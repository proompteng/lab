#!/usr/bin/env python
"""Read-only H-PAIRS signal/route liveness diagnostics.

The audit intentionally consumes only fixture JSON, local status JSON, or an
optional bounded HTTP GET. It never submits orders, writes proof artifacts, or
mutates database/cluster state.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import cast


DEFAULT_HPAIRS_HYPOTHESIS_ID = "H-PAIRS-01"

DEFAULT_HPAIRS_CANDIDATE_ID = "c88421d619759b2cfaa6f4d0"

DEFAULT_HPAIRS_RUNTIME_STRATEGY = "microbar-cross-sectional-pairs-v1"

DEFAULT_HPAIRS_ACCOUNT_LABEL = "TORGHUT_SIM"

DEFAULT_OBSERVED_STAGE = "paper"

HPAIRS_SIGNAL_LIVENESS_SCHEMA_VERSION = "torghut.hpairs-signal-liveness.v1"

NEXT_ACTIONS = (
    "no_target",
    "wrong_account",
    "no_market_data",
    "signal_below_threshold",
    "risk_veto",
    "route_disabled",
    "evidence_collection_disabled",
    "materialize_drift_checks",
    "materialize_runtime_buckets",
    "wait_for_fresh_signal_window",
    "wait_for_market_session_open",
    "ready_to_submit_sim_order",
    "unsupported_inputs",
)

_MARKET_DATA_READY_KEYS = (
    "ready",
    "is_ready",
    "available",
    "is_available",
    "fresh",
    "has_latest",
)

_ROUTE_FLAG_KEYS = (
    "route_enabled",
    "route_eligible",
    "paper_route_enabled",
    "paper_route_eligible",
    "order_route_enabled",
    "order_route_eligible",
    "submit_route_enabled",
    "submit_route_eligible",
    "simulation_route_enabled",
    "sim_route_enabled",
)

_EVIDENCE_COLLECTION_KEYS = (
    "evidence_collection_ok",
    "evidence_collection_enabled",
    "bounded_evidence_collection_authorized",
    "source_collection_enabled",
    "source_collection_ok",
    "collection_enabled",
)

_SIMPLE_SUBMIT_KEYS = (
    "simple_submit_enabled",
    "submit_enabled",
    "trading_simple_submit_enabled",
)


@dataclass(frozen=True)
class AuditExpectations:
    hypothesis_id: str
    candidate_id: str
    account_label: str
    observed_stage: str
    runtime_strategy: str
    max_quote_age_seconds: float
    max_feature_age_seconds: float
    max_signal_lag_seconds: float


def _mapping(value: object) -> Mapping[str, object]:
    if isinstance(value, Mapping):
        return cast(Mapping[str, object], value)
    return {}


def _sequence(value: object) -> Sequence[object]:
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return cast(Sequence[object], value)
    return ()


def _text(value: object) -> str | None:
    if value is None:
        return None
    if isinstance(value, str):
        stripped = value.strip()
        return stripped or None
    return str(value)


def _bool_or_none(value: object) -> bool | None:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"1", "true", "t", "yes", "y", "enabled", "ready", "ok"}:
            return True
        if normalized in {"0", "false", "f", "no", "n", "disabled", "blocked"}:
            return False
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return bool(value)
    return None


def _float_or_none(value: object) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return None
        try:
            return float(stripped)
        except ValueError:
            return None
    return None


def _unique_text_items(value: object) -> list[str]:
    raw_items: Iterable[object]
    if isinstance(value, str):
        raw_items = (item for item in value.replace(";", ",").split(","))
    elif isinstance(value, Sequence) and not isinstance(value, (bytes, bytearray)):
        raw_items = value
    elif isinstance(value, Mapping):
        raw_items = value.keys()
    elif value is None:
        raw_items = ()
    else:
        raw_items = (value,)
    seen: set[str] = set()
    items: list[str] = []
    for raw_item in raw_items:
        item = _text(raw_item)
        if item is None or item in seen:
            continue
        seen.add(item)
        items.append(item)
    return items


def _json_default(value: object) -> str:
    return str(value)


def stable_json(payload: Mapping[str, object]) -> str:
    return json.dumps(payload, default=_json_default, indent=2, sort_keys=True) + "\n"


def _read_json_path(path: str | Path) -> Mapping[str, object]:
    loaded = json.loads(Path(path).read_text())
    if not isinstance(loaded, Mapping):
        raise ValueError(f"{path} must contain a JSON object")
    return cast(Mapping[str, object], loaded)


def _read_status_url(url: str, timeout: float) -> Mapping[str, object]:
    request = urllib.request.Request(url, method="GET")
    with urllib.request.urlopen(request, timeout=timeout) as response:
        loaded = json.loads(response.read().decode("utf-8"))
    if not isinstance(loaded, Mapping):
        raise ValueError(f"{url} returned a non-object JSON payload")
    return cast(Mapping[str, object], loaded)


def _merge_inputs(
    base: Mapping[str, object], overrides: Mapping[str, Mapping[str, object]]
) -> dict[str, object]:
    merged: dict[str, object] = dict(base)
    for key, value in overrides.items():
        if value:
            merged[key] = dict(value)
    return merged


def _target_matches(
    candidate: Mapping[str, object], expectations: AuditExpectations
) -> bool:
    candidate_id = _text(
        candidate.get("candidate_id") or candidate.get("target_candidate_id")
    )
    hypothesis_id = _text(candidate.get("hypothesis_id") or candidate.get("hypothesis"))
    runtime_strategy = _text(
        candidate.get("runtime_strategy_name")
        or candidate.get("runtime_strategy")
        or candidate.get("strategy_name")
        or candidate.get("strategy")
    )
    if candidate_id == expectations.candidate_id:
        return True
    if hypothesis_id == expectations.hypothesis_id and runtime_strategy in (
        None,
        expectations.runtime_strategy,
    ):
        return True
    return False


def _first_mapping_from_keys(
    source: Mapping[str, object], keys: Sequence[str]
) -> Mapping[str, object]:
    for key in keys:
        candidate = _mapping(source.get(key))
        if candidate:
            return candidate
    return {}


def _first_value_from_keys(
    source: Mapping[str, object], keys: Sequence[str]
) -> object | None:
    for key in keys:
        if key in source:
            return source.get(key)
    return None


def _target_from_source(
    source: Mapping[str, object], expectations: AuditExpectations
) -> Mapping[str, object]:
    target = _first_mapping_from_keys(
        source, ("target", "target_candidate", "target_candidate_identity")
    )
    if target:
        return target
    for key in ("targets", "planned_targets", "target_candidates", "source_targets"):
        sequence = _sequence(source.get(key))
        mappings = [_mapping(item) for item in sequence]
        for candidate in mappings:
            if candidate and _target_matches(candidate, expectations):
                return candidate
        for candidate in mappings:
            if candidate:
                return candidate
    return {}


def _candidate_identity(
    target: Mapping[str, object], expectations: AuditExpectations
) -> dict[str, object]:
    observed = {
        "hypothesis_id": _text(target.get("hypothesis_id") or target.get("hypothesis")),
        "candidate_id": _text(
            target.get("candidate_id") or target.get("target_candidate_id")
        ),
        "account_label": _text(target.get("account_label") or target.get("account")),
        "observed_stage": _text(
            target.get("observed_stage")
            or target.get("stage")
            or target.get("evidence_collection_stage")
        ),
        "runtime_strategy": _text(
            target.get("runtime_strategy_name")
            or target.get("runtime_strategy")
            or target.get("strategy_name")
            or target.get("strategy")
        ),
    }
    expected = {
        "hypothesis_id": expectations.hypothesis_id,
        "candidate_id": expectations.candidate_id,
        "account_label": expectations.account_label,
        "observed_stage": expectations.observed_stage,
        "runtime_strategy": expectations.runtime_strategy,
    }
    matches = {
        key: observed_value == expected[key]
        for key, observed_value in observed.items()
        if observed_value is not None
    }
    missing = sorted(key for key, value in observed.items() if value is None)
    return {
        "materialized": bool(target),
        "expected": expected,
        "observed": observed,
        "matches": matches,
        "missing_fields": missing,
    }


def _symbols_from_target(target: Mapping[str, object]) -> list[str]:
    symbols: list[str] = []
    for key in (
        "symbols",
        "symbol_universe",
        "required_symbols",
        "pair_symbols",
        "paper_route_probe_symbols",
        "legs",
    ):
        raw_value = target.get(key)
        if isinstance(raw_value, Mapping):
            symbols.extend(str(symbol) for symbol in raw_value.keys())
        else:
            for item in _sequence(raw_value):
                if isinstance(item, Mapping):
                    symbol = _text(item.get("symbol") or item.get("ticker"))
                    if symbol is not None:
                        symbols.append(symbol)
                else:
                    symbol = _text(item)
                    if symbol is not None:
                        symbols.append(symbol)
    for key in (
        "symbol",
        "primary_symbol",
        "secondary_symbol",
        "long_symbol",
        "short_symbol",
    ):
        symbol = _text(target.get(key))
        if symbol is not None:
            symbols.append(symbol)
    return _normalize_symbols(symbols)


def _normalize_symbols(symbols: Iterable[str]) -> list[str]:
    seen: set[str] = set()
    normalized: list[str] = []
    for symbol in symbols:
        item = symbol.strip().upper()
        if not item or item in seen:
            continue
        seen.add(item)
        normalized.append(item)
    return sorted(normalized)


def _symbol_payload(container: Mapping[str, object]) -> Mapping[str, object]:
    explicit = _mapping(container.get("symbols"))
    if explicit:
        return explicit
    latest = _mapping(container.get("latest"))
    latest_symbols = _mapping(latest.get("symbols"))
    if latest_symbols:
        return latest_symbols
    by_symbol = _mapping(container.get("by_symbol"))
    if by_symbol:
        return by_symbol
    return {}


def _availability_for_symbol(
    symbol: str,
    payload: Mapping[str, object],
    max_age_seconds: float,
    *,
    quote_mode: bool,
) -> tuple[bool, dict[str, object]]:
    raw = (
        payload.get(symbol)
        or payload.get(symbol.lower())
        or payload.get(symbol.upper())
    )
    details = _mapping(raw)
    ready = _bool_or_none(details.get("ready"))
    for key in _MARKET_DATA_READY_KEYS:
        value = _bool_or_none(details.get(key))
        if value is not None:
            ready = value
            break
    age_seconds = _float_or_none(
        details.get("age_seconds") or details.get("staleness_seconds")
    )
    if ready is None:
        ready = bool(details)
    if quote_mode and details:
        bid = _float_or_none(details.get("bid") or details.get("bid_price"))
        ask = _float_or_none(details.get("ask") or details.get("ask_price"))
        if (
            bid is not None
            and ask is not None
            and (bid <= 0.0 or ask <= 0.0 or bid > ask)
        ):
            ready = False
    if age_seconds is not None and age_seconds > max_age_seconds:
        ready = False
    return ready, {
        "available": bool(details),
        "ready": ready,
        "age_seconds": age_seconds,
        "timestamp": _text(
            details.get("timestamp")
            or details.get("as_of")
            or details.get("updated_at")
        ),
    }


def _availability_report(
    container: Mapping[str, object],
    symbols: Sequence[str],
    *,
    max_age_seconds: float,
    quote_mode: bool,
) -> dict[str, object]:
    payload = _symbol_payload(container)
    available_symbols = _normalize_symbols(str(key) for key in payload.keys())
    evaluated_symbols = list(symbols) or available_symbols
    by_symbol: dict[str, object] = {}
    missing_symbols: list[str] = []
    stale_symbols: list[str] = []
    not_ready_symbols: list[str] = []
    for symbol in evaluated_symbols:
        ready, details = _availability_for_symbol(
            symbol,
            payload,
            max_age_seconds,
            quote_mode=quote_mode,
        )
        by_symbol[symbol] = details
        if not bool(details["available"]):
            missing_symbols.append(symbol)
        elif not ready:
            not_ready_symbols.append(symbol)
            if details.get("age_seconds") is not None:
                stale_symbols.append(symbol)
    return {
        "ready": bool(evaluated_symbols)
        and not missing_symbols
        and not not_ready_symbols,
        "symbols_evaluated": evaluated_symbols,
        "available_symbols": available_symbols,
        "missing_symbols": missing_symbols,
        "stale_symbols": stale_symbols,
        "not_ready_symbols": not_ready_symbols,
        "by_symbol": by_symbol,
        "latest_timestamp": _text(
            container.get("latest_timestamp")
            or container.get("timestamp")
            or _mapping(container.get("latest")).get("timestamp")
        ),
    }


def _signal_threshold_report(signal: Mapping[str, object]) -> dict[str, object]:
    score = _float_or_none(
        signal.get("entry_score")
        or signal.get("score")
        or signal.get("signal")
        or signal.get("entry_signal")
        or signal.get("zscore")
    )
    threshold = _float_or_none(
        signal.get("entry_threshold")
        or signal.get("threshold")
        or signal.get("min_entry_score")
        or signal.get("abs_entry_zscore_threshold")
    )
    margin = None if score is None or threshold is None else abs(score) - threshold
    explicit_pass = _bool_or_none(
        signal.get("passes_threshold")
        or signal.get("threshold_passed")
        or signal.get("entry_signal_ready")
    )
    passes = (
        explicit_pass
        if explicit_pass is not None
        else (None if margin is None else margin >= 0.0)
    )
    return {
        "score": score,
        "threshold": threshold,
        "margin": margin,
        "passes": passes,
        "direction": _text(
            signal.get("direction") or signal.get("side") or signal.get("entry_side")
        ),
        "missing_inputs": [
            key
            for key, value in (("score", score), ("threshold", threshold))
            if value is None and explicit_pass is None
        ],
    }


def _signal_drift_readiness_report(
    *,
    status: Mapping[str, object],
    target: Mapping[str, object],
    signal: Mapping[str, object],
    expectations: AuditExpectations,
) -> dict[str, object]:
    observed = _mapping(status.get("observed"))
    if not observed:
        observed = _mapping(target.get("observed"))
    signal_lag_seconds = _float_or_none(
        _first_value_from_keys(
            observed,
            ("signal_lag_seconds", "signalLagSeconds"),
        )
        or _first_value_from_keys(
            status,
            ("signal_lag_seconds", "signalLagSeconds"),
        )
        or _first_value_from_keys(
            signal,
            ("signal_lag_seconds", "signalLagSeconds", "lag_seconds", "age_seconds"),
        )
    )
    max_signal_lag_seconds = (
        _float_or_none(
            _first_value_from_keys(
                observed,
                ("max_signal_lag_seconds", "maxSignalLagSeconds"),
            )
            or _first_value_from_keys(
                status,
                ("max_signal_lag_seconds", "maxSignalLagSeconds"),
            )
        )
        or expectations.max_signal_lag_seconds
    )
    drift_detection_checks_total = _float_or_none(
        _first_value_from_keys(
            observed,
            (
                "drift_detection_checks_total",
                "driftDetectionChecksTotal",
                "drift_detection_checks",
                "drift_checks",
            ),
        )
        or _first_value_from_keys(
            status,
            (
                "drift_detection_checks_total",
                "driftDetectionChecksTotal",
                "drift_detection_checks",
                "drift_checks",
            ),
        )
    )
    market_session_open = _bool_or_none(
        _first_value_from_keys(observed, ("market_session_open", "marketSessionOpen"))
        or _first_value_from_keys(status, ("market_session_open", "marketSessionOpen"))
    )
    observed_any = any(
        value is not None
        for value in (
            signal_lag_seconds,
            drift_detection_checks_total,
            market_session_open,
        )
    )
    blockers: list[str] = []
    fresh_signal_window: bool | None = None
    if signal_lag_seconds is not None:
        fresh_signal_window = signal_lag_seconds <= max_signal_lag_seconds
        if not fresh_signal_window:
            blockers.append("signal_lag_exceeded")
    if drift_detection_checks_total is not None and drift_detection_checks_total <= 0:
        blockers.append("drift_checks_missing")
    if market_session_open is False:
        blockers.append("market_session_closed")
    return {
        "observed_any": observed_any,
        "signal_lag_seconds": signal_lag_seconds,
        "max_signal_lag_seconds": max_signal_lag_seconds,
        "fresh_signal_window": fresh_signal_window,
        "drift_detection_checks_total": drift_detection_checks_total,
        "drift_checks_present": None
        if drift_detection_checks_total is None
        else drift_detection_checks_total > 0,
        "market_session_open": market_session_open,
        "blockers": sorted(set(blockers)),
        "ready": observed_any and not blockers,
    }


def _runtime_materialization_count(
    containers: Sequence[Mapping[str, object]],
    keys: Sequence[str],
) -> float | None:
    for container in containers:
        value = _first_value_from_keys(container, keys)
        count = _float_or_none(value)
        if count is not None:
            return count
    return None


def _runtime_materialization_report(
    *,
    source: Mapping[str, object],
    status: Mapping[str, object],
    target: Mapping[str, object],
) -> dict[str, object]:
    observed = _mapping(status.get("observed")) or _mapping(source.get("observed"))
    containers = [observed, status, target, source]
    decision_count = _runtime_materialization_count(
        containers,
        (
            "hpairs_decisions",
            "h_pairs_decisions",
            "recent_hpairs_decisions",
            "decision_count",
            "decisions_count",
            "recent_decision_count",
        ),
    )
    order_event_count = _runtime_materialization_count(
        containers,
        (
            "hpairs_order_events",
            "h_pairs_order_events",
            "recent_hpairs_order_events",
            "order_event_count",
            "order_events_count",
            "recent_order_event_count",
        ),
    )
    runtime_bucket_count = _runtime_materialization_count(
        containers,
        (
            "hpairs_runtime_buckets",
            "h_pairs_runtime_buckets",
            "recent_hpairs_runtime_buckets",
            "runtime_bucket_count",
            "runtime_buckets_count",
            "recent_runtime_bucket_count",
        ),
    )
    counts = {
        "decision_count": decision_count,
        "order_event_count": order_event_count,
        "runtime_bucket_count": runtime_bucket_count,
    }
    observed_counts: dict[str, float] = {
        key: value for key, value in counts.items() if value is not None
    }
    zero_fields = sorted(key for key, value in observed_counts.items() if value <= 0)
    return {
        "observed_any": bool(observed_counts),
        "counts": counts,
        "zero_fields": zero_fields,
        "ready": bool(observed_counts) and not zero_fields,
        "window": _text(
            observed.get("window")
            or status.get("window")
            or source.get("window")
            or observed.get("recent_window")
            or status.get("recent_window")
            or source.get("recent_window")
        ),
    }
