from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

from tests.migration_testing import load_migration_module


MIGRATION_FILENAME = "0070_risk_reduction_mutation_fencing.py"


def test_revision_extends_strict_recovery_without_rewriting_history() -> None:
    module = load_migration_module(MIGRATION_FILENAME)

    assert module.revision == "0070_reduction_fencing"
    assert module.down_revision == "0069_strict_submit_recovery"
    assert len(module.revision) <= 32
    assert (
        len(Path(module.__file__ or "").read_text(encoding="utf-8").splitlines())
        <= 1000
    )


def test_upgrade_allows_only_unlinked_risk_neutral_repricing() -> None:
    module = load_migration_module(MIGRATION_FILENAME)

    with (
        patch.object(module.op, "execute") as execute,
        patch.object(module.op, "drop_constraint") as drop_constraint,
        patch.object(module.op, "create_check_constraint") as create_check,
    ):
        module.upgrade()

    condition = str(create_check.call_args.args[2])
    assert "operation = 'replace_order'" in condition
    assert "broker_route = 'alpaca'" in condition
    assert "submission_claim_id IS NULL" in condition
    assert "risk_class = 'risk_neutral'" in condition
    assert "purpose = 'repricing'" in condition
    replace_clause = condition.split("operation = 'replace_order'", 1)[1].split(
        "operation = 'cancel_order'", 1
    )[0]
    assert "submission_claim_id IS NOT NULL" not in replace_clause
    assert "close_position" in condition
    assert "close_all_positions" in condition
    statements = [str(call.args[0]) for call in execute.call_args_list]
    assert any("ACCESS EXCLUSIVE MODE NOWAIT" in value for value in statements)
    claim_guard = next(
        value
        for value in statements
        if "CREATE OR REPLACE FUNCTION torghut_guard_bm_claim_0060" in value
    )
    assert "NEW.broker_route = 'alpaca'" in claim_guard
    assert "NEW.risk_class = 'risk_neutral'" in claim_guard
    assert "NEW.purpose = 'repricing'" in claim_guard
    drop_constraint.assert_called_once_with(
        "ck_bm_receipt_operation_contract",
        "broker_mutation_receipts",
        type_="check",
    )


def test_downgrade_restores_linked_only_replace_contract() -> None:
    module = load_migration_module(MIGRATION_FILENAME)

    with (
        patch.object(module.op, "execute") as execute,
        patch.object(module.op, "drop_constraint") as drop_constraint,
        patch.object(module.op, "create_check_constraint") as create_check,
    ):
        module.downgrade()

    condition = str(create_check.call_args.args[2])
    replace_clause = condition.split("operation = 'replace_order'", 1)[1].split(
        "operation = 'cancel_order'", 1
    )[0]
    assert "submission_claim_id IS NOT NULL" in replace_clause
    assert "risk_class = 'risk_neutral'" not in replace_clause
    assert execute.call_count == 3
    statements = [str(call.args[0]) for call in execute.call_args_list]
    assert "ACCESS EXCLUSIVE MODE NOWAIT" in statements[0]
    assert "unlinked replacement receipts" in statements[1]
    claim_guard = statements[2]
    assert "CREATE OR REPLACE FUNCTION torghut_guard_bm_claim_0060" in claim_guard
    assert "NEW.purpose = 'repricing'" not in claim_guard
    drop_constraint.assert_called_once_with(
        "ck_bm_receipt_operation_contract",
        "broker_mutation_receipts",
        type_="check",
    )
