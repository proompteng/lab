from __future__ import annotations

import scripts.whitepaper_autoresearch_runner.artifact_io as artifact_io
import scripts.whitepaper_autoresearch_runner.preview_narrowing as preview_narrowing
import scripts.whitepaper_autoresearch_runner.queue_metadata as queue_metadata

from dataclasses import replace
import json
from datetime import date, datetime, timezone
from decimal import Decimal
from pathlib import Path
from tempfile import TemporaryDirectory


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
            requested_symbols = artifact_io._candidate_universe_symbols_from_args(args)
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
                source_query_digest=queue_metadata._materialized_replay_tape_source_query_digest(
                    args=args,
                    symbols=requested_symbols,
                    start_date=date(2026, 2, 23),
                    end_date=date(2026, 2, 27),
                ),
                feature_schema_hash=queue_metadata._materialized_replay_tape_feature_schema_hash(
                    args
                ),
                cost_model_hash=queue_metadata._materialized_replay_tape_cost_model_hash(
                    args
                ),
                strategy_family=queue_metadata._materialized_replay_tape_strategy_family(
                    args
                ),
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
            requested_symbols = artifact_io._candidate_universe_symbols_from_args(args)
            source_query_digest = (
                queue_metadata._materialized_replay_tape_source_query_digest(
                    args=args,
                    symbols=requested_symbols,
                    start_date=date(2026, 2, 23),
                    end_date=date(2026, 2, 23),
                )
            )
            feature_schema_hash = (
                queue_metadata._materialized_replay_tape_feature_schema_hash(args)
            )
            cost_model_hash = queue_metadata._materialized_replay_tape_cost_model_hash(
                args
            )
            strategy_family = queue_metadata._materialized_replay_tape_strategy_family(
                args
            )
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
            requested_symbols = artifact_io._candidate_universe_symbols_from_args(args)
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
                source_query_digest=queue_metadata._materialized_replay_tape_source_query_digest(
                    args=args,
                    symbols=requested_symbols,
                    start_date=date(2026, 2, 23),
                    end_date=date(2026, 2, 23),
                ),
                feature_schema_hash="stale-feature-schema",
                cost_model_hash=queue_metadata._materialized_replay_tape_cost_model_hash(
                    args
                ),
                strategy_family=queue_metadata._materialized_replay_tape_strategy_family(
                    args
                ),
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
            requested_symbols = artifact_io._candidate_universe_symbols_from_args(args)
            materialize_signal_tape(
                rows=rows,
                tape_path=tape_path,
                dataset_snapshot_ref="blocked-preview",
                symbols=requested_symbols,
                start_date=date(2026, 2, 23),
                end_date=date(2026, 2, 23),
                source_query_digest=queue_metadata._materialized_replay_tape_source_query_digest(
                    args=args,
                    symbols=requested_symbols,
                    start_date=date(2026, 2, 23),
                    end_date=date(2026, 2, 23),
                ),
                feature_schema_hash=queue_metadata._materialized_replay_tape_feature_schema_hash(
                    args
                ),
                cost_model_hash=queue_metadata._materialized_replay_tape_cost_model_hash(
                    args
                ),
                strategy_family=queue_metadata._materialized_replay_tape_strategy_family(
                    args
                ),
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

        queue_payload = queue_metadata._bounded_sim_target_queue_metadata(
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

            self.assertEqual(
                preview_narrowing._resolved_fast_replay_preview_top_k(args), 0
            )
            self.assertFalse(queue_metadata._auto_materialize_staged_replay_tape(args))

            args.staged_replay_frontier_default = True
            args.disable_staged_replay_frontier = True
            self.assertEqual(
                preview_narrowing._resolved_fast_replay_preview_top_k(args), 0
            )
            self.assertFalse(queue_metadata._auto_materialize_staged_replay_tape(args))

            args.disable_staged_replay_frontier = False
            args.replay_mode = "synthetic"
            self.assertEqual(
                preview_narrowing._resolved_fast_replay_preview_top_k(args), 0
            )
            self.assertFalse(queue_metadata._auto_materialize_staged_replay_tape(args))

            args.replay_mode = "real"
            args.replay_tape_path = None
            self.assertEqual(
                preview_narrowing._resolved_fast_replay_preview_top_k(args), 0
            )

            args.selection_only = True
            self.assertFalse(queue_metadata._auto_materialize_staged_replay_tape(args))

            args.selection_only = False
            args.replay_tape_path = Path(tmpdir) / "provided-tape.jsonl"
            self.assertFalse(queue_metadata._auto_materialize_staged_replay_tape(args))

            args.replay_tape_path = None
            args.full_window_start_date = ""
            self.assertFalse(queue_metadata._auto_materialize_staged_replay_tape(args))

            args.full_window_start_date = "2026-02-23"
            args.full_window_end_date = ""
            self.assertFalse(queue_metadata._auto_materialize_staged_replay_tape(args))
