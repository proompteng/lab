"""Transaction cost analytics (TCA) derivation for execution rows."""

from __future__ import annotations

from collections.abc import Collection, Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from typing import cast
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from ...config import settings
from ...models import Execution, ExecutionTCAMetric, TradeDecision
from ..economic_policy import (
    alpaca_equity_fee_schedule_cost,
    alpaca_equity_fee_schedule_hash,
    load_effective_economic_policy,
)
from .adaptive_policy import (
    ExecutionChurnContext,
    derive_execution_churn,
    load_trade_decision_for_execution,
    positive_decimal,
    resolve_arrival_price,
    resolve_simulator_expectations,
    signed_execution_quantity,
)
from .lineage_hashes import (
    dedupe_texts,
    execution_policy_hash_candidates,
    hash_candidates,
    non_negative_decimal,
    resolve_lineage_hash,
    stable_payload_digest,
    text_from_payload,
)
from .lineage_read_model import journal_tigerbeetle_execution_cost

EXECUTION_TCA_COST_LINEAGE_SCHEMA_VERSION = "torghut.execution-tca-cost-lineage.v1"

POST_COST_PNL_BASIS = "realized_strategy_pnl_after_explicit_costs"

_EXPLICIT_COST_AMOUNT_KEYS = (
    "cost_amount",
    "explicit_cost",
    "explicit_cost_amount",
    "commission",
    "fees",
    "fee_amount",
    "broker_fee",
    "total_fees",
    "total_fee_amount",
)

_COST_BASIS_KEYS = (
    "cost_basis",
    "cost_source",
    "fee_basis",
    "commission_basis",
    "broker_fee_basis",
)

_COST_MODEL_HASH_KEYS = (
    "cost_model_hash",
    "fee_model_hash",
    "cost_model_sha256",
)

_COST_MODEL_PAYLOAD_KEYS = (
    "cost_model",
    "cost_model_config",
    "transaction_cost_model",
    "fee_model",
    "fees_model",
)


@dataclass(frozen=True)
class _ExecutionTcaContext:
    computed_at: datetime
    decision: TradeDecision | None
    strategy_id: UUID | None
    account_label: str | None


@dataclass(frozen=True)
class _ExecutionTcaValues:
    arrival_price: Decimal | None
    avg_fill_price: Decimal | None
    filled_qty: Decimal
    signed_qty: Decimal
    slippage_bps: Decimal | None
    shortfall_notional: Decimal | None
    expected_shortfall_bps_p50: Decimal | None
    expected_shortfall_bps_p95: Decimal | None
    realized_shortfall_bps: Decimal | None
    divergence_bps: Decimal | None
    simulator_version: str | None
    churn_qty: Decimal
    churn_ratio: Decimal | None


@dataclass(frozen=True)
class _ExecutionLineageInputs:
    audit_payload: dict[str, object]
    decision_payload: dict[str, object]
    source_payloads: list[Mapping[str, object]]


@dataclass(frozen=True)
class _ExecutionPolicyHashLineageRequest:
    source_payloads: Collection[Mapping[str, object]]
    decision: TradeDecision | None
    decision_payload: Mapping[str, object]
    execution: Execution
    source_fields: dict[str, object]
    blockers: list[str]


@dataclass(frozen=True)
class _CostModelHashLineageRequest:
    source_payloads: Collection[Mapping[str, object]]
    cost: "_ExplicitCostLineage"
    blockers: list[str]


@dataclass(frozen=True)
class _ExecutionTcaLineagePayloadInput:
    blockers: list[str]
    source_fields: dict[str, object]
    filled_notional: Decimal | None
    cost: "_ExplicitCostLineage"
    execution_policy_hash: str | None
    cost_model_hash: str | None
    lineage_hash: str


@dataclass(frozen=True)
class _ExplicitCostLineage:
    amount: Decimal | None
    basis: str | None
    source_field: str | None


def upsert_execution_tca_metric(
    session: Session, execution: Execution
) -> ExecutionTCAMetric:
    """Derive deterministic TCA metrics for an execution and upsert a single row."""

    context = _load_execution_tca_context(session, execution)
    values = _derive_execution_tca_values(session, execution, context)
    _repair_execution_tca_cost_lineage(
        execution=execution,
        decision=context.decision,
        filled_qty=values.filled_qty,
        avg_fill_price=values.avg_fill_price,
    )
    row = _upsert_execution_tca_row(session, execution, context, values)
    journal_tigerbeetle_execution_cost(session, execution, row)
    return row


def _load_execution_tca_context(
    session: Session,
    execution: Execution,
) -> _ExecutionTcaContext:
    decision = load_trade_decision_for_execution(session, execution)
    strategy_id = decision.strategy_id if decision is not None else None
    account_label = (
        decision.alpaca_account_label
        if decision is not None
        else execution.alpaca_account_label
    )
    return _ExecutionTcaContext(
        computed_at=datetime.now(timezone.utc),
        decision=decision,
        strategy_id=strategy_id,
        account_label=account_label,
    )


def _derive_execution_tca_values(
    session: Session,
    execution: Execution,
    context: _ExecutionTcaContext,
) -> _ExecutionTcaValues:
    arrival_price = resolve_arrival_price(
        decision=context.decision,
        execution=execution,
    )
    avg_fill_price = positive_decimal(execution.avg_fill_price)
    filled_qty = positive_decimal(execution.filled_qty) or Decimal("0")
    signed_qty = signed_execution_quantity(side=execution.side, qty=filled_qty)
    slippage_bps, shortfall_notional, realized_shortfall_bps = _derive_shortfall_values(
        arrival_price=arrival_price,
        avg_fill_price=avg_fill_price,
        filled_qty=filled_qty,
        signed_qty=signed_qty,
    )
    expected_shortfall_bps_p50, expected_shortfall_bps_p95, simulator_version = (
        resolve_simulator_expectations(context.decision)
    )
    churn_qty, churn_ratio = derive_execution_churn(
        ExecutionChurnContext(
            session=session,
            execution=execution,
            strategy_id=context.strategy_id,
            account_label=context.account_label,
            signed_qty=signed_qty,
            filled_qty=filled_qty,
        )
    )
    return _ExecutionTcaValues(
        arrival_price=arrival_price,
        avg_fill_price=avg_fill_price,
        filled_qty=filled_qty,
        signed_qty=signed_qty,
        slippage_bps=slippage_bps,
        shortfall_notional=shortfall_notional,
        expected_shortfall_bps_p50=expected_shortfall_bps_p50,
        expected_shortfall_bps_p95=expected_shortfall_bps_p95,
        realized_shortfall_bps=realized_shortfall_bps,
        divergence_bps=_derive_divergence_bps(
            realized_shortfall_bps=realized_shortfall_bps,
            expected_shortfall_bps_p50=expected_shortfall_bps_p50,
        ),
        simulator_version=simulator_version,
        churn_qty=churn_qty,
        churn_ratio=churn_ratio,
    )


def _derive_shortfall_values(
    *,
    arrival_price: Decimal | None,
    avg_fill_price: Decimal | None,
    filled_qty: Decimal,
    signed_qty: Decimal,
) -> tuple[Decimal | None, Decimal | None, Decimal | None]:
    if (
        arrival_price is None
        or avg_fill_price is None
        or filled_qty <= 0
        or signed_qty == 0
    ):
        return None, None, None
    price_delta = avg_fill_price - arrival_price
    direction = Decimal("1") if signed_qty > 0 else Decimal("-1")
    slippage_bps = (direction * price_delta / arrival_price) * Decimal("10000")
    shortfall_notional = direction * price_delta * filled_qty
    return slippage_bps, shortfall_notional, slippage_bps


def _derive_divergence_bps(
    *,
    realized_shortfall_bps: Decimal | None,
    expected_shortfall_bps_p50: Decimal | None,
) -> Decimal | None:
    if realized_shortfall_bps is None or expected_shortfall_bps_p50 is None:
        return None
    return realized_shortfall_bps - expected_shortfall_bps_p50


def _upsert_execution_tca_row(
    session: Session,
    execution: Execution,
    context: _ExecutionTcaContext,
    values: _ExecutionTcaValues,
) -> ExecutionTCAMetric:
    existing = session.execute(
        select(ExecutionTCAMetric).where(
            ExecutionTCAMetric.execution_id == execution.id
        )
    ).scalar_one_or_none()
    if existing is None:
        row = ExecutionTCAMetric(
            execution_id=execution.id,
        )
        session.add(row)
    else:
        row = existing
    _apply_execution_tca_values(row, execution, context, values)
    session.add(row)
    return row


def _apply_execution_tca_values(
    row: ExecutionTCAMetric,
    execution: Execution,
    context: _ExecutionTcaContext,
    values: _ExecutionTcaValues,
) -> None:
    row.trade_decision_id = execution.trade_decision_id
    row.strategy_id = context.strategy_id
    row.alpaca_account_label = context.account_label
    row.symbol = execution.symbol
    row.side = execution.side
    row.arrival_price = values.arrival_price
    row.avg_fill_price = values.avg_fill_price
    row.filled_qty = values.filled_qty
    row.signed_qty = values.signed_qty
    row.slippage_bps = values.slippage_bps
    row.shortfall_notional = values.shortfall_notional
    row.expected_shortfall_bps_p50 = values.expected_shortfall_bps_p50
    row.expected_shortfall_bps_p95 = values.expected_shortfall_bps_p95
    row.realized_shortfall_bps = values.realized_shortfall_bps
    row.divergence_bps = values.divergence_bps
    row.simulator_version = values.simulator_version
    row.churn_qty = values.churn_qty
    row.churn_ratio = values.churn_ratio
    row.computed_at = context.computed_at


def _repair_execution_tca_cost_lineage(
    *,
    execution: Execution,
    decision: TradeDecision | None,
    filled_qty: Decimal,
    avg_fill_price: Decimal | None,
) -> dict[str, object]:
    """Attach deterministic runtime-ledger cost lineage to execution audit JSON.

    The repair is intentionally conservative: it computes filled notional only
    from persisted fill quantity and average fill price, accepts explicit costs
    only from persisted execution/order payload fields, and records missing or
    ambiguous source evidence as blockers instead of fabricating authority.
    """

    lineage_inputs = _execution_lineage_inputs(execution=execution, decision=decision)
    blockers: list[str] = []
    source_fields: dict[str, object] = {}
    filled_notional = _resolve_filled_notional_lineage(
        filled_qty=filled_qty,
        avg_fill_price=avg_fill_price,
        blockers=blockers,
        source_fields=source_fields,
    )

    cost = _resolve_explicit_cost_lineage(
        lineage_inputs.source_payloads,
        execution=execution,
        filled_qty=filled_qty,
        filled_notional=filled_notional,
    )
    _record_explicit_cost_lineage(
        cost=cost,
        blockers=blockers,
        source_fields=source_fields,
    )
    execution_policy_hash = _resolve_execution_policy_hash_lineage(
        _ExecutionPolicyHashLineageRequest(
            source_payloads=lineage_inputs.source_payloads,
            decision=decision,
            decision_payload=lineage_inputs.decision_payload,
            execution=execution,
            source_fields=source_fields,
            blockers=blockers,
        )
    )
    cost_model_hash = _resolve_cost_model_hash_lineage(
        _CostModelHashLineageRequest(
            source_payloads=lineage_inputs.source_payloads,
            cost=cost,
            blockers=blockers,
        )
    )
    lineage_hash = resolve_lineage_hash(
        source_payloads=lineage_inputs.source_payloads,
        execution=execution,
        decision=decision,
    )
    blockers = dedupe_texts(blockers)
    payload_input = _ExecutionTcaLineagePayloadInput(
        blockers=blockers,
        source_fields=source_fields,
        filled_notional=filled_notional,
        cost=cost,
        execution_policy_hash=execution_policy_hash,
        cost_model_hash=cost_model_hash,
        lineage_hash=lineage_hash,
    )
    lineage_payload = _build_execution_tca_lineage_payload(payload_input)
    _store_execution_tca_lineage_payload(
        execution=execution,
        audit_payload=lineage_inputs.audit_payload,
        lineage_payload=lineage_payload,
        payload_input=payload_input,
    )
    return lineage_payload


def _execution_lineage_inputs(
    *,
    execution: Execution,
    decision: TradeDecision | None,
) -> _ExecutionLineageInputs:
    audit_payload = _mapping_from_any(execution.execution_audit_json)
    raw_order_payload = _mapping_from_any(execution.raw_order)
    decision_payload = _mapping_from_any(decision.decision_json if decision else None)
    return _ExecutionLineageInputs(
        audit_payload=audit_payload,
        decision_payload=decision_payload,
        source_payloads=_lineage_source_payloads(
            raw_order_payload,
            audit_payload,
            decision_payload,
        ),
    )


def _resolve_filled_notional_lineage(
    *,
    filled_qty: Decimal,
    avg_fill_price: Decimal | None,
    blockers: list[str],
    source_fields: dict[str, object],
) -> Decimal | None:
    if filled_qty <= 0 or avg_fill_price is None or avg_fill_price <= 0:
        blockers.append("filled_notional_missing")
        return None
    source_fields["filled_notional"] = [
        "executions.filled_qty",
        "executions.avg_fill_price",
    ]
    return filled_qty * avg_fill_price


def _record_explicit_cost_lineage(
    *,
    cost: _ExplicitCostLineage,
    blockers: list[str],
    source_fields: dict[str, object],
) -> None:
    if cost.amount is None:
        blockers.append("explicit_cost_missing")
    elif cost.basis is None:
        blockers.append("cost_basis_missing")
    else:
        source_fields["explicit_cost"] = cost.source_field


def _resolve_explicit_cost_lineage(
    payloads: Collection[Mapping[str, object]],
    *,
    execution: Execution,
    filled_qty: Decimal,
    filled_notional: Decimal | None,
) -> _ExplicitCostLineage:
    amount, basis, source_field = _resolve_explicit_cost(
        payloads,
        execution=execution,
        filled_qty=filled_qty,
        filled_notional=filled_notional,
    )
    return _ExplicitCostLineage(
        amount=amount,
        basis=basis,
        source_field=source_field,
    )


def _resolve_execution_policy_hash_lineage(
    request: _ExecutionPolicyHashLineageRequest,
) -> str | None:
    hashes = execution_policy_hash_candidates(
        source_payloads=request.source_payloads,
        decision=request.decision,
        decision_payload=request.decision_payload,
        execution=request.execution,
        source_fields=request.source_fields,
    )
    return _single_lineage_hash(
        hashes,
        missing_blocker="execution_policy_hash_missing",
        ambiguous_blocker="execution_policy_hash_ambiguous",
        blockers=request.blockers,
    )


def _resolve_cost_model_hash_lineage(
    request: _CostModelHashLineageRequest,
) -> str | None:
    hashes = hash_candidates(
        request.source_payloads,
        hash_keys=_COST_MODEL_HASH_KEYS,
        payload_keys=_COST_MODEL_PAYLOAD_KEYS,
    )
    if not hashes and _cost_basis_is_alpaca_fee_schedule(request.cost.basis):
        hashes.add(_alpaca_2026_equity_fee_schedule_hash())
    if not hashes:
        _add_explicit_cost_source_hash(
            hashes,
            cost_amount=request.cost.amount,
            cost_basis=request.cost.basis,
            cost_source_field=request.cost.source_field,
        )
    return _single_lineage_hash(
        hashes,
        missing_blocker="cost_model_hash_missing",
        ambiguous_blocker="cost_model_hash_ambiguous",
        blockers=request.blockers,
    )


def _add_explicit_cost_source_hash(
    hashes: set[str],
    *,
    cost_amount: Decimal | None,
    cost_basis: str | None,
    cost_source_field: str | None,
) -> None:
    if cost_amount is None or cost_basis is None or cost_source_field is None:
        return
    hashes.add(
        stable_payload_digest(
            {
                "cost_basis": cost_basis,
                "kind": "explicit_cost_source",
                "source_field": cost_source_field,
            }
        )
    )


def _single_lineage_hash(
    hashes: set[str],
    *,
    missing_blocker: str,
    ambiguous_blocker: str,
    blockers: list[str],
) -> str | None:
    if len(hashes) == 0:
        blockers.append(missing_blocker)
        return None
    if len(hashes) > 1:
        blockers.append(ambiguous_blocker)
        return None
    return next(iter(hashes))


def _build_execution_tca_lineage_payload(
    payload_input: _ExecutionTcaLineagePayloadInput,
) -> dict[str, object]:
    source_backed = not payload_input.blockers
    return {
        "schema_version": EXECUTION_TCA_COST_LINEAGE_SCHEMA_VERSION,
        "status": "source_backed" if source_backed else "blocked",
        "source_backed": source_backed,
        "promotion_authority": False,
        "promotion_authority_reason": "lineage_dimension_only_not_promotion_authority",
        "blockers": payload_input.blockers,
        "pnl_basis": POST_COST_PNL_BASIS,
        "filled_notional": str(payload_input.filled_notional)
        if payload_input.filled_notional is not None
        else None,
        "filled_notional_basis": "execution_filled_qty_x_avg_fill_price"
        if payload_input.filled_notional is not None
        else None,
        "explicit_cost_amount": str(payload_input.cost.amount)
        if payload_input.cost.amount is not None
        else None,
        "cost_basis": payload_input.cost.basis,
        "execution_policy_hash": payload_input.execution_policy_hash,
        "cost_model_hash": payload_input.cost_model_hash,
        "lineage_hash": payload_input.lineage_hash,
        "source_fields": payload_input.source_fields,
    }


def _store_execution_tca_lineage_payload(
    *,
    execution: Execution,
    audit_payload: Mapping[str, object],
    lineage_payload: dict[str, object],
    payload_input: _ExecutionTcaLineagePayloadInput,
) -> None:
    repaired_audit = dict(audit_payload)
    repaired_audit["runtime_ledger_lineage"] = lineage_payload
    repaired_audit["execution_tca_cost_lineage"] = lineage_payload
    if payload_input.filled_notional is not None:
        repaired_audit["filled_notional"] = str(payload_input.filled_notional)
    if payload_input.cost.amount is not None:
        repaired_audit["cost_amount"] = str(payload_input.cost.amount)
    if payload_input.cost.basis is not None:
        repaired_audit["cost_basis"] = payload_input.cost.basis
    if payload_input.execution_policy_hash is not None:
        repaired_audit["execution_policy_hash"] = payload_input.execution_policy_hash
    if payload_input.cost_model_hash is not None:
        repaired_audit["cost_model_hash"] = payload_input.cost_model_hash
    repaired_audit["lineage_hash"] = payload_input.lineage_hash
    repaired_audit["pnl_basis"] = POST_COST_PNL_BASIS
    execution.execution_audit_json = repaired_audit


def _mapping_from_any(value: object | None) -> dict[str, object]:
    if not isinstance(value, Mapping):
        return {}
    mapping = cast(Mapping[object, object], value)
    return {str(key): item for key, item in mapping.items()}


def _lineage_source_payloads(
    *values: Mapping[str, object],
) -> list[Mapping[str, object]]:
    payloads: list[Mapping[str, object]] = []

    def append_payload(value: object, *, depth: int) -> None:
        if not isinstance(value, Mapping):
            return
        mapping = cast(Mapping[object, object], value)
        payload = {str(item_key): item for item_key, item in mapping.items()}
        payloads.append(payload)
        if depth <= 0:
            return
        for item_key, nested in payload.items():
            if str(item_key) == "source_fields":
                continue
            if isinstance(nested, Mapping):
                append_payload(cast(Mapping[object, object], nested), depth=depth - 1)

    for value in values:
        append_payload(value, depth=4)
    return payloads


def _resolve_explicit_cost(
    payloads: Collection[Mapping[str, object]],
    *,
    execution: Execution,
    filled_qty: Decimal,
    filled_notional: Decimal | None,
) -> tuple[Decimal | None, str | None, str | None]:
    missing_basis_candidate: tuple[Decimal, str] | None = None
    for payload in payloads:
        for key in _EXPLICIT_COST_AMOUNT_KEYS:
            amount = non_negative_decimal(payload.get(key))
            if amount is None:
                continue
            basis = text_from_payload(payload, *_COST_BASIS_KEYS)
            if basis is None:
                basis = _default_cost_basis_for_field(key)
            if basis is None:
                missing_basis_candidate = (amount, key)
                continue
            return amount, basis, key
    if missing_basis_candidate is not None:
        amount, key = missing_basis_candidate
        return amount, None, key
    if filled_notional is not None:
        fee_schedule_cost = _alpaca_2026_equity_fee_schedule_cost(
            payloads,
            execution=execution,
            filled_qty=filled_qty,
            filled_notional=filled_notional,
        )
        if fee_schedule_cost is not None:
            amount, basis = fee_schedule_cost
            return amount, basis, "modeled_alpaca_2026_equity_fee_schedule"
    return None, None, None


def _default_cost_basis_for_field(key: str) -> str | None:
    normalized = key.strip().lower()
    if normalized == "commission":
        return "broker_reported_commission"
    if normalized in {
        "fees",
        "fee_amount",
        "broker_fee",
        "total_fees",
        "total_fee_amount",
    }:
        return "broker_reported_fees"
    return None


def _alpaca_2026_equity_fee_schedule_cost(
    payloads: Collection[Mapping[str, object]],
    *,
    execution: Execution,
    filled_qty: Decimal,
    filled_notional: Decimal,
) -> tuple[Decimal, str] | None:
    if filled_qty <= 0 or filled_notional <= 0:
        return None
    if not _has_alpaca_us_equity_source(payloads, execution=execution):
        return None
    return alpaca_equity_fee_schedule_cost(
        side=execution.side,
        filled_qty=filled_qty,
        filled_notional=filled_notional,
        policy=load_effective_economic_policy(settings),
    )


def _has_alpaca_us_equity_source(
    payloads: Collection[Mapping[str, object]], *, execution: Execution
) -> bool:
    source_markers = {
        str(item or "").strip().lower()
        for item in (
            execution.execution_expected_adapter,
            execution.execution_actual_adapter,
            execution.alpaca_account_label,
        )
        if str(item or "").strip()
    }
    asset_classes: set[str] = set()
    for payload in payloads:
        for key in (
            "feed",
            "source_topic",
            "channel",
            "submit_path",
            "source",
            "adapter",
            "execution_adapter",
            "_execution_adapter",
        ):
            text = str(payload.get(key) or "").strip().lower()
            if text:
                source_markers.add(text)
        asset_class = (
            str(payload.get("asset_class") or "").strip().lower().replace("-", "_")
        )
        if asset_class:
            asset_classes.add(asset_class)
    if not any(
        "alpaca" in marker or marker == "trade_updates" for marker in source_markers
    ):
        return False
    return any(
        item in {"us_equity", "us_equities", "equity", "equities"}
        for item in asset_classes
    )


def _alpaca_2026_equity_fee_schedule_hash() -> str:
    return alpaca_equity_fee_schedule_hash(
        policy=load_effective_economic_policy(settings)
    )


def _cost_basis_is_alpaca_fee_schedule(value: object) -> bool:
    normalized = str(value or "").strip()
    return normalized.startswith(("alpaca_2026_equity_", "modeled_alpaca_2026_equity_"))


__all__ = [
    "EXECUTION_TCA_COST_LINEAGE_SCHEMA_VERSION",
    "POST_COST_PNL_BASIS",
    "upsert_execution_tca_metric",
]
