from collections.abc import Iterator, Mapping
from contextlib import contextmanager, nullcontext
from datetime import UTC, datetime
import json
from types import SimpleNamespace
from typing import cast

from sqlalchemy.orm import Session

from app.options_lane.repository import OptionsRepository
from app.options_lane.snapshot_ranking import snapshot_ranking_inputs


class _RecordingSession:
    def __init__(self) -> None:
        self.statements: list[tuple[str, Mapping[str, object]]] = []

    def begin(self) -> nullcontext[None]:
        return nullcontext()

    def execute(
        self,
        statement: object,
        parameters: Mapping[str, object],
    ) -> SimpleNamespace:
        self.statements.append((str(statement), parameters))
        return SimpleNamespace(rowcount=1)


class _RecordingRepository(OptionsRepository):
    def __init__(self, session: _RecordingSession) -> None:
        self._recording_session = session

    @contextmanager
    def session(self) -> Iterator[Session]:
        yield cast(Session, self._recording_session)


def test_snapshot_ranking_inputs_do_not_overwrite_catalog_liquidity() -> None:
    inputs = snapshot_ranking_inputs(
        {
            "latest_trade_ts": datetime(2026, 7, 15, 14, 0, tzinfo=UTC),
            "latest_quote_ts": datetime(2026, 7, 15, 14, 0, tzinfo=UTC),
            "latest_bid_size": 20,
            "latest_ask_size": 30,
        }
    )

    assert inputs == {
        "trade_recency_score": 1.0,
        "quote_recency_score": 1.0,
    }
    assert "liquidity_score" not in inputs


def test_snapshot_persistence_skips_unchanged_subscription_inputs() -> None:
    session = _RecordingSession()
    repository = _RecordingRepository(session)
    ranking_inputs = {
        "trade_recency_score": 1.0,
        "quote_recency_score": 1.0,
    }

    repository.record_snapshot_success(
        contract_symbol="AMD260715C00300000",
        snapshot_class="hot",
        observed_at=datetime(2026, 7, 15, 14, 0, tzinfo=UTC),
        ranking_inputs=ranking_inputs,
    )

    assert len(session.statements) == 2
    subscription_sql, subscription_parameters = session.statements[1]
    assert "ON CONFLICT (contract_symbol) DO UPDATE" in subscription_sql
    assert "IS DISTINCT FROM" in subscription_sql
    assert "|| EXCLUDED.ranking_inputs" in subscription_sql
    assert (
        json.loads(cast(str, subscription_parameters["ranking_inputs"]))
        == ranking_inputs
    )
