from __future__ import annotations

# ruff: noqa: F401,F403,F405

from tests.submission_council.support import *


class TestSubmissionCouncilPaperProbationImportPlan(SubmissionCouncilTestCase):
    def test_clean_source_backed_probation_requests_bounded_collection_only(
        self,
    ) -> None:
        candidate = {
            "hypothesis_id": "H-PAIRS-01",
            "candidate_id": "c88421d619759b2cfaa6f4d0",
            "strategy_id": "microbar_cross_sectional_pairs_v1@research",
            "strategy_family": "microbar_cross_sectional_pairs",
            "account": "TORGHUT_SIM",
            "observed_stage": "paper",
            "bucket_started_at": "2026-05-29T14:30:00+00:00",
            "bucket_ended_at": "2026-05-29T15:00:00+00:00",
            "decision_count": 2,
            "submitted_order_count": 2,
            "fill_count": 2,
            "closed_trade_count": 2,
            "open_position_count": 0,
            "filled_notional": "127090.02495200",
            "cost_amount": "14",
            "net_strategy_pnl_after_costs": "567.44720578",
            "post_cost_expectancy_bps": "44.64923238",
            "pnl_basis": "realized_strategy_pnl_after_explicit_costs",
            "execution_policy_hash_counts": {"policy": 2},
            "cost_model_hash_counts": {"cost": 2},
            "lineage_hash_counts": {"lineage": 2},
            "source_window_start": "2026-05-29T14:30:00+00:00",
            "source_window_end": "2026-05-29T15:00:00+00:00",
            "source_refs": [
                "postgres:trade_decisions",
                "postgres:executions",
                "postgres:execution_order_events",
                "postgres:order_feed_source_windows",
            ],
            "source_row_counts": {
                "trade_decisions": 2,
                "executions": 2,
                "execution_order_events": 2,
                "order_feed_source_windows": 2,
            },
            "trade_decision_ids": ["decision-buy", "decision-sell"],
            "execution_ids": ["execution-buy", "execution-sell"],
            "execution_order_event_ids": ["event-fill-buy", "event-fill-sell"],
            "source_window_ids": ["source-window-buy", "source-window-sell"],
            "source_offsets": [
                {"topic": "alpaca.trade_updates", "partition": 0, "offset": 100},
                {"topic": "alpaca.trade_updates", "partition": 0, "offset": 101},
            ],
            "source_materialization": "execution_order_events",
            "authority_class": "runtime_order_feed_execution_source",
            "authority_reason": "event_sourced_runtime_ledger_profit_proof",
            "reason_codes": ["runtime_ledger_stage_not_live"],
        }

        plan = _runtime_ledger_paper_probation_import_plan([candidate])

        self.assertTrue(plan["evidence_collection_ok"])
        self.assertTrue(plan["canary_collection_authorized"])
        self.assertTrue(plan["bounded_live_paper_collection_authorized"])
        self.assertTrue(
            plan["paper_probation_satisfied_for_bounded_live_paper_collection"]
        )
        self.assertFalse(plan["promotion_allowed"])
        self.assertFalse(plan["final_promotion_allowed"])
        target = plan["targets"][0]
        self.assertTrue(
            target["paper_probation_satisfied_for_bounded_live_paper_collection"]
        )
        self.assertTrue(target["canary_collection_authorized"])
        self.assertFalse(target["capital_promotion_allowed"])
        self.assertFalse(target["final_authority_ok"])
        self.assertFalse(target["promotion_allowed"])
        self.assertFalse(target["final_promotion_allowed"])

    def test_runtime_ledger_paper_probation_import_plan_falls_back_and_skips_incomplete_targets(
        self,
    ) -> None:
        plan = _runtime_ledger_paper_probation_import_plan(
            [
                {
                    "hypothesis_id": "H-FALLBACK-01",
                    "candidate_id": "candidate-fallback",
                    "strategy_id": "microbar_cross_sectional_pairs_v1@research",
                    "strategy_family": "microbar_cross_sectional_pairs",
                    "account": "TORGHUT_SIM",
                    "bucket_started_at": "2026-05-13T17:00:00+00:00",
                    "bucket_ended_at": "2026-05-13T17:30:00+00:00",
                    "observed_stage": "paper",
                    "decision_count": 2,
                    "submitted_order_count": 2,
                    "fill_count": 2,
                    "closed_trade_count": 2,
                    "open_position_count": 0,
                    "filled_notional": "1000",
                    "cost_amount": "1.25",
                    "net_strategy_pnl_after_costs": "12.50",
                    "post_cost_expectancy_bps": "125",
                    "pnl_basis": "realized_strategy_pnl_after_explicit_costs",
                    "execution_policy_hash_counts": {"policy": 2},
                    "cost_model_hash_counts": {"cost": 2},
                    "lineage_hash_counts": {"lineage": 2},
                    "source_window_start": "2026-05-13T17:00:00+00:00",
                    "source_window_end": "2026-05-13T17:30:00+00:00",
                    "source_refs": [
                        "postgres:trade_decisions",
                        "postgres:executions",
                        "postgres:execution_order_events",
                        "postgres:order_feed_source_windows",
                    ],
                    "source_row_counts": {
                        "trade_decisions": 2,
                        "executions": 2,
                        "execution_order_events": 2,
                        "order_feed_source_windows": 2,
                    },
                    "trade_decision_ids": ["decision-1", "decision-2"],
                    "execution_ids": ["execution-1", "execution-2"],
                    "execution_order_event_ids": ["event-1", "event-2"],
                    "source_window_ids": ["source-window-1", "source-window-2"],
                    "source_offsets": [
                        {"topic": "alpaca.trade_updates", "partition": 0, "offset": 1},
                        {"topic": "alpaca.trade_updates", "partition": 0, "offset": 2},
                    ],
                    "source_materialization": "execution_order_events",
                    "authority_class": "runtime_order_feed_execution_source",
                    "authority_reason": "event_sourced_runtime_ledger_profit_proof",
                    "reason_codes": ["runtime_ledger_stage_not_live"],
                },
                {
                    "candidate_id": "candidate-missing",
                    "bucket_started_at": "2026-05-13T17:00:00+00:00",
                    "bucket_ended_at": "2026-05-13T17:30:00+00:00",
                },
            ]
        )

        self.assertEqual(plan["target_count"], 1)
        self.assertEqual(plan["skipped_target_count"], 1)
        target = plan["targets"][0]
        self.assertEqual(target["strategy_name"], "microbar-cross-sectional-pairs-v1")
        self.assertEqual(
            target["strategy_id"], "microbar_cross_sectional_pairs_v1@research"
        )
        self.assertEqual(
            target["runtime_strategy_name"], "microbar-cross-sectional-pairs-v1"
        )
        self.assertEqual(
            target["strategy_lookup_names"], ["microbar-cross-sectional-pairs-v1"]
        )
        self.assertEqual(
            target["source_manifest_ref"],
            "config/trading/hypotheses/h-fallback-01.json",
        )
        self.assertNotIn("runtime_ledger_bucket_ref", target)
        skipped_target = plan["skipped_targets"][0]
        self.assertEqual(skipped_target["candidate_id"], "candidate-missing")
        self.assertIn("hypothesis_id", skipped_target["missing_fields"])
        self.assertIn("strategy_name", skipped_target["missing_fields"])
        self.assertIn("source_manifest_ref", skipped_target["missing_fields"])

    def test_runtime_ledger_paper_probation_import_plan_uses_family_runtime_harness(
        self,
    ) -> None:
        plan = _runtime_ledger_paper_probation_import_plan(
            [
                {
                    "hypothesis_id": "H-TSMOM-LIQ",
                    "candidate_id": "candidate-tsmom",
                    "strategy_id": "intraday_tsmom_v2@research",
                    "runtime_strategy_name": "intraday-tsmom-v2",
                    "strategy_family": "intraday_tsmom_consistent",
                    "account": "TORGHUT_SIM",
                    "bucket_started_at": "2026-05-29T13:30:00+00:00",
                    "bucket_ended_at": "2026-05-29T20:00:00+00:00",
                    "source_collection_candidate": True,
                    "source_collection_reason_codes": [
                        "runtime_ledger_source_collection_pending"
                    ],
                    "reason_codes": ["runtime_ledger_source_collection_pending"],
                }
            ]
        )

        self.assertEqual(plan["target_count"], 1)
        target = plan["targets"][0]
        self.assertEqual(target["strategy_id"], "intraday_tsmom_v2@research")
        self.assertEqual(target["strategy_name"], "intraday-tsmom-profit-v3")
        self.assertEqual(target["runtime_strategy_name"], "intraday-tsmom-profit-v3")
        self.assertEqual(target["target_dsn_env"], "SIM_DB_DSN")
        self.assertEqual(target["source_account_label"], "TORGHUT_SIM")
        self.assertEqual(
            target["strategy_lookup_names"],
            ["intraday-tsmom-profit-v3", "intraday-tsmom-v2"],
        )
        self.assertFalse(
            target["paper_probation_satisfied_for_bounded_live_paper_collection"]
        )
        self.assertFalse(target["bounded_live_paper_collection_authorized"])
        self.assertFalse(target["promotion_allowed"])
        self.assertFalse(target["final_promotion_authorized"])
        self.assertFalse(target["final_promotion_allowed"])

    def test_runtime_ledger_paper_probation_import_plan_dedupes_same_window_targets(
        self,
    ) -> None:
        base_candidate = {
            "hypothesis_id": "H-PAIRS-01",
            "candidate_id": "candidate-pairs",
            "runtime_strategy_name": "microbar-pairs-vwap-cap-safe",
            "strategy_family": "microbar_cross_sectional_pairs",
            "account": "TORGHUT_REPLAY",
            "dataset_snapshot_ref": "portfolio-profit-autoresearch-500-v1",
            "source_manifest_ref": "config/trading/hypotheses/h-pairs-01.json",
            "bucket_started_at": "2026-05-21T17:00:00+00:00",
            "bucket_ended_at": "2026-05-21T17:30:00+00:00",
            "observed_stage": "paper",
            "decision_count": 2,
            "submitted_order_count": 2,
            "fill_count": 2,
            "closed_trade_count": 2,
            "open_position_count": 0,
            "filled_notional": "1000",
            "cost_amount": "1.25",
            "net_strategy_pnl_after_costs": "12.50",
            "post_cost_expectancy_bps": "125",
            "pnl_basis": "realized_strategy_pnl_after_explicit_costs",
            "execution_policy_hash_counts": {"policy": 2},
            "cost_model_hash_counts": {"cost": 2},
            "lineage_hash_counts": {"lineage": 2},
            "source_window_start": "2026-05-21T17:00:00+00:00",
            "source_window_end": "2026-05-21T17:30:00+00:00",
            "source_refs": [
                "postgres:trade_decisions",
                "postgres:executions",
                "postgres:execution_order_events",
                "postgres:order_feed_source_windows",
            ],
            "source_row_counts": {
                "trade_decisions": 2,
                "executions": 2,
                "execution_order_events": 2,
                "order_feed_source_windows": 2,
            },
            "trade_decision_ids": ["decision-1", "decision-2"],
            "execution_ids": ["execution-1", "execution-2"],
            "execution_order_event_ids": ["event-1", "event-2"],
            "source_window_ids": ["source-window-1", "source-window-2"],
            "source_offsets": [
                {"topic": "alpaca.trade_updates", "partition": 0, "offset": 1},
                {"topic": "alpaca.trade_updates", "partition": 0, "offset": 2},
            ],
            "source_materialization": "execution_order_events",
            "authority_class": "runtime_order_feed_execution_source",
            "authority_reason": "event_sourced_runtime_ledger_profit_proof",
            "reason_codes": ["runtime_ledger_stage_not_live"],
        }

        plan = _runtime_ledger_paper_probation_import_plan(
            [
                {**base_candidate, "run_id": "better-runtime-ledger"},
                {**base_candidate, "run_id": "duplicate-runtime-ledger"},
            ]
        )

        self.assertEqual(plan["target_count"], 1)
        self.assertEqual(plan["skipped_target_count"], 1)
        self.assertEqual(
            plan["targets"][0]["runtime_ledger_bucket_ref"],
            "strategy_runtime_ledger_buckets:better-runtime-ledger:"
            "2026-05-21T17:00:00+00:00:2026-05-21T17:30:00+00:00",
        )
        skipped_target = plan["skipped_targets"][0]
        self.assertEqual(
            skipped_target["reason"],
            "duplicate_runtime_ledger_paper_probation_target",
        )
        self.assertEqual(
            skipped_target["runtime_ledger_bucket_ref"],
            "strategy_runtime_ledger_buckets:duplicate-runtime-ledger:"
            "2026-05-21T17:00:00+00:00:2026-05-21T17:30:00+00:00",
        )

    def test_runtime_ledger_source_collection_target_does_not_grant_probation(
        self,
    ) -> None:
        candidates = _runtime_ledger_source_collection_candidates(
            [
                {
                    "hypothesis_id": "H-PAIRS-01",
                    "candidate_id": "c88421d619759b2cfaa6f4d0",
                    "strategy_id": "microbar_cross_sectional_pairs_v1@research",
                    "strategy_family": "microbar_cross_sectional_pairs",
                    "account": "TORGHUT_SIM",
                    "observed_stage": "paper",
                    "bucket_started_at": "2026-05-29T17:00:00+00:00",
                    "bucket_ended_at": "2026-05-29T20:00:00+00:00",
                    "submitted_order_count": 8,
                    "fill_count": 35,
                    "closed_trade_count": 12,
                    "open_position_count": 4,
                    "filled_notional": "157941.50000000",
                    "net_strategy_pnl_after_costs": "5514.86354020",
                    "reason_codes": [
                        "runtime_ledger_stage_not_live",
                        "runtime_ledger_source_window_missing",
                        "runtime_ledger_source_refs_missing",
                        "execution_reconstruction_not_runtime_ledger_proof",
                        "unclosed_position",
                    ],
                }
            ]
        )

        self.assertEqual(len(candidates), 1)
        self.assertTrue(candidates[0]["source_collection_authorized"])
        self.assertFalse(candidates[0].get("paper_probation_eligible", False))
        plan = _runtime_ledger_paper_probation_import_plan(candidates)

        self.assertEqual(plan["target_count"], 1)
        self.assertEqual(plan["paper_probation_target_count"], 0)
        self.assertEqual(plan["source_collection_target_count"], 1)
        target = plan["targets"][0]
        self.assertEqual(target["source_dsn_env"], "SIM_DB_DSN")
        self.assertEqual(target["target_dsn_env"], "SIM_DB_DSN")
        self.assertEqual(target["source_account_label"], "TORGHUT_SIM")
        self.assertEqual(
            target["source_kind"], "runtime_ledger_source_collection_candidate"
        )
        self.assertFalse(target["paper_probation_authorized"])
        self.assertTrue(target["source_collection_authorized"])
        self.assertFalse(target["probation_allowed"])
        self.assertFalse(target["promotion_allowed"])
        self.assertFalse(target["final_promotion_allowed"])
        self.assertIn(
            "runtime_ledger_source_window_evidence_pending",
            target["final_promotion_blockers"],
        )
        self.assertIn(
            "runtime_ledger_source_window_missing",
            target["source_collection_reason_codes"],
        )

    def test_runtime_ledger_source_collection_replay_bucket_reads_from_live_db(
        self,
    ) -> None:
        candidates = _runtime_ledger_source_collection_candidates(
            [
                {
                    "source": "strategy_runtime_ledger_buckets",
                    "hypothesis_id": "H-PAIRS-01",
                    "candidate_id": "c88421d619759b2cfaa6f4d0",
                    "strategy_id": "microbar_cross_sectional_pairs_v1@research",
                    "strategy_family": "microbar_cross_sectional_pairs",
                    "runtime_strategy_name": "microbar-pairs-vwap-cap-safe",
                    "account": "TORGHUT_REPLAY",
                    "observed_stage": "paper",
                    "bucket_started_at": "2026-05-13T17:00:00+00:00",
                    "bucket_ended_at": "2026-05-13T17:30:00+00:00",
                    "submitted_order_count": 8,
                    "fill_count": 35,
                    "closed_trade_count": 2,
                    "open_position_count": 0,
                    "filled_notional": "127090.02495200",
                    "cost_amount": "12.42289104",
                    "net_strategy_pnl_after_costs": "567.44720578",
                    "post_cost_expectancy_bps": "44.64923238",
                    "pnl_basis": "realized_strategy_pnl_after_explicit_costs",
                    "source_window_ids": ["window-1", "window-2"],
                    "trade_decision_ids": ["decision-1", "decision-2"],
                    "execution_ids": ["execution-1", "execution-2"],
                    "execution_tca_metric_ids": ["tca-1", "tca-2"],
                    "execution_order_event_ids": ["event-1", "event-2"],
                    "source_offsets": [
                        {
                            "topic": "torghut.trade-updates.v1",
                            "partition": 1,
                            "offset": 7091,
                        },
                        {
                            "topic": "torghut.trade-updates.v1",
                            "partition": 1,
                            "offset": 7092,
                        },
                    ],
                    "source_materialization": "execution_order_events",
                    "authority_class": "runtime_order_feed_execution_source",
                    "authority_reason": "event_sourced_runtime_ledger_profit_proof",
                    "reason_codes": [
                        "runtime_ledger_source_window_missing",
                        "runtime_ledger_source_refs_missing",
                        "execution_reconstruction_not_runtime_ledger_proof",
                    ],
                }
            ]
        )

        self.assertEqual(len(candidates), 1)
        self.assertTrue(candidates[0]["source_collection_profit_target_candidate"])
        self.assertEqual(
            candidates[0]["source_collection_priority"],
            "profit_target_source_materialization",
        )
        plan = _runtime_ledger_paper_probation_import_plan(candidates)

        self.assertEqual(plan["target_count"], 1)
        self.assertEqual(plan["source_collection_profit_target_count"], 1)
        target = plan["targets"][0]
        self.assertEqual(target["source_dsn_env"], "DB_DSN")
        self.assertEqual(target["target_dsn_env"], "SIM_DB_DSN")
        self.assertEqual(target["source_account_label"], "TORGHUT_REPLAY")
        self.assertEqual(
            target["source_kind"], "runtime_ledger_source_collection_candidate"
        )
        self.assertTrue(target["source_collection_authorized"])
        self.assertFalse(target["paper_probation_authorized"])
        self.assertFalse(target["promotion_allowed"])
        self.assertFalse(target["final_promotion_allowed"])
        self.assertTrue(target["bounded_evidence_collection_authorized"])
        self.assertEqual(target["target_notional"], "25")
        self.assertEqual(target["bounded_evidence_collection_max_notional"], "25")
        self.assertEqual(target["max_notional"], "25")
        self.assertEqual(
            target["selection_reason"], "profit_target_source_window_evidence_pending"
        )
        self.assertEqual(
            target["source_collection_next_action"],
            "materialize_runtime_ledger_source_window_refs",
        )
        self.assertEqual(target["source_window_ids"], ["window-1", "window-2"])
        self.assertEqual(target["trade_decision_ids"], ["decision-1", "decision-2"])
        self.assertEqual(target["execution_ids"], ["execution-1", "execution-2"])
        self.assertEqual(target["execution_tca_metric_ids"], ["tca-1", "tca-2"])
        self.assertEqual(target["execution_order_event_ids"], ["event-1", "event-2"])
        self.assertEqual(target["source_materialization"], "execution_order_events")
        self.assertEqual(
            target["authority_class"], "runtime_order_feed_execution_source"
        )
        self.assertEqual(
            target["authority_reason"], "event_sourced_runtime_ledger_profit_proof"
        )
        self.assertEqual(
            target["source_offsets"],
            [
                {
                    "topic": "torghut.trade-updates.v1",
                    "partition": 1,
                    "offset": 7091,
                },
                {
                    "topic": "torghut.trade-updates.v1",
                    "partition": 1,
                    "offset": 7092,
                },
            ],
        )
        self.assertEqual(target["probation_target_shortfall"], "0")
        self.assertEqual(
            target["probation_target_progress_ratio"],
            "1.13489441156",
        )
        self.assertEqual(target["required_notional_repair_scale_to_target"], "1")
        self.assertEqual(
            target["required_notional_repair_scale_authority"],
            "linear_notional_sizing_estimate_for_repair_only_not_capital_authority",
        )
        self.assertFalse(target["live_capital_authorized"])
        self.assertTrue(target["final_promotion_requires_live_paper_runtime_proof"])
        self.assertIn(
            "runtime_ledger_execution_order_event_refs",
            target["live_paper_evidence_requirements"],
        )
        self.assertEqual(
            target["safe_evidence_collection_path"][0],
            "materialize_runtime_ledger_source_window_refs",
        )
