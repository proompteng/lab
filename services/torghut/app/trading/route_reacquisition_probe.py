"""Paper-route probe planning for route reacquisition books."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import cast

_PAPER_ROUTE_PROBE_REASONS = {
    "execution_tca_route_universe_empty",
    "execution_tca_route_universe_exclusions_applied",
    "execution_tca_route_universe_incomplete",
    "execution_tca_slippage_guardrail_exceeded",
    "execution_tca_symbol_missing",
    "route_tca_passed_but_dependency_receipts_block_capital",
    "route_tca_avg_abs_slippage_above_guardrail",
    "route_tca_non_authority_source",
    "route_tca_non_authority_source_decision_mode",
    "tca_evidence_stale",
    "stale_quote",
    "missing_executable_quote",
    "missing_bid_ask",
    "missing_bid",
    "missing_ask",
    "spread_bps_exceeded",
    "session_closed",
    "pair_imbalance",
    "missing_target",
    "blocked_submit",
    "missing_close_flatten_handoff",
    "runtime_import_pending",
}
_PAPER_ROUTE_PROBE_STATES = {"blocked", "missing", "probing"}


@dataclass(frozen=True)
class PaperRouteProbeConfig:
    trading_mode: str
    market_session_open: bool | None
    enabled: bool
    allow_live_mode: bool
    max_notional: object | None
    target_symbols: Sequence[object] | None


@dataclass(frozen=True)
class PaperRouteProbePlan:
    configured_limit: str | None
    eligible_symbols: list[str]
    target_symbols: list[str]
    blockers: list[str]
    active: bool
    effective_limit: str
    next_session_limit: str
    active_symbols: list[str]


def paper_route_probe_plan(
    records: Sequence[Mapping[str, object]],
    config: PaperRouteProbeConfig,
) -> PaperRouteProbePlan:
    configured_limit = _positive_amount_text(config.max_notional)
    eligible_symbols = [
        _text(item.get("symbol"))
        for item in records
        if _paper_route_probe_eligible(item)
    ]
    target_symbols = _symbol_list(config.target_symbols)
    for symbol in target_symbols:
        if symbol not in eligible_symbols:
            eligible_symbols.append(symbol)
    blockers = _paper_route_probe_blockers(
        config,
        configured_limit=configured_limit,
        eligible_symbol_count=len(eligible_symbols),
    )
    active = not blockers
    next_session_limit = (
        configured_limit if config.enabled and configured_limit is not None else "0"
    )
    return PaperRouteProbePlan(
        configured_limit=configured_limit,
        eligible_symbols=eligible_symbols,
        target_symbols=target_symbols,
        blockers=blockers,
        active=active,
        effective_limit=configured_limit
        if active and configured_limit is not None
        else "0",
        next_session_limit=next_session_limit,
        active_symbols=eligible_symbols if active else [],
    )


def apply_paper_route_probe(
    records: list[dict[str, object]],
    *,
    config: PaperRouteProbeConfig,
    plan: PaperRouteProbePlan,
) -> None:
    for record in records:
        eligible = _paper_route_probe_eligible(record)
        record["paper_route_probe"] = {
            "eligible": eligible,
            "active": plan.active and eligible,
            "notional_limit": plan.effective_limit if eligible else "0",
            "next_session_notional_limit": plan.next_session_limit if eligible else "0",
            "live_mode_collection_allowed": config.allow_live_mode,
            "blocking_reasons": plan.blockers if eligible else [],
            "capital_authority": "none",
            "promotion_authority": False,
        }


def paper_route_probe_payload(
    *,
    config: PaperRouteProbeConfig,
    plan: PaperRouteProbePlan,
) -> dict[str, object]:
    return {
        "configured_enabled": config.enabled,
        "live_mode_collection_allowed": config.allow_live_mode,
        "configured_max_notional": plan.configured_limit or "0",
        "active": plan.active,
        "effective_max_notional": plan.effective_limit,
        "next_session_max_notional": plan.next_session_limit,
        "eligible_symbol_count": len(plan.eligible_symbols),
        "eligible_symbols": plan.eligible_symbols,
        "active_symbols": plan.active_symbols,
        "blocking_reasons": plan.blockers,
        "capital_authority": "none",
        "promotion_authority": False,
    }


def _text(value: object, default: str = "") -> str:
    if value is None:
        return default
    normalized = str(value).strip()
    return normalized or default


def _float(value: object) -> float | None:
    if isinstance(value, bool):
        return float(value)
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str) and value.strip():
        try:
            return float(value.strip())
        except ValueError:
            return None
    return None


def _positive_amount_text(value: object) -> str | None:
    amount = _float(value)
    if amount is None or amount <= 0:
        return None
    rendered = _text(value)
    return rendered if rendered else str(amount)


def _sequence(value: object) -> list[object]:
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return list(cast(Sequence[object], value))
    return []


def _symbol_list(value: object) -> list[str]:
    symbols: list[str] = []
    values: Sequence[object] = (
        value.split(",") if isinstance(value, str) else _sequence(value)
    )
    for raw_symbol in values:
        symbol = _text(raw_symbol).upper()
        if symbol and symbol not in symbols:
            symbols.append(symbol)
    return symbols


def _paper_route_probe_eligible(record: Mapping[str, object]) -> bool:
    return (
        _text(record.get("state")) in _PAPER_ROUTE_PROBE_STATES
        and _text(record.get("reason")) in _PAPER_ROUTE_PROBE_REASONS
    )


def _paper_route_probe_blockers(
    config: PaperRouteProbeConfig,
    *,
    configured_limit: str | None,
    eligible_symbol_count: int,
) -> list[str]:
    blockers: list[str] = []
    if config.trading_mode == "live":
        if not config.allow_live_mode:
            blockers.append("live_paper_route_probe_collection_disabled")
    elif config.trading_mode != "paper":
        blockers.append("not_paper_mode")
    if not config.enabled:
        blockers.append("paper_route_probe_disabled")
    if configured_limit is None:
        blockers.append("paper_route_probe_max_notional_invalid")
    if config.market_session_open is not True:
        blockers.append(
            "session_closed"
            if config.market_session_open is False
            else "market_session_unknown"
        )
    if eligible_symbol_count <= 0:
        blockers.append("paper_route_probe_candidate_missing")
    return blockers


__all__ = [
    "PaperRouteProbeConfig",
    "PaperRouteProbePlan",
    "apply_paper_route_probe",
    "paper_route_probe_payload",
    "paper_route_probe_plan",
]
