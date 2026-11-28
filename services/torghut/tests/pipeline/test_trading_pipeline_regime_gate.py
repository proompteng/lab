from __future__ import annotations

import json
import tempfile
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from unittest.mock import patch

from sqlalchemy import select

from app.models import Execution, TradeDecision
from app.trading.decisions import DecisionEngine
from app.trading.firewall import OrderFirewall
from app.trading.models import StrategyDecision
from app.trading.risk import RiskEngine
from app.trading.scheduler.state import TradingState
from tests.pipeline.trading_pipeline_base import TradingPipelineTestCaseBase
from tests.pipeline.trading_pipeline_support import (
    FakeAlpacaClient,
    FakeIngestor,
    FakePriceFetcher,
)
from tests.trading_fixtures import macd_buy_signal, make_signal, make_strategy


class TestTradingPipelineRegimeGate(TradingPipelineTestCaseBase):
    def test_run_once_blocks_live_submission_when_quant_latest_store_is_empty(
        self,
    ) -> None:
        self.configure_settings(
            trading_enabled=True,
            trading_mode="live",
            trading_autonomy_enabled=False,
            trading_autonomy_allow_live_promotion=True,
            trading_kill_switch_enabled=False,
            trading_simple_submit_enabled=True,
            trading_live_submit_enabled=True,
            trading_universe_source="static",
            trading_static_symbols_raw="AAPL",
        )

        with self.session_local() as session:
            strategy = make_strategy(
                name="live-canary-empty-quant",
                description="autonomy evidence with empty quant latest store",
                max_notional_per_trade=Decimal("1000"),
            )
            session.add(strategy)
            session.flush()
            self._activate_test_capital_authority(
                session,
                strategy=strategy,
                account_mode="live",
                account_label="paper",
            )
            session.commit()

        signal = macd_buy_signal()

        alpaca_client = FakeAlpacaClient()
        state = TradingState(
            last_autonomy_promotion_eligible=True,
            last_autonomy_promotion_action="promote",
        )
        self._prime_test_capital_state(state)
        pipeline = self.make_pipeline(
            alpaca_client=alpaca_client,
            order_firewall=OrderFirewall(alpaca_client),
            ingestor=FakeIngestor([signal]),
            execution_adapter=alpaca_client,
            state=state,
        )
        pipeline._is_market_session_open = lambda _now=None: True

        with (
            patch(
                "app.trading.submission_council._alpaca_broker_available",
                return_value=True,
            ),
        ):
            pipeline.run_once()

        with self.session_local() as session:
            decision_rows = session.execute(select(TradeDecision)).scalars().all()
            self.assertEqual(len(decision_rows), 1)
            self.assertNotEqual(decision_rows[0].status, "blocked")
            decision_json = decision_rows[0].decision_json
            assert isinstance(decision_json, dict)
            control_plane_snapshot = decision_json.get("control_plane_snapshot")
            assert isinstance(control_plane_snapshot, dict)
            live_submission_gate = control_plane_snapshot.get("live_submission_gate")
            assert isinstance(live_submission_gate, dict)
            self.assertEqual(live_submission_gate.get("allowed"), True)
            self.assertEqual(
                live_submission_gate.get("reason"),
                "operational_submission_ready",
            )
            self.assertEqual(live_submission_gate.get("capital_state"), "live")
            self.assertNotIn(
                "quant_latest_store_alarm",
                live_submission_gate.get("blocked_reasons", []),
            )
            self.assertNotIn("quant_evidence", live_submission_gate)

        self.assertNotEqual(alpaca_client.submitted, [])

    def test_decision_engine_macd_rsi(self) -> None:
        engine = DecisionEngine()
        strategy = make_strategy(
            name="demo",
            description="demo",
        )
        signal = make_signal(
            datetime.now(timezone.utc),
            payload={"macd": {"macd": 1.2, "signal": 0.5}, "rsi14": 25, "price": 100},
        )
        decisions = engine.evaluate(signal, [strategy])
        self.assertTrue(decisions)
        self.assertEqual(decisions[0].action, "buy")

    def test_decision_engine_attaches_price(self) -> None:
        engine = DecisionEngine(price_fetcher=FakePriceFetcher(Decimal("101.5")))
        strategy = make_strategy(
            name="demo",
            description="demo",
        )
        signal = make_signal(
            datetime.now(timezone.utc),
            payload={"macd": {"macd": 1.2, "signal": 0.5}, "rsi14": 25},
        )
        decisions = engine.evaluate(signal, [strategy])
        self.assertTrue(decisions)
        self.assertEqual(decisions[0].params.get("price"), Decimal("101.5"))

    def test_risk_engine_ignores_deprecated_live_enabled_flag(self) -> None:
        self.configure_settings(
            trading_enabled=True,
            trading_mode="live",
        )
        self.configure_settings(
            trading_mode="paper",
        )

        strategy = make_strategy(
            name="demo",
            description="demo",
        )
        decision = StrategyDecision(
            strategy_id="strategy",
            symbol="AAPL",
            event_ts=datetime.now(timezone.utc),
            timeframe="1Min",
            action="buy",
            qty=Decimal("1"),
            params={"price": Decimal("100")},
        )

        with self.session_local() as session:
            engine = RiskEngine()
            verdict = engine.evaluate(
                session,
                decision,
                strategy,
                account={"equity": "10000", "buying_power": "10000"},
                positions=[],
                allowed_symbols={"AAPL"},
            )
        self.assertTrue(verdict.approved)
        self.assertNotIn("live_trading_disabled", verdict.reasons)

    def test_pipeline_idempotent_execution(self) -> None:
        self.configure_settings(
            trading_enabled=True,
            trading_mode="paper",
            trading_kill_switch_enabled=False,
            trading_universe_source="static",
            trading_static_symbols_raw="AAPL",
        )

        with self.session_local() as session:
            strategy = make_strategy(
                name="demo",
                description="demo",
                max_notional_per_trade=Decimal("1000"),
            )
            session.add(strategy)
            session.flush()
            self._activate_test_capital_authority(session, strategy=strategy)
            session.commit()
            session.refresh(strategy)

        signal = macd_buy_signal()

        alpaca_client = FakeAlpacaClient()
        pipeline = self.make_pipeline(
            alpaca_client=alpaca_client,
            order_firewall=OrderFirewall(alpaca_client),
            ingestor=FakeIngestor([signal]),
            execution_adapter=alpaca_client,
        )
        self._prime_test_capital_state(pipeline.state)

        pipeline.run_once()
        pipeline.run_once()

        with self.session_local() as session:
            decisions = session.execute(select(TradeDecision)).scalars().all()
            executions = session.execute(select(Execution)).scalars().all()
            self.assertEqual(len(decisions), 1)
            self.assertEqual(len(executions), 1)
            self.assertIsNotNone(decisions[0].decision_hash)
            self.assertEqual(len(alpaca_client.submitted), 1)

    def test_pipeline_runtime_uncertainty_fail_blocks_new_entries(self) -> None:
        self.configure_settings(
            trading_enabled=True,
        )
        self.configure_settings(
            trading_mode="paper",
            trading_kill_switch_enabled=False,
            trading_universe_source="static",
            trading_static_symbols_raw="AAPL",
        )

        with tempfile.TemporaryDirectory() as tmpdir:
            with self.session_local() as session:
                strategy = make_strategy(
                    name="demo",
                    description="runtime-gate-fail",
                    max_notional_per_trade=Decimal("1000"),
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
            alpaca_client = FakeAlpacaClient()
            pipeline = self.make_pipeline(
                alpaca_client=alpaca_client,
                order_firewall=OrderFirewall(alpaca_client),
                ingestor=FakeIngestor([signal]),
                execution_adapter=alpaca_client,
                state=state,
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
                self.assertEqual(gate_payload.get("action"), "fail")
                self.assertTrue(gate_payload.get("entry_blocked"))

            self.assertEqual(alpaca_client.submitted, [])
            self.assertEqual(
                state.metrics.runtime_uncertainty_gate_action_total.get("fail"), 1
            )
            self.assertEqual(
                state.metrics.runtime_uncertainty_gate_blocked_total.get("fail"),
                1,
            )

    def test_pipeline_runtime_uncertainty_saturated_fail_sentinel_degrades(
        self,
    ) -> None:
        self.configure_settings(
            trading_enabled=True,
            trading_mode="paper",
            trading_kill_switch_enabled=False,
            trading_universe_source="static",
            trading_static_symbols_raw="AAPL",
        )

        with tempfile.TemporaryDirectory() as tmpdir:
            with self.session_local() as session:
                strategy = make_strategy(
                    name="demo",
                    description="runtime-gate-sentinel",
                    max_notional_per_trade=Decimal("1000"),
                )
                session.add(strategy)
                session.flush()
                self._activate_test_capital_authority(session, strategy=strategy)
                session.commit()

            gate_path = Path(tmpdir) / "gate-report.json"
            gate_path.write_text(
                json.dumps(
                    {
                        "generated_at": datetime.now(timezone.utc).isoformat(),
                        "uncertainty_gate_action": "fail",
                        "coverage_error": "1",
                        "shift_score": "1",
                        "conformal_interval_width": "0",
                    }
                ),
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
            self._prime_test_capital_state(state)
            alpaca_client = FakeAlpacaClient()
            pipeline = self.make_pipeline(
                alpaca_client=alpaca_client,
                order_firewall=OrderFirewall(alpaca_client),
                ingestor=FakeIngestor([signal]),
                execution_adapter=alpaca_client,
                state=state,
            )

            pipeline.run_once()

            with self.session_local() as session:
                decisions = session.execute(select(TradeDecision)).scalars().all()
                self.assertEqual(len(decisions), 1)
                self.assertNotEqual(decisions[0].status, "rejected")
                decision_json = decisions[0].decision_json
                assert isinstance(decision_json, dict)
                self.assertNotIn(
                    "runtime_uncertainty_gate_fail_block_new_entries",
                    decision_json.get("risk_reasons", []),
                )
                params = decision_json.get("params")
                assert isinstance(params, dict)
                gate_payload = params.get("runtime_uncertainty_gate")
                assert isinstance(gate_payload, dict)
                self.assertEqual(gate_payload.get("action"), "degrade")
                self.assertEqual(
                    gate_payload.get("source"),
                    "autonomy_gate_report_saturated_fail_sentinel",
                )

            self.assertEqual(len(alpaca_client.submitted), 1)

    def test_runtime_uncertainty_gate_resolves_strictest_action_across_sources(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            gate_path = Path(tmpdir) / "gate-report.json"
            gate_path.write_text(
                '{"uncertainty_gate_action":"fail","coverage_error":"0.11","shift_score":"0.96"}',
                encoding="utf-8",
            )
            pipeline = self.make_pipeline(
                state=TradingState(last_autonomy_gates=str(gate_path)),
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
                    "runtime_uncertainty_gate": {"action": "degrade"},
                    "forecast_audit": {"uncertainty_gate_action": "abstain"},
                },
            )

            gate = pipeline._resolve_runtime_uncertainty_gate(decision)

            self.assertEqual(gate.action, "fail")
            self.assertEqual(gate.source, "autonomy_gate_report")

    def test_pipeline_runtime_uncertainty_gate_defaults_degrade_when_inputs_missing(
        self,
    ) -> None:
        pipeline = self.make_pipeline()
        decision = StrategyDecision(
            strategy_id="strategy",
            symbol="AAPL",
            event_ts=datetime.now(timezone.utc),
            timeframe="1Min",
            action="buy",
            qty=Decimal("10"),
            params={},
        )

        gate, _runtime_payload = (
            pipeline._resolve_runtime_uncertainty_gate_from_inputs(decision),
            pipeline._resolve_runtime_uncertainty_gate(decision),
        )
        self.assertEqual(gate.action, "degrade")
        self.assertEqual(gate.source, "uncertainty_input_missing")
        self.assertEqual(_runtime_payload.action, "degrade")
        self.assertEqual(_runtime_payload.source, "uncertainty_input_missing")

    def test_pipeline_runtime_uncertainty_gate_stale_decision_payload_abstains(
        self,
    ) -> None:
        pipeline = self.make_pipeline()
        stale = datetime.now(timezone.utc) - timedelta(minutes=45)
        decision = StrategyDecision(
            strategy_id="strategy",
            symbol="AAPL",
            event_ts=datetime.now(timezone.utc),
            timeframe="1Min",
            action="buy",
            qty=Decimal("10"),
            params={
                "runtime_uncertainty_gate": {
                    "action": "pass",
                    "generated_at": stale.isoformat().replace("+00:00", "Z"),
                    "coverage_error": "0.01",
                }
            },
        )

        gate = pipeline._resolve_runtime_uncertainty_gate_from_inputs(decision)
        self.assertEqual(gate.action, "abstain")
        self.assertEqual(gate.source, "decision_runtime_payload_stale")
        self.assertEqual(gate.reason, "decision_runtime_payload_generated_at_stale")

    def test_pipeline_runtime_regime_gate_defaults_degrade_when_inputs_missing(
        self,
    ) -> None:
        pipeline = self.make_pipeline()
        decision = StrategyDecision(
            strategy_id="strategy",
            symbol="AAPL",
            event_ts=datetime.now(timezone.utc),
            timeframe="1Min",
            action="buy",
            qty=Decimal("10"),
            params={},
        )

        gate = pipeline._resolve_runtime_regime_gate(decision)
        self.assertEqual(gate.action, "degrade")
        self.assertEqual(gate.source, "missing")
        self.assertEqual(gate.reason, "missing")

    def test_pipeline_runtime_regime_gate_degrades_for_uncertain_regime_posterior(
        self,
    ) -> None:
        pipeline = self.make_pipeline()
        decision = StrategyDecision(
            strategy_id="strategy",
            symbol="AAPL",
            event_ts=datetime.now(timezone.utc),
            timeframe="1Min",
            action="buy",
            qty=Decimal("10"),
            params={
                "regime_hmm": {
                    "schema_version": "hmm_regime_context_v1",
                    "regime_id": "R2",
                    "posterior": {"R2": "0.68", "R3": "0.32"},
                    "entropy": "0.95",
                    "entropy_band": "medium",
                    "predicted_next": "R3",
                    "artifact": {"model_id": "hmm-regime-v1.2.0"},
                    "guardrail": {"reason": "stable"},
                },
            },
        )

        gate = pipeline._resolve_runtime_regime_gate(decision)
        self.assertEqual(gate.action, "degrade")
        self.assertEqual(gate.source, "regime_hmm_confidence")
        self.assertEqual(gate.reason, "regime_hmm_confidence_is_uncertain")

    def test_pipeline_runtime_regime_gate_abstains_for_high_entropy_low_confidence(
        self,
    ) -> None:
        pipeline = self.make_pipeline()
        decision = StrategyDecision(
            strategy_id="strategy",
            symbol="AAPL",
            event_ts=datetime.now(timezone.utc),
            timeframe="1Min",
            action="buy",
            qty=Decimal("10"),
            params={
                "regime_hmm": {
                    "schema_version": "hmm_regime_context_v1",
                    "regime_id": "R2",
                    "posterior": {"R2": "0.60", "R3": "0.40"},
                    "entropy": "2.2",
                    "entropy_band": "high",
                    "predicted_next": "R3",
                    "artifact": {"model_id": "hmm-regime-v1.2.0"},
                    "guardrail": {"reason": "stable"},
                },
            },
        )

        gate = pipeline._resolve_runtime_regime_gate(decision)
        self.assertEqual(gate.action, "abstain")
        self.assertEqual(gate.source, "regime_hmm_confidence")
        self.assertEqual(gate.reason, "regime_hmm_confidence_too_low")

    def test_pipeline_runtime_regime_gate_respects_configured_entropy_band_thresholds(
        self,
    ) -> None:
        from app import config

        original_thresholds = dict(
            config.settings.trading_runtime_regime_confidence_thresholds_by_entropy_band
        )
        config.settings.trading_runtime_regime_confidence_thresholds_by_entropy_band = {
            **original_thresholds,
            "high": (0.55, 0.45),
        }
        try:
            pipeline = self.make_pipeline()
            decision = StrategyDecision(
                strategy_id="strategy",
                symbol="AAPL",
                event_ts=datetime.now(timezone.utc),
                timeframe="1Min",
                action="buy",
                qty=Decimal("10"),
                params={
                    "regime_hmm": {
                        "schema_version": "hmm_regime_context_v1",
                        "regime_id": "R2",
                        "posterior": {"R2": "0.60", "R3": "0.40"},
                        "entropy": "2.2",
                        "entropy_band": "high",
                        "predicted_next": "R3",
                        "artifact": {"model_id": "hmm-regime-v1.2.0"},
                        "guardrail": {"reason": "stable"},
                    },
                },
            )

            gate = pipeline._resolve_runtime_regime_gate(decision)
            self.assertEqual(gate.action, "pass")
            self.assertEqual(gate.source, "regime_hmm")
        finally:
            config.settings.trading_runtime_regime_confidence_thresholds_by_entropy_band = original_thresholds

    def test_pipeline_runtime_regime_gate_invalid_regime_gate_action_fails_closed(
        self,
    ) -> None:
        pipeline = self.make_pipeline()
        decision = StrategyDecision(
            strategy_id="strategy",
            symbol="AAPL",
            event_ts=datetime.now(timezone.utc),
            timeframe="1Min",
            action="buy",
            qty=Decimal("10"),
            params={
                "regime_gate": {"action": "invalid"},
            },
        )

        gate = pipeline._resolve_runtime_regime_gate(decision)
        self.assertEqual(gate.action, "abstain")
        self.assertEqual(gate.source, "decision_regime_gate_invalid_action")
        self.assertEqual(gate.reason, "decision_regime_gate_invalid_action")

    def test_pipeline_runtime_regime_gate_unknown_regime_without_label_fails_closed(
        self,
    ) -> None:
        pipeline = self.make_pipeline()
        decision = StrategyDecision(
            strategy_id="strategy",
            symbol="AAPL",
            event_ts=datetime.now(timezone.utc),
            timeframe="1Min",
            action="buy",
            qty=Decimal("10"),
            params={
                "regime_hmm": {
                    "schema_version": "hmm_regime_context_v1",
                    "regime_id": "unknown",
                    "posterior": {"R2": "0.75"},
                    "entropy": "1.23",
                    "entropy_band": "medium",
                    "predicted_next": "R3",
                    "artifact": {"model_id": "hmm-regime-v1.2.0"},
                    "guardrail": {"reason": "stable"},
                },
            },
        )

        gate = pipeline._resolve_runtime_regime_gate(decision)

        self.assertEqual(gate.action, "abstain")
        self.assertEqual(gate.source, "regime_hmm_unknown_regime")
        self.assertEqual(gate.reason, "hmm_unknown")

    def test_pipeline_runtime_regime_gate_invalid_regime_id_without_label_fails_closed(
        self,
    ) -> None:
        pipeline = self.make_pipeline()
        decision = StrategyDecision(
            strategy_id="strategy",
            symbol="AAPL",
            event_ts=datetime.now(timezone.utc),
            timeframe="1Min",
            action="buy",
            qty=Decimal("10"),
            params={
                "regime_hmm": {
                    "schema_version": "hmm_regime_context_v1",
                    "regime_id": "R2-ish",
                    "posterior": {"R2": "0.75"},
                    "entropy": "1.23",
                    "entropy_band": "medium",
                    "predicted_next": "R3",
                    "artifact": {"model_id": "hmm-regime-v1.2.0"},
                    "guardrail": {"reason": "legacy_bridge"},
                },
            },
        )

        gate = pipeline._resolve_runtime_regime_gate(decision)

        self.assertEqual(gate.action, "abstain")
        self.assertEqual(gate.source, "regime_hmm_unknown_regime")
        self.assertEqual(gate.reason, "hmm_unknown")

    def test_pipeline_runtime_regime_gate_invalid_schema_version_fails_closed(
        self,
    ) -> None:
        pipeline = self.make_pipeline()
        decision = StrategyDecision(
            strategy_id="strategy",
            symbol="AAPL",
            event_ts=datetime.now(timezone.utc),
            timeframe="1Min",
            action="buy",
            qty=Decimal("10"),
            params={
                "regime_hmm": {
                    "schema_version": "hmm_regime_context_v0",
                    "regime_id": "R2",
                    "artifact": {"model_id": "hmm-regime-v1.2.0"},
                    "guardrail": {"reason": "stable"},
                },
            },
        )

        gate = pipeline._resolve_runtime_regime_gate(decision)

        self.assertEqual(gate.action, "abstain")
        self.assertEqual(gate.source, "regime_hmm_unknown_regime")
        self.assertEqual(gate.reason, "hmm_schema_version_invalid")
