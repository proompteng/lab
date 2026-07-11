from __future__ import annotations

from unittest import TestCase
from unittest.mock import patch

from sqlalchemy import CheckConstraint, ForeignKeyConstraint

from tests.migration_testing import load_migration_module


MIGRATION_FILENAME = "0059_broker_mutation_receipts.py"


class TestBrokerMutationReceiptMigration(TestCase):
    def test_revision_follows_submission_claims(self) -> None:
        module = load_migration_module(MIGRATION_FILENAME)

        self.assertEqual(module.revision, "0059_broker_mutation_receipts")
        self.assertEqual(module.down_revision, "0058_decision_submission_claims")
        self.assertLessEqual(len(module.revision), 32)

    def test_upgrade_creates_immutable_header_and_append_only_events(self) -> None:
        module = load_migration_module(MIGRATION_FILENAME)

        with (
            patch.object(module.op, "create_table") as create_table,
            patch.object(module.op, "create_index") as create_index,
            patch.object(module.op, "execute") as execute,
        ):
            module.upgrade()

        tables = {item.args[0]: item.args[1:] for item in create_table.call_args_list}
        self.assertEqual(
            set(tables),
            {"broker_mutation_receipts", "broker_mutation_receipt_events"},
        )
        header_rendered = "\n".join(
            str(item) for item in tables["broker_mutation_receipts"]
        )
        for column_name in (
            "broker_route",
            "account_label",
            "endpoint_fingerprint",
            "origin_writer_generation",
            "creator_owner",
            "operation",
            "risk_class",
            "purpose",
            "submission_claim_id",
            "workflow_id",
            "client_request_id",
            "target_kind",
            "target_key",
            "canonical_intent_json",
            "canonical_intent_sha256",
        ):
            self.assertIn(column_name, header_rendered)
        event_rendered = "\n".join(
            str(item) for item in tables["broker_mutation_receipt_events"]
        )
        for column_name in (
            "receipt_id",
            "sequence_no",
            "event_type",
            "state",
            "primary_token",
            "primary_epoch",
            "primary_writer_generation",
            "released_at",
            "broker_io_started_at",
            "recovery_token",
            "recovery_epoch",
            "recovery_writer_generation",
            "recovery_checked_at",
            "recovery_observation_epoch",
            "recovery_outcome",
            "recovery_evidence_json",
            "recovery_evidence_sha256",
            "settlement_source",
            "settlement_outcome",
            "settlement_evidence_json",
            "settlement_evidence_sha256",
            "settled_at",
        ):
            self.assertIn(column_name, event_rendered)

        foreign_keys = [
            item
            for table_items in tables.values()
            for item in table_items
            if isinstance(item, ForeignKeyConstraint)
        ]
        self.assertGreaterEqual(len(foreign_keys), 3)
        self.assertEqual({item.ondelete for item in foreign_keys}, {"RESTRICT"})
        self.assertEqual({item.onupdate for item in foreign_keys}, {"RESTRICT"})
        checks = "\n".join(
            str(item.sqltext)
            for table_items in tables.values()
            for item in table_items
            if isinstance(item, CheckConstraint)
        )
        self.assertIn("risk_increasing", checks)
        self.assertIn("replace_order", checks)
        self.assertIn("opposite_side_cleanup", checks)
        self.assertIn("broker_io_started", checks)
        self.assertIn("already_satisfied", checks)
        self.assertIn("preflight", checks)
        self.assertIn("sequence_no > 0", checks)

        index_names = {item.args[0] for item in create_index.call_args_list}
        self.assertIn("uq_broker_mutation_receipt_client", index_names)
        self.assertIn("uq_broker_mutation_receipt_intent", index_names)
        self.assertIn("uq_broker_mutation_receipt_event_seq", index_names)
        self.assertIn("ix_broker_mutation_receipt_recovery_due", index_names)
        for call_args in (*create_table.call_args_list, *create_index.call_args_list):
            name = call_args.args[0]
            self.assertLessEqual(len(name), 63)

        guard_sql = "\n".join(str(item.args[0]) for item in execute.call_args_list)
        for contract in (
            "broker mutation receipt header is immutable",
            "broker mutation receipt event is append-only",
            "broker mutation receipt sequence must be contiguous",
            "broker I/O quarantine is irreversible",
            "settled broker mutation receipt is terminal",
            "broker mutation receipt intent hash mismatch",
            "broker mutation receipt evidence hash mismatch",
            "broker mutation receipt requires sequence-one claimed event",
        ):
            self.assertIn(contract, guard_sql)
        self.assertIn("DEFERRABLE INITIALLY DEFERRED", guard_sql)
        self.assertIn("BEFORE TRUNCATE", guard_sql)
        self.assertIn("CREATE EXTENSION IF NOT EXISTS pgcrypto", guard_sql)
        self.assertIn("digest(convert_to", guard_sql)
        self.assertIn("previous.state = 'claimed'", guard_sql)
        self.assertIn("NEW.settlement_source <> 'preflight'", guard_sql)
        self.assertIn("NEW.settlement_outcome <> 'already_satisfied'", guard_sql)
        self.assertIn("torghut_lock_submission_identities", guard_sql)
        self.assertLess(
            guard_sql.index("torghut_lock_submission_identities"),
            guard_sql.index("FOR UPDATE"),
        )

    def test_downgrade_locks_and_refuses_nonempty_audit_state(self) -> None:
        module = load_migration_module(MIGRATION_FILENAME)

        with (
            patch.object(module.op, "execute") as execute,
            patch.object(module.op, "drop_index") as drop_index,
            patch.object(module.op, "drop_table") as drop_table,
        ):
            module.downgrade()

        downgrade_sql = "\n".join(
            str(item.args[0]) for item in execute.call_args_list[:2]
        )
        self.assertIn(
            "LOCK TABLE broker_mutation_receipts, "
            "broker_mutation_receipt_events IN ACCESS EXCLUSIVE MODE NOWAIT",
            downgrade_sql,
        )
        self.assertIn(
            "refusing to downgrade nonempty broker mutation receipt audit state",
            downgrade_sql,
        )
        self.assertGreaterEqual(drop_index.call_count, 1)
        self.assertEqual(
            [item.args[0] for item in drop_table.call_args_list],
            ["broker_mutation_receipt_events", "broker_mutation_receipts"],
        )
