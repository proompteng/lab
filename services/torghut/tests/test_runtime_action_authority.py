from __future__ import annotations

from datetime import datetime, timezone
from types import SimpleNamespace

from app.trading.action_authority import reduce_runtime_action_authority


_NOW = datetime(2026, 7, 14, 12, 0, tzinfo=timezone.utc)


def _service(*, ok: bool = True, detail: str = "ok") -> dict[str, object]:
    return {"ok": ok, "detail": detail}


def _gate(**overrides: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "schema_version": "torghut.operational-submission-gate.v2",
        "allowed": True,
        "reason": "operational_submission_ready",
        "blocked_reasons": [],
        "new_exposure_allowed": True,
        "execution_route": {
            "route": "alpaca",
            "reason": "alpaca_regular_session_open",
        },
    }
    payload.update(overrides)
    return payload


def _state(**overrides: object) -> SimpleNamespace:
    payload: dict[str, object] = {
        "capital_closeout_in_progress": False,
        "emergency_stop_active": False,
    }
    payload.update(overrides)
    return SimpleNamespace(**payload)


def _mutation_status(**overrides: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "schema_version": "torghut.broker-mutation-runtime-status.v1",
        "runtime_wired": True,
        "entry_fencing_proven": True,
        "reduction_fencing_proven": True,
        "recovery_worker_wired": True,
        "recovery_degraded": False,
        "database_status": "current",
        "unresolved_receipt_count": 0,
        "reason_codes": [],
    }
    payload.update(overrides)
    return payload


def _economic_ledger_status(**overrides: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "schema_version": "torghut.broker-economic-ledger-status.v1",
        "entry_dependency_satisfied": True,
        "reason_codes": [],
    }
    payload.update(overrides)
    return payload


def test_required_accounting_parity_blocks_entry_only() -> None:
    authority = reduce_runtime_action_authority(
        service_status=_service(),
        live_submission_gate=_gate(),
        broker_mutation_status=_mutation_status(),
        broker_economic_ledger_status=_economic_ledger_status(
            entry_dependency_satisfied=False,
            reason_codes=["tigerbeetle_economic_transfer_missing"],
        ),
        accounting_parity_required=True,
        state=_state(),
        evaluated_at=_NOW,
    )

    assert authority.service_healthy is True
    assert authority.entry_allowed is False
    assert authority.reduce_only_allowed is True
    assert authority.recovery_degraded is False
    assert authority.reason_codes["entry"] == ("tigerbeetle_economic_transfer_missing",)
    assert authority.reason_codes["reduce_only"] == ()


def test_current_accounting_parity_satisfies_required_entry_dependency() -> None:
    authority = reduce_runtime_action_authority(
        service_status=_service(),
        live_submission_gate=_gate(),
        broker_mutation_status=_mutation_status(),
        broker_economic_ledger_status=_economic_ledger_status(),
        accounting_parity_required=True,
        state=_state(),
        evaluated_at=_NOW,
    )

    assert authority.entry_allowed is True


def test_required_accounting_parity_fails_closed_on_malformed_status() -> None:
    authority = reduce_runtime_action_authority(
        service_status=_service(),
        live_submission_gate=_gate(),
        broker_mutation_status=_mutation_status(),
        broker_economic_ledger_status={"entry_dependency_satisfied": True},
        accounting_parity_required=True,
        state=_state(),
        evaluated_at=_NOW,
    )

    assert authority.entry_allowed is False
    assert authority.reduce_only_allowed is True
    assert authority.reason_codes["entry"] == (
        "broker_economic_accounting_parity_status_invalid",
    )


def test_capital_freeze_separates_service_entry_and_reduction_authority() -> None:
    authority = reduce_runtime_action_authority(
        service_status=_service(),
        live_submission_gate=_gate(new_exposure_allowed=False),
        broker_mutation_status=_mutation_status(),
        state=_state(),
        evaluated_at=_NOW,
    )

    assert authority.service_healthy is True
    assert authority.entry_allowed is False
    assert authority.reduce_only_allowed is True
    assert authority.recovery_degraded is False
    assert authority.reason_codes["entry"] == ("new_exposure_cutoff_active",)
    assert authority.evaluated_at == _NOW


def test_entry_data_blocker_does_not_disable_reduction_authority() -> None:
    authority = reduce_runtime_action_authority(
        service_status=_service(),
        live_submission_gate=_gate(
            allowed=False,
            reason="accepted_ta_signal_stale",
            blocked_reasons=["accepted_ta_signal_stale"],
        ),
        broker_mutation_status=_mutation_status(),
        state=_state(),
        evaluated_at=_NOW,
    )

    assert authority.entry_allowed is False
    assert authority.reduce_only_allowed is True
    assert authority.reason_codes["entry"] == ("accepted_ta_signal_stale",)
    assert authority.reason_codes["reduce_only"] == ()


def test_global_submission_switch_blocks_reduction_authority() -> None:
    authority = reduce_runtime_action_authority(
        service_status=_service(),
        live_submission_gate=_gate(
            allowed=False,
            reason="submit_disabled",
            blocked_reasons=["submit_disabled"],
        ),
        broker_mutation_status=_mutation_status(),
        state=_state(),
        evaluated_at=_NOW,
    )

    assert authority.entry_allowed is False
    assert authority.reduce_only_allowed is False
    assert authority.reason_codes["reduce_only"] == ("submit_disabled",)


def test_missing_or_malformed_gate_fails_closed() -> None:
    authority = reduce_runtime_action_authority(
        service_status=_service(),
        live_submission_gate={"allowed": True},
        broker_mutation_status=_mutation_status(),
        state=_state(),
        evaluated_at=_NOW,
    )

    assert authority.service_healthy is True
    assert authority.entry_allowed is False
    assert authority.reduce_only_allowed is False
    assert authority.reason_codes["entry"] == ("live_submission_gate_contract_invalid",)


def test_unhealthy_service_blocks_actions_and_marks_recovery_degraded() -> None:
    authority = reduce_runtime_action_authority(
        service_status=_service(ok=False, detail="scheduler_reconcile_success_stale"),
        live_submission_gate=_gate(),
        broker_mutation_status=_mutation_status(),
        state=_state(),
        evaluated_at=_NOW,
    )

    assert authority.service_healthy is False
    assert authority.entry_allowed is False
    assert authority.reduce_only_allowed is False
    assert authority.recovery_degraded is True
    assert authority.reason_codes["service"] == ("scheduler_reconcile_success_stale",)


def test_emergency_stop_preserves_reduction_but_requires_recovery() -> None:
    authority = reduce_runtime_action_authority(
        service_status=_service(),
        live_submission_gate=_gate(
            allowed=False,
            reason="emergency_stop_active",
            blocked_reasons=["emergency_stop_active"],
            new_exposure_allowed=False,
        ),
        broker_mutation_status=_mutation_status(),
        state=_state(emergency_stop_active=True),
        evaluated_at=_NOW,
    )

    assert authority.entry_allowed is False
    assert authority.reduce_only_allowed is True
    assert authority.recovery_degraded is True
    assert authority.reason_codes["recovery"] == ("emergency_stop_active",)


def test_unwired_mutation_runtime_cannot_claim_entry_or_reduction_safety() -> None:
    authority = reduce_runtime_action_authority(
        service_status=_service(),
        live_submission_gate=_gate(),
        broker_mutation_status=_mutation_status(
            runtime_wired=False,
            entry_fencing_proven=False,
            reduction_fencing_proven=False,
            recovery_worker_wired=False,
            recovery_degraded=True,
            reason_codes=["broker_mutation_receipts_unwired"],
        ),
        state=_state(),
        evaluated_at=_NOW,
    )

    assert authority.service_healthy is True
    assert authority.entry_allowed is False
    assert authority.reduce_only_allowed is False
    assert authority.recovery_degraded is True
    assert authority.reason_codes["entry"] == (
        "broker_mutation_receipts_unwired",
        "broker_mutation_recovery_unproven",
    )
    assert authority.reason_codes["reduce_only"] == (
        "broker_mutation_receipts_unwired",
    )


def test_unresolved_submit_blocks_new_entry_without_disabling_reduction() -> None:
    authority = reduce_runtime_action_authority(
        service_status=_service(),
        live_submission_gate=_gate(),
        broker_mutation_status=_mutation_status(unresolved_receipt_count=1),
        state=_state(),
        evaluated_at=_NOW,
    )

    assert authority.entry_allowed is False
    assert authority.reduce_only_allowed is True
    assert authority.reason_codes["entry"] == ("broker_mutation_submit_unresolved",)


def test_unresolved_receipt_reason_preserves_operation_truth() -> None:
    authority = reduce_runtime_action_authority(
        service_status=_service(),
        live_submission_gate=_gate(),
        broker_mutation_status=_mutation_status(
            unresolved_receipt_count=2,
            unresolved_submit_receipt_count=1,
            unresolved_reduction_receipt_count=1,
        ),
        state=_state(),
        evaluated_at=_NOW,
    )

    assert authority.entry_allowed is False
    assert authority.reduce_only_allowed is True
    assert authority.reason_codes["entry"] == (
        "broker_mutation_submit_unresolved",
        "broker_mutation_reduction_unresolved",
    )


def test_disabled_recovery_blocks_new_entry_without_disabling_reduction() -> None:
    authority = reduce_runtime_action_authority(
        service_status=_service(),
        live_submission_gate=_gate(),
        broker_mutation_status=_mutation_status(
            recovery_degraded=True,
            reason_codes=["broker_mutation_recovery_disabled"],
        ),
        state=_state(),
        evaluated_at=_NOW,
    )

    assert authority.entry_allowed is False
    assert authority.reduce_only_allowed is True
    assert authority.recovery_degraded is True
    assert authority.reason_codes["entry"] == ("broker_mutation_recovery_disabled",)
    assert authority.reason_codes["recovery"] == ("broker_mutation_recovery_disabled",)


def test_mutations_require_current_durable_receipt_readback() -> None:
    authority = reduce_runtime_action_authority(
        service_status=_service(),
        live_submission_gate=_gate(),
        broker_mutation_status=_mutation_status(
            database_status="not_checked",
            unresolved_receipt_count=None,
        ),
        state=_state(),
        evaluated_at=_NOW,
    )

    assert authority.entry_allowed is False
    assert authority.reduce_only_allowed is False
    assert authority.reason_codes["entry"] == (
        "broker_mutation_database_status_not_current",
    )
    assert authority.reason_codes["reduce_only"] == (
        "broker_mutation_database_status_not_current",
    )


def test_entry_rejects_missing_unresolved_count_after_current_readback() -> None:
    authority = reduce_runtime_action_authority(
        service_status=_service(),
        live_submission_gate=_gate(),
        broker_mutation_status=_mutation_status(unresolved_receipt_count=None),
        state=_state(),
        evaluated_at=_NOW,
    )

    assert authority.entry_allowed is False
    assert authority.reason_codes["entry"] == (
        "broker_mutation_status_contract_invalid",
    )


def test_unwired_runtime_cannot_enable_actions_with_incoherent_fencing_flags() -> None:
    authority = reduce_runtime_action_authority(
        service_status=_service(),
        live_submission_gate=_gate(),
        broker_mutation_status=_mutation_status(
            runtime_wired=False,
            entry_fencing_proven=True,
            reduction_fencing_proven=True,
            reason_codes=[],
        ),
        state=_state(),
        evaluated_at=_NOW,
    )

    assert authority.entry_allowed is False
    assert authority.reduce_only_allowed is False
    assert authority.reason_codes["entry"] == (
        "broker_mutation_entry_fencing_unproven",
        "broker_mutation_recovery_unproven",
    )
