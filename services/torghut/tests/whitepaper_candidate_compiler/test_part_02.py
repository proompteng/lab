from __future__ import annotations

# ruff: noqa: F401,F403,F405
from tests.whitepaper_candidate_compiler.support import *


class TestWhitepaperCandidateCompilerPart2(_TestWhitepaperCandidateCompilerBase):
    def test_intraday_price_flow_macro_news_claims_compile_with_strict_replay_gates(
        self,
    ) -> None:
        compilation = compile_claim_payloads_to_whitepaper_experiments(
            run_id="paper-arxiv-2508-06788",
            claims=[
                {
                    "claim_id": "one-second-price-flow-impact-decay",
                    "claim_type": "signal_mechanism",
                    "claim_text": (
                        "One-second price-flow dynamics and order flow imbalance "
                        "decay quickly and are horizon dependent."
                    ),
                    "data_requirements": [
                        "order_flow_imbalance",
                        "price_flow_impact",
                        "flow_impact_decay",
                        "forecast_horizon",
                    ],
                    "confidence": "0.74",
                },
                {
                    "claim_id": "macro-news-price-flow-regime",
                    "claim_type": "market_regime",
                    "claim_text": (
                        "Macroeconomic news changes price impact, flow impact, "
                        "volatility, and liquidity regimes."
                    ),
                    "data_requirements": [
                        "macro_announcement_window",
                        "realized_volatility",
                        "spread_bps",
                        "route_tca",
                    ],
                    "confidence": "0.73",
                },
                {
                    "claim_id": "macro-news-heldout-replay-required",
                    "claim_type": "validation_requirement",
                    "claim_text": (
                        "Macro-news and non-news windows require separate walk-forward "
                        "replay, live-paper parity, and transaction-cost stress."
                    ),
                    "data_requirements": [
                        "walk_forward_replay",
                        "live_paper_parity",
                        "transaction_cost_stress",
                    ],
                    "confidence": "0.73",
                },
            ],
            target_net_pnl_per_day=Decimal("500"),
            family_template_dir=Path("config/trading/families"),
            seed_sweep_dir=Path("config/trading"),
        )

        family_ids = {spec.family_template_id for spec in compilation.executable_specs}

        self.assertTrue(compilation.executable_specs)
        self.assertIn("intraday_tsmom_v2", family_ids)
        self.assertIn("microstructure_continuation_matched_filter_v1", family_ids)
        self.assertFalse(
            [
                blocker
                for blocker in compilation.blockers
                if blocker.reason == "required_features_missing_from_family_template"
            ]
        )
        self.assertTrue(
            any(
                "macro_announcement_dvar_momentum"
                in spec.parameter_space["mechanism_overlay_ids"]
                for spec in compilation.executable_specs
            )
        )
        self.assertTrue(
            any(
                spec.hard_vetoes.get("required_event_non_event_holdout_replay")
                for spec in compilation.executable_specs
            )
        )
        self.assertTrue(
            all(
                spec.promotion_contract.get("requires_live_paper_parity")
                for spec in compilation.executable_specs
            )
        )

    def test_red2400_rejected_outcome_claim_compiles_to_counterfactual_calibration_overlay(
        self,
    ) -> None:
        compilation = compile_claim_payloads_to_whitepaper_experiments(
            run_id="paper-arxiv-2605.12151",
            claims=[
                {
                    "claim_id": "rejection-event-outcome-labels",
                    "claim_type": "signal_mechanism",
                    "claim_text": (
                        "Algorithmically rejected trading events with realized outcome "
                        "labels can turn skipped-signal logs into counterfactual "
                        "learning examples for veto calibration."
                    ),
                    "asset_scope": "intraday_execution",
                    "horizon_scope": "rejected_event_learning",
                    "expected_direction": "neutral",
                    "data_requirements": [
                        "rejected_signal_log",
                        "outcome_labels",
                        "executable_quote",
                    ],
                    "confidence": "0.76",
                },
                {
                    "claim_id": "counterfactual-reject-outcome-learning",
                    "claim_type": "validation_requirement",
                    "claim_text": (
                        "Rejected-event benchmarks should measure whether current "
                        "vetoes discard profitable, executable opportunities or "
                        "correctly block bad fills."
                    ),
                    "asset_scope": "intraday_execution",
                    "horizon_scope": "rejected_event_learning",
                    "expected_direction": "neutral",
                    "data_requirements": [
                        "rejected_signal_log",
                        "counterfactual_return",
                        "route_tca",
                        "post_cost_net_pnl",
                    ],
                    "confidence": "0.76",
                },
            ],
            relations=[
                {
                    "relation_id": "rejected-outcome-labels-calibrate-vetoes",
                    "relation_type": "requires_validation",
                    "source_claim_id": "counterfactual-reject-outcome-learning",
                    "target_claim_id": "rejection-event-outcome-labels",
                }
            ],
            target_net_pnl_per_day=Decimal("500"),
            family_template_dir=Path("config/trading/families"),
            seed_sweep_dir=Path("config/trading"),
        )

        family_ids = {spec.family_template_id for spec in compilation.executable_specs}

        self.assertTrue(compilation.executable_specs)
        self.assertTrue(
            {
                "microstructure_continuation_matched_filter_v1",
                "microbar_cross_sectional_pairs_v1",
                "opening_drive_leader_reclaim_v1",
            }.issubset(family_ids)
        )
        self.assertNotIn("intraday_tsmom_v2", family_ids)
        self.assertTrue(
            any(
                spec.strategy_overrides.get("params", {}).get("veto_relaxation_scope")
                == "labeled_false_negative_only"
                for spec in compilation.executable_specs
            )
        )
        self.assertTrue(
            any(
                "rejected_signal_outcome_calibration"
                in spec.parameter_space.get("mechanism_overlay_ids", [])
                for spec in compilation.executable_specs
            )
        )
        self.assertTrue(
            all(
                spec.hard_vetoes.get("required_min_rejected_signal_outcome_label_count")
                == "120"
                for spec in compilation.executable_specs
            )
        )
        self.assertTrue(
            all(
                spec.promotion_contract.get("requires_rejected_signal_outcome_learning")
                for spec in compilation.executable_specs
            )
        )
        self.assertTrue(
            all(
                spec.promotion_contract.get(
                    "rejects_pending_rejected_signal_outcome_labels"
                )
                for spec in compilation.executable_specs
            )
        )
        self.assertTrue(
            all(
                spec.promotion_contract.get("requires_live_paper_parity")
                for spec in compilation.executable_specs
            )
        )
        self.assertTrue(
            all(
                spec.promotion_contract.get("promotion_impact")
                == "repair_only_until_labeled"
                for spec in compilation.executable_specs
            )
        )

    def test_structural_ohlcv_falsification_claims_stay_executable_but_not_promotable(
        self,
    ) -> None:
        compilation = compile_claim_payloads_to_whitepaper_experiments(
            run_id="paper-arxiv-2605-04004",
            claims=[
                {
                    "claim_id": "gap-continuation-positive-control",
                    "claim_type": "signal_mechanism",
                    "claim_text": (
                        "A gap-continuation setup can be retained only as a positive-control "
                        "hypothesis because it showed statistical strength but failed minimum "
                        "sample requirements."
                    ),
                    "data_requirements": [
                        "gap_velocity",
                        "executable_quote",
                        "walk_forward_replay",
                    ],
                    "confidence": "0.70",
                    "expected_failure_modes": [
                        "insufficient_trade_count",
                        "fails_transaction_cost_stress",
                    ],
                },
                {
                    "claim_id": "ohlcv-only-intraday-falsification",
                    "claim_type": "validation_requirement",
                    "claim_text": (
                        "OHLCV-only intraday momentum signals can fail under realistic "
                        "execution constraints despite attractive naive backtests."
                    ),
                    "data_requirements": [
                        "executable_quote",
                        "route_tca",
                        "walk_forward_replay",
                    ],
                    "confidence": "0.76",
                },
                {
                    "claim_id": "walk-forward-cost-constraints-required",
                    "claim_type": "risk_constraint",
                    "claim_text": (
                        "Walk-forward validation and market-microstructure cost constraints "
                        "are required to falsify overfit intraday signals."
                    ),
                    "data_requirements": [
                        "walk_forward_replay",
                        "transaction_cost_stress",
                        "live_paper_parity",
                    ],
                    "confidence": "0.75",
                },
            ],
            relations=[
                {
                    "relation_id": "ohlcv-falsification-requires-live-paper-proof",
                    "relation_type": "requires_validation",
                    "source_claim_id": "walk-forward-cost-constraints-required",
                    "target_claim_id": "ohlcv-only-intraday-falsification",
                }
            ],
            target_net_pnl_per_day=Decimal("500"),
            family_template_dir=Path("config/trading/families"),
            seed_sweep_dir=Path("config/trading"),
        )

        self.assertTrue(compilation.executable_specs)
        self.assertFalse(
            [
                blocker
                for blocker in compilation.blockers
                if blocker.reason == "contradictory_claim_relation"
            ]
        )
        self.assertTrue(
            any(
                "ohlcv_only_falsification"
                in spec.parameter_space.get("mechanism_overlay_ids", [])
                for spec in compilation.executable_specs
            )
        )
        self.assertTrue(
            any(
                spec.hard_vetoes.get("required_min_ohlcv_falsification_trade_count")
                == "120"
                for spec in compilation.executable_specs
            )
        )
        self.assertTrue(
            all(
                spec.promotion_contract.get("rejects_ohlcv_only_promotion_evidence")
                for spec in compilation.executable_specs
            )
        )

    def test_recent_execution_and_event_stream_claim_aliases_compile_to_runtime_families(
        self,
    ) -> None:
        compilation = compile_claim_payloads_to_whitepaper_experiments(
            run_id="paper-recent-execution-event-stream",
            claims=[
                {
                    "claim_id": "mixed-market-limit-execution-policy",
                    "claim_type": "signal_mechanism",
                    "claim_text": (
                        "Dynamic allocation between market and limit orders can improve "
                        "execution when fill probability and shortfall are modeled together."
                    ),
                    "data_requirements": [
                        "market_limit_order_mix",
                        "limit_fill_probability",
                        "logistic_normal_execution_policy",
                    ],
                    "confidence": "0.74",
                },
                {
                    "claim_id": "lobdiff-time-event-prediction",
                    "claim_type": "feature_recipe",
                    "claim_text": (
                        "Diffusion modeling can forecast LOB event-time and event-type state "
                        "with skip-step sampling for lower-latency inference."
                    ),
                    "data_requirements": [
                        "lob_diffusion_event_stream",
                        "time_event_joint_distribution",
                        "skip_step_sampling",
                    ],
                    "confidence": "0.72",
                },
                {
                    "claim_id": "neural-hawkes-fill-stress",
                    "claim_type": "validation_requirement",
                    "claim_text": (
                        "Neural-Hawkes LOB simulation and mixed-order execution need fill-model, "
                        "route TCA, live-paper parity, and latency stress before capital routing."
                    ),
                    "data_requirements": [
                        "neural_hawkes_event_stream",
                        "synthetic_lob_fill_parity",
                        "route_tca",
                        "latency_stress",
                        "live_paper_parity",
                    ],
                    "confidence": "0.73",
                },
            ],
            target_net_pnl_per_day=Decimal("500"),
            family_template_dir=Path("config/trading/families"),
            seed_sweep_dir=Path("config/trading"),
        )

        self.assertTrue(compilation.executable_specs)
        self.assertFalse(
            [
                blocker
                for blocker in compilation.blockers
                if blocker.reason == "required_features_missing_from_family_template"
            ]
        )

    def test_bootstrap_robust_optimization_aliases_compile_to_runtime_families(
        self,
    ) -> None:
        compilation = compile_claim_payloads_to_whitepaper_experiments(
            run_id="paper-bootstrap-robust-optimization",
            claims=[
                {
                    "claim_id": "bootstrap-robust-optimization",
                    "claim_type": "strategy_mechanism",
                    "claim_text": (
                        "Non-parametric bootstrap robust optimization uses "
                        "resampled confidence intervals and utility-percentile "
                        "selection to reduce overfitting and selection bias."
                    ),
                    "data_requirements": [
                        "bootstrap_confidence_interval",
                        "utility_percentile",
                        "resampled_strategy_optimization",
                    ],
                    "confidence": "0.78",
                },
                {
                    "claim_id": "bootstrap-robust-validation",
                    "claim_type": "validation_requirement",
                    "claim_text": (
                        "Promotion requires parameter instability stress, "
                        "model misspecification stress, and out-of-sample "
                        "generalization."
                    ),
                    "data_requirements": [
                        "parameter_instability_stress",
                        "selection_bias_stress",
                        "model_misspecification_stress",
                        "out_of_sample_generalization",
                    ],
                    "confidence": "0.76",
                },
            ],
            target_net_pnl_per_day=Decimal("500"),
            family_template_dir=Path("config/trading/families"),
            seed_sweep_dir=Path("config/trading"),
        )

        self.assertTrue(compilation.executable_specs)
        self.assertFalse(
            [
                blocker
                for blocker in compilation.blockers
                if blocker.reason == "required_features_missing_from_family_template"
            ]
        )
        self.assertTrue(
            any(
                "bootstrap_robust_optimization_stability"
                in spec.parameter_space.get("mechanism_overlay_ids", [])
                for spec in compilation.executable_specs
            )
        )

    def test_missing_family_template_blocks_execution(self) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-run-2",
            claims=[
                {
                    "claim_id": "claim-flow",
                    "claim_type": "signal_mechanism",
                    "claim_text": "Clustered order flow imbalance improves short-horizon LOB signals.",
                    "confidence": "0.82",
                }
            ],
        )

        compilation = compile_whitepaper_candidate_specs(
            hypothesis_cards=cards,
            target_net_pnl_per_day=Decimal("500"),
            family_template_dir=Path("/tmp/does-not-exist-torghut-families"),
        )

        self.assertEqual(len(compilation.executable_specs), 0)
        self.assertEqual(
            len(compilation.blocked_specs), _expected_portfolio_target_candidate_count()
        )
        self.assertEqual(compilation.blockers[0].reason, "family_template_missing")

    def test_late_day_continuation_family_is_executable_from_fresh_momentum_claim(
        self,
    ) -> None:
        compilation = compile_claim_payloads_to_whitepaper_experiments(
            run_id="paper-run-late-day",
            claims=[
                {
                    "claim_id": "claim-late-momentum",
                    "claim_type": "signal_mechanism",
                    "claim_text": (
                        "Macro announcement information strengthens late-day intraday momentum "
                        "into the close with VWAP exit confirmation."
                    ),
                    "required_features": [
                        "macro_announcement_window",
                        "weighted_microprice_momentum",
                        "spread_bps",
                    ],
                    "confidence": "0.74",
                },
                {
                    "claim_id": "claim-late-validation",
                    "claim_type": "validation_requirement",
                    "claim_text": "The sleeve must pass non-announcement held-out days and transaction-cost stress.",
                    "required_features": ["transaction_cost_stress"],
                    "confidence": "0.72",
                },
            ],
            target_net_pnl_per_day=Decimal("300"),
            family_template_dir=Path("config/trading/families"),
            seed_sweep_dir=Path("config/trading"),
        )

        late_day_specs = [
            spec
            for spec in compilation.executable_specs
            if spec.family_template_id == "late_day_continuation_v1"
        ]
        self.assertEqual(len(late_day_specs), 3)
        self.assertEqual(
            {
                spec.feature_contract["execution_profile"]["profile_id"]
                for spec in late_day_specs
            },
            {
                "late_day_continuation_v1:profile-1",
                "late_day_continuation_v1:profile-2",
                "late_day_continuation_v1:profile-3",
            },
        )
        self.assertTrue(
            all(
                spec.runtime_strategy_name == "late-day-continuation-long-v1"
                for spec in late_day_specs
            )
        )
        self.assertTrue(
            all(
                spec.objective["target_net_pnl_per_day"] == "300"
                for spec in late_day_specs
            )
        )
        self.assertTrue(
            all(
                "macro_announcement_dvar_momentum"
                in spec.parameter_space["mechanism_overlay_ids"]
                for spec in late_day_specs
            )
        )
        self.assertTrue(
            all(
                spec.promotion_contract.get("rejects_pooled_macro_and_non_macro_replay")
                for spec in late_day_specs
            )
        )

    def test_end_of_day_reversal_family_is_executable_from_loser_reversal_claim(
        self,
    ) -> None:
        compilation = compile_claim_payloads_to_whitepaper_experiments(
            run_id="paper-run-eod-reversal",
            claims=[
                {
                    "claim_id": "claim-eod-reversal",
                    "claim_type": "signal_mechanism",
                    "claim_text": (
                        "Individual-stock losers can reverse in the final 30 minutes "
                        "with closing-window rebid confirmation."
                    ),
                    "required_features": [
                        "closing_window",
                        "intraday_return_rank",
                        "quote_quality",
                    ],
                    "confidence": "0.77",
                },
                {
                    "claim_id": "claim-eod-validation",
                    "claim_type": "validation_requirement",
                    "claim_text": "The reversal sleeve must pass held-out transaction-cost stress.",
                    "required_features": ["transaction_cost_stress"],
                    "confidence": "0.72",
                },
            ],
            target_net_pnl_per_day=Decimal("300"),
            family_template_dir=Path("config/trading/families"),
            seed_sweep_dir=Path("config/trading"),
        )

        eod_specs = [
            spec
            for spec in compilation.executable_specs
            if spec.family_template_id == "end_of_day_reversal_v1"
        ]
        self.assertEqual(len(eod_specs), 2)
        self.assertEqual(
            {
                spec.feature_contract["execution_profile"]["profile_id"]
                for spec in eod_specs
            },
            {
                "end_of_day_reversal_v1:profile-1",
                "end_of_day_reversal_v1:profile-2",
            },
        )
        self.assertTrue(
            all(
                spec.runtime_strategy_name == "end-of-day-reversal-long-v1"
                for spec in eod_specs
            )
        )
        self.assertTrue(
            all(spec.objective["target_net_pnl_per_day"] == "300" for spec in eod_specs)
        )

    def test_short_exhaustion_family_is_executable_from_fade_claim(self) -> None:
        compilation = compile_claim_payloads_to_whitepaper_experiments(
            run_id="paper-run-short-exhaustion",
            claims=[
                {
                    "claim_id": "claim-short-exhaustion",
                    "claim_type": "signal_mechanism",
                    "claim_text": (
                        "Short-side upside exhaustion fade with offer pressure can "
                        "profit from overbought intraday weakness."
                    ),
                    "required_features": [
                        "session_open_extension",
                        "offer_pressure",
                        "quote_quality",
                    ],
                    "confidence": "0.79",
                }
            ],
            target_net_pnl_per_day=Decimal("300"),
            family_template_dir=Path("config/trading/families"),
            seed_sweep_dir=Path("config/trading"),
        )

        short_specs = [
            spec
            for spec in compilation.executable_specs
            if spec.family_template_id == "mean_reversion_exhaustion_short_v1"
        ]
        self.assertEqual(len(short_specs), 3)
        self.assertFalse(
            [
                blocker
                for blocker in compilation.blockers
                if blocker.reason == "required_features_missing_from_family_template"
            ]
        )
        self.assertTrue(
            all(
                spec.runtime_strategy_name == "mean-reversion-exhaustion-short-v1"
                for spec in short_specs
            )
        )

    def test_momentum_and_reversal_families_cover_inferred_feature_contracts(
        self,
    ) -> None:
        momentum = compile_claim_payloads_to_whitepaper_experiments(
            run_id="paper-run-momentum-contract",
            claims=[
                {
                    "claim_id": "claim-momentum-contract",
                    "claim_type": "signal_mechanism",
                    "claim_text": (
                        "Fresh intraday momentum and trend persistence in chip stocks "
                        "support pullback continuation entries."
                    ),
                    "confidence": "0.76",
                }
            ],
            target_net_pnl_per_day=Decimal("300"),
            family_template_dir=Path("config/trading/families"),
            seed_sweep_dir=Path("config/trading"),
        )
        momentum_family_ids = {
            spec.family_template_id for spec in momentum.executable_specs
        }

        self.assertTrue(
            {
                "momentum_pullback_v1",
                "intraday_tsmom_v2",
            }.issubset(momentum_family_ids)
        )
        self.assertFalse(
            [
                blocker
                for blocker in momentum.blockers
                if blocker.reason == "required_features_missing_from_family_template"
            ]
        )

        reversal = compile_claim_payloads_to_whitepaper_experiments(
            run_id="paper-run-reversal-contract",
            claims=[
                {
                    "claim_id": "claim-reversal-contract",
                    "claim_type": "signal_mechanism",
                    "claim_text": (
                        "Intraday washout reversal and mean reversion in liquid chip "
                        "stocks support controlled rebound entries."
                    ),
                    "confidence": "0.76",
                }
            ],
            target_net_pnl_per_day=Decimal("300"),
            family_template_dir=Path("config/trading/families"),
            seed_sweep_dir=Path("config/trading"),
        )
        reversal_family_ids = {
            spec.family_template_id for spec in reversal.executable_specs
        }

        self.assertTrue(
            {
                "washout_rebound_v2",
                "mean_reversion_rebound_v1",
            }.issubset(reversal_family_ids)
        )
        self.assertFalse(
            [
                blocker
                for blocker in reversal.blockers
                if blocker.reason == "required_features_missing_from_family_template"
            ]
        )

    def test_missing_seed_sweep_blocks_execution(self) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-run-3",
            claims=[
                {
                    "claim_id": "claim-flow",
                    "claim_type": "signal_mechanism",
                    "claim_text": "Clustered order flow imbalance improves short-horizon LOB signals.",
                    "confidence": "0.82",
                }
            ],
        )

        with TemporaryDirectory() as tmpdir:
            compilation = compile_whitepaper_candidate_specs(
                hypothesis_cards=cards,
                target_net_pnl_per_day=Decimal("500"),
                family_template_dir=Path("config/trading/families"),
                seed_sweep_dir=Path(tmpdir),
            )

        self.assertEqual(compilation.executable_specs, ())
        self.assertEqual(
            len(compilation.blocked_specs), _expected_portfolio_target_candidate_count()
        )
        self.assertEqual(compilation.blockers[0].reason, "seed_sweep_missing")

    def test_cached_catalog_helpers_skip_invalid_seed_rows(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            family_dir = root / "families"
            seed_dir = root / "seeds"
            family_dir.mkdir()
            seed_dir.mkdir()
            (family_dir / "cached_family.yaml").write_text(
                "\n".join(
                    [
                        "required_features:",
                        "  - order_flow_imbalance",
                        "risk_controls:",
                        "  - volatility_shock_veto",
                        "liquidity_assumptions:",
                        "  quote_quality: true",
                    ]
                )
                + "\n",
                encoding="utf-8",
            )
            (seed_dir / "profitability-frontier-invalid.yaml").write_text(
                "- not-a-mapping\n",
                encoding="utf-8",
            )
            (seed_dir / "profitability-frontier-valid.yaml").write_text(
                "family_template_id: cached_family\n",
                encoding="utf-8",
            )

            self.assertEqual(
                compiler_module._family_feature_catalog(family_dir),
                {"order_flow_imbalance", "volatility_shock_veto", "quote_quality"},
            )
            self.assertEqual(
                compiler_module._seed_sweep_family_ids(seed_dir),
                {"cached_family"},
            )
