"""Shared helpers for simulation-window bounded runtime behavior."""

from __future__ import annotations

from datetime import datetime, timezone

from ..config import settings
from .simulation_progress import active_simulation_runtime_context


def _parse_datetime(raw: str | None) -> datetime | None:
    value = (raw or '').strip()
    if not value:
        return None
    normalized = f'{value[:-1]}+00:00' if value.endswith('Z') else value
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def simulation_window_bounds() -> tuple[datetime | None, datetime | None]:
    if not settings.trading_simulation_enabled:
        return None, None
    runtime_context = active_simulation_runtime_context()
    start = _parse_datetime(
        (runtime_context or {}).get('window_start') or settings.trading_simulation_window_start
    )
    end = _parse_datetime(
        (runtime_context or {}).get('window_end') or settings.trading_simulation_window_end
    )
    if start is not None and end is not None and end < start:
        end = start
    return start, end


def normalize_simulation_cursor(cursor_at: datetime | None) -> datetime | None:
    if cursor_at is None:
        return None
    start, end = simulation_window_bounds()
    if start is not None and cursor_at < start:
        return start
    if end is not None and cursor_at > end:
        return start or end
    return cursor_at


__all__ = ['normalize_simulation_cursor', 'simulation_window_bounds']
