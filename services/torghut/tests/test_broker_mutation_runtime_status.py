from __future__ import annotations

from app.trading.broker_mutation_receipts.runtime_status import (
    build_broker_mutation_runtime_status,
)


def test_unwired_runtime_reports_code_truth_without_overclaim() -> None:
    payload = build_broker_mutation_runtime_status()

    assert payload["runtime_wired"] is False
    assert payload["entry_fencing_proven"] is False
    assert payload["reduction_fencing_proven"] is False
    assert payload["recovery_degraded"] is True
    assert payload["schema_version"] == "torghut.broker-mutation-runtime-status.v1"
    assert payload["reason_codes"] == ["broker_mutation_receipts_unwired"]
