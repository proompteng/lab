from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal
from unittest import TestCase

from app.trading.discovery.execution_schedule_stress import (
    EXECUTION_SCHEDULE_STRESS_PRIMARY_SOURCES,
    execution_schedule_stress_contract,
    extract_execution_schedule_stress,
)
from app.trading.models import SignalEnvelope


class TestExecutionScheduleStress(TestCase):
    def _row(
        self,
        *,
        offset: int,
        price: str,
        volume: str,
        spread_bps: str = "2",
    ) -> SignalEnvelope:
        return SignalEnvelope(
            event_ts=datetime(2026, 3, 30, 13, 30, tzinfo=timezone.utc)
            + timedelta(seconds=offset),
            symbol="AAA",
            timeframe="1S",
            seq=offset,
            source="fixture",
            payload={
                "price": Decimal(price),
                "microbar_volume": Decimal(volume),
                "spread_bps": Decimal(spread_bps),
            },
            ingest_ts=datetime(2026, 3, 30, 13, 30, 1, tzinfo=timezone.utc),
        )

    def test_clustered_volume_and_adverse_price_path_raise_schedule_stress(
        self,
    ) -> None:
        adverse_rows = [
            self._row(offset=0, price="100", volume="100"),
            self._row(offset=1, price="101", volume="100"),
            self._row(offset=2, price="102", volume="10000"),
            self._row(offset=3, price="103", volume="100"),
        ]
        benign_rows = [
            self._row(offset=0, price="100", volume="1000"),
            self._row(offset=1, price="100", volume="1000"),
            self._row(offset=2, price="100", volume="1000"),
            self._row(offset=3, price="100", volume="1000"),
        ]

        adverse = extract_execution_schedule_stress(
            adverse_rows, direction=1, max_notional=Decimal("25000")
        ).to_payload()
        benign = extract_execution_schedule_stress(
            benign_rows, direction=1, max_notional=Decimal("25000")
        ).to_payload()

        self.assertGreater(
            float(adverse["schedule_deviation_bps"]),
            float(benign["schedule_deviation_bps"]),
        )
        self.assertGreater(float(adverse["opportunity_cost_bps"]), 0)
        self.assertGreater(
            float(adverse["replay_rank_penalty_bps"]),
            float(benign["replay_rank_penalty_bps"]),
        )
        self.assertTrue(adverse["mpc_schedule_trace_preview"])
        self.assertTrue(adverse["market_limit_mix_preview"])
        self.assertFalse(adverse["proof_authority"])
        self.assertFalse(adverse["promotion_authority"])

    def test_contract_records_primary_sources_without_promotion_authority(self) -> None:
        contract = execution_schedule_stress_contract()

        self.assertEqual(
            [item["source_id"] for item in contract["source_papers"]],
            [item["source_id"] for item in EXECUTION_SCHEDULE_STRESS_PRIMARY_SOURCES],
        )
        self.assertTrue(contract["proof_neutrality"]["requires_exact_replay"])
        self.assertTrue(contract["proof_neutrality"]["requires_route_tca"])
        self.assertTrue(contract["proof_neutrality"]["requires_runtime_ledger"])
        self.assertFalse(contract["proof_neutrality"]["promotion_proof"])
