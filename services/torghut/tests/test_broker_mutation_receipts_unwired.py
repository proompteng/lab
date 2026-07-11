from __future__ import annotations

from pathlib import Path


SERVICE_ROOT = Path(__file__).resolve().parents[1]


def test_receipt_api_remains_unwired_from_all_broker_mutation_runtimes() -> None:
    runtime_paths = (
        "app/alpaca_client.py",
        "app/trading/execution/order_executor_core_methods.py",
        "app/trading/execution/order_executor_submission_methods.py",
        "app/trading/execution/order_lifecycle.py",
        "app/trading/scheduler/capital_controls.py",
        "app/trading/scheduler/pipeline/runtime_gates.py",
        "app/trading/scheduler/governance/governance_mixin_lifecycle_methods.py",
        "app/hyperliquid_execution/exchange.py",
        "app/hyperliquid_execution/entry_processing.py",
        "app/hyperliquid_execution/maintenance.py",
        "app/hyperliquid_execution/service.py",
    )

    for relative_path in runtime_paths:
        source = (SERVICE_ROOT / relative_path).read_text(encoding="utf-8")
        assert "broker_mutation_receipts" not in source, relative_path


def test_receipt_slice_does_not_change_scheduler_replica_contract() -> None:
    manifest = (
        SERVICE_ROOT.parents[1]
        / "argocd/applications/torghut/scheduler-deployment.yaml"
    ).read_text(encoding="utf-8")

    assert "replicas: 0" in manifest


def test_receipt_postgres_races_are_a_required_ci_gate() -> None:
    workflow = (SERVICE_ROOT.parents[1] / ".github/workflows/torghut-ci.yml").read_text(
        encoding="utf-8"
    )

    assert "name: PostgreSQL mutation fencing CAS" in workflow
    assert "tests/execution/test_broker_mutation_receipts_postgres.py" in workflow
    assert (
        "tests/execution/test_broker_mutation_linked_receipts_postgres.py" in workflow
    )
    assert (
        "tests/execution/test_broker_mutation_receipt_boundaries_postgres.py"
        in workflow
    )
