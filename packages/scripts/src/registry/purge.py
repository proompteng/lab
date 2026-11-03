"""Purge online through the existing registry Pod's writable quarantine-only mount."""

import argparse
import json
import re
import subprocess
import sys
import uuid
from pathlib import Path

from collect import Collection
from prepare import CONTAINER, copy_verified, maintenance_pod


def diagnostic_tail(path):
    # Read a bounded suffix, not the whole per-blob event log. Remote cleanup only
    # emits filesystem diagnostics; never include kubeconfig or cluster objects.
    with path.open("rb") as source:
        source.seek(0, 2)
        source.seek(max(0, source.tell() - 8192))
        return source.read(8192).decode(errors="replace")


def run(context, batch, output):
    if not re.fullmatch(r"[a-z0-9-]{1,80}", batch):
        raise ValueError("Invalid quarantine identifier")
    client = Collection(context)
    deployment = client.get("registry", "deployment", "registry")
    if any(
        e["name"].startswith("REGISTRY_STORAGE_MAINTENANCE_READONLY")
        for c in deployment["spec"]["template"]["spec"]["containers"]
        for e in c.get("env", [])
    ):
        raise RuntimeError("Restore uploads before starting physical deletion")
    pvc = client.get("registry", "pvc", "registry-data")
    if pvc["status"]["phase"] != "Bound":
        raise RuntimeError("Require a Bound registry claim")
    pod = maintenance_pod(client)
    if any(
        e["name"].startswith("REGISTRY_STORAGE_MAINTENANCE_READONLY")
        for c in pod["spec"]["containers"]
        for e in c.get("env", [])
    ):
        raise RuntimeError("Restore uploads before starting physical deletion")
    name = pod["metadata"]["name"]
    script = "/dev/shm/registry-purge-" + uuid.uuid4().hex[:12] + ".py"
    try:
        copy_verified(client, name, Path(__file__).with_name("cleanup.py"), script)
        current_pvc = client.get("registry", "pvc", "registry-data")
        if (
            current_pvc["status"]["phase"] != "Bound"
            or current_pvc["metadata"]["uid"] != pvc["metadata"]["uid"]
            or current_pvc["spec"]["volumeName"] != pvc["spec"]["volumeName"]
        ):
            raise RuntimeError("Registry claim changed before purge")
        # A kernel lock prevents overlapping purges; process exit releases it, including after Pod replacement.
        code = (
            "import fcntl,os,runpy,signal;signal.alarm(3600);"
            "lock=os.open('/dev/shm/registry-purge.lock',os.O_CREAT|os.O_RDWR,0o600);"
            "fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB);runpy.run_path("
            + repr(script)
            + ",run_name='__main__')"
        )
        with output.open("w") as logs:
            try:
                process = subprocess.run(
                    client.kubectl
                    + [
                        "-n",
                        "registry",
                        "exec",
                        name,
                        "-c",
                        CONTAINER,
                        "--",
                        "python3",
                        "-c",
                        code,
                        "purge",
                        "--root",
                        "/quarantine",
                        "--quarantine-id",
                        batch,
                        "--pvc-uid",
                        pvc["metadata"]["uid"],
                        "--pv",
                        pvc["spec"]["volumeName"],
                        "--workers",
                        "8",
                    ],
                    check=False,
                    stdout=subprocess.PIPE,
                    stderr=logs,
                    text=True,
                    timeout=3660,
                )
            except subprocess.TimeoutExpired as error:
                logs.flush()
                raise RuntimeError(
                    f"Purge failed (timeout {error.timeout}s): {diagnostic_tail(output)}"
                ) from error
            logs.flush()
            if process.returncode:
                raise RuntimeError(
                    f"Purge failed (exit {process.returncode}): {diagnostic_tail(output)}"
                    f"\nFull purge log: {output}; retry its receipt"
                )
            logs.write(process.stdout)
        return json.loads(process.stdout)
    finally:
        # Pod replacement can make cleanup fail too; do not hide the purge diagnosis.
        failed = sys.exc_info()[0] is not None
        try:
            client.command(
                [
                    "-n",
                    "registry",
                    "exec",
                    name,
                    "-c",
                    CONTAINER,
                    "--",
                    "rm",
                    "-f",
                    script,
                ]
            )
        except Exception:
            if not failed:
                raise
            print(
                "Purge script cleanup failed; original purge error retained",
                file=sys.stderr,
            )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--context", required=True)
    parser.add_argument("--quarantine-id", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(run(args.context, args.quarantine_id, args.output)))
