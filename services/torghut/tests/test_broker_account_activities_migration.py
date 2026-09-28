from __future__ import annotations

from pathlib import Path
from unittest import TestCase
from unittest.mock import patch

from sqlalchemy import BigInteger, CheckConstraint, Column, Numeric

from app.models import BrokerAccountActivity, BrokerAccountActivityCursor
from tests.migration_testing import load_migration_module


MIGRATION_FILENAME = "0076_broker_account_activities.py"


class BrokerAccountActivitiesMigrationTests(TestCase):
    def test_models_preserve_raw_economic_evidence_and_bounded_precision(self) -> None:
        activity_columns = BrokerAccountActivity.__table__.columns
        cursor_columns = BrokerAccountActivityCursor.__table__.columns

        for column_name in (
            "external_activity_id",
            "activity_type",
            "event_at",
            "order_id",
            "quantity",
            "price",
            "net_amount",
            "raw_payload",
            "raw_payload_canonical_json",
            "raw_payload_sha256",
            "first_observed_at",
        ):
            self.assertIn(column_name, activity_columns)
        for column_name in (
            "quantity",
            "price",
            "cumulative_quantity",
            "leaves_quantity",
            "net_amount",
        ):
            column_type = activity_columns[column_name].type
            self.assertIsInstance(column_type, Numeric)
            self.assertEqual(column_type.precision, 38)
            self.assertEqual(column_type.scale, 18)
        for column_name in (
            "pages_processed",
            "activities_seen",
            "activities_inserted",
        ):
            self.assertIsInstance(cursor_columns[column_name].type, BigInteger)

        activity_indexes = {
            index.name: index for index in BrokerAccountActivity.__table__.indexes
        }
        cursor_indexes = {
            index.name: index for index in BrokerAccountActivityCursor.__table__.indexes
        }
        self.assertTrue(
            activity_indexes["uq_broker_account_activities_external_identity"].unique
        )
        self.assertTrue(
            cursor_indexes["uq_broker_account_activity_cursors_scope"].unique
        )
        self.assertIn(
            "endpoint_fingerprint",
            {
                column.name
                for column in cursor_indexes[
                    "uq_broker_account_activity_cursors_scope"
                ].columns
            },
        )

    def test_revision_extends_validation_observation_head(self) -> None:
        module = load_migration_module(MIGRATION_FILENAME)

        self.assertEqual(module.revision, "0076_broker_account_activities")
        self.assertEqual(module.down_revision, "0075_validation_observed_at")
        self.assertLessEqual(len(module.revision), 32)
        self.assertLessEqual(
            len(Path(module.__file__ or "").read_text(encoding="utf-8").splitlines()),
            500,
        )

    def test_upgrade_creates_one_immutable_fact_table_and_one_cursor(self) -> None:
        module = load_migration_module(MIGRATION_FILENAME)

        with (
            patch.object(module.op, "create_table") as create_table,
            patch.object(module.op, "create_index") as create_index,
            patch.object(module.op, "execute") as execute,
        ):
            module.upgrade()

        self.assertEqual(create_table.call_count, 2)
        self.assertEqual(
            [call.args[0] for call in create_table.call_args_list],
            ["broker_account_activities", "broker_account_activity_cursors"],
        )
        table_items = [
            item for call in create_table.call_args_list for item in call.args[1:]
        ]
        columns = {item.name: item for item in table_items if isinstance(item, Column)}
        self.assertIn("raw_payload_canonical_json", columns)
        self.assertIn("normalized_economic_sha256", columns)
        self.assertIn("source_offset", columns)
        self.assertIsInstance(columns["quantity"].type, Numeric)
        self.assertEqual(columns["quantity"].type.precision, 38)
        self.assertEqual(columns["quantity"].type.scale, 18)
        checks = "\n".join(
            str(item.sqltext)
            for item in table_items
            if isinstance(item, CheckConstraint)
        )
        self.assertIn("activities_inserted <= activities_seen", checks)
        self.assertEqual(
            {call.args[0] for call in create_index.call_args_list},
            {
                "ix_broker_account_activities_scope_event",
                "uq_broker_account_activities_external_identity",
                "uq_broker_account_activities_source_offset",
                "uq_broker_account_activity_cursors_scope",
            },
        )
        self.assertEqual(
            sum(
                bool(call.kwargs.get("unique")) for call in create_index.call_args_list
            ),
            3,
        )

        sql = "\n".join(str(call.args[0]) for call in execute.call_args_list)
        self.assertIn("CREATE EXTENSION IF NOT EXISTS pgcrypto", sql)
        self.assertIn("broker account activity is append-only", sql)
        self.assertIn("raw_payload_canonical_json", sql)
        self.assertIn("payload identity mismatch", sql)
        self.assertIn("payload hash mismatch", sql)
        self.assertIn("BEFORE INSERT OR UPDATE OR DELETE", sql)
        self.assertIn("BEFORE TRUNCATE", sql)

    def test_downgrade_refuses_to_discard_activity_evidence(self) -> None:
        module = load_migration_module(MIGRATION_FILENAME)

        with (
            patch.object(module.op, "execute") as execute,
            patch.object(module.op, "drop_table") as drop_table,
        ):
            module.downgrade()

        sql = "\n".join(str(call.args[0]) for call in execute.call_args_list)
        self.assertIn("refusing to discard broker account activity evidence", sql)
        self.assertIn("DROP TRIGGER trg_guard_broker_account_activity", sql)
        self.assertIn("DROP FUNCTION", sql)
        self.assertEqual(
            [call.args[0] for call in drop_table.call_args_list],
            ["broker_account_activity_cursors", "broker_account_activities"],
        )
