"""Public helper functions for the semantic scheduler pipeline modules."""

from __future__ import annotations

import hashlib
import json
import logging
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Literal, Optional, cast

from sqlalchemy import select
from sqlalchemy.orm import Session

from ....config import settings
from ....models import TradeDecision
from ...llm.schema import PortfolioSnapshot, RecentDecisionSummary
from ...models import StrategyDecision
from ...prices import MarketSnapshot
from ...regime_hmm import (
    resolve_hmm_context,
    resolve_legacy_regime_label,
    resolve_regime_context_authority_reason,
    resolve_regime_route_label,
)
from ..state import (
    RuntimeUncertaintyGate,
    RuntimeUncertaintyGateAction,
    normalize_reason_metric,
)

logger = logging.getLogger(__name__)

RUNTIME_UNCERTAINTY_GATE_MAX_STALENESS_SECONDS = 15 * 60
PROJECTED_ORDER_ACTIONS = {"buy", "sell"}
PROJECTED_ORDER_TYPES = {"market", "limit", "stop", "stop_limit"}
PROJECTED_ORDER_TIME_IN_FORCE = {"day", "gtc", "ioc", "fok"}


@dataclass(frozen=True)
class OpenOrderProjection:
    symbol: str
    action: Literal["buy", "sell"]
    qty: Decimal
    order_type: Literal["market", "limit", "stop", "stop_limit"]
    time_in_force: Literal["day", "gtc", "ioc", "fok"]
    client_order_id: str
    params: dict[str, Any]


@dataclass(frozen=True)
class ExistingProjectionContext:
    projection_ids: list[str]
    projection_only: bool
    projection_count: int
    had_positions: bool


def clone_positions(positions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [dict(position) for position in positions]


def optional_decimal(value: Any) -> Optional[Decimal]:
    if value is None:
        return None
    try:
        return Decimal(str(value))
    except (ArithmeticError, ValueError):
        return None


def optional_int(value: Any) -> Optional[int]:
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def coerce_bool(value: Any) -> bool | None:
    if isinstance(value, bool):
        return value
    if isinstance(value, int):
        return value != 0
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"true", "t", "1", "yes", "on"}:
            return True
        if normalized in {"false", "f", "0", "no", "off"}:
            return False
    return None


def coerce_runtime_uncertainty_gate_action(
    value: Any,
) -> RuntimeUncertaintyGateAction | None:
    if not isinstance(value, str):
        return None
    normalized = value.strip().lower()
    if normalized in {"pass", "degrade", "abstain", "fail"}:
        return cast(RuntimeUncertaintyGateAction, normalized)
    return None


def coerce_strategy_symbols(raw: object) -> set[str]:
    if raw is None:
        return set()
    if isinstance(raw, list):
        symbols: set[str] = set()
        for symbol in cast(list[Any], raw):
            cleaned = str(symbol).strip()
            if cleaned:
                symbols.add(cleaned)
        return symbols
    if isinstance(raw, str):
        return {symbol.strip() for symbol in raw.split(",") if symbol.strip()}
    return set()


def coerce_json(value: Any) -> dict[str, Any]:
    if isinstance(value, Mapping):
        raw = cast(Mapping[str, Any], value)
        return {str(key): val for key, val in raw.items()}
    return {}


def extract_json_error_payload(error: Exception) -> dict[str, Any] | None:
    raw = str(error).strip()
    if not raw.startswith("{"):
        return None
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return None
    if isinstance(parsed, dict):
        return cast(dict[str, Any], parsed)
    return None


def format_order_submit_rejection(error: Exception) -> str:
    payload = extract_json_error_payload(error)
    if not payload:
        return f"alpaca_order_submit_failed {type(error).__name__}: {error}"
    source = str(payload.get("source") or "").strip().lower()
    code = payload.get("code")
    reject_reason = payload.get("reject_reason")
    existing_order_id = payload.get("existing_order_id")
    if source == "broker_precheck":
        parts: list[str] = ["broker_precheck_rejected"]
    elif source == "local_pre_submit":
        parts = ["local_pre_submit_rejected"]
    else:
        parts = ["alpaca_order_rejected"]
    if code is not None:
        parts.append(f"code={code}")
    if reject_reason:
        parts.append(f"reason={reject_reason}")
    if existing_order_id:
        parts.append(f"existing_order_id={existing_order_id}")
    return " ".join(parts)


def price_snapshot_payload(snapshot: MarketSnapshot) -> dict[str, Any]:
    return {
        "as_of": snapshot.as_of.isoformat(),
        "price": str(snapshot.price) if snapshot.price is not None else None,
        "spread": str(snapshot.spread) if snapshot.spread is not None else None,
        "source": snapshot.source,
    }


def build_portfolio_snapshot(
    account: dict[str, str],
    positions: list[dict[str, Any]],
) -> PortfolioSnapshot:
    exposure_by_symbol: dict[str, Decimal] = {}
    total_exposure = Decimal("0")
    for position in positions:
        symbol = str(position.get("symbol") or "").strip()
        market_value = optional_decimal(position.get("market_value"))
        if not symbol or market_value is None:
            continue
        exposure_by_symbol[symbol] = (
            exposure_by_symbol.get(symbol, Decimal("0")) + market_value
        )
        total_exposure += abs(market_value)
    return PortfolioSnapshot(
        equity=optional_decimal(account.get("equity")),
        cash=optional_decimal(account.get("cash")),
        buying_power=optional_decimal(account.get("buying_power")),
        total_exposure=total_exposure,
        exposure_by_symbol=exposure_by_symbol,
        positions=positions,
    )


def load_recent_decisions(
    session: Session,
    strategy_id: str,
    symbol: str,
) -> list[RecentDecisionSummary]:
    if settings.llm_recent_decisions <= 0:
        return []
    stmt = (
        select(TradeDecision)
        .where(TradeDecision.strategy_id == strategy_id)
        .where(TradeDecision.symbol == symbol)
        .order_by(TradeDecision.created_at.desc())
        .limit(settings.llm_recent_decisions)
    )
    decisions = session.execute(stmt).scalars().all()
    summaries: list[RecentDecisionSummary] = []
    for decision in decisions:
        decision_json = coerce_json(decision.decision_json)
        params_value: object = decision_json.get("params")
        params_map: Mapping[str, Any] = {}
        if isinstance(params_value, Mapping):
            params_map = cast(Mapping[str, Any], params_value)
        price = optional_decimal(params_map.get("price"))
        if price is None and isinstance(params_map.get("price_snapshot"), Mapping):
            snapshot_map = cast(Mapping[str, Any], params_map.get("price_snapshot"))
            price = optional_decimal(snapshot_map.get("price"))
        summaries.append(
            RecentDecisionSummary(
                decision_id=str(decision.id),
                strategy_id=str(decision.strategy_id),
                symbol=decision.symbol,
                action=decision_json.get("action", "buy"),
                qty=optional_decimal(decision_json.get("qty")) or Decimal("0"),
                status=decision.status,
                created_at=decision.created_at,
                rationale=decision.rationale,
                price=price,
            )
        )
    return summaries


def allocator_rejection_reasons(decision: StrategyDecision) -> list[str]:
    allocator = decision.params.get("allocator")
    if not isinstance(allocator, Mapping):
        return []
    allocator_map = cast(Mapping[str, Any], allocator)
    if str(allocator_map.get("status") or "").lower() != "rejected":
        return []
    raw_codes = allocator_map.get("reason_codes")
    if isinstance(raw_codes, list):
        codes = cast(list[Any], raw_codes)
        reason_codes = [str(item).strip() for item in codes if str(item).strip()]
        if reason_codes:
            return reason_codes
    return ["allocator_rejected"]


def apply_projected_position_decision(
    positions: list[dict[str, Any]],
    decision: StrategyDecision,
) -> None:
    qty = optional_decimal(decision.qty)
    if qty is None or qty <= 0 or decision.action not in {"buy", "sell"}:
        return
    current_qty = position_qty(decision.symbol, positions)
    current_market_value = position_market_value(decision.symbol, positions)
    delta = qty if decision.action == "buy" else -qty
    projected_qty = current_qty + delta
    projected_market_value = projected_position_market_value(
        current_market_value,
        delta,
        extract_decision_price(decision),
    )
    positions[:] = [
        position for position in positions if position.get("symbol") != decision.symbol
    ]
    if projected_qty == 0:
        return
    projected_position = {
        "symbol": decision.symbol,
        "qty": str(abs(projected_qty)),
        "side": "short" if projected_qty < 0 else "long",
    }
    if projected_market_value is not None:
        projected_position["market_value"] = str(projected_market_value)
    positions.append(projected_position)


def project_open_orders_onto_positions(
    positions: list[dict[str, Any]],
    open_orders: list[dict[str, Any]],
) -> int:
    projected_total = 0
    projection_ts = datetime.now(timezone.utc)
    for order in open_orders:
        projection = open_order_projection(order, projection_ts)
        if projection is None:
            continue
        context = existing_projection_context(positions, projection.symbol)
        projected_total += 1
        apply_projected_position_decision(
            positions,
            projection_strategy_decision(projection, projection_ts),
        )
        record_open_order_projection_metadata(positions, projection, context)
    return projected_total


def is_runtime_risk_increasing_entry(
    decision: StrategyDecision,
    positions: list[dict[str, Any]],
) -> bool:
    qty = optional_decimal(decision.qty)
    if qty is None or qty <= 0:
        return False
    current_position_qty = position_qty(decision.symbol, positions)
    if decision.action == "buy":
        if current_position_qty < 0:
            return qty > abs(current_position_qty)
        return True
    if current_position_qty <= 0:
        return True
    return qty > current_position_qty


def resolve_signal_regime(signal: Any) -> Optional[str]:
    payload_map = cast(Mapping[str, Any], signal.payload)
    macd = optional_decimal(payload_map.get("macd"))
    if macd is None and isinstance(payload_map.get("macd"), Mapping):
        macd_block = cast(Mapping[str, Any], payload_map.get("macd"))
        macd = optional_decimal(macd_block.get("macd"))
    macd_signal = optional_decimal(payload_map.get("macd_signal"))
    if macd_signal is None and isinstance(payload_map.get("macd"), Mapping):
        macd_block = cast(Mapping[str, Any], payload_map.get("macd"))
        macd_signal = optional_decimal(macd_block.get("signal"))
    resolved = resolve_regime_route_label(
        payload_map,
        macd=macd,
        macd_signal=macd_signal,
    )
    if resolved != "unknown":
        return resolved
    return resolve_legacy_regime_label(payload_map)


def resolve_decision_regime_label_with_source(
    decision: StrategyDecision,
) -> tuple[Optional[str], str, str | None]:
    params = cast(Mapping[str, Any], decision.params)
    allocator_label = allocator_regime_label(params)
    if allocator_label is not None:
        return allocator_label, "allocator", None
    hmm_resolution = hmm_regime_label(params)
    if hmm_resolution is not None:
        return hmm_resolution
    direct = params.get("regime_label")
    if isinstance(direct, str) and direct.strip():
        return direct.strip().lower(), "legacy", None
    legacy_label = resolve_legacy_regime_label(params)
    return (
        legacy_label,
        "legacy",
        None if legacy_label is not None else "missing",
    )


def extract_top_regime_posterior_probability(
    posterior: Mapping[str, str],
) -> Decimal | None:
    top_probability = None
    for raw_probability in posterior.values():
        try:
            parsed_probability = Decimal(raw_probability)
        except (ArithmeticError, ValueError):
            continue
        if parsed_probability < 0 or parsed_probability > 1:
            continue
        if top_probability is None or parsed_probability > top_probability:
            top_probability = parsed_probability
    return top_probability


def select_strictest_runtime_uncertainty_gate(
    candidates: list[RuntimeUncertaintyGate],
) -> RuntimeUncertaintyGate:
    selected = candidates[0]
    for candidate in candidates[1:]:
        if runtime_uncertainty_gate_rank(
            candidate.action
        ) > runtime_uncertainty_gate_rank(selected.action):
            selected = candidate
    return selected


def autonomy_gate_report_is_saturated_fail_sentinel(
    *,
    action: RuntimeUncertaintyGateAction,
    coverage_error: Decimal | None,
    shift_score: Decimal | None,
    conformal_interval_width: Decimal | None,
) -> bool:
    if action != "fail" or coverage_error is None or coverage_error < Decimal("1"):
        return False
    if shift_score is not None and shift_score < Decimal("1"):
        return False
    if conformal_interval_width is None:
        return True
    return conformal_interval_width <= 0


def uncertainty_gate_staleness_reason(
    source: str,
    payload: Mapping[str, Any],
) -> str | None:
    if "generated_at" not in payload:
        return None
    timestamp = coerce_gateway_timestamp(payload.get("generated_at"))
    if timestamp is None:
        return f"{source}_generated_at_unparseable"
    age_seconds = int((datetime.now(timezone.utc) - timestamp).total_seconds())
    if age_seconds > RUNTIME_UNCERTAINTY_GATE_MAX_STALENESS_SECONDS:
        return f"{source}_generated_at_stale"
    return None


def hash_payload(payload: dict[str, Any]) -> str:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def resolve_llm_unavailable_reject_reason(reason: str | None) -> str:
    normalized = normalize_reason_metric(reason)
    if normalized == "unknown":
        return "llm_unavailable_unknown"
    if normalized.startswith("llm_unavailable_"):
        return normalized
    return f"llm_unavailable_{normalized}"


def classify_llm_error(error: Exception) -> Optional[str]:
    message = str(error)
    if message == "llm_response_not_json":
        return "llm_response_not_json"
    if message == "llm_response_invalid":
        return "llm_response_invalid"
    return None


def resolve_llm_review_error_reject_reason(error: Exception) -> str:
    label = classify_llm_error(error)
    if label == "llm_response_not_json":
        return "llm_review_error_response_not_json"
    if label == "llm_response_invalid":
        return "llm_review_error_response_invalid"
    return f"llm_review_error_{type(error).__name__}"


def attach_dspy_lineage(
    response_json: dict[str, Any],
    *,
    artifact_source: str,
    error: str | None = None,
) -> None:
    payload = response_json.get("dspy")
    if isinstance(payload, Mapping):
        dspy_payload = {
            str(key): value for key, value in cast(Mapping[str, Any], payload).items()
        }
        if normalize_optional_text(dspy_payload.get("artifact_source")) is None:
            dspy_payload["artifact_source"] = artifact_source
        if error is not None and error.strip() and "error" not in dspy_payload:
            dspy_payload["error"] = error.strip()
        response_json["dspy"] = dspy_payload
    else:
        response_json["dspy"] = runtime_dspy_metadata(
            artifact_source=artifact_source,
            error=error,
        )
    response_json["dspy_lineage"] = build_dspy_lineage(response_json)


def committee_trace_has_veto(response_json: Mapping[str, Any]) -> bool:
    committee_payload = response_json.get("committee")
    if not isinstance(committee_payload, Mapping):
        return False
    committee_roles = cast(Mapping[str, Any], committee_payload).get("roles")
    if not isinstance(committee_roles, Mapping):
        return False
    for role_payload in cast(Mapping[str, Any], committee_roles).values():
        if not isinstance(role_payload, Mapping):
            continue
        verdict = normalize_optional_text(
            cast(Mapping[str, Any], role_payload).get("verdict")
        )
        if verdict == "veto":
            return True
    return False


def build_committee_veto_alignment_payload(
    *,
    committee_veto: bool,
    deterministic_veto: bool,
) -> dict[str, bool]:
    return {
        "committee_veto": committee_veto,
        "deterministic_veto": deterministic_veto,
        "aligned": (not committee_veto) or deterministic_veto,
    }


def normalize_rollout_stage(stage: str) -> str:
    if stage.startswith("stage0"):
        return "stage0"
    if stage.startswith("stage1"):
        return "stage1"
    if stage.startswith("stage2"):
        return "stage2"
    if stage.startswith("stage3"):
        return "stage3"
    return "stage3"


def llm_guardrail_controls_snapshot() -> dict[str, Any]:
    return {
        "min_confidence": settings.llm_min_confidence,
        "min_calibrated_probability": settings.llm_min_calibrated_top_probability,
        "min_probability_margin": settings.llm_min_probability_margin,
        "max_uncertainty_score": settings.llm_max_uncertainty,
        "max_uncertainty_band": settings.llm_max_uncertainty_band,
        "min_calibration_quality_score": settings.llm_min_calibration_quality_score,
        "abstain_fail_mode": settings.llm_abstain_fail_mode,
        "escalation_fail_mode": settings.llm_escalate_fail_mode,
        "uncertainty_fail_mode": settings.llm_quality_fail_mode,
        "effective_fail_mode": settings.llm_effective_fail_mode_for_current_rollout(),
    }


def position_qty(symbol: str, positions: list[dict[str, Any]]) -> Decimal:
    total_qty = Decimal("0")
    for position in positions:
        if position.get("symbol") != symbol:
            continue
        qty = optional_decimal(position.get("qty"))
        if qty is None:
            qty = optional_decimal(position.get("quantity"))
        if qty is None:
            continue
        side = str(position.get("side") or "").strip().lower()
        if side == "short":
            qty = -abs(qty)
        total_qty += qty
    return total_qty


def position_market_value(
    symbol: str,
    positions: list[dict[str, Any]],
) -> Decimal | None:
    total_market_value = Decimal("0")
    has_market_value = False
    for position in positions:
        if position.get("symbol") != symbol:
            continue
        market_value = optional_decimal(position.get("market_value"))
        if market_value is None:
            continue
        total_market_value += market_value
        has_market_value = True
    if not has_market_value:
        return None
    return total_market_value


def projected_position_market_value(
    current_market_value: Decimal | None,
    delta: Decimal,
    decision_price: Decimal | None,
) -> Decimal | None:
    if decision_price is None:
        return current_market_value
    return (current_market_value or Decimal("0")) + (delta * decision_price)


def extract_decision_price(decision: StrategyDecision) -> Decimal | None:
    for key in ("price", "limit_price", "stop_price"):
        value = decision.params.get(key)
        if value is None:
            value = getattr(decision, key, None)
        if value is not None:
            return optional_decimal(value)
    return None


def open_order_projection(
    order: Mapping[str, Any],
    projection_ts: datetime,
) -> OpenOrderProjection | None:
    _ = projection_ts
    symbol = str(order.get("symbol") or "").strip().upper()
    side = str(order.get("side") or "").strip().lower()
    qty = optional_decimal(order.get("qty"))
    filled_qty = optional_decimal(order.get("filled_qty")) or Decimal("0")
    if not symbol or side not in {"buy", "sell"} or qty is None or qty <= 0:
        return None
    remaining_qty = qty - max(filled_qty, Decimal("0"))
    if remaining_qty <= 0:
        return None
    action = cast(Literal["buy", "sell"], side)
    return OpenOrderProjection(
        symbol=symbol,
        action=action,
        qty=remaining_qty,
        order_type=normalized_order_type(order),
        time_in_force=normalized_time_in_force(order),
        client_order_id=str(
            order.get("client_order_id") or order.get("client_orderid") or ""
        ).strip(),
        params=open_order_price_params(order),
    )


def open_order_price_params(order: Mapping[str, Any]) -> dict[str, Any]:
    price = (
        optional_decimal(order.get("limit_price"))
        or optional_decimal(order.get("stop_price"))
        or optional_decimal(order.get("notional_price"))
    )
    return {"price": str(price)} if price is not None else {}


def normalized_order_type(
    order: Mapping[str, Any],
) -> Literal["market", "limit", "stop", "stop_limit"]:
    order_type = str(order.get("type") or order.get("order_type") or "market")
    normalized = order_type.strip().lower()
    if normalized not in PROJECTED_ORDER_TYPES:
        normalized = "market"
    return cast(Literal["market", "limit", "stop", "stop_limit"], normalized)


def normalized_time_in_force(
    order: Mapping[str, Any],
) -> Literal["day", "gtc", "ioc", "fok"]:
    normalized = str(order.get("time_in_force") or "day").strip().lower()
    if normalized not in PROJECTED_ORDER_TIME_IN_FORCE:
        normalized = "day"
    return cast(Literal["day", "gtc", "ioc", "fok"], normalized)


def existing_projection_context(
    positions: list[dict[str, Any]],
    symbol: str,
) -> ExistingProjectionContext:
    existing_positions = [
        position
        for position in positions
        if str(position.get("symbol") or "").strip().upper() == symbol
    ]
    projection_ids: list[str] = []
    projection_only = True
    projection_count = 0
    for position in existing_positions:
        if not bool(position.get("open_order_projection")):
            projection_only = False
            continue
        projection_count += int(position.get("open_order_projection_count") or 1)
        projection_ids.extend(projection_ids_from_position(position))
    return ExistingProjectionContext(
        projection_ids=projection_ids,
        projection_only=projection_only,
        projection_count=projection_count,
        had_positions=bool(existing_positions),
    )


def projection_ids_from_position(position: Mapping[str, Any]) -> list[str]:
    projection_ids: list[str] = []
    raw_ids = position.get("open_order_client_order_ids")
    if isinstance(raw_ids, list):
        projection_ids.extend(
            str(item).strip() for item in cast(list[Any], raw_ids) if str(item).strip()
        )
    raw_id = str(position.get("open_order_client_order_id") or "").strip()
    if raw_id:
        projection_ids.append(raw_id)
    return projection_ids


def projection_strategy_decision(
    projection: OpenOrderProjection,
    projection_ts: datetime,
) -> StrategyDecision:
    return StrategyDecision(
        strategy_id="open_order_projection",
        symbol=projection.symbol,
        event_ts=projection_ts,
        timeframe="open_order",
        action=projection.action,
        qty=projection.qty,
        order_type=projection.order_type,
        time_in_force=projection.time_in_force,
        params=projection.params,
    )


def record_open_order_projection_metadata(
    positions: list[dict[str, Any]],
    projection: OpenOrderProjection,
    context: ExistingProjectionContext,
) -> None:
    for position in positions:
        if str(position.get("symbol") or "").strip().upper() != projection.symbol:
            continue
        projection_ids = [*context.projection_ids]
        if projection.client_order_id:
            projection_ids.append(projection.client_order_id)
            position["open_order_client_order_id"] = projection.client_order_id
        if projection_ids:
            position["open_order_client_order_ids"] = list(
                dict.fromkeys(projection_ids)
            )
        position["open_order_projection"] = True
        position["open_order_projection_only"] = context.projection_only and bool(
            projection_ids or not context.had_positions
        )
        position["open_order_projection_count"] = context.projection_count + 1
        break


def allocator_regime_label(params: Mapping[str, Any]) -> str | None:
    allocator = params.get("allocator")
    if not isinstance(allocator, Mapping):
        return None
    allocator_regime = cast(Mapping[str, Any], allocator).get("regime_label")
    if isinstance(allocator_regime, str) and allocator_regime.strip():
        return allocator_regime.strip().lower()
    return None


def hmm_regime_label(
    params: Mapping[str, Any],
) -> tuple[Optional[str], str, str | None] | None:
    raw_regime_hmm = params.get("regime_hmm")
    if not isinstance(raw_regime_hmm, Mapping):
        return None
    regime_context = resolve_hmm_context(cast(Mapping[str, Any], raw_regime_hmm))
    authority_reason = resolve_regime_context_authority_reason(regime_context)
    if regime_context.is_authoritative:
        return regime_context.regime_id.lower(), "hmm", None
    if authority_reason is None:
        return None, "hmm", "hmm_non_authoritative"
    legacy_label = resolve_legacy_regime_label(params)
    if legacy_label is not None:
        return legacy_label, "legacy", authority_reason
    return None, "none", authority_reason


def runtime_uncertainty_gate_rank(action: RuntimeUncertaintyGateAction) -> int:
    ranking: dict[RuntimeUncertaintyGateAction, int] = {
        "pass": 0,
        "degrade": 1,
        "abstain": 2,
        "fail": 3,
    }
    return ranking[action]


def coerce_gateway_timestamp(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, (int, float)):
        return numeric_gateway_timestamp(value)
    if not isinstance(value, str):
        return None
    return text_gateway_timestamp(value)


def numeric_gateway_timestamp(value: int | float) -> datetime | None:
    try:
        return datetime.fromtimestamp(float(value), tz=timezone.utc)
    except (OverflowError, OSError, ValueError):
        return None


def text_gateway_timestamp(value: str) -> datetime | None:
    raw_value = value.strip()
    if not raw_value:
        return None
    normalized = raw_value.replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def normalize_optional_text(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, str):
        normalized = value.strip()
        return normalized or None
    normalized = str(value).strip()
    return normalized or None


def runtime_dspy_metadata(
    *,
    artifact_source: str,
    error: str | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "mode": settings.llm_dspy_runtime_mode,
        "program_name": settings.llm_dspy_program_name,
        "signature_version": settings.llm_dspy_signature_version,
        "artifact_hash": normalize_optional_text(settings.llm_dspy_artifact_hash),
        "artifact_source": artifact_source,
    }
    if error is not None and error.strip():
        payload["error"] = error.strip()
    return payload


def build_dspy_lineage(response_json: Mapping[str, Any]) -> dict[str, Any]:
    payload = response_json.get("dspy")
    dspy_payload: dict[str, Any] = {}
    if isinstance(payload, Mapping):
        dspy_payload = {
            str(key): value for key, value in cast(Mapping[str, Any], payload).items()
        }
    return {
        "mode": normalize_optional_text(dspy_payload.get("mode"))
        or settings.llm_dspy_runtime_mode,
        "program_name": normalize_optional_text(dspy_payload.get("program_name"))
        or settings.llm_dspy_program_name,
        "signature_version": normalize_optional_text(
            dspy_payload.get("signature_version")
        )
        or settings.llm_dspy_signature_version,
        "artifact_hash": normalize_optional_text(dspy_payload.get("artifact_hash"))
        or normalize_optional_text(settings.llm_dspy_artifact_hash),
        "artifact_source": normalize_optional_text(dspy_payload.get("artifact_source"))
        or "runtime",
    }
