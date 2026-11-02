from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal
from unittest import TestCase

from app.trading.discovery.signal_adaptive_execution_resilience_stress import (
    extract_signal_adaptive_execution_resilience_stress,
    signal_adaptive_execution_resilience_stress_contract,
)
from app.trading.models import SignalEnvelope


class TestSignalAdaptiveExecutionResilienceStress(TestCase):
    def _row(
        self,
        *,
        offset: int,
        price: str,
        signal_bps: str,
        spread_bps: str,
        quote_offset_bps: str,
        fill_probability: str,
        inventory: str,
        visible_depth: str,
        impact_bps: str,
        event_type: str = "trade",
    ) -> SignalEnvelope:
        return SignalEnvelope(
            event_ts=datetime(2026, 5, 22, 14, 30, tzinfo=timezone.utc)
            + timedelta(seconds=offset),
            symbol="SAE",
            timeframe="1s",
            seq=offset,
            source="signal-adaptive-execution-fixture",
            payload={
                "price": Decimal(price),
                "signal_bps": Decimal(signal_bps),
                "spread_bps": Decimal(spread_bps),
                "quote_offset_bps": Decimal(quote_offset_bps),
                "fill_probability": Decimal(fill_probability),
                "inventory": Decimal(inventory),
                "target_inventory": Decimal("0"),
                "max_inventory": Decimal("1000"),
                "visible_depth": Decimal(visible_depth),
                "impact_bps": Decimal(impact_bps),
                "event_type": event_type,
            },
            ingest_ts=datetime(2026, 5, 22, 14, 30, tzinfo=timezone.utc)
            + timedelta(seconds=offset + 1),
        )

    def test_weak_signal_low_fill_and_depth_collapse_downrank_more(self) -> None:
        resilient_rows = [
            self._row(
                offset=0,
                price="100.00",
                signal_bps="9.0",
                spread_bps="1.0",
                quote_offset_bps="1.0",
                fill_probability="0.85",
                inventory="25",
                visible_depth="12000",
                impact_bps="0.5",
                event_type="limit",
            ),
            self._row(
                offset=1,
                price="100.03",
                signal_bps="8.5",
                spread_bps="1.1",
                quote_offset_bps="1.2",
                fill_probability="0.82",
                inventory="30",
                visible_depth="11800",
                impact_bps="0.6",
            ),
            self._row(
                offset=2,
                price="100.05",
                signal_bps="8.0",
                spread_bps="1.0",
                quote_offset_bps="1.0",
                fill_probability="0.80",
                inventory="20",
                visible_depth="12100",
                impact_bps="0.5",
                event_type="cancel",
            ),
        ]
        fragile_rows = [
            self._row(
                offset=0,
                price="100.00",
                signal_bps="0.2",
                spread_bps="8.0",
                quote_offset_bps="7.0",
                fill_probability="0.05",
                inventory="950",
                visible_depth="16000",
                impact_bps="9.0",
            ),
            self._row(
                offset=1,
                price="99.92",
                signal_bps="-0.1",
                spread_bps="9.0",
                quote_offset_bps="8.0",
                fill_probability="0.03",
                inventory="980",
                visible_depth="3500",
                impact_bps="12.0",
            ),
            self._row(
                offset=2,
                price="99.86",
                signal_bps="0.0",
                spread_bps="10.0",
                quote_offset_bps="9.0",
                fill_probability="0.02",
                inventory="990",
                visible_depth="2500",
                impact_bps="15.0",
            ),
        ]

        resilient = extract_signal_adaptive_execution_resilience_stress(
            resilient_rows
        ).to_payload()
        fragile = extract_signal_adaptive_execution_resilience_stress(
            fragile_rows
        ).to_payload()

        self.assertEqual(
            fragile["status"],
            "preview_only_signal_adaptive_execution_resilience_stress_ranking",
        )
        self.assertGreater(
            fragile["ranking_features"]["replay_rank_penalty_bps"],
            resilient["ranking_features"]["replay_rank_penalty_bps"],
        )
        self.assertGreater(fragile["ranking_features"]["signal_cost_mismatch_share"], 0)
        self.assertGreater(
            fragile["ranking_features"]["fill_intensity_shortfall_share"], 0
        )
        self.assertGreater(
            fragile["ranking_features"]["liquidity_regime_switch_share"], 0
        )
        self.assertIn(
            "arxiv-2605.24242",
            {source["source_id"] for source in fragile["source_papers"]},
        )
        self.assertFalse(fragile["promotion_authority"])
        self.assertFalse(fragile["final_promotion_allowed"])

    def test_missing_execution_inputs_fail_closed(self) -> None:
        row = SignalEnvelope(
            event_ts=datetime(2026, 5, 22, 14, 30, tzinfo=timezone.utc),
            symbol="SAE",
            timeframe="1Min",
            seq=1,
            source="missing-execution-fixture",
            payload={"price": Decimal("100")},
            ingest_ts=datetime(2026, 5, 22, 14, 31, tzinfo=timezone.utc),
        )

        payload = extract_signal_adaptive_execution_resilience_stress(
            (row,)
        ).to_payload()

        self.assertGreater(payload["ranking_features"]["replay_rank_penalty_bps"], 0)
        self.assertEqual(
            payload["ranking_features"]["missing_execution_metadata_score"], 1
        )
        self.assertIn("missing_signal_drift_or_alpha_fields", payload["warnings"])
        self.assertFalse(payload["promotion_proof"])

    def test_contract_keeps_route_tca_and_runtime_ledger_authoritative(self) -> None:
        contract = signal_adaptive_execution_resilience_stress_contract()

        self.assertEqual(
            {source["source_id"] for source in contract["source_papers"]},
            {"arxiv-2605.24242", "arxiv-2506.11813"},
        )
        neutrality = contract["proof_neutrality"]
        self.assertFalse(neutrality["promotion_proof"])
        self.assertTrue(neutrality["requires_exact_replay"])
        self.assertTrue(neutrality["requires_route_tca"])
        self.assertTrue(neutrality["requires_order_lifecycle_fill_evidence"])
        self.assertTrue(neutrality["requires_runtime_ledger"])
        self.assertTrue(neutrality["rejects_signal_drift_as_fill_or_pnl_authority"])
        self.assertTrue(
            neutrality["rejects_modeled_fill_intensity_as_runtime_ledger_authority"]
        )
