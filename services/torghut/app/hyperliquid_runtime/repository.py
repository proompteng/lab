"""Postgres operational truth for the Hyperliquid runtime lane."""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from decimal import Decimal
from typing import Iterable, Mapping, cast

from sqlalchemy import text

from .models import (
    AccountState,
    DecisionRecord,
    Fill,
    HyperliquidMarket,
    OrderIntent,
    OrderResult,
    OrderSide,
    PerformanceSnapshot,
    RiskState,
    RuntimeDependencyStatus,
    Signal,
)
from .runtime_session import RuntimeSession


class HyperliquidRuntimeRepository:
    """Persistence facade for runtime tables created by migration 0054."""

    def __init__(self, session: RuntimeSession) -> None:
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

    def reconcile_closed_orders(
        self, *, open_order_market_ids: frozenset[str]
    ) -> list[tuple[OrderIntent, OrderResult]]:
        release_orders: list[tuple[OrderIntent, OrderResult]] = []
        rows = self._session.execute(
            text(
                """
                    SELECT
                      o.decision_id,
                      o.network,
                      o.market_id,
                      o.coin,
                      o.cloid,
                      o.exchange_order_id,
                      o.side,
                      o.size,
                      o.limit_price,
                      o.notional_usd,
                      o.reduce_only,
                      EXISTS (
                        SELECT 1
                        FROM hyperliquid_runtime_fills f
                        WHERE f.network = o.network
                          AND f.exchange_order_id IS NOT NULL
                          AND f.exchange_order_id = o.exchange_order_id
                      ) AS has_fill
                    FROM hyperliquid_runtime_orders o
                    WHERE o.network = 'testnet'
                      AND o.status IN ('accepted', 'submitted')
                    """
            )
        ).mappings()
        for row in rows:
            row_map = cast(Mapping[str, object], row)
            market_id = str(row_map["market_id"])
            if market_id in open_order_market_ids:
                continue
            has_fill = bool(row_map["has_fill"])
            reconciled_status = "filled" if has_fill else "cancelled"
            rejection_reason = None
            if not has_fill:
                rejection_reason = "not_open_on_exchange_reconciliation"
            reconciliation_payload: dict[str, object] = {
                "source": "exchange_open_orders",
                "open_on_exchange": False,
                "filled_from_reconciled_fills": has_fill,
            }
            raw_response: dict[str, object] = {"reconciliation": reconciliation_payload}
            self._session.execute(
                text(
                    """
                    UPDATE hyperliquid_runtime_orders
                    SET
                      status = :status,
                      rejection_reason = :rejection_reason,
                      raw_response = raw_response || CAST(:raw_response AS jsonb),
                      updated_at = now()
                    WHERE network = :network
                      AND cloid = :cloid
                      AND status IN ('accepted', 'submitted')
                    """
                ),
                {
                    "network": str(row_map["network"]),
                    "cloid": str(row_map["cloid"]),
                    "status": reconciled_status,
                    "rejection_reason": rejection_reason,
                    "raw_response": json.dumps(raw_response, sort_keys=True),
                },
            )
            if not has_fill:
                intent = _order_intent_from_row(row_map)
                release_orders.append(
                    (
                        intent,
                        OrderResult(
                            status="cancelled",
                            exchange_order_id=_optional_text(
                                row_map["exchange_order_id"]
                            ),
                            raw_response=raw_response,
                            rejection_reason=rejection_reason,
                        ),
                    )
                )
        return release_orders

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

    def upsert_account_state(self, account_state: AccountState) -> None:
        self._session.execute(
            text(
                """
                INSERT INTO hyperliquid_runtime_account_snapshots (
                  id,
                  network,
                  observed_at,
                  account_value_usd,
                  withdrawable_usd,
                  gross_exposure_usd,
                  raw_payload
                )
                VALUES (
                  :id,
                  :network,
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
                "network": "testnet",
                "observed_at": account_state.account.observed_at,
                "account_value_usd": str(account_state.account.account_value_usd),
                "withdrawable_usd": str(account_state.account.withdrawable_usd),
                "gross_exposure_usd": str(account_state.account.gross_exposure_usd),
                "raw_payload": json.dumps(
                    account_state.account.raw_payload, sort_keys=True
                ),
            },
        )
        self._session.execute(
            text("DELETE FROM hyperliquid_runtime_positions WHERE network = 'testnet'")
        )
        for position in account_state.positions:
            self._session.execute(
                text(
                    """
                    INSERT INTO hyperliquid_runtime_positions (
                      network,
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
                      :network,
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
                    "network": "testnet",
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
        trade_coins: Iterable[str] = (),
        excluded_coins: Iterable[str] = (),
        reject_cooldown_threshold: int = 3,
        reject_cooldown_window_seconds: int = 1800,
        reject_cooldown_seconds: int = 900,
        halted_cooldown_seconds: int = 300,
    ) -> RiskState:
        row = (
            self._session.execute(
                text(
                    """
                SELECT
                  COALESCE((
                    SELECT gross_exposure_usd
                    FROM hyperliquid_runtime_account_snapshots
                    WHERE network = 'testnet'
                    ORDER BY observed_at DESC
                    LIMIT 1
                  ), 0)
                    AS gross_exposure_usd,
                  COALESCE((
                    SELECT SUM(unrealized_pnl_usd)
                    FROM hyperliquid_runtime_positions
                    WHERE network = 'testnet'
                  ), 0)
                    AS unrealized_pnl_usd,
                  COALESCE((
                    SELECT SUM(closed_pnl_usd - fee_usd)
                    FROM hyperliquid_runtime_fills
                    WHERE network = 'testnet'
                      AND event_ts >= date_trunc('day', now())
                  ), 0) AS daily_realized_pnl_usd,
                  COALESCE((
                    SELECT SUM(fee_usd)
                    FROM hyperliquid_runtime_fills
                    WHERE network = 'testnet'
                      AND event_ts >= date_trunc('day', now())
                  ), 0) AS daily_fees_usd
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
        symbol_exposure_rows = self._session.execute(
            text(
                """
                SELECT coin, SUM(notional_usd) AS exposure_usd
                FROM (
                  SELECT coin, ABS(notional_usd) AS notional_usd
                  FROM hyperliquid_runtime_positions
                  WHERE network = 'testnet'
                  UNION ALL
                  SELECT coin, ABS(notional_usd) AS notional_usd
                  FROM hyperliquid_runtime_orders
                  WHERE network = 'testnet'
                    AND status IN ('accepted', 'submitted')
                ) exposures
                GROUP BY coin
                """
            )
        ).mappings()
        reject_cooldown_rows = self._session.execute(
            text(
                """
                SELECT coin
                FROM hyperliquid_runtime_orders
                WHERE network = 'testnet'
                  AND status = 'rejected'
                  AND rejection_reason ILIKE '%could not immediately match%'
                  AND created_at >= now() - (:window_seconds * interval '1 second')
                GROUP BY coin
                HAVING count(*) >= :threshold
                  AND max(created_at) >= now()
                    - (:cooldown_seconds * interval '1 second')
                """
            ),
            {
                "window_seconds": reject_cooldown_window_seconds,
                "cooldown_seconds": reject_cooldown_seconds,
                "threshold": reject_cooldown_threshold,
            },
        ).mappings()
        halted_rows = self._session.execute(
            text(
                """
                SELECT DISTINCT coin
                FROM hyperliquid_runtime_orders
                WHERE network = 'testnet'
                  AND status = 'rejected'
                  AND rejection_reason = 'Trading is halted.'
                  AND created_at >= now() - (:cooldown_seconds * interval '1 second')
                """
            ),
            {"cooldown_seconds": halted_cooldown_seconds},
        ).mappings()
        symbol_exposure_usd_by_coin = {
            str(exposure_row["coin"]): Decimal(str(exposure_row["exposure_usd"]))
            for exposure_row in symbol_exposure_rows
        }
        account_gross_exposure_usd = Decimal(str(row["gross_exposure_usd"]))
        collection_gross_exposure_usd = _collection_gross_exposure_usd(
            account_gross_exposure_usd=account_gross_exposure_usd,
            symbol_exposure_usd_by_coin=symbol_exposure_usd_by_coin,
            trade_coins=trade_coins,
            excluded_coins=excluded_coins,
        )
        return RiskState(
            gross_exposure_usd=account_gross_exposure_usd,
            daily_realized_pnl_usd=Decimal(str(row["daily_realized_pnl_usd"])),
            unrealized_pnl_usd=Decimal(str(row["unrealized_pnl_usd"])),
            daily_fees_usd=Decimal(str(row["daily_fees_usd"])),
            open_order_markets=frozenset(
                str(open_row["market_id"]) for open_row in open_rows
            ),
            dependencies=tuple(dependencies),
            symbol_exposure_usd_by_coin=symbol_exposure_usd_by_coin,
            collection_gross_exposure_usd=collection_gross_exposure_usd,
            reject_cooldown_coins=frozenset(
                str(cooldown_row["coin"]) for cooldown_row in reject_cooldown_rows
            ),
            halted_coins=frozenset(
                str(halted_row["coin"]) for halted_row in halted_rows
            ),
        )

    def operational_report(
        self,
        *,
        config_payload: Mapping[str, object],
    ) -> dict[str, object]:
        """Return a compact operator report from existing runtime evidence."""

        return {
            "schema_version": "torghut.hyperliquid-runtime-report.v1",
            "config": dict(config_payload),
            "account": self._query_report_rows(
                """
                SELECT
                  observed_at::text,
                  account_value_usd::text,
                  withdrawable_usd::text,
                  gross_exposure_usd::text,
                  raw_payload
                FROM hyperliquid_runtime_account_snapshots
                WHERE network = 'testnet'
                ORDER BY observed_at DESC
                LIMIT 1
                """
            ),
            "positions": self._query_report_rows(
                """
                SELECT
                  observed_at::text,
                  coin,
                  size::text,
                  entry_price::text,
                  notional_usd::text,
                  unrealized_pnl_usd::text
                FROM hyperliquid_runtime_positions
                WHERE network = 'testnet'
                ORDER BY observed_at DESC, coin
                LIMIT 50
                """
            ),
            "fills_by_coin": self._query_report_rows(
                """
                SELECT
                  coin,
                  side,
                  count(*)::int AS fills,
                  COALESCE(sum(notional_usd), 0)::text AS notional_usd,
                  COALESCE(sum(fee_usd), 0)::text AS fees_usd,
                  COALESCE(sum(closed_pnl_usd - fee_usd), 0)::text
                    AS net_pnl_after_fees_usd,
                  max(event_ts)::text AS latest_fill_at
                FROM hyperliquid_runtime_fills
                WHERE network = 'testnet'
                GROUP BY coin, side
                ORDER BY max(event_ts) DESC NULLS LAST
                LIMIT 100
                """
            ),
            "rejects_by_coin_reason": self._query_report_rows(
                """
                SELECT
                  coin,
                  rejection_reason,
                  count(*)::int AS rejects,
                  max(created_at)::text AS latest_reject_at
                FROM hyperliquid_runtime_orders
                WHERE network = 'testnet'
                  AND status = 'rejected'
                GROUP BY coin, rejection_reason
                ORDER BY max(created_at) DESC NULLS LAST, rejects DESC
                LIMIT 100
                """
            ),
            "blocked_decisions_by_reason": self._query_report_rows(
                """
                SELECT
                  coin,
                  action,
                  reason,
                  count(*)::int AS decisions,
                  max(decided_at)::text AS latest_decision_at
                FROM hyperliquid_runtime_decisions
                WHERE network = 'testnet'
                  AND status = 'blocked'
                  AND decided_at >= now() - interval '1 hour'
                GROUP BY coin, action, reason
                ORDER BY max(decided_at) DESC NULLS LAST, decisions DESC
                LIMIT 100
                """
            ),
            "cooldowns": {
                "immediate_match_rejects": self._query_report_rows(
                    """
                    SELECT
                      coin,
                      count(*)::int AS rejects,
                      max(created_at)::text AS latest_reject_at
                    FROM hyperliquid_runtime_orders
                    WHERE network = 'testnet'
                      AND status = 'rejected'
                      AND rejection_reason ILIKE '%could not immediately match%'
                      AND created_at >= now() - (:window_seconds * interval '1 second')
                    GROUP BY coin
                    HAVING count(*) >= :threshold
                      AND max(created_at) >= now()
                        - (:cooldown_seconds * interval '1 second')
                    ORDER BY max(created_at) DESC NULLS LAST
                    """,
                    {
                        "window_seconds": config_payload[
                            "reject_cooldown_window_seconds"
                        ],
                        "cooldown_seconds": config_payload["reject_cooldown_seconds"],
                        "threshold": config_payload["reject_cooldown_threshold"],
                    },
                ),
                "halted": self._query_report_rows(
                    """
                    SELECT
                      coin,
                      max(created_at)::text AS latest_reject_at
                    FROM hyperliquid_runtime_orders
                    WHERE network = 'testnet'
                      AND status = 'rejected'
                      AND rejection_reason = 'Trading is halted.'
                      AND created_at >= now()
                        - (:cooldown_seconds * interval '1 second')
                    GROUP BY coin
                    ORDER BY max(created_at) DESC NULLS LAST
                    """,
                    {"cooldown_seconds": config_payload["halted_cooldown_seconds"]},
                ),
            },
            "latest_performance": self._query_report_rows(
                """
                SELECT
                  observed_at::text,
                  gross_exposure_usd::text,
                  realized_pnl_usd::text,
                  unrealized_pnl_usd::text,
                  fees_usd::text,
                  (realized_pnl_usd + unrealized_pnl_usd - fees_usd)::text
                    AS net_pnl_after_fees_usd,
                  trade_count,
                  reconciliation_status
                FROM hyperliquid_runtime_performance_snapshots
                WHERE network = 'testnet'
                ORDER BY observed_at DESC
                LIMIT 1
                """
            ),
        }

    def _query_report_rows(
        self,
        sql: str,
        params: Mapping[str, object] | None = None,
    ) -> list[dict[str, object]]:
        rows = self._session.execute(text(sql), dict(params or {})).mappings()
        return [dict(row) for row in rows]


def _collection_gross_exposure_usd(
    *,
    account_gross_exposure_usd: Decimal,
    symbol_exposure_usd_by_coin: Mapping[str, Decimal],
    trade_coins: Iterable[str],
    excluded_coins: Iterable[str],
) -> Decimal:
    trade_coin_set = _normalized_coin_set(trade_coins)
    excluded_coin_set = _normalized_coin_set(excluded_coins)
    if not trade_coin_set and not excluded_coin_set:
        return account_gross_exposure_usd
    total = Decimal("0")
    for coin, exposure_usd in symbol_exposure_usd_by_coin.items():
        normalized = coin.casefold()
        if normalized in excluded_coin_set:
            continue
        if trade_coin_set and normalized not in trade_coin_set:
            continue
        total += exposure_usd.copy_abs()
    return total


def _normalized_coin_set(coins: Iterable[str]) -> frozenset[str]:
    return frozenset(coin.strip().casefold() for coin in coins if coin.strip())


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


def _order_intent_from_row(row: Mapping[str, object]) -> OrderIntent:
    return OrderIntent(
        market_id=str(row["market_id"]),
        coin=str(row["coin"]),
        dex=_coin_dex(str(row["coin"])),
        side=_order_side(row["side"]),
        size=Decimal(str(row["size"])),
        limit_price=Decimal(str(row["limit_price"])),
        notional_usd=Decimal(str(row["notional_usd"])),
        cloid=str(row["cloid"]),
        reduce_only=bool(row["reduce_only"]),
        decision_id=str(row["decision_id"]),
    )


def _order_side(value: object) -> OrderSide:
    side = str(value)
    if side not in {"buy", "sell"}:
        raise ValueError(f"invalid_order_side:{side}")
    return cast(OrderSide, side)


def _coin_dex(coin: str) -> str:
    prefix, separator, _suffix = coin.partition(":")
    if not separator:
        return "default"
    return prefix.strip()


def _optional_text(value: object) -> str | None:
    if value is None:
        return None
    return str(value)


def _decimal_or_none(value: Decimal | None) -> str | None:
    if value is None:
        return None
    return str(value)
