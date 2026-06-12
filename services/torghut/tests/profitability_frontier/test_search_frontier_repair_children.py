from __future__ import annotations

# ruff: noqa: F403,F405
from tests.profitability_frontier.search_frontier_base import *


class TestSearchFrontierRepairChildren(
    SearchConsistentProfitabilityFrontierTestCaseBase
):
    def test_frontier_workflow_states_separate_preview_exact_handoff_and_authority(
        self,
    ) -> None:
        paper_handoff = {
            "candidate_id": "candidate-exact",
            "evidence_collection_ok": True,
            "promotion_allowed": False,
            "final_promotion_allowed": False,
        }
        blocked_handoff = {
            "candidate_id": "candidate-needs-repair",
            "paper_probation_allowed": False,
            "target_shortfall": "175",
            "target_progress_ratio": "0.65",
            "paper_probation_repair_plan": {
                "status": "repair_required_before_paper_evidence_collection",
                "repairable_for_evidence_collection": True,
                "promotion_allowed": False,
                "final_promotion_allowed": False,
                "repair_actions": [
                    "produce_authoritative_exact_replay_ledger",
                    "keep_final_promotion_gates_fail_closed",
                ],
            },
        }
        states = frontier._build_frontier_workflow_states(
            [
                {
                    "candidate_id": "candidate-exact",
                    "strategy_name": "strategy",
                    "family": "family",
                    "objective_scorecard": {"net_pnl_per_day": "25"},
                    "full_window": {"net_per_day": "25"},
                    "screening": {"status": "passed"},
                    "staged_search": {
                        "stage": "full_replay",
                        "full_replay_selected_after_train_rank": True,
                        "full_replay_selection_reason": (
                            "exploitation_top_economic_rank"
                        ),
                    },
                    "exact_replay_ledger_artifact_ref": (
                        "/tmp/candidate-exact-replay-ledger.json"
                    ),
                    "exact_replay_ledger_artifact_row_count": 6,
                    "exact_replay_ledger_artifact_fill_count": 2,
                    "hard_vetoes": [],
                    "ranking": {"vetoed": False},
                },
                {
                    "candidate_id": "candidate-preview-only",
                    "objective_scorecard": {"net_pnl_per_day": "15"},
                    "full_window": {"net_per_day": "15"},
                    "screening": {"status": "passed"},
                    "staged_search": {"stage": "train_screen_only"},
                    "hard_vetoes": ["full_replay_candidate_budget_exhausted"],
                },
            ],
            paper_probation_shortlist=[paper_handoff, blocked_handoff],
        )

        self.assertEqual(
            [item["candidate_id"] for item in states["preview_qualified"]],
            ["candidate-exact", "candidate-preview-only"],
        )
        self.assertEqual(
            [item["candidate_id"] for item in states["exact_replay_shortlist"]],
            ["candidate-exact"],
        )
        self.assertEqual(
            [item["candidate_id"] for item in states["exact_replay_qualified"]],
            ["candidate-exact"],
        )
        self.assertEqual(
            states["paper_probation_shortlisted"], [paper_handoff, blocked_handoff]
        )
        self.assertEqual(
            [item["candidate_id"] for item in states["paper_probation_repair_queue"]],
            ["candidate-needs-repair"],
        )
        self.assertFalse(
            states["paper_probation_repair_queue"][0]["repair_plan"][
                "promotion_allowed"
            ]
        )
        self.assertEqual(states["authority_proof"]["status"], "absent")
        self.assertFalse(states["authority_proof"]["promotion_allowed"])
        self.assertFalse(states["authority_proof"]["final_promotion_allowed"])

    def test_generate_symbol_prune_children_removes_worst_symbols_from_universe(
        self,
    ) -> None:
        children = frontier._generate_symbol_prune_children(
            cli_symbols=(),
            strategy_overrides={"universe_symbols": ["NVDA", "AVGO", "MSFT"]},
            configmap_payload={},
            strategy_name="intraday-tsmom-profit-v3",
            symbol_contributions={
                "AVGO": {"contribution_score": "-200", "net_pnl": "-100"},
                "NVDA": {"contribution_score": "-50", "net_pnl": "10"},
                "MSFT": {"contribution_score": "100", "net_pnl": "120"},
            },
            branch_count=2,
            min_universe_size=2,
        )
        self.assertEqual(children[0][0], "AVGO")
        self.assertEqual(children[0][1]["universe_symbols"], ["NVDA", "MSFT"])
        self.assertEqual(children[1][0], "NVDA")
        self.assertEqual(children[1][1]["universe_symbols"], ["AVGO", "MSFT"])

    def test_generate_loss_repair_children_tightens_controls_and_exposure(
        self,
    ) -> None:
        configmap_payload = {
            "data": {
                "strategies.yaml": yaml.safe_dump(
                    {
                        "strategies": [
                            {
                                "name": "intraday-tsmom-profit-v3",
                                "max_notional_per_trade": "20000",
                                "max_position_pct_equity": "0.50",
                                "params": {
                                    "long_stop_loss_bps": "12",
                                    "long_trailing_stop_drawdown_bps": "4",
                                    "max_session_negative_exit_bps": "12",
                                    "max_stop_loss_exits_per_session": "2",
                                    "stop_loss_lockout_seconds": "1200",
                                    "negative_exit_lockout_seconds": "900",
                                    "max_gross_exposure_pct_equity": "1.0",
                                },
                            }
                        ],
                    },
                    sort_keys=False,
                )
            }
        }

        children = frontier._generate_loss_repair_children(
            params_candidate={},
            strategy_overrides={},
            candidate_configmap=configmap_payload,
            strategy_name="intraday-tsmom-profit-v3",
            hard_vetoes=["worst_day_loss_above_max"],
            full_window_summary={},
            branch_count=2,
        )

        self.assertEqual(
            children[0][0], "loss_controls_and_exposure:worst_day_loss_above_max"
        )
        repaired_params = children[0][1]
        repaired_overrides = children[0][2]
        self.assertEqual(repaired_params["long_stop_loss_bps"], "9")
        self.assertEqual(repaired_params["long_trailing_stop_drawdown_bps"], "3")
        self.assertEqual(repaired_params["max_session_negative_exit_bps"], "9")
        self.assertEqual(repaired_params["max_stop_loss_exits_per_session"], "1")
        self.assertEqual(repaired_params["stop_loss_lockout_seconds"], "2400")
        self.assertEqual(repaired_params["negative_exit_lockout_seconds"], "1800")
        self.assertEqual(repaired_params["max_gross_exposure_pct_equity"], "0.75")
        self.assertEqual(repaired_overrides["max_notional_per_trade"], "15000")
        self.assertEqual(repaired_overrides["max_position_pct_equity"], "0.375")

    def test_generate_loss_repair_children_uses_capital_aware_exposure_scale(
        self,
    ) -> None:
        configmap_payload = {
            "data": {
                "strategies.yaml": yaml.safe_dump(
                    {
                        "strategies": [
                            {
                                "name": "microbar-cross-sectional-pairs-v1",
                                "max_notional_per_trade": "157950",
                                "max_position_pct_equity": "0.50",
                                "params": {
                                    "max_gross_exposure_pct_equity": "1.0",
                                },
                            }
                        ],
                    },
                    sort_keys=False,
                )
            }
        }

        children = frontier._generate_loss_repair_children(
            params_candidate={},
            strategy_overrides={},
            candidate_configmap=configmap_payload,
            strategy_name="microbar-cross-sectional-pairs-v1",
            hard_vetoes=[
                "gross_exposure_pct_equity_above_max",
                "min_cash_below_min",
            ],
            full_window_summary={
                "max_gross_exposure_pct_equity": "8.181368403273092342936517235",
                "max_gross_exposure_pct_equity_required": "999999999",
                "min_cash": "-234450.4847634027429531207507",
                "min_cash_required": "-999999999",
            },
            branch_count=1,
            policy_required_max_gross_exposure_pct_equity=Decimal("1.0"),
            policy_required_min_cash=Decimal("0"),
        )

        self.assertEqual(
            children[0][0],
            "loss_controls_and_exposure:gross_exposure_pct_equity_above_max",
        )
        self.assertEqual(children[0][1]["max_gross_exposure_pct_equity"], "0.116117")
        self.assertEqual(children[0][2]["max_notional_per_trade"], "18340.68015")
        self.assertEqual(children[0][2]["max_position_pct_equity"], "0.058058")

    def test_generate_loss_repair_children_ignores_non_loss_vetoes(self) -> None:
        children = frontier._generate_loss_repair_children(
            params_candidate={"entry_cooldown_seconds": "300"},
            strategy_overrides={},
            candidate_configmap={},
            strategy_name="intraday-tsmom-profit-v3",
            hard_vetoes=["active_day_ratio_below_min"],
            full_window_summary={},
            branch_count=2,
        )

        self.assertEqual(children, [])

    def test_generate_consistency_repair_children_increases_activity_and_breadth(
        self,
    ) -> None:
        configmap_payload = {
            "data": {
                "strategies.yaml": yaml.safe_dump(
                    {
                        "strategies": [
                            {
                                "name": "microbar-cross-sectional-pairs-v1",
                                "params": {
                                    "max_entries_per_session": "1",
                                    "top_n": "2",
                                    "entry_cooldown_seconds": "300",
                                },
                            }
                        ],
                    },
                    sort_keys=False,
                )
            }
        }

        children = frontier._generate_consistency_repair_children(
            params_candidate={},
            strategy_overrides={},
            candidate_configmap=configmap_payload,
            strategy_name="microbar-cross-sectional-pairs-v1",
            hard_vetoes=[
                "active_day_ratio_below_min",
                "avg_daily_notional_below_min",
                "best_day_share_above_max",
            ],
            full_window_summary={
                "net_per_day": "97",
                "max_gross_exposure_pct_equity": "0.97",
                "min_cash": "935",
                "negative_cash_observation_count": "0",
            },
            branch_count=3,
        )

        self.assertEqual(
            children[0][0], "consistency_breadth:active_day_ratio_below_min"
        )
        self.assertEqual(children[0][1], {"top_n": "3"})
        self.assertEqual(children[0][2], {})
        self.assertEqual(
            children[1][0], "consistency_entries:active_day_ratio_below_min"
        )
        self.assertEqual(children[1][1], {"max_entries_per_session": "2"})
        self.assertEqual(
            children[2][0], "consistency_cooldown:active_day_ratio_below_min"
        )
        self.assertEqual(children[2][1], {"entry_cooldown_seconds": "150"})

    def test_generate_consistency_repair_children_relaxes_signal_thresholds_first(
        self,
    ) -> None:
        configmap_payload = {
            "data": {
                "strategies.yaml": yaml.safe_dump(
                    {
                        "strategies": [
                            {
                                "name": "microbar-cross-sectional-pairs-v1",
                                "params": {
                                    "min_cross_section_continuation_rank": "0.55",
                                    "min_cross_section_reversal_rank": "0.65",
                                    "max_entries_per_session": "1",
                                    "top_n": "2",
                                },
                            }
                        ],
                    },
                    sort_keys=False,
                )
            }
        }

        children = frontier._generate_consistency_repair_children(
            params_candidate={},
            strategy_overrides={},
            candidate_configmap=configmap_payload,
            strategy_name="microbar-cross-sectional-pairs-v1",
            hard_vetoes=["active_day_ratio_below_min"],
            full_window_summary={
                "net_per_day": "131",
                "max_gross_exposure_pct_equity": "0.93",
                "min_cash": "2089",
                "negative_cash_observation_count": "0",
            },
            branch_count=2,
        )

        self.assertEqual(
            children[0][0], "consistency_signal_thresholds:active_day_ratio_below_min"
        )
        self.assertEqual(
            children[0][1],
            {
                "min_cross_section_continuation_rank": "0.5",
                "min_cross_section_reversal_rank": "0.6",
            },
        )
        self.assertEqual(
            children[1][0], "consistency_breadth:active_day_ratio_below_min"
        )
        self.assertEqual(children[1][1], {"top_n": "3"})

    def test_relax_signal_threshold_candidate_param_scales_absolute_thresholds(
        self,
    ) -> None:
        params: dict[str, object] = {}

        repaired = frontier._relax_signal_threshold_candidate_param(
            params=params,
            strategy_params={
                "min_recent_microprice_bias_bps": "2.50",
                "min_cross_section_continuation_rank": "0.01",
            },
            keys=(
                "min_recent_microprice_bias_bps",
                "min_cross_section_continuation_rank",
            ),
        )

        self.assertTrue(repaired)
        self.assertEqual(params["min_recent_microprice_bias_bps"], "2")
        self.assertNotIn("min_cross_section_continuation_rank", params)

    def test_generate_consistency_repair_children_rejects_unsafe_parent(
        self,
    ) -> None:
        children = frontier._generate_consistency_repair_children(
            params_candidate={"max_entries_per_session": "1"},
            strategy_overrides={},
            candidate_configmap={},
            strategy_name="microbar-cross-sectional-pairs-v1",
            hard_vetoes=["active_day_ratio_below_min", "min_cash_below_min"],
            full_window_summary={
                "net_per_day": "97",
                "max_gross_exposure_pct_equity": "1.2",
                "min_cash": "-1",
            },
            branch_count=3,
        )

        self.assertEqual(children, [])

    def test_consistency_repair_helpers_reject_non_actionable_inputs(self) -> None:
        self.assertFalse(frontier._positive_capital_safe_summary({}))
        self.assertFalse(
            frontier._positive_capital_safe_summary(
                {
                    "net_per_day": "-1",
                    "max_gross_exposure_pct_equity": "0.9",
                    "min_cash": "10",
                }
            )
        )
        self.assertFalse(
            frontier._positive_capital_safe_summary(
                {
                    "net_per_day": "1",
                    "max_gross_exposure_pct_equity": "0.9",
                    "min_cash": "10",
                    "negative_cash_observation_count": "bad",
                }
            )
        )
        self.assertIsNone(
            frontier._consistency_repair_trigger_reason(
                hard_vetoes=["avg_daily_notional_below_min"],
                full_window_summary={},
            )
        )
        self.assertIsNone(
            frontier._consistency_repair_trigger_reason(
                hard_vetoes=["profit_factor_below_min"],
                full_window_summary={
                    "net_per_day": "1",
                    "max_gross_exposure_pct_equity": "0.9",
                    "min_cash": "10",
                },
            )
        )
        self.assertFalse(
            frontier._increment_integer_candidate_param(
                params={},
                strategy_params={"ignored": "1", "max_entries_per_session": "bad"},
                keys=("missing", "max_entries_per_session"),
            )
        )
        self.assertFalse(
            frontier._halve_positive_integer_candidate_param(
                params={},
                strategy_params={"ignored": "1", "entry_cooldown_seconds": "1"},
                keys=("missing", "entry_cooldown_seconds"),
            )
        )
        self.assertFalse(
            frontier._relax_signal_threshold_candidate_param(
                params={},
                strategy_params={
                    "ignored": "1",
                    "min_cross_section_continuation_rank": "bad",
                },
                keys=("missing", "min_cross_section_continuation_rank"),
            )
        )

        self.assertEqual(
            frontier._generate_consistency_repair_children(
                params_candidate={},
                strategy_overrides={},
                candidate_configmap={},
                strategy_name="microbar-cross-sectional-pairs-v1",
                hard_vetoes=["active_day_ratio_below_min"],
                full_window_summary={
                    "net_per_day": "1",
                    "max_gross_exposure_pct_equity": "0.9",
                    "min_cash": "10",
                },
                branch_count=3,
            ),
            [],
        )

    def test_consistency_repair_children_are_branch_count_bounded(self) -> None:
        configmap_payload = {
            "data": {
                "strategies.yaml": yaml.safe_dump(
                    {
                        "strategies": [
                            {
                                "name": "microbar-cross-sectional-pairs-v1",
                                "params": {
                                    "max_entries_per_session": "1",
                                    "top_n": "2",
                                    "entry_cooldown_seconds": "300",
                                },
                            }
                        ],
                    },
                    sort_keys=False,
                )
            }
        }

        children = frontier._generate_consistency_repair_children(
            params_candidate={},
            strategy_overrides={},
            candidate_configmap=configmap_payload,
            strategy_name="microbar-cross-sectional-pairs-v1",
            hard_vetoes=["active_day_ratio_below_min"],
            full_window_summary={
                "net_per_day": "97",
                "max_gross_exposure_pct_equity": "0.97",
                "min_cash": "935",
            },
            branch_count=1,
        )

        self.assertEqual(len(children), 1)
        self.assertEqual(
            children[0][0], "consistency_breadth:active_day_ratio_below_min"
        )

    def test_consistency_repair_children_target_second_oos_shortfall(
        self,
    ) -> None:
        configmap_payload = {
            "data": {
                "strategies.yaml": yaml.safe_dump(
                    {
                        "strategies": [
                            {
                                "name": "washout-rebound-long-v1",
                                "params": {
                                    "max_entries_per_session": "2",
                                    "entry_cooldown_seconds": "600",
                                },
                            }
                        ],
                    },
                    sort_keys=False,
                )
            }
        }

        children = frontier._generate_consistency_repair_children(
            params_candidate={},
            strategy_overrides={},
            candidate_configmap=configmap_payload,
            strategy_name="washout-rebound-long-v1",
            hard_vetoes=["second_oos_net_per_day_below_target"],
            full_window_summary={
                "net_per_day": "515",
                "max_gross_exposure_pct_equity": "0.95",
                "min_cash": "2500",
                "negative_cash_observation_count": "0",
            },
            branch_count=2,
        )

        self.assertEqual(
            children[0][0],
            "consistency_entries:second_oos_net_per_day_below_target",
        )
        self.assertEqual(children[0][1], {"max_entries_per_session": "3"})
        self.assertEqual(
            children[1][0],
            "consistency_cooldown:second_oos_net_per_day_below_target",
        )
        self.assertEqual(children[1][1], {"entry_cooldown_seconds": "300"})

        unsafe_children = frontier._generate_consistency_repair_children(
            params_candidate={},
            strategy_overrides={},
            candidate_configmap=configmap_payload,
            strategy_name="washout-rebound-long-v1",
            hard_vetoes=["second_oos_net_per_day_below_target"],
            full_window_summary={
                "net_per_day": "515",
                "max_gross_exposure_pct_equity": "1.2",
                "min_cash": "-1",
                "negative_cash_observation_count": "1",
            },
            branch_count=2,
        )

        self.assertEqual(unsafe_children, [])

    def test_loss_repair_configmap_lookup_handles_invalid_shapes(self) -> None:
        invalid_payloads = [
            {"not_data": {}},
            {"data": {"strategies.yaml": {"not": "yaml"}}},
            {"data": {"strategies.yaml": "[]"}},
            {"data": {"strategies.yaml": "strategies: {}\n"}},
            {
                "data": {
                    "strategies.yaml": yaml.safe_dump(
                        {
                            "strategies": [
                                "not-a-strategy",
                                {"name": "other-strategy", "params": {"stop": "1"}},
                            ]
                        }
                    )
                }
            },
        ]

        for payload in invalid_payloads:
            with self.subTest(payload=payload):
                item, params = frontier._strategy_item_from_configmap(
                    configmap_payload=payload,
                    strategy_name="intraday-tsmom-profit-v3",
                )
                self.assertEqual(item, {})
                self.assertEqual(params, {})

    def test_loss_repair_decimal_helpers_reject_invalid_or_non_reducing_values(
        self,
    ) -> None:
        self.assertIsNone(frontier._decimal_or_none(None))
        self.assertIsNone(frontier._decimal_or_none(" "))
        self.assertIsNone(frontier._decimal_or_none("not-a-decimal"))
        self.assertIsNone(
            frontier._tightened_bps("0", floor=Decimal("4")),
        )
        self.assertIsNone(
            frontier._tightened_bps("4", floor=Decimal("4")),
        )
        self.assertIsNone(frontier._reduced_exposure("0"))
        self.assertIsNone(frontier._reduced_exposure("0.0000001"))
        self.assertIsNone(frontier._reduced_exposure("NaN"))
        self.assertIsNone(frontier._reduced_exposure("Infinity"))
        self.assertEqual(
            frontier._reduced_exposure("1.5", scale=Decimal("0.116117")),
            "0.174175",
        )

    def test_capital_repair_exposure_scale_uses_summary_thresholds(self) -> None:
        self.assertEqual(frontier._capital_repair_exposure_scale({}), Decimal("0.75"))
        self.assertEqual(
            frontier._capital_repair_exposure_scale(
                {
                    "max_gross_exposure_pct_equity": "8.181368403273092342936517235",
                    "max_gross_exposure_pct_equity_required": "1.0",
                }
            ),
            Decimal("0.116117"),
        )
        self.assertEqual(
            frontier._capital_repair_exposure_scale(
                {
                    "min_cash": "-1",
                    "min_cash_required": "0",
                }
            ),
            Decimal("0.5"),
        )
        self.assertEqual(
            frontier._capital_repair_exposure_scale(
                {
                    "max_gross_exposure_pct_equity": "10000000",
                    "max_gross_exposure_pct_equity_required": "1.0",
                }
            ),
            Decimal("0.000001"),
        )
        self.assertEqual(
            frontier._capital_repair_exposure_scale(
                {
                    "max_gross_exposure_pct_equity": "NaN",
                    "max_gross_exposure_pct_equity_required": "1.0",
                }
            ),
            Decimal("0.75"),
        )
        self.assertEqual(
            frontier._capital_repair_exposure_scale(
                {
                    "max_gross_exposure_pct_equity": "8.181368403273092342936517235",
                    "max_gross_exposure_pct_equity_required": "999999999",
                    "min_cash": "-234450.4847634027429531207507",
                    "min_cash_required": "-999999999",
                },
                policy_required_max_gross_exposure_pct_equity=Decimal("1.0"),
                policy_required_min_cash=Decimal("0"),
            ),
            Decimal("0.116117"),
        )

    def test_paper_probation_notional_scale_helpers_cover_edge_cases(self) -> None:
        policy = frontier.ObjectiveVetoPolicy(
            required_max_gross_exposure_pct_equity=Decimal("1"),
            required_min_cash=Decimal("0"),
        )
        item = {
            "objective_scorecard": {
                "max_gross_exposure_pct_equity": "8",
                "min_cash": "100",
            }
        }

        self.assertEqual(
            frontier._paper_probation_notional_scale(
                item=item,
                objective_veto_policy=policy,
                hard_vetoes=["gross_exposure_pct_equity_above_max"],
            ),
            "0.11875",
        )
        self.assertEqual(
            frontier._paper_probation_target_notional_scale(
                capital_repaired_net_pnl_per_day=Decimal("100"),
                target_net_pnl_per_day=Decimal("0"),
            ),
            Decimal("1"),
        )
        self.assertEqual(
            frontier._paper_probation_target_notional_scale(
                capital_repaired_net_pnl_per_day=Decimal("0"),
                target_net_pnl_per_day=Decimal("500"),
            ),
            Decimal("0"),
        )

    def test_positive_capital_safe_summary_rejects_non_finite_values(self) -> None:
        self.assertFalse(
            frontier._positive_capital_safe_summary(
                {
                    "net_per_day": "NaN",
                    "max_gross_exposure_pct_equity": "0.9",
                    "min_cash": "10",
                    "negative_cash_observation_count": "0",
                }
            )
        )

    def test_loss_repair_trigger_reason_accepts_suffix_and_daily_summary(
        self,
    ) -> None:
        self.assertEqual(
            frontier._loss_repair_trigger_reason(
                hard_vetoes=["second_oos_worst_day_loss_above_max"],
                full_window_summary={},
            ),
            "second_oos_worst_day_loss_above_max",
        )
        self.assertEqual(
            frontier._loss_repair_trigger_reason(
                hard_vetoes=[],
                full_window_summary={"daily_net_below_min_count": "2"},
            ),
            "daily_net_below_min",
        )
        self.assertIsNone(
            frontier._loss_repair_trigger_reason(
                hard_vetoes=[],
                full_window_summary={"daily_net_below_min_count": "bad"},
            )
        )

    def test_loss_repair_tightening_skips_absent_or_non_reducible_controls(
        self,
    ) -> None:
        params = {
            "long_stop_loss_bps": "0",
            "max_stop_loss_exits_per_session": "1",
            "stop_loss_lockout_seconds": "-1",
        }

        changed = frontier._apply_loss_control_tightening(
            params=params,
            strategy_params={},
        )

        self.assertFalse(changed)
        self.assertEqual(
            params,
            {
                "long_stop_loss_bps": "0",
                "max_stop_loss_exits_per_session": "1",
                "stop_loss_lockout_seconds": "-1",
            },
        )

    def test_loss_repair_exposure_clamp_skips_absent_exposure_controls(
        self,
    ) -> None:
        params: dict[str, object] = {}
        overrides: dict[str, object] = {}

        changed = frontier._apply_exposure_clamp(
            params=params,
            overrides=overrides,
            strategy_item={},
            strategy_params={},
        )

        self.assertFalse(changed)
        self.assertEqual(params, {})
        self.assertEqual(overrides, {})
