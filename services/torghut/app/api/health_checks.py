"""Extracted Torghut API route and support functions."""

# pyright: reportUnusedImport=false
# ruff: noqa: F401,F403,F405
from __future__ import annotations

from fastapi import APIRouter
from typing import Any, TYPE_CHECKING

if TYPE_CHECKING:
    from .compat_typing import *

from .common import *
from .proxy import capture_module_exports


def _check_postgres(session: Session) -> dict[str, object]:
    try:
        ping(session)
    except SQLAlchemyError as exc:
        return {"ok": False, "detail": f"postgres error: {exc}"}
    return {"ok": True, "detail": "ok"}


def _check_tigerbeetle_protocol_health() -> dict[str, object]:
    if not settings.tigerbeetle_enabled:
        health = check_tigerbeetle_health(settings)
        payload = health.as_dict()
        payload["protocol_ok"] = True
        payload["protocol_probe_skipped"] = False
        return payload

    replica_addresses = [
        item.strip()
        for item in settings.tigerbeetle_replica_addresses.split(",")
        if item.strip()
    ]
    if not (settings.tigerbeetle_required or settings.tigerbeetle_reconcile_required):
        return {
            "enabled": True,
            "required": settings.tigerbeetle_required,
            "ok": True,
            "protocol_ok": False,
            "protocol_probe_skipped": True,
            "cluster_id": settings.tigerbeetle_cluster_id,
            "replica_addresses": replica_addresses,
            "last_error": None,
        }

    timeout_seconds = max(0.1, float(settings.tigerbeetle_health_timeout_seconds))
    executor = ThreadPoolExecutor(max_workers=1)
    future = executor.submit(check_tigerbeetle_health, settings)
    try:
        health = future.result(timeout=timeout_seconds)
    except TimeoutError:
        return {
            "enabled": True,
            "required": settings.tigerbeetle_required,
            "ok": not settings.tigerbeetle_required,
            "protocol_ok": False,
            "protocol_probe_skipped": False,
            "cluster_id": settings.tigerbeetle_cluster_id,
            "replica_addresses": replica_addresses,
            "last_error": (
                f"TimeoutError: tigerbeetle protocol health timed out after "
                f"{timeout_seconds:.2f}s"
            ),
        }
    finally:
        executor.shutdown(wait=False, cancel_futures=True)

    payload = health.as_dict()
    protocol_ok = bool(payload.get("ok"))
    payload["protocol_ok"] = protocol_ok
    payload["protocol_probe_skipped"] = False
    payload["ok"] = protocol_ok or not settings.tigerbeetle_required
    return payload


def _tigerbeetle_status_int(value: object) -> int:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    try:
        return int(str(value))
    except (TypeError, ValueError):
        return 0


def _empty_tigerbeetle_ref_counts(
    *,
    reason_codes: Sequence[str],
    last_error: str | None = None,
) -> dict[str, object]:
    return {
        "schema_version": "torghut.tigerbeetle-ref-counts.v1",
        "cluster_id": settings.tigerbeetle_cluster_id,
        "ref_counts_unavailable": True,
        "reason_codes": list(reason_codes),
        "last_error": last_error,
        "account_ref_count": 0,
        "transfer_ref_count": 0,
        "by_source_type": {},
        "order_event_ref_count": 0,
        "execution_ref_count": 0,
        "cost_ref_count": 0,
        "runtime_ledger_ref_count": 0,
        "stable_ref_count": 0,
        "stable_ref_missing_count": 0,
        "stable_ref_mismatch_count": 0,
        "stable_ref_diagnostic_bounded": True,
        "stable_ref_sample_size": 0,
        "runtime_ledger_required_bucket_count": 0,
        "runtime_ledger_signed_ref_count": 0,
        "runtime_ledger_missing_signed_ref_count": 0,
        "runtime_ledger_account_ref_count": 0,
        "runtime_ledger_missing_account_ref_count": 0,
        "runtime_ledger_missing_account_ids": [],
        "runtime_ledger_source_ids": [],
        "runtime_ledger_transfer_ids": [],
        "runtime_ledger_signed_bucket_ids": [],
        "runtime_ledger_ref_coverage_bounded": True,
        "runtime_ledger_ref_sample_size": 0,
        "source_materialization": {
            "account_ref_table": "tigerbeetle_account_refs",
            "transfer_ref_table": "tigerbeetle_transfer_refs",
            "reconciliation_run_table": "tigerbeetle_reconciliation_runs",
            "runtime_ledger_source_table": "strategy_runtime_ledger_buckets",
            "runtime_ledger_source_type": "strategy_runtime_ledger_bucket",
            "runtime_ledger_transfer_kind": "runtime_net_pnl",
        },
    }


def _latest_reconciliation_ref_counts(
    latest_reconciliation: Mapping[str, object] | None,
) -> dict[str, object] | None:
    if latest_reconciliation is None:
        return None
    raw_ref_counts = latest_reconciliation.get("ref_counts")
    if not isinstance(raw_ref_counts, Mapping):
        return None
    ref_counts = dict(cast(Mapping[str, object], raw_ref_counts))
    required_keys = (
        "account_ref_count",
        "transfer_ref_count",
        "runtime_ledger_ref_count",
        "runtime_ledger_signed_ref_count",
        "runtime_ledger_missing_signed_ref_count",
        "runtime_ledger_missing_account_ref_count",
    )
    trusted_top_level_keys: set[str] | None = None
    raw_field_names = latest_reconciliation.get("ref_count_field_names")
    if isinstance(raw_field_names, Sequence) and not isinstance(
        raw_field_names,
        (str, bytes, bytearray),
    ):
        trusted_top_level_keys = {
            str(item) for item in cast(Sequence[object], raw_field_names)
        }
    for key in required_keys:
        if key in ref_counts or key not in latest_reconciliation:
            continue
        if trusted_top_level_keys is not None and key not in trusted_top_level_keys:
            continue
        if key not in ref_counts and key in latest_reconciliation:
            ref_counts[key] = latest_reconciliation[key]
    if not all(key in ref_counts for key in required_keys):
        return None
    ref_counts.setdefault("schema_version", "torghut.tigerbeetle-ref-counts.v1")
    ref_counts["source"] = "latest_tigerbeetle_reconciliation"
    ref_counts["source_reconciliation_status"] = latest_reconciliation.get("status")
    ref_counts["source_reconciliation_ok"] = bool(latest_reconciliation.get("ok"))
    ref_counts["source_reconciliation_age_seconds"] = latest_reconciliation.get(
        "age_seconds"
    )
    ref_counts["source_reconciliation_stale"] = bool(
        latest_reconciliation.get("reconciliation_stale")
    )
    ref_counts["bounded_status_live_query_skipped"] = True
    return ref_counts


def _unavailable_tigerbeetle_reconciliation_payload(
    *,
    reason_codes: Sequence[str],
    last_error: str | None = None,
) -> dict[str, object]:
    return {
        "schema_version": "torghut.tigerbeetle-reconciliation-status.v1",
        "ok": False,
        "cluster_id": settings.tigerbeetle_cluster_id,
        "status": "unavailable",
        "age_seconds": None,
        "reconciliation_freshness": {
            "observed_at": None,
            "age_seconds": None,
            "max_age_seconds": max(
                1,
                int(settings.tigerbeetle_reconcile_max_age_seconds),
            ),
            "stale": True,
        },
        "authority": "accounting_parity_only",
        "promotion_authority": False,
        "overrides_runtime_ledger_authority": False,
        "reason_codes": list(reason_codes),
        "last_error": last_error,
        "blockers": list(reason_codes),
        "ref_counts": {},
    }


def _build_tigerbeetle_ledger_status(session: Session) -> dict[str, object]:
    protocol = _check_tigerbeetle_protocol_health()
    blockers: list[str] = []
    latest_reconciliation: dict[str, object] | None
    reconciliation_status_available = True
    try:
        _apply_status_read_statement_timeout(session, milliseconds=750)
        latest_reconciliation = latest_tigerbeetle_reconciliation_status_payload(
            session,
            cluster_id=settings.tigerbeetle_cluster_id,
        )
        if latest_reconciliation is None:
            latest_reconciliation = latest_tigerbeetle_reconciliation_payload(
                session,
                cluster_id=settings.tigerbeetle_cluster_id,
            )
    except SQLAlchemyError as exc:
        logger.warning("TigerBeetle reconciliation status unavailable: %s", exc)
        session.rollback()
        reconciliation_status_available = False
        reason_codes = ["tigerbeetle_reconciliation_status_unavailable"]
        if _sqlalchemy_error_indicates_statement_timeout(exc):
            reason_codes.append("tigerbeetle_reconciliation_status_query_timeout")
        blockers.extend(reason_codes)
        latest_reconciliation = _unavailable_tigerbeetle_reconciliation_payload(
            reason_codes=reason_codes,
            last_error=str(exc),
        )

    ref_counts: dict[str, object]
    ref_counts_available = True
    latest_ref_counts = _latest_reconciliation_ref_counts(latest_reconciliation)
    if latest_ref_counts is not None:
        ref_counts = latest_ref_counts
    else:
        try:
            _apply_status_read_statement_timeout(session, milliseconds=750)
            ref_counts = tigerbeetle_ref_counts(
                session,
                cluster_id=settings.tigerbeetle_cluster_id,
                full_ref_scan=False,
            )
        except SQLAlchemyError as exc:
            logger.warning("TigerBeetle ref-count status unavailable: %s", exc)
            session.rollback()
            ref_counts_available = False
            reason_codes = ["tigerbeetle_ref_counts_unavailable"]
            if _sqlalchemy_error_indicates_statement_timeout(exc):
                reason_codes.append("tigerbeetle_ref_counts_query_timeout")
            blockers.extend(reason_codes)
            ref_counts = _empty_tigerbeetle_ref_counts(
                reason_codes=reason_codes,
                last_error=str(exc),
            )
    runtime_ledger_ref_count = _tigerbeetle_status_int(
        ref_counts.get("runtime_ledger_ref_count")
    )
    runtime_ledger_signed_ref_count = _tigerbeetle_status_int(
        ref_counts.get("runtime_ledger_signed_ref_count")
    )
    runtime_ledger_missing_signed_ref_count = _tigerbeetle_status_int(
        ref_counts.get("runtime_ledger_missing_signed_ref_count")
    )
    runtime_ledger_missing_account_ref_count = _tigerbeetle_status_int(
        ref_counts.get("runtime_ledger_missing_account_ref_count")
    )
    claimed_by_runtime_evidence = runtime_ledger_ref_count > 0
    if (
        settings.tigerbeetle_enabled
        and not bool(protocol.get("protocol_ok"))
        and not bool(protocol.get("protocol_probe_skipped"))
    ):
        blockers.append("tigerbeetle_protocol_unhealthy")
    reconciliation_ok = True
    reconciliation_required = bool(
        settings.tigerbeetle_required or settings.tigerbeetle_reconcile_required
    )
    if latest_reconciliation is None:
        if reconciliation_required:
            reconciliation_ok = False
            blockers.append("tigerbeetle_reconciliation_missing")
    else:
        reconciliation_ok = bool(latest_reconciliation.get("ok"))
        reconciliation_age_seconds = _tigerbeetle_status_int(
            latest_reconciliation.get("age_seconds")
        )
        reconciliation_max_age_seconds = max(
            1,
            int(settings.tigerbeetle_reconcile_max_age_seconds),
        )
        if reconciliation_age_seconds > reconciliation_max_age_seconds:
            reconciliation_ok = False
            blockers.append(BLOCKER_RECONCILIATION_STALE)
        raw_blockers = latest_reconciliation.get("blockers")
        if isinstance(raw_blockers, Sequence) and not isinstance(
            raw_blockers, (str, bytes, bytearray)
        ):
            blocker_items = cast(Sequence[object], raw_blockers)
            blockers.extend(str(item) for item in blocker_items)
    if not reconciliation_status_available:
        reconciliation_ok = False
    if not ref_counts_available:
        reconciliation_ok = False
    reconciliation_age_seconds = (
        _tigerbeetle_status_int(latest_reconciliation.get("age_seconds"))
        if latest_reconciliation is not None
        else None
    )
    reconciliation_max_age_seconds = max(
        1,
        int(settings.tigerbeetle_reconcile_max_age_seconds),
    )
    reconciliation_stale = (
        reconciliation_age_seconds is not None
        and reconciliation_age_seconds > reconciliation_max_age_seconds
    )
    if runtime_ledger_missing_signed_ref_count:
        reconciliation_ok = False
        blockers.append("tigerbeetle_runtime_ledger_signed_refs_missing")
    if runtime_ledger_ref_count and runtime_ledger_signed_ref_count <= 0:
        reconciliation_ok = False
        blockers.append("tigerbeetle_runtime_ledger_signed_refs_missing")
    if runtime_ledger_missing_account_ref_count:
        reconciliation_ok = False
        blockers.append("tigerbeetle_runtime_ledger_account_refs_missing")

    protocol_gate_ok = bool(protocol.get("ok"))
    reconcile_gate_ok = reconciliation_ok or not reconciliation_required
    return {
        "schema_version": "torghut.tigerbeetle-ledger-status.v1",
        "enabled": settings.tigerbeetle_enabled,
        "journal_enabled": settings.tigerbeetle_journal_enabled,
        "required": settings.tigerbeetle_required,
        "reconcile_required": settings.tigerbeetle_reconcile_required,
        "claimed_by_runtime_evidence": claimed_by_runtime_evidence,
        "reconciliation_required": reconciliation_required,
        "ok": protocol_gate_ok and reconcile_gate_ok,
        "protocol_ok": bool(protocol.get("protocol_ok")),
        "protocol_probe_skipped": bool(protocol.get("protocol_probe_skipped")),
        "reconciliation_ok": reconciliation_ok,
        "reconciliation_age_seconds": reconciliation_age_seconds,
        "reconciliation_max_age_seconds": reconciliation_max_age_seconds,
        "reconciliation_stale": reconciliation_stale,
        "cluster_id": settings.tigerbeetle_cluster_id,
        "replica_addresses": protocol.get("replica_addresses", []),
        "last_error": protocol.get("last_error"),
        "ref_counts": ref_counts,
        "account_ref_count": ref_counts.get("account_ref_count", 0),
        "transfer_ref_count": ref_counts.get("transfer_ref_count", 0),
        "runtime_ledger_ref_count": runtime_ledger_ref_count,
        "runtime_ledger_signed_ref_count": runtime_ledger_signed_ref_count,
        "runtime_ledger_missing_signed_ref_count": (
            runtime_ledger_missing_signed_ref_count
        ),
        "runtime_ledger_missing_account_ref_count": (
            runtime_ledger_missing_account_ref_count
        ),
        "source_materialization": ref_counts.get("source_materialization", {}),
        "latest_reconciliation": latest_reconciliation,
        "blockers": sorted(set(blockers)),
    }


def _build_control_plane_contract(
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
        "active_revision": _active_runtime_revision(),
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


def _active_runtime_revision() -> str | None:
    revision = os.getenv("K_REVISION", "").strip()
    return revision or None


def _build_shadow_first_toggle_parity() -> dict[str, object]:
    return build_shadow_first_toggle_parity()


def _resolve_active_capital_stage(
    hypothesis_summary: Mapping[str, Any] | None,
) -> str | None:
    return resolve_active_capital_stage(hypothesis_summary)


def _build_shadow_first_runtime_payload(
    *,
    state: object,
    hypothesis_summary: Mapping[str, Any] | None,
) -> dict[str, object]:
    metrics = getattr(state, "metrics", None)
    return {
        "active_revision": _active_runtime_revision(),
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


def _check_clickhouse() -> dict[str, object]:
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


def _forecast_service_status(
    empirical_jobs_status: Mapping[str, Any] | None = None,
) -> dict[str, object]:
    return cast(
        dict[str, object],
        forecast_status_from_empirical_jobs(empirical_jobs_status),
    )


def _lean_authority_status() -> dict[str, object]:
    return cast(dict[str, object], lean_authority_status())


def _empirical_jobs_status() -> dict[str, object]:
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


def _alpaca_endpoint_class(*, paper: bool | None = None) -> str:
    use_paper = settings.trading_mode != "live" if paper is None else paper
    return "paper" if use_paper else "live"


def _alpaca_failure_status(detail: str) -> str:
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


def _alpaca_probe_account(
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
            "status": _alpaca_failure_status(detail),
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


def _remember_alpaca_success(
    *,
    account: Mapping[str, Any],
    endpoint_class: str,
) -> None:
    with _ALPACA_HEALTH_CACHE_LOCK:
        _ALPACA_HEALTH_STATE.clear()
        _ALPACA_HEALTH_STATE.update(
            {
                "last_ok_at": datetime.now(timezone.utc),
                "account_label": str(
                    account.get("account_number")
                    or settings.trading_account_label
                    or ""
                ).strip()
                or None,
                "account_status": str(account.get("status") or "").strip() or None,
                "endpoint_class": endpoint_class,
            }
        )


def _alpaca_cached_last_good(
    *,
    failure_status: str,
    failure_detail: str,
    endpoint_class: str,
) -> dict[str, object] | None:
    if failure_status not in {"broker_slow", "network_unreachable"}:
        return None
    ttl_seconds = max(0, settings.trading_alpaca_healthcheck_last_good_ttl_seconds)
    if ttl_seconds <= 0:
        return None
    with _ALPACA_HEALTH_CACHE_LOCK:
        last_ok_at = cast(datetime | None, _ALPACA_HEALTH_STATE.get("last_ok_at"))
        account_label = cast(str | None, _ALPACA_HEALTH_STATE.get("account_label"))
        account_status = cast(str | None, _ALPACA_HEALTH_STATE.get("account_status"))
        cached_endpoint_class = cast(
            str | None,
            _ALPACA_HEALTH_STATE.get("endpoint_class"),
        )
    if last_ok_at is None:
        return None
    age_seconds = max(
        0.0,
        round((datetime.now(timezone.utc) - last_ok_at).total_seconds(), 3),
    )
    if age_seconds > ttl_seconds:
        return None
    return {
        "ok": True,
        "detail": (
            f"{failure_detail}; using cached last known good Alpaca probe from "
            f"{last_ok_at.isoformat()}"
        ),
        "broker_status": failure_status,
        "endpoint_class": cached_endpoint_class or endpoint_class,
        "cache_used": True,
        "last_ok_at": last_ok_at.isoformat(),
        "cache_age_seconds": age_seconds,
        "account_label": account_label,
        "account_status": account_status,
    }


def _check_alpaca() -> dict[str, object]:
    if not settings.apca_api_key_id or not settings.apca_api_secret_key:
        return {
            "ok": False,
            "detail": "alpaca keys missing",
            "broker_status": "credentials_missing",
            "endpoint_class": _alpaca_endpoint_class(),
            "cache_used": False,
        }
    client = TorghutAlpacaClient()
    timeout_seconds = max(0.1, settings.trading_alpaca_healthcheck_timeout_seconds)
    retries = max(1, settings.trading_alpaca_healthcheck_retries)
    backoff_seconds = max(0.0, settings.trading_alpaca_healthcheck_backoff_seconds)
    endpoint_class = (
        str(getattr(client, "endpoint_class", _alpaca_endpoint_class())).strip()
        or _alpaca_endpoint_class()
    )

    last_failure: dict[str, object] | None = None
    for attempt in range(retries):
        probe = _alpaca_probe_account(client, timeout_seconds=timeout_seconds)
        if bool(probe.get("ok")):
            account = cast(Mapping[str, Any], probe.get("account") or {})
            _remember_alpaca_success(
                account=account,
                endpoint_class=endpoint_class,
            )
            return {
                "ok": True,
                "detail": "ok",
                "broker_status": "broker_ok",
                "endpoint_class": endpoint_class,
                "cache_used": False,
                "account_label": str(
                    account.get("account_number")
                    or settings.trading_account_label
                    or ""
                ).strip()
                or None,
                "account_status": str(account.get("status") or "").strip() or None,
            }
        last_failure = probe
        if probe.get("status") == "credentials_invalid":
            break
        if attempt < retries - 1 and backoff_seconds > 0:
            time.sleep(backoff_seconds * float(attempt + 1))

    failure_status = str(last_failure.get("status") if last_failure else "broker_error")
    failure_detail = str(
        last_failure.get("detail") if last_failure else "alpaca probe failed"
    )
    cached = _alpaca_cached_last_good(
        failure_status=failure_status,
        failure_detail=failure_detail,
        endpoint_class=endpoint_class,
    )
    if cached is not None:
        return cached
    return {
        "ok": False,
        "detail": failure_detail,
        "broker_status": failure_status,
        "endpoint_class": endpoint_class,
        "cache_used": False,
    }


def _tca_row_payload(row: ExecutionTCAMetric | None) -> dict[str, object] | None:
    if row is None:
        return None
    return {
        "arrival_price": row.arrival_price,
        "avg_fill_price": row.avg_fill_price,
        "slippage_bps": row.slippage_bps,
        "shortfall_notional": row.shortfall_notional,
        "expected_shortfall_bps_p50": row.expected_shortfall_bps_p50,
        "expected_shortfall_bps_p95": row.expected_shortfall_bps_p95,
        "realized_shortfall_bps": row.realized_shortfall_bps,
        "divergence_bps": row.divergence_bps,
        "simulator_version": row.simulator_version,
        "churn_qty": row.churn_qty,
        "churn_ratio": row.churn_ratio,
        "computed_at": row.computed_at,
    }


def _load_tca_summary(
    session: Session,
    *,
    scheduler: TradingScheduler | None = None,
) -> dict[str, object]:
    try:
        _apply_status_read_statement_timeout(session, milliseconds=750)
        return build_tca_gate_inputs(
            session=session,
            account_label=settings.trading_account_label,
            symbols=_resolve_tca_scope_symbols(scheduler),
        )
    except SQLAlchemyError as exc:
        logger.warning("Execution TCA status summary unavailable: %s", exc)
        _rollback_status_read_session(session, context="execution TCA summary")
        reason = (
            "execution_tca_summary_query_timeout"
            if _sqlalchemy_error_indicates_statement_timeout(exc)
            else "execution_tca_summary_unavailable"
        )
        return _budget_unavailable_tca_summary_payload(reason)


def _load_clickhouse_ta_status(
    scheduler: TradingScheduler | None = None,
) -> dict[str, object]:
    pipeline = getattr(scheduler, "_pipeline", None) if scheduler is not None else None
    ingestor = getattr(pipeline, "ingestor", None)
    if isinstance(ingestor, ClickHouseSignalIngestor):
        return ingestor.latest_signal_status()
    return ClickHouseSignalIngestor(
        account_label=settings.trading_account_label
    ).latest_signal_status()


def _budget_exhausted_live_submission_gate_payload(
    *,
    reason: str,
    empirical_jobs_status: Mapping[str, Any],
    quant_health_status: Mapping[str, Any],
) -> dict[str, object]:
    simple_lane_blockers = [reason]
    if settings.trading_pipeline_mode == "simple":
        if not settings.trading_simple_submit_enabled:
            simple_lane_blockers.append("simple_submit_disabled")
    return {
        "allowed": False,
        "reason": reason,
        "blocked_reasons": list(dict.fromkeys(simple_lane_blockers)),
        "reason_codes": [reason],
        "read_model_unavailable": True,
        "read_model_status": "timeout",
        "capital_stage": "shadow",
        "active_capital_stage": "shadow",
        "capital_state": "observe",
        "configured_live_promotion": bool(
            settings.trading_autonomy_allow_live_promotion
        ),
        "autonomy_promotion_eligible": False,
        "autonomy_promotion_action": None,
        "drift_live_promotion_eligible": False,
        "promotion_eligible_total": 0,
        "paper_probation_eligible_total": 0,
        "dependency_quorum_decision": "unknown",
        "continuity_ok": False,
        "continuity_reason": reason,
        "drift_ok": False,
        "drift_reason": reason,
        "empirical_jobs_ready": empirical_jobs_status.get("ready"),
        "dspy_live_ready": None,
        "critical_toggle_parity": _build_shadow_first_toggle_parity(),
        "critical_toggle_parity_blocking_mismatches": [],
        "quant_evidence": dict(quant_health_status),
        "quant_health_ref": {
            "account": quant_health_status.get("account"),
            "window": quant_health_status.get("window"),
            "status": quant_health_status.get("status"),
            "source_url": quant_health_status.get("source_url"),
        },
        "segment_summary": {
            "state": "blocked",
            "reason_codes": [reason],
            "read_model_unavailable": True,
        },
        "lineage_ref": {
            "source": "trading_status",
            "status": "unavailable",
            "reason_codes": [reason],
            "read_model_unavailable": True,
        },
        "evaluated_tuples": [],
        "runtime_ledger_repair_candidates": [],
        "runtime_ledger_paper_probation_candidates": [],
        "runtime_ledger_source_collection_candidates": [],
        "runtime_ledger_source_collection_candidate_total": 0,
        "runtime_ledger_paper_probation_eligible_total": 0,
        "runtime_ledger_paper_probation_import_plan": {
            "state": "unavailable",
            "reason_codes": [reason],
            "read_model_unavailable": True,
        },
        "profit_window_contract": {
            "state": "blocked",
            "reason_codes": [reason],
            "read_model_unavailable": True,
        },
        "profit_lease_projection": {
            "state": "blocked",
            "blocking_reason_codes": [reason],
            "read_model_unavailable": True,
        },
        "pipeline_mode": settings.trading_pipeline_mode,
        "simple_lane": {
            "submit_enabled": settings.trading_simple_submit_enabled,
            "shared_gate_enforced": True,
            "blocked_reasons": simple_lane_blockers,
        },
    }


def _budget_exhausted_options_catalog_freshness_payload(
    *,
    reason: str,
    route_symbols: Sequence[str],
) -> dict[str, object]:
    scoped_symbols = tuple(
        sorted(
            {
                str(symbol).strip().upper()
                for symbol in route_symbols
                if str(symbol).strip()
            }
        )
    )
    return {
        "status": "unavailable",
        "scope": "route_symbols" if scoped_symbols else "global",
        "route_symbols": list(scoped_symbols),
        "reason_codes": [reason],
        "read_model_unavailable": True,
    }


def _route_claim_symbols(profit_signal_quorum: Mapping[str, Any]) -> tuple[str, ...]:
    raw_quorums = profit_signal_quorum.get("quorums")
    if not isinstance(raw_quorums, Sequence) or isinstance(
        raw_quorums, (str, bytes, bytearray)
    ):
        return ()
    symbols: set[str] = set()

    def add_symbols(raw_symbols: object) -> None:
        if not isinstance(raw_symbols, Sequence) or isinstance(
            raw_symbols, (str, bytes, bytearray)
        ):
            return
        for raw_symbol in cast(Sequence[object], raw_symbols):
            symbol = str(raw_symbol or "").strip().upper()
            if symbol:
                symbols.add(symbol)

    for raw_quorum_item in cast(Sequence[object], raw_quorums):
        if not isinstance(raw_quorum_item, Mapping):
            continue
        raw_quorum = cast(Mapping[str, Any], raw_quorum_item)
        add_symbols(raw_quorum.get("symbols"))
        raw_signal = raw_quorum.get("route_tca_signal")
        if not isinstance(raw_signal, Mapping):
            continue
        route_tca_signal = cast(Mapping[str, Any], raw_signal)
        raw_details = route_tca_signal.get("details")
        if not isinstance(raw_details, Mapping):
            continue
        details = cast(Mapping[str, Any], raw_details)
        add_symbols(details.get("symbols"))
        raw_nested_details = details.get("details")
        if isinstance(raw_nested_details, Mapping):
            add_symbols(cast(Mapping[str, Any], raw_nested_details).get("symbols"))
    return tuple(sorted(symbols))


def _load_cached_options_catalog_freshness_summary(
    cache_key: tuple[str, ...],
) -> dict[str, object] | None:
    ttl_seconds = max(0, settings.trading_options_catalog_freshness_cache_seconds)
    if ttl_seconds <= 0:
        return None
    now = datetime.now(timezone.utc)
    with _OPTIONS_CATALOG_FRESHNESS_CACHE_LOCK:
        cache_entry = _OPTIONS_CATALOG_FRESHNESS_CACHE.get(cache_key)
        if cache_entry is None:
            return None
        cached_at, cached_payload = cache_entry
        age_seconds = (now - cached_at).total_seconds()
        if age_seconds >= ttl_seconds:
            _OPTIONS_CATALOG_FRESHNESS_CACHE.pop(cache_key, None)
            return None
    payload = deepcopy(cached_payload)
    payload["cache"] = {
        "hit": True,
        "cached_at": cached_at,
        "age_seconds": age_seconds,
        "ttl_seconds": ttl_seconds,
    }
    return payload


def _store_options_catalog_freshness_summary(
    cache_key: tuple[str, ...],
    payload: dict[str, object],
) -> dict[str, object]:
    ttl_seconds = max(0, settings.trading_options_catalog_freshness_cache_seconds)
    if ttl_seconds <= 0:
        return payload
    cached_at = datetime.now(timezone.utc)
    cache_payload = deepcopy(payload)
    cache_payload.pop("cache", None)
    with _OPTIONS_CATALOG_FRESHNESS_CACHE_LOCK:
        _OPTIONS_CATALOG_FRESHNESS_CACHE[cache_key] = (cached_at, cache_payload)
    payload = deepcopy(cache_payload)
    payload["cache"] = {
        "hit": False,
        "cached_at": cached_at,
        "age_seconds": 0.0,
        "ttl_seconds": ttl_seconds,
    }
    return payload


def _decimal_or_none(value: object) -> Decimal | None:
    if value is None:
        return None
    try:
        return Decimal(str(value))
    except Exception:
        return None


def _sqlalchemy_error_indicates_statement_timeout(exc: SQLAlchemyError) -> bool:
    message = str(exc).lower()
    return (
        "statement timeout" in message
        or "querycanceled" in message
        or "query canceled" in message
    )


def _load_bounded_options_catalog_freshness_summary(
    session: Session,
    scoped_symbols: tuple[str, ...],
    *,
    reason: str,
    reason_codes: list[str] | None = None,
) -> dict[str, object] | None:
    if not scoped_symbols:
        return None
    fallback_reason_codes = reason_codes if reason_codes is not None else [reason]
    if reason not in fallback_reason_codes:
        fallback_reason_codes.append(reason)
    rows: list[Mapping[str, object]] = []
    bounded_query = text(
        """
SELECT
  underlying_symbol,
  last_seen_ts,
  provider_updated_ts,
  close_price,
  open_interest
FROM torghut_options_contract_catalog
WHERE underlying_symbol = :route_symbol
  AND status = 'active'
LIMIT 1
"""
    )
    try:
        session.execute(text("SET LOCAL statement_timeout = 500"))
        for symbol in scoped_symbols:
            row = (
                session.execute(
                    bounded_query,
                    {"route_symbol": symbol},
                )
                .mappings()
                .first()
            )
            if row is not None:
                rows.append(cast(Mapping[str, object], row))
    except SQLAlchemyError as bounded_exc:
        logger.warning(
            "Options catalog bounded freshness fallback unavailable: %s",
            bounded_exc,
        )
        fallback_reason_codes.append(
            "options_catalog_freshness_bounded_route_scope_timeout"
            if _sqlalchemy_error_indicates_statement_timeout(bounded_exc)
            else "options_catalog_freshness_bounded_route_scope_unavailable"
        )
        return None

    route_symbol_freshness: dict[str, dict[str, object]] = {}
    for row in rows:
        symbol = str(row.get("underlying_symbol") or "").strip().upper()
        if not symbol:
            continue
        route_symbol_freshness[symbol] = {
            "status": "current",
            "active_contracts": 1,
            "active_contracts_exact": False,
            "coverage_exact": False,
            "bounded": True,
            "newest_last_seen_ts": _ensure_utc_datetime(
                cast(datetime | None, row.get("last_seen_ts"))
            ),
            "missing_provider_updated_ts_count": 1,
            "provider_updated_ts_present": False,
            "newest_provider_updated_ts": _ensure_utc_datetime(
                cast(datetime | None, row.get("provider_updated_ts"))
            ),
            "missing_close_price_count": 1 if row.get("close_price") is None else 0,
            "zero_open_interest_count": 1
            if (_decimal_or_none(row.get("open_interest")) or Decimal("0")) <= 0
            else 0,
            "reason_codes": [
                "options_catalog_freshness_bounded_route_scope",
                *fallback_reason_codes,
            ],
        }

    newest_last_seen_values = [
        value
        for value in (
            _ensure_utc_datetime(cast(datetime | None, row.get("last_seen_ts")))
            for row in rows
        )
        if value is not None
    ]
    newest_provider_updated_values = [
        value
        for value in (
            _ensure_utc_datetime(cast(datetime | None, row.get("provider_updated_ts")))
            for row in rows
        )
        if value is not None
    ]
    active_contracts = len(rows)
    return {
        "status": "current" if active_contracts > 0 else "missing",
        "scope": "route_symbols",
        "bounded": True,
        "coverage_exact": False,
        "active_contracts_exact": False,
        "active_contracts": active_contracts,
        "newest_last_seen_ts": max(newest_last_seen_values)
        if newest_last_seen_values
        else None,
        "missing_provider_updated_ts_count": active_contracts,
        "provider_updated_ts_present": False,
        "newest_provider_updated_ts": max(newest_provider_updated_values)
        if newest_provider_updated_values
        else None,
        "missing_close_price_count": sum(
            1 for row in rows if row.get("close_price") is None
        ),
        "zero_open_interest_count": sum(
            1
            for row in rows
            if (_decimal_or_none(row.get("open_interest")) or Decimal("0")) <= 0
        ),
        "route_symbols": list(scoped_symbols),
        "route_symbol_freshness": route_symbol_freshness,
        "reason_codes": [
            "options_catalog_freshness_bounded_route_scope",
            *fallback_reason_codes,
        ],
    }


def _load_options_catalog_freshness_summary(
    session: Session, *, route_symbols: Sequence[str] | None = None
) -> dict[str, object]:
    scoped_symbols = tuple(
        sorted(
            {
                str(symbol).strip().upper()
                for symbol in route_symbols or ()
                if str(symbol).strip()
            }
        )
    )
    cached_payload = _load_cached_options_catalog_freshness_summary(scoped_symbols)
    if cached_payload is not None:
        return cached_payload
    if (
        scoped_symbols
        and not settings.trading_options_catalog_freshness_exact_route_scope_enabled
    ):
        reason_codes = [
            "options_catalog_freshness_exact_route_scope_disabled",
        ]
        bounded_payload = _load_bounded_options_catalog_freshness_summary(
            session,
            scoped_symbols,
            reason=reason_codes[-1],
            reason_codes=reason_codes,
        )
        if bounded_payload is not None:
            return _store_options_catalog_freshness_summary(
                scoped_symbols,
                bounded_payload,
            )
        if (
            "options_catalog_freshness_bounded_route_scope_unavailable"
            not in reason_codes
        ):
            reason_codes.append(
                "options_catalog_freshness_bounded_route_scope_unavailable"
            )
        return _store_options_catalog_freshness_summary(
            scoped_symbols,
            {
                "status": "unavailable",
                "scope": "route_symbols",
                "route_symbols": list(scoped_symbols),
                "reason_codes": reason_codes,
            },
        )
    try:
        session.execute(text("SET LOCAL statement_timeout = 500"))
        if scoped_symbols:
            scoped_query = text(
                """
SELECT
  underlying_symbol,
  COUNT(*) AS active_contracts,
  MAX(last_seen_ts) AS newest_last_seen_ts,
  COUNT(*) FILTER (WHERE provider_updated_ts IS NULL) AS missing_provider_updated_ts_count,
  MAX(provider_updated_ts) AS newest_provider_updated_ts,
  COUNT(*) FILTER (WHERE close_price IS NULL) AS missing_close_price_count,
  COUNT(*) FILTER (WHERE COALESCE(open_interest, 0) <= 0) AS zero_open_interest_count
FROM torghut_options_contract_catalog
WHERE underlying_symbol IN :route_symbols
  AND status = 'active'
GROUP BY underlying_symbol
"""
            ).bindparams(bindparam("route_symbols", expanding=True))
            scoped_rows = list(
                session.execute(
                    scoped_query,
                    {"route_symbols": scoped_symbols},
                ).mappings()
            )
            active_contracts = sum(
                int(row["active_contracts"] or 0) for row in scoped_rows
            )
            newest_last_seen_values = [
                value
                for value in (
                    _ensure_utc_datetime(
                        cast(datetime | None, row["newest_last_seen_ts"])
                    )
                    for row in scoped_rows
                )
                if value is not None
            ]
            newest_last_seen_ts = (
                max(newest_last_seen_values) if newest_last_seen_values else None
            )
            missing_provider_updated_ts_count = sum(
                int(row["missing_provider_updated_ts_count"] or 0)
                for row in scoped_rows
            )
            newest_provider_updated_values = [
                value
                for value in (
                    _ensure_utc_datetime(
                        cast(datetime | None, row["newest_provider_updated_ts"])
                    )
                    for row in scoped_rows
                )
                if value is not None
            ]
            newest_provider_updated_ts = (
                max(newest_provider_updated_values)
                if newest_provider_updated_values
                else None
            )
            missing_close_price_count = sum(
                int(row["missing_close_price_count"] or 0) for row in scoped_rows
            )
            zero_open_interest_count = sum(
                int(row["zero_open_interest_count"] or 0) for row in scoped_rows
            )
        else:
            global_rows = list(
                session.execute(
                    text(
                        """
SELECT
  underlying_symbol,
  last_seen_ts,
  provider_updated_ts,
  close_price,
  open_interest
FROM torghut_options_contract_catalog
WHERE status = 'active'
ORDER BY last_seen_ts DESC NULLS LAST
LIMIT 200
"""
                    )
                ).mappings()
            )
            scoped_rows = []
            active_contracts = len(global_rows)
            newest_last_seen_values = [
                value
                for value in (
                    _ensure_utc_datetime(cast(datetime | None, row.get("last_seen_ts")))
                    for row in global_rows
                )
                if value is not None
            ]
            newest_last_seen_ts = (
                max(newest_last_seen_values) if newest_last_seen_values else None
            )
            missing_provider_updated_ts_count = sum(
                1 for row in global_rows if row.get("provider_updated_ts") is None
            )
            newest_provider_updated_values = [
                value
                for value in (
                    _ensure_utc_datetime(
                        cast(datetime | None, row.get("provider_updated_ts"))
                    )
                    for row in global_rows
                )
                if value is not None
            ]
            newest_provider_updated_ts = (
                max(newest_provider_updated_values)
                if newest_provider_updated_values
                else None
            )
            missing_close_price_count = sum(
                1 for row in global_rows if row.get("close_price") is None
            )
            zero_open_interest_count = sum(
                1
                for row in global_rows
                if (_decimal_or_none(row.get("open_interest")) or Decimal("0")) <= 0
            )
    except SQLAlchemyError as exc:
        logger.warning("Options catalog freshness summary unavailable: %s", exc)
        rollback = getattr(session, "rollback", None)
        if callable(rollback):
            try:
                rollback()
            except SQLAlchemyError:
                logger.warning("Failed to roll back options catalog freshness session")
        reason_codes = ["options_catalog_freshness_summary_unavailable"]
        if _sqlalchemy_error_indicates_statement_timeout(exc):
            reason_codes.append("options_catalog_freshness_query_timeout")
        bounded_payload = _load_bounded_options_catalog_freshness_summary(
            session,
            scoped_symbols,
            reason=reason_codes[-1],
            reason_codes=reason_codes,
        )
        if bounded_payload is not None:
            return _store_options_catalog_freshness_summary(
                scoped_symbols,
                bounded_payload,
            )
        return _store_options_catalog_freshness_summary(
            scoped_symbols,
            {
                "status": "unavailable",
                "scope": "route_symbols" if scoped_symbols else "global",
                "route_symbols": list(scoped_symbols),
                "reason_codes": reason_codes,
            },
        )

    route_symbol_freshness = {
        str(scoped_row["underlying_symbol"]).strip().upper(): {
            "status": "current"
            if int(scoped_row["active_contracts"] or 0) > 0
            else "missing",
            "active_contracts": int(scoped_row["active_contracts"] or 0),
            "newest_last_seen_ts": _ensure_utc_datetime(
                cast(datetime | None, scoped_row["newest_last_seen_ts"])
            ),
            "missing_provider_updated_ts_count": int(
                scoped_row["missing_provider_updated_ts_count"] or 0
            ),
            "provider_updated_ts_present": int(
                scoped_row["missing_provider_updated_ts_count"] or 0
            )
            == 0
            and scoped_row["newest_provider_updated_ts"] is not None,
            "newest_provider_updated_ts": _ensure_utc_datetime(
                cast(datetime | None, scoped_row["newest_provider_updated_ts"])
            ),
            "missing_close_price_count": int(
                scoped_row["missing_close_price_count"] or 0
            ),
            "zero_open_interest_count": int(
                scoped_row["zero_open_interest_count"] or 0
            ),
        }
        for scoped_row in scoped_rows
    }
    return _store_options_catalog_freshness_summary(
        scoped_symbols,
        {
            "status": "current" if active_contracts > 0 else "missing",
            "scope": "route_symbols" if scoped_symbols else "global",
            "active_contracts": active_contracts,
            "active_contracts_exact": bool(scoped_symbols),
            "coverage_exact": bool(scoped_symbols),
            "query_limit": None if scoped_symbols else 200,
            "newest_last_seen_ts": newest_last_seen_ts,
            "missing_provider_updated_ts_count": missing_provider_updated_ts_count,
            "provider_updated_ts_present": missing_provider_updated_ts_count == 0
            and newest_provider_updated_ts is not None,
            "newest_provider_updated_ts": newest_provider_updated_ts,
            "missing_close_price_count": missing_close_price_count,
            "zero_open_interest_count": zero_open_interest_count,
            "route_symbols": list(scoped_symbols),
            "route_symbol_freshness": route_symbol_freshness,
        },
    )


def _resolve_tca_scope_symbols(
    scheduler: TradingScheduler | None,
) -> tuple[str, ...] | None:
    if scheduler is None:
        return None
    resolver = _resolve_universe_resolver_for_readiness(scheduler)
    if resolver is None:
        return None
    try:
        resolution = resolver.get_resolution()
    except Exception:  # pragma: no cover - diagnostic scope should not break routes
        logger.exception("Failed to resolve universe symbols for TCA scope")
        return None
    raw_symbols = getattr(resolution, "symbols", None)
    if not isinstance(raw_symbols, set):
        return None
    raw_symbol_set = cast(set[object], raw_symbols)
    symbols = tuple(
        sorted(
            {
                str(symbol).strip().upper()
                for symbol in raw_symbol_set
                if str(symbol).strip()
            }
        )
    )
    return symbols or None


def _ensure_utc_datetime(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _load_last_decision_at(session: Session) -> datetime | None:
    return _ensure_utc_datetime(
        session.execute(select(func.max(TradeDecision.created_at))).scalar_one()
    )


def _build_hypothesis_runtime_payload(
    scheduler: TradingScheduler,
    *,
    tca_summary: Mapping[str, Any],
    market_context_status: Mapping[str, Any],
    dependency_quorum: JangarDependencyQuorumStatus | None = None,
    feature_readiness: Mapping[str, Any] | None = None,
) -> tuple[dict[str, object], dict[str, object], JangarDependencyQuorumStatus]:
    registry = load_hypothesis_registry()
    if dependency_quorum is None:
        dependency_quorum = resolve_hypothesis_dependency_quorum(registry)
    resolved_feature_readiness = feature_readiness or _load_clickhouse_ta_status(
        scheduler
    )
    try:
        with SessionLocal() as session:
            _apply_status_read_statement_timeout(session, milliseconds=750)
            summary_with_items = build_hypothesis_runtime_summary(
                session,
                state=scheduler.state,
                tca_summary=tca_summary,
                market_context_status=market_context_status,
                dependency_quorum=dependency_quorum,
                feature_readiness=resolved_feature_readiness,
            )
    except SQLAlchemyError as exc:
        logger.warning("Hypothesis runtime status summary unavailable: %s", exc)
        reason = (
            "hypothesis_runtime_summary_query_timeout"
            if _sqlalchemy_error_indicates_statement_timeout(exc)
            else "hypothesis_runtime_summary_unavailable"
        )
        return _budget_unavailable_hypothesis_runtime_payload(reason=reason)
    items = list(
        cast(Sequence[Mapping[str, Any]], summary_with_items.get("items") or [])
    )
    summary = dict(summary_with_items)
    summary.pop("items", None)
    return (
        {
            "registry_loaded": registry.loaded,
            "registry_path": registry.path,
            "registry_errors": list(registry.errors),
            "dependency_quorum": dependency_quorum.as_payload(),
            "summary": summary,
            "items": items,
        },
        summary,
        dependency_quorum,
    )


def _build_live_submission_gate_payload(
    state: object,
    *,
    session: Session | None = None,
    hypothesis_summary: Mapping[str, Any] | None,
    empirical_jobs_status: Mapping[str, Any] | None = None,
    dspy_runtime_status: Mapping[str, Any] | None = None,
    quant_health_status: Mapping[str, Any] | None = None,
    clickhouse_ta_status: Mapping[str, Any] | None = None,
) -> dict[str, object]:
    resolved_clickhouse_ta_status = clickhouse_ta_status
    if resolved_clickhouse_ta_status is None:
        resolved_clickhouse_ta_status = _load_clickhouse_ta_status(
            cast(TradingScheduler | None, getattr(app.state, "trading_scheduler", None))
        )
    if settings.trading_pipeline_mode == "simple":
        gate = build_live_submission_gate_payload(
            state,
            session=session,
            hypothesis_summary=hypothesis_summary,
            empirical_jobs_status=empirical_jobs_status,
            dspy_runtime_status=dspy_runtime_status,
            quant_health_status=quant_health_status,
            clickhouse_ta_status=resolved_clickhouse_ta_status,
        )
        if settings.trading_mode != "live":
            gate["pipeline_mode"] = "simple"
            gate["configured_live_promotion"] = settings.trading_simple_submit_enabled
            gate["simple_lane"] = {
                "submit_enabled": settings.trading_simple_submit_enabled,
                "shared_gate_enforced": True,
                "blocked_reasons": [],
            }
            return gate
        blocked_reasons: list[str] = []
        if not settings.trading_enabled:
            blocked_reasons.append("trading_disabled")
        if settings.trading_kill_switch_enabled:
            blocked_reasons.append("kill_switch_enabled")
        if not settings.trading_simple_submit_enabled:
            blocked_reasons.append("simple_submit_disabled")
        if settings.trading_emergency_stop_enabled and bool(
            getattr(state, "emergency_stop_active", False)
        ):
            blocked_reasons.append(
                str(
                    getattr(state, "emergency_stop_reason", "")
                    or "emergency_stop_active"
                )
            )
        merged_blocked_reasons = list(
            dict.fromkeys(
                [
                    *[
                        str(item).strip()
                        for item in cast(
                            Sequence[object],
                            gate.get("blocked_reasons") or [],
                        )
                        if str(item).strip()
                    ],
                    *blocked_reasons,
                ]
            )
        )
        gate["allowed"] = bool(gate.get("allowed", False)) and not blocked_reasons
        gate["blocked_reasons"] = merged_blocked_reasons
        if blocked_reasons:
            gate["reason"] = blocked_reasons[0]
            gate["capital_stage"] = "shadow"
            gate["capital_state"] = "observe"
        gate["pipeline_mode"] = "simple"
        gate["simple_lane"] = {
            "submit_enabled": settings.trading_simple_submit_enabled,
            "shared_gate_enforced": True,
            "blocked_reasons": blocked_reasons,
        }
        return gate
    return build_live_submission_gate_payload(
        state,
        session=session,
        hypothesis_summary=hypothesis_summary,
        empirical_jobs_status=empirical_jobs_status,
        dspy_runtime_status=dspy_runtime_status,
        quant_health_status=quant_health_status,
        clickhouse_ta_status=resolved_clickhouse_ta_status,
    )


def _build_simple_lane_status_payload() -> dict[str, object]:
    return {
        "enabled": settings.trading_pipeline_mode == "simple",
        "submit_enabled": settings.trading_simple_submit_enabled,
        "order_feed_telemetry_enabled": (
            settings.trading_simple_order_feed_telemetry_enabled
        ),
        "order_feed_ingestion_enabled": settings.trading_order_feed_enabled,
        "order_feed_bootstrap_configured": bool(
            settings.trading_order_feed_bootstrap_server_list
        ),
        "order_feed_topic_count": len(settings.trading_order_feed_topics),
        "order_feed_assignment_mode": settings.trading_order_feed_assignment_mode,
        "order_feed_auto_offset_reset": settings.trading_order_feed_auto_offset_reset,
        "order_feed_lifecycle_required": (
            settings.trading_pipeline_mode == "simple"
            and settings.trading_mode in {"paper", "live"}
        ),
        "order_feed_lifecycle_status": (
            "enabled"
            if settings.trading_simple_order_feed_telemetry_enabled
            else "disabled"
        ),
        "paper_route_probe_enabled": (
            settings.trading_simple_paper_route_probe_enabled
        ),
        "paper_route_probe_max_notional": (
            settings.trading_simple_paper_route_probe_max_notional
        ),
        "route_symbol_filter_enabled": settings.trading_pipeline_mode == "simple",
        "max_notional_per_order": settings.trading_simple_max_notional_per_order,
        "max_notional_per_symbol": settings.trading_simple_max_notional_per_symbol,
        "max_order_pct_equity": settings.trading_simple_max_order_pct_equity,
        "max_gross_exposure_pct_equity": (
            settings.trading_simple_max_gross_exposure_pct_equity
        ),
        "allowed_reject_reasons": sorted(_SIMPLE_LANE_ALLOWED_REJECT_REASONS),
    }


__all__ = [
    "_check_postgres",
    "_check_tigerbeetle_protocol_health",
    "_tigerbeetle_status_int",
    "_empty_tigerbeetle_ref_counts",
    "_latest_reconciliation_ref_counts",
    "_unavailable_tigerbeetle_reconciliation_payload",
    "_build_tigerbeetle_ledger_status",
    "_build_control_plane_contract",
    "_active_runtime_revision",
    "_build_shadow_first_toggle_parity",
    "_resolve_active_capital_stage",
    "_build_shadow_first_runtime_payload",
    "_check_clickhouse",
    "_forecast_service_status",
    "_lean_authority_status",
    "_empirical_jobs_status",
    "_alpaca_endpoint_class",
    "_alpaca_failure_status",
    "_alpaca_probe_account",
    "_remember_alpaca_success",
    "_alpaca_cached_last_good",
    "_check_alpaca",
    "_tca_row_payload",
    "_load_tca_summary",
    "_load_clickhouse_ta_status",
    "_budget_exhausted_live_submission_gate_payload",
    "_budget_exhausted_options_catalog_freshness_payload",
    "_route_claim_symbols",
    "_load_cached_options_catalog_freshness_summary",
    "_store_options_catalog_freshness_summary",
    "_decimal_or_none",
    "_sqlalchemy_error_indicates_statement_timeout",
    "_load_bounded_options_catalog_freshness_summary",
    "_load_options_catalog_freshness_summary",
    "_resolve_tca_scope_symbols",
    "_ensure_utc_datetime",
    "_load_last_decision_at",
    "_build_hypothesis_runtime_payload",
    "_build_live_submission_gate_payload",
    "_build_simple_lane_status_payload",
]
capture_module_exports(globals(), __all__)
