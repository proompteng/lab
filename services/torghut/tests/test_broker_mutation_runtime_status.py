from __future__ import annotations

from app.trading.broker_mutation_receipts.runtime_status import (
    build_broker_mutation_runtime_status,
    unavailable_broker_mutation_runtime_status,
)


def test_entry_wiring_reports_code_truth_without_overclaim() -> None:
    payload = build_broker_mutation_runtime_status()

    assert payload["runtime_wired"] is True
    assert payload["entry_fencing_proven"] is True
    assert payload["reduction_fencing_proven"] is False
    assert payload["recovery_degraded"] is True
    assert payload["schema_version"] == "torghut.broker-mutation-runtime-status.v1"
    assert payload["recovery_worker_wired"] is False
    assert payload["reason_codes"] == [
        "broker_mutation_reduction_fencing_unproven",
        "broker_mutation_recovery_unproven",
    ]


def test_database_status_unavailability_fails_entry_capability_closed() -> None:
    payload = unavailable_broker_mutation_runtime_status()

    assert payload["runtime_wired"] is True
    assert payload["entry_fencing_proven"] is False
    assert payload["database_status"] == "unavailable"
    assert payload["reason_codes"][0] == "broker_mutation_database_status_unavailable"
