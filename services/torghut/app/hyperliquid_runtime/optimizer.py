"""Offline guarded parameter improvement for Hyperliquid V1."""

from __future__ import annotations

from dataclasses import dataclass
from collections.abc import Mapping
from decimal import Decimal

from sqlalchemy import text

from .config import HyperliquidRuntimeConfig
from .runtime_session import RuntimeSession


@dataclass(frozen=True)
class OptimizerCandidate:
    """Walk-forward optimizer result before promotion gates."""

    parameter_version: str
    trade_count: int
    net_pnl_usd: Decimal
    max_drawdown_usd: Decimal
    reconciliation_gap_count: int
    stale_period_count: int
    payload: dict[str, object]


@dataclass(frozen=True)
class OptimizerGateResult:
    """Promotion gate result for an offline candidate."""

    promoted: bool
    reasons: tuple[str, ...]


def evaluate_optimizer_candidate(
    candidate: OptimizerCandidate,
    config: HyperliquidRuntimeConfig,
) -> OptimizerGateResult:
    """Accept only candidates with adequate trades, PnL, drawdown, and clean data."""

    reasons: list[str] = []
    if candidate.trade_count < config.optimizer_min_trades:
        reasons.append("insufficient_trades")
    if candidate.net_pnl_usd < config.optimizer_min_net_pnl_usd:
        reasons.append("net_pnl_below_gate")
    if candidate.max_drawdown_usd > config.optimizer_max_drawdown_usd:
        reasons.append("drawdown_above_gate")
    if candidate.reconciliation_gap_count > 0:
        reasons.append("reconciliation_gaps")
    if candidate.stale_period_count > 0:
        reasons.append("stale_data_periods")
    return OptimizerGateResult(promoted=not reasons, reasons=tuple(reasons))


def build_optimizer_candidate(
    session: RuntimeSession,
    *,
    config: HyperliquidRuntimeConfig,
    history_summary: Mapping[str, object],
) -> OptimizerCandidate:
    """Build a guarded offline candidate from market history and outcomes."""

    row = (
        session.execute(
            text(
                """
                WITH fill_summary AS (
                  SELECT
                    count(*) AS trade_count,
                    COALESCE(sum(closed_pnl_usd - fee_usd), 0) AS net_pnl_usd
                  FROM hyperliquid_runtime_fills
                  WHERE network = 'testnet'
                    AND event_ts >= now() - INTERVAL '7 days'
                ),
                performance_summary AS (
                  SELECT
                    COALESCE(
                      abs(least(min(realized_pnl_usd + unrealized_pnl_usd - fees_usd), 0)),
                      0
                    ) AS max_drawdown_usd,
                    count(*) FILTER (WHERE reconciliation_status <> 'pass')
                      AS stale_period_count
                  FROM hyperliquid_runtime_performance_snapshots
                  WHERE network = 'testnet'
                    AND observed_at >= now() - INTERVAL '7 days'
                ),
                tigerbeetle_summary AS (
                  SELECT count(*) AS reconciliation_gap_count
                  FROM hyperliquid_runtime_tigerbeetle_refs
                  WHERE status NOT IN ('created', 'exists')
                )
                SELECT
                  fill_summary.trade_count,
                  fill_summary.net_pnl_usd,
                  performance_summary.max_drawdown_usd,
                  performance_summary.stale_period_count,
                  tigerbeetle_summary.reconciliation_gap_count
                FROM fill_summary, performance_summary, tigerbeetle_summary
                """
            )
        )
        .mappings()
        .one()
    )
    return OptimizerCandidate(
        parameter_version=f"{config.strategy_parameter_version}-offline-v1",
        trade_count=_int(row["trade_count"]),
        net_pnl_usd=_decimal(row["net_pnl_usd"]),
        max_drawdown_usd=_decimal(row["max_drawdown_usd"]),
        reconciliation_gap_count=_int(row["reconciliation_gap_count"]),
        stale_period_count=_int(row["stale_period_count"])
        + _int(history_summary.get("stale_feature_rows")),
        payload={
            "schema_version": "torghut.hyperliquid-runtime-optimizer-input.v1",
            "market_history": dict(history_summary),
            "outcome_window": "7d",
            "strategy_parameter_version": config.strategy_parameter_version,
        },
    )


def persist_optimizer_run(
    session: RuntimeSession,
    candidate: OptimizerCandidate,
    result: OptimizerGateResult,
) -> None:
    """Persist an optimizer run without changing runtime parameters."""

    import json
    import uuid

    session.execute(
        text(
            """
            INSERT INTO hyperliquid_runtime_optimizer_runs (
              id,
              parameter_version,
              trade_count,
              net_pnl_usd,
              max_drawdown_usd,
              reconciliation_gap_count,
              stale_period_count,
              promoted,
              rejection_reasons,
              payload
            )
            VALUES (
              :id,
              :parameter_version,
              :trade_count,
              :net_pnl_usd,
              :max_drawdown_usd,
              :reconciliation_gap_count,
              :stale_period_count,
              :promoted,
              :rejection_reasons,
              CAST(:payload AS jsonb)
            )
            """
        ),
        {
            "id": str(uuid.uuid4()),
            "parameter_version": candidate.parameter_version,
            "trade_count": candidate.trade_count,
            "net_pnl_usd": str(candidate.net_pnl_usd),
            "max_drawdown_usd": str(candidate.max_drawdown_usd),
            "reconciliation_gap_count": candidate.reconciliation_gap_count,
            "stale_period_count": candidate.stale_period_count,
            "promoted": result.promoted,
            "rejection_reasons": list(result.reasons),
            "payload": json.dumps(candidate.payload, sort_keys=True),
        },
    )


def _int(value: object) -> int:
    if value is None:
        return 0
    return int(Decimal(str(value)))


def _decimal(value: object) -> Decimal:
    if value is None:
        return Decimal("0")
    return Decimal(str(value))
