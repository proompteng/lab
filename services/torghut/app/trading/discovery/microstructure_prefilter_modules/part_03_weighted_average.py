# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportPrivateUsage=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
"""Bounded H-PAIRS ClusterLOB/OFI candidate prefiltering.

The scores in this module are discovery metadata only. They intentionally rank
candidate specs for a bounded exact-replay handoff and never create promotion
or runtime-ledger authority.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import timezone
from decimal import Decimal
from math import exp, isfinite, log, sqrt
from typing import Any, cast

import numpy as np
from numpy.typing import NDArray

from app.trading.discovery.candidate_specs import CandidateSpec
from app.trading.models import SignalEnvelope

# ruff: noqa: F401,F403,F405,F811,F821

from .part_01_statements_24 import *
from .part_02_horizon_ofi_features import *


def _weighted_average(values: Sequence[tuple[float, int]]) -> float:
    total_weight = sum(max(0, weight) for _, weight in values)
    if total_weight <= 0:
        return 0.0
    return sum(value * max(0, weight) for value, weight in values) / total_weight


def _ewma_last(values: NDArray[np.float64], *, half_life: float) -> float:
    if values.size == 0:
        return 0.0
    decay = log(2.0) / max(1.0, half_life)
    total = 0.0
    weighted = 0.0
    for distance, value in enumerate(reversed(values.tolist())):
        weight = exp(-decay * float(distance))
        total += weight
        weighted += float(value) * weight
    if total <= 0.0:
        return 0.0
    return float(np.clip(weighted / total, -1.0, 1.0))


def _normalized_entropy(labels: Sequence[str]) -> float:
    clean = [label for label in labels if label and label != "unknown"]
    if not clean:
        return 0.0
    counts = Counter(clean)
    if len(counts) <= 1:
        return 0.0
    probabilities = np.asarray(
        [count / len(clean) for count in counts.values()], dtype=np.float64
    )
    entropy = -float(np.sum(probabilities * np.log(probabilities)))
    return float(np.clip(entropy / np.log(len(counts)), 0.0, 1.0))


def _dominant_label(labels: Sequence[str]) -> str:
    clean = [label for label in labels if label and label != "unknown"]
    if not clean:
        return "unknown"
    return sorted(Counter(clean).items(), key=lambda item: (-item[1], item[0]))[0][0]


def _concat_arrays(arrays: Sequence[NDArray[np.float64]]) -> NDArray[np.float64]:
    non_empty = [array for array in arrays if array.size]
    if not non_empty:
        return np.asarray([], dtype=np.float64)
    return np.concatenate(non_empty)


def _first_float_with_key(
    payload: Mapping[str, Any], keys: Sequence[str], *, positive: bool = False
) -> tuple[float | None, str | None]:
    for key in keys:
        value = _float_or_none(payload.get(key))
        if value is None:
            continue
        if positive and value <= 0.0:
            continue
        return value, key
    return None, None


def _float_or_none(value: Any) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    if not isfinite(parsed):
        return None
    return parsed


def _mean(values: NDArray[np.float64]) -> float:
    return float(np.mean(values)) if values.size else 0.0


def _percentile(values: NDArray[np.float64], percentile: float) -> float:
    return float(np.percentile(values, percentile)) if values.size else 0.0


def _decimal(value: float) -> Decimal:
    return Decimal(str(round(float(value), 8)))


def _mapping(value: Any) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        return {}
    mapping = cast(Mapping[Any, Any], value)
    return {str(key): item for key, item in mapping.items()}


def _string(value: Any) -> str:
    return str(value or "").strip()


__all__ = [
    "HPAIRS_AUTHORITY_BLOCKERS",
    "HPAIRS_FAMILY_TEMPLATE_ID",
    "HPAIRS_PREFILTER_PROOF_SEMANTICS_LABEL",
    "HPAIRS_PREFILTER_PROOF_SOURCE",
    "HPAIRS_PREFILTER_ROW_SCHEMA_VERSION",
    "HPAIRS_PREFILTER_SCHEMA_VERSION",
    "HPAIRS_RUNTIME_STRATEGY_NAME",
    "MicrostructureCandidatePrefilterRow",
    "MicrostructurePrefilterResult",
    "build_hpairs_microstructure_prefilter",
]


__all__ = [name for name in globals() if not name.startswith("__")]
