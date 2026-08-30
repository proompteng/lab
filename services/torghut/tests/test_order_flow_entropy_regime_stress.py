from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal
from unittest import TestCase

from app.trading.discovery.order_flow_entropy_regime_stress import (
    extract_order_flow_entropy_regime_stress,
    order_flow_entropy_regime_stress_contract,
)
from app.trading.models import SignalEnvelope


class TestOrderFlowEntropyRegimeStress(TestCase):
    def _row(
        self,
        *,
        offset: int,
        price: str,
        ofi: str | None = None,
        volume: str = "1000",
        event_type: str = "trade",
        side: str = "buy",
        volatility_bps: str = "0",
    ) -> SignalEnvelope:
        payload: dict[str, object] = {
            "price": Decimal(price),
            "microbar_volume": Decimal(volume),
            "event_type": event_type,
            "trade_side": side,
            "volatility_bps": Decimal(volatility_bps),
        }
        if ofi is not None:
            payload["ofi"] = Decimal(ofi)
        return SignalEnvelope(
            event_ts=datetime(2026, 4, 3, 14, 30, tzinfo=timezone.utc)
            + timedelta(seconds=offset),
            symbol="SPY",
            timeframe="1s",
            seq=offset,
            source="test",
            payload=payload,
            ingest_ts=datetime(2026, 4, 3, 14, 30, tzinfo=timezone.utc)
            + timedelta(seconds=offset, milliseconds=50),
        )

    def test_low_entropy_high_move_order_flow_downranks_more_than_diverse_flow(
        self,
    ) -> None:
        hidden_order_rows = [
            self._row(
                offset=0, price="100.00", ofi="0.92", volume="7000", volatility_bps="12"
            ),
            self._row(
                offset=1, price="100.35", ofi="0.94", volume="7200", volatility_bps="11"
            ),
            self._row(
                offset=2, price="99.92", ofi="0.91", volume="6900", volatility_bps="13"
            ),
            self._row(
                offset=3, price="100.41", ofi="0.95", volume="7300", volatility_bps="12"
            ),
            self._row(
                offset=4, price="99.88", ofi="0.93", volume="7100", volatility_bps="14"
            ),
            self._row(
                offset=5, price="100.52", ofi="0.96", volume="7400", volatility_bps="13"
            ),
        ]
        diverse_rows = [
            self._row(
                offset=0, price="100.00", ofi="0.10", event_type="add", side="buy"
            ),
            self._row(
                offset=1, price="100.01", ofi="-0.08", event_type="cancel", side="sell"
            ),
            self._row(
                offset=2, price="100.00", ofi="0.03", event_type="trade", side="buy"
            ),
            self._row(
                offset=3, price="100.02", ofi="-0.04", event_type="add", side="sell"
            ),
            self._row(
                offset=4, price="100.01", ofi="0.06", event_type="trade", side="buy"
            ),
            self._row(
                offset=5, price="100.02", ofi="-0.05", event_type="cancel", side="sell"
            ),
        ]

        hidden = extract_order_flow_entropy_regime_stress(
            hidden_order_rows
        ).to_payload()
        diverse = extract_order_flow_entropy_regime_stress(diverse_rows).to_payload()

        self.assertGreater(
            hidden["ranking_features"]["low_entropy_hidden_order_score"],
            diverse["ranking_features"]["low_entropy_hidden_order_score"],
        )
        self.assertGreater(
            hidden["ranking_features"]["replay_rank_penalty_bps"],
            diverse["ranking_features"]["replay_rank_penalty_bps"],
        )
        self.assertIn(
            "low_entropy_hidden_order_volatility_state_not_direction",
            hidden["warnings"],
        )
        self.assertFalse(hidden["proof_authority"])
        self.assertFalse(hidden["promotion_authority"])

    def test_missing_order_flow_and_price_inputs_fail_closed_as_source_gap(
        self,
    ) -> None:
        rows = [
            SignalEnvelope(
                event_ts=datetime(2026, 4, 3, 14, 30, tzinfo=timezone.utc)
                + timedelta(seconds=idx),
                symbol="SPY",
                timeframe="1s",
                seq=idx,
                source="test",
                payload={"event_type": "unknown"},
            )
            for idx in range(4)
        ]

        payload = extract_order_flow_entropy_regime_stress(rows).to_payload()

        self.assertEqual(payload["observed_order_flow_count"], 0)
        self.assertEqual(payload["observed_price_count"], 0)
        self.assertGreaterEqual(payload["ranking_features"]["source_gap_score"], 1.0)
        self.assertIn("missing_order_flow_entropy_inputs", payload["warnings"])
        self.assertIn(
            "missing_price_path_for_entropy_directionality", payload["warnings"]
        )
        self.assertFalse(payload["final_authority_ok"])

    def test_contract_embeds_sources_and_rejects_entropy_as_directional_proof(
        self,
    ) -> None:
        contract = order_flow_entropy_regime_stress_contract()
        source_ids = {item["source_id"] for item in contract["source_papers"]}

        self.assertIn("ssrn-5315733", source_ids)
        self.assertIn("arxiv-2512.15720", source_ids)
        self.assertIn("arxiv-2603.20456", source_ids)
        self.assertFalse(contract["proof_neutrality"]["proof_authority"])
        self.assertTrue(
            contract["proof_neutrality"]["rejects_entropy_as_directional_alpha_proof"]
        )
        self.assertTrue(contract["proof_neutrality"]["requires_runtime_ledger"])
