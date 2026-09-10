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
        return VERIFIER.verify(self.root, self.expected, self.endpoints)

    def test_accepts_complete_matching_native_results_with_distinct_restore_uuids(self):
        result = self.verify()
        self.assertEqual(result["status"], "PASS")
        self.assertEqual(result["rows"], 52)

    def test_rejects_missing_or_nonzero_native_exit(self):
        (self.root / "v26_3/server-exit").write_text("137")
        with self.assertRaisesRegex(RuntimeError, "Unclean native exit"):
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

    def test_rejects_native_restore_failure(self):
        self.write("v25_3", "data-restore.jsonl", [{"status": "RESTORE_FAILED"}])
        with self.assertRaisesRegex(RuntimeError, "Restore failed"):
            self.verify()


if __name__ == "__main__":
    unittest.main()
