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
    PositionSnapshot,
    RiskState,
    RuntimeDependencyStatus,
    Signal,
)
from .multifactor_repository import MultifactorExecutionRepository
from .profitability import SymbolProfitabilityState
from .repository_read_models import (
    position_for_coin,
    risk_state,
    symbol_profitability_state,
)
from .reporting import build_operational_report, build_performance_metrics


class HyperliquidExecutionRepository:
    """Persistence facade for v2 execution tables."""

    def __init__(self, session: Any) -> None:
        self._session = session
        self._multifactor = MultifactorExecutionRepository(session)

    @property
    def session(self) -> Any:
        """Return the owning unit of work for the durable submit coordinator."""

        return self._session

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
        self._multifactor.insert_signal(
            run_id=cycle_id,
            signal_id=signal_id,
            signal=signal,
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

    def insert_multifactor_execution_intent(
        self,
        *,
        run_id: str,
        intent: OrderIntent,
        result: OrderResult,
        verdict: Any,
    ) -> None:
        self._multifactor.insert_execution_intent(
            run_id=run_id,
            intent=intent,
            result=result,
            verdict=verdict,
        )

    def insert_multifactor_risk_and_target(self, *, run_id: str, verdict: Any) -> None:
        self._multifactor.insert_risk_and_target(run_id=run_id, verdict=verdict)

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
            or "minimum value" in normalized
            or "minimum order" in normalized
            or "insufficient margin" in normalized
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
                        OR rejection_reason ILIKE '%minimum value%'
                        OR rejection_reason ILIKE '%minimum order%'
                        OR rejection_reason ILIKE '%insufficient margin%'
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
                  market_id,
                  coin,
                  exchange_order_id,
                  cloid,
                  status,
                  expires_at
                FROM hyperliquid_execution_orders
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
                dex=_dex_from_market_id(row["market_id"]),
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
            legacy_fill_hash = _legacy_fill_hash(fill)
            if legacy_fill_hash is not None:
                self._deduplicate_legacy_fill(fill, legacy_fill_hash)
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
                _fill_params(fill),
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

    def _deduplicate_legacy_fill(self, fill: Fill, legacy_fill_hash: str) -> None:
        params = _fill_params(fill) | {"legacy_fill_hash": legacy_fill_hash}
        self._session.execute(
            text(
                """
                UPDATE hyperliquid_execution_fills
                SET
                  fill_hash = :fill_hash,
                  order_id = COALESCE((
                    SELECT id
                    FROM hyperliquid_execution_orders
                    WHERE execution_network = 'testnet'
                      AND exchange_order_id = CAST(:exchange_order_id AS text)
                    ORDER BY created_at DESC
                    LIMIT 1
                  ), order_id),
                  market_id = :market_id,
                  coin = :coin,
                  side = :side,
                  price = :price,
                  size = :size,
                  notional_usd = :notional_usd,
                  fee_usd = :fee_usd,
                  closed_pnl_usd = :closed_pnl_usd,
                  exchange_order_id = COALESCE(CAST(:exchange_order_id AS text), exchange_order_id),
                  event_ts = :event_ts,
                  raw_payload = raw_payload || CAST(:raw_payload AS jsonb)
                WHERE execution_network = 'testnet'
                  AND fill_hash = :legacy_fill_hash
                  AND coin = :coin
                  AND (
                    exchange_order_id IS NULL
                    OR CAST(:exchange_order_id AS text) IS NULL
                    OR exchange_order_id = CAST(:exchange_order_id AS text)
                  )
                  AND NOT EXISTS (
                    SELECT 1
                    FROM hyperliquid_execution_fills
                    WHERE execution_network = 'testnet'
                      AND fill_hash = :fill_hash
                  )
                """
            ),
            params,
        )
        self._session.execute(
            text(
                """
                DELETE FROM hyperliquid_execution_fills
                WHERE execution_network = 'testnet'
                  AND fill_hash = :legacy_fill_hash
                  AND coin = :coin
                  AND (
                    exchange_order_id IS NULL
                    OR CAST(:exchange_order_id AS text) IS NULL
                    OR exchange_order_id = CAST(:exchange_order_id AS text)
                  )
                  AND EXISTS (
                    SELECT 1
                    FROM hyperliquid_execution_fills
                    WHERE execution_network = 'testnet'
                      AND fill_hash = :fill_hash
                  )
                """
            ),
            params,
        )

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
                    "raw_payload": json.dumps(
                        _position_raw_payload(position), sort_keys=True
                    ),
                },
            )

    def symbol_profitability_state(
        self,
        *,
        coin: str,
        now: datetime,
        account_value_usd: Decimal,
    ) -> SymbolProfitabilityState:
        return symbol_profitability_state(
            self._session,
            coin=coin,
            now=now,
            account_value_usd=account_value_usd,
        )

    def position_for_coin(self, coin: str) -> PositionSnapshot | None:
        return position_for_coin(self._session, coin)

    def risk_state(
        self,
        *,
        trading_enabled: bool,
        dependencies: tuple[RuntimeDependencyStatus, ...],
        max_leverage_by_coin: dict[str, Decimal] | None = None,
    ) -> RiskState:
        return risk_state(
            self._session,
            trading_enabled=trading_enabled,
            dependencies=dependencies,
            max_leverage_by_coin=max_leverage_by_coin,
        )

    def insert_performance_snapshot(self, *, observed_at: datetime) -> None:
        metrics = build_performance_metrics(self._session)
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

    def insert_multifactor_attribution_snapshot(
        self,
        *,
        run_id: str,
        observed_at: datetime,
    ) -> None:
        self._multifactor.insert_attribution_snapshot(
            run_id=run_id,
            observed_at=observed_at,
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
        self._multifactor.insert_cycle(record)

    def operational_report(
        self,
        *,
        runtime_payload: Mapping[str, object],
        config_payload: Mapping[str, object],
    ) -> dict[str, object]:
        return build_operational_report(
            self._session,
            runtime_payload=runtime_payload,
            config_payload=config_payload,
        )

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


def _dex_from_market_id(value: object) -> str:
    text_value = str(value or "").strip()
    parts = text_value.split(":")
    if len(parts) >= 4 and parts[0] == "hl" and parts[1] == "perp":
        dex = parts[2].strip()
        if dex:
            return dex
    return "default"


def _position_raw_payload(position: PositionSnapshot) -> dict[str, object]:
    payload = dict(position.raw_payload)
    if position.sdk_coin:
        payload.setdefault("sdk_coin", position.sdk_coin)
    return payload


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


def _decimal_or_none(value: Decimal | None) -> str | None:
    return None if value is None else str(value)


def _legacy_fill_hash(fill: Fill) -> str | None:
    legacy_hash = fill.raw_payload.get("hash")
    if legacy_hash is None:
        return None
    legacy_hash_text = str(legacy_hash).strip()
    if not legacy_hash_text or legacy_hash_text == fill.fill_hash:
        return None
    return legacy_hash_text


def _fill_params(fill: Fill) -> dict[str, object]:
    return {
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
    }


def _optional_text(value: object) -> str | None:
    if value is None:
        return None
    text_value = str(value)
    return text_value if text_value else None
