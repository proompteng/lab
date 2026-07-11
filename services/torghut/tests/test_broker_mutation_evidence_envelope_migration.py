from __future__ import annotations

from pathlib import Path
import re
from unittest import TestCase
from unittest.mock import patch

from tests.migration_testing import load_migration_module


MIGRATION_FILENAME = "0060_broker_mutation_evidence_envelopes.py"


class TestBrokerMutationEvidenceEnvelopeMigration(TestCase):
    def test_revision_extends_receipt_foundation_with_bounded_source(self) -> None:
        module = load_migration_module(MIGRATION_FILENAME)

        self.assertEqual(module.revision, "0060_bm_evidence_envelopes")
        self.assertEqual(module.down_revision, "0059_broker_mutation_receipts")
        self.assertLessEqual(len(module.revision), 32)
        source = Path(module.__file__ or "").read_text(encoding="utf-8")
        self.assertLessEqual(len(source.splitlines()), 1000)

    def test_upgrade_installs_recursive_secret_and_envelope_guards(self) -> None:
        module = load_migration_module(MIGRATION_FILENAME)

        with (
            patch.object(module.op, "execute") as execute,
            patch.object(module.op, "add_column") as add_column,
            patch.object(module.op, "create_check_constraint") as create_constraint,
        ):
            module.upgrade()

        self.assertEqual(add_column.call_count, 3)
        create_constraint.assert_called_once()
        statements = [str(item.args[0]) for item in execute.call_args_list]
        self.assertIn("ACCESS EXCLUSIVE MODE NOWAIT", statements[0])
        self.assertIn(
            "refusing to upgrade nonempty unsafe 0059 broker mutation receipt state",
            statements[1],
        )
        guard_sql = "\n".join(str(item.args[0]) for item in execute.call_args_list)
        for marker in (
            "torghut_bm_canonical_json_0060",
            "torghut_assert_bm_canonical_json_0060",
            "json_each(document)",
            "json_array_elements(document)",
            'COLLATE "C"',
            "normalize(key, NFC)",
            "normalized_text IS DISTINCT FROM normalize(",
            "^(0|-?[1-9][0-9]*)$",
            "convert_to(raw_document, 'UTF8')",
            "NEW.canonical_intent_json",
            "NEW.recovery_evidence_json",
            "NEW.settlement_evidence_json",
        ):
            self.assertIn(marker, guard_sql)
        for marker in (
            "apikey",
            "authorization",
            "bearer",
            "cookie",
            "credential",
            "password",
            "passwd",
            "privatekey",
            "secret",
            "token",
        ):
            self.assertIn(marker, guard_sql)
        self.assertIn("normalize(raw_key, NFKC)", guard_sql)
        self.assertIn("'ǰẖẗẘẙ', 'jhtwy'", guard_sql)
        self.assertIn("'ß', 'ss'", guard_sql)
        self.assertIn("translate", guard_sql)
        self.assertIn("regexp_replace", guard_sql)
        self.assertIn("jsonb_each(document)", guard_sql)
        self.assertIn("jsonb_array_elements(document)", guard_sql)
        self.assertIn("torghut_assert_bm_no_secret_keys_0060", guard_sql)
        self.assertIn("intent_document -> 'request'", guard_sql)
        self.assertIn("NEW.recovery_evidence_json::jsonb", guard_sql)
        self.assertIn("NEW.settlement_evidence_json::jsonb", guard_sql)

        for trigger_name in (
            "trg_guard_bm_receipt_a_claim_0060",
            "trg_guard_bm_receipt_b_request_secrets_0060",
            "trg_guard_bm_receipt_event_a_secrets_0060",
            "trg_guard_bm_receipt_event_b_linked_0060",
            "trg_guard_bm_receipt_event_b_recovery_0060",
            "trg_guard_bm_receipt_event_c_settlement_0060",
        ):
            self.assertIn(f"CREATE TRIGGER {trigger_name}", guard_sql)
        self.assertGreaterEqual(guard_sql.count("BEFORE INSERT"), 6)

        self.assertIn("claim_client_request_id", guard_sql)
        self.assertIn("claim_state IS DISTINCT FROM 'claimed'", guard_sql)
        self.assertIn("replace receipts remain disabled", guard_sql)
        self.assertIn("NEW.submission_claim_id", guard_sql)
        self.assertIn("linked broker mutation settlement requires", guard_sql)

        self.assertIn("recovery-evidence.v1", guard_sql)
        self.assertIn("checked_client_request_id", guard_sql)
        self.assertIn("checked_target_key", guard_sql)
        self.assertIn("NEW.recovery_outcome", guard_sql)
        self.assertIn("jsonb_typeof(evidence_document -> 'observation')", guard_sql)
        self.assertIn("jsonb_object_keys(evidence_document)) <> 5", guard_sql)

        self.assertIn("settlement-evidence.v1", guard_sql)
        self.assertIn("NEW.settlement_source", guard_sql)
        self.assertIn("NEW.settlement_outcome", guard_sql)
        self.assertIn("NEW.broker_reference", guard_sql)
        self.assertIn("NEW.execution_id::text", guard_sql)
        self.assertIn("jsonb_typeof(evidence_document -> 'evidence')", guard_sql)
        self.assertIn("jsonb_object_keys(evidence_document)) <> 6", guard_sql)

        names = re.findall(r"CREATE (?:FUNCTION|TRIGGER) ([a-zA-Z0-9_]+)", guard_sql)
        self.assertTrue(names)
        self.assertTrue(all(len(name) <= 63 for name in names))

    def test_downgrade_refuses_nonempty_state_before_dropping_guards(self) -> None:
        module = load_migration_module(MIGRATION_FILENAME)

        with (
            patch.object(module.op, "execute") as execute,
            patch.object(module.op, "drop_constraint") as drop_constraint,
            patch.object(module.op, "drop_column") as drop_column,
        ):
            module.downgrade()

        statements = [str(item.args[0]) for item in execute.call_args_list]
        self.assertIn(
            "LOCK TABLE broker_mutation_receipts, "
            "broker_mutation_receipt_events IN ACCESS EXCLUSIVE MODE NOWAIT",
            statements[0],
        )
        self.assertIn(
            "refusing to downgrade nonempty broker mutation evidence envelopes",
            statements[1],
        )
        drop_sql = "\n".join(statements[2:])
        drop_constraint.assert_called_once()
        self.assertEqual(drop_column.call_count, 3)
        for object_name in (
            "trg_guard_bm_receipt_event_c_settlement_0060",
            "trg_guard_bm_receipt_event_b_recovery_0060",
            "trg_guard_bm_receipt_event_b_linked_0060",
            "trg_guard_bm_receipt_event_a_secrets_0060",
            "trg_guard_bm_receipt_b_request_secrets_0060",
            "trg_guard_bm_receipt_a_claim_0060",
            "torghut_guard_bm_settlement_envelope_0060",
            "torghut_guard_bm_recovery_envelope_0060",
            "torghut_assert_bm_no_secret_keys_0060",
            "torghut_bm_security_key_0060",
            "torghut_assert_bm_canonical_json_0060",
            "torghut_bm_canonical_json_0060",
        ):
            self.assertIn(object_name, drop_sql)
