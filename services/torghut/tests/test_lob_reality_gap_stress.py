from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal
from unittest import TestCase

from app.trading.discovery.lob_reality_gap_stress import (
    build_lob_reality_gap_stress_schema_hash,
    extract_lob_reality_gap_stress,
    lob_reality_gap_stress_contract,
)
from app.trading.models import SignalEnvelope


class TestLobRealityGapStress(TestCase):
    def _row(
        self,
        *,
        offset: int,
        price: str,
        bid_size: str,
        ask_size: str,
        latency_ms: str,
        trade_direction: str,
        trade_size: str,
        odd_lot_bid_size: str,
        odd_lot_ask_size: str,
        off_exchange_trade: bool = False,
        event_type: str = "trade",
    ) -> SignalEnvelope:
        mid = Decimal(price)
        return SignalEnvelope(
            event_ts=datetime(2026, 3, 25, 14, 30, tzinfo=timezone.utc)
            + timedelta(milliseconds=offset),
            symbol="LBG",
            timeframe="1ms",
            seq=offset,
            source="lob-reality-gap-fixture",
            payload={
                "price": mid,
                "bid": mid - Decimal("0.01"),
                "ask": mid + Decimal("0.01"),
                "bid_size": Decimal(bid_size),
                "ask_size": Decimal(ask_size),
                "round_trip_latency_ms": Decimal(latency_ms),
                "trade_direction": trade_direction,
                "trade_size": Decimal(trade_size),
                "odd_lot_bid_size": Decimal(odd_lot_bid_size),
                "odd_lot_ask_size": Decimal(odd_lot_ask_size),
                "off_exchange_trade": off_exchange_trade,
                "event_type": event_type,
            },
            ingest_ts=datetime(2026, 3, 25, 14, 31, tzinfo=timezone.utc),
        )

    def test_reality_gap_stress_penalizes_latency_flow_and_odd_lot_vanish(self) -> None:
        stable = extract_lob_reality_gap_stress(
            (
                self._row(
                    offset=1,
                    price="100.00",
                    bid_size="500",
                    ask_size="480",
                    latency_ms="1.2",
                    trade_direction="buy",
                    trade_size="5",
                    odd_lot_bid_size="40",
                    odd_lot_ask_size="42",
                ),
                self._row(
                    offset=2,
                    price="100.01",
                    bid_size="510",
                    ask_size="500",
                    latency_ms="2.7",
                    trade_direction="sell",
                    trade_size="4",
                    odd_lot_bid_size="41",
                    odd_lot_ask_size="43",
                ),
                self._row(
                    offset=3,
                    price="100.00",
                    bid_size="505",
                    ask_size="495",
                    latency_ms="3.5",
                    trade_direction="buy",
                    trade_size="4",
                    odd_lot_bid_size="40",
                    odd_lot_ask_size="44",
                ),
            ),
            direction=1,
        )
        fragile = extract_lob_reality_gap_stress(
            (
                self._row(
                    offset=1,
                    price="100.00",
                    bid_size="950",
                    ask_size="50",
                    latency_ms="2.0",
                    trade_direction="buy",
                    trade_size="900",
                    odd_lot_bid_size="80",
                    odd_lot_ask_size="82",
                ),
                self._row(
                    offset=2,
                    price="100.28",
                    bid_size="930",
                    ask_size="45",
                    latency_ms="2.0",
                    trade_direction="buy",
                    trade_size="850",
                    odd_lot_bid_size="5",
                    odd_lot_ask_size="4",
                    off_exchange_trade=True,
                    event_type="cancel",
                ),
                self._row(
                    offset=3,
                    price="100.62",
                    bid_size="920",
                    ask_size="40",
                    latency_ms="2.0",
                    trade_direction="buy",
                    trade_size="800",
                    odd_lot_bid_size="4",
                    odd_lot_ask_size="3",
                    off_exchange_trade=True,
                    event_type="cancel_replace",
                ),
                self._row(
                    offset=4,
                    price="100.91",
                    bid_size="900",
                    ask_size="35",
                    latency_ms="2.0",
                    trade_direction="buy",
                    trade_size="780",
                    odd_lot_bid_size="70",
                    odd_lot_ask_size="72",
                ),
            ),
            direction=1,
        )

        self.assertGreater(
            fragile.median_abs_volume_imbalance, stable.median_abs_volume_imbalance
        )
        self.assertGreater(fragile.high_imbalance_share, stable.high_imbalance_share)
        self.assertGreater(fragile.latency_mode_share, stable.latency_mode_share)
        self.assertGreater(
            fragile.power_law_signed_flow_impact_bps,
            stable.power_law_signed_flow_impact_bps,
        )
        self.assertGreater(fragile.odd_lot_vanish_share, stable.odd_lot_vanish_share)
        self.assertGreater(
            fragile.replay_rank_penalty_bps, stable.replay_rank_penalty_bps
        )
        payload = fragile.to_payload()
        self.assertEqual(
            payload["status"], "preview_only_lob_reality_gap_stress_ranking"
        )
        self.assertTrue(payload["power_law_signed_flow_impact_preview"])
        self.assertTrue(payload["odd_lot_liquidity_reliability_preview"])
        self.assertFalse(payload["proof_authority"])
        self.assertFalse(payload["promotion_allowed"])
        self.assertFalse(payload["final_authority_ok"])

    def test_contract_embeds_sources_and_keeps_proof_fail_closed(self) -> None:
        contract = lob_reality_gap_stress_contract()
        payload = extract_lob_reality_gap_stress(
            (
                self._row(
                    offset=1,
                    price="100",
                    bid_size="100",
                    ask_size="100",
                    latency_ms="1",
                    trade_direction="buy",
                    trade_size="10",
                    odd_lot_bid_size="10",
                    odd_lot_ask_size="10",
                ),
                self._row(
                    offset=2,
                    price="100.01",
                    bid_size="100",
                    ask_size="100",
                    latency_ms="1.5",
                    trade_direction="sell",
                    trade_size="8",
                    odd_lot_bid_size="10",
                    odd_lot_ask_size="10",
                ),
            )
        ).to_payload()
        source_ids = {source["source_id"] for source in payload["source_papers"]}

        self.assertEqual(
            payload["feature_schema_hash"], build_lob_reality_gap_stress_schema_hash()
        )
        self.assertIn("arxiv-2603.24137", source_ids)
        self.assertIn("ofr-25-01", source_ids)
        self.assertIn("arxiv-2507.06345", source_ids)
        self.assertTrue(contract["proof_neutrality"]["requires_exact_replay"])
        self.assertTrue(contract["proof_neutrality"]["requires_route_tca"])
        self.assertTrue(
            contract["proof_neutrality"]["requires_order_lifecycle_fill_evidence"]
        )
        self.assertTrue(contract["proof_neutrality"]["requires_runtime_ledger"])
        self.assertFalse(contract["proof_neutrality"]["promotion_proof"])
        self.assertFalse(payload["promotion_authority"])
