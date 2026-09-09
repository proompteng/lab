from __future__ import annotations

from sqlalchemy import Numeric

from app.models import ExecutionOrderEvent
from tests.migration_testing import load_migration_module


def test_revision_follows_live_paper_bounds() -> None:
    module = load_migration_module("0074_order_feed_crypto_quantity_precision.py")

    assert module.revision == "0074_crypto_qty_precision"
    assert module.down_revision == "0073_live_paper_bounds"


def test_order_feed_quantity_columns_preserve_alpaca_precision() -> None:
    table = ExecutionOrderEvent.__table__

    for column_name in ("qty", "filled_qty", "filled_qty_delta", "position_qty"):
        column_type = table.c[column_name].type
        assert isinstance(column_type, Numeric)
        assert column_type.precision == 21
        assert column_type.scale == 9
