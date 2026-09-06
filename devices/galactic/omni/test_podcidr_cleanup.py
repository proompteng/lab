import copy
from contextlib import redirect_stdout
import io
import ipaddress
import json
from pathlib import Path
import tempfile
import subprocess
import unittest
from unittest.mock import patch

import podcidr_cleanup as maintenance


PLAN = {
    "operation": "test-turin",
    "nodeName": "turin",
    "bootID": "00000000-0000-4000-8000-000000000001",
    "oldCIDR": "10.244.0.0/24",
    "daemonPodUIDs": ["00000000-0000-4000-8000-000000000002"],
}


class CleanupTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        for relative, content in {
            "etc/hostname": "turin\n",
            "proc/sys/kernel/random/boot_id": PLAN["bootID"],
            "var/lib/cni/networks/cbr0/10.244.0.9": "old-sandbox-id",
            "var/lib/cni/networks/cbr0/last_reserved_ip.0": "10.244.0.9",
            "run/flannel/subnet.env": "FLANNEL_SUBNET=10.244.0.1/24\nFLANNEL_MTU=1400\n",
        }.items():
            path = self.root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content)
        self.lease_dir = self.root / "var/lib/cni/networks/cbr0"
        self.state = self.root / "var/lib/podcidr23-ops/test-turin"
        self.standalone = patch.object(
            maintenance, "standalone", return_value=True
        ).start()
        self.sandboxes = patch.object(maintenance, "sandboxes", return_value=[]).start()
        self.cri = patch.object(maintenance, "cri").start()
        self.run = patch.object(maintenance, "run", return_value="[]").start()
        self.addCleanup(patch.stopall)

    def cleanup(self, **kwargs):
        return maintenance.cleanup(copy.deepcopy(PLAN), self.root, **kwargs)

    def test_success_archives_only_network_state_and_repeated_run_is_noop(self):
        data = self.root / "var/lib/rook/retained-data"
        data.parent.mkdir(parents=True)
        data.write_bytes(b"preserve application data")
        result = self.cleanup()
        self.assertEqual(result["phase"], "complete")
        self.assertEqual(result["leasesArchived"], ["10.244.0.9", "last_reserved_ip.0"])
        self.assertEqual(
            (self.state / "leases/10.244.0.9").read_text(), "old-sandbox-id"
        )
        self.assertEqual(data.read_bytes(), b"preserve application data")
        self.assertFalse((self.root / "run/flannel/subnet.env").exists())
        calls = self.sandboxes.call_count
        self.assertEqual(self.cleanup(), result)
        self.assertEqual(self.sandboxes.call_count, calls)
        self.assertEqual((self.state / "result.json").stat().st_mode & 0o777, 0o600)

    def test_wrong_host_or_reboot_prevents_any_runtime_action(self):
        for relative in ("etc/hostname", "proc/sys/kernel/random/boot_id"):
            with self.subTest(relative=relative):
                path = self.root / relative
                previous = path.read_text()
                path.write_text("different")
                with self.assertRaises(maintenance.MaintenanceError):
                    self.cleanup()
                path.write_text(previous)
        self.sandboxes.assert_not_called()
        self.assertTrue((self.lease_dir / "10.244.0.9").exists())

    def test_unknown_running_pod_stops_cleanup_before_any_mutation(self):
        self.sandboxes.return_value = [
            (
                "sandbox",
                {"state": "SANDBOX_READY", "metadata": {"uid": "not-approved"}},
                "POD",
            )
        ]
        result = self.cleanup()
        self.assertEqual(result["phase"], "failed")
        self.assertIn("undrained pod", result["error"])
        self.cri.assert_not_called()
        self.run.assert_not_called()
        self.assertTrue((self.lease_dir / "10.244.0.9").exists())

    def test_daemon_that_survives_removal_prevents_network_cleanup(self):
        self.sandboxes.return_value = [
            (
                "daemon",
                {
                    "state": "SANDBOX_READY",
                    "metadata": {"uid": PLAN["daemonPodUIDs"][0]},
                },
                "POD",
            )
        ]
        result = self.cleanup()
        self.assertEqual(result["phase"], "failed")
        self.cri.assert_any_call("stopp", "daemon")
        self.cri.assert_any_call("rmp", "daemon")
        self.run.assert_not_called()
        self.assertTrue((self.lease_dir / "10.244.0.9").exists())

    def test_foreign_lease_prevents_archiving_valid_leases(self):
        (self.lease_dir / "10.244.1.2").write_text("other-subnet-owner")
        result = self.cleanup()
        self.assertEqual(result["phase"], "failed")
        self.assertIn("outside old subnet", result["error"])
        self.assertTrue((self.lease_dir / "10.244.0.9").exists())
        self.run.assert_not_called()

    def test_symlink_lock_is_rejected(self):
        (self.lease_dir / "lock").symlink_to(self.root / "unrelated")
        result = self.cleanup()
        self.assertEqual(result["phase"], "failed")
        self.assertFalse((self.root / "unrelated").exists())
        self.assertTrue((self.lease_dir / "10.244.0.9").exists())

    def test_live_bridge_ports_prevent_lease_or_link_removal(self):
        self.run.side_effect = [
            json.dumps([{"ifname": "cni0", "linkinfo": {"info_kind": "bridge"}}]),
            json.dumps(
                [
                    {
                        "addr_info": [
                            {"family": "inet", "local": "10.244.0.1", "prefixlen": 24}
                        ]
                    }
                ]
            ),
            '[{"ifname":"veth-owned"}]',
        ]
        with patch.object(maintenance.time, "monotonic", side_effect=[0, 0, 121]):
            result = self.cleanup()
        self.assertEqual(result["phase"], "failed")
        self.assertIn("live ports", result["error"])
        self.assertTrue((self.lease_dir / "10.244.0.9").exists())
        self.assertFalse(any("delete" in call.args for call in self.run.call_args_list))

    def test_async_bridge_detach_finishes_before_network_cleanup(self):
        self.run.side_effect = [
            json.dumps([{"ifname": "cni0", "linkinfo": {"info_kind": "bridge"}}]),
            json.dumps(
                [
                    {
                        "addr_info": [
                            {"family": "inet", "local": "10.244.0.1", "prefixlen": 24}
                        ]
                    }
                ]
            ),
            '[{"ifname":"veth-detaching"}]',
            "[]",
            "",
        ]
        with patch.object(maintenance.time, "sleep") as sleep:
            result = self.cleanup()
        self.assertEqual(result["phase"], "complete")
        sleep.assert_called_once_with(2)
        self.assertEqual(result["linksRemoved"], ["cni0"])

    def test_foreign_subnet_file_prevents_lease_removal(self):
        (self.root / "run/flannel/subnet.env").write_text(
            "FLANNEL_SUBNET=10.244.2.1/24\n"
        )
        result = self.cleanup()
        self.assertEqual(result["phase"], "failed")
        self.assertIn("differs from plan", result["error"])
        self.assertTrue((self.lease_dir / "10.244.0.9").exists())

    def test_partial_operation_requires_explicit_retry(self):
        lease = self.lease_dir / "10.244.1.2"
        lease.write_text("unexpected")
        self.assertEqual(self.cleanup()["phase"], "failed")
        lease.unlink()
        with self.assertRaisesRegex(
            maintenance.MaintenanceError, "explicit --retry-failed"
        ):
            self.cleanup()
        self.assertEqual(self.cleanup(retry_failed=True)["phase"], "complete")

    def test_operation_cannot_be_reused_with_different_plan(self):
        self.cleanup()
        different = copy.deepcopy(PLAN)
        different["oldCIDR"] = "10.244.0.0/23"
        with self.assertRaisesRegex(maintenance.MaintenanceError, "another plan"):
            maintenance.cleanup(different, self.root)

    def test_failed_command_preserves_diagnostics_in_private_report(self):
        self.run.side_effect = subprocess.CalledProcessError(
            1,
            ["ip", "link"],
            output="partial runtime output",
            stderr="device is still owned",
        )
        result = self.cleanup()
        self.assertEqual(result["phase"], "failed")
        saved = json.loads((self.state / "result.json").read_text())
        self.assertEqual(saved["commandFailure"]["exitCode"], 1)
        self.assertEqual(saved["commandFailure"]["stdout"], "partial runtime output")
        self.assertEqual(saved["commandFailure"]["stderr"], "device is still owned")
        self.assertEqual((self.state / "result.json").stat().st_mode & 0o777, 0o600)

    def test_timeout_preserves_byte_diagnostics(self):
        self.run.side_effect = subprocess.TimeoutExpired(
            ["crictl", "inspectp"],
            60,
            output=b"partial reply",
            stderr=b"runtime did not respond",
        )
        result = self.cleanup()
        self.assertEqual(result["commandFailure"]["timeoutSeconds"], 60)
        self.assertEqual(result["commandFailure"]["stdout"], "partial reply")
        self.assertEqual(result["commandFailure"]["stderr"], "runtime did not respond")

    def test_static_pod_log_omits_private_command_output(self):
        plan_path = self.root / "plan.json"
        plan_path.write_text(json.dumps(PLAN))
        report = {
            **PLAN,
            "phase": "failed",
            "commandFailure": {"stderr": "private diagnostic"},
        }
        output = io.StringIO()
        with (
            patch("sys.argv", ["podcidr_cleanup.py", "--plan", str(plan_path)]),
            patch.object(maintenance, "cleanup", return_value=report),
            redirect_stdout(output),
        ):
            self.assertEqual(maintenance.main(), 1)
        self.assertEqual(json.loads(output.getvalue())["phase"], "failed")
        self.assertNotIn("private diagnostic", output.getvalue())

    def test_plan_limits_network_and_operation_paths(self):
        for key, value in (
            ("operation", "../../outside"),
            ("oldCIDR", "192.168.0.0/24"),
            ("oldCIDR", "10.244.0.0/22"),
            ("oldCIDR", "10.244.0.1/24"),
            ("daemonPodUIDs", []),
            ("daemonPodUIDs", PLAN["daemonPodUIDs"] * 2),
        ):
            with self.subTest(key=key, value=value):
                invalid = copy.deepcopy(PLAN)
                invalid[key] = value
                with self.assertRaises((ValueError, maintenance.MaintenanceError)):
                    maintenance.validate_plan(invalid)
        rollback = copy.deepcopy(PLAN)
        rollback["oldCIDR"] = "10.244.0.0/23"
        self.assertEqual(
            maintenance.validate_plan(rollback), ipaddress.ip_network("10.244.0.0/23")
        )


if __name__ == "__main__":
    unittest.main()
