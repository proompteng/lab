from __future__ import annotations

from tests.pipeline.trading_pipeline_base import (
    Any,
    BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE,
    Decimal,
    DecisionEngine,
    FakeAlpacaClient,
    FakeIngestor,
    FakePriceFetcher,
    MarketSnapshot,
    NoSignalReasonIngestor,
    OrderExecutor,
    OrderFirewall,
    PriceFetcher,
    ROUTE_ACQUISITION_SOURCE_DECISION_MODE,
    Reconciler,
    RiskEngine,
    SimpleNamespace,
    SimpleTradingPipeline,
    Strategy,
    StrategyDecision,
    TradeDecision,
    TradingPipelineTestCaseBase,
    TradingState,
    UniverseResolver,
    cast,
    datetime,
    materialize_bounded_paper_route_target_plan,
    patch,
    select,
    timezone,
    uuid4,
)


class TestTradingPipelineMaterializedTargetPlanB(TradingPipelineTestCaseBase):
    def test_simple_pipeline_processes_materialized_target_plan_when_signal_ingest_unavailable(
        self,
    ) -> None:
        from app import config

        now = datetime(2026, 5, 26, 14, 0, tzinfo=timezone.utc)
        window_start = datetime(2026, 5, 26, 13, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 5, 26, 20, 0, tzinfo=timezone.utc)
        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_pipeline_mode": config.settings.trading_pipeline_mode,
            "trading_simple_submit_enabled": config.settings.trading_simple_submit_enabled,
            "trading_fractional_equities_enabled": config.settings.trading_fractional_equities_enabled,
            "trading_simple_paper_route_probe_enabled": (
                config.settings.trading_simple_paper_route_probe_enabled
            ),
            "trading_simple_paper_route_probe_max_notional": (
                config.settings.trading_simple_paper_route_probe_max_notional
            ),
            "trading_paper_route_target_plan_url": config.settings.trading_paper_route_target_plan_url,
            "trading_universe_source": config.settings.trading_universe_source,
            "trading_static_symbols_raw": config.settings.trading_static_symbols_raw,
            "trading_universe_static_fallback_enabled": (
                config.settings.trading_universe_static_fallback_enabled
            ),
            "trading_universe_static_fallback_symbols_raw": (
                config.settings.trading_universe_static_fallback_symbols_raw
            ),
        }
        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_mode = "paper"
        config.settings.trading_pipeline_mode = "simple"
        config.settings.trading_simple_submit_enabled = True
        config.settings.trading_fractional_equities_enabled = True
        config.settings.trading_simple_paper_route_probe_enabled = True
        config.settings.trading_simple_paper_route_probe_max_notional = 500.0
        config.settings.trading_paper_route_target_plan_url = ""
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"
        config.settings.trading_universe_static_fallback_enabled = True
        config.settings.trading_universe_static_fallback_symbols_raw = "AAPL"

        try:
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

                materialized = materialize_bounded_paper_route_target_plan(
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
                                "bounded_collection_stage": (
                                    "bounded_paper_collection"
                                ),
                                "target_notional": "200",
                                "target_quantity": "1",
                                "paper_route_probe_next_session_max_notional": "200",
                                "paper_route_probe_window_start": (
                                    window_start.isoformat()
                                ),
                                "paper_route_probe_window_end": (
                                    window_end.isoformat()
                                ),
                                "paper_route_probe_symbols": ["AAPL"],
                                "paper_route_probe_symbol_actions": {"AAPL": "buy"},
                                "paper_route_probe_symbol_quantities": {"AAPL": "1"},
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
                                "bounded_evidence_collection_blockers": [],
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
                self.assertEqual(len(materialized["decisions"]), 1)
                session.commit()

            alpaca_client = FakeAlpacaClient()
            ingestor = NoSignalReasonIngestor(no_signal_reason="clickhouse_url_missing")
            pipeline = SimpleTradingPipeline(
                alpaca_client=alpaca_client,
                order_firewall=OrderFirewall(alpaca_client),
                ingestor=ingestor,
                decision_engine=DecisionEngine(),
                risk_engine=RiskEngine(),
                executor=OrderExecutor(),
                execution_adapter=alpaca_client,
                reconciler=Reconciler(),
                universe_resolver=UniverseResolver(),
                state=TradingState(),
                account_label="TORGHUT_SIM",
                session_factory=self.session_local,
                price_fetcher=FakePriceFetcher(
                    Decimal("100"),
                    spread=Decimal("0.02"),
                    bid=Decimal("99.99"),
                    ask=Decimal("100.01"),
                ),
            )
            pipeline._is_market_session_open = lambda _now=None: True

            with (
                patch.object(
                    SimpleTradingPipeline,
                    "_profitability_proof_floor",
                    return_value={
                        "route_state": "repair_only",
                        "capital_state": "zero_notional",
                        "max_notional": "0",
                        "market_window": {"session_open": True},
                        "blocking_reasons": ["alpha_readiness_not_promotion_eligible"],
                    },
                ),
                patch(
                    "app.trading.scheduler.simple_pipeline.trading_now",
                    return_value=now,
                ),
                patch(
                    "app.trading.scheduler.pipeline.run_cycle.trading_now",
                    return_value=now,
                ),
                patch("app.trading.simulation.trading_now", return_value=now),
            ):
                pipeline.run_once()

            self.assertEqual(len(alpaca_client.submitted), 1)
            self.assertEqual(alpaca_client.submitted[0]["symbol"], "AAPL")
            self.assertEqual(alpaca_client.submitted[0]["side"], "buy")
            blocker = pipeline.state.last_bounded_evidence_collection_blocker
            self.assertEqual(blocker["reason"], "clickhouse_url_missing")
            with self.session_local() as session:
                decision = session.execute(select(TradeDecision)).scalar_one()
                self.assertEqual(decision.status, "submitted")
        finally:
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_pipeline_mode = original["trading_pipeline_mode"]
            config.settings.trading_simple_submit_enabled = original[
                "trading_simple_submit_enabled"
            ]
            config.settings.trading_fractional_equities_enabled = original[
                "trading_fractional_equities_enabled"
            ]
            config.settings.trading_simple_paper_route_probe_enabled = original[
                "trading_simple_paper_route_probe_enabled"
            ]
            config.settings.trading_simple_paper_route_probe_max_notional = original[
                "trading_simple_paper_route_probe_max_notional"
            ]
            config.settings.trading_paper_route_target_plan_url = original[
                "trading_paper_route_target_plan_url"
            ]
            config.settings.trading_universe_source = original[
                "trading_universe_source"
            ]
            config.settings.trading_static_symbols_raw = original[
                "trading_static_symbols_raw"
            ]
            config.settings.trading_universe_static_fallback_enabled = original[
                "trading_universe_static_fallback_enabled"
            ]
            config.settings.trading_universe_static_fallback_symbols_raw = original[
                "trading_universe_static_fallback_symbols_raw"
            ]

    def test_materialized_target_plan_helpers_reject_bad_source_payloads(
        self,
    ) -> None:
        row = TradeDecision(decision_json=[])
        self.assertIsNone(
            SimpleTradingPipeline._paper_route_materialized_source_payload(row)
        )

        row.decision_json = {"params": None}
        self.assertIsNone(
            SimpleTradingPipeline._paper_route_materialized_source_payload(row)
        )

        row.decision_json = {
            "submission_stage": "planned",
            "params": {
                "paper_route_target_plan_materialized": False,
                "source_decision_mode": BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE,
            },
        }
        self.assertIsNone(
            SimpleTradingPipeline._paper_route_materialized_source_payload(row)
        )

        row.decision_json = {
            "params": {
                "paper_route_target_plan_materialized": True,
                "source": "manual",
                "source_decision_mode": BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE,
            },
        }
        self.assertIsNone(
            SimpleTradingPipeline._paper_route_materialized_source_payload(row)
        )

        row.decision_json = {
            "params": {
                "paper_route_target_plan_materialized": True,
                "source": "paper_route_target_plan_materializer",
                "source_decision_mode": ROUTE_ACQUISITION_SOURCE_DECISION_MODE,
            },
        }
        self.assertIsNone(
            SimpleTradingPipeline._paper_route_materialized_source_payload(row)
        )

    def test_materialized_target_plan_target_payload_defaults_runtime_identity(
        self,
    ) -> None:
        self.assertIsNone(
            SimpleTradingPipeline._paper_route_materialized_target_from_payload(
                {"params": None}
            )
        )
        self.assertIsNone(
            SimpleTradingPipeline._paper_route_materialized_target_from_payload(
                {"params": {}}
            )
        )

        target = SimpleTradingPipeline._paper_route_materialized_target_from_payload(
            {
                "target_plan_identity": {
                    "window_start": "2026-05-26T13:30:00+00:00",
                    "window_end": "2026-05-26T20:00:00+00:00",
                    "source_account_label": "TORGHUT_REPLAY",
                    "source_kind": "paper_route_probe_runtime_observed",
                },
                "params": {
                    "paper_route_target_plan_source_decision": {
                        "hypothesis_id": "H-PAIRS-01",
                        "candidate_id": "c88421d619759b2cfaa6f4d0",
                        "runtime_strategy_name": "microbar-cross-sectional-pairs-v1",
                        "account_label": "TORGHUT_SIM",
                    }
                },
            }
        )

        self.assertIsNotNone(target)
        typed_target = cast(dict[str, Any], target)
        self.assertEqual(
            typed_target["paper_route_probe_window_start"],
            "2026-05-26T13:30:00+00:00",
        )
        self.assertEqual(
            typed_target["paper_route_probe_window_end"],
            "2026-05-26T20:00:00+00:00",
        )
        self.assertEqual(
            typed_target["account_stage_runtime_identity"]["source_account_label"],
            "TORGHUT_REPLAY",
        )
        self.assertFalse(typed_target["final_promotion_allowed"])

    def test_materialized_target_plan_decision_builder_defaults_event_time(
        self,
    ) -> None:
        strategy = Strategy(
            id=uuid4(),
            name="microbar-cross-sectional-pairs-v1",
            description="bounded H-PAIRS materialized target",
            enabled=True,
            base_timeframe="1Min",
            universe_type="static",
            universe_symbols=["AAPL"],
            max_notional_per_trade=Decimal("1000"),
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
            price_fetcher=FakePriceFetcher(Decimal("100")),
        )
        window_start = datetime(2026, 5, 26, 13, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 5, 26, 20, 0, tzinfo=timezone.utc)
        target = {
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
            "paper_route_probe_symbols": ["AAPL"],
            "paper_route_probe_symbol_actions": {"AAPL": "buy"},
            "paper_route_probe_symbol_quantities": {"AAPL": "1"},
        }
        decision_row = TradeDecision(
            id=uuid4(),
            strategy_id=strategy.id,
            alpaca_account_label="TORGHUT_SIM",
            symbol="AAPL",
            timeframe="1Min",
            decision_json={"params": {}},
            decision_hash="materialized-default-event-hash",
            created_at=datetime(2026, 5, 26, 14, 0),
        )

        decision = pipeline._paper_route_materialized_decision_with_execution_metadata(
            decision_row=decision_row,
            payload={"params": {}},
            target=target,
            strategy=strategy,
            symbol="AAPL",
            action="buy",
            window_start=window_start,
            window_end=window_end,
            max_notional=Decimal("200"),
            now=window_start,
        )

        self.assertIsNotNone(decision)
        typed_decision = cast(StrategyDecision, decision)
        self.assertEqual(
            typed_decision.event_ts,
            datetime(2026, 5, 26, 14, 0, tzinfo=timezone.utc),
        )
        self.assertEqual(typed_decision.qty, Decimal("2.0000"))
        sizing = typed_decision.params["paper_route_target_notional_sizing"]
        self.assertEqual(sizing["sizing_source"], "target_notional")
        self.assertEqual(sizing["requested_qty"], "1")
        self.assertEqual(sizing["resolved_qty"], "2.0000")
        self.assertEqual(sizing["symbol_notional_budget"], "200")
        self.assertEqual(typed_decision.params["reference_price"], Decimal("100"))

        rejected = pipeline._paper_route_materialized_decision_with_execution_metadata(
            decision_row=decision_row,
            payload={"qty": "-1", "params": {}},
            target={
                key: value
                for key, value in target.items()
                if key != "paper_route_probe_symbol_quantities"
            },
            strategy=strategy,
            symbol="AAPL",
            action="buy",
            window_start=window_start,
            window_end=window_end,
            max_notional=Decimal("200"),
            now=window_start,
        )
        self.assertIsNone(rejected)

        pipeline.price_fetcher = cast(
            PriceFetcher,
            SimpleNamespace(
                fetch_market_snapshot=lambda signal: MarketSnapshot(
                    symbol=signal.symbol,
                    as_of=signal.event_ts,
                    price=None,
                    spread=None,
                    source="fixture_missing_price",
                )
            ),
        )
        missing_price = (
            pipeline._paper_route_materialized_decision_with_execution_metadata(
                decision_row=decision_row,
                payload={"params": {}},
                target=target,
                strategy=strategy,
                symbol="AAPL",
                action="buy",
                window_start=window_start,
                window_end=window_end,
                max_notional=Decimal("200"),
                now=window_start,
            )
        )
        self.assertIsNone(missing_price)
