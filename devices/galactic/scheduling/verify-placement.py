#!/usr/bin/env python3
"""Inventory Ryzen storage clients, verify placement, or probe isolated admission rules."""

import argparse
import copy
import json
from pathlib import Path
import subprocess
import time
import uuid

RYZEN = "talos-192-168-1-194"
KEY = "workload.proompteng.ai/compute-local"
TOLERATION = {"key": KEY, "operator": "Equal", "value": "true", "effect": "NoSchedule"}
ROOT = Path(__file__).resolve().parents[3]


def kubectl(context, namespace, args, document=None):
    result = subprocess.run(
        ["kubectl", "--context", context, "-n", namespace, *args],
        input=None if document is None else json.dumps(document),
        capture_output=True,
        text=True,
        check=False,
        timeout=45,
    )
    if result.returncode:
        raise RuntimeError(result.stderr.strip())
    return result.stdout


def query(context, resource):
    return json.loads(
        kubectl(context, "kube-system", ["get", resource, "-A", "-o", "json"])
    )["items"]


def tolerates(spec):
    return any(
        t.get("effect", "") in ("", "NoSchedule")
        and (
            t.get("operator", "Equal") == "Exists"
            and t.get("key", "") in ("", KEY)
            or t.get("key") == KEY
            and t.get("value") == "true"
        )
        for t in spec.get("tolerations", [])
    )


def claim_name(pod, volume):
    if "persistentVolumeClaim" in volume:
        return volume["persistentVolumeClaim"]["claimName"]
    if "ephemeral" in volume:
        return f"{pod['metadata']['name']}-{volume['name']}"
    return None


def inventory(context, verify):
    classes = {s["metadata"]["name"]: s for s in query(context, "storageclasses")}
    claims = {
        (c["metadata"]["namespace"], c["metadata"]["name"]): c
        for c in query(context, "pvc")
    }
    volumes = {v["metadata"]["name"]: v for v in query(context, "pv")}
    pods = query(context, "pods")
    clients = []
    unknown = []
    monitors = []
    runners = []
    for pod in pods:
        meta, spec = pod["metadata"], pod["spec"]
        if spec.get("nodeName") != RYZEN or pod["status"].get("phase") in (
            "Succeeded",
            "Failed",
        ):
            continue
        namespace = meta["namespace"]
        if (
            namespace == "rook-ceph"
            and meta.get("labels", {}).get("app") == "rook-ceph-mon"
        ):
            monitors.append(meta["name"])
        if (
            namespace == "arc"
            and meta.get("labels", {}).get("actions.github.com/scale-set-name")
            == "arc-amd64"
            and meta.get("labels", {}).get("app.kubernetes.io/component") == "runner"
        ):
            runners.append(pod)
        for volume in spec.get("volumes", []):
            if namespace != "rook-ceph" and (
                volume.get("csi", {}).get("driver", "").endswith(".csi.ceph.com")
                or "cephfs" in volume
                or "rbd" in volume
            ):
                clients.append(
                    f"{namespace}/{meta['name']}: inline Ceph volume {volume['name']}"
                )
            name = claim_name(pod, volume)
            if not name:
                continue
            claim = claims.get((namespace, name))
            if claim is None:
                unknown.append(f"{namespace}/{meta['name']}: missing PVC {name}")
                continue
            storage = claim["spec"].get("storageClassName", "")
            pv = volumes.get(claim["spec"].get("volumeName"), {})
            driver = (
                pv.get("spec", {})
                .get("csi", {})
                .get("driver", classes.get(storage, {}).get("provisioner", ""))
            )
            if driver.endswith(".csi.ceph.com") and namespace != "rook-ceph":
                clients.append(f"{namespace}/{meta['name']}: {name} ({storage})")
    print(
        json.dumps(
            {
                "ryzen_ceph_clients": clients,
                "unknown_claims": unknown,
                "ryzen_monitors": monitors,
                "ryzen_amd64_runners": [p["metadata"]["name"] for p in runners],
            },
            indent=2,
        )
    )
    if not verify:
        return
    assert not clients, "applications still mount Ceph volumes on Ryzen"
    assert not unknown, "unresolved PVCs prevent placement acceptance"
    for node in query(context, "nodes"):
        name = node["metadata"]["name"]
        expected = "false" if name == RYZEN else "true"
        assert (
            node["metadata"]["labels"].get("network.proompteng.ai/100g") == expected
        ), f"{name}: 100G label differs"
        if name == RYZEN:
            assert {"key": KEY, "value": "true", "effect": "NoSchedule"} in node[
                "spec"
            ].get("taints", []), "Ryzen taint missing"
    assert len(monitors) == 1, "Ryzen must retain one Ceph monitor"
    quorum = json.loads(
        kubectl(
            context,
            "rook-ceph",
            [
                "exec",
                "deployment/rook-ceph-tools",
                "--",
                "ceph",
                "quorum_status",
                "-f",
                "json",
            ],
        )
    )
    assert len(quorum["quorum_names"]) == 3, "Ceph monitor quorum is incomplete"
    assert runners, "no AMD64 ARC runner on Ryzen"
    assert any(
        any(
            c["type"] == "Ready" and c["status"] == "True"
            for c in p["status"].get("conditions", [])
        )
        for p in runners
    ), "no ready AMD64 ARC runner"
    for pod in runners:
        mounted = [
            claims[("arc", claim_name(pod, v))]["spec"].get("storageClassName")
            for v in pod["spec"].get("volumes", [])
            if claim_name(pod, v)
        ]
        assert mounted == ["local-path-ci-amd64"], (
            "AMD64 runner scratch does not use the per-host CI local class"
        )
    print(
        "PASS: Ryzen has local CI scratch, no application Ceph clients, and its Ceph monitor remains in quorum"
    )


def probe_admission(context):
    """Create only UUID-scoped policy objects; every test Pod uses server dry-run."""
    import yaml

    token = uuid.uuid4().hex[:12]
    name = f"compute-local-probe-{token}"
    label = "test.proompteng.ai/placement"
    source = ROOT / "argocd/applications/local-path/compute-local-admission.yaml"
    policy, binding = list(yaml.safe_load_all(source.read_text()))
    policy["metadata"]["name"] = binding["metadata"]["name"] = name
    policy["spec"]["matchConstraints"]["objectSelector"] = {
        "matchLabels": {label: token}
    }
    binding["spec"]["policyName"] = name
    binding["spec"]["matchResources"] = {
        "namespaceSelector": {
            "matchLabels": {"kubernetes.io/metadata.name": "local-path-storage"}
        }
    }
    resources = {"apiVersion": "v1", "kind": "List", "items": [policy, binding]}
    base = {
        "apiVersion": "v1",
        "kind": "Pod",
        "metadata": {
            "name": name,
            "namespace": "local-path-storage",
            "labels": {label: token},
        },
        "spec": {
            "containers": [{"name": "probe", "image": "registry.k8s.io/pause:3.10"}],
            "nodeSelector": {"kubernetes.io/arch": "amd64"},
        },
    }
    cases = [
        ("cpu", [], True, []),
        ("emptydir", [{"name": "scratch", "emptyDir": {}}], True, []),
        (
            "ceph-pvc",
            [{"name": "data", "persistentVolumeClaim": {"claimName": "ceph-test"}}],
            False,
            [],
        ),
        (
            "missing-pvc",
            [
                {
                    "name": "data",
                    "persistentVolumeClaim": {"claimName": "not-created-yet"},
                }
            ],
            False,
            [],
        ),
        (
            "local-named-pvc",
            [{"name": "data", "persistentVolumeClaim": {"claimName": "local-test"}}],
            False,
            [],
        ),
        (
            "local-explicit",
            [{"name": "data", "persistentVolumeClaim": {"claimName": "local-test"}}],
            True,
            [TOLERATION],
        ),
        (
            "rook-monitor",
            [{"name": "mon-data", "hostPath": {"path": "/var/lib/rook"}}],
            True,
            [TOLERATION],
        ),
        (
            "spiffe",
            [{"name": "identity", "csi": {"driver": "csi.spiffe.io"}}],
            True,
            [],
        ),
        (
            "ceph-csi",
            [{"name": "data", "csi": {"driver": "rook-ceph.rbd.csi.ceph.com"}}],
            False,
            [],
        ),
        (
            "preserve-toleration",
            [],
            True,
            [{"key": "other", "operator": "Exists", "effect": "NoSchedule"}],
        ),
        ("idempotent", [], True, [TOLERATION]),
        ("blanket", [], True, [{"operator": "Exists"}]),
        (
            "wrong-value",
            [],
            True,
            [
                {
                    "key": KEY,
                    "operator": "Equal",
                    "value": "false",
                    "effect": "NoSchedule",
                }
            ],
        ),
        (
            "empty-value",
            [],
            True,
            [{"key": KEY, "operator": "Equal", "effect": "NoSchedule"}],
        ),
        (
            "cephfs-inline",
            [
                {
                    "name": "data",
                    "cephfs": {"monitors": ["10.0.0.1:6789"], "path": "/test"},
                }
            ],
            False,
            [],
        ),
        (
            "rbd-inline",
            [{"name": "data", "rbd": {"monitors": ["10.0.0.1:6789"], "image": "test"}}],
            False,
            [],
        ),
        (
            "mixed-storage",
            [
                {"name": "scratch", "emptyDir": {}},
                {"name": "data", "persistentVolumeClaim": {"claimName": "ceph-test"}},
            ],
            False,
            [],
        ),
    ]
    for storage in (
        "local-path",
        "local-path-ryzen",
        "local-path-ci-amd64",
        "local-path-turin-nvme-intel",
        "local-path-turin-nvme-transcend",
        "rook-ceph-block",
        "rook-cephfs",
        "temporal-elasticsearch-snapshot-wsync",
        None,
    ):
        template = {
            "accessModes": ["ReadWriteOnce"],
            "resources": {"requests": {"storage": "1Gi"}},
        }
        if storage is not None:
            template["storageClassName"] = storage
        cases.append(
            (
                f"ephemeral-{storage}",
                [
                    {
                        "name": "data",
                        "ephemeral": {"volumeClaimTemplate": {"spec": template}},
                    }
                ],
                storage is not None and storage.startswith("local-path"),
                [],
            )
        )
    try:
        kubectl(context, "local-path-storage", ["create", "-f", "-"], resources)
        deadline = time.monotonic() + 30
        for case, volumes, expected, existing in cases:
            pod = copy.deepcopy(base)
            pod["spec"]["volumes"] = volumes
            pod["spec"]["tolerations"] = existing
            pod["spec"]["affinity"] = {
                "nodeAffinity": {
                    "requiredDuringSchedulingIgnoredDuringExecution": {
                        "nodeSelectorTerms": [
                            {
                                "matchExpressions": [
                                    {
                                        "key": "kubernetes.io/hostname",
                                        "operator": "In",
                                        "values": [RYZEN],
                                    }
                                ]
                            },
                            {
                                "matchExpressions": [
                                    {
                                        "key": "kubernetes.io/arch",
                                        "operator": "In",
                                        "values": ["amd64"],
                                    }
                                ]
                            },
                        ]
                    }
                }
            }
            while True:
                result = json.loads(
                    kubectl(
                        context,
                        "local-path-storage",
                        ["create", "--dry-run=server", "-f", "-", "-o", "json"],
                        pod,
                    )
                )
                if (
                    case != "cpu"
                    or tolerates(result["spec"])
                    or time.monotonic() >= deadline
                ):
                    break
                time.sleep(0.5)
            assert tolerates(result["spec"]) == expected, (
                f"{case}: unexpected compute eligibility"
            )
            assert result["spec"]["affinity"] == pod["spec"]["affinity"], (
                f"{case}: existing affinity changed"
            )
            assert result["spec"]["nodeSelector"] == pod["spec"]["nodeSelector"], (
                f"{case}: architecture changed"
            )
            for item in existing:
                assert any(
                    all(t.get(k) == v for k, v in item.items())
                    for t in result["spec"]["tolerations"]
                ), f"{case}: toleration lost"
            assert (
                sum(
                    t.get("key") == KEY
                    and t.get("value") == "true"
                    and t.get("effect") == "NoSchedule"
                    for t in result["spec"].get("tolerations", [])
                )
                <= 1
            ), f"{case}: duplicate toleration"
            print(f"PASS: {case}")
    finally:
        kubectl(
            context,
            "local-path-storage",
            ["delete", "--ignore-not-found=true", "-f", "-"],
            resources,
        )
    print(
        f"PASS: {len(cases)} native admission cases; temporary policy and binding removed; no Pods persisted"
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--context", default="galactic-lan")
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument(
        "--verify",
        action="store_true",
        help="require completed placement and Ceph quorum",
    )
    modes.add_argument(
        "--probe-admission",
        action="store_true",
        help="temporarily install a UUID-scoped policy, dry-run Pods, and remove it",
    )
    args = parser.parse_args()
    if args.probe_admission:
        probe_admission(args.context)
    else:
        inventory(args.context, args.verify)


if __name__ == "__main__":
    main()
