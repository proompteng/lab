from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal
from unittest import TestCase

import app.trading.discovery.ofi_response_horizon_stress as stress
from app.trading.discovery.ofi_response_horizon_stress import (
    build_ofi_response_horizon_stress_schema_hash,
    extract_ofi_response_horizon_stress,
    ofi_response_horizon_stress_contract,
)
from app.trading.models import SignalEnvelope


class TestOfiResponseHorizonStress(TestCase):
    def _row(
        self,
        *,
        offset: int,
        price: str,
        ofi: str | None,
        spread_bps: str = "2.0",
        macro: bool = False,
        volume: str = "100000",
    ) -> SignalEnvelope:
        payload: dict[str, object] = {
            "price": Decimal(price),
            "spread_bps": Decimal(spread_bps),
            "microbar_volume": Decimal(volume),
            "macro_event_window": macro,
        }
        if ofi is not None:
            payload["ofi"] = Decimal(ofi)
        return SignalEnvelope(
            event_ts=datetime(2026, 3, 25, 14, 30, tzinfo=timezone.utc)
            + timedelta(seconds=offset),
            symbol="OFI",
            timeframe="1s",
            seq=offset,
            source="ofi-response-horizon-fixture",
            payload=payload,
            ingest_ts=datetime(2026, 3, 25, 14, 31, tzinfo=timezone.utc),
        )

    def test_aligned_short_horizon_response_beats_stale_macro_reversal(self) -> None:
        aligned = extract_ofi_response_horizon_stress(
            (
                self._row(offset=0, price="100.00", ofi="0.70"),
                self._row(offset=1, price="100.05", ofi="0.60"),
                self._row(offset=2, price="100.08", ofi="0.35"),
                self._row(offset=3, price="100.09", ofi="0.10"),
                self._row(offset=4, price="100.10", ofi="0.05"),
            ),
            direction=1,
        )
        stale_macro = extract_ofi_response_horizon_stress(
            (
                self._row(
                    offset=0,
                    price="100.00",
                    ofi="0.90",
                    spread_bps="15.0",
                    macro=True,
                ),
                self._row(
                    offset=1,
                    price="99.98",
                    ofi="0.85",
                    spread_bps="25.0",
                    macro=True,
                ),
                self._row(
                    offset=2,
                    price="99.95",
                    ofi="0.80",
                    spread_bps="28.0",
                    macro=True,
                ),
                self._row(
                    offset=3,
                    price="100.25",
                    ofi="0.75",
                    spread_bps="30.0",
                    macro=True,
                ),
                self._row(
                    offset=4,
                    price="99.70",
                    ofi="0.70",
                    spread_bps="32.0",
                    macro=True,
                ),
            ),
            direction=1,
        )

        self.assertGreater(
            aligned.short_horizon_response_bps,
            stale_macro.short_horizon_response_bps,
        )
        self.assertGreater(
            aligned.direction_adjusted_ofi_return_alignment,
            stale_macro.direction_adjusted_ofi_return_alignment,
        )
        self.assertGreater(
            stale_macro.macro_news_distortion_score,
            aligned.macro_news_distortion_score,
        )
        self.assertGreater(
            stale_macro.shock_dissipation_gap_score,
            aligned.shock_dissipation_gap_score,
        )
        self.assertGreater(
            stale_macro.replay_rank_penalty_bps, aligned.replay_rank_penalty_bps
        )
        payload = stale_macro.to_payload()
        self.assertEqual(
            payload["status"], "preview_only_ofi_response_horizon_stress_ranking"
        )
        self.assertTrue(payload["ofi_horizon_response_preview"])
        self.assertTrue(payload["macro_news_ofi_distortion_preview"])
        self.assertFalse(payload["proof_authority"])
        self.assertFalse(payload["promotion_authority"])
        self.assertFalse(payload["final_authority_ok"])
        self.assertIn(
            "ofi_response_horizon_arxiv_2505_17388_2025",
            payload["source_markers"],
        )
        self.assertIn(
            "intraday_ofi_macro_news_arxiv_2508_06788_2025",
            payload["source_markers"],
        )

    def test_missing_ofi_fails_closed_with_source_gap_and_contract_sources(
        self,
    ) -> None:
        summary = extract_ofi_response_horizon_stress(
            (
                self._row(offset=0, price="100.00", ofi=None),
                self._row(offset=1, price="100.01", ofi=None),
            )
        )
        payload = summary.to_payload()
        contract = ofi_response_horizon_stress_contract()
        source_ids = {source["source_id"] for source in payload["source_papers"]}

        self.assertEqual(
            payload["feature_schema_hash"],
            build_ofi_response_horizon_stress_schema_hash(),
        )
        self.assertIn("arxiv-2505.17388", source_ids)
        self.assertIn("arxiv-2508.06788", source_ids)
        self.assertIn(
            "ofi_response_horizon_arxiv_2505_17388_2025",
            payload["source_markers"],
        )
        self.assertIn(
            "intraday_ofi_macro_news_arxiv_2508_06788_2025",
            payload["source_markers"],
        )
        self.assertIn(
            "ofi_response_horizon_arxiv_2505_17388_2025",
            contract["source_markers"],
        )
        self.assertIn(
            "intraday_ofi_macro_news_arxiv_2508_06788_2025",
            contract["source_markers"],
        )
        self.assertIn(
            "missing_order_flow_imbalance_for_response_horizon", payload["warnings"]
        )
        self.assertGreater(payload["source_gap_score"], 0)
        self.assertFalse(contract["proof_neutrality"]["proof_authority"])
        self.assertTrue(
            contract["proof_neutrality"]["rejects_ofi_response_as_pnl_authority"]
        )

    def test_edge_case_helpers_keep_stress_fail_closed_and_bounded(self) -> None:
        self.assertEqual(
            stress._horizon_responses(
                prices=(0.0, 100.0),
                ofi_values=(0.9, 0.8),
                direction=1.0,
                horizon_steps=1,
            ),
            [],
        )
        self.assertEqual(stress._alignment_score((0.0, 0.0)), 0.0)
        self.assertEqual(stress._reversal_share((0.0, 0.0), (1.0, 2.0)), 0.0)
        self.assertEqual(stress._response_instability((0.0, 0.0, 0.0)), 0.0)
        self.assertEqual(
            stress._source_gap_score(
                row_count=0,
                observed_ofi_count=0,
                observed_price_count=0,
                observed_spread_count=0,
                observed_volume_count=0,
            ),
            1.0,
        )
        self.assertEqual(
            stress._shock_dissipation_gap(
                prices=(100.0, 103.0, 103.0, 103.0, 103.0),
                ofi_values=(0.9, 0.8, 0.7, 0.6, 0.5),
                direction=1.0,
            ),
            0.0,
        )

        self.assertEqual(
            stress._extract_macro_value({"macro_event_window": "0.25"}), 0.25
        )
        self.assertEqual(
            stress._extract_macro_value({"macro_event_window": "news"}), 1.0
        )
        self.assertEqual(
            stress._extract_macro_value({"macro_event_window": "normal"}), 0.0
        )
        self.assertEqual(
            stress._first_finite(
                {"features": {"mid_price": "101.25"}}, ("price", "mid_price")
            ),
            101.25,
        )
        self.assertIsNone(stress._float_or_none(None))
        self.assertIsNone(stress._float_or_none("not-a-number"))
        self.assertIsNone(stress._float_or_none("nan"))
        self.assertEqual(stress._median(()), 0.0)
        self.assertEqual(stress._stable_float(float("nan")), 0.0)
