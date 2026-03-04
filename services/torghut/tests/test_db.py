from __future__ import annotations

import hashlib
from unittest.mock import MagicMock, patch
from unittest import TestCase

from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

from app.config import settings
from app import db as app_db
from app.db import check_account_scope_invariants
from app.models import Base


class TestDbAccountScopeInvariants(TestCase):
    def setUp(self) -> None:
        self._original_multi_account_enabled = settings.trading_multi_account_enabled
        settings.trading_multi_account_enabled = True

        self.engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
        Base.metadata.create_all(self.engine)
        self.session_local = sessionmaker(
            bind=self.engine, expire_on_commit=False, future=True
        )

    def tearDown(self) -> None:
        settings.trading_multi_account_enabled = self._original_multi_account_enabled
        self.engine.dispose()

    def test_account_scope_invariants_pass_for_migrated_schema(self) -> None:
        with self.session_local() as session:
            status = check_account_scope_invariants(session)

        self.assertTrue(status["account_scope_ready"])
        self.assertTrue(status["execution_has_account_scoped_unique_order_id"])
        self.assertTrue(status["execution_has_account_scoped_unique_client_order_id"])
        self.assertFalse(status["legacy_executions_single_account_indexes_present"])
        self.assertFalse(status["legacy_trade_cursor_source_only_index_present"])

    def test_account_scope_invariants_detects_legacy_single_account_constraints(self) -> None:
        with self.engine.begin() as conn:
            conn.execute(text("DROP INDEX IF EXISTS uq_executions_account_alpaca_order_id"))
            conn.execute(text("DROP INDEX IF EXISTS uq_executions_account_client_order_id"))
            conn.execute(text("DROP INDEX IF EXISTS uq_trade_decisions_account_decision_hash"))
            conn.execute(text("DROP INDEX IF EXISTS uq_trade_cursor_source_account"))
            conn.execute(
                text(
                    "CREATE UNIQUE INDEX legacy_exec_order_id ON executions(alpaca_order_id)"
                )
            )
            conn.execute(
                text(
                    "CREATE UNIQUE INDEX legacy_exec_client_order_id ON executions(client_order_id)"
                )
            )
            conn.execute(
                text("CREATE UNIQUE INDEX legacy_cursor_source ON trade_cursor(source)")
            )

        with self.session_local() as session:
            status = check_account_scope_invariants(session)

        self.assertFalse(status["account_scope_ready"])
        self.assertIn(
            "legacy unique constraint/index detected for executions.alpaca_order_id",
            status["account_scope_errors"],
        )
        self.assertIn(
            "legacy unique constraint/index detected for trade_cursor.source",
            status["account_scope_errors"],
        )
        self.assertTrue(status["legacy_executions_single_account_indexes_present"])
        self.assertTrue(status["legacy_trade_cursor_source_only_index_present"])


class TestDbSchemaCurrent(TestCase):
    def test_check_schema_current_normalizes_and_signs_expected_heads(self) -> None:
        engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
        session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)
        Base.metadata.create_all(bind=engine)

        with (
            patch(
                "app.db._get_expected_schema_heads",
                return_value=("0012_demo_beta", "0011_demo_alpha"),
            ),
            patch("app.db.MigrationContext") as mock_migration_context,
        ):
            context_instance = MagicMock()
            context_instance.get_current_heads.return_value = [
                "0011_demo_alpha",
                "0012_demo_gamma",
                "0011_demo_alpha",
            ]
            mock_migration_context.configure.return_value = context_instance

            with session_local() as session:
                status = app_db.check_schema_current(session)

        self.assertEqual(
            status["current_heads"],
            ["0011_demo_alpha", "0011_demo_alpha", "0012_demo_gamma"],
        )
        self.assertEqual(
            status["expected_heads"], ["0011_demo_alpha", "0012_demo_beta"]
        )
        self.assertFalse(status["schema_current"])
        self.assertEqual(
            status["expected_heads_signature"],
            hashlib.sha256("0011_demo_alpha,0012_demo_beta".encode("utf-8")).hexdigest(),
        )

    def test_expected_schema_heads_cached(self) -> None:
        app_db._get_expected_schema_heads.cache_clear()
        with patch("app.db.ScriptDirectory.from_config") as mock_from_config:
            script_directory = MagicMock()
            script_directory.get_heads.return_value = [
                "0012_demo_beta",
                "0011_demo_alpha",
            ]
            mock_from_config.return_value = script_directory

            first = app_db._get_expected_schema_heads()
            second = app_db._get_expected_schema_heads()

        self.assertEqual(first, ("0011_demo_alpha", "0012_demo_beta"))
        self.assertEqual(second, first)
        self.assertEqual(mock_from_config.call_count, 1)
