from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal
from unittest import TestCase

from app.trading.discovery.counterfactual_regime_replay_stress import (
    build_counterfactual_regime_replay_stress_schema_hash,
    counterfactual_regime_replay_stress_contract,
    extract_counterfactual_regime_replay_stress,
)
from app.trading.models import SignalEnvelope


class TestCounterfactualRegimeReplayStress(TestCase):
    def _row(
        self,
        *,
        offset: int,
        price: str,
        spread_bps: str,
        volume: str,
        ofi: str,
        trend_regime: str | None = None,
        volatility_regime: str | None = None,
        liquidity_regime: str | None = None,
        ofi_regime: str | None = None,
    ) -> SignalEnvelope:
        mid = Decimal(price)
        payload: dict[str, object] = {
            "price": mid,
            "bid": mid - Decimal("0.01"),
            "ask": mid + Decimal("0.01"),
            "spread_bps": Decimal(spread_bps),
            "microbar_volume": Decimal(volume),
            "ofi": Decimal(ofi),
        }
        if trend_regime is not None:
            payload["future_trend_regime"] = trend_regime
        if volatility_regime is not None:
            payload["future_volatility_regime"] = volatility_regime
        if liquidity_regime is not None:
            payload["future_liquidity_regime"] = liquidity_regime
        if ofi_regime is not None:
            payload["future_ofi_regime"] = ofi_regime
        return SignalEnvelope(
            event_ts=datetime(2026, 2, 3, 14, 30, tzinfo=timezone.utc)
            + timedelta(milliseconds=offset * 100),
            symbol="CFR",
            timeframe="100ms",
            seq=offset,
            source="counterfactual-regime-fixture",
            payload=payload,
            ingest_ts=datetime(2026, 2, 3, 14, 31, tzinfo=timezone.utc),
        )

    def test_counterfactual_regime_stress_penalizes_fragile_regime_edges(
        self,
    ) -> None:
        balanced = extract_counterfactual_regime_replay_stress(
            (
                self._row(
                    offset=1, price="100.00", spread_bps="1", volume="900", ofi="0.4"
                ),
                self._row(
                    offset=2, price="100.03", spread_bps="1", volume="850", ofi="-0.3"
                ),
                self._row(
                    offset=3, price="100.00", spread_bps="1", volume="870", ofi="0.2"
                ),
                self._row(
                    offset=4, price="100.02", spread_bps="1", volume="920", ofi="-0.4"
                ),
                self._row(
                    offset=5, price="99.99", spread_bps="1", volume="880", ofi="0.5"
                ),
                self._row(
                    offset=6, price="100.02", spread_bps="1", volume="910", ofi="-0.2"
                ),
                self._row(
                    offset=7, price="100.00", spread_bps="1", volume="890", ofi="0.1"
                ),
                self._row(
                    offset=8, price="100.02", spread_bps="1", volume="905", ofi="-0.1"
                ),
            ),
            direction=1,
        )
        fragile = extract_counterfactual_regime_replay_stress(
            (
                self._row(
                    offset=1,
                    price="100.00",
                    spread_bps="1",
                    volume="1500",
                    ofi="0.9",
                    trend_regime="up",
                    volatility_regime="low",
                    liquidity_regime="deep",
                    ofi_regime="buy_pressure",
                ),
                self._row(
                    offset=2,
                    price="100.20",
                    spread_bps="1",
                    volume="1600",
                    ofi="0.9",
                    trend_regime="up",
                    volatility_regime="low",
                    liquidity_regime="deep",
                    ofi_regime="buy_pressure",
                ),
                self._row(
                    offset=3,
                    price="100.42",
                    spread_bps="1",
                    volume="1550",
                    ofi="0.8",
                    trend_regime="up",
                    volatility_regime="low",
                    liquidity_regime="deep",
                    ofi_regime="buy_pressure",
                ),
                self._row(
                    offset=4,
                    price="100.65",
                    spread_bps="8",
                    volume="100",
                    ofi="-0.9",
                    trend_regime="down",
                    volatility_regime="high",
                    liquidity_regime="thin",
                    ofi_regime="sell_pressure",
                ),
                self._row(
                    offset=5,
                    price="100.05",
                    spread_bps="9",
                    volume="90",
                    ofi="-0.8",
                    trend_regime="down",
                    volatility_regime="high",
                    liquidity_regime="thin",
                    ofi_regime="sell_pressure",
                ),
                self._row(
                    offset=6,
                    price="99.45",
                    spread_bps="10",
                    volume="80",
                    ofi="-0.9",
                    trend_regime="down",
                    volatility_regime="high",
                    liquidity_regime="thin",
                    ofi_regime="sell_pressure",
                ),
            ),
            direction=1,
        )

        self.assertGreater(
            fragile.dominant_regime_share, balanced.dominant_regime_share
        )
        self.assertGreater(
            fragile.regime_edge_concentration_share,
            balanced.regime_edge_concentration_share,
        )
        self.assertGreater(
            fragile.channel_counterfactual_sensitivity_bps,
            balanced.channel_counterfactual_sensitivity_bps,
        )
        self.assertGreater(
            fragile.temporal_wasserstein_shift,
            balanced.temporal_wasserstein_shift,
        )
        self.assertGreater(
            fragile.replay_rank_penalty_bps, balanced.replay_rank_penalty_bps
        )
        payload = fragile.to_payload()
        self.assertEqual(
            payload["status"],
            "preview_only_counterfactual_regime_replay_stress_ranking",
        )
        self.assertTrue(payload["regime_conditioned_real_tape_support_preview"])
        self.assertFalse(payload["counterfactual_generation_preview"])
        self.assertFalse(payload["synthetic_trajectory_generation"])
        self.assertFalse(payload["proof_authority"])
        self.assertFalse(payload["promotion_authority"])
        self.assertFalse(payload["final_authority_ok"])

    def test_contract_embeds_sources_and_keeps_proof_fail_closed(self) -> None:
        contract = counterfactual_regime_replay_stress_contract()
        payload = extract_counterfactual_regime_replay_stress(
            (
                self._row(
                    offset=1, price="100.00", spread_bps="1", volume="100", ofi="0.2"
                ),
                self._row(
                    offset=2, price="100.01", spread_bps="1", volume="100", ofi="-0.2"
                ),
                self._row(
                    offset=3, price="100.00", spread_bps="1", volume="100", ofi="0.2"
                ),
                self._row(
                    offset=4, price="100.01", spread_bps="1", volume="100", ofi="-0.2"
                ),
            )
        ).to_payload()
        source_ids = {source["source_id"] for source in payload["source_papers"]}

        self.assertEqual(
            payload["feature_schema_hash"],
            build_counterfactual_regime_replay_stress_schema_hash(),
        )
        self.assertIn("arxiv-2602.03776", source_ids)
        self.assertIn("ssrn-6232459", source_ids)
        self.assertTrue(contract["proof_neutrality"]["requires_exact_replay"])
        self.assertTrue(contract["proof_neutrality"]["requires_route_tca"])
        self.assertTrue(
            contract["proof_neutrality"]["requires_order_lifecycle_fill_evidence"]
        )
        self.assertTrue(contract["proof_neutrality"]["requires_runtime_ledger"])
        self.assertTrue(
            contract["proof_neutrality"][
                "rejects_synthetic_counterfactual_pnl_authority"
            ]
        )
        self.assertFalse(contract["proof_neutrality"]["promotion_proof"])
        self.assertFalse(payload["promotion_authority"])
