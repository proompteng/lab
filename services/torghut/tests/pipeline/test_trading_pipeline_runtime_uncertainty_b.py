from __future__ import annotations

import json
import tempfile
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path

from sqlalchemy import select

from app.models import TradeDecision
from app.trading.decisions import DecisionEngine
from app.trading.firewall import OrderFirewall
from app.trading.models import StrategyDecision
from app.trading.scheduler.state import TradingState
from tests.pipeline.trading_pipeline_base import TradingPipelineTestCaseBase
from tests.pipeline.trading_pipeline_support import (
    FakeAlpacaClient,
    FakeIngestor,
    FakePriceFetcher,
    PositionedAlpacaClient,
)
from tests.trading_fixtures import make_signal, make_strategy


class TestTradingPipelineRuntimeUncertaintyB(TradingPipelineTestCaseBase):
    def test_pipeline_runtime_regime_gate_invalid_posterior_blocks_risk_increasing_entry_and_preserves_artifact_lineage(
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
                    name="demo-invalid-posterior",
                    description="runtime-regime-gate-invalid-posterior",
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
                    "posterior": {"R2": "bad-posterior"},
                    "entropy": "1.2",
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
                self.assertEqual(
                    gate_payload.get("source"), "regime_hmm_non_authoritative"
                )
                regime_gate = gate_payload.get("regime_gate")
                assert isinstance(regime_gate, dict)
                self.assertEqual(regime_gate.get("action"), "abstain")
                self.assertEqual(regime_gate.get("reason"), "hmm_invalid_posterior")

                regime_payload = params.get("regime_hmm")
                self.assertIsInstance(regime_payload, dict)
                self.assertEqual(
                    regime_payload.get("schema_version"),
                    "hmm_regime_context_v1",
                )
                regime_artifact = regime_payload.get("artifact")
                self.assertIsInstance(regime_artifact, dict)
                self.assertEqual(
                    regime_artifact.get("model_id"),
                    "hmm-regime-v1.2.0",
                )
                self.assertEqual(
                    regime_artifact.get("feature_schema"),
                    "hmm-v1",
                )
                self.assertEqual(
                    regime_artifact.get("training_run_id"),
                    "run-2026-03-02",
                )
                self.assertEqual(regime_payload.get("hmm_entropy"), "1.2")
                self.assertEqual(regime_payload.get("hmm_state_posterior"), {})
                self.assertEqual(regime_payload.get("hmm_entropy_band"), "medium")
                self.assertEqual(regime_payload.get("hmm_transition_shock"), False)

            self.assertEqual(len(alpaca_client.submitted), 0)
            self.assertEqual(
                state.metrics.runtime_regime_gate_action_total.get("abstain"), 1
            )
            self.assertEqual(
                state.metrics.runtime_regime_gate_blocked_total.get("abstain"), 1
            )

    def test_pipeline_runtime_regime_gate_unparseable_payload_fails_closed(
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

        class DeterministicDecisionEngine(DecisionEngine):
            def evaluate(
                self,
                _signal,
                _strategies,
                *,
                equity: object | None = None,
            ) -> list[StrategyDecision]:
                _ = equity
                return [forced_decision]

        strategy_id: str
        with self.session_local() as session:
            strategy = make_strategy(
                name="demo",
                description="runtime-regime-gate-unparseable",
                max_notional_per_trade=Decimal("1000"),
            )
            session.add(strategy)
            session.commit()
            strategy_id = str(strategy.id)

        forced_decision = StrategyDecision(
            strategy_id=strategy_id,
            symbol="AAPL",
            event_ts=datetime.now(timezone.utc),
            timeframe="1Min",
            action="buy",
            qty=Decimal("1"),
            params={
                "regime_hmm": "bad-regime-payload",
            },
        )

        state = TradingState()
        alpaca_client = FakeAlpacaClient()
        pipeline = self.make_pipeline(
            alpaca_client=alpaca_client,
            order_firewall=OrderFirewall(alpaca_client),
            ingestor=FakeIngestor(
                [
                    make_signal(
                        datetime.now(timezone.utc),
                        payload={
                            "macd": {"macd": 1.2, "signal": 0.5},
                            "rsi14": 25,
                            "price": 100,
                        },
                    )
                ]
            ),
            decision_engine=DeterministicDecisionEngine(),
            execution_adapter=alpaca_client,
            state=state,
            price_fetcher=FakePriceFetcher(Decimal("100")),
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
            self.assertEqual(gate_payload.get("source"), "regime_hmm_unparseable")
            regime_gate = gate_payload.get("regime_gate")
            assert isinstance(regime_gate, dict)
            self.assertEqual(regime_gate.get("action"), "abstain")
            self.assertEqual(
                regime_gate.get("reason"), "regime_hmm_unparseable_payload"
            )

        self.assertEqual(len(alpaca_client.submitted), 0)
        self.assertEqual(
            state.metrics.runtime_regime_gate_action_total.get("abstain"), 1
        )
        self.assertEqual(
            state.metrics.runtime_regime_gate_blocked_total.get("abstain"), 1
        )

    def test_pipeline_runtime_uncertainty_abstain_allows_risk_reducing_exit(
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
                    description="runtime-gate-abstain",
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

            with self.session_local() as session:
                decisions = session.execute(select(TradeDecision)).scalars().all()
                self.assertEqual(len(decisions), 1)
                self.assertEqual(decisions[0].status, "submitted")
                decision_json = decisions[0].decision_json
                assert isinstance(decision_json, dict)
                params = decision_json.get("params")
                assert isinstance(params, dict)
                gate_payload = params.get("runtime_uncertainty_gate")
                assert isinstance(gate_payload, dict)
                self.assertEqual(gate_payload.get("action"), "abstain")
                self.assertFalse(gate_payload.get("entry_blocked"))
                self.assertFalse(gate_payload.get("risk_increasing_entry"))

            self.assertEqual(len(alpaca_client.submitted), 1)
            self.assertEqual(
                state.metrics.runtime_uncertainty_gate_action_total.get("abstain"),
                1,
            )
            self.assertIsNone(
                state.metrics.runtime_uncertainty_gate_blocked_total.get("abstain")
            )

    def test_pipeline_runtime_uncertainty_degrade_tightens_sizing_and_participation(
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
                    description="runtime-gate-degrade",
                    max_notional_per_trade=Decimal("1000"),
                )
                session.add(strategy)
                session.flush()
                self._activate_test_capital_authority(session, strategy=strategy)
                session.commit()

            gate_path = Path(tmpdir) / "gate-report.json"
            gate_path.write_text(
                '{"uncertainty_gate_action":"degrade"}',
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

            self.assertEqual(len(alpaca_client.submitted), 1)
            self.assertEqual(alpaca_client.submitted[0]["qty"], "5.0")
            with self.session_local() as session:
                decisions = session.execute(select(TradeDecision)).scalars().all()
                self.assertEqual(len(decisions), 1)
                self.assertEqual(decisions[0].status, "submitted")
                decision_json = decisions[0].decision_json
                assert isinstance(decision_json, dict)
                params = decision_json.get("params")
                assert isinstance(params, dict)
                gate_payload = params.get("runtime_uncertainty_gate")
                assert isinstance(gate_payload, dict)
                self.assertEqual(gate_payload.get("action"), "degrade")
                self.assertEqual(gate_payload.get("degrade_qty_multiplier"), "0.50")
                allocator = params.get("allocator")
                assert isinstance(allocator, dict)
                self.assertEqual(
                    allocator.get("max_participation_rate_override"), "0.05"
                )
                self.assertEqual(params.get("execution_seconds"), 120)

            self.assertEqual(
                state.metrics.runtime_uncertainty_gate_action_total.get("degrade"),
                1,
            )

    def test_runtime_uncertainty_gate_degrade_uses_regime_profile(self) -> None:
        self.configure_settings(
            trading_runtime_uncertainty_degrade_qty_multipliers_by_regime={
                "riskoff": 0.25,
            },
            trading_runtime_uncertainty_degrade_max_participation_rate_by_regime={
                "riskoff": 0.03,
            },
            trading_runtime_uncertainty_degrade_min_execution_seconds_by_regime={
                "riskoff": 180,
            },
        )

        pipeline = self.make_pipeline()
        decision = StrategyDecision(
            strategy_id="strategy",
            symbol="AAPL",
            event_ts=datetime.now(timezone.utc),
            timeframe="1Min",
            action="buy",
            qty=Decimal("20"),
            params={
                "regime_gate": {
                    "action": "pass",
                    "regime_label": "riskoff",
                },
            },
        )

        updated_decision, payload, reason = pipeline._apply_runtime_uncertainty_gate(
            decision,
            positions=[],
        )

        self.assertIsNone(reason)
        self.assertEqual(payload.get("degrade_qty_multiplier"), "0.25")
        self.assertEqual(payload.get("max_participation_rate_override"), "0.03")
        self.assertEqual(payload.get("min_execution_seconds"), 180)
        self.assertEqual(
            str(
                updated_decision.params["allocator"]["max_participation_rate_override"]
            ),
            "0.03",
        )
        self.assertEqual(updated_decision.params.get("execution_seconds"), 180)
        self.assertEqual(Decimal(str(payload.get("adjusted_qty"))), Decimal("5"))

    def test_runtime_uncertainty_gate_degrade_does_not_increase_fractional_qty(
        self,
    ) -> None:
        self.configure_settings(
            trading_fractional_equities_enabled=True,
            trading_runtime_uncertainty_degrade_qty_multipliers_by_regime={
                "trend": 0.5,
            },
        )

        pipeline = self.make_pipeline()
        decision = StrategyDecision(
            strategy_id="strategy",
            symbol="AAPL",
            event_ts=datetime.now(timezone.utc),
            timeframe="1Min",
            action="buy",
            qty=Decimal("0.2766"),
            params={
                "regime_gate": {
                    "action": "pass",
                    "regime_label": "trend",
                },
                "runtime_uncertainty_gate": {
                    "action": "degrade",
                },
            },
        )

        updated_decision, payload, reason = pipeline._apply_runtime_uncertainty_gate(
            decision,
            positions=[],
        )

        self.assertIsNone(reason)
        self.assertEqual(payload.get("adjusted_qty"), "0.1383")
        self.assertEqual(updated_decision.qty, Decimal("0.1383"))

    def test_runtime_uncertainty_gate_softens_saturated_autonomy_fail_sentinel(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            gate_path = Path(tmpdir) / "gate-report.json"
            gate_path.write_text(
                json.dumps(
                    {
                        "uncertainty_gate_action": "fail",
                        "coverage_error": "1",
                        "shift_score": "1",
                        "conformal_interval_width": "0",
                    }
                ),
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
                qty=Decimal("5"),
                params={},
            )

            gate = pipeline._resolve_runtime_uncertainty_gate_from_inputs(decision)

            self.assertEqual(gate.action, "degrade")
            self.assertEqual(
                gate.source, "autonomy_gate_report_saturated_fail_sentinel"
            )
            self.assertEqual(
                gate.reason, "autonomy_gate_report_saturated_fail_sentinel"
            )

    def test_pipeline_runtime_uncertainty_uses_projected_positions_within_run(
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
                    description="runtime-gate-projected-positions",
                    max_notional_per_trade=Decimal("500"),
                )
                session.add(strategy)
                session.commit()

            gate_path = Path(tmpdir) / "gate-report.json"
            gate_path.write_text(
                '{"uncertainty_gate_action":"abstain"}',
                encoding="utf-8",
            )
            event_ts = datetime.now(timezone.utc)
            signals = [
                make_signal(
                    event_ts,
                    payload={
                        "macd": {"macd": 1.2, "signal": 0.5},
                        "rsi14": 25,
                        "price": 100,
                    },
                ),
                make_signal(
                    event_ts + timedelta(seconds=1),
                    payload={
                        "macd": {"macd": 1.2, "signal": 0.5},
                        "rsi14": 25,
                        "price": 100,
                    },
                ),
            ]
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
                ingestor=FakeIngestor(signals),
                execution_adapter=alpaca_client,
                state=state,
            )

            pipeline.run_once()

            with self.session_local() as session:
                decisions = session.execute(select(TradeDecision)).scalars().all()
                self.assertEqual(len(decisions), 2)
                status_counts = {
                    status: sum(1 for item in decisions if item.status == status)
                    for status in {"submitted", "rejected"}
                }
                self.assertEqual(status_counts.get("submitted"), 1)
                self.assertEqual(status_counts.get("rejected"), 1)
                rejected = next(item for item in decisions if item.status == "rejected")
                decision_json = rejected.decision_json
                assert isinstance(decision_json, dict)
                self.assertIn(
                    "runtime_uncertainty_gate_abstain_block_risk_increasing_entries",
                    decision_json.get("risk_reasons", []),
                )

            self.assertEqual(len(alpaca_client.submitted), 1)
            self.assertEqual(
                state.metrics.runtime_uncertainty_gate_blocked_total.get("abstain"),
                1,
            )
