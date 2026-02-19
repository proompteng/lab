"""Online/offline feature parity checks for FeatureVectorV3."""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from pathlib import Path
from typing import Any

from .features import FEATURE_VECTOR_V3_VALUE_FIELDS, FeatureNormalizationError, normalize_feature_vector_v3
from .models import SignalEnvelope


@dataclass(frozen=True)
class FeatureParityThresholds:
    max_hash_mismatch_ratio: float = 0.0
    max_numeric_drift: float = 1e-9


@dataclass(frozen=True)
class FeatureParityReport:
    checked_rows: int
    missing_online_rows: int
    missing_offline_rows: int
    hash_mismatches: int
    drift_by_field: dict[str, float]
    top_drift_fields: list[dict[str, Any]]
    failing_windows: list[dict[str, Any]]
    accepted: bool
    reasons: list[str]

    def to_dict(self) -> dict[str, Any]:
        return {
            'checked_rows': self.checked_rows,
            'missing_online_rows': self.missing_online_rows,
            'missing_offline_rows': self.missing_offline_rows,
            'hash_mismatches': self.hash_mismatches,
            'drift_by_field': self.drift_by_field,
            'top_drift_fields': self.top_drift_fields,
            'failing_windows': self.failing_windows,
            'accepted': self.accepted,
            'reasons': self.reasons,
        }


def run_feature_parity(
    online_signals: list[SignalEnvelope],
    offline_signals: list[SignalEnvelope],
    *,
    thresholds: FeatureParityThresholds | None = None,
) -> FeatureParityReport:
    policy = thresholds or FeatureParityThresholds()

    online_vectors = _normalize_indexed(online_signals)
    offline_vectors = _normalize_indexed(offline_signals)

    online_keys = set(online_vectors)
    offline_keys = set(offline_vectors)
    shared_keys = sorted(online_keys & offline_keys)

    missing_online_rows = len(offline_keys - online_keys)
    missing_offline_rows = len(online_keys - offline_keys)

    drift_by_field: dict[str, float] = {field: 0.0 for field in FEATURE_VECTOR_V3_VALUE_FIELDS}
    hash_mismatches = 0
    failing_windows: list[dict[str, Any]] = []

    for key in shared_keys:
        online = online_vectors[key]
        offline = offline_vectors[key]

        if online.normalization_hash != offline.normalization_hash:
            hash_mismatches += 1

        drift_record: dict[str, float] = {}
        for field in FEATURE_VECTOR_V3_VALUE_FIELDS:
            drift = _value_drift(online.values.get(field), offline.values.get(field))
            if drift > drift_by_field[field]:
                drift_by_field[field] = drift
            if drift > policy.max_numeric_drift:
                drift_record[field] = drift

        if drift_record:
            failing_windows.append(
                {
                    'event_ts': online.event_ts.isoformat(),
                    'symbol': online.symbol,
                    'timeframe': online.timeframe,
                    'seq': online.seq,
                    'source': online.source,
                    'drift': drift_record,
                }
            )

    top_drift_fields = [
        {'field': field, 'max_abs_drift': drift}
        for field, drift in sorted(drift_by_field.items(), key=lambda item: item[1], reverse=True)
        if drift > 0
    ][:5]

    checked_rows = len(shared_keys)
    reasons: list[str] = []
    hash_mismatch_ratio = (hash_mismatches / checked_rows) if checked_rows else 0.0
    if hash_mismatch_ratio > policy.max_hash_mismatch_ratio:
        reasons.append('hash_mismatch_ratio_exceeds_threshold')
    if failing_windows:
        reasons.append('numeric_drift_exceeds_threshold')
    if missing_online_rows > 0 or missing_offline_rows > 0:
        reasons.append('coverage_mismatch')

    return FeatureParityReport(
        checked_rows=checked_rows,
        missing_online_rows=missing_online_rows,
        missing_offline_rows=missing_offline_rows,
        hash_mismatches=hash_mismatches,
        drift_by_field=drift_by_field,
        top_drift_fields=top_drift_fields,
        failing_windows=failing_windows,
        accepted=len(reasons) == 0,
        reasons=reasons,
    )


def write_feature_parity_report(report: FeatureParityReport, output_path: Path) -> Path:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(report.to_dict(), indent=2, sort_keys=True), encoding='utf-8')
    return output_path


def _normalize_indexed(signals: list[SignalEnvelope]) -> dict[tuple[datetime, str, str, int, str], Any]:
    indexed: dict[tuple[datetime, str, str, int, str], Any] = {}
    for signal in signals:
        try:
            fv = normalize_feature_vector_v3(signal)
        except FeatureNormalizationError:
            continue
        key = (fv.event_ts, fv.symbol, fv.timeframe, fv.seq, fv.source)
        indexed[key] = fv
    return indexed


def _value_drift(lhs: Any, rhs: Any) -> float:
    left = _to_decimal(lhs)
    right = _to_decimal(rhs)
    if left is None or right is None:
        return 0.0 if lhs == rhs else 1.0
    return float(abs(left - right))


def _to_decimal(value: Any) -> Decimal | None:
    if value is None:
        return None
    if isinstance(value, Decimal):
        return value
    if isinstance(value, (int, float, str)):
        try:
            return Decimal(str(value))
        except Exception:
            return None
    return None


__all__ = [
    'FeatureParityReport',
    'FeatureParityThresholds',
    'run_feature_parity',
    'write_feature_parity_report',
]
