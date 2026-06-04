from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal
from unittest import TestCase

from app.trading.discovery.adaptive_market_limit_allocation_stress import (
    ADAPTIVE_MARKET_LIMIT_ALLOCATION_STRESS_PRIMARY_SOURCES,
    adaptive_market_limit_allocation_stress_contract,
    extract_adaptive_market_limit_allocation_stress,
)
from app.trading.models import SignalEnvelope


class TestAdaptiveMarketLimitAllocationStress(TestCase):
    def _row(
        self,
        *,
        offset: int,
        price: str,
        order_type: str,
        fill_status: str,
        spread_bps: str,
        imbalance: str,
        fill_qty: str = "100",
        order_qty: str = "100",
    ) -> SignalEnvelope:
        return SignalEnvelope(
            event_ts=datetime(2026, 1, 26, 14, 30, tzinfo=timezone.utc)
            + timedelta(seconds=offset),
            symbol="AAA",
            timeframe="1S",
            seq=offset,
            source="fixture",
            payload={
                "price": Decimal(price),
                "order_type": order_type,
                "fill_status": fill_status,
                "fill_qty": Decimal(fill_qty),
                "order_qty": Decimal(order_qty),
                "spread_bps": Decimal(spread_bps),
                "order_book_imbalance": Decimal(imbalance),
            },
            ingest_ts=datetime(2026, 1, 26, 14, 30, 1, tzinfo=timezone.utc),
        )

    def test_adverse_market_orders_and_unfilled_limits_raise_penalty(self) -> None:
        stressed = [
            self._row(
                offset=1,
                price="100",
                order_type="market",
                fill_status="filled",
                spread_bps="12",
                imbalance="-0.40",
            ),
            self._row(
                offset=2,
                price="101",
                order_type="limit",
                fill_status="unfilled",
                spread_bps="10",
                imbalance="0.20",
                fill_qty="0",
            ),
            self._row(
                offset=3,
                price="102",
                order_type="limit",
                fill_status="unfilled",
                spread_bps="9",
                imbalance="0.30",
                fill_qty="0",
            ),
        ]
        balanced = [
            self._row(
                offset=1,
                price="100",
                order_type="market",
                fill_status="filled",
                spread_bps="2",
                imbalance="0.30",
            ),
            self._row(
                offset=2,
                price="100.01",
                order_type="limit",
                fill_status="filled",
                spread_bps="2",
                imbalance="0.25",
            ),
            self._row(
                offset=3,
                price="100.02",
                order_type="limit",
                fill_status="filled",
                spread_bps="2",
                imbalance="0.20",
            ),
        ]

        stressed_payload = extract_adaptive_market_limit_allocation_stress(
            stressed, direction=1
        ).to_payload()
        balanced_payload = extract_adaptive_market_limit_allocation_stress(
            balanced, direction=1
        ).to_payload()

        self.assertGreater(stressed_payload["adverse_market_order_share"], 0)
        self.assertGreater(stressed_payload["wide_spread_market_order_share"], 0)
        self.assertGreater(stressed_payload["unfilled_limit_share"], 0)
        self.assertGreater(stressed_payload["nonfill_opportunity_cost_bps"], 0)
        self.assertGreater(
            stressed_payload["replay_rank_penalty_bps"],
            balanced_payload["replay_rank_penalty_bps"],
        )
        self.assertEqual(
            stressed_payload["status"],
            "preview_only_adaptive_market_limit_allocation_stress_ranking",
        )
        self.assertTrue(stressed_payload["market_limit_allocation_preview"])
        self.assertFalse(stressed_payload["proof_authority"])
        self.assertFalse(stressed_payload["promotion_authority"])

    def test_missing_inputs_fail_closed_and_contract_rejects_authority(self) -> None:
        row = SignalEnvelope(
            event_ts=datetime(2026, 1, 26, 14, 30, tzinfo=timezone.utc),
            symbol="AAA",
            timeframe="1S",
            seq=1,
            source="fixture",
            payload={"price": Decimal("100")},
            ingest_ts=datetime(2026, 1, 26, 14, 30, 1, tzinfo=timezone.utc),
        )

        payload = extract_adaptive_market_limit_allocation_stress([row]).to_payload()
        contract = adaptive_market_limit_allocation_stress_contract()

        self.assertIn("missing_market_limit_order_type_evidence", payload["warnings"])
        self.assertIn("missing_order_lifecycle_fill_evidence", payload["warnings"])
        self.assertGreater(payload["replay_rank_penalty_bps"], 0)
        self.assertEqual(
            [source["source_id"] for source in contract["source_papers"]],
            [
                source["source_id"]
                for source in ADAPTIVE_MARKET_LIMIT_ALLOCATION_STRESS_PRIMARY_SOURCES
            ],
        )
        self.assertTrue(contract["proof_neutrality"]["requires_exact_replay"])
        self.assertTrue(contract["proof_neutrality"]["requires_route_tca"])
        self.assertTrue(
            contract["proof_neutrality"]["requires_order_lifecycle_fill_evidence"]
        )
        self.assertTrue(contract["proof_neutrality"]["requires_runtime_ledger"])
        self.assertFalse(contract["proof_neutrality"]["promotion_proof"])
        self.assertFalse(payload["promotion_allowed"])
        self.assertFalse(payload["final_authority_ok"])
