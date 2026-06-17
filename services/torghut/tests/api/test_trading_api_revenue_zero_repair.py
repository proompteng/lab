from __future__ import annotations

from tests.api.trading_api_support import (
    OperationalError,
    TradingApiTestCaseBase,
    _freshness_carry_ledger_for_test,
    _retryable_tca_recompute_error,
    patch,
)


class TestTradingApiRevenueZeroRepair(TradingApiTestCaseBase):
    def test_trading_revenue_repair_endpoint_returns_business_digest(self) -> None:
        readyz_payload: dict[str, object] = {
            "status": "degraded",
            "dependencies": {
                "profitability_proof_floor": {
                    "ok": False,
                    "detail": "repair_only",
                    "capital_state": "zero_notional",
                },
                "live_submission_gate": {
                    "ok": False,
                    "detail": "simple_submit_disabled",
                    "capital_stage": "shadow",
                },
            },
        }
        status_payload: dict[str, object] = {
            "mode": "live",
            "pipeline_mode": "simple",
            "build": {"active_revision": "torghut-00254"},
            "live_submission_gate": {
                "allowed": False,
                "reason": "simple_submit_disabled",
                "blocked_reasons": ["simple_submit_disabled"],
                "capital_stage": "shadow",
                "configured_live_promotion": False,
            },
            "proof_floor": {
                "route_state": "repair_only",
                "capital_state": "zero_notional",
                "max_notional": "0",
                "blocking_reasons": [
                    "alpha_readiness_not_promotion_eligible",
                    "execution_tca_stale",
                    "simple_submit_disabled",
                ],
                "repair_ladder": [
                    {
                        "code": "repair_execution_tca",
                        "reason": "execution_tca_stale",
                        "dimension": "execution_tca",
                        "priority": 65,
                        "expected_unblock_value": 3,
                    }
                ],
                "proof_dimensions": [
                    {
                        "dimension": "execution_tca",
                        "state": "stale",
                        "reason": "execution_tca_stale",
                        "freshness_seconds": 2_988_327,
                        "threshold_seconds": 86_400,
                        "source_ref": {
                            "order_count": 13_775,
                            "last_computed_at": "2026-04-02T20:59:45.136640+00:00",
                            "avg_abs_slippage_bps": "568.6138848199565249",
                        },
                    }
                ],
            },
            "alpha_readiness": {
                "summary": {
                    "promotion_eligible_total": 0,
                    "rollback_required_total": 3,
                    "state_totals": {"blocked": 1, "shadow": 2},
                }
            },
            "quant_evidence": {"ok": True, "status": "healthy", "reason": "ready"},
            "routeability_repair_acceptance_ledger": {
                "ledger_id": "routeability-acceptance-ledger:test",
                "aggregate_state": "blocked",
                "accepted_routeable_candidate_count": 0,
                "zero_notional_or_stale_evidence_rate": 1,
                "aggregate_blocking_reason_codes": ["proof_floor_repair_only"],
            },
            "route_evidence_clearinghouse_packet": {
                "schema_version": "torghut.route-evidence-clearinghouse-packet.v1",
                "packet_id": "route-evidence-clearinghouse:test",
                "capital_decision": "repair_only",
                "accepted_routeable_candidate_count": 0,
                "zero_notional_or_stale_evidence_rate": 1,
                "selected_repair_bids": [
                    {"value_gate": "fill_tca_or_slippage_quality"}
                ],
                "held_action_classes": ["paper_canary", "live_micro_canary"],
                "summary": {"route_claim_count": 1},
            },
            "repair_bid_settlement_ledger": {
                "schema_version": "torghut.repair-bid-settlement-ledger.v1",
                "ledger_id": "repair-bid-settlement-ledger:test",
                "account_id": "PA3SX7FYNUTF",
                "session_id": "15m",
                "trading_mode": "live",
                "capital_decision": "repair_only",
                "max_notional": "0",
                "raw_repair_bid_count": 1,
                "routeable_candidate_count": 0,
                "selected_lot_ids": ["compacted-repair-lot:test"],
                "dispatchable_lot_ids": ["compacted-repair-lot:test"],
                "active_dedupe_keys": [],
                "compacted_lots": [
                    {
                        "lot_id": "compacted-repair-lot:promotion",
                        "lot_class": "promotion_custody",
                        "target_value_gate": "routeable_candidate_count",
                        "priority": 60,
                        "expected_gate_delta": "retire_alpha_readiness_not_promotion_eligible",
                        "raw_reason_codes": ["alpha_readiness_not_promotion_eligible"],
                        "required_output_receipt": "torghut.promotion-custody-decision-receipt.v1",
                        "dedupe_key": "PA3SX7FYNUTF:15m:promotion_custody",
                        "ttl_seconds": 900,
                        "max_runtime_seconds": 1200,
                        "max_notional": "0",
                        "state": "held",
                        "dispatchable": False,
                        "hold_reason_codes": ["selection_limit_exceeded"],
                        "source_bid_ids": ["route-evidence-repair-bid:promotion"],
                    }
                ],
                "summary": {
                    "compacted_lot_count": 1,
                    "selected_lot_count": 1,
                    "dispatchable_lot_count": 1,
                },
            },
        }
        with (
            patch(
                "app.api.maintenance._evaluate_trading_health_payload",
                return_value=(readyz_payload, 503),
            ),
            patch("app.api.maintenance.trading_status", return_value=status_payload),
        ):
            response = self.client.get("/trading/revenue-repair")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["schema_version"], "torghut.revenue-repair-digest.v1")
        self.assertEqual(
            payload["routeability_repair_acceptance_ledger_id"],
            "routeability-acceptance-ledger:test",
        )
        self.assertFalse(payload["revenue_ready"])
        self.assertEqual(payload["business_state"], "repair_only")
        self.assertEqual(payload["capital"]["capital_state"], "zero_notional")
        self.assertIn(
            "execution_tca_stale",
            {item["reason"] for item in payload["blockers"]},
        )
        self.assertEqual(payload["repair_queue"][0]["code"], "repair_alpha_readiness")
        self.assertEqual(payload["top_repair_queue_item"], payload["repair_queue"][0])
        self.assertEqual(payload["selected_value_gate"], "routeable_candidate_count")
        self.assertEqual(
            payload["required_output_receipt"],
            "torghut.executable-alpha-receipts.v1",
        )
        self.assertEqual(payload["capital_state"], "zero_notional")
        self.assertEqual(payload["capital_stage"], "shadow")
        self.assertFalse(payload["live_submission_allowed"])
        self.assertEqual(payload["max_notional"], "0")
        self.assertEqual(payload["accepted_routeable_candidate_count"], 0)
        self.assertEqual(payload["routeable_candidate_delta"], 0)
        self.assertEqual(payload["repair_bid_settlement_status"], "repair_only")
        self.assertEqual(
            payload["repair_bid_settlement_selected_lot_ids"],
            ["compacted-repair-lot:test"],
        )
        self.assertEqual(
            payload["repair_bid_settlement_dispatchable_lot_ids"],
            ["compacted-repair-lot:test"],
        )
        self.assertEqual(
            payload["repair_bid_settlement_held_lot_ids"],
            ["compacted-repair-lot:promotion"],
        )
        self.assertIn(
            "jangar_material_evidence_settlement_ref_unavailable",
            payload["field_unavailable_reason_codes"],
        )
        self.assertEqual(
            payload["expected_repair_action"],
            "clear_hypothesis_blockers_before_capital",
        )
        self.assertEqual(
            payload["evidence"]["execution_tca"]["last_computed_at"],
            "2026-04-02T20:59:45.136640+00:00",
        )
        self.assertEqual(
            payload["evidence"]["routeability_acceptance"]["ledger_id"],
            "routeability-acceptance-ledger:test",
        )
        self.assertEqual(
            payload["route_evidence_clearinghouse_packet"]["packet_id"],
            "route-evidence-clearinghouse:test",
        )
        self.assertEqual(
            payload["evidence"]["route_evidence_clearinghouse"][
                "selected_repair_bid_count"
            ],
            1,
        )
        self.assertEqual(
            payload["repair_bid_settlement_ledger"]["ledger_id"],
            "repair-bid-settlement-ledger:test",
        )
        self.assertEqual(
            payload["alpha_readiness_strike_ledger"]["schema_version"],
            "torghut.alpha-readiness-strike-ledger.v1",
        )
        self.assertEqual(
            payload["alpha_readiness_strike_ledger"]["strike_slots"][0]["lot_class"],
            "promotion_custody",
        )
        self.assertEqual(
            payload["executable_alpha_repair_receipts"]["schema_version"],
            "torghut.executable-alpha-repair-receipts.v1",
        )
        self.assertEqual(payload["executable_alpha_repair_receipts"]["status"], "held")
        self.assertIn(
            "alpha_readiness_repair_targets_missing",
            payload["executable_alpha_repair_receipts"]["reason_codes"],
        )
        settlement_slots = payload["executable_alpha_settlement_slots"]
        self.assertEqual(
            settlement_slots["schema_version"],
            "torghut.executable-alpha-settlement-slots.v1",
        )
        self.assertEqual(settlement_slots["status"], "held")
        self.assertEqual(settlement_slots["selected_slot"], None)
        self.assertEqual(settlement_slots["max_notional"], "0")
        self.assertIn(
            "selected_executable_alpha_repair_receipt_missing",
            settlement_slots["reason_codes"],
        )
        closure_board = payload["alpha_repair_closure_board"]
        self.assertEqual(
            closure_board["schema_version"],
            "torghut.alpha-repair-closure-board.v1",
        )
        self.assertEqual(closure_board["status"], "blocked")
        self.assertEqual(
            closure_board["selected_value_gate"], "routeable_candidate_count"
        )
        self.assertEqual(closure_board["max_notional"], "0")
        self.assertIn("alpha_repair_receipt_missing", closure_board["reason_codes"])
        alpha_foundry = payload["alpha_evidence_foundry"]
        self.assertEqual(
            alpha_foundry["schema_version"],
            "torghut.alpha-evidence-foundry.v1",
        )
        self.assertEqual(alpha_foundry["status"], "held")
        self.assertEqual(alpha_foundry["selected_queue_code"], "repair_alpha_readiness")
        self.assertEqual(
            alpha_foundry["selected_value_gate"], "routeable_candidate_count"
        )
        self.assertEqual(
            alpha_foundry["required_output_receipt"],
            "torghut.alpha-evidence-window-receipt.v1",
        )
        self.assertEqual(alpha_foundry["max_notional"], "0")
        self.assertIn(
            "alpha_evidence_window_receipts_missing",
            alpha_foundry["reason_codes"],
        )
        settlement_conveyor = payload["alpha_readiness_settlement_conveyor"]
        self.assertEqual(
            settlement_conveyor["schema_version"],
            "torghut.alpha-readiness-settlement-conveyor.v1",
        )
        self.assertEqual(settlement_conveyor["status"], "blocked")
        self.assertEqual(settlement_conveyor["max_notional"], "0")
        self.assertIn(
            "alpha_readiness_settlement_receipts_missing",
            settlement_conveyor["reason_codes"],
        )
        alpha_dividend = payload["alpha_repair_dividend_ledger"]
        self.assertEqual(
            alpha_dividend["schema_version"],
            "torghut.alpha-repair-dividend-ledger.v1",
        )
        self.assertEqual(alpha_dividend["dividend_state"], "blocked")
        self.assertEqual(alpha_dividend["max_notional"], "0")
        self.assertIn(
            "alpha_repair_settlement_receipt_missing",
            alpha_dividend["reason_codes"],
        )
        self.assertEqual(
            payload["evidence"]["repair_bid_settlement"]["dispatchable_lot_count"],
            1,
        )

    def test_zero_notional_repair_endpoint_returns_dry_run_receipt(self) -> None:
        status_payload = {
            "active_revision": "torghut-00320",
            "freshness_carry_ledger": _freshness_carry_ledger_for_test("empirical"),
            "profit_freshness_frontier": {
                "frontier_id": "profit-freshness-frontier:test",
                "capital_posture": {
                    "capital_state": "zero_notional",
                    "paper_notional_limit": "0",
                    "live_notional_limit": "0",
                    "capital_behavior_changed": False,
                },
                "selected_zero_notional_repairs": [
                    {
                        "lot_id": "profit-freshness-repair-lot:test",
                        "candidate_id": "candidate-a",
                        "hypothesis_id": "H-AAPL",
                        "blocked_dimension": "empirical_proof",
                        "zero_notional_action": "renew_empirical_proof_jobs",
                        "before_refs": ["empirical:H-AAPL"],
                        "paper_notional_limit": "0",
                        "live_notional_limit": "0",
                        "state": "selected_zero_notional_repair",
                    }
                ],
            },
        }
        with patch("app.api.maintenance.trading_status", return_value=status_payload):
            response = self.client.post(
                "/trading/profit-freshness/zero-notional-repair"
            )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(
            payload["schema_version"],
            "torghut.zero-notional-repair-execution-receipt.v1",
        )
        self.assertEqual(payload["execution_state"], "dry_run_ready")
        self.assertEqual(payload["command_exit_code"], 0)
        self.assertFalse(payload["order_submission_enabled"])
        self.assertEqual(payload["paper_notional_limit"], "0")
        self.assertEqual(payload["live_notional_limit"], "0")
        self.assertEqual(payload["before_refs"], ["empirical:H-AAPL"])
        self.assertEqual(
            payload["freshness_carry_ledger_ref"],
            "freshness-carry-ledger:test",
        )
        self.assertEqual(payload["freshness_citation_state"], "cited")
        self.assertEqual(payload["freshness_dimension_id"], "empirical")
        self.assertEqual(
            payload["freshness_repair_proof_slo_ref"],
            "freshness-repair-slo:empirical",
        )

    def test_zero_notional_repair_endpoint_accepts_dispatch_ticket_body(self) -> None:
        status_payload = {
            "active_revision": "torghut-00320",
            "freshness_carry_ledger": _freshness_carry_ledger_for_test("empirical"),
            "profit_freshness_frontier": {
                "frontier_id": "profit-freshness-frontier:test",
                "capital_posture": {
                    "capital_state": "zero_notional",
                    "paper_notional_limit": "0",
                    "live_notional_limit": "0",
                    "capital_behavior_changed": False,
                },
                "selected_zero_notional_repairs": [
                    {
                        "lot_id": "profit-freshness-repair-lot:test",
                        "candidate_id": "candidate-a",
                        "hypothesis_id": "H-AAPL",
                        "blocked_dimension": "empirical_proof",
                        "zero_notional_action": "renew_empirical_proof_jobs",
                        "before_refs": ["empirical:H-AAPL"],
                        "paper_notional_limit": "0",
                        "live_notional_limit": "0",
                        "state": "selected_zero_notional_repair",
                    }
                ],
            },
        }
        repair_lot_dispatch_ticket = {
            "schema_version": "jangar.repair-lot-dispatch-ticket.v1",
            "ticket_id": "repair-lot-dispatch-ticket:test",
            "admission_receipt_id": "repair-bid-admission-receipt:test",
            "torghut_lot_id": "profit-freshness-repair-lot:test",
            "lot_class": "empirical_replay",
            "target_value_gate": "zero_notional_or_stale_evidence_rate",
            "dedupe_key": "torghut-repair:test",
            "required_output_receipt": "torghut.empirical-proof-refresh-receipt.v1",
            "launch_allowed": True,
            "launch_reason": "current_zero_notional_compacted_lot",
            "stop_conditions": ["fresh_until_expired", "dedupe_key_became_active"],
            "max_runtime_seconds": 1200,
            "max_notional": 0,
            "expected_gate_delta": 1,
            "rollback_target": "keep Torghut max_notional=0",
        }
        with patch("app.api.maintenance.trading_status", return_value=status_payload):
            response = self.client.post(
                "/trading/profit-freshness/zero-notional-repair?execute=true",
                json=repair_lot_dispatch_ticket,
            )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["execution_state"], "runner_admission_required")
        self.assertEqual(payload["command_exit_code"], 78)
        self.assertEqual(
            payload["blocked_reasons"],
            ["zero_notional_runner_admission_required"],
        )
        self.assertEqual(
            payload["repair_lot_dispatch_ticket_ref"],
            "repair-lot-dispatch-ticket:test",
        )
        self.assertEqual(payload["freshness_citation_state"], "cited")
        self.assertEqual(payload["freshness_dimension_id"], "empirical")
        self.assertTrue(payload["repair_lot_dispatch_ticket_launch_allowed"])
        self.assertFalse(payload["order_submission_enabled"])

    def test_zero_notional_repair_endpoint_can_select_queued_route_tca_action(
        self,
    ) -> None:
        status_payload = {
            "active_revision": "torghut-00320",
            "freshness_carry_ledger": _freshness_carry_ledger_for_test("tca"),
            "profit_freshness_frontier": {
                "frontier_id": "profit-freshness-frontier:test",
                "capital_posture": {
                    "capital_state": "zero_notional",
                    "paper_notional_limit": "0",
                    "live_notional_limit": "0",
                    "capital_behavior_changed": False,
                },
                "selected_zero_notional_repairs": [
                    {
                        "lot_id": "profit-freshness-repair-lot:empirical",
                        "candidate_id": "candidate-a",
                        "hypothesis_id": "H-AAPL",
                        "blocked_dimension": "empirical_proof",
                        "zero_notional_action": "renew_empirical_proof_jobs",
                        "before_refs": ["empirical:stale"],
                        "paper_notional_limit": "0",
                        "live_notional_limit": "0",
                        "state": "selected_zero_notional_repair",
                    }
                ],
                "repair_lots": [
                    {
                        "lot_id": "profit-freshness-repair-lot:tca",
                        "candidate_id": "candidate-b",
                        "hypothesis_id": "H-NVDA",
                        "blocked_dimension": "tca_fill_quality",
                        "zero_notional_action": "recompute_route_tca_and_fill_quality",
                        "before_refs": ["execution_tca:NVDA"],
                        "paper_notional_limit": "0",
                        "live_notional_limit": "0",
                        "state": "queued_zero_notional_repair",
                    }
                ],
            },
        }
        with patch("app.api.maintenance.trading_status", return_value=status_payload):
            response = self.client.post(
                "/trading/profit-freshness/zero-notional-repair"
                "?action=recompute_route_tca_and_fill_quality"
            )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["execution_state"], "dry_run_ready")
        self.assertEqual(
            payload["zero_notional_action"],
            "recompute_route_tca_and_fill_quality",
        )
        self.assertEqual(
            payload["preferred_zero_notional_action"],
            "recompute_route_tca_and_fill_quality",
        )
        self.assertEqual(payload["repair_lot_ref"], "profit-freshness-repair-lot:tca")
        self.assertEqual(payload["before_refs"], ["execution_tca:NVDA"])
        self.assertEqual(payload["freshness_citation_state"], "cited")
        self.assertEqual(payload["freshness_dimension_id"], "tca")
        self.assertFalse(payload["order_submission_enabled"])

    def test_zero_notional_repair_endpoint_retries_route_tca_deadlock(self) -> None:
        class _Deadlock:
            sqlstate = "40P01"

            def __str__(self) -> str:
                return "deadlock detected"

        status_payload = {
            "active_revision": "torghut-00320",
            "freshness_carry_ledger": _freshness_carry_ledger_for_test("tca"),
            "profit_freshness_frontier": {
                "frontier_id": "profit-freshness-frontier:test",
                "capital_posture": {
                    "capital_state": "zero_notional",
                    "paper_notional_limit": "0",
                    "live_notional_limit": "0",
                    "capital_behavior_changed": False,
                },
                "selected_zero_notional_repairs": [
                    {
                        "lot_id": "profit-freshness-repair-lot:tca",
                        "candidate_id": "candidate-b",
                        "hypothesis_id": "H-AMZN",
                        "blocked_dimension": "tca_fill_quality",
                        "zero_notional_action": "recompute_route_tca_and_fill_quality",
                        "before_refs": ["execution_tca:AMZN"],
                        "paper_notional_limit": "0",
                        "live_notional_limit": "0",
                        "state": "selected_zero_notional_repair",
                    }
                ],
            },
        }

        with (
            patch("app.api.maintenance.trading_status", return_value=status_payload),
            patch("app.api.maintenance.time.sleep") as sleep,
            patch(
                "app.api.maintenance.refresh_execution_tca_metrics",
                side_effect=[
                    OperationalError("UPDATE execution_tca_metrics", {}, _Deadlock()),
                    {
                        "selected": 1,
                        "refreshed": 1,
                        "dry_run": False,
                        "limit": 250,
                        "account_label": "paper",
                    },
                ],
            ) as refresh,
        ):
            response = self.client.post(
                "/trading/profit-freshness/zero-notional-repair"
                "?action=recompute_route_tca_and_fill_quality&execute=true"
            )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["execution_state"], "executed")
        self.assertEqual(payload["command_exit_code"], 0)
        self.assertEqual(payload["after_refs"], ["execution_tca_metrics"])
        self.assertEqual(payload["runner_result"]["retry_attempts"], 1)
        self.assertEqual(
            payload["runner_result"]["retry_reasons"],
            ["route_tca_recompute_retryable:OperationalError"],
        )
        self.assertFalse(payload["order_submission_enabled"])
        self.assertEqual(refresh.call_count, 2)
        sleep.assert_called_once()

    def test_retryable_tca_recompute_error_classifies_db_retries(self) -> None:
        class _SerializationFailure:
            pgcode = "40001"

        self.assertFalse(
            _retryable_tca_recompute_error(ValueError("deadlock detected"))
        )
        self.assertTrue(
            _retryable_tca_recompute_error(
                OperationalError(
                    "UPDATE execution_tca_metrics",
                    {},
                    _SerializationFailure(),
                )
            )
        )
        self.assertTrue(
            _retryable_tca_recompute_error(
                OperationalError(
                    "deadlock detected",
                    {},
                    Exception("database busy"),
                )
            )
        )
        self.assertTrue(
            _retryable_tca_recompute_error(
                OperationalError(
                    "serialization failure",
                    {},
                    Exception("database busy"),
                )
            )
        )

    def test_zero_notional_repair_endpoint_fails_closed_on_route_tca_error(
        self,
    ) -> None:
        class _PermissionDenied:
            def __str__(self) -> str:
                return "permission denied"

        status_payload = {
            "active_revision": "torghut-00320",
            "freshness_carry_ledger": _freshness_carry_ledger_for_test("tca"),
            "profit_freshness_frontier": {
                "frontier_id": "profit-freshness-frontier:test",
                "capital_posture": {
                    "capital_state": "zero_notional",
                    "paper_notional_limit": "0",
                    "live_notional_limit": "0",
                    "capital_behavior_changed": False,
                },
                "selected_zero_notional_repairs": [
                    {
                        "lot_id": "profit-freshness-repair-lot:tca",
                        "candidate_id": "candidate-b",
                        "hypothesis_id": "H-AMZN",
                        "blocked_dimension": "tca_fill_quality",
                        "zero_notional_action": "recompute_route_tca_and_fill_quality",
                        "before_refs": ["execution_tca:AMZN"],
                        "paper_notional_limit": "0",
                        "live_notional_limit": "0",
                        "state": "selected_zero_notional_repair",
                    }
                ],
            },
        }

        with (
            patch("app.api.maintenance.trading_status", return_value=status_payload),
            patch(
                "app.api.maintenance.refresh_execution_tca_metrics",
                side_effect=OperationalError(
                    "UPDATE execution_tca_metrics",
                    {},
                    _PermissionDenied(),
                ),
            ) as refresh,
        ):
            response = self.client.post(
                "/trading/profit-freshness/zero-notional-repair"
                "?action=recompute_route_tca_and_fill_quality&execute=true"
            )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["execution_state"], "runner_failed")
        self.assertEqual(payload["command_exit_code"], 1)
        self.assertEqual(payload["after_refs"], [])
        self.assertEqual(
            payload["blocked_reasons"],
            ["route_tca_recompute_failed:OperationalError"],
        )
        self.assertEqual(payload["runner_result"]["retry_attempts"], 0)
        self.assertEqual(refresh.call_count, 1)
