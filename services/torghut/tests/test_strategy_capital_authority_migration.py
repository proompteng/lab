from __future__ import annotations

from pathlib import Path
from unittest import TestCase
from unittest.mock import patch

from sqlalchemy import CheckConstraint, ForeignKeyConstraint, UniqueConstraint, select
from sqlalchemy.dialects import postgresql
from sqlalchemy.schema import CreateIndex

from app.models import StrategyCapitalAuthorityRecord, TradeDecision
from tests.migration_testing import load_migration_module


MIGRATION_FILENAME = "0064_strategy_capital_authority.py"
REPOSITORY_ROOT = Path(__file__).resolve().parents[3]


class TestStrategyCapitalAuthorityMigration(TestCase):
    def test_postgres_migration_contract_runs_in_required_ci(self) -> None:
        workflow = (REPOSITORY_ROOT / ".github/workflows/torghut-ci.yml").read_text(
            encoding="utf-8"
        )

        self.assertIn(
            "tests/trading/test_strategy_capital_authority_postgres.py",
            workflow,
        )

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

        self.assertEqual(module.revision, "0064_strategy_capital_authority")
        self.assertEqual(module.down_revision, "0063_options_archive_final_idx")
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
            patch.object(module.op, "get_context") as get_context,
            patch.object(module, "_existing_column_names", return_value=set()),
            patch.object(module, "_existing_constraint_names", return_value=set()),
            patch.object(
                module,
                "_unvalidated_constraint_names",
                return_value=set(module._DECISION_CONSTRAINTS),
            ),
            patch.object(
                module,
                "_usage_index_is_current",
                side_effect=(None, True),
            ),
        ):
            module.upgrade()

        get_context.return_value.autocommit_block.assert_called_once_with()
        create_table.assert_called_once()
        self.assertEqual(create_table.call_args.args[0], "strategy_capital_authorities")
        self.assertTrue(create_table.call_args.kwargs["if_not_exists"])
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
        self.assertEqual(create_index.call_count, 2)
        self.assertTrue(
            all(call.kwargs["if_not_exists"] for call in create_index.call_args_list)
        )
        sql = "\n".join(str(call.args[0]) for call in execute.call_args_list)
        self.assertIn("SET lock_timeout = '5s'", sql)
        self.assertIn("SET statement_timeout = '30min'", sql)
        self.assertIn("ADD COLUMN active_capital_authority_id UUID", sql)
        self.assertIn("ADD COLUMN strategy_capital_authority_id VARCHAR(128)", sql)
        self.assertEqual(sql.count("NOT VALID"), 5)
        self.assertIn("VALIDATE CONSTRAINT", sql)
        self.assertIn("CREATE INDEX CONCURRENTLY IF NOT EXISTS", sql)
        self.assertIn("WHERE strategy_capital_authority_allowed IS TRUE", sql)
        self.assertIn("strategy capital authority records are immutable", sql)
        self.assertIn("BEFORE UPDATE", sql)
        self.assertIn("BEFORE DELETE", sql)
        self.assertIn("evidence epoch records are immutable", sql)
        self.assertIn("RESET statement_timeout", sql)
        self.assertIn("RESET lock_timeout", sql)

    def test_upgrade_is_retry_safe_after_autocommit_progress(self) -> None:
        module = load_migration_module(MIGRATION_FILENAME)
        columns = {
            "active_capital_authority_id",
            "strategy_capital_authority_id",
            "strategy_capital_authority_digest",
            "strategy_capital_authority_evaluated_at",
            "strategy_capital_authority_allowed",
        }
        constraints = set(module._DECISION_CONSTRAINTS) | {
            module._STRATEGY_AUTHORITY_FK
        }

        with (
            patch.object(module.op, "create_table"),
            patch.object(module.op, "create_index"),
            patch.object(module.op, "execute") as execute,
            patch.object(module.op, "get_context"),
            patch.object(module, "_existing_column_names", return_value=columns),
            patch.object(
                module,
                "_existing_constraint_names",
                return_value=constraints,
            ),
            patch.object(
                module,
                "_unvalidated_constraint_names",
                return_value=set(),
            ),
            patch.object(module, "_usage_index_is_current", return_value=True),
        ):
            module.upgrade()

        sql = "\n".join(str(call.args[0]) for call in execute.call_args_list)
        self.assertNotIn("ALTER TABLE strategies", sql)
        self.assertNotIn("ALTER TABLE trade_decisions", sql)
        self.assertNotIn("CREATE INDEX CONCURRENTLY", sql)

    def test_invalid_concurrent_usage_index_is_removed_before_retry(self) -> None:
        module = load_migration_module(MIGRATION_FILENAME)

        with (
            patch.object(
                module,
                "_usage_index_is_current",
                side_effect=(False, True),
            ),
            patch.object(module.op, "execute") as execute,
        ):
            module._create_usage_index()

        sql = "\n".join(str(call.args[0]) for call in execute.call_args_list)
        self.assertIn("DROP INDEX CONCURRENTLY IF EXISTS", sql)
        self.assertIn("CREATE INDEX CONCURRENTLY IF NOT EXISTS", sql)

    def test_usage_index_and_digest_metadata_match_production_contract(self) -> None:
        usage_index = next(
            index
            for index in TradeDecision.__table__.indexes
            if index.name == "ix_trade_decisions_capital_authority_usage"
        )
        index_sql = str(CreateIndex(usage_index).compile(dialect=postgresql.dialect()))
        self.assertIn("WHERE strategy_capital_authority_allowed IS TRUE", index_sql)

        authority_checks = {
            str(constraint.name): str(
                constraint.sqltext.compile(
                    dialect=postgresql.dialect(),
                    compile_kwargs={"literal_binds": True},
                )
            )
            for constraint in StrategyCapitalAuthorityRecord.__table__.constraints
            if isinstance(constraint, CheckConstraint)
        }
        self.assertIn("~", authority_checks["ck_strategy_capital_authorities_digest"])
        self.assertIn(
            "BETWEEN 1 AND 128",
            authority_checks["ck_strategy_capital_authorities_id"],
        )

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
