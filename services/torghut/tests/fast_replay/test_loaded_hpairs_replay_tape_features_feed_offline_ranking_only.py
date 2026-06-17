from __future__ import annotations

from tests.fast_replay.support import (
    Decimal,
    Path,
    SignalEnvelope,
    TemporaryDirectory,
    _TestFastReplayPreviewBase,
    ast,
    build_fast_replay_preview,
    build_source_query_digest,
    date,
    datetime,
    fast_replay,
    load_replay_tape,
    materialize_signal_tape,
    timedelta,
    timezone,
)


class TestLoadedHpairsReplayTapeFeaturesFeedOfflineRankingOnly(
    _TestFastReplayPreviewBase
):
    def test_loaded_hpairs_replay_tape_features_feed_offline_ranking_only(
        self,
    ) -> None:
        def hpairs_signal(offset: int, price: str, ofi: str) -> SignalEnvelope:
            return SignalEnvelope(
                event_ts=datetime(2026, 2, 23, 14, 30, tzinfo=timezone.utc)
                + timedelta(minutes=offset),
                symbol="AAA",
                timeframe="1Min",
                seq=offset,
                source="test",
                payload={
                    "price": Decimal(price),
                    "spread_bps": Decimal("2"),
                    "microbar_volume": Decimal("100000"),
                    "ofi_horizons": {
                        "3": Decimal(ofi),
                        "12": Decimal("0.25"),
                    },
                    "ofi_decay_memory": {
                        "half_life_3": Decimal("0.60"),
                        "half_life_12": Decimal("0.30"),
                    },
                    "cluster_lob_bucket": "directional",
                    "regime_tags": ["opening_drive"],
                    "target_implied_notional": Decimal("50000"),
                },
                ingest_ts=datetime(2026, 2, 23, 14, 31, tzinfo=timezone.utc),
            )

        with TemporaryDirectory() as tmpdir:
            tape_path = Path(tmpdir) / "tape.jsonl"
            materialize_signal_tape(
                rows=[
                    hpairs_signal(1, "100", "0.70"),
                    hpairs_signal(2, "101", "0.80"),
                    hpairs_signal(3, "102", "0.90"),
                ],
                tape_path=tape_path,
                dataset_snapshot_ref="snapshot-hpairs-features",
                symbols=("AAA",),
                start_date=date(2026, 2, 23),
                end_date=date(2026, 2, 23),
                source_query_digest=build_source_query_digest(
                    {"window": "hpairs-features"}
                ),
                feature_schema_hash="feature-hpairs",
                cost_model_hash="cost-hpairs",
                strategy_family="hpairs-feature-ranking",
            )
            tape = load_replay_tape(tape_path)

        preview = build_fast_replay_preview(
            specs=(self._spec("spec-hpairs", symbols=["AAA"]),),
            rows=tape.rows,
            replay_tape_manifest=tape.manifest,
            top_k=1,
            min_rows_per_candidate=2,
        )

        row = preview.rows[0]
        payload = row.to_payload()
        self.assertGreater(row.ofi_pressure_score, Decimal("0"))
        self.assertGreater(row.ofi_decay_alignment_score, Decimal("0"))
        self.assertEqual(row.frontier_bucket, "exploitation")
        self.assertIn("hpairs_replay_tape_features", tape.rows[0].payload)
        self.assertFalse(
            tape.rows[0].payload["hpairs_replay_tape_features"]["proof_authority"]
        )
        self.assertFalse(payload["promotion_allowed"])
        self.assertFalse(payload["proof_authority"])
        self.assertFalse(payload["final_authority_ok"])

    def test_ofi_pressure_uses_nonstandard_hpair_horizon_values(self) -> None:
        signal = SignalEnvelope(
            event_ts=datetime(2026, 2, 23, 14, 30, tzinfo=timezone.utc),
            symbol="AAA",
            timeframe="1Min",
            seq=1,
            source="test",
            payload={
                "hpairs_replay_tape_features": {
                    "order_flow_imbalance_horizons": {
                        "custom_short": "125",
                        "custom_long": "175",
                        "bad": "not-a-decimal",
                    },
                },
            },
            ingest_ts=datetime(2026, 2, 23, 14, 31, tzinfo=timezone.utc),
        )

        ofi_pressure = fast_replay._extract_ofi_pressure(signal)

        self.assertIsNotNone(ofi_pressure)
        assert ofi_pressure is not None
        self.assertGreater(ofi_pressure, 0.9)
        self.assertLessEqual(ofi_pressure, 1.0)

    def test_ofi_pressure_uses_replay_tape_memory_regime_slices(self) -> None:
        signal = SignalEnvelope(
            event_ts=datetime(2026, 2, 23, 14, 30, tzinfo=timezone.utc),
            symbol="AAA",
            timeframe="1Min",
            seq=1,
            source="test",
            payload={
                "hpairs_replay_tape_features": {
                    "ofi_memory_regime_slices": {
                        "horizons": {
                            "instant": "0.30",
                            "short": "0.50",
                            "medium": "0.20",
                            "long": "0.10",
                        },
                        "directional_alignment_score": "0.35",
                        "regime_bucket": "positive_ofi_shock",
                        "prefilter_only": True,
                        "proof_authority": False,
                    },
                    "cluster_lob": {"bucket": "aggressive_buy_pressure"},
                },
            },
            ingest_ts=datetime(2026, 2, 23, 14, 31, tzinfo=timezone.utc),
        )

        ofi_pressure = fast_replay._extract_ofi_pressure(signal)
        ofi_memory = fast_replay._extract_ofi_memory_regime_score(signal)

        self.assertEqual(ofi_pressure, 0.275)
        self.assertEqual(ofi_memory, 0.35)

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
                feature_schema_hash="feature-notional",
                cost_model_hash="cost-notional",
                strategy_family="hpairs-notional",
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
        self.assertIn(
            "positive_post_cost_expectancy_missing",
            negative["lineage_blockers"],
        )

    def test_fast_preview_ranking_uses_combined_preview_score_before_raw_prefilter(
        self,
    ) -> None:
        def row(
            candidate_spec_id: str,
            *,
            preview_score: str,
            prefilter_score: str,
            exploration_score: str = "0",
            is_hpairs_candidate: bool = True,
        ) -> fast_replay.FastReplayPreviewRow:
            return fast_replay.FastReplayPreviewRow(
                candidate_spec_id=candidate_spec_id,
                rank=0,
                preview_score=Decimal(preview_score),
                selected=False,
                selection_reason="fast_replay_preview_ranked",
                matched_row_count=10,
                matched_symbol_count=1,
                requested_symbol_count=1,
                trading_day_count=1,
                signed_return_bps=Decimal("1"),
                avg_abs_return_bps=Decimal("0"),
                median_spread_bps=Decimal("0"),
                activity_score=Decimal("0"),
                coverage_score=Decimal("1"),
                ofi_pressure_score=Decimal("0"),
                microprice_bias_bps=Decimal("0"),
                spread_tail_bps=Decimal("0"),
                return_tail_abs_bps=Decimal("0"),
                impact_liquidity_penalty_bps=Decimal("0"),
                cluster_lob_activity_score=Decimal("0"),
                ofi_decay_alignment_score=Decimal("0"),
                liquidity_regime_score=Decimal("0"),
                macro_stress_veto_score=Decimal("0"),
                conformal_tail_risk_penalty_bps=Decimal("0"),
                square_root_impact_capacity_penalty_bps=Decimal("0"),
                exploration_score=Decimal(exploration_score),
                frontier_bucket="not_selected",
                microstructure_prefilter={
                    "prefilter_score": prefilter_score,
                    "is_hpairs_candidate": is_hpairs_candidate,
                    "proof_source": "prefilter_only",
                    "proof_authority": False,
                    "promotion_allowed": False,
                    "final_promotion_allowed": False,
                },
            )

        ranked = sorted(
            (
                row("raw-prefilter-winner", preview_score="1", prefilter_score="999"),
                row("combined-preview-winner", preview_score="50", prefilter_score="0"),
                row(
                    "explicit-non-hpairs",
                    preview_score="100",
                    prefilter_score="1000",
                    is_hpairs_candidate=False,
                ),
            ),
            key=fast_replay._preview_rank_key,
        )
        selected = fast_replay._select_frontier_buckets(
            ranked_rows=ranked,
            exploitation_count=1,
            exploration_count=1,
            exact_replay_candidate_cap=2,
        )

        self.assertEqual(ranked[0].candidate_spec_id, "combined-preview-winner")
        self.assertEqual(selected["combined-preview-winner"], "exploitation")
        self.assertNotIn("explicit-non-hpairs", selected)

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
                feature_schema_hash="feature-cap",
                cost_model_hash="cost-cap",
                strategy_family="hpairs-cap",
            )
        specs = tuple(
            self._spec(
                f"spec-{index}",
                symbols=["AAA"],
                max_notional_per_trade=str(2500 + index),
            )
            for index in range(8)
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
        payload = preview.to_manifest_payload()
        exact_queue = payload["bounded_exact_replay_queue"]
        self.assertEqual(exact_queue["exact_replay_candidate_cap"], 6)
        self.assertEqual(exact_queue["enqueue_candidate_count"], 6)
        self.assertEqual(
            exact_queue["selected_candidate_spec_ids"],
            list(preview.selected_candidate_spec_ids),
        )
        self.assertEqual(
            exact_queue["selected_candidate_ids_by_bucket"]["all"],
            list(preview.selected_candidate_spec_ids),
        )
        self.assertEqual(
            len(exact_queue["selected_candidate_ids_by_bucket"]["exploitation"]),
            4,
        )
        self.assertEqual(
            len(exact_queue["selected_candidate_ids_by_bucket"]["exploration"]),
            2,
        )
        self.assertEqual(
            exact_queue["status"],
            "metadata_only_not_dispatched",
        )
        self.assertFalse(exact_queue["command_execution_allowed_here"])
        self.assertFalse(exact_queue["kubernetes_fanout_allowed"])
        self.assertFalse(exact_queue["db_writes_allowed"])
        self.assertFalse(exact_queue["proof_packet_upload_allowed"])
        self.assertFalse(exact_queue["promotion_allowed"])
        self.assertFalse(exact_queue["final_authority_ok"])
        self.assertEqual(
            payload["selected_candidate_ids_by_bucket"]["all"],
            list(preview.selected_candidate_spec_ids),
        )
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

    def test_frontier_selector_defaults_to_four_exploitation_two_diverse_exploration(
        self,
    ) -> None:
        def row(
            candidate_spec_id: str,
            *,
            preview_score: str,
            exploration_score: str,
            symbols: list[str],
        ) -> fast_replay.FastReplayPreviewRow:
            return fast_replay.FastReplayPreviewRow(
                candidate_spec_id=candidate_spec_id,
                rank=0,
                preview_score=Decimal(preview_score),
                selected=False,
                selection_reason="fast_replay_preview_ranked",
                matched_row_count=10,
                matched_symbol_count=1,
                requested_symbol_count=1,
                trading_day_count=1,
                signed_return_bps=Decimal("3"),
                avg_abs_return_bps=Decimal("1"),
                median_spread_bps=Decimal("1"),
                activity_score=Decimal("1"),
                coverage_score=Decimal("1"),
                ofi_pressure_score=Decimal("1"),
                microprice_bias_bps=Decimal("0"),
                spread_tail_bps=Decimal("1"),
                return_tail_abs_bps=Decimal("1"),
                impact_liquidity_penalty_bps=Decimal("0"),
                cluster_lob_activity_score=Decimal("1"),
                ofi_decay_alignment_score=Decimal("1"),
                liquidity_regime_score=Decimal("1"),
                macro_stress_veto_score=Decimal("0"),
                conformal_tail_risk_penalty_bps=Decimal("0"),
                square_root_impact_capacity_penalty_bps=Decimal("1"),
                exploration_score=Decimal(exploration_score),
                frontier_bucket="not_selected",
                microstructure_prefilter={
                    "is_hpairs_candidate": True,
                    "proof_source": "prefilter_only",
                    "proof_authority": False,
                    "promotion_allowed": False,
                    "final_promotion_allowed": False,
                },
                candidate_lineage={
                    "family_template_id": "microbar_cross_sectional_pairs_v1",
                    "runtime_strategy_name": "microbar-cross-sectional-pairs-v1",
                    "symbol_universe": symbols,
                    "lineage_preserved": True,
                },
            )

        ranked = sorted(
            (
                row(
                    "exploit-1",
                    preview_score="100",
                    exploration_score="1",
                    symbols=["AAA"],
                ),
                row(
                    "exploit-2",
                    preview_score="99",
                    exploration_score="1",
                    symbols=["BBB"],
                ),
                row(
                    "exploit-3",
                    preview_score="98",
                    exploration_score="1",
                    symbols=["CCC"],
                ),
                row(
                    "exploit-4",
                    preview_score="97",
                    exploration_score="1",
                    symbols=["DDD"],
                ),
                row(
                    "explore-same-high",
                    preview_score="10",
                    exploration_score="100",
                    symbols=["AAA"],
                ),
                row(
                    "explore-same-deferred",
                    preview_score="9",
                    exploration_score="99",
                    symbols=["AAA"],
                ),
                row(
                    "explore-diverse",
                    preview_score="8",
                    exploration_score="98",
                    symbols=["EEE"],
                ),
                row(
                    "budget-exhausted",
                    preview_score="7",
                    exploration_score="97",
                    symbols=["FFF"],
                ),
            ),
            key=fast_replay._preview_rank_key,
        )

        selected = fast_replay._select_frontier_buckets(
            ranked_rows=ranked,
            exploitation_count=fast_replay.FAST_REPLAY_DEFAULT_EXPLOITATION_COUNT,
            exploration_count=fast_replay.FAST_REPLAY_DEFAULT_EXPLORATION_COUNT,
            exact_replay_candidate_cap=fast_replay.FAST_REPLAY_EXACT_REPLAY_CANDIDATE_CAP,
        )
        final_rows = [
            fast_replay._row_with_rank_and_selection(
                row=item,
                rank=index,
                frontier_bucket=selected.get(item.candidate_spec_id, "not_selected"),
            )
            for index, item in enumerate(ranked, start=1)
        ]
        payloads = {item.candidate_spec_id: item.to_payload() for item in final_rows}

        self.assertEqual(
            [
                candidate_id
                for candidate_id, bucket in selected.items()
                if bucket == "exploitation"
            ],
            ["exploit-1", "exploit-2", "exploit-3", "exploit-4"],
        )
        self.assertEqual(
            [
                candidate_id
                for candidate_id, bucket in selected.items()
                if bucket == "exploration"
            ],
            ["explore-same-high", "explore-diverse"],
        )
        self.assertNotIn("explore-same-deferred", selected)
        self.assertEqual(len(selected), 6)
        self.assertEqual(
            payloads["explore-same-high"]["selection_reason"],
            "fast_replay_frontier_exploration_selected",
        )
        self.assertEqual(
            payloads["explore-diverse"]["selection_reason"],
            "fast_replay_frontier_exploration_selected",
        )
        self.assertEqual(
            payloads["explore-same-deferred"]["selection_reason"],
            "fast_replay_frontier_budget_exhausted_skipped",
        )
        self.assertEqual(
            payloads["budget-exhausted"]["frontier_selection"]["reason_code"],
            "fast_replay_frontier_budget_exhausted_skipped",
        )
        self.assertFalse(
            payloads["budget-exhausted"]["frontier_selection"]["final_authority_ok"]
        )

    def test_preview_boundary_fields_are_ranking_only_and_never_authorize_promotion(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            rows = [
                self._signal(symbol="AAA", offset=1, price="100", ofi="0.40"),
                self._signal(symbol="AAA", offset=2, price="101", ofi="0.50"),
                self._signal(symbol="AAA", offset=3, price="102", ofi="0.60"),
            ]
            manifest = materialize_signal_tape(
                rows=rows,
                tape_path=Path(tmpdir) / "tape.jsonl",
                dataset_snapshot_ref="snapshot-boundary-fields",
                symbols=("AAA",),
                start_date=date(2026, 2, 23),
                end_date=date(2026, 2, 23),
                source_query_digest=build_source_query_digest({"window": "boundary"}),
                feature_schema_hash="feature-boundary",
                cost_model_hash="cost-boundary",
                strategy_family="hpairs-boundary",
            )

        preview = build_fast_replay_preview(
            specs=(self._spec("spec-boundary", symbols=["AAA"]),),
            rows=rows,
            replay_tape_manifest=manifest,
            top_k=1,
            min_rows_per_candidate=2,
        )
        payload = preview.rows[0].to_payload()
        manifest_payload = preview.to_manifest_payload()

        self.assertEqual(payload["preview_rank_score"], payload["preview_score"])
        self.assertTrue(payload["exact_replay_required"])
        self.assertTrue(payload["runtime_ledger_required"])
        self.assertIn("ranking_only_reasons", payload)
        self.assertIn("risk_veto_reasons", payload)
        self.assertIn(
            "exact_replay_required_before_any_promotion_claim",
            payload["ranking_only_reasons"],
        )
        self.assertIn(
            "runtime_ledger_required_before_any_profitability_claim",
            payload["ranking_only_reasons"],
        )
        runtime_handoff = payload["runtime_ledger_lineage_materialization_handoff"]
        self.assertEqual(
            runtime_handoff["schema_version"],
            fast_replay.FAST_REPLAY_RUNTIME_LEDGER_LINEAGE_HANDOFF_SCHEMA_VERSION,
        )
        self.assertTrue(runtime_handoff["runtime_ledger_required"])
        self.assertTrue(runtime_handoff["source_backed_runtime_ledger_required"])
        self.assertTrue(
            runtime_handoff["zero_authoritative_daily_pnl_until_materialized"]
        )
        self.assertFalse(runtime_handoff["promotion_allowed"])
        self.assertFalse(runtime_handoff["final_authority_ok"])
        self.assertIn(
            "closed_round_trip_ledger",
            runtime_handoff["required_materialized_artifacts"],
        )
        self.assertIn(
            "route_tca_observations",
            runtime_handoff["required_materialized_artifacts"],
        )
        self.assertIn(
            "broker_execution_semantics_parity",
            runtime_handoff["required_semantic_parity_checks"],
        )
        self.assertIn(
            "live_paper_runtime_ledger_required",
            runtime_handoff["lineage_blockers"],
        )
        self.assertFalse(payload["promotion_allowed"])
        self.assertFalse(payload["frontier_selection"]["promotion_allowed"])
        self.assertFalse(payload["frontier_selection"]["final_authority_ok"])
        boundary = manifest_payload["ranking_authority_boundary"]
        self.assertEqual(boundary["preview_rank_score_field"], "preview_rank_score")
        self.assertTrue(boundary["exact_replay_required"])
        self.assertTrue(boundary["runtime_ledger_required"])
        self.assertFalse(boundary["ranking_output_can_authorize_promotion"])
        self.assertEqual(
            manifest_payload["throughput_limits"]["max_exact_replay_candidates"], 6
        )
        self.assertLessEqual(
            manifest_payload["throughput_limits"]["exact_replay_candidate_cap"], 6
        )
        self.assertEqual(manifest_payload["throughput_limits"]["max_local_workers"], 2)
        self.assertFalse(
            manifest_payload["throughput_limits"]["kubernetes_fanout_allowed"]
        )
        exact_queue = manifest_payload["bounded_exact_replay_queue"]
        self.assertEqual(
            exact_queue["candidate_command_contract"]["source"],
            "selected_candidate_spec_ids",
        )
        self.assertFalse(
            exact_queue["candidate_command_contract"]["command_execution_allowed_here"]
        )
        self.assertTrue(exact_queue["preview_only"])
        self.assertTrue(exact_queue["research_ranking_only"])
        self.assertFalse(exact_queue["promotion_authority"])
        self.assertFalse(exact_queue["final_authority_ok"])
        queue_handoff = exact_queue["runtime_ledger_lineage_materialization_handoff"]
        self.assertEqual(queue_handoff["candidate_count"], 1)
        self.assertEqual(
            queue_handoff["candidates"][0]["candidate_spec_id"], "spec-boundary"
        )
        self.assertTrue(
            queue_handoff["zero_authoritative_daily_pnl_until_materialized"]
        )
        self.assertFalse(queue_handoff["command_execution_allowed_here"])
        self.assertFalse(queue_handoff["db_writes_allowed"])
        self.assertFalse(queue_handoff["proof_packet_upload_allowed"])
        self.assertFalse(queue_handoff["promotion_allowed"])
        self.assertIn(
            "arxiv-2603.21330",
            {source["source_id"] for source in queue_handoff["source_papers"]},
        )

    def test_frontier_path_has_no_kubernetes_or_database_execution_imports(
        self,
    ) -> None:
        module_path = Path(fast_replay.__file__)
        parsed = ast.parse(module_path.read_text(encoding="utf-8"))
        disallowed_import_roots = {
            "asyncpg",
            "kubernetes",
            "psycopg",
            "psycopg2",
            "sqlalchemy",
            "subprocess",
        }
        imported_roots: set[str] = set()
        for node in ast.walk(parsed):
            if isinstance(node, ast.Import):
                imported_roots.update(
                    alias.name.split(".", maxsplit=1)[0] for alias in node.names
                )
            elif isinstance(node, ast.ImportFrom) and node.module is not None:
                imported_roots.add(node.module.split(".", maxsplit=1)[0])

        self.assertTrue(disallowed_import_roots.isdisjoint(imported_roots))

    def test_robust_lower_percentile_utility_ranks_ahead_of_mean_only_score(
        self,
    ) -> None:
        def row(
            candidate_spec_id: str,
            *,
            preview_score: str,
            robust_utility: str,
        ) -> fast_replay.FastReplayPreviewRow:
            return fast_replay.FastReplayPreviewRow(
                candidate_spec_id=candidate_spec_id,
                rank=0,
                preview_score=Decimal(preview_score),
                selected=False,
                selection_reason="fast_replay_preview_ranked",
                matched_row_count=10,
                matched_symbol_count=1,
                requested_symbol_count=1,
                trading_day_count=1,
                signed_return_bps=Decimal("1"),
                avg_abs_return_bps=Decimal("0"),
                median_spread_bps=Decimal("0"),
                activity_score=Decimal("0"),
                coverage_score=Decimal("1"),
                ofi_pressure_score=Decimal("0"),
                microprice_bias_bps=Decimal("0"),
                spread_tail_bps=Decimal("0"),
                return_tail_abs_bps=Decimal("0"),
                impact_liquidity_penalty_bps=Decimal("0"),
                cluster_lob_activity_score=Decimal("0"),
                ofi_decay_alignment_score=Decimal("0"),
                liquidity_regime_score=Decimal("1"),
                macro_stress_veto_score=Decimal("0"),
                conformal_tail_risk_penalty_bps=Decimal("0"),
                square_root_impact_capacity_penalty_bps=Decimal("0"),
                exploration_score=Decimal("0"),
                frontier_bucket="not_selected",
                microstructure_prefilter={
                    "is_hpairs_candidate": True,
                    "proof_source": "prefilter_only",
                    "promotion_allowed": False,
                    "final_promotion_allowed": False,
                },
                robust_lower_percentile_post_cost_utility_bps=Decimal(robust_utility),
                bootstrap_lower_percentile_post_cost_utility_bps=Decimal(
                    robust_utility
                ),
            )

        ranked = sorted(
            (
                row("mean-only-tail-risk", preview_score="100", robust_utility="-5"),
                row("robust-frontier", preview_score="50", robust_utility="12"),
            ),
            key=fast_replay._preview_rank_key,
        )

        self.assertEqual(ranked[0].candidate_spec_id, "robust-frontier")
        payload = ranked[0].to_payload()
        self.assertEqual(payload["robust_lower_percentile_post_cost_utility_bps"], "12")
        self.assertIn(
            "robust_lower_percentile_post_cost_utility_used_for_ranking",
            payload["ranking_only_reasons"],
        )
        self.assertFalse(payload["promotion_allowed"])
