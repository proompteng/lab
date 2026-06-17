"""Profit readiness summaries and live controls."""

from __future__ import annotations

from .common import (
    Any,
    AutoresearchCandidateSpec,
    AutoresearchEpoch,
    AutoresearchPortfolioCandidate,
    AutoresearchProposalScore,
    Decimal,
    Mapping,
    ResearchCandidate,
    ResearchPromotion,
    SQLAlchemyError,
    Sequence,
    Session,
    StrategyPromotionDecision,
    TradeDecision,
    VNextPromotionDecision,
    AUTORESEARCH_PORTFOLIO_READY_STATUSES as _AUTORESEARCH_PORTFOLIO_READY_STATUSES,
    PROMOTION_PORTFOLIO_READY_SCAN_LIMIT as _PROMOTION_PORTFOLIO_READY_SCAN_LIMIT,
    PROMOTION_PORTFOLIO_SAMPLE_LIMIT as _PROMOTION_PORTFOLIO_SAMPLE_LIMIT,
    PROMOTION_SCALAR_COUNT_LIMIT as _PROMOTION_SCALAR_COUNT_LIMIT,
    PROMOTION_TABLE_COUNT_SCAN_LIMIT as _PROMOTION_TABLE_COUNT_SCAN_LIMIT,
    PortfolioPromotionRow as _PortfolioPromotionRow,
    compat_symbol as _compat_symbol,
    maybe_set_runtime_ledger_status_statement_timeout as _maybe_set_runtime_ledger_status_statement_timeout,
    rollback_runtime_ledger_status_session as _rollback_runtime_ledger_status_session,
    safe_int as _safe_int,
    safe_text as _safe_text,
    sqlalchemy_error_indicates_statement_timeout as _sqlalchemy_error_indicates_statement_timeout,
    cast,
    datetime,
    func,
    logger,
    select,
    settings,
    timedelta,
    timezone,
)


from .quant_health import (
    autoresearch_portfolio_current_oracle_passed as _autoresearch_portfolio_current_oracle_passed,
    empty_profit_promotion_table_counts as _empty_profit_promotion_table_counts,
    load_profit_promotion_bounded_row_count as _load_profit_promotion_bounded_row_count,
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


__all__: tuple[str, ...] = ()

# Public aliases used by split modules.
build_profit_data_readiness_summary = _build_profit_data_readiness_summary
build_profit_live_controls = _build_profit_live_controls
build_profit_rejection_summary = _build_profit_rejection_summary
load_persisted_profit_rejection_summary = _load_persisted_profit_rejection_summary
load_profit_promotion_table_counts = _load_profit_promotion_table_counts
