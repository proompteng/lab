from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal
from unittest import TestCase

from app.trading.discovery.queue_survival_fill_stress import (
    build_queue_survival_fill_stress_schema_hash,
    extract_queue_survival_fill_stress,
    queue_survival_fill_stress_contract,
)
from app.trading.models import SignalEnvelope


class TestQueueSurvivalFillStress(TestCase):
    def _row(
        self,
        *,
        offset: int,
        price: str,
        queue_ratio: str,
        bid_size: str,
        ask_size: str = "50",
        volume: str = "1",
        event_type: str = "add",
        fill_qty: str = "0",
        status: str = "accepted",
    ) -> SignalEnvelope:
        return SignalEnvelope(
            event_ts=datetime(2026, 5, 7, 14, 30, tzinfo=timezone.utc)
            + timedelta(seconds=offset),
            symbol="QST",
            timeframe="1S",
            seq=offset,
            source="queue-survival-fixture",
            payload={
                "price": Decimal(price),
                "spread_bps": Decimal("2"),
                "queue_ratio": Decimal(queue_ratio),
                "bid_size": Decimal(bid_size),
                "ask_size": Decimal(ask_size),
                "microbar_volume": Decimal(volume),
                "event_type": event_type,
                "order_status": status,
                "fill_qty": Decimal(fill_qty),
            },
            ingest_ts=datetime(2026, 5, 7, 14, 31, tzinfo=timezone.utc),
        )

    def test_queue_survival_stress_penalizes_crowded_nonfill_paths(self) -> None:
        fillable = extract_queue_survival_fill_stress(
            (
                self._row(
                    offset=1,
                    price="100.00",
                    queue_ratio="0.04",
                    bid_size="900",
                    volume="600",
                    event_type="add",
                ),
                self._row(
                    offset=2,
                    price="100.02",
                    queue_ratio="0.05",
                    bid_size="850",
                    volume="700",
                    event_type="trade",
                    fill_qty="300",
                    status="filled",
                ),
                self._row(
                    offset=3,
                    price="100.04",
                    queue_ratio="0.05",
                    bid_size="800",
                    volume="650",
                    event_type="trade",
                    fill_qty="300",
                    status="filled",
                ),
                self._row(
                    offset=4,
                    price="100.06",
                    queue_ratio="0.06",
                    bid_size="780",
                    volume="700",
                    event_type="trade",
                    fill_qty="300",
                    status="filled",
                ),
            ),
            direction=1,
            max_notional=10_000,
        )
        stressed = extract_queue_survival_fill_stress(
            (
                self._row(
                    offset=1,
                    price="100.00",
                    queue_ratio="0.92",
                    bid_size="20",
                    volume="1",
                    event_type="add",
                ),
                self._row(
                    offset=2,
                    price="100.35",
                    queue_ratio="0.95",
                    bid_size="18",
                    volume="1",
                    event_type="cancel",
                    status="cancelled",
                ),
                self._row(
                    offset=3,
                    price="100.70",
                    queue_ratio="0.96",
                    bid_size="15",
                    volume="1",
                    event_type="post_only_reject",
                    status="rejected",
                ),
                self._row(
                    offset=4,
                    price="101.00",
                    queue_ratio="0.98",
                    bid_size="16",
                    volume="1",
                    event_type="add",
                ),
            ),
            direction=1,
            max_notional=10_000,
        )

        self.assertGreater(
            fillable.estimated_limit_fill_probability,
            stressed.estimated_limit_fill_probability,
        )
        self.assertGreater(
            stressed.queue_delay_penalty_bps, fillable.queue_delay_penalty_bps
        )
        self.assertGreater(
            stressed.replay_rank_penalty_bps, fillable.replay_rank_penalty_bps
        )
        self.assertGreater(stressed.nonfill_opportunity_cost_bps, 0.0)
        self.assertGreaterEqual(stressed.visible_depth_notional_shortfall_share, 0.75)

        stressed_payload = stressed.to_payload()
        self.assertEqual(
            stressed_payload["status"],
            "preview_only_queue_survival_fill_stress_ranking",
        )
        self.assertTrue(stressed_payload["queue_position_survival_preview"])
        self.assertTrue(stressed_payload["execution_delay_depth_preview"])
        self.assertTrue(stressed_payload["queue_reactive_replay_parity_preview"])
        self.assertFalse(stressed_payload["proof_authority"])
        self.assertFalse(stressed_payload["promotion_authority"])
        self.assertFalse(stressed_payload["final_authority_ok"])
        self.assertIn("ranking_features", stressed_payload)
        self.assertIn(
            "queue_reactive_event_mix_l1", stressed_payload["ranking_features"]
        )

    def test_queue_reactive_event_mix_and_order_size_parity_penalize_bad_replay(
        self,
    ) -> None:
        plausible_replay = extract_queue_survival_fill_stress(
            (
                self._row(
                    offset=1,
                    price="100.00",
                    queue_ratio="0.45",
                    bid_size="1000",
                    volume="45",
                    event_type="add",
                ),
                self._row(
                    offset=2,
                    price="100.01",
                    queue_ratio="0.50",
                    bid_size="950",
                    volume="80",
                    event_type="trade",
                    fill_qty="80",
                    status="filled",
                ),
                self._row(
                    offset=3,
                    price="100.00",
                    queue_ratio="0.55",
                    bid_size="900",
                    volume="60",
                    event_type="cancel",
                    status="cancelled",
                ),
                self._row(
                    offset=4,
                    price="100.02",
                    queue_ratio="0.48",
                    bid_size="980",
                    volume="55",
                    event_type="add",
                ),
                self._row(
                    offset=5,
                    price="100.01",
                    queue_ratio="0.52",
                    bid_size="920",
                    volume="70",
                    event_type="replace",
                ),
            ),
            direction=1,
            max_notional=10_000,
        ).to_payload()
        bad_replay = extract_queue_survival_fill_stress(
            (
                self._row(
                    offset=1,
                    price="100.00",
                    queue_ratio="0.45",
                    bid_size="100",
                    volume="5000",
                    event_type="heartbeat",
                ),
                self._row(
                    offset=2,
                    price="100.04",
                    queue_ratio="0.50",
                    bid_size="100",
                    volume="6000",
                    event_type="heartbeat",
                ),
                self._row(
                    offset=3,
                    price="100.08",
                    queue_ratio="0.55",
                    bid_size="100",
                    volume="5500",
                    event_type="heartbeat",
                ),
                self._row(
                    offset=4,
                    price="100.12",
                    queue_ratio="0.52",
                    bid_size="100",
                    volume="6500",
                    event_type="heartbeat",
                ),
            ),
            direction=1,
            max_notional=10_000,
        ).to_payload()

        self.assertGreater(
            float(bad_replay["queue_reactive_event_mix_l1"]),
            float(plausible_replay["queue_reactive_event_mix_l1"]),
        )
        self.assertGreater(
            float(bad_replay["order_size_distribution_wasserstein_proxy"]),
            float(plausible_replay["order_size_distribution_wasserstein_proxy"]),
        )
        self.assertGreater(
            float(bad_replay["queue_reactive_replay_parity_penalty_bps"]),
            float(plausible_replay["queue_reactive_replay_parity_penalty_bps"]),
        )
        self.assertFalse(bad_replay["promotion_allowed"])
        self.assertFalse(bad_replay["final_authority_ok"])

    def test_contract_embeds_recent_sources_and_requires_authoritative_proof(
        self,
    ) -> None:
        contract = queue_survival_fill_stress_contract()
        payload = extract_queue_survival_fill_stress(
            (
                self._row(offset=1, price="100", queue_ratio="0.25", bid_size="100"),
                self._row(offset=2, price="99.98", queue_ratio="0.30", bid_size="90"),
                self._row(offset=3, price="100.02", queue_ratio="0.35", bid_size="80"),
            ),
            direction=-1,
            max_notional="5000",
        ).to_payload()
        source_ids = {source["source_id"] for source in payload["source_papers"]}

        self.assertEqual(
            payload["feature_schema_hash"],
            build_queue_survival_fill_stress_schema_hash(),
        )
        self.assertIn("arxiv-2512.05734", source_ids)
        self.assertIn("arxiv-2501.08822", source_ids)
        self.assertIn("arxiv-2511.15262", source_ids)
        self.assertIn("ssrn-6440898", source_ids)
        self.assertIn("ssrn-6730443", source_ids)
        self.assertTrue(contract["proof_neutrality"]["requires_exact_replay"])
        self.assertTrue(contract["proof_neutrality"]["requires_route_tca"])
        self.assertTrue(
            contract["proof_neutrality"]["requires_order_lifecycle_fill_evidence"]
        )
        self.assertTrue(
            contract["proof_neutrality"]["requires_queue_reactive_replay_parity"]
        )
        self.assertTrue(contract["proof_neutrality"]["requires_runtime_ledger"])
        self.assertTrue(
            contract["proof_neutrality"][
                "rejects_queue_reactive_replay_parity_as_pnl_proof"
            ]
        )
        self.assertFalse(contract["proof_neutrality"]["promotion_proof"])
        self.assertFalse(payload["promotion_allowed"])
