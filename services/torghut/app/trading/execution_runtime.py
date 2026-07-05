"""Route-neutral execution status and gate helpers."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from decimal import Decimal
from typing import cast

from .submission_authority import operational_submission_gate_status

_OPERATIONAL_REJECT_REASONS = frozenset(
    {
        "broker_submit_failed",
        "invalid_order",
        "kill_switch_enabled",
        "live_submit_disabled",
        "risk_breach",
        "submit_disabled",
        "trading_disabled",
    }
)
_OPERATIONAL_REJECT_SUFFIXES = ("_unavailable",)
_OPERATIONAL_REJECT_PREFIXES = ("dependency_not_ready:",)


@dataclass(frozen=True)
class ExecutionRouteDecision:
    route: str
    reason: str
    alpaca_regular_session_open: bool
    testnet_after_hours_enabled: bool

    def to_payload(self) -> dict[str, object]:
        return {
            "route": self.route,
            "reason": self.reason,
            "alpaca_regular_session_open": self.alpaca_regular_session_open,
            "testnet_after_hours_enabled": self.testnet_after_hours_enabled,
        }


@dataclass(frozen=True)
class ExecutionGate:
    allowed: bool
    reason: str
    blocked_reasons: Sequence[str]
    route: ExecutionRouteDecision

    def to_payload(self) -> dict[str, object]:
        return {
            "allowed": self.allowed,
            "reason": self.reason,
            "blocked_reasons": list(self.blocked_reasons),
            "execution_route": self.route.to_payload(),
        }


@dataclass(frozen=True)
class ExecutionGateInputs:
    trading_enabled: bool
    submit_enabled: bool
    live_submit_enabled: bool
    kill_switch_enabled: bool
    route_available: bool
    route: ExecutionRouteDecision


@dataclass(frozen=True)
class ExecutionOrderResult:
    route: str
    symbol: str
    side: str
    notional: Decimal
    broker_order_id: str | None
    status: str
    submitted_at: str | None

    def to_payload(self) -> dict[str, object]:
        return {
            "route": self.route,
            "symbol": self.symbol,
            "side": self.side,
            "notional": str(self.notional),
            "broker_order_id": self.broker_order_id,
            "status": self.status,
            "submitted_at": self.submitted_at,
        }


def build_execution_gate(
    *,
    inputs: ExecutionGateInputs,
    diagnostics: Mapping[str, object] | None = None,
) -> ExecutionGate:
    """Build the hard operational gate.

    Diagnostics are intentionally accepted but ignored. Profit, proof, and
    runtime-ledger status must not become implicit submit authority again.
    """

    _ = diagnostics
    blocked_reasons: list[str] = []
    if not inputs.trading_enabled:
        blocked_reasons.append("trading_disabled")
    if not inputs.submit_enabled:
        blocked_reasons.append("submit_disabled")
    if not inputs.live_submit_enabled:
        blocked_reasons.append("live_submit_disabled")
    if inputs.kill_switch_enabled:
        blocked_reasons.append("kill_switch_enabled")
    if not inputs.route_available:
        blocked_reasons.append(f"{inputs.route.route}_unavailable")
    reason = blocked_reasons[0] if blocked_reasons else "operational_submission_ready"
    return ExecutionGate(
        allowed=not blocked_reasons,
        reason=reason,
        blocked_reasons=tuple(blocked_reasons),
        route=inputs.route,
    )


def build_execution_status_payload(
    *,
    state: object,
    live_submission_gate: Mapping[str, object],
) -> dict[str, object]:
    metrics = getattr(state, "metrics")
    gate = operational_submission_gate_status(live_submission_gate)
    route = _execution_route_payload(gate, live_submission_gate)
    gate_payload = {
        "allowed": bool(gate.get("allowed") is True),
        "reason": str(gate.get("reason") or "unknown"),
        "blocked_reasons": _strings(gate.get("blocked_reasons")),
        "execution_route": route,
    }
    return {
        "schema_version": "torghut.execution-status.v1",
        "route": _optional_text(route.get("route")),
        "route_reason": _optional_text(route.get("reason")),
        "route_details": route,
        "gate": gate_payload,
        "orders_submitted_total": int(getattr(metrics, "orders_submitted_total", 0)),
        "orders_rejected_total": int(getattr(metrics, "orders_rejected_total", 0)),
        "reject_reason_totals": _operational_reject_reason_totals(metrics),
        "last_submitted_order": _last_submitted_order_payload(state),
    }


def record_last_execution_order(
    *,
    state: object,
    order: ExecutionOrderResult,
) -> None:
    setattr(state, "last_execution_order", order.to_payload())


def _execution_route_payload(
    gate: Mapping[str, object],
    live_submission_gate: Mapping[str, object],
) -> dict[str, object]:
    route = _mapping(gate.get("execution_route")) or _mapping(
        live_submission_gate.get("execution_route")
    )
    return dict(route)


def _last_submitted_order_payload(state: object) -> dict[str, object] | None:
    payload = getattr(state, "last_execution_order", None)
    if isinstance(payload, Mapping):
        return dict(cast(Mapping[str, object], payload))
    return None


def _operational_reject_reason_totals(metrics: object) -> dict[str, int]:
    totals = getattr(metrics, "decision_reject_reason_total", {})
    if not isinstance(totals, Mapping):
        return {}
    output: dict[str, int] = {}
    for raw_reason, raw_count in cast(Mapping[object, object], totals).items():
        reason = _optional_text(raw_reason)
        if reason is None or not _is_operational_reject_reason(reason):
            continue
        output[reason] = _count(raw_count)
    return output


def _is_operational_reject_reason(reason: str) -> bool:
    return (
        reason in _OPERATIONAL_REJECT_REASONS
        or reason.endswith(_OPERATIONAL_REJECT_SUFFIXES)
        or reason.startswith(_OPERATIONAL_REJECT_PREFIXES)
    )


def _count(value: object) -> int:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str):
        try:
            return int(float(value))
        except ValueError:
            return 1
    return 1


def _mapping(value: object) -> Mapping[str, object]:
    if isinstance(value, Mapping):
        return cast(Mapping[str, object], value)
    return {}


def _optional_text(value: object) -> str | None:
    text = str(value).strip() if value is not None else ""
    return text or None


def _strings(value: object) -> list[str]:
    if not isinstance(value, list):
        return []
    strings: list[str] = []
    for item in cast(list[object], value):
        text = _optional_text(item)
        if text:
            strings.append(text)
    return strings


__all__ = [
    "ExecutionGate",
    "ExecutionGateInputs",
    "ExecutionOrderResult",
    "ExecutionRouteDecision",
    "build_execution_gate",
    "build_execution_status_payload",
    "record_last_execution_order",
]
