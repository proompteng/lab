"""Offline guarded parameter improvement for Hyperliquid V1."""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal

from sqlalchemy import text
from sqlalchemy.orm import Session

from .config import HyperliquidRuntimeConfig


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


def persist_optimizer_run(
    session: Session,
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
