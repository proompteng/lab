from __future__ import annotations

import importlib.util
from pathlib import Path
from types import ModuleType
from unittest import TestCase
from unittest.mock import patch


def _load_migration_module() -> ModuleType:
    path = (
        Path(__file__).resolve().parents[1]
        / "migrations"
        / "versions"
        / "0041_runtime_ledger_status_index.py"
    )
    spec = importlib.util.spec_from_file_location("torghut_migration_0041", path)
    if spec is None or spec.loader is None:
        raise AssertionError("failed_to_load_migration_0041")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class TestRuntimeLedgerStatusIndexMigration(TestCase):
    def test_revision_follows_current_head(self) -> None:
        module = _load_migration_module()

        self.assertEqual(module.revision, "0041_runtime_ledger_status_index")
        self.assertEqual(module.down_revision, "0040_order_feed_fill_delta_basis")

    def test_upgrade_adds_hypothesis_ordering_index(self) -> None:
        module = _load_migration_module()

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
        module = _load_migration_module()

        with patch.object(module.op, "execute") as execute:
            module.downgrade()

        execute.assert_called_once()
        self.assertIn("DROP INDEX IF EXISTS", str(execute.call_args.args[0]))
