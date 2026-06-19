from __future__ import annotations

from tests.pipeline.trading_pipeline_base import (
    Any,
    BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE,
    Decimal,
    DecisionEngine,
    Execution,
    FakeAlpacaClient,
    FakeIngestor,
    Mapping,
    OrderExecutor,
    OrderFirewall,
    Reconciler,
    RiskEngine,
    SimpleTradingPipeline,
    Strategy,
    StrategyDecision,
    TradeDecision,
    TradingPipelineTestCaseBase,
    TradingState,
    UniverseResolver,
    _safe_int,
    cast,
    datetime,
    json,
    patch,
    timezone,
    uuid4,
)


class TestTradingPipelineRetryProfitFloorB(TradingPipelineTestCaseBase):
    def test_simple_pipeline_scans_target_price_retry_without_new_signal(self) -> None:
        from app import config

        event_ts = datetime(2026, 5, 29, 14, 0, tzinfo=timezone.utc)
        config.settings.trading_simple_paper_route_probe_enabled = True
        config.settings.trading_simple_paper_route_probe_retry_attempt_limit = 2
        config.settings.trading_simple_paper_route_probe_retry_batch_limit = 4
        config.settings.trading_simple_paper_route_probe_retry_scan_limit = 16

        with self.session_local() as session:
            strategy = Strategy(
                name="simple-paper-target-price-retry-scan",
                description="simple paper target source price retry scan",
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=["AAPL"],
                max_notional_per_trade=Decimal("1000"),
            )
            session.add(strategy)
            session.commit()
            session.refresh(strategy)

            decision = StrategyDecision(
                strategy_id=str(strategy.id),
                symbol="AAPL",
                event_ts=event_ts,
                timeframe="1Min",
                action="buy",
                qty=Decimal("1"),
                rationale="paper-route-target-source",
                params={
                    "paper_route_target_plan": {
                        "candidate_id": "candidate-1",
                        "hypothesis_id": "H-PAIRS-01",
                    },
                    "source_decision_mode": "route_acquisition_probe",
                },
            )
            executor = OrderExecutor()
            decision_row = executor.ensure_decision(
                session,
                decision,
                strategy,
                "paper",
            )
            decision_json = dict(cast(Mapping[str, Any], decision_row.decision_json))
            params = dict(cast(Mapping[str, Any], decision_json.get("params") or {}))
            params["simple_lane_precheck"] = {
                "price": None,
                "requested_qty": "1",
            }
            decision_json.update(
                {
                    "params": params,
                    "submission_stage": "rejected_pre_submit",
                    "risk_reasons": ["broker_precheck_failed"],
                    "reject_reason_atomic": ["broker_precheck_failed"],
                }
            )
            decision_row.status = "rejected"
            decision_row.decision_json = decision_json
            session.add(decision_row)
            session.commit()

            pipeline = SimpleTradingPipeline(
                alpaca_client=FakeAlpacaClient(),
                order_firewall=OrderFirewall(FakeAlpacaClient()),
                ingestor=FakeIngestor([]),
                decision_engine=DecisionEngine(),
                risk_engine=RiskEngine(),
                executor=executor,
                execution_adapter=FakeAlpacaClient(),
                reconciler=Reconciler(),
                universe_resolver=UniverseResolver(),
                state=TradingState(),
                account_label="paper",
                session_factory=self.session_local,
            )

            with patch(
                "app.trading.scheduler.simple_pipeline.trading_now",
                return_value=datetime(2026, 5, 29, 14, 5, tzinfo=timezone.utc),
            ):
                retries = pipeline._paper_route_probe_retry_decisions(session=session)
                self.assertEqual([retry.symbol for retry in retries], ["AAPL"])
                pending = pipeline._ensure_pending_decision_row(
                    session=session,
                    decision=retries[0],
                    strategy=strategy,
                )

            self.assertIsNotNone(pending)
            session.refresh(decision_row)
            refreshed_json = cast(dict[str, Any], decision_row.decision_json)
            self.assertEqual(decision_row.status, "planned")
            self.assertEqual(
                refreshed_json.get("submission_stage"),
                "paper_route_target_price_retry_pending",
            )
            self.assertEqual(
                refreshed_json.get("paper_route_target_price_retry_attempts"),
                1,
            )

    def test_simple_pipeline_retry_helpers_filter_invalid_rows_and_limits(
        self,
    ) -> None:
        from app import config

        self.assertEqual(_safe_int(True), 1)
        self.assertEqual(_safe_int("7"), 7)
        self.assertEqual(_safe_int("bad"), 0)

        pipeline = SimpleTradingPipeline(
            alpaca_client=FakeAlpacaClient(),
            order_firewall=OrderFirewall(FakeAlpacaClient()),
            ingestor=FakeIngestor([]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=FakeAlpacaClient(),
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="paper",
            session_factory=self.session_local,
        )
        strategy_id = uuid4()
        invalid_row = TradeDecision(
            strategy_id=strategy_id,
            alpaca_account_label="paper",
            symbol="AAPL",
            timeframe="1Min",
            decision_json=["not", "a", "mapping"],
            status="blocked",
        )
        self.assertIsNone(
            SimpleTradingPipeline._trade_decision_from_retry_row(invalid_row)
        )
        flatten_close_row = TradeDecision(
            strategy_id=strategy_id,
            alpaca_account_label="paper",
            symbol="BITO",
            timeframe="event",
            decision_json={
                "schema_version": "torghut.paper-account-flatten-close-decision.v1",
                "flatten_lineage_role": "close",
                "action": "sell",
                "qty": "1000",
            },
            status="submitted",
        )
        self.assertIsNone(
            SimpleTradingPipeline._trade_decision_from_retry_row(flatten_close_row)
        )
        flatten_role_only_row = TradeDecision(
            strategy_id=strategy_id,
            alpaca_account_label="paper",
            symbol="BITO",
            timeframe="event",
            decision_json={
                "flatten_lineage_role": "close",
                "action": "sell",
                "qty": "1000",
            },
            status="submitted",
        )
        self.assertIsNone(
            SimpleTradingPipeline._trade_decision_from_retry_row(flatten_role_only_row)
        )

        event_ts = datetime(2026, 3, 26, 13, 30, tzinfo=timezone.utc)
        decision = StrategyDecision(
            strategy_id=str(strategy_id),
            symbol="AAPL",
            event_ts=event_ts,
            timeframe="1Min",
            action="buy",
            qty=Decimal("1"),
            rationale="paper-route-retry-filter",
            params={"price": Decimal("100")},
        )
        self.assertIsNone(
            SimpleTradingPipeline._paper_route_probe_exit_minute_value(None)
        )
        self.assertIsNone(
            SimpleTradingPipeline._paper_route_probe_exit_minute_value("")
        )
        self.assertEqual(
            SimpleTradingPipeline._paper_route_probe_exit_minute_value("close"),
            390,
        )
        self.assertIsNone(
            SimpleTradingPipeline._paper_route_probe_exit_minute_value("bad")
        )
        self.assertEqual(
            SimpleTradingPipeline._paper_route_probe_exit_minute_value(Decimal("42.8")),
            42,
        )
        self.assertIsNone(
            SimpleTradingPipeline._paper_route_probe_exit_minute_value(object())
        )
        self.assertEqual(
            SimpleTradingPipeline._paper_route_probe_exit_minute_after_open(
                decision=decision.model_copy(
                    update={
                        "params": {
                            "price": Decimal("100"),
                            "exit_minute_after_open": "45",
                        }
                    }
                )
            ),
            45,
        )
        self.assertEqual(
            SimpleTradingPipeline._paper_route_probe_exit_minute_after_open(
                decision=decision.model_copy(
                    update={
                        "params": {
                            "price": Decimal("100"),
                            "paper_route_probe": {
                                "exit_minute_after_open": "120",
                            },
                        }
                    }
                )
            ),
            120,
        )
        window_end = datetime(2026, 3, 26, 20, 0, tzinfo=timezone.utc)
        strategy = Strategy(
            name="paper-route-candidate-v1",
            description="paper route candidate without explicit exit",
            enabled=True,
            base_timeframe="1Min",
            universe_type="static",
            universe_symbols=["AAPL"],
        )
        target = {
            "candidate_id": "cand-paper-route",
            "hypothesis_id": "H-PAPER-ROUTE",
            "source_kind": "paper_route_probe_runtime_observed",
            "paper_route_probe_symbols": ["AAPL"],
            "paper_route_probe_window_start": event_ts.isoformat(),
            "paper_route_probe_window_end": window_end.isoformat(),
            "paper_probation_authorized": True,
            "bounded_evidence_collection_authorized": True,
        }
        source_decision_metadata = (
            SimpleTradingPipeline._paper_route_target_source_decision_metadata(
                target=target,
                strategy=strategy,
                symbol="AAPL",
                window_start=event_ts,
                window_end=window_end,
                max_notional=Decimal("250"),
            )
        )
        self.assertEqual(source_decision_metadata["exit_minute_after_open"], 375)
        self.assertEqual(
            source_decision_metadata["effective_exit_minute_after_open"], 375
        )
        self.assertEqual(
            source_decision_metadata["exit_due_at"],
            "2026-03-26T19:45:00+00:00",
        )
        self.assertTrue(source_decision_metadata["paper_route_probe_exit_defaulted"])
        self.assertEqual(
            SimpleTradingPipeline._paper_route_probe_exit_minute_after_open(
                decision=decision.model_copy(
                    update={
                        "params": {
                            "paper_route_target_plan_source_decision": (
                                source_decision_metadata
                            )
                        }
                    }
                )
            ),
            375,
        )
        strategy_signal_metadata = (
            SimpleTradingPipeline._strategy_signal_paper_metadata(
                decision=decision,
                target=target,
                strategy=strategy,
            )
        )
        self.assertEqual(strategy_signal_metadata["exit_minute_after_open"], 375)
        self.assertTrue(strategy_signal_metadata["paper_route_probe_exit_defaulted"])
        self.assertEqual(
            SimpleTradingPipeline._paper_route_probe_exit_minute_after_open(
                decision=decision.model_copy(
                    update={
                        "params": {"strategy_signal_paper": strategy_signal_metadata}
                    }
                )
            ),
            375,
        )
        old_row = TradeDecision(
            strategy_id=strategy_id,
            alpaca_account_label="paper",
            symbol="AAPL",
            timeframe="1Min",
            decision_json=decision.model_dump(mode="json"),
            status="blocked",
            created_at=datetime(2026, 3, 25, 19, 0, tzinfo=timezone.utc),
        )
        self.assertFalse(
            pipeline._created_in_current_regular_session(
                old_row,
                decision.model_copy(
                    update={
                        "event_ts": datetime(
                            2026,
                            3,
                            25,
                            19,
                            0,
                            tzinfo=timezone.utc,
                        )
                    }
                ),
                session_open=datetime(2026, 3, 26, 13, 30, tzinfo=timezone.utc),
            )
        )

        config.settings.trading_simple_paper_route_probe_enabled = False
        with self.session_local() as session:
            self.assertEqual(
                pipeline._paper_route_probe_retry_decisions(session=session), []
            )

        config.settings.trading_simple_paper_route_probe_enabled = True
        config.settings.trading_simple_paper_route_probe_retry_batch_limit = 0
        config.settings.trading_simple_paper_route_probe_retry_scan_limit = 16
        with self.session_local() as session:
            self.assertEqual(
                pipeline._paper_route_probe_retry_decisions(session=session), []
            )

        config.settings.trading_simple_paper_route_probe_retry_batch_limit = 2
        config.settings.trading_simple_paper_route_probe_retry_attempt_limit = 2
        with self.session_local() as session:
            self.assertIsNone(
                pipeline._paper_route_probe_strategy(
                    session=session,
                    decision=decision.model_copy(
                        update={"strategy_id": "not-a-valid-uuid"}
                    ),
                )
            )
            strategy = Strategy(
                name="simple-paper-proof-floor-retry-filter",
                description=(
                    "simple paper retry filter fixtures\n[catalog_metadata]\n"
                    + json.dumps(
                        {
                            "params": {
                                "entry_minute_after_open": "60",
                                "exit_minute_after_open": "120",
                            }
                        }
                    )
                ),
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=["AAPL"],
                max_notional_per_trade=Decimal("1000"),
            )
            session.add(strategy)
            session.commit()
            session.refresh(strategy)

            stale_payload = decision.model_copy(
                update={
                    "strategy_id": str(strategy.id),
                    "event_ts": datetime(2026, 3, 25, 19, 0, tzinfo=timezone.utc),
                }
            ).model_dump(mode="json")
            stale_payload.update(
                {
                    "submission_stage": "blocked_profitability_proof_floor",
                    "submission_block_reason": "alpha_readiness_not_promotion_eligible",
                    "profitability_proof_floor": {"route_state": "repair_only"},
                }
            )
            stale_row = TradeDecision(
                strategy_id=strategy.id,
                alpaca_account_label="paper",
                symbol="AAPL",
                timeframe="1Min",
                decision_json=stale_payload,
                status="blocked",
                created_at=datetime(2026, 3, 25, 19, 0, tzinfo=timezone.utc),
            )
            invalid_payload_row = TradeDecision(
                strategy_id=strategy.id,
                alpaca_account_label="paper",
                symbol="AAPL",
                timeframe="1Min",
                decision_json={
                    "submission_stage": "blocked_profitability_proof_floor",
                    "submission_block_reason": "alpha_readiness_not_promotion_eligible",
                    "profitability_proof_floor": {"route_state": "repair_only"},
                },
                status="blocked",
                created_at=event_ts,
            )
            metadata_miss_row = TradeDecision(
                strategy_id=strategy.id,
                alpaca_account_label="paper",
                symbol="AAPL",
                timeframe="1Min",
                decision_json={
                    "submission_stage": "blocked_other",
                    "submission_block_reason": "alpha_readiness_not_promotion_eligible",
                    "profitability_proof_floor": {"route_state": "repair_only"},
                },
                status="blocked",
                created_at=event_ts,
            )
            executed_payload = decision.model_copy(
                update={"strategy_id": str(strategy.id)}
            ).model_dump(mode="json")
            executed_payload.update(
                {
                    "submission_stage": "blocked_profitability_proof_floor",
                    "submission_block_reason": "alpha_readiness_not_promotion_eligible",
                    "profitability_proof_floor": {"route_state": "repair_only"},
                }
            )
            executed_row = TradeDecision(
                strategy_id=strategy.id,
                alpaca_account_label="paper",
                symbol="AAPL",
                timeframe="1Min",
                decision_json=executed_payload,
                status="blocked",
                created_at=event_ts,
            )
            session.add_all(
                [
                    stale_row,
                    invalid_payload_row,
                    metadata_miss_row,
                    executed_row,
                ]
            )
            session.commit()
            session.refresh(executed_row)
            session.add(
                Execution(
                    trade_decision_id=executed_row.id,
                    alpaca_account_label="paper",
                    alpaca_order_id="order-existing",
                    client_order_id="client-existing",
                    symbol="AAPL",
                    side="buy",
                    order_type="market",
                    time_in_force="day",
                    submitted_qty=Decimal("1"),
                    status="accepted",
                    raw_order={},
                )
            )
            session.commit()

            with patch(
                "app.trading.scheduler.simple_pipeline.trading_now",
                return_value=datetime(2026, 3, 26, 14, 0, tzinfo=timezone.utc),
            ):
                self.assertEqual(
                    pipeline._paper_route_probe_retry_decisions(session=session),
                    [],
                )

            stale_after_exit_payload = decision.model_copy(
                update={
                    "strategy_id": str(strategy.id),
                    "event_ts": datetime(2026, 3, 26, 14, 30, tzinfo=timezone.utc),
                }
            ).model_dump(mode="json")
            stale_after_exit_payload.update(
                {
                    "submission_stage": "blocked_profitability_proof_floor",
                    "submission_block_reason": "alpha_readiness_not_promotion_eligible",
                    "profitability_proof_floor": {"route_state": "repair_only"},
                }
            )
            session.add(
                TradeDecision(
                    strategy_id=strategy.id,
                    alpaca_account_label="paper",
                    symbol="AAPL",
                    timeframe="1Min",
                    decision_json=stale_after_exit_payload,
                    status="blocked",
                    created_at=datetime(2026, 3, 26, 14, 30, tzinfo=timezone.utc),
                )
            )
            session.commit()

            with patch(
                "app.trading.scheduler.simple_pipeline.trading_now",
                return_value=datetime(2026, 3, 26, 15, 31, tzinfo=timezone.utc),
            ):
                self.assertEqual(
                    pipeline._paper_route_probe_retry_decisions(session=session),
                    [],
                )

    def test_simple_pipeline_scans_rejected_quote_routeability_retry_without_new_signal(
        self,
    ) -> None:
        from app import config

        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_mode = "paper"
        config.settings.trading_pipeline_mode = "simple"
        config.settings.trading_simple_submit_enabled = True
        config.settings.trading_fractional_equities_enabled = True
        config.settings.trading_simple_paper_route_probe_enabled = True
        config.settings.trading_simple_paper_route_probe_retry_attempt_limit = 2
        config.settings.trading_simple_paper_route_probe_retry_batch_limit = 4
        config.settings.trading_simple_paper_route_probe_retry_scan_limit = 16
        config.settings.trading_paper_route_target_plan_url = ""
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"
        config.settings.trading_universe_static_fallback_enabled = True
        config.settings.trading_universe_static_fallback_symbols_raw = "AAPL"

        event_ts = datetime(2026, 3, 26, 14, 0, tzinfo=timezone.utc)
        pipeline = SimpleTradingPipeline(
            alpaca_client=FakeAlpacaClient(),
            order_firewall=OrderFirewall(FakeAlpacaClient()),
            ingestor=FakeIngestor([]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=FakeAlpacaClient(),
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="paper",
            session_factory=self.session_local,
        )

        with self.session_local() as session:
            strategy = Strategy(
                name="simple-paper-quote-routeability-retry-scan",
                description="simple paper quote routeability retry scan",
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=["AAPL"],
                max_notional_per_trade=Decimal("1000"),
            )
            session.add(strategy)
            session.commit()
            session.refresh(strategy)

            decision = StrategyDecision(
                strategy_id=str(strategy.id),
                symbol="AAPL",
                event_ts=event_ts,
                timeframe="1Min",
                action="buy",
                qty=Decimal("1"),
                rationale="paper-route-target-source",
                params={
                    "paper_route_target_plan": {
                        "candidate_id": "c88421d619759b2cfaa6f4d0",
                        "hypothesis_id": "H-PAIRS-01",
                        "account_label": "paper",
                        "observed_stage": "paper",
                        "source_kind": "paper_route_probe_runtime_observed",
                    },
                    "source_decision_mode": BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE,
                    "profit_proof_eligible": True,
                },
            )
            row = pipeline.executor.ensure_decision(
                session, decision, strategy, "paper"
            )
            decision_json = dict(cast(Mapping[str, Any], row.decision_json))
            params = dict(cast(Mapping[str, Any], decision_json.get("params")))
            params["quote_routeability"] = {
                "schema_version": "torghut.paper-route-quote-routeability.v1",
                "status": "blocked",
                "reason": "missing_executable_quote",
                "bounded_evidence_collection_ready": False,
                "promotion_allowed": False,
                "final_authority_ok": False,
                "final_promotion_allowed": False,
            }
            decision_json["params"] = params
            decision_json["submission_stage"] = "rejected_quote_routeability"
            decision_json["reject_reason_atomic"] = ["missing_executable_quote"]
            row.status = "rejected"
            row.decision_json = decision_json
            session.add(row)
            session.commit()

            with patch(
                "app.trading.scheduler.simple_pipeline.trading_now",
                return_value=datetime(2026, 3, 26, 14, 5, tzinfo=timezone.utc),
            ):
                retries = pipeline._paper_route_probe_retry_decisions(session=session)
                self.assertEqual([retry.symbol for retry in retries], ["AAPL"])
                reopened = pipeline._ensure_pending_decision_row(
                    session=session,
                    decision=retries[0],
                    strategy=strategy,
                )

            self.assertIsNotNone(reopened)
            session.refresh(row)
            reopened_json = cast(dict[str, Any], row.decision_json)
            reopened_params = cast(dict[str, Any], reopened_json.get("params"))
            retry_metadata = cast(
                dict[str, Any],
                reopened_json.get("paper_route_quote_routeability_retry"),
            )

            self.assertEqual(row.status, "planned")
            self.assertEqual(
                reopened_json.get("submission_stage"),
                "paper_route_quote_routeability_retry_pending",
            )
            self.assertNotIn("quote_routeability", reopened_params)
            self.assertEqual(
                reopened_json.get("paper_route_quote_routeability_retry_attempts"),
                1,
            )
            self.assertEqual(
                retry_metadata.get("previous_quote_routeability_reason"),
                "missing_executable_quote",
            )

    def test_simple_pipeline_reopens_profit_floor_block_for_bounded_paper_route_retry(
        self,
    ) -> None:
        from app import config

        config.settings.trading_mode = "paper"
        config.settings.trading_simple_submit_enabled = True
        config.settings.trading_simple_paper_route_probe_enabled = True
        config.settings.trading_simple_paper_route_probe_max_notional = 25.0
        config.settings.trading_paper_route_target_plan_url = ""

        proof_floor = {
            "route_state": "repair_only",
            "capital_state": "paper",
            "max_notional": "25",
            "market_window": {"session_open": True},
            "blocking_reasons": ["execution_tca_route_universe_empty"],
            "route_reacquisition_book": {
                "summary": {"repair_candidate_symbols": ["AAPL"]}
            },
        }

        with self.session_local() as session:
            strategy = Strategy(
                name="simple-paper-proof-floor-retry",
                description="simple paper retry after proof floor block",
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=["AAPL"],
                max_notional_per_trade=Decimal("1000"),
            )
            session.add(strategy)
            session.commit()
            session.refresh(strategy)

            decision = StrategyDecision(
                strategy_id=str(strategy.id),
                symbol="AAPL",
                event_ts=datetime(2026, 3, 26, 13, 30, tzinfo=timezone.utc),
                timeframe="1Min",
                action="buy",
                qty=Decimal("1"),
                rationale="paper-route-retry",
                params={"price": Decimal("100")},
            )
            executor = OrderExecutor()
            decision_row = executor.ensure_decision(
                session,
                decision,
                strategy,
                "paper",
            )
            decision_json = dict(cast(Mapping[str, Any], decision_row.decision_json))
            decision_json.update(
                {
                    "submission_stage": "blocked_profitability_proof_floor",
                    "submission_block_reason": "alpha_readiness_not_promotion_eligible",
                    "submission_block_atomic": [
                        "alpha_readiness_not_promotion_eligible"
                    ],
                    "profitability_proof_floor": proof_floor,
                }
            )
            decision_row.status = "blocked"
            decision_row.decision_json = decision_json
            session.add(decision_row)
            session.commit()
            session.refresh(decision_row)

            pipeline = SimpleTradingPipeline(
                alpaca_client=FakeAlpacaClient(),
                order_firewall=OrderFirewall(FakeAlpacaClient()),
                ingestor=FakeIngestor([]),
                decision_engine=DecisionEngine(),
                risk_engine=RiskEngine(),
                executor=executor,
                execution_adapter=FakeAlpacaClient(),
                reconciler=Reconciler(),
                universe_resolver=UniverseResolver(),
                state=TradingState(),
                account_label="paper",
                session_factory=self.session_local,
            )

            with patch.object(
                pipeline,
                "_profitability_proof_floor",
                return_value=proof_floor,
            ):
                pending = pipeline._ensure_pending_decision_row(
                    session=session,
                    decision=decision,
                    strategy=strategy,
                )

            self.assertIsNotNone(pending)
            assert pending is not None
            self.assertEqual(pending.id, decision_row.id)
            refreshed = session.get(TradeDecision, decision_row.id)
            assert refreshed is not None
            self.assertEqual(refreshed.status, "planned")
            refreshed_json = cast(dict[str, Any], refreshed.decision_json)
            self.assertEqual(
                refreshed_json.get("submission_stage"),
                "paper_route_probe_retry_pending",
            )
            self.assertNotIn("submission_block_reason", refreshed_json)
            self.assertNotIn("submission_block_atomic", refreshed_json)
            self.assertEqual(refreshed_json.get("paper_route_probe_retry_attempts"), 1)
            retry = cast(dict[str, Any], refreshed_json.get("paper_route_probe_retry"))
            self.assertEqual(
                retry.get("previous_submission_block_reason"),
                "alpha_readiness_not_promotion_eligible",
            )
            self.assertEqual(retry.get("previous_paper_route_probe_retry_attempts"), 0)
            self.assertEqual(retry.get("symbol"), "AAPL")
            self.assertEqual(
                retry.get("submission_stage"),
                "paper_route_probe_retry_pending",
            )
            context = cast(dict[str, Any], retry.get("context"))
            self.assertEqual(context.get("mode"), "paper_route_acquisition")
            self.assertEqual(context.get("max_notional"), "25.0")
