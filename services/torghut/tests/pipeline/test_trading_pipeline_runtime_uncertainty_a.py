from __future__ import annotations

import json
import tempfile
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path

from sqlalchemy import select

from app.models import TradeDecision
from app.trading.firewall import OrderFirewall
from app.trading.models import StrategyDecision
from app.trading.scheduler.state import TradingState
from tests.pipeline.trading_pipeline_base import TradingPipelineTestCaseBase
from tests.pipeline.trading_pipeline_support import FakeAlpacaClient, FakeIngestor
from tests.trading_fixtures import make_signal, make_strategy


class TestTradingPipelineRuntimeUncertaintyA(TradingPipelineTestCaseBase):
    def test_pipeline_runtime_regime_gate_invalid_posterior_fails_closed(self) -> None:
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
                    "posterior": {"R2": "bad-probability", "R3": "0.5"},
                    "entropy": "1.2",
                    "entropy_band": "medium",
                    "predicted_next": "R3",
                    "artifact": {"model_id": "hmm-regime-v1.2.0"},
                    "transition_shock": False,
                    "guardrail": {"stale": False, "fallback_to_defensive": False},
                },
            },
        )

        gate = pipeline._resolve_runtime_regime_gate(decision)

        self.assertEqual(gate.action, "abstain")
        self.assertEqual(gate.source, "regime_hmm_non_authoritative")
        self.assertEqual(gate.reason, "hmm_invalid_posterior")

    def test_pipeline_runtime_regime_gate_invalid_schema_version_fails_closed_and_preserves_artifact_lineage(
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
                    "posterior": {"R2": "0.75"},
                    "entropy": "1.2",
                    "entropy_band": "medium",
                    "predicted_next": "R3",
                    "artifact": {
                        "model_id": "hmm-regime-v1.2.0",
                        "feature_schema": "hmm-v1-feature-schema",
                        "training_run_id": "run-2026-03-01",
                    },
                    "transition_shock": False,
                    "guardrail": {"stale": False, "fallback_to_defensive": False},
                },
                "regime_label": "trend",
            },
        )

        gate = pipeline._resolve_runtime_regime_gate(decision)
        self.assertEqual(gate.action, "abstain")
        self.assertEqual(gate.source, "regime_hmm_unknown_regime")
        self.assertEqual(gate.reason, "hmm_schema_version_invalid")
        self.assertIsNone(gate.regime_label)
        regime_payload = decision.params.get("regime_hmm")
        self.assertIsInstance(regime_payload, dict)
        self.assertEqual(regime_payload.get("schema_version"), "hmm_regime_context_v0")
        regime_artifact = regime_payload.get("artifact")
        self.assertIsInstance(regime_artifact, dict)
        self.assertEqual(regime_artifact.get("model_id"), "hmm-regime-v1.2.0")
        self.assertEqual(regime_artifact.get("feature_schema"), "hmm-v1-feature-schema")
        self.assertEqual(regime_artifact.get("training_run_id"), "run-2026-03-01")

    def test_pipeline_runtime_regime_gate_invalid_posterior_fails_closed_and_preserves_artifact_lineage(
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
                    "posterior": {
                        "R2": "bad-probability",
                        "R3": "0.5",
                    },
                    "entropy": "1.2",
                    "entropy_band": "medium",
                    "predicted_next": "R3",
                    "artifact": {
                        "model_id": "hmm-regime-v1.2.0",
                        "feature_schema": "hmm-v1-feature-schema",
                        "training_run_id": "run-2026-03-01",
                    },
                    "transition_shock": False,
                    "guardrail": {"stale": False, "fallback_to_defensive": False},
                },
                "regime_label": "trend",
            },
        )

        gate = pipeline._resolve_runtime_regime_gate(decision)
        self.assertEqual(gate.action, "abstain")
        self.assertEqual(gate.source, "regime_hmm_non_authoritative")
        self.assertEqual(gate.reason, "hmm_invalid_posterior")
        self.assertIsNone(gate.regime_label)
        regime_payload = decision.params.get("regime_hmm")
        self.assertIsInstance(regime_payload, dict)
        self.assertEqual(regime_payload.get("schema_version"), "hmm_regime_context_v1")
        regime_artifact = regime_payload.get("artifact")
        self.assertIsInstance(regime_artifact, dict)
        self.assertEqual(
            regime_artifact.get("model_id"),
            "hmm-regime-v1.2.0",
        )

    def test_pipeline_runtime_regime_gate_stale_hmm_is_fail_closed(self) -> None:
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
                    "posterior": {"R2": "0.75"},
                    "entropy": "1.23",
                    "entropy_band": "medium",
                    "predicted_next": "R3",
                    "artifact": {"model_id": "hmm-regime-v1.2.0"},
                    "guardrail": {"reason": "aging_output", "stale": True},
                },
            },
        )

        gate = pipeline._resolve_runtime_regime_gate(decision)

        self.assertEqual(gate.action, "abstain")
        self.assertEqual(gate.source, "regime_hmm_stale")
        self.assertEqual(gate.reason, "aging_output")

    def test_pipeline_runtime_regime_gate_stale_hmm_is_fail_closed_and_preserves_lineage(
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
                    "posterior": {"R2": "0.75"},
                    "entropy": "1.23",
                    "entropy_band": "medium",
                    "predicted_next": "R3",
                    "artifact": {
                        "model_id": "hmm-regime-v1.2.0",
                        "feature_schema": "hmm-v1-feature-schema",
                        "training_run_id": "run-2026-03-01",
                    },
                    "guardrail": {"reason": "aging_output", "stale": True},
                },
                "regime_label": "trend",
            },
        )

        gate = pipeline._resolve_runtime_regime_gate(decision)
        self.assertEqual(gate.action, "abstain")
        self.assertEqual(gate.source, "regime_hmm_stale")
        self.assertEqual(gate.reason, "aging_output")
        self.assertEqual(gate.regime_label, "trend")
        regime_payload = decision.params.get("regime_hmm")
        self.assertIsInstance(regime_payload, dict)
        self.assertEqual(regime_payload.get("schema_version"), "hmm_regime_context_v1")
        regime_artifact = regime_payload.get("artifact")
        self.assertIsInstance(regime_artifact, dict)
        self.assertEqual(
            regime_artifact.get("model_id"),
            "hmm-regime-v1.2.0",
        )

    def test_pipeline_runtime_regime_gate_fallback_to_defensive_is_fail_closed(
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
                    "posterior": {"R2": "0.75"},
                    "entropy": "1.23",
                    "entropy_band": "medium",
                    "predicted_next": "R3",
                    "artifact": {"model_id": "hmm-regime-v1.2.0"},
                    "guardrail": {"fallback_to_defensive": True},
                },
            },
        )

        gate = pipeline._resolve_runtime_regime_gate(decision)
        self.assertEqual(gate.action, "abstain")
        self.assertEqual(gate.source, "regime_hmm_stale")
        self.assertEqual(gate.regime_label, "R2")
        self.assertEqual(gate.reason, "fallback_to_defensive")

    def test_pipeline_runtime_regime_gate_non_authoritative_regime_with_legacy_label_fails_closed(
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
                    "regime_id": "not-a-regime-id",
                    "posterior": {"R2": "0.75"},
                    "entropy": "1.23",
                    "entropy_band": "medium",
                    "predicted_next": "R3",
                    "artifact": {"model_id": "hmm-regime-v1.2.0"},
                    "guardrail": {"reason": "transitioning"},
                },
                "regime_label": "trend",
            },
        )

        gate = pipeline._resolve_runtime_regime_gate(decision)
        self.assertEqual(gate.action, "abstain")
        self.assertEqual(gate.source, "regime_hmm_unknown_regime")
        self.assertEqual(gate.reason, "hmm_unknown")

    def test_pipeline_runtime_uncertainty_gate_report_parse_error_fails_closed(
        self,
    ) -> None:
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
                    description="runtime-gate-parse-error",
                    max_notional_per_trade=Decimal("1000"),
                )
                session.add(strategy)
                session.commit()

            gate_path = Path(tmpdir) / "gate-report.json"
            gate_path.write_text(
                '{"uncertainty_gate_action":"fail"',
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
                    "runtime_uncertainty_gate_abstain_block_risk_increasing_entries",
                    decision_json.get("risk_reasons", []),
                )
                params = decision_json.get("params")
                assert isinstance(params, dict)
                gate_payload = params.get("runtime_uncertainty_gate")
                assert isinstance(gate_payload, dict)
                self.assertEqual(gate_payload.get("action"), "abstain")
                self.assertEqual(
                    gate_payload.get("source"),
                    "autonomy_gate_report_read_error",
                )

    def test_pipeline_runtime_uncertainty_gate_report_stale_in_autonomy_path_abstains(
        self,
    ) -> None:
        stale_report = {
            "uncertainty_gate_action": "pass",
            "generated_at": (datetime.now(timezone.utc) - timedelta(minutes=45))
            .isoformat()
            .replace(
                "+00:00",
                "Z",
            ),
            "coverage_error": "0.01",
            "shift_score": "0.10",
        }
        with tempfile.TemporaryDirectory() as tmpdir:
            gate_path = Path(tmpdir) / "gate-report.json"
            gate_path.write_text(json.dumps(stale_report), encoding="utf-8")
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
                params={},
            )

            gate = pipeline._resolve_runtime_uncertainty_gate_from_inputs(decision)
            self.assertEqual(gate.action, "abstain")
            self.assertEqual(gate.source, "autonomy_gate_report_stale")
            self.assertEqual(gate.reason, "autonomy_gate_report_generated_at_stale")

    def test_pipeline_runtime_regime_gate_transition_shock_blocks_risk_increasing_entry(
        self,
    ) -> None:
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
                    description="runtime-regime-gate-transition-shock",
                    max_notional_per_trade=Decimal("1000"),
                )
                session.add(strategy)
                session.commit()

            gate_path = Path(tmpdir) / "gate-report.json"
            gate_path.write_text(
                '{"uncertainty_gate_action":"pass"}',
                encoding="utf-8",
            )
            signal = make_signal(
                datetime.now(timezone.utc),
                payload={
                    "macd": {"macd": 1.2, "signal": 0.5},
                    "rsi14": 25,
                    "price": 100,
                    "schema_version": "hmm_regime_context_v1",
                    "regime_id": "R2",
                    "posterior": {"R2": 1.0},
                    "entropy": "0.42",
                    "entropy_band": "low",
                    "predicted_next": "R2",
                    "transition_shock": True,
                    "duration_ms": 123,
                    "artifact": {
                        "model_id": "hmm-regime-v1.2.0",
                        "feature_schema": "hmm-v1",
                        "training_run_id": "run-2026-02-21",
                    },
                    "guardrail": {
                        "stale": False,
                        "fallback_to_defensive": False,
                    },
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
                    "runtime_uncertainty_gate_abstain_block_risk_increasing_entries",
                    decision_json.get("risk_reasons", []),
                )
                params = decision_json.get("params")
                assert isinstance(params, dict)
                gate_payload = params.get("runtime_uncertainty_gate")
                assert isinstance(gate_payload, dict)
                self.assertEqual(gate_payload.get("action"), "abstain")
                self.assertEqual(
                    gate_payload.get("source"), "regime_hmm_transition_shock"
                )
                regime_gate = gate_payload.get("regime_gate")
                assert isinstance(regime_gate, dict)
                self.assertEqual(regime_gate.get("action"), "abstain")
                self.assertEqual(
                    regime_gate.get("reason"), "regime_context_transition_shock"
                )

            self.assertEqual(len(alpaca_client.submitted), 0)
            self.assertEqual(
                state.metrics.runtime_regime_gate_action_total.get("abstain"), 1
            )
            self.assertEqual(
                state.metrics.runtime_regime_gate_blocked_total.get("abstain"), 1
            )

    def test_pipeline_runtime_regime_gate_stale_hmm_blocks_risk_increasing_entry_and_preserves_artifact_lineage(
        self,
    ) -> None:
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
                    name="demo-stale-regime-lineage",
                    description="runtime-regime-gate-stale",
                    max_notional_per_trade=Decimal("1000"),
                )
                session.add(strategy)
                session.commit()

            gate_path = Path(tmpdir) / "gate-report.json"
            gate_path.write_text(
                '{"uncertainty_gate_action":"pass"}',
                encoding="utf-8",
            )
            signal = make_signal(
                datetime.now(timezone.utc),
                payload={
                    "macd": {"macd": 1.2, "signal": 0.5},
                    "rsi14": 25,
                    "price": 100,
                    "schema_version": "hmm_regime_context_v1",
                    "regime_id": "R2",
                    "posterior": {"R2": 0.75},
                    "entropy": "1.23",
                    "entropy_band": "medium",
                    "predicted_next": "R3",
                    "transition_shock": False,
                    "duration_ms": 123,
                    "artifact": {
                        "model_id": "hmm-regime-v1.2.0",
                        "feature_schema": "hmm-v1",
                        "training_run_id": "run-2026-03-02",
                    },
                    "guardrail": {
                        "stale": True,
                        "fallback_to_defensive": False,
                        "reason": "aging_output",
                    },
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
                    "runtime_uncertainty_gate_abstain_block_risk_increasing_entries",
                    decision_json.get("risk_reasons", []),
                )
                params = decision_json.get("params")
                assert isinstance(params, dict)

                gate_payload = params.get("runtime_uncertainty_gate")
                assert isinstance(gate_payload, dict)
                self.assertEqual(gate_payload.get("action"), "abstain")
                self.assertEqual(
                    gate_payload.get("source"),
                    "regime_hmm_stale",
                )
                regime_gate = gate_payload.get("regime_gate")
                assert isinstance(regime_gate, dict)
                self.assertEqual(regime_gate.get("action"), "abstain")
                self.assertEqual(regime_gate.get("reason"), "aging_output")

                regime_payload = params.get("regime_hmm")
                self.assertIsInstance(regime_payload, dict)
                self.assertEqual(
                    regime_payload.get("schema_version"),
                    "hmm_regime_context_v1",
                )
                regime_artifact = regime_payload.get("artifact")
                self.assertIsInstance(regime_artifact, dict)
                self.assertEqual(regime_artifact.get("model_id"), "hmm-regime-v1.2.0")
                self.assertEqual(regime_artifact.get("feature_schema"), "hmm-v1")
                self.assertEqual(
                    regime_artifact.get("training_run_id"), "run-2026-03-02"
                )
                self.assertEqual(
                    regime_payload.get("hmm_state_posterior"), {"R2": "0.75"}
                )
                self.assertEqual(regime_payload.get("hmm_entropy"), "1.23")
                self.assertEqual(regime_payload.get("hmm_entropy_band"), "medium")
                self.assertEqual(regime_payload.get("hmm_transition_shock"), False)

            self.assertEqual(len(alpaca_client.submitted), 0)
            self.assertEqual(
                state.metrics.runtime_regime_gate_action_total.get("abstain"), 1
            )
            self.assertEqual(
                state.metrics.runtime_regime_gate_blocked_total.get("abstain"), 1
            )
