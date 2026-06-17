# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportPrivateUsage=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
"""Promotion certificate evaluation and lineage helpers."""

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
    _certificate_evidence_selection_key,
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

from .certificate_loading import (
    _certificate_capital_stage,
    _certificate_evidence_is_fresh,
    _load_latest_certificate_evidence,
    _merge_runtime_certificate_evidence,
    _metric_window_activity_reason_codes,
    _promotion_decision_blocking_reason_codes,
    _window_evidence_issued_at,
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


__all__ = [name for name in globals() if not name.startswith("__")]
