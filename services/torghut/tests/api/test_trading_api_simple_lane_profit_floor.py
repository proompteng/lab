from __future__ import annotations

from tests.api.trading_api_support import (
    Decimal,
    RejectedSignalOutcomeEvent,
    SQLAlchemyError,
    SimpleNamespace,
    TradingApiTestCaseBase,
    TradingScheduler,
    _build_live_submission_gate_payload,
    _load_rejected_signal_outcome_learning_summary,
    _readiness_dependency_checks,
    app,
    datetime,
    patch,
    settings,
    timezone,
)


class TestTradingApiSimpleLaneProfitFloor(TradingApiTestCaseBase):
    def test_readiness_checks_external_dependencies_before_postgres_session(
        self,
    ) -> None:
        call_order: list[str] = []
        original_trading_enabled = settings.trading_enabled
        settings.trading_enabled = True
        try:
            with (
                patch(
                    "app.api.health_checks.check_clickhouse_dependency",
                    side_effect=lambda: (
                        call_order.append("clickhouse") or {"ok": True, "detail": "ok"}
                    ),
                ),
                patch(
                    "app.api.health_checks.check_alpaca_dependency",
                    side_effect=lambda: (
                        call_order.append("alpaca") or {"ok": True, "detail": "ok"}
                    ),
                ),
                patch(
                    "app.api.health_checks.check_postgres_dependency",
                    side_effect=lambda _session: (
                        call_order.append("postgres") or {"ok": True, "detail": "ok"}
                    ),
                ),
            ):
                with self.session_local() as session:
                    _readiness_dependency_checks(
                        session,
                        include_database_contract=False,
                    )
        finally:
            settings.trading_enabled = original_trading_enabled

        self.assertEqual(call_order, ["clickhouse", "alpaca", "postgres"])

    def test_trading_status_surfaces_route_neutral_execution_contract(self) -> None:
        original_pipeline_mode = settings.trading_pipeline_mode
        original_trading_enabled = settings.trading_enabled
        original_trading_mode = settings.trading_mode
        original_simple_submit_enabled = settings.trading_simple_submit_enabled
        original_live_submit_enabled = settings.trading_live_submit_enabled
        original_testnet_after_hours_enabled = (
            settings.trading_testnet_after_hours_enabled
        )
        original_kill_switch_enabled = settings.trading_kill_switch_enabled

        settings.trading_pipeline_mode = "simple"
        settings.trading_enabled = True
        settings.trading_mode = "live"
        settings.trading_simple_submit_enabled = True
        settings.trading_live_submit_enabled = True
        settings.trading_testnet_after_hours_enabled = True
        settings.trading_kill_switch_enabled = False
        try:
            scheduler = TradingScheduler()
            scheduler.state.metrics.orders_submitted_total = 7
            scheduler.state.metrics.decision_reject_reason_total = {
                "broker_submit_failed": 2,
                "capital_stage_shadow": 9,
            }
            scheduler.state.metrics.strategy_intent_suppression_total = {
                "strategy-1|exit_only_sell_without_long_position": 4,
            }
            scheduler.state.metrics.rejected_signal_events_total = 3
            scheduler.state.metrics.rejected_signal_outcome_label_pending_total = 3
            scheduler.state.metrics.rejected_signal_reason_total = {
                "missing_executable_quote": 3,
            }
            scheduler.state.last_rejected_signal_outcome_event = {
                "schema_version": "torghut.rejected-signal-outcome-event.v1",
                "source": "quote_quality_gate",
                "paper_claim_id": "rejection-event-outcome-labels",
                "symbol": "AAPL",
                "reject_reason": "missing_executable_quote",
                "outcome_label_status": "pending",
            }
            app.state.trading_scheduler = scheduler

            with patch(
                "app.api.trading_status._load_clickhouse_ta_status",
                return_value={
                    "state": "current",
                    "accepted_sources": ["ta"],
                    "latest_accepted_event_at": "2026-03-20T09:59:00Z",
                    "accepted_lag_seconds": 30,
                    "accepted_max_lag_seconds": 300,
                    "accepted_source_state": "current",
                    "blocking_reason": None,
                    "excluded_fresher_sources": [],
                    "per_symbol_coverage": [],
                    "market_session_state": "regular_open",
                },
            ):
                response = self.client.get("/trading/status")
            self.assertEqual(response.status_code, 200)
            payload = response.json()

            self.assertEqual(payload["pipeline_mode"], "simple")
            self.assertEqual(payload["execution_lane"], "simple")
            self.assertTrue(payload["live_submission_gate"]["allowed"])
            self.assertEqual(
                payload["live_submission_gate"]["reason"],
                "operational_submission_ready",
            )
            self.assertNotIn(
                "hypothesis_not_promotion_eligible",
                payload["live_submission_gate"]["blocked_reasons"],
            )
            self.assertNotIn(
                "runtime_window_import_required",
                payload["live_submission_gate"]["blocked_reasons"],
            )
            self.assertNotIn(
                "runtime_profit_target_import_required",
                payload["live_submission_gate"]["blocked_reasons"],
            )
            self.assertNotIn("simple_lane", payload["live_submission_gate"])
            self.assertIn(
                "profit_window_contract",
                payload["live_submission_gate"],
            )
            self.assertEqual(payload["execution"]["orders_submitted_total"], 7)
            self.assertEqual(
                payload["execution"]["reject_reason_totals"],
                {"broker_submit_failed": 2},
            )
            self.assertNotIn("simple_lane_reject_reason_totals", payload)
            self.assertNotIn("simple_lane_status", payload)
            self.assertEqual(
                payload["rejections"]["strategy_intent_suppression_total"],
                {"strategy-1|exit_only_sell_without_long_position": 4},
            )
            self.assertEqual(payload["rejections"]["rejected_signal_events_total"], 3)
            self.assertEqual(
                payload["rejections"]["rejected_signal_reason_total"],
                {"missing_executable_quote": 3},
            )
            outcome_learning = payload["rejected_signal_outcome_learning"]
            self.assertEqual(
                outcome_learning["schema_version"],
                "torghut.rejected-signal-outcome-learning.v1",
            )
            self.assertEqual(outcome_learning["state"], "pending_outcome_labels")
            self.assertEqual(outcome_learning["events_total"], 3)
            self.assertEqual(
                outcome_learning["blocking_reasons"],
                ["counterfactual_outcome_labels_pending"],
            )
            self.assertEqual(
                outcome_learning["latest_event"]["paper_claim_id"],
                "rejection-event-outcome-labels",
            )
        finally:
            settings.trading_pipeline_mode = original_pipeline_mode
            settings.trading_enabled = original_trading_enabled
            settings.trading_mode = original_trading_mode
            settings.trading_simple_submit_enabled = original_simple_submit_enabled
            settings.trading_live_submit_enabled = original_live_submit_enabled
            settings.trading_testnet_after_hours_enabled = (
                original_testnet_after_hours_enabled
            )
            settings.trading_kill_switch_enabled = original_kill_switch_enabled

    def test_trading_status_summarizes_persisted_rejected_signal_outcomes(
        self,
    ) -> None:
        with self.session_local() as session:
            required_fields = [
                "counterfactual_return",
                "route_tca",
                "post_cost_net_pnl",
                "executable_quote",
            ]
            session.add_all(
                [
                    RejectedSignalOutcomeEvent(
                        event_id="reject-event-1",
                        source="quote_quality_gate",
                        paper_source="paper-arxiv-2605.12151",
                        paper_claim_id="rejection-event-outcome-labels",
                        account_label="paper",
                        symbol="AAPL",
                        event_ts=datetime(2026, 5, 18, 14, 31, tzinfo=timezone.utc),
                        timeframe="1Min",
                        seq="42",
                        reject_reason="missing_executable_quote",
                        spread_bps=Decimal("55.5"),
                        jump_bps=None,
                        outcome_label_status="pending",
                        counterfactual_required=True,
                        required_outcome_fields_json=required_fields,
                        event_payload_json={"event_id": "reject-event-1"},
                    ),
                    RejectedSignalOutcomeEvent(
                        event_id="reject-event-2",
                        source="quote_quality_gate",
                        paper_source="paper-arxiv-2605.12151",
                        paper_claim_id="rejection-event-outcome-labels",
                        account_label="paper",
                        symbol="MSFT",
                        event_ts=datetime(2026, 5, 18, 14, 32, tzinfo=timezone.utc),
                        timeframe="1Min",
                        seq="43",
                        reject_reason="wide_spread",
                        outcome_label_status="labeled",
                        counterfactual_required=True,
                        required_outcome_fields_json=required_fields,
                        event_payload_json={"event_id": "reject-event-2"},
                        outcome_payload_json={"post_cost_net_pnl": "1.25"},
                    ),
                    RejectedSignalOutcomeEvent(
                        event_id="reject-event-3",
                        source="quote_quality_gate",
                        paper_source="paper-arxiv-2605.12151",
                        paper_claim_id="rejection-event-outcome-labels",
                        account_label="paper",
                        symbol="NVDA",
                        event_ts=datetime(2026, 5, 18, 14, 33, tzinfo=timezone.utc),
                        timeframe="1Min",
                        seq="44",
                        reject_reason="missing_executable_quote",
                        outcome_label_status="incomplete",
                        counterfactual_required=True,
                        required_outcome_fields_json=required_fields,
                        event_payload_json={"event_id": "reject-event-3"},
                    ),
                ]
            )
            session.commit()

        scheduler = TradingScheduler()
        app.state.trading_scheduler = scheduler
        try:
            response = self.client.get("/trading/status")
            self.assertEqual(response.status_code, 200)
            outcome_learning = response.json()["rejected_signal_outcome_learning"]
        finally:
            app.state.trading_scheduler = None

        self.assertEqual(outcome_learning["persistence_state"], "ok")
        self.assertEqual(outcome_learning["events_total"], 3)
        self.assertEqual(outcome_learning["outcome_label_pending_total"], 1)
        self.assertEqual(outcome_learning["labeled_count"], 1)
        self.assertEqual(outcome_learning["incomplete_count"], 1)
        self.assertEqual(
            outcome_learning["outcome_label_status_total"],
            {"incomplete": 1, "labeled": 1, "pending": 1},
        )
        self.assertEqual(
            outcome_learning["reason_total"],
            {"missing_executable_quote": 2, "wide_spread": 1},
        )
        self.assertEqual(outcome_learning["latest_event"]["event_id"], "reject-event-3")
        self.assertEqual(
            outcome_learning["blocking_reasons"],
            ["counterfactual_outcome_labels_pending"],
        )

    def test_rejected_signal_outcome_summary_reports_unavailable_on_db_error(
        self,
    ) -> None:
        with self.session_local() as session:
            with patch.object(
                session,
                "execute",
                side_effect=SQLAlchemyError("db unavailable"),
            ):
                summary = _load_rejected_signal_outcome_learning_summary(session)

        self.assertEqual(summary, {"persistence_state": "unavailable"})

    def test_operational_gate_applies_local_block_reason(self) -> None:
        original = {
            "trading_pipeline_mode": settings.trading_pipeline_mode,
            "trading_enabled": settings.trading_enabled,
            "trading_mode": settings.trading_mode,
            "trading_simple_submit_enabled": settings.trading_simple_submit_enabled,
            "trading_live_submit_enabled": settings.trading_live_submit_enabled,
            "trading_kill_switch_enabled": settings.trading_kill_switch_enabled,
            "trading_emergency_stop_enabled": settings.trading_emergency_stop_enabled,
        }
        settings.trading_pipeline_mode = "simple"
        settings.trading_enabled = False
        settings.trading_mode = "live"
        settings.trading_simple_submit_enabled = True
        settings.trading_live_submit_enabled = True
        settings.trading_kill_switch_enabled = False
        settings.trading_emergency_stop_enabled = False
        try:
            with patch(
                "app.api.health_checks.load_options_catalog_freshness_summary.build_live_submission_gate_payload",
                return_value={
                    "allowed": True,
                    "reason": "ready",
                    "blocked_reasons": [],
                    "capital_stage": "live",
                    "capital_state": "live",
                },
            ):
                gate = _build_live_submission_gate_payload(
                    SimpleNamespace(emergency_stop_active=False),
                    session=None,
                    hypothesis_summary={},
                )
        finally:
            settings.trading_pipeline_mode = original["trading_pipeline_mode"]
            settings.trading_enabled = original["trading_enabled"]
            settings.trading_mode = original["trading_mode"]
            settings.trading_simple_submit_enabled = original[
                "trading_simple_submit_enabled"
            ]
            settings.trading_live_submit_enabled = original[
                "trading_live_submit_enabled"
            ]
            settings.trading_kill_switch_enabled = original[
                "trading_kill_switch_enabled"
            ]
            settings.trading_emergency_stop_enabled = original[
                "trading_emergency_stop_enabled"
            ]

        self.assertFalse(gate["allowed"])
        self.assertEqual(gate["reason"], "trading_disabled")
        self.assertEqual(gate["capital_stage"], "shadow")
        self.assertEqual(gate["capital_state"], "observe")
        self.assertEqual(gate["blocked_reasons"], ["trading_disabled"])
        self.assertNotIn("simple_lane", gate)
        self.assertEqual(
            gate["operational_submission_gate"]["blocked_reasons"],
            ["trading_disabled"],
        )

    def test_operational_gate_applies_emergency_stop_reason(self) -> None:
        original = {
            "trading_pipeline_mode": settings.trading_pipeline_mode,
            "trading_enabled": settings.trading_enabled,
            "trading_mode": settings.trading_mode,
            "trading_simple_submit_enabled": settings.trading_simple_submit_enabled,
            "trading_live_submit_enabled": settings.trading_live_submit_enabled,
            "trading_kill_switch_enabled": settings.trading_kill_switch_enabled,
            "trading_emergency_stop_enabled": settings.trading_emergency_stop_enabled,
        }
        settings.trading_pipeline_mode = "simple"
        settings.trading_enabled = True
        settings.trading_mode = "live"
        settings.trading_simple_submit_enabled = True
        settings.trading_live_submit_enabled = True
        settings.trading_kill_switch_enabled = False
        settings.trading_emergency_stop_enabled = True
        try:
            with patch(
                "app.api.health_checks.load_options_catalog_freshness_summary.build_live_submission_gate_payload",
                return_value={
                    "allowed": True,
                    "reason": "ready",
                    "blocked_reasons": [],
                    "capital_stage": "live",
                    "capital_state": "live",
                },
            ):
                gate = _build_live_submission_gate_payload(
                    SimpleNamespace(
                        emergency_stop_active=True,
                        emergency_stop_reason="operator_pause",
                    ),
                    session=None,
                    hypothesis_summary={},
                )
        finally:
            settings.trading_pipeline_mode = original["trading_pipeline_mode"]
            settings.trading_enabled = original["trading_enabled"]
            settings.trading_mode = original["trading_mode"]
            settings.trading_simple_submit_enabled = original[
                "trading_simple_submit_enabled"
            ]
            settings.trading_live_submit_enabled = original[
                "trading_live_submit_enabled"
            ]
            settings.trading_kill_switch_enabled = original[
                "trading_kill_switch_enabled"
            ]
            settings.trading_emergency_stop_enabled = original[
                "trading_emergency_stop_enabled"
            ]

        self.assertFalse(gate["allowed"])
        self.assertEqual(gate["reason"], "operator_pause")
        self.assertEqual(gate["blocked_reasons"], ["operator_pause"])
        self.assertNotIn("simple_lane", gate)
        self.assertEqual(
            gate["operational_submission_gate"]["blocked_reasons"],
            ["operator_pause"],
        )

    def test_paper_mode_preserves_shared_runtime_import_plan(self) -> None:
        original = {
            "trading_pipeline_mode": settings.trading_pipeline_mode,
            "trading_mode": settings.trading_mode,
            "trading_simple_submit_enabled": settings.trading_simple_submit_enabled,
        }
        settings.trading_pipeline_mode = "simple"
        settings.trading_mode = "paper"
        settings.trading_simple_submit_enabled = True
        shared_gate = {
            "allowed": True,
            "reason": "non_live_mode",
            "blocked_reasons": [],
            "capital_stage": "paper",
            "promotion_eligible_total": 0,
            "paper_probation_eligible_total": 1,
            "runtime_ledger_paper_probation_import_plan": {
                "schema_version": "torghut.runtime-ledger-paper-probation-import-plan.v1",
                "target_count": 1,
                "targets": [
                    {
                        "hypothesis_id": "H-PAIRS-01",
                        "candidate_id": "c88421d619759b2cfaa6f4d0",
                        "paper_probation_authorized": True,
                        "promotion_allowed": False,
                        "final_promotion_authorized": False,
                    }
                ],
            },
        }
        try:
            with patch(
                "app.api.health_checks.load_options_catalog_freshness_summary.build_live_submission_gate_payload",
                return_value=shared_gate,
            ) as shared_gate_builder:
                gate = _build_live_submission_gate_payload(
                    SimpleNamespace(emergency_stop_active=False),
                    session=None,
                    hypothesis_summary={},
                )
        finally:
            settings.trading_pipeline_mode = original["trading_pipeline_mode"]
            settings.trading_mode = original["trading_mode"]
            settings.trading_simple_submit_enabled = original[
                "trading_simple_submit_enabled"
            ]

        shared_gate_builder.assert_called_once()
        self.assertTrue(gate["allowed"])
        self.assertEqual(gate["reason"], "non_live_mode")
        self.assertEqual(gate["pipeline_mode"], "simple")
        self.assertEqual(
            gate["runtime_ledger_paper_probation_import_plan"]["target_count"],
            1,
        )
        self.assertNotIn("simple_lane", gate)

    def test_trading_status_and_health_include_profitability_proof_floor(
        self,
    ) -> None:
        proof_floor = {
            "schema_version": "torghut.profitability-proof-floor.v1",
            "generated_at": "2026-05-07T22:11:12.125118+00:00",
            "account_label": "PA3SX7FYNUTF",
            "route_state": "repair_only",
            "capital_state": "zero_notional",
            "repair_ladder": [{"code": "repair_execution_tca"}],
            "route_reacquisition_book": {
                "schema_version": "torghut.route-reacquisition-book.v1",
                "account_label": "PA3SX7FYNUTF",
                "trading_mode": "live",
                "records": [
                    {
                        "symbol": "NVDA",
                        "state": "blocked",
                        "reason": "execution_tca_route_universe_incomplete",
                        "filled_execution_count": 12,
                        "next_repair_action": "repair_route_evidence_before_paper_probe",
                    }
                ],
                "summary": {"blocked_symbol_count": 1},
            },
        }

        with patch(
            "app.api.proof_floor_payloads.proof_floor_receipts.build_profitability_proof_floor_receipt",
            return_value=proof_floor,
        ):
            status_response = self.client.get("/trading/status")
            health_response = self.client.get("/trading/health")

        self.assertEqual(status_response.status_code, 200)
        self.assertIn(health_response.status_code, {200, 503})
        self.assertEqual(status_response.json()["proof_floor"], proof_floor)
        status_consumer_evidence = status_response.json()[
            "torghut_consumer_evidence_receipt"
        ]
        self.assertEqual(
            status_consumer_evidence["schema_version"],
            "torghut.consumer-evidence-receipt.v1",
        )
        self.assertEqual(status_consumer_evidence["paper_readiness_state"], "blocked")
        self.assertIn(
            "forecast_registry_degraded", status_consumer_evidence["reason_codes"]
        )
        status_route_receipt = status_response.json()["route_proven_profit_receipt"]
        self.assertEqual(
            status_route_receipt["schema_version"],
            "torghut.route-proven-profit-receipt.v1",
        )
        self.assertEqual(status_route_receipt["decision"], "repair")
        self.assertEqual(
            status_route_receipt["consumer_evidence_receipt_id"],
            status_consumer_evidence["receipt_id"],
        )
        self.assertEqual(
            status_response.json()["consumer_evidence_canary"],
            status_route_receipt["route_canary"],
        )
        self.assertEqual(
            status_response.json()["route_reacquisition_book"],
            proof_floor["route_reacquisition_book"],
        )
        status_board = status_response.json()["route_reacquisition_board"]
        self.assertEqual(
            status_board["schema_version"],
            "torghut.route-reacquisition-board.v1",
        )
        self.assertEqual(status_board["state"], "repair_only")
        self.assertEqual(status_board["summary"]["zero_notional_row_count"], 1)
        self.assertEqual(status_board["rows"][0]["symbol"], "NVDA")
        self.assertEqual(status_board["rows"][0]["max_notional"], "0")
        self.assertEqual(health_response.json()["proof_floor"], proof_floor)
        self.assertEqual(
            health_response.json()["torghut_consumer_evidence_receipt"][
                "schema_version"
            ],
            "torghut.consumer-evidence-receipt.v1",
        )
        self.assertEqual(
            health_response.json()["route_proven_profit_receipt"]["schema_version"],
            "torghut.route-proven-profit-receipt.v1",
        )
        self.assertEqual(
            health_response.json()["route_reacquisition_book"],
            proof_floor["route_reacquisition_book"],
        )
        health_board = health_response.json()["route_reacquisition_board"]
        self.assertEqual(
            health_board["schema_version"],
            "torghut.route-reacquisition-board.v1",
        )
        self.assertEqual(health_board["state"], status_board["state"])
        self.assertEqual(health_board["summary"], status_board["summary"])
        self.assertEqual(health_board["rows"], status_board["rows"])
        self.assertEqual(
            health_response.json()["dependencies"]["profitability_proof_floor"][
                "detail"
            ],
            "repair_only",
        )
        status_ledger = status_response.json()["capital_reentry_cohort_ledger"]
        health_ledger = health_response.json()["capital_reentry_cohort_ledger"]
        self.assertEqual(
            status_ledger["schema_version"],
            "torghut.capital-reentry-cohort-ledger.v1",
        )
        self.assertEqual(status_ledger["aggregate_state"], "repair")
        self.assertEqual(status_ledger["summary"]["zero_notional_cohort_count"], 5)
        self.assertEqual(
            health_ledger["schema_version"], status_ledger["schema_version"]
        )
        self.assertTrue(
            str(health_ledger["consumer_evidence_receipt_id"]).startswith(
                "torghut-consumer-evidence:"
            )
        )
        status_profit_repair = status_response.json()["profit_repair_settlement_ledger"]
        health_profit_repair = health_response.json()["profit_repair_settlement_ledger"]
        self.assertEqual(
            status_profit_repair["schema_version"],
            "torghut.profit-repair-settlement-ledger.v1",
        )
        self.assertEqual(status_profit_repair["summary"]["zero_notional_lot_count"], 7)
        self.assertEqual(
            health_profit_repair["schema_version"],
            status_profit_repair["schema_version"],
        )
        status_routeability = status_response.json()[
            "routeability_repair_acceptance_ledger"
        ]
        health_routeability = health_response.json()[
            "routeability_repair_acceptance_ledger"
        ]
        self.assertEqual(
            status_routeability["schema_version"],
            "torghut.routeability-repair-acceptance-ledger.v1",
        )
        self.assertEqual(status_routeability["accepted_routeable_candidate_count"], 0)
        self.assertEqual(status_routeability["summary"]["zero_notional_lot_count"], 7)
        self.assertEqual(
            health_routeability["schema_version"],
            status_routeability["schema_version"],
        )
        status_arbiter = status_response.json()["evidence_clock_arbiter"]
        health_arbiter = health_response.json()["evidence_clock_arbiter"]
        self.assertEqual(
            status_arbiter["schema_version"],
            "torghut.evidence-clock-arbiter.v1",
        )
        self.assertEqual(status_arbiter["routeable_candidate_count"], 0)
        self.assertIn(
            "capital_gate",
            {clock["name"] for clock in status_arbiter["clocks"]},
        )
        self.assertEqual(
            health_arbiter["schema_version"], status_arbiter["schema_version"]
        )
        status_exchange = status_response.json()["routeable_profit_candidate_exchange"]
        health_exchange = health_response.json()["routeable_profit_candidate_exchange"]
        self.assertEqual(
            status_exchange["schema_version"],
            "torghut.routeable-profit-candidate-exchange.v1",
        )
        self.assertEqual(status_exchange["summary"]["routeable_candidate_count"], 0)
        self.assertEqual(
            health_exchange["schema_version"], status_exchange["schema_version"]
        )
        status_settlement = status_response.json()["clock_settlement_receipt"]
        health_settlement = health_response.json()["clock_settlement_receipt"]
        self.assertEqual(
            status_settlement["schema_version"],
            "torghut.clock-settlement-receipt.v1",
        )
        self.assertEqual(status_settlement["routeable_candidate_count"], 0)
        self.assertEqual(status_settlement["max_notional"], "0")
        self.assertEqual(
            health_settlement["schema_version"],
            status_settlement["schema_version"],
        )
        status_clearinghouse = status_response.json()[
            "route_evidence_clearinghouse_packet"
        ]
        health_clearinghouse = health_response.json()[
            "route_evidence_clearinghouse_packet"
        ]
        self.assertEqual(
            status_clearinghouse["schema_version"],
            "torghut.route-evidence-clearinghouse-packet.v1",
        )
        self.assertEqual(status_clearinghouse["accepted_routeable_candidate_count"], 0)
        self.assertEqual(status_clearinghouse["max_notional"], "0")
        self.assertEqual(
            health_clearinghouse["schema_version"],
            status_clearinghouse["schema_version"],
        )
        status_repair_bid_settlement = status_response.json()[
            "repair_bid_settlement_ledger"
        ]
        health_repair_bid_settlement = health_response.json()[
            "repair_bid_settlement_ledger"
        ]
        self.assertEqual(
            status_repair_bid_settlement["schema_version"],
            "torghut.repair-bid-settlement-ledger.v1",
        )
        self.assertEqual(status_repair_bid_settlement["routeable_candidate_count"], 0)
        self.assertEqual(status_repair_bid_settlement["max_notional"], "0")
        self.assertLessEqual(
            len(status_repair_bid_settlement["dispatchable_lot_ids"]),
            status_repair_bid_settlement["summary"]["max_dispatchable_lots"],
        )
        self.assertEqual(
            health_repair_bid_settlement["schema_version"],
            status_repair_bid_settlement["schema_version"],
        )
        status_warrant = status_response.json()["route_warrant_exchange"]
        health_warrant = health_response.json()["route_warrant_exchange"]
        self.assertEqual(
            status_warrant["schema_version"],
            "torghut.route-warrant-exchange.v1",
        )
        self.assertEqual(status_warrant["accepted_routeable_candidate_count"], 0)
        self.assertEqual(status_warrant["max_notional"], "0")
        self.assertEqual(
            health_warrant["schema_version"],
            status_warrant["schema_version"],
        )
        status_source_serving = status_response.json()[
            "source_serving_repair_receipt_ledger"
        ]
        health_source_serving = health_response.json()[
            "source_serving_repair_receipt_ledger"
        ]
        self.assertEqual(
            status_source_serving["schema_version"],
            "torghut.source-serving-repair-receipt-ledger.v1",
        )
        self.assertEqual(status_source_serving["max_notional"], "0")
        self.assertEqual(
            status_source_serving["route_warrant_ref"],
            status_warrant["warrant_id"],
        )
        self.assertEqual(
            health_source_serving["schema_version"],
            status_source_serving["schema_version"],
        )
        status_freshness_carry = status_response.json()["freshness_carry_ledger"]
        health_freshness_carry = health_response.json()["freshness_carry_ledger"]
        self.assertEqual(
            status_freshness_carry["schema_version"],
            "torghut.freshness-carry-ledger.v1",
        )
        self.assertEqual(
            status_freshness_carry["capital_posture"]["max_notional"],
            "0",
        )
        self.assertIn("dimensions", status_freshness_carry)
        self.assertIn("repair_proof_slos", status_freshness_carry)
        self.assertEqual(
            health_freshness_carry["schema_version"],
            status_freshness_carry["schema_version"],
        )
        status_repair_receipt_frontier = status_response.json()[
            "repair_receipt_frontier"
        ]
        health_repair_receipt_frontier = health_response.json()[
            "repair_receipt_frontier"
        ]
        self.assertEqual(
            status_repair_receipt_frontier["schema_version"],
            "torghut.repair-receipt-frontier.v1",
        )
        self.assertEqual(status_repair_receipt_frontier["max_notional"], "0")
        self.assertEqual(
            status_repair_receipt_frontier["source_serving_ledger_ref"],
            status_source_serving["ledger_id"],
        )
        self.assertEqual(
            health_repair_receipt_frontier["schema_version"],
            status_repair_receipt_frontier["schema_version"],
        )
        status_repair_outcome = status_response.json()["repair_outcome_dividend_ledger"]
        health_repair_outcome = health_response.json()["repair_outcome_dividend_ledger"]
        self.assertEqual(
            status_repair_outcome["schema_version"],
            "torghut.repair-outcome-dividend-ledger.v1",
        )
        self.assertEqual(status_repair_outcome["max_notional"], "0")
        self.assertFalse(status_repair_outcome["live_submit_enabled"])
        self.assertEqual(
            status_repair_outcome["source_repair_bid_settlement_ledger_id"],
            status_repair_bid_settlement["ledger_id"],
        )
        self.assertEqual(
            status_repair_outcome["repair_receipt_frontier_ref"],
            status_repair_receipt_frontier["frontier_id"],
        )
        self.assertEqual(
            health_repair_outcome["schema_version"],
            status_repair_outcome["schema_version"],
        )
        status_frontier = status_response.json()["profit_freshness_frontier"]
        health_frontier = health_response.json()["profit_freshness_frontier"]
        self.assertEqual(
            status_frontier["schema_version"],
            "torghut.profit-freshness-frontier.v1",
        )
        self.assertEqual(
            status_frontier["capital_posture"]["paper_notional_limit"],
            "0",
        )
        self.assertEqual(
            status_frontier["capital_posture"]["live_notional_limit"],
            "0",
        )
        self.assertEqual(
            health_frontier["schema_version"],
            status_frontier["schema_version"],
        )

    def test_trading_status_and_health_include_renewal_bond_profit_escrow(
        self,
    ) -> None:
        escrow = {
            "schema_version": "torghut.renewal-bond-profit-escrow.v1",
            "receipt_id": "rbpe-test",
            "escrow_verdict": "repair_only",
            "capital_state": "zero_notional",
            "max_notional": "0",
            "selected_zero_notional_repairs": [
                {"code": "refresh_execution_tca_settlement"}
            ],
        }

        with patch(
            "app.api.proof_floor_payloads.proof_floor_receipts.build_renewal_bond_profit_escrow",
            return_value=escrow,
        ):
            status_response = self.client.get("/trading/status")
            health_response = self.client.get("/trading/health")

        self.assertEqual(status_response.status_code, 200)
        self.assertIn(health_response.status_code, {200, 503})
        self.assertEqual(status_response.json()["renewal_bond_profit_escrow"], escrow)
        self.assertEqual(health_response.json()["renewal_bond_profit_escrow"], escrow)

    def test_trading_status_health_and_autonomy_include_alpha_replay_projection(
        self,
    ) -> None:
        projection = {
            "capital_replay_board": {
                "schema_version": "torghut.capital-replay-board.v1",
                "board_id": "capital-replay:test",
                "summary": {"replay_item_count": 1},
                "replay_items": [{"max_notional": "0"}],
            },
            "executable_alpha_receipts": {
                "schema_version": "torghut.executable-alpha-receipts.v1",
                "summary": {"receipts_total": 1},
                "receipts": [{"graduation_state": "candidate"}],
            },
        }

        with (
            patch(
                "app.api.proof_floor_payloads.capital_and_repair_ledgers.build_capital_replay_projection",
                return_value=projection,
            ),
            patch(
                "app.api.proof_floor_payloads.build_autonomy_capital_replay_projection",
                return_value=projection,
            ),
        ):
            status_response = self.client.get("/trading/status")
            health_response = self.client.get("/trading/health")
            autonomy_response = self.client.get("/trading/autonomy")

        self.assertEqual(status_response.status_code, 200)
        self.assertIn(health_response.status_code, {200, 503})
        self.assertEqual(autonomy_response.status_code, 200)
        for response in (status_response, health_response, autonomy_response):
            payload = response.json()
            self.assertEqual(
                payload["capital_replay_board"],
                projection["capital_replay_board"],
            )
            self.assertEqual(
                payload["executable_alpha_receipts"],
                projection["executable_alpha_receipts"],
            )

    def test_trading_status_and_health_include_quality_adjusted_frontier(
        self,
    ) -> None:
        frontier = {
            "schema_version": "torghut.quality-adjusted-profit-frontier.v1",
            "frontier_id": "quality-frontier:test",
            "summary": {"packet_count": 1, "capital_ready": False},
            "packets": [{"repair_class": "quant", "max_notional": "0"}],
            "paper_probe_notional_limit": "0",
        }

        with patch(
            "app.api.proof_floor_payloads.build_jangar_reliability_settlement_ref.build_quality_adjusted_profit_frontier",
            return_value=frontier,
        ):
            status_response = self.client.get("/trading/status")
            health_response = self.client.get("/trading/health")

        self.assertEqual(status_response.status_code, 200)
        self.assertIn(health_response.status_code, {200, 503})
        self.assertEqual(
            status_response.json()["quality_adjusted_profit_frontier"],
            frontier,
        )
        self.assertEqual(
            health_response.json()["quality_adjusted_profit_frontier"],
            frontier,
        )

    def test_trading_status_and_health_include_profit_signal_quorum(self) -> None:
        quorum = {
            "schema_version": "torghut.profit-signal-quorum.v1",
            "quorum_set_id": "profit-signal-quorum-ledger:test",
            "aggregate_decision": "observe_only",
            "summary": {"quorum_count": 1, "zero_notional_quorum_count": 1},
            "quorums": [
                {
                    "quorum_id": "profit-signal-quorum:test",
                    "hypothesis_id": "H-CONT-01",
                    "decision": "observe_only",
                    "max_notional": "0",
                }
            ],
            "max_notional": "0",
        }

        with patch(
            "app.api.proof_floor_payloads.build_jangar_reliability_settlement_ref.build_profit_signal_quorum",
            return_value=quorum,
        ):
            status_response = self.client.get("/trading/status")
            health_response = self.client.get("/trading/health")

        self.assertEqual(status_response.status_code, 200)
        self.assertIn(health_response.status_code, {200, 503})
        self.assertEqual(status_response.json()["profit_signal_quorum"], quorum)
        self.assertEqual(health_response.json()["profit_signal_quorum"], quorum)
