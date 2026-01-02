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
        return False

    def _prune(self, now: datetime) -> None:
        window_start = now - timedelta(seconds=self.window_seconds)
        self._errors = [ts for ts in self._errors if ts >= window_start]

    def snapshot(self) -> dict[str, Any]:
        return {
            "open": self.is_open(),
            "open_until": self._open_until,
            "max_errors": self.max_errors,
            "window_seconds": self.window_seconds,
            "cooldown_seconds": self.cooldown_seconds,
            "recent_error_count": len(self._errors),
        }


__all__ = ["LLMCircuitBreaker"]
