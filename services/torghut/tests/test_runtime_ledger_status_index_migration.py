from __future__ import annotations

from unittest import TestCase
from unittest.mock import patch

from tests.migration_testing import load_migration_module


MIGRATION_FILENAME = "0041_runtime_ledger_status_index.py"


class TestRuntimeLedgerStatusIndexMigration(TestCase):
    def test_revision_follows_current_head(self) -> None:
        module = load_migration_module(MIGRATION_FILENAME)

        self.assertEqual(module.revision, "0041_runtime_ledger_status_index")
        self.assertEqual(module.down_revision, "0040_order_feed_fill_delta_basis")

    def test_upgrade_adds_hypothesis_ordering_index(self) -> None:
        module = load_migration_module(MIGRATION_FILENAME)

        with patch.object(module.op, "execute") as execute:
            module.upgrade()

        execute.assert_called_once()
        sql = str(execute.call_args.args[0])
        self.assertIn("CREATE INDEX IF NOT EXISTS", sql)
        self.assertIn(
            "ix_strategy_runtime_ledger_buckets_hypothesis_ended_created",
            sql,
        )
        self.assertIn("hypothesis_id", sql)
        self.assertIn("bucket_ended_at DESC", sql)
        self.assertIn("created_at DESC", sql)

    def test_downgrade_drops_index(self) -> None:
        module = load_migration_module(MIGRATION_FILENAME)

        with patch.object(module.op, "execute") as execute:
            module.downgrade()

        execute.assert_called_once()
        self.assertIn("DROP INDEX IF EXISTS", str(execute.call_args.args[0]))
