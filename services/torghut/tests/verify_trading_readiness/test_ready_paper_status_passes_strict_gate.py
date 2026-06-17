from __future__ import annotations

# ruff: noqa: F401,F403,F405
from tests.verify_trading_readiness.support import (
    Decimal,
    _TestVerifyTradingReadinessBase,
    _completion_status,
    _ready_status,
    _runtime_ledger_proof_packet,
    _tigerbeetle_parity,
    evaluate_trading_readiness,
    verifier,
)


class TestReadyPaperStatusPassesStrictGate(_TestVerifyTradingReadinessBase):
    def test_ready_paper_status_passes_strict_gate(self) -> None:
        result = evaluate_trading_readiness(
            _ready_status(),
            profile="paper",
            min_routeable_symbols=2,
            min_decisions=1,
            min_orders=1,
        )

        self.assertTrue(result["ok"])
        self.assertEqual(result["failed_checks"], [])

    def test_runtime_ledger_profit_proof_can_be_required_from_completion_status(
        self,
    ) -> None:
        result = evaluate_trading_readiness(
            _ready_status(),
            completion_status=_completion_status(),
            profile="paper",
            min_routeable_symbols=2,
            min_runtime_ledger_net_pnl=Decimal("500"),
            min_runtime_ledger_trading_days=25,
            min_runtime_ledger_daily_net_pnl=Decimal("20"),
            require_runtime_ledger_profit_proof=True,
        )

        self.assertTrue(result["ok"], result)
        self.assertEqual(result["failed_checks"], [])
        self.assertEqual(
            result["completion_profit_proof"]["gate_id"],
            verifier.DOC29_LIVE_SCALE_GATE,
        )

    def test_runtime_ledger_profit_proof_fails_closed_on_missing_or_weak_completion(
        self,
    ) -> None:
        missing = evaluate_trading_readiness(
            _ready_status(),
            min_runtime_ledger_net_pnl=Decimal("500"),
            require_runtime_ledger_profit_proof=True,
        )
        self.assertFalse(missing["ok"])
        self.assertIn("completion_status_present", missing["failed_checks"])

        weak = evaluate_trading_readiness(
            _ready_status(),
            completion_status=_completion_status(
                gate_status="blocked",
                blocked_reason="runtime_ledger_profit_proof_missing",
                net_pnl="499.99",
                expectancy_bps="0",
                trading_day_count=2,
                ledger_refs=[],
                unbacked_refs=["window-1"],
            ),
            min_runtime_ledger_net_pnl=Decimal("500"),
            min_runtime_ledger_trading_days=25,
            min_runtime_ledger_daily_net_pnl=Decimal("500"),
            require_runtime_ledger_profit_proof=True,
        )

        self.assertFalse(weak["ok"])
        for check_name in (
            "doc29_live_scale_gate_satisfied",
            "runtime_ledger_db_refs_present",
            "runtime_ledger_unbacked_windows_empty",
            "runtime_ledger_observed_trading_days",
            "runtime_ledger_net_pnl_target",
            "runtime_ledger_daily_net_pnl_target",
            "runtime_ledger_post_cost_expectancy_positive",
        ):
            self.assertIn(check_name, weak["failed_checks"])

    def test_runtime_ledger_profit_proof_requires_tca_cost_lineage_readback(
        self,
    ) -> None:
        status = _ready_status()
        proof_floor = status["proof_floor"]
        assert isinstance(proof_floor, dict)
        dimensions = proof_floor["proof_dimensions"]
        assert isinstance(dimensions, list)
        for dimension in dimensions:
            if (
                isinstance(dimension, dict)
                and dimension.get("dimension") == "execution_tca"
            ):
                source_ref = dimension["source_ref"]
                assert isinstance(source_ref, dict)
                source_ref["runtime_ledger_lineage"] = {
                    "schema_version": "torghut.execution-tca-cost-lineage.v1",
                    "status": "blocked",
                    "promotion_authority": False,
                    "execution_count": 1,
                    "source_backed_count": 0,
                    "blocked_count": 1,
                    "filled_notional_count": 1,
                    "explicit_cost_count": 0,
                    "execution_policy_hash_count": 1,
                    "cost_model_hash_count": 1,
                    "post_cost_pnl_basis_count": 1,
                    "blockers": ["explicit_cost_missing"],
                    "blocker_counts": {"explicit_cost_missing": 1},
                    "sample_blockers": [
                        {
                            "execution_id": "exec-1",
                            "blockers": ["explicit_cost_missing"],
                        }
                    ],
                }

        result = evaluate_trading_readiness(
            status,
            completion_status=_completion_status(),
            require_runtime_ledger_profit_proof=True,
        )

        self.assertFalse(result["ok"])
        self.assertIn(
            "execution_tca_cost_lineage_source_backed",
            result["failed_checks"],
        )
        self.assertEqual(
            result["execution_tca_lineage"]["blockers"],
            ["explicit_cost_missing"],
        )

    def test_tca_cost_lineage_readback_does_not_replace_runtime_authority(
        self,
    ) -> None:
        result = evaluate_trading_readiness(
            _ready_status(),
            min_runtime_ledger_net_pnl=Decimal("500"),
            require_runtime_ledger_profit_proof=True,
        )

        self.assertFalse(result["ok"])
        self.assertIn("completion_status_present", result["failed_checks"])
        self.assertNotIn(
            "execution_tca_cost_lineage_source_backed",
            result["failed_checks"],
        )

    def test_runtime_ledger_proof_packet_can_be_required_as_final_authority(
        self,
    ) -> None:
        result = evaluate_trading_readiness(
            _ready_status(),
            runtime_ledger_proof_packet=_runtime_ledger_proof_packet(),
            require_runtime_ledger_proof_packet=True,
        )

        self.assertTrue(result["ok"], result)
        self.assertEqual(result["failed_checks"], [])
        self.assertEqual(
            result["runtime_ledger_proof_packet"]["schema_version"],
            verifier.RUNTIME_LEDGER_PROOF_PACKET_SCHEMA_VERSION,
        )
        self.assertEqual(
            result["runtime_ledger_proof_packet"]["proof_mode"], "authority"
        )
        self.assertTrue(result["runtime_ledger_proof_packet"]["final_authority_ok"])
        self.assertFalse(
            result["runtime_ledger_proof_packet"]["evidence_collection_ok"]
        )
        packet_summary = result["runtime_ledger_proof_packet"]
        self.assertTrue(packet_summary["promotion_allowed"])
        self.assertTrue(packet_summary["final_promotion_allowed"])
        self.assertEqual(packet_summary["min_runtime_ledger_trading_days"], 20)
        self.assertEqual(
            packet_summary["min_runtime_ledger_daily_net_pnl_after_costs"], "500"
        )
        self.assertEqual(
            packet_summary["min_runtime_ledger_net_pnl_after_costs"], "10000"
        )
        self.assertTrue(packet_summary["source_backed_runtime_ledger_proof_required"])
        self.assertTrue(packet_summary["non_empty_runtime_ledger_source_refs_required"])
        self.assertEqual(packet_summary["blockers"], [])
        self.assertEqual(packet_summary["authority_blockers"], [])

    def test_tigerbeetle_parity_can_be_required_as_accounting_only_gate(
        self,
    ) -> None:
        result = evaluate_trading_readiness(
            _ready_status(),
            tigerbeetle_parity=_tigerbeetle_parity(),
            require_tigerbeetle_parity=True,
        )

        self.assertTrue(result["ok"], result)
        self.assertEqual(result["failed_checks"], [])
        self.assertEqual(result["tigerbeetle_parity"]["parity_status"], "pass")

    def test_tigerbeetle_parity_requirement_fails_closed_on_degraded_or_authority_claim(
        self,
    ) -> None:
        degraded = evaluate_trading_readiness(
            _ready_status(),
            tigerbeetle_parity=_tigerbeetle_parity(
                ok=False,
                parity_status="blocked",
                blockers=["tigerbeetle_parity_entry_missing"],
            ),
            require_tigerbeetle_parity=True,
        )

        self.assertFalse(degraded["ok"])
        self.assertIn(
            "tigerbeetle_runtime_ledger_parity",
            degraded["failed_checks"],
        )
        self.assertEqual(
            degraded["next_action"],
            "repair_tigerbeetle_journal_parity_without_using_as_profit_authority",
        )

        synthetic = evaluate_trading_readiness(
            _ready_status(),
            tigerbeetle_parity=_tigerbeetle_parity(
                overrides_runtime_ledger_authority=True
            ),
            require_tigerbeetle_parity=True,
        )
        self.assertFalse(synthetic["ok"])
        self.assertIn("tigerbeetle_runtime_ledger_parity", synthetic["failed_checks"])

    def test_tigerbeetle_parity_does_not_replace_runtime_ledger_authority(
        self,
    ) -> None:
        result = evaluate_trading_readiness(
            _ready_status(),
            tigerbeetle_parity=_tigerbeetle_parity(),
            min_runtime_ledger_net_pnl=Decimal("500"),
            require_runtime_ledger_profit_proof=True,
            require_tigerbeetle_parity=True,
        )

        self.assertFalse(result["ok"])
        self.assertIn("completion_status_present", result["failed_checks"])
        self.assertNotIn("tigerbeetle_runtime_ledger_parity", result["failed_checks"])

    def test_runtime_ledger_proof_packet_fails_closed_when_blocked(self) -> None:
        result = evaluate_trading_readiness(
            _ready_status(),
            runtime_ledger_proof_packet=_runtime_ledger_proof_packet(
                allowed=False,
                blockers=["runtime_ledger_daily_net_pnl_below_target"],
            ),
            require_runtime_ledger_proof_packet=True,
        )

        self.assertFalse(result["ok"])
        self.assertIn(
            "runtime_ledger_proof_packet_authority",
            result["failed_checks"],
        )
        self.assertEqual(
            result["checks"]["runtime_ledger_proof_packet_authority"]["observed"][
                "blocking_reasons"
            ],
            ["runtime_ledger_daily_net_pnl_below_target"],
        )

    def test_runtime_ledger_proof_packet_rejects_smoke_mode_as_final_authority(
        self,
    ) -> None:
        packet = _runtime_ledger_proof_packet()
        packet["proof_mode"] = "smoke"
        packet["proof_mode_contract"] = {
            "proof_mode": "smoke",
            "default_proof_mode": "smoke",
            "authority_scope": "plumbing_only",
            "mode_can_grant_final_authority": False,
            "mode_can_grant_promotion_authority": False,
            "requires_explicit_authority_mode_for_final_promotion": True,
            "implicit_default_final_authority": False,
        }
        packet["final_authority_ok"] = False
        packet["evidence_collection_only"] = True
        packet["capital_promotion_allowed"] = False
        packet["promotion_allowed"] = False
        packet["final_promotion_allowed"] = False
        packet["evidence_collection_ok"] = True
        packet["next_action"] = "rerun_proof_packet_in_authority_mode"
        packet["promotion_authority"] = {
            "allowed": False,
            "reason": "runtime_ledger_proof_mode_not_authority",
            "blocking_reasons": ["runtime_ledger_proof_mode_not_authority"],
            "failed_checks": ["runtime_ledger_proof_mode_authority_required"],
        }

        result = evaluate_trading_readiness(
            _ready_status(),
            runtime_ledger_proof_packet=packet,
            require_runtime_ledger_proof_packet=True,
        )

        self.assertFalse(result["ok"])
        observed = result["checks"]["runtime_ledger_proof_packet_authority"]["observed"]
        self.assertEqual(observed["proof_mode"], "smoke")
        self.assertFalse(observed["authority_allowed"])
        self.assertFalse(observed["mode_contract_allows_authority"])
        packet_summary = result["runtime_ledger_proof_packet"]
        self.assertEqual(packet_summary["proof_mode"], "smoke")
        self.assertEqual(
            packet_summary["proof_mode_contract"]["authority_scope"],
            "plumbing_only",
        )
        self.assertFalse(packet_summary["final_authority_ok"])
        self.assertTrue(packet_summary["evidence_collection_ok"])
        self.assertFalse(packet_summary["promotion_allowed"])
        self.assertFalse(packet_summary["final_promotion_allowed"])
        self.assertEqual(result["next_action"], "rerun_proof_packet_in_authority_mode")

    def test_runtime_ledger_proof_packet_readback_separates_probation_collection(
        self,
    ) -> None:
        proof_packet = _runtime_ledger_proof_packet()
        proof_packet["proof_mode"] = "probation"
        proof_packet["proof_mode_contract"] = {
            "proof_mode": "probation",
            "default_proof_mode": "smoke",
            "authority_scope": "bounded_evidence_collection_only",
            "mode_can_grant_final_authority": False,
            "mode_can_grant_promotion_authority": False,
            "requires_explicit_authority_mode_for_final_promotion": True,
            "implicit_default_final_authority": False,
        }
        proof_packet["final_authority_ok"] = False
        proof_packet["evidence_collection_only"] = True
        proof_packet["evidence_collection_ok"] = True
        proof_packet["canary_collection_authorized"] = True
        proof_packet["promotion_allowed"] = False
        proof_packet["capital_promotion_allowed"] = False
        proof_packet["final_promotion_allowed"] = False
        proof_packet["next_action"] = "rerun_proof_packet_in_authority_mode"
        proof_packet["promotion_authority"] = {
            "allowed": False,
            "reason": "runtime_ledger_proof_mode_not_authority",
            "blocking_reasons": ["runtime_ledger_proof_mode_not_authority"],
            "failed_checks": ["runtime_ledger_proof_mode_authority_required"],
        }

        result = evaluate_trading_readiness(
            _ready_status(),
            runtime_ledger_proof_packet=proof_packet,
            require_runtime_ledger_proof_packet=True,
        )

        self.assertFalse(result["ok"])
        packet_summary = result["runtime_ledger_proof_packet"]
        self.assertEqual(packet_summary["proof_mode"], "probation")
        self.assertEqual(
            packet_summary["proof_mode_contract"]["authority_scope"],
            "bounded_evidence_collection_only",
        )
        self.assertFalse(packet_summary["final_authority_ok"])
        self.assertTrue(packet_summary["evidence_collection_only"])
        self.assertTrue(packet_summary["evidence_collection_ok"])
        self.assertTrue(packet_summary["canary_collection_authorized"])
        self.assertFalse(packet_summary["promotion_allowed"])
        self.assertFalse(packet_summary["capital_promotion_allowed"])
        self.assertFalse(packet_summary["final_promotion_allowed"])

    def test_runtime_ledger_proof_packet_requires_explicit_authority_mode_contract(
        self,
    ) -> None:
        packet = _runtime_ledger_proof_packet(allowed=True)
        packet.pop("proof_mode_contract")

        result = evaluate_trading_readiness(
            _ready_status(),
            runtime_ledger_proof_packet=packet,
            require_runtime_ledger_proof_packet=True,
        )

        self.assertFalse(result["ok"])
        observed = result["checks"]["runtime_ledger_proof_packet_authority"]["observed"]
        self.assertEqual(observed["proof_mode"], "authority")
        self.assertEqual(observed["proof_mode_contract"], {})
        self.assertFalse(observed["mode_contract_allows_authority"])
        self.assertIn(
            "runtime_ledger_proof_packet_authority",
            result["failed_checks"],
        )

    def test_runtime_ledger_proof_packet_requires_authority_target_contract(
        self,
    ) -> None:
        packet = _runtime_ledger_proof_packet(allowed=True)
        target = packet["target"]
        assert isinstance(target, dict)
        target["min_runtime_ledger_trading_days"] = 1
        target["source_backed_runtime_ledger_proof_required"] = False

        result = evaluate_trading_readiness(
            _ready_status(),
            runtime_ledger_proof_packet=packet,
            require_runtime_ledger_proof_packet=True,
        )

        self.assertFalse(result["ok"])
        observed = result["checks"]["runtime_ledger_proof_packet_authority"]["observed"]
        self.assertFalse(observed["authority_target_contract_ok"])
        self.assertEqual(observed["min_runtime_ledger_trading_days"], 1)
        self.assertFalse(observed["source_backed_runtime_ledger_proof_required"])
        self.assertIn(
            "runtime_ledger_proof_packet_authority",
            result["failed_checks"],
        )

    def test_runtime_ledger_proof_packet_rejects_mislabeled_smoke_authority(
        self,
    ) -> None:
        packet = _runtime_ledger_proof_packet(allowed=True)
        packet["proof_mode"] = "smoke"

        result = evaluate_trading_readiness(
            _ready_status(),
            runtime_ledger_proof_packet=packet,
            require_runtime_ledger_proof_packet=True,
        )

        self.assertFalse(result["ok"])
        observed = result["checks"]["runtime_ledger_proof_packet_authority"]["observed"]
        self.assertEqual(observed["proof_mode"], "smoke")
        self.assertTrue(observed["promotion_allowed"])
        self.assertTrue(observed["final_promotion_allowed"])
        self.assertIn(
            "runtime_ledger_proof_packet_authority",
            result["failed_checks"],
        )

    def test_runtime_ledger_blockers_map_to_concrete_next_actions(self) -> None:
        cases = [
            (
                "runtime_window_import_missing",
                "run_runtime_window_import_from_paper_route_target_plan",
            ),
            (
                "runtime_ledger_source_authority_missing",
                "inspect_runtime_ledger_source_activity",
            ),
            (
                "runtime_ledger_trading_days_below_target",
                "collect_more_runtime_ledger_trading_days",
            ),
            (
                "runtime_ledger_closed_round_trips_below_authority_floor",
                "collect_more_closed_runtime_round_trips",
            ),
            (
                "runtime_ledger_filled_notional_below_authority_floor",
                "collect_more_runtime_ledger_filled_notional",
            ),
            (
                "runtime_ledger_explicit_costs_missing",
                "repair_runtime_ledger_lifecycle_cost_or_lineage_evidence",
            ),
        ]
        for blocker, expected_action in cases:
            with self.subTest(blocker=blocker):
                action = verifier._readiness_next_action(
                    failed_checks=["runtime_ledger_proof_packet_authority"],
                    checks={
                        "runtime_ledger_proof_packet_authority": {
                            "observed": {"blocking_reasons": [blocker]}
                        }
                    },
                    runtime_ledger_proof_packet={},
                )

                self.assertEqual(action, expected_action)

    def test_runtime_ledger_profit_proof_requires_observed_days_and_daily_pnl(
        self,
    ) -> None:
        short_window = evaluate_trading_readiness(
            _ready_status(),
            completion_status=_completion_status(
                net_pnl="15000",
                trading_day_count=3,
            ),
            min_runtime_ledger_net_pnl=Decimal("12500"),
            min_runtime_ledger_trading_days=25,
            min_runtime_ledger_daily_net_pnl=Decimal("500"),
            require_runtime_ledger_profit_proof=True,
        )
        self.assertFalse(short_window["ok"])
        self.assertIn(
            "runtime_ledger_observed_trading_days",
            short_window["failed_checks"],
        )

        weak_daily = evaluate_trading_readiness(
            _ready_status(),
            completion_status=_completion_status(
                net_pnl="600",
                trading_day_count=25,
            ),
            min_runtime_ledger_net_pnl=Decimal("500"),
            min_runtime_ledger_trading_days=25,
            min_runtime_ledger_daily_net_pnl=Decimal("500"),
            require_runtime_ledger_profit_proof=True,
        )
        self.assertFalse(weak_daily["ok"])
        self.assertIn(
            "runtime_ledger_daily_net_pnl_target",
            weak_daily["failed_checks"],
        )

    def test_runtime_ledger_profit_proof_prefers_persisted_daily_mean(self) -> None:
        result = evaluate_trading_readiness(
            _ready_status(),
            completion_status=_completion_status(
                net_pnl="15000",
                trading_day_count=25,
                mean_daily_net_pnl="300",
            ),
            min_runtime_ledger_net_pnl=Decimal("12500"),
            min_runtime_ledger_trading_days=25,
            min_runtime_ledger_daily_net_pnl=Decimal("500"),
            require_runtime_ledger_profit_proof=True,
        )

        self.assertFalse(result["ok"])
        self.assertIn("runtime_ledger_daily_net_pnl_target", result["failed_checks"])
        self.assertEqual(
            result["checks"]["runtime_ledger_daily_net_pnl_target"]["detail"][
                "source_key"
            ],
            "runtime_ledger_mean_daily_net_pnl_after_costs",
        )

    def test_runtime_ledger_daily_net_pnl_reports_missing_without_inputs(self) -> None:
        self.assertEqual(
            verifier._runtime_ledger_daily_net_pnl(
                {},
                net_pnl=None,
                trading_day_count=0,
            ),
            (None, "missing"),
        )

    def test_live_and_either_profiles_use_live_floor_states_and_market_window(
        self,
    ) -> None:
        status = _ready_status()
        status["mode"] = "live"
        metrics = status["metrics"]
        assert isinstance(metrics, dict)
        metrics.pop("market_session_open")
        proof_floor = status["proof_floor"]
        assert isinstance(proof_floor, dict)
        proof_floor.update(
            {
                "floor_state": "live_micro_ready",
                "route_state": "live_micro_candidate",
                "capital_state": "live_allowed",
                "market_window": {"session_open": "open"},
            }
        )

        live = evaluate_trading_readiness(
            status, profile="live", min_routeable_symbols=2
        )
        either = evaluate_trading_readiness(
            status, profile="either", min_routeable_symbols=2
        )

        self.assertTrue(live["ok"], live)
        self.assertTrue(either["ok"], either)

    def test_repair_only_route_universe_fails_with_actionable_checks(self) -> None:
        status = _ready_status()
        proof_floor = status["proof_floor"]
        assert isinstance(proof_floor, dict)
        proof_floor.update(
            {
                "floor_state": "repair_only",
                "route_state": "repair_only",
                "capital_state": "zero_notional",
                "max_notional": "0",
                "blocking_reasons": [
                    "alpha_readiness_not_promotion_eligible",
                    "execution_tca_route_universe_empty",
                    "market_context_stale",
                ],
            }
        )
        dimensions = proof_floor["proof_dimensions"]
        assert isinstance(dimensions, list)
        for dimension in dimensions:
            if not isinstance(dimension, dict):
                continue
            if dimension.get("dimension") == "alpha_readiness":
                dimension["state"] = "fail"
                dimension["reason"] = "alpha_readiness_not_promotion_eligible"
            if dimension.get("dimension") == "market_context":
                dimension["state"] = "stale"
                dimension["reason"] = "market_context_stale"
            if dimension.get("dimension") == "execution_tca":
                dimension["state"] = "fail"
                dimension["reason"] = "execution_tca_route_universe_empty"
                source_ref = dimension["source_ref"]
                assert isinstance(source_ref, dict)
                symbol_routes = source_ref["symbol_routes"]
                assert isinstance(symbol_routes, dict)
                symbol_routes.update(
                    {
                        "routeable_symbol_count": 0,
                        "blocked_symbol_count": 1,
                        "missing_symbol_count": 1,
                        "routeable_symbols": [],
                        "blocked_symbols": [{"symbol": "NVDA"}],
                        "missing_symbols": ["AVGO"],
                    }
                )

        status["route_reacquisition_board"] = {
            "schema_version": "torghut.route-reacquisition-board.v1",
            "state": "repair_only",
            "capital_state": "zero_notional",
            "summary": {
                "row_count": 2,
                "state_counts": {"blocked": 1, "missing": 1},
                "zero_notional_row_count": 2,
                "expected_unblock_value": 3,
                "top_repair_symbols": ["NVDA", "AVGO"],
                "capital_eligible_symbol_count": 0,
            },
            "rows": [
                {"symbol": "NVDA", "state": "blocked", "max_notional": "0"},
                {"symbol": "AVGO", "state": "missing", "max_notional": "0"},
            ],
        }

        result = evaluate_trading_readiness(
            status,
            profile="paper",
            min_routeable_symbols=2,
            min_decisions=1,
            min_orders=1,
        )

        self.assertFalse(result["ok"])
        self.assertIn("proof_floor_state", result["failed_checks"])
        self.assertIn("capital_state", result["failed_checks"])
        self.assertIn("alpha_readiness_pass", result["failed_checks"])
        self.assertIn("market_context_pass", result["failed_checks"])
        self.assertIn("execution_tca_pass", result["failed_checks"])
        self.assertIn("routeable_symbol_count", result["failed_checks"])
        self.assertIn("blocked_symbol_count", result["failed_checks"])
        self.assertIn("missing_symbol_count", result["failed_checks"])
        self.assertIn("route_board_jangar_continuity_ready", result["failed_checks"])
        self.assertIn("route_board_capital_eligible_symbols", result["failed_checks"])
        self.assertIn("route_board_zero_notional_rows", result["failed_checks"])

    def test_optional_quant_empty_fails_unless_informational_quant_is_allowed(
        self,
    ) -> None:
        status = _ready_status()
        proof_floor = status["proof_floor"]
        assert isinstance(proof_floor, dict)
        dimensions = proof_floor["proof_dimensions"]
        assert isinstance(dimensions, list)
        for dimension in dimensions:
            if (
                isinstance(dimension, dict)
                and dimension.get("dimension") == "quant_ingestion"
            ):
                dimension["state"] = "informational"
                dimension["reason"] = "quant_latest_metrics_empty"
                dimension["source_ref"] = {"required": False}

        strict = evaluate_trading_readiness(status, require_quant_fresh=True)
        permissive = evaluate_trading_readiness(status, require_quant_fresh=False)

        self.assertFalse(strict["ok"])
        self.assertIn("quant_ingestion_ready", strict["failed_checks"])
        self.assertTrue(permissive["ok"])

    def test_required_quant_empty_fails_even_when_informational_quant_is_allowed(
        self,
    ) -> None:
        status = _ready_status()
        proof_floor = status["proof_floor"]
        assert isinstance(proof_floor, dict)
        dimensions = proof_floor["proof_dimensions"]
        assert isinstance(dimensions, list)
        for dimension in dimensions:
            if (
                isinstance(dimension, dict)
                and dimension.get("dimension") == "quant_ingestion"
            ):
                dimension["state"] = "informational"
                dimension["reason"] = "quant_latest_metrics_empty"
                dimension["source_ref"] = {"required": True}

        result = evaluate_trading_readiness(status, require_quant_fresh=False)

        self.assertFalse(result["ok"])
        self.assertIn("quant_ingestion_ready", result["failed_checks"])

    def test_legacy_evidence_required_quant_empty_fails_when_informational_quant_is_allowed(
        self,
    ) -> None:
        status = _ready_status()
        proof_floor = status["proof_floor"]
        assert isinstance(proof_floor, dict)
        dimensions = proof_floor["proof_dimensions"]
        assert isinstance(dimensions, list)
        for dimension in dimensions:
            if (
                isinstance(dimension, dict)
                and dimension.get("dimension") == "quant_ingestion"
            ):
                dimension["state"] = "informational"
                dimension["reason"] = "quant_latest_metrics_empty"
                dimension["source_ref"] = {"evidence_required": True}

        result = evaluate_trading_readiness(status, require_quant_fresh=False)

        self.assertFalse(result["ok"])
        self.assertIn("quant_ingestion_ready", result["failed_checks"])

    def test_closed_session_paper_route_probe_candidate_can_be_required_for_next_session(
        self,
    ) -> None:
        status = _ready_status()
        metrics = status["metrics"]
        assert isinstance(metrics, dict)
        metrics["market_session_open"] = 0
        route_book = status["route_reacquisition_book"]
        assert isinstance(route_book, dict)
        probe = route_book["paper_route_probe"]
        assert isinstance(probe, dict)
        probe.update(
            {
                "active": False,
                "effective_max_notional": "0",
                "next_session_max_notional": "25",
                "active_symbols": [],
                "blocking_reasons": ["market_session_closed"],
            }
        )
        summary = route_book["summary"]
        assert isinstance(summary, dict)
        summary["paper_route_probe_active_symbols"] = []

        result = evaluate_trading_readiness(
            status,
            require_market_open=False,
            require_paper_route_probe_candidate=True,
        )

        self.assertTrue(result["ok"], result)
        self.assertEqual(result["paper_route_probe"]["eligible_symbols"], ["NVDA"])
        self.assertEqual(
            result["paper_route_probe"]["blocking_reasons"], ["market_session_closed"]
        )
