#!/usr/bin/env python3
"""Prepare the disposable S3 archive used by integration tests."""

import argparse
import hashlib
import io
import json
import os
import secrets
import ssl
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

import urllib3
from minio import Minio
from minio.commonconfig import ENABLED, Filter
from minio.error import S3Error
from minio.lifecycleconfig import (
    Expiration,
    LifecycleConfig,
    NoncurrentVersionExpiration,
)
from minio.lifecycleconfig import (
    Rule as LifecycleRule,
)
from minio.objectlockconfig import ObjectLockConfig
from minio.retention import COMPLIANCE, Retention
from minio.sse import SseS3
from minio.sseconfig import Rule, SSEConfig

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from audit_export import (
    BUCKET,
    ENDPOINT,
    RETENTION_DAYS,
    ArchiveError,
    credential,
    failure_report,
)  # noqa: E402

DATABASE_BUCKETS = {
    "ofz": "ofz-database-backups",
    "keycloak": "keycloak-database-backups",
}
DATABASE_RETENTION_DAYS = 30


def write_private(path: Path, value: str, *, exclusive: bool = False) -> None:
    flags = os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW
    flags |= os.O_EXCL if exclusive else os.O_TRUNC
    with os.fdopen(os.open(path, flags, 0o600), "w") as target:
        os.fchmod(target.fileno(), 0o600)
        target.write(value)
        target.flush()
        os.fsync(target.fileno())


def persist_once(path: Path, value: str) -> None:
    temporary = path.with_name(f".{path.name}-{secrets.token_hex(8)}")
    write_private(temporary, value, exclusive=True)
    try:
        os.link(temporary, path)
    except FileExistsError:
        pass
    finally:
        temporary.unlink()
    descriptor = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def prepare(directory: Path) -> None:
    if (
        directory.is_symlink()
        or not directory.is_dir()
        or directory.stat().st_mode & 0o077
    ):
        raise ArchiveError("dedicated private credential directory required")
    manifest = directory / "manifest.json"
    if not manifest.exists():
        values = {
            "version": 1,
            "root_access_key": f"OFZROOT{secrets.token_hex(10).upper()}",
            "root_secret_key": secrets.token_hex(32),
            "archive_access_key": f"OFZAUDIT{secrets.token_hex(10).upper()}",
            "archive_secret_key": secrets.token_hex(32),
        }
        persist_once(manifest, json.dumps(values, sort_keys=True))
    encryption_key = directory / "sse_kek"
    encryption_fingerprint = directory / "sse_kek.sha256"
    if not encryption_key.exists():
        if encryption_fingerprint.exists():
            raise ArchiveError("restore the original recovery encryption key")
        persist_once(encryption_key, secrets.token_hex(32))
    key = credential(str(encryption_key))
    try:
        valid_key = len(key) == 64 and len(bytes.fromhex(key)) == 32
    except ValueError:
        valid_key = False
    if not valid_key:
        raise ArchiveError("invalid persistent recovery encryption key")
    fingerprint = hashlib.sha256(bytes.fromhex(key)).hexdigest()
    if not encryption_fingerprint.exists():
        persist_once(encryption_fingerprint, fingerprint)
    if credential(str(encryption_fingerprint)) != fingerprint:
        raise ArchiveError("recovery encryption key identity changed")
    write_private(directory / "security.toml", f'[s3.sse]\nkek = "{key}"\n')
    values = json.loads(credential(str(manifest)))
    names = {
        "root_access_key",
        "root_secret_key",
        "archive_access_key",
        "archive_secret_key",
    }
    if values.get("version") != 1 or set(values) != names | {"version"}:
        raise ArchiveError("unsupported recovery credential manifest")
    for name in names:
        if (
            not isinstance(values[name], str)
            or not values[name].isalnum()
            or len(values[name]) < 20
        ):
            raise ArchiveError("invalid recovery credential manifest")
        write_private(directory / name, values[name])
    policy = json.loads(Path(__file__).with_name("audit-policy.json").read_text())
    identities = [
        {
            "name": "ofz-recovery-custodian",
            "credentials": [
                {
                    "access_key": values["root_access_key"],
                    "secret_key": values["root_secret_key"],
                }
            ],
            "actions": ["Admin"],
        },
        {
            "name": "ofz-audit-export",
            "credentials": [
                {
                    "access_key": values["archive_access_key"],
                    "secret_key": values["archive_secret_key"],
                }
            ],
            "policy_names": ["audit-export"],
        },
    ]
    database_manifest = directory / "database-writers.json"
    database_fingerprint = directory / "database-writers.sha256"
    if not database_manifest.exists():
        if database_fingerprint.exists():
            raise ArchiveError("restore the original database backup credentials")
        persist_once(
            database_manifest,
            json.dumps(
                {
                    name: {
                        "access_key": f"{name.upper()}DB{secrets.token_hex(10).upper()}",
                        "secret_key": secrets.token_hex(32),
                    }
                    for name in DATABASE_BUCKETS
                },
                sort_keys=True,
            ),
        )
    database_values = credential(str(database_manifest))
    digest = hashlib.sha256(database_values.encode()).hexdigest()
    persist_once(database_fingerprint, digest)
    if credential(str(database_fingerprint)) != digest:
        raise ArchiveError("database backup credential identity changed")
    writers = json.loads(database_values)
    if set(writers) != set(DATABASE_BUCKETS):
        raise ArchiveError("unsupported database backup credentials")
    policies = [{"name": "audit-export", "content": json.dumps(policy)}]
    database_policy = Path(__file__).with_name("database-policy.json").read_text()
    for name, bucket in DATABASE_BUCKETS.items():
        keys = writers[name]
        if set(keys) != {"access_key", "secret_key"} or any(
            not isinstance(value, str) or not value.isalnum() or len(value) < 20
            for value in keys.values()
        ):
            raise ArchiveError("invalid database backup credentials")
        identities.append(
            {
                "name": f"{name}-database-backup",
                "credentials": [keys],
                "policy_names": [name],
            }
        )
        policies.append(
            {"name": name, "content": database_policy.replace("BACKUP_BUCKET", bucket)}
        )
    write_private(
        directory / "s3.json",
        json.dumps(
            {
                "identities": identities,
                "policies": policies,
            },
            sort_keys=True,
        ),
    )


def client(directory: Path, *, root: bool, local: bool = False) -> Minio:
    prefix = "root" if root else "archive"
    return Minio(
        "127.0.0.1:9445" if local else ENDPOINT,
        access_key=credential(str(directory / f"{prefix}_access_key")),
        secret_key=credential(str(directory / f"{prefix}_secret_key")),
        secure=not local,
        region="us-east-1",
        http_client=urllib3.PoolManager(
            ssl_context=ssl.create_default_context(
                cafile=os.environ.get("SSL_CERT_FILE")
            ),
            timeout=urllib3.Timeout(total=8, connect=2, read=5),
            retries=False,
        ),
    )


def configure(directory: Path, storage: Minio | None = None) -> None:
    storage = storage or client(directory, root=True, local=True)
    configure_bucket(storage, BUCKET, RETENTION_DAYS)
    for bucket in DATABASE_BUCKETS.values():
        configure_bucket(storage, bucket, DATABASE_RETENTION_DAYS)
        lifecycle = LifecycleConfig(
            [
                LifecycleRule(
                    ENABLED,
                    rule_filter=Filter(prefix=""),
                    rule_id="database-retention",
                    expiration=Expiration(days=40),
                    noncurrent_version_expiration=NoncurrentVersionExpiration(
                        noncurrent_days=45
                    ),
                )
            ]
        )
        storage.set_bucket_lifecycle(bucket, lifecycle)


def configure_bucket(storage: Minio, bucket: str, retention_days: int) -> None:
    if not storage.bucket_exists(bucket):
        storage.make_bucket(bucket, object_lock=True)
    try:
        existing = storage.get_object_lock_config(bucket)
    except S3Error as error:
        if error.code != "ObjectLockConfigurationNotFoundError":
            raise
        existing = ObjectLockConfig(None, None, None)
    if existing.mode is None:
        storage.set_object_lock_config(
            bucket, ObjectLockConfig(COMPLIANCE, retention_days, "Days")
        )
    elif (
        existing.mode != COMPLIANCE
        or existing.duration_unit != "Days"
        or existing.duration < retention_days
    ):
        raise ArchiveError("existing archive has an unapproved retention policy")
    encryption = storage.get_bucket_encryption(bucket)
    if encryption is None:
        storage.set_bucket_encryption(bucket, SSEConfig(Rule.new_sse_s3_rule()))
    elif encryption.rule != Rule.new_sse_s3_rule():
        raise ArchiveError("existing archive has an unapproved encryption policy")


def denied(operation) -> None:
    try:
        operation()
    except S3Error as error:
        if error.code in {"AccessDenied", "InvalidRequest"}:
            return
        raise
    raise ArchiveError("archive accepted a forbidden mutation")


def verify(
    directory: Path, writer: Minio | None = None, root: Minio | None = None
) -> dict:
    writer = writer or client(directory, root=False)
    root = root or client(directory, root=True)
    config = writer.get_object_lock_config(BUCKET)
    if (
        writer.get_bucket_versioning(BUCKET).status != "Enabled"
        or config.mode != COMPLIANCE
        or config.duration_unit != "Days"
        or config.duration < RETENTION_DAYS
    ):
        raise ArchiveError("versioned ninety-day compliance archive required")
    data = b"Ofz independent archive qualification version 1\n"
    digest = hashlib.sha256(data).hexdigest()
    key = f"qualification/{digest}.txt"
    until = datetime.now(UTC).replace(microsecond=0) + timedelta(
        days=RETENTION_DAYS, seconds=1
    )
    written = writer.put_object(
        BUCKET,
        key,
        io.BytesIO(data),
        len(data),
        retention=Retention(COMPLIANCE, until),
        sse=SseS3(),
    )
    if not written.version_id:
        raise ArchiveError("archive did not return an immutable version")
    retention = writer.get_object_retention(BUCKET, key, version_id=written.version_id)
    if retention.mode != COMPLIANCE or retention.retain_until_date < until:
        raise ArchiveError("archive retention readback failed")
    response = writer.get_object(BUCKET, key, version_id=written.version_id)
    try:
        if response.headers.get("x-amz-server-side-encryption") != "AES256":
            raise ArchiveError("archive encryption readback failed")
        if response.read(len(data) + 1) != data:
            raise ArchiveError("archive version readback failed")
    finally:
        response.close()
        response.release_conn()
    denied(lambda: writer.remove_object(BUCKET, key))
    denied(lambda: writer.remove_object(BUCKET, key, version_id=written.version_id))
    denied(lambda: root.remove_object(BUCKET, key, version_id=written.version_id))
    denied(
        lambda: writer.set_object_lock_config(
            BUCKET, ObjectLockConfig(COMPLIANCE, 1, "Days")
        )
    )
    denied(
        lambda: root.set_object_retention(
            BUCKET,
            key,
            Retention(COMPLIANCE, datetime.now(UTC) + timedelta(days=1)),
            version_id=written.version_id,
        )
    )
    return {
        "expectedEndpoint": f"https://{ENDPOINT}",
        "bucket": BUCKET,
        "mode": COMPLIANCE,
        "retainedUntil": retention.retain_until_date.isoformat(),
        "versionId": written.version_id,
        "sha256": digest,
        "encryption": "AES256",
        "writerDeleteDenied": True,
        "rootVersionDeleteDenied": True,
        "retentionShorteningDenied": True,
    }


def database_clients(directory: Path, *, local: bool = False) -> dict[str, Minio]:
    values = json.loads(credential(str(directory / "database-writers.json")))
    return {
        name: Minio(
            "127.0.0.1:9445" if local else ENDPOINT,
            access_key=keys["access_key"],
            secret_key=keys["secret_key"],
            secure=not local,
            region="us-east-1",
            http_client=urllib3.PoolManager(
                ssl_context=ssl.create_default_context(
                    cafile=os.environ.get("SSL_CERT_FILE")
                ),
                timeout=urllib3.Timeout(total=8, connect=2, read=5),
                retries=False,
            ),
        )
        for name, keys in values.items()
    }


def verify_databases(
    directory: Path,
    writers: dict[str, Minio] | None = None,
    root: Minio | None = None,
) -> list[dict]:
    writers = writers or database_clients(directory)
    root = root or client(directory, root=True)
    report = []
    for name, bucket in DATABASE_BUCKETS.items():
        writer = writers[name]
        config = writer.get_object_lock_config(bucket)
        if (
            writer.get_bucket_versioning(bucket).status != "Enabled"
            or config.mode != COMPLIANCE
            or config.duration_unit != "Days"
            or config.duration < DATABASE_RETENTION_DAYS
        ):
            raise ArchiveError("versioned thirty-day database retention required")
        data = f"{name} independent database storage qualification\n".encode()
        digest = hashlib.sha256(data).hexdigest()
        key = f"qualification/{digest}.txt"
        minimum = datetime.now(UTC) + timedelta(
            days=DATABASE_RETENTION_DAYS, minutes=-1
        )
        written = writer.put_object(
            bucket, key, io.BytesIO(data), len(data), sse=SseS3()
        )
        if not written.version_id:
            raise ArchiveError("database archive returned no immutable version")
        retained = writer.get_object_retention(
            bucket, key, version_id=written.version_id
        )
        if retained.mode != COMPLIANCE or retained.retain_until_date < minimum:
            raise ArchiveError("database retention readback failed")
        response = writer.get_object(bucket, key, version_id=written.version_id)
        try:
            if (
                response.headers.get("x-amz-server-side-encryption") != "AES256"
                or response.read(len(data) + 1) != data
            ):
                raise ArchiveError("encrypted database version readback failed")
        finally:
            response.close()
            response.release_conn()
        listed = next(writer.list_objects(bucket, prefix=key), None)
        if listed is None or listed.object_name != key:
            raise ArchiveError("database writer cannot list its backup")
        denied(lambda: writer.remove_object(bucket, key, version_id=written.version_id))
        denied(lambda: root.remove_object(bucket, key, version_id=written.version_id))
        for other in [BUCKET, *DATABASE_BUCKETS.values()]:
            if other != bucket:
                denied(
                    lambda: writer.put_object(other, key, io.BytesIO(data), len(data))
                )
                denied(lambda: writer.get_object(other, key))
        denied(
            lambda: writer.set_bucket_encryption(
                bucket, SSEConfig(Rule.new_sse_s3_rule())
            )
        )
        report.append(
            {
                "bucket": bucket,
                "versionId": written.version_id,
                "sha256": digest,
                "encryption": "AES256",
                "retainedUntil": retained.retain_until_date.isoformat(),
                "crossBucketWriteDenied": True,
                "crossBucketReadDenied": True,
                "rootVersionDeleteDenied": True,
            }
        )
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "operation", choices=["prepare", "configure", "verify", "verify-local"]
    )
    parser.add_argument("directory", type=Path)
    arguments = parser.parse_args()
    if arguments.operation == "prepare":
        prepare(arguments.directory)
    elif arguments.operation == "configure":
        configure(arguments.directory)
    else:
        local = arguments.operation == "verify-local"
        root = client(arguments.directory, root=True, local=local)
        report = verify(
            arguments.directory,
            writer=client(arguments.directory, root=False, local=local),
            root=root,
        )
        report["databases"] = verify_databases(
            arguments.directory,
            writers=database_clients(arguments.directory, local=local),
            root=root,
        )
        if local:
            report["boundary"] = "NUC loopback S3"
        print(json.dumps(report, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except Exception as failure:
        print(
            json.dumps(failure_report(failure, "recovery_initialization_failed")),
            file=sys.stderr,
        )
        sys.exit(1)
