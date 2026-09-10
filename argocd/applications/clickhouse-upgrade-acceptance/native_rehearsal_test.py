import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


SPEC = importlib.util.spec_from_file_location(
    "native_verifier", Path(__file__).with_name("verify-clickhouse-native-rehearsal.py")
)
VERIFIER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(VERIFIER)


class NativeRehearsalVerificationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.endpoints = [f"10.1.0.{i}:9000" for i in range(1, 6)]
        self.tables = [
            {
                "database": "signal",
                "name": f"table_{i:02d}",
                "engine": "ReplicatedMergeTree" if i < 11 else "MergeTree",
                "engine_full": "PARTITION BY date ORDER BY key",
                "uuid": f"source-{i}",
            }
            for i in range(26)
        ]
        self.expected = "".join(
            "\t".join(t[k] for k in ["database", "name", "engine"]) + "\n"
            for t in self.tables
        )
        for phase, version in VERIFIER.VERSIONS.items():
            root = self.root / phase
            root.mkdir()
            (root / "version").write_text(version)
            for name in ["process-exit", "server-exit", "keeper-exit"]:
                (root / name).write_text("0\n")
            (root / "isolation.tsv").write_text(
                "".join(e + "\tDENIED\n" for e in self.endpoints)
            )
            self.write(
                phase,
                "isolation-probes.jsonl",
                [
                    {"endpoint": endpoint, "exitCode": 124, "outcome": "TIMED_OUT"}
                    for endpoint in self.endpoints
                ],
            )
            for endpoint in self.endpoints:
                host, port = endpoint.split(":")
                (root / f"probe-{host}-{port}.stderr").write_text("")
            targets = [
                {
                    "pod": f"source-{i}",
                    "podUID": f"uid-{i}",
                    "endpoint": endpoint,
                    "positiveControl": "PASS",
                }
                for i, endpoint in enumerate(self.endpoints)
            ]
            (root / "runtime-before.json").write_text(
                json.dumps({"epoch": 1000, "targets": targets})
            )
            (root / "runtime-after.json").write_text(
                json.dumps({"epoch": 1035, "targets": targets})
            )
            self.write(phase, "structure-restore.jsonl", [{"status": "RESTORED"}])
            self.write(phase, "data-restore.jsonl", [{"status": "RESTORED"}])
            self.write(
                phase,
                "tables.jsonl",
                [dict(t, uuid=phase + t["uuid"]) for t in self.tables],
            )
            self.write(
                phase,
                "columns.jsonl",
                [
                    {
                        "database": "signal",
                        "table": "table_00",
                        "name": "key",
                        "type": "UInt64",
                    }
                ],
            )
            self.write(
                phase,
                "replicas.jsonl",
                [
                    dict(
                        database=t["database"],
                        table=t["name"],
                        is_readonly=0,
                        is_session_expired=0,
                        queue_size=0,
                        lost_part_count=0,
                    )
                    for t in self.tables[:11]
                ],
            )
            for table in self.tables:
                suffix = table["database"] + "-" + table["name"] + ".jsonl"
                self.write(phase, "check-" + suffix, [{"result": 1}])
                self.write(
                    phase,
                    "fingerprint-" + suffix,
                    [
                        dict(
                            rows="2",
                            **{
                                p + str(i): "12"
                                for p in ["sum", "xor"]
                                for i in range(4)
                            },
                        )
                    ],
                )

    def write(self, phase, name, rows):
        (self.root / phase / name).write_text(
            "".join(json.dumps(row) + "\n" for row in rows)
        )

    def verify(self):
        return VERIFIER.verify(self.root, self.expected)

    def test_accepts_complete_matching_native_results_with_distinct_restore_uuids(self):
        self.assertEqual(VERIFIER.VERSIONS["v25_3"], "25.3.6.10034")
        result = self.verify()
        self.assertEqual(result["status"], "PASS")
        self.assertEqual(result["rows"], 52)

    def test_rejects_missing_or_nonzero_native_exit(self):
        (self.root / "v26_3/server-exit").write_text("137")
        with self.assertRaisesRegex(RuntimeError, "Unclean native exit"):
            self.verify()

    def test_accepts_the_observed_altinity_package_suffix(self):
        (self.root / "v25_3/version").write_text("25.3.6.10034.altinitystable")
        self.assertEqual(self.verify()["status"], "PASS")

    def test_rejects_a_different_engine_version(self):
        (self.root / "v26_3/version").write_text("25.3.6.10034.altinitystable")
        with self.assertRaisesRegex(RuntimeError, "Wrong engine"):
            self.verify()

    def test_rejects_native_table_check_failure(self):
        self.write("v25_8", "check-signal-table_00.jsonl", [{"result": 0}])
        with self.assertRaisesRegex(RuntimeError, "CHECK TABLE failed"):
            self.verify()

    def test_rejects_same_count_with_changed_row_hashes(self):
        path = self.root / "v26_3/fingerprint-signal-table_00.jsonl"
        value = json.loads(path.read_text())
        value["sum2"] = "13"
        path.write_text(json.dumps(value))
        with self.assertRaisesRegex(RuntimeError, "Full row fingerprints differ"):
            self.verify()

    def test_rejects_column_type_change(self):
        self.write(
            "v26_3",
            "columns.jsonl",
            [
                {
                    "database": "signal",
                    "table": "table_00",
                    "name": "key",
                    "type": "String",
                }
            ],
        )
        with self.assertRaisesRegex(RuntimeError, "Column catalog differs"):
            self.verify()

    def test_rejects_missing_endpoint_denial(self):
        (self.root / "v25_3/isolation.tsv").write_text("")
        with self.assertRaisesRegex(RuntimeError, "Isolation failed"):
            self.verify()

    def test_accepts_native_connection_refused_with_paired_positive_controls(self):
        self.write(
            "v25_3",
            "isolation-probes.jsonl",
            [
                {"endpoint": endpoint, "exitCode": 1, "outcome": "REJECTED"}
                for endpoint in self.endpoints
            ],
        )
        for endpoint in self.endpoints:
            host, port = endpoint.split(":")
            (self.root / "v25_3" / f"probe-{host}-{port}.stderr").write_text(
                f"bash: connect: Connection refused\nbash: line 1: /dev/tcp/{host}/{port}: Connection refused\n"
            )
        self.assertEqual(self.verify()["status"], "PASS")

    def test_rejects_an_arbitrary_nonzero_probe_exit(self):
        self.write(
            "v25_3",
            "isolation-probes.jsonl",
            [
                {"endpoint": endpoint, "exitCode": 126, "outcome": "REJECTED"}
                for endpoint in self.endpoints
            ],
        )
        with self.assertRaisesRegex(RuntimeError, "Unclassified isolation failure"):
            self.verify()

    def test_rejects_probe_failure_without_native_network_error(self):
        self.write(
            "v25_3",
            "isolation-probes.jsonl",
            [
                {"endpoint": endpoint, "exitCode": 1, "outcome": "REJECTED"}
                for endpoint in self.endpoints
            ],
        )
        with self.assertRaisesRegex(RuntimeError, "Unclassified isolation failure"):
            self.verify()

    def test_rejects_native_restore_failure(self):
        self.write("v25_3", "data-restore.jsonl", [{"status": "RESTORE_FAILED"}])
        with self.assertRaisesRegex(RuntimeError, "Restore failed"):
            self.verify()

    def test_rejects_replaced_production_endpoint(self):
        path = self.root / "v25_3/runtime-after.json"
        control = json.loads(path.read_text())
        control["targets"][0]["podUID"] = "replacement-uid"
        path.write_text(json.dumps(control))
        with self.assertRaisesRegex(RuntimeError, "Production target identity changed"):
            self.verify()

    def test_rejects_stale_positive_controls(self):
        path = self.root / "v25_3/runtime-after.json"
        control = json.loads(path.read_text())
        control["epoch"] = 1200
        path.write_text(json.dumps(control))
        with self.assertRaisesRegex(RuntimeError, "Stale runtime isolation controls"):
            self.verify()


if __name__ == "__main__":
    unittest.main()
