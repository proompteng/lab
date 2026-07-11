"""Regression coverage for scoped and durable loop-status position ownership."""

from datetime import datetime, timezone

from app.trading.loop_status import (
    LoopStatusOptions,
    LoopStatusRows,
    _blockers,
    _proof_summary,
)
from app.trading.loop_status_positions import (
    managed_exchange_positions,
    position_coin_set,
    raw_account_positions,
)


def test_scoped_exchange_coin_matches_persisted_canonical_coin() -> None:
    raw = ({"coin": "xyz:NVDA", "size": "1"},)

    managed = managed_exchange_positions(
        ({"coin": "NVDA"},),
        raw,
        (),
    )

    assert managed == list(raw)
    assert position_coin_set(managed) == {"NVDA"}


def test_configured_coin_remains_managed_when_not_selected_this_cycle() -> None:
    raw = ({"coin": "xyz:MU", "size": "1"},)

    managed = managed_exchange_positions(
        (),
        raw,
        (),
        ("xyz:MU",),
    )

    assert managed == list(raw)


def test_scoped_configuration_does_not_claim_same_coin_on_another_dex() -> None:
    configured = {"coin": "xyz:NVDA", "size": "1"}
    other_dex = {"coin": "abc:NVDA", "size": "1"}

    managed = managed_exchange_positions(
        ({"coin": "NVDA"},),
        (configured, other_dex),
        ("NVDA",),
        ("xyz:NVDA",),
    )

    assert managed == [configured]


def test_unconfigured_unpersisted_coin_is_not_claimed() -> None:
    raw = ({"coin": "xyz:UNMANAGED", "size": "1"},)

    assert managed_exchange_positions((), raw, (), ("xyz:MU",)) == []


def test_raw_dex_positions_inherit_parent_scope_when_coin_is_unscoped() -> None:
    positions = raw_account_positions(
        {
            "raw_payload": {
                "dexStates": {
                    "xyz": {
                        "assetPositions": [{"position": {"coin": "NVDA", "szi": "1"}}]
                    },
                    "abc": {
                        "assetPositions": [{"position": {"coin": "NVDA", "szi": "2"}}]
                    },
                }
            }
        }
    )

    assert [(row["coin"], row["size"]) for row in positions] == [
        ("abc:NVDA", "2"),
        ("xyz:NVDA", "1"),
    ]


def test_unmanaged_scoped_position_blocks_reconciliation() -> None:
    generated_at = datetime(2026, 7, 11, 17, 0, tzinfo=timezone.utc)
    rows = LoopStatusRows(
        latest_cycle={},
        latest_signal={},
        latest_order={},
        counts_24h={},
        fill_summary={},
        latest_fill={},
        latest_account={
            "observed_at": generated_at,
            "raw_payload": {
                "dexStates": {
                    "xyz": {
                        "assetPositions": [{"position": {"coin": "NVDA", "szi": "1"}}]
                    },
                    "abc": {
                        "assetPositions": [{"position": {"coin": "NVDA", "szi": "1"}}]
                    },
                }
            },
        },
        positions=({"coin": "NVDA"},),
        performance={},
        stale_open_orders=(),
        unexpected_live_alpaca={},
        query_errors=(),
    )
    summary = _proof_summary(
        rows,
        LoopStatusOptions(
            generated_at=generated_at,
            configured_symbols=("xyz:NVDA",),
        ),
    )

    assert [row["coin"] for row in summary.managed_exchange_positions] == ["xyz:NVDA"]
    assert [row["coin"] for row in summary.unmanaged_exchange_positions] == ["abc:NVDA"]
    assert summary.positions_reconciled is False
    assert "hyperliquid_position_reconciliation_missing" in _blockers(
        summary, min_recent_fills=0
    )
