# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportPrivateUsage=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
"""Promotion certificate loading and runtime evidence merging."""

from __future__ import annotations

# ruff: noqa: F401,F403,F405,F811,F821
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
    _AUTORESEARCH_PORTFOLIO_READY_STATUSES,
    _CAPITAL_STAGE_ORDER,
    _CERTIFICATE_EVIDENCE_PER_HYPOTHESIS_LIMIT,
    _CERTIFICATE_EVIDENCE_RUNTIME_LEDGER_LIMIT,
    _CERTIFICATE_EVIDENCE_WINDOW_LIMIT,
    _LIVE_SUBMISSION_BLOCKING_TOGGLE_MISMATCHES,
    _PROMOTION_PORTFOLIO_READY_SCAN_LIMIT,
    _PROMOTION_PORTFOLIO_SAMPLE_LIMIT,
    _PROMOTION_SCALAR_COUNT_LIMIT,
    _PROMOTION_TABLE_COUNT_SCAN_LIMIT,
    _PortfolioPromotionRow,
    _QUANT_HEALTH_CACHE,
    _QUANT_HEALTH_CACHE_LOCK,
    _RUNTIME_LEDGER_REPAIR_CANDIDATE_LIMIT,
    _RUNTIME_LEDGER_REPAIR_SCAN_LIMIT,
    _RUNTIME_LEDGER_STATUS_QUERY_TIMEOUT_DEFAULT_MS,
    _RUNTIME_LEDGER_STATUS_QUERY_TIMEOUT_ENV,
    _RUNTIME_LEDGER_STATUS_QUERY_TIMEOUT_MAX_MS,
    _RUNTIME_LEDGER_STATUS_QUERY_TIMEOUT_MIN_MS,
    _RUNTIME_LEDGER_SUMMARY_PER_HYPOTHESIS_LIMIT,
    _RUNTIME_WINDOW_IMPORT_CONTINUITY_READY_STATES,
    _STALE_SEGMENT_STATES,
    _TA_CORE_REASON_CODES,
    _TYPED_QUANT_HEALTH_PATH,
    _bounded_paper_route_probe_collection_payload,
    _bounded_paper_route_probe_notional,
    _certificate_evidence_reason_codes,
    _coerce_aware_datetime,
    _compat_symbol,
    _decimal_text,
    _maybe_set_runtime_ledger_status_statement_timeout,
    _normalize_reason_codes,
    _rollback_runtime_ledger_status_session,
    _runtime_ledger_status_query_timeout_ms,
    _safe_attr_text,
    _safe_bool,
    _safe_decimal,
    _safe_int,
    _safe_text,
    _sqlalchemy_error_indicates_statement_timeout,
    _stage_rank,
    _unavailable_certificate_evidence_rows,
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
    _RUNTIME_LEDGER_BUCKET_COMMON_TEXT_KEYS,
    _RUNTIME_LEDGER_BUCKET_COUNT_MAP_KEYS,
    _RUNTIME_LEDGER_BUCKET_DECIMAL_TOTAL_KEYS,
    _RUNTIME_LEDGER_BUCKET_INT_TOTAL_KEYS,
    _RUNTIME_LEDGER_BUCKET_SEQUENCE_KEYS,
    _RUNTIME_LEDGER_SOURCE_EVIDENCE_KEYS,
    _certificate_runtime_ledger_payload,
    _normalized_strategy_family,
    _runtime_ledger_aggregate_candidate_payloads,
    _runtime_ledger_bucket_matches_metric_window,
    _runtime_ledger_bucket_payload,
    _runtime_ledger_bucket_symbol,
    _runtime_ledger_bucket_window_reason_code,
    _runtime_ledger_bucket_within_metric_window,
    _runtime_ledger_candidate_group_key,
    _runtime_ledger_common_text,
    _runtime_ledger_hash_count,
    _runtime_ledger_latest_payloads_per_symbol,
    _runtime_ledger_merge_count_maps,
    _runtime_ledger_payload_from_runtime_item,
    _runtime_ledger_source_evidence_payload,
    _runtime_ledger_unique_sequence,
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
    _BOUNDED_PAPER_ROUTE_COLLECTION_PROMOTION_BLOCKERS,
    _BOUNDED_PAPER_ROUTE_COLLECTION_SCOPE,
    _BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_KIND,
    _HPAIRS_BOUNDED_COLLECTION_CANDIDATE_ID,
    _HPAIRS_BOUNDED_COLLECTION_HYPOTHESIS_ID,
    _RUNTIME_LEDGER_PAPER_PROBATION_ALLOWED_REASONS,
    _RUNTIME_LEDGER_PAPER_PROBATION_IMPORT_SCHEMA_VERSION,
    _RUNTIME_LEDGER_PAPER_PROBATION_MIN_CLOSED_ROUND_TRIPS,
    _RUNTIME_LEDGER_PAPER_PROBATION_PROMOTION_BLOCKERS,
    _RUNTIME_LEDGER_PAPER_PROBATION_REASON,
    _RUNTIME_LEDGER_PAPER_PROBATION_SOURCE_DSN_ENV,
    _RUNTIME_LEDGER_PAPER_PROBATION_SOURCE_KIND,
    _RUNTIME_LEDGER_PAPER_PROBATION_TARGET_DSN_ENV,
    _RUNTIME_LEDGER_SOURCE_COLLECTION_BUCKET_SOURCE,
    _RUNTIME_LEDGER_SOURCE_COLLECTION_BUCKET_SOURCE_DSN_ENVS,
    _RUNTIME_LEDGER_SOURCE_COLLECTION_LIVE_PAPER_EVIDENCE_REQUIREMENTS,
    _RUNTIME_LEDGER_SOURCE_COLLECTION_PROFIT_TARGET_BLOCKER,
    _RUNTIME_LEDGER_SOURCE_COLLECTION_PROFIT_TARGET_NET_PNL_AFTER_COSTS,
    _RUNTIME_LEDGER_SOURCE_COLLECTION_PROFIT_TARGET_SELECTION_REASON,
    _RUNTIME_LEDGER_SOURCE_COLLECTION_PROMOTION_BLOCKERS,
    _RUNTIME_LEDGER_SOURCE_COLLECTION_SAFE_EVIDENCE_COLLECTION_PATH,
    _RUNTIME_LEDGER_SOURCE_COLLECTION_SOURCE_DSN_ENV,
    _RUNTIME_LEDGER_SOURCE_COLLECTION_SOURCE_KIND,
    _RUNTIME_LEDGER_SOURCE_COLLECTION_TARGET_DSN_ENV,
    _RUNTIME_LEDGER_SOURCE_COLLECTION_TRIGGER_REASONS,
    _bounded_source_collection_probe_window,
    _hypothesis_manifest_ref,
    _runtime_ledger_paper_probation_activity_blockers,
    _runtime_ledger_paper_probation_blockers,
    _runtime_ledger_paper_probation_bucket_ref,
    _runtime_ledger_paper_probation_candidates,
    _runtime_ledger_paper_probation_eligible,
    _runtime_ledger_paper_probation_hash_blockers,
    _runtime_ledger_paper_probation_payload,
    _runtime_ledger_paper_probation_profit_blockers,
    _runtime_ledger_paper_probation_strategy_name,
    _runtime_ledger_source_collection_candidate,
    _runtime_ledger_source_collection_candidates,
    _runtime_ledger_source_collection_import_candidate,
    _runtime_ledger_source_collection_profit_target_candidate,
    _runtime_ledger_source_collection_profit_target_metadata,
    _runtime_ledger_source_collection_source_dsn_env,
    _runtime_ledger_source_collection_target_progress_payload,
    _strategy_lookup_names,
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
    _RuntimeLedgerImportCandidate,
    _blocked_import_target,
    _bounded_paper_route_manifest_collection_targets,
    _candidate_reason_codes,
    _duplicate_import_target,
    _missing_import_target,
    _paper_probation_eligible_total_with_runtime_ledger,
    _runtime_ledger_base_import_target,
    _runtime_ledger_import_candidate,
    _runtime_ledger_import_handoff,
    _runtime_ledger_import_plan_has_target,
    _runtime_ledger_import_plan_payload,
    _runtime_ledger_import_probation_reason,
    _runtime_ledger_import_selector,
    _runtime_ledger_import_target,
    _runtime_ledger_import_target_key,
    _runtime_ledger_paper_probation_import_plan,
    _source_collection_import_target_metadata,
    _source_collection_reason_codes,
    _with_bounded_paper_route_manifest_collection_targets,
)

from .repair_candidates import (
    _certificate_evidence_authority_score,
    _extract_runtime_summary,
    _load_runtime_ledger_repair_candidates,
    _refresh_runtime_summary_totals,
    _runtime_ledger_repair_reason_codes,
    _runtime_ledger_repair_score,
    _runtime_ledger_selection_score,
    build_submission_gate_market_context_status,
)
from .runtime_certificates import (
    _certificate_runtime_ledger_reason_codes,
    _load_latest_runtime_ledger_summary,
    _mark_runtime_certificate_rejected,
    _runtime_ledger_manifest_candidate_ids,
    _runtime_ledger_target_reason_codes,
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


__all__ = [name for name in globals() if not name.startswith("__")]
