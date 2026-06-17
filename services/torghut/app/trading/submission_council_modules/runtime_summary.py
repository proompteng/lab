# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
"""Runtime ledger summary payload helpers."""

from __future__ import annotations

# ruff: noqa: F401
from .common import (
    Any,
    AutoresearchCandidateSpec,
    AutoresearchEpoch,
    AutoresearchPortfolioCandidate,
    AutoresearchProposalScore,
    Decimal,
    InvalidOperation,
    Lock,
    Mapping,
    NamedTuple,
    POST_COST_PNL_BASIS,
    RUNTIME_LEDGER_AUTHORITY_CLASS_MISSING_BLOCKER,
    RUNTIME_LEDGER_EXECUTION_ORDER_EVENT_REFS_MISSING_BLOCKER,
    RUNTIME_LEDGER_EXECUTION_REFS_MISSING_BLOCKER,
    RUNTIME_LEDGER_SOURCE_MATERIALIZATION_MISSING_BLOCKER,
    RUNTIME_LEDGER_SOURCE_OFFSETS_MISSING_BLOCKER,
    RUNTIME_LEDGER_SOURCE_REFS_MISSING_BLOCKER,
    RUNTIME_LEDGER_SOURCE_WINDOW_IDS_MISSING_BLOCKER,
    RUNTIME_LEDGER_SOURCE_WINDOW_MISSING_BLOCKER,
    RUNTIME_LEDGER_TRADE_DECISION_REFS_MISSING_BLOCKER,
    Request,
    ResearchCandidate,
    ResearchPromotion,
    SQLAlchemyError,
    Sequence,
    Session,
    StrategyHypothesis,
    StrategyHypothesisMetricWindow,
    StrategyPromotionDecision,
    StrategyRuntimeLedgerBucket,
    TradeDecision,
    VNextDatasetSnapshot,
    VNextPromotionDecision,
    AUTORESEARCH_PORTFOLIO_READY_STATUSES as _AUTORESEARCH_PORTFOLIO_READY_STATUSES,
    CAPITAL_STAGE_ORDER as _CAPITAL_STAGE_ORDER,
    CERTIFICATE_EVIDENCE_PER_HYPOTHESIS_LIMIT as _CERTIFICATE_EVIDENCE_PER_HYPOTHESIS_LIMIT,
    CERTIFICATE_EVIDENCE_RUNTIME_LEDGER_LIMIT as _CERTIFICATE_EVIDENCE_RUNTIME_LEDGER_LIMIT,
    CERTIFICATE_EVIDENCE_WINDOW_LIMIT as _CERTIFICATE_EVIDENCE_WINDOW_LIMIT,
    LIVE_SUBMISSION_BLOCKING_TOGGLE_MISMATCHES as _LIVE_SUBMISSION_BLOCKING_TOGGLE_MISMATCHES,
    PROMOTION_PORTFOLIO_READY_SCAN_LIMIT as _PROMOTION_PORTFOLIO_READY_SCAN_LIMIT,
    PROMOTION_PORTFOLIO_SAMPLE_LIMIT as _PROMOTION_PORTFOLIO_SAMPLE_LIMIT,
    PROMOTION_SCALAR_COUNT_LIMIT as _PROMOTION_SCALAR_COUNT_LIMIT,
    PROMOTION_TABLE_COUNT_SCAN_LIMIT as _PROMOTION_TABLE_COUNT_SCAN_LIMIT,
    PortfolioPromotionRow as _PortfolioPromotionRow,
    QUANT_HEALTH_CACHE as _QUANT_HEALTH_CACHE,
    QUANT_HEALTH_CACHE_LOCK as _QUANT_HEALTH_CACHE_LOCK,
    RUNTIME_LEDGER_REPAIR_CANDIDATE_LIMIT as _RUNTIME_LEDGER_REPAIR_CANDIDATE_LIMIT,
    RUNTIME_LEDGER_REPAIR_SCAN_LIMIT as _RUNTIME_LEDGER_REPAIR_SCAN_LIMIT,
    RUNTIME_LEDGER_STATUS_QUERY_TIMEOUT_DEFAULT_MS as _RUNTIME_LEDGER_STATUS_QUERY_TIMEOUT_DEFAULT_MS,
    RUNTIME_LEDGER_STATUS_QUERY_TIMEOUT_ENV as _RUNTIME_LEDGER_STATUS_QUERY_TIMEOUT_ENV,
    RUNTIME_LEDGER_STATUS_QUERY_TIMEOUT_MAX_MS as _RUNTIME_LEDGER_STATUS_QUERY_TIMEOUT_MAX_MS,
    RUNTIME_LEDGER_STATUS_QUERY_TIMEOUT_MIN_MS as _RUNTIME_LEDGER_STATUS_QUERY_TIMEOUT_MIN_MS,
    RUNTIME_LEDGER_SUMMARY_PER_HYPOTHESIS_LIMIT as _RUNTIME_LEDGER_SUMMARY_PER_HYPOTHESIS_LIMIT,
    RUNTIME_WINDOW_IMPORT_CONTINUITY_READY_STATES as _RUNTIME_WINDOW_IMPORT_CONTINUITY_READY_STATES,
    STALE_SEGMENT_STATES as _STALE_SEGMENT_STATES,
    TA_CORE_REASON_CODES as _TA_CORE_REASON_CODES,
    TYPED_QUANT_HEALTH_PATH as _TYPED_QUANT_HEALTH_PATH,
    bounded_paper_route_probe_collection_payload as _bounded_paper_route_probe_collection_payload,
    bounded_paper_route_probe_notional as _bounded_paper_route_probe_notional,
    certificate_evidence_reason_codes as _certificate_evidence_reason_codes,
    coerce_aware_datetime as _coerce_aware_datetime,
    compat_symbol as _compat_symbol,
    decimal_text as _decimal_text,
    maybe_set_runtime_ledger_status_statement_timeout as _maybe_set_runtime_ledger_status_statement_timeout,
    normalize_reason_codes as _normalize_reason_codes,
    rollback_runtime_ledger_status_session as _rollback_runtime_ledger_status_session,
    runtime_ledger_status_query_timeout_ms as _runtime_ledger_status_query_timeout_ms,
    safe_attr_text as _safe_attr_text,
    safe_bool as _safe_bool,
    safe_decimal as _safe_decimal,
    safe_int as _safe_int,
    safe_text as _safe_text,
    sqlalchemy_error_indicates_statement_timeout as _sqlalchemy_error_indicates_statement_timeout,
    stage_rank as _stage_rank,
    unavailable_certificate_evidence_rows as _unavailable_certificate_evidence_rows,
    active_market_context_mapping,
    active_market_context_reasons,
    bounded_paper_route_probe_collection_payload,
    build_profit_lease_projection,
    build_profit_window_contract,
    build_tca_gate_inputs,
    cast,
    compile_hypothesis_runtime_statuses,
    datetime,
    derived_strategy_name_from_strategy_id,
    evaluate_profit_target_oracle,
    explicit_runtime_strategy_name_or_family_harness,
    func,
    hashlib,
    json,
    load_hypothesis_registry,
    logger,
    logging,
    normalize_reason_codes,
    os,
    parse_qsl,
    regular_session_close_utc_for,
    regular_session_open_utc_for,
    resolve_hypothesis_dependency_quorum,
    runtime_ledger_promotion_source_authority_blockers,
    runtime_ledger_promotion_source_authority_present,
    safe_decimal,
    safe_int,
    safe_text,
    select,
    settings,
    sql_text,
    strategy_names_from_strategy_id,
    summarize_hypothesis_runtime_statuses,
    sys,
    timedelta,
    timezone,
    urlencode,
    urlopen,
    urlsplit,
    urlunsplit,
)


def build_hypothesis_runtime_summary(
    session: Session,
    *,
    state: object,
    market_context_status: Mapping[str, Any],
    tca_summary: Mapping[str, Any] | None = None,
    dependency_quorum: Any | None = None,
    feature_readiness: Mapping[str, Any] | None = None,
) -> dict[str, object]:
    from .certificate_loading import (
        load_latest_certificate_evidence as _load_latest_certificate_evidence,
        merge_runtime_certificate_evidence as _merge_runtime_certificate_evidence,
    )
    from .runtime_certificates import (
        load_latest_runtime_ledger_summary as _load_latest_runtime_ledger_summary,
    )

    registry = _compat_symbol("load_hypothesis_registry", load_hypothesis_registry)()
    if dependency_quorum is None:
        dependency_quorum = _compat_symbol(
            "resolve_hypothesis_dependency_quorum",
            resolve_hypothesis_dependency_quorum,
        )(registry)
    runtime_ledger_summary = _load_latest_runtime_ledger_summary(
        session,
        hypothesis_ids=[item.hypothesis_id for item in registry.items],
    )
    compile_statuses = _compat_symbol(
        "compile_hypothesis_runtime_statuses",
        compile_hypothesis_runtime_statuses,
    )
    build_tca_inputs = _compat_symbol("build_tca_gate_inputs", build_tca_gate_inputs)
    items = compile_statuses(
        registry=registry,
        state=state,
        tca_summary=tca_summary
        if tca_summary is not None
        else build_tca_inputs(
            session=session,
            account_label=settings.trading_account_label,
        ),
        runtime_ledger_summary=runtime_ledger_summary,
        market_context_status=market_context_status,
        jangar_dependency_quorum=dependency_quorum,
        feature_readiness=feature_readiness,
        market_session_open=cast(
            bool | None, getattr(state, "market_session_open", None)
        ),
        route_symbol_filter_enabled=settings.trading_pipeline_mode == "simple",
    )
    max_age_seconds = max(
        0, int(settings.trading_drift_live_promotion_max_evidence_age_seconds)
    )
    now = datetime.now(timezone.utc)
    evidence = _load_latest_certificate_evidence(
        session,
        hypothesis_ids=[item.hypothesis_id for item in registry.items],
        now=now,
        max_age_seconds=max_age_seconds,
    )
    items = _merge_runtime_certificate_evidence(
        items,
        evidence=evidence,
        now=now,
        max_age_seconds=max_age_seconds,
    )
    summary = summarize_hypothesis_runtime_statuses(
        items,
        registry=registry,
        dependency_quorum=dependency_quorum,
    )
    summary["runtime_ledger_read_status"] = {
        "status": runtime_ledger_summary.get("query_status")
        or (
            "unavailable"
            if bool(runtime_ledger_summary.get("read_model_unavailable"))
            else "ok"
        ),
        "reason_codes": list(
            cast(
                Sequence[object],
                runtime_ledger_summary.get("query_reason_codes")
                or runtime_ledger_summary.get("reason_codes")
                or [],
            )
        ),
        "query_limit": runtime_ledger_summary.get("query_limit"),
        "query_limit_per_hypothesis": runtime_ledger_summary.get(
            "query_limit_per_hypothesis"
        ),
    }
    summary["runtime_ledger_read_model"] = {
        "query_scope": runtime_ledger_summary.get("query_scope"),
        "query_limit_per_hypothesis": runtime_ledger_summary.get(
            "query_limit_per_hypothesis"
        ),
        "reason_codes": runtime_ledger_summary.get("reason_codes")
        or runtime_ledger_summary.get("query_reason_codes")
        or [],
        "read_model_unavailable": bool(
            runtime_ledger_summary.get("read_model_unavailable")
        ),
    }
    certificate_reason_codes = sorted(
        {
            str(reason).strip()
            for row in evidence
            for reason in cast(
                Sequence[object],
                row.get("query_reason_codes") or row.get("reason_codes") or [],
            )
            if str(reason).strip()
        }
    )
    certificate_unavailable = any(
        bool(row.get("read_model_unavailable")) for row in evidence
    )
    summary["certificate_evidence_read_status"] = {
        "status": "ok"
        if not certificate_reason_codes and not certificate_unavailable
        else "degraded",
        "reason_codes": certificate_reason_codes,
        "per_hypothesis_limit": _CERTIFICATE_EVIDENCE_WINDOW_LIMIT,
        "runtime_ledger_query_limit": _CERTIFICATE_EVIDENCE_RUNTIME_LEDGER_LIMIT,
        "read_model_unavailable": certificate_unavailable,
    }
    summary["items"] = items
    return summary


def _runtime_ledger_bucket_payload(
    row: StrategyRuntimeLedgerBucket,
) -> dict[str, object]:
    payload_json: Mapping[str, object]
    raw_payload_json: object = row.payload_json
    if isinstance(raw_payload_json, Mapping):
        payload_json = {
            str(key): value
            for key, value in cast(Mapping[object, object], raw_payload_json).items()
        }
    else:
        payload_json = {}
    return {
        "run_id": row.run_id,
        "candidate_id": row.candidate_id,
        "hypothesis_id": row.hypothesis_id,
        "observed_stage": row.observed_stage,
        "bucket_started_at": row.bucket_started_at.isoformat(),
        "bucket_ended_at": row.bucket_ended_at.isoformat(),
        "account_label": row.account_label,
        "runtime_strategy_name": row.runtime_strategy_name,
        "strategy_family": row.strategy_family,
        "symbol": payload_json.get("symbol"),
        "fill_count": row.fill_count,
        "decision_count": row.decision_count,
        "submitted_order_count": row.submitted_order_count,
        "cancelled_order_count": row.cancelled_order_count,
        "rejected_order_count": row.rejected_order_count,
        "unfilled_order_count": row.unfilled_order_count,
        "closed_trade_count": row.closed_trade_count,
        "open_position_count": row.open_position_count,
        "filled_notional": str(row.filled_notional),
        "gross_strategy_pnl": str(row.gross_strategy_pnl),
        "cost_amount": str(row.cost_amount),
        "net_strategy_pnl_after_costs": str(row.net_strategy_pnl_after_costs),
        "post_cost_expectancy_bps": str(row.post_cost_expectancy_bps)
        if row.post_cost_expectancy_bps is not None
        else None,
        "ledger_schema_version": row.ledger_schema_version,
        "pnl_basis": row.pnl_basis,
        "execution_policy_hash_counts": row.execution_policy_hash_counts or {},
        "cost_model_hash_counts": row.cost_model_hash_counts or {},
        "lineage_hash_counts": row.lineage_hash_counts or {},
        "source_window_start": payload_json.get("source_window_start")
        or payload_json.get("runtime_ledger_source_window_start"),
        "source_window_end": payload_json.get("source_window_end")
        or payload_json.get("runtime_ledger_source_window_end"),
        "source_refs": payload_json.get("source_refs") or [],
        "source_ref": payload_json.get("source_ref"),
        "source_row_counts": payload_json.get("source_row_counts") or {},
        "source_window_ids": payload_json.get("source_window_ids")
        or payload_json.get("runtime_ledger_source_window_ids")
        or [],
        "source_window_id": payload_json.get("source_window_id")
        or payload_json.get("runtime_ledger_source_window_id"),
        "trade_decision_ids": payload_json.get("trade_decision_ids") or [],
        "execution_ids": payload_json.get("execution_ids") or [],
        "execution_tca_metric_ids": (
            payload_json.get("execution_tca_metric_ids")
            or payload_json.get("runtime_ledger_execution_tca_metric_ids")
            or []
        ),
        "execution_order_event_ids": (
            payload_json.get("execution_order_event_ids") or []
        ),
        "source_offsets": payload_json.get("source_offsets") or [],
        "source_materialization": payload_json.get("source_materialization"),
        "authority_class": payload_json.get("authority_class"),
        "authority_reason": payload_json.get("authority_reason"),
        "pnl_derivation": payload_json.get("pnl_derivation"),
        "cost_basis_counts": payload_json.get("cost_basis_counts") or {},
        "blockers": row.blockers_json or [],
    }


_RUNTIME_LEDGER_BUCKET_INT_TOTAL_KEYS = (
    "fill_count",
    "decision_count",
    "submitted_order_count",
    "cancelled_order_count",
    "rejected_order_count",
    "unfilled_order_count",
    "closed_trade_count",
    "open_position_count",
)
_RUNTIME_LEDGER_BUCKET_DECIMAL_TOTAL_KEYS = (
    "filled_notional",
    "gross_strategy_pnl",
    "cost_amount",
    "net_strategy_pnl_after_costs",
)
_RUNTIME_LEDGER_BUCKET_COUNT_MAP_KEYS = (
    "execution_policy_hash_counts",
    "cost_model_hash_counts",
    "lineage_hash_counts",
    "cost_basis_counts",
    "source_row_counts",
)
_RUNTIME_LEDGER_BUCKET_SEQUENCE_KEYS = (
    "source_refs",
    "source_window_ids",
    "trade_decision_ids",
    "execution_ids",
    "execution_tca_metric_ids",
    "execution_order_event_ids",
    "source_offsets",
)
_RUNTIME_LEDGER_BUCKET_COMMON_TEXT_KEYS = (
    "source_materialization",
    "authority_class",
    "authority_reason",
    "pnl_derivation",
)


def _runtime_ledger_candidate_group_key(
    payload: Mapping[str, object],
) -> tuple[str, str, str, str, str, str, str, str, str]:
    return (
        _safe_text(payload.get("hypothesis_id")) or "",
        _safe_text(payload.get("candidate_id")) or "",
        _safe_text(payload.get("run_id")) or "",
        _safe_text(payload.get("bucket_started_at")) or "",
        _safe_text(payload.get("bucket_ended_at")) or "",
        _safe_text(payload.get("observed_stage")) or "",
        _safe_text(payload.get("account_label")) or "",
        _safe_text(payload.get("runtime_strategy_name")) or "",
        _safe_text(payload.get("strategy_family")) or "",
    )


def _runtime_ledger_bucket_symbol(payload: Mapping[str, object]) -> str | None:
    symbol = _safe_text(payload.get("symbol"))
    return symbol.upper() if symbol is not None else None


def _runtime_ledger_latest_payloads_per_symbol(
    payloads: Sequence[dict[str, object]],
) -> list[dict[str, object]]:
    no_symbol = [
        payload
        for payload in payloads
        if _runtime_ledger_bucket_symbol(payload) is None
    ]
    if no_symbol:
        return [dict(no_symbol[0])]
    by_symbol: dict[str, dict[str, object]] = {}
    for payload in payloads:
        symbol = _runtime_ledger_bucket_symbol(payload)
        if symbol is None or symbol in by_symbol:
            continue
        by_symbol[symbol] = dict(payload)
    return list(by_symbol.values())


def _runtime_ledger_merge_count_maps(
    payloads: Sequence[Mapping[str, object]],
    key: str,
) -> dict[str, int]:
    merged: dict[str, int] = {}
    for payload in payloads:
        value = payload.get(key)
        if not isinstance(value, Mapping):
            continue
        for raw_name, raw_count in cast(Mapping[object, object], value).items():
            name = str(raw_name or "").strip()
            count = _safe_int(raw_count)
            if not name or count <= 0:
                continue
            merged[name] = merged.get(name, 0) + count
    return dict(sorted(merged.items()))


def _runtime_ledger_unique_sequence(
    payloads: Sequence[Mapping[str, object]],
    key: str,
) -> list[object]:
    values: list[object] = []
    seen: set[str] = set()
    for payload in payloads:
        raw_values = payload.get(key)
        if not isinstance(raw_values, Sequence) or isinstance(
            raw_values, (str, bytes, bytearray)
        ):
            continue
        for value in cast(Sequence[object], raw_values):
            marker = json.dumps(value, sort_keys=True, default=str)
            if marker in seen:
                continue
            seen.add(marker)
            values.append(value)
    return values


def _runtime_ledger_common_text(
    payloads: Sequence[Mapping[str, object]],
    key: str,
) -> str | None:
    values = sorted(
        {
            value
            for payload in payloads
            if (value := _safe_text(payload.get(key))) is not None
        }
    )
    return values[0] if len(values) == 1 else None


def _runtime_ledger_aggregate_candidate_payloads(
    payloads: Sequence[dict[str, object]],
) -> dict[str, object]:
    selected = _runtime_ledger_latest_payloads_per_symbol(payloads)
    if len(selected) <= 1:
        return dict(selected[0]) if selected else {}

    aggregate = dict(selected[0])
    symbols = sorted(
        symbol
        for payload in selected
        if (symbol := _runtime_ledger_bucket_symbol(payload)) is not None
    )
    for key in _RUNTIME_LEDGER_BUCKET_INT_TOTAL_KEYS:
        aggregate[key] = sum(_safe_int(payload.get(key)) for payload in selected)
    for key in _RUNTIME_LEDGER_BUCKET_DECIMAL_TOTAL_KEYS:
        aggregate[key] = _decimal_text(
            sum(
                (
                    _safe_decimal(payload.get(key)) or Decimal("0")
                    for payload in selected
                ),
                Decimal("0"),
            ),
        )
    filled_notional = _safe_decimal(aggregate.get("filled_notional")) or Decimal("0")
    net_pnl = _safe_decimal(aggregate.get("net_strategy_pnl_after_costs")) or Decimal(
        "0"
    )
    aggregate["post_cost_expectancy_bps"] = (
        _decimal_text(net_pnl / filled_notional * Decimal("10000"))
        if filled_notional > 0
        else None
    )
    for key in _RUNTIME_LEDGER_BUCKET_COUNT_MAP_KEYS:
        merged = _runtime_ledger_merge_count_maps(selected, key)
        if merged:
            aggregate[key] = merged
    for key in _RUNTIME_LEDGER_BUCKET_SEQUENCE_KEYS:
        merged_sequence = _runtime_ledger_unique_sequence(selected, key)
        if merged_sequence:
            aggregate[key] = merged_sequence
    aggregate_blockers = [
        blocker
        for payload in selected
        for blocker in (
            [
                str(item).strip()
                for item in cast(Sequence[object], payload.get("blockers") or [])
                if str(item).strip()
            ]
            + runtime_ledger_promotion_source_authority_blockers(payload)
        )
    ]
    aggregate["blockers"] = _normalize_reason_codes(aggregate_blockers)
    aggregate["symbol"] = symbols[0] if len(symbols) == 1 else None
    aggregate["symbols"] = symbols
    aggregate["runtime_ledger_bucket_aggregation"] = (
        "portfolio_window_from_symbol_buckets"
    )
    aggregate["runtime_ledger_aggregate_bucket_count"] = len(selected)
    aggregate["runtime_ledger_aggregate_symbols"] = symbols
    for key in _RUNTIME_LEDGER_BUCKET_COMMON_TEXT_KEYS:
        common_value = _runtime_ledger_common_text(selected, key)
        if common_value is not None:
            aggregate[key] = common_value
        else:
            aggregate.pop(key, None)
    return aggregate


_RUNTIME_LEDGER_SOURCE_EVIDENCE_KEYS = (
    "source_window_start",
    "source_window_end",
    "source_refs",
    "source_ref",
    "source_row_counts",
    "source_window_ids",
    "source_window_id",
    "trade_decision_ids",
    "execution_ids",
    "execution_tca_metric_ids",
    "execution_order_event_ids",
    "source_offsets",
    "source_materialization",
    "authority_class",
    "authority_reason",
    "pnl_derivation",
    "cost_basis_counts",
)


def _runtime_ledger_source_evidence_payload(
    candidate: Mapping[str, object],
) -> dict[str, object]:
    from .paper_probation import (
        runtime_ledger_paper_probation_payload as _runtime_ledger_paper_probation_payload,
    )

    payload = _runtime_ledger_paper_probation_payload(candidate)
    evidence: dict[str, object] = {}
    for key in _RUNTIME_LEDGER_SOURCE_EVIDENCE_KEYS:
        value = payload.get(key)
        if value is None or value == "" or value == [] or value == {}:
            continue
        evidence[key] = value
    return evidence


def _normalized_strategy_family(value: object) -> str | None:
    text = _safe_text(value)
    return text.replace("-", "_").lower() if text is not None else None


def _runtime_ledger_hash_count(
    payload: Mapping[str, object],
    *,
    payload_key: str,
    observed: Mapping[str, object],
    observed_key: str,
) -> int:
    payload_counts = payload.get(payload_key)
    if isinstance(payload_counts, Mapping):
        typed_counts = cast(Mapping[str, object], payload_counts)
        total = 0
        for raw_value in typed_counts.values():
            count = _safe_int(raw_value)
            if count > 0:
                total += count
        return total
    payload_count = _safe_int(payload_counts)
    if payload_count > 0:
        return payload_count
    return _safe_int(observed.get(observed_key))


def _runtime_ledger_payload_from_runtime_item(
    runtime_item: Mapping[str, object],
) -> dict[str, object]:
    observed_raw = runtime_item.get("observed")
    observed = (
        cast(Mapping[str, object], observed_raw)
        if isinstance(observed_raw, Mapping)
        else cast(Mapping[str, object], {})
    )
    if not bool(observed.get("runtime_ledger_proof_present")):
        return {}
    return {
        "candidate_id": observed.get("runtime_ledger_candidate_id"),
        "hypothesis_id": runtime_item.get("hypothesis_id"),
        "observed_stage": observed.get("runtime_ledger_observed_stage"),
        "runtime_strategy_name": observed.get("runtime_ledger_runtime_strategy_name"),
        "strategy_family": observed.get("runtime_ledger_strategy_family")
        or runtime_item.get("strategy_family"),
        "fill_count": observed.get("runtime_ledger_fill_count"),
        "submitted_order_count": observed.get("runtime_ledger_submitted_order_count"),
        "closed_trade_count": observed.get("runtime_ledger_closed_trade_count"),
        "open_position_count": observed.get("runtime_ledger_open_position_count"),
        "filled_notional": observed.get("runtime_ledger_filled_notional"),
        "net_strategy_pnl_after_costs": observed.get(
            "runtime_ledger_net_strategy_pnl_after_costs"
        ),
        "post_cost_expectancy_bps": observed.get(
            "runtime_ledger_post_cost_expectancy_bps"
        ),
        "blockers": observed.get("runtime_ledger_blockers"),
        "ledger_schema_version": observed.get("runtime_ledger_schema_version"),
        "pnl_basis": observed.get("runtime_ledger_pnl_basis"),
        "source_window_start": observed.get("runtime_ledger_source_window_start"),
        "source_window_end": observed.get("runtime_ledger_source_window_end"),
        "source_refs": observed.get("runtime_ledger_source_refs") or [],
        "source_ref": observed.get("runtime_ledger_source_ref"),
        "source_row_counts": observed.get("runtime_ledger_source_row_counts") or {},
        "source_window_ids": observed.get("runtime_ledger_source_window_ids") or [],
        "source_window_id": observed.get("runtime_ledger_source_window_id"),
        "trade_decision_ids": observed.get("runtime_ledger_trade_decision_ids") or [],
        "execution_ids": observed.get("runtime_ledger_execution_ids") or [],
        "execution_order_event_ids": (
            observed.get("runtime_ledger_execution_order_event_ids") or []
        ),
        "source_offsets": observed.get("runtime_ledger_source_offsets") or [],
        "source_materialization": observed.get("runtime_ledger_source_materialization"),
        "authority_class": observed.get("runtime_ledger_authority_class"),
        "authority_reason": observed.get("runtime_ledger_authority_reason"),
        "pnl_derivation": observed.get("runtime_ledger_pnl_derivation"),
        "execution_policy_hash_counts": observed.get(
            "runtime_ledger_execution_policy_hash_counts"
        ),
        "cost_model_hash_counts": observed.get("runtime_ledger_cost_model_hash_counts"),
        "lineage_hash_counts": observed.get("runtime_ledger_lineage_hash_counts"),
    }


def _runtime_ledger_bucket_within_metric_window(
    *,
    bucket_started_at: object,
    bucket_ended_at: object,
    metric_window: StrategyHypothesisMetricWindow,
) -> bool:
    window_started_at = _coerce_aware_datetime(
        cast(object, getattr(metric_window, "window_started_at", None))
    )
    window_ended_at = _coerce_aware_datetime(
        cast(object, getattr(metric_window, "window_ended_at", None))
    )
    bucket_start = _coerce_aware_datetime(bucket_started_at)
    bucket_end = _coerce_aware_datetime(bucket_ended_at)
    if (
        window_started_at is None
        or window_ended_at is None
        or bucket_start is None
        or bucket_end is None
    ):
        return False
    if window_ended_at < window_started_at or bucket_end < bucket_start:
        return False
    return window_started_at <= bucket_start and bucket_end <= window_ended_at


def _runtime_ledger_bucket_matches_metric_window(
    ledger: StrategyRuntimeLedgerBucket,
    *,
    metric_window: StrategyHypothesisMetricWindow,
) -> bool:
    return _runtime_ledger_bucket_within_metric_window(
        bucket_started_at=ledger.bucket_started_at,
        bucket_ended_at=ledger.bucket_ended_at,
        metric_window=metric_window,
    )


def _runtime_ledger_bucket_window_reason_code(
    payload: Mapping[str, object],
    *,
    metric_window: StrategyHypothesisMetricWindow,
) -> str | None:
    window_started_at = cast(object, getattr(metric_window, "window_started_at", None))
    window_ended_at = cast(object, getattr(metric_window, "window_ended_at", None))
    if window_started_at is None or window_ended_at is None:
        return None
    bucket_started_at = payload.get("bucket_started_at")
    bucket_ended_at = payload.get("bucket_ended_at")
    if bucket_started_at is None or bucket_ended_at is None:
        return "runtime_ledger_window_bounds_missing"
    if not _runtime_ledger_bucket_within_metric_window(
        bucket_started_at=bucket_started_at,
        bucket_ended_at=bucket_ended_at,
        metric_window=metric_window,
    ):
        return "runtime_ledger_window_bounds_mismatch"
    return None


def _certificate_runtime_ledger_payload(
    *,
    evidence_row: Mapping[str, object],
    runtime_item: Mapping[str, object],
) -> dict[str, object]:
    payload = evidence_row.get("runtime_ledger_bucket")
    if "runtime_ledger_bucket" in evidence_row and not isinstance(payload, Mapping):
        return {}
    if isinstance(payload, Mapping):
        return dict(cast(Mapping[str, object], payload))
    return _runtime_ledger_payload_from_runtime_item(runtime_item)


__all__ = ("build_hypothesis_runtime_summary",)

# Public aliases used by split modules.
certificate_runtime_ledger_payload = _certificate_runtime_ledger_payload
normalized_strategy_family = _normalized_strategy_family
runtime_ledger_aggregate_candidate_payloads = (
    _runtime_ledger_aggregate_candidate_payloads
)
RUNTIME_LEDGER_BUCKET_COMMON_TEXT_KEYS = _RUNTIME_LEDGER_BUCKET_COMMON_TEXT_KEYS
RUNTIME_LEDGER_BUCKET_COUNT_MAP_KEYS = _RUNTIME_LEDGER_BUCKET_COUNT_MAP_KEYS
RUNTIME_LEDGER_BUCKET_DECIMAL_TOTAL_KEYS = _RUNTIME_LEDGER_BUCKET_DECIMAL_TOTAL_KEYS
RUNTIME_LEDGER_BUCKET_INT_TOTAL_KEYS = _RUNTIME_LEDGER_BUCKET_INT_TOTAL_KEYS
runtime_ledger_bucket_matches_metric_window = (
    _runtime_ledger_bucket_matches_metric_window
)
runtime_ledger_bucket_payload = _runtime_ledger_bucket_payload
RUNTIME_LEDGER_BUCKET_SEQUENCE_KEYS = _RUNTIME_LEDGER_BUCKET_SEQUENCE_KEYS
runtime_ledger_bucket_symbol = _runtime_ledger_bucket_symbol
runtime_ledger_bucket_window_reason_code = _runtime_ledger_bucket_window_reason_code
runtime_ledger_bucket_within_metric_window = _runtime_ledger_bucket_within_metric_window
runtime_ledger_candidate_group_key = _runtime_ledger_candidate_group_key
runtime_ledger_common_text = _runtime_ledger_common_text
runtime_ledger_hash_count = _runtime_ledger_hash_count
runtime_ledger_latest_payloads_per_symbol = _runtime_ledger_latest_payloads_per_symbol
runtime_ledger_merge_count_maps = _runtime_ledger_merge_count_maps
runtime_ledger_payload_from_runtime_item = _runtime_ledger_payload_from_runtime_item
RUNTIME_LEDGER_SOURCE_EVIDENCE_KEYS = _RUNTIME_LEDGER_SOURCE_EVIDENCE_KEYS
runtime_ledger_source_evidence_payload = _runtime_ledger_source_evidence_payload
runtime_ledger_unique_sequence = _runtime_ledger_unique_sequence
