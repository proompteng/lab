#!/usr/bin/env python3
"""Reviewed, single-Pod Ceph-CSI RBD remount maintenance.

The command is read-only unless ``--execute`` is supplied.  It intentionally
uses only explicit kubectl calls so the operation can be reviewed from its
audit JSON and tested with a fake command runner.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import signal
import subprocess
import sys
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence


class RemountError(RuntimeError):
    pass


class LatencyAboveLimit(RemountError):
    pass


Runner = Callable[[Sequence[str], str | None, float], tuple[int, str, str]]


@dataclass(frozen=True)
class Config:
    context: str
    namespace: str | None = None
    pod: str | None = None
    node: str | None = None
    uid: str | None = None
    images: frozenset[str] = frozenset()
    fsid: str | None = None
    ceph_namespace: str = "rook-ceph"
    execute: bool = False
    timeout: float = 180.0
    poll: float = 2.0
    command_timeout: float = 15.0
    allow_bluestore_alert: bool = False
    audit_path: Path | None = None


@dataclass(frozen=True)
class Controller:
    kind: str
    name: str
    uid: str
    selector: str


@dataclass(frozen=True)
class Volume:
    claim: str
    claim_uid: str
    pv: str
    pv_uid: str
    image: str


@dataclass(frozen=True)
class CSIPlugin:
    pod: str
    container: str | None


OWNER_ANNOTATION = "storage.proompteng.ai/ceph-remount-owner"
MAX_OSD_LATENCY_MS = 75
MAX_NODE_PATCH_ATTEMPTS = 4
MAX_NODE_READ_ATTEMPTS = 3
KNOWN_CSI_PRINCIPALS = {"csi-rbd-node", "csi-rbd-node.2", "csi-rbd-node.3"}


def json_pointer_segment(value: str) -> str:
    return value.replace("~", "~0").replace("/", "~1")


OWNER_JSON_PATH = f"/metadata/annotations/{json_pointer_segment(OWNER_ANNOTATION)}"


CSI_RBD_DRIVER = "rook-ceph.rbd.csi.ceph.com"
CSI_RBD_NODE_DS = "rook-ceph.rbd.csi.ceph.com-nodeplugin"
PROTECTED_KINDS = {
    "daemonset",
    "job",
    "cronjob",
    "virtualmachine",
    "virtualmachineinstance",
    "cnpgcluster",
    "strimzipodset",
    "kafkacluster",
    "restatecluster",
    "restatedeployment",
}
RESOURCES = {
    "Deployment": "deployments",
    "ReplicaSet": "replicasets",
    "StatefulSet": "statefulsets",
    "DaemonSet": "daemonsets",
    "Job": "jobs",
    "CronJob": "cronjobs",
    "VirtualMachine": "virtualmachines",
    "VirtualMachineInstance": "virtualmachineinstances",
    "CNPGCluster": "clusters.postgresql.cnpg.io",
    "StrimziPodSet": "strimzipodsets.core.strimzi.io",
    "RestateCluster": "restateclusters.apps.restate.dev",
    "RestateDeployment": "restatedeployments.apps.restate.dev",
}
APPROVED_HEALTH_WARNINGS = {
    "AUTH_INSECURE_CLIENT_KEY_TYPE",
    "AUTH_INSECURE_KEYS_ALLOWED",
    "AUTH_INSECURE_KEYS_CREATABLE",
    "AUTH_INSECURE_ROTATING_SERVICE_KEY_TYPE",
}


INVENTORY_SCRIPT = r"""set -eu
for device in /sys/bus/rbd/devices/*; do
  [ -d "$device" ] || continue
  image=$(cat "$device/name" 2>/dev/null || true)
  client_id=$(cat "$device/client_id" 2>/dev/null || true)
  principal=
  candidate="/sys/kernel/debug/ceph/{{FSID}}.${client_id}/client_options"
  if [ -r "$candidate" ]; then
    principal=$(sed -n 's/.*name=\([^, ]*\).*/\1/p' "$candidate" | head -n 1)
  fi
  case "$principal" in client.*) principal=${principal#client.};; esac
  [ -n "$principal" ] || { echo "missing verified Ceph client_options for ${client_id}" >&2; exit 1; }
  printf '%s\t%s\t%s\n' "$image" "$client_id" "$principal"
done
"""


def subprocess_runner(argv: Sequence[str], input_text: str | None, timeout: float) -> tuple[int, str, str]:
    try:
        result = subprocess.run(
            list(argv), input=input_text, text=True, capture_output=True, check=False, timeout=timeout
        )
    except subprocess.TimeoutExpired as exc:
        raise RemountError(f"command timed out after {timeout:.1f}s: {' '.join(argv)}") from exc
    return result.returncode, result.stdout, result.stderr


def kubectl(config: Config, args: Sequence[str], runner: Runner, input_text: str | None = None) -> str:
    argv = ["kubectl", "--context", config.context, *args]
    code, stdout, stderr = runner(argv, input_text, config.command_timeout)
    if code:
        raise RemountError(f"kubectl failed ({code}): {' '.join(argv)}: {stderr.strip()}")
    return stdout


def get_json(config: Config, args: Sequence[str], runner: Runner) -> Mapping[str, Any] | list[Any]:
    try:
        value = json.loads(kubectl(config, args, runner))
    except json.JSONDecodeError as exc:
        raise RemountError(f"kubectl returned invalid JSON: {' '.join(args)}") from exc
    if not isinstance(value, (dict, list)):
        raise RemountError(f"kubectl JSON response is not an object/list: {' '.join(args)}")
    return value


def optional_json(config: Config, args: Sequence[str], runner: Runner) -> Mapping[str, Any] | list[Any] | None:
    try:
        return get_json(config, args, runner)
    except RemountError as exc:
        if "not found" in str(exc).lower() or "notfound" in str(exc).lower():
            return None
        raise


def ready(obj: Mapping[str, Any]) -> bool:
    return obj.get("status", {}).get("phase") == "Running" and any(
        c.get("type") == "Ready" and c.get("status") == "True" for c in obj.get("status", {}).get("conditions", [])
    )


def node_ready(obj: Mapping[str, Any]) -> bool:
    return any(c.get("type") == "Ready" and c.get("status") == "True" for c in obj.get("status", {}).get("conditions", []))


def claims(obj: Mapping[str, Any]) -> set[str]:
    return {
        volume["persistentVolumeClaim"]["claimName"]
        for volume in obj.get("spec", {}).get("volumes", [])
        if isinstance(volume.get("persistentVolumeClaim"), Mapping)
        and isinstance(volume["persistentVolumeClaim"].get("claimName"), str)
    }


def match_selector(selector: Mapping[str, Any] | None, labels: Mapping[str, str]) -> bool:
    if selector is None or not isinstance(selector, Mapping):
        return False
    if not selector.get("matchLabels") and not selector.get("matchExpressions"):
        return True
    if any(labels.get(k) != v for k, v in selector.get("matchLabels", {}).items()):
        return False
    for expression in selector.get("matchExpressions", []):
        key, operator, values = expression.get("key"), expression.get("operator"), expression.get("values", [])
        present = key in labels
        if operator == "In" and (not present or labels[key] not in values):
            return False
        if operator == "NotIn" and present and labels[key] in values:
            return False
        if operator == "Exists" and not present:
            return False
        if operator == "DoesNotExist" and present:
            return False
        if operator not in {"In", "NotIn", "Exists", "DoesNotExist"}:
            raise RemountError(f"unsupported selector operator {operator!r}")
    return True


def labels_for_selector(selector: Mapping[str, Any]) -> dict[str, str]:
    labels = selector.get("matchLabels")
    if not isinstance(labels, Mapping) or not labels or selector.get("matchExpressions"):
        raise RemountError("only non-empty matchLabels selectors are supported")
    return {str(k): str(v) for k, v in labels.items()}


def selector_string(labels: Mapping[str, str]) -> str:
    return ",".join(f"{key}={labels[key]}" for key in sorted(labels))


def same_image(observed: str, expected: str) -> bool:
    return observed == expected or observed.rsplit("/", 1)[-1] == expected


def image_from_volume_handle(handle: Any) -> str:
    if not isinstance(handle, str):
        raise RemountError("CSI PV has no volumeHandle")
    match = re.search(
        r"([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        handle,
    )
    if not match:
        raise RemountError("CSI volumeHandle has no validated UUID suffix")
    return f"csi-vol-{match.group(1).lower()}"


def event(audit: dict[str, Any], name: str, **values: Any) -> None:
    audit["events"].append({"name": name, "at": dt.datetime.now(dt.UTC).isoformat(), **values})


def write_audit(path: Path | None, audit: dict[str, Any], outcome: str) -> None:
    if path is None:
        return
    payload = {"metadata": audit["metadata"], "events": audit["events"], "outcome": outcome}
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(temporary, path)


class Workflow:
    def __init__(
        self,
        config: Config,
        runner: Runner = subprocess_runner,
        *,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self.c = config
        self.runner = runner
        self.clock = clock
        self.sleep = sleep
        self.audit: dict[str, Any] = {
            "metadata": {
                "operation": "ceph-csi-rbd-remount",
                "mode": "execute" if config.execute else "plan",
                "context": config.context,
                "namespace": config.namespace,
                "pod": config.pod,
                "node": config.node,
                "expectedPodUID": config.uid,
                "expectedRBDImages": sorted(config.images),
                "expectedFSID": config.fsid,
                "cephNamespace": config.ceph_namespace,
                "requiredCSIKeyGeneration": 3,
                "requiredCSIKeyType": "aes256k",
                "minimumPriorKeyCount": 2,
                "allowBlueStoreAlert": config.allow_bluestore_alert,
            },
            "events": [],
        }
        self.controller: Controller | None = None
        self.pod: Mapping[str, Any] | None = None
        self.claim_set: set[str] = set()
        self.volumes: tuple[Volume, ...] = ()
        self.plugin: CSIPlugin | None = None
        self.node_rv: str | None = None
        self.cordoned = False
        self.uncordoned = False
        self.cordon_attempted = False
        self.owner_token = uuid.uuid4().hex
        self.audit["metadata"]["nodeOwnershipToken"] = self.owner_token
        self.already_current = False

    def target(self) -> tuple[str, str, str, str, str]:
        values = (self.c.namespace, self.c.pod, self.c.node, self.c.uid, self.c.fsid)
        if not all(isinstance(value, str) and value for value in values):
            raise RemountError("explicit namespace, Pod, node, expected Pod UID, and FSID are required")
        return values  # type: ignore[return-value]

    def run(self) -> dict[str, Any]:
        failure: BaseException | None = None
        try:
            self.persist("started")
            self.validate()
            if not self.complete_target():
                self.record("plan", writes=[])
                outcome = "planned"
                self.finish_audit(outcome)
                return self.summary(outcome)
            self.preflight()
            if self.already_current:
                self.verify_mapping()
                self.postcheck()
                self.record("complete", reason="all expected RBD images already use csi-rbd-node.3", writes=[])
                outcome = "complete"
                self.finish_audit(outcome)
                return self.summary(outcome)
            if not self.c.execute:
                self.record("plan-ready", writes=[])
                outcome = "planned"
                self.finish_audit(outcome)
                return self.summary(outcome)
            self.cordon()
            self.evict()
            self.wait_unstage()
        except BaseException as exc:
            failure = exc
            self.record("failed", error=type(exc).__name__)
        finally:
            if (self.cordon_attempted or self.cordoned) and not self.uncordoned:
                try:
                    self.uncordon()
                except BaseException as exc:
                    self.record("uncordon-failed", error=type(exc).__name__)
                    failure = RemountError(f"{failure}; node uncordon also failed: {exc}") if failure else exc
        if failure:
            self.finish_audit("failed")
            raise failure
        try:
            self.wait_replacement()
            self.verify_mapping()
            self.postcheck()
            self.record("complete")
            outcome = "complete"
            self.finish_audit(outcome)
            return self.summary(outcome)
        except BaseException as exc:
            self.record("failed-after-uncordon", error=type(exc).__name__)
            self.finish_audit("failed")
            raise

    def finish_audit(self, outcome: str) -> None:
        write_audit(self.c.audit_path, self.audit, outcome)

    def persist(self, outcome: str = "in-progress") -> None:
        write_audit(self.c.audit_path, self.audit, outcome)

    def record(self, name: str, **values: Any) -> None:
        event(self.audit, name, **values)
        self.persist()

    def validate(self) -> None:
        if not self.c.context.strip():
            raise RemountError("--context must be an explicit non-empty context")
        if self.c.timeout <= 0 or self.c.timeout > 900 or self.c.poll < 0 or self.c.poll > 5:
            raise RemountError("timeout must be 0<timeout<=900 and 0<=poll<=5 seconds")
        if self.c.command_timeout <= 0 or self.c.command_timeout > 60:
            raise RemountError("command timeout must be between 0 and 60 seconds")
        if self.c.execute and self.c.audit_path is None:
            raise RemountError("--execute requires --audit-file")
        if self.c.execute:
            missing = [name for name, value in (("--namespace", self.c.namespace), ("--pod", self.c.pod), ("--node", self.c.node), ("--expected-pod-uid", self.c.uid), ("--expected-fsid", self.c.fsid)) if not value]
            if missing or not self.c.images:
                raise RemountError(f"--execute requires explicit {', '.join(missing + ([] if self.c.images else ['--expected-rbd-image']))}")
        if self.c.fsid and not re.fullmatch(r"[0-9a-fA-F-]{36}", self.c.fsid):
            raise RemountError("--expected-fsid must be a UUID-shaped Ceph FSID")

    def complete_target(self) -> bool:
        return bool(self.c.namespace and self.c.pod and self.c.node and self.c.uid and self.c.fsid and self.c.images)

    def json(self, args: Sequence[str]) -> Mapping[str, Any] | list[Any]:
        return get_json(self.c, args, self.runner)

    def command(self, args: Sequence[str], input_text: str | None = None) -> str:
        return kubectl(self.c, args, self.runner, input_text)

    def node_json(self, node_name: str, purpose: str) -> Mapping[str, Any]:
        last_error: RemountError | None = None
        for attempt in range(1, MAX_NODE_READ_ATTEMPTS + 1):
            try:
                node = self.json(["get", "node", node_name, "-n", self.c.ceph_namespace, "-o", "json"])
                if not isinstance(node, Mapping):
                    raise RemountError(f"node response is not an object during {purpose}")
                return node
            except RemountError as exc:
                last_error = exc
                if attempt < MAX_NODE_READ_ATTEMPTS:
                    self.sleep(min(self.c.poll or 0.1, 5))
        raise RemountError(f"node read failed during {purpose} after {MAX_NODE_READ_ATTEMPTS} attempts: {last_error}")

    def ceph(self, *args: str) -> dict[str, Any]:
        output = self.command(["exec", "-n", self.c.ceph_namespace, "deploy/rook-ceph-tools", "--", *args])
        try:
            value = json.loads(output)
        except json.JSONDecodeError as exc:
            raise RemountError(f"Ceph returned invalid JSON for {' '.join(args)}") from exc
        if not isinstance(value, dict):
            raise RemountError(f"Ceph returned a non-object for {' '.join(args)}")
        return value

    def preflight(self) -> None:
        namespace, pod_name, node_name, uid, fsid = self.target()
        self.record("preflight-start")
        node = self.json(["get", "node", node_name, "-n", self.c.ceph_namespace, "-o", "json"])
        if not isinstance(node, Mapping):
            raise RemountError("node response is not an object")
        self.node_rv = str(node.get("metadata", {}).get("resourceVersion", ""))
        if not self.node_rv or node.get("spec", {}).get("unschedulable", False):
            raise RemountError("target node is already cordoned or has no resourceVersion")
        if not node_ready(node):
            raise RemountError(f"target node {node_name} is not Ready")
        self.record("node-ready", resourceVersion=self.node_rv, originalUnschedulable=False)
        pod = self.json(["get", "pod", pod_name, "-n", namespace, "-o", "json"])
        if not isinstance(pod, Mapping):
            raise RemountError("Pod response is not an object")
        if pod.get("metadata", {}).get("uid") != uid:
            raise RemountError(f"Pod UID mismatch: expected {uid}, observed {pod.get('metadata', {}).get('uid')}")
        if pod.get("spec", {}).get("nodeName") != node_name or not ready(pod) or pod.get("metadata", {}).get("deletionTimestamp"):
            raise RemountError("selected Pod is not Running/Ready on the explicit node")
        self.pod = pod
        self.claim_set = claims(pod)
        if not self.claim_set:
            raise RemountError("naked/no-PVC Pods are refused")
        self.controller = self.owner_controller(pod)
        self.pdb(pod)
        self.volumes = self.rbd_volumes(self.claim_set)
        self.shared_consumers()
        self.ceph_posture(fsid)
        self.functional_checks("preflight")
        self.plugin = self.csi_ready(node_name)
        self.inspect_current_mapping()
        self.record("preflight-ready", controller=self.controller.name, claims=sorted(self.claim_set), images=sorted(v.image for v in self.volumes), csiNodePod=self.plugin.pod)

    def inspect_current_mapping(self) -> None:
        records = self.inventory()
        selected: list[tuple[str, str, str]] = []
        for expected in sorted(self.c.images):
            matches = [record for record in records if same_image(record[0], expected)]
            if not matches:
                raise RemountError(f"preflight cannot find expected RBD image {expected} on the selected node")
            if any(record[2] not in KNOWN_CSI_PRINCIPALS for record in matches):
                raise RemountError(f"preflight found an unknown Ceph CSI principal for {expected}")
            selected.extend(matches)
        self.already_current = bool(selected) and all(record[2] == "csi-rbd-node.3" for record in selected)
        self.record("current-mapping", images=sorted(self.c.images), principals=sorted({record[2] for record in selected}), alreadyCurrent=self.already_current)

    def owner_controller(self, pod: Mapping[str, Any]) -> Controller:
        refs = [ref for ref in pod.get("metadata", {}).get("ownerReferences", []) if ref.get("controller")]
        if len(refs) != 1:
            raise RemountError("naked or ambiguous Pod controller is refused")
        ref = refs[0]
        seen: set[tuple[str, str]] = set()
        through_replicaset = False
        while True:
            kind, name, uid = str(ref.get("kind", "")), str(ref.get("name", "")), str(ref.get("uid", ""))
            if not kind or not name or not uid or (kind, name) in seen:
                raise RemountError("invalid/cyclic controller owner chain")
            seen.add((kind, name))
            if kind.lower() in PROTECTED_KINDS or kind not in RESOURCES:
                raise RemountError(f"protected or unsupported controller kind {kind}")
            namespace, _, _, _, _ = self.target()
            owner = self.json(["get", RESOURCES[kind], name, "-n", namespace, "-o", "json"])
            if not isinstance(owner, Mapping) or owner.get("metadata", {}).get("uid") != uid:
                raise RemountError(f"controller UID mismatch for {kind}/{name}")
            parents = [item for item in owner.get("metadata", {}).get("ownerReferences", []) if item.get("controller")]
            if kind == "ReplicaSet" and parents:
                if len(parents) != 1 or parents[0].get("kind") != "Deployment":
                    raise RemountError("ordinary workload must use the exact Pod/ReplicaSet/Deployment owner chain")
                through_replicaset = True
                ref = parents[0]
                continue
            if kind == "ReplicaSet":
                raise RemountError("unmanaged ReplicaSet controllers are refused")
            if kind in {"Deployment", "StatefulSet"} and parents:
                raise RemountError("ordinary workload controller must not have a parent controller")
            if kind == "Deployment" and not through_replicaset:
                raise RemountError("Deployment Pods must use the exact Pod/ReplicaSet/Deployment owner chain")
            if kind not in {"Deployment", "StatefulSet", "ReplicaSet"}:
                raise RemountError(f"controller kind {kind} requires its specialized operator")
            if owner.get("metadata", {}).get("deletionTimestamp"):
                raise RemountError("controller is terminating")
            replicas = owner.get("spec", {}).get("replicas")
            if not isinstance(replicas, int) or replicas < 1:
                raise RemountError("controller has no usable replica count")
            labels = labels_for_selector(owner.get("spec", {}).get("selector", {}))
            return Controller(kind, name, uid, selector_string(labels))

    def pdb(self, pod: Mapping[str, Any]) -> int | None:
        namespace, _, _, _, _ = self.target()
        response = self.json(["get", "pdb", "-n", namespace, "-o", "json"])
        if not isinstance(response, Mapping):
            raise RemountError("PDB response is not an object")
        matching = []
        labels = pod.get("metadata", {}).get("labels", {})
        for item in response.get("items", []):
            item_spec = item.get("spec", {})
            selector = item_spec.get("selector") if isinstance(item_spec, Mapping) else None
            if not match_selector(selector, labels):
                continue
            budget = item.get("status", {}).get("disruptionsAllowed")
            if not isinstance(budget, int) or budget < 1:
                raise RemountError(f"PDB {item.get('metadata', {}).get('name')} has no disruption budget")
            matching.append(
                {
                    "name": item.get("metadata", {}).get("name"),
                    "selector": selector,
                    "disruptionsAllowed": budget,
                }
            )
        if not matching:
            self.record("pdb-none", reason="no matching PDB; controller is ordinary and eviction remains UID-fenced")
            return None
        self.record("pdb-ready", pdbs=matching)
        return min(item["disruptionsAllowed"] for item in matching)

    def rbd_volumes(self, claim_names: set[str]) -> tuple[Volume, ...]:
        namespace, _, _, _, _ = self.target()
        values: list[Volume] = []
        for claim in sorted(claim_names):
            pvc = self.json(["get", "pvc", claim, "-n", namespace, "-o", "json"])
            if not isinstance(pvc, Mapping) or not pvc.get("spec", {}).get("volumeName"):
                raise RemountError(f"PVC {claim} is not bound")
            pv_name = pvc["spec"]["volumeName"]
            pv = self.json(["get", "pv", pv_name, "-n", self.c.ceph_namespace, "-o", "json"])
            spec = pv.get("spec", {}) if isinstance(pv, Mapping) else {}
            pvc_uid = pvc.get("metadata", {}).get("uid")
            claim_ref = spec.get("claimRef", {})
            if (
                not pvc_uid
                or claim_ref.get("uid") != pvc_uid
                or claim_ref.get("name") != claim
                or claim_ref.get("namespace") != namespace
            ):
                raise RemountError(f"PV {pv_name} claimRef does not match PVC {namespace}/{claim}")
            csi = spec.get("csi", {})
            if not isinstance(csi, Mapping):
                raise RemountError(f"PV {pv_name} has no CSI specification")
            if csi.get("driver") != CSI_RBD_DRIVER:
                raise RemountError(f"PVC {claim} is not RBD Ceph-CSI")
            if str(spec.get("volumeMode") or pvc.get("spec", {}).get("volumeMode") or "Filesystem").lower() != "filesystem":
                raise RemountError(f"PVC {claim} is raw-block or otherwise unsupported")
            attrs = csi.get("volumeAttributes", {})
            if not isinstance(attrs, Mapping):
                raise RemountError(f"PV {pv_name} has invalid CSI volumeAttributes")
            image_name = attrs.get("imageName")
            if image_name is None:
                image_name = image_from_volume_handle(csi.get("volumeHandle"))
            if not isinstance(image_name, str) or not re.fullmatch(
                r"csi-vol-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}",
                image_name,
            ):
                raise RemountError(f"PVC {claim} has an unvalidated RBD image name")
            candidates = {image_name.lower()}
            matches = candidates & self.c.images
            if len(matches) != 1:
                raise RemountError(f"PVC {claim} is not exactly covered by expected RBD images: {sorted(candidates)}")
            pv_uid = pv.get("metadata", {}).get("uid")
            if not isinstance(pvc_uid, str) or not isinstance(pv_uid, str) or not pv_uid:
                raise RemountError(f"PVC {claim} or PV {pv_name} has no stable UID")
            values.append(Volume(claim, pvc_uid, pv_name, pv_uid, next(iter(matches))))
        if len({value.image for value in values}) != len(values) or {value.image for value in values} != self.c.images:
            raise RemountError("expected RBD images must exactly cover every Pod PVC")
        return tuple(values)

    def shared_consumers(self) -> None:
        namespace, _, _, uid, _ = self.target()
        response = self.json(["get", "pods", "--all-namespaces", "-o", "json"])
        if not isinstance(response, Mapping):
            raise RemountError("Pod consumer response is not an object")
        for pod in response.get("items", []):
            metadata = pod.get("metadata", {})
            if metadata.get("uid") == uid or metadata.get("namespace") != namespace:
                continue
            shared = claims(pod) & self.claim_set
            if not shared:
                continue
            if metadata.get("deletionTimestamp"):
                raise RemountError(f"PVC has a terminating consumer {namespace}/{metadata.get('name')}")
            if pod.get("status", {}).get("phase") in {"Succeeded", "Failed"}:
                continue
            raise RemountError(f"PVC has a live consumer {namespace}/{metadata.get('name')}")

    def ceph_posture(self, fsid: str) -> None:
        cluster = self.json(["get", "cephcluster", "rook-ceph", "-n", self.c.ceph_namespace, "-o", "json"])
        if not isinstance(cluster, Mapping):
            raise RemountError("CephCluster response is not an object")
        spec = cluster.get("spec", {}).get("security", {}).get("cephx", {}).get("csi", {})
        status = cluster.get("status", {}).get("cephx", {}).get("csi", {})
        if cluster.get("status", {}).get("phase") != "Ready" or spec.get("keyGeneration") != 3 or status.get("keyGeneration") != 3 or str(spec.get("keyType", "")).lower() != "aes256k" or str(status.get("keyType", "")).lower() != "aes256k":
            raise RemountError("CephCluster is not Ready with CSI generation 3 AES256K")
        desired_prior = spec.get("keepPriorKeyCountMax")
        actual_prior = status.get("priorKeyCount")
        if not isinstance(desired_prior, int) or desired_prior < 2 or not isinstance(actual_prior, int) or actual_prior < 2:
            raise RemountError("CephCluster does not report desired and actual retention of two prior CSI keys")
        observed_fsid = self.command(["exec", "-n", self.c.ceph_namespace, "deploy/rook-ceph-tools", "--", "ceph", "fsid"]).strip()
        if observed_fsid != fsid:
            raise RemountError(f"Ceph FSID mismatch: expected {fsid}, observed {observed_fsid}")
        health_status = self.check_ceph_health("preflight")
        self.wait_for_quiet_io()
        self.record("ceph-posture-ready", fsid=fsid, health=health_status, priorKeyCount=actual_prior)

    def check_ceph_health(self, phase: str) -> str:
        health = self.ceph("ceph", "status", "-f", "json")
        health_data = health.get("health", {})
        if not isinstance(health_data, Mapping):
            raise RemountError(f"Ceph health response is malformed during {phase}")
        health_status = health_data.get("status")
        checks = set(health_data.get("checks") or {})
        mutes = health_data.get("mutes") or []
        allowed = APPROVED_HEALTH_WARNINGS | ({"BLUESTORE_SLOW_OP_ALERT"} if self.c.allow_bluestore_alert else set())
        if health_status == "HEALTH_ERR" or health_status not in {"HEALTH_OK", "HEALTH_WARN"} or mutes or checks - allowed:
            raise RemountError(f"Ceph health is not an approved {phase} state: {health_status}")
        if "BLUESTORE_SLOW_OP_ALERT" in checks:
            if not self.c.allow_bluestore_alert:
                raise RemountError("BLUESTORE_SLOW_OP_ALERT requires --allow-bluestore-alert")
            print(
                "ceph-csi-remount: allowing retained BLUESTORE_SLOW_OP_ALERT; OSD latency and functional gates are required",
                file=sys.stderr,
            )
            self.record("ceph-health-warning", check="BLUESTORE_SLOW_OP_ALERT", acknowledged=True, phase=phase)
        return str(health_status)

    def check_osd_latency(self, perf: Mapping[str, Any]) -> None:
        entries = perf.get("osdstats", {}).get("osd_perf_infos", [])
        if not isinstance(entries, list) or len(entries) != 6:
            raise RemountError("Ceph OSD latency sample must contain all six OSDs")
        values = []
        for entry in entries:
            stats = entry.get("perf_stats", {}) if isinstance(entry, Mapping) else {}
            for field in ("commit_latency_ms", "apply_latency_ms"):
                value = stats.get(field)
                if not isinstance(value, (int, float)) or value < 0:
                    raise RemountError(f"Ceph OSD {entry.get('id')} {field}={value!r}ms is outside normal <= {MAX_OSD_LATENCY_MS}ms")
                if value > MAX_OSD_LATENCY_MS:
                    self.record("osd-latency-above-limit", osd=entry.get("id"), field=field, latencyMs=value)
                    raise LatencyAboveLimit(f"Ceph OSD {entry.get('id')} {field}={value}ms exceeds {MAX_OSD_LATENCY_MS}ms")
                values.append(value)
        self.record("osd-latency-ready", maxLatencyMs=max(values))

    def wait_for_quiet_io(self) -> None:
        deadline = self.clock() + min(self.c.timeout, 90)
        consecutive = 0
        while self.clock() < deadline:
            try:
                self.check_osd_latency(self.ceph("ceph", "osd", "perf", "-f", "json"))
                consecutive += 1
            except LatencyAboveLimit:
                consecutive = 0
            if consecutive == 3:
                self.record("osd-quiet-window", consecutiveSamples=consecutive)
                return
            self.sleep(self.c.poll)
        raise RemountError("Ceph I/O did not produce three consecutive samples below the latency limit within 90 seconds")

    def functional_checks(self, phase: str) -> None:
        osd = self.ceph("ceph", "osd", "stat", "-f", "json")
        if not all(osd.get(key) == 6 for key in ("num_osds", "num_up_osds", "num_in_osds")):
            raise RemountError(f"{phase} requires six Ceph OSDs total/up/in")
        quorum = self.ceph("ceph", "quorum_status", "-f", "json")
        quorum_ids = quorum.get("quorum", [])
        quorum_names = quorum.get("quorum_names", [])
        if (
            ("quorate" in quorum and quorum.get("quorate") is not True)
            or not isinstance(quorum_ids, list)
            or not isinstance(quorum_names, list)
            or len(quorum_ids) != 3
            or len(quorum_names) != 3
            or not isinstance(quorum.get("quorum_leader_name"), str)
            or quorum["quorum_leader_name"] not in quorum_names
        ):
            raise RemountError(f"{phase} requires a quorate three-member monitor quorum")
        monmap = quorum.get("monmap", {})
        if isinstance(monmap, Mapping) and isinstance(monmap.get("mons"), list):
            monmap_names = {str(mon.get("name")) for mon in monmap["mons"] if isinstance(mon, Mapping) and mon.get("name")}
            if monmap_names and monmap_names != set(quorum_names):
                raise RemountError(f"{phase} quorum names do not match the monitor map")
        pg = self.ceph("ceph", "pg", "stat", "-f", "json")
        summary, states = pg.get("pg_summary", {}), pg.get("pg_summary", {}).get("num_pg_by_state", [])
        if pg.get("pg_ready") is not True or not isinstance(summary.get("num_pgs"), int) or summary["num_pgs"] <= 0 or sum(item.get("num", 0) for item in states) != summary["num_pgs"] or any(not str(item.get("name", "")).startswith("active+clean") for item in states):
            raise RemountError(f"{phase} requires all PGs to be active+clean")
        self.record("ceph-functional-ready", phase=phase, osds="6/6/6", quorum=3, pg="active+clean")

    def csi_ready(self, node_name: str) -> CSIPlugin:
        ds = self.json(["get", "daemonset", CSI_RBD_NODE_DS, "-n", self.c.ceph_namespace, "-o", "json"])
        status = ds.get("status", {}) if isinstance(ds, Mapping) else {}
        desired = status.get("desiredNumberScheduled")
        if not isinstance(desired, int) or desired <= 0 or any(status.get(field) != desired for field in ("currentNumberScheduled", "updatedNumberScheduled", "numberAvailable", "numberReady")):
            raise RemountError("CSI RBD node DaemonSet is not fully Ready")
        labels = labels_for_selector(ds.get("spec", {}).get("selector", {})) if isinstance(ds, Mapping) else {}
        response = self.json(["get", "pods", "-n", self.c.ceph_namespace, "-l", selector_string(labels), "-o", "json"])
        items = response.get("items", []) if isinstance(response, Mapping) else []
        candidates = [pod for pod in items if pod.get("spec", {}).get("nodeName") == node_name and ready(pod)]
        if len(candidates) != 1:
            raise RemountError(f"expected one Ready CSI RBD node Pod on {node_name}")
        pod = candidates[0]
        name = pod.get("metadata", {}).get("name")
        if not isinstance(name, str):
            raise RemountError("CSI node Pod has no name")
        containers = [item.get("name") for item in pod.get("spec", {}).get("containers", [])]
        if containers.count("csi-rbdplugin") != 1:
            raise RemountError("CSI node Pod does not contain exactly one csi-rbdplugin container")
        self.record("csi-ready", daemonset=CSI_RBD_NODE_DS, pod=name)
        return CSIPlugin(name, "csi-rbdplugin")

    def cordon(self) -> None:
        _, _, node_name, _, _ = self.target()
        self.cordon_attempted = True
        self.record("cordon-start")
        last_error: RemountError | None = None
        for attempt in range(1, MAX_NODE_PATCH_ATTEMPTS + 1):
            node = self.node_json(node_name, "cordon")
            if not isinstance(node, Mapping):
                raise RemountError("node response is not an object while cordoning")
            metadata = node.get("metadata", {})
            spec = node.get("spec", {})
            if not isinstance(metadata, Mapping) or not isinstance(spec, Mapping):
                raise RemountError("node metadata/spec is malformed while cordoning")
            annotations = metadata.get("annotations", {})
            if annotations is None:
                annotations = {}
            if not isinstance(annotations, Mapping):
                raise RemountError("node annotations are malformed while cordoning")
            rv = str(metadata.get("resourceVersion", ""))
            if not rv:
                raise RemountError("node has no resourceVersion while cordoning")
            if bool(spec.get("unschedulable", False)):
                raise RemountError("target node became cordoned before this operation")
            if not node_ready(node):
                raise RemountError(f"target node {node_name} is not Ready immediately before cordon")
            existing_owner = annotations.get(OWNER_ANNOTATION)
            if existing_owner:
                raise RemountError("target node already has a remount owner")
            self.node_rv = rv
            self.record("cordon-attempt", attempt=attempt, resourceVersion=rv)
            patch: list[dict[str, Any]] = [{"op": "test", "path": "/metadata/resourceVersion", "value": rv}]
            if "annotations" not in metadata:
                patch.append({"op": "add", "path": "/metadata/annotations", "value": {OWNER_ANNOTATION: self.owner_token}})
            else:
                patch.append({"op": "add", "path": OWNER_JSON_PATH, "value": self.owner_token})
            patch.append(
                {
                    "op": "replace" if "unschedulable" in spec else "add",
                    "path": "/spec/unschedulable",
                    "value": True,
                }
            )
            patch_error: RemountError | None = None
            patch_started = False
            try:
                patch_started = True
                response = self.json(
                    [
                        "patch",
                        "node",
                        node_name,
                        "-n",
                        self.c.ceph_namespace,
                        "--type=json",
                        "-p",
                        json.dumps(patch, separators=(",", ":")),
                        "-o",
                        "json",
                    ]
                )
                if not isinstance(response, Mapping):
                    raise RemountError("cordon patch response is not an object")
                response_annotations = response.get("metadata", {}).get("annotations", {})
                if (
                    bool(response.get("spec", {}).get("unschedulable", False)) is not True
                    or not isinstance(response_annotations, Mapping)
                    or response_annotations.get(OWNER_ANNOTATION) != self.owner_token
                ):
                    raise RemountError("cordon patch did not establish the ownership token and unschedulable state")
                self.node_rv = str(response.get("metadata", {}).get("resourceVersion", rv))
                self.cordoned = True
            except RemountError as exc:
                patch_error = exc
            finally:
                if patch_started and not self.cordoned:
                    try:
                        observed = self.node_json(node_name, "cordon confirmation")
                        observed_meta = observed.get("metadata", {}) if isinstance(observed, Mapping) else {}
                        observed_spec = observed.get("spec", {}) if isinstance(observed, Mapping) else {}
                        observed_annotations = observed_meta.get("annotations", {}) if isinstance(observed_meta, Mapping) else {}
                        if (
                            isinstance(observed_annotations, Mapping)
                            and observed_annotations.get(OWNER_ANNOTATION) == self.owner_token
                            and bool(observed_spec.get("unschedulable", False))
                        ):
                            self.cordoned = True
                            self.node_rv = str(observed_meta.get("resourceVersion", rv))
                            self.record("cordon-confirmed-after-error", attempt=attempt, resourceVersion=self.node_rv)
                    except (RemountError, TypeError, AttributeError) as observed_error:
                        if patch_error is None:
                            patch_error = RemountError(f"could not confirm cordon ownership after patch failure: {observed_error}")
            if self.cordoned:
                self.record("cordoned", resourceVersion=self.node_rv)
                return
            if patch_error is None:
                raise RemountError("cordon patch failed without an error")
            if "conflict" not in str(patch_error).lower() and "test operation" not in str(patch_error).lower():
                raise patch_error
            last_error = patch_error
        raise RemountError(f"node cordon resourceVersion conflicted after {MAX_NODE_PATCH_ATTEMPTS} attempts: {last_error}")

    def evict(self) -> None:
        namespace, pod_name, _, uid, _ = self.target()
        body = {"apiVersion": "policy/v1", "kind": "Eviction", "metadata": {"name": pod_name, "namespace": namespace}, "deleteOptions": {"preconditions": {"uid": uid}}}
        path = f"/api/v1/namespaces/{namespace}/pods/{pod_name}/eviction"
        self.record("eviction-start", uidPrecondition=uid)
        self.command(["create", "--raw", path, "-f", "-"], json.dumps(body, separators=(",", ":")))
        self.record("evicted", apiVersion="policy/v1", uidPrecondition=uid)

    def inventory(self) -> list[tuple[str, str, str]]:
        if self.plugin is None or not self.c.fsid:
            raise RemountError("CSI node plugin or FSID was not recorded")
        args = ["exec", "-n", self.c.ceph_namespace, self.plugin.pod]
        if self.plugin.container:
            args += ["-c", self.plugin.container]
        args += ["--", "sh", "-ceu", INVENTORY_SCRIPT.replace("{{FSID}}", self.c.fsid)]
        records: list[tuple[str, str, str]] = []
        for line in self.command(args).splitlines():
            parts = line.split("\t", 2)
            if len(parts) != 3:
                if line.strip():
                    raise RemountError("CSI sysfs inventory returned an invalid record")
                continue
            image, client_id, principal = (part.strip() for part in parts)
            if not image or not re.fullmatch(r"client[0-9]+", client_id) or not re.fullmatch(r"csi-rbd-node(?:\.[0-9]+)?", principal):
                raise RemountError("CSI sysfs inventory returned an invalid record")
            records.append((image, client_id, principal))
        return records

    def wait_unstage(self) -> None:
        namespace, pod_name, _, uid, _ = self.target()
        deadline = self.clock() + self.c.timeout
        while True:
            pod = optional_json(self.c, ["get", "pod", pod_name, "-n", namespace, "-o", "json"], self.runner)
            old_gone = pod is None or pod.get("metadata", {}).get("uid") != uid
            records = self.inventory()
            present = [record[0] for record in records]
            images_gone = not any(same_image(observed, expected) for observed in present for expected in self.c.images)
            self.record("unstage-observation", oldUIDGone=old_gone, expectedImagesAbsent=images_gone)
            if old_gone and images_gone:
                self.record("unstaged")
                return
            if self.clock() >= deadline:
                left = sorted(expected for expected in self.c.images if any(same_image(observed, expected) for observed in present))
                raise RemountError(f"timed out waiting for old UID/RBD unstage; mapped={left}")
            if self.c.poll:
                self.sleep(min(self.c.poll, 5))

    def uncordon(self) -> None:
        _, _, node_name, _, _ = self.target()
        last_error: RemountError | None = None
        for attempt in range(1, MAX_NODE_PATCH_ATTEMPTS + 1):
            node = self.node_json(node_name, "uncordon")
            if not isinstance(node, Mapping):
                raise RemountError("node response is not an object while uncordoning")
            metadata = node.get("metadata", {})
            spec = node.get("spec", {})
            annotations = metadata.get("annotations", {}) if isinstance(metadata, Mapping) else {}
            if not isinstance(metadata, Mapping) or not isinstance(spec, Mapping) or not isinstance(annotations, Mapping):
                raise RemountError("node metadata/spec/annotations are malformed while uncordoning")
            rv = str(metadata.get("resourceVersion", ""))
            if not rv:
                raise RemountError("node has no resourceVersion while uncordoning")
            owner = annotations.get(OWNER_ANNOTATION)
            if owner != self.owner_token:
                if owner:
                    raise RemountError("node ownership token belongs to another operation")
                if self.cordoned or bool(spec.get("unschedulable", False)):
                    raise RemountError("node ownership token is missing; refusing uncordon")
                self.uncordoned = True
                self.record("uncordoned", alreadyClear=True)
                return
            patch: list[dict[str, Any]] = [
                {"op": "test", "path": "/metadata/resourceVersion", "value": rv},
                {"op": "test", "path": OWNER_JSON_PATH, "value": self.owner_token},
            ]
            if bool(spec.get("unschedulable", False)):
                patch.append({"op": "replace", "path": "/spec/unschedulable", "value": False})
            patch.append({"op": "remove", "path": OWNER_JSON_PATH})
            patch_error: RemountError | None = None
            try:
                response = self.json(
                    [
                        "patch",
                        "node",
                        node_name,
                        "-n",
                        self.c.ceph_namespace,
                        "--type=json",
                        "-p",
                        json.dumps(patch, separators=(",", ":")),
                        "-o",
                        "json",
                    ]
                )
                if not isinstance(response, Mapping):
                    raise RemountError("uncordon patch response is not an object")
                response_metadata = response.get("metadata", {})
                response_spec = response.get("spec", {})
                response_annotations = response_metadata.get("annotations", {}) if isinstance(response_metadata, Mapping) else None
                if not isinstance(response_spec, Mapping) or not isinstance(response_annotations, Mapping) or bool(response_spec.get("unschedulable", False)) or OWNER_ANNOTATION in response_annotations:
                    raise RemountError("uncordon patch did not remove ownership and scheduling state")
                self.uncordoned = True
                self.node_rv = str(response.get("metadata", {}).get("resourceVersion", rv))
                self.record("uncordoned", resourceVersion=self.node_rv)
                return
            except RemountError as exc:
                patch_error = exc
            observed = self.node_json(node_name, "uncordon confirmation")
            observed_meta = observed.get("metadata", {}) if isinstance(observed, Mapping) else {}
            observed_spec = observed.get("spec", {}) if isinstance(observed, Mapping) else {}
            observed_annotations = observed_meta.get("annotations", {}) if isinstance(observed_meta, Mapping) else {}
            if isinstance(observed_annotations, Mapping) and OWNER_ANNOTATION not in observed_annotations and not bool(observed_spec.get("unschedulable", False)):
                self.uncordoned = True
                self.record("uncordoned-after-error", attempt=attempt)
                return
            if "conflict" not in str(patch_error).lower() and "test operation" not in str(patch_error).lower():
                raise patch_error
            last_error = patch_error
        raise RemountError(f"node uncordon resourceVersion conflicted after {MAX_NODE_PATCH_ATTEMPTS} attempts: {last_error}")

    def wait_replacement(self) -> None:
        namespace, _, _, uid, _ = self.target()
        if self.controller is None:
            raise RemountError("controller was not captured")
        deadline = self.clock() + self.c.timeout
        while True:
            response = self.json(["get", "pods", "-n", namespace, "-l", self.controller.selector, "-o", "json"])
            for pod in response.get("items", []) if isinstance(response, Mapping) else []:
                if pod.get("metadata", {}).get("uid") == uid or not ready(pod) or pod.get("metadata", {}).get("deletionTimestamp"):
                    continue
                replacement = self.owner_controller(pod)
                if replacement.uid != self.controller.uid:
                    continue
                if claims(pod) != self.claim_set:
                    continue
                replacement_node = pod.get("spec", {}).get("nodeName")
                if not isinstance(replacement_node, str) or not replacement_node:
                    continue
                self.plugin = self.csi_ready(replacement_node)
                self.pod = pod
                self.record("replacement-ready", pod=pod.get("metadata", {}).get("name"), uid=pod.get("metadata", {}).get("uid"), node=replacement_node, csiNodePod=self.plugin.pod)
                return
            if self.clock() >= deadline:
                raise RemountError("timed out waiting for same-controller replacement with same PVCs")
            if self.c.poll:
                self.sleep(min(self.c.poll, 5))

    def verify_mapping(self) -> None:
        records = self.inventory()
        for expected in sorted(self.c.images):
            selected = [record for record in records if same_image(record[0], expected)]
            if not selected or any(record[2] != "csi-rbd-node.3" for record in selected):
                raise RemountError(f"RBD image {expected} is not proven to use csi-rbd-node.3")
        self.record("new-mapping-ready", images=sorted(self.c.images), client="csi-rbd-node.3")

    def postcheck(self) -> None:
        post_volumes = self.rbd_volumes(self.claim_set)
        if post_volumes != self.volumes:
            raise RemountError("PVC/PV identity or RBD image changed during remount")
        self.record("rbd-claims-stable", claims=sorted(self.claim_set), images=sorted(volume.image for volume in post_volumes))
        self.wait_for_quiet_io()
        self.check_ceph_health("postcheck")
        self.functional_checks("postcheck")
        self.record("ceph-postcheck", osds="6/6/6", quorum=3, pg="active+clean")

    def summary(self, outcome: str) -> dict[str, Any]:
        return {"mode": "execute" if self.c.execute else "plan", "outcome": outcome, "target": self.audit["metadata"], "states": [item["name"] for item in self.audit["events"]]}


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--context", required=True)
    p.add_argument("--namespace")
    p.add_argument("--pod")
    p.add_argument("--node")
    p.add_argument("--expected-pod-uid")
    p.add_argument("--expected-rbd-image", action="append", default=[])
    p.add_argument("--expected-fsid")
    p.add_argument("--ceph-namespace", default="rook-ceph")
    p.add_argument("--execute", action="store_true")
    p.add_argument("--timeout-seconds", type=float, default=180.0)
    p.add_argument("--poll-seconds", type=float, default=2.0)
    p.add_argument("--command-timeout-seconds", type=float, default=15.0)
    p.add_argument("--audit-file", "--audit-path", dest="audit_path", type=Path)
    p.add_argument("--allow-bluestore-alert", action="store_true")
    return p


def main(argv: Sequence[str] | None = None) -> int:
    args = parser().parse_args(argv)
    config = Config(
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
    workflow = Workflow(config)
    def handle_sigterm(signum: int, frame: Any) -> None:
        del signum, frame
        raise RemountError("received SIGTERM")

    previous_sigterm = signal.signal(signal.SIGTERM, handle_sigterm)
    try:
        print(json.dumps(workflow.run(), sort_keys=True))
        return 0
    except (RemountError, OSError) as exc:
        try:
            workflow.finish_audit("failed")
        except OSError as audit_error:
            print(f"ceph-csi-remount: audit persistence failed: {audit_error}", file=sys.stderr)
        print(f"ceph-csi-remount: {exc}", file=sys.stderr)
        return 1
    finally:
        signal.signal(signal.SIGTERM, previous_sigterm)


if __name__ == "__main__":
    raise SystemExit(main())
