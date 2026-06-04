from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal
from unittest import TestCase

from app.trading.discovery.stochastic_liquidity_resilience_stress import (
    build_stochastic_liquidity_resilience_stress_schema_hash,
    extract_stochastic_liquidity_resilience_stress,
    stochastic_liquidity_resilience_stress_contract,
)
from app.trading.models import SignalEnvelope


class TestStochasticLiquidityResilienceStress(TestCase):
    def _row(
        self,
        *,
        offset: int,
        price: str = "100.00",
        bid_depth: str | None = "1000",
        ask_depth: str | None = "1000",
        spread_bps: str = "2.0",
        shortfall_bps: str = "1.5",
        participation_rate: str = "0.02",
        volume: str = "100000",
    ) -> SignalEnvelope:
        payload: dict[str, object] = {
            "price": Decimal(price),
            "spread_bps": Decimal(spread_bps),
            "microbar_volume": Decimal(volume),
            "execution_shortfall_bps": Decimal(shortfall_bps),
            "child_order_participation_rate": Decimal(participation_rate),
        }
        if bid_depth is not None:
            payload["bid_depth"] = Decimal(bid_depth)
        if ask_depth is not None:
            payload["ask_depth"] = Decimal(ask_depth)
        return SignalEnvelope(
            event_ts=datetime(2026, 4, 11, 14, 30, tzinfo=timezone.utc)
            + timedelta(seconds=offset),
            symbol="LIQ",
            timeframe="1s",
            seq=offset,
            source="stochastic-liquidity-fixture",
            payload=payload,
            ingest_ts=datetime(2026, 4, 11, 14, 31, tzinfo=timezone.utc),
        )

    def test_stable_depth_recovery_beats_fragile_regime_switching_depth(self) -> None:
        stable = extract_stochastic_liquidity_resilience_stress(
            (
                self._row(offset=0, bid_depth="1000", ask_depth="1000"),
                self._row(offset=1, bid_depth="1000", ask_depth="1000"),
                self._row(offset=2, bid_depth="1000", ask_depth="1000"),
                self._row(offset=3, bid_depth="1000", ask_depth="1000"),
                self._row(offset=4, bid_depth="1000", ask_depth="1000"),
            ),
            max_notional=50000.0,
        )
        fragile = extract_stochastic_liquidity_resilience_stress(
            (
                self._row(
                    offset=0,
                    bid_depth="1400",
                    ask_depth="1200",
                    spread_bps="3.0",
                    shortfall_bps="2.0",
                    participation_rate="0.03",
                ),
                self._row(
                    offset=1,
                    bid_depth="250",
                    ask_depth="80",
                    spread_bps="18.0",
                    shortfall_bps="14.0",
                    participation_rate="0.18",
                ),
                self._row(
                    offset=2,
                    bid_depth="1600",
                    ask_depth="1100",
                    spread_bps="4.0",
                    shortfall_bps="3.0",
                    participation_rate="0.04",
                ),
                self._row(
                    offset=3,
                    bid_depth="180",
                    ask_depth="40",
                    spread_bps="24.0",
                    shortfall_bps="18.0",
                    participation_rate="0.22",
                ),
                self._row(
                    offset=4,
                    bid_depth="220",
                    ask_depth="70",
                    spread_bps="26.0",
                    shortfall_bps="20.0",
                    participation_rate="0.20",
                ),
            ),
            max_notional=50000.0,
        )

        self.assertLess(
            stable.liquidity_regime_instability_score,
            fragile.liquidity_regime_instability_score,
        )
        self.assertLess(
            stable.lob_shape_imbalance_score,
            fragile.lob_shape_imbalance_score,
        )
        self.assertLess(
            stable.depth_shock_recovery_gap_score,
            fragile.depth_shock_recovery_gap_score,
        )
        self.assertLess(
            stable.replay_rank_penalty_bps,
            fragile.replay_rank_penalty_bps,
        )
        payload = fragile.to_payload()
        self.assertEqual(
            payload["status"],
            "preview_only_stochastic_liquidity_resilience_stress_ranking",
        )
        self.assertTrue(payload["stochastic_liquidity_regime_preview"])
        self.assertTrue(payload["depth_recovery_resilience_preview"])
        self.assertFalse(payload["proof_authority"])
        self.assertFalse(payload["promotion_authority"])
        self.assertFalse(payload["final_authority_ok"])

    def test_missing_depth_fails_closed_with_source_gap_and_contract_sources(
        self,
    ) -> None:
        summary = extract_stochastic_liquidity_resilience_stress(
            (
                self._row(offset=0, bid_depth=None, ask_depth=None),
                self._row(offset=1, bid_depth=None, ask_depth=None),
            ),
            max_notional=50000.0,
        )
        payload = summary.to_payload()
        contract = stochastic_liquidity_resilience_stress_contract()
        source_ids = {source["source_id"] for source in payload["source_papers"]}

        self.assertEqual(
            payload["feature_schema_hash"],
            build_stochastic_liquidity_resilience_stress_schema_hash(),
        )
        self.assertIn("arxiv-2506.11813", source_ids)
        self.assertIn("ssrn-3798235", source_ids)
        self.assertIn(
            "missing_lob_depth_for_stochastic_liquidity_resilience",
            payload["warnings"],
        )
        self.assertGreater(payload["source_gap_score"], 0)
        self.assertFalse(contract["proof_neutrality"]["proof_authority"])
        self.assertTrue(
            contract["proof_neutrality"][
                "rejects_modeled_liquidity_resilience_as_pnl_authority"
            ]
        )

    def test_nested_payload_and_empty_rows_stay_bounded(self) -> None:
        empty = extract_stochastic_liquidity_resilience_stress(())
        nested = extract_stochastic_liquidity_resilience_stress(
            (
                SignalEnvelope(
                    event_ts=datetime(2026, 4, 11, 14, 30, tzinfo=timezone.utc),
                    symbol="LIQ",
                    timeframe="1s",
                    seq=0,
                    source="stochastic-liquidity-fixture",
                    payload={
                        "features": {
                            "mid_price": "101.5",
                            "bid_size": "800",
                            "ask_size": "700",
                            "quoted_spread_bps": "3.5",
                            "microbar_volume": "120000",
                            "slippage_bps": "2.5",
                            "pov_rate": "0.04",
                        }
                    },
                    ingest_ts=datetime(2026, 4, 11, 14, 31, tzinfo=timezone.utc),
                ),
            ),
            max_notional=10000.0,
        )

        self.assertEqual(empty.source_gap_score, 1.0)
        self.assertEqual(nested.observed_depth_count, 1)
        self.assertEqual(nested.observed_spread_count, 1)
        self.assertEqual(nested.observed_shortfall_count, 1)
        self.assertGreaterEqual(nested.execution_boundary_pressure_bps, 0.0)
        self.assertFalse(nested.to_payload()["proof_authority"])
