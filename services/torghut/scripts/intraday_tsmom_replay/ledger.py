from __future__ import annotations

import uuid
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from typing import Any

from app.trading.costs import TransactionCostModel
from app.trading.economic_policy import EconomicPolicy
from app.trading.models import StrategyDecision

from .replay_types import (
    _EXACT_REPLAY_LEDGER_ROWS_SCHEMA_VERSION,
    _REPLAY_ADV_SOURCE,
    _REPLAY_COST_BASIS,
    _REPLAY_LEDGER_ACCOUNT_LABEL,
    _REPLAY_LEDGER_SOURCE,
    ReplayConfig,
    ReplayCostLineage,
    ReplayLedgerContext,
    _decimal_text,
    _decimal_text_or_none,
    _file_sha256,
    _stable_json_hash,
    _utc_text,
)


@dataclass(frozen=True)
class LedgerBaseRow:
    context: ReplayLedgerContext
    decision: StrategyDecision
    strategy_id: str
    decision_id: str
    order_id: str
    event_type: str
    executed_at: datetime


@dataclass(frozen=True)
class LedgerResolution:
    context: ReplayLedgerContext | None
    decision: StrategyDecision
    created_at: datetime
    resolved_at: datetime
    strategy_id: str
    event_type: str
    reason: str | None = None


@dataclass(frozen=True)
class LedgerFill:
    context: ReplayLedgerContext | None
    decision: StrategyDecision
    created_at: datetime
    filled_at: datetime
    strategy_id: str
    filled_qty: Decimal
    avg_fill_price: Decimal
    cost_amount: Decimal
    cost_lineage: ReplayCostLineage | None = None


def _ledger_identity(
    *,
    prefix: str,
    decision: StrategyDecision,
    created_at: datetime,
    strategy_id: str,
) -> str:
    payload = {
        "prefix": prefix,
        "strategy_id": strategy_id,
        "symbol": decision.symbol.upper(),
        "created_at": _utc_text(created_at),
        "event_ts": _utc_text(decision.event_ts),
        "action": decision.action,
        "qty": _decimal_text(decision.qty),
        "order_type": decision.order_type,
        "time_in_force": decision.time_in_force,
        "limit_price": _decimal_text_or_none(decision.limit_price),
    }
    digest = _stable_json_hash(payload)
    return f"{prefix}-{uuid.uuid5(uuid.NAMESPACE_URL, digest)}"


def _build_replay_ledger_context(
    *,
    config: ReplayConfig,
    cost_model: TransactionCostModel,
    economic_policy: EconomicPolicy,
) -> ReplayLedgerContext:
    config_hash = _file_sha256(config.strategy_configmap_path)
    replay_manifest_hash = _file_sha256(config.replay_tape_manifest_path)
    replay_tape_hash = _file_sha256(config.replay_tape_path)
    execution_policy_hash = _stable_json_hash(
        {
            "source": _REPLAY_LEDGER_SOURCE,
            "strategy_configmap_sha256": config_hash,
            "flatten_eod": config.flatten_eod,
            "force_position_isolation": config.force_position_isolation,
            "economic_policy_digest": economic_policy.digest,
            "max_executable_spread_bps": str(
                economic_policy.slippage.max_executable_spread_bps
            ),
            "max_quote_mid_jump_bps": str(
                economic_policy.slippage.max_quote_mid_jump_bps
            ),
            "max_jump_with_wide_spread_bps": str(
                economic_policy.slippage.max_jump_with_wide_spread_bps
            ),
        }
    )
    cost_model_hash = _stable_json_hash(
        {
            "model": cost_model.__class__.__name__,
            "module": cost_model.__class__.__module__,
            "cost_basis": _REPLAY_COST_BASIS,
            "adv_source": _REPLAY_ADV_SOURCE,
            "config": {
                "commission_bps": str(cost_model.config.commission_bps),
                "commission_per_share": str(cost_model.config.commission_per_share),
                "min_commission": str(cost_model.config.min_commission),
                "sec_fee_rate_on_sales": str(cost_model.config.sec_fee_rate_on_sales),
                "taf_fee_per_share_on_sales": str(
                    cost_model.config.taf_fee_per_share_on_sales
                ),
                "taf_fee_cap_per_trade": str(cost_model.config.taf_fee_cap_per_trade),
                "cat_fee_per_share": str(cost_model.config.cat_fee_per_share),
                "max_participation_rate": str(cost_model.config.max_participation_rate),
                "impact_bps_at_full_participation": str(
                    cost_model.config.impact_bps_at_full_participation
                ),
                "impact_participation_exponent": str(
                    cost_model.config.impact_participation_exponent
                ),
            },
        }
    )
    cost_lineage_payload = {
        "cost_basis": _REPLAY_COST_BASIS,
        "model": cost_model.__class__.__name__,
        "module": cost_model.__class__.__module__,
        "adv_source": _REPLAY_ADV_SOURCE,
        "fill_adv_notional_required": True,
        "fill_participation_rate_required": True,
        "fill_capacity_warning_contract_required": True,
        "warning_contract": ["missing_adv", "participation_exceeds_max"],
        "config": {
            "commission_bps": str(cost_model.config.commission_bps),
            "commission_per_share": str(cost_model.config.commission_per_share),
            "min_commission": str(cost_model.config.min_commission),
            "sec_fee_rate_on_sales": str(cost_model.config.sec_fee_rate_on_sales),
            "taf_fee_per_share_on_sales": str(
                cost_model.config.taf_fee_per_share_on_sales
            ),
            "taf_fee_cap_per_trade": str(cost_model.config.taf_fee_cap_per_trade),
            "cat_fee_per_share": str(cost_model.config.cat_fee_per_share),
            "max_participation_rate": str(cost_model.config.max_participation_rate),
            "impact_bps_at_full_participation": str(
                cost_model.config.impact_bps_at_full_participation
            ),
            "impact_participation_exponent": str(
                cost_model.config.impact_participation_exponent
            ),
        },
    }
    cost_lineage_hash = _stable_json_hash(cost_lineage_payload)
    lineage_payload = {
        "source": _REPLAY_LEDGER_SOURCE,
        "strategy_configmap_sha256": config_hash,
        "start_date": config.start_date.isoformat(),
        "end_date": config.end_date.isoformat(),
        "symbols": list(config.symbols),
        "chunk_minutes": config.chunk_minutes,
        "replay_tape_sha256": replay_tape_hash,
        "replay_tape_manifest_sha256": replay_manifest_hash,
        "allow_stale_tape": config.allow_stale_tape,
        "economic_policy_digest": economic_policy.digest,
    }
    replay_data_hash = _stable_json_hash(
        {
            "clickhouse_http_url": config.clickhouse_http_url,
            "start_date": config.start_date.isoformat(),
            "end_date": config.end_date.isoformat(),
            "symbols": list(config.symbols),
            "replay_tape_sha256": replay_tape_hash,
            "replay_tape_manifest_sha256": replay_manifest_hash,
        }
    )
    candidate_identity_seed = {
        "source": _REPLAY_LEDGER_SOURCE,
        "strategy_configmap_sha256": config_hash,
        "start_date": config.start_date.isoformat(),
        "end_date": config.end_date.isoformat(),
        "symbols": list(config.symbols),
        "execution_policy_hash": execution_policy_hash,
        "cost_model_hash": cost_model_hash,
        "cost_lineage_hash": cost_lineage_hash,
        "lineage_hash": _stable_json_hash(lineage_payload),
        "replay_data_hash": replay_data_hash,
        "economic_policy_digest": economic_policy.digest,
    }
    candidate_identity_hash = _stable_json_hash(candidate_identity_seed)
    candidate_id = f"exact-replay-{candidate_identity_hash[:24]}"
    candidate_identity = {
        **candidate_identity_seed,
        "candidate_id": candidate_id,
        "candidate_id_source": (
            "sha256(strategy_config,replay_window,symbols,execution_policy,"
            "cost_lineage,lineage,replay_data)"
        ),
        "candidate_identity_hash": candidate_identity_hash,
    }
    return ReplayLedgerContext(
        account_label=_REPLAY_LEDGER_ACCOUNT_LABEL,
        candidate_id=candidate_id,
        candidate_identity=candidate_identity,
        candidate_identity_hash=candidate_identity_hash,
        execution_policy_hash=execution_policy_hash,
        cost_model_hash=cost_model_hash,
        cost_lineage=cost_lineage_payload,
        cost_lineage_hash=cost_lineage_hash,
        lineage_hash=_stable_json_hash(lineage_payload),
        replay_data_hash=replay_data_hash,
        economic_policy_digest=economic_policy.digest,
    )


def _base_ledger_row(entry: LedgerBaseRow) -> dict[str, Any]:
    row: dict[str, Any] = {
        "event_type": entry.event_type,
        "executed_at": _utc_text(entry.executed_at),
        "account_label": entry.context.account_label,
        "candidate_id": entry.context.candidate_id,
        "candidate_identity_hash": entry.context.candidate_identity_hash,
        "strategy_id": entry.strategy_id,
        "symbol": entry.decision.symbol.upper(),
        "side": entry.decision.action,
        "decision_id": entry.decision_id,
        "order_id": entry.order_id,
        "source": _REPLAY_LEDGER_SOURCE,
        "execution_policy_hash": entry.context.execution_policy_hash,
        "cost_model_hash": entry.context.cost_model_hash,
        "cost_lineage_hash": entry.context.cost_lineage_hash,
        "lineage_hash": entry.context.lineage_hash,
        "replay_data_hash": entry.context.replay_data_hash,
        "economic_policy_digest": entry.context.economic_policy_digest,
        "order_type": entry.decision.order_type,
        "time_in_force": entry.decision.time_in_force,
    }
    if entry.decision.limit_price is not None:
        row["limit_price"] = _decimal_text(entry.decision.limit_price)
    if entry.decision.rationale:
        row["rationale"] = entry.decision.rationale
    pre_broker_intent = entry.decision.params.get("pre_broker_intent")
    if isinstance(pre_broker_intent, dict):
        row["pre_broker_intent_digest"] = pre_broker_intent.get("digest")
    return row


def _append_ledger_submission(
    *,
    rows: list[dict[str, Any]] | None,
    context: ReplayLedgerContext | None,
    decision: StrategyDecision,
    created_at: datetime,
    strategy_id: str,
) -> tuple[str, str]:
    decision_id = _ledger_identity(
        prefix="decision",
        decision=decision,
        created_at=created_at,
        strategy_id=strategy_id,
    )
    order_id = _ledger_identity(
        prefix="order",
        decision=decision,
        created_at=created_at,
        strategy_id=strategy_id,
    )
    if rows is None or context is None:
        return decision_id, order_id
    decision_row = _base_ledger_row(
        LedgerBaseRow(
            context=context,
            decision=decision,
            strategy_id=strategy_id,
            decision_id=decision_id,
            order_id=order_id,
            event_type="decision",
            executed_at=created_at,
        )
    )
    decision_row["qty"] = _decimal_text(decision.qty)
    rows.append(decision_row)
    order_row = _base_ledger_row(
        LedgerBaseRow(
            context=context,
            decision=decision,
            strategy_id=strategy_id,
            decision_id=decision_id,
            order_id=order_id,
            event_type="order_submitted",
            executed_at=created_at,
        )
    )
    order_row["submitted_qty"] = _decimal_text(decision.qty)
    rows.append(order_row)
    return decision_id, order_id


def _append_ledger_resolution(
    rows: list[dict[str, Any]] | None,
    resolution: LedgerResolution,
) -> None:
    if rows is None or resolution.context is None:
        return
    decision_id = _ledger_identity(
        prefix="decision",
        decision=resolution.decision,
        created_at=resolution.created_at,
        strategy_id=resolution.strategy_id,
    )
    order_id = _ledger_identity(
        prefix="order",
        decision=resolution.decision,
        created_at=resolution.created_at,
        strategy_id=resolution.strategy_id,
    )
    row = _base_ledger_row(
        LedgerBaseRow(
            context=resolution.context,
            decision=resolution.decision,
            strategy_id=resolution.strategy_id,
            decision_id=decision_id,
            order_id=order_id,
            event_type=resolution.event_type,
            executed_at=resolution.resolved_at,
        )
    )
    if resolution.reason:
        row["reason"] = resolution.reason
    rows.append(row)


def _ledger_resolution_event_type(outcome: str) -> str | None:
    if outcome == "filled":
        return None
    if outcome == "replaced":
        return "order_cancelled"
    if outcome == "censored":
        return "order_unfilled"
    if outcome == "rejected":
        return "order_rejected"
    return "order_unfilled"


def _append_ledger_fill(
    rows: list[dict[str, Any]] | None,
    fill: LedgerFill,
) -> None:
    if rows is None or fill.context is None:
        return
    decision_id = _ledger_identity(
        prefix="decision",
        decision=fill.decision,
        created_at=fill.created_at,
        strategy_id=fill.strategy_id,
    )
    order_id = _ledger_identity(
        prefix="order",
        decision=fill.decision,
        created_at=fill.created_at,
        strategy_id=fill.strategy_id,
    )
    row = _base_ledger_row(
        LedgerBaseRow(
            context=fill.context,
            decision=fill.decision,
            strategy_id=fill.strategy_id,
            decision_id=decision_id,
            order_id=order_id,
            event_type="fill",
            executed_at=fill.filled_at,
        )
    )
    filled_notional = fill.avg_fill_price * fill.filled_qty
    row.update(
        {
            "filled_qty": _decimal_text(fill.filled_qty),
            "avg_fill_price": _decimal_text(fill.avg_fill_price),
            "filled_notional": _decimal_text(filled_notional),
            "cost_amount": _decimal_text(fill.cost_amount),
            "cost_basis": _REPLAY_COST_BASIS,
            "fill_price_basis": "local_replay_resolved_fill_price",
        }
    )
    if fill.cost_lineage is not None:
        row.update(
            {
                "adv_source": fill.cost_lineage.adv_source,
                "adv_notional": _decimal_text_or_none(fill.cost_lineage.adv_notional),
                "participation_rate": _decimal_text_or_none(
                    fill.cost_lineage.participation_rate
                ),
                "capacity_ok": fill.cost_lineage.capacity_ok,
                "capacity_warning_codes": list(fill.cost_lineage.warnings),
                "spread": _decimal_text_or_none(fill.cost_lineage.spread),
                "volatility": _decimal_text_or_none(fill.cost_lineage.volatility),
                "spread_cost_bps": _decimal_text(fill.cost_lineage.spread_cost_bps),
                "volatility_cost_bps": _decimal_text(
                    fill.cost_lineage.volatility_cost_bps
                ),
                "impact_cost_bps": _decimal_text(fill.cost_lineage.impact_cost_bps),
                "commission_cost": _decimal_text(fill.cost_lineage.commission_cost),
                "commission_cost_bps": _decimal_text(
                    fill.cost_lineage.commission_cost_bps
                ),
                "sec_fee_cost": _decimal_text(fill.cost_lineage.sec_fee_cost),
                "taf_fee_cost": _decimal_text(fill.cost_lineage.taf_fee_cost),
                "cat_fee_cost": _decimal_text(fill.cost_lineage.cat_fee_cost),
                "regulatory_fee_cost": _decimal_text(
                    fill.cost_lineage.regulatory_fee_cost
                ),
                "regulatory_fee_cost_bps": _decimal_text(
                    fill.cost_lineage.regulatory_fee_cost_bps
                ),
                "total_cost_bps": _decimal_text(fill.cost_lineage.total_cost_bps),
                "max_participation_rate": _decimal_text(
                    fill.cost_lineage.max_participation_rate
                ),
                "impact_bps_at_full_participation": _decimal_text(
                    fill.cost_lineage.impact_bps_at_full_participation
                ),
                "impact_participation_exponent": _decimal_text(
                    fill.cost_lineage.impact_participation_exponent
                ),
            }
        )
    rows.append(row)


def _exact_replay_ledger_payload(
    *,
    rows: list[dict[str, Any]],
    config: ReplayConfig,
    context: ReplayLedgerContext,
) -> dict[str, Any]:
    event_type_counts: defaultdict[str, int] = defaultdict(int)
    for row in rows:
        event_type_counts[str(row.get("event_type") or "diagnostic")] += 1
    fill_rows = [row for row in rows if row.get("event_type") == "fill"]
    capacity_warning_counts: defaultdict[str, int] = defaultdict(int)
    fills_with_capacity_warning_contract = 0
    for row in fill_rows:
        warnings = row.get("capacity_warning_codes")
        if isinstance(warnings, list):
            fills_with_capacity_warning_contract += 1
            for warning in warnings:
                if isinstance(warning, str) and warning:
                    capacity_warning_counts[warning] += 1
    return {
        "schema_version": _EXACT_REPLAY_LEDGER_ROWS_SCHEMA_VERSION,
        "source": _REPLAY_LEDGER_SOURCE,
        "account_label": context.account_label,
        "candidate_id": context.candidate_id,
        "candidate_identity": context.candidate_identity,
        "candidate_identity_hash": context.candidate_identity_hash,
        "stage": "replay",
        "promotion_authority": "replay_artifact_only_not_live",
        "window_start": config.start_date.isoformat(),
        "window_end": config.end_date.isoformat(),
        "execution_policy_hash": context.execution_policy_hash,
        "economic_policy_digest": context.economic_policy_digest,
        "cost_model_hash": context.cost_model_hash,
        "cost_lineage": {
            **context.cost_lineage,
            "cost_lineage_hash": context.cost_lineage_hash,
            "fill_count": len(fill_rows),
            "fills_with_adv_notional": sum(
                1 for row in fill_rows if row.get("adv_notional") not in (None, "")
            ),
            "fills_with_participation_rate": sum(
                1
                for row in fill_rows
                if row.get("participation_rate") not in (None, "")
            ),
            "fills_with_capacity_warning_contract": (
                fills_with_capacity_warning_contract
            ),
            "capacity_warning_counts": dict(sorted(capacity_warning_counts.items())),
        },
        "cost_lineage_hash": context.cost_lineage_hash,
        "lineage_hash": context.lineage_hash,
        "replay_data_hash": context.replay_data_hash,
        "cost_basis": _REPLAY_COST_BASIS,
        "row_count": len(rows),
        "event_type_counts": dict(sorted(event_type_counts.items())),
        "decision_row_count": event_type_counts.get("decision", 0),
        "submitted_order_row_count": event_type_counts.get("order_submitted", 0),
        "fill_row_count": event_type_counts.get("fill", 0),
        "runtime_ledger_rows": rows,
    }
