"""Repository fill identity compatibility regressions."""

from __future__ import annotations

from dataclasses import replace

from app.hyperliquid_execution.repository import HyperliquidExecutionRepository

from tests.hyperliquid_execution.test_runtime_surfaces import (
    _FakeSession,
    _fill,
    _now,
)


def test_repository_deduplicates_legacy_hash_fill_before_tid_insert() -> None:
    session = _FakeSession()
    repo = HyperliquidExecutionRepository(session)
    fill = replace(
        _fill(_now()),
        fill_hash="trade-1",
        raw_payload={"hash": "order-hash", "tid": "trade-1"},
    )

    assert repo.upsert_fills((fill,)) == 1

    fill_calls = [
        (sql, params)
        for sql, params in session.calls
        if params is not None and params.get("fill_hash") == "trade-1"
    ]
    assert "UPDATE hyperliquid_execution_fills" in fill_calls[0][0]
    assert "DELETE FROM hyperliquid_execution_fills" in fill_calls[1][0]
    assert "INSERT INTO hyperliquid_execution_fills" in fill_calls[2][0]
    assert "CAST(:exchange_order_id AS text) IS NULL" in fill_calls[0][0]
    assert "CAST(:exchange_order_id AS text) IS NULL" in fill_calls[1][0]
    assert "OR :exchange_order_id IS NULL" not in fill_calls[0][0]
    assert "OR :exchange_order_id IS NULL" not in fill_calls[1][0]
    assert fill_calls[0][1] is not None
    assert fill_calls[0][1]["legacy_fill_hash"] == "order-hash"
    assert fill_calls[1][1] is not None
    assert fill_calls[1][1]["legacy_fill_hash"] == "order-hash"
