"""Route-warrant exchange projection for Torghut routeability proof."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import datetime, timedelta, timezone
from hashlib import sha256
import json
from typing import Any, cast

from .route_metadata import route_repair_recommendation


ROUTE_WARRANT_EXCHANGE_SCHEMA_VERSION = "torghut.route-warrant-exchange.v1"

_FRESHNESS_SECONDS = 60
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
_VALUE_GATES = [
    "post_cost_daily_net_pnl",
    "routeable_candidate_count",
    "zero_notional_or_stale_evidence_rate",
    "fill_tca_or_slippage_quality",
    "capital_gate_safety",
]
_WARRANT_DEPENDENCIES = {
    "clickhouse_ta": {
        "target_dependency": "direct_data",
        "target_value_gate": "zero_notional_or_stale_evidence_rate",
        "repair_class": "market_data_clock_refresh",
        "output_receipt": "torghut.direct-data-current-receipt.v1",
        "source_ref": "clickhouse_ta",
    },
    "torghut_quant": {
        "target_dependency": "ingestion_materialization",
        "target_value_gate": "zero_notional_or_stale_evidence_rate",
        "repair_class": "quant_ingestion_materialization_repair",
        "output_receipt": "torghut.quant-ingestion-materialization-current-receipt.v1",
        "source_ref": "torghut_quant_health",
    },
    "postgres_tca": {
        "target_dependency": "active_tca",
        "target_value_gate": "fill_tca_or_slippage_quality",
        "repair_class": "active_session_tca_refresh",
        "output_receipt": "torghut.active-session-tca-current-receipt.v1",
        "source_ref": "execution_tca_metrics",
    },
    "empirical_replay": {
        "target_dependency": "empirical",
        "target_value_gate": "zero_notional_or_stale_evidence_rate",
        "repair_class": "empirical_replay_refresh",
        "output_receipt": "torghut.empirical-replay-current-receipt.v1",
        "source_ref": "vnext_empirical_job_runs",
    },
    "market_context": {
        "target_dependency": "market_context",
        "target_value_gate": "zero_notional_or_stale_evidence_rate",
        "repair_class": "market_context_domain_refresh",
        "output_receipt": "torghut.market-context-current-receipt.v1",
        "source_ref": "market_context",
    },
    "hypothesis_lineage": {
        "target_dependency": "forecast_registry",
        "target_value_gate": "routeable_candidate_count",
        "repair_class": "promotion_candidate_generation",
        "output_receipt": "torghut.forecast-registry-current-receipt.v1",
        "source_ref": "strategy_hypothesis_metric_windows",
    },
    "rollout": {
        "target_dependency": "rollout_image",
        "target_value_gate": "capital_gate_safety",
        "repair_class": "rollout_image_proof",
        "output_receipt": "torghut.rollout-image-current-receipt.v1",
        "source_ref": "torghut_runtime_image",
    },
    "routeability_acceptance": {
        "target_dependency": "routeability",
        "target_value_gate": "routeable_candidate_count",
        "repair_class": "routeability_receipt_settlement",
        "output_receipt": "torghut.routeability-acceptance-current-receipt.v1",
        "source_ref": "routeability_repair_acceptance_ledger",
    },
    "profit_signal_quorum": {
        "target_dependency": "profit_signal",
        "target_value_gate": "post_cost_daily_net_pnl",
        "repair_class": "profit_signal_quorum_repair",
        "output_receipt": "torghut.profit-signal-quorum-current-receipt.v1",
        "source_ref": "profit_signal_quorum",
    },
    "capital_gate": {
        "target_dependency": "submission",
        "target_value_gate": "capital_gate_safety",
        "repair_class": "capital_gate_hold",
        "output_receipt": "torghut.live-submission-gate-current-receipt.v1",
        "source_ref": "live_submission_gate",
    },
}
_WITNESS_GROUP_BY_DEPENDENCY = {
    "direct_data": "direct_data_witnesses",
    "ingestion_materialization": "ingestion_materialization_witnesses",
    "active_tca": "active_tca_witnesses",
    "empirical": "empirical_replay_witnesses",
    "market_context": "market_context_witnesses",
    "submission": "capital_submission_witnesses",
    "routeability": "routeability_witnesses",
    "profit_signal": "profit_signal_witnesses",
    "rollout_image": "rollout_witnesses",
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


def _bool(value: object, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"1", "true", "yes", "on", "allow", "allowed", "ok", "ready"}:
            return True
        if normalized in {
            "0",
            "false",
            "no",
            "off",
            "block",
            "blocked",
            "degraded",
            "hold",
        }:
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


def _timestamp(value: object) -> datetime | None:
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


def _first_timestamp(source: Mapping[str, Any], *keys: str) -> datetime | None:
    for key in keys:
        parsed = _timestamp(source.get(key))
        if parsed is not None:
            return parsed
    return None


def _stable_ref(prefix: str, payload: Mapping[str, object]) -> str:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return f"{prefix}:{sha256(encoded.encode()).hexdigest()[:20]}"


def _clock_by_name(
    evidence_clock_arbiter: Mapping[str, Any],
) -> dict[str, Mapping[str, Any]]:
    clocks: dict[str, Mapping[str, Any]] = {}
    for raw_clock in _sequence(evidence_clock_arbiter.get("clocks")):
        clock = _mapping(raw_clock)
        name = _text(clock.get("name"))
        if name:
            clocks[name] = clock
    return clocks


def _clock_state(clock: Mapping[str, Any]) -> str:
    return _text(clock.get("state"), "missing").lower()


def _state_from_source(source: Mapping[str, Any]) -> str:
    for key in ("state", "status", "overall_state", "decision"):
        if text := _text(source.get(key)):
            return text.lower()
    return "unknown"


def _source_reason_codes(source: Mapping[str, Any]) -> list[str]:
    return _unique(
        [
            *_strings(source.get("blocking_reasons")),
            *_strings(source.get("blocked_reasons")),
            *_strings(source.get("reason_codes")),
            *_strings(source.get("reasons")),
            *_strings(source.get("stale_jobs")),
            *_strings(source.get("missing_jobs")),
            *_strings(source.get("ineligible_jobs")),
            *_strings(source.get("stale_domains")),
            *_strings(source.get("market_context_stale_domains")),
        ]
    )


def _quant_reasons(quant_evidence: Mapping[str, Any]) -> list[str]:
    reasons = _source_reason_codes(quant_evidence)
    if quant_evidence.get("ok") is False:
        reasons.append(_text(quant_evidence.get("reason"), "torghut_quant_degraded"))
    for key, reason in (
        ("ingestion_ok", "torghut_quant_ingestion_degraded"),
        ("materialization_ok", "torghut_quant_materialization_degraded"),
        ("compute_ok", "torghut_quant_compute_degraded"),
    ):
        if quant_evidence.get(key) is False:
            reasons.append(reason)
    if _int(quant_evidence.get("latest_metrics_count"), -1) == 0:
        reasons.append("torghut_quant_latest_metrics_empty")
    if _int(quant_evidence.get("stage_count"), -1) == 0:
        reasons.append("torghut_quant_scoped_stages_missing")
    return _unique(reasons)


def _source_for_clock(
    clock_name: str,
    *,
    quant_evidence: Mapping[str, Any],
    tca_summary: Mapping[str, Any],
    empirical_jobs_status: Mapping[str, Any],
    market_context_status: Mapping[str, Any],
    routeability_repair_acceptance_ledger: Mapping[str, Any],
    live_submission_gate: Mapping[str, Any],
    build: Mapping[str, Any],
    profit_freshness_frontier: Mapping[str, Any],
) -> Mapping[str, Any]:
    sources = {
        "torghut_quant": quant_evidence,
        "postgres_tca": tca_summary,
        "empirical_replay": empirical_jobs_status,
        "market_context": market_context_status,
        "routeability_acceptance": routeability_repair_acceptance_ledger,
        "capital_gate": live_submission_gate,
        "rollout": build,
        "profit_signal_quorum": profit_freshness_frontier,
    }
    return sources.get(clock_name, {})


def _source_observed_at(
    clock_name: str, source: Mapping[str, Any], clock: Mapping[str, Any]
) -> datetime | None:
    clock_observed_at = _first_timestamp(clock, "as_of", "generated_at", "updated_at")
    if clock_observed_at is not None:
        return clock_observed_at
    source_keys = {
        "torghut_quant": (
            "latest_metrics_updated_at",
            "latestMetricsUpdatedAt",
            "updated_at",
        ),
        "postgres_tca": ("last_computed_at", "computed_at"),
        "empirical_replay": ("updated_at", "newest_updated_at", "last_completed_at"),
        "market_context": (
            "updated_at",
            "last_updated_at",
            "last_snapshot_at",
            "last_checked_at",
        ),
    }
    return _first_timestamp(
        source,
        *source_keys.get(clock_name, ("generated_at", "updated_at", "verified_at")),
    )


def _source_ref(
    clock_name: str, source: Mapping[str, Any], clock: Mapping[str, Any]
) -> object:
    if clock.get("source_ref"):
        return clock.get("source_ref")
    for key in (
        "receipt_id",
        "source_url",
        "ledger_id",
        "frontier_id",
        "authority",
        "schema_version",
    ):
        if source.get(key):
            return source.get(key)
    return _WARRANT_DEPENDENCIES[clock_name]["source_ref"]


def _witness(
    *,
    clock_name: str,
    source: Mapping[str, Any],
    clock: Mapping[str, Any],
    fallback_reason: str,
) -> dict[str, object]:
    dependency = _WARRANT_DEPENDENCIES[clock_name]
    clock_reasons = _strings(clock.get("reason_codes"))
    if clock_name == "torghut_quant":
        source_reasons = _quant_reasons(source)
    else:
        source_reasons = _source_reason_codes(source)
    state = _clock_state(clock) if clock else "missing"
    if state in {"", "unknown"}:
        state = _state_from_source(source)
    reasons = _unique([*clock_reasons, *source_reasons])
    if not clock:
        reasons.append(fallback_reason)
    if state in _BAD_STATES and not reasons:
        reasons.append(f"{clock_name}_{state}")
    observed_at = _source_observed_at(clock_name, source, clock)
    published_state = _clock_state(clock) if clock else "missing"
    current = state == "current" and not reasons
    witness_state = "current" if current else ("stale" if state == "current" else state)
    published_matches = witness_state == published_state or published_state == "missing"
    return {
        "witness_id": _stable_ref(
            "route-warrant-witness",
            {
                "clock_name": clock_name,
                "state": witness_state,
                "source_ref": _source_ref(clock_name, source, clock),
                "reason_codes": reasons,
            },
        ),
        "dependency": dependency["target_dependency"],
        "published_clock": clock_name,
        "state": witness_state,
        "source_ref": _source_ref(clock_name, source, clock),
        "newest_timestamp": _iso(observed_at),
        "freshness_budget_seconds": clock.get("max_age_seconds"),
        "matching_published_clock": published_matches,
        "contradiction_reason_codes": []
        if published_matches
        else [f"{clock_name}_direct_{witness_state}_published_{published_state}"],
        "affected_value_gates": list(_sequence(clock.get("affected_value_gates")))
        or [dependency["target_value_gate"]],
        "reason_codes": _unique(reasons),
        "details": dict(_mapping(clock.get("details"))),
    }


def _repair_packet(witness: Mapping[str, Any]) -> dict[str, object]:
    dependency_name = _text(witness.get("published_clock"))
    dependency = _WARRANT_DEPENDENCIES[dependency_name]
    reason_codes = _strings(witness.get("reason_codes"))
    primary_reason = reason_codes[0] if reason_codes else _text(witness.get("state"), "missing")
    payload = {
        "dependency": dependency["target_dependency"],
        "state": _text(witness.get("state")),
        "reason_codes": reason_codes,
        "source_ref": _text(witness.get("source_ref")),
    }
    return {
        "packet_id": _stable_ref("route-warrant-repair-packet", payload),
        "target_value_gate": dependency["target_value_gate"],
        "target_dependency": dependency["target_dependency"],
        "repair_class": dependency["repair_class"],
        "current_state": _text(witness.get("state"), "missing"),
        "reason_codes": reason_codes,
        "source_ref": witness.get("source_ref"),
        "expected_output_receipt": dependency["output_receipt"],
        "expected_unblock_value": f"{dependency['target_dependency']}_current",
        "repair_recommendation": route_repair_recommendation(primary_reason),
        "promotion_authority": False,
        "capital_authority": "none",
        "authority_semantics": "audit_only",
        "max_notional": "0",
        "stop_conditions": [
            "paper_or_live_notional_requested",
            "required_output_receipt_missing",
            "warrant_dependency_still_not_current",
            "runtime_ledger_source_proof_missing",
        ],
        "rollback_target": {
            "capital_state": "zero_notional",
            "live_submit_enabled": False,
            "route_warrant_consumption_enabled": False,
            "promotion_authority": False,
        },
    }


def _group_witnesses(
    witnesses: Sequence[Mapping[str, Any]],
) -> dict[str, list[dict[str, object]]]:
    result: dict[str, list[dict[str, object]]] = {
        group_name: [] for group_name in _WITNESS_GROUP_BY_DEPENDENCY.values()
    }
    for witness in witnesses:
        group_name = _WITNESS_GROUP_BY_DEPENDENCY.get(_text(witness.get("dependency")))
        if group_name is None:
            continue
        row = cast(dict[str, object], dict(witness))
        result[group_name].append(row)
    return result


def _routeable_candidate_count(
    *,
    all_required_current: bool,
    live_submission_gate: Mapping[str, Any],
    routeability_repair_acceptance_ledger: Mapping[str, Any],
    routeable_profit_candidate_exchange: Mapping[str, Any],
) -> int:
    if not all_required_current or not _bool(live_submission_gate.get("allowed")):
        return 0
    ledger_count = _int(
        routeability_repair_acceptance_ledger.get("accepted_routeable_candidate_count")
    )
    exchange_summary = _mapping(routeable_profit_candidate_exchange.get("summary"))
    exchange_count = _int(exchange_summary.get("routeable_candidate_count"))
    if exchange_count <= 0:
        exchange_count = len(
            _sequence(routeable_profit_candidate_exchange.get("routeable_candidates"))
        )
    return min(ledger_count, exchange_count) if exchange_count > 0 else ledger_count


def _warrant_state(
    *,
    consumer_evidence_receipt: Mapping[str, Any],
    evidence_clock_arbiter: Mapping[str, Any],
    all_required_current: bool,
    accepted_routeable_candidate_count: int,
    live_submission_gate: Mapping[str, Any],
) -> str:
    if not consumer_evidence_receipt or not evidence_clock_arbiter:
        return "blocked"
    if (
        all_required_current
        and accepted_routeable_candidate_count > 0
        and _bool(live_submission_gate.get("allowed"))
    ):
        return "paper_candidate"
    return "repair_only"


def _post_cost_state(
    *,
    profit_freshness_frontier: Mapping[str, Any],
    accepted_routeable_candidate_count: int,
) -> dict[str, object]:
    summary = _mapping(profit_freshness_frontier.get("summary"))
    selected_unlock = summary.get("selected_expected_daily_net_pnl_unlock")
    frontier_state = _text(profit_freshness_frontier.get("frontier_state"), "unknown")
    return {
        "state": "paper_candidate"
        if accepted_routeable_candidate_count > 0 and frontier_state == "ready"
        else frontier_state,
        "selected_expected_daily_net_pnl_unlock": selected_unlock,
        "ranked_daily_net_pnl_repair_count": summary.get(
            "ranked_daily_net_pnl_repair_count"
        ),
        "frontier_ref": profit_freshness_frontier.get("frontier_id"),
    }


def build_route_warrant_exchange(
    *,
    account_label: str,
    window: str,
    trading_mode: str,
    torghut_revision: str | None,
    source_commit: str | None,
    build: Mapping[str, Any],
    consumer_evidence_receipt: Mapping[str, Any],
    evidence_clock_arbiter: Mapping[str, Any],
    routeable_profit_candidate_exchange: Mapping[str, Any],
    routeability_repair_acceptance_ledger: Mapping[str, Any],
    profit_freshness_frontier: Mapping[str, Any],
    live_submission_gate: Mapping[str, Any],
    quant_evidence: Mapping[str, Any],
    tca_summary: Mapping[str, Any],
    empirical_jobs_status: Mapping[str, Any],
    market_context_status: Mapping[str, Any],
    now: datetime | None = None,
) -> dict[str, object]:
    """Build a shadow-first route warrant without widening paper or live notional."""

    observed_at = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    clocks = _clock_by_name(evidence_clock_arbiter)
    required_clock_names = [
        "clickhouse_ta",
        "torghut_quant",
        "postgres_tca",
        "empirical_replay",
        "market_context",
        "hypothesis_lineage",
        "rollout",
        "routeability_acceptance",
        "profit_signal_quorum",
        "capital_gate",
    ]
    witnesses = [
        _witness(
            clock_name=clock_name,
            source=_source_for_clock(
                clock_name,
                quant_evidence=quant_evidence,
                tca_summary=tca_summary,
                empirical_jobs_status=empirical_jobs_status,
                market_context_status=market_context_status,
                routeability_repair_acceptance_ledger=routeability_repair_acceptance_ledger,
                live_submission_gate=live_submission_gate,
                build=build,
                profit_freshness_frontier=profit_freshness_frontier,
            ),
            clock=clocks.get(clock_name, {}),
            fallback_reason=f"{clock_name}_clock_missing",
        )
        for clock_name in required_clock_names
    ]
    noncurrent_witnesses = [
        witness for witness in witnesses if _text(witness.get("state")) != "current"
    ]
    all_required_current = not noncurrent_witnesses
    accepted_routeable_candidate_count = _routeable_candidate_count(
        all_required_current=all_required_current,
        live_submission_gate=live_submission_gate,
        routeability_repair_acceptance_ledger=routeability_repair_acceptance_ledger,
        routeable_profit_candidate_exchange=routeable_profit_candidate_exchange,
    )
    warrant_state = _warrant_state(
        consumer_evidence_receipt=consumer_evidence_receipt,
        evidence_clock_arbiter=evidence_clock_arbiter,
        all_required_current=all_required_current,
        accepted_routeable_candidate_count=accepted_routeable_candidate_count,
        live_submission_gate=live_submission_gate,
    )
    stale_rate = round(len(noncurrent_witnesses) / max(1, len(witnesses)), 4)
    repair_packets = [_repair_packet(witness) for witness in noncurrent_witnesses]
    grouped_witnesses = _group_witnesses(witnesses)
    warrant_id = _stable_ref(
        "route-warrant-exchange",
        {
            "account_label": account_label,
            "window": window,
            "trading_mode": trading_mode,
            "torghut_revision": torghut_revision,
            "warrant_state": warrant_state,
            "witness_states": {
                _text(witness.get("published_clock")): _text(witness.get("state"))
                for witness in witnesses
            },
            "accepted_routeable_candidate_count": accepted_routeable_candidate_count,
        },
    )
    empty_witness: Mapping[str, Any] = {}
    tca_witness = next(
        (witness for witness in witnesses if witness.get("dependency") == "active_tca"),
        empty_witness,
    )
    blocking_reason_codes = _unique(
        [
            _text(reason)
            for witness in noncurrent_witnesses
            for reason in _sequence(witness.get("reason_codes"))
        ]
    )
    return {
        "schema_version": ROUTE_WARRANT_EXCHANGE_SCHEMA_VERSION,
        "warrant_id": warrant_id,
        "generated_at": observed_at.isoformat(),
        "fresh_until": (
            observed_at + timedelta(seconds=_FRESHNESS_SECONDS)
        ).isoformat(),
        "account": account_label,
        "window": window,
        "trading_mode": trading_mode,
        "torghut_revision": torghut_revision,
        "source_commit": source_commit,
        "consumer_evidence_receipt_id": consumer_evidence_receipt.get("receipt_id"),
        "evidence_clock_arbiter_ref": evidence_clock_arbiter.get("arbiter_id"),
        "routeable_profit_candidate_exchange_ref": routeable_profit_candidate_exchange.get(
            "exchange_id"
        ),
        "routeability_repair_acceptance_ref": routeability_repair_acceptance_ledger.get(
            "ledger_id"
        ),
        "profit_freshness_frontier_ref": profit_freshness_frontier.get("frontier_id"),
        "live_submission_gate_ref": live_submission_gate.get("gate_id")
        or live_submission_gate.get("reason")
        or "live_submission_gate",
        **grouped_witnesses,
        "repair_packets": repair_packets,
        "accepted_routeable_candidate_count": accepted_routeable_candidate_count,
        "routeable_candidate_count": accepted_routeable_candidate_count,
        "zero_notional_or_stale_evidence_rate": stale_rate,
        "fill_tca_or_slippage_quality": {
            "state": tca_witness.get("state", "missing"),
            "reason_codes": tca_witness.get("reason_codes", []),
            "details": tca_witness.get("details", {}),
        },
        "capital_gate_safety": {
            "state": "zero_notional_safe",
            "warrant_state": warrant_state,
            "max_notional": "0",
            "live_submission_allowed": _bool(live_submission_gate.get("allowed")),
            "capital_behavior_changed": False,
        },
        "post_cost_daily_net_pnl_state": _post_cost_state(
            profit_freshness_frontier=profit_freshness_frontier,
            accepted_routeable_candidate_count=accepted_routeable_candidate_count,
        ),
        "warrant_state": warrant_state,
        "promotion_authority": False,
        "authority_semantics": "audit_only_until_source_backed_runtime_ledger_fill_proof",
        "max_notional": "0",
        "blocking_reason_codes": blocking_reason_codes,
        "summary": {
            "witness_count": len(witnesses),
            "current_witness_count": len(witnesses) - len(noncurrent_witnesses),
            "noncurrent_witness_count": len(noncurrent_witnesses),
            "repair_packet_count": len(repair_packets),
            "accepted_routeable_candidate_count": accepted_routeable_candidate_count,
            "value_gates": _VALUE_GATES,
        },
        "rollback_target": {
            "route_warrant_exchange_consumption_enabled": False,
            "capital_state": "zero_notional",
            "live_submit_enabled": False,
            "fallback_payload": "torghut.consumer-evidence-status.v1",
        },
    }


__all__ = [
    "ROUTE_WARRANT_EXCHANGE_SCHEMA_VERSION",
    "build_route_warrant_exchange",
]
