from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal
from unittest import TestCase

from app.trading.discovery.microstructure_regime_tokenization_stress import (
    build_microstructure_regime_tokenization_stress_schema_hash,
    extract_microstructure_regime_tokenization_stress,
    microstructure_regime_tokenization_stress_contract,
)
from app.trading.models import SignalEnvelope


class TestMicrostructureRegimeTokenizationStress(TestCase):
    def _row(
        self,
        *,
        offset: int,
        price: str,
        ofi: str,
        spread_bps: str,
        bid_size: str,
        ask_size: str,
        event_type: str,
        side: str,
        raw: bool = True,
        seq: int | None = None,
        structured_message: bool = True,
    ) -> SignalEnvelope:
        payload = {
            "price": Decimal(price),
            "ofi": Decimal(ofi),
            "spread_bps": Decimal(spread_bps),
            "bid_size": Decimal(bid_size),
            "ask_size": Decimal(ask_size),
            "trade_size": Decimal("100"),
            "event_type": event_type,
            "trade_direction": side,
        }
        if raw:
            payload["raw_event_bytes"] = f"{event_type}|{side}|{price}|{ofi}".encode()
        if structured_message:
            payload["order_id"] = f"MRT-{offset // 2}"
            payload["delta_time_ms"] = Decimal("0") if offset == 0 else Decimal("1000")
            payload["best_bid"] = Decimal(price) - Decimal("0.01")
            payload["best_ask"] = Decimal(price) + Decimal("0.01")
        return SignalEnvelope(
            event_ts=datetime(2026, 4, 22, 14, 30, tzinfo=timezone.utc)
            + timedelta(seconds=offset),
            symbol="MRT",
            timeframe="1s",
            seq=offset if seq is None else seq,
            source="microstructure-regime-tokenization-fixture",
            payload=payload,
            ingest_ts=datetime(2026, 4, 22, 14, 30, tzinfo=timezone.utc)
            + timedelta(seconds=offset + 1),
        )

    def test_complete_event_stream_with_latent_build_up_downranks_less(self) -> None:
        complete = extract_microstructure_regime_tokenization_stress(
            (
                self._row(
                    offset=0,
                    price="100.00",
                    ofi="0.10",
                    spread_bps="1.0",
                    bid_size="1200",
                    ask_size="1100",
                    event_type="add",
                    side="buy",
                ),
                self._row(
                    offset=1,
                    price="100.01",
                    ofi="0.25",
                    spread_bps="1.2",
                    bid_size="1100",
                    ask_size="1050",
                    event_type="modify",
                    side="buy",
                ),
                self._row(
                    offset=2,
                    price="100.02",
                    ofi="0.85",
                    spread_bps="3.5",
                    bid_size="700",
                    ask_size="650",
                    event_type="cancel",
                    side="sell",
                ),
                self._row(
                    offset=3,
                    price="100.03",
                    ofi="0.95",
                    spread_bps="4.2",
                    bid_size="420",
                    ask_size="380",
                    event_type="trade",
                    side="buy",
                ),
                self._row(
                    offset=4,
                    price="100.55",
                    ofi="0.80",
                    spread_bps="5.0",
                    bid_size="390",
                    ask_size="360",
                    event_type="trade",
                    side="buy",
                ),
                self._row(
                    offset=5,
                    price="100.48",
                    ofi="0.30",
                    spread_bps="2.0",
                    bid_size="1000",
                    ask_size="980",
                    event_type="add",
                    side="sell",
                ),
            )
        ).to_payload()
        lossy = extract_microstructure_regime_tokenization_stress(
            (
                self._row(
                    offset=0,
                    price="100.00",
                    ofi="0.00",
                    spread_bps="1.0",
                    bid_size="1000",
                    ask_size="1000",
                    event_type="trade",
                    side="buy",
                    raw=False,
                    seq=None,
                    structured_message=False,
                ),
                self._row(
                    offset=1,
                    price="101.00",
                    ofi="0.00",
                    spread_bps="1.0",
                    bid_size="1000",
                    ask_size="1000",
                    event_type="trade",
                    side="buy",
                    raw=False,
                    seq=None,
                    structured_message=False,
                ),
                self._row(
                    offset=2,
                    price="100.00",
                    ofi="0.00",
                    spread_bps="1.0",
                    bid_size="1000",
                    ask_size="1000",
                    event_type="trade",
                    side="buy",
                    raw=False,
                    seq=None,
                    structured_message=False,
                ),
                self._row(
                    offset=3,
                    price="101.00",
                    ofi="0.00",
                    spread_bps="1.0",
                    bid_size="1000",
                    ask_size="1000",
                    event_type="trade",
                    side="buy",
                    raw=False,
                    seq=None,
                    structured_message=False,
                ),
            )
        ).to_payload()

        self.assertEqual(
            complete["status"],
            "preview_only_microstructure_regime_tokenization_stress_ranking",
        )
        self.assertIn(
            "arxiv-2604.20949",
            {source["source_id"] for source in complete["source_papers"]},
        )
        self.assertIn(
            "arxiv-2602.23784",
            {source["source_id"] for source in complete["source_papers"]},
        )
        self.assertIn(
            "arxiv-2511.12563",
            {source["source_id"] for source in complete["source_papers"]},
        )
        self.assertGreater(
            complete["ranking_features"]["latent_regime_lead_coverage"],
            lossy["ranking_features"]["latent_regime_lead_coverage"],
        )
        self.assertGreater(
            lossy["ranking_features"]["universal_tokenization_gap_score"],
            complete["ranking_features"]["universal_tokenization_gap_score"],
        )
        self.assertGreater(
            lossy["ranking_features"]["byte_stream_precision_gap_score"],
            complete["ranking_features"]["byte_stream_precision_gap_score"],
        )
        self.assertGreater(
            lossy["ranking_features"]["lobert_message_semantics_gap_score"],
            complete["ranking_features"]["lobert_message_semantics_gap_score"],
        )
        self.assertGreater(
            lossy["ranking_features"]["replay_rank_penalty_bps"],
            complete["ranking_features"]["replay_rank_penalty_bps"],
        )
        self.assertFalse(complete["promotion_authority"])
        self.assertFalse(complete["final_promotion_allowed"])
        self.assertFalse(complete["synthetic_rollout_generation"])

    def test_missing_event_stream_inputs_fail_closed(self) -> None:
        payload = extract_microstructure_regime_tokenization_stress(
            (
                SignalEnvelope(
                    event_ts=datetime(2026, 4, 22, 14, 30, tzinfo=timezone.utc),
                    symbol="MRT",
                    timeframe="1Min",
                    seq=None,
                    source="missing-event-stream-fixture",
                    payload={"price": Decimal("100")},
                    ingest_ts=datetime(2026, 4, 22, 14, 31, tzinfo=timezone.utc),
                ),
            )
        ).to_payload()

        self.assertGreater(payload["ranking_features"]["replay_rank_penalty_bps"], 0)
        self.assertEqual(payload["observed_event_type_count"], 0)
        self.assertIn(
            "missing_event_type_for_universal_tokenization", payload["warnings"]
        )
        self.assertIn(
            "missing_raw_event_message_bytes_for_byte_stream_fidelity",
            payload["warnings"],
        )
        self.assertIn(
            "missing_order_ids_for_lobert_message_lifecycle", payload["warnings"]
        )
        self.assertIn(
            "missing_post_message_lob_snapshot_for_lobert_conditioning",
            payload["warnings"],
        )
        self.assertFalse(payload["proof_authority"])
        self.assertEqual(
            payload["feature_schema_hash"],
            build_microstructure_regime_tokenization_stress_schema_hash(),
        )

    def test_lobert_message_semantics_gap_penalizes_missing_order_lifecycle(
        self,
    ) -> None:
        structured = extract_microstructure_regime_tokenization_stress(
            (
                self._row(
                    offset=0,
                    price="100.00",
                    ofi="0.10",
                    spread_bps="1.0",
                    bid_size="1200",
                    ask_size="1100",
                    event_type="add",
                    side="buy",
                ),
                self._row(
                    offset=1,
                    price="100.01",
                    ofi="0.20",
                    spread_bps="1.2",
                    bid_size="1180",
                    ask_size="1090",
                    event_type="modify",
                    side="buy",
                ),
                self._row(
                    offset=2,
                    price="100.02",
                    ofi="0.35",
                    spread_bps="1.5",
                    bid_size="900",
                    ask_size="870",
                    event_type="cancel",
                    side="sell",
                ),
                self._row(
                    offset=3,
                    price="100.04",
                    ofi="0.55",
                    spread_bps="2.0",
                    bid_size="820",
                    ask_size="780",
                    event_type="trade",
                    side="buy",
                ),
            )
        ).to_payload()
        lossy = extract_microstructure_regime_tokenization_stress(
            (
                self._row(
                    offset=0,
                    price="100.00",
                    ofi="0.10",
                    spread_bps="1.0",
                    bid_size="1200",
                    ask_size="1100",
                    event_type="trade",
                    side="buy",
                    structured_message=False,
                ),
                self._row(
                    offset=1,
                    price="100.01",
                    ofi="0.20",
                    spread_bps="1.0",
                    bid_size="1200",
                    ask_size="1100",
                    event_type="trade",
                    side="buy",
                    structured_message=False,
                ),
                self._row(
                    offset=2,
                    price="100.02",
                    ofi="0.30",
                    spread_bps="1.0",
                    bid_size="1200",
                    ask_size="1100",
                    event_type="trade",
                    side="buy",
                    structured_message=False,
                ),
                self._row(
                    offset=3,
                    price="100.03",
                    ofi="0.40",
                    spread_bps="1.0",
                    bid_size="1200",
                    ask_size="1100",
                    event_type="trade",
                    side="buy",
                    structured_message=False,
                ),
            )
        ).to_payload()

        self.assertEqual(structured["observed_order_id_count"], 4)
        self.assertEqual(structured["observed_lifecycle_action_count"], 4)
        self.assertEqual(structured["observed_time_delta_count"], 4)
        self.assertEqual(structured["observed_post_message_snapshot_count"], 4)
        self.assertLess(
            structured["ranking_features"]["lobert_message_semantics_gap_score"],
            lossy["ranking_features"]["lobert_message_semantics_gap_score"],
        )
        self.assertIn(
            "missing_order_ids_for_lobert_message_lifecycle", lossy["warnings"]
        )
        self.assertFalse(structured["proof_authority"])
        self.assertFalse(structured["promotion_allowed"])
        self.assertFalse(structured["final_promotion_allowed"])

    def test_contract_rejects_synthetic_or_tokenized_pnl_authority(self) -> None:
        contract = microstructure_regime_tokenization_stress_contract()

        self.assertEqual(
            {source["source_id"] for source in contract["source_papers"]},
            {
                "arxiv-2604.20949",
                "arxiv-2602.23784",
                "arxiv-2508.02247",
                "arxiv-2511.12563",
            },
        )
        self.assertIn(
            "lobert_message_semantics_gap_score", contract["stress_components"]
        )
        neutrality = contract["proof_neutrality"]
        self.assertFalse(neutrality["promotion_proof"])
        self.assertTrue(neutrality["requires_exact_replay"])
        self.assertTrue(neutrality["requires_route_tca"])
        self.assertTrue(neutrality["requires_order_lifecycle_fill_evidence"])
        self.assertTrue(neutrality["requires_runtime_ledger"])
        self.assertTrue(neutrality["rejects_synthetic_rollouts_as_pnl_authority"])
        self.assertTrue(
            neutrality["rejects_tokenized_tradeflow_as_runtime_ledger_authority"]
        )
        self.assertTrue(
            neutrality["rejects_lobert_message_model_as_runtime_ledger_authority"]
        )
        self.assertTrue(neutrality["rejects_latent_regime_trigger_as_promotion_proof"])
