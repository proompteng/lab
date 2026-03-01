from __future__ import annotations

import hashlib
import json
import os
import tempfile
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from unittest.mock import patch
from unittest import TestCase
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from typing import Any

from app.trading.autonomy.lane import (
    _AUTONOMY_PHASE_ORDER,
    _build_phase_manifest,
    _resolve_paper_patch_path,
    _resolve_gate_forecast_metrics,
    _resolve_gate_fragility_inputs,
    run_autonomous_lane,
    upsert_autonomy_no_signal_run,
)
from app.trading.autonomy.policy_checks import (
    PromotionPrerequisiteResult,
    RollbackReadinessResult,
)
from app.trading.autonomy.phase_manifest_contract import coerce_phase_status
from app.trading.autonomy.gates import GateEvaluationReport, GateResult
from app.trading.evaluation import WalkForwardDecision
from app.trading.features import SignalFeatures
from app.trading.models import SignalEnvelope, StrategyDecision
from app.trading.reporting import PromotionEvidenceSummary, PromotionRecommendation
from app.models import (
    Base,
    ResearchCandidate,
    ResearchFoldMetrics,
    ResearchPromotion,
    ResearchRun,
    ResearchStressMetrics,
)


class TestAutonomousLane(TestCase):
    def _artifact_sha256(self, path: Path) -> str:
        return hashlib.sha256(path.read_bytes()).hexdigest()

    def _empty_session_factory(self) -> sessionmaker:
        engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            future=True,
            connect_args={"check_same_thread": False},
        )
        Base.metadata.create_all(engine)
        return sessionmaker(bind=engine, expire_on_commit=False, future=True)

    def test_gate_forecast_metrics_are_derived_from_signals(self) -> None:
        signals = [
            SignalEnvelope(
                event_ts=datetime(2026, 1, 1, 0, 1, tzinfo=timezone.utc),
                symbol="AAPL",
                timeframe="1Min",
                payload={
                    "macd": {"macd": "0.6", "signal": "0.2"},
                    "rsi14": "42",
                    "price": "100",
                },
            ),
            SignalEnvelope(
                event_ts=datetime(2026, 1, 1, 0, 2, tzinfo=timezone.utc),
                symbol="AAPL",
                timeframe="1Min",
                payload={
                    "macd": {"macd": "0.7", "signal": "0.1"},
                    "rsi14": "48",
                    "price": "101",
                },
            ),
        ]

        metrics = _resolve_gate_forecast_metrics(signals=signals)

        self.assertIn("fallback_rate", metrics)
        self.assertIn("inference_latency_ms_p95", metrics)
        self.assertIn("calibration_score_min", metrics)
        self.assertGreaterEqual(Decimal(metrics["fallback_rate"]), Decimal("0"))
        self.assertLessEqual(Decimal(metrics["fallback_rate"]), Decimal("1"))
        self.assertGreaterEqual(int(metrics["inference_latency_ms_p95"]), 1)
        self.assertGreaterEqual(Decimal(metrics["calibration_score_min"]), Decimal("0"))

    def test_gate_fragility_inputs_are_derived_from_decision_payloads(self) -> None:
        fallback_metrics = {
            "fragility_state": "elevated",
            "fragility_score": "0.40",
            "stability_mode_active": False,
        }
        decisions = [
            WalkForwardDecision(
                decision=StrategyDecision(
                    strategy_id="s1",
                    symbol="AAPL",
                    event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
                    timeframe="1Min",
                    action="buy",
                    qty=Decimal("1"),
                    order_type="market",
                    time_in_force="day",
                    params={
                        "allocator": {
                            "fragility_state": "crisis",
                            "fragility_score": "0.92",
                            "stability_mode_active": True,
                        }
                    },
                ),
                features=SignalFeatures(
                    macd=None,
                    macd_signal=None,
                    rsi=None,
                    price=None,
                    volatility=None,
                ),
            )
        ]

        state, score, stability, inputs_valid = _resolve_gate_fragility_inputs(
            metrics_payload=fallback_metrics, decisions=decisions
        )

        self.assertEqual(state, "crisis")
        self.assertEqual(score, Decimal("0.92"))
        self.assertTrue(stability)
        self.assertTrue(inputs_valid)

    def test_gate_fragility_inputs_fail_closed_on_missing_or_invalid_values(self) -> None:
        state, score, stability, inputs_valid = _resolve_gate_fragility_inputs(
            metrics_payload={},
            decisions=[],
        )
        self.assertEqual(state, "crisis")
        self.assertEqual(score, Decimal("1"))
        self.assertFalse(stability)
        self.assertFalse(inputs_valid)

        state, score, stability, inputs_valid = _resolve_gate_fragility_inputs(
            metrics_payload={},
            decisions=[
                WalkForwardDecision(
                    decision=StrategyDecision(
                        strategy_id="s1",
                        symbol="AAPL",
                        event_ts=datetime.now(timezone.utc),
                        timeframe="1Min",
                        action="buy",
                        qty=Decimal("1"),
                        order_type="market",
                        time_in_force="day",
                        params={
                            "allocator": {
                                "fragility_state": "not-a-state",
                                "fragility_score": "maybe",
                                "stability_mode_active": "n/a",
                            }
                        },
                    ),
                    features=SignalFeatures(
                        macd=None,
                        macd_signal=None,
                        rsi=None,
                        price=None,
                        volatility=None,
                    ),
                )
            ],
        )
        self.assertEqual(state, "crisis")
        self.assertEqual(score, Decimal("1"))
        self.assertFalse(stability)
        self.assertFalse(inputs_valid)

    def test_lane_emits_gate_report_and_paper_patch(self) -> None:
        fixture_path = Path(__file__).parent / "fixtures" / "walkforward_signals.json"
        strategy_config_path = (
            Path(__file__).parent.parent / "config" / "autonomous-strategy-sample.yaml"
        )
        gate_policy_path = (
            Path(__file__).parent.parent / "config" / "autonomous-gate-policy.json"
        )
        strategy_configmap_path = (
            Path(__file__).parent.parent.parent.parent
            / "argocd"
            / "applications"
            / "torghut"
            / "strategy-configmap.yaml"
        )

        with tempfile.TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "lane"
            session_factory = self._empty_session_factory()
            result = run_autonomous_lane(
                signals_path=fixture_path,
                strategy_config_path=strategy_config_path,
                gate_policy_path=gate_policy_path,
                output_dir=output_dir,
                promotion_target="paper",
                strategy_configmap_path=strategy_configmap_path,
                session_factory=session_factory,
                code_version="test-sha",
            )

            gate_payload = json.loads(
                result.gate_report_path.read_text(encoding="utf-8")
            )
            self.assertIn("gates", gate_payload)
            self.assertNotEqual(gate_payload["recommended_mode"], "paper")
            self.assertIn("promotion_evidence", gate_payload)
            self.assertIn("promotion_decision", gate_payload)
            self.assertFalse(gate_payload["promotion_decision"]["promotion_allowed"])
            evidence = gate_payload["promotion_evidence"]
            self.assertEqual(evidence["fold_metrics"]["count"], 1)
            self.assertEqual(evidence["stress_metrics"]["count"], 4)
            self.assertIn("janus_q", evidence)
            self.assertEqual(evidence["janus_q"]["event_car"]["count"], 3)
            self.assertEqual(evidence["janus_q"]["hgrm_reward"]["count"], 3)
            self.assertTrue(
                bool(evidence["promotion_rationale"].get("recommendation_trace_id"))
            )
            self.assertTrue(
                (output_dir / "gates" / "profitability-benchmark-v4.json").exists()
            )
            self.assertTrue(
                (output_dir / "gates" / "profitability-evidence-v4.json").exists()
            )
            self.assertTrue(
                (
                    output_dir / "gates" / "profitability-evidence-validation.json"
                ).exists()
            )
            self.assertTrue((output_dir / "gates" / "janus-event-car-v1.json").exists())
            self.assertTrue(
                (output_dir / "gates" / "janus-hgrm-reward-v1.json").exists()
            )
            self.assertTrue((output_dir / "gates" / "actuation-intent.json").exists())
            self.assertTrue(
                (output_dir / "gates" / "promotion-evidence-gate.json").exists()
            )
            self.assertIsNone(result.paper_patch_path)
            actuation_payload = json.loads(
                result.actuation_intent_path.read_text(encoding="utf-8")
                if result.actuation_intent_path
                else "{}"
            )
            self.assertEqual(
                actuation_payload["schema_version"], "torghut.autonomy.actuation-intent.v1"
            )
            self.assertFalse(actuation_payload["actuation_allowed"])
            governance_payload = actuation_payload["governance"]
            self.assertEqual(governance_payload["repository"], "proompteng/lab")
            self.assertEqual(governance_payload["base"], "main")
            self.assertTrue(governance_payload["head"].startswith("agentruns/"))
            self.assertEqual(governance_payload["artifact_path"], str(output_dir))
            self.assertEqual(governance_payload["change"], "autonomous-promotion")
            self.assertEqual(
                governance_payload["reason"],
                "Autonomous recommendation for paper target.",
            )
            self.assertIsNone(governance_payload["priority_id"])
            self.assertIn("artifact_refs", actuation_payload)
            self.assertTrue(
                str(output_dir / "gates" / "profitability-evidence-v4.json")
                in actuation_payload["artifact_refs"]
            )
            self.assertIn(
                str(output_dir / "gates" / "rollback-readiness.json"),
                actuation_payload["artifact_refs"],
            )

    def test_lane_progression_manifests_and_iteration_note(self) -> None:
        fixture_path = Path(__file__).parent / "fixtures" / "walkforward_signals.json"
        strategy_config_path = (
            Path(__file__).parent.parent / "config" / "autonomous-strategy-sample.yaml"
        )
        gate_policy_path = (
            Path(__file__).parent.parent / "config" / "autonomous-gate-policy.json"
        )

        with tempfile.TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "lane-manifest"
            result = run_autonomous_lane(
                signals_path=fixture_path,
                strategy_config_path=strategy_config_path,
                gate_policy_path=gate_policy_path,
                output_dir=output_dir,
                promotion_target="paper",
                code_version="test-sha",
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
            self.assertEqual(evaluation_manifest["parent_stage"], "candidate-generation")
            self.assertEqual(evaluation_manifest["stage"], "evaluation")
            self.assertEqual(evaluation_manifest["stage_index"], 2)
            self.assertEqual(
                recommendation_manifest["parent_lineage_hash"],
                evaluation_manifest["lineage_hash"],
            )
            self.assertEqual(recommendation_manifest["parent_stage"], "evaluation")
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
            self.assertIn("Autonomous lane iteration 1", note_text)
            self.assertIn("candidate-generation", note_text)

    def test_lane_progression_and_iteration_notes_respect_execution_artifact_path(
        self,
    ) -> None:
        fixture_path = Path(__file__).parent / "fixtures" / "walkforward_signals.json"
        strategy_config_path = (
            Path(__file__).parent.parent / "config" / "autonomous-strategy-sample.yaml"
        )
        gate_policy_path = (
            Path(__file__).parent.parent / "config" / "autonomous-gate-policy.json"
        )

        with tempfile.TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "lane-default-notes"
            artifact_path = Path(tmpdir) / "external-notes-root"
            result = run_autonomous_lane(
                signals_path=fixture_path,
                strategy_config_path=strategy_config_path,
                gate_policy_path=gate_policy_path,
                output_dir=output_dir,
                promotion_target="paper",
                code_version="test-sha",
                governance_inputs={
                    "execution_context": {
                        "repository": "override/repo",
                        "base": "feature/base",
                        "head": "run/head",
                        "priorityId": "P-1001",
                        "artifactPath": str(artifact_path),
                    }
                },
            )

            notes_dir = artifact_path / "notes"
            notes = sorted(notes_dir.glob("iteration-*.md"))
            self.assertEqual(len(notes), 1)
            self.assertIn(
                "Autonomous lane iteration 1",
                notes[0].read_text(encoding="utf-8"),
            )
            self.assertFalse(
                any((output_dir / "notes").glob("iteration-*.md")),
                "iteration notes should be written under execution artifactPath",
            )
            phase_manifest = json.loads(
                result.phase_manifest_path.read_text(encoding="utf-8")
            )
            self.assertEqual(
                phase_manifest["execution_context"]["artifactPath"],
                str(artifact_path),
            )
            self.assertEqual(
                phase_manifest["execution_context"]["repository"],
                "override/repo",
            )
            self.assertEqual(phase_manifest["execution_context"]["base"], "feature/base")
            self.assertEqual(
                phase_manifest["execution_context"]["head"],
                "run/head",
            )
            actuation_payload = json.loads(
                result.actuation_intent_path.read_text(encoding="utf-8")
                if result.actuation_intent_path
                else "{}"
            )
            self.assertEqual(
                actuation_payload["governance"]["artifact_path"],
                str(artifact_path),
            )
            self.assertEqual(
                actuation_payload["governance"]["repository"],
                "override/repo",
            )
            self.assertEqual(
                actuation_payload["governance"]["base"],
                "feature/base",
            )
            self.assertEqual(actuation_payload["governance"]["head"], "run/head")
            self.assertEqual(
                actuation_payload["governance"]["priority_id"],
                "P-1001",
            )

    def test_lane_prefers_governance_artifact_override_over_execution_context_artifact(
        self,
    ) -> None:
        fixture_path = Path(__file__).parent / "fixtures" / "walkforward_signals.json"
        strategy_config_path = (
            Path(__file__).parent.parent / "config" / "autonomous-strategy-sample.yaml"
        )
        gate_policy_path = (
            Path(__file__).parent.parent / "config" / "autonomous-gate-policy.json"
        )

        with tempfile.TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "lane-override-notes"
            execution_artifact_path = Path(tmpdir) / "execution-notes-root"
            explicit_artifact_path = Path(tmpdir) / "explicit-notes-root"
            result = run_autonomous_lane(
                signals_path=fixture_path,
                strategy_config_path=strategy_config_path,
                gate_policy_path=gate_policy_path,
                output_dir=output_dir,
                promotion_target="paper",
                code_version="test-sha",
                governance_artifact_path=str(explicit_artifact_path),
                governance_inputs={
                    "execution_context": {
                        "artifactPath": str(execution_artifact_path),
                    }
                },
            )

            actuation_payload = json.loads(
                result.actuation_intent_path.read_text(encoding="utf-8")
                if result.actuation_intent_path
                else "{}"
            )
            self.assertEqual(
                actuation_payload["governance"]["artifact_path"],
                str(explicit_artifact_path),
            )
            phase_manifest = json.loads(
                result.phase_manifest_path.read_text(encoding="utf-8")
            )
            self.assertEqual(
                phase_manifest["execution_context"]["artifactPath"],
                str(explicit_artifact_path),
            )
            notes = sorted((execution_artifact_path / "notes").glob("iteration-*.md"))
            self.assertEqual(
                len(notes),
                0,
                "execution context artifactPath should be overridden by governance_artifact_path",
            )
            notes = sorted((explicit_artifact_path / "notes").glob("iteration-*.md"))
            self.assertEqual(len(notes), 1)

    def test_lane_supports_governance_override_for_actuation_intent(self) -> None:
        fixture_path = Path(__file__).parent / "fixtures" / "walkforward_signals.json"
        strategy_config_path = (
            Path(__file__).parent.parent / "config" / "autonomous-strategy-sample.yaml"
        )
        gate_policy_path = (
            Path(__file__).parent.parent / "config" / "autonomous-gate-policy.json"
        )

        with tempfile.TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "lane-overrides"
            custom_artifact_dir = output_dir / "artifacts"
            custom_head = "agentruns/torghut-autonomy-custom"
            result = run_autonomous_lane(
                signals_path=fixture_path,
                strategy_config_path=strategy_config_path,
                gate_policy_path=gate_policy_path,
                output_dir=output_dir,
                promotion_target="paper",
                code_version="test-sha",
                governance_repository="alt-org/lab",
                governance_base="release",
                governance_head=custom_head,
                governance_artifact_path=str(custom_artifact_dir),
                priority_id="priority-123",
                governance_change="manual-review",
                governance_reason="manual override",
            )

            actuation_payload = json.loads(
                result.actuation_intent_path.read_text(encoding="utf-8")
                if result.actuation_intent_path
                else "{}"
            )
            governance_payload = actuation_payload["governance"]
            self.assertEqual(governance_payload["repository"], "alt-org/lab")
            self.assertEqual(governance_payload["base"], "release")
            self.assertEqual(governance_payload["head"], custom_head)
            self.assertEqual(governance_payload["artifact_path"], str(custom_artifact_dir))
            self.assertEqual(governance_payload["change"], "manual-review")
            self.assertEqual(governance_payload["priority_id"], "priority-123")
            self.assertEqual(governance_payload["reason"], "manual override")

    def test_lane_blocks_live_without_policy_enablement(self) -> None:
        fixture_path = Path(__file__).parent / "fixtures" / "walkforward_signals.json"
        strategy_config_path = (
            Path(__file__).parent.parent / "config" / "autonomous-strategy-sample.yaml"
        )
        gate_policy_path = (
            Path(__file__).parent.parent / "config" / "autonomous-gate-policy.json"
        )

        with tempfile.TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "lane-live"
            result = run_autonomous_lane(
                signals_path=fixture_path,
                strategy_config_path=strategy_config_path,
                gate_policy_path=gate_policy_path,
                output_dir=output_dir,
                promotion_target="live",
                code_version="test-sha",
            )

            gate_payload = json.loads(
                result.gate_report_path.read_text(encoding="utf-8")
            )
            self.assertFalse(gate_payload["promotion_allowed"])
            self.assertIn("live_rollout_disabled_by_policy", gate_payload["reasons"])
            self.assertIsNone(result.paper_patch_path)
            self.assertIsNotNone(result.actuation_intent_path)
            assert result.actuation_intent_path is not None
            self.assertTrue(result.actuation_intent_path.exists())
            actuation_payload = json.loads(
                result.actuation_intent_path.read_text(encoding="utf-8")
            )
            self.assertFalse(actuation_payload["actuation_allowed"])
            self.assertEqual(actuation_payload["promotion_target"], "live")
            self.assertTrue(actuation_payload["confirmation_phrase_required"])

    @patch(
        "app.trading.autonomy.lane.evaluate_rollback_readiness",
        return_value=RollbackReadinessResult(
            ready=False,
            reasons=["rollback_checks_missing_or_failed"],
            required_checks=["killSwitchDryRunPassed"],
            missing_checks=["killSwitchDryRunPassed"],
        ),
    )
    def test_lane_marks_actuation_not_allowed_when_rollback_readiness_fails(
        self, _mock_rollback: object
    ) -> None:
        fixture_path = Path(__file__).parent / "fixtures" / "walkforward_signals.json"
        strategy_config_path = (
            Path(__file__).parent.parent / "config" / "autonomous-strategy-sample.yaml"
        )
        gate_policy_path = (
            Path(__file__).parent.parent / "config" / "autonomous-gate-policy.json"
        )

        with tempfile.TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "lane-rollback-block"
            result = run_autonomous_lane(
                signals_path=fixture_path,
                strategy_config_path=strategy_config_path,
                gate_policy_path=gate_policy_path,
                output_dir=output_dir,
                promotion_target="paper",
                code_version="test-sha",
            )

            actuation_payload = json.loads(
                result.actuation_intent_path.read_text(encoding="utf-8")
            )
            self.assertFalse(actuation_payload["actuation_allowed"])
            self.assertIsNone(result.paper_patch_path)
            self.assertEqual(
                actuation_payload["audit"]["rollback_evidence_missing_checks"],
                ["killSwitchDryRunPassed"],
            )
            self.assertIn(
                "rollback_checks_missing_or_failed",
                actuation_payload["gates"]["recommendation_reasons"],
            )
            self.assertIn(
                str(output_dir / "gates" / "rollback-readiness.json"),
                actuation_payload["artifact_refs"],
            )

    @patch(
        "app.trading.autonomy.lane._evaluate_drift_promotion_gate",
        return_value={
            "allowed": False,
            "artifact_refs": [],
            "eligible_for_live_promotion": False,
            "reasons": ["drift_gate_rejected"],
        },
    )
    @patch(
        "app.trading.autonomy.lane.evaluate_rollback_readiness",
        return_value=RollbackReadinessResult(
            ready=True,
            reasons=[],
            required_checks=[],
            missing_checks=[],
        ),
    )
    def test_lane_marks_actuation_not_allowed_when_recommendation_ineligible_for_drift(
        self,
        _mock_rollback: object,
        _mock_drift: object,
    ) -> None:
        fixture_path = Path(__file__).parent / "fixtures" / "walkforward_signals.json"
        strategy_config_path = (
            Path(__file__).parent.parent / "config" / "autonomous-strategy-sample.yaml"
        )
        gate_policy_path = (
            Path(__file__).parent.parent / "config" / "autonomous-gate-policy.json"
        )

        with tempfile.TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "lane-drift-ineligible"
            result = run_autonomous_lane(
                signals_path=fixture_path,
                strategy_config_path=strategy_config_path,
                gate_policy_path=gate_policy_path,
                output_dir=output_dir,
                promotion_target="paper",
                code_version="test-sha",
            )

            actuation_payload = json.loads(
                result.actuation_intent_path.read_text(encoding="utf-8")
                if result.actuation_intent_path
                else "{}"
            )
            self.assertFalse(actuation_payload["actuation_allowed"])
            self.assertIsNone(result.paper_patch_path)

    @patch(
        "app.trading.autonomy.lane.evaluate_promotion_prerequisites",
    )
    @patch(
        "app.trading.autonomy.lane._resolve_paper_patch_path",
    )
    def test_resolve_paper_patch_path_before_promotion_prerequisites(
        self,
        mock_resolve_patch: object,
        mock_promotion_prerequisites: object,
    ) -> None:
        fixture_path = Path(__file__).parent / "fixtures" / "walkforward_signals.json"
        strategy_config_path = (
            Path(__file__).parent.parent / "config" / "autonomous-strategy-sample.yaml"
        )
        gate_policy_path = (
            Path(__file__).parent.parent / "config" / "autonomous-gate-policy.json"
        )
        strategy_configmap_path = (
            Path(__file__).parent.parent.parent.parent
            / "argocd"
            / "applications"
            / "torghut"
            / "strategy-configmap.yaml"
        )

        with tempfile.TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "lane-order"
            output_dir.mkdir(parents=True, exist_ok=True)

            patch_path = output_dir / "paper-candidate" / "strategy-configmap-patch.yaml"
            patch_path.parent.mkdir(parents=True, exist_ok=True)

            def _mock_resolve_patch(*_args, **_kwargs) -> Path:
                patch_path.write_text(
                    "apiVersion: v1\\nkind: ConfigMap", encoding="utf-8"
                )
                return patch_path

            def _mock_promotion_prerequisites(
                *,
                policy_payload: dict[str, Any],
                gate_report_payload: dict[str, Any],
                candidate_state_payload: dict[str, Any],
                promotion_target: str,
                artifact_root: Path,
            ) -> PromotionPrerequisiteResult:
                self.assertTrue(
                    (artifact_root / "paper-candidate" / "strategy-configmap-patch.yaml").exists()
                )
                return PromotionPrerequisiteResult(
                    allowed=False,
                    reasons=[],
                    required_artifacts=[],
                    missing_artifacts=[],
                    reason_details=[],
                    artifact_refs=[],
                    required_throughput={"signal_count": 1, "decision_count": 1},
                    observed_throughput={"signal_count": 1, "decision_count": 1},
                )

            mock_resolve_patch.side_effect = _mock_resolve_patch
            mock_promotion_prerequisites.side_effect = _mock_promotion_prerequisites

            result = run_autonomous_lane(
                signals_path=fixture_path,
                strategy_config_path=strategy_config_path,
                gate_policy_path=gate_policy_path,
                output_dir=output_dir,
                promotion_target="paper",
                strategy_configmap_path=strategy_configmap_path,
                code_version="test-sha",
            )

            self.assertIsNotNone(result.paper_patch_path)
            self.assertTrue(patch_path.exists())

    def test_resolve_paper_patch_path_respects_recommendation_mode(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            strategy_config_path = Path(tmpdir) / "strategy-configmap.yaml"
            strategy_config_path.write_text("{}", encoding="utf-8")
            patch_path = _resolve_paper_patch_path(
                gate_report=GateEvaluationReport(
                    policy_version="v3-gates-1",
                    promotion_target="paper",
                    promotion_allowed=True,
                    recommended_mode="shadow",
                    gates=[GateResult(gate_id="gate0_data_integrity", status="pass")],
                    reasons=[],
                    uncertainty_gate_action="pass",
                    coverage_error="0.01",
                    conformal_interval_width="1.0",
                    shift_score="0.1",
                    recalibration_run_id=None,
                    evaluated_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
                    code_version="test-sha",
                ),
                strategy_configmap_path=strategy_config_path,
                runtime_strategies=[],
                candidate_id="cand-no-patch",
                promotion_target="paper",
                paper_dir=Path(tmpdir) / "paper-candidate",
            )
            self.assertIsNone(patch_path)

    def test_resolve_paper_patch_path_resolves_for_live_target_when_recommended(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            strategy_config_path = Path(tmpdir) / "strategy-configmap.yaml"
            strategy_config_path.write_text("{}", encoding="utf-8")
            paper_candidate_dir = Path(tmpdir) / "paper-candidate"
            paper_candidate_dir.mkdir(parents=True, exist_ok=True)
            patch_path = _resolve_paper_patch_path(
                gate_report=GateEvaluationReport(
                    policy_version="v3-gates-1",
                    promotion_target="live",
                    promotion_allowed=True,
                    recommended_mode="paper",
                    gates=[GateResult(gate_id="gate0_data_integrity", status="pass")],
                    reasons=[],
                    uncertainty_gate_action="pass",
                    coverage_error="0.01",
                    conformal_interval_width="1.0",
                    shift_score="0.1",
                    recalibration_run_id=None,
                    evaluated_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
                    code_version="test-sha",
                ),
                strategy_configmap_path=strategy_config_path,
                runtime_strategies=[],
                candidate_id="cand-live-patch",
                promotion_target="live",
                paper_dir=paper_candidate_dir,
            )
            self.assertIsNotNone(patch_path)
            self.assertTrue(patch_path.exists())

    @patch(
        "app.trading.autonomy.lane.evaluate_rollback_readiness",
        return_value=RollbackReadinessResult(
            ready=False,
            reasons=["rollback_checks_missing_or_failed"],
            required_checks=["killSwitchDryRunPassed"],
            missing_checks=["killSwitchDryRunPassed"],
        ),
    )
    def test_lane_does_not_persist_promotion_when_rollback_not_ready(
        self, _mock_rollback: object
    ) -> None:
        fixture_path = Path(__file__).parent / "fixtures" / "walkforward_signals.json"
        strategy_config_path = (
            Path(__file__).parent.parent / "config" / "autonomous-strategy-sample.yaml"
        )
        gate_policy_path = (
            Path(__file__).parent.parent / "config" / "autonomous-gate-policy.json"
        )

        engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            future=True,
            connect_args={"check_same_thread": False},
        )
        Base.metadata.create_all(engine)
        session_factory = sessionmaker(bind=engine, expire_on_commit=False, future=True)

        with tempfile.TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "lane-no-promote"
            result = run_autonomous_lane(
                signals_path=fixture_path,
                strategy_config_path=strategy_config_path,
                gate_policy_path=gate_policy_path,
                output_dir=output_dir,
                promotion_target="paper",
                code_version="test-sha",
                persist_results=True,
                session_factory=session_factory,
            )

            self.assertIsNone(result.paper_patch_path)
            with session_factory() as session:
                candidate = session.execute(
                    select(ResearchCandidate).where(
                        ResearchCandidate.candidate_id == result.candidate_id
                    )
                ).scalar_one()
                promotion_row = session.execute(
                    select(ResearchPromotion).where(
                        ResearchPromotion.candidate_id == result.candidate_id
                    )
                ).scalar_one()

        self.assertEqual(candidate.lifecycle_role, "challenger")
        self.assertEqual(candidate.lifecycle_status, "evaluated")
        self.assertFalse(candidate.metadata_bundle.get("actuation_allowed"))
        self.assertIsNone(promotion_row.approved_mode)
        self.assertIsNotNone(promotion_row.deny_reason)
        self.assertEqual(promotion_row.requested_mode, "paper")

    def test_lane_uses_repo_relative_default_configmap_path(self) -> None:
        fixture_path = Path(__file__).parent / "fixtures" / "walkforward_signals.json"
        strategy_config_path = (
            Path(__file__).parent.parent / "config" / "autonomous-strategy-sample.yaml"
        )
        gate_policy_path = (
            Path(__file__).parent.parent / "config" / "autonomous-gate-policy.json"
        )
        previous_cwd = Path.cwd()
        try:
            os.chdir(Path(__file__).parent.parent)
            with tempfile.TemporaryDirectory() as tmpdir:
                output_dir = Path(tmpdir) / "lane-default-path"
                session_factory = self._empty_session_factory()
                result = run_autonomous_lane(
                    signals_path=fixture_path,
                    strategy_config_path=strategy_config_path,
                    gate_policy_path=gate_policy_path,
                    output_dir=output_dir,
                    promotion_target="paper",
                    session_factory=session_factory,
                    code_version="test-sha",
                )
                self.assertIsNone(result.paper_patch_path)
                gate_payload = json.loads(
                    result.gate_report_path.read_text(encoding="utf-8")
                )
                self.assertFalse(gate_payload["promotion_decision"]["promotion_allowed"])
                self.assertNotEqual(gate_payload["recommended_mode"], "paper")
        finally:
            os.chdir(previous_cwd)

    def test_lane_persists_research_ledger_when_enabled(self) -> None:
        fixture_path = Path(__file__).parent / "fixtures" / "walkforward_signals.json"
        strategy_config_path = (
            Path(__file__).parent.parent / "config" / "autonomous-strategy-sample.yaml"
        )
        gate_policy_path = (
            Path(__file__).parent.parent / "config" / "autonomous-gate-policy.json"
        )

        engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            future=True,
            connect_args={"check_same_thread": False},
        )
        Base.metadata.create_all(engine)
        session_factory = sessionmaker(bind=engine, expire_on_commit=False, future=True)

        with tempfile.TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "lane-ledger"
            result = run_autonomous_lane(
                signals_path=fixture_path,
                strategy_config_path=strategy_config_path,
                gate_policy_path=gate_policy_path,
                output_dir=output_dir,
                promotion_target="paper",
                code_version="test-sha",
                persist_results=True,
                session_factory=session_factory,
            )

            self.assertIsNone(result.paper_patch_path)
            gate_payload = json.loads(
                result.gate_report_path.read_text(encoding="utf-8")
            )
            self.assertFalse(gate_payload["promotion_decision"]["promotion_allowed"])
            self.assertIn(
                "tca_order_count_below_minimum",
                gate_payload["promotion_decision"]["reason_codes"],
            )

            with session_factory() as session:
                run_row = session.execute(
                    select(ResearchRun).where(ResearchRun.run_id == result.run_id)
                ).scalar_one()
                candidate = session.execute(
                    select(ResearchCandidate).where(
                        ResearchCandidate.candidate_id == result.candidate_id
                    )
                ).scalar_one()
                fold_rows = (
                    session.execute(
                        select(ResearchFoldMetrics).where(
                            ResearchFoldMetrics.candidate_id == result.candidate_id
                        )
                    )
                    .scalars()
                    .all()
                )
                stress_rows = (
                    session.execute(
                        select(ResearchStressMetrics).where(
                            ResearchStressMetrics.candidate_id == result.candidate_id
                        )
                    )
                    .scalars()
                    .all()
                )
                promotion_row = session.execute(
                    select(ResearchPromotion).where(
                        ResearchPromotion.candidate_id == result.candidate_id
                    )
                ).scalar_one()

            self.assertEqual(run_row.status, "passed")
            self.assertIsNotNone(run_row.dataset_from)
            self.assertIsNotNone(run_row.dataset_to)
            self.assertIsInstance(candidate.decision_count, int)
            self.assertGreaterEqual(candidate.decision_count, 0)
            self.assertIsInstance(candidate.universe_definition, dict)
            assert isinstance(candidate.universe_definition, dict)
            lifecycle = candidate.universe_definition.get("autonomy_lifecycle")
            self.assertIsInstance(lifecycle, dict)
            assert isinstance(lifecycle, dict)
            self.assertEqual(lifecycle.get("role"), "challenger")
            self.assertIn(
                lifecycle.get("status"), {"promoted_champion", "retained_challenger"}
            )
            self.assertTrue(fold_rows)
            self.assertEqual(len(stress_rows), 4)
            self.assertEqual(promotion_row.requested_mode, "paper")
            self.assertIn(promotion_row.approved_mode, {"paper", None})
            self.assertIn(candidate.lifecycle_role, {"champion", "challenger"})
            self.assertIsInstance(candidate.metadata_bundle, dict)
            self.assertIsInstance(candidate.recommendation_bundle, dict)
            self.assertIsNotNone(promotion_row.decision_action)
            self.assertTrue((promotion_row.decision_rationale or "").strip())
            self.assertIsInstance(promotion_row.evidence_bundle, dict)
            self.assertIsNotNone(
                promotion_row.approve_reason or promotion_row.deny_reason
            )
            candidate_spec = json.loads(
                result.candidate_spec_path.read_text(encoding="utf-8")
            )
            self.assertIn("stage_lineage", candidate_spec)
            self.assertEqual(
                candidate_spec["stage_lineage"]["root_lineage_hash"],
                result.stage_lineage_root,
            )
            self.assertIn("stages", candidate_spec["stage_lineage"])
            self.assertIn("candidate-generation", candidate_spec["artifacts"])
            self.assertIn("evaluation", candidate_spec["artifacts"])
            self.assertIn("promotion-recommendation", candidate_spec["artifacts"])
            self.assertIn("promotion_recommendation", candidate_spec["artifacts"])
            self.assertIn(
                "candidate-generation", candidate_spec["stage_trace_ids"],
            )
            self.assertIn(
                "evaluation", candidate_spec["stage_trace_ids"],
            )
            self.assertIn(
                "promotion-recommendation", candidate_spec["stage_trace_ids"],
            )
            self.assertEqual(
                candidate_spec["stage_trace_ids"],
                result.stage_trace_ids,
            )
            self.assertIn("replay_artifact_hashes", candidate_spec)
            artifact_paths = dict(candidate_spec["artifacts"])
            artifact_paths.update(
                {
                    "candidate_generation_manifest": candidate_spec["stage_manifest_refs"][
                        "candidate-generation"
                    ],
                    "evaluation_manifest": candidate_spec["stage_manifest_refs"][
                        "evaluation"
                    ],
                    "recommendation_manifest": candidate_spec["stage_manifest_refs"][
                        "promotion-recommendation"
                    ],
                }
            )
            for artifact_key, expected_hash in candidate_spec[
                "replay_artifact_hashes"
            ].items():
                artifact_path = artifact_paths.get(artifact_key)
                self.assertIsNotNone(
                    artifact_path, f"artifact {artifact_key} should be present"
                )
                self.assertEqual(
                    expected_hash,
                    self._artifact_sha256(Path(artifact_path)),
                    f"artifact hash for {artifact_key} should match replay payload",
                )
            for key in (
                "candidate_generation_manifest",
                "evaluation_manifest",
                "recommendation_manifest",
                "promotion_recommendation",
            ):
                self.assertIn(key, candidate_spec["replay_artifact_hashes"])
            self.assertIn("stage_lineage", candidate.metadata_bundle)
            self.assertEqual(
                candidate.metadata_bundle["stage_lineage"]["root_lineage_hash"],
                result.stage_lineage_root,
            )
            self.assertIn(
                "stage_manifest_refs",
                candidate.metadata_bundle,
            )
            self.assertEqual(
                candidate.metadata_bundle["stage_manifest_refs"],
                candidate_spec["stage_manifest_refs"],
            )
            self.assertIn("stage_lineage", promotion_row.evidence_bundle)
            self.assertEqual(
                promotion_row.evidence_bundle["stage_lineage"]["root_lineage_hash"],
                result.stage_lineage_root,
            )
            self.assertIn("replay_artifact_hashes", promotion_row.evidence_bundle)
            self.assertEqual(
                promotion_row.evidence_bundle["replay_artifact_hashes"],
                candidate.metadata_bundle["replay_artifact_hashes"],
            )

    def test_lane_fails_closed_when_required_stage_artifact_is_missing(self) -> None:
        fixture_path = Path(__file__).parent / "fixtures" / "walkforward_signals.json"
        strategy_config_path = (
            Path(__file__).parent.parent / "config" / "autonomous-strategy-sample.yaml"
        )
        policy_payload = {
            "promotion_required_artifacts": [
                "research/candidate-spec.json",
                "backtest/evaluation-report.json",
                "gates/gate-evaluation.json",
                "stages/does-not-exist-manifest.json",
            ],
            "promotion_require_patch_targets": [],
            "gate6_require_profitability_evidence": False,
            "gate6_require_janus_evidence": False,
            "promotion_require_janus_evidence": False,
        }

        with tempfile.TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "lane-missing-artifact"
            policy_path = Path(tmpdir) / "policy.json"
            policy_path.write_text(json.dumps(policy_payload), encoding="utf-8")
            result = run_autonomous_lane(
                signals_path=fixture_path,
                strategy_config_path=strategy_config_path,
                gate_policy_path=policy_path,
                output_dir=output_dir,
                promotion_target="paper",
                code_version="test-sha",
            )

            actuation_payload = json.loads(
                result.actuation_intent_path.read_text(encoding="utf-8")
                if result.actuation_intent_path
                else "{}"
            )
            promotion_reqs = json.loads(
                (output_dir / "gates" / "promotion-prerequisites.json").read_text(
                    encoding="utf-8"
                )
            )

        self.assertFalse(actuation_payload["actuation_allowed"])
        self.assertIn(
            "required_artifacts_missing",
            actuation_payload["gates"]["recommendation_reasons"],
        )
        self.assertIn("required_artifacts_missing", promotion_reqs["reasons"])
        self.assertIn(
            "stages/does-not-exist-manifest.json",
            promotion_reqs["missing_artifacts"],
        )

    def test_upsert_no_signal_run_records_skipped_research_run(self) -> None:
        strategy_config_path = (
            Path(__file__).parent.parent / "config" / "autonomous-strategy-sample.yaml"
        )
        gate_policy_path = (
            Path(__file__).parent.parent / "config" / "autonomous-gate-policy.json"
        )

        engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            future=True,
            connect_args={"check_same_thread": False},
        )
        Base.metadata.create_all(engine)
        session_factory = sessionmaker(bind=engine, expire_on_commit=False, future=True)

        query_start = datetime(2026, 1, 1, 0, 0, tzinfo=timezone.utc)
        query_end = datetime(2026, 1, 1, 0, 15, tzinfo=timezone.utc)

        run_id = upsert_autonomy_no_signal_run(
            session_factory=session_factory,
            query_start=query_start,
            query_end=query_end,
            strategy_config_path=strategy_config_path,
            gate_policy_path=gate_policy_path,
            no_signal_reason="cursor_ahead_of_stream",
            now=query_start,
            code_version="test-sha",
        )

        with session_factory() as session:
            run_row = session.execute(
                select(ResearchRun).where(ResearchRun.run_id == run_id)
            ).scalar_one()

        def _as_utc(value: datetime) -> datetime:
            return (
                value
                if value.tzinfo is not None
                else value.replace(tzinfo=timezone.utc)
            )

        self.assertEqual(run_row.status, "skipped")
        self.assertEqual(_as_utc(run_row.dataset_from), query_start)
        self.assertEqual(_as_utc(run_row.dataset_to), query_end)
        self.assertEqual(run_row.runner_version, "run_autonomous_lane_no_signals")
        self.assertEqual(run_row.dataset_snapshot_ref, "no_signal_window")

    @patch("app.trading.autonomy.lane._persist_run_outputs")
    def test_lane_persistence_failure_marks_run_failed(
        self, mock_persist: object
    ) -> None:
        fixture_path = Path(__file__).parent / "fixtures" / "walkforward_signals.json"
        strategy_config_path = (
            Path(__file__).parent.parent / "config" / "autonomous-strategy-sample.yaml"
        )
        gate_policy_path = (
            Path(__file__).parent.parent / "config" / "autonomous-gate-policy.json"
        )

        engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            future=True,
            connect_args={"check_same_thread": False},
        )
        Base.metadata.create_all(engine)
        session_factory = sessionmaker(bind=engine, expire_on_commit=False, future=True)
        mock_persist.side_effect = RuntimeError("ledger_write_failed")

        with tempfile.TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "lane-ledger-fail"
            with self.assertRaises(RuntimeError) as ctx:
                run_autonomous_lane(
                    signals_path=fixture_path,
                    strategy_config_path=strategy_config_path,
                    gate_policy_path=gate_policy_path,
                    output_dir=output_dir,
                    promotion_target="paper",
                    code_version="test-sha",
                    persist_results=True,
                    session_factory=session_factory,
                )
            self.assertIn("autonomous_lane_persistence_failed", str(ctx.exception))

            with session_factory() as session:
                run_rows = session.execute(select(ResearchRun)).scalars().all()
                candidate_rows = (
                    session.execute(select(ResearchCandidate)).scalars().all()
                )

            self.assertEqual(len(run_rows), 1)
            self.assertEqual(run_rows[0].status, "failed")
            self.assertEqual(len(candidate_rows), 0)

    def test_lane_promotion_audit_rows_are_append_only_for_repeat_runs(self) -> None:
        fixture_path = Path(__file__).parent / "fixtures" / "walkforward_signals.json"
        strategy_config_path = (
            Path(__file__).parent.parent / "config" / "autonomous-strategy-sample.yaml"
        )
        gate_policy_path = (
            Path(__file__).parent.parent / "config" / "autonomous-gate-policy.json"
        )

        engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            future=True,
            connect_args={"check_same_thread": False},
        )
        Base.metadata.create_all(engine)
        session_factory = sessionmaker(bind=engine, expire_on_commit=False, future=True)

        with tempfile.TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "lane-ledger-repeat"
            first = run_autonomous_lane(
                signals_path=fixture_path,
                strategy_config_path=strategy_config_path,
                gate_policy_path=gate_policy_path,
                output_dir=output_dir / "first",
                promotion_target="paper",
                code_version="test-sha",
                persist_results=True,
                session_factory=session_factory,
            )
            second = run_autonomous_lane(
                signals_path=fixture_path,
                strategy_config_path=strategy_config_path,
                gate_policy_path=gate_policy_path,
                output_dir=output_dir / "second",
                promotion_target="paper",
                code_version="test-sha",
                persist_results=True,
                session_factory=session_factory,
            )

        self.assertEqual(first.candidate_id, second.candidate_id)
        with session_factory() as session:
            promotion_rows = (
                session.execute(
                    select(ResearchPromotion).where(
                        ResearchPromotion.candidate_id == first.candidate_id
                    )
                )
                .scalars()
                .all()
            )
        self.assertGreaterEqual(len(promotion_rows), 2)

    def test_lane_counts_rsi_alias_for_gate_null_rate(self) -> None:
        strategy_config_path = (
            Path(__file__).parent.parent / "config" / "autonomous-strategy-sample.yaml"
        )
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            signals_path = tmp / "signals.json"
            policy_path = tmp / "policy.json"
            output_dir = tmp / "lane-rsi-alias"

            signals_path.write_text(
                json.dumps(
                    [
                        {
                            "event_ts": datetime(
                                2026, 1, 1, 0, 0, tzinfo=timezone.utc
                            ).isoformat(),
                            "ingest_ts": datetime(
                                2026, 1, 1, 0, 0, tzinfo=timezone.utc
                            ).isoformat(),
                            "symbol": "AAPL",
                            "timeframe": "1Min",
                            "payload": {
                                "macd": {"macd": "1.2", "signal": "0.8"},
                                "rsi": "24",
                                "price": "101.5",
                            },
                            "seq": 1,
                            "source": "fixture",
                        }
                    ]
                ),
                encoding="utf-8",
            )
            policy_path.write_text(
                json.dumps(
                    {
                        "policy_version": "v3-gates-1",
                        "required_feature_schema_version": "3.0.0",
                        "gate0_max_null_rate": "0",
                        "gate0_max_staleness_ms": 120000,
                        "gate0_min_symbol_coverage": 1,
                        "gate1_min_decision_count": 0,
                        "gate1_min_trade_count": 0,
                        "gate1_min_net_pnl": "-100000",
                        "gate1_max_negative_fold_ratio": "1",
                        "gate1_max_net_pnl_cv": "100",
                        "gate2_max_drawdown": "100000",
                        "gate2_max_turnover_ratio": "1000",
                        "gate2_max_cost_bps": "1000",
                        "gate3_max_llm_error_ratio": "1",
                        "gate5_live_enabled": False,
                    }
                ),
                encoding="utf-8",
            )

            result = run_autonomous_lane(
                signals_path=signals_path,
                strategy_config_path=strategy_config_path,
                gate_policy_path=policy_path,
                output_dir=output_dir,
                promotion_target="paper",
                code_version="test-sha",
            )
            gate_payload = json.loads(
                result.gate_report_path.read_text(encoding="utf-8")
            )
            gate0 = next(
                item
                for item in gate_payload["gates"]
                if item["gate_id"] == "gate0_data_integrity"
            )
            self.assertEqual(gate0["status"], "pass")

    def test_intraday_strategy_candidate_blocks_paper_patch_without_tca_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            config_dir = Path(tmpdir) / "configs"
            config_dir.mkdir(parents=True, exist_ok=True)
            signals_path = config_dir / "intraday_signals.json"
            strategy_config_path = config_dir / "intraday_strategy_candidate.json"
            gate_policy_path = config_dir / "autonomous_gate_policy_short.json"
            signals_path.write_text(
                json.dumps(
                    [
                        {
                            "event_ts": datetime(
                                2026, 1, 1, 0, 1, tzinfo=timezone.utc
                            ).isoformat(),
                            "ingest_ts": datetime(
                                2026, 1, 1, 0, 1, tzinfo=timezone.utc
                            ).isoformat(),
                            "symbol": "AAPL",
                            "timeframe": "1Min",
                            "payload": {
                                "macd": {"macd": "0.12", "signal": "0.03"},
                                "rsi14": "56",
                                "price": "101.5",
                                "ema12": "101.0",
                                "ema26": "100.5",
                                "vol_realized_w60s": "0.008",
                            },
                            "seq": 1,
                            "source": "fixture",
                        },
                        {
                            "event_ts": datetime(
                                2026, 1, 1, 0, 2, tzinfo=timezone.utc
                            ).isoformat(),
                            "ingest_ts": datetime(
                                2026, 1, 1, 0, 2, tzinfo=timezone.utc
                            ).isoformat(),
                            "symbol": "AAPL",
                            "timeframe": "1Min",
                            "payload": {
                                "macd": {"macd": "-0.22", "signal": "-0.10"},
                                "rsi14": "72",
                                "price": "100.0",
                                "ema12": "100.3",
                                "ema26": "100.8",
                                "vol_realized_w60s": "0.006",
                            },
                            "seq": 2,
                            "source": "fixture",
                        },
                    ]
                ),
                encoding="utf-8",
            )

            strategy_config_path.write_text(
                json.dumps(
                    {
                        "strategies": [
                            {
                                "strategy_id": "candidate-intraday",
                                "strategy_type": "intraday_tsmom_v1",
                                "version": "1.1.0",
                                "enabled": True,
                            }
                        ]
                    },
                    sort_keys=False,
                ),
                encoding="utf-8",
            )
            gate_policy_path.write_text(
                json.dumps(
                    {
                        "policy_version": "test-policy",
                        "required_feature_schema_version": "3.0.0",
                        "gate1_min_decision_count": 0,
                        "gate1_min_trade_count": 0,
                        "gate1_min_net_pnl": "-100000",
                        "gate1_max_negative_fold_ratio": "1",
                        "gate1_max_net_pnl_cv": "100",
                        "gate2_max_drawdown": "100000",
                        "gate2_max_turnover_ratio": "1000",
                        "gate2_max_cost_bps": "1000",
                        "gate3_max_llm_error_ratio": "1",
                        "gate6_require_profitability_evidence": False,
                        "gate5_live_enabled": False,
                    },
                    sort_keys=True,
                ),
                encoding="utf-8",
            )

            output_dir = Path(tmpdir) / "lane-tsmom"
            session_factory = self._empty_session_factory()
            result = run_autonomous_lane(
                signals_path=signals_path,
                strategy_config_path=strategy_config_path,
                gate_policy_path=gate_policy_path,
                output_dir=output_dir,
                promotion_target="paper",
                session_factory=session_factory,
                code_version="test-sha",
            )
            self.assertIsNone(result.paper_patch_path)
            gate_payload = json.loads(
                result.gate_report_path.read_text(encoding="utf-8")
            )
            self.assertFalse(gate_payload["promotion_decision"]["promotion_allowed"])
            self.assertIn(
                "tca_order_count_below_minimum",
                gate_payload["promotion_decision"]["reason_codes"],
            )

    def test_lane_blocks_promotion_when_profitability_threshold_not_met(self) -> None:
        fixture_path = Path(__file__).parent / "fixtures" / "walkforward_signals.json"
        strategy_config_path = (
            Path(__file__).parent.parent / "config" / "autonomous-strategy-sample.yaml"
        )

        with tempfile.TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "lane-profitability-block"
            policy_path = Path(tmpdir) / "strict-policy.json"
            policy_path.write_text(
                json.dumps(
                    {
                        "policy_version": "v3-gates-1",
                        "required_feature_schema_version": "3.0.0",
                        "gate0_max_null_rate": "0.01",
                        "gate0_max_staleness_ms": 120000,
                        "gate0_min_symbol_coverage": 1,
                        "gate1_min_decision_count": 1,
                        "gate1_min_trade_count": 1,
                        "gate1_min_net_pnl": "0",
                        "gate1_max_negative_fold_ratio": "1",
                        "gate1_max_net_pnl_cv": "100",
                        "gate2_max_drawdown": "100000",
                        "gate2_max_turnover_ratio": "1000",
                        "gate2_max_cost_bps": "1000",
                        "gate3_max_llm_error_ratio": "1",
                        "gate6_min_market_net_pnl_delta": "999999",
                        "gate6_min_regime_slice_pass_ratio": "1",
                        "gate6_min_return_over_drawdown": "999999",
                        "gate6_max_cost_bps": "1",
                        "gate6_max_calibration_error": "0.01",
                        "gate6_min_reproducibility_hashes": 20,
                        "gate5_live_enabled": False,
                    }
                ),
                encoding="utf-8",
            )

            result = run_autonomous_lane(
                signals_path=fixture_path,
                strategy_config_path=strategy_config_path,
                gate_policy_path=policy_path,
                output_dir=output_dir,
                promotion_target="paper",
                code_version="test-sha",
            )

            gate_payload = json.loads(
                result.gate_report_path.read_text(encoding="utf-8")
            )
            self.assertFalse(gate_payload["promotion_allowed"])
            self.assertIn(
                "profitability_evidence_validation_failed", gate_payload["reasons"]
            )
            self.assertIsNone(result.paper_patch_path)

    def test_lane_promotion_demotes_previous_champion_with_audit(self) -> None:
        fixture_path = Path(__file__).parent / "fixtures" / "walkforward_signals.json"
        engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            future=True,
            connect_args={"check_same_thread": False},
        )
        Base.metadata.create_all(engine)
        session_factory = sessionmaker(bind=engine, expire_on_commit=False, future=True)

        with tempfile.TemporaryDirectory() as tmpdir:
            strategy_a = Path(tmpdir) / "strategy-a.json"
            strategy_b = Path(tmpdir) / "strategy-b.json"
            gate_policy_path = Path(tmpdir) / "permissive-gate-policy.json"
            strategy_a.write_text(
                json.dumps(
                    {
                        "strategies": [
                            {
                                "strategy_id": "candidate-a",
                                "strategy_type": "legacy_macd_rsi",
                                "version": "1.0.0",
                                "enabled": True,
                            }
                        ]
                    }
                ),
                encoding="utf-8",
            )
            gate_policy_path.write_text(
                json.dumps(
                    {
                        "policy_version": "v3-gates-1",
                        "required_feature_schema_version": "3.0.0",
                        "gate0_max_null_rate": "1",
                        "gate0_max_staleness_ms": 120000,
                        "gate0_min_symbol_coverage": 1,
                        "gate1_min_decision_count": 0,
                        "gate1_min_trade_count": 0,
                        "gate1_min_net_pnl": "-1000000",
                        "gate1_max_negative_fold_ratio": "1",
                        "gate1_max_net_pnl_cv": "999",
                        "gate2_max_drawdown": "1000000",
                        "gate2_max_turnover_ratio": "1000000",
                        "gate2_max_cost_bps": "1000000",
                        "gate3_max_llm_error_ratio": "1",
                        "gate6_require_profitability_evidence": False,
                        "gate5_live_enabled": False,
                    }
                ),
                encoding="utf-8",
            )
            strategy_b.write_text(
                json.dumps(
                    {
                        "strategies": [
                            {
                                "strategy_id": "candidate-b",
                                "strategy_type": "legacy_macd_rsi",
                                "version": "1.0.1",
                                "enabled": True,
                            }
                        ]
                    }
                ),
                encoding="utf-8",
            )

            forced_gate = GateEvaluationReport(
                policy_version="v3-gates-1",
                promotion_target="paper",
                promotion_allowed=True,
                recommended_mode="paper",
                gates=[
                    GateResult(gate_id="gate0_data_integrity", status="pass"),
                    GateResult(gate_id="gate1_statistical_robustness", status="pass"),
                    GateResult(gate_id="gate2_risk_capacity", status="pass"),
                    GateResult(gate_id="gate3_shadow_paper_quality", status="pass"),
                    GateResult(gate_id="gate4_operational_readiness", status="pass"),
                    GateResult(gate_id="gate6_profitability_evidence", status="pass"),
                    GateResult(gate_id="gate5_live_ramp_readiness", status="pass"),
                ],
                reasons=[],
                uncertainty_gate_action="pass",
                coverage_error="0.02",
                conformal_interval_width="1.00",
                shift_score="0.10",
                recalibration_run_id=None,
                evaluated_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
                code_version="test-sha",
            )
            with patch(
                "app.trading.autonomy.lane.evaluate_gate_matrix",
                return_value=forced_gate,
            ):
                with patch(
                    "app.trading.autonomy.lane.build_promotion_recommendation",
                    return_value=PromotionRecommendation(
                        action="promote",
                        requested_mode="paper",
                        recommended_mode="paper",
                        eligible=True,
                        rationale="forced_test_rationale",
                        reasons=[],
                        evidence=PromotionEvidenceSummary(
                            fold_metrics_count=1,
                            stress_metrics_count=4,
                            rationale_present=True,
                            evidence_complete=True,
                            reasons=[],
                        ),
                        trace_id="forced-trace",
                    ),
                ):
                    first = run_autonomous_lane(
                        signals_path=fixture_path,
                        strategy_config_path=strategy_a,
                        gate_policy_path=gate_policy_path,
                        output_dir=Path(tmpdir) / "lane-a",
                        promotion_target="paper",
                        code_version="test-sha",
                        persist_results=True,
                        session_factory=session_factory,
                    )
                    second = run_autonomous_lane(
                        signals_path=fixture_path,
                        strategy_config_path=strategy_b,
                        gate_policy_path=gate_policy_path,
                        output_dir=Path(tmpdir) / "lane-b",
                        promotion_target="paper",
                        code_version="test-sha",
                        persist_results=True,
                        session_factory=session_factory,
                    )

            with session_factory() as session:
                first_candidate = session.execute(
                    select(ResearchCandidate).where(
                        ResearchCandidate.candidate_id == first.candidate_id
                    )
                ).scalar_one()
                second_candidate = session.execute(
                    select(ResearchCandidate).where(
                        ResearchCandidate.candidate_id == second.candidate_id
                    )
                ).scalar_one()
                demotion_row = session.execute(
                    select(ResearchPromotion).where(
                        ResearchPromotion.candidate_id == first.candidate_id,
                        ResearchPromotion.decision_action == "demote",
                        ResearchPromotion.successor_candidate_id == second.candidate_id,
                    )
                ).scalar_one_or_none()

            self.assertEqual(second_candidate.lifecycle_role, "champion")
            self.assertEqual(second_candidate.lifecycle_status, "active")
            self.assertEqual(first_candidate.lifecycle_role, "demoted")
            self.assertEqual(first_candidate.lifecycle_status, "standby")
            self.assertIsNotNone(demotion_row)
            assert demotion_row is not None
            self.assertEqual(demotion_row.rollback_candidate_id, first.candidate_id)

    def test_lane_marks_hold_recommendation_as_retained_challenger(self) -> None:
        fixture_path = Path(__file__).parent / "fixtures" / "walkforward_signals.json"
        strategy_config_path = (
            Path(__file__).parent.parent / "config" / "autonomous-strategy-sample.yaml"
        )
        gate_policy_path = (
            Path(__file__).parent.parent / "config" / "autonomous-gate-policy.json"
        )
        engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            future=True,
            connect_args={"check_same_thread": False},
        )
        Base.metadata.create_all(engine)
        session_factory = sessionmaker(bind=engine, expire_on_commit=False, future=True)

        forced_gate = GateEvaluationReport(
            policy_version="v3-gates-1",
            promotion_target="paper",
            promotion_allowed=True,
            recommended_mode="paper",
            gates=[
                GateResult(gate_id="gate0_data_integrity", status="pass"),
                GateResult(gate_id="gate1_statistical_robustness", status="pass"),
                GateResult(gate_id="gate2_risk_capacity", status="pass"),
                GateResult(gate_id="gate3_shadow_paper_quality", status="pass"),
                GateResult(gate_id="gate4_operational_readiness", status="pass"),
                GateResult(gate_id="gate6_profitability_evidence", status="pass"),
                GateResult(gate_id="gate5_live_ramp_readiness", status="pass"),
            ],
            reasons=[],
            uncertainty_gate_action="pass",
            coverage_error="0.02",
            conformal_interval_width="1.00",
            shift_score="0.10",
            recalibration_run_id=None,
            evaluated_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
            code_version="test-sha",
        )
        with tempfile.TemporaryDirectory() as tmpdir:
            with patch(
                "app.trading.autonomy.lane.evaluate_gate_matrix",
                return_value=forced_gate,
            ):
                with patch(
                    "app.trading.autonomy.lane.build_promotion_recommendation",
                    return_value=PromotionRecommendation(
                        action="hold",
                        requested_mode="paper",
                        recommended_mode="shadow",
                        eligible=True,
                        rationale="hold_for_shadow_stage",
                        reasons=["shadow_mode_recommended"],
                        evidence=PromotionEvidenceSummary(
                            fold_metrics_count=1,
                            stress_metrics_count=4,
                            rationale_present=True,
                            evidence_complete=True,
                            reasons=[],
                        ),
                        trace_id="forced-hold-trace",
                    ),
                ):
                    result = run_autonomous_lane(
                        signals_path=fixture_path,
                        strategy_config_path=strategy_config_path,
                        gate_policy_path=gate_policy_path,
                        output_dir=Path(tmpdir) / "lane-hold",
                        promotion_target="paper",
                        code_version="test-sha",
                        persist_results=True,
                        session_factory=session_factory,
                    )

        with session_factory() as session:
            candidate = session.execute(
                select(ResearchCandidate).where(
                    ResearchCandidate.candidate_id == result.candidate_id
                )
            ).scalar_one()

        self.assertEqual(candidate.lifecycle_role, "challenger")
        self.assertEqual(candidate.lifecycle_status, "evaluated")
        self.assertIsInstance(candidate.universe_definition, dict)
        assert isinstance(candidate.universe_definition, dict)
        lifecycle = candidate.universe_definition.get("autonomy_lifecycle")
        self.assertIsInstance(lifecycle, dict)
        assert isinstance(lifecycle, dict)
        self.assertEqual(lifecycle.get("status"), "retained_challenger")

    def test_build_phase_manifest_has_canonical_phase_order_and_transitions(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            signals = [
                SignalEnvelope(
                    event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
                    symbol="AAPL",
                    timeframe="1Min",
                    payload={},
                )
            ]
            output_dir = Path(tmpdir) / "manifest"
            gate_report = GateEvaluationReport(
                policy_version="v3-gates-1",
                promotion_target="paper",
                promotion_allowed=True,
                recommended_mode="paper",
                gates=[GateResult(gate_id="gate0_data_integrity", status="pass")],
                reasons=[],
                uncertainty_gate_action="pass",
                coverage_error="0.01",
                conformal_interval_width="1.0",
                shift_score="0.1",
                recalibration_run_id=None,
                evaluated_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
                code_version="test-sha",
            )
            manifest = _build_phase_manifest(
                run_id="run-123",
                candidate_id="cand-1",
                evaluated_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
                output_dir=output_dir,
                signals=signals,
                requested_promotion_target="paper",
                gate_report=gate_report,
                gate_report_payload={
                    "gates": [],
                    "recommended_mode": "paper",
                    "throughput": {
                        "signal_count": 1,
                        "decision_count": 1,
                        "trade_count": 0,
                    },
                },
                gate_report_path=output_dir / "gate-evaluation.json",
                promotion_check=PromotionPrerequisiteResult(
                    allowed=True,
                    reasons=[],
                    required_artifacts=[],
                    missing_artifacts=[],
                    reason_details=[],
                    artifact_refs=[],
                    required_throughput={"signal_count": 1, "decision_count": 1},
                    observed_throughput={"signal_count": 1, "decision_count": 1},
                ),
                rollback_check=RollbackReadinessResult(
                    ready=True,
                    reasons=[],
                    required_checks=[],
                    missing_checks=[],
                ),
                drift_gate_check={"allowed": True, "reasons": []},
                patch_path=output_dir / "paper-candidate" / "strategy-configmap-patch.yaml",
                recommended_mode="paper",
                promotion_reasons=[],
                governance_inputs={
                    "execution_context": {
                        "repository": "acme/torghut",
                        "base": "main",
                        "head": "paper-path",
                        "artifactPath": str(output_dir),
                        "priorityId": "p1",
                    }
                },
                drift_promotion_evidence=None,
            )

            self.assertEqual(manifest["status"], "pass")
            self.assertEqual(manifest["phase_count"], len(_AUTONOMY_PHASE_ORDER))
            self.assertEqual(
                [phase["name"] for phase in manifest["phases"]],
                list(_AUTONOMY_PHASE_ORDER),
            )
            self.assertEqual(
                manifest["phase_transitions"],
                [
                    {"from": "gate-evaluation", "to": "promotion-prerequisites", "status": "pass"},
                    {"from": "promotion-prerequisites", "to": "rollback-readiness", "status": "pass"},
                    {"from": "rollback-readiness", "to": "drift-gate", "status": "pass"},
                    {"from": "drift-gate", "to": "paper-canary", "status": "pass"},
                    {"from": "paper-canary", "to": "runtime-governance", "status": "skipped"},
                    {"from": "runtime-governance", "to": "rollback-proof", "status": "pass"},
                ],
            )
            self.assertEqual(
                manifest["execution_context"], {
                    "repository": "acme/torghut",
                    "base": "main",
                    "head": "paper-path",
                    "artifactPath": str(output_dir),
                    "priorityId": "p1",
                }
            )
            gate_transition_statuses = {phase["name"]: phase["status"] for phase in manifest["phases"]}
            self.assertEqual(gate_transition_statuses["runtime-governance"], "skipped")
            self.assertEqual(gate_transition_statuses["rollback-proof"], "pass")

    def test_build_phase_manifest_defaults_execution_context_artifact_path(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            signals = [
                SignalEnvelope(
                    event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
                    symbol="AAPL",
                    timeframe="1Min",
                    payload={},
                )
            ]
            output_dir = Path(tmpdir) / "manifest-default-artifact-path"
            gate_report = GateEvaluationReport(
                policy_version="v3-gates-1",
                promotion_target="paper",
                promotion_allowed=True,
                recommended_mode="paper",
                gates=[GateResult(gate_id="gate0_data_integrity", status="pass")],
                reasons=[],
                uncertainty_gate_action="pass",
                coverage_error="0.01",
                conformal_interval_width="1.0",
                shift_score="0.1",
                recalibration_run_id=None,
                evaluated_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
                code_version="test-sha",
            )
            manifest = _build_phase_manifest(
                run_id="run-126",
                candidate_id="cand-4",
                evaluated_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
                output_dir=output_dir,
                signals=signals,
                requested_promotion_target="paper",
                gate_report=gate_report,
                gate_report_payload={
                    "gates": [],
                    "recommended_mode": "paper",
                    "throughput": {
                        "signal_count": 1,
                        "decision_count": 1,
                        "trade_count": 0,
                    },
                },
                gate_report_path=output_dir / "gate-evaluation.json",
                promotion_check=PromotionPrerequisiteResult(
                    allowed=True,
                    reasons=[],
                    required_artifacts=[],
                    missing_artifacts=[],
                    reason_details=[],
                    artifact_refs=[],
                    required_throughput={"signal_count": 1, "decision_count": 1},
                    observed_throughput={"signal_count": 1, "decision_count": 1},
                ),
                rollback_check=RollbackReadinessResult(
                    ready=True,
                    reasons=[],
                    required_checks=[],
                    missing_checks=[],
                ),
                drift_gate_check={"allowed": True, "reasons": []},
                patch_path=output_dir / "paper-candidate" / "strategy-configmap-patch.yaml",
                recommended_mode="paper",
                promotion_reasons=[],
                governance_inputs=None,
                drift_promotion_evidence=None,
            )

            self.assertEqual(
                manifest["execution_context"]["artifactPath"],
                str(output_dir),
            )

    def test_build_phase_manifest_marks_live_canary_slo_as_skipped(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            signals = [
                SignalEnvelope(
                    event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
                    symbol="AAPL",
                    timeframe="1Min",
                    payload={},
                )
            ]
            output_dir = Path(tmpdir) / "manifest-live-canary-skip"
            gate_report = GateEvaluationReport(
                policy_version="v3-gates-1",
                promotion_target="live",
                promotion_allowed=True,
                recommended_mode="live",
                gates=[GateResult(gate_id="gate0_data_integrity", status="pass")],
                reasons=[],
                uncertainty_gate_action="pass",
                coverage_error="0.01",
                conformal_interval_width="1.0",
                shift_score="0.1",
                recalibration_run_id=None,
                evaluated_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
                code_version="test-sha",
            )
            manifest = _build_phase_manifest(
                run_id="run-127",
                candidate_id="cand-5",
                evaluated_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
                output_dir=output_dir,
                signals=signals,
                requested_promotion_target="live",
                gate_report=gate_report,
                gate_report_payload={
                    "gates": [],
                    "recommended_mode": "live",
                    "throughput": {
                        "signal_count": 1,
                        "decision_count": 1,
                        "trade_count": 0,
                    },
                },
                gate_report_path=output_dir / "gate-evaluation.json",
                promotion_check=PromotionPrerequisiteResult(
                    allowed=True,
                    reasons=[],
                    required_artifacts=[],
                    missing_artifacts=[],
                    reason_details=[],
                    artifact_refs=[],
                    required_throughput={"signal_count": 1, "decision_count": 1},
                    observed_throughput={"signal_count": 1, "decision_count": 1},
                ),
                rollback_check=RollbackReadinessResult(
                    ready=True,
                    reasons=[],
                    required_checks=[],
                    missing_checks=[],
                ),
                drift_gate_check={"allowed": True, "reasons": []},
                patch_path=None,
                recommended_mode="live",
                promotion_reasons=[],
                governance_inputs=None,
                drift_promotion_evidence=None,
            )

            canary_phase = manifest["phases"][4]
            self.assertEqual(canary_phase["name"], "paper-canary")
            self.assertEqual(canary_phase["status"], "skipped")
            self.assertEqual(
                canary_phase["slo_gates"][0]["status"],
                "skipped",
            )

    def test_build_phase_manifest_reports_gate_failure(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            signals = [
                SignalEnvelope(
                    event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
                    symbol="AAPL",
                    timeframe="1Min",
                    payload={},
                )
            ]
            output_dir = Path(tmpdir) / "manifest-fail"
            gate_report = GateEvaluationReport(
                policy_version="v3-gates-1",
                promotion_target="paper",
                promotion_allowed=False,
                recommended_mode="shadow",
                gates=[GateResult(gate_id="gate0_data_integrity", status="fail")],
                reasons=["gate0_data_integrity"],
                uncertainty_gate_action="pass",
                coverage_error="0.01",
                conformal_interval_width="1.0",
                shift_score="0.1",
                recalibration_run_id=None,
                evaluated_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
                code_version="test-sha",
            )
            manifest = _build_phase_manifest(
                run_id="run-124",
                candidate_id="cand-2",
                evaluated_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
                output_dir=output_dir,
                signals=signals,
                requested_promotion_target="paper",
                gate_report=gate_report,
                gate_report_payload={
                    "gates": [],
                    "recommended_mode": "shadow",
                    "throughput": {
                        "signal_count": 0,
                        "decision_count": 0,
                        "trade_count": 0,
                    },
                },
                gate_report_path=output_dir / "gate-evaluation.json",
                promotion_check=PromotionPrerequisiteResult(
                    allowed=False,
                    reasons=["missing_artifacts"],
                    required_artifacts=["gates/promotion-evidence-gate.json"],
                    missing_artifacts=["gates/promotion-evidence-gate.json"],
                    reason_details=[{"artifact": "gates/promotion-evidence-gate.json"}],
                    artifact_refs=[],
                    required_throughput={"signal_count": 1, "decision_count": 1},
                    observed_throughput={"signal_count": 0, "decision_count": 0},
                ),
                rollback_check=RollbackReadinessResult(
                    ready=True,
                    reasons=[],
                    required_checks=[],
                    missing_checks=[],
                ),
                drift_gate_check={"allowed": False, "reasons": ["drift_data_missing"]},
                patch_path=None,
                recommended_mode="shadow",
                promotion_reasons=["gate_failed"],
                governance_inputs={},
                drift_promotion_evidence=None,
            )

            self.assertEqual(manifest["status"], "fail")
            self.assertEqual(manifest["phases"][0]["status"], "fail")
            self.assertEqual(manifest["phases"][4]["status"], "fail")

    def test_build_phase_manifest_updates_rollback_proof_when_triggered(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            signals = [
                SignalEnvelope(
                    event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
                    symbol="AAPL",
                    timeframe="1Min",
                    payload={},
                )
            ]
            output_dir = Path(tmpdir) / "manifest-rollback"
            output_dir.mkdir(parents=True, exist_ok=True)
            rollback_evidence = output_dir / "rollback-evidence.json"
            rollback_evidence.write_text("{}", encoding="utf-8")
            gate_report = GateEvaluationReport(
                policy_version="v3-gates-1",
                promotion_target="paper",
                promotion_allowed=True,
                recommended_mode="paper",
                gates=[GateResult(gate_id="gate0_data_integrity", status="pass")],
                reasons=[],
                uncertainty_gate_action="pass",
                coverage_error="0.01",
                conformal_interval_width="1.0",
                shift_score="0.1",
                recalibration_run_id=None,
                evaluated_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
                code_version="test-sha",
            )
            manifest = _build_phase_manifest(
                run_id="run-125",
                candidate_id="cand-3",
                evaluated_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
                output_dir=output_dir,
                signals=signals,
                requested_promotion_target="paper",
                gate_report=gate_report,
                gate_report_payload={
                    "gates": [],
                    "recommended_mode": "paper",
                    "throughput": {
                        "signal_count": 1,
                        "decision_count": 1,
                        "trade_count": 0,
                    },
                },
                gate_report_path=output_dir / "gate-evaluation.json",
                promotion_check=PromotionPrerequisiteResult(
                    allowed=True,
                    reasons=[],
                    required_artifacts=[],
                    missing_artifacts=[],
                    reason_details=[],
                    artifact_refs=[],
                    required_throughput={"signal_count": 1, "decision_count": 1},
                    observed_throughput={"signal_count": 1, "decision_count": 1},
                ),
                rollback_check=RollbackReadinessResult(
                    ready=True,
                    reasons=[],
                    required_checks=[],
                    missing_checks=[],
                ),
                drift_gate_check={"allowed": True, "reasons": []},
                patch_path=output_dir / "paper-candidate" / "strategy-configmap-patch.yaml",
                recommended_mode="paper",
                promotion_reasons=[],
                governance_inputs={
                    "execution_context": {
                        "repository": "acme/torghut",
                        "base": "main",
                        "head": "paper-path",
                        "artifactPath": str(output_dir),
                        "priorityId": "p1",
                    },
                    "runtime_governance": {
                        "governance_status": "fail",
                        "artifact_refs": ["runtime-check.json"],
                        "drift_status": "drift_detected",
                        "rollback_triggered": True,
                    },
                    "rollback_proof": {
                        "rollback_triggered": True,
                        "rollback_incident_evidence_path": str(rollback_evidence),
                    },
                },
                drift_promotion_evidence=None,
            )

            runtime = manifest["runtime_governance"]
            rollback = manifest["rollback_proof"]
            self.assertEqual(runtime.get("governance_status"), "fail")
            self.assertEqual(manifest["phases"][5]["status"], "fail")
            self.assertEqual(manifest["phases"][6]["status"], "pass")
            self.assertEqual(
                rollback.get("rollback_incident_evidence_path"),
                str(rollback_evidence),
            )
            self.assertIn(str(rollback_evidence), manifest["artifact_refs"])

    def test_coerce_phase_status_unknown_status_fails(self) -> None:
        self.assertEqual(coerce_phase_status("blocked"), "fail")
        self.assertEqual(
            coerce_phase_status("blocked", default="skip"),
            "skip",
        )
