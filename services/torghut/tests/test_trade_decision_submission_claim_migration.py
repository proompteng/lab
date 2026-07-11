from __future__ import annotations

from unittest import TestCase
from unittest.mock import call, patch

from sqlalchemy import CheckConstraint, ForeignKeyConstraint

from tests.migration_testing import load_migration_module


MIGRATION_FILENAME = "0058_trade_decision_submission_claims.py"


class TestTradeDecisionSubmissionClaimMigration(TestCase):
    def test_revision_follows_current_head(self) -> None:
        module = load_migration_module(MIGRATION_FILENAME)

        self.assertEqual(module.revision, "0058_decision_submission_claims")
        self.assertEqual(module.down_revision, "0057_generic_multifactor_machine")
        self.assertLessEqual(len(module.revision), 32)

    def test_upgrade_creates_exact_identity_claim_contract(self) -> None:
        module = load_migration_module(MIGRATION_FILENAME)

        with (
            patch.object(module.op, "create_table") as create_table,
            patch.object(module.op, "create_index") as create_index,
            patch.object(module.op, "execute") as execute,
        ):
            module.upgrade()

        create_table.assert_called_once()
        args = create_table.call_args.args
        self.assertEqual(args[0], "trade_decision_submission_claims")
        rendered = "\n".join(str(item) for item in args[1:])
        for column_name in (
            "trade_decision_id",
            "account_label",
            "client_order_id",
            "claim_token",
            "fencing_epoch",
            "broker_io_started_at",
            "recovery_token",
            "recovery_fencing_epoch",
            "recovery_owner",
            "recovery_lease_expires_at",
            "recovery_observation_epoch",
            "recovery_outcome",
            "recovery_evidence",
            "broker_order_id",
            "broker_client_order_id",
            "execution_id",
            "completed_at",
        ):
            self.assertIn(column_name, rendered)
        self.assertNotIn("submission_max_attempts", rendered)

        check_sql = "\n".join(
            str(item.sqltext) for item in args[1:] if isinstance(item, CheckConstraint)
        )
        self.assertIn("state IN ('claimed', 'broker_io', 'submitted')", check_sql)
        self.assertNotIn("available", check_sql)
        self.assertNotIn("recovering", check_sql)
        self.assertIn("broker_client_order_id = client_order_id", check_sql)
        self.assertIn("recovery_fencing_epoch = 0", check_sql)
        self.assertIn("recovery_outcome = 'found'", check_sql)
        self.assertIn("recovery_observation_epoch <= recovery_fencing_epoch", check_sql)
        self.assertIn("lease_expires_at <= released_at", check_sql)
        self.assertIn("state = 'claimed'", check_sql)

        foreign_keys = [
            item for item in args[1:] if isinstance(item, ForeignKeyConstraint)
        ]
        self.assertEqual(len(foreign_keys), 2)
        self.assertEqual({item.ondelete for item in foreign_keys}, {"RESTRICT"})
        execution_fk = next(item for item in foreign_keys if len(item.elements) == 5)
        self.assertEqual(execution_fk.onupdate, "RESTRICT")
        for item in args[1:]:
            name = getattr(item, "name", None)
            if name:
                self.assertLessEqual(len(name), 63)

        self.assertEqual(
            [item.args[0] for item in create_index.call_args_list],
            [
                "uq_executions_submission_claim_identity",
                "uq_trade_decision_submission_claim_token",
                "uq_trade_decision_submission_claim_account_client_order",
                "uq_trade_decision_submission_recovery_token",
                "ix_trade_decision_submission_claim_state_lease",
                "ix_trade_decision_submission_claim_recovery_due",
            ],
        )
        self.assertEqual(
            create_index.call_args_list[-1].args[2],
            ["state", "recovery_after", "recovery_lease_expires_at"],
        )
        guard_sql = "\n".join(str(item.args[0]) for item in execute.call_args_list)
        self.assertIn("broker I/O quarantine is irreversible", guard_sql)
        self.assertIn("submitted claim tombstone is immutable", guard_sql)
        self.assertIn("terminal broker client identity mismatch", guard_sql)
        self.assertIn("terminal execution identity mismatch", guard_sql)
        self.assertIn("claimed trade decision identity is immutable", guard_sql)
        self.assertIn("claimed execution identity is immutable", guard_sql)
        self.assertIn("non-planned decision cannot start broker I/O", guard_sql)
        self.assertIn("matching execution already exists", guard_sql)
        self.assertIn("submission claim audit row cannot be deleted", guard_sql)
        self.assertIn("primary fencing epoch must be monotonic", guard_sql)
        self.assertIn("recovery fencing epoch must be monotonic", guard_sql)
        self.assertIn("BEFORE TRUNCATE", guard_sql)
        self.assertIn("torghut_lock_submission_identities", guard_sql)
        self.assertIn("BEFORE INSERT ON executions", guard_sql)
        claim_guard_sql = str(execute.call_args_list[1].args[0])
        self.assertLess(
            claim_guard_sql.index("PERFORM torghut_lock_submission_identities"),
            claim_guard_sql.index("SELECT alpaca_account_label"),
        )
        self.assertGreaterEqual(guard_sql.count("FOR UPDATE"), 2)

    def test_downgrade_removes_guards_indexes_and_table(self) -> None:
        module = load_migration_module(MIGRATION_FILENAME)

        with (
            patch.object(module.op, "execute") as execute,
            patch.object(module.op, "drop_index") as drop_index,
            patch.object(module.op, "drop_table") as drop_table,
        ):
            module.downgrade()

        self.assertEqual(execute.call_count, 11)
        self.assertIn(
            "LOCK TABLE executions, trade_decision_submission_claims "
            "IN ACCESS EXCLUSIVE MODE NOWAIT",
            str(execute.call_args_list[0].args[0]),
        )
        self.assertIn(
            "refusing to downgrade nonempty submission claim tombstones",
            str(execute.call_args_list[1].args[0]),
        )
        self.assertEqual(
            drop_index.call_args_list,
            [
                call(
                    "ix_trade_decision_submission_claim_recovery_due",
                    table_name="trade_decision_submission_claims",
                ),
                call(
                    "ix_trade_decision_submission_claim_state_lease",
                    table_name="trade_decision_submission_claims",
                ),
                call(
                    "uq_trade_decision_submission_recovery_token",
                    table_name="trade_decision_submission_claims",
                ),
                call(
                    "uq_trade_decision_submission_claim_account_client_order",
                    table_name="trade_decision_submission_claims",
                ),
                call(
                    "uq_trade_decision_submission_claim_token",
                    table_name="trade_decision_submission_claims",
                ),
                call(
                    "uq_executions_submission_claim_identity",
                    table_name="executions",
                ),
            ],
        )
        drop_table.assert_called_once_with("trade_decision_submission_claims")
