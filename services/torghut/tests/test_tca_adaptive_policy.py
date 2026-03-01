from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal
from unittest import TestCase

from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker

from app.models import Base, Execution, ExecutionTCAMetric, Strategy, TradeDecision
from app.trading.tca import build_tca_gate_inputs, derive_adaptive_execution_policy


class TestAdaptiveExecutionPolicyDerivation(TestCase):
    def setUp(self) -> None:
        engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
        Base.metadata.create_all(engine)
        self.session_local = sessionmaker(
            bind=engine, expire_on_commit=False, future=True
        )

    def test_derivation_builds_defensive_override_for_high_recent_slippage(
        self,
    ) -> None:
        with self.session_local() as session:
            strategy = self._insert_strategy(session)
            self._insert_observations(
                session,
                strategy,
                symbol="AAPL",
                regime="trend",
                slippages=[
                    Decimal("10"),
                    Decimal("10"),
                    Decimal("10"),
                    Decimal("25"),
                    Decimal("25"),
                    Decimal("25"),
                ],
                shortfalls=[
                    Decimal("2"),
                    Decimal("2"),
                    Decimal("2"),
                    Decimal("20"),
                    Decimal("20"),
                    Decimal("20"),
                ],
                expected_shortfall_p50_values=[
                    Decimal("5"),
                    Decimal("5"),
                    Decimal("5"),
                    Decimal("5"),
                    Decimal("5"),
                    Decimal("5"),
                ],
                adaptive_applied=False,
            )

            decision = derive_adaptive_execution_policy(
                session,
                symbol="AAPL",
                regime_label="trend",
            )

        self.assertEqual(decision.aggressiveness, "defensive")
        self.assertEqual(decision.prefer_limit, True)
        self.assertFalse(decision.fallback_active)
        self.assertEqual(decision.sample_size, 6)
        self.assertEqual(decision.regime_label, "trend")

    def test_derivation_builds_defensive_override_for_high_shortfall_only(self) -> None:
        with self.session_local() as session:
            strategy = self._insert_strategy(session)
            self._insert_observations(
                session,
                strategy,
                symbol="AAPL",
                regime="trend",
                slippages=[
                    Decimal("8"),
                    Decimal("9"),
                    Decimal("10"),
                    Decimal("10"),
                    Decimal("10"),
                    Decimal("10"),
                ],
                shortfalls=[
                    Decimal("1"),
                    Decimal("1"),
                    Decimal("1"),
                    Decimal("18"),
                    Decimal("18"),
                    Decimal("18"),
                ],
                expected_shortfall_p50_values=[
                    Decimal("4"),
                    Decimal("4"),
                    Decimal("4"),
                    Decimal("4"),
                    Decimal("4"),
                    Decimal("4"),
                ],
                adaptive_applied=False,
            )

            decision = derive_adaptive_execution_policy(
                session,
                symbol="AAPL",
                regime_label="trend",
            )

        self.assertEqual(decision.aggressiveness, "defensive")
        self.assertEqual(decision.prefer_limit, True)
        self.assertFalse(decision.fallback_active)
        self.assertGreater(
            decision.recent_shortfall_notional or Decimal("0"), Decimal("15")
        )

    def test_build_tca_gate_inputs_uses_absolute_metrics_for_tca_exposure(self) -> None:
        with self.session_local() as session:
            strategy = self._insert_strategy(session)
            self._insert_observations(
                session,
                strategy,
                symbol="AAPL",
                regime="trend",
                slippages=[Decimal("12"), Decimal("-12")],
                shortfalls=[Decimal("4"), Decimal("-4")],
                expected_shortfall_p50_values=[Decimal("0"), Decimal("0")],
                realized_shortfall_bps_values=[Decimal("1"), Decimal("-1")],
                divergence_bps_values=[Decimal("1"), Decimal("-1")],
                adaptive_applied=False,
            )

            expected = build_tca_gate_inputs(session, strategy_id=strategy.id)
            self.assertEqual(expected["avg_slippage_bps"], Decimal("0"))
            self.assertEqual(expected["avg_abs_slippage_bps"], Decimal("12"))
            self.assertEqual(expected["avg_shortfall_notional"], Decimal("0"))
            self.assertEqual(expected["avg_shortfall_notional_abs"], Decimal("4"))
            self.assertEqual(expected["avg_divergence_bps"], Decimal("0"))
            self.assertEqual(expected["avg_divergence_bps_abs"], Decimal("1"))
            self.assertEqual(expected["avg_realized_shortfall_bps"], Decimal("0"))
            self.assertEqual(expected["avg_realized_shortfall_bps_abs"], Decimal("1"))
            self.assertEqual(expected["order_count"], 2)
            self.assertEqual(expected["expected_shortfall_sample_count"], 2)
            self.assertEqual(expected["expected_shortfall_coverage"], Decimal("1"))

    def test_derivation_fallback_when_expected_shortfall_coverage_is_insufficient(
        self,
    ) -> None:
        with self.session_local() as session:
            strategy = self._insert_strategy(session)
            self._insert_observations(
                session,
                strategy,
                symbol="AAPL",
                regime="trend",
                slippages=[
                    Decimal("8"),
                    Decimal("8"),
                    Decimal("8"),
                    Decimal("8"),
                    Decimal("8"),
                    Decimal("8"),
                ],
                shortfalls=[
                    Decimal("2"),
                    Decimal("2"),
                    Decimal("2"),
                    Decimal("2"),
                    Decimal("2"),
                    Decimal("2"),
                ],
                expected_shortfall_p50_values=[Decimal("4"), Decimal("4")],
                adaptive_applied=False,
            )

            decision = derive_adaptive_execution_policy(
                session,
                symbol="AAPL",
                regime_label="trend",
            )

        self.assertTrue(decision.fallback_active)
        self.assertEqual(
            decision.fallback_reason, "adaptive_policy_expected_shortfall_coverage_low"
        )
        self.assertEqual(decision.expected_shortfall_sample_count, 2)
        self.assertEqual(decision.expected_shortfall_coverage, Decimal(2) / Decimal(6))

    def test_derivation_fallback_when_expected_shortfall_calibration_is_missing(
        self,
    ) -> None:
        with self.session_local() as session:
            strategy = self._insert_strategy(session)
            self._insert_observations(
                session,
                strategy,
                symbol="AAPL",
                regime="trend",
                slippages=[
                    Decimal("8"),
                    Decimal("9"),
                    Decimal("10"),
                    Decimal("11"),
                    Decimal("12"),
                    Decimal("13"),
                ],
                shortfalls=[
                    Decimal("1"),
                    Decimal("2"),
                    Decimal("3"),
                    Decimal("4"),
                    Decimal("5"),
                    Decimal("6"),
                ],
                adaptive_applied=False,
            )

            decision = derive_adaptive_execution_policy(
                session,
                symbol="AAPL",
                regime_label="trend",
            )

        self.assertTrue(decision.fallback_active)
        self.assertEqual(
            decision.fallback_reason,
            "adaptive_policy_expected_shortfall_coverage_missing",
        )
        self.assertEqual(decision.expected_shortfall_sample_count, 0)

    def test_derivation_triggers_fallback_when_adaptive_degrades(self) -> None:
        with self.session_local() as session:
            strategy = self._insert_strategy(session)
            self._insert_observations(
                session,
                strategy,
                symbol="AAPL",
                regime="all",
                slippages=[
                    Decimal("10"),
                    Decimal("10"),
                    Decimal("10"),
                    Decimal("18"),
                    Decimal("18"),
                    Decimal("18"),
                ],
                shortfalls=[
                    Decimal("3"),
                    Decimal("3"),
                    Decimal("3"),
                    Decimal("9"),
                    Decimal("9"),
                    Decimal("9"),
                ],
                expected_shortfall_p50_values=[
                    Decimal("5"),
                    Decimal("5"),
                    Decimal("5"),
                    Decimal("5"),
                    Decimal("5"),
                    Decimal("5"),
                ],
                adaptive_applied=True,
            )

            decision = derive_adaptive_execution_policy(
                session,
                symbol="AAPL",
                regime_label=None,
            )

        self.assertTrue(decision.fallback_active)
        self.assertEqual(decision.fallback_reason, "adaptive_policy_degraded")
        self.assertIsNone(decision.prefer_limit)
        self.assertGreater(decision.degradation_bps or Decimal("0"), Decimal("4"))

    def test_derivation_stays_neutral_when_shortfall_signal_is_missing(self) -> None:
        with self.session_local() as session:
            strategy = self._insert_strategy(session)
            self._insert_observations(
                session,
                strategy,
                symbol="AAPL",
                regime="trend",
                slippages=[
                    Decimal("10"),
                    Decimal("12"),
                    Decimal("14"),
                    Decimal("16"),
                    Decimal("18"),
                    Decimal("20"),
                ],
                shortfalls=[
                    None,
                    None,
                    None,
                    None,
                    None,
                    None,
                ],
                expected_shortfall_p50_values=[
                    Decimal("5"),
                    Decimal("5"),
                    Decimal("5"),
                    Decimal("5"),
                    Decimal("5"),
                    Decimal("5"),
                ],
                adaptive_applied=False,
            )

            decision = derive_adaptive_execution_policy(
                session,
                symbol="AAPL",
                regime_label="trend",
            )

        self.assertFalse(decision.fallback_active)
        self.assertIsNone(decision.prefer_limit)
        self.assertEqual(decision.aggressiveness, "neutral")

    def _insert_strategy(self, session: Session) -> Strategy:
        strategy = Strategy(
            name="adaptive-policy-test",
            description="test",
            enabled=True,
            base_timeframe="1Min",
            universe_type="static",
            universe_symbols=["AAPL"],
        )
        session.add(strategy)
        session.commit()
        session.refresh(strategy)
        return strategy

    def _insert_observations(
        self,
        session: Session,
        strategy: Strategy,
        *,
        symbol: str,
        regime: str,
        slippages: list[Decimal],
        shortfalls: list[Decimal | None],
        adaptive_applied: bool,
        expected_shortfall_p50_values: list[Decimal] | None = None,
        expected_shortfall_p95_values: list[Decimal] | None = None,
        realized_shortfall_bps_values: list[Decimal] | None = None,
        divergence_bps_values: list[Decimal] | None = None,
    ) -> None:
        base_ts = datetime(2026, 1, 1, tzinfo=timezone.utc)
        for idx, slippage in enumerate(slippages):
            decision = TradeDecision(
                strategy_id=strategy.id,
                alpaca_account_label="paper",
                symbol=symbol,
                timeframe="1Min",
                decision_json={
                    "strategy_id": str(strategy.id),
                    "symbol": symbol,
                    "action": "buy",
                    "qty": "1",
                    "params": {
                        "regime_label": regime,
                        "execution_policy": {
                            "adaptive": {
                                "applied": adaptive_applied,
                            }
                        },
                    },
                },
                rationale="test",
                status="submitted",
                decision_hash=f"hash-{regime}-{idx}",
            )
            session.add(decision)
            session.flush()

            realized_shortfall_bps = (
                realized_shortfall_bps_values[idx]
                if realized_shortfall_bps_values is not None
                and idx < len(realized_shortfall_bps_values)
                else Decimal("0")
            )
            avg_fill_price = Decimal("100") * (
                Decimal("1") + realized_shortfall_bps / Decimal("10000")
            )
            execution = Execution(
                trade_decision_id=decision.id,
                alpaca_order_id=f"order-{regime}-{idx}",
                client_order_id=f"client-{regime}-{idx}",
                symbol=symbol,
                side="buy",
                order_type="market",
                time_in_force="day",
                submitted_qty=Decimal("1"),
                filled_qty=Decimal("1"),
                avg_fill_price=avg_fill_price,
                status="filled",
                execution_expected_adapter="alpaca",
                execution_actual_adapter="alpaca",
            )
            session.add(execution)
            session.flush()

            expected_shortfall_p50 = (
                expected_shortfall_p50_values[idx]
                if expected_shortfall_p50_values is not None
                and idx < len(expected_shortfall_p50_values)
                else None
            )
            expected_shortfall_p95 = (
                expected_shortfall_p95_values[idx]
                if expected_shortfall_p95_values is not None
                and idx < len(expected_shortfall_p95_values)
                else None
            )
            divergence_bps = (
                divergence_bps_values[idx]
                if divergence_bps_values is not None
                and idx < len(divergence_bps_values)
                else None
            )
            metric = ExecutionTCAMetric(
                execution_id=execution.id,
                trade_decision_id=decision.id,
                strategy_id=strategy.id,
                alpaca_account_label="paper",
                symbol=symbol,
                side="buy",
                arrival_price=Decimal("100"),
                avg_fill_price=avg_fill_price,
                filled_qty=Decimal("1"),
                signed_qty=Decimal("1"),
                slippage_bps=slippage,
                shortfall_notional=shortfalls[idx],
                expected_shortfall_bps_p50=expected_shortfall_p50,
                expected_shortfall_bps_p95=expected_shortfall_p95,
                realized_shortfall_bps=realized_shortfall_bps,
                divergence_bps=divergence_bps,
                churn_qty=Decimal("0"),
                churn_ratio=Decimal("0"),
                computed_at=base_ts + timedelta(minutes=idx),
            )
            session.add(metric)

        session.commit()

    def test_build_tca_gate_inputs_includes_calibration_and_divergence_evidence(
        self,
    ) -> None:
        with self.session_local() as session:
            strategy = self._insert_strategy(session)
            self._insert_observations(
                session,
                strategy,
                symbol="AAPL",
                regime="trend",
                slippages=[Decimal("8"), Decimal("12"), Decimal("4")],
                shortfalls=[Decimal("2"), Decimal("3"), Decimal("1")],
                expected_shortfall_p50_values=[
                    Decimal("4"),
                    Decimal("4"),
                    Decimal("4"),
                ],
                expected_shortfall_p95_values=[
                    Decimal("9"),
                    Decimal("11"),
                    Decimal("10"),
                ],
                realized_shortfall_bps_values=[
                    Decimal("1"),
                    Decimal("2"),
                    Decimal("3"),
                ],
                divergence_bps_values=[Decimal("1"), Decimal("1"), Decimal("1")],
                adaptive_applied=False,
            )

            metrics = session.scalars(
                select(ExecutionTCAMetric)
                .join(Execution, Execution.id == ExecutionTCAMetric.execution_id)
                .join(TradeDecision, TradeDecision.id == Execution.trade_decision_id)
                .where(TradeDecision.strategy_id == strategy.id)
                .order_by(ExecutionTCAMetric.execution_id)
            ).all()
            assert len(metrics) == 3

            expected = build_tca_gate_inputs(session, strategy_id=strategy.id)
            self.assertEqual(expected["order_count"], 3)
            self.assertEqual(expected["expected_shortfall_sample_count"], 3)
            self.assertEqual(expected["expected_shortfall_coverage"], Decimal("1"))
            self.assertEqual(expected["avg_expected_shortfall_bps_p50"], Decimal("4"))
            self.assertEqual(expected["avg_expected_shortfall_bps_p95"], Decimal("10"))
            self.assertEqual(expected["avg_realized_shortfall_bps"], Decimal("2"))
            self.assertEqual(expected["avg_divergence_bps"], Decimal("1"))
            self.assertEqual(expected["avg_calibration_error_bps"], Decimal("2"))
