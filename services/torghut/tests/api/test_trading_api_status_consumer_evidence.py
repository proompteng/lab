from __future__ import annotations

from tests.api.trading_api_support import (
    JangarDependencyQuorumStatus,
    Session,
    Strategy,
    TradeDecision,
    TradingApiTestCaseBase,
    _route_continuity_packet_for_proof_floor,
    datetime,
    patch,
    select,
    timedelta,
    timezone,
)


class TestTradingApiStatusConsumerEvidence(TradingApiTestCaseBase):
    def test_trading_executions_endpoint(self) -> None:
        response = self.client.get("/trading/executions?symbol=AAPL")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(len(payload), 1)
        self.assertEqual(payload[0]["symbol"], "AAPL")
        self.assertEqual(payload[0]["execution_correlation_id"], "corr-1")
        self.assertEqual(payload[0]["execution_idempotency_key"], "idem-1")
        self.assertIsNotNone(payload[0]["tca"])
        self.assertEqual(payload[0]["tca"]["slippage_bps"], 100.0)

    def test_trading_tca_endpoint(self) -> None:
        response = self.client.get("/trading/tca?symbol=AAPL")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["summary"]["order_count"], 1)
        self.assertEqual(payload["summary"]["expected_shortfall_sample_count"], 1)
        self.assertAlmostEqual(
            float(payload["summary"]["expected_shortfall_coverage"]), 1.0
        )
        self.assertEqual(len(payload["rows"]), 1)
        self.assertEqual(payload["rows"][0]["symbol"], "AAPL")

    def test_trading_status_includes_tca_calibration_summary(self) -> None:
        response = self.client.get("/trading/status")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        tca_summary = payload["tca"]
        self.assertEqual(tca_summary["order_count"], 1)
        self.assertEqual(tca_summary["expected_shortfall_sample_count"], 1)
        self.assertEqual(float(tca_summary["expected_shortfall_coverage"]), 1.0)
        self.assertEqual(float(tca_summary["avg_expected_shortfall_bps_p50"]), 3.5)
        self.assertEqual(float(tca_summary["avg_expected_shortfall_bps_p95"]), 5.0)
        self.assertEqual(float(tca_summary["avg_realized_shortfall_bps"]), 1.2)
        self.assertEqual(float(tca_summary["avg_divergence_bps"]), 0.7)
        submission_authority = payload["submission_authority"]
        self.assertEqual(
            submission_authority["schema_version"],
            "torghut.submission-authority.v1",
        )
        self.assertIn(
            submission_authority["effective_submit_mode"],
            {
                "blocked",
                "bounded_live_paper_collection",
                "bounded_live_paper_collection_waiting_for_session",
                "capital_promotion",
            },
        )
        self.assertIn("capital_promotion_gate", submission_authority)
        self.assertIn("bounded_collection_gate", submission_authority)

    def test_trading_status_reports_latest_persisted_decision_timestamp(self) -> None:
        with self.session_local() as session:
            strategy = session.execute(select(Strategy)).scalars().first()
            assert strategy is not None
            latest_created_at = datetime.now(timezone.utc) + timedelta(minutes=5)
            session.add(
                TradeDecision(
                    strategy_id=strategy.id,
                    alpaca_account_label="paper",
                    symbol="MSFT",
                    timeframe="5Min",
                    decision_json={"action": "sell", "qty": "2"},
                    rationale="latest",
                    status="planned",
                    created_at=latest_created_at,
                )
            )
            session.commit()

        response = self.client.get("/trading/status")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(
            datetime.fromisoformat(payload["last_decision_at"]),
            latest_created_at,
        )

    def test_trading_status_does_not_fetch_jangar_dependency_for_self_governed_registry(
        self,
    ) -> None:
        call_order: list[str] = []

        def _load_llm_evaluation(_session: Session) -> dict[str, object]:
            call_order.append("llm_evaluation")
            return {"ok": True, "metrics": {"total_reviews": 1}}

        def _load_tca(_session: Session, **_kwargs: object) -> dict[str, object]:
            call_order.append("tca")
            return {}

        with (
            patch(
                "app.trading.hypotheses.runtime_ledger_row_rank.urlopen"
            ) as jangar_status_fetch,
            patch(
                "app.api.status_helpers._load_llm_evaluation",
                side_effect=_load_llm_evaluation,
            ),
            patch("app.api.status_helpers._load_tca_summary", side_effect=_load_tca),
            patch("app.api.trading_status.SessionLocal", self.session_local),
        ):
            response = self.client.get("/trading/status")

        self.assertEqual(response.status_code, 200)
        self.assertIn("llm_evaluation", call_order)
        self.assertIn("tca", call_order)
        jangar_status_fetch.assert_not_called()

    def test_revenue_repair_hydrates_jangar_verify_foreclosure_board(self) -> None:
        board = {
            "schema_version": "jangar.verify-trust-foreclosure-board.v1",
            "board_id": "verify-trust-foreclosure-board:agents:test",
            "fresh_until": "2026-05-14T16:30:00Z",
            "execution_trust_status": "degraded",
            "source_rollout_truth_state": "converged",
            "foreclosure_tickets": [
                {
                    "ticket_id": "verify-trust-foreclosure-ticket:test",
                    "state": "open",
                    "required_output_receipt": (
                        "jangar.verify-trust-foreclosure-ticket.v1"
                    ),
                }
            ],
        }

        def _build_digest(
            *,
            readyz_payload: dict[str, object],
            status_payload: dict[str, object],
        ) -> dict[str, object]:
            self.assertEqual(readyz_payload["status"], "degraded")
            return {
                "schema_version": "torghut.revenue-repair-digest.v1",
                "verify_trust_foreclosure_board": status_payload.get(
                    "verify_trust_foreclosure_board"
                ),
            }

        with (
            patch(
                "app.api.maintenance._evaluate_trading_health_payload",
                return_value=({"status": "degraded"}, 503),
            ),
            patch(
                "app.api.maintenance.trading_status",
                return_value={
                    "mode": "live",
                    "pipeline_mode": "simple",
                    "build": {"commit": "source-sha"},
                },
            ),
            patch(
                "app.api.maintenance._load_jangar_verify_trust_foreclosure_board",
                return_value=board,
            ),
            patch(
                "app.api.maintenance.build_revenue_repair_digest",
                side_effect=_build_digest,
            ),
        ):
            response = self.client.get("/trading/revenue-repair")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["verify_trust_foreclosure_board"], board)

    def test_revenue_repair_hydrates_jangar_repair_slot_carry(self) -> None:
        board = {
            "schema_version": "jangar.verify-trust-foreclosure-board.v1",
            "board_id": "verify-trust-foreclosure-board:agents:test",
            "fresh_until": "2026-05-14T16:30:00Z",
        }
        settlement = {
            "schema_version": "jangar.controller-ingestion-settlement.v1",
            "settlement_id": "controller-ingestion-settlement:agents:test",
            "decision": "hold",
            "agentrun_ingestion_current": False,
        }
        repair_slot_escrow = {
            "schema_version": "jangar.repair-slot-escrow.v1",
            "escrow_id": "repair-slot-escrow:test",
            "status": "block",
            "reason_codes": ["selected_receipt_source_revenue_repair_ref_mismatch"],
        }
        rollout_witness = {
            "schema_version": "jangar.foreclosure-carry-rollout-witness.v1",
            "witness_id": "foreclosure-carry-rollout-witness:test",
        }
        dependency_quorum = {
            "decision": "block",
            "reasons": ["empirical_jobs_degraded"],
            "message": "blocked",
            "controller_ingestion_settlement": settlement,
            "verify_trust_foreclosure_board": board,
            "repair_slot_escrow": repair_slot_escrow,
            "foreclosure_carry_rollout_witness": rollout_witness,
        }

        def _build_digest(
            *,
            readyz_payload: dict[str, object],
            status_payload: dict[str, object],
        ) -> dict[str, object]:
            self.assertEqual(readyz_payload["status"], "degraded")
            self.assertEqual(status_payload["dependency_quorum"], dependency_quorum)
            self.assertEqual(
                status_payload["controller_ingestion_settlement"],
                settlement,
            )
            self.assertEqual(status_payload["repair_slot_escrow"], repair_slot_escrow)
            self.assertEqual(
                status_payload["foreclosure_carry_rollout_witness"],
                rollout_witness,
            )
            return {
                "schema_version": "torghut.revenue-repair-digest.v1",
                "repair_slot_escrow": status_payload.get("repair_slot_escrow"),
            }

        with (
            patch(
                "app.api.maintenance._evaluate_trading_health_payload",
                return_value=({"status": "degraded"}, 503),
            ),
            patch(
                "app.api.maintenance.trading_status",
                return_value={
                    "mode": "live",
                    "pipeline_mode": "simple",
                    "build": {"commit": "source-sha"},
                },
            ),
            patch(
                "app.api.maintenance._load_jangar_dependency_quorum_payload",
                return_value=dependency_quorum,
            ),
            patch(
                "app.api.maintenance.build_revenue_repair_digest",
                side_effect=_build_digest,
            ),
        ):
            response = self.client.get("/trading/revenue-repair")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["repair_slot_escrow"], repair_slot_escrow)

    def test_trading_consumer_evidence_avoids_recursive_jangar_status_fetch(
        self,
    ) -> None:
        proof_floor = {
            "schema_version": "torghut.profitability-proof-floor.v1",
            "generated_at": "2026-05-08T03:54:41.769374+00:00",
            "account_label": "PA3SX7FYNUTF",
            "route_state": "repair_only",
            "capital_state": "zero_notional",
            "max_notional": "0",
            "blocking_reasons": ["simple_submit_disabled"],
            "proof_dimensions": [],
            "repair_ladder": [],
        }
        live_submission_gate = {
            "allowed": False,
            "reason": "simple_submit_disabled",
            "blocked_reasons": ["simple_submit_disabled"],
            "capital_stage": "shadow",
            "dependency_quorum_decision": "allow",
        }

        with (
            patch(
                "app.api.trading_misc.shared_context.resolve_hypothesis_dependency_quorum"
            ) as dependency_fetch,
            patch(
                "app.api.trading_misc.shared_context.load_jangar_route_continuity_packet"
            ) as continuity_fetch,
            patch(
                "app.api.trading_status._forecast_service_status",
                return_value={
                    "status": "healthy",
                    "authority": "empirical",
                    "promotion_authority_eligible_models": ["candidate-a"],
                },
            ),
            patch(
                "app.api.trading_status._lean_authority_status",
                return_value={"status": "healthy", "authority": "empirical"},
            ),
            patch(
                "app.api.trading_status._empirical_jobs_status",
                return_value={
                    "status": "healthy",
                    "ready": True,
                    "candidate_ids": ["candidate-a"],
                    "dataset_snapshot_refs": ["dataset-a"],
                },
            ),
            patch(
                "app.api.trading_status.load_quant_evidence_status",
                return_value={"ok": True, "required": False},
            ),
            patch("app.api.health_checks._load_tca_summary", return_value={}),
            patch(
                "app.api.trading_status._build_live_submission_gate_payload",
                return_value=live_submission_gate,
            ),
            patch(
                "app.api.proof_floor_payloads.shared_context.build_profitability_proof_floor_receipt",
                return_value=proof_floor,
            ),
            patch(
                "app.api.readiness_helpers.readiness_dependency_snapshot",
                return_value=(
                    {
                        "database": {
                            "ok": True,
                            "schema_current": True,
                            "schema_current_heads": ["0029_live_submission_gate"],
                        }
                    },
                    datetime(2026, 5, 8, 3, 54, 41, tzinfo=timezone.utc),
                    True,
                ),
            ) as readiness_snapshot,
            patch("app.api.trading_status.SessionLocal", self.session_local),
        ):
            response = self.client.get("/trading/consumer-evidence")
            summary_response = self.client.get(
                "/trading/consumer-evidence?view=summary"
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(summary_response.status_code, 200)
        self.assertTrue(
            readiness_snapshot.call_args.kwargs["include_database_contract"]
        )
        self.assertTrue(
            readiness_snapshot.call_args.kwargs["allow_stale_dependency_cache"]
        )
        payload = response.json()
        self.assertEqual(
            payload["schema_version"], "torghut.consumer-evidence-status.v1"
        )
        self.assertEqual(payload["control_plane_dependency_mode"], "caller_evaluated")
        self.assertEqual(payload["dependency_quorum"]["decision"], "allow")
        self.assertEqual(payload["proof_floor"], proof_floor)
        self.assertEqual(
            payload["revenue_repair_digest_ref"], "/trading/revenue-repair"
        )
        self.assertEqual(
            payload["top_repair_queue_item"]["code"], "live_submit_gate_closed"
        )
        self.assertEqual(payload["selected_value_gate"], "capital_gate_safety")
        self.assertEqual(payload["max_notional"], "0")
        self.assertEqual(payload["accepted_routeable_candidate_count"], 0)
        self.assertEqual(payload["routeable_candidate_delta"], 0)
        self.assertNotIn("route_reacquisition_board", payload)
        summary_payload = summary_response.json()
        self.assertEqual(summary_payload["schema_version"], payload["schema_version"])
        self.assertEqual(summary_payload["view"], "summary")
        self.assertEqual(
            summary_payload["control_plane_dependency_mode"], "caller_evaluated"
        )
        self.assertEqual(summary_payload["dependency_quorum"]["decision"], "allow")
        self.assertEqual(summary_payload["proof_floor"], proof_floor)
        self.assertIn("torghut_consumer_evidence_receipt", summary_payload)
        self.assertIn("route_proven_profit_receipt", summary_payload)
        self.assertNotIn("route_reacquisition_board", summary_payload)
        self.assertNotIn("capital_reentry_cohort_ledger", summary_payload)
        self.assertNotIn("profit_carry_passport_ledger", summary_payload)
        receipt = payload["torghut_consumer_evidence_receipt"]
        self.assertEqual(
            receipt["schema_version"],
            "torghut.consumer-evidence-receipt.v1",
        )
        self.assertEqual(receipt["paper_readiness_state"], "blocked")
        self.assertIn("simple_submit_disabled", receipt["reason_codes"])
        route_proven_receipt = payload["route_proven_profit_receipt"]
        self.assertEqual(
            route_proven_receipt["schema_version"],
            "torghut.route-proven-profit-receipt.v1",
        )
        self.assertEqual(route_proven_receipt["decision"], "repair")
        self.assertEqual(route_proven_receipt["capital_state"], "zero_notional")
        self.assertEqual(
            route_proven_receipt["consumer_evidence_receipt_id"],
            receipt["receipt_id"],
        )
        self.assertEqual(
            payload["consumer_evidence_canary"],
            route_proven_receipt["route_canary"],
        )
        self.assertEqual(
            payload["consumer_evidence_canary"]["expected_schema"],
            "torghut.consumer-evidence-status.v1",
        )
        ledger = payload["capital_reentry_cohort_ledger"]
        self.assertEqual(
            ledger["schema_version"],
            "torghut.capital-reentry-cohort-ledger.v1",
        )
        self.assertEqual(
            ledger["consumer_evidence_receipt_id"],
            receipt["receipt_id"],
        )
        self.assertEqual(ledger["summary"]["zero_notional_cohort_count"], 5)
        profit_repair = payload["profit_repair_settlement_ledger"]
        self.assertEqual(
            profit_repair["schema_version"],
            "torghut.profit-repair-settlement-ledger.v1",
        )
        self.assertEqual(
            profit_repair["consumer_evidence_receipt_id"],
            receipt["receipt_id"],
        )
        self.assertEqual(profit_repair["summary"]["zero_notional_lot_count"], 7)
        routeability = payload["routeability_repair_acceptance_ledger"]
        self.assertEqual(
            routeability["schema_version"],
            "torghut.routeability-repair-acceptance-ledger.v1",
        )
        self.assertEqual(routeability["summary"]["zero_notional_lot_count"], 7)
        self.assertEqual(routeability["accepted_routeable_candidate_count"], 0)
        clearinghouse = payload["route_evidence_clearinghouse_packet"]
        self.assertEqual(
            clearinghouse["schema_version"],
            "torghut.route-evidence-clearinghouse-packet.v1",
        )
        self.assertEqual(clearinghouse["accepted_routeable_candidate_count"], 0)
        self.assertEqual(clearinghouse["max_notional"], "0")
        repair_bid_settlement = payload["repair_bid_settlement_ledger"]
        self.assertEqual(
            repair_bid_settlement["schema_version"],
            "torghut.repair-bid-settlement-ledger.v1",
        )
        self.assertEqual(repair_bid_settlement["routeable_candidate_count"], 0)
        self.assertEqual(repair_bid_settlement["max_notional"], "0")
        self.assertLessEqual(
            len(repair_bid_settlement["selected_lot_ids"]),
            repair_bid_settlement["summary"]["max_selected_lots"],
        )
        executable_alpha_repair = payload["executable_alpha_repair_receipts"]
        self.assertEqual(
            executable_alpha_repair["schema_version"],
            "torghut.executable-alpha-repair-receipts.v1",
        )
        self.assertEqual(executable_alpha_repair["status"], "inactive")
        self.assertEqual(executable_alpha_repair["max_notional"], "0")
        executable_alpha_settlement = payload["executable_alpha_settlement_slots"]
        self.assertEqual(
            executable_alpha_settlement["schema_version"],
            "torghut.executable-alpha-settlement-slots-ref.v1",
        )
        self.assertEqual(executable_alpha_settlement["status"], "blocked")
        self.assertEqual(executable_alpha_settlement["max_notional"], "0")
        alpha_repair_closure = payload["alpha_repair_closure_board"]
        self.assertEqual(
            alpha_repair_closure["schema_version"],
            "torghut.alpha-repair-closure-board-ref.v1",
        )
        self.assertEqual(alpha_repair_closure["status"], "inactive")
        self.assertEqual(alpha_repair_closure["max_notional"], "0")
        self.assertNotIn("db_check_not_provided", alpha_repair_closure["reason_codes"])
        alpha_foundry = payload["alpha_evidence_foundry"]
        self.assertEqual(
            alpha_foundry["schema_version"],
            "torghut.alpha-evidence-foundry-ref.v1",
        )
        self.assertEqual(alpha_foundry["status"], "inactive")
        self.assertEqual(alpha_foundry["max_notional"], "0")
        settlement_conveyor = payload["alpha_readiness_settlement_conveyor"]
        self.assertEqual(
            settlement_conveyor["schema_version"],
            "torghut.alpha-readiness-settlement-conveyor-ref.v1",
        )
        self.assertEqual(settlement_conveyor["status"], "observing")
        self.assertEqual(settlement_conveyor["max_notional"], "0")
        alpha_dividend = payload["alpha_repair_dividend_ledger"]
        self.assertEqual(
            alpha_dividend["schema_version"],
            "torghut.alpha-repair-dividend-ledger-ref.v1",
        )
        self.assertEqual(alpha_dividend["max_notional"], "0")
        self.assertEqual(
            alpha_dividend["required_recorder_schema"],
            "jangar.material-action-custody-flight-recorder.v1",
        )
        alpha_closure_slo = payload["alpha_closure_dividend_slo"]
        self.assertEqual(
            alpha_closure_slo["schema_version"],
            "torghut.alpha-closure-dividend-slo.v1",
        )
        self.assertEqual(alpha_closure_slo["max_notional"], "0")
        self.assertEqual(alpha_closure_slo["capital_rule"], "zero_notional_repair_only")
        self.assertEqual(alpha_closure_slo["enforcement_mode"], "observe")
        controller_carry = payload["jangar_controller_ingestion_carry"]
        self.assertEqual(
            controller_carry["schema_version"],
            "torghut.jangar-controller-ingestion-carry-ref.v1",
        )
        self.assertEqual(controller_carry["carry_state"], "unavailable")
        self.assertEqual(controller_carry["max_notional"], "0")
        no_delta_auction = payload["no_delta_repair_reentry_auction"]
        self.assertEqual(
            no_delta_auction["schema_version"],
            "torghut.no-delta-repair-reentry-auction-ref.v1",
        )
        self.assertEqual(
            no_delta_auction["jangar_controller_ingestion_carry_state"],
            "unavailable",
        )
        self.assertIn(
            no_delta_auction["reentry_decision"],
            {"deny", "hold"},
        )
        self.assertEqual(no_delta_auction["max_notional"], "0")
        warrant = payload["route_warrant_exchange"]
        self.assertEqual(
            warrant["schema_version"],
            "torghut.route-warrant-exchange.v1",
        )
        self.assertEqual(warrant["accepted_routeable_candidate_count"], 0)
        self.assertEqual(warrant["max_notional"], "0")
        source_serving = payload["source_serving_repair_receipt_ledger"]
        self.assertEqual(
            source_serving["schema_version"],
            "torghut.source-serving-repair-receipt-ledger.v1",
        )
        self.assertEqual(source_serving["max_notional"], "0")
        self.assertIn(
            source_serving["source_serving_state"],
            {
                "converged",
                "digest_unknown",
                "contract_missing",
                "source_ahead",
                "unknown",
            },
        )
        self.assertEqual(
            source_serving["route_warrant_ref"],
            warrant["warrant_id"],
        )
        freshness_carry = payload["freshness_carry_ledger"]
        self.assertEqual(
            freshness_carry["schema_version"],
            "torghut.freshness-carry-ledger.v1",
        )
        self.assertEqual(freshness_carry["capital_posture"]["max_notional"], "0")
        self.assertIn("dimensions", freshness_carry)
        self.assertIn("repair_proof_slos", freshness_carry)
        self.assertEqual(
            freshness_carry["source_serving_ledger_ref"],
            source_serving["ledger_id"],
        )
        self.assertEqual(
            freshness_carry["route_warrant_ref"],
            warrant["warrant_id"],
        )
        repair_receipt_frontier = payload["repair_receipt_frontier"]
        self.assertEqual(
            repair_receipt_frontier["schema_version"],
            "torghut.repair-receipt-frontier.v1",
        )
        self.assertEqual(repair_receipt_frontier["max_notional"], "0")
        self.assertEqual(
            repair_receipt_frontier["source_serving_ledger_ref"],
            source_serving["ledger_id"],
        )
        self.assertEqual(
            repair_receipt_frontier["freshness_carry_ledger_ref"],
            freshness_carry["ledger_id"],
        )
        self.assertIn(
            repair_receipt_frontier["frontier_state"],
            {"repair_only", "paper_blocked", "paper_candidate", "live_candidate"},
        )
        repair_outcome = payload["repair_outcome_dividend_ledger"]
        self.assertEqual(
            repair_outcome["schema_version"],
            "torghut.repair-outcome-dividend-ledger.v1",
        )
        self.assertEqual(repair_outcome["max_notional"], "0")
        self.assertFalse(repair_outcome["live_submit_enabled"])
        self.assertEqual(
            repair_outcome["source_repair_bid_settlement_ledger_id"],
            repair_bid_settlement["ledger_id"],
        )
        self.assertEqual(
            repair_outcome["repair_receipt_frontier_ref"],
            repair_receipt_frontier["frontier_id"],
        )
        self.assertEqual(
            repair_outcome["summary"]["repair_receipt_binding_count"],
            len(repair_outcome["outcome_receipts"]),
        )
        self.assertEqual(
            repair_outcome["summary"]["open_escrow_count"],
            len(repair_outcome["open_escrows"]),
        )
        self.assertEqual(
            {
                receipt["repair_lot_id"]
                for receipt in repair_outcome["outcome_receipts"]
            },
            set(repair_bid_settlement["dispatchable_lot_ids"]),
        )
        self.assertTrue(
            all(
                escrow["max_notional"] == "0"
                for escrow in repair_outcome["open_escrows"]
            )
        )
        self.assertEqual(
            repair_outcome["summary"]["routeable_candidate_count"],
            0,
        )
        profit_carry = payload["profit_carry_passport_ledger"]
        self.assertEqual(
            profit_carry["schema_version"],
            "torghut.profit-carry-passport-ledger.v1",
        )
        self.assertEqual(profit_carry["max_notional"], "0")
        self.assertFalse(profit_carry["live_submit_enabled"])
        self.assertEqual(
            profit_carry["source_refs"]["repair_outcome_dividend_ledger_ref"],
            repair_outcome["ledger_id"],
        )
        self.assertEqual(
            profit_carry["action_class_decisions"]["paper_canary"], "blocked"
        )
        self.assertEqual(
            profit_carry["action_class_decisions"]["live_micro_canary"], "blocked"
        )
        self.assertTrue(
            all(
                passport["max_notional"] == "0"
                for passport in profit_carry["profit_carry_passports"]
            )
        )
        frontier = payload["profit_freshness_frontier"]
        self.assertEqual(
            frontier["schema_version"],
            "torghut.profit-freshness-frontier.v1",
        )
        self.assertEqual(frontier["capital_posture"]["paper_notional_limit"], "0")
        self.assertEqual(frontier["capital_posture"]["live_notional_limit"], "0")
        arbiter = payload["evidence_clock_arbiter"]
        self.assertEqual(
            arbiter["schema_version"],
            "torghut.evidence-clock-arbiter.v1",
        )
        self.assertEqual(arbiter["routeable_candidate_count"], 0)
        self.assertEqual(arbiter["max_notional"], "0")
        exchange = payload["routeable_profit_candidate_exchange"]
        self.assertEqual(
            exchange["schema_version"],
            "torghut.routeable-profit-candidate-exchange.v1",
        )
        self.assertEqual(exchange["summary"]["routeable_candidate_count"], 0)
        self.assertEqual(exchange["capital_safety_ref"]["max_notional"], "0")
        settlement = payload["clock_settlement_receipt"]
        self.assertEqual(
            settlement["schema_version"],
            "torghut.clock-settlement-receipt.v1",
        )
        self.assertEqual(settlement["routeable_candidate_count"], 0)
        self.assertEqual(settlement["max_notional"], "0")
        self.assertIn(
            "selected_repair_packet_ids",
            settlement["summary"],
        )
        dependency_fetch.assert_not_called()
        continuity_fetch.assert_not_called()

    def test_trading_consumer_evidence_hydrates_jangar_carry_non_recursively(
        self,
    ) -> None:
        settlement = {
            "settlement_id": "controller-ingestion-settlement:current",
            "decision": "allow",
            "controller_ingestion_current": True,
            "fresh_until": "2099-05-14T15:45:00+00:00",
        }
        board = {
            "board_id": "verify-trust-foreclosure-board:current",
            "fresh_until": "2099-05-14T15:45:00+00:00",
        }
        proof_floor = {
            "schema_version": "torghut.profitability-proof-floor.v1",
            "generated_at": "2026-05-08T03:54:41.769374+00:00",
            "account_label": "PA3SX7FYNUTF",
            "route_state": "repair_only",
            "capital_state": "zero_notional",
            "max_notional": "0",
            "blocking_reasons": ["simple_submit_disabled"],
            "proof_dimensions": [],
            "repair_ladder": [],
        }
        live_submission_gate = {
            "allowed": False,
            "reason": "simple_submit_disabled",
            "blocked_reasons": ["simple_submit_disabled"],
            "capital_stage": "shadow",
            "dependency_quorum_decision": "allow",
        }

        with (
            patch(
                "app.api.trading_misc.shared_context.resolve_hypothesis_dependency_quorum"
            ) as dependency_fetch,
            patch(
                "app.api.trading_misc.shared_context.load_jangar_route_continuity_packet"
            ) as continuity_fetch,
            patch(
                "app.api.trading_misc.shared_context.load_jangar_dependency_quorum",
                return_value=JangarDependencyQuorumStatus(
                    decision="allow",
                    reasons=[],
                    message="ok",
                    controller_ingestion_settlement=settlement,
                    verify_trust_foreclosure_board=board,
                ),
            ) as jangar_fetch,
            patch(
                "app.api.trading_status._forecast_service_status",
                return_value={
                    "status": "healthy",
                    "authority": "empirical",
                    "promotion_authority_eligible_models": ["candidate-a"],
                },
            ),
            patch(
                "app.api.trading_status._lean_authority_status",
                return_value={"status": "healthy", "authority": "empirical"},
            ),
            patch(
                "app.api.trading_status._empirical_jobs_status",
                return_value={
                    "status": "healthy",
                    "ready": True,
                    "candidate_ids": ["candidate-a"],
                    "dataset_snapshot_refs": ["dataset-a"],
                },
            ),
            patch(
                "app.api.trading_status.load_quant_evidence_status",
                return_value={"ok": True, "required": False},
            ),
            patch("app.api.health_checks._load_tca_summary", return_value={}),
            patch(
                "app.api.trading_status._build_live_submission_gate_payload",
                return_value=live_submission_gate,
            ),
            patch(
                "app.api.proof_floor_payloads.shared_context.build_profitability_proof_floor_receipt",
                return_value=proof_floor,
            ),
            patch(
                "app.api.readiness_helpers.readiness_dependency_snapshot",
                return_value=(
                    {
                        "database": {
                            "ok": True,
                            "schema_current": True,
                            "schema_current_heads": ["0029_live_submission_gate"],
                        }
                    },
                    datetime(2026, 5, 8, 3, 54, 41, tzinfo=timezone.utc),
                    True,
                ),
            ),
            patch("app.api.trading_status.SessionLocal", self.session_local),
        ):
            response = self.client.get("/trading/consumer-evidence")

        self.assertEqual(response.status_code, 200)
        jangar_fetch.assert_called_once_with(omit_torghut_consumer_evidence=True)
        dependency_fetch.assert_not_called()
        continuity_fetch.assert_not_called()
        payload = response.json()
        self.assertEqual(
            payload["control_plane_dependency_mode"],
            "jangar_status_non_recursive",
        )
        self.assertEqual(
            payload["dependency_quorum"]["controller_ingestion_settlement"],
            settlement,
        )
        self.assertEqual(
            payload["dependency_quorum"]["verify_trust_foreclosure_board"],
            board,
        )
        controller_carry = payload["jangar_controller_ingestion_carry"]
        self.assertEqual(controller_carry["carry_state"], "current")
        self.assertEqual(
            controller_carry["source_jangar_settlement_ref"],
            "controller-ingestion-settlement:current",
        )
        self.assertNotIn(
            "jangar_controller_ingestion_settlement_missing",
            controller_carry["reason_codes"],
        )
        self.assertNotIn(
            "jangar_verify_foreclosure_board_missing",
            controller_carry["reason_codes"],
        )
        self.assertEqual(controller_carry["max_notional"], "0")

    def test_route_continuity_delegates_to_jangar_when_registry_requires_it(
        self,
    ) -> None:
        expected_packet = {
            "epoch_id": "jangar-epoch",
            "state": "present",
            "decision": "allow",
            "fresh_until": "2026-05-08T21:00:00+00:00",
            "blocking_reasons": [],
            "action_class": "paper_canary",
        }

        with (
            patch(
                "app.api.proof_floor_payloads.build_jangar_reliability_settlement_ref.hypothesis_registry_requires_dependency_capability",
                return_value=True,
            ) as requires_capability,
            patch(
                "app.api.proof_floor_payloads.build_jangar_reliability_settlement_ref.load_jangar_route_continuity_packet",
                return_value=expected_packet,
            ) as continuity_fetch,
        ):
            packet = _route_continuity_packet_for_proof_floor(
                {"generated_at": "2026-05-08T20:00:00+00:00"}
            )

        self.assertEqual(packet, expected_packet)
        requires_capability.assert_called_once()
        continuity_fetch.assert_called_once_with(action_class="paper_canary")
