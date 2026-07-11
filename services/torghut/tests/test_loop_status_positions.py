"""Regression coverage for scoped and durable loop-status position ownership."""

from app.trading.loop_status_positions import (
    managed_exchange_positions,
    position_coin_set,
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
