from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

from tests.migration_testing import load_migration_module


MIGRATION_FILENAME = "0069_strict_submit_recovery.py"


def test_revision_extends_validation_head_without_rewriting_history() -> None:
    module = load_migration_module(MIGRATION_FILENAME)

    assert module.revision == "0069_strict_submit_recovery"
    assert module.down_revision == "0068_validation_submit"
    assert len(module.revision) <= 32
    assert (
        len(Path(module.__file__ or "").read_text(encoding="utf-8").splitlines())
        <= 1000
    )


def test_upgrade_installs_fenced_recovery_terminal_guards() -> None:
    module = load_migration_module(MIGRATION_FILENAME)

    with (
        patch.object(module.op, "execute") as execute,
        patch.object(module.op, "drop_constraint") as drop_constraint,
        patch.object(module.op, "create_check_constraint") as create_check,
    ):
        module.upgrade()

    sql = "\n".join(str(call.args[0]) for call in execute.call_args_list)
    check_conditions = "\n".join(
        str(call.args[2]) for call in create_check.call_args_list
    )
    assert "LOCK TABLE executions" in sql
    assert "IF EXISTS (SELECT 1 FROM trade_decision_submission_claims)" not in sql
    assert "torghut_guard_bm_linked_terminal_0069" in sql
    assert "torghut_guard_bm_settlement_envelope_0069" in sql
    assert "torghut_assert_linked_submission_terminal_0069" in sql
    assert "settlement_source NOT IN ('primary', 'recovery')" in sql
    assert "automatic_resubmission_attempted" in sql
    assert "claim.recovery_outcome <> 'found'" in sql
    assert "state IN ('submitted', 'rejected')" in check_conditions
    drop_constraint.assert_called_once_with(
        "ck_td_submission_claim_recovery_outcome",
        "trade_decision_submission_claims",
        type_="check",
    )


def test_downgrade_refuses_recovery_truth_and_restores_0061_guards() -> None:
    module = load_migration_module(MIGRATION_FILENAME)

    with (
        patch.object(module.op, "execute") as execute,
        patch.object(module.op, "drop_constraint") as drop_constraint,
        patch.object(module.op, "create_check_constraint") as create_check,
    ):
        module.downgrade()

    sql = "\n".join(str(call.args[0]) for call in execute.call_args_list)
    check_conditions = "\n".join(
        str(call.args[2]) for call in create_check.call_args_list
    )
    assert "refusing to downgrade strict submit recovery terminal data" in sql
    assert "DROP TRIGGER trg_check_execution_terminal_0069" in sql
    assert "CREATE CONSTRAINT TRIGGER trg_check_execution_terminal_0061" in sql
    assert "AND state = 'submitted'" in check_conditions
    drop_constraint.assert_called_once_with(
        "ck_td_submission_claim_recovery_outcome",
        "trade_decision_submission_claims",
        type_="check",
    )
