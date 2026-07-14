from __future__ import annotations

from unittest import TestCase
from unittest.mock import MagicMock, patch

from tests.migration_testing import load_migration_module


MIGRATION_FILENAME = "0062_loop_status_read_indexes.py"


class TestLoopStatusReadIndexesMigration(TestCase):
    def test_revision_follows_linked_submission_recovery(self) -> None:
        module = load_migration_module(MIGRATION_FILENAME)

        self.assertEqual(module.revision, "0062_loop_status_read_indexes")
        self.assertEqual(module.down_revision, "0061_linked_submission_terminal")

    def test_index_names_fit_postgres_identifier_limit(self) -> None:
        module = load_migration_module(MIGRATION_FILENAME)

        for index_name, _table_name, _create_sql in module._INDEXES:
            self.assertLessEqual(len(index_name), 63, index_name)

    def test_upgrade_adds_concurrent_time_first_indexes(self) -> None:
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

        get_context.return_value.autocommit_block.assert_called_once_with()
        executed_sql = "\n".join(str(call.args[0]) for call in execute.call_args_list)
        self.assertEqual(execute.call_count, 5)
        self.assertEqual(executed_sql.count("CREATE INDEX CONCURRENTLY"), 5)
        self.assertIn("hyperliquid_execution_signals (generated_at DESC)", executed_sql)
        self.assertIn(
            "hyperliquid_execution_orders (execution_network, created_at DESC)",
            executed_sql,
        )
        self.assertIn(
            "hyperliquid_execution_fills (execution_network, event_ts DESC)",
            executed_sql,
        )
        self.assertIn("executions (created_at DESC)", executed_sql)
        self.assertIn("COALESCE(event_ts, created_at)", executed_sql)
        self.assertEqual(executed_sql.count("INCLUDE (alpaca_account_label)"), 2)

    def test_upgrade_skips_missing_tables(self) -> None:
        module = load_migration_module(MIGRATION_FILENAME)
        bind = MagicMock()
        bind.dialect.name = "postgresql"
        inspector = MagicMock()
        inspector.has_table.side_effect = [True, False, True, False, True]

        with (
            patch.object(module.op, "get_bind", return_value=bind),
            patch.object(module.op, "get_context"),
            patch.object(module, "inspect", return_value=inspector),
            patch.object(module.op, "execute") as execute,
        ):
            module.upgrade()

        self.assertEqual(execute.call_count, 3)

    def test_upgrade_rebuilds_invalid_concurrent_index_residue(self) -> None:
        module = load_migration_module(MIGRATION_FILENAME)
        bind = MagicMock()
        bind.dialect.name = "postgresql"
        bind.execute.return_value.scalar_one_or_none.side_effect = [
            True,
            False,
            False,
            True,
            True,
        ]
        inspector = MagicMock()
        inspector.has_table.return_value = True

        with (
            patch.object(module.op, "get_bind", return_value=bind),
            patch.object(module.op, "get_context"),
            patch.object(module, "inspect", return_value=inspector),
            patch.object(module.op, "execute") as execute,
        ):
            module.upgrade()

        executed_sql = [str(call.args[0]) for call in execute.call_args_list]
        self.assertEqual(len(executed_sql), 4)
        self.assertIn(
            "DROP INDEX CONCURRENTLY IF EXISTS "
            "ix_hyperliquid_execution_orders_network_created_desc",
            executed_sql[0],
        )
        self.assertIn("CREATE INDEX CONCURRENTLY", executed_sql[1])
        self.assertIn(
            "DROP INDEX CONCURRENTLY IF EXISTS "
            "ix_hyperliquid_execution_fills_network_event_desc",
            executed_sql[2],
        )
        self.assertIn("CREATE INDEX CONCURRENTLY", executed_sql[3])

    def test_upgrade_skips_non_postgres(self) -> None:
        module = load_migration_module(MIGRATION_FILENAME)
        bind = MagicMock()
        bind.dialect.name = "sqlite"

        with (
            patch.object(module.op, "get_bind", return_value=bind),
            patch.object(module.op, "execute") as execute,
        ):
            module.upgrade()

        execute.assert_not_called()

    def test_downgrade_drops_concurrent_indexes_in_reverse_order(self) -> None:
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
        executed_sql = [str(call.args[0]) for call in execute.call_args_list]
        self.assertEqual(len(executed_sql), 5)
        self.assertIn("ix_execution_order_events_activity_at_desc", executed_sql[0])
        self.assertTrue(
            any(
                "ix_hyperliquid_execution_orders_network_created_desc" in sql
                for sql in executed_sql
            )
        )
        self.assertTrue(
            any(
                "ix_hyperliquid_execution_fills_network_event_desc" in sql
                for sql in executed_sql
            )
        )
        self.assertIn(
            "ix_hyperliquid_execution_signals_generated_at_desc", executed_sql[-1]
        )
        self.assertTrue(
            all("DROP INDEX CONCURRENTLY IF EXISTS" in sql for sql in executed_sql)
        )
