# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
"""Runtime certificate and repair scoring helpers."""

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

from .runtime_summary import (
    RUNTIME_LEDGER_BUCKET_COMMON_TEXT_KEYS as _RUNTIME_LEDGER_BUCKET_COMMON_TEXT_KEYS,
    RUNTIME_LEDGER_BUCKET_COUNT_MAP_KEYS as _RUNTIME_LEDGER_BUCKET_COUNT_MAP_KEYS,
    RUNTIME_LEDGER_BUCKET_DECIMAL_TOTAL_KEYS as _RUNTIME_LEDGER_BUCKET_DECIMAL_TOTAL_KEYS,
    RUNTIME_LEDGER_BUCKET_INT_TOTAL_KEYS as _RUNTIME_LEDGER_BUCKET_INT_TOTAL_KEYS,
    RUNTIME_LEDGER_BUCKET_SEQUENCE_KEYS as _RUNTIME_LEDGER_BUCKET_SEQUENCE_KEYS,
    RUNTIME_LEDGER_SOURCE_EVIDENCE_KEYS as _RUNTIME_LEDGER_SOURCE_EVIDENCE_KEYS,
    certificate_runtime_ledger_payload as _certificate_runtime_ledger_payload,
    normalized_strategy_family as _normalized_strategy_family,
    runtime_ledger_aggregate_candidate_payloads as _runtime_ledger_aggregate_candidate_payloads,
    runtime_ledger_bucket_matches_metric_window as _runtime_ledger_bucket_matches_metric_window,
    runtime_ledger_bucket_payload as _runtime_ledger_bucket_payload,
    runtime_ledger_bucket_symbol as _runtime_ledger_bucket_symbol,
    runtime_ledger_bucket_window_reason_code as _runtime_ledger_bucket_window_reason_code,
    runtime_ledger_bucket_within_metric_window as _runtime_ledger_bucket_within_metric_window,
    runtime_ledger_candidate_group_key as _runtime_ledger_candidate_group_key,
    runtime_ledger_common_text as _runtime_ledger_common_text,
    runtime_ledger_hash_count as _runtime_ledger_hash_count,
    runtime_ledger_latest_payloads_per_symbol as _runtime_ledger_latest_payloads_per_symbol,
    runtime_ledger_merge_count_maps as _runtime_ledger_merge_count_maps,
    runtime_ledger_payload_from_runtime_item as _runtime_ledger_payload_from_runtime_item,
    runtime_ledger_source_evidence_payload as _runtime_ledger_source_evidence_payload,
    runtime_ledger_unique_sequence as _runtime_ledger_unique_sequence,
    build_hypothesis_runtime_summary,
)


def _certificate_runtime_ledger_reason_codes(
    *,
    evidence_row: Mapping[str, object],
    runtime_item: Mapping[str, object],
    metric_window: StrategyHypothesisMetricWindow,
    promotion_decision: StrategyPromotionDecision,
) -> list[str]:
    ledger_payload = _certificate_runtime_ledger_payload(
        evidence_row=evidence_row,
        runtime_item=runtime_item,
    )
    if not ledger_payload:
        return ["runtime_ledger_proof_missing"]

    reasons: list[str] = []
    observed_raw = runtime_item.get("observed")
    observed = (
        cast(Mapping[str, object], observed_raw)
        if isinstance(observed_raw, Mapping)
        else cast(Mapping[str, object], {})
    )
    ledger_hypothesis_id = _safe_text(
        ledger_payload.get("hypothesis_id") or runtime_item.get("hypothesis_id")
    )
    metric_hypothesis_id = (
        _safe_attr_text(metric_window, "hypothesis_id")
        or _safe_text(evidence_row.get("hypothesis_id"))
        or _safe_text(runtime_item.get("hypothesis_id"))
    )
    if ledger_hypothesis_id != metric_hypothesis_id:
        reasons.append("runtime_ledger_hypothesis_mismatch")

    ledger_run_id = _safe_text(ledger_payload.get("run_id"))
    metric_run_id = _safe_attr_text(metric_window, "run_id")
    if (
        ledger_run_id is not None
        and metric_run_id is not None
        and ledger_run_id != metric_run_id
    ):
        reasons.append("runtime_ledger_run_id_mismatch")
    window_reason = _runtime_ledger_bucket_window_reason_code(
        ledger_payload,
        metric_window=metric_window,
    )
    if window_reason is not None:
        reasons.append(window_reason)

    certificate_candidate_id = (
        _safe_attr_text(metric_window, "candidate_id")
        or _safe_attr_text(promotion_decision, "candidate_id")
        or _safe_text(runtime_item.get("candidate_id"))
    )
    ledger_candidate_id = _safe_text(
        ledger_payload.get("candidate_id")
        or observed.get("runtime_ledger_candidate_id")
        or runtime_item.get("candidate_id")
    )
    if ledger_candidate_id is None:
        reasons.append("runtime_ledger_candidate_missing")
    elif (
        certificate_candidate_id is not None
        and ledger_candidate_id != certificate_candidate_id
    ):
        reasons.append("runtime_ledger_candidate_mismatch")

    if _safe_text(ledger_payload.get("observed_stage")) != "live":
        reasons.append("runtime_ledger_stage_not_live")

    ledger_family = _normalized_strategy_family(ledger_payload.get("strategy_family"))
    runtime_family = _normalized_strategy_family(runtime_item.get("strategy_family"))
    if (
        ledger_family is not None
        and runtime_family is not None
        and ledger_family != runtime_family
    ):
        reasons.append("runtime_ledger_strategy_family_mismatch")

    blockers = [
        str(reason).strip()
        for reason in cast(Sequence[object], ledger_payload.get("blockers") or [])
        if str(reason).strip()
    ]
    reasons.extend(blockers)

    if _safe_text(ledger_payload.get("pnl_basis")) != POST_COST_PNL_BASIS:
        reasons.append("runtime_ledger_pnl_basis_missing")

    filled_notional = _safe_decimal(ledger_payload.get("filled_notional"))
    if filled_notional is None or filled_notional <= 0:
        reasons.append("runtime_ledger_filled_notional_missing")

    expectancy_bps = _safe_decimal(ledger_payload.get("post_cost_expectancy_bps"))
    if expectancy_bps is None:
        reasons.append("runtime_ledger_expectancy_missing")
    elif expectancy_bps <= 0:
        reasons.append("post_cost_expectancy_non_positive")

    if _safe_int(ledger_payload.get("closed_trade_count")) <= 0:
        reasons.append("runtime_ledger_closed_trades_missing")
    if _safe_int(ledger_payload.get("open_position_count")) > 0:
        reasons.append("unclosed_position")

    submitted_order_count = _safe_int(ledger_payload.get("submitted_order_count"))
    if submitted_order_count <= 0:
        reasons.append("runtime_order_lifecycle_missing")
    elif submitted_order_count < _safe_int(
        cast(object, getattr(metric_window, "order_count", None))
    ):
        reasons.append("runtime_ledger_submitted_order_count_mismatch")

    if (
        _runtime_ledger_hash_count(
            ledger_payload,
            payload_key="execution_policy_hash_counts",
            observed=observed,
            observed_key="runtime_ledger_execution_policy_hash_count",
        )
        <= 0
    ):
        reasons.append("runtime_ledger_execution_policy_hash_missing")
    if (
        _runtime_ledger_hash_count(
            ledger_payload,
            payload_key="cost_model_hash_counts",
            observed=observed,
            observed_key="runtime_ledger_cost_model_hash_count",
        )
        <= 0
    ):
        reasons.append("runtime_ledger_cost_model_hash_missing")
    if (
        _runtime_ledger_hash_count(
            ledger_payload,
            payload_key="lineage_hash_counts",
            observed=observed,
            observed_key="runtime_ledger_lineage_hash_count",
        )
        <= 0
    ):
        reasons.append("runtime_ledger_lineage_hash_missing")

    return _normalize_reason_codes(reasons)


def _mark_runtime_certificate_rejected(
    updated: dict[str, object],
    *,
    metric_window: StrategyHypothesisMetricWindow,
    promotion_decision: StrategyPromotionDecision,
    reason_codes: Sequence[object],
) -> dict[str, object]:
    normalized_reasons = _normalize_reason_codes(reason_codes)
    observed_raw = updated.get("observed")
    observed = (
        dict(cast(Mapping[str, object], observed_raw))
        if isinstance(observed_raw, Mapping)
        else {}
    )
    observed.update(
        {
            "runtime_window_certificate_rejected": True,
            "runtime_window_rejection_reasons": normalized_reasons,
            "metric_window_id": str(metric_window.id),
            "promotion_decision_id": str(promotion_decision.id),
            "metric_window_market_session_count": metric_window.market_session_count,
            "metric_window_decision_count": metric_window.decision_count,
            "metric_window_trade_count": metric_window.trade_count,
            "metric_window_order_count": metric_window.order_count,
            "metric_window_avg_abs_slippage_bps": metric_window.avg_abs_slippage_bps,
            "metric_window_post_cost_expectancy_bps": (
                metric_window.post_cost_expectancy_bps
            ),
        }
    )
    prior_reasons = [
        str(reason).strip()
        for reason in cast(Sequence[object], updated.get("reasons") or [])
        if str(reason).strip()
    ]
    updated["reasons"] = _normalize_reason_codes([*prior_reasons, *normalized_reasons])
    updated["informational_reasons"] = sorted(
        {
            *[
                str(reason)
                for reason in cast(
                    Sequence[object],
                    updated.get("informational_reasons") or [],
                )
                if str(reason).strip()
            ],
            "runtime_window_certificate_rejected",
        }
    )
    updated["promotion_eligible"] = False
    updated["promotion_decision_id"] = str(promotion_decision.id)
    updated["metric_window_id"] = str(metric_window.id)
    updated["observed"] = observed
    return updated


def _load_latest_runtime_ledger_summary(
    session: Session,
    *,
    hypothesis_ids: Sequence[str],
) -> dict[str, object]:
    normalized_ids = [
        hypothesis_id for hypothesis_id in hypothesis_ids if hypothesis_id
    ]
    by_hypothesis: dict[str, dict[str, object]] = {}
    retained_rows: list[dict[str, object]] = []
    if not normalized_ids:
        return {
            "by_hypothesis": by_hypothesis,
            "runtime_ledger_buckets": retained_rows,
            "query_status": "skipped",
            "query_reason_codes": ["runtime_ledger_hypothesis_scope_missing"],
            "query_limit": _RUNTIME_LEDGER_REPAIR_SCAN_LIMIT,
            "query_scope": "per_hypothesis_latest_runtime_ledger",
            "query_limit_per_hypothesis": _RUNTIME_LEDGER_SUMMARY_PER_HYPOTHESIS_LIMIT,
            "reason_codes": ["runtime_ledger_hypothesis_scope_missing"],
        }

    try:
        for hypothesis_id in normalized_ids:
            _maybe_set_runtime_ledger_status_statement_timeout(session)
            rows = list(
                session.execute(
                    select(StrategyRuntimeLedgerBucket)
                    .where(StrategyRuntimeLedgerBucket.hypothesis_id == hypothesis_id)
                    .order_by(
                        StrategyRuntimeLedgerBucket.bucket_ended_at.desc(),
                        StrategyRuntimeLedgerBucket.created_at.desc(),
                    )
                    .limit(_RUNTIME_LEDGER_SUMMARY_PER_HYPOTHESIS_LIMIT)
                ).scalars()
            )
            retained_for_hypothesis = 0
            for row in rows:
                payload = _runtime_ledger_bucket_payload(row)
                if retained_for_hypothesis < 8:
                    retained_rows.append(payload)
                    retained_for_hypothesis += 1

                current = by_hypothesis.get(row.hypothesis_id)
                if current is None:
                    by_hypothesis[row.hypothesis_id] = payload
                    continue
                current_is_live = (
                    str(current.get("observed_stage") or "").strip() == "live"
                )
                row_is_live = str(payload.get("observed_stage") or "").strip() == "live"
                if row_is_live and not current_is_live:
                    by_hypothesis[row.hypothesis_id] = payload
    except SQLAlchemyError as exc:
        logger.warning("Runtime ledger latest summary unavailable: %s", exc)
        _rollback_runtime_ledger_status_session(session)
        reason_code = (
            "runtime_ledger_summary_query_timeout"
            if _sqlalchemy_error_indicates_statement_timeout(exc)
            else "runtime_ledger_summary_query_unavailable"
        )
        return {
            "by_hypothesis": {},
            "runtime_ledger_buckets": [],
            "query_status": "timeout"
            if reason_code == "runtime_ledger_summary_query_timeout"
            else "unavailable",
            "query_reason_codes": [reason_code],
            "query_limit": _RUNTIME_LEDGER_REPAIR_SCAN_LIMIT,
            "query_scope": "per_hypothesis_latest_runtime_ledger",
            "query_limit_per_hypothesis": _RUNTIME_LEDGER_SUMMARY_PER_HYPOTHESIS_LIMIT,
            "reason_codes": [reason_code],
            "read_model_unavailable": True,
        }
    return {
        "by_hypothesis": by_hypothesis,
        "runtime_ledger_buckets": retained_rows,
        "query_status": "ok",
        "query_reason_codes": [],
        "query_limit": _RUNTIME_LEDGER_REPAIR_SCAN_LIMIT,
        "query_scope": "per_hypothesis_latest_runtime_ledger",
        "query_limit_per_hypothesis": _RUNTIME_LEDGER_SUMMARY_PER_HYPOTHESIS_LIMIT,
        "reason_codes": [],
    }


def _runtime_ledger_selection_score(payload: Mapping[str, object] | None) -> int:
    if not isinstance(payload, Mapping):
        return 0

    score = 0
    blockers = [
        str(reason).strip()
        for reason in cast(Sequence[object], payload.get("blockers") or [])
        if str(reason).strip()
    ]
    if not blockers:
        score += 1
    if _safe_text(payload.get("pnl_basis")) == POST_COST_PNL_BASIS:
        score += 1
    if (_safe_decimal(payload.get("filled_notional")) or Decimal("0")) > 0:
        score += 1
    if (_safe_decimal(payload.get("post_cost_expectancy_bps")) or Decimal("0")) > 0:
        score += 1
    if _safe_int(payload.get("closed_trade_count")) > 0:
        score += 1
    if _safe_int(payload.get("open_position_count")) == 0:
        score += 1
    if (
        _runtime_ledger_hash_count(
            payload,
            payload_key="execution_policy_hash_counts",
            observed={},
            observed_key="runtime_ledger_execution_policy_hash_count",
        )
        > 0
    ):
        score += 1
    if (
        _runtime_ledger_hash_count(
            payload,
            payload_key="cost_model_hash_counts",
            observed={},
            observed_key="runtime_ledger_cost_model_hash_count",
        )
        > 0
    ):
        score += 1
    if (
        _runtime_ledger_hash_count(
            payload,
            payload_key="lineage_hash_counts",
            observed={},
            observed_key="runtime_ledger_lineage_hash_count",
        )
        > 0
    ):
        score += 1
    return score


def _certificate_evidence_authority_score(
    *,
    observed_stage: str | None,
    runtime_ledger_bucket: Mapping[str, object] | None,
) -> int:
    if observed_stage == "live":
        return 2 if _runtime_ledger_selection_score(runtime_ledger_bucket) >= 9 else 0
    if observed_stage == "paper":
        return 1
    return 0


def _runtime_ledger_target_reason_codes(
    payload: Mapping[str, object],
    *,
    manifest: Mapping[str, object],
) -> list[str]:
    reasons: list[str] = []
    expected_candidates = _runtime_ledger_manifest_candidate_ids(manifest)
    actual_candidate = _safe_text(payload.get("candidate_id"))
    if expected_candidates:
        if actual_candidate is None:
            reasons.append("runtime_ledger_candidate_missing")
        elif actual_candidate not in expected_candidates:
            reasons.append("runtime_ledger_candidate_mismatch")

    expected_family = _normalized_strategy_family(manifest.get("strategy_family"))
    actual_family = _normalized_strategy_family(payload.get("strategy_family"))
    if (
        expected_family is not None
        and actual_family is not None
        and actual_family != expected_family
    ):
        reasons.append("runtime_ledger_strategy_family_mismatch")
    return reasons


def _runtime_ledger_manifest_candidate_ids(
    manifest: Mapping[str, object],
) -> set[str]:
    candidates: set[str] = set()
    primary_candidate = _safe_text(manifest.get("candidate_id"))
    if primary_candidate is not None:
        candidates.add(primary_candidate)
    raw_probation_candidates = manifest.get("paper_probation_candidate_ids")
    if isinstance(raw_probation_candidates, Sequence) and not isinstance(
        raw_probation_candidates, (str, bytes, bytearray)
    ):
        for raw_candidate in cast(Sequence[object], raw_probation_candidates):
            candidate = _safe_text(raw_candidate)
            if candidate is not None:
                candidates.add(candidate)
    return candidates


def _runtime_ledger_repair_reason_codes(
    payload: Mapping[str, object],
    *,
    manifest: Mapping[str, object],
) -> list[str]:
    reasons = [
        str(reason).strip()
        for reason in cast(Sequence[object], payload.get("blockers") or [])
        if str(reason).strip()
    ]
    reasons.extend(runtime_ledger_promotion_source_authority_blockers(payload))
    reasons.extend(_runtime_ledger_target_reason_codes(payload, manifest=manifest))
    if _safe_text(payload.get("observed_stage")) != "live":
        reasons.append("runtime_ledger_stage_not_live")
    if _safe_text(payload.get("pnl_basis")) != POST_COST_PNL_BASIS:
        reasons.append("runtime_ledger_pnl_basis_missing")
    if (_safe_decimal(payload.get("filled_notional")) or Decimal("0")) <= 0:
        reasons.append("runtime_ledger_filled_notional_missing")
    if _safe_int(payload.get("fill_count")) <= 0:
        reasons.append("runtime_ledger_fills_missing")
    if _safe_int(payload.get("closed_trade_count")) <= 0:
        reasons.append("runtime_ledger_closed_trades_missing")
    if _safe_int(payload.get("open_position_count")) > 0:
        reasons.append("unclosed_position")
    if (
        _safe_decimal(payload.get("net_strategy_pnl_after_costs")) or Decimal("0")
    ) <= 0:
        reasons.append("post_cost_pnl_non_positive")
    expectancy_bps = _safe_decimal(payload.get("post_cost_expectancy_bps"))
    if expectancy_bps is None:
        reasons.append("runtime_ledger_expectancy_missing")
    elif expectancy_bps <= 0:
        reasons.append("post_cost_expectancy_non_positive")
    if (
        _runtime_ledger_hash_count(
            payload,
            payload_key="execution_policy_hash_counts",
            observed={},
            observed_key="runtime_ledger_execution_policy_hash_count",
        )
        <= 0
    ):
        reasons.append("runtime_ledger_execution_policy_hash_missing")
    if (
        _runtime_ledger_hash_count(
            payload,
            payload_key="cost_model_hash_counts",
            observed={},
            observed_key="runtime_ledger_cost_model_hash_count",
        )
        <= 0
    ):
        reasons.append("runtime_ledger_cost_model_hash_missing")
    if (
        _runtime_ledger_hash_count(
            payload,
            payload_key="lineage_hash_counts",
            observed={},
            observed_key="runtime_ledger_lineage_hash_count",
        )
        <= 0
    ):
        reasons.append("runtime_ledger_lineage_hash_missing")
    return _normalize_reason_codes(reasons)


def _runtime_ledger_repair_score(
    candidate: Mapping[str, object],
) -> tuple[int, int, int, int, int, int, int, Decimal, Decimal, Decimal, float]:
    reason_codes = set(
        str(reason).strip()
        for reason in cast(Sequence[object], candidate.get("reason_codes") or [])
        if str(reason).strip()
    )
    filled_notional = _safe_decimal(candidate.get("filled_notional")) or Decimal("0")
    net_pnl = _safe_decimal(candidate.get("net_strategy_pnl_after_costs")) or Decimal(
        "0"
    )
    expectancy_bps = _safe_decimal(
        candidate.get("post_cost_expectancy_bps")
    ) or Decimal("0")
    ended_at = _coerce_aware_datetime(candidate.get("bucket_ended_at"))
    observed_stage = _safe_text(candidate.get("observed_stage"))
    payload: dict[str, object] = {}
    raw_bucket = candidate.get("runtime_ledger_bucket")
    if isinstance(raw_bucket, Mapping):
        payload.update(cast(Mapping[str, object], raw_bucket))
    payload.update(
        {
            str(key): value
            for key, value in candidate.items()
            if key != "runtime_ledger_bucket"
        }
    )
    source_authority_present = int(
        runtime_ledger_promotion_source_authority_present(payload)
    )
    clear_live_candidate = observed_stage == "live" and not reason_codes
    return (
        (
            2 if clear_live_candidate else source_authority_present,
            source_authority_present,
            int(filled_notional > 0),
            int(_safe_int(candidate.get("fill_count")) > 0),
            int(_safe_int(candidate.get("closed_trade_count")) > 0),
            int(net_pnl > 0),
            int(expectancy_bps > 0),
            net_pnl,
            expectancy_bps,
            filled_notional,
            ended_at.timestamp() if ended_at is not None else 0.0,
        )
        if not clear_live_candidate
        else (
            2,
            source_authority_present,
            2,
            2,
            2,
            2,
            2,
            net_pnl,
            expectancy_bps,
            filled_notional,
            ended_at.timestamp() if ended_at is not None else 0.0,
        )
    )


__all__: tuple[str, ...] = ()

# Public aliases used by split modules.
certificate_evidence_authority_score = _certificate_evidence_authority_score
certificate_runtime_ledger_reason_codes = _certificate_runtime_ledger_reason_codes
load_latest_runtime_ledger_summary = _load_latest_runtime_ledger_summary
mark_runtime_certificate_rejected = _mark_runtime_certificate_rejected
runtime_ledger_manifest_candidate_ids = _runtime_ledger_manifest_candidate_ids
runtime_ledger_repair_reason_codes = _runtime_ledger_repair_reason_codes
runtime_ledger_repair_score = _runtime_ledger_repair_score
runtime_ledger_selection_score = _runtime_ledger_selection_score
runtime_ledger_target_reason_codes = _runtime_ledger_target_reason_codes
