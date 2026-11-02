"""Real PostgreSQL, owning CLI and independent S3 archive qualification."""

import hashlib
import importlib.util
import io
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import uuid
from contextlib import nullcontext
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import psycopg
import urllib3
from minio import Minio
from minio.error import S3Error
from minio.objectlockconfig import ObjectLockConfig
from minio.retention import COMPLIANCE, GOVERNANCE, Retention
from minio.sseconfig import Rule, SSEConfig
from psycopg import sql
from psycopg.conninfo import conninfo_to_dict, make_conninfo
from psycopg.rows import dict_row

module = importlib.util.spec_from_file_location(
    "audit_export", Path(__file__).resolve().parents[1] / "audit_export.py"
)
archive = importlib.util.module_from_spec(module)
sys.modules[module.name] = archive
module.loader.exec_module(archive)

initializer_spec = importlib.util.spec_from_file_location(
    "nuc_archive_initialize",
    Path(__file__).resolve().parent / "fixtures/initialize.py",
)
initialize = importlib.util.module_from_spec(initializer_spec)
initializer_spec.loader.exec_module(initialize)

IMAGE = "docker.io/chrislusf/seaweedfs@sha256:092e57674b53aaa6191b6f3041a16b23f3fcf986dd3fe600f2e0bf31cab34dfe"


def docker(*arguments: str) -> str:
    return subprocess.check_output(
        ["docker", *arguments], text=True, stderr=subprocess.DEVNULL
    ).strip()


class StoredBeforeCrash(archive.Exporter):
    def store(self, rows, now_ms):
        super().store(rows, now_ms)
        raise InterruptedError(
            "injected crash after independent storage before SQL acknowledgement"
        )


class ArchiveBoundaries(unittest.TestCase):
    def test_transient_transport_repeats_full_verification_before_fencing(self):
        database = Mock()
        exporter = archive.Exporter(database, Mock())
        failure = urllib3.exceptions.ReadTimeoutError(None, None, "PRIVATE_SENTINEL")
        with patch.object(exporter, "_tick", side_effect=[failure, 0]) as verify:
            self.assertEqual(exporter.tick(), 0)
        self.assertEqual(verify.call_count, 2)
        database.execute.assert_not_called()

    def test_persistent_transport_failure_fences_after_one_retry(self):
        database = Mock()
        exporter = archive.Exporter(database, Mock())
        failure = urllib3.exceptions.ReadTimeoutError(None, None, "PRIVATE_SENTINEL")
        with (
            patch.object(exporter, "_tick", side_effect=failure) as verify,
            self.assertRaises(urllib3.exceptions.ReadTimeoutError),
        ):
            exporter.tick()
        self.assertEqual(verify.call_count, 2)
        database.execute.assert_called_once_with(
            "UPDATE ofz.archive_state SET acknowledged_at_ms=0 "
            "WHERE acknowledged_at_ms<>0"
        )

    def test_integrity_failure_fences_without_retry(self):
        database = Mock()
        exporter = archive.Exporter(database, Mock())
        with (
            patch.object(
                exporter, "_tick", side_effect=archive.ArchiveError("hash mismatch")
            ) as verify,
            self.assertRaises(archive.ArchiveError),
        ):
            exporter.tick()
        self.assertEqual(verify.call_count, 1)
        database.execute.assert_called_once()

    def test_worker_recovers_from_transport_timeout_without_restart(self):
        tick = Mock(
            side_effect=[
                urllib3.exceptions.ReadTimeoutError(None, None, "PRIVATE_SENTINEL"),
                0,
                KeyboardInterrupt,
            ]
        )
        exporter = SimpleNamespace(
            database=nullcontext(), acquire=lambda: True, tick=tick
        )
        with (
            patch.object(archive, "from_environment", return_value=exporter),
            patch.object(sys, "argv", ["ofz-audit-export"]),
            patch.object(archive.time, "sleep") as sleep,
            patch.object(sys, "stderr", io.StringIO()) as errors,
            self.assertRaises(KeyboardInterrupt),
        ):
            archive.main()
        self.assertEqual(tick.call_count, 3)
        self.assertEqual(sleep.call_count, 2)
        self.assertIn('"event": "audit_archive_retry"', errors.getvalue())
        self.assertNotIn("PRIVATE_SENTINEL", errors.getvalue())

    def test_once_reports_transport_failure_without_worker_retry(self):
        timeout = urllib3.exceptions.ReadTimeoutError(None, None, "fixture timeout")
        tick = Mock(side_effect=timeout)
        exporter = SimpleNamespace(
            database=nullcontext(), acquire=lambda: True, tick=tick
        )
        with (
            patch.object(archive, "from_environment", return_value=exporter),
            patch.object(sys, "argv", ["ofz-audit-export", "--once"]),
            patch.object(archive.time, "sleep") as sleep,
            self.assertRaises(urllib3.exceptions.ReadTimeoutError),
        ):
            archive.main()
        self.assertEqual(tick.call_count, 1)
        sleep.assert_not_called()

    def test_ceph_retention_uses_rfc3339_nanosecond_precision(self):
        storage = archive.CephArchive(
            "localhost:9000",
            access_key="fixture",
            secret_key="fixture-secret",
            secure=False,
        )
        response = SimpleNamespace(
            data=b'<Retention xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Mode>COMPLIANCE</Mode><RetainUntilDate>2030-01-02T03:04:05.934000000Z</RetainUntilDate></Retention>'
        )
        with patch.object(storage, "_execute", return_value=response):
            retention = storage.get_object_retention(
                "ofz-audit", "batches/fixture", version_id="ceph-version"
            )
        self.assertEqual(retention.mode, COMPLIANCE)
        self.assertEqual(
            retention.retain_until_date, datetime(2030, 1, 2, 3, 4, 5, 934000, UTC)
        )

    def test_ceph_archive_verifies_bytes_and_retention_without_sse(self):
        payload = b"Ceph archive payload"
        digest = hashlib.sha256(payload).hexdigest()
        until = datetime.now(UTC) + timedelta(days=90)

        class Response(io.BytesIO):
            headers = {}

            def release_conn(self):
                pass

        class Storage:
            data = payload
            deadline = until

            def get_object_retention(self, *args, **kwargs):
                return SimpleNamespace(mode=COMPLIANCE, retain_until_date=self.deadline)

            def get_object(self, *args, **kwargs):
                return Response(self.data)

        storage = Storage()
        exporter = archive.Exporter(None, storage)
        receipt = archive.Receipt(
            f"batches/1-1-{digest}.json", "ceph-version", digest, until.isoformat()
        )
        exporter.verify_object(receipt)
        storage.data = b"changed"
        with self.assertRaisesRegex(archive.ArchiveError, "readback mismatch"):
            exporter.verify_object(receipt)
        storage.data = payload
        storage.deadline = until - timedelta(seconds=1)
        with self.assertRaisesRegex(archive.ArchiveError, "retention mismatch"):
            exporter.verify_object(receipt)

    def test_database_writer_identity_cannot_be_replaced(self):
        with tempfile.TemporaryDirectory(prefix="ofz-database-writers-") as temporary:
            directory = Path(temporary)
            initialize.prepare(directory)
            manifest = directory / "database-writers.json"
            original = manifest.read_bytes()
            initialize.prepare(directory)
            self.assertEqual(original, manifest.read_bytes())
            values = json.loads(original)
            self.assertEqual(set(values), {"ofz", "keycloak"})
            values["ofz"]["secret_key"] = "00" * 32
            manifest.write_text(json.dumps(values, sort_keys=True))
            with self.assertRaisesRegex(archive.ArchiveError, "identity changed"):
                initialize.prepare(directory)
            manifest.unlink()
            with self.assertRaisesRegex(archive.ArchiveError, "original"):
                initialize.prepare(directory)
            self.assertFalse(manifest.exists())

    def test_recovery_key_is_stable_and_corruption_is_not_replaced(self):
        with tempfile.TemporaryDirectory(prefix="ofz-recovery-key-") as temporary:
            directory = Path(temporary)
            initialize.prepare(directory)
            key = directory / "sse_kek"
            original = key.read_bytes()
            configuration = (directory / "security.toml").read_bytes()
            initialize.prepare(directory)
            self.assertEqual(original, key.read_bytes())
            self.assertEqual(configuration, (directory / "security.toml").read_bytes())
            self.assertEqual(len(bytes.fromhex(original.decode())), 32)
            key.write_text("corrupt-key")
            with self.assertRaises(archive.ArchiveError):
                initialize.prepare(directory)
            self.assertEqual(key.read_text(), "corrupt-key")
            key.write_text("00" * 32)
            with self.assertRaisesRegex(archive.ArchiveError, "identity changed"):
                initialize.prepare(directory)
            key.unlink()
            with self.assertRaisesRegex(archive.ArchiveError, "original"):
                initialize.prepare(directory)
            self.assertFalse(key.exists())

    def test_private_credentials_and_redacted_failures(self):
        with tempfile.TemporaryDirectory(
            prefix="ofz-archive-credentials-"
        ) as temporary:
            path = Path(temporary) / "credential"
            path.write_text("fixture-secret")
            path.chmod(0o600)
            self.assertEqual(
                hashlib.sha256(archive.credential(str(path)).encode()).hexdigest(),
                hashlib.sha256(b"fixture-secret").hexdigest(),
            )
            path.chmod(0o644)
            with self.assertRaises(archive.ArchiveError):
                archive.credential(str(path))
            path.chmod(0o600)
            path.write_bytes(b"x" * (16 * 1024 + 1))
            with self.assertRaises(archive.ArchiveError):
                archive.credential(str(path))
        failure = S3Error(
            None,
            "AccessDenied",
            "fixture-secret",
            "fixture-secret",
            "request",
            "host",
            object_name="fixture-secret",
        )
        report = archive.failure_report(failure, "archive_failed")
        self.assertEqual(report["code"], "AccessDenied")
        self.assertNotIn("fixture-secret", json.dumps(report))
        report = archive.failure_report(
            psycopg.OperationalError("fixture-secret"), "archive_failed"
        )
        self.assertNotIn("fixture-secret", json.dumps(report))


class ArchivePolling(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        config = conninfo_to_dict(os.environ["OFZ_TEST_DSN"])
        config.update(sslmode="verify-full", sslrootcert=os.environ["OFZ_TEST_CA_FILE"])
        cls.administrator = psycopg.connect(**config, autocommit=True)
        cls.database_name = f"ofz_poll_{uuid.uuid4().hex}"
        cls.administrator.execute(
            sql.SQL("CREATE DATABASE {}").format(sql.Identifier(cls.database_name))
        )
        cls.database = psycopg.connect(
            **dict(config, dbname=cls.database_name),
            autocommit=True,
            row_factory=dict_row,
        )
        cls.database.execute("""
            CREATE SCHEMA ofz;
            CREATE TABLE ofz.audit (
                sequence bigint PRIMARY KEY, receipt jsonb NOT NULL,
                target_hash bytea NOT NULL, created_at_ms bigint NOT NULL
            );
            CREATE TABLE ofz.audit_outbox (
                audit_sequence bigint PRIMARY KEY REFERENCES ofz.audit(sequence),
                acknowledged_at_ms bigint,
                archive_receipt text
            );
            CREATE FUNCTION ofz.now_ms() RETURNS bigint LANGUAGE sql AS
                'SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint';
            CREATE TABLE ofz.archive_state (
                acknowledged_sequence bigint NOT NULL,
                acknowledged_at_ms bigint NOT NULL
            );
            CREATE INDEX audit_outbox_unacknowledged ON ofz.audit_outbox(audit_sequence)
                WHERE acknowledged_at_ms IS NULL;
            INSERT INTO ofz.audit
                SELECT n,jsonb_build_object('fixture',repeat(md5(n::text),32)),
                    decode(repeat('00',32),'hex'),n
                FROM generate_series(1,10300) n;
            INSERT INTO ofz.audit_outbox
                SELECT sequence,CASE WHEN sequence<=10000 THEN 1 END FROM ofz.audit;
            INSERT INTO ofz.archive_state VALUES (10300,0);
        """)
        cls.database.execute("VACUUM ANALYZE ofz.audit")
        cls.database.execute("VACUUM ANALYZE ofz.audit_outbox")

    @classmethod
    def tearDownClass(cls):
        cls.database.close()
        cls.administrator.execute(
            sql.SQL("DROP DATABASE {}").format(sql.Identifier(cls.database_name))
        )
        cls.administrator.close()

    def setUp(self):
        self.database.execute("BEGIN")

    def tearDown(self):
        self.database.execute("ROLLBACK")

    def idle_exporter(self):
        receipt = archive.Receipt(
            f"batches/1-10300-{'0' * 64}.json",
            "idle-heartbeat-sql-fixture",
            "0" * 64,
            (datetime.now(UTC) + timedelta(days=90)).isoformat(),
        )
        self.database.execute(
            "UPDATE ofz.audit_outbox SET acknowledged_at_ms=1,archive_receipt=%s",
            (receipt.encode(),),
        )

        class VerifiedArchive(archive.Exporter):
            verifications = 0

            def verify_destination(self):
                self.verifications += 1

            def verify_object(self, stored):
                self.verifications += 1
                if stored != receipt:
                    raise archive.ArchiveError("unexpected fixture receipt")

        return VerifiedArchive(self.database, None)

    def checkpoint_version(self):
        return self.database.execute(
            "SELECT ctid::text AS tuple,acknowledged_at_ms FROM ofz.archive_state"
        ).fetchone()

    def test_idle_poll_verifies_archive_without_rewriting_fresh_heartbeat(self):
        exporter = self.idle_exporter()
        self.assertEqual(exporter.tick(), 0)
        initial = self.checkpoint_version()
        self.assertGreater(initial["acknowledged_at_ms"], 0)
        self.assertEqual(exporter.tick(), 0)
        self.assertEqual(self.checkpoint_version(), initial)
        self.assertEqual(exporter.verifications, 4)

        self.database.execute(
            "UPDATE ofz.archive_state SET acknowledged_at_ms=ofz.now_ms()-11000"
        )
        expired = self.checkpoint_version()
        self.assertEqual(exporter.tick(), 0)
        self.assertGreater(
            self.checkpoint_version()["acknowledged_at_ms"],
            expired["acknowledged_at_ms"],
        )

        self.database.execute(
            "UPDATE ofz.archive_state SET acknowledged_at_ms=ofz.now_ms()+11000"
        )
        future = self.checkpoint_version()
        self.assertEqual(exporter.tick(), 0)
        self.assertLess(
            self.checkpoint_version()["acknowledged_at_ms"],
            future["acknowledged_at_ms"],
        )

    def test_idle_archive_failure_invalidates_health_immediately_and_once(self):
        exporter = self.idle_exporter()
        self.assertEqual(exporter.tick(), 0)

        def unavailable():
            raise archive.ArchiveError("fixture archive unavailable")

        exporter.verify_destination = unavailable
        with self.assertRaises(archive.ArchiveError):
            exporter.tick()
        failed = self.checkpoint_version()
        self.assertEqual(failed["acknowledged_at_ms"], 0)
        with self.assertRaises(archive.ArchiveError):
            exporter.tick()
        self.assertEqual(self.checkpoint_version(), failed)

    def test_transport_timeout_fences_until_verified_retry(self):
        exporter = self.idle_exporter()
        self.assertEqual(exporter.tick(), 0)
        with (
            patch.object(
                exporter,
                "verify_destination",
                side_effect=urllib3.exceptions.ReadTimeoutError(
                    None, None, "fixture timeout"
                ),
            ),
            self.assertRaises(urllib3.exceptions.ReadTimeoutError),
        ):
            exporter.tick()
        self.assertEqual(self.checkpoint_version()["acknowledged_at_ms"], 0)
        self.assertEqual(exporter.tick(), 0)
        self.assertGreater(self.checkpoint_version()["acknowledged_at_ms"], 0)

    def test_transient_read_reverifies_without_invalidating_fresh_checkpoint(self):
        exporter = self.idle_exporter()
        self.assertEqual(exporter.tick(), 0)
        checkpoint = self.checkpoint_version()
        verify_object = exporter.verify_object
        attempts = 0

        def interrupted_read(receipt):
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                raise urllib3.exceptions.ReadTimeoutError(None, None, "fixture timeout")
            return verify_object(receipt)

        with patch.object(exporter, "verify_object", side_effect=interrupted_read):
            self.assertEqual(exporter.tick(), 0)
        self.assertEqual(attempts, 2)
        self.assertEqual(self.checkpoint_version(), checkpoint)
        self.assertEqual(exporter.verifications, 5)

    def test_bounded_order_preserves_late_commits_and_missing_outboxes(self):
        self.database.execute("DELETE FROM ofz.audit_outbox WHERE audit_sequence=5")
        self.database.execute(
            "UPDATE ofz.audit_outbox SET acknowledged_at_ms=NULL WHERE audit_sequence=10"
        )
        self.database.execute(
            "UPDATE ofz.audit_outbox SET acknowledged_at_ms=1 WHERE audit_sequence=10005"
        )
        rows = self.database.execute(archive.PENDING_AUDIT_QUERY, (10000,)).fetchall()
        self.assertEqual(
            [row["sequence"] for row in rows], [5, 10, *range(10001, 10063)]
        )
        self.assertFalse(rows[0]["has_outbox"])
        self.assertTrue(all(row["has_outbox"] for row in rows[1:]))

    def test_poll_reads_payloads_only_for_the_selected_batch(self):
        plan = self.database.execute(
            "EXPLAIN (ANALYZE, FORMAT JSON) " + archive.PENDING_AUDIT_QUERY, (10000,)
        ).fetchone()["QUERY PLAN"][0]["Plan"]

        def payload_rows(node):
            own = 0
            if (
                node.get("Relation Name") == "audit"
                and node["Node Type"] != "Index Only Scan"
            ):
                own = (
                    node["Actual Rows"] + node.get("Rows Removed by Filter", 0)
                ) * node["Actual Loops"]
            return own + sum(payload_rows(child) for child in node.get("Plans", []))

        self.assertEqual(plan["Actual Rows"], 64)
        self.assertLessEqual(payload_rows(plan), 64)


class RealArchive(unittest.TestCase):
    def test_independent_archive_and_bootstrap(self):
        with tempfile.TemporaryDirectory(prefix="ofz-archive-") as directory:
            root = Path(directory)
            name = f"ofz-archive-{uuid.uuid4()}"
            self.addCleanup(lambda: docker("volume", "rm", name))
            self.addCleanup(lambda: docker("rm", "--force", name))
            self.addCleanup(
                lambda: Path("/tmp/ofz-archive-seaweed-last-server.log").write_text(
                    subprocess.run(
                        ["docker", "logs", name], capture_output=True, text=True
                    ).stdout
                    + subprocess.run(
                        ["docker", "logs", name], capture_output=True, text=True
                    ).stderr
                )
            )
            credentials = root / "credentials"
            credentials.mkdir(mode=0o700)
            initialize.prepare(credentials)
            manifest_hash = hashlib.sha256(
                (credentials / "manifest.json").read_bytes()
            ).hexdigest()
            initialize.prepare(credentials)
            self.assertEqual(
                manifest_hash,
                hashlib.sha256(
                    (credentials / "manifest.json").read_bytes()
                ).hexdigest(),
            )
            filer_config = root / "filer.toml"
            filer_config.write_text(
                (Path(__file__).resolve().parent / "fixtures/filer.toml").read_text()
            )
            filer_config.chmod(0o444)
            docker("volume", "create", name)
            for filename in ["s3.json", "security.toml"]:
                initialized = subprocess.run(
                    [
                        "docker",
                        "run",
                        "--rm",
                        "--interactive",
                        "--user",
                        "0:0",
                        "--cap-drop=ALL",
                        "--cap-add=CHOWN",
                        "--cap-add=DAC_OVERRIDE",
                        "--read-only",
                        "--entrypoint",
                        "/bin/sh",
                        "--mount",
                        f"type=volume,source={name},target=/data",
                        IMAGE,
                        "-ec",
                        f"cat > /data/{filename}; chmod 0600 /data/{filename}; chown 1000:1000 /data /data/{filename}",
                    ],
                    input=(credentials / filename).read_text(),
                    text=True,
                    capture_output=True,
                )
                self.assertEqual(initialized.returncode, 0, initialized.stderr)
            with socket.socket() as reservation:
                reservation.bind(("127.0.0.1", 0))
                host_port = reservation.getsockname()[1]
            docker(
                "run",
                "--detach",
                "--name",
                name,
                "--cpus=1",
                "--memory=512m",
                "--pids-limit=256",
                "--user",
                "1000:1000",
                "--cap-drop=ALL",
                "--read-only",
                "--entrypoint",
                "/usr/bin/weed",
                "--workdir",
                "/data",
                "--tmpfs",
                "/tmp:rw,nosuid,nodev,size=64m",
                "--publish",
                f"127.0.0.1:{host_port}:8333",
                "--mount",
                f"type=volume,source={name},target=/data",
                "--mount",
                f"type=bind,source={filer_config},target=/etc/seaweedfs/filer.toml,readonly",
                IMAGE,
                "server",
                "-dir=/data",
                "-ip=127.0.0.1",
                "-ip.bind=0.0.0.0",
                "-volume.max=0",
                "-master.volumeSizeLimitMB=64",
                "-master.telemetry=false",
                "-volume.minFreeSpace=1GiB",
                "-filer",
                "-filer.disableHttp",
                "-s3",
                "-s3.config=/data/s3.json",
                "-s3.iam=false",
                "-s3.port.iceberg=0",
                "-s3.port.lance=0",
            )
            endpoint = docker("port", name, "8333/tcp")
            administrator = Minio(
                endpoint,
                access_key=archive.credential(str(credentials / "root_access_key")),
                secret_key=archive.credential(str(credentials / "root_secret_key")),
                secure=False,
                region="us-east-1",
                http_client=urllib3.PoolManager(
                    timeout=urllib3.Timeout(total=8, connect=2, read=5), retries=False
                ),
            )
            storage = archive.CephArchive(
                endpoint,
                access_key=archive.credential(str(credentials / "archive_access_key")),
                secret_key=archive.credential(str(credentials / "archive_secret_key")),
                secure=False,
                region="us-east-1",
                http_client=urllib3.PoolManager(
                    timeout=urllib3.Timeout(total=8, connect=2, read=5), retries=False
                ),
            )
            deadline = time.monotonic() + 45
            while True:
                try:
                    administrator.list_buckets()
                    break
                except Exception:
                    if time.monotonic() >= deadline:
                        self.fail("isolated S3 server did not become ready")
                    time.sleep(0.2)
            docker(
                "exec",
                name,
                "/bin/sh",
                "-ec",
                "printf 'fs.configure -locationPrefix=/buckets/ -fsync -volumeGrowthCount=1 -apply\\n' | /usr/bin/weed shell -master=127.0.0.1:9333 -filer=127.0.0.1:8888",
            )
            initialize.configure(credentials, storage=administrator)
            initialize.configure(credentials, storage=administrator)
            writers = json.loads((credentials / "database-writers.json").read_text())
            database_clients = {}
            for database, bucket in initialize.DATABASE_BUCKETS.items():
                writer = Minio(
                    endpoint,
                    access_key=writers[database]["access_key"],
                    secret_key=writers[database]["secret_key"],
                    secure=False,
                    region="us-east-1",
                )
                config = writer.get_object_lock_config(bucket)
                database_clients[database] = writer
                self.assertEqual(config.mode, COMPLIANCE)
                self.assertEqual(config.duration, 30)
                self.assertEqual(writer.get_bucket_versioning(bucket).status, "Enabled")
                data = (database + " independent physical backup fixture").encode()
                written = writer.put_object(
                    bucket, "wal/test", io.BytesIO(data), len(data)
                )
                self.assertTrue(written.version_id)
                self.assertEqual(
                    len(list(writer.list_objects(bucket, prefix="wal/"))), 1
                )
                response = writer.get_object(
                    bucket, "wal/test", version_id=written.version_id
                )
                try:
                    self.assertEqual(
                        response.headers.get("x-amz-server-side-encryption"), "AES256"
                    )
                    self.assertEqual(response.read(), data)
                finally:
                    response.close()
                    response.release_conn()
                for denied_client in (writer, administrator):
                    initialize.denied(
                        lambda: denied_client.remove_object(
                            bucket, "wal/test", version_id=written.version_id
                        )
                    )
                other = next(
                    value
                    for value in initialize.DATABASE_BUCKETS.values()
                    if value != bucket
                )
                initialize.denied(
                    lambda: writer.put_object(
                        other, "cross-database", io.BytesIO(data), len(data)
                    )
                )
                initialize.denied(
                    lambda: storage.put_object(
                        bucket, "audit-writer", io.BytesIO(data), len(data)
                    )
                )
                initialize.denied(
                    lambda: writer.set_bucket_encryption(
                        bucket, SSEConfig(Rule.new_sse_s3_rule())
                    )
                )
                lifecycle = administrator.get_bucket_lifecycle(bucket)
                self.assertEqual(lifecycle.rules[0].expiration.days, 40)
                self.assertEqual(
                    lifecycle.rules[0].noncurrent_version_expiration.noncurrent_days, 45
                )
            report = initialize.verify_databases(
                credentials, writers=database_clients, root=administrator
            )
            self.assertEqual(
                {item["bucket"] for item in report},
                set(initialize.DATABASE_BUCKETS.values()),
            )
            with self.assertRaises(S3Error):
                initialize.verify_databases(
                    credentials,
                    writers={**database_clients, "ofz": database_clients["keycloak"]},
                    root=administrator,
                )
            docker("exec", name, "/bin/sh", "-ec", "test -s /data/filer.sqlite3")
            administrator.set_object_lock_config(
                archive.BUCKET, ObjectLockConfig(COMPLIANCE, 90, "Days")
            )
            shell = [
                "docker",
                "exec",
                "--interactive",
                name,
                "/usr/bin/weed",
                "shell",
                "-master=127.0.0.1:9333",
                "-filer=127.0.0.1:8888",
            ]
            applied = subprocess.run(
                shell,
                input="fs.configure -locationPrefix=/buckets/ -fsync -volumeGrowthCount=1 -apply\n",
                capture_output=True,
                text=True,
            )
            self.assertEqual(applied.returncode, 0, applied.stderr)
            readback = subprocess.run(
                shell,
                input="fs.configure\n",
                capture_output=True,
                text=True,
                check=True,
            )
            settings = json.JSONDecoder().raw_decode(
                readback.stdout[readback.stdout.index("{") :]
            )[0]
            self.assertTrue(
                any(
                    item.get("locationPrefix") == "/buckets/"
                    and item.get("fsync") is True
                    for item in settings["locations"]
                )
            )

            config = conninfo_to_dict(os.environ["OFZ_TEST_DSN"])
            config.update(
                sslmode="verify-full",
                sslrootcert=os.environ["OFZ_TEST_CA_FILE"],
                client_encoding="UTF8",
            )
            database = psycopg.connect(**config, autocommit=True, row_factory=dict_row)
            self.addCleanup(database.close)
            database.execute(
                "CREATE ROLE ofz_migrator LOGIN PASSWORD 'archive-fixture' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT"
            )
            database.execute(
                "CREATE ROLE ofz_api LOGIN PASSWORD 'archive-fixture' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT"
            )
            database.execute(
                "CREATE ROLE ofz_archiver LOGIN PASSWORD 'archive-fixture' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT"
            )
            database.execute("GRANT CREATE ON DATABASE ofz_control TO ofz_migrator")

            password = root / "password"
            password.write_text("archive-fixture")
            password.chmod(0o600)
            manifest = root / "manifest.json"
            manifest.write_text(
                json.dumps(
                    {
                        "operationId": str(uuid.uuid4()),
                        "activationOperationId": str(uuid.uuid4()),
                        "administratorGithubIds": ["1", "2"],
                    }
                )
            )
            manifest.chmod(0o600)
            owner = dict(config, user="ofz_migrator")
            owner.pop("password", None)
            owner.pop("sslrootcert", None)
            owner.pop("client_encoding", None)
            owner["sslmode"] = "require"
            environment = dict(
                os.environ,
                OFZ_DATABASE_DSN=make_conninfo(**owner),
                OFZ_DATABASE_PASSWORD_FILE=str(password),
                OFZ_DATABASE_CA_FILE=os.environ["OFZ_TEST_CA_FILE"],
                OFZ_SPICEDB_ENDPOINT=os.environ["OFZ_TEST_NATIVE_ENDPOINT"],
                OFZ_SPICEDB_KEY_FILE=os.environ["OFZ_TEST_NATIVE_KEY_FILE"],
            )

            def cli(operation):
                arguments = [os.environ["OFZ_BOOTSTRAP_CLI_FIXTURE"], operation]
                if operation != "migrate":
                    arguments.append(str(manifest))
                result = subprocess.run(
                    arguments,
                    env=environment,
                    capture_output=True,
                    text=True,
                    timeout=20,
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                return json.loads(result.stdout) if result.stdout.strip() else None

            cli("migrate")
            bootstrap = cli("bootstrap")
            self.assertTrue(bootstrap["currentPlatformFenced"])
            self.assertFalse(bootstrap["currentArchiveHealthy"])

            def connect(role):
                connection = psycopg.connect(
                    **dict(config, user=role, password="archive-fixture"),
                    autocommit=True,
                    row_factory=dict_row,
                )
                self.addCleanup(connection.close)
                return connection

            caller = connect("ofz_archiver")
            exporter = archive.Exporter(caller, storage)
            self.assertTrue(exporter.acquire())
            self.assertFalse(
                archive.Exporter(connect("ofz_archiver"), storage).acquire()
            )
            with self.assertRaises(archive.ArchiveError):
                archive.Exporter(connect("ofz_api"), storage).acquire()
            with self.assertRaises(InterruptedError):
                StoredBeforeCrash(caller, storage).tick()
            self.assertIsNone(
                database.execute(
                    "SELECT acknowledged_at_ms FROM ofz.audit_outbox"
                ).fetchone()["acknowledged_at_ms"]
            )
            self.assertEqual(exporter.tick(), 1)
            before = database.execute(
                "SELECT archive_receipt FROM ofz.audit_outbox"
            ).fetchone()["archive_receipt"]
            receipt = archive.Receipt.decode(before)
            exporter.verify_object(receipt)
            self.assertEqual(
                len(
                    list(
                        administrator.list_objects(archive.BUCKET, include_version=True)
                    )
                ),
                1,
            )
            activated = cli("activate")
            self.assertFalse(activated["currentPlatformFenced"])
            self.assertTrue(activated["currentArchiveHealthy"])
            self.assertEqual(exporter.tick(), 1)
            self.assertEqual(exporter.tick(), 0)

            plaintext = b"qualification payload with valid hash and retention"
            plaintext_hash = hashlib.sha256(plaintext).hexdigest()
            plaintext_key = f"batches/1-1-{plaintext_hash}.json"
            until = datetime.now(UTC).replace(microsecond=0) + timedelta(
                days=90, seconds=1
            )
            administrator.delete_bucket_encryption(archive.BUCKET)
            try:
                unencrypted = administrator.put_object(
                    archive.BUCKET,
                    plaintext_key,
                    io.BytesIO(plaintext),
                    len(plaintext),
                    retention=Retention(COMPLIANCE, until),
                )
            finally:
                administrator.set_bucket_encryption(
                    archive.BUCKET, SSEConfig(Rule.new_sse_s3_rule())
                )
            exporter.verify_object(
                archive.Receipt(
                    plaintext_key,
                    unencrypted.version_id,
                    plaintext_hash,
                    until.isoformat(),
                )
            )
            with self.assertRaisesRegex(archive.ArchiveError, "readback mismatch"):
                exporter.verify_object(
                    archive.Receipt(
                        plaintext_key,
                        unencrypted.version_id,
                        "0" * 64,
                        until.isoformat(),
                    )
                )

            marker = f"OFZ-CIPHERTEXT-PROBE-{uuid.uuid4().hex}"
            payload = (marker.encode() * (8 * 1024 * 1024 // len(marker) + 1))[
                : 8 * 1024 * 1024
            ]
            payload_hash = hashlib.sha256(payload).hexdigest()
            encrypted = storage.put_object(
                archive.BUCKET,
                "qualification/encrypted-multipart",
                io.BytesIO(payload),
                len(payload),
            )
            self.assertTrue(encrypted.version_id)
            docker(
                "exec",
                name,
                "/bin/sh",
                "-ec",
                'if grep -aFq -- "$1" /data/*.dat /data/filer.sqlite3*; then exit 1; fi',
                "sh",
                marker,
            )

            for client in [storage, administrator]:
                with self.assertRaises(S3Error):
                    client.remove_object(
                        archive.BUCKET, receipt.key, version_id=receipt.version_id
                    )
            with self.assertRaises(S3Error):
                storage.remove_object(archive.BUCKET, receipt.key)
            with self.assertRaises(S3Error):
                storage.set_object_lock_config(
                    archive.BUCKET, ObjectLockConfig(GOVERNANCE, 1, "Days")
                )
            with self.assertRaises(S3Error):
                storage.set_object_retention(
                    archive.BUCKET,
                    receipt.key,
                    Retention(COMPLIANCE, datetime.now(UTC) + timedelta(days=1)),
                    version_id=receipt.version_id,
                )
            exporter.verify_object(receipt)

            def append(connection, label):
                row = connection.execute(
                    "INSERT INTO ofz.audit(id,receipt,target_hash) VALUES(%s,%s,%s) RETURNING sequence",
                    (
                        uuid.uuid4(),
                        json.dumps({"fixture": label}),
                        hashlib.sha256(label.encode()).digest(),
                    ),
                ).fetchone()
                connection.execute(
                    "INSERT INTO ofz.audit_outbox(audit_sequence) VALUES(%s)",
                    (row["sequence"],),
                )
                return row["sequence"]

            delayed = connect("ofz_api")
            with delayed.transaction():
                older = append(delayed, "delayed-commit")
                newer = append(connect("ofz_api"), "later-sequence-first-commit")
                self.assertGreater(newer, older)
                self.assertEqual(exporter.tick(), 1)
            self.assertEqual(exporter.tick(), 1)
            self.assertEqual(exporter.tick(), 0)
            self.assertEqual(
                database.execute(
                    "SELECT acknowledged_sequence FROM ofz.archive_state"
                ).fetchone()["acknowledged_sequence"],
                newer,
            )
            self.assertEqual(
                database.execute(
                    "SELECT count(*) AS pending FROM ofz.audit_outbox WHERE acknowledged_at_ms IS NULL"
                ).fetchone()["pending"],
                0,
            )

            checkpoint = newer
            delayed.execute("BEGIN")
            older = append(delayed, "commit-during-independent-upload")
            newer = append(connect("ofz_api"), "visible-before-upload")

            class CommitDuringUpload(archive.Exporter):
                def store(self, rows, now_ms):
                    receipt = super().store(rows, now_ms)
                    delayed.execute("COMMIT")
                    return receipt

            try:
                self.assertEqual(CommitDuringUpload(caller, storage).tick(), 1)
            finally:
                delayed.rollback()
            state = database.execute(
                "SELECT acknowledged_sequence,acknowledged_at_ms FROM ofz.archive_state"
            ).fetchone()
            self.assertEqual(state["acknowledged_sequence"], checkpoint)
            self.assertGreater(state["acknowledged_at_ms"], 0)
            self.assertIsNone(
                database.execute(
                    "SELECT acknowledged_at_ms FROM ofz.audit_outbox WHERE audit_sequence=%s",
                    (older,),
                ).fetchone()["acknowledged_at_ms"]
            )
            self.assertTrue(cli("activate")["currentArchiveHealthy"])
            self.assertEqual(exporter.tick(), 2)
            self.assertEqual(exporter.tick(), 0)
            self.assertEqual(
                database.execute(
                    "SELECT acknowledged_sequence FROM ofz.archive_state"
                ).fetchone()["acknowledged_sequence"],
                newer,
            )
            self.assertEqual(
                database.execute(
                    "SELECT count(*) AS pending FROM ofz.audit_outbox WHERE acknowledged_at_ms IS NULL"
                ).fetchone()["pending"],
                0,
            )

            docker("kill", "--signal=KILL", name)
            with self.assertRaises(Exception):
                exporter.tick()
            self.assertEqual(
                database.execute(
                    "SELECT acknowledged_at_ms FROM ofz.archive_state"
                ).fetchone()["acknowledged_at_ms"],
                0,
            )
            self.assertFalse(cli("activate")["currentArchiveHealthy"])
            docker("start", name)
            self.assertEqual(docker("port", name, "8333/tcp"), endpoint)
            deadline = time.monotonic() + 30
            while True:
                try:
                    exporter.tick()
                    break
                except Exception:
                    if time.monotonic() >= deadline:
                        self.fail(
                            "independent archive did not recover its immutable versions"
                        )
                    time.sleep(0.2)
            self.assertTrue(cli("activate")["currentArchiveHealthy"])
            exporter.verify_object(receipt)
            response = storage.get_object(
                archive.BUCKET,
                "qualification/encrypted-multipart",
                version_id=encrypted.version_id,
            )
            try:
                self.assertEqual(
                    response.headers.get("x-amz-server-side-encryption"), "AES256"
                )
                self.assertEqual(
                    hashlib.sha256(response.read()).hexdigest(), payload_hash
                )
            finally:
                response.close()
                response.release_conn()
            self.assertTrue(
                initialize.verify(credentials, writer=storage, root=administrator)[
                    "rootVersionDeleteDenied"
                ]
            )
            self.assertEqual(
                before,
                database.execute(
                    "SELECT archive_receipt FROM ofz.audit_outbox ORDER BY audit_sequence LIMIT 1"
                ).fetchone()["archive_receipt"],
            )
            administrator.set_object_lock_config(
                archive.BUCKET, ObjectLockConfig(GOVERNANCE, 1, "Days")
            )
            with self.assertRaises(archive.ArchiveError):
                exporter.tick()
            self.assertEqual(
                database.execute(
                    "SELECT acknowledged_at_ms FROM ofz.archive_state"
                ).fetchone()["acknowledged_at_ms"],
                0,
            )
            administrator.set_object_lock_config(
                archive.BUCKET, ObjectLockConfig(COMPLIANCE, 90, "Days")
            )
            exporter.tick()
            sequence = append(connect("ofz_api"), "independent-readback-corruption")
            with self.assertRaises(InterruptedError):
                StoredBeforeCrash(caller, storage).tick()
            original = next(
                administrator.list_objects(
                    archive.BUCKET,
                    prefix=f"batches/{sequence}-{sequence}-",
                    include_version=True,
                )
            )
            original_response = administrator.get_object(
                archive.BUCKET, original.object_name, version_id=original.version_id
            )
            try:
                original_data = original_response.read(archive.MAX_BATCH_BYTES + 1)
            finally:
                original_response.close()
                original_response.release_conn()
            protected_until = datetime.now(UTC) + timedelta(days=90, minutes=1)
            administrator.put_object(
                archive.BUCKET,
                original.object_name,
                io.BytesIO(b"changed payload"),
                len(b"changed payload"),
                retention=Retention(COMPLIANCE, protected_until),
            )
            with self.assertRaisesRegex(archive.ArchiveError, "readback mismatch"):
                exporter.tick()
            self.assertIsNone(
                database.execute(
                    "SELECT acknowledged_at_ms FROM ofz.audit_outbox WHERE audit_sequence=%s",
                    (sequence,),
                ).fetchone()["acknowledged_at_ms"]
            )
            administrator.put_object(
                archive.BUCKET,
                original.object_name,
                io.BytesIO(original_data),
                len(original_data),
                retention=Retention(COMPLIANCE, datetime.now(UTC) + timedelta(days=1)),
            )
            with self.assertRaisesRegex(
                archive.ArchiveError, "retention does not cover"
            ):
                exporter.tick()
            self.assertIsNone(
                database.execute(
                    "SELECT acknowledged_at_ms FROM ofz.audit_outbox WHERE audit_sequence=%s",
                    (sequence,),
                ).fetchone()["acknowledged_at_ms"]
            )
            administrator.put_object(
                archive.BUCKET,
                original.object_name,
                io.BytesIO(original_data),
                len(original_data),
                retention=Retention(COMPLIANCE, protected_until),
            )
            self.assertEqual(exporter.tick(), 1)
            sequence = append(connect("ofz_api"), "receipt-after-clock-snapshot")
            newer_receipt = database.execute(
                "SELECT sequence,receipt,encode(target_hash,'hex') AS target_hash,created_at_ms FROM ofz.audit WHERE sequence=%s",
                (sequence,),
            ).fetchone()
            deadline_receipt = exporter.store(
                [newer_receipt], newer_receipt["created_at_ms"] - 2000
            )
            required_until = datetime.fromtimestamp(
                newer_receipt["created_at_ms"] / 1000, UTC
            ) + timedelta(days=90)
            self.assertGreaterEqual(
                datetime.fromisoformat(deadline_receipt.retained_until), required_until
            )
            self.assertEqual(exporter.tick(), 1)
            original_budget = archive.MAX_BATCH_BYTES
            try:
                archive.MAX_BATCH_BYTES = 3000
                for index in range(6):
                    append(connect("ofz_api"), f"bounded-batch-{index}-" + "x" * 900)
                counts = []
                while database.execute(
                    "SELECT count(*) AS pending FROM ofz.audit_outbox WHERE acknowledged_at_ms IS NULL"
                ).fetchone()["pending"]:
                    counts.append(exporter.tick())
                self.assertEqual(sum(counts), 6)
                self.assertGreater(len(counts), 1)
                self.assertTrue(all(count > 0 for count in counts))
            finally:
                archive.MAX_BATCH_BYTES = original_budget
            print(
                "PASS: versioned compliance archive; fixture encrypted multipart and ciphertext proof; Ceph-compatible versions verified by hash and retention; real bootstrap/activation; owner and writer role boundaries; version-specific deletion and retention shortening denied; interrupted upload retries; out-of-order audit commits; crash/restart readback; archive failure fences without fabricated acknowledgement"
            )


if __name__ == "__main__":
    unittest.main()
