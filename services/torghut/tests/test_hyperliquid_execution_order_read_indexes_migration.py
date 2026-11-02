from __future__ import annotations

from contextlib import nullcontext
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import MagicMock, call, patch

from tests.migration_testing import load_migration_module


MIGRATION_FILENAME = "0083_hyperliquid_execution_order_read_indexes.py"


def _postgres_bind() -> MagicMock:
    bind = MagicMock()
    bind.dialect = SimpleNamespace(name="postgresql")
    return bind


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
            self.assertIn("CREATE INDEX CONCURRENTLY", create_sql)
            self.assertNotIn("IF NOT EXISTS", create_sql)

    def test_upgrade_rebuilds_and_validates_indexes_concurrently(self) -> None:
        module = load_migration_module(MIGRATION_FILENAME)
        bind = _postgres_bind()
        inspector = MagicMock()
        inspector.has_table.return_value = True
        context = MagicMock()
        context.autocommit_block.return_value = nullcontext()

        with (
            patch.object(module.op, "get_bind", return_value=bind),
            patch.object(module.op, "get_context", return_value=context),
            patch.object(module, "inspect", return_value=inspector),
            patch.object(module.op, "execute") as execute,
            patch.object(
                module, "_index_is_valid", side_effect=(True, True)
            ) as is_valid,
        ):
            module.upgrade()

        inspector.has_table.assert_called_once_with(module.TABLE_NAME)
        context.autocommit_block.assert_called_once_with()
        is_valid.assert_has_calls(
            [
                call("ix_hyperliquid_execution_orders_network_created"),
                call("ix_hyperliquid_execution_orders_network_exchange_created"),
            ]
        )
        executed_sql = [str(call.args[0]) for call in execute.call_args_list]
        self.assertEqual(
            sum(sql.startswith("DROP INDEX CONCURRENTLY") for sql in executed_sql), 2
        )
        self.assertEqual(
            sum("CREATE INDEX CONCURRENTLY" in sql for sql in executed_sql), 2
        )
        self.assertIn("SET lock_timeout = '5s'", executed_sql)
        self.assertIn("SET statement_timeout = '30min'", executed_sql)
        self.assertIn("RESET statement_timeout", executed_sql)
        self.assertIn("RESET lock_timeout", executed_sql)

    def test_upgrade_rejects_invalid_concurrent_index(self) -> None:
        module = load_migration_module(MIGRATION_FILENAME)
        bind = _postgres_bind()
        inspector = MagicMock()
        inspector.has_table.return_value = True
        context = MagicMock()
        context.autocommit_block.return_value = nullcontext()

        with (
            patch.object(module.op, "get_bind", return_value=bind),
            patch.object(module.op, "get_context", return_value=context),
            patch.object(module, "inspect", return_value=inspector),
            patch.object(module.op, "execute") as execute,
            patch.object(module, "_index_is_valid", return_value=False),
            self.assertRaisesRegex(RuntimeError, "was not created as a valid index"),
        ):
            module.upgrade()

        executed_sql = [str(call.args[0]) for call in execute.call_args_list]
        self.assertTrue(
            any(sql.startswith("DROP INDEX CONCURRENTLY") for sql in executed_sql)
        )
        self.assertIn("RESET statement_timeout", executed_sql)
        self.assertIn("RESET lock_timeout", executed_sql)

    def test_index_validation_requires_ready_and_valid_catalog_state(self) -> None:
        module = load_migration_module(MIGRATION_FILENAME)
        bind = _postgres_bind()
        bind.execute.return_value.scalar_one_or_none.return_value = False

        with patch.object(module.op, "get_bind", return_value=bind):
            self.assertFalse(module._index_is_valid("ix_example"))

        sql = str(bind.execute.call_args.args[0])
        self.assertIn("indisvalid AND indisready", sql)
        self.assertEqual(bind.execute.call_args.args[1], {"index_name": "ix_example"})

    def test_downgrade_drops_indexes_concurrently(self) -> None:
        module = load_migration_module(MIGRATION_FILENAME)
        bind = _postgres_bind()
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
