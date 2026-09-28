from __future__ import annotations

from app.trading.execution_metadata import (
    execution_metadata,
    mutable_execution_metadata,
    set_execution_metadata,
)


def test_execution_metadata_ignores_removed_simple_lane_key() -> None:
    params: dict[str, object] = {
        "simple_lane": {
            "price": "999",
            "quantity_resolution": {"short_increasing": False},
        }
    }

    assert execution_metadata(params) is None
    assert mutable_execution_metadata(params) == {}


def test_set_execution_metadata_drops_removed_simple_lane_key() -> None:
    params: dict[str, object] = {
        "simple_lane": {"price": "999"},
        "execution": {"price": "100"},
    }

    set_execution_metadata(params, {"price": "101"})

    assert params == {"execution": {"price": "101"}}
