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
        / "0048_status_read_timeout_indexes.py"
    )
    spec = importlib.util.spec_from_file_location("torghut_migration_0048", path)
    if spec is None or spec.loader is None:
        raise AssertionError("failed_to_load_migration_0048")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class TestStatusReadTimeoutIndexesMigration(TestCase):
    def test_revision_follows_current_head(self) -> None:
        module = _load_migration_module()

        self.assertEqual(module.revision, "0048_status_read_timeout_indexes")
        self.assertEqual(
            module.down_revision,
            "0047_order_feed_source_window_classification_counts",
        )

    def test_index_names_fit_postgres_identifier_limit(self) -> None:
        module = _load_migration_module()

        for index_name, _table_name, _create_sql in module._INDEXES:
            self.assertLessEqual(len(index_name), 63, index_name)

    def test_upgrade_adds_postgres_status_read_indexes(self) -> None:
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

        self.assertEqual(execute.call_count, len(module._INDEXES))
        sql = "\n".join(str(call.args[0]) for call in execute.call_args_list)
        self.assertIn("window_ended_at DESC NULLS LAST", sql)
        self.assertIn("ix_strategy_promotion_decisions_status_lookup", sql)
        self.assertIn("WHERE avg_fill_price IS NOT NULL", sql)
        self.assertIn("ix_execution_tca_metrics_account_symbol_computed", sql)
        self.assertIn("ix_options_catalog_active_last_seen_desc", sql)
        self.assertIn("WHERE status = 'active'", sql)

    def test_upgrade_skips_non_postgres(self) -> None:
        module = _load_migration_module()
        bind = SimpleNamespace(dialect=SimpleNamespace(name="sqlite"))

        with (
            patch.object(module.op, "get_bind", return_value=bind),
            patch.object(module.op, "execute") as execute,
        ):
            module.upgrade()

        execute.assert_not_called()

    def test_downgrade_drops_existing_indexes(self) -> None:
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

        sql = "\n".join(str(call.args[0]) for call in execute.call_args_list)
        self.assertIn(
            "DROP INDEX IF EXISTS ix_strategy_hyp_windows_hyp_ended_desc", sql
        )
        self.assertIn(
            "DROP INDEX IF EXISTS ix_options_catalog_active_last_seen_desc",
            sql,
        )
