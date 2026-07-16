from __future__ import annotations

import ast
from pathlib import Path

from app.trading.broker_mutation_receipts.runtime_status import (
    build_broker_mutation_runtime_status,
)


SERVICE_ROOT = Path(__file__).resolve().parents[1]


def _source(relative_path: str) -> str:
    return (SERVICE_ROOT / relative_path).read_text(encoding="utf-8")


def _attribute_calls(root: Path) -> set[tuple[str, str, str]]:
    calls: set[tuple[str, str, str]] = set()
    for path in root.rglob("*.py"):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        relative_path = path.relative_to(SERVICE_ROOT).as_posix()
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            if isinstance(node.func, ast.Name):
                calls.add((relative_path, "", node.func.id))
                continue
            if not isinstance(node.func, ast.Attribute):
                continue
            calls.add(
                (
                    relative_path,
                    ast.unparse(node.func.value),
                    node.func.attr,
                )
            )
    return calls


def test_every_production_mutation_uses_durable_and_reduction_authority() -> None:
    alpaca_executor = _source("app/trading/execution/order_executor_core_methods.py")
    alpaca_adapter = _source("app/trading/execution_adapters/adapter_types.py")
    alpaca_reductions = _source("app/trading/alpaca_reduction_mutations.py")
    alpaca_firewall = _source("app/trading/firewall.py")
    hyperliquid_entry = _source("app/hyperliquid_execution/entry_processing.py")
    hyperliquid_reductions = _source("app/hyperliquid_execution/reduction_mutations.py")
    hyperliquid_exchange = _source("app/hyperliquid_execution/exchange.py")
    reduction_authority = _source("app/trading/risk_reduction_mutation_authority.py")
    validation_runner = _source("app/trading/infrastructure_validation_submit.py")

    assert "BrokerMutationCoordinator" in alpaca_executor
    assert ".submit_linked_order(" in alpaca_executor
    assert "AlpacaReductionMutationExecutor" in alpaca_adapter
    assert ".execute_unlinked_mutation(" in alpaca_reductions
    assert "consume_risk_reduction_mutation_authority(" in alpaca_firewall

    assert ".execute_unlinked_mutation(" in hyperliquid_entry
    assert ".execute_unlinked_mutation(" in hyperliquid_reductions
    assert "consume_risk_reduction_mutation_authority(" in hyperliquid_exchange
    assert "consume_broker_mutation_io_permit(" in reduction_authority
    assert "consume_risk_reduction_permit(" in reduction_authority
    assert ".submit_infrastructure_validation_order(" in validation_runner
    assert "submit_verified_infrastructure_validation_order(" in alpaca_firewall


def test_validation_authority_cannot_fall_through_generic_unlinked_submit() -> None:
    coordinator = _source("app/trading/broker_mutation_coordinator.py")
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


def test_production_mutation_permits_are_issued_only_by_the_committed_transition() -> (
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


def test_operational_scripts_have_no_direct_broker_mutation_authority() -> None:
    calls = _attribute_calls(SERVICE_ROOT / "scripts")
    forbidden_methods = {
        "cancel",
        "cancel_all_orders",
        "cancel_order",
        "cancel_order_by_id",
        "cancel_orders",
        "close_all_positions",
        "close_position",
        "market_close",
        "market_open",
        "replace_order",
        "replace_order_by_id",
        "submit_order",
    }

    assert not {call for call in calls if call[2] in forbidden_methods}


def test_raw_broker_sdk_calls_remain_inside_the_narrow_adapters() -> None:
    calls = _attribute_calls(SERVICE_ROOT / "app")
    raw_calls = {
        call
        for call in calls
        if (call[1], call[2])
        in {
            ("self._trading", "cancel_order_by_id"),
            ("self._trading", "cancel_orders"),
            ("self._trading", "close_all_positions"),
            ("self._trading", "close_position"),
            ("self._trading", "replace_order_by_id"),
            ("self._trading", "submit_order"),
            ("client", "market_open"),
            ("exchange", "cancel"),
            ("exchange", "market_close"),
        }
    }

    assert raw_calls == {
        ("app/alpaca_client.py", "self._trading", "cancel_order_by_id"),
        ("app/alpaca_client.py", "self._trading", "cancel_orders"),
        ("app/alpaca_client.py", "self._trading", "close_all_positions"),
        ("app/alpaca_client.py", "self._trading", "close_position"),
        ("app/alpaca_client.py", "self._trading", "replace_order_by_id"),
        ("app/alpaca_client.py", "self._trading", "submit_order"),
        ("app/hyperliquid_execution/exchange.py", "exchange", "cancel"),
        ("app/hyperliquid_execution/exchange.py", "exchange", "market_close"),
        ("app/hyperliquid_execution/sdk_submission.py", "client", "market_open"),
    }


def test_alpaca_raw_capability_is_minted_only_by_the_firewall() -> None:
    calls = _attribute_calls(SERVICE_ROOT / "app")
    issuers = {
        path
        for path, _receiver, method in calls
        if method == "issue_order_firewall_token"
    }

    assert issuers == {"app/trading/firewall.py"}


def test_recovery_routes_have_no_broker_mutation_calls() -> None:
    recovery_paths = {
        "app/hyperliquid_execution/mutation_recovery.py",
        "app/trading/alpaca_mutation_recovery.py",
        "app/trading/broker_mutation_recovery_worker.py",
    }
    forbidden_methods = {
        "cancel",
        "cancel_all_orders",
        "cancel_order",
        "cancel_order_by_id",
        "cancel_orders",
        "close_all_positions",
        "close_position",
        "market_close",
        "market_open",
        "replace_order",
        "replace_order_by_id",
        "submit_order",
    }
    calls = _attribute_calls(SERVICE_ROOT / "app")

    assert not {
        call
        for call in calls
        if call[0] in recovery_paths and call[2] in forbidden_methods
    }


def test_runtime_status_claims_only_the_entry_capability_now_wired() -> None:
    status = build_broker_mutation_runtime_status()

    assert status["runtime_wired"] is True
    assert status["entry_fencing_proven"] is True
    assert status["reduction_fencing_proven"] is False
    assert status["recovery_worker_wired"] is True
    assert status["recovery_worker_enabled"] is True
    assert status["recovery_degraded"] is False


def test_scheduler_writer_is_singleton_or_explicitly_quiesced() -> None:
    manifest = (
        SERVICE_ROOT.parents[1]
        / "argocd/applications/torghut/scheduler-deployment.yaml"
    ).read_text(encoding="utf-8")

    if "replicas: 0" in manifest:
        assert (
            "Temporarily quiesced for the bounded Alpaca-paper lifecycle proof"
            in manifest
        )
        assert "Restore the single scheduler writer after readback" in manifest
    else:
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
    assert "tests/execution/test_broker_mutation_coordinator_postgres.py" in workflow
    assert "tests/execution/test_validation_quarantine_postgres.py" in workflow
    assert "tests/execution/test_linked_submission_terminal_postgres.py" in workflow
