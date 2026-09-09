from pathlib import Path

from tests.migration_testing import load_migration_module


SERVICE_ROOT = Path(__file__).resolve().parents[2]
MIGRATION = (
    SERVICE_ROOT / "migrations" / "versions" / "0081_order_lineage_repair_receipts.py"
)


def test_order_lineage_migration_has_one_linear_parent() -> None:
    module = load_migration_module(MIGRATION.name)
    assert module.revision == "0081_order_lineage_receipts"
    assert module.down_revision == "0080_broker_econ_recon_freshness"
    assert module.branch_labels is None
    assert module.depends_on is None


def test_order_lineage_migration_is_append_only_and_non_promotional() -> None:
    text = MIGRATION.read_text()
    assert "order lineage repair receipt is append-only" in text
    assert "BEFORE INSERT OR UPDATE OR DELETE" in text
    assert "BEFORE TRUNCATE" in text
    assert "evidence JSON is not canonical" in text
    assert "expected_order_identity_material" in text
    assert "identity hash mismatch" in text
    assert "jsonb_array_elements_text(order_event_ids)" in text
    assert "value !~ '^[0-9a-f]{{8}}-[0-9a-f]{{4}}-'" in text
    assert "prior_value >= value" in text
    assert "match basis is not canonical" in text
    assert "blockers are not canonical" in text
    assert "causal link UUID is not canonical" in text
    assert "evidence shape mismatch" in text
    assert "evidence scalar type mismatch" in text
    assert "promotion_authority_eligible IS FALSE" in text
    assert "torghut.order-lineage-repair-evidence.v1" in text
    assert "uq_order_lineage_receipt_evidence" in text
    assert "order_identity_sha256" in text
    assert "evidence_sha256" in text
    assert "primary_order_id_kind" in text
    assert "fill_order_event_count = 0" in text
    assert 'sa.Column("canonical_execution_id"' not in text
    assert 'sa.Column("order_event_count"' not in text
