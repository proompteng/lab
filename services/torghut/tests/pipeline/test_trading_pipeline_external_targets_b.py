from __future__ import annotations

from tests.pipeline.trading_pipeline_base import (
    Any,
    Decimal,
    DecisionEngine,
    Execution,
    FakeAlpacaClient,
    FakeIngestor,
    Mapping,
    OrderExecutor,
    OrderFirewall,
    PositionSnapshot,
    ROUTE_ACQUISITION_SOURCE_DECISION_MODE,
    Reconciler,
    RiskEngine,
    SimpleTradingPipeline,
    Strategy,
    StrategyDecision,
    TradeDecision,
    TradingPipelineTestCaseBase,
    TradingState,
    UniverseResolver,
    _target_price_snapshots,
    _target_truthy,
    datetime,
    patch,
    timedelta,
    timezone,
    uuid4,
)


class TestTradingPipelineExternalTargetsB(TradingPipelineTestCaseBase):
    def test_strategy_signal_paper_target_rejects_unqualified_targets(
        self,
    ) -> None:
        from app import config

        window_start = datetime(2026, 5, 28, 13, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 5, 28, 20, 0, tzinfo=timezone.utc)
        config.settings.trading_mode = "paper"
        config.settings.trading_simple_paper_route_probe_enabled = True
        config.settings.trading_paper_route_target_plan_url = (
            "http://torghut.local/trading/paper-route-evidence"
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
        )
        strategy = Strategy(
            id=uuid4(),
            name="microbar-cross-sectional-pairs-v1",
            enabled=True,
            base_timeframe="1Sec",
            universe_type="static",
            universe_symbols=["AAPL"],
        )

        def make_decision(
            *,
            symbol: str = "AAPL",
            event_ts: datetime = datetime(2026, 5, 28, 15, 30),
            params: Mapping[str, Any] | None = None,
        ) -> StrategyDecision:
            return StrategyDecision(
                strategy_id=str(strategy.id),
                symbol=symbol,
                event_ts=event_ts,
                timeframe="1Sec",
                action="sell",
                qty=Decimal("1"),
                params={"price": "100", **dict(params or {})},
            )

        def make_target(**overrides: object) -> dict[str, object]:
            target: dict[str, object] = {
                "paper_route_probe_symbols": ["AAPL"],
                "paper_route_probe_window_start": window_start.isoformat(),
                "paper_route_probe_window_end": window_end.isoformat(),
                "candidate_id": "candidate-pairs-a",
                "hypothesis_id": "H-PAIRS-01",
                "observed_stage": "paper",
                "account_label": "TORGHUT_SIM",
                "source_account_label": "TORGHUT_REPLAY",
                "runtime_strategy_name": "microbar-cross-sectional-pairs-v1",
                "strategy_lookup_names": [str(strategy.id), strategy.name],
                "source_kind": "paper_route_probe_runtime_observed",
                "source_manifest_ref": "config/trading/hypotheses/h-pairs-01.json",
                "evidence_collection_ok": True,
                "paper_route_target_account_audit_state": (
                    self._paper_route_target_account_audit_state(["AAPL"])
                ),
                "paper_route_target_account_audit_blockers": [],
                "canary_collection_authorized": True,
                "bounded_evidence_collection_authorized": True,
                "bounded_live_paper_collection_authorized": True,
                "bounded_evidence_collection_scope": (
                    "paper_route_probe_next_session_only"
                ),
                "bounded_evidence_collection_blockers": [],
                "runtime_window_import_health_gate_blockers": [],
                "paper_route_account_pre_session_blockers": [],
                "paper_route_hpairs_symbol_blockers": [],
                "paper_route_probe_pair_balance_state": "balanced",
                "source_decision_readiness": {"ready": True, "blockers": []},
                "paper_probation_authorized": "yes",
            }
            target.update(overrides)
            return target

        good_decision = make_decision()
        good_target = make_target()

        self.assertFalse(_target_truthy(Decimal("0")))
        self.assertTrue(_target_truthy("yes"))

        config.settings.trading_mode = "live"
        self.assertIsNone(
            pipeline._strategy_signal_paper_target_for_decision(
                good_decision,
                strategy,
            )
        )

        config.settings.trading_mode = "paper"
        config.settings.trading_simple_paper_route_probe_enabled = False
        self.assertIsNone(
            pipeline._strategy_signal_paper_target_for_decision(
                good_decision,
                strategy,
            )
        )
        config.settings.trading_simple_paper_route_probe_enabled = True

        guarded_cases: list[tuple[str, StrategyDecision, list[Mapping[str, Any]]]] = [
            (
                "source decision payload",
                make_decision(
                    params={"paper_route_target_plan_source_decision": {"mode": "x"}}
                ),
                [good_target],
            ),
            (
                "paper route probe exit",
                make_decision(params={"paper_route_probe_exit": {"mode": "x"}}),
                [good_target],
            ),
            (
                "route acquisition mode",
                make_decision(
                    params={"source_decision_mode": "route_acquisition_probe"}
                ),
                [good_target],
            ),
            ("blank symbol", make_decision(symbol=" "), [good_target]),
            (
                "empty strategy lookup names",
                good_decision,
                [
                    make_target(
                        strategy_lookup_names=[],
                        strategy_name=None,
                        strategy_id=None,
                        runtime_strategy_name=None,
                    )
                ],
            ),
            (
                "strategy mismatch",
                good_decision,
                [
                    make_target(
                        strategy_lookup_names=["other-strategy"],
                        runtime_strategy_name="other-strategy",
                    )
                ],
            ),
            ("missing candidate", good_decision, [make_target(candidate_id=None)]),
            ("missing hypothesis", good_decision, [make_target(hypothesis_id=None)]),
            ("wrong stage", good_decision, [make_target(observed_stage="backtest")]),
            ("wrong source kind", good_decision, [make_target(source_kind="manual")]),
            (
                "bounded collection blockers",
                good_decision,
                [
                    make_target(
                        paper_route_account_pre_session_blockers=[
                            "unlinked_order_events_present"
                        ]
                    )
                ],
            ),
            (
                "probation unauthorized",
                good_decision,
                [make_target(paper_probation_authorized=0)],
            ),
        ]
        for name, decision, targets in guarded_cases:
            with self.subTest(name=name):
                with patch.object(
                    pipeline,
                    "_external_paper_route_target_probe_symbols_cached",
                    return_value=({"AAPL"}, None, targets),
                ):
                    self.assertIsNone(
                        pipeline._strategy_signal_paper_target_for_decision(
                            decision,
                            strategy,
                        )
                    )

        with patch.object(
            pipeline,
            "_external_paper_route_target_probe_symbols_cached",
            return_value=({"AAPL"}, "fetch failed", [good_target]),
        ):
            self.assertIsNone(
                pipeline._strategy_signal_paper_target_for_decision(
                    good_decision,
                    strategy,
                )
            )

        with patch.object(
            pipeline,
            "_external_paper_route_target_probe_symbols_cached",
            return_value=({"AAPL"}, None, [good_target]),
        ):
            self.assertEqual(
                pipeline._strategy_signal_paper_target_for_decision(
                    good_decision,
                    strategy,
                ),
                good_target,
            )

    def test_paper_route_target_source_skips_pair_with_open_strategy_exposure(
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

            decision = TradeDecision(
                strategy_id=strategy.id,
                alpaca_account_label="TORGHUT_SIM",
                symbol="AMZN",
                timeframe="1Sec",
                decision_json={
                    "action": "sell",
                    "qty": "10",
                    "event_ts": (window_start + timedelta(minutes=3)).isoformat(),
                    "params": {
                        "source_decision_mode": ROUTE_ACQUISITION_SOURCE_DECISION_MODE,
                        "profit_proof_eligible": False,
                        "paper_route_probe": {
                            "mode": "paper_route_acquisition",
                            "source_decision_mode": ROUTE_ACQUISITION_SOURCE_DECISION_MODE,
                            "profit_proof_eligible": False,
                        },
                    },
                },
                rationale="paper-route-entry",
                status="filled",
                created_at=window_start + timedelta(minutes=3),
            )
            session.add(decision)
            session.commit()
            session.refresh(decision)
            session.add(
                Execution(
                    trade_decision_id=decision.id,
                    alpaca_account_label="TORGHUT_SIM",
                    alpaca_order_id="paper-amzn-open",
                    client_order_id="paper-amzn-open-client",
                    symbol="AMZN",
                    side="sell",
                    order_type="market",
                    time_in_force="day",
                    submitted_qty=Decimal("10"),
                    filled_qty=Decimal("10"),
                    avg_fill_price=Decimal("272"),
                    status="filled",
                    raw_order={},
                    created_at=window_start + timedelta(minutes=4),
                    updated_at=window_start + timedelta(minutes=4),
                )
            )
            session.commit()

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
                "price_snapshots": _target_price_snapshots("AAPL", "AMZN"),
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
                decisions = pipeline._paper_route_target_source_decisions(
                    strategies=[strategy],
                    allowed_symbols=set(),
                    positions=[],
                    session=session,
                )

        self.assertEqual(decisions, [])

    def test_paper_route_target_source_allows_flat_repaired_strategy_exposure(
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

            decision = TradeDecision(
                strategy_id=strategy.id,
                alpaca_account_label="TORGHUT_SIM",
                symbol="AMZN",
                timeframe="1Sec",
                decision_json={
                    "action": "sell",
                    "qty": "10",
                    "event_ts": (
                        window_start - timedelta(days=3) + timedelta(minutes=3)
                    ).isoformat(),
                    "params": {
                        "source_decision_mode": ROUTE_ACQUISITION_SOURCE_DECISION_MODE,
                        "profit_proof_eligible": False,
                    },
                },
                rationale="paper-route-entry",
                status="filled",
                created_at=window_start - timedelta(days=3) + timedelta(minutes=3),
            )
            session.add(decision)
            session.commit()
            session.refresh(decision)
            session.add(
                Execution(
                    trade_decision_id=decision.id,
                    alpaca_account_label="TORGHUT_SIM",
                    alpaca_order_id="paper-amzn-stale-open",
                    client_order_id="paper-amzn-stale-open-client",
                    symbol="AMZN",
                    side="sell",
                    order_type="market",
                    time_in_force="day",
                    submitted_qty=Decimal("10"),
                    filled_qty=Decimal("10"),
                    avg_fill_price=Decimal("272"),
                    status="filled",
                    raw_order={},
                    created_at=window_start - timedelta(days=3) + timedelta(minutes=2),
                    updated_at=window_start - timedelta(days=3) + timedelta(minutes=2),
                )
            )
            session.add(
                PositionSnapshot(
                    alpaca_account_label="TORGHUT_SIM",
                    as_of=window_start - timedelta(minutes=5),
                    equity=Decimal("100000"),
                    cash=Decimal("100000"),
                    buying_power=Decimal("200000"),
                    positions=[],
                )
            )
            session.commit()

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
                "price_snapshots": _target_price_snapshots("AAPL", "AMZN"),
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
                decisions = pipeline._paper_route_target_source_decisions(
                    strategies=[strategy],
                    allowed_symbols=set(),
                    positions=[],
                    session=session,
                )

        self.assertEqual(
            [(decision.symbol, decision.action) for decision in decisions],
            [("AAPL", "buy"), ("AMZN", "sell")],
        )
