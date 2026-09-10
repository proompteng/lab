from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

from tests.migration_testing import load_migration_module


MIGRATION_FILENAME = "0071_infrastructure_validation_lineage.py"


def test_revision_extends_reduction_fencing_without_rewriting_history() -> None:
    module = load_migration_module(MIGRATION_FILENAME)

    assert module.revision == "0071_validation_lineage"
    assert module.down_revision == "0070_reduction_fencing"
    assert len(module.revision) <= 32
    assert (
        len(Path(module.__file__ or "").read_text(encoding="utf-8").splitlines())
        <= 1000
    )


def test_upgrade_binds_each_descendant_to_a_terminal_parent_and_root() -> None:
    module = load_migration_module(MIGRATION_FILENAME)

    with (
        patch.object(module.op, "execute") as execute,
        patch.object(module.op, "create_index") as create_index,
    ):
        module.upgrade()

    sql = "\n".join(str(call.args[0]) for call in execute.call_args_list)
    assert "ACCESS EXCLUSIVE MODE NOWAIT" in sql
    assert "ADD CONSTRAINT ck_bm_receipt_validation_lineage" in sql
    assert "VALIDATE CONSTRAINT ck_bm_receipt_validation_lineage" in sql
    assert "jsonb_object_length" not in sql
    for required_key in (
        "root_receipt_id",
        "root_client_order_id",
        "parent_receipt_id",
        "parent_broker_order_id",
        "permit_id",
        "permit_sha256",
        "evidence_tag",
        "promotable",
    ):
        assert required_key in sql
    assert "CREATE TRIGGER trg_guard_bm_validation_lineage_0071" in sql
    assert "root is not broker-terminal" in sql
    assert "lineage parent missing" in sql
    assert "ancestor_reference" in sql
    assert "ancestor.operation NOT IN" in sql
    assert "'submit_order', 'replace_order'" in sql
    assert "torghut.infrastructure-validation-lifecycle-plan.v1" in sql
    assert "lineage target mismatch" in sql
    assert "cancel_all_orders" not in sql
    assert "jsonb_build_array(root_symbol)" in sql
    create_index.assert_called_once()
    index_call = create_index.call_args
    assert index_call.args == (
        "ix_bm_receipt_event_broker_reference",
        "broker_mutation_receipt_events",
        ["broker_reference", "receipt_id"],
    )
    assert index_call.kwargs["unique"] is False
    assert str(index_call.kwargs["postgresql_where"]) == (
        "state = 'settled' AND broker_reference IS NOT NULL"
    )


def test_downgrade_refuses_to_erase_lineage_history() -> None:
    module = load_migration_module(MIGRATION_FILENAME)

    with (
        patch.object(module.op, "execute") as execute,
        patch.object(module.op, "drop_index") as drop_index,
        patch.object(module.op, "drop_constraint") as drop_constraint,
    ):
        module.downgrade()

    statements = [str(call.args[0]) for call in execute.call_args_list]
    assert "ACCESS EXCLUSIVE MODE NOWAIT" in statements[0]
    assert "cannot downgrade with validation-lineage receipts" in statements[1]
    assert "DROP TRIGGER trg_guard_bm_validation_lineage_0071" in statements[2]
    assert "DROP FUNCTION torghut_guard_bm_validation_lineage_0071" in statements[3]
    drop_index.assert_called_once_with(
        "ix_bm_receipt_event_broker_reference",
        table_name="broker_mutation_receipt_events",
    )
    drop_constraint.assert_called_once_with(
        "ck_bm_receipt_validation_lineage",
        "broker_mutation_receipts",
        type_="check",
    )
