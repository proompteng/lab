# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportPrivateUsage=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
"""Extracted Torghut API route and support functions."""

# ruff: noqa: F401,F403,F405,F811,F821
from __future__ import annotations

from fastapi import APIRouter
from typing import Any, TYPE_CHECKING

# ruff: noqa: F401,F403,F405,F821,F821,F821

from .part_01_statements_10 import *


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


__all__ = [name for name in globals() if not name.startswith("__")]
