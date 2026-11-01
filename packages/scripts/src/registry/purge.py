#!/usr/bin/env python3
"""Purge online through the existing registry Pod's writable quarantine-only mount."""

import argparse
import json
from pathlib import Path
import re
import subprocess
import uuid

from collect import Collection
from prepare import CONTAINER, copy_verified, maintenance_pod


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
    pod = maintenance_pod(client)
    name = pod["metadata"]["name"]
    script = "/dev/shm/registry-purge-" + uuid.uuid4().hex[:12] + ".py"
    try:
        copy_verified(client, name, Path(__file__).with_name("cleanup.py"), script)
        # A kernel lock prevents overlapping purges; process exit releases it, including after Pod replacement.
        code = (
            "import fcntl,os,runpy,signal;signal.alarm(3600);"
            "lock=os.open('/dev/shm/registry-purge.lock',os.O_CREAT|os.O_RDWR,0o600);"
            "fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB);runpy.run_path("
            + repr(script)
            + ",run_name='__main__')"
        )
        with output.open("w") as logs:
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
                    "--workers",
                    "8",
                ],
                stdout=subprocess.PIPE,
                stderr=logs,
                text=True,
                timeout=3660,
            )
            logs.write(process.stdout)
        if process.returncode:
            raise RuntimeError(
                "Purge failed; inspect " + str(output) + " and retry its receipt"
            )
        return json.loads(process.stdout)
    finally:
        client.command(
            ["-n", "registry", "exec", name, "-c", CONTAINER, "--", "rm", "-f", script]
        )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--context", required=True)
    parser.add_argument("--quarantine-id", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(run(args.context, args.quarantine_id, args.output)))
