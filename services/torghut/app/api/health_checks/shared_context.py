"""Extracted Torghut API route and support functions."""

from __future__ import annotations

from typing import Any

from ..common import (
    ClickHouseSignalIngestor,
    Decimal,
    ExecutionTCAMetric,
    HTTPConnection,
    HTTPSConnection,
    JangarDependencyQuorumStatus,
    Mapping,
    SQLAlchemyError,
    Sequence,
    Session,
    SessionLocal,
    ThreadPoolExecutor,
    TimeoutError,
    TorghutAlpacaClient,
    TradeDecision,
    TradingScheduler,
    ALPACA_HEALTH_CACHE_LOCK,
    ALPACA_HEALTH_STATE,
    OPTIONS_CATALOG_FRESHNESS_CACHE,
    OPTIONS_CATALOG_FRESHNESS_CACHE_LOCK,
    SIMPLE_LANE_ALLOWED_REJECT_REASONS,
    bindparam,
    build_empirical_jobs_status,
    build_hypothesis_runtime_summary,
    build_live_submission_gate_payload,
    build_shadow_first_toggle_parity,
    build_tca_gate_inputs,
    cast,
    datetime,
    deepcopy,
    forecast_status_from_empirical_jobs,
    func,
    lean_authority_status,
    load_hypothesis_registry,
    logger,
    os,
    resolve_active_capital_stage,
    resolve_hypothesis_dependency_quorum,
    select,
    settings,
    text,
    time,
    timezone,
    urlencode,
    urlsplit,
)


from .tigerbeetle_health import (
    build_tigerbeetle_ledger_status,
    check_postgres,
    check_tigerbeetle_protocol_health,
    empty_tigerbeetle_ref_counts,
    latest_reconciliation_ref_counts,
    tigerbeetle_status_int,
    unavailable_tigerbeetle_reconciliation_payload,
)


def build_control_plane_contract(
    state: object,
    *,
    hypothesis_summary: Mapping[str, Any] | None = None,
    dependency_quorum: JangarDependencyQuorumStatus | None = None,
) -> dict[str, object]:
    metrics = getattr(state, "metrics", None)
    signal_lag_seconds = getattr(metrics, "signal_lag_seconds", None)
    no_signal_reason_streak = getattr(metrics, "no_signal_reason_streak", None)
    signal_staleness_alert_total = getattr(
        metrics, "signal_staleness_alert_total", None
    )
    signal_continuity_actionable = getattr(
        metrics, "signal_continuity_actionable", None
    )
    market_session_open = getattr(state, "market_session_open", None)
    last_run_at = getattr(state, "last_run_at", None)
    last_reconcile_at = getattr(state, "last_reconcile_at", None)
    summary: dict[str, Any] = (
        dict(hypothesis_summary) if hypothesis_summary is not None else {}
    )
    raw_state_totals = summary.get("state_totals")
    state_totals: dict[str, Any] = (
        dict(cast(Mapping[str, Any], raw_state_totals))
        if isinstance(raw_state_totals, Mapping)
        else {}
    )
    capital_stage_totals = (
        dict(cast(Mapping[str, Any], summary.get("capital_stage_totals", {})))
        if isinstance(summary.get("capital_stage_totals"), Mapping)
        else {}
    )
    return {
        "contract_version": "torghut.quant-producer.v1",
        "active_revision": active_runtime_revision(),
        "signal_lag_seconds": signal_lag_seconds,
        "signal_continuity_state": getattr(state, "last_signal_continuity_state", None),
        "signal_continuity_reason": getattr(
            state, "last_signal_continuity_reason", None
        ),
        "signal_continuity_actionable": signal_continuity_actionable,
        "signal_continuity_alert_active": getattr(
            state, "signal_continuity_alert_active", None
        ),
        "signal_continuity_alert_reason": getattr(
            state, "signal_continuity_alert_reason", None
        ),
        "signal_continuity_alert_started_at": getattr(
            state, "signal_continuity_alert_started_at", None
        ),
        "signal_continuity_recovery_streak": getattr(
            state, "signal_continuity_recovery_streak", None
        ),
        "signal_continuity_promotion_block_total": getattr(
            metrics, "signal_continuity_promotion_block_total", None
        ),
        "market_session_open": market_session_open,
        "no_signal_reason_streak": no_signal_reason_streak,
        "signal_staleness_alert_total": signal_staleness_alert_total,
        "signal_expected_staleness_total": getattr(
            metrics, "signal_expected_staleness_total", None
        ),
        "signal_actionable_staleness_total": getattr(
            metrics, "signal_actionable_staleness_total", None
        ),
        "universe_status": getattr(state, "universe_source_status", None),
        "universe_reason": getattr(state, "universe_source_reason", None),
        "universe_symbols_count": getattr(state, "universe_symbols_count", None),
        "universe_cache_age_seconds": getattr(
            state, "universe_cache_age_seconds", None
        ),
        "universe_resolution_total": getattr(
            metrics, "universe_resolution_total", None
        ),
        "universe_fail_safe_blocked": getattr(
            state, "universe_fail_safe_blocked", None
        ),
        "universe_fail_safe_block_reason": getattr(
            state, "universe_fail_safe_block_reason", None
        ),
        "running": bool(getattr(state, "running", False)),
        "last_run_at": last_run_at,
        "last_reconcile_at": last_reconcile_at,
        "submission_block_total": getattr(metrics, "submission_block_total", None),
        "decision_state_total": getattr(metrics, "decision_state_total", None),
        "planned_decision_age_seconds": getattr(
            metrics, "planned_decision_age_seconds", None
        ),
        "last_autonomy_recommendation_trace_id": getattr(
            state, "last_autonomy_recommendation_trace_id", None
        ),
        "domain_telemetry_event_total": getattr(
            metrics, "domain_telemetry_event_total", None
        ),
        "domain_telemetry_dropped_total": getattr(
            metrics, "domain_telemetry_dropped_total", None
        ),
        "alpha_readiness_hypotheses_total": summary.get("hypotheses_total", 0),
        "alpha_readiness_blocked_total": state_totals.get("blocked", 0),
        "alpha_readiness_shadow_total": state_totals.get("shadow", 0),
        "alpha_readiness_canary_live_total": state_totals.get("canary_live", 0),
        "alpha_readiness_scaled_live_total": state_totals.get("scaled_live", 0),
        "capital_stage_totals": capital_stage_totals,
        "active_capital_stage": _resolve_active_capital_stage(summary),
        "alpha_readiness_promotion_eligible_total": summary.get(
            "promotion_eligible_total", 0
        ),
        "alpha_readiness_rollback_required_total": summary.get(
            "rollback_required_total", 0
        ),
        "alpha_readiness_dependency_quorum_decision": (
            dependency_quorum.decision if dependency_quorum is not None else "unknown"
        ),
        "critical_toggle_parity": _build_shadow_first_toggle_parity(),
        "market_context_required": settings.trading_market_context_required,
        "market_context_max_staleness_seconds": settings.trading_market_context_max_staleness_seconds,
    }


def active_runtime_revision() -> str | None:
    revision = os.getenv("K_REVISION", "").strip()
    return revision or None


def _build_shadow_first_toggle_parity() -> dict[str, object]:
    return build_shadow_first_toggle_parity()


def _resolve_active_capital_stage(
    hypothesis_summary: Mapping[str, Any] | None,
) -> str | None:
    return resolve_active_capital_stage(hypothesis_summary)


def build_shadow_first_runtime_payload(
    *,
    state: object,
    hypothesis_summary: Mapping[str, Any] | None,
) -> dict[str, object]:
    metrics = getattr(state, "metrics", None)
    return {
        "active_revision": active_runtime_revision(),
        "capital_stage": _resolve_active_capital_stage(hypothesis_summary),
        "capital_stage_totals": (
            dict(
                cast(
                    Mapping[str, Any],
                    hypothesis_summary.get("capital_stage_totals", {}),
                )
            )
            if isinstance(hypothesis_summary, Mapping)
            and isinstance(hypothesis_summary.get("capital_stage_totals"), Mapping)
            else {}
        ),
        "submission_block_total": dict(
            cast(
                Mapping[str, int],
                getattr(metrics, "submission_block_total", {}) or {},
            )
        ),
        "decision_state_total": dict(
            cast(Mapping[str, int], getattr(metrics, "decision_state_total", {}) or {})
        ),
        "planned_decision_age_seconds": getattr(
            metrics, "planned_decision_age_seconds", 0
        ),
        "critical_toggle_parity": _build_shadow_first_toggle_parity(),
    }


def check_clickhouse() -> dict[str, object]:
    if not settings.trading_clickhouse_url:
        return {"ok": False, "detail": "clickhouse url missing"}
    query = "SELECT 1 FORMAT JSONEachRow"
    params = {"query": query}
    url = f"{settings.trading_clickhouse_url.rstrip('/')}/?{urlencode(params)}"
    parsed = urlsplit(url)
    scheme = parsed.scheme.lower()
    if scheme not in {"http", "https"}:
        return {
            "ok": False,
            "detail": f"clickhouse invalid url scheme: {scheme or 'missing'}",
        }
    if not parsed.hostname:
        return {"ok": False, "detail": "clickhouse invalid url host"}

    headers: dict[str, str] = {"Content-Type": "text/plain"}
    if settings.trading_clickhouse_username:
        headers["X-ClickHouse-User"] = settings.trading_clickhouse_username
    if settings.trading_clickhouse_password:
        headers["X-ClickHouse-Key"] = settings.trading_clickhouse_password

    path = parsed.path or "/"
    if parsed.query:
        path = f"{path}?{parsed.query}"
    connection_class = HTTPSConnection if scheme == "https" else HTTPConnection
    connection = connection_class(
        parsed.hostname,
        parsed.port,
        timeout=settings.trading_clickhouse_timeout_seconds,
    )

    try:
        connection.request("GET", path, headers=headers)
        response = connection.getresponse()
        if response.status < 200 or response.status >= 300:
            return {"ok": False, "detail": f"clickhouse http status {response.status}"}
        payload = response.read().decode("utf-8")
    except Exception as exc:  # pragma: no cover - depends on network
        return {"ok": False, "detail": f"clickhouse error: {exc}"}
    finally:
        connection.close()

    if not payload.strip():
        return {"ok": False, "detail": "clickhouse empty response"}
    return {"ok": True, "detail": "ok"}


def forecast_service_status(
    empirical_jobs_status: Mapping[str, Any] | None = None,
) -> dict[str, object]:
    return cast(
        dict[str, object],
        forecast_status_from_empirical_jobs(empirical_jobs_status),
    )


def _lean_authority_status() -> dict[str, object]:
    return cast(dict[str, object], lean_authority_status())


def empirical_jobs_status() -> dict[str, object]:
    try:
        with SessionLocal() as session:
            return build_empirical_jobs_status(
                session=session,
                stale_after_seconds=settings.trading_empirical_job_stale_after_seconds,
            )
    except Exception as exc:
        return {
            "status": "degraded",
            "authority": "blocked",
            "stale_after_seconds": settings.trading_empirical_job_stale_after_seconds,
            "jobs": {},
            "message": f"empirical job status unavailable: {type(exc).__name__}",
        }


def alpaca_endpoint_class(*, paper: bool | None = None) -> str:
    use_paper = settings.trading_mode != "live" if paper is None else paper
    return "paper" if use_paper else "live"


def alpaca_failure_status(detail: str) -> str:
    message = detail.strip().lower()
    if "keys missing" in message:
        return "credentials_missing"
    if any(
        token in message
        for token in (
            "unauthorized",
            "forbidden",
            "invalid api",
            "authentication",
            "not authorized",
            "insufficient scope",
            "access key",
            "secret key",
            "credentials",
        )
    ):
        return "credentials_invalid"
    if any(
        token in message
        for token in (
            "timeout",
            "timed out",
            "deadline exceeded",
            "read timed out",
        )
    ):
        return "broker_slow"
    if any(
        token in message
        for token in (
            "connection refused",
            "connection reset",
            "name or service not known",
            "temporary failure in name resolution",
            "nodename nor servname",
            "network is unreachable",
            "no route to host",
            "failed to establish a new connection",
            "max retries exceeded",
            "dns",
        )
    ):
        return "network_unreachable"
    return "broker_error"


def alpaca_probe_account(
    client: TorghutAlpacaClient,
    *,
    timeout_seconds: float,
) -> dict[str, object]:
    executor = ThreadPoolExecutor(max_workers=1)
    future = None
    try:
        future = executor.submit(client.get_account)
        account = future.result(timeout=timeout_seconds)
    except TimeoutError:
        if future is not None:
            future.cancel()
        return {
            "ok": False,
            "status": "broker_slow",
            "detail": f"alpaca account probe timed out after {timeout_seconds:.2f}s",
        }
    except Exception as exc:  # pragma: no cover - depends on network
        detail = str(exc).strip() or type(exc).__name__
        return {
            "ok": False,
            "status": alpaca_failure_status(detail),
            "detail": detail,
        }
    finally:
        executor.shutdown(wait=False, cancel_futures=True)
    return {
        "ok": True,
        "status": "broker_ok",
        "detail": "ok",
        "account": account,
    }


shadow_first_toggle_parity_payload = _build_shadow_first_toggle_parity
active_capital_stage_from_summary = _resolve_active_capital_stage
lean_authority_status_payload = _lean_authority_status


# Explicit barrel exports; keeps re-export imports intentional without file-level Ruff ignores.
__all__: tuple[str, ...] = (
    "ALPACA_HEALTH_CACHE_LOCK",
    "ALPACA_HEALTH_STATE",
    "ClickHouseSignalIngestor",
    "Decimal",
    "ExecutionTCAMetric",
    "JangarDependencyQuorumStatus",
    "Mapping",
    "OPTIONS_CATALOG_FRESHNESS_CACHE",
    "OPTIONS_CATALOG_FRESHNESS_CACHE_LOCK",
    "SIMPLE_LANE_ALLOWED_REJECT_REASONS",
    "SQLAlchemyError",
    "Sequence",
    "Session",
    "SessionLocal",
    "TorghutAlpacaClient",
    "TradeDecision",
    "TradingScheduler",
    "ALPACA_HEALTH_CACHE_LOCK",
    "ALPACA_HEALTH_STATE",
    "OPTIONS_CATALOG_FRESHNESS_CACHE",
    "OPTIONS_CATALOG_FRESHNESS_CACHE_LOCK",
    "SIMPLE_LANE_ALLOWED_REJECT_REASONS",
    "active_runtime_revision",
    "alpaca_endpoint_class",
    "alpaca_failure_status",
    "alpaca_probe_account",
    "build_control_plane_contract",
    "build_shadow_first_runtime_payload",
    "build_tigerbeetle_ledger_status",
    "check_clickhouse",
    "check_postgres",
    "check_tigerbeetle_protocol_health",
    "empirical_jobs_status",
    "empty_tigerbeetle_ref_counts",
    "forecast_service_status",
    "latest_reconciliation_ref_counts",
    "tigerbeetle_status_int",
    "unavailable_tigerbeetle_reconciliation_payload",
    "active_runtime_revision",
    "alpaca_endpoint_class",
    "alpaca_failure_status",
    "alpaca_probe_account",
    "bindparam",
    "build_control_plane_contract",
    "build_hypothesis_runtime_summary",
    "build_live_submission_gate_payload",
    "build_shadow_first_runtime_payload",
    "build_shadow_first_toggle_parity",
    "build_tca_gate_inputs",
    "build_tigerbeetle_ledger_status",
    "cast",
    "check_clickhouse",
    "check_postgres",
    "check_tigerbeetle_protocol_health",
    "datetime",
    "deepcopy",
    "empirical_jobs_status",
    "empty_tigerbeetle_ref_counts",
    "forecast_service_status",
    "func",
    "latest_reconciliation_ref_counts",
    "lean_authority_status",
    "load_hypothesis_registry",
    "logger",
    "resolve_active_capital_stage",
    "resolve_hypothesis_dependency_quorum",
    "select",
    "settings",
    "text",
    "tigerbeetle_status_int",
    "time",
    "timezone",
    "unavailable_tigerbeetle_reconciliation_payload",
)
