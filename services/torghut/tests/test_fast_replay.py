from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase

from app.trading.discovery.candidate_specs import (
    CANDIDATE_SPEC_SCHEMA_VERSION,
    CandidateSpec,
)
from app.trading.discovery.fast_replay import (
    FAST_REPLAY_PROOF_SEMANTICS_LABEL,
    build_fast_replay_preview,
)
from app.trading.discovery.replay_tape import (
    build_source_query_digest,
    materialize_signal_tape,
)
from app.trading.models import SignalEnvelope


class TestFastReplayPreview(TestCase):
    def _spec(
        self,
        candidate_spec_id: str,
        *,
        symbols: list[str],
        selection_mode: str = "continuation",
        max_notional_per_trade: str = "2500",
    ) -> CandidateSpec:
        return CandidateSpec(
            schema_version=CANDIDATE_SPEC_SCHEMA_VERSION,
            candidate_spec_id=candidate_spec_id,
            hypothesis_id=f"hyp-{candidate_spec_id}",
            family_template_id="microbar_cross_sectional_pairs_v1",
            candidate_kind="sleeve",
            runtime_family="microbar_cross_sectional_pairs",
            runtime_strategy_name="microbar-cross-sectional-pairs-v1",
            feature_contract={"mechanism": "test hpairs", "required_features": ["ofi"]},
            parameter_space={},
            strategy_overrides={
                "max_notional_per_trade": max_notional_per_trade,
                "params": {
                    "selection_mode": selection_mode,
                    "signal_motif": "ofi_lob_response_continuation",
                    "rank_feature": "cross_section_session_open_rank",
                },
                "universe_symbols": symbols,
            },
            objective={"target_net_pnl_per_day": "500"},
            hard_vetoes={},
            expected_failure_modes=(),
            promotion_contract={"promotion_policy": "research_only"},
        )

    def _signal(
        self,
        *,
        symbol: str,
        offset: int,
        price: str,
        ofi: str,
        volume: str = "100000",
        stress: bool = False,
        event_type: str = "trade",
    ) -> SignalEnvelope:
        return SignalEnvelope(
            event_ts=datetime(2026, 2, 23, 14, 30, tzinfo=timezone.utc)
            + timedelta(minutes=offset),
            symbol=symbol,
            timeframe="1Min",
            seq=offset,
            source="test",
            payload={
                "price": Decimal(price),
                "spread_bps": Decimal("2"),
                "ofi": Decimal(ofi),
                "microbar_volume": Decimal(volume),
                "event_type": event_type,
                "bid_size": Decimal("700"),
                "ask_size": Decimal("300"),
                "macro_event_window": stress,
            },
            ingest_ts=datetime(2026, 2, 23, 14, 31, tzinfo=timezone.utc),
        )

    def test_whitepaper_features_rank_and_label_preview_only(self) -> None:
        with TemporaryDirectory() as tmpdir:
            rows = [
                self._signal(
                    symbol="AAA", offset=1, price="100", ofi="0.65", event_type="add"
                ),
                self._signal(
                    symbol="AAA", offset=2, price="101", ofi="0.80", event_type="trade"
                ),
                self._signal(
                    symbol="AAA", offset=3, price="102", ofi="0.85", event_type="cancel"
                ),
                self._signal(
                    symbol="BBB", offset=1, price="100", ofi="-0.10", stress=True
                ),
                self._signal(
                    symbol="BBB", offset=2, price="99", ofi="-0.20", stress=True
                ),
                self._signal(
                    symbol="BBB", offset=3, price="98", ofi="-0.20", stress=True
                ),
            ]
            manifest = materialize_signal_tape(
                rows=rows,
                tape_path=Path(tmpdir) / "tape.jsonl",
                dataset_snapshot_ref="snapshot-fast",
                symbols=("AAA", "BBB"),
                start_date=date(2026, 2, 23),
                end_date=date(2026, 2, 23),
                source_query_digest=build_source_query_digest({"window": "fast"}),
            )

        preview = build_fast_replay_preview(
            specs=(
                self._spec("spec-good", symbols=["AAA"]),
                self._spec("spec-stress", symbols=["BBB"]),
            ),
            rows=rows,
            replay_tape_manifest=manifest,
            top_k=2,
            min_rows_per_candidate=2,
            exploitation_count=1,
            exploration_count=1,
            exact_replay_candidate_cap=2,
        )

        self.assertEqual(
            preview.selected_candidate_spec_ids, ("spec-good", "spec-stress")
        )
        good, stress = preview.rows
        self.assertEqual(good.candidate_spec_id, "spec-good")
        self.assertGreater(good.cluster_lob_activity_score, Decimal("0"))
        self.assertGreater(good.ofi_decay_alignment_score, Decimal("0"))
        self.assertEqual(good.frontier_bucket, "exploitation")
        self.assertEqual(stress.frontier_bucket, "exploration")
        self.assertGreater(stress.macro_stress_veto_score, Decimal("0"))
        payload = preview.to_manifest_payload()
        row_payload = good.to_payload()
        self.assertFalse(payload["promotion_proof"])
        self.assertFalse(payload["promotion_allowed"])
        self.assertFalse(payload["final_promotion_allowed"])
        self.assertEqual(
            payload["proof_semantics_label"], FAST_REPLAY_PROOF_SEMANTICS_LABEL
        )
        self.assertIn(
            "source_backed_runtime_ledger_proof_required", payload["blockers"]
        )
        self.assertIn("conformal_tail_risk", payload["implemented_mechanisms"])
        self.assertEqual(
            row_payload["target_implied_notional_context"]["target_net_pnl_per_day"],
            "500",
        )
        self.assertIn("observed_post_cost_expectancy_bps", row_payload)
        self.assertIn("cost_impact_lineage", row_payload)
        self.assertEqual(
            row_payload["adv_capacity_context"]["status"], "missing_source_backed_adv"
        )
        self.assertIn("source_backed_adv_missing", row_payload["lineage_blockers"])
        self.assertFalse(row_payload["promotion_proof"])
        self.assertFalse(row_payload["proof_authority"])
        self.assertIn("risk_flags", row_payload)
        self.assertIn("source_backed_adv_missing", row_payload["risk_flags"])
        self.assertEqual(
            payload["replay_tape"]["dataset_snapshot_ref"], "snapshot-fast"
        )
        self.assertIn("feature_schema_hash", payload["replay_tape"])
        self.assertIn("cost_model_hash", payload["replay_tape"])
        self.assertIn("strategy_family", payload["replay_tape"])
        self.assertEqual(
            payload["replay_tape"]["cache_identity"]["status"], "incomplete"
        )
        self.assertIn(
            "replay_tape_cache_identity_missing_feature_schema_hash",
            payload["replay_tape"]["cache_identity"]["blockers"],
        )
        self.assertFalse(payload["proof_authority"])

    def test_target_implied_notional_blocks_non_positive_expectancy(self) -> None:
        with TemporaryDirectory() as tmpdir:
            rows = [
                self._signal(symbol="AAA", offset=1, price="100", ofi="0.50"),
                self._signal(symbol="AAA", offset=2, price="102", ofi="0.50"),
                self._signal(symbol="BBB", offset=1, price="102", ofi="0.50"),
                self._signal(symbol="BBB", offset=2, price="100", ofi="0.50"),
            ]
            manifest = materialize_signal_tape(
                rows=rows,
                tape_path=Path(tmpdir) / "tape.jsonl",
                dataset_snapshot_ref="snapshot-notional",
                symbols=("AAA", "BBB"),
                start_date=date(2026, 2, 23),
                end_date=date(2026, 2, 23),
                source_query_digest=build_source_query_digest({"window": "notional"}),
            )

        preview = build_fast_replay_preview(
            specs=(
                self._spec(
                    "spec-positive",
                    symbols=["AAA"],
                    max_notional_per_trade="0",
                ),
                self._spec(
                    "spec-negative",
                    symbols=["BBB"],
                    max_notional_per_trade="0",
                ),
            ),
            rows=rows,
            replay_tape_manifest=manifest,
            top_k=2,
            min_rows_per_candidate=2,
            exploitation_count=1,
            exploration_count=1,
            exact_replay_candidate_cap=2,
        )

        payloads = {row.candidate_spec_id: row.to_payload() for row in preview.rows}
        positive = payloads["spec-positive"]
        positive_expectancy = Decimal(positive["observed_post_cost_expectancy_bps"])
        self.assertGreater(positive_expectancy, Decimal("0"))
        self.assertEqual(
            Decimal(positive["required_daily_notional"]),
            Decimal("500") / (positive_expectancy / Decimal("10000")),
        )
        self.assertFalse(positive["target_implied_notional_context"]["blocked"])
        self.assertEqual(
            positive["target_implied_notional_context"]["formula"],
            "target_net_pnl_per_day/(observed_post_cost_expectancy_bps/10000)",
        )

        negative = payloads["spec-negative"]
        self.assertLessEqual(
            Decimal(negative["observed_post_cost_expectancy_bps"]), Decimal("0")
        )
        self.assertIsNone(negative["required_daily_notional"])
        self.assertTrue(negative["target_implied_notional_context"]["blocked"])
        self.assertEqual(
            negative["target_implied_notional_context"]["feasibility_status"],
            "blocked_non_positive_post_cost_expectancy",
        )
        self.assertIn(
            "target_implied_notional_blocked_non_positive_expectancy",
            negative["lineage_blockers"],
        )

    def test_frontier_selection_caps_exact_replay_with_exploration_slots(self) -> None:
        with TemporaryDirectory() as tmpdir:
            rows = [
                self._signal(
                    symbol="AAA", offset=index, price=str(100 + index), ofi="0.50"
                )
                for index in range(1, 8)
            ]
            manifest = materialize_signal_tape(
                rows=rows,
                tape_path=Path(tmpdir) / "tape.jsonl",
                dataset_snapshot_ref="snapshot-cap",
                symbols=("AAA",),
                start_date=date(2026, 2, 23),
                end_date=date(2026, 2, 23),
                source_query_digest=build_source_query_digest({"window": "cap"}),
            )
        specs = tuple(
            self._spec(f"spec-{index}", symbols=["AAA"]) for index in range(8)
        )

        preview = build_fast_replay_preview(
            specs=specs,
            rows=rows,
            replay_tape_manifest=manifest,
            top_k=8,
            min_rows_per_candidate=2,
            exploitation_count=4,
            exploration_count=2,
            exact_replay_candidate_cap=99,
        )

        self.assertEqual(len(preview.selected_candidate_spec_ids), 6)
        self.assertEqual(preview.exploitation_candidate_count, 4)
        self.assertEqual(preview.exploration_candidate_count, 2)
        self.assertEqual(preview.exact_replay_candidate_cap, 6)
        self.assertEqual(
            [row.frontier_bucket for row in preview.rows if row.selected],
            [
                "exploitation",
                "exploitation",
                "exploitation",
                "exploitation",
                "exploration",
                "exploration",
            ],
        )
