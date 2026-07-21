"""Live account equity stops and deterministic end-of-day closeout."""

from __future__ import annotations

import logging
import time as time_module
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from typing import cast
from zoneinfo import ZoneInfo

from alpaca.common.exceptions import APIError
from sqlalchemy import func, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from ...config import settings
from ...models import PositionSnapshot
from ..broker_mutation_receipts import BrokerMutationPurpose
from ..execution_adapters import ExecutionAdapter
from ..models import StrategyDecision
from ..session_context import regular_session_open_utc_for
from ..tigerbeetle_client import (
    RealTigerBeetleClient,
    TigerBeetleHealth,
    check_tigerbeetle_health,
    create_tigerbeetle_client,
)
from ..tigerbeetle_reconcile.latest_tigerbeetle_reconciliation_status_p import (
    latest_tigerbeetle_reconciliation_status_payload,
)
from ..time_source import trading_now
from .state import TradingState

logger = logging.getLogger(__name__)
_NEW_YORK = ZoneInfo("America/New_York")


@dataclass(frozen=True)
class CapitalRiskSnapshot:
    current_equity: Decimal
    daily_start_equity: Decimal
    high_water_equity: Decimal
    daily_loss_ratio: Decimal
    drawdown_ratio: Decimal


class CapitalSafetyController:
    """Enforce live loss limits, exposure cutoff, and broker closeout."""

    def __init__(
        self,
        *,
        execution_adapter: ExecutionAdapter,
        state: TradingState,
        account_label: str,
        sleep: Callable[[float], None] = time_module.sleep,
    ) -> None:
        self.execution_adapter = execution_adapter
        self.state = state
        self.account_label = account_label
        self.sleep = sleep
        self._ledger_checked_at_monotonic: float | None = None
        self._ledger_stop_reason_cache: str | None = None
        self._ledger_client: RealTigerBeetleClient | None = None

    def close(self) -> None:
        client = self._ledger_client
        self._ledger_client = None
        if client is not None:
            client.close()

    def _check_ledger_protocol(self) -> TigerBeetleHealth:
        if not settings.tigerbeetle_enabled:
            return check_tigerbeetle_health(settings)
        if self._ledger_client is None:
            self._ledger_client = create_tigerbeetle_client(settings)
        health = check_tigerbeetle_health(settings, client=self._ledger_client)
        if not health.ok:
            self.close()
        return health

    def evaluate(self, session: Session, snapshot: PositionSnapshot) -> None:
        if settings.trading_mode != "live":
            self.state.capital_new_exposure_allowed = True
            return
        observed_at = getattr(snapshot, "as_of", None)
        now = (
            observed_at
            if isinstance(observed_at, datetime) and observed_at.tzinfo is not None
            else trading_now(account_label=self.account_label)
        )
        risk = self._load_risk_snapshot(session, snapshot=snapshot, now=now)
        self._record_risk_state(risk, now=now)

        local_time = now.astimezone(_NEW_YORK).time().replace(tzinfo=None)
        self.state.capital_new_exposure_allowed = bool(
            local_time < settings.trading_new_exposure_cutoff_time_et
            and not self.state.emergency_stop_active
        )
        stop_reason = self._equity_stop_reason(risk) or self._ledger_stop_reason(
            session,
            now=now,
        )
        if stop_reason is not None:
            self._latch_stop(stop_reason, now=now)
            self._flatten(reason=stop_reason, now=now)
            return
        if self.state.emergency_stop_active:
            self._flatten(
                reason=self.state.emergency_stop_reason or "emergency_stop",
                now=now,
            )
            return

        if local_time >= settings.trading_flatten_start_time_et:
            self.state.capital_new_exposure_allowed = False
            self._flatten(reason="scheduled_closeout", now=now)
        if local_time >= settings.trading_flat_confirmation_time_et:
            remaining = self._positions()
            if remaining:
                self._latch_stop("closeout_failed", now=now)
            else:
                self.state.capital_flat_confirmed_at = now

    def trigger_flatten(self, reason: str) -> None:
        """Latch a non-recoverable live safety event and flatten immediately."""

        now = trading_now(account_label=self.account_label)
        self._latch_stop(reason, now=now)
        self._flatten(reason=reason, now=now)

    def position_market_values(self, symbols: set[str]) -> dict[str, Decimal]:
        """Read signed broker market values for a bounded symbol set."""

        values = {symbol.strip().upper(): Decimal("0") for symbol in symbols}
        for position in self._positions():
            symbol = str(position.get("symbol") or "").strip().upper()
            if symbol not in values:
                continue
            value = self._decimal(position.get("market_value"))
            if value is None:
                qty = self._decimal(position.get("qty") or position.get("quantity"))
                price = self._decimal(position.get("current_price"))
                value = qty * price if qty is not None and price is not None else None
            if value is None:
                raise RuntimeError("pair_position_market_value_unavailable")
            side = str(position.get("side") or "").strip().lower()
            values[symbol] += -abs(value) if side == "short" else abs(value)
        return values

    @staticmethod
    def pair_delta_is_balanced(
        decisions: list[StrategyDecision],
        *,
        before: Mapping[str, Decimal],
        after: Mapping[str, Decimal],
    ) -> bool:
        long_delta = Decimal("0")
        short_delta = Decimal("0")
        for decision in decisions:
            symbol = decision.symbol.strip().upper()
            delta = after.get(symbol, Decimal("0")) - before.get(symbol, Decimal("0"))
            if decision.action == "buy":
                if delta <= 0:
                    return False
                long_delta += delta
            elif decision.action == "sell":
                if delta >= 0:
                    return False
                short_delta += abs(delta)
            else:
                return False
        tolerance = max(
            Decimal("1"),
            max(long_delta, short_delta)
            * Decimal(str(settings.trading_pair_delta_tolerance_bps))
            / Decimal("10000"),
        )
        return abs(long_delta - short_delta) <= tolerance

    def _load_risk_snapshot(
        self,
        session: Session,
        *,
        snapshot: PositionSnapshot,
        now: datetime,
    ) -> CapitalRiskSnapshot:
        session_open = regular_session_open_utc_for(now.astimezone(timezone.utc))
        daily_start = session.execute(
            select(PositionSnapshot.equity)
            .where(
                PositionSnapshot.alpaca_account_label == self.account_label,
                PositionSnapshot.as_of >= session_open,
            )
            .order_by(PositionSnapshot.as_of.asc())
            .limit(1)
        ).scalar_one_or_none()
        high_water = session.execute(
            select(func.max(PositionSnapshot.equity)).where(
                PositionSnapshot.alpaca_account_label == self.account_label
            )
        ).scalar_one_or_none()
        current_equity = Decimal(snapshot.equity)
        daily_start_equity = Decimal(daily_start or current_equity)
        high_water_equity = Decimal(high_water or current_equity)
        return CapitalRiskSnapshot(
            current_equity=current_equity,
            daily_start_equity=daily_start_equity,
            high_water_equity=high_water_equity,
            daily_loss_ratio=self._loss_ratio(daily_start_equity, current_equity),
            drawdown_ratio=self._loss_ratio(high_water_equity, current_equity),
        )

    @staticmethod
    def _loss_ratio(reference: Decimal, current: Decimal) -> Decimal:
        if reference <= 0 or current >= reference:
            return Decimal("0")
        return (reference - current) / reference

    def _equity_stop_reason(self, risk: CapitalRiskSnapshot) -> str | None:
        daily_limit = Decimal(str(settings.trading_daily_loss_stop_pct_equity))
        drawdown_limit = Decimal(
            str(settings.trading_persistent_drawdown_stop_pct_equity)
        )
        if risk.daily_loss_ratio >= daily_limit:
            return f"daily_loss_stop:{risk.daily_loss_ratio:.8f}"
        if risk.drawdown_ratio >= drawdown_limit:
            return f"persistent_drawdown_stop:{risk.drawdown_ratio:.8f}"
        return None

    def _ledger_stop_reason(self, session: Session, *, now: datetime) -> str | None:
        protocol_required = bool(settings.tigerbeetle_required)
        reconciliation_required = bool(settings.tigerbeetle_reconcile_required)
        if not protocol_required and not reconciliation_required:
            self.state.capital_ledger_state = "not_required"
            self.state.capital_ledger_reason = None
            return None
        monotonic_now = time_module.monotonic()
        if (
            self._ledger_checked_at_monotonic is not None
            and monotonic_now - self._ledger_checked_at_monotonic < 30
        ):
            return self._ledger_stop_reason_cache
        if protocol_required:
            try:
                protocol_health = self._check_ledger_protocol()
            except Exception as exc:
                logger.exception("TigerBeetle protocol safety check failed")
                reason = f"tigerbeetle_protocol_unavailable:{type(exc).__name__}"
                self._record_ledger_state(reason=reason, now=now)
                return reason
            if not protocol_health.enabled or not protocol_health.ok:
                reason = "tigerbeetle_protocol_unavailable"
                self._record_ledger_state(reason=reason, now=now)
                return reason
        if not reconciliation_required:
            self._record_ledger_state(reason=None, now=now)
            return None
        try:
            payload = latest_tigerbeetle_reconciliation_status_payload(
                session,
                cluster_id=settings.tigerbeetle_cluster_id,
            )
        except (SQLAlchemyError, RuntimeError, TypeError, ValueError) as exc:
            logger.exception("TigerBeetle reconciliation safety read failed")
            reason = f"tigerbeetle_reconciliation_unavailable:{type(exc).__name__}"
            self._record_ledger_state(reason=reason, now=now)
            return reason

        reason = self._tigerbeetle_reconciliation_reason(payload)
        self._record_ledger_state(reason=reason, now=now)
        return reason

    def _record_ledger_state(
        self,
        *,
        reason: str | None,
        now: datetime,
    ) -> None:
        self._ledger_checked_at_monotonic = time_module.monotonic()
        self._ledger_stop_reason_cache = reason
        self.state.capital_ledger_state = "current" if reason is None else "blocked"
        self.state.capital_ledger_reason = reason
        self.state.capital_ledger_checked_at = now

    @staticmethod
    def _tigerbeetle_reconciliation_reason(
        payload: Mapping[str, object] | None,
    ) -> str | None:
        if payload is None:
            return "tigerbeetle_reconciliation_missing"
        if bool(payload.get("reconciliation_stale")):
            return "tigerbeetle_reconciliation_stale"
        if payload.get("ok") is True:
            return None
        blockers = payload.get("blockers")
        if isinstance(blockers, list):
            blocker_values = cast(list[object], blockers)
            first = next(
                (str(item).strip() for item in blocker_values if str(item).strip()),
                "",
            )
            if first:
                return f"tigerbeetle_reconciliation_not_ok:{first}"
        return "tigerbeetle_reconciliation_not_ok"

    def _record_risk_state(
        self,
        risk: CapitalRiskSnapshot,
        *,
        now: datetime,
    ) -> None:
        self.state.capital_current_equity = str(risk.current_equity)
        self.state.capital_daily_start_equity = str(risk.daily_start_equity)
        self.state.capital_high_water_equity = str(risk.high_water_equity)
        self.state.capital_daily_loss_ratio = str(risk.daily_loss_ratio)
        self.state.capital_drawdown_ratio = str(risk.drawdown_ratio)
        self.state.capital_last_evaluated_at = now

    def _latch_stop(self, reason: str, *, now: datetime) -> None:
        existing = {
            item.strip()
            for item in str(self.state.emergency_stop_reason or "").split(";")
            if item.strip()
        }
        existing.add(reason)
        self.state.emergency_stop_active = True
        self.state.emergency_stop_reason = ";".join(sorted(existing))
        self.state.emergency_stop_triggered_at = (
            self.state.emergency_stop_triggered_at or now
        )
        self.state.capital_new_exposure_allowed = False
        self.state.last_error = f"capital_stop_triggered reason={reason}"
        logger.error(
            "Capital stop triggered account=%s reason=%s", self.account_label, reason
        )

    def _flatten(self, *, reason: str, now: datetime) -> None:
        if self.state.capital_closeout_in_progress:
            return
        self.state.capital_closeout_in_progress = True
        self.state.capital_closeout_reason = reason
        mutation_purpose: BrokerMutationPurpose = (
            "closeout" if reason == "scheduled_closeout" else "kill_switch"
        )
        try:
            self._cancel_open_orders(purpose=mutation_purpose)
            attempts = max(1, settings.trading_closeout_max_attempts)
            submitted_positions: tuple[tuple[str, str, Decimal], ...] | None = None
            for attempt in range(1, attempts + 1):
                positions = self._positions()
                if not positions:
                    self.state.capital_flat_confirmed_at = trading_now(
                        account_label=self.account_label
                    )
                    return
                observed_positions = self._closeout_position_state(positions)
                if submitted_positions is None:
                    self.execution_adapter.close_all_positions(purpose=mutation_purpose)
                    submitted_positions = observed_positions
                elif observed_positions != submitted_positions:
                    if not self._closeout_progressed(
                        before=submitted_positions,
                        after=observed_positions,
                    ):
                        raise RuntimeError("capital_closeout_position_progress_invalid")
                    self._cancel_open_orders(purpose=mutation_purpose)
                    self.execution_adapter.close_all_positions(purpose=mutation_purpose)
                    submitted_positions = observed_positions
                self.state.capital_closeout_attempts = attempt
                self.sleep(max(0.0, settings.trading_closeout_reprice_seconds))

            self._cancel_open_orders(purpose=mutation_purpose)
            if self._positions():
                self._latch_stop("closeout_failed", now=now)
        except (APIError, OSError, RuntimeError, TypeError, ValueError) as exc:
            self._latch_stop(f"closeout_error:{type(exc).__name__}", now=now)
            logger.exception("Capital closeout failed account=%s", self.account_label)
        finally:
            self.state.capital_closeout_in_progress = False

    @staticmethod
    def _closeout_position_state(
        positions: list[dict[str, object]],
    ) -> tuple[tuple[str, str, Decimal], ...]:
        state: list[tuple[str, str, Decimal]] = []
        seen_symbols: set[str] = set()
        for position in positions:
            symbol = str(position.get("symbol") or "").strip().upper()
            side = str(position.get("side") or "").strip().lower()
            qty = CapitalSafetyController._decimal(position.get("qty"))
            if not symbol or symbol in seen_symbols or side not in {"long", "short"}:
                raise RuntimeError("capital_closeout_position_identity_invalid")
            if qty is None or qty <= 0:
                raise RuntimeError("capital_closeout_position_quantity_invalid")
            seen_symbols.add(symbol)
            state.append((symbol, side, qty.normalize()))
        return tuple(sorted(state))

    @staticmethod
    def _closeout_progressed(
        *,
        before: tuple[tuple[str, str, Decimal], ...],
        after: tuple[tuple[str, str, Decimal], ...],
    ) -> bool:
        before_by_symbol = {
            symbol: (side, quantity) for symbol, side, quantity in before
        }
        progressed = len(after) < len(before)
        for symbol, side, quantity in after:
            previous = before_by_symbol.get(symbol)
            if previous is None or previous[0] != side or quantity > previous[1]:
                return False
            progressed = progressed or quantity < previous[1]
        return progressed

    def _positions(self) -> list[dict[str, object]]:
        raw_positions = self.execution_adapter.list_positions()
        if not isinstance(raw_positions, list):
            raise RuntimeError("capital_closeout_positions_unavailable")
        positions: list[dict[str, object]] = []
        for raw_position in cast(list[object], raw_positions):
            if not isinstance(raw_position, Mapping):
                raise RuntimeError("capital_closeout_position_invalid")
            position = {
                str(key): value
                for key, value in cast(Mapping[object, object], raw_position).items()
            }
            raw_qty = position.get("qty")
            if raw_qty is None:
                raw_qty = position.get("quantity")
            qty = self._decimal(raw_qty)
            if qty is None:
                raise RuntimeError("capital_closeout_position_quantity_invalid")
            if qty == 0:
                continue
            side = str(position.get("side") or "").strip().lower()
            if qty < 0:
                position["qty"] = str(abs(qty))
                position["side"] = "short"
            elif side not in {"long", "short"}:
                raise RuntimeError("capital_closeout_position_side_invalid")
            elif side == "short":
                position["qty"] = str(abs(qty))
            positions.append(position)
        return positions

    def _cancel_open_orders(self, *, purpose: BrokerMutationPurpose) -> None:
        self.execution_adapter.cancel_all_orders(purpose=purpose)
        list_orders = getattr(self.execution_adapter, "list_orders", None)
        if not callable(list_orders):
            raise RuntimeError("capital_closeout_order_read_unavailable")
        for confirmation_attempt in range(3):
            open_orders = list_orders(status="open")
            if not isinstance(open_orders, list):
                raise RuntimeError("capital_closeout_order_read_invalid")
            if not open_orders:
                return
            if confirmation_attempt < 2:
                self.sleep(0.1)
        raise RuntimeError("capital_closeout_cancel_unconfirmed")

    @staticmethod
    def _decimal(value: object) -> Decimal | None:
        try:
            parsed = Decimal(str(value))
        except (ArithmeticError, ValueError):
            return None
        return parsed if parsed.is_finite() else None


__all__ = ["CapitalRiskSnapshot", "CapitalSafetyController"]
