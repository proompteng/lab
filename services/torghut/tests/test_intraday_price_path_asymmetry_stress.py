from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal
from unittest import TestCase

from app.trading.discovery.intraday_price_path_asymmetry_stress import (
    build_intraday_price_path_asymmetry_stress_schema_hash,
    extract_intraday_price_path_asymmetry_stress,
    intraday_price_path_asymmetry_stress_contract,
)
from app.trading.models import SignalEnvelope


class TestIntradayPricePathAsymmetryStress(TestCase):
    def _row(
        self,
        *,
        symbol: str = "SPY",
        day_offset: int = 0,
        offset: int,
        price: str,
        open_price: str | None = None,
        high: str | None = None,
        low: str | None = None,
        close: str | None = None,
        late_return_bps: str | None = None,
        volatility_bps: str | None = "30",
    ) -> SignalEnvelope:
        payload: dict[str, object] = {"price": Decimal(price)}
        if open_price is not None:
            payload["open"] = Decimal(open_price)
        if high is not None:
            payload["high"] = Decimal(high)
        if low is not None:
            payload["low"] = Decimal(low)
        if close is not None:
            payload["close"] = Decimal(close)
        if late_return_bps is not None:
            payload["late_session_return_bps"] = Decimal(late_return_bps)
        if volatility_bps is not None:
            payload["volatility_bps"] = Decimal(volatility_bps)
        return SignalEnvelope(
            event_ts=datetime(2026, 2, 3 + day_offset, 14, 30, tzinfo=timezone.utc)
            + timedelta(minutes=offset),
            symbol=symbol,
            timeframe="1Min",
            seq=offset,
            source="intraday-price-path-asymmetry-fixture",
            payload=payload,
            ingest_ts=datetime(2026, 2, 3 + day_offset, 14, 31, tzinfo=timezone.utc),
        )

    def test_long_chasing_positive_intraday_asymmetry_is_downranked(self) -> None:
        contrarian_rows = (
            self._row(
                offset=1,
                price="100.00",
                open_price="100.00",
                high="101.00",
                low="95.00",
                close="96.00",
                late_return_bps="-20",
            ),
            self._row(offset=2, price="97.00"),
            self._row(offset=3, price="96.00"),
        )
        chase_rows = (
            self._row(
                offset=1,
                price="100.00",
                open_price="100.00",
                high="105.00",
                low="99.00",
                close="104.00",
                late_return_bps="20",
            ),
            self._row(offset=2, price="103.00"),
            self._row(offset=3, price="104.00"),
        )

        contrarian = extract_intraday_price_path_asymmetry_stress(
            contrarian_rows,
            direction=1,
        )
        chase = extract_intraday_price_path_asymmetry_stress(chase_rows, direction=1)

        self.assertGreater(
            contrarian.contrarian_alignment_score,
            chase.contrarian_alignment_score,
        )
        self.assertGreater(chase.momentum_chase_score, contrarian.momentum_chase_score)
        self.assertGreater(
            chase.replay_rank_penalty_bps, contrarian.replay_rank_penalty_bps
        )
        payload = chase.to_payload()
        self.assertEqual(
            payload["status"],
            "preview_only_intraday_price_path_asymmetry_stress_ranking",
        )
        self.assertIn(
            "intraday_asymmetry_momentum_chase_downranked", payload["warnings"]
        )
        self.assertTrue(payload["range_based_open_high_low_asymmetry_preview"])
        self.assertFalse(payload["proof_authority"])
        self.assertFalse(payload["promotion_authority"])
        self.assertFalse(payload["final_authority_ok"])

    def test_missing_path_inputs_fail_closed_as_source_gap(self) -> None:
        rows = (
            SignalEnvelope(
                event_ts=datetime(2026, 2, 3, 14, 30, tzinfo=timezone.utc)
                + timedelta(minutes=idx),
                symbol="SPY",
                timeframe="1Min",
                seq=idx,
                source="intraday-price-path-asymmetry-fixture",
                payload={"event_type": "unknown"},
            )
            for idx in range(3)
        )

        payload = extract_intraday_price_path_asymmetry_stress(tuple(rows)).to_payload()

        self.assertEqual(payload["observed_path_count"], 0)
        self.assertGreaterEqual(payload["source_gap_score"], 0.75)
        self.assertIn("missing_open_high_low_path_inputs", payload["warnings"])
        self.assertIn(
            "missing_intraday_price_path_asymmetry_inputs", payload["warnings"]
        )
        self.assertFalse(payload["promotion_proof"])
        self.assertFalse(payload["promotion_allowed"])
        self.assertFalse(payload["final_authority_ok"])

    def test_contract_embeds_sources_and_rejects_asymmetry_as_proof(self) -> None:
        contract = intraday_price_path_asymmetry_stress_contract()
        payload = extract_intraday_price_path_asymmetry_stress(
            (
                self._row(
                    offset=1,
                    price="100.00",
                    open_price="100.00",
                    high="105.00",
                    low="99.00",
                    close="104.00",
                ),
                self._row(offset=2, price="104.00"),
            )
        ).to_payload()

        source_ids = {source["source_id"] for source in contract["source_papers"]}
        self.assertIn("ssrn-6074846", source_ids)
        self.assertIn("ssrn-5039009", source_ids)
        proof_neutrality = contract["proof_neutrality"]
        self.assertTrue(proof_neutrality["requires_exact_replay"])
        self.assertTrue(proof_neutrality["requires_tick_level_replay"])
        self.assertTrue(proof_neutrality["requires_next_session_replay"])
        self.assertTrue(proof_neutrality["requires_route_tca"])
        self.assertTrue(proof_neutrality["requires_runtime_ledger"])
        self.assertTrue(proof_neutrality["rejects_intraday_asymmetry_as_pnl_authority"])
        self.assertTrue(proof_neutrality["rejects_same_day_path_proxy_as_execution_authority"])
        self.assertTrue(proof_neutrality["rejects_missing_ohlc_as_neutral"])
        self.assertFalse(payload["promotion_proof"])
        self.assertFalse(payload["promotion_allowed"])
        self.assertEqual(
            payload["feature_schema_hash"],
            build_intraday_price_path_asymmetry_stress_schema_hash(),
        )
