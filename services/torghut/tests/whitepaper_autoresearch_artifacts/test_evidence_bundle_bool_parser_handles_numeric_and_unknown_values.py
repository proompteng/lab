from __future__ import annotations

# ruff: noqa: F401,F403,F405
from tests.whitepaper_autoresearch_artifacts.support import (
    Decimal,
    HYPOTHESIS_CARD_SCHEMA_VERSION,
    HypothesisCard,
    MlxTrainingRow,
    _FakeTorchCpuModule,
    _FakeTorchModule,
    _TestWhitepaperAutoresearchArtifactsBase,
    _profile_ids_for_family,
    build_hypothesis_cards,
    build_mlx_training_rows,
    candidate_spec_from_payload,
    candidate_specs_module,
    compile_candidate_specs,
    evidence_bundle_blockers,
    evidence_bundle_from_frontier_candidate,
    evidence_bundle_from_payload,
    evidence_bundles_module,
    hypothesis_card_from_payload,
    mlx_training_data_module,
    optimize_portfolio_candidate,
    patch,
    rank_training_rows,
    train_mlx_ranker,
)


class TestEvidenceBundleBoolParserHandlesNumericAndUnknownValues(
    _TestWhitepaperAutoresearchArtifactsBase
):
    def test_evidence_bundle_bool_parser_handles_numeric_and_unknown_values(
        self,
    ) -> None:
        self.assertEqual(evidence_bundles_module._bool(Decimal("1")), True)
        self.assertEqual(evidence_bundles_module._bool(0), False)
        self.assertEqual(evidence_bundles_module._bool("custom-truthy-marker"), True)

    def test_hypothesis_and_candidate_specs_round_trip(self) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-2026",
            claims=[
                {
                    "claim_id": "claim-flow",
                    "claim_type": "signal_mechanism",
                    "claim_text": "Clustered order flow imbalance improves intraday trading signals.",
                    "asset_scope": "us_equities_intraday",
                    "horizon_scope": "intraday",
                    "expected_direction": "positive",
                    "confidence": "0.82",
                }
            ],
        )

        self.assertEqual(len(cards), 1)
        reloaded_card = hypothesis_card_from_payload(cards[0].to_payload())
        self.assertEqual(reloaded_card.hypothesis_id, cards[0].hypothesis_id)
        self.assertIn("order_flow_imbalance", reloaded_card.required_features)

        specs = compile_candidate_specs(
            hypothesis_cards=cards, target_net_pnl_per_day=Decimal("500")
        )
        expected_family_profiles = {
            family_template_id: _profile_ids_for_family(family_template_id)
            for family_template_id in candidate_specs_module._FAMILY_EXECUTION_PROFILES
        }
        self.assertEqual(
            len(specs),
            sum(len(profiles) for profiles in expected_family_profiles.values()),
        )
        family_profiles: dict[str, list[str]] = {}
        for spec in specs:
            family_profiles.setdefault(spec.family_template_id, []).append(
                str(spec.feature_contract["execution_profile"]["profile_id"])
            )
        self.assertEqual(family_profiles, expected_family_profiles)
        self.assertIn(
            "microbar_cross_sectional_pairs_v1",
            {spec.family_template_id for spec in specs},
        )
        self.assertEqual(specs[0].objective["target_net_pnl_per_day"], "500")

        reloaded_spec = candidate_spec_from_payload(specs[0].to_payload())
        self.assertEqual(reloaded_spec.candidate_spec_id, specs[0].candidate_spec_id)
        self.assertEqual(
            reloaded_spec.to_vnext_experiment_payload()["family_template_id"],
            specs[0].family_template_id,
        )

    def test_evidence_training_rows_and_portfolio_optimizer(self) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-2026",
            claims=[
                {
                    "claim_id": "claim-flow",
                    "claim_type": "signal_mechanism",
                    "claim_text": "Trade-flow order flow clustering creates a transferable intraday signal.",
                    "confidence": "0.82",
                },
                {
                    "claim_id": "claim-momentum",
                    "claim_type": "feature_recipe",
                    "claim_text": "Momentum pullback ranking improves continuation entries.",
                    "confidence": "0.76",
                },
            ],
        )
        specs = compile_candidate_specs(
            hypothesis_cards=cards, target_net_pnl_per_day=Decimal("500")
        )
        bundles = [
            evidence_bundle_from_frontier_candidate(
                candidate_spec_id=f"{spec.candidate_spec_id}-{index}",
                candidate={
                    "candidate_id": f"cand-{index}",
                    "objective_scorecard": {
                        "net_pnl_per_day": str(625 - (index * 25)),
                        "active_day_ratio": "0.92",
                        "positive_day_ratio": "0.64",
                        "worst_day_loss": "150",
                        "max_drawdown": "400",
                        "best_day_share": "0.18",
                    },
                    "full_window": {
                        "daily_net": {
                            "2026-02-23": str(625 - (index * 25)),
                            "2026-02-24": str(625 - (index * 25)),
                        },
                        "daily_filled_notional": {
                            "2026-02-23": "350000",
                            "2026-02-24": "350000",
                        },
                    },
                },
                dataset_snapshot_id="snap-1",
                result_path=f"/tmp/result-{index}.json",
            )
            for index, spec in enumerate([specs[0], specs[0]], start=1)
        ]

        rows = build_mlx_training_rows(candidate_specs=specs, evidence_bundles=bundles)
        self.assertEqual(len(rows), len(specs))
        self.assertEqual(rows[0].feature_names[0], "family_code")

        portfolio = optimize_portfolio_candidate(
            evidence_bundles=bundles,
            target_net_pnl_per_day=Decimal("500"),
            portfolio_size_min=2,
            portfolio_size_max=4,
        )

        self.assertIsNotNone(portfolio)
        assert portfolio is not None
        self.assertTrue(portfolio.objective_scorecard["target_met"])
        self.assertEqual(len(portfolio.sleeves), 2)

    def test_mlx_ranker_learns_and_scores_training_rows(self) -> None:
        cards = build_hypothesis_cards(
            source_run_id="paper-2026",
            claims=[
                {
                    "claim_id": "claim-flow",
                    "claim_type": "signal_mechanism",
                    "claim_text": "Trade-flow order flow clustering creates a transferable intraday signal.",
                    "confidence": "0.82",
                }
            ],
        )
        specs = compile_candidate_specs(
            hypothesis_cards=cards, target_net_pnl_per_day=Decimal("500")
        )
        high_spec = specs[0]
        low_spec = candidate_spec_from_payload(
            {
                **high_spec.to_payload(),
                "candidate_spec_id": f"{high_spec.candidate_spec_id}-low",
                "hypothesis_id": f"{high_spec.hypothesis_id}-low",
            }
        )
        bundles = [
            evidence_bundle_from_frontier_candidate(
                candidate_spec_id=high_spec.candidate_spec_id,
                candidate={
                    "candidate_id": "high",
                    "objective_scorecard": {
                        "net_pnl_per_day": "500",
                        "active_day_ratio": "1.0",
                        "positive_day_ratio": "0.8",
                    },
                },
                dataset_snapshot_id="snap-1",
                result_path="/tmp/high.json",
            ),
            evidence_bundle_from_frontier_candidate(
                candidate_spec_id=low_spec.candidate_spec_id,
                candidate={
                    "candidate_id": "low",
                    "objective_scorecard": {
                        "net_pnl_per_day": "50",
                        "active_day_ratio": "0.5",
                        "positive_day_ratio": "0.4",
                    },
                },
                dataset_snapshot_id="snap-1",
                result_path="/tmp/low.json",
            ),
        ]

        rows = build_mlx_training_rows(
            candidate_specs=[high_spec, low_spec],
            evidence_bundles=bundles,
        )
        model = train_mlx_ranker(rows, backend_preference="numpy-fallback", steps=128)
        ranked = rank_training_rows(model=model, rows=rows)

        self.assertEqual(model.schema_version, "torghut.mlx-ranker.v7")
        self.assertEqual(model.backend, "numpy-fallback")
        self.assertEqual(model.row_count, 2)
        self.assertEqual(ranked[0].candidate_spec_id, high_spec.candidate_spec_id)
        self.assertGreater(ranked[0].score, ranked[1].score)

    def test_ranker_uses_torch_cuda_backend_when_requested(self) -> None:
        rows = [
            MlxTrainingRow(
                candidate_spec_id="low",
                feature_names=("edge", "risk"),
                feature_values=(0.1, 0.9),
                target=10.0,
            ),
            MlxTrainingRow(
                candidate_spec_id="high",
                feature_names=("edge", "risk"),
                feature_values=(0.9, 0.1),
                target=100.0,
            ),
        ]

        with patch.dict("sys.modules", {"torch": _FakeTorchModule()}):
            model = train_mlx_ranker(rows, backend_preference="torch-cuda", steps=8)

        ranked = rank_training_rows(model=model, rows=rows)

        self.assertEqual(model.backend, "torch-cuda")
        self.assertEqual(ranked[0].candidate_spec_id, "high")

    def test_torch_ranker_backend_selection_covers_fallback_edges(self) -> None:
        with patch.object(
            mlx_training_data_module.importlib,
            "import_module",
            side_effect=ModuleNotFoundError("torch"),
        ):
            self.assertIsNone(
                mlx_training_data_module._import_torch_array_backend("torch-cuda")
            )

        with patch.object(
            mlx_training_data_module.importlib,
            "import_module",
            return_value=_FakeTorchCpuModule(),
        ):
            self.assertIsNone(
                mlx_training_data_module._import_torch_array_backend("torch-cuda")
            )
            self.assertEqual(
                mlx_training_data_module._import_array_backend("cuda")[0],
                "numpy-fallback",
            )
            self.assertEqual(
                mlx_training_data_module._import_torch_array_backend("torch")[0],
                "torch",
            )
            self.assertIsNone(
                mlx_training_data_module._import_torch_array_backend("unsupported")
            )

        with patch.object(
            mlx_training_data_module.importlib,
            "import_module",
            return_value=_FakeTorchModule(),
        ):
            self.assertEqual(
                mlx_training_data_module._import_torch_array_backend("torch")[0],
                "torch-cuda",
            )

    def test_hypothesis_cards_cover_failure_and_threshold_edges(self) -> None:
        self.assertEqual(
            build_hypothesis_cards(source_run_id="empty", claims=[]),
            [],
        )
        self.assertEqual(
            build_hypothesis_cards(
                source_run_id="low-confidence",
                claims=[
                    {
                        "claim_id": "weak",
                        "claim_text": "Weak momentum signal.",
                        "confidence": "0.10",
                    }
                ],
                min_confidence=Decimal("0.50"),
            ),
            [],
        )

        cards = build_hypothesis_cards(
            source_run_id="edge-paper",
            claims=[
                {
                    "claim_id": "negative-reversal",
                    "claim_text": "A reversal washout can fail when liquidity vanishes.",
                    "expected_direction": "negative",
                    "expected_failure_modes": "liquidity_vanishes",
                    "expected_regimes": "stressed_open",
                    "confidence": "not-a-decimal",
                    "metadata": {"features": {"bad": "shape"}},
                }
            ],
            relations=[
                {
                    "relation_id": "rel-1",
                    "relation_type": "contradicts",
                }
            ],
            min_confidence=Decimal("0"),
        )

        self.assertEqual(len(cards), 1)
        self.assertIn("session_selloff_bps", cards[0].required_features)
        self.assertIn("rebound", cards[0].entry_motifs)
        self.assertIn("liquidity_vanishes", cards[0].failure_modes)
        self.assertIn("contradiction:rel-1", cards[0].failure_modes)
        with self.assertRaisesRegex(ValueError, "hypothesis_card_schema_invalid"):
            hypothesis_card_from_payload({"schema_version": "bad"})

    def test_candidate_specs_cover_family_selection_and_payload_edges(self) -> None:
        cards = [
            HypothesisCard(
                schema_version=HYPOTHESIS_CARD_SCHEMA_VERSION,
                hypothesis_id=f"hyp-{index}",
                source_run_id="paper",
                source_claim_ids=(f"claim-{index}",),
                mechanism=mechanism,
                asset_scope="us_equities_intraday",
                horizon_scope="intraday",
                expected_direction="positive",
                required_features=(),
                entry_motifs=(),
                exit_motifs=("time_exit",),
                risk_controls=("quote_quality",),
                expected_regimes=("regular_session",),
                failure_modes=("cost_stress",),
                implementation_constraints={},
                confidence=Decimal("0.8"),
            )
            for index, mechanism in enumerate(
                [
                    "matched-filter normalization signal",
                    "washout rebound signal",
                    "momentum trend pullback signal",
                    "breakout continuation signal",
                ],
                start=1,
            )
        ]

        specs = compile_candidate_specs(
            hypothesis_cards=cards, target_net_pnl_per_day=Decimal("500")
        )

        primary_family_by_hypothesis = {
            spec.hypothesis_id: spec.family_template_id
            for spec in specs
            if spec.feature_contract.get("family_selection", {}).get("rank") == 1
        }
        self.assertEqual(
            [primary_family_by_hypothesis[card.hypothesis_id] for card in cards],
            [
                "microstructure_continuation_matched_filter_v1",
                "washout_rebound_v2",
                "momentum_pullback_v1",
                "breakout_reclaim_v2",
            ],
        )
        payload = specs[0].to_payload()
        payload["feature_contract"] = "not-a-mapping"
        reloaded = candidate_spec_from_payload(payload)
        self.assertEqual(reloaded.feature_contract, {})
        with self.assertRaisesRegex(ValueError, "candidate_spec_schema_invalid"):
            candidate_spec_from_payload({"schema_version": "bad"})

    def test_evidence_bundle_covers_full_window_fallbacks(self) -> None:
        bundle = evidence_bundle_from_frontier_candidate(
            candidate_spec_id="spec-fallback",
            candidate={
                "candidate_id": "",
                "runtime_family": "microbar_cross_sectional_pairs",
                "runtime_strategy_name": "microbar-cross-sectional-pairs-v1",
                "family_template_id": "microbar_cross_sectional_pairs_v1",
                "full_window": {
                    "net_per_day": "123",
                    "active_day_ratio": "1.0",
                    "positive_day_ratio": "0.8",
                    "best_day_share": "0.2",
                    "max_drawdown": "0",
                    "trading_day_count": "1",
                    "avg_filled_notional_per_day": "350000",
                    "daily_net": {"2026-02-23": "123"},
                    "daily_filled_notional": {"2026-02-23": "350000"},
                    "daily_liquidity_notional": {"2026-02-23": "900000"},
                    "decision_count_by_order_type": {"market": 2, "limit": 3},
                    "filled_count_by_order_type": {"market": 2, "limit": 2},
                    "limit_fill_rate": "0.6667",
                    "implementation_uncertainty_required": True,
                    "implementation_uncertainty_model": "impact_latency_cost_model_interval",
                    "implementation_uncertainty_model_count": 5,
                    "implementation_uncertainty_stability_passed": False,
                    "implementation_uncertainty_lower_net_pnl_per_day": "88",
                    "implementation_uncertainty_upper_net_pnl_per_day": "120",
                    "implementation_uncertainty_interval_width_per_day": "32",
                    "implementation_uncertainty_scenarios": {
                        "latency_depth_fillability": "88"
                    },
                },
                "route_tca_artifact_ref": "/tmp/route-tca.json",
                "order_type_execution_artifact_ref": "/tmp/order-type-execution.json",
                "execution_shortfall_evidence_present": True,
            },
            dataset_snapshot_id="snap-fallback",
            result_path="/tmp/fallback.json",
        )

        self.assertEqual(bundle.candidate_id, "spec-fallback")
        self.assertEqual(bundle.objective_scorecard["net_pnl_per_day"], "123")
        self.assertIn("daily_filled_notional", bundle.objective_scorecard)
        self.assertTrue(
            bundle.objective_scorecard["nonlinear_market_impact_stress_missing"]
        )
        self.assertEqual(
            bundle.objective_scorecard["avg_liquidity_notional_per_day"],
            "900000",
        )
        self.assertFalse(bundle.objective_scorecard["market_impact_stress_passed"])
        self.assertEqual(
            bundle.objective_scorecard[
                "delay_adjusted_depth_fillable_notional_per_day"
            ],
            "350000",
        )
        self.assertEqual(
            bundle.objective_scorecard[
                "delay_adjusted_depth_worst_active_day_fillable_notional"
            ],
            "350000",
        )
        self.assertEqual(
            bundle.objective_scorecard[
                "delay_adjusted_depth_p10_active_day_fillable_notional"
            ],
            "350000",
        )
        self.assertTrue(
            bundle.objective_scorecard["delay_adjusted_depth_tail_coverage_passed"]
        )
        self.assertEqual(
            bundle.objective_scorecard["delay_adjusted_depth_stress_net_pnl_per_day"],
            "88",
        )
        self.assertTrue(
            bundle.objective_scorecard["delay_adjusted_depth_stress_passed"]
        )
        self.assertEqual(
            bundle.objective_scorecard["decision_count_by_order_type"],
            {"market": 2, "limit": 3},
        )
        self.assertEqual(bundle.objective_scorecard["limit_fill_rate"], "0.6667")
        self.assertEqual(
            bundle.objective_scorecard["market_limit_order_mix_sample_count"],
            5,
        )
        self.assertTrue(
            bundle.objective_scorecard["implementation_uncertainty_required"]
        )
        self.assertEqual(
            bundle.objective_scorecard["implementation_uncertainty_model_count"],
            5,
        )
        self.assertIn(
            "latency_depth_fillability",
            bundle.objective_scorecard["implementation_uncertainty_scenarios"],
        )
        self.assertTrue(
            bundle.objective_scorecard["market_limit_order_mix_evidence_present"]
        )
        self.assertEqual(
            bundle.objective_scorecard["limit_fill_probability_sample_count"],
            3,
        )
        self.assertTrue(
            bundle.objective_scorecard["limit_fill_probability_evidence_present"]
        )
        self.assertEqual(
            bundle.objective_scorecard["route_tca_artifact_ref"],
            "/tmp/route-tca.json",
        )
        self.assertEqual(
            bundle.objective_scorecard["order_type_execution_artifact_ref"],
            "/tmp/order-type-execution.json",
        )
        self.assertTrue(
            bundle.objective_scorecard["execution_shortfall_evidence_present"]
        )
        self.assertEqual(len(bundle.stress_metrics), 3)
        self.assertEqual(
            bundle.stress_metrics[1]["worst_grid_fillable_notional_per_day"],
            "350000",
        )
        self.assertEqual(bundle.stress_metrics[1]["fillable_ratio"], "1")
        self.assertEqual(
            bundle.stress_metrics[2]["stress_type"], "implementation_uncertainty"
        )
        with self.assertRaisesRegex(ValueError, "evidence_bundle_schema_invalid"):
            evidence_bundle_from_payload({"schema_version": "bad"})

    def test_evidence_bundle_hydrates_runtime_config_from_frontier_replay_config(
        self,
    ) -> None:
        bundle = evidence_bundle_from_frontier_candidate(
            candidate_spec_id="spec-frontier-runtime-config",
            candidate={
                "candidate_id": "cand-frontier-runtime-config",
                "family": "microbar_cross_sectional_pairs",
                "strategy_name": "microbar-cross-sectional-pairs-v1",
                "family_template_id": "microbar_cross_sectional_pairs_v1",
                "full_window": {
                    "net_per_day": "143",
                    "active_day_ratio": "1.0",
                    "positive_day_ratio": "1.0",
                    "best_day_share": "0.25",
                    "max_drawdown": "0",
                },
                "replay_config": {
                    "params": {
                        "signal_motif": "vwap_displacement_reversal",
                        "rank_feature": "cross_section_vwap_w5m_rank",
                        "selection_mode": "reversal",
                        "top_n": "2",
                        "entry_minute_after_open": "180",
                        "exit_minute_after_open": "240",
                    },
                    "strategy_overrides": {
                        "universe_symbols": ["NVDA", "AAPL"],
                        "max_notional_per_trade": "30642.32",
                        "max_position_pct_equity": "0.97",
                    },
                },
            },
            dataset_snapshot_id="snap-frontier-runtime-config",
            result_path="/tmp/frontier-runtime-config.json",
        )

        scorecard = bundle.objective_scorecard
        self.assertEqual(
            scorecard["runtime_params"]["signal_motif"],
            "vwap_displacement_reversal",
        )
        self.assertEqual(scorecard["runtime_family"], "microbar_cross_sectional_pairs")
        self.assertEqual(
            scorecard["runtime_strategy_name"], "microbar-cross-sectional-pairs-v1"
        )
        self.assertEqual(scorecard["universe_symbols"], ["NVDA", "AAPL"])
        self.assertEqual(scorecard["max_notional_per_trade"], "30642.32")
        self.assertEqual(scorecard["max_position_pct_equity"], "0.97")
        self.assertEqual(
            scorecard["candidate_strategy_overrides"]["universe_symbols"],
            ["NVDA", "AAPL"],
        )

    def test_evidence_bundle_blocks_promotion_proof_without_fill_survival(self) -> None:
        bundle = evidence_bundle_from_frontier_candidate(
            candidate_spec_id="spec-promotion-proof",
            candidate={
                "candidate_id": "cand-promotion-proof",
                "objective_scorecard": {
                    "net_pnl_per_day": "650",
                    "delay_adjusted_depth_stress_passed": True,
                    "delay_adjusted_depth_stress_model": "latency_depth_haircut",
                    "delay_adjusted_depth_stress_ms": "50",
                    "delay_adjusted_depth_stress_artifact_ref": "/tmp/depth.json",
                    "delay_adjusted_depth_tail_coverage_passed": True,
                    "delay_adjusted_depth_p10_active_day_fillable_notional": "250000",
                    "delay_adjusted_depth_worst_active_day_fillable_notional": "200000",
                    "delay_adjusted_depth_stress_net_pnl_per_day": "540",
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
                    "promotable": True,
                    "blockers": [],
                },
            },
            dataset_snapshot_id="snap-promotion-proof",
            result_path="/tmp/promotion-proof.json",
        )

        blockers = evidence_bundle_blockers(bundle)

        self.assertIn("fill_survival_evidence_missing", blockers)
        self.assertIn("fill_survival_sample_count_zero", blockers)

    def test_evidence_bundle_hydrates_fill_survival_from_order_lifecycle(
        self,
    ) -> None:
        bundle = evidence_bundle_from_frontier_candidate(
            candidate_spec_id="spec-lifecycle-proof",
            candidate={
                "candidate_id": "cand-lifecycle-proof",
                "objective_scorecard": {
                    "net_pnl_per_day": "650",
                    "delay_adjusted_depth_stress_passed": True,
                    "delay_adjusted_depth_stress_model": "latency_depth_haircut",
                    "delay_adjusted_depth_stress_ms": "50",
                    "delay_adjusted_depth_stress_artifact_ref": "/tmp/depth.json",
                    "delay_adjusted_depth_tail_coverage_passed": True,
                    "delay_adjusted_depth_p10_active_day_fillable_notional": "250000",
                    "delay_adjusted_depth_worst_active_day_fillable_notional": "200000",
                    "delay_adjusted_depth_stress_net_pnl_per_day": "540",
                },
                "full_window": {
                    "net_per_day": "650",
                    "trading_day_count": "1",
                    "avg_filled_notional_per_day": "350000",
                    "daily_filled_notional": {"2026-02-23": "350000"},
                    "daily_liquidity_notional": {"2026-02-23": "900000"},
                    "order_lifecycle": {
                        "submitted_order_count": 4,
                        "filled_order_count": 3,
                        "fill_rate": "0.75",
                        "fill_survival_sample_count": 4,
                        "order_qty_to_touch_qty_ratio_p95": "0.20",
                        "queue_ahead_depletion_evidence_present": True,
                        "queue_ahead_depletion_sample_count": 4,
                        "queue_ahead_depletion_rate": "0.75",
                        "queue_ahead_depleted_qty_p50": "18",
                        "queue_ahead_depletion_time_ms_p50": "140",
                        "post_cost_survivorship": {
                            "post_cost_survival_rate": "0.50",
                            "gross_positive_killed_by_cost_count": 1,
                        },
                    },
                },
                "promotion_readiness": {
                    "stage": "paper_probation",
                    "status": "promotion_ready",
                    "promotable": True,
                    "blockers": [],
                },
            },
            dataset_snapshot_id="snap-lifecycle-proof",
            result_path="/tmp/lifecycle-proof.json",
        )

        blockers = evidence_bundle_blockers(bundle)

        self.assertNotIn("fill_survival_evidence_missing", blockers)
        self.assertNotIn("fill_survival_sample_count_zero", blockers)
        self.assertTrue(bundle.objective_scorecard["fill_survival_evidence_present"])
        self.assertEqual(bundle.objective_scorecard["fill_survival_sample_count"], 4)
        self.assertEqual(bundle.objective_scorecard["fill_survival_fill_rate"], "0.75")
        self.assertTrue(
            bundle.objective_scorecard[
                "delay_adjusted_depth_fill_survival_evidence_present"
            ]
        )
        self.assertEqual(
            bundle.objective_scorecard[
                "delay_adjusted_depth_fill_survival_sample_count"
            ],
            4,
        )
        self.assertEqual(
            bundle.objective_scorecard["delay_adjusted_depth_fill_survival_rate"],
            "0.75",
        )
        self.assertEqual(
            bundle.objective_scorecard["delay_adjusted_depth_queue_ratio_p95"],
            "0.20",
        )
        self.assertTrue(
            bundle.objective_scorecard["queue_ahead_depletion_evidence_present"]
        )
        self.assertEqual(
            bundle.objective_scorecard["queue_ahead_depletion_sample_count"],
            4,
        )
        self.assertTrue(
            bundle.objective_scorecard[
                "delay_adjusted_depth_queue_ahead_depletion_evidence_present"
            ]
        )
        self.assertEqual(
            bundle.objective_scorecard[
                "delay_adjusted_depth_queue_ahead_depletion_sample_count"
            ],
            4,
        )
        self.assertEqual(
            bundle.objective_scorecard["post_cost_survival_rate"],
            "0.50",
        )
        self.assertEqual(
            bundle.objective_scorecard["gross_positive_killed_by_cost_count"],
            1,
        )

    def test_evidence_bundle_blocks_l1_queue_ratio_without_queue_ahead_depletion(
        self,
    ) -> None:
        bundle = evidence_bundle_from_frontier_candidate(
            candidate_spec_id="spec-l1-proxy-proof",
            candidate={
                "candidate_id": "cand-l1-proxy-proof",
                "objective_scorecard": {
                    "net_pnl_per_day": "650",
                    "delay_adjusted_depth_stress_passed": True,
                    "delay_adjusted_depth_stress_model": "latency_depth_haircut",
                    "delay_adjusted_depth_stress_ms": "50",
                    "delay_adjusted_depth_stress_artifact_ref": "/tmp/depth.json",
                    "delay_adjusted_depth_tail_coverage_passed": True,
                    "delay_adjusted_depth_p10_active_day_fillable_notional": "250000",
                    "delay_adjusted_depth_worst_active_day_fillable_notional": "200000",
                    "delay_adjusted_depth_stress_net_pnl_per_day": "540",
                },
                "full_window": {
                    "net_per_day": "650",
                    "trading_day_count": "1",
                    "avg_filled_notional_per_day": "350000",
                    "daily_filled_notional": {"2026-02-23": "350000"},
                    "daily_liquidity_notional": {"2026-02-23": "900000"},
                    "order_lifecycle": {
                        "submitted_order_count": 4,
                        "filled_order_count": 3,
                        "fill_rate": "0.75",
                        "fill_survival_sample_count": 4,
                        "order_qty_to_touch_qty_ratio_p95": "0.20",
                    },
                },
                "promotion_readiness": {
                    "stage": "paper_probation",
                    "status": "promotion_ready",
                    "promotable": True,
                    "blockers": [],
                },
            },
            dataset_snapshot_id="snap-l1-proxy-proof",
            result_path="/tmp/l1-proxy-proof.json",
        )

        blockers = evidence_bundle_blockers(bundle)

        self.assertNotIn("fill_survival_evidence_missing", blockers)
        self.assertIn("queue_ahead_depletion_evidence_missing", blockers)
        self.assertIn("queue_ahead_depletion_sample_count_zero", blockers)
