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
        / "0032_options_catalog_active_underlying_index.py"
    )
    spec = importlib.util.spec_from_file_location("torghut_migration_0032", path)
    if spec is None or spec.loader is None:
        raise AssertionError("failed_to_load_migration_0032")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class TestOptionsCatalogActiveUnderlyingIndexMigration(TestCase):
    def test_revision_follows_current_head(self) -> None:
        module = _load_migration_module()

        self.assertEqual(
            module.revision, "0032_options_catalog_active_underlying_index"
        )
        self.assertEqual(
            module.down_revision, "0031_autoresearch_candidate_spec_epoch_uniqueness"
        )

    def test_upgrade_adds_partial_covering_index_for_active_route_symbols(
        self,
    ) -> None:
        module = _load_migration_module()

        with patch.object(module.op, "create_index") as create_index:
            module.upgrade()

        create_index.assert_called_once()
        _name, table_name, columns = create_index.call_args.args[:3]
        kwargs = create_index.call_args.kwargs
        self.assertEqual(table_name, "torghut_options_contract_catalog")
        self.assertEqual(columns, ["underlying_symbol"])
        self.assertIn("status = 'active'", str(kwargs["postgresql_where"]))
        self.assertEqual(
            kwargs["postgresql_include"],
            [
                "last_seen_ts",
                "provider_updated_ts",
                "close_price",
                "open_interest",
            ],
        )

    def test_downgrade_drops_index(self) -> None:
        module = _load_migration_module()

        with patch.object(module.op, "drop_index") as drop_index:
            module.downgrade()

        drop_index.assert_called_once_with(
            "ix_torghut_options_contract_catalog_active_underlying_freshness",
            table_name="torghut_options_contract_catalog",
        )
