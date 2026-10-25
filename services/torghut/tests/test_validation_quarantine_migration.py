from __future__ import annotations

import importlib.util
from pathlib import Path
from types import ModuleType


SERVICE_ROOT = Path(__file__).resolve().parents[1]
MIGRATION = (
    SERVICE_ROOT / "migrations" / "versions" / "0077_validation_quarantine_closure.py"
)


def _load_migration() -> ModuleType:
    spec = importlib.util.spec_from_file_location(
        "validation_quarantine_migration", MIGRATION
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_validation_quarantine_migration_has_one_linear_parent() -> None:
    module = _load_migration()

    assert module.revision == "0077_validation_quarantine"
    assert module.down_revision == "0076_broker_account_activities"
    assert module.branch_labels is None
    assert module.depends_on is None


def test_validation_quarantine_migration_is_narrow_and_fail_closed() -> None:
    text = MIGRATION.read_text(encoding="utf-8")

    assert "operator_confirmation" in text
    assert "validation_quarantine_closed" in text
    assert "control_plane_validation" in text
    assert "time_in_force}' IS DISTINCT FROM 'ioc'" in text
    assert "non_promotable_validation" in text
    assert "order_existence_resolution' IS DISTINCT FROM 'unresolved'" in text
    assert "refusing to downgrade validation quarantine evidence" in text
    assert "DELETE FROM broker_mutation" not in text
