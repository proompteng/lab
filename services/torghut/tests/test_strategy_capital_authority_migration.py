from __future__ import annotations

from pathlib import Path
from unittest import TestCase
from unittest.mock import patch

from sqlalchemy import CheckConstraint, ForeignKeyConstraint, UniqueConstraint, select
from sqlalchemy.dialects import postgresql

from app.models import TradeDecision
from tests.migration_testing import load_migration_module


MIGRATION_FILENAME = "0063_strategy_capital_authority.py"


class TestStrategyCapitalAuthorityMigration(TestCase):
    def test_authority_columns_are_explicitly_loaded_for_historical_schema_tests(
        self,
    ) -> None:
        entity_query = str(select(TradeDecision).compile(dialect=postgresql.dialect()))
        authority_query = str(
            select(TradeDecision.strategy_capital_authority_id).compile(
                dialect=postgresql.dialect()
            )
        )

        self.assertNotIn("strategy_capital_authority_id", entity_query)
        self.assertIn("strategy_capital_authority_id", authority_query)

    def test_revision_extends_options_archive_membership(self) -> None:
        module = load_migration_module(MIGRATION_FILENAME)

        self.assertEqual(module.revision, "0063_strategy_capital_authority")
        self.assertEqual(module.down_revision, "0062_options_archive_members")
        self.assertLessEqual(len(module.revision), 32)
        self.assertLessEqual(
            len(Path(module.__file__ or "").read_text(encoding="utf-8").splitlines()),
            1000,
        )

    def test_upgrade_creates_insert_only_authority_and_explicit_pointer(self) -> None:
        module = load_migration_module(MIGRATION_FILENAME)

        with (
            patch.object(module.op, "create_table") as create_table,
            patch.object(module.op, "create_index") as create_index,
            patch.object(module.op, "execute") as execute,
            patch.object(module.op, "add_column") as add_column,
            patch.object(module.op, "create_foreign_key") as create_foreign_key,
            patch.object(module.op, "create_check_constraint") as create_check,
        ):
            module.upgrade()

        create_table.assert_called_once()
        self.assertEqual(create_table.call_args.args[0], "strategy_capital_authorities")
        rendered = "\n".join(str(item) for item in create_table.call_args.args[1:])
        for column in (
            "authority_id",
            "strategy_id",
            "schema_version",
            "stage",
            "authority_digest",
            "payload_json",
            "issued_at",
            "expires_at",
            "created_at",
        ):
            self.assertIn(column, rendered)
        constraints = create_table.call_args.args[1:]
        foreign_keys = [
            item for item in constraints if isinstance(item, ForeignKeyConstraint)
        ]
        self.assertEqual(len(foreign_keys), 1)
        self.assertEqual(foreign_keys[0].ondelete, "RESTRICT")
        self.assertEqual(foreign_keys[0].onupdate, "RESTRICT")
        self.assertEqual(
            len([item for item in constraints if isinstance(item, UniqueConstraint)]),
            4,
        )
        checks = "\n".join(
            str(item.sqltext)
            for item in constraints
            if isinstance(item, CheckConstraint)
        )
        self.assertIn("shadow_allowed", checks)
        self.assertIn("capital_allowed", checks)
        self.assertIn("sha256", checks)

        self.assertEqual(add_column.call_count, 5)
        decision_columns = {
            call.args[1].name
            for call in add_column.call_args_list
            if call.args[0] == "trade_decisions"
        }
        self.assertEqual(
            decision_columns,
            {
                "strategy_capital_authority_id",
                "strategy_capital_authority_digest",
                "strategy_capital_authority_evaluated_at",
                "strategy_capital_authority_allowed",
            },
        )
        self.assertEqual(create_check.call_count, 4)
        self.assertEqual(create_foreign_key.call_count, 2)
        create_foreign_key.assert_any_call(
            "fk_strategies_active_capital_authority_identity",
            "strategies",
            "strategy_capital_authorities",
            ["active_capital_authority_id", "id"],
            ["id", "strategy_id"],
            ondelete="RESTRICT",
            onupdate="RESTRICT",
        )
        create_foreign_key.assert_any_call(
            "fk_trade_decisions_strategy_capital_authority_identity",
            "trade_decisions",
            "strategy_capital_authorities",
            [
                "strategy_capital_authority_id",
                "strategy_capital_authority_digest",
                "strategy_id",
            ],
            ["authority_id", "authority_digest", "strategy_id"],
            ondelete="RESTRICT",
            onupdate="RESTRICT",
        )
        self.assertEqual(create_index.call_count, 3)
        sql = "\n".join(str(call.args[0]) for call in execute.call_args_list)
        self.assertIn("strategy capital authority records are immutable", sql)
        self.assertIn("BEFORE UPDATE", sql)
        self.assertIn("BEFORE DELETE", sql)
        self.assertIn("evidence epoch records are immutable", sql)

    def test_downgrade_refuses_to_destroy_authority_history(self) -> None:
        module = load_migration_module(MIGRATION_FILENAME)

        with (
            patch.object(module.op, "execute") as execute,
            patch.object(module.op, "drop_index"),
            patch.object(module.op, "drop_constraint"),
            patch.object(module.op, "drop_column"),
            patch.object(module.op, "drop_table"),
        ):
            module.downgrade()

        sql = "\n".join(str(call.args[0]) for call in execute.call_args_list)
        self.assertIn("ACCESS EXCLUSIVE MODE NOWAIT", sql)
        self.assertIn(
            "refusing to downgrade nonempty strategy capital authorities", sql
        )
        self.assertIn("DROP TRIGGER trg_strategy_capital_authorities_no_update", sql)
        self.assertIn("DROP TRIGGER trg_strategy_capital_authorities_no_delete", sql)
        self.assertIn("DROP TRIGGER trg_evidence_epochs_no_update", sql)
        self.assertIn("DROP TRIGGER trg_evidence_epochs_no_delete", sql)
