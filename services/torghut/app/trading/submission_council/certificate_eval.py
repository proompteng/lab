"""Promotion certificate evaluation and lineage helpers."""

from __future__ import annotations

from .common import (
    Any,
    Mapping,
    RuntimeLedgerReadSession,
    SQLAlchemyError,
    Sequence,
    StrategyHypothesis,
    VNextDatasetSnapshot,
    STALE_SEGMENT_STATES as _STALE_SEGMENT_STATES,
    TA_CORE_REASON_CODES as _TA_CORE_REASON_CODES,
    normalize_reason_codes as _normalize_reason_codes,
    rollback_runtime_ledger_status_session as _rollback_runtime_ledger_status_session,
    safe_int as _safe_int,
    safe_text as _safe_text,
    sqlalchemy_error_indicates_statement_timeout as _sqlalchemy_error_indicates_statement_timeout,
    active_market_context_mapping,
    active_market_context_reasons,
    cast,
    logger,
    select,
)


from .repair_candidates import (
    build_submission_gate_market_context_status,
)
from .quant_health import (
    fresh_clickhouse_signal_continuity as _fresh_clickhouse_signal_continuity,
)


def segment_summary(
    *,
    state: object,
    runtime_items: Sequence[Mapping[str, Any]],
    blocking_toggle_mismatches: Sequence[str],
    empirical_ready: bool | None,
    dspy_mode: str,
    dspy_live_ready: bool | None,
    clickhouse_ta_status: Mapping[str, Any] | None = None,
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
    clickhouse_signal = _fresh_clickhouse_signal_continuity(clickhouse_ta_status)
    clickhouse_signal_current = (
        clickhouse_signal is not None
        and clickhouse_signal[0] == "true"
        and clickhouse_signal[1] == "clickhouse_ta_status"
    )
    if (
        bool(getattr(state, "signal_continuity_alert_active", False))
        and not clickhouse_signal_current
    ):
        ta_core_reasons.append("signal_continuity_alert_active")
    if (
        _safe_int(getattr(getattr(state, "metrics", None), "signal_lag_seconds", None))
        > 0
        and not clickhouse_signal_current
    ):
        signal_lag = _safe_int(
            getattr(getattr(state, "metrics", None), "signal_lag_seconds", None)
        )
        if signal_lag > 0 and bool(
            getattr(state, "signal_continuity_alert_active", False)
        ):
            ta_core_reasons.append("signal_lag_exceeded")
    ta_core_reasons.extend(
        _runtime_ta_core_reasons(
            runtime_items=runtime_items,
            clickhouse_signal_current=clickhouse_signal_current,
        )
    )

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


def _runtime_ta_core_reasons(
    *,
    runtime_items: Sequence[Mapping[str, Any]],
    clickhouse_signal_current: bool,
) -> list[str]:
    clickhouse_superseded_runtime_reasons: frozenset[str] = (
        frozenset({"signal_continuity_alert_active", "signal_lag_exceeded"})
        if clickhouse_signal_current
        else frozenset()
    )
    ta_core_reasons: list[str] = []
    for item in runtime_items:
        item_reasons = [
            str(reason).strip()
            for reason in cast(Sequence[object], item.get("reasons") or [])
            if str(reason).strip() in _TA_CORE_REASON_CODES
            and str(reason).strip() not in clickhouse_superseded_runtime_reasons
        ]
        ta_core_reasons.extend(item_reasons)
    return ta_core_reasons


def default_lineage_ref(
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


def attach_lineage_refs(
    session: RuntimeLedgerReadSession,
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
            evaluated_row["lineage_ref"] = default_lineage_ref(
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
        lineage_ref = default_lineage_ref(
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
