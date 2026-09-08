from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

from tests.migration_testing import load_migration_module


MIGRATION_FILENAME = "0072_infrastructure_validation_lifecycle.py"


def test_revision_extends_validation_lineage_without_rewriting_history() -> None:
    module = load_migration_module(MIGRATION_FILENAME)

    assert module.revision == "0072_validation_lifecycle"
    assert module.down_revision == "0071_validation_lineage"
    assert len(module.revision) <= 32
    assert (
        len(Path(module.__file__ or "").read_text(encoding="utf-8").splitlines())
        <= 1000
    )


def test_upgrade_requires_position_proof_for_lifecycle_reductions() -> None:
    module = load_migration_module(MIGRATION_FILENAME)

    with (
        patch.object(module.op, "execute") as execute,
        patch.object(module.op, "add_column") as add_column,
        patch.object(module.op, "create_index") as create_index,
        patch.object(module.op, "drop_constraint") as drop_constraint,
    ):
        module.upgrade()

    sql = "\n".join(str(call.args[0]) for call in execute.call_args_list)
    assert "ACCESS EXCLUSIVE MODE NOWAIT" in sql
    assert "torghut.infrastructure-validation-lifecycle-plan.v1" in sql
    assert "max_notional_usd}')::numeric <= 5" in sql
    assert "operation IN ('submit_order', 'replace_order', 'cancel_order'" in sql
    assert "risk_class = 'risk_reducing'" in sql
    assert "purpose = 'closeout'" in sql
    assert "event.position_qty" in sql
    assert "event.event_type IN ('fill', 'partial_fill')" in sql
    assert "event.execution_id IS NULL" in sql
    assert "event.trade_decision_id IS NULL" in sql
    assert "validation_root_receipt_id" in sql
    assert "permit_sha256" in sql
    assert "jsonb_array_length(risk #> '{observation,positions}') <> 1" in sql
    assert "observed_position_qty IS DISTINCT FROM latest_position_qty" in sql
    assert "NEW.created_at - observed_at > interval '5 seconds'" in sql
    assert "ancestor.created_at > NEW.created_at" in sql
    assert "ancestor.created_at >= NEW.created_at" not in sql
    assert "submit_close_order" in sql
    assert "close_position" in sql
    assert "close_all_positions" in sql
    assert "cancel_all_orders" not in module._LINEAGE_CONTRACT_0072
    assert "DROP TRIGGER trg_guard_bm_validation_lineage_0071" in sql
    assert "CREATE TRIGGER trg_guard_bm_validation_lineage_0072" in sql
    add_column.assert_called_once()
    assert add_column.call_args.args[0] == "execution_order_events"
    assert add_column.call_args.args[1].name == "position_qty"
    create_index.assert_called_once()
    assert create_index.call_args.args == (
        "ix_order_event_validation_position",
        "execution_order_events",
        ["alpaca_account_label", "symbol", "event_ts", "created_at"],
    )
    assert str(create_index.call_args.kwargs["postgresql_where"]) == (
        "position_qty IS NOT NULL AND execution_id IS NULL "
        "AND trade_decision_id IS NULL"
    )
    assert [call.args for call in drop_constraint.call_args_list] == [
        (
            "ck_bm_receipt_validation_authority",
            "broker_mutation_receipts",
        ),
        (
            "ck_bm_receipt_validation_lineage",
            "broker_mutation_receipts",
        ),
    ]


def test_downgrade_refuses_to_erase_lifecycle_evidence() -> None:
    module = load_migration_module(MIGRATION_FILENAME)

    with (
        patch.object(module.op, "execute") as execute,
        patch.object(module.op, "drop_index") as drop_index,
        patch.object(module.op, "drop_column") as drop_column,
        patch.object(module.op, "drop_constraint"),
    ):
        module.downgrade()

    sql = "\n".join(str(call.args[0]) for call in execute.call_args_list)
    assert "cannot downgrade with validation lifecycle evidence" in sql
    assert "position_qty IS NOT NULL" in sql
    assert "DROP TRIGGER trg_guard_bm_validation_lineage_0072" in sql
    assert "DROP FUNCTION torghut_guard_bm_validation_lineage_0072()" in sql
    assert "CREATE TRIGGER trg_guard_bm_validation_lineage_0071" in sql
    drop_index.assert_called_once_with(
        "ix_order_event_validation_position",
        table_name="execution_order_events",
    )
    drop_column.assert_called_once_with("execution_order_events", "position_qty")
