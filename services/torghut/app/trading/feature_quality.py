"""Runtime feature data-quality gates for fail-closed strategy evaluation."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from statistics import quantiles

from .features import (
    FEATURE_VECTOR_V3_REQUIRED_FIELDS,
    map_feature_values_v3,
    signal_declares_compatible_schema,
)
from .models import SignalEnvelope

QUALITY_GATED_REQUIRED_FIELDS = tuple(
    [field for field in FEATURE_VECTOR_V3_REQUIRED_FIELDS if field != "price"]
)
REASON_NON_MONOTONIC = "non_monotonic_progression"
REASON_SCHEMA_MISMATCH = "schema_mismatch"
REASON_REQUIRED_NULL_RATE = "required_feature_null_rate_exceeds_threshold"
REASON_STALENESS = "feature_staleness_exceeds_budget"
REASON_DUPLICATE_RATIO = "duplicate_ratio_exceeds_threshold"


@dataclass(frozen=True)
class FeatureQualityThresholds:
    max_required_null_rate: float = 0.01
    max_staleness_ms: int = 120_000
    max_duplicate_ratio: float = 0.02

    def to_payload(self) -> dict[str, float | int]:
        return {
            "max_required_null_rate": self.max_required_null_rate,
            "max_staleness_ms": self.max_staleness_ms,
            "max_duplicate_ratio": self.max_duplicate_ratio,
        }


@dataclass(frozen=True)
class FeatureQualityReport:
    accepted: bool
    rows_total: int
    null_rate_by_field: dict[str, float]
    staleness_ms_p95: int
    duplicate_ratio: float
    schema_mismatch_total: int
    reasons: list[str]

    def to_payload(self) -> dict[str, object]:
        return {
            "accepted": self.accepted,
            "rows_total": self.rows_total,
            "null_rate_by_field": dict(self.null_rate_by_field),
            "staleness_ms_p95": self.staleness_ms_p95,
            "duplicate_ratio": self.duplicate_ratio,
            "schema_mismatch_total": self.schema_mismatch_total,
            "reasons": list(self.reasons),
        }


class FeatureQualityError(RuntimeError):
    """Raised when a quality report fails hard thresholds."""


def evaluate_feature_batch_quality(
    signals: list[SignalEnvelope],
    *,
    thresholds: FeatureQualityThresholds | None = None,
) -> FeatureQualityReport:
    policy = thresholds or FeatureQualityThresholds()
    rows_total = len(signals)
    if rows_total == 0:
        return FeatureQualityReport(
            accepted=True,
            rows_total=0,
            null_rate_by_field={
                field: 0.0 for field in FEATURE_VECTOR_V3_REQUIRED_FIELDS
            },
            staleness_ms_p95=0,
            duplicate_ratio=0.0,
            schema_mismatch_total=0,
            reasons=[],
        )

    null_counts = {field: 0 for field in FEATURE_VECTOR_V3_REQUIRED_FIELDS}
    seen_keys: set[tuple[datetime, str, int]] = set()
    duplicate_total = 0
    schema_mismatch_total = 0
    staleness_values: list[int] = []
    reasons: list[str] = []

    previous: tuple[datetime, str, int] | None = None
    for signal in signals:
        if not signal_declares_compatible_schema(signal):
            schema_mismatch_total += 1

        values = map_feature_values_v3(signal)
        for field in FEATURE_VECTOR_V3_REQUIRED_FIELDS:
            if values.get(field) is None:
                null_counts[field] += 1

        staleness_raw = values.get("staleness_ms")
        staleness = int(staleness_raw) if isinstance(staleness_raw, (int, float)) else 0
        staleness_values.append(staleness)

        key = (signal.event_ts, signal.symbol, signal.seq or 0)
        if key in seen_keys:
            duplicate_total += 1
        else:
            seen_keys.add(key)

        if previous is not None and key < previous:
            reasons.append(REASON_NON_MONOTONIC)
        previous = key

    null_rate_by_field = {
        field: null_counts[field] / rows_total
        for field in FEATURE_VECTOR_V3_REQUIRED_FIELDS
    }
    duplicate_ratio = duplicate_total / rows_total
    staleness_ms_p95 = _p95(staleness_values)

    if schema_mismatch_total > 0:
        reasons.append(REASON_SCHEMA_MISMATCH)
    # Price can be enriched downstream by price fetchers, so null-rate gating is applied
    # only to indicator fields that must be present at signal ingest time.
    if any(
        null_rate_by_field[field] > policy.max_required_null_rate
        for field in QUALITY_GATED_REQUIRED_FIELDS
    ):
        reasons.append(REASON_REQUIRED_NULL_RATE)
    if staleness_ms_p95 > policy.max_staleness_ms:
        reasons.append(REASON_STALENESS)
    if duplicate_ratio > policy.max_duplicate_ratio:
        reasons.append(REASON_DUPLICATE_RATIO)

    unique_reasons = sorted(set(reasons))
    return FeatureQualityReport(
        accepted=len(unique_reasons) == 0,
        rows_total=rows_total,
        null_rate_by_field=null_rate_by_field,
        staleness_ms_p95=staleness_ms_p95,
        duplicate_ratio=duplicate_ratio,
        schema_mismatch_total=schema_mismatch_total,
        reasons=unique_reasons,
    )


def enforce_feature_batch_quality(
    signals: list[SignalEnvelope],
    *,
    thresholds: FeatureQualityThresholds | None = None,
) -> FeatureQualityReport:
    report = evaluate_feature_batch_quality(signals, thresholds=thresholds)
    if report.accepted:
        return report

    parts: list[str] = []
    if report.reasons:
        parts.append(f"reasons={','.join(report.reasons)}")
    parts.append(f"rows={report.rows_total}")
    parts.append(f"schema_mismatch_total={report.schema_mismatch_total}")
    parts.append(f"staleness_ms_p95={report.staleness_ms_p95}")
    parts.append(f"duplicate_ratio={report.duplicate_ratio:.6f}")
    raise FeatureQualityError("feature_quality_gate_failed " + " ".join(parts))


def _p95(values: list[int]) -> int:
    if not values:
        return 0
    if len(values) == 1:
        return values[0]
    quantized = quantiles(values, n=100, method="inclusive")
    if not quantized:
        return max(values)
    return int(quantized[94])


__all__ = [
    "FeatureQualityError",
    "FeatureQualityReport",
    "FeatureQualityThresholds",
    "REASON_DUPLICATE_RATIO",
    "REASON_NON_MONOTONIC",
    "REASON_REQUIRED_NULL_RATE",
    "REASON_SCHEMA_MISMATCH",
    "REASON_STALENESS",
    "enforce_feature_batch_quality",
    "evaluate_feature_batch_quality",
]
