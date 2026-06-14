from __future__ import annotations

from tests.pipeline.trading_pipeline_base import (
    Any,
    Decimal,
    DecisionEngine,
    Execution,
    FakeAlpacaClient,
    FakeIngestor,
    MarketSnapshot,
    Mock,
    OrderExecutor,
    OrderFirewall,
    Reconciler,
    RiskEngine,
    SignalEnvelope,
    SimpleTradingPipeline,
    Strategy,
    StrategyDecision,
    TradeDecision,
    TradingPipelineTestCaseBase,
    TradingState,
    UniverseResolver,
    _target_price_snapshots,
    cast,
    datetime,
    patch,
    select,
    timedelta,
    timezone,
)


class TestTradingPipelineExternalTargetsC(TradingPipelineTestCaseBase):
    def test_bounded_hpairs_target_source_records_decisions_and_executions(
        self,
    ) -> None:
        from app import config

        window_start = datetime(2026, 6, 1, 13, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 6, 1, 20, 0, tzinfo=timezone.utc)
        now = window_start + timedelta(minutes=15)
        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_pipeline_mode = "simple"
        config.settings.trading_simple_submit_enabled = True
        config.settings.trading_simple_paper_route_probe_enabled = True
        config.settings.trading_allow_shorts = True
        config.settings.trading_fractional_equities_enabled = True
        config.settings.trading_simple_max_notional_per_order = 1000.0
        config.settings.trading_simple_max_notional_per_symbol = 1000.0

        alpaca_client = FakeAlpacaClient()
        pipeline = SimpleTradingPipeline(
            alpaca_client=alpaca_client,
            order_firewall=OrderFirewall(alpaca_client),
            ingestor=FakeIngestor([]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=alpaca_client,
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="TORGHUT_SIM",
            session_factory=self.session_local,
        )
        pipeline._is_market_session_open = lambda _now=None: True

        with self.session_local() as session:
            strategy = Strategy(
                name="microbar-cross-sectional-pairs-v1",
                enabled=True,
                base_timeframe="1Sec",
                universe_type="microbar_cross_sectional_pairs_v1",
                universe_symbols=["AAPL", "AMZN"],
                max_notional_per_trade=Decimal("1000"),
            )
            session.add(strategy)
            session.commit()
            session.refresh(strategy)

            target = {
                "account_label": "TORGHUT_SIM",
                "observed_stage": "paper",
                "source_kind": "paper_route_probe_runtime_observed",
                "candidate_id": "c88421d619759b2cfaa6f4d0",
                "hypothesis_id": "H-PAIRS-01",
                "runtime_strategy_name": "microbar-cross-sectional-pairs-v1",
                "strategy_name": "microbar-cross-sectional-pairs-v1",
                "strategy_lookup_names": [str(strategy.id), strategy.name],
                "strategy_family": "microbar_cross_sectional_pairs",
                "source_manifest_ref": "config/trading/hypotheses/h-pairs-01.json",
                "paper_route_probe_symbols": ["AAPL", "AMZN"],
                "paper_route_probe_symbol_actions": {
                    "AAPL": "buy",
                    "AMZN": "sell",
                },
                "paper_route_probe_window_start": window_start.isoformat(),
                "paper_route_probe_window_end": window_end.isoformat(),
                "paper_route_probe_next_session_max_notional": "0",
                "bounded_evidence_collection_max_notional": "500",
                "max_notional": "0",
                "price_snapshots": _target_price_snapshots("AAPL", "AMZN"),
                "bounded_evidence_collection_authorized": True,
                "bounded_live_paper_collection_authorized": True,
                "bounded_evidence_collection_scope": "paper_route_probe_next_session_only",
                "evidence_collection_ok": True,
                "source_decision_readiness": {"ready": True, "blockers": []},
                "runtime_window_import_health_gate_blockers": [
                    "evidence_continuity_not_ok"
                ],
                "paper_route_account_pre_session_blockers": [],
                "paper_route_hpairs_symbol_blockers": [],
                "promotion_allowed": False,
                "final_promotion_allowed": False,
                "final_promotion_authorized": False,
            }
            proof_floor = {
                "route_state": "repair_only",
                "capital_state": "zero_notional",
                "max_notional": "0",
                "market_window": {"session_open": True},
                "blocking_reasons": ["alpha_readiness_not_promotion_eligible"],
            }

            def priced_decision(
                decision: StrategyDecision, signal_price: object = None
            ) -> tuple[StrategyDecision, MarketSnapshot | None]:
                del signal_price
                params = dict(decision.params)
                params["price"] = Decimal("100")
                params["imbalance_bid_px"] = Decimal("99.99")
                params["imbalance_ask_px"] = Decimal("100.01")
                params["imbalance_spread"] = Decimal("0.02")
                params["price_snapshot"] = {
                    "as_of": now.isoformat(),
                    "quote_as_of": now.isoformat(),
                    "source": "test_executable_quote",
                    "quote_source": "test_executable_quote",
                    "price": "100",
                    "bid": "99.99",
                    "ask": "100.01",
                    "spread": "0.02",
                }
                return decision.model_copy(update={"params": params}), None

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
                patch.object(
                    pipeline,
                    "_ensure_decision_price",
                    side_effect=priced_decision,
                ),
                patch(
                    "app.trading.scheduler.simple_pipeline.trading_now",
                    return_value=now,
                ),
                patch(
                    "app.trading.scheduler.pipeline_modules.run_cycle.trading_now",
                    return_value=now,
                ),
                patch(
                    "app.trading.scheduler.pipeline_modules.decision_lifecycle.trading_now",
                    return_value=now,
                ),
            ):
                pipeline._process_paper_route_target_source_decisions(
                    session=session,
                    strategies=[strategy],
                    account=alpaca_client.get_account(),
                    positions=[],
                    allowed_symbols={"AAPL", "AMZN"},
                )

            decisions = (
                session.execute(select(TradeDecision).order_by(TradeDecision.symbol))
                .scalars()
                .all()
            )
            executions = (
                session.execute(select(Execution).order_by(Execution.symbol))
                .scalars()
                .all()
            )

        self.assertEqual([decision.symbol for decision in decisions], ["AAPL", "AMZN"])
        self.assertEqual(
            [decision.status for decision in decisions], ["submitted", "submitted"]
        )
        self.assertEqual(
            [execution.symbol for execution in executions], ["AAPL", "AMZN"]
        )
        self.assertEqual(len(alpaca_client.submitted), 2)
        for decision in decisions:
            payload = cast(dict[str, Any], decision.decision_json)
            params = cast(dict[str, Any], payload.get("params") or {})
            metadata = cast(dict[str, Any], params.get("paper_route_target_plan") or {})
            self.assertEqual(
                metadata.get("paper_route_probe_next_session_max_notional"), "500"
            )
            self.assertFalse(params.get("promotion_allowed"))
            self.assertFalse(params.get("final_promotion_allowed"))
            self.assertFalse(params.get("final_promotion_authorized"))
            self.assertEqual(params.get("execution_account_label"), "TORGHUT_SIM")

    def test_paper_route_target_source_skips_pair_when_account_not_flat(
        self,
    ) -> None:
        from app import config

        window_start = datetime(2026, 6, 1, 13, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 6, 1, 20, 0, tzinfo=timezone.utc)
        config.settings.trading_mode = "paper"
        config.settings.trading_simple_paper_route_probe_enabled = True
        config.settings.trading_allow_shorts = True
        pipeline = object.__new__(SimpleTradingPipeline)
        setattr(pipeline, "account_label", "TORGHUT_SIM")
        setattr(pipeline, "_is_market_session_open", lambda _now: True)

        with self.session_local() as session:
            strategy = Strategy(
                name="microbar-cross-sectional-pairs-v1",
                enabled=True,
                base_timeframe="1Sec",
                universe_type="microbar_cross_sectional_pairs_v1",
                universe_symbols=["AAPL", "AMZN"],
                max_notional_per_trade=Decimal("1000"),
            )
            session.add(strategy)
            session.commit()
            session.refresh(strategy)
            target = {
                "account_label": "TORGHUT_SIM",
                "observed_stage": "paper",
                "source_kind": "paper_route_probe_runtime_observed",
                "candidate_id": "candidate-pairs-monday",
                "hypothesis_id": "H-PAIRS-01",
                "runtime_strategy_name": "microbar-cross-sectional-pairs-v1",
                "strategy_name": "microbar-cross-sectional-pairs-v1",
                "strategy_lookup_names": [str(strategy.id), strategy.name],
                "strategy_family": "microbar_cross_sectional_pairs",
                "source_manifest_ref": "config/trading/hypotheses/h-pairs-01.json",
                "paper_route_probe_symbols": ["AAPL", "AMZN"],
                "paper_route_probe_symbol_actions": {
                    "AAPL": "buy",
                    "AMZN": "sell",
                },
                "paper_route_probe_window_start": window_start.isoformat(),
                "paper_route_probe_window_end": window_end.isoformat(),
                "paper_route_probe_next_session_max_notional": "1000",
                "bounded_evidence_collection_authorized": True,
                "evidence_collection_ok": True,
                "source_decision_readiness": {"ready": True, "blockers": []},
            }
            setattr(
                pipeline,
                "_external_paper_route_target_probe_symbols_cached",
                lambda **_kwargs: ({"AAPL", "AMZN"}, None, [target]),
            )
            with patch(
                "app.trading.scheduler.simple_pipeline.trading_now",
                return_value=window_start + timedelta(minutes=5),
            ):
                decisions = pipeline._paper_route_target_source_decisions(
                    strategies=[strategy],
                    allowed_symbols=set(),
                    positions=[{"symbol": "NVDA", "qty": "1", "side": "long"}],
                    session=session,
                )

        self.assertEqual(decisions, [])

    def test_paper_route_target_plan_reserves_account_for_collection(self) -> None:
        from app import config

        window_start = datetime(2026, 6, 1, 13, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 6, 1, 20, 0, tzinfo=timezone.utc)
        config.settings.trading_mode = "paper"
        config.settings.trading_simple_paper_route_probe_enabled = True
        pipeline = object.__new__(SimpleTradingPipeline)
        setattr(pipeline, "account_label", "TORGHUT_SIM")
        setattr(pipeline, "_is_market_session_open", lambda _now: True)
        target = {
            "account_label": "TORGHUT_SIM",
            "observed_stage": "paper",
            "source_kind": "paper_route_probe_runtime_observed",
            "candidate_id": "candidate-pairs-monday",
            "hypothesis_id": "H-PAIRS-01",
            "runtime_strategy_name": "microbar-cross-sectional-pairs-v1",
            "source_manifest_ref": "config/trading/hypotheses/h-pairs-01.json",
            "paper_route_probe_symbols": ["AAPL", "AMZN"],
            "paper_route_probe_window_start": window_start.isoformat(),
            "paper_route_probe_window_end": window_end.isoformat(),
            "bounded_evidence_collection_authorized": True,
            "evidence_collection_ok": True,
            "source_decision_readiness": {"ready": True, "blockers": []},
            "runtime_window_import_health_gate_blockers": [
                "evidence_continuity_not_ok"
            ],
            "runtime_window_import_promotion_blockers": ["drift_checks_not_ok"],
        }
        setattr(
            pipeline,
            "_external_paper_route_target_probe_symbols_cached",
            lambda **_kwargs: ({"AAPL", "AMZN"}, None, [target]),
        )

        with patch(
            "app.trading.scheduler.simple_pipeline.trading_now",
            return_value=window_start + timedelta(minutes=5),
        ):
            reserves = pipeline._paper_route_target_plan_reserves_account(
                allowed_symbols=set()
            )

        self.assertTrue(reserves)

    def test_run_once_commits_and_skips_regular_signals_when_target_reserves_account(
        self,
    ) -> None:
        signal = SignalEnvelope(
            event_ts=datetime(2026, 6, 1, 14, 30, tzinfo=timezone.utc),
            symbol="NVDA",
            payload={"price": Decimal("100")},
            timeframe="1Min",
        )
        ingestor = FakeIngestor([signal])
        pipeline = object.__new__(SimpleTradingPipeline)
        setattr(pipeline, "account_label", "TORGHUT_SIM")
        setattr(pipeline, "session_factory", self.session_local)
        setattr(pipeline, "state", TradingState())
        setattr(pipeline, "ingestor", ingestor)
        strategy = Strategy(
            name="microbar-cross-sectional-pairs-v1",
            enabled=True,
            base_timeframe="1Sec",
            universe_type="microbar_cross_sectional_pairs_v1",
            universe_symbols=["AAPL", "AMZN"],
        )
        setattr(pipeline, "_label_mature_rejected_signal_outcome_events", lambda: None)
        setattr(pipeline, "_prepare_run_once", lambda _session: [strategy])
        setattr(
            pipeline,
            "_capture_runtime_window_account_snapshot_if_due",
            lambda _session: None,
        )
        setattr(
            pipeline,
            "_warm_session_context_from_open",
            lambda _session, *, strategies: None,
        )
        setattr(pipeline, "_record_ingest_window", lambda _batch: None)
        setattr(
            pipeline,
            "_build_run_context",
            lambda _session: ({}, {}, [], {"AAPL", "AMZN"}),
        )
        setattr(
            pipeline,
            "_process_paper_route_probe_exit_decisions",
            lambda **_kwargs: None,
        )
        setattr(
            pipeline,
            "_process_paper_route_materialized_decisions",
            lambda **_kwargs: None,
        )
        setattr(
            pipeline,
            "_process_paper_route_target_source_decisions",
            lambda **_kwargs: None,
        )
        setattr(
            pipeline,
            "_process_paper_route_probe_retry_decisions",
            Mock(side_effect=AssertionError("generic retry path should be skipped")),
        )
        setattr(
            pipeline,
            "_paper_route_target_plan_reserves_account",
            lambda *, allowed_symbols: True,
        )
        setattr(
            pipeline,
            "_quality_gate_signals",
            Mock(side_effect=AssertionError("regular signal path should be skipped")),
        )

        pipeline.run_once()

        self.assertEqual(ingestor.committed_batches, 1)

    def test_run_once_skips_generic_retries_on_empty_batch_when_target_reserves_account(
        self,
    ) -> None:
        ingestor = FakeIngestor([])
        pipeline = object.__new__(SimpleTradingPipeline)
        setattr(pipeline, "account_label", "TORGHUT_SIM")
        setattr(pipeline, "session_factory", self.session_local)
        setattr(pipeline, "state", TradingState())
        setattr(pipeline, "ingestor", ingestor)
        strategy = Strategy(
            name="microbar-cross-sectional-pairs-v1",
            enabled=True,
            base_timeframe="1Sec",
            universe_type="microbar_cross_sectional_pairs_v1",
            universe_symbols=["AAPL", "AMZN"],
        )
        target_source = Mock()
        retry = Mock(side_effect=AssertionError("generic retry path should be skipped"))
        setattr(pipeline, "_label_mature_rejected_signal_outcome_events", lambda: None)
        setattr(pipeline, "_prepare_run_once", lambda _session: [strategy])
        setattr(
            pipeline,
            "_capture_runtime_window_account_snapshot_if_due",
            lambda _session: None,
        )
        setattr(
            pipeline,
            "_warm_session_context_from_open",
            lambda _session, *, strategies: None,
        )
        setattr(
            pipeline,
            "_bounded_paper_route_signal_scope",
            lambda *_args, **_kwargs: None,
        )
        setattr(pipeline, "_record_ingest_window", lambda _batch: None)
        setattr(pipeline, "_signal_ingest_unavailable", lambda _batch: False)
        setattr(
            pipeline,
            "_prepare_batch_for_decisions",
            lambda *_args, **_kwargs: True,
        )
        setattr(
            pipeline,
            "_build_run_context",
            lambda _session: ({}, {}, [], {"AAPL", "AMZN"}),
        )
        setattr(
            pipeline,
            "_process_paper_route_probe_exit_decisions",
            lambda **_kwargs: None,
        )
        setattr(
            pipeline,
            "_process_paper_route_materialized_decisions",
            lambda **_kwargs: None,
        )
        setattr(
            pipeline,
            "_process_paper_route_target_source_decisions",
            target_source,
        )
        setattr(
            pipeline,
            "_process_paper_route_probe_retry_decisions",
            retry,
        )
        setattr(
            pipeline,
            "_paper_route_target_plan_reserves_account",
            lambda *, allowed_symbols: True,
        )

        pipeline.run_once()

        target_source.assert_called_once()
        retry.assert_not_called()

    def test_run_once_processes_generic_retries_after_regular_batch_when_unreserved(
        self,
    ) -> None:
        signal = SignalEnvelope(
            event_ts=datetime(2026, 6, 1, 14, 30, tzinfo=timezone.utc),
            symbol="NVDA",
            payload={"price": Decimal("100")},
            timeframe="1Min",
        )
        ingestor = FakeIngestor([signal])
        pipeline = object.__new__(SimpleTradingPipeline)
        setattr(pipeline, "account_label", "TORGHUT_SIM")
        setattr(pipeline, "session_factory", self.session_local)
        setattr(pipeline, "state", TradingState())
        setattr(pipeline, "ingestor", ingestor)
        strategy = Strategy(
            name="microbar-cross-sectional-pairs-v1",
            enabled=True,
            base_timeframe="1Sec",
            universe_type="microbar_cross_sectional_pairs_v1",
            universe_symbols=["AAPL", "AMZN"],
        )
        retry = Mock()
        setattr(pipeline, "_label_mature_rejected_signal_outcome_events", lambda: None)
        setattr(pipeline, "_prepare_run_once", lambda _session: [strategy])
        setattr(
            pipeline,
            "_capture_runtime_window_account_snapshot_if_due",
            lambda _session: None,
        )
        setattr(
            pipeline,
            "_warm_session_context_from_open",
            lambda _session, *, strategies: None,
        )
        setattr(
            pipeline,
            "_bounded_paper_route_signal_scope",
            lambda *_args, **_kwargs: None,
        )
        setattr(pipeline, "_record_ingest_window", lambda _batch: None)
        setattr(
            pipeline,
            "_build_run_context",
            lambda _session: ({}, {}, [], {"NVDA"}),
        )
        setattr(
            pipeline,
            "_process_paper_route_probe_exit_decisions",
            lambda **_kwargs: None,
        )
        setattr(
            pipeline,
            "_process_paper_route_materialized_decisions",
            lambda **_kwargs: None,
        )
        setattr(
            pipeline,
            "_process_paper_route_target_source_decisions",
            lambda **_kwargs: None,
        )
        setattr(
            pipeline,
            "_paper_route_target_plan_reserves_account",
            lambda *, allowed_symbols: False,
        )
        setattr(
            pipeline,
            "_quality_gate_signals",
            lambda *, signals, strategies, allowed_symbols: list(signals),
        )
        setattr(
            pipeline,
            "_prepare_batch_for_decisions",
            lambda *_args, **_kwargs: True,
        )
        setattr(
            pipeline,
            "_process_batch_signals",
            lambda **_kwargs: None,
        )
        setattr(
            pipeline,
            "_process_paper_route_probe_retry_decisions",
            retry,
        )

        pipeline.run_once()

        retry.assert_called_once()
        self.assertEqual(ingestor.committed_batches, 1)
