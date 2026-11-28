"""Expire only completed Paperless CNPG snapshots, retaining two known-good backups."""

import datetime as dt
import json
import os
import ssl
import urllib.request
from pathlib import Path

CLUSTER = "paperless-db"
SCHEDULE = "paperless-db-daily"
RETENTION_DAYS = 30
SERVICE_ACCOUNT = Path("/var/run/secrets/kubernetes.io/serviceaccount")


def eligible(backups: list[dict], now: dt.datetime) -> list[dict]:
    completed = [
        entry
        for entry in backups
        if entry.get("metadata", {}).get("labels", {}).get("cnpg.io/cluster") == CLUSTER
        and entry["metadata"]["labels"].get("cnpg.io/scheduled-backup") == SCHEDULE
        and entry.get("status", {}).get("phase") == "completed"
    ]
    completed.sort(key=lambda item: item["metadata"]["creationTimestamp"], reverse=True)
    cutoff = now - dt.timedelta(days=RETENTION_DAYS)
    return [
        entry
        for entry in completed[2:]
        if dt.datetime.fromisoformat(entry["metadata"]["creationTimestamp"]) < cutoff
    ]


def main() -> None:
    namespace = (SERVICE_ACCOUNT / "namespace").read_text().strip()
    if namespace != "paperless":
        raise RuntimeError("Backup cleanup must run only in the paperless namespace")
    host = os.environ["KUBERNETES_SERVICE_HOST"]
    port = os.environ.get("KUBERNETES_SERVICE_PORT_HTTPS", "443")
    url = f"https://{host}:{port}/apis/postgresql.cnpg.io/v1/namespaces/{namespace}/backups"
    headers = {
        "Authorization": f"Bearer {(SERVICE_ACCOUNT / 'token').read_text().strip()}",
        "Accept": "application/json",
    }
    context = ssl.create_default_context(cafile=str(SERVICE_ACCOUNT / "ca.crt"))
    request = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(request, context=context, timeout=20) as response:
        entries = json.load(response)["items"]

    deletions = eligible(entries, dt.datetime.now(dt.UTC))
    for entry in deletions:
        metadata = entry["metadata"]
        request = urllib.request.Request(
            f"{url}/{metadata['name']}",
            data=json.dumps(
                {
                    "apiVersion": "v1",
                    "kind": "DeleteOptions",
                    "preconditions": {"uid": metadata["uid"]},
                }
            ).encode(),
            headers={**headers, "Content-Type": "application/json"},
            method="DELETE",
        )
        with urllib.request.urlopen(request, context=context, timeout=20):
            print(f"Removed expired Paperless snapshot Backup/{metadata['name']}")
    print(
        f"Inspected {len(entries)} backups; cleaned up {len(deletions)} completed snapshots"
    )


if __name__ == "__main__":
    main()
