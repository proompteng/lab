from __future__ import annotations

from pathlib import Path

from app.trading.broker_mutation_receipts.runtime_status import (
    build_broker_mutation_runtime_status,
)


SERVICE_ROOT = Path(__file__).resolve().parents[1]


def _source(relative_path: str) -> str:
    return (SERVICE_ROOT / relative_path).read_text(encoding="utf-8")


def test_every_production_entry_submit_uses_the_durable_coordinator() -> None:
    alpaca_executor = _source("app/trading/execution/order_executor_core_methods.py")
    alpaca_adapter = _source("app/trading/execution_adapters/adapter_types.py")
    alpaca_firewall = _source("app/trading/firewall.py")
    hyperliquid_entry = _source("app/hyperliquid_execution/entry_processing.py")
    hyperliquid_exchange = _source("app/hyperliquid_execution/exchange.py")
    validation_runner = _source("app/trading/infrastructure_validation_submit.py")

    assert "BrokerMutationSubmitCoordinator" in alpaca_executor
    assert ".submit_linked_order(" in alpaca_executor
    assert ".submit_unlinked_order(" in alpaca_adapter
    assert "consume_broker_mutation_io_permit(" in alpaca_firewall

    assert ".submit_unlinked_order(" in hyperliquid_entry
    assert "consume_broker_mutation_io_permit(" in hyperliquid_exchange
    assert ".submit_infrastructure_validation_order(" in validation_runner
    assert "submit_verified_infrastructure_validation_order(" in alpaca_firewall


def test_validation_authority_cannot_fall_through_generic_unlinked_submit() -> None:
    coordinator = _source("app/trading/broker_mutation_submit_coordinator.py")
    migration = _source("migrations/versions/0068_infrastructure_validation_submit.py")

    assert (
        "infrastructure_validation_requires_dedicated_submit_authority" in coordinator
    )
    assert 'purpose="control_plane_validation"' in coordinator
    assert 'risk_class="risk_neutral"' in coordinator
    assert "non_promotable_validation" in migration
    assert "uq_bm_receipt_validation_permit" in migration


def test_retired_live_submit_adapters_cannot_reintroduce_a_bypass() -> None:
    production_sources = "\n".join(
        path.read_text(encoding="utf-8")
        for path in (SERVICE_ROOT / "app").rglob("*.py")
    )

    assert "LeanExecutionAdapter" not in production_sources
    assert '"/v1/orders/submit"' not in production_sources
    assert '"session_router"' not in production_sources
    assert "alpaca_entry_submit_requires_durable_order_firewall" in production_sources


def test_production_submit_permits_are_issued_only_by_the_committed_transition() -> (
    None
):
    production_sources = list((SERVICE_ROOT / "app").rglob("*.py"))
    issuers = sorted(
        path.relative_to(SERVICE_ROOT).as_posix()
        for path in production_sources
        if "issue_broker_mutation_io_permit(" in path.read_text(encoding="utf-8")
    )

    assert issuers == [
        "app/trading/broker_mutation_receipts/transitions.py",
        "app/trading/broker_mutation_receipts/types.py",
    ]


def test_removed_submit_retry_and_preclaim_cancel_paths_do_not_regress() -> None:
    submission_sources = "\n".join(
        _source(relative_path)
        for relative_path in (
            "app/trading/execution/order_executor_core_methods.py",
            "app/trading/execution/order_executor_submission_methods.py",
            "app/trading/execution/order_lifecycle.py",
            "app/trading/scheduler/pipeline/runtime_gates.py",
        )
    )

    for retired_symbol in (
        "submit_with_bounded_repricing",
        "_retry_sell_inventory_conflict_after_cancel",
        "_cancel_conflicting_precheck_order",
    ):
        assert retired_symbol not in submission_sources


def test_operational_scripts_have_no_direct_broker_submit_authority() -> None:
    script_sources = "\n".join(
        path.read_text(encoding="utf-8")
        for path in (SERVICE_ROOT / "scripts").rglob("*.py")
    )

    assert ".submit_order(" not in script_sources
    assert ".market_open(" not in script_sources


def test_runtime_status_claims_only_the_entry_capability_now_wired() -> None:
    status = build_broker_mutation_runtime_status()

    assert status["runtime_wired"] is True
    assert status["entry_fencing_proven"] is True
    assert status["reduction_fencing_proven"] is False
    assert status["recovery_worker_wired"] is False
    assert status["recovery_degraded"] is True


def test_scheduler_singleton_replica_contract_remains_enabled() -> None:
    manifest = (
        SERVICE_ROOT.parents[1]
        / "argocd/applications/torghut/scheduler-deployment.yaml"
    ).read_text(encoding="utf-8")

    assert "replicas: 1" in manifest


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
    assert (
        "tests/execution/test_broker_mutation_submit_coordinator_postgres.py"
        in workflow
    )
    assert "tests/execution/test_linked_submission_terminal_postgres.py" in workflow
