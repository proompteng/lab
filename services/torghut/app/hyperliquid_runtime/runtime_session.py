"""Session contract used by the isolated Hyperliquid runtime lane."""

from __future__ import annotations

from typing import Any, Protocol


class RuntimeSession(Protocol):
    """Small SQLAlchemy session surface required by one runtime cycle."""

    def execute(self, statement: Any, params: Any | None = None) -> Any:
        """Execute a SQL statement."""
        ...

    def commit(self) -> None:
        """Commit the current transaction."""
        ...


__all__ = ["RuntimeSession"]
