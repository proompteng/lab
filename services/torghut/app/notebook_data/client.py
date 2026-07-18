"""Public, tested Torghut diagnostics client used by canonical notebooks."""

from __future__ import annotations

import os
from collections.abc import Mapping, Sequence
from datetime import datetime, timedelta, timezone
from typing import cast
from uuid import UUID

from .adapters import DataAdapter, NotebookDataError, adapter_from_environment
from .models import (
    MAX_PROJECTED_ROWS,
    FlowLane,
    QualityState,
    QueryResult,
    Record,
    Records,
    Snapshot,
    Window,
    max_watermark,
    parse_utc,
)
from .queries import (
    DECISION_STATUS_QUERY,
    EQUITIES_FLOW_QUERY,
    EXECUTION_LINK_QUERY,
    HYPERLIQUID_FLOW_QUERY,
    LEDGER_EVIDENCE_QUERY,
    OPTIONS_FLOW_QUERY,
    REJECTION_REASON_QUERY,
    TCA_EVIDENCE_QUERY,
)

FLOW_SCHEMAS: dict[FlowLane, frozenset[str]] = {
    "equities": frozenset(
        {
            "symbol",
            "event_ts",
            "ema12",
            "ema26",
            "rsi14",
            "vwap_session",
            "latest_ingest_ts",
            "source_watermark",
        }
    ),
    "options": frozenset(
        {
            "underlying_symbol",
            "event_ts",
            "atm_iv",
            "call_put_skew_25d",
            "snapshot_coverage_ratio",
            "hot_contract_coverage_ratio",
            "feature_quality_status",
            "latest_ingest_ts",
            "source_watermark",
        }
    ),
    "hyperliquid": frozenset(
        {
            "network",
            "market_id",
            "coin",
            "dex",
            "interval",
            "event_ts",
            "price",
            "regime",
            "source_lag_seconds",
            "momentum_5m_bps",
            "volatility_bps",
            "spread_bps",
            "latest_ingest_ts",
            "source_watermark",
        }
    ),
}

LIFECYCLE_SCHEMAS = {
    "decision_status": frozenset(
        {
            "strategy_id",
            "bucket_start",
            "status",
            "decision_count",
            "last_activity_at",
            "source_watermark",
        }
    ),
    "execution_links": frozenset(
        {
            "strategy_id",
            "symbol",
            "status",
            "execution_count",
            "unlinked_execution_count",
            "linked_execution_count",
            "tca_count",
            "filled_qty",
            "last_activity_at",
            "source_watermark",
        }
    ),
    "rejection_reasons": frozenset(
        {
            "source",
            "account_label",
            "symbol",
            "reject_reason",
            "rejected_signal_count",
            "last_activity_at",
            "source_watermark",
        }
    ),
}

TCA_SCHEMA = frozenset(
    {
        "execution_id",
        "trade_decision_id",
        "strategy_id",
        "account_label",
        "symbol",
        "side",
        "filled_qty",
        "slippage_bps",
        "expected_shortfall_bps_p50",
        "expected_shortfall_bps_p95",
        "realized_shortfall_bps",
        "divergence_bps",
        "computed_at",
        "source_watermark",
    }
)

LEDGER_SCHEMA = frozenset(
    {
        "bucket_day",
        "observed_stage",
        "account_label",
        "strategy_label",
        "fill_count",
        "decision_count",
        "filled_notional",
        "gross_strategy_pnl",
        "cost_amount",
        "net_strategy_pnl_after_costs",
        "latest_bucket_ended_at",
        "source_watermark",
    }
)

STRATEGY_SCOPED_LEDGER_MESSAGE = (
    "STRATEGY-SCOPED LEDGER EVIDENCE UNAVAILABLE — "
    "strategy_runtime_ledger_buckets has no verified strategy UUID lineage; "
    "all-strategy P&L was omitted from this scoped view."
)


def default_flow_window(lane: FlowLane) -> Window:
    if lane == "equities":
        return Window.sessions()
    if lane == "options":
        return Window.minutes(60)
    return Window.minutes(30)


def _capture_time(adapter: DataAdapter) -> datetime:
    if adapter.mode == "fixture":
        from .fixtures import FIXTURE_AS_OF

        return FIXTURE_AS_OF
    return datetime.now(timezone.utc)


def _image_revision() -> str:
    return os.getenv(
        "JUPYTER_IMAGE_SPEC", os.getenv("TORGHUT_NOTEBOOK_IMAGE_DIGEST", "unknown")
    )


def _git_revision() -> str:
    return os.getenv("TORGHUT_NOTEBOOK_GIT_REVISION", "unknown")


def _validate_exact_schema(
    query_identifier: str,
    result: QueryResult,
    expected: frozenset[str],
) -> None:
    for index, record in enumerate(result.records):
        actual = frozenset(record)
        if actual != expected:
            missing = sorted(expected - actual)
            extra = sorted(actual - expected)
            raise NotebookDataError(
                f"{query_identifier} row {index} schema mismatch; missing={missing}, extra={extra}"
            )


def _snapshot(
    *,
    adapter: DataAdapter,
    captured_at: datetime,
    window: Mapping[str, object],
    query_identifier: str,
    results: Sequence[QueryResult],
    datasets: Mapping[str, Records],
    quality: QualityState,
    messages: Sequence[str] = (),
) -> Snapshot:
    truncated = any(result.truncated for result in results)
    if truncated:
        quality = "invalid"
        messages = (
            *messages,
            "source result reached its hard row cap; narrow or aggregate the query",
        )
    row_count = sum(len(result.records) for result in results)
    return Snapshot(
        captured_at=captured_at,
        effective_window=window,
        source_watermark=max_watermark(*results),
        row_count=row_count,
        query_identifier=query_identifier,
        image_revision=_image_revision(),
        git_revision=_git_revision(),
        truncated=truncated,
        quality=quality,
        datasets=datasets,
        messages=tuple(messages),
    )


def _unavailable_snapshot(
    *,
    adapter: DataAdapter,
    captured_at: datetime,
    window: Mapping[str, object],
    query_identifier: str,
    error: Exception,
) -> Snapshot:
    return _snapshot(
        adapter=adapter,
        captured_at=captured_at,
        window=window,
        query_identifier=query_identifier,
        results=(),
        datasets={},
        quality="unavailable",
        messages=(str(error), "No fixture or synthetic rows were substituted."),
    )


def _as_string_mapping(value: object) -> Mapping[str, object] | None:
    if not isinstance(value, Mapping):
        return None
    mapping = cast(Mapping[object, object], value)
    if any(not isinstance(key, str) for key in mapping):
        return None
    return cast(Mapping[str, object], mapping)


def _status_market_closed(status: Mapping[str, object]) -> bool:
    continuity = _as_string_mapping(status.get("signal_continuity"))
    if continuity is not None and continuity.get("market_session_open") is False:
        return True
    market = _as_string_mapping(status.get("market_context"))
    if market is not None:
        if market.get("market_session_open") is False:
            return True
        return market.get("status") in {"market_closed", "closed", "expected_idle"}
    return False


def _flow_window_metadata(
    window: Window,
    result: QueryResult,
    *,
    captured_at: datetime,
) -> Record:
    metadata = window.to_metadata(now=captured_at)
    event_times = [
        parsed
        for record in result.records
        if (parsed := parse_utc(record.get("event_ts"))) is not None
    ]
    if event_times:
        metadata["source_event_start"] = min(event_times).isoformat()
        metadata["source_event_end"] = max(event_times).isoformat()
    return metadata


def flow_snapshot(
    lane: FlowLane,
    window: Window,
    *,
    adapter: DataAdapter | None = None,
) -> Snapshot:
    """Capture bounded, typed flow evidence for one market-data lane."""

    selected = adapter or adapter_from_environment()
    captured_at = _capture_time(selected)
    if lane == "equities" and window.kind != "sessions":
        raise ValueError("equities flow requires a session window")
    if lane in {"options", "hyperliquid"} and window.kind != "minutes":
        raise ValueError(f"{lane} flow requires a minutes window")
    try:
        parameters: dict[str, object] = {
            "as_of": window.end(now=captured_at),
            "limit": MAX_PROJECTED_ROWS,
        }
        if lane == "equities":
            parameters["session_count"] = window.value
            result = selected.clickhouse(
                "flow.equities", EQUITIES_FLOW_QUERY, parameters
            )
        elif lane == "options":
            parameters["minutes"] = window.value
            result = selected.clickhouse("flow.options", OPTIONS_FLOW_QUERY, parameters)
        else:
            parameters["minutes"] = window.value
            result = selected.clickhouse(
                "flow.hyperliquid", HYPERLIQUID_FLOW_QUERY, parameters
            )
        _validate_exact_schema(f"flow.{lane}", result, FLOW_SCHEMAS[lane])
        messages: list[str] = []
        try:
            status_result = selected.status("flow.status")
        except NotebookDataError as error:
            status_result = QueryResult(())
            messages.append(f"Runtime status unavailable: {error}")
        status = status_result.records[0] if status_result.records else {}
        quality: QualityState = "ok"
        market_closed = lane in {"equities", "options"} and _status_market_closed(
            status
        )
        if market_closed:
            quality = "expected_idle"
            if result.records:
                messages.append(
                    "Market is closed; showing the latest completed/current-session source window."
                )
            else:
                messages.append(
                    "No rows in the requested market window while the market is closed."
                )
        elif not result.records:
            quality = "unavailable"
            messages.append(
                "No typed source rows were returned for the requested window."
            )
        datasets = {
            lane: result.records,
            "runtime_status": status_result.records,
        }
        return _snapshot(
            adapter=selected,
            captured_at=captured_at,
            window=_flow_window_metadata(window, result, captured_at=captured_at),
            query_identifier=f"torghut.notebook.flow.{lane}.v1",
            results=(result,),
            datasets=datasets,
            quality=quality,
            messages=messages,
        )
    except (NotebookDataError, ValueError) as error:
        return _unavailable_snapshot(
            adapter=selected,
            captured_at=captured_at,
            window=window.to_metadata(now=captured_at),
            query_identifier=f"torghut.notebook.flow.{lane}.v1",
            error=error,
        )


def strategy_lifecycle(
    strategy_id: UUID | None,
    window: Window,
    *,
    adapter: DataAdapter | None = None,
) -> Snapshot:
    """Capture decision, execution-lineage, and separate rejection evidence."""

    if window.kind != "days":
        raise ValueError("strategy lifecycle requires a days window")
    selected = adapter or adapter_from_environment()
    captured_at = _capture_time(selected)
    metadata = window.to_metadata(now=captured_at)
    parameters = {
        "start": window.start(now=captured_at),
        "end": window.end(now=captured_at),
        "strategy_id": str(strategy_id) if strategy_id else None,
    }
    try:
        decisions = selected.postgres(
            "lifecycle.decisions", DECISION_STATUS_QUERY, parameters
        )
        executions = selected.postgres(
            "lifecycle.executions", EXECUTION_LINK_QUERY, parameters
        )
        rejections = selected.postgres(
            "lifecycle.rejections", REJECTION_REASON_QUERY, parameters
        )
        _validate_exact_schema(
            "lifecycle.decisions", decisions, LIFECYCLE_SCHEMAS["decision_status"]
        )
        _validate_exact_schema(
            "lifecycle.executions", executions, LIFECYCLE_SCHEMAS["execution_links"]
        )
        _validate_exact_schema(
            "lifecycle.rejections", rejections, LIFECYCLE_SCHEMAS["rejection_reasons"]
        )
        quality: QualityState = (
            "ok" if decisions.records or executions.records else "expected_idle"
        )
        messages = (
            "Rejected-signal outcomes are intentionally separate: no proven signal-to-decision key exists.",
        )
        return _snapshot(
            adapter=selected,
            captured_at=captured_at,
            window=metadata,
            query_identifier="torghut.notebook.strategy-lifecycle.v1",
            results=(decisions, executions, rejections),
            datasets={
                "decision_status": decisions.records,
                "execution_links": executions.records,
                "rejection_reasons": rejections.records,
            },
            quality=quality,
            messages=messages,
        )
    except (NotebookDataError, ValueError) as error:
        return _unavailable_snapshot(
            adapter=selected,
            captured_at=captured_at,
            window=metadata,
            query_identifier="torghut.notebook.strategy-lifecycle.v1",
            error=error,
        )


def _current_profitability_state(
    ledger: QueryResult,
    *,
    captured_at: datetime,
) -> tuple[bool, str]:
    current_cutoff = captured_at - timedelta(days=1)
    for row in ledger.records:
        stage = str(row.get("observed_stage", "")).lower()
        ended = parse_utc(row.get("latest_bucket_ended_at"))
        if (
            stage in {"live", "live_canary"}
            and ended is not None
            and ended >= current_cutoff
        ):
            return True, "Current live-stage runtime-ledger evidence is present."
    return (
        False,
        "CURRENT PROFITABILITY UNPROVEN — no current live-stage runtime ledger exists; historical paper/replay P&L is not broker equity.",
    )


def _query_execution_sources(
    adapter: DataAdapter,
    strategy_id: UUID | None,
    tca_window: Window,
    ledger_window: Window,
    captured_at: datetime,
) -> tuple[QueryResult, QueryResult]:
    tca = adapter.postgres(
        "execution.tca",
        TCA_EVIDENCE_QUERY,
        {
            "start": tca_window.start(now=captured_at),
            "end": tca_window.end(now=captured_at),
            "strategy_id": str(strategy_id) if strategy_id else None,
        },
    )
    if strategy_id is None:
        ledger = adapter.postgres(
            "execution.ledger",
            LEDGER_EVIDENCE_QUERY,
            {
                "start": ledger_window.start(now=captured_at),
                "end": ledger_window.end(now=captured_at),
            },
        )
    else:
        ledger = QueryResult(())
    _validate_exact_schema("execution.tca", tca, TCA_SCHEMA)
    _validate_exact_schema("execution.ledger", ledger, LEDGER_SCHEMA)
    return tca, ledger


def _optional_runtime_status(
    adapter: DataAdapter,
) -> tuple[QueryResult, tuple[str, ...]]:
    try:
        return adapter.status("execution.status"), ()
    except NotebookDataError as error:
        return QueryResult(()), (f"Runtime status unavailable: {error}",)


def _ledger_state_records(
    ledger: QueryResult,
    *,
    captured_at: datetime,
    strategy_id: UUID | None,
) -> tuple[Records, tuple[str, ...]]:
    if strategy_id is not None:
        records: Records = (
            {
                "current_profitability_proven": False,
                "message": STRATEGY_SCOPED_LEDGER_MESSAGE,
                "historical_ledger_rows": 0,
                "ledger_included": False,
                "scope": "strategy",
                "strategy_id": str(strategy_id),
            },
        )
        return records, (STRATEGY_SCOPED_LEDGER_MESSAGE,)

    current_proven, message = _current_profitability_state(
        ledger, captured_at=captured_at
    )
    records = (
        {
            "current_profitability_proven": current_proven,
            "message": message,
            "historical_ledger_rows": len(ledger.records),
            "ledger_included": True,
            "scope": "all_strategies",
            "strategy_id": None,
        },
    )
    return records, (message,)


def execution_evidence(
    strategy_id: UUID | None,
    window: Window,
    *,
    adapter: DataAdapter | None = None,
) -> Snapshot:
    """Capture bounded TCA and stage/account-separated runtime-ledger evidence."""

    if window.kind != "days":
        raise ValueError("execution evidence requires a days window")
    selected = adapter or adapter_from_environment()
    captured_at = _capture_time(selected)
    ledger_window = Window.days(180, as_of=window.end(now=captured_at))
    metadata = {
        "tca": window.to_metadata(now=captured_at),
        "runtime_ledger": ledger_window.to_metadata(now=captured_at),
    }
    try:
        tca, ledger = _query_execution_sources(
            selected, strategy_id, window, ledger_window, captured_at
        )
        status, status_messages = _optional_runtime_status(selected)
        ledger_state, profitability_messages = _ledger_state_records(
            ledger, captured_at=captured_at, strategy_id=strategy_id
        )
        return _snapshot(
            adapter=selected,
            captured_at=captured_at,
            window=metadata,
            query_identifier="torghut.notebook.execution-evidence.v1",
            results=(tca, ledger),
            datasets={
                "tca": tca.records,
                "runtime_ledger": ledger.records,
                "ledger_state": ledger_state,
                "runtime_status": status.records,
            },
            quality="ok" if tca.records or ledger.records else "unavailable",
            messages=(*profitability_messages, *status_messages),
        )
    except (NotebookDataError, ValueError) as error:
        return _unavailable_snapshot(
            adapter=selected,
            captured_at=captured_at,
            window=metadata,
            query_identifier="torghut.notebook.execution-evidence.v1",
            error=error,
        )


def _reason_codes(payload: Mapping[str, object]) -> object:
    if "reason_codes" in payload:
        return payload["reason_codes"]
    if "blocked_reasons" in payload:
        return payload["blocked_reasons"]
    if "blockers" in payload:
        return payload["blockers"]
    return []


def _component(
    name: str,
    payload: object,
    *,
    authority_field: str | None,
    authoritative: bool,
) -> Record:
    mapping: Mapping[str, object] = _as_string_mapping(payload) or {}
    return {
        "component": name,
        "authoritative": authoritative,
        "authority_field": authority_field,
        "authority_value": mapping.get(authority_field) if authority_field else None,
        "state": mapping.get("state", mapping.get("status")),
        "reason_codes": _reason_codes(mapping),
        "payload": dict(mapping),
    }


def _unavailable_component(
    name: str,
    payload: object,
    *,
    authority_field: str,
) -> Record:
    return {
        "component": name,
        "authoritative": False,
        "authority_field": authority_field,
        "authority_value": None,
        "state": "unavailable",
        "reason_codes": [],
        "payload": payload,
    }


def capital_authority(*, adapter: DataAdapter | None = None) -> Snapshot:
    """Return verbatim authority components without deriving a new allowed flag."""

    selected = adapter or adapter_from_environment()
    captured_at = _capture_time(selected)
    metadata = {"kind": "instant", "start": None, "end": captured_at.isoformat()}
    try:
        result = selected.status("capital.status")
        if len(result.records) != 1:
            raise NotebookDataError("Torghut status must return exactly one object")
        status = result.records[0]
        required = {
            "action_authority",
            "live_submission_gate",
            "execution",
            "runtime_ledger",
            "broker_economic_ledger",
            "tigerbeetle_ledger",
            "capital_controls",
        }
        missing = sorted(required - set(status))
        if missing:
            raise NotebookDataError(
                f"Torghut status is missing authority fields: {missing}"
            )
        action = _as_string_mapping(status["action_authority"])
        if action is None or not isinstance(action.get("entry_allowed"), bool):
            raise NotebookDataError("action_authority.entry_allowed is not a boolean")
        broker_ledger = _as_string_mapping(status["broker_economic_ledger"])
        if broker_ledger is None:
            raise NotebookDataError("broker_economic_ledger is not an object")
        raw_tigerbeetle_parity = broker_ledger.get("tigerbeetle_economic_parity")
        parity_messages: tuple[str, ...] = ()
        if raw_tigerbeetle_parity is None:
            tigerbeetle_component = _unavailable_component(
                "TigerBeetle parity",
                raw_tigerbeetle_parity,
                authority_field="parity",
            )
            parity_messages = (
                "TigerBeetle economic parity is unavailable; final action authority remains authoritative.",
            )
        else:
            tigerbeetle_parity = _as_string_mapping(raw_tigerbeetle_parity)
            if tigerbeetle_parity is None or not isinstance(
                tigerbeetle_parity.get("parity"), bool
            ):
                raise NotebookDataError(
                    "broker_economic_ledger.tigerbeetle_economic_parity.parity is not a boolean"
                )
            tigerbeetle_component = _component(
                "TigerBeetle parity",
                tigerbeetle_parity,
                authority_field="parity",
                authoritative=False,
            )
        components = (
            _component(
                "final action authority",
                action,
                authority_field="entry_allowed",
                authoritative=True,
            ),
            _component(
                "execution gate",
                status["live_submission_gate"],
                authority_field="allowed",
                authoritative=False,
            ),
            _component(
                "runtime ledger",
                status["runtime_ledger"],
                authority_field="status",
                authoritative=False,
            ),
            _component(
                "broker reconciliation",
                broker_ledger,
                authority_field="reconciled",
                authoritative=False,
            ),
            tigerbeetle_component,
            _component(
                "capital authority",
                broker_ledger,
                authority_field="capital_authority",
                authoritative=False,
            ),
            _component(
                "capital controls",
                status["capital_controls"],
                authority_field="new_exposure_allowed",
                authoritative=False,
            ),
        )
        return _snapshot(
            adapter=selected,
            captured_at=captured_at,
            window=metadata,
            query_identifier="torghut.notebook.capital-authority.v1",
            results=(result,),
            datasets={"components": components, "raw_status": result.records},
            quality="ok",
            messages=(
                "Final action_authority.entry_allowed is authoritative; lower-level successes do not override it.",
                *parity_messages,
            ),
        )
    except (NotebookDataError, ValueError) as error:
        return _unavailable_snapshot(
            adapter=selected,
            captured_at=captured_at,
            window=metadata,
            query_identifier="torghut.notebook.capital-authority.v1",
            error=error,
        )
