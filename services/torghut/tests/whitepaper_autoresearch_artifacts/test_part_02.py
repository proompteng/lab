from __future__ import annotations

# ruff: noqa: F401,F403,F405
from tests.whitepaper_autoresearch_artifacts.support import *


class TestWhitepaperAutoresearchArtifactsPart2(
    _TestWhitepaperAutoresearchArtifactsBase
):
    def test_evidence_bundle_parses_serialized_false_survival_booleans(self) -> None:
        bundle = evidence_bundle_from_frontier_candidate(
            candidate_spec_id="spec-serialized-false-proof",
            candidate={
                "candidate_id": "cand-serialized-false-proof",
                "objective_scorecard": {
                    "net_pnl_per_day": "650",
                    "delay_adjusted_depth_stress_passed": "false",
                    "delay_adjusted_depth_stress_model": "latency_depth_haircut",
                    "delay_adjusted_depth_stress_ms": "50",
                    "delay_adjusted_depth_stress_artifact_ref": "/tmp/depth.json",
                    "delay_adjusted_depth_tail_coverage_passed": "0",
                    "delay_adjusted_depth_p10_active_day_fillable_notional": "250000",
                    "delay_adjusted_depth_worst_active_day_fillable_notional": "200000",
                    "delay_adjusted_depth_stress_net_pnl_per_day": "540",
                    "fill_survival_evidence_present": "false",
                    "fill_survival_sample_count": "12",
                    "fill_survival_fill_rate": "0.85",
                },
                "full_window": {
                    "net_per_day": "650",
                    "trading_day_count": "1",
                    "avg_filled_notional_per_day": "350000",
                    "daily_filled_notional": {"2026-02-23": "350000"},
                    "daily_liquidity_notional": {"2026-02-23": "900000"},
                },
                "promotion_readiness": {
                    "stage": "paper_probation",
                    "status": "promotion_ready",
                    "promotable": "true",
                    "blockers": [],
                },
            },
            dataset_snapshot_id="snap-serialized-false-proof",
            result_path="/tmp/serialized-false-proof.json",
        )

        blockers = evidence_bundle_blockers(bundle)

        self.assertIn("delay_adjusted_depth_stress_failed", blockers)
        self.assertIn("delay_adjusted_depth_tail_coverage_missing", blockers)
        self.assertIn("fill_survival_evidence_missing", blockers)

    def test_evidence_bundle_fallback_stress_uses_fill_survival_rate(self) -> None:
        bundle = evidence_bundle_from_frontier_candidate(
            candidate_spec_id="spec-survival-adjusted-fallback",
            candidate={
                "candidate_id": "cand-survival-adjusted-fallback",
                "objective_scorecard": {
                    "net_pnl_per_day": "100",
                    "fill_survival_evidence_present": True,
                    "fill_survival_sample_count": 10,
                    "fill_survival_fill_rate": "0.01",
                },
                "full_window": {
                    "net_per_day": "100",
                    "trading_day_count": "1",
                    "avg_filled_notional_per_day": "100000",
                    "daily_filled_notional": {"2026-02-23": "100000"},
                    "daily_liquidity_notional": {"2026-02-23": "1000000"},
                },
                "promotion_readiness": {
                    "stage": "paper_probation",
                    "status": "promotion_ready",
                    "promotable": True,
                    "blockers": [],
                },
            },
            dataset_snapshot_id="snap-survival-adjusted-fallback",
            result_path="/tmp/survival-adjusted-fallback.json",
        )

        self.assertEqual(
            bundle.objective_scorecard[
                "delay_adjusted_depth_survival_adjusted_fillable_ratio"
            ],
            "0.01",
        )
        self.assertEqual(
            bundle.objective_scorecard["delay_adjusted_depth_stress_net_pnl_per_day"],
            "-9.00",
        )
        blockers = evidence_bundle_blockers(bundle)
        self.assertIn("delay_adjusted_depth_stress_failed", blockers)
        self.assertIn("delay_adjusted_depth_stress_net_pnl_non_positive", blockers)

    def test_evidence_bundle_copies_fill_survival_from_full_window(
        self,
    ) -> None:
        bundle = evidence_bundle_from_frontier_candidate(
            candidate_spec_id="spec-stage-proof",
            candidate={
                "candidate_id": "cand-stage-proof",
                "objective_scorecard": {
                    "net_pnl_per_day": "650",
                    "market_impact_stress_passed": True,
                    "market_impact_stress_artifact_ref": "/tmp/stage-proof.json",
                    "market_impact_stress_model": "nonlinear_square_root_impact",
                    "market_impact_stress_cost_bps": "1",
                    "market_impact_stress_net_pnl_per_day": "650",
                    "market_impact_stress_components": {
                        "source_marker": "realistic_market_impact_arxiv_2603_29086_2026"
                    },
                    "delay_adjusted_depth_stress_passed": True,
                    "delay_adjusted_depth_tail_coverage_passed": True,
                    "fill_survival_evidence_present": True,
                    "fill_survival_sample_count": 8,
                },
                "full_window": {
                    "net_per_day": "650",
                    "trading_day_count": "1",
                    "avg_filled_notional_per_day": "350000",
                    "daily_filled_notional": {"2026-02-23": "350000"},
                    "daily_liquidity_notional": {"2026-02-23": "900000"},
                    "fill_survival_fill_rate": "0.75",
                    "queue_ahead_depletion_evidence_present": True,
                    "queue_ahead_depletion_sample_count": 8,
                    "queue_position_survival_fill_curve_evidence_present": True,
                    "queue_position_survival_sample_count": 8,
                    "queue_position_survival_fill_rate": "0.75",
                    "queue_position_survival_queue_ahead_depletion_evidence_present": (
                        True
                    ),
                    "queue_position_survival_queue_ahead_depletion_sample_count": 8,
                    "queue_position_survival_adjusted_fillable_ratio": "0.75",
                    "post_cost_net_pnl_after_queue_position_survival_fill_stress": (
                        "487.50"
                    ),
                },
                "promotion_readiness": {
                    "stage": "paper_probation",
                    "status": "candidate_review",
                    "promotable": False,
                    "blockers": [],
                },
            },
            dataset_snapshot_id="snap-stage-proof",
            result_path="/tmp/stage-proof.json",
        )

        blockers = evidence_bundle_blockers(bundle)

        self.assertEqual(bundle.objective_scorecard["fill_survival_fill_rate"], "0.75")
        self.assertTrue(
            bundle.objective_scorecard[
                "queue_position_survival_fill_curve_evidence_present"
            ]
        )
        self.assertEqual(
            bundle.objective_scorecard[
                "post_cost_net_pnl_after_queue_position_survival_fill_stress"
            ],
            "487.50",
        )
        self.assertEqual(blockers, ())

    def test_evidence_bundle_blocks_stage_promotion_with_missing_depth_fields(
        self,
    ) -> None:
        bundle = evidence_bundles_module.CandidateEvidenceBundle(
            schema_version=evidence_bundles_module.EVIDENCE_BUNDLE_SCHEMA_VERSION,
            evidence_bundle_id="bundle-stage-proof",
            candidate_id="cand-stage-proof",
            candidate_spec_id="spec-stage-proof",
            dataset_snapshot_id="snap-stage-proof",
            feature_spec_hash="feature-hash",
            code_commit="commit-sha",
            replay_artifact_refs=(),
            objective_scorecard={
                "delay_adjusted_depth_stress_passed": True,
                "delay_adjusted_depth_tail_coverage_passed": True,
                "fill_survival_evidence_present": True,
                "fill_survival_sample_count": 8,
            },
            fold_metrics=(),
            stress_metrics=(),
            cost_calibration={},
            null_comparator={},
            promotion_readiness={
                "stage": "paper_probation",
                "status": "candidate_review",
                "promotable": False,
            },
        )

        blockers = evidence_bundle_blockers(bundle)

        self.assertIn("delay_adjusted_depth_stress_model_missing", blockers)
        self.assertIn("delay_adjusted_depth_stress_ms_missing", blockers)
        self.assertIn("delay_adjusted_depth_stress_artifact_missing", blockers)
        self.assertIn("delay_adjusted_depth_p10_fillable_non_positive", blockers)
        self.assertIn("delay_adjusted_depth_worst_fillable_non_positive", blockers)

    def test_evidence_bundle_marks_order_type_execution_artifact_without_ablation(
        self,
    ) -> None:
        bundle = evidence_bundle_from_frontier_candidate(
            candidate_spec_id="spec-order-type-execution",
            candidate={
                "candidate_id": "cand-order-type-execution",
                "runtime_family": "microbar_cross_sectional_pairs",
                "runtime_strategy_name": "microbar-cross-sectional-pairs-v1",
                "family_template_id": "microbar_cross_sectional_pairs_v1",
                "full_window": {
                    "net_per_day": "123",
                    "trading_day_count": "1",
                    "avg_filled_notional_per_day": "350000",
                    "daily_net": {"2026-02-23": "123"},
                    "daily_filled_notional": {"2026-02-23": "350000"},
                    "daily_liquidity_notional": {"2026-02-23": "900000"},
                    "decision_count_by_order_type": {"market": 2, "limit": 3},
                    "filled_count_by_order_type": {"market": 2, "limit": 2},
                    "limit_fill_rate": "0.6667",
                },
            },
            dataset_snapshot_id="snap-order-type-execution",
            result_path="/tmp/order-type-execution-replay.json",
        )

        self.assertEqual(
            bundle.objective_scorecard["order_type_execution_artifact_ref"],
            "/tmp/order-type-execution-replay.json",
        )
        self.assertEqual(
            bundle.objective_scorecard["market_limit_order_mix_artifact_ref"],
            "/tmp/order-type-execution-replay.json",
        )
        self.assertNotIn("order_type_ablation_artifact_ref", bundle.objective_scorecard)
        self.assertNotIn("order_type_ablation_passed", bundle.objective_scorecard)

    def test_evidence_bundle_preserves_replay_lineage_and_window_coverage(
        self,
    ) -> None:
        replay_lineage = {
            "schema_version": "torghut.frontier-replay-lineage.v1",
            "lineage_hash": "lineage-hash",
            "expected_windows": ["train", "holdout", "full_window"],
            "present_windows": ["train", "holdout", "full_window"],
            "missing_windows": [],
        }
        replay_window_coverage = {
            "schema_version": "torghut.replay-window-coverage.v1",
            "lineage_hash": "lineage-hash",
            "expected_windows": ["train", "holdout", "full_window"],
            "present_windows": ["train", "holdout", "full_window"],
            "missing_windows": [],
            "window_count": 3,
        }

        bundle = evidence_bundle_from_frontier_candidate(
            candidate_spec_id="spec-replay-lineage",
            candidate={
                "candidate_id": "cand-replay-lineage",
                "runtime_family": "microbar_cross_sectional_pairs",
                "runtime_strategy_name": "microbar-cross-sectional-pairs-v1",
                "family_template_id": "microbar_cross_sectional_pairs_v1",
                "replay_lineage": replay_lineage,
                "objective_scorecard": {
                    "net_pnl_per_day": "640",
                    "replay_window_coverage": replay_window_coverage,
                },
                "full_window": {
                    "net_per_day": "640",
                    "trading_day_count": "1",
                    "daily_net": {"2026-02-23": "640"},
                },
            },
            dataset_snapshot_id="snap-replay-lineage",
            result_path="/tmp/replay-lineage.json",
        )

        self.assertEqual(bundle.objective_scorecard["replay_lineage"], replay_lineage)
        self.assertEqual(
            bundle.objective_scorecard["replay_window_coverage"],
            replay_window_coverage,
        )

    def test_evidence_bundle_preserves_nested_order_type_ablation_artifact(
        self,
    ) -> None:
        bundle = evidence_bundle_from_frontier_candidate(
            candidate_spec_id="spec-order-type-ablation",
            candidate={
                "candidate_id": "cand-order-type-ablation",
                "runtime_family": "microbar_cross_sectional_pairs",
                "runtime_strategy_name": "microbar-cross-sectional-pairs-v1",
                "family_template_id": "microbar_cross_sectional_pairs_v1",
                "full_window": {
                    "net_per_day": "123",
                    "trading_day_count": "1",
                    "avg_filled_notional_per_day": "350000",
                    "daily_net": {"2026-02-23": "123"},
                    "daily_filled_notional": {"2026-02-23": "350000"},
                    "daily_liquidity_notional": {"2026-02-23": "900000"},
                    "decision_count_by_order_type": {"market": 2, "limit": 3},
                    "filled_count_by_order_type": {"market": 2, "limit": 2},
                    "limit_fill_rate": "0.6667",
                },
                "order_type_ablation": {
                    "artifact_ref": "/tmp/order-type-ablation.json",
                    "passed": True,
                    "sample_count": 60,
                    "selected_order_type": "limit",
                    "opportunity_cost_bps": "4.5",
                    "limit_sample_count": 30,
                },
            },
            dataset_snapshot_id="snap-order-type-ablation",
            result_path="/tmp/order-type-ablation-replay.json",
        )

        self.assertEqual(
            bundle.objective_scorecard["order_type_ablation_artifact_ref"],
            "/tmp/order-type-ablation.json",
        )
        self.assertTrue(bundle.objective_scorecard["order_type_ablation_passed"])
        self.assertEqual(
            bundle.objective_scorecard["order_type_ablation_sample_count"], 60
        )
        self.assertEqual(
            bundle.objective_scorecard["order_type_ablation_selected_order_type"],
            "limit",
        )
        self.assertEqual(
            bundle.objective_scorecard["order_type_opportunity_cost_bps"],
            "4.5",
        )
        self.assertTrue(
            bundle.objective_scorecard["order_type_opportunity_cost_evidence_present"]
        )
        self.assertEqual(
            bundle.objective_scorecard["limit_fill_probability_sample_count"],
            30,
        )
        self.assertEqual(
            bundle.replay_artifact_refs,
            (
                "/tmp/order-type-ablation-replay.json",
                "/tmp/order-type-ablation.json",
            ),
        )
        self.assertNotIn("route_tca_artifact_ref", bundle.objective_scorecard)
        self.assertNotIn(
            "price_improvement_evidence_present", bundle.objective_scorecard
        )
        self.assertNotIn(
            "execution_shortfall_evidence_present", bundle.objective_scorecard
        )

    def test_evidence_bundle_preserves_exact_replay_ledger_artifact_ref(self) -> None:
        bundle = evidence_bundle_from_frontier_candidate(
            candidate_spec_id="spec-exact-ledger",
            candidate={
                "candidate_id": "cand-exact-ledger",
                "full_window": {
                    "net_per_day": "123",
                    "trading_day_count": "1",
                    "daily_net": {"2026-02-23": "123"},
                },
                "objective_scorecard": {
                    "net_pnl_per_day": "123",
                    "exact_replay_ledger_artifact_ref": "/tmp/exact-replay-ledger.json",
                    "runtime_ledger_artifact_row_count": 6,
                },
            },
            dataset_snapshot_id="snap-exact-ledger",
            result_path="/tmp/frontier-result.json",
        )

        self.assertEqual(
            bundle.objective_scorecard["exact_replay_ledger_artifact_ref"],
            "/tmp/exact-replay-ledger.json",
        )
        self.assertEqual(
            bundle.replay_artifact_refs,
            ("/tmp/frontier-result.json", "/tmp/exact-replay-ledger.json"),
        )

    def test_evidence_bundle_fails_delay_depth_without_recorded_daily_liquidity(
        self,
    ) -> None:
        bundle = evidence_bundle_from_frontier_candidate(
            candidate_spec_id="spec-missing-depth",
            candidate={
                "candidate_id": "cand-missing-depth",
                "runtime_family": "microbar_cross_sectional_pairs",
                "runtime_strategy_name": "microbar-cross-sectional-pairs-v1",
                "family_template_id": "microbar_cross_sectional_pairs_v1",
                "full_window": {
                    "net_per_day": "700",
                    "trading_day_count": "1",
                    "avg_filled_notional_per_day": "350000",
                    "daily_net": {"2026-02-23": "700"},
                    "daily_filled_notional": {"2026-02-23": "350000"},
                },
            },
            dataset_snapshot_id="snap-missing-depth",
            result_path="/tmp/missing-depth.json",
        )

        self.assertFalse(
            bundle.objective_scorecard[
                "delay_adjusted_depth_liquidity_evidence_present"
            ]
        )
        self.assertEqual(
            bundle.objective_scorecard[
                "delay_adjusted_depth_liquidity_missing_day_count"
            ],
            1,
        )
        self.assertEqual(
            bundle.objective_scorecard[
                "delay_adjusted_depth_fillable_notional_per_day"
            ],
            "0",
        )
        self.assertEqual(
            bundle.objective_scorecard[
                "delay_adjusted_depth_worst_active_day_fillable_notional"
            ],
            "0",
        )
        self.assertEqual(
            bundle.objective_scorecard[
                "delay_adjusted_depth_p10_active_day_fillable_notional"
            ],
            "0",
        )
        self.assertFalse(
            bundle.objective_scorecard["delay_adjusted_depth_tail_coverage_passed"]
        )
        self.assertFalse(
            bundle.objective_scorecard["delay_adjusted_depth_stress_passed"]
        )

    def test_evidence_bundle_uses_per_day_depth_not_average_liquidity(self) -> None:
        bundle = evidence_bundle_from_frontier_candidate(
            candidate_spec_id="spec-thin-depth",
            candidate={
                "candidate_id": "cand-thin-depth",
                "runtime_family": "microbar_cross_sectional_pairs",
                "runtime_strategy_name": "microbar-cross-sectional-pairs-v1",
                "family_template_id": "microbar_cross_sectional_pairs_v1",
                "full_window": {
                    "net_per_day": "800",
                    "trading_day_count": "2",
                    "avg_filled_notional_per_day": "400000",
                    "daily_net": {
                        "2026-02-23": "800",
                        "2026-02-24": "800",
                    },
                    "daily_filled_notional": {
                        "2026-02-23": "400000",
                        "2026-02-24": "400000",
                    },
                    "daily_liquidity_notional": {
                        "2026-02-23": "1000000",
                        "2026-02-24": "200000",
                    },
                },
            },
            dataset_snapshot_id="snap-thin-depth",
            result_path="/tmp/thin-depth.json",
        )

        self.assertTrue(
            bundle.objective_scorecard[
                "delay_adjusted_depth_liquidity_evidence_present"
            ]
        )
        self.assertEqual(
            bundle.objective_scorecard[
                "delay_adjusted_depth_liquidity_missing_day_count"
            ],
            0,
        )
        self.assertEqual(
            bundle.objective_scorecard[
                "delay_adjusted_depth_fillable_notional_per_day"
            ],
            "295000.00",
        )
        self.assertEqual(
            bundle.objective_scorecard[
                "delay_adjusted_depth_worst_grid_fillable_notional_per_day"
            ],
            "275000.00",
        )
        self.assertEqual(
            bundle.objective_scorecard[
                "delay_adjusted_depth_worst_active_day_fillable_notional"
            ],
            "150000.00",
        )
        self.assertEqual(
            bundle.objective_scorecard[
                "delay_adjusted_depth_p10_active_day_fillable_notional"
            ],
            "150000.00",
        )
        self.assertTrue(
            bundle.objective_scorecard["delay_adjusted_depth_tail_coverage_passed"]
        )
        self.assertEqual(
            bundle.objective_scorecard["delay_adjusted_depth_fillable_ratio"],
            "0.7375",
        )
        self.assertEqual(
            bundle.objective_scorecard[
                "delay_adjusted_depth_unfillable_notional_per_day"
            ],
            "105000.00",
        )
        self.assertEqual(
            Decimal(
                bundle.objective_scorecard[
                    "delay_adjusted_depth_stress_net_pnl_per_day"
                ]
            ),
            Decimal("560.5"),
        )

    def test_mlx_ranker_covers_fallback_and_error_edges(self) -> None:
        rows = [
            build_mlx_training_rows(
                candidate_specs=[
                    compile_candidate_specs(
                        hypothesis_cards=build_hypothesis_cards(
                            source_run_id="paper",
                            claims=[
                                {
                                    "claim_id": "claim-flow",
                                    "claim_type": "signal_mechanism",
                                    "claim_text": "Order flow cluster signal.",
                                    "confidence": "0.8",
                                }
                            ],
                        ),
                        target_net_pnl_per_day=Decimal("500"),
                    )[0]
                ],
                evidence_bundles=[],
            )[0]
        ]

        import builtins

        real_import = builtins.__import__

        def fake_import(name: str, *args: Any, **kwargs: Any) -> Any:
            if name == "mlx.core":
                raise ModuleNotFoundError("mlx unavailable in test")
            return real_import(name, *args, **kwargs)

        with patch("builtins.__import__", side_effect=fake_import):
            model = train_mlx_ranker(rows, backend_preference="mlx", steps=2)

        self.assertEqual(model.backend, "numpy-fallback")
        self.assertEqual(
            mlx_ranker_model_from_payload(model.to_payload()).model_id,
            model.model_id,
        )
        with self.assertRaisesRegex(ValueError, "mlx_ranker_training_rows_required"):
            train_mlx_ranker([])
        with self.assertRaisesRegex(ValueError, "mlx_ranker_schema_invalid"):
            mlx_ranker_model_from_payload({"schema_version": "bad"})

    def test_portfolio_optimizer_uses_daily_vectors_and_correlation_cap(self) -> None:
        bundles = [
            evidence_bundle_from_frontier_candidate(
                candidate_spec_id="spec-a",
                candidate={
                    "candidate_id": "cand-a",
                    "objective_scorecard": {
                        "net_pnl_per_day": "900",
                        "active_day_ratio": "1.0",
                        "positive_day_ratio": "1.0",
                        "worst_day_loss": "0",
                        "max_drawdown": "0",
                        "best_day_share": "0.34",
                    },
                    "full_window": {
                        "daily_net": {
                            "2026-02-23": "600",
                            "2026-02-24": "1200",
                            "2026-02-25": "900",
                        }
                    },
                },
                dataset_snapshot_id="snap-1",
                result_path="/tmp/a.json",
            ),
            evidence_bundle_from_frontier_candidate(
                candidate_spec_id="spec-b",
                candidate={
                    "candidate_id": "cand-b",
                    "objective_scorecard": {
                        "net_pnl_per_day": "810",
                        "active_day_ratio": "1.0",
                        "positive_day_ratio": "1.0",
                        "worst_day_loss": "0",
                        "max_drawdown": "0",
                        "best_day_share": "0.34",
                    },
                    "full_window": {
                        "daily_net": {
                            "2026-02-23": "300",
                            "2026-02-24": "1050",
                            "2026-02-25": "1080",
                        }
                    },
                },
                dataset_snapshot_id="snap-1",
                result_path="/tmp/b.json",
            ),
            evidence_bundle_from_frontier_candidate(
                candidate_spec_id="spec-c",
                candidate={
                    "candidate_id": "cand-c",
                    "objective_scorecard": {
                        "net_pnl_per_day": "780",
                        "active_day_ratio": "1.0",
                        "positive_day_ratio": "1.0",
                        "worst_day_loss": "0",
                        "max_drawdown": "0",
                        "best_day_share": "0.34",
                    },
                    "full_window": {
                        "daily_net": {
                            "2026-02-23": "540",
                            "2026-02-24": "1080",
                            "2026-02-25": "720",
                        }
                    },
                },
                dataset_snapshot_id="snap-1",
                result_path="/tmp/c.json",
            ),
        ]

        portfolio = optimize_portfolio_candidate(
            evidence_bundles=bundles,
            target_net_pnl_per_day=Decimal("700"),
            portfolio_size_min=2,
            portfolio_size_max=3,
        )

        self.assertIsNotNone(portfolio)
        assert portfolio is not None
        self.assertEqual(portfolio.source_candidate_ids, ("cand-a", "cand-b"))
        self.assertEqual(portfolio.objective_scorecard["net_pnl_per_day"], "855.0")
        self.assertEqual(portfolio.objective_scorecard["worst_day_loss"], "0")
        self.assertEqual(
            portfolio.objective_scorecard["daily_net"],
            {
                "2026-02-23": "450.0",
                "2026-02-24": "1125.0",
                "2026-02-25": "990.0",
            },
        )
        rejection_reasons = [
            item["reason"] for item in portfolio.optimizer_report["rejections"]
        ]
        self.assertIn("correlation_cap", rejection_reasons)
