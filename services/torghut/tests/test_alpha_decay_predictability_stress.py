from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal
from unittest import TestCase

from app.trading.discovery.alpha_decay_predictability_stress import (
    build_alpha_decay_predictability_stress_schema_hash,
    alpha_decay_predictability_stress_contract,
    extract_alpha_decay_predictability_stress,
)
from app.trading.models import SignalEnvelope


class TestAlphaDecayPredictabilityStress(TestCase):
    def _row(
        self,
        *,
        offset: int,
        price: str,
        spread_bps: str,
        volume: str,
        algo_activity_score: str = "0.10",
        inference_latency_ms: str = "10",
    ) -> SignalEnvelope:
        mid = Decimal(price)
        return SignalEnvelope(
            event_ts=datetime(2026, 1, 5, 14, 30, tzinfo=timezone.utc)
            + timedelta(milliseconds=offset * 100),
            symbol="ADX",
            timeframe="100ms",
            seq=offset,
            source="alpha-decay-fixture",
            payload={
                "price": mid,
                "bid": mid - Decimal("0.01"),
                "ask": mid + Decimal("0.01"),
                "spread_bps": Decimal(spread_bps),
                "microbar_volume": Decimal(volume),
                "algo_activity_score": Decimal(algo_activity_score),
                "model_inference_latency_ms": Decimal(inference_latency_ms),
            },
            ingest_ts=datetime(2026, 1, 5, 14, 31, tzinfo=timezone.utc),
        )

    def test_alpha_decay_stress_penalizes_cost_crossover_and_latency_mismatch(
        self,
    ) -> None:
        durable = extract_alpha_decay_predictability_stress(
            (
                self._row(offset=1, price="100.00", spread_bps="0.5", volume="100"),
                self._row(offset=2, price="100.08", spread_bps="0.5", volume="105"),
                self._row(offset=3, price="100.16", spread_bps="0.5", volume="110"),
                self._row(offset=4, price="100.24", spread_bps="0.5", volume="115"),
                self._row(offset=5, price="100.32", spread_bps="0.5", volume="120"),
                self._row(offset=6, price="100.40", spread_bps="0.5", volume="125"),
            ),
            direction=1,
        )
        decayed = extract_alpha_decay_predictability_stress(
            (
                self._row(
                    offset=1,
                    price="100.00",
                    spread_bps="3.0",
                    volume="900",
                    algo_activity_score="0.95",
                    inference_latency_ms="350",
                ),
                self._row(
                    offset=2,
                    price="100.06",
                    spread_bps="3.0",
                    volume="950",
                    algo_activity_score="0.95",
                    inference_latency_ms="350",
                ),
                self._row(
                    offset=3,
                    price="99.98",
                    spread_bps="3.0",
                    volume="980",
                    algo_activity_score="0.95",
                    inference_latency_ms="350",
                ),
                self._row(
                    offset=4,
                    price="99.90",
                    spread_bps="3.0",
                    volume="990",
                    algo_activity_score="0.95",
                    inference_latency_ms="350",
                ),
                self._row(
                    offset=5,
                    price="99.84",
                    spread_bps="3.0",
                    volume="1000",
                    algo_activity_score="0.95",
                    inference_latency_ms="350",
                ),
                self._row(
                    offset=6,
                    price="99.80",
                    spread_bps="3.0",
                    volume="1020",
                    algo_activity_score="0.95",
                    inference_latency_ms="350",
                ),
            ),
            direction=1,
        )

        self.assertGreater(decayed.alpha_decay_bps, durable.alpha_decay_bps)
        self.assertGreater(decayed.cost_crossover_share, durable.cost_crossover_share)
        self.assertGreater(
            decayed.algorithmic_activity_intensity,
            durable.algorithmic_activity_intensity,
        )
        self.assertGreater(
            decayed.latency_horizon_mismatch_share,
            durable.latency_horizon_mismatch_share,
        )
        self.assertGreater(
            decayed.replay_rank_penalty_bps, durable.replay_rank_penalty_bps
        )
        payload = decayed.to_payload()
        self.assertEqual(
            payload["status"], "preview_only_alpha_decay_predictability_ranking"
        )
        self.assertTrue(payload["multi_horizon_alpha_decay_preview"])
        self.assertTrue(payload["spread_adjusted_label_preview"])
        self.assertFalse(payload["proof_authority"])
        self.assertFalse(payload["promotion_authority"])
        self.assertFalse(payload["final_authority_ok"])

    def test_contract_embeds_sources_and_keeps_proof_fail_closed(self) -> None:
        contract = alpha_decay_predictability_stress_contract()
        payload = extract_alpha_decay_predictability_stress(
            (
                self._row(offset=1, price="100.00", spread_bps="1", volume="100"),
                self._row(offset=2, price="100.01", spread_bps="1", volume="110"),
                self._row(offset=3, price="100.02", spread_bps="1", volume="120"),
            )
        ).to_payload()
        source_ids = {source["source_id"] for source in payload["source_papers"]}

        self.assertEqual(
            payload["feature_schema_hash"],
            build_alpha_decay_predictability_stress_schema_hash(),
        )
        self.assertIn("arxiv-2601.02310", source_ids)
        self.assertIn("ssrn-6608199", source_ids)
        self.assertTrue(contract["proof_neutrality"]["requires_exact_replay"])
        self.assertTrue(contract["proof_neutrality"]["requires_route_tca"])
        self.assertTrue(
            contract["proof_neutrality"]["requires_order_lifecycle_fill_evidence"]
        )
        self.assertTrue(contract["proof_neutrality"]["requires_runtime_ledger"])
        self.assertTrue(
            contract["proof_neutrality"]["rejects_single_horizon_lob_alpha_promotion"]
        )
        self.assertFalse(contract["proof_neutrality"]["promotion_proof"])
        self.assertFalse(payload["promotion_authority"])
