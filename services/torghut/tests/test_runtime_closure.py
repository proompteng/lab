from __future__ import annotations

import json
import subprocess
from decimal import Decimal
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import patch

import app.trading.discovery.runtime_closure as runtime_closure
from app.trading.discovery.autoresearch import (
    ProposalModelPolicy,
    ReplayBudget,
    RuntimeClosurePolicy,
    SnapshotPolicy,
    StrategyAutoresearchProgram,
    StrategyObjective,
)
from app.trading.discovery.mlx_snapshot import build_mlx_snapshot_manifest
from app.trading.discovery.portfolio_candidates import (
    PORTFOLIO_CANDIDATE_SCHEMA_VERSION,
    PortfolioCandidateSpec,
)
from app.trading.discovery.runtime_closure import (
    RuntimeClosureExecutionContext,
    write_runtime_closure_bundle,
)

_REPO_ROOT = Path(__file__).resolve().parents[3]


def _program() -> StrategyAutoresearchProgram:
    return StrategyAutoresearchProgram(
        program_id="program-1",
        description="desc",
        objective=StrategyObjective(
            target_net_pnl_per_day=Decimal("500"),
            min_active_day_ratio=Decimal("1.0"),
            min_positive_day_ratio=Decimal("0.6"),
            min_daily_notional=Decimal("300000"),
            max_best_day_share=Decimal("0.3"),
            max_worst_day_loss=Decimal("350"),
            max_drawdown=Decimal("900"),
            require_every_day_active=True,
            min_regime_slice_pass_rate=Decimal("0.45"),
            stop_when_objective_met=True,
        ),
        snapshot_policy=SnapshotPolicy(
            bar_interval="PT1S",
            feature_set_id="torghut.mlx-autoresearch.v1",
            quote_quality_policy_id="scheduler_v3_default",
            symbol_policy="args_or_sweep",
            allow_prior_day_features=True,
            allow_cross_sectional_features=True,
        ),
        forbidden_mutations=("runtime_code_path",),
        proposal_model_policy=ProposalModelPolicy(
            enabled=True,
            mode="ranking_only",
            backend_preference="mlx",
            top_k=4,
            exploration_slots=1,
            minimum_history_rows=1,
        ),
        replay_budget=ReplayBudget(
            max_candidates_per_round=8,
            exploration_slots=1,
            max_candidates_per_frontier_run=16,
        ),
        runtime_closure_policy=RuntimeClosurePolicy(
            enabled=False,
            execute_parity_replay=True,
            execute_approval_replay=True,
            parity_window="full_window",
            approval_window="holdout",
            shadow_validation_mode="require_live_evidence",
            promotion_target="shadow",
        ),
        parity_requirements=("scheduler_v3_parity_replay",),
        promotion_policy="research_only",
        ledger_policy={"append_only": True},
        research_sources=(),
        families=(),
    )


class TestRuntimeClosure(TestCase):
    def test_runtime_closure_helper_branches_cover_edge_cases(self) -> None:
        manifest = build_mlx_snapshot_manifest(
            runner_run_id="run-1",
            program=_program(),
            symbols="AMAT,NVDA",
            train_days=6,
            holdout_days=2,
            full_window_start_date="2026-03-20",
            full_window_end_date="2026-04-09",
        )
        context = RuntimeClosureExecutionContext(
            strategy_configmap_path=Path("/tmp/unused.yaml"),
            clickhouse_http_url="http://example.invalid:8123",
            clickhouse_username="torghut",
            clickhouse_password="secret",
            start_equity=Decimal("31590.02"),
            chunk_minutes=10,
            symbols=("AMAT", "NVDA"),
        )

        self.assertEqual(
            runtime_closure._max_drawdown_from_daily_net(
                {"2026-03-20": Decimal("5"), "2026-03-21": Decimal("-10")}
            ),
            Decimal("10"),
        )
        self.assertEqual(
            runtime_closure._rolling_lower_bound({}, window=3), Decimal("0")
        )
        self.assertEqual(
            runtime_closure._rolling_lower_bound(
                {"2026-03-20": Decimal("2"), "2026-03-21": Decimal("4")},
                window=3,
            ),
            Decimal("3"),
        )
        self.assertEqual(
            runtime_closure._max_best_day_share_of_total_pnl(
                daily_net={"2026-03-20": Decimal("-1")},
                total_net_pnl=Decimal("0"),
            ),
            Decimal("1"),
        )
        self.assertEqual(
            runtime_closure._max_best_day_share_of_total_pnl(
                daily_net={"2026-03-20": Decimal("-1")},
                total_net_pnl=Decimal("10"),
            ),
            Decimal("0"),
        )
        self.assertEqual(
            runtime_closure._candidate_symbols(
                best_candidate={"candidate_strategy_overrides": {}},
                execution_context=context,
            ),
            ("AMAT", "NVDA"),
        )
        self.assertIsNone(context.to_payload()["shadow_validation_artifact_path"])
        self.assertEqual(
            runtime_closure._window_bounds(
                best_candidate={},
                window_name="full_window",
                manifest=manifest,
            ),
            (
                runtime_closure._date_from_iso("2026-03-20"),
                runtime_closure._date_from_iso("2026-04-09"),
            ),
        )
        with self.assertRaisesRegex(
            ValueError, "runtime_closure_window_missing:holdout"
        ):
            runtime_closure._window_bounds(
                best_candidate={},
                window_name="holdout",
                manifest=manifest,
            )
        config = object()
        with patch.object(
            runtime_closure.replay_mod, "run_replay", return_value={"status": "ok"}
        ) as mock_run:
            payload = runtime_closure._default_replay_executor(config)
        self.assertEqual(payload, {"status": "ok"})
        mock_run.assert_called_once_with(config)  # type: ignore[arg-type]

    def test_shadow_validation_artifact_helper_covers_invalid_schema_and_pending_status(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            invalid_json_path = root / "invalid.json"
            invalid_json_path.write_text("{not-json\n", encoding="utf-8")
            bad_schema_path = root / "bad-schema.json"
            bad_schema_path.write_text(
                json.dumps(
                    {"schema_version": "wrong-schema", "status": "within_budget"}
                )
                + "\n",
                encoding="utf-8",
            )
            pending_path = root / "pending.json"
            pending_path.write_text(
                json.dumps(
                    {
                        "schema_version": "shadow-live-deviation-report-v1",
                        "status": "pending",
                        "order_count": 2,
                    }
                )
                + "\n",
                encoding="utf-8",
            )

            invalid_payload = runtime_closure._shadow_validation_artifact(
                best_candidate={"candidate_id": "cand-1"},
                program=_program(),
                execution_context=RuntimeClosureExecutionContext(
                    strategy_configmap_path=root / "strategies.yaml",
                    clickhouse_http_url="http://example.invalid:8123",
                    clickhouse_username="torghut",
                    clickhouse_password="secret",
                    start_equity=Decimal("31590.02"),
                    chunk_minutes=10,
                    shadow_validation_artifact_path=invalid_json_path,
                ),
            )
            self.assertEqual(invalid_payload["status"], "invalid_artifact")
            self.assertIn(
                "shadow_validation_artifact_invalid_json", invalid_payload["reasons"]
            )

            bad_schema_payload = runtime_closure._shadow_validation_artifact(
                best_candidate={"candidate_id": "cand-1"},
                program=_program(),
                execution_context=RuntimeClosureExecutionContext(
                    strategy_configmap_path=root / "strategies.yaml",
                    clickhouse_http_url="http://example.invalid:8123",
                    clickhouse_username="torghut",
                    clickhouse_password="secret",
                    start_equity=Decimal("31590.02"),
                    chunk_minutes=10,
                    shadow_validation_artifact_path=bad_schema_path,
                ),
            )
            self.assertEqual(bad_schema_payload["status"], "invalid_artifact")
            self.assertIn(
                "shadow_validation_schema_version_invalid",
                bad_schema_payload["reasons"],
            )

            pending_payload = runtime_closure._shadow_validation_artifact(
                best_candidate={"candidate_id": "cand-1"},
                program=_program(),
                execution_context=RuntimeClosureExecutionContext(
                    strategy_configmap_path=root / "strategies.yaml",
                    clickhouse_http_url="http://example.invalid:8123",
                    clickhouse_username="torghut",
                    clickhouse_password="secret",
                    start_equity=Decimal("31590.02"),
                    chunk_minutes=10,
                    shadow_validation_artifact_path=pending_path,
                ),
            )
            self.assertEqual(pending_payload["status"], "pending")
            self.assertIn("shadow_validation_pending", pending_payload["reasons"])

    def test_materialize_candidate_configmap_rejects_invalid_inputs(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            invalid_configmap_path = root / "invalid.yaml"
            invalid_configmap_path.write_text("- not-a-mapping\n", encoding="utf-8")
            context = RuntimeClosureExecutionContext(
                strategy_configmap_path=invalid_configmap_path,
                clickhouse_http_url="http://example.invalid:8123",
                clickhouse_username="torghut",
                clickhouse_password="secret",
                start_equity=Decimal("31590.02"),
                chunk_minutes=10,
            )
            with self.assertRaisesRegex(ValueError, "strategy_configmap_not_mapping"):
                runtime_closure._materialize_candidate_configmap(
                    best_candidate={},
                    execution_context=context,
                    output_path=root / "out.yaml",
                )

            valid_configmap_path = root / "valid.yaml"
            valid_configmap_path.write_text(
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
            valid_context = RuntimeClosureExecutionContext(
                strategy_configmap_path=valid_configmap_path,
                clickhouse_http_url="http://example.invalid:8123",
                clickhouse_username="torghut",
                clickhouse_password="secret",
                start_equity=Decimal("31590.02"),
                chunk_minutes=10,
            )
            with self.assertRaisesRegex(
                ValueError, "runtime_closure_missing_runtime_strategy_name"
            ):
                runtime_closure._materialize_candidate_configmap(
                    best_candidate={
                        "candidate_params": {"max_entries_per_session": "1"}
                    },
                    execution_context=valid_context,
                    output_path=root / "missing-name.yaml",
                )
            with self.assertRaisesRegex(
                ValueError, "runtime_closure_missing_candidate_params"
            ):
                runtime_closure._materialize_candidate_configmap(
                    best_candidate={
                        "runtime_strategy_name": "breakout-continuation-long-v1"
                    },
                    execution_context=valid_context,
                    output_path=root / "missing-params.yaml",
                )

    def test_materialize_candidate_configmap_supports_microbar_portfolio_candidates(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            configmap_path = root / "valid.yaml"
            configmap_path.write_text(
                """
apiVersion: v1
kind: ConfigMap
data:
  strategies.yaml: |
    strategies:
      - name: breakout-continuation-long-v1
        enabled: true
        strategy_type: breakout_continuation_long_v1
        params:
          max_entries_per_session: '1'
""".strip()
                + "\n",
                encoding="utf-8",
            )
            context = RuntimeClosureExecutionContext(
                strategy_configmap_path=configmap_path,
                clickhouse_http_url="http://example.invalid:8123",
                clickhouse_username="torghut",
                clickhouse_password="secret",
                start_equity=Decimal("31590.02"),
                chunk_minutes=10,
            )
            best_candidate = {
                "candidate_id": "cand-pairs",
                "family": "microbar_cross_sectional_pairs",
                "family_template_id": "microbar_cross_sectional_pairs_v1",
                "strategy_name": "microbar-cross-sectional-pairs-v1",
                "replay_config": {
                    "backend": "microbar_daily_portfolio",
                    "portfolio": {
                        "base_per_leg_notional": "25000",
                        "symbols": ["AAPL", "NVDA", "MSFT"],
                        "sleeves": [
                            {
                                "entry_minute_after_open": 60,
                                "exit_minute_after_open": 120,
                                "signal": "open_window_continuation",
                                "top_n": 2,
                                "weight": "2",
                            },
                            {
                                "entry_minute_after_open": 75,
                                "exit_minute_after_open": "close",
                                "signal": "vwap_close_continuation",
                                "top_n": 1,
                                "weight": "1",
                            },
                        ],
                    },
                },
            }

            rendered_path = runtime_closure._materialize_candidate_configmap(
                best_candidate=best_candidate,
                execution_context=context,
                output_path=root / "portfolio.yaml",
            )
            rendered = runtime_closure.yaml.safe_load(
                rendered_path.read_text(encoding="utf-8")
            )
            catalog = runtime_closure.yaml.safe_load(
                rendered["data"]["strategies.yaml"]
            )
            strategies = catalog["strategies"]
            self.assertFalse(strategies[0]["enabled"])
            self.assertEqual(
                runtime_closure._candidate_symbols(
                    best_candidate=best_candidate,
                    execution_context=context,
                ),
                ("AAPL", "NVDA", "MSFT"),
            )
            microbar_names = [item["name"] for item in strategies[1:]]
            self.assertEqual(
                microbar_names,
                [
                    "microbar-cross-sectional-pairs-v1-sleeve-1-long",
                    "microbar-cross-sectional-pairs-v1-sleeve-1-short",
                    "microbar-cross-sectional-pairs-v1-sleeve-2-long",
                    "microbar-cross-sectional-pairs-v1-sleeve-2-short",
                ],
            )
            sleeve_one_long = strategies[1]
            self.assertEqual(
                sleeve_one_long["strategy_type"], "microbar_cross_sectional_long_v1"
            )
            self.assertEqual(
                sleeve_one_long["params"]["rank_feature"],
                "cross_section_session_open_rank",
            )
            self.assertEqual(
                sleeve_one_long["params"]["selection_mode"], "continuation"
            )
            self.assertEqual(sleeve_one_long["params"]["max_concurrent_positions"], "2")
            self.assertEqual(
                Decimal(str(sleeve_one_long["max_notional_per_trade"])),
                Decimal("50000"),
            )

            manifest = build_mlx_snapshot_manifest(
                runner_run_id="run-1",
                program=_program(),
                symbols="AAPL,MSFT,NVDA",
                train_days=6,
                holdout_days=2,
                full_window_start_date="2026-03-25",
                full_window_end_date="2026-04-02",
            )
            candidate_spec = runtime_closure._candidate_spec(
                runner_run_id="run-1",
                program=_program(),
                best_candidate=best_candidate,
                manifest=manifest,
            )
            self.assertEqual(
                candidate_spec["runtime_strategy_names"],
                [
                    "microbar-cross-sectional-pairs-v1-sleeve-1-long",
                    "microbar-cross-sectional-pairs-v1-sleeve-1-short",
                    "microbar-cross-sectional-pairs-v1-sleeve-2-long",
                    "microbar-cross-sectional-pairs-v1-sleeve-2-short",
                ],
            )
            self.assertEqual(
                candidate_spec["portfolio_promotion_v2"]["strategy_count"], 4
            )
            self.assertEqual(
                candidate_spec["portfolio_promotion_v2"]["spec_compiled_count"], 4
            )
            self.assertEqual(
                candidate_spec["portfolio_promotion_v2"]["missing_policy_refs"], []
            )
            self.assertEqual(
                len(candidate_spec["portfolio_promotion_v2"]["promotion_policy_refs"]),
                4,
            )
            self.assertTrue(
                all(
                    str(ref).startswith("torghut.autoresearch.portfolio/cand-pairs/")
                    for ref in candidate_spec["portfolio_promotion_v2"][
                        "promotion_policy_refs"
                    ]
                )
            )
            self.assertEqual(candidate_spec["full_window_start_date"], "2026-03-25")
            self.assertEqual(candidate_spec["full_window_end_date"], "2026-04-02")
            gate_report = runtime_closure._gate_report(
                runner_run_id="run-1",
                best_candidate=best_candidate,
                promotion_target="shadow",
                parity_report=None,
                approval_report=None,
                shadow_plan={"required": False, "status": "skipped"},
            )
            self.assertEqual(
                gate_report["vnext"]["portfolio_promotion"]["strategy_count"], 4
            )
            self.assertEqual(
                gate_report["vnext"]["portfolio_promotion"]["missing_policy_refs"], []
            )

    def test_materialize_candidate_configmap_supports_generic_portfolio_candidates(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            configmap_path = root / "valid.yaml"
            configmap_path.write_text(
                """
apiVersion: v1
kind: ConfigMap
data:
  strategies.yaml: |
    strategies:
      - name: breakout-continuation-long-v1
        enabled: true
        strategy_type: breakout_continuation_long_v1
        params:
          max_entries_per_session: '1'
""".strip()
                + "\n",
                encoding="utf-8",
            )
            context = RuntimeClosureExecutionContext(
                strategy_configmap_path=configmap_path,
                clickhouse_http_url="http://example.invalid:8123",
                clickhouse_username="torghut",
                clickhouse_password="secret",
                start_equity=Decimal("31590.02"),
                chunk_minutes=10,
                symbols=("AAPL", "NVDA"),
            )
            best_candidate = {
                "candidate_id": "portfolio-1",
                "family_template_id": "portfolio_whitepaper_autoresearch_v1",
                "portfolio": {
                    "base_per_leg_notional": "50000",
                    "sleeves": [
                        {
                            "candidate_id": "cand-a",
                            "candidate_spec_id": "spec-a",
                            "runtime_family": "momentum_pullback_consistent",
                            "runtime_strategy_name": "momentum-pullback-long-v1",
                            "weight": "0.60",
                            "expected_net_pnl_per_day": "320",
                            "correlation_cluster": "momentum",
                        },
                        {
                            "candidate_id": "cand-b",
                            "candidate_spec_id": "spec-b",
                            "runtime_family": "washout_rebound_consistent",
                            "runtime_strategy_name": "washout-rebound-long-v1",
                            "weight": "0.40",
                            "expected_net_pnl_per_day": "230",
                            "correlation_cluster": "rebound",
                        },
                    ],
                },
            }

            rendered_path = runtime_closure._materialize_candidate_configmap(
                best_candidate=best_candidate,
                execution_context=context,
                output_path=root / "generic-portfolio.yaml",
            )
            rendered = runtime_closure.yaml.safe_load(
                rendered_path.read_text(encoding="utf-8")
            )
            catalog = runtime_closure.yaml.safe_load(
                rendered["data"]["strategies.yaml"]
            )
            strategies = catalog["strategies"]
            self.assertFalse(strategies[0]["enabled"])
            self.assertEqual(
                [item["name"] for item in strategies[1:]],
                ["momentum-pullback-long-v1", "washout-rebound-long-v1"],
            )
            self.assertEqual(
                strategies[1]["strategy_type"], "momentum_pullback_consistent"
            )
            self.assertEqual(strategies[1]["params"]["candidate_spec_id"], "spec-a")
            self.assertEqual(strategies[1]["params"]["sleeve_weight"], "0.6")
            self.assertEqual(strategies[2]["max_notional_per_trade"], "20000")
            self.assertEqual(
                runtime_closure._portfolio_runtime_strategy_names(best_candidate),
                ("momentum-pullback-long-v1", "washout-rebound-long-v1"),
            )
            portfolio_contract = runtime_closure._portfolio_promotion_v2(best_candidate)
            self.assertEqual(portfolio_contract["strategy_count"], 2)
            self.assertEqual(portfolio_contract["spec_compiled_count"], 2)
            self.assertEqual(
                portfolio_contract["strategy_compilation_source"],
                "runtime_closure_materialized_portfolio_v1",
            )
            self.assertEqual(portfolio_contract["missing_policy_refs"], [])
            self.assertEqual(len(portfolio_contract["promotion_policy_refs"]), 2)
            self.assertEqual(len(portfolio_contract["risk_profile_refs"]), 2)
            self.assertEqual(len(portfolio_contract["sizing_policy_refs"]), 2)
            self.assertEqual(len(portfolio_contract["execution_policy_refs"]), 2)

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

            self.assertEqual(summary.status, "pending_shadow_validation")
            self.assertTrue(Path(summary.candidate_configmap_path).exists())
            self.assertTrue(Path(summary.parity_replay_path).exists())
            self.assertTrue(Path(summary.approval_replay_path).exists())
            self.assertTrue(Path(summary.shadow_validation_path).exists())
            self.assertIn("live_shadow_validation", summary.next_required_steps)

            parity_report = json.loads(
                Path(summary.parity_report_path).read_text(encoding="utf-8")
            )
            self.assertTrue(parity_report["objective_met"])
            self.assertEqual(parity_report["window_name"], "full_window")

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
