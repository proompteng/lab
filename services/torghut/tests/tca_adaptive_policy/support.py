from __future__ import annotations

# ruff: noqa: F401

from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import cast
from unittest import TestCase
from unittest.mock import patch

from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker

from app.models import Base, Execution, ExecutionTCAMetric, Strategy, TradeDecision
from app.trading import tca as tca_module
from app.trading.tca import (
    build_tca_gate_inputs,
    derive_adaptive_execution_policy,
    refresh_execution_tca_metrics,
    upsert_execution_tca_metric,
)


class _TestAdaptiveExecutionPolicyDerivationBase(TestCase):
    def setUp(self) -> None:
        engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
        Base.metadata.create_all(engine)
        self.session_local = sessionmaker(
            bind=engine, expire_on_commit=False, future=True
        )

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

    def _insert_tca_execution(
        self,
        session: Session,
        *,
        order_id: str,
        client_order_id: str,
    ) -> Execution:
        strategy = self._insert_strategy(session)
        decision = TradeDecision(
            strategy_id=strategy.id,
            alpaca_account_label="paper",
            symbol="MU",
            timeframe="1Min",
            decision_json={
                "strategy_id": str(strategy.id),
                "symbol": "MU",
                "action": "sell",
                "qty": "2",
                "params": {
                    "price": "412.67",
                    "price_snapshot": {"price": "316.93"},
                },
            },
            rationale="test",
            status="submitted",
            decision_hash=client_order_id,
        )
        session.add(decision)
        session.flush()
        execution = Execution(
            trade_decision_id=decision.id,
            alpaca_order_id=order_id,
            client_order_id=client_order_id,
            symbol="MU",
            side="sell",
            order_type="market",
            time_in_force="day",
            submitted_qty=Decimal("2"),
            filled_qty=Decimal("2"),
            avg_fill_price=Decimal("316.93"),
            status="filled",
            execution_expected_adapter="alpaca",
            execution_actual_adapter="alpaca",
        )
        session.add(execution)
        session.flush()
        return execution

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
        realized_shortfall_bps_values: list[Decimal | None] | None = None,
        divergence_bps_values: list[Decimal] | None = None,
        account_label: str = "paper",
    ) -> None:
        base_ts = datetime(2026, 1, 1, tzinfo=timezone.utc)
        for idx, slippage in enumerate(slippages):
            decision = TradeDecision(
                strategy_id=strategy.id,
                alpaca_account_label=account_label,
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
            realized_shortfall_bps_for_fill = realized_shortfall_bps
            if realized_shortfall_bps_for_fill is None:
                realized_shortfall_bps_for_fill = Decimal("0")
            avg_fill_price = Decimal("100") * (
                Decimal("1") + realized_shortfall_bps_for_fill / Decimal("10000")
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
                alpaca_account_label=account_label,
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


__all__ = [name for name in globals() if not name.startswith("__")]
