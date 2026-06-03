from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal
from unittest import TestCase

from app.trading.discovery.feed_lag_liquidity_stress import (
    build_feed_lag_liquidity_stress_schema_hash,
    extract_feed_lag_liquidity_stress,
    feed_lag_liquidity_stress_contract,
)
from app.trading.models import SignalEnvelope


class TestFeedLagLiquidityStress(TestCase):
    def _row(
        self,
        *,
        offset: int,
        price: str,
        delay_ms: str,
        spread_bps: str,
        bid_size: str,
        ask_size: str,
        feed_direction: str = "buy",
        authoritative_direction: str = "buy",
    ) -> SignalEnvelope:
        return SignalEnvelope(
            event_ts=datetime(2026, 4, 29, 14, 30, tzinfo=timezone.utc)
            + timedelta(seconds=offset),
            symbol="FLG",
            timeframe="1S",
            seq=offset,
            source="feed-lag-fixture",
            payload={
                "price": Decimal(price),
                "feed_delay_ms": Decimal(delay_ms),
                "quoted_spread_bps": Decimal(spread_bps),
                "bid_size": Decimal(bid_size),
                "ask_size": Decimal(ask_size),
                "feed_trade_direction": feed_direction,
                "authoritative_trade_direction": authoritative_direction,
            },
            ingest_ts=datetime(2026, 4, 29, 14, 31, tzinfo=timezone.utc),
        )

    def test_feed_lag_stress_penalizes_delayed_thin_public_quotes(self) -> None:
        reliable = extract_feed_lag_liquidity_stress(
            (
                self._row(
                    offset=1,
                    price="100.00",
                    delay_ms="15",
                    spread_bps="1.2",
                    bid_size="700",
                    ask_size="690",
                ),
                self._row(
                    offset=2,
                    price="100.02",
                    delay_ms="20",
                    spread_bps="1.1",
                    bid_size="720",
                    ask_size="710",
                ),
                self._row(
                    offset=3,
                    price="100.03",
                    delay_ms="25",
                    spread_bps="1.2",
                    bid_size="710",
                    ask_size="705",
                ),
                self._row(
                    offset=4,
                    price="100.04",
                    delay_ms="30",
                    spread_bps="1.3",
                    bid_size="730",
                    ask_size="720",
                ),
            ),
            direction=1,
        )
        lagged = extract_feed_lag_liquidity_stress(
            (
                self._row(
                    offset=1,
                    price="100.00",
                    delay_ms="20",
                    spread_bps="1.0",
                    bid_size="800",
                    ask_size="790",
                ),
                self._row(
                    offset=2,
                    price="99.70",
                    delay_ms="6200",
                    spread_bps="8.5",
                    bid_size="80",
                    ask_size="75",
                    feed_direction="buy",
                    authoritative_direction="sell",
                ),
                self._row(
                    offset=3,
                    price="99.20",
                    delay_ms="9100",
                    spread_bps="10.0",
                    bid_size="60",
                    ask_size="55",
                    feed_direction="buy",
                    authoritative_direction="sell",
                ),
                self._row(
                    offset=4,
                    price="99.10",
                    delay_ms="30",
                    spread_bps="1.2",
                    bid_size="760",
                    ask_size="740",
                ),
            ),
            direction=1,
        )

        self.assertGreater(lagged.p95_feed_delay_ms, reliable.p95_feed_delay_ms)
        self.assertGreater(
            lagged.high_delay_spread_widening_bps,
            reliable.high_delay_spread_widening_bps,
        )
        self.assertGreater(
            lagged.high_delay_depth_thinning_share,
            reliable.high_delay_depth_thinning_share,
        )
        self.assertGreater(lagged.public_feed_direction_disagreement_share, 0.0)
        self.assertGreater(lagged.stale_quote_adverse_move_bps, 0.0)
        self.assertGreater(
            lagged.replay_rank_penalty_bps, reliable.replay_rank_penalty_bps
        )
        self.assertLess(lagged.feed_reliability_score, reliable.feed_reliability_score)

        payload = lagged.to_payload()
        self.assertEqual(
            payload["status"], "preview_only_feed_lag_liquidity_stress_ranking"
        )
        self.assertTrue(payload["public_feed_delay_preview"])
        self.assertTrue(payload["quoted_liquidity_reliability_preview"])
        self.assertTrue(payload["authoritative_trade_direction_join_preview"])
        self.assertFalse(payload["proof_authority"])
        self.assertFalse(payload["promotion_authority"])
        self.assertFalse(payload["final_authority_ok"])

    def test_contract_embeds_sources_and_requires_authoritative_evidence(self) -> None:
        contract = feed_lag_liquidity_stress_contract()
        payload = extract_feed_lag_liquidity_stress(
            (
                self._row(
                    offset=1,
                    price="100",
                    delay_ms="25",
                    spread_bps="1",
                    bid_size="100",
                    ask_size="100",
                ),
                self._row(
                    offset=2,
                    price="100.01",
                    delay_ms="45",
                    spread_bps="1.1",
                    bid_size="100",
                    ask_size="100",
                ),
                self._row(
                    offset=3,
                    price="99.99",
                    delay_ms="35",
                    spread_bps="1.2",
                    bid_size="100",
                    ask_size="100",
                ),
            ),
            direction=-1,
        ).to_payload()
        source_ids = {source["source_id"] for source in payload["source_papers"]}

        self.assertEqual(
            payload["feature_schema_hash"],
            build_feed_lag_liquidity_stress_schema_hash(),
        )
        self.assertIn("ssrn-6675338", source_ids)
        self.assertIn("arxiv-2604.24366", source_ids)
        self.assertIn("arxiv-2511.20606", source_ids)
        self.assertTrue(contract["proof_neutrality"]["requires_exact_replay"])
        self.assertTrue(contract["proof_neutrality"]["requires_route_tca"])
        self.assertTrue(
            contract["proof_neutrality"]["requires_authoritative_trade_direction_join"]
        )
        self.assertTrue(contract["proof_neutrality"]["requires_runtime_ledger"])
        self.assertFalse(contract["proof_neutrality"]["promotion_proof"])
        self.assertFalse(payload["promotion_allowed"])
