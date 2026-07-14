from __future__ import annotations

from collections.abc import Iterator, Mapping, Sequence
from contextlib import contextmanager, nullcontext
from datetime import UTC, date, datetime, timedelta
import json
from typing import cast

import pytest
from sqlalchemy.orm import Session

from app.options_lane.alpaca import normalize_contract_record
from app.options_lane.catalog_scope import OptionsCatalogScope
from app.options_lane.repository import OptionsRepository


class _RowsResult:
    def __init__(self, rows: Sequence[Mapping[str, object]] = ()) -> None:
        self._rows = [dict(row) for row in rows]

    def mappings(self) -> _RowsResult:
        return self

    def __iter__(self) -> Iterator[dict[str, object]]:
        return iter(self._rows)


class _CatalogSession:
    def __init__(
        self,
        *,
        existing_rows: Sequence[Mapping[str, object]] = (),
        transition_rows: Sequence[Mapping[str, object]] = (),
        expired_transition_rows: Sequence[Mapping[str, object]] = (),
    ) -> None:
        self.existing_rows = existing_rows
        self.transition_rows = transition_rows
        self.expired_transition_rows = expired_transition_rows
        self.calls: list[tuple[str, object]] = []

    def begin(self) -> object:
        return nullcontext()

    def execute(self, statement: object, parameters: object = None) -> _RowsResult:
        sql = str(statement)
        self.calls.append((sql, parameters))
        if "SELECT catalog.*" in sql and "contract_symbol = ANY" in sql:
            return _RowsResult(self.existing_rows)
        if "WITH expired_batch AS" in sql:
            return _RowsResult(self.expired_transition_rows)
        if "RETURNING catalog.*" in sql:
            return _RowsResult(self.transition_rows)
        return _RowsResult()


class _CatalogRepository(OptionsRepository):
    def __init__(self, session: _CatalogSession) -> None:
        self.fake_session = session

    @contextmanager
    def session(self) -> Iterator[Session]:
        yield cast(Session, self.fake_session)


def _contract(
    symbol: str, *, observed_at: datetime, open_interest: int
) -> dict[str, object]:
    underlying = symbol.split("2", maxsplit=1)[0]
    return normalize_contract_record(
        {
            "id": f"id-{symbol}",
            "symbol": symbol,
            "status": "active",
            "tradable": True,
            "expiration_date": "2026-07-17",
            "root_symbol": underlying,
            "underlying_symbol": underlying,
            "underlying_asset_id": f"asset-{underlying}",
            "type": "call",
            "style": "american",
            "strike_price": "200",
            "size": "100",
            "open_interest": str(open_interest),
        },
        observed_at=observed_at,
    )


def _scope() -> OptionsCatalogScope:
    return OptionsCatalogScope(
        underlying_symbols=("msft", "AAPL", "AAPL"),
        expiration_date_gte=date(2026, 7, 14),
        expiration_date_lte=date(2026, 11, 11),
    )


def _persisted_contract_row(contract: Mapping[str, object]) -> dict[str, object]:
    columns = {
        "contract_symbol",
        "contract_id",
        "root_symbol",
        "underlying_symbol",
        "expiration_date",
        "strike_price",
        "option_type",
        "style",
        "contract_size",
        "status",
        "tradable",
        "open_interest",
        "open_interest_date",
        "close_price",
        "close_price_date",
        "provider_updated_ts",
        "first_seen_ts",
        "last_seen_ts",
        "metadata",
    }
    return {key: value for key, value in contract.items() if key in columns}


def test_catalog_scope_normalizes_and_rejects_unbounded_universe() -> None:
    assert _scope().underlying_symbols == ("AAPL", "MSFT")
    with pytest.raises(ValueError, match="must not be empty"):
        OptionsCatalogScope(
            underlying_symbols=("",),
            expiration_date_gte=date(2026, 7, 14),
            expiration_date_lte=date(2026, 11, 11),
        )


def test_unchanged_catalog_page_performs_no_upsert_or_publication() -> None:
    observed_at = datetime(2026, 7, 14, 15, tzinfo=UTC)
    contract = _contract(
        "AAPL260717C00200000", observed_at=observed_at, open_interest=42
    )
    existing = _persisted_contract_row(contract)
    existing["first_seen_ts"] = observed_at - timedelta(days=1)
    existing["last_seen_ts"] = observed_at - timedelta(minutes=5)
    session = _CatalogSession(existing_rows=[existing])
    repository = _CatalogRepository(session)

    assert (
        repository.sync_contract_catalog_page([contract], observed_at=observed_at) == []
    )

    assert len(session.calls) == 3
    assert "pg_advisory_xact_lock" in session.calls[0][0]
    assert "SELECT catalog.*" in session.calls[1][0]
    assert "DELETE FROM torghut_options_contract_archive_status" in session.calls[2][0]


def test_seen_catalog_row_clears_archive_overlay_and_publishes_reactivation() -> None:
    observed_at = datetime(2026, 7, 14, 15, tzinfo=UTC)
    contract = _contract(
        "AAPL260717C00200000", observed_at=observed_at, open_interest=42
    )
    existing = _persisted_contract_row(contract)
    existing["first_seen_ts"] = observed_at - timedelta(days=1)
    existing["last_seen_ts"] = observed_at - timedelta(minutes=5)
    existing["archive_status_symbol"] = contract["contract_symbol"]
    session = _CatalogSession(existing_rows=[existing])
    repository = _CatalogRepository(session)

    changed_rows = repository.sync_contract_catalog_page(
        [contract], observed_at=observed_at
    )

    assert [row["contract_symbol"] for row in changed_rows] == ["AAPL260717C00200000"]
    assert changed_rows[0]["status"] == "active"
    assert not any("jsonb_to_recordset" in sql for sql, _ in session.calls)
    delete_sql, delete_parameters = session.calls[-1]
    assert "DELETE FROM torghut_options_contract_archive_status" in delete_sql
    assert delete_parameters == {"symbols": ["AAPL260717C00200000"]}


def test_catalog_upserts_changed_rows_in_stable_order_with_database_guard() -> None:
    observed_at = datetime(2026, 7, 14, 15, tzinfo=UTC)
    contracts = [
        _contract("MSFT260717C00400000", observed_at=observed_at, open_interest=10),
        _contract("AAPL260717C00200000", observed_at=observed_at, open_interest=20),
    ]
    session = _CatalogSession()
    repository = _CatalogRepository(session)

    changed_rows = repository.sync_contract_catalog_page(
        contracts, observed_at=observed_at
    )

    assert [row["contract_symbol"] for row in changed_rows] == [
        "AAPL260717C00200000",
        "MSFT260717C00400000",
    ]
    insert_sql, insert_parameters = session.calls[2]
    assert "jsonb_to_recordset" in insert_sql
    assert "IS DISTINCT FROM" in insert_sql
    assert isinstance(insert_parameters, dict)
    serialized_rows = json.loads(str(insert_parameters["rows"]))
    assert [row["contract_symbol"] for row in serialized_rows] == [
        "AAPL260717C00200000",
        "MSFT260717C00400000",
    ]


def test_missing_contract_transition_is_scoped_to_exact_completed_scan() -> None:
    observed_at = datetime(2026, 7, 14, 15, tzinfo=UTC)
    session = _CatalogSession(
        transition_rows=[
            {
                "contract_symbol": "AAPL260717P00190000",
                "status": "inactive",
                "expiration_date": date(2026, 7, 17),
            }
        ],
        expired_transition_rows=[
            {
                "contract_symbol": "AAPL260710P00190000",
                "status": "expired",
                "expiration_date": date(2026, 7, 10),
            }
        ],
    )
    repository = _CatalogRepository(session)

    rows = repository.mark_contracts_missing_from_cycle(
        observed_at=observed_at,
        scope=_scope(),
        seen_symbols={"MSFT260717C00400000", "AAPL260717C00200000"},
    )

    assert rows[0]["catalog_status_reason"] == "not_seen_in_active_discovery_run"
    assert rows[1]["catalog_status_reason"] == "expired_below_live_discovery_window"
    assert (
        "CREATE TEMPORARY TABLE options_catalog_seen_contracts" in session.calls[0][0]
    )
    assert session.calls[1][1] == {
        "seen_symbols": ["AAPL260717C00200000", "MSFT260717C00400000"]
    }
    transition_sql, transition_parameters = session.calls[2]
    assert "catalog.underlying_symbol = ANY(:underlying_symbols)" in transition_sql
    assert "catalog.expiration_date BETWEEN :expiration_date_gte" in transition_sql
    assert "AND :expiration_date_lte" in transition_sql
    assert "catalog.expiration_date < :expiration_date_gte" not in transition_sql
    assert "NOT EXISTS" in transition_sql
    assert "last_seen_ts <" not in transition_sql
    assert transition_parameters == {
        "observed_at": observed_at,
        **_scope().query_parameters,
    }
    expired_sql, expired_parameters = session.calls[3]
    assert "WITH expired_batch AS" in expired_sql
    assert "LIMIT :expired_cleanup_limit" in expired_sql
    assert "FOR UPDATE SKIP LOCKED" in expired_sql
    assert expired_parameters == {
        "observed_at": observed_at,
        "underlying_symbols": ["AAPL", "MSFT"],
        "expiration_date_gte": date(2026, 7, 14),
        "expired_cleanup_limit": 1000,
    }


def test_missing_contract_transition_fails_closed_on_empty_seen_set() -> None:
    repository = _CatalogRepository(_CatalogSession())

    with pytest.raises(ValueError, match="must contain contracts"):
        repository.mark_contracts_missing_from_cycle(
            observed_at=datetime(2026, 7, 14, 15, tzinfo=UTC),
            scope=_scope(),
            seen_symbols=set(),
        )
