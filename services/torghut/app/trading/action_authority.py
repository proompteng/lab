"""Typed action-specific authority projections for the trading runtime."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import cast

OPERATIONAL_SUBMISSION_GATE_SCHEMA_VERSION = "torghut.operational-submission-gate.v2"
BROKER_MUTATION_RUNTIME_STATUS_SCHEMA_VERSION = (
    "torghut.broker-mutation-runtime-status.v1"
)
RUNTIME_ACTION_AUTHORITY_SCHEMA_VERSION = "torghut.runtime-action-authority.v1"
RUNTIME_ACTION_AUTHORITY_POLICY_REVISION = "p0-capital-freeze-economic-parity.v2"

_REDUCTION_BLOCKERS = frozenset(
    {
        "broker_unavailable",
        "kill_switch_enabled",
        "live_submit_disabled",
        "mainnet_route_unavailable",
        "submit_disabled",
        "trading_disabled",
    }
)


@dataclass(frozen=True, slots=True)
class _SubmissionRouteProjection:
    """Operational route facts before mutation-fencing authority is applied."""

    entry_allowed: bool
    reduce_only_allowed: bool
    recovery_degraded: bool
    reason_codes: Mapping[str, tuple[str, ...]]


@dataclass(frozen=True, slots=True)
class RuntimeActionAuthority:
    """Service and capital projections published to operators."""

    service_healthy: bool
    entry_allowed: bool
    reduce_only_allowed: bool
    recovery_degraded: bool
    reason_codes: Mapping[str, tuple[str, ...]]
    evaluated_at: datetime
    policy_revision: str = RUNTIME_ACTION_AUTHORITY_POLICY_REVISION
    schema_version: str = RUNTIME_ACTION_AUTHORITY_SCHEMA_VERSION

    def to_payload(self) -> dict[str, object]:
        return {
            "schema_version": self.schema_version,
            "policy_revision": self.policy_revision,
            "evaluated_at": self.evaluated_at.isoformat(),
            "service_healthy": self.service_healthy,
            "entry_allowed": self.entry_allowed,
            "reduce_only_allowed": self.reduce_only_allowed,
            "recovery_degraded": self.recovery_degraded,
            "reason_codes": {
                name: list(reasons) for name, reasons in self.reason_codes.items()
            },
        }


def _reduce_submission_route(
    *,
    live_submission_gate: Mapping[str, object],
    state: object,
) -> _SubmissionRouteProjection:
    """Project route availability without pretending mutation safety is wired."""

    if not _valid_gate_contract(live_submission_gate):
        invalid = ("live_submission_gate_contract_invalid",)
        return _SubmissionRouteProjection(
            entry_allowed=False,
            reduce_only_allowed=False,
            recovery_degraded=True,
            reason_codes={
                "entry": invalid,
                "reduce_only": invalid,
                "recovery": invalid,
            },
        )

    blocked_reasons = _strings(live_submission_gate.get("blocked_reasons"))
    entry_reasons: list[str] = []
    if live_submission_gate.get("allowed") is not True:
        entry_reasons.extend(
            blocked_reasons
            or _strings(live_submission_gate.get("reason"))
            or ("operational_submission_blocked",)
        )
    if live_submission_gate.get("new_exposure_allowed") is not True:
        entry_reasons.append("new_exposure_cutoff_active")

    route = _mapping(live_submission_gate.get("execution_route"))
    reduction_reasons = [
        reason for reason in blocked_reasons if reason in _REDUCTION_BLOCKERS
    ]
    if route.get("route") != "alpaca":
        reduction_reasons.append("mainnet_route_unavailable")

    recovery_reasons: list[str] = []
    if bool(getattr(state, "capital_closeout_in_progress", False)):
        recovery_reasons.append("capital_closeout_in_progress")
    if bool(getattr(state, "emergency_stop_active", False)):
        recovery_reasons.append("emergency_stop_active")
    if "broker_unavailable" in blocked_reasons:
        recovery_reasons.append("broker_unavailable")

    entry_codes = _unique(entry_reasons)
    reduction_codes = _unique(reduction_reasons)
    recovery_codes = _unique(recovery_reasons)
    return _SubmissionRouteProjection(
        entry_allowed=not entry_codes,
        reduce_only_allowed=not reduction_codes,
        recovery_degraded=bool(recovery_codes),
        reason_codes={
            "entry": entry_codes,
            "reduce_only": reduction_codes,
            "recovery": recovery_codes,
        },
    )


def reduce_runtime_action_authority(
    *,
    service_status: Mapping[str, object],
    live_submission_gate: Mapping[str, object],
    broker_mutation_status: Mapping[str, object],
    state: object,
    broker_economic_ledger_status: Mapping[str, object] | None = None,
    accounting_parity_required: bool = False,
    evaluated_at: datetime | None = None,
) -> RuntimeActionAuthority:
    """Combine process health with action-specific submission authority."""

    observed_at = evaluated_at or datetime.now(timezone.utc)
    if observed_at.tzinfo is None:
        raise ValueError("runtime_action_authority_timestamp_must_be_timezone_aware")

    service_healthy = service_status.get("ok") is True
    service_reasons = () if service_healthy else (_service_reason(service_status),)
    submission = _reduce_submission_route(
        live_submission_gate=live_submission_gate,
        state=state,
    )
    mutation_entry_reasons = _mutation_authority_reasons(
        broker_mutation_status,
        required_field="entry_fencing_proven",
        fallback_reason="broker_mutation_entry_fencing_unproven",
    )
    mutation_reduction_reasons = _mutation_authority_reasons(
        broker_mutation_status,
        required_field="reduction_fencing_proven",
        fallback_reason="broker_mutation_reduction_fencing_unproven",
    )
    mutation_recovery_reasons = _mutation_recovery_reasons(broker_mutation_status)
    accounting_entry_reasons = _accounting_parity_reasons(
        broker_economic_ledger_status,
        required=accounting_parity_required,
    )
    entry_reasons = _unique(
        (
            *service_reasons,
            *submission.reason_codes["entry"],
            *mutation_entry_reasons,
            *mutation_recovery_reasons,
            *accounting_entry_reasons,
        )
    )
    reduction_reasons = _unique(
        (
            *service_reasons,
            *submission.reason_codes["reduce_only"],
            *mutation_reduction_reasons,
        )
    )
    recovery_reasons = _unique(
        (
            *service_reasons,
            *submission.reason_codes["recovery"],
            *mutation_recovery_reasons,
        )
    )
    return RuntimeActionAuthority(
        service_healthy=service_healthy,
        entry_allowed=not entry_reasons,
        reduce_only_allowed=not reduction_reasons,
        recovery_degraded=bool(recovery_reasons),
        reason_codes={
            "service": service_reasons,
            "entry": entry_reasons,
            "reduce_only": reduction_reasons,
            "recovery": recovery_reasons,
        },
        evaluated_at=observed_at,
    )


def _accounting_parity_reasons(
    status: Mapping[str, object] | None,
    *,
    required: bool,
) -> tuple[str, ...]:
    if not required:
        return ()
    invalid = ("broker_economic_accounting_parity_status_invalid",)
    if status is None or status.get("schema_version") != (
        "torghut.broker-economic-ledger-status.v1"
    ):
        return invalid
    satisfied = status.get("entry_dependency_satisfied")
    reason_codes = status.get("reason_codes")
    if (
        not isinstance(satisfied, bool)
        or not isinstance(reason_codes, Sequence)
        or isinstance(
            reason_codes,
            (str, bytes, bytearray),
        )
    ):
        return invalid
    reason_items = cast(Sequence[object], reason_codes)
    if any(not isinstance(item, str) for item in reason_items):
        return invalid
    if satisfied:
        return ()
    reasons = _strings(reason_items)
    return reasons or ("broker_economic_accounting_parity_unproven",)


def _valid_gate_contract(gate: Mapping[str, object]) -> bool:
    route = gate.get("execution_route")
    blocked = gate.get("blocked_reasons")
    return (
        gate.get("schema_version") == OPERATIONAL_SUBMISSION_GATE_SCHEMA_VERSION
        and isinstance(gate.get("allowed"), bool)
        and isinstance(gate.get("new_exposure_allowed"), bool)
        and isinstance(route, Mapping)
        and isinstance(cast(Mapping[object, object], route).get("route"), str)
        and isinstance(blocked, Sequence)
        and not isinstance(blocked, (str, bytes, bytearray))
        and all(isinstance(reason, str) for reason in cast(Sequence[object], blocked))
    )


def _valid_mutation_status(status: Mapping[str, object]) -> bool:
    reason_codes = status.get("reason_codes")
    return (
        status.get("schema_version") == BROKER_MUTATION_RUNTIME_STATUS_SCHEMA_VERSION
        and all(
            isinstance(status.get(field), bool)
            for field in (
                "runtime_wired",
                "entry_fencing_proven",
                "reduction_fencing_proven",
                "recovery_worker_wired",
                "recovery_degraded",
            )
        )
        and isinstance(reason_codes, Sequence)
        and not isinstance(reason_codes, (str, bytes, bytearray))
        and all(
            isinstance(reason, str) for reason in cast(Sequence[object], reason_codes)
        )
    )


def _mutation_authority_reasons(
    status: Mapping[str, object],
    *,
    required_field: str,
    fallback_reason: str,
) -> tuple[str, ...]:
    if not _valid_mutation_status(status):
        return ("broker_mutation_status_contract_invalid",)
    if status.get("database_status") != "current":
        return ("broker_mutation_database_status_not_current",)
    if required_field == "entry_fencing_proven":
        unresolved_count = status.get("unresolved_receipt_count")
        if (
            not isinstance(unresolved_count, int)
            or isinstance(unresolved_count, bool)
            or unresolved_count < 0
        ):
            return ("broker_mutation_status_contract_invalid",)
        if unresolved_count > 0:
            return _unresolved_mutation_reasons(status, unresolved_count)
    if status.get("runtime_wired") is True and status.get(required_field) is True:
        return ()
    return _strings(status.get("reason_codes")) or (fallback_reason,)


def _unresolved_mutation_reasons(
    status: Mapping[str, object],
    unresolved_count: int,
) -> tuple[str, ...]:
    submit_count = status.get("unresolved_submit_receipt_count")
    reduction_count = status.get("unresolved_reduction_receipt_count")
    if submit_count is None and reduction_count is None:
        return ("broker_mutation_submit_unresolved",)
    if any(
        not isinstance(value, int) or isinstance(value, bool) or value < 0
        for value in (submit_count, reduction_count)
    ):
        return ("broker_mutation_status_contract_invalid",)
    assert isinstance(submit_count, int)
    assert isinstance(reduction_count, int)
    if submit_count + reduction_count != unresolved_count:
        return ("broker_mutation_status_contract_invalid",)
    return (
        *(["broker_mutation_submit_unresolved"] if submit_count > 0 else []),
        *(["broker_mutation_reduction_unresolved"] if reduction_count > 0 else []),
    )


def _mutation_recovery_reasons(
    status: Mapping[str, object],
) -> tuple[str, ...]:
    if not _valid_mutation_status(status):
        return ("broker_mutation_status_contract_invalid",)
    if (
        status.get("runtime_wired") is True
        and status.get("recovery_worker_wired") is True
        and status.get("recovery_degraded") is False
    ):
        return ()
    recovery_reasons = tuple(
        reason
        for reason in _strings(status.get("reason_codes"))
        if reason.startswith("broker_mutation_recovery_")
    )
    return recovery_reasons or ("broker_mutation_recovery_unproven",)


def _service_reason(service_status: Mapping[str, object]) -> str:
    detail = service_status.get("detail")
    if isinstance(detail, str) and detail.strip():
        return detail.strip()
    return "service_health_unavailable"


def _mapping(value: object) -> Mapping[str, object]:
    if isinstance(value, Mapping):
        return cast(Mapping[str, object], value)
    return {}


def _strings(value: object) -> tuple[str, ...]:
    if isinstance(value, str):
        normalized = value.strip()
        return (normalized,) if normalized else ()
    if isinstance(value, Sequence) and not isinstance(value, (bytes, bytearray)):
        return tuple(
            normalized
            for item in cast(Sequence[object], value)
            if (normalized := str(item).strip())
        )
    return ()


def _unique(values: Sequence[str]) -> tuple[str, ...]:
    return tuple(dict.fromkeys(value for value in values if value))


__all__ = [
    "BROKER_MUTATION_RUNTIME_STATUS_SCHEMA_VERSION",
    "OPERATIONAL_SUBMISSION_GATE_SCHEMA_VERSION",
    "RUNTIME_ACTION_AUTHORITY_POLICY_REVISION",
    "RUNTIME_ACTION_AUTHORITY_SCHEMA_VERSION",
    "RuntimeActionAuthority",
    "reduce_runtime_action_authority",
]
