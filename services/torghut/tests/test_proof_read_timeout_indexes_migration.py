from __future__ import annotations

from unittest import TestCase
from unittest.mock import MagicMock, patch

from tests.migration_testing import load_migration_module


MIGRATION_FILENAME = "0052_proof_read_timeout_indexes.py"


class TestProofReadTimeoutIndexesMigration(TestCase):
    def test_revision_follows_current_head(self) -> None:
        module = load_migration_module(MIGRATION_FILENAME)

        self.assertEqual(module.revision, "0052_proof_read_timeout_indexes")
        self.assertEqual(
            module.down_revision,
            "0051_paper_route_source_activity_latest_index",
        )

    def test_index_names_fit_postgres_identifier_limit(self) -> None:
        module = load_migration_module(MIGRATION_FILENAME)

        for index_name, _table_name, _create_sql in module._INDEXES:
            self.assertLessEqual(len(index_name), 63, index_name)

    def test_upgrade_adds_concurrent_timeout_indexes(self) -> None:
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
        self.assertIn("CREATE INDEX CONCURRENTLY IF NOT EXISTS", executed_sql)
        self.assertIn("ix_runtime_ledger_bucket_audit_lookup", executed_sql)
        self.assertIn("ix_rejected_signal_events_account_event_created", executed_sql)
        self.assertIn("ix_trade_decisions_created_id", executed_sql)

    def test_downgrade_drops_concurrent_timeout_indexes(self) -> None:
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
        self.assertIn("DROP INDEX CONCURRENTLY IF EXISTS", executed_sql)
        self.assertIn("ix_runtime_ledger_bucket_audit_lookup", executed_sql)
        self.assertIn("ix_rejected_signal_events_account_event_created", executed_sql)
        self.assertIn("ix_trade_decisions_created_id", executed_sql)
