from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Literal, cast


from ....models import (
    Strategy,
)
from ....strategies.catalog import extract_catalog_metadata
from ...models import StrategyDecision
from ...runtime_strategy_resolution import strategy_names_from_strategy_id
from .bounded_collection import (
    BOUNDED_PAPER_ROUTE_DEFAULT_CLOSEOUT_BUFFER_MINUTES as _BOUNDED_PAPER_ROUTE_DEFAULT_CLOSEOUT_BUFFER_MINUTES,
    BOUNDED_SIM_COLLECTION_ACCOUNT_LABEL as _BOUNDED_SIM_COLLECTION_ACCOUNT_LABEL,
    BOUNDED_SIM_COLLECTION_LINEAGE_BOOL_KEYS as _BOUNDED_SIM_COLLECTION_LINEAGE_BOOL_KEYS,
    BOUNDED_SIM_COLLECTION_LINEAGE_KEYS as _BOUNDED_SIM_COLLECTION_LINEAGE_KEYS,
    BOUNDED_SIM_COLLECTION_LINEAGE_MAPPING_KEYS as _BOUNDED_SIM_COLLECTION_LINEAGE_MAPPING_KEYS,
    REGULAR_SESSION_MINUTES as _REGULAR_SESSION_MINUTES,
    bounded_sim_collection_authorized as _bounded_sim_collection_authorized,
    bounded_sim_collection_reserves_account as _bounded_sim_collection_reserves_account,
    lineage_target_from_mapping as _lineage_target_from_mapping,
    lineage_target_key as _lineage_target_key,
    lineage_text_values as _lineage_text_values,
    merge_unique_texts as _merge_unique_texts,
    safe_text as _safe_text,
    single_lineage_text as _single_lineage_text,
    target_bool as _target_bool,
    target_has_bounded_sim_collection_source_kind as _target_has_bounded_sim_collection_source_kind,
    target_owns_bounded_sim_collection_account as _target_owns_bounded_sim_collection_account,
    target_runtime_account_matches as _target_runtime_account_matches,
    target_strategy_family_tokens as _target_strategy_family_tokens,
    target_truthy as _target_truthy,
)


def _target_plan_has_active_bounded_sim_collection_owner(
    targets: Sequence[Mapping[str, Any]],
    *,
    account_label: str | None,
    now: datetime,
) -> bool:
    for target in targets:
        if not _target_owns_bounded_sim_collection_account(target):
            continue
        if not _target_runtime_account_matches(target, account_label=account_label):
            continue
        if not _bounded_sim_collection_reserves_account(
            target,
            account_label=account_label,
        ):
            continue
        if _target_active_in_window(target, now):
            return True
    return False


def _target_requires_bounded_sim_collection_gate(target: Mapping[str, Any]) -> bool:
    account_label = _safe_text(target.get("account_label"))
    return (
        _target_owns_bounded_sim_collection_account(target)
        or account_label == _BOUNDED_SIM_COLLECTION_ACCOUNT_LABEL
    )


def _bounded_sim_collection_metadata_from_decision(
    decision: StrategyDecision,
    *,
    account_label: str | None,
    trading_mode: str,
) -> Mapping[str, Any] | None:
    if trading_mode != "paper":
        return None
    for key in (
        "paper_route_target_plan_source_decision",
        "paper_route_target_plan",
        "strategy_signal_paper",
        "paper_route_probe",
        "paper_route_probe_exit",
    ):
        value = decision.params.get(key)
        if not isinstance(value, Mapping):
            continue
        metadata = cast(Mapping[str, Any], value)
        if _bounded_sim_collection_authorized(metadata, account_label=account_label):
            return metadata
    return None


def _target_lookup_names(target: Mapping[str, Any]) -> list[str]:
    names: list[str] = []
    strategy_id = target.get("strategy_id")
    for value in (
        strategy_id,
        target.get("runtime_strategy_name"),
        target.get("strategy_name"),
        target.get("strategy_lookup_names"),
    ):
        _merge_unique_texts(names, _lineage_text_values(value))
    for resolved_name in strategy_names_from_strategy_id(strategy_id):
        _merge_unique_texts(names, [resolved_name])
    return names


def _strategy_lookup_names(strategy: Strategy) -> list[str]:
    names: list[str] = []
    _merge_unique_texts(names, _lineage_text_values(str(strategy.id)))
    _merge_unique_texts(names, _lineage_text_values(strategy.name))

    metadata = extract_catalog_metadata(strategy.description)
    for key in ("strategy_id", "runtime_strategy_name", "strategy_name"):
        _merge_unique_texts(names, _lineage_text_values(metadata.get(key)))
    declared_strategy_id = metadata.get("strategy_id")
    for resolved_name in strategy_names_from_strategy_id(declared_strategy_id):
        _merge_unique_texts(names, [resolved_name])
    return names


def _parse_target_datetime(value: object) -> datetime | None:
    if isinstance(value, datetime):
        parsed = value
    else:
        raw_text = _safe_text(value)
        if raw_text is None:
            return None
        try:
            parsed = datetime.fromisoformat(raw_text.replace("Z", "+00:00"))
        except ValueError:
            return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _mapping_value(value: object) -> Mapping[str, Any] | None:
    if isinstance(value, Mapping):
        return cast(Mapping[str, Any], value)
    return None


def _optional_decimal(value: Any) -> Decimal | None:
    if value is None:
        return None
    try:
        return Decimal(str(value))
    except (ArithmeticError, ValueError):
        return None


def _decimal_from_mapping(
    payload: Mapping[str, Any],
    keys: Sequence[str],
) -> Decimal | None:
    for key in keys:
        value = _optional_decimal(payload.get(key))
        if value is not None:
            return value
    return None


def _text_from_mapping(payload: Mapping[str, Any], keys: Sequence[str]) -> str | None:
    for key in keys:
        value = _safe_text(payload.get(key))
        if value is not None:
            return value
    return None


def _target_metadata_quote_snapshot(
    params: Mapping[str, Any],
    *,
    symbol: str,
) -> Mapping[str, Any] | None:
    normalized_symbol = symbol.strip().upper()
    for metadata_key in (
        "paper_route_target_plan_source_decision",
        "paper_route_target_plan",
        "paper_route_probe",
        "strategy_signal_paper",
    ):
        metadata = _mapping_value(params.get(metadata_key))
        if metadata is None:
            continue
        snapshot = _quote_snapshot_from_mapping(metadata, symbol=normalized_symbol)
        if snapshot is not None:
            return snapshot
    return None


def _quote_snapshot_from_mapping(
    payload: Mapping[str, Any],
    *,
    symbol: str,
) -> Mapping[str, Any] | None:
    for direct_key in (
        "price_snapshot",
        "executable_quote",
        "quote",
        "nbbo",
        "market_snapshot",
    ):
        direct = _mapping_value(payload.get(direct_key))
        if direct is not None and _quote_snapshot_matches_symbol(direct, symbol=symbol):
            return direct

    readiness = _mapping_value(payload.get("source_decision_readiness"))
    if readiness is not None:
        snapshot = _quote_snapshot_from_mapping(readiness, symbol=symbol)
        if snapshot is not None:
            return snapshot

    for symbol_map_key in (
        "paper_route_probe_symbol_quotes",
        "source_symbol_quotes",
        "symbol_quotes",
        "executable_quotes",
        "price_snapshots",
        "latest_quotes",
    ):
        symbol_map = _mapping_value(payload.get(symbol_map_key))
        if symbol_map is None:
            continue
        for raw_symbol, raw_snapshot in symbol_map.items():
            if str(raw_symbol).strip().upper() != symbol:
                continue
            snapshot = _mapping_value(raw_snapshot)
            if snapshot is not None:
                return snapshot
    return None


def _quote_snapshot_matches_symbol(
    snapshot: Mapping[str, Any],
    *,
    symbol: str,
) -> bool:
    snapshot_symbol = _safe_text(snapshot.get("symbol"))
    return snapshot_symbol is None or snapshot_symbol.upper() == symbol


def _snapshot_has_executable_quote(snapshot: Mapping[str, Any]) -> bool:
    bid = _decimal_from_mapping(snapshot, ("bid", "bid_px", "bid_price", "bp"))
    ask = _decimal_from_mapping(snapshot, ("ask", "ask_px", "ask_price", "ap"))
    return bid is not None and ask is not None and bid > 0 and ask >= bid


def _target_probe_window(target: Mapping[str, Any]) -> tuple[datetime, datetime] | None:
    window_start = _parse_target_datetime(
        target.get("paper_route_probe_window_start") or target.get("window_start")
    )
    window_end = _parse_target_datetime(
        target.get("paper_route_probe_window_end") or target.get("window_end")
    )
    if window_start is None or window_end is None or window_end <= window_start:
        return None
    return window_start, window_end


def _target_active_in_window(target: Mapping[str, Any], now: datetime) -> bool:
    window = _target_probe_window(target)
    if window is None:
        return False
    window_start, window_end = window
    return window_start <= now < window_end


def _target_missing_explicit_probe_window(target: Mapping[str, Any]) -> bool:
    return all(
        _safe_text(target.get(key)) is None
        for key in (
            "paper_route_probe_window_start",
            "paper_route_probe_window_end",
            "window_start",
            "window_end",
        )
    )


def _target_probe_action(target: Mapping[str, Any]) -> Literal["buy", "sell"]:
    for key in (
        "paper_route_probe_action",
        "paper_route_probe_side",
        "probe_action",
        "probe_side",
        "action",
        "side",
    ):
        normalized = str(target.get(key) or "").strip().lower()
        if normalized in {"buy", "long"}:
            return "buy"
        if normalized in {"sell", "short"}:
            return "sell"
    return "buy"


def _target_probe_cap(target: Mapping[str, Any]) -> Decimal | None:
    for key in (
        "paper_route_probe_next_session_max_notional",
        "bounded_evidence_collection_max_notional",
        "paper_route_probe_effective_max_notional",
        "paper_route_probe_target_notional",
        "target_notional",
        "max_notional",
    ):
        cap = _optional_decimal(target.get(key))
        if cap is not None and cap > 0:
            return cap
    return None


def _target_probe_exit_minute_after_open(
    target: Mapping[str, Any],
) -> tuple[int | None, bool]:
    for key in ("exit_minute_after_open", "paper_route_probe_exit_minute_after_open"):
        raw_value = target.get(key)
        if raw_value is None:
            exit_minute = None
        elif isinstance(raw_value, str):
            text = raw_value.strip().lower()
            if not text:
                exit_minute = None
            elif text == "close":
                exit_minute = _REGULAR_SESSION_MINUTES
            else:
                try:
                    exit_minute = max(0, int(Decimal(text)))
                except Exception:
                    exit_minute = None
        else:
            try:
                exit_minute = max(0, int(raw_value))
            except (TypeError, ValueError, ArithmeticError):
                exit_minute = None
        if exit_minute is not None:
            return exit_minute, False
    if _target_has_bounded_sim_collection_source_kind(target) and (
        _target_truthy(target.get("bounded_evidence_collection_authorized"))
        or _target_truthy(target.get("paper_probation_authorized"))
        or _target_truthy(target.get("source_collection_authorized"))
    ):
        return (
            max(
                0,
                _REGULAR_SESSION_MINUTES
                - _BOUNDED_PAPER_ROUTE_DEFAULT_CLOSEOUT_BUFFER_MINUTES,
            ),
            True,
        )
    return None, False


def _target_requires_balanced_pair_legs(target: Mapping[str, Any]) -> bool:
    explicit = _target_bool(target.get("paper_route_probe_pair_balance_required"))
    if explicit is not None:
        return explicit
    return any(
        "microbar_cross_sectional_pairs" in token
        for token in _target_strategy_family_tokens(target)
    )


def _normalized_target_symbols(symbols: Sequence[str]) -> list[str]:
    return [symbol.strip().upper() for symbol in symbols if symbol.strip()]


def _action_from_raw_value(value: object) -> Literal["buy", "sell"] | None:
    action = str(value or "").strip().lower()
    if action in {"buy", "long"}:
        return "buy"
    if action in {"sell", "short"}:
        return "sell"
    return None


def _target_probe_actions_from_mapping(
    raw_actions: Mapping[object, object],
    normalized_symbols: Sequence[str],
) -> dict[str, Literal["buy", "sell"]]:
    actions: dict[str, Literal["buy", "sell"]] = {}
    for raw_symbol, raw_action in raw_actions.items():
        symbol = str(raw_symbol).strip().upper()
        action = _action_from_raw_value(raw_action)
        if symbol in normalized_symbols and action is not None:
            actions[symbol] = action
    return actions


def _target_probe_actions_from_sequence(
    raw_actions: Sequence[object],
    normalized_symbols: Sequence[str],
) -> dict[str, Literal["buy", "sell"]]:
    actions: dict[str, Literal["buy", "sell"]] = {}
    for raw_item in raw_actions:
        if not isinstance(raw_item, Mapping):
            continue
        item = cast(Mapping[str, object], raw_item)
        symbol = str(item.get("symbol") or "").strip().upper()
        action = _action_from_raw_value(item.get("action") or item.get("side"))
        if symbol in normalized_symbols and action is not None:
            actions[symbol] = action
    return actions


def _target_probe_declared_actions(
    target: Mapping[str, Any],
    normalized_symbols: Sequence[str],
) -> dict[str, Literal["buy", "sell"]]:
    raw_actions = target.get("paper_route_probe_symbol_actions")
    if isinstance(raw_actions, Mapping):
        return _target_probe_actions_from_mapping(
            cast(Mapping[object, object], raw_actions),
            normalized_symbols,
        )
    if isinstance(raw_actions, Sequence) and not isinstance(
        raw_actions, (str, bytes, bytearray)
    ):
        return _target_probe_actions_from_sequence(
            cast(Sequence[object], raw_actions),
            normalized_symbols,
        )
    return {}


def _seed_action_pair(
    *,
    selection_mode: str,
) -> tuple[Literal["buy", "sell"], Literal["buy", "sell"]]:
    first_action: Literal["buy", "sell"] = (
        "sell" if selection_mode == "reversal" else "buy"
    )
    second_action: Literal["buy", "sell"] = "buy" if first_action == "sell" else "sell"
    return first_action, second_action


def _balance_missing_probe_actions(
    target: Mapping[str, Any],
    actions: dict[str, Literal["buy", "sell"]],
    missing_symbols: Sequence[str],
) -> None:
    selection_mode = str(target.get("selection_mode") or "continuation").strip().lower()
    first_action, second_action = _seed_action_pair(selection_mode=selection_mode)
    buy_count = sum(1 for action in actions.values() if action == "buy")
    sell_count = sum(1 for action in actions.values() if action == "sell")
    balanced_seed_index = 0
    for symbol in missing_symbols:
        if buy_count < sell_count:
            action: Literal["buy", "sell"] = "buy"
        elif sell_count < buy_count:
            action = "sell"
        else:
            action = first_action if balanced_seed_index % 2 == 0 else second_action
            balanced_seed_index += 1
        actions[symbol] = action
        if action == "buy":
            buy_count += 1
        else:
            sell_count += 1


def _target_probe_symbol_actions(
    target: Mapping[str, Any],
    symbols: Sequence[str],
) -> dict[str, Literal["buy", "sell"]]:
    normalized_symbols = _normalized_target_symbols(symbols)
    actions = _target_probe_declared_actions(target, normalized_symbols)
    missing_symbols = [symbol for symbol in normalized_symbols if symbol not in actions]
    if missing_symbols and _target_requires_balanced_pair_legs(target):
        _balance_missing_probe_actions(
            target,
            actions,
            missing_symbols,
        )

    default_action = _target_probe_action(target)
    return {
        symbol: actions.get(symbol, default_action) for symbol in normalized_symbols
    }


def _target_probe_symbol_quantities(
    target: Mapping[str, Any],
    symbols: Sequence[str],
) -> dict[str, Decimal]:
    normalized_symbols = [
        symbol.strip().upper() for symbol in symbols if symbol.strip()
    ]
    quantities: dict[str, Decimal] = {}
    for field in (
        "paper_route_probe_symbol_quantities",
        "target_symbol_quantities",
        "symbol_quantities",
    ):
        raw_quantities = target.get(field)
        if not isinstance(raw_quantities, Mapping):
            continue
        for raw_symbol, raw_quantity in cast(
            Mapping[object, object], raw_quantities
        ).items():
            symbol = str(raw_symbol).strip().upper()
            quantity = _optional_decimal(raw_quantity)
            if symbol in normalized_symbols and quantity is not None and quantity > 0:
                quantities.setdefault(symbol, quantity)
    fallback_quantity = _optional_decimal(
        target.get("paper_route_probe_target_quantity")
    ) or _optional_decimal(target.get("target_quantity"))
    if fallback_quantity is not None and fallback_quantity > 0:
        for symbol in normalized_symbols:
            quantities.setdefault(symbol, fallback_quantity)
    return quantities


@dataclass(frozen=True)
class _TargetProbeQuantityResolution:
    qty: Decimal
    audit: dict[str, Any]
    price_params: dict[str, Any]


def _target_probe_symbol_notional_budget(
    *,
    target: Mapping[str, Any],
    symbol: str,
    symbols: Sequence[str],
    symbol_quantities: Mapping[str, Decimal],
    max_notional: Decimal,
) -> Decimal | None:
    target_notional = _target_probe_cap(target) or max_notional
    if target_notional <= 0 or max_notional <= 0:
        return None
    budget = min(target_notional, max_notional)
    normalized_symbols = [item.strip().upper() for item in symbols if item.strip()]
    if symbol not in normalized_symbols:
        return None
    weights = {
        item: symbol_quantities[item]
        for item in normalized_symbols
        if symbol_quantities.get(item, Decimal("0")) > 0
    }
    if weights:
        total_weight = sum(weights.values(), Decimal("0"))
        if total_weight > 0:
            return budget * (weights.get(symbol, Decimal("0")) / total_weight)
    return budget / Decimal(len(normalized_symbols))


def _quote_snapshot_reference_price(
    snapshot: Mapping[str, Any],
    *,
    action: Literal["buy", "sell", "hold"],
) -> Decimal | None:
    bid = _decimal_from_mapping(snapshot, ("bid", "bid_px", "bid_price", "bp"))
    ask = _decimal_from_mapping(snapshot, ("ask", "ask_px", "ask_price", "ap"))
    price = _decimal_from_mapping(snapshot, ("price", "mid", "mid_price", "midpoint"))
    if action == "buy" and ask is not None and ask > 0:
        return ask
    if action == "sell" and bid is not None and bid > 0:
        return bid
    if bid is not None and ask is not None and bid > 0 and ask >= bid:
        return (bid + ask) / Decimal("2")
    if price is not None and price > 0:
        return price
    return None


def _target_pair_balance_state(
    target: Mapping[str, Any],
    symbol_actions: Mapping[str, Literal["buy", "sell"]],
) -> str:
    if not _target_requires_balanced_pair_legs(target):
        return "not_required"
    buy_count = sum(1 for action in symbol_actions.values() if action == "buy")
    sell_count = sum(1 for action in symbol_actions.values() if action == "sell")
    if buy_count > 0 and buy_count == sell_count:
        return "balanced"
    return "imbalanced"


@dataclass
class _PaperRouteProbeLineageAccumulator:
    candidate_ids: list[str]
    hypothesis_ids: list[str]
    strategy_names: list[str]
    lineage_targets: list[dict[str, str]]
    lineage_target_keys: set[tuple[str | None, str | None, str | None]]
    fallback_source_decision_modes: list[str]
    fallback_profit_proof_values: list[bool]
    collection_lineage: dict[str, Any]


def _new_paper_route_probe_lineage_accumulator() -> _PaperRouteProbeLineageAccumulator:
    return _PaperRouteProbeLineageAccumulator(
        candidate_ids=[],
        hypothesis_ids=[],
        strategy_names=[],
        lineage_targets=[],
        lineage_target_keys=set(),
        fallback_source_decision_modes=[],
        fallback_profit_proof_values=[],
        collection_lineage={},
    )


def _paper_route_probe_lineage_payloads(
    params: Mapping[str, Any],
) -> list[Mapping[str, Any]]:
    payloads: list[Mapping[str, Any]] = [params]
    for key in (
        "paper_route_probe",
        "paper_route_target_plan_source_decision",
        "paper_route_target_plan",
        "paper_route_probe_exit",
        "strategy_signal_paper",
    ):
        value = params.get(key)
        if isinstance(value, Mapping):
            payloads.append(cast(Mapping[str, Any], value))
    return payloads


def _collect_paper_route_probe_identity_lineage(
    accumulator: _PaperRouteProbeLineageAccumulator,
    payload: Mapping[str, Any],
) -> None:
    for key in ("candidate_id", "source_candidate_id", "source_candidate_ids"):
        _merge_unique_texts(
            accumulator.candidate_ids,
            _lineage_text_values(payload.get(key)),
        )
    for key in ("hypothesis_id", "source_hypothesis_id", "source_hypothesis_ids"):
        _merge_unique_texts(
            accumulator.hypothesis_ids,
            _lineage_text_values(payload.get(key)),
        )
    for key in (
        "runtime_strategy_name",
        "source_strategy_name",
        "source_strategy_names",
    ):
        _merge_unique_texts(
            accumulator.strategy_names,
            _lineage_text_values(payload.get(key)),
        )


def _collect_paper_route_probe_fallback_lineage(
    accumulator: _PaperRouteProbeLineageAccumulator,
    payload: Mapping[str, Any],
    *,
    is_root_payload: bool,
) -> None:
    if is_root_payload:
        return
    if mode := _safe_text(payload.get("source_decision_mode")):
        accumulator.fallback_source_decision_modes.append(mode)
    if (eligible := _target_bool(payload.get("profit_proof_eligible"))) is not None:
        accumulator.fallback_profit_proof_values.append(eligible)


def _collect_paper_route_probe_collection_lineage(
    accumulator: _PaperRouteProbeLineageAccumulator,
    payload: Mapping[str, Any],
) -> None:
    collection_lineage = accumulator.collection_lineage
    for key in _BOUNDED_SIM_COLLECTION_LINEAGE_KEYS:
        if key not in collection_lineage and (value := _safe_text(payload.get(key))):
            collection_lineage[key] = value
    for key in _BOUNDED_SIM_COLLECTION_LINEAGE_BOOL_KEYS:
        value = _target_bool(payload.get(key))
        if key not in collection_lineage and value is not None:
            collection_lineage[key] = value
    if "paper_route_probe_symbols" not in collection_lineage:
        symbols = _lineage_text_values(payload.get("paper_route_probe_symbols"))
        if symbols:
            collection_lineage["paper_route_probe_symbols"] = symbols
    for key in _BOUNDED_SIM_COLLECTION_LINEAGE_MAPPING_KEYS:
        value = payload.get(key)
        if key not in collection_lineage and isinstance(value, Mapping):
            collection_lineage[key] = dict(cast(Mapping[str, Any], value))


def _collect_paper_route_probe_lineage_targets(
    accumulator: _PaperRouteProbeLineageAccumulator,
    payload: Mapping[str, Any],
) -> None:
    raw_targets = payload.get("paper_route_probe_lineage_targets")
    if not isinstance(raw_targets, Sequence) or isinstance(
        raw_targets, (str, bytes, bytearray)
    ):
        return
    for raw_target in cast(Sequence[object], raw_targets):
        if not isinstance(raw_target, Mapping):
            continue
        lineage_target = _lineage_target_from_mapping(
            cast(Mapping[str, object], raw_target)
        )
        if not lineage_target:
            continue
        lineage_key = _lineage_target_key(lineage_target)
        if lineage_key not in accumulator.lineage_target_keys:
            accumulator.lineage_target_keys.add(lineage_key)
            accumulator.lineage_targets.append(lineage_target)


def _build_paper_route_probe_lineage(
    accumulator: _PaperRouteProbeLineageAccumulator,
    *,
    source_decision_mode: str | None,
    profit_proof_eligible: bool | None,
) -> dict[str, Any]:
    lineage: dict[str, Any] = {}
    if accumulator.candidate_ids:
        lineage["source_candidate_ids"] = accumulator.candidate_ids
    single_candidate_id = _single_lineage_text(accumulator.candidate_ids)
    if single_candidate_id is not None:
        lineage["candidate_id"] = single_candidate_id
    if accumulator.hypothesis_ids:
        lineage["source_hypothesis_ids"] = accumulator.hypothesis_ids
    single_hypothesis_id = _single_lineage_text(accumulator.hypothesis_ids)
    if single_hypothesis_id is not None:
        lineage["hypothesis_id"] = single_hypothesis_id
    if accumulator.strategy_names:
        lineage["source_strategy_names"] = accumulator.strategy_names
    single_strategy_name = _single_lineage_text(accumulator.strategy_names)
    if single_strategy_name is not None:
        lineage.setdefault("runtime_strategy_name", single_strategy_name)
    if accumulator.lineage_targets:
        lineage["paper_route_probe_lineage_targets"] = accumulator.lineage_targets
    if source_decision_mode:
        lineage["source_decision_mode"] = source_decision_mode
    else:
        unique_modes = list(dict.fromkeys(accumulator.fallback_source_decision_modes))
        if len(unique_modes) == 1:
            lineage["source_decision_mode"] = unique_modes[0]
    if profit_proof_eligible is not None:
        lineage["profit_proof_eligible"] = profit_proof_eligible
    elif accumulator.fallback_profit_proof_values:
        lineage["profit_proof_eligible"] = all(accumulator.fallback_profit_proof_values)
    lineage.update(accumulator.collection_lineage)
    return lineage


def _paper_route_probe_lineage_from_params(params: Mapping[str, Any]) -> dict[str, Any]:
    accumulator = _new_paper_route_probe_lineage_accumulator()
    for payload in _paper_route_probe_lineage_payloads(params):
        _collect_paper_route_probe_identity_lineage(accumulator, payload)
        _collect_paper_route_probe_fallback_lineage(
            accumulator,
            payload,
            is_root_payload=payload is params,
        )
        _collect_paper_route_probe_collection_lineage(accumulator, payload)
        _collect_paper_route_probe_lineage_targets(accumulator, payload)
    return _build_paper_route_probe_lineage(
        accumulator,
        source_decision_mode=_safe_text(params.get("source_decision_mode")),
        profit_proof_eligible=_target_bool(params.get("profit_proof_eligible")),
    )


# Public module boundary aliases.
target_plan_has_active_bounded_sim_collection_owner = (
    _target_plan_has_active_bounded_sim_collection_owner
)
target_requires_bounded_sim_collection_gate = (
    _target_requires_bounded_sim_collection_gate
)
bounded_sim_collection_metadata_from_decision = (
    _bounded_sim_collection_metadata_from_decision
)
target_lookup_names = _target_lookup_names
strategy_lookup_names = _strategy_lookup_names
parse_target_datetime = _parse_target_datetime
mapping_value = _mapping_value
optional_decimal = _optional_decimal
decimal_from_mapping = _decimal_from_mapping
text_from_mapping = _text_from_mapping
target_metadata_quote_snapshot = _target_metadata_quote_snapshot
quote_snapshot_from_mapping = _quote_snapshot_from_mapping
quote_snapshot_matches_symbol = _quote_snapshot_matches_symbol
snapshot_has_executable_quote = _snapshot_has_executable_quote
target_probe_window = _target_probe_window
target_active_in_window = _target_active_in_window
target_missing_explicit_probe_window = _target_missing_explicit_probe_window
target_probe_action = _target_probe_action
target_probe_cap = _target_probe_cap
target_probe_exit_minute_after_open = _target_probe_exit_minute_after_open
target_requires_balanced_pair_legs = _target_requires_balanced_pair_legs
target_probe_symbol_actions = _target_probe_symbol_actions
target_probe_symbol_quantities = _target_probe_symbol_quantities
TargetProbeQuantityResolution = _TargetProbeQuantityResolution
target_probe_symbol_notional_budget = _target_probe_symbol_notional_budget
quote_snapshot_reference_price = _quote_snapshot_reference_price
target_pair_balance_state = _target_pair_balance_state
paper_route_probe_lineage_from_params = _paper_route_probe_lineage_from_params
