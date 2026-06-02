"""Freshness carry ledger for zero-notional Torghut repair proof SLOs."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from hashlib import sha256
import json
from typing import Any, cast

from .market_context_domains import active_market_context_reasons


FRESHNESS_CARRY_LEDGER_SCHEMA_VERSION = "torghut.freshness-carry-ledger.v1"

_FRESHNESS_SECONDS = 60
_ZERO_NOTIONAL = "0"
_CURRENT_STATES = {"ok", "ready", "healthy", "current", "pass", "allow", "converged"}
_NON_CURRENT_STATES = {"missing", "stale", "low_confidence", "unknown"}
_TA_MAX_LAG_SECONDS = 900
_TCA_MAX_AGE_SECONDS = 86_400
_MARKET_CONTEXT_DEFAULT_MAX_STALENESS_SECONDS = 900
_MIN_EXPECTED_SHORTFALL_COVERAGE = Decimal("0.50")

_VALUE_GATE_BY_DIMENSION = {
    "ta_signals": "zero_notional_or_stale_evidence_rate",
    "tca": "fill_tca_or_slippage_quality",
    "empirical": "post_cost_daily_net_pnl",
    "quant_evidence": "routeable_candidate_count",
    "source_serving": "capital_gate_safety",
}

_OUTPUT_RECEIPT_BY_DIMENSION = {
    "ta_signals": "torghut.ta-freshness-repair-receipt.v1",
    "tca": "torghut.execution-tca-refresh-receipt.v1",
    "empirical": "torghut.empirical-proof-refresh-receipt.v1",
    "quant_evidence": "torghut.quant-evidence-refresh-receipt.v1",
    "source_serving": "torghut.source-serving-repair-receipt-ledger.v1",
}


def _sequence(value: object) -> Sequence[object]:
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return cast(Sequence[object], value)
    return ()


def _text(value: object, default: str = "") -> str:
    if value is None:
        return default
    text = str(value).strip()
    return text or default


def _bool(value: object) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "y", "on"}
    return bool(value)


def _int(value: object, default: int = 0) -> int:
    try:
        if isinstance(value, bool):
            return int(value)
        return int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return default


def _decimal(value: object) -> Decimal | None:
    if value is None:
        return None
    if isinstance(value, Decimal):
        return value
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None


def _strings(value: object) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for item in _sequence(value):
        normalized = _text(item)
        if normalized and normalized not in seen:
            result.append(normalized)
            seen.add(normalized)
    return result


def _parse_datetime(value: object) -> datetime | None:
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        if text.endswith("Z"):
            text = f"{text[:-1]}+00:00"
        try:
            parsed = datetime.fromisoformat(text)
        except ValueError:
            return None
    else:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _iso(value: object) -> str | None:
    parsed = _parse_datetime(value)
    if parsed is None:
        return None
    return parsed.isoformat()


def _lag_seconds(now: datetime, event_at: datetime | None) -> int | None:
    if event_at is None:
        return None
    return max(0, int((now - event_at).total_seconds()))


def _stable_ref(prefix: str, payload: Mapping[str, object]) -> str:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return f"{prefix}:{sha256(encoded.encode()).hexdigest()[:20]}"


def _dimension(
    *,
    dimension_id: str,
    state: str,
    proof_authority: str,
    observed_at: object = None,
    max_event_at: object = None,
    lag_seconds: int | None = None,
    low_memory_fallback_count: int = 0,
    stale_reason_codes: Sequence[str] = (),
    source_ref: object = None,
) -> dict[str, object]:
    if state in _CURRENT_STATES:
        normalized_state = "current"
    elif state in _NON_CURRENT_STATES:
        normalized_state = state
    else:
        normalized_state = "unknown"
    reasons = [reason for reason in stale_reason_codes if reason]
    if normalized_state == "current":
        reasons = []
    if normalized_state != "current" and not reasons:
        reasons = [f"{dimension_id}_{normalized_state}"]
    return {
        "dimension_id": dimension_id,
        "state": normalized_state,
        "proof_authority": proof_authority,
        "observed_at": _iso(observed_at),
        "max_event_at": _iso(max_event_at),
        "lag_seconds": lag_seconds,
        "low_memory_fallback_count": low_memory_fallback_count,
        "stale_reason_codes": reasons,
        "required_repair_receipt": _OUTPUT_RECEIPT_BY_DIMENSION.get(dimension_id),
        "source_ref": _text(source_ref) or None,
        "max_notional": _ZERO_NOTIONAL,
    }


def _ta_signal_dimension(
    *,
    clickhouse_ta_status: Mapping[str, Any],
    now: datetime,
) -> dict[str, object]:
    latest_signal_at = _parse_datetime(clickhouse_ta_status.get("latest_signal_at"))
    lag = _lag_seconds(now, latest_signal_at)
    raw_state = _text(clickhouse_ta_status.get("state"), "unknown").lower()
    reasons = _strings(clickhouse_ta_status.get("reason_codes"))
    if latest_signal_at is None:
        state = "missing"
        reasons.append("ta_signal_timestamp_missing")
    elif raw_state not in _CURRENT_STATES:
        state = "stale" if raw_state == "stale" else "unknown"
        reasons.append(f"clickhouse_ta_{raw_state}")
    elif lag is not None and lag > _TA_MAX_LAG_SECONDS:
        state = "stale"
        reasons.append("ta_signal_lag_exceeded")
    else:
        state = "current"
    return _dimension(
        dimension_id="ta_signals",
        state=state,
        proof_authority=_text(
            clickhouse_ta_status.get("proof_authority"), "direct_sql"
        ),
        observed_at=now,
        max_event_at=latest_signal_at,
        lag_seconds=lag,
        low_memory_fallback_count=_int(
            clickhouse_ta_status.get("low_memory_fallback_count")
        ),
        stale_reason_codes=reasons,
        source_ref=clickhouse_ta_status.get("source_ref"),
    )


def _tca_dimension(
    *,
    tca_summary: Mapping[str, Any],
    now: datetime,
) -> dict[str, object]:
    last_computed_at = _parse_datetime(tca_summary.get("last_computed_at"))
    lag = _lag_seconds(now, last_computed_at)
    order_count = _int(tca_summary.get("order_count"))
    expected_coverage = _decimal(tca_summary.get("expected_shortfall_coverage"))
    reasons: list[str] = []
    if order_count <= 0:
        state = "missing"
        reasons.append("tca_orders_missing")
    elif last_computed_at is None:
        state = "missing"
        reasons.append("tca_computed_at_missing")
    elif lag is not None and lag > _TCA_MAX_AGE_SECONDS:
        state = "stale"
        reasons.append("tca_computed_at_stale")
    elif (
        expected_coverage is None
        or expected_coverage < _MIN_EXPECTED_SHORTFALL_COVERAGE
    ):
        state = "low_confidence"
        reasons.append("expected_shortfall_coverage_low")
    else:
        state = "current"
    return _dimension(
        dimension_id="tca",
        state=state,
        proof_authority="app_health",
        observed_at=now,
        max_event_at=last_computed_at or tca_summary.get("latest_execution_created_at"),
        lag_seconds=lag,
        stale_reason_codes=reasons,
        source_ref="execution_tca_metrics",
    )


def _empirical_dimension(empirical_jobs_status: Mapping[str, Any]) -> dict[str, object]:
    ready = _bool(empirical_jobs_status.get("ready"))
    status = _text(empirical_jobs_status.get("status"), "unknown").lower()
    stale_jobs = _strings(empirical_jobs_status.get("stale_jobs"))
    missing_jobs = _strings(empirical_jobs_status.get("missing_jobs"))
    ineligible_jobs = _strings(empirical_jobs_status.get("ineligible_jobs"))
    reasons = [
        *[f"empirical_job_stale:{job}" for job in stale_jobs],
        *[f"empirical_job_missing:{job}" for job in missing_jobs],
        *[f"empirical_job_ineligible:{job}" for job in ineligible_jobs],
        *_strings(empirical_jobs_status.get("blocked_reasons")),
    ]
    if ready and status in _CURRENT_STATES:
        state = "current"
    elif missing_jobs:
        state = "missing"
    elif stale_jobs:
        state = "stale"
    else:
        state = "unknown"
        if status:
            reasons.append(f"empirical_jobs_{status}")
    return _dimension(
        dimension_id="empirical",
        state=state,
        proof_authority=_text(empirical_jobs_status.get("authority"), "app_health"),
        observed_at=None,
        stale_reason_codes=reasons,
        source_ref="vnext_empirical_job_runs",
    )


def _market_context_dimension(
    *,
    market_context_status: Mapping[str, Any],
    now: datetime,
) -> dict[str, object]:
    max_staleness = _int(
        market_context_status.get("max_staleness_seconds"),
        _MARKET_CONTEXT_DEFAULT_MAX_STALENESS_SECONDS,
    )
    freshness_seconds = _int(market_context_status.get("last_freshness_seconds"), -1)
    last_checked_at = market_context_status.get(
        "last_checked_at"
    ) or market_context_status.get("last_as_of")
    reasons = active_market_context_reasons(
        [
            *_strings(market_context_status.get("last_risk_flags")),
            *_strings(market_context_status.get("reason_codes")),
            *_strings(market_context_status.get("blocking_reasons")),
        ]
    )
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
    if market_context_status.get("health_error"):
        reasons.append("market_context_health_error")
    if freshness_seconds < 0:
        state = "missing"
        reasons.append("market_context_freshness_missing")
    elif freshness_seconds > max_staleness:
        state = "stale"
        reasons.append("market_context_staleness_exceeded")
    elif reasons:
        state = "low_confidence"
    else:
        state = "current"
    return _dimension(
        dimension_id="market_context",
        state=state,
        proof_authority="app_health",
        observed_at=last_checked_at or now,
        max_event_at=last_checked_at,
        lag_seconds=freshness_seconds if freshness_seconds >= 0 else None,
        stale_reason_codes=reasons,
        source_ref=market_context_status.get("last_symbol") or "market_context",
    )


def _quant_evidence_dimension(quant_evidence: Mapping[str, Any]) -> dict[str, object]:
    ok = _bool(quant_evidence.get("ok", True))
    required = _bool(quant_evidence.get("required"))
    reason = _text(quant_evidence.get("reason"))
    if ok or not required:
        state = "current"
        reasons: list[str] = []
    else:
        state = "stale"
        reasons = [reason or "quant_evidence_not_ok"]
    return _dimension(
        dimension_id="quant_evidence",
        state=state,
        proof_authority=_text(quant_evidence.get("authority"), "app_health"),
        observed_at=quant_evidence.get("checked_at"),
        stale_reason_codes=reasons,
        source_ref=quant_evidence.get("source_ref") or quant_evidence.get("window"),
    )


def _source_serving_dimension(
    source_serving_repair_receipt_ledger: Mapping[str, Any],
) -> dict[str, object]:
    source_state = _text(
        source_serving_repair_receipt_ledger.get("source_serving_state"), "unknown"
    )
    reasons = _strings(source_serving_repair_receipt_ledger.get("reason_codes"))
    if source_state == "converged":
        state = "current"
    elif source_state in {"contract_missing", "digest_unknown", "source_ahead"}:
        state = "stale"
    else:
        state = "unknown"
    return _dimension(
        dimension_id="source_serving",
        state=state,
        proof_authority="app_health",
        observed_at=source_serving_repair_receipt_ledger.get("generated_at"),
        max_event_at=source_serving_repair_receipt_ledger.get("generated_at"),
        stale_reason_codes=reasons or [f"source_serving_{source_state}"],
        source_ref=source_serving_repair_receipt_ledger.get("ledger_id"),
    )


def _repair_slos(
    *,
    ledger_id: str,
    dimensions: Sequence[Mapping[str, object]],
    source_serving_current: bool,
) -> list[dict[str, object]]:
    slos: list[dict[str, object]] = []
    for dimension in dimensions:
        dimension_id = _text(dimension.get("dimension_id"))
        state = _text(dimension.get("state"))
        if not dimension_id or state == "current":
            continue
        output_receipt = _OUTPUT_RECEIPT_BY_DIMENSION.get(dimension_id)
        target_value_gate = _VALUE_GATE_BY_DIMENSION.get(dimension_id)
        if output_receipt is None or target_value_gate is None:
            continue
        dispatchable = source_serving_current or dimension_id == "source_serving"
        slos.append(
            {
                "repair_id": _stable_ref(
                    "freshness-repair-slo",
                    {
                        "ledger_id": ledger_id,
                        "dimension_id": dimension_id,
                        "state": state,
                        "output_receipt": output_receipt,
                    },
                ),
                "target_dimension_id": dimension_id,
                "target_value_gate": target_value_gate,
                "expected_delta": "0.25",
                "max_runtime_seconds": 900,
                "max_retries": 1,
                "required_output_receipts": [output_receipt],
                "stop_conditions": [
                    "max_notional_nonzero",
                    "source_serving_state_conflict",
                    "repair_receipt_expired",
                ],
                "promotion_condition": "freshness_dimension_current_with_source_serving_epoch",
                "rollback_target": "keep paper/live disabled and retain existing route warrant hold",
                "dispatchable": dispatchable,
                "max_notional": _ZERO_NOTIONAL,
                "hold_reason_codes": []
                if dispatchable
                else ["source_serving_not_current"],
                "settlement_status": "pending",
            }
        )
    return slos


def _route_warrant_reason(route_warrant_exchange: Mapping[str, Any]) -> str | None:
    state = _text(route_warrant_exchange.get("warrant_state"), "missing")
    if state in {
        "paper_candidate",
        "live_candidate",
        "live_micro_candidate",
        "live_scale_candidate",
    }:
        return None
    return f"route_warrant_{state}"


def _capital_posture(
    *,
    dimensions: Sequence[Mapping[str, object]],
    source_serving_dimension: Mapping[str, object],
    route_warrant_exchange: Mapping[str, Any],
    live_submission_gate: Mapping[str, Any],
) -> dict[str, object]:
    non_current_dimensions = [
        _text(dimension.get("dimension_id"))
        for dimension in dimensions
        if _text(dimension.get("state")) != "current"
        and _text(dimension.get("dimension_id")) in _VALUE_GATE_BY_DIMENSION
    ]
    reason_codes = [
        reason
        for dimension in dimensions
        if _text(dimension.get("dimension_id")) in _VALUE_GATE_BY_DIMENSION
        for reason in _strings(dimension.get("stale_reason_codes"))
    ]
    route_reason = _route_warrant_reason(route_warrant_exchange)
    if route_reason:
        reason_codes.append(route_reason)
    if not _bool(live_submission_gate.get("allowed")):
        reason_codes.append(
            _text(live_submission_gate.get("reason"), "live_submission_gate_closed")
        )
    decision = "observe"
    route_warrant_state = _text(route_warrant_exchange.get("warrant_state"), "missing")
    if (
        non_current_dimensions
        or route_reason
        or not _bool(live_submission_gate.get("allowed"))
    ):
        decision = "repair_only"
    elif route_warrant_state == "paper_candidate":
        decision = "paper_candidate"
    elif route_warrant_state in {
        "live_candidate",
        "live_micro_candidate",
        "live_scale_candidate",
    }:
        decision = "live_candidate"

    return {
        "decision": decision,
        "max_notional": _ZERO_NOTIONAL
        if decision == "repair_only"
        else _text(route_warrant_exchange.get("max_notional"), _ZERO_NOTIONAL),
        "reason_codes": sorted(set(reason_codes)),
        "required_freshness_dimensions": [
            _text(dimension.get("dimension_id")) for dimension in dimensions
        ],
        "required_source_serving_state": "converged",
        "source_serving_state": _text(source_serving_dimension.get("state")),
        "non_current_dimension_ids": non_current_dimensions,
    }


def _value_gate_impacts(
    dimensions: Sequence[Mapping[str, object]],
) -> list[dict[str, object]]:
    impacts: list[dict[str, object]] = []
    for dimension in dimensions:
        dimension_id = _text(dimension.get("dimension_id"))
        state = _text(dimension.get("state"))
        if not dimension_id:
            continue
        value_gate = _VALUE_GATE_BY_DIMENSION.get(dimension_id)
        if value_gate is None:
            impacts.append(
                {
                    "value_gate": "diagnostic",
                    "dimension_id": dimension_id,
                    "state": state,
                    "capital_effect": "no_capital_change",
                }
            )
            continue
        impacts.append(
            {
                "value_gate": value_gate,
                "dimension_id": dimension_id,
                "state": state,
                "capital_effect": "max_notional_held_at_zero"
                if state != "current"
                else "no_capital_change",
            }
        )
    return impacts


def _jangar_pressure_refs(
    *,
    account_label: str,
    window: str,
    ledger_id: str,
    fresh_until: str,
    dimensions: Sequence[Mapping[str, object]],
    repair_proof_slos: Sequence[Mapping[str, object]],
    external_refs: Sequence[Mapping[str, object]] | None,
) -> list[dict[str, object]]:
    dimension_by_id = {
        _text(dimension.get("dimension_id")): dimension for dimension in dimensions
    }
    refs: list[dict[str, object]] = []
    for slo in repair_proof_slos:
        dimension_id = _text(slo.get("target_dimension_id"))
        if not dimension_id:
            continue
        dimension = dimension_by_id.get(dimension_id, {})
        required_output_receipts = _strings(slo.get("required_output_receipts"))
        pressure_payload = {
            "account_label": account_label,
            "window": window,
            "ledger_id": ledger_id,
            "repair_proof_slo_ref": _text(slo.get("repair_id")),
            "target_dimension_id": dimension_id,
            "required_output_receipts": required_output_receipts,
        }
        reason_codes = sorted(
            set(
                [
                    *_strings(dimension.get("stale_reason_codes")),
                    *_strings(slo.get("hold_reason_codes")),
                ]
            )
        )
        refs.append(
            {
                "schema_version": "torghut.jangar-pressure-ref.v1",
                "pressure_ref_id": _stable_ref(
                    "freshness-pressure-ref", pressure_payload
                ),
                "source_class": "torghut_freshness",
                "action_class": "dispatch_repair",
                "evidence_ref": ledger_id,
                "freshness_carry_ledger_ref": ledger_id,
                "repair_proof_slo_ref": slo.get("repair_id"),
                "target_dimension_id": dimension_id,
                "state": dimension.get("state"),
                "target_value_gate": slo.get("target_value_gate"),
                "required_output_receipts": required_output_receipts,
                "reason_codes": reason_codes,
                "ttl_seconds": _FRESHNESS_SECONDS,
                "expires_at": fresh_until,
                "dedupe_key": _stable_ref(
                    "freshness-pressure-dedupe",
                    {
                        "account_label": account_label,
                        "window": window,
                        "target_dimension_id": dimension_id,
                        "required_output_receipts": required_output_receipts,
                    },
                ),
                "max_notional": _ZERO_NOTIONAL,
                "max_runtime_seconds": slo.get("max_runtime_seconds"),
                "max_retries": slo.get("max_retries"),
                "dispatchable": _bool(slo.get("dispatchable")),
                "hold_reason_codes": _strings(slo.get("hold_reason_codes")),
                "settlement_status": slo.get("settlement_status"),
                "rollback_target": slo.get("rollback_target"),
            }
        )

    for external_ref in external_refs or ():
        ref = dict(external_ref)
        if not _text(ref.get("pressure_ref_id")):
            ref["pressure_ref_id"] = _stable_ref("freshness-pressure-ref", ref)
        refs.append(ref)

    unique_refs: dict[str, dict[str, object]] = {}
    for ref in refs:
        unique_refs[_text(ref.get("pressure_ref_id"))] = ref
    return [ref for key, ref in unique_refs.items() if key]


def build_freshness_carry_ledger(
    *,
    account_label: str,
    window: str,
    source_serving_repair_receipt_ledger: Mapping[str, Any],
    route_warrant_exchange: Mapping[str, Any],
    clickhouse_ta_status: Mapping[str, Any],
    tca_summary: Mapping[str, Any],
    empirical_jobs_status: Mapping[str, Any],
    market_context_status: Mapping[str, Any],
    quant_evidence: Mapping[str, Any],
    live_submission_gate: Mapping[str, Any],
    jangar_pressure_refs: Sequence[Mapping[str, object]] | None = None,
    now: datetime | None = None,
) -> dict[str, object]:
    """Build an observe-mode freshness carry ledger without changing capital gates."""

    generated_at = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    source_dimension = _source_serving_dimension(source_serving_repair_receipt_ledger)
    dimensions = [
        _ta_signal_dimension(
            clickhouse_ta_status=clickhouse_ta_status,
            now=generated_at,
        ),
        _tca_dimension(tca_summary=tca_summary, now=generated_at),
        _empirical_dimension(empirical_jobs_status),
        _market_context_dimension(
            market_context_status=market_context_status,
            now=generated_at,
        ),
        _quant_evidence_dimension(quant_evidence),
        source_dimension,
    ]
    ledger_payload = {
        "account_label": account_label,
        "window": window,
        "source_serving_ledger_ref": source_serving_repair_receipt_ledger.get(
            "ledger_id"
        ),
        "route_warrant_ref": route_warrant_exchange.get("warrant_id"),
        "dimensions": [
            {
                "dimension_id": dimension["dimension_id"],
                "state": dimension["state"],
                "stale_reason_codes": dimension["stale_reason_codes"],
            }
            for dimension in dimensions
        ],
    }
    ledger_id = _stable_ref("freshness-carry-ledger", ledger_payload)
    source_current = _text(source_dimension.get("state")) == "current"
    repair_proof_slos = _repair_slos(
        ledger_id=ledger_id,
        dimensions=dimensions,
        source_serving_current=source_current,
    )
    fresh_until = (generated_at + timedelta(seconds=_FRESHNESS_SECONDS)).isoformat()
    non_current_count = sum(
        1 for dimension in dimensions if _text(dimension.get("state")) != "current"
    )
    capital_posture = _capital_posture(
        dimensions=dimensions,
        source_serving_dimension=source_dimension,
        route_warrant_exchange=route_warrant_exchange,
        live_submission_gate=live_submission_gate,
    )

    return {
        "schema_version": FRESHNESS_CARRY_LEDGER_SCHEMA_VERSION,
        "ledger_id": ledger_id,
        "generated_at": generated_at.isoformat(),
        "fresh_until": fresh_until,
        "account": account_label,
        "window": window,
        "source_serving_ledger_ref": source_serving_repair_receipt_ledger.get(
            "ledger_id"
        ),
        "route_warrant_ref": route_warrant_exchange.get("warrant_id"),
        "dimensions": dimensions,
        "repair_proof_slos": repair_proof_slos,
        "capital_posture": capital_posture,
        "jangar_pressure_refs": _jangar_pressure_refs(
            account_label=account_label,
            window=window,
            ledger_id=ledger_id,
            fresh_until=fresh_until,
            dimensions=dimensions,
            repair_proof_slos=repair_proof_slos,
            external_refs=jangar_pressure_refs,
        ),
        "value_gate_impacts": _value_gate_impacts(dimensions),
        "summary": {
            "dimension_count": len(dimensions),
            "non_current_dimension_count": non_current_count,
            "dispatchable_repair_slo_count": sum(
                1 for slo in repair_proof_slos if _bool(slo.get("dispatchable"))
            ),
            "zero_notional_or_stale_evidence_rate": (
                str(Decimal(non_current_count) / Decimal(len(dimensions)))
                if dimensions
                else "0"
            ),
            "capital_posture": capital_posture["decision"],
            "max_notional": capital_posture["max_notional"],
        },
        "rollback_target": {
            "freshness_carry_ledger_enabled": False,
            "capital_state": "zero_notional",
            "fallback_payload": "torghut.source-serving-repair-receipt-ledger.v1",
        },
    }


__all__ = [
    "FRESHNESS_CARRY_LEDGER_SCHEMA_VERSION",
    "build_freshness_carry_ledger",
]
