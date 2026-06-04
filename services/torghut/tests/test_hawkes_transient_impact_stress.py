from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal
from unittest import TestCase

from app.trading.discovery.hawkes_transient_impact_stress import (
    build_hawkes_transient_impact_stress_schema_hash,
    extract_hawkes_transient_impact_stress,
    hawkes_transient_impact_stress_contract,
)
from app.trading.models import SignalEnvelope


class TestHawkesTransientImpactStress(TestCase):
    def _row(
        self,
        *,
        offset_ms: int,
        price: str,
        side: str | None = "buy",
        quantity: str | None = "100",
        volume: str | None = "10000",
        spread_bps: str | None = "1.0",
        depth: str | None = "5000",
        participation_rate: str | None = "0.01",
        latency_ms: str | None = "4",
    ) -> SignalEnvelope:
        payload: dict[str, object] = {"price": Decimal(price)}
        if side is not None:
            payload["side"] = side
        if quantity is not None:
            payload["quantity"] = Decimal(quantity)
        if volume is not None:
            payload["microbar_volume"] = Decimal(volume)
        if spread_bps is not None:
            payload["spread_bps"] = Decimal(spread_bps)
        if depth is not None:
            payload["top_depth"] = Decimal(depth)
        if participation_rate is not None:
            payload["participation_rate"] = Decimal(participation_rate)
        if latency_ms is not None:
            payload["route_latency_ms"] = Decimal(latency_ms)
        return SignalEnvelope(
            event_ts=datetime(2026, 4, 4, 14, 0, tzinfo=timezone.utc)
            + timedelta(milliseconds=offset_ms),
            symbol="IMPACT",
            timeframe="event",
            seq=offset_ms,
            source="hawkes-transient-impact-fixture",
            payload=payload,
            ingest_ts=datetime(2026, 4, 4, 14, 1, tzinfo=timezone.utc),
        )

    def test_bursty_same_side_flow_increases_transient_impact_penalty(self) -> None:
        calm = extract_hawkes_transient_impact_stress(
            (
                self._row(offset_ms=0, price="100.00", side="buy"),
                self._row(offset_ms=60000, price="100.01", side="sell"),
                self._row(offset_ms=120000, price="100.00", side="buy"),
                self._row(offset_ms=180000, price="100.01", side="sell"),
            ),
            max_notional=10_000,
        )
        stressed = extract_hawkes_transient_impact_stress(
            (
                self._row(offset_ms=0, price="100.00", side="buy", quantity="1500"),
                self._row(offset_ms=50, price="100.08", side="buy", quantity="1800"),
                self._row(offset_ms=90, price="100.17", side="buy", quantity="1600"),
                self._row(offset_ms=120, price="100.22", side="sell", quantity="900"),
                self._row(offset_ms=160, price="100.31", side="buy", quantity="1700"),
            ),
            direction=1,
            max_notional=250_000,
        )

        self.assertGreater(stressed.burst_event_share, calm.burst_event_share)
        self.assertGreater(
            stressed.same_side_cluster_share, calm.same_side_cluster_share
        )
        self.assertGreater(
            stressed.transient_impact_pressure_bps,
            calm.transient_impact_pressure_bps,
        )
        self.assertGreater(
            stressed.square_root_impact_pressure_bps,
            calm.square_root_impact_pressure_bps,
        )
        self.assertGreater(
            stressed.replay_rank_penalty_bps, calm.replay_rank_penalty_bps
        )
        payload = stressed.to_payload()
        self.assertEqual(
            payload["status"],
            "preview_only_hawkes_transient_impact_stress_ranking",
        )
        self.assertTrue(payload["hawkes_excitation_preview"])
        self.assertIn(
            "hawkes_transient_impact_arxiv_2504_10282_2025",
            payload["source_markers"],
        )
        self.assertIn(
            "state_dependent_hawkes_arxiv_2604_23961_2026",
            payload["source_markers"],
        )
        self.assertTrue(payload["transient_impact_preview"])
        self.assertTrue(payload["square_root_impact_preview"])
        self.assertFalse(payload["proof_authority"])
        self.assertFalse(payload["promotion_authority"])
        self.assertFalse(payload["final_authority_ok"])

    def test_missing_event_signs_and_execution_context_fail_closed(self) -> None:
        summary = extract_hawkes_transient_impact_stress(
            (
                self._row(
                    offset_ms=0,
                    price="100.00",
                    side=None,
                    quantity="1000",
                    volume=None,
                    spread_bps=None,
                    depth=None,
                    participation_rate=None,
                    latency_ms=None,
                ),
                self._row(
                    offset_ms=600000,
                    price="100.25",
                    side=None,
                    quantity="1100",
                    volume=None,
                    spread_bps=None,
                    depth=None,
                    participation_rate=None,
                    latency_ms=None,
                ),
            )
        )
        payload = summary.to_payload()

        self.assertGreater(summary.source_gap_score, 0.0)
        self.assertIn("missing_signed_order_flow_events", summary.warnings)
        self.assertIn("missing_volume_context", summary.warnings)
        self.assertIn("missing_spread_context", summary.warnings)
        self.assertIn("coarse_replay_clock_for_hawkes_stress", summary.warnings)
        self.assertFalse(payload["promotion_proof"])
        self.assertFalse(payload["promotion_allowed"])
        self.assertFalse(payload["final_promotion_allowed"])

    def test_contract_embeds_primary_sources_and_proof_boundary(self) -> None:
        contract = hawkes_transient_impact_stress_contract()
        payload = extract_hawkes_transient_impact_stress(
            (
                self._row(offset_ms=0, price="100.00"),
                self._row(offset_ms=50, price="100.08"),
            )
        ).to_payload()

        source_ids = {source["source_id"] for source in contract["source_papers"]}
        self.assertIn("arxiv-2504.10282", source_ids)
        self.assertIn("arxiv-2603.29086", source_ids)
        self.assertIn("ssrn-5170318", source_ids)
        self.assertIn("arxiv-2604.23961", source_ids)
        self.assertIn(
            "orderbook_hawkes_random_environment_ssrn_5170318_2025",
            contract["source_markers"],
        )
        self.assertIn(
            "state_dependent_hawkes_arxiv_2604_23961_2026",
            contract["source_markers"],
        )
        proof_neutrality = contract["proof_neutrality"]
        self.assertTrue(proof_neutrality["requires_exact_replay"])
        self.assertTrue(proof_neutrality["requires_event_time_replay"])
        self.assertTrue(proof_neutrality["requires_order_lifecycle_events"])
        self.assertTrue(proof_neutrality["requires_route_tca"])
        self.assertTrue(proof_neutrality["requires_runtime_ledger"])
        self.assertTrue(proof_neutrality["rejects_hawkes_intensity_as_fill_authority"])
        self.assertTrue(
            proof_neutrality["rejects_modeled_impact_as_realized_pnl_authority"]
        )
        self.assertTrue(
            proof_neutrality["rejects_missing_event_signs_as_neutral_order_flow"]
        )
        self.assertEqual(
            payload["feature_schema_hash"],
            build_hawkes_transient_impact_stress_schema_hash(),
        )
        self.assertFalse(payload["proof_authority"])
        self.assertFalse(payload["promotion_authority"])
