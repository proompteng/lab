from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from unittest import TestCase

from app.trading.discovery.candidate_specs import CandidateSpec
from app.trading.discovery.microstructure_prefilter import (
    HPAIRS_AUTHORITY_BLOCKERS,
    HPAIRS_PREFILTER_PROOF_SOURCE,
    build_hpairs_microstructure_prefilter,
)
from app.trading.models import SignalEnvelope


def _spec(
    candidate_spec_id: str,
    *,
    symbol: str,
    family_template_id: str = "microbar_cross_sectional_pairs_v1",
) -> CandidateSpec:
    return CandidateSpec(
        schema_version="torghut.candidate-spec.v1",
        candidate_spec_id=candidate_spec_id,
        hypothesis_id=f"hyp-{candidate_spec_id}",
        family_template_id=family_template_id,
        candidate_kind="sleeve",
        runtime_family="microbar_cross_sectional_pairs",
        runtime_strategy_name=(
            "microbar-cross-sectional-pairs-v1"
            if family_template_id == "microbar_cross_sectional_pairs_v1"
            else "breakout-continuation-long-v1"
        ),
        feature_contract={"mechanism": "test"},
        parameter_space={},
        strategy_overrides={
            "max_notional_per_trade": "5000",
            "universe_symbols": [symbol],
            "params": {
                "selection_mode": "continuation",
                "signal_motif": "vwap_close_continuation",
                "rank_feature": "cross_section_vwap_w5m_rank",
            },
        },
        objective={"target_net_pnl_per_day": "500"},
        hard_vetoes={},
        expected_failure_modes=(),
        promotion_contract={},
    )


def _row(
    minute: int,
    symbol: str,
    price: str,
    *,
    ofi: str | None = None,
    bid_size: str = "200",
    ask_size: str = "80",
    event_label: str | None = "buy_absorption",
    stress: str | None = "0",
) -> SignalEnvelope:
    bid = Decimal(price) - Decimal("0.01")
    ask = Decimal(price) + Decimal("0.01")
    payload: dict[str, object] = {
        "bid": bid,
        "ask": ask,
        "bid_size": Decimal(bid_size),
        "ask_size": Decimal(ask_size),
        "microbar_volume": Decimal("15000"),
    }
    if ofi is not None:
        payload["order_flow_imbalance"] = Decimal(ofi)
    if event_label is not None:
        payload["cluster_lob_label"] = event_label
    if stress is not None:
        payload["regime_stress_score"] = Decimal(stress)
    return SignalEnvelope(
        event_ts=datetime(2026, 2, 23, 15, minute, tzinfo=timezone.utc),
        symbol=symbol,
        timeframe="1Sec",
        source="test",
        payload=payload,
    )


class MicrostructurePrefilterTest(TestCase):
    def test_deterministic_hpairs_ranking_prefers_ofi_clustered_candidate(self) -> None:
        specs = (_spec("weak", symbol="AAPL"), _spec("strong", symbol="NVDA"))
        rows = (
            _row(30, "NVDA", "100.00", ofi="0.20"),
            _row(31, "NVDA", "100.12", ofi="0.35", event_label="buy_sweep"),
            _row(32, "NVDA", "100.28", ofi="0.55", event_label="buy_sweep"),
            _row(30, "AAPL", "200.00", ofi="-0.10", event_label="sell_sweep"),
            _row(31, "AAPL", "199.95", ofi="-0.08", event_label="sell_sweep"),
            _row(32, "AAPL", "199.90", ofi="-0.06", event_label="sell_sweep"),
        )

        first = build_hpairs_microstructure_prefilter(
            specs=specs,
            rows=rows,
            top_k=2,
            exploitation_count=1,
            exploration_count=1,
            exact_replay_candidate_cap=2,
        )
        second = build_hpairs_microstructure_prefilter(
            specs=specs,
            rows=rows,
            top_k=2,
            exploitation_count=1,
            exploration_count=1,
            exact_replay_candidate_cap=2,
        )

        self.assertEqual(
            [row.to_payload() for row in first.rows],
            [row.to_payload() for row in second.rows],
        )
        self.assertEqual(first.rows[0].candidate_spec_id, "strong")
        self.assertEqual(first.rows[0].frontier_bucket, "exploitation")
        self.assertEqual(first.rows[1].frontier_bucket, "exploration")
        self.assertEqual(len(first.selected_candidate_spec_ids), 2)

    def test_missing_source_fields_emit_blockers_without_fabricated_scores(
        self,
    ) -> None:
        result = build_hpairs_microstructure_prefilter(
            specs=(_spec("missing", symbol="NVDA"),),
            rows=(
                SignalEnvelope(
                    event_ts=datetime(2026, 2, 23, 15, 30, tzinfo=timezone.utc),
                    symbol="NVDA",
                    payload={"note": "no price or order flow"},
                ),
            ),
            top_k=1,
            min_rows_per_candidate=1,
        )

        payload = result.rows[0].to_payload()
        self.assertIn("missing_price_return_microbar_fields", payload["blockers"])
        self.assertIn("missing_ofi_or_depth_fields", payload["blockers"])
        self.assertIn(
            "missing_cluster_lob_event_fields_using_microbar_fallback",
            payload["warnings"],
        )
        self.assertEqual(payload["horizon_ofi_features"]["status"], "missing_inputs")
        self.assertIn(
            "missing_price_return_microbar_fields",
            payload["source_input_blockers"],
        )
        self.assertEqual(payload["macro_window_stress"]["status"], "missing_inputs")
        self.assertEqual(payload["impact_capacity_lineage"]["status"], "missing_inputs")
        self.assertIn(
            "median_price_missing",
            payload["impact_capacity_lineage"]["blockers"],
        )
        self.assertEqual(payload["proof_source"], HPAIRS_PREFILTER_PROOF_SOURCE)

    def test_prefilter_metadata_never_grants_promotion_authority(self) -> None:
        result = build_hpairs_microstructure_prefilter(
            specs=(_spec("authority", symbol="NVDA"),),
            rows=(
                _row(30, "NVDA", "100.00", ofi="0.20"),
                _row(31, "NVDA", "100.20", ofi="0.40"),
            ),
            top_k=1,
        )
        manifest = result.to_manifest_payload()
        row = result.rows[0].to_payload()

        self.assertFalse(manifest["promotion_allowed"])
        self.assertFalse(manifest["final_promotion_allowed"])
        self.assertFalse(row["promotion_allowed"])
        self.assertFalse(row["final_promotion_allowed"])
        self.assertFalse(row["proof_authority"])
        for blocker in HPAIRS_AUTHORITY_BLOCKERS:
            self.assertIn(blocker, row["authority_blockers"])

    def test_frontier_size_is_bounded_to_exploitation_plus_exploration_cap(
        self,
    ) -> None:
        specs = tuple(
            _spec(f"spec-{index}", symbol=symbol)
            for index, symbol in enumerate(("NVDA", "AAPL", "AMD", "INTC"))
        )
        rows = tuple(
            item
            for symbol, base in (
                ("NVDA", "100"),
                ("AAPL", "200"),
                ("AMD", "120"),
                ("INTC", "30"),
            )
            for item in (
                _row(30, symbol, base, ofi="0.20"),
                _row(31, symbol, str(Decimal(base) + Decimal("0.10")), ofi="0.30"),
            )
        )

        result = build_hpairs_microstructure_prefilter(
            specs=specs,
            rows=rows,
            top_k=4,
            exploitation_count=3,
            exploration_count=3,
            exact_replay_candidate_cap=2,
        )

        self.assertEqual(result.exact_replay_candidate_cap, 2)
        self.assertLessEqual(len(result.selected_candidate_spec_ids), 2)
        self.assertEqual(sum(1 for row in result.rows if row.selected), 2)

    def test_hpairs_metadata_surfaces_horizons_behavior_and_stress_veto(self) -> None:
        result = build_hpairs_microstructure_prefilter(
            specs=(_spec("metadata", symbol="NVDA"),),
            rows=(
                _row(30, "NVDA", "100.00", ofi="0.10", stress="0.20"),
                _row(
                    31,
                    "NVDA",
                    "100.03",
                    ofi="0.20",
                    event_label="buy_sweep",
                    stress="0.20",
                ),
                _row(
                    32,
                    "NVDA",
                    "100.08",
                    ofi="0.55",
                    event_label="buy_sweep",
                    stress="0.20",
                ),
            ),
            top_k=1,
        )

        payload = result.rows[0].to_payload()
        self.assertIn("3_microbars", payload["horizon_ofi_features"]["horizons"])
        self.assertIn("12_microbars", payload["horizon_ofi_features"]["horizons"])
        self.assertIn("36_microbars", payload["horizon_ofi_features"]["horizons"])
        self.assertEqual(payload["cluster_behavior"]["source"], "cluster_lob_fields")
        self.assertIn("behavior_bucket", payload["cluster_behavior"])
        self.assertEqual(payload["regime_stress_veto"]["status"], "available")
        self.assertEqual(payload["macro_window_stress"]["status"], "available")
        self.assertEqual(payload["macro_window_stress"]["sample_count"], 3)
        self.assertFalse(payload["macro_window_stress"]["proof_authority"])
        self.assertEqual(
            payload["impact_capacity_lineage"]["model"],
            "square_root_power_law_impact_proxy",
        )
        self.assertEqual(payload["impact_capacity_lineage"]["status"], "available")
        self.assertFalse(payload["impact_capacity_lineage"]["proof_authority"])
        self.assertEqual(payload["proof_source"], "prefilter_only")
