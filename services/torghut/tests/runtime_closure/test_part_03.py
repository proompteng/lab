from __future__ import annotations

# ruff: noqa: F401,F403,F405
from tests.runtime_closure.support import *


class TestRuntimeClosurePart3(_TestRuntimeClosureBase):
    def test_delay_adjusted_depth_stress_rejects_aggregate_depth_without_lob_reality_evidence(
        self,
    ) -> None:
        report = runtime_closure._delay_adjusted_depth_stress_report(
            runner_run_id="run-depth-no-lob-proof",
            best_candidate={
                "candidate_id": "cand-depth-no-lob-proof",
                "runtime_family": "microstructure_continuation",
                "runtime_strategy_name": "microbar-volume-continuation-long-v1",
            },
            approval_report={
                "objective_met": True,
                "summary": {
                    "trading_day_count": 2,
                    "net_pnl": "1600",
                    "daily_net": {
                        "2026-05-18": "800",
                        "2026-05-19": "800",
                    },
                    "daily_filled_notional": {
                        "2026-05-18": "300000",
                        "2026-05-19": "300000",
                    },
                    "daily_liquidity_notional": {
                        "2026-05-18": "1200000",
                        "2026-05-19": "1200000",
                    },
                },
                "scorecard": {"net_pnl_per_day": "800"},
            },
            program=_program(),
        )

        self.assertFalse(report["objective_met"])
        self.assertEqual(
            report["liquidity_input_source"], "recorded_liquidity_notional"
        )
        self.assertFalse(report["lob_execution_realism_evidence_present"])
        self.assertIn("lob_execution_realism_evidence_missing", report["reasons"])
        self.assertIn(
            "delay_adjusted_depth_lob_event_stream_evidence_missing",
            report["reasons"],
        )
        self.assertIn(
            "delay_adjusted_depth_fill_outcome_evidence_missing",
            report["reasons"],
        )

    def test_delay_adjusted_depth_stress_rejects_candidate_metadata_as_runtime_evidence(
        self,
    ) -> None:
        candidate_metadata = {
            "lob_event_stream_event_count": 160,
            "fill_outcome_count": 160,
            "live_paper_parity_status": "within_budget",
            "live_paper_parity_sample_count": 160,
            "live_paper_parity_max_fill_error_bps": "4",
            "live_paper_parity_max_adverse_selection_error_bps": "5",
            "implementation_trace_ref": "s3://proof/runtime-implementation-trace.json",
            "lob_event_stream_artifact_ref": "s3://proof/lob-events.json",
            "fill_outcomes_artifact_ref": "s3://proof/fill-outcomes.json",
            "simulation_live_parity_artifact_ref": "s3://proof/live-parity.json",
        }
        report = runtime_closure._delay_adjusted_depth_stress_report(
            runner_run_id="run-depth-candidate-metadata",
            best_candidate={
                "candidate_id": "cand-depth-candidate-metadata",
                "runtime_family": "microstructure_continuation",
                "runtime_strategy_name": "microbar-volume-continuation-long-v1",
                **candidate_metadata,
            },
            approval_report={
                "objective_met": True,
                "summary": {
                    "trading_day_count": 2,
                    "net_pnl": "1600",
                    "daily_net": {
                        "2026-05-18": "800",
                        "2026-05-19": "800",
                    },
                    "daily_filled_notional": {
                        "2026-05-18": "300000",
                        "2026-05-19": "300000",
                    },
                    "daily_liquidity_notional": {
                        "2026-05-18": "1200000",
                        "2026-05-19": "1200000",
                    },
                },
                "scorecard": {"net_pnl_per_day": "800", **candidate_metadata},
            },
            program=_program(),
        )

        self.assertFalse(report["objective_met"])
        self.assertFalse(report["lob_execution_realism_evidence_present"])
        self.assertEqual(report["lob_event_stream_event_count"], 0)
        self.assertEqual(report["fill_outcome_count"], 0)
        self.assertIn(
            "delay_adjusted_depth_lob_event_stream_evidence_missing",
            report["reasons"],
        )
        self.assertIn(
            "delay_adjusted_depth_fill_outcome_evidence_missing",
            report["reasons"],
        )

    def test_delay_adjusted_depth_stress_requires_explicit_parity_error_metrics(
        self,
    ) -> None:
        report = runtime_closure._delay_adjusted_depth_stress_report(
            runner_run_id="run-depth-missing-parity-errors",
            best_candidate={
                "candidate_id": "cand-depth-missing-parity-errors",
                "runtime_family": "microstructure_continuation",
                "runtime_strategy_name": "microbar-volume-continuation-long-v1",
            },
            approval_report={
                "objective_met": True,
                "summary": {
                    "trading_day_count": 2,
                    "net_pnl": "1600",
                    "daily_net": {
                        "2026-05-18": "800",
                        "2026-05-19": "800",
                    },
                    "daily_filled_notional": {
                        "2026-05-18": "300000",
                        "2026-05-19": "300000",
                    },
                    "daily_liquidity_notional": {
                        "2026-05-18": "1200000",
                        "2026-05-19": "1200000",
                    },
                    "daily_lob_event_stream_count": {
                        "2026-05-18": 80,
                        "2026-05-19": 80,
                    },
                    "daily_fill_outcome_count": {
                        "2026-05-18": 80,
                        "2026-05-19": 80,
                    },
                    "lob_event_stream_event_count": 160,
                    "fill_outcome_count": 160,
                    "live_paper_parity_status": "within_budget",
                    "live_paper_parity_sample_count": 160,
                    "implementation_trace_ref": "s3://proof/runtime-implementation-trace.json",
                    "lob_event_stream_artifact_ref": "s3://proof/lob-events.json",
                    "fill_outcomes_artifact_ref": "s3://proof/fill-outcomes.json",
                    "simulation_live_parity_artifact_ref": "s3://proof/live-parity.json",
                },
                "scorecard": {"net_pnl_per_day": "800"},
            },
            program=_program(),
        )

        self.assertFalse(report["objective_met"])
        self.assertFalse(report["live_paper_parity_evidence_present"])
        self.assertEqual(
            report["execution_realism_status"], "missing_required_evidence"
        )
        self.assertEqual(report["live_paper_parity_max_fill_error_bps"], "")
        self.assertIn(
            "delay_adjusted_depth_live_paper_parity_fill_error_evidence_missing",
            report["reasons"],
        )
        self.assertIn(
            "delay_adjusted_depth_live_paper_parity_adverse_selection_error_evidence_missing",
            report["reasons"],
        )

    def test_delay_adjusted_depth_stress_accepts_lob_reality_gap_evidence(
        self,
    ) -> None:
        report = runtime_closure._delay_adjusted_depth_stress_report(
            runner_run_id="run-depth-lob-proof",
            best_candidate={
                "candidate_id": "cand-depth-lob-proof",
                "runtime_family": "microstructure_continuation",
                "runtime_strategy_name": "microbar-volume-continuation-long-v1",
            },
            approval_report={
                "objective_met": True,
                "summary": {
                    "trading_day_count": 2,
                    "net_pnl": "1600",
                    "daily_net": {
                        "2026-05-18": "800",
                        "2026-05-19": "800",
                    },
                    "daily_filled_notional": {
                        "2026-05-18": "300000",
                        "2026-05-19": "300000",
                    },
                    "daily_liquidity_notional": {
                        "2026-05-18": "1200000",
                        "2026-05-19": "1200000",
                    },
                    "daily_lob_event_stream_count": {
                        "2026-05-18": 80,
                        "2026-05-19": 80,
                    },
                    "daily_fill_outcome_count": {
                        "2026-05-18": 80,
                        "2026-05-19": 80,
                    },
                    "lob_event_stream_event_count": 160,
                    "fill_outcome_count": 160,
                    "live_paper_parity_status": "within_budget",
                    "live_paper_parity_sample_count": 160,
                    "live_paper_parity_max_fill_error_bps": "4",
                    "live_paper_parity_max_adverse_selection_error_bps": "5",
                    "implementation_trace_ref": "s3://proof/runtime-implementation-trace.json",
                    "lob_event_stream_artifact_ref": "s3://proof/lob-events.json",
                    "fill_outcomes_artifact_ref": "s3://proof/fill-outcomes.json",
                    "simulation_live_parity_artifact_ref": "s3://proof/live-parity.json",
                },
                "scorecard": {"net_pnl_per_day": "800"},
            },
            program=_program(),
        )

        self.assertTrue(report["objective_met"])
        self.assertTrue(report["lob_execution_realism_evidence_present"])
        self.assertTrue(report["live_paper_parity_evidence_present"])
        self.assertEqual(report["lob_event_stream_event_count"], 160)
        self.assertEqual(report["fill_outcome_count"], 160)
        self.assertEqual(report["daily"][0]["lob_event_stream_count"], 80)
        self.assertEqual(report["daily"][0]["fill_outcome_count"], 80)
        self.assertIn(
            "lob_simulation_reality_gap_arxiv_2603_24137_2026",
            report["source_markers"],
        )

    def test_delay_adjusted_depth_stress_scales_net_when_recorded_depth_is_thin(
        self,
    ) -> None:
        report = runtime_closure._delay_adjusted_depth_stress_report(
            runner_run_id="run-depth-thin",
            best_candidate={
                "candidate_id": "cand-depth-thin",
                "runtime_family": "microstructure_continuation",
                "runtime_strategy_name": "microbar-volume-continuation-long-v1",
            },
            approval_report={
                "objective_met": True,
                "summary": {
                    "trading_day_count": 2,
                    "net_pnl": "1600",
                    "daily_net": {
                        "2026-05-18": "800",
                        "2026-05-19": "800",
                    },
                    "daily_filled_notional": {
                        "2026-05-18": "400000",
                        "2026-05-19": "400000",
                    },
                    "daily_liquidity_notional": {
                        "2026-05-18": "200000",
                        "2026-05-19": "200000",
                    },
                    "daily_lob_event_stream_count": {
                        "2026-05-18": 80,
                        "2026-05-19": 80,
                    },
                    "daily_fill_outcome_count": {
                        "2026-05-18": 80,
                        "2026-05-19": 80,
                    },
                    "lob_event_stream_event_count": 160,
                    "fill_outcome_count": 160,
                    "live_paper_parity_status": "within_budget",
                    "live_paper_parity_sample_count": 160,
                    "live_paper_parity_max_fill_error_bps": "4",
                    "live_paper_parity_max_adverse_selection_error_bps": "5",
                    "implementation_trace_ref": "s3://proof/runtime-implementation-trace.json",
                    "lob_event_stream_artifact_ref": "s3://proof/lob-events.json",
                    "fill_outcomes_artifact_ref": "s3://proof/fill-outcomes.json",
                    "simulation_live_parity_artifact_ref": "s3://proof/live-parity.json",
                },
                "scorecard": {"net_pnl_per_day": "800"},
            },
            program=_program(),
        )

        self.assertFalse(report["objective_met"])
        self.assertEqual(
            report["liquidity_input_source"], "recorded_liquidity_notional"
        )
        self.assertEqual(report["recorded_liquidity_day_count"], 2)
        self.assertEqual(report["missing_liquidity_days"], 0)
        self.assertEqual(report["fillable_notional_per_day"], "150000")
        self.assertEqual(report["unfillable_notional"], "500000")
        self.assertEqual(report["daily"][0]["fillable_ratio"], "0.375")
        self.assertTrue(report["lob_execution_realism_evidence_present"])
        self.assertEqual(report["worst_active_day_fillable_notional"], "150000")
        self.assertEqual(report["p10_active_day_fillable_notional"], "150000")
        self.assertFalse(report["tail_coverage_passed"])
        self.assertEqual(report["post_delay_depth_net_pnl_per_day"], "112.5")
        self.assertIn(
            "delay_adjusted_depth_fillable_notional_below_minimum",
            report["reasons"],
        )
        self.assertIn(
            "delay_adjusted_depth_tail_fillable_notional_below_minimum",
            report["reasons"],
        )
        self.assertIn(
            "delay_adjusted_depth_stress_net_pnl_below_target",
            report["reasons"],
        )

    def test_double_oos_walkforward_report_fails_closed_on_missing_or_weak_windows(
        self,
    ) -> None:
        self.assertEqual(
            runtime_closure._runtime_replay_net_pnl_per_day(
                {"summary": {"net_pnl": "1000", "trading_day_count": 2}}
            ),
            Decimal("500"),
        )
        self.assertEqual(
            runtime_closure._runtime_replay_net_pnl_per_day(
                {"summary": {"net_pnl": "1000", "trading_day_count": 0}}
            ),
            Decimal("0"),
        )
        weak_window = runtime_closure._double_oos_window_row(
            window_id="approval",
            report={
                "objective_met": False,
                "summary": {
                    "net_pnl": "100",
                    "trading_day_count": 0,
                    "decision_count": 1,
                    "filled_count": 1,
                },
            },
            target_net_pnl_per_day=Decimal("500"),
        )
        self.assertFalse(weak_window["passed"])
        self.assertEqual(
            weak_window["reasons"],
            [
                "approval_objective_not_met",
                "approval_net_pnl_below_target",
                "approval_trading_days_missing",
            ],
        )

        report = runtime_closure._double_oos_walkforward_report(
            runner_run_id="run-double-oos",
            best_candidate={
                "candidate_id": "cand-double-oos",
                "runtime_family": "breakout_continuation_consistent",
                "runtime_strategy_name": "breakout-continuation-long-v1",
            },
            parity_report={
                "objective_met": False,
                "summary": {"net_pnl": "400", "trading_day_count": 2},
            },
            approval_report=None,
            market_impact_report=None,
            delay_depth_report=None,
            program=_program(),
        )

        self.assertFalse(report["objective_met"])
        self.assertEqual(report["independent_window_count"], 1)
        self.assertIn(
            "double_oos_independent_window_count_below_minimum", report["reasons"]
        )
        self.assertIn("double_oos_pass_rate_below_required", report["reasons"])
        self.assertIn("double_oos_net_pnl_below_target", report["reasons"])
        self.assertIn("market_impact_stress_missing", report["reasons"])
        self.assertIn("delay_adjusted_depth_stress_missing", report["reasons"])

    def test_write_runtime_closure_bundle_keeps_pending_parity_when_execution_skipped(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            run_root = Path(tmpdir)
            manifest = build_mlx_snapshot_manifest(
                runner_run_id="run-1",
                program=_program(),
                symbols="AMAT,NVDA",
                train_days=6,
                holdout_days=2,
                full_window_start_date="2026-03-20",
                full_window_end_date="2026-04-09",
            )
            configmap_path = run_root / "strategy-configmap.yaml"
            configmap_path.write_text(
                """
apiVersion: v1
kind: ConfigMap
data:
  strategies.yaml: |
    strategies:
      - name: breakout-continuation-long-v1
        enabled: true
        family: breakout_continuation_consistent
        params:
          max_entries_per_session: '1'
""".strip()
                + "\n",
                encoding="utf-8",
            )
            program = StrategyAutoresearchProgram(
                **{
                    **_program().__dict__,
                    "runtime_closure_policy": RuntimeClosurePolicy(
                        enabled=True,
                        execute_parity_replay=False,
                        execute_approval_replay=False,
                        parity_window="full_window",
                        approval_window="holdout",
                        shadow_validation_mode="skip",
                        promotion_target="shadow",
                    ),
                }
            )
            best_candidate = {
                "candidate_id": "cand-1",
                "family_template_id": "breakout_reclaim_v2",
                "runtime_family": "breakout_continuation_consistent",
                "runtime_strategy_name": "breakout-continuation-long-v1",
                "status": "keep",
                "candidate_params": {"max_entries_per_session": "1"},
                "candidate_strategy_overrides": {},
                "disable_other_strategies": True,
                "full_window_start_date": "2026-03-20",
                "full_window_end_date": "2026-04-09",
            }

            summary = write_runtime_closure_bundle(
                run_root=run_root,
                runner_run_id="run-1",
                program=program,
                best_candidate=best_candidate,
                manifest=manifest,
                execution_context=RuntimeClosureExecutionContext(
                    strategy_configmap_path=configmap_path,
                    clickhouse_http_url="http://example.invalid:8123",
                    clickhouse_username="torghut",
                    clickhouse_password="secret",
                    start_equity=Decimal("31590.02"),
                    chunk_minutes=10,
                ),
            )

            self.assertEqual(summary.status, "pending_runtime_parity")
            self.assertEqual(
                summary.next_required_steps,
                ("scheduler_v3_parity_replay", "scheduler_v3_approval_replay"),
            )
            self.assertEqual(
                summary.shadow_validation_path,
                str(
                    run_root
                    / "runtime-closure"
                    / "replay"
                    / "shadow-validation-plan.json"
                ),
            )

    def test_write_runtime_closure_bundle_skips_shadow_status_when_shadow_not_required(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            run_root = Path(tmpdir)
            manifest = build_mlx_snapshot_manifest(
                runner_run_id="run-1",
                program=_program(),
                symbols="AMAT,NVDA",
                train_days=6,
                holdout_days=2,
                full_window_start_date="2026-03-20",
                full_window_end_date="2026-04-09",
            )
            configmap_path = run_root / "strategy-configmap.yaml"
            configmap_path.write_text(
                """
apiVersion: v1
kind: ConfigMap
data:
  strategies.yaml: |
    strategies:
      - name: breakout-continuation-long-v1
        enabled: true
        family: breakout_continuation_consistent
        params:
          max_entries_per_session: '1'
        universe_symbols:
          - AMAT
          - NVDA
""".strip()
                + "\n",
                encoding="utf-8",
            )
            program = StrategyAutoresearchProgram(
                **{
                    **_program().__dict__,
                    "objective": StrategyObjective(
                        target_net_pnl_per_day=Decimal("500"),
                        min_active_day_ratio=Decimal("1.0"),
                        min_positive_day_ratio=Decimal("0.6"),
                        min_daily_notional=Decimal("300000"),
                        max_best_day_share=Decimal("0.3"),
                        max_worst_day_loss=Decimal("350"),
                        max_drawdown=Decimal("900"),
                        require_every_day_active=True,
                        min_regime_slice_pass_rate=Decimal("0"),
                        stop_when_objective_met=True,
                    ),
                    "runtime_closure_policy": RuntimeClosurePolicy(
                        enabled=True,
                        execute_parity_replay=True,
                        execute_approval_replay=True,
                        parity_window="full_window",
                        approval_window="holdout",
                        shadow_validation_mode="skip",
                        promotion_target="shadow",
                    ),
                }
            )
            best_candidate = {
                "candidate_id": "cand-1",
                "family_template_id": "breakout_reclaim_v2",
                "runtime_family": "breakout_continuation_consistent",
                "runtime_strategy_name": "breakout-continuation-long-v1",
                "status": "keep",
                "candidate_params": {"max_entries_per_session": "1"},
                "candidate_strategy_overrides": {"universe_symbols": ["AMAT", "NVDA"]},
                "disable_other_strategies": True,
                "holdout_start_date": "2026-04-08",
                "holdout_end_date": "2026-04-09",
                "full_window_start_date": "2026-03-20",
                "full_window_end_date": "2026-04-09",
                "normalization_regime": "price_scaled",
            }
            replay_payload = {
                "start_date": "2026-03-20",
                "end_date": "2026-04-09",
                "net_pnl": "6000",
                "decision_count": 12,
                "filled_count": 9,
                "wins": 7,
                "losses": 2,
                "daily": {
                    "2026-03-20": {
                        "net_pnl": "1000",
                        "filled_count": 1,
                        "filled_notional": "300000",
                    },
                    "2026-03-21": {
                        "net_pnl": "800",
                        "filled_count": 1,
                        "filled_notional": "300000",
                    },
                    "2026-03-24": {
                        "net_pnl": "700",
                        "filled_count": 1,
                        "filled_notional": "300000",
                    },
                    "2026-03-25": {
                        "net_pnl": "900",
                        "filled_count": 1,
                        "filled_notional": "300000",
                    },
                    "2026-03-26": {
                        "net_pnl": "1100",
                        "filled_count": 1,
                        "filled_notional": "300000",
                    },
                    "2026-03-27": {
                        "net_pnl": "600",
                        "filled_count": 1,
                        "filled_notional": "300000",
                    },
                    "2026-04-08": {
                        "net_pnl": "500",
                        "filled_count": 1,
                        "filled_notional": "300000",
                    },
                    "2026-04-09": {
                        "net_pnl": "400",
                        "filled_count": 1,
                        "filled_notional": "300000",
                    },
                },
            }

            def _fake_replay_executor(_: object) -> dict[str, object]:
                return dict(replay_payload)

            summary = write_runtime_closure_bundle(
                run_root=run_root,
                runner_run_id="run-1",
                program=program,
                best_candidate=best_candidate,
                manifest=manifest,
                execution_context=RuntimeClosureExecutionContext(
                    strategy_configmap_path=configmap_path,
                    clickhouse_http_url="http://example.invalid:8123",
                    clickhouse_username="torghut",
                    clickhouse_password="secret",
                    start_equity=Decimal("31590.02"),
                    chunk_minutes=10,
                    symbols=("AMAT", "NVDA"),
                    progress_log_interval_seconds=30,
                ),
                replay_executor=_fake_replay_executor,
            )

            self.assertEqual(summary.status, "ready_for_promotion_review")
            self.assertEqual(summary.next_required_steps, ("promotion_review",))
