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
from .part_02_target_plan_has_active_bounded_sim_collect import *


def _paper_route_probe_entry_metadata(
    params: Mapping[str, Any],
) -> Mapping[str, Any] | None:
    metadata = params.get("paper_route_probe")
    if not isinstance(metadata, Mapping):
        return None

    source_decision_mode = normalize_source_decision_mode(
        params.get("source_decision_mode")
    )
    if source_decision_mode == STRATEGY_SIGNAL_PAPER_SOURCE_DECISION_MODE:
        return None
    if _target_bool(params.get("profit_proof_eligible")) is True:
        return None

    probe_metadata = cast(Mapping[str, Any], metadata)
    probe_source_decision_mode = normalize_source_decision_mode(
        probe_metadata.get("source_decision_mode")
    )
    if (
        probe_source_decision_mode is not None
        and probe_source_decision_mode != ROUTE_ACQUISITION_SOURCE_DECISION_MODE
    ):
        return None
    if _target_bool(probe_metadata.get("profit_proof_eligible")) is True:
        return None
    return probe_metadata


def _target_notional_sizing_audit_from_params(
    params: Mapping[str, Any],
) -> Mapping[str, Any] | None:
    direct = _mapping_value(params.get("paper_route_target_notional_sizing"))
    if (
        direct is not None
        and _safe_text(direct.get("sizing_source")) == "target_notional"
    ):
        return direct
    for key in (
        "paper_route_target_plan_source_decision",
        "paper_route_target_plan",
        "paper_route_probe",
        "simple_lane",
    ):
        metadata = _mapping_value(params.get(key))
        if metadata is None:
            continue
        audit = _mapping_value(metadata.get("paper_route_target_notional_sizing"))
        if (
            audit is not None
            and _safe_text(audit.get("sizing_source")) == "target_notional"
        ):
            return audit
    return None


def _bounded_collection_decision_requires_target_notional_sizing(
    params: Mapping[str, Any],
) -> bool:
    source_decision_mode = normalize_source_decision_mode(
        params.get("source_decision_mode")
    )
    return (
        source_decision_mode == BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE
        and _target_bool(params.get("profit_proof_eligible")) is True
    )


def _bounded_paper_route_collection_entry_metadata(
    params: Mapping[str, Any],
) -> Mapping[str, Any] | None:
    for key in (
        "paper_route_probe",
        "paper_route_target_plan_source_decision",
        "paper_route_target_plan",
    ):
        metadata = params.get(key)
        if not isinstance(metadata, Mapping):
            continue
        probe_metadata = cast(Mapping[str, Any], metadata)
        source_decision_mode = normalize_source_decision_mode(
            params.get("source_decision_mode")
        ) or normalize_source_decision_mode(probe_metadata.get("source_decision_mode"))
        if source_decision_mode != BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE:
            continue
        if not (
            _target_bool(params.get("profit_proof_eligible")) is True
            or _target_bool(probe_metadata.get("profit_proof_eligible")) is True
        ):
            continue
        return probe_metadata
    return None


def _strategy_signal_paper_entry_metadata(
    params: Mapping[str, Any],
) -> Mapping[str, Any] | None:
    source_decision_mode = normalize_source_decision_mode(
        params.get("source_decision_mode")
    )
    if source_decision_mode != STRATEGY_SIGNAL_PAPER_SOURCE_DECISION_MODE:
        return None
    if _target_bool(params.get("profit_proof_eligible")) is not True:
        return None

    metadata = params.get("strategy_signal_paper")
    if not isinstance(metadata, Mapping):
        return None
    metadata_mapping = cast(Mapping[str, Any], metadata)
    metadata_mode = normalize_source_decision_mode(
        metadata_mapping.get("source_decision_mode") or metadata_mapping.get("mode")
    )
    if metadata_mode not in {None, STRATEGY_SIGNAL_PAPER_SOURCE_DECISION_MODE}:
        return None
    if _target_bool(metadata_mapping.get("profit_proof_eligible")) is False:
        return None
    return metadata_mapping


def _lineage_target_from_mapping(raw_target: Mapping[str, object]) -> dict[str, str]:
    return {
        key: value
        for key, value in {
            "candidate_id": _safe_text(raw_target.get("candidate_id")),
            "hypothesis_id": _safe_text(raw_target.get("hypothesis_id")),
            "strategy_name": _safe_text(raw_target.get("strategy_name")),
        }.items()
        if value
    }


def _lineage_target_key(
    lineage_target: Mapping[str, str],
) -> tuple[str | None, str | None, str | None]:
    return (
        lineage_target.get("candidate_id"),
        lineage_target.get("hypothesis_id"),
        lineage_target.get("strategy_name"),
    )


def _merge_paper_route_probe_lineage(
    target: dict[str, Any],
    lineage: Mapping[str, Any],
) -> None:
    for key in (
        "source_candidate_ids",
        "source_hypothesis_ids",
        "source_strategy_names",
    ):
        values = _lineage_text_values(lineage.get(key))
        if not values:
            continue
        current = target.setdefault(key, [])
        if isinstance(current, list):
            _merge_unique_texts(cast(list[str], current), values)

    identity_fallbacks = {
        "candidate_id": "source_candidate_ids",
        "hypothesis_id": "source_hypothesis_ids",
        "runtime_strategy_name": "source_strategy_names",
    }
    for key, source_key in identity_fallbacks.items():
        if _safe_text(target.get(key)) is not None:
            continue
        value = _safe_text(lineage.get(key)) or _single_lineage_text(
            lineage.get(source_key)
        )
        if value is not None:
            target[key] = value

    for key in ("source_decision_mode", "profit_proof_eligible"):
        if key in lineage and key not in target:
            target[key] = lineage[key]
    for key in _BOUNDED_SIM_COLLECTION_LINEAGE_KEYS:
        value = _safe_text(lineage.get(key))
        if value is not None and key not in target:
            target[key] = value
    for key in _BOUNDED_SIM_COLLECTION_LINEAGE_BOOL_KEYS:
        value = _target_bool(lineage.get(key))
        if value is not None and key not in target:
            target[key] = value
    symbols = _lineage_text_values(lineage.get("paper_route_probe_symbols"))
    if symbols and "paper_route_probe_symbols" not in target:
        target["paper_route_probe_symbols"] = symbols
    for key in _BOUNDED_SIM_COLLECTION_LINEAGE_MAPPING_KEYS:
        value = lineage.get(key)
        if key not in target and isinstance(value, Mapping):
            target[key] = dict(cast(Mapping[str, Any], value))

    raw_targets = lineage.get("paper_route_probe_lineage_targets")
    if not isinstance(raw_targets, Sequence) or isinstance(
        raw_targets, (str, bytes, bytearray)
    ):
        return
    current_targets = target.setdefault("paper_route_probe_lineage_targets", [])
    if not isinstance(current_targets, list):
        return
    typed_current_targets = cast(list[object], current_targets)
    existing_keys: set[tuple[str | None, str | None, str | None]] = set()
    for item in typed_current_targets:
        if isinstance(item, Mapping):
            existing_keys.add(_lineage_target_key(cast(Mapping[str, str], item)))
    for raw_target in cast(Sequence[object], raw_targets):
        if not isinstance(raw_target, Mapping):
            continue
        lineage_target = _lineage_target_from_mapping(
            cast(Mapping[str, object], raw_target)
        )
        lineage_key = _lineage_target_key(lineage_target)
        if lineage_target and lineage_key not in existing_keys:
            existing_keys.add(lineage_key)
            typed_current_targets.append(lineage_target)


def _optional_decimal(value: Any) -> Decimal | None:
    if value is None:
        return None
    try:
        return Decimal(str(value))
    except (ArithmeticError, ValueError):
        return None


def _first_decimal(*values: Decimal | None) -> Decimal | None:
    for value in values:
        if value is not None:
            return value
    return None


def _executable_bid_ask_present(payload: Mapping[str, Any]) -> bool:
    bid = _first_decimal(
        _optional_decimal(payload.get("imbalance_bid_px")),
        _optional_decimal(payload.get("bid")),
    )
    ask = _first_decimal(
        _optional_decimal(payload.get("imbalance_ask_px")),
        _optional_decimal(payload.get("ask")),
    )
    if bid is None or ask is None:
        return False
    return bid > 0 and ask >= bid


def _min_optional_decimal(*values: Decimal | None) -> Decimal | None:
    candidates = [value for value in values if value is not None and value >= 0]
    if not candidates:
        return None
    return min(candidates)


def _simple_drift_feature_thresholds() -> FeatureQualityThresholds:
    return FeatureQualityThresholds(
        max_required_null_rate=settings.trading_drift_max_required_null_rate,
        max_staleness_ms=settings.trading_drift_max_staleness_ms_p95,
        max_duplicate_ratio=settings.trading_drift_max_duplicate_ratio,
    )


def _simple_drift_thresholds() -> DriftThresholds:
    return DriftThresholds(
        max_required_null_rate=Decimal(
            str(settings.trading_drift_max_required_null_rate)
        ),
        max_staleness_ms_p95=max(0, int(settings.trading_drift_max_staleness_ms_p95)),
        max_duplicate_ratio=Decimal(str(settings.trading_drift_max_duplicate_ratio)),
        max_schema_mismatch_total=max(
            0, int(settings.trading_drift_max_schema_mismatch_total)
        ),
        max_model_calibration_error=Decimal(
            str(settings.trading_drift_max_model_calibration_error)
        ),
        max_model_llm_error_ratio=Decimal(
            str(settings.trading_drift_max_model_llm_error_ratio)
        ),
        min_performance_net_pnl=Decimal(
            str(settings.trading_drift_min_performance_net_pnl)
        ),
        max_performance_drawdown=Decimal(
            str(settings.trading_drift_max_performance_drawdown)
        ),
        max_performance_cost_bps=Decimal(
            str(settings.trading_drift_max_performance_cost_bps)
        ),
        max_execution_fallback_ratio=Decimal(
            str(settings.trading_drift_max_execution_fallback_ratio)
        ),
    )


def _pct_cap_to_notional(
    *, equity: Decimal | None, pct: Decimal | None
) -> Decimal | None:
    if equity is None or equity <= 0 or pct is None or pct <= 0:
        return None
    return equity * pct


def _simple_decision_notional(decision: StrategyDecision) -> Decimal | None:
    simple_lane = decision.params.get("simple_lane")
    if isinstance(simple_lane, Mapping):
        simple_lane_payload = cast(Mapping[str, Any], simple_lane)
        notional = _optional_decimal(simple_lane_payload.get("notional"))
        if notional is not None:
            return notional
    price = _optional_decimal(decision.params.get("price"))
    if price is None:
        return None
    return price * decision.qty


def _simple_buying_power_consumption(
    *,
    positions: list[dict[str, Any]],
    decision: StrategyDecision,
    notional: Decimal,
) -> Decimal:
    action = decision.action.strip().lower()
    if action == "buy":
        return notional
    if action != "sell" or decision.qty <= 0:
        return Decimal("0")
    current_qty = position_qty_for_symbol(positions, decision.symbol)
    if current_qty >= decision.qty:
        return Decimal("0")
    short_increasing_qty = (
        decision.qty if current_qty <= 0 else decision.qty - current_qty
    )
    return notional * (short_increasing_qty / decision.qty)


__all__ = [name for name in globals() if not name.startswith("__")]
