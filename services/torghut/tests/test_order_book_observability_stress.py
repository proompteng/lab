from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal
from unittest import TestCase

from app.trading.discovery.order_book_observability_stress import (
    ORDER_BOOK_OBSERVABILITY_STRESS_PRIMARY_SOURCES,
    extract_order_book_observability_stress,
    order_book_observability_stress_contract,
)
from app.trading.models import SignalEnvelope


class TestOrderBookObservabilityStress(TestCase):
    def _row(
        self,
        *,
        offset: int,
        price: str = "100",
        event_type: str = "book_update",
        quote: bool = True,
        depth: bool = True,
        bid_size: str = "800",
        ask_size: str = "800",
    ) -> SignalEnvelope:
        mid = Decimal(price)
        payload: dict[str, object] = {
            "price": mid,
            "event_type": event_type,
            "spread_bps": Decimal("2"),
        }
        if quote:
            payload.update(
                {
                    "bid": mid - Decimal("0.01"),
                    "ask": mid + Decimal("0.01"),
                }
            )
        if depth:
            payload.update(
                {
                    "bid_size": Decimal(bid_size),
                    "ask_size": Decimal(ask_size),
                }
            )
        return SignalEnvelope(
            event_ts=datetime(2026, 5, 19, 14, 30, tzinfo=timezone.utc)
            + timedelta(seconds=offset),
            symbol="AAA",
            timeframe="1S",
            seq=offset,
            source="fixture",
            payload=payload,
            ingest_ts=datetime(2026, 5, 19, 14, 30, 1, tzinfo=timezone.utc),
        )

    def test_missing_book_feedback_and_thin_depth_raise_rank_penalty(self) -> None:
        observable_rows = [
            self._row(offset=0, event_type="book_update"),
            self._row(offset=1, event_type="quote_update"),
            self._row(offset=2, event_type="cancel"),
        ]
        censored_trade_rows = [
            self._row(offset=0, event_type="trade", quote=False, depth=False),
            self._row(offset=1, event_type="trade", quote=False, depth=False),
            self._row(offset=2, event_type="fill", quote=False, depth=False),
        ]

        observable = extract_order_book_observability_stress(
            observable_rows,
            direction=1,
            max_notional=Decimal("25000"),
        ).to_payload()
        censored = extract_order_book_observability_stress(
            censored_trade_rows,
            direction=1,
            max_notional=Decimal("25000"),
        ).to_payload()

        self.assertGreater(
            float(censored["replay_rank_penalty_bps"]),
            float(observable["replay_rank_penalty_bps"]) + 40.0,
        )
        self.assertEqual(censored["observed_quote_count"], 0)
        self.assertEqual(censored["observed_depth_count"], 0)
        self.assertIn("high_trade_censored_share", censored["warnings"])
        self.assertIn("missing_order_book_quotes", censored["warnings"])
        self.assertFalse(observable["proof_authority"])
        self.assertFalse(observable["promotion_authority"])
        self.assertTrue(observable["order_book_feedback_preview"])

    def test_contract_records_primary_sources_without_promotion_authority(self) -> None:
        contract = order_book_observability_stress_contract()

        self.assertEqual(
            [item["source_id"] for item in contract["source_papers"]],
            [
                item["source_id"]
                for item in ORDER_BOOK_OBSERVABILITY_STRESS_PRIMARY_SOURCES
            ],
        )
        self.assertTrue(contract["proof_neutrality"]["requires_exact_replay"])
        self.assertTrue(contract["proof_neutrality"]["requires_route_tca"])
        self.assertTrue(contract["proof_neutrality"]["requires_runtime_ledger"])
        self.assertFalse(contract["proof_neutrality"]["promotion_proof"])
