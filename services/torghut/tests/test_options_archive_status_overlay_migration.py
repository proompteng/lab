from __future__ import annotations

from unittest.mock import patch

from tests.migration_testing import load_migration_module


MIGRATION_FILENAME = "0067_options_archive_status_overlay.py"


def test_archive_status_overlay_is_logged_narrow_and_extends_current_head() -> None:
    module = load_migration_module(MIGRATION_FILENAME)

    assert module.revision == "0067_options_archive_status"
    assert module.down_revision == "0066_broker_submit_coordinator"
    assert len(module.revision) <= 32

    with (
        patch.object(module.op, "create_table") as create_table,
        patch.object(module.op, "execute") as execute,
    ):
        module.upgrade()

    assert create_table.call_args.args[0] == "torghut_options_contract_archive_status"
    assert "prefixes" not in create_table.call_args.kwargs
    view_sql = str(execute.call_args.args[0])
    assert "CREATE VIEW torghut_options_active_contract_catalog" in view_sql
    assert "archive_status.contract_symbol = catalog.contract_symbol" in view_sql
    assert "catalog.status = 'active'" in view_sql


def test_archive_status_overlay_downgrade_drops_view_before_table() -> None:
    module = load_migration_module(MIGRATION_FILENAME)

    with (
        patch.object(module.op, "execute") as execute,
        patch.object(module.op, "drop_table") as drop_table,
    ):
        module.downgrade()

    execute.assert_called_once_with(
        "DROP VIEW IF EXISTS torghut_options_active_contract_catalog"
    )
    drop_table.assert_called_once_with("torghut_options_contract_archive_status")
