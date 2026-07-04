"""Shared live-submission gate helpers for status and runtime paths."""

from __future__ import annotations

from dataclasses import dataclass

from .common import (
    Any,
    Mapping,
    Sequence,
    Session,
    StrategyHypothesisMetricWindow,
    StrategyPromotionDecision,
    LIVE_SUBMISSION_BLOCKING_TOGGLE_MISMATCHES as _LIVE_SUBMISSION_BLOCKING_TOGGLE_MISMATCHES,
    normalize_reason_codes as _normalize_reason_codes,
    safe_int as _safe_int,
    safe_text as _safe_text,
    build_profit_lease_projection,
    build_profit_window_contract,
    build_tca_gate_inputs,
    cast,
    compile_hypothesis_runtime_statuses,
    datetime,
    load_hypothesis_registry,
    resolve_hypothesis_dependency_quorum,
    settings,
    timezone,
    urlopen,
)
from .quant_health import (
    runtime_window_import_health_gate_inputs as _runtime_window_import_health_gate_inputs,
    build_shadow_first_toggle_parity,
    critical_trading_toggle_snapshot,
    load_quant_evidence_status,
    resolve_active_capital_stage,
    resolve_quant_health_url,
)
from .gate_payloads import (
    common_submission_payload as _common_submission_payload,
)
from .configured_collection import (
    with_configured_paper_collection_targets as _with_configured_paper_collection_targets,
)
from .runtime_summary import (
    build_hypothesis_runtime_summary,
)
from .paper_probation import (
    runtime_ledger_paper_probation_candidates as _runtime_ledger_paper_probation_candidates,
    runtime_ledger_source_collection_candidates as _runtime_ledger_source_collection_candidates,
)
from .import_plan import (
    paper_probation_eligible_total_with_runtime_ledger as _paper_probation_eligible_total_with_runtime_ledger,
    runtime_ledger_paper_probation_import_plan as _runtime_ledger_paper_probation_import_plan,
    with_bounded_paper_route_manifest_collection_targets as _with_bounded_paper_route_manifest_collection_targets,
)
from .repair_candidates import (
    extract_runtime_summary as _extract_runtime_summary,
    load_runtime_ledger_repair_candidates as _load_runtime_ledger_repair_candidates,
    refresh_runtime_summary_totals as _refresh_runtime_summary_totals,
    build_submission_gate_market_context_status,
)
from .certificate_loading import (
    load_latest_certificate_evidence as _load_latest_certificate_evidence,
    merge_runtime_certificate_evidence as _merge_runtime_certificate_evidence,
)
from .certificate_eval import (
    default_lineage_ref as _default_lineage_ref,
    segment_summary as _segment_summary,
)
from .profit_readiness import (
    build_profit_data_readiness_summary as _build_profit_data_readiness_summary,
    build_profit_live_controls as _build_profit_live_controls,
    build_profit_rejection_summary as _build_profit_rejection_summary,
    load_profit_promotion_table_counts as _load_profit_promotion_table_counts,
)


@dataclass(frozen=True)
class _SubmissionDependencyContext:
    payload: dict[str, Any]
    decision: str
    runtime_window_import_health_gate: dict[str, object]
    empirical_ready: bool | None
    dspy_mode: str
    dspy_live_ready: bool | None


@dataclass(frozen=True)
class _SubmissionToggleContext:
    configured_live_promotion: bool
    autonomy_promotion_eligible: bool
    autonomy_promotion_action: object
    drift_live_promotion_eligible: bool
    critical_toggle_parity: dict[str, object]
    blocking_toggle_mismatches: list[str]


@dataclass(frozen=True)
class _SubmissionQuantContext:
    evidence: dict[str, Any]
    required: bool
    ready: bool
    reason: str
    blocking_reasons: list[str]


@dataclass(frozen=True)
class _SubmissionRuntimeLedgerContext:
    repair_candidates: list[dict[str, object]]
    paper_probation_candidates: list[dict[str, object]]
    source_collection_candidates: list[dict[str, object]]
    source_collection_profit_target_candidates: list[dict[str, object]]
    paper_probation_import_plan: dict[str, object]


@dataclass(frozen=True)
class _SubmissionRuntimeInputs:
    registry_item_payloads: list[dict[str, object]]
    runtime_ledger: _SubmissionRuntimeLedgerContext
    evidence_rows: Sequence[Mapping[str, object]]


@dataclass(frozen=True)
class _SubmissionTotals:
    claimed_promotion_eligible_total: int
    promotion_eligible_total: int
    paper_probation_eligible_total: int
    active_capital_stage: str


@dataclass(frozen=True)
class _SubmissionGateContext:
    state: object
    summary: Mapping[str, Any]
    runtime_items: list[dict[str, Any]]
    dependencies: _SubmissionDependencyContext
    toggles: _SubmissionToggleContext
    quant: _SubmissionQuantContext
    market_context_ref: dict[str, object]
    max_age_seconds: int
    now: datetime
    runtime_inputs: _SubmissionRuntimeInputs
    totals: _SubmissionTotals
    segment_summary: Mapping[str, Mapping[str, object]]
    profit_lease_projection: dict[str, object]
    empirical_jobs_status: Mapping[str, Any] | None


@dataclass(frozen=True)
class _SubmissionGateBuildInputs:
    state: object
    hypothesis_summary: Mapping[str, Any] | None
    empirical_jobs_status: Mapping[str, Any] | None
    dspy_runtime_status: Mapping[str, Any] | None
    quant_health_status: Mapping[str, Any] | None
    quant_account_label: str | None
    session: Session | None
    promotion_certificate_evidence: Sequence[Mapping[str, object]] | None
    clickhouse_ta_status: Mapping[str, Any] | None


def build_live_submission_gate_payload(
    state: object,
    *,
    hypothesis_summary: Mapping[str, Any] | None,
    empirical_jobs_status: Mapping[str, Any] | None = None,
    dspy_runtime_status: Mapping[str, Any] | None = None,
    quant_health_status: Mapping[str, Any] | None = None,
    quant_account_label: str | None = None,
    session: Session | None = None,
    promotion_certificate_evidence: Sequence[Mapping[str, object]] | None = None,
    clickhouse_ta_status: Mapping[str, Any] | None = None,
) -> dict[str, object]:
    inputs = _SubmissionGateBuildInputs(
        state=state,
        hypothesis_summary=hypothesis_summary,
        empirical_jobs_status=empirical_jobs_status,
        dspy_runtime_status=dspy_runtime_status,
        quant_health_status=quant_health_status,
        quant_account_label=quant_account_label,
        session=session,
        promotion_certificate_evidence=promotion_certificate_evidence,
        clickhouse_ta_status=clickhouse_ta_status,
    )
    context = _build_submission_gate_context(inputs)
    return _submission_gate_payload_from_context(context, session=session)


def _submission_gate_payload_from_context(
    context: _SubmissionGateContext,
    *,
    session: Session | None,
) -> dict[str, object]:
    if settings.trading_mode != "live":
        return _non_live_submission_gate_payload(context)
    del session
    blocked_reasons = _operational_submission_blocked_reasons(context)
    lineage_ref = _default_lineage_ref(status="operational")
    return _operational_submission_gate_payload(
        context,
        blocked_reasons=blocked_reasons,
        lineage_ref=lineage_ref,
        profit_window_contract=_submission_profit_window_contract(
            context, lineage_ref=lineage_ref
        ),
    )


def _build_submission_gate_context(
    inputs: _SubmissionGateBuildInputs,
) -> _SubmissionGateContext:
    summary, runtime_items = _extract_runtime_summary(inputs.hypothesis_summary)
    runtime_items = [dict(item) for item in runtime_items]
    dependencies = _submission_dependency_context(
        inputs.state,
        summary=summary,
        empirical_jobs_status=inputs.empirical_jobs_status,
        dspy_runtime_status=inputs.dspy_runtime_status,
        clickhouse_ta_status=inputs.clickhouse_ta_status,
    )
    toggles = _submission_toggle_context(inputs.state)
    quant = _submission_quant_context(
        inputs.quant_health_status, inputs.quant_account_label
    )
    market_context_ref = build_submission_gate_market_context_status(inputs.state)
    max_age_seconds = max(
        0, int(settings.trading_drift_live_promotion_max_evidence_age_seconds)
    )
    now = datetime.now(timezone.utc)
    runtime_inputs = _submission_runtime_inputs(
        inputs.session,
        promotion_certificate_evidence=inputs.promotion_certificate_evidence,
        now=now,
        max_age_seconds=max_age_seconds,
    )
    claimed_promotion_eligible_total = _safe_int(
        summary.get("promotion_eligible_total")
    )
    summary, runtime_items = _summary_with_runtime_certificate_evidence(
        summary,
        runtime_items=runtime_items,
        evidence_rows=runtime_inputs.evidence_rows,
        now=now,
        max_age_seconds=max_age_seconds,
    )
    totals = _submission_totals(
        summary,
        runtime_items,
        runtime_inputs.runtime_ledger,
        claimed_promotion_eligible_total=claimed_promotion_eligible_total,
    )
    segment_summary = _segment_summary(
        state=inputs.state,
        runtime_items=runtime_items,
        blocking_toggle_mismatches=toggles.blocking_toggle_mismatches,
        empirical_ready=dependencies.empirical_ready,
        dspy_mode=dependencies.dspy_mode,
        dspy_live_ready=dependencies.dspy_live_ready,
    )
    return _SubmissionGateContext(
        state=inputs.state,
        summary=summary,
        runtime_items=runtime_items,
        dependencies=dependencies,
        toggles=toggles,
        quant=quant,
        market_context_ref=market_context_ref,
        max_age_seconds=max_age_seconds,
        now=now,
        runtime_inputs=runtime_inputs,
        totals=totals,
        segment_summary=segment_summary,
        profit_lease_projection=_submission_profit_lease_projection(
            inputs.state,
            session=inputs.session,
            context_values=(runtime_items, quant, dependencies, segment_summary, now),
            clickhouse_ta_status=inputs.clickhouse_ta_status,
            quant_account_label=inputs.quant_account_label,
            empirical_jobs_status=inputs.empirical_jobs_status,
        ),
        empirical_jobs_status=inputs.empirical_jobs_status,
    )


def _submission_dependency_context(
    state: object,
    *,
    summary: Mapping[str, Any],
    empirical_jobs_status: Mapping[str, Any] | None,
    dspy_runtime_status: Mapping[str, Any] | None,
    clickhouse_ta_status: Mapping[str, Any] | None,
) -> _SubmissionDependencyContext:
    payload = (
        dict(cast(Mapping[str, Any], summary.get("dependency_quorum")))
        if isinstance(summary.get("dependency_quorum"), Mapping)
        else {}
    )
    decision = str(payload.get("decision") or "").strip().lower() or "unknown"
    dspy_mode = (
        str(dspy_runtime_status.get("mode") or "").strip().lower()
        if isinstance(dspy_runtime_status, Mapping)
        else ""
    )
    return _SubmissionDependencyContext(
        payload=payload,
        decision=decision,
        runtime_window_import_health_gate=_runtime_window_import_health_gate_inputs(
            state,
            dependency_quorum_decision=decision,
            clickhouse_ta_status=clickhouse_ta_status,
        ),
        empirical_ready=None,
        dspy_mode=dspy_mode,
        dspy_live_ready=(
            bool(dspy_runtime_status.get("live_ready"))
            if isinstance(dspy_runtime_status, Mapping) and dspy_mode == "active"
            else None
        ),
    )


def _submission_toggle_context(state: object) -> _SubmissionToggleContext:
    critical_toggle_parity = build_shadow_first_toggle_parity()
    critical_toggle_mismatches = list(
        cast(list[str], critical_toggle_parity.get("mismatches") or [])
    )
    return _SubmissionToggleContext(
        configured_live_promotion=bool(settings.trading_autonomy_allow_live_promotion),
        autonomy_promotion_eligible=bool(
            getattr(state, "last_autonomy_promotion_eligible", False)
        ),
        autonomy_promotion_action=getattr(
            state, "last_autonomy_promotion_action", None
        ),
        drift_live_promotion_eligible=bool(
            getattr(state, "drift_live_promotion_eligible", False)
        ),
        critical_toggle_parity=critical_toggle_parity,
        blocking_toggle_mismatches=[
            mismatch
            for mismatch in critical_toggle_mismatches
            if mismatch in _LIVE_SUBMISSION_BLOCKING_TOGGLE_MISMATCHES
        ],
    )


def _submission_quant_context(
    quant_health_status: Mapping[str, Any] | None,
    quant_account_label: str | None,
) -> _SubmissionQuantContext:
    evidence = (
        dict(quant_health_status)
        if isinstance(quant_health_status, Mapping)
        else load_quant_evidence_status(account_label=quant_account_label)
    )
    return _SubmissionQuantContext(
        evidence=evidence,
        required=bool(evidence.get("required")),
        ready=bool(evidence.get("ok")),
        reason=str(evidence.get("reason") or "").strip() or "unknown",
        blocking_reasons=[
            str(item).strip()
            for item in cast(Sequence[object], evidence.get("blocking_reasons") or [])
            if str(item).strip()
        ],
    )


def _submission_runtime_inputs(
    session: Session | None,
    *,
    promotion_certificate_evidence: Sequence[Mapping[str, object]] | None,
    now: datetime,
    max_age_seconds: int,
) -> _SubmissionRuntimeInputs:
    registry = load_hypothesis_registry()
    registry_item_payloads = [item.model_dump(mode="json") for item in registry.items]
    runtime_ledger = _submission_runtime_ledger_context(session, registry_item_payloads)
    evidence_rows = (
        [dict(item) for item in promotion_certificate_evidence]
        if promotion_certificate_evidence is not None
        else _load_latest_certificate_evidence(
            session,
            hypothesis_ids=[item.hypothesis_id for item in registry.items],
            now=now,
            max_age_seconds=max_age_seconds,
        )
        if session is not None
        else []
    )
    return _SubmissionRuntimeInputs(
        registry_item_payloads=registry_item_payloads,
        runtime_ledger=runtime_ledger,
        evidence_rows=evidence_rows,
    )


def _submission_runtime_ledger_context(
    session: Session | None,
    registry_item_payloads: list[dict[str, object]],
) -> _SubmissionRuntimeLedgerContext:
    repair_candidates = (
        _load_runtime_ledger_repair_candidates(
            session, registry_items=registry_item_payloads
        )
        if session is not None
        else []
    )
    paper_probation_candidates = _runtime_ledger_paper_probation_candidates(
        repair_candidates
    )
    source_collection_candidates = _runtime_ledger_source_collection_candidates(
        repair_candidates
    )
    source_collection_profit_target_candidates = [
        candidate
        for candidate in source_collection_candidates
        if bool(candidate.get("source_collection_profit_target_candidate"))
    ]
    import_plan = _runtime_ledger_paper_probation_import_plan(
        [*paper_probation_candidates, *source_collection_candidates]
    )
    merged_import_plan = _with_bounded_paper_route_manifest_collection_targets(
        import_plan,
        registry_items=registry_item_payloads,
    )
    merged_import_plan = _with_configured_paper_collection_targets(
        merged_import_plan,
        session=session,
    )
    return _SubmissionRuntimeLedgerContext(
        repair_candidates=repair_candidates,
        paper_probation_candidates=paper_probation_candidates,
        source_collection_candidates=source_collection_candidates,
        source_collection_profit_target_candidates=source_collection_profit_target_candidates,
        paper_probation_import_plan=merged_import_plan,
    )


def _summary_with_runtime_certificate_evidence(
    summary: Mapping[str, Any],
    *,
    runtime_items: list[dict[str, Any]],
    evidence_rows: Sequence[Mapping[str, object]],
    now: datetime,
    max_age_seconds: int,
) -> tuple[Mapping[str, Any], list[dict[str, Any]]]:
    runtime_evidence_rows = _runtime_certificate_evidence_rows(evidence_rows)
    if not runtime_items or not runtime_evidence_rows:
        return summary, runtime_items
    merged_items = _merge_runtime_certificate_evidence(
        runtime_items,
        evidence=runtime_evidence_rows,
        now=now,
        max_age_seconds=max_age_seconds,
    )
    return _refresh_runtime_summary_totals(summary, merged_items), merged_items


def _runtime_certificate_evidence_rows(
    evidence_rows: Sequence[Mapping[str, object]],
) -> list[Mapping[str, object]]:
    runtime_evidence_rows: list[Mapping[str, object]] = []
    for row in evidence_rows:
        metric_window = cast(
            StrategyHypothesisMetricWindow | None, row.get("metric_window")
        )
        promotion_decision = cast(
            StrategyPromotionDecision | None, row.get("promotion_decision")
        )
        if metric_window is None or promotion_decision is None:
            continue
        if _safe_text(getattr(metric_window, "observed_stage", None)) not in {
            "paper",
            "live",
        }:
            continue
        runtime_evidence_rows.append(row)
    return runtime_evidence_rows


def _submission_totals(
    summary: Mapping[str, Any],
    runtime_items: Sequence[Mapping[str, Any]],
    runtime_ledger: _SubmissionRuntimeLedgerContext,
    *,
    claimed_promotion_eligible_total: int,
) -> _SubmissionTotals:
    paper_probation_eligible_total = _safe_int(
        summary.get("paper_probation_eligible_total")
    )
    return _SubmissionTotals(
        claimed_promotion_eligible_total=claimed_promotion_eligible_total,
        promotion_eligible_total=_safe_int(summary.get("promotion_eligible_total")),
        paper_probation_eligible_total=_paper_probation_eligible_total_with_runtime_ledger(
            legacy_total=paper_probation_eligible_total,
            runtime_items=runtime_items,
            runtime_ledger_candidates=runtime_ledger.paper_probation_candidates,
        ),
        active_capital_stage=resolve_active_capital_stage(summary) or "unknown",
    )


def _submission_profit_lease_projection(
    state: object,
    *,
    session: Session | None,
    context_values: tuple[
        list[dict[str, Any]],
        _SubmissionQuantContext,
        _SubmissionDependencyContext,
        Mapping[str, Mapping[str, object]],
        datetime,
    ],
    clickhouse_ta_status: Mapping[str, Any] | None,
    quant_account_label: str | None,
    empirical_jobs_status: Mapping[str, Any] | None,
) -> dict[str, object]:
    runtime_items, quant, dependencies, _segment_summary, now = context_values
    return build_profit_lease_projection(
        runtime_items=runtime_items,
        quant_evidence=quant.evidence,
        empirical_jobs_status=empirical_jobs_status,
        dependency_quorum=dependencies.payload,
        rejection_summary=_build_profit_rejection_summary(
            state,
            session=session,
            account_label=_safe_text(quant.evidence.get("account"))
            or quant_account_label,
            now=now,
        ),
        promotion_table_counts=_load_profit_promotion_table_counts(session)
        if session is not None
        else {},
        data_readiness=_build_profit_data_readiness_summary(
            state, clickhouse_ta_status=clickhouse_ta_status
        ),
        live_controls=_build_profit_live_controls(state),
        account=_safe_text(quant.evidence.get("account")),
        window=_safe_text(quant.evidence.get("window")),
        now=now,
    )


def _non_live_submission_gate_payload(
    context: _SubmissionGateContext,
) -> dict[str, object]:
    profit_window_contract = _submission_profit_window_contract(context)
    return {
        "allowed": True,
        "reason": "non_live_mode",
        "blocked_reasons": [],
        "certificate_id": None,
        "capital_stage": settings.trading_mode,
        "capital_state": settings.trading_mode,
        "issued_at": None,
        "expires_at": None,
        **_common_submission_payload(context),
        "reason_codes": ["non_live_mode"],
        "segment_summary": context.segment_summary,
        "evidence_tuple": _empty_submission_evidence_tuple(
            context, settings.trading_mode
        ),
        "lineage_ref": _default_lineage_ref(),
        "evaluated_tuples": [],
        "profit_window_contract": profit_window_contract,
    }


def _operational_submission_blocked_reasons(
    context: _SubmissionGateContext,
) -> list[str]:
    blocked_reasons: list[str] = []
    if not settings.trading_enabled:
        blocked_reasons.append("trading_disabled")
    if settings.trading_kill_switch_enabled:
        blocked_reasons.append("kill_switch_enabled")
    if not settings.trading_simple_submit_enabled:
        blocked_reasons.append("submit_disabled")
    if not settings.trading_live_submit_enabled:
        blocked_reasons.append("live_submit_disabled")
    if settings.trading_emergency_stop_enabled and bool(
        getattr(context.state, "emergency_stop_active", False)
    ):
        blocked_reasons.append(
            str(
                getattr(context.state, "emergency_stop_reason", "")
                or "emergency_stop_active"
            )
        )
    execution_route = _execution_route_payload(context)
    if execution_route["route"] == "alpaca" and not _alpaca_broker_available():
        blocked_reasons.append("broker_unavailable")
    if (
        execution_route["route"] == "testnet"
        and not settings.trading_testnet_after_hours_enabled
    ):
        blocked_reasons.append("testnet_after_hours_disabled")
    return _normalize_reason_codes(blocked_reasons)


def _alpaca_broker_available() -> bool:
    for account in settings.trading_accounts:
        api_key = str(getattr(account, "api_key", "") or "").strip()
        secret_key = str(getattr(account, "secret_key", "") or "").strip()
        if api_key and secret_key:
            return True
    return False


def _primary_live_submission_blocked_reason(blocked_reasons: Sequence[str]) -> str:
    if blocked_reasons:
        return blocked_reasons[0]
    return "operational_submission_ready"


def _submission_profit_window_contract(
    context: _SubmissionGateContext,
    *,
    lineage_ref: Mapping[str, object] | None = None,
) -> dict[str, object]:
    return build_profit_window_contract(
        runtime_items=context.runtime_items,
        quant_evidence=context.quant.evidence,
        empirical_jobs_status=context.empirical_jobs_status,
        market_context_ref=context.market_context_ref,
        segment_summary=context.segment_summary,
        lineage_ref=lineage_ref,
        account=_safe_text(context.quant.evidence.get("account")),
        window=_safe_text(context.quant.evidence.get("window")),
        market_session_open=getattr(context.state, "market_session_open", None),
        replay=bool(getattr(context.state, "simulation_replay_active", False)),
        now=context.now,
    )


def _empty_submission_evidence_tuple(
    context: _SubmissionGateContext,
    capital_state: str,
) -> dict[str, object]:
    return {
        "hypothesis_id": None,
        "candidate_id": None,
        "strategy_id": None,
        "account": context.quant.evidence.get("account"),
        "window": context.quant.evidence.get("window"),
        "capital_state": capital_state,
    }


def _operational_submission_gate_payload(
    context: _SubmissionGateContext,
    *,
    blocked_reasons: list[str],
    lineage_ref: dict[str, object],
    profit_window_contract: dict[str, object],
) -> dict[str, object]:
    allowed = not blocked_reasons
    reason = (
        _primary_live_submission_blocked_reason(blocked_reasons)
        if blocked_reasons
        else "operational_submission_ready"
    )
    execution_route = _execution_route_payload(context)
    return {
        "schema_version": "torghut.operational-submission-gate.v1",
        "allowed": allowed,
        "reason": reason,
        "blocked_reasons": blocked_reasons,
        "certificate_id": None,
        "capital_stage": "live" if allowed else "operational_blocked",
        "capital_state": "live" if allowed else "blocked",
        "issued_at": None,
        "expires_at": None,
        "authority_scope": "operational_submission",
        "promotion_authority": False,
        "final_authority_ok": allowed,
        "final_promotion_allowed": False,
        "capital_promotion_allowed": False,
        "configured_live_submit": settings.trading_live_submit_enabled,
        "simple_submit_enabled": settings.trading_simple_submit_enabled,
        "testnet_after_hours_enabled": settings.trading_testnet_after_hours_enabled,
        "alpaca_regular_session_open": execution_route["alpaca_regular_session_open"],
        "execution_route": execution_route,
        "operational_submission_gate": {
            "allowed": allowed,
            "reason": reason,
            "blocked_reasons": blocked_reasons,
            "execution_route": execution_route,
        },
        **_common_submission_payload(context),
        "reason_codes": blocked_reasons or ["operational_submission_ready"],
        "segment_summary": {
            "segments": context.segment_summary,
            "evaluated_hypotheses": [],
        },
        "evidence_tuple": _empty_submission_evidence_tuple(context, "operational"),
        "lineage_ref": lineage_ref,
        "evaluated_tuples": [],
        "profit_window_contract": profit_window_contract,
    }


def _execution_route_payload(context: _SubmissionGateContext) -> dict[str, object]:
    session_open = getattr(context.state, "market_session_open", None)
    route = "alpaca" if session_open is True else "testnet"
    reason = (
        "alpaca_regular_session_open"
        if route == "alpaca"
        else "alpaca_regular_session_closed"
    )
    return {
        "route": route,
        "reason": reason,
        "alpaca_regular_session_open": session_open is True,
        "testnet_after_hours_enabled": settings.trading_testnet_after_hours_enabled,
    }


__all__ = [
    "build_tca_gate_inputs",
    "build_hypothesis_runtime_summary",
    "build_live_submission_gate_payload",
    "build_shadow_first_toggle_parity",
    "build_submission_gate_market_context_status",
    "compile_hypothesis_runtime_statuses",
    "critical_trading_toggle_snapshot",
    "load_quant_evidence_status",
    "load_hypothesis_registry",
    "resolve_active_capital_stage",
    "resolve_hypothesis_dependency_quorum",
    "resolve_quant_health_url",
    "urlopen",
]
