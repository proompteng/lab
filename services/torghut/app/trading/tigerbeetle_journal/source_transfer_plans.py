"""Idempotent Torghut order-event journal for TigerBeetle."""

from __future__ import annotations

from decimal import Decimal


from app.models import (
    Execution,
    ExecutionTCAMetric,
    StrategyRuntimeLedgerBucket,
)
from app.trading.tigerbeetle_ledger_model import (
    PNL_DIRECTION_LOSS,
    PNL_DIRECTION_PROFIT,
    TRANSFER_KIND_EXECUTION_COST,
    TRANSFER_KIND_EXECUTION_FILL,
    TRANSFER_KIND_RUNTIME_NET_PNL,
    decimal_usd_to_nearest_micros,
)

from .journal_payloads import (
    TigerBeetleRuntimeLedgerTransferPlan,
    TigerBeetleSourceTransferPlan,
)
from .transfer_refs import (
    evidence_account_specs,
    execution_cost_transfer_id,
    execution_notional_usd,
    execution_transfer_id,
    runtime_ledger_amount_source,
    runtime_ledger_transfer_id,
    source_transfer_spec,
)


def _amount_to_micros(value: Decimal | None) -> int | None:
    if value is None:
        return None
    amount = decimal_usd_to_nearest_micros(abs(Decimal(str(value))))
    return amount if amount > 0 else None


def build_runtime_ledger_bucket_transfer_plan(
    bucket: StrategyRuntimeLedgerBucket,
) -> TigerBeetleRuntimeLedgerTransferPlan | None:
    amount_source = runtime_ledger_amount_source(bucket)
    amount = _amount_to_micros(amount_source)
    if amount is None:
        return None
    runtime_key = (
        f"{bucket.hypothesis_id}:{bucket.run_id}:{bucket.bucket_started_at.isoformat()}"
    )
    account_specs = tuple(
        evidence_account_specs(
            account_label=bucket.account_label,
            symbol=None,
            strategy_id=bucket.hypothesis_id,
            runtime_key=runtime_key,
        )
    )
    account_label = bucket.account_label or "unknown"
    accounts = {spec.account_key: spec for spec in account_specs}
    control = accounts[f"evidence_control:{account_label}:usd"]
    runtime_account = accounts[f"runtime_ledger:{account_label}:{runtime_key}"]
    pnl_direction = PNL_DIRECTION_PROFIT if amount_source > 0 else PNL_DIRECTION_LOSS
    debit = control if pnl_direction == PNL_DIRECTION_PROFIT else runtime_account
    credit = runtime_account if pnl_direction == PNL_DIRECTION_PROFIT else control
    return TigerBeetleRuntimeLedgerTransferPlan(
        account_specs=account_specs,
        transfer_spec=source_transfer_spec(
            transfer_id=runtime_ledger_transfer_id(bucket),
            transfer_kind=TRANSFER_KIND_RUNTIME_NET_PNL,
            amount=amount,
            debit=debit,
            credit=credit,
        ),
        amount_source=amount_source,
        signed_amount_micros=amount if amount_source > 0 else -amount,
        pnl_direction=pnl_direction,
        runtime_key=runtime_key,
    )


def build_execution_transfer_plan(
    execution: Execution,
) -> TigerBeetleSourceTransferPlan | None:
    amount_source = execution_notional_usd(execution)
    amount = _amount_to_micros(amount_source)
    if amount is None or amount_source is None:
        return None
    strategy_id = (
        str(execution.trade_decision_id) if execution.trade_decision_id else None
    )
    account_specs = tuple(
        evidence_account_specs(
            account_label=execution.alpaca_account_label,
            symbol=execution.symbol,
            strategy_id=strategy_id,
        )
    )
    accounts = {spec.account_key: spec for spec in account_specs}
    control = accounts[f"evidence_control:{execution.alpaca_account_label}:usd"]
    execution_account = accounts[
        f"execution_evidence:{execution.alpaca_account_label}:{execution.symbol}:{strategy_id or 'unknown'}"
    ]
    return TigerBeetleSourceTransferPlan(
        account_specs=account_specs,
        transfer_spec=source_transfer_spec(
            transfer_id=execution_transfer_id(execution),
            transfer_kind=TRANSFER_KIND_EXECUTION_FILL,
            amount=amount,
            debit=control,
            credit=execution_account,
        ),
        amount_source=amount_source,
    )


def build_execution_tca_metric_transfer_plan(
    metric: ExecutionTCAMetric,
) -> TigerBeetleSourceTransferPlan | None:
    amount_source = metric.shortfall_notional
    amount = _amount_to_micros(amount_source)
    if amount is None or amount_source is None:
        return None
    strategy_id = str(metric.strategy_id) if metric.strategy_id else None
    account_specs = tuple(
        evidence_account_specs(
            account_label=metric.alpaca_account_label,
            symbol=metric.symbol,
            strategy_id=strategy_id,
        )
    )
    account_label = metric.alpaca_account_label or "unknown"
    accounts = {spec.account_key: spec for spec in account_specs}
    control = accounts[f"evidence_control:{account_label}:usd"]
    cost_account = accounts[
        f"execution_cost:{account_label}:{metric.symbol}:{strategy_id or 'unknown'}"
    ]
    return TigerBeetleSourceTransferPlan(
        account_specs=account_specs,
        transfer_spec=source_transfer_spec(
            transfer_id=execution_cost_transfer_id(metric),
            transfer_kind=TRANSFER_KIND_EXECUTION_COST,
            amount=amount,
            debit=control,
            credit=cost_account,
        ),
        amount_source=amount_source,
    )
