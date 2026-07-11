from __future__ import annotations

import re
from pathlib import Path
from unittest import TestCase
from unittest.mock import patch

from tests.migration_testing import load_migration_module


MIGRATION_FILENAME = "0062_linked_submission_recovery.py"


class TestLinkedSubmissionRecoveryMigration(TestCase):
    def test_revision_is_bounded_and_extends_linked_terminal_contract(self) -> None:
        module = load_migration_module(MIGRATION_FILENAME)

        self.assertEqual(module.revision, "0062_linked_submission_recovery")
        self.assertEqual(module.down_revision, "0061_linked_submission_terminal")
        self.assertLessEqual(len(module.revision), 32)
        source = Path(module.__file__ or "").read_text(encoding="utf-8")
        self.assertLessEqual(len(source.splitlines()), 1100)

    def test_upgrade_installs_paired_fenced_recovery_terminal_contract(self) -> None:
        module = load_migration_module(MIGRATION_FILENAME)

        with patch.object(module.op, "execute") as execute:
            module.upgrade()

        self.assertEqual(execute.call_count, 6)
        sql = "\n".join(str(call.args[0]) for call in execute.call_args_list)
        for marker in (
            "ACCESS EXCLUSIVE MODE NOWAIT",
            "refusing to upgrade asymmetric linked submission recovery state",
            "CREATE OR REPLACE FUNCTION torghut_guard_broker_mutation_event()",
            "NEW.recovery_lease_expires_at := now_at",
            "THEN ARRAY['recovery_lease_expires_at']",
            "CREATE OR REPLACE FUNCTION torghut_guard_bm_linked_terminal_0061()",
            "NEW.submission_claim_token IS NOT NULL",
            "NEW.submission_claim_fencing_epoch IS NOT NULL",
            "NEW.submission_claim_owner IS NOT NULL",
            "unlinked broker mutation event has claim identity",
            "NEW.settlement_source = 'primary'",
            "ELSIF NEW.settlement_source = 'recovery'",
            "NEW.settlement_outcome <> 'reconciled'",
            "linked recovery terminal fence mismatch",
            "torghut.linked-submission-terminal.v1",
            "torghut.linked-submission-recovery-terminal.v1",
            "'checked_client_order_id'",
            "'checked_target_key'",
            "'observation_outcome'",
            "IS DISTINCT FROM 'found'",
            "linked recovery terminal evidence envelope mismatch",
            "linked nonterminal recovery state is asymmetric",
            "event.recovery_token IS DISTINCT FROM claim.recovery_token",
            "event.recovery_lease_expires_at",
            "IS DISTINCT FROM claim.recovery_lease_expires_at",
            "claim.recovery_checked_at IS DISTINCT FROM event.settled_at",
            "claim.recovery_lease_expires_at IS DISTINCT FROM event.settled_at",
            "event.recovery_lease_expires_at IS DISTINCT FROM event.settled_at",
            "claim.recovery_observation_epoch",
            "IS DISTINCT FROM claim.recovery_fencing_epoch",
            "claim.recovery_outcome <> 'found'",
            "claim.recovery_evidence",
            "IS DISTINCT FROM event.settlement_evidence_json",
            "linked recovery terminal observation mismatch",
        ):
            self.assertIn(marker, sql)
        self.assertNotIn("DROP TRIGGER", sql)
        self.assertNotIn("CREATE TRIGGER", sql)
        names = re.findall(
            r"CREATE OR REPLACE FUNCTION ([a-zA-Z0-9_]+)",
            sql,
        )
        self.assertEqual(
            set(names),
            {
                "torghut_guard_broker_mutation_event",
                "torghut_guard_bm_linked_terminal_0061",
                "torghut_guard_bm_settlement_envelope_0061",
                "torghut_assert_linked_submission_terminal_0061",
            },
        )
        self.assertTrue(all(len(name) <= 63 for name in names))

    def test_downgrade_refuses_recovery_terminals_and_restores_0061(self) -> None:
        module = load_migration_module(MIGRATION_FILENAME)

        with patch.object(module.op, "execute") as execute:
            module.downgrade()

        self.assertEqual(execute.call_count, 6)
        sql = "\n".join(str(call.args[0]) for call in execute.call_args_list)
        for marker in (
            "ACCESS EXCLUSIVE MODE NOWAIT",
            "refusing to downgrade linked recovery terminal state",
            "event.settlement_source = 'recovery'",
            "CREATE OR REPLACE FUNCTION torghut_guard_broker_mutation_event()",
            "NEW.submission_claim_token IS NOT NULL",
            "NEW.submission_claim_fencing_epoch IS NOT NULL",
            "NEW.submission_claim_owner IS NOT NULL",
            "unlinked broker mutation event has claim identity",
            "NEW.settlement_source <> 'primary'",
            "torghut.linked-submission-terminal.v1",
            "event.settlement_source <> 'primary'",
        ):
            self.assertIn(marker, sql)
        self.assertNotIn("torghut.linked-submission-recovery-terminal.v1", sql)
        self.assertNotIn("THEN ARRAY['recovery_lease_expires_at']", sql)
        self.assertNotIn("linked nonterminal recovery state is asymmetric", sql)
        self.assertNotIn("DROP TRIGGER", sql)
        self.assertNotIn("CREATE TRIGGER", sql)
