"""Regression coverage for Hyperliquid reconciliation key aliases."""

from __future__ import annotations

from decimal import Decimal

from app.hyperliquid_execution.models import ExecutionMarket
from app.hyperliquid_execution.reconciliation_keys import (
    market_id_by_reconciliation_coin,
)


def test_reconciliation_map_registers_scoped_coin_aliases() -> None:
    scoped = _market(
        market_id="hl:perp:xyz:NVDA",
        coin="NVDA",
        dex="xyz",
    )
    default = _market(
        market_id="hl:perp:default:ETH",
        coin="ETH",
        dex="default",
    )
    already_scoped = _market(
        market_id="hl:perp:abc:abc:BTC",
        coin="abc:BTC",
        dex="abc",
    )

    market_id_by_coin = market_id_by_reconciliation_coin(
        (scoped, default, already_scoped)
    )

    assert market_id_by_coin["NVDA"] == "hl:perp:xyz:NVDA"
    assert market_id_by_coin["xyz:NVDA"] == "hl:perp:xyz:NVDA"
    assert market_id_by_coin["ETH"] == "hl:perp:default:ETH"
    assert market_id_by_coin["abc:BTC"] == "hl:perp:abc:abc:BTC"
    assert market_id_by_coin.canonical_coin_by_coin["xyz:NVDA"] == "NVDA"
    assert market_id_by_coin.canonical_coin_by_coin["abc:BTC"] == "abc:BTC"


def _market(*, market_id: str, coin: str, dex: str) -> ExecutionMarket:
    return ExecutionMarket(
        market_id=market_id,
        coin=coin,
        dex=dex,
        network="mainnet",
        day_notional_volume_usd=Decimal("1000"),
        mark_price=Decimal("100"),
        mid_price=Decimal("100"),
        payload={"source": "test"},
    )
