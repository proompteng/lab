from __future__ import annotations

# ruff: noqa: F401,F403,F405
from tests.runtime_closure.support import *


class TestRuntimeClosurePart1(_TestRuntimeClosureBase):
    def test_discover_runtime_root_accepts_monorepo_and_service_image_layouts(
        self,
    ) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            monorepo_root = root / "repo"
            monorepo_source = (
                monorepo_root
                / "services"
                / "torghut"
                / "app"
                / "trading"
                / "discovery"
                / "runtime_closure.py"
            )
            monorepo_source.parent.mkdir(parents=True)
            monorepo_source.write_text("# test\n", encoding="utf-8")
            (monorepo_root / ".git").write_text("gitdir: test\n", encoding="utf-8")

            self.assertEqual(
                runtime_closure._discover_runtime_root(monorepo_source),
                monorepo_root.resolve(),
            )

            service_root = root / "service-image"
            service_source = (
                service_root / "app" / "trading" / "discovery" / "runtime_closure.py"
            )
            service_source.parent.mkdir(parents=True)
            service_source.write_text("# test\n", encoding="utf-8")
            (service_root / "app" / "main.py").write_text("# test\n", encoding="utf-8")
            (service_root / "scripts").mkdir()

            self.assertEqual(
                runtime_closure._discover_runtime_root(service_source),
                service_root.resolve(),
            )

            argocd_root = root / "argocd-root"
            argocd_source = (
                argocd_root
                / "pkg"
                / "app"
                / "trading"
                / "discovery"
                / "runtime_closure.py"
            )
            argocd_source.parent.mkdir(parents=True)
            argocd_source.write_text("# test\n", encoding="utf-8")
            (
                argocd_root
                / "argocd"
                / "applications"
                / "torghut"
                / "strategy-configmap.yaml"
            ).parent.mkdir(parents=True)
            (
                argocd_root
                / "argocd"
                / "applications"
                / "torghut"
                / "strategy-configmap.yaml"
            ).write_text("apiVersion: v1\n", encoding="utf-8")

            self.assertEqual(
                runtime_closure._discover_runtime_root(argocd_source),
                argocd_root.resolve(),
            )

            shallow_source = (
                root
                / "shallow"
                / "app"
                / "trading"
                / "discovery"
                / "runtime_closure.py"
            )
            shallow_source.parent.mkdir(parents=True)
            shallow_source.write_text("# test\n", encoding="utf-8")

            self.assertEqual(
                runtime_closure._discover_runtime_root(shallow_source),
                (root / "shallow").resolve(),
            )

            unmatched_source = root / "other" / "module.py"
            unmatched_source.parent.mkdir(parents=True)
            unmatched_source.write_text("# test\n", encoding="utf-8")

            self.assertEqual(
                runtime_closure._discover_runtime_root(unmatched_source),
                unmatched_source.parent.resolve(),
            )

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
            runtime_closure._daily_liquidity_notional(
                {
                    "daily": {
                        "2026-03-20": {"daily_adv_notional": "3200.00"},
                        "2026-03-21": {"depth_notional": "329.950"},
                    }
                }
            ),
            {
                "2026-03-20": Decimal("3200.00"),
                "2026-03-21": Decimal("329.950"),
            },
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
        self.assertEqual(payload["status"], "ok")
        self.assertEqual(
            payload["execution_realism_status"], "missing_required_evidence"
        )
        self.assertIn(
            "lob_event_stream_evidence_missing",
            payload["execution_realism_missing_evidence"],
        )
        self.assertIn(
            "live_paper_parity_fill_error_evidence_missing",
            payload["execution_realism_missing_evidence"],
        )
        self.assertEqual(
            payload["execution_realism"]["status"], "missing_required_evidence"
        )
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

            missing_catalog_path = root / "missing-catalog.yaml"
            missing_catalog_path.write_text("not_strategies: []\n", encoding="utf-8")
            with self.assertRaisesRegex(
                ValueError, "strategy_configmap_missing_strategies_yaml"
            ):
                runtime_closure._load_strategy_configmap_payload(missing_catalog_path)

    def test_materialize_candidate_configmap_accepts_mounted_strategy_catalog(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            strategy_catalog_path = root / "strategies.yaml"
            strategy_catalog_path.write_text(
                """
strategies:
  - name: breakout-continuation-long-v1
    enabled: false
    strategy_type: breakout_continuation_long_v1
    params:
      max_entries_per_session: '1'
""".strip()
                + "\n",
                encoding="utf-8",
            )
            context = RuntimeClosureExecutionContext(
                strategy_configmap_path=strategy_catalog_path,
                clickhouse_http_url="http://example.invalid:8123",
                clickhouse_username="torghut",
                clickhouse_password="secret",
                start_equity=Decimal("31590.02"),
                chunk_minutes=10,
            )

            rendered_path = runtime_closure._materialize_candidate_configmap(
                best_candidate={
                    "candidate_id": "cand-1",
                    "runtime_strategy_name": "breakout-continuation-long-v1",
                    "candidate_params": {"max_entries_per_session": "3"},
                },
                execution_context=context,
                output_path=root / "candidate-configmap.yaml",
            )

            rendered = runtime_closure.yaml.safe_load(
                rendered_path.read_text(encoding="utf-8")
            )
            catalog = runtime_closure.yaml.safe_load(
                rendered["data"]["strategies.yaml"]
            )
            strategy = catalog["strategies"][0]
            self.assertTrue(strategy["enabled"])
            self.assertEqual(strategy["params"]["max_entries_per_session"], "3")

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

    def test_microbar_portfolio_closure_preserves_prevclose_runtime_params(
        self,
    ) -> None:
        context = RuntimeClosureExecutionContext(
            strategy_configmap_path=Path("/tmp/unused.yaml"),
            clickhouse_http_url="http://example.invalid:8123",
            clickhouse_username="torghut",
            clickhouse_password="secret",
            start_equity=Decimal("31590.02"),
            chunk_minutes=10,
            symbols=("NVDA", "AVGO", "AMD"),
        )
        best_candidate = {
            "candidate_id": "cand-prevclose",
            "family": "microbar_cross_sectional_pairs",
            "family_template_id": "microbar_cross_sectional_pairs_v1",
            "strategy_name": "microbar-cross-sectional-pairs-v1",
            "replay_config": {
                "backend": "microbar_daily_portfolio",
                "portfolio": {
                    "base_per_leg_notional": "30000",
                    "symbols": ["NVDA", "AVGO", "AMD"],
                    "sleeves": [
                        {
                            "signal": "opening_window_prev_close_reversal",
                            "weight": "1",
                            "params": {
                                "entry_minute_after_open": "35",
                                "entry_window_minutes": "25",
                                "exit_minute_after_open": "180",
                                "signal_motif": "opening_window_prev_close_reversal",
                                "rank_feature": (
                                    "cross_section_opening_window_return_from_prev_close_rank"
                                ),
                                "selection_mode": "reversal",
                                "top_n": "2",
                                "gate_feature": (
                                    "cross_section_positive_opening_window_return_from_prev_close_ratio"
                                ),
                                "gate_min": "0.20",
                                "gate_max": "0.85",
                                "long_stop_loss_bps": "5",
                                "long_trailing_stop_activation_profit_bps": "5",
                                "long_trailing_stop_drawdown_bps": "2",
                                "max_session_negative_exit_bps": "3",
                            },
                            "universe_symbols": ["NVDA", "AVGO", "AMD"],
                        }
                    ],
                },
            },
        }

        strategies = (
            runtime_closure._materialized_microbar_portfolio_runtime_strategies(
                best_candidate=best_candidate,
                execution_context=context,
            )
        )

        self.assertEqual(len(strategies), 2)
        long_params = strategies[0]["params"]
        self.assertEqual(
            long_params["rank_feature"],
            "cross_section_opening_window_return_from_prev_close_rank",
        )
        self.assertEqual(
            long_params["gate_feature"],
            "cross_section_positive_opening_window_return_from_prev_close_ratio",
        )
        self.assertEqual(long_params["entry_window_minutes"], "25")
        self.assertEqual(long_params["long_stop_loss_bps"], "5")
        self.assertEqual(strategies[0]["universe_symbols"], ["NVDA", "AVGO", "AMD"])

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
                            "universe_symbols": ["NVDA", "AAPL"],
                            "max_notional_per_trade": "17500",
                            "params": {
                                "entry_minute_after_open": "45",
                                "exit_minute_after_open": "240",
                            },
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
            self.assertEqual(strategies[1]["params"]["entry_minute_after_open"], "45")
            self.assertEqual(strategies[1]["universe_symbols"], ["NVDA", "AAPL"])
            self.assertEqual(strategies[1]["max_notional_per_trade"], "17500")
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
