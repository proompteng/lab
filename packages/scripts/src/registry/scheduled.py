#!/usr/bin/env python3
"""Run daily registry retention through the existing prepare/collect/purge protocol."""

import json
import os
from pathlib import Path
import signal

from collect import Collection, HOLD, OWNER, READONLY
import prepare
from protected_references import references
import purge


def emit(phase, **fields):
    print(json.dumps({"phase": phase, **fields}), flush=True)


def run(context, directory):
    client = Collection(context)
    app = client.get("argocd", "application", "registry")
    deployment = client.get("registry", "deployment", "registry")
    annotations = app["metadata"].get("annotations", {})
    if app.get("operation") or any(key in annotations for key in [HOLD, OWNER]):
        raise RuntimeError("Another Argo operation or maintenance owner is active")
    spec = deployment["spec"]["template"]["spec"]
    if "nodeName" in spec or any(
        entry["name"].startswith(READONLY)
        for container in spec["containers"]
        for entry in container.get("env", [])
    ):
        raise RuntimeError("Resolve unfinished registry maintenance before retrying")
    pod = prepare.maintenance_pod(client)["metadata"]["name"]
    batches = json.loads(
        client.command(
            [
                "-n",
                "registry",
                "exec",
                pod,
                "-c",
                prepare.CONTAINER,
                "--",
                "python3",
                "-c",
                "import json,pathlib;print(json.dumps(sorted(p.name for p in "
                "pathlib.Path('/quarantine').iterdir() if p.is_dir() and "
                "p.name.startswith('registry-collect-') and (p/'receipt.json').is_file())))",
            ]
        )
    )
    for batch in batches:
        emit("resume-purge", batch=batch)
        emit(
            "purged",
            batch=batch,
            **purge.run(context, batch, directory / (batch + ".log")),
        )

    plan_path = directory / "plan.json"
    reference_path = directory / "references.json"
    emit("prepare")
    emit("prepared", **prepare.run(context, plan_path, reference_path))
    plan = json.loads(plan_path.read_text())
    if not plan["blobs"] and not plan["deleteTags"]:
        emit(
            "complete",
            collectionTimedOut=False,
            deletedTags=0,
            deletedBlobs=0,
            deletedBytes=0,
        )
        return
    reference_path.write_text(json.dumps(references(context)))
    operation = Collection(context, seconds=240, max_blobs=2000)
    emit("collect", batch=operation.name)
    result = operation.run(plan_path, reference_path)
    emit("collected", **result)
    emit(
        "complete",
        collectionTimedOut=result["collectionTimedOut"],
        **purge.run(context, result["quarantineId"], directory / "purge.log"),
    )


def main():
    directory = Path("/work")
    directory.mkdir(parents=True, exist_ok=True)
    credentials = "/var/run/secrets/kubernetes.io/serviceaccount/"
    config = {
        "apiVersion": "v1",
        "kind": "Config",
        "clusters": [
            {
                "name": "in-cluster",
                "cluster": {
                    "server": "https://kubernetes.default.svc",
                    "certificate-authority": credentials + "ca.crt",
                },
            }
        ],
        "users": [
            {"name": "registry-cleanup", "user": {"tokenFile": credentials + "token"}}
        ],
        "contexts": [
            {
                "name": "in-cluster",
                "context": {
                    "cluster": "in-cluster",
                    "user": "registry-cleanup",
                    "namespace": "registry",
                },
            }
        ],
        "current-context": "in-cluster",
    }
    kubeconfig = directory / "kubeconfig"
    kubeconfig.write_text(json.dumps(config))
    kubeconfig.chmod(0o600)
    os.environ["KUBECONFIG"] = str(kubeconfig)
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
    run("in-cluster", directory)


if __name__ == "__main__":
    main()
