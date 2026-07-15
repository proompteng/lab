"""Shared lightweight runtime-surface test values."""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from datetime import datetime, timezone


class _FakeResult:
    def __init__(self, rows: Iterable[Mapping[str, object]]) -> None:
        self.rows = [dict(row) for row in rows]

    def mappings(self) -> "_FakeResult":
        return self

    def __iter__(self) -> Iterable[dict[str, object]]:
        return iter(self.rows)

    def one(self) -> dict[str, object]:
        return self.rows[0]

    def all(self) -> list[dict[str, object]]:
        return self.rows

    def scalar_one_or_none(self) -> object | None:
        if not self.rows:
            return None
        if len(self.rows) != 1 or len(self.rows[0]) != 1:
            raise AssertionError("fake scalar result is not exactly one value")
        return next(iter(self.rows[0].values()))


def _now() -> datetime:
    return datetime(2026, 6, 19, 12, tzinfo=timezone.utc)
