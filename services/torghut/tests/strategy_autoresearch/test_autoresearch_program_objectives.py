from __future__ import annotations

from tests.strategy_autoresearch.support import (
    Decimal,
    FamilyAutoresearchPlan,
    MutationSpace,
    Namespace,
    Path,
    StrategyAutoresearchTestCase,
    StrategyObjective,
    TemporaryDirectory,
    _family_template,
    apply_program_objective,
    build_mutated_sweep_config,
    candidate_meets_objective,
    copy,
    load_strategy_autoresearch_program,
    runner,
    yaml,
)


class TestStrategyAutoresearchProgramObjectives(StrategyAutoresearchTestCase):
    def test_materialize_run_replay_tape_skips_when_supplied_or_unresolved(
        self,
    ) -> None:
        existing_stats = runner.MlxSignalBundleStats(
            path="/tmp/existing.jsonl",
            row_count=7,
            symbol_count=1,
            first_event_ts="2026-03-20T13:30:00+00:00",
            last_event_ts="2026-03-20T13:31:00+00:00",
        )
        args = Namespace(
            materialize_replay_tape=True,
            replay_tape_path=Path("/tmp/provided-tape.jsonl"),
        )

        stats, receipt = runner._maybe_materialize_run_replay_tape(
            args=args,
            runner_run_id="strategy-autoresearch-test",
            snapshot_symbols=("AMAT",),
            bundle_paths={},
            full_window_start_date="2026-03-20",
            full_window_end_date="2026-03-20",
            existing_signal_bundle=existing_stats,
        )
        self.assertIs(stats, existing_stats)
        self.assertIsNone(receipt)

        args.replay_tape_path = None
        stats, receipt = runner._maybe_materialize_run_replay_tape(
            args=args,
            runner_run_id="strategy-autoresearch-test",
            snapshot_symbols=("AMAT",),
            bundle_paths={},
            full_window_start_date="",
            full_window_end_date="2026-03-20",
            existing_signal_bundle=existing_stats,
        )
        self.assertIs(stats, existing_stats)
        self.assertIsNone(receipt)

    def _write_program_fixture(self, root: Path) -> tuple[Path, Path]:
        family_dir = root / "families"
        family_dir.mkdir()
        (family_dir / "breakout_reclaim_v2.yaml").write_text(
            yaml.safe_dump(
                {
                    "schema_version": "torghut.family-template.v1",
                    "family_id": "breakout_reclaim_v2",
                    "economic_mechanism": "Breakout reclaim.",
                    "supported_markets": ["us_equities_intraday"],
                    "required_features": ["quote_quality"],
                    "allowed_normalizations": ["price_scaled", "opening_window_scaled"],
                    "entry_motifs": ["breakout_reclaim"],
                    "exit_motifs": ["trailing_stop"],
                    "risk_controls": ["stop_loss"],
                    "activity_model": {
                        "min_active_day_ratio": "0.50",
                        "min_daily_notional": "200000",
                    },
                    "liquidity_assumptions": {"max_spread_bps": "30"},
                    "regime_activation_rules": [],
                    "day_veto_rules": [],
                    "default_hard_vetoes": {"required_max_best_day_share": "0.45"},
                    "default_selection_objectives": {"target_net_pnl_per_day": "300"},
                    "runtime_harness": {
                        "family": "breakout_continuation_consistent",
                        "strategy_name": "breakout-continuation-long-v1",
                        "disable_other_strategies": True,
                    },
                },
                sort_keys=False,
            ),
            encoding="utf-8",
        )
        sweep_path = root / "profitability-frontier-consistent-breakout.yaml"
        sweep_path.write_text(
            yaml.safe_dump(
                {
                    "schema_version": "torghut.replay-frontier-sweep.v1",
                    "family": "breakout_continuation_consistent",
                    "family_template_id": "breakout_reclaim_v2",
                    "strategy_name": "breakout-continuation-long-v1",
                    "disable_other_strategies": True,
                    "constraints": {"holdout_target_net_per_day": "300"},
                    "consistency_constraints": {"target_net_per_day": "300"},
                    "strategy_overrides": {
                        "universe_symbols": [["AMAT", "NVDA"]],
                        "max_position_pct_equity": ["10.0"],
                    },
                    "parameters": {
                        "max_entries_per_session": ["2"],
                        "entry_cooldown_seconds": ["600"],
                    },
                },
                sort_keys=False,
            ),
            encoding="utf-8",
        )
        program_path = root / "program.yaml"
        program_path.write_text(
            yaml.safe_dump(
                {
                    "schema_version": "torghut.strategy-autoresearch.v1",
                    "program_id": "daily-profit",
                    "description": "Program fixture.",
                    "objective": {
                        "target_net_pnl_per_day": "500",
                        "min_active_day_ratio": "0.80",
                        "min_positive_day_ratio": "0.55",
                        "min_daily_notional": "300000",
                        "max_best_day_share": "0.35",
                        "max_worst_day_loss": "450",
                        "max_drawdown": "1000",
                        "min_regime_slice_pass_rate": "0.40",
                        "max_gross_exposure_pct_equity": "1.25",
                        "min_cash": "0",
                    },
                    "runtime_closure_policy": {
                        "enabled": False,
                        "execute_parity_replay": True,
                        "execute_approval_replay": True,
                        "parity_window": "full_window",
                        "approval_window": "holdout",
                        "shadow_validation_mode": "require_live_evidence",
                        "promotion_target": "shadow",
                    },
                    "research_sources": [
                        {
                            "source_id": "paper-1",
                            "title": "Paper 1",
                            "url": "https://example.com/paper-1",
                            "published_at": "2026-01-01",
                            "claims": [
                                {
                                    "claim_id": "claim-1",
                                    "summary": "Use realistic replay.",
                                    "implication": "Prefer day-level diagnostics.",
                                }
                            ],
                        }
                    ],
                    "families": [
                        {
                            "family_template_id": "breakout_reclaim_v2",
                            "seed_sweep_config": "./profitability-frontier-consistent-breakout.yaml",
                            "max_iterations": 2,
                            "keep_top_candidates": 1,
                            "frontier_top_n": 2,
                            "symbol_prune_iterations": 1,
                            "symbol_prune_candidates": 1,
                            "symbol_prune_min_universe_size": 2,
                            "loss_repair_iterations": 1,
                            "loss_repair_candidates": 1,
                            "consistency_repair_iterations": 1,
                            "consistency_repair_candidates": 2,
                            "parameter_mutations": {
                                "max_entries_per_session": {
                                    "mode": "numeric_step",
                                    "deltas": ["-1", "0", "1"],
                                    "minimum": "1",
                                    "maximum": "4",
                                }
                            },
                            "strategy_override_mutations": {
                                "normalization_regime": {
                                    "mode": "allowed_normalizations"
                                }
                            },
                        }
                    ],
                },
                sort_keys=False,
            ),
            encoding="utf-8",
        )
        return program_path, family_dir

    def test_load_program_and_apply_objective(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            program_path, family_dir = self._write_program_fixture(root)

            program = load_strategy_autoresearch_program(
                program_path, family_dir=family_dir
            )
            self.assertEqual(program.program_id, "daily-profit")
            self.assertEqual(program.objective.target_net_pnl_per_day, Decimal("500"))
            self.assertEqual(
                program.objective.max_gross_exposure_pct_equity, Decimal("1.25")
            )
            self.assertEqual(program.objective.min_cash, Decimal("0"))
            self.assertEqual(
                program.families[0].family_template.family_id, "breakout_reclaim_v2"
            )
            self.assertEqual(
                program.families[0]
                .strategy_override_mutations["normalization_regime"]
                .mode,
                "allowed_normalizations",
            )

            sweep_payload = yaml.safe_load(
                (root / "profitability-frontier-consistent-breakout.yaml").read_text(
                    encoding="utf-8"
                )
            )
            updated = apply_program_objective(
                sweep_config=sweep_payload,
                objective=program.objective,
                holdout_day_count=3,
                full_window_day_count=9,
            )
            self.assertEqual(
                updated["constraints"]["holdout_target_net_per_day"], "500"
            )
            self.assertEqual(
                updated["consistency_constraints"]["min_daily_net_pnl"], "0"
            )
            self.assertEqual(
                updated["consistency_constraints"]["max_best_day_share_of_total_pnl"],
                "0.35",
            )
            self.assertEqual(
                updated["consistency_constraints"]["max_gross_exposure_pct_equity"],
                "1.25",
            )
            self.assertEqual(updated["consistency_constraints"]["min_cash"], "0")
            self.assertEqual(updated["consistency_constraints"]["min_active_days"], 8)

    def test_checked_in_300_daily_profit_program_targets_daily_net(self) -> None:
        program_path = Path(
            "config/trading/research-programs/strict-daily-profit-autoresearch-300-v1.yaml"
        )

        program = load_strategy_autoresearch_program(
            program_path,
            family_dir=Path("config/trading/families"),
        )

        self.assertEqual(program.program_id, "strict_daily_profit_autoresearch_300_v1")
        self.assertEqual(program.objective.target_net_pnl_per_day, Decimal("300"))
        self.assertEqual(program.objective.min_daily_net_pnl, Decimal("300"))
        self.assertEqual(program.objective.min_positive_day_ratio, Decimal("1.0"))
        self.assertEqual(program.objective.max_worst_day_loss, Decimal("0"))
        self.assertTrue(program.objective.require_every_day_active)
        self.assertEqual(program.runtime_closure_policy.promotion_target, "shadow")
        self.assertIn("scheduler_v3_parity_replay", program.parity_requirements)
        self.assertGreaterEqual(len(program.research_sources), 4)
        self.assertTrue(
            all(
                source.published_at.startswith(("2025", "2026"))
                for source in program.research_sources
            )
        )

    def test_checked_in_500_portfolio_profit_program_allows_bounded_down_days(
        self,
    ) -> None:
        program_path = Path(
            "config/trading/research-programs/portfolio-profit-autoresearch-500-v1.yaml"
        )

        program = load_strategy_autoresearch_program(
            program_path,
            family_dir=Path("config/trading/families"),
        )

        self.assertEqual(program.program_id, "portfolio_profit_autoresearch_500_v1")
        self.assertEqual(program.objective.target_net_pnl_per_day, Decimal("500"))
        self.assertEqual(program.objective.min_daily_net_pnl, Decimal("-999999999"))
        self.assertEqual(program.objective.min_active_day_ratio, Decimal("0.90"))
        self.assertEqual(program.objective.min_positive_day_ratio, Decimal("0.60"))
        self.assertEqual(program.objective.min_profit_factor, Decimal("1.50"))
        self.assertEqual(program.objective.max_worst_day_loss, Decimal("999999999"))
        self.assertEqual(program.objective.max_drawdown, Decimal("999999999"))
        self.assertEqual(
            program.objective.max_worst_day_loss_pct_equity, Decimal("0.05")
        )
        self.assertEqual(program.objective.max_drawdown_pct_equity, Decimal("0.08"))
        self.assertEqual(
            program.objective.extended_max_worst_day_loss_pct_equity,
            Decimal("0.08"),
        )
        self.assertEqual(
            program.objective.extended_max_drawdown_pct_equity, Decimal("0.12")
        )
        self.assertEqual(
            program.objective.min_total_net_pnl_to_drawdown_ratio, Decimal("3.00")
        )
        self.assertFalse(program.objective.require_every_day_active)
        self.assertEqual(
            program.objective.max_gross_exposure_pct_equity, Decimal("1.0")
        )
        self.assertEqual(program.objective.min_cash, Decimal("0"))
        self.assertEqual(program.objective.min_observed_trading_days, 20)
        self.assertEqual(program.replay_budget.staged_train_screen_multiplier, 3)

        policy = runner._portfolio_oracle_policy(program)
        self.assertEqual(policy.min_profit_factor, Decimal("1.50"))
        self.assertEqual(policy.max_worst_day_loss, Decimal("999999999"))
        self.assertEqual(policy.max_drawdown, Decimal("999999999"))
        self.assertEqual(policy.default_start_equity, Decimal("31590.02"))
        self.assertEqual(policy.max_worst_day_loss_pct_equity, Decimal("0.05"))
        self.assertEqual(policy.max_drawdown_pct_equity, Decimal("0.08"))
        self.assertEqual(policy.extended_max_worst_day_loss_pct_equity, Decimal("0.08"))
        self.assertEqual(policy.extended_max_drawdown_pct_equity, Decimal("0.12"))
        self.assertEqual(policy.min_total_net_pnl_to_drawdown_ratio, Decimal("3.00"))
        self.assertEqual(policy.max_gross_exposure_pct_equity, Decimal("1.0"))
        self.assertEqual(policy.min_cash, Decimal("0"))
        self.assertEqual(policy.min_observed_trading_days, 20)

    def test_checked_in_500_portfolio_profit_program_includes_reversal_surfaces(
        self,
    ) -> None:
        program_path = Path(
            "config/trading/research-programs/portfolio-profit-autoresearch-500-v1.yaml"
        )

        program = load_strategy_autoresearch_program(
            program_path,
            family_dir=Path("config/trading/families"),
        )

        source_ids = {source.source_id for source in program.research_sources}
        self.assertTrue(
            {
                "intraday_residual_reversal_2024",
                "intraday_return_autocorrelation_term_structure_2025",
                "intraday_time_series_reversal_2025",
                "end_of_day_reversal_2024",
                "overnight_jump_intraday_reversal_2026",
                "intraday_cross_section_patterns_2010",
                "attention_factors_stat_arb_2025",
                "asymmetric_ofi_hmm_regime_2025",
                "opening_range_breakout_stocks_in_play_2024",
                "realistic_market_impact_rl_envs_2026",
                "overreaction_intraday_momentum_aapl_2026",
                "vwap_regime_classification_intraday_2026",
                "intramonth_momentum_cycle_2026",
                "structural_limits_ohlcv_intraday_2026",
                "latent_microstructure_regime_detection_2026",
                "explainable_crypto_microstructure_patterns_2026",
                "unified_order_flow_impact_volatility_2026",
                "closing_auction_market_making_2026",
                "algorithmic_retail_options_intraday_2026",
                "learning_from_book_short_run_efficiency_2026",
                "idiosyncratic_trade_imbalance_2026",
                "intraday_price_asymmetry_sp500_2026",
                "market_depth_execution_delays_2026",
                "alphacrafter_factor_execution_loop_2026",
                "financial_multi_agent_cost_awareness_2026",
                "live_market_agent_arena_2025",
                "tradetrap_system_stress_2025",
                "agentic_trading_evidence_ledger_2026",
            }.issubset(source_ids)
        )
        impact_source = next(
            source
            for source in program.research_sources
            if source.source_id == "realistic_market_impact_rl_envs_2026"
        )
        self.assertEqual(impact_source.claims[0].claim_type, "feature_recipe")
        self.assertIn("route_tca", impact_source.claims[0].data_requirements)
        self.assertEqual(impact_source.claims[0].horizon_scope, "intraday_execution")
        depth_delay_source = next(
            source
            for source in program.research_sources
            if source.source_id == "market_depth_execution_delays_2026"
        )
        self.assertEqual(depth_delay_source.claims[0].claim_type, "feature_recipe")
        self.assertIn("market_depth", depth_delay_source.claims[0].data_requirements)
        self.assertIn("execution_delay", depth_delay_source.claims[0].data_requirements)
        self.assertEqual(
            depth_delay_source.claims[0].horizon_scope, "intraday_execution"
        )
        attention_factor_source = next(
            source
            for source in program.research_sources
            if source.source_id == "attention_factors_stat_arb_2025"
        )
        self.assertEqual(
            attention_factor_source.claims[0].claim_type, "signal_mechanism"
        )
        self.assertIn(
            "residual_portfolio_returns",
            attention_factor_source.claims[0].data_requirements,
        )
        self.assertIn(
            "runtime_ledger_profit_proof",
            attention_factor_source.claims[2].data_requirements,
        )

        microbar_seed_names = {
            plan.seed_sweep_config.name
            for plan in program.families
            if plan.family_template.family_id == "microbar_cross_sectional_pairs_v1"
        }
        self.assertTrue(
            {
                "profitability-frontier-strict-daily-microbar-eod-loser-reversal.yaml",
                "profitability-frontier-strict-daily-microbar-vwap-reversal.yaml",
                "profitability-frontier-strict-daily-microbar-prev-day-open60-short-top1.yaml",
                "profitability-frontier-strict-daily-microbar-recent15-reversal-short.yaml",
                "profitability-frontier-strict-daily-microbar-vwap-stretch-reversal-long-top4.yaml",
                "profitability-frontier-portfolio-coverage-microbar-overnight-gap-reversal.yaml",
                "profitability-frontier-portfolio-coverage-microbar-opening-prev-close-reversal.yaml",
                "profitability-frontier-portfolio-coverage-microbar-tug-of-war-reversal.yaml",
            }.issubset(microbar_seed_names)
        )
        coverage_seed_payloads = {
            plan.seed_sweep_config.name: yaml.safe_load(
                plan.seed_sweep_config.read_text(encoding="utf-8")
            )
            for plan in program.families
            if plan.seed_sweep_config.name.startswith(
                "profitability-frontier-portfolio-coverage-microbar-"
            )
        }
        self.assertEqual(
            {
                "overnight_gap_reversal",
                "opening_window_prev_close_reversal",
                "intraday_tug_of_war_reversal",
            },
            {
                payload["parameters"]["signal_motif"][0]
                for payload in coverage_seed_payloads.values()
            },
        )
        for payload in coverage_seed_payloads.values():
            self.assertFalse(
                payload["consistency_constraints"]["require_every_day_active"]
            )
            self.assertEqual(
                payload["parameters"]["gate_feature"],
                ["cross_section_positive_opening_window_return_from_prev_close_ratio"],
            )
            self.assertLessEqual(
                Decimal(payload["strategy_overrides"]["max_position_pct_equity"][0]),
                Decimal("1.0"),
            )
            self.assertLessEqual(
                Decimal(payload["strategy_overrides"]["max_notional_per_trade"][0]),
                Decimal("30000"),
            )
        self.assertEqual(program.promotion_policy, "research_only")
        self.assertIn("scheduler_v3_parity_replay", program.parity_requirements)

    def test_load_program_rejects_non_mapping_schema_and_missing_families(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            program_path = root / "program.yaml"

            program_path.write_text("- item\n", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "autoresearch_program_not_mapping"):
                load_strategy_autoresearch_program(program_path, family_dir=root)

            program_path.write_text(
                yaml.safe_dump(
                    {"schema_version": "wrong", "families": []}, sort_keys=False
                ),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(
                ValueError, "autoresearch_program_schema_invalid"
            ):
                load_strategy_autoresearch_program(program_path, family_dir=root)

            program_path.write_text(
                yaml.safe_dump(
                    {
                        "schema_version": "torghut.strategy-autoresearch.v1",
                        "program_id": "empty",
                        "description": "missing families",
                        "objective": {},
                        "families": [],
                    },
                    sort_keys=False,
                ),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(
                ValueError, "autoresearch_program_missing_families"
            ):
                load_strategy_autoresearch_program(program_path, family_dir=root)

    def test_load_program_rejects_invalid_runtime_closure_policy_values(self) -> None:
        invalid_cases = [
            (
                {"parity_window": "bad"},
                "autoresearch_runtime_closure_parity_window_invalid",
            ),
            (
                {"approval_window": "bad"},
                "autoresearch_runtime_closure_approval_window_invalid",
            ),
            (
                {"shadow_validation_mode": "bad"},
                "autoresearch_runtime_closure_shadow_validation_mode_invalid",
            ),
            (
                {"promotion_target": "bad"},
                "autoresearch_runtime_closure_promotion_target_invalid",
            ),
        ]

        for overrides, expected_error in invalid_cases:
            with self.subTest(overrides=overrides):
                with TemporaryDirectory() as tmpdir:
                    root = Path(tmpdir)
                    program_path, family_dir = self._write_program_fixture(root)
                    payload = yaml.safe_load(program_path.read_text(encoding="utf-8"))
                    payload["runtime_closure_policy"] = {
                        "enabled": False,
                        "execute_parity_replay": True,
                        "execute_approval_replay": True,
                        "parity_window": "full_window",
                        "approval_window": "holdout",
                        "shadow_validation_mode": "require_live_evidence",
                        "promotion_target": "shadow",
                    }
                    payload["runtime_closure_policy"].update(overrides)
                    program_path.write_text(
                        yaml.safe_dump(payload, sort_keys=False), encoding="utf-8"
                    )

                    with self.assertRaisesRegex(ValueError, expected_error):
                        load_strategy_autoresearch_program(
                            program_path, family_dir=family_dir
                        )

    def test_load_program_skips_invalid_source_and_claim_entries(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            family_dir = root / "families"
            family_dir.mkdir()
            (family_dir / "breakout_reclaim_v2.yaml").write_text(
                yaml.safe_dump(
                    {
                        "schema_version": "torghut.family-template.v1",
                        "family_id": "breakout_reclaim_v2",
                        "economic_mechanism": "Breakout reclaim.",
                        "supported_markets": ["us_equities_intraday"],
                        "required_features": ["quote_quality"],
                        "allowed_normalizations": ["price_scaled"],
                        "entry_motifs": ["breakout_reclaim"],
                        "exit_motifs": ["trailing_stop"],
                        "risk_controls": ["stop_loss"],
                        "activity_model": {
                            "min_active_day_ratio": "0.50",
                            "min_daily_notional": "200000",
                        },
                        "liquidity_assumptions": {"max_spread_bps": "30"},
                        "regime_activation_rules": [],
                        "day_veto_rules": [],
                        "default_hard_vetoes": {},
                        "default_selection_objectives": {},
                        "runtime_harness": {
                            "family": "breakout",
                            "strategy_name": "breakout-v1",
                        },
                    },
                    sort_keys=False,
                ),
                encoding="utf-8",
            )
            sweep_path = root / "seed.yaml"
            sweep_path.write_text(
                "schema_version: torghut.replay-frontier-sweep.v1\n", encoding="utf-8"
            )
            program_path = root / "program.yaml"
            program_path.write_text(
                yaml.safe_dump(
                    {
                        "schema_version": "torghut.strategy-autoresearch.v1",
                        "program_id": "valid-ish",
                        "description": "fixture",
                        "objective": {},
                        "research_sources": [
                            "skip-me",
                            {
                                "source_id": "",
                                "title": "missing id",
                                "claims": [{"claim_id": "claim-ignored"}],
                            },
                            {
                                "source_id": "paper-1",
                                "title": "Paper 1",
                                "url": "https://example.com",
                                "published_at": "2026-01-01",
                                "claims": [
                                    "skip-claim",
                                    {"claim_id": "", "summary": "missing id"},
                                    {
                                        "claim_id": "claim-1",
                                        "summary": "ok",
                                        "implication": "use it",
                                    },
                                ],
                            },
                        ],
                        "families": [
                            "skip-family",
                            {
                                "family_template_id": "breakout_reclaim_v2",
                                "seed_sweep_config": str(sweep_path),
                            },
                        ],
                    },
                    sort_keys=False,
                ),
                encoding="utf-8",
            )

            program = load_strategy_autoresearch_program(
                program_path, family_dir=family_dir
            )

        self.assertEqual(len(program.research_sources), 1)
        self.assertEqual(program.research_sources[0].source_id, "paper-1")
        self.assertEqual(len(program.research_sources[0].claims), 1)
        self.assertEqual(program.research_sources[0].claims[0].claim_id, "claim-1")

    def test_apply_program_objective_skips_full_window_counts_when_unknown(
        self,
    ) -> None:
        updated = apply_program_objective(
            sweep_config={"constraints": {}, "consistency_constraints": {}},
            objective=StrategyObjective(
                target_net_pnl_per_day=Decimal("500"),
                min_active_day_ratio=Decimal("0.80"),
                min_positive_day_ratio=Decimal("0.55"),
                min_daily_notional=Decimal("300000"),
                max_best_day_share=Decimal("0.35"),
                max_worst_day_loss=Decimal("450"),
                max_drawdown=Decimal("1000"),
                require_every_day_active=False,
                min_regime_slice_pass_rate=Decimal("0.40"),
                stop_when_objective_met=False,
            ),
            holdout_day_count=3,
            full_window_day_count=None,
        )
        self.assertNotIn("min_active_days", updated["consistency_constraints"])
        self.assertNotIn("min_positive_days", updated["consistency_constraints"])

    def test_build_mutated_sweep_config_keeps_current_values_and_mutates_neighbors(
        self,
    ) -> None:
        family_plan = FamilyAutoresearchPlan(
            family_template=_family_template(),
            seed_sweep_config=Path("/tmp/example.yaml"),
            max_iterations=2,
            keep_top_candidates=1,
            frontier_top_n=2,
            force_keep_top_candidate_if_all_vetoed=True,
            symbol_prune_iterations=1,
            symbol_prune_candidates=1,
            symbol_prune_min_universe_size=2,
            loss_repair_iterations=1,
            loss_repair_candidates=1,
            consistency_repair_iterations=1,
            consistency_repair_candidates=2,
            parameter_mutations={
                "max_entries_per_session": MutationSpace(
                    mode="numeric_step",
                    deltas=(Decimal("-1"), Decimal("0"), Decimal("1")),
                    minimum=Decimal("1"),
                    maximum=Decimal("4"),
                )
            },
            strategy_override_mutations={
                "normalization_regime": MutationSpace(mode="allowed_normalizations")
            },
        )
        base_sweep = {
            "parameters": {
                "max_entries_per_session": ["2"],
                "entry_cooldown_seconds": ["600"],
            },
            "strategy_overrides": {
                "universe_symbols": [["AMAT", "NVDA"]],
                "max_position_pct_equity": ["10.0"],
            },
        }
        candidate = {
            "candidate_id": "candidate-1",
            "replay_config": {
                "params": {
                    "max_entries_per_session": "2",
                    "entry_cooldown_seconds": "600",
                },
                "strategy_overrides": {
                    "universe_symbols": ["AMAT", "NVDA"],
                    "max_position_pct_equity": "10.0",
                },
            },
        }

        mutated, description = build_mutated_sweep_config(
            base_sweep_config=base_sweep,
            candidate_payload=candidate,
            family_plan=family_plan,
        )

        self.assertEqual(mutated["parameters"]["entry_cooldown_seconds"], ["600"])
        self.assertEqual(
            mutated["parameters"]["max_entries_per_session"], ["2", "1", "3"]
        )
        self.assertEqual(
            mutated["strategy_overrides"]["universe_symbols"], [["AMAT", "NVDA"]]
        )
        self.assertEqual(
            mutated["strategy_overrides"]["normalization_regime"],
            ["price_scaled", "opening_window_scaled"],
        )
        self.assertIn("max_entries_per_session", description)

    def test_build_mutated_sweep_config_falls_back_when_mutation_values_are_filtered_out(
        self,
    ) -> None:
        family_plan = FamilyAutoresearchPlan(
            family_template=_family_template(),
            seed_sweep_config=Path("/tmp/example.yaml"),
            max_iterations=2,
            keep_top_candidates=1,
            frontier_top_n=2,
            force_keep_top_candidate_if_all_vetoed=True,
            symbol_prune_iterations=0,
            symbol_prune_candidates=1,
            symbol_prune_min_universe_size=2,
            loss_repair_iterations=0,
            loss_repair_candidates=1,
            consistency_repair_iterations=0,
            consistency_repair_candidates=2,
            parameter_mutations={
                "entry_cooldown_seconds": MutationSpace(
                    mode="numeric_step",
                    deltas=(Decimal("-1000"),),
                    minimum=Decimal("1"),
                    maximum=Decimal("1200"),
                ),
                "normalization_regime": MutationSpace(
                    mode="explicit_values",
                    values=("matched_filter",),
                ),
            },
            strategy_override_mutations={
                "max_position_pct_equity": MutationSpace(
                    mode="numeric_step",
                    deltas=(Decimal("100"),),
                    minimum=Decimal("0"),
                    maximum=Decimal("20"),
                )
            },
        )
        base_sweep = {
            "parameters": {
                "entry_cooldown_seconds": ["600"],
            },
            "strategy_overrides": {
                "max_position_pct_equity": ["10.0"],
            },
        }
        candidate = {
            "candidate_id": "candidate-2",
            "replay_config": {
                "params": {
                    "entry_cooldown_seconds": "600",
                },
                "strategy_overrides": {
                    "max_position_pct_equity": "10.0",
                },
            },
        }

        mutated, description = build_mutated_sweep_config(
            base_sweep_config=base_sweep,
            candidate_payload=candidate,
            family_plan=family_plan,
        )

        self.assertEqual(mutated["parameters"]["entry_cooldown_seconds"], ["600"])
        self.assertEqual(
            mutated["parameters"]["normalization_regime"], ["matched_filter"]
        )
        self.assertEqual(
            mutated["strategy_overrides"]["max_position_pct_equity"], ["10.0"]
        )
        self.assertIn("candidate-2", description)

    def test_candidate_meets_objective_respects_vetoes(self) -> None:
        objective = StrategyObjective(
            target_net_pnl_per_day=Decimal("500"),
            min_active_day_ratio=Decimal("0.80"),
            min_positive_day_ratio=Decimal("0.55"),
            min_daily_notional=Decimal("300000"),
            max_best_day_share=Decimal("0.35"),
            max_worst_day_loss=Decimal("450"),
            max_drawdown=Decimal("1000"),
            require_every_day_active=False,
            min_regime_slice_pass_rate=Decimal("0.40"),
            stop_when_objective_met=False,
            max_gross_exposure_pct_equity=Decimal("1.50"),
            min_cash=Decimal("0"),
        )
        candidate = {
            "hard_vetoes": [],
            "objective_scorecard": {
                "net_pnl_per_day": "600",
                "active_day_ratio": "0.80",
                "positive_day_ratio": "0.60",
                "avg_filled_notional_per_day": "350000",
                "best_day_share": "0.30",
                "worst_day_loss": "300",
                "max_drawdown": "900",
                "regime_slice_pass_rate": "0.45",
                "max_gross_exposure_pct_equity": "1.25",
                "min_cash": "2500",
            },
            "full_window": {"trading_day_count": 9, "active_days": 7},
        }
        self.assertTrue(candidate_meets_objective(candidate, objective=objective))
        over_levered = copy.deepcopy(candidate)
        over_levered["objective_scorecard"]["max_gross_exposure_pct_equity"] = "1.51"
        self.assertFalse(candidate_meets_objective(over_levered, objective=objective))
        negative_cash = copy.deepcopy(candidate)
        negative_cash["objective_scorecard"]["min_cash"] = "-0.01"
        self.assertFalse(candidate_meets_objective(negative_cash, objective=objective))
        vetoed = dict(candidate)
        vetoed["hard_vetoes"] = ["best_day_share_above_max"]
        self.assertFalse(candidate_meets_objective(vetoed, objective=objective))

    def test_candidate_meets_objective_allows_return_adjusted_drawdown(self) -> None:
        objective = StrategyObjective(
            target_net_pnl_per_day=Decimal("500"),
            min_active_day_ratio=Decimal("0.80"),
            min_positive_day_ratio=Decimal("0.60"),
            min_daily_notional=Decimal("300000"),
            max_best_day_share=Decimal("0.35"),
            max_worst_day_loss=Decimal("999999999"),
            max_drawdown=Decimal("999999999"),
            require_every_day_active=False,
            min_regime_slice_pass_rate=Decimal("0.40"),
            stop_when_objective_met=False,
            max_gross_exposure_pct_equity=Decimal("1.50"),
            min_cash=Decimal("0"),
        )
        candidate = {
            "hard_vetoes": [],
            "objective_scorecard": {
                "net_pnl_per_day": "9666.67",
                "active_day_ratio": "1",
                "positive_day_ratio": "0.67",
                "avg_filled_notional_per_day": "700000",
                "best_day_share": "0.30",
                "worst_day_loss": "2400",
                "max_drawdown": "3000",
                "regime_slice_pass_rate": "0.45",
                "max_gross_exposure_pct_equity": "1.25",
                "min_cash": "2500",
            },
            "full_window": {
                "trading_day_count": 3,
                "active_days": 3,
                "daily_net": {
                    "2026-04-01": "-2400",
                    "2026-04-02": "17000",
                    "2026-04-03": "15000",
                },
            },
        }

        self.assertTrue(candidate_meets_objective(candidate, objective=objective))

    def test_candidate_meets_objective_requires_daily_minimum_when_configured(
        self,
    ) -> None:
        objective = StrategyObjective(
            target_net_pnl_per_day=Decimal("300"),
            min_daily_net_pnl=Decimal("300"),
            min_active_day_ratio=Decimal("1.0"),
            min_positive_day_ratio=Decimal("1.0"),
            min_daily_notional=Decimal("300000"),
            max_best_day_share=Decimal("0.60"),
            max_worst_day_loss=Decimal("0"),
            max_drawdown=Decimal("0"),
            require_every_day_active=True,
            min_regime_slice_pass_rate=Decimal("0.40"),
            stop_when_objective_met=False,
        )
        candidate = {
            "hard_vetoes": [],
            "objective_scorecard": {
                "net_pnl_per_day": "500",
                "active_day_ratio": "1",
                "positive_day_ratio": "1",
                "avg_filled_notional_per_day": "350000",
                "best_day_share": "0.40",
                "worst_day_loss": "0",
                "max_drawdown": "0",
                "regime_slice_pass_rate": "0.45",
            },
            "full_window": {
                "trading_day_count": 3,
                "active_days": 3,
                "daily_net": {
                    "2026-04-01": "900",
                    "2026-04-02": "300",
                    "2026-04-03": "300",
                },
            },
        }
        self.assertTrue(candidate_meets_objective(candidate, objective=objective))

        weak_day = copy.deepcopy(candidate)
        weak_day["full_window"]["daily_net"]["2026-04-02"] = "299.99"
        self.assertFalse(candidate_meets_objective(weak_day, objective=objective))
