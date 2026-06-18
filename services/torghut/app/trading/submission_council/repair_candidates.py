"""Runtime ledger repair candidate loading and market context."""

from __future__ import annotations

from .common import (
    Any,
    Decimal,
    Mapping,
    RuntimeLedgerReadSession,
    SQLAlchemyError,
    Sequence,
    StrategyHypothesisMetricWindow,
    StrategyPromotionDecision,
    StrategyRuntimeLedgerBucket,
    RUNTIME_LEDGER_REPAIR_CANDIDATE_LIMIT as _RUNTIME_LEDGER_REPAIR_CANDIDATE_LIMIT,
    RUNTIME_LEDGER_REPAIR_SCAN_LIMIT as _RUNTIME_LEDGER_REPAIR_SCAN_LIMIT,
    coerce_aware_datetime as _coerce_aware_datetime,
    maybe_set_runtime_ledger_status_statement_timeout as _maybe_set_runtime_ledger_status_statement_timeout,
    rollback_runtime_ledger_status_session as _rollback_runtime_ledger_status_session,
    safe_decimal as _safe_decimal,
    safe_bool as _safe_bool,
    safe_int as _safe_int,
    safe_text as _safe_text,
    stage_rank as _stage_rank,
    active_market_context_mapping,
    active_market_context_reasons,
    cast,
    datetime,
    logger,
    select,
    timedelta,
)

from .runtime_summary import (
    runtime_ledger_aggregate_candidate_payloads as _runtime_ledger_aggregate_candidate_payloads,
    runtime_ledger_bucket_payload as _runtime_ledger_bucket_payload,
    runtime_ledger_candidate_group_key as _runtime_ledger_candidate_group_key,
    runtime_ledger_source_evidence_payload as _runtime_ledger_source_evidence_payload,
)

from .certificate_loading import (
    metric_window_activity_reason_codes as _metric_window_activity_reason_codes,
    promotion_decision_blocking_reason_codes as _promotion_decision_blocking_reason_codes,
)
from .paper_probation import (
    hypothesis_manifest_ref as _hypothesis_manifest_ref,
)


from .runtime_certificates import (
    certificate_evidence_authority_score as _certificate_evidence_authority_score,
    runtime_ledger_selection_score as _runtime_ledger_selection_score,
    runtime_ledger_repair_reason_codes as _runtime_ledger_repair_reason_codes,
    runtime_ledger_repair_score as _runtime_ledger_repair_score,
)


def _load_runtime_ledger_repair_candidates(
    session: RuntimeLedgerReadSession,
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


__all__ = ("build_submission_gate_market_context_status",)

# Public aliases used by split modules.
certificate_evidence_authority_score = _certificate_evidence_authority_score
certificate_evidence_selection_key = _certificate_evidence_selection_key
extract_runtime_summary = _extract_runtime_summary
load_runtime_ledger_repair_candidates = _load_runtime_ledger_repair_candidates
refresh_runtime_summary_totals = _refresh_runtime_summary_totals
runtime_ledger_repair_reason_codes = _runtime_ledger_repair_reason_codes
runtime_ledger_repair_score = _runtime_ledger_repair_score
runtime_ledger_selection_score = _runtime_ledger_selection_score
