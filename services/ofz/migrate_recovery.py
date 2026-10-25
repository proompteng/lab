#!/usr/bin/env python3
"""Move the three Ofz/Keycloak recovery buckets from NUC to Ceph."""

import argparse
import base64
import hashlib
import json
import sqlite3
import subprocess
import tempfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path

BUCKETS = ("ofz-database-backups", "keycloak-database-backups", "ofz-audit")
CONTEXT = "galactic-tailscale"


def command(args, data=None):
    result = subprocess.run(args, input=data, capture_output=True)
    if result.returncode:
        raise RuntimeError(f"{args[0]} failed with exit code {result.returncode}")
    return result.stdout


def source_credentials():
    root = Path("/var/lib/ofz-recovery/secrets")
    manifest = json.loads(
        command(["ssh", "nuc", "sudo", "-n", "cat", str(root / "manifest.json")])
    )
    writers = json.loads(
        command(
            ["ssh", "nuc", "sudo", "-n", "cat", str(root / "database-writers.json")]
        )
    )
    return {
        "ofz-recovery-custodian": (
            manifest["root_access_key"],
            manifest["root_secret_key"],
        ),
        "ofz-audit-export": (
            manifest["archive_access_key"],
            manifest["archive_secret_key"],
        ),
        **{
            f"{name}-database-backup": (value["access_key"], value["secret_key"])
            for name, value in writers.items()
        },
    }


def client(endpoint, identity):
    import boto3
    from botocore.config import Config

    return boto3.client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id=identity[0],
        aws_secret_access_key=identity[1],
        region_name="us-east-1",
        config=Config(
            signature_version="s3v4",
            retries={"max_attempts": 2},
            connect_timeout=3,
            read_timeout=60,
            request_checksum_calculation="when_required",
            response_checksum_validation="when_required",
            s3={"addressing_style": "path", "payload_signing_enabled": True},
            max_pool_connections=64,
        ),
    )


def versions(storage, bucket):
    result = []
    for page in storage.get_paginator("list_object_versions").paginate(Bucket=bucket):
        result.extend(
            dict(item, DeleteMarker=False) for item in page.get("Versions", [])
        )
        result.extend(
            dict(item, DeleteMarker=True) for item in page.get("DeleteMarkers", [])
        )
    # S3 lists equal-timestamp versions newest first, separately from delete markers.
    return sorted(
        reversed(result),
        key=lambda item: (item["Key"], item["LastModified"], item["IsLatest"]),
    )


def verify_inventory(source, target, ledger):
    target_versions = {(item["Key"], item["VersionId"]): item for item in target}
    current = {item["Key"]: item["VersionId"] for item in target if item["IsLatest"]}
    for item in source:
        record = ledger[json.dumps([item["Key"], item["VersionId"]])]
        copied = target_versions.get((item["Key"], record["version_id"]))
        if copied is None or copied["DeleteMarker"] != item["DeleteMarker"]:
            raise RuntimeError(
                "Destination version or delete marker is missing or differs"
            )
        if item["IsLatest"] and current.get(item["Key"]) != record["version_id"]:
            raise RuntimeError("Destination current version differs from source")


def admin(*args, data=None, optional=False):
    result = subprocess.run(
        [
            "kubectl",
            "--context",
            CONTEXT,
            "-n",
            "rook-ceph",
            "exec",
            "-i",
            "deployment/rook-ceph-tools",
            "--",
            "radosgw-admin",
            "--rgw-realm=objectstore",
            "--rgw-zonegroup=objectstore",
            "--rgw-zone=objectstore",
            *args,
        ],
        input=data,
        capture_output=True,
    )
    if optional and result.returncode:
        return None
    if result.returncode:
        raise RuntimeError(
            f"Ceph user operation failed with exit code {result.returncode}"
        )
    return json.loads(result.stdout or b"null")


def provision(endpoint, identities, directory):
    path = directory / "destination-identities.json"
    credentials = json.loads(path.read_text()) if path.exists() else {}
    for uid in identities:
        existing = admin("user", "info", f"--uid={uid}", optional=True)
        if existing is None:
            existing = admin(
                "user",
                "create",
                f"--uid={uid}",
                f"--display-name={uid}",
                "--gen-access-key=false",
                "--gen-secret=false",
            )
        if uid not in credentials:
            before = {key["access_key"] for key in existing["keys"]}
            updated = admin(
                "key", "create", f"--uid={uid}", "--gen-access-key", "--gen-secret"
            )
            key = next(
                key for key in updated["keys"] if key["access_key"] not in before
            )
            credentials[uid] = [key["access_key"], key["secret_key"]]
            path.touch(mode=0o600, exist_ok=True)
            path.write_text(json.dumps(credentials))
        if uid != "ofz-recovery-custodian":
            admin("user", "modify", f"--uid={uid}", "--max-buckets=0")
    destination = client(endpoint, credentials["ofz-recovery-custodian"])
    for bucket in BUCKETS:
        try:
            destination.head_bucket(Bucket=bucket)
        except destination.exceptions.ClientError as error:
            if error.response["ResponseMetadata"]["HTTPStatusCode"] not in {403, 404}:
                raise
            destination.create_bucket(Bucket=bucket, ObjectLockEnabledForBucket=True)
        destination.put_bucket_versioning(
            Bucket=bucket, VersioningConfiguration={"Status": "Enabled"}
        )
        days = 90 if bucket == "ofz-audit" else 30
        destination.put_object_lock_configuration(
            Bucket=bucket,
            ObjectLockConfiguration={
                "ObjectLockEnabled": "Enabled",
                "Rule": {"DefaultRetention": {"Mode": "COMPLIANCE", "Days": days}},
            },
        )
        uid = "ofz-audit-export" if bucket == "ofz-audit" else bucket.removesuffix("s")
        actions = [
            "s3:ListBucket",
            "s3:GetBucketVersioning",
            "s3:GetBucketObjectLockConfiguration",
            "s3:GetObject",
            "s3:GetObjectVersion",
            "s3:GetObjectRetention",
            "s3:PutObject",
        ]
        if bucket == "ofz-audit":
            actions += ["s3:PutObjectRetention"]
        else:
            actions += [
                "s3:ListBucketVersions",
                "s3:GetBucketLocation",
                "s3:ListBucketMultipartUploads",
                "s3:DeleteObject",
                "s3:AbortMultipartUpload",
                "s3:ListMultipartUploadParts",
            ]
            destination.put_bucket_lifecycle_configuration(
                Bucket=bucket,
                LifecycleConfiguration={
                    "Rules": [
                        {
                            "ID": "database-retention",
                            "Status": "Enabled",
                            "Filter": {"Prefix": ""},
                            "Expiration": {"Days": 40},
                            "NoncurrentVersionExpiration": {"NoncurrentDays": 45},
                        }
                    ]
                },
            )
        destination.put_bucket_policy(
            Bucket=bucket,
            Policy=json.dumps(
                {
                    "Version": "2012-10-17",
                    "Statement": [
                        {
                            "Effect": "Allow",
                            "Principal": {"AWS": f"arn:aws:iam:::user/{uid}"},
                            "Action": actions,
                            "Resource": [
                                f"arn:aws:s3:::{bucket}",
                                f"arn:aws:s3:::{bucket}/*",
                            ],
                        }
                    ],
                }
            ),
        )
        print(json.dumps({"bucket": bucket, "provisioned": True}), flush=True)


def digest_body(response):
    digest = hashlib.sha256()
    length = 0
    with response["Body"] as body:
        for block in iter(lambda: body.read(1024 * 1024), b""):
            length += len(block)
            digest.update(block)
    return length, digest.hexdigest()


def migrate_bucket(source, destination, bucket, directory, verify):
    inventory = versions(source, bucket)
    if any(item["DeleteMarker"] for item in inventory):
        raise RuntimeError("Source delete markers are outside this migration")
    ledger_path = directory / f"{bucket}.json"
    ledger = json.loads(ledger_path.read_text()) if ledger_path.exists() else {}
    database = sqlite3.connect(directory / f"{bucket}.sqlite")
    database.execute("PRAGMA journal_mode=WAL")
    database.execute(
        "CREATE TABLE IF NOT EXISTS versions (source TEXT PRIMARY KEY, record TEXT NOT NULL)"
    )
    ledger.update(
        (key, json.loads(value))
        for key, value in database.execute("SELECT source, record FROM versions")
    )
    groups = {}
    for item in inventory:
        groups.setdefault(item["Key"], []).append(item)
    existing = {}
    for item in versions(destination, bucket):
        if not item["DeleteMarker"]:
            existing.setdefault(item["Key"], []).append(item["VersionId"])

    def copy_key(items):
        copied = []
        for item in items:
            key, version = item["Key"], item["VersionId"]
            identity = json.dumps([key, version])
            record = ledger.get(identity)
            if record and not verify:
                copied.append((identity, record))
                continue
            options = {"Bucket": bucket, "Key": key, "VersionId": version}
            response = source.get_object(**options)
            retention = source.get_object_retention(**options).get("Retention", {})
            with tempfile.TemporaryFile() as buffer:
                original = hashlib.sha256()
                transport = hashlib.md5(usedforsecurity=False)
                length = 0
                with response["Body"] as body:
                    for block in iter(lambda: body.read(1024 * 1024), b""):
                        original.update(block)
                        transport.update(block)
                        length += len(block)
                        buffer.write(block)
                digest = original.hexdigest()
                if not record:
                    if verify:
                        raise RuntimeError("Uncopied object version")
                    for candidate in existing.get(key, []):
                        target = destination.head_object(
                            Bucket=bucket, Key=key, VersionId=candidate
                        )
                        metadata = target.get("Metadata", {})
                        if (
                            metadata.get("source-version") == version
                            and metadata.get("sha256") == digest
                        ):
                            record = {
                                "key": key,
                                "source_version": version,
                                "version_id": candidate,
                                "sha256": digest,
                                "bytes": length,
                                "retention": retention,
                            }
                            break
                if not record:
                    buffer.seek(0)
                    extra = {
                        "Metadata": {
                            **response.get("Metadata", {}),
                            "source-version": version,
                            "sha256": digest,
                        },
                        "ContentType": response.get(
                            "ContentType", "application/octet-stream"
                        ),
                    }
                    if retention.get("RetainUntilDate"):
                        extra.update(
                            ObjectLockMode=retention["Mode"],
                            ObjectLockRetainUntilDate=retention["RetainUntilDate"],
                        )
                    if length > 5 * 1024**3:
                        raise RuntimeError(
                            "Source object exceeds the migration's single-upload budget"
                        )
                    target = destination.put_object(
                        Bucket=bucket,
                        Key=key,
                        Body=buffer,
                        ContentLength=length,
                        ContentMD5=base64.b64encode(transport.digest()).decode(),
                        **extra,
                    )
                    record = {
                        "key": key,
                        "source_version": version,
                        "version_id": target["VersionId"],
                        "sha256": digest,
                        "bytes": length,
                        "retention": retention,
                    }
                target_options = {
                    "Bucket": bucket,
                    "Key": key,
                    "VersionId": record["version_id"],
                }
                if digest_body(destination.get_object(**target_options)) != (
                    length,
                    digest,
                ):
                    raise RuntimeError("Destination object bytes differ")
                actual = destination.get_object_retention(**target_options).get(
                    "Retention", {}
                )
                if retention.get("RetainUntilDate") and (
                    actual.get("Mode") != retention["Mode"]
                    or actual.get("RetainUntilDate") < retention["RetainUntilDate"]
                ):
                    raise RuntimeError("Destination retention is shorter")
            copied.append((identity, record))
        return copied

    with ThreadPoolExecutor(max_workers=32) as pool:
        count = 0
        pending = [pool.submit(copy_key, items) for items in groups.values()]
        for completed in as_completed(pending):
            try:
                records = completed.result()
            except BaseException:
                for task in pending:
                    task.cancel()
                raise
            ledger.update(records)
            count += len(records)
            with database:
                database.executemany(
                    "INSERT OR REPLACE INTO versions VALUES (?, ?)",
                    [(key, json.dumps(record, default=str)) for key, record in records],
                )
            if count % 100 == 0:
                print(
                    json.dumps(
                        {
                            "bucket": bucket,
                            "verified_versions": count,
                            "total": len(inventory),
                        }
                    ),
                    flush=True,
                )
    if len(ledger) != len(inventory):
        raise RuntimeError("Source inventory changed; reconcile before retiring it")
    verify_inventory(inventory, versions(destination, bucket), ledger)
    temporary = ledger_path.with_suffix(".tmp")
    temporary.write_text(json.dumps(ledger, default=str))
    temporary.replace(ledger_path)
    database.close()
    print(
        json.dumps(
            {
                "bucket": bucket,
                "verified_versions": len(inventory),
                "bytes": sum(item.get("bytes", 0) for item in ledger.values()),
            }
        ),
        flush=True,
    )


def rebind_audit(destination, directory):
    import psycopg

    def kube(kind, name):
        return json.loads(
            command(
                [
                    "kubectl",
                    "--context",
                    CONTEXT,
                    "-n",
                    "ofz",
                    "get",
                    kind,
                    name,
                    "-o",
                    "json",
                ]
            )
        )

    ledger = json.loads((directory / "ofz-audit.json").read_text())
    password = base64.b64decode(
        kube("secret", "ofz-archiver-db-auth")["data"]["password"]
    ).decode()
    ca = directory / "database-ca.crt"
    ca.write_bytes(base64.b64decode(kube("secret", "ofz-db-ca")["data"]["ca.crt"]))
    service = kube("service", "ofz-db-rw")
    with psycopg.connect(
        host="ofz-db-rw.ofz.svc.cluster.local",
        hostaddr=service["spec"]["clusterIP"],
        port=5432,
        dbname="ofz_control",
        user="ofz_archiver",
        password=password,
        sslmode="verify-full",
        sslrootcert=str(ca),
        application_name="ofz-recovery-migration",
        connect_timeout=5,
        autocommit=True,
        options="-c statement_timeout=120000 -c lock_timeout=15000",
    ) as database:
        database.execute(
            "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename=current_user "
            "AND application_name='ofz-audit-export' AND pid<>pg_backend_pid()"
        )
        database.execute("SELECT pg_advisory_lock(726635522919)")
        checkpoint = database.execute(
            "SELECT acknowledged_sequence,acknowledged_at_ms,batch_hash FROM ofz.archive_state"
        ).fetchone()
        receipts = database.execute(
            "SELECT DISTINCT archive_receipt FROM ofz.audit_outbox WHERE archive_receipt IS NOT NULL"
        ).fetchall()
        replacements = {}
        for (encoded,) in receipts:
            receipt = json.loads(encoded)
            record = ledger.get(json.dumps([receipt["key"], receipt["version_id"]]))
            if record:
                if record["sha256"] != receipt["sha256"]:
                    raise RuntimeError(
                        "Verified audit version does not match its SQL receipt"
                    )
                receipt["version_id"] = record["version_id"]
                replacements[encoded] = json.dumps(receipt, sort_keys=True)
            else:
                target = {
                    "Bucket": "ofz-audit",
                    "Key": receipt["key"],
                    "VersionId": receipt["version_id"],
                }
                if (
                    digest_body(destination.get_object(**target))[1]
                    != receipt["sha256"]
                ):
                    raise RuntimeError(
                        "Current Ceph audit receipt has a different hash"
                    )
                retention = destination.get_object_retention(**target)["Retention"]
                if retention["Mode"] != "COMPLIANCE" or retention[
                    "RetainUntilDate"
                ] < datetime.fromisoformat(receipt["retained_until"]):
                    raise RuntimeError(
                        "Current Ceph audit receipt has insufficient retention"
                    )
        with database.transaction():
            updated = database.execute(
                "WITH replacements AS (SELECT key,value FROM jsonb_each_text(%s::jsonb)) "
                "UPDATE ofz.audit_outbox AS o SET archive_receipt=r.value FROM replacements r WHERE o.archive_receipt=r.key",
                (json.dumps(replacements),),
            ).rowcount
            current = database.execute(
                "SELECT acknowledged_sequence,acknowledged_at_ms,batch_hash FROM ofz.archive_state"
            ).fetchone()
            if current != checkpoint:
                raise RuntimeError("Audit checkpoint changed during receipt migration")
        print(
            json.dumps(
                {
                    "audit_receipts_rebound": updated,
                    "distinct_versions": len(replacements),
                    "checkpoint_sequence": checkpoint[0],
                    "checkpoint_unchanged": True,
                }
            ),
            flush=True,
        )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "mode",
        choices=[
            "inventory",
            "provision",
            "copy",
            "verify",
            "seal-owner",
            "rebind-audit",
        ],
    )
    parser.add_argument("--destination", default="http://10.98.171.42")
    parser.add_argument("--evidence", type=Path, default=Path("/tmp/ofz-ceph-recovery"))
    args = parser.parse_args()
    args.evidence.mkdir(mode=0o700, parents=True, exist_ok=True)
    identities = source_credentials()
    owner = identities["ofz-recovery-custodian"]
    source = client("https://nuc.ide-newton.ts.net:9444", owner)
    if args.mode == "provision":
        provision(args.destination, identities, args.evidence)
    elif args.mode == "inventory":
        for bucket in BUCKETS:
            inventory = versions(source, bucket)
            print(
                json.dumps(
                    {
                        "bucket": bucket,
                        "versions": len(inventory),
                        "bytes": sum(item.get("Size", 0) for item in inventory),
                        "delete_markers": sum(
                            item["DeleteMarker"] for item in inventory
                        ),
                    }
                ),
                flush=True,
            )
    elif args.mode == "seal-owner":
        credentials = json.loads(
            (args.evidence / "destination-identities.json").read_text()
        )
        for uid, (access, secret) in credentials.items():
            namespace = "keycloak" if uid.startswith("keycloak") else "ofz"
            if uid == "ofz-recovery-custodian":
                name, filename, keys = (
                    "ofz-recovery-owner",
                    "ofz/control-plane/recovery-owner-sealedsecret.yaml",
                    ("access-key", "secret-key"),
                )
            elif uid == "ofz-audit-export":
                name, filename, keys = (
                    "ofz-audit-archive",
                    "ofz/control-plane/audit-archive-sealedsecret.yaml",
                    ("access-key", "secret-key"),
                )
            else:
                name, filename, keys = (
                    uid,
                    f"{namespace}/database-backup-sealedsecret.yaml",
                    ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"),
                )
            value = {
                "apiVersion": "v1",
                "kind": "Secret",
                "metadata": {
                    "name": name,
                    "namespace": namespace,
                    "annotations": {"argocd.argoproj.io/sync-wave": "-9"},
                },
                "type": "Opaque",
                "data": {
                    keys[0]: base64.b64encode(access.encode()).decode(),
                    keys[1]: base64.b64encode(secret.encode()).decode(),
                },
            }
            sealed = command(
                [
                    "kubeseal",
                    "--context",
                    CONTEXT,
                    "--controller-name",
                    "sealed-secrets",
                    "--controller-namespace",
                    "sealed-secrets",
                    "--format",
                    "json",
                ],
                json.dumps(value).encode(),
            )
            document = json.loads(sealed)
            document["metadata"]["annotations"] = {"argocd.argoproj.io/sync-wave": "-9"}
            rendered = command(["yq", "-P", "."], json.dumps(document).encode())
            Path(f"argocd/applications/{filename}").write_bytes(rendered)
    else:
        credentials = json.loads(
            (args.evidence / "destination-identities.json").read_text()
        )
        destination = client(args.destination, credentials["ofz-recovery-custodian"])
        if args.mode == "rebind-audit":
            rebind_audit(destination, args.evidence)
            return
        for bucket in BUCKETS:
            migrate_bucket(
                source, destination, bucket, args.evidence, args.mode == "verify"
            )


if __name__ == "__main__":
    main()
