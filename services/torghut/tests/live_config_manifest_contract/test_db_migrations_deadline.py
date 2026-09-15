from __future__ import annotations

from pathlib import Path
from typing import Mapping, cast
from unittest import TestCase

from tests.live_config_manifest_contract.support import _load_yaml_mapping


_MANIFEST_PATH = "argocd/applications/torghut/db-migrations-job.yaml"
_MIGRATION_PATH = Path(
    "services/torghut/migrations/versions/"
    "0083_hyperliquid_execution_order_read_indexes.py"
)
_REPO_ROOT = Path(__file__).resolve().parents[4]


class DatabaseMigrationDeadlineTests(TestCase):
    def test_deadline_covers_both_online_index_builds_and_database_waits(self) -> None:
        manifest = _load_yaml_mapping(_MANIFEST_PATH)
        spec = cast(Mapping[str, object], manifest["spec"])
        deadline_seconds = cast(int, spec["activeDeadlineSeconds"])
        migration = (_REPO_ROOT / _MIGRATION_PATH).read_text()

        index_build_count = migration.count("CREATE INDEX CONCURRENTLY")
        self.assertEqual(index_build_count, 2)
        self.assertIn("SET statement_timeout = '30min'", migration)

        index_build_budget_seconds = index_build_count * 30 * 60
        database_wait_budget_seconds = 2 * 300
        remaining_migration_budget_seconds = 600
        required_deadline_seconds = (
            index_build_budget_seconds
            + database_wait_budget_seconds
            + remaining_migration_budget_seconds
        )
        self.assertGreaterEqual(deadline_seconds, required_deadline_seconds)
