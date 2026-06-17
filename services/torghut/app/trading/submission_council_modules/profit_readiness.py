# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
"""Profit readiness summaries and live controls."""

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

from .quant_health import (
    autoresearch_portfolio_current_oracle_passed as _autoresearch_portfolio_current_oracle_passed,
    build_quant_health_request_url as _build_quant_health_request_url,
    derive_quant_health_url as _derive_quant_health_url,
    empty_profit_promotion_table_counts as _empty_profit_promotion_table_counts,
    fresh_clickhouse_signal_continuity as _fresh_clickhouse_signal_continuity,
    load_profit_promotion_bounded_row_count as _load_profit_promotion_bounded_row_count,
    runtime_window_import_continuity_signal as _runtime_window_import_continuity_signal,
    runtime_window_import_drift_signal as _runtime_window_import_drift_signal,
    runtime_window_import_health_gate_inputs as _runtime_window_import_health_gate_inputs,
    build_shadow_first_toggle_parity,
    critical_trading_toggle_snapshot,
    load_quant_evidence_status,
    resolve_active_capital_stage,
    resolve_quant_health_url,
)


def _load_profit_promotion_table_counts(session: Session) -> dict[str, Any]:
    count_errors: list[str] = []
    truncated_counts: list[str] = []
    try:
        _maybe_set_runtime_ledger_status_statement_timeout(session)
        portfolio_rows = [
            _PortfolioPromotionRow(
                status=str(row.status),
                portfolio_candidate_id=str(row.portfolio_candidate_id),
                source_candidate_ids_json=row.source_candidate_ids_json,
                target_net_pnl_per_day=cast(Decimal, row.target_net_pnl_per_day),
                objective_scorecard_json=row.objective_scorecard_json,
            )
            for row in session.execute(
                select(
                    AutoresearchPortfolioCandidate.status,
                    AutoresearchPortfolioCandidate.portfolio_candidate_id,
                    AutoresearchPortfolioCandidate.source_candidate_ids_json,
                    AutoresearchPortfolioCandidate.target_net_pnl_per_day,
                    AutoresearchPortfolioCandidate.objective_scorecard_json,
                )
                .order_by(AutoresearchPortfolioCandidate.created_at.desc())
                .limit(_PROMOTION_PORTFOLIO_SAMPLE_LIMIT + 1)
            ).all()
        ]
    except SQLAlchemyError as exc:
        logger.warning(
            "Failed to load profit promotion portfolio rows error=%s",
            exc,
        )
        _rollback_runtime_ledger_status_session(session)
        return _empty_profit_promotion_table_counts(
            count_errors=["autoresearch_portfolio_candidates"]
        )
    if len(portfolio_rows) > _PROMOTION_PORTFOLIO_SAMPLE_LIMIT:
        portfolio_rows = portfolio_rows[:_PROMOTION_PORTFOLIO_SAMPLE_LIMIT]
        truncated_counts.append("autoresearch_portfolio_candidates")
        count_errors.append("autoresearch_portfolio_candidates_bounded_scan_truncated")

    current_oracle_ready = 0
    current_policy_blocked = 0
    ready_refs: set[str] = set()
    ready_source_candidate_ids: set[str] = set()
    for row in portfolio_rows:
        current_oracle_passed = _compat_symbol(
            "_autoresearch_portfolio_current_oracle_passed",
            _autoresearch_portfolio_current_oracle_passed,
        )(row)
        if (
            row.status in _AUTORESEARCH_PORTFOLIO_READY_STATUSES
            and current_oracle_passed
        ):
            current_oracle_ready += 1
            if portfolio_candidate_id := _safe_text(row.portfolio_candidate_id):
                ready_refs.add(f"portfolio_candidate_id:{portfolio_candidate_id}")
            raw_source_candidate_ids = row.source_candidate_ids_json
            if isinstance(raw_source_candidate_ids, Sequence) and not isinstance(
                raw_source_candidate_ids, (str, bytes, bytearray)
            ):
                for raw_source_id in cast(Sequence[object], raw_source_candidate_ids):
                    source_candidate_id = _safe_text(raw_source_id)
                    if source_candidate_id is None:
                        continue
                    ready_source_candidate_ids.add(source_candidate_id)
                    ready_refs.add(f"source_candidate_id:{source_candidate_id}")
                    ready_refs.add(f"candidate_spec_id:{source_candidate_id}")
        if (
            row.status not in _AUTORESEARCH_PORTFOLIO_READY_STATUSES
            or not current_oracle_passed
        ):
            current_policy_blocked += 1

    if ready_source_candidate_ids:
        try:
            _maybe_set_runtime_ledger_status_statement_timeout(session)
            spec_rows = session.execute(
                select(AutoresearchCandidateSpec).where(
                    AutoresearchCandidateSpec.candidate_spec_id.in_(
                        sorted(ready_source_candidate_ids)
                    )
                )
            ).scalars()
            for spec_row in spec_rows:
                if hypothesis_id := _safe_text(spec_row.hypothesis_id):
                    ready_refs.add(f"hypothesis_id:{hypothesis_id}")
        except SQLAlchemyError as exc:
            logger.warning(
                "Failed to load profit promotion ready spec refs error=%s",
                exc,
            )
            count_errors.append("autoresearch_candidate_specs")
            _rollback_runtime_ledger_status_session(session)

    return {
        "research_candidates": _load_profit_promotion_bounded_row_count(
            session,
            table_name="research_candidates",
            statement=select(ResearchCandidate.id),
            count_errors=count_errors,
            truncated_counts=truncated_counts,
            model=ResearchCandidate,
        ),
        "research_promotions": _load_profit_promotion_bounded_row_count(
            session,
            table_name="research_promotions",
            statement=select(ResearchPromotion.id),
            count_errors=count_errors,
            truncated_counts=truncated_counts,
            model=ResearchPromotion,
        ),
        "strategy_promotion_decisions": _load_profit_promotion_bounded_row_count(
            session,
            table_name="strategy_promotion_decisions",
            statement=select(StrategyPromotionDecision.id),
            count_errors=count_errors,
            truncated_counts=truncated_counts,
            model=StrategyPromotionDecision,
        ),
        "vnext_promotion_decisions": _load_profit_promotion_bounded_row_count(
            session,
            table_name="vnext_promotion_decisions",
            statement=select(VNextPromotionDecision.id),
            count_errors=count_errors,
            truncated_counts=truncated_counts,
            model=VNextPromotionDecision,
        ),
        "autoresearch_epochs": _load_profit_promotion_bounded_row_count(
            session,
            table_name="autoresearch_epochs",
            statement=select(AutoresearchEpoch.id),
            count_errors=count_errors,
            truncated_counts=truncated_counts,
            model=AutoresearchEpoch,
        ),
        "autoresearch_candidate_specs": _load_profit_promotion_bounded_row_count(
            session,
            table_name="autoresearch_candidate_specs",
            statement=select(AutoresearchCandidateSpec.id),
            count_errors=count_errors,
            truncated_counts=truncated_counts,
            model=AutoresearchCandidateSpec,
        ),
        "autoresearch_proposal_scores": _load_profit_promotion_bounded_row_count(
            session,
            table_name="autoresearch_proposal_scores",
            statement=select(AutoresearchProposalScore.id),
            count_errors=count_errors,
            truncated_counts=truncated_counts,
            model=AutoresearchProposalScore,
        ),
        "autoresearch_portfolio_candidates": _load_profit_promotion_bounded_row_count(
            session,
            table_name="autoresearch_portfolio_candidates",
            statement=select(AutoresearchPortfolioCandidate.id),
            count_errors=count_errors,
            truncated_counts=truncated_counts,
            model=AutoresearchPortfolioCandidate,
        ),
        "autoresearch_portfolio_ready": current_oracle_ready,
        "autoresearch_portfolio_blocked": current_policy_blocked,
        "autoresearch_portfolio_ready_refs": sorted(ready_refs),
        "count_basis": "bounded_latest_rows",
        "count_limit": _PROMOTION_TABLE_COUNT_SCAN_LIMIT,
        "autoresearch_portfolio_scan_limit": _PROMOTION_PORTFOLIO_READY_SCAN_LIMIT,
        "truncated_counts": sorted(set(truncated_counts)),
        "read_model_scope": "bounded_promotion_scalar_counts",
        "promotion_scalar_count_limit": _PROMOTION_SCALAR_COUNT_LIMIT,
        "autoresearch_portfolio_sample_limit": _PROMOTION_PORTFOLIO_SAMPLE_LIMIT,
        "promotion_scalar_counts_exact": False,
        "count_errors": sorted(set(count_errors)),
    }


def _coerce_aware_datetime(value: object) -> datetime | None:
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, str) and value.strip():
        normalized = value.strip()
        if normalized.endswith("Z"):
            normalized = f"{normalized[:-1]}+00:00"
        try:
            parsed = datetime.fromisoformat(normalized)
        except ValueError:
            return None
    else:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _build_profit_data_readiness_summary(
    state: object,
    *,
    clickhouse_ta_status: Mapping[str, Any] | None = None,
) -> dict[str, object]:
    metrics = getattr(state, "metrics", None)
    rows = _safe_int(getattr(metrics, "feature_batch_rows_total", 0))
    symbols = 0
    source_ref = "scheduler.metrics.feature_batch_rows_total"
    observed_at = None
    fresh_until = None
    clickhouse_status = (
        dict(clickhouse_ta_status) if isinstance(clickhouse_ta_status, Mapping) else {}
    )
    clickhouse_rows = _safe_int(
        clickhouse_status.get("signal_rows")
        or clickhouse_status.get("equity_ta_rows")
        or clickhouse_status.get("row_count")
        or clickhouse_status.get("rows")
        or 0
    )
    clickhouse_symbols = _safe_int(
        clickhouse_status.get("symbol_count")
        or clickhouse_status.get("equity_ta_symbols")
        or clickhouse_status.get("symbols")
        or 0
    )
    if rows <= 0 and clickhouse_rows > 0:
        rows = clickhouse_rows
        symbols = clickhouse_symbols
        source_ref = (
            _safe_text(clickhouse_status.get("source_ref")) or "clickhouse:ta_signals"
        )
        observed_at = _coerce_aware_datetime(
            clickhouse_status.get("latest_signal_at")
            or clickhouse_status.get("readiness_window_end")
            or clickhouse_status.get("as_of")
        )
        fresh_until = _coerce_aware_datetime(clickhouse_status.get("fresh_until"))
        if fresh_until is None and observed_at is not None:
            fresh_until = observed_at + timedelta(
                milliseconds=max(1, settings.trading_feature_max_staleness_ms)
            )
    null_rate = getattr(metrics, "feature_null_rate", {}) if metrics else {}
    staleness_ms_p95 = _safe_int(getattr(metrics, "feature_staleness_ms_p95", 0))
    duplicate_ratio = getattr(metrics, "feature_duplicate_ratio", None)
    return {
        "equity_ta_rows": rows,
        "equity_ta_symbols": symbols,
        "equity_ta_source_ref": source_ref,
        "observed_at": observed_at,
        "fresh_until": fresh_until,
        "feature_null_rate": dict(cast(Mapping[str, float], null_rate))
        if isinstance(null_rate, Mapping)
        else {},
        "feature_staleness_ms_p95": staleness_ms_p95,
        "feature_duplicate_ratio": duplicate_ratio,
    }


def _load_persisted_profit_rejection_summary(
    session: Session,
    *,
    account_label: str | None,
    now: datetime,
) -> dict[str, object]:
    lookback_start = now - timedelta(days=7)
    filters = [TradeDecision.created_at >= lookback_start]
    if account_label:
        filters.append(TradeDecision.alpaca_account_label == account_label)
    try:
        _maybe_set_runtime_ledger_status_statement_timeout(session)
        rows = session.execute(
            select(TradeDecision.status, func.count())
            .where(*filters)
            .group_by(TradeDecision.status)
        ).all()
    except SQLAlchemyError as exc:
        logger.warning("Profit rejection summary unavailable: %s", exc)
        _rollback_runtime_ledger_status_session(session)
        reason_code = (
            "profit_rejection_summary_query_timeout"
            if _sqlalchemy_error_indicates_statement_timeout(exc)
            else "profit_rejection_summary_unavailable"
        )
        return {
            "rejected": 0,
            "blocked": 0,
            "filled": 0,
            "planned": 0,
            "total": 0,
            "rejection_drag_ratio": None,
            "status_totals": {},
            "source_ref": "postgres:trade_decisions:7d",
            "reason_codes": [reason_code],
        }
    status_totals: dict[str, int] = {}
    for status, count in rows:
        normalized = str(status or "unknown").strip().lower() or "unknown"
        status_totals[normalized] = status_totals.get(normalized, 0) + _safe_int(count)
    rejected = status_totals.get("rejected", 0)
    blocked = status_totals.get("blocked", 0)
    filled = status_totals.get("filled", 0)
    planned = status_totals.get("planned", 0) + status_totals.get("submitted", 0)
    total = sum(status_totals.values())
    rejection_drag_ratio = (
        float(rejected + blocked) / float(total) if total > 0 else None
    )
    return {
        "rejected": rejected,
        "blocked": blocked,
        "filled": filled,
        "planned": planned,
        "total": total,
        "rejection_drag_ratio": rejection_drag_ratio,
        "status_totals": status_totals,
        "source_ref": "postgres:trade_decisions:7d",
    }


def _build_profit_rejection_summary(
    state: object,
    *,
    session: Session | None = None,
    account_label: str | None = None,
    now: datetime | None = None,
) -> dict[str, object]:
    metrics = getattr(state, "metrics", None)
    state_totals = getattr(metrics, "decision_state_total", {}) if metrics else {}
    decision_state_total = (
        dict(cast(Mapping[str, int], state_totals))
        if isinstance(state_totals, Mapping)
        else {}
    )
    rejected = _safe_int(decision_state_total.get("rejected"))
    blocked = _safe_int(decision_state_total.get("blocked"))
    filled = _safe_int(decision_state_total.get("filled"))
    planned = _safe_int(decision_state_total.get("planned"))
    total = sum(_safe_int(value) for value in decision_state_total.values())
    if total == 0:
        total = rejected + blocked + filled + planned
    if total <= 0 and session is not None:
        return _load_persisted_profit_rejection_summary(
            session,
            account_label=account_label,
            now=now or datetime.now(timezone.utc),
        )
    rejection_drag_ratio = (
        float(rejected + blocked) / float(total) if total > 0 else None
    )
    return {
        "rejected": rejected,
        "blocked": blocked,
        "filled": filled,
        "planned": planned,
        "total": total,
        "rejection_drag_ratio": rejection_drag_ratio,
        "source_ref": "scheduler.metrics.decision_state_total",
    }


def _build_profit_live_controls(state: object) -> dict[str, object]:
    rollback_ready = not bool(getattr(state, "emergency_stop_active", False)) and bool(
        getattr(state, "rollback_incident_evidence_path", None)
    )
    live_submission_enabled = (
        settings.trading_mode == "live"
        and settings.trading_enabled
        and not settings.trading_kill_switch_enabled
        and settings.trading_autonomy_allow_live_promotion
    )
    return {
        "live_submission_enabled": live_submission_enabled,
        "rollback_ready": rollback_ready,
        "deployer_approved": False,
    }


__all__ = [name for name in globals() if not name.startswith("__")]

# Public aliases used by split modules.
build_profit_data_readiness_summary = _build_profit_data_readiness_summary
build_profit_live_controls = _build_profit_live_controls
build_profit_rejection_summary = _build_profit_rejection_summary
load_persisted_profit_rejection_summary = _load_persisted_profit_rejection_summary
load_profit_promotion_table_counts = _load_profit_promotion_table_counts
