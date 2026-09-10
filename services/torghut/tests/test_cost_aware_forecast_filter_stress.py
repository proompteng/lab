from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal
from unittest import TestCase

from app.trading.discovery.cost_aware_forecast_filter_stress import (
    build_cost_aware_forecast_filter_stress_schema_hash,
    cost_aware_forecast_filter_stress_contract,
    extract_cost_aware_forecast_filter_stress,
)
from app.trading.models import SignalEnvelope


class TestCostAwareForecastFilterStress(TestCase):
    def _row(
        self,
        *,
        offset: int,
        forecast_bps: str | None,
        cost_bps: str = "4",
        action: str = "hold",
        fold: str | None = "wf-1",
        multi_scale: bool = True,
        variable_selection: bool = True,
    ) -> SignalEnvelope:
        payload: dict[str, object] = {
            "transaction_cost_bps": Decimal(cost_bps),
            "trade_action": action,
            "spread_bps": Decimal("2"),
        }
        if forecast_bps is not None:
            payload["forecast_return_bps"] = Decimal(forecast_bps)
        if fold is not None:
            payload["walk_forward_fold_id"] = fold
        if multi_scale:
            payload["multi_scale_trend_score"] = Decimal("0.72")
            payload["trend_scales"] = {"short": "up", "medium": "up", "long": "flat"}
        if variable_selection:
            payload["dynamic_variable_weights"] = {
                "dxy": "0.31",
                "rates": "0.22",
                "vol": "0.18",
            }
        return SignalEnvelope(
            event_ts=datetime(2026, 5, 19, 14, 30, tzinfo=timezone.utc)
            + timedelta(minutes=offset),
            symbol="COST",
            timeframe="1Min",
            seq=offset,
            source="cost-aware-forecast-filter-fixture",
            payload=payload,
            ingest_ts=datetime(2026, 5, 19, 14, 31, tzinfo=timezone.utc),
        )

    def test_cost_filter_downranks_weak_forecast_churn(self) -> None:
        filtered = extract_cost_aware_forecast_filter_stress(
            (
                self._row(offset=1, forecast_bps="12", action="buy", fold="wf-1"),
                self._row(offset=2, forecast_bps="10", action="buy", fold="wf-2"),
                self._row(offset=3, forecast_bps="8", action="buy", fold="wf-3"),
                self._row(offset=4, forecast_bps="3", action="hold", fold="wf-3"),
            )
        )
        churny = extract_cost_aware_forecast_filter_stress(
            (
                self._row(
                    offset=1,
                    forecast_bps="1.0",
                    action="buy",
                    fold=None,
                    multi_scale=False,
                    variable_selection=False,
                ),
                self._row(
                    offset=2,
                    forecast_bps="1.2",
                    action="sell",
                    fold=None,
                    multi_scale=False,
                    variable_selection=False,
                ),
                self._row(
                    offset=3,
                    forecast_bps="0.8",
                    action="buy",
                    fold=None,
                    multi_scale=False,
                    variable_selection=False,
                ),
                self._row(
                    offset=4,
                    forecast_bps="0.5",
                    action="sell",
                    fold=None,
                    multi_scale=False,
                    variable_selection=False,
                ),
            )
        )

        self.assertGreater(filtered.cost_clearance_share, churny.cost_clearance_share)
        self.assertLess(
            filtered.weak_forecast_trade_share, churny.weak_forecast_trade_share
        )
        self.assertGreater(
            filtered.cost_filtered_action_agreement_share,
            churny.cost_filtered_action_agreement_share,
        )
        self.assertLess(filtered.turnover_churn_score, churny.turnover_churn_score)
        self.assertGreater(
            filtered.walk_forward_coverage_score,
            churny.walk_forward_coverage_score,
        )
        self.assertGreater(
            filtered.multi_scale_feature_coverage,
            churny.multi_scale_feature_coverage,
        )
        self.assertGreater(
            filtered.dynamic_variable_selection_coverage,
            churny.dynamic_variable_selection_coverage,
        )
        self.assertGreater(
            churny.replay_rank_penalty_bps,
            filtered.replay_rank_penalty_bps,
        )
        payload = churny.to_payload()
        self.assertEqual(
            payload["status"],
            "preview_only_cost_aware_forecast_filter_stress_ranking",
        )
        self.assertTrue(payload["cost_threshold_trade_filter_preview"])
        self.assertFalse(payload["proof_authority"])
        self.assertFalse(payload["promotion_authority"])
        self.assertFalse(payload["final_authority_ok"])

    def test_missing_inputs_fail_closed_and_contract_rejects_pnl_authority(
        self,
    ) -> None:
        summary = extract_cost_aware_forecast_filter_stress(
            (
                self._row(
                    offset=1,
                    forecast_bps=None,
                    action="hold",
                    fold=None,
                    multi_scale=False,
                    variable_selection=False,
                ),
            )
        )
        payload = summary.to_payload()
        contract = cost_aware_forecast_filter_stress_contract()
        source_ids = {source["source_id"] for source in payload["source_papers"]}

        self.assertEqual(
            payload["feature_schema_hash"],
            build_cost_aware_forecast_filter_stress_schema_hash(),
        )
        self.assertIn("arxiv-2606.00060", source_ids)
        self.assertIn("arxiv-2512.12727", source_ids)
        self.assertIn("missing_forecast_magnitude_inputs", payload["warnings"])
        self.assertIn("missing_walk_forward_fold_inputs", payload["warnings"])
        self.assertTrue(contract["proof_neutrality"]["requires_exact_replay"])
        self.assertTrue(contract["proof_neutrality"]["requires_route_tca"])
        self.assertTrue(
            contract["proof_neutrality"]["requires_order_lifecycle_fill_evidence"]
        )
        self.assertTrue(contract["proof_neutrality"]["requires_runtime_ledger"])
        self.assertTrue(
            contract["proof_neutrality"]["rejects_gross_forecast_return_as_pnl_proof"]
        )
        self.assertTrue(
            contract["proof_neutrality"][
                "rejects_cost_filtered_preview_as_promotion_authority"
            ]
        )
        self.assertFalse(payload["promotion_authority"])
        self.assertFalse(contract["proof_neutrality"]["promotion_proof"])
