# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
"""Promotion certificate evaluation and lineage helpers."""

from __future__ import annotations

# ruff: noqa: F401,F811,F821
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
    certificate_evidence_selection_key as _certificate_evidence_selection_key,
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

from .certificate_loading import (
    certificate_capital_stage as _certificate_capital_stage,
    certificate_evidence_is_fresh as _certificate_evidence_is_fresh,
    load_latest_certificate_evidence as _load_latest_certificate_evidence,
    merge_runtime_certificate_evidence as _merge_runtime_certificate_evidence,
    metric_window_activity_reason_codes as _metric_window_activity_reason_codes,
    promotion_decision_blocking_reason_codes as _promotion_decision_blocking_reason_codes,
    window_evidence_issued_at as _window_evidence_issued_at,
)


def _segment_summary(
    *,
    state: object,
    runtime_items: Sequence[Mapping[str, Any]],
    blocking_toggle_mismatches: Sequence[str],
    empirical_ready: bool | None,
    dspy_mode: str,
    dspy_live_ready: bool | None,
) -> dict[str, dict[str, object]]:
    market_context_ref = build_submission_gate_market_context_status(state)
    domain_states = {
        key: str(value).strip().lower()
        for key, value in active_market_context_mapping(
            cast(Mapping[str, Any], market_context_ref.get("last_domain_states", {}))
        ).items()
    }
    market_context_reasons: list[str] = []
    if bool(market_context_ref.get("alert_active")):
        market_context_reasons.extend(
            active_market_context_reasons(
                [
                    str(
                        market_context_ref.get("alert_reason")
                        or "market_context_alert_active"
                    )
                ]
            )
        )
    stale_domains = [
        domain
        for domain, segment_state in sorted(domain_states.items())
        if segment_state in _STALE_SEGMENT_STATES
    ]
    market_context_reasons.extend(
        [
            f"market_context_domain_{domain}_{domain_states[domain]}"
            for domain in stale_domains
        ]
    )

    ta_core_reasons: list[str] = []
    if bool(getattr(state, "signal_continuity_alert_active", False)):
        ta_core_reasons.append("signal_continuity_alert_active")
    if (
        _safe_int(getattr(getattr(state, "metrics", None), "signal_lag_seconds", None))
        > 0
    ):
        signal_lag = _safe_int(
            getattr(getattr(state, "metrics", None), "signal_lag_seconds", None)
        )
        if signal_lag > 0 and bool(
            getattr(state, "signal_continuity_alert_active", False)
        ):
            ta_core_reasons.append("signal_lag_exceeded")
    for item in runtime_items:
        item_reasons = [
            str(reason).strip()
            for reason in cast(Sequence[object], item.get("reasons") or [])
            if str(reason).strip() in _TA_CORE_REASON_CODES
        ]
        ta_core_reasons.extend(item_reasons)

    execution_reasons = (
        ["critical_toggle_parity_diverged"] if list(blocking_toggle_mismatches) else []
    )
    empirical_reasons = (
        [] if empirical_ready is not False else ["empirical_jobs_not_ready"]
    )
    llm_review_reasons: list[str] = []
    if dspy_mode == "active" and dspy_live_ready is False:
        llm_review_reasons.append("dspy_live_runtime_not_ready")

    raw_segments = {
        "market-context": market_context_reasons,
        "ta-core": ta_core_reasons,
        "execution": execution_reasons,
        "empirical": empirical_reasons,
        "llm-review": llm_review_reasons,
    }
    return {
        segment: {
            "state": "ok" if not reasons else "blocked",
            "reason_codes": _normalize_reason_codes(reasons),
        }
        for segment, reasons in sorted(raw_segments.items())
    }


def _evaluate_certificate_candidates(
    *,
    evidence: Sequence[Mapping[str, object]],
    segment_summary: Mapping[str, Mapping[str, object]],
    runtime_items: Sequence[Mapping[str, Any]],
    registry_items: Sequence[Mapping[str, object]],
    max_age_seconds: int,
    now: datetime,
    window: str | None,
    account: str | None,
) -> tuple[list[dict[str, object]], list[dict[str, object]]]:
    manifests = {
        str(item.get("hypothesis_id") or ""): item
        for item in registry_items
        if str(item.get("hypothesis_id") or "").strip()
    }
    runtime_by_hypothesis = {
        str(item.get("hypothesis_id") or ""): item
        for item in runtime_items
        if str(item.get("hypothesis_id") or "").strip()
    }
    evaluated: list[dict[str, object]] = []
    valid: list[dict[str, object]] = []
    for row in evidence:
        hypothesis_id = str(row.get("hypothesis_id") or "").strip()
        if not hypothesis_id:
            continue
        manifest = cast(Mapping[str, Any], manifests.get(hypothesis_id) or {})
        runtime_item = cast(
            Mapping[str, object], runtime_by_hypothesis.get(hypothesis_id) or {}
        )
        metric_window = cast(
            StrategyHypothesisMetricWindow | None, row.get("metric_window")
        )
        promotion_decision = cast(
            StrategyPromotionDecision | None, row.get("promotion_decision")
        )
        reasons: list[str] = _certificate_evidence_reason_codes(row)
        metric_window_id: str | None = None
        promotion_decision_id: str | None = None
        candidate_id = None
        capital_stage = None
        issued_at = None

        if metric_window is None:
            reasons.append("hypothesis_window_evidence_missing")
        else:
            metric_window_id = str(metric_window.id)
            candidate_id = metric_window.candidate_id
            capital_stage = metric_window.capital_stage
            if _safe_text(getattr(metric_window, "observed_stage", None)) != "live":
                reasons.append("promotion_certificate_not_live_runtime")
            issued_at = metric_window.window_ended_at or metric_window.created_at
            if issued_at.tzinfo is None:
                issued_at = issued_at.replace(tzinfo=timezone.utc)
            if max_age_seconds > 0 and issued_at < now - timedelta(
                seconds=max_age_seconds
            ):
                reasons.append("hypothesis_window_evidence_stale")
            if not bool(metric_window.continuity_ok):
                reasons.append("hypothesis_window_continuity_failed")
            if not bool(metric_window.drift_ok):
                reasons.append("hypothesis_window_drift_failed")
            if _safe_text(metric_window.dependency_quorum_decision) != "allow":
                reasons.append("hypothesis_window_dependency_quorum_not_allow")
            reasons.extend(_metric_window_activity_reason_codes(metric_window))
            if (
                _safe_text(getattr(metric_window, "observed_stage", None)) == "live"
                and promotion_decision is not None
            ):
                reasons.extend(
                    _certificate_runtime_ledger_reason_codes(
                        evidence_row=row,
                        runtime_item=runtime_item,
                        metric_window=metric_window,
                        promotion_decision=promotion_decision,
                    )
                )

        if promotion_decision is None:
            reasons.append("promotion_decision_evidence_missing")
        else:
            promotion_decision_id = str(promotion_decision.id)
            if candidate_id is None:
                candidate_id = promotion_decision.candidate_id
            if capital_stage is None:
                capital_stage = promotion_decision.state
            reasons.extend(
                _promotion_decision_blocking_reason_codes(promotion_decision)
            )
        if candidate_id is None:
            candidate_id = _safe_text(manifest.get("candidate_id"))
        if _safe_text(capital_stage) in {None, "shadow"}:
            reasons.append("promotion_certificate_shadow_only")

        segment_dependencies = [
            str(segment).strip()
            for segment in cast(
                Sequence[object], manifest.get("segment_dependencies") or []
            )
            if str(segment).strip()
        ]
        blocked_segments: list[str] = []
        if runtime_item:
            if not bool(runtime_item.get("promotion_eligible")):
                reasons.append("alpha_hypothesis_not_promotion_eligible")
            runtime_stage = _safe_text(runtime_item.get("capital_stage"))
            if runtime_stage in {None, "shadow"}:
                reasons.append("alpha_hypothesis_shadow_only")
        elif runtime_items:
            reasons.append("alpha_hypothesis_runtime_missing")
        for segment in segment_dependencies:
            segment_payload = cast(
                Mapping[str, Any], segment_summary.get(segment) or {}
            )
            if str(segment_payload.get("state") or "").strip() != "ok":
                blocked_segments.append(segment)
                reasons.extend(
                    [
                        f"segment_{segment}_blocked",
                        *cast(Sequence[str], segment_payload.get("reason_codes") or []),
                    ]
                )

        evaluated_row: dict[str, object] = {
            "hypothesis_id": hypothesis_id,
            "candidate_id": candidate_id,
            "strategy_id": manifest.get("strategy_id")
            or manifest.get("strategy_family"),
            "dataset_snapshot_ref": manifest.get("dataset_snapshot_ref"),
            "account": account,
            "window": window,
            "capital_state": capital_stage or "observe",
            "capital_stage": capital_stage or "shadow",
            "segment_dependencies": segment_dependencies,
            "blocked_segments": sorted(set(blocked_segments)),
            "reason_codes": _normalize_reason_codes(reasons),
            "metric_window_id": metric_window_id,
            "promotion_decision_id": promotion_decision_id,
            "issued_at": issued_at,
            "expires_at": (
                issued_at + timedelta(seconds=max_age_seconds)
                if issued_at is not None and max_age_seconds > 0
                else None
            ),
        }
        evaluated.append(evaluated_row)
        if not evaluated_row["reason_codes"]:
            valid.append(evaluated_row)
    return evaluated, valid


def _runtime_hypothesis_ids_for_gate_scope(
    runtime_items: Sequence[Mapping[str, Any]],
    *,
    eligibility_key: str,
) -> set[str]:
    return {
        hypothesis_id
        for item in runtime_items
        if bool(item.get(eligibility_key))
        for hypothesis_id in [str(item.get("hypothesis_id") or "").strip()]
        if hypothesis_id
    }


def _runtime_ledger_hypothesis_ids_for_gate_scope(
    runtime_ledger_candidates: Sequence[Mapping[str, object]],
) -> set[str]:
    return {
        hypothesis_id
        for candidate in runtime_ledger_candidates
        for hypothesis_id in [str(candidate.get("hypothesis_id") or "").strip()]
        if hypothesis_id
    }


def _candidate_reason_codes_for_gate_scope(
    evaluated_tuples: Sequence[Mapping[str, object]],
    *,
    hypothesis_ids: set[str],
) -> list[str]:
    scoped_tuples = [
        item
        for item in evaluated_tuples
        if str(item.get("hypothesis_id") or "").strip() in hypothesis_ids
    ]
    source_tuples = scoped_tuples if scoped_tuples else list(evaluated_tuples)
    return [
        reason
        for item in source_tuples
        for reason in cast(Sequence[str], item.get("reason_codes") or [])
    ]


def _default_lineage_ref(
    *,
    status: str = "unverified",
    candidate_id: str | None = None,
    hypothesis_id: str | None = None,
) -> dict[str, object]:
    return {
        "status": status,
        "candidate_id": candidate_id,
        "hypothesis_id": hypothesis_id,
        "dataset_snapshot_count": 0,
        "dataset_snapshot_id": None,
        "dataset_snapshot_ref": None,
        "dataset_snapshot_run_id": None,
        "strategy_hypothesis_count": 0,
        "strategy_hypothesis_id": None,
        "lane_id": None,
        "strategy_family": None,
    }


def _attach_lineage_refs(
    session: Session,
    *,
    evaluated_rows: Sequence[Mapping[str, object]],
) -> list[dict[str, object]]:
    candidate_ids = sorted(
        {
            candidate_id
            for row in evaluated_rows
            if (candidate_id := _safe_text(row.get("candidate_id"))) is not None
        }
    )
    hypothesis_ids = sorted(
        {
            hypothesis_id
            for row in evaluated_rows
            if (hypothesis_id := _safe_text(row.get("hypothesis_id"))) is not None
        }
    )

    dataset_snapshots_by_candidate: dict[str, list[VNextDatasetSnapshot]] = {}
    hypotheses_by_id: dict[str, list[StrategyHypothesis]] = {}
    try:
        if candidate_ids:
            dataset_rows = (
                session.execute(
                    select(VNextDatasetSnapshot)
                    .where(VNextDatasetSnapshot.candidate_id.in_(candidate_ids))
                    .order_by(VNextDatasetSnapshot.created_at.desc())
                )
                .scalars()
                .all()
            )
            for row in dataset_rows:
                candidate_id = _safe_text(row.candidate_id)
                if candidate_id is None:
                    continue
                dataset_snapshots_by_candidate.setdefault(candidate_id, []).append(row)

        if hypothesis_ids:
            hypothesis_rows = (
                session.execute(
                    select(StrategyHypothesis)
                    .where(
                        StrategyHypothesis.hypothesis_id.in_(hypothesis_ids),
                        StrategyHypothesis.active.is_(True),
                    )
                    .order_by(StrategyHypothesis.created_at.desc())
                )
                .scalars()
                .all()
            )
            for row in hypothesis_rows:
                hypothesis_id = _safe_text(row.hypothesis_id)
                if hypothesis_id is None:
                    continue
                hypotheses_by_id.setdefault(hypothesis_id, []).append(row)
    except SQLAlchemyError as exc:
        logger.warning("Lineage refs unavailable: %s", exc)
        _rollback_runtime_ledger_status_session(session)
        reason_code = (
            "lineage_ref_query_timeout"
            if _sqlalchemy_error_indicates_statement_timeout(exc)
            else "lineage_ref_unavailable"
        )
        attached_rows: list[dict[str, object]] = []
        for row in evaluated_rows:
            evaluated_row = dict(row)
            reason_codes = list(
                cast(Sequence[str], evaluated_row.get("reason_codes") or [])
            )
            if reason_code not in reason_codes:
                reason_codes.append(reason_code)
            evaluated_row["reason_codes"] = _normalize_reason_codes(reason_codes)
            evaluated_row["lineage_ref"] = _default_lineage_ref(
                status="unavailable",
                candidate_id=_safe_text(evaluated_row.get("candidate_id")),
                hypothesis_id=_safe_text(evaluated_row.get("hypothesis_id")),
            )
            attached_rows.append(evaluated_row)
        return attached_rows

    attached_rows: list[dict[str, object]] = []
    for row in evaluated_rows:
        evaluated_row = dict(row)
        candidate_id = _safe_text(evaluated_row.get("candidate_id"))
        hypothesis_id = _safe_text(evaluated_row.get("hypothesis_id"))
        reason_codes = list(
            cast(Sequence[str], evaluated_row.get("reason_codes") or [])
        )

        dataset_rows = (
            dataset_snapshots_by_candidate.get(candidate_id, [])
            if candidate_id is not None
            else []
        )
        declared_dataset_snapshot_ref = _safe_text(
            evaluated_row.get("dataset_snapshot_ref")
        )
        hypothesis_rows = (
            hypotheses_by_id.get(hypothesis_id, []) if hypothesis_id is not None else []
        )

        if (
            candidate_id is not None
            and not dataset_rows
            and declared_dataset_snapshot_ref is None
        ):
            reason_codes.append("dataset_snapshot_missing")
        if hypothesis_id is not None and not hypothesis_rows:
            reason_codes.append("strategy_hypothesis_missing")

        dataset_row = dataset_rows[0] if dataset_rows else None
        hypothesis_row = hypothesis_rows[0] if hypothesis_rows else None
        lineage_missing = (
            candidate_id is not None
            and not dataset_rows
            and declared_dataset_snapshot_ref is None
        ) or (hypothesis_id is not None and not hypothesis_rows)
        lineage_ref = _default_lineage_ref(
            status=(
                "missing"
                if lineage_missing
                else "manifest_declared"
                if declared_dataset_snapshot_ref is not None and not dataset_rows
                else "ready"
            ),
            candidate_id=candidate_id,
            hypothesis_id=hypothesis_id,
        )
        lineage_ref.update(
            {
                "dataset_snapshot_count": len(dataset_rows),
                "dataset_snapshot_id": (
                    str(dataset_row.id) if dataset_row is not None else None
                ),
                "dataset_snapshot_ref": (
                    dataset_row.artifact_ref
                    if dataset_row is not None
                    else declared_dataset_snapshot_ref
                ),
                "dataset_snapshot_run_id": (
                    dataset_row.run_id if dataset_row is not None else None
                ),
                "strategy_hypothesis_count": len(hypothesis_rows),
                "strategy_hypothesis_id": (
                    str(hypothesis_row.id) if hypothesis_row is not None else None
                ),
                "lane_id": hypothesis_row.lane_id
                if hypothesis_row is not None
                else None,
                "strategy_family": (
                    hypothesis_row.strategy_family
                    if hypothesis_row is not None
                    else None
                ),
            }
        )

        evaluated_row["reason_codes"] = _normalize_reason_codes(reason_codes)
        evaluated_row["lineage_ref"] = lineage_ref
        attached_rows.append(evaluated_row)

    return attached_rows


__all__: tuple[str, ...] = ()

# Public aliases used by split modules.
attach_lineage_refs = _attach_lineage_refs
candidate_reason_codes_for_gate_scope = _candidate_reason_codes_for_gate_scope
default_lineage_ref = _default_lineage_ref
evaluate_certificate_candidates = _evaluate_certificate_candidates
runtime_hypothesis_ids_for_gate_scope = _runtime_hypothesis_ids_for_gate_scope
runtime_ledger_hypothesis_ids_for_gate_scope = (
    _runtime_ledger_hypothesis_ids_for_gate_scope
)
segment_summary = _segment_summary
