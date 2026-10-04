import copy
from contextlib import redirect_stdout
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from podcidr_cleanup import MaintenanceError
import podcidr_patch as renderer
from podcidr_patch import MAINTENANCE_KEY, make_patches, make_plan, omni_resource


class PatchTests(unittest.TestCase):
    def setUp(self):
        self.node = {
            "metadata": {"name": "turin"},
            "spec": {"unschedulable": True, "podCIDR": "10.244.0.0/24"},
            "status": {
                "capacity": {"pods": "250"},
                "nodeInfo": {"bootID": "00000000-0000-4000-8000-000000000001"},
                "conditions": [{"type": "Ready", "status": "True"}],
            },
        }
        self.pods = {
            "items": [
                {
                    "metadata": {
                        "name": "kube-flannel-example",
                        "namespace": "kube-system",
                        "uid": "00000000-0000-4000-8000-000000000002",
                        "ownerReferences": [{"kind": "DaemonSet", "controller": True}],
                    },
                    "spec": {"nodeName": "turin", "hostNetwork": True},
                    "status": {"phase": "Running"},
                }
            ]
        }

    def test_standalone_and_registration_keep_api_and_taint_settings_atomic(self):
        plan, daemons = make_plan(self.node, self.pods, "test-turin")
        self.assertEqual(plan["daemonPodUIDs"], [daemons[0]["uid"]])
        standalone, register = make_patches(plan, "print('reviewed helper')")
        for configuration, skip, server in (
            (standalone, True, False),
            (register, False, True),
        ):
            kubelet = configuration["machine"]["kubelet"]
            self.assertIs(kubelet["skipNodeRegistration"], skip)
            self.assertIs(kubelet["extraConfig"]["enableServer"], server)
            self.assertEqual(kubelet["extraConfig"]["maxPods"], 250)
            self.assertEqual(
                kubelet["extraConfig"]["registerWithTaints"][0]["key"], MAINTENANCE_KEY
            )
            self.assertEqual(
                configuration["machine"]["nodeTaints"][MAINTENANCE_KEY],
                "true:NoSchedule",
            )
        self.assertEqual(standalone["machine"]["pods"], register["machine"]["pods"])

    def test_undrained_workload_rejects_patch(self):
        del self.pods["items"][0]["metadata"]["ownerReferences"]
        with self.assertRaisesRegex(MaintenanceError, "not drained"):
            make_plan(self.node, self.pods, "test")

    def test_pending_workload_also_rejects_patch(self):
        workload = copy.deepcopy(self.pods["items"][0])
        workload["metadata"]["name"] = "pending-app"
        workload["metadata"]["ownerReferences"] = [
            {"kind": "ReplicaSet", "controller": True}
        ]
        workload["status"]["phase"] = "Pending"
        self.pods["items"].append(workload)
        with self.assertRaisesRegex(MaintenanceError, "not drained"):
            make_plan(self.node, self.pods, "test")

    def test_peer_pod_snapshot_is_rejected(self):
        self.pods["items"][0]["spec"]["nodeName"] = "peer"
        with self.assertRaisesRegex(MaintenanceError, "another node"):
            make_plan(self.node, self.pods, "test")

    def test_cap_and_cordon_are_required(self):
        for cap, cordon in (("500", True), ("250", False)):
            with self.subTest(cap=cap, cordon=cordon):
                self.node["status"]["capacity"]["pods"] = cap
                self.node["spec"]["unschedulable"] = cordon
                with self.assertRaises(MaintenanceError):
                    make_plan(self.node, self.pods, "test")

    def test_unknown_node_cannot_receive_production_omni_patch(self):
        with self.assertRaisesRegex(MaintenanceError, "only Turin and Altra"):
            omni_resource("talos-192-168-1-194", {})
        labels = omni_resource("turin", {})["metadata"]["labels"]
        self.assertEqual(labels["omni.sidero.dev/cluster"], "galactic")
        self.assertEqual(
            labels["omni.sidero.dev/cluster-machine"],
            "8bf7ec00-171c-11f1-8000-7cc255f16774",
        )

    def test_renderer_emits_explicit_retry_for_same_operation_and_resource(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "node.json").write_text(json.dumps(self.node))
            (root / "pods.json").write_text(json.dumps(self.pods))
            arguments = [
                "podcidr_patch.py",
                "--node-json",
                str(root / "node.json"),
                "--pods-json",
                str(root / "pods.json"),
                "--operation",
                "test-turin",
                "--output-dir",
                str(root / "output"),
            ]
            with patch("sys.argv", arguments), redirect_stdout(io.StringIO()):
                renderer.main()
            normal = json.loads((root / "output/standalone-omni.yaml").read_text())
            retry = json.loads((root / "output/retry-omni.yaml").read_text())
            register = json.loads((root / "output/register-omni.yaml").read_text())
            self.assertEqual(normal["metadata"], retry["metadata"])
            for resource, expected_retry in (
                (normal, False),
                (retry, True),
                (register, False),
            ):
                machine = json.loads(resource["spec"]["data"])["machine"]
                command = machine["pods"][0]["spec"]["containers"][0]["command"][2]
                self.assertEqual(
                    "--retry-failed" in command.splitlines()[-1], expected_retry
                )
                self.assertEqual(
                    len(machine["kubelet"]["extraConfig"]["registerWithTaints"]), 1
                )
            normal_machine = json.loads(normal["spec"]["data"])["machine"]
            retry_machine = json.loads(retry["spec"]["data"])["machine"]
            self.assertEqual(normal_machine["kubelet"], retry_machine["kubelet"])
            self.assertEqual(normal_machine["nodeTaints"], retry_machine["nodeTaints"])


if __name__ == "__main__":
    unittest.main()
