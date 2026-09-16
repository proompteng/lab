import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location(
    "keeper_verifier", Path(__file__).with_name("verify-keeper-native-rehearsal.py")
)
VERIFIER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(VERIFIER)


class KeeperVerificationTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        for phase, version in [("v25_12", "25.12.5.44"), ("v26_8", "26.8.2.7")]:
            root = self.root / phase
            root.mkdir()
            for name in ["process-exit", "keeper-exit"]:
                (root / name).write_text("0\n")
            (root / "ruok").write_text("imok\n")
            (root / "mntr.txt").write_text(
                f"zk_version\tv{version}-stable-test\nzk_server_state\tstandalone\nzk_ephemerals_count\t0\nzk_znode_count\t23000\n"
            )
            (root / "conf.txt").write_text("server_id=0\n")
            (root / "canary-value").write_text("native-canary\n")
            for name in [
                "canary-stat",
                "canary-acl",
                "root-stat",
                "clickhouse-root",
                "uuid.sha256",
            ]:
                (root / name).write_text(name + "\n")
            for name in ["all-children", "clickhouse-children"]:
                (root / name).write_text("22999\n")
            for name in ["source-files.sha256", "copied-files.sha256"]:
                (root / name).write_text("retained-native-files\n")
            targets = [
                {
                    "endpoint": f"10.2.0.{i}:2181",
                    "podUID": f"source-{i}",
                    "positiveControl": "PASS",
                }
                for i in range(1, 7)
            ]
            for side, epoch in [("before", 1000), ("after", 1040)]:
                (root / f"runtime-{side}.json").write_text(
                    json.dumps({"epoch": epoch, "targets": targets})
                )
            probes = []
            for target in targets:
                endpoint = target["endpoint"]
                host, port = endpoint.split(":")
                (root / f"probe-{host}-{port}.stderr").write_text(
                    f"bash: line 1: /dev/tcp/{host}/{port}: Connection refused\n"
                )
                probes.append(
                    {
                        "endpoint": endpoint,
                        "exitCode": 1,
                        "outcome": "REJECTED",
                        "elapsedSeconds": 0,
                    }
                )
            (root / "isolation-probes.jsonl").write_text(
                "".join(json.dumps(x) + "\n" for x in probes)
            )

    def test_accepts_native_recovery_and_preserved_persistent_canary(self):
        self.assertEqual(VERIFIER.verify(self.root, "native-canary")["status"], "PASS")

    def test_rejects_changed_persistent_canary(self):
        (self.root / "v26_8/canary-value").write_text("changed\n")
        with self.assertRaisesRegex(RuntimeError, "canary lost"):
            VERIFIER.verify(self.root, "native-canary")

    def test_rejects_changed_source_files(self):
        (self.root / "v25_12/copied-files.sha256").write_text("different\n")
        with self.assertRaisesRegex(RuntimeError, "changed during copy"):
            VERIFIER.verify(self.root, "native-canary")

    def test_rejects_immediate_signal_as_timeout(self):
        path = self.root / "v26_8/isolation-probes.jsonl"
        probes = [json.loads(line) for line in path.read_text().splitlines()]
        probes[0].update(exitCode=143, outcome="TIMED_OUT", elapsedSeconds=0)
        path.write_text("".join(json.dumps(x) + "\n" for x in probes))
        with self.assertRaisesRegex(RuntimeError, "Unclassified native network"):
            VERIFIER.verify(self.root, "native-canary")


if __name__ == "__main__":
    unittest.main()
