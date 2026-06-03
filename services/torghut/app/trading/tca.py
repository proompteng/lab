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

from ..config import settings
from ..models import Execution, ExecutionTCAMetric, TradeDecision
from .prices import resolve_execution_reference_price
from .tigerbeetle_journal import (
    TIGERBEETLE_BLOCKER_JOURNAL_ERROR,
    TIGERBEETLE_BLOCKER_TRANSFER_REF_CONFLICT,
    TigerBeetleLedgerJournal,
)

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
_EXECUTION_POLICY_PAYLOAD_KEYS = (
    "execution_policy",
    "execution_policy_context",
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

    execution_policy_hashes = _hash_candidates(
        source_payloads,
        hash_keys=_EXECUTION_POLICY_HASH_KEYS,
        payload_keys=_EXECUTION_POLICY_PAYLOAD_KEYS,
    )
    if len(execution_policy_hashes) == 0:
        decision_policy_hash = _decision_execution_policy_hash(
            decision=decision,
            decision_payload=decision_payload,
            execution=execution,
        )
        if decision_policy_hash is not None:
            execution_policy_hashes.add(decision_policy_hash)
            source_fields["execution_policy_hash"] = (
                "trade_decisions.decision_json+executions.order_fields"
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
        for nested in payload.values():
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


def _hash_candidates(
    payloads: Collection[Mapping[str, object]],
    *,
    hash_keys: Collection[str],
    payload_keys: Collection[str],
) -> set[str]:
    candidates: set[str] = set()
    for payload in payloads:
        for key in hash_keys:
            text = _text_from_payload(payload, key)
            if text is not None:
                candidates.add(text)
        for key in payload_keys:
            value = payload.get(key)
            if value is not None and (digest := _stable_payload_digest(value)):
                candidates.add(digest)
    return candidates


def _resolve_lineage_hash(
    *,
    source_payloads: Collection[Mapping[str, object]],
    execution: Execution,
    decision: TradeDecision | None,
) -> str:
    explicit_hashes = _hash_candidates(
        source_payloads,
        hash_keys=_LINEAGE_HASH_KEYS,
        payload_keys=("lineage", "candidate_lineage", "source_lineage"),
    )
    if len(explicit_hashes) == 1:
        return next(iter(explicit_hashes))
    return _stable_payload_digest(
        {
            "alpaca_account_label": execution.alpaca_account_label,
            "alpaca_order_id": execution.alpaca_order_id,
            "client_order_id": execution.client_order_id,
            "decision_hash": decision.decision_hash if decision is not None else None,
            "execution_id": str(execution.id),
            "trade_decision_id": str(execution.trade_decision_id)
            if execution.trade_decision_id
            else None,
        }
    )


def _stable_payload_digest(value: object) -> str:
    body = json.dumps(value, default=str, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(body.encode("utf-8")).hexdigest()


def _text_from_payload(payload: Mapping[str, object], *keys: str) -> str | None:
    for key in keys:
        text = str(payload.get(key) or "").strip()
        if text:
            return text
    return None


def _non_negative_decimal(value: object | None) -> Decimal | None:
    parsed = _decimal_or_none(value)
    if parsed is None or parsed < 0:
        return None
    return parsed


def _dedupe_texts(values: Collection[str]) -> list[str]:
    deduped: list[str] = []
    for value in values:
        text = value.strip()
        if text and text not in deduped:
            deduped.append(text)
    return deduped


def _journal_tigerbeetle_execution_cost(
    session: Session,
    execution: Execution,
    metric: ExecutionTCAMetric,
) -> None:
    if not settings.tigerbeetle_enabled or not settings.tigerbeetle_journal_enabled:
        return
    session.flush()
    try:
        with TigerBeetleLedgerJournal() as journal, session.begin_nested():
            journal.journal_execution(session, execution)
            journal.journal_execution_tca_metric(session, metric)
    except Exception as exc:
        if settings.tigerbeetle_required:
            raise
        blocker = (
            TIGERBEETLE_BLOCKER_TRANSFER_REF_CONFLICT
            if TIGERBEETLE_BLOCKER_TRANSFER_REF_CONFLICT in str(exc)
            else TIGERBEETLE_BLOCKER_JOURNAL_ERROR
        )
        logger.warning(
            "TigerBeetle execution/TCA journal failed for execution_id=%s metric_id=%s blocker=%s: %s",
            execution.id,
            metric.id,
            blocker,
            exc,
            extra={
                "tigerbeetle_execution_cost_journal_status": "blocked",
                "tigerbeetle_execution_cost_journal_blocker": blocker,
                "tigerbeetle_execution_id": str(execution.id),
                "tigerbeetle_execution_tca_metric_id": str(metric.id),
            },
        )


def refresh_execution_tca_metrics(
    session: Session,
    *,
    account_label: str | None = None,
    stale_before: datetime | None = None,
    limit: int = 500,
    dry_run: bool = False,
) -> dict[str, object]:
    """Refresh materialized TCA rows for filled executions.

    This is intentionally bounded. Revenue-readiness gates consume the
    materialized ``execution_tca_metrics`` table, so code-level TCA fixes do not
    affect promotion evidence until stale rows are rematerialized.
    """

    bounded_limit = max(1, min(limit, 5000))
    stmt = (
        select(Execution)
        .outerjoin(ExecutionTCAMetric, ExecutionTCAMetric.execution_id == Execution.id)
        .where(
            Execution.avg_fill_price.is_not(None),
            Execution.filled_qty > 0,
        )
        .order_by(
            ExecutionTCAMetric.computed_at.asc().nullsfirst(),
            Execution.created_at.asc(),
        )
        .limit(bounded_limit)
    )
    normalized_account_label = account_label.strip() if account_label else ""
    if normalized_account_label:
        stmt = stmt.where(Execution.alpaca_account_label == normalized_account_label)
    if stale_before is not None:
        stmt = stmt.where(
            or_(
                ExecutionTCAMetric.id.is_(None),
                ExecutionTCAMetric.computed_at < stale_before,
            )
        )

    executions = session.execute(stmt).scalars().all()
    if dry_run:
        return {
            "selected": len(executions),
            "refreshed": 0,
            "dry_run": True,
            "limit": bounded_limit,
            "account_label": normalized_account_label or None,
            "stale_before": stale_before.isoformat() if stale_before else None,
            "runtime_ledger_lineage": _execution_lineage_summary(executions),
        }

    refreshed = 0
    for execution in executions:
        upsert_execution_tca_metric(session, execution)
        refreshed += 1

    lineage_summary = _execution_lineage_summary(executions)
    return {
        "selected": len(executions),
        "refreshed": refreshed,
        "dry_run": False,
        "limit": bounded_limit,
        "account_label": normalized_account_label or None,
        "stale_before": stale_before.isoformat() if stale_before else None,
        "runtime_ledger_lineage": lineage_summary,
    }


def build_tca_gate_inputs(
    session: Session,
    *,
    strategy_id: str | None = None,
    account_label: str | None = None,
    symbols: Collection[str] | None = None,
) -> dict[str, object]:
    """Build aggregate TCA inputs used by autonomy gate thresholds."""

    normalized_symbols = _normalize_tca_symbols(symbols)
    stmt = select(
        func.count(ExecutionTCAMetric.id),
        func.avg(ExecutionTCAMetric.slippage_bps),
        func.avg(func.abs(ExecutionTCAMetric.slippage_bps)),
        func.avg(ExecutionTCAMetric.shortfall_notional),
        func.avg(func.abs(ExecutionTCAMetric.shortfall_notional)),
        func.avg(ExecutionTCAMetric.churn_ratio),
        func.avg(ExecutionTCAMetric.divergence_bps),
        func.avg(func.abs(ExecutionTCAMetric.divergence_bps)),
        func.count(ExecutionTCAMetric.expected_shortfall_bps_p50),
        func.avg(ExecutionTCAMetric.expected_shortfall_bps_p50),
        func.avg(ExecutionTCAMetric.expected_shortfall_bps_p95),
        func.avg(ExecutionTCAMetric.realized_shortfall_bps),
        func.avg(func.abs(ExecutionTCAMetric.realized_shortfall_bps)),
        func.avg(
            func.abs(
                ExecutionTCAMetric.realized_shortfall_bps
                - ExecutionTCAMetric.expected_shortfall_bps_p50
            )
        ),
        func.max(ExecutionTCAMetric.computed_at),
    )
    if strategy_id:
        stmt = stmt.where(ExecutionTCAMetric.strategy_id == strategy_id)
    normalized_account_label = account_label.strip() if account_label else ""
    if normalized_account_label:
        stmt = stmt.where(
            ExecutionTCAMetric.alpaca_account_label == normalized_account_label
        )
    if normalized_symbols:
        stmt = stmt.where(ExecutionTCAMetric.symbol.in_(normalized_symbols))

    row = session.execute(stmt).one()
    symbol_breakdown_reason: str | None = None
    try:
        symbol_breakdown = _build_tca_symbol_breakdown(
            session,
            strategy_id=strategy_id,
            account_label=normalized_account_label,
            symbols=normalized_symbols,
        )
    except SQLAlchemyError as exc:
        logger.warning("TCA symbol breakdown unavailable: %s", exc)
        session.rollback()
        symbol_breakdown_reason = "execution_tca_symbol_breakdown_query_unavailable"
        symbol_breakdown = _unavailable_tca_symbol_breakdown(
            symbols=normalized_symbols,
            reason=symbol_breakdown_reason,
        )
    execution_coverage_reason: str | None = None
    try:
        execution_stmt = _tca_execution_coverage_stmt(
            strategy_id=strategy_id,
            account_label=normalized_account_label,
            symbols=normalized_symbols,
        )
        unsettled_execution_stmt = _tca_execution_coverage_stmt(
            strategy_id=strategy_id,
            account_label=normalized_account_label,
            symbols=normalized_symbols,
            only_unsettled=True,
        )
        execution_count, latest_execution_created_at = session.execute(
            execution_stmt
        ).one()
        unsettled_execution_count = int(
            session.execute(unsettled_execution_stmt).scalar_one() or 0
        )
    except SQLAlchemyError as exc:
        logger.warning("TCA execution coverage unavailable: %s", exc)
        session.rollback()
        execution_coverage_reason = "execution_tca_execution_coverage_query_unavailable"
        execution_count = 0
        latest_execution_created_at = None
        unsettled_execution_count = 0
    order_count = int(row[0] or 0)
    avg_slippage = _decimal_or_none(row[1])
    avg_abs_slippage = _decimal_or_none(row[2])
    avg_shortfall = _decimal_or_none(row[3])
    avg_abs_shortfall = _decimal_or_none(row[4])
    avg_churn = _decimal_or_none(row[5])
    avg_divergence = _decimal_or_none(row[6])
    avg_abs_divergence = _decimal_or_none(row[7])
    expected_count = int(row[8] or 0)
    avg_expected_shortfall_p50 = _decimal_or_none(row[9])
    avg_expected_shortfall_p95 = _decimal_or_none(row[10])
    avg_realized_shortfall_bps = _decimal_or_none(row[11])
    avg_abs_realized_shortfall_bps = _decimal_or_none(row[12])
    avg_calibration_error_bps = _decimal_or_none(row[13])
    last_computed_at = row[14]
    expected_shortfall_coverage = (
        Decimal(expected_count) / Decimal(order_count) if order_count > 0 else None
    )
    filled_execution_count = int(execution_count or 0)
    lineage_unavailable_reason = execution_coverage_reason
    if lineage_unavailable_reason is None:
        try:
            runtime_ledger_lineage = _build_tca_runtime_ledger_lineage_summary(
                session,
                strategy_id=strategy_id,
                account_label=normalized_account_label,
                symbols=normalized_symbols,
                total_filled_execution_count=filled_execution_count,
            )
        except SQLAlchemyError as exc:
            logger.warning("TCA runtime ledger lineage unavailable: %s", exc)
            session.rollback()
            lineage_unavailable_reason = "runtime_tca_cost_lineage_query_unavailable"
            runtime_ledger_lineage = _unavailable_tca_runtime_ledger_lineage_summary(
                reason=lineage_unavailable_reason,
                total_filled_execution_count=filled_execution_count,
            )
    else:
        runtime_ledger_lineage = _unavailable_tca_runtime_ledger_lineage_summary(
            reason=lineage_unavailable_reason,
            total_filled_execution_count=None,
        )
    reason_codes = [
        reason
        for reason in (
            symbol_breakdown_reason,
            execution_coverage_reason,
            lineage_unavailable_reason
            if lineage_unavailable_reason != execution_coverage_reason
            else None,
        )
        if reason is not None
    ]
    return {
        "account_label": normalized_account_label or None,
        "scope_symbols": list(normalized_symbols),
        "scope_symbol_count": len(normalized_symbols),
        "order_count": order_count,
        "avg_slippage_bps": avg_slippage if avg_slippage is not None else Decimal("0"),
        "avg_abs_slippage_bps": avg_abs_slippage
        if avg_abs_slippage is not None
        else Decimal("0"),
        "avg_shortfall_notional": avg_shortfall
        if avg_shortfall is not None
        else Decimal("0"),
        "avg_shortfall_notional_abs": avg_abs_shortfall
        if avg_abs_shortfall is not None
        else Decimal("0"),
        "avg_churn_ratio": avg_churn if avg_churn is not None else Decimal("0"),
        "avg_divergence_bps": avg_divergence
        if avg_divergence is not None
        else Decimal("0"),
        "avg_divergence_bps_abs": avg_abs_divergence
        if avg_abs_divergence is not None
        else Decimal("0"),
        "expected_shortfall_sample_count": expected_count,
        "expected_shortfall_coverage": expected_shortfall_coverage,
        "avg_expected_shortfall_bps_p50": avg_expected_shortfall_p50
        if avg_expected_shortfall_p50 is not None
        else Decimal("0"),
        "avg_expected_shortfall_bps_p95": avg_expected_shortfall_p95
        if avg_expected_shortfall_p95 is not None
        else Decimal("0"),
        "avg_realized_shortfall_bps": avg_realized_shortfall_bps
        if avg_realized_shortfall_bps is not None
        else Decimal("0"),
        "avg_realized_shortfall_bps_abs": avg_abs_realized_shortfall_bps
        if avg_abs_realized_shortfall_bps is not None
        else Decimal("0"),
        "avg_calibration_error_bps": avg_calibration_error_bps,
        "last_computed_at": last_computed_at,
        "filled_execution_count": filled_execution_count,
        "latest_execution_created_at": latest_execution_created_at,
        "unsettled_execution_count": unsettled_execution_count,
        "symbol_breakdown": symbol_breakdown,
        "runtime_ledger_lineage": runtime_ledger_lineage,
        "read_model_status": "degraded" if reason_codes else "ok",
        "reason_codes": reason_codes,
    }


def _tca_execution_coverage_stmt(
    *,
    strategy_id: str | None,
    account_label: str,
    symbols: tuple[str, ...],
    only_unsettled: bool = False,
) -> Any:
    if only_unsettled:
        stmt = (
            select(func.count(Execution.id))
            .select_from(Execution)
            .outerjoin(
                ExecutionTCAMetric,
                ExecutionTCAMetric.execution_id == Execution.id,
            )
            .where(ExecutionTCAMetric.id.is_(None))
        )
    else:
        stmt = select(func.count(Execution.id), func.max(Execution.created_at))

    stmt = stmt.where(
        Execution.avg_fill_price.is_not(None),
        Execution.filled_qty > 0,
    )
    if strategy_id:
        stmt = stmt.join(TradeDecision, TradeDecision.id == Execution.trade_decision_id)
        stmt = stmt.where(TradeDecision.strategy_id == strategy_id)
    if account_label:
        stmt = stmt.where(Execution.alpaca_account_label == account_label)
    if symbols:
        stmt = stmt.where(Execution.symbol.in_(symbols))
    return stmt


def _build_tca_runtime_ledger_lineage_summary(
    session: Session,
    *,
    strategy_id: str | None,
    account_label: str,
    symbols: tuple[str, ...],
    total_filled_execution_count: int | None = None,
) -> dict[str, object]:
    sample_limit = _tca_status_lineage_sample_limit()
    stmt = (
        select(Execution)
        .options(
            load_only(
                Execution.id,
                Execution.alpaca_order_id,
                Execution.symbol,
                Execution.execution_audit_json,
            )
        )
        .join(ExecutionTCAMetric, ExecutionTCAMetric.execution_id == Execution.id)
        .where(
            Execution.avg_fill_price.is_not(None),
            Execution.filled_qty > 0,
        )
    )
    if strategy_id:
        stmt = stmt.where(ExecutionTCAMetric.strategy_id == strategy_id)
    if account_label:
        stmt = stmt.where(Execution.alpaca_account_label == account_label)
    if symbols:
        stmt = stmt.where(Execution.symbol.in_(symbols))
    stmt = stmt.order_by(Execution.created_at.desc(), Execution.id.desc()).limit(
        sample_limit + 1
    )
    sampled_executions = list(session.execute(stmt).scalars())
    query_truncated = len(sampled_executions) > sample_limit
    executions = sampled_executions[:sample_limit]
    summary = _execution_lineage_summary(executions)
    sampled_count = len(executions)
    known_total = (
        max(0, int(total_filled_execution_count))
        if total_filled_execution_count is not None
        else None
    )
    known_truncated = known_total is not None and known_total > sampled_count
    truncated = query_truncated or known_truncated
    summary.update(
        {
            "bounded": True,
            "coverage_exact": not truncated,
            "query_limit": sample_limit,
            "sampled_execution_count": sampled_count,
            "truncated": truncated,
        }
    )
    if known_total is not None:
        summary["total_filled_execution_count"] = known_total
    if truncated:
        _mark_tca_lineage_summary_fail_closed(
            summary,
            reason=_TCA_STATUS_LINEAGE_SAMPLE_TRUNCATED_BLOCKER,
            missing_count=max(1, (known_total or sampled_count + 1) - sampled_count),
        )
    return summary


def _tca_status_lineage_sample_limit() -> int:
    configured_limit = getattr(
        settings,
        "trading_tca_status_lineage_sample_limit",
        _TCA_STATUS_LINEAGE_SAMPLE_DEFAULT_LIMIT,
    )
    try:
        parsed_limit = int(configured_limit)
    except (TypeError, ValueError):
        parsed_limit = _TCA_STATUS_LINEAGE_SAMPLE_DEFAULT_LIMIT
    return max(1, min(parsed_limit, _TCA_STATUS_LINEAGE_SAMPLE_MAX_LIMIT))


def _mark_tca_lineage_summary_fail_closed(
    summary: dict[str, object],
    *,
    reason: str,
    missing_count: int,
) -> None:
    blockers = [
        str(blocker)
        for blocker in cast(Collection[object], summary.get("blockers") or [])
    ]
    if reason not in blockers:
        blockers.append(reason)
    blocker_counts: dict[str, int] = {}
    for key, value in cast(
        Mapping[object, object], summary.get("blocker_counts") or {}
    ).items():
        try:
            blocker_counts[str(key)] = int(cast(Any, value))
        except (TypeError, ValueError):
            blocker_counts[str(key)] = 1
    blocker_counts[reason] = max(1, missing_count)
    summary["status"] = "blocked"
    summary["blockers"] = blockers
    summary["blocker_counts"] = dict(sorted(blocker_counts.items()))
    summary["promotion_authority"] = False


def _unavailable_tca_runtime_ledger_lineage_summary(
    *,
    reason: str,
    total_filled_execution_count: int | None,
) -> dict[str, object]:
    summary = _execution_lineage_summary([])
    sample_limit = _tca_status_lineage_sample_limit()
    missing_count = max(
        1,
        int(total_filled_execution_count)
        if total_filled_execution_count is not None
        else 1,
    )
    summary.update(
        {
            "bounded": True,
            "coverage_exact": False,
            "query_limit": sample_limit,
            "sampled_execution_count": 0,
            "truncated": total_filled_execution_count is not None
            and total_filled_execution_count > 0,
            "read_model_unavailable": True,
            "read_model_status": "timeout",
        }
    )
    if total_filled_execution_count is not None:
        summary["total_filled_execution_count"] = max(
            0, int(total_filled_execution_count)
        )
    _mark_tca_lineage_summary_fail_closed(
        summary,
        reason=reason,
        missing_count=missing_count,
    )
    return summary


def _execution_lineage_summary(executions: Collection[Execution]) -> dict[str, object]:
    blocker_counts: dict[str, int] = {}
    source_backed_count = 0
    filled_notional_count = 0
    explicit_cost_count = 0
    execution_policy_hash_count = 0
    cost_model_hash_count = 0
    post_cost_pnl_basis_count = 0
    sample_blockers: list[dict[str, object]] = []
    for execution in executions:
        audit_payload = _mapping_from_any(execution.execution_audit_json)
        lineage = _mapping_from_any(
            audit_payload.get("runtime_ledger_lineage")
            or audit_payload.get("execution_tca_cost_lineage")
        )
        blockers = [
            str(item).strip()
            for item in cast(Collection[object], lineage.get("blockers") or [])
            if str(item).strip()
        ]
        if not lineage:
            blockers = ["runtime_tca_cost_lineage_readback_missing"]
        if lineage.get("source_backed") is True and not blockers:
            source_backed_count += 1
        if lineage.get("filled_notional") is not None:
            filled_notional_count += 1
        if lineage.get("explicit_cost_amount") is not None:
            explicit_cost_count += 1
        if lineage.get("execution_policy_hash") is not None:
            execution_policy_hash_count += 1
        if lineage.get("cost_model_hash") is not None:
            cost_model_hash_count += 1
        if lineage.get("pnl_basis") == POST_COST_PNL_BASIS:
            post_cost_pnl_basis_count += 1
        for blocker in blockers:
            blocker_counts[blocker] = blocker_counts.get(blocker, 0) + 1
        if blockers and len(sample_blockers) < 10:
            sample_blockers.append(
                {
                    "execution_id": str(execution.id),
                    "alpaca_order_id": execution.alpaca_order_id,
                    "symbol": execution.symbol,
                    "blockers": blockers,
                }
            )

    execution_count = len(executions)
    blockers = sorted(blocker_counts)
    return {
        "schema_version": EXECUTION_TCA_COST_LINEAGE_SCHEMA_VERSION,
        "status": "source_backed"
        if execution_count > 0
        and source_backed_count == execution_count
        and not blockers
        else "blocked"
        if execution_count > 0
        else "missing",
        "promotion_authority": False,
        "promotion_authority_reason": "lineage_dimension_only_not_promotion_authority",
        "execution_count": execution_count,
        "source_backed_count": source_backed_count,
        "blocked_count": max(0, execution_count - source_backed_count),
        "filled_notional_count": filled_notional_count,
        "explicit_cost_count": explicit_cost_count,
        "execution_policy_hash_count": execution_policy_hash_count,
        "cost_model_hash_count": cost_model_hash_count,
        "post_cost_pnl_basis_count": post_cost_pnl_basis_count,
        "blockers": blockers,
        "blocker_counts": dict(sorted(blocker_counts.items())),
        "sample_blockers": sample_blockers,
    }


def _normalize_tca_symbols(symbols: Collection[str] | None) -> tuple[str, ...]:
    if symbols is None:
        return ()
    return tuple(
        sorted(
            {str(symbol).strip().upper() for symbol in symbols if str(symbol).strip()}
        )
    )


def _unavailable_tca_symbol_breakdown(
    *,
    symbols: tuple[str, ...],
    reason: str,
) -> list[dict[str, object]]:
    return [
        {
            "symbol": symbol,
            "order_count": 0,
            "avg_abs_slippage_bps": None,
            "max_abs_slippage_bps": None,
            "avg_realized_shortfall_bps": None,
            "last_computed_at": None,
            "read_model_unavailable": True,
            "read_model_status": "timeout",
            "reason_codes": [reason],
        }
        for symbol in symbols
    ]


def _build_tca_symbol_breakdown(
    session: Session,
    *,
    strategy_id: str | None,
    account_label: str,
    symbols: tuple[str, ...],
) -> list[dict[str, object]]:
    if not symbols:
        return []

    stmt = (
        select(
            ExecutionTCAMetric.symbol,
            func.count(ExecutionTCAMetric.id),
            func.avg(func.abs(ExecutionTCAMetric.slippage_bps)),
            func.max(func.abs(ExecutionTCAMetric.slippage_bps)),
            func.max(ExecutionTCAMetric.computed_at),
            func.avg(ExecutionTCAMetric.realized_shortfall_bps),
        )
        .where(ExecutionTCAMetric.symbol.in_(symbols))
        .group_by(ExecutionTCAMetric.symbol)
    )
    if strategy_id:
        stmt = stmt.where(ExecutionTCAMetric.strategy_id == strategy_id)
    if account_label:
        stmt = stmt.where(ExecutionTCAMetric.alpaca_account_label == account_label)

    rows_by_symbol = {str(row[0]).upper(): row for row in session.execute(stmt).all()}
    breakdown: list[dict[str, object]] = []
    for symbol in symbols:
        row = rows_by_symbol.get(symbol)
        if row is None:
            breakdown.append(
                {
                    "symbol": symbol,
                    "order_count": 0,
                    "avg_abs_slippage_bps": None,
                    "max_abs_slippage_bps": None,
                    "avg_realized_shortfall_bps": None,
                    "last_computed_at": None,
                }
            )
            continue
        breakdown.append(
            {
                "symbol": symbol,
                "order_count": int(row[1] or 0),
                "avg_abs_slippage_bps": _decimal_or_none(row[2]),
                "max_abs_slippage_bps": _decimal_or_none(row[3]),
                "last_computed_at": row[4],
                "avg_realized_shortfall_bps": _decimal_or_none(row[5]),
            }
        )
    return breakdown


def derive_adaptive_execution_policy(
    session: Session,
    *,
    symbol: str,
    regime_label: str | None,
) -> AdaptiveExecutionPolicyDecision:
    normalized_symbol = symbol.strip().upper()
    normalized_regime = _normalize_regime_label(regime_label)
    key = f"{normalized_symbol}:{normalized_regime}"
    generated_at = datetime.now(timezone.utc)

    if not normalized_symbol:
        return _empty_adaptive_execution_policy(
            key=key,
            symbol=normalized_symbol,
            regime_label=normalized_regime,
            generated_at=generated_at,
        )

    rows = _load_recent_tca_rows(
        session, symbol=normalized_symbol, regime_label=normalized_regime
    )
    window_summary = _collect_adaptive_windows(rows)
    baseline_slippage, recent_slippage = _split_window_average(window_summary.slippages)
    baseline_shortfall, recent_shortfall = _split_window_average(
        window_summary.shortfalls
    )
    effect_size_bps, degradation_bps = _derive_effect_size(
        baseline_slippage=baseline_slippage,
        recent_slippage=recent_slippage,
    )
    fallback_active, fallback_reason = _resolve_fallback_state(
        sample_size=window_summary.sample_size,
        adaptive_samples=window_summary.adaptive_samples,
        expected_shortfall_coverage=window_summary.expected_shortfall_coverage,
        degradation_bps=degradation_bps,
    )
    (
        prefer_limit,
        participation_rate_scale,
        execution_seconds_scale,
        aggressiveness,
    ) = _resolve_adaptive_controls(
        sample_size=window_summary.sample_size,
        fallback_active=fallback_active,
        recent_slippage=recent_slippage,
        recent_shortfall=recent_shortfall,
    )

    return AdaptiveExecutionPolicyDecision(
        key=key,
        symbol=normalized_symbol,
        regime_label=normalized_regime,
        sample_size=window_summary.sample_size,
        adaptive_samples=window_summary.adaptive_samples,
        baseline_slippage_bps=baseline_slippage,
        recent_slippage_bps=recent_slippage,
        baseline_shortfall_notional=baseline_shortfall,
        recent_shortfall_notional=recent_shortfall,
        effect_size_bps=effect_size_bps,
        degradation_bps=degradation_bps,
        expected_shortfall_coverage=window_summary.expected_shortfall_coverage,
        expected_shortfall_sample_count=window_summary.expected_shortfall_sample_count,
        fallback_active=fallback_active,
        fallback_reason=fallback_reason,
        prefer_limit=prefer_limit,
        participation_rate_scale=participation_rate_scale,
        execution_seconds_scale=execution_seconds_scale,
        aggressiveness=aggressiveness,
        generated_at=generated_at,
    )


def _empty_adaptive_execution_policy(
    *,
    key: str,
    symbol: str,
    regime_label: str,
    generated_at: datetime,
) -> AdaptiveExecutionPolicyDecision:
    return AdaptiveExecutionPolicyDecision(
        key=key,
        symbol=symbol,
        regime_label=regime_label,
        sample_size=0,
        adaptive_samples=0,
        expected_shortfall_coverage=Decimal("0"),
        expected_shortfall_sample_count=0,
        baseline_slippage_bps=None,
        recent_slippage_bps=None,
        baseline_shortfall_notional=None,
        recent_shortfall_notional=None,
        effect_size_bps=None,
        degradation_bps=None,
        fallback_active=False,
        fallback_reason=None,
        prefer_limit=None,
        participation_rate_scale=Decimal("1"),
        execution_seconds_scale=Decimal("1"),
        aggressiveness="neutral",
        generated_at=generated_at,
    )


def _collect_adaptive_windows(rows: list[dict[str, Any]]) -> _AdaptiveWindowSummary:
    adaptive_samples = 0
    expected_shortfall_sample_count = 0
    slippages: list[Decimal] = []
    shortfalls: list[Decimal] = []
    for row in rows:
        if row["adaptive_applied"]:
            adaptive_samples += 1
        slippage = row["slippage_bps"]
        shortfall = row["shortfall_notional"]
        if row["expected_shortfall_bps_p50"] is not None:
            expected_shortfall_sample_count += 1
        if slippage is not None:
            slippages.append(abs(slippage))
        if shortfall is not None:
            shortfalls.append(abs(shortfall))
    sample_size = len(rows)
    expected_shortfall_coverage = (
        Decimal(expected_shortfall_sample_count) / Decimal(sample_size)
        if sample_size > 0
        else Decimal("0")
    )
    return _AdaptiveWindowSummary(
        sample_size=sample_size,
        adaptive_samples=adaptive_samples,
        expected_shortfall_sample_count=expected_shortfall_sample_count,
        expected_shortfall_coverage=expected_shortfall_coverage,
        slippages=slippages,
        shortfalls=shortfalls,
    )


def _derive_effect_size(
    *,
    baseline_slippage: Decimal | None,
    recent_slippage: Decimal | None,
) -> tuple[Decimal | None, Decimal | None]:
    if baseline_slippage is None or recent_slippage is None:
        return None, None
    return baseline_slippage - recent_slippage, recent_slippage - baseline_slippage


def _resolve_fallback_state(
    *,
    sample_size: int,
    adaptive_samples: int,
    expected_shortfall_coverage: Decimal,
    degradation_bps: Decimal | None,
) -> tuple[bool, str | None]:
    if (
        sample_size >= ADAPTIVE_MIN_SAMPLE_SIZE
        and expected_shortfall_coverage < ADAPTIVE_MIN_EXPECTED_SHORTFALL_COVERAGE
    ):
        if expected_shortfall_coverage == Decimal("0"):
            return True, "adaptive_policy_expected_shortfall_coverage_missing"
        return True, "adaptive_policy_expected_shortfall_coverage_low"
    fallback_required = (
        adaptive_samples >= max(2, ADAPTIVE_MIN_SAMPLE_SIZE // 2)
        and degradation_bps is not None
        and degradation_bps >= ADAPTIVE_DEGRADE_FALLBACK_BPS
    )
    if fallback_required:
        return True, "adaptive_policy_degraded"
    return False, None


def _resolve_adaptive_controls(
    *,
    sample_size: int,
    fallback_active: bool,
    recent_slippage: Decimal | None,
    recent_shortfall: Decimal | None,
) -> tuple[bool | None, Decimal, Decimal, str]:
    prefer_limit: bool | None = None
    participation_rate_scale = Decimal("1")
    execution_seconds_scale = Decimal("1")
    aggressiveness = "neutral"
    if sample_size < ADAPTIVE_MIN_SAMPLE_SIZE or fallback_active:
        return (
            prefer_limit,
            participation_rate_scale,
            execution_seconds_scale,
            aggressiveness,
        )
    if (
        recent_slippage is not None
        and recent_shortfall is not None
        and (
            recent_slippage > ADAPTIVE_MAX_SLIPPAGE_BPS
            or recent_shortfall > ADAPTIVE_MAX_SHORTFALL
        )
    ):
        return (
            True,
            ADAPTIVE_PARTICIPATION_TIGHTEN,
            ADAPTIVE_EXECUTION_SLOWDOWN,
            "defensive",
        )
    if (
        recent_slippage is not None
        and recent_shortfall is not None
        and recent_slippage <= ADAPTIVE_TARGET_SLIPPAGE_BPS
        and recent_shortfall <= ADAPTIVE_MAX_SHORTFALL
    ):
        return (
            False,
            ADAPTIVE_PARTICIPATION_RELAX,
            ADAPTIVE_EXECUTION_SPEEDUP,
            "offensive",
        )
    return (
        prefer_limit,
        participation_rate_scale,
        execution_seconds_scale,
        aggressiveness,
    )


def _derive_churn(
    *,
    session: Session,
    execution: Execution,
    strategy_id: Any,
    account_label: str | None,
    signed_qty: Decimal,
    filled_qty: Decimal,
) -> tuple[Decimal, Optional[Decimal]]:
    if strategy_id is None or filled_qty <= 0 or signed_qty == 0:
        return Decimal("0"), None

    prior_where = [
        ExecutionTCAMetric.strategy_id == strategy_id,
        ExecutionTCAMetric.symbol == execution.symbol,
        Execution.created_at < execution.created_at,
    ]
    if account_label is None:
        prior_where.append(ExecutionTCAMetric.alpaca_account_label.is_(None))
    else:
        prior_where.append(ExecutionTCAMetric.alpaca_account_label == account_label)

    prior_signed_sum_stmt = (
        select(func.coalesce(func.sum(ExecutionTCAMetric.signed_qty), 0))
        .select_from(ExecutionTCAMetric)
        .join(Execution, Execution.id == ExecutionTCAMetric.execution_id)
        .where(*prior_where)
    )
    prior_signed = _decimal_or_none(
        session.execute(prior_signed_sum_stmt).scalar_one()
    ) or Decimal("0")

    if prior_signed == 0:
        return Decimal("0"), Decimal("0")
    if (prior_signed > 0 and signed_qty > 0) or (prior_signed < 0 and signed_qty < 0):
        return Decimal("0"), Decimal("0")

    churn_qty = min(abs(prior_signed), abs(signed_qty))
    churn_ratio = churn_qty / filled_qty if filled_qty > 0 else None
    return churn_qty, churn_ratio


def _resolve_arrival_price(
    *, decision: TradeDecision | None, execution: Execution
) -> Decimal | None:
    decision_payload: dict[str, Any] = {}
    decision_json = decision.decision_json if decision is not None else None
    if isinstance(decision_json, Mapping):
        decision_payload = {
            str(key): value
            for key, value in cast(Mapping[object, object], decision_json).items()
        }
    params = decision_payload.get("params")
    params_payload: dict[str, Any] = {}
    if isinstance(params, Mapping):
        params_payload = {
            str(key): value
            for key, value in cast(Mapping[object, object], params).items()
        }

    raw_order_payload: dict[str, Any] = {}
    raw_order = execution.raw_order
    if isinstance(raw_order, Mapping):
        raw_order_payload = {
            str(key): value
            for key, value in cast(Mapping[object, object], raw_order).items()
        }

    for candidate in (
        params_payload.get("arrival_price"),
        params_payload.get("reference_price"),
        decision_payload.get("arrival_price"),
        decision_payload.get("reference_price"),
        raw_order_payload.get("arrival_price"),
        raw_order_payload.get("reference_price"),
    ):
        resolved = _positive_decimal(candidate)
        if resolved is not None:
            return resolved
    return resolve_execution_reference_price(
        params=params_payload,
        limit_price=raw_order_payload.get("limit_price"),
    )


def _load_trade_decision(
    session: Session, execution: Execution
) -> TradeDecision | None:
    if execution.trade_decision_id is not None:
        decision = session.get(TradeDecision, execution.trade_decision_id)
        if decision is not None:
            return decision
    if execution.client_order_id is None:
        return None
    return session.execute(
        select(TradeDecision).where(
            TradeDecision.decision_hash == execution.client_order_id
        )
    ).scalar_one_or_none()


def _load_recent_tca_rows(
    session: Session,
    *,
    symbol: str,
    regime_label: str,
) -> list[dict[str, Any]]:
    stmt = (
        select(ExecutionTCAMetric, TradeDecision.decision_json)
        .outerjoin(
            TradeDecision, TradeDecision.id == ExecutionTCAMetric.trade_decision_id
        )
        .where(ExecutionTCAMetric.symbol == symbol)
        .order_by(ExecutionTCAMetric.computed_at.desc())
        .limit(ADAPTIVE_LOOKBACK_WINDOW * 3)
    )
    rows = session.execute(stmt).all()

    filtered: list[dict[str, Any]] = []
    for metric, decision_json in rows:
        params = _decision_params(decision_json)
        row_regime = _normalize_regime_label(
            params.get("regime_label") or params.get("regime")
        )
        if regime_label != "all" and row_regime != regime_label:
            continue
        execution_policy = params.get("execution_policy")
        execution_policy_map: Mapping[str, Any] = (
            cast(Mapping[str, Any], execution_policy)
            if isinstance(execution_policy, Mapping)
            else {}
        )
        adaptive = execution_policy_map.get("adaptive")
        adaptive_map: Mapping[str, Any] = (
            cast(Mapping[str, Any], adaptive) if isinstance(adaptive, Mapping) else {}
        )
        filtered.append(
            {
                "slippage_bps": _decimal_or_none(metric.slippage_bps),
                "shortfall_notional": _decimal_or_none(metric.shortfall_notional),
                "expected_shortfall_bps_p50": _decimal_or_none(
                    metric.expected_shortfall_bps_p50
                ),
                "adaptive_applied": bool(adaptive_map.get("applied", False)),
            }
        )
        if len(filtered) >= ADAPTIVE_LOOKBACK_WINDOW:
            break
    return filtered


def _decision_params(raw_decision_json: Any) -> dict[str, Any]:
    if not isinstance(raw_decision_json, Mapping):
        return {}
    decision_map = cast(Mapping[str, Any], raw_decision_json)
    raw_params = decision_map.get("params")
    if not isinstance(raw_params, Mapping):
        return {}
    params = cast(Mapping[str, Any], raw_params)
    return {str(key): value for key, value in params.items()}


def _split_window_average(
    values: list[Decimal],
) -> tuple[Decimal | None, Decimal | None]:
    if len(values) < ADAPTIVE_MIN_SAMPLE_SIZE:
        return None, None
    midpoint = len(values) // 2
    if midpoint == 0 or midpoint == len(values):
        return None, None
    recent = values[:midpoint]
    baseline = values[midpoint:]
    if not recent or not baseline:
        return None, None
    return _mean(baseline), _mean(recent)


def _mean(values: list[Decimal]) -> Decimal | None:
    if not values:
        return None
    total = sum(values, start=Decimal("0"))
    return total / Decimal(len(values))


def _normalize_regime_label(value: Any) -> str:
    text = str(value).strip().lower() if value is not None else ""
    return text or "all"


def _resolve_simulator_expectations(
    decision: TradeDecision | None,
) -> tuple[Decimal | None, Decimal | None, str | None]:
    if decision is None:
        return None, None, None
    decision_json = decision.decision_json
    if not isinstance(decision_json, Mapping):
        return None, None, None
    params_raw = cast(Mapping[object, object], decision_json).get("params")
    if not isinstance(params_raw, Mapping):
        return None, None, None
    params = cast(Mapping[object, object], params_raw)
    advice_payloads: list[Mapping[object, object]] = []
    for key in ("execution_advice", "execution_advisor"):
        raw_payload = params.get(key)
        if isinstance(raw_payload, Mapping):
            advice_payloads.append(cast(Mapping[object, object], raw_payload))
    if not advice_payloads:
        return None, None, None

    expected_p50: Decimal | None = None
    expected_p95: Decimal | None = None
    simulator_version: str | None = None
    for advice in advice_payloads:
        if expected_p50 is None:
            expected_p50 = _decimal_or_none(advice.get("expected_shortfall_bps_p50"))
        if expected_p95 is None:
            expected_p95 = _decimal_or_none(advice.get("expected_shortfall_bps_p95"))
        if simulator_version is None:
            simulator_version_raw = advice.get("simulator_version")
            if simulator_version_raw is not None:
                text = str(simulator_version_raw).strip()
                simulator_version = text or None
    return expected_p50, expected_p95, simulator_version


def _signed_qty(*, side: str, qty: Decimal) -> Decimal:
    normalized = (side or "").strip().lower()
    if normalized == "buy":
        return qty
    if normalized == "sell":
        return -qty
    return Decimal("0")


def _positive_decimal(value: Any) -> Decimal | None:
    parsed = _decimal_or_none(value)
    if parsed is None or parsed <= 0:
        return None
    return parsed


def _decimal_or_none(value: Any) -> Decimal | None:
    if value is None:
        return None
    if isinstance(value, Decimal):
        return value
    try:
        return Decimal(str(value))
    except (ArithmeticError, TypeError, ValueError):
        return None


def _decimal_str(value: Decimal | None) -> str | None:
    if value is None:
        return None
    return str(value)


__all__ = [
    "AdaptiveExecutionPolicyDecision",
    "build_tca_gate_inputs",
    "derive_adaptive_execution_policy",
    "refresh_execution_tca_metrics",
    "upsert_execution_tca_metric",
]
