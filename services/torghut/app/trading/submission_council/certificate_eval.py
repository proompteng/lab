"""Promotion certificate evaluation and lineage helpers."""

from __future__ import annotations

from .common import (
    Any,
    Mapping,
    RuntimeLedgerReadSession,
    SQLAlchemyError,
    Sequence,
    StrategyHypothesis,
    StrategyHypothesisMetricWindow,
    StrategyPromotionDecision,
    VNextDatasetSnapshot,
    STALE_SEGMENT_STATES as _STALE_SEGMENT_STATES,
    TA_CORE_REASON_CODES as _TA_CORE_REASON_CODES,
    certificate_evidence_reason_codes as _certificate_evidence_reason_codes,
    normalize_reason_codes as _normalize_reason_codes,
    rollback_runtime_ledger_status_session as _rollback_runtime_ledger_status_session,
    safe_int as _safe_int,
    safe_text as _safe_text,
    sqlalchemy_error_indicates_statement_timeout as _sqlalchemy_error_indicates_statement_timeout,
    active_market_context_mapping,
    active_market_context_reasons,
    cast,
    datetime,
    logger,
    select,
    timedelta,
    timezone,
)


from .repair_candidates import (
    build_submission_gate_market_context_status,
)
from .runtime_certificates import (
    certificate_runtime_ledger_reason_codes as _certificate_runtime_ledger_reason_codes,
)

from .certificate_loading import (
    metric_window_activity_reason_codes as _metric_window_activity_reason_codes,
    promotion_decision_blocking_reason_codes as _promotion_decision_blocking_reason_codes,
)


def segment_summary(
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


def evaluate_certificate_candidates(
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


def runtime_hypothesis_ids_for_gate_scope(
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


def runtime_ledger_hypothesis_ids_for_gate_scope(
    runtime_ledger_candidates: Sequence[Mapping[str, object]],
) -> set[str]:
    return {
        hypothesis_id
        for candidate in runtime_ledger_candidates
        for hypothesis_id in [str(candidate.get("hypothesis_id") or "").strip()]
        if hypothesis_id
    }


def candidate_reason_codes_for_gate_scope(
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


__all__: tuple[str, ...] = ()
