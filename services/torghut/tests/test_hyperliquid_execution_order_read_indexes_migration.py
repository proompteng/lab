from __future__ import annotations

from unittest import TestCase
from unittest.mock import MagicMock, patch

from tests.migration_testing import load_migration_module


MIGRATION_FILENAME = "0083_hyperliquid_execution_order_read_indexes.py"


class TestHyperliquidExecutionOrderReadIndexesMigration(TestCase):
    def test_revision_follows_current_head(self) -> None:
        module = load_migration_module(MIGRATION_FILENAME)

        self.assertEqual(module.revision, "0083_hyperliquid_order_reads")
        self.assertEqual(module.down_revision, "0082_order_lineage_runs")

    def test_index_contract_matches_measured_queries(self) -> None:
        module = load_migration_module(MIGRATION_FILENAME)
        sql = "\n".join(create_sql for _index_name, create_sql in module.INDEXES)

        self.assertEqual(len(module.INDEXES), 2)
        self.assertIn("(execution_network, created_at DESC)", sql)
        self.assertIn("exchange_order_id", sql)
        self.assertIn("WHERE exchange_order_id IS NOT NULL", sql)
        for index_name, create_sql in module.INDEXES:
            self.assertLessEqual(len(index_name), 63, index_name)
            self.assertIn("CREATE INDEX CONCURRENTLY IF NOT EXISTS", create_sql)

    def test_upgrade_creates_indexes_concurrently(self) -> None:
        module = load_migration_module(MIGRATION_FILENAME)
        bind = MagicMock()
        bind.dialect.name = "postgresql"
        inspector = MagicMock()
        inspector.has_table.return_value = True

        with (
            patch.object(module.op, "get_bind", return_value=bind),
            patch.object(module.op, "get_context") as get_context,
            patch.object(module, "inspect", return_value=inspector),
            patch.object(module.op, "execute") as execute,
        ):
            module.upgrade()

        inspector.has_table.assert_called_once_with(module.TABLE_NAME)
        get_context.return_value.autocommit_block.assert_called_once_with()
        self.assertEqual(execute.call_count, 2)

    def test_downgrade_drops_indexes_concurrently(self) -> None:
        module = load_migration_module(MIGRATION_FILENAME)
        bind = MagicMock()
        bind.dialect.name = "postgresql"
        inspector = MagicMock()
        inspector.has_table.return_value = True

        with (
            patch.object(module.op, "get_bind", return_value=bind),
            patch.object(module.op, "get_context") as get_context,
            patch.object(module, "inspect", return_value=inspector),
            patch.object(module.op, "execute") as execute,
        ):
            module.downgrade()

        get_context.return_value.autocommit_block.assert_called_once_with()
        executed_sql = "\n".join(str(call.args[0]) for call in execute.call_args_list)
        self.assertEqual(execute.call_count, 2)
        self.assertIn("DROP INDEX CONCURRENTLY IF EXISTS", executed_sql)
