#!/usr/bin/env python3
"""Prepare retention online through the registry Pod's read-only maintenance mount."""

import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import uuid

from collect import Collection
from protected_references import references

CONTAINER = "registry-maintenance"


def maintenance_pod(client):
    pods = json.loads(
        client.command(
            ["-n", "registry", "get", "pods", "-l", "app=registry", "-o", "json"]
        )
    )["items"]
    if (
        len(pods) != 1
        or pods[0]["metadata"].get("deletionTimestamp")
        or not all(c["ready"] for c in pods[0]["status"]["containerStatuses"])
    ):
        raise RuntimeError("Require exactly one ready registry Pod")
    container = next(
        (c for c in pods[0]["spec"]["containers"] if c["name"] == CONTAINER), None
    )
    volumes = {
        v["name"]
        for v in pods[0]["spec"]["volumes"]
        if v.get("persistentVolumeClaim", {}).get("claimName") == "registry-data"
    }
    if (
        container is None
        or not any(
            v["name"] in volumes
            and v["mountPath"] == "/var/lib/registry"
            and v.get("readOnly")
            for v in container["volumeMounts"]
        )
        or not any(
            v["mountPath"] == "/quarantine"
            and v["name"] in volumes
            and not v.get("readOnly")
            and v.get("subPath") == "docker/registry/v2/_gc_quarantine"
            for v in container["volumeMounts"]
        )
    ):
        raise RuntimeError(
            "Deploy the registry's read-only maintenance mount and quarantine subpath first"
        )
    return pods[0]


def copy_verified(client, pod, source, destination):
    client.command(
        ["-n", "registry", "cp", str(source), pod + ":" + destination, "-c", CONTAINER]
    )
    actual = client.command(
        [
            "-n",
            "registry",
            "exec",
            pod,
            "-c",
            CONTAINER,
            "--",
            "python3",
            "-c",
            "import hashlib,pathlib;print(hashlib.sha256(pathlib.Path("
            + repr(destination)
            + ").read_bytes()).hexdigest())",
        ]
    ).strip()
    if actual != hashlib.sha256(source.read_bytes()).hexdigest():
        raise RuntimeError("Incomplete maintenance input transfer")


def run(context, plan_path, reference_path):
    client = Collection(context)
    pvc = client.get("registry", "pvc", "registry-data")
    if pvc["status"]["phase"] != "Bound":
        raise RuntimeError("Require a Bound registry claim")
    pod = maintenance_pod(client)
    name = pod["metadata"]["name"]
    prefix = "/dev/shm/registry-prepare-" + uuid.uuid4().hex[:12]
    reference_path.write_text(json.dumps(references(context)))
    try:
        copy_verified(
            client, name, Path(__file__).with_name("cleanup.py"), prefix + ".py"
        )
        copy_verified(client, name, reference_path, prefix + ".json")
        with (
            plan_path.open("w") as output,
            plan_path.with_suffix(".prepare.log").open("w") as errors,
        ):
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
                    "import runpy,signal;signal.alarm(2700);runpy.run_path("
                    + repr(prefix + ".py")
                    + ",run_name='__main__')",
                    "prepare",
                    "--references",
                    prefix + ".json",
                    "--workers",
                    "32",
                ],
                stdout=output,
                stderr=errors,
                timeout=2760,
            )
        if process.returncode:
            log = plan_path.with_suffix(".prepare.log")
            raise RuntimeError(
                f"Preparation failed (exit {process.returncode}): {log.read_text()[-8192:]}"
                f"\nFull preparation log: {log}"
            )
        current_pvc = client.get("registry", "pvc", "registry-data")
        if (
            current_pvc["metadata"]["uid"] != pvc["metadata"]["uid"]
            or current_pvc["spec"]["volumeName"] != pvc["spec"]["volumeName"]
        ):
            raise RuntimeError("Registry claim changed during preparation")
        plan = json.loads(plan_path.read_text())
        plan["pvcUid"] = pvc["metadata"]["uid"]
        plan["pv"] = pvc["spec"]["volumeName"]
        plan_path.write_text(json.dumps(plan))
        return {
            "plan": str(plan_path),
            "references": str(reference_path),
            "candidates": len(plan["blobs"]),
            "candidateBytes": plan["candidateBytes"],
            "registryWrites": "unchanged",
        }
    finally:
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
                prefix + ".py",
                prefix + ".json",
            ]
        )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--context", required=True)
    parser.add_argument("--plan", type=Path, required=True)
    parser.add_argument("--references", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(run(args.context, args.plan, args.references)))
