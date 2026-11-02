from __future__ import annotations

from collections import defaultdict
from decimal import Decimal
from typing import Any

from .replay_types import ClosedTrade, _decimal_text, logger


def _record_fill_order_type(stats: dict[str, Any], order_type: str) -> None:
    order_type_counts = stats.setdefault("filled_count_by_order_type", defaultdict(int))
    order_type_counts[order_type] += 1


def _ensure_replay_stats_bucket(bucket: dict[str, Any]) -> dict[str, Any]:
    bucket.setdefault("decision_count", 0)
    bucket.setdefault("filled_count", 0)
    bucket.setdefault("decision_count_by_order_type", defaultdict(int))
    bucket.setdefault("filled_count_by_order_type", defaultdict(int))
    bucket.setdefault("filled_notional", Decimal("0"))
    bucket.setdefault("daily_adv_notional", Decimal("0"))
    bucket.setdefault("depth_notional", None)
    bucket.setdefault("liquidity_observation_count", 0)
    bucket.setdefault("gross_pnl", Decimal("0"))
    bucket.setdefault("net_pnl", Decimal("0"))
    bucket.setdefault("cost_total", Decimal("0"))
    bucket.setdefault("wins", 0)
    bucket.setdefault("losses", 0)
    bucket.setdefault("closed_trades", [])
    bucket.setdefault("closed_trade_count", 0)
    bucket.setdefault("capital_snapshot_count", 0)
    bucket.setdefault("min_cash", None)
    bucket.setdefault("min_equity", None)
    bucket.setdefault("max_gross_exposure", Decimal("0"))
    bucket.setdefault("max_net_exposure_abs", Decimal("0"))
    bucket.setdefault("max_gross_exposure_pct_equity", Decimal("0"))
    bucket.setdefault("negative_cash_observation_count", 0)
    return bucket


def _log_trade_closed(trade: ClosedTrade) -> None:
    logger.info(
        "replay_trade_closed symbol=%s strategy_id=%s opened_at=%s closed_at=%s qty=%s entry=%s exit=%s gross_pnl=%s net_pnl=%s exit_reason=%s",
        trade.symbol,
        trade.strategy_id,
        trade.opened_at.isoformat(),
        trade.closed_at.isoformat(),
        _decimal_text(trade.qty),
        _decimal_text(trade.entry_price),
        _decimal_text(trade.exit_price),
        _decimal_text(trade.gross_pnl),
        _decimal_text(trade.net_pnl),
        trade.exit_reason,
    )
