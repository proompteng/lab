from __future__ import annotations

import hashlib
import json
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from unittest import TestCase

import pandas as pd
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from app.models import (
    Base,
    ResearchAttempt,
    ResearchCandidate,
    ResearchCostCalibration,
    ResearchPromotion,
    ResearchRun,
    ResearchSequentialTrial,
    ResearchValidationTest,
)
from app.trading.alpha.lane import run_alpha_discovery_lane, _normalize_prices
from app.trading.discovery.sequential_trials import build_sequential_trial_summary


class TestAlphaLane(TestCase):
    def _artifact_sha256(self, path: Path) -> str:
        return hashlib.sha256(path.read_bytes()).hexdigest()

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

    def test_lane_iteration_notes_use_execution_context_artifact_path(self) -> None:
        train, test = self._trend_frames()

        with tempfile.TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "alpha-notes"
            artifact_path = Path(tmpdir) / "external-notes-root"
            result = run_alpha_discovery_lane(
                artifact_path=output_dir,
                train_prices=train,
                test_prices=test,
                execution_context={
                    "execution_context": {
                        "repository": "override/repo",
                        "base": "feature/base",
                        "head": "run/head",
                        "priorityId": "P-5001",
                        "artifactPath": str(artifact_path),
                    }
                },
            )

            notes_dir = artifact_path / "notes"
            notes = sorted(notes_dir.glob("iteration-*.md"))
            self.assertEqual(len(notes), 1)
            self.assertIn(
                "Alpha lane iteration 1",
                notes[0].read_text(encoding="utf-8"),
            )
            self.assertFalse(
                any((output_dir / "notes").glob("iteration-*.md")),
                "iteration notes should be written under provided execution context artifactPath",
            )
            self.assertEqual(result.output_dir, output_dir)

            candidate_spec = json.loads(
                result.candidate_spec_path.read_text(encoding="utf-8")
            )
            self.assertEqual(
                candidate_spec["input_context"],
                {
                    "repository": "override/repo",
                    "base": "feature/base",
                    "head": "run/head",
                    "priority_id": "P-5001",
                },
            )

    def test_lane_iteration_notes_use_explicit_artifact_path_argument(self) -> None:
        train, test = self._trend_frames()

        with tempfile.TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "alpha-notes"
            notes_artifact_path = Path(tmpdir) / "explicit-notes-root"
            result = run_alpha_discovery_lane(
                artifact_path=output_dir,
                train_prices=train,
                test_prices=test,
                notes_artifact_path=str(notes_artifact_path),
                execution_context={
                    "execution_context": {
                        "artifactPath": str(Path(tmpdir) / "execution-notes-root"),
                    }
                },
            )

            notes_dir = notes_artifact_path / "notes"
            notes = sorted(notes_dir.glob("iteration-*.md"))
            self.assertEqual(len(notes), 1)
            self.assertIn(
                "Alpha lane iteration 1",
                notes[0].read_text(encoding="utf-8"),
            )
            self.assertEqual(result.output_dir, output_dir)
            self.assertFalse(
                any((output_dir / "notes").glob("iteration-*.md")),
                "iteration notes should be written under explicit artifactPath argument",
            )

    def test_lane_iteration_notes_resolve_camelcase_artifact_and_priority_inputs(self) -> None:
        train, test = self._trend_frames()

        with tempfile.TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "alpha-notes"
            notes_artifact_path = Path(tmpdir) / "camel-notes-root"
            result = run_alpha_discovery_lane(
                artifact_path=output_dir,
                train_prices=train,
                test_prices=test,
                artifactPath=str(notes_artifact_path),
                priorityId="P-5002",
            )

            notes_dir = notes_artifact_path / "notes"
            notes = sorted(notes_dir.glob("iteration-*.md"))
            self.assertEqual(len(notes), 1)
            self.assertIn(
                "Alpha lane iteration 1",
                notes[0].read_text(encoding="utf-8"),
            )
            self.assertFalse(
                any((output_dir / "notes").glob("iteration-*.md")),
                "iteration notes should be written under explicit artifactPath alias",
            )
            candidate_spec = json.loads(
                result.candidate_spec_path.read_text(encoding="utf-8")
            )
            self.assertEqual(candidate_spec["input_context"]["priority_id"], "P-5002")

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

    def test_fail_closed_lane_still_records_full_stage_lineage(self) -> None:
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
            output_dir = Path(tmpdir) / "alpha-fail-lineage"
            policy_path = Path(tmpdir) / "policy.json"
            policy_path.write_text(json.dumps(policy), encoding="utf-8")
            result = run_alpha_discovery_lane(
                artifact_path=output_dir,
                train_prices=train,
                test_prices=test,
                gate_policy_path=policy_path,
            )

            recommendation_payload = json.loads(
                result.recommendation_artifact_path.read_text(encoding="utf-8")
            )
            self.assertFalse(recommendation_payload["evaluation_passed"])
            self.assertFalse(recommendation_payload["recommendation"]["eligible"])

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
            self.assertEqual(evaluation_manifest["stage"], "evaluation")
            self.assertEqual(recommendation_manifest["stage"], "promotion-recommendation")
            self.assertEqual(evaluation_manifest["parent_lineage_hash"], candidate_manifest["lineage_hash"])
            self.assertEqual(recommendation_manifest["parent_lineage_hash"], evaluation_manifest["lineage_hash"])
            self.assertEqual(result.stage_lineage_root, candidate_manifest["lineage_hash"])

            candidate_spec = json.loads(
                result.candidate_spec_path.read_text(encoding="utf-8")
            )
            self.assertEqual(
                candidate_spec["stage_lineage"]["root_lineage_hash"],
                result.stage_lineage_root,
            )
            self.assertEqual(
                candidate_spec["stage_trace_ids"],
                result.stage_trace_ids,
            )
            self.assertIn(
                "recommendation_artifact",
                candidate_spec["replay_artifact_hashes"],
            )

    def test_lane_replay_artifacts_are_immutable(self) -> None:
        train, test = self._trend_frames()

        with tempfile.TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "alpha-immutable"
            result = run_alpha_discovery_lane(
                artifact_path=output_dir,
                train_prices=train,
                test_prices=test,
            )

            candidate_spec = json.loads(
                result.candidate_spec_path.read_text(encoding="utf-8")
            )
            stage_lineage = candidate_spec["stage_lineage"]
            self.assertEqual(
                stage_lineage["root_lineage_hash"],
                result.stage_lineage_root,
                "candidate spec should persist root lineage hash",
            )
            self.assertEqual(
                stage_lineage["stages"]["evaluation"]["parent_stage"],
                "candidate-generation",
            )
            self.assertEqual(
                stage_lineage["stages"]["promotion-recommendation"]["parent_stage"],
                "evaluation",
            )

            for artifact_key, expected_hash in candidate_spec[
                "replay_artifact_hashes"
            ].items():
                artifact_path = candidate_spec["artifacts"][artifact_key]
                self.assertEqual(
                    expected_hash,
                    self._artifact_sha256(Path(artifact_path)),
                    f"artifact hash for {artifact_key} should match file content",
                )

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

    def test_lane_persists_strategy_factory_research_chain_when_enabled(self) -> None:
        train, test = self._trend_frames()
        engine = create_engine(
            'sqlite+pysqlite:///:memory:',
            future=True,
            connect_args={'check_same_thread': False},
        )
        Base.metadata.create_all(engine)
        session_factory = sessionmaker(bind=engine, expire_on_commit=False, future=True)
        try:
            with tempfile.TemporaryDirectory() as tmpdir:
                output_dir = Path(tmpdir) / 'alpha-ledger'
                result = run_alpha_discovery_lane(
                    artifact_path=output_dir,
                    train_prices=train,
                    test_prices=test,
                    persist_results=True,
                    session_factory=session_factory,
                    head='test-sha',
                    repository='proompteng/lab',
                )

                candidate_spec = json.loads(
                    result.candidate_spec_path.read_text(encoding='utf-8')
                )
                self.assertIn('strategy_factory', candidate_spec)
                self.assertIn('attempt_ledger', candidate_spec['artifacts'])
                self.assertIn('validation_formal_validity', candidate_spec['artifacts'])

                with session_factory() as session:
                    run_row = session.execute(
                        select(ResearchRun).where(ResearchRun.run_id == result.run_id)
                    ).scalar_one()
                    candidate_row = session.execute(
                        select(ResearchCandidate).where(
                            ResearchCandidate.candidate_id == result.candidate_id
                        )
                    ).scalar_one()
                    attempts = (
                        session.execute(
                            select(ResearchAttempt).where(
                                ResearchAttempt.run_id == result.run_id
                            )
                        )
                        .scalars()
                        .all()
                    )
                    validations = (
                        session.execute(
                            select(ResearchValidationTest).where(
                                ResearchValidationTest.candidate_id == result.candidate_id
                            )
                        )
                        .scalars()
                        .all()
                    )
                    sequential = session.execute(
                        select(ResearchSequentialTrial).where(
                            ResearchSequentialTrial.candidate_id == result.candidate_id
                        )
                    ).scalar_one()
                    calibration = session.execute(select(ResearchCostCalibration)).scalar_one()
                    promotion = session.execute(
                        select(ResearchPromotion).where(
                            ResearchPromotion.candidate_id == result.candidate_id
                        )
                    ).scalar_one()

                self.assertEqual(run_row.discovery_mode, 'strategy_factory_alpha_v1')
                self.assertEqual(candidate_row.candidate_family, 'tsmom')
                self.assertIsInstance(candidate_row.economic_validity_card, dict)
                self.assertGreaterEqual(len(attempts), 1)
                self.assertGreaterEqual(len(validations), 8)
                self.assertIn(sequential.status, {'paper_ready', 'paper_only'})
                self.assertEqual(calibration.scope_type, 'candidate_family')
                self.assertIsInstance(promotion.evidence_bundle, dict)
                self.assertIn('strategy_factory', promotion.evidence_bundle)
        finally:
            engine.dispose()

    def test_sequential_trial_summary_handles_empty_samples(self) -> None:
        summary = build_sequential_trial_summary(
            net_returns=pd.Series(dtype='float64'),
            started_at=datetime(2026, 4, 1, tzinfo=timezone.utc),
            updated_at=datetime(2026, 4, 2, tzinfo=timezone.utc),
            cost_calibration_status='calibrated',
            baseline_outperformed=True,
        )

        self.assertEqual(summary.status, 'observe_only')
        self.assertIn('no_sequential_samples', summary.reason_codes)

    def test_sequential_trial_summary_marks_single_sample_uncalibrated_baseline_failure(self) -> None:
        summary = build_sequential_trial_summary(
            net_returns=pd.Series([0.75], dtype='float64'),
            started_at=datetime(2026, 4, 1, tzinfo=timezone.utc),
            updated_at=datetime(2026, 4, 2, tzinfo=timezone.utc),
            cost_calibration_status='stale',
            baseline_outperformed=False,
        )

        self.assertEqual(summary.status, 'paper_only')
        self.assertIn('cost_calibration_not_calibrated', summary.reason_codes)
        self.assertIn('baseline_not_outperformed', summary.reason_codes)

    def test_sequential_trial_summary_blocks_non_positive_posterior_edge(self) -> None:
        summary = build_sequential_trial_summary(
            net_returns=pd.Series([-0.25, -0.10], dtype='float64'),
            started_at=datetime(2026, 4, 1, tzinfo=timezone.utc),
            updated_at=datetime(2026, 4, 2, tzinfo=timezone.utc),
            cost_calibration_status='calibrated',
            baseline_outperformed=True,
        )

        self.assertEqual(summary.status, 'paper_only')
        self.assertIn('posterior_edge_not_positive', summary.reason_codes)
