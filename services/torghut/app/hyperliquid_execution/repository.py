"""Postgres repository for Hyperliquid execution v2."""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Iterable, Mapping, cast

from sqlalchemy import text

from .config import HyperliquidExecutionConfig
from .models import (
    AccountState,
    CycleRecord,
    ExecutionMarket,
    Fill,
    OpenOrder,
    OrderIntent,
    OrderResult,
    RiskState,
    RuntimeDependencyStatus,
    Signal,
)


class HyperliquidExecutionRepository:
    """Persistence facade for v2 execution tables."""

    def __init__(self, session: Any) -> None:
        self._session = session

    def upsert_markets(self, markets: Iterable[ExecutionMarket]) -> None:
        for market in markets:
            self._session.execute(
                text(
                    """
                    INSERT INTO hyperliquid_execution_symbol_state (
                      coin,
                      market_id,
                      dex,
                      active,
                      last_metadata,
                      updated_at
                    )
                    VALUES (
                      :coin,
                      :market_id,
                      :dex,
                      true,
                      CAST(:metadata AS jsonb),
                      now()
                    )
                    ON CONFLICT (coin) DO UPDATE SET
                      market_id = EXCLUDED.market_id,
                      dex = EXCLUDED.dex,
                      active = true,
                      last_metadata = EXCLUDED.last_metadata,
                      updated_at = now()
                    """
                ),
                {
                    "coin": market.coin,
                    "market_id": market.market_id,
                    "dex": market.dex,
                    "metadata": json.dumps(market.payload, sort_keys=True),
                },
            )

    def insert_signal(self, *, cycle_id: str, signal: Signal) -> str:
        signal_id = str(uuid.uuid4())
        self._session.execute(
            text(
                """
                INSERT INTO hyperliquid_execution_signals (
                  id,
                  cycle_id,
                  market_data_network,
                  execution_network,
                  market_id,
                  coin,
                  generated_at,
                  action,
                  edge_bps,
                  reason,
                  feature_event_ts,
                  features
                )
                VALUES (
                  :id,
                  :cycle_id,
                  'mainnet',
                  'testnet',
                  :market_id,
                  :coin,
                  :generated_at,
                  :action,
                  :edge_bps,
                  :reason,
                  :feature_event_ts,
                  CAST(:features AS jsonb)
                )
                """
            ),
            {
                "id": signal_id,
                "cycle_id": cycle_id,
                "market_id": signal.market_id,
                "coin": signal.coin,
                "generated_at": signal.generated_at,
                "action": signal.action,
                "edge_bps": str(signal.edge_bps),
                "reason": signal.reason,
                "feature_event_ts": signal.feature.event_ts,
                "features": json.dumps(signal.feature.raw_features, sort_keys=True),
            },
        )
        return signal_id

    def insert_order(self, intent: OrderIntent, result: OrderResult) -> str:
        order_id = str(uuid.uuid4())
        self._session.execute(
            text(
                """
                INSERT INTO hyperliquid_execution_orders (
                  id,
                  signal_id,
                  execution_network,
                  market_id,
                  coin,
                  cloid,
                  exchange_order_id,
                  side,
                  size,
                  limit_price,
                  notional_usd,
                  reduce_only,
                  tif,
                  status,
                  rejection_reason,
                  submitted_at,
                  expires_at,
                  raw_response
                )
                VALUES (
                  :id,
                  :signal_id,
                  'testnet',
                  :market_id,
                  :coin,
                  :cloid,
                  :exchange_order_id,
                  :side,
                  :size,
                  :limit_price,
                  :notional_usd,
                  :reduce_only,
                  :tif,
                  :status,
                  :rejection_reason,
                  :submitted_at,
                  :expires_at,
                  CAST(:raw_response AS jsonb)
                )
                ON CONFLICT (execution_network, cloid) DO UPDATE SET
                  exchange_order_id = EXCLUDED.exchange_order_id,
                  status = EXCLUDED.status,
                  rejection_reason = EXCLUDED.rejection_reason,
                  raw_response = EXCLUDED.raw_response,
                  updated_at = now()
                """
            ),
            {
                "id": order_id,
                "signal_id": intent.signal_id,
                "market_id": intent.market_id,
                "coin": intent.coin,
                "cloid": intent.cloid,
                "exchange_order_id": result.exchange_order_id,
                "side": intent.side,
                "size": str(intent.size),
                "limit_price": str(intent.limit_price),
                "notional_usd": str(intent.notional_usd),
                "reduce_only": intent.reduce_only,
                "tif": intent.tif,
                "status": result.status,
                "rejection_reason": result.rejection_reason,
                "submitted_at": datetime.now(timezone.utc),
                "expires_at": intent.expires_at,
                "raw_response": json.dumps(result.raw_response, sort_keys=True),
            },
        )
        return order_id

    def update_reject_cooldown(
        self,
        *,
        coin: str,
        rejection_reason: str | None,
        config: HyperliquidExecutionConfig,
    ) -> None:
        if not rejection_reason:
            return
        normalized = rejection_reason.lower()
        halted = "trading is halted" in normalized
        immediate = (
            "could not immediately match" in normalized
            or "immediately match" in normalized
            or "alo" in normalized
        )
        if halted:
            self._set_cooldown(
                coin=coin,
                reason="trading_halted_until_metadata_refresh",
                seconds=config.exchange_staleness_seconds,
            )
            return
        if not immediate:
            return
        row = (
            self._session.execute(
                text(
                    """
                    SELECT count(*) AS rejects
                    FROM hyperliquid_execution_orders
                    WHERE execution_network = 'testnet'
                      AND coin = :coin
                      AND status = 'rejected'
                      AND (
                        rejection_reason ILIKE '%could not immediately match%'
                        OR rejection_reason ILIKE '%immediately match%'
                        OR rejection_reason ILIKE '%ALO%'
                      )
                      AND created_at >= now() - (:window_seconds * interval '1 second')
                    """
                ),
                {
                    "coin": coin,
                    "window_seconds": config.reject_cooldown_window_seconds,
                },
            )
            .mappings()
            .one()
        )
        if int(row["rejects"]) >= config.reject_cooldown_threshold:
            self._set_cooldown(
                coin=coin,
                reason="symbol_reject_cooldown",
                seconds=config.reject_cooldown_seconds,
            )

    def expired_open_orders(self, *, now: datetime) -> list[OpenOrder]:
        rows = self._session.execute(
            text(
                """
                SELECT
                  id,
                  coin,
                  dex,
                  exchange_order_id,
                  cloid,
                  status,
                  expires_at
                FROM hyperliquid_execution_orders
                JOIN hyperliquid_execution_symbol_state USING (coin)
                WHERE execution_network = 'testnet'
                  AND status IN ('accepted', 'submitted')
                  AND expires_at <= :now
                ORDER BY expires_at ASC
                LIMIT 100
                """
            ),
            {"now": now},
        ).mappings()
        return [
            OpenOrder(
                order_id=str(row["id"]),
                coin=str(row["coin"]),
                dex=str(row["dex"]),
                exchange_order_id=_optional_text(row["exchange_order_id"]),
                cloid=str(row["cloid"]),
                status=str(row["status"]),
                expires_at=cast(datetime, row["expires_at"]),
            )
            for row in rows
        ]

    def mark_order_cancelled(self, order: OpenOrder, result: OrderResult) -> None:
        self._session.execute(
            text(
                """
                UPDATE hyperliquid_execution_orders
                SET
                  status = 'cancelled',
                  rejection_reason = :reason,
                  raw_response = raw_response || CAST(:raw_response AS jsonb),
                  updated_at = now()
                WHERE id = :id
                """
            ),
            {
                "id": order.order_id,
                "reason": result.rejection_reason,
                "raw_response": json.dumps(
                    {"cancel": result.raw_response}, sort_keys=True
                ),
            },
        )

    def upsert_fills(self, fills: Iterable[Fill]) -> int:
        count = 0
        for fill in fills:
            self._session.execute(
                text(
                    """
                    INSERT INTO hyperliquid_execution_fills (
                      execution_network,
                      fill_hash,
                      order_id,
                      market_id,
                      coin,
                      side,
                      price,
                      size,
                      notional_usd,
                      fee_usd,
                      closed_pnl_usd,
                      exchange_order_id,
                      event_ts,
                      raw_payload
                    )
                    VALUES (
                      'testnet',
                      :fill_hash,
                      (
                        SELECT id
                        FROM hyperliquid_execution_orders
                        WHERE execution_network = 'testnet'
                          AND exchange_order_id = :exchange_order_id
                        ORDER BY created_at DESC
                        LIMIT 1
                      ),
                      :market_id,
                      :coin,
                      :side,
                      :price,
                      :size,
                      :notional_usd,
                      :fee_usd,
                      :closed_pnl_usd,
                      :exchange_order_id,
                      :event_ts,
                      CAST(:raw_payload AS jsonb)
                    )
                    ON CONFLICT (execution_network, fill_hash) DO NOTHING
                    """
                ),
                {
                    "fill_hash": fill.fill_hash,
                    "market_id": fill.market_id,
                    "coin": fill.coin,
                    "side": fill.side,
                    "price": str(fill.price),
                    "size": str(fill.size),
                    "notional_usd": str(fill.notional_usd),
                    "fee_usd": str(fill.fee_usd),
                    "closed_pnl_usd": str(fill.closed_pnl_usd),
                    "exchange_order_id": fill.exchange_order_id,
                    "event_ts": fill.event_ts,
                    "raw_payload": json.dumps(fill.raw_payload, sort_keys=True),
                },
            )
            if fill.exchange_order_id:
                self._session.execute(
                    text(
                        """
                        UPDATE hyperliquid_execution_orders
                        SET status = 'filled', updated_at = now()
                        WHERE execution_network = 'testnet'
                          AND exchange_order_id = :exchange_order_id
                          AND status IN ('accepted', 'submitted')
                        """
                    ),
                    {"exchange_order_id": fill.exchange_order_id},
                )
            count += 1
        return count

    def upsert_account_state(self, state: AccountState) -> None:
        self._session.execute(
            text(
                """
                INSERT INTO hyperliquid_execution_account_snapshots (
                  id,
                  execution_network,
                  observed_at,
                  account_value_usd,
                  withdrawable_usd,
                  gross_exposure_usd,
                  raw_payload
                )
                VALUES (
                  :id,
                  'testnet',
                  :observed_at,
                  :account_value_usd,
                  :withdrawable_usd,
                  :gross_exposure_usd,
                  CAST(:raw_payload AS jsonb)
                )
                """
            ),
            {
                "id": str(uuid.uuid4()),
                "observed_at": state.account.observed_at,
                "account_value_usd": str(state.account.account_value_usd),
                "withdrawable_usd": str(state.account.withdrawable_usd),
                "gross_exposure_usd": str(state.account.gross_exposure_usd),
                "raw_payload": json.dumps(state.account.raw_payload, sort_keys=True),
            },
        )
        self._session.execute(
            text(
                "DELETE FROM hyperliquid_execution_positions WHERE execution_network = 'testnet'"
            )
        )
        for position in state.positions:
            self._session.execute(
                text(
                    """
                    INSERT INTO hyperliquid_execution_positions (
                      execution_network,
                      market_id,
                      coin,
                      size,
                      entry_price,
                      notional_usd,
                      unrealized_pnl_usd,
                      observed_at,
                      raw_payload
                    )
                    VALUES (
                      'testnet',
                      :market_id,
                      :coin,
                      :size,
                      :entry_price,
                      :notional_usd,
                      :unrealized_pnl_usd,
                      :observed_at,
                      CAST(:raw_payload AS jsonb)
                    )
                    """
                ),
                {
                    "market_id": position.market_id,
                    "coin": position.coin,
                    "size": str(position.size),
                    "entry_price": _decimal_or_none(position.entry_price),
                    "notional_usd": str(position.notional_usd),
                    "unrealized_pnl_usd": str(position.unrealized_pnl_usd),
                    "observed_at": position.observed_at,
                    "raw_payload": json.dumps(position.raw_payload, sort_keys=True),
                },
            )

    def risk_state(
        self,
        *,
        trading_enabled: bool,
        dependencies: tuple[RuntimeDependencyStatus, ...],
    ) -> RiskState:
        account_row = (
            self._session.execute(
                text(
                    """
                    SELECT
                      COALESCE((
                        SELECT gross_exposure_usd
                        FROM hyperliquid_execution_account_snapshots
                        WHERE execution_network = 'testnet'
                        ORDER BY observed_at DESC
                        LIMIT 1
                      ), 0) AS gross_exposure_usd,
                      COALESCE((
                        SELECT SUM(closed_pnl_usd - fee_usd)
                        FROM hyperliquid_execution_fills
                        WHERE execution_network = 'testnet'
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
                SELECT DISTINCT coin
                FROM hyperliquid_execution_orders
                WHERE execution_network = 'testnet'
                  AND status IN ('accepted', 'submitted')
                """
            )
        ).mappings()
        exposure_rows = self._session.execute(
            text(
                """
                SELECT coin, SUM(exposure_usd) AS exposure_usd
                FROM (
                  SELECT coin, ABS(notional_usd) AS exposure_usd
                  FROM hyperliquid_execution_positions
                  WHERE execution_network = 'testnet'
                  UNION ALL
                  SELECT coin, ABS(notional_usd) AS exposure_usd
                  FROM hyperliquid_execution_orders
                  WHERE execution_network = 'testnet'
                    AND status IN ('accepted', 'submitted')
                ) exposures
                GROUP BY coin
                """
            )
        ).mappings()
        cooldown_rows = self._session.execute(
            text(
                """
                SELECT coin, cooldown_reason
                FROM hyperliquid_execution_symbol_state
                WHERE cooldown_until IS NOT NULL
                  AND cooldown_until > now()
                """
            )
        ).mappings()
        return RiskState(
            trading_enabled=trading_enabled,
            dependencies=dependencies,
            gross_exposure_usd=Decimal(str(account_row["gross_exposure_usd"])),
            daily_realized_pnl_usd=Decimal(str(account_row["daily_realized_pnl_usd"])),
            open_order_coins=frozenset(str(row["coin"]) for row in open_rows),
            symbol_exposure_usd_by_coin={
                str(row["coin"]): Decimal(str(row["exposure_usd"]))
                for row in exposure_rows
            },
            cooldown_reason_by_coin={
                str(row["coin"]): str(row["cooldown_reason"]) for row in cooldown_rows
            },
        )

    def insert_performance_snapshot(self, *, observed_at: datetime) -> None:
        metrics = self._performance_metrics()
        self._session.execute(
            text(
                """
                INSERT INTO hyperliquid_execution_performance_snapshots (
                  id,
                  execution_network,
                  observed_at,
                  fill_count_24h,
                  notional_usd_24h,
                  fees_usd_24h,
                  net_pnl_after_fees_usd_24h,
                  max_drawdown_usd_24h,
                  fill_count_7d,
                  notional_usd_7d,
                  fees_usd_7d,
                  net_pnl_after_fees_usd_7d,
                  max_drawdown_usd_7d,
                  maker_fill_rate_24h,
                  cancel_rate_24h,
                  reject_rate_24h,
                  sample_ready,
                  symbol_pnl
                )
                VALUES (
                  :id,
                  'testnet',
                  :observed_at,
                  :fill_count_24h,
                  :notional_usd_24h,
                  :fees_usd_24h,
                  :net_pnl_after_fees_usd_24h,
                  :max_drawdown_usd_24h,
                  :fill_count_7d,
                  :notional_usd_7d,
                  :fees_usd_7d,
                  :net_pnl_after_fees_usd_7d,
                  :max_drawdown_usd_7d,
                  :maker_fill_rate_24h,
                  :cancel_rate_24h,
                  :reject_rate_24h,
                  :sample_ready,
                  CAST(:symbol_pnl AS jsonb)
                )
                """
            ),
            {"id": str(uuid.uuid4()), "observed_at": observed_at, **metrics},
        )

    def insert_cycle(self, record: CycleRecord) -> None:
        self._session.execute(
            text(
                """
                INSERT INTO hyperliquid_execution_cycles (
                  id,
                  started_at,
                  finished_at,
                  trading_enabled,
                  selected_coins,
                  signals_written,
                  orders_submitted,
                  orders_cancelled,
                  dependency_statuses,
                  universe_details,
                  error
                )
                VALUES (
                  :id,
                  :started_at,
                  :finished_at,
                  :trading_enabled,
                  CAST(:selected_coins AS jsonb),
                  :signals_written,
                  :orders_submitted,
                  :orders_cancelled,
                  CAST(:dependency_statuses AS jsonb),
                  CAST(:universe_details AS jsonb),
                  :error
                )
                ON CONFLICT (id) DO UPDATE SET
                  finished_at = EXCLUDED.finished_at,
                  trading_enabled = EXCLUDED.trading_enabled,
                  selected_coins = EXCLUDED.selected_coins,
                  signals_written = EXCLUDED.signals_written,
                  orders_submitted = EXCLUDED.orders_submitted,
                  orders_cancelled = EXCLUDED.orders_cancelled,
                  dependency_statuses = EXCLUDED.dependency_statuses,
                  universe_details = EXCLUDED.universe_details,
                  error = EXCLUDED.error
                """
            ),
            {
                "id": record.cycle_id,
                "started_at": record.started_at,
                "finished_at": record.finished_at,
                "trading_enabled": record.trading_enabled,
                "selected_coins": json.dumps(list(record.selected_coins)),
                "signals_written": record.signals_written,
                "orders_submitted": record.orders_submitted,
                "orders_cancelled": record.orders_cancelled,
                "dependency_statuses": json.dumps(
                    [
                        _dependency_payload(dependency)
                        for dependency in record.dependency_statuses
                    ],
                    sort_keys=True,
                ),
                "universe_details": json.dumps(
                    dict(record.universe_details), sort_keys=True
                ),
                "error": record.error,
            },
        )

    def operational_report(
        self,
        *,
        runtime_payload: Mapping[str, object],
        config_payload: Mapping[str, object],
    ) -> dict[str, object]:
        """Return a compact operator report from v2 evidence only."""

        return {
            "schema_version": "torghut.hyperliquid-execution-report.v2",
            "runtime": dict(runtime_payload),
            "config": dict(config_payload),
            "account": self._query_rows(
                """
                SELECT
                  observed_at::text,
                  account_value_usd::text,
                  withdrawable_usd::text,
                  gross_exposure_usd::text,
                  raw_payload
                FROM hyperliquid_execution_account_snapshots
                WHERE execution_network = 'testnet'
                ORDER BY observed_at DESC
                LIMIT 1
                """
            ),
            "positions": self._query_rows(
                """
                SELECT
                  observed_at::text,
                  coin,
                  size::text,
                  entry_price::text,
                  notional_usd::text,
                  unrealized_pnl_usd::text
                FROM hyperliquid_execution_positions
                WHERE execution_network = 'testnet'
                ORDER BY coin
                LIMIT 100
                """
            ),
            "external_account_positions": self._query_rows(
                """
                SELECT
                  observed_at::text,
                  coin,
                  size::text,
                  entry_price::text,
                  notional_usd::text,
                  unrealized_pnl_usd::text
                FROM hyperliquid_execution_positions
                WHERE execution_network = 'testnet'
                ORDER BY coin
                LIMIT 100
                """
            ),
            "open_orders": self._query_rows(
                """
                SELECT
                  created_at::text,
                  coin,
                  side,
                  status,
                  exchange_order_id,
                  limit_price::text,
                  size::text,
                  notional_usd::text,
                  expires_at::text
                FROM hyperliquid_execution_orders
                WHERE execution_network = 'testnet'
                  AND status IN ('accepted', 'submitted')
                ORDER BY created_at DESC
                LIMIT 100
                """
            ),
            "fills_by_coin": self._query_rows(
                """
                SELECT
                  coin,
                  side,
                  count(*)::int AS fills,
                  COALESCE(sum(notional_usd), 0)::text AS notional_usd,
                  COALESCE(sum(fee_usd), 0)::text AS fees_usd,
                  COALESCE(sum(closed_pnl_usd - fee_usd), 0)::text AS net_pnl_after_fees_usd
                FROM hyperliquid_execution_fills
                WHERE execution_network = 'testnet'
                GROUP BY coin, side
                ORDER BY coin, side
                """
            ),
            "rejects_by_coin_reason": self._query_rows(
                """
                SELECT
                  coin,
                  COALESCE(rejection_reason, '') AS reason,
                  count(*)::int AS rejects,
                  max(created_at)::text AS latest_at
                FROM hyperliquid_execution_orders
                WHERE execution_network = 'testnet'
                  AND status = 'rejected'
                GROUP BY coin, COALESCE(rejection_reason, '')
                ORDER BY latest_at DESC
                LIMIT 100
                """
            ),
            "cooldowns": self._query_rows(
                """
                SELECT
                  coin,
                  cooldown_reason,
                  cooldown_until::text,
                  updated_at::text
                FROM hyperliquid_execution_symbol_state
                WHERE cooldown_until IS NOT NULL
                  AND cooldown_until > now()
                ORDER BY cooldown_until DESC
                """
            ),
            "performance": self._query_rows(
                """
                SELECT
                  observed_at::text,
                  fill_count_24h,
                  notional_usd_24h::text,
                  fees_usd_24h::text,
                  net_pnl_after_fees_usd_24h::text,
                  max_drawdown_usd_24h::text,
                  fill_count_7d,
                  notional_usd_7d::text,
                  fees_usd_7d::text,
                  net_pnl_after_fees_usd_7d::text,
                  max_drawdown_usd_7d::text,
                  maker_fill_rate_24h::text,
                  cancel_rate_24h::text,
                  reject_rate_24h::text,
                  sample_ready,
                  symbol_pnl
                FROM hyperliquid_execution_performance_snapshots
                WHERE execution_network = 'testnet'
                ORDER BY observed_at DESC
                LIMIT 1
                """
            ),
        }

    def _set_cooldown(self, *, coin: str, reason: str, seconds: int) -> None:
        self._session.execute(
            text(
                """
                INSERT INTO hyperliquid_execution_symbol_state (
                  coin,
                  active,
                  cooldown_reason,
                  cooldown_until,
                  updated_at
                )
                VALUES (
                  :coin,
                  true,
                  :reason,
                  now() + (:seconds * interval '1 second'),
                  now()
                )
                ON CONFLICT (coin) DO UPDATE SET
                  cooldown_reason = EXCLUDED.cooldown_reason,
                  cooldown_until = EXCLUDED.cooldown_until,
                  updated_at = now()
                """
            ),
            {"coin": coin, "reason": reason, "seconds": seconds},
        )

    def _performance_metrics(self) -> dict[str, object]:
        summary = (
            self._session.execute(
                text(
                    """
                    WITH
                    fills_24h AS (
                      SELECT
                        count(*) AS fills,
                        COALESCE(sum(notional_usd), 0) AS notional,
                        COALESCE(sum(fee_usd), 0) AS fees,
                        COALESCE(sum(closed_pnl_usd - fee_usd), 0) AS net_pnl
                      FROM hyperliquid_execution_fills
                      WHERE execution_network = 'testnet'
                        AND event_ts >= now() - interval '24 hours'
                    ),
                    fills_7d AS (
                      SELECT
                        count(*) AS fills,
                        COALESCE(sum(notional_usd), 0) AS notional,
                        COALESCE(sum(fee_usd), 0) AS fees,
                        COALESCE(sum(closed_pnl_usd - fee_usd), 0) AS net_pnl
                      FROM hyperliquid_execution_fills
                      WHERE execution_network = 'testnet'
                        AND event_ts >= now() - interval '7 days'
                    ),
                    orders_24h AS (
                      SELECT
                        count(*) AS orders,
                        count(*) FILTER (WHERE status = 'filled') AS filled,
                        count(*) FILTER (WHERE status = 'cancelled') AS cancelled,
                        count(*) FILTER (WHERE status = 'rejected') AS rejected
                      FROM hyperliquid_execution_orders
                      WHERE execution_network = 'testnet'
                        AND created_at >= now() - interval '24 hours'
                    ),
                    all_fills AS (
                      SELECT count(*) AS fills
                      FROM hyperliquid_execution_fills
                      WHERE execution_network = 'testnet'
                    )
                    SELECT
                      fills_24h.fills AS fills_24h,
                      fills_24h.notional AS notional_24h,
                      fills_24h.fees AS fees_24h,
                      fills_24h.net_pnl AS net_pnl_24h,
                      fills_7d.fills AS fills_7d,
                      fills_7d.notional AS notional_7d,
                      fills_7d.fees AS fees_7d,
                      fills_7d.net_pnl AS net_pnl_7d,
                      orders_24h.orders AS orders_24h,
                      orders_24h.filled AS filled_orders_24h,
                      orders_24h.cancelled AS cancelled_orders_24h,
                      orders_24h.rejected AS rejected_orders_24h,
                      all_fills.fills AS all_fills
                    FROM fills_24h, fills_7d, orders_24h, all_fills
                    """
                )
            )
            .mappings()
            .one()
        )
        symbol_pnl = self._query_rows(
            """
            SELECT
              coin,
              count(*)::int AS fills,
              COALESCE(sum(notional_usd), 0)::text AS notional_usd,
              COALESCE(sum(fee_usd), 0)::text AS fees_usd,
              COALESCE(sum(closed_pnl_usd - fee_usd), 0)::text AS net_pnl_after_fees_usd
            FROM hyperliquid_execution_fills
            WHERE execution_network = 'testnet'
            GROUP BY coin
            ORDER BY coin
            """
        )
        orders_24h = Decimal(str(summary["orders_24h"]))
        filled = Decimal(str(summary["filled_orders_24h"]))
        cancelled = Decimal(str(summary["cancelled_orders_24h"]))
        rejected = Decimal(str(summary["rejected_orders_24h"]))
        net_24h = Decimal(str(summary["net_pnl_24h"]))
        net_7d = Decimal(str(summary["net_pnl_7d"]))
        return {
            "fill_count_24h": int(summary["fills_24h"]),
            "notional_usd_24h": str(summary["notional_24h"]),
            "fees_usd_24h": str(summary["fees_24h"]),
            "net_pnl_after_fees_usd_24h": str(net_24h),
            "max_drawdown_usd_24h": str(min(net_24h, Decimal("0"))),
            "fill_count_7d": int(summary["fills_7d"]),
            "notional_usd_7d": str(summary["notional_7d"]),
            "fees_usd_7d": str(summary["fees_7d"]),
            "net_pnl_after_fees_usd_7d": str(net_7d),
            "max_drawdown_usd_7d": str(min(net_7d, Decimal("0"))),
            "maker_fill_rate_24h": str(_ratio(filled, orders_24h)),
            "cancel_rate_24h": str(_ratio(cancelled, orders_24h)),
            "reject_rate_24h": str(_ratio(rejected, orders_24h)),
            "sample_ready": int(summary["all_fills"]) >= 40,
            "symbol_pnl": json.dumps(symbol_pnl, sort_keys=True),
        }

    def _query_rows(self, query: str) -> list[dict[str, object]]:
        rows = self._session.execute(text(query)).mappings().all()
        return [
            {
                str(key): _json_safe(value)
                for key, value in cast(Mapping[str, object], row).items()
            }
            for row in rows
        ]


def _dependency_payload(dependency: RuntimeDependencyStatus) -> dict[str, object]:
    return {
        "name": dependency.name,
        "ready": dependency.ready,
        "observed_at": dependency.observed_at.isoformat()
        if dependency.observed_at
        else None,
        "lag_seconds": dependency.lag_seconds,
        "reason": dependency.reason,
        "details": dependency.details,
    }


def _ratio(numerator: Decimal, denominator: Decimal) -> Decimal:
    if denominator <= Decimal("0"):
        return Decimal("0")
    return (numerator / denominator).quantize(Decimal("0.0001"))


def _decimal_or_none(value: Decimal | None) -> str | None:
    return None if value is None else str(value)


def _optional_text(value: object) -> str | None:
    if value is None:
        return None
    text_value = str(value)
    return text_value if text_value else None


def _json_safe(value: object) -> object:
    if isinstance(value, (datetime, Decimal)):
        return str(value)
    return value
