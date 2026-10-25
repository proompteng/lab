from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal
from unittest import TestCase

from app.trading.discovery.order_transition_stress import (
    ORDER_TRANSITION_STRESS_PRIMARY_SOURCES,
    extract_order_transition_stress,
    order_transition_stress_contract,
)
from app.trading.models import SignalEnvelope


class TestOrderTransitionStress(TestCase):
    def _row(
        self,
        *,
        offset: int,
        event_type: str,
        side: str = "buy",
        spread_bps: str = "2",
        bid_size: str = "1000",
        ask_size: str = "1000",
        ofi: str = "0.10",
        volume: str = "10000",
    ) -> SignalEnvelope:
        return SignalEnvelope(
            event_ts=datetime(2026, 4, 24, 13, 30, tzinfo=timezone.utc)
            + timedelta(seconds=offset),
            symbol="AAA",
            timeframe="1S",
            seq=offset,
            source="fixture",
            payload={
                "event_type": event_type,
                "side": side,
                "spread_bps": Decimal(spread_bps),
                "bid_size": Decimal(bid_size),
                "ask_size": Decimal(ask_size),
                "ofi": Decimal(ofi),
                "microbar_volume": Decimal(volume),
            },
            ingest_ts=datetime(2026, 4, 24, 13, 30, 1, tzinfo=timezone.utc),
        )

    def test_transition_entropy_and_latent_buildup_raise_replay_penalty(self) -> None:
        stable_rows = [
            self._row(offset=index, event_type="add", ofi="0.05") for index in range(6)
        ]
        stressed_rows = [
            self._row(offset=0, event_type="add", spread_bps="2", ofi="0.05"),
            self._row(offset=1, event_type="cancel", spread_bps="3", ofi="0.20"),
            self._row(
                offset=2, event_type="trade", side="buy", spread_bps="6", ofi="0.55"
            ),
            self._row(
                offset=3,
                event_type="trade",
                side="sell",
                spread_bps="9",
                bid_size="200",
                ask_size="250",
                ofi="-0.70",
                volume="2500",
            ),
            self._row(
                offset=4,
                event_type="modify",
                spread_bps="12",
                bid_size="100",
                ask_size="120",
                ofi="0.85",
                volume="1000",
            ),
            self._row(
                offset=5,
                event_type="trade",
                side="sell",
                spread_bps="15",
                bid_size="60",
                ask_size="80",
                ofi="-0.95",
                volume="500",
            ),
        ]

        stable = extract_order_transition_stress(stable_rows).to_payload()
        stressed = extract_order_transition_stress(stressed_rows).to_payload()

        self.assertGreater(
            float(stressed["normalized_transition_entropy"]),
            float(stable["normalized_transition_entropy"]),
        )
        self.assertGreater(
            float(stressed["latent_build_up_score"]),
            float(stable["latent_build_up_score"]),
        )
        self.assertGreater(
            float(stressed["replay_rank_penalty_bps"]),
            float(stable["replay_rank_penalty_bps"]),
        )
        self.assertTrue(stressed["markov_transition_matrix_preview"])
        self.assertTrue(stressed["latent_regime_rising_edge_preview"])
        self.assertFalse(stressed["proof_authority"])
        self.assertFalse(stressed["promotion_authority"])

    def test_contract_records_primary_sources_without_promotion_authority(self) -> None:
        contract = order_transition_stress_contract()

        self.assertEqual(
            [item["source_id"] for item in contract["source_papers"]],
            [item["source_id"] for item in ORDER_TRANSITION_STRESS_PRIMARY_SOURCES],
        )
        self.assertTrue(contract["proof_neutrality"]["requires_exact_replay"])
        self.assertTrue(contract["proof_neutrality"]["requires_route_tca"])
        self.assertTrue(contract["proof_neutrality"]["requires_runtime_ledger"])
        self.assertFalse(contract["proof_neutrality"]["promotion_proof"])
