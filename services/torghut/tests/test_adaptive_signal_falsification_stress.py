from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from unittest import TestCase

from app.trading.discovery.adaptive_signal_falsification_stress import (
    adaptive_signal_falsification_stress_contract,
    build_adaptive_signal_falsification_stress_schema_hash,
    extract_adaptive_signal_falsification_stress,
)
from app.trading.discovery.evidence_bundles import (
    EVIDENCE_BUNDLE_SCHEMA_VERSION,
    CandidateEvidenceBundle,
    evidence_bundle_blockers,
)
from app.trading.models import SignalEnvelope


class TestAdaptiveSignalFalsificationStress(TestCase):
    def test_materialized_falsification_patch_satisfies_adaptive_blockers(self) -> None:
        candidate_returns = [0.02, 0.018, 0.019, 0.021]
        null_sets = [[0.0, 0.0001, -0.0001] for _ in range(120)]
        summary = extract_adaptive_signal_falsification_stress(
            candidate_returns,
            null_model_record_sets=null_sets,
            incumbent_records=[0.01, 0.01, 0.01, 0.01],
            candidate_id="adaptive-factor-fixture",
            artifact_ref="artifact://adaptive-signal-falsification/fixture-pass",
            effective_test_count=1,
            leakage_probe_passed=True,
        )
        payload = summary.to_payload()

        self.assertTrue(summary.adaptive_signal_falsification_passed)
        self.assertTrue(payload["objective_scorecard_patch"]["negative_control_passed"])
        self.assertTrue(payload["null_comparator_patch"]["baseline_outperformed"])
        self.assertLessEqual(
            payload["objective_scorecard_patch"][
                "effective_multiplicity_adjusted_p_value"
            ],
            0.05,
        )
        self.assertFalse(payload["proof_authority"])
        self.assertFalse(payload["promotion_authority"])
        self.assertFalse(payload["final_authority_ok"])
        self.assertIn(
            "spurious_predictability_arxiv_2604_15531_2026",
            payload["source_markers"],
        )

        bundle = CandidateEvidenceBundle(
            schema_version=EVIDENCE_BUNDLE_SCHEMA_VERSION,
            evidence_bundle_id="ev-adaptive-falsification-pass",
            candidate_id="candidate-adaptive-pass",
            candidate_spec_id="spec-adaptive-pass",
            dataset_snapshot_id="snapshot-adaptive-pass",
            feature_spec_hash="feature-adaptive-pass",
            code_commit="commit-adaptive-pass",
            replay_artifact_refs=("artifact://replay",),
            objective_scorecard={
                "market_impact_stress_passed": True,
                "market_impact_stress_artifact_ref": "artifact://market-impact",
                "market_impact_stress_model": "nonlinear_square_root_impact",
                "market_impact_stress_cost_bps": "1",
                "market_impact_stress_net_pnl_per_day": "600",
                "market_impact_liquidity_evidence_present": True,
                **payload["objective_scorecard_patch"],
            },
            fold_metrics=(),
            stress_metrics=(),
            cost_calibration={"status": "calibrated", "source": "route_tca"},
            null_comparator=payload["null_comparator_patch"],
            promotion_readiness={
                "stage": "paper_probation",
                "status": "promotion_ready",
                "promotable": True,
            },
        )

        blockers = evidence_bundle_blockers(bundle)

        self.assertNotIn("adaptive_signal_falsification_missing_or_failed", blockers)
        self.assertNotIn("adaptive_signal_falsification_artifact_missing", blockers)
        self.assertNotIn("adaptive_signal_baseline_not_outperformed", blockers)
        self.assertNotIn("effective_multiplicity_adjusted_p_value_above_max", blockers)
        self.assertIn("delay_adjusted_depth_stress_failed", blockers)

    def test_null_like_candidate_fails_closed_with_reasons(self) -> None:
        summary = extract_adaptive_signal_falsification_stress(
            [0.001, -0.001, 0.0],
            null_model_record_sets=[[0.001, 0.0, 0.0] for _ in range(12)],
            incumbent_records=[0.002, 0.0, 0.0],
            candidate_id="adaptive-factor-null-like",
            effective_test_count=20,
            leakage_probe_passed=False,
        )
        payload = summary.to_payload()

        self.assertFalse(summary.adaptive_signal_falsification_passed)
        self.assertFalse(
            payload["objective_scorecard_patch"]["negative_control_passed"]
        )
        self.assertFalse(payload["objective_scorecard_patch"]["leakage_probe_passed"])
        self.assertGreater(
            payload["objective_scorecard_patch"][
                "effective_multiplicity_adjusted_p_value"
            ],
            0.05,
        )
        self.assertIn("null_model_sample_count_below_min", payload["warnings"])
        self.assertIn("leakage_probe_missing_or_failed", payload["warnings"])
        self.assertFalse(payload["promotion_allowed"])

    def test_contract_and_signal_envelope_extraction_are_proof_neutral(self) -> None:
        row = SignalEnvelope(
            event_ts=datetime(2026, 4, 16, 14, 30, tzinfo=timezone.utc),
            symbol="ASF",
            source="adaptive-falsification-fixture",
            payload={"post_cost_net_return": Decimal("0.01")},
        )
        summary = extract_adaptive_signal_falsification_stress(
            [
                row,
                {"payload": {"post_cost_net_return": "0.012"}},
                {"port_ret_net": "0.011"},
            ],
            null_model_record_sets=[[{"post_cost_net_return": "0"}] for _ in range(30)],
            incumbent_records=[{"post_cost_net_return": "0.005"}],
            effective_test_count=1,
            leakage_probe_passed=True,
        )
        payload = summary.to_payload()
        contract = adaptive_signal_falsification_stress_contract()

        self.assertEqual(
            payload["feature_schema_hash"],
            build_adaptive_signal_falsification_stress_schema_hash(),
        )
        self.assertEqual(summary.candidate_sample_count, 3)
        self.assertEqual(summary.null_model_sample_count, 30)
        self.assertTrue(contract["proof_neutrality"]["requires_exact_replay"])
        self.assertTrue(contract["proof_neutrality"]["requires_route_tca"])
        self.assertTrue(contract["proof_neutrality"]["requires_runtime_ledger"])
        self.assertTrue(
            contract["proof_neutrality"][
                "rejects_adaptive_specification_search_as_profit_proof"
            ]
        )
        self.assertFalse(contract["proof_neutrality"]["promotion_proof"])
        self.assertFalse(payload["promotion_proof"])
