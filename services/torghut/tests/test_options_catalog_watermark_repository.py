from __future__ import annotations

from contextlib import AbstractContextManager, nullcontext
from datetime import UTC, datetime
import json
from typing import cast

from sqlalchemy.orm import Session

from app.options_lane.catalog_watermark_repository import (
    CatalogCycleSummary,
    record_catalog_cycle_success,
)


class _RecordingSession:
    def __init__(self) -> None:
        self.statement = ""
        self.parameters: dict[str, object] = {}

    def begin(self) -> AbstractContextManager[None]:
        return nullcontext()

    def execute(self, statement: object, parameters: dict[str, object]) -> None:
        self.statement = str(statement)
        self.parameters = parameters


def test_catalog_success_uses_one_cycle_watermark() -> None:
    session = _RecordingSession()
    observed_at = datetime(2026, 7, 14, 6, 30, tzinfo=UTC)

    record_catalog_cycle_success(
        cast(Session, session),
        CatalogCycleSummary(
            observed_at=observed_at,
            page_count=3,
            contract_count=250,
            catalog_changed_count=2,
            transition_count=1,
            hot_count=160,
            warm_count=800,
            subscription_changed_count=4,
            subscription_deactivated_count=3,
        ),
    )

    assert "'catalog'" in session.statement
    assert "'universe'" in session.statement
    assert "'live'" in session.statement
    assert "last_success_ts = EXCLUDED.last_success_ts" in session.statement
    assert session.parameters["observed_at"] == observed_at
    metadata = json.loads(cast(str, session.parameters["metadata"]))
    assert metadata["contract_count"] == 250
    assert metadata["subscription_changed_count"] == 4
