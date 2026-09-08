#!/usr/bin/env python3
"""Focused state-order, identity, and fencing tests for ceph-csi-remount.py."""

from __future__ import annotations

import copy
import importlib.util
import json
import os
import sys
import unittest
from pathlib import Path
from typing import Any, Sequence


SPEC = importlib.util.spec_from_file_location("ceph_csi_remount", Path(__file__).with_name("ceph-csi-remount.py"))
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)

UID = "b6fca716-3445-46be-8a76-57f2d60d9a55"
REPLACEMENT_UID = "dc7b92df-00fd-4aea-a26e-e775608877d7"
PVC_UID = "9b49fd0b-358c-400f-afc6-3da9581c7140"
IMAGE = "csi-vol-92eda432-76fb-416c-a652-a6029ed0d442"
FSID = "11111111-2222-3333-4444-555555555555"
AUDIT = Path(f"/tmp/ceph-csi-remount-test-{os.getpid()}.json")


def output(value: Any, code: int = 0, stderr: str = "") -> tuple[int, str, str]:
    return code, value if isinstance(value, str) else json.dumps(value), stderr


class FakeKubectl:
    """Concrete command fake exercising the Workflow's kubectl boundaries."""

    def __init__(
        self,
        *,
        budget: int | None = 1,
        initial_principal: str = "csi-rbd-node.2",
        mapped_principal: str = "csi-rbd-node.3",
        mapped_after_unstage: bool = False,
        replacement_node: str = "node-85",
        functional_ok: bool = True,
        desired_prior: int = 2,
        actual_prior: int = 2,
        no_pdb: bool = False,
        terminating_consumer: bool = False,
        uncertain_cordon: bool = False,
        image_from_handle: bool = False,
    ) -> None:
        self.calls: list[tuple[tuple[str, ...], str | None]] = []
        self.node_reads = 0
        self.inventory_reads = 0
        self.budget = budget
        self.initial_principal = initial_principal
        self.mapped_principal = mapped_principal
        self.mapped_after_unstage = mapped_after_unstage
        self.replacement_node = replacement_node
        self.functional_ok = functional_ok
        self.desired_prior = desired_prior
        self.actual_prior = actual_prior
        self.no_pdb = no_pdb
        self.terminating_consumer = terminating_consumer
        self.uncertain_cordon = uncertain_cordon
        self.uncertain_cordon_seen = False
        self.image_from_handle = image_from_handle
        self.evicted = False
        self.node_state: dict[str, Any] = {
            "metadata": {"resourceVersion": "10"},
            "spec": {"unschedulable": False},
            "status": {"conditions": [{"type": "Ready", "status": "True"}]},
        }

    def __call__(self, argv: Sequence[str], input_text: str | None, timeout: float) -> tuple[int, str, str]:
        del timeout
        args = tuple(argv)
        self.calls.append((args, input_text))
        if args[:3] != ("kubectl", "--context", "galactic-lan"):
            raise AssertionError(f"missing explicit context: {args!r}")
        command = args[3:]
        if command[:2] == ("get", "node"):
            self.node_reads += 1
            return output(copy.deepcopy(self.node_state))
        if command[:3] == ("get", "pod", "nats-1") and "--all-namespaces" not in command:
            if self.evicted:
                return output("", 1, 'Error from server (NotFound): pods "nats-1" not found')
            return output(self.pod(UID, "node-194"))
        if command[:2] == ("get", "statefulsets"):
            return output(self.controller())
        if command[:2] == ("get", "pdb"):
            return output({"items": [] if self.no_pdb else [self.pdb()]})
        if command[:2] == ("get", "pvc"):
            return output(
                {
                    "metadata": {"uid": PVC_UID},
                    "spec": {"volumeName": "pv-nats-1", "volumeMode": "Filesystem"},
                }
            )
        if command[:2] == ("get", "pv"):
            csi = {
                "driver": MODULE.CSI_RBD_DRIVER,
                "volumeHandle": f"0001-0009-rook-ceph-0000000000000001-{IMAGE.removeprefix('csi-vol-')}",
                "volumeAttributes": {} if self.image_from_handle else {"imageName": IMAGE},
            }
            return output(
                {
                    "metadata": {"name": "pv-nats-1", "uid": "original-pv-uid"},
                    "spec": {
                        "volumeMode": "Filesystem",
                        "claimRef": {"name": "nats-js-nats-1", "namespace": "nats", "uid": PVC_UID},
                        "csi": csi,
                    },
                }
            )
        if command[:3] == ("get", "pods", "--all-namespaces"):
            items = [self.pod(UID, "node-194")]
            if self.terminating_consumer:
                consumer = self.pod("shared-consumer", "node-85")
                consumer["metadata"]["name"] = "shared-consumer"
                consumer["metadata"]["deletionTimestamp"] = "2026-09-08T00:00:00Z"
                items.append(consumer)
            return output({"items": items})
        if command[:2] == ("get", "cephcluster"):
            return output(self.cluster())
        if command[:2] == ("get", "daemonset"):
            return output(self.daemonset())
        if command[:2] == ("get", "pods") and "-l" in command:
            selector = command[command.index("-l") + 1]
            if selector == "app=ceph-csi-node":
                return output({"items": [self.csi_pod("node-194"), self.csi_pod(self.replacement_node)]})
            return output({"items": [self.pod(REPLACEMENT_UID, self.replacement_node)]})
        if command[:2] == ("exec", "-n") and "ceph fsid" in " ".join(command):
            return output(FSID + "\n")
        if command[:2] == ("exec", "-n") and "ceph status -f json" in " ".join(command):
            return output({"health": {"status": "HEALTH_OK"}})
        if command[:2] == ("exec", "-n") and "ceph osd perf -f json" in " ".join(command):
            return output(
                {
                    "pg_ready": True,
                    "osdstats": {
                        "osd_perf_infos": [
                            {"id": index, "perf_stats": {"commit_latency_ms": 26, "apply_latency_ms": 26}}
                            for index in range(6)
                        ]
                    },
                }
            )
        if command[:2] == ("exec", "-n") and "ceph osd stat -f json" in " ".join(command):
            return output({"num_osds": 6, "num_up_osds": 6, "num_in_osds": 6} if self.functional_ok else {"num_osds": 5, "num_up_osds": 6, "num_in_osds": 6})
        if command[:2] == ("exec", "-n") and "ceph quorum_status -f json" in " ".join(command):
            return output({"quorum": [0, 1, 2], "quorum_names": ["a", "b", "c"], "quorum_leader_name": "a", "monmap": {"mons": [{"name": "a"}, {"name": "b"}, {"name": "c"}]}})
        if command[:2] == ("exec", "-n") and "ceph pg stat -f json" in " ".join(command):
            return output({"pg_ready": True, "pg_summary": {"num_pgs": 2, "num_pg_by_state": [{"name": "active+clean", "num": 2}]}})
        if command[:2] == ("exec", "-n"):
            self.inventory_reads += 1
            if self.initial_principal == "csi-rbd-node.3":
                return output(f"{IMAGE}\tclient49743819\tcsi-rbd-node.3\n")
            if self.inventory_reads == 1:
                return output(f"{IMAGE}\tclient49743819\t{self.initial_principal}\n")
            if self.mapped_after_unstage or self.inventory_reads > 2:
                return output(f"{IMAGE}\tclient49743819\t{self.mapped_principal}\n")
            return output("")
        if command[:2] == ("patch", "node"):
            patch = json.loads(command[command.index("-p") + 1])
            self.apply_patch(patch)
            has_owner = any(
                (item.get("path") == MODULE.OWNER_JSON_PATH and item.get("op") == "add")
                or (item.get("path") == "/metadata/annotations" and MODULE.OWNER_ANNOTATION in item.get("value", {}))
                for item in patch
            )
            if has_owner and self.uncertain_cordon and not self.uncertain_cordon_seen:
                self.uncertain_cordon_seen = True
                return output("", 409, "Conflict: simulated uncertain response")
            return output(copy.deepcopy(self.node_state))
        if command[:2] == ("create", "--raw"):
            body = json.loads(input_text or "{}")
            if body.get("apiVersion") != "policy/v1" or body.get("deleteOptions", {}).get("preconditions", {}).get("uid") != UID:
                raise AssertionError(f"unsafe eviction body: {body}")
            self.evicted = True
            return output({})
        raise AssertionError(f"unexpected command: {args!r}")

    def apply_patch(self, patch: list[dict[str, Any]]) -> None:
        current_rv = self.node_state["metadata"]["resourceVersion"]
        if patch[0] != {"op": "test", "path": "/metadata/resourceVersion", "value": current_rv}:
            raise AssertionError(f"missing atomic resourceVersion test: {patch!r}")
        for operation in patch[1:]:
            path = operation["path"]
            if operation["op"] == "test":
                if path != MODULE.OWNER_JSON_PATH or self.node_state["metadata"].get("annotations", {}).get(MODULE.OWNER_ANNOTATION) != operation["value"]:
                    raise AssertionError(f"missing ownership test: {patch!r}")
            elif path == "/metadata/annotations":
                self.node_state["metadata"]["annotations"] = copy.deepcopy(operation["value"])
            elif path == MODULE.OWNER_JSON_PATH and operation["op"] == "add":
                self.node_state["metadata"].setdefault("annotations", {})[MODULE.OWNER_ANNOTATION] = operation["value"]
            elif path == MODULE.OWNER_JSON_PATH and operation["op"] == "remove":
                self.node_state["metadata"].setdefault("annotations", {}).pop(MODULE.OWNER_ANNOTATION, None)
            elif path == "/spec/unschedulable":
                self.node_state["spec"]["unschedulable"] = operation["value"]
            else:
                raise AssertionError(f"unexpected patch operation: {operation!r}")
        self.node_state["metadata"]["resourceVersion"] = str(int(current_rv) + 1)

    @staticmethod
    def pod(uid: str, node: str) -> dict[str, Any]:
        return {
            "metadata": {
                "name": "nats-1",
                "namespace": "nats",
                "uid": uid,
                "labels": {"app": "nats"},
                "ownerReferences": [{"kind": "StatefulSet", "name": "nats", "uid": "controller", "controller": True}],
            },
            "spec": {"nodeName": node, "volumes": [{"persistentVolumeClaim": {"claimName": "nats-js-nats-1"}}]},
            "status": {"phase": "Running", "conditions": [{"type": "Ready", "status": "True"}]},
        }

    @staticmethod
    def controller() -> dict[str, Any]:
        return {"metadata": {"uid": "controller"}, "spec": {"replicas": 3, "selector": {"matchLabels": {"app": "nats"}}}}

    def pdb(self) -> dict[str, Any]:
        return {"metadata": {"name": "nats"}, "spec": {"selector": {"matchLabels": {"app": "nats"}}}, "status": {"disruptionsAllowed": self.budget}}

    def cluster(self) -> dict[str, Any]:
        desired = {"keyGeneration": 3, "keyType": "aes256k", "keepPriorKeyCountMax": self.desired_prior}
        actual = {"keyGeneration": 3, "keyType": "aes256k", "priorKeyCount": self.actual_prior}
        return {"spec": {"security": {"cephx": {"csi": desired}}}, "status": {"phase": "Ready", "cephx": {"csi": actual}}}

    @staticmethod
    def daemonset() -> dict[str, Any]:
        return {"spec": {"selector": {"matchLabels": {"app": "ceph-csi-node"}}}, "status": {field: 3 for field in ("desiredNumberScheduled", "currentNumberScheduled", "updatedNumberScheduled", "numberAvailable", "numberReady")}}

    @staticmethod
    def csi_pod(node: str) -> dict[str, Any]:
        return {"metadata": {"name": f"rbd-{node}"}, "spec": {"nodeName": node, "containers": [{"name": "csi-rbdplugin"}]}, "status": {"phase": "Running", "conditions": [{"type": "Ready", "status": "True"}]}}


def config(**kwargs: Any) -> MODULE.Config:
    values = {
        "context": "galactic-lan",
        "namespace": "nats",
        "pod": "nats-1",
        "node": "node-194",
        "uid": UID,
        "images": frozenset({IMAGE}),
        "fsid": FSID,
        "execute": True,
        "timeout": 5.0,
        "poll": 0.0,
        "audit_path": AUDIT,
    }
    values.update(kwargs)
    return MODULE.Config(**values)


class RemountTests(unittest.TestCase):
    def tearDown(self) -> None:
        AUDIT.unlink(missing_ok=True)

    def test_latency_spike_resets_consecutive_quiet_samples(self) -> None:
        samples = iter([20, 30, 90, 15, 25, 35])
        now = [0.0]

        def runner(argv, input_text, timeout):
            value = next(samples)
            return output({"osdstats": {"osd_perf_infos": [
                {"id": index, "perf_stats": {"commit_latency_ms": value, "apply_latency_ms": value}}
                for index in range(6)
            ]}})

        workflow = MODULE.Workflow(config(timeout=10), runner, clock=lambda: now[0], sleep=lambda _: now.__setitem__(0, now[0] + 1))
        workflow.wait_for_quiet_io()
        self.assertEqual(now[0], 5)
        self.assertEqual(workflow.audit["events"][-1]["name"], "osd-quiet-window")
        self.assertEqual(sum(event["name"] == "osd-latency-above-limit" for event in workflow.audit["events"]), 1)

    def test_sustained_high_latency_never_admits_maintenance(self) -> None:
        now = [0.0]
        perf = {"osdstats": {"osd_perf_infos": [
            {"id": index, "perf_stats": {"commit_latency_ms": 90, "apply_latency_ms": 90}}
            for index in range(6)
        ]}}
        workflow = MODULE.Workflow(config(timeout=3), lambda *_: output(perf), clock=lambda: now[0], sleep=lambda _: now.__setitem__(0, now[0] + 1))
        with self.assertRaisesRegex(MODULE.RemountError, "three consecutive samples"):
            workflow.wait_for_quiet_io()
        self.assertFalse(any(event["name"] == "osd-quiet-window" for event in workflow.audit["events"]))

    def test_empty_pdb_selector_matches_all_but_absent_selector_matches_none(self) -> None:
        labels = {"app": "nats"}
        self.assertTrue(MODULE.match_selector({}, labels))
        self.assertFalse(MODULE.match_selector(None, labels))

    def test_recreated_claim_and_pv_with_same_names_fail_postcheck(self) -> None:
        class RecreatedClaims(FakeKubectl):
            def __call__(self, argv, input_text, timeout):
                result = super().__call__(argv, input_text, timeout)
                if self.evicted and tuple(argv[3:5]) in {("get", "pvc"), ("get", "pv")}:
                    payload = json.loads(result[1])
                    payload["metadata"]["uid"] = "replacement-uid"
                    if argv[4] == "pv":
                        payload["spec"]["claimRef"]["uid"] = "replacement-uid"
                    return output(payload)
                return result

        runner = RecreatedClaims()
        with self.assertRaisesRegex(MODULE.RemountError, "PVC/PV identity"):
            MODULE.Workflow(config(), runner).run()
        self.assertFalse(runner.node_state["spec"]["unschedulable"])

    def test_success_allows_cross_node_replacement_and_updates_plugin(self) -> None:
        runner = FakeKubectl()
        workflow = MODULE.Workflow(config(), runner)
        self.assertEqual(workflow.run()["outcome"], "complete")
        self.assertEqual(workflow.plugin, MODULE.CSIPlugin("rbd-node-85", "csi-rbdplugin"))
        replacement = next(item for item in workflow.audit["events"] if item["name"] == "replacement-ready")
        self.assertEqual(replacement["node"], "node-85")
        self.assertFalse(runner.node_state["spec"]["unschedulable"])
        self.assertNotIn(MODULE.OWNER_ANNOTATION, runner.node_state["metadata"].get("annotations", {}))
        names = [item["name"] for item in workflow.audit["events"]]
        order = ["cordoned", "evicted", "unstaged", "uncordoned", "replacement-ready", "new-mapping-ready", "ceph-postcheck", "complete"]
        self.assertEqual([names.index(item) for item in order], sorted(names.index(item) for item in order))
        patches = [args for args, _ in runner.calls if args[3:5] == ("patch", "node")]
        self.assertEqual(len(patches), 2)
        for patch_args in patches:
            patch = json.loads(patch_args[patch_args.index("-p") + 1])
            self.assertEqual(patch[0]["path"], "/metadata/resourceVersion")
        self.assertTrue(any(item["op"] == "test" and item["path"] == MODULE.OWNER_JSON_PATH for item in json.loads(patches[1][patches[1].index("-p") + 1])))

    def test_unstage_timeout_uncordons_owned_node(self) -> None:
        runner = FakeKubectl(mapped_after_unstage=True)
        with self.assertRaises(MODULE.RemountError):
            MODULE.Workflow(config(timeout=0.001), runner).run()
        patches = [args for args, _ in runner.calls if args[3:5] == ("patch", "node")]
        self.assertEqual(len(patches), 2)
        self.assertFalse(runner.node_state["spec"]["unschedulable"])

    def test_uncertain_cordon_response_is_cleaned_by_token(self) -> None:
        runner = FakeKubectl(uncertain_cordon=True)
        workflow = MODULE.Workflow(config(), runner)
        self.assertEqual(workflow.run()["outcome"], "complete")
        self.assertFalse(runner.node_state["spec"]["unschedulable"])
        self.assertNotIn(MODULE.OWNER_ANNOTATION, runner.node_state["metadata"].get("annotations", {}))
        self.assertTrue(any(item["name"] == "cordon-confirmed-after-error" for item in workflow.audit["events"]))

    def test_exact_principal_rejects_dot_thirty(self) -> None:
        runner = FakeKubectl(mapped_principal="csi-rbd-node.30")
        workflow = MODULE.Workflow(config(), runner)
        with self.assertRaises(MODULE.RemountError):
            workflow.run()
        self.assertNotIn("new-mapping-ready", [item["name"] for item in workflow.audit["events"]])
        self.assertFalse(runner.node_state["spec"]["unschedulable"])

    def test_uid_pdb_and_terminating_consumer_fences_prevent_writes(self) -> None:
        cases = [config(uid="wrong"), config(), config()]
        runners = [FakeKubectl(), FakeKubectl(budget=0), FakeKubectl(terminating_consumer=True)]
        for values, runner in zip(cases, runners, strict=True):
            with self.assertRaises(MODULE.RemountError):
                MODULE.Workflow(values, runner).run()
            self.assertFalse(any(args[3] in {"patch", "create"} for args, _ in runner.calls))

    def test_preflight_functional_failure_and_zero_actual_retention_prevent_eviction(self) -> None:
        for runner in (FakeKubectl(functional_ok=False), FakeKubectl(actual_prior=0)):
            with self.assertRaises(MODULE.RemountError):
                MODULE.Workflow(config(), runner).run()
            self.assertFalse(any(args[3] in {"patch", "create"} for args, _ in runner.calls))

    def test_single_statefulset_without_pdb_is_allowed(self) -> None:
        self.assertEqual(MODULE.Workflow(config(), FakeKubectl(no_pdb=True)).run()["outcome"], "complete")

    def test_volume_handle_uuid_is_used_when_image_name_absent(self) -> None:
        self.assertEqual(MODULE.Workflow(config(), FakeKubectl(image_from_handle=True)).run()["outcome"], "complete")

    def test_already_gen3_mapping_is_complete_without_eviction(self) -> None:
        runner = FakeKubectl(initial_principal="csi-rbd-node.3")
        workflow = MODULE.Workflow(config(), runner)
        self.assertEqual(workflow.run()["outcome"], "complete")
        self.assertFalse(any(args[3] in {"patch", "create"} for args, _ in runner.calls))

    def test_unknown_principal_is_rejected_before_eviction(self) -> None:
        runner = FakeKubectl(initial_principal="csi-rbd-node.4")
        with self.assertRaises(MODULE.RemountError):
            MODULE.Workflow(config(), runner).run()
        self.assertFalse(any(args[3] in {"patch", "create"} for args, _ in runner.calls))

    def test_incomplete_plan_has_no_cluster_calls(self) -> None:
        runner = FakeKubectl()
        result = MODULE.Workflow(MODULE.Config(context="galactic-lan"), runner).run()
        self.assertEqual(result["outcome"], "planned")
        self.assertEqual(runner.calls, [])


if __name__ == "__main__":
    unittest.main()
