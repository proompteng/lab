from __future__ import annotations

from tests.tca_adaptive_policy.support import (
    Decimal,
    Execution,
    ExecutionTCAMetric,
    TradeDecision,
    _TestAdaptiveExecutionPolicyDerivationBase,
    build_tca_gate_inputs,
    derive_adaptive_execution_policy,
    select,
)


class TestAdaptiveExecutionPolicyCalibration(
    _TestAdaptiveExecutionPolicyDerivationBase
):
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

    def test_build_tca_gate_inputs_preserves_missing_calibration_error(self) -> None:
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
                realized_shortfall_bps_values=[None, None, None],
                divergence_bps_values=[Decimal("1"), Decimal("1"), Decimal("1")],
                adaptive_applied=False,
            )

            expected = build_tca_gate_inputs(session, strategy_id=strategy.id)
            self.assertEqual(expected["order_count"], 3)
            self.assertEqual(expected["expected_shortfall_sample_count"], 3)
            self.assertEqual(expected["expected_shortfall_coverage"], Decimal("1"))
            self.assertIsNone(expected["avg_calibration_error_bps"])
