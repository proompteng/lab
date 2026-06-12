from __future__ import annotations

# ruff: noqa: F401,F403,F405
from tests.completion_trace.support import *


class TestCompletionTracePart1(_TestCompletionTraceBase):
    def test_runtime_and_doc_completion_matrices_match(self) -> None:
        self.assertTrue(runtime_and_doc_completion_matrices_match())

    def test_runtime_ledger_daily_summary_counts_day_distribution_and_drawdown(
        self,
    ) -> None:
        self.assertEqual(
            _runtime_ledger_trading_day_key(datetime(2026, 3, 6, 14, 30)),
            "2026-03-06",
        )
        self.assertEqual(
            _median_decimal([Decimal("3"), Decimal("1"), Decimal("2")]),
            Decimal("2"),
        )
        self.assertEqual(_p10_decimal([Decimal("5"), Decimal("-1")]), Decimal("-1"))

        rows = [
            _runtime_ledger_bucket(
                run_id="daily-positive",
                bucket_started_at=datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc),
                bucket_ended_at=datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc),
                payload_json={"source": "raw-runtime-ledger"},
            ),
            _runtime_ledger_bucket(
                run_id="daily-drawdown",
                bucket_started_at=datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc),
                bucket_ended_at=datetime(2026, 3, 6, 15, 30, tzinfo=timezone.utc),
                payload_json={"source": "raw-runtime-ledger"},
            ),
            _runtime_ledger_bucket(
                run_id="persisted-summary",
                bucket_started_at=datetime(2026, 3, 9, 13, 30, tzinfo=timezone.utc),
                bucket_ended_at=datetime(2026, 3, 9, 14, 0, tzinfo=timezone.utc),
                payload_json={
                    "runtime_ledger_daily_summary": {
                        "runtime_ledger_observed_trading_day_count": 25,
                        "runtime_ledger_mean_daily_net_pnl_after_costs": "24",
                    }
                },
            ),
        ]
        rows[0].net_strategy_pnl_after_costs = Decimal("100")
        rows[1].net_strategy_pnl_after_costs = Decimal("-40")

        summary = _runtime_ledger_daily_summary(rows[:2])
        self.assertEqual(
            summary["runtime_ledger_net_pnl_by_trading_day"],
            {"2026-03-06": "60"},
        )
        self.assertEqual(summary["runtime_ledger_max_intraday_drawdown"], "40")
        self.assertEqual(
            summary["runtime_ledger_closed_trade_count_by_day"],
            {"2026-03-06": 12},
        )

        persisted_summary = _runtime_ledger_daily_summary(rows)
        self.assertEqual(
            persisted_summary["runtime_ledger_observed_trading_day_count"],
            25,
        )
        self.assertEqual(
            persisted_summary["runtime_ledger_mean_daily_net_pnl_after_costs"],
            "24",
        )

    def test_persist_completion_trace_round_trips_gate_rows(self) -> None:
        trace = build_completion_trace(
            doc_id="doc29",
            gate_ids_attempted=[DOC29_SIMULATION_FULL_DAY_GATE],
            run_id="sim-2026-03-06-full-day",
            dataset_snapshot_ref="snapshot-1",
            candidate_id="cand-1",
            workflow_name="torghut-historical-simulation",
            analysis_run_names=["analysis-1"],
            artifact_refs=["s3://artifacts/run-full-lifecycle-manifest.json"],
            db_row_refs={"simulation_postgres_db": "torghut_sim_full_day"},
            status_snapshot={"activity_classification": "success"},
            result_by_gate={
                DOC29_SIMULATION_FULL_DAY_GATE: {
                    "status": TRACE_STATUS_SATISFIED,
                    "artifact_ref": "s3://artifacts/run-full-lifecycle-manifest.json",
                    "acceptance_snapshot": {
                        "trade_decisions": 640,
                        "executions": 320,
                        "execution_tca_metrics": 320,
                        "execution_order_events": 320,
                        "coverage_ratio": 0.99,
                    },
                }
            },
            blocked_reasons={},
            git_revision="abc123",
            image_digest="sha256:test",
            workflow_template_revision="abc123",
        )

        with self.session_local() as session:
            row_ids = persist_completion_trace(
                session=session,
                trace_payload=trace,
                default_artifact_ref="s3://artifacts/completion-trace.json",
            )
            session.commit()

            status = build_doc29_completion_status(
                session=session,
                stale_after_seconds=86400,
                current_git_revision="abc123",
                current_image_digest="sha256:test",
            )

        self.assertIn(DOC29_SIMULATION_FULL_DAY_GATE, row_ids)
        gate = next(
            item
            for item in status["gates"]
            if item["gate_id"] == DOC29_SIMULATION_FULL_DAY_GATE
        )
        self.assertEqual(gate["status"], "satisfied")
        self.assertEqual(gate["latest_run"], "sim-2026-03-06-full-day")

    def test_doc29_completion_status_all_satisfied_stays_status_only(self) -> None:
        with self.session_local() as session:
            with patch(
                "app.trading.completion.load_doc29_completion_matrix",
                return_value={
                    "doc_id": "doc29",
                    "design_doc_path": "docs/torghut/design-system/v6/29-completion-matrix-2026-03-07.yaml",
                    "matrix_version": "test-empty-matrix",
                    "gates": [],
                },
            ):
                status = build_doc29_completion_status(
                    session=session,
                    stale_after_seconds=86400,
                    current_git_revision="abc123",
                    current_image_digest="sha256:test",
                )

        self.assertTrue(status["summary"]["all_satisfied"])
        self.assertTrue(status["promotion_authority"]["completion_trace_all_satisfied"])
        self.assertEqual(
            status["promotion_authority"]["authority_source"],
            "completion_trace_status_only",
        )
        self.assertFalse(status["promotion_authority"]["capital_promotion_allowed"])
        self.assertFalse(status["promotion_authority"]["promotion_allowed"])
        self.assertFalse(status["promotion_authority"]["final_authority_ok"])
        self.assertFalse(status["promotion_authority"]["final_promotion_allowed"])
        self.assertEqual(
            status["promotion_authority"]["final_promotion_blockers"],
            ["completion_trace_not_runtime_ledger_authority"],
        )

    def test_doc29_completion_status_derives_empirical_jobs_gate(self) -> None:
        with self.session_local() as session:
            for job_type in (
                "benchmark_parity",
                "foundation_router_parity",
                "janus_event_car",
                "janus_hgrm_reward",
            ):
                session.add(
                    VNextEmpiricalJobRun(
                        run_id="run-1",
                        candidate_id="cand-1",
                        job_name=job_type,
                        job_type=job_type,
                        job_run_id=f"job-{job_type}",
                        status="completed",
                        authority="empirical",
                        promotion_authority_eligible=True,
                        dataset_snapshot_ref="snapshot-1",
                        artifact_refs=[f"s3://artifacts/{job_type}.json"],
                        payload_json=_truthful_empirical_payload(
                            job_run_id=f"job-{job_type}",
                        ),
                    )
                )
            session.commit()

            status = build_doc29_completion_status(
                session=session,
                stale_after_seconds=86400,
                current_git_revision="abc123",
                current_image_digest="sha256:test",
            )

        gate = next(
            item
            for item in status["gates"]
            if item["gate_id"] == DOC29_EMPIRICAL_JOBS_GATE
        )
        self.assertEqual(gate["status"], "satisfied")
        self.assertEqual(gate["source"], "derived_from_empirical_jobs")

    def test_doc29_completion_status_blocks_paper_gate_without_fill_price_budget(
        self,
    ) -> None:
        trace = build_completion_trace(
            doc_id="doc29",
            gate_ids_attempted=[DOC29_SIMULATION_FULL_DAY_GATE],
            run_id="sim-2026-03-06-full-day",
            dataset_snapshot_ref="snapshot-1",
            candidate_id="cand-1",
            workflow_name="torghut-historical-simulation",
            analysis_run_names=[],
            artifact_refs=["s3://artifacts/run-full-lifecycle-manifest.json"],
            db_row_refs={},
            status_snapshot={},
            result_by_gate={
                DOC29_SIMULATION_FULL_DAY_GATE: {
                    "status": TRACE_STATUS_SATISFIED,
                    "artifact_ref": "s3://artifacts/run-full-lifecycle-manifest.json",
                    "acceptance_snapshot": {
                        "trade_decisions": 640,
                        "executions": 320,
                        "execution_tca_metrics": 320,
                        "execution_order_events": 320,
                        "coverage_ratio": 0.99,
                    },
                }
            },
            blocked_reasons={},
            git_revision="abc123",
            image_digest="sha256:test",
        )
        with self.session_local() as session:
            persist_completion_trace(
                session=session,
                trace_payload=trace,
                default_artifact_ref="s3://artifacts/completion-trace.json",
            )
            for job_type in (
                "benchmark_parity",
                "foundation_router_parity",
                "janus_event_car",
                "janus_hgrm_reward",
            ):
                session.add(
                    VNextEmpiricalJobRun(
                        run_id="run-1",
                        candidate_id="cand-1",
                        job_name=job_type,
                        job_type=job_type,
                        job_run_id=f"job-{job_type}",
                        status="completed",
                        authority="empirical",
                        promotion_authority_eligible=True,
                        dataset_snapshot_ref="snapshot-1",
                        artifact_refs=[f"s3://artifacts/{job_type}.json"],
                        payload_json=_truthful_empirical_payload(
                            job_run_id=f"job-{job_type}",
                        ),
                    )
                )
            session.commit()

            status = build_doc29_completion_status(
                session=session,
                stale_after_seconds=86400,
                current_git_revision="abc123",
                current_image_digest="sha256:test",
            )

        paper_gate = next(
            item
            for item in status["gates"]
            if item["gate_id"] == "paper_gate_satisfied"
        )
        self.assertEqual(paper_gate["status"], "blocked")
        self.assertEqual(
            paper_gate["blocked_reason"], "fill_price_error_budget_not_recorded"
        )

    def test_doc29_completion_status_satisfies_paper_gate_with_fill_price_budget(
        self,
    ) -> None:
        trace = build_completion_trace(
            doc_id="doc29",
            gate_ids_attempted=[DOC29_SIMULATION_FULL_DAY_GATE],
            run_id="sim-2026-03-06-full-day",
            dataset_snapshot_ref="snapshot-1",
            candidate_id="cand-1",
            workflow_name="torghut-historical-simulation",
            analysis_run_names=[],
            artifact_refs=["s3://artifacts/run-full-lifecycle-manifest.json"],
            db_row_refs={},
            status_snapshot={},
            result_by_gate={
                DOC29_SIMULATION_FULL_DAY_GATE: {
                    "status": TRACE_STATUS_SATISFIED,
                    "artifact_ref": "s3://artifacts/run-full-lifecycle-manifest.json",
                    "acceptance_snapshot": {
                        "trade_decisions": 640,
                        "executions": 320,
                        "execution_tca_metrics": 320,
                        "execution_order_events": 320,
                        "coverage_ratio": 0.99,
                        "fill_price_error_budget_status": "within_budget",
                        "fill_price_error_budget_artifact_ref": (
                            "s3://artifacts/gates/fill-price-error-budget-report-v1.json"
                        ),
                    },
                },
            },
            blocked_reasons={},
            git_revision="abc123",
            image_digest="sha256:test",
        )
        with self.session_local() as session:
            persist_completion_trace(
                session=session,
                trace_payload=trace,
                default_artifact_ref="s3://artifacts/completion-trace.json",
            )
            for job_type in (
                "benchmark_parity",
                "foundation_router_parity",
                "janus_event_car",
                "janus_hgrm_reward",
            ):
                session.add(
                    VNextEmpiricalJobRun(
                        run_id="run-1",
                        candidate_id="cand-1",
                        job_name=job_type,
                        job_type=job_type,
                        job_run_id=f"job-{job_type}",
                        status="completed",
                        authority="empirical",
                        promotion_authority_eligible=True,
                        dataset_snapshot_ref="snapshot-1",
                        artifact_refs=[f"s3://artifacts/{job_type}.json"],
                        payload_json=_truthful_empirical_payload(
                            job_run_id=f"job-{job_type}",
                        ),
                    )
                )
            session.commit()

            status = build_doc29_completion_status(
                session=session,
                stale_after_seconds=86400,
                current_git_revision="abc123",
                current_image_digest="sha256:test",
            )

        paper_gate = next(
            item for item in status["gates"] if item["gate_id"] == DOC29_PAPER_GATE
        )
        self.assertEqual(paper_gate["status"], "satisfied")
        self.assertIn(
            "s3://artifacts/gates/fill-price-error-budget-report-v1.json",
            paper_gate["artifact_refs"],
        )

    def test_doc29_completion_status_derives_live_canary_and_scale_gates(self) -> None:
        trace = build_completion_trace(
            doc_id="doc29",
            gate_ids_attempted=[
                "promotion_truthfulness_firewall",
                "strategy_spec_v2_runtime_lineage",
                DOC29_SIMULATION_SMOKE_GATE,
                DOC29_SIMULATION_FULL_DAY_GATE,
                DOC29_EMPIRICAL_MANIFEST_GATE,
            ],
            run_id="sim-2026-03-06-full-day",
            dataset_snapshot_ref="snapshot-1",
            candidate_id="cand-1",
            workflow_name="torghut-historical-simulation",
            analysis_run_names=[],
            artifact_refs=["s3://artifacts/run-full-lifecycle-manifest.json"],
            db_row_refs={},
            status_snapshot={},
            result_by_gate={
                "promotion_truthfulness_firewall": {
                    "status": TRACE_STATUS_SATISFIED,
                    "artifact_ref": "s3://artifacts/gates/benchmark-parity-report-v1.json",
                    "acceptance_snapshot": {
                        "synthetic_evidence_present": False,
                        "placeholder_evidence_present": False,
                    },
                },
                "strategy_spec_v2_runtime_lineage": {
                    "status": TRACE_STATUS_SATISFIED,
                    "artifact_ref": "s3://artifacts/completion-trace.json",
                    "acceptance_snapshot": {
                        "strategy_spec_ref": "StrategySpecV2:legacy_macd_rsi",
                        "experiment_spec_ref": "ExperimentSpec:doc29",
                    },
                },
                DOC29_SIMULATION_SMOKE_GATE: {
                    "status": TRACE_STATUS_SATISFIED,
                    "artifact_ref": "s3://artifacts/run-smoke-manifest.json",
                    "acceptance_snapshot": {
                        "trade_decisions": 12,
                        "executions": 12,
                        "execution_tca_metrics": 12,
                        "execution_order_events": 12,
                        "coverage_ratio": 1.0,
                    },
                },
                DOC29_SIMULATION_FULL_DAY_GATE: {
                    "status": TRACE_STATUS_SATISFIED,
                    "artifact_ref": "s3://artifacts/run-full-lifecycle-manifest.json",
                    "acceptance_snapshot": {
                        "trade_decisions": 640,
                        "executions": 320,
                        "execution_tca_metrics": 320,
                        "execution_order_events": 320,
                        "coverage_ratio": 0.99,
                        "fill_price_error_budget_status": "within_budget",
                        "fill_price_error_budget_artifact_ref": (
                            "s3://artifacts/gates/fill-price-error-budget-report-v1.json"
                        ),
                    },
                },
                DOC29_EMPIRICAL_MANIFEST_GATE: {
                    "status": TRACE_STATUS_SATISFIED,
                    "artifact_ref": "s3://artifacts/empirical-manifest.json",
                    "acceptance_snapshot": {
                        "manifest_schema_version": "torghut.empirical-manifest.v1",
                        "lineage_complete": True,
                    },
                },
            },
            blocked_reasons={},
            git_revision="abc123",
            image_digest="sha256:test",
        )
        with self.session_local() as session:
            persist_completion_trace(
                session=session,
                trace_payload=trace,
                default_artifact_ref="s3://artifacts/completion-trace.json",
            )
            for job_type in (
                "benchmark_parity",
                "foundation_router_parity",
                "janus_event_car",
                "janus_hgrm_reward",
            ):
                session.add(
                    VNextEmpiricalJobRun(
                        run_id="run-1",
                        candidate_id="cand-1",
                        job_name=job_type,
                        job_type=job_type,
                        job_run_id=f"job-{job_type}",
                        status="completed",
                        authority="empirical",
                        promotion_authority_eligible=True,
                        dataset_snapshot_ref="snapshot-1",
                        artifact_refs=[f"s3://artifacts/{job_type}.json"],
                        payload_json=_truthful_empirical_payload(
                            job_run_id=f"job-{job_type}",
                        ),
                    )
                )

            now = datetime.now(timezone.utc)
            paper_window_start = now - timedelta(days=2)
            for index in range(4):
                run_id = f"paper-run-{index}"
                session.add(
                    StrategyHypothesisMetricWindow(
                        run_id=run_id,
                        candidate_id="cand-1",
                        hypothesis_id="legacy_macd_rsi",
                        observed_stage="paper",
                        window_started_at=paper_window_start,
                        window_ended_at=paper_window_start,
                        market_session_count=10,
                        decision_count=200,
                        trade_count=194,
                        order_count=194,
                        evidence_provenance="paper_runtime_observed",
                        evidence_maturity="empirically_validated",
                        decision_alignment_ratio="0.97",
                        avg_abs_slippage_bps="4.2",
                        slippage_budget_bps="8.0",
                        post_cost_expectancy_bps="1.1",
                        continuity_ok=True,
                        drift_ok=True,
                        dependency_quorum_decision="allow",
                        capital_stage="shadow",
                        payload_json={},
                    )
                )
                session.add(
                    _promotion_decision(
                        run_id=run_id,
                        candidate_id="cand-1",
                        hypothesis_id="legacy_macd_rsi",
                        promotion_target="paper",
                        state="0.10x canary",
                    )
                )

            live_window_start = now - timedelta(days=1)
            runtime_daily_summary = {
                "runtime_ledger_observed_trading_day_count": 25,
                "runtime_ledger_net_pnl_by_trading_day": {
                    "2026-03-06": "600",
                    "2026-03-09": "0",
                },
                "runtime_ledger_mean_daily_net_pnl_after_costs": "24",
                "runtime_ledger_median_daily_net_pnl_after_costs": "0",
                "runtime_ledger_p10_daily_net_pnl_after_costs": "0",
                "runtime_ledger_worst_day_net_pnl_after_costs": "0",
                "runtime_ledger_max_intraday_drawdown": "0",
                "runtime_ledger_avg_daily_filled_notional": "4800",
                "runtime_ledger_closed_trade_count_by_day": {
                    "2026-03-06": 6,
                    "2026-03-09": 0,
                },
            }
            for index in range(10):
                run_id = f"live-run-{index}"
                live_window_end = live_window_start + timedelta(minutes=index + 1)
                session.add(
                    StrategyHypothesisMetricWindow(
                        run_id=run_id,
                        candidate_id="cand-1",
                        hypothesis_id="legacy_macd_rsi",
                        observed_stage="live",
                        window_started_at=live_window_start,
                        window_ended_at=live_window_end,
                        market_session_count=12,
                        decision_count=220,
                        trade_count=215,
                        order_count=215,
                        evidence_provenance="live_runtime_observed",
                        evidence_maturity="empirically_validated",
                        decision_alignment_ratio="0.98",
                        avg_abs_slippage_bps="4.5",
                        slippage_budget_bps="8.0",
                        post_cost_expectancy_bps="1.4",
                        continuity_ok=True,
                        drift_ok=True,
                        dependency_quorum_decision="allow",
                        capital_stage="0.50x live",
                        payload_json={},
                    )
                )
                session.add(
                    _promotion_decision(
                        run_id=run_id,
                        candidate_id="cand-1",
                        hypothesis_id="legacy_macd_rsi",
                        promotion_target="live",
                        state="0.50x live",
                    )
                )
                session.add(
                    _runtime_ledger_bucket(
                        run_id=run_id,
                        bucket_started_at=live_window_start,
                        bucket_ended_at=live_window_end,
                        payload_json=_runtime_ledger_source_authority_payload(
                            extra={
                                "runtime_ledger_daily_summary": runtime_daily_summary
                            }
                        ),
                    )
                )
            session.commit()

            status = build_doc29_completion_status(
                session=session,
                stale_after_seconds=86400,
                current_git_revision="abc123",
                current_image_digest="sha256:test",
            )

        canary_gate = next(
            item
            for item in status["gates"]
            if item["gate_id"] == DOC29_LIVE_CANARY_GATE
        )
        scale_gate = next(
            item for item in status["gates"] if item["gate_id"] == DOC29_LIVE_SCALE_GATE
        )
        self.assertEqual(canary_gate["status"], "satisfied")
        self.assertEqual(scale_gate["status"], "satisfied")
        self.assertEqual(
            len(scale_gate["db_row_refs"]["strategy_runtime_ledger_buckets"]),
            10,
        )
        self.assertEqual(
            scale_gate["runtime_ledger_summary"][
                "runtime_ledger_post_cost_expectancy_bps"
            ],
            1.4,
        )
        self.assertEqual(
            scale_gate["runtime_ledger_summary"][
                "runtime_ledger_observed_trading_day_count"
            ],
            25,
        )
        self.assertEqual(
            scale_gate["runtime_ledger_summary"][
                "runtime_ledger_mean_daily_net_pnl_after_costs"
            ],
            "24",
        )
        self.assertTrue(status["summary"]["all_satisfied"])
        self.assertTrue(status["promotion_authority"]["completion_trace_all_satisfied"])
        self.assertEqual(
            status["promotion_authority"]["authority_source"],
            "completion_trace_status_only",
        )
        self.assertFalse(status["promotion_authority"]["final_authority_ok"])
        self.assertFalse(status["promotion_authority"]["capital_promotion_allowed"])
        self.assertFalse(status["promotion_authority"]["promotion_allowed"])
        self.assertFalse(status["promotion_authority"]["final_promotion_allowed"])
        self.assertEqual(
            status["promotion_authority"]["final_promotion_blockers"],
            ["completion_trace_not_runtime_ledger_authority"],
        )

    def test_runtime_ledger_daily_summary_falls_back_to_bucket_rows(self) -> None:
        first = _runtime_ledger_bucket(
            run_id="fallback-day-1a",
            bucket_started_at=datetime(2026, 3, 6, 14, 30),
            bucket_ended_at=datetime(2026, 3, 6, 15, 0),
        )
        first.net_strategy_pnl_after_costs = Decimal("100")
        first.filled_notional = Decimal("1000")
        first.closed_trade_count = 2
        second = _runtime_ledger_bucket(
            run_id="fallback-day-1b",
            bucket_started_at=datetime(2026, 3, 6, 15, 0),
            bucket_ended_at=datetime(2026, 3, 6, 15, 30),
        )
        second.net_strategy_pnl_after_costs = Decimal("-130")
        second.filled_notional = Decimal("500")
        second.closed_trade_count = -2
        third = _runtime_ledger_bucket(
            run_id="fallback-day-2",
            bucket_started_at=datetime(2026, 3, 9, 14, 30),
            bucket_ended_at=datetime(2026, 3, 9, 15, 0),
        )
        third.net_strategy_pnl_after_costs = Decimal("10")
        third.filled_notional = Decimal("100")
        third.closed_trade_count = 0

        summary = _runtime_ledger_daily_summary([first, second, third])

        self.assertEqual(summary["runtime_ledger_observed_trading_day_count"], 2)
        self.assertEqual(
            summary["runtime_ledger_net_pnl_by_trading_day"],
            {"2026-03-06": "-30", "2026-03-09": "10"},
        )
        self.assertEqual(
            summary["runtime_ledger_mean_daily_net_pnl_after_costs"], "-10"
        )
        self.assertEqual(
            summary["runtime_ledger_median_daily_net_pnl_after_costs"], "-10"
        )
        self.assertEqual(summary["runtime_ledger_p10_daily_net_pnl_after_costs"], "-30")
        self.assertEqual(summary["runtime_ledger_worst_day_net_pnl_after_costs"], "-30")
        self.assertEqual(summary["runtime_ledger_max_intraday_drawdown"], "130")
        self.assertEqual(summary["runtime_ledger_avg_daily_filled_notional"], "800")
        self.assertEqual(
            summary["runtime_ledger_filled_notional_by_trading_day"],
            {"2026-03-06": "1500", "2026-03-09": "100"},
        )
        self.assertEqual(
            summary["runtime_ledger_closed_trade_count_by_day"],
            {"2026-03-06": 2, "2026-03-09": 0},
        )

    def test_runtime_ledger_bucket_summary_readback_blocks_empty_rows(self) -> None:
        summary = _runtime_ledger_bucket_summary([])

        readback = summary["runtime_ledger_profit_distance_readback"]
        self.assertEqual(readback["required_daily_net_pnl"], "500")
        self.assertEqual(readback["observed_mean_daily_net_pnl"], "0")
        self.assertEqual(readback["source_authority"]["bucket_count"], 0)
        self.assertIn("runtime_ledger_rows_missing", readback["blockers"])
        self.assertEqual(readback["authority_readback_state"], "blocked")

    def test_runtime_ledger_bucket_summary_readback_blocks_aggregate_only_rows(
        self,
    ) -> None:
        row = _runtime_ledger_bucket(
            run_id="aggregate-only",
            bucket_started_at=datetime(2026, 3, 6, 14, 30),
            bucket_ended_at=datetime(2026, 3, 6, 15, 0),
            payload_json={"source": "aggregate-window-import"},
        )
        row.net_strategy_pnl_after_costs = Decimal("800")

        summary = _runtime_ledger_bucket_summary([row])

        readback = summary["runtime_ledger_profit_distance_readback"]
        self.assertEqual(readback["observed_mean_daily_net_pnl"], "800")
        self.assertEqual(readback["source_authority"]["source_backed_bucket_count"], 0)
        self.assertEqual(readback["missing_to_target"]["daily_net_pnl"], "0")
        self.assertEqual(
            readback["missing_to_target"]["source_authority_bucket_count"],
            1,
        )
        self.assertIn("runtime_ledger_source_authority_blocked", readback["blockers"])
        self.assertEqual(readback["authority_readback_state"], "blocked")

    def test_runtime_ledger_bucket_summary_readback_reports_pnl_distance(
        self,
    ) -> None:
        row = _runtime_ledger_bucket(
            run_id="source-backed-insufficient",
            bucket_started_at=datetime(2026, 3, 6, 14, 30),
            bucket_ended_at=datetime(2026, 3, 6, 15, 0),
        )
        row.net_strategy_pnl_after_costs = Decimal("120")

        summary = _runtime_ledger_bucket_summary([row])

        readback = summary["runtime_ledger_profit_distance_readback"]
        self.assertEqual(readback["source_authority"]["source_backed_bucket_count"], 1)
        self.assertEqual(readback["observed_mean_daily_net_pnl"], "120")
        self.assertEqual(readback["missing_to_target"]["daily_net_pnl"], "380")
        self.assertEqual(
            readback["next_blocking_reason"],
            "runtime_ledger_mean_daily_net_pnl_after_costs_below_target",
        )

    def test_runtime_ledger_bucket_summary_readback_reports_close_to_target(
        self,
    ) -> None:
        row = _runtime_ledger_bucket(
            run_id="source-backed-close",
            bucket_started_at=datetime(2026, 3, 6, 14, 30),
            bucket_ended_at=datetime(2026, 3, 6, 15, 0),
        )
        row.net_strategy_pnl_after_costs = Decimal("499.99")

        summary = _runtime_ledger_bucket_summary([row])

        readback = summary["runtime_ledger_profit_distance_readback"]
        self.assertEqual(readback["observed_mean_daily_net_pnl"], "499.99")
        self.assertEqual(readback["missing_to_target"]["daily_net_pnl"], "0.01")
        self.assertEqual(readback["authority_readback_state"], "blocked")

    def test_runtime_ledger_bucket_summary_readback_satisfies_distance_when_source_backed(
        self,
    ) -> None:
        row = _runtime_ledger_bucket(
            run_id="source-backed-passing",
            bucket_started_at=datetime(2026, 3, 6, 14, 30),
            bucket_ended_at=datetime(2026, 3, 6, 15, 0),
        )
        row.net_strategy_pnl_after_costs = Decimal("620")
        row.filled_notional = Decimal("125000")
        row.closed_trade_count = 7

        summary = _runtime_ledger_bucket_summary([row])

        readback = summary["runtime_ledger_profit_distance_readback"]
        self.assertEqual(readback["observed_mean_daily_net_pnl"], "620")
        self.assertEqual(readback["missing_to_target"]["daily_net_pnl"], "0")
        self.assertEqual(readback["filled_notional"]["total"], "125000")
        self.assertEqual(readback["closed_trade_count"], 7)
        self.assertEqual(readback["open_position_count"], 0)
        self.assertEqual(readback["source_authority"]["source_backed_bucket_count"], 1)
        self.assertEqual(readback["blockers"], [])
        self.assertEqual(readback["authority_readback_state"], "distance_satisfied")

    def test_runtime_ledger_bucket_match_requires_full_event_time_containment(
        self,
    ) -> None:
        window = StrategyHypothesisMetricWindow(
            run_id="strict-window",
            candidate_id="cand-1",
            hypothesis_id="legacy_macd_rsi",
            observed_stage="live",
            window_started_at=datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc),
            window_ended_at=datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc),
        )

        overlapping = _runtime_ledger_bucket(
            run_id="strict-window",
            bucket_started_at=datetime(2026, 3, 6, 14, 45, tzinfo=timezone.utc),
            bucket_ended_at=datetime(2026, 3, 6, 15, 15, tzinfo=timezone.utc),
        )
        containing = _runtime_ledger_bucket(
            run_id="strict-window",
            bucket_started_at=datetime(2026, 3, 6, 14, 0, tzinfo=timezone.utc),
            bucket_ended_at=datetime(2026, 3, 6, 15, 30, tzinfo=timezone.utc),
        )
        missing_event_time = _runtime_ledger_bucket(
            run_id="strict-window",
            bucket_started_at=datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc),
            bucket_ended_at=datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc),
        )
        missing_event_time.bucket_started_at = None

        self.assertFalse(_runtime_ledger_bucket_matches_window(overlapping, window))
        self.assertTrue(_runtime_ledger_bucket_matches_window(containing, window))
        self.assertFalse(
            _runtime_ledger_bucket_matches_window(missing_event_time, window)
        )
