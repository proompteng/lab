from __future__ import annotations

from app.trading.broker_mutation_receipts.runtime_status import (
    build_broker_mutation_runtime_status,
    unavailable_broker_mutation_runtime_status,
)


def test_mutation_wiring_reports_proven_code_truth() -> None:
    payload = build_broker_mutation_runtime_status()

    assert payload["runtime_wired"] is True
    assert payload["entry_fencing_proven"] is True
    assert payload["reduction_fencing_proven"] is True
    assert payload["recovery_degraded"] is False
    assert payload["schema_version"] == "torghut.broker-mutation-runtime-status.v1"
    assert payload["recovery_worker_wired"] is True
    assert payload["recovery_worker_enabled"] is True
    assert payload["reason_codes"] == []


def test_database_status_unavailability_fails_entry_capability_closed() -> None:
    payload = unavailable_broker_mutation_runtime_status()

    assert payload["runtime_wired"] is True
    assert payload["entry_fencing_proven"] is False
    assert payload["reduction_fencing_proven"] is False
    assert payload["recovery_degraded"] is True
    assert payload["database_status"] == "unavailable"
    assert payload["reason_codes"][:2] == [
        "broker_mutation_database_status_unavailable",
        "broker_mutation_recovery_database_status_unavailable",
    ]
