from __future__ import annotations

# ruff: noqa: F403,F405
from tests.api.trading_api_support import *


class TestTradingApiRuntimeProfitability(TradingApiTestCaseBase):
    def test_trading_runtime_profitability_endpoint_happy_path(self) -> None:
        original_scheduler = getattr(app.state, "trading_scheduler", None)
        with self.session_local() as session:
            decision = session.execute(select(TradeDecision)).scalars().first()
            strategy = session.execute(select(Strategy)).scalars().first()
            self.assertIsNotNone(decision)
            self.assertIsNotNone(strategy)
            execution = Execution(
                trade_decision_id=decision.id if decision is not None else None,
                alpaca_order_id="order-2",
                client_order_id="client-2",
                symbol="AAPL",
                side="buy",
                order_type="limit",
                time_in_force="day",
                submitted_qty=Decimal("2"),
                filled_qty=Decimal("2"),
                avg_fill_price=Decimal("102"),
                status="filled",
                execution_expected_adapter="lean",
                execution_actual_adapter="alpaca_fallback",
                execution_fallback_reason="lean_submit_failed",
                execution_fallback_count=2,
                raw_order={},
                created_at=datetime.now(timezone.utc),
                last_update_at=datetime.now(timezone.utc),
            )
            session.add(execution)
            session.commit()
            session.refresh(execution)
            tca = ExecutionTCAMetric(
                execution_id=execution.id,
                trade_decision_id=decision.id if decision is not None else None,
                strategy_id=strategy.id if strategy is not None else None,
                alpaca_account_label="paper",
                symbol="AAPL",
                side="buy",
                arrival_price=Decimal("100"),
                avg_fill_price=Decimal("102"),
                filled_qty=Decimal("2"),
                signed_qty=Decimal("2"),
                slippage_bps=Decimal("200"),
                shortfall_notional=Decimal("2"),
                realized_shortfall_bps=Decimal("150"),
                churn_qty=Decimal("0"),
                churn_ratio=Decimal("0"),
                computed_at=datetime.now(timezone.utc),
            )
            session.add(tca)
            session.commit()

        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            gate_path = root / "gate-evaluation.json"
            rollback_path = root / "rollback-incident.json"
            gate_path.write_text(
                json.dumps(
                    {
                        "run_id": "run-demo",
                        "gates": [
                            {
                                "gate_id": "gate6_profitability_evidence",
                                "status": "pass",
                                "reasons": [],
                                "artifact_refs": [
                                    str(root / "profitability-evidence-v4.json")
                                ],
                            }
                        ],
                        "promotion_decision": {
                            "promotion_target": "paper",
                            "recommended_mode": "paper",
                            "promotion_allowed": True,
                            "reason_codes": [],
                            "promotion_gate_artifact": str(
                                root / "promotion-evidence-gate.json"
                            ),
                        },
                        "promotion_recommendation": {
                            "action": "promote",
                            "trace_id": "recommendation-trace-demo",
                        },
                        "provenance": {
                            "gate_report_trace_id": "gate-trace-demo",
                            "recommendation_trace_id": "recommendation-trace-demo",
                            "profitability_benchmark_artifact": str(
                                root / "profitability-benchmark-v4.json"
                            ),
                            "profitability_evidence_artifact": str(
                                root / "profitability-evidence-v4.json"
                            ),
                            "profitability_validation_artifact": str(
                                root / "profitability-evidence-validation.json"
                            ),
                        },
                    }
                ),
                encoding="utf-8",
            )
            actuation_path = root / "actuation-intent.json"
            actuation_path.write_text(
                json.dumps(
                    {
                        "schema_version": "torghut.autonomy.actuation-intent.v1",
                        "run_id": "run-demo",
                        "candidate_id": "candidate-demo",
                        "gates": {
                            "recommendation_trace_id": "act-rec-trace-demo",
                            "gate_report_trace_id": "act-gate-trace-demo",
                            "promotion_allowed": True,
                        },
                        "artifact_refs": [str(root / "profitability-evidence-v4.json")],
                        "audit": {
                            "rollback_readiness_readout": {
                                "kill_switch_dry_run_passed": True,
                                "gitops_revert_dry_run_passed": True,
                                "strategy_disable_dry_run_passed": False,
                                "human_approved": False,
                                "rollback_target": "rollback-target",
                                "dry_run_completed_at": "",
                            },
                            "rollback_evidence_missing_checks": [
                                "strategy_disable_dry_run_failed"
                            ],
                        },
                    }
                ),
                encoding="utf-8",
            )
            rollback_path.write_text(
                json.dumps(
                    {
                        "reasons": ["signal_lag_exceeded:900"],
                        "verification": {"incident_evidence_complete": True},
                    }
                ),
                encoding="utf-8",
            )

            try:
                scheduler = TradingScheduler()
                scheduler.state.last_autonomy_gates = str(gate_path)
                scheduler.state.rollback_incident_evidence_path = str(rollback_path)
                scheduler.state.rollback_incidents_total = 3
                scheduler.state.emergency_stop_active = True
                scheduler.state.emergency_stop_reason = "signal_lag_exceeded:900"
                scheduler.state.metrics.signal_continuity_promotion_block_total = 2
                scheduler.state.last_autonomy_actuation_intent = str(actuation_path)
                app.state.trading_scheduler = scheduler

                response = self.client.get("/trading/profitability/runtime")
                self.assertEqual(response.status_code, 200)
                payload = response.json()
                self.assertEqual(
                    payload["schema_version"], "torghut.runtime-profitability.v1"
                )
                self.assertEqual(payload["window"]["lookback_hours"], 72)
                self.assertEqual(payload["window"]["decision_count"], 1)
                self.assertEqual(payload["window"]["execution_count"], 2)
                self.assertEqual(
                    payload["executions"]["fallback_reason_totals"][
                        "lean_submit_failed"
                    ],
                    1,
                )
                self.assertEqual(
                    payload["realized_pnl_summary"]["shortfall_notional_total"], "3"
                )
                self.assertEqual(
                    payload["realized_pnl_summary"]["realized_pnl_proxy_notional"],
                    "-3",
                )
                self.assertEqual(
                    payload["gate_rollback_attribution"]["gate_report_trace_id"],
                    "act-gate-trace-demo",
                )
                self.assertTrue(
                    payload["gate_rollback_attribution"][
                        "gate6_profitability_evidence"
                    ]["status"]
                    == "pass"
                )
                self.assertEqual(
                    payload["gate_rollback_attribution"]["actuation_intent"][
                        "artifact_path"
                    ],
                    str(actuation_path),
                )
                self.assertFalse(
                    payload["gate_rollback_attribution"]["actuation_intent"][
                        "actuation_allowed"
                    ]
                )
                self.assertEqual(
                    payload["gate_rollback_attribution"]["actuation_intent"][
                        "rollback_readiness"
                    ]["missing_checks"],
                    ["strategy_disable_dry_run_failed"],
                )
            finally:
                if original_scheduler is None:
                    if hasattr(app.state, "trading_scheduler"):
                        del app.state.trading_scheduler
                else:
                    app.state.trading_scheduler = original_scheduler

    def test_trading_runtime_profitability_endpoint_empty_window(self) -> None:
        original_scheduler = getattr(app.state, "trading_scheduler", None)
        try:
            with self.session_local() as session:
                old_ts = datetime.now(timezone.utc) - timedelta(days=10)
                for decision in session.execute(select(TradeDecision)).scalars().all():
                    decision.created_at = old_ts
                    decision.executed_at = old_ts
                for execution in session.execute(select(Execution)).scalars().all():
                    execution.created_at = old_ts
                    execution.last_update_at = old_ts
                for tca in session.execute(select(ExecutionTCAMetric)).scalars().all():
                    tca.computed_at = old_ts
                session.commit()

            scheduler = TradingScheduler()
            app.state.trading_scheduler = scheduler
            response = self.client.get("/trading/profitability/runtime")
            self.assertEqual(response.status_code, 200)
            payload = response.json()
            self.assertTrue(payload["window"]["empty"])
            self.assertEqual(payload["window"]["decision_count"], 0)
            self.assertEqual(payload["window"]["execution_count"], 0)
            self.assertEqual(payload["decisions_by_symbol_strategy"], [])
            self.assertEqual(payload["executions"]["by_adapter"], [])
            self.assertEqual(payload["realized_pnl_summary"]["tca_sample_count"], 0)
            caveat_codes = {item["code"] for item in payload["caveats"]}
            self.assertIn("empty_window_no_runtime_evidence", caveat_codes)
        finally:
            if original_scheduler is None:
                if hasattr(app.state, "trading_scheduler"):
                    del app.state.trading_scheduler
            else:
                app.state.trading_scheduler = original_scheduler
