from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

from tests.migration_testing import load_migration_module


MIGRATION_FILENAME = "0068_infrastructure_validation_submit.py"


def test_revision_follows_current_migration_head() -> None:
    module = load_migration_module(MIGRATION_FILENAME)

    assert module.revision == "0068_validation_submit"
    assert module.down_revision == "0067_options_archive_status"
    assert len(module.revision) <= 32
    assert (
        len(Path(module.__file__ or "").read_text(encoding="utf-8").splitlines())
        <= 1000
    )


def test_upgrade_hard_binds_one_non_promotable_permit() -> None:
    module = load_migration_module(MIGRATION_FILENAME)

    with (
        patch.object(module.op, "execute") as execute,
        patch.object(module.op, "drop_constraint") as drop_constraint,
        patch.object(module.op, "create_check_constraint") as create_check,
    ):
        module.upgrade()

    sql = "\n".join(str(call.args[0]) for call in execute.call_args_list)
    conditions = "\n".join(str(call.args[2]) for call in create_check.call_args_list)
    assert "ACCESS EXCLUSIVE MODE NOWAIT" in sql
    assert "control_plane_validation" in sql
    assert "non_promotable_validation" in sql
    assert "max_outstanding_intents}' = '1'" in sql
    assert "CREATE UNIQUE INDEX uq_bm_receipt_validation_permit" in sql
    assert "CREATE OR REPLACE FUNCTION torghut_guard_bm_claim_0060" in sql
    assert "control_plane_validation" in conditions
    assert "OR COALESCE((" in sql
    assert "^ivp-[0-9a-f]{44}$" in sql
    assert "e7ce2f426f96cfc1606a46bc494cdfff" in sql
    assert "permit,asset_class}' = 'crypto'" in sql
    assert "permit,market_session}' = 'continuous'" in sql
    assert "= '[\"buy\"]'::jsonb" in sql
    assert drop_constraint.call_count == 2


def test_downgrade_refuses_to_erase_validation_history() -> None:
    module = load_migration_module(MIGRATION_FILENAME)

    with (
        patch.object(module.op, "execute") as execute,
        patch.object(module.op, "drop_constraint") as drop_constraint,
        patch.object(module.op, "create_check_constraint") as create_check,
    ):
        module.downgrade()

    sql = "\n".join(str(call.args[0]) for call in execute.call_args_list)
    conditions = "\n".join(str(call.args[2]) for call in create_check.call_args_list)
    assert "cannot downgrade with infrastructure-validation receipts" in sql
    assert "DROP INDEX uq_bm_receipt_validation_permit" in sql
    assert "control_plane_validation" not in conditions
    drop_constraint.assert_any_call(
        "ck_bm_receipt_validation_authority",
        "broker_mutation_receipts",
        type_="check",
    )
