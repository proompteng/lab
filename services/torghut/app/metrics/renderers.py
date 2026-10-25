"""Prometheus-formatted metrics for Torghut trading counters."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from decimal import Decimal
from typing import cast

from .core import (
    AUTONOMY_WINDOW_GAUGES,
    DIRECT_GAUGES,
    EVIDENCE_CONTINUITY_KEYS,
    SERVICE_LABEL_GAUGES,
    SIMPLE_MAP_METRICS,
    STRATEGY_RUNTIME_METRICS,
    coerce_int,
    metric_headers,
    render_execution_fallback_total_map,
    render_forecast_calibration_error_map,
    render_labeled_metric,
    render_route_provenance_map,
    render_simple_map_metric,
    render_universe_resolution_total_map,
    sorted_metric_items,
)


def _render_forecast_route_selection_total_map(
    values: Mapping[str, object],
) -> list[str]:
    metric_name = "torghut_forecast_route_selection_total"
    lines = metric_headers(
        metric_name,
        "Count of forecast route selections by model family and route key.",
        "counter",
    )
    for route_key, count in sorted_metric_items(values, numeric_kind="int"):
        parts = route_key.split("|", 1)
        if len(parts) != 2:
            continue
        family, route_label = parts
        lines.extend(
            render_labeled_metric(
                metric_name=metric_name,
                labels={
                    "model_family": family,
                    "route_key": route_label,
                },
                value=count,
            )
        )
    return lines


def _render_llm_committee_verdict_total_map(values: Mapping[str, object]) -> list[str]:
    metric_name = "torghut_trading_llm_committee_verdict_total"
    lines = metric_headers(metric_name, "Count of committee role verdicts.", "counter")
    for label, count in sorted_metric_items(values, numeric_kind="int"):
        role, verdict = (label.split(":", 1) + ["unknown"])[:2]
        lines.extend(
            render_labeled_metric(
                metric_name=metric_name,
                labels={"role": role, "verdict": verdict},
                value=count,
            )
        )
    return lines


def _render_allocator_multiplier_total_map(values: Mapping[str, object]) -> list[str]:
    metric_name = "torghut_trading_allocation_multiplier_total"
    lines = metric_headers(
        metric_name,
        "Allocator multiplier applications by regime and fragility state.",
        "counter",
    )
    for label, count in sorted_metric_items(values, numeric_kind="int"):
        parts = label.rsplit("|", 2)
        if len(parts) == 3:
            regime, fragility_state, multiplier = parts
        elif len(parts) == 2:
            regime, fragility_state = parts
            multiplier = "unknown"
        else:
            regime = parts[0] if parts else "unknown"
            fragility_state = "elevated"
            multiplier = "unknown"
        lines.extend(
            render_labeled_metric(
                metric_name=metric_name,
                labels={
                    "regime": regime,
                    "fragility_state": fragility_state,
                    "multiplier": multiplier,
                },
                value=count,
            )
        )
    return lines


def _render_qty_resolution_total_map(values: Mapping[str, object]) -> list[str]:
    metric_name = "torghut_trading_qty_resolution_total"
    lines = metric_headers(
        metric_name,
        "Count of quantity-resolution outcomes by stage, outcome, and reason.",
        "counter",
    )
    for key, count in sorted_metric_items(values, numeric_kind="int"):
        stage = "unknown"
        outcome = "unknown"
        reason = "unknown"
        parts = key.split("|", 2)
        if len(parts) == 3:
            stage, outcome, reason = parts
        lines.extend(
            render_labeled_metric(
                metric_name=metric_name,
                labels={"stage": stage, "outcome": outcome, "reason": reason},
                value=count,
            )
        )
    return lines


def _render_sell_inventory_context_total_map(values: Mapping[str, object]) -> list[str]:
    metric_name = "torghut_trading_sell_inventory_context_total"
    lines = metric_headers(
        metric_name,
        "Count of sell inventory context observations by stage and context.",
        "counter",
    )
    for key, count in sorted_metric_items(values, numeric_kind="int"):
        stage = "unknown"
        context = "unknown"
        parts = key.split("|", 1)
        if len(parts) == 2:
            stage, context = parts
        lines.extend(
            render_labeled_metric(
                metric_name=metric_name,
                labels={"stage": stage, "context": context},
                value=count,
            )
        )
    return lines


def _render_execution_local_reject_total_map(values: Mapping[str, object]) -> list[str]:
    metric_name = "torghut_trading_execution_local_reject_total"
    lines = metric_headers(
        metric_name,
        "Count of local execution rejects by code and reason.",
        "counter",
    )
    for key, count in sorted_metric_items(values, numeric_kind="int"):
        code = "unknown"
        reason = "unknown"
        parts = key.split("|", 1)
        if len(parts) == 2:
            code, reason = parts
        lines.extend(
            render_labeled_metric(
                metric_name=metric_name,
                labels={"code": code, "reason": reason},
                value=count,
            )
        )
    return lines


def _render_execution_submit_attempt_total_map(
    values: Mapping[str, object],
) -> list[str]:
    metric_name = "torghut_trading_execution_submit_attempt_total"
    lines = metric_headers(
        metric_name,
        "Count of execution submit attempts by adapter, side, and asset class.",
        "counter",
    )
    for key, count in sorted_metric_items(values, numeric_kind="int"):
        adapter = "unknown"
        side = "unknown"
        asset_class = "unknown"
        parts = key.split("|", 2)
        if len(parts) == 3:
            adapter, side, asset_class = parts
        lines.extend(
            render_labeled_metric(
                metric_name=metric_name,
                labels={
                    "adapter": adapter,
                    "side": side,
                    "asset_class": asset_class,
                },
                value=count,
            )
        )
    return lines


def _render_execution_submit_result_total_map(
    values: Mapping[str, object],
) -> list[str]:
    metric_name = "torghut_trading_execution_submit_result_total"
    lines = metric_headers(
        metric_name,
        "Count of execution submit results by status and adapter.",
        "counter",
    )
    for key, count in sorted_metric_items(values, numeric_kind="int"):
        status = "unknown"
        adapter = "unknown"
        parts = key.split("|", 1)
        if len(parts) == 2:
            status, adapter = parts
        lines.extend(
            render_labeled_metric(
                metric_name=metric_name,
                labels={"status": status, "adapter": adapter},
                value=count,
            )
        )
    return lines


def _render_tca_summary_map(values: Mapping[str, object]) -> list[str]:
    lines: list[str] = []
    scalar_metrics: list[tuple[str, str]] = [
        ("order_count", "torghut_trading_tca_order_count"),
        ("avg_slippage_bps", "torghut_trading_tca_avg_slippage_bps"),
        ("avg_abs_slippage_bps", "torghut_trading_tca_avg_abs_slippage_bps"),
        ("avg_shortfall_notional", "torghut_trading_tca_avg_shortfall_notional"),
        (
            "avg_shortfall_notional_abs",
            "torghut_trading_tca_avg_shortfall_notional_abs",
        ),
        ("avg_churn_ratio", "torghut_trading_tca_avg_churn_ratio"),
        ("avg_divergence_bps", "torghut_trading_tca_avg_divergence_bps"),
        ("avg_divergence_bps_abs", "torghut_trading_tca_avg_divergence_bps_abs"),
        ("avg_calibration_error_bps", "torghut_trading_tca_avg_calibration_error_bps"),
        (
            "avg_realized_shortfall_bps",
            "torghut_trading_tca_avg_realized_shortfall_bps",
        ),
        (
            "avg_realized_shortfall_bps_abs",
            "torghut_trading_tca_avg_realized_shortfall_bps_abs",
        ),
        (
            "avg_expected_shortfall_bps_p50",
            "torghut_trading_tca_avg_expected_shortfall_bps_p50",
        ),
        (
            "avg_expected_shortfall_bps_p95",
            "torghut_trading_tca_avg_expected_shortfall_bps_p95",
        ),
        (
            "expected_shortfall_coverage",
            "torghut_trading_tca_expected_shortfall_coverage",
        ),
        (
            "expected_shortfall_sample_count",
            "torghut_trading_tca_expected_shortfall_sample_count",
        ),
    ]
    for summary_key, metric_name in scalar_metrics:
        metric_value = values.get(summary_key)
        if not isinstance(metric_value, (int, float, Decimal)):
            continue
        numeric_value = float(metric_value)
        metric_type = "counter" if summary_key == "order_count" else "gauge"
        lines.extend(
            metric_headers(
                metric_name,
                f"Torghut TCA summary metric {summary_key}.",
                metric_type,
            )
        )
        lines.append(f"{metric_name} {numeric_value}")
    return lines


def _render_strategy_runtime_map(key: str, values: Mapping[str, object]) -> list[str]:
    metric_name, metric_type = STRATEGY_RUNTIME_METRICS[key]
    lines = metric_headers(metric_name, f"Strategy runtime metric {key}.", metric_type)
    for strategy_id, count in sorted_metric_items(values, numeric_kind="int"):
        lines.extend(
            render_labeled_metric(
                metric_name=metric_name,
                labels={"strategy_id": strategy_id},
                value=count,
            )
        )
    return lines


def _render_strategy_intent_suppression_total_map(
    values: Mapping[str, object],
) -> list[str]:
    metric_name = "torghut_trading_strategy_intent_suppression_total"
    lines = metric_headers(
        metric_name,
        "Count of runtime intents suppressed before decision creation.",
        "counter",
    )
    for key, count in sorted_metric_items(values, numeric_kind="int"):
        strategy_id, reason = (key.split("|", 1) + ["unknown"])[:2]
        lines.extend(
            render_labeled_metric(
                metric_name=metric_name,
                labels={"strategy_id": strategy_id, "reason": reason or "unknown"},
                value=count,
            )
        )
    return lines


_SPECIAL_MAP_RENDERERS = {
    "execution_fallback_total": render_execution_fallback_total_map,
    "execution_local_reject_total": _render_execution_local_reject_total_map,
    "execution_submit_attempt_total": _render_execution_submit_attempt_total_map,
    "execution_submit_result_total": _render_execution_submit_result_total_map,
    "strategy_intent_suppression_total": _render_strategy_intent_suppression_total_map,
    "route_provenance": render_route_provenance_map,
    "forecast_calibration_error": render_forecast_calibration_error_map,
    "forecast_route_selection_total": _render_forecast_route_selection_total_map,
    "llm_committee_verdict_total": _render_llm_committee_verdict_total_map,
    "allocator_multiplier_total": _render_allocator_multiplier_total_map,
    "qty_resolution_total": _render_qty_resolution_total_map,
    "sell_inventory_context_total": _render_sell_inventory_context_total_map,
    "universe_resolution_total": render_universe_resolution_total_map,
    "tca_summary": _render_tca_summary_map,
}


def _render_mapping_metric(key: str, values: Mapping[str, object]) -> list[str]:
    if key in SIMPLE_MAP_METRICS:
        return render_simple_map_metric(key, values)
    if key in STRATEGY_RUNTIME_METRICS:
        return _render_strategy_runtime_map(key, values)
    renderer = _SPECIAL_MAP_RENDERERS.get(key)
    if renderer is None:
        return []
    return renderer(values)


ScalarRenderer = Callable[[str, int | float, Mapping[str, object]], list[str]]


def _render_service_label_scalar(
    metric_name: str,
    help_text: str,
    value: int | float,
) -> list[str]:
    lines = metric_headers(metric_name, help_text, "gauge")
    lines.extend(
        render_labeled_metric(
            metric_name=metric_name,
            labels={"service": "torghut"},
            value=value,
        )
    )
    return lines


def _render_direct_gauge_scalar(
    metric_name: str, help_text: str, value: int | float
) -> list[str]:
    lines = metric_headers(metric_name, help_text, "gauge")
    lines.append(f"{metric_name} {value}")
    return lines


def _render_evidence_continuity_scalar(key: str, value: int | float) -> list[str]:
    metric_name = f"torghut_trading_{key}"
    lines = metric_headers(
        metric_name,
        f"Torghut trading metric {key.replace('_', ' ')}.",
        "gauge",
    )
    lines.append(f"{metric_name} {value}")
    return lines


def _render_autonomy_window_scalar(
    metric_name: str, help_text: str, value: int | float
) -> list[str]:
    lines = metric_headers(metric_name, help_text, "gauge")
    lines.extend(
        render_labeled_metric(
            metric_name=metric_name,
            labels={"symbol": "all", "horizon": "autonomy"},
            value=value,
        )
    )
    return lines


def _render_llm_committee_veto_alignment_scalar(
    _key: str,
    value: int | float,
    metrics: Mapping[str, object],
) -> list[str]:
    metric_name = "torghut_trading_llm_committee_veto_alignment_total"
    rate_name = "torghut_trading_llm_committee_veto_alignment_rate"
    veto_total = coerce_int(metrics.get("llm_committee_veto_total"))
    lines = metric_headers(
        metric_name,
        "Count of committee vetoes aligned with deterministic veto outcomes.",
        "counter",
    )
    lines.append(f"{metric_name} {value}")
    lines.extend(
        metric_headers(
            rate_name,
            "Ratio of committee vetoes aligned with deterministic veto outcomes.",
            "gauge",
        )
    )
    rate = float(value) / veto_total if veto_total > 0 else 1.0
    lines.append(f"{rate_name} {rate}")
    return lines


def _render_orders_rejected_scalar(
    _key: str,
    value: int | float,
    metrics: Mapping[str, object],
) -> list[str]:
    submitted_total = coerce_int(metrics.get("orders_submitted_total"))
    total = submitted_total + int(value)
    clean_ratio = float(submitted_total) / total if total > 0 else 1.0
    reject_ratio = float(value) / total if total > 0 else 0.0
    lines = metric_headers(
        "torghut_trading_execution_clean_ratio",
        "Ratio of submitted orders to total submit/reject outcomes.",
        "gauge",
    )
    lines.append(f"torghut_trading_execution_clean_ratio {clean_ratio}")
    lines.extend(
        metric_headers(
            "torghut_trading_execution_reject_ratio",
            "Ratio of rejected orders to total submit/reject outcomes.",
            "gauge",
        )
    )
    lines.append(f"torghut_trading_execution_reject_ratio {reject_ratio}")
    lines.extend(
        metric_headers(
            "torghut_trading_orders_rejected_total",
            "Torghut trading metric orders rejected total.",
            "counter",
        )
    )
    lines.append(f"torghut_trading_orders_rejected_total {value}")
    return lines


def _render_signal_batch_order_violation_scalar(
    _key: str,
    value: int | float,
    _metrics: Mapping[str, object],
) -> list[str]:
    metric_name = "torghut_trading_signal_batch_order_violation_total"
    lines = metric_headers(
        metric_name,
        "Count of signal batch ordering violations detected by the feature-quality gate.",
        "counter",
    )
    lines.append(f"{metric_name} {value}")
    return lines


def _render_execution_validation_mismatch_scalar(
    _key: str,
    value: int | float,
    _metrics: Mapping[str, object],
) -> list[str]:
    metric_name = "torghut_trading_execution_validation_mismatch_total"
    lines = metric_headers(
        metric_name,
        "Count of mismatches between earlier quantity planning and execution validation.",
        "counter",
    )
    lines.append(f"{metric_name} {value}")
    return lines


def _render_default_scalar(key: str, value: int | float) -> list[str]:
    metric_name = f"torghut_trading_{key}"
    lines = metric_headers(
        metric_name,
        f"Torghut trading metric {key.replace('_', ' ')}.",
        "counter",
    )
    lines.append(f"{metric_name} {value}")
    return lines


_SPECIAL_SCALAR_RENDERERS: dict[str, ScalarRenderer] = {
    "llm_committee_veto_alignment_total": _render_llm_committee_veto_alignment_scalar,
    "orders_rejected_total": _render_orders_rejected_scalar,
    "signal_batch_order_violation_total": _render_signal_batch_order_violation_scalar,
    "execution_validation_mismatch_total": _render_execution_validation_mismatch_scalar,
}


def _render_scalar_metric(
    key: str,
    value: int | float,
    metrics: Mapping[str, object],
) -> list[str]:
    service_spec = SERVICE_LABEL_GAUGES.get(key)
    if service_spec is not None:
        return _render_service_label_scalar(*service_spec, value)

    direct_spec = DIRECT_GAUGES.get(key)
    if direct_spec is not None:
        return _render_direct_gauge_scalar(*direct_spec, value)

    if key in EVIDENCE_CONTINUITY_KEYS:
        return _render_evidence_continuity_scalar(key, value)

    autonomy_spec = AUTONOMY_WINDOW_GAUGES.get(key)
    if autonomy_spec is not None:
        return _render_autonomy_window_scalar(*autonomy_spec, value)

    renderer = _SPECIAL_SCALAR_RENDERERS.get(key)
    if renderer is not None:
        return renderer(key, value, metrics)

    return _render_default_scalar(key, value)


def render_trading_metrics(metrics: Mapping[str, object]) -> str:
    lines: list[str] = []
    for key, value in metrics.items():
        if isinstance(value, bool):
            continue
        if isinstance(value, Mapping):
            lines.extend(_render_mapping_metric(key, cast(Mapping[str, object], value)))
            continue
        if not isinstance(value, (int, float)):
            continue
        lines.extend(_render_scalar_metric(key, value, metrics))
    return "\n".join(lines) + "\n"


__all__ = ["render_trading_metrics"]
