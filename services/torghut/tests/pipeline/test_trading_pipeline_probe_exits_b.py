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
    PositionedAlpacaClient,
    Reconciler,
    RiskEngine,
    SignalEnvelope,
    SimpleTradingPipeline,
    SimulationExecutionAdapter,
    Strategy,
    StrategyDecision,
    TradeDecision,
    TradingPipelineTestCaseBase,
    TradingState,
    UniverseResolver,
    _bounded_sim_collection_target_with_runtime_account_audit,
    _paper_route_probe_lineage_from_params,
    _target_probe_symbol_notional_budget,
    cast,
    datetime,
    patch,
    select,
    timezone,
    uuid4,
)


class TestTradingPipelineProbeExitsB(TradingPipelineTestCaseBase):
    def test_runtime_account_audit_normalization_keeps_missing_readiness_blocked(
        self,
    ) -> None:
        normalized = _bounded_sim_collection_target_with_runtime_account_audit(
            {
                "hypothesis_id": "H-PAIRS-01",
                "candidate_id": "c88421d619759b2cfaa6f4d0",
                "account_label": "TORGHUT_SIM",
                "observed_stage": "paper",
                "runtime_strategy_name": "microbar-cross-sectional-pairs-v1",
                "source_kind": "paper_route_probe_runtime_observed",
                "source_manifest_ref": "config/trading/hypotheses/h-pairs-01.json",
                "paper_route_probe_symbols": ["AAPL", "AMZN"],
                "bounded_evidence_collection_blockers": [
                    "paper_route_target_account_audit_unavailable"
                ],
                "paper_route_target_account_audit_blockers": [
                    "paper_route_target_account_audit_unavailable"
                ],
                "evidence_collection_ok": False,
                "canary_collection_authorized": False,
                "bounded_evidence_collection_authorized": False,
                "bounded_live_paper_collection_authorized": False,
                "promotion_allowed": False,
                "final_promotion_authorized": False,
                "final_promotion_allowed": False,
                "capital_promotion_allowed": False,
            },
            positions=[],
            account_label="TORGHUT_SIM",
        )

        audit_state = cast(
            Mapping[str, Any],
            normalized["paper_route_target_account_audit_state"],
        )
        self.assertEqual(audit_state["state"], "available")
        self.assertEqual(normalized["paper_route_target_account_audit_blockers"], [])
        self.assertFalse(normalized["evidence_collection_ok"])

    def test_paper_route_probe_lineage_parses_profit_proof_eligibility(self) -> None:
        self.assertTrue(
            _paper_route_probe_lineage_from_params({"profit_proof_eligible": 1})[
                "profit_proof_eligible"
            ]
        )
        self.assertTrue(
            _paper_route_probe_lineage_from_params({"profit_proof_eligible": "true"})[
                "profit_proof_eligible"
            ]
        )
        self.assertFalse(
            _paper_route_probe_lineage_from_params({"profit_proof_eligible": "false"})[
                "profit_proof_eligible"
            ]
        )

    def test_paper_route_probe_lineage_falls_back_to_nested_source_mode(
        self,
    ) -> None:
        lineage = _paper_route_probe_lineage_from_params(
            {
                "paper_route_probe": {
                    "source_decision_mode": "strategy_signal_paper",
                    "profit_proof_eligible": True,
                }
            }
        )

        self.assertEqual(lineage["source_decision_mode"], "strategy_signal_paper")
        self.assertTrue(lineage["profit_proof_eligible"])

    def test_target_probe_symbol_notional_budget_normalizes_symbols(
        self,
    ) -> None:
        budget = _target_probe_symbol_notional_budget(
            target={"target_notional": "150"},
            symbol="AAPL",
            symbols=[" aapl ", "AMZN"],
            symbol_quantities={"AAPL": Decimal("2"), "AMZN": Decimal("1")},
            max_notional=Decimal("120"),
        )

        self.assertEqual(budget, Decimal("80"))

    def test_simple_pipeline_reopens_rejected_paper_route_probe_exit(
        self,
    ) -> None:
        from app import config

        config.settings.trading_mode = "paper"
        config.settings.trading_simple_paper_route_probe_enabled = True
        config.settings.trading_simple_paper_route_probe_retry_attempt_limit = 2
        self._seed_filled_paper_route_probe_entry()
        now = datetime(2026, 3, 26, 15, 31, tzinfo=timezone.utc)
        executor = OrderExecutor()
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
        pipeline._is_market_session_open = lambda _now=None: True
        with (
            patch(
                "app.trading.scheduler.simple_pipeline.trading_now",
                return_value=now,
            ),
            self.session_local() as session,
        ):
            exit_decisions = pipeline._paper_route_probe_exit_decisions(session=session)
            self.assertEqual(len(exit_decisions), 1)
            exit_decision = exit_decisions[0]
            strategy = (
                session.execute(
                    select(Strategy).where(Strategy.id == exit_decision.strategy_id)
                )
                .scalars()
                .one()
            )
            exit_row = executor.ensure_decision(
                session,
                exit_decision,
                strategy,
                "paper",
            )
            exit_payload = dict(cast(Mapping[str, Any], exit_row.decision_json))
            exit_payload["submission_stage"] = "rejected_pre_submit"
            exit_payload["risk_reasons"] = ["max_notional_exceeded"]
            exit_payload["reject_reason_atomic"] = ["max_notional_exceeded"]
            exit_row.status = "rejected"
            exit_row.decision_json = exit_payload
            session.add(exit_row)
            session.commit()

        alpaca_client = PositionedAlpacaClient(
            [{"symbol": "AAPL", "qty": "2", "side": "long"}]
        )

        self._run_simple_paper_pipeline(
            alpaca_client=alpaca_client,
            now=now,
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
            exit_row = decisions[-1]
            self.assertEqual(exit_row.status, "submitted")
            exit_payload = cast(dict[str, Any], exit_row.decision_json)
            self.assertEqual(
                exit_payload.get("submission_stage"),
                "submitted",
            )
            retry = cast(
                dict[str, Any],
                exit_payload.get("paper_route_probe_exit_retry"),
            )
            self.assertEqual(retry.get("previous_decision_status"), "rejected")
            self.assertEqual(
                retry.get("previous_submission_stage"), "rejected_pre_submit"
            )
            self.assertEqual(
                exit_payload.get("paper_route_probe_exit_retry_attempts"), 1
            )
            self.assertNotIn("risk_reasons", exit_payload)
            self.assertNotIn("reject_reason_atomic", exit_payload)

    def test_simple_pipeline_skips_probe_exit_retry_without_broker_inventory(
        self,
    ) -> None:
        decision = StrategyDecision(
            strategy_id=str(uuid4()),
            symbol="INTC",
            event_ts=datetime(2026, 3, 26, 15, 31, tzinfo=timezone.utc),
            timeframe="1Sec",
            action="sell",
            qty=Decimal("34.6997"),
            rationale="paper-route-probe-exit",
            params={
                "price": Decimal("108.37"),
                "paper_route_probe_exit": {
                    "mode": "paper_route_exit",
                    "db_open_qty": "34.69970000",
                    "db_open_side": "long",
                },
                "execution": {
                    "quantity_resolution": {
                        "action": "sell",
                        "symbol": "INTC",
                        "position_qty": "34.6997",
                    },
                },
            },
        )
        stale_cached_positions = [{"symbol": "INTC", "qty": "34.6997", "side": "long"}]
        broker_adapter = PositionedAlpacaClient([])

        prepared = SimpleTradingPipeline._prepare_paper_route_probe_exit_position(
            stale_cached_positions,
            decision,
            execution_adapter=broker_adapter,
            trading_mode="paper",
        )

        self.assertIsNone(prepared)

    def test_simple_pipeline_ignores_unusable_execution_adapter_positions(
        self,
    ) -> None:
        class RaisingPositionsAdapter:
            def list_positions(self) -> list[dict[str, str]]:
                raise RuntimeError("broker unavailable")

        class RawPositionsAdapter:
            def __init__(self, raw_positions: object) -> None:
                self.raw_positions = raw_positions

            def list_positions(self) -> object:
                return self.raw_positions

        self.assertIsNone(SimpleTradingPipeline._execution_adapter_positions(None))
        self.assertIsNone(SimpleTradingPipeline._execution_adapter_positions(object()))
        self.assertIsNone(
            SimpleTradingPipeline._execution_adapter_positions(
                RaisingPositionsAdapter()
            )
        )
        self.assertIsNone(
            SimpleTradingPipeline._execution_adapter_positions(
                RawPositionsAdapter("not positions")
            )
        )
        self.assertIsNone(
            SimpleTradingPipeline._execution_adapter_positions(
                RawPositionsAdapter({"symbol": "AAPL", "qty": "1"})
            )
        )
        self.assertEqual(
            SimpleTradingPipeline._execution_adapter_positions(
                RawPositionsAdapter([{"symbol": "AAPL", "qty": "1"}, "ignored"])
            ),
            [{"symbol": "AAPL", "qty": "1"}],
        )

    def test_simple_pipeline_skips_probe_exit_retry_submission_when_broker_flat(
        self,
    ) -> None:
        decision = StrategyDecision(
            strategy_id=str(uuid4()),
            symbol="INTC",
            event_ts=datetime(2026, 3, 26, 15, 31, tzinfo=timezone.utc),
            timeframe="1Sec",
            action="sell",
            qty=Decimal("34.6997"),
            rationale="paper-route-probe-exit",
            params={
                "price": Decimal("108.37"),
                "paper_route_probe_exit": {
                    "mode": "paper_route_exit",
                    "db_open_qty": "34.69970000",
                    "db_open_side": "long",
                },
                "execution": {
                    "quantity_resolution": {
                        "action": "sell",
                        "symbol": "INTC",
                        "position_qty": "34.6997",
                    },
                },
            },
        )
        pipeline = SimpleTradingPipeline(
            alpaca_client=FakeAlpacaClient(),
            order_firewall=OrderFirewall(FakeAlpacaClient()),
            ingestor=FakeIngestor([]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=PositionedAlpacaClient([]),
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="paper",
            session_factory=self.session_local,
        )
        positions = [{"symbol": "INTC", "qty": "34.6997", "side": "long"}]

        with (
            self.session_local() as session,
            patch.object(
                pipeline,
                "_paper_route_probe_retry_decisions",
                return_value=[decision],
            ),
            patch.object(pipeline, "_handle_decision") as handle_decision,
        ):
            pipeline._process_paper_route_probe_retry_decisions(
                session=session,
                strategies=[],
                account={"equity": "10000", "cash": "10000", "buying_power": "10000"},
                positions=positions,
                allowed_symbols={"INTC"},
            )

        handle_decision.assert_not_called()
        self.assertEqual(pipeline.state.metrics.decisions_total, 0)

    def test_simple_pipeline_does_not_exit_without_broker_inventory(
        self,
    ) -> None:
        self._seed_filled_paper_route_probe_entry()
        alpaca_client = PositionedAlpacaClient([])

        self._run_simple_paper_pipeline(
            alpaca_client=alpaca_client,
            now=datetime(2026, 3, 26, 15, 31, tzinfo=timezone.utc),
        )

        self.assertEqual(alpaca_client.submitted, [])
        with self.session_local() as session:
            decisions = session.execute(select(TradeDecision)).scalars().all()
            self.assertEqual(len(decisions), 1)
            payload = cast(dict[str, Any], decisions[0].decision_json)
            self.assertEqual(payload.get("action"), "buy")

    def test_simple_pipeline_restores_simulation_exit_position_from_db_open_qty(
        self,
    ) -> None:
        self._seed_filled_paper_route_probe_entry()
        alpaca_client = PositionedAlpacaClient([])
        execution_adapter = SimulationExecutionAdapter(
            bootstrap_servers=None,
            security_protocol=None,
            sasl_mechanism=None,
            sasl_username=None,
            sasl_password=None,
            topic="torghut.sim.trade-updates.v1",
            account_label="paper",
            simulation_run_id="paper-route-exit-test",
            dataset_id="paper-route-exit-test",
        )

        self._run_simple_paper_pipeline(
            alpaca_client=alpaca_client,
            execution_adapter=execution_adapter,
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
            executions = (
                session.execute(select(Execution).order_by(Execution.created_at.asc()))
                .scalars()
                .all()
            )

        self.assertEqual(
            [
                cast(dict[str, Any], row.decision_json).get("action")
                for row in decisions
            ],
            ["buy", "sell"],
        )
        self.assertEqual([execution.side for execution in executions], ["buy", "sell"])
        self.assertEqual(execution_adapter.list_positions(), [])

        exit_payload = cast(dict[str, Any], decisions[-1].decision_json)
        params = cast(dict[str, Any], exit_payload.get("params"))
        exit_metadata = cast(dict[str, Any], params.get("paper_route_probe_exit"))
        self.assertEqual(exit_metadata.get("broker_position_qty"), "0")
        self.assertEqual(exit_metadata.get("db_position_qty_fallback"), True)
        self.assertEqual(
            exit_metadata.get("position_source"),
            "source_execution_db_open_qty",
        )
        self.assertEqual(exit_metadata.get("effective_position_qty"), "2.00000000")

    def test_simulation_seed_missing_position_snapshot_fail_closed_edges(
        self,
    ) -> None:
        execution_adapter = SimulationExecutionAdapter(
            bootstrap_servers=None,
            security_protocol=None,
            sasl_mechanism=None,
            sasl_username=None,
            sasl_password=None,
            topic="torghut.sim.trade-updates.v1",
            account_label="paper",
            simulation_run_id="paper-route-exit-test",
            dataset_id="paper-route-exit-test",
        )

        self.assertFalse(execution_adapter.seed_missing_position_snapshot({}))
        self.assertFalse(
            execution_adapter.seed_missing_position_snapshot({"symbol": "AAPL"})
        )
        self.assertFalse(
            execution_adapter.seed_missing_position_snapshot(
                {"symbol": "AAPL", "qty": "bad"}
            )
        )
        self.assertFalse(
            execution_adapter.seed_missing_position_snapshot(
                {"symbol": "AAPL", "qty": "0"}
            )
        )
        self.assertTrue(
            execution_adapter.seed_missing_position_snapshot(
                {"symbol": "AAPL", "qty": "2", "side": "long"}
            )
        )
        self.assertFalse(
            execution_adapter.seed_missing_position_snapshot(
                {"symbol": "AAPL", "qty": "1", "side": "long"}
            )
        )

    def test_restore_simulation_exit_position_fail_closed_edges(self) -> None:
        decision = StrategyDecision(
            strategy_id=str(uuid4()),
            symbol="AAPL",
            event_ts=datetime(2026, 3, 26, 14, 0, tzinfo=timezone.utc),
            timeframe="1Min",
            action="sell",
            qty=Decimal("2"),
            rationale="paper-route-exit-edge",
            params={},
        )

        class NonCallableSeedAdapter:
            name = "simulation"

        class FalseSeedAdapter:
            name = "simulation"

            def seed_missing_position_snapshot(self, _position: object) -> bool:
                return False

        class RaisingSeedAdapter:
            name = "simulation"

            def seed_missing_position_snapshot(self, _position: object) -> bool:
                raise RuntimeError("seed failed")

        class RecordingSeedAdapter:
            name = "simulation"

            def __init__(self) -> None:
                self.positions: list[dict[str, Any]] = []

            def seed_missing_position_snapshot(self, position: object) -> bool:
                self.positions.append(dict(cast(Mapping[str, Any], position)))
                return True

        base_kwargs = {
            "positions": [],
            "decision": decision,
            "metadata": {"db_open_qty": "2"},
            "price": Decimal("100"),
            "execution_adapter": FalseSeedAdapter(),
        }

        self.assertIsNone(
            SimpleTradingPipeline._restore_simulation_paper_route_probe_exit_position(
                **{**base_kwargs, "trading_mode": "live"}
            )
        )
        self.assertIsNone(
            SimpleTradingPipeline._restore_simulation_paper_route_probe_exit_position(
                **{
                    **base_kwargs,
                    "trading_mode": "paper",
                    "execution_adapter": FakeAlpacaClient(),
                }
            )
        )
        self.assertIsNone(
            SimpleTradingPipeline._restore_simulation_paper_route_probe_exit_position(
                **{**base_kwargs, "trading_mode": "paper", "metadata": {}}
            )
        )
        self.assertIsNone(
            SimpleTradingPipeline._restore_simulation_paper_route_probe_exit_position(
                **{
                    **base_kwargs,
                    "trading_mode": "paper",
                    "execution_adapter": NonCallableSeedAdapter(),
                }
            )
        )
        self.assertIsNone(
            SimpleTradingPipeline._restore_simulation_paper_route_probe_exit_position(
                **{**base_kwargs, "trading_mode": "paper"}
            )
        )
        restored_positions: list[dict[str, Any]] = []
        recording_adapter = RecordingSeedAdapter()
        self.assertEqual(
            SimpleTradingPipeline._restore_simulation_paper_route_probe_exit_position(
                **{
                    **base_kwargs,
                    "positions": restored_positions,
                    "trading_mode": "paper",
                    "metadata": {"db_open_qty": "3", "db_open_side": "sideways"},
                    "execution_adapter": recording_adapter,
                }
            ),
            Decimal("2"),
        )
        self.assertEqual(
            recording_adapter.positions,
            [{"symbol": "AAPL", "qty": "2", "side": "long", "market_value": "200"}],
        )
        self.assertEqual(restored_positions, recording_adapter.positions)
        self.assertIsNone(
            SimpleTradingPipeline._restore_simulation_paper_route_probe_exit_position(
                **{
                    **base_kwargs,
                    "trading_mode": "paper",
                    "execution_adapter": RaisingSeedAdapter(),
                }
            )
        )

    def test_simple_pipeline_paper_route_exit_helpers_cover_filter_edges(
        self,
    ) -> None:
        from app import config

        config.settings.trading_mode = "paper"
        config.settings.trading_simple_paper_route_probe_enabled = True

        decision = StrategyDecision(
            strategy_id=str(uuid4()),
            symbol="AAPL",
            event_ts=datetime(2026, 3, 26, 14, 0, tzinfo=timezone.utc),
            timeframe="1Min",
            action="sell",
            qty=Decimal("2"),
            rationale="paper-route-exit-edge",
            params={
                "price": Decimal("100"),
                "paper_route_probe_exit": {"mode": "not-paper-route-exit"},
            },
        )
        self.assertIsNone(
            SimpleTradingPipeline._paper_route_probe_exit_metadata(decision)
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
            account_label="paper",
            session_factory=self.session_local,
        )
        pipeline._is_market_session_open = lambda _now=None: False
        with (
            patch(
                "app.trading.scheduler.simple_pipeline.trading_now",
                return_value=datetime(2026, 3, 26, 14, 0, tzinfo=timezone.utc),
            ),
            self.session_local() as session,
        ):
            self.assertEqual(
                pipeline._paper_route_probe_exit_decisions(session=session), []
            )

        non_exit_decision = decision.model_copy(
            update={"params": {"price": Decimal("100")}}
        )
        self.assertIs(
            SimpleTradingPipeline._prepare_paper_route_probe_exit_position(
                [{"symbol": "AAPL", "qty": "1", "side": "long"}],
                non_exit_decision,
            ),
            non_exit_decision,
        )

        exit_decision = decision.model_copy(
            update={
                "params": {
                    "price": Decimal("100"),
                    "paper_route_probe_exit": {"mode": "paper_route_exit"},
                    "execution": {"quantity_resolution": {}},
                }
            }
        )
        prepared = SimpleTradingPipeline._prepare_paper_route_probe_exit_position(
            [{"symbol": "AAPL", "qty": "1", "side": "long"}],
            exit_decision,
        )
        assert prepared is not None
        self.assertEqual(prepared.qty, Decimal("1"))
        metadata = cast(dict[str, Any], prepared.params["paper_route_probe_exit"])
        self.assertEqual(metadata["qty_capped_to_position"], True)
        self.assertEqual(metadata["broker_position_qty"], "1")

    def test_simple_pipeline_proof_floor_includes_paper_route_probe_settings(
        self,
    ) -> None:
        from app import config

        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_pipeline_mode = "simple"
        config.settings.trading_simple_submit_enabled = True
        config.settings.trading_simple_order_feed_telemetry_enabled = True
        config.settings.trading_simple_paper_route_probe_enabled = True
        config.settings.trading_simple_paper_route_probe_max_notional = 25.0

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
        captured: dict[str, Any] = {}

        def fake_proof_floor(**kwargs: Any) -> dict[str, object]:
            captured.update(kwargs)
            return {"schema_version": "test-proof-floor"}

        with (
            patch.object(pipeline, "_refresh_market_context_for_proof_floor"),
            patch.object(pipeline, "_live_submission_gate", return_value={}),
            patch(
                "app.trading.scheduler.simple_pipeline.build_submission_gate_market_context_status",
                return_value={},
            ),
            patch(
                "app.trading.scheduler.simple_pipeline.build_hypothesis_runtime_summary",
                return_value={},
            ),
            patch(
                "app.trading.scheduler.pipeline.decision_lifecycle.build_empirical_jobs_status",
                return_value={},
            ),
            patch(
                "app.trading.scheduler.simple_pipeline.load_quant_evidence_status",
                return_value={},
            ),
            patch(
                "app.trading.scheduler.simple_pipeline.build_tca_gate_inputs",
                return_value={},
            ),
            patch(
                "app.trading.scheduler.simple_pipeline.build_profitability_proof_floor_receipt",
                side_effect=fake_proof_floor,
            ),
            self.session_local() as session,
        ):
            proof_floor = pipeline._profitability_proof_floor(session=session)

        self.assertEqual(proof_floor["schema_version"], "test-proof-floor")
        simple_lane_status = cast(
            Mapping[str, Any],
            captured["simple_lane_status"],
        )
        self.assertTrue(simple_lane_status["paper_route_probe_enabled"])
        self.assertEqual(simple_lane_status["paper_route_probe_max_notional"], 25.0)
        self.assertTrue(simple_lane_status["order_feed_telemetry_enabled"])
        self.assertTrue(simple_lane_status["order_feed_lifecycle_required"])
        self.assertEqual(simple_lane_status["order_feed_lifecycle_status"], "enabled")

    def test_simple_pipeline_allows_bounded_paper_route_probe_for_tca_repair(
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
        config.settings.trading_simple_paper_route_probe_max_notional = 25.0
        config.settings.trading_universe_source = "jangar"
        config.settings.trading_universe_static_fallback_enabled = True
        config.settings.trading_universe_static_fallback_symbols_raw = "NVDA"

        with self.session_local() as session:
            strategy = Strategy(
                name="simple-paper-route-probe",
                description="simple paper lane route probe",
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=["NVDA"],
                max_notional_per_trade=Decimal("1000"),
            )
            session.add(strategy)
            session.commit()

        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 26, 13, 30, tzinfo=timezone.utc),
            ingest_ts=datetime(2026, 3, 26, 13, 30, 5, tzinfo=timezone.utc),
            symbol="NVDA",
            timeframe="1Min",
            seq=1,
            payload={
                "feature_schema_version": "3.0.0",
                "macd": {"macd": 1.2, "signal": 0.5},
                "rsi14": 25,
                "price": 100,
            },
        )

        alpaca_client = FakeAlpacaClient()
        pipeline = SimpleTradingPipeline(
            alpaca_client=alpaca_client,
            order_firewall=OrderFirewall(alpaca_client),
            ingestor=FakeIngestor([signal]),
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
        pipeline._is_market_session_open = lambda _now=None: True

        proof_floor = {
            "route_state": "repair_only",
            "capital_state": "zero_notional",
            "max_notional": "0",
            "market_window": {"session_open": True},
            "blocking_reasons": [
                "hypothesis_not_promotion_eligible",
                "execution_tca_route_universe_empty",
            ],
            "route_reacquisition_book": {
                "summary": {
                    "candidate_symbols": [],
                    "repair_candidate_symbols": ["NVDA"],
                }
            },
        }
        with patch.object(
            SimpleTradingPipeline,
            "_profitability_proof_floor",
            return_value=proof_floor,
        ):
            pipeline.run_once()

        self.assertEqual(len(alpaca_client.submitted), 1)
        self.assertEqual(alpaca_client.submitted[0]["qty"], "0.25")
        with self.session_local() as session:
            decision = session.execute(select(TradeDecision)).scalar_one()
            execution = session.execute(select(Execution)).scalar_one()
            decision_json = cast(dict[str, Any], decision.decision_json)
            params = cast(dict[str, Any], decision_json.get("params"))
            paper_route_probe = cast(dict[str, Any], params.get("paper_route_probe"))
            simple_lane = cast(dict[str, Any], params.get("execution"))

            self.assertEqual(decision.status, "submitted")
            self.assertEqual(execution.submitted_qty, Decimal("0.25000000"))
            self.assertEqual(paper_route_probe.get("mode"), "paper_route_acquisition")
            self.assertEqual(paper_route_probe.get("max_notional"), "25.0")
            self.assertEqual(paper_route_probe.get("capped_qty"), "0.2500")
            self.assertEqual(simple_lane.get("paper_route_probe_cap_applied"), True)
