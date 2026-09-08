from __future__ import annotations

from unittest import TestCase
from unittest.mock import MagicMock, patch

from tests.migration_testing import load_migration_module


MIGRATION_FILENAME = "0043_status_readiness_bounded_read_indexes.py"


class TestStatusReadinessBoundedReadIndexesMigration(TestCase):
    def test_revision_follows_current_head(self) -> None:
        module = load_migration_module(MIGRATION_FILENAME)

        self.assertEqual(module.revision, "0043_status_readiness_bounded_read_indexes")
        self.assertEqual(
            module.down_revision, "0042_order_feed_source_window_scope_index"
        )

    def test_upgrade_adds_bounded_status_read_indexes(self) -> None:
        module = load_migration_module(MIGRATION_FILENAME)
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
        module = load_migration_module(MIGRATION_FILENAME)
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
