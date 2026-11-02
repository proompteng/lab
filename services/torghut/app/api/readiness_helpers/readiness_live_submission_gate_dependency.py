from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import cast


def readiness_live_submission_gate_dependency(
    live_submission_gate: Mapping[str, object],
    *,
    startup_readiness_grace_active: bool = False,
) -> dict[str, object]:
    clickhouse_ta_freshness = live_submission_gate.get("clickhouse_ta_freshness")
    freshness = (
        cast(Mapping[str, object], clickhouse_ta_freshness)
        if isinstance(clickhouse_ta_freshness, Mapping)
        else cast(Mapping[str, object], {})
    )
    allowed = bool(live_submission_gate.get("allowed", False))
    startup_grace_suppressed = startup_readiness_grace_suppresses_live_gate(
        live_submission_gate,
        startup_readiness_grace_active=startup_readiness_grace_active,
    )
    payload: dict[str, object] = {
        "ok": allowed or startup_grace_suppressed,
        "detail": str(live_submission_gate.get("reason") or "unknown"),
        "capital_stage": live_submission_gate.get("capital_stage"),
        "accepted_source_state": freshness.get("accepted_source_state"),
        "accepted_lag_seconds": freshness.get("accepted_lag_seconds"),
        "accepted_max_lag_seconds": freshness.get("accepted_max_lag_seconds"),
        "blocking_reason": freshness.get("blocking_reason"),
    }
    if startup_grace_suppressed:
        payload["startup_readiness_grace_active"] = True
        payload["readiness_gate_suppressed"] = str(
            live_submission_gate.get("reason") or "live_submission_gate_blocked"
        )
    return payload


_STARTUP_READINESS_GRACE_LIVE_GATE_REASONS = frozenset(
    {
        "trading_loop_startup_readiness_grace_active",
        "trading_loop_starting",
        "trading_loop_not_running",
        "trading_scheduler_starting",
        "scheduler_startup_grace_active",
    }
)


def startup_readiness_grace_suppresses_live_gate(
    live_submission_gate: Mapping[str, object],
    *,
    startup_readiness_grace_active: bool,
) -> bool:
    if not startup_readiness_grace_active:
        return False
    if bool(live_submission_gate.get("allowed", False)):
        return False
    reason = str(live_submission_gate.get("reason") or "").strip()
    blocked_reasons = live_submission_gate.get("blocked_reasons")
    reasons: set[str] = set()
    if reason:
        reasons.add(reason)
    if isinstance(blocked_reasons, Sequence) and not isinstance(
        blocked_reasons, (str, bytes, bytearray)
    ):
        for raw_reason in cast(Sequence[object], blocked_reasons):
            blocked_reason = str(raw_reason).strip()
            if blocked_reason:
                reasons.add(blocked_reason)
    return bool(reasons) and reasons <= _STARTUP_READINESS_GRACE_LIVE_GATE_REASONS
