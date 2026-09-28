from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal
from unittest import TestCase

from app.trading.discovery.metaorder_adverse_selection_stress import (
    extract_metaorder_adverse_selection_stress,
    metaorder_adverse_selection_stress_contract,
)
from app.trading.models import SignalEnvelope


class TestMetaorderAdverseSelectionStress(TestCase):
    def _row(
        self,
        *,
        offset: int,
        price: str,
        event_type: str,
        trade_direction: str,
        spread_bps: str,
        imbalance: str,
        bid_size: str,
        ask_size: str,
        trade_size: str = "100",
    ) -> SignalEnvelope:
        return SignalEnvelope(
            event_ts=datetime(2026, 4, 17, 14, 30, tzinfo=timezone.utc)
            + timedelta(seconds=offset),
            symbol="META",
            timeframe="1s",
            seq=offset,
            source="metaorder-adverse-selection-fixture",
            payload={
                "price": Decimal(price),
                "event_type": event_type,
                "order_type": "market" if event_type == "trade" else "limit",
                "trade_direction": trade_direction,
                "base_imbalance": Decimal(imbalance),
                "spread_bps": Decimal(spread_bps),
                "bid_size": Decimal(bid_size),
                "ask_size": Decimal(ask_size),
                "trade_size": Decimal(trade_size),
            },
            ingest_ts=datetime(2026, 4, 17, 14, 30, tzinfo=timezone.utc)
            + timedelta(seconds=offset + 1),
        )

    def test_clustered_buy_metaorder_drift_downranks_more_than_balanced_flow(
        self,
    ) -> None:
        balanced_rows = [
            self._row(
                offset=0,
                price="100.00",
                event_type="trade",
                trade_direction="buy",
                spread_bps="1.0",
                imbalance="0.05",
                bid_size="1000",
                ask_size="1000",
            ),
            self._row(
                offset=20,
                price="100.01",
                event_type="add",
                trade_direction="sell",
                spread_bps="1.1",
                imbalance="0.00",
                bid_size="1100",
                ask_size="1050",
            ),
            self._row(
                offset=45,
                price="100.00",
                event_type="trade",
                trade_direction="sell",
                spread_bps="1.0",
                imbalance="-0.04",
                bid_size="1080",
                ask_size="1060",
            ),
            self._row(
                offset=90,
                price="100.01",
                event_type="cancel",
                trade_direction="buy",
                spread_bps="1.0",
                imbalance="0.02",
                bid_size="1070",
                ask_size="1080",
            ),
        ]
        toxic_rows = [
            self._row(
                offset=0,
                price="100.00",
                event_type="trade",
                trade_direction="buy",
                spread_bps="9.0",
                imbalance="0.45",
                bid_size="1200",
                ask_size="1000",
                trade_size="600",
            ),
            self._row(
                offset=2,
                price="100.06",
                event_type="trade",
                trade_direction="buy",
                spread_bps="9.5",
                imbalance="0.50",
                bid_size="1250",
                ask_size="520",
                trade_size="650",
            ),
            self._row(
                offset=4,
                price="100.14",
                event_type="trade",
                trade_direction="buy",
                spread_bps="10.0",
                imbalance="0.55",
                bid_size="1300",
                ask_size="300",
                trade_size="700",
            ),
            self._row(
                offset=6,
                price="100.22",
                event_type="trade",
                trade_direction="buy",
                spread_bps="11.0",
                imbalance="0.58",
                bid_size="1350",
                ask_size="180",
                trade_size="750",
            ),
        ]

        balanced = extract_metaorder_adverse_selection_stress(
            balanced_rows,
            direction=1,
        ).to_payload()
        toxic = extract_metaorder_adverse_selection_stress(
            toxic_rows,
            direction=1,
        ).to_payload()

        self.assertEqual(
            toxic["status"],
            "preview_only_metaorder_adverse_selection_stress_ranking",
        )
        self.assertGreater(
            toxic["ranking_features"]["replay_rank_penalty_bps"],
            balanced["ranking_features"]["replay_rank_penalty_bps"],
        )
        self.assertGreater(toxic["ranking_features"]["metaorder_footprint_share"], 0)
        self.assertGreater(
            toxic["ranking_features"]["adverse_selection_alignment_share"],
            0,
        )
        self.assertGreater(
            toxic["ranking_features"]["liquidity_replenishment_gap_share"],
            0,
        )
        self.assertIn(
            "arxiv-2510.27334",
            {source["source_id"] for source in toxic["source_papers"]},
        )
        self.assertIn(
            "doi-10.1007/s10203-026-00570-z",
            {source["source_id"] for source in toxic["source_papers"]},
        )
        self.assertFalse(toxic["promotion_proof"])
        self.assertFalse(toxic["promotion_authority"])

    def test_missing_inputs_fail_closed_and_contract_preserves_authority(self) -> None:
        payload = extract_metaorder_adverse_selection_stress(
            (
                SignalEnvelope(
                    event_ts=datetime(2026, 4, 17, 14, 30, tzinfo=timezone.utc),
                    symbol="META",
                    timeframe="1Min",
                    seq=1,
                    source="missing-metaorder-inputs",
                    payload={"price": Decimal("100")},
                    ingest_ts=datetime(2026, 4, 17, 14, 31, tzinfo=timezone.utc),
                ),
            )
        ).to_payload()

        self.assertGreater(payload["ranking_features"]["replay_rank_penalty_bps"], 0)
        self.assertIn("missing_lob_event_type_evidence", payload["warnings"])
        self.assertIn("missing_trade_direction_evidence", payload["warnings"])
        self.assertIn("missing_price_path_for_adverse_drift", payload["warnings"])
        self.assertFalse(payload["proof_authority"])
        self.assertFalse(payload["final_promotion_allowed"])

        contract = metaorder_adverse_selection_stress_contract()
        neutrality = contract["proof_neutrality"]
        self.assertFalse(neutrality["promotion_proof"])
        self.assertTrue(neutrality["requires_exact_replay"])
        self.assertTrue(neutrality["requires_route_tca"])
        self.assertTrue(neutrality["requires_order_lifecycle_fill_evidence"])
        self.assertTrue(neutrality["requires_runtime_ledger"])
        self.assertTrue(neutrality["rejects_metaorder_footprint_as_pnl_authority"])
        self.assertTrue(neutrality["rejects_hawkes_intensity_as_fill_authority"])
