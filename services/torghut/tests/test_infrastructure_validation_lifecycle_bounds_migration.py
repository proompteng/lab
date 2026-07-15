from __future__ import annotations

from unittest.mock import Mock, patch

import pytest

from tests.migration_testing import load_migration_module


MIGRATION_FILENAME = "0073_live_paper_lifecycle_bounds.py"


def _definition(module: object, cap: int) -> str:
    cap_fragment = getattr(module, "_cap_fragment")
    schema = getattr(module, "_LIFECYCLE_SCHEMA")
    return (
        "CHECK (purpose <> 'control_plane_validation' OR ("
        f"plan_schema = '{schema}' AND "
        f"{cap_fragment('max_notional_usd', cap)} AND "
        f"{cap_fragment('max_loss_usd', cap)}))"
    )


def test_revision_extends_the_released_lifecycle_schema() -> None:
    module = load_migration_module(MIGRATION_FILENAME)

    assert module.revision == "0073_live_paper_bounds"
    assert module.down_revision == "0072_validation_lifecycle"


def test_cap_rewrite_changes_only_the_two_lifecycle_money_bounds() -> None:
    module = load_migration_module(MIGRATION_FILENAME)
    definition = _definition(module, 5)

    condition = module._replace_lifecycle_cap(
        definition,
        old_cap=5,
        new_cap=30,
    )

    assert module._cap_fragment("max_notional_usd", 30) in condition
    assert module._cap_fragment("max_loss_usd", 30) in condition
    assert "purpose <> 'control_plane_validation'" in condition
    assert "<= 5::numeric" not in condition


@pytest.mark.parametrize(
    "definition",
    (
        "NOT A CHECK",
        "CHECK (missing lifecycle schema)",
    ),
)
def test_cap_rewrite_fails_closed_on_catalog_drift(definition: str) -> None:
    module = load_migration_module(MIGRATION_FILENAME)

    with pytest.raises(RuntimeError, match="validation_authority"):
        module._replace_lifecycle_cap(definition, old_cap=5, new_cap=30)


def test_upgrade_locks_and_validates_the_rewritten_constraint() -> None:
    module = load_migration_module(MIGRATION_FILENAME)
    connection = Mock()
    connection.execute.return_value.scalar_one_or_none.return_value = _definition(
        module,
        5,
    )

    with (
        patch.object(module.op, "get_bind", return_value=connection),
        patch.object(module.op, "execute") as execute,
        patch.object(module.op, "drop_constraint") as drop_constraint,
    ):
        module.upgrade()

    sql = "\n".join(str(call.args[0]) for call in execute.call_args_list)
    assert "ACCESS EXCLUSIVE MODE NOWAIT" in sql
    assert module._cap_fragment("max_notional_usd", 30) in sql
    assert module._cap_fragment("max_loss_usd", 30) in sql
    assert "NOT VALID" in sql
    assert "VALIDATE CONSTRAINT ck_bm_receipt_validation_authority" in sql
    drop_constraint.assert_called_once_with(
        "ck_bm_receipt_validation_authority",
        "broker_mutation_receipts",
        type_="check",
    )


def test_downgrade_refuses_incompatible_evidence_before_restoring_cap() -> None:
    module = load_migration_module(MIGRATION_FILENAME)
    connection = Mock()
    connection.execute.return_value.scalar_one_or_none.return_value = _definition(
        module,
        30,
    )

    with (
        patch.object(module.op, "get_bind", return_value=connection),
        patch.object(module.op, "execute") as execute,
        patch.object(module.op, "drop_constraint"),
    ):
        module.downgrade()

    sql = "\n".join(str(call.args[0]) for call in execute.call_args_list)
    assert "cannot downgrade with lifecycle receipts above the old cap" in sql
    assert module._cap_fragment("max_notional_usd", 5) in sql
    assert module._cap_fragment("max_loss_usd", 5) in sql
