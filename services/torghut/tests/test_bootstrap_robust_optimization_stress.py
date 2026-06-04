from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal
from unittest import TestCase

from app.trading.discovery.bootstrap_robust_optimization_stress import (
    bootstrap_robust_optimization_stress_contract,
    build_bootstrap_robust_optimization_stress_schema_hash,
    extract_bootstrap_robust_optimization_stress,
)
from app.trading.models import SignalEnvelope


class TestBootstrapRobustOptimizationStress(TestCase):
    def _row(
        self,
        *,
        offset: int,
        utility_bps: str | None,
        fold: str | None = "wf-1",
        parameter_set: str | None = "params-a",
        trial_count: int | None = 24,
        selection_rank: int | None = 1,
    ) -> SignalEnvelope:
        payload: dict[str, object] = {}
        if utility_bps is not None:
            payload["post_cost_utility_bps"] = Decimal(utility_bps)
        if fold is not None:
            payload["walk_forward_fold_id"] = fold
        if parameter_set is not None:
            payload["parameter_set_id"] = parameter_set
        if trial_count is not None:
            payload["effective_trial_count"] = Decimal(trial_count)
        if selection_rank is not None:
            payload["selection_rank"] = Decimal(selection_rank)
        return SignalEnvelope(
            event_ts=datetime(2026, 4, 16, 14, 30, tzinfo=timezone.utc)
            + timedelta(minutes=offset),
            symbol="BOOT",
            timeframe="1Min",
            seq=offset,
            source="bootstrap-robust-optimization-fixture",
            payload=payload,
            ingest_ts=datetime(2026, 4, 16, 14, 31, tzinfo=timezone.utc),
        )

    def test_bootstrap_stress_downranks_unstable_selected_searches(self) -> None:
        robust = extract_bootstrap_robust_optimization_stress(
            (
                self._row(offset=1, utility_bps="8", fold="wf-1", parameter_set="a"),
                self._row(offset=2, utility_bps="7", fold="wf-2", parameter_set="a"),
                self._row(offset=3, utility_bps="9", fold="wf-3", parameter_set="b"),
                self._row(offset=4, utility_bps="8", fold="wf-4", parameter_set="b"),
            ),
            candidate_count=4,
        )
        fragile = extract_bootstrap_robust_optimization_stress(
            (
                self._row(offset=1, utility_bps="18", fold="wf-1", parameter_set="a"),
                self._row(offset=2, utility_bps="-9", fold="wf-1", parameter_set="b"),
                self._row(offset=3, utility_bps="16", fold="wf-1", parameter_set="a"),
                self._row(offset=4, utility_bps="-12", fold="wf-1", parameter_set="b"),
            ),
            candidate_count=80,
        )

        self.assertGreater(
            robust.robust_utility_for_ranking_bps,
            fragile.robust_utility_for_ranking_bps,
        )
        self.assertGreater(
            fragile.parameter_instability_score,
            robust.parameter_instability_score,
        )
        self.assertGreater(
            fragile.selection_bias_stress_score,
            robust.selection_bias_stress_score,
        )
        self.assertGreater(
            fragile.replay_rank_penalty_bps, robust.replay_rank_penalty_bps
        )
        payload = fragile.to_payload()
        self.assertEqual(
            payload["status"],
            "preview_only_bootstrap_robust_optimization_stress_ranking",
        )
        self.assertTrue(payload["stationary_block_bootstrap_preview"])
        self.assertFalse(payload["proof_authority"])
        self.assertFalse(payload["promotion_authority"])
        self.assertFalse(payload["final_authority_ok"])

    def test_missing_inputs_fail_closed_and_contract_rejects_pnl_authority(
        self,
    ) -> None:
        summary = extract_bootstrap_robust_optimization_stress(
            (self._row(offset=1, utility_bps=None, fold=None, parameter_set=None),)
        )
        payload = summary.to_payload()
        contract = bootstrap_robust_optimization_stress_contract()
        source_ids = {source["source_id"] for source in payload["source_papers"]}

        self.assertEqual(
            payload["feature_schema_hash"],
            build_bootstrap_robust_optimization_stress_schema_hash(),
        )
        self.assertIn("arxiv-2510.12725", source_ids)
        self.assertIn("arxiv-2604.15531", source_ids)
        self.assertIn("missing_post_cost_utility_inputs", payload["warnings"])
        self.assertIn("missing_walk_forward_fold_inputs", payload["warnings"])
        self.assertTrue(contract["proof_neutrality"]["requires_exact_replay"])
        self.assertTrue(contract["proof_neutrality"]["requires_route_tca"])
        self.assertTrue(
            contract["proof_neutrality"]["requires_order_lifecycle_fill_evidence"]
        )
        self.assertTrue(contract["proof_neutrality"]["requires_runtime_ledger"])
        self.assertTrue(
            contract["proof_neutrality"][
                "rejects_bootstrap_percentile_utility_as_pnl_proof"
            ]
        )
        self.assertTrue(
            contract["proof_neutrality"][
                "rejects_selection_bias_falsification_preview_as_promotion_authority"
            ]
        )
        self.assertFalse(payload["promotion_authority"])
        self.assertFalse(contract["proof_neutrality"]["promotion_proof"])
