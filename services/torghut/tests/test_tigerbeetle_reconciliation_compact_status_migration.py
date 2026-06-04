from __future__ import annotations

import importlib.util
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest import TestCase
from unittest.mock import MagicMock, patch


def _load_migration_module() -> ModuleType:
    path = (
        Path(__file__).resolve().parents[1]
        / "migrations"
        / "versions"
        / "0050_tigerbeetle_reconciliation_compact_status.py"
    )
    spec = importlib.util.spec_from_file_location("torghut_migration_0050", path)
    if spec is None or spec.loader is None:
        raise AssertionError("failed_to_load_migration_0050")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class TestTigerBeetleReconciliationCompactStatusMigration(TestCase):
    def test_revision_follows_current_head(self) -> None:
        module = _load_migration_module()

        self.assertEqual(
            module.revision,
            "0050_tigerbeetle_reconciliation_compact_status",
        )
        self.assertEqual(
            module.down_revision,
            "0049_tigerbeetle_reconciliation_status_lookup",
        )

    def test_upgrade_adds_compact_status_columns(self) -> None:
        module = _load_migration_module()
        bind = SimpleNamespace(dialect=SimpleNamespace(name="postgresql"))
        inspector = MagicMock()
        inspector.has_table.return_value = True
        inspector.get_columns.return_value = [{"name": "id"}]

        with (
            patch.object(module.op, "get_bind", return_value=bind),
            patch.object(module, "inspect", return_value=inspector),
            patch.object(module.op, "add_column") as add_column,
        ):
            module.upgrade()

        column_names = [call.args[1].name for call in add_column.call_args_list]
        self.assertEqual(
            column_names,
            [
                *module.COMPACT_COUNT_COLUMNS,
                *module.COMPACT_JSON_COLUMNS,
            ],
        )

    def test_upgrade_skips_existing_compact_status_columns(self) -> None:
        module = _load_migration_module()
        bind = SimpleNamespace(dialect=SimpleNamespace(name="postgresql"))
        inspector = MagicMock()
        inspector.has_table.return_value = True
        inspector.get_columns.return_value = [
            {"name": column_name}
            for column_name in (
                "id",
                *module.COMPACT_COUNT_COLUMNS,
                *module.COMPACT_JSON_COLUMNS,
            )
        ]

        with (
            patch.object(module.op, "get_bind", return_value=bind),
            patch.object(module, "inspect", return_value=inspector),
            patch.object(module.op, "add_column") as add_column,
        ):
            module.upgrade()

        add_column.assert_not_called()

    def test_downgrade_drops_compact_status_columns(self) -> None:
        module = _load_migration_module()
        bind = SimpleNamespace(dialect=SimpleNamespace(name="postgresql"))
        inspector = MagicMock()
        inspector.has_table.return_value = True
        inspector.get_columns.return_value = [
            {"name": column_name}
            for column_name in (
                "id",
                *module.COMPACT_COUNT_COLUMNS,
                *module.COMPACT_JSON_COLUMNS,
            )
        ]

        with (
            patch.object(module.op, "get_bind", return_value=bind),
            patch.object(module, "inspect", return_value=inspector),
            patch.object(module.op, "drop_column") as drop_column,
        ):
            module.downgrade()

        column_names = [call.args[1] for call in drop_column.call_args_list]
        self.assertEqual(
            column_names,
            list(reversed((*module.COMPACT_JSON_COLUMNS, *module.COMPACT_COUNT_COLUMNS))),
        )
