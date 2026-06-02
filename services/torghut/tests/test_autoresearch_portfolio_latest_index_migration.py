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
        / "0046_autoresearch_portfolio_latest_index.py"
    )
    spec = importlib.util.spec_from_file_location("torghut_migration_0046", path)
    if spec is None or spec.loader is None:
        raise AssertionError("failed_to_load_migration_0046")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class TestAutoresearchPortfolioLatestIndexMigration(TestCase):
    def test_revision_follows_current_head(self) -> None:
        module = _load_migration_module()

        self.assertEqual(module.revision, "0046_autoresearch_portfolio_latest_index")
        self.assertEqual(
            module.down_revision,
            "0045_paper_route_audit_bounded_read_indexes",
        )

    def test_upgrade_adds_created_at_index(self) -> None:
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

        create_index.assert_called_once_with(
            "ix_autoresearch_portfolio_candidates_created",
            "autoresearch_portfolio_candidates",
            ["created_at"],
        )

    def test_downgrade_drops_existing_index(self) -> None:
        module = _load_migration_module()
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
