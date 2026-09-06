import unittest

from podcidr_preflight import evaluate


class PreflightTest(unittest.TestCase):
    def setUp(self):
        self.nodes = [
            {
                "metadata": {"name": name},
                "spec": {"podCIDR": cidr, "podCIDRs": [cidr]},
                "status": {
                    "capacity": {"pods": "250"},
                    "conditions": [{"type": "Ready", "status": "True"}],
                },
            }
            for name, cidr in [
                ("turin", "10.244.0.0/24"),
                ("talos-192-168-1-194", "10.244.3.0/24"),
                ("talos-192-168-1-85", "10.244.5.0/24"),
            ]
        ]
        self.pods = [
            {
                "metadata": {
                    "namespace": "rook-ceph",
                    "name": f"mds-{daemon}",
                    "labels": {
                        "app": "rook-ceph-mds",
                        "rook_file_system": "cephfs",
                        "ceph_daemon_id": f"cephfs-{daemon}",
                    },
                },
                "spec": {"nodeName": node},
                "status": {
                    "phase": "Running",
                    "conditions": [{"type": "Ready", "status": "True"}],
                    "podIPs": [{"ip": address}],
                },
            }
            for daemon, node, address in [
                ("a", "turin", "10.244.0.10"),
                ("b", "talos-192-168-1-85", "10.244.5.10"),
            ]
        ]
        self.ceph = {
            "health": {"status": "HEALTH_OK", "mutes": []},
            "quorum_names": ["i", "n", "o"],
            "osdmap": {
                "num_osds": 6,
                "num_up_osds": 6,
                "num_in_osds": 6,
                "num_remapped_pgs": 0,
            },
            "pgmap": {
                "num_pgs": 10,
                "pgs_by_state": [
                    {"count": 10, "state_name": "active+clean+scrubbing+deep"}
                ],
            },
            "fsmap": {
                "by_rank": [
                    {"name": "cephfs-a", "status": "up:active"},
                    {"name": "cephfs-b", "status": "up:standby-replay"},
                ]
            },
        }

    def result(self, migrated=False):
        return evaluate(self.nodes, self.pods, self.ceph, "turin", migrated)

    def set_cidr(self, index, value):
        self.nodes[index]["spec"].update(podCIDR=value, podCIDRs=[value])

    def test_distinct_parent_blocks_and_scrubbing_are_safe(self):
        self.assertEqual(self.result()["failures"], [])

    def test_disjoint_24s_in_one_23_are_rejected(self):
        self.set_cidr(2, "10.244.1.0/24")
        self.assertTrue(
            any("allocator /23" in failure for failure in self.result()["failures"])
        )

    def test_mixed_masks_cannot_overlap(self):
        self.set_cidr(0, "10.244.2.0/23")
        self.assertTrue(
            any("overlap" in failure for failure in self.result()["failures"])
        )

    def test_acceptance_requires_both_address_space_and_kubelet_limit(self):
        self.assertTrue(self.result(migrated=True)["failures"])
        self.set_cidr(0, "10.244.0.0/23")
        self.assertTrue(self.result(migrated=True)["failures"])
        self.nodes[0]["status"]["capacity"]["pods"] = "500"
        self.assertEqual(self.result(migrated=True)["failures"], [])

    def test_stale_ip_after_new_assignment_is_rejected(self):
        self.set_cidr(0, "10.244.6.0/23")
        self.assertTrue(
            any("outside its node" in failure for failure in self.result()["failures"])
        )

    def test_recovery_and_osd_loss_block_next_host(self):
        self.ceph["osdmap"]["num_up_osds"] = 3
        self.ceph["pgmap"]["pgs_by_state"][0]["state_name"] = (
            "active+undersized+degraded"
        )
        failures = self.result()["failures"]
        self.assertTrue(any("all six" in failure for failure in failures))
        self.assertTrue(any("not fully recovered" in failure for failure in failures))

    def test_missing_pg_evidence_is_not_clean(self):
        self.ceph["pgmap"] = {}
        self.assertTrue(
            any("PG accounting" in failure for failure in self.result()["failures"])
        )

    def test_colocated_or_terminating_mds_blocks_maintenance(self):
        self.pods[1]["spec"]["nodeName"] = "turin"
        self.assertTrue(
            any("separate hosts" in failure for failure in self.result()["failures"])
        )
        self.pods[1]["spec"]["nodeName"] = "talos-192-168-1-85"
        self.pods[1]["metadata"]["deletionTimestamp"] = "2026-09-06T00:00:00Z"
        self.assertTrue(
            any("separate hosts" in failure for failure in self.result()["failures"])
        )

    def test_peer_maintenance_blocks_next_host(self):
        self.nodes[2]["spec"]["taints"] = [
            {"key": "maintenance", "effect": "NoSchedule"}
        ]
        self.assertTrue(
            any("another node" in failure for failure in self.result()["failures"])
        )

    def test_unknown_membership_is_not_accepted(self):
        self.nodes.pop()
        self.assertTrue(
            any("membership" in failure for failure in self.result()["failures"])
        )


if __name__ == "__main__":
    unittest.main()
