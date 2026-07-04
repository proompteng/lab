from __future__ import annotations

from tests.pipeline.trading_pipeline_base import (
    Any,
    Decimal,
    DecisionEngine,
    FakeAlpacaClient,
    FakeIngestor,
    Mapping,
    OrderExecutor,
    OrderFirewall,
    Reconciler,
    RiskEngine,
    STRATEGY_SIGNAL_PAPER_SOURCE_DECISION_MODE,
    SimpleTradingPipeline,
    Strategy,
    StrategyDecision,
    TradeDecision,
    TradingPipelineTestCaseBase,
    TradingState,
    UniverseResolver,
    _bounded_sim_collection_blockers,
    _bounded_sim_collection_metadata_from_decision,
    _executable_bid_ask_present,
    cast,
    datetime,
    patch,
    timezone,
    uuid4,
)


class TestTradingPipelineRetryProfitFloorA(TradingPipelineTestCaseBase):
    def test_executable_bid_ask_rejects_crossed_or_missing_quotes(self) -> None:
        self.assertFalse(
            _executable_bid_ask_present({"bid": "190.14", "ask": "190.10"})
        )
        self.assertFalse(_executable_bid_ask_present({"bid": "190.10"}))
        self.assertTrue(_executable_bid_ask_present({"bid": "190.10", "ask": "190.14"}))

    def test_bounded_collection_contamination_blocker_is_not_hidden_by_quote_readiness(
        self,
    ) -> None:
        target = {
            "candidate_id": "c88421d619759b2cfaa6f4d0",
            "hypothesis_id": "H-PAIRS-01",
            "observed_stage": "paper",
            "runtime_strategy_name": "microbar-cross-sectional-pairs-v1",
            "account_label": "TORGHUT_SIM",
            "source_account_label": "TORGHUT_SIM",
            "source_kind": "paper_route_probe_runtime_observed",
            "source_manifest_ref": "config/trading/hypotheses/h-pairs-01.json",
            "paper_route_probe_symbols": ["AAPL", "AMZN"],
            "evidence_collection_ok": True,
            "bounded_evidence_collection_authorized": True,
            "bounded_live_paper_collection_authorized": True,
            "bounded_evidence_collection_scope": "paper_route_probe_next_session_only",
            "promotion_allowed": False,
            "final_promotion_allowed": False,
            "final_promotion_authorized": False,
            "source_decision_readiness": {"ready": True, "blockers": []},
            "paper_route_account_contamination_blockers": [
                "paper_route_account_contamination_detected",
                "unlinked_order_events_present",
            ],
        }

        blockers = _bounded_sim_collection_blockers(
            target,
            account_label="TORGHUT_SIM",
        )

        self.assertIn("paper_route_account_contamination_detected", blockers)
        self.assertIn("unlinked_order_events_present", blockers)

    def test_strategy_signal_paper_collection_bypasses_repair_only_floor(
        self,
    ) -> None:
        from app import config

        now = datetime(2026, 6, 1, 14, 30, tzinfo=timezone.utc)
        window_start = datetime(2026, 6, 1, 13, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 6, 1, 20, 0, tzinfo=timezone.utc)
        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_simple_submit_enabled = True
        config.settings.trading_simple_paper_route_probe_enabled = True
        config.settings.trading_paper_route_target_plan_url = "http://torghut.test/plan"

        strategy_id = uuid4()
        strategy = Strategy(
            id=strategy_id,
            name="microbar-cross-sectional-pairs-v1",
            description="bounded strategy-signal collection",
            enabled=True,
            base_timeframe="1Sec",
            universe_type="static",
            universe_symbols=["AAPL", "AMZN"],
            max_notional_per_trade=Decimal("75000"),
        )
        target: dict[str, Any] = {
            "candidate_id": "c88421d619759b2cfaa6f4d0",
            "hypothesis_id": "H-PAIRS-01",
            "observed_stage": "paper",
            "strategy_family": "microbar_cross_sectional_pairs",
            "strategy_name": strategy.name,
            "runtime_strategy_name": strategy.name,
            "strategy_lookup_names": [str(strategy_id), strategy.name],
            "account_label": "TORGHUT_SIM",
            "source_account_label": "TORGHUT_REPLAY",
            "source_kind": "paper_route_probe_runtime_observed",
            "source_manifest_ref": "config/trading/hypotheses/h-pairs-01.json",
            "paper_route_probe_symbols": ["AAPL", "AMZN"],
            "paper_route_target_account_audit_state": (
                self._paper_route_target_account_audit_state(["AAPL", "AMZN"])
            ),
            "paper_route_target_account_audit_blockers": [],
            "paper_route_probe_pair_balance_state": "balanced",
            "paper_route_probe_window_start": window_start.isoformat(),
            "paper_route_probe_window_end": window_end.isoformat(),
            "evidence_collection_ok": True,
            "canary_collection_authorized": True,
            "bounded_evidence_collection_authorized": True,
            "bounded_live_paper_collection_authorized": True,
            "bounded_evidence_collection_scope": "paper_route_probe_next_session_only",
            "bounded_evidence_collection_blockers": [],
            "runtime_window_import_health_gate_blockers": [],
            "paper_route_account_pre_session_blockers": [],
            "paper_route_hpairs_symbol_blockers": [],
            "source_decision_readiness": {"ready": True, "blockers": []},
            "paper_probation_authorized": True,
        }
        base_decision = StrategyDecision(
            strategy_id=str(strategy_id),
            symbol="AAPL",
            event_ts=now,
            timeframe="1Sec",
            action="sell",
            qty=Decimal("1"),
            rationale="bounded strategy-signal paper collection",
            params={"price": "100"},
        )
        metadata = SimpleTradingPipeline._strategy_signal_paper_metadata(
            decision=base_decision,
            target=target,
            strategy=strategy,
        )
        blocked_metadata = SimpleTradingPipeline._strategy_signal_paper_metadata(
            decision=base_decision,
            target={
                **target,
                "paper_route_account_pre_session_blockers": [
                    "unlinked_order_events_present",
                ],
            },
            strategy=strategy,
        )
        self.assertEqual(
            blocked_metadata.get("paper_route_account_pre_session_blockers"),
            ["unlinked_order_events_present"],
        )
        decision = base_decision.model_copy(
            update={
                "params": {
                    "price": "100",
                    "paper_route_target_plan": metadata,
                    "strategy_signal_paper": metadata,
                    "source_decision_mode": STRATEGY_SIGNAL_PAPER_SOURCE_DECISION_MODE,
                    "profit_proof_eligible": True,
                }
            }
        )
        proof_floor = {
            "route_state": "repair_only",
            "capital_state": "zero_notional",
            "max_notional": "0",
            "market_window": {"session_open": True},
            "blocking_reasons": ["hypothesis_not_promotion_eligible"],
        }
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
            account_label="TORGHUT_SIM",
            session_factory=self.session_local,
        )

        with self.session_local() as session:
            row = TradeDecision(
                strategy_id=strategy_id,
                alpaca_account_label="TORGHUT_SIM",
                symbol="AAPL",
                timeframe="1Sec",
                decision_json=decision.model_dump(mode="json"),
                status="planned",
            )
            session.add(row)
            session.commit()

            with (
                patch.object(
                    pipeline,
                    "_external_paper_route_target_probe_symbols_cached",
                    return_value=({"AAPL", "AMZN"}, None, [target]),
                ),
                patch.object(
                    SimpleTradingPipeline,
                    "_profitability_proof_floor",
                    return_value=proof_floor,
                ),
                patch(
                    "app.trading.scheduler.simple_pipeline.trading_now",
                    return_value=now,
                ),
            ):
                self.assertTrue(
                    pipeline._is_trading_submission_allowed(
                        session=session,
                        decision=decision,
                        decision_row=row,
                    )
                )

            session.refresh(row)
            row_json = cast(dict[str, Any], row.decision_json)

        self.assertEqual(row.status, "planned")
        self.assertNotIn("submission_block_reason", row_json)

    def test_strategy_signal_paper_collection_reopens_prior_profit_floor_block(
        self,
    ) -> None:
        from app import config

        now = datetime(2026, 6, 1, 14, 35, tzinfo=timezone.utc)
        window_start = datetime(2026, 6, 1, 13, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 6, 1, 20, 0, tzinfo=timezone.utc)
        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_simple_submit_enabled = True
        config.settings.trading_simple_paper_route_probe_enabled = True
        config.settings.trading_simple_paper_route_probe_retry_attempt_limit = 2
        config.settings.trading_paper_route_target_plan_url = "http://torghut.test/plan"

        strategy = Strategy(
            id=uuid4(),
            name="microbar-cross-sectional-pairs-v1",
            description="bounded strategy-signal collection",
            enabled=True,
            base_timeframe="1Sec",
            universe_type="static",
            universe_symbols=["AAPL", "AMZN"],
            max_notional_per_trade=Decimal("75000"),
        )
        target: dict[str, Any] = {
            "candidate_id": "c88421d619759b2cfaa6f4d0",
            "hypothesis_id": "H-PAIRS-01",
            "observed_stage": "paper",
            "strategy_family": "microbar_cross_sectional_pairs",
            "strategy_name": strategy.name,
            "runtime_strategy_name": strategy.name,
            "strategy_lookup_names": [str(strategy.id), strategy.name],
            "account_label": "TORGHUT_SIM",
            "source_account_label": "TORGHUT_REPLAY",
            "source_kind": "paper_route_probe_runtime_observed",
            "source_manifest_ref": "config/trading/hypotheses/h-pairs-01.json",
            "paper_route_probe_symbols": ["AAPL", "AMZN"],
            "paper_route_target_account_audit_state": (
                self._paper_route_target_account_audit_state(["AAPL", "AMZN"])
            ),
            "paper_route_target_account_audit_blockers": [],
            "paper_route_probe_pair_balance_state": "balanced",
            "paper_route_probe_window_start": window_start.isoformat(),
            "paper_route_probe_window_end": window_end.isoformat(),
            "evidence_collection_ok": True,
            "canary_collection_authorized": True,
            "bounded_evidence_collection_authorized": True,
            "bounded_live_paper_collection_authorized": True,
            "bounded_evidence_collection_scope": "paper_route_probe_next_session_only",
            "bounded_evidence_collection_blockers": [],
            "runtime_window_import_health_gate_blockers": [],
            "paper_route_account_pre_session_blockers": [],
            "paper_route_hpairs_symbol_blockers": [],
            "source_decision_readiness": {"ready": True, "blockers": []},
            "paper_probation_authorized": True,
        }
        decision = StrategyDecision(
            strategy_id=str(strategy.id),
            symbol="AAPL",
            event_ts=now,
            timeframe="1Sec",
            action="sell",
            qty=Decimal("1"),
            rationale="bounded strategy-signal paper collection",
            params={"price": "100"},
        )
        proof_floor = {
            "route_state": "repair_only",
            "capital_state": "zero_notional",
            "max_notional": "0",
            "market_window": {"session_open": True},
            "blocking_reasons": ["hypothesis_not_promotion_eligible"],
        }
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
            account_label="TORGHUT_SIM",
            session_factory=self.session_local,
        )

        with self.session_local() as session:
            session.add(strategy)
            session.commit()
            row = pipeline.executor.ensure_decision(
                session,
                decision,
                strategy,
                "TORGHUT_SIM",
            )
            blocked_json = dict(cast(Mapping[str, Any], row.decision_json))
            blocked_json["params"] = {
                "price": "100",
                "source_decision_mode": STRATEGY_SIGNAL_PAPER_SOURCE_DECISION_MODE,
                "profit_proof_eligible": True,
                "promotion_allowed": False,
                "final_promotion_allowed": False,
                "final_promotion_authorized": False,
            }
            blocked_json["submission_stage"] = "blocked_profitability_proof_floor"
            blocked_json["submission_block_reason"] = (
                "hypothesis_not_promotion_eligible"
            )
            blocked_json["profitability_proof_floor"] = proof_floor
            row.status = "blocked"
            row.decision_json = blocked_json
            session.add(row)
            session.commit()

            with (
                patch.object(
                    pipeline,
                    "_external_paper_route_target_probe_symbols_cached",
                    return_value=({"AAPL", "AMZN"}, None, [target]),
                ),
                patch.object(
                    SimpleTradingPipeline,
                    "_profitability_proof_floor",
                    return_value=proof_floor,
                ),
                patch(
                    "app.trading.scheduler.simple_pipeline.trading_now",
                    return_value=now,
                ),
            ):
                reopened = pipeline._ensure_pending_decision_row(
                    session=session,
                    decision=decision,
                    strategy=strategy,
                )

            self.assertIsNotNone(reopened)
            assert reopened is not None
            session.refresh(reopened)
            row_json = cast(dict[str, Any], reopened.decision_json)
            params = cast(dict[str, Any], row_json.get("params"))
            retry = cast(dict[str, Any], row_json.get("bounded_sim_collection_retry"))

        self.assertEqual(reopened.status, "planned")
        self.assertEqual(
            row_json.get("submission_stage"),
            "bounded_sim_collection_retry_pending",
        )
        self.assertNotIn("submission_block_reason", row_json)
        self.assertEqual(row_json.get("paper_route_probe_retry_attempts"), 1)
        self.assertEqual(
            retry.get("previous_submission_block_reason"),
            "hypothesis_not_promotion_eligible",
        )
        self.assertEqual(params.get("source_decision_mode"), "strategy_signal_paper")
        self.assertFalse(params.get("promotion_allowed"))
        self.assertFalse(params.get("final_promotion_allowed"))
        self.assertFalse(params.get("final_promotion_authorized"))
        self.assertIsNotNone(
            _bounded_sim_collection_metadata_from_decision(
                StrategyDecision(
                    strategy_id=str(strategy.id),
                    symbol="AAPL",
                    event_ts=now,
                    timeframe="1Sec",
                    action="sell",
                    qty=Decimal("1"),
                    params=params,
                ),
                account_label="TORGHUT_SIM",
                trading_mode="paper",
            )
        )

    def test_simple_pipeline_retry_metadata_requires_prior_profit_floor_block(
        self,
    ) -> None:
        def decision_row(
            *,
            status: str = "blocked",
            decision_json: object,
        ) -> TradeDecision:
            return TradeDecision(
                strategy_id=uuid4(),
                alpaca_account_label="paper",
                symbol="AAPL",
                timeframe="1Min",
                decision_json=decision_json,
                status=status,
            )

        self.assertIsNone(
            SimpleTradingPipeline._paper_route_probe_retry_metadata(
                decision_row(
                    status="planned",
                    decision_json={
                        "submission_stage": "blocked_profitability_proof_floor",
                        "submission_block_reason": "hypothesis_not_promotion_eligible",
                        "profitability_proof_floor": {},
                    },
                )
            )
        )
        self.assertIsNone(
            SimpleTradingPipeline._paper_route_probe_retry_metadata(
                decision_row(decision_json=["not", "a", "mapping"])
            )
        )
        self.assertIsNone(
            SimpleTradingPipeline._paper_route_probe_retry_metadata(
                decision_row(
                    decision_json={
                        "submission_stage": "blocked_other",
                        "submission_block_reason": "hypothesis_not_promotion_eligible",
                        "profitability_proof_floor": {},
                    }
                )
            )
        )
        self.assertIsNone(
            SimpleTradingPipeline._paper_route_probe_retry_metadata(
                decision_row(
                    decision_json={
                        "submission_stage": "blocked_profitability_proof_floor",
                        "submission_block_reason": "",
                        "profitability_proof_floor": {},
                    }
                )
            )
        )
        self.assertIsNone(
            SimpleTradingPipeline._paper_route_probe_retry_metadata(
                decision_row(
                    decision_json={
                        "submission_stage": "blocked_profitability_proof_floor",
                        "submission_block_reason": "hypothesis_not_promotion_eligible",
                        "profitability_proof_floor": "not-a-mapping",
                    }
                )
            )
        )
        self.assertEqual(
            SimpleTradingPipeline._paper_route_probe_retry_metadata(
                decision_row(
                    decision_json={
                        "submission_stage": "blocked_profitability_proof_floor",
                        "submission_block_reason": "hypothesis_not_promotion_eligible",
                        "profitability_proof_floor": {"route_state": "repair_only"},
                    }
                )
            ),
            {
                "previous_submission_stage": "blocked_profitability_proof_floor",
                "previous_submission_block_reason": "hypothesis_not_promotion_eligible",
                "previous_decision_status": "blocked",
                "previous_paper_route_probe_retry_attempts": 0,
            },
        )

        from app import config

        config.settings.trading_simple_paper_route_probe_retry_attempt_limit = 1
        self.assertIsNone(
            SimpleTradingPipeline._paper_route_probe_retry_metadata(
                decision_row(
                    decision_json={
                        "submission_stage": "blocked_profitability_proof_floor",
                        "submission_block_reason": "hypothesis_not_promotion_eligible",
                        "paper_route_probe_retry_attempts": 1,
                        "profitability_proof_floor": {"route_state": "repair_only"},
                    }
                )
            )
        )

    def test_simple_pipeline_target_price_retry_metadata_requires_price_null_precheck(
        self,
    ) -> None:
        def decision_row(
            *,
            status: str = "rejected",
            decision_json: object,
        ) -> TradeDecision:
            return TradeDecision(
                strategy_id=uuid4(),
                alpaca_account_label="paper",
                symbol="AAPL",
                timeframe="1Min",
                decision_json=decision_json,
                status=status,
            )

        base_params: dict[str, Any] = {
            "paper_route_target_plan": {
                "candidate_id": "candidate-1",
                "hypothesis_id": "H-PAIRS-01",
            },
            "execution_precheck": {
                "price": None,
                "requested_qty": "1",
            },
        }
        base_json: dict[str, Any] = {
            "submission_stage": "rejected_pre_submit",
            "risk_reasons": ["broker_precheck_failed"],
            "params": base_params,
        }
        self.assertIsNone(
            SimpleTradingPipeline._paper_route_target_price_retry_metadata(
                decision_row(status="planned", decision_json=base_json)
            )
        )
        self.assertIsNone(
            SimpleTradingPipeline._paper_route_target_price_retry_metadata(
                decision_row(
                    decision_json={
                        **base_json,
                        "params": {
                            **base_params,
                            "execution_precheck": {"price": "100"},
                        },
                    }
                )
            )
        )
        self.assertIsNone(
            SimpleTradingPipeline._paper_route_target_price_retry_metadata(
                decision_row(
                    decision_json={
                        **base_json,
                        "risk_reasons": ["max_notional_exceeded"],
                    }
                )
            )
        )
        self.assertEqual(
            SimpleTradingPipeline._paper_route_target_price_retry_metadata(
                decision_row(decision_json=base_json)
            ),
            {
                "previous_decision_status": "rejected",
                "previous_submission_stage": "rejected_pre_submit",
                "previous_risk_reasons": ["broker_precheck_failed"],
                "previous_retry_attempts": 0,
            },
        )

        from app import config

        config.settings.trading_simple_paper_route_probe_retry_attempt_limit = 1
        self.assertIsNone(
            SimpleTradingPipeline._paper_route_target_price_retry_metadata(
                decision_row(
                    decision_json={
                        **base_json,
                        "paper_route_target_price_retry_attempts": 1,
                    }
                )
            )
        )

    def test_simple_pipeline_reopens_price_null_target_source_decision(self) -> None:
        from app import config

        config.settings.trading_simple_paper_route_probe_retry_attempt_limit = 2

        with self.session_local() as session:
            strategy = Strategy(
                name="simple-paper-target-price-retry",
                description="simple paper target source price retry",
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
                event_ts=datetime(2026, 5, 29, 13, 30, tzinfo=timezone.utc),
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
            params["execution_precheck"] = {
                "price": None,
                "requested_qty": "1",
            }
            decision_json.update(
                {
                    "params": params,
                    "submission_stage": "rejected_pre_submit",
                    "risk_reasons": ["broker_precheck_failed"],
                    "reject_reason_atomic": ["broker_precheck_failed"],
                    "reject_class": "runtime",
                    "reject_origin": "scheduler",
                }
            )
            decision_row.status = "rejected"
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
                "paper_route_target_price_retry_pending",
            )
            self.assertNotIn("risk_reasons", refreshed_json)
            self.assertNotIn("reject_reason_atomic", refreshed_json)
            self.assertEqual(
                refreshed_json.get("paper_route_target_price_retry_attempts"),
                1,
            )
            retry = cast(
                dict[str, Any],
                refreshed_json.get("paper_route_target_price_retry"),
            )
            self.assertEqual(
                retry.get("previous_risk_reasons"), ["broker_precheck_failed"]
            )
            self.assertEqual(retry.get("previous_retry_attempts"), 0)
            self.assertEqual(
                retry.get("submission_stage"),
                "paper_route_target_price_retry_pending",
            )
