from __future__ import annotations

from tests.runtime_closure.support import (
    json,
    Decimal,
    Path,
    TemporaryDirectory,
    RuntimeClosurePolicy,
    StrategyAutoresearchProgram,
    StrategyObjective,
    build_mlx_snapshot_manifest,
    RuntimeClosureExecutionContext,
    write_runtime_closure_bundle,
    _program,
    _TestRuntimeClosureBase,
)


class TestRuntimeClosureShadowArtifacts(_TestRuntimeClosureBase):
    def test_write_runtime_closure_bundle_consumes_within_budget_shadow_artifact(
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
            shadow_artifact_path = run_root / "shadow-live-deviation-report.json"
            shadow_artifact_path.write_text(
                json.dumps(
                    {
                        "schema_version": "shadow-live-deviation-report-v1",
                        "status": "within_budget",
                        "order_count": 12,
                        "coverage_error": "0.02",
                    }
                )
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
                    shadow_validation_artifact_path=shadow_artifact_path,
                ),
                replay_executor=_fake_replay_executor,
            )

            self.assertEqual(summary.status, "ready_for_promotion_review")
            shadow_payload = json.loads(
                Path(summary.shadow_validation_path).read_text(encoding="utf-8")
            )
            self.assertEqual(shadow_payload["status"], "within_budget")
            self.assertTrue(shadow_payload["evidence_loaded"])
            self.assertEqual(
                shadow_payload["source_artifact_path"], str(shadow_artifact_path)
            )

    def test_write_runtime_closure_bundle_fails_when_shadow_artifact_is_out_of_budget(
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
            shadow_artifact_path = run_root / "shadow-live-deviation-report.json"
            shadow_artifact_path.write_text(
                json.dumps(
                    {
                        "schema_version": "shadow-live-deviation-report-v1",
                        "status": "out_of_budget",
                        "order_count": 12,
                        "coverage_error": "0.09",
                    }
                )
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
                "status": "keep",
                "candidate_params": {"max_entries_per_session": "1"},
                "candidate_strategy_overrides": {},
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
                    shadow_validation_artifact_path=shadow_artifact_path,
                ),
                replay_executor=_fake_replay_executor,
            )

            self.assertEqual(summary.status, "shadow_validation_failed")
            shadow_payload = json.loads(
                Path(summary.shadow_validation_path).read_text(encoding="utf-8")
            )
            self.assertEqual(shadow_payload["status"], "out_of_budget")
            self.assertIn(
                "shadow_validation_status_not_within_budget", shadow_payload["reasons"]
            )

    def test_write_runtime_closure_bundle_handles_missing_best_candidate(self) -> None:
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
            summary = write_runtime_closure_bundle(
                run_root=run_root,
                runner_run_id="run-1",
                program=_program(),
                best_candidate=None,
                manifest=manifest,
            )

            self.assertEqual(summary.status, "missing_candidate")
            self.assertTrue((run_root / "runtime-closure" / "summary.json").exists())
