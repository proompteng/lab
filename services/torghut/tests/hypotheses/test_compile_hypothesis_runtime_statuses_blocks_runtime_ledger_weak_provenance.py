from __future__ import annotations

from tests.hypotheses.support import (
    EXACT_REPLAY_LEDGER_SCHEMA_VERSION,
    JangarDependencyQuorumStatus,
    POST_COST_PNL_BASIS,
    _MANIFEST_CANDIDATE_IDS,
    _MANIFEST_STRATEGY_FAMILIES,
    _TestHypothesisReadinessBase,
    _hpairs_route_repair_tca_summary,
    _runtime_ledger_summary,
    _state,
    compile_hypothesis_runtime_statuses,
    datetime,
    load_hypothesis_registry,
    timezone,
)


class TestCompileHypothesisRuntimeStatusesBlocksRuntimeLedgerWeakProvenance(
    _TestHypothesisReadinessBase
):
    def test_compile_hypothesis_runtime_statuses_blocks_runtime_ledger_weak_provenance(
        self,
    ) -> None:
        registry = load_hypothesis_registry()
        state = _state(
            feature_rows=5,
            drift_checks=3,
            evidence_checks=2,
            signal_lag_seconds=15,
            evidence_report={
                "ok": True,
                "checked_at": "2026-03-06T15:45:00+00:00",
            },
        )
        statuses = compile_hypothesis_runtime_statuses(
            registry=registry,
            state=state,
            tca_summary={
                "order_count": 45,
                "avg_abs_slippage_bps": 4,
                "avg_realized_shortfall_bps": -8,
                "last_computed_at": "2026-03-06T15:50:00+00:00",
            },
            runtime_ledger_summary={
                "by_hypothesis": {
                    "H-CONT-01": {
                        "hypothesis_id": "H-CONT-01",
                        "candidate_id": _MANIFEST_CANDIDATE_IDS["H-CONT-01"],
                        "observed_stage": "live",
                        "strategy_family": _MANIFEST_STRATEGY_FAMILIES["H-CONT-01"],
                        "bucket_started_at": "2026-03-06T15:45:00+00:00",
                        "bucket_ended_at": "2026-03-06T15:55:00+00:00",
                        "submitted_order_count": 45,
                        "post_cost_expectancy_bps": "8",
                        "ledger_schema_version": "unknown",
                        "pnl_basis": "broker_tca_shortfall_estimate",
                        "execution_policy_hash_counts": {},
                        "cost_model_hash_counts": {},
                        "lineage_hash_counts": {},
                    }
                }
            },
            market_context_status={"last_freshness_seconds": 60},
            jangar_dependency_quorum=JangarDependencyQuorumStatus(
                decision="allow",
                reasons=[],
                message="ok",
            ),
            now=datetime(2026, 3, 6, 16, 0, tzinfo=timezone.utc),
        )

        cont = next(item for item in statuses if item["hypothesis_id"] == "H-CONT-01")
        self.assertFalse(cont["promotion_eligible"])
        self.assertIn("runtime_ledger_schema_version_invalid", cont["reasons"])
        self.assertIn("runtime_ledger_pnl_basis_invalid", cont["reasons"])
        self.assertIn("runtime_ledger_execution_policy_hash_missing", cont["reasons"])
        self.assertIn("runtime_ledger_cost_model_hash_missing", cont["reasons"])
        self.assertIn("runtime_ledger_lineage_hash_missing", cont["reasons"])

    def test_compile_hypothesis_runtime_statuses_blocks_runtime_ledger_lifecycle_blockers(
        self,
    ) -> None:
        registry = load_hypothesis_registry()
        state = _state(
            feature_rows=5,
            drift_checks=3,
            evidence_checks=2,
            signal_lag_seconds=15,
            evidence_report={
                "ok": True,
                "checked_at": "2026-03-06T15:45:00+00:00",
            },
        )
        statuses = compile_hypothesis_runtime_statuses(
            registry=registry,
            state=state,
            tca_summary={
                "order_count": 45,
                "avg_abs_slippage_bps": 4,
                "avg_realized_shortfall_bps": -8,
                "last_computed_at": "2026-03-06T15:50:00+00:00",
            },
            runtime_ledger_summary={
                "hypothesis_id": "H-CONT-01",
                "observed_stage": "live",
                "bucket_ended_at": "2026-03-06T15:10:00+00:00",
                "submitted_order_count": 45,
                "post_cost_expectancy_bps": "8",
                "items": [
                    "ignored",
                    {
                        "hypothesis_id": "H-IGNORED-01",
                        "observed_stage": "live",
                    },
                    {
                        "hypothesis_id": "H-CONT-01",
                        "candidate_id": _MANIFEST_CANDIDATE_IDS["H-CONT-01"],
                        "observed_stage": "live",
                        "strategy_family": _MANIFEST_STRATEGY_FAMILIES["H-CONT-01"],
                        "bucket_started_at": "2026-03-06T15:45:00+00:00",
                        "bucket_ended_at": "2026-03-06T15:55:00+00:00",
                        "submitted_order_count": 45,
                        "closed_trade_count": 5,
                        "post_cost_expectancy_bps": "8",
                        "ledger_schema_version": EXACT_REPLAY_LEDGER_SCHEMA_VERSION,
                        "pnl_basis": POST_COST_PNL_BASIS,
                        "execution_policy_hash_counts": {"policy-sha": 1},
                        "cost_model_hash_counts": {"cost-sha": 1},
                        "lineage_hash_counts": {"lineage-sha": 1},
                        "blockers": [
                            "unclosed_position",
                            "",
                            "unclosed_position",
                        ],
                    },
                ],
            },
            market_context_status={"last_freshness_seconds": 60},
            jangar_dependency_quorum=JangarDependencyQuorumStatus(
                decision="allow",
                reasons=[],
                message="ok",
            ),
            now=datetime(2026, 3, 6, 16, 0, tzinfo=timezone.utc),
        )

        cont = next(item for item in statuses if item["hypothesis_id"] == "H-CONT-01")
        self.assertFalse(cont["promotion_eligible"])
        self.assertTrue(cont["rollback_required"])
        self.assertEqual(cont["reasons"], ["unclosed_position"])
        observed = cont["observed"]
        self.assertEqual(observed["runtime_ledger_blockers"], ["unclosed_position"])
        self.assertEqual(
            observed["runtime_ledger_bucket_ended_at"], "2026-03-06T15:55:00+00:00"
        )
        self.assertEqual(observed["runtime_ledger_execution_policy_hash_count"], 1)
        self.assertEqual(observed["runtime_ledger_cost_model_hash_count"], 1)
        self.assertEqual(observed["runtime_ledger_lineage_hash_count"], 1)

    def test_compile_hypothesis_runtime_statuses_blocks_missing_runtime_ledger_expectancy(
        self,
    ) -> None:
        registry = load_hypothesis_registry()
        state = _state(
            feature_rows=5,
            drift_checks=3,
            evidence_checks=2,
            signal_lag_seconds=15,
            evidence_report={
                "ok": True,
                "checked_at": "2026-03-06T15:45:00+00:00",
            },
        )
        statuses = compile_hypothesis_runtime_statuses(
            registry=registry,
            state=state,
            tca_summary={
                "order_count": 45,
                "avg_abs_slippage_bps": 4,
                "avg_realized_shortfall_bps": -8,
                "last_computed_at": "2026-03-06T15:50:00+00:00",
            },
            runtime_ledger_summary=_runtime_ledger_summary(
                "H-CONT-01",
                submitted_order_count=45,
                post_cost_expectancy_bps=None,
            ),
            market_context_status={"last_freshness_seconds": 60},
            jangar_dependency_quorum=JangarDependencyQuorumStatus(
                decision="allow",
                reasons=[],
                message="ok",
            ),
            now=datetime(2026, 3, 6, 16, 0, tzinfo=timezone.utc),
        )

        cont = next(item for item in statuses if item["hypothesis_id"] == "H-CONT-01")
        self.assertFalse(cont["promotion_eligible"])
        self.assertTrue(cont["rollback_required"])
        self.assertIn("runtime_ledger_expectancy_missing", cont["reasons"])
        self.assertIsNone(cont["observed"]["runtime_ledger_post_cost_expectancy_bps"])

    def test_compile_hypothesis_runtime_statuses_blocks_h_micro_without_delay_depth_stress(
        self,
    ) -> None:
        registry = load_hypothesis_registry()
        state = _state(
            feature_rows=5,
            drift_checks=3,
            evidence_checks=2,
            signal_lag_seconds=15,
            evidence_report={
                "ok": True,
                "checked_at": "2026-03-06T15:45:00+00:00",
            },
        )

        statuses = compile_hypothesis_runtime_statuses(
            registry=registry,
            state=state,
            tca_summary={
                "order_count": 80,
                "avg_abs_slippage_bps": 4,
                "avg_realized_shortfall_bps": -12,
                "last_computed_at": "2026-03-06T15:50:00+00:00",
            },
            runtime_ledger_summary=_runtime_ledger_summary(
                "H-MICRO-01",
                submitted_order_count=80,
                post_cost_expectancy_bps="12",
            ),
            market_context_status={"last_freshness_seconds": 60},
            jangar_dependency_quorum=JangarDependencyQuorumStatus(
                decision="allow",
                reasons=[],
                message="ok",
            ),
            feature_readiness={"order_book_liquidity_rows": 5},
            now=datetime(2026, 3, 6, 16, 0, tzinfo=timezone.utc),
        )

        micro = next(item for item in statuses if item["hypothesis_id"] == "H-MICRO-01")
        self.assertFalse(micro["promotion_eligible"])
        self.assertEqual(micro["state"], "blocked")
        self.assertIn("delay_adjusted_depth_stress_missing", micro["reasons"])
        self.assertEqual(
            micro["observed"]["delay_adjusted_depth_stress_checks_total"],
            0,
        )
        self.assertEqual(
            micro["entry_contract"]["max_delay_adjusted_depth_stress_age_minutes"],
            30,
        )

    def test_compile_hypothesis_runtime_statuses_promotes_h_micro_with_delay_depth_stress(
        self,
    ) -> None:
        registry = load_hypothesis_registry()
        state = _state(
            feature_rows=5,
            drift_checks=3,
            evidence_checks=2,
            signal_lag_seconds=15,
            evidence_report={
                "ok": True,
                "checked_at": "2026-03-06T15:45:00+00:00",
            },
        )

        statuses = compile_hypothesis_runtime_statuses(
            registry=registry,
            state=state,
            tca_summary={
                "order_count": 80,
                "avg_abs_slippage_bps": 4,
                "avg_realized_shortfall_bps": -12,
                "last_computed_at": "2026-03-06T15:50:00+00:00",
            },
            runtime_ledger_summary=_runtime_ledger_summary(
                "H-MICRO-01",
                submitted_order_count=80,
                post_cost_expectancy_bps="12",
            ),
            market_context_status={"last_freshness_seconds": 60},
            jangar_dependency_quorum=JangarDependencyQuorumStatus(
                decision="allow",
                reasons=[],
                message="ok",
            ),
            feature_readiness={
                "order_book_liquidity_rows": 5,
                "delay_adjusted_depth_stress_checks_total": 1,
                "delay_adjusted_depth_stress_passed": True,
                "delay_adjusted_depth_stress_checked_at": "2026-03-06T15:55:00+00:00",
                "delay_adjusted_depth_stress_artifact_ref": "proof/h-micro-delay-depth.json",
            },
            now=datetime(2026, 3, 6, 16, 0, tzinfo=timezone.utc),
        )

        micro = next(item for item in statuses if item["hypothesis_id"] == "H-MICRO-01")
        self.assertTrue(micro["promotion_eligible"])
        self.assertEqual(micro["state"], "canary_live")
        self.assertEqual(micro["capital_stage"], "0.25x canary")
        self.assertEqual(micro["capital_multiplier"], "0.25")
        self.assertNotIn("delay_adjusted_depth_stress_missing", micro["reasons"])
        self.assertEqual(
            micro["observed"]["delay_adjusted_depth_stress_age_minutes"],
            5,
        )
        self.assertEqual(
            micro["observed"]["delay_adjusted_depth_stress_report_id"],
            "proof/h-micro-delay-depth.json",
        )

    def test_compile_hypothesis_runtime_statuses_blocks_h_micro_on_failed_or_stale_delay_depth_stress(
        self,
    ) -> None:
        registry = load_hypothesis_registry()
        state = _state(
            feature_rows=5,
            drift_checks=3,
            evidence_checks=2,
            signal_lag_seconds=15,
            evidence_report={
                "ok": True,
                "checked_at": "2026-03-06T15:45:00+00:00",
            },
        )

        statuses = compile_hypothesis_runtime_statuses(
            registry=registry,
            state=state,
            tca_summary={
                "order_count": 80,
                "avg_abs_slippage_bps": 4,
                "avg_realized_shortfall_bps": -12,
                "last_computed_at": "2026-03-06T15:50:00+00:00",
            },
            market_context_status={"last_freshness_seconds": 60},
            jangar_dependency_quorum=JangarDependencyQuorumStatus(
                decision="allow",
                reasons=[],
                message="ok",
            ),
            feature_readiness={
                "order_book_liquidity_rows": 5,
                "delay_adjusted_depth_stress_report": {
                    "case_count": 1,
                    "passed": "failed",
                    "generated_at": "2026-03-06T15:00:00+00:00",
                    "report_id": "proof/h-micro-delay-depth-failed.json",
                },
            },
            now=datetime(2026, 3, 6, 16, 0, tzinfo=timezone.utc),
        )

        micro = next(item for item in statuses if item["hypothesis_id"] == "H-MICRO-01")
        self.assertFalse(micro["promotion_eligible"])
        self.assertEqual(micro["state"], "blocked")
        self.assertIn("delay_adjusted_depth_stress_failed", micro["reasons"])
        self.assertIn("delay_adjusted_depth_stress_stale", micro["reasons"])
        self.assertEqual(micro["observed"]["delay_adjusted_depth_stress_passed"], False)
        self.assertEqual(
            micro["observed"]["delay_adjusted_depth_stress_report_id"],
            "proof/h-micro-delay-depth-failed.json",
        )

    def test_compile_hypothesis_runtime_statuses_blocks_h_micro_on_untimed_delay_depth_stress(
        self,
    ) -> None:
        registry = load_hypothesis_registry()
        state = _state(
            feature_rows=5,
            drift_checks=3,
            evidence_checks=2,
            signal_lag_seconds=15,
            evidence_report={
                "ok": True,
                "checked_at": "2026-03-06T15:45:00+00:00",
            },
        )

        statuses = compile_hypothesis_runtime_statuses(
            registry=registry,
            state=state,
            tca_summary={
                "order_count": 80,
                "avg_abs_slippage_bps": 4,
                "avg_realized_shortfall_bps": -12,
                "last_computed_at": "2026-03-06T15:50:00+00:00",
            },
            market_context_status={"last_freshness_seconds": 60},
            jangar_dependency_quorum=JangarDependencyQuorumStatus(
                decision="allow",
                reasons=[],
                message="ok",
            ),
            feature_readiness={
                "order_book_liquidity_rows": 5,
                "delay_adjusted_depth_stress_report": {
                    "case_count": 1,
                    "passed": True,
                    "report_id": "proof/h-micro-delay-depth-untimed.json",
                },
            },
            now=datetime(2026, 3, 6, 16, 0, tzinfo=timezone.utc),
        )

        micro = next(item for item in statuses if item["hypothesis_id"] == "H-MICRO-01")
        self.assertFalse(micro["promotion_eligible"])
        self.assertEqual(micro["state"], "blocked")
        self.assertIn("delay_adjusted_depth_stress_missing", micro["reasons"])
        self.assertEqual(micro["observed"]["delay_adjusted_depth_stress_passed"], True)
        self.assertEqual(
            micro["observed"]["delay_adjusted_depth_stress_age_minutes"], None
        )

    def test_compile_hypothesis_runtime_statuses_uses_route_filtered_tca_when_enabled(
        self,
    ) -> None:
        registry = load_hypothesis_registry()
        state = _state(
            feature_rows=5,
            drift_checks=3,
            evidence_checks=2,
            signal_lag_seconds=15,
            evidence_report={
                "ok": True,
                "checked_at": "2026-03-06T15:45:00+00:00",
            },
        )
        statuses = compile_hypothesis_runtime_statuses(
            registry=registry,
            state=state,
            tca_summary={
                "order_count": 145,
                "avg_abs_slippage_bps": 25,
                "avg_realized_shortfall_bps": 4,
                "last_computed_at": "2026-03-06T15:50:00+00:00",
                "symbol_breakdown": [
                    {
                        "symbol": "AAPL",
                        "order_count": 90,
                        "avg_abs_slippage_bps": 6,
                        "avg_realized_shortfall_bps": -8,
                        "last_computed_at": "2026-03-06T15:50:00+00:00",
                    },
                    {
                        "symbol": "NVDA",
                        "order_count": 55,
                        "avg_abs_slippage_bps": 25,
                        "avg_realized_shortfall_bps": 5,
                        "last_computed_at": "2026-03-06T15:50:00+00:00",
                    },
                ],
            },
            runtime_ledger_summary=_runtime_ledger_summary(
                "H-CONT-01",
                submitted_order_count=90,
                post_cost_expectancy_bps="8",
            ),
            market_context_status={"last_freshness_seconds": 60},
            jangar_dependency_quorum=JangarDependencyQuorumStatus(
                decision="allow",
                reasons=[],
                message="ok",
            ),
            now=datetime(2026, 3, 6, 16, 0, tzinfo=timezone.utc),
            market_session_open=True,
            route_symbol_filter_enabled=True,
        )

        cont = next(item for item in statuses if item["hypothesis_id"] == "H-CONT-01")
        self.assertEqual(cont["state"], "scaled_live")
        self.assertEqual(cont["capital_stage"], "1.00x live")
        self.assertEqual(cont["capital_multiplier"], "1")
        self.assertTrue(cont["promotion_eligible"])
        self.assertNotIn("slippage_budget_exceeded", cont["reasons"])
        observed = cont["observed"]
        self.assertEqual(observed["tca_order_count"], 90)
        self.assertEqual(observed["avg_abs_slippage_bps"], "6")
        self.assertEqual(observed["runtime_ledger_post_cost_expectancy_bps"], "8")
        self.assertEqual(observed["runtime_ledger_submitted_order_count"], 90)
        self.assertEqual(observed["route_tca_symbols"], ["AAPL"])
        self.assertEqual(observed["route_tca_excluded_symbol_count"], 1)

    def test_compile_hypothesis_runtime_statuses_blocks_empty_route_universe(
        self,
    ) -> None:
        registry = load_hypothesis_registry()
        state = _state(
            feature_rows=5,
            drift_checks=3,
            evidence_checks=2,
            signal_lag_seconds=15,
            evidence_report={
                "ok": True,
                "checked_at": "2026-03-06T15:45:00+00:00",
            },
        )
        statuses = compile_hypothesis_runtime_statuses(
            registry=registry,
            state=state,
            tca_summary={
                "order_count": 100,
                "avg_abs_slippage_bps": 25,
                "avg_realized_shortfall_bps": -8,
                "last_computed_at": "2026-03-06T15:50:00+00:00",
                "symbol_breakdown": [
                    {
                        "symbol": "AAPL",
                        "order_count": 0,
                        "avg_abs_slippage_bps": None,
                        "avg_realized_shortfall_bps": None,
                        "last_computed_at": None,
                    },
                    {
                        "symbol": "ORCL",
                        "order_count": 0,
                        "avg_abs_slippage_bps": None,
                        "avg_realized_shortfall_bps": None,
                        "last_computed_at": None,
                    },
                ],
            },
            market_context_status={"last_freshness_seconds": 60},
            jangar_dependency_quorum=JangarDependencyQuorumStatus(
                decision="allow",
                reasons=[],
                message="ok",
            ),
            now=datetime(2026, 3, 6, 16, 0, tzinfo=timezone.utc),
            market_session_open=True,
            route_symbol_filter_enabled=True,
        )

        cont = next(item for item in statuses if item["hypothesis_id"] == "H-CONT-01")
        self.assertEqual(cont["state"], "shadow")
        self.assertFalse(cont["promotion_eligible"])
        self.assertTrue(cont["rollback_required"])
        self.assertIn("route_universe_empty", cont["reasons"])
        observed = cont["observed"]
        self.assertEqual(observed["route_tca_symbols"], [])
        self.assertEqual(observed["route_tca_symbol_count"], 0)
        self.assertEqual(observed["route_tca_missing_symbol_count"], 2)

    def test_compile_hypothesis_runtime_statuses_keeps_route_negative_expectancy_blocked(
        self,
    ) -> None:
        registry = load_hypothesis_registry()
        state = _state(
            feature_rows=5,
            drift_checks=3,
            evidence_checks=2,
            signal_lag_seconds=15,
            evidence_report={
                "ok": True,
                "checked_at": "2026-03-06T15:45:00+00:00",
            },
        )
        statuses = compile_hypothesis_runtime_statuses(
            registry=registry,
            state=state,
            tca_summary={
                "order_count": 100,
                "avg_abs_slippage_bps": 25,
                "avg_realized_shortfall_bps": 4,
                "last_computed_at": "2026-03-06T15:50:00+00:00",
                "symbol_breakdown": [
                    {
                        "symbol": "AAPL",
                        "order_count": 45,
                        "avg_abs_slippage_bps": 6,
                        "avg_realized_shortfall_bps": 1,
                        "last_computed_at": "2026-03-06T15:50:00+00:00",
                    },
                    {
                        "symbol": "NVDA",
                        "order_count": 55,
                        "avg_abs_slippage_bps": 25,
                        "avg_realized_shortfall_bps": 5,
                        "last_computed_at": "2026-03-06T15:50:00+00:00",
                    },
                ],
            },
            runtime_ledger_summary=_runtime_ledger_summary(
                "H-CONT-01",
                submitted_order_count=45,
                net_strategy_pnl_after_costs="-10",
                post_cost_expectancy_bps="-1",
            ),
            market_context_status={"last_freshness_seconds": 60},
            jangar_dependency_quorum=JangarDependencyQuorumStatus(
                decision="allow",
                reasons=[],
                message="ok",
            ),
            now=datetime(2026, 3, 6, 16, 0, tzinfo=timezone.utc),
            market_session_open=True,
            route_symbol_filter_enabled=True,
        )

        cont = next(item for item in statuses if item["hypothesis_id"] == "H-CONT-01")
        self.assertEqual(cont["state"], "shadow")
        self.assertFalse(cont["promotion_eligible"])
        self.assertTrue(cont["rollback_required"])
        self.assertNotIn("slippage_budget_exceeded", cont["reasons"])
        self.assertIn("post_cost_expectancy_non_positive", cont["reasons"])
        observed = cont["observed"]
        self.assertEqual(observed["avg_abs_slippage_bps"], "6")
        self.assertEqual(observed["runtime_ledger_post_cost_expectancy_bps"], "-1")
        self.assertEqual(observed["route_tca_symbols"], ["AAPL"])

    def test_compile_hypothesis_runtime_statuses_keeps_non_authority_route_tca_out_of_final_authority(
        self,
    ) -> None:
        registry = load_hypothesis_registry()
        state = _state(
            feature_rows=2770,
            drift_checks=3,
            evidence_checks=2,
            signal_lag_seconds=14,
            evidence_report={
                "ok": True,
                "checked_at": "2026-06-01T19:15:00+00:00",
            },
        )
        statuses = compile_hypothesis_runtime_statuses(
            registry=registry,
            state=state,
            tca_summary={
                "account_label": "TORGHUT_SIM",
                "order_count": 2,
                "avg_abs_slippage_bps": "4",
                "avg_realized_shortfall_bps": "1",
                "last_computed_at": "2026-06-01T19:16:00+00:00",
                "scope_symbols": ["AAPL", "AMZN"],
                "symbol_breakdown": [
                    {
                        "symbol": "AAPL",
                        "order_count": 1,
                        "avg_abs_slippage_bps": "4",
                        "avg_realized_shortfall_bps": "1",
                        "last_computed_at": "2026-06-01T19:16:00+00:00",
                        "hypothesis_id": "H-PAIRS-01",
                        "candidate_id": _MANIFEST_CANDIDATE_IDS["H-PAIRS-01"],
                        "strategy_family": _MANIFEST_STRATEGY_FAMILIES["H-PAIRS-01"],
                        "account_label": "TORGHUT_SIM",
                        "ledger_schema_version": EXACT_REPLAY_LEDGER_SCHEMA_VERSION,
                    },
                    {
                        "symbol": "AMZN",
                        "order_count": 1,
                        "avg_abs_slippage_bps": "4",
                        "avg_realized_shortfall_bps": "1",
                        "last_computed_at": "2026-06-01T19:16:00+00:00",
                        "hypothesis_id": "H-PAIRS-01",
                        "candidate_id": _MANIFEST_CANDIDATE_IDS["H-PAIRS-01"],
                        "strategy_family": _MANIFEST_STRATEGY_FAMILIES["H-PAIRS-01"],
                        "account_label": "TORGHUT_SIM",
                        "source_decision_mode": "bounded_paper_route_collection_only",
                        "source_decision_mode_profit_proof_eligible": False,
                    },
                ],
            },
            runtime_ledger_summary=_runtime_ledger_summary(
                "H-PAIRS-01",
                bucket_started_at="2026-06-01T19:00:00+00:00",
                bucket_ended_at="2026-06-01T19:15:00+00:00",
                submitted_order_count=120,
                post_cost_expectancy_bps="12",
            ),
            market_context_status={"last_freshness_seconds": 60},
            jangar_dependency_quorum=JangarDependencyQuorumStatus(
                decision="allow",
                reasons=[],
                message="ok",
            ),
            now=datetime(2026, 6, 1, 19, 17, tzinfo=timezone.utc),
            market_session_open=True,
            route_symbol_filter_enabled=True,
        )

        hpairs = next(
            item for item in statuses if item["hypothesis_id"] == "H-PAIRS-01"
        )
        observed = hpairs["observed"]
        self.assertFalse(hpairs["promotion_eligible"])
        self.assertIn("route_universe_empty", hpairs["reasons"])
        self.assertEqual(observed["tca_order_count"], 0)
        self.assertEqual(observed["route_tca_symbols"], [])
        self.assertEqual(observed["route_tca_repair_symbols"], ["AAPL", "AMZN"])
        self.assertTrue(observed["bounded_route_evidence_collection_eligible"])
        self.assertEqual(
            observed["bounded_route_evidence_collection_authority"],
            "repair_only_non_authority",
        )
        self.assertIn(
            "route_tca_non_authority_source",
            observed["route_tca_blocking_reason_codes"],
        )
        self.assertIn(
            "route_tca_non_authority_source_decision_mode",
            observed["route_tca_blocking_reason_codes"],
        )
        self.assertTrue(observed["bounded_route_evidence_collection_ready"])
        self.assertEqual(
            observed["bounded_route_evidence_collection_next_action"],
            "collect_bounded_paper_route_source_rows",
        )
        self.assertEqual(observed["bounded_route_evidence_collection_blockers"], [])

    def test_compile_hypothesis_runtime_statuses_blocks_bounded_hpairs_collection_when_drift_missing(
        self,
    ) -> None:
        registry = load_hypothesis_registry()
        statuses = compile_hypothesis_runtime_statuses(
            registry=registry,
            state=_state(
                feature_rows=2770,
                drift_checks=0,
                evidence_checks=2,
                signal_lag_seconds=14,
                evidence_report={
                    "ok": True,
                    "checked_at": "2026-06-01T19:15:00+00:00",
                },
            ),
            tca_summary=_hpairs_route_repair_tca_summary(),
            runtime_ledger_summary=_runtime_ledger_summary(
                "H-PAIRS-01",
                bucket_started_at="2026-06-01T19:00:00+00:00",
                bucket_ended_at="2026-06-01T19:15:00+00:00",
                submitted_order_count=120,
                post_cost_expectancy_bps="12",
            ),
            market_context_status={"last_freshness_seconds": 60},
            jangar_dependency_quorum=JangarDependencyQuorumStatus(
                decision="allow",
                reasons=[],
                message="ok",
            ),
            now=datetime(2026, 6, 1, 19, 17, tzinfo=timezone.utc),
            market_session_open=True,
            route_symbol_filter_enabled=True,
        )

        hpairs = next(
            item for item in statuses if item["hypothesis_id"] == "H-PAIRS-01"
        )
        observed = hpairs["observed"]
        self.assertIn("drift_checks_missing", hpairs["reasons"])
        self.assertFalse(hpairs["promotion_eligible"])
        self.assertTrue(observed["bounded_route_evidence_collection_eligible"])
        self.assertFalse(observed["bounded_route_evidence_collection_ready"])
        self.assertEqual(
            observed["bounded_route_evidence_collection_next_action"],
            "materialize_drift_checks",
        )
        self.assertEqual(
            observed["bounded_route_evidence_collection_blockers"],
            ["drift_checks_missing"],
        )
