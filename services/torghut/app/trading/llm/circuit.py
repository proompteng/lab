"""Simple circuit breaker for LLM failures."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any

from ...config import settings


def _error_list() -> list[datetime]:
    return []


@dataclass
class LLMCircuitBreaker:
    max_errors: int
    window_seconds: int
    cooldown_seconds: int
    _errors: list[datetime] = field(default_factory=_error_list)
    _open_until: datetime | None = None
    _opened_at: datetime | None = None

    @classmethod
    def from_settings(cls) -> "LLMCircuitBreaker":
        return cls(
            max_errors=settings.llm_circuit_max_errors,
            window_seconds=settings.llm_circuit_window_seconds,
            cooldown_seconds=settings.llm_circuit_cooldown_seconds,
        )

    def record_error(self) -> None:
        now = datetime.now(timezone.utc)
        self._errors.append(now)
        self._prune(now)
        if len(self._errors) >= self.max_errors:
            if self._open_until is None or now >= self._open_until:
                self._opened_at = now
            self._open_until = now + timedelta(seconds=self.cooldown_seconds)

    def record_success(self) -> None:
        now = datetime.now(timezone.utc)
        self._prune(now)

    def is_open(self) -> bool:
        now = datetime.now(timezone.utc)
        if self._open_until and now < self._open_until:
            return True
        if self._open_until and now >= self._open_until:
            self._open_until = None
            self._opened_at = None
        return False

    def _prune(self, now: datetime) -> None:
        window_start = now - timedelta(seconds=self.window_seconds)
        self._errors = [ts for ts in self._errors if ts >= window_start]

    def snapshot(self) -> dict[str, Any]:
        now = datetime.now(timezone.utc)
        open_now = self.is_open()
        cooldown_remaining_seconds = 0
        if self._open_until and open_now:
            cooldown_remaining_seconds = max(
                0, int((self._open_until - now).total_seconds())
            )
        open_seconds = 0
        if self._opened_at and open_now:
            open_seconds = max(0, int((now - self._opened_at).total_seconds()))
        return {
            "open": open_now,
            "open_until": self._open_until,
            "opened_at": self._opened_at,
            "max_errors": self.max_errors,
            "window_seconds": self.window_seconds,
            "cooldown_seconds": self.cooldown_seconds,
            "cooldown_remaining_seconds": cooldown_remaining_seconds,
            "open_seconds": open_seconds,
            "recent_error_count": len(self._errors),
        }


__all__ = ["LLMCircuitBreaker"]
