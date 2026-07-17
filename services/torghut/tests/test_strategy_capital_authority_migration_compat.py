from __future__ import annotations

from pathlib import Path

from alembic.config import Config as AlembicConfig
from alembic.script import ScriptDirectory

from tests.migration_testing import load_migration_module


SERVICE_ROOT = Path(__file__).resolve().parents[1]


def test_released_strategy_capital_revision_remains_addressable() -> None:
    compatibility = load_migration_module("0063_strategy_capital_authority_compat.py")
    merge = load_migration_module("0065_strategy_capital_authority_compat.py")

    assert compatibility.revision == "0063_strategy_capital_authority"
    assert compatibility.down_revision == "0062_options_archive_members"
    assert merge.revision == "0065_strategy_capital_compat"
    assert set(merge.down_revision) == {
        "0064_strategy_capital_authority",
        "0063_strategy_capital_authority",
    }


def test_migration_graph_has_one_merged_head_and_knows_the_released_revision() -> None:
    config = AlembicConfig(str(SERVICE_ROOT / "alembic.ini"))
    scripts = ScriptDirectory.from_config(config)

    assert scripts.get_heads() == ["0081_order_lineage_receipts"]
    assert scripts.get_revision("0063_strategy_capital_authority") is not None
    assert scripts.get_revision("0064_strategy_capital_authority") is not None
    assert scripts.get_revision("0065_strategy_capital_compat") is not None
    assert scripts.get_revision("0066_broker_submit_coordinator") is not None
    assert scripts.get_revision("0067_options_archive_status") is not None
    assert scripts.get_revision("0068_validation_submit") is not None
    assert scripts.get_revision("0069_strict_submit_recovery") is not None
    assert scripts.get_revision("0070_reduction_fencing") is not None
    assert scripts.get_revision("0071_validation_lineage") is not None
    assert scripts.get_revision("0072_validation_lifecycle") is not None
    assert scripts.get_revision("0073_live_paper_bounds") is not None
    assert scripts.get_revision("0074_crypto_qty_precision") is not None
    assert scripts.get_revision("0075_validation_observed_at") is not None
    assert scripts.get_revision("0076_broker_account_activities") is not None
    assert scripts.get_revision("0077_validation_quarantine") is not None
    assert scripts.get_revision("0078_broker_economic_ledger") is not None
    assert scripts.get_revision("0079_broker_econ_reconciliation") is not None
    assert scripts.get_revision("0080_broker_econ_recon_freshness") is not None
    assert scripts.get_revision("0081_order_lineage_receipts") is not None
