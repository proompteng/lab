"""Postgres operational truth for the Hyperliquid runtime lane."""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from decimal import Decimal
from typing import Iterable

from sqlalchemy import text
from sqlalchemy.orm import Session

from .models import (
    DecisionRecord,
    Fill,
    HyperliquidMarket,
    OrderIntent,
    OrderResult,
    PerformanceSnapshot,
    RiskState,
    RuntimeDependencyStatus,
    Signal,
)


class HyperliquidRuntimeRepository:
    """Persistence facade for runtime tables created by migration 0054."""

    def __init__(self, session: Session) -> None:
        self._session = session

    def upsert_markets(self, markets: Iterable[HyperliquidMarket]) -> None:
        for market in markets:
            self._session.execute(
                text(
                    """
                    INSERT INTO hyperliquid_runtime_markets (
                      network,
                      market_id,
                      coin,
                      dex,
                      asset_class,
                      day_notional_volume_usd,
                      mark_price,
                      mid_price,
                      open_interest_usd,
                      max_leverage,
                      payload,
                      updated_at
                    )
                    VALUES (
                      :network,
                      :market_id,
                      :coin,
                      :dex,
                      :asset_class,
                      :day_notional_volume_usd,
                      :mark_price,
                      :mid_price,
                      :open_interest_usd,
                      :max_leverage,
                      CAST(:payload AS jsonb),
                      now()
                    )
                    ON CONFLICT (network, market_id) DO UPDATE SET
                      coin = EXCLUDED.coin,
                      dex = EXCLUDED.dex,
                      asset_class = EXCLUDED.asset_class,
                      day_notional_volume_usd = EXCLUDED.day_notional_volume_usd,
                      mark_price = EXCLUDED.mark_price,
                      mid_price = EXCLUDED.mid_price,
                      open_interest_usd = EXCLUDED.open_interest_usd,
                      max_leverage = EXCLUDED.max_leverage,
                      payload = EXCLUDED.payload,
                      updated_at = now()
                    """
                ),
                {
                    "network": market.network,
                    "market_id": market.market_id,
                    "coin": market.coin,
                    "dex": market.dex,
                    "asset_class": market.asset_class,
                    "day_notional_volume_usd": str(market.day_notional_volume_usd),
                    "mark_price": _decimal_or_none(market.mark_price),
                    "mid_price": _decimal_or_none(market.mid_price),
                    "open_interest_usd": str(market.open_interest_usd),
                    "max_leverage": market.max_leverage,
                    "payload": json.dumps(market.payload, sort_keys=True),
                },
            )

    def insert_signal(self, signal: Signal) -> str:
        signal_id = str(uuid.uuid4())
        self._session.execute(
            text(
                """
                INSERT INTO hyperliquid_runtime_signals (
                  id,
                  network,
                  market_id,
                  coin,
                  generated_at,
                  action,
                  strength,
                  reason,
                  parameter_version,
                  feature_event_ts,
                  features
                )
                VALUES (
                  :id,
                  :network,
                  :market_id,
                  :coin,
                  :generated_at,
                  :action,
                  :strength,
                  :reason,
                  :parameter_version,
                  :feature_event_ts,
                  CAST(:features AS jsonb)
                )
                """
            ),
            {
                "id": signal_id,
                "network": "testnet",
                "market_id": signal.market_id,
                "coin": signal.coin,
                "generated_at": signal.generated_at,
                "action": signal.action,
                "strength": str(signal.strength),
                "reason": signal.reason,
                "parameter_version": signal.parameter_version,
                "feature_event_ts": signal.feature.event_ts,
                "features": json.dumps(_feature_payload(signal), sort_keys=True),
            },
        )
        return signal_id

    def insert_decision(self, decision: DecisionRecord) -> str:
        decision_id = str(uuid.uuid4())
        self._session.execute(
            text(
                """
                INSERT INTO hyperliquid_runtime_decisions (
                  id,
                  signal_id,
                  network,
                  market_id,
                  coin,
                  decided_at,
                  action,
                  status,
                  reason,
                  order_notional_usd,
                  decision_hash
                )
                VALUES (
                  :id,
                  :signal_id,
                  :network,
                  :market_id,
                  :coin,
                  :decided_at,
                  :action,
                  :status,
                  :reason,
                  :order_notional_usd,
                  :decision_hash
                )
                """
            ),
            {
                "id": decision_id,
                "signal_id": decision.signal_id,
                "network": "testnet",
                "market_id": decision.signal.market_id,
                "coin": decision.signal.coin,
                "decided_at": datetime.now(timezone.utc),
                "action": decision.signal.action,
                "status": decision.status,
                "reason": decision.reason,
                "order_notional_usd": str(decision.order_notional_usd),
                "decision_hash": _decision_hash(
                    decision.signal_id, decision.status, decision.reason
                ),
            },
        )
        return decision_id

    def insert_order(
        self,
        intent: OrderIntent,
        result: OrderResult,
    ) -> str:
        order_id = str(uuid.uuid4())
        self._session.execute(
            text(
                """
                INSERT INTO hyperliquid_runtime_orders (
                  id,
                  decision_id,
                  network,
                  market_id,
                  coin,
                  cloid,
                  exchange_order_id,
                  side,
                  size,
                  limit_price,
                  notional_usd,
                  reduce_only,
                  status,
                  rejection_reason,
                  submitted_at,
                  raw_response
                )
                VALUES (
                  :id,
                  :decision_id,
                  :network,
                  :market_id,
                  :coin,
                  :cloid,
                  :exchange_order_id,
                  :side,
                  :size,
                  :limit_price,
                  :notional_usd,
                  :reduce_only,
                  :status,
                  :rejection_reason,
                  :submitted_at,
                  CAST(:raw_response AS jsonb)
                )
                ON CONFLICT (network, cloid) DO UPDATE SET
                  exchange_order_id = EXCLUDED.exchange_order_id,
                  status = EXCLUDED.status,
                  rejection_reason = EXCLUDED.rejection_reason,
                  raw_response = EXCLUDED.raw_response,
                  updated_at = now()
                """
            ),
            {
                "id": order_id,
                "decision_id": intent.decision_id,
                "network": "testnet",
                "market_id": intent.market_id,
                "coin": intent.coin,
                "cloid": intent.cloid,
                "exchange_order_id": result.exchange_order_id,
                "side": intent.side,
                "size": str(intent.size),
                "limit_price": str(intent.limit_price),
                "notional_usd": str(intent.notional_usd),
                "reduce_only": intent.reduce_only,
                "status": result.status,
                "rejection_reason": result.rejection_reason,
                "submitted_at": datetime.now(timezone.utc),
                "raw_response": json.dumps(result.raw_response, sort_keys=True),
            },
        )
        return order_id

    def upsert_fills(self, fills: Iterable[Fill]) -> int:
        count = 0
        for fill in fills:
            self._session.execute(
                text(
                    """
                    INSERT INTO hyperliquid_runtime_fills (
                      network,
                      market_id,
                      coin,
                      side,
                      price,
                      size,
                      notional_usd,
                      fee_usd,
                      closed_pnl_usd,
                      exchange_order_id,
                      fill_hash,
                      event_ts,
                      raw_payload
                    )
                    VALUES (
                      :network,
                      :market_id,
                      :coin,
                      :side,
                      :price,
                      :size,
                      :notional_usd,
                      :fee_usd,
                      :closed_pnl_usd,
                      :exchange_order_id,
                      :fill_hash,
                      :event_ts,
                      CAST(:raw_payload AS jsonb)
                    )
                    ON CONFLICT (network, fill_hash) DO NOTHING
                    """
                ),
                {
                    "network": "testnet",
                    "market_id": fill.market_id,
                    "coin": fill.coin,
                    "side": fill.side,
                    "price": str(fill.price),
                    "size": str(fill.size),
                    "notional_usd": str(fill.notional_usd),
                    "fee_usd": str(fill.fee_usd),
                    "closed_pnl_usd": str(fill.closed_pnl_usd),
                    "exchange_order_id": fill.exchange_order_id,
                    "fill_hash": fill.fill_hash,
                    "event_ts": fill.event_ts,
                    "raw_payload": json.dumps(fill.raw_payload, sort_keys=True),
                },
            )
            count += 1
        return count

    def insert_performance_snapshot(self, snapshot: PerformanceSnapshot) -> None:
        self._session.execute(
            text(
                """
                INSERT INTO hyperliquid_runtime_performance_snapshots (
                  observed_at,
                  network,
                  gross_exposure_usd,
                  realized_pnl_usd,
                  unrealized_pnl_usd,
                  fees_usd,
                  trade_count,
                  reconciliation_status
                )
                VALUES (
                  :observed_at,
                  :network,
                  :gross_exposure_usd,
                  :realized_pnl_usd,
                  :unrealized_pnl_usd,
                  :fees_usd,
                  :trade_count,
                  :reconciliation_status
                )
                """
            ),
            {
                "observed_at": snapshot.observed_at,
                "network": "testnet",
                "gross_exposure_usd": str(snapshot.gross_exposure_usd),
                "realized_pnl_usd": str(snapshot.realized_pnl_usd),
                "unrealized_pnl_usd": str(snapshot.unrealized_pnl_usd),
                "fees_usd": str(snapshot.fees_usd),
                "trade_count": snapshot.trade_count,
                "reconciliation_status": snapshot.reconciliation_status,
            },
        )

    def risk_state(
        self,
        *,
        dependencies: Iterable[RuntimeDependencyStatus],
    ) -> RiskState:
        row = (
            self._session.execute(
                text(
                    """
                SELECT
                  COALESCE((SELECT SUM(ABS(notional_usd)) FROM hyperliquid_runtime_positions WHERE network = 'testnet'), 0)
                    AS gross_exposure_usd,
                  COALESCE((
                    SELECT SUM(closed_pnl_usd - fee_usd)
                    FROM hyperliquid_runtime_fills
                    WHERE network = 'testnet'
                      AND event_ts >= date_trunc('day', now())
                  ), 0) AS daily_realized_pnl_usd
                """
                )
            )
            .mappings()
            .one()
        )
        open_rows = self._session.execute(
            text(
                """
                SELECT DISTINCT market_id
                FROM hyperliquid_runtime_orders
                WHERE network = 'testnet'
                  AND status IN ('accepted', 'submitted')
                """
            )
        ).mappings()
        return RiskState(
            gross_exposure_usd=Decimal(str(row["gross_exposure_usd"])),
            daily_realized_pnl_usd=Decimal(str(row["daily_realized_pnl_usd"])),
            open_order_markets=frozenset(
                str(open_row["market_id"]) for open_row in open_rows
            ),
            dependencies=tuple(dependencies),
        )


def _feature_payload(signal: Signal) -> dict[str, str | int]:
    feature = signal.feature
    return {
        "event_ts": feature.event_ts.isoformat(),
        "price": str(feature.price),
        "momentum_1m_bps": str(feature.momentum_1m_bps),
        "momentum_3m_bps": str(feature.momentum_3m_bps),
        "momentum_5m_bps": str(feature.momentum_5m_bps),
        "momentum_15m_bps": str(feature.momentum_15m_bps),
        "momentum_1h_bps": str(feature.momentum_1h_bps),
        "volatility_bps": str(feature.volatility_bps),
        "vwap_distance_bps": str(feature.vwap_distance_bps),
        "spread_bps": str(feature.spread_bps),
        "book_imbalance": str(feature.book_imbalance),
        "liquidity_usd": str(feature.liquidity_usd),
        "funding_rate": str(feature.funding_rate),
        "open_interest_usd": str(feature.open_interest_usd),
        "regime": feature.regime,
        "source_lag_seconds": feature.source_lag_seconds,
    }


def _decision_hash(
    signal_id: str,
    status: str,
    reason: str,
) -> str:
    import hashlib

    return hashlib.sha256(
        f"{signal_id}\0{status}\0{reason}".encode("utf-8")
    ).hexdigest()


def _decimal_or_none(value: Decimal | None) -> str | None:
    if value is None:
        return None
    return str(value)
