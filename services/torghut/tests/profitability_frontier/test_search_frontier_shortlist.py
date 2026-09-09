from __future__ import annotations

from tests.profitability_frontier.search_frontier_base import (
    Decimal,
    SearchConsistentProfitabilityFrontierTestCaseBase,
    deque,
    frontier,
)


class TestSearchFrontierShortlist(SearchConsistentProfitabilityFrontierTestCaseBase):
    def test_economic_shortlist_preserves_high_pnl_vetoed_candidate(self) -> None:
        items = [
            {
                "candidate_id": "clean-low",
                "strategy_name": "strategy",
                "family": "family",
                "objective_scorecard": {
                    "net_pnl_per_day": "25",
                    "net_pnl": "125",
                    "active_day_ratio": "1",
                    "positive_day_ratio": "1",
                    "max_drawdown": "0",
                    "worst_day_loss": "0",
                    "max_gross_exposure_pct_equity": "0.5",
                    "min_cash": "100",
                },
                "full_window": {"net_per_day": "25", "net_pnl": "125"},
                "hard_vetoes": [],
                "ranking": {"vetoed": False, "pareto_tier": 0},
            },
            {
                "candidate_id": "vetoed-high",
                "strategy_name": "strategy",
                "family": "family",
                "objective_scorecard": {
                    "net_pnl_per_day": "150",
                    "net_pnl": "750",
                    "active_day_ratio": "1",
                    "positive_day_ratio": "0.8",
                    "max_drawdown": "6",
                    "worst_day_loss": "6",
                    "max_gross_exposure_pct_equity": "1.01",
                    "min_cash": "-15",
                },
                "full_window": {"net_per_day": "150", "net_pnl": "750"},
                "exact_replay_ledger_artifact_ref": "/tmp/high-ledger.json",
                "replay_artifact_refs": ["/tmp/high-ledger.json"],
                "hard_vetoes": ["min_cash_below_min"],
                "ranking": {"vetoed": True, "pareto_tier": 999},
            },
        ]

        shortlist = frontier._build_economic_shortlist(items, top_n=1)

        self.assertEqual(shortlist[0]["candidate_id"], "vetoed-high")
        self.assertEqual(shortlist[0]["net_pnl_per_day"], "150")
        self.assertEqual(
            shortlist[0]["exact_replay_ledger_artifact_ref"], "/tmp/high-ledger.json"
        )
        self.assertEqual(shortlist[0]["hard_vetoes"], ["min_cash_below_min"])
        self.assertTrue(shortlist[0]["vetoed"])

    def test_economic_shortlist_metric_helpers_handle_missing_and_invalid_values(
        self,
    ) -> None:
        self.assertEqual(frontier._safe_decimal(None), Decimal("0"))
        self.assertEqual(frontier._safe_decimal("not-a-decimal"), Decimal("0"))
        self.assertEqual(
            frontier._candidate_metric_value(
                {},
                scorecard_key="net_pnl_per_day",
                full_window_key="net_per_day",
                default="7",
            ),
            "7",
        )

        shortlist = frontier._build_economic_shortlist(
            [
                {
                    "candidate_id": "artifact-only",
                    "objective_scorecard": {},
                    "full_window": {},
                    "ranking": {},
                    "replay_artifact_refs": ["/tmp/artifact.json"],
                }
            ],
            top_n=1,
        )

        self.assertEqual(shortlist[0]["candidate_id"], "artifact-only")
        self.assertEqual(shortlist[0]["net_pnl_per_day"], "0")

    def test_paper_probation_shortlist_labels_vetoed_candidate_as_paper_only(
        self,
    ) -> None:
        items = [
            {
                "candidate_id": "microbar-close",
                "strategy_name": "strategy",
                "family": "microbar",
                "objective_scorecard": {
                    "net_pnl_per_day": "406.58",
                    "net_pnl": "813.16",
                    "active_day_ratio": "1",
                    "positive_day_ratio": "0.5",
                    "max_drawdown": "239.02",
                    "worst_day_loss": "239.02",
                    "max_gross_exposure_pct_equity": "6",
                    "min_cash": "-161171.80",
                },
                "full_window": {"net_per_day": "406.58", "net_pnl": "813.16"},
                "exact_replay_ledger_artifact_ref": (
                    "/tmp/microbar-exact-replay-ledger.json"
                ),
                "exact_replay_ledger_artifact_row_count": 12,
                "exact_replay_ledger_artifact_fill_count": 4,
                "runtime_ledger_cost_basis_count": 4,
                "runtime_ledger_post_cost_expectancy_bps": "25",
                "runtime_ledger_pnl_basis": "realized_strategy_pnl_after_explicit_costs",
                "runtime_ledger_open_position_count": 0,
                "replay_artifact_refs": ["/tmp/microbar-exact-replay-ledger.json"],
                "dataset_snapshot_id": "snapshot-microbar",
                "replay_lineage": {"lineage_hash": "lineage-microbar"},
                "candidate_evaluation_key": "eval-microbar",
                "candidate_evaluation_key_payload": {
                    "candidate_evaluation_key": "eval-microbar",
                    "replay_tape": {
                        "content_sha256": "tape-sha",
                        "dataset_snapshot_ref": "snapshot-microbar",
                        "source_query_digest": "query-sha",
                        "feature_schema_hash": "feature-sha",
                        "cost_model_hash": "cost-sha",
                        "strategy_family": "microbar",
                        "replay_cache_key": "cache-key",
                        "selected_symbols": ["NVDA"],
                        "selected_row_count": 12,
                        "validation_status": "valid",
                        "point_in_time_receipt": {
                            "status": "verified_on_load",
                            "receipt_sha256": "sha256:receipt",
                            "observation_cutoff": "2026-03-26T18:00:00+00:00",
                            "input_row_set_sha256": "sha256:inputs",
                            "feature_matrix_sha256": "sha256:features",
                        },
                    },
                },
                "hard_vetoes": [
                    "gross_exposure_pct_equity_above_max",
                    "min_cash_below_min",
                    "daily_net_below_min",
                    "conformal_tail_risk_below_target",
                ],
            }
        ]

        shortlist = frontier._build_paper_probation_shortlist(
            items,
            top_n=1,
            objective_veto_policy=frontier.ObjectiveVetoPolicy(
                required_max_gross_exposure_pct_equity=Decimal("1"),
                required_min_cash=Decimal("0"),
            ),
        )

        item = shortlist[0]
        self.assertEqual(item["candidate_id"], "microbar-close")
        self.assertTrue(item["paper_probation_allowed"])
        self.assertTrue(item["evidence_collection_ok"])
        self.assertFalse(item["promotion_allowed"])
        self.assertFalse(item["final_promotion_allowed"])
        self.assertFalse(item["final_promotion_authorized"])
        self.assertFalse(item["bounded_sim_handoff"]["promotion_allowed"])
        self.assertFalse(item["bounded_sim_handoff"]["final_promotion_allowed"])
        self.assertEqual(item["stage"], "paper_evidence_collection_only")
        self.assertEqual(item["target_net_pnl_per_day"], "500")
        self.assertEqual(item["target_shortfall"], "93.42")
        self.assertEqual(item["capital_repaired_net_pnl_per_day"], "64.37503114")
        self.assertEqual(item["capital_repaired_target_shortfall"], "435.62496886")
        self.assertEqual(item["target_notional_scale_after_capital_repair"], "7.766987")
        self.assertTrue(item["target_scale_required"])
        self.assertEqual(
            item["target_scale_authority"],
            "planning_only_requires_bounded_paper_validation",
        )
        self.assertEqual(item["target_progress_ratio"], "0.8132")
        self.assertEqual(
            item["paper_probation_repair_plan"]["status"],
            "ready_for_bounded_paper_evidence_collection",
        )
        self.assertEqual(
            item["paper_probation_repair_plan"]["capital_repaired_net_pnl_per_day"],
            "64.37503114",
        )
        self.assertIn(
            "post_cost_costs_tca_and_execution_shortfall",
            item["live_paper_evidence_requirements"],
        )
        self.assertIn(
            "source_backed_runtime_ledger_lineage",
            item["paper_probation_repair_plan"]["live_paper_evidence_requirements"],
        )
        self.assertIn(
            "verify_closed_flat_positions_and_broker_runtime_ledger_reconciliation",
            item["safe_evidence_collection_path"],
        )
        self.assertFalse(item["live_capital_authorized"])
        self.assertFalse(item["paper_probation_repair_plan"]["live_capital_authorized"])
        self.assertIn(
            "validate_target_notional_scale_capacity_before_paper_orders",
            item["paper_probation_repair_plan"]["repair_actions"],
        )
        self.assertFalse(item["paper_probation_repair_plan"]["promotion_allowed"])
        self.assertFalse(item["paper_probation_repair_plan"]["final_promotion_allowed"])
        self.assertEqual(item["recommended_notional_scale"], "0.158333")
        self.assertIn(
            "apply_capital_repair_sizing_before_paper_orders",
            item["required_actions_before_or_during_probation"],
        )
        self.assertIn(
            "tighten_loss_controls_before_paper_orders",
            item["required_actions_before_or_during_probation"],
        )
        self.assertIn(
            "collect_tail_risk_and_fill_survival_evidence",
            item["required_actions_before_or_during_probation"],
        )
        self.assertIn(
            "validate_target_notional_scale_capacity_before_paper_orders",
            item["required_actions_before_or_during_probation"],
        )

    def test_paper_probation_actions_collect_queue_position_survival_for_fill_vetoes(
        self,
    ) -> None:
        actions = frontier._paper_probation_required_actions(
            ["fill_survival_rate_below_min"]
        )

        self.assertIn("collect_tail_risk_and_fill_survival_evidence", actions)
        self.assertIn("collect_queue_position_survival_fill_curve_evidence", actions)

    def test_paper_probation_repair_actions_collect_queue_position_survival_for_bundle_blockers(
        self,
    ) -> None:
        actions = frontier._paper_probation_repair_actions(
            blockers=["queue_position_survival_fill_curve_evidence_missing"],
            hard_vetoes=[],
        )

        self.assertIn("collect_queue_position_survival_fill_curve_evidence", actions)
        self.assertIn("keep_final_promotion_gates_fail_closed", actions)

    def test_paper_probation_shortlist_prioritizes_handoff_ready_candidate(
        self,
    ) -> None:
        items = [
            {
                "candidate_id": "higher-profit-unproved",
                "strategy_name": "blocked",
                "family": "microbar",
                "objective_scorecard": {
                    "net_pnl_per_day": "900",
                    "net_pnl": "1800",
                    "max_gross_exposure_pct_equity": "0.5",
                    "min_cash": "100",
                },
                "full_window": {"net_per_day": "900", "net_pnl": "1800"},
                "hard_vetoes": [],
            },
            {
                "candidate_id": "lower-profit-handoff-ready",
                "strategy_name": "ready",
                "family": "hpairs",
                "objective_scorecard": {
                    "net_pnl_per_day": "275",
                    "net_pnl": "550",
                    "active_day_ratio": "1",
                    "positive_day_ratio": "1",
                    "max_drawdown": "50",
                    "worst_day_loss": "25",
                    "max_gross_exposure_pct_equity": "0.5",
                    "min_cash": "100",
                },
                "full_window": {"net_per_day": "275", "net_pnl": "550"},
                "exact_replay_ledger_artifact_ref": (
                    "/tmp/lower-profit-handoff-ready-exact-replay-ledger.json"
                ),
                "exact_replay_ledger_artifact_row_count": 10,
                "exact_replay_ledger_artifact_fill_count": 4,
                "runtime_ledger_cost_basis_count": 4,
                "runtime_ledger_post_cost_expectancy_bps": "18",
                "runtime_ledger_pnl_basis": "realized_strategy_pnl_after_explicit_costs",
                "runtime_ledger_open_position_count": 0,
                "replay_artifact_refs": [
                    "/tmp/lower-profit-handoff-ready-exact-replay-ledger.json"
                ],
                "dataset_snapshot_id": "snapshot-handoff-ready",
                "replay_lineage": {"lineage_hash": "lineage-handoff-ready"},
                "candidate_evaluation_key": "eval-handoff-ready",
                "candidate_evaluation_key_payload": {
                    "candidate_evaluation_key": "eval-handoff-ready",
                    "replay_tape": {
                        "content_sha256": "tape-sha",
                        "dataset_snapshot_ref": "snapshot-handoff-ready",
                        "source_query_digest": "query-sha",
                        "feature_schema_hash": "feature-sha",
                        "cost_model_hash": "cost-sha",
                        "strategy_family": "hpairs",
                        "replay_cache_key": "cache-key",
                        "selected_symbols": ["NVDA"],
                        "selected_row_count": 10,
                        "validation_status": "valid",
                        "point_in_time_receipt": {
                            "status": "verified_on_load",
                            "receipt_sha256": "sha256:receipt",
                            "observation_cutoff": "2026-03-26T18:00:00+00:00",
                            "input_row_set_sha256": "sha256:inputs",
                            "feature_matrix_sha256": "sha256:features",
                        },
                    },
                },
                "hard_vetoes": [],
            },
        ]

        shortlist = frontier._build_paper_probation_shortlist(
            items,
            top_n=1,
            objective_veto_policy=frontier.ObjectiveVetoPolicy(
                required_max_gross_exposure_pct_equity=Decimal("1"),
                required_min_cash=Decimal("0"),
            ),
        )

        item = shortlist[0]
        self.assertEqual(item["candidate_id"], "lower-profit-handoff-ready")
        self.assertTrue(item["paper_probation_allowed"])
        self.assertTrue(item["evidence_collection_ok"])
        self.assertFalse(item["promotion_allowed"])
        self.assertFalse(item["final_promotion_allowed"])
        self.assertFalse(item["final_promotion_authorized"])
        self.assertFalse(item["bounded_sim_handoff"]["promotion_allowed"])
        self.assertFalse(item["bounded_sim_handoff"]["final_promotion_allowed"])
        self.assertEqual(item["probation_blockers"], [])

    def test_paper_probation_shortlist_ranks_by_capital_repaired_target_gap(
        self,
    ) -> None:
        evidence_fields = {
            "exact_replay_ledger_artifact_row_count": 10,
            "exact_replay_ledger_artifact_fill_count": 4,
            "runtime_ledger_cost_basis_count": 4,
            "runtime_ledger_post_cost_expectancy_bps": "18",
            "runtime_ledger_pnl_basis": "realized_strategy_pnl_after_explicit_costs",
            "runtime_ledger_open_position_count": 0,
            "dataset_snapshot_id": "snapshot",
            "replay_lineage": {"lineage_hash": "lineage"},
        }
        items = [
            {
                **evidence_fields,
                "candidate_id": "raw-high-capital-repaired-low",
                "strategy_name": "capital-repaired",
                "family": "microbar",
                "objective_scorecard": {
                    "net_pnl_per_day": "900",
                    "net_pnl": "1800",
                    "active_day_ratio": "1",
                    "positive_day_ratio": "1",
                    "max_drawdown": "50",
                    "worst_day_loss": "25",
                    "max_gross_exposure_pct_equity": "9.5",
                    "min_cash": "100",
                },
                "full_window": {"net_per_day": "900", "net_pnl": "1800"},
                "exact_replay_ledger_artifact_ref": (
                    "/tmp/raw-high-capital-repaired-low-exact-replay-ledger.json"
                ),
                "replay_artifact_refs": [
                    "/tmp/raw-high-capital-repaired-low-exact-replay-ledger.json"
                ],
                "candidate_evaluation_key": "eval-raw-high",
                "hard_vetoes": ["gross_exposure_pct_equity_above_max"],
            },
            {
                **evidence_fields,
                "candidate_id": "raw-lower-target-close",
                "strategy_name": "target-close",
                "family": "hpairs",
                "objective_scorecard": {
                    "net_pnl_per_day": "450",
                    "net_pnl": "900",
                    "active_day_ratio": "1",
                    "positive_day_ratio": "1",
                    "max_drawdown": "50",
                    "worst_day_loss": "25",
                    "max_gross_exposure_pct_equity": "0.5",
                    "min_cash": "100",
                },
                "full_window": {"net_per_day": "450", "net_pnl": "900"},
                "exact_replay_ledger_artifact_ref": (
                    "/tmp/raw-lower-target-close-exact-replay-ledger.json"
                ),
                "replay_artifact_refs": [
                    "/tmp/raw-lower-target-close-exact-replay-ledger.json"
                ],
                "candidate_evaluation_key": "eval-raw-lower",
                "hard_vetoes": [],
            },
        ]

        shortlist = frontier._build_paper_probation_shortlist(
            items,
            top_n=1,
            objective_veto_policy=frontier.ObjectiveVetoPolicy(
                required_max_gross_exposure_pct_equity=Decimal("1"),
                required_min_cash=Decimal("0"),
            ),
        )

        item = shortlist[0]
        self.assertEqual(item["candidate_id"], "raw-lower-target-close")
        self.assertEqual(item["capital_repaired_net_pnl_per_day"], "450")
        self.assertEqual(item["capital_repaired_target_shortfall"], "50")
        self.assertEqual(item["target_notional_scale_after_capital_repair"], "1.111112")

    def test_paper_probation_shortlist_blocks_missing_ledger_artifact(self) -> None:
        shortlist = frontier._build_paper_probation_shortlist(
            [
                {
                    "candidate_id": "positive-but-unproved",
                    "objective_scorecard": {
                        "net_pnl_per_day": "75",
                        "net_pnl": "150",
                        "max_gross_exposure_pct_equity": "0.5",
                        "min_cash": "100",
                    },
                    "full_window": {"net_per_day": "75", "net_pnl": "150"},
                    "hard_vetoes": ["active_day_ratio_below_min"],
                }
            ],
            top_n=1,
            objective_veto_policy=frontier.ObjectiveVetoPolicy(
                required_max_gross_exposure_pct_equity=Decimal("1"),
                required_min_cash=Decimal("0"),
            ),
        )

        self.assertFalse(shortlist[0]["paper_probation_allowed"])
        self.assertEqual(
            shortlist[0]["probation_blockers"],
            [
                "missing_exact_replay_ledger_artifact",
                "missing_exact_replay_ledger_row_count",
                "missing_exact_replay_ledger_fill_count",
                "missing_source_lineage",
                "failed_exact_replay_parity",
            ],
        )
        self.assertFalse(shortlist[0]["promotion_allowed"])
        self.assertFalse(shortlist[0]["evidence_collection_ok"])
        repair_plan = shortlist[0]["paper_probation_repair_plan"]
        self.assertEqual(
            repair_plan["status"],
            "repair_required_before_paper_evidence_collection",
        )
        self.assertEqual(repair_plan["target_shortfall"], "425")
        self.assertEqual(repair_plan["target_progress_ratio"], "0.15")
        self.assertIn(
            "produce_authoritative_exact_replay_ledger",
            repair_plan["repair_actions"],
        )
        self.assertIn(
            "materialize_source_lineage_receipt",
            repair_plan["repair_actions"],
        )
        self.assertIn(
            "keep_final_promotion_gates_fail_closed",
            repair_plan["repair_actions"],
        )
        self.assertFalse(repair_plan["promotion_allowed"])
        self.assertFalse(repair_plan["final_promotion_allowed"])
        self.assertIn(
            "insufficient_days",
            {
                diagnostic["category"]
                for diagnostic in shortlist[0]["handoff_diagnostics"]
            },
        )

    def test_paper_probation_shortlist_blocks_missing_post_cost_basis(self) -> None:
        shortlist = frontier._build_paper_probation_shortlist(
            [
                {
                    "candidate_id": "missing-post-cost-proof",
                    "objective_scorecard": {
                        "net_pnl_per_day": "125",
                        "net_pnl": "250",
                        "max_gross_exposure_pct_equity": "0.5",
                        "min_cash": "100",
                    },
                    "full_window": {"net_per_day": "125", "net_pnl": "250"},
                    "exact_replay_ledger_artifact_ref": "/tmp/exact-replay-ledger.json",
                    "exact_replay_ledger_artifact_row_count": 6,
                    "exact_replay_ledger_artifact_fill_count": 2,
                    "runtime_ledger_open_position_count": 0,
                    "dataset_snapshot_id": "snapshot-post-cost",
                    "replay_lineage": {"lineage_hash": "lineage-post-cost"},
                    "candidate_evaluation_key": "eval-post-cost",
                    "candidate_evaluation_key_payload": {
                        "candidate_evaluation_key": "eval-post-cost",
                        "replay_tape": {
                            "content_sha256": "tape-sha",
                            "dataset_snapshot_ref": "snapshot-post-cost",
                            "source_query_digest": "query-sha",
                            "feature_schema_hash": "feature-sha",
                            "cost_model_hash": "cost-sha",
                            "strategy_family": "hpairs",
                            "replay_cache_key": "cache-key",
                            "selected_symbols": ["NVDA"],
                            "selected_row_count": 10,
                            "validation_status": "valid",
                        },
                    },
                    "hard_vetoes": [],
                }
            ],
            top_n=1,
            objective_veto_policy=frontier.ObjectiveVetoPolicy(
                required_max_gross_exposure_pct_equity=Decimal("1"),
                required_min_cash=Decimal("0"),
            ),
        )

        item = shortlist[0]
        self.assertFalse(item["paper_probation_allowed"])
        self.assertIn("missing_post_cost_pnl_basis", item["probation_blockers"])
        self.assertIn("missing_cost_basis", item["probation_blockers"])
        self.assertIn("missing_post_cost_expectancy_bps", item["probation_blockers"])
        self.assertFalse(item["bounded_sim_handoff"]["promotion_allowed"])
        self.assertFalse(item["bounded_sim_handoff"]["final_promotion_allowed"])
        self.assertIn(
            "missing_post_cost_basis",
            {diagnostic["category"] for diagnostic in item["handoff_diagnostics"]},
        )

    def test_paper_probation_shortlist_blocks_missing_replay_tape_metadata(
        self,
    ) -> None:
        shortlist = frontier._build_paper_probation_shortlist(
            [
                {
                    "candidate_id": "missing-tape-metadata",
                    "objective_scorecard": {
                        "net_pnl_per_day": "125",
                        "net_pnl": "250",
                        "max_gross_exposure_pct_equity": "0.5",
                        "min_cash": "100",
                    },
                    "full_window": {"net_per_day": "125", "net_pnl": "250"},
                    "exact_replay_ledger_artifact_ref": "/tmp/exact-replay-ledger.json",
                    "exact_replay_ledger_artifact_row_count": 6,
                    "exact_replay_ledger_artifact_fill_count": 2,
                    "runtime_ledger_cost_basis_count": 2,
                    "runtime_ledger_post_cost_expectancy_bps": "25",
                    "runtime_ledger_pnl_basis": "realized_strategy_pnl_after_explicit_costs",
                    "runtime_ledger_open_position_count": 0,
                    "dataset_snapshot_id": "snapshot-tape-missing",
                    "replay_lineage": {"lineage_hash": "lineage-tape-missing"},
                    "candidate_evaluation_key": "eval-tape-missing",
                    "candidate_evaluation_key_payload": {
                        "candidate_evaluation_key": "eval-tape-missing",
                        "replay_tape": {
                            "content_sha256": "tape-sha",
                            "dataset_snapshot_ref": "snapshot-tape-missing",
                            "source_query_digest": "query-sha",
                            "selected_symbols": ["NVDA"],
                            "selected_row_count": 10,
                            "validation_status": "valid",
                        },
                    },
                    "hard_vetoes": [],
                }
            ],
            top_n=1,
            objective_veto_policy=frontier.ObjectiveVetoPolicy(
                required_max_gross_exposure_pct_equity=Decimal("1"),
                required_min_cash=Decimal("0"),
            ),
        )

        item = shortlist[0]
        self.assertFalse(item["paper_probation_allowed"])
        self.assertIn(
            "missing_replay_tape_feature_schema_hash", item["probation_blockers"]
        )
        self.assertIn("missing_replay_tape_cost_model_hash", item["probation_blockers"])
        self.assertIn("missing_replay_tape_strategy_family", item["probation_blockers"])
        self.assertFalse(item["bounded_sim_handoff"]["evidence_collection_ok"])
        self.assertIn(
            "missing_replay_tape_metadata",
            {diagnostic["category"] for diagnostic in item["handoff_diagnostics"]},
        )

    def test_replay_tape_blockers_fail_closed_when_metadata_is_omitted(self) -> None:
        blockers = frontier._candidate_replay_tape_metadata_blockers(
            {
                "candidate_evaluation_key_payload": {
                    "candidate_evaluation_key": "eval-no-tape",
                },
                "dataset_snapshot_id": "snapshot-no-tape",
                "replay_lineage": {"lineage_hash": "lineage-no-tape"},
            }
        )

        self.assertEqual(
            blockers,
            [
                "missing_replay_tape_metadata",
                "missing_point_in_time_replay_receipt",
            ],
        )

    def test_paper_probation_shortlist_blocks_generic_replay_artifact(self) -> None:
        shortlist = frontier._build_paper_probation_shortlist(
            [
                {
                    "candidate_id": "positive-generic-replay-only",
                    "objective_scorecard": {
                        "net_pnl_per_day": "175",
                        "net_pnl": "350",
                        "max_gross_exposure_pct_equity": "0.5",
                        "min_cash": "100",
                    },
                    "full_window": {"net_per_day": "175", "net_pnl": "350"},
                    "replay_artifact_refs": ["/tmp/generic-replay.json"],
                    "hard_vetoes": [],
                }
            ],
            top_n=1,
            objective_veto_policy=frontier.ObjectiveVetoPolicy(
                required_max_gross_exposure_pct_equity=Decimal("1"),
                required_min_cash=Decimal("0"),
            ),
        )

        self.assertFalse(shortlist[0]["paper_probation_allowed"])
        self.assertIn(
            "missing_exact_replay_ledger_artifact",
            shortlist[0]["probation_blockers"],
        )

    def test_paper_probation_shortlist_blocks_proof_only_exact_replay_ledger(
        self,
    ) -> None:
        shortlist = frontier._build_paper_probation_shortlist(
            [
                {
                    "candidate_id": "positive-proof-only",
                    "objective_scorecard": {
                        "net_pnl_per_day": "225",
                        "net_pnl": "450",
                        "max_gross_exposure_pct_equity": "0.5",
                        "min_cash": "100",
                    },
                    "full_window": {"net_per_day": "225", "net_pnl": "450"},
                    "exact_replay_ledger_artifact_ref": "/tmp/proof-only-ledger.json",
                    "exact_replay_ledger_artifact_row_count": 12,
                    "exact_replay_ledger_artifact_fill_count": 4,
                    "exact_replay_ledger_artifact_proof_only": True,
                    "screening": {"proof_only_full_window_replay_captured": True},
                    "staged_search": {
                        "stage": "full_replay_budget_exhausted_full_window_proof"
                    },
                    "hard_vetoes": [],
                }
            ],
            top_n=1,
            objective_veto_policy=frontier.ObjectiveVetoPolicy(
                required_max_gross_exposure_pct_equity=Decimal("1"),
                required_min_cash=Decimal("0"),
            ),
        )

        self.assertFalse(shortlist[0]["paper_probation_allowed"])
        self.assertIn(
            "proof_only_full_window_replay_not_probation_authority",
            shortlist[0]["probation_blockers"],
        )

    def test_exact_replay_shortlist_caps_to_top_four_plus_two_exploration(
        self,
    ) -> None:
        survivors: list[frontier._WorklistItem] = []
        for index, net_per_day in enumerate(
            ["120", "110", "100", "90", "80", "70", "60", "50"],
            start=1,
        ):
            survivors.append(
                frontier._WorklistItem(
                    params_candidate={"long_stop_loss_bps": str(10 + index)},
                    strategy_overrides={"universe_symbols": [f"SYM{index}"]},
                    deferred_candidate_index=index,
                    deferred_candidate_key=f"candidate-{index}",
                    deferred_train_payload=self._payload(
                        start_date="2026-03-18",
                        end_date="2026-03-20",
                        daily_net={
                            "2026-03-18": net_per_day,
                            "2026-03-19": net_per_day,
                            "2026-03-20": net_per_day,
                        },
                        decision_count=3,
                        filled_count=3,
                        wins=3,
                        losses=0,
                    ),
                )
            )

        worklist: deque[frontier._WorklistItem] = deque()
        frontier._enqueue_ranked_train_screen_survivors(
            worklist=worklist,
            survivors=survivors,
            full_replay_candidate_budget=12,
        )

        queued = list(worklist)
        selected = [item for item in queued if item.deferred_full_replay_selected]
        self.assertEqual(len(selected), 6)
        self.assertEqual(
            [item.deferred_full_replay_selection_reason for item in selected[:4]],
            ["exploitation_top_economic_rank"] * 4,
        )
        self.assertEqual(
            [item.deferred_full_replay_selection_reason for item in selected[4:]],
            ["exploration_diversity_pick"] * 2,
        )
        self.assertEqual(
            frontier._safe_exact_replay_candidate_budget(12),
            6,
        )

    def test_exact_replay_shortlist_exploration_falls_back_when_diversity_exhausted(
        self,
    ) -> None:
        survivors: list[frontier._WorklistItem] = []
        for index, net_per_day in enumerate(
            ["120", "110", "100", "90", "80", "70"],
            start=1,
        ):
            survivors.append(
                frontier._WorklistItem(
                    params_candidate={"long_stop_loss_bps": "12"},
                    strategy_overrides={
                        "universe_symbols": ["NVDA"],
                        "normalization_regime": "matched_filter",
                        "max_notional_per_trade": str(1000 + index),
                    },
                    deferred_candidate_index=index,
                    deferred_candidate_key=f"candidate-{index}",
                    deferred_train_payload=self._payload(
                        start_date="2026-03-18",
                        end_date="2026-03-20",
                        daily_net={
                            "2026-03-18": net_per_day,
                            "2026-03-19": net_per_day,
                            "2026-03-20": net_per_day,
                        },
                        decision_count=3,
                        filled_count=3,
                        wins=3,
                        losses=0,
                    ),
                )
            )

        worklist: deque[frontier._WorklistItem] = deque()
        frontier._enqueue_ranked_train_screen_survivors(
            worklist=worklist,
            survivors=survivors,
            full_replay_candidate_budget=6,
        )

        selected = [item for item in worklist if item.deferred_full_replay_selected]
        self.assertEqual(len(selected), 6)
        self.assertEqual(
            [item.deferred_full_replay_selection_reason for item in selected[:4]],
            ["exploitation_top_economic_rank"] * 4,
        )
        self.assertEqual(
            [item.deferred_full_replay_selection_reason for item in selected[4:]],
            ["exploration_diversity_pick"] * 2,
        )
