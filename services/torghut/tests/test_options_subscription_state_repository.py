from __future__ import annotations

from collections.abc import Mapping
from contextlib import AbstractContextManager, nullcontext
from datetime import UTC, datetime
from types import SimpleNamespace
from typing import cast

from sqlalchemy.orm import Session

from app.options_lane.subscription_state_repository import (
    reconcile_subscription_state,
)


class _RecordingSession:
    def __init__(self) -> None:
        self.deactivation_batches: list[list[str]] = []

    def begin(self) -> AbstractContextManager[None]:
        return nullcontext()

    def execute(
        self, _statement: object, parameters: Mapping[str, object]
    ) -> SimpleNamespace:
        symbols = parameters["symbols"]
        assert isinstance(symbols, list)
        assert all(isinstance(symbol, str) for symbol in symbols)
        self.deactivation_batches.append(symbols)
        return SimpleNamespace(rowcount=len(symbols))


def test_reconcile_chunks_large_deactivation_sets() -> None:
    session = _RecordingSession()
    symbols = {f"CONTRACT-{index:05d}" for index in range(2_501)}

    result = reconcile_subscription_state(
        cast(Session, session),
        ranked_rows=[],
        deactivate_symbols=symbols,
        observed_at=datetime(2026, 7, 14, tzinfo=UTC),
    )

    assert [len(batch) for batch in session.deactivation_batches] == [1_000, 1_000, 501]
    assert [
        symbol for batch in session.deactivation_batches for symbol in batch
    ] == sorted(symbols)
    assert result.deactivated_count == len(symbols)
