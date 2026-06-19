"""Profit freshness frontier projection for zero-notional repair selection."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from hashlib import sha256
import json
from typing import Any, cast

from ..market_context_domains import (
    active_market_context_mapping,
    active_market_context_reasons,
)
from ..market_context import market_context_status_enforced


PROFIT_FRESHNESS_FRONTIER_SCHEMA_VERSION = "torghut.profit-freshness-frontier.v1"

FRESHNESS_SECONDS = 60

CURRENT_STATES = {"accepted", "allow", "current", "healthy", "ok", "pass", "ready"}

ROUTE_SETTLED_ROW_STATES = CURRENT_STATES | {"routeable"}

BAD_STATES = {"blocked", "degraded", "fail", "missing", "repair", "stale", "unknown"}

DIMENSION_EXPECTED_BPS: Mapping[str, Decimal] = {
    "empirical_proof": Decimal("24"),
    "tca_fill_quality": Decimal("22"),
    "signal_ingestion": Decimal("18"),
    "route_readiness": Decimal("17"),
    "feature_coverage": Decimal("16"),
    "drift_checks": Decimal("12"),
    "schema_migration_state": Decimal("10"),
    "jangar_settlement": Decimal("8"),
}

DIMENSION_REPAIR_COST: Mapping[str, str] = {
    "empirical_proof": "medium",
    "tca_fill_quality": "medium",
    "signal_ingestion": "medium",
    "route_readiness": "medium",
    "feature_coverage": "medium",
    "drift_checks": "low",
    "schema_migration_state": "low",
    "jangar_settlement": "low",
}

REPAIR_COST_PENALTY: Mapping[str, Decimal] = {
    "low": Decimal("2"),
    "medium": Decimal("5"),
    "high": Decimal("8"),
}

DIMENSION_ACTION: Mapping[str, str] = {
    "signal_ingestion": "refresh_scoped_quant_pipeline_stage_receipts",
    "empirical_proof": "renew_empirical_proof_jobs",
    "feature_coverage": "rebuild_required_feature_rows",
    "drift_checks": "rerun_drift_checks_for_blocked_hypotheses",
    "tca_fill_quality": "recompute_route_tca_and_fill_quality",
    "route_readiness": "settle_routeability_acceptance_lots",
    "schema_migration_state": "refresh_schema_and_migration_lineage_receipts",
    "jangar_settlement": "refresh_jangar_reliability_settlement",
}

DIMENSION_REPAIR_CLASSES: Mapping[str, tuple[str, ...]] = {
    "signal_ingestion": ("quant", "scoped_quant", "signal", "signal_ingestion"),
    "empirical_proof": ("empirical", "empirical_proof", "replay", "simulation"),
    "feature_coverage": ("feature", "feature_coverage"),
    "drift_checks": ("drift", "drift_checks"),
    "tca_fill_quality": ("fill_quality", "route_tca", "tca"),
    "route_readiness": ("route", "routeability", "route_readiness"),
    "schema_migration_state": ("migration", "schema", "schema_migration"),
    "jangar_settlement": ("jangar", "jangar_settlement", "reliability_settlement"),
}

DAILY_NET_PNL_UNLOCK_KEYS = (
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

DIMENSION_SUCCESS: Mapping[str, str] = {
    "signal_ingestion": "scoped quant metrics and stage receipts are current",
    "empirical_proof": "all required empirical jobs are fresh, truthful, and promotion eligible",
    "feature_coverage": "required feature rows are present for blocked hypotheses",
    "drift_checks": "drift checks are present for blocked hypotheses",
    "tca_fill_quality": "route TCA rows are fresh and inside fill-quality guardrails",
    "route_readiness": "routeability acceptance ledger is accepted with settled receipt refs",
    "schema_migration_state": "schema and migration lineage blockers are absent",
    "jangar_settlement": "Jangar reliability settlement allows paper canary consideration",
}

REPAIRABLE_DIMENSIONS = frozenset(DIMENSION_ACTION)

ROUTEABILITY_ONLY_TCA_REASON_CODES = {
    "execution_tca_route_universe_exclusions_applied",
    "execution_tca_symbol_missing",
    "route_tca_passed_but_dependency_receipts_block_capital",
}

ROUTEABILITY_ONLY_TCA_REASON_PREFIXES = ("capital_state_", "proof_floor_")

NONBLOCKING_JANGAR_RELIABILITY_REASONS = {
    "torghut_dependency_quorum_not_required",
}

NONBLOCKING_QUANT_HEALTH_REASONS = {
    "quant_health_not_configured",
}

ROUTEABILITY_TCA_REPAIR_LOT_TYPES = {"route_universe_tca_repair"}

ROUTEABILITY_TCA_REPAIR_ACTION = "recompute_route_tca_and_fill_quality"

ROUTEABILITY_TCA_REPAIR_REASON_PREFIXES = ("execution_tca_", "route_tca_")

ROUTEABILITY_TCA_REPAIR_REASON_FRAGMENTS = ("slippage", "route_universe")

ALPHA_FEATURE_REPLAY_REASON_CODES = {
    "feature_rows_missing",
    "required_feature_set_unavailable",
}

ALPHA_FEATURE_REPLAY_PRIORITY_BONUS = Decimal("3")

ALPHA_FEATURE_ROUTEABILITY_PRIORITY_BONUS = Decimal("3")

ALPHA_READINESS_ROUTEABILITY_REASON_CODES = {
    "alpha_readiness_fail",
    "alpha_readiness_not_promotion_eligible",
    "hypothesis_not_promotion_eligible",
}


def mapping(value: object) -> Mapping[str, Any]:
    return cast(Mapping[str, Any], value) if isinstance(value, Mapping) else {}


def sequence(value: object) -> Sequence[object]:
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return cast(Sequence[object], value)
    return ()


def text(value: object, default: str = "") -> str:
    if value is None:
        return default
    text = str(value).strip()
    return text or default


def decimal(value: object) -> Decimal | None:
    if value is None:
        return None
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None


def decimal_text(value: Decimal | None) -> str | None:
    if value is None:
        return None
    text = format(value, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    if text in {"", "-0"}:
        return "0"
    return text


def int_value(value: object, default: int = 0) -> int:
    parsed = decimal(value)
    return default if parsed is None else int(parsed)


def float_value(value: object) -> float | None:
    parsed = decimal(value)
    return None if parsed is None else float(parsed)


def bool_value(value: object, default: bool = False) -> bool:
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


def unique(values: Sequence[str]) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for value in values:
        normalized = value.strip()
        if normalized and normalized not in seen:
            result.append(normalized)
            seen.add(normalized)
    return result


def strings(value: object) -> list[str]:
    return unique([text(item) for item in sequence(value)])


def symbols(value: object) -> list[str]:
    if isinstance(value, str):
        return unique([value.upper()])
    return unique([text(item).upper() for item in sequence(value)])


def stable_ref(prefix: str, payload: Mapping[str, object]) -> str:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return f"{prefix}:{sha256(encoded.encode()).hexdigest()[:16]}"


def timestamp(value: object) -> datetime | None:
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


def state_from_reasons(
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


def hypothesis_items(hypothesis_payload: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    return [mapping(item) for item in sequence(hypothesis_payload.get("items"))]


def hypothesis_summary(hypothesis_payload: Mapping[str, Any]) -> Mapping[str, Any]:
    summary = mapping(hypothesis_payload.get("summary"))
    return summary if summary else hypothesis_payload


def hypothesis_ids_for_reasons(
    hypothesis_payload: Mapping[str, Any],
    target_reasons: Sequence[str],
) -> list[str]:
    targets = set(target_reasons)
    ids: list[str] = []
    for item in hypothesis_items(hypothesis_payload):
        reasons = set(strings(item.get("reasons")))
        if not targets or reasons.intersection(targets):
            for key in ("hypothesis_id", "id", "candidate_id", "strategy_id"):
                if value := text(item.get(key)):
                    ids.append(value)
                    break
    return unique(ids)


def reason_total(
    hypothesis_payload: Mapping[str, Any],
    reason: str,
) -> int:
    summary = hypothesis_summary(hypothesis_payload)
    totals = mapping(summary.get("reason_totals"))
    if reason in totals:
        return int_value(totals.get(reason))
    return sum(
        1
        for item in hypothesis_items(hypothesis_payload)
        if reason in strings(item.get("reasons"))
    )


def dimension(
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
    observed = timestamp(observed_at) or generated_at
    fresh = (
        text(fresh_until)
        or (
            observed + timedelta(seconds=FRESHNESS_SECONDS)
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
        "reason_codes": unique(list(reason_codes)),
        "evidence_refs": unique(list(evidence_refs)),
        "details": dict(details or {}),
    }


def proof_dimension(
    proof_floor_receipt: Mapping[str, Any],
    dimension_name: str,
) -> Mapping[str, Any]:
    for raw_dimension in sequence(proof_floor_receipt.get("proof_dimensions")):
        dimension = mapping(raw_dimension)
        if text(dimension.get("dimension")) == dimension_name:
            return dimension
    return {}


def market_domain_states(
    market_context_status: Mapping[str, Any],
) -> Mapping[str, Any]:
    for key in ("last_domain_states", "domain_states", "domains"):
        domains = mapping(market_context_status.get(key))
        if domains:
            return domains
    return mapping(mapping(market_context_status.get("health")).get("domain_states"))


def market_dimension(
    *,
    market_context_status: Mapping[str, Any],
    hypothesis_payload: Mapping[str, Any],
    generated_at: datetime,
) -> dict[str, object]:
    enforced = market_context_status_enforced(market_context_status)
    reasons = (
        active_market_context_reasons(
            [
                *strings(market_context_status.get("blocking_reasons")),
                *strings(market_context_status.get("reason_codes")),
                *strings(market_context_status.get("last_risk_flags")),
            ]
        )
        if enforced
        else []
    )
    status = (
        text(
            mapping(market_context_status.get("health")).get("status")
            or market_context_status.get("status")
            or market_context_status.get("state")
            or market_context_status.get("last_reason")
        ).lower()
        if enforced
        else ""
    )
    stale_domains: list[str] = []
    for domain_name, raw_domain in active_market_context_mapping(
        market_domain_states(market_context_status)
    ).items():
        domain = mapping(raw_domain)
        domain_state = text(domain.get("status") or domain.get("state")).lower()
        if domain_state == "stale" or domain.get("stale") is True:
            stale_domains.append(str(domain_name))
    if enforced and bool_value(market_context_status.get("alert_active")):
        reasons.extend(
            active_market_context_reasons(
                [
                    text(
                        market_context_status.get("alert_reason"),
                        "market_context_alert_active",
                    )
                ]
            )
        )
    if status and status not in CURRENT_STATES and status != "fresh":
        reasons.append(f"market_context_{status}")
    reasons.extend([f"market_context_{domain}_stale" for domain in stale_domains])
    staleness = int_value(
        market_context_status.get("last_freshness_seconds"), default=-1
    )
    stale = enforced and (
        bool(stale_domains)
        or "stale" in status
        or staleness
        > int_value(
            market_context_status.get("max_staleness_seconds"),
            default=86_400,
        )
    )
    if stale and not reasons:
        reasons.append("market_context_stale")
    return dimension(
        name="market_context",
        state=state_from_reasons(
            reasons, missing=not market_context_status, stale=stale
        ),
        generated_at=generated_at,
        reason_codes=reasons,
        evidence_refs=[
            text(market_context_status.get("last_symbol"), "market_context"),
            *unique([f"market_context:{domain}" for domain in stale_domains]),
        ],
        blocking_hypotheses=hypothesis_ids_for_reasons(
            hypothesis_payload, ["market_context_stale"]
        ),
        staleness_seconds=None if staleness < 0 else staleness,
        observed_at=market_context_status.get("last_checked_at")
        or market_context_status.get("last_as_of"),
        details={"stale_domains": unique(stale_domains)},
    )


def signal_dimension(
    *,
    quant_evidence: Mapping[str, Any],
    hypothesis_payload: Mapping[str, Any],
    generated_at: datetime,
) -> dict[str, object]:
    informational_reasons = [
        reason
        for reason in strings(quant_evidence.get("informational_reasons"))
        if reason in NONBLOCKING_QUANT_HEALTH_REASONS
    ]
    reasons = [
        *strings(quant_evidence.get("blocking_reasons")),
        *strings(quant_evidence.get("non_promoting_receipts")),
    ]
    latest_count = int_value(
        quant_evidence.get("latest_metrics_count")
        or quant_evidence.get("latestMetricsCount"),
        default=-1,
    )
    stage_count = int_value(
        quant_evidence.get("stage_count") or quant_evidence.get("stageCount"),
        default=-1,
    )
    lag_seconds = max(
        int_value(quant_evidence.get("metrics_pipeline_lag_seconds"), default=0),
        int_value(
            quant_evidence.get("max_stage_lag_seconds")
            or quant_evidence.get("maxStageLagSeconds"),
            default=0,
        ),
    )
    status = text(quant_evidence.get("status") or quant_evidence.get("state")).lower()
    quant_required = quant_evidence.get("required") is True
    quant_is_not_required = quant_evidence.get("required") is False and (
        status == "not_required"
        or not text(quant_evidence.get("source_url") or quant_evidence.get("sourceUrl"))
    )
    quant_counts_are_authoritative = quant_required or not quant_is_not_required
    if quant_counts_are_authoritative and latest_count <= 0:
        reasons.append("signal_latest_metrics_missing")
    if quant_counts_are_authoritative and stage_count <= 0:
        reasons.append("signal_pipeline_stages_missing")
    if quant_evidence.get("ok") is False:
        reasons.append(text(quant_evidence.get("reason"), "quant_health_degraded"))
    elif status and status not in CURRENT_STATES and status != "not_required":
        reasons.append(text(quant_evidence.get("reason"), f"quant_health_{status}"))
    return dimension(
        name="signal_ingestion",
        state=state_from_reasons(
            reasons,
            missing=latest_count == 0 or stage_count == 0,
            stale=lag_seconds > 0,
        ),
        generated_at=generated_at,
        reason_codes=reasons,
        evidence_refs=[text(quant_evidence.get("source_url"), "quant_health")],
        blocking_hypotheses=hypothesis_ids_for_reasons(
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


def empirical_dimension(
    *,
    empirical_jobs_status: Mapping[str, Any],
    generated_at: datetime,
) -> dict[str, object]:
    reasons = [
        *strings(empirical_jobs_status.get("blocked_reasons")),
        *[
            f"empirical_job_missing:{item}"
            for item in strings(empirical_jobs_status.get("missing_jobs"))
        ],
        *[
            f"empirical_job_stale:{item}"
            for item in strings(empirical_jobs_status.get("stale_jobs"))
        ],
        *[
            f"empirical_job_ineligible:{item}"
            for item in strings(empirical_jobs_status.get("ineligible_jobs"))
        ],
    ]
    jobs = mapping(empirical_jobs_status.get("jobs"))
    for job_name, raw_job in jobs.items():
        job = mapping(raw_job)
        reasons.extend(
            [f"{job_name}:{reason}" for reason in strings(job.get("blocked_reasons"))]
        )
    ready = bool_value(empirical_jobs_status.get("ready"))
    if not ready and not reasons:
        reasons.append(
            text(empirical_jobs_status.get("status"), "empirical_jobs_not_ready")
        )
    state = state_from_reasons(
        reasons,
        missing=bool(strings(empirical_jobs_status.get("missing_jobs")))
        or not empirical_jobs_status,
        stale=bool(strings(empirical_jobs_status.get("stale_jobs"))),
    )
    return dimension(
        name="empirical_proof",
        state="current" if ready and not reasons else state,
        generated_at=generated_at,
        reason_codes=reasons,
        evidence_refs=[
            *strings(empirical_jobs_status.get("dataset_snapshot_refs")),
            *strings(empirical_jobs_status.get("candidate_ids")),
        ]
        or ["empirical_jobs"],
        blocking_hypotheses=strings(empirical_jobs_status.get("candidate_ids")),
        observed_at=empirical_jobs_status.get("last_completed_at")
        or empirical_jobs_status.get("as_of"),
        details={
            "eligible_jobs": strings(empirical_jobs_status.get("eligible_jobs")),
            "missing_jobs": strings(empirical_jobs_status.get("missing_jobs")),
            "stale_jobs": strings(empirical_jobs_status.get("stale_jobs")),
        },
    )


def hypothesis_dimension(
    *,
    name: str,
    reason_names: Sequence[str],
    hypothesis_payload: Mapping[str, Any],
    generated_at: datetime,
) -> dict[str, object]:
    reasons: list[str] = []
    for reason_name in reason_names:
        count = reason_total(hypothesis_payload, reason_name)
        if count > 0:
            reasons.append(reason_name)
    return dimension(
        name=name,
        state=state_from_reasons(reasons, missing=bool(reasons)),
        generated_at=generated_at,
        reason_codes=reasons,
        evidence_refs=[
            f"hypothesis:{hypothesis_id}"
            for hypothesis_id in hypothesis_ids_for_reasons(
                hypothesis_payload, reason_names
            )
        ]
        or ["hypothesis_runtime_summary"],
        blocking_hypotheses=hypothesis_ids_for_reasons(
            hypothesis_payload, reason_names
        ),
        details={
            "reason_totals": {
                reason: reason_total(hypothesis_payload, reason)
                for reason in reason_names
            }
        },
    )


def route_rows(
    route_reacquisition_board: Mapping[str, Any],
) -> list[Mapping[str, Any]]:
    return [mapping(row) for row in sequence(route_reacquisition_board.get("rows"))]


def route_symbols(route_reacquisition_board: Mapping[str, Any]) -> list[str]:
    return sorted(
        {
            text(row.get("symbol")).upper()
            for row in route_rows(route_reacquisition_board)
            if text(row.get("symbol"))
        }
    )


def routeability_only_tca_reason(reason: str) -> bool:
    return reason in ROUTEABILITY_ONLY_TCA_REASON_CODES or reason.startswith(
        ROUTEABILITY_ONLY_TCA_REASON_PREFIXES
    )


__all__ = (
    "PROFIT_FRESHNESS_FRONTIER_SCHEMA_VERSION",
    "text",
)
