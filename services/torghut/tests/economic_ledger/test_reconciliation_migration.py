from __future__ import annotations

from pathlib import Path

from tests.migration_testing import load_migration_module


SERVICE_ROOT = Path(__file__).resolve().parents[2]
MIGRATION = (
    SERVICE_ROOT / "migrations" / "versions" / "0079_broker_economic_reconciliation.py"
)


def test_reconciliation_migration_has_one_linear_parent() -> None:
    module = load_migration_module(MIGRATION.name)

    assert module.revision == "0079_broker_econ_reconciliation"
    assert module.down_revision == "0078_broker_economic_ledger"
    assert module.branch_labels is None
    assert module.depends_on is None


def test_reconciliation_migration_enforces_append_only_run_bound_evidence() -> None:
    text = MIGRATION.read_text(encoding="utf-8")

    assert "broker economic reconciliation is append-only" in text
    assert "broker economic reconciliation run identity mismatch" in text
    assert "broker economic reconciliation hash mismatch" in text
    assert "journal_reducer <> 'balanced_journal'" in text
    assert "state_reducer <> 'independent_position_state'" in text
    assert "stored_input_watermark IS DISTINCT FROM NEW.source_watermark" in text
    assert "broker economic reconciliation source age mismatch" in text
    assert "result_document->>'input_manifest_sha256'" in text
    assert "result_document#>>'{{reducers,journal}}'" in text
    assert "refusing to discard broker economic reconciliation evidence" in text
    assert "ON DELETE CASCADE" not in text
