"""Pure and shared helpers for the trading pipeline."""
# pyright: reportUnusedImport=false, reportPrivateUsage=false, reportUnusedFunction=false

from __future__ import annotations

import hashlib
import json
import logging
from collections.abc import Callable, Mapping
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Optional, cast
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.orm import Session

from ...config import settings
from ...models import TradeDecision
from ..llm.schema import PortfolioSnapshot, RecentDecisionSummary
from ..models import SignalEnvelope, StrategyDecision
from ..prices import MarketSnapshot
from ..regime_hmm import (
    resolve_hmm_context,
    resolve_legacy_regime_label,
    resolve_regime_context_authority_reason,
    resolve_regime_route_label,
)
from ..time_source import trading_now
from .state import (
    RuntimeUncertaintyGate,
    RuntimeUncertaintyGateAction,
    _normalize_reason_metric,
)

logger = logging.getLogger(__name__)
_RUNTIME_UNCERTAINTY_GATE_MAX_STALENESS_SECONDS = 15 * 60

def _runtime_uncertainty_gate_rank(action: RuntimeUncertaintyGateAction) -> int:
    ranking: dict[RuntimeUncertaintyGateAction, int] = {
        "pass": 0,
        "degrade": 1,
        "abstain": 2,
        "fail": 3,
    }
    return ranking[action]


def _select_strictest_runtime_uncertainty_gate(
    candidates: list[RuntimeUncertaintyGate],
) -> RuntimeUncertaintyGate:
    selected = candidates[0]
    for candidate in candidates[1:]:
        if _runtime_uncertainty_gate_rank(
            candidate.action
        ) > _runtime_uncertainty_gate_rank(selected.action):
            selected = candidate
    return selected


def _autonomy_gate_report_is_saturated_fail_sentinel(
    *,
    action: RuntimeUncertaintyGateAction,
    coverage_error: Decimal | None,
    shift_score: Decimal | None,
    conformal_interval_width: Decimal | None,
) -> bool:
    if action != "fail":
        return False
    if coverage_error is None:
        return False
    if coverage_error < Decimal("1"):
        return False
    if shift_score is not None and shift_score < Decimal("1"):
        return False
    if conformal_interval_width is None:
        return True
    return conformal_interval_width <= 0


def _clone_positions(positions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [dict(position) for position in positions]

def _resolve_llm_unavailable_reject_reason(reason: str | None) -> str:
    normalized = _normalize_reason_metric(reason)
    if normalized == "unknown":
        return "llm_unavailable_unknown"
    if normalized.startswith("llm_unavailable_"):
        return normalized
    return f"llm_unavailable_{normalized}"


def _resolve_llm_review_error_reject_reason(error: Exception) -> str:
    label = _classify_llm_error(error)
    if label == "llm_response_not_json":
        return "llm_review_error_response_not_json"
    if label == "llm_response_invalid":
        return "llm_review_error_response_invalid"
    return f"llm_review_error_{type(error).__name__}"


def _is_market_session_open(
    trading_client: Any | None,
    *,
    now: datetime | None = None,
) -> bool:
    if settings.trading_simulation_enabled:
        current = (now or trading_now()).astimezone(ZoneInfo("America/New_York"))
        if current.weekday() >= 5:
            return False
        session_open = current.replace(hour=9, minute=30, second=0, microsecond=0)
        session_close = current.replace(hour=16, minute=0, second=0, microsecond=0)
        return session_open <= current < session_close
    get_clock = cast(
        Callable[[], Any] | None, getattr(trading_client, "get_clock", None)
    )
    if callable(get_clock):
        try:
            clock = get_clock()
            is_open = getattr(clock, "is_open", None)
            if isinstance(is_open, bool):
                return is_open
            if is_open is not None:
                return bool(is_open)
        except Exception:
            logger.exception("Failed to resolve Alpaca market clock state")

    current = (now or datetime.now(timezone.utc)).astimezone(
        ZoneInfo("America/New_York")
    )
    if current.weekday() >= 5:
        return False
    session_open = current.replace(hour=9, minute=30, second=0, microsecond=0)
    session_close = current.replace(hour=16, minute=0, second=0, microsecond=0)
    return session_open <= current < session_close


def _latch_signal_continuity_alert_state(state: Any, reason: str) -> None:
    now = datetime.now(timezone.utc)
    if not state.signal_continuity_alert_active:
        state.signal_continuity_alert_started_at = now
    state.signal_continuity_alert_active = True
    state.signal_continuity_alert_reason = reason
    state.signal_continuity_alert_last_seen_at = now
    state.signal_continuity_recovery_streak = 0
    state.metrics.record_signal_continuity_alert_state(
        active=True,
        recovery_streak=0,
    )


def _record_signal_continuity_recovery_cycle(
    state: Any, *, required_recovery_cycles: int
) -> None:
    if not state.signal_continuity_alert_active:
        state.metrics.record_signal_continuity_alert_state(
            active=False,
            recovery_streak=0,
        )
        return

    state.signal_continuity_recovery_streak += 1
    state.metrics.record_signal_continuity_alert_state(
        active=True,
        recovery_streak=state.signal_continuity_recovery_streak,
    )
    if state.signal_continuity_recovery_streak < required_recovery_cycles:
        return

    logger.info(
        "Signal continuity alert cleared after healthy cycles=%s reason=%s",
        state.signal_continuity_recovery_streak,
        state.signal_continuity_alert_reason,
    )
    state.signal_continuity_alert_active = False
    state.signal_continuity_alert_reason = None
    state.signal_continuity_alert_started_at = None
    state.signal_continuity_alert_last_seen_at = None
    state.signal_continuity_recovery_streak = 0
    state.metrics.record_signal_continuity_alert_state(
        active=False,
        recovery_streak=0,
    )


def _extract_json_error_payload(error: Exception) -> Optional[dict[str, Any]]:
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


def _format_order_submit_rejection(error: Exception) -> str:
    payload = _extract_json_error_payload(error)
    if payload:
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
    return f"alpaca_order_submit_failed {type(error).__name__}: {error}"

def _coerce_json(value: Any) -> dict[str, Any]:
    if isinstance(value, Mapping):
        raw = cast(Mapping[str, Any], value)
        return {str(key): val for key, val in raw.items()}
    return {}


def _classify_llm_error(error: Exception) -> Optional[str]:
    message = str(error)
    if message == "llm_response_not_json":
        return "llm_response_not_json"
    if message == "llm_response_invalid":
        return "llm_response_invalid"
    return None


def _price_snapshot_payload(snapshot: MarketSnapshot) -> dict[str, Any]:
    return {
        "as_of": snapshot.as_of.isoformat(),
        "price": str(snapshot.price) if snapshot.price is not None else None,
        "spread": str(snapshot.spread) if snapshot.spread is not None else None,
        "source": snapshot.source,
    }


def _build_portfolio_snapshot(
    account: dict[str, str], positions: list[dict[str, Any]]
) -> PortfolioSnapshot:
    equity = _optional_decimal(account.get("equity"))
    cash = _optional_decimal(account.get("cash"))
    buying_power = _optional_decimal(account.get("buying_power"))
    exposure_by_symbol: dict[str, Decimal] = {}
    total_exposure = Decimal("0")
    for position in positions:
        symbol = position.get("symbol")
        if not symbol:
            continue
        market_value = _optional_decimal(position.get("market_value"))
        if market_value is None:
            continue
        exposure_by_symbol[symbol] = (
            exposure_by_symbol.get(symbol, Decimal("0")) + market_value
        )
        total_exposure += abs(market_value)
    return PortfolioSnapshot(
        equity=equity,
        cash=cash,
        buying_power=buying_power,
        total_exposure=total_exposure,
        exposure_by_symbol=exposure_by_symbol,
        positions=positions,
    )


def _load_recent_decisions(
    session: Session, strategy_id: str, symbol: str
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
        decision_json = _coerce_json(decision.decision_json)
        params_value: object = decision_json.get("params")
        params_map: Mapping[str, Any] = {}
        if isinstance(params_value, Mapping):
            params_map = cast(Mapping[str, Any], params_value)
        price = _optional_decimal(params_map.get("price"))
        if price is None and isinstance(params_map.get("price_snapshot"), Mapping):
            snapshot_map = cast(Mapping[str, Any], params_map.get("price_snapshot"))
            price = _optional_decimal(snapshot_map.get("price"))
        summaries.append(
            RecentDecisionSummary(
                decision_id=str(decision.id),
                strategy_id=str(decision.strategy_id),
                symbol=decision.symbol,
                action=decision_json.get("action", "buy"),
                qty=_optional_decimal(decision_json.get("qty")) or Decimal("0"),
                status=decision.status,
                created_at=decision.created_at,
                rationale=decision.rationale,
                price=price,
            )
        )
    return summaries


def _resolve_signal_regime(signal: SignalEnvelope) -> Optional[str]:
    payload = signal.payload
    payload_map = cast(Mapping[str, Any], payload)
    macd = _optional_decimal(payload_map.get("macd"))
    if macd is None and isinstance(payload_map.get("macd"), Mapping):
        macd_block = cast(Mapping[str, Any], payload_map.get("macd"))
        macd = _optional_decimal(macd_block.get("macd"))
    macd_signal = _optional_decimal(payload_map.get("macd_signal"))
    if macd_signal is None and isinstance(payload_map.get("macd"), Mapping):
        macd_block = cast(Mapping[str, Any], payload_map.get("macd"))
        macd_signal = _optional_decimal(macd_block.get("signal"))
    resolved = resolve_regime_route_label(
        payload_map, macd=macd, macd_signal=macd_signal
    )
    if resolved != "unknown":
        return resolved
    regime_label = resolve_legacy_regime_label(payload_map)
    if regime_label is not None:
        return regime_label
    return None


def _resolve_decision_regime_label_with_source(
    decision: StrategyDecision,
) -> tuple[Optional[str], str, str | None]:
    params = cast(Mapping[str, Any], decision.params)
    allocator = params.get("allocator")
    if isinstance(allocator, Mapping):
        allocator_map = cast(Mapping[str, Any], allocator)
        allocator_regime = allocator_map.get("regime_label")
        if isinstance(allocator_regime, str) and allocator_regime.strip():
            return allocator_regime.strip().lower(), "allocator", None

    raw_regime_hmm = params.get("regime_hmm")
    if isinstance(raw_regime_hmm, Mapping):
        regime_context = resolve_hmm_context(cast(Mapping[str, Any], raw_regime_hmm))
        regime_context_authority_reason = resolve_regime_context_authority_reason(
            regime_context
        )
        if regime_context.is_authoritative:
            return regime_context.regime_id.lower(), "hmm", None

        if regime_context_authority_reason is None:
            return (
                None,
                "hmm",
                "hmm_non_authoritative",
            )
        regime_label = resolve_legacy_regime_label(params)
        if regime_label is not None:
            return regime_label, "legacy", regime_context_authority_reason
        return None, "none", regime_context_authority_reason

    direct = params.get("regime_label")
    if isinstance(direct, str) and direct.strip():
        return direct.strip().lower(), "legacy", None

    legacy_label = resolve_legacy_regime_label(params)
    regime_label = legacy_label if legacy_label is not None else None
    return regime_label, "legacy", None if regime_label is not None else "missing"


def _resolve_decision_regime_label(decision: StrategyDecision) -> Optional[str]:  # pyright: ignore[reportUnusedFunction]
    # kept for backwards compatibility with existing tests and callers
    regime_label, _, _ = _resolve_decision_regime_label_with_source(decision)
    return regime_label


def _allocator_rejection_reasons(decision: StrategyDecision) -> list[str]:
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


def _coerce_strategy_symbols(raw: object) -> set[str]:
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

def _optional_decimal(value: Any) -> Optional[Decimal]:
    if value is None:
        return None
    try:
        return Decimal(str(value))
    except (ArithmeticError, ValueError):
        return None


def _optional_int(value: Any) -> Optional[int]:
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _coerce_bool(value: Any) -> bool | None:
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


def _coerce_runtime_uncertainty_gate_action(
    value: Any,
) -> RuntimeUncertaintyGateAction | None:
    if not isinstance(value, str):
        return None
    normalized = value.strip().lower()
    if normalized in {"pass", "degrade", "abstain", "fail"}:
        return cast(RuntimeUncertaintyGateAction, normalized)
    return None


def _coerce_gateway_timestamp(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, (int, float)):
        try:
            return datetime.fromtimestamp(float(value), tz=timezone.utc)
        except (OverflowError, OSError, ValueError):
            return None
    if not isinstance(value, str):
        return None
    raw_value = value.strip()
    if not raw_value:
        return None
    normalized = raw_value.replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _uncertainty_gate_staleness_reason(
    source: str,
    payload: Mapping[str, Any],
) -> str | None:
    if "generated_at" not in payload:
        return None
    timestamp = _coerce_gateway_timestamp(payload.get("generated_at"))
    if timestamp is None:
        return f"{source}_generated_at_unparseable"
    age_seconds = int((datetime.now(timezone.utc) - timestamp).total_seconds())
    if age_seconds > _RUNTIME_UNCERTAINTY_GATE_MAX_STALENESS_SECONDS:
        return f"{source}_generated_at_stale"
    return None


def _position_qty(symbol: str, positions: list[dict[str, Any]]) -> Decimal:
    total_qty = Decimal("0")
    for position in positions:
        if position.get("symbol") != symbol:
            continue
        qty = _optional_decimal(position.get("qty"))
        if qty is None:
            qty = _optional_decimal(position.get("quantity"))
        if qty is None:
            continue
        side = str(position.get("side") or "").strip().lower()
        if side == "short":
            qty = -abs(qty)
        total_qty += qty
    return total_qty


def _position_market_value(
    symbol: str, positions: list[dict[str, Any]]
) -> Decimal | None:
    total_market_value = Decimal("0")
    has_market_value = False
    for position in positions:
        if position.get("symbol") != symbol:
            continue
        market_value = _optional_decimal(position.get("market_value"))
        if market_value is None:
            continue
        total_market_value += market_value
        has_market_value = True
    if not has_market_value:
        return None
    return total_market_value


def _extract_decision_price(decision: StrategyDecision) -> Decimal | None:
    for key in ("price", "limit_price", "stop_price"):
        value = decision.params.get(key)
        if value is None:
            value = getattr(decision, key, None)
        if value is not None:
            return _optional_decimal(value)
    return None


def _apply_projected_position_decision(
    positions: list[dict[str, Any]],
    decision: StrategyDecision,
) -> None:
    qty = _optional_decimal(decision.qty)
    if qty is None or qty <= 0:
        return
    if decision.action not in {"buy", "sell"}:
        return

    current_qty = _position_qty(decision.symbol, positions)
    current_market_value = _position_market_value(decision.symbol, positions)
    delta = qty if decision.action == "buy" else -qty
    projected_qty = current_qty + delta
    decision_price = _extract_decision_price(decision)
    if decision_price is not None:
        projected_market_value = (current_market_value or Decimal("0")) + (
            delta * decision_price
        )
    else:
        projected_market_value = current_market_value

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


def _is_runtime_risk_increasing_entry(
    decision: StrategyDecision,
    positions: list[dict[str, Any]],
) -> bool:
    qty = _optional_decimal(decision.qty)
    if qty is None or qty <= 0:
        return False
    position_qty = _position_qty(decision.symbol, positions)
    if decision.action == "buy":
        if position_qty < 0:
            return qty > abs(position_qty)
        return True
    if position_qty <= 0:
        return True
    return qty > position_qty


def _hash_payload(payload: dict[str, Any]) -> str:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _normalize_optional_text(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, str):
        normalized = value.strip()
        return normalized or None
    normalized = str(value).strip()
    return normalized or None


def _runtime_dspy_metadata(
    *, artifact_source: str, error: str | None = None
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "mode": settings.llm_dspy_runtime_mode,
        "program_name": settings.llm_dspy_program_name,
        "signature_version": settings.llm_dspy_signature_version,
        "artifact_hash": _normalize_optional_text(settings.llm_dspy_artifact_hash),
        "artifact_source": artifact_source,
    }
    if error is not None and error.strip():
        payload["error"] = error.strip()
    return payload


def _build_dspy_lineage(response_json: Mapping[str, Any]) -> dict[str, Any]:
    payload = response_json.get("dspy")
    dspy_payload: dict[str, Any] = {}
    if isinstance(payload, Mapping):
        dspy_payload = {
            str(key): value for key, value in cast(Mapping[str, Any], payload).items()
        }
    mode = (
        _normalize_optional_text(dspy_payload.get("mode"))
        or settings.llm_dspy_runtime_mode
    )
    program_name = (
        _normalize_optional_text(dspy_payload.get("program_name"))
        or settings.llm_dspy_program_name
    )
    signature_version = (
        _normalize_optional_text(dspy_payload.get("signature_version"))
        or settings.llm_dspy_signature_version
    )
    artifact_hash = _normalize_optional_text(
        dspy_payload.get("artifact_hash")
    ) or _normalize_optional_text(settings.llm_dspy_artifact_hash)
    artifact_source = (
        _normalize_optional_text(dspy_payload.get("artifact_source")) or "runtime"
    )
    return {
        "mode": mode,
        "program_name": program_name,
        "signature_version": signature_version,
        "artifact_hash": artifact_hash,
        "artifact_source": artifact_source,
    }


def _attach_dspy_lineage(
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
        if _normalize_optional_text(dspy_payload.get("artifact_source")) is None:
            dspy_payload["artifact_source"] = artifact_source
        if error is not None and error.strip() and "error" not in dspy_payload:
            dspy_payload["error"] = error.strip()
        response_json["dspy"] = dspy_payload
    else:
        response_json["dspy"] = _runtime_dspy_metadata(
            artifact_source=artifact_source,
            error=error,
        )
    response_json["dspy_lineage"] = _build_dspy_lineage(response_json)


def _committee_trace_has_veto(response_json: Mapping[str, Any]) -> bool:
    committee_payload = response_json.get("committee")
    if not isinstance(committee_payload, Mapping):
        return False
    committee_roles = cast(Mapping[str, Any], committee_payload).get("roles")
    if not isinstance(committee_roles, Mapping):
        return False
    for role_payload in cast(Mapping[str, Any], committee_roles).values():
        if not isinstance(role_payload, Mapping):
            continue
        verdict = _normalize_optional_text(
            cast(Mapping[str, Any], role_payload).get("verdict")
        )
        if verdict == "veto":
            return True
    return False


def _build_committee_veto_alignment_payload(
    *,
    committee_veto: bool,
    deterministic_veto: bool,
) -> dict[str, bool]:
    return {
        "committee_veto": committee_veto,
        "deterministic_veto": deterministic_veto,
        "aligned": (not committee_veto) or deterministic_veto,
    }


def _is_llm_stage_policy_violation(rollout_stage: str) -> bool:
    if rollout_stage == "stage0":
        return (
            settings.llm_enabled
            or not settings.llm_shadow_mode
            or settings.llm_adjustment_allowed
        )
    if rollout_stage == "stage1":
        if not settings.llm_shadow_mode or settings.llm_adjustment_allowed:
            return True
        expected_fail_mode = settings.llm_effective_fail_mode(rollout_stage="stage1")
        return settings.llm_fail_mode != expected_fail_mode
    if rollout_stage == "stage2":
        expected_fail_mode = settings.llm_effective_fail_mode(rollout_stage="stage2")
        return settings.llm_fail_mode != expected_fail_mode
    return False


def _normalize_rollout_stage(stage: str) -> str:
    if stage.startswith("stage0"):
        return "stage0"
    if stage.startswith("stage1"):
        return "stage1"
    if stage.startswith("stage2"):
        return "stage2"
    if stage.startswith("stage3"):
        return "stage3"
    return "stage3"


def _expected_fail_mode_for_stage(rollout_stage: str) -> str:
    if rollout_stage == "stage1":
        return settings.llm_effective_fail_mode(rollout_stage="stage1")
    if rollout_stage == "stage2":
        return settings.llm_effective_fail_mode(rollout_stage="stage2")
    return settings.llm_effective_fail_mode()


def _build_llm_policy_resolution(
    *,
    rollout_stage: str,
    effective_fail_mode: str,
    guardrail_reasons: tuple[str, ...] | list[str],
) -> dict[str, Any]:
    normalized_stage = _normalize_rollout_stage(rollout_stage)
    expected_fail_mode = _expected_fail_mode_for_stage(normalized_stage)
    configured_fail_mode = settings.llm_fail_mode
    stage_policy_violation = _is_llm_stage_policy_violation(normalized_stage)
    fail_mode_override = effective_fail_mode != configured_fail_mode
    fail_mode_exception_active = (
        fail_mode_override
        and not stage_policy_violation
        and bool(settings.llm_policy_exceptions)
        and expected_fail_mode != configured_fail_mode
    )
    fail_mode_violation_active = fail_mode_override and not fail_mode_exception_active
    if fail_mode_violation_active:
        classification = "violation"
    elif fail_mode_exception_active:
        classification = "intentional_exception"
    else:
        classification = "compliant"
    reasoning: list[str] = []
    if stage_policy_violation:
        reasoning.append("rollout_stage_policy_violation")
    if fail_mode_exception_active:
        reasoning.append("intentional_policy_exception")
    if fail_mode_violation_active:
        reasoning.append("unexpected_fail_mode_override")
    if not reasoning:
        reasoning.append("policy_compliant")

    return {
        "classification": classification,
        "rollout_stage": normalized_stage,
        "configured_fail_mode": configured_fail_mode,
        "effective_fail_mode": effective_fail_mode,
        "expected_fail_mode": expected_fail_mode,
        "stage_policy_violation": stage_policy_violation,
        "fail_mode_exception_active": fail_mode_exception_active,
        "fail_mode_violation_active": fail_mode_violation_active,
        "policy_exceptions": list(settings.llm_policy_exceptions),
        "guardrail_reasons": list(guardrail_reasons),
        "reasoning": reasoning,
        "source_inputs": {
            "trading_mode": settings.trading_mode,
            "llm_fail_mode_enforcement": settings.llm_fail_mode_enforcement,
            "llm_live_fail_open_requested": settings.llm_live_fail_open_requested_for_stage(
                normalized_stage
            ),
            "llm_fail_open_live_approved": settings.llm_fail_open_live_approved,
        },
    }


def _llm_guardrail_controls_snapshot() -> dict[str, Any]:
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


__all__ = [
    "_allocator_rejection_reasons",
    "_apply_projected_position_decision",
    "_attach_dspy_lineage",
    "_autonomy_gate_report_is_saturated_fail_sentinel",
    "_build_committee_veto_alignment_payload",
    "_build_dspy_lineage",
    "_build_llm_policy_resolution",
    "_build_portfolio_snapshot",
    "_classify_llm_error",
    "_clone_positions",
    "_coerce_bool",
    "_coerce_gateway_timestamp",
    "_coerce_json",
    "_coerce_runtime_uncertainty_gate_action",
    "_coerce_strategy_symbols",
    "_committee_trace_has_veto",
    "_expected_fail_mode_for_stage",
    "_extract_decision_price",
    "_extract_json_error_payload",
    "_format_order_submit_rejection",
    "_hash_payload",
    "_is_llm_stage_policy_violation",
    "_is_runtime_risk_increasing_entry",
    "_llm_guardrail_controls_snapshot",
    "_load_recent_decisions",
    "_normalize_optional_text",
    "_normalize_rollout_stage",
    "_optional_decimal",
    "_optional_int",
    "_position_market_value",
    "_position_qty",
    "_price_snapshot_payload",
    "_resolve_decision_regime_label",
    "_resolve_decision_regime_label_with_source",
    "_resolve_llm_review_error_reject_reason",
    "_resolve_llm_unavailable_reject_reason",
    "_resolve_signal_regime",
    "_runtime_dspy_metadata",
    "_runtime_uncertainty_gate_rank",
    "_select_strictest_runtime_uncertainty_gate",
    "_uncertainty_gate_staleness_reason",
]
