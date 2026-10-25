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
        latency_ms: str = "25",
        bid_size: str = "250000",
        ask_size: str = "250000",
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
                "route_latency_ms": Decimal(latency_ms),
                "bid_size": Decimal(bid_size),
                "ask_size": Decimal(ask_size),
            },
            ingest_ts=datetime(2026, 3, 30, 13, 30, tzinfo=timezone.utc)
            + timedelta(seconds=offset, milliseconds=int(Decimal(latency_ms))),
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
        self.assertGreater(adverse["observed_latency_count"], 0)
        self.assertIn(
            "latency_adjusted_limit_fill_probability",
            adverse["ranking_features"],
        )
        self.assertGreater(
            float(adverse["replay_rank_penalty_bps"]),
            float(benign["replay_rank_penalty_bps"]),
        )
        self.assertTrue(adverse["mpc_schedule_trace_preview"])
        self.assertTrue(adverse["market_limit_mix_preview"])
        self.assertFalse(adverse["proof_authority"])
        self.assertFalse(adverse["promotion_authority"])

    def test_submission_latency_and_sparse_depth_raise_limit_fill_risk(self) -> None:
        low_latency_liquid = [
            self._row(
                offset=0,
                price="100",
                volume="2500",
                spread_bps="1",
                latency_ms="15",
                bid_size="400000",
                ask_size="420000",
            ),
            self._row(
                offset=1,
                price="100.01",
                volume="2600",
                spread_bps="1",
                latency_ms="20",
                bid_size="390000",
                ask_size="410000",
            ),
            self._row(
                offset=2,
                price="100.00",
                volume="2400",
                spread_bps="1",
                latency_ms="18",
                bid_size="410000",
                ask_size="400000",
            ),
        ]
        high_latency_sparse = [
            self._row(
                offset=0,
                price="100",
                volume="250",
                spread_bps="9",
                latency_ms="450",
                bid_size="12000",
                ask_size="11000",
            ),
            self._row(
                offset=1,
                price="100.20",
                volume="200",
                spread_bps="11",
                latency_ms="500",
                bid_size="9000",
                ask_size="8500",
            ),
            self._row(
                offset=2,
                price="100.35",
                volume="180",
                spread_bps="12",
                latency_ms="550",
                bid_size="7000",
                ask_size="7500",
            ),
        ]

        liquid = extract_execution_schedule_stress(
            low_latency_liquid, direction=1, max_notional=Decimal("25000")
        ).to_payload()
        sparse = extract_execution_schedule_stress(
            high_latency_sparse, direction=1, max_notional=Decimal("25000")
        ).to_payload()

        self.assertEqual(liquid["observed_latency_count"], 3)
        self.assertEqual(sparse["observed_latency_count"], 3)
        self.assertGreater(
            float(liquid["latency_adjusted_limit_fill_probability"]),
            float(sparse["latency_adjusted_limit_fill_probability"]),
        )
        self.assertGreater(
            float(sparse["latency_forced_market_order_risk"]),
            float(liquid["latency_forced_market_order_risk"]),
        )
        self.assertGreater(
            float(sparse["replay_rank_penalty_bps"]),
            float(liquid["replay_rank_penalty_bps"]),
        )
        self.assertFalse(sparse["promotion_allowed"])
        self.assertFalse(sparse["final_promotion_allowed"])

    def test_contract_records_primary_sources_without_promotion_authority(self) -> None:
        contract = execution_schedule_stress_contract()

        self.assertEqual(
            [item["source_id"] for item in contract["source_papers"]],
            [item["source_id"] for item in EXECUTION_SCHEDULE_STRESS_PRIMARY_SOURCES],
        )
        self.assertIn(
            "arxiv-2504.00846",
            [item["source_id"] for item in contract["source_papers"]],
        )
        self.assertIn(
            "latency_adjusted_limit_fill_probability",
            contract["stress_components"],
        )
        self.assertTrue(contract["proof_neutrality"]["requires_exact_replay"])
        self.assertTrue(contract["proof_neutrality"]["requires_route_tca"])
        self.assertTrue(contract["proof_neutrality"]["requires_runtime_ledger"])
        self.assertTrue(
            contract["proof_neutrality"][
                "rejects_latency_fill_probability_as_promotion_proof"
            ]
        )
        self.assertFalse(contract["proof_neutrality"]["promotion_proof"])
