from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal
from unittest import TestCase

from app.trading.discovery.nonlinear_impact_execution_stress import (
    build_nonlinear_impact_execution_stress_schema_hash,
    extract_nonlinear_impact_execution_stress,
    nonlinear_impact_execution_stress_contract,
)
from app.trading.models import SignalEnvelope


class TestNonlinearImpactExecutionStress(TestCase):
    def _row(
        self,
        *,
        offset: int,
        price: str,
        volume: str,
        spread_bps: str = "1.0",
        decay_half_life_events: str = "8",
    ) -> SignalEnvelope:
        mid = Decimal(price)
        return SignalEnvelope(
            event_ts=datetime(2026, 3, 30, 14, 30, tzinfo=timezone.utc)
            + timedelta(milliseconds=offset * 100),
            symbol="IMPACT",
            timeframe="100ms",
            seq=offset,
            source="nonlinear-impact-fixture",
            payload={
                "price": mid,
                "bid": mid - Decimal("0.01"),
                "ask": mid + Decimal("0.01"),
                "spread_bps": Decimal(spread_bps),
                "microbar_volume": Decimal(volume),
                "impact_decay_half_life_events": Decimal(decay_half_life_events),
            },
            ingest_ts=datetime(2026, 3, 30, 14, 31, tzinfo=timezone.utc),
        )

    def test_nonlinear_impact_stress_penalizes_high_participation_decay(
        self,
    ) -> None:
        liquid = extract_nonlinear_impact_execution_stress(
            (
                self._row(offset=1, price="100.00", volume="200000"),
                self._row(offset=2, price="100.01", volume="210000"),
                self._row(offset=3, price="100.02", volume="220000"),
                self._row(offset=4, price="100.03", volume="205000"),
                self._row(offset=5, price="100.04", volume="215000"),
            ),
            direction=1,
            max_notional=10_000,
        )
        crowded = extract_nonlinear_impact_execution_stress(
            (
                self._row(
                    offset=1,
                    price="100.00",
                    volume="500",
                    spread_bps="4.0",
                    decay_half_life_events="30",
                ),
                self._row(
                    offset=2,
                    price="99.95",
                    volume="450",
                    spread_bps="4.5",
                    decay_half_life_events="30",
                ),
                self._row(
                    offset=3,
                    price="99.90",
                    volume="400",
                    spread_bps="5.0",
                    decay_half_life_events="30",
                ),
                self._row(
                    offset=4,
                    price="99.82",
                    volume="380",
                    spread_bps="5.0",
                    decay_half_life_events="30",
                ),
                self._row(
                    offset=5,
                    price="99.78",
                    volume="350",
                    spread_bps="5.5",
                    decay_half_life_events="30",
                ),
            ),
            direction=1,
            max_notional=50_000,
        )

        self.assertGreater(
            crowded.median_participation_rate, liquid.median_participation_rate
        )
        self.assertGreater(
            crowded.high_participation_share, liquid.high_participation_share
        )
        self.assertGreater(
            crowded.square_root_impact_cost_bps, liquid.square_root_impact_cost_bps
        )
        self.assertGreater(
            crowded.permanent_impact_residual_bps, liquid.permanent_impact_residual_bps
        )
        self.assertGreater(
            crowded.adverse_decay_reversal_share, liquid.adverse_decay_reversal_share
        )
        self.assertGreater(
            crowded.replay_rank_penalty_bps, liquid.replay_rank_penalty_bps
        )
        payload = crowded.to_payload()
        self.assertEqual(
            payload["status"],
            "preview_only_nonlinear_impact_execution_stress_ranking",
        )
        self.assertTrue(payload["square_root_market_impact_preview"])
        self.assertTrue(payload["permanent_impact_decay_preview"])
        self.assertTrue(payload["trade_level_logging_required_downstream"])
        self.assertFalse(payload["proof_authority"])
        self.assertFalse(payload["promotion_authority"])
        self.assertFalse(payload["final_authority_ok"])

    def test_contract_embeds_sources_and_keeps_proof_fail_closed(self) -> None:
        contract = nonlinear_impact_execution_stress_contract()
        payload = extract_nonlinear_impact_execution_stress(
            (
                self._row(offset=1, price="100.00", volume="1000"),
                self._row(offset=2, price="100.01", volume="1000"),
            ),
            max_notional=5_000,
        ).to_payload()

        source_ids = {source["source_id"] for source in contract["source_papers"]}
        self.assertIn("arxiv-2603.29086", source_ids)
        self.assertIn("arxiv-2502.16246", source_ids)
        proof_neutrality = contract["proof_neutrality"]
        self.assertTrue(proof_neutrality["requires_exact_replay"])
        self.assertTrue(proof_neutrality["requires_route_tca"])
        self.assertTrue(proof_neutrality["requires_order_lifecycle_fill_evidence"])
        self.assertTrue(proof_neutrality["requires_runtime_ledger"])
        self.assertTrue(proof_neutrality["requires_trade_level_logging"])
        self.assertTrue(
            proof_neutrality["rejects_model_cost_as_realized_pnl_authority"]
        )
        self.assertTrue(proof_neutrality["rejects_synthetic_fill_authority"])
        self.assertFalse(payload["promotion_proof"])
        self.assertFalse(payload["promotion_allowed"])
        self.assertEqual(
            payload["feature_schema_hash"],
            build_nonlinear_impact_execution_stress_schema_hash(),
        )
