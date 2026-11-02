from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal
from unittest import TestCase

from app.trading.discovery.rough_flow_volatility_stress import (
    extract_rough_flow_volatility_stress,
    rough_flow_volatility_stress_contract,
)
from app.trading.models import SignalEnvelope


class TestRoughFlowVolatilityStress(TestCase):
    def _row(
        self,
        offset: int,
        *,
        price: str,
        ofi: str,
        volume: str,
        seconds: int | None = None,
    ) -> SignalEnvelope:
        return SignalEnvelope(
            event_ts=datetime(2026, 4, 7, 14, 30, tzinfo=timezone.utc)
            + timedelta(seconds=seconds if seconds is not None else offset * 60),
            symbol="AAA",
            timeframe="1Min",
            seq=offset,
            source="test",
            payload={
                "price": Decimal(price),
                "ofi": Decimal(ofi),
                "microbar_volume": Decimal(volume),
                "event_type": "trade",
            },
            ingest_ts=datetime(2026, 4, 7, 14, 30, tzinfo=timezone.utc)
            + timedelta(seconds=(seconds if seconds is not None else offset * 60) + 1),
        )

    def test_persistent_rough_flow_downranks_more_than_smooth_flow(self) -> None:
        rough_rows = [
            self._row(0, price="100.00", ofi="0.80", volume="12000", seconds=0),
            self._row(1, price="100.20", ofi="0.75", volume="60000", seconds=1),
            self._row(2, price="99.85", ofi="0.78", volume="15000", seconds=20),
            self._row(3, price="100.55", ofi="0.82", volume="90000", seconds=21),
            self._row(4, price="99.90", ofi="0.79", volume="18000", seconds=80),
            self._row(5, price="101.00", ofi="0.84", volume="110000", seconds=81),
            self._row(6, price="100.05", ofi="0.81", volume="16000", seconds=220),
            self._row(7, price="101.35", ofi="0.83", volume="125000", seconds=221),
        ]
        smooth_rows = [
            self._row(0, price="100.00", ofi="0.10", volume="45000", seconds=0),
            self._row(1, price="100.02", ofi="0.02", volume="46000", seconds=50),
            self._row(2, price="100.01", ofi="-0.05", volume="45500", seconds=130),
            self._row(3, price="100.03", ofi="0.04", volume="45200", seconds=145),
            self._row(4, price="100.02", ofi="-0.01", volume="45800", seconds=270),
            self._row(5, price="100.04", ofi="0.03", volume="45100", seconds=360),
            self._row(6, price="100.03", ofi="-0.02", volume="45600", seconds=380),
            self._row(7, price="100.05", ofi="0.01", volume="45300", seconds=500),
        ]

        rough = extract_rough_flow_volatility_stress(rough_rows).to_payload()
        smooth = extract_rough_flow_volatility_stress(smooth_rows).to_payload()

        self.assertEqual(
            rough["status"], "preview_only_rough_flow_volatility_stress_ranking"
        )
        self.assertGreater(
            rough["ranking_features"]["replay_rank_penalty_bps"],
            smooth["ranking_features"]["replay_rank_penalty_bps"],
        )
        self.assertGreater(rough["ranking_features"]["rough_volume_score"], 0)
        self.assertGreater(rough["ranking_features"]["rough_volatility_score"], 0)
        self.assertIn(
            "arxiv-2601.23172", {p["source_id"] for p in rough["source_papers"]}
        )
        self.assertFalse(rough["promotion_authority"])
        self.assertFalse(rough["final_promotion_allowed"])

    def test_missing_inputs_fail_closed_with_warnings(self) -> None:
        rows = [self._row(0, price="100", ofi="0", volume="0")]
        payload = extract_rough_flow_volatility_stress(rows).to_payload()

        self.assertGreater(payload["ranking_features"]["replay_rank_penalty_bps"], 0)
        self.assertIn("insufficient_rough_flow_replay_rows", payload["warnings"])
        self.assertIn(
            "missing_return_path_for_rough_volatility_stress", payload["warnings"]
        )

    def test_contract_keeps_replay_and_runtime_ledger_authoritative(self) -> None:
        contract = rough_flow_volatility_stress_contract()

        self.assertEqual(
            {item["source_id"] for item in contract["source_papers"]},
            {"arxiv-2601.23172", "arxiv-2603.13170"},
        )
        self.assertFalse(contract["proof_neutrality"]["promotion_proof"])
        self.assertTrue(contract["proof_neutrality"]["requires_exact_tick_replay"])
        self.assertTrue(contract["proof_neutrality"]["requires_route_tca"])
        self.assertTrue(contract["proof_neutrality"]["requires_runtime_ledger"])
        self.assertTrue(
            contract["proof_neutrality"][
                "rejects_rough_volatility_as_directional_alpha_proof"
            ]
        )
