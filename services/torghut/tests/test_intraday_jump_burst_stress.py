from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal
from unittest import TestCase

from app.trading.discovery.intraday_jump_burst_stress import (
    build_intraday_jump_burst_stress_schema_hash,
    extract_intraday_jump_burst_stress,
    intraday_jump_burst_stress_contract,
)
from app.trading.models import SignalEnvelope


class TestIntradayJumpBurstStress(TestCase):
    def _row(
        self,
        *,
        offset: int,
        price: str,
        spread_bps: str | None = "1.0",
        volume: str | None = "100000",
        ofi: str | None = "0.05",
        jump_bps: str | None = None,
        news_window: bool = False,
        session_edge: bool = False,
    ) -> SignalEnvelope:
        payload: dict[str, object] = {"price": Decimal(price)}
        if spread_bps is not None:
            payload["spread_bps"] = Decimal(spread_bps)
        if volume is not None:
            payload["microbar_volume"] = Decimal(volume)
        if ofi is not None:
            payload["ofi"] = Decimal(ofi)
        if jump_bps is not None:
            payload["jump_bps"] = Decimal(jump_bps)
        if news_window:
            payload["macro_event_window"] = True
        if session_edge:
            payload["session_open_window"] = True
        return SignalEnvelope(
            event_ts=datetime(2026, 5, 29, 17, 0, tzinfo=timezone.utc)
            + timedelta(seconds=offset * 10),
            symbol="JUMP",
            timeframe="10s",
            seq=offset,
            source="intraday-jump-burst-fixture",
            payload=payload,
            ingest_ts=datetime(2026, 5, 29, 17, 1, tzinfo=timezone.utc),
        )

    def test_intraday_jump_burst_stress_penalizes_supported_jump_windows(self) -> None:
        benign = extract_intraday_jump_burst_stress(
            (
                self._row(offset=1, price="100.00"),
                self._row(offset=2, price="100.01"),
                self._row(offset=3, price="100.02"),
                self._row(offset=4, price="100.03"),
                self._row(offset=5, price="100.04"),
                self._row(offset=6, price="100.05"),
            )
        )
        stressed = extract_intraday_jump_burst_stress(
            (
                self._row(offset=1, price="100.00"),
                self._row(offset=2, price="100.01"),
                self._row(
                    offset=3,
                    price="98.40",
                    spread_bps="8.0",
                    volume="400000",
                    ofi="-0.90",
                    jump_bps="-180",
                    news_window=True,
                    session_edge=True,
                ),
                self._row(offset=4, price="98.45", spread_bps="4.5", volume="250000"),
                self._row(offset=5, price="98.48", spread_bps="3.5", volume="200000"),
                self._row(offset=6, price="98.50"),
            ),
            direction=1,
        )

        self.assertGreater(stressed.jump_event_count, benign.jump_event_count)
        self.assertGreater(stressed.jump_event_share, benign.jump_event_share)
        self.assertGreater(
            stressed.liquidity_shock_jump_share, benign.liquidity_shock_jump_share
        )
        self.assertGreater(stressed.news_burst_share, benign.news_burst_share)
        self.assertGreater(
            stressed.open_close_extreme_share, benign.open_close_extreme_share
        )
        self.assertGreater(
            stressed.replay_rank_penalty_bps, benign.replay_rank_penalty_bps
        )
        payload = stressed.to_payload()
        self.assertEqual(
            payload["status"], "preview_only_intraday_jump_burst_stress_ranking"
        )
        self.assertTrue(payload["intraday_jump_preview"])
        self.assertTrue(payload["volatility_burst_preview"])
        self.assertTrue(payload["spurious_jump_guard_preview"])
        self.assertTrue(payload["requires_tick_level_replay_downstream"])
        self.assertTrue(payload["requires_news_calendar_or_event_labels_downstream"])
        self.assertTrue(payload["requires_microstructure_noise_controls_downstream"])
        self.assertFalse(payload["proof_authority"])
        self.assertFalse(payload["promotion_authority"])
        self.assertFalse(payload["final_authority_ok"])

    def test_ambiguous_jump_without_context_fails_closed_as_source_gap(self) -> None:
        summary = extract_intraday_jump_burst_stress(
            (
                self._row(
                    offset=1, price="100.00", spread_bps=None, volume=None, ofi=None
                ),
                self._row(
                    offset=2,
                    price="97.50",
                    spread_bps=None,
                    volume=None,
                    ofi=None,
                    jump_bps="-250",
                ),
                self._row(
                    offset=3, price="97.51", spread_bps=None, volume=None, ofi=None
                ),
            )
        )
        payload = summary.to_payload()

        self.assertEqual(summary.jump_event_count, 1)
        self.assertEqual(summary.ambiguous_extreme_count, 1)
        self.assertGreater(summary.microstructure_source_gap_score, 0.0)
        self.assertGreater(summary.spurious_jump_risk_score, 0.0)
        self.assertIn(
            "ambiguous_intraday_jump_without_liquidity_or_news_context",
            summary.warnings,
        )
        self.assertIn("missing_spread_context", summary.warnings)
        self.assertIn("missing_volume_context", summary.warnings)
        self.assertFalse(payload["promotion_proof"])
        self.assertFalse(payload["promotion_allowed"])
        self.assertFalse(payload["final_promotion_allowed"])
        self.assertFalse(payload["final_authority_ok"])

    def test_contract_embeds_sources_and_keeps_proof_neutral(self) -> None:
        contract = intraday_jump_burst_stress_contract()
        payload = extract_intraday_jump_burst_stress(
            (
                self._row(offset=1, price="100.00"),
                self._row(offset=2, price="99.00", jump_bps="-100"),
            )
        ).to_payload()

        source_ids = {source["source_id"] for source in contract["source_papers"]}
        self.assertIn("ssrn-5223127", source_ids)
        self.assertIn("ssrn-5199540", source_ids)
        self.assertIn("arxiv-2602.10925", source_ids)
        proof_neutrality = contract["proof_neutrality"]
        self.assertTrue(proof_neutrality["requires_exact_replay"])
        self.assertTrue(proof_neutrality["requires_tick_level_replay"])
        self.assertTrue(proof_neutrality["requires_route_tca"])
        self.assertTrue(proof_neutrality["requires_runtime_ledger"])
        self.assertTrue(proof_neutrality["requires_news_calendar_or_event_labels"])
        self.assertTrue(proof_neutrality["requires_microstructure_noise_controls"])
        self.assertTrue(
            proof_neutrality["rejects_jump_proxy_as_realized_pnl_authority"]
        )
        self.assertTrue(
            proof_neutrality["rejects_coarse_bar_jump_as_exact_replay_authority"]
        )
        self.assertTrue(
            proof_neutrality["rejects_missing_news_labels_as_no_news_assumption"]
        )
        self.assertFalse(payload["promotion_proof"])
        self.assertFalse(payload["promotion_allowed"])
        self.assertEqual(
            payload["feature_schema_hash"],
            build_intraday_jump_burst_stress_schema_hash(),
        )
