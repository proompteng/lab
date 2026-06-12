# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportPrivateUsage=false
#!/usr/bin/env python
"""Read-only H-PAIRS profit proof-gap readback CLI.

The command reads operator-provided endpoint URLs or fixture paths and emits one
machine-readable JSON payload that names the first remaining proof blocker.  It
never writes database rows, calls promotion endpoints, mutates Kubernetes, or
changes runtime configuration.
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Literal, cast

# ruff: noqa: F401,F403,F405,F811,F821

from .part_01_statements_25 import *


def _target_status(
    target_plan: Mapping[str, Any],
    paper_route_evidence: Mapping[str, Any],
    status: Mapping[str, Any],
    *,
    identity: Identity,
) -> dict[str, Any]:
    candidates = (
        _candidate_mappings(target_plan)
        + _candidate_mappings(paper_route_evidence)
        + _candidate_mappings(status)
    )
    matching = [item for item in candidates if _matches_identity(item, identity)]
    selected = matching[0] if matching else {}
    target_count = _int_or_none(target_plan.get("target_count"))
    if target_count is None:
        target_count = len(_candidate_mappings(target_plan))
    return {
        "present": bool(matching),
        "target_count": target_count,
        "matched_target_count": len(matching),
        "selected_target": _compact_mapping(selected),
    }


def _paper_route_status(
    target: Mapping[str, Any], evidence: Mapping[str, Any], status: Mapping[str, Any]
) -> dict[str, Any]:
    selected = _mapping(target.get("selected_target"))
    values = [
        _truthy_route_flag(selected),
        _truthy_route_flag(evidence),
        _truthy_route_flag(status),
        _bool_or_none(
            evidence.get("paper_route_active"),
            evidence.get("route_active"),
            evidence.get("active"),
        ),
    ]
    blockers = _text_list(selected.get("blockers")) + _text_list(
        evidence.get("blockers")
    )
    has_inactive_blocker = any(
        "inactive" in blocker or "disabled" in blocker or "not_eligible" in blocker
        for blocker in blockers
    )
    active = (
        True
        if any(value is True for value in values) and not has_inactive_blocker
        else False
    )
    return {
        "active": active,
        "route_flags": [value for value in values if value is not None],
        "blockers": blockers,
    }


def _source_ref_status(
    proof_packet: Mapping[str, Any],
    source_census: Mapping[str, Any],
    runtime_summary: Mapping[str, Any],
    target_plan: Mapping[str, Any],
    paper_route_evidence: Mapping[str, Any],
    status: Mapping[str, Any],
    *,
    identity: Identity,
) -> dict[str, Any]:
    payloads = _non_empty_payloads(
        proof_packet,
        source_census,
        runtime_summary,
        _mapping(
            _mapping(proof_packet.get("evidence")).get("hpairs_source_proof_census")
        ),
        *_source_observation_payloads(
            (target_plan, paper_route_evidence, status), identity=identity
        ),
    )
    source_refs_present = any(
        _has_positive_key(payload, SOURCE_REF_KEYS) for payload in payloads
    )
    source_windows_present = any(
        _has_positive_key(payload, SOURCE_WINDOW_KEYS) for payload in payloads
    )
    if not source_refs_present:
        source_refs_present = any(
            _source_row_count(payload, "executions") > 0 for payload in payloads
        )
    if not source_windows_present:
        source_windows_present = any(
            _source_row_count(payload, "order_feed_source_windows") > 0
            for payload in payloads
        )
    blockers = _reported_blockers(*payloads)
    source_blockers = _source_missing_blockers(blockers)
    return {
        "source_refs_present": source_refs_present,
        "source_windows_present": source_windows_present,
        "source_ref_count": _first_positive_key_count(payloads, SOURCE_REF_KEYS)
        or _first_int_at_keys(payloads, ("source_ref_count", "source_refs_count"))
        or _first_positive_source_row_count(
            payloads, ("executions", "trade_decisions")
        ),
        "source_window_count": _first_positive_key_count(payloads, SOURCE_WINDOW_KEYS)
        or _first_int_at_keys(payloads, ("source_window_count", "source_windows_count"))
        or _first_positive_source_row_count(payloads, ("order_feed_source_windows",)),
        "blockers": blockers,
        "reported_source_blockers": source_blockers,
    }


def _lifecycle_economics_status(
    proof_packet: Mapping[str, Any],
    source_census: Mapping[str, Any],
    runtime_summary: Mapping[str, Any],
    target_plan: Mapping[str, Any],
    paper_route_evidence: Mapping[str, Any],
    status: Mapping[str, Any],
    *,
    identity: Identity,
) -> dict[str, Any]:
    payloads = _non_empty_payloads(
        proof_packet,
        source_census,
        runtime_summary,
        _mapping(
            _mapping(proof_packet.get("evidence")).get("hpairs_source_proof_census")
        ),
        *_source_observation_payloads(
            (target_plan, paper_route_evidence, status), identity=identity
        ),
    )
    lifecycle = _first_bool_at_keys(payloads, LIFECYCLE_KEYS)
    economics = _first_bool_at_keys(payloads, ECONOMICS_KEYS)
    if lifecycle is None and any(
        _has_order_lifecycle_rows(payload) for payload in payloads
    ):
        lifecycle = True
    if economics is None and any(
        _has_execution_economics_rows(payload) for payload in payloads
    ):
        economics = True
    blockers = _reported_blockers(*payloads)
    if any(
        any(word in blocker for word in LIFECYCLE_ECONOMICS_WORDS)
        for blocker in blockers
    ):
        if any(
            "lifecycle" in blocker or "order_feed" in blocker for blocker in blockers
        ):
            lifecycle = False
        if any("economic" in blocker or "cost" in blocker for blocker in blockers):
            economics = False
    return {
        "lifecycle_complete": lifecycle is True,
        "economics_complete": economics is True,
        "lifecycle_observed": lifecycle,
        "economics_observed": economics,
        "blockers": blockers,
    }


def _proof_authority_status(proof_packet: Mapping[str, Any]) -> dict[str, Any]:
    present = bool(proof_packet)
    proof_mode = _text(proof_packet.get("proof_mode"))
    mode_contract = _mapping(proof_packet.get("proof_mode_contract"))
    final_authority = _bool_or_none(
        proof_packet.get("final_authority"),
        _mapping(proof_packet.get("target")).get("final_authority"),
        mode_contract.get("final_authority"),
    )
    final_authority_ok = _bool_or_none(
        proof_packet.get("final_authority_ok"),
        _mapping(proof_packet.get("post_cost_proof_authority")).get("allowed"),
    )
    promotion_allowed = _bool_or_none(
        proof_packet.get("promotion_allowed"),
        proof_packet.get("capital_promotion_allowed"),
        proof_packet.get("final_promotion_allowed"),
    )
    return {
        "present": present,
        "proof_mode": proof_mode,
        "authority_mode": proof_mode == "authority",
        "final_authority": final_authority,
        "final_authority_ok": final_authority_ok,
        "promotion_allowed": promotion_allowed,
        "ambiguous": not present or not proof_mode or final_authority is None,
    }


def _numeric_readback(
    proof_packet: Mapping[str, Any],
    source_census: Mapping[str, Any],
    runtime_summary: Mapping[str, Any],
) -> NumericReadback:
    payloads = _non_empty_payloads(
        runtime_summary,
        proof_packet,
        source_census,
        _mapping(
            _mapping(proof_packet.get("evidence")).get("completion_live_scale")
        ).get("runtime_ledger_summary"),
        _mapping(proof_packet.get("aggregate")),
        _mapping(proof_packet.get("target")),
    )
    daily = tuple(_daily_net_pnls(payloads))
    trading_days = _first_int_at_keys(
        payloads, ("trading_days", "trading_day_count", "clean_authority_trading_days")
    )
    if trading_days is None and daily:
        trading_days = len(daily)
    mean = _first_decimal_at_keys(
        payloads, ("mean_daily_net_pnl_after_costs", "mean_net_pnl_after_costs")
    )
    median = _first_decimal_at_keys(
        payloads, ("median_daily_net_pnl_after_costs", "median_net_pnl_after_costs")
    )
    worst = _first_decimal_at_keys(
        payloads, ("worst_daily_net_pnl_after_costs", "worst_day_net_pnl_after_costs")
    )
    if daily:
        mean = mean if mean is not None else sum(daily) / Decimal(len(daily))
        median = (
            median if median is not None else Decimal(str(statistics.median(daily)))
        )
        worst = worst if worst is not None else min(daily)
    return NumericReadback(
        trading_days=trading_days,
        daily_net_pnl_after_costs=daily,
        mean_daily_net_pnl_after_costs=mean,
        median_daily_net_pnl_after_costs=median,
        worst_daily_net_pnl_after_costs=worst,
        filled_notional=_first_decimal_at_keys(payloads, FILLED_NOTIONAL_KEYS),
        closed_trades=_first_int_at_keys(payloads, CLOSED_TRADES_KEYS),
        open_positions=_first_int_at_keys(payloads, OPEN_POSITIONS_KEYS),
        max_drawdown_pct_equity=_first_decimal_at_keys(
            payloads, ("max_drawdown_pct_equity", "drawdown_pct_equity", "max_drawdown")
        ),
        best_day_share=_first_decimal_at_keys(
            payloads, ("best_day_share", "max_best_day_share")
        ),
        symbol_concentration_share=_first_decimal_at_keys(
            payloads, ("symbol_concentration_share", "max_symbol_concentration_share")
        ),
    )


def _numeric_blockers(
    numeric: NumericReadback,
    *,
    min_trading_days: int,
    min_daily_net_pnl_after_costs: Decimal,
    min_filled_notional: Decimal,
    min_closed_trades: int,
) -> list[str]:
    blockers: list[str] = []
    if numeric.daily_net_pnl_after_costs and min(numeric.daily_net_pnl_after_costs) < 0:
        blockers.append("daily_net_pnl_negative")
    if (
        numeric.mean_daily_net_pnl_after_costs is not None
        and numeric.mean_daily_net_pnl_after_costs < 0
    ):
        blockers.append("mean_daily_net_pnl_negative")
    if numeric.trading_days is None or numeric.trading_days < min_trading_days:
        blockers.append("insufficient_trading_days")
    for name, value in (
        ("mean_daily_net_pnl_after_costs", numeric.mean_daily_net_pnl_after_costs),
        ("median_daily_net_pnl_after_costs", numeric.median_daily_net_pnl_after_costs),
        ("worst_daily_net_pnl_after_costs", numeric.worst_daily_net_pnl_after_costs),
    ):
        if value is None:
            blockers.append(f"{name}_missing")
        elif value < min_daily_net_pnl_after_costs:
            blockers.append(f"{name}_below_threshold")
    if numeric.filled_notional is None or numeric.filled_notional < min_filled_notional:
        blockers.append("filled_notional_missing_or_below_threshold")
    if numeric.closed_trades is None or numeric.closed_trades < min_closed_trades:
        blockers.append("closed_trades_missing_or_below_threshold")
    if numeric.open_positions is None:
        blockers.append("open_positions_missing")
    elif numeric.open_positions > 0:
        blockers.append("open_positions_block_authority")
    return blockers


def _classify_blocker_stage(
    *,
    sources: Mapping[EndpointName, LoadedSource],
    rollout: Mapping[str, Any],
    target: Mapping[str, Any],
    route: Mapping[str, Any],
    source_status: Mapping[str, Any],
    lifecycle_economics: Mapping[str, Any],
    proof_authority: Mapping[str, Any],
    numeric: NumericReadback,
    min_trading_days: int,
    min_daily_net_pnl_after_costs: Decimal,
    reported_blockers: Sequence[str],
) -> BlockerStage:
    if (
        any(not sources[name].present for name in ("readyz", "trading_status"))
        or rollout.get("drift_detected") is True
    ):
        return "rollout_drift"
    if (
        any(not sources[name].present for name in ("paper_route_target_plan",))
        or target.get("present") is not True
    ):
        return "target_plan_missing"
    if (
        any(not sources[name].present for name in ("paper_route_evidence",))
        or route.get("active") is not True
    ):
        return "paper_route_inactive"
    if (
        source_status.get("source_refs_present") is not True
        or source_status.get("source_windows_present") is not True
    ):
        return "source_refs_missing"
    if (
        lifecycle_economics.get("lifecycle_complete") is not True
        or lifecycle_economics.get("economics_complete") is not True
    ):
        return "lifecycle_economics_blocked"
    if (
        proof_authority.get("authority_mode") is not True
        or proof_authority.get("final_authority") is not True
    ):
        return "proof_mode_not_authority"
    if _has_negative_pnl(numeric):
        return "negative_pnl"
    if numeric.trading_days is None or numeric.trading_days < min_trading_days:
        return "insufficient_days"
    if _has_insufficient_daily_pnl(numeric, min_daily_net_pnl_after_costs):
        return "insufficient_daily_pnl"
    if _has_concentration_or_drawdown_blocker(numeric, reported_blockers):
        return "concentration_or_drawdown_blocked"
    return "no_authority_blocker_detected"


def _has_negative_pnl(numeric: NumericReadback) -> bool:
    values = list(numeric.daily_net_pnl_after_costs)
    for value in (
        numeric.mean_daily_net_pnl_after_costs,
        numeric.median_daily_net_pnl_after_costs,
        numeric.worst_daily_net_pnl_after_costs,
    ):
        if value is not None:
            values.append(value)
    return any(value < 0 for value in values)


def _has_insufficient_daily_pnl(numeric: NumericReadback, threshold: Decimal) -> bool:
    values = (
        numeric.mean_daily_net_pnl_after_costs,
        numeric.median_daily_net_pnl_after_costs,
        numeric.worst_daily_net_pnl_after_costs,
    )
    return any(value is None or value < threshold for value in values)


def _has_concentration_or_drawdown_blocker(
    numeric: NumericReadback, blockers: Sequence[str]
) -> bool:
    if any(
        any(word in blocker for word in CONCENTRATION_DRAWDOWN_WORDS)
        for blocker in blockers
    ):
        return True
    for value in (
        numeric.max_drawdown_pct_equity,
        numeric.best_day_share,
        numeric.symbol_concentration_share,
    ):
        if value is not None and value > 0:
            return True
    return False


def _classification_semantics() -> dict[str, str]:
    return {
        "rollout_drift": "A required rollout/status source is unreadable or readyz/status/proof revisions disagree.",
        "target_plan_missing": "No matching H-PAIRS target is present in the configured target-plan/evidence/status sources.",
        "paper_route_inactive": "The matching target exists but paper-route activity/eligibility is false, blocked, or ambiguous.",
        "source_refs_missing": "Runtime/source proof lacks source references or source-window evidence, or reports source-only blockers.",
        "lifecycle_economics_blocked": "Order-feed lifecycle or execution economics/cost evidence is incomplete or blocked.",
        "proof_mode_not_authority": "The proof packet is missing, ambiguous, or not explicit final authority mode.",
        "negative_pnl": "Observed post-cost daily/mean/median/worst PnL is negative.",
        "insufficient_days": "Authority-mode proof exists, but trading-day count is below the configured floor.",
        "insufficient_daily_pnl": "Authority-mode proof exists, but mean/median/worst post-cost daily PnL is missing or below threshold.",
        "concentration_or_drawdown_blocked": "Authority-mode proof exists, but concentration/drawdown evidence reports blockers.",
        "no_authority_blocker_detected": "No readback blocker was detected from the supplied read-only sources; this is not a promotion action.",
    }


def _candidate_mappings(payload: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    candidates: list[Mapping[str, Any]] = []
    stack: list[Any] = [payload]
    while stack:
        item = stack.pop()
        if isinstance(item, Mapping):
            mapping = cast(Mapping[str, Any], item)
            if _looks_like_candidate(mapping):
                candidates.append(mapping)
            for key, value in mapping.items():
                if key in TARGET_COLLECTION_KEYS or isinstance(
                    value, (Mapping, list, tuple)
                ):
                    stack.append(value)
        elif isinstance(item, (list, tuple)):
            stack.extend(item)
    return candidates


def _source_collection_readback(
    target_plan: Mapping[str, Any],
    paper_route_evidence: Mapping[str, Any],
    status: Mapping[str, Any],
    *,
    identity: Identity,
) -> dict[str, Any]:
    observations = _source_observation_payloads(
        (target_plan, paper_route_evidence, status), identity=identity
    )
    selected = _best_source_observation(observations)
    profit_target = _best_profit_target_source_observation(observations)
    source_refs_present = bool(selected) and (
        _has_positive_key(selected, SOURCE_REF_KEYS)
        or _source_row_count(selected, "executions") > 0
        or _source_row_count(selected, "trade_decisions") > 0
    )
    source_windows_present = bool(selected) and (
        _has_positive_key(selected, SOURCE_WINDOW_KEYS)
        or _source_row_count(selected, "order_feed_source_windows") > 0
    )
    return {
        "present": bool(observations),
        "matched_observation_count": len(observations),
        "source_refs_present": source_refs_present,
        "source_windows_present": source_windows_present,
        "lifecycle_observed": _has_order_lifecycle_rows(selected),
        "economics_observed": _has_execution_economics_rows(selected),
        "selected_observation": _compact_source_observation(selected),
        "profit_target_present": bool(profit_target),
        "profit_target_source_refs_present": bool(profit_target)
        and _source_ref_observation_count(profit_target) > 0,
        "profit_target_source_windows_present": bool(profit_target)
        and _source_window_observation_count(profit_target) > 0,
        "profit_target_observation": _compact_source_observation(profit_target),
    }


def _source_observation_payloads(
    payloads: Iterable[Mapping[str, Any]], *, identity: Identity
) -> tuple[Mapping[str, Any], ...]:
    observations: list[Mapping[str, Any]] = []
    seen: set[int] = set()
    for payload in payloads:
        for candidate in _candidate_mappings(payload):
            if not _matches_source_identity(candidate, identity):
                continue
            if not _looks_like_source_observation(candidate):
                continue
            for item in (candidate, _mapping(candidate.get("runtime_ledger_bucket"))):
                if not item:
                    continue
                marker = id(item)
                if marker not in seen:
                    observations.append(item)
                    seen.add(marker)
    return tuple(observations)


def _best_source_observation(
    observations: Sequence[Mapping[str, Any]],
) -> Mapping[str, Any]:
    if not observations:
        return {}

    def rank(
        item: Mapping[str, Any],
    ) -> tuple[int, int, int, int, int, int, Decimal, int]:
        net = _decimal(
            item.get("source_collection_net_strategy_pnl_after_costs")
            or item.get("net_strategy_pnl_after_costs")
        )
        source_ref_count = _source_ref_observation_count(item)
        source_window_count = _source_window_observation_count(item)
        lifecycle_count = 1 if _has_order_lifecycle_rows(item) else 0
        economics_count = 1 if _has_execution_economics_rows(item) else 0
        return (
            1 if source_ref_count > 0 else 0,
            1 if source_window_count > 0 else 0,
            lifecycle_count,
            economics_count,
            source_ref_count + source_window_count,
            1
            if _bool_or_none(item.get("source_collection_profit_target_candidate"))
            else 0,
            net if net is not None else Decimal("-Infinity"),
            _source_row_count(item, "executions")
            + _source_row_count(item, "execution_order_events")
            + _source_row_count(item, "order_feed_source_windows"),
        )

    return max(observations, key=rank)


def _best_profit_target_source_observation(
    observations: Sequence[Mapping[str, Any]],
) -> Mapping[str, Any]:
    profit_targets = [
        item
        for item in observations
        if _looks_like_profit_target_source_observation(item)
    ]
    if not profit_targets:
        return {}
    return max(profit_targets, key=_profit_target_source_observation_rank)


def _looks_like_profit_target_source_observation(mapping: Mapping[str, Any]) -> bool:
    if _bool_or_none(mapping.get("source_collection_profit_target_candidate")) is True:
        return True
    next_action = _text(mapping.get("source_collection_next_action"))
    if next_action == "materialize_runtime_ledger_source_window_refs":
        return True
    net = _decimal(mapping.get("source_collection_net_strategy_pnl_after_costs"))
    return (
        net is not None
        and net >= Decimal("500")
        and _decimal(mapping.get("source_collection_filled_notional")) is not None
    )


def _profit_target_source_observation_rank(
    item: Mapping[str, Any],
) -> tuple[int, int, int, Decimal, int]:
    net = _decimal(item.get("source_collection_net_strategy_pnl_after_costs"))
    return (
        1 if _source_ref_observation_count(item) > 0 else 0,
        1 if _source_window_observation_count(item) > 0 else 0,
        1
        if _bool_or_none(item.get("source_collection_profit_target_candidate"))
        else 0,
        net if net is not None else Decimal("-Infinity"),
        _source_ref_observation_count(item) + _source_window_observation_count(item),
    )


def _matches_source_identity(mapping: Mapping[str, Any], identity: Identity) -> bool:
    hypothesis = _text(mapping.get("hypothesis_id"))
    candidate = _text(mapping.get("candidate_id"))
    account = _text(mapping.get("account_label")) or _text(
        mapping.get("alpaca_account_label")
    )
    if candidate and candidate == identity.candidate_id:
        return (not hypothesis or hypothesis == identity.hypothesis_id) and (
            not account or account == identity.account_label
        )
    return _matches_identity(mapping, identity)


def _looks_like_source_observation(mapping: Mapping[str, Any]) -> bool:
    if any(key in mapping for key in SOURCE_REF_KEYS + SOURCE_WINDOW_KEYS):
        return True
    if _mapping(mapping.get("source_row_counts")):
        return True
    if _mapping(mapping.get("runtime_ledger_bucket")):
        return True
    return any(
        key in mapping
        for key in (
            "source_collection_net_strategy_pnl_after_costs",
            "net_strategy_pnl_after_costs",
            "source_collection_filled_notional",
            "closed_trade_count",
            "open_position_count",
        )
    )


def _compact_source_observation(payload: Mapping[str, Any]) -> dict[str, Any]:
    if not payload:
        return {}
    keys = (
        "hypothesis_id",
        "candidate_id",
        "strategy_name",
        "runtime_strategy_name",
        "account_label",
        "source_kind",
        "source_collection_profit_target_candidate",
        "source_collection_net_strategy_pnl_after_costs",
        "source_collection_filled_notional",
        "source_collection_post_cost_expectancy_bps",
        "net_strategy_pnl_after_costs",
        "filled_notional",
        "closed_trade_count",
        "open_position_count",
        "target_notional",
        "max_notional",
        "window_start",
        "window_end",
        "bucket_started_at",
        "bucket_ended_at",
        "source_window_start",
        "source_window_end",
        "source_collection_next_action",
    )
    compact = {key: payload[key] for key in keys if key in payload}
    if "source_refs" in payload:
        compact["source_ref_count"] = len(_text_list(payload.get("source_refs")))
    if "source_window_ids" in payload:
        compact["source_window_count"] = len(
            _text_list(payload.get("source_window_ids"))
        )
    source_rows = _mapping(payload.get("source_row_counts"))
    if source_rows:
        compact["source_row_counts"] = dict(source_rows)
    blockers = _reported_blockers(payload)
    if blockers:
        compact["blockers"] = blockers
    return compact


def _looks_like_candidate(mapping: Mapping[str, Any]) -> bool:
    return any(
        key in mapping
        for key in (
            "hypothesis_id",
            "candidate_id",
            "runtime_strategy_name",
            "strategy_name",
        )
    )


def _matches_identity(mapping: Mapping[str, Any], identity: Identity) -> bool:
    hypothesis = _text(mapping.get("hypothesis_id"))
    candidate = _text(mapping.get("candidate_id"))
    strategy = _text(mapping.get("runtime_strategy_name")) or _text(
        mapping.get("strategy_name")
    )
    account = _text(mapping.get("account_label")) or _text(
        mapping.get("alpaca_account_label")
    )
    checks = [
        not hypothesis or hypothesis == identity.hypothesis_id,
        not candidate or candidate == identity.candidate_id,
        not strategy or strategy == identity.runtime_strategy_name,
        not account or account == identity.account_label,
    ]
    return any((hypothesis, candidate, strategy)) and all(checks)


def _truthy_route_flag(payload: Mapping[str, Any]) -> bool | None:
    values: list[bool] = []
    for key, value in _walk_items(payload):
        lowered = key.lower()
        if any(
            token in lowered
            for token in (
                "route_enabled",
                "route_eligible",
                "paper_route",
                "submit_enabled",
                "active",
            )
        ):
            parsed = _bool_or_none(value)
            if parsed is not None:
                values.append(parsed)
    if not values:
        return None
    return any(values)


def _source_row_count(payload: Mapping[str, Any], key: str) -> int:
    value = _mapping(payload.get("source_row_counts")).get(key)
    parsed = _int_or_none(value)
    return parsed if parsed is not None else 0


__all__ = [name for name in globals() if not name.startswith("__")]
