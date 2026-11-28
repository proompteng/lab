"""Run the registry Pod's cleanup worker with fresh Kubernetes image protections."""

import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import time
import uuid

from maintenance import code_hashes
from protected_references import references


def read(context, kind, name):
    return json.loads(
        subprocess.check_output(
            [
                "kubectl",
                "--context",
                context,
                "--request-timeout=20s",
                "-n",
                "registry",
                "get",
                kind,
                name,
                "-o",
                "json",
            ],
            timeout=25,
        )
    )


def claim(context):
    pvc = read(context, "pvc", "registry-data")
    if pvc["status"]["phase"] != "Bound":
        raise RuntimeError("Registry data claim is not Bound")
    return {"pvcUid": pvc["metadata"]["uid"], "pv": pvc["spec"]["volumeName"]}


def ready_pod(context):
    expected = None
    if name := os.environ.get("POD_NAME"):
        own_pod = read(context, "pod", name)
        expected = next(
            volume["configMap"]["name"]
            for volume in own_pod["spec"]["volumes"]
            if volume["name"] == "scripts"
        )
    deadline = time.monotonic() + 300
    print(json.dumps({"event": "waiting-for-registry", "seconds": 300}), flush=True)
    while time.monotonic() < deadline:
        pods = json.loads(
            subprocess.check_output(
                [
                    "kubectl",
                    "--context",
                    context,
                    "--request-timeout=20s",
                    "-n",
                    "registry",
                    "get",
                    "pods",
                    "-l",
                    "app=registry",
                    "-o",
                    "json",
                ],
                timeout=25,
            )
        )["items"]
        if len(pods) == 1:
            pod = pods[0]
            statuses = pod.get("status", {}).get("containerStatuses", [])
            cohort = next(
                (
                    volume.get("configMap", {}).get("name")
                    for volume in pod["spec"]["volumes"]
                    if volume["name"] == "cleanup-scripts"
                ),
                None,
            )
            if (
                not pod["metadata"].get("deletionTimestamp")
                and len(statuses) == len(pod["spec"]["containers"])
                and all(container.get("ready") for container in statuses)
                and (expected is None or expected == cohort)
            ):
                return pod
        time.sleep(1)
    raise TimeoutError(
        "Registry did not reach one ready Pod with the cleanup script revision within five minutes"
    )


def run(context):
    pod = ready_pod(context)
    name, uid = pod["metadata"]["name"], pod["metadata"]["uid"]
    storage = claim(context)
    run_id = uuid.uuid4().hex
    command = [
        "kubectl",
        "--context",
        context,
        "-n",
        "registry",
        "exec",
        "-i",
        name,
        "-c",
        "registry-maintenance",
        "--",
        "python3",
        "-u",
        "/scripts/maintenance.py",
    ]
    message = {
        "storage": storage,
        "references": references(context),
        "code": code_hashes(),
    }
    process = subprocess.Popen(
        command + ["run", run_id],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        text=True,
    )
    complete = False
    refreshed = False
    try:
        process.stdin.write(json.dumps(message) + "\n")
        process.stdin.flush()
        for line in process.stdout:
            event = json.loads(line)
            print(line, end="", flush=True)
            if event["event"] == "refresh-references":
                if refreshed or event["run"] != run_id:
                    raise RuntimeError("Unexpected cleanup protection refresh")
                if (
                    read(context, "pod", name)["metadata"]["uid"] != uid
                    or claim(context) != storage
                ):
                    raise RuntimeError(
                        "Registry Pod or claim changed during preparation"
                    )
                process.stdin.write(
                    json.dumps({"references": references(context)}) + "\n"
                )
                process.stdin.flush()
                refreshed = True
            elif event["event"] == "complete":
                complete = True
        status = process.wait()
        if status or not complete:
            raise RuntimeError(f"Registry cleanup worker failed with exit {status}")
        if claim(context) != storage:
            raise RuntimeError("Registry claim changed during cleanup")
    except BaseException:
        subprocess.run(
            command + ["stop", run_id], stdin=subprocess.DEVNULL, timeout=40, check=True
        )
        raise
    finally:
        process.stdin.close()
        process.stdout.close()
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()


def in_cluster(directory):
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
    path = Path(directory) / "kubeconfig"
    path.write_text(json.dumps(config))
    path.chmod(0o600)
    os.environ["KUBECONFIG"] = str(path)


def interrupted(*_):
    raise InterruptedError("Registry cleanup controller interrupted")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--context")
    args = parser.parse_args()
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    with tempfile.TemporaryDirectory() as directory:
        if args.context is None:
            in_cluster(directory)
        run(args.context or "in-cluster")
