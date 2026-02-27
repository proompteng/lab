"""Simulation-mode metadata helpers."""

from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime
from typing import Any, cast

from ..config import settings


def _coerce_context_mapping(value: Any) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        return {}
    typed_value = cast(Mapping[object, Any], value)
    return {str(key): item for key, item in typed_value.items()}


def simulation_context_enabled() -> bool:
    return settings.trading_simulation_enabled


def resolve_simulation_context(
    *,
    signal: Any | None = None,
    source: Mapping[str, Any] | None = None,
    decision_id: str | None = None,
    decision_hash: str | None = None,
) -> dict[str, Any] | None:
    """Build normalized simulation context from runtime settings + signal metadata."""

    context: dict[str, Any] = {}
    if source is not None:
        context.update(_coerce_context_mapping(source))

    if signal is not None:
        symbol = getattr(signal, "symbol", None)
        if symbol is not None and context.get("symbol") in (None, ""):
            context["symbol"] = str(symbol).strip().upper()

        event_ts = getattr(signal, "event_ts", None)
        if isinstance(event_ts, datetime) and context.get("signal_event_ts") is None:
            context["signal_event_ts"] = event_ts.isoformat()

        seq = getattr(signal, "seq", None)
        if seq is not None and context.get("signal_seq") is None:
            context["signal_seq"] = int(seq)

    run_id = settings.trading_simulation_run_id
    if run_id and context.get("simulation_run_id") in (None, ""):
        context["simulation_run_id"] = run_id

    dataset_id = settings.trading_simulation_dataset_id
    if dataset_id and context.get("dataset_id") in (None, ""):
        context["dataset_id"] = dataset_id

    if decision_id and context.get("decision_id") in (None, ""):
        context["decision_id"] = decision_id
    if decision_hash and context.get("decision_hash") in (None, ""):
        context["decision_hash"] = decision_hash

    if context:
        return context
    if simulation_context_enabled():
        return {
            "simulation_run_id": run_id or "simulation",
            "dataset_id": dataset_id or "unknown",
        }
    return None


__all__ = ["resolve_simulation_context", "simulation_context_enabled"]
