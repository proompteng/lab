from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import pytest

from tests.migration_testing import load_migration_module


MIGRATION_FILENAME = "0075_validation_observation_timestamp.py"
_FUNCTION_DEFINITION = """
CREATE OR REPLACE FUNCTION torghut_guard_bm_validation_lineage_0072()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
    IF observed_position_qty IS DISTINCT FROM latest_position_qty
       OR observed_at > NEW.created_at + interval '1 second'
       OR NEW.created_at - observed_at > interval '5 seconds' THEN
        RAISE EXCEPTION 'infrastructure validation position not reconciled';
    END IF;
    RETURN NEW;
END;
$function$
"""


def test_revision_extends_crypto_quantity_precision() -> None:
    module = load_migration_module(MIGRATION_FILENAME)

    assert module.revision == "0075_validation_observed_at"
    assert module.down_revision == "0074_crypto_qty_precision"
    assert len(module.revision) <= 32
    assert (
        len(Path(module.__file__ or "").read_text(encoding="utf-8").splitlines())
        <= 1000
    )


def test_lineage_rewrite_requires_and_round_trips_observation_timestamp() -> None:
    module = load_migration_module(MIGRATION_FILENAME)

    upgraded = module._rewrite_lineage_function(_FUNCTION_DEFINITION, upgrade=True)

    assert "IF observed_at IS NULL" in upgraded
    assert "OR observed_position_qty IS DISTINCT FROM latest_position_qty" in upgraded
    assert module._rewrite_lineage_function(upgraded, upgrade=False) == (
        _FUNCTION_DEFINITION
    )


def test_upgrade_locks_and_replaces_the_live_lineage_function() -> None:
    module = load_migration_module(MIGRATION_FILENAME)

    with (
        patch.object(
            module,
            "_current_lineage_function_definition",
            return_value=_FUNCTION_DEFINITION,
        ),
        patch.object(module.op, "execute") as execute,
    ):
        module.upgrade()

    sql = "\n".join(str(call.args[0]) for call in execute.call_args_list)
    assert "ACCESS EXCLUSIVE MODE NOWAIT" in sql
    assert "IF observed_at IS NULL" in sql
    assert "observed_position_qty IS DISTINCT FROM latest_position_qty" in sql


def test_rewrite_rejects_an_unrecognized_function_shape() -> None:
    module = load_migration_module(MIGRATION_FILENAME)

    with pytest.raises(
        RuntimeError,
        match="validation_observation_timestamp_guard_shape_invalid",
    ):
        module._rewrite_lineage_function("SELECT 1", upgrade=True)
