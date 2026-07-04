from __future__ import annotations

from tests.pipeline.trading_pipeline_base import (
    Any,
    BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE,
    Decimal,
    DecisionEngine,
    Execution,
    FakeAlpacaClient,
    FakeIngestor,
    FakePriceFetcher,
    Mapping,
    OrderExecutor,
    OrderFirewall,
    Reconciler,
    RiskEngine,
    Sequence,
    SimpleTradingPipeline,
    Strategy,
    TradeDecision,
    TradingPipelineTestCaseBase,
    TradingState,
    UniverseResolver,
    _target_price_snapshots,
    cast,
    datetime,
    materialize_bounded_paper_route_target_plan,
    patch,
    select,
    timedelta,
    timezone,
)


class TestTradingPipelineMaterializedTargetPlanA(TradingPipelineTestCaseBase):
    def test_simple_pipeline_no_signal_cycle_generates_target_plan_source_decision(
        self,
    ) -> None:
        from app import config

        now = datetime(2026, 5, 26, 14, 0, tzinfo=timezone.utc)
        window_start = datetime(2026, 5, 26, 13, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 5, 26, 20, 0, tzinfo=timezone.utc)
        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_mode = "paper"
        config.settings.trading_pipeline_mode = "simple"
        config.settings.trading_simple_submit_enabled = True
        config.settings.trading_fractional_equities_enabled = True
        config.settings.trading_simple_paper_route_probe_enabled = True
        config.settings.trading_simple_paper_route_probe_max_notional = 1000.0
        config.settings.trading_paper_route_target_plan_url = "http://torghut.test/plan"
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"
        config.settings.trading_universe_static_fallback_enabled = True
        config.settings.trading_universe_static_fallback_symbols_raw = "AAPL"

        with self.session_local() as session:
            strategy = Strategy(
                name="intraday-tsmom-profit-v3",
                description="paper route candidate",
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=["AAPL"],
                max_notional_per_trade=Decimal("1000"),
            )
            session.add(strategy)
            session.commit()

        target = {
            "candidate_id": "cand-tsmom-liq",
            "hypothesis_id": "H-TSMOM-LIQ",
            "observed_stage": "paper",
            "strategy_family": "intraday_tsmom",
            "strategy_name": "intraday-tsmom-profit-v3",
            "runtime_strategy_name": "intraday-tsmom-profit-v3",
            "strategy_lookup_names": [
                "intraday-tsmom-profit-v3",
            ],
            "account_label": "TORGHUT_SIM",
            "source_account_label": "TORGHUT_REPLAY",
            "source_kind": "paper_route_probe_runtime_observed",
            "source_manifest_ref": "config/trading/hypotheses/h-tsmom-liq.json",
            "paper_route_probe_symbols": ["AAPL"],
            "paper_route_probe_next_session_max_notional": "250",
            "paper_route_probe_window_start": window_start.isoformat(),
            "paper_route_probe_window_end": window_end.isoformat(),
            "exit_minute_after_open": "120",
            "paper_probation_authorized": True,
            "source_collection_authorized": True,
            "source_collection_authorization_scope": (
                "source_window_evidence_collection_only"
            ),
            "source_collection_reason_codes": [
                "source_window_evidence_collection_pending"
            ],
            "bounded_evidence_collection_authorized": True,
            "bounded_live_paper_collection_authorized": True,
            "canary_collection_authorized": True,
            "bounded_evidence_collection_scope": "paper_route_probe_next_session_only",
            "bounded_evidence_collection_max_notional": "250",
            "evidence_collection_ok": True,
            "bounded_evidence_collection_blockers": [],
            "runtime_window_import_health_gate_blockers": [],
            "paper_route_account_pre_session_blockers": [],
            "paper_route_hpairs_symbol_blockers": [],
            "source_decision_readiness": {"ready": True, "blockers": []},
            "max_notional": "0",
            "promotion_allowed": False,
            "final_promotion_authorized": False,
            "final_promotion_allowed": False,
            "capital_promotion_allowed": False,
        }
        proof_floor = {
            "route_state": "repair_only",
            "capital_state": "zero_notional",
            "max_notional": "0",
            "market_window": {"session_open": True},
            "blocking_reasons": ["hypothesis_not_promotion_eligible"],
        }
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
                "_external_paper_route_target_probe_symbols_cached",
                return_value=({"AAPL"}, None, [target]),
            ),
            patch.object(
                SimpleTradingPipeline,
                "_external_paper_route_target_probe_symbols",
                return_value=({"AAPL"}, None, [target]),
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
            patch(
                "app.trading.scheduler.pipeline.run_cycle.trading_now",
                return_value=now,
            ),
            patch(
                "app.trading.scheduler.pipeline.decision_lifecycle.trading_now",
                return_value=now,
            ),
            patch("app.trading.simulation.trading_now", return_value=now),
        ):
            pipeline.run_once()
            pipeline.run_once()

        self.assertEqual(len(alpaca_client.submitted), 1)
        self.assertEqual(alpaca_client.submitted[0]["side"], "buy")
        self.assertEqual(alpaca_client.submitted[0]["qty"], "2.4997")
        with self.session_local() as session:
            decisions = list(session.execute(select(TradeDecision)).scalars())
            executions = list(session.execute(select(Execution)).scalars())
            self.assertEqual(len(decisions), 1)
            self.assertEqual(len(executions), 1)
            decision = decisions[0]
            execution = executions[0]
            decision_json = cast(dict[str, Any], decision.decision_json)
            params = cast(dict[str, Any], decision_json.get("params"))
            target_plan = cast(dict[str, Any], params.get("paper_route_target_plan"))
            source_decision = cast(
                dict[str, Any],
                params.get("paper_route_target_plan_source_decision"),
            )
            paper_route_probe = cast(dict[str, Any], params.get("paper_route_probe"))
            execution_metadata = cast(dict[str, Any], params.get("execution"))
            execution_precheck = cast(dict[str, Any], params.get("execution_precheck"))
            bounded_execution_policy = cast(
                dict[str, Any], params.get("bounded_paper_route_execution_policy")
            )
            self.assertNotIn("simple_lane", params)
            self.assertNotIn("simple_lane_precheck", params)

            self.assertEqual(decision.status, "submitted")
            self.assertEqual(Decimal(str(decision_json["qty"])), Decimal("2.4997"))
            self.assertEqual(execution.submitted_qty, Decimal("2.49970000"))
            created_at = decision.created_at
            if created_at.tzinfo is None:
                created_at = created_at.replace(tzinfo=timezone.utc)
            self.assertEqual(created_at, now)
            self.assertEqual(
                target_plan["mode"], "paper_route_target_plan_source_decision"
            )
            self.assertEqual(source_decision["candidate_id"], "cand-tsmom-liq")
            self.assertEqual(source_decision["hypothesis_id"], "H-TSMOM-LIQ")
            self.assertEqual(
                source_decision["source_decision_mode"],
                BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE,
            )
            self.assertTrue(source_decision["profit_proof_eligible"])
            self.assertEqual(source_decision["exit_minute_after_open"], 120)
            self.assertTrue(source_decision["source_collection_authorized"])
            self.assertEqual(
                source_decision["source_collection_authorization_scope"],
                "source_window_evidence_collection_only",
            )
            self.assertEqual(
                source_decision["source_collection_reason_codes"],
                ["source_window_evidence_collection_pending"],
            )
            self.assertTrue(source_decision["bounded_evidence_collection_authorized"])
            self.assertEqual(
                source_decision["bounded_evidence_collection_scope"],
                "paper_route_probe_next_session_only",
            )
            self.assertEqual(
                source_decision["bounded_evidence_collection_max_notional"], "250"
            )
            self.assertEqual(
                source_decision["paper_route_probe_effective_max_notional"], "250"
            )
            self.assertEqual(params["exit_minute_after_open"], 120)
            self.assertEqual(params["candidate_id"], "cand-tsmom-liq")
            self.assertEqual(params["hypothesis_id"], "H-TSMOM-LIQ")
            self.assertEqual(
                params["runtime_strategy_name"],
                "intraday-tsmom-profit-v3",
            )
            self.assertEqual(params["source_candidate_ids"], ["cand-tsmom-liq"])
            self.assertEqual(params["source_hypothesis_ids"], ["H-TSMOM-LIQ"])
            self.assertEqual(
                params["source_decision_mode"],
                BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE,
            )
            self.assertTrue(params["profit_proof_eligible"])
            self.assertFalse(params["promotion_allowed"])
            self.assertFalse(params["final_promotion_authorized"])
            self.assertEqual(
                paper_route_probe["mode"], "bounded_paper_route_collection"
            )
            self.assertEqual(paper_route_probe["max_notional"], "250")
            self.assertTrue(paper_route_probe["target_source_authorized"])
            self.assertEqual(
                paper_route_probe["source_decision_mode"],
                BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE,
            )
            self.assertTrue(paper_route_probe["profit_proof_eligible"])
            self.assertEqual(paper_route_probe["exit_minute_after_open"], 120)
            self.assertEqual(
                paper_route_probe["exit_due_at"],
                "2026-05-26T15:30:00+00:00",
            )
            self.assertEqual(paper_route_probe["capped_qty"], "2.4997")
            self.assertEqual(
                Decimal(str(paper_route_probe["capped_notional"])),
                Decimal("249.994997"),
            )
            self.assertTrue(paper_route_probe["target_source_notional_sized"])
            self.assertEqual(
                Decimal(str(execution_metadata["final_qty"])), Decimal("2.4997")
            )
            self.assertEqual(
                Decimal(str(execution_metadata["notional"])), Decimal("249.994997")
            )
            self.assertEqual(execution_precheck["requested_qty"], "2.4997")
            self.assertEqual(execution_precheck["final_qty"], "2.4997")
            self.assertEqual(
                bounded_execution_policy["authority"],
                "bounded_paper_route_collection_only",
            )
            self.assertEqual(
                bounded_execution_policy["max_notional"],
                "250",
            )
            self.assertEqual(
                paper_route_probe["bounded_paper_route_execution_policy"]["authority"],
                "bounded_paper_route_collection_only",
            )

    def test_simple_pipeline_submits_materialized_target_plan_source_decisions(
        self,
    ) -> None:
        from app import config

        now = datetime(2026, 5, 26, 14, 0, tzinfo=timezone.utc)
        window_start = datetime(2026, 5, 26, 13, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 5, 26, 20, 0, tzinfo=timezone.utc)
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
        config.settings.trading_static_symbols_raw = "AAPL,AMZN"
        config.settings.trading_universe_static_fallback_enabled = True
        config.settings.trading_universe_static_fallback_symbols_raw = "AAPL,AMZN"
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
                            "bounded_collection_stage": ("bounded_paper_collection"),
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
            self.assertEqual(len(materialized["decisions"]), 2)
            materialized_ids = {
                str(item["trade_decision_id"])
                for item in cast(
                    Sequence[Mapping[str, object]],
                    materialized["decisions"],
                )
            }
            materialized_hashes = {
                str(item["decision_hash"])
                for item in cast(
                    Sequence[Mapping[str, object]],
                    materialized["decisions"],
                )
            }
            session.commit()

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
                    "blocking_reasons": ["hypothesis_not_promotion_eligible"],
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
            patch(
                "app.trading.scheduler.pipeline.decision_lifecycle.trading_now",
                return_value=now,
            ),
            patch("app.trading.simulation.trading_now", return_value=now),
        ):
            pipeline.run_once()

        self.assertEqual(len(alpaca_client.submitted), 2)
        self.assertEqual(
            {order["symbol"]: order["side"] for order in alpaca_client.submitted},
            {"AAPL": "buy", "AMZN": "sell"},
        )
        with self.session_local() as session:
            decisions = list(
                session.execute(select(TradeDecision).order_by(TradeDecision.symbol))
                .scalars()
                .all()
            )
            executions = list(
                session.execute(select(Execution).order_by(Execution.symbol))
                .scalars()
                .all()
            )
            self.assertEqual(
                {str(decision.id) for decision in decisions}, materialized_ids
            )
            self.assertEqual(
                {str(decision.decision_hash) for decision in decisions},
                materialized_hashes,
            )
            self.assertEqual(
                [decision.status for decision in decisions], ["submitted", "submitted"]
            )
            self.assertEqual(len(executions), 2)
            for decision in decisions:
                decision_json = cast(dict[str, Any], decision.decision_json)
                params = cast(dict[str, Any], decision_json["params"])
                source_decision = cast(
                    dict[str, Any],
                    params["paper_route_target_plan_source_decision"],
                )
                self.assertEqual(
                    params["source_decision_mode"],
                    BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE,
                )
                self.assertTrue(params["profit_proof_eligible"])
                self.assertTrue(params["paper_route_target_plan_materialized"])
                self.assertEqual(
                    params["paper_route_materialized_trade_decision_id"],
                    str(decision.id),
                )
                self.assertEqual(
                    params["bounded_paper_route_submit_path"],
                    "bounded_paper_route_collection",
                )
                self.assertEqual(
                    source_decision["source"],
                    "paper_route_target_plan_materializer",
                )
                self.assertEqual(
                    source_decision["source_account_label"],
                    "TORGHUT_REPLAY",
                )
                self.assertFalse(params["promotion_allowed"])
                self.assertFalse(params["final_promotion_authorized"])

    def test_materialized_target_plan_expired_rows_fail_closed(self) -> None:
        from app import config

        generated_at = datetime(2026, 5, 26, 14, 0, tzinfo=timezone.utc)
        window_start = datetime(2026, 5, 26, 13, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 5, 26, 20, 0, tzinfo=timezone.utc)
        now = window_end + timedelta(minutes=5)
        already_submitted = TradeDecision(
            status="submitted",
            decision_json={"submission_stage": "bounded_paper_route_materialized"},
        )
        self.assertFalse(
            SimpleTradingPipeline._expire_stale_materialized_paper_route_decision(
                decision_row=already_submitted,
                payload=cast(Mapping[str, Any], already_submitted.decision_json),
                window_end=window_end,
                now=now,
            )
        )
        original = {
            "trading_mode": config.settings.trading_mode,
            "trading_simple_paper_route_probe_enabled": (
                config.settings.trading_simple_paper_route_probe_enabled
            ),
            "trading_allow_shorts": config.settings.trading_allow_shorts,
        }
        config.settings.trading_mode = "paper"
        config.settings.trading_simple_paper_route_probe_enabled = True
        config.settings.trading_allow_shorts = True

        try:
            with self.session_local() as session:
                strategy = Strategy(
                    name="microbar-cross-sectional-pairs-v1",
                    description="expired bounded H-PAIRS target",
                    enabled=True,
                    base_timeframe="1Min",
                    universe_type="static",
                    universe_symbols=["AAPL", "AMZN"],
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
                                "target_quantity": "2",
                                "paper_route_probe_next_session_max_notional": "200",
                                "paper_route_probe_window_start": (
                                    window_start.isoformat()
                                ),
                                "paper_route_probe_window_end": (
                                    window_end.isoformat()
                                ),
                                "paper_route_probe_symbols": ["AAPL", "AMZN"],
                                "paper_route_probe_symbol_actions": {
                                    "AAPL": "buy",
                                    "AMZN": "sell",
                                },
                                "paper_route_probe_symbol_quantities": {
                                    "AAPL": "1",
                                    "AMZN": "1",
                                },
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
                        ],
                    },
                    generated_at=generated_at,
                    bounded_notional_limit=Decimal("500"),
                )
                self.assertEqual(materialized["materialized_decision_count"], 2)
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
                pipeline._is_market_session_open = lambda _now=None: False
                with patch(
                    "app.trading.scheduler.simple_pipeline.trading_now",
                    return_value=now,
                ):
                    decisions = pipeline._paper_route_materialized_planned_decisions(
                        session=session,
                        strategies=[strategy],
                        allowed_symbols={"AAPL", "AMZN"},
                        positions=[],
                    )

                self.assertEqual(decisions, [])
                rows = list(
                    session.execute(
                        select(TradeDecision).order_by(TradeDecision.symbol)
                    )
                    .scalars()
                    .all()
                )
                self.assertEqual([row.status for row in rows], ["rejected", "rejected"])
                for row in rows:
                    payload = cast(dict[str, Any], row.decision_json)
                    params = cast(dict[str, Any], payload["params"])
                    self.assertEqual(
                        payload["submission_stage"],
                        "expired_paper_route_materialized_window",
                    )
                    self.assertEqual(
                        payload["submission_block_reason"],
                        "paper_route_materialized_window_expired_unsubmitted",
                    )
                    self.assertEqual(
                        params["paper_route_materialized_unsubmitted"]["reason"],
                        "paper_route_materialized_window_expired_unsubmitted",
                    )
        finally:
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_simple_paper_route_probe_enabled = original[
                "trading_simple_paper_route_probe_enabled"
            ]
            config.settings.trading_allow_shorts = original["trading_allow_shorts"]
