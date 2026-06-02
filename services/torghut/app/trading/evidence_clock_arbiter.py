"""Evidence-clock arbiter and routeable candidate exchange projections."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from hashlib import sha256
import json
from typing import Any, cast


EVIDENCE_CLOCK_ARBITER_SCHEMA_VERSION = "torghut.evidence-clock-arbiter.v1"
ROUTEABLE_PROFIT_CANDIDATE_EXCHANGE_SCHEMA_VERSION = (
    "torghut.routeable-profit-candidate-exchange.v1"
)

_FRESHNESS_SECONDS = 60
_DEFAULT_MAX_CLOCK_AGE_SECONDS = 6 * 60 * 60
_DEFAULT_TCA_AVG_ABS_SLIPPAGE_GUARDRAIL_BPS = Decimal("8")
_CURRENT_STATES = {
    "allow",
    "allowed",
    "current",
    "fresh",
    "healthy",
    "ok",
    "pass",
    "ready",
    "routeable",
}
_BAD_STATES = {
    "blocked",
    "degraded",
    "down",
    "error",
    "fail",
    "failed",
    "missing",
    "stale",
}
_PAPER_ACTION_STATES = {
    "allow",
    "allowed",
    "approved",
    "paper",
    "paper_canary",
    "paper_candidate",
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


def _int(value: object, default: int = 0) -> int:
    parsed = _decimal(value)
    return default if parsed is None else int(parsed)


def _positive_decimal(value: object) -> Decimal | None:
    parsed = _decimal(value)
    if parsed is None or parsed <= 0:
        return None
    return parsed


def _bool(value: object, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"1", "true", "yes", "on", "ok", "healthy", "ready"}:
            return True
        if normalized in {"0", "false", "no", "off", "degraded", "missing"}:
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


def _first_value(source: Mapping[str, Any], *keys: str) -> object:
    for key in keys:
        if key in source and source[key] is not None:
            return source[key]
    return None


def _first_text(source: Mapping[str, Any], *keys: str, default: str = "") -> str:
    for key in keys:
        if text := _text(source.get(key)):
            return text
    return default


def _parse_timestamp(value: object) -> datetime | None:
    if isinstance(value, datetime):
        return (
            value.astimezone(timezone.utc)
            if value.tzinfo
            else value.replace(tzinfo=timezone.utc)
        )
    text = _text(value)
    if not text:
        return None
    if text.endswith("Z"):
        text = f"{text[:-1]}+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    return (
        parsed.astimezone(timezone.utc)
        if parsed.tzinfo
        else parsed.replace(tzinfo=timezone.utc)
    )


def _iso(value: datetime | None) -> str | None:
    return None if value is None else value.astimezone(timezone.utc).isoformat()


def _age_seconds(as_of: datetime | None, now: datetime) -> int | None:
    if as_of is None:
        return None
    return max(0, int((now - as_of).total_seconds()))


def _stable_ref(prefix: str, payload: Mapping[str, object]) -> str:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return f"{prefix}:{sha256(encoded.encode()).hexdigest()[:20]}"


def _clock(
    *,
    name: str,
    state: str,
    affected_value_gates: Sequence[str],
    reason_codes: Sequence[str] = (),
    as_of: datetime | None = None,
    max_age_seconds: int | None = None,
    source_ref: object = None,
    details: Mapping[str, object] | None = None,
) -> dict[str, object]:
    return {
        "name": name,
        "state": state,
        "as_of": _iso(as_of),
        "max_age_seconds": max_age_seconds,
        "source_ref": source_ref,
        "affected_value_gates": _unique(list(affected_value_gates)),
        "reason_codes": _unique(list(reason_codes)),
        "details": dict(details or {}),
    }


def _is_current(clock: Mapping[str, Any]) -> bool:
    return _text(clock.get("state")).lower() == "current"


def _timestamp_from(source: Mapping[str, Any], *keys: str) -> datetime | None:
    return _parse_timestamp(_first_value(source, *keys))


def _state_from_status(source: Mapping[str, Any]) -> str:
    return _first_text(
        source, "state", "status", "overall_state", "overallState", default="unknown"
    ).lower()


def _clickhouse_ta_clock(
    clickhouse_ta_status: Mapping[str, Any],
    *,
    now: datetime,
    max_age_seconds: int,
) -> dict[str, object]:
    if not clickhouse_ta_status:
        return _clock(
            name="clickhouse_ta",
            state="missing",
            affected_value_gates=["zero_notional_or_stale_evidence_rate"],
            reason_codes=["clickhouse_ta_clock_missing"],
            max_age_seconds=max_age_seconds,
        )
    as_of = _timestamp_from(
        clickhouse_ta_status,
        "as_of",
        "updated_at",
        "latest_signal_at",
        "latestSignalAt",
    )
    reasons = [
        *_strings(clickhouse_ta_status.get("reason_codes")),
        *_strings(clickhouse_ta_status.get("blocking_reasons")),
    ]
    status = _state_from_status(clickhouse_ta_status)
    if status in _BAD_STATES:
        reasons.append(f"clickhouse_ta_{status}")
    age = _age_seconds(as_of, now)
    if as_of is None:
        reasons.append("clickhouse_ta_timestamp_missing")
    elif age is not None and age > max_age_seconds:
        reasons.append("clickhouse_ta_stale")
    return _clock(
        name="clickhouse_ta",
        state="current" if not reasons else "stale",
        affected_value_gates=["zero_notional_or_stale_evidence_rate"],
        reason_codes=reasons,
        as_of=as_of,
        max_age_seconds=max_age_seconds,
        source_ref=clickhouse_ta_status.get("source_ref")
        or clickhouse_ta_status.get("receipt_id"),
        details={
            "age_seconds": age,
            "symbol_count": clickhouse_ta_status.get("symbol_count"),
        },
    )


def _quant_clock(quant_evidence: Mapping[str, Any]) -> dict[str, object]:
    if not quant_evidence:
        return _clock(
            name="torghut_quant",
            state="missing",
            affected_value_gates=[
                "zero_notional_or_stale_evidence_rate",
                "routeable_candidate_count",
            ],
            reason_codes=["torghut_quant_evidence_missing"],
        )
    reasons = [
        *_strings(quant_evidence.get("blocking_reasons")),
        *_strings(quant_evidence.get("informational_reasons")),
        *_strings(quant_evidence.get("non_promoting_receipts")),
    ]
    status = _state_from_status(quant_evidence)
    if quant_evidence.get("ok") is False:
        reasons.append(_text(quant_evidence.get("reason"), "torghut_quant_degraded"))
    if status in _BAD_STATES:
        reasons.append(f"torghut_quant_{status}")
    latest_count = _int(
        _first_value(quant_evidence, "latest_metrics_count", "latestMetricsCount"),
        default=-1,
    )
    stage_count = _int(
        _first_value(quant_evidence, "stage_count", "stageCount"), default=-1
    )
    if latest_count == 0:
        reasons.append("torghut_quant_latest_metrics_empty")
    elif latest_count < 0 and quant_evidence.get("ok") is not True:
        reasons.append("torghut_quant_latest_metrics_missing")
    if stage_count == 0 or _bool(
        quant_evidence.get("missing_pipeline_health_stages")
        or quant_evidence.get("missingPipelineHealthStages")
    ):
        reasons.append("torghut_quant_scoped_stages_missing")
    for key, reason in (
        ("ingestion_ok", "torghut_quant_ingestion_degraded"),
        ("materialization_ok", "torghut_quant_materialization_degraded"),
        ("compute_ok", "torghut_quant_compute_degraded"),
    ):
        if quant_evidence.get(key) is False:
            reasons.append(reason)
    as_of = _timestamp_from(
        quant_evidence,
        "latest_metrics_updated_at",
        "latestMetricsUpdatedAt",
        "updated_at",
    )
    state = "current"
    if reasons:
        state = "split" if latest_count > 0 else "stale"
    return _clock(
        name="torghut_quant",
        state=state,
        affected_value_gates=[
            "zero_notional_or_stale_evidence_rate",
            "routeable_candidate_count",
        ],
        reason_codes=reasons,
        as_of=as_of,
        source_ref=quant_evidence.get("receipt_id") or quant_evidence.get("source_url"),
        details={
            "latest_metrics_count": latest_count if latest_count >= 0 else None,
            "stage_count": stage_count,
        },
    )


def _tca_clock(
    tca_summary: Mapping[str, Any],
    *,
    now: datetime,
    max_age_seconds: int,
) -> dict[str, object]:
    if not tca_summary:
        return _clock(
            name="postgres_tca",
            state="missing",
            affected_value_gates=[
                "fill_tca_or_slippage_quality",
                "routeable_candidate_count",
            ],
            reason_codes=["execution_tca_summary_missing"],
            max_age_seconds=max_age_seconds,
        )
    reasons: list[str] = []
    order_count = _int(tca_summary.get("order_count"))
    filled_count = _int(tca_summary.get("filled_execution_count"))
    last_computed_at = _timestamp_from(tca_summary, "last_computed_at", "computed_at")
    latest_execution_at = _timestamp_from(tca_summary, "latest_execution_created_at")
    if order_count <= 0:
        reasons.append("execution_tca_missing")
    computed_age = _age_seconds(last_computed_at, now)
    execution_age = _age_seconds(latest_execution_at, now)
    if last_computed_at is None:
        reasons.append("execution_tca_computed_at_missing")
    elif computed_age is not None and computed_age > max_age_seconds:
        reasons.append("execution_tca_stale")
    if latest_execution_at is None or filled_count <= 0:
        reasons.append("active_session_execution_samples_missing")
    elif execution_age is not None and execution_age > max_age_seconds:
        reasons.append("active_session_execution_samples_stale")
    expected_shortfall_count = _int(
        tca_summary.get("expected_shortfall_sample_count")
        or tca_summary.get("expected_shortfall_count"),
        default=0,
    )
    if expected_shortfall_count <= 0:
        reasons.append("execution_tca_expected_shortfall_samples_missing_non_promoting")
    avg_abs_slippage_bps = _decimal(tca_summary.get("avg_abs_slippage_bps"))
    slippage_guardrail_bps = (
        _positive_decimal(
            _first_value(
                tca_summary,
                "slippage_guardrail_bps",
                "route_slippage_guardrail_bps",
                "max_avg_abs_slippage_bps",
                "avg_abs_slippage_guardrail_bps",
            )
        )
        or _DEFAULT_TCA_AVG_ABS_SLIPPAGE_GUARDRAIL_BPS
    )
    if avg_abs_slippage_bps is None:
        reasons.append("execution_tca_slippage_quality_missing")
    elif avg_abs_slippage_bps > slippage_guardrail_bps:
        reasons.append("execution_tca_slippage_guardrail_exceeded")
    missing_symbols = _strings(tca_summary.get("missing_symbols"))
    if missing_symbols:
        reasons.append("execution_tca_symbol_coverage_missing")
    return _clock(
        name="postgres_tca",
        state="current" if not reasons else "stale",
        affected_value_gates=[
            "fill_tca_or_slippage_quality",
            "routeable_candidate_count",
        ],
        reason_codes=reasons,
        as_of=last_computed_at,
        max_age_seconds=max_age_seconds,
        source_ref=tca_summary.get("receipt_id") or "execution_tca_metrics",
        details={
            "order_count": order_count,
            "filled_execution_count": filled_count,
            "latest_execution_created_at": _iso(latest_execution_at),
            "computed_age_seconds": computed_age,
            "execution_age_seconds": execution_age,
            "avg_abs_slippage_bps": str(avg_abs_slippage_bps)
            if avg_abs_slippage_bps is not None
            else None,
            "slippage_guardrail_bps": str(slippage_guardrail_bps),
            "expected_shortfall_sample_count": expected_shortfall_count,
            "missing_symbols": missing_symbols,
        },
    )


def _empirical_clock(empirical_jobs_status: Mapping[str, Any]) -> dict[str, object]:
    if not empirical_jobs_status:
        return _clock(
            name="empirical_replay",
            state="missing",
            affected_value_gates=[
                "zero_notional_or_stale_evidence_rate",
                "routeable_candidate_count",
            ],
            reason_codes=["empirical_jobs_status_missing"],
        )
    reasons = [
        *_strings(empirical_jobs_status.get("blocking_reasons")),
        *_strings(empirical_jobs_status.get("reason_codes")),
        *_strings(empirical_jobs_status.get("stale_jobs")),
    ]
    status = _state_from_status(empirical_jobs_status)
    ready = _bool(empirical_jobs_status.get("ready"))
    if not ready:
        reasons.append(
            _text(empirical_jobs_status.get("reason"), "empirical_jobs_not_ready")
        )
    if status in _BAD_STATES:
        reasons.append(f"empirical_jobs_{status}")
    return _clock(
        name="empirical_replay",
        state="current" if not reasons else "stale",
        affected_value_gates=[
            "zero_notional_or_stale_evidence_rate",
            "routeable_candidate_count",
        ],
        reason_codes=reasons,
        as_of=_timestamp_from(
            empirical_jobs_status,
            "updated_at",
            "newest_updated_at",
            "last_completed_at",
        ),
        source_ref=empirical_jobs_status.get("authority")
        or empirical_jobs_status.get("receipt_id"),
        details={"status": status, "ready": ready},
    )


def _hypothesis_items(hypothesis_payload: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    return [
        _mapping(raw_item)
        for raw_item in _sequence(hypothesis_payload.get("items"))
        if _mapping(raw_item)
    ]


def _hypothesis_clock(hypothesis_payload: Mapping[str, Any]) -> dict[str, object]:
    items = _hypothesis_items(hypothesis_payload)
    if not items:
        return _clock(
            name="hypothesis_lineage",
            state="missing",
            affected_value_gates=["routeable_candidate_count"],
            reason_codes=["hypothesis_registry_empty"],
        )
    reasons: list[str] = []
    eligible_count = 0
    for item in items:
        candidate_id = _first_text(item, "candidate_id", "candidateId")
        strategy_id = _first_text(item, "strategy_id", "strategyId")
        if not candidate_id:
            reasons.append("hypothesis_candidate_id_missing")
        if not strategy_id:
            reasons.append("hypothesis_strategy_id_missing")
        if item.get("promotion_eligible") is True:
            eligible_count += 1
        else:
            reasons.append("hypothesis_not_promotion_eligible")
        reasons.extend(_strings(item.get("reasons")))
    summary = _mapping(hypothesis_payload.get("summary"))
    promotion_eligible_total = _int(
        summary.get("promotion_eligible_total"), default=eligible_count
    )
    if promotion_eligible_total <= 0:
        reasons.append("alpha_readiness_not_promotion_eligible")
    return _clock(
        name="hypothesis_lineage",
        state="current" if not reasons else "stale",
        affected_value_gates=["routeable_candidate_count"],
        reason_codes=reasons,
        source_ref=hypothesis_payload.get("registry_path"),
        details={
            "hypothesis_count": len(items),
            "promotion_eligible_total": promotion_eligible_total,
        },
    )


def _rollout_clock(
    rollout_status: Mapping[str, Any], build: Mapping[str, Any]
) -> dict[str, object]:
    image_digest = _first_text(build, "image_digest", "imageDigest")
    active_revision = _first_text(build, "active_revision", "commit")
    if not rollout_status and not image_digest:
        return _clock(
            name="rollout",
            state="missing",
            affected_value_gates=[
                "capital_gate_safety",
                "zero_notional_or_stale_evidence_rate",
            ],
            reason_codes=["rollout_image_proof_missing"],
            source_ref=active_revision or None,
        )
    reasons = [
        *_strings(rollout_status.get("blocking_reasons")),
        *_strings(rollout_status.get("reason_codes")),
        *_strings(rollout_status.get("image_pull_failures")),
    ]
    status = _state_from_status(rollout_status)
    if status in _BAD_STATES:
        reasons.append(f"rollout_{status}")
    if not image_digest:
        reasons.append("rollout_image_digest_missing")
    if rollout_status and rollout_status.get("route_workloads_ok") is False:
        reasons.append("route_adjacent_workloads_degraded")
    elif image_digest and "route_workloads_ok" not in rollout_status:
        reasons.append("route_adjacent_workload_proof_missing")
    return _clock(
        name="rollout",
        state="current" if not reasons else "split",
        affected_value_gates=[
            "capital_gate_safety",
            "zero_notional_or_stale_evidence_rate",
        ],
        reason_codes=reasons,
        as_of=_timestamp_from(rollout_status, "updated_at", "verified_at"),
        source_ref=image_digest or active_revision or None,
        details={
            "active_revision": active_revision or None,
            "image_digest": image_digest or None,
        },
    )


def _routeability_clock(routeability_ledger: Mapping[str, Any]) -> dict[str, object]:
    if not routeability_ledger:
        return _clock(
            name="routeability_acceptance",
            state="missing",
            affected_value_gates=[
                "routeable_candidate_count",
                "zero_notional_or_stale_evidence_rate",
            ],
            reason_codes=["routeability_acceptance_ledger_missing"],
        )
    aggregate_state = _text(
        routeability_ledger.get("aggregate_state"), "unknown"
    ).lower()
    reasons = _strings(routeability_ledger.get("aggregate_blocking_reason_codes"))
    if aggregate_state != "accepted":
        reasons.append(f"routeability_acceptance_{aggregate_state}")
    return _clock(
        name="routeability_acceptance",
        state="current" if not reasons else "stale",
        affected_value_gates=[
            "routeable_candidate_count",
            "zero_notional_or_stale_evidence_rate",
        ],
        reason_codes=reasons,
        as_of=_timestamp_from(routeability_ledger, "generated_at"),
        source_ref=routeability_ledger.get("ledger_id"),
        details={
            "aggregate_state": aggregate_state,
            "accepted_routeable_candidate_count": routeability_ledger.get(
                "accepted_routeable_candidate_count"
            ),
        },
    )


def _profit_signal_clock(profit_signal_quorum: Mapping[str, Any]) -> dict[str, object]:
    if not profit_signal_quorum:
        return _clock(
            name="profit_signal_quorum",
            state="missing",
            affected_value_gates=[
                "routeable_candidate_count",
                "post_cost_daily_net_pnl",
            ],
            reason_codes=["profit_signal_quorum_missing"],
        )
    decision = _text(profit_signal_quorum.get("aggregate_decision"), "unknown").lower()
    reasons = _strings(profit_signal_quorum.get("aggregate_reason_codes"))
    if decision not in {"paper_candidate", "paper_canary"}:
        reasons.append(f"profit_signal_quorum_{decision}")
    return _clock(
        name="profit_signal_quorum",
        state="current" if not reasons else "stale",
        affected_value_gates=["routeable_candidate_count", "post_cost_daily_net_pnl"],
        reason_codes=reasons,
        as_of=_timestamp_from(profit_signal_quorum, "generated_at"),
        source_ref=profit_signal_quorum.get("quorum_set_id"),
        details={"aggregate_decision": decision},
    )


def _capital_clock(
    proof_floor_receipt: Mapping[str, Any],
    live_submission_gate: Mapping[str, Any],
    torghut_custody_ref: Mapping[str, Any],
) -> dict[str, object]:
    reasons: list[str] = []
    route_state = _text(proof_floor_receipt.get("route_state"), "unknown").lower()
    capital_state = _text(proof_floor_receipt.get("capital_state"), "unknown").lower()
    max_notional = _text(proof_floor_receipt.get("max_notional"), "0")
    if route_state in {"repair_only", "unknown"}:
        reasons.append(f"proof_floor_{route_state}")
    if capital_state in {"zero_notional", "unknown"}:
        reasons.append(f"capital_state_{capital_state}")
    if max_notional in {"0", "0.0", "0.00"}:
        reasons.append("max_notional_zero")
    if not _bool(live_submission_gate.get("allowed")):
        reasons.append(
            _text(live_submission_gate.get("reason"), "live_submission_gate_closed")
        )
    custody_decision = _text(
        torghut_custody_ref.get("decision")
        or torghut_custody_ref.get("state")
        or torghut_custody_ref.get("status"),
        "missing",
    ).lower()
    if custody_decision not in _PAPER_ACTION_STATES:
        reasons.append(f"torghut_custody_{custody_decision}")
    return _clock(
        name="capital_gate",
        state="current" if not reasons else "blocked",
        affected_value_gates=["capital_gate_safety"],
        reason_codes=[*reasons, *_strings(live_submission_gate.get("blocked_reasons"))],
        as_of=_timestamp_from(proof_floor_receipt, "generated_at"),
        source_ref=proof_floor_receipt.get("schema_version"),
        details={
            "route_state": route_state,
            "capital_state": capital_state,
            "max_notional": max_notional,
            "live_submission_allowed": _bool(live_submission_gate.get("allowed")),
            "torghut_custody_decision": custody_decision,
        },
    )


def _clock_splits(clocks: Sequence[Mapping[str, Any]]) -> list[dict[str, object]]:
    return [
        {
            "clock": _text(clock.get("name")),
            "state": _text(clock.get("state")),
            "affected_value_gates": list(_sequence(clock.get("affected_value_gates"))),
            "reason_codes": list(_sequence(clock.get("reason_codes"))),
            "next_repair_class": _repair_class_for_clock(_text(clock.get("name"))),
        }
        for clock in clocks
        if not _is_current(clock)
    ]


def _capital_decision(
    *,
    all_clocks_current: bool,
    proof_floor_receipt: Mapping[str, Any],
    live_submission_gate: Mapping[str, Any],
) -> str:
    route_state = _text(proof_floor_receipt.get("route_state"), "unknown").lower()
    capital_state = _text(proof_floor_receipt.get("capital_state"), "unknown").lower()
    if (
        all_clocks_current
        and _bool(live_submission_gate.get("allowed"))
        and route_state != "repair_only"
    ):
        return "paper_candidate"
    if route_state == "repair_only" or capital_state == "zero_notional":
        return "repair_only"
    if not _bool(live_submission_gate.get("allowed")):
        return "hold"
    return "repair_only"


def _repair_class_for_clock(clock_name: str) -> str:
    return {
        "clickhouse_ta": "market_data_clock_refresh",
        "torghut_quant": "quant_ingestion_repair",
        "postgres_tca": "execution_tca_refresh",
        "empirical_replay": "empirical_job_refresh",
        "hypothesis_lineage": "promotion_candidate_generation",
        "rollout": "image_digest_reconcile",
        "routeability_acceptance": "routeability_receipt_settlement",
        "profit_signal_quorum": "profit_signal_quorum_repair",
        "capital_gate": "capital_gate_hold",
    }.get(clock_name, "evidence_clock_refresh")


def _target_gate_for_clock(clock_name: str) -> str:
    return {
        "postgres_tca": "fill_tca_or_slippage_quality",
        "hypothesis_lineage": "routeable_candidate_count",
        "routeability_acceptance": "routeable_candidate_count",
        "profit_signal_quorum": "routeable_candidate_count",
        "capital_gate": "capital_gate_safety",
        "rollout": "capital_gate_safety",
    }.get(clock_name, "zero_notional_or_stale_evidence_rate")


def _hypothesis_id(item: Mapping[str, Any]) -> str:
    return _first_text(item, "hypothesis_id", "hypothesisId", "id", default="unknown")


def _routeable_candidates(
    *,
    profit_signal_quorum: Mapping[str, Any],
    all_clocks_current: bool,
    routeable_candidate_count: int,
) -> list[dict[str, object]]:
    if not all_clocks_current or routeable_candidate_count <= 0:
        return []
    candidates: list[dict[str, object]] = []
    for raw_quorum in _sequence(profit_signal_quorum.get("quorums")):
        quorum = _mapping(raw_quorum)
        decision = _text(quorum.get("decision")).lower()
        if decision not in {"paper_candidate", "paper_canary"}:
            continue
        candidates.append(
            {
                "candidate_id": quorum.get("candidate_id"),
                "hypothesis_id": quorum.get("hypothesis_id"),
                "strategy_id": quorum.get("strategy_id"),
                "decision": "routeable",
                "max_notional": "0",
                "source_quorum_id": quorum.get("quorum_id"),
                "reason_codes": [],
            }
        )
    if not candidates:
        candidates.append(
            {
                "candidate_id": "aggregate-routeable-candidate",
                "hypothesis_id": "aggregate",
                "strategy_id": None,
                "decision": "routeable",
                "max_notional": "0",
                "source_quorum_id": profit_signal_quorum.get("quorum_set_id"),
                "reason_codes": [],
            }
        )
    return candidates[:routeable_candidate_count]


def _repair_lots(clocks: Sequence[Mapping[str, Any]]) -> list[dict[str, object]]:
    lots: list[dict[str, object]] = []
    for clock in clocks:
        if _is_current(clock):
            continue
        clock_name = _text(clock.get("name"), "unknown")
        target_gate = _target_gate_for_clock(clock_name)
        repair_class = _repair_class_for_clock(clock_name)
        lot_payload = {
            "clock": clock_name,
            "target_value_gate": target_gate,
            "repair_class": repair_class,
            "reason_codes": list(_sequence(clock.get("reason_codes"))),
        }
        lots.append(
            {
                "lot_id": _stable_ref("evidence-clock-repair-lot", lot_payload),
                "clock": clock_name,
                "target_value_gate": target_gate,
                "repair_class": repair_class,
                "expected_value_gate_delta": f"retire_{clock_name}_clock_debt",
                "required_input_receipts": [
                    clock.get("source_ref") or f"{clock_name}_receipt"
                ],
                "required_output_receipts": [f"{clock_name}_clock_current_receipt"],
                "max_notional": "0",
                "stop_conditions": [
                    "paper_or_live_notional_requested",
                    "clock_debt_not_retired",
                ],
                "reason_codes": list(_sequence(clock.get("reason_codes"))),
                "rollback_target": "keep_zero_notional_and_existing_proof_floor",
            }
        )
    return lots


def _rejected_candidates(
    hypothesis_payload: Mapping[str, Any],
    clocks: Sequence[Mapping[str, Any]],
) -> list[dict[str, object]]:
    noncurrent_reasons = _unique(
        [
            _text(reason)
            for clock in clocks
            if not _is_current(clock)
            for reason in _sequence(clock.get("reason_codes"))
        ]
    )
    items = _hypothesis_items(hypothesis_payload)
    if not items:
        return [
            {
                "candidate_id": None,
                "hypothesis_id": None,
                "reason_codes": ["hypothesis_registry_empty", *noncurrent_reasons],
                "max_notional": "0",
            }
        ]
    return [
        {
            "candidate_id": _first_text(item, "candidate_id", "candidateId") or None,
            "hypothesis_id": _hypothesis_id(item),
            "strategy_id": _first_text(item, "strategy_id", "strategyId") or None,
            "reason_codes": _unique(
                [*_strings(item.get("reasons")), *noncurrent_reasons]
            ),
            "max_notional": "0",
        }
        for item in items
        if item.get("promotion_eligible") is not True or noncurrent_reasons
    ]


def build_evidence_clock_arbiter_and_exchange(
    *,
    account_label: str,
    window: str,
    trading_mode: str,
    torghut_revision: str | None,
    build: Mapping[str, Any],
    hypothesis_payload: Mapping[str, Any],
    quant_evidence: Mapping[str, Any],
    market_context_status: Mapping[str, Any],
    tca_summary: Mapping[str, Any],
    empirical_jobs_status: Mapping[str, Any],
    proof_floor_receipt: Mapping[str, Any],
    routeability_repair_acceptance_ledger: Mapping[str, Any],
    profit_signal_quorum: Mapping[str, Any],
    live_submission_gate: Mapping[str, Any],
    torghut_custody_ref: Mapping[str, Any],
    clickhouse_ta_status: Mapping[str, Any] | None = None,
    rollout_status: Mapping[str, Any] | None = None,
    now: datetime | None = None,
    max_clock_age_seconds: int = _DEFAULT_MAX_CLOCK_AGE_SECONDS,
) -> tuple[dict[str, object], dict[str, object]]:
    """Build shadow-only clock and candidate projections from existing payloads."""

    observed_at = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    _ = market_context_status
    clocks = [
        _clickhouse_ta_clock(
            _mapping(clickhouse_ta_status),
            now=observed_at,
            max_age_seconds=max_clock_age_seconds,
        ),
        _quant_clock(quant_evidence),
        _tca_clock(tca_summary, now=observed_at, max_age_seconds=max_clock_age_seconds),
        _empirical_clock(empirical_jobs_status),
        _hypothesis_clock(hypothesis_payload),
        _rollout_clock(_mapping(rollout_status), build),
        _routeability_clock(routeability_repair_acceptance_ledger),
        _profit_signal_clock(profit_signal_quorum),
        _capital_clock(proof_floor_receipt, live_submission_gate, torghut_custody_ref),
    ]
    all_clocks_current = all(_is_current(clock) for clock in clocks)
    ledger_routeable_count = _int(
        routeability_repair_acceptance_ledger.get("accepted_routeable_candidate_count")
    )
    candidate_count = ledger_routeable_count if all_clocks_current else 0
    noncurrent_count = sum(1 for clock in clocks if not _is_current(clock))
    denominator = max(1, len(clocks))
    decision = _capital_decision(
        all_clocks_current=all_clocks_current,
        proof_floor_receipt=proof_floor_receipt,
        live_submission_gate=live_submission_gate,
    )
    generated_at = observed_at.isoformat()
    arbiter_id = _stable_ref(
        "evidence-clock-arbiter",
        {
            "account_label": account_label,
            "window": window,
            "trading_mode": trading_mode,
            "torghut_revision": torghut_revision,
            "clock_states": {
                str(clock["name"]): str(clock["state"]) for clock in clocks
            },
            "candidate_count": candidate_count,
        },
    )
    repair_lots = _repair_lots(clocks)
    routeable_candidates = _routeable_candidates(
        profit_signal_quorum=profit_signal_quorum,
        all_clocks_current=all_clocks_current,
        routeable_candidate_count=candidate_count,
    )
    exchange_id = _stable_ref(
        "routeable-profit-candidate-exchange",
        {
            "arbiter_id": arbiter_id,
            "candidate_count": len(routeable_candidates),
            "repair_lot_count": len(repair_lots),
        },
    )
    stale_rate = round(noncurrent_count / denominator, 4)
    arbiter: dict[str, object] = {
        "schema_version": EVIDENCE_CLOCK_ARBITER_SCHEMA_VERSION,
        "arbiter_id": arbiter_id,
        "generated_at": generated_at,
        "fresh_until": (
            observed_at + timedelta(seconds=_FRESHNESS_SECONDS)
        ).isoformat(),
        "account": account_label,
        "window": window,
        "trading_mode": trading_mode,
        "active_revision": torghut_revision,
        "clocks": clocks,
        "clock_splits": _clock_splits(clocks),
        "routeable_candidate_count": candidate_count,
        "stale_or_zero_notional_evidence_rate": stale_rate,
        "zero_notional_or_stale_evidence_rate": stale_rate,
        "capital_decision": decision,
        "max_notional": "0",
        "required_torghut_custody_ref": dict(torghut_custody_ref),
        "selected_repair_lot_ids": [lot["lot_id"] for lot in repair_lots],
        "summary": {
            "clock_count": len(clocks),
            "current_clock_count": len(clocks) - noncurrent_count,
            "noncurrent_clock_count": noncurrent_count,
            "routeable_candidate_count": candidate_count,
            "zero_notional_repair_lot_count": len(repair_lots),
            "value_gates": [
                "post_cost_daily_net_pnl",
                "routeable_candidate_count",
                "zero_notional_or_stale_evidence_rate",
                "fill_tca_or_slippage_quality",
                "capital_gate_safety",
            ],
        },
        "rollback_target": {
            "capital_state": "zero_notional",
            "live_submit_enabled": False,
            "evidence_clock_arbiter_consumption_enabled": False,
        },
    }
    exchange: dict[str, object] = {
        "schema_version": ROUTEABLE_PROFIT_CANDIDATE_EXCHANGE_SCHEMA_VERSION,
        "exchange_id": exchange_id,
        "generated_at": generated_at,
        "account": account_label,
        "window": window,
        "routeable_candidates": routeable_candidates,
        "zero_notional_repair_lots": repair_lots,
        "rejected_candidates": _rejected_candidates(hypothesis_payload, clocks),
        "capital_safety_ref": {
            "proof_floor_ref": proof_floor_receipt.get("schema_version"),
            "proof_floor_route_state": proof_floor_receipt.get("route_state"),
            "proof_floor_capital_state": proof_floor_receipt.get("capital_state"),
            "live_submission_allowed": _bool(live_submission_gate.get("allowed")),
            "max_notional": "0",
            "capital_decision": decision,
        },
        "summary": {
            "routeable_candidate_count": len(routeable_candidates),
            "zero_notional_repair_lot_count": len(repair_lots),
            "rejected_candidate_count": len(
                _rejected_candidates(hypothesis_payload, clocks)
            ),
        },
    }
    return arbiter, exchange


__all__ = [
    "EVIDENCE_CLOCK_ARBITER_SCHEMA_VERSION",
    "ROUTEABLE_PROFIT_CANDIDATE_EXCHANGE_SCHEMA_VERSION",
    "build_evidence_clock_arbiter_and_exchange",
]
