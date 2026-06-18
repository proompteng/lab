from __future__ import annotations

import importlib.util
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest import TestCase
from unittest.mock import MagicMock, patch

import sqlalchemy as sa


def _load_migration_module() -> ModuleType:
    path = (
        Path(__file__).resolve().parents[1]
        / "migrations"
        / "versions"
        / "0055_hyperliquid_tigerbeetle_ref_u128.py"
    )
    spec = importlib.util.spec_from_file_location("torghut_migration_0055", path)
    if spec is None or spec.loader is None:
        raise AssertionError("failed_to_load_migration_0055")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class TestHyperliquidTigerBeetleRefU128Migration(TestCase):
    def test_revision_follows_hyperliquid_runtime_migration(self) -> None:
        module = _load_migration_module()

        self.assertEqual(
            module.revision,
            "0055_hyperliquid_tigerbeetle_ref_u128",
        )
        self.assertEqual(module.down_revision, "0054_hyperliquid_runtime")

    def test_upgrade_widens_integer_transfer_id_to_numeric_39(self) -> None:
        module = _load_migration_module()
        bind = SimpleNamespace(dialect=SimpleNamespace(name="postgresql"))
        inspector = MagicMock()
        inspector.has_table.return_value = True
        inspector.get_columns.return_value = [
            {"name": "transfer_id", "type": sa.Integer(), "nullable": False},
            {
                "name": "debit_account_id",
                "type": sa.Numeric(39, 0),
                "nullable": False,
            },
            {
                "name": "credit_account_id",
                "type": sa.Numeric(39, 0),
                "nullable": False,
            },
            {"name": "amount", "type": sa.Numeric(39, 0), "nullable": False},
        ]

        with (
            patch.object(module.op, "get_bind", return_value=bind),
            patch.object(module, "inspect", return_value=inspector),
            patch.object(module.op, "alter_column") as alter_column,
        ):
            module.upgrade()

        alter_column.assert_called_once()
        _, column_name = alter_column.call_args.args
        kwargs = alter_column.call_args.kwargs
        self.assertEqual(column_name, "transfer_id")
        self.assertIsInstance(kwargs["type_"], sa.Numeric)
        self.assertEqual(kwargs["type_"].precision, 39)
        self.assertEqual(kwargs["type_"].scale, 0)
        self.assertEqual(kwargs["postgresql_using"], "transfer_id::numeric(39, 0)")

    def test_upgrade_skips_when_columns_are_already_numeric_39(self) -> None:
        module = _load_migration_module()
        bind = SimpleNamespace(dialect=SimpleNamespace(name="postgresql"))
        inspector = MagicMock()
        inspector.has_table.return_value = True
        inspector.get_columns.return_value = [
            {"name": column_name, "type": sa.Numeric(39, 0), "nullable": False}
            for column_name in module.NUMERIC_39_COLUMNS
        ]

        with (
            patch.object(module.op, "get_bind", return_value=bind),
            patch.object(module, "inspect", return_value=inspector),
            patch.object(module.op, "alter_column") as alter_column,
        ):
            module.upgrade()

        alter_column.assert_not_called()
