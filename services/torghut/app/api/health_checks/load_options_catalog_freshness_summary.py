"""Extracted Torghut API route and support functions."""

from __future__ import annotations

from ..application import get_app
from typing import Any


from .shared_context import (
    Decimal,
    JangarDependencyQuorumStatus,
    Mapping,
    SQLAlchemyError,
    Sequence,
    Session,
    SessionLocal,
    TradeDecision,
    TradingScheduler,
    SIMPLE_LANE_ALLOWED_REJECT_REASONS as _SIMPLE_LANE_ALLOWED_REJECT_REASONS,
    active_runtime_revision as _active_runtime_revision,
    alpaca_endpoint_class as _alpaca_endpoint_class,
    alpaca_failure_status as _alpaca_failure_status,
    alpaca_probe_account as _alpaca_probe_account,
    build_control_plane_contract as _build_control_plane_contract,
    build_shadow_first_runtime_payload as _build_shadow_first_runtime_payload,
    build_shadow_first_toggle_parity as _build_shadow_first_toggle_parity,
    build_tigerbeetle_ledger_status as _build_tigerbeetle_ledger_status,
    check_clickhouse as _check_clickhouse,
    check_postgres as _check_postgres,
    check_tigerbeetle_protocol_health as _check_tigerbeetle_protocol_health,
    empirical_jobs_status as _empirical_jobs_status,
    empty_tigerbeetle_ref_counts as _empty_tigerbeetle_ref_counts,
    forecast_service_status as _forecast_service_status,
    latest_reconciliation_ref_counts as _latest_reconciliation_ref_counts,
    lean_authority_status as _lean_authority_status,
    resolve_active_capital_stage as _resolve_active_capital_stage,
    tigerbeetle_status_int as _tigerbeetle_status_int,
    unavailable_tigerbeetle_reconciliation_payload as _unavailable_tigerbeetle_reconciliation_payload,
    bindparam,
    build_hypothesis_runtime_summary,
    build_live_submission_gate_payload as _raw_build_live_submission_gate_payload,
    capture_module_exports,
    cast,
    datetime,
    func,
    load_hypothesis_registry,
    logger,
    resolve_hypothesis_dependency_quorum,
    select,
    settings,
    text,
    timezone,
)
from .remember_alpaca_success import (
    alpaca_cached_last_good as _alpaca_cached_last_good,
    budget_exhausted_live_submission_gate_payload as _budget_exhausted_live_submission_gate_payload,
    budget_exhausted_options_catalog_freshness_payload as _budget_exhausted_options_catalog_freshness_payload,
    check_alpaca as _check_alpaca,
    decimal_or_none as _decimal_or_none,
    load_bounded_options_catalog_freshness_summary as _load_bounded_options_catalog_freshness_summary,
    load_cached_options_catalog_freshness_summary as _load_cached_options_catalog_freshness_summary,
    load_clickhouse_ta_status as _load_clickhouse_ta_status,
    load_tca_summary as _load_tca_summary,
    remember_alpaca_success as _remember_alpaca_success,
    route_claim_symbols as _route_claim_symbols,
    sqlalchemy_error_indicates_statement_timeout as _sqlalchemy_error_indicates_statement_timeout,
    store_options_catalog_freshness_summary as _store_options_catalog_freshness_summary,
    tca_row_payload as _tca_row_payload,
)


def _apply_status_read_statement_timeout(
    session: Session,
    *,
    milliseconds: int,
) -> None:
    from ..status_helpers import (
        apply_status_read_statement_timeout as apply_statement_timeout,
    )

    apply_statement_timeout(session, milliseconds=milliseconds)


def _budget_unavailable_hypothesis_runtime_payload(
    *,
    reason: str,
) -> tuple[dict[str, object], dict[str, object], JangarDependencyQuorumStatus]:
    from ..status_helpers import (
        budget_unavailable_hypothesis_runtime_payload as unavailable_payload,
    )

    return unavailable_payload(reason=reason)


def _resolve_universe_resolver_for_readiness(scheduler: TradingScheduler) -> Any | None:
    from ..readiness_helpers import (
        resolve_universe_resolver_for_readiness as resolve_universe_resolver,
    )

    return resolve_universe_resolver(scheduler)


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
            cast(
                TradingScheduler | None,
                getattr(get_app().state, "trading_scheduler", None),
            )
        )
    if settings.trading_pipeline_mode == "simple":
        shared_gate_builder = build_live_submission_gate_payload
        if shared_gate_builder is _PUBLIC_BUILD_LIVE_SUBMISSION_GATE_PAYLOAD:
            shared_gate_builder = _raw_build_live_submission_gate_payload
        gate = shared_gate_builder(
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
    return _raw_build_live_submission_gate_payload(
        state,
        session=session,
        hypothesis_summary=hypothesis_summary,
        empirical_jobs_status=empirical_jobs_status,
        dspy_runtime_status=dspy_runtime_status,
        quant_health_status=quant_health_status,
        clickhouse_ta_status=resolved_clickhouse_ta_status,
    )


def build_hypothesis_runtime_payload(
    scheduler: TradingScheduler,
    *,
    tca_summary: Mapping[str, Any],
    market_context_status: Mapping[str, Any],
    dependency_quorum: JangarDependencyQuorumStatus | None = None,
    feature_readiness: Mapping[str, Any] | None = None,
) -> tuple[dict[str, object], dict[str, object], JangarDependencyQuorumStatus]:
    return _build_hypothesis_runtime_payload(
        scheduler,
        tca_summary=tca_summary,
        market_context_status=market_context_status,
        dependency_quorum=dependency_quorum,
        feature_readiness=feature_readiness,
    )


def build_live_submission_gate_payload(
    state: object,
    *,
    session: Session | None = None,
    hypothesis_summary: Mapping[str, Any] | None,
    empirical_jobs_status: Mapping[str, Any] | None = None,
    dspy_runtime_status: Mapping[str, Any] | None = None,
    quant_health_status: Mapping[str, Any] | None = None,
    clickhouse_ta_status: Mapping[str, Any] | None = None,
) -> dict[str, object]:
    return _build_live_submission_gate_payload(
        state,
        session=session,
        hypothesis_summary=hypothesis_summary,
        empirical_jobs_status=empirical_jobs_status,
        dspy_runtime_status=dspy_runtime_status,
        quant_health_status=quant_health_status,
        clickhouse_ta_status=clickhouse_ta_status,
    )


_PUBLIC_BUILD_LIVE_SUBMISSION_GATE_PAYLOAD = build_live_submission_gate_payload


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
        "paper_route_probe_allow_live_mode": (
            settings.trading_simple_paper_route_probe_allow_live_mode
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
    "build_hypothesis_runtime_payload",
    "build_live_submission_gate_payload",
]

capture_module_exports(globals(), __all__)
