#!/usr/bin/env python3
"""Export Ofz audit receipts before acknowledging them in the control database."""

import argparse
import hashlib
import io
import json
import os
import re
import stat
import sys
import time
from dataclasses import asdict, dataclass
from datetime import UTC, datetime, timedelta
from xml.etree import ElementTree

import psycopg
import urllib3
from minio import Minio
from minio.error import S3Error
from minio.retention import COMPLIANCE, Retention
from psycopg.conninfo import conninfo_to_dict
from psycopg.rows import dict_row

BUCKET = "ofz-audit"
ENDPOINT = "rook-ceph-rgw-objectstore.rook-ceph.svc.cluster.local:80"
MAX_BATCH_BYTES = 4 * 1024 * 1024
RETENTION_DAYS = 90
IDLE_HEARTBEAT_MS = 10_000
EXPORT_LOCK = 726635522919
PENDING_AUDIT_QUERY = """
    WITH candidates AS MATERIALIZED (
        (SELECT sequence FROM ofz.audit
         WHERE sequence>%s ORDER BY sequence LIMIT 64)
        UNION
        (SELECT audit_sequence FROM ofz.audit_outbox
         WHERE acknowledged_at_ms IS NULL ORDER BY audit_sequence LIMIT 64)
        UNION
        (SELECT a.sequence FROM ofz.audit a
         WHERE NOT EXISTS (
             SELECT 1 FROM ofz.audit_outbox o WHERE o.audit_sequence=a.sequence
         ) ORDER BY a.sequence LIMIT 64)
        ORDER BY sequence LIMIT 64
    )
    SELECT a.sequence,a.receipt,encode(a.target_hash,'hex') AS target_hash,
           a.created_at_ms,o.audit_sequence IS NOT NULL AS has_outbox
    FROM candidates c JOIN ofz.audit a ON a.sequence=c.sequence
    LEFT JOIN ofz.audit_outbox o ON o.audit_sequence=a.sequence
    ORDER BY a.sequence
"""


class ArchiveError(Exception):
    pass


class CephArchive(Minio):
    def get_object_retention(self, bucket_name, object_name, version_id=None):
        query = {"retention": ""}
        if version_id:
            query["versionId"] = version_id
        response = self._execute(
            "GET", bucket_name, object_name=object_name, query_params=query
        )
        retention = ElementTree.fromstring(response.data)
        value = retention.findtext("{*}RetainUntilDate")
        if not value:
            raise ArchiveError("archive retention deadline missing")
        # Ceph returns nanosecond precision, which Minio's timestamp decoder rejects.
        until = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if until.tzinfo is None:
            raise ArchiveError("archive retention deadline requires an offset")
        return Retention(retention.findtext("{*}Mode"), until)


def failure_report(failure: Exception, event: str) -> dict:
    report = {"event": event, "error": type(failure).__name__}
    if isinstance(failure, ArchiveError):
        report["reason"] = str(failure)
    elif isinstance(failure, S3Error):
        report["code"] = failure.code[:64]
    elif isinstance(failure, psycopg.Error) and failure.sqlstate:
        report["sqlstate"] = failure.sqlstate
    return report


def credential(path: str) -> str:
    descriptor = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
    with os.fdopen(descriptor, "rb") as source:
        metadata = os.fstat(source.fileno())
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_mode & 0o037:
            raise ArchiveError("private credential file required")
        value = source.read(16 * 1024 + 1)
    if len(value) > 16 * 1024:
        raise ArchiveError("credential exceeds limit")
    value = value.decode().rstrip("\r\n")
    if not value or "\x00" in value:
        raise ArchiveError("invalid credential")
    return value


def encode_batch(rows: list[dict]) -> bytes:
    return json.dumps(
        {"schemaVersion": 1, "records": rows}, sort_keys=True, separators=(",", ":")
    ).encode()


@dataclass(frozen=True)
class Receipt:
    key: str
    version_id: str
    sha256: str
    retained_until: str

    @classmethod
    def decode(cls, value: str) -> "Receipt":
        receipt = cls(**json.loads(value))
        if (
            not re.fullmatch(
                r"batches/[1-9][0-9]*-[1-9][0-9]*-[a-f0-9]{64}\.json", receipt.key
            )
            or not re.fullmatch(r"[a-f0-9]{64}", receipt.sha256)
            or not receipt.key.endswith(f"-{receipt.sha256}.json")
            or not receipt.version_id
            or len(receipt.version_id) > 1024
            or datetime.fromisoformat(receipt.retained_until).tzinfo is None
        ):
            raise ArchiveError("invalid independent archive receipt")
        return receipt

    def encode(self) -> str:
        return json.dumps(asdict(self), sort_keys=True, separators=(",", ":"))


class Exporter:
    def __init__(self, database: psycopg.Connection, storage: CephArchive):
        self.database = database
        self.storage = storage

    def acquire(self) -> bool:
        row = self.database.execute(
            "SELECT current_user='ofz_archiver' AND current_database()='ofz_control' "
            "AND NOT rolsuper AS allowed FROM pg_roles WHERE rolname=current_user"
        ).fetchone()
        if not row or not row["allowed"]:
            raise ArchiveError("separate non-superuser archive role required")
        return self.database.execute(
            "SELECT pg_try_advisory_lock(%s) AS acquired", (EXPORT_LOCK,)
        ).fetchone()["acquired"]

    def verify_destination(self) -> None:
        versioning = self.storage.get_bucket_versioning(BUCKET)
        retention = self.storage.get_object_lock_config(BUCKET)
        if (
            versioning.status != "Enabled"
            or retention.mode != COMPLIANCE
            or retention.duration_unit != "Days"
            or retention.duration < RETENTION_DAYS
        ):
            raise ArchiveError(
                "versioned compliance archive with ninety-day retention required"
            )

    def verify_object(self, receipt: Receipt) -> None:
        retention = self.storage.get_object_retention(
            BUCKET, receipt.key, version_id=receipt.version_id
        )
        if (
            retention.mode != COMPLIANCE
            or retention.retain_until_date is None
            or retention.retain_until_date
            < datetime.fromisoformat(receipt.retained_until)
        ):
            raise ArchiveError("independent object retention mismatch")
        response = self.storage.get_object(
            BUCKET, receipt.key, version_id=receipt.version_id
        )
        try:
            data = response.read(MAX_BATCH_BYTES + 1)
        finally:
            response.close()
            response.release_conn()
        if (
            len(data) > MAX_BATCH_BYTES
            or hashlib.sha256(data).hexdigest() != receipt.sha256
        ):
            raise ArchiveError("independent object readback mismatch")

    def store(self, rows: list[dict], now_ms: int) -> Receipt:
        data = encode_batch(rows)
        if len(data) > MAX_BATCH_BYTES:
            raise ArchiveError("audit batch exceeds its byte budget")
        digest = hashlib.sha256(data).hexdigest()
        key = f"batches/{rows[0]['sequence']}-{rows[-1]['sequence']}-{digest}.json"
        minimum = datetime.fromtimestamp((now_ms + 999) // 1000, UTC) + timedelta(
            days=RETENTION_DAYS
        )
        required = datetime.fromtimestamp(
            (max(row["created_at_ms"] for row in rows) + 999) // 1000, UTC
        ) + timedelta(days=RETENTION_DAYS)
        minimum = max(minimum, required)
        try:
            existing = self.storage.stat_object(BUCKET, key)
            version = existing.version_id
            retention = self.storage.get_object_retention(
                BUCKET, key, version_id=version
            )
            until = retention.retain_until_date
            if until is None or until < required:
                raise ArchiveError(
                    "existing archive retention does not cover the audit receipts"
                )
        except S3Error as error:
            if error.code not in {"NoSuchKey", "NoSuchObject"}:
                raise
            stored = self.storage.put_object(
                BUCKET,
                key,
                io.BytesIO(data),
                len(data),
                content_type="application/json",
                metadata={"sha256": digest},
                retention=Retention(COMPLIANCE, minimum),
            )
            version = stored.version_id
            until = minimum
        if not version:
            raise ArchiveError("versioned independent object required")
        receipt = Receipt(key, version, digest, until.isoformat())
        self.verify_object(receipt)
        return receipt

    def tick(self) -> int:
        try:
            try:
                return self._tick()
            except urllib3.exceptions.HTTPError as failure:
                # A broken connection can recover on a fresh request. Repeat the
                # complete verification; uncertain uploads already reuse their key.
                print(
                    json.dumps(failure_report(failure, "audit_archive_verify_retry")),
                    file=sys.stderr,
                    flush=True,
                )
                return self._tick()
        except Exception:
            try:
                self.database.execute(
                    "UPDATE ofz.archive_state SET acknowledged_at_ms=0 "
                    "WHERE acknowledged_at_ms<>0"
                )
            except psycopg.Error as failure:
                print(
                    json.dumps(
                        failure_report(failure, "archive_health_invalidation_failed")
                    ),
                    file=sys.stderr,
                )
            raise

    def _tick(self) -> int:
        self.verify_destination()
        state = self.database.execute(
            "SELECT acknowledged_sequence,ofz.now_ms() AS now_ms FROM ofz.archive_state"
        ).fetchone()
        rows = self.database.execute(
            PENDING_AUDIT_QUERY,
            (state["acknowledged_sequence"],),
        ).fetchall()
        if not rows:
            if state["acknowledged_sequence"]:
                previous = self.database.execute(
                    "SELECT archive_receipt FROM ofz.audit_outbox WHERE audit_sequence=%s",
                    (state["acknowledged_sequence"],),
                ).fetchone()
                if not previous or not previous["archive_receipt"]:
                    raise ArchiveError(
                        "checkpoint lacks an independent archive receipt"
                    )
                self.verify_object(Receipt.decode(previous["archive_receipt"]))
            self.database.execute(
                "UPDATE ofz.archive_state SET acknowledged_at_ms=ofz.now_ms() "
                "WHERE acknowledged_sequence=%s AND "
                "(acknowledged_at_ms<=ofz.now_ms()-%s OR acknowledged_at_ms>ofz.now_ms())",
                (state["acknowledged_sequence"], IDLE_HEARTBEAT_MS),
            )
            return 0
        if any(not row.pop("has_outbox") for row in rows):
            raise ArchiveError("audit receipt lacks its durable outbox entry")
        while len(encode_batch(rows)) > MAX_BATCH_BYTES:
            if len(rows) == 1:
                raise ArchiveError("audit receipt exceeds its byte budget")
            rows = rows[: len(rows) // 2]
        receipt = self.store(rows, state["now_ms"])
        sequences = [row["sequence"] for row in rows]
        with self.database.transaction():
            acknowledged = self.database.execute(
                "UPDATE ofz.audit_outbox SET acknowledged_at_ms=coalesce(acknowledged_at_ms,ofz.now_ms()),"
                "archive_receipt=coalesce(archive_receipt,%s) WHERE audit_sequence=ANY(%s)",
                (receipt.encode(), sequences),
            ).rowcount
            self.database.execute(
                "UPDATE ofz.archive_state SET acknowledged_sequence=greatest(acknowledged_sequence,%s),"
                "acknowledged_at_ms=ofz.now_ms(),batch_hash=%s "
                "WHERE NOT EXISTS(SELECT 1 FROM ofz.audit a LEFT JOIN ofz.audit_outbox o "
                "ON o.audit_sequence=a.sequence WHERE a.sequence<=%s AND o.acknowledged_at_ms IS NULL)",
                (sequences[-1], receipt.sha256, sequences[-1]),
            )
            if acknowledged != len(sequences):
                raise ArchiveError("audit acknowledgement changed")
        return len(sequences)


def from_environment() -> Exporter:
    config = conninfo_to_dict(os.environ["OFZ_DATABASE_DSN"])
    if (
        config.get("user") != "ofz_archiver"
        or config.get("dbname") != "ofz_control"
        or "password" in config
        or config.get("sslmode") not in {"require", "verify-full"}
    ):
        raise ArchiveError("mounted archive-role TLS database credentials required")
    config.update(
        password=credential(os.environ["OFZ_DATABASE_PASSWORD_FILE"]),
        sslmode="verify-full",
        sslrootcert=os.environ["OFZ_DATABASE_CA_FILE"],
        connect_timeout="2",
        application_name="ofz-audit-export",
        client_encoding="UTF8",
        keepalives_idle="5",
        keepalives_interval="2",
        keepalives_count="3",
        options="-c statement_timeout=2000 -c lock_timeout=1000 -c idle_in_transaction_session_timeout=5000 -c idle_session_timeout=15000",
    )
    database = psycopg.connect(**config, autocommit=True, row_factory=dict_row)
    storage = CephArchive(
        ENDPOINT,
        access_key=credential(os.environ["OFZ_ARCHIVE_ACCESS_KEY_FILE"]),
        secret_key=credential(os.environ["OFZ_ARCHIVE_SECRET_KEY_FILE"]),
        secure=False,
        region="us-east-1",
        http_client=urllib3.PoolManager(
            timeout=urllib3.Timeout(total=8, connect=2, read=5),
            retries=False,
            maxsize=2,
        ),
    )
    return Exporter(database, storage)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--once", action="store_true")
    arguments = parser.parse_args()
    exporter = from_environment()
    with exporter.database:
        while not exporter.acquire():
            if arguments.once:
                raise ArchiveError("another exporter holds the database lease")
            time.sleep(1)
        while True:
            try:
                count = exporter.tick()
            except urllib3.exceptions.HTTPError as failure:
                if arguments.once:
                    raise
                print(
                    json.dumps(failure_report(failure, "audit_archive_retry")),
                    file=sys.stderr,
                    flush=True,
                )
                time.sleep(1)
                continue
            if count:
                print(
                    json.dumps({"event": "audit_archived", "receipts": count}),
                    flush=True,
                )
            if arguments.once:
                return 0
            time.sleep(1)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as failure:
        print(
            json.dumps(failure_report(failure, "audit_archive_failed")), file=sys.stderr
        )
        sys.exit(1)
