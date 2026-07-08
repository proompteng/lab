"""Quant health and runtime-window health helpers."""

from __future__ import annotations

from .common import (
    Any,
    AutoresearchPortfolioCandidate,
    Mapping,
    Request,
    SQLAlchemyError,
    Sequence,
    Session,
    CAPITAL_STAGE_ORDER as _CAPITAL_STAGE_ORDER,
    PROMOTION_PORTFOLIO_READY_SCAN_LIMIT as _PROMOTION_PORTFOLIO_READY_SCAN_LIMIT,
    PROMOTION_PORTFOLIO_SAMPLE_LIMIT as _PROMOTION_PORTFOLIO_SAMPLE_LIMIT,
    PROMOTION_SCALAR_COUNT_LIMIT as _PROMOTION_SCALAR_COUNT_LIMIT,
    PROMOTION_TABLE_COUNT_SCAN_LIMIT as _PROMOTION_TABLE_COUNT_SCAN_LIMIT,
    PortfolioPromotionRow as _PortfolioPromotionRow,
    QUANT_HEALTH_CACHE as _QUANT_HEALTH_CACHE,
    QUANT_HEALTH_CACHE_LOCK as _QUANT_HEALTH_CACHE_LOCK,
    RUNTIME_LEDGER_STATUS_QUERY_TIMEOUT_DEFAULT_MS as _RUNTIME_LEDGER_STATUS_QUERY_TIMEOUT_DEFAULT_MS,
    RUNTIME_LEDGER_STATUS_QUERY_TIMEOUT_ENV as _RUNTIME_LEDGER_STATUS_QUERY_TIMEOUT_ENV,
    RUNTIME_LEDGER_STATUS_QUERY_TIMEOUT_MAX_MS as _RUNTIME_LEDGER_STATUS_QUERY_TIMEOUT_MAX_MS,
    RUNTIME_LEDGER_STATUS_QUERY_TIMEOUT_MIN_MS as _RUNTIME_LEDGER_STATUS_QUERY_TIMEOUT_MIN_MS,
    RUNTIME_WINDOW_IMPORT_CONTINUITY_READY_STATES as _RUNTIME_WINDOW_IMPORT_CONTINUITY_READY_STATES,
    TYPED_QUANT_HEALTH_PATH as _TYPED_QUANT_HEALTH_PATH,
    coerce_aware_datetime as _coerce_aware_datetime,
    safe_attr_text as _safe_attr_text,
    safe_bool as _safe_bool,
    safe_int as _safe_int,
    safe_text as _safe_text,
    cast,
    datetime,
    evaluate_profit_target_oracle,
    func,
    json,
    logger,
    os,
    parse_qsl,
    select,
    settings,
    sql_text,
    timedelta,
    timezone,
    urlencode,
    urlopen,
    urlsplit,
    urlunsplit,
)


def _maybe_set_runtime_ledger_status_statement_timeout(session: Session) -> None:
    get_bind = getattr(session, "get_bind", None)
    if callable(get_bind):
        try:
            bind = get_bind()
            dialect = getattr(getattr(bind, "dialect", None), "name", "")
            if dialect != "postgresql":
                return
        except Exception:
            pass
    session.execute(
        sql_text(
            f"SET LOCAL statement_timeout = {_runtime_ledger_status_query_timeout_ms()}"
        )
    )


def _runtime_ledger_status_query_timeout_ms() -> int:
    raw_timeout = os.getenv(_RUNTIME_LEDGER_STATUS_QUERY_TIMEOUT_ENV)
    if raw_timeout is None:
        return _RUNTIME_LEDGER_STATUS_QUERY_TIMEOUT_DEFAULT_MS
    try:
        timeout_ms = int(raw_timeout)
    except ValueError:
        return _RUNTIME_LEDGER_STATUS_QUERY_TIMEOUT_DEFAULT_MS
    return min(
        _RUNTIME_LEDGER_STATUS_QUERY_TIMEOUT_MAX_MS,
        max(_RUNTIME_LEDGER_STATUS_QUERY_TIMEOUT_MIN_MS, timeout_ms),
    )


def _rollback_runtime_ledger_status_session(session: Session) -> None:
    rollback = getattr(session, "rollback", None)
    if not callable(rollback):
        return
    try:
        rollback()
    except SQLAlchemyError:
        logger.warning("Failed to roll back runtime-ledger status session")


def empty_profit_promotion_table_counts(
    *,
    count_errors: Sequence[str] | None = None,
) -> dict[str, Any]:
    return {
        "research_candidates": 0,
        "research_promotions": 0,
        "strategy_promotion_decisions": 0,
        "vnext_promotion_decisions": 0,
        "autoresearch_epochs": 0,
        "autoresearch_candidate_specs": 0,
        "autoresearch_proposal_scores": 0,
        "autoresearch_portfolio_candidates": 0,
        "autoresearch_portfolio_ready": 0,
        "autoresearch_portfolio_blocked": 0,
        "autoresearch_portfolio_ready_refs": [],
        "count_basis": "bounded_latest_rows",
        "count_limit": _PROMOTION_TABLE_COUNT_SCAN_LIMIT,
        "autoresearch_portfolio_scan_limit": _PROMOTION_PORTFOLIO_READY_SCAN_LIMIT,
        "truncated_counts": [],
        "read_model_scope": "bounded_promotion_scalar_counts",
        "promotion_scalar_count_limit": _PROMOTION_SCALAR_COUNT_LIMIT,
        "autoresearch_portfolio_sample_limit": _PROMOTION_PORTFOLIO_SAMPLE_LIMIT,
        "promotion_scalar_counts_exact": False,
        "count_errors": sorted(set(count_errors or ())),
    }


def load_profit_promotion_bounded_row_count(
    session: Session,
    *,
    table_name: str,
    model: Any,
    count_errors: list[str],
    truncated_counts: list[str],
    statement: Any | None = None,
) -> int:
    """Return a bounded diagnostic table count without forcing a full-table scan."""

    try:
        _maybe_set_runtime_ledger_status_statement_timeout(session)
        if statement is not None:
            bounded_count = session.execute(
                select(func.count()).select_from(
                    statement.limit(_PROMOTION_SCALAR_COUNT_LIMIT + 1).subquery()
                )
            ).scalar_one()
            if int(bounded_count or 0) > _PROMOTION_SCALAR_COUNT_LIMIT:
                truncated_counts.append(table_name)
            return min(int(bounded_count or 0), _PROMOTION_SCALAR_COUNT_LIMIT)
        rows = list(
            session.execute(
                select(model.id)
                .order_by(model.created_at.desc())
                .limit(_PROMOTION_TABLE_COUNT_SCAN_LIMIT + 1)
            )
        )
    except SQLAlchemyError as exc:
        logger.warning(
            "Failed to load bounded profit promotion table count table=%s error=%s",
            table_name,
            exc,
        )
        count_errors.append(table_name)
        _rollback_runtime_ledger_status_session(session)
        return 0
    if len(rows) > _PROMOTION_TABLE_COUNT_SCAN_LIMIT:
        truncated_counts.append(table_name)
    return min(len(rows), _PROMOTION_TABLE_COUNT_SCAN_LIMIT)


def fresh_clickhouse_signal_continuity(
    clickhouse_ta_status: Mapping[str, Any] | None,
) -> tuple[str, str, str] | None:
    if not isinstance(clickhouse_ta_status, Mapping):
        return None
    blocking_reason = _safe_text(clickhouse_ta_status.get("blocking_reason"))
    if blocking_reason:
        return "false", "clickhouse_ta_status", blocking_reason
    accepted_source_state = _safe_text(
        clickhouse_ta_status.get("accepted_source_state")
    )
    if accepted_source_state == "stale":
        return "false", "clickhouse_ta_status", "accepted_ta_signal_stale"
    if accepted_source_state == "outside_regular_session":
        market_session_state = _safe_text(
            clickhouse_ta_status.get("market_session_state")
        )
        reason = market_session_state or "outside_regular_session"
        return "true", "clickhouse_ta_status", f"accepted_ta_signal_{reason}"
    state = _safe_text(clickhouse_ta_status.get("state"))
    latest_signal_at = _coerce_aware_datetime(
        clickhouse_ta_status.get("latest_signal_at")
        or clickhouse_ta_status.get("readiness_window_end")
        or clickhouse_ta_status.get("as_of")
    )
    if state != "current" or latest_signal_at is None:
        return None

    max_age_seconds = max(
        1,
        int(settings.trading_feature_max_staleness_ms) // 1000,
    )
    lag_seconds = max(
        0,
        int((datetime.now(timezone.utc) - latest_signal_at).total_seconds()),
    )
    if lag_seconds <= max_age_seconds:
        return "true", "clickhouse_ta_status", "signals_present"
    return "false", "clickhouse_ta_status", "signal_lag_exceeded"


def runtime_window_import_continuity_signal(
    state: object,
    *,
    clickhouse_ta_status: Mapping[str, Any] | None = None,
) -> tuple[str, str, str]:
    persisted_signal = fresh_clickhouse_signal_continuity(clickhouse_ta_status)
    if persisted_signal is not None:
        return persisted_signal

    state_text = _safe_attr_text(state, "last_signal_continuity_state")
    reason = _safe_attr_text(state, "last_signal_continuity_reason")
    actionable = _safe_bool(getattr(state, "last_signal_continuity_actionable", None))
    alert_active = bool(getattr(state, "signal_continuity_alert_active", False))
    alert_reason = _safe_attr_text(state, "signal_continuity_alert_reason")
    if alert_active:
        return (
            "false",
            "signal_continuity",
            alert_reason or "signal_continuity_alert_active",
        )
    if actionable is True:
        return (
            "false",
            "signal_continuity",
            reason or state_text or "signal_continuity_actionable",
        )
    if state_text in _RUNTIME_WINDOW_IMPORT_CONTINUITY_READY_STATES:
        return "true", "signal_continuity", state_text
    if actionable is False and state_text:
        return "true", "signal_continuity", state_text
    return "false", "missing", "signal_continuity_missing"


def runtime_window_import_drift_signal(state: object) -> tuple[str, str, str]:
    if hasattr(state, "drift_live_promotion_eligible"):
        eligible = bool(getattr(state, "drift_live_promotion_eligible", False))
        return (
            "true" if eligible else "false",
            "drift_live_promotion_eligible",
            "drift_live_promotion_eligible"
            if eligible
            else "drift_live_promotion_ineligible",
        )
    return "false", "missing", "drift_live_promotion_eligible_missing"


def runtime_window_import_health_gate_inputs(
    state: object,
    *,
    dependency_quorum_decision: str,
    clickhouse_ta_status: Mapping[str, Any] | None = None,
) -> dict[str, object]:
    continuity_ok, continuity_source, continuity_reason = (
        runtime_window_import_continuity_signal(
            state,
            clickhouse_ta_status=clickhouse_ta_status,
        )
    )
    drift_ok, drift_source, drift_reason = runtime_window_import_drift_signal(state)
    blockers: list[str] = []
    promotion_blockers: list[str] = []
    if dependency_quorum_decision != "allow":
        blockers.append("dependency_quorum_not_allow")
    if continuity_source == "missing":
        blockers.append("runtime_window_import_continuity_missing")
    elif continuity_ok != "true":
        blockers.append("evidence_continuity_not_ok")
    if drift_source == "missing":
        promotion_blockers.append("runtime_window_import_drift_missing")
    elif drift_ok != "true":
        promotion_blockers.append("drift_checks_not_ok")
    return {
        "continuity_ok": continuity_ok,
        "continuity_source": continuity_source,
        "continuity_reason": continuity_reason,
        "drift_ok": drift_ok,
        "drift_source": drift_source,
        "drift_reason": drift_reason,
        "runtime_window_import_health_gate": {
            "schema_version": "torghut.runtime-window-import-health-gate.v1",
            "source": "live_submission_gate",
            "dependency_quorum_decision": dependency_quorum_decision,
            "dependency_quorum_source": "dependency_quorum",
            "continuity_ok": continuity_ok,
            "continuity_source": continuity_source,
            "continuity_reason": continuity_reason,
            "drift_ok": drift_ok,
            "drift_source": drift_source,
            "drift_reason": drift_reason,
            "ready": not blockers,
            "blockers": blockers,
            "promotion_blockers": promotion_blockers,
        },
        "runtime_window_import_health_gate_blockers": blockers,
        "runtime_window_import_promotion_blockers": promotion_blockers,
    }


def autoresearch_portfolio_current_oracle_passed(
    row: AutoresearchPortfolioCandidate | _PortfolioPromotionRow,
) -> bool:
    scorecard = row.objective_scorecard_json
    if not isinstance(scorecard, Mapping):
        return False
    oracle = evaluate_profit_target_oracle(
        cast(Mapping[str, Any], scorecard),
        target_net_pnl_per_day=row.target_net_pnl_per_day,
    )
    return bool(oracle.get("passed"))


def derive_quant_health_url(
    value: str | None,
    *,
    preserve_path: bool = False,
) -> str | None:
    raw = (value or "").strip()
    if not raw:
        return None
    parsed = urlsplit(raw)
    if not parsed.scheme or not parsed.netloc:
        return None
    path = parsed.path if preserve_path else ""
    query = parsed.query if preserve_path else ""
    if preserve_path and path:
        normalized_path = path if path.startswith("/") else f"/{path}"
        normalized_path = (
            normalized_path.rstrip("/") if normalized_path != "/" else normalized_path
        )
        if not (
            normalized_path == _TYPED_QUANT_HEALTH_PATH
            or normalized_path.endswith(_TYPED_QUANT_HEALTH_PATH)
        ):
            return None
        resolved_path = normalized_path
    else:
        resolved_path = _TYPED_QUANT_HEALTH_PATH
    return urlunsplit(
        (
            parsed.scheme,
            parsed.netloc,
            resolved_path,
            query,
            "",
        )
    )


def resolve_quant_health_url() -> str | None:
    return derive_quant_health_url(
        settings.trading_jangar_quant_health_url,
        preserve_path=True,
    )


def build_quant_health_request_url(
    base_url: str,
    *,
    account: str,
    window: str,
) -> str:
    parsed = urlsplit(base_url)
    query_params = dict(parse_qsl(parsed.query, keep_blank_values=True))
    if account:
        query_params["account"] = account
    if window:
        query_params["window"] = window
    query = urlencode(query_params)
    return urlunsplit(
        (
            parsed.scheme,
            parsed.netloc,
            parsed.path,
            query,
            "",
        )
    )


def load_quant_evidence_status(
    *, account_label: str | None = None
) -> dict[str, object]:
    window = settings.trading_jangar_quant_window
    account = (account_label or settings.trading_account_label or "").strip()
    required = bool(settings.trading_jangar_quant_health_required)
    configured_url = _safe_text(settings.trading_jangar_quant_health_url)
    base_url = resolve_quant_health_url()
    if configured_url is not None and not base_url:
        blocking_reasons = ["quant_health_invalid_endpoint"] if required else []
        return {
            "required": required,
            "ok": not required,
            "status": "unknown",
            "reason": "quant_health_invalid_endpoint",
            "blocking_reasons": blocking_reasons,
            "informational_reasons": []
            if required
            else ["quant_health_invalid_endpoint"],
            "account": account or None,
            "window": window,
            "source_url": configured_url,
            "message": (
                "TRADING_JANGAR_QUANT_HEALTH_URL must target the typed "
                f"{_TYPED_QUANT_HEALTH_PATH} surface"
            ),
        }
    if not base_url:
        blocking_reasons = ["quant_health_not_configured"] if required else []
        return {
            "required": required,
            "ok": not required,
            "status": "unknown" if required else "not_required",
            "reason": "quant_health_not_configured",
            "blocking_reasons": blocking_reasons,
            "informational_reasons": []
            if required
            else ["quant_health_not_configured"],
            "account": account or None,
            "window": window,
            "source_url": None,
        }

    request_url = build_quant_health_request_url(
        base_url,
        account=account,
        window=window,
    )
    cache_key = f"{request_url}|required={int(required)}"
    ttl_seconds = max(0, int(settings.trading_jangar_control_plane_cache_ttl_seconds))
    now = datetime.now(timezone.utc)

    if ttl_seconds > 0:
        with _QUANT_HEALTH_CACHE_LOCK:
            cached = cast(dict[str, Any] | None, _QUANT_HEALTH_CACHE.get(cache_key))
            if cached is not None:
                checked_at = cast(datetime | None, cached.get("checked_at"))
                if checked_at is not None and now - checked_at <= timedelta(
                    seconds=ttl_seconds
                ):
                    return dict(cast(Mapping[str, Any], cached["payload"]))

    status_payload: dict[str, object]
    try:
        request = Request(
            request_url, method="GET", headers={"accept": "application/json"}
        )
        with urlopen(
            request, timeout=settings.trading_jangar_control_plane_timeout_seconds
        ) as response:
            status_code = int(getattr(response, "status", 200))
            if status_code < 200 or status_code >= 300:
                raise RuntimeError(f"quant_health_http_{status_code}")
            decoded = json.loads(response.read().decode("utf-8"))
        if not isinstance(decoded, Mapping):
            raise RuntimeError("quant_health_payload_invalid")
        payload = cast(Mapping[str, Any], decoded)
        if payload.get("ok") is not True:
            message = str(
                payload.get("message") or "quant_health_request_failed"
            ).strip()
            raise RuntimeError(message)
        latest_metrics_count = _safe_int(payload.get("latestMetricsCount"))
        empty_latest_store_alarm = bool(payload.get("emptyLatestStoreAlarm"))
        missing_update_alarm = bool(payload.get("missingUpdateAlarm"))
        stages_raw = payload.get("stages")
        stages = (
            list(cast(Sequence[object], stages_raw))
            if isinstance(stages_raw, Sequence)
            and not isinstance(stages_raw, (str, bytes, bytearray))
            else []
        )
        blocking_reasons: list[str] = []
        if latest_metrics_count <= 0:
            blocking_reasons.append("quant_latest_metrics_empty")
        if empty_latest_store_alarm:
            blocking_reasons.append("quant_latest_store_alarm")
        if missing_update_alarm:
            blocking_reasons.append("quant_metrics_update_missing")
        if len(stages) == 0:
            blocking_reasons.append("quant_pipeline_stages_missing")
        elif any(
            _safe_bool(cast(Mapping[str, Any], stage).get("ok")) is False
            for stage in stages
            if isinstance(stage, Mapping)
        ):
            blocking_reasons.append("quant_pipeline_degraded")

        raw_status = str(payload.get("status") or "").strip().lower()
        if not blocking_reasons and raw_status not in {"ok", "healthy"}:
            blocking_reasons.append("quant_health_degraded")

        status_payload = {
            "required": required,
            "ok": len(blocking_reasons) == 0 or not required,
            "status": "healthy" if len(blocking_reasons) == 0 else "degraded",
            "reason": "ready" if len(blocking_reasons) == 0 else blocking_reasons[0],
            "blocking_reasons": blocking_reasons if required else [],
            "informational_reasons": [] if required else blocking_reasons,
            "account": account or None,
            "window": window,
            "source_url": request_url,
            "latest_metrics_count": latest_metrics_count,
            "latest_metrics_updated_at": payload.get("latestMetricsUpdatedAt"),
            "empty_latest_store_alarm": empty_latest_store_alarm,
            "missing_update_alarm": missing_update_alarm,
            "metrics_pipeline_lag_seconds": payload.get("metricsPipelineLagSeconds"),
            "stage_count": len(stages),
            "max_stage_lag_seconds": payload.get("maxStageLagSeconds"),
            "stages": stages,
            "as_of": payload.get("asOf"),
        }
    except Exception as exc:
        blocking_reasons = ["quant_health_fetch_failed"] if required else []
        status_payload = {
            "required": required,
            "ok": not required,
            "status": "unknown",
            "reason": "quant_health_fetch_failed",
            "blocking_reasons": blocking_reasons,
            "informational_reasons": [] if required else ["quant_health_fetch_failed"],
            "account": account or None,
            "window": window,
            "source_url": request_url,
            "message": str(exc),
            "latest_metrics_count": None,
            "latest_metrics_updated_at": None,
            "empty_latest_store_alarm": None,
            "missing_update_alarm": None,
            "metrics_pipeline_lag_seconds": None,
            "stage_count": None,
            "max_stage_lag_seconds": None,
            "stages": [],
            "as_of": None,
        }

    if ttl_seconds > 0:
        with _QUANT_HEALTH_CACHE_LOCK:
            _QUANT_HEALTH_CACHE[cache_key] = {
                "checked_at": now,
                "payload": dict(status_payload),
            }
    return dict(status_payload)


def critical_trading_toggle_snapshot() -> dict[str, object]:
    return {
        "TRADING_ENABLED": settings.trading_enabled,
        "TRADING_AUTONOMY_ENABLED": settings.trading_autonomy_enabled,
        "TRADING_AUTONOMY_ALLOW_LIVE_PROMOTION": settings.trading_autonomy_allow_live_promotion,
        "TRADING_KILL_SWITCH_ENABLED": settings.trading_kill_switch_enabled,
        "TRADING_MODE": settings.trading_mode,
    }


def build_shadow_first_toggle_parity() -> dict[str, object]:
    expected = {
        "TRADING_ENABLED": True,
        "TRADING_AUTONOMY_ENABLED": False,
        "TRADING_AUTONOMY_ALLOW_LIVE_PROMOTION": False,
        "TRADING_KILL_SWITCH_ENABLED": False,
        "TRADING_MODE": "live",
    }
    effective = critical_trading_toggle_snapshot()
    mismatches = [
        key
        for key, expected_value in expected.items()
        if effective.get(key) != expected_value
    ]
    return {
        "status": "aligned" if not mismatches else "diverged",
        "mismatches": mismatches,
        "expected": expected,
        "effective": effective,
    }


def resolve_active_capital_stage(
    hypothesis_summary: Mapping[str, Any] | None,
) -> str | None:
    if not isinstance(hypothesis_summary, Mapping):
        return None
    totals_raw = hypothesis_summary.get("capital_stage_totals")
    if not isinstance(totals_raw, Mapping):
        return None
    totals = cast(Mapping[str, Any], totals_raw)
    for stage in reversed(_CAPITAL_STAGE_ORDER):
        count = totals.get(stage)
        if isinstance(count, int) and count > 0:
            return stage
    return "shadow" if totals else None


__all__ = (
    "resolve_quant_health_url",
    "load_quant_evidence_status",
    "critical_trading_toggle_snapshot",
    "build_shadow_first_toggle_parity",
    "resolve_active_capital_stage",
)
