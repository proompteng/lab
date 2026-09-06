import copy
import unittest

from podcidr_cleanup import MaintenanceError
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
        for patch, skip, server in ((standalone, True, False), (register, False, True)):
            kubelet = patch["machine"]["kubelet"]
            self.assertIs(kubelet["skipNodeRegistration"], skip)
            self.assertIs(kubelet["extraConfig"]["enableServer"], server)
            self.assertEqual(kubelet["extraConfig"]["maxPods"], 250)
            self.assertEqual(
                kubelet["extraConfig"]["registerWithTaints"][0]["key"], MAINTENANCE_KEY
            )
            self.assertEqual(
                patch["machine"]["nodeTaints"][MAINTENANCE_KEY], "true:NoSchedule"
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


if __name__ == "__main__":
    unittest.main()
