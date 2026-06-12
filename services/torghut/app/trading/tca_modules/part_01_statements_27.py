# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportPrivateUsage=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
"""Transaction cost analytics (TCA) derivation for execution rows."""

from __future__ import annotations

import logging
import hashlib
import json
from collections.abc import Collection, Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import ROUND_CEILING, Decimal
from typing import Any, Optional, cast

from sqlalchemy import func, or_, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session, load_only

from ...config import settings
from ...models import Execution, ExecutionTCAMetric, TradeDecision
from ..prices import resolve_execution_reference_price
from ..tigerbeetle_journal import (
    TIGERBEETLE_BLOCKER_JOURNAL_ERROR,
    TIGERBEETLE_BLOCKER_TRANSFER_REF_CONFLICT,
    TigerBeetleLedgerJournal,
)

# ruff: noqa: F401,F403,F405,F811,F821


logger = logging.getLogger(__name__)

ADAPTIVE_LOOKBACK_WINDOW = 24

ADAPTIVE_MIN_SAMPLE_SIZE = 6

ADAPTIVE_DEGRADE_FALLBACK_BPS = Decimal("4")

ADAPTIVE_TARGET_SLIPPAGE_BPS = Decimal("12")

ADAPTIVE_MAX_SLIPPAGE_BPS = Decimal("20")

ADAPTIVE_MAX_SHORTFALL = Decimal("15")

ADAPTIVE_MIN_EXPECTED_SHORTFALL_COVERAGE = Decimal("0.50")

ADAPTIVE_PARTICIPATION_TIGHTEN = Decimal("0.75")

ADAPTIVE_PARTICIPATION_RELAX = Decimal("1.0")

ADAPTIVE_EXECUTION_SLOWDOWN = Decimal("1.40")

ADAPTIVE_EXECUTION_SPEEDUP = Decimal("0.85")

EXECUTION_TCA_COST_LINEAGE_SCHEMA_VERSION = "torghut.execution-tca-cost-lineage.v1"

POST_COST_PNL_BASIS = "realized_strategy_pnl_after_explicit_costs"

_TCA_STATUS_LINEAGE_SAMPLE_DEFAULT_LIMIT = 200

_TCA_STATUS_LINEAGE_SAMPLE_MAX_LIMIT = 1000

_TCA_STATUS_LINEAGE_SAMPLE_TRUNCATED_BLOCKER = (
    "runtime_tca_cost_lineage_sample_truncated"
)

_CENT = Decimal("0.01")

_ALPACA_2026_EQUITY_SEC_FEE_RATE = Decimal("20.60") / Decimal("1000000")

_ALPACA_2026_EQUITY_TAF_RATE_PER_SHARE = Decimal("0.000195")

_ALPACA_2026_EQUITY_TAF_CAP = Decimal("9.79")

_ALPACA_2026_FEE_SCHEDULE_REVISED_ON = "2026-04-01"

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

_EXECUTION_POLICY_HASH_KEYS = (
    "execution_policy_hash",
    "execution_policy_sha256",
    "policy_hash",
)

_EXECUTION_POLICY_PRIMARY_PAYLOAD_KEYS = (
    "execution_policy",
    "execution_policy_context",
)

_EXECUTION_POLICY_ADVISORY_PAYLOAD_KEYS = (
    "execution_advisor",
    "_execution_advice_provenance",
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

_LINEAGE_HASH_KEYS = (
    "lineage_hash",
    "candidate_lineage_hash",
    "replay_lineage_hash",
    "candidate_evaluation_key",
    "replay_data_hash",
    "replay_tape_content_sha256",
    "dataset_snapshot_hash",
    "source_query_digest",
)


@dataclass(frozen=True)
class AdaptiveExecutionPolicyDecision:
    key: str
    symbol: str
    regime_label: str
    sample_size: int
    adaptive_samples: int
    baseline_slippage_bps: Decimal | None
    recent_slippage_bps: Decimal | None
    baseline_shortfall_notional: Decimal | None
    recent_shortfall_notional: Decimal | None
    effect_size_bps: Decimal | None
    degradation_bps: Decimal | None
    expected_shortfall_coverage: Decimal
    expected_shortfall_sample_count: int
    fallback_active: bool
    fallback_reason: str | None
    prefer_limit: bool | None
    participation_rate_scale: Decimal
    execution_seconds_scale: Decimal
    aggressiveness: str
    generated_at: datetime

    @property
    def has_override(self) -> bool:
        return self.prefer_limit is not None

    def as_payload(self) -> dict[str, Any]:
        return {
            "key": self.key,
            "symbol": self.symbol,
            "regime_label": self.regime_label,
            "sample_size": self.sample_size,
            "adaptive_samples": self.adaptive_samples,
            "baseline_slippage_bps": _decimal_str(self.baseline_slippage_bps),
            "recent_slippage_bps": _decimal_str(self.recent_slippage_bps),
            "baseline_shortfall_notional": _decimal_str(
                self.baseline_shortfall_notional
            ),
            "recent_shortfall_notional": _decimal_str(self.recent_shortfall_notional),
            "effect_size_bps": _decimal_str(self.effect_size_bps),
            "degradation_bps": _decimal_str(self.degradation_bps),
            "expected_shortfall_coverage": str(self.expected_shortfall_coverage),
            "expected_shortfall_sample_count": self.expected_shortfall_sample_count,
            "fallback_active": self.fallback_active,
            "fallback_reason": self.fallback_reason,
            "prefer_limit": self.prefer_limit,
            "participation_rate_scale": _decimal_str(self.participation_rate_scale),
            "execution_seconds_scale": _decimal_str(self.execution_seconds_scale),
            "aggressiveness": self.aggressiveness,
            "generated_at": self.generated_at.isoformat(),
        }


@dataclass(frozen=True)
class _AdaptiveWindowSummary:
    sample_size: int
    adaptive_samples: int
    expected_shortfall_sample_count: int
    expected_shortfall_coverage: Decimal
    slippages: list[Decimal]
    shortfalls: list[Decimal]


def upsert_execution_tca_metric(
    session: Session, execution: Execution
) -> ExecutionTCAMetric:
    """Derive deterministic TCA metrics for an execution and upsert a single row."""

    computed_at = datetime.now(timezone.utc)
    decision = _load_trade_decision(session, execution)
    strategy_id = decision.strategy_id if decision is not None else None
    if decision is not None:
        account_label = decision.alpaca_account_label
    else:
        account_label = execution.alpaca_account_label

    arrival_price = _resolve_arrival_price(decision=decision, execution=execution)
    avg_fill_price = _positive_decimal(execution.avg_fill_price)
    filled_qty = _positive_decimal(execution.filled_qty) or Decimal("0")
    signed_qty = _signed_qty(side=execution.side, qty=filled_qty)

    slippage_bps: Decimal | None = None
    shortfall_notional: Decimal | None = None
    realized_shortfall_bps: Decimal | None = None
    if (
        arrival_price is not None
        and avg_fill_price is not None
        and filled_qty > 0
        and signed_qty != 0
    ):
        price_delta = avg_fill_price - arrival_price
        direction = Decimal("1") if signed_qty > 0 else Decimal("-1")
        slippage_bps = (direction * price_delta / arrival_price) * Decimal("10000")
        realized_shortfall_bps = slippage_bps
        shortfall_notional = direction * price_delta * filled_qty
    expected_shortfall_bps_p50, expected_shortfall_bps_p95, simulator_version = (
        _resolve_simulator_expectations(decision)
    )
    divergence_bps: Decimal | None = None
    if realized_shortfall_bps is not None and expected_shortfall_bps_p50 is not None:
        divergence_bps = realized_shortfall_bps - expected_shortfall_bps_p50

    churn_qty, churn_ratio = _derive_churn(
        session=session,
        execution=execution,
        strategy_id=strategy_id,
        account_label=account_label,
        signed_qty=signed_qty,
        filled_qty=filled_qty,
    )
    _repair_execution_tca_cost_lineage(
        execution=execution,
        decision=decision,
        filled_qty=filled_qty,
        avg_fill_price=avg_fill_price,
    )

    existing = session.execute(
        select(ExecutionTCAMetric).where(
            ExecutionTCAMetric.execution_id == execution.id
        )
    ).scalar_one_or_none()
    if existing is None:
        row = ExecutionTCAMetric(
            execution_id=execution.id,
            trade_decision_id=execution.trade_decision_id,
            strategy_id=strategy_id,
            alpaca_account_label=account_label,
            symbol=execution.symbol,
            side=execution.side,
            arrival_price=arrival_price,
            avg_fill_price=avg_fill_price,
            filled_qty=filled_qty,
            signed_qty=signed_qty,
            slippage_bps=slippage_bps,
            shortfall_notional=shortfall_notional,
            expected_shortfall_bps_p50=expected_shortfall_bps_p50,
            expected_shortfall_bps_p95=expected_shortfall_bps_p95,
            realized_shortfall_bps=realized_shortfall_bps,
            divergence_bps=divergence_bps,
            simulator_version=simulator_version,
            churn_qty=churn_qty,
            churn_ratio=churn_ratio,
            computed_at=computed_at,
        )
        session.add(row)
        _journal_tigerbeetle_execution_cost(session, execution, row)
        return row

    existing.trade_decision_id = execution.trade_decision_id
    existing.strategy_id = strategy_id
    existing.alpaca_account_label = account_label
    existing.symbol = execution.symbol
    existing.side = execution.side
    existing.arrival_price = arrival_price
    existing.avg_fill_price = avg_fill_price
    existing.filled_qty = filled_qty
    existing.signed_qty = signed_qty
    existing.slippage_bps = slippage_bps
    existing.shortfall_notional = shortfall_notional
    existing.expected_shortfall_bps_p50 = expected_shortfall_bps_p50
    existing.expected_shortfall_bps_p95 = expected_shortfall_bps_p95
    existing.realized_shortfall_bps = realized_shortfall_bps
    existing.divergence_bps = divergence_bps
    existing.simulator_version = simulator_version
    existing.churn_qty = churn_qty
    existing.churn_ratio = churn_ratio
    existing.computed_at = computed_at
    session.add(existing)
    _journal_tigerbeetle_execution_cost(session, execution, existing)
    return existing


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

    audit_payload = _mapping_from_any(execution.execution_audit_json)
    raw_order_payload = _mapping_from_any(execution.raw_order)
    decision_payload = _mapping_from_any(decision.decision_json if decision else None)
    source_payloads = _lineage_source_payloads(
        raw_order_payload,
        audit_payload,
        decision_payload,
    )
    blockers: list[str] = []
    source_fields: dict[str, object] = {}

    filled_notional: Decimal | None = None
    if filled_qty > 0 and avg_fill_price is not None and avg_fill_price > 0:
        filled_notional = filled_qty * avg_fill_price
        source_fields["filled_notional"] = [
            "executions.filled_qty",
            "executions.avg_fill_price",
        ]
    else:
        blockers.append("filled_notional_missing")

    cost_amount, cost_basis, cost_source_field = _resolve_explicit_cost(
        source_payloads,
        execution=execution,
        filled_qty=filled_qty,
        filled_notional=filled_notional,
    )
    if cost_amount is None:
        blockers.append("explicit_cost_missing")
    elif cost_basis is None:
        blockers.append("cost_basis_missing")
    else:
        source_fields["explicit_cost"] = cost_source_field

    execution_policy_hashes = _execution_policy_hash_candidates(
        source_payloads=source_payloads,
        decision=decision,
        decision_payload=decision_payload,
        execution=execution,
        source_fields=source_fields,
    )
    if len(execution_policy_hashes) == 0:
        blockers.append("execution_policy_hash_missing")
    elif len(execution_policy_hashes) > 1:
        blockers.append("execution_policy_hash_ambiguous")
    execution_policy_hash = (
        next(iter(execution_policy_hashes))
        if len(execution_policy_hashes) == 1
        else None
    )

    cost_model_hashes = _hash_candidates(
        source_payloads,
        hash_keys=_COST_MODEL_HASH_KEYS,
        payload_keys=_COST_MODEL_PAYLOAD_KEYS,
    )
    if len(cost_model_hashes) == 0 and _cost_basis_is_alpaca_fee_schedule(cost_basis):
        cost_model_hashes.add(_alpaca_2026_equity_fee_schedule_hash())
    if (
        len(cost_model_hashes) == 0
        and cost_amount is not None
        and cost_basis is not None
        and cost_source_field is not None
    ):
        cost_model_hashes.add(
            _stable_payload_digest(
                {
                    "cost_basis": cost_basis,
                    "kind": "explicit_cost_source",
                    "source_field": cost_source_field,
                }
            )
        )
    if len(cost_model_hashes) == 0:
        blockers.append("cost_model_hash_missing")
    elif len(cost_model_hashes) > 1:
        blockers.append("cost_model_hash_ambiguous")
    cost_model_hash = (
        next(iter(cost_model_hashes)) if len(cost_model_hashes) == 1 else None
    )

    lineage_hash = _resolve_lineage_hash(
        source_payloads=source_payloads,
        execution=execution,
        decision=decision,
    )
    blockers = _dedupe_texts(blockers)
    source_backed = not blockers
    lineage_payload: dict[str, object] = {
        "schema_version": EXECUTION_TCA_COST_LINEAGE_SCHEMA_VERSION,
        "status": "source_backed" if source_backed else "blocked",
        "source_backed": source_backed,
        "promotion_authority": False,
        "promotion_authority_reason": "lineage_dimension_only_not_promotion_authority",
        "blockers": blockers,
        "pnl_basis": POST_COST_PNL_BASIS,
        "filled_notional": str(filled_notional)
        if filled_notional is not None
        else None,
        "filled_notional_basis": "execution_filled_qty_x_avg_fill_price"
        if filled_notional is not None
        else None,
        "explicit_cost_amount": str(cost_amount) if cost_amount is not None else None,
        "cost_basis": cost_basis,
        "execution_policy_hash": execution_policy_hash,
        "cost_model_hash": cost_model_hash,
        "lineage_hash": lineage_hash,
        "source_fields": source_fields,
    }

    repaired_audit = dict(audit_payload)
    repaired_audit["runtime_ledger_lineage"] = lineage_payload
    repaired_audit["execution_tca_cost_lineage"] = lineage_payload
    if filled_notional is not None:
        repaired_audit["filled_notional"] = str(filled_notional)
    if cost_amount is not None:
        repaired_audit["cost_amount"] = str(cost_amount)
    if cost_basis is not None:
        repaired_audit["cost_basis"] = cost_basis
    if execution_policy_hash is not None:
        repaired_audit["execution_policy_hash"] = execution_policy_hash
    if cost_model_hash is not None:
        repaired_audit["cost_model_hash"] = cost_model_hash
    repaired_audit["lineage_hash"] = lineage_hash
    repaired_audit["pnl_basis"] = POST_COST_PNL_BASIS
    execution.execution_audit_json = repaired_audit
    return lineage_payload


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
            amount = _non_negative_decimal(payload.get(key))
            if amount is None:
                continue
            basis = _text_from_payload(payload, *_COST_BASIS_KEYS)
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
            return amount, basis, "alpaca_2026_equity_fee_schedule"
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
    normalized_side = str(execution.side or "").strip().lower().replace("-", "_")
    if normalized_side in {"buy", "buy_to_cover", "cover"}:
        return Decimal("0"), "alpaca_2026_equity_zero_commission_and_cat_fee_schedule"
    if normalized_side not in {"sell", "sell_short", "short"}:
        return None
    sec_fee = _decimal_ceil_cent(filled_notional * _ALPACA_2026_EQUITY_SEC_FEE_RATE)
    taf_fee = min(
        _decimal_ceil_cent(filled_qty * _ALPACA_2026_EQUITY_TAF_RATE_PER_SHARE),
        _ALPACA_2026_EQUITY_TAF_CAP,
    )
    return sec_fee + taf_fee, "alpaca_2026_equity_sec_taf_cat_fee_schedule"


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


def _decimal_ceil_cent(value: Decimal) -> Decimal:
    if value <= 0:
        return Decimal("0")
    return value.quantize(_CENT, rounding=ROUND_CEILING)


def _alpaca_2026_equity_fee_schedule_hash() -> str:
    return _stable_payload_digest(
        {
            "broker": "alpaca",
            "asset_class": "us_equity",
            "schedule": "alpaca_brokerage_fee_schedule",
            "revised_on": _ALPACA_2026_FEE_SCHEDULE_REVISED_ON,
            "sec_fee_rate_per_notional": str(_ALPACA_2026_EQUITY_SEC_FEE_RATE),
            "taf_rate_per_share": str(_ALPACA_2026_EQUITY_TAF_RATE_PER_SHARE),
            "taf_cap": str(_ALPACA_2026_EQUITY_TAF_CAP),
            "cat_fee_equities": "0",
            "commission": "0",
        }
    )


def _cost_basis_is_alpaca_fee_schedule(value: object) -> bool:
    return str(value or "").strip().startswith("alpaca_2026_equity_")


def _decision_execution_policy_hash(
    *,
    decision: TradeDecision | None,
    decision_payload: Mapping[str, object],
    execution: Execution,
) -> str | None:
    if decision is None:
        return None
    action = (
        _text_from_payload(decision_payload, "action")
        or str(execution.side or "").strip()
    )
    order_type = (
        _text_from_payload(decision_payload, "order_type")
        or str(execution.order_type or "").strip()
    )
    time_in_force = (
        _text_from_payload(decision_payload, "time_in_force")
        or str(execution.time_in_force or "").strip()
    )
    if not action or not order_type or not time_in_force:
        return None
    policy_payload = {
        "source": "trade_decision_execution_policy",
        "decision_hash": decision.decision_hash,
        "strategy_id": str(decision.strategy_id) if decision.strategy_id else None,
        "symbol": decision.symbol or execution.symbol,
        "action": action,
        "order_type": order_type,
        "time_in_force": time_in_force,
        "limit_price": _text_from_payload(decision_payload, "limit_price"),
        "stop_price": _text_from_payload(decision_payload, "stop_price"),
        "submission_stage": _text_from_payload(decision_payload, "submission_stage"),
    }
    return _stable_payload_digest(
        {key: value for key, value in policy_payload.items() if value is not None}
    )


__all__ = [name for name in globals() if not name.startswith("__")]
