# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
"""Runtime ledger repair candidate loading and market context."""

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

from .runtime_certificates import (
    certificate_evidence_authority_score as _certificate_evidence_authority_score,
    runtime_ledger_selection_score as _runtime_ledger_selection_score,
    runtime_ledger_repair_reason_codes as _runtime_ledger_repair_reason_codes,
    runtime_ledger_repair_score as _runtime_ledger_repair_score,
)


def _load_runtime_ledger_repair_candidates(
    session: Session,
    *,
    registry_items: Sequence[Mapping[str, object]],
    limit: int = _RUNTIME_LEDGER_REPAIR_CANDIDATE_LIMIT,
) -> list[dict[str, object]]:
    manifests = {
        str(item.get("hypothesis_id") or "").strip(): item
        for item in registry_items
        if str(item.get("hypothesis_id") or "").strip()
    }
    hypothesis_ids = sorted(manifests)
    if not hypothesis_ids or limit <= 0:
        return []

    try:
        _maybe_set_runtime_ledger_status_statement_timeout(session)
        rows = (
            session.execute(
                select(StrategyRuntimeLedgerBucket)
                .where(StrategyRuntimeLedgerBucket.hypothesis_id.in_(hypothesis_ids))
                .order_by(
                    StrategyRuntimeLedgerBucket.bucket_ended_at.desc(),
                    StrategyRuntimeLedgerBucket.created_at.desc(),
                )
                .limit(_RUNTIME_LEDGER_REPAIR_SCAN_LIMIT)
            )
            .scalars()
            .all()
        )
    except SQLAlchemyError as exc:
        logger.warning("Runtime ledger repair candidates unavailable: %s", exc)
        _rollback_runtime_ledger_status_session(session)
        return []

    payload_groups: dict[
        tuple[str, str, str, str, str, str, str, str, str],
        list[dict[str, object]],
    ] = {}
    for row in rows:
        payload = _runtime_ledger_bucket_payload(row)
        if (
            _safe_int(payload.get("submitted_order_count")) <= 0
            and _safe_int(payload.get("fill_count")) <= 0
            and _safe_int(payload.get("closed_trade_count")) <= 0
        ):
            continue
        payload_groups.setdefault(
            _runtime_ledger_candidate_group_key(payload),
            [],
        ).append(payload)

    candidates: list[dict[str, object]] = []
    for payloads in payload_groups.values():
        payload = _runtime_ledger_aggregate_candidate_payloads(payloads)
        if not payload:
            continue
        manifest = manifests.get(_safe_text(payload.get("hypothesis_id")) or "") or {}
        reason_codes = _runtime_ledger_repair_reason_codes(
            payload,
            manifest=manifest,
        )
        candidates.append(
            {
                "source": "strategy_runtime_ledger_buckets",
                "promotion_authority": "runtime_ledger_candidate_only",
                "hypothesis_id": payload.get("hypothesis_id"),
                "candidate_id": payload.get("candidate_id"),
                "strategy_id": manifest.get("strategy_id")
                or payload.get("runtime_strategy_name"),
                "dataset_snapshot_ref": manifest.get("dataset_snapshot_ref"),
                "source_manifest_ref": manifest.get("source_manifest_ref")
                or _hypothesis_manifest_ref(payload.get("hypothesis_id")),
                "strategy_family": payload.get("strategy_family")
                or manifest.get("strategy_family"),
                "runtime_strategy_name": payload.get("runtime_strategy_name"),
                "observed_stage": payload.get("observed_stage"),
                "run_id": payload.get("run_id"),
                "bucket_started_at": payload.get("bucket_started_at"),
                "bucket_ended_at": payload.get("bucket_ended_at"),
                "account": payload.get("account_label"),
                "fill_count": payload.get("fill_count"),
                "decision_count": payload.get("decision_count"),
                "submitted_order_count": payload.get("submitted_order_count"),
                "closed_trade_count": payload.get("closed_trade_count"),
                "open_position_count": payload.get("open_position_count"),
                "filled_notional": payload.get("filled_notional"),
                "net_strategy_pnl_after_costs": payload.get(
                    "net_strategy_pnl_after_costs"
                ),
                "post_cost_expectancy_bps": payload.get("post_cost_expectancy_bps"),
                "ledger_schema_version": payload.get("ledger_schema_version"),
                "pnl_basis": payload.get("pnl_basis"),
                "source_window_start": payload.get("source_window_start"),
                "source_window_end": payload.get("source_window_end"),
                "source_refs": payload.get("source_refs"),
                "source_row_counts": payload.get("source_row_counts"),
                **_runtime_ledger_source_evidence_payload(payload),
                "reason_codes": reason_codes,
                "runtime_ledger_bucket": payload,
            }
        )

    return sorted(candidates, key=_runtime_ledger_repair_score, reverse=True)[:limit]


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
        decision_score,
        activity_score,
        continuity_score,
        authority_score,
        stage_score,
        runtime_ledger_score,
        capital_rank + sample_count,
        expectancy_bps,
        issued_ts,
    )


def _extract_runtime_summary(
    hypothesis_summary: Mapping[str, Any] | None,
) -> tuple[Mapping[str, Any], list[Mapping[str, Any]]]:
    if not isinstance(hypothesis_summary, Mapping):
        return {}, []
    nested_summary = hypothesis_summary.get("summary")
    if isinstance(nested_summary, Mapping):
        items_raw = hypothesis_summary.get("items")
        items = (
            [
                cast(Mapping[str, Any], item)
                for item in cast(Sequence[object], items_raw)
                if isinstance(item, Mapping)
            ]
            if isinstance(items_raw, Sequence)
            and not isinstance(items_raw, (str, bytes, bytearray))
            else []
        )
        return cast(Mapping[str, Any], nested_summary), items
    items_raw = hypothesis_summary.get("items")
    items = (
        [
            cast(Mapping[str, Any], item)
            for item in cast(Sequence[object], items_raw)
            if isinstance(item, Mapping)
        ]
        if isinstance(items_raw, Sequence)
        and not isinstance(items_raw, (str, bytes, bytearray))
        else []
    )
    return hypothesis_summary, items


def _refresh_runtime_summary_totals(
    summary: Mapping[str, Any],
    runtime_items: Sequence[Mapping[str, Any]],
) -> dict[str, object]:
    state_totals: dict[str, int] = {}
    reason_totals: dict[str, int] = {}
    informational_reason_totals: dict[str, int] = {}
    capital_stage_totals: dict[str, int] = {}
    capital_multiplier_by_hypothesis: dict[str, str] = {}
    promotion_eligible_total = 0
    paper_probation_eligible_total = 0
    rollback_required_total = 0

    for item in runtime_items:
        state = str(item.get("state") or "unknown")
        state_totals[state] = state_totals.get(state, 0) + 1

        capital_stage = str(item.get("capital_stage") or "shadow")
        capital_stage_totals[capital_stage] = (
            capital_stage_totals.get(capital_stage, 0) + 1
        )

        hypothesis_id = str(item.get("hypothesis_id") or "unknown")
        capital_multiplier_by_hypothesis[hypothesis_id] = str(
            item.get("capital_multiplier") or "0"
        )

        if bool(item.get("promotion_eligible")):
            promotion_eligible_total += 1
        if bool(item.get("paper_probation_eligible")):
            paper_probation_eligible_total += 1
        if bool(item.get("rollback_required")):
            rollback_required_total += 1

        for reason in cast(Sequence[object], item.get("reasons") or []):
            reason_code = str(reason).strip()
            if reason_code:
                reason_totals[reason_code] = reason_totals.get(reason_code, 0) + 1
        for reason in cast(Sequence[object], item.get("informational_reasons") or []):
            reason_code = str(reason).strip()
            if reason_code:
                informational_reason_totals[reason_code] = (
                    informational_reason_totals.get(reason_code, 0) + 1
                )

    refreshed = dict(summary)
    refreshed.update(
        {
            "hypotheses_total": len(runtime_items),
            "state_totals": dict(sorted(state_totals.items())),
            "reason_totals": dict(sorted(reason_totals.items())),
            "informational_reason_totals": dict(
                sorted(informational_reason_totals.items())
            ),
            "capital_stage_totals": dict(sorted(capital_stage_totals.items())),
            "capital_multiplier_by_hypothesis": capital_multiplier_by_hypothesis,
            "promotion_eligible_total": promotion_eligible_total,
            "paper_probation_eligible_total": paper_probation_eligible_total,
            "rollback_required_total": rollback_required_total,
            "items": list(runtime_items),
        }
    )
    return refreshed


def build_submission_gate_market_context_status(state: object) -> dict[str, object]:
    last_domain_states = {
        key: str(value).strip().lower()
        for key, value in active_market_context_mapping(
            cast(
                Mapping[str, Any],
                getattr(state, "last_market_context_domain_states", {}),
            )
        ).items()
    }
    last_risk_flags = active_market_context_reasons(
        cast(Sequence[str], getattr(state, "last_market_context_risk_flags", []))
    )
    raw_alert_active = bool(getattr(state, "market_context_alert_active", False))
    alert_reason = (
        getattr(state, "market_context_alert_reason", None)
        or "market_context_alert_active"
        if raw_alert_active
        else None
    )
    active_alert_reasons = active_market_context_reasons([alert_reason])
    filtered_alert_reason = active_alert_reasons[0] if active_alert_reasons else None
    return {
        "last_symbol": getattr(state, "last_market_context_symbol", None),
        "last_checked_at": getattr(state, "last_market_context_checked_at", None),
        "last_as_of": getattr(state, "last_market_context_as_of", None),
        "last_freshness_seconds": getattr(
            state, "last_market_context_freshness_seconds", None
        ),
        "last_domain_states": last_domain_states,
        "last_risk_flags": last_risk_flags,
        "alert_active": raw_alert_active and filtered_alert_reason is not None,
        "alert_reason": filtered_alert_reason,
    }


__all__ = [name for name in globals() if not name.startswith("__")]

# Public aliases used by split modules.
certificate_evidence_authority_score = _certificate_evidence_authority_score
certificate_evidence_selection_key = _certificate_evidence_selection_key
extract_runtime_summary = _extract_runtime_summary
load_runtime_ledger_repair_candidates = _load_runtime_ledger_repair_candidates
refresh_runtime_summary_totals = _refresh_runtime_summary_totals
runtime_ledger_repair_reason_codes = _runtime_ledger_repair_reason_codes
runtime_ledger_repair_score = _runtime_ledger_repair_score
runtime_ledger_selection_score = _runtime_ledger_selection_score
