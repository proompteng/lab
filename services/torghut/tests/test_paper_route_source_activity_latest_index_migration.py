from __future__ import annotations

import importlib.util
from pathlib import Path
from types import ModuleType
from unittest import TestCase
from unittest.mock import MagicMock, patch


def _load_migration_module() -> ModuleType:
    path = (
        Path(__file__).resolve().parents[1]
        / "migrations"
        / "versions"
        / "0051_paper_route_source_activity_latest_index.py"
    )
    spec = importlib.util.spec_from_file_location("torghut_migration_0051", path)
    if spec is None or spec.loader is None:
        raise AssertionError("failed_to_load_migration_0051")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class TestPaperRouteSourceActivityLatestIndexMigration(TestCase):
    def test_revision_follows_current_head(self) -> None:
        module = _load_migration_module()

        self.assertEqual(
            module.revision,
            "0051_paper_route_source_activity_latest_index",
        )
        self.assertEqual(
            module.down_revision,
            "0050_tigerbeetle_reconciliation_compact_status",
        )

    def test_index_name_fits_postgres_identifier_limit(self) -> None:
        module = _load_migration_module()

        self.assertLessEqual(len(module.INDEX_NAME), 63)

    def test_upgrade_adds_latest_source_activity_index(self) -> None:
        module = _load_migration_module()
        inspector = MagicMock()
        inspector.has_table.return_value = True
        inspector.get_indexes.return_value = []

        with (
            patch.object(module.op, "get_bind", return_value=object()),
            patch.object(module.op, "get_context") as get_context,
            patch.object(module, "inspect", return_value=inspector),
            patch.object(module.op, "create_index") as create_index,
        ):
            module.upgrade()

        get_context.return_value.autocommit_block.assert_called_once_with()
        create_index.assert_called_once_with(
            "ix_trade_decisions_account_strategy_symbol_created",
            "trade_decisions",
            [
                "alpaca_account_label",
                "strategy_id",
                "symbol",
                "created_at",
            ],
            postgresql_concurrently=True,
        )

    def test_downgrade_drops_latest_source_activity_index(self) -> None:
        module = _load_migration_module()
        inspector = MagicMock()
        inspector.has_table.return_value = True
        inspector.get_indexes.return_value = [{"name": module.INDEX_NAME}]

        with (
            patch.object(module.op, "get_bind", return_value=object()),
            patch.object(module.op, "get_context") as get_context,
            patch.object(module, "inspect", return_value=inspector),
            patch.object(module.op, "drop_index") as drop_index,
        ):
            module.downgrade()

        get_context.return_value.autocommit_block.assert_called_once_with()
        drop_index.assert_called_once_with(
            "ix_trade_decisions_account_strategy_symbol_created",
            table_name="trade_decisions",
            postgresql_concurrently=True,
        )
