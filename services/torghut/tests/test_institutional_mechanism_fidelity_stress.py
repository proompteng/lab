from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal
from unittest import TestCase

from app.trading.discovery.institutional_mechanism_fidelity_stress import (
    extract_institutional_mechanism_fidelity_stress,
    institutional_mechanism_fidelity_stress_contract,
)
from app.trading.models import SignalEnvelope


class TestInstitutionalMechanismFidelityStress(TestCase):
    def _row(
        self,
        *,
        symbol: str = "AAA",
        offset: int,
        price: str,
        phase: str = "continuous",
        tick_size: str = "0.01",
        event_type: str = "trade",
        latency_ms: str = "12",
        limit_up_price: str | None = None,
        limit_down_price: str | None = None,
        price_limit_hit: bool = False,
        opening_auction: bool = False,
    ) -> SignalEnvelope:
        payload = {
            "price": Decimal(price),
            "market_phase": phase,
            "tick_size": Decimal(tick_size),
            "event_type": event_type,
            "propagation_delay_ms": Decimal(latency_ms),
            "opening_auction": opening_auction,
            "price_limit_hit": price_limit_hit,
        }
        if limit_up_price is not None:
            payload["limit_up_price"] = Decimal(limit_up_price)
        if limit_down_price is not None:
            payload["limit_down_price"] = Decimal(limit_down_price)
        return SignalEnvelope(
            event_ts=datetime(2026, 4, 20, 15, 30, tzinfo=timezone.utc)
            + timedelta(milliseconds=offset),
            symbol=symbol,
            timeframe="1ms",
            seq=offset,
            source="institutional-mechanism-fixture",
            payload=payload,
            ingest_ts=datetime(2026, 4, 20, 15, 30, tzinfo=timezone.utc)
            + timedelta(milliseconds=offset + 1),
        )

    def test_boundary_limit_tick_and_async_rows_downrank_more_than_continuous_rows(
        self,
    ) -> None:
        stable_rows = [
            self._row(offset=0, price="100.00", event_type="limit"),
            self._row(offset=10, price="100.01", event_type="trade"),
            self._row(offset=20, price="100.02", event_type="cancel"),
            self._row(offset=30, price="100.01", event_type="limit"),
        ]
        fragile_rows = [
            self._row(
                symbol="AAA",
                offset=0,
                price="100.003",
                phase="opening_auction",
                tick_size="0.01",
                event_type="limit",
                latency_ms="500",
                limit_up_price="100.00",
                price_limit_hit=True,
                opening_auction=True,
            ),
            self._row(
                symbol="BBB",
                offset=2500,
                price="101.997",
                phase="opening_auction",
                tick_size="0.01",
                event_type="trade",
                latency_ms="450",
                limit_up_price="102.00",
                price_limit_hit=True,
                opening_auction=True,
            ),
            self._row(
                symbol="AAA",
                offset=6000,
                price="99.997",
                phase="limit_down_halt",
                tick_size="0.01",
                event_type="cancel",
                latency_ms="700",
                limit_down_price="100.00",
                price_limit_hit=True,
                opening_auction=False,
            ),
        ]

        stable = extract_institutional_mechanism_fidelity_stress(
            stable_rows
        ).to_payload()
        fragile = extract_institutional_mechanism_fidelity_stress(
            fragile_rows
        ).to_payload()

        self.assertEqual(
            fragile["status"],
            "preview_only_institutional_mechanism_fidelity_stress_ranking",
        )
        self.assertGreater(
            fragile["ranking_features"]["replay_rank_penalty_bps"],
            stable["ranking_features"]["replay_rank_penalty_bps"],
        )
        self.assertGreater(
            fragile["ranking_features"]["price_limit_proximity_share"], 0
        )
        self.assertGreater(
            fragile["ranking_features"]["tick_rounding_violation_share"], 0
        )
        self.assertGreater(
            fragile["ranking_features"]["cross_asset_async_gap_share"], 0
        )
        self.assertIn(
            "arxiv-2604.18046",
            {source["source_id"] for source in fragile["source_papers"]},
        )
        self.assertFalse(fragile["promotion_authority"])
        self.assertFalse(fragile["final_promotion_allowed"])

    def test_missing_mechanism_metadata_fails_closed(self) -> None:
        row = SignalEnvelope(
            event_ts=datetime(2026, 4, 20, 15, 30, tzinfo=timezone.utc),
            symbol="AAA",
            timeframe="1Min",
            seq=1,
            source="missing-mechanism-metadata-fixture",
            payload={"price": Decimal("100")},
            ingest_ts=datetime(2026, 4, 20, 15, 31, tzinfo=timezone.utc),
        )

        payload = extract_institutional_mechanism_fidelity_stress((row,)).to_payload()

        self.assertGreater(payload["ranking_features"]["replay_rank_penalty_bps"], 0)
        self.assertEqual(
            payload["ranking_features"]["missing_mechanism_metadata_score"], 1
        )
        self.assertIn("missing_market_phase_or_session_metadata", payload["warnings"])
        self.assertFalse(payload["promotion_proof"])

    def test_contract_requires_exact_exchange_mechanism_evidence(self) -> None:
        contract = institutional_mechanism_fidelity_stress_contract()

        self.assertEqual(
            {source["source_id"] for source in contract["source_papers"]},
            {"arxiv-2604.18046", "arxiv-2511.02016"},
        )
        neutrality = contract["proof_neutrality"]
        self.assertFalse(neutrality["promotion_proof"])
        self.assertTrue(neutrality["requires_exact_exchange_calendar_replay"])
        self.assertTrue(neutrality["requires_price_time_priority_order_lifecycle"])
        self.assertTrue(neutrality["requires_route_tca"])
        self.assertTrue(neutrality["requires_runtime_ledger"])
        self.assertTrue(neutrality["rejects_simulator_calibration_as_pnl_authority"])
