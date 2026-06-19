from __future__ import annotations

import json
import tempfile
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

from sqlalchemy import select

from app import config
from app.models import Strategy, TradeDecision
from app.trading.decisions import (
    _is_entry_action_for_strategies,
    _is_exit_action_for_strategies,
    _strategy_uses_position_isolation,
    DecisionEngine,
)
from app.trading.execution import OrderExecutor
from app.trading.firewall import OrderFirewall
from app.trading.models import SignalEnvelope, StrategyDecision
from app.trading.reconcile import Reconciler
from app.trading.risk import RiskEngine
from app.trading.scheduler.pipeline import TradingPipeline
from app.trading.scheduler.state import TradingState
from app.trading.universe import UniverseResolver
from tests.pipeline.trading_pipeline_base import TradingPipelineTestCaseBase
from tests.pipeline.trading_pipeline_support import (
    FakeAlpacaClient,
    FakeIngestor,
    FakeLLMReviewEngine,
    PositionedAlpacaClient,
    SellInventoryConflictRetryClient,
    _set_llm_guardrails,
)


class TestTradingPipelinePositionProjectionB(TradingPipelineTestCaseBase):
    def test_attach_strategy_position_tag_fail_closed_edges(self) -> None:
        session_open = datetime(2026, 3, 26, 13, 30, tzinfo=timezone.utc)
        exposures = {
            "AAPL": {
                "strategy-a": {"qty": Decimal("2")},
                "strategy-b": {"qty": Decimal("2")},
            }
        }

        self.assertFalse(
            TradingPipeline.same_side_position_exposure(
                Decimal("0"),
                Decimal("2"),
            )
        )
        already_tagged = {"symbol": "AAPL", "qty": "2", "strategy_id": "existing"}
        self.assertIs(
            TradingPipeline._attach_strategy_position_tag(
                already_tagged,
                exposures=exposures,
                session_open=session_open,
            ),
            already_tagged,
        )
        no_symbol = {"qty": "2"}
        self.assertIs(
            TradingPipeline._attach_strategy_position_tag(
                no_symbol,
                exposures=exposures,
                session_open=session_open,
            ),
            no_symbol,
        )
        no_exposure = {"symbol": "MSFT", "qty": "2"}
        self.assertIs(
            TradingPipeline._attach_strategy_position_tag(
                no_exposure,
                exposures=exposures,
                session_open=session_open,
            ),
            no_exposure,
        )
        nonpositive = {"symbol": "AAPL", "qty": "0"}
        self.assertIs(
            TradingPipeline._attach_strategy_position_tag(
                nonpositive,
                exposures=exposures,
                session_open=session_open,
            ),
            nonpositive,
        )
        ambiguous = {"symbol": "AAPL", "qty": "2", "side": "long"}
        self.assertIs(
            TradingPipeline._attach_strategy_position_tag(
                ambiguous,
                exposures=exposures,
                session_open=session_open,
            ),
            ambiguous,
        )

    def test_attach_strategy_position_tag_reconstructs_avg_entry_from_fills(
        self,
    ) -> None:
        session_open = datetime(2026, 3, 26, 13, 30, tzinfo=timezone.utc)
        tagged = TradingPipeline._attach_strategy_position_tag(
            {"symbol": "AAPL", "qty": "2", "side": "long"},
            exposures={
                "AAPL": {
                    "strategy-a": {
                        "qty": Decimal("2"),
                        "buy_qty": Decimal("2"),
                        "buy_notional": Decimal("202"),
                        "latest_execution_at": session_open + timedelta(minutes=1),
                    }
                }
            },
            session_open=session_open,
        )

        self.assertEqual(tagged["strategy_id"], "strategy-a")
        self.assertEqual(tagged["avg_entry_price"], "101")
        self.assertEqual(
            tagged["strategy_position_latest_execution_at"],
            (session_open + timedelta(minutes=1)).isoformat(),
        )

    def test_attach_strategy_position_tag_handles_signed_short_qty(self) -> None:
        session_open = datetime(2026, 3, 26, 13, 30, tzinfo=timezone.utc)
        tagged = TradingPipeline._attach_strategy_position_tag(
            {"symbol": "AMZN", "qty": "-41"},
            exposures={
                "AMZN": {
                    "strategy-pairs": {
                        "qty": Decimal("-41"),
                        "latest_execution_at": session_open + timedelta(minutes=61),
                    }
                }
            },
            session_open=session_open,
        )

        self.assertEqual(tagged["strategy_id"], "strategy-pairs")
        self.assertEqual(tagged["qty"], "41")
        self.assertEqual(tagged["side"], "short")

    def test_microbar_pairs_are_symmetric_entries_with_position_isolation(self) -> None:
        strategy = Strategy(
            name="microbar-cross-sectional-pairs-v1",
            enabled=True,
            base_timeframe="1Sec",
            universe_type="microbar_cross_sectional_pairs_v1",
            universe_symbols=["AAPL", "AMZN"],
        )

        self.assertTrue(_strategy_uses_position_isolation(strategy))
        self.assertTrue(
            _is_entry_action_for_strategies(strategies=[strategy], action="buy")
        )
        self.assertTrue(
            _is_entry_action_for_strategies(strategies=[strategy], action="sell")
        )
        self.assertFalse(
            _is_exit_action_for_strategies(strategies=[strategy], action="buy")
        )
        self.assertFalse(
            _is_exit_action_for_strategies(strategies=[strategy], action="sell")
        )

    def test_pipeline_runtime_uncertainty_rechecks_after_llm_adjustment(self) -> None:
        from app import config

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_kill_switch_enabled": config.settings.trading_kill_switch_enabled,
            "trading_universe_source": config.settings.trading_universe_source,
            "trading_static_symbols_raw": config.settings.trading_static_symbols_raw,
            "llm_enabled": config.settings.llm_enabled,
            "llm_min_confidence": config.settings.llm_min_confidence,
            "llm_adjustment_allowed": config.settings.llm_adjustment_allowed,
            "llm_allowed_models_raw": config.settings.llm_allowed_models_raw,
            "llm_evaluation_report": config.settings.llm_evaluation_report,
            "llm_effective_challenge_id": config.settings.llm_effective_challenge_id,
            "llm_shadow_completed_at": config.settings.llm_shadow_completed_at,
            "llm_adjustment_approved": config.settings.llm_adjustment_approved,
        }
        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_mode = "paper"
        config.settings.trading_kill_switch_enabled = False
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"
        config.settings.llm_enabled = True
        config.settings.llm_min_confidence = 0.0
        config.settings.llm_adjustment_allowed = True
        _set_llm_guardrails(config, adjustment_approved=True)

        try:
            with tempfile.TemporaryDirectory() as tmpdir:
                with self.session_local() as session:
                    strategy = Strategy(
                        name="demo",
                        description="runtime-gate-post-llm-recheck",
                        enabled=True,
                        base_timeframe="1Min",
                        universe_type="static",
                        universe_symbols=["AAPL"],
                        max_notional_per_trade=Decimal("500"),
                    )
                    session.add(strategy)
                    session.commit()

                gate_path = Path(tmpdir) / "gate-report.json"
                gate_path.write_text(
                    '{"uncertainty_gate_action":"fail","coverage_error":"0.11","shift_score":"0.96"}',
                    encoding="utf-8",
                )
                signal = SignalEnvelope(
                    event_ts=datetime.now(timezone.utc),
                    symbol="AAPL",
                    payload={
                        "macd": {"macd": 1.2, "signal": 0.5},
                        "rsi14": 25,
                        "price": 100,
                    },
                    timeframe="1Min",
                )
                state = TradingState(last_autonomy_gates=str(gate_path))
                alpaca_client = PositionedAlpacaClient(
                    positions=[
                        {
                            "symbol": "AAPL",
                            "qty": "5",
                            "side": "short",
                            "market_value": "-500",
                        }
                    ]
                )
                pipeline = TradingPipeline(
                    alpaca_client=alpaca_client,
                    order_firewall=OrderFirewall(alpaca_client),
                    ingestor=FakeIngestor([signal]),
                    decision_engine=DecisionEngine(),
                    risk_engine=RiskEngine(),
                    executor=OrderExecutor(),
                    execution_adapter=alpaca_client,
                    reconciler=Reconciler(),
                    universe_resolver=UniverseResolver(),
                    state=state,
                    account_label="paper",
                    session_factory=self.session_local,
                    llm_review_engine=FakeLLMReviewEngine(
                        verdict="adjust",
                        adjusted_qty=Decimal("6"),
                        adjusted_order_type="market",
                    ),
                )

                pipeline.run_once()

                with self.session_local() as session:
                    decisions = session.execute(select(TradeDecision)).scalars().all()
                    self.assertEqual(len(decisions), 1)
                    self.assertEqual(decisions[0].status, "rejected")
                    decision_json = decisions[0].decision_json
                    assert isinstance(decision_json, dict)
                    self.assertIn(
                        "runtime_uncertainty_gate_fail_block_new_entries",
                        decision_json.get("risk_reasons", []),
                    )
                    params = decision_json.get("params")
                    assert isinstance(params, dict)
                    gate_payload = params.get("runtime_uncertainty_gate")
                    assert isinstance(gate_payload, dict)
                    self.assertTrue(gate_payload.get("entry_blocked"))
                    self.assertTrue(gate_payload.get("risk_increasing_entry"))

                self.assertEqual(alpaca_client.submitted, [])
                self.assertEqual(
                    state.metrics.runtime_uncertainty_gate_blocked_total.get("fail"),
                    1,
                )
        finally:
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_kill_switch_enabled = original[
                "trading_kill_switch_enabled"
            ]
            config.settings.trading_universe_source = original[
                "trading_universe_source"
            ]
            config.settings.trading_static_symbols_raw = original[
                "trading_static_symbols_raw"
            ]
            config.settings.llm_enabled = original["llm_enabled"]
            config.settings.llm_min_confidence = original["llm_min_confidence"]
            config.settings.llm_adjustment_allowed = original["llm_adjustment_allowed"]
            config.settings.llm_allowed_models_raw = original["llm_allowed_models_raw"]
            config.settings.llm_evaluation_report = original["llm_evaluation_report"]
            config.settings.llm_effective_challenge_id = original[
                "llm_effective_challenge_id"
            ]
            config.settings.llm_shadow_completed_at = original[
                "llm_shadow_completed_at"
            ]
            config.settings.llm_adjustment_approved = original[
                "llm_adjustment_approved"
            ]

    def test_maybe_record_lean_strategy_shadow_rolls_back_session_on_failure(
        self,
    ) -> None:
        pipeline = object.__new__(TradingPipeline)
        metrics = Mock()
        pipeline.state = SimpleNamespace(metrics=metrics)
        pipeline.lean_lane_manager = Mock()
        pipeline.lean_lane_manager.record_strategy_shadow.side_effect = RuntimeError(
            "boom"
        )

        session = Mock()
        execution_client = Mock()
        execution_client.evaluate_strategy_shadow.return_value = {
            "run_id": "run-1",
            "parity_status": "blocked_missing_empirical_authority",
        }
        decision = SimpleNamespace(
            strategy_id="strategy-1",
            symbol="AAPL",
            action="buy",
            qty=Decimal("1"),
            order_type="market",
            time_in_force="day",
        )

        original_enabled = config.settings.trading_lean_strategy_shadow_enabled
        original_disable_switch = config.settings.trading_lean_lane_disable_switch
        try:
            config.settings.trading_lean_strategy_shadow_enabled = True
            config.settings.trading_lean_lane_disable_switch = False
            TradingPipeline._maybe_record_lean_strategy_shadow(
                pipeline,
                session=session,
                decision=decision,
                execution_client=execution_client,
                selected_adapter_name="lean",
            )
        finally:
            config.settings.trading_lean_strategy_shadow_enabled = original_enabled
            config.settings.trading_lean_lane_disable_switch = original_disable_switch

        session.rollback.assert_called_once()
        metrics.record_lean_strategy_shadow.assert_any_call("error")

    def test_runtime_uncertainty_gate_records_uncertainty_sub_gate_action(self) -> None:
        pipeline = TradingPipeline(
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
        gate_payload = {
            "action": "fail",
            "source": "regime_hmm_transition_shock",
            "uncertainty_gate": {"action": "pass", "source": "autonomy_gate_report"},
            "regime_gate": {"action": "fail", "source": "regime_hmm_transition_shock"},
        }

        pipeline._record_runtime_uncertainty_gate_result(
            gate_payload=gate_payload,
            gate_rejection="runtime_uncertainty_gate_fail_block_new_entries",
        )

        self.assertEqual(
            pipeline.state.metrics.runtime_uncertainty_gate_action_total.get("pass"),
            1,
        )
        self.assertEqual(
            pipeline.state.metrics.runtime_uncertainty_gate_action_total.get("fail"),
            None,
        )
        self.assertEqual(pipeline.state.last_runtime_uncertainty_gate_action, "pass")

    def test_runtime_uncertainty_gate_blocks_source_is_component_scoped(self) -> None:
        pipeline = TradingPipeline(
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
        decision = StrategyDecision(
            strategy_id="strategy",
            symbol="AAPL",
            event_ts=datetime.now(timezone.utc),
            timeframe="1Min",
            action="buy",
            qty=Decimal("1"),
            params={
                "uncertainty_gate_action": "pass",
                "regime_gate": {
                    "action": "fail",
                    "source": "decision_regime_gate",
                    "reason": "regime_context_transition_shock",
                },
            },
        )

        _, payload, reason = pipeline._apply_runtime_uncertainty_gate(
            decision,
            positions=[],
        )

        self.assertEqual(reason, "runtime_uncertainty_gate_fail_block_new_entries")
        self.assertEqual(payload.get("regime_action_blocked"), "decision_regime_gate")
        self.assertIsNone(payload.get("uncertainty_action_blocked"))

    def test_runtime_uncertainty_gate_degrades_autonomy_coverage_failures(self) -> None:
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as handle:
            handle.write(
                json.dumps(
                    {
                        "uncertainty_gate_action": "fail",
                        "coverage_error": "1",
                        "shift_score": "1",
                        "conformal_interval_width": "0",
                    }
                )
            )
            gate_path = handle.name
        try:
            state = TradingState()
            state.last_autonomy_gates = gate_path
            pipeline = TradingPipeline(
                alpaca_client=FakeAlpacaClient(),
                order_firewall=OrderFirewall(FakeAlpacaClient()),
                ingestor=FakeIngestor([]),
                decision_engine=DecisionEngine(),
                risk_engine=RiskEngine(),
                executor=OrderExecutor(),
                execution_adapter=FakeAlpacaClient(),
                reconciler=Reconciler(),
                universe_resolver=UniverseResolver(),
                state=state,
                account_label="paper",
                session_factory=self.session_local,
            )
            decision = StrategyDecision(
                strategy_id="strategy",
                symbol="AAPL",
                event_ts=datetime.now(timezone.utc),
                timeframe="1Min",
                action="buy",
                qty=Decimal("4"),
                params={"price": Decimal("100")},
            )

            degraded, payload, reason = pipeline._apply_runtime_uncertainty_gate(
                decision,
                positions=[],
            )

            self.assertIsNone(reason)
            self.assertEqual(payload.get("action"), "degrade")
            self.assertIn(
                payload.get("source"),
                {
                    "autonomy_gate_report_coverage_fallback",
                    "autonomy_gate_report_saturated_fail_sentinel",
                },
            )
            self.assertLess(degraded.qty, decision.qty)
        finally:
            Path(gate_path).unlink(missing_ok=True)

    def test_submit_order_retries_sell_inventory_conflict_after_cancel(self) -> None:
        client = SellInventoryConflictRetryClient()
        order_firewall = OrderFirewall(client)
        pipeline = TradingPipeline(
            alpaca_client=client,
            order_firewall=order_firewall,
            ingestor=FakeIngestor([]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=client,
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="paper",
            session_factory=self.session_local,
        )
        with self.session_local() as session:
            strategy = Strategy(
                name="demo",
                description="demo",
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=["AAPL"],
            )
            session.add(strategy)
            session.commit()
            session.refresh(strategy)

            decision = StrategyDecision(
                strategy_id=str(strategy.id),
                symbol="AAPL",
                event_ts=datetime.now(timezone.utc),
                timeframe="1Min",
                action="sell",
                qty=Decimal("1"),
                order_type="market",
                time_in_force="day",
                params={"price": Decimal("100")},
            )
            decision_row = pipeline.executor.ensure_decision(
                session, decision, strategy, "paper"
            )

            execution, rejected = pipeline._submit_order_with_handling(
                session=session,
                execution_client=order_firewall,
                decision=decision,
                decision_row=decision_row,
                selected_adapter_name="alpaca",
                retry_delays=[],
            )

            self.assertFalse(rejected)
            self.assertIsNotNone(execution)
            self.assertEqual(client.cancel_calls, ["open-sell-1"])
            self.assertEqual(len(client.submitted), 1)
            self.assertEqual(Decimal(client.submitted[0]["qty"]), Decimal("1"))
            session.refresh(decision_row)
            broker_precheck_recovery = decision_row.decision_json.get(
                "broker_precheck_recovery", {}
            )
            self.assertEqual(
                broker_precheck_recovery.get("code"),
                "sell_inventory_conflict_retried_after_cancel",
            )
            self.assertEqual(broker_precheck_recovery.get("status"), "cleared")

    def test_runtime_uncertainty_gate_does_not_bypass_kill_switch_precedence(
        self,
    ) -> None:
        from app import config

        original = {
            "trading_enabled": config.settings.trading_enabled,
            "trading_mode": config.settings.trading_mode,
            "trading_kill_switch_enabled": config.settings.trading_kill_switch_enabled,
            "trading_universe_source": config.settings.trading_universe_source,
            "trading_static_symbols_raw": config.settings.trading_static_symbols_raw,
        }
        config.settings.trading_enabled = True
        config.settings.trading_mode = "paper"
        config.settings.trading_mode = "paper"
        config.settings.trading_kill_switch_enabled = True
        config.settings.trading_universe_source = "static"
        config.settings.trading_static_symbols_raw = "AAPL"

        try:
            with tempfile.TemporaryDirectory() as tmpdir:
                with self.session_local() as session:
                    strategy = Strategy(
                        name="demo",
                        description="runtime-gate-precedence",
                        enabled=True,
                        base_timeframe="1Min",
                        universe_type="static",
                        universe_symbols=["AAPL"],
                        max_notional_per_trade=Decimal("1000"),
                    )
                    session.add(strategy)
                    session.commit()

                gate_path = Path(tmpdir) / "gate-report.json"
                gate_path.write_text(
                    '{"uncertainty_gate_action":"abstain"}',
                    encoding="utf-8",
                )
                signal = SignalEnvelope(
                    event_ts=datetime.now(timezone.utc),
                    symbol="AAPL",
                    payload={
                        "macd": {"macd": 0.4, "signal": 1.0},
                        "rsi14": 75,
                        "price": 100,
                    },
                    timeframe="1Min",
                )
                state = TradingState(last_autonomy_gates=str(gate_path))
                alpaca_client = PositionedAlpacaClient(
                    positions=[
                        {
                            "symbol": "AAPL",
                            "qty": "5",
                            "side": "long",
                            "market_value": "500",
                        }
                    ]
                )
                pipeline = TradingPipeline(
                    alpaca_client=alpaca_client,
                    order_firewall=OrderFirewall(alpaca_client),
                    ingestor=FakeIngestor([signal]),
                    decision_engine=DecisionEngine(),
                    risk_engine=RiskEngine(),
                    executor=OrderExecutor(),
                    execution_adapter=alpaca_client,
                    reconciler=Reconciler(),
                    universe_resolver=UniverseResolver(),
                    state=state,
                    account_label="paper",
                    session_factory=self.session_local,
                )

                pipeline.run_once()

                self.assertEqual(alpaca_client.submitted, [])
                with self.session_local() as session:
                    decisions = session.execute(select(TradeDecision)).scalars().all()
                    self.assertEqual(len(decisions), 1)
                    self.assertEqual(decisions[0].status, "rejected")
                    decision_json = decisions[0].decision_json
                    assert isinstance(decision_json, dict)
                    risk_reasons = decision_json.get("risk_reasons", [])
                    self.assertIn("kill_switch_enabled", risk_reasons)
                    self.assertNotIn(
                        "runtime_uncertainty_gate_abstain_block_risk_increasing_entries",
                        risk_reasons,
                    )
        finally:
            config.settings.trading_enabled = original["trading_enabled"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_mode = original["trading_mode"]
            config.settings.trading_kill_switch_enabled = original[
                "trading_kill_switch_enabled"
            ]
            config.settings.trading_universe_source = original[
                "trading_universe_source"
            ]
            config.settings.trading_static_symbols_raw = original[
                "trading_static_symbols_raw"
            ]
