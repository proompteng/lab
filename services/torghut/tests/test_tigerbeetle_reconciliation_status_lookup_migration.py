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
        / "0049_tigerbeetle_reconciliation_status_lookup.py"
    )
    spec = importlib.util.spec_from_file_location("torghut_migration_0049", path)
    if spec is None or spec.loader is None:
        raise AssertionError("failed_to_load_migration_0049")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class TestTigerBeetleReconciliationStatusLookupMigration(TestCase):
    def test_revision_follows_current_head(self) -> None:
        module = _load_migration_module()

        self.assertEqual(
            module.revision,
            "0049_tigerbeetle_reconciliation_status_lookup",
        )
        self.assertEqual(module.down_revision, "0048_status_read_timeout_indexes")

    def test_index_name_fits_postgres_identifier_limit(self) -> None:
        module = _load_migration_module()

        self.assertLessEqual(len(module.INDEX_NAME), 63)

    def test_upgrade_adds_reconciliation_status_lookup_index(self) -> None:
        module = _load_migration_module()
        bind = SimpleNamespace(dialect=SimpleNamespace(name="postgresql"))
        inspector = MagicMock()
        inspector.has_table.return_value = True

        with (
            patch.object(module.op, "get_bind", return_value=bind),
            patch.object(module, "inspect", return_value=inspector),
            patch.object(module.op, "execute") as execute,
        ):
            module.upgrade()

        sql = str(execute.call_args.args[0])
        self.assertIn("ix_tb_reconciliation_runs_cluster_started_desc", sql)
        self.assertIn("cluster_id", sql)
        self.assertIn("started_at DESC", sql)

    def test_upgrade_skips_non_postgres(self) -> None:
        module = _load_migration_module()
        bind = SimpleNamespace(dialect=SimpleNamespace(name="sqlite"))

        with (
            patch.object(module.op, "get_bind", return_value=bind),
            patch.object(module.op, "execute") as execute,
        ):
            module.upgrade()

        execute.assert_not_called()

    def test_downgrade_drops_index(self) -> None:
        module = _load_migration_module()
        bind = SimpleNamespace(dialect=SimpleNamespace(name="postgresql"))
        inspector = MagicMock()
        inspector.has_table.return_value = True

        with (
            patch.object(module.op, "get_bind", return_value=bind),
            patch.object(module, "inspect", return_value=inspector),
            patch.object(module.op, "execute") as execute,
        ):
            module.downgrade()

        sql = str(execute.call_args.args[0])
        self.assertIn(
            "DROP INDEX IF EXISTS ix_tb_reconciliation_runs_cluster_started_desc",
            sql,
        )
