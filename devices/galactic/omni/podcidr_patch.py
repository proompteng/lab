"""Render temporary Omni maintenance patches from a drained node's snapshots."""

import argparse
import base64
import json
from pathlib import Path

from podcidr_cleanup import require, validate_plan


MAINTENANCE_KEY = "maintenance.proompteng.ai/podcidr"
IMAGE = "python:3.12-alpine@sha256:b64631e04e4920160c50fbe8d8df828f7f35f06f425cb44aa09bca53e708a35a"
MACHINES = {
    "turin": "8bf7ec00-171c-11f1-8000-7cc255f16774",
    "talos-192-168-1-85": "12345678-9abc-deff-1234-56789abcdeff",
}


def make_plan(node, pods, operation):
    name = node["metadata"]["name"]
    require(node["spec"].get("unschedulable") is True, "target must be cordoned")
    require(
        int(node["status"]["capacity"]["pods"]) == 250, "target must advertise 250 pods"
    )
    require(
        any(
            condition["type"] == "Ready" and condition["status"] == "True"
            for condition in node["status"]["conditions"]
        ),
        "target must be Ready before entering standalone mode",
    )
    for taint in node["spec"].get("taints", []):
        require(
            taint["key"] in (MAINTENANCE_KEY, "node.kubernetes.io/unschedulable"),
            "unreviewed target taint",
        )
    daemons = []
    for pod in pods["items"]:
        require(
            pod["spec"].get("nodeName") == name, "pod snapshot includes another node"
        )
        if pod["status"].get("phase") in ("Succeeded", "Failed"):
            continue
        metadata = pod["metadata"]
        if metadata.get("annotations", {}).get("kubernetes.io/config.mirror"):
            require(
                pod["spec"].get("hostNetwork") is True, "non-host-network static pod"
            )
            continue
        require(
            any(
                owner["kind"] == "DaemonSet" and owner.get("controller")
                for owner in metadata.get("ownerReferences", [])
            ),
            f"target is not drained: {metadata['namespace']}/{metadata['name']}",
        )
        daemons.append({key: metadata[key] for key in ("name", "namespace", "uid")})
    require(
        any(
            p["namespace"] == "kube-system" and p["name"].startswith("kube-flannel-")
            for p in daemons
        ),
        "Flannel daemon missing from snapshot",
    )
    plan = {
        "operation": operation,
        "nodeName": name,
        "bootID": node["status"]["nodeInfo"]["bootID"],
        "oldCIDR": node["spec"]["podCIDR"],
        "daemonPodUIDs": sorted(p["uid"] for p in daemons),
    }
    validate_plan(plan)
    return plan, daemons


def make_patches(plan, source):
    code = base64.b64encode(source.encode()).decode()
    data = base64.b64encode(json.dumps(plan).encode()).decode()
    command = (
        "apk add --no-cache iproute2 cri-tools >/tmp/maintenance-packages.log 2>&1\n"
        f"printf '%s' '{code}' | base64 -d > /tmp/podcidr_cleanup.py\n"
        f"printf '%s' '{data}' | base64 -d > /tmp/cni-plan.json\n"
        "exec python3 /tmp/podcidr_cleanup.py --plan /tmp/cni-plan.json --hold\n"
    )
    taint = {"key": MAINTENANCE_KEY, "value": "true", "effect": "NoSchedule"}
    machine = {
        "nodeTaints": {MAINTENANCE_KEY: "true:NoSchedule"},
        "kubelet": {
            "skipNodeRegistration": True,
            "extraConfig": {
                "enableServer": False,
                "maxPods": 250,
                "registerWithTaints": [taint],
            },
        },
        "pods": [
            {
                "apiVersion": "v1",
                "kind": "Pod",
                "metadata": {
                    "name": "podcidr23-maintenance",
                    "namespace": "kube-system",
                },
                "spec": {
                    "hostNetwork": True,
                    "hostPID": True,
                    "dnsPolicy": "Default",
                    "containers": [
                        {
                            "name": "maintenance",
                            "image": IMAGE,
                            "command": ["/bin/sh", "-ec", command],
                            "securityContext": {"privileged": True, "runAsUser": 0},
                            "resources": {
                                "requests": {"cpu": "10m", "memory": "64Mi"},
                                "limits": {"memory": "256Mi"},
                            },
                        }
                    ],
                },
            }
        ],
    }
    standalone = {"machine": machine}
    register = json.loads(json.dumps(standalone))
    register["machine"]["kubelet"]["skipNodeRegistration"] = False
    register["machine"]["kubelet"]["extraConfig"]["enableServer"] = True
    return standalone, register


def omni_resource(node_name, patch):
    require(node_name in MACHINES, "Omni patch supports only Turin and Altra")
    return {
        "metadata": {
            "namespace": "default",
            "type": "ConfigPatches.omni.sidero.dev",
            "id": f"90-podcidr23-{node_name}",
            "labels": {
                "omni.sidero.dev/cluster": "galactic",
                "omni.sidero.dev/cluster-machine": MACHINES[node_name],
            },
        },
        "spec": {"data": json.dumps(patch)},
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--node-json", required=True, type=Path)
    parser.add_argument("--pods-json", required=True, type=Path)
    parser.add_argument("--operation", required=True)
    parser.add_argument("--output-dir", required=True, type=Path)
    args = parser.parse_args()
    plan, daemons = make_plan(
        json.loads(args.node_json.read_text()),
        json.loads(args.pods_json.read_text()),
        args.operation,
    )
    patches = make_patches(
        plan, Path(__file__).with_name("podcidr_cleanup.py").read_text()
    )
    resources = [omni_resource(plan["nodeName"], patch) for patch in patches]
    args.output_dir.mkdir(mode=0o700, parents=True, exist_ok=False)
    files = {
        "plan.json": plan,
        "daemon-pods.json": daemons,
        "standalone-patch.json": patches[0],
        "register-patch.json": patches[1],
        "standalone-omni.yaml": resources[0],
        "register-omni.yaml": resources[1],
    }
    for name, contents in files.items():
        path = args.output_dir / name
        path.write_text(json.dumps(contents, indent=2) + "\n")
        path.chmod(0o600)
    print(
        f"Rendered maintenance files for {plan['nodeName']} into {args.output_dir}; nothing applied"
    )


if __name__ == "__main__":
    main()
