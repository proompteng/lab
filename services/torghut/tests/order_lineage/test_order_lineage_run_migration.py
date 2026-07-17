from pathlib import Path

from tests.migration_testing import load_migration_module


SERVICE_ROOT = Path(__file__).resolve().parents[2]
MIGRATION = (
    SERVICE_ROOT / "migrations" / "versions" / "0082_order_lineage_repair_runs.py"
)


def test_order_lineage_run_migration_has_one_linear_parent() -> None:
    module = load_migration_module(MIGRATION.name)
    assert module.revision == "0082_order_lineage_runs"
    assert module.down_revision == "0081_order_lineage_receipts"
    assert module.branch_labels is None
    assert module.depends_on is None


def test_order_lineage_run_migration_is_closed_and_append_only() -> None:
    text = MIGRATION.read_text()
    assert "order lineage repair run is append-only" in text
    assert "BEFORE INSERT OR UPDATE OR DELETE" in text
    assert "BEFORE TRUNCATE" in text
    assert "torghut.order-lineage-census-input.v1" in text
    assert "torghut.order-lineage-census-result.v1" in text
    assert "broker_economic_input_id" in text
    assert "order lineage broker input mismatch" in text
    assert "expected_order_identity_count" in text
    assert "classification counts mismatch" in text
    assert "source coverage counts mismatch" in text
    assert "promotion_authority_eligible IS FALSE" in text
