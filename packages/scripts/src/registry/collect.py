#!/usr/bin/env python3
"""Quarantine a prepared batch with a four-minute freeze ceiling and restore writes."""

import argparse
import hashlib
import json
from pathlib import Path
import signal
import subprocess
import time
import uuid

PYTHON_IMAGE = "python:3.14-alpine@sha256:f6a589d43c42b9e7f7dc67a12d37132491f362859a5d750607710cc56da3bc72"
HOLD = "argocd.argoproj.io/skip-reconcile"
OWNER = "storage.proompteng.ai/ceph-remount-owner"
READONLY = "REGISTRY_STORAGE_MAINTENANCE_READONLY"


class Collection:
    def __init__(self, context, seconds=240, max_blobs=2000):
        self.kubectl = ["kubectl", "--context", context]
        self.seconds = seconds
        self.max_blobs = max_blobs
        self.name = "registry-collect-" + uuid.uuid4().hex[:12]
        self.owner = self.name

    def command(self, args, timeout=60):
        result = subprocess.run(
            self.kubectl + args, text=True, capture_output=True, timeout=timeout
        )
        if result.returncode:
            raise RuntimeError(f"kubectl {args[:5]} failed: {result.stderr[-2000:]}")
        return result.stdout

    def get(self, namespace, kind, name):
        return json.loads(
            self.command(["-n", namespace, "get", kind, name, "-o", "json"])
        )

    def patch(self, namespace, kind, name, patch, strategy="json"):
        return self.command(
            [
                "-n",
                namespace,
                "patch",
                kind,
                name,
                "--type=" + strategy,
                "-p",
                json.dumps(patch),
            ]
        )

    def rollout(self, deadline):
        while time.monotonic() < deadline:
            deployment = self.get("registry", "deployment", "registry")
            status = deployment.get("status", {})
            if status.get("observedGeneration", 0) >= deployment["metadata"][
                "generation"
            ] and all(
                status.get(name) == 1
                for name in [
                    "replicas",
                    "updatedReplicas",
                    "readyReplicas",
                    "availableReplicas",
                ]
            ):
                return
            time.sleep(2)
        raise TimeoutError("Registry rollout exceeded its deadline")

    def restore(self, app_uid, deployment_uid, pvc_uid, pv, node, held, frozen):
        # Never restore uploads while a remote collector may still be alive.
        self.command(
            [
                "-n",
                "registry",
                "delete",
                "pod",
                self.name,
                "--ignore-not-found",
                "--wait=true",
                "--timeout=60s",
            ],
            timeout=70,
        )
        deployment = self.get("registry", "deployment", "registry")
        if deployment["metadata"]["uid"] != deployment_uid:
            raise RuntimeError(
                "Registry Deployment identity changed; retain the maintenance hold"
            )
        if frozen:
            spec = deployment["spec"]["template"]["spec"]
            env = next(c for c in spec["containers"] if c["name"] == "registry").get(
                "env", []
            )
            override = [value for value in env if value["name"] == READONLY]
            if override and override != [
                {"name": READONLY, "value": '{"enabled":true}'}
            ]:
                raise RuntimeError(
                    "Read-only override changed ownership; retain the maintenance hold"
                )
            if spec.get("nodeName") not in [None, node]:
                raise RuntimeError(
                    "Registry node pin changed ownership; retain the maintenance hold"
                )
            self.patch(
                "registry",
                "deployment",
                "registry",
                {
                    "spec": {
                        "template": {
                            "spec": {
                                "nodeName": None,
                                "containers": [
                                    {
                                        "name": "registry",
                                        "env": [{"name": READONLY, "$patch": "delete"}],
                                    }
                                ],
                            }
                        }
                    }
                },
                "strategic",
            )
            self.rollout(time.monotonic() + 300)
        pvc = self.get("registry", "pvc", "registry-data")
        if pvc["metadata"]["uid"] != pvc_uid or pvc["spec"]["volumeName"] != pv:
            raise RuntimeError(
                "Registry claim identity changed; retain the maintenance hold"
            )
        if held:
            app = self.get("argocd", "application", "registry")
            annotations = app["metadata"].get("annotations", {})
            if annotations.get(OWNER) == self.owner:
                self.patch(
                    "argocd",
                    "application",
                    "registry",
                    [
                        {"op": "test", "path": "/metadata/uid", "value": app_uid},
                        {
                            "op": "test",
                            "path": "/metadata/annotations/storage.proompteng.ai~1ceph-remount-owner",
                            "value": self.owner,
                        },
                        {
                            "op": "remove",
                            "path": "/metadata/annotations/argocd.argoproj.io~1skip-reconcile",
                        },
                        {
                            "op": "remove",
                            "path": "/metadata/annotations/storage.proompteng.ai~1ceph-remount-owner",
                        },
                    ],
                )
            elif HOLD in annotations or OWNER in annotations:
                raise RuntimeError("Argo hold ownership changed; leave it intact")

    def run(self, plan_path, references_path):
        app = self.get("argocd", "application", "registry")
        deployment = self.get("registry", "deployment", "registry")
        pvc = self.get("registry", "pvc", "registry-data")
        prepared = json.loads(plan_path.read_text())
        if (
            prepared["pvcUid"] != pvc["metadata"]["uid"]
            or prepared["pv"] != pvc["spec"]["volumeName"]
        ):
            raise RuntimeError("Prepared plan belongs to another registry claim")
        annotations = app["metadata"].get("annotations", {})
        if app.get("operation") or HOLD in annotations or OWNER in annotations:
            raise RuntimeError("Another Argo operation or maintenance hold is active")
        if app["spec"]["source"]["path"] != "argocd/applications/registry":
            raise RuntimeError("Unexpected registry Application source")
        spec = deployment["spec"]["template"]["spec"]
        if "nodeName" in spec or any(
            e["name"].startswith(READONLY)
            for c in spec["containers"]
            for e in c.get("env", [])
        ):
            raise RuntimeError("Registry has unfinished maintenance overrides")
        if pvc["status"]["phase"] != "Bound":
            raise RuntimeError("Registry claim is not Bound")
        pods = json.loads(
            self.command(
                ["-n", "registry", "get", "pods", "-l", "app=registry", "-o", "json"]
            )
        )["items"]
        if len(pods) != 1 or not all(
            c["ready"] for c in pods[0]["status"]["containerStatuses"]
        ):
            raise RuntimeError("Require exactly one ready registry Pod")
        node = pods[0]["spec"]["nodeName"]
        helper = {
            "apiVersion": "v1",
            "kind": "Pod",
            "metadata": {"name": self.name, "namespace": "registry"},
            "spec": {
                "nodeName": node,
                "restartPolicy": "Never",
                "terminationGracePeriodSeconds": 1,
                "automountServiceAccountToken": False,
                "activeDeadlineSeconds": self.seconds + 180,
                "securityContext": {"seccompProfile": {"type": "RuntimeDefault"}},
                "containers": [
                    {
                        "name": "collector",
                        "image": PYTHON_IMAGE,
                        "command": ["sleep", str(self.seconds + 180)],
                        "resources": {
                            "requests": {"cpu": "50m", "memory": "64Mi"},
                            "limits": {"cpu": "2", "memory": "2Gi"},
                        },
                        "securityContext": {
                            "allowPrivilegeEscalation": False,
                            "readOnlyRootFilesystem": True,
                            "capabilities": {"drop": ["ALL"]},
                        },
                        "volumeMounts": [
                            {"name": "data", "mountPath": "/var/lib/registry"}
                        ],
                    }
                ],
                "volumes": [
                    {
                        "name": "data",
                        "persistentVolumeClaim": {"claimName": "registry-data"},
                    }
                ],
            },
        }
        held, frozen = False, False
        timeout_error = None
        collection_result = None
        helper_path = plan_path.with_suffix(".pod.json")
        helper_path.write_text(json.dumps(helper))
        try:
            self.command(["-n", "registry", "create", "-f", str(helper_path)])
            self.command(
                [
                    "-n",
                    "registry",
                    "wait",
                    "--for=condition=Ready",
                    "pod/" + self.name,
                    "--timeout=60s",
                ],
                timeout=70,
            )
            for source, destination in [
                (Path(__file__).with_name("cleanup.py"), "cleanup.py"),
                (plan_path, "plan.json"),
                (references_path, "references.json"),
            ]:
                self.command(
                    [
                        "-n",
                        "registry",
                        "cp",
                        str(source),
                        self.name + ":/dev/shm/" + destination,
                        "-c",
                        "collector",
                    ]
                )
                expected = hashlib.sha256(source.read_bytes()).hexdigest()
                actual = self.command(
                    [
                        "-n",
                        "registry",
                        "exec",
                        self.name,
                        "-c",
                        "collector",
                        "--",
                        "python3",
                        "-c",
                        "import hashlib,pathlib;print(hashlib.sha256(pathlib.Path('/dev/shm/"
                        + destination
                        + "').read_bytes()).hexdigest())",
                    ]
                ).strip()
                if actual != expected:
                    raise RuntimeError(
                        "Helper input transfer is incomplete: " + destination
                    )
            fresh_app = self.get("argocd", "application", "registry")
            if (
                fresh_app["metadata"]["uid"] != app["metadata"]["uid"]
                or fresh_app.get("operation")
                or any(
                    key in fresh_app["metadata"].get("annotations", {})
                    for key in [HOLD, OWNER]
                )
            ):
                raise RuntimeError(
                    "Registry Application changed before acquiring the hold"
                )
            app = fresh_app
            held = True
            self.patch(
                "argocd",
                "application",
                "registry",
                [
                    {
                        "op": "test",
                        "path": "/metadata/uid",
                        "value": app["metadata"]["uid"],
                    },
                    {
                        "op": "test",
                        "path": "/metadata/resourceVersion",
                        "value": app["metadata"]["resourceVersion"],
                    },
                    {
                        "op": "add",
                        "path": "/metadata/annotations/argocd.argoproj.io~1skip-reconcile",
                        "value": "true",
                    },
                    {
                        "op": "add",
                        "path": "/metadata/annotations/storage.proompteng.ai~1ceph-remount-owner",
                        "value": self.owner,
                    },
                ],
            )
            deadline = time.monotonic() + self.seconds
            frozen = True
            self.patch(
                "registry",
                "deployment",
                "registry",
                {
                    "spec": {
                        "template": {
                            "spec": {
                                "nodeName": node,
                                "containers": [
                                    {
                                        "name": "registry",
                                        "env": [
                                            {
                                                "name": READONLY,
                                                "value": '{"enabled":true}',
                                            }
                                        ],
                                    }
                                ],
                            }
                        }
                    }
                },
                "strategic",
            )
            self.rollout(deadline)
            remaining = int(deadline - time.monotonic())
            if remaining < 20:
                raise TimeoutError(
                    "No collection budget remains after read-only rollout"
                )
            try:
                result = subprocess.run(
                    self.kubectl
                    + [
                        "-n",
                        "registry",
                        "exec",
                        self.name,
                        "-c",
                        "collector",
                        "--",
                        "python3",
                        "/dev/shm/cleanup.py",
                        "collect",
                        "--plan",
                        "/dev/shm/plan.json",
                        "--references",
                        "/dev/shm/references.json",
                        "--workers",
                        "32",
                        "--seconds",
                        str(remaining - 10),
                        "--max-blobs",
                        str(self.max_blobs),
                        "--quarantine-id",
                        self.name,
                    ],
                    text=True,
                    capture_output=True,
                    timeout=remaining,
                )
            except subprocess.TimeoutExpired as error:
                timeout_error = error
                diagnostics = error.stderr or ""
                if isinstance(diagnostics, bytes):
                    diagnostics = diagnostics.decode(errors="replace")
                plan_path.with_suffix(".collection.log").write_text(
                    str(error) + "\n" + diagnostics
                )
            else:
                plan_path.with_suffix(".collection.log").write_text(result.stderr)
                if result.returncode:
                    raise RuntimeError("Collection failed: " + result.stderr[-2000:])
                collection_result = json.loads(result.stdout)
        finally:
            try:
                self.restore(
                    app["metadata"]["uid"],
                    deployment["metadata"]["uid"],
                    pvc["metadata"]["uid"],
                    pvc["spec"]["volumeName"],
                    node,
                    held,
                    frozen,
                )
            except Exception as error:
                if timeout_error is not None:
                    raise error from timeout_error
                raise
        if timeout_error is not None:
            from prepare import CONTAINER, maintenance_pod

            pod = maintenance_pod(self)["metadata"]["name"]
            receipt = json.loads(
                self.command(
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
                        "import json,pathlib; p=pathlib.Path("
                        + repr("/quarantine/" + self.name + "/receipt.json")
                        + "); print(json.dumps(json.loads(p.read_text()) if p.is_file() else None))",
                    ]
                )
            )
            if receipt is None:
                raise timeout_error
            if (
                not isinstance(receipt, dict)
                or receipt.get("version") != 2
                or not isinstance(receipt.get("blobs"), list)
                or not isinstance(receipt.get("tags"), list)
            ):
                raise ValueError(
                    "Invalid quarantine receipt; refuse partial collection"
                ) from timeout_error
            return {"quarantineId": self.name, "collectionTimedOut": True}
        return collection_result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--context", required=True)
    parser.add_argument("--plan", required=True, type=Path)
    parser.add_argument("--references", required=True, type=Path)
    parser.add_argument("--seconds", type=int, default=240)
    parser.add_argument("--max-blobs", type=int, default=2000)
    args = parser.parse_args()
    if not 30 <= args.seconds <= 240 or args.max_blobs < 1:
        parser.error("Collection requires 30..240 seconds and max-blobs>=1")
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
    result = Collection(args.context, args.seconds, args.max_blobs).run(
        args.plan, args.references
    )
    args.plan.with_suffix(".collection.json").write_text(json.dumps(result, indent=2))
    print(json.dumps(result))


if __name__ == "__main__":
    main()
