# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
"""Promotion certificate loading and runtime evidence merging."""

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

from .paper_probation import (
    BOUNDED_PAPER_ROUTE_COLLECTION_PROMOTION_BLOCKERS,
    BOUNDED_PAPER_ROUTE_COLLECTION_SCOPE,
    BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_KIND,
    HPAIRS_BOUNDED_COLLECTION_CANDIDATE_ID,
    HPAIRS_BOUNDED_COLLECTION_HYPOTHESIS_ID,
    RUNTIME_LEDGER_PAPER_PROBATION_IMPORT_SCHEMA_VERSION,
    RUNTIME_LEDGER_PAPER_PROBATION_PROMOTION_BLOCKERS,
    RUNTIME_LEDGER_PAPER_PROBATION_SOURCE_DSN_ENV,
    RUNTIME_LEDGER_PAPER_PROBATION_SOURCE_KIND,
    RUNTIME_LEDGER_PAPER_PROBATION_TARGET_DSN_ENV,
    RUNTIME_LEDGER_SOURCE_COLLECTION_LIVE_PAPER_EVIDENCE_REQUIREMENTS,
    RUNTIME_LEDGER_SOURCE_COLLECTION_PROFIT_TARGET_NET_PNL_AFTER_COSTS,
    RUNTIME_LEDGER_SOURCE_COLLECTION_PROFIT_TARGET_SELECTION_REASON,
    RUNTIME_LEDGER_SOURCE_COLLECTION_PROMOTION_BLOCKERS,
    RUNTIME_LEDGER_SOURCE_COLLECTION_SAFE_EVIDENCE_COLLECTION_PATH,
    RUNTIME_LEDGER_SOURCE_COLLECTION_SOURCE_KIND,
    RUNTIME_LEDGER_SOURCE_COLLECTION_TARGET_DSN_ENV,
    BOUNDED_PAPER_ROUTE_COLLECTION_PROMOTION_BLOCKERS as _BOUNDED_PAPER_ROUTE_COLLECTION_PROMOTION_BLOCKERS,
    BOUNDED_PAPER_ROUTE_COLLECTION_SCOPE as _BOUNDED_PAPER_ROUTE_COLLECTION_SCOPE,
    BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_KIND as _BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_KIND,
    HPAIRS_BOUNDED_COLLECTION_CANDIDATE_ID as _HPAIRS_BOUNDED_COLLECTION_CANDIDATE_ID,
    HPAIRS_BOUNDED_COLLECTION_HYPOTHESIS_ID as _HPAIRS_BOUNDED_COLLECTION_HYPOTHESIS_ID,
    RUNTIME_LEDGER_PAPER_PROBATION_ALLOWED_REASONS as _RUNTIME_LEDGER_PAPER_PROBATION_ALLOWED_REASONS,
    RUNTIME_LEDGER_PAPER_PROBATION_IMPORT_SCHEMA_VERSION as _RUNTIME_LEDGER_PAPER_PROBATION_IMPORT_SCHEMA_VERSION,
    RUNTIME_LEDGER_PAPER_PROBATION_MIN_CLOSED_ROUND_TRIPS as _RUNTIME_LEDGER_PAPER_PROBATION_MIN_CLOSED_ROUND_TRIPS,
    RUNTIME_LEDGER_PAPER_PROBATION_PROMOTION_BLOCKERS as _RUNTIME_LEDGER_PAPER_PROBATION_PROMOTION_BLOCKERS,
    RUNTIME_LEDGER_PAPER_PROBATION_REASON as _RUNTIME_LEDGER_PAPER_PROBATION_REASON,
    RUNTIME_LEDGER_PAPER_PROBATION_SOURCE_DSN_ENV as _RUNTIME_LEDGER_PAPER_PROBATION_SOURCE_DSN_ENV,
    RUNTIME_LEDGER_PAPER_PROBATION_SOURCE_KIND as _RUNTIME_LEDGER_PAPER_PROBATION_SOURCE_KIND,
    RUNTIME_LEDGER_PAPER_PROBATION_TARGET_DSN_ENV as _RUNTIME_LEDGER_PAPER_PROBATION_TARGET_DSN_ENV,
    RUNTIME_LEDGER_SOURCE_COLLECTION_BUCKET_SOURCE as _RUNTIME_LEDGER_SOURCE_COLLECTION_BUCKET_SOURCE,
    RUNTIME_LEDGER_SOURCE_COLLECTION_BUCKET_SOURCE_DSN_ENVS as _RUNTIME_LEDGER_SOURCE_COLLECTION_BUCKET_SOURCE_DSN_ENVS,
    RUNTIME_LEDGER_SOURCE_COLLECTION_LIVE_PAPER_EVIDENCE_REQUIREMENTS as _RUNTIME_LEDGER_SOURCE_COLLECTION_LIVE_PAPER_EVIDENCE_REQUIREMENTS,
    RUNTIME_LEDGER_SOURCE_COLLECTION_PROFIT_TARGET_BLOCKER as _RUNTIME_LEDGER_SOURCE_COLLECTION_PROFIT_TARGET_BLOCKER,
    RUNTIME_LEDGER_SOURCE_COLLECTION_PROFIT_TARGET_NET_PNL_AFTER_COSTS as _RUNTIME_LEDGER_SOURCE_COLLECTION_PROFIT_TARGET_NET_PNL_AFTER_COSTS,
    RUNTIME_LEDGER_SOURCE_COLLECTION_PROFIT_TARGET_SELECTION_REASON as _RUNTIME_LEDGER_SOURCE_COLLECTION_PROFIT_TARGET_SELECTION_REASON,
    RUNTIME_LEDGER_SOURCE_COLLECTION_PROMOTION_BLOCKERS as _RUNTIME_LEDGER_SOURCE_COLLECTION_PROMOTION_BLOCKERS,
    RUNTIME_LEDGER_SOURCE_COLLECTION_SAFE_EVIDENCE_COLLECTION_PATH as _RUNTIME_LEDGER_SOURCE_COLLECTION_SAFE_EVIDENCE_COLLECTION_PATH,
    RUNTIME_LEDGER_SOURCE_COLLECTION_SOURCE_DSN_ENV as _RUNTIME_LEDGER_SOURCE_COLLECTION_SOURCE_DSN_ENV,
    RUNTIME_LEDGER_SOURCE_COLLECTION_SOURCE_KIND as _RUNTIME_LEDGER_SOURCE_COLLECTION_SOURCE_KIND,
    RUNTIME_LEDGER_SOURCE_COLLECTION_TARGET_DSN_ENV as _RUNTIME_LEDGER_SOURCE_COLLECTION_TARGET_DSN_ENV,
    RUNTIME_LEDGER_SOURCE_COLLECTION_TRIGGER_REASONS as _RUNTIME_LEDGER_SOURCE_COLLECTION_TRIGGER_REASONS,
    bounded_source_collection_probe_window as _bounded_source_collection_probe_window,
    hypothesis_manifest_ref as _hypothesis_manifest_ref,
    runtime_ledger_paper_probation_activity_blockers as _runtime_ledger_paper_probation_activity_blockers,
    runtime_ledger_paper_probation_blockers as _runtime_ledger_paper_probation_blockers,
    runtime_ledger_paper_probation_bucket_ref as _runtime_ledger_paper_probation_bucket_ref,
    runtime_ledger_paper_probation_candidates as _runtime_ledger_paper_probation_candidates,
    runtime_ledger_paper_probation_eligible as _runtime_ledger_paper_probation_eligible,
    runtime_ledger_paper_probation_hash_blockers as _runtime_ledger_paper_probation_hash_blockers,
    runtime_ledger_paper_probation_payload as _runtime_ledger_paper_probation_payload,
    runtime_ledger_paper_probation_profit_blockers as _runtime_ledger_paper_probation_profit_blockers,
    runtime_ledger_paper_probation_strategy_name as _runtime_ledger_paper_probation_strategy_name,
    runtime_ledger_source_collection_candidate as _runtime_ledger_source_collection_candidate,
    runtime_ledger_source_collection_candidates as _runtime_ledger_source_collection_candidates,
    runtime_ledger_source_collection_import_candidate as _runtime_ledger_source_collection_import_candidate,
    runtime_ledger_source_collection_profit_target_candidate as _runtime_ledger_source_collection_profit_target_candidate,
    runtime_ledger_source_collection_profit_target_metadata as _runtime_ledger_source_collection_profit_target_metadata,
    runtime_ledger_source_collection_source_dsn_env as _runtime_ledger_source_collection_source_dsn_env,
    runtime_ledger_source_collection_target_progress_payload as _runtime_ledger_source_collection_target_progress_payload,
    strategy_lookup_names as _strategy_lookup_names,
    bounded_source_collection_probe_window,
    hypothesis_manifest_ref,
    runtime_ledger_paper_probation_blockers,
    runtime_ledger_paper_probation_bucket_ref,
    runtime_ledger_paper_probation_payload,
    runtime_ledger_paper_probation_strategy_name,
    runtime_ledger_source_collection_import_candidate,
    runtime_ledger_source_collection_source_dsn_env,
    strategy_lookup_names,
)

from .import_plan import (
    RuntimeLedgerImportCandidate as _RuntimeLedgerImportCandidate,
    blocked_import_target as _blocked_import_target,
    bounded_paper_route_manifest_collection_targets as _bounded_paper_route_manifest_collection_targets,
    candidate_reason_codes as _candidate_reason_codes,
    duplicate_import_target as _duplicate_import_target,
    missing_import_target as _missing_import_target,
    paper_probation_eligible_total_with_runtime_ledger as _paper_probation_eligible_total_with_runtime_ledger,
    runtime_ledger_base_import_target as _runtime_ledger_base_import_target,
    runtime_ledger_import_candidate as _runtime_ledger_import_candidate,
    runtime_ledger_import_handoff as _runtime_ledger_import_handoff,
    runtime_ledger_import_plan_has_target as _runtime_ledger_import_plan_has_target,
    runtime_ledger_import_plan_payload as _runtime_ledger_import_plan_payload,
    runtime_ledger_import_probation_reason as _runtime_ledger_import_probation_reason,
    runtime_ledger_import_selector as _runtime_ledger_import_selector,
    runtime_ledger_import_target as _runtime_ledger_import_target,
    runtime_ledger_import_target_key as _runtime_ledger_import_target_key,
    runtime_ledger_paper_probation_import_plan as _runtime_ledger_paper_probation_import_plan,
    source_collection_import_target_metadata as _source_collection_import_target_metadata,
    source_collection_reason_codes as _source_collection_reason_codes,
    with_bounded_paper_route_manifest_collection_targets as _with_bounded_paper_route_manifest_collection_targets,
)

from .repair_candidates import (
    certificate_evidence_authority_score as _certificate_evidence_authority_score,
    extract_runtime_summary as _extract_runtime_summary,
    load_runtime_ledger_repair_candidates as _load_runtime_ledger_repair_candidates,
    refresh_runtime_summary_totals as _refresh_runtime_summary_totals,
    runtime_ledger_repair_reason_codes as _runtime_ledger_repair_reason_codes,
    runtime_ledger_repair_score as _runtime_ledger_repair_score,
    runtime_ledger_selection_score as _runtime_ledger_selection_score,
    build_submission_gate_market_context_status,
)
from .runtime_certificates import (
    certificate_runtime_ledger_reason_codes as _certificate_runtime_ledger_reason_codes,
    load_latest_runtime_ledger_summary as _load_latest_runtime_ledger_summary,
    mark_runtime_certificate_rejected as _mark_runtime_certificate_rejected,
    runtime_ledger_manifest_candidate_ids as _runtime_ledger_manifest_candidate_ids,
    runtime_ledger_target_reason_codes as _runtime_ledger_target_reason_codes,
)


def _load_latest_certificate_evidence(
    session: Session,
    *,
    hypothesis_ids: Sequence[str],
    now: datetime | None = None,
    max_age_seconds: int | None = None,
) -> list[dict[str, object]]:
    normalized_ids = [
        hypothesis_id for hypothesis_id in hypothesis_ids if hypothesis_id
    ]
    if not normalized_ids:
        return []

    evidence: list[dict[str, object]] = []
    try:
        for hypothesis_id in normalized_ids:
            _compat_symbol(
                "_maybe_set_runtime_ledger_status_statement_timeout",
                _maybe_set_runtime_ledger_status_statement_timeout,
            )(session)
            metric_windows = list(
                session.execute(
                    select(StrategyHypothesisMetricWindow)
                    .where(
                        StrategyHypothesisMetricWindow.hypothesis_id == hypothesis_id
                    )
                    .order_by(
                        StrategyHypothesisMetricWindow.window_ended_at.desc().nullslast(),
                        StrategyHypothesisMetricWindow.created_at.desc(),
                    )
                    .limit(_CERTIFICATE_EVIDENCE_WINDOW_LIMIT)
                ).scalars()
            )
            candidate_rows: list[dict[str, object]] = []
            for metric_window in metric_windows:
                _compat_symbol(
                    "_maybe_set_runtime_ledger_status_statement_timeout",
                    _maybe_set_runtime_ledger_status_statement_timeout,
                )(session)
                promotion_decision = (
                    session.execute(
                        select(StrategyPromotionDecision)
                        .where(StrategyPromotionDecision.hypothesis_id == hypothesis_id)
                        .where(
                            StrategyPromotionDecision.run_id == metric_window.run_id,
                            StrategyPromotionDecision.candidate_id
                            == metric_window.candidate_id,
                            StrategyPromotionDecision.promotion_target
                            == metric_window.observed_stage,
                        )
                        .order_by(StrategyPromotionDecision.created_at.desc())
                        .limit(1)
                    )
                    .scalars()
                    .first()
                )

                runtime_ledger_bucket = None
                _compat_symbol(
                    "_maybe_set_runtime_ledger_status_statement_timeout",
                    _maybe_set_runtime_ledger_status_statement_timeout,
                )(session)
                ledger_rows = list(
                    session.execute(
                        select(StrategyRuntimeLedgerBucket)
                        .where(
                            StrategyRuntimeLedgerBucket.hypothesis_id == hypothesis_id
                        )
                        .where(
                            StrategyRuntimeLedgerBucket.run_id == metric_window.run_id,
                            StrategyRuntimeLedgerBucket.candidate_id
                            == metric_window.candidate_id,
                            StrategyRuntimeLedgerBucket.observed_stage
                            == metric_window.observed_stage,
                        )
                        .order_by(
                            StrategyRuntimeLedgerBucket.bucket_ended_at.desc(),
                            StrategyRuntimeLedgerBucket.created_at.desc(),
                        )
                        .limit(_CERTIFICATE_EVIDENCE_RUNTIME_LEDGER_LIMIT)
                    ).scalars()
                )
                for ledger in ledger_rows:
                    if _runtime_ledger_bucket_matches_metric_window(
                        ledger,
                        metric_window=metric_window,
                    ):
                        runtime_ledger_bucket = _runtime_ledger_bucket_payload(ledger)
                        break
                candidate_rows.append(
                    {
                        "hypothesis_id": hypothesis_id,
                        "metric_window": metric_window,
                        "promotion_decision": promotion_decision,
                        "runtime_ledger_bucket": runtime_ledger_bucket,
                        "query_status": "ok",
                        "query_reason_codes": [],
                        "query_scope": "per_hypothesis_certificate_evidence",
                        "query_limit_per_hypothesis": _CERTIFICATE_EVIDENCE_WINDOW_LIMIT,
                        "runtime_ledger_query_limit": _CERTIFICATE_EVIDENCE_RUNTIME_LEDGER_LIMIT,
                        "reason_codes": [],
                    }
                )
            if not candidate_rows:
                evidence.append(
                    {
                        "hypothesis_id": hypothesis_id,
                        "metric_window": None,
                        "promotion_decision": None,
                        "runtime_ledger_bucket": None,
                        "query_status": "ok",
                        "query_reason_codes": [],
                        "query_scope": "per_hypothesis_certificate_evidence",
                        "query_limit_per_hypothesis": _CERTIFICATE_EVIDENCE_WINDOW_LIMIT,
                        "runtime_ledger_query_limit": _CERTIFICATE_EVIDENCE_RUNTIME_LEDGER_LIMIT,
                        "reason_codes": ["hypothesis_window_evidence_missing"],
                    }
                )
                continue
            evidence.append(
                max(
                    candidate_rows,
                    key=lambda row: _certificate_evidence_selection_key(
                        row,
                        now=now,
                        max_age_seconds=max_age_seconds,
                    ),
                )
            )
    except SQLAlchemyError as exc:
        logger.warning("Certificate evidence read model unavailable: %s", exc)
        _rollback_runtime_ledger_status_session(session)
        reason_code = (
            "certificate_evidence_query_timeout"
            if _sqlalchemy_error_indicates_statement_timeout(exc)
            else "certificate_evidence_unavailable"
        )
        rows = _unavailable_certificate_evidence_rows(
            hypothesis_ids=normalized_ids,
            reason_code=reason_code,
        )
        for row in rows:
            row["query_status"] = (
                "timeout"
                if reason_code == "certificate_evidence_query_timeout"
                else "unavailable"
            )
            row["query_reason_codes"] = [reason_code]
            row["query_scope"] = "per_hypothesis_certificate_evidence"
            row["query_limit_per_hypothesis"] = _CERTIFICATE_EVIDENCE_WINDOW_LIMIT
            row["runtime_ledger_query_limit"] = (
                _CERTIFICATE_EVIDENCE_RUNTIME_LEDGER_LIMIT
            )
        return rows
    return evidence


def _window_evidence_issued_at(
    metric_window: StrategyHypothesisMetricWindow,
) -> datetime | None:
    return _coerce_aware_datetime(
        metric_window.window_ended_at or metric_window.created_at
    )


def _certificate_evidence_is_fresh(
    metric_window: StrategyHypothesisMetricWindow,
    *,
    max_age_seconds: int,
    now: datetime,
) -> bool:
    issued_at = _window_evidence_issued_at(metric_window)
    if issued_at is None:
        return False
    return max_age_seconds <= 0 or issued_at >= now - timedelta(seconds=max_age_seconds)


def _certificate_capital_stage(
    metric_window: StrategyHypothesisMetricWindow,
    promotion_decision: StrategyPromotionDecision,
) -> str | None:
    window_stage = _safe_text(metric_window.capital_stage)
    decision_stage = _safe_text(promotion_decision.state)
    ranked_stages = [
        stage
        for stage in (window_stage, decision_stage)
        if stage is not None and _stage_rank(stage) >= 0
    ]
    if not ranked_stages:
        return None
    return min(ranked_stages, key=_stage_rank)


def _metric_window_activity_reason_codes(
    metric_window: StrategyHypothesisMetricWindow,
) -> list[str]:
    reasons: list[str] = []
    if _safe_int(metric_window.market_session_count) <= 0:
        reasons.append("hypothesis_window_market_sessions_missing")
    if _safe_int(metric_window.decision_count) <= 0:
        reasons.append("hypothesis_window_decisions_missing")
    if _safe_int(metric_window.trade_count) <= 0:
        reasons.append("hypothesis_window_trades_missing")
    if _safe_int(metric_window.order_count) <= 0:
        reasons.append("hypothesis_window_orders_missing")

    expectancy_bps = _safe_decimal(metric_window.post_cost_expectancy_bps)
    if expectancy_bps is None or expectancy_bps <= 0:
        reasons.append("hypothesis_window_post_cost_expectancy_non_positive")
    payload_raw = getattr(metric_window, "payload_json", None)
    payload: Mapping[str, object] = (
        cast(Mapping[str, object], payload_raw)
        if isinstance(payload_raw, Mapping)
        else cast(Mapping[str, object], {})
    )
    basis_counts: object | None = payload.get("post_cost_basis_counts")
    if (
        isinstance(basis_counts, Mapping)
        and _safe_int(payload.get("post_cost_promotion_sample_count")) <= 0
    ):
        reasons.append("hypothesis_window_post_cost_pnl_basis_missing")
    observed_stage = _safe_text(getattr(metric_window, "observed_stage", None))
    if observed_stage == "live":
        promotion_sample_count = _safe_int(
            payload.get("post_cost_promotion_sample_count")
        )
        runtime_ledger_sample_count = _safe_int(
            payload.get("runtime_ledger_notional_weighted_sample_count")
        )
        aggregation = _safe_text(payload.get("post_cost_expectancy_aggregation"))
        if (
            promotion_sample_count <= 0
            or runtime_ledger_sample_count < promotion_sample_count
            or aggregation != "runtime_ledger_notional_weighted"
        ):
            reasons.append("runtime_ledger_pnl_basis_missing")

    avg_abs_slippage_bps = _safe_decimal(metric_window.avg_abs_slippage_bps)
    slippage_budget_bps = _safe_decimal(metric_window.slippage_budget_bps)
    if (
        avg_abs_slippage_bps is not None
        and slippage_budget_bps is not None
        and avg_abs_slippage_bps > slippage_budget_bps
    ):
        reasons.append("hypothesis_window_slippage_budget_exceeded")
    return reasons


def _promotion_decision_blocking_reason_codes(
    promotion_decision: StrategyPromotionDecision,
) -> list[str]:
    payload_raw = getattr(promotion_decision, "payload_json", None)
    payload: Mapping[str, object] = (
        cast(Mapping[str, object], payload_raw)
        if isinstance(payload_raw, Mapping)
        else cast(Mapping[str, object], {})
    )
    reasons = [
        str(reason).strip()
        for reason in cast(
            Sequence[object], payload.get("promotion_blocking_reasons") or []
        )
        if str(reason).strip()
    ]
    summary = _safe_text(getattr(promotion_decision, "reason_summary", None))
    satisfied_summaries = {
        "runtime_evidence_thresholds_satisfied",
        "paper_runtime_evidence_thresholds_satisfied",
        "ready",
    }
    if summary and summary not in satisfied_summaries:
        reasons.extend(
            reason.strip() for reason in summary.split(",") if reason.strip()
        )
    if _safe_bool(getattr(promotion_decision, "allowed", True)) is False:
        reasons.append("promotion_decision_not_allowed")
    return _normalize_reason_codes(reasons)


def _certificate_evidence_selection_key(
    row: Mapping[str, object],
    *,
    now: datetime | None,
    max_age_seconds: int | None,
) -> tuple[int, int, int, int, int, int, int, int, Decimal, float]:
    metric_window = cast(
        StrategyHypothesisMetricWindow | None, row.get("metric_window")
    )
    promotion_decision = cast(
        StrategyPromotionDecision | None, row.get("promotion_decision")
    )
    runtime_ledger_bucket = cast(
        Mapping[str, object] | None, row.get("runtime_ledger_bucket")
    )
    if metric_window is None:
        return (0, 0, 0, 0, 0, 0, 0, 0, Decimal("0"), 0.0)

    issued_at = _coerce_aware_datetime(
        getattr(metric_window, "window_ended_at", None)
        or getattr(metric_window, "created_at", None)
    )
    fresh_score = 1
    if now is not None and max_age_seconds is not None and max_age_seconds > 0:
        fresh_score = int(
            issued_at is not None
            and issued_at >= now - timedelta(seconds=max_age_seconds)
        )
    observed_stage = _safe_text(getattr(metric_window, "observed_stage", None))
    stage_score = {"live": 2, "paper": 1}.get(observed_stage or "", 0)
    runtime_ledger_score = _runtime_ledger_selection_score(runtime_ledger_bucket)
    authority_score = _certificate_evidence_authority_score(
        observed_stage=observed_stage,
        runtime_ledger_bucket=runtime_ledger_bucket,
    )
    decision_score = 0
    if promotion_decision is not None:
        decision_score = int(
            _safe_bool(getattr(promotion_decision, "allowed", False)) is True
            and not _promotion_decision_blocking_reason_codes(promotion_decision)
        )
    activity_score = int(not _metric_window_activity_reason_codes(metric_window))
    continuity_score = int(
        bool(getattr(metric_window, "continuity_ok", False))
        and bool(getattr(metric_window, "drift_ok", False))
        and _safe_text(getattr(metric_window, "dependency_quorum_decision", None))
        == "allow"
    )
    capital_rank = max(0, _stage_rank(getattr(metric_window, "capital_stage", None)))
    sample_count = _safe_int(getattr(metric_window, "order_count", None))
    expectancy_bps = _safe_decimal(
        getattr(metric_window, "post_cost_expectancy_bps", None)
    ) or Decimal("0")
    issued_ts = issued_at.timestamp() if issued_at is not None else 0.0
    return (
        fresh_score,
        authority_score,
        runtime_ledger_score,
        stage_score,
        decision_score,
        activity_score,
        continuity_score,
        capital_rank + sample_count,
        expectancy_bps,
        issued_ts,
    )


def _merge_runtime_certificate_evidence(
    items: Sequence[Mapping[str, Any]],
    *,
    evidence: Sequence[Mapping[str, object]],
    now: datetime,
    max_age_seconds: int,
) -> list[dict[str, object]]:
    evidence_by_hypothesis = {
        str(row.get("hypothesis_id") or "").strip(): row
        for row in evidence
        if str(row.get("hypothesis_id") or "").strip()
    }
    merged: list[dict[str, object]] = []
    for item in items:
        updated: dict[str, object] = dict(item)
        hypothesis_id = str(updated.get("hypothesis_id") or "").strip()
        row = evidence_by_hypothesis.get(hypothesis_id)
        if not row:
            merged.append(updated)
            continue

        metric_window = cast(
            StrategyHypothesisMetricWindow | None, row.get("metric_window")
        )
        promotion_decision = cast(
            StrategyPromotionDecision | None, row.get("promotion_decision")
        )
        if metric_window is None or promotion_decision is None:
            merged.append(updated)
            continue
        if not _certificate_evidence_is_fresh(
            metric_window,
            max_age_seconds=max_age_seconds,
            now=now,
        ):
            merged.append(updated)
            continue
        if not bool(metric_window.continuity_ok) or not bool(metric_window.drift_ok):
            merged.append(updated)
            continue
        if _safe_text(metric_window.dependency_quorum_decision) != "allow":
            merged.append(updated)
            continue
        decision_blockers = _promotion_decision_blocking_reason_codes(
            promotion_decision
        )
        if decision_blockers:
            updated = _mark_runtime_certificate_rejected(
                updated,
                metric_window=metric_window,
                promotion_decision=promotion_decision,
                reason_codes=decision_blockers,
            )
            merged.append(updated)
            continue
        activity_reason_codes = _metric_window_activity_reason_codes(metric_window)
        if activity_reason_codes:
            updated = _mark_runtime_certificate_rejected(
                updated,
                metric_window=metric_window,
                promotion_decision=promotion_decision,
                reason_codes=activity_reason_codes,
            )
            merged.append(updated)
            continue

        capital_stage = _certificate_capital_stage(metric_window, promotion_decision)
        if capital_stage is None:
            merged.append(updated)
            continue
        observed_stage = _safe_text(getattr(metric_window, "observed_stage", None))
        if observed_stage == "paper":
            issued_at = _window_evidence_issued_at(metric_window)
            candidate_id = (
                _safe_text(metric_window.candidate_id)
                or _safe_text(promotion_decision.candidate_id)
                or _safe_text(updated.get("candidate_id"))
            )
            observed = (
                dict(cast(Mapping[str, Any], updated.get("observed")))
                if isinstance(updated.get("observed"), Mapping)
                else {}
            )
            observed.update(
                {
                    "runtime_window_certificate_readiness_applied": True,
                    "runtime_window_paper_probation_applied": True,
                    "paper_probation_evidence_collection_only": True,
                    "paper_probation_target_capital_stage": capital_stage,
                    "runtime_window_prior_reasons": list(
                        cast(Sequence[object], updated.get("reasons") or [])
                    ),
                    "metric_window_id": str(metric_window.id),
                    "promotion_decision_id": str(promotion_decision.id),
                    "metric_window_issued_at": issued_at.isoformat()
                    if issued_at is not None
                    else None,
                    "metric_window_market_session_count": metric_window.market_session_count,
                    "metric_window_decision_count": metric_window.decision_count,
                    "metric_window_trade_count": metric_window.trade_count,
                    "metric_window_order_count": metric_window.order_count,
                    "metric_window_avg_abs_slippage_bps": metric_window.avg_abs_slippage_bps,
                    "metric_window_post_cost_expectancy_bps": metric_window.post_cost_expectancy_bps,
                }
            )
            if candidate_id is not None:
                updated["candidate_id"] = candidate_id
            updated.update(
                {
                    "state": "shadow",
                    "capital_stage": "shadow",
                    "capital_multiplier": "0",
                    "promotion_eligible": False,
                    "paper_probation_eligible": True,
                    "paper_probation_target_capital_stage": capital_stage,
                    "rollback_required": False,
                    "reasons": ["paper_probation_evidence_collection_only"],
                    "informational_reasons": sorted(
                        {
                            *[
                                str(reason)
                                for reason in cast(
                                    Sequence[object],
                                    updated.get("informational_reasons") or [],
                                )
                                if str(reason).strip()
                            ],
                            "runtime_window_certificate_readiness_applied",
                            "runtime_window_paper_probation_applied",
                        }
                    ),
                    "promotion_decision_id": str(promotion_decision.id),
                    "metric_window_id": str(metric_window.id),
                    "observed": observed,
                }
            )
            merged.append(updated)
            continue
        if observed_stage != "live":
            merged.append(updated)
            continue
        if _stage_rank(capital_stage) <= _stage_rank("shadow"):
            merged.append(updated)
            continue
        runtime_ledger_reason_codes = _certificate_runtime_ledger_reason_codes(
            evidence_row=row,
            runtime_item=updated,
            metric_window=metric_window,
            promotion_decision=promotion_decision,
        )
        if runtime_ledger_reason_codes:
            updated = _mark_runtime_certificate_rejected(
                updated,
                metric_window=metric_window,
                promotion_decision=promotion_decision,
                reason_codes=runtime_ledger_reason_codes,
            )
            merged.append(updated)
            continue

        issued_at = _window_evidence_issued_at(metric_window)
        candidate_id = (
            _safe_text(metric_window.candidate_id)
            or _safe_text(promotion_decision.candidate_id)
            or _safe_text(updated.get("candidate_id"))
        )
        observed = (
            dict(cast(Mapping[str, Any], updated.get("observed")))
            if isinstance(updated.get("observed"), Mapping)
            else {}
        )
        observed.update(
            {
                "runtime_window_certificate_applied": True,
                "runtime_window_prior_reasons": list(
                    cast(Sequence[object], updated.get("reasons") or [])
                ),
                "metric_window_id": str(metric_window.id),
                "promotion_decision_id": str(promotion_decision.id),
                "metric_window_issued_at": issued_at.isoformat()
                if issued_at is not None
                else None,
                "metric_window_market_session_count": metric_window.market_session_count,
                "metric_window_decision_count": metric_window.decision_count,
                "metric_window_trade_count": metric_window.trade_count,
                "metric_window_order_count": metric_window.order_count,
                "metric_window_avg_abs_slippage_bps": metric_window.avg_abs_slippage_bps,
                "metric_window_post_cost_expectancy_bps": metric_window.post_cost_expectancy_bps,
            }
        )
        if candidate_id is not None:
            updated["candidate_id"] = candidate_id
        updated.update(
            {
                "state": "canary_live"
                if _stage_rank(capital_stage) < _stage_rank("0.50x live")
                else "scaled_live",
                "capital_stage": capital_stage,
                "capital_multiplier": {
                    "0.10x canary": "0.10",
                    "0.25x canary": "0.25",
                    "0.50x live": "0.50",
                    "1.00x live": "1.00",
                }.get(capital_stage, str(updated.get("capital_multiplier") or "0")),
                "promotion_eligible": True,
                "rollback_required": False,
                "reasons": [],
                "informational_reasons": sorted(
                    {
                        *[
                            str(reason)
                            for reason in cast(
                                Sequence[object],
                                updated.get("informational_reasons") or [],
                            )
                            if str(reason).strip()
                        ],
                        "runtime_window_certificate_applied",
                    }
                ),
                "promotion_decision_id": str(promotion_decision.id),
                "metric_window_id": str(metric_window.id),
                "observed": observed,
            }
        )
        merged.append(updated)
    return merged


__all__: tuple[str, ...] = ()

# Public aliases used by split modules.
certificate_capital_stage = _certificate_capital_stage
certificate_evidence_is_fresh = _certificate_evidence_is_fresh
certificate_evidence_selection_key = _certificate_evidence_selection_key
load_latest_certificate_evidence = _load_latest_certificate_evidence
merge_runtime_certificate_evidence = _merge_runtime_certificate_evidence
metric_window_activity_reason_codes = _metric_window_activity_reason_codes
promotion_decision_blocking_reason_codes = _promotion_decision_blocking_reason_codes
window_evidence_issued_at = _window_evidence_issued_at
