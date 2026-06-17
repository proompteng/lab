"""Trading scheduler governance, autonomy, and safety workflows."""

from __future__ import annotations

import json
import logging
import os
import tempfile
from collections.abc import Mapping, Sequence
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any, Literal, Optional, cast

from ....config import settings
from ...autonomy import (
    DriftThresholds,
    DriftTriggerPolicy,
    decide_drift_action,
    detect_drift,
    evaluate_live_promotion_evidence,
    evaluate_evidence_continuity,
    run_autonomous_lane,
    upsert_autonomy_no_signal_run,
)
from ...autonomy.phase_manifest_contract import (
    build_phase_manifest_payload_with_runtime_and_rollback,
    coerce_path_strings,
)
from ...feature_quality import FeatureQualityThresholds, evaluate_feature_batch_quality
from ...ingest import SignalBatch
from ...models import SignalEnvelope
from ...time_source import trading_now
from ..pipeline import TradingPipeline
from ..safety import (
    FRESH_TAIL_NO_SIGNAL_REASONS as _FRESH_TAIL_NO_SIGNAL_REASONS,
    coerce_recovery_reason_sequence as _coerce_recovery_reason_sequence,
    is_market_session_open as _is_market_session_open,
    is_recoverable_emergency_stop_reason as _is_recoverable_emergency_stop_reason,
    latch_signal_continuity_alert_state as _latch_signal_continuity_alert_state,
    merge_emergency_stop_reasons as _merge_emergency_stop_reasons,
    record_signal_continuity_recovery_cycle as _record_signal_continuity_recovery_cycle,
    signal_bootstrap_grace_active as _signal_bootstrap_grace_active,
    signal_tail_is_fresh as _signal_tail_is_fresh,
    split_emergency_stop_reasons as _split_emergency_stop_reasons,
)
from ..state import TradingState


logger = logging.getLogger(__name__)


def _resolve_autonomy_artifact_root(raw_root: Path) -> Path:
    preferred_root = raw_root.expanduser()
    system_temp_root = Path(tempfile.gettempdir())
    fallback_roots = [
        system_temp_root / "torghut" / "autonomy",
        system_temp_root / "torghut",
        system_temp_root,
    ]

    for root in [preferred_root, *fallback_roots]:
        try:
            root.mkdir(parents=True, exist_ok=True)
            test_file = root / ".autonomy-write-check"
            test_file.write_text("ok", encoding="utf-8")
            try:
                test_file.unlink(missing_ok=True)
            except OSError:
                pass
            return root
        except OSError as exc:
            if root == preferred_root:
                logger.warning(
                    "Autonomy artifact root not writable at %s; trying fallback (%s)",
                    preferred_root,
                    exc,
                )
            elif root in fallback_roots:
                logger.warning(
                    "Autonomy artifact fallback root not writable at %s; trying next fallback (%s)",
                    root,
                    exc,
                )
    raise RuntimeError("unable_to_resolve_autonomy_artifact_root")


def _int_from_mapping(payload: Mapping[str, Any], key: str) -> int:
    value = payload.get(key)
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        stripped = value.strip()
        if stripped:
            try:
                return int(stripped)
            except ValueError:
                return 0
    return 0


def _incident_payload_complete(payload: Mapping[str, Any]) -> bool:
    keys = (
        "triggered_at",
        "reasons",
        "rollback_hooks",
        "safety_snapshot",
        "provenance",
        "verification",
    )
    for key in keys:
        if key not in payload:
            return False
    reasons = payload.get("reasons")
    rollback_hooks = payload.get("rollback_hooks")
    safety_snapshot = payload.get("safety_snapshot")
    if not isinstance(reasons, list) or not reasons:
        return False
    if not isinstance(rollback_hooks, Mapping):
        return False
    if not isinstance(safety_snapshot, Mapping):
        return False
    return True


def _parse_iso_datetime(raw: str) -> datetime | None:
    text = raw.strip()
    if not text:
        return None
    normalized = text.replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed


class _TradingSchedulerGovernanceMixinFields:
    state: TradingState

    _pipeline: Optional[TradingPipeline]

    _pipelines: list[TradingPipeline]


resolve_autonomy_artifact_root = _resolve_autonomy_artifact_root

__all__ = (
    "logger",
    "resolve_autonomy_artifact_root",
)

# Public aliases used by split modules.
incident_payload_complete = _incident_payload_complete
int_from_mapping = _int_from_mapping
parse_iso_datetime = _parse_iso_datetime
TradingSchedulerGovernanceMixinFields = _TradingSchedulerGovernanceMixinFields


# Explicit barrel exports; keeps re-export imports intentional without file-level Ruff ignores.
__all__: tuple[str, ...] = (
    "Any",
    "Decimal",
    "DriftThresholds",
    "DriftTriggerPolicy",
    "FeatureQualityThresholds",
    "Literal",
    "Mapping",
    "Optional",
    "Path",
    "Sequence",
    "SignalBatch",
    "SignalEnvelope",
    "TradingPipeline",
    "TradingSchedulerGovernanceMixinFields",
    "TradingState",
    "_FRESH_TAIL_NO_SIGNAL_REASONS",
    "_TradingSchedulerGovernanceMixinFields",
    "_coerce_recovery_reason_sequence",
    "_incident_payload_complete",
    "_int_from_mapping",
    "_is_market_session_open",
    "_is_recoverable_emergency_stop_reason",
    "_latch_signal_continuity_alert_state",
    "_merge_emergency_stop_reasons",
    "_parse_iso_datetime",
    "_record_signal_continuity_recovery_cycle",
    "_resolve_autonomy_artifact_root",
    "_signal_bootstrap_grace_active",
    "_signal_tail_is_fresh",
    "_split_emergency_stop_reasons",
    "annotations",
    "build_phase_manifest_payload_with_runtime_and_rollback",
    "cast",
    "coerce_path_strings",
    "datetime",
    "decide_drift_action",
    "detect_drift",
    "evaluate_evidence_continuity",
    "evaluate_feature_batch_quality",
    "evaluate_live_promotion_evidence",
    "incident_payload_complete",
    "int_from_mapping",
    "json",
    "logger",
    "logging",
    "os",
    "parse_iso_datetime",
    "resolve_autonomy_artifact_root",
    "run_autonomous_lane",
    "settings",
    "tempfile",
    "timedelta",
    "timezone",
    "trading_now",
    "upsert_autonomy_no_signal_run",
)
