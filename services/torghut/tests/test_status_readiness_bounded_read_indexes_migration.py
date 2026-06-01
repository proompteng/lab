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
        / "0043_status_readiness_bounded_read_indexes.py"
    )
    spec = importlib.util.spec_from_file_location("torghut_migration_0043", path)
    if spec is None or spec.loader is None:
        raise AssertionError("failed_to_load_migration_0043")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class TestStatusReadinessBoundedReadIndexesMigration(TestCase):
    def test_revision_follows_current_head(self) -> None:
        module = _load_migration_module()

        self.assertEqual(module.revision, "0043_status_readiness_bounded_read_indexes")
        self.assertEqual(
            module.down_revision, "0042_order_feed_source_window_scope_index"
        )

    def test_upgrade_adds_bounded_status_read_indexes(self) -> None:
        module = _load_migration_module()
        inspector = MagicMock()
        inspector.has_table.return_value = True
        inspector.get_indexes.return_value = []

        with (
            patch.object(module.op, "get_bind", return_value=object()),
            patch.object(module, "inspect", return_value=inspector),
            patch.object(module.op, "create_index") as create_index,
        ):
            module.upgrade()

        self.assertEqual(create_index.call_count, 3)
        created_names = [call.args[0] for call in create_index.call_args_list]
        self.assertIn(
            "ix_strategy_hypothesis_metric_windows_hypothesis_ended_created",
            created_names,
        )
        self.assertIn(
            "ix_strategy_promotion_decisions_hypothesis_created",
            created_names,
        )
        self.assertIn(
            "ix_autoresearch_portfolio_candidates_status_created",
            created_names,
        )

    def test_downgrade_drops_existing_indexes(self) -> None:
        module = _load_migration_module()
        inspector = MagicMock()
        inspector.has_table.return_value = True
        inspector.get_indexes.return_value = [
            {"name": "ix_strategy_hypothesis_metric_windows_hypothesis_ended_created"},
            {"name": "ix_strategy_promotion_decisions_hypothesis_created"},
            {"name": "ix_autoresearch_portfolio_candidates_status_created"},
        ]

        with (
            patch.object(module.op, "get_bind", return_value=object()),
            patch.object(module, "inspect", return_value=inspector),
            patch.object(module.op, "drop_index") as drop_index,
        ):
            module.downgrade()

        self.assertEqual(drop_index.call_count, 3)
