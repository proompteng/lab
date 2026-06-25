from __future__ import annotations

import scripts.whitepaper_autoresearch_runner.artifact_io as artifact_io
import scripts.whitepaper_autoresearch_runner.preview_narrowing as preview_narrowing
import scripts.whitepaper_autoresearch_runner.queue_metadata as queue_metadata

from tests.whitepaper_autoresearch.autoresearch_runner_base import (
    Decimal,
    Path,
    REPLAY_TAPE_MANIFEST_SCHEMA_VERSION,
    ReplayTapeManifest,
    SignalEnvelope,
    TemporaryDirectory,
    WhitepaperAutoresearchRunnerTestCaseBase,
    date,
    datetime,
    fast_replay,
    materialize_signal_tape,
    replace,
    runner,
    timezone,
)


class TestAutoresearchRunnerFastReplay(WhitepaperAutoresearchRunnerTestCaseBase):
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

            self.assertEqual(
                preview_narrowing._resolved_fast_replay_preview_top_k(args), 77
            )

            args.replay_tape_path = None
            self.assertTrue(queue_metadata._auto_materialize_staged_replay_tape(args))
