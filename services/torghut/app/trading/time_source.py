"""Shared runtime time source for live trading and historical replay."""

from __future__ import annotations

import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select

from ..config import settings
from ..db import SessionLocal
from ..models import TradeCursor

_SIMULATION_CURSOR_BASELINE = datetime(1970, 1, 1, tzinfo=timezone.utc)


def _parse_datetime(raw: str | None) -> datetime | None:
    value = (raw or "").strip()
    if not value:
        return None
    normalized = f"{value[:-1]}+00:00" if value.endswith("Z") else value
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


@dataclass(frozen=True)
class TradingTimeSnapshot:
    mode: str
    now: datetime
    source: str
    cursor_at: datetime | None = None

    def to_payload(self) -> dict[str, Any]:
        return {
            "mode": self.mode,
            "now": self.now.isoformat(),
            "source": self.source,
            "cursor_at": self.cursor_at.isoformat() if self.cursor_at is not None else None,
        }


class TradingTimeSource:
    """Resolve the authoritative trading timestamp for the current runtime."""

    def __init__(self) -> None:
        self._cache_by_account: dict[str, tuple[TradingTimeSnapshot, float]] = {}

    def now(self, *, account_label: str | None = None) -> datetime:
        return self.snapshot(account_label=account_label).now

    def monotonic(self, *, account_label: str | None = None) -> float:
        snapshot = self.snapshot(account_label=account_label)
        if snapshot.mode == "live":
            return time.monotonic()
        return snapshot.now.timestamp()

    def snapshot(self, *, account_label: str | None = None) -> TradingTimeSnapshot:
        mode = settings.trading_simulation_clock_mode
        if not settings.trading_simulation_enabled or mode == "live":
            now = datetime.now(timezone.utc)
            return TradingTimeSnapshot(mode="live", now=now, source="wall_clock")

        effective_account_label = self._effective_account_label(account_label=account_label)
        cache_ttl = max(settings.trading_simulation_clock_cache_seconds, 0)
        current_monotonic = time.monotonic()
        cached_entry = self._cache_by_account.get(effective_account_label)
        if cached_entry is not None and cache_ttl > 0:
            cached_snapshot, loaded_at = cached_entry
            if current_monotonic - loaded_at <= cache_ttl:
                return cached_snapshot

        resolved = self._resolve_simulation_snapshot(account_label=effective_account_label)
        self._cache_by_account[effective_account_label] = (resolved, current_monotonic)
        return resolved

    @staticmethod
    def _effective_account_label(*, account_label: str | None) -> str:
        account = (account_label or settings.trading_account_label).strip()
        return account or settings.trading_account_label

    def _resolve_simulation_snapshot(
        self, *, account_label: str | None = None
    ) -> TradingTimeSnapshot:
        start = _parse_datetime(settings.trading_simulation_window_start)
        account = self._effective_account_label(account_label=account_label)
        cursor_at = self._load_clickhouse_cursor(account_label=account)
        if cursor_at is not None:
            return TradingTimeSnapshot(
                mode="simulation_cursor",
                now=cursor_at,
                source="trade_cursor.clickhouse",
                cursor_at=cursor_at,
            )
        if start is not None:
            return TradingTimeSnapshot(
                mode="simulation_cursor",
                now=start,
                source="window_start",
                cursor_at=None,
            )
        now = datetime.now(timezone.utc)
        return TradingTimeSnapshot(
            mode="simulation_cursor",
            now=now,
            source="wall_clock_fallback",
            cursor_at=None,
        )

    @staticmethod
    def _load_clickhouse_cursor(*, account_label: str) -> datetime | None:
        with SessionLocal() as session:
            stmt = select(TradeCursor).where(
                TradeCursor.source == "clickhouse",
                TradeCursor.account_label == account_label,
            )
            row = session.execute(stmt).scalar_one_or_none()
            if row is None:
                return None
            cursor_at = row.cursor_at.astimezone(timezone.utc)
            if settings.trading_simulation_enabled and cursor_at <= _SIMULATION_CURSOR_BASELINE:
                return None
            return cursor_at


_TIME_SOURCE = TradingTimeSource()


def trading_now(*, account_label: str | None = None) -> datetime:
    return _TIME_SOURCE.now(account_label=account_label)


def trading_monotonic(*, account_label: str | None = None) -> float:
    return _TIME_SOURCE.monotonic(account_label=account_label)


def trading_time_status(*, account_label: str | None = None) -> dict[str, Any]:
    return _TIME_SOURCE.snapshot(account_label=account_label).to_payload()


__all__ = ["TradingTimeSource", "trading_monotonic", "trading_now", "trading_time_status"]
