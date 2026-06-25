"""Persistence helpers for generic multifactor proof tables."""

from __future__ import annotations

import json
from datetime import datetime
from decimal import Decimal
from typing import Any, Mapping

from sqlalchemy import text

from .models import CycleRecord, OrderIntent, OrderResult, Signal
from .reporting import build_performance_metrics


class MultifactorExecutionRepository:
    """Writes generic multifactor proof rows for the Hyperliquid runtime."""

    def __init__(self, session: Any) -> None:
        self._session = session

    def insert_signal(
        self,
        *,
        run_id: str,
        signal_id: str,
        signal: Signal,
    ) -> None:
        vector = signal.factor_vector
        forecast = signal.alpha_forecast
        if vector is None or forecast is None:
            return
        asset_key = vector.asset.key
        self._session.execute(
            text(
                """
                INSERT INTO multifactor_factor_snapshots (
                  run_id,
                  asset_key,
                  venue,
                  symbol,
                  market_id,
                  source_event_at,
                  observed_at,
                  raw_factors,
                  normalized_factors,
                  source_lag_seconds,
                  quote_lag_seconds,
                  freshness_blocker
                )
                VALUES (
                  :run_id,
                  :asset_key,
                  :venue,
                  :symbol,
                  :market_id,
                  :source_event_at,
                  :observed_at,
                  CAST(:raw_factors AS jsonb),
                  CAST(:normalized_factors AS jsonb),
                  :source_lag_seconds,
                  :quote_lag_seconds,
                  :freshness_blocker
                )
                ON CONFLICT (run_id, asset_key) DO UPDATE SET
                  source_event_at = EXCLUDED.source_event_at,
                  observed_at = EXCLUDED.observed_at,
                  raw_factors = EXCLUDED.raw_factors,
                  normalized_factors = EXCLUDED.normalized_factors,
                  source_lag_seconds = EXCLUDED.source_lag_seconds,
                  quote_lag_seconds = EXCLUDED.quote_lag_seconds,
                  freshness_blocker = EXCLUDED.freshness_blocker,
                  updated_at = now()
                """
            ),
            {
                "run_id": run_id,
                "asset_key": asset_key,
                "venue": vector.asset.venue,
                "symbol": vector.asset.symbol,
                "market_id": vector.asset.market_id,
                "source_event_at": vector.source_event_at,
                "observed_at": vector.observed_at,
                "raw_factors": json.dumps(
                    _decimal_map_payload(vector.raw_factors), sort_keys=True
                ),
                "normalized_factors": json.dumps(
                    _decimal_map_payload(vector.normalized_factors), sort_keys=True
                ),
                "source_lag_seconds": vector.source_lag_seconds,
                "quote_lag_seconds": vector.quote_lag_seconds,
                "freshness_blocker": vector.freshness_blocker,
            },
        )
        self._insert_forecast(
            run_id=run_id,
            signal_id=signal_id,
            signal=signal,
            asset_key=asset_key,
        )

    def insert_execution_intent(
        self,
        *,
        run_id: str,
        intent: OrderIntent,
        result: OrderResult,
        verdict: Any,
    ) -> None:
        target = getattr(verdict, "portfolio_target", None)
        if target is None:
            return
        self._session.execute(
            text(
                """
                INSERT INTO multifactor_execution_intents (
                  run_id,
                  asset_key,
                  venue,
                  side,
                  notional_usd,
                  idempotency_key,
                  status,
                  blocker,
                  venue_order_id,
                  raw_payload
                )
                VALUES (
                  :run_id,
                  :asset_key,
                  'hyperliquid',
                  :side,
                  :notional_usd,
                  :idempotency_key,
                  :status,
                  :blocker,
                  :venue_order_id,
                  CAST(:raw_payload AS jsonb)
                )
                ON CONFLICT (run_id, asset_key) DO UPDATE SET
                  side = EXCLUDED.side,
                  notional_usd = EXCLUDED.notional_usd,
                  idempotency_key = EXCLUDED.idempotency_key,
                  status = EXCLUDED.status,
                  blocker = EXCLUDED.blocker,
                  venue_order_id = EXCLUDED.venue_order_id,
                  raw_payload = EXCLUDED.raw_payload,
                  updated_at = now()
                """
            ),
            {
                "run_id": run_id,
                "asset_key": target.asset.key,
                "side": intent.side,
                "notional_usd": str(intent.notional_usd),
                "idempotency_key": intent.cloid,
                "status": result.status,
                "blocker": result.rejection_reason,
                "venue_order_id": result.exchange_order_id,
                "raw_payload": json.dumps(result.raw_response, sort_keys=True),
            },
        )

    def insert_risk_and_target(self, *, run_id: str, verdict: Any) -> None:
        risk = getattr(verdict, "risk_forecast", None)
        target = getattr(verdict, "portfolio_target", None)
        if risk is None or target is None:
            return
        asset_key = target.asset.key
        self._insert_risk(run_id=run_id, asset_key=asset_key, risk=risk)
        self._insert_target(run_id=run_id, asset_key=asset_key, target=target)

    def insert_attribution_snapshot(
        self,
        *,
        run_id: str,
        observed_at: datetime,
    ) -> None:
        metrics = build_performance_metrics(self._session)
        self._session.execute(
            text(
                """
                INSERT INTO multifactor_attribution_snapshots (
                  run_id,
                  observed_at,
                  fill_count,
                  realized_pnl_usd,
                  turnover_usd,
                  realized_cost_usd,
                  hit_rate,
                  raw_payload
                )
                VALUES (
                  :run_id,
                  :observed_at,
                  :fill_count,
                  :realized_pnl_usd,
                  :turnover_usd,
                  :realized_cost_usd,
                  :hit_rate,
                  CAST(:raw_payload AS jsonb)
                )
                ON CONFLICT (run_id) DO UPDATE SET
                  observed_at = EXCLUDED.observed_at,
                  fill_count = EXCLUDED.fill_count,
                  realized_pnl_usd = EXCLUDED.realized_pnl_usd,
                  turnover_usd = EXCLUDED.turnover_usd,
                  realized_cost_usd = EXCLUDED.realized_cost_usd,
                  hit_rate = EXCLUDED.hit_rate,
                  raw_payload = EXCLUDED.raw_payload,
                  updated_at = now()
                """
            ),
            {
                "run_id": run_id,
                "observed_at": observed_at,
                "fill_count": metrics["fill_count_24h"],
                "realized_pnl_usd": metrics["net_pnl_after_fees_usd_24h"],
                "turnover_usd": metrics["notional_usd_24h"],
                "realized_cost_usd": metrics["fees_usd_24h"],
                "hit_rate": "1" if int(str(metrics["fill_count_24h"])) > 0 else "0",
                "raw_payload": json.dumps(metrics, sort_keys=True),
            },
        )

    def insert_cycle(self, record: CycleRecord) -> None:
        self._session.execute(
            text(
                """
                INSERT INTO multifactor_runs (
                  id,
                  lane,
                  model_version,
                  started_at,
                  finished_at,
                  status,
                  blockers,
                  selected_assets,
                  raw_payload
                )
                VALUES (
                  :id,
                  'hyperliquid_testnet',
                  'active-portfolio-management-v1',
                  :started_at,
                  :finished_at,
                  :status,
                  CAST(:blockers AS jsonb),
                  CAST(:selected_assets AS jsonb),
                  CAST(:raw_payload AS jsonb)
                )
                ON CONFLICT (id) DO UPDATE SET
                  finished_at = EXCLUDED.finished_at,
                  status = EXCLUDED.status,
                  blockers = EXCLUDED.blockers,
                  selected_assets = EXCLUDED.selected_assets,
                  raw_payload = EXCLUDED.raw_payload,
                  updated_at = now()
                """
            ),
            {
                "id": record.cycle_id,
                "started_at": record.started_at,
                "finished_at": record.finished_at,
                "status": "failed" if record.error else "completed",
                "blockers": json.dumps(
                    [
                        dependency.name
                        for dependency in record.dependency_statuses
                        if not dependency.ready
                    ],
                    sort_keys=True,
                ),
                "selected_assets": json.dumps(list(record.selected_coins)),
                "raw_payload": json.dumps(
                    {
                        "signals_written": record.signals_written,
                        "orders_submitted": record.orders_submitted,
                        "orders_cancelled": record.orders_cancelled,
                        "universe_details": record.universe_details,
                    },
                    sort_keys=True,
                ),
            },
        )

    def _insert_forecast(
        self,
        *,
        run_id: str,
        signal_id: str,
        signal: Signal,
        asset_key: str,
    ) -> None:
        vector = signal.factor_vector
        forecast = signal.alpha_forecast
        if vector is None or forecast is None:
            return
        self._session.execute(
            text(
                """
                INSERT INTO multifactor_forecasts (
                  run_id,
                  asset_key,
                  model_id,
                  signal_id,
                  horizon_seconds,
                  score,
                  residual_volatility_bps,
                  information_coefficient,
                  expected_return_bps,
                  direction,
                  blocker
                )
                VALUES (
                  :run_id,
                  :asset_key,
                  :model_id,
                  :signal_id,
                  :horizon_seconds,
                  :score,
                  :residual_volatility_bps,
                  :information_coefficient,
                  :expected_return_bps,
                  :direction,
                  :blocker
                )
                ON CONFLICT (run_id, asset_key) DO UPDATE SET
                  model_id = EXCLUDED.model_id,
                  signal_id = EXCLUDED.signal_id,
                  horizon_seconds = EXCLUDED.horizon_seconds,
                  score = EXCLUDED.score,
                  residual_volatility_bps = EXCLUDED.residual_volatility_bps,
                  information_coefficient = EXCLUDED.information_coefficient,
                  expected_return_bps = EXCLUDED.expected_return_bps,
                  direction = EXCLUDED.direction,
                  blocker = EXCLUDED.blocker,
                  updated_at = now()
                """
            ),
            {
                "run_id": run_id,
                "asset_key": asset_key,
                "model_id": forecast.model_id,
                "signal_id": signal_id,
                "horizon_seconds": forecast.horizon_seconds,
                "score": str(forecast.score),
                "residual_volatility_bps": str(forecast.residual_volatility_bps),
                "information_coefficient": str(forecast.information_coefficient),
                "expected_return_bps": str(forecast.expected_return_bps),
                "direction": forecast.direction,
                "blocker": forecast.blocker,
            },
        )
        self._update_signal_features(
            run_id=run_id,
            signal_id=signal_id,
            signal=signal,
            asset_key=asset_key,
        )

    def _insert_risk(self, *, run_id: str, asset_key: str, risk: Any) -> None:
        self._session.execute(
            text(
                """
                INSERT INTO multifactor_risk_forecasts (
                  run_id,
                  asset_key,
                  active_risk_bps,
                  gross_exposure_usd,
                  symbol_exposure_usd,
                  liquidity_capacity_usd,
                  concentration_bps,
                  blocker
                )
                VALUES (
                  :run_id,
                  :asset_key,
                  :active_risk_bps,
                  :gross_exposure_usd,
                  :symbol_exposure_usd,
                  :liquidity_capacity_usd,
                  :concentration_bps,
                  :blocker
                )
                ON CONFLICT (run_id, asset_key) DO UPDATE SET
                  active_risk_bps = EXCLUDED.active_risk_bps,
                  gross_exposure_usd = EXCLUDED.gross_exposure_usd,
                  symbol_exposure_usd = EXCLUDED.symbol_exposure_usd,
                  liquidity_capacity_usd = EXCLUDED.liquidity_capacity_usd,
                  concentration_bps = EXCLUDED.concentration_bps,
                  blocker = EXCLUDED.blocker,
                  updated_at = now()
                """
            ),
            {
                "run_id": run_id,
                "asset_key": asset_key,
                "active_risk_bps": str(risk.active_risk_bps),
                "gross_exposure_usd": str(risk.gross_exposure_usd),
                "symbol_exposure_usd": str(risk.symbol_exposure_usd),
                "liquidity_capacity_usd": str(risk.liquidity_capacity_usd),
                "concentration_bps": str(risk.concentration_bps),
                "blocker": risk.blocker,
            },
        )

    def _insert_target(self, *, run_id: str, asset_key: str, target: Any) -> None:
        self._session.execute(
            text(
                """
                INSERT INTO multifactor_portfolio_targets (
                  run_id,
                  asset_key,
                  direction,
                  current_notional_usd,
                  target_notional_usd,
                  delta_notional_usd,
                  expected_return_bps,
                  expected_cost_bps,
                  active_risk_bps,
                  risk_buffer_bps,
                  clip_reason
                )
                VALUES (
                  :run_id,
                  :asset_key,
                  :direction,
                  :current_notional_usd,
                  :target_notional_usd,
                  :delta_notional_usd,
                  :expected_return_bps,
                  :expected_cost_bps,
                  :active_risk_bps,
                  :risk_buffer_bps,
                  :clip_reason
                )
                ON CONFLICT (run_id, asset_key) DO UPDATE SET
                  direction = EXCLUDED.direction,
                  current_notional_usd = EXCLUDED.current_notional_usd,
                  target_notional_usd = EXCLUDED.target_notional_usd,
                  delta_notional_usd = EXCLUDED.delta_notional_usd,
                  expected_return_bps = EXCLUDED.expected_return_bps,
                  expected_cost_bps = EXCLUDED.expected_cost_bps,
                  active_risk_bps = EXCLUDED.active_risk_bps,
                  risk_buffer_bps = EXCLUDED.risk_buffer_bps,
                  clip_reason = EXCLUDED.clip_reason,
                  updated_at = now()
                """
            ),
            {
                "run_id": run_id,
                "asset_key": asset_key,
                "direction": target.direction,
                "current_notional_usd": str(target.current_notional_usd),
                "target_notional_usd": str(target.target_notional_usd),
                "delta_notional_usd": str(target.delta_notional_usd),
                "expected_return_bps": str(target.expected_return_bps),
                "expected_cost_bps": str(target.expected_cost_bps),
                "active_risk_bps": str(target.active_risk_bps),
                "risk_buffer_bps": str(target.risk_buffer_bps),
                "clip_reason": target.clip_reason,
            },
        )

    def _update_signal_features(
        self,
        *,
        run_id: str,
        signal_id: str,
        signal: Signal,
        asset_key: str,
    ) -> None:
        vector = signal.factor_vector
        forecast = signal.alpha_forecast
        if vector is None or forecast is None:
            return
        raw_features = dict(signal.feature.raw_features)
        raw_features.setdefault("source_lag_seconds", signal.feature.source_lag_seconds)
        if signal.feature.quote_lag_seconds is not None:
            raw_features.setdefault(
                "quote_lag_seconds", signal.feature.quote_lag_seconds
            )
        raw_features["multifactor"] = {
            "schema_version": "torghut.multifactor.signal.v1",
            "run_id": run_id,
            "asset_key": asset_key,
            "model_id": forecast.model_id,
            "expected_return_bps": str(forecast.expected_return_bps),
            "score": str(forecast.score),
            "direction": forecast.direction,
            "freshness_blocker": vector.freshness_blocker,
        }
        self._session.execute(
            text(
                """
                UPDATE hyperliquid_execution_signals
                SET features = CAST(:features AS jsonb)
                WHERE id = :signal_id
                """
            ),
            {
                "signal_id": signal_id,
                "features": json.dumps(raw_features, sort_keys=True),
            },
        )


def _decimal_map_payload(values: Mapping[str, Decimal]) -> dict[str, str]:
    return {key: str(value) for key, value in values.items()}
