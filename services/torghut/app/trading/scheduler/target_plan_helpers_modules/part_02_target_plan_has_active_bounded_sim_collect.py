# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportPrivateUsage=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false

from __future__ import annotations

import logging
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any, Literal, TypeAlias, cast


from ....config import settings
from ....models import (
    Strategy,
)
from ....strategies.catalog import extract_catalog_metadata
from ...autonomy import DriftThresholds
from ...feature_quality import FeatureQualityThresholds
from ...models import StrategyDecision
from ...runtime_decision_authority import (
    BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE,
    ROUTE_ACQUISITION_SOURCE_DECISION_MODE,
    STRATEGY_SIGNAL_PAPER_SOURCE_DECISION_MODE,
    normalize_source_decision_mode,
)
from ...runtime_strategy_resolution import strategy_names_from_strategy_id
from ...simple_risk import (
    position_qty_for_symbol,
)

# ruff: noqa: F401,F403,F405,F811,F821

from .part_01_statements_32 import *


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
                exit_minute = max(0, int(cast(Any, raw_value)))
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


def _target_strategy_family_tokens(target: Mapping[str, Any]) -> set[str]:
    tokens: set[str] = set()
    for key in (
        "strategy_family",
        "strategy_name",
        "runtime_strategy_name",
        "strategy_id",
        "universe_type",
    ):
        value = _safe_text(target.get(key))
        if value:
            tokens.add(value.strip().lower().replace("-", "_"))
    return tokens


def _target_requires_balanced_pair_legs(target: Mapping[str, Any]) -> bool:
    explicit = _target_bool(target.get("paper_route_probe_pair_balance_required"))
    if explicit is not None:
        return explicit
    return any(
        "microbar_cross_sectional_pairs" in token
        for token in _target_strategy_family_tokens(target)
    )


def _target_probe_symbol_actions(
    target: Mapping[str, Any],
    symbols: Sequence[str],
) -> dict[str, Literal["buy", "sell"]]:
    normalized_symbols = [
        symbol.strip().upper() for symbol in symbols if symbol.strip()
    ]
    actions: dict[str, Literal["buy", "sell"]] = {}
    raw_actions = target.get("paper_route_probe_symbol_actions")
    if isinstance(raw_actions, Mapping):
        for raw_symbol, raw_action in cast(
            Mapping[object, object], raw_actions
        ).items():
            symbol = str(raw_symbol).strip().upper()
            action = str(raw_action or "").strip().lower()
            if symbol in normalized_symbols and action in {"buy", "long"}:
                actions[symbol] = "buy"
            elif symbol in normalized_symbols and action in {"sell", "short"}:
                actions[symbol] = "sell"
    elif isinstance(raw_actions, Sequence) and not isinstance(
        raw_actions, (str, bytes, bytearray)
    ):
        for raw_item in cast(Sequence[object], raw_actions):
            if not isinstance(raw_item, Mapping):
                continue
            item = cast(Mapping[str, object], raw_item)
            symbol = str(item.get("symbol") or "").strip().upper()
            action = str(item.get("action") or item.get("side") or "").strip().lower()
            if symbol in normalized_symbols and action in {"buy", "long"}:
                actions[symbol] = "buy"
            elif symbol in normalized_symbols and action in {"sell", "short"}:
                actions[symbol] = "sell"

    missing_symbols = [symbol for symbol in normalized_symbols if symbol not in actions]
    if missing_symbols and _target_requires_balanced_pair_legs(target):
        selection_mode = (
            str(target.get("selection_mode") or "continuation").strip().lower()
        )
        first_action: Literal["buy", "sell"] = (
            "sell" if selection_mode == "reversal" else "buy"
        )
        second_action: Literal["buy", "sell"] = (
            "buy" if first_action == "sell" else "sell"
        )
        buy_count = sum(1 for action in actions.values() if action == "buy")
        sell_count = sum(1 for action in actions.values() if action == "sell")
        balanced_seed_index = 0
        for symbol in missing_symbols:
            if buy_count < sell_count:
                action = "buy"
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
    action: Literal["buy", "sell"],
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


def _target_truthy(value: object) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, int | float | Decimal):
        return bool(value)
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


def _target_bool(value: object) -> bool | None:
    if isinstance(value, bool):
        return value
    if isinstance(value, int | float | Decimal):
        return bool(value)
    text = str(value or "").strip().lower()
    if text in {"1", "true", "yes", "on"}:
        return True
    if text in {"0", "false", "no", "off"}:
        return False
    return None


def _lineage_text_values(value: object) -> list[str]:
    raw_items: Sequence[object]
    if isinstance(value, str):
        raw_items = value.split(",")
    elif isinstance(value, Sequence) and not isinstance(value, (bytes, bytearray)):
        raw_items = cast(Sequence[object], value)
    else:
        raw_items = (value,)

    values: list[str] = []
    for raw_item in raw_items:
        text = _safe_text(raw_item)
        if text and text not in values:
            values.append(text)
    return values


def _merge_unique_texts(target: list[str], values: Sequence[str]) -> None:
    for value in values:
        if value not in target:
            target.append(value)


def _single_lineage_text(value: object) -> str | None:
    values = _lineage_text_values(value)
    if len(values) != 1:
        return None
    return values[0]


def _paper_route_probe_lineage_from_params(params: Mapping[str, Any]) -> dict[str, Any]:
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

    candidate_ids: list[str] = []
    hypothesis_ids: list[str] = []
    strategy_names: list[str] = []
    lineage_targets: list[dict[str, str]] = []
    lineage_target_keys: set[tuple[str | None, str | None, str | None]] = set()
    source_decision_mode = _safe_text(params.get("source_decision_mode"))
    profit_proof_eligible = _target_bool(params.get("profit_proof_eligible"))
    fallback_source_decision_modes: list[str] = []
    fallback_profit_proof_values: list[bool] = []
    collection_lineage: dict[str, Any] = {}
    for payload in payloads:
        _merge_unique_texts(
            candidate_ids, _lineage_text_values(payload.get("candidate_id"))
        )
        _merge_unique_texts(
            candidate_ids, _lineage_text_values(payload.get("source_candidate_id"))
        )
        _merge_unique_texts(
            candidate_ids, _lineage_text_values(payload.get("source_candidate_ids"))
        )
        _merge_unique_texts(
            hypothesis_ids, _lineage_text_values(payload.get("hypothesis_id"))
        )
        _merge_unique_texts(
            hypothesis_ids, _lineage_text_values(payload.get("source_hypothesis_id"))
        )
        _merge_unique_texts(
            hypothesis_ids, _lineage_text_values(payload.get("source_hypothesis_ids"))
        )
        _merge_unique_texts(
            strategy_names, _lineage_text_values(payload.get("runtime_strategy_name"))
        )
        _merge_unique_texts(
            strategy_names, _lineage_text_values(payload.get("source_strategy_name"))
        )
        _merge_unique_texts(
            strategy_names, _lineage_text_values(payload.get("source_strategy_names"))
        )
        if payload is not params:
            if mode := _safe_text(payload.get("source_decision_mode")):
                fallback_source_decision_modes.append(mode)
            if (
                eligible := _target_bool(payload.get("profit_proof_eligible"))
            ) is not None:
                fallback_profit_proof_values.append(eligible)
        for key in _BOUNDED_SIM_COLLECTION_LINEAGE_KEYS:
            if key not in collection_lineage and (
                value := _safe_text(payload.get(key))
            ):
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

        raw_targets = payload.get("paper_route_probe_lineage_targets")
        if isinstance(raw_targets, Sequence) and not isinstance(
            raw_targets, (str, bytes, bytearray)
        ):
            for raw_target in cast(Sequence[object], raw_targets):
                if not isinstance(raw_target, Mapping):
                    continue
                lineage_target = _lineage_target_from_mapping(
                    cast(Mapping[str, object], raw_target)
                )
                if not lineage_target:
                    continue
                lineage_key = _lineage_target_key(lineage_target)
                if lineage_key not in lineage_target_keys:
                    lineage_target_keys.add(lineage_key)
                    lineage_targets.append(lineage_target)

    lineage: dict[str, Any] = {}
    if candidate_ids:
        lineage["source_candidate_ids"] = candidate_ids
    single_candidate_id = _single_lineage_text(candidate_ids)
    if single_candidate_id is not None:
        lineage["candidate_id"] = single_candidate_id
    if hypothesis_ids:
        lineage["source_hypothesis_ids"] = hypothesis_ids
    single_hypothesis_id = _single_lineage_text(hypothesis_ids)
    if single_hypothesis_id is not None:
        lineage["hypothesis_id"] = single_hypothesis_id
    if strategy_names:
        lineage["source_strategy_names"] = strategy_names
    single_strategy_name = _single_lineage_text(strategy_names)
    if single_strategy_name is not None:
        lineage.setdefault("runtime_strategy_name", single_strategy_name)
    if lineage_targets:
        lineage["paper_route_probe_lineage_targets"] = lineage_targets
    if source_decision_mode:
        lineage["source_decision_mode"] = source_decision_mode
    else:
        unique_modes = list(dict.fromkeys(fallback_source_decision_modes))
        if len(unique_modes) == 1:
            lineage["source_decision_mode"] = unique_modes[0]
    if profit_proof_eligible is not None:
        lineage["profit_proof_eligible"] = profit_proof_eligible
    elif fallback_profit_proof_values:
        lineage["profit_proof_eligible"] = all(fallback_profit_proof_values)
    lineage.update(collection_lineage)
    return lineage


__all__ = [name for name in globals() if not name.startswith("__")]
