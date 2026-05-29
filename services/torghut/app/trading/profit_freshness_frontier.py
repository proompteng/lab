"""Profit freshness frontier projection for zero-notional repair selection."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from hashlib import sha256
import json
from typing import Any, cast

from .market_context_domains import (
    active_market_context_mapping,
    active_market_context_reasons,
)


PROFIT_FRESHNESS_FRONTIER_SCHEMA_VERSION = "torghut.profit-freshness-frontier.v1"

_FRESHNESS_SECONDS = 60
_CURRENT_STATES = {"accepted", "allow", "current", "healthy", "ok", "pass", "ready"}
_ROUTE_SETTLED_ROW_STATES = _CURRENT_STATES | {"routeable"}
_BAD_STATES = {"blocked", "degraded", "fail", "missing", "repair", "stale", "unknown"}
_DIMENSION_EXPECTED_BPS: Mapping[str, Decimal] = {
    "empirical_proof": Decimal("24"),
    "tca_fill_quality": Decimal("22"),
    "market_context": Decimal("20"),
    "signal_ingestion": Decimal("18"),
    "route_readiness": Decimal("17"),
    "feature_coverage": Decimal("16"),
    "drift_checks": Decimal("12"),
    "schema_migration_state": Decimal("10"),
    "jangar_settlement": Decimal("8"),
}
_DIMENSION_REPAIR_COST: Mapping[str, str] = {
    "empirical_proof": "medium",
    "tca_fill_quality": "medium",
    "market_context": "low",
    "signal_ingestion": "medium",
    "route_readiness": "medium",
    "feature_coverage": "medium",
    "drift_checks": "low",
    "schema_migration_state": "low",
    "jangar_settlement": "low",
}
_REPAIR_COST_PENALTY: Mapping[str, Decimal] = {
    "low": Decimal("2"),
    "medium": Decimal("5"),
    "high": Decimal("8"),
}
_DIMENSION_ACTION: Mapping[str, str] = {
    "signal_ingestion": "refresh_scoped_quant_pipeline_stage_receipts",
    "market_context": "refresh_stale_market_context_domains",
    "empirical_proof": "renew_empirical_proof_jobs",
    "feature_coverage": "rebuild_required_feature_rows",
    "drift_checks": "rerun_drift_checks_for_blocked_hypotheses",
    "tca_fill_quality": "recompute_route_tca_and_fill_quality",
    "route_readiness": "settle_routeability_acceptance_lots",
    "schema_migration_state": "refresh_schema_and_migration_lineage_receipts",
    "jangar_settlement": "refresh_jangar_reliability_settlement",
}
_DIMENSION_REPAIR_CLASSES: Mapping[str, tuple[str, ...]] = {
    "signal_ingestion": ("quant", "scoped_quant", "signal", "signal_ingestion"),
    "market_context": ("market_context",),
    "empirical_proof": ("empirical", "empirical_proof", "replay", "simulation"),
    "feature_coverage": ("feature", "feature_coverage"),
    "drift_checks": ("drift", "drift_checks"),
    "tca_fill_quality": ("fill_quality", "route_tca", "tca"),
    "route_readiness": ("route", "routeability", "route_readiness"),
    "schema_migration_state": ("migration", "schema", "schema_migration"),
    "jangar_settlement": ("jangar", "jangar_settlement", "reliability_settlement"),
}
_DAILY_NET_PNL_UNLOCK_KEYS = (
    "expected_daily_net_pnl_unlock",
    "post_cost_daily_net_pnl_unlock",
    "expected_post_cost_daily_net_pnl_unlock",
    "quality_adjusted_daily_net_pnl_unlock",
    "expected_daily_net_pnl",
    "post_cost_daily_net_pnl",
    "quality_adjusted_daily_net_pnl",
    "net_pnl_per_day",
    "daily_net_pnl",
)
_DIMENSION_SUCCESS: Mapping[str, str] = {
    "signal_ingestion": "scoped quant metrics and stage receipts are current",
    "market_context": "required market-context domains are fresh for the active symbol set",
    "empirical_proof": "all required empirical jobs are fresh, truthful, and promotion eligible",
    "feature_coverage": "required feature rows are present for blocked hypotheses",
    "drift_checks": "drift checks are present for blocked hypotheses",
    "tca_fill_quality": "route TCA rows are fresh and inside fill-quality guardrails",
    "route_readiness": "routeability acceptance ledger is accepted with settled receipt refs",
    "schema_migration_state": "schema and migration lineage blockers are absent",
    "jangar_settlement": "Jangar reliability settlement allows paper canary consideration",
}
_ROUTEABILITY_ONLY_TCA_REASON_CODES = {
    "execution_tca_route_universe_exclusions_applied",
    "execution_tca_symbol_missing",
    "route_tca_passed_but_dependency_receipts_block_capital",
}
_ROUTEABILITY_ONLY_TCA_REASON_PREFIXES = ("capital_state_", "proof_floor_")
_NONBLOCKING_JANGAR_RELIABILITY_REASONS = {
    "torghut_dependency_quorum_not_required",
}
_NONBLOCKING_QUANT_HEALTH_REASONS = {
    "quant_health_not_configured",
}
_ROUTEABILITY_TCA_REPAIR_LOT_TYPES = {"route_universe_tca_repair"}
_ROUTEABILITY_TCA_REPAIR_ACTION = "recompute_route_tca_and_fill_quality"
_ROUTEABILITY_TCA_REPAIR_REASON_PREFIXES = ("execution_tca_", "route_tca_")
_ROUTEABILITY_TCA_REPAIR_REASON_FRAGMENTS = ("slippage", "route_universe")
_ALPHA_FEATURE_REPLAY_REASON_CODES = {
    "feature_rows_missing",
    "required_feature_set_unavailable",
}
_ALPHA_FEATURE_REPLAY_PRIORITY_BONUS = Decimal("3")
_ALPHA_FEATURE_ROUTEABILITY_PRIORITY_BONUS = Decimal("3")
_ALPHA_READINESS_ROUTEABILITY_REASON_CODES = {
    "alpha_readiness_fail",
    "alpha_readiness_not_promotion_eligible",
    "hypothesis_not_promotion_eligible",
}


def _mapping(value: object) -> Mapping[str, Any]:
    return cast(Mapping[str, Any], value) if isinstance(value, Mapping) else {}


def _sequence(value: object) -> Sequence[object]:
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return cast(Sequence[object], value)
    return ()


def _text(value: object, default: str = "") -> str:
    if value is None:
        return default
    text = str(value).strip()
    return text or default


def _decimal(value: object) -> Decimal | None:
    if value is None:
        return None
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None


def _decimal_text(value: Decimal | None) -> str | None:
    if value is None:
        return None
    text = format(value, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    if text in {"", "-0"}:
        return "0"
    return text


def _int(value: object, default: int = 0) -> int:
    parsed = _decimal(value)
    return default if parsed is None else int(parsed)


def _float(value: object) -> float | None:
    parsed = _decimal(value)
    return None if parsed is None else float(parsed)


def _bool(value: object, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {
            "1",
            "true",
            "yes",
            "on",
            "allow",
            "allowed",
            "healthy",
            "ok",
            "ready",
        }:
            return True
        if normalized in {"0", "false", "no", "off", "blocked", "degraded", "missing"}:
            return False
    return default


def _unique(values: Sequence[str]) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for value in values:
        normalized = value.strip()
        if normalized and normalized not in seen:
            result.append(normalized)
            seen.add(normalized)
    return result


def _strings(value: object) -> list[str]:
    return _unique([_text(item) for item in _sequence(value)])


def _symbols(value: object) -> list[str]:
    if isinstance(value, str):
        return _unique([value.upper()])
    return _unique([_text(item).upper() for item in _sequence(value)])


def _stable_ref(prefix: str, payload: Mapping[str, object]) -> str:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return f"{prefix}:{sha256(encoded.encode()).hexdigest()[:16]}"


def _timestamp(value: object) -> datetime | None:
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, str) and value.strip():
        raw = value.strip()
        if raw.endswith("Z"):
            raw = f"{raw[:-1]}+00:00"
        try:
            parsed = datetime.fromisoformat(raw)
        except ValueError:
            return None
    else:
        return None
    return (
        parsed.replace(tzinfo=timezone.utc)
        if parsed.tzinfo is None
        else parsed.astimezone(timezone.utc)
    )


def _state_from_reasons(
    reasons: Sequence[str],
    *,
    missing: bool = False,
    stale: bool = False,
    blocked: bool = False,
) -> str:
    if missing:
        return "missing"
    if blocked:
        return "blocked"
    if stale:
        return "stale"
    if reasons:
        if any("stale" in reason or "lag" in reason for reason in reasons):
            return "stale"
        if any("missing" in reason or "empty" in reason for reason in reasons):
            return "missing"
        if any("blocked" in reason or "disabled" in reason for reason in reasons):
            return "blocked"
        return "degraded"
    return "current"


def _hypothesis_items(hypothesis_payload: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    return [_mapping(item) for item in _sequence(hypothesis_payload.get("items"))]


def _hypothesis_summary(hypothesis_payload: Mapping[str, Any]) -> Mapping[str, Any]:
    summary = _mapping(hypothesis_payload.get("summary"))
    return summary if summary else hypothesis_payload


def _hypothesis_ids_for_reasons(
    hypothesis_payload: Mapping[str, Any],
    target_reasons: Sequence[str],
) -> list[str]:
    targets = set(target_reasons)
    ids: list[str] = []
    for item in _hypothesis_items(hypothesis_payload):
        reasons = set(_strings(item.get("reasons")))
        if not targets or reasons.intersection(targets):
            for key in ("hypothesis_id", "id", "candidate_id", "strategy_id"):
                if value := _text(item.get(key)):
                    ids.append(value)
                    break
    return _unique(ids)


def _reason_total(
    hypothesis_payload: Mapping[str, Any],
    reason: str,
) -> int:
    summary = _hypothesis_summary(hypothesis_payload)
    totals = _mapping(summary.get("reason_totals"))
    if reason in totals:
        return _int(totals.get(reason))
    return sum(
        1
        for item in _hypothesis_items(hypothesis_payload)
        if reason in _strings(item.get("reasons"))
    )


def _dimension(
    *,
    name: str,
    state: str,
    generated_at: datetime,
    reason_codes: Sequence[str],
    evidence_refs: Sequence[str],
    blocking_hypotheses: Sequence[str] = (),
    staleness_seconds: int | None = None,
    observed_at: object = None,
    fresh_until: object = None,
    details: Mapping[str, object] | None = None,
) -> dict[str, object]:
    observed = _timestamp(observed_at) or generated_at
    fresh = (
        _text(fresh_until)
        or (
            observed + timedelta(seconds=_FRESHNESS_SECONDS)
            if state == "current"
            else generated_at
        ).isoformat()
    )
    return {
        "dimension": name,
        "state": state,
        "observed_at": observed.isoformat(),
        "fresh_until": fresh,
        "staleness_seconds": staleness_seconds,
        "blocking_hypotheses": list(blocking_hypotheses),
        "reason_codes": _unique(list(reason_codes)),
        "evidence_refs": _unique(list(evidence_refs)),
        "details": dict(details or {}),
    }


def _proof_dimension(
    proof_floor_receipt: Mapping[str, Any],
    dimension_name: str,
) -> Mapping[str, Any]:
    for raw_dimension in _sequence(proof_floor_receipt.get("proof_dimensions")):
        dimension = _mapping(raw_dimension)
        if _text(dimension.get("dimension")) == dimension_name:
            return dimension
    return {}


def _market_domain_states(
    market_context_status: Mapping[str, Any],
) -> Mapping[str, Any]:
    for key in ("last_domain_states", "domain_states", "domains"):
        domains = _mapping(market_context_status.get(key))
        if domains:
            return domains
    return _mapping(_mapping(market_context_status.get("health")).get("domain_states"))


def _market_dimension(
    *,
    market_context_status: Mapping[str, Any],
    hypothesis_payload: Mapping[str, Any],
    generated_at: datetime,
) -> dict[str, object]:
    reasons = active_market_context_reasons(
        [
            *_strings(market_context_status.get("blocking_reasons")),
            *_strings(market_context_status.get("reason_codes")),
            *_strings(market_context_status.get("last_risk_flags")),
        ]
    )
    status = _text(
        _mapping(market_context_status.get("health")).get("status")
        or market_context_status.get("status")
        or market_context_status.get("state")
        or market_context_status.get("last_reason")
    ).lower()
    stale_domains: list[str] = []
    for domain_name, raw_domain in active_market_context_mapping(
        _market_domain_states(market_context_status)
    ).items():
        domain = _mapping(raw_domain)
        domain_state = _text(domain.get("status") or domain.get("state")).lower()
        if domain_state == "stale" or domain.get("stale") is True:
            stale_domains.append(str(domain_name))
    if _bool(market_context_status.get("alert_active")):
        reasons.extend(
            active_market_context_reasons(
                [
                    _text(
                        market_context_status.get("alert_reason"),
                        "market_context_alert_active",
                    )
                ]
            )
        )
    if status and status not in _CURRENT_STATES and status != "fresh":
        reasons.append(f"market_context_{status}")
    reasons.extend([f"market_context_{domain}_stale" for domain in stale_domains])
    staleness = _int(market_context_status.get("last_freshness_seconds"), default=-1)
    stale = (
        bool(stale_domains)
        or "stale" in status
        or staleness
        > _int(
            market_context_status.get("max_staleness_seconds"),
            default=86_400,
        )
    )
    if stale and not reasons:
        reasons.append("market_context_stale")
    return _dimension(
        name="market_context",
        state=_state_from_reasons(
            reasons, missing=not market_context_status, stale=stale
        ),
        generated_at=generated_at,
        reason_codes=reasons,
        evidence_refs=[
            _text(market_context_status.get("last_symbol"), "market_context"),
            *_unique([f"market_context:{domain}" for domain in stale_domains]),
        ],
        blocking_hypotheses=_hypothesis_ids_for_reasons(
            hypothesis_payload, ["market_context_stale"]
        ),
        staleness_seconds=None if staleness < 0 else staleness,
        observed_at=market_context_status.get("last_checked_at")
        or market_context_status.get("last_as_of"),
        details={"stale_domains": _unique(stale_domains)},
    )


def _signal_dimension(
    *,
    quant_evidence: Mapping[str, Any],
    hypothesis_payload: Mapping[str, Any],
    generated_at: datetime,
) -> dict[str, object]:
    informational_reasons = [
        reason
        for reason in _strings(quant_evidence.get("informational_reasons"))
        if reason in _NONBLOCKING_QUANT_HEALTH_REASONS
    ]
    reasons = [
        *_strings(quant_evidence.get("blocking_reasons")),
        *_strings(quant_evidence.get("non_promoting_receipts")),
    ]
    latest_count = _int(
        quant_evidence.get("latest_metrics_count")
        or quant_evidence.get("latestMetricsCount"),
        default=-1,
    )
    stage_count = _int(
        quant_evidence.get("stage_count") or quant_evidence.get("stageCount"),
        default=-1,
    )
    lag_seconds = max(
        _int(quant_evidence.get("metrics_pipeline_lag_seconds"), default=0),
        _int(
            quant_evidence.get("max_stage_lag_seconds")
            or quant_evidence.get("maxStageLagSeconds"),
            default=0,
        ),
    )
    status = _text(quant_evidence.get("status") or quant_evidence.get("state")).lower()
    quant_required = quant_evidence.get("required") is True
    quant_is_not_required = quant_evidence.get("required") is False and (
        status == "not_required"
        or not _text(
            quant_evidence.get("source_url") or quant_evidence.get("sourceUrl")
        )
    )
    quant_counts_are_authoritative = quant_required or not quant_is_not_required
    if quant_counts_are_authoritative and latest_count <= 0:
        reasons.append("signal_latest_metrics_missing")
    if quant_counts_are_authoritative and stage_count <= 0:
        reasons.append("signal_pipeline_stages_missing")
    if quant_evidence.get("ok") is False:
        reasons.append(_text(quant_evidence.get("reason"), "quant_health_degraded"))
    elif status and status not in _CURRENT_STATES and status != "not_required":
        reasons.append(_text(quant_evidence.get("reason"), f"quant_health_{status}"))
    return _dimension(
        name="signal_ingestion",
        state=_state_from_reasons(
            reasons,
            missing=latest_count == 0 or stage_count == 0,
            stale=lag_seconds > 0,
        ),
        generated_at=generated_at,
        reason_codes=reasons,
        evidence_refs=[_text(quant_evidence.get("source_url"), "quant_health")],
        blocking_hypotheses=_hypothesis_ids_for_reasons(
            hypothesis_payload, ["signal_lag_exceeded"]
        ),
        staleness_seconds=lag_seconds or None,
        observed_at=quant_evidence.get("as_of")
        or quant_evidence.get("latest_metrics_updated_at"),
        details={
            "latest_metrics_count": latest_count if latest_count >= 0 else None,
            "stage_count": stage_count,
            **(
                {"informational_reason_codes": informational_reasons}
                if informational_reasons
                else {}
            ),
        },
    )


def _empirical_dimension(
    *,
    empirical_jobs_status: Mapping[str, Any],
    generated_at: datetime,
) -> dict[str, object]:
    reasons = [
        *_strings(empirical_jobs_status.get("blocked_reasons")),
        *[
            f"empirical_job_missing:{item}"
            for item in _strings(empirical_jobs_status.get("missing_jobs"))
        ],
        *[
            f"empirical_job_stale:{item}"
            for item in _strings(empirical_jobs_status.get("stale_jobs"))
        ],
        *[
            f"empirical_job_ineligible:{item}"
            for item in _strings(empirical_jobs_status.get("ineligible_jobs"))
        ],
    ]
    jobs = _mapping(empirical_jobs_status.get("jobs"))
    for job_name, raw_job in jobs.items():
        job = _mapping(raw_job)
        reasons.extend(
            [f"{job_name}:{reason}" for reason in _strings(job.get("blocked_reasons"))]
        )
    ready = _bool(empirical_jobs_status.get("ready"))
    if not ready and not reasons:
        reasons.append(
            _text(empirical_jobs_status.get("status"), "empirical_jobs_not_ready")
        )
    state = _state_from_reasons(
        reasons,
        missing=bool(_strings(empirical_jobs_status.get("missing_jobs")))
        or not empirical_jobs_status,
        stale=bool(_strings(empirical_jobs_status.get("stale_jobs"))),
    )
    return _dimension(
        name="empirical_proof",
        state="current" if ready and not reasons else state,
        generated_at=generated_at,
        reason_codes=reasons,
        evidence_refs=[
            *_strings(empirical_jobs_status.get("dataset_snapshot_refs")),
            *_strings(empirical_jobs_status.get("candidate_ids")),
        ]
        or ["empirical_jobs"],
        blocking_hypotheses=_strings(empirical_jobs_status.get("candidate_ids")),
        observed_at=empirical_jobs_status.get("last_completed_at")
        or empirical_jobs_status.get("as_of"),
        details={
            "eligible_jobs": _strings(empirical_jobs_status.get("eligible_jobs")),
            "missing_jobs": _strings(empirical_jobs_status.get("missing_jobs")),
            "stale_jobs": _strings(empirical_jobs_status.get("stale_jobs")),
        },
    )


def _hypothesis_dimension(
    *,
    name: str,
    reason_names: Sequence[str],
    hypothesis_payload: Mapping[str, Any],
    generated_at: datetime,
) -> dict[str, object]:
    reasons: list[str] = []
    for reason_name in reason_names:
        count = _reason_total(hypothesis_payload, reason_name)
        if count > 0:
            reasons.append(reason_name)
    return _dimension(
        name=name,
        state=_state_from_reasons(reasons, missing=bool(reasons)),
        generated_at=generated_at,
        reason_codes=reasons,
        evidence_refs=[
            f"hypothesis:{hypothesis_id}"
            for hypothesis_id in _hypothesis_ids_for_reasons(
                hypothesis_payload, reason_names
            )
        ]
        or ["hypothesis_runtime_summary"],
        blocking_hypotheses=_hypothesis_ids_for_reasons(
            hypothesis_payload, reason_names
        ),
        details={
            "reason_totals": {
                reason: _reason_total(hypothesis_payload, reason)
                for reason in reason_names
            }
        },
    )


def _route_rows(
    route_reacquisition_board: Mapping[str, Any],
) -> list[Mapping[str, Any]]:
    return [_mapping(row) for row in _sequence(route_reacquisition_board.get("rows"))]


def _route_symbols(route_reacquisition_board: Mapping[str, Any]) -> list[str]:
    return sorted(
        {
            _text(row.get("symbol")).upper()
            for row in _route_rows(route_reacquisition_board)
            if _text(row.get("symbol"))
        }
    )


def _routeability_only_tca_reason(reason: str) -> bool:
    return reason in _ROUTEABILITY_ONLY_TCA_REASON_CODES or reason.startswith(
        _ROUTEABILITY_ONLY_TCA_REASON_PREFIXES
    )


def _tca_dimension(
    *,
    proof_floor_receipt: Mapping[str, Any],
    routeability_ledger: Mapping[str, Any],
    route_reacquisition_board: Mapping[str, Any],
    generated_at: datetime,
) -> dict[str, object]:
    execution_tca = _proof_dimension(proof_floor_receipt, "execution_tca")
    route_lot: Mapping[str, Any] = {}
    for raw_lot in _sequence(routeability_ledger.get("lots")):
        lot = _mapping(raw_lot)
        if _text(lot.get("lot_type")) == "route_universe_tca_repair":
            route_lot = lot
            break
    proof_state = _text(execution_tca.get("state"), "missing").lower()
    reasons: list[str] = []
    if not execution_tca:
        reasons.append("execution_tca_missing")
    else:
        for reason in _strings(execution_tca.get("blocking_reason_codes")):
            if proof_state not in _CURRENT_STATES or not _routeability_only_tca_reason(
                reason
            ):
                reasons.append(reason)
    proof_reason = _text(execution_tca.get("reason"))
    if proof_state not in _CURRENT_STATES:
        if proof_reason:
            reasons.append(proof_reason)
        elif proof_state == "missing":
            reasons.append("execution_tca_missing")
        elif proof_state == "stale":
            reasons.append("execution_tca_stale")
        elif proof_state:
            reasons.append(f"execution_tca_{proof_state}")
    routeability_reasons: list[str] = [
        *_strings(routeability_ledger.get("aggregate_blocking_reason_codes")),
        *_strings(route_lot.get("blocking_reason_codes")),
    ]
    blocked_symbols: list[str] = []
    for row in _route_rows(route_reacquisition_board):
        row_state = _text(row.get("state")).lower()
        blocker = _text(row.get("current_blocker"))
        if blocker and row_state not in _ROUTE_SETTLED_ROW_STATES:
            routeability_reasons.append(blocker)
            if symbol := _text(row.get("symbol")).upper():
                blocked_symbols.append(symbol)
    freshness_seconds = _int(execution_tca.get("freshness_seconds"), default=-1)
    missing = proof_state == "missing" or any("missing" in reason for reason in reasons)
    stale = proof_state == "stale"
    return _dimension(
        name="tca_fill_quality",
        state=_state_from_reasons(
            reasons,
            missing=missing,
            stale=stale,
            blocked=proof_state in _BAD_STATES and not missing and not stale,
        ),
        generated_at=generated_at,
        reason_codes=reasons,
        evidence_refs=[
            _text(routeability_ledger.get("ledger_id"), "routeability_acceptance"),
            "execution_tca",
        ],
        blocking_hypotheses=_strings(route_lot.get("hypothesis_ids"))
        if reasons
        else [],
        staleness_seconds=None if freshness_seconds < 0 else freshness_seconds,
        observed_at=_mapping(execution_tca.get("source_ref")).get("last_computed_at"),
        details={
            "symbols": _route_symbols(route_reacquisition_board),
            "routeability_blocker_codes": _unique(routeability_reasons),
            "routeability_blocked_symbols": _unique(blocked_symbols),
        },
    )


def _route_readiness_dimension(
    *,
    routeability_ledger: Mapping[str, Any],
    generated_at: datetime,
) -> dict[str, object]:
    aggregate_state = _text(
        routeability_ledger.get("aggregate_state"), "missing"
    ).lower()
    accepted_count = _int(routeability_ledger.get("accepted_routeable_candidate_count"))
    reasons = [
        *_strings(routeability_ledger.get("aggregate_blocking_reason_codes")),
    ]
    if aggregate_state not in {"accepted", "current"}:
        reasons.append(f"routeability_acceptance_{aggregate_state}")
    if aggregate_state in {"accepted", "current"} and accepted_count <= 0:
        reasons.append("routeability_candidate_count_zero")
    return _dimension(
        name="route_readiness",
        state="current" if not reasons else _state_from_reasons(reasons, blocked=True),
        generated_at=generated_at,
        reason_codes=reasons,
        evidence_refs=[
            _text(routeability_ledger.get("ledger_id"), "routeability_acceptance")
        ],
        details={
            "accepted_routeable_candidate_count": accepted_count,
            "aggregate_state": aggregate_state,
        },
    )


def _is_routeability_tca_repair_reason(reason: str) -> bool:
    normalized = reason.strip().lower()
    return normalized.startswith(_ROUTEABILITY_TCA_REPAIR_REASON_PREFIXES) or any(
        fragment in normalized for fragment in _ROUTEABILITY_TCA_REPAIR_REASON_FRAGMENTS
    )


def _route_readiness_action(routeability_ledger: Mapping[str, Any]) -> str:
    for raw_lot in _sequence(routeability_ledger.get("lots")):
        lot = _mapping(raw_lot)
        if _text(lot.get("lot_type")) not in _ROUTEABILITY_TCA_REPAIR_LOT_TYPES:
            continue
        if _text(lot.get("current_state")).lower() in _CURRENT_STATES:
            continue
        if any(
            _is_routeability_tca_repair_reason(reason)
            for reason in _strings(lot.get("blocking_reason_codes"))
        ):
            return _ROUTEABILITY_TCA_REPAIR_ACTION
    return _DIMENSION_ACTION["route_readiness"]


def _zero_notional_action(
    dimension_name: str,
    *,
    routeability_ledger: Mapping[str, Any],
) -> str:
    if dimension_name == "route_readiness":
        return _route_readiness_action(routeability_ledger)
    return _DIMENSION_ACTION.get(dimension_name, "observe_profit_freshness_frontier")


def _schema_dimension(
    *,
    proof_floor_receipt: Mapping[str, Any],
    generated_at: datetime,
) -> dict[str, object]:
    reasons = [
        reason
        for reason in _strings(proof_floor_receipt.get("blocking_reasons"))
        if "schema" in reason or "migration" in reason or "lineage" in reason
    ]
    return _dimension(
        name="schema_migration_state",
        state=_state_from_reasons(reasons, missing=bool(reasons)),
        generated_at=generated_at,
        reason_codes=reasons,
        evidence_refs=[_text(proof_floor_receipt.get("schema_version"), "proof_floor")],
    )


def _jangar_dimension(
    *,
    jangar_reliability_settlement_ref: Mapping[str, Any],
    generated_at: datetime,
) -> dict[str, object]:
    decision = _text(
        jangar_reliability_settlement_ref.get("decision")
        or jangar_reliability_settlement_ref.get("state")
        or jangar_reliability_settlement_ref.get("status"),
        "missing",
    ).lower()
    state = _text(
        jangar_reliability_settlement_ref.get("state") or decision, "missing"
    ).lower()
    raw_reasons = [
        *_strings(jangar_reliability_settlement_ref.get("reason_codes")),
        *_strings(jangar_reliability_settlement_ref.get("blocking_reasons")),
        *_strings(jangar_reliability_settlement_ref.get("reasons")),
    ]
    reasons = [
        reason
        for reason in raw_reasons
        if reason not in _NONBLOCKING_JANGAR_RELIABILITY_REASONS
    ]
    if decision not in _CURRENT_STATES:
        reasons.append(f"jangar_reliability_settlement_{decision}")
    if state in _BAD_STATES and state != decision:
        reasons.append(f"jangar_reliability_settlement_{state}")
    return _dimension(
        name="jangar_settlement",
        state="current"
        if not reasons
        else _state_from_reasons(reasons, missing=decision == "missing", blocked=True),
        generated_at=generated_at,
        reason_codes=reasons,
        evidence_refs=[
            _text(
                jangar_reliability_settlement_ref.get("ledger_id")
                or jangar_reliability_settlement_ref.get("settlement_ref"),
                "jangar_reliability_settlement",
            )
        ],
        observed_at=jangar_reliability_settlement_ref.get("generated_at"),
        fresh_until=jangar_reliability_settlement_ref.get("fresh_until"),
        details={
            "decision": decision,
            "state": state,
            "source": jangar_reliability_settlement_ref.get("source"),
            "informational_reason_codes": [
                reason
                for reason in raw_reasons
                if reason in _NONBLOCKING_JANGAR_RELIABILITY_REASONS
            ],
        },
    )


def _confidence_for_state(state: str) -> Decimal:
    if state == "stale":
        return Decimal("0.90")
    if state == "degraded":
        return Decimal("0.70")
    if state == "missing":
        return Decimal("0.55")
    if state == "blocked":
        return Decimal("0.50")
    return Decimal("0")


def _routeability_confidence(routeability_ledger: Mapping[str, Any]) -> Decimal:
    state = _text(routeability_ledger.get("aggregate_state"), "missing").lower()
    if state == "accepted":
        return Decimal("1.00")
    if state in {"repairing", "stale"}:
        return Decimal("0.65")
    if state in {"blocked", "missing"}:
        return Decimal("0.45")
    return Decimal("0.55")


def _jangar_confidence(jangar_reliability_settlement_ref: Mapping[str, Any]) -> Decimal:
    decision = _text(
        jangar_reliability_settlement_ref.get("decision")
        or jangar_reliability_settlement_ref.get("state"),
        "missing",
    ).lower()
    if decision in _CURRENT_STATES:
        return Decimal("1.00")
    if decision in {"delay", "hold"}:
        return Decimal("0.45")
    if decision in {"block", "missing"}:
        return Decimal("0.15")
    return Decimal("0.30")


def _packet_dimension(packet: Mapping[str, Any]) -> str:
    explicit = _text(
        packet.get("blocked_dimension")
        or packet.get("dimension")
        or packet.get("repair_dimension")
    ).lower()
    if explicit in _DIMENSION_EXPECTED_BPS:
        return explicit
    repair_class = _text(
        packet.get("repair_class")
        or packet.get("lot_type")
        or packet.get("repair_type")
    ).lower()
    for dimension_name, repair_classes in _DIMENSION_REPAIR_CLASSES.items():
        if repair_class in repair_classes:
            return dimension_name
    return ""


def _packet_hypothesis_refs(packet: Mapping[str, Any]) -> list[str]:
    refs = [
        _text(packet.get(key))
        for key in (
            "hypothesis_ref",
            "hypothesis_id",
            "candidate_id",
            "strategy_id",
        )
    ]
    refs.extend(_strings(packet.get("hypothesis_ids")))
    refs.extend(_strings(packet.get("candidate_ids")))
    return _unique(refs)


def _packet_symbols(packet: Mapping[str, Any]) -> list[str]:
    symbols = [_text(packet.get("symbol")).upper()]
    symbols.extend(_symbols(packet.get("symbol_set")))
    symbols.extend(_symbols(packet.get("symbols")))
    return _unique(symbols)


def _daily_net_pnl_unlock(source: Mapping[str, Any]) -> Decimal | None:
    for key in _DAILY_NET_PNL_UNLOCK_KEYS:
        parsed = _decimal(source.get(key))
        if parsed is not None:
            return parsed
    for nested_key in (
        "profit_metrics",
        "metrics",
        "objective_scorecard",
        "scorecard",
        "selection_objectives",
    ):
        nested = _mapping(source.get(nested_key))
        for key in _DAILY_NET_PNL_UNLOCK_KEYS:
            parsed = _decimal(nested.get(key))
            if parsed is not None:
                return parsed
    return None


def _expected_daily_net_pnl_unlock(
    *,
    dimension_name: str,
    quality_adjusted_profit_frontier: Mapping[str, Any],
    blocking_hypotheses: Sequence[str],
    candidate_ids: Sequence[str],
    symbol_set: Sequence[str],
) -> tuple[Decimal | None, list[str]]:
    targets = set(blocking_hypotheses) | set(candidate_ids)
    symbols = {symbol.upper() for symbol in symbol_set if symbol}
    best_value: Decimal | None = None
    best_refs: list[str] = []

    for raw_packet in _sequence(quality_adjusted_profit_frontier.get("packets")):
        packet = _mapping(raw_packet)
        if _packet_dimension(packet) != dimension_name:
            continue
        value = _daily_net_pnl_unlock(packet)
        if value is None:
            continue
        packet_refs = _packet_hypothesis_refs(packet)
        if (
            targets
            and packet_refs
            and "global" not in packet_refs
            and targets.isdisjoint(packet_refs)
        ):
            continue
        packet_symbols = _packet_symbols(packet)
        if symbols and packet_symbols and symbols.isdisjoint(packet_symbols):
            continue
        packet_ref = _text(
            packet.get("packet_id")
            or packet.get("receipt_id")
            or packet.get("evidence_ref"),
            "quality_adjusted_profit_frontier",
        )
        if best_value is None or value > best_value:
            best_value = value
            best_refs = [packet_ref]
        elif value == best_value:
            best_refs.append(packet_ref)

    return best_value, _unique(best_refs)


def _repair_lot(
    *,
    dimension: Mapping[str, Any],
    routeability_ledger: Mapping[str, Any],
    quality_adjusted_profit_frontier: Mapping[str, Any],
    jangar_reliability_settlement_ref: Mapping[str, Any],
    route_reacquisition_board: Mapping[str, Any],
    empirical_jobs_status: Mapping[str, Any],
) -> dict[str, object]:
    dimension_name = _text(dimension.get("dimension"))
    state = _text(dimension.get("state"), "unknown")
    repair_cost_class = _DIMENSION_REPAIR_COST.get(dimension_name, "medium")
    expected_bps = _DIMENSION_EXPECTED_BPS.get(dimension_name, Decimal("5"))
    reason_codes = _strings(dimension.get("reason_codes"))
    priority_adjustments: list[str] = []
    priority_bonus = Decimal("0")
    if dimension_name == "feature_coverage" and set(reason_codes).intersection(
        _ALPHA_FEATURE_REPLAY_REASON_CODES
    ):
        priority_adjustments.append("alpha_feature_replay_closure")
        priority_bonus += _ALPHA_FEATURE_REPLAY_PRIORITY_BONUS
        routeability_reasons = set(
            _strings(routeability_ledger.get("aggregate_blocking_reason_codes"))
        )
        if routeability_reasons.intersection(
            _ALPHA_READINESS_ROUTEABILITY_REASON_CODES
        ):
            priority_adjustments.append("alpha_readiness_routeability_closure")
            priority_bonus += _ALPHA_FEATURE_ROUTEABILITY_PRIORITY_BONUS
    blocking_hypotheses = _strings(dimension.get("blocking_hypotheses"))
    candidate_ids = _strings(empirical_jobs_status.get("candidate_ids"))
    symbol_set = _route_symbols(route_reacquisition_board)
    expected_daily_net_pnl_unlock, profit_unlock_refs = _expected_daily_net_pnl_unlock(
        dimension_name=dimension_name,
        quality_adjusted_profit_frontier=quality_adjusted_profit_frontier,
        blocking_hypotheses=blocking_hypotheses,
        candidate_ids=candidate_ids if dimension_name == "empirical_proof" else (),
        symbol_set=symbol_set,
    )
    expected_profit = expected_daily_net_pnl_unlock or expected_bps
    repair_priority = (
        expected_profit
        * _confidence_for_state(state)
        * _routeability_confidence(routeability_ledger)
        * _jangar_confidence(jangar_reliability_settlement_ref)
        - _REPAIR_COST_PENALTY.get(repair_cost_class, Decimal("5"))
        + priority_bonus
    )
    lot_id = _stable_ref(
        "profit-freshness-repair-lot",
        {
            "dimension": dimension_name,
            "state": state,
            "reason_codes": reason_codes,
            "hypotheses": blocking_hypotheses,
            "symbols": symbol_set,
        },
    )
    return {
        "lot_id": lot_id,
        "hypothesis_id": blocking_hypotheses[0] if blocking_hypotheses else None,
        "candidate_id": candidate_ids[0] if candidate_ids else None,
        "symbol_set": symbol_set,
        "blocked_dimension": dimension_name,
        "before_refs": _strings(dimension.get("evidence_refs")),
        "zero_notional_action": _zero_notional_action(
            dimension_name,
            routeability_ledger=routeability_ledger,
        ),
        "expected_profit_unlock_bps": float(expected_bps),
        "expected_daily_net_pnl_unlock": _decimal_text(expected_daily_net_pnl_unlock),
        "profit_unlock_refs": profit_unlock_refs,
        "repair_priority": round(float(repair_priority), 4),
        "priority_adjustments": priority_adjustments,
        "repair_priority_basis": (
            "expected_daily_net_pnl_unlock"
            if expected_daily_net_pnl_unlock is not None
            else "expected_profit_unlock_bps_proxy"
        ),
        "repair_cost_class": repair_cost_class,
        "validation_window": "next_market_session",
        "success_criteria": _DIMENSION_SUCCESS.get(
            dimension_name, "dimension state becomes current"
        ),
        "guardrail_failures": [
            reason
            for reason in reason_codes
            if "guardrail" in reason or "slippage" in reason or "capital" in reason
        ],
        "after_refs": [],
        "state": "queued_zero_notional_repair",
        "paper_notional_limit": "0",
        "live_notional_limit": "0",
    }


def build_profit_freshness_frontier(
    *,
    account_label: str | None,
    trading_mode: str,
    proof_window: str | None,
    torghut_revision: str | None,
    proof_floor_receipt: Mapping[str, Any],
    routeability_repair_acceptance_ledger: Mapping[str, Any],
    quality_adjusted_profit_frontier: Mapping[str, Any],
    route_reacquisition_board: Mapping[str, Any],
    live_submission_gate: Mapping[str, Any],
    quant_evidence: Mapping[str, Any],
    market_context_status: Mapping[str, Any],
    empirical_jobs_status: Mapping[str, Any],
    hypothesis_payload: Mapping[str, Any],
    jangar_reliability_settlement_ref: Mapping[str, Any],
    now: datetime | None = None,
) -> dict[str, object]:
    """Build an observe-only frontier that ranks zero-notional proof repairs."""

    observed_at = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    generated_at = observed_at.isoformat()
    account = account_label or _text(proof_floor_receipt.get("account_label")) or None
    feature_dimension = _hypothesis_dimension(
        name="feature_coverage",
        reason_names=["feature_rows_missing", "required_feature_set_unavailable"],
        hypothesis_payload=hypothesis_payload,
        generated_at=observed_at,
    )
    drift_dimension = _hypothesis_dimension(
        name="drift_checks",
        reason_names=["drift_checks_missing"],
        hypothesis_payload=hypothesis_payload,
        generated_at=observed_at,
    )
    dimensions = [
        _signal_dimension(
            quant_evidence=quant_evidence,
            hypothesis_payload=hypothesis_payload,
            generated_at=observed_at,
        ),
        _market_dimension(
            market_context_status=market_context_status,
            hypothesis_payload=hypothesis_payload,
            generated_at=observed_at,
        ),
        _empirical_dimension(
            empirical_jobs_status=empirical_jobs_status,
            generated_at=observed_at,
        ),
        feature_dimension,
        drift_dimension,
        _tca_dimension(
            proof_floor_receipt=proof_floor_receipt,
            routeability_ledger=routeability_repair_acceptance_ledger,
            route_reacquisition_board=route_reacquisition_board,
            generated_at=observed_at,
        ),
        _route_readiness_dimension(
            routeability_ledger=routeability_repair_acceptance_ledger,
            generated_at=observed_at,
        ),
        _schema_dimension(
            proof_floor_receipt=proof_floor_receipt,
            generated_at=observed_at,
        ),
        _jangar_dimension(
            jangar_reliability_settlement_ref=jangar_reliability_settlement_ref,
            generated_at=observed_at,
        ),
    ]
    aggregate_blockers = _unique(
        [
            _text(reason)
            for dimension in dimensions
            for reason in _sequence(dimension.get("reason_codes"))
        ]
    )
    active_lots = [
        _repair_lot(
            dimension=dimension,
            routeability_ledger=routeability_repair_acceptance_ledger,
            quality_adjusted_profit_frontier=quality_adjusted_profit_frontier,
            jangar_reliability_settlement_ref=jangar_reliability_settlement_ref,
            route_reacquisition_board=route_reacquisition_board,
            empirical_jobs_status=empirical_jobs_status,
        )
        for dimension in dimensions
        if _text(dimension.get("state")) != "current"
    ]
    active_lots.sort(
        key=lambda lot: (
            -(_float(lot.get("repair_priority")) or 0.0),
            _text(lot.get("lot_id")),
        )
    )
    if active_lots:
        active_lots[0] = {
            **active_lots[0],
            "state": "selected_zero_notional_repair",
        }
    selected_repairs = active_lots[:1]
    selected_daily_net_pnl_unlock: Decimal | None = None
    for repair in selected_repairs:
        value = _decimal(repair.get("expected_daily_net_pnl_unlock"))
        if value is not None:
            selected_daily_net_pnl_unlock = (
                selected_daily_net_pnl_unlock or Decimal("0")
            ) + value
    accepted_routeable_count = _int(
        routeability_repair_acceptance_ledger.get("accepted_routeable_candidate_count")
    )
    all_dimensions_current = not active_lots
    proof_floor_ready = _text(
        proof_floor_receipt.get("route_state")
    ) != "repair_only" and _text(proof_floor_receipt.get("capital_state")) not in {
        "zero_notional",
        "",
    }
    live_gate_allows = _bool(live_submission_gate.get("allowed"))
    paper_replay_candidate_count = (
        accepted_routeable_count
        if all_dimensions_current and proof_floor_ready and live_gate_allows
        else 0
    )
    frontier_state = "ready" if all_dimensions_current else "repair_only"
    if any(
        _text(dimension.get("dimension")) == "jangar_settlement"
        for dimension in dimensions
        if _text(dimension.get("state")) != "current"
    ):
        frontier_state = "held"
    frontier_id = _stable_ref(
        "profit-freshness-frontier",
        {
            "account": account,
            "trading_mode": trading_mode,
            "proof_window": proof_window,
            "torghut_revision": torghut_revision,
            "routeability_ledger": routeability_repair_acceptance_ledger.get(
                "ledger_id"
            ),
            "dimension_states": {
                _text(dimension.get("dimension")): _text(dimension.get("state"))
                for dimension in dimensions
            },
            "selected_repairs": [
                _text(repair.get("lot_id")) for repair in selected_repairs
            ],
        },
    )
    return {
        "schema_version": PROFIT_FRESHNESS_FRONTIER_SCHEMA_VERSION,
        "frontier_id": frontier_id,
        "account_label": account,
        "trading_mode": trading_mode,
        "proof_window": proof_window,
        "torghut_revision": torghut_revision,
        "jangar_reliability_settlement_ref": dict(jangar_reliability_settlement_ref),
        "generated_at": generated_at,
        "fresh_until": (
            observed_at + timedelta(seconds=_FRESHNESS_SECONDS)
        ).isoformat(),
        "freshness_dimensions": dimensions,
        "repair_lots": active_lots,
        "selected_zero_notional_repairs": selected_repairs,
        "frontier_state": frontier_state,
        "aggregate_blocking_reason_codes": aggregate_blockers,
        "capital_posture": {
            "capital_state": "zero_notional",
            "paper_notional_limit": "0",
            "live_notional_limit": "0",
            "paper_replay_candidate_count": paper_replay_candidate_count,
            "capital_behavior_changed": False,
            "graduation_rule": (
                "paper replay requires current freshness dimensions, accepted routeability, "
                "live gate allowance, and existing capital gates"
            ),
        },
        "next_zero_notional_action": _text(
            selected_repairs[0].get("zero_notional_action")
            if selected_repairs
            else None,
            "observe_profit_freshness_frontier",
        ),
        "summary": {
            "dimension_count": len(dimensions),
            "current_dimension_count": sum(
                1
                for dimension in dimensions
                if _text(dimension.get("state")) == "current"
            ),
            "active_repair_lot_count": len(active_lots),
            "selected_repair_count": len(selected_repairs),
            "accepted_routeable_candidate_count": accepted_routeable_count,
            "ranked_daily_net_pnl_repair_count": sum(
                1
                for repair in active_lots
                if repair.get("expected_daily_net_pnl_unlock") is not None
            ),
            "selected_expected_daily_net_pnl_unlock": _decimal_text(
                selected_daily_net_pnl_unlock
            ),
            "quality_frontier_packet_count": len(
                _sequence(quality_adjusted_profit_frontier.get("packets"))
            ),
        },
        "rollback_target": {
            "capital_state": "zero_notional",
            "profit_freshness_frontier_projection_enabled": False,
            "zero_notional_repair_execution_enabled": False,
            "live_submit_enabled": False,
        },
    }


__all__ = [
    "PROFIT_FRESHNESS_FRONTIER_SCHEMA_VERSION",
    "build_profit_freshness_frontier",
]
