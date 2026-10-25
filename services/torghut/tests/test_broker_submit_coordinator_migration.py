from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

from tests.migration_testing import load_migration_module


MIGRATION_FILENAME = "0066_broker_submit_coordinator.py"


def test_revision_follows_strategy_capital_authority() -> None:
    module = load_migration_module(MIGRATION_FILENAME)

    assert module.revision == "0066_broker_submit_coordinator"
    assert module.down_revision == "0065_strategy_capital_compat"
    assert len(module.revision) <= 32
    assert (
        len(Path(module.__file__ or "").read_text(encoding="utf-8").splitlines())
        <= 1000
    )


def test_upgrade_replaces_contract_under_nowait_exclusive_lock() -> None:
    module = load_migration_module(MIGRATION_FILENAME)

    with (
        patch.object(module.op, "execute") as execute,
        patch.object(module.op, "drop_constraint") as drop_constraint,
        patch.object(module.op, "create_check_constraint") as create_check,
    ):
        module.upgrade()

    sql = "\n".join(str(call.args[0]) for call in execute.call_args_list)
    assert "ACCESS EXCLUSIVE MODE NOWAIT" in sql
    assert "CREATE OR REPLACE FUNCTION torghut_guard_bm_claim_0060" in sql
    assert "unlinked broker mutation submit contract invalid" in sql
    drop_constraint.assert_called_once_with(
        "ck_bm_receipt_operation_contract",
        "broker_mutation_receipts",
        type_="check",
    )
    condition = str(create_check.call_args.args[2])
    assert "purpose IN ('closeout', 'flatten')" in condition
    assert "broker_route = 'hyperliquid' AND submission_claim_id IS NULL" in condition


def test_downgrade_refuses_all_unlinked_submit_history() -> None:
    module = load_migration_module(MIGRATION_FILENAME)

    with (
        patch.object(module.op, "execute") as execute,
        patch.object(module.op, "drop_constraint"),
        patch.object(module.op, "create_check_constraint") as create_check,
    ):
        module.downgrade()

    sql = "\n".join(str(call.args[0]) for call in execute.call_args_list)
    assert "ACCESS EXCLUSIVE MODE NOWAIT" in sql
    assert "operation = 'submit_order'" in sql
    assert "cannot downgrade with unlinked submit-order receipts" in sql
    assert "unlinked broker mutation submit contract invalid" not in sql
    condition = str(create_check.call_args.args[2])
    assert "operation IN ('submit_order', 'replace_order')" in condition
    assert "broker_route = 'hyperliquid'" not in condition
