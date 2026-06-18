from __future__ import annotations

from collections.abc import Mapping, Sequence
from decimal import Decimal
from typing import Any, cast


from ....config import settings
from ...autonomy import DriftThresholds
from ...feature_quality import FeatureQualityThresholds
from ...models import StrategyDecision
from ...runtime_decision_authority import (
    BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE,
    ROUTE_ACQUISITION_SOURCE_DECISION_MODE,
    STRATEGY_SIGNAL_PAPER_SOURCE_DECISION_MODE,
    normalize_source_decision_mode,
)
from ...simple_risk import (
    position_qty_for_symbol,
)
from .bounded_collection import (
    BOUNDED_SIM_COLLECTION_LINEAGE_BOOL_KEYS as _BOUNDED_SIM_COLLECTION_LINEAGE_BOOL_KEYS,
    BOUNDED_SIM_COLLECTION_LINEAGE_KEYS as _BOUNDED_SIM_COLLECTION_LINEAGE_KEYS,
    BOUNDED_SIM_COLLECTION_LINEAGE_MAPPING_KEYS as _BOUNDED_SIM_COLLECTION_LINEAGE_MAPPING_KEYS,
    lineage_target_from_mapping as _lineage_target_from_mapping,
    lineage_target_key as _lineage_target_key,
    lineage_text_values as _lineage_text_values,
    merge_unique_texts as _merge_unique_texts,
    safe_text as _safe_text,
    single_lineage_text as _single_lineage_text,
    target_bool as _target_bool,
)
from .target_probe import (
    mapping_value as _mapping_value,
    optional_decimal as _optional_decimal,
)


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


def _merge_lineage_list_field(
    target: dict[str, Any],
    *,
    key: str,
    values: list[str],
) -> None:
    if not values:
        return
    current = target.setdefault(key, [])
    if isinstance(current, list):
        _merge_unique_texts(cast(list[str], current), values)


def _merge_paper_route_probe_source_lists(
    target: dict[str, Any],
    lineage: Mapping[str, Any],
) -> None:
    for key in (
        "source_candidate_ids",
        "source_hypothesis_ids",
        "source_strategy_names",
    ):
        _merge_lineage_list_field(
            target,
            key=key,
            values=_lineage_text_values(lineage.get(key)),
        )


def _merge_paper_route_probe_identity_fallbacks(
    target: dict[str, Any],
    lineage: Mapping[str, Any],
) -> None:
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


def _merge_paper_route_probe_scalar_lineage(
    target: dict[str, Any],
    lineage: Mapping[str, Any],
) -> None:
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


def _merge_paper_route_probe_lineage_targets(
    target: dict[str, Any],
    lineage: Mapping[str, Any],
) -> None:
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


def _merge_paper_route_probe_lineage(
    target: dict[str, Any],
    lineage: Mapping[str, Any],
) -> None:
    _merge_paper_route_probe_source_lists(target, lineage)
    _merge_paper_route_probe_identity_fallbacks(target, lineage)
    _merge_paper_route_probe_scalar_lineage(target, lineage)
    _merge_paper_route_probe_lineage_targets(target, lineage)


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


# Public module boundary aliases.
paper_route_probe_entry_metadata = _paper_route_probe_entry_metadata
target_notional_sizing_audit_from_params = _target_notional_sizing_audit_from_params
bounded_collection_decision_requires_target_notional_sizing = (
    _bounded_collection_decision_requires_target_notional_sizing
)
bounded_paper_route_collection_entry_metadata = (
    _bounded_paper_route_collection_entry_metadata
)
strategy_signal_paper_entry_metadata = _strategy_signal_paper_entry_metadata
merge_paper_route_probe_lineage = _merge_paper_route_probe_lineage
first_decimal = _first_decimal
executable_bid_ask_present = _executable_bid_ask_present
min_optional_decimal = _min_optional_decimal
simple_drift_feature_thresholds = _simple_drift_feature_thresholds
simple_drift_thresholds = _simple_drift_thresholds
pct_cap_to_notional = _pct_cap_to_notional
simple_decision_notional = _simple_decision_notional
simple_buying_power_consumption = _simple_buying_power_consumption
