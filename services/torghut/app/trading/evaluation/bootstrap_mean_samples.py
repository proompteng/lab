"""Walk-forward evaluation harness for offline backtests."""

from __future__ import annotations

import json
import hashlib
from decimal import Decimal
from typing import Any, cast


from .signal_source import (
    FillPriceErrorBudgetReportV1,
    FixtureSignalSource,
    FoldResult,
    ProfitabilityBenchmarkSliceV4,
    ProfitabilityBenchmarkV4,
    ProfitabilityEvidenceThresholdsV4,
    ProfitabilityEvidenceV4,
    ProfitabilityEvidenceValidationResultV4,
    SignalSource,
    WalkForwardDecision,
    WalkForwardFold,
    WalkForwardResults,
    build_profitability_evidence_v4,
    execute_profitability_benchmark_v4,
    generate_walk_forward_folds,
    run_walk_forward,
    validate_profitability_evidence_v4,
    write_walk_forward_results,
)
from .build_simulation_calibration_report_v1 import (
    build_fill_price_error_budget_report_v1,
)


def _bootstrap_mean_samples(
    values: list[Decimal], *, sample_count: int
) -> list[Decimal]:
    if not values:
        return []
    payload = [str(value) for value in values]
    seed = int(
        hashlib.sha256(json.dumps(payload, sort_keys=True).encode("utf-8")).hexdigest()[
            :16
        ],
        16,
    )
    samples: list[Decimal] = []
    values_count = len(values)
    for _ in range(sample_count):
        sample_sum: Decimal = Decimal("0")
        for _ in range(values_count):
            seed = (1664525 * seed + 1013904223) % (2**32)
            index: int = seed % values_count
            sample_sum = sample_sum + values[index]
        sample_mean: Decimal = sample_sum / Decimal(values_count)
        samples.append(sample_mean)
    return samples


def _quantile_decimal(values: list[Decimal], quantile: Decimal) -> Decimal:
    if not values:
        return Decimal("0")
    if quantile <= 0:
        return values[0]
    if quantile >= 1:
        return values[-1]
    index = int((Decimal(len(values) - 1) * quantile).to_integral_value())
    index = max(0, min(index, len(values) - 1))
    return values[index]


def _reproducibility_payload(hashes: dict[str, str]) -> dict[str, object]:
    normalized = {
        str(key): str(value)
        for key, value in hashes.items()
        if str(key).strip() and str(value).strip()
    }
    manifest = json.dumps(sorted(normalized.items()), separators=(",", ":")).encode(
        "utf-8"
    )
    manifest_hash = hashlib.sha256(manifest).hexdigest()
    return {
        "hash_algorithm": "sha256",
        "artifact_hashes": normalized,
        "manifest_hash": manifest_hash,
    }


def _report_fold_net_pnls(report_payload: dict[str, Any]) -> list[Decimal]:
    robustness = _as_dict(report_payload.get("robustness"))
    folds = robustness.get("folds")
    if not isinstance(folds, list):
        return []
    values: list[Decimal] = []
    for raw in cast(list[object], folds):
        if not isinstance(raw, dict):
            continue
        fold = cast(dict[str, Any], raw)
        value = _decimal(fold.get("net_pnl"))
        if value is not None:
            values.append(value)
    return values


def _decimal(value: Any) -> Decimal | None:
    if value is None:
        return None
    if isinstance(value, Decimal):
        return value
    try:
        return Decimal(str(value))
    except (ArithmeticError, TypeError, ValueError):
        return None


def _decimal_mean(values: list[Decimal]) -> Decimal:
    if not values:
        return Decimal("0")
    return sum(values, Decimal("0")) / Decimal(len(values))


def _decimal_std(values: list[Decimal], mean: Decimal) -> Decimal:
    if len(values) <= 1:
        return Decimal("0")
    variance = sum((value - mean) ** 2 for value in values) / Decimal(len(values))
    return variance.sqrt()


def _safe_ratio(numerator: Decimal, denominator: Decimal) -> Decimal:
    if denominator <= 0:
        return Decimal("0")
    return numerator / denominator


def _as_dict(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    return cast(dict[str, Any], value)


def _as_int(value: Any) -> int | None:
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


# Public aliases used by split-module consumers.
as_int = _as_int
bootstrap_mean_samples = _bootstrap_mean_samples
decimal_mean = _decimal_mean
decimal_std = _decimal_std
quantile_decimal = _quantile_decimal
reproducibility_payload = _reproducibility_payload
report_fold_net_pnls = _report_fold_net_pnls
safe_ratio = _safe_ratio

__all__ = [
    "FixtureSignalSource",
    "FillPriceErrorBudgetReportV1",
    "FoldResult",
    "ProfitabilityBenchmarkSliceV4",
    "ProfitabilityBenchmarkV4",
    "ProfitabilityEvidenceThresholdsV4",
    "ProfitabilityEvidenceV4",
    "ProfitabilityEvidenceValidationResultV4",
    "SignalSource",
    "WalkForwardDecision",
    "WalkForwardFold",
    "WalkForwardResults",
    "as_int",
    "bootstrap_mean_samples",
    "build_fill_price_error_budget_report_v1",
    "decimal_mean",
    "decimal_std",
    "build_profitability_evidence_v4",
    "execute_profitability_benchmark_v4",
    "generate_walk_forward_folds",
    "quantile_decimal",
    "reproducibility_payload",
    "report_fold_net_pnls",
    "run_walk_forward",
    "safe_ratio",
    "validate_profitability_evidence_v4",
    "write_walk_forward_results",
]
