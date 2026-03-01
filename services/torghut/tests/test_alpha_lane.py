from __future__ import annotations

import json
import tempfile
from pathlib import Path
from unittest import TestCase

import pandas as pd

from app.trading.alpha.lane import run_alpha_discovery_lane, _normalize_prices


class TestAlphaLane(TestCase):
    def _trend_frames(self) -> tuple[pd.DataFrame, pd.DataFrame]:
        index = pd.date_range("2022-01-01", periods=420, freq="B", tz="UTC")
        trend = pd.Series(range(100, 100 + len(index)), index=index, dtype="float64")
        sideways = pd.Series(
            [100 + (i % 4) for i in range(len(index))],
            index=index,
            dtype="float64",
        )
        prices = pd.DataFrame({"TREND": trend, "SIDE": sideways})
        train = prices.iloc[:280]
        test = prices.iloc[280:]
        return train, test

    def test_lane_progression_manifests_and_notes(self) -> None:
        train, test = self._trend_frames()

        with tempfile.TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "alpha-lane"
            result = run_alpha_discovery_lane(
                artifact_path=output_dir,
                train_prices=train,
                test_prices=test,
                repository="proompteng/lab",
                base="main",
                head="feature/alpha",
                priority_id="P-77",
            )

            candidate_manifest = json.loads(
                result.candidate_generation_manifest_path.read_text(encoding="utf-8")
            )
            evaluation_manifest = json.loads(
                result.evaluation_manifest_path.read_text(encoding="utf-8")
            )
            recommendation_manifest = json.loads(
                result.recommendation_manifest_path.read_text(encoding="utf-8")
            )

            self.assertEqual(candidate_manifest["stage"], "candidate-generation")
            self.assertEqual(candidate_manifest["stage_index"], 1)
            self.assertIsNone(candidate_manifest["parent_lineage_hash"])
            self.assertEqual(
                evaluation_manifest["parent_lineage_hash"],
                candidate_manifest["lineage_hash"],
            )
            self.assertEqual(evaluation_manifest["stage"], "evaluation")
            self.assertEqual(evaluation_manifest["stage_index"], 2)
            self.assertEqual(
                recommendation_manifest["parent_lineage_hash"],
                evaluation_manifest["lineage_hash"],
            )
            self.assertEqual(recommendation_manifest["stage"], "promotion-recommendation")
            self.assertEqual(recommendation_manifest["stage_index"], 3)
            self.assertEqual(
                result.stage_lineage_root,
                candidate_manifest["lineage_hash"],
            )
            self.assertEqual(
                result.stage_trace_ids["candidate-generation"],
                candidate_manifest["stage_trace_id"],
            )
            self.assertEqual(
                result.stage_trace_ids["evaluation"],
                evaluation_manifest["stage_trace_id"],
            )
            self.assertEqual(
                result.stage_trace_ids["promotion-recommendation"],
                recommendation_manifest["stage_trace_id"],
            )

            notes = sorted((output_dir / "notes").glob("iteration-*.md"))
            self.assertEqual(len(notes), 1)
            note_text = notes[0].read_text(encoding="utf-8")
            self.assertIn("Alpha lane iteration 1", note_text)
            self.assertIn("candidate-generation", note_text)

    def test_lane_lineage_persists_in_candidate_spec(self) -> None:
        train, test = self._trend_frames()

        with tempfile.TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "alpha-lineage"
            result = run_alpha_discovery_lane(
                artifact_path=output_dir,
                train_prices=train,
                test_prices=test,
            )

            candidate_spec = json.loads(
                result.candidate_spec_path.read_text(encoding="utf-8")
            )
            self.assertIn("stage_lineage", candidate_spec)
            stage_lineage = candidate_spec["stage_lineage"]
            self.assertEqual(
                stage_lineage["root_lineage_hash"],
                result.stage_lineage_root,
            )
            self.assertIn("stages", stage_lineage)
            self.assertEqual(
                candidate_spec["stage_trace_ids"],
                result.stage_trace_ids,
            )
            self.assertIn(
                "train_prices",
                candidate_spec["artifacts"],
            )
            self.assertIn("replay_artifact_hashes", candidate_spec)
            self.assertIn(
                "candidate-generation",
                candidate_spec["stage_manifest_refs"],
            )
            self.assertEqual(
                stage_lineage["stages"]["promotion-recommendation"]["parent_stage"],
                "evaluation",
            )

    def test_lane_fail_closed_when_evidence_rejects(self) -> None:
        train, test = self._trend_frames()

        policy = {
            "policy_version": "alpha-lane-policy-v1",
            "alpha_min_train_total_return": "-1000000",
            "alpha_min_test_total_return": "999999",
            "alpha_min_train_sharpe": "-1000000",
            "alpha_min_test_sharpe": "0",
            "alpha_max_test_drawdown_abs": "1",
            "require_candidate_accepted": True,
        }

        with tempfile.TemporaryDirectory() as tmpdir:
            policy_path = Path(tmpdir) / "policy.json"
            policy_path.write_text(json.dumps(policy), encoding="utf-8")
            result = run_alpha_discovery_lane(
                artifact_path=Path(tmpdir) / "alpha-fail",
                train_prices=train,
                test_prices=test,
                gate_policy_path=policy_path,
            )

            recommendation_payload = json.loads(
                result.recommendation_artifact_path.read_text(encoding="utf-8")
            )
            recommendation = recommendation_payload["recommendation"]
            self.assertFalse(recommendation["eligible"])
            self.assertEqual(recommendation["action"], "deny")
            self.assertIn("test_total_return_below_threshold", recommendation["reasons"])

    def test_normalize_prices_does_not_drop_numeric_first_column(self) -> None:
        prices = pd.DataFrame(
            {
                "A": [101.0, 102.0, 103.0, 104.0],
                "B": [201.0, 202.0, 203.0, 204.0],
            }
        )
        normalized = _normalize_prices(prices, label="train")

        self.assertEqual(normalized.shape, (4, 2))
        self.assertIn("A", normalized.columns)
        self.assertIn("B", normalized.columns)
        self.assertTrue(normalized.index.equals(prices.index))

    def test_iteration_notes_use_real_newlines(self) -> None:
        train, test = self._trend_frames()

        with tempfile.TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "alpha-notes"
            _result = run_alpha_discovery_lane(
                artifact_path=output_dir,
                train_prices=train,
                test_prices=test,
            )

            notes = sorted((output_dir / "notes").glob("iteration-*.md"))
            self.assertEqual(len(notes), 1)
            note_contents = notes[0].read_text(encoding="utf-8")
            self.assertIn("\n", note_contents)
            self.assertNotIn("\\n", note_contents)
