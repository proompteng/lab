#!/usr/bin/env python3
"""Exercise NoSchedule ownership and retained-fence failure paths."""

import copy
import importlib.util
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import Mock

spec = importlib.util.spec_from_file_location(
    "taint_remount_tested", Path(__file__).with_name("ceph-csi-taint-remount.py")
)
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)


class NodeAPI:
    def __init__(self):
        self.node = {
            "metadata": {
                "uid": "node-uid",
                "resourceVersion": "1",
                "annotations": {"other": "keep"},
            },
            "spec": {"taints": [{"key": "other", "effect": "NoSchedule"}]},
            "status": {"conditions": [{"type": "Ready", "status": "True"}]},
        }
        self.old_present = True
        self.calls = []
        self.uncertain_once = False

    def __call__(self, argv, body, timeout):
        args = list(argv)[3:]
        self.calls.append((args, body))
        if args[:2] == ["get", "node"]:
            return 0, json.dumps(self.node), ""
        if args[:2] == ["get", "pod"]:
            if self.old_present:
                return 0, json.dumps({"metadata": {"uid": "old-pod"}}), ""
            return 1, "", "Error from server (NotFound): pod not found"
        if args[:2] == ["patch", "node"]:
            ops = json.loads(args[args.index("-p") + 1])
            candidate = copy.deepcopy(self.node)
            for op in ops:
                parts = [
                    p.replace("~1", "/").replace("~0", "~")
                    for p in op["path"].split("/")[1:]
                ]
                parent = candidate
                for key in parts[:-1]:
                    parent = (
                        parent[int(key)] if isinstance(parent, list) else parent[key]
                    )
                key = (
                    int(parts[-1])
                    if isinstance(parent, list) and parts[-1] != "-"
                    else parts[-1]
                )
                if op["op"] == "test":
                    if parent[key] != op["value"]:
                        return 1, "", "Conflict: test operation failed"
                elif op["op"] == "remove":
                    del parent[key]
                elif isinstance(parent, list) and key == "-":
                    parent.append(op["value"])
                else:
                    parent[key] = op["value"]
            if "--dry-run=server" not in args:
                candidate["metadata"]["resourceVersion"] = str(
                    int(self.node["metadata"]["resourceVersion"]) + 1
                )
                self.node = candidate
                if self.uncertain_once:
                    self.uncertain_once = False
                    return 1, "", "lost response after apply"
            return 0, json.dumps(candidate), ""
        if args[:2] == ["create", "--raw"]:
            assert (
                json.loads(body)["deleteOptions"]["preconditions"]["uid"] == "old-pod"
            )
            self.old_present = False
            return 0, "{}", ""
        raise AssertionError(args)


class FenceTests(unittest.TestCase):
    def make(self):
        api = NodeAPI()
        config = module.core.Config(
            context="galactic-lan",
            namespace="restate",
            pod="restate-0",
            node="node",
            uid="old-pod",
            images=frozenset({"image"}),
            fsid="11111111-2222-3333-4444-555555555555",
            execute=True,
            timeout=0.1,
            poll=0,
            audit_path=Path("/tmp/unused-taint-unit-receipt.json"),
        )
        w = module.TaintWorkflow(config, runner=api)
        w.node_uid = "node-uid"
        w.database_guard = Mock()
        w.persist = Mock()
        w.inventory = Mock(return_value=[])
        return w, api

    def test_no_cordon_and_unrelated_state_preserved(self):
        w, api = self.make()
        before = copy.deepcopy(api.node)
        w.cordon()
        self.assertNotIn("unschedulable", api.node["spec"])
        self.assertTrue(w.fence_present(api.node))
        w.uncordon()
        self.assertEqual(api.node["spec"], before["spec"])
        self.assertEqual(
            api.node["metadata"]["annotations"], before["metadata"]["annotations"]
        )

    def test_wait_timeout_retains_mapping_fence(self):
        w, api = self.make()
        w.preflight = Mock()
        w.finish_audit = Mock()
        w.inventory.return_value = [("image", "client1", "csi-rbd-node")]
        w.wait_replacement = Mock()
        with self.assertRaises(module.core.RemountError):
            w.run()
        self.assertFalse(api.old_present)
        self.assertTrue(w.fence_present(api.node))
        self.assertNotIn("unschedulable", api.node["spec"])
        w.wait_replacement.assert_not_called()

    def test_old_uid_alone_retains_fence(self):
        w, api = self.make()
        w.cordon()
        w.eviction_attempted = True
        with self.assertRaises(module.core.RemountError):
            w.uncordon()
        self.assertTrue(w.fence_present(api.node))

    def test_inventory_failure_retains_fence(self):
        w, api = self.make()
        w.cordon()
        w.eviction_attempted = True
        api.old_present = False
        w.inventory.side_effect = module.core.RemountError("CSI unavailable")
        with self.assertRaises(module.core.RemountError):
            w.uncordon()
        self.assertTrue(w.fence_present(api.node))

    def test_release_only_after_both_absent(self):
        w, api = self.make()
        w.cordon()
        w.eviction_attempted = True
        api.old_present = False
        w.uncordon()
        self.assertFalse(w.fence_present(api.node))
        self.assertTrue(w.uncordoned)

    def test_foreign_owner_never_removed(self):
        w, api = self.make()
        w.cordon()
        api.node["metadata"]["annotations"][module.core.OWNER_ANNOTATION] = "foreign"
        calls = len(api.calls)
        with self.assertRaises(module.core.RemountError):
            w.uncordon()
        self.assertFalse(
            any(args[:2] == ["patch", "node"] for args, _ in api.calls[calls:])
        )

    def test_changed_node_uid_blocks_cleanup(self):
        w, api = self.make()
        w.cordon()
        api.node["metadata"]["uid"] = "replacement-node"
        with self.assertRaises(module.core.RemountError):
            w.uncordon()
        self.assertIn(module.core.OWNER_ANNOTATION, api.node["metadata"]["annotations"])

    def test_uncertain_acquire_confirmed_by_readback(self):
        w, api = self.make()
        api.uncertain_once = True
        w.cordon()
        self.assertTrue(w.cordoned)
        self.assertTrue(w.fence_present(api.node))

    def test_toleration_matching(self):
        for t in [
            {"operator": "Exists"},
            {"key": module.TAINT_KEY, "operator": "Exists"},
            {"key": module.TAINT_KEY, "value": "anything"},
        ]:
            self.assertTrue(module.tolerates_fence({"spec": {"tolerations": [t]}}))
        self.assertFalse(
            module.tolerates_fence(
                {
                    "spec": {
                        "tolerations": [{"operator": "Exists", "effect": "NoExecute"}]
                    }
                }
            )
        )

    def test_not_ready_before_fence_refused(self):
        w, api = self.make()
        api.node["status"]["conditions"][0]["status"] = "False"
        with self.assertRaisesRegex(module.core.RemountError, "not Ready"):
            w.cordon()
        self.assertFalse(any(args[0] == "patch" for args, _ in api.calls))

    def test_not_ready_after_database_guard_refuses_eviction(self):
        w, api = self.make()
        w.cordon()

        def fail_node():
            api.node["status"]["conditions"][0]["status"] = "False"

        w.database_guard.side_effect = fail_node
        with self.assertRaisesRegex(module.core.RemountError, "not Ready"):
            w.evict()
        self.assertTrue(api.old_present)
        self.assertFalse(any(args[0] == "create" for args, _ in api.calls))


class RecoveryTests(unittest.TestCase):
    make = FenceTests.make

    def setup_recovery(self, execute=True):
        original, api = self.make()
        original.cordon()
        api.old_present = False
        receipt = copy.deepcopy(original.audit)
        receipt["metadata"].update(
            cnpgPrimaries=[{"name": "db", "uid": "db-uid", "primary": "db-1"}],
            cnpgOperatorConfigurationHash="operator-hash",
            recovery={
                "nodeUid": "node-uid",
                "controller": {
                    "kind": "StatefulSet",
                    "name": "restate",
                    "uid": "controller-uid",
                    "selector": "app=restate",
                },
                "controllerSpecHash": module.digest({"replicas": 3}),
                "volumes": [
                    module.asdict(
                        module.core.Volume("data", "pvc-uid", "pv", "pv-uid", "image")
                    )
                ],
            },
        )
        from dataclasses import replace

        recovery = module.TaintWorkflow(
            replace(original.c, execute=execute), runner=api
        )
        recovery.persist = Mock()
        recovery.finish_audit = Mock()
        recovery.database_guard = Mock()
        recovery.ceph_posture = Mock()
        recovery.functional_checks = Mock()
        recovery.csi_ready = Mock(
            return_value=module.core.CSIPlugin("csi", "csi-rbdplugin")
        )
        recovery.inventory = Mock(return_value=[])
        recovery.rbd_volumes = Mock(
            return_value=(
                module.core.Volume("data", "pvc-uid", "pv", "pv-uid", "image"),
            )
        )
        inherited = recovery.json
        recovery.json = lambda args: (
            {"metadata": {"uid": "controller-uid"}, "spec": {"replicas": 3}}
            if args[1] == "statefulsets"
            else inherited(args)
        )
        return recovery, api, receipt

    def test_recovery_reuses_original_owner_and_never_evicts(self):
        w, api, receipt = self.setup_recovery()
        self.assertNotEqual(w.owner_token, receipt["metadata"]["nodeOwnershipToken"])
        self.assertEqual(w.recover(receipt)["outcome"], "fence-released")
        self.assertEqual(w.owner_token, receipt["metadata"]["nodeOwnershipToken"])
        self.assertNotIn(
            module.core.OWNER_ANNOTATION, api.node["metadata"]["annotations"]
        )
        self.assertFalse(any(args[0] == "create" for args, _ in api.calls))

    def test_recovery_plan_leaves_fence(self):
        w, api, receipt = self.setup_recovery(execute=False)
        calls = len(api.calls)
        self.assertEqual(w.recover(receipt)["outcome"], "planned")
        self.assertTrue(w.fence_present(api.node))
        self.assertFalse(
            any(args[0] in {"patch", "create"} for args, _ in api.calls[calls:])
        )

    def test_recovery_wrong_target_or_owner_refused(self):
        for change in ("context", "nodeOwnershipToken"):
            w, api, receipt = self.setup_recovery()
            receipt["metadata"][change] = "foreign"
            calls = len(api.calls)
            with self.assertRaises(module.core.RemountError):
                w.recover(receipt)
            self.assertFalse(
                any(args[0] in {"patch", "create"} for args, _ in api.calls[calls:])
            )

    def test_recovery_stuck_mapping_or_old_uid_or_failed_csi_keeps_fence(self):
        for problem in ("mapping", "uid", "csi", "volume"):
            w, api, receipt = self.setup_recovery()
            if problem == "mapping":
                w.inventory.return_value = [("image", "client1", "csi-rbd-node")]
            elif problem == "uid":
                api.old_present = True
            elif problem == "volume":
                w.rbd_volumes.return_value = ()
            else:
                w.inventory.side_effect = module.core.RemountError("CSI unavailable")
            with self.assertRaises(module.core.RemountError):
                w.recover(receipt)
            self.assertTrue(w.fence_present(api.node))


class DatabaseGuardTests(unittest.TestCase):
    def make(self):
        w = module.TaintWorkflow(module.core.Config(context="galactic-lan"))
        rows = [
            {
                "metadata": {"namespace": "db" + str(i), "name": "db", "uid": str(i)},
                "spec": {"instances": 3},
                "status": {
                    "currentPrimary": "db-1",
                    "targetPrimary": "db-1",
                    "phase": "Cluster in healthy state",
                    "readyInstances": 3,
                },
            }
            for i in range(12)
        ]
        op = {
            "metadata": {"uid": "operator", "generation": 1},
            "spec": {
                "replicas": 1,
                "template": {
                    "spec": {
                        "containers": [
                            {
                                "name": "manager",
                                "image": "ghcr.io/cloudnative-pg/cloudnative-pg:1.30.0",
                            }
                        ]
                    }
                },
            },
            "status": {
                "observedGeneration": 1,
                "replicas": 1,
                "updatedReplicas": 1,
                "readyReplicas": 1,
                "availableReplicas": 1,
            },
        }
        config = {"metadata": {"uid": "config"}, "data": {}}

        def get(args):
            if args[1] == "clusters.postgresql.cnpg.io":
                return {"items": rows}
            return op if args[1] == "deployment" else config

        w.json = get
        return w, rows, op, config

    def test_primary_change_refused(self):
        w, rows, _, _ = self.make()
        w.database_guard()
        rows[0]["status"].update(currentPrimary="db-2", targetPrimary="db-2")
        with self.assertRaises(module.core.RemountError):
            w.database_guard()

    def test_operator_rollout_refused(self):
        w, _, op, _ = self.make()
        op["status"]["updatedReplicas"] = 0
        with self.assertRaises(module.core.RemountError):
            w.database_guard()

    def test_unverified_operator_refused(self):
        w, _, op, _ = self.make()
        op["spec"]["template"]["spec"]["containers"][0]["image"] = "unknown:latest"
        with self.assertRaises(module.core.RemountError):
            w.database_guard()

    def test_drain_override_refused(self):
        w, _, _, config = self.make()
        config["data"]["DRAIN_TAINTS"] = module.TAINT_KEY
        with self.assertRaises(module.core.RemountError):
            w.database_guard()


if __name__ == "__main__":
    unittest.main()
