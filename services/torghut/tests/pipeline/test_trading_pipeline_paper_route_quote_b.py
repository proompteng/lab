from __future__ import annotations

from typing import Literal

from app.trading.scheduler.submission_preparation.shared import (
    SubmissionPreparationRequest,
)
from tests.pipeline.trading_pipeline_base import (
    Any,
    BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE,
    Decimal,
    DecisionEngine,
    FakeAlpacaClient,
    FakeIngestor,
    FakePriceFetcher,
    Mapping,
    OrderExecutor,
    OrderFirewall,
    ROUTE_ACQUISITION_SOURCE_DECISION_MODE,
    Reconciler,
    RiskEngine,
    SimpleTradingPipeline,
    Strategy,
    StrategyDecision,
    TradingPipelineTestCaseBase,
    TradingState,
    UniverseResolver,
    _target_notional_sizing_audit_from_params,
    cast,
    datetime,
    timezone,
    uuid4,
)


class TestTradingPipelinePaperRouteQuoteB(TradingPipelineTestCaseBase):
    def test_bounded_collection_target_source_submits_precheck_qty_clamp(
        self,
    ) -> None:
        from app import config

        now = datetime(2026, 6, 4, 14, 0, tzinfo=timezone.utc)
        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_simple_submit_enabled = True
        config.settings.trading_fractional_equities_enabled = True
        config.settings.trading_allow_shorts = True
        config.settings.trading_simple_max_notional_per_order = 1000.0
        config.settings.trading_simple_max_notional_per_symbol = 100000.0
        strategy = Strategy(
            id=uuid4(),
            name="microbar-cross-sectional-pairs-v1",
            description="bounded target strategy",
            enabled=True,
            base_timeframe="1Min",
            universe_type="static",
            universe_symbols=["AAPL", "AMZN"],
            max_notional_per_trade=Decimal("100000"),
        )
        target_metadata = {
            "candidate_id": "c88421d619759b2cfaa6f4d0",
            "hypothesis_id": "H-PAIRS-01",
            "account_label": "TORGHUT_SIM",
            "observed_stage": "paper",
            "source_kind": "paper_route_probe_runtime_observed",
            "source_manifest_ref": "config/trading/hypotheses/h-pairs.json",
            "runtime_strategy_name": "microbar-cross-sectional-pairs-v1",
            "strategy_name": "microbar-cross-sectional-pairs-v1",
            "strategy_family": "microbar_cross_sectional_pairs",
            "paper_route_probe_symbols": ["AAPL", "AMZN"],
            "paper_route_probe_symbol_actions": {
                "AAPL": "buy",
                "AMZN": "sell",
            },
            "paper_route_probe_symbol_quantities": {
                "AAPL": "1",
                "AMZN": "1",
            },
            "paper_route_probe_next_session_max_notional": "75000",
            "bounded_evidence_collection_authorized": True,
            "bounded_live_paper_collection_authorized": True,
            "evidence_collection_ok": True,
            "source_decision_readiness": {"ready": True, "blockers": []},
            "promotion_allowed": False,
            "final_promotion_allowed": False,
            "final_promotion_authorized": False,
        }
        decision = StrategyDecision(
            strategy_id=str(strategy.id),
            symbol="AMZN",
            event_ts=now,
            timeframe="1Min",
            action="sell",
            qty=Decimal("1"),
            rationale="bounded paper-route target source",
            params={
                "paper_route_target_plan": target_metadata,
                "source_decision_mode": (
                    BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE
                ),
                "profit_proof_eligible": True,
            },
        )
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
            price_fetcher=FakePriceFetcher(
                Decimal("250"),
                spread=Decimal("0.02"),
                bid=Decimal("250"),
                ask=Decimal("250.02"),
            ),
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

            prepared = pipeline._prepare_decision_for_submission(
                SubmissionPreparationRequest(
                    session=session,
                    decision=decision,
                    decision_row=row,
                    strategy=strategy,
                    account={
                        "equity": "200000",
                        "cash": "200000",
                        "buying_power": "200000",
                    },
                    positions=[],
                )
            )
            session.refresh(row)
            row_json = cast(dict[str, Any], row.decision_json)
            params = cast(dict[str, Any], row_json["params"])
            sizing = cast(dict[str, Any], params["paper_route_target_notional_sizing"])

        self.assertIsNotNone(prepared)
        assert prepared is not None
        prepared_decision, _snapshot = prepared
        self.assertEqual(prepared_decision.qty, Decimal("4"))
        self.assertEqual(row.status, "planned")
        self.assertEqual(
            Decimal(str(sizing["target_notional_resolved_qty"])), Decimal("150")
        )
        self.assertEqual(Decimal(str(sizing["resolved_qty"])), Decimal("4"))
        self.assertTrue(sizing["precheck_quantity_adjusted"])
        self.assertEqual(
            sizing["precheck_adjustment_reason"], "risk_precheck_capped_quantity"
        )
        self.assertEqual(sizing["precheck_resolved_qty"], "4")
        self.assertEqual(sizing["precheck_expected_target_qty"], "150")
        self.assertTrue(sizing["precheck_capped_by_order"])

    def test_bounded_collection_target_source_rejects_missing_target_sizing(
        self,
    ) -> None:
        from app import config

        now = datetime(2026, 6, 4, 14, 0, tzinfo=timezone.utc)
        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_simple_submit_enabled = True
        config.settings.trading_fractional_equities_enabled = True
        config.settings.trading_allow_shorts = True
        strategy = Strategy(
            id=uuid4(),
            name="microbar-cross-sectional-pairs-v1",
            description="bounded target strategy",
            enabled=True,
            base_timeframe="1Min",
            universe_type="static",
            universe_symbols=["AAPL", "AMZN"],
            max_notional_per_trade=Decimal("100000"),
        )
        target_metadata = {
            "candidate_id": "c88421d619759b2cfaa6f4d0",
            "hypothesis_id": "H-PAIRS-01",
            "account_label": "TORGHUT_SIM",
            "observed_stage": "paper",
            "source_kind": "paper_route_probe_runtime_observed",
            "source_manifest_ref": "config/trading/hypotheses/h-pairs.json",
            "runtime_strategy_name": "microbar-cross-sectional-pairs-v1",
            "strategy_name": "microbar-cross-sectional-pairs-v1",
            "strategy_family": "microbar_cross_sectional_pairs",
            "paper_route_probe_symbols": ["AAPL", "AMZN"],
            "paper_route_probe_symbol_actions": {
                "AAPL": "buy",
                "AMZN": "sell",
            },
            "paper_route_probe_symbol_quantities": {
                "AAPL": "1",
                "AMZN": "1",
            },
            "bounded_evidence_collection_authorized": True,
            "bounded_live_paper_collection_authorized": True,
            "evidence_collection_ok": True,
            "source_decision_readiness": {"ready": True, "blockers": []},
            "promotion_allowed": False,
            "final_promotion_allowed": False,
            "final_promotion_authorized": False,
        }
        decision = StrategyDecision(
            strategy_id=str(strategy.id),
            symbol="AMZN",
            event_ts=now,
            timeframe="1Min",
            action="sell",
            qty=Decimal("1"),
            rationale="bounded paper-route target source",
            params={
                "paper_route_target_plan": target_metadata,
                "source_decision_mode": (
                    BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE
                ),
                "profit_proof_eligible": True,
            },
        )
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
            price_fetcher=FakePriceFetcher(
                Decimal("250"),
                spread=Decimal("0.02"),
                bid=Decimal("250"),
                ask=Decimal("250.02"),
            ),
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

            prepared = pipeline._prepare_decision_for_submission(
                SubmissionPreparationRequest(
                    session=session,
                    decision=decision,
                    decision_row=row,
                    strategy=strategy,
                    account={
                        "equity": "200000",
                        "cash": "200000",
                        "buying_power": "200000",
                    },
                    positions=[],
                )
            )
            session.refresh(row)
            row_json = cast(dict[str, Any], row.decision_json)
            params = cast(dict[str, Any], row_json["params"])
            sizing = cast(dict[str, Any], params["paper_route_target_notional_sizing"])

        self.assertIsNone(prepared)
        self.assertEqual(row.status, "rejected")
        self.assertEqual(
            row_json["reject_reason_atomic"],
            ["bounded_paper_route_target_notional_sizing_missing"],
        )
        self.assertEqual(
            sizing["blockers"],
            ["bounded_paper_route_target_notional_cap_missing"],
        )

    def test_bounded_collection_target_source_rejects_entry_after_exit_window(
        self,
    ) -> None:
        from app import config

        now = datetime(2026, 6, 5, 19, 52, tzinfo=timezone.utc)
        exit_due_at = datetime(2026, 6, 5, 19, 45, tzinfo=timezone.utc)
        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_simple_submit_enabled = True
        config.settings.trading_fractional_equities_enabled = True
        config.settings.trading_allow_shorts = True
        strategy = Strategy(
            id=uuid4(),
            name="microbar-cross-sectional-pairs-v1",
            description="bounded target strategy",
            enabled=True,
            base_timeframe="1Min",
            universe_type="static",
            universe_symbols=["AAPL", "AMZN"],
            max_notional_per_trade=Decimal("100000"),
        )
        target_metadata = {
            "candidate_id": "c88421d619759b2cfaa6f4d0",
            "hypothesis_id": "H-PAIRS-01",
            "account_label": "TORGHUT_SIM",
            "observed_stage": "paper",
            "source_kind": "paper_route_probe_runtime_observed",
            "source_manifest_ref": "config/trading/hypotheses/h-pairs.json",
            "runtime_strategy_name": "microbar-cross-sectional-pairs-v1",
            "strategy_name": "microbar-cross-sectional-pairs-v1",
            "strategy_family": "microbar_cross_sectional_pairs",
            "paper_route_probe_symbols": ["AAPL", "AMZN"],
            "paper_route_probe_symbol_actions": {
                "AAPL": "buy",
                "AMZN": "sell",
            },
            "paper_route_probe_symbol_quantities": {
                "AAPL": "1",
                "AMZN": "1",
            },
            "paper_route_probe_next_session_max_notional": "75000",
            "bounded_evidence_collection_authorized": True,
            "bounded_live_paper_collection_authorized": True,
            "evidence_collection_ok": True,
            "source_decision_readiness": {"ready": True, "blockers": []},
            "promotion_allowed": False,
            "final_promotion_allowed": False,
            "final_promotion_authorized": False,
            "exit_due_at": exit_due_at.isoformat(),
        }
        decision = StrategyDecision(
            strategy_id=str(strategy.id),
            symbol="AAPL",
            event_ts=now,
            timeframe="1Min",
            action="buy",
            qty=Decimal("1"),
            rationale="bounded paper-route target source after exit",
            params={
                "paper_route_target_plan": target_metadata,
                "source_decision_mode": (
                    BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE
                ),
                "profit_proof_eligible": True,
            },
        )
        price_fetcher = FakePriceFetcher(
            Decimal("250"),
            spread=Decimal("0.02"),
            bid=Decimal("250"),
            ask=Decimal("250.02"),
        )
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
            price_fetcher=price_fetcher,
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

            prepared = pipeline._prepare_decision_for_submission(
                SubmissionPreparationRequest(
                    session=session,
                    decision=decision,
                    decision_row=row,
                    strategy=strategy,
                    account={
                        "equity": "200000",
                        "cash": "200000",
                        "buying_power": "200000",
                    },
                    positions=[],
                )
            )
            session.refresh(row)
            row_json = cast(dict[str, Any], row.decision_json)
            params = cast(dict[str, Any], row_json["params"])
            exit_window = cast(
                dict[str, Any],
                params["bounded_paper_route_target_exit_window"],
            )
            target_plan = cast(dict[str, Any], params["paper_route_target_plan"])

        self.assertIsNone(prepared)
        self.assertEqual(row.status, "rejected")
        self.assertEqual(
            row_json["reject_reason_atomic"],
            ["bounded_paper_route_target_exit_window_elapsed"],
        )
        self.assertEqual(price_fetcher.snapshot_requests, 0)
        self.assertEqual(
            exit_window["reason"], "bounded_paper_route_target_exit_window_elapsed"
        )
        self.assertEqual(exit_window["event_ts"], now.isoformat())
        self.assertEqual(exit_window["exit_due_at"], exit_due_at.isoformat())
        self.assertEqual(
            target_plan["bounded_paper_route_target_exit_window"], exit_window
        )

    def test_bounded_collection_target_sizing_helper_fail_closed_branches(
        self,
    ) -> None:
        from app import config

        now = datetime(2026, 6, 4, 14, 0, tzinfo=timezone.utc)
        config.settings.trading_mode = "paper"
        config.settings.trading_fractional_equities_enabled = True
        config.settings.trading_allow_shorts = True
        strategy = Strategy(
            id=uuid4(),
            name="microbar-cross-sectional-pairs-v1",
            description="bounded target strategy",
            enabled=True,
            base_timeframe="1Min",
            universe_type="static",
            universe_symbols=["AAPL", "AMZN"],
            max_notional_per_trade=Decimal("100000"),
        )
        pipeline = object.__new__(SimpleTradingPipeline)
        direct_quote_decision = StrategyDecision(
            strategy_id=str(strategy.id),
            symbol="AAPL",
            event_ts=now,
            timeframe="1Min",
            action="buy",
            qty=Decimal("1"),
            rationale="direct quote fallback",
            params={
                "price": Decimal("100"),
                "imbalance_bid_px": Decimal("99.99"),
                "imbalance_ask_px": Decimal("100.01"),
                "imbalance_spread": Decimal("0.02"),
            },
        )
        direct_quote = SimpleTradingPipeline._decision_quote_snapshot_for_target_sizing(
            direct_quote_decision
        )
        assert direct_quote is not None
        self.assertEqual(direct_quote["price"], "100")
        self.assertIsNone(
            SimpleTradingPipeline._decision_quote_snapshot_for_target_sizing(
                direct_quote_decision.model_copy(update={"params": {}})
            )
        )

        nested_audit = {"sizing_source": "target_notional", "resolved_qty": "3"}
        self.assertEqual(
            _target_notional_sizing_audit_from_params(
                {"execution": {"paper_route_target_notional_sizing": nested_audit}}
            ),
            nested_audit,
        )

        base_params = {
            "source_decision_mode": BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE,
            "profit_proof_eligible": True,
        }
        missing_metadata_decision = StrategyDecision(
            strategy_id=str(strategy.id),
            symbol="AAPL",
            event_ts=now,
            timeframe="1Min",
            action="buy",
            qty=Decimal("1"),
            rationale="missing bounded target metadata",
            params=base_params,
        )
        sized, reason = pipeline._bounded_collection_target_notional_sized_decision(
            decision=missing_metadata_decision,
            strategy=strategy,
            positions=[],
        )
        self.assertEqual(reason, "bounded_paper_route_target_notional_sizing_missing")
        self.assertEqual(
            sized.params["paper_route_target_notional_sizing"]["blockers"],
            ["bounded_paper_route_target_metadata_missing"],
        )

        def bounded_decision(
            *,
            symbol: str,
            action: Literal["buy", "sell"],
            target: Mapping[str, Any],
            params_extra: Mapping[str, Any] | None = None,
        ) -> StrategyDecision:
            return StrategyDecision(
                strategy_id=str(strategy.id),
                symbol=symbol,
                event_ts=now,
                timeframe="1Min",
                action=action,
                qty=Decimal("1"),
                rationale="bounded target helper branch",
                params={
                    **base_params,
                    "paper_route_target_plan": dict(target),
                    **dict(params_extra or {}),
                },
            )

        appended_symbol_decision = bounded_decision(
            symbol="AAPL",
            action="buy",
            target={
                "paper_route_probe_next_session_max_notional": "1000",
                "price_snapshot": {"symbol": "AAPL", "ask": "100", "bid": "99.99"},
            },
        )
        sized, reason = pipeline._bounded_collection_target_notional_sized_decision(
            decision=appended_symbol_decision,
            strategy=strategy,
            positions=[],
        )
        self.assertIsNone(reason)
        self.assertEqual(
            sized.params["paper_route_target_notional_sizing"]["symbols"], ["AAPL"]
        )

        missing_price_decision = bounded_decision(
            symbol="AAPL",
            action="buy",
            target={
                "paper_route_probe_symbols": ["AAPL"],
                "paper_route_probe_next_session_max_notional": "1000",
            },
        )
        sized, reason = pipeline._bounded_collection_target_notional_sized_decision(
            decision=missing_price_decision,
            strategy=strategy,
            positions=[],
        )
        self.assertEqual(reason, "bounded_paper_route_target_notional_sizing_missing")
        self.assertEqual(
            sized.params["paper_route_target_notional_sizing"]["blockers"],
            ["paper_route_target_notional_price_missing"],
        )

        tiny_target_decision = bounded_decision(
            symbol="AAPL",
            action="buy",
            target={
                "paper_route_probe_symbols": ["AAPL"],
                "paper_route_probe_next_session_max_notional": "0.00001",
                "price_snapshot": {"symbol": "AAPL", "ask": "100", "bid": "99.99"},
            },
        )
        sized, reason = pipeline._bounded_collection_target_notional_sized_decision(
            decision=tiny_target_decision,
            strategy=strategy,
            positions=[],
        )
        self.assertEqual(reason, "bounded_paper_route_target_notional_sizing_missing")
        self.assertEqual(
            sized.params["paper_route_target_notional_sizing"]["blockers"],
            ["paper_route_target_notional_qty_below_min_step"],
        )

        broker_zero_decision = bounded_decision(
            symbol="AMZN",
            action="sell",
            target={
                "paper_route_probe_symbols": ["AMZN"],
                "paper_route_probe_symbol_actions": {"AMZN": "sell"},
                "paper_route_probe_next_session_max_notional": "50",
                "price_snapshot": {"symbol": "AMZN", "bid": "100", "ask": "100.01"},
            },
        )
        sized, reason = pipeline._bounded_collection_target_notional_sized_decision(
            decision=broker_zero_decision,
            strategy=strategy,
            positions=[],
        )
        self.assertEqual(reason, "bounded_paper_route_target_notional_sizing_missing")
        self.assertIn(
            "paper_route_target_notional_broker_qty_below_min_step",
            sized.params["paper_route_target_notional_sizing"]["blockers"],
        )

    def test_paper_route_target_price_only_snapshot_refreshes_executable_quote(
        self,
    ) -> None:
        from app import config

        now = datetime(2026, 6, 1, 14, 0, tzinfo=timezone.utc)
        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_simple_submit_enabled = True
        config.settings.trading_fractional_equities_enabled = True
        strategy = Strategy(
            id=uuid4(),
            name="microbar-cross-sectional-pairs-v1",
            description="bounded target strategy",
            enabled=True,
            base_timeframe="1Min",
            universe_type="static",
            universe_symbols=["AAPL"],
            max_notional_per_trade=Decimal("1000"),
        )
        decision = StrategyDecision(
            strategy_id=str(strategy.id),
            symbol="AAPL",
            event_ts=now,
            timeframe="1Min",
            action="buy",
            qty=Decimal("1"),
            rationale="paper-route-target-source",
            params={
                "paper_route_target_plan": {"candidate_id": "c88421d619759b2cfaa6f4d0"},
                "source_decision_mode": ROUTE_ACQUISITION_SOURCE_DECISION_MODE,
                "price": Decimal("190.12"),
                "price_snapshot": {
                    "as_of": now.isoformat(),
                    "price": "190.12",
                    "spread": "0.04",
                    "source": "decision_engine_price_only",
                },
            },
        )
        price_fetcher = FakePriceFetcher(
            Decimal("190.12"),
            spread=Decimal("0.04"),
            bid=Decimal("190.10"),
            ask=Decimal("190.14"),
        )
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
            price_fetcher=price_fetcher,
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

            prepared = pipeline._prepare_decision_for_submission(
                SubmissionPreparationRequest(
                    session=session,
                    decision=decision,
                    decision_row=row,
                    strategy=strategy,
                    account={
                        "equity": "100000",
                        "cash": "100000",
                        "buying_power": "100000",
                    },
                    positions=[],
                )
            )
            session.refresh(row)
            row_json = cast(dict[str, Any], row.decision_json)
            params = cast(dict[str, Any], row_json.get("params"))
            routeability = cast(dict[str, Any], params.get("quote_routeability"))
            refreshed_snapshot = cast(dict[str, Any], params.get("price_snapshot"))

        self.assertIsNotNone(prepared)
        self.assertEqual(price_fetcher.snapshot_requests, 1)
        self.assertEqual(routeability.get("status"), "accepted")
        self.assertEqual(routeability.get("reason"), "executable_quote_ready")
        self.assertEqual(refreshed_snapshot.get("bid"), "190.10")
        self.assertEqual(refreshed_snapshot.get("ask"), "190.14")
        self.assertEqual(row.status, "planned")

    def test_paper_route_quote_routeability_retries_rejected_decision_when_quote_recovers(
        self,
    ) -> None:
        from app import config

        now = datetime(2026, 6, 1, 14, 0, tzinfo=timezone.utc)
        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_simple_submit_enabled = True
        config.settings.trading_fractional_equities_enabled = True
        config.settings.trading_simple_paper_route_probe_retry_attempt_limit = 1
        strategy = Strategy(
            id=uuid4(),
            name="microbar-cross-sectional-pairs-v1",
            description="bounded target strategy",
            enabled=True,
            base_timeframe="1Min",
            universe_type="static",
            universe_symbols=["AAPL"],
            max_notional_per_trade=Decimal("1000"),
        )
        decision = StrategyDecision(
            strategy_id=str(strategy.id),
            symbol="AAPL",
            event_ts=now,
            timeframe="1Min",
            action="buy",
            qty=Decimal("1"),
            rationale="paper-route-target-source",
            params={
                "paper_route_target_plan": {
                    "candidate_id": "c88421d619759b2cfaa6f4d0",
                    "hypothesis_id": "H-PAIRS-01",
                    "account_label": "TORGHUT_SIM",
                    "observed_stage": "paper",
                    "source_kind": "paper_route_probe_runtime_observed",
                    "source_manifest_ref": "config/trading/hypotheses/h-pairs.json",
                    "runtime_strategy_name": "microbar-cross-sectional-pairs-v1",
                    "strategy_name": "microbar-cross-sectional-pairs-v1",
                    "strategy_family": "microbar_cross_sectional_pairs",
                    "paper_route_probe_symbols": ["AAPL"],
                    "paper_route_probe_symbol_quantities": {"AAPL": "1"},
                    "paper_route_probe_next_session_max_notional": "250",
                    "bounded_evidence_collection_authorized": True,
                    "bounded_live_paper_collection_authorized": True,
                    "evidence_collection_ok": True,
                    "source_decision_readiness": {"ready": True, "blockers": []},
                    "promotion_allowed": False,
                    "final_promotion_allowed": False,
                    "final_promotion_authorized": False,
                },
                "source_decision_mode": BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE,
                "profit_proof_eligible": True,
            },
        )
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
            price_fetcher=FakePriceFetcher(
                Decimal("190.12"),
                spread=Decimal("0.04"),
                bid=Decimal("190.10"),
                ask=Decimal("190.14"),
            ),
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
            row.status = "rejected"
            decision_json = cast(dict[str, Any], row.decision_json)
            params = cast(dict[str, Any], decision_json["params"])
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
            decision_json["reject_reason_atomic"] = ["missing_executable_quote"]
            row.decision_json = decision_json
            session.add(row)
            session.commit()

            reopened = pipeline._ensure_pending_decision_row(
                session=session,
                decision=decision,
                strategy=strategy,
            )
            assert reopened is not None
            session.refresh(row)
            reopened_json = cast(dict[str, Any], row.decision_json)
            self.assertEqual(row.status, "planned")
            self.assertEqual(
                reopened_json.get("submission_stage"),
                "paper_route_quote_routeability_retry_pending",
            )
            self.assertEqual(
                cast(
                    dict[str, Any],
                    reopened_json["paper_route_quote_routeability_retry"],
                )["previous_quote_routeability_reason"],
                "missing_executable_quote",
            )

            prepared = pipeline._prepare_decision_for_submission(
                SubmissionPreparationRequest(
                    session=session,
                    decision=decision,
                    decision_row=row,
                    strategy=strategy,
                    account={
                        "equity": "100000",
                        "cash": "100000",
                        "buying_power": "100000",
                    },
                    positions=[],
                )
            )
            session.refresh(row)
            final_params = cast(
                dict[str, Any], cast(dict[str, Any], row.decision_json)["params"]
            )
            routeability = cast(dict[str, Any], final_params.get("quote_routeability"))

        self.assertIsNotNone(prepared)
        self.assertEqual(routeability.get("status"), "accepted")
        self.assertEqual(routeability.get("reason"), "executable_quote_ready")
        self.assertFalse(routeability.get("promotion_allowed"))
        self.assertFalse(routeability.get("final_authority_ok"))
        self.assertEqual(row.status, "planned")

    def test_decision_price_uses_existing_executable_quote_without_refetch(
        self,
    ) -> None:
        now = datetime(2026, 6, 1, 14, 0, tzinfo=timezone.utc)
        price_fetcher = FakePriceFetcher(Decimal("190.12"))
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
            price_fetcher=price_fetcher,
        )
        non_paper_route_decision = StrategyDecision(
            strategy_id=str(uuid4()),
            symbol="AAPL",
            event_ts=now,
            timeframe="1Min",
            action="buy",
            qty=Decimal("1"),
            rationale="strategy-signal",
            params={
                "price": Decimal("190.12"),
                "price_snapshot": {"price": "190.12", "spread": "0.04"},
            },
        )
        nested_quote_decision = StrategyDecision(
            strategy_id=str(uuid4()),
            symbol="AAPL",
            event_ts=now,
            timeframe="1Min",
            action="buy",
            qty=Decimal("1"),
            rationale="paper-route-target-source",
            params={
                "paper_route_target_plan": {"candidate_id": "c88421d619759b2cfaa6f4d0"},
                "source_decision_mode": ROUTE_ACQUISITION_SOURCE_DECISION_MODE,
                "price": Decimal("190.12"),
                "price_snapshot": {
                    "price": "190.12",
                    "bid": "190.10",
                    "ask": "190.14",
                },
            },
        )
        top_level_quote_decision = nested_quote_decision.model_copy(
            update={
                "params": {
                    "paper_route_target_plan": {
                        "candidate_id": "c88421d619759b2cfaa6f4d0"
                    },
                    "source_decision_mode": ROUTE_ACQUISITION_SOURCE_DECISION_MODE,
                    "price": Decimal("190.12"),
                    "imbalance_bid_px": "190.10",
                    "imbalance_ask_px": "190.14",
                }
            }
        )

        for decision in (
            non_paper_route_decision,
            nested_quote_decision,
            top_level_quote_decision,
        ):
            prepared, snapshot = pipeline._ensure_decision_price(
                decision,
                Decimal("190.12"),
            )
            self.assertIs(prepared, decision)
            self.assertIsNone(snapshot)

        self.assertEqual(price_fetcher.snapshot_requests, 0)
