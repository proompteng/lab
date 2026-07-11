from __future__ import annotations

import re
from pathlib import Path
from unittest import TestCase
from unittest.mock import patch

from tests.migration_testing import load_migration_module


MIGRATION_FILENAME = "0061_linked_submission_terminal.py"


class TestLinkedSubmissionTerminalMigration(TestCase):
    def test_revision_is_bounded_and_extends_evidence_contract(self) -> None:
        module = load_migration_module(MIGRATION_FILENAME)

        self.assertEqual(module.revision, "0061_linked_submission_terminal")
        self.assertEqual(module.down_revision, "0060_bm_evidence_envelopes")
        self.assertLessEqual(len(module.revision), 32)
        source = Path(module.__file__ or "").read_text(encoding="utf-8")
        self.assertLessEqual(len(source.splitlines()), 1000)

    def test_upgrade_installs_atomic_triangle_and_rejected_tombstone(self) -> None:
        module = load_migration_module(MIGRATION_FILENAME)

        with (
            patch.object(module.op, "execute") as execute,
            patch.object(module.op, "add_column") as add_column,
            patch.object(module.op, "create_foreign_key") as create_foreign_key,
            patch.object(module.op, "create_index") as create_index,
            patch.object(module.op, "drop_constraint"),
            patch.object(module.op, "create_check_constraint") as create_check,
        ):
            module.upgrade()

        add_column.assert_called_once()
        create_foreign_key.assert_called_once_with(
            "fk_td_submission_claim_terminal_receipt_event",
            "trade_decision_submission_claims",
            "broker_mutation_receipt_events",
            ["terminal_receipt_event_id"],
            ["id"],
            ondelete="RESTRICT",
            onupdate="RESTRICT",
        )
        create_index.assert_called_once_with(
            "uq_trade_decision_submission_terminal_receipt_event",
            "trade_decision_submission_claims",
            ["terminal_receipt_event_id"],
            unique=True,
        )
        self.assertEqual(create_check.call_count, 8)
        sql = "\n".join(str(call.args[0]) for call in execute.call_args_list)
        for marker in (
            "ACCESS EXCLUSIVE MODE NOWAIT",
            "refusing to upgrade nonempty linked submission terminal state",
            "torghut_guard_rejected_submission_claim_0061",
            "torghut_guard_bm_linked_terminal_0061",
            "torghut.linked-submission-terminal.v1",
            "torghut_assert_linked_submission_terminal_0061",
            "terminal_receipt_event_id",
            "linked rejected execution truth mismatch",
            "linked submitted execution truth mismatch",
            "event.settlement_source <> 'primary'",
            "DEFERRABLE INITIALLY DEFERRED",
        ):
            self.assertIn(marker, sql)
        for trigger in (
            "trg_check_submission_claim_terminal_0061",
            "trg_check_bm_event_terminal_0061",
            "trg_check_execution_terminal_0061",
        ):
            self.assertIn(f"CREATE CONSTRAINT TRIGGER {trigger}", sql)
        names = re.findall(r"CREATE (?:FUNCTION|TRIGGER) ([a-zA-Z0-9_]+)", sql)
        self.assertTrue(names)
        self.assertTrue(all(len(name) <= 63 for name in names))

    def test_downgrade_refuses_nonempty_state_and_restores_0060_names(self) -> None:
        module = load_migration_module(MIGRATION_FILENAME)

        with (
            patch.object(module.op, "execute") as execute,
            patch.object(module.op, "drop_constraint"),
            patch.object(module.op, "create_check_constraint"),
            patch.object(module.op, "drop_index"),
            patch.object(module.op, "drop_column"),
        ):
            module.downgrade()

        sql = "\n".join(str(call.args[0]) for call in execute.call_args_list)
        self.assertIn(
            "refusing to downgrade nonempty linked submission terminal state",
            sql,
        )
        self.assertIn("DROP TRIGGER trg_check_execution_terminal_0061", sql)
        self.assertIn(
            "DROP FUNCTION torghut_assert_linked_submission_terminal_0061", sql
        )
        self.assertIn("CREATE TRIGGER trg_guard_td_submission_claim ", sql)
        self.assertIn(
            "CREATE TRIGGER trg_guard_bm_receipt_event_b_linked_0060",
            sql,
        )
        self.assertIn(
            "CREATE TRIGGER trg_guard_bm_receipt_event_c_settlement_0060",
            sql,
        )
