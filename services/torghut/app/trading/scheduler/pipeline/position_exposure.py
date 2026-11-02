"""Position exposure helpers for scheduler cycle context."""

from __future__ import annotations

import logging
from collections.abc import Sequence
from datetime import datetime
from decimal import Decimal
from typing import Protocol, TypeAlias, cast

from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from ....models import Execution, TradeDecision
from .contexts import StrategyPositionExposureUpdate
from .shared import (
    TradingPipelineRuntime,
    aware_utc,
    normalized_symbol,
    same_side_position_exposure,
)
from .support import optional_decimal

logger = logging.getLogger(__name__)


class _PositionExposureExecutionRow(Protocol):
    symbol: object
    filled_qty: object
    side: object
    created_at: datetime
    avg_fill_price: object


class _PositionExposureDecisionRow(Protocol):
    symbol: object
    strategy_id: object


_PositionExposureRows: TypeAlias = Sequence[
    tuple[_PositionExposureExecutionRow, _PositionExposureDecisionRow]
]
_PositionExposureValue: TypeAlias = Decimal | datetime | None
_StrategyPositionExposure: TypeAlias = dict[str, _PositionExposureValue]
_StrategyPositionExposuresBySymbol: TypeAlias = dict[
    str, dict[str, _StrategyPositionExposure]
]


class TradingPipelinePositionExposureMixin(TradingPipelineRuntime):
    def _load_strategy_position_tag_rows(
        self,
        session: Session,
        lookback_start: datetime,
    ) -> _PositionExposureRows | None:
        try:
            return cast(
                _PositionExposureRows,
                session.execute(
                    select(Execution, TradeDecision)
                    .join(
                        TradeDecision, Execution.trade_decision_id == TradeDecision.id
                    )
                    .where(
                        Execution.alpaca_account_label == self.account_label,
                        TradeDecision.alpaca_account_label == self.account_label,
                        Execution.status == "filled",
                        Execution.filled_qty > Decimal("0"),
                        Execution.created_at >= lookback_start,
                    )
                ).all(),
            )
        except SQLAlchemyError:
            logger.exception(
                "Failed to resolve strategy position tags account=%s",
                self.account_label,
            )
            return None

    def _build_strategy_position_exposures(
        self,
        rows: _PositionExposureRows,
        session_open: datetime,
    ) -> _StrategyPositionExposuresBySymbol:
        exposures: _StrategyPositionExposuresBySymbol = {}
        for execution, decision_row in rows:
            update = self._strategy_position_exposure_update(execution, decision_row)
            if update is None:
                continue
            self._record_strategy_position_exposure(
                exposures,
                update=update,
                session_open=session_open,
            )
        return exposures

    @staticmethod
    def _strategy_position_exposure_update(
        execution: _PositionExposureExecutionRow,
        decision_row: _PositionExposureDecisionRow,
    ) -> StrategyPositionExposureUpdate | None:
        symbol = normalized_symbol(execution.symbol or decision_row.symbol)
        strategy_id = str(decision_row.strategy_id)
        if not symbol or not strategy_id:
            return None
        filled_qty = optional_decimal(execution.filled_qty)
        if filled_qty is None or filled_qty <= 0:
            return None
        side = str(execution.side or "").strip().lower()
        if side not in {"buy", "sell"}:
            return None
        signed_qty = filled_qty if side == "buy" else -filled_qty
        return StrategyPositionExposureUpdate(
            symbol=symbol,
            strategy_id=strategy_id,
            signed_qty=signed_qty,
            filled_qty=filled_qty,
            side=side,
            execution_created_at=aware_utc(execution.created_at),
            avg_fill_price=optional_decimal(execution.avg_fill_price),
        )

    @staticmethod
    def _empty_strategy_position_exposure() -> _StrategyPositionExposure:
        return {
            "qty": Decimal("0"),
            "buy_qty": Decimal("0"),
            "buy_notional": Decimal("0"),
            "session_qty": Decimal("0"),
            "latest_execution_at": None,
            "earliest_execution_at": None,
        }

    @staticmethod
    def _record_strategy_position_exposure(
        exposures: _StrategyPositionExposuresBySymbol,
        *,
        update: StrategyPositionExposureUpdate,
        session_open: datetime,
    ) -> None:
        strategy_exposures = exposures.setdefault(update.symbol, {})
        exposure = strategy_exposures.setdefault(
            update.strategy_id,
            TradingPipelinePositionExposureMixin._empty_strategy_position_exposure(),
        )
        exposure["qty"] = cast(Decimal, exposure["qty"]) + update.signed_qty
        if update.execution_created_at >= session_open:
            exposure["session_qty"] = (
                cast(Decimal, exposure["session_qty"]) + update.signed_qty
            )
        if (
            update.side == "buy"
            and update.avg_fill_price is not None
            and update.avg_fill_price > 0
        ):
            exposure["buy_qty"] = cast(Decimal, exposure["buy_qty"]) + update.filled_qty
            exposure["buy_notional"] = cast(
                Decimal,
                exposure["buy_notional"],
            ) + (update.filled_qty * update.avg_fill_price)
        TradingPipelinePositionExposureMixin._record_position_exposure_window(
            exposure,
            update.execution_created_at,
        )

    @staticmethod
    def _record_position_exposure_window(
        exposure: _StrategyPositionExposure,
        execution_created_at: datetime,
    ) -> None:
        earliest_execution_at = exposure.get("earliest_execution_at")
        if (
            not isinstance(earliest_execution_at, datetime)
            or execution_created_at < earliest_execution_at
        ):
            exposure["earliest_execution_at"] = execution_created_at
        latest_execution_at = exposure.get("latest_execution_at")
        if (
            not isinstance(latest_execution_at, datetime)
            or execution_created_at > latest_execution_at
        ):
            exposure["latest_execution_at"] = execution_created_at

    @staticmethod
    def same_side_position_exposure(
        position_qty: Decimal,
        exposure_qty: Decimal,
    ) -> bool:
        return same_side_position_exposure(position_qty, exposure_qty)
