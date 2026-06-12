from __future__ import annotations

# ruff: noqa: F401,F403,F405
from tests.runtime_closure.support import *


class TestRuntimeClosurePart2(_TestRuntimeClosureBase):
    def test_runtime_closure_accepts_portfolio_spec_and_requires_optimizer_evidence(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            run_root = Path(tmpdir)
            manifest = build_mlx_snapshot_manifest(
                runner_run_id="run-1",
                program=_program(),
                symbols="AAPL,NVDA",
                train_days=6,
                holdout_days=2,
                full_window_start_date="2026-03-20",
                full_window_end_date="2026-04-09",
            )
            portfolio = PortfolioCandidateSpec(
                schema_version=PORTFOLIO_CANDIDATE_SCHEMA_VERSION,
                portfolio_candidate_id="portfolio-direct",
                source_candidate_ids=("cand-a", "cand-b"),
                target_net_pnl_per_day=Decimal("500"),
                sleeves=(
                    {
                        "candidate_id": "cand-a",
                        "candidate_spec_id": "spec-a",
                        "runtime_family": "momentum_pullback_consistent",
                        "runtime_strategy_name": "momentum-pullback-long-v1",
                        "weight": "0.55",
                        "expected_net_pnl_per_day": "310",
                        "correlation_cluster": "momentum",
                    },
                    {
                        "candidate_id": "cand-b",
                        "candidate_spec_id": "spec-b",
                        "runtime_family": "washout_rebound_consistent",
                        "runtime_strategy_name": "washout-rebound-long-v1",
                        "weight": "0.45",
                        "expected_net_pnl_per_day": "245",
                        "correlation_cluster": "rebound",
                    },
                ),
                capital_budget={"mode": "equal_weight_initial", "max_sleeves": 4},
                correlation_budget={
                    "max_cluster_contribution_share": "0.40",
                    "max_single_symbol_contribution_share": "0.35",
                },
                drawdown_budget={"max_drawdown": "400"},
                evidence_refs=("evidence-a", "evidence-b"),
                objective_scorecard={
                    "net_pnl_per_day": "555",
                    "target_met": True,
                    "oracle_passed": True,
                    "active_day_ratio": "1.0",
                    "positive_day_ratio": "0.8",
                    "best_day_share": "0.22",
                    "worst_day_loss": "120",
                    "max_drawdown": "400",
                },
                optimizer_report={
                    "method": "deterministic_greedy_pareto_v1",
                    "selected_count": 2,
                    "target_met": True,
                    "oracle_passed": True,
                },
            )

            summary = write_runtime_closure_bundle(
                run_root=run_root,
                runner_run_id="run-1",
                program=_program(),
                best_candidate=portfolio,
                manifest=manifest,
            )

            self.assertEqual(summary.status, "pending_runtime_parity")
            self.assertTrue(Path(summary.portfolio_optimizer_evidence_path).exists())
            self.assertTrue(Path(summary.portfolio_proof_receipt_path).exists())
            portfolio_proof = json.loads(
                Path(summary.portfolio_proof_receipt_path).read_text(encoding="utf-8")
            )
            self.assertEqual(
                portfolio_proof["payload"]["portfolio_candidate_id"],
                "portfolio-direct",
            )
            candidate_spec = json.loads(
                Path(summary.candidate_spec_path).read_text(encoding="utf-8")
            )
            self.assertEqual(candidate_spec["candidate_id"], "portfolio-direct")
            self.assertEqual(
                candidate_spec["portfolio_optimizer_evidence"][
                    "portfolio_candidate_id"
                ],
                "portfolio-direct",
            )
            gate_report = json.loads(
                Path(summary.gate_report_path).read_text(encoding="utf-8")
            )
            self.assertEqual(
                gate_report["promotion_evidence"]["portfolio_optimizer"][
                    "artifact_ref"
                ],
                "promotion/portfolio-optimizer-evidence.json",
            )
            self.assertEqual(
                gate_report["promotion_evidence"]["portfolio_proof"]["artifact_ref"],
                "promotion/portfolio-proof-receipt.json",
            )
            prerequisites = summary.promotion_prerequisites
            self.assertIn(
                "promotion/portfolio-optimizer-evidence.json",
                prerequisites["required_artifacts"],
            )
            self.assertIn(
                str(Path(summary.portfolio_optimizer_evidence_path)),
                prerequisites["artifact_refs"],
            )
            self.assertNotIn(
                "portfolio_optimizer_evidence_missing", prerequisites["reasons"]
            )

    def test_replay_analysis_records_decomposition_errors(self) -> None:
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
        best_candidate = {
            "candidate_id": "cand-1",
            "family_template_id": "breakout_reclaim_v2",
            "runtime_family": "breakout_continuation_consistent",
            "runtime_strategy_name": "breakout-continuation-long-v1",
            "normalization_regime": "price_scaled",
        }

        with patch.object(
            runtime_closure,
            "build_replay_decomposition",
            side_effect=RuntimeError("boom"),
        ):
            analysis = runtime_closure._replay_analysis(
                window_name="full_window",
                replay_payload=replay_payload,
                best_candidate=best_candidate,
                program=_program(),
            )

        self.assertEqual(analysis["decomposition_error"], "boom")
        self.assertIsNone(analysis["decomposition"])

    def test_write_runtime_closure_bundle_emits_fail_closed_governance_artifacts(
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
                row_counts={"receipt_count": 1, "signal_row_count": 42},
            )
            best_candidate = {
                "candidate_id": "cand-1",
                "family_template_id": "breakout_reclaim_v2",
                "runtime_family": "breakout_continuation_consistent",
                "runtime_strategy_name": "breakout-continuation-long-v1",
                "objective_scope": "research_only",
                "objective_met": True,
                "status": "keep",
                "mutation_label": "seed",
                "descriptor_id": "desc-1",
                "entry_window_start_minute": 45,
                "entry_window_end_minute": 75,
                "max_hold_minutes": 30,
                "rank_count": 1,
                "requires_prev_day_features": True,
                "requires_cross_sectional_features": True,
                "requires_quote_quality_gate": True,
                "net_pnl_per_day": "620",
                "active_day_ratio": "0.85",
                "positive_day_ratio": "0.60",
                "best_day_share": "0.30",
                "worst_day_loss": "300",
                "max_drawdown": "850",
                "proposal_score": 12.0,
                "proposal_rank": 1,
                "promotion_status": "blocked_pending_runtime_parity",
                "promotion_stage": "research_candidate",
                "promotion_reason": "still blocked",
                "promotion_blockers": [
                    "scheduler_v3_parity_missing",
                    "scheduler_v3_approval_missing",
                    "shadow_validation_missing",
                ],
                "promotion_required_evidence": [
                    "checked_in_runtime_family",
                    "scheduler_v3_parity_replay",
                    "scheduler_v3_approval_replay",
                    "live_shadow_validation",
                ],
            }

            summary = write_runtime_closure_bundle(
                run_root=run_root,
                runner_run_id="run-1",
                program=_program(),
                best_candidate=best_candidate,
                manifest=manifest,
            )

            self.assertEqual(summary.status, "pending_runtime_parity")
            self.assertFalse(summary.promotion_prerequisites["allowed"])
            self.assertFalse(summary.rollback_readiness["ready"])
            self.assertIn("scheduler_v3_parity_replay", summary.next_required_steps)
            self.assertTrue(Path(summary.candidate_spec_path).exists())
            self.assertTrue(Path(summary.promotion_prerequisites_path).exists())
            self.assertTrue(Path(summary.profitability_stage_manifest_path).exists())

            manifest_payload = json.loads(
                Path(summary.profitability_stage_manifest_path).read_text(
                    encoding="utf-8"
                )
            )
            self.assertEqual(manifest_payload["candidate_id"], "cand-1")
            self.assertEqual(manifest_payload["overall_status"], "fail")
            self.assertIn(
                "validation_stage_incomplete", manifest_payload["failure_reasons"]
            )
            self.assertEqual(manifest_payload["run_context"]["run_id"], "run-1")
            self.assertEqual(
                manifest_payload["run_context"]["design_doc"],
                "docs/torghut/design-system/v6/71-torghut-whitepaper-autoresearch-profit-target-strategy-factory-2026-04-21.md",
            )
            self.assertEqual(
                manifest_payload["run_context"]["head"],
                subprocess.run(
                    ["git", "rev-parse", "--abbrev-ref", "HEAD"],
                    cwd=_REPO_ROOT,
                    check=True,
                    capture_output=True,
                    text=True,
                ).stdout.strip(),
            )

    def test_write_runtime_closure_bundle_executes_runtime_replays_when_enabled(
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
                row_counts={"receipt_count": 1, "signal_row_count": 42},
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
            program = _program()
            program = StrategyAutoresearchProgram(
                **{
                    **program.__dict__,
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
                        shadow_validation_mode="require_live_evidence",
                        promotion_target="shadow",
                    ),
                }
            )
            best_candidate = {
                "candidate_id": "cand-1",
                "family_template_id": "breakout_reclaim_v2",
                "runtime_family": "breakout_continuation_consistent",
                "runtime_strategy_name": "breakout-continuation-long-v1",
                "objective_scope": "research_only",
                "objective_met": True,
                "status": "keep",
                "mutation_label": "seed",
                "descriptor_id": "desc-1",
                "entry_window_start_minute": 45,
                "entry_window_end_minute": 75,
                "max_hold_minutes": 30,
                "rank_count": 1,
                "requires_prev_day_features": True,
                "requires_cross_sectional_features": True,
                "requires_quote_quality_gate": True,
                "net_pnl_per_day": "620",
                "active_day_ratio": "0.85",
                "positive_day_ratio": "0.60",
                "best_day_share": "0.30",
                "worst_day_loss": "300",
                "max_drawdown": "850",
                "proposal_score": 12.0,
                "proposal_rank": 1,
                "promotion_status": "blocked_pending_runtime_parity",
                "promotion_stage": "research_candidate",
                "promotion_reason": "still blocked",
                "promotion_blockers": [
                    "scheduler_v3_parity_missing",
                    "scheduler_v3_approval_missing",
                    "shadow_validation_missing",
                ],
                "promotion_required_evidence": [
                    "checked_in_runtime_family",
                    "scheduler_v3_parity_replay",
                    "scheduler_v3_approval_replay",
                    "live_shadow_validation",
                ],
                "candidate_params": {"max_entries_per_session": "1"},
                "candidate_strategy_overrides": {"universe_symbols": ["AMAT", "NVDA"]},
                "disable_other_strategies": True,
                "train_start_date": "2026-03-20",
                "train_end_date": "2026-03-27",
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
                "execution_realism": {
                    "daily_lob_event_stream_count": {
                        "2026-03-20": 40,
                        "2026-03-21": 40,
                        "2026-03-24": 40,
                        "2026-03-25": 40,
                        "2026-03-26": 40,
                        "2026-03-27": 40,
                        "2026-04-08": 40,
                        "2026-04-09": 40,
                    },
                    "daily_fill_outcome_count": {
                        "2026-03-20": 40,
                        "2026-03-21": 40,
                        "2026-03-24": 40,
                        "2026-03-25": 40,
                        "2026-03-26": 40,
                        "2026-03-27": 40,
                        "2026-04-08": 40,
                        "2026-04-09": 40,
                    },
                    "lob_event_stream_event_count": 320,
                    "fill_outcome_count": 320,
                    "live_paper_parity_status": "within_budget",
                    "live_paper_parity_sample_count": 160,
                    "live_paper_parity_max_fill_error_bps": "3.5",
                    "live_paper_parity_max_adverse_selection_error_bps": "4.0",
                    "implementation_trace_ref": "s3://proof/runtime-implementation-trace.json",
                    "lob_event_stream_artifact_ref": "s3://proof/lob-events.json",
                    "fill_outcomes_artifact_ref": "s3://proof/fill-outcomes.json",
                    "simulation_live_parity_artifact_ref": "s3://proof/live-parity.json",
                },
                "daily": {
                    "2026-03-20": {
                        "net_pnl": "1000",
                        "filled_count": 1,
                        "filled_notional": "300000",
                        "adv_notional": "3000000",
                    },
                    "2026-03-21": {
                        "net_pnl": "800",
                        "filled_count": 1,
                        "filled_notional": "300000",
                        "adv_notional": "3000000",
                    },
                    "2026-03-24": {
                        "net_pnl": "700",
                        "filled_count": 1,
                        "filled_notional": "300000",
                        "adv_notional": "3000000",
                    },
                    "2026-03-25": {
                        "net_pnl": "900",
                        "filled_count": 1,
                        "filled_notional": "300000",
                        "adv_notional": "3000000",
                    },
                    "2026-03-26": {
                        "net_pnl": "1100",
                        "filled_count": 1,
                        "filled_notional": "300000",
                        "adv_notional": "3000000",
                    },
                    "2026-03-27": {
                        "net_pnl": "600",
                        "filled_count": 1,
                        "filled_notional": "300000",
                        "adv_notional": "3000000",
                    },
                    "2026-04-08": {
                        "net_pnl": "500",
                        "filled_count": 1,
                        "filled_notional": "300000",
                        "adv_notional": "3000000",
                    },
                    "2026-04-09": {
                        "net_pnl": "400",
                        "filled_count": 1,
                        "filled_notional": "300000",
                        "adv_notional": "3000000",
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

            self.assertEqual(summary.status, "pending_shadow_validation")
            self.assertTrue(Path(summary.candidate_configmap_path).exists())
            self.assertTrue(Path(summary.parity_replay_path).exists())
            self.assertTrue(Path(summary.approval_replay_path).exists())
            self.assertTrue(Path(summary.market_impact_stress_report_path).exists())
            self.assertTrue(
                Path(summary.delay_adjusted_depth_stress_report_path).exists()
            )
            self.assertTrue(Path(summary.stress_metrics_path).exists())
            self.assertTrue(Path(summary.shadow_validation_path).exists())
            self.assertIn("live_shadow_validation", summary.next_required_steps)

            parity_report = json.loads(
                Path(summary.parity_report_path).read_text(encoding="utf-8")
            )
            self.assertTrue(parity_report["objective_met"])
            self.assertEqual(parity_report["window_name"], "full_window")
            market_impact_report = json.loads(
                Path(summary.market_impact_stress_report_path).read_text(
                    encoding="utf-8"
                )
            )
            self.assertEqual(market_impact_report["model"], "square_root")
            self.assertGreater(Decimal(market_impact_report["impact_cost_bps"]), 0)
            delay_depth_report = json.loads(
                Path(summary.delay_adjusted_depth_stress_report_path).read_text(
                    encoding="utf-8"
                )
            )
            self.assertEqual(delay_depth_report["model"], "latency_depth_haircut")
            self.assertGreater(delay_depth_report["case_count"], 0)
            self.assertEqual(
                delay_depth_report["stress_case_count"],
                len(delay_depth_report["daily"]),
            )
            self.assertIn("generated_at", delay_depth_report)
            self.assertIn("checked_at", delay_depth_report)
            self.assertIn("report_id", delay_depth_report)
            self.assertGreater(Decimal(delay_depth_report["delay_depth_cost_bps"]), 0)
            self.assertTrue(
                delay_depth_report["lob_execution_realism_evidence_present"]
            )
            self.assertEqual(delay_depth_report["lob_event_stream_event_count"], 320)
            self.assertEqual(delay_depth_report["fill_outcome_count"], 320)
            self.assertEqual(
                delay_depth_report["live_paper_parity_status"], "within_budget"
            )
            self.assertEqual(delay_depth_report["live_paper_parity_sample_count"], 160)
            self.assertEqual(
                delay_depth_report["daily"][0]["lob_event_stream_count"], 40
            )
            self.assertEqual(delay_depth_report["daily"][0]["fill_outcome_count"], 40)
            stress_metrics = json.loads(
                Path(summary.stress_metrics_path).read_text(encoding="utf-8")
            )
            self.assertEqual(stress_metrics["schema_version"], "stress-metrics-v1")
            self.assertGreaterEqual(stress_metrics["count"], 4)
            double_oos = json.loads(
                Path(summary.double_oos_report_path).read_text(encoding="utf-8")
            )
            self.assertEqual(
                double_oos["schema_version"],
                "torghut.double-oos-walkforward-report.v1",
            )
            self.assertEqual(double_oos["independent_window_count"], 2)
            self.assertEqual(len(double_oos["fold_metrics"]), 2)
            self.assertEqual(
                double_oos["source_markers"][0],
                "double_oos_walkforward_arxiv_2602_10785_2026",
            )

            stage_manifest = json.loads(
                Path(summary.profitability_stage_manifest_path).read_text(
                    encoding="utf-8"
                )
            )
            self.assertIn(
                "market_impact_stress",
                stage_manifest["stages"]["validation"]["artifacts"],
            )
            self.assertIn(
                "delay_adjusted_depth_stress",
                stage_manifest["stages"]["validation"]["artifacts"],
            )
            self.assertIn(
                "stress_metrics",
                stage_manifest["stages"]["validation"]["artifacts"],
            )
            self.assertIn(
                "double_oos_walkforward",
                stage_manifest["stages"]["validation"]["artifacts"],
            )

    def test_market_impact_stress_report_passes_only_after_square_root_cost(
        self,
    ) -> None:
        report = runtime_closure._market_impact_stress_report(
            runner_run_id="run-impact",
            best_candidate={
                "candidate_id": "cand-impact",
                "runtime_family": "breakout_continuation_consistent",
                "runtime_strategy_name": "breakout-continuation-long-v1",
            },
            approval_report={
                "objective_met": True,
                "summary": {
                    "trading_day_count": 2,
                    "net_pnl": "2400",
                    "daily_net": {
                        "2026-05-18": "1200",
                        "2026-05-19": "1200",
                    },
                    "daily_filled_notional": {
                        "2026-05-18": "300000",
                        "2026-05-19": "300000",
                    },
                    "daily_liquidity_notional": {
                        "2026-05-18": "3000000",
                        "2026-05-19": "3000000",
                    },
                },
                "scorecard": {"net_pnl_per_day": "1200"},
            },
            program=_program(),
        )

        self.assertTrue(report["objective_met"])
        self.assertEqual(report["model"], "square_root")
        self.assertTrue(report["liquidity_evidence_present"])
        self.assertEqual(
            report["liquidity_input_source"], "recorded_liquidity_notional"
        )
        self.assertGreater(Decimal(report["impact_cost_bps"]), Decimal("1"))
        self.assertGreaterEqual(
            Decimal(report["post_impact_net_pnl_per_day"]), Decimal("500")
        )

    def test_market_impact_stress_report_fails_without_real_liquidity_evidence(
        self,
    ) -> None:
        report = runtime_closure._market_impact_stress_report(
            runner_run_id="run-impact",
            best_candidate={
                "candidate_id": "cand-impact",
                "runtime_family": "breakout_continuation_consistent",
                "runtime_strategy_name": "breakout-continuation-long-v1",
            },
            approval_report={
                "objective_met": True,
                "summary": {
                    "trading_day_count": 2,
                    "net_pnl": "2400",
                    "daily_net": {
                        "2026-05-18": "1200",
                        "2026-05-19": "1200",
                    },
                    "daily_filled_notional": {
                        "2026-05-18": "300000",
                        "2026-05-19": "300000",
                    },
                },
                "scorecard": {"net_pnl_per_day": "1200"},
            },
            program=_program(),
        )

        self.assertFalse(report["objective_met"])
        self.assertFalse(report["liquidity_evidence_present"])
        self.assertEqual(report["liquidity_input_source"], "synthetic_proxy")
        self.assertIn(
            "market_impact_stress_liquidity_evidence_missing", report["reasons"]
        )

    def test_delay_adjusted_depth_stress_report_blocks_no_delay_fill_assumption(
        self,
    ) -> None:
        report = runtime_closure._delay_adjusted_depth_stress_report(
            runner_run_id="run-depth-delay",
            best_candidate={
                "candidate_id": "cand-depth-delay",
                "runtime_family": "microstructure_continuation",
                "runtime_strategy_name": "microbar-volume-continuation-long-v1",
            },
            approval_report={
                "objective_met": True,
                "summary": {
                    "trading_day_count": 2,
                    "net_pnl": "1100",
                    "daily_net": {
                        "2026-05-18": "550",
                        "2026-05-19": "550",
                    },
                    "daily_filled_notional": {
                        "2026-05-18": "300000",
                        "2026-05-19": "300000",
                    },
                },
                "scorecard": {"net_pnl_per_day": "550"},
            },
            program=_program(),
        )

        self.assertFalse(report["objective_met"])
        self.assertEqual(report["model"], "latency_depth_haircut")
        self.assertEqual(report["stress_delay_ms"], "250")
        self.assertEqual(report["liquidity_input_source"], "missing_recorded_liquidity")
        self.assertEqual(report["recorded_liquidity_day_count"], 0)
        self.assertEqual(report["missing_liquidity_days"], 2)
        self.assertEqual(report["unfillable_notional"], "600000")
        self.assertEqual(report["fillable_notional_per_day"], "0")
        self.assertEqual(report["worst_active_day_fillable_notional"], "0")
        self.assertEqual(report["p10_active_day_fillable_notional"], "0")
        self.assertFalse(report["tail_coverage_passed"])
        self.assertEqual(report["post_delay_depth_net_pnl_per_day"], "0")
        self.assertIn(
            "delay_adjusted_depth_stress_liquidity_evidence_missing",
            report["reasons"],
        )
        self.assertIn(
            "delay_adjusted_depth_lob_event_stream_evidence_missing",
            report["reasons"],
        )
        self.assertIn(
            "delay_adjusted_depth_fill_outcome_evidence_missing",
            report["reasons"],
        )
        self.assertIn(
            "delay_adjusted_depth_live_paper_parity_evidence_missing",
            report["reasons"],
        )
        self.assertIn(
            "delay_adjusted_depth_live_paper_parity_sample_count_below_minimum",
            report["reasons"],
        )
        self.assertIn("lob_execution_realism_evidence_missing", report["reasons"])
        self.assertIn(
            "delay_adjusted_depth_tail_fillable_notional_below_minimum",
            report["reasons"],
        )
        self.assertTrue(all(row["fillable_notional"] == "0" for row in report["daily"]))
