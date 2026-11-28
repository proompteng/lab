import contextlib
import io
import json
import unittest
from unittest.mock import patch

from podcidr_preflight import evaluate, main


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

    def result(self, **kwargs):
        return evaluate(self.nodes, self.pods, self.ceph, "turin", **kwargs)

    def set_cidr(self, index, value):
        self.nodes[index]["spec"].update(podCIDR=value, podCIDRs=[value])

    def set_slash22_topology(self):
        self.set_cidr(0, "10.244.8.0/22")
        self.set_cidr(2, "10.244.4.0/23")
        self.pods[0]["status"]["podIPs"][0]["ip"] = "10.244.11.10"
        for node in self.nodes[1:]:
            node["status"]["capacity"]["pods"] = "500"

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

    def test_slash22_acceptance_requires_both_address_space_and_kubelet_limit(self):
        self.set_slash22_topology()
        self.nodes[0]["status"]["capacity"]["pods"] = "500"
        options = {"migrated": True, "allocator_prefix": 22}
        self.assertEqual(
            self.result(**options)["failures"],
            ["turin: expected maxPods 1000, found 500"],
        )
        self.nodes[0]["status"]["capacity"]["pods"] = "1000"
        report = self.result(**options)
        self.assertEqual(report["failures"], [])
        self.assertEqual(report["nodes"]["turin"]["podIPs"], 1)
        self.assertEqual(
            report["warnings"],
            ["talos-192-168-1-194: maxPods 500 exceeds CNI address capacity"],
        )

        self.set_cidr(0, "10.244.10.0/23")
        self.assertIn(
            "turin: migrated node must have a /22 PodCIDR",
            self.result(**options)["failures"],
        )

    def test_slash22_rollback_preparation_requires_250_pods(self):
        self.set_slash22_topology()
        self.assertEqual(self.result(allocator_prefix=22)["failures"], [])
        self.nodes[0]["status"]["capacity"]["pods"] = "1000"
        self.assertEqual(
            self.result(allocator_prefix=22)["failures"],
            ["turin: expected maxPods 250, found 1000"],
        )

    def test_narrower_nonoverlapping_cidrs_cannot_share_one_slash22_block(self):
        self.set_cidr(0, "10.244.0.0/23")
        self.set_cidr(2, "10.244.4.0/23")
        self.assertEqual(self.result()["failures"], [])
        failures = self.result(allocator_prefix=22)["failures"]
        self.assertEqual(len(failures), 1)
        self.assertIn("allocator /22", failures[0])

    def test_slash22_reserves_both_halves_under_a_slash23_allocator(self):
        self.set_slash22_topology()
        self.set_cidr(2, "10.244.10.0/23")
        self.pods[1]["status"]["podIPs"][0]["ip"] = "10.244.10.10"
        failures = self.result()["failures"]
        self.assertEqual(len(failures), 1)
        self.assertIn("allocator /23", failures[0])

    def test_unsupported_prefix_and_out_of_cluster_slash22_fail(self):
        for cidr, diagnostic in (
            ("10.244.8.0/21", "unexpected prefix /21"),
            ("10.244.8.0/25", "unexpected prefix /25"),
            ("10.245.8.0/22", "PodCIDR is outside 10.244.0.0/16"),
            ("fd00::/22", "PodCIDR is outside 10.244.0.0/16"),
        ):
            with self.subTest(cidr=cidr):
                self.set_cidr(0, cidr)
                self.assertIn(f"turin: {diagnostic}", self.result()["failures"])

    def test_slash22_migrated_cli(self):
        self.set_slash22_topology()
        self.nodes[0]["status"]["capacity"]["pods"] = "1000"
        arguments = [
            "podcidr_preflight.py",
            "--node",
            "turin",
            "--migrated",
            "--allocator-prefix",
            "22",
        ]
        stdout = io.StringIO()
        with (
            patch("sys.argv", arguments),
            patch(
                "podcidr_preflight.kubectl",
                side_effect=[{"items": self.nodes}, {"items": self.pods}, self.ceph],
            ),
            contextlib.redirect_stdout(stdout),
            self.assertRaises(SystemExit) as result,
        ):
            main()
        self.assertEqual(result.exception.code, 0)
        self.assertEqual(
            json.loads(stdout.getvalue())["nodes"]["turin"]["maxPods"], 1000
        )

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

    def test_missing_kubectl_is_unavailable_evidence(self):
        stderr = io.StringIO()
        with (
            patch("sys.argv", ["podcidr_preflight.py", "--node", "turin"]),
            patch(
                "podcidr_preflight.subprocess.run",
                side_effect=FileNotFoundError("kubectl"),
            ),
            contextlib.redirect_stderr(stderr),
            self.assertRaises(SystemExit) as result,
        ):
            main()
        self.assertEqual(result.exception.code, 2)
        self.assertIn("could not establish live evidence", stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
