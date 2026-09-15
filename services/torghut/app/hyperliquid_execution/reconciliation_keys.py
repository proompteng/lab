"""Exchange reconciliation key helpers."""

from __future__ import annotations

from collections.abc import Mapping

from .models import ExecutionMarket


class ReconciliationCoinMap(dict[str, str]):
    """Map exchange payload coins to market ids and canonical selected coins."""

    def __init__(
        self,
        market_id_by_coin: Mapping[str, str],
        canonical_coin_by_coin: Mapping[str, str],
    ) -> None:
        super().__init__(market_id_by_coin)
        self.canonical_coin_by_coin = dict(canonical_coin_by_coin)


def market_id_by_reconciliation_coin(
    execution_markets: tuple[ExecutionMarket, ...],
) -> ReconciliationCoinMap:
    market_id_by_coin: dict[str, str] = {}
    canonical_coin_by_coin: dict[str, str] = {}
    for market in execution_markets:
        market_id_by_coin[market.coin] = market.market_id
        canonical_coin_by_coin[market.coin] = market.coin
        reconciliation_coin = _reconciliation_coin(market.coin, market.dex)
        market_id_by_coin[reconciliation_coin] = market.market_id
        canonical_coin_by_coin[reconciliation_coin] = market.coin
    return ReconciliationCoinMap(market_id_by_coin, canonical_coin_by_coin)


def _reconciliation_coin(coin: str, dex: str) -> str:
    normalized_coin = coin.strip()
    if ":" in normalized_coin:
        return normalized_coin
    normalized_dex = dex.strip().lower()
    if normalized_dex in {"", "default"}:
        return normalized_coin
    return f"{normalized_dex}:{normalized_coin}"
