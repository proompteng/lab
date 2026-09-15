"""Clock-settlement receipt projection for Torghut proof-path parity."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import datetime, timedelta, timezone
from hashlib import sha256
import json
from typing import Any, cast

from app.trading.evidence_clock_market_session import (
    clickhouse_ta_session_staleness_gate,
)


CLOCK_SETTLEMENT_RECEIPT_SCHEMA_VERSION = "torghut.clock-settlement-receipt.v1"

_FRESHNESS_SECONDS = 60
_DEFAULT_MAX_CLOCK_AGE_SECONDS = 6 * 60 * 60
_CURRENT_STATES = {
    "accepted",
    "allow",
    "allowed",
    "current",
    "fresh",
    "healthy",
    "ok",
    "pass",
    "ready",
}
_BAD_STATES = {
    "block",
    "blocked",
    "degraded",
    "down",
    "error",
    "fail",
    "failed",
    "hold",
    "missing",
    "stale",
}
_VALUE_GATE_BY_CLOCK = {
    "clickhouse_ta": "zero_notional_or_stale_evidence_rate",
    "torghut_quant": "zero_notional_or_stale_evidence_rate",
    "postgres_tca": "fill_tca_or_slippage_quality",
    "empirical_replay": "zero_notional_or_stale_evidence_rate",
    "promotion": "routeable_candidate_count",
    "rollout": "capital_gate_safety",
}
_REPAIR_CLASS_BY_CLOCK = {
    "clickhouse_ta": "clock_wiring_split",
    "torghut_quant": "torghut_quant_scoped_health",
    "postgres_tca": "active_session_tca_refresh",
    "empirical_replay": "empirical_replay_reclock",
    "promotion": "promotion_custody_recheck",
    "rollout": "rollout_image_proof",
}
_VALIDATION_BY_CLOCK = {
    "clickhouse_ta": "pytest services/torghut/tests/test_clock_settlement.py -k clickhouse",
    "torghut_quant": "pytest services/torghut/tests/test_clock_settlement.py -k torghut_quant",
    "postgres_tca": "pytest services/torghut/tests/test_clock_settlement.py -k tca",
    "empirical_replay": "pytest services/torghut/tests/test_clock_settlement.py -k empirical",
    "promotion": "pytest services/torghut/tests/test_clock_settlement.py -k promotion",
    "rollout": "pytest services/torghut/tests/test_clock_settlement.py -k rollout",
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


def _int(value: object, default: int = 0) -> int:
    if value is None:
        return default
    try:
        return int(float(str(value)))
    except (TypeError, ValueError):
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


def _timestamp_from(source: Mapping[str, Any], *keys: str) -> datetime | None:
    for key in keys:
        parsed = _parse_timestamp(source.get(key))
        if parsed is not None:
            return parsed
    return None


def _iso(value: datetime | None) -> str | None:
    return None if value is None else value.astimezone(timezone.utc).isoformat()


def _age_seconds(value: datetime | None, now: datetime) -> int | None:
    return None if value is None else max(0, int((now - value).total_seconds()))


def _stable_ref(prefix: str, payload: Mapping[str, object]) -> str:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return f"{prefix}:{sha256(encoded.encode()).hexdigest()[:20]}"


def _state_from(source: Mapping[str, Any], default: str = "unknown") -> str:
    for key in ("state", "status", "overall_state", "decision"):
        if text := _text(source.get(key)):
            return text.lower()
    return default


def _clock_by_name(arbiter: Mapping[str, Any]) -> dict[str, Mapping[str, Any]]:
    clocks: dict[str, Mapping[str, Any]] = {}
    for raw_clock in _sequence(arbiter.get("clocks")):
        clock = _mapping(raw_clock)
        name = _text(clock.get("name"))
        if name:
            clocks[name] = clock
    return clocks


def _published_state(clock: Mapping[str, Any]) -> str:
    return _text(clock.get("state"), "missing").lower()


def _published_reasons(clock: Mapping[str, Any]) -> list[str]:
    return _strings(clock.get("reason_codes"))


def _split_reasons(
    *,
    witness_class: str,
    freshness_state: str,
    published_clock: Mapping[str, Any],
) -> list[str]:
    published_state = _published_state(published_clock)
    if freshness_state == "current" and published_state != "current":
        reasons = ["clock_wiring_split"]
        if not published_clock:
            reasons.append(f"published_{witness_class}_clock_missing")
        else:
            reasons.append(f"published_{witness_class}_clock_{published_state}")
        reasons.extend(_published_reasons(published_clock))
        return _unique(reasons)
    if freshness_state != "current" and published_state == "current":
        return [f"published_{witness_class}_clock_without_direct_witness"]
    return []


def _witness(
    *,
    witness_class: str,
    source_ref: object,
    observed_at: datetime | None,
    row_count: int | None,
    freshness_state: str,
    reason_codes: Sequence[str],
    published_clock: Mapping[str, Any],
    now: datetime,
    details: Mapping[str, object] | None = None,
) -> dict[str, object]:
    split_reasons = _split_reasons(
        witness_class=witness_class,
        freshness_state=freshness_state,
        published_clock=published_clock,
    )
    published_name = _text(published_clock.get("name"), witness_class)
    return {
        "witness_id": _stable_ref(
            "clock-witness",
            {
                "witness_class": witness_class,
                "source_ref": source_ref,
                "freshness_state": freshness_state,
                "published_state": _published_state(published_clock),
                "reason_codes": list(reason_codes),
                "split_reason_codes": split_reasons,
            },
        ),
        "witness_class": witness_class,
        "source_ref": source_ref,
        "observed_at": _iso(observed_at),
        "row_count": row_count,
        "freshness_state": "split" if split_reasons else freshness_state,
        "direct_freshness_state": freshness_state,
        "matching_published_clock_name": published_name,
        "matching_published_clock_state": _published_state(published_clock),
        "split_reason_codes": split_reasons,
        "reason_codes": _unique(list(reason_codes)),
        "age_seconds": _age_seconds(observed_at, now),
        "details": dict(details or {}),
    }


def _clickhouse_ta_witness(
    status: Mapping[str, Any],
    *,
    published_clock: Mapping[str, Any],
    now: datetime,
    max_age_seconds: int,
) -> dict[str, object]:
    if not status:
        return _witness(
            witness_class="clickhouse_ta",
            source_ref="clickhouse_ta_status",
            observed_at=None,
            row_count=None,
            freshness_state="missing",
            reason_codes=["clickhouse_ta_direct_witness_missing"],
            published_clock=published_clock,
            now=now,
        )
    observed_at = _timestamp_from(
        status, "latest_signal_at", "updated_at", "as_of", "latestSignalAt"
    )
    reasons = [
        *_strings(status.get("reason_codes")),
        *_strings(status.get("blocking_reasons")),
    ]
    state = _state_from(status)
    gate = clickhouse_ta_session_staleness_gate(status)
    if state in _BAD_STATES:
        reasons.append(f"clickhouse_ta_{state}")
    age = _age_seconds(observed_at, now)
    if observed_at is None:
        reasons.append("clickhouse_ta_timestamp_missing")
    elif age is not None and age > max_age_seconds and not gate.suppress_stale:
        reasons.append("clickhouse_ta_stale")
    row_count = _int(status.get("row_count") or status.get("signal_count"), -1)
    freshness_state = "current" if not reasons else "stale"
    if observed_at is None:
        freshness_state = "missing"
    return _witness(
        witness_class="clickhouse_ta",
        source_ref=status.get("source_ref") or status.get("receipt_id"),
        observed_at=observed_at,
        row_count=None if row_count < 0 else row_count,
        freshness_state=freshness_state,
        reason_codes=reasons,
        published_clock=published_clock,
        now=now,
        details={
            "time_column": status.get("time_column"),
            "symbol_count": status.get("symbol_count"),
            "accepted_source_state": gate.accepted_source_state or None,
            "regular_session_open": gate.regular_session_open,
        },
    )


def _tca_witness(
    tca_summary: Mapping[str, Any],
    *,
    published_clock: Mapping[str, Any],
    now: datetime,
    max_age_seconds: int,
) -> dict[str, object]:
    observed_at = _timestamp_from(tca_summary, "last_computed_at", "computed_at")
    latest_execution_at = _timestamp_from(tca_summary, "latest_execution_created_at")
    row_count = _int(tca_summary.get("order_count"), -1)
    filled_count = _int(tca_summary.get("filled_execution_count"), -1)
    reasons = [*_strings(tca_summary.get("reason_codes"))]
    computed_age = _age_seconds(observed_at, now)
    execution_age = _age_seconds(latest_execution_at, now)
    if not tca_summary:
        reasons.append("execution_tca_summary_missing")
    elif row_count <= 0:
        reasons.append("execution_tca_missing")
    if observed_at is None:
        reasons.append("execution_tca_computed_at_missing")
    elif computed_age is not None and computed_age > max_age_seconds:
        reasons.append("execution_tca_stale")
    if latest_execution_at is None or filled_count <= 0:
        reasons.append("active_session_execution_samples_missing")
    elif execution_age is not None and execution_age > max_age_seconds:
        reasons.append("active_session_execution_samples_stale")
    freshness_state = "current" if not reasons else "stale"
    if not tca_summary:
        freshness_state = "missing"
    return _witness(
        witness_class="postgres_tca",
        source_ref=tca_summary.get("receipt_id") or "execution_tca_metrics",
        observed_at=observed_at,
        row_count=None if row_count < 0 else row_count,
        freshness_state=freshness_state,
        reason_codes=reasons,
        published_clock=published_clock,
        now=now,
        details={
            "latest_execution_created_at": _iso(latest_execution_at),
            "computed_age_seconds": computed_age,
            "execution_age_seconds": execution_age,
        },
    )


def _simple_status_witness(
    *,
    witness_class: str,
    source: Mapping[str, Any],
    published_clock: Mapping[str, Any],
    source_ref: object,
    observed_at: datetime | None,
    row_count: int | None = None,
    ready_keys: Sequence[str] = (),
    missing_reason: str,
    stale_reason: str,
    now: datetime,
) -> dict[str, object]:
    reasons = [
        *_strings(source.get("reason_codes")),
        *_strings(source.get("blocking_reasons")),
        *_strings(source.get("stale_jobs")),
        *_strings(source.get("non_promoting_receipts")),
    ]
    state = _state_from(source)
    if not source:
        reasons.append(missing_reason)
    elif state in _BAD_STATES:
        reasons.append(stale_reason)
    for key in ready_keys:
        if source.get(key) is False:
            reasons.append(f"{witness_class}_{key}_false")
    freshness_state = "current" if source and not reasons else "stale"
    if not source:
        freshness_state = "missing"
    return _witness(
        witness_class=witness_class,
        source_ref=source_ref,
        observed_at=observed_at,
        row_count=row_count,
        freshness_state=freshness_state,
        reason_codes=reasons,
        published_clock=published_clock,
        now=now,
        details={"state": state},
    )


def _quant_witness(
    quant_evidence: Mapping[str, Any],
    *,
    published_clock: Mapping[str, Any],
    now: datetime,
) -> dict[str, object]:
    source = dict(quant_evidence)
    reasons = _strings(source.get("reason_codes"))
    if source.get("ok") is False:
        reasons.append("torghut_quant_degraded")
    latest_count = _int(source.get("latest_metrics_count"), -1)
    stage_count = _int(source.get("stage_count"), -1)
    if latest_count == 0:
        reasons.append("torghut_quant_latest_metrics_empty")
    if stage_count == 0:
        reasons.append("torghut_quant_scoped_stages_missing")
    source["reason_codes"] = _unique(reasons)
    return _simple_status_witness(
        witness_class="torghut_quant",
        source=source,
        published_clock=published_clock,
        source_ref=source.get("receipt_id") or source.get("source_url"),
        observed_at=_timestamp_from(
            source, "latest_metrics_updated_at", "updated_at", "latestMetricsUpdatedAt"
        ),
        row_count=None if latest_count < 0 else latest_count,
        missing_reason="torghut_quant_evidence_missing",
        stale_reason="torghut_quant_degraded",
        now=now,
    )


def _promotion_witness(
    profit_signal_quorum: Mapping[str, Any],
    *,
    published_clock: Mapping[str, Any],
    now: datetime,
) -> dict[str, object]:
    decision = _text(profit_signal_quorum.get("aggregate_decision"), "missing").lower()
    source = dict(profit_signal_quorum)
    reasons = _strings(source.get("reason_codes"))
    if decision not in {"paper_candidate", "paper_canary"}:
        reasons.append(f"profit_signal_quorum_{decision}")
    source["reason_codes"] = _unique(reasons)
    return _simple_status_witness(
        witness_class="promotion",
        source=source,
        published_clock=published_clock,
        source_ref=source.get("quorum_set_id"),
        observed_at=_timestamp_from(source, "generated_at"),
        row_count=len(_sequence(source.get("quorums"))),
        missing_reason="promotion_custody_missing",
        stale_reason="promotion_custody_not_current",
        now=now,
    )


def _rollout_witness(
    rollout_status: Mapping[str, Any],
    build: Mapping[str, Any],
    *,
    published_clock: Mapping[str, Any],
    now: datetime,
) -> dict[str, object]:
    source = dict(rollout_status)
    if not source:
        source = {
            "state": "missing",
            "reason_codes": ["rollout_image_proof_missing"],
            "image_digest": build.get("image_digest"),
            "active_revision": build.get("active_revision") or build.get("commit"),
        }
    reasons = _strings(source.get("reason_codes"))
    if not source.get("image_digest") and not build.get("image_digest"):
        reasons.append("image_digest_missing")
    if source.get("route_workloads_ok") is False:
        reasons.append("route_adjacent_workloads_degraded")
    source["reason_codes"] = _unique(reasons)
    return _simple_status_witness(
        witness_class="rollout",
        source=source,
        published_clock=published_clock,
        source_ref=source.get("image_digest") or build.get("image_digest"),
        observed_at=_timestamp_from(source, "updated_at", "verified_at"),
        missing_reason="rollout_image_proof_missing",
        stale_reason="rollout_image_proof_not_current",
        now=now,
    )


def _repair_packet(
    witness: Mapping[str, Any],
    *,
    evidence_clock_arbiter: Mapping[str, Any],
    routeable_profit_candidate_exchange: Mapping[str, Any],
) -> dict[str, object]:
    witness_class = _text(witness.get("witness_class"), "unknown")
    target_clock = _text(witness.get("matching_published_clock_name"), witness_class)
    repair_class = _REPAIR_CLASS_BY_CLOCK.get(witness_class, "evidence_clock_repair")
    value_gate = _VALUE_GATE_BY_CLOCK.get(
        target_clock,
        _VALUE_GATE_BY_CLOCK.get(witness_class, "zero_notional_or_stale_evidence_rate"),
    )
    reason_codes = _unique(
        [
            *_strings(witness.get("split_reason_codes")),
            *_strings(witness.get("reason_codes")),
        ]
    )
    payload = {
        "target_clock": target_clock,
        "repair_class": repair_class,
        "value_gate": value_gate,
        "reason_codes": reason_codes,
        "arbiter_id": evidence_clock_arbiter.get("arbiter_id"),
    }
    return {
        "packet_id": _stable_ref("clock-repair-packet", payload),
        "target_clock": target_clock,
        "target_value_gate": value_gate,
        "repair_class": repair_class,
        "expected_unblock_value": f"retire_{target_clock}_clock_debt",
        "required_input_receipts": [
            witness.get("witness_id"),
            evidence_clock_arbiter.get("arbiter_id"),
            routeable_profit_candidate_exchange.get("exchange_id"),
        ],
        "required_output_receipts": [f"{target_clock}_clock_settled_receipt"],
        "max_runtime_seconds": 900,
        "max_notional": "0",
        "forbidden_action_classes": ["paper_canary", "live_micro_canary", "live_scale"],
        "validation_commands": [
            _VALIDATION_BY_CLOCK.get(
                witness_class, "pytest services/torghut/tests/test_clock_settlement.py"
            )
        ],
        "rollback_target": "keep_existing_evidence_clock_arbiter_and_zero_notional_capital",
        "reason_codes": reason_codes,
    }


def _clock_splits(witnesses: Sequence[Mapping[str, Any]]) -> list[dict[str, object]]:
    splits: list[dict[str, object]] = []
    for witness in witnesses:
        split_reasons = _strings(witness.get("split_reason_codes"))
        if not split_reasons:
            continue
        splits.append(
            {
                "witness_id": witness.get("witness_id"),
                "target_clock": witness.get("matching_published_clock_name"),
                "direct_freshness_state": witness.get("direct_freshness_state"),
                "published_clock_state": witness.get("matching_published_clock_state"),
                "reason_codes": split_reasons,
            }
        )
    return splits


def _settlement_state(
    *,
    witnesses: Sequence[Mapping[str, Any]],
    repair_packets: Sequence[Mapping[str, Any]],
    routeable_candidate_count: int,
    capital_decision: str,
) -> str:
    if repair_packets:
        return "repair_ready"
    if any(
        _text(witness.get("direct_freshness_state")) != "current"
        for witness in witnesses
    ):
        return "blocked"
    if routeable_candidate_count > 0 and capital_decision in {
        "paper_candidate",
        "paper_rehearsal_ready",
    }:
        return "paper_rehearsal_ready"
    return "repair_ready"


def _summary(
    *,
    witnesses: Sequence[Mapping[str, Any]],
    repair_packets: Sequence[Mapping[str, Any]],
    routeable_candidate_count: int,
    zero_notional_or_stale_evidence_rate: object,
    capital_decision: str,
    settlement_state: str,
) -> dict[str, object]:
    return {
        "settlement_state": settlement_state,
        "direct_witness_count": len(witnesses),
        "clock_split_count": sum(
            1 for witness in witnesses if _strings(witness.get("split_reason_codes"))
        ),
        "repair_packet_count": len(repair_packets),
        "selected_repair_packet_ids": [
            packet.get("packet_id") for packet in repair_packets
        ],
        "routeable_candidate_count": routeable_candidate_count,
        "zero_notional_or_stale_evidence_rate": zero_notional_or_stale_evidence_rate,
        "capital_decision": capital_decision,
        "max_notional": "0",
    }


def build_clock_settlement_receipt(
    *,
    account_label: str,
    window: str,
    trading_mode: str,
    torghut_revision: str | None,
    source_commit: str | None,
    build: Mapping[str, Any],
    evidence_clock_arbiter: Mapping[str, Any],
    routeable_profit_candidate_exchange: Mapping[str, Any],
    clickhouse_ta_status: Mapping[str, Any] | None = None,
    quant_evidence: Mapping[str, Any] | None = None,
    tca_summary: Mapping[str, Any] | None = None,
    empirical_jobs_status: Mapping[str, Any] | None = None,
    profit_signal_quorum: Mapping[str, Any] | None = None,
    rollout_status: Mapping[str, Any] | None = None,
    now: datetime | None = None,
    max_clock_age_seconds: int = _DEFAULT_MAX_CLOCK_AGE_SECONDS,
) -> dict[str, object]:
    """Build an observe-mode settlement receipt without changing capital gates."""

    observed_at = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    published_clocks = _clock_by_name(evidence_clock_arbiter)
    witnesses = [
        _clickhouse_ta_witness(
            _mapping(clickhouse_ta_status),
            published_clock=published_clocks.get("clickhouse_ta", {}),
            now=observed_at,
            max_age_seconds=max_clock_age_seconds,
        ),
        _quant_witness(
            _mapping(quant_evidence),
            published_clock=published_clocks.get("torghut_quant", {}),
            now=observed_at,
        ),
        _tca_witness(
            _mapping(tca_summary),
            published_clock=published_clocks.get("postgres_tca", {}),
            now=observed_at,
            max_age_seconds=max_clock_age_seconds,
        ),
        _simple_status_witness(
            witness_class="empirical_replay",
            source=_mapping(empirical_jobs_status),
            published_clock=published_clocks.get("empirical_replay", {}),
            source_ref=_mapping(empirical_jobs_status).get("authority")
            or _mapping(empirical_jobs_status).get("receipt_id"),
            observed_at=_timestamp_from(
                _mapping(empirical_jobs_status),
                "updated_at",
                "newest_updated_at",
                "last_completed_at",
            ),
            ready_keys=("ready",),
            missing_reason="empirical_jobs_status_missing",
            stale_reason="empirical_jobs_not_ready",
            now=observed_at,
        ),
        _promotion_witness(
            _mapping(profit_signal_quorum),
            published_clock=published_clocks.get("profit_signal_quorum", {}),
            now=observed_at,
        ),
        _rollout_witness(
            _mapping(rollout_status),
            build,
            published_clock=published_clocks.get("rollout", {}),
            now=observed_at,
        ),
    ]
    repair_packets = [
        _repair_packet(
            witness,
            evidence_clock_arbiter=evidence_clock_arbiter,
            routeable_profit_candidate_exchange=routeable_profit_candidate_exchange,
        )
        for witness in witnesses
        if _strings(witness.get("split_reason_codes"))
        or _text(witness.get("direct_freshness_state")) != "current"
    ]
    routeable_candidate_count = _int(
        evidence_clock_arbiter.get("routeable_candidate_count")
    )
    capital_decision = _text(
        evidence_clock_arbiter.get("capital_decision"), "repair_only"
    )
    settlement_state = _settlement_state(
        witnesses=witnesses,
        repair_packets=repair_packets,
        routeable_candidate_count=routeable_candidate_count,
        capital_decision=capital_decision,
    )
    receipt_payload = {
        "account_label": account_label,
        "window": window,
        "trading_mode": trading_mode,
        "torghut_revision": torghut_revision,
        "source_commit": source_commit,
        "evidence_clock_arbiter_ref": evidence_clock_arbiter.get("arbiter_id"),
        "repair_packet_ids": [packet["packet_id"] for packet in repair_packets],
        "settlement_state": settlement_state,
    }
    summary = _summary(
        witnesses=witnesses,
        repair_packets=repair_packets,
        routeable_candidate_count=routeable_candidate_count,
        zero_notional_or_stale_evidence_rate=evidence_clock_arbiter.get(
            "zero_notional_or_stale_evidence_rate"
        ),
        capital_decision=capital_decision,
        settlement_state=settlement_state,
    )
    return {
        "schema_version": CLOCK_SETTLEMENT_RECEIPT_SCHEMA_VERSION,
        "receipt_id": _stable_ref("clock-settlement-receipt", receipt_payload),
        "generated_at": observed_at.isoformat(),
        "fresh_until": (
            observed_at + timedelta(seconds=_FRESHNESS_SECONDS)
        ).isoformat(),
        "account": account_label,
        "window": window,
        "trading_mode": trading_mode,
        "torghut_revision": torghut_revision,
        "source_commit": source_commit,
        "build": dict(build),
        "evidence_clock_arbiter_ref": evidence_clock_arbiter.get("arbiter_id"),
        "routeable_profit_candidate_exchange_ref": routeable_profit_candidate_exchange.get(
            "exchange_id"
        ),
        "direct_data_witnesses": witnesses,
        "published_clocks": [
            {
                "name": clock.get("name"),
                "state": clock.get("state"),
                "as_of": clock.get("as_of"),
                "reason_codes": list(_sequence(clock.get("reason_codes"))),
            }
            for clock in published_clocks.values()
        ],
        "clock_splits": _clock_splits(witnesses),
        "repair_execution_packets": repair_packets,
        "settlement_state": settlement_state,
        "routeable_candidate_count": routeable_candidate_count,
        "zero_notional_or_stale_evidence_rate": evidence_clock_arbiter.get(
            "zero_notional_or_stale_evidence_rate"
        ),
        "fill_tca_or_slippage_quality": (
            "current"
            if next(
                witness
                for witness in witnesses
                if witness["witness_class"] == "postgres_tca"
            )["direct_freshness_state"]
            == "current"
            else "repair_required"
        ),
        "capital_decision": capital_decision,
        "max_notional": "0",
        "selected_repair_packet_ids": [
            packet["packet_id"] for packet in repair_packets
        ],
        "required_torghut_dispatch_ref": evidence_clock_arbiter.get(
            "required_torghut_custody_ref"
        ),
        "rollback_target": {
            "capital_state": "zero_notional",
            "clock_settlement_consumption_enabled": False,
            "evidence_clock_arbiter_consumption_enabled": False,
        },
        "summary": summary,
    }


__all__ = [
    "CLOCK_SETTLEMENT_RECEIPT_SCHEMA_VERSION",
    "build_clock_settlement_receipt",
]
