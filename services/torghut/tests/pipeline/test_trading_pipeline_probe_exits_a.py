from __future__ import annotations

# ruff: noqa: F403,F405
from tests.pipeline.trading_pipeline_base import *


class TestTradingPipelineProbeExitsA(TradingPipelineTestCaseBase):
    def test_simple_pipeline_retries_blocked_paper_route_decision_without_new_signal(
        self,
    ) -> None:
        from app import config

        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_live_enabled = False
        config.settings.trading_pipeline_mode = "simple"
        config.settings.trading_simple_submit_enabled = True
        config.settings.trading_fractional_equities_enabled = True
        config.settings.trading_simple_paper_route_probe_enabled = True
        config.settings.trading_simple_paper_route_probe_max_notional = 25.0
        config.settings.trading_simple_paper_route_probe_retry_attempt_limit = 2
        config.settings.trading_simple_paper_route_probe_retry_batch_limit = 4
        config.settings.trading_simple_paper_route_probe_retry_scan_limit = 16
        config.settings.trading_paper_route_target_plan_url = ""
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"
        config.settings.trading_universe_static_fallback_enabled = True
        config.settings.trading_universe_static_fallback_symbols_raw = "AAPL"

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
        event_ts = datetime(2026, 3, 26, 13, 30, tzinfo=timezone.utc)

        with self.session_local() as session:
            strategy = Strategy(
                name="simple-paper-proof-floor-no-signal-retry",
                description="simple paper retry after proof floor block without new signal",
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

        alpaca_client = FakeAlpacaClient()
        ingestor = FakeIngestor([])
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
            account_label="paper",
            session_factory=self.session_local,
        )
        pipeline._is_market_session_open = lambda _now=None: True  # type: ignore[method-assign]

        with (
            patch.object(
                SimpleTradingPipeline,
                "_profitability_proof_floor",
                return_value=proof_floor,
            ),
            patch(
                "app.trading.scheduler.simple_pipeline.trading_now",
                return_value=datetime(2026, 3, 26, 14, 0, tzinfo=timezone.utc),
            ),
        ):
            pipeline.run_once()

        self.assertEqual(ingestor.committed_batches, 1)
        self.assertEqual(len(alpaca_client.submitted), 1)
        self.assertEqual(alpaca_client.submitted[0]["qty"], "0.25")
        with self.session_local() as session:
            refreshed = session.execute(select(TradeDecision)).scalar_one()
            execution = session.execute(select(Execution)).scalar_one()
            refreshed_json = cast(dict[str, Any], refreshed.decision_json)
            params = cast(dict[str, Any], refreshed_json.get("params"))
            paper_route_probe = cast(dict[str, Any], params.get("paper_route_probe"))
            simple_lane = cast(dict[str, Any], params.get("simple_lane"))
            retry = cast(dict[str, Any], refreshed_json.get("paper_route_probe_retry"))

            self.assertEqual(refreshed.status, "submitted")
            self.assertEqual(execution.trade_decision_id, refreshed.id)
            self.assertEqual(paper_route_probe.get("mode"), "paper_route_acquisition")
            self.assertEqual(
                Decimal(str(paper_route_probe.get("capped_notional"))),
                Decimal("25.000000"),
            )
            self.assertEqual(simple_lane.get("paper_route_probe_cap_applied"), True)
            self.assertEqual(
                retry.get("previous_submission_block_reason"),
                "alpha_readiness_not_promotion_eligible",
            )
            self.assertEqual(refreshed_json.get("paper_route_probe_retry_attempts"), 1)

    def test_simple_pipeline_closes_filled_paper_route_probe_after_exit_minute(
        self,
    ) -> None:
        self._seed_filled_paper_route_probe_entry()
        alpaca_client = PositionedAlpacaClient(
            [{"symbol": "AAPL", "qty": "2", "side": "long"}]
        )

        self._run_simple_paper_pipeline(
            alpaca_client=alpaca_client,
            now=datetime(2026, 3, 26, 15, 31, tzinfo=timezone.utc),
        )

        self.assertEqual(len(alpaca_client.submitted), 1)
        self.assertEqual(alpaca_client.submitted[0]["side"], "sell")
        self.assertEqual(alpaca_client.submitted[0]["qty"], "2.0")
        with self.session_local() as session:
            decisions = (
                session.execute(
                    select(TradeDecision).order_by(TradeDecision.created_at.asc())
                )
                .scalars()
                .all()
            )
            self.assertEqual(len(decisions), 2)
            exit_row = decisions[-1]
            exit_payload = cast(dict[str, Any], exit_row.decision_json)
            params = cast(dict[str, Any], exit_payload.get("params"))
            exit_metadata = cast(
                dict[str, Any],
                params.get("paper_route_probe_exit"),
            )

            self.assertEqual(exit_row.status, "submitted")
            self.assertEqual(exit_payload.get("action"), "sell")
            self.assertEqual(exit_metadata.get("mode"), "paper_route_exit")
            self.assertEqual(exit_metadata.get("db_open_qty"), "2.00000000")
            self.assertEqual(exit_metadata.get("broker_position_qty"), "2")
            self.assertEqual(
                exit_metadata.get("exit_due_at"),
                "2026-03-26T15:30:00+00:00",
            )

    def test_simple_pipeline_carries_paper_route_lineage_to_exit_decision(
        self,
    ) -> None:
        self._seed_filled_paper_route_probe_entry(
            source_candidate_ids=("candidate-pairs-a",),
            source_hypothesis_ids=("H-PAIRS-01",),
            source_strategy_names=("microbar-cross-sectional-pairs-v1",),
        )
        alpaca_client = PositionedAlpacaClient(
            [{"symbol": "AAPL", "qty": "2", "side": "long"}]
        )

        self._run_simple_paper_pipeline(
            alpaca_client=alpaca_client,
            now=datetime(2026, 3, 26, 15, 31, tzinfo=timezone.utc),
        )

        with self.session_local() as session:
            decisions = (
                session.execute(
                    select(TradeDecision).order_by(TradeDecision.created_at.asc())
                )
                .scalars()
                .all()
            )
            self.assertEqual(len(decisions), 2)
            exit_payload = cast(dict[str, Any], decisions[-1].decision_json)
            params = cast(dict[str, Any], exit_payload.get("params"))
            exit_metadata = cast(
                dict[str, Any],
                params.get("paper_route_probe_exit"),
            )

        self.assertEqual(
            exit_metadata.get("source_candidate_ids"),
            ["candidate-pairs-a"],
        )
        self.assertEqual(
            exit_metadata.get("source_hypothesis_ids"),
            ["H-PAIRS-01"],
        )
        self.assertEqual(
            exit_metadata.get("source_strategy_names"),
            ["microbar-cross-sectional-pairs-v1"],
        )
        self.assertEqual(
            exit_metadata.get("paper_route_probe_lineage_targets"),
            [
                {
                    "candidate_id": "candidate-pairs-a",
                    "hypothesis_id": "H-PAIRS-01",
                    "strategy_name": "microbar-cross-sectional-pairs-v1",
                }
            ],
        )

    def test_simple_pipeline_closes_short_paper_route_probe_with_buy_exit(
        self,
    ) -> None:
        self._seed_filled_paper_route_probe_entry(
            symbol="AMZN",
            side="sell",
            source_candidate_ids=("candidate-pairs-a",),
            source_hypothesis_ids=("H-PAIRS-01",),
            source_strategy_names=("microbar-cross-sectional-pairs-v1",),
        )
        alpaca_client = PositionedAlpacaClient(
            [{"symbol": "AMZN", "qty": "2", "side": "short"}]
        )

        self._run_simple_paper_pipeline(
            alpaca_client=alpaca_client,
            now=datetime(2026, 3, 26, 15, 31, tzinfo=timezone.utc),
        )

        self.assertEqual(len(alpaca_client.submitted), 1)
        self.assertEqual(alpaca_client.submitted[0]["side"], "buy")
        self.assertEqual(alpaca_client.submitted[0]["qty"], "2.0")
        with self.session_local() as session:
            decisions = (
                session.execute(
                    select(TradeDecision).order_by(TradeDecision.created_at.asc())
                )
                .scalars()
                .all()
            )
            self.assertEqual(len(decisions), 2)
            exit_payload = cast(dict[str, Any], decisions[-1].decision_json)
            params = cast(dict[str, Any], exit_payload.get("params"))
            exit_metadata = cast(
                dict[str, Any],
                params.get("paper_route_probe_exit"),
            )

        self.assertEqual(exit_payload.get("action"), "buy")
        self.assertEqual(exit_metadata.get("db_open_side"), "short")
        self.assertEqual(exit_metadata.get("db_open_qty"), "2.00000000")
        self.assertEqual(
            exit_metadata.get("source_candidate_ids"), ["candidate-pairs-a"]
        )
        self.assertEqual(exit_metadata.get("source_hypothesis_ids"), ["H-PAIRS-01"])

    def test_simple_pipeline_closes_late_filled_probe_from_strategy_exit_metadata(
        self,
    ) -> None:
        self._seed_filled_paper_route_probe_entry(
            entry_ts=datetime(2026, 3, 26, 15, 45, tzinfo=timezone.utc),
            include_decision_exit_minute=False,
        )
        alpaca_client = PositionedAlpacaClient(
            [{"symbol": "AAPL", "qty": "2", "side": "long"}]
        )

        self._run_simple_paper_pipeline(
            alpaca_client=alpaca_client,
            now=datetime(2026, 3, 26, 15, 46, tzinfo=timezone.utc),
        )

        self.assertEqual(len(alpaca_client.submitted), 1)
        self.assertEqual(alpaca_client.submitted[0]["side"], "sell")
        with self.session_local() as session:
            decisions = (
                session.execute(
                    select(TradeDecision).order_by(TradeDecision.created_at.asc())
                )
                .scalars()
                .all()
            )
            self.assertEqual(len(decisions), 2)
            exit_payload = cast(dict[str, Any], decisions[-1].decision_json)
            params = cast(dict[str, Any], exit_payload.get("params"))
            exit_metadata = cast(
                dict[str, Any],
                params.get("paper_route_probe_exit"),
            )
            self.assertEqual(
                exit_metadata.get("exit_due_at"),
                "2026-03-26T15:30:00+00:00",
            )

    def test_simple_pipeline_closes_probe_even_when_signal_preparation_blocks(
        self,
    ) -> None:
        self._seed_filled_paper_route_probe_entry()
        alpaca_client = PositionedAlpacaClient(
            [{"symbol": "AAPL", "qty": "2", "side": "long"}]
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 26, 15, 31, tzinfo=timezone.utc),
            ingest_ts=datetime(2026, 3, 26, 15, 31, 5, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Min",
            seq=1,
            payload={
                "feature_schema_version": "3.0.0",
                "macd": {"macd": 1.2, "signal": 0.5},
                "rsi14": 25,
                "price": 100,
            },
        )

        with patch.object(
            SimpleTradingPipeline,
            "_prepare_batch_for_decisions",
            return_value=False,
        ):
            self._run_simple_paper_pipeline(
                alpaca_client=alpaca_client,
                now=datetime(2026, 3, 26, 15, 31, tzinfo=timezone.utc),
                signals=[signal],
            )

        self.assertEqual(len(alpaca_client.submitted), 1)
        self.assertEqual(alpaca_client.submitted[0]["side"], "sell")

    def test_simple_pipeline_repairs_stale_paper_route_probe_exit_next_session(
        self,
    ) -> None:
        self._seed_filled_paper_route_probe_entry(
            entry_ts=datetime(2026, 3, 26, 18, 40, tzinfo=timezone.utc),
            exit_minute_after_open="120",
        )
        alpaca_client = PositionedAlpacaClient(
            [{"symbol": "AAPL", "qty": "2", "side": "long"}]
        )

        self._run_simple_paper_pipeline(
            alpaca_client=alpaca_client,
            now=datetime(2026, 3, 27, 14, 31, tzinfo=timezone.utc),
        )

        self.assertEqual(len(alpaca_client.submitted), 1)
        self.assertEqual(alpaca_client.submitted[0]["side"], "sell")
        with self.session_local() as session:
            exit_row = (
                session.execute(
                    select(TradeDecision)
                    .where(TradeDecision.symbol == "AAPL")
                    .order_by(TradeDecision.created_at.desc())
                )
                .scalars()
                .first()
            )
            assert exit_row is not None
            exit_payload = cast(dict[str, Any], exit_row.decision_json)
            params = cast(dict[str, Any], exit_payload.get("params"))
            exit_metadata = cast(
                dict[str, Any],
                params.get("paper_route_probe_exit"),
            )

            self.assertEqual(exit_payload.get("action"), "sell")
            self.assertEqual(
                exit_metadata.get("session_open"),
                "2026-03-26T13:30:00+00:00",
            )
            self.assertEqual(
                exit_metadata.get("exit_due_at"),
                "2026-03-26T15:30:00+00:00",
            )
            self.assertEqual(exit_metadata.get("stale_exit_repair"), True)

    def test_paper_route_probe_exit_session_open_prefers_exit_metadata(
        self,
    ) -> None:
        decision = StrategyDecision(
            strategy_id="strategy-1",
            symbol="AAPL",
            event_ts=datetime(2026, 3, 26, 18, 40, tzinfo=timezone.utc),
            timeframe="1Min",
            action="sell",
            qty=Decimal("1"),
            rationale="paper-route-exit",
            params={
                "paper_route_probe_exit": {
                    "mode": "paper_route_exit",
                    "session_open": datetime(
                        2026,
                        3,
                        25,
                        16,
                        tzinfo=timezone.utc,
                    ),
                }
            },
        )
        fallback = datetime(2026, 3, 27, 14, 31, tzinfo=timezone.utc)

        self.assertEqual(
            SimpleTradingPipeline._paper_route_probe_exit_session_open(
                decision=decision,
                fallback=fallback,
            ),
            datetime(2026, 3, 25, 13, 30, tzinfo=timezone.utc),
        )

        parsed_text_decision = decision.model_copy(
            update={
                "params": {
                    "paper_route_probe_exit": {
                        "mode": "paper_route_exit",
                        "session_open": "2026-03-24T17:55:00Z",
                    }
                }
            }
        )
        self.assertEqual(
            SimpleTradingPipeline._paper_route_probe_exit_session_open(
                decision=parsed_text_decision,
                fallback=fallback,
            ),
            datetime(2026, 3, 24, 13, 30, tzinfo=timezone.utc),
        )

        invalid_text_decision = decision.model_copy(
            update={
                "params": {
                    "paper_route_probe_exit": {
                        "mode": "paper_route_exit",
                        "session_open": "not-a-timestamp",
                    }
                }
            }
        )
        self.assertEqual(
            SimpleTradingPipeline._paper_route_probe_exit_session_open(
                decision=invalid_text_decision,
                fallback=fallback,
            ),
            datetime(2026, 3, 27, 13, 30, tzinfo=timezone.utc),
        )
        self.assertEqual(
            SimpleTradingPipeline._paper_route_probe_session_open(
                datetime(2026, 1, 5, 15, 31, tzinfo=timezone.utc)
            ),
            datetime(2026, 1, 5, 14, 30, tzinfo=timezone.utc),
        )

    def test_simple_pipeline_does_not_close_paper_route_probe_before_exit_minute(
        self,
    ) -> None:
        self._seed_filled_paper_route_probe_entry()
        alpaca_client = PositionedAlpacaClient(
            [{"symbol": "AAPL", "qty": "2", "side": "long"}]
        )

        self._run_simple_paper_pipeline(
            alpaca_client=alpaca_client,
            now=datetime(2026, 3, 26, 15, 29, tzinfo=timezone.utc),
        )

        self.assertEqual(alpaca_client.submitted, [])
        with self.session_local() as session:
            self.assertEqual(session.query(TradeDecision).count(), 1)

    def test_simple_pipeline_does_not_duplicate_paper_route_probe_exit(
        self,
    ) -> None:
        self._seed_filled_paper_route_probe_entry()
        alpaca_client = PositionedAlpacaClient(
            [{"symbol": "AAPL", "qty": "2", "side": "long"}]
        )
        now = datetime(2026, 3, 26, 15, 31, tzinfo=timezone.utc)

        self._run_simple_paper_pipeline(alpaca_client=alpaca_client, now=now)
        self._run_simple_paper_pipeline(alpaca_client=alpaca_client, now=now)

        self.assertEqual(len(alpaca_client.submitted), 1)
        with self.session_local() as session:
            sell_count = (
                session.execute(
                    select(TradeDecision).where(TradeDecision.symbol == "AAPL")
                )
                .scalars()
                .all()
            )
            self.assertEqual(
                sum(
                    1
                    for decision_row in sell_count
                    if cast(dict[str, Any], decision_row.decision_json).get("action")
                    == "sell"
                ),
                1,
            )

    def test_simple_pipeline_allows_large_position_reducing_probe_exit(
        self,
    ) -> None:
        self._seed_filled_paper_route_probe_entry(qty=Decimal("20"))
        alpaca_client = PositionedAlpacaClient(
            [{"symbol": "AAPL", "qty": "20", "side": "long"}]
        )

        self._run_simple_paper_pipeline(
            alpaca_client=alpaca_client,
            now=datetime(2026, 3, 26, 15, 31, tzinfo=timezone.utc),
        )

        self.assertEqual(len(alpaca_client.submitted), 1)
        self.assertEqual(alpaca_client.submitted[0]["side"], "sell")
        self.assertEqual(alpaca_client.submitted[0]["qty"], "20.0")
        with self.session_local() as session:
            exit_row = (
                session.execute(
                    select(TradeDecision)
                    .where(TradeDecision.symbol == "AAPL")
                    .order_by(TradeDecision.created_at.desc())
                )
                .scalars()
                .first()
            )
            assert exit_row is not None
            self.assertEqual(exit_row.status, "submitted")
            payload = cast(dict[str, Any], exit_row.decision_json)
            self.assertNotIn("max_notional_exceeded", payload.get("risk_reasons", []))

    def test_simple_pipeline_closes_strategy_signal_paper_with_linked_exit(
        self,
    ) -> None:
        self._seed_filled_paper_route_probe_entry(
            source_candidate_ids=["cand-h-pairs"],
            source_hypothesis_ids=["H-PAIRS-01"],
            source_strategy_names=["microbar-cross-sectional-pairs-v1"],
            source_decision_mode="strategy_signal_paper",
            profit_proof_eligible=True,
        )
        alpaca_client = PositionedAlpacaClient(
            [{"symbol": "AAPL", "qty": "2", "side": "long"}]
        )

        self._run_simple_paper_pipeline(
            alpaca_client=alpaca_client,
            now=datetime(2026, 3, 26, 15, 31, tzinfo=timezone.utc),
        )

        self.assertEqual(len(alpaca_client.submitted), 1)
        self.assertEqual(alpaca_client.submitted[0]["side"], "sell")
        self.assertEqual(alpaca_client.submitted[0]["qty"], "2.0")
        with self.session_local() as session:
            decisions = (
                session.execute(
                    select(TradeDecision).order_by(TradeDecision.created_at)
                )
                .scalars()
                .all()
            )
            self.assertEqual(len(decisions), 2)
            payload = cast(dict[str, Any], decisions[-1].decision_json)
            params = cast(dict[str, Any], payload["params"])
            exit_metadata = cast(dict[str, Any], params.get("paper_route_probe_exit"))

            self.assertEqual(payload.get("action"), "sell")
            self.assertEqual(params["source_decision_mode"], "strategy_signal_paper")
            self.assertTrue(params["profit_proof_eligible"])
            self.assertEqual(exit_metadata.get("mode"), "paper_route_exit")
            self.assertEqual(
                exit_metadata.get("source"),
                "filled_strategy_signal_paper_executions",
            )
            self.assertEqual(
                exit_metadata.get("source_decision_mode"),
                "strategy_signal_paper",
            )
            self.assertTrue(exit_metadata.get("profit_proof_eligible"))
            self.assertEqual(
                exit_metadata.get("source_candidate_ids"), ["cand-h-pairs"]
            )
            self.assertEqual(exit_metadata.get("source_hypothesis_ids"), ["H-PAIRS-01"])
            self.assertEqual(
                exit_metadata.get("source_strategy_names"),
                ["microbar-cross-sectional-pairs-v1"],
            )

    def test_paper_route_probe_entry_metadata_rejects_proof_and_non_probe_rows(
        self,
    ) -> None:
        self.assertIsNone(_paper_route_probe_entry_metadata({}))
        self.assertIsNone(
            _paper_route_probe_entry_metadata(
                {
                    "profit_proof_eligible": True,
                    "paper_route_probe": {"mode": "paper_route_acquisition"},
                }
            )
        )
        self.assertIsNone(
            _paper_route_probe_entry_metadata(
                {
                    "paper_route_probe": {
                        "mode": "paper_route_acquisition",
                        "source_decision_mode": "strategy_signal_paper",
                    }
                }
            )
        )
        self.assertIsNone(
            _paper_route_probe_entry_metadata(
                {
                    "paper_route_probe": {
                        "mode": "paper_route_acquisition",
                        "profit_proof_eligible": True,
                    }
                }
            )
        )
        self.assertEqual(
            _paper_route_probe_entry_metadata(
                {
                    "paper_route_probe": {
                        "mode": "paper_route_acquisition",
                        "source_decision_mode": "route_acquisition_probe",
                    }
                }
            ),
            {
                "mode": "paper_route_acquisition",
                "source_decision_mode": "route_acquisition_probe",
            },
        )

    def test_bounded_paper_route_collection_entry_metadata_accepts_proof_rows(
        self,
    ) -> None:
        params = {
            "source_decision_mode": BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE,
            "profit_proof_eligible": True,
            "paper_route_probe": {
                "mode": "bounded_paper_route_collection",
                "source_decision_mode": (
                    BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE
                ),
                "profit_proof_eligible": True,
            },
        }

        self.assertEqual(
            _bounded_paper_route_collection_entry_metadata(params),
            params["paper_route_probe"],
        )
        self.assertIsNone(_paper_route_probe_entry_metadata(params))
        self.assertIsNone(
            _bounded_paper_route_collection_entry_metadata(
                {
                    **params,
                    "profit_proof_eligible": False,
                    "paper_route_probe": {
                        **params["paper_route_probe"],
                        "profit_proof_eligible": False,
                    },
                }
            )
        )
        self.assertIsNone(
            _bounded_paper_route_collection_entry_metadata(
                {
                    **params,
                    "source_decision_mode": ROUTE_ACQUISITION_SOURCE_DECISION_MODE,
                }
            )
        )

    def test_strategy_signal_paper_entry_metadata_rejects_incomplete_payloads(
        self,
    ) -> None:
        base_params: dict[str, Any] = {
            "source_decision_mode": STRATEGY_SIGNAL_PAPER_SOURCE_DECISION_MODE,
            "profit_proof_eligible": True,
            "strategy_signal_paper": {
                "mode": STRATEGY_SIGNAL_PAPER_SOURCE_DECISION_MODE,
                "profit_proof_eligible": True,
            },
        }

        self.assertIsNotNone(_strategy_signal_paper_entry_metadata(base_params))
        self.assertIsNone(
            _strategy_signal_paper_entry_metadata(
                {
                    **base_params,
                    "profit_proof_eligible": False,
                }
            )
        )
        self.assertIsNone(
            _strategy_signal_paper_entry_metadata(
                {
                    "source_decision_mode": STRATEGY_SIGNAL_PAPER_SOURCE_DECISION_MODE,
                    "profit_proof_eligible": True,
                }
            )
        )
        self.assertIsNone(
            _strategy_signal_paper_entry_metadata(
                {
                    **base_params,
                    "strategy_signal_paper": {
                        "mode": ROUTE_ACQUISITION_SOURCE_DECISION_MODE,
                        "profit_proof_eligible": True,
                    },
                }
            )
        )
        self.assertIsNone(
            _strategy_signal_paper_entry_metadata(
                {
                    **base_params,
                    "strategy_signal_paper": {
                        "mode": STRATEGY_SIGNAL_PAPER_SOURCE_DECISION_MODE,
                        "profit_proof_eligible": False,
                    },
                }
            )
        )
