"""Apply exact replay-ledger remediation to follow-up search sweeps."""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation, ROUND_CEILING, ROUND_DOWN
from typing import Any, cast

REPLAY_LEDGER_GUIDED_SEARCH_SCHEMA_VERSION = "torghut.replay-ledger-guided-search.v1"

_BREADTH_BLOCKERS = frozenset(
    {
        "avg_filled_notional_per_day_below_min",
        "window_net_pnl_per_day_below_target",
    }
)
_CONCENTRATION_BLOCKER = "best_day_share_above_max"
_EXPOSURE_BLOCKER = "max_single_fill_notional_pct_equity_above_max"
_WINDOW_BLOCKER = "window_weekday_count_below_min_observed_trading_days"
_BREADTH_PARAMETER_KEYS = (
    "top_n",
    "rank_count",
    "max_pair_legs",
    "max_entries_per_session",
    "max_concurrent_positions",
)
_MAX_BREADTH_FACTOR = Decimal("4")
_MAX_TOP_N = 12
_MAX_ENTRY_COUNT = 12
_EXECUTION_QUALITY_EVIDENCE_FIELDS_BY_BLOCKER = {
    "order_type_mix_evidence_incomplete": (
        "selected_order_type",
        "submitted_order_type",
        "fill_order_type",
    ),
    "fill_order_type_evidence_incomplete": (
        "submitted_order_type",
        "fill_order_type",
        "fill_order_id",
    ),
    "execution_shortfall_evidence_incomplete": (
        "route_tca_bps",
        "execution_shortfall_bps",
        "arrival_shortfall_bps",
    ),
    "limit_fill_probability_evidence_incomplete": (
        "limit_fill_probability",
        "survival_fill_probability",
        "fill_probability",
    ),
    "queue_position_survival_evidence_incomplete": (
        "queue_position",
        "queue_ahead_qty",
        "time_to_fill_seconds",
    ),
    "price_improvement_evidence_incomplete": (
        "price_improvement_bps",
        "realized_price_improvement_bps",
    ),
    "nonfill_opportunity_cost_evidence_incomplete": (
        "nonfill_opportunity_cost_bps",
        "missed_fill_opportunity_cost_bps",
    ),
    "limit_fill_rate_below_execution_quality_floor": (
        "limit_fill_probability",
        "limit_fill_rate",
        "order_type_ablation",
    ),
    "execution_shortfall_bps_above_quality_floor": (
        "route_tca_bps",
        "execution_shortfall_bps",
        "order_type_ablation",
    ),
    "nonfill_opportunity_cost_bps_above_quality_floor": (
        "nonfill_opportunity_cost_bps",
        "missed_fill_opportunity_cost_bps",
        "order_type_ablation",
    ),
}
_DEFAULT_EXECUTION_QUALITY_EVIDENCE_FIELDS = (
    "route_tca_bps",
    "selected_order_type",
    "fill_order_type",
    "limit_fill_probability",
    "queue_position",
    "price_improvement_bps",
    "nonfill_opportunity_cost_bps",
)


@dataclass(frozen=True)
class ReplayLedgerGuidedSweep:
    sweep_config: dict[str, Any]
    applied_actions: tuple[str, ...]

    @property
    def applied(self) -> bool:
        return bool(self.applied_actions)

    @property
    def mutation_label_suffix(self) -> str:
        return "+".join(self.applied_actions)


def apply_replay_ledger_remediation_guidance(
    *,
    sweep_config: Mapping[str, Any],
    remediation_report: Mapping[str, Any] | None,
) -> ReplayLedgerGuidedSweep:
    """Convert exact replay-ledger blockers into bounded next-sweep adjustments."""

    payload = _json_clone(sweep_config)
    if remediation_report is None:
        return ReplayLedgerGuidedSweep(sweep_config=payload, applied_actions=())

    blockers = _search_blockers(remediation_report)
    execution_quality_blockers = _execution_quality_blockers(remediation_report)
    if not blockers and not execution_quality_blockers:
        return ReplayLedgerGuidedSweep(sweep_config=payload, applied_actions=())

    policy = _policy_from_report(remediation_report)
    actions: list[str] = []
    parameter_changes: list[dict[str, str]] = []

    if blockers & _BREADTH_BLOCKERS:
        if _expand_breadth_parameters(
            payload=payload,
            multiplier=_search_breadth_multiplier(remediation_report),
            parameter_changes=parameter_changes,
        ):
            actions.append("breadth")

    if _CONCENTRATION_BLOCKER in blockers:
        if _tighten_best_day_share(
            payload=payload,
            policy=policy,
            parameter_changes=parameter_changes,
        ):
            actions.append("concentration")

    if _EXPOSURE_BLOCKER in blockers:
        if _tighten_exposure_caps(
            payload=payload,
            policy=policy,
            parameter_changes=parameter_changes,
        ):
            actions.append("exposure")

    if _WINDOW_BLOCKER in blockers:
        _require_min_window_weekday_count(
            payload=payload,
            policy=policy,
            parameter_changes=parameter_changes,
        )
        actions.append("window")

    execution_quality_remediations = _execution_quality_remediations(
        remediation_report,
        execution_quality_blockers=execution_quality_blockers,
    )
    if execution_quality_blockers:
        actions.append("execution_quality")

    if actions:
        metadata = _mapping(payload.get("metadata"))
        metadata["replay_ledger_guided_search"] = {
            "schema_version": REPLAY_LEDGER_GUIDED_SEARCH_SCHEMA_VERSION,
            "source_candidate_id": _string(remediation_report.get("candidate_id")),
            "status": _string(remediation_report.get("status")),
            "blockers": sorted(blockers),
            "execution_quality_blockers": sorted(execution_quality_blockers),
            "execution_quality_remediations": execution_quality_remediations,
            "required_replay_evidence_fields": _required_execution_quality_fields(
                execution_quality_blockers
            ),
            "execution_quality_authority": (
                "research_ranking_only_final_promotion_still_requires_runtime_ledger"
            ),
            "applied_actions": list(actions),
            "parameter_changes": parameter_changes,
            "metric_snapshot": dict(
                _mapping(remediation_report.get("metric_snapshot"))
            ),
        }
        payload["metadata"] = metadata

    return ReplayLedgerGuidedSweep(
        sweep_config=payload,
        applied_actions=tuple(actions),
    )


def _json_clone(payload: Mapping[str, Any]) -> dict[str, Any]:
    return cast(dict[str, Any], json.loads(json.dumps(payload, default=str)))


def _mapping(value: object) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        return {}
    mapping = cast(Mapping[object, Any], value)
    return {str(key): item for key, item in mapping.items()}


def _string(value: object) -> str:
    if value is None:
        return ""
    return str(value).strip()


def _string_list(value: object) -> tuple[str, ...]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes)):
        return ()
    sequence = cast(Sequence[object], value)
    return tuple(parsed for item in sequence if (parsed := _string(item)))


def _decimal(value: object) -> Decimal | None:
    try:
        return Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        return None


def _format_decimal(value: Decimal) -> str:
    if value == 0:
        return "0"
    formatted = format(value.normalize(), "f")
    if "." in formatted:
        return formatted.rstrip("0").rstrip(".") or "0"
    return formatted


def _as_values(value: object) -> list[object]:
    if isinstance(value, list):
        return list(cast(list[object], value))
    if value is None:
        return []
    return [value]


def _positive_decimal_grid_values(value: object) -> tuple[Decimal, ...]:
    decimals: list[Decimal] = []
    for item in _as_values(value):
        parsed = _decimal(item)
        if parsed is not None and parsed > 0:
            decimals.append(parsed)
    return tuple(decimals)


def _search_blockers(remediation_report: Mapping[str, Any]) -> set[str]:
    blockers = {
        *_string_list(remediation_report.get("promotion_blockers")),
        *_string_list(remediation_report.get("runtime_ledger_blockers")),
    }
    blockers.discard("replay_artifact_only_not_live")
    blockers.discard("exact_replay_ledger_candidate_missing")
    return blockers


def _execution_quality_blockers(remediation_report: Mapping[str, Any]) -> set[str]:
    return set(_string_list(remediation_report.get("execution_quality_blockers")))


def _execution_quality_remediations(
    remediation_report: Mapping[str, Any],
    *,
    execution_quality_blockers: set[str],
) -> list[dict[str, Any]]:
    if not execution_quality_blockers:
        return []
    remediations: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for item in (
        *_mapping_sequence(remediation_report.get("recommended_search_actions")),
        *_mapping_sequence(remediation_report.get("blocker_remediations")),
    ):
        blocker = _string(item.get("blocker"))
        if blocker not in execution_quality_blockers:
            continue
        action = _string(item.get("action"))
        dedupe_key = (blocker, action)
        if dedupe_key in seen:
            continue
        seen.add(dedupe_key)
        remediations.append(
            {
                "blocker": blocker,
                "action": action,
                "reason": _string(item.get("reason")),
                "parameter_hints": list(_string_list(item.get("parameter_hints"))),
            }
        )
    return remediations


def _required_execution_quality_fields(
    execution_quality_blockers: set[str],
) -> list[str]:
    fields: set[str] = set()
    for blocker in execution_quality_blockers:
        fields.update(
            _EXECUTION_QUALITY_EVIDENCE_FIELDS_BY_BLOCKER.get(
                blocker, _DEFAULT_EXECUTION_QUALITY_EVIDENCE_FIELDS
            )
        )
    return sorted(fields)


def _policy_from_report(remediation_report: Mapping[str, Any]) -> dict[str, str]:
    policy: dict[str, str] = {}
    adjustments = _mapping(remediation_report.get("recommended_objective_adjustments"))
    metric_snapshot = _mapping(remediation_report.get("metric_snapshot"))
    for key in (
        "max_best_day_share",
        "max_gross_exposure_pct_equity",
        "target_net_pnl_per_day",
        "min_avg_filled_notional_per_day",
        "min_window_weekday_count",
        "start_equity",
    ):
        value = _string(adjustments.get(key)) or _string(metric_snapshot.get(key))
        if value:
            policy[key] = value
    return policy


def _search_breadth_multiplier(remediation_report: Mapping[str, Any]) -> Decimal:
    multiplier = Decimal("2")
    for action in _mapping_sequence(
        remediation_report.get("recommended_search_actions")
    ):
        required = _decimal(action.get("required_multiplier"))
        if required is not None and required > multiplier:
            multiplier = required
    return min(_MAX_BREADTH_FACTOR, multiplier)


def _mapping_sequence(value: object) -> tuple[Mapping[str, Any], ...]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes)):
        return ()
    sequence = cast(Sequence[object], value)
    return tuple(
        cast(Mapping[str, Any], item) for item in sequence if isinstance(item, Mapping)
    )


def _ceil_to_int(value: Decimal) -> int:
    return int(value.to_integral_value(rounding=ROUND_CEILING))


def _expand_breadth_parameters(
    *,
    payload: dict[str, Any],
    multiplier: Decimal,
    parameter_changes: list[dict[str, str]],
) -> bool:
    parameters = _mapping(payload.get("parameters"))
    changed = False
    factor = max(2, _ceil_to_int(multiplier))
    for key in _BREADTH_PARAMETER_KEYS:
        if key not in parameters:
            continue
        maximum = _MAX_TOP_N if key in {"top_n", "rank_count"} else _MAX_ENTRY_COUNT
        values = _expanded_positive_int_grid(
            parameters.get(key),
            factor=factor,
            maximum=maximum,
        )
        if not values:
            continue
        before = _normalized_grid(parameters.get(key))
        if values == before:
            continue
        parameters[key] = values
        changed = True
        parameter_changes.append(
            {
                "key": f"parameters.{key}",
                "before": ",".join(before),
                "after": ",".join(values),
            }
        )
    if changed:
        payload["parameters"] = parameters
    if _is_microbar_pairs_sweep(payload):
        changed |= _ensure_microbar_pair_breadth_grid(
            parameters=parameters,
            factor=factor,
            parameter_changes=parameter_changes,
        )
        if changed:
            payload["parameters"] = parameters
    return changed


def _is_microbar_pairs_sweep(payload: Mapping[str, Any]) -> bool:
    return (
        _string(payload.get("family_template_id"))
        == "microbar_cross_sectional_pairs_v1"
    )


def _ensure_microbar_pair_breadth_grid(
    *,
    parameters: dict[str, Any],
    factor: int,
    parameter_changes: list[dict[str, str]],
) -> bool:
    if "max_pair_legs" in parameters:
        return False
    seed_values = (
        _positive_decimal_grid_values(parameters.get("top_n"))
        or _positive_decimal_grid_values(parameters.get("max_entries_per_session"))
        or (Decimal("2"),)
    )
    seed = max(2, _ceil_to_int(max(seed_values)))
    values = _expanded_positive_int_grid(
        [str(seed)], factor=factor, maximum=_MAX_ENTRY_COUNT
    )
    if not values:
        return False
    parameters["max_pair_legs"] = values
    parameter_changes.append(
        {
            "key": "parameters.max_pair_legs",
            "before": "",
            "after": ",".join(values),
        }
    )
    return True


def _expanded_positive_int_grid(
    value: object,
    *,
    factor: int,
    maximum: int,
) -> list[str]:
    expanded: set[int] = set()
    for item in _positive_decimal_grid_values(value):
        current = max(1, _ceil_to_int(item))
        expanded.add(min(maximum, current))
        expanded.add(min(maximum, current * factor))
    return [str(item) for item in sorted(expanded)]


def _normalized_grid(value: object) -> list[str]:
    return [_string(item) for item in _as_values(value) if _string(item)]


def _tighten_best_day_share(
    *,
    payload: dict[str, Any],
    policy: Mapping[str, str],
    parameter_changes: list[dict[str, str]],
) -> bool:
    threshold = _decimal(policy.get("max_best_day_share"))
    if threshold is None or threshold <= 0:
        return False
    consistency = _mapping(payload.get("consistency_constraints"))
    before = _string(consistency.get("max_best_day_share_of_total_pnl"))
    before_decimal = _decimal(before)
    if before_decimal is not None and before_decimal <= threshold:
        return False
    after = _format_decimal(threshold)
    consistency["max_best_day_share_of_total_pnl"] = after
    payload["consistency_constraints"] = consistency
    parameter_changes.append(
        {
            "key": "consistency_constraints.max_best_day_share_of_total_pnl",
            "before": before,
            "after": after,
        }
    )
    return True


def _tighten_exposure_caps(
    *,
    payload: dict[str, Any],
    policy: Mapping[str, str],
    parameter_changes: list[dict[str, str]],
) -> bool:
    max_gross = _decimal(policy.get("max_gross_exposure_pct_equity"))
    if max_gross is None or max_gross <= 0:
        return False
    parameters = _mapping(payload.get("parameters"))
    strategy_overrides = _mapping(payload.get("strategy_overrides"))
    changed = False

    changed |= _cap_grid(
        container=parameters,
        key="max_gross_exposure_pct_equity",
        maximum=max_gross,
        fallback=max_gross,
        label="parameters.max_gross_exposure_pct_equity",
        parameter_changes=parameter_changes,
    )

    max_entries = _max_entry_count(parameters)
    per_entry_pct = (max_gross / Decimal(max_entries)).quantize(
        Decimal("0.000001"),
        rounding=ROUND_DOWN,
    )
    changed |= _cap_grid(
        container=strategy_overrides,
        key="max_position_pct_equity",
        maximum=per_entry_pct,
        fallback=per_entry_pct,
        label="strategy_overrides.max_position_pct_equity",
        parameter_changes=parameter_changes,
    )

    start_equity = _decimal(policy.get("start_equity"))
    if start_equity is not None and start_equity > 0:
        per_trade_notional = (start_equity * per_entry_pct).quantize(
            Decimal("0.01"),
            rounding=ROUND_DOWN,
        )
        changed |= _cap_grid(
            container=strategy_overrides,
            key="max_notional_per_trade",
            maximum=per_trade_notional,
            fallback=per_trade_notional,
            label="strategy_overrides.max_notional_per_trade",
            parameter_changes=parameter_changes,
        )

    if changed:
        payload["parameters"] = parameters
        payload["strategy_overrides"] = strategy_overrides
    return changed


def _require_min_window_weekday_count(
    *,
    payload: dict[str, Any],
    policy: Mapping[str, str],
    parameter_changes: list[dict[str, str]],
) -> bool:
    threshold = _positive_int(policy.get("min_window_weekday_count"))
    if threshold is None:
        return False
    consistency = _mapping(payload.get("consistency_constraints"))
    before = _string(consistency.get("min_window_weekday_count"))
    before_int = _positive_int(before) or 0
    if before_int >= threshold:
        return False
    consistency["min_window_weekday_count"] = threshold
    payload["consistency_constraints"] = consistency
    parameter_changes.append(
        {
            "key": "consistency_constraints.min_window_weekday_count",
            "before": before,
            "after": str(threshold),
        }
    )
    return True


def _positive_int(value: object) -> int | None:
    parsed = _decimal(value)
    if parsed is None or parsed <= 0:
        return None
    return _ceil_to_int(parsed)


def _cap_grid(
    *,
    container: dict[str, Any],
    key: str,
    maximum: Decimal,
    fallback: Decimal,
    label: str,
    parameter_changes: list[dict[str, str]],
) -> bool:
    before = _normalized_grid(container.get(key))
    kept = [
        value
        for value in _positive_decimal_grid_values(container.get(key))
        if value <= maximum
    ]
    if not kept:
        kept = [fallback]
    after = [_format_decimal(value) for value in kept]
    if after == before:
        return False
    container[key] = after
    parameter_changes.append(
        {
            "key": label,
            "before": ",".join(before),
            "after": ",".join(after),
        }
    )
    return True


def _max_entry_count(parameters: Mapping[str, Any]) -> int:
    for key in ("max_concurrent_positions", "max_pair_legs", "top_n", "rank_count"):
        values = _positive_decimal_grid_values(parameters.get(key))
        if values:
            return max(1, min(_MAX_ENTRY_COUNT, _ceil_to_int(max(values))))
    return 1
