from __future__ import annotations

# ruff: noqa: F403,F405
from tests.pipeline.trading_pipeline_base import *


class TestTradingPipelineExternalTargetsD(TradingPipelineTestCaseBase):
    def test_run_once_blocks_bounded_target_decisions_when_signal_ingest_times_out(
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
        config.settings.trading_allow_shorts = True
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL,AMZN"
        config.settings.trading_universe_static_fallback_enabled = True
        config.settings.trading_universe_static_fallback_symbols_raw = "AAPL,AMZN"

        with self.session_local() as session:
            strategy = Strategy(
                name="microbar-cross-sectional-pairs-v1",
                enabled=True,
                base_timeframe="1Sec",
                universe_type="static",
                universe_symbols=["AAPL", "AMZN"],
                max_notional_per_trade=Decimal("1000"),
            )
            session.add(strategy)
            session.commit()

        target = {
            "paper_route_probe_symbols": ["AAPL", "AMZN"],
            "paper_route_probe_window_start": window_start.isoformat(),
            "paper_route_probe_window_end": window_end.isoformat(),
            "paper_route_probe_next_session_max_notional": "250",
            "candidate_id": "candidate-pairs-monday",
            "hypothesis_id": "H-PAIRS-01",
            "observed_stage": "paper",
            "strategy_family": "microbar_cross_sectional_pairs",
            "strategy_name": "microbar-cross-sectional-pairs-v1",
            "runtime_strategy_name": "microbar-cross-sectional-pairs-v1",
            "source_kind": "paper_route_probe_runtime_observed",
            "source_manifest_ref": "config/trading/hypotheses/h-pairs-01.json",
            "account_label": "TORGHUT_SIM",
            "source_account_label": "TORGHUT_REPLAY",
            "evidence_collection_ok": True,
            "paper_route_target_account_audit_state": (
                self._paper_route_target_account_audit_state(["AAPL", "AMZN"])
            ),
            "paper_route_target_account_audit_blockers": [],
            "canary_collection_authorized": True,
            "bounded_evidence_collection_authorized": True,
            "bounded_live_paper_collection_authorized": True,
            "bounded_evidence_collection_scope": "paper_route_probe_next_session_only",
            "bounded_evidence_collection_blockers": [],
            "runtime_window_import_health_gate_blockers": [],
            "paper_route_account_pre_session_blockers": [],
            "paper_route_hpairs_symbol_blockers": [],
            "paper_route_probe_pair_balance_state": "balanced",
            "source_decision_readiness": {"ready": True, "blockers": []},
            "paper_probation_authorized": True,
        }
        ingestor = NoSignalReasonIngestor(
            no_signal_reason="clickhouse_signal_query_timeout"
        )
        alpaca_client = FakeAlpacaClient()
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
            price_fetcher=FakePriceFetcher(Decimal("100")),
        )
        pipeline._is_market_session_open = lambda _now=None: True  # type: ignore[method-assign]

        with (
            patch.object(
                SimpleTradingPipeline,
                "_external_paper_route_target_probe_symbols_cached",
                return_value=({"AAPL", "AMZN"}, None, [target]),
            ),
            patch.object(
                pipeline,
                "_process_paper_route_probe_retry_decisions",
                side_effect=AssertionError("generic retry path should be skipped"),
            ),
            patch(
                "app.trading.scheduler.simple_pipeline.trading_now", return_value=now
            ),
            patch("app.trading.scheduler.pipeline.trading_now", return_value=now),
        ):
            pipeline.run_once()

        self.assertEqual(ingestor.fetch_scopes, [({"AAPL", "AMZN"}, {"1Sec"})])
        self.assertEqual(alpaca_client.submitted, [])
        self.assertEqual(
            pipeline.state.last_ingest_reason, "clickhouse_signal_query_timeout"
        )
        self.assertEqual(
            pipeline.state.last_signal_continuity_reason,
            "clickhouse_signal_query_timeout",
        )
        self.assertTrue(bool(pipeline.state.last_signal_continuity_actionable))
        blocker = cast(
            dict[str, Any],
            getattr(pipeline.state, "last_bounded_evidence_collection_blocker"),
        )
        self.assertEqual(blocker.get("blockers"), ["clickhouse_signal_query_timeout"])
        self.assertFalse(blocker.get("signals_authoritative"))
        with self.session_local() as session:
            self.assertEqual(list(session.execute(select(TradeDecision)).scalars()), [])
            self.assertEqual(list(session.execute(select(Execution)).scalars()), [])

    def test_run_once_scopes_hpairs_signal_ingest_and_emits_candidate_decisions(
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
        config.settings.trading_allow_shorts = True
        config.settings.trading_fractional_equities_enabled = True
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL,AMZN"
        config.settings.trading_universe_static_fallback_enabled = True
        config.settings.trading_universe_static_fallback_symbols_raw = "AAPL,AMZN"

        with self.session_local() as session:
            strategy = Strategy(
                name="microbar-cross-sectional-pairs-v1",
                enabled=True,
                base_timeframe="1Sec",
                universe_type="static",
                universe_symbols=["AAPL", "AMZN"],
                max_notional_per_trade=Decimal("1000"),
            )
            session.add(strategy)
            session.commit()

        signals = [
            SignalEnvelope(
                event_ts=now,
                symbol="AAPL",
                payload={"price": Decimal("100")},
                timeframe="1Sec",
                seq=1,
            ),
            SignalEnvelope(
                event_ts=now,
                symbol="AMZN",
                payload={"price": Decimal("100")},
                timeframe="1Sec",
                seq=2,
            ),
        ]
        target = {
            "paper_route_probe_symbols": ["AAPL", "AMZN"],
            "paper_route_probe_window_start": window_start.isoformat(),
            "paper_route_probe_window_end": window_end.isoformat(),
            "paper_route_probe_next_session_max_notional": "250",
            "candidate_id": "candidate-pairs-monday",
            "hypothesis_id": "H-PAIRS-01",
            "observed_stage": "paper",
            "strategy_family": "microbar_cross_sectional_pairs",
            "strategy_name": "microbar-cross-sectional-pairs-v1",
            "runtime_strategy_name": "microbar-cross-sectional-pairs-v1",
            "source_kind": "paper_route_probe_runtime_observed",
            "source_manifest_ref": "config/trading/hypotheses/h-pairs-01.json",
            "account_label": "TORGHUT_SIM",
            "source_account_label": "TORGHUT_REPLAY",
            "evidence_collection_ok": True,
            "paper_route_target_account_audit_state": (
                self._paper_route_target_account_audit_state(["AAPL", "AMZN"])
            ),
            "paper_route_target_account_audit_blockers": [],
            "canary_collection_authorized": True,
            "bounded_evidence_collection_authorized": True,
            "bounded_live_paper_collection_authorized": True,
            "bounded_evidence_collection_scope": "paper_route_probe_next_session_only",
            "bounded_evidence_collection_blockers": [],
            "runtime_window_import_health_gate_blockers": [],
            "paper_route_account_pre_session_blockers": [],
            "paper_route_hpairs_symbol_blockers": [],
            "paper_route_probe_pair_balance_state": "balanced",
            "source_decision_readiness": {"ready": True, "blockers": []},
            "paper_probation_authorized": True,
        }
        ingestor = FakeIngestor(
            signals, cursor_at=now, cursor_seq=2, cursor_symbol="AMZN"
        )
        alpaca_client = FakeAlpacaClient()
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
            price_fetcher=FakePriceFetcher(Decimal("100")),
        )
        pipeline._is_market_session_open = lambda _now=None: True  # type: ignore[method-assign]

        with (
            patch.object(
                SimpleTradingPipeline,
                "_external_paper_route_target_probe_symbols_cached",
                return_value=({"AAPL", "AMZN"}, None, [target]),
            ),
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
                "app.trading.scheduler.simple_pipeline.trading_now", return_value=now
            ),
            patch("app.trading.scheduler.pipeline.trading_now", return_value=now),
            patch("app.trading.simulation.trading_now", return_value=now),
        ):
            pipeline.run_once()

        self.assertEqual(ingestor.fetch_scopes, [({"AAPL", "AMZN"}, {"1Sec"})])
        self.assertEqual(ingestor.committed_batches, 1)
        with self.session_local() as session:
            decisions = list(session.execute(select(TradeDecision)).scalars())
            self.assertEqual(len(decisions), 2)
            symbols = sorted(decision.symbol for decision in decisions)
            self.assertEqual(symbols, ["AAPL", "AMZN"])
            for decision in decisions:
                decision_json = cast(dict[str, Any], decision.decision_json)
                params = cast(dict[str, Any], decision_json.get("params"))
                self.assertEqual(
                    params.get("source_decision_mode"),
                    BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE,
                )
                self.assertTrue(params.get("profit_proof_eligible"))
                self.assertEqual(params.get("source_hypothesis_ids"), ["H-PAIRS-01"])
                target_plan = cast(
                    dict[str, Any],
                    params.get("paper_route_target_plan"),
                )
                self.assertEqual(
                    target_plan.get("candidate_id"), "candidate-pairs-monday"
                )
                self.assertEqual(
                    target_plan.get("source_decision_mode"),
                    BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE,
                )
                self.assertTrue(target_plan.get("profit_proof_eligible"))

    def test_fetch_signal_batch_falls_back_for_legacy_ingestor_signature(self) -> None:
        class LegacyIngestor:
            def __init__(self) -> None:
                self.calls = 0

            def fetch_signals(self, session: Session) -> SignalBatch:
                self.calls += 1
                return SignalBatch(
                    signals=[],
                    cursor_at=None,
                    cursor_seq=None,
                    cursor_symbol=None,
                )

        ingestor = LegacyIngestor()
        pipeline = object.__new__(SimpleTradingPipeline)
        setattr(pipeline, "account_label", "TORGHUT_SIM")
        setattr(pipeline, "ingestor", ingestor)

        with self.session_local() as session:
            batch = pipeline._fetch_signal_batch(
                session,
                signal_scope=({"AAPL"}, {"1Sec"}),
            )

        self.assertEqual(batch.signals, [])
        self.assertEqual(ingestor.calls, 1)

    def test_bounded_signal_scope_skips_unusable_targets_before_valid_target(
        self,
    ) -> None:
        from app import config

        now = datetime(2026, 6, 1, 14, 30, tzinfo=timezone.utc)
        window_start = datetime(2026, 6, 1, 13, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 6, 1, 20, 0, tzinfo=timezone.utc)
        config.settings.trading_mode = "paper"
        config.settings.trading_simple_paper_route_probe_enabled = True
        strategy = Strategy(
            name="microbar-cross-sectional-pairs-v1",
            enabled=True,
            base_timeframe="1Sec",
            universe_type="static",
            universe_symbols=["AAPL", "AMZN"],
        )

        def target(**overrides: object) -> dict[str, object]:
            item: dict[str, object] = {
                "paper_route_probe_symbols": ["AAPL", "AMZN"],
                "paper_route_probe_window_start": window_start.isoformat(),
                "paper_route_probe_window_end": window_end.isoformat(),
                "candidate_id": "candidate-pairs-monday",
                "hypothesis_id": "H-PAIRS-01",
                "observed_stage": "paper",
                "strategy_family": "microbar_cross_sectional_pairs",
                "strategy_name": "microbar-cross-sectional-pairs-v1",
                "runtime_strategy_name": "microbar-cross-sectional-pairs-v1",
                "source_kind": "paper_route_probe_runtime_observed",
                "source_manifest_ref": "config/trading/hypotheses/h-pairs-01.json",
                "account_label": "TORGHUT_SIM",
                "evidence_collection_ok": True,
                "paper_route_target_account_audit_state": (
                    self._paper_route_target_account_audit_state(["AAPL", "AMZN"])
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
            }
            item.update(overrides)
            return item

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
        targets = [
            target(paper_route_account_pre_session_blockers=["not_flat"]),
            target(
                paper_route_probe_window_start=None, paper_route_probe_window_end=None
            ),
            target(
                paper_route_probe_window_start=(
                    window_start - timedelta(days=1)
                ).isoformat(),
                paper_route_probe_window_end=(
                    window_end - timedelta(days=1)
                ).isoformat(),
            ),
            target(strategy_name="missing-strategy", runtime_strategy_name="missing"),
            target(),
        ]

        with (
            patch.object(
                SimpleTradingPipeline,
                "_external_paper_route_target_probe_symbols_cached",
                return_value=({"AAPL", "AMZN"}, None, targets),
            ),
            patch(
                "app.trading.scheduler.simple_pipeline.trading_now", return_value=now
            ),
        ):
            scope = pipeline._bounded_paper_route_signal_scope([strategy])

        self.assertEqual(scope, ({"AAPL", "AMZN"}, {"1Sec"}))

    def test_paper_route_target_plan_reservation_rejects_unusable_targets(self) -> None:
        from app import config

        window_start = datetime(2026, 6, 1, 13, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 6, 1, 20, 0, tzinfo=timezone.utc)
        now = window_start + timedelta(minutes=5)
        config.settings.trading_mode = "paper"
        config.settings.trading_simple_paper_route_probe_enabled = True
        pipeline = object.__new__(SimpleTradingPipeline)
        setattr(pipeline, "account_label", "TORGHUT_SIM")
        base_target = {
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
        }
        targets = [
            {
                **base_target,
                "paper_route_account_pre_session_blockers": [
                    "unlinked_order_events_present"
                ],
            },
            {**base_target, "paper_route_probe_window_start": None},
            {
                **base_target,
                "paper_route_probe_window_start": (
                    window_start + timedelta(days=1)
                ).isoformat(),
                "paper_route_probe_window_end": (
                    window_end + timedelta(days=1)
                ).isoformat(),
            },
            base_target,
        ]
        setattr(
            pipeline,
            "_external_paper_route_target_probe_symbols_cached",
            lambda **_kwargs: ({"AAPL", "AMZN"}, None, targets),
        )

        with patch(
            "app.trading.scheduler.simple_pipeline.trading_now",
            return_value=now,
        ):
            setattr(pipeline, "_is_market_session_open", lambda _now: False)
            self.assertFalse(
                pipeline._paper_route_target_plan_reserves_account(
                    allowed_symbols=set()
                )
            )
            setattr(pipeline, "_is_market_session_open", lambda _now: True)
            # An active bounded H-PAIRS owner reserves the whole paper account,
            # not just symbols that overlap the candidate target.
            self.assertTrue(
                pipeline._paper_route_target_plan_reserves_account(
                    allowed_symbols={"MSFT"}
                )
            )

    def test_paper_route_flat_repair_snapshot_handles_query_and_shape_failures(
        self,
    ) -> None:
        class RaisingSession:
            def execute(self, *_args: object, **_kwargs: object) -> object:
                raise RuntimeError("snapshot query failed")

        class ResultWithStringPositions:
            def first(self) -> tuple[str, datetime]:
                return (
                    "not-a-position-list",
                    datetime(2026, 6, 1, tzinfo=timezone.utc),
                )

        class StringPositionsSession:
            def execute(
                self, *_args: object, **_kwargs: object
            ) -> ResultWithStringPositions:
                return ResultWithStringPositions()

        self.assertFalse(
            SimpleTradingPipeline._paper_route_target_symbol_has_flat_repair_snapshot(
                session=cast(Session, RaisingSession()),
                account_label="TORGHUT_SIM",
                symbol="AMZN",
                after=datetime(2026, 6, 1, tzinfo=timezone.utc),
            )
        )
        self.assertFalse(
            SimpleTradingPipeline._paper_route_target_symbol_has_flat_repair_snapshot(
                session=cast(Session, StringPositionsSession()),
                account_label="TORGHUT_SIM",
                symbol="AMZN",
                after=datetime(2026, 6, 1, tzinfo=timezone.utc),
            )
        )

    def test_paper_route_account_exposure_detects_market_value(self) -> None:
        self.assertTrue(
            SimpleTradingPipeline._paper_route_target_account_has_open_exposure(
                [{"symbol": "NVDA", "qty": "0", "market_value": "10"}]
            )
        )
        self.assertFalse(
            SimpleTradingPipeline._paper_route_target_account_has_open_exposure(
                [{"symbol": "NVDA", "qty": "0", "market_value": "0"}]
            )
        )

    def test_paper_decision_persists_external_target_lineage_existing_row(
        self,
    ) -> None:
        from app import config

        config.settings.trading_mode = "paper"
        config.settings.trading_simple_paper_route_probe_enabled = True
        config.settings.trading_paper_route_target_plan_url = (
            "http://torghut.local/trading/paper-route-evidence"
        )
        config.settings.trading_paper_route_target_plan_timeout_seconds = 1.0
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
                name="microbar-cross-sectional-pairs-v1",
                enabled=True,
                base_timeframe="1Sec",
                universe_type="static",
                universe_symbols=["AMZN"],
            )
            session.add(strategy)
            session.commit()
            session.refresh(strategy)
            decision = StrategyDecision(
                strategy_id=str(strategy.id),
                symbol="AMZN",
                event_ts=datetime(2026, 3, 26, 14, 31, tzinfo=timezone.utc),
                timeframe="1Sec",
                action="sell",
                qty=Decimal("1"),
                params={"price": "200"},
            )
            existing = pipeline.executor.ensure_decision(
                session,
                decision,
                strategy,
                pipeline.account_label,
            )
            existing_payload = cast(dict[str, Any], existing.decision_json)
            existing_params = cast(dict[str, Any], existing_payload.get("params"))
            self.assertNotIn("paper_route_target_plan", existing_params)

            with patch(
                "app.trading.scheduler.simple_pipeline.fetch_paper_route_target_plan_url",
                return_value={
                    "targets": [
                        {
                            "paper_route_probe_symbols": ["AMZN"],
                            "candidate_id": "candidate-pairs-a",
                            "hypothesis_id": "H-PAIRS-01",
                            "strategy_name": "microbar-cross-sectional-pairs-v1",
                        }
                    ]
                },
            ):
                row = pipeline._ensure_pending_decision_row(
                    session=session,
                    decision=decision,
                    strategy=strategy,
                )

            self.assertIsNotNone(row)
            assert row is not None
            self.assertEqual(row.id, existing.id)
            session.refresh(row)
            payload = cast(dict[str, Any], row.decision_json)
            params = cast(dict[str, Any], payload.get("params"))
            target_plan = cast(dict[str, Any], params.get("paper_route_target_plan"))

        self.assertEqual(params.get("source_candidate_ids"), ["candidate-pairs-a"])
        self.assertEqual(params.get("source_hypothesis_ids"), ["H-PAIRS-01"])
        self.assertEqual(target_plan.get("mode"), "paper_route_target_lineage")
        self.assertNotIn("paper_route_probe", params)

    def test_paper_route_target_lineage_cache_and_existing_plan_merge(self) -> None:
        from app import config

        config.settings.trading_mode = "paper"
        config.settings.trading_simple_paper_route_probe_enabled = True
        config.settings.trading_paper_route_target_plan_url = (
            "http://torghut.local/trading/paper-route-evidence"
        )
        config.settings.trading_paper_route_target_plan_timeout_seconds = 1.0
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
        first = StrategyDecision(
            strategy_id="strategy-1",
            symbol="AAPL",
            event_ts=datetime(2026, 3, 26, 14, 30, tzinfo=timezone.utc),
            timeframe="1Sec",
            action="sell",
            qty=Decimal("1"),
            params={
                "price": "100",
                "paper_route_target_plan": {
                    "existing": "keep",
                    "source_candidate_ids": ["candidate-existing"],
                },
            },
        )
        second = first.model_copy(update={"symbol": "MSFT", "params": {"price": "200"}})
        fetch = Mock(
            return_value={
                "targets": [
                    {
                        "paper_route_probe_symbols": ["AAPL"],
                        "candidate_id": "candidate-aapl",
                        "hypothesis_id": "H-AAPL",
                        "strategy_name": "pairs-runtime-a",
                        "strategy_lookup_names": ["strategy-1"],
                    },
                    {
                        "paper_route_probe_symbols": ["MSFT"],
                        "candidate_id": "candidate-msft",
                        "hypothesis_id": "H-MSFT",
                        "strategy_name": "pairs-runtime-b",
                        "strategy_lookup_names": ["strategy-1"],
                    },
                ]
            }
        )

        with (
            patch(
                "app.trading.scheduler.simple_pipeline.trading_now",
                return_value=datetime(2026, 3, 26, 14, 31, tzinfo=timezone.utc),
            ),
            patch(
                "app.trading.scheduler.simple_pipeline.fetch_paper_route_target_plan_url",
                fetch,
            ),
        ):
            enriched_first = pipeline._with_paper_route_target_lineage(first)
            enriched_second = pipeline._with_paper_route_target_lineage(second)

        self.assertEqual(fetch.call_count, 1)
        first_params = cast(dict[str, Any], enriched_first.params)
        first_target_plan = cast(
            dict[str, Any], first_params.get("paper_route_target_plan")
        )
        self.assertEqual(first_target_plan.get("existing"), "keep")
        self.assertEqual(
            first_target_plan.get("source_candidate_ids"),
            ["candidate-existing", "candidate-aapl"],
        )
        self.assertEqual(first_params.get("source_candidate_ids"), ["candidate-aapl"])
        self.assertEqual(first_params.get("source_hypothesis_ids"), ["H-AAPL"])
        second_params = cast(dict[str, Any], enriched_second.params)
        second_target_plan = cast(
            dict[str, Any], second_params.get("paper_route_target_plan")
        )
        self.assertEqual(
            second_target_plan.get("source_candidate_ids"), ["candidate-msft"]
        )
        self.assertEqual(second_params.get("source_hypothesis_ids"), ["H-MSFT"])
        self.assertNotIn("paper_route_probe", first_params)
        self.assertNotIn("paper_route_probe", second_params)
