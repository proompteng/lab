# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportPrivateUsage=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
"""Runtime ledger repair candidate loading and market context."""

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

from .runtime_certificates import (
    _certificate_evidence_authority_score,
    _runtime_ledger_selection_score,
    _runtime_ledger_repair_reason_codes,
    _runtime_ledger_repair_score,
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
