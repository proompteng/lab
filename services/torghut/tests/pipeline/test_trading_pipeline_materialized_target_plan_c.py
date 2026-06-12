from __future__ import annotations

# ruff: noqa: F403,F405
from tests.pipeline.trading_pipeline_base import *


class TestTradingPipelineMaterializedTargetPlanC(TradingPipelineTestCaseBase):
    def test_materialized_target_plan_planned_decisions_skip_unsafe_rows(
        self,
    ) -> None:
        from app import config

        now = datetime(2026, 5, 26, 14, 0, tzinfo=timezone.utc)
        window_start = datetime(2026, 5, 26, 13, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 5, 26, 20, 0, tzinfo=timezone.utc)
        config.settings.trading_mode = "paper"
        config.settings.trading_simple_paper_route_probe_enabled = True
        config.settings.trading_allow_shorts = False

        with self.session_local() as session:
            strategy = Strategy(
                name="microbar-cross-sectional-pairs-v1",
                description="bounded H-PAIRS materialized target",
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=["AAPL"],
                max_notional_per_trade=Decimal("1000"),
            )
            session.add(strategy)
            session.commit()
            session.refresh(strategy)

            base_target = {
                "hypothesis_id": "H-PAIRS-01",
                "candidate_id": "c88421d619759b2cfaa6f4d0",
                "runtime_strategy_name": "microbar-cross-sectional-pairs-v1",
                "strategy_name": "microbar-cross-sectional-pairs-v1",
                "account_label": "TORGHUT_SIM",
                "source_account_label": "TORGHUT_REPLAY",
                "source_kind": "paper_route_probe_runtime_observed",
                "source_plan_ref": "s3://torghut-proof/hpairs/current-window.json",
                "source_manifest_ref": "config/trading/hypotheses/h-pairs.json",
                "observed_stage": "paper",
                "bounded_collection_stage": "bounded_paper_collection",
                "target_notional": "200",
                "target_quantity": "1",
                "paper_route_probe_next_session_max_notional": "200",
                "paper_route_probe_window_start": window_start.isoformat(),
                "paper_route_probe_window_end": window_end.isoformat(),
                "paper_route_probe_symbols": ["AAPL"],
                "paper_route_probe_symbol_actions": {"AAPL": "buy"},
                "paper_route_probe_symbol_quantities": {"AAPL": "1"},
                "price_snapshots": _target_price_snapshots("AAPL"),
                "source_decision_readiness": {"ready": True, "blockers": []},
                "evidence_collection_ok": True,
                "bounded_evidence_collection_authorized": True,
                "bounded_live_paper_collection_authorized": True,
                "canary_collection_authorized": True,
                "promotion_allowed": False,
                "final_promotion_authorized": False,
                "final_promotion_allowed": False,
            }

            def add_row(
                label: str,
                *,
                target_update: Mapping[str, Any] | None = None,
                symbol: str = "AAPL",
                payload_symbol: str | None = "AAPL",
                payload_action: str | None = "buy",
                strategy_id: Any | None = None,
                materialized: bool = True,
                submission_stage: str = "bounded_paper_route_materialized",
            ) -> TradeDecision:
                target = dict(base_target)
                if target_update:
                    target.update(target_update)
                payload: dict[str, Any] = {
                    "submission_stage": submission_stage,
                    "source": "paper_route_target_plan_materializer",
                    "source_decision_mode": BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE,
                    "params": {
                        "paper_route_target_plan_materialized": materialized,
                        "source_decision_mode": BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE,
                        "paper_route_target_plan_source_decision": target,
                    },
                }
                if payload_symbol is not None:
                    payload["symbol"] = payload_symbol
                if payload_action is not None:
                    payload["action"] = payload_action
                row = TradeDecision(
                    strategy_id=strategy_id or strategy.id,
                    alpaca_account_label="TORGHUT_SIM",
                    symbol=symbol,
                    timeframe="1Min",
                    decision_json=payload,
                    decision_hash=f"materialized-skip-{label}",
                    status="planned",
                )
                session.add(row)
                session.commit()
                session.refresh(row)
                return row

            add_row("not-materialized", materialized=False, submission_stage="planned")
            executed_row = add_row("execution-exists")
            session.add(
                Execution(
                    trade_decision_id=executed_row.id,
                    alpaca_account_label="TORGHUT_SIM",
                    alpaca_order_id="existing-materialized-order",
                    client_order_id=executed_row.decision_hash,
                    symbol="AAPL",
                    side="buy",
                    order_type="market",
                    time_in_force="day",
                    submitted_qty=Decimal("1"),
                    filled_qty=Decimal("0"),
                    status="new",
                    raw_order={},
                )
            )
            session.commit()
            add_row("missing-target", target_update={}, payload_symbol="AAPL")
            missing_target = session.execute(
                select(TradeDecision).where(
                    TradeDecision.decision_hash == "materialized-skip-missing-target"
                )
            ).scalar_one()
            payload = dict(cast(Mapping[str, Any], missing_target.decision_json))
            params = dict(cast(Mapping[str, Any], payload["params"]))
            params.pop("paper_route_target_plan_source_decision", None)
            payload["params"] = params
            missing_target.decision_json = payload
            session.add(missing_target)
            session.commit()
            add_row(
                "blocked",
                target_update={
                    "source_decision_readiness": {
                        "ready": False,
                        "blockers": ["quote_missing"],
                    }
                },
            )
            add_row(
                "not-hpairs",
                target_update={
                    "hypothesis_id": "H-OTHER",
                    "candidate_id": "candidate-other",
                    "account_label": "paper",
                    "strategy_name": "plain-strategy",
                    "runtime_strategy_name": "plain-strategy",
                },
            )
            add_row(
                "missing-window",
                target_update={
                    "paper_route_probe_window_start": None,
                    "paper_route_probe_window_end": None,
                },
            )
            add_row(
                "expired-window",
                target_update={
                    "paper_route_probe_window_start": (
                        window_start - timedelta(days=1)
                    ).isoformat(),
                    "paper_route_probe_window_end": (
                        window_end - timedelta(days=1)
                    ).isoformat(),
                },
            )
            add_row(
                "missing-cap",
                target_update={
                    "paper_route_probe_next_session_max_notional": None,
                    "target_notional": None,
                    "max_notional": None,
                },
            )
            add_row(
                "missing-strategy",
                target_update={
                    "strategy_name": "missing-strategy",
                    "runtime_strategy_name": "missing-strategy",
                },
                strategy_id=uuid4(),
            )
            add_row("missing-symbol", symbol="", payload_symbol=None)
            add_row("not-allowed", symbol="MSFT", payload_symbol="MSFT")
            add_row("invalid-action", payload_action="hold")
            add_row("short-disabled", payload_action="sell")

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
            pipeline._is_market_session_open = lambda _now=None: False  # type: ignore[method-assign]
            with patch(
                "app.trading.scheduler.simple_pipeline.trading_now",
                return_value=now,
            ):
                closed_market_decisions = (
                    pipeline._paper_route_materialized_planned_decisions(
                        session=session,
                        strategies=[strategy],
                        allowed_symbols={"AAPL"},
                        positions=[],
                    )
                )
                pipeline._is_market_session_open = lambda _now=None: True  # type: ignore[method-assign]
                decisions = pipeline._paper_route_materialized_planned_decisions(
                    session=session,
                    strategies=[strategy],
                    allowed_symbols={"AAPL"},
                    positions=[],
                )
                blocked_by_exposure = (
                    pipeline._paper_route_materialized_planned_decisions(
                        session=session,
                        strategies=[strategy],
                        allowed_symbols={"AAPL"},
                        positions=[{"symbol": "ZZZ", "qty": "1"}],
                    )
                )

        self.assertEqual(closed_market_decisions, [])
        self.assertEqual(len(decisions), 1)
        self.assertEqual(decisions[0].action, "buy")
        self.assertEqual(blocked_by_exposure, [])

    def test_materialized_target_plan_reconciles_matching_open_order_projections(
        self,
    ) -> None:
        from app import config

        now = datetime(2026, 5, 26, 14, 0, tzinfo=timezone.utc)
        window_start = datetime(2026, 5, 26, 13, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 5, 26, 20, 0, tzinfo=timezone.utc)
        config.settings.trading_mode = "paper"
        config.settings.trading_simple_paper_route_probe_enabled = True
        config.settings.trading_allow_shorts = True

        with self.session_local() as session:
            strategy = Strategy(
                name="microbar-cross-sectional-pairs-v1",
                description="bounded H-PAIRS materialized target",
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=["AAPL", "AMZN"],
                max_notional_per_trade=Decimal("1000"),
            )
            session.add(strategy)
            session.commit()

            materialize_bounded_paper_route_target_plan(
                session,
                {
                    "targets": [
                        {
                            "hypothesis_id": "H-PAIRS-01",
                            "candidate_id": "c88421d619759b2cfaa6f4d0",
                            "runtime_strategy_name": (
                                "microbar-cross-sectional-pairs-v1"
                            ),
                            "strategy_name": "microbar-cross-sectional-pairs-v1",
                            "account_label": "TORGHUT_SIM",
                            "source_account_label": "TORGHUT_REPLAY",
                            "source_kind": "paper_route_probe_runtime_observed",
                            "source_plan_ref": (
                                "s3://torghut-proof/hpairs/current-window.json"
                            ),
                            "source_manifest_ref": (
                                "config/trading/hypotheses/h-pairs.json"
                            ),
                            "observed_stage": "paper",
                            "bounded_collection_stage": "bounded_paper_collection",
                            "target_notional": "200",
                            "target_quantity": "2",
                            "paper_route_probe_next_session_max_notional": "200",
                            "paper_route_probe_window_start": (
                                window_start.isoformat()
                            ),
                            "paper_route_probe_window_end": window_end.isoformat(),
                            "paper_route_probe_symbols": ["AAPL", "AMZN"],
                            "paper_route_probe_symbol_actions": {
                                "AAPL": "buy",
                                "AMZN": "sell",
                            },
                            "paper_route_probe_symbol_quantities": {
                                "AAPL": "1",
                                "AMZN": "1",
                            },
                            "price_snapshots": _target_price_snapshots("AAPL", "AMZN"),
                            "paper_route_probe_pair_balance_state": "balanced",
                            "paper_route_clean_window_baseline_state": {
                                "state": "clean",
                                "blockers": [],
                            },
                            "paper_route_clean_window_state": "clean",
                            "source_decision_readiness": {
                                "ready": True,
                                "blockers": [],
                            },
                            "bounded_evidence_collection_authorized": True,
                            "bounded_live_paper_collection_authorized": True,
                            "canary_collection_authorized": True,
                            "evidence_collection_ok": True,
                            "runtime_window_import_health_gate_blockers": [],
                            "paper_route_target_account_audit_state": {
                                "state": "available",
                                "audit_available": True,
                                "blockers": [],
                            },
                            "paper_route_target_account_audit_blockers": [],
                            "paper_route_account_pre_session_blockers": [],
                            "paper_route_hpairs_symbol_blockers": [],
                            "promotion_allowed": False,
                            "final_promotion_authorized": False,
                            "final_promotion_allowed": False,
                        },
                    ]
                },
                generated_at=now,
                bounded_notional_limit=Decimal("500"),
            )
            session.commit()
            rows = list(
                session.execute(select(TradeDecision).order_by(TradeDecision.symbol))
                .scalars()
                .all()
            )
            hashes_by_symbol = {str(row.symbol): str(row.decision_hash) for row in rows}

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
            pipeline._is_market_session_open = lambda _now=None: True  # type: ignore[method-assign]

            matching_projection_positions = [
                {
                    "symbol": "AAPL",
                    "qty": "1",
                    "side": "long",
                    "market_value": "100",
                    "open_order_projection": True,
                    "open_order_projection_only": True,
                    "open_order_client_order_ids": [hashes_by_symbol["AAPL"]],
                },
                {
                    "symbol": "AMZN",
                    "qty": "1",
                    "side": "short",
                    "market_value": "-100",
                    "open_order_projection": True,
                    "open_order_projection_only": True,
                    "open_order_client_order_ids": [hashes_by_symbol["AMZN"]],
                },
            ]
            unrelated_projection_positions = [
                {
                    "symbol": "AAPL",
                    "qty": "1",
                    "side": "long",
                    "market_value": "100",
                    "open_order_projection": True,
                    "open_order_projection_only": True,
                    "open_order_client_order_ids": ["unrelated-client-order-id"],
                }
            ]

            with patch(
                "app.trading.scheduler.simple_pipeline.trading_now",
                return_value=now,
            ):
                decisions = pipeline._paper_route_materialized_planned_decisions(
                    session=session,
                    strategies=[strategy],
                    allowed_symbols={"AAPL", "AMZN"},
                    positions=matching_projection_positions,
                )
                blocked_by_unrelated_projection = (
                    pipeline._paper_route_materialized_planned_decisions(
                        session=session,
                        strategies=[strategy],
                        allowed_symbols={"AAPL", "AMZN"},
                        positions=unrelated_projection_positions,
                    )
                )

        self.assertEqual(
            {decision.symbol: decision.action for decision in decisions},
            {"AAPL": "buy", "AMZN": "sell"},
        )
        self.assertEqual(blocked_by_unrelated_projection, [])

    def test_materialized_target_plan_projection_helpers_fail_closed(self) -> None:
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

        self.assertFalse(
            SimpleTradingPipeline._paper_route_position_is_materialized_projection(
                {
                    "symbol": "AAPL",
                    "open_order_projection": True,
                    "open_order_projection_only": False,
                    "open_order_client_order_ids": ["matching-client-order-id"],
                },
                {"matching-client-order-id"},
            )
        )
        self.assertTrue(
            SimpleTradingPipeline._paper_route_position_is_materialized_projection(
                {
                    "symbol": "AAPL",
                    "open_order_projection": True,
                    "open_order_projection_only": True,
                    "open_order_client_order_id": "matching-client-order-id",
                },
                {"matching-client-order-id"},
            )
        )
        self.assertFalse(
            SimpleTradingPipeline._paper_route_position_is_materialized_projection(
                {
                    "symbol": "AAPL",
                    "open_order_projection": True,
                    "open_order_projection_only": True,
                },
                {"matching-client-order-id"},
            )
        )

        with self.session_local() as session:
            decision_without_hash = TradeDecision(
                strategy_id=uuid4(),
                alpaca_account_label="TORGHUT_SIM",
                symbol="AAPL",
                timeframe="1Min",
                decision_json={},
                decision_hash=None,
                status="planned",
            )
            self.assertEqual(
                pipeline._active_materialized_paper_route_client_order_ids(
                    session=session,
                    rows=[decision_without_hash],
                    strategies=[],
                    positions=[],
                    now=datetime(2026, 5, 26, 14, 0, tzinfo=timezone.utc),
                ),
                set(),
            )

    def test_materialized_target_plan_ignores_transient_batch_symbol_filter(
        self,
    ) -> None:
        from app import config

        now = datetime(2026, 5, 26, 14, 0, tzinfo=timezone.utc)
        window_start = datetime(2026, 5, 26, 13, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 5, 26, 20, 0, tzinfo=timezone.utc)
        config.settings.trading_mode = "paper"
        config.settings.trading_simple_paper_route_probe_enabled = True
        config.settings.trading_allow_shorts = True

        with self.session_local() as session:
            strategy = Strategy(
                name="microbar-cross-sectional-pairs-v1",
                description="bounded H-PAIRS materialized target",
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=["AAPL", "AMZN"],
                max_notional_per_trade=Decimal("1000"),
            )
            session.add(strategy)
            session.commit()
            session.refresh(strategy)

            target = {
                "hypothesis_id": "H-PAIRS-01",
                "candidate_id": "c88421d619759b2cfaa6f4d0",
                "runtime_strategy_name": "microbar-cross-sectional-pairs-v1",
                "strategy_name": "microbar-cross-sectional-pairs-v1",
                "account_label": "TORGHUT_SIM",
                "source_account_label": "TORGHUT_REPLAY",
                "source_kind": "paper_route_probe_runtime_observed",
                "source_plan_ref": "config/trading/hypotheses/h-pairs-01.json",
                "source_manifest_ref": "config/trading/hypotheses/h-pairs-01.json",
                "observed_stage": "paper",
                "bounded_collection_stage": "bounded_paper_collection",
                "target_notional": "200",
                "target_quantity": "1",
                "paper_route_probe_next_session_max_notional": "200",
                "paper_route_probe_window_start": window_start.isoformat(),
                "paper_route_probe_window_end": window_end.isoformat(),
                "paper_route_probe_symbols": ["AAPL"],
                "paper_route_probe_symbol_actions": {"AAPL": "buy"},
                "paper_route_probe_symbol_quantities": {"AAPL": "1"},
                "price_snapshots": _target_price_snapshots("AAPL"),
                "paper_route_probe_pair_balance_state": "not_required",
                "source_decision_readiness": {"ready": True, "blockers": []},
                "evidence_collection_ok": True,
                "bounded_evidence_collection_authorized": True,
                "bounded_live_paper_collection_authorized": True,
                "canary_collection_authorized": True,
                "promotion_allowed": False,
                "final_promotion_authorized": False,
                "final_promotion_allowed": False,
            }
            session.add(
                TradeDecision(
                    strategy_id=strategy.id,
                    alpaca_account_label="TORGHUT_SIM",
                    symbol="AAPL",
                    timeframe="1Min",
                    decision_json={
                        "submission_stage": "bounded_paper_route_materialized",
                        "source": "paper_route_target_plan_materializer",
                        "source_decision_mode": (
                            BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE
                        ),
                        "symbol": "AAPL",
                        "action": "buy",
                        "qty": "1",
                        "params": {
                            "paper_route_target_plan_materialized": True,
                            "source": "paper_route_target_plan_materializer",
                            "source_decision_mode": (
                                BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE
                            ),
                            "paper_route_target_plan_source_decision": target,
                        },
                    },
                    decision_hash="materialized-batch-filter-aapl",
                    status="planned",
                    created_at=now,
                )
            )
            session.commit()

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
            pipeline._is_market_session_open = lambda _now=None: True  # type: ignore[method-assign]

            with patch(
                "app.trading.scheduler.simple_pipeline.trading_now",
                return_value=now,
            ):
                decisions = pipeline._paper_route_materialized_planned_decisions(
                    session=session,
                    strategies=[strategy],
                    allowed_symbols={"NVDA"},
                    positions=[],
                )

        self.assertEqual([decision.symbol for decision in decisions], ["AAPL"])
        self.assertEqual(decisions[0].action, "buy")
        self.assertEqual(
            decisions[0].params["paper_route_target_plan"]["candidate_id"],
            "c88421d619759b2cfaa6f4d0",
        )

    def test_materialized_target_plan_process_records_handler_errors(
        self,
    ) -> None:
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
        decision = StrategyDecision(
            strategy_id=str(uuid4()),
            symbol="AAPL",
            event_ts=datetime(2026, 5, 26, 14, 0, tzinfo=timezone.utc),
            timeframe="1Min",
            action="buy",
            qty=Decimal("1"),
            rationale="materialized target",
            params={},
        )
        with self.session_local() as session:
            with (
                patch.object(
                    pipeline,
                    "_paper_route_materialized_planned_decisions",
                    return_value=[decision],
                ),
                patch.object(
                    pipeline,
                    "_handle_decision",
                    side_effect=RuntimeError("submission failed"),
                ),
            ):
                pipeline._process_paper_route_materialized_decisions(
                    session=session,
                    strategies=[],
                    account={},
                    positions=[],
                    allowed_symbols={"AAPL"},
                )

        self.assertEqual(pipeline.state.metrics.orders_rejected_total, 1)

    def test_materialized_target_plan_claim_rejects_stale_or_invalid_rows(
        self,
    ) -> None:
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
            strategy = Strategy(
                name="microbar-cross-sectional-pairs-v1",
                description="bounded H-PAIRS materialized target",
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=["AAPL"],
                max_notional_per_trade=Decimal("1000"),
            )
            session.add(strategy)
            session.commit()
            session.refresh(strategy)

            def decision_with(row_id: str | None) -> StrategyDecision:
                params = (
                    {"paper_route_materialized_trade_decision_id": row_id}
                    if row_id is not None
                    else {}
                )
                return StrategyDecision(
                    strategy_id=str(strategy.id),
                    symbol="AAPL",
                    event_ts=datetime(2026, 5, 26, 14, 0, tzinfo=timezone.utc),
                    timeframe="1Min",
                    action="buy",
                    qty=Decimal("1"),
                    rationale="materialized target",
                    params=params,
                )

            self.assertIsNone(
                pipeline._claim_materialized_paper_route_decision_row(
                    session=session,
                    decision=decision_with(None),
                    strategy=strategy,
                )
            )
            self.assertIsNone(
                pipeline._claim_materialized_paper_route_decision_row(
                    session=session,
                    decision=decision_with("not-a-uuid"),
                    strategy=strategy,
                )
            )
            self.assertIsNone(
                pipeline._claim_materialized_paper_route_decision_row(
                    session=session,
                    decision=decision_with(str(uuid4())),
                    strategy=strategy,
                )
            )

            def add_row(
                label: str,
                *,
                account_label: str = "TORGHUT_SIM",
                status: str = "planned",
            ) -> TradeDecision:
                row = TradeDecision(
                    strategy_id=strategy.id,
                    alpaca_account_label=account_label,
                    symbol="AAPL",
                    timeframe="1Min",
                    decision_json={"params": {}},
                    decision_hash=f"claim-materialized-{label}",
                    status=status,
                )
                session.add(row)
                session.commit()
                session.refresh(row)
                return row

            wrong_account = add_row("wrong-account", account_label="paper")
            submitted = add_row("submitted", status="submitted")
            executed = add_row("executed")
            session.add(
                Execution(
                    trade_decision_id=executed.id,
                    alpaca_account_label="TORGHUT_SIM",
                    alpaca_order_id="claimed-existing-order",
                    client_order_id=executed.decision_hash,
                    symbol="AAPL",
                    side="buy",
                    order_type="market",
                    time_in_force="day",
                    submitted_qty=Decimal("1"),
                    filled_qty=Decimal("0"),
                    status="new",
                    raw_order={},
                )
            )
            session.commit()

            for row in (wrong_account, submitted, executed):
                self.assertIsNone(
                    pipeline._claim_materialized_paper_route_decision_row(
                        session=session,
                        decision=decision_with(str(row.id)),
                        strategy=strategy,
                    )
                )
            self.assertIsNone(
                pipeline._ensure_pending_decision_row(
                    session=session,
                    decision=decision_with(str(uuid4())),
                    strategy=strategy,
                )
            )

    def test_materialized_target_plan_quote_routeability_retry_reopens_row(
        self,
    ) -> None:
        from app import config

        event_ts = datetime(2026, 5, 26, 14, 0, tzinfo=timezone.utc)
        config.settings.trading_mode = "paper"
        config.settings.trading_simple_paper_route_probe_enabled = True
        config.settings.trading_simple_paper_route_probe_retry_attempt_limit = 2
        config.settings.trading_simple_paper_route_probe_retry_batch_limit = 4
        config.settings.trading_simple_paper_route_probe_retry_scan_limit = 16

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
            strategy = Strategy(
                name="microbar-cross-sectional-pairs-v1",
                description="bounded H-PAIRS materialized target",
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=["AAPL"],
                max_notional_per_trade=Decimal("1000"),
            )
            session.add(strategy)
            session.commit()
            session.refresh(strategy)

            row = TradeDecision(
                strategy_id=strategy.id,
                alpaca_account_label="TORGHUT_SIM",
                symbol="AAPL",
                timeframe="1Min",
                decision_json={"params": {}},
                decision_hash="materialized-quote-retry",
                status="planned",
                created_at=event_ts,
            )
            session.add(row)
            session.commit()
            session.refresh(row)

            decision = StrategyDecision(
                strategy_id=str(strategy.id),
                symbol="AAPL",
                event_ts=event_ts,
                timeframe="1Min",
                action="buy",
                qty=Decimal("1"),
                rationale="materialized target",
                params={
                    "paper_route_materialized_trade_decision_id": str(row.id),
                    "paper_route_target_plan": {
                        "candidate_id": "cand-materialized-retry",
                        "hypothesis_id": "H-PAIRS-01",
                    },
                    "paper_route_target_plan_source_decision": {
                        "candidate_id": "cand-materialized-retry",
                        "hypothesis_id": "H-PAIRS-01",
                    },
                    "quote_routeability": {
                        "schema_version": "torghut.paper-route-quote-routeability.v1",
                        "status": "blocked",
                        "reason": "spread_bps_exceeded",
                    },
                },
            )
            decision_json = decision.model_dump(mode="json")
            decision_json["submission_stage"] = "rejected_pre_submit"
            decision_json["reject_reason_atomic"] = ["spread_bps_exceeded"]
            row.status = "rejected"
            row.decision_json = decision_json
            session.add(row)
            session.commit()

            with patch(
                "app.trading.scheduler.simple_pipeline.trading_now",
                return_value=event_ts,
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
            row_json = cast(dict[str, Any], row.decision_json)
            row_params = cast(dict[str, Any], row_json.get("params"))

            self.assertEqual(row.status, "planned")
            self.assertEqual(
                row_json.get("submission_stage"),
                "paper_route_quote_routeability_retry_pending",
            )
            self.assertNotIn("quote_routeability", row_params)
            self.assertEqual(
                row_json.get("paper_route_quote_routeability_retry_attempts"),
                1,
            )
