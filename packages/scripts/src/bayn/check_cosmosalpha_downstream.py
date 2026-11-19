"""Exercise downstream metric definitions and reject corrupted saved-model evidence."""

import hashlib
import io
import json
import math
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

import numpy as np

import verify_cosmosalpha_downstream as verifier


class Definitions(unittest.TestCase):
    def test_integer_validity_flags_are_rejected_before_indexing(self):
        manifest = {
            "schema_version": "columnar-records/1.0",
            "row_count": 2,
            "columns": [
                {
                    "name": "score",
                    "type": "float",
                    "data_key": "column_0",
                    "valid_key": "valid_0",
                }
            ],
        }
        stream = io.BytesIO()
        np.savez(
            stream,
            column_0=np.array([1.0, 2.0]),
            valid_0=np.array([1, 1], dtype=np.uint8),
            __cosmosalpha_manifest__=json.dumps(manifest),
        )
        payload = stream.getvalue()
        key = hashlib.sha256(payload).hexdigest()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "artifacts" / key[:2] / key
            path.parent.mkdir(parents=True)
            path.write_bytes(payload)
            with self.assertRaisesRegex(ValueError, "Validity flags must be boolean"):
                verifier.table(
                    root,
                    {
                        "artifact_id": key,
                        "checksum": "sha256:" + key,
                        "size_bytes": len(payload),
                    },
                )

    def test_signed_daily_ranks_sample_threshold_and_sample_deviation(self):
        sizes = [100, 200, 100, 99]
        scores = [
            np.repeat(np.arange(50), n // 50) if n != 99 else np.arange(n)
            for n in sizes
        ]
        predictions = {
            "datetime": np.repeat(
                ["2021-01-04", "2021-01-05", "2021-01-06", "2021-01-07"], sizes
            ),
            "score": np.concatenate(scores),
            "raw_forward_return": np.concatenate([-scores[0], *scores[1:]]),
        }
        metrics, rows = verifier.signal_metrics(predictions)
        self.assertEqual([r[3] for r in rows], [100, 200, 100])
        self.assertEqual(metrics["effective_sample_count"], 400)
        for name in ["ic", "rank_ic"]:
            self.assertAlmostEqual(metrics[name + "_mean"], 1 / 3)
            self.assertAlmostEqual(metrics[name + "_std"], math.sqrt(4 / 3))
            self.assertAlmostEqual(metrics[name + "_ir"], 1 / math.sqrt(12))

    def test_constant_cross_section_is_excluded_and_one_date_has_zero_ir(self):
        values = np.arange(100, dtype=float)
        metrics, rows = verifier.signal_metrics(
            {
                "datetime": np.repeat(["2021-01-04", "2021-01-05"], 100),
                "score": np.r_[values, np.ones(100)],
                "raw_forward_return": np.r_[-values, values],
            }
        )
        self.assertEqual(len(rows), 1)
        self.assertAlmostEqual(metrics["rank_ic_mean"], -1)
        self.assertEqual(metrics["rank_ic_ir"], 0)

    def test_arithmetic_signed_drawdown_and_238_day_annualization(self):
        def compute(values):
            return verifier.portfolio_metrics(
                {
                    "return": np.array(values),
                    "cost": np.zeros(len(values)),
                    "bench": np.zeros(len(values)),
                }
            )

        self.assertAlmostEqual(compute([0.1, 0.1, -0.1, -0.1])["max_drawdown"], -0.2)
        metrics = compute([0.01, -0.02, 0.015])
        self.assertAlmostEqual(metrics["annualized_return"], 238 / 600)
        self.assertAlmostEqual(metrics["information_ratio"], math.sqrt(238 / 129))


class SavedArtifacts(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = EXPERIMENT_ROOT
        cls.plan = verifier.read(cls.root / "plan.json")
        cls.arm_plan = cls.plan["runs"][0]
        cls.model_path = (
            cls.root / "receipts" / cls.arm_plan["runId"] / "model-result.json"
        )

    def test_all_saved_models(self):
        for run in self.plan["runs"]:
            with self.subTest(run=run["runId"]):
                verifier.verify_run(self.root, self.plan, run)

    def test_reported_metric_corruptions_are_rejected(self):
        original = verifier.read
        for group, name in [
            ("metrics", "rank_ic_mean"),
            ("metrics", "ic_ir"),
            ("portfolio_metrics", "max_drawdown"),
        ]:

            def corrupt(path):
                data = original(path)
                if path == self.model_path:
                    data[group][name] += 0.01
                return data

            with (
                self.subTest(metric=name),
                patch.object(verifier, "read", side_effect=corrupt),
            ):
                with self.assertRaisesRegex(ValueError, "Reported .* differs"):
                    verifier.verify_run(self.root, self.plan, self.arm_plan)

    def test_decoded_table_corruptions_are_rejected(self):
        original = verifier.table
        for kind, column, reason in [
            (
                "lightgbm_predictions",
                "raw_forward_return",
                "Prediction raw target differs",
            ),
            (
                "lightgbm_daily_signal_metrics",
                "sample_count",
                "Daily sample counts differ",
            ),
            ("qlib_portfolio_report", "return", "Reported .* differs"),
        ]:

            def corrupt(root, ref):
                data = original(root, ref)
                if ref["kind"] == kind:
                    data[column][0] += 0.01 if column != "sample_count" else 1
                return data

            with (
                self.subTest(column=column),
                patch.object(verifier, "table", side_effect=corrupt),
            ):
                with self.assertRaisesRegex(ValueError, reason):
                    verifier.verify_run(self.root, self.plan, self.arm_plan)

    def test_portfolio_key_cannot_hide_an_incorrect_signal_metric(self):
        original = verifier.read

        def corrupt(path):
            data = original(path)
            if path == self.model_path:
                data["portfolio_metrics"]["rank_ic_mean"] = data["metrics"][
                    "rank_ic_mean"
                ]
                data["metrics"]["rank_ic_mean"] += 0.01
            return data

        with patch.object(verifier, "read", side_effect=corrupt):
            with self.assertRaisesRegex(ValueError, "Reported rank_ic_mean differs"):
                verifier.verify_run(self.root, self.plan, self.arm_plan)

    def test_missing_model_cannot_pass_by_skipping_it(self):
        original = verifier.read

        def missing(path):
            if path == self.model_path:
                raise FileNotFoundError("injected missing model")
            return original(path)

        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "report.json"
            with (
                patch.object(verifier, "read", side_effect=missing),
                patch.object(
                    sys,
                    "argv",
                    ["verify_cosmosalpha_downstream.py", str(self.root), str(output)],
                ),
            ):
                self.assertEqual(verifier.main(), 1)
            report = original(output)
            self.assertEqual(report["status"], "FAIL")
            self.assertEqual(len(report["findings"]), 1)
            self.assertEqual(len(report["checks"]), len(self.plan["runs"]) - 1)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit(
            "usage: check_cosmosalpha_downstream.py <completed-experiment-root>"
        )
    EXPERIMENT_ROOT = Path(sys.argv[1]).resolve()
    unittest.main(argv=[sys.argv[0]])
