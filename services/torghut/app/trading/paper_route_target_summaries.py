"""Paper-route target summary helpers."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from decimal import Decimal
from typing import cast

from .proofs.targets import text_value


def paper_route_target_summaries(
    targets: Sequence[Mapping[str, object]],
) -> list[dict[str, object]]:
    summaries: list[dict[str, object]] = []
    for item in targets:
        target = _nested_target(item)
        symbol_actions = _string_mapping(target.get("paper_route_probe_symbol_actions"))
        symbols = _symbols(target, symbol_actions)
        target_notional = text_value(target.get("target_notional")) or "0"
        bounded_notional = _target_capacity_notional(target)
        symbol_quantities = _symbol_quantities(target)
        symbol_quantity_source = text_value(
            target.get("paper_route_probe_symbol_quantity_source")
        )
        if not symbol_quantities and bounded_notional > 0 and symbols:
            symbol_quantities = {symbol: "1" for symbol in symbols}
            symbol_quantity_source = "target_notional_runtime_sizing_seed"
        summaries.append(
            {
                "hypothesis_id": text_value(target.get("hypothesis_id")),
                "candidate_id": text_value(target.get("candidate_id")),
                "strategy_family": text_value(target.get("strategy_family")),
                "strategy_name": text_value(target.get("strategy_name")),
                "runtime_strategy_name": text_value(
                    target.get("runtime_strategy_name")
                ),
                "runtime_strategy_id": text_value(target.get("runtime_strategy_name"))
                or text_value(target.get("strategy_name")),
                "account_label": text_value(target.get("account_label")),
                "source_kind": text_value(target.get("source_kind")),
                "symbols": symbols,
                "symbol_actions": symbol_actions,
                "symbol_quantities": symbol_quantities,
                "symbol_quantity_source": symbol_quantity_source,
                "pair_balance_required": bool(
                    target.get("paper_route_probe_pair_balance_required")
                ),
                "pair_balance_state": text_value(
                    target.get("paper_route_probe_pair_balance_state")
                )
                or "not_required",
                "session_start": text_value(target.get("window_start")),
                "session_end": text_value(target.get("window_end")),
                "next_session_max_notional": text_value(
                    target.get("paper_route_probe_next_session_max_notional")
                )
                or "0",
                "target_notional": target_notional,
                "bounded_paper_collection_notional": _decimal_text(bounded_notional),
                "capital_promotion_max_notional": text_value(target.get("max_notional"))
                or "0",
                "bounded_evidence_collection_authorized": bool(
                    target.get("bounded_evidence_collection_authorized")
                ),
                "evidence_collection_ok": bool(target.get("evidence_collection_ok")),
                "canary_collection_authorized": bool(
                    target.get("canary_collection_authorized")
                ),
                "bounded_evidence_collection_max_notional": text_value(
                    target.get("bounded_evidence_collection_max_notional")
                )
                or "0",
                "promotion_allowed": False,
                "final_promotion_allowed": False,
                "promotion_blocked": True,
                "source_decision_ready": bool(
                    _mapping(target.get("source_decision_readiness")).get("ready")
                ),
                "execution_readiness": {
                    "state": text_value(
                        _mapping(
                            target.get("paper_route_execution_readiness_contract")
                        ).get("state")
                    ),
                    "next_action": text_value(
                        _mapping(
                            target.get("paper_route_execution_readiness_contract")
                        ).get("next_action")
                    ),
                    "proof_boundary": "runtime_window_proofs",
                },
            }
        )
    return summaries


def _nested_target(item: Mapping[str, object]) -> Mapping[str, object]:
    nested = _mapping(item.get("target"))
    return nested if nested else item


def _mapping(value: object) -> dict[str, object]:
    if not isinstance(value, Mapping):
        return {}
    return {
        str(key): item for key, item in cast(Mapping[object, object], value).items()
    }


def _string_mapping(value: object) -> dict[str, str]:
    return {
        str(key).strip().upper(): str(item or "").strip()
        for key, item in _mapping(value).items()
        if str(key).strip() and str(item or "").strip()
    }


def _symbol_quantities(target: Mapping[str, object]) -> dict[str, str]:
    for key in (
        "paper_route_probe_symbol_quantities",
        "target_symbol_quantities",
        "symbol_quantities",
    ):
        quantities = _string_mapping(target.get(key))
        if quantities:
            return quantities
    return {}


def _target_capacity_notional(target: Mapping[str, object]) -> Decimal:
    for key in (
        "target_notional",
        "paper_route_probe_target_notional",
        "paper_route_probe_effective_max_notional",
        "bounded_evidence_collection_max_notional",
        "paper_route_probe_next_session_max_notional",
        "max_notional",
    ):
        try:
            amount = Decimal(str(target.get(key) or "0"))
        except Exception:
            continue
        if amount > 0:
            return amount
    return Decimal("0")


def _decimal_text(value: Decimal) -> str:
    normalized = value.normalize()
    return format(normalized, "f")


def _symbols(target: Mapping[str, object], actions: Mapping[str, str]) -> list[str]:
    symbols: set[str] = set(actions)
    for key in ("paper_route_probe_symbols", "symbols", "target_symbols"):
        raw = target.get(key)
        if isinstance(raw, str):
            values: Sequence[object] = raw.split(",")
        elif isinstance(raw, Sequence) and not isinstance(raw, (bytes, bytearray)):
            values = cast(Sequence[object], raw)
        else:
            continue
        symbols.update(
            str(item).strip().upper() for item in values if str(item).strip()
        )
    return sorted(symbols)


_next_paper_route_target_summaries = paper_route_target_summaries
