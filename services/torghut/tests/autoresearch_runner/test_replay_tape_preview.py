from __future__ import annotations

from dataclasses import replace
import json
from argparse import Namespace
from datetime import date, datetime, timezone
from decimal import Decimal
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Sequence
from unittest.mock import patch


import scripts.run_whitepaper_autoresearch_profit_target as runner
from app.trading.discovery import fast_replay
from app.trading.discovery.replay_tape import (
    REPLAY_TAPE_MANIFEST_SCHEMA_VERSION,
    ReplayTapeManifest,
    materialize_signal_tape,
)
from app.trading.models import SignalEnvelope
from tests.autoresearch_runner.helpers import (
    AutoresearchRunnerTestCase,
)


class TestAutoresearchRunnerReplayTapePreview(AutoresearchRunnerTestCase):
    def test_replay_tape_preview_narrows_direct_specs_without_promotion_proof(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            output_dir = root / "epoch"
            specs_path = root / "candidate-specs.jsonl"
            tape_path = root / "preview-tape.jsonl"
            base_nvda = self._candidate_spec("spec-nvda-continuation")
            nvda_spec = replace(
                base_nvda,
                strategy_overrides={
                    **base_nvda.strategy_overrides,
                    "universe_symbols": ["NVDA"],
                },
            )
            base_aapl = self._candidate_spec("spec-aapl-continuation")
            aapl_spec = replace(
                base_aapl,
                strategy_overrides={
                    **base_aapl.strategy_overrides,
                    "universe_symbols": ["AAPL"],
                },
            )
            specs_path.write_text(
                "\n".join(
                    json.dumps(spec.to_payload(), sort_keys=True)
                    for spec in (nvda_spec, aapl_spec)
                )
                + "\n",
                encoding="utf-8",
            )
            args = self._args(output_dir)
            args.candidate_specs = [specs_path]
            args.seed_recent_whitepapers = False
            args.replay_mode = "real"
            args.selection_only = True
            args.replay_tape_path = tape_path
            args.replay_tape_preview_top_k = 1
            args.symbols = "NVDA"
            args.replay_tape_dataset_snapshot_ref = "preview-snapshot"
            requested_symbols = runner._candidate_universe_symbols_from_args(args)
            materialize_signal_tape(
                rows=[
                    SignalEnvelope(
                        event_ts=datetime(2026, 2, day, 15, 30, tzinfo=timezone.utc),
                        symbol=symbol,
                        timeframe="1Sec",
                        seq=seq,
                        source="ta",
                        payload={
                            "price": Decimal(price),
                            "spread_bps": Decimal("2"),
                            "ofi": Decimal("0.25"),
                            "microbar_volume": Decimal("100000"),
                            "event_type": "trade",
                        },
                    )
                    for seq, (day, symbol, price) in enumerate(
                        (
                            (23, "NVDA", "100"),
                            (24, "NVDA", "101"),
                            (25, "NVDA", "102"),
                            (26, "NVDA", "103"),
                            (27, "NVDA", "104"),
                        ),
                        start=1,
                    )
                ],
                tape_path=tape_path,
                dataset_snapshot_ref="preview-snapshot",
                symbols=requested_symbols,
                start_date=date(2026, 2, 23),
                end_date=date(2026, 2, 27),
                source_query_digest=runner._materialized_replay_tape_source_query_digest(
                    args=args,
                    symbols=requested_symbols,
                    start_date=date(2026, 2, 23),
                    end_date=date(2026, 2, 27),
                ),
                feature_schema_hash=runner._materialized_replay_tape_feature_schema_hash(
                    args
                ),
                cost_model_hash=runner._materialized_replay_tape_cost_model_hash(args),
                strategy_family=runner._materialized_replay_tape_strategy_family(args),
            )

            payload = runner.run_whitepaper_autoresearch_profit_target(args)

            selection = json.loads(
                (output_dir / "candidate-selection-manifest.json").read_text(
                    encoding="utf-8"
                )
            )
            selected_specs = [
                json.loads(line)
                for line in (output_dir / "selected-candidate-specs.jsonl")
                .read_text(encoding="utf-8")
                .splitlines()
                if line
            ]
            preview_scores_exists = (
                output_dir / "replay-tape-preview-scores.jsonl"
            ).exists()

        self.assertEqual(payload["status"], "selection_only")
        self.assertEqual(payload["replay_candidate_spec_count"], 1)
        self.assertEqual(
            selection["selected_candidate_spec_ids"], ["spec-nvda-continuation"]
        )
        self.assertEqual(
            [spec["candidate_spec_id"] for spec in selected_specs],
            ["spec-nvda-continuation"],
        )
        self.assertFalse(selected_specs[0]["promotion_allowed"])
        self.assertFalse(selected_specs[0]["final_promotion_allowed"])
        self.assertFalse(selected_specs[0]["final_authority_ok"])
        self.assertFalse(selection["replay_tape_preview"]["promotion_proof"])
        self.assertIn(
            "exact_replay_required", selection["replay_tape_preview"]["blockers"]
        )
        self.assertIn(
            "adaptive_signal_falsification_if_adaptive_factor_or_signal_source",
            selection["replay_tape_preview"]["proof_semantics"][
                "final_promotion_requires"
            ],
        )
        self.assertTrue(preview_scores_exists)
        nvda_row = next(
            row
            for row in selection["rows"]
            if row["candidate_spec_id"] == "spec-nvda-continuation"
        )
        self.assertIn("fast_replay_preview_ofi_pressure_score", nvda_row)
        self.assertIn("fast_replay_preview_microprice_bias_bps", nvda_row)
        self.assertIn("fast_replay_preview_impact_liquidity_penalty_bps", nvda_row)
        self.assertIn("fast_replay_preview_required_daily_notional", nvda_row)
        self.assertIn("fast_replay_target_implied_notional_context", nvda_row)
        self.assertIn("fast_replay_cost_impact_lineage", nvda_row)
        self.assertIn("fast_replay_adv_capacity_context", nvda_row)
        self.assertIn("fast_replay_lineage_blockers", nvda_row)
        self.assertIn("fast_replay_risk_flags", nvda_row)
        self.assertIn("fast_replay_adaptive_signal_falsification_stress", nvda_row)
        adaptive_falsification_stress = nvda_row[
            "fast_replay_adaptive_signal_falsification_stress"
        ]
        self.assertEqual(
            adaptive_falsification_stress["status"],
            "research_only_adaptive_signal_falsification_evidence_collection",
        )
        self.assertTrue(nvda_row["fast_replay_adaptive_signal_falsification_required"])
        self.assertFalse(nvda_row["fast_replay_adaptive_signal_falsification_passed"])
        self.assertIn(
            "spurious_predictability_arxiv_2604_15531_2026",
            nvda_row["fast_replay_adaptive_signal_falsification_source_markers"],
        )
        self.assertIn(
            "null_model_sample_count_below_min",
            nvda_row["fast_replay_adaptive_signal_falsification_warnings"],
        )
        self.assertIn(
            "leakage_probe_missing_or_failed",
            nvda_row["fast_replay_adaptive_signal_falsification_warnings"],
        )
        scorecard_patch = nvda_row[
            "fast_replay_adaptive_signal_falsification_objective_scorecard_patch"
        ]
        self.assertTrue(scorecard_patch["required_adaptive_signal_falsification"])
        self.assertFalse(scorecard_patch["adaptive_signal_falsification_passed"])
        self.assertEqual(
            scorecard_patch["adaptive_signal_falsification_artifact_ref"],
            nvda_row["fast_replay_adaptive_signal_falsification_artifact_ref"],
        )
        self.assertFalse(adaptive_falsification_stress["proof_authority"])
        self.assertFalse(adaptive_falsification_stress["promotion_authority"])
        self.assertFalse(adaptive_falsification_stress["promotion_allowed"])
        self.assertFalse(adaptive_falsification_stress["final_authority_ok"])
        self.assertTrue(nvda_row["fast_replay_prefilter_only"])
        self.assertFalse(nvda_row["fast_replay_proof_authority"])
        self.assertFalse(nvda_row["fast_replay_promotion_allowed"])
        self.assertFalse(nvda_row["fast_replay_final_promotion_allowed"])
        self.assertFalse(nvda_row["fast_replay_final_authority_ok"])
        aapl_row = next(
            row
            for row in selection["rows"]
            if row["candidate_spec_id"] == "spec-aapl-continuation"
        )
        self.assertTrue(aapl_row["pre_fast_replay_preview_selected_for_replay"])
        self.assertFalse(aapl_row["selected_for_replay"])
        self.assertEqual(aapl_row["selection_reason"], "fast_replay_preview_filtered")

    def test_fast_replay_preview_builds_bounded_sim_target_queue_and_caps_exact_replay(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "epoch"
            output_dir.mkdir()
            tape_path = Path(tmpdir) / "tape.jsonl"
            rows = [
                SignalEnvelope(
                    event_ts=datetime(2026, 2, 23, 14, 30 + index, tzinfo=timezone.utc),
                    symbol=symbol,
                    timeframe="1Min",
                    seq=index,
                    source="ta",
                    payload={
                        "price": Decimal(str(100 + index)),
                        "spread_bps": Decimal("2"),
                        "ofi": Decimal("0.35"),
                        "microbar_volume": Decimal("100000"),
                        "event_type": "trade",
                    },
                )
                for index, symbol in enumerate(["NVDA", "AAPL", "INTC"] * 3)
            ]
            args = self._args(output_dir)
            args.replay_mode = "real"
            args.full_window_start_date = "2026-02-23"
            args.full_window_end_date = "2026-02-23"
            args.symbols = "NVDA,AAPL,INTC"
            args.replay_tape_path = tape_path
            args.replay_tape_preview_top_k = 8
            args.replay_tape_exact_candidate_cap = 99
            args.replay_tape_dataset_snapshot_ref = "frontier-preview"
            args.allow_unsafe_replay_tape_exact_cap_override = True
            requested_symbols = runner._candidate_universe_symbols_from_args(args)
            source_query_digest = runner._materialized_replay_tape_source_query_digest(
                args=args,
                symbols=requested_symbols,
                start_date=date(2026, 2, 23),
                end_date=date(2026, 2, 23),
            )
            feature_schema_hash = runner._materialized_replay_tape_feature_schema_hash(
                args
            )
            cost_model_hash = runner._materialized_replay_tape_cost_model_hash(args)
            strategy_family = runner._materialized_replay_tape_strategy_family(args)
            materialize_signal_tape(
                rows=rows,
                tape_path=tape_path,
                dataset_snapshot_ref="frontier-preview",
                symbols=("NVDA", "AAPL", "INTC"),
                start_date=date(2026, 2, 23),
                end_date=date(2026, 2, 23),
                source_query_digest=source_query_digest,
                feature_schema_hash=feature_schema_hash,
                cost_model_hash=cost_model_hash,
                strategy_family=strategy_family,
                source_table_versions={"signals": "v1"},
            )
            specs = [
                self._candidate_spec(
                    f"spec-frontier-{index}",
                    entry_minute_after_open=str(45 + index),
                )
                for index in range(8)
            ]
            candidate_selection = {
                "schema_version": "torghut.whitepaper-autoresearch-selection.v1",
                "budget": {"selected_count": len(specs)},
                "selected_candidate_spec_ids": [
                    spec.candidate_spec_id for spec in specs
                ],
                "rows": [
                    {
                        "candidate_spec_id": spec.candidate_spec_id,
                        "selected_for_replay": True,
                        "selection_reason": "test",
                    }
                    for spec in specs
                ],
            }

            narrowed_specs, updated_selection = (
                runner._apply_fast_replay_preview_narrowing(
                    args=args,
                    output_dir=output_dir,
                    specs=specs,
                    candidate_selection=candidate_selection,
                )
            )

        self.assertEqual(len(narrowed_specs), 6)
        self.assertEqual(
            updated_selection["budget"]["fast_replay_exact_replay_candidate_cap"], 6
        )
        preview_validation = updated_selection["replay_tape_preview"]["validation"]
        self.assertEqual(preview_validation["source_query_digest"], source_query_digest)
        self.assertEqual(preview_validation["feature_schema_hash"], feature_schema_hash)
        self.assertEqual(preview_validation["cost_model_hash"], cost_model_hash)
        self.assertEqual(preview_validation["strategy_family"], strategy_family)
        self.assertEqual(preview_validation["cache_identity"]["status"], "complete")
        queue_payload = updated_selection["bounded_sim_target_queue"]
        self.assertEqual(queue_payload["exact_replay_candidate_count"], 6)
        self.assertFalse(queue_payload["promotion_proof"])
        self.assertEqual(
            queue_payload["proof_semantics"]["label"],
            fast_replay.FAST_REPLAY_PROOF_SEMANTICS_LABEL,
        )
        self.assertEqual(
            queue_payload["discovery_stage_semantics"]["preview_only_status"],
            "preview_only_ranked",
        )
        self.assertEqual(
            queue_payload["discovery_stage_semantics"]["exact_replay_qualified_status"],
            "exact_replay_qualified_frontier",
        )
        self.assertFalse(
            queue_payload["discovery_stage_semantics"][
                "preview_output_can_authorize_promotion"
            ]
        )
        self.assertTrue(queue_payload["prefilter_only"])
        self.assertFalse(queue_payload["proof_authority"])
        self.assertFalse(queue_payload["promotion_allowed"])
        self.assertFalse(queue_payload["final_promotion_allowed"])
        self.assertFalse(queue_payload["final_authority_ok"])
        self.assertFalse(queue_payload["proof_semantics"]["promotion_allowed"])
        self.assertFalse(queue_payload["proof_semantics"]["final_promotion_allowed"])
        self.assertFalse(queue_payload["proof_semantics"]["final_authority_ok"])
        self.assertEqual(
            queue_payload["runner_policy"]["default_shard_timeout_seconds"], 900
        )
        self.assertEqual(queue_payload["runner_policy"]["default_worker_cap"], 2)
        self.assertFalse(queue_payload["runner_policy"]["kubernetes_fanout_enabled"])
        self.assertEqual(
            queue_payload["runner_policy"]["default_parallel_frontier_candidate_cap"],
            6,
        )
        ranking_boundary = queue_payload["ranking_authority_boundary"]
        self.assertTrue(ranking_boundary["exact_replay_required"])
        self.assertTrue(ranking_boundary["runtime_ledger_required"])
        self.assertFalse(ranking_boundary["ranking_output_can_authorize_promotion"])
        first_entry = queue_payload["entries"][0]
        self.assertIn("preview_rank_score", first_entry)
        self.assertIn("ranking_only_reasons", first_entry)
        self.assertIn("risk_veto_reasons", first_entry)
        self.assertTrue(first_entry["exact_replay_required"])
        self.assertTrue(first_entry["runtime_ledger_required"])
        command_policy = queue_payload["exact_replay_command_policy"]
        self.assertEqual(command_policy["generation_scope"], "bounded_frontier_only")
        self.assertEqual(command_policy["max_exact_replay_candidates"], 6)
        self.assertEqual(command_policy["effective_exact_replay_candidate_cap"], 6)
        self.assertEqual(command_policy["max_local_workers"], 2)
        self.assertEqual(command_policy["shard_timeout_seconds"], 900)
        self.assertFalse(command_policy["proof_packet_upload_allowed"])
        self.assertFalse(command_policy["db_writes_allowed"])
        self.assertFalse(command_policy["kubernetes_fanout_allowed"])
        self.assertFalse(command_policy["promotion_writes_allowed"])
        self.assertFalse(command_policy["final_authority_ok"])
        self.assertEqual(
            queue_payload["target_queue"]["status"],
            "sim_target_queue_ready_live_paper_blocked",
        )
        self.assertEqual(
            queue_payload["target_queue"]["candidate_stage"],
            "bounded_sim_evidence_collection_candidate",
        )
        self.assertEqual(
            queue_payload["replay_tape"]["feature_schema_hash"],
            feature_schema_hash,
        )
        self.assertEqual(
            queue_payload["replay_tape"]["cost_model_hash"], cost_model_hash
        )
        self.assertEqual(
            queue_payload["replay_tape"]["strategy_family"], strategy_family
        )
        self.assertEqual(
            queue_payload["replay_tape"]["source_query_digest"], source_query_digest
        )
        self.assertEqual(
            queue_payload["replay_tape"]["source_table_versions"], {"signals": "v1"}
        )
        self.assertEqual(
            queue_payload["replay_tape"]["cache_identity"]["status"], "complete"
        )
        self.assertFalse(
            queue_payload["replay_tape"]["cache_identity"]["missing_components"]
        )
        self.assertEqual(
            [entry["frontier_bucket"] for entry in queue_payload["entries"]],
            [
                "exploitation",
                "exploitation",
                "exploitation",
                "exploitation",
                "exploration",
                "exploration",
            ],
        )
        first_entry = queue_payload["entries"][0]
        self.assertEqual(
            first_entry["discovery_stage_metadata"]["preview_status"],
            "preview_only_ranked",
        )
        self.assertTrue(
            first_entry["discovery_stage_metadata"]["exact_replay_qualified"]
        )
        self.assertEqual(
            first_entry["discovery_stage_metadata"]["evidence_collection_status"],
            "bounded_sim_evidence_collection_candidate",
        )
        self.assertFalse(first_entry["discovery_stage_metadata"]["promotion_allowed"])
        self.assertIn("observed_post_cost_expectancy_bps", first_entry)
        self.assertIn("required_daily_notional", first_entry)
        self.assertFalse(first_entry["proof_authority"])
        self.assertIn("risk_flags", first_entry)
        self.assertEqual(
            first_entry["reproducibility_metadata"]["dataset_snapshot_ref"],
            "frontier-preview",
        )
        self.assertEqual(
            first_entry["reproducibility_metadata"]["feature_schema_hash"],
            feature_schema_hash,
        )
        self.assertEqual(
            first_entry["reproducibility_metadata"]["source_query_digest"],
            source_query_digest,
        )
        self.assertEqual(
            first_entry["reproducibility_metadata"]["source_table_versions"],
            {"signals": "v1"},
        )
        self.assertEqual(
            first_entry["reproducibility_metadata"]["cache_identity"]["status"],
            "complete",
        )
        self.assertEqual(
            first_entry["reproducibility_metadata"]["preview_score"],
            first_entry["preview_score"],
        )
        self.assertIn("target_implied_notional_context", first_entry)
        self.assertIn("cost_impact_lineage", first_entry)
        self.assertIn("impact_capacity_lineage", first_entry)
        self.assertIn("hpairs_macro_window_stress", first_entry)
        self.assertIn("hpairs_impact_capacity_lineage", first_entry)
        self.assertIn("exact_replay_handoff_lineage", first_entry)
        self.assertIn(
            first_entry["handoff_lineage_hash"],
            queue_payload["handoff_lineage_hashes"],
        )
        self.assertEqual(
            first_entry["exact_replay_handoff_lineage"]["lineage_hash"],
            first_entry["handoff_lineage_hash"],
        )
        self.assertEqual(
            first_entry["exact_replay_handoff_lineage"]["discovery_stage_metadata"][
                "evidence_collection_status"
            ],
            "bounded_sim_evidence_collection_candidate",
        )
        self.assertFalse(
            first_entry["exact_replay_handoff_lineage"]["discovery_stage_metadata"][
                "final_promotion_allowed"
            ]
        )
        self.assertEqual(
            first_entry["exact_replay_handoff_lineage"]["replay_tape"][
                "source_query_digest"
            ],
            source_query_digest,
        )
        self.assertEqual(
            first_entry["exact_replay_handoff_lineage"]["replay_tape"][
                "cost_model_hash"
            ],
            cost_model_hash,
        )
        self.assertFalse(
            first_entry["exact_replay_handoff_lineage"]["promotion_allowed"]
        )
        self.assertFalse(
            first_entry["exact_replay_handoff_lineage"]["final_promotion_allowed"]
        )
        self.assertFalse(
            first_entry["exact_replay_handoff_lineage"]["final_authority_ok"]
        )
        self.assertEqual(
            first_entry["adv_capacity_context"]["status"], "missing_source_backed_adv"
        )
        self.assertIn("source_backed_adv_missing", first_entry["lineage_blockers"])
        self.assertFalse(first_entry["promotion_allowed"])
        self.assertFalse(first_entry["final_promotion_allowed"])
        self.assertFalse(first_entry["final_authority_ok"])
        self.assertIn("hpairs_microstructure_prefilter", first_entry)
        self.assertEqual(
            first_entry["hpairs_microstructure_prefilter"]["proof_source"],
            "prefilter_only",
        )
        self.assertFalse(
            first_entry["hpairs_microstructure_prefilter"]["final_promotion_allowed"]
        )
        self.assertIn(
            "horizon_ofi_features",
            first_entry["hpairs_microstructure_prefilter"],
        )
        self.assertIn(
            "macro_window_stress",
            first_entry["hpairs_microstructure_prefilter"],
        )
        self.assertIn(
            "impact_capacity_lineage",
            first_entry["hpairs_microstructure_prefilter"],
        )

    def test_fast_replay_preview_rejects_replay_tape_cache_identity_mismatch(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "epoch"
            output_dir.mkdir()
            tape_path = Path(tmpdir) / "tape.jsonl"
            args = self._args(output_dir)
            args.replay_mode = "real"
            args.full_window_start_date = "2026-02-23"
            args.full_window_end_date = "2026-02-23"
            args.symbols = "NVDA,AAPL"
            args.replay_tape_path = tape_path
            args.replay_tape_preview_top_k = 2
            args.replay_tape_dataset_snapshot_ref = "frontier-preview"
            requested_symbols = runner._candidate_universe_symbols_from_args(args)
            materialize_signal_tape(
                rows=[
                    SignalEnvelope(
                        event_ts=datetime(2026, 2, 23, 14, 30, tzinfo=timezone.utc),
                        symbol="NVDA",
                        timeframe="1Min",
                        seq=1,
                        source="ta",
                        payload={
                            "price": Decimal("100"),
                            "spread_bps": Decimal("2"),
                            "ofi": Decimal("0.20"),
                            "microbar_volume": Decimal("100000"),
                        },
                    ),
                    SignalEnvelope(
                        event_ts=datetime(2026, 2, 23, 14, 31, tzinfo=timezone.utc),
                        symbol="AAPL",
                        timeframe="1Min",
                        seq=2,
                        source="ta",
                        payload={
                            "price": Decimal("101"),
                            "spread_bps": Decimal("2"),
                            "ofi": Decimal("0.20"),
                            "microbar_volume": Decimal("100000"),
                        },
                    ),
                ],
                tape_path=tape_path,
                dataset_snapshot_ref="frontier-preview",
                symbols=requested_symbols,
                start_date=date(2026, 2, 23),
                end_date=date(2026, 2, 23),
                source_query_digest=runner._materialized_replay_tape_source_query_digest(
                    args=args,
                    symbols=requested_symbols,
                    start_date=date(2026, 2, 23),
                    end_date=date(2026, 2, 23),
                ),
                feature_schema_hash="stale-feature-schema",
                cost_model_hash=runner._materialized_replay_tape_cost_model_hash(args),
                strategy_family=runner._materialized_replay_tape_strategy_family(args),
            )
            spec = self._candidate_spec("spec-frontier-0")
            candidate_selection = {
                "schema_version": "torghut.whitepaper-autoresearch-selection.v1",
                "budget": {"selected_count": 1},
                "selected_candidate_spec_ids": [spec.candidate_spec_id],
                "rows": [
                    {
                        "candidate_spec_id": spec.candidate_spec_id,
                        "selected_for_replay": True,
                        "selection_reason": "test",
                    }
                ],
            }

            with self.assertRaisesRegex(
                ValueError,
                "replay_tape_cache_identity_mismatch:.*feature_schema_hash",
            ):
                runner._apply_fast_replay_preview_narrowing(
                    args=args,
                    output_dir=output_dir,
                    specs=[spec],
                    candidate_selection=candidate_selection,
                )

    def test_fast_replay_preview_does_not_backfill_lineage_blocked_candidates(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "epoch"
            output_dir.mkdir()
            tape_path = Path(tmpdir) / "blocked-tape.jsonl"
            rows = [
                SignalEnvelope(
                    event_ts=datetime(2026, 2, 23, 14, 30 + index, tzinfo=timezone.utc),
                    symbol="NVDA",
                    timeframe="1Min",
                    seq=index,
                    source="ta",
                    payload={"price": Decimal(str(100 + index))},
                )
                for index in range(3)
            ]
            args = self._args(output_dir)
            args.replay_mode = "real"
            args.full_window_start_date = "2026-02-23"
            args.full_window_end_date = "2026-02-23"
            args.symbols = "NVDA"
            args.replay_tape_path = tape_path
            args.replay_tape_preview_top_k = 1
            args.replay_tape_dataset_snapshot_ref = "blocked-preview"
            requested_symbols = runner._candidate_universe_symbols_from_args(args)
            materialize_signal_tape(
                rows=rows,
                tape_path=tape_path,
                dataset_snapshot_ref="blocked-preview",
                symbols=requested_symbols,
                start_date=date(2026, 2, 23),
                end_date=date(2026, 2, 23),
                source_query_digest=runner._materialized_replay_tape_source_query_digest(
                    args=args,
                    symbols=requested_symbols,
                    start_date=date(2026, 2, 23),
                    end_date=date(2026, 2, 23),
                ),
                feature_schema_hash=runner._materialized_replay_tape_feature_schema_hash(
                    args
                ),
                cost_model_hash=runner._materialized_replay_tape_cost_model_hash(args),
                strategy_family=runner._materialized_replay_tape_strategy_family(args),
            )
            base_spec = self._candidate_spec("spec-lineage-blocked")
            spec = replace(
                base_spec,
                strategy_overrides={
                    **base_spec.strategy_overrides,
                    "max_notional_per_trade": "0",
                    "universe_symbols": ["NVDA"],
                },
            )
            candidate_selection = {
                "schema_version": "torghut.whitepaper-autoresearch-selection.v1",
                "budget": {"selected_count": 1},
                "selected_candidate_spec_ids": [spec.candidate_spec_id],
                "rows": [
                    {
                        "candidate_spec_id": spec.candidate_spec_id,
                        "selected_for_replay": True,
                        "selection_reason": "test",
                    }
                ],
            }

            narrowed_specs, updated_selection = (
                runner._apply_fast_replay_preview_narrowing(
                    args=args,
                    output_dir=output_dir,
                    specs=[spec],
                    candidate_selection=candidate_selection,
                )
            )

        self.assertEqual(narrowed_specs, [])
        self.assertEqual(updated_selection["selected_candidate_spec_ids"], [])
        self.assertEqual(
            updated_selection["budget"]["fast_replay_preview_selected_count"], 0
        )
        self.assertEqual(
            updated_selection["bounded_sim_target_queue"][
                "exact_replay_candidate_count"
            ],
            0,
        )
        updated_row = updated_selection["rows"][0]
        self.assertFalse(updated_row["selected_for_replay"])
        self.assertTrue(updated_row["fast_replay_exact_replay_selection_blocked"])
        self.assertEqual(
            updated_row["fast_replay_discovery_stage_metadata"]["exact_replay_status"],
            "not_exact_replay_qualified",
        )
        self.assertFalse(
            updated_row["fast_replay_discovery_stage_metadata"][
                "evidence_collection_candidate"
            ]
        )
        self.assertFalse(
            updated_row["fast_replay_discovery_stage_metadata"]["promotion_allowed"]
        )
        self.assertIn(
            "cost_lineage_spread_missing",
            updated_row["fast_replay_exact_replay_selection_blockers"],
        )
        self.assertEqual(
            updated_row["selection_reason"], "fast_replay_preview_filtered"
        )

    def test_bounded_sim_target_queue_dedupes_duplicate_frontier_keys(self) -> None:
        manifest = ReplayTapeManifest(
            schema_version=REPLAY_TAPE_MANIFEST_SCHEMA_VERSION,
            dataset_snapshot_ref="queue-dedupe-snapshot",
            symbols=("NVDA",),
            row_symbols=("NVDA",),
            start_date=date(2026, 2, 23),
            end_date=date(2026, 2, 23),
            start_ts=datetime(2026, 2, 23, 14, 30, tzinfo=timezone.utc),
            end_ts=datetime(2026, 2, 23, 21, 0, tzinfo=timezone.utc),
            min_event_ts=None,
            max_event_ts=None,
            trading_day_count=1,
            row_count=0,
            source_query_digest="queue-dedupe-query",
            content_sha256="queue-dedupe-sha",
            artifact_refs={},
            source_table_versions={"signals": "v1"},
            created_at=datetime(2026, 2, 24, tzinfo=timezone.utc),
            feature_schema_hash="queue-feature",
            cost_model_hash="queue-cost",
            strategy_family="queue-family",
            replay_cache_key="queue-cache-key",
        )
        duplicate_rows = [
            {
                "candidate_spec_id": "spec-a",
                "selected": True,
                "rank": 1,
                "frontier_bucket": "exploitation",
                "preview_score": "10",
                "proof_semantics_label": fast_replay.FAST_REPLAY_PROOF_SEMANTICS_LABEL,
                "candidate_frontier_hash": "candidate-frontier-a",
                "exact_replay_frontier_key": "exact-frontier-a",
                "frontier_dedupe_status": "representative",
                "frontier_dedupe_metadata": {
                    "proof_authority": False,
                    "promotion_allowed": False,
                },
            },
            {
                "candidate_spec_id": "spec-b",
                "selected": True,
                "rank": 2,
                "frontier_bucket": "exploitation",
                "preview_score": "9",
                "proof_semantics_label": fast_replay.FAST_REPLAY_PROOF_SEMANTICS_LABEL,
                "candidate_frontier_hash": "candidate-frontier-a",
                "exact_replay_frontier_key": "exact-frontier-a",
                "frontier_dedupe_status": "duplicate_filtered",
                "frontier_dedupe_metadata": {
                    "proof_authority": False,
                    "promotion_allowed": False,
                },
            },
            {
                "candidate_spec_id": "spec-c",
                "selected": True,
                "rank": 3,
                "frontier_bucket": "exploration",
                "preview_score": "8",
                "proof_semantics_label": fast_replay.FAST_REPLAY_PROOF_SEMANTICS_LABEL,
                "candidate_frontier_hash": "candidate-frontier-c",
                "exact_replay_frontier_key": "exact-frontier-c",
                "frontier_dedupe_status": "unique",
                "frontier_dedupe_metadata": {
                    "proof_authority": False,
                    "promotion_allowed": False,
                },
            },
        ]

        queue_payload = runner._bounded_sim_target_queue_metadata(
            preview_rows=duplicate_rows,
            replay_tape_manifest=manifest,
            exact_replay_candidate_cap=6,
            exploitation_slots=4,
            exploration_slots=2,
        )

        self.assertEqual(queue_payload["pre_dedupe_selected_candidate_count"], 3)
        self.assertEqual(queue_payload["exact_replay_candidate_count"], 2)
        self.assertEqual(
            queue_payload["duplicate_filtered_candidate_spec_ids"], ["spec-b"]
        )
        self.assertEqual(queue_payload["candidate_spec_ids"], ["spec-a", "spec-c"])
        self.assertEqual(
            queue_payload["exact_replay_frontier_keys"],
            ["exact-frontier-a", "exact-frontier-c"],
        )
        self.assertEqual(queue_payload["dedupe_policy"]["status"], "enabled")
        self.assertEqual(
            queue_payload["entries"][0]["discovery_stage_metadata"][
                "exact_replay_status"
            ],
            "exact_replay_qualified_frontier",
        )
        self.assertEqual(
            queue_payload["entries"][0]["exact_replay_handoff_lineage"][
                "discovery_stage_metadata"
            ]["evidence_collection_status"],
            "bounded_sim_evidence_collection_candidate",
        )
        self.assertFalse(queue_payload["dedupe_policy"]["proof_authority"])
        self.assertFalse(queue_payload["dedupe_policy"]["promotion_allowed"])
        self.assertFalse(queue_payload["dedupe_policy"]["final_authority_ok"])
        self.assertFalse(queue_payload["promotion_allowed"])
        self.assertFalse(queue_payload["final_authority_ok"])
        self.assertEqual(
            queue_payload["entries"][0]["exact_replay_handoff_lineage"][
                "exact_replay_frontier_key"
            ],
            "exact-frontier-a",
        )

    def test_staged_replay_frontier_default_resolvers_fail_closed(self) -> None:
        with TemporaryDirectory() as tmpdir:
            args = self._args(Path(tmpdir))
            args.staged_replay_frontier_default = False
            args.disable_staged_replay_frontier = False
            args.replay_mode = "real"
            args.replay_tape_path = Path(tmpdir) / "tape.jsonl"
            args.selection_only = False
            args.full_window_start_date = "2026-02-23"
            args.full_window_end_date = "2026-02-27"

            self.assertEqual(runner._resolved_fast_replay_preview_top_k(args), 0)
            self.assertFalse(runner._auto_materialize_staged_replay_tape(args))

            args.staged_replay_frontier_default = True
            args.disable_staged_replay_frontier = True
            self.assertEqual(runner._resolved_fast_replay_preview_top_k(args), 0)
            self.assertFalse(runner._auto_materialize_staged_replay_tape(args))

            args.disable_staged_replay_frontier = False
            args.replay_mode = "synthetic"
            self.assertEqual(runner._resolved_fast_replay_preview_top_k(args), 0)
            self.assertFalse(runner._auto_materialize_staged_replay_tape(args))

            args.replay_mode = "real"
            args.replay_tape_path = None
            self.assertEqual(runner._resolved_fast_replay_preview_top_k(args), 0)

            args.selection_only = True
            self.assertFalse(runner._auto_materialize_staged_replay_tape(args))

            args.selection_only = False
            args.replay_tape_path = Path(tmpdir) / "provided-tape.jsonl"
            self.assertFalse(runner._auto_materialize_staged_replay_tape(args))

            args.replay_tape_path = None
            args.full_window_start_date = ""
            self.assertFalse(runner._auto_materialize_staged_replay_tape(args))

            args.full_window_start_date = "2026-02-23"
            args.full_window_end_date = ""
            self.assertFalse(runner._auto_materialize_staged_replay_tape(args))

    def test_staged_replay_frontier_default_resolvers_enable_bounded_real_path(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            args = self._args(Path(tmpdir))
            args.staged_replay_frontier_default = True
            args.disable_staged_replay_frontier = False
            args.replay_mode = "real"
            args.replay_tape_path = Path(tmpdir) / "tape.jsonl"
            args.replay_tape_preview_top_k = 0
            args.max_candidates = 77
            args.selection_only = False
            args.full_window_start_date = "2026-02-23"
            args.full_window_end_date = "2026-02-27"

            self.assertEqual(runner._resolved_fast_replay_preview_top_k(args), 77)

            args.replay_tape_path = None
            self.assertTrue(runner._auto_materialize_staged_replay_tape(args))

    def test_fast_replay_preview_scores_microstructure_diagnostics_preview_only(
        self,
    ) -> None:
        base_spec = self._candidate_spec(
            "spec-nvda-microstructure-preview",
            selection_mode="continuation",
        )
        spec = replace(
            base_spec,
            strategy_overrides={
                **base_spec.strategy_overrides,
                "universe_symbols": ["NVDA"],
            },
        )
        rows = [
            SignalEnvelope(
                event_ts=datetime(2026, 2, 23, 15, 30, tzinfo=timezone.utc),
                symbol="NVDA",
                timeframe="1Sec",
                seq=1,
                source="ta",
                payload={
                    "bid": Decimal("100.00"),
                    "ask": Decimal("100.02"),
                    "bid_size": Decimal("220"),
                    "ask_size": Decimal("80"),
                    "microbar_volume": Decimal("15000"),
                },
            ),
            SignalEnvelope(
                event_ts=datetime(2026, 2, 23, 15, 31, tzinfo=timezone.utc),
                symbol="NVDA",
                timeframe="1Sec",
                seq=2,
                source="ta",
                payload={
                    "bid": Decimal("100.08"),
                    "ask": Decimal("100.12"),
                    "bid_size": Decimal("260"),
                    "ask_size": Decimal("90"),
                    "microbar_volume": Decimal("17000"),
                },
            ),
            SignalEnvelope(
                event_ts=datetime(2026, 2, 24, 15, 30, tzinfo=timezone.utc),
                symbol="NVDA",
                timeframe="1Sec",
                seq=3,
                source="ta",
                payload={
                    "bid": Decimal("100.19"),
                    "ask": Decimal("100.25"),
                    "order_flow_imbalance": Decimal("0.45"),
                    "microbar_volume": Decimal("11000"),
                },
            ),
        ]
        manifest = ReplayTapeManifest(
            schema_version=REPLAY_TAPE_MANIFEST_SCHEMA_VERSION,
            dataset_snapshot_ref="microstructure-preview",
            symbols=("NVDA",),
            row_symbols=("NVDA",),
            start_date=date(2026, 2, 23),
            end_date=date(2026, 2, 24),
            start_ts=datetime(2026, 2, 23, 14, 30, tzinfo=timezone.utc),
            end_ts=datetime(2026, 2, 24, 21, 0, tzinfo=timezone.utc),
            min_event_ts=rows[0].event_ts,
            max_event_ts=rows[-1].event_ts,
            trading_day_count=2,
            row_count=len(rows),
            source_query_digest="microstructure-preview-query",
            content_sha256="microstructure-preview-sha",
            artifact_refs={},
            source_table_versions={},
            created_at=datetime(2026, 2, 25, tzinfo=timezone.utc),
        )

        preview = fast_replay.build_fast_replay_preview(
            specs=(spec,),
            rows=rows,
            replay_tape_manifest=manifest,
            top_k=1,
            min_rows_per_candidate=2,
        )
        row_payload = preview.rows[0].to_payload()
        manifest_payload = preview.to_manifest_payload()

        self.assertEqual(
            row_payload["schema_version"],
            fast_replay.FAST_REPLAY_PREVIEW_ROW_SCHEMA_VERSION,
        )
        self.assertEqual(manifest_payload["status"], "preview_only")
        self.assertFalse(manifest_payload["promotion_proof"])
        self.assertFalse(manifest_payload["final_authority_ok"])
        self.assertEqual(
            row_payload["proof_semantics_label"],
            fast_replay.FAST_REPLAY_PROOF_SEMANTICS_LABEL,
        )
        self.assertFalse(row_payload["promotion_proof"])
        self.assertIn("exact_replay_required", manifest_payload["blockers"])
        self.assertGreater(Decimal(row_payload["ofi_pressure_score"]), Decimal("0"))
        self.assertGreater(Decimal(row_payload["microprice_bias_bps"]), Decimal("0"))
        self.assertGreater(Decimal(row_payload["spread_tail_bps"]), Decimal("0"))
        self.assertGreater(
            Decimal(row_payload["impact_liquidity_penalty_bps"]), Decimal("0")
        )
        self.assertIn("conformal_tail_risk", manifest_payload["implemented_mechanisms"])
        self.assertEqual(row_payload["proof_source"], "prefilter_only")
        self.assertFalse(row_payload["final_promotion_allowed"])
        self.assertFalse(row_payload["final_authority_ok"])
        self.assertIn("hpairs_microstructure_prefilter", row_payload)
        self.assertEqual(
            row_payload["hpairs_microstructure_prefilter"]["proof_source"],
            "prefilter_only",
        )
        self.assertIn("hpairs_microstructure_prefilter", manifest_payload)

    def test_materialize_replay_tape_writes_run_artifacts_and_updates_args(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            output_dir = root / "epoch"
            output_dir.mkdir()
            strategy_configmap = root / "strategy-configmap.yaml"
            strategy_configmap.write_text("{}", encoding="utf-8")
            args = self._args(output_dir)
            args.strategy_configmap = strategy_configmap
            args.replay_mode = "real"
            args.materialize_replay_tape = True
            args.symbols = "NVDA"
            rows = [
                SignalEnvelope(
                    event_ts=datetime(2026, 2, day, 15, 30, tzinfo=timezone.utc),
                    symbol="NVDA",
                    timeframe="1Sec",
                    seq=seq,
                    source="ta",
                    payload={"price": Decimal("100"), "spread": Decimal("0.01")},
                )
                for seq, day in enumerate(range(23, 28), start=1)
            ]

            with patch.object(
                runner.replay_mod, "_iter_signal_rows", return_value=rows
            ):
                updated_args, receipt = runner._maybe_materialize_epoch_replay_tape(
                    args=args,
                    output_dir=output_dir,
                    epoch_id="epoch-materialized",
                )
            tape = runner.load_replay_tape(updated_args.replay_tape_path)
            self.assertIsNotNone(receipt)
            assert receipt is not None
            self.assertEqual(
                updated_args.replay_tape_path, output_dir / "replay-tape.jsonl"
            )
            self.assertEqual(
                updated_args.replay_tape_manifest,
                output_dir / "replay-tape.jsonl.manifest.json",
            )
            self.assertEqual(receipt["status"], "materialized")
            self.assertEqual(receipt["row_count"], 5)
            self.assertEqual(receipt["row_symbols"], ["NVDA"])
            self.assertTrue((output_dir / "replay-tape-receipt.json").exists())
            self.assertEqual(tape.manifest.dataset_snapshot_ref, "epoch-materialized")
            self.assertEqual(tape.manifest.row_count, 5)
            self.assertEqual(tape.manifest.missing_trading_days, ())

    def test_materialize_replay_tape_fails_closed_on_missing_days(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            output_dir = root / "epoch"
            output_dir.mkdir()
            strategy_configmap = root / "strategy-configmap.yaml"
            strategy_configmap.write_text("{}", encoding="utf-8")
            args = self._args(output_dir)
            args.strategy_configmap = strategy_configmap
            args.replay_mode = "real"
            args.materialize_replay_tape = True
            args.symbols = "NVDA"
            rows = [
                SignalEnvelope(
                    event_ts=datetime(2026, 2, 23, 15, 30, tzinfo=timezone.utc),
                    symbol="NVDA",
                    timeframe="1Sec",
                    seq=1,
                    source="ta",
                    payload={"price": Decimal("100"), "spread": Decimal("0.01")},
                )
            ]

            with patch.object(
                runner.replay_mod, "_iter_signal_rows", return_value=rows
            ):
                with self.assertRaisesRegex(
                    ValueError,
                    "replay_tape_incomplete_coverage:missing_days=2026-02-24,2026-02-25,2026-02-26,2026-02-27",
                ):
                    runner._maybe_materialize_epoch_replay_tape(
                        args=args,
                        output_dir=output_dir,
                        epoch_id="epoch-materialized",
                    )

            self.assertFalse((output_dir / "replay-tape.jsonl").exists())
            self.assertFalse((output_dir / "replay-tape.jsonl.manifest.json").exists())

    def test_materialize_replay_tape_skips_provided_tape_and_fails_closed(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            output_dir = root / "epoch"
            output_dir.mkdir()
            args = self._args(output_dir)
            args.materialize_replay_tape = True
            args.replay_tape_path = root / "provided-tape.jsonl"

            updated_args, receipt = runner._maybe_materialize_epoch_replay_tape(
                args=args,
                output_dir=output_dir,
                epoch_id="epoch-skip",
            )

            self.assertIs(updated_args, args)
            self.assertIsNone(receipt)

            args.replay_tape_path = None
            args.replay_mode = "synthetic"
            with self.assertRaisesRegex(
                ValueError, "replay_tape_materialization_requires_real_replay"
            ):
                runner._maybe_materialize_epoch_replay_tape(
                    args=args,
                    output_dir=output_dir,
                    epoch_id="epoch-synthetic",
                )

            args.replay_mode = "real"
            args.selection_only = True
            with self.assertRaisesRegex(
                ValueError, "replay_tape_materialization_requires_replay_execution"
            ):
                runner._maybe_materialize_epoch_replay_tape(
                    args=args,
                    output_dir=output_dir,
                    epoch_id="epoch-selection-only",
                )

            args.selection_only = False
            args.full_window_start_date = ""
            with self.assertRaisesRegex(
                ValueError,
                "replay_tape_materialization_requires_full_window_start_date",
            ):
                runner._maybe_materialize_epoch_replay_tape(
                    args=args,
                    output_dir=output_dir,
                    epoch_id="epoch-missing-window",
                )

    def test_materialized_replay_tape_window_preflight_updates_args(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            output_dir = root / "epoch"
            output_dir.mkdir()
            args = self._args(output_dir)
            args.replay_mode = "real"
            args.materialize_replay_tape = True
            args.symbols = "NVDA,AAPL"
            args.full_window_start_date = "2026-02-23"
            args.full_window_end_date = "2026-02-27"
            args.latest_complete_window_min_days = 3
            coverage = {
                "schema_version": "torghut.replay-coverage-diagnostic.v1",
                "requested_trading_days": [
                    "2026-02-23",
                    "2026-02-24",
                    "2026-02-25",
                    "2026-02-26",
                    "2026-02-27",
                ],
                "rows_by_trading_day": {
                    "2026-02-23": self._coverage_row(
                        raw=10,
                        executable=0,
                        microbar=10,
                    ),
                    "2026-02-24": self._coverage_row(
                        raw=10,
                        executable=3,
                        microbar=10,
                    ),
                    "2026-02-25": self._coverage_row(
                        raw=10,
                        executable=3,
                        microbar=10,
                    ),
                    "2026-02-26": self._coverage_row(
                        raw=10,
                        executable=3,
                        microbar=10,
                    ),
                    "2026-02-27": self._coverage_row(
                        raw=10,
                        executable=3,
                        microbar=10,
                    ),
                },
                "missing_executable_signal_days": ["2026-02-23"],
            }

            with patch.object(
                runner.replay_materializer,
                "_fetch_coverage_diagnostics",
                return_value=coverage,
            ) as fetch:
                updated_args, receipt = (
                    runner._maybe_preflight_materialized_replay_tape_window(
                        args=args,
                        output_dir=output_dir,
                    )
                )

            self.assertEqual(fetch.call_count, 1)
            self.assertIsNotNone(receipt)
            assert receipt is not None
            self.assertEqual(updated_args.full_window_start_date, "2026-02-24")
            self.assertEqual(updated_args.full_window_end_date, "2026-02-27")
            self.assertEqual(updated_args.expected_last_trading_day, "2026-02-27")
            self.assertEqual(
                receipt["selected_trading_days"],
                ["2026-02-24", "2026-02-25", "2026-02-26", "2026-02-27"],
            )
            self.assertTrue(
                (output_dir / "replay-source-latest-complete-window.json").exists()
            )

    def test_replay_tape_preview_error_paths_and_fallback_selection(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            output_dir = root / "epoch"
            tape_path = root / "preview-tape.jsonl"
            args = self._args(output_dir)
            args.replay_tape_preview_top_k = 1
            args.full_window_start_date = "2026-02-23"
            args.full_window_end_date = "2026-02-27"
            args.symbols = "NVDA"
            args.replay_tape_dataset_snapshot_ref = "preview-snapshot"
            requested_symbols = runner._candidate_universe_symbols_from_args(args)
            materialize_signal_tape(
                rows=[
                    SignalEnvelope(
                        event_ts=datetime(2026, 2, day, 15, 30, tzinfo=timezone.utc),
                        symbol="NVDA",
                        timeframe="1Sec",
                        seq=seq,
                        source="ta",
                        payload={"price": Decimal("100")},
                    )
                    for seq, day in enumerate(range(23, 28), start=1)
                ],
                tape_path=tape_path,
                dataset_snapshot_ref="preview-snapshot",
                symbols=requested_symbols,
                start_date=date(2026, 2, 23),
                end_date=date(2026, 2, 27),
                source_query_digest=runner._materialized_replay_tape_source_query_digest(
                    args=args,
                    symbols=requested_symbols,
                    start_date=date(2026, 2, 23),
                    end_date=date(2026, 2, 27),
                ),
                feature_schema_hash=runner._materialized_replay_tape_feature_schema_hash(
                    args
                ),
                cost_model_hash=runner._materialized_replay_tape_cost_model_hash(args),
                strategy_family=runner._materialized_replay_tape_strategy_family(args),
            )
            spec = self._candidate_spec("spec-preview-fallback")
            selection = {
                "selected_candidate_spec_ids": [spec.candidate_spec_id],
                "rows": [
                    {
                        "candidate_spec_id": spec.candidate_spec_id,
                        "selected_for_replay": True,
                    }
                ],
                "budget": {"selected_count": 1},
            }
            with self.assertRaisesRegex(
                ValueError, "fast_replay_preview_requires_real_replay"
            ):
                runner._apply_fast_replay_preview_narrowing(
                    args=args,
                    output_dir=output_dir,
                    specs=[spec],
                    candidate_selection=selection,
                )
            args.replay_mode = "real"
            args.replay_tape_path = None
            with self.assertRaisesRegex(
                ValueError, "fast_replay_preview_requires_replay_tape_path"
            ):
                runner._apply_fast_replay_preview_narrowing(
                    args=args,
                    output_dir=output_dir,
                    specs=[spec],
                    candidate_selection=selection,
                )
            args.replay_tape_path = tape_path
            args.full_window_start_date = ""
            with self.assertRaisesRegex(
                ValueError, "fast_replay_preview_requires_full_window_start_date"
            ):
                runner._apply_fast_replay_preview_narrowing(
                    args=args,
                    output_dir=output_dir,
                    specs=[spec],
                    candidate_selection=selection,
                )

            class UnknownPreview:
                selected_candidate_spec_ids = ("missing-spec",)
                rows = ()

                def to_manifest_payload(self) -> dict[str, object]:
                    return {
                        "schema_version": "torghut.fast-replay-preview.v1",
                        "promotion_proof": False,
                    }

            args.full_window_start_date = "2026-02-23"
            args.symbols = "NVDA"
            with patch.object(
                runner,
                "build_fast_replay_preview",
                return_value=UnknownPreview(),
            ):
                narrowed, updated = runner._apply_fast_replay_preview_narrowing(
                    args=args,
                    output_dir=output_dir,
                    specs=[spec],
                    candidate_selection=selection,
                )

        self.assertEqual(
            [item.candidate_spec_id for item in narrowed], [spec.candidate_spec_id]
        )
        self.assertEqual(
            updated["selected_candidate_spec_ids"], [spec.candidate_spec_id]
        )

    def test_fast_replay_preview_covers_signal_field_fallbacks(self) -> None:
        no_universe_spec = replace(
            self._candidate_spec("spec-no-universe"),
            runtime_strategy_name="NVDA",
            strategy_overrides={
                "params": {
                    "selection_mode": "continuation",
                    "signal_motif": "opening_continuation",
                }
            },
        )
        self.assertEqual(fast_replay._candidate_symbols(no_universe_spec), ("NVDA",))
        self.assertEqual(fast_replay._candidate_direction(no_universe_spec), 1.0)
        self.assertEqual(
            fast_replay._extract_price(
                SignalEnvelope(
                    event_ts=datetime(2026, 2, 23, 15, 30, tzinfo=timezone.utc),
                    symbol="NVDA",
                    payload={"bid": Decimal("100"), "ask": Decimal("102")},
                )
            ),
            101.0,
        )
        self.assertIsNone(
            fast_replay._extract_price(
                SignalEnvelope(
                    event_ts=datetime(2026, 2, 23, 15, 30, tzinfo=timezone.utc),
                    symbol="NVDA",
                    payload={},
                )
            )
        )
        bid_ask_spread = fast_replay._extract_spread_bps(
            SignalEnvelope(
                event_ts=datetime(2026, 2, 23, 15, 30, tzinfo=timezone.utc),
                symbol="NVDA",
                payload={"bid": Decimal("100"), "ask": Decimal("101")},
            )
        )
        self.assertAlmostEqual(bid_ask_spread or 0.0, 99.50248756218905)
        self.assertEqual(
            fast_replay._extract_spread_bps(
                SignalEnvelope(
                    event_ts=datetime(2026, 2, 23, 15, 30, tzinfo=timezone.utc),
                    symbol="NVDA",
                    payload={"price": Decimal("100"), "spread": Decimal("0.05")},
                )
            ),
            5.0,
        )
        self.assertAlmostEqual(
            fast_replay._extract_quote_depth_imbalance(
                SignalEnvelope(
                    event_ts=datetime(2026, 2, 23, 15, 30, tzinfo=timezone.utc),
                    symbol="NVDA",
                    payload={
                        "bid_size": Decimal("200"),
                        "ask_size": Decimal("100"),
                    },
                )
            )
            or 0.0,
            1.0 / 3.0,
        )
        self.assertAlmostEqual(
            fast_replay._extract_ofi_pressure(
                SignalEnvelope(
                    event_ts=datetime(2026, 2, 23, 15, 30, tzinfo=timezone.utc),
                    symbol="NVDA",
                    payload={"order_flow_imbalance": Decimal("50")},
                )
            )
            or 0.0,
            0.46211715726000974,
        )
        self.assertGreater(
            fast_replay._extract_microprice_bias_bps(
                SignalEnvelope(
                    event_ts=datetime(2026, 2, 23, 15, 30, tzinfo=timezone.utc),
                    symbol="NVDA",
                    payload={
                        "bid": Decimal("100"),
                        "ask": Decimal("101"),
                        "bid_size": Decimal("200"),
                        "ask_size": Decimal("100"),
                    },
                )
            )
            or 0.0,
            0.0,
        )
        self.assertEqual(
            fast_replay._extract_volume(
                SignalEnvelope(
                    event_ts=datetime(2026, 2, 23, 15, 30, tzinfo=timezone.utc),
                    symbol="NVDA",
                    payload={"microbar_volume": Decimal("12345")},
                )
            ),
            12345.0,
        )
        self.assertIsNone(
            fast_replay._extract_spread_bps(
                SignalEnvelope(
                    event_ts=datetime(2026, 2, 23, 15, 30, tzinfo=timezone.utc),
                    symbol="NVDA",
                    payload={},
                )
            )
        )
        self.assertIsNone(fast_replay._float_or_none("not-a-number"))
        self.assertIsNone(fast_replay._float_or_none(float("nan")))
        self.assertEqual(fast_replay._mapping("not-a-mapping"), {})

    def test_candidate_specs_replay_skips_compiler_and_replays_selected_specs(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "epoch"
            selected_specs_path = Path(tmpdir) / "selected-candidate-specs.jsonl"
            direct_a_base = self._candidate_spec("spec-direct-a")
            direct_a_spec = replace(
                direct_a_base,
                feature_contract={
                    **direct_a_base.feature_contract,
                    "source_claims": [
                        {
                            "claim_id": "direct-route-tca-required",
                            "claim_type": "execution_assumption",
                            "data_requirements": ["route_tca"],
                        }
                    ],
                },
                parameter_space={
                    "mechanism_overlay_ids": ["queue_position_survival_fill_curve"]
                },
                promotion_contract={
                    "requires_route_tca": True,
                    "requires_runtime_ledger": True,
                },
            )
            specs = (
                direct_a_spec,
                self._candidate_spec(
                    "spec-direct-b",
                    family_template_id="momentum_pullback_v1",
                    selection_mode="pullback",
                ),
            )
            selected_specs_path.write_text(
                "\n".join(
                    json.dumps(spec.to_payload(), sort_keys=True) for spec in specs
                )
                + "\n",
                encoding="utf-8",
            )
            captured_spec_ids: list[str] = []

            def fake_replay(
                *,
                args: Namespace,
                output_dir: Path,
                specs: Sequence[runner.CandidateSpec],
            ) -> runner.EpochReplayResult:
                del args
                captured_spec_ids.extend(spec.candidate_spec_id for spec in specs)
                bundle = runner.evidence_bundle_from_frontier_candidate(
                    candidate_spec_id=specs[0].candidate_spec_id,
                    candidate={
                        "candidate_id": "cand-direct-a",
                        "objective_scorecard": {
                            "net_pnl_per_day": "25",
                            "active_day_ratio": "1",
                            "positive_day_ratio": "1",
                            "exact_replay_ledger_artifact_ref": "direct-exact-ledger.json",
                            "exact_replay_ledger_artifact_row_count": 12,
                            "exact_replay_ledger_artifact_fill_count": 4,
                            "runtime_window_start": "2026-05-18T13:30:00+00:00",
                            "runtime_window_end": "2026-05-18T20:00:00+00:00",
                        },
                    },
                    dataset_snapshot_id="snap-direct",
                    result_path=str(output_dir / "direct-a.json"),
                )
                return runner.EpochReplayResult(
                    evidence_bundles=(bundle,),
                    replay_results=({"status": "ok"},),
                )

            args = self._args(output_dir)
            args.seed_recent_whitepapers = False
            args.candidate_specs = [selected_specs_path]
            args.replay_mode = "real"
            args.portfolio_size_min = 1

            with (
                patch.object(
                    runner,
                    "compile_sources_to_hypothesis_cards",
                    side_effect=AssertionError("source compiler must not run"),
                ) as source_compiler_mock,
                patch.object(
                    runner,
                    "compile_whitepaper_candidate_specs",
                    side_effect=AssertionError("candidate compiler must not run"),
                ) as candidate_compiler_mock,
                patch.object(
                    runner,
                    "_select_candidate_specs_for_replay",
                    side_effect=AssertionError("selection must not run"),
                ) as selection_mock,
                patch.object(
                    runner,
                    "_run_replay_with_optional_timeout",
                    side_effect=fake_replay,
                ) as replay_mock,
            ):
                payload = runner.run_whitepaper_autoresearch_profit_target(args)

            selection = json.loads(
                (output_dir / "candidate-selection-manifest.json").read_text(
                    encoding="utf-8"
                )
            )
            selected_candidate_specs = [
                json.loads(line)
                for line in (output_dir / "selected-candidate-specs.jsonl")
                .read_text(encoding="utf-8")
                .splitlines()
                if line
            ]
            compiler_report = json.loads(
                (output_dir / "candidate-compiler-report.json").read_text(
                    encoding="utf-8"
                )
            )
            profitability_goal = json.loads(
                (output_dir / "profitability-search-goal.json").read_text(
                    encoding="utf-8"
                )
            )

        self.assertEqual(captured_spec_ids, ["spec-direct-a", "spec-direct-b"])
        self.assertEqual(payload["candidate_spec_count"], 2)
        self.assertEqual(payload["replay_candidate_spec_count"], 2)
        self.assertEqual(
            payload["selected_candidate_spec_ids"], ["spec-direct-a", "spec-direct-b"]
        )
        self.assertEqual(selection["selection_mode"], "direct_candidate_specs_handoff")
        self.assertEqual(
            selection["selected_candidate_spec_ids"],
            ["spec-direct-a", "spec-direct-b"],
        )
        direct_selection_row = next(
            row
            for row in selection["rows"]
            if row["candidate_spec_id"] == "spec-direct-a"
        )
        self.assertGreater(
            Decimal(str(direct_selection_row["paper_contract_prior_score"])),
            Decimal("0"),
        )
        self.assertEqual(
            direct_selection_row["paper_mechanism_overlay_ids"],
            ["queue_position_survival_fill_curve"],
        )
        self.assertIn(
            "runtime_ledger", direct_selection_row["paper_required_evidence_tokens"]
        )
        self.assertEqual(
            [spec["candidate_spec_id"] for spec in selected_candidate_specs],
            ["spec-direct-a", "spec-direct-b"],
        )
        self.assertEqual(
            compiler_report["status"], "loaded_candidate_specs_for_direct_replay"
        )
        self.assertEqual(
            profitability_goal["recommended_next_epoch"][
                "direct_candidate_specs_artifacts"
            ],
            [str(selected_specs_path)],
        )
        self.assertIn(
            "--candidate-specs",
            profitability_goal["recommended_next_epoch"]["argv"],
        )
        self.assertIn(
            str(selected_specs_path),
            profitability_goal["recommended_next_epoch"]["argv"],
        )
        direct_sleeve_row = next(
            row
            for row in profitability_goal["sleeve_plan"]["rows"]
            if row["candidate_spec_id"] == "spec-direct-a"
        )
        self.assertEqual(
            direct_sleeve_row["replay_selection_reason"],
            "direct_candidate_specs_handoff",
        )
        self.assertTrue(direct_sleeve_row["paper_contract_candidate"])
        self.assertTrue(direct_sleeve_row["paper_contract_selected_for_replay"])
        self.assertEqual(
            direct_sleeve_row["paper_mechanism_overlay_ids"],
            ["queue_position_survival_fill_curve"],
        )
        self.assertIn(
            "runtime_ledger", direct_sleeve_row["paper_required_evidence_tokens"]
        )
        self.assertEqual(
            direct_sleeve_row["exact_replay_ledger_artifact_refs"],
            ["direct-exact-ledger.json"],
        )
        self.assertNotIn("runtime_ledger_artifact_refs", direct_sleeve_row)
        self.assertNotIn("runtime_ledger_artifact_ref", direct_sleeve_row)
        self.assertEqual(
            direct_sleeve_row["exact_replay_ledger_artifact_row_count"], 12
        )
        self.assertEqual(
            direct_sleeve_row["exact_replay_ledger_artifact_fill_count"], 4
        )
        source_compiler_mock.assert_not_called()
        candidate_compiler_mock.assert_not_called()
        selection_mock.assert_not_called()
        replay_mock.assert_called_once()

    def test_candidate_specs_replay_rejects_duplicate_spec_ids(self) -> None:
        with TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "epoch"
            selected_specs_path = Path(tmpdir) / "selected-candidate-specs.jsonl"
            spec = self._candidate_spec("spec-direct-duplicate")
            selected_specs_path.write_text(
                "\n".join(
                    json.dumps(spec.to_payload(), sort_keys=True) for _ in range(2)
                )
                + "\n",
                encoding="utf-8",
            )
            args = self._args(output_dir)
            args.seed_recent_whitepapers = False
            args.candidate_specs = [selected_specs_path]
            args.replay_mode = "real"

            with patch.object(
                runner,
                "_run_replay_with_optional_timeout",
                side_effect=AssertionError("invalid input must not run replay"),
            ) as replay_mock:
                payload = runner.run_whitepaper_autoresearch_profit_target(args)

        self.assertEqual(payload["status"], "invalid_candidate_specs")
        self.assertIn(
            "candidate_specs_jsonl_duplicate_candidate_spec_id",
            payload["failure_reason"],
        )
        replay_mock.assert_not_called()
