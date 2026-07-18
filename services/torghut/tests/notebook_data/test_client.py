from __future__ import annotations

import io
import json
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Mapping
from uuid import UUID

import pytest

from app.notebook_data import (
    MAX_PROJECTED_ROWS,
    FixtureDataAdapter,
    LiveDataAdapter,
    NotebookDataError,
    Window,
    adapter_from_environment,
    capital_authority,
    execution_evidence,
    flow_snapshot,
    mode_banner,
    strategy_lifecycle,
)
from app.notebook_data.fixtures import FIXTURE_AS_OF, fixture_query
from app.notebook_data.models import QueryResult
from app.notebook_data.queries import (
    ALL_QUERIES,
    DECISION_STATUS_QUERY,
    EQUITIES_FLOW_QUERY,
    EXECUTION_LINK_QUERY,
    FORBIDDEN_PROJECTIONS,
    HYPERLIQUID_FLOW_QUERY,
    LEDGER_EVIDENCE_QUERY,
    OPTIONS_FLOW_QUERY,
    TCA_EVIDENCE_QUERY,
    assert_query_contract,
)


@dataclass
class EmptyEquitiesAdapter:
    mode: str = "fixture"

    def postgres(
        self,
        query_identifier: str,
        sql: str,
        parameters: Mapping[str, object],
        *,
        row_limit: int = MAX_PROJECTED_ROWS,
    ) -> QueryResult:
        return fixture_query(query_identifier, parameters, row_limit=row_limit)

    def clickhouse(
        self,
        query_identifier: str,
        sql: str,
        parameters: Mapping[str, object],
        *,
        row_limit: int = MAX_PROJECTED_ROWS,
    ) -> QueryResult:
        del query_identifier, sql, parameters, row_limit
        return QueryResult((), FIXTURE_AS_OF)

    def status(self, query_identifier: str) -> QueryResult:
        return fixture_query(query_identifier, {}, row_limit=1)


@dataclass
class InvalidSchemaAdapter(EmptyEquitiesAdapter):
    def clickhouse(
        self,
        query_identifier: str,
        sql: str,
        parameters: Mapping[str, object],
        *,
        row_limit: int = MAX_PROJECTED_ROWS,
    ) -> QueryResult:
        del query_identifier, sql, parameters, row_limit
        return QueryResult(({"symbol": "AAPL"},), FIXTURE_AS_OF)


@dataclass
class StatusUnavailableAdapter(EmptyEquitiesAdapter):
    def clickhouse(
        self,
        query_identifier: str,
        sql: str,
        parameters: Mapping[str, object],
        *,
        row_limit: int = MAX_PROJECTED_ROWS,
    ) -> QueryResult:
        del sql
        return fixture_query(query_identifier, parameters, row_limit=row_limit)

    def status(self, query_identifier: str) -> QueryResult:
        raise NotebookDataError(f"{query_identifier} is unavailable")


@dataclass
class NewerStatusWatermarkAdapter(StatusUnavailableAdapter):
    def status(self, query_identifier: str) -> QueryResult:
        result = fixture_query(query_identifier, {}, row_limit=1)
        return QueryResult(result.records, FIXTURE_AS_OF + timedelta(days=1))


@dataclass
class StrategyScopedExecutionAdapter(EmptyEquitiesAdapter):
    def postgres(
        self,
        query_identifier: str,
        sql: str,
        parameters: Mapping[str, object],
        *,
        row_limit: int = MAX_PROJECTED_ROWS,
    ) -> QueryResult:
        if query_identifier == "execution.ledger":
            raise AssertionError(
                "strategy-scoped execution evidence queried an all-strategy ledger"
            )
        return fixture_query(query_identifier, parameters, row_limit=row_limit)


def _live_adapter() -> LiveDataAdapter:
    return LiveDataAdapter(
        postgres_host="postgres.example",
        postgres_port=5432,
        postgres_database="torghut",
        postgres_user="torghut_notebook",
        postgres_password="read-only",
        clickhouse_url="http://clickhouse.example:8123",
        clickhouse_database="torghut",
        clickhouse_user="torghut_notebook",
        clickhouse_password="read-only",
        status_url="http://torghut-scheduler/trading/status",
    )


def test_window_hard_caps_and_timezone_contract() -> None:
    assert Window.sessions(5).value == 5
    assert Window.minutes(360).value == 360
    assert Window.days(180).value == 180

    with pytest.raises(ValueError, match="hard maximum"):
        Window.sessions(6)
    with pytest.raises(ValueError, match="hard maximum"):
        Window.minutes(361)
    with pytest.raises(ValueError, match="hard maximum"):
        Window.days(181)
    with pytest.raises(ValueError, match="timezone-aware"):
        Window.days(1, as_of=datetime(2026, 7, 17))


def test_queries_are_bounded_and_never_project_wide_payloads() -> None:
    for identifier, sql in ALL_QUERIES.items():
        assert_query_contract(identifier, sql)
        normalized = sql.lower()
        assert "select *" not in normalized
        assert "limit" in normalized
        for field in FORBIDDEN_PROJECTIONS:
            assert field not in normalized


def test_queries_use_source_native_parameter_binding() -> None:
    for sql in (
        DECISION_STATUS_QUERY,
        EXECUTION_LINK_QUERY,
        TCA_EVIDENCE_QUERY,
        LEDGER_EVIDENCE_QUERY,
    ):
        assert "%(start)s" in sql
        assert "%(end)s" in sql
        assert "%(limit)s" in sql
    for sql in (EQUITIES_FLOW_QUERY, OPTIONS_FLOW_QUERY, HYPERLIQUID_FLOW_QUERY):
        assert "{as_of:DateTime64(3, 'UTC')}" in sql
        assert "{limit:UInt32}" in sql


def test_execution_lineage_counts_only_verified_decision_joins_as_linked() -> None:
    normalized = " ".join(EXECUTION_LINK_QUERY.split())
    assert (
        "LEFT JOIN trade_decisions AS td ON td.id = e.trade_decision_id" in normalized
    )
    assert "count(*) FILTER (WHERE td.id IS NULL)" in normalized
    assert "count(*) FILTER (WHERE td.id IS NOT NULL)" in normalized


def test_hyperliquid_query_deduplicates_latest_interval_version() -> None:
    normalized = " ".join(HYPERLIQUID_FLOW_QUERY.split())
    assert "FROM torghut.hyperliquid_ta_features" in normalized
    assert "hyperliquid_bbo" not in normalized
    for field in (
        "price",
        "regime",
        "source_lag_seconds",
        "momentum_5m_bps",
        "volatility_bps",
        "spread_bps",
    ):
        assert f"argMax({field}, ingest_ts)" in normalized
    assert "GROUP BY network, market_id, coin, dex, interval, event_ts" in normalized


def test_fixture_flow_snapshots_have_exact_schemas_and_provenance() -> None:
    adapter = FixtureDataAdapter()
    for lane, window, expected_quality in (
        ("equities", Window.sessions(as_of=FIXTURE_AS_OF), "expected_idle"),
        ("options", Window.minutes(60, as_of=FIXTURE_AS_OF), "expected_idle"),
        ("hyperliquid", Window.minutes(30, as_of=FIXTURE_AS_OF), "ok"),
    ):
        snapshot = flow_snapshot(lane, window, adapter=adapter)
        assert snapshot.quality == expected_quality
        assert snapshot.row_count == len(snapshot.datasets[lane])
        assert snapshot.source_watermark == FIXTURE_AS_OF
        assert snapshot.truncated is False
        assert not snapshot.frame(lane).empty
        assert snapshot.effective_window["source_event_start"]
        assert snapshot.effective_window["source_event_end"]


def test_market_closed_without_rows_is_expected_idle() -> None:
    snapshot = flow_snapshot(
        "equities",
        Window.sessions(as_of=FIXTURE_AS_OF),
        adapter=EmptyEquitiesAdapter(),
    )
    assert snapshot.quality == "expected_idle"
    assert "market is closed" in snapshot.messages[0]


def test_schema_drift_is_unavailable_not_synthetic() -> None:
    snapshot = flow_snapshot(
        "equities",
        Window.sessions(as_of=FIXTURE_AS_OF),
        adapter=InvalidSchemaAdapter(),
    )
    assert snapshot.quality == "unavailable"
    assert snapshot.datasets == {}
    assert "schema mismatch" in snapshot.messages[0]
    assert "No fixture or synthetic rows were substituted." in snapshot.messages


def test_flow_data_remains_visible_when_runtime_status_is_unavailable() -> None:
    snapshot = flow_snapshot(
        "hyperliquid",
        Window.minutes(30, as_of=FIXTURE_AS_OF),
        adapter=StatusUnavailableAdapter(),
    )
    assert snapshot.quality == "ok"
    assert snapshot.row_count == len(snapshot.datasets["hyperliquid"])
    assert snapshot.datasets["runtime_status"] == ()
    assert snapshot.source_watermark == FIXTURE_AS_OF
    assert any("Runtime status unavailable" in message for message in snapshot.messages)


def test_auxiliary_status_watermark_does_not_mask_flow_freshness() -> None:
    snapshot = flow_snapshot(
        "hyperliquid",
        Window.minutes(30, as_of=FIXTURE_AS_OF),
        adapter=NewerStatusWatermarkAdapter(),
    )
    assert snapshot.source_watermark == FIXTURE_AS_OF


def test_lifecycle_keeps_unlinked_executions_and_rejections_separate() -> None:
    snapshot = strategy_lifecycle(
        None,
        Window.days(30, as_of=FIXTURE_AS_OF),
        adapter=FixtureDataAdapter(),
    )
    execution_links = snapshot.frame("execution_links")
    rejections = snapshot.frame("rejection_reasons")
    assert execution_links["unlinked_execution_count"].sum() == 1
    assert "reject_reason" in rejections.columns
    assert "strategy_id" not in rejections.columns
    assert any(
        "no proven signal-to-decision key" in message for message in snapshot.messages
    )


def test_missing_current_ledger_never_becomes_zero_pnl() -> None:
    snapshot = execution_evidence(
        None,
        Window.days(30, as_of=FIXTURE_AS_OF),
        adapter=FixtureDataAdapter(),
    )
    state = snapshot.datasets["ledger_state"][0]
    assert state["current_profitability_proven"] is False
    assert "CURRENT PROFITABILITY UNPROVEN" in state["message"]
    assert set(snapshot.frame("runtime_ledger")["observed_stage"]) == {"paper"}


def test_strategy_scoped_execution_omits_unlinked_all_strategy_ledger() -> None:
    strategy_id = UUID("11111111-1111-1111-1111-111111111111")
    snapshot = execution_evidence(
        strategy_id,
        Window.days(30, as_of=FIXTURE_AS_OF),
        adapter=StrategyScopedExecutionAdapter(),
    )
    assert snapshot.datasets["runtime_ledger"] == ()
    assert not snapshot.frame("tca").empty
    state = snapshot.datasets["ledger_state"][0]
    assert state["ledger_included"] is False
    assert state["strategy_id"] == str(strategy_id)
    assert "STRATEGY-SCOPED LEDGER EVIDENCE UNAVAILABLE" in state["message"]


def test_execution_evidence_survives_auxiliary_status_failure() -> None:
    snapshot = execution_evidence(
        None,
        Window.days(30, as_of=FIXTURE_AS_OF),
        adapter=StatusUnavailableAdapter(),
    )
    assert snapshot.quality == "ok"
    assert not snapshot.frame("tca").empty
    assert not snapshot.frame("runtime_ledger").empty
    assert snapshot.datasets["runtime_status"] == ()
    assert any("Runtime status unavailable" in message for message in snapshot.messages)


def test_accounting_parity_does_not_override_final_action_authority() -> None:
    snapshot = capital_authority(adapter=FixtureDataAdapter())
    components = {row["component"]: row for row in snapshot.datasets["components"]}
    assert components["TigerBeetle parity"]["authority_value"] is True
    assert components["broker reconciliation"]["authority_value"] is True
    assert components["final action authority"]["authority_value"] is False
    assert components["final action authority"]["authoritative"] is True


def test_fixture_adapter_rejects_row_cap_breach() -> None:
    adapter = FixtureDataAdapter()
    with pytest.raises(ValueError, match="row_limit"):
        adapter.postgres(
            "lifecycle.decisions",
            DECISION_STATUS_QUERY,
            {},
            row_limit=MAX_PROJECTED_ROWS + 1,
        )


def test_live_adapter_never_activates_without_all_read_only_configuration(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    for name in (
        "PGHOST",
        "PGDATABASE",
        "PGUSER",
        "PGPASSWORD",
        "CLICKHOUSE_URL",
        "CLICKHOUSE_USER",
        "CLICKHOUSE_PASSWORD",
        "TORGHUT_STATUS_URL",
    ):
        monkeypatch.delenv(name, raising=False)
    with pytest.raises(NotebookDataError, match="configuration is incomplete"):
        LiveDataAdapter.from_environment()


def test_adapter_environment_selects_only_explicit_live_or_fixture_modes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    environment = {
        "PGHOST": "postgres.example",
        "PGDATABASE": "torghut",
        "PGUSER": "torghut_notebook",
        "PGPASSWORD": "read-only",
        "CLICKHOUSE_URL": "http://clickhouse.example:8123/",
        "CLICKHOUSE_USER": "torghut_notebook",
        "CLICKHOUSE_PASSWORD": "read-only",
        "TORGHUT_STATUS_URL": "http://torghut-scheduler/trading/status",
    }
    for name, value in environment.items():
        monkeypatch.setenv(name, value)

    monkeypatch.setenv("TORGHUT_NOTEBOOK_DATA_MODE", "live")
    live = adapter_from_environment()
    assert isinstance(live, LiveDataAdapter)
    assert live.clickhouse_url == "http://clickhouse.example:8123"
    assert "LIVE MODE" in mode_banner(live)

    monkeypatch.setenv("TORGHUT_NOTEBOOK_DATA_MODE", "fixture")
    fixture = adapter_from_environment()
    assert isinstance(fixture, FixtureDataAdapter)
    assert "FIXTURE MODE" in mode_banner(fixture)

    monkeypatch.setenv("TORGHUT_NOTEBOOK_DATA_MODE", "automatic")
    with pytest.raises(NotebookDataError, match="exactly 'live' or 'fixture'"):
        adapter_from_environment()


def test_live_clickhouse_and_status_reads_are_bounded_and_typed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    adapter = _live_adapter()
    requests: list[urllib.request.Request] = []

    def clickhouse_response(
        request: urllib.request.Request, *, timeout: int
    ) -> io.BytesIO:
        assert timeout == 35
        requests.append(request)
        payload = {
            "data": [
                {
                    "coin": "BTC",
                    "latest_ingest_ts": FIXTURE_AS_OF.isoformat(),
                }
            ]
        }
        return io.BytesIO(json.dumps(payload).encode())

    monkeypatch.setattr(urllib.request, "urlopen", clickhouse_response)
    result = adapter.clickhouse(
        "flow.hyperliquid",
        HYPERLIQUID_FLOW_QUERY,
        {"as_of": FIXTURE_AS_OF, "minutes": 30},
        row_limit=10,
    )
    assert result.records[0]["coin"] == "BTC"
    assert result.watermark == FIXTURE_AS_OF
    assert result.truncated is False
    assert requests[0].method == "POST"
    assert "database=torghut" in requests[0].full_url
    assert "param_limit=10" in requests[0].full_url
    for profile_setting in (
        "readonly",
        "max_execution_time",
        "max_result_rows",
        "result_overflow_mode",
        "max_memory_usage",
        "max_threads",
    ):
        assert f"{profile_setting}=" not in requests[0].full_url
    assert requests[0].headers["X-clickhouse-user"] == "torghut_notebook"

    def status_response(request: urllib.request.Request, *, timeout: int) -> io.BytesIO:
        assert request.method == "GET"
        assert timeout == 10
        payload = {"action_authority": {"evaluated_at": FIXTURE_AS_OF.isoformat()}}
        return io.BytesIO(json.dumps(payload).encode())

    monkeypatch.setattr(urllib.request, "urlopen", status_response)
    status = adapter.status("capital.status")
    assert status.watermark == FIXTURE_AS_OF
    assert status.records[0]["action_authority"] == {
        "evaluated_at": FIXTURE_AS_OF.isoformat()
    }


@pytest.mark.parametrize(
    "payload",
    ([], {"data": {}}, {"data": ["not-an-object"]}),
)
def test_live_clickhouse_rejects_invalid_json_schemas(payload: object) -> None:
    with pytest.raises(NotebookDataError, match="invalid JSON schema"):
        LiveDataAdapter._clickhouse_records(payload, "flow.hyperliquid")


def test_live_http_failures_surface_without_synthetic_fallback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    adapter = _live_adapter()

    def denied(request: urllib.request.Request, *, timeout: int) -> io.BytesIO:
        del request, timeout
        raise urllib.error.HTTPError(
            "http://clickhouse.example",
            403,
            "Forbidden",
            {},
            io.BytesIO(b"readonly profile denied query"),
        )

    monkeypatch.setattr(urllib.request, "urlopen", denied)
    with pytest.raises(NotebookDataError, match="HTTP 403"):
        adapter.clickhouse(
            "flow.hyperliquid",
            HYPERLIQUID_FLOW_QUERY,
            {"as_of": FIXTURE_AS_OF, "minutes": 30},
            row_limit=10,
        )

    monkeypatch.setattr(
        urllib.request,
        "urlopen",
        lambda request, timeout: io.BytesIO(b"[]"),
    )
    with pytest.raises(NotebookDataError, match="not a JSON object"):
        adapter.status("capital.status")


def test_datetime_clickhouse_parameters_are_utc_millisecond_strings() -> None:
    adapter = _live_adapter()
    local_time = datetime(2026, 7, 17, 13, 0, tzinfo=timezone(timedelta(hours=-7)))
    parameters = adapter._clickhouse_parameters({"as_of": local_time}, 7)
    assert parameters["param_as_of"] == "2026-07-17 20:00:00.000"
    assert parameters["param_limit"] == "7"
