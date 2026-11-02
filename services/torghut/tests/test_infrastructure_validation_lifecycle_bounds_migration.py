from __future__ import annotations

from unittest.mock import patch

import pytest

from tests.migration_testing import load_migration_module


MIGRATION_FILENAME = "0073_live_paper_lifecycle_bounds.py"


def _definition(module: object, *, upgraded: bool = False) -> str:
    resting_bound = getattr(module, "_resting_close_bound_fragment")()
    if upgraded:
        schema_predicate = getattr(module, "_schema_pair_predicate")()
        cap_notional = getattr(module, "_versioned_cap_fragment")("max_notional_usd")
        cap_loss = getattr(module, "_versioned_cap_fragment")("max_loss_usd")
        lifecycle_bounds = (
            f"{getattr(module, '_partial_close_bound_fragment')()} AND "
            f"({getattr(module, '_floor_guard_fragment')()}) AND {resting_bound}"
        )
    else:
        schema_predicate = getattr(module, "_schema_predicate")(
            getattr(module, "_LEGACY_LIFECYCLE_SCHEMA")
        )
        cap = getattr(module, "_OLD_CAP")
        raw_cap_fragment = getattr(module, "_cap_fragment")
        cap_notional = raw_cap_fragment("max_notional_usd", cap)
        cap_loss = raw_cap_fragment("max_loss_usd", cap)
        lifecycle_bounds = (
            f"{getattr(module, '_partial_close_bound_fragment')()} AND {resting_bound}"
        )
    return (
        "CHECK (purpose <> 'control_plane_validation' OR ("
        f"{schema_predicate} AND "
        f"{cap_notional} AND "
        f"{cap_loss} AND "
        f"{lifecycle_bounds}))"
    )


def _lineage_definition(module: object, *, upgraded: bool = False) -> str:
    legacy = getattr(module, "_LEGACY_LIFECYCLE_SCHEMA")
    guard = f"root_plan_schema IS DISTINCT FROM\n    '{legacy}'"
    assignment = (
        "BEGIN\n"
        "    lineage := NEW.canonical_intent_json::jsonb #>\n"
        "        '{request,infrastructure_validation_lineage}';\n"
    )
    definition = assignment + "\n".join(f"IF {guard} THEN" for _ in range(3))
    if upgraded:
        return getattr(module, "_rewrite_lineage_function")(
            definition,
            upgrade=True,
        )
    return definition


def test_revision_extends_the_released_lifecycle_schema() -> None:
    module = load_migration_module(MIGRATION_FILENAME)

    assert module.revision == "0073_live_paper_bounds"
    assert module.down_revision == "0072_validation_lifecycle"


def test_upgrade_rewrite_versions_caps_and_leg_floors() -> None:
    module = load_migration_module(MIGRATION_FILENAME)

    condition = module._rewrite_lifecycle_authority(
        _definition(module),
        upgrade=True,
    )

    assert module._schema_pair_predicate() in condition
    assert module._versioned_cap_fragment("max_notional_usd") in condition
    assert module._versioned_cap_fragment("max_loss_usd") in condition
    assert module._floor_guard_fragment() in condition
    assert module._cap_fragment("max_notional_usd", 5) not in condition


def test_authority_rewrite_round_trips_to_the_released_contract() -> None:
    module = load_migration_module(MIGRATION_FILENAME)

    downgraded = module._rewrite_lifecycle_authority(
        _definition(module, upgraded=True),
        upgrade=False,
    )

    assert f"CHECK ({downgraded})" == _definition(module)


def test_lineage_rewrite_accepts_catalog_whitespace_and_round_trips() -> None:
    module = load_migration_module(MIGRATION_FILENAME)
    legacy_definition = _lineage_definition(module)

    upgraded = module._rewrite_lineage_function(legacy_definition, upgrade=True)

    assert upgraded.count(module._LIFECYCLE_SCHEMA) == 3
    assert "NOT IN" not in upgraded
    assert module._rewrite_lineage_function(upgraded, upgrade=False) == (
        legacy_definition.replace("\n    '", " '")
    )


@pytest.mark.parametrize(
    "definition",
    (
        "NOT A CHECK",
        "CHECK (missing lifecycle schema)",
    ),
)
def test_authority_rewrite_fails_closed_on_catalog_drift(definition: str) -> None:
    module = load_migration_module(MIGRATION_FILENAME)

    with pytest.raises(RuntimeError, match="validation_authority"):
        module._rewrite_lifecycle_authority(definition, upgrade=True)


def test_lineage_rewrite_fails_closed_on_catalog_drift() -> None:
    module = load_migration_module(MIGRATION_FILENAME)

    with pytest.raises(RuntimeError, match="validation_lineage"):
        module._rewrite_lineage_function("SELECT 1", upgrade=True)


def test_upgrade_locks_and_validates_versioned_contracts() -> None:
    module = load_migration_module(MIGRATION_FILENAME)

    with (
        patch.object(
            module,
            "_current_constraint_definition",
            return_value=_definition(module),
        ),
        patch.object(
            module,
            "_current_lineage_function_definition",
            return_value=_lineage_definition(module),
        ),
        patch.object(module.op, "execute") as execute,
        patch.object(module.op, "drop_constraint") as drop_constraint,
    ):
        module.upgrade()

    sql = "\n".join(str(call.args[0]) for call in execute.call_args_list)
    assert "ACCESS EXCLUSIVE MODE NOWAIT" in sql
    assert module._versioned_cap_fragment("max_notional_usd") in sql
    assert module._versioned_cap_fragment("max_loss_usd") in sql
    assert module._floor_guard_fragment() in sql
    assert sql.count(module._LIFECYCLE_SCHEMA) >= 6
    assert "NOT VALID" in sql
    assert "VALIDATE CONSTRAINT ck_bm_receipt_validation_authority" in sql
    assert f"CREATE FUNCTION {module._LEGACY_ROOT_FUNCTION}()" in sql
    assert f"CREATE TRIGGER {module._LEGACY_ROOT_TRIGGER}" in sql
    assert module._LEGACY_ROOT_RETIREMENT_ERROR in sql
    drop_constraint.assert_called_once_with(
        "ck_bm_receipt_validation_authority",
        "broker_mutation_receipts",
        type_="check",
    )


def test_downgrade_refuses_v2_evidence_before_restoring_v1() -> None:
    module = load_migration_module(MIGRATION_FILENAME)

    with (
        patch.object(
            module,
            "_current_constraint_definition",
            return_value=_definition(module, upgraded=True),
        ),
        patch.object(
            module,
            "_current_lineage_function_definition",
            return_value=_lineage_definition(module, upgraded=True),
        ),
        patch.object(module.op, "execute") as execute,
        patch.object(module.op, "drop_constraint"),
    ):
        module.downgrade()

    sql = "\n".join(str(call.args[0]) for call in execute.call_args_list)
    assert "cannot downgrade with lifecycle v2 receipts" in sql
    assert module._cap_fragment("max_notional_usd", 5) in sql
    assert module._cap_fragment("max_loss_usd", 5) in sql
    assert all(fragment not in sql for fragment in module._leg_floor_fragments())
    assert f"DROP TRIGGER {module._LEGACY_ROOT_TRIGGER}" in sql
    assert f"DROP FUNCTION {module._LEGACY_ROOT_FUNCTION}()" in sql
