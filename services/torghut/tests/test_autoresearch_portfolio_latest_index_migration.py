from __future__ import annotations

from unittest import TestCase
from unittest.mock import MagicMock, patch

from tests.migration_testing import load_migration_module


MIGRATION_FILENAME = "0046_autoresearch_portfolio_latest_index.py"


class TestAutoresearchPortfolioLatestIndexMigration(TestCase):
    def test_revision_follows_current_head(self) -> None:
        module = load_migration_module(MIGRATION_FILENAME)

        self.assertEqual(module.revision, "0046_autoresearch_portfolio_latest_index")
        self.assertEqual(
            module.down_revision,
            "0045_paper_route_audit_bounded_read_indexes",
        )

    def test_upgrade_adds_created_at_index(self) -> None:
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

        create_index.assert_called_once_with(
            "ix_autoresearch_portfolio_candidates_created",
            "autoresearch_portfolio_candidates",
            ["created_at"],
        )

    def test_downgrade_drops_existing_index(self) -> None:
        module = load_migration_module(MIGRATION_FILENAME)
        inspector = MagicMock()
        inspector.has_table.return_value = True
        inspector.get_indexes.return_value = [
            {"name": "ix_autoresearch_portfolio_candidates_created"}
        ]

        with (
            patch.object(module.op, "get_bind", return_value=object()),
            patch.object(module, "inspect", return_value=inspector),
            patch.object(module.op, "drop_index") as drop_index,
        ):
            module.downgrade()

        drop_index.assert_called_once_with(
            "ix_autoresearch_portfolio_candidates_created",
            table_name="autoresearch_portfolio_candidates",
        )
