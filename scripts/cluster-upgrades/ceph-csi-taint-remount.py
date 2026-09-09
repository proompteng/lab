#!/usr/bin/env python3
"""Ceph CSI remount with an owned NoSchedule fence that survives failed detachment.

Uses the shared remount driver's read-only default, identity, PDB, CSI, and Ceph
checks. This galactic-specific fence also verifies CNPG 1.30 drain configuration
and all twelve database primaries. It never sets node.spec.unschedulable.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import signal
import sys
from pathlib import Path
from typing import Any, Mapping

_spec = importlib.util.spec_from_file_location(
    "ceph_taint_core", Path(__file__).with_name("ceph-csi-remount.py")
)
assert _spec and _spec.loader
core = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = core
_spec.loader.exec_module(core)
TAINT_KEY = "storage.proompteng.ai/ceph-remount"
CNPG_IMAGES = {
    "ghcr.io/cloudnative-pg/cloudnative-pg:1.30.0",
    "ghcr.io/cloudnative-pg/cloudnative-pg@sha256:a2701eb97cdd2a34b1fdb2cb51987f544b706e40bec72ae7146cd8580efefebb",
}


def require(condition: bool, message: str) -> None:
    if not condition:
        raise core.RemountError(message)


def digest(value: Any) -> str:
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def tolerates_fence(pod: Mapping[str, Any]) -> bool:
    return any(
        t.get("effect", "") in {"", "NoSchedule"}
        and (
            t.get("key") == TAINT_KEY
            or (not t.get("key") and t.get("operator") == "Exists")
        )
        for t in pod.get("spec", {}).get("tolerations", [])
    )


class TaintWorkflow(core.Workflow):
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self.eviction_attempted = False
        self.storage_unstaged = False
        self.node_uid: str | None = None
        self.primary_identities: list[dict[str, str]] | None = None
        self.operator_identity: str | None = None
        self.audit["metadata"]["schedulingFence"] = "NoSchedule"

    def database_guard(self) -> None:
        clusters = self.json(
            [
                "get",
                "clusters.postgresql.cnpg.io",
                "-A",
                "-n",
                "cloudnative-pg",
                "-o",
                "json",
            ]
        )["items"]
        require(len(clusters) == 12, "expected all twelve galactic CNPG clusters")
        identities = []
        for cluster in clusters:
            status, meta = cluster.get("status", {}), cluster["metadata"]
            primary = status.get("currentPrimary")
            require(
                bool(primary)
                and primary == status.get("targetPrimary")
                and status.get("phase") == "Cluster in healthy state"
                and status.get("readyInstances") == cluster["spec"]["instances"],
                "CNPG cluster is not settled",
            )
            identities.append(
                {
                    "namespace": meta["namespace"],
                    "name": meta["name"],
                    "uid": meta["uid"],
                    "primary": primary,
                }
            )
        identities.sort(key=lambda item: (item["namespace"], item["name"]))
        if self.primary_identities is None:
            self.primary_identities = identities
            self.audit["metadata"]["cnpgPrimaries"] = identities
        require(
            identities == self.primary_identities,
            "CNPG primary identity changed during maintenance",
        )
        op = self.json(
            [
                "get",
                "deployment",
                "cloudnative-pg",
                "-n",
                "cloudnative-pg",
                "-o",
                "json",
            ]
        )
        config = self.json(
            [
                "get",
                "configmap",
                "cnpg-controller-manager-config",
                "-n",
                "cloudnative-pg",
                "-o",
                "json",
            ]
        )
        spec, status = op["spec"], op.get("status", {})
        count = spec.get("replicas", 1)
        require(
            count > 0
            and op["metadata"]["generation"] == status.get("observedGeneration")
            and all(
                status.get(field) == count
                for field in (
                    "replicas",
                    "updatedReplicas",
                    "readyReplicas",
                    "availableReplicas",
                )
            )
            and status.get("unavailableReplicas", 0) == 0,
            "CNPG operator is not settled",
        )
        containers = spec["template"]["spec"]["containers"]
        managers = [
            container for container in containers if container["name"] == "manager"
        ]
        require(
            len(managers) == 1 and managers[0]["image"] in CNPG_IMAGES,
            "unverified CNPG operator version",
        )
        # The accepted cluster uses the 1.30 defaults. Any override needs a new
        # reviewed interpretation instead of guessing precedence or flag syntax.
        require(
            not config.get("data"),
            "CNPG operator configuration overrides require review",
        )
        for container in containers:
            require(
                not container.get("envFrom"),
                "CNPG envFrom configuration cannot be verified",
            )
            require(
                not any(
                    "drain" in env.get("name", "").lower()
                    for env in container.get("env", [])
                ),
                "CNPG drain environment override requires review",
            )
            args = container.get("command", []) + container.get("args", [])
            require(
                not any("drain" in arg.lower() for arg in args),
                "CNPG drain argument override requires review",
            )
            for index, arg in enumerate(args):
                if arg.startswith("--config-map-name="):
                    require(
                        arg == "--config-map-name=cnpg-controller-manager-config",
                        "unexpected CNPG ConfigMap",
                    )
                elif arg == "--config-map-name":
                    require(
                        index + 1 < len(args)
                        and args[index + 1] == "cnpg-controller-manager-config",
                        "unexpected CNPG ConfigMap",
                    )
                elif arg.startswith("--config-map"):
                    raise core.RemountError("unrecognized CNPG ConfigMap argument")
        identity = digest(
            {
                "uid": op["metadata"]["uid"],
                "spec": spec,
                "configUid": config["metadata"]["uid"],
                "data": config.get("data", {}),
            }
        )
        if self.operator_identity is None:
            self.operator_identity = identity
            self.audit["metadata"]["cnpgOperatorConfigurationHash"] = identity
        require(
            identity == self.operator_identity,
            "CNPG operator configuration changed during maintenance",
        )

    def preflight(self) -> None:
        super().preflight()
        require(
            not tolerates_fence(self.pod), "Pod tolerates the NoSchedule storage fence"
        )
        node = self.node_json(self.c.node, "taint preflight")
        self.node_uid = node["metadata"].get("uid")
        require(bool(self.node_uid), "node UID is missing")
        require(
            core.OWNER_ANNOTATION not in node["metadata"].get("annotations", {})
            and not any(
                t.get("key") == TAINT_KEY for t in node["spec"].get("taints", [])
            ),
            "node maintenance already owned",
        )
        self.database_guard()
        self.record("taint-preflight", nodeUid=self.node_uid, cnpgClusters=12)

    def checked_node(self) -> Mapping[str, Any]:
        node = self.node_json(self.c.node, "owned NoSchedule fence")
        require(node["metadata"]["uid"] == self.node_uid, "node UID changed")
        require(not node["spec"].get("unschedulable", False), "node became cordoned")
        return node

    def fence_present(self, node: Mapping[str, Any]) -> bool:
        selected = [
            t for t in node["spec"].get("taints", []) if t.get("key") == TAINT_KEY
        ]
        return node["metadata"].get("annotations", {}).get(
            core.OWNER_ANNOTATION
        ) == self.owner_token and selected == [
            {"key": TAINT_KEY, "value": self.owner_token, "effect": "NoSchedule"}
        ]

    def change_fence(self, acquire: bool) -> None:
        for attempt in range(core.MAX_NODE_PATCH_ATTEMPTS):
            node = self.checked_node()
            meta, spec = node["metadata"], node["spec"]
            annotations, taints = meta.get("annotations", {}), spec.get("taints", [])
            ops = [
                {"op": "test", "path": "/metadata/uid", "value": self.node_uid},
                {
                    "op": "test",
                    "path": "/metadata/resourceVersion",
                    "value": meta["resourceVersion"],
                },
                {"op": "test", "path": "/spec", "value": spec},
            ]
            if acquire:
                require(
                    core.OWNER_ANNOTATION not in annotations
                    and not any(t.get("key") == TAINT_KEY for t in taints),
                    "another fence owner exists",
                )
                if "annotations" not in meta:
                    ops.append(
                        {"op": "add", "path": "/metadata/annotations", "value": {}}
                    )
                ops.append(
                    {
                        "op": "add",
                        "path": core.OWNER_JSON_PATH,
                        "value": self.owner_token,
                    }
                )
                fence = {
                    "key": TAINT_KEY,
                    "value": self.owner_token,
                    "effect": "NoSchedule",
                }
                ops.append(
                    {"op": "add", "path": "/spec/taints/-", "value": fence}
                    if "taints" in spec
                    else {"op": "add", "path": "/spec/taints", "value": [fence]}
                )
            else:
                require(self.fence_present(node), "fence cleanup ownership changed")
                index = next(
                    index
                    for index, taint in enumerate(taints)
                    if taint["key"] == TAINT_KEY
                )
                ops += [
                    {
                        "op": "test",
                        "path": core.OWNER_JSON_PATH,
                        "value": self.owner_token,
                    },
                    {"op": "remove", "path": f"/spec/taints/{index}"},
                    {"op": "remove", "path": core.OWNER_JSON_PATH},
                ]
            args = [
                "patch",
                "node",
                self.c.node,
                "-n",
                self.c.ceph_namespace,
                "--type=json",
                "-p",
                json.dumps(ops),
            ]
            self.command(args + ["--dry-run=server"])
            try:
                self.command(args)
            except core.RemountError:
                observed = self.checked_node()
                complete = (
                    self.fence_present(observed)
                    if acquire
                    else (
                        core.OWNER_ANNOTATION
                        not in observed["metadata"].get("annotations", {})
                        and not any(
                            t.get("key") == TAINT_KEY
                            for t in observed["spec"].get("taints", [])
                        )
                    )
                )
                if complete:
                    return
                if attempt + 1 == core.MAX_NODE_PATCH_ATTEMPTS:
                    raise
                continue
            observed = self.checked_node()
            if acquire:
                require(
                    self.fence_present(observed), "NoSchedule fence readback failed"
                )
            else:
                require(
                    core.OWNER_ANNOTATION
                    not in observed["metadata"].get("annotations", {})
                    and not any(
                        t.get("key") == TAINT_KEY
                        for t in observed["spec"].get("taints", [])
                    ),
                    "NoSchedule fence removal not observed",
                )
            return

    def cordon(self) -> None:
        self.database_guard()
        self.cordon_attempted = True
        self.change_fence(True)
        self.cordoned = True
        self.record("taint-acquired", node=self.c.node)

    def evict(self) -> None:
        require(
            self.fence_present(self.checked_node()), "owned NoSchedule fence is missing"
        )
        self.database_guard()
        self.eviction_attempted = True
        super().evict()

    def wait_unstage(self) -> None:
        super().wait_unstage()
        self.storage_unstaged = True

    def uncordon(self) -> None:
        node = self.checked_node()
        if (
            not self.eviction_attempted
            and not self.cordoned
            and core.OWNER_ANNOTATION not in node["metadata"].get("annotations", {})
            and not any(
                t.get("key") == TAINT_KEY for t in node["spec"].get("taints", [])
            )
        ):
            self.uncordoned = True
            return
        if self.eviction_attempted and not self.storage_unstaged:
            old = core.optional_json(
                self.c,
                ["get", "pod", self.c.pod, "-n", self.c.namespace, "-o", "json"],
                self.runner,
            )
            old_gone = old is None or old.get("metadata", {}).get("uid") != self.c.uid
            mapped = any(
                core.same_image(row[0], expected)
                for row in self.inventory()
                for expected in self.c.images
            )
            require(
                old_gone and not mapped,
                "old Pod UID or RBD mapping remains; retaining owned NoSchedule fence for recovery",
            )
        self.database_guard()
        self.change_fence(False)
        self.uncordoned = True
        self.record("taint-released", node=self.c.node)

    def postcheck(self) -> None:
        super().postcheck()
        self.database_guard()
        self.record("cnpg-identities-unchanged", clusters=12)


def main(argv: list[str] | None = None) -> int:
    args = core.parser().parse_args(argv)
    config = core.Config(
        context=args.context,
        namespace=args.namespace,
        pod=args.pod,
        node=args.node,
        uid=args.expected_pod_uid,
        images=frozenset(args.expected_rbd_image),
        fsid=args.expected_fsid,
        ceph_namespace=args.ceph_namespace,
        execute=args.execute,
        timeout=args.timeout_seconds,
        poll=args.poll_seconds,
        command_timeout=args.command_timeout_seconds,
        allow_bluestore_alert=args.allow_bluestore_alert,
        audit_path=args.audit_path,
    )
    workflow = TaintWorkflow(config)

    def interrupted(*_: Any) -> None:
        raise core.RemountError("interrupted; retained fence recovery checks apply")

    previous = signal.signal(signal.SIGTERM, interrupted)
    try:
        print(json.dumps(workflow.run(), sort_keys=True))
        return 0
    except (core.RemountError, OSError) as exc:
        workflow.finish_audit("failed")
        print(str(exc), file=sys.stderr)
        return 1
    finally:
        signal.signal(signal.SIGTERM, previous)


if __name__ == "__main__":
    raise SystemExit(main())
