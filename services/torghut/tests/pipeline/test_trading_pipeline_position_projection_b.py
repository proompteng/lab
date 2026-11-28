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
    is_entry_action_for_strategies,
    is_exit_action_for_strategies,
    strategy_uses_position_isolation,
)
from app.trading.firewall import OrderFirewall
from app.trading.models import StrategyDecision
from app.trading.scheduler.pipeline import TradingPipeline
from app.trading.scheduler.pipeline.contexts import OrderSubmissionRequest
from app.trading.scheduler.state import TradingState
from tests.pipeline.trading_pipeline_base import TradingPipelineTestCaseBase
from tests.pipeline.trading_pipeline_support import (
    FakeIngestor,
    FakeLLMReviewEngine,
    PositionedAlpacaClient,
    SellInventoryConflictRetryClient,
)
from tests.trading_fixtures import make_signal, make_strategy


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

        self.assertTrue(strategy_uses_position_isolation(strategy))
        self.assertTrue(
            is_entry_action_for_strategies(strategies=[strategy], action="buy")
        )
        self.assertTrue(
            is_entry_action_for_strategies(strategies=[strategy], action="sell")
        )
        self.assertFalse(
            is_exit_action_for_strategies(strategies=[strategy], action="buy")
        )
        self.assertFalse(
            is_exit_action_for_strategies(strategies=[strategy], action="sell")
        )

    def test_pipeline_runtime_uncertainty_rechecks_after_llm_adjustment(self) -> None:
        self.configure_settings(
            trading_enabled=True,
        )
        self.configure_settings(
            trading_mode="paper",
            trading_kill_switch_enabled=False,
            trading_universe_source="static",
            trading_static_symbols_raw="AAPL",
            llm_enabled=True,
            llm_min_confidence=0.0,
            llm_adjustment_allowed=True,
        )
        self.configure_llm_guardrails(adjustment_approved=True)

        with tempfile.TemporaryDirectory() as tmpdir:
            with self.session_local() as session:
                strategy = make_strategy(
                    name="demo",
                    description="runtime-gate-post-llm-recheck",
                    max_notional_per_trade=Decimal("500"),
                )
                session.add(strategy)
                session.commit()

            gate_path = Path(tmpdir) / "gate-report.json"
            gate_path.write_text(
                '{"uncertainty_gate_action":"fail","coverage_error":"0.11","shift_score":"0.96"}',
                encoding="utf-8",
            )
            signal = make_signal(
                datetime.now(timezone.utc),
                payload={
                    "macd": {"macd": 1.2, "signal": 0.5},
                    "rsi14": 25,
                    "price": 100,
                },
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
            pipeline = self.make_pipeline(
                alpaca_client=alpaca_client,
                order_firewall=OrderFirewall(alpaca_client),
                ingestor=FakeIngestor([signal]),
                execution_adapter=alpaca_client,
                state=state,
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
            )
        finally:
            config.settings.trading_lean_strategy_shadow_enabled = original_enabled
            config.settings.trading_lean_lane_disable_switch = original_disable_switch

        session.rollback.assert_called_once()
        metrics.record_lean_strategy_shadow.assert_any_call("error")

    def test_runtime_uncertainty_gate_records_uncertainty_sub_gate_action(self) -> None:
        pipeline = self.make_pipeline()
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
        pipeline = self.make_pipeline()
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
            pipeline = self.make_pipeline(
                state=state,
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

    def test_submit_order_blocks_sell_inventory_conflict_without_cancel(self) -> None:
        client = SellInventoryConflictRetryClient()
        order_firewall = OrderFirewall(client)
        pipeline = self.make_pipeline(
            alpaca_client=client,
            order_firewall=order_firewall,
            execution_adapter=client,
        )
        with self.session_local() as session:
            strategy = make_strategy(
                name="demo",
                description="demo",
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
                OrderSubmissionRequest(
                    session=session,
                    execution_client=order_firewall,
                    decision=decision,
                    decision_row=decision_row,
                    selected_adapter_name="alpaca",
                )
            )

            self.assertTrue(rejected)
            self.assertIsNone(execution)
            self.assertEqual(client.cancel_calls, [])
            self.assertEqual(len(client.submitted), 0)
            session.refresh(decision_row)
            self.assertNotIn("broker_precheck_recovery", decision_row.decision_json)

    def test_runtime_uncertainty_gate_does_not_bypass_kill_switch_precedence(
        self,
    ) -> None:
        self.configure_settings(
            trading_enabled=True,
        )
        self.configure_settings(
            trading_mode="paper",
            trading_kill_switch_enabled=True,
            trading_universe_source="static",
            trading_static_symbols_raw="AAPL",
        )

        with tempfile.TemporaryDirectory() as tmpdir:
            with self.session_local() as session:
                strategy = make_strategy(
                    name="demo",
                    description="runtime-gate-precedence",
                    max_notional_per_trade=Decimal("1000"),
                )
                session.add(strategy)
                session.commit()

            gate_path = Path(tmpdir) / "gate-report.json"
            gate_path.write_text(
                '{"uncertainty_gate_action":"abstain"}',
                encoding="utf-8",
            )
            signal = make_signal(
                datetime.now(timezone.utc),
                payload={
                    "macd": {"macd": 0.4, "signal": 1.0},
                    "rsi14": 75,
                    "price": 100,
                },
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
            pipeline = self.make_pipeline(
                alpaca_client=alpaca_client,
                order_firewall=OrderFirewall(alpaca_client),
                ingestor=FakeIngestor([signal]),
                execution_adapter=alpaca_client,
                state=state,
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
