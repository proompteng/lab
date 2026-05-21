"""Shared live-submission gate helpers for status and runtime paths."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping, Sequence
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from threading import Lock
from typing import Any, cast
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
from urllib.request import Request, urlopen

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..config import settings
from ..models import (
    AutoresearchCandidateSpec,
    AutoresearchEpoch,
    AutoresearchPortfolioCandidate,
    AutoresearchProposalScore,
    ResearchCandidate,
    ResearchPromotion,
    StrategyHypothesis,
    StrategyHypothesisMetricWindow,
    StrategyPromotionDecision,
    TradeDecision,
    VNextDatasetSnapshot,
    VNextPromotionDecision,
)
from .hypotheses import (
    compile_hypothesis_runtime_statuses,
    load_hypothesis_registry,
    resolve_hypothesis_dependency_quorum,
    summarize_hypothesis_runtime_statuses,
)
from .discovery.profit_target_oracle import evaluate_profit_target_oracle
from .profit_windows import build_profit_window_contract
from .profit_leases import build_profit_lease_projection
from .tca import build_tca_gate_inputs

_CAPITAL_STAGE_ORDER = (
    "shadow",
    "0.10x canary",
    "0.25x canary",
    "0.50x live",
    "1.00x live",
)
_LIVE_SUBMISSION_BLOCKING_TOGGLE_MISMATCHES = frozenset(
    {
        "TRADING_ENABLED",
        "TRADING_KILL_SWITCH_ENABLED",
        "TRADING_MODE",
    }
)
_TYPED_QUANT_HEALTH_PATH = "/api/torghut/trading/control-plane/quant/health"
_QUANT_HEALTH_CACHE_LOCK = Lock()
_QUANT_HEALTH_CACHE: dict[str, object] = {}
_STALE_SEGMENT_STATES = frozenset({"stale", "down", "degraded", "error", "blocked"})
_TA_CORE_REASON_CODES = frozenset(
    {
        "feature_rows_missing",
        "no_signal_streak_exceeded",
        "required_feature_set_unavailable",
        "signal_continuity_alert_active",
        "signal_lag_exceeded",
    }
)
_AUTORESEARCH_PORTFOLIO_READY_STATUSES = (
    "paper_candidate",
    "promotion_ready",
    "ready_for_promotion",
    "ready_for_promotion_review",
    "accepted",
    "promoted",
)


def _autoresearch_portfolio_current_oracle_passed(
    row: AutoresearchPortfolioCandidate,
) -> bool:
    scorecard = row.objective_scorecard_json
    if not isinstance(scorecard, Mapping):
        return False
    oracle = evaluate_profit_target_oracle(
        cast(Mapping[str, Any], scorecard),
        target_net_pnl_per_day=row.target_net_pnl_per_day,
    )
    return bool(oracle.get("passed"))


def _safe_int(value: object) -> int:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str) and value.strip():
        try:
            return int(value.strip())
        except ValueError:
            return 0
    return 0


def _safe_decimal(value: object) -> Decimal | None:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, Decimal):
        return value
    text = str(value).strip()
    if not text:
        return None
    try:
        return Decimal(text)
    except (InvalidOperation, ValueError):
        return None


def _safe_bool(value: object) -> bool | None:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"true", "1", "yes", "y", "on"}:
            return True
        if normalized in {"false", "0", "no", "n", "off"}:
            return False
    return None


def _safe_text(value: object) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _normalize_reason_codes(values: Sequence[object]) -> list[str]:
    normalized: list[str] = []
    seen: set[str] = set()
    for value in values:
        item = str(value).strip()
        if not item or item in seen:
            continue
        normalized.append(item)
        seen.add(item)
    return normalized


def _stage_rank(stage: object) -> int:
    text = _safe_text(stage)
    if text is None:
        return -1
    try:
        return _CAPITAL_STAGE_ORDER.index(text)
    except ValueError:
        return -1


def _derive_quant_health_url(
    value: str | None,
    *,
    preserve_path: bool = False,
) -> str | None:
    raw = (value or "").strip()
    if not raw:
        return None
    parsed = urlsplit(raw)
    if not parsed.scheme or not parsed.netloc:
        return None
    path = parsed.path if preserve_path else ""
    query = parsed.query if preserve_path else ""
    if preserve_path and path:
        normalized_path = path if path.startswith("/") else f"/{path}"
        normalized_path = (
            normalized_path.rstrip("/") if normalized_path != "/" else normalized_path
        )
        if not (
            normalized_path == _TYPED_QUANT_HEALTH_PATH
            or normalized_path.endswith(_TYPED_QUANT_HEALTH_PATH)
        ):
            return None
        resolved_path = normalized_path
    else:
        resolved_path = _TYPED_QUANT_HEALTH_PATH
    return urlunsplit(
        (
            parsed.scheme,
            parsed.netloc,
            resolved_path,
            query,
            "",
        )
    )


def resolve_quant_health_url() -> str | None:
    return _derive_quant_health_url(
        settings.trading_jangar_quant_health_url,
        preserve_path=True,
    )


def _build_quant_health_request_url(
    base_url: str,
    *,
    account: str,
    window: str,
) -> str:
    parsed = urlsplit(base_url)
    query_params = dict(parse_qsl(parsed.query, keep_blank_values=True))
    if account:
        query_params["account"] = account
    if window:
        query_params["window"] = window
    query = urlencode(query_params)
    return urlunsplit(
        (
            parsed.scheme,
            parsed.netloc,
            parsed.path,
            query,
            "",
        )
    )


def load_quant_evidence_status(
    *, account_label: str | None = None
) -> dict[str, object]:
    window = settings.trading_jangar_quant_window
    account = (account_label or settings.trading_account_label or "").strip()
    required = bool(settings.trading_jangar_quant_health_required)
    configured_url = _safe_text(settings.trading_jangar_quant_health_url)
    base_url = resolve_quant_health_url()
    if configured_url is not None and not base_url:
        blocking_reasons = ["quant_health_invalid_endpoint"] if required else []
        return {
            "required": required,
            "ok": not required,
            "status": "unknown",
            "reason": "quant_health_invalid_endpoint",
            "blocking_reasons": blocking_reasons,
            "informational_reasons": []
            if required
            else ["quant_health_invalid_endpoint"],
            "account": account or None,
            "window": window,
            "source_url": configured_url,
            "message": (
                "TRADING_JANGAR_QUANT_HEALTH_URL must target the typed "
                f"{_TYPED_QUANT_HEALTH_PATH} surface"
            ),
        }
    if not base_url:
        blocking_reasons = ["quant_health_not_configured"] if required else []
        return {
            "required": required,
            "ok": not required,
            "status": "unknown" if required else "not_required",
            "reason": "quant_health_not_configured",
            "blocking_reasons": blocking_reasons,
            "informational_reasons": []
            if required
            else ["quant_health_not_configured"],
            "account": account or None,
            "window": window,
            "source_url": None,
        }

    request_url = _build_quant_health_request_url(
        base_url,
        account=account,
        window=window,
    )
    cache_key = f"{request_url}|required={int(required)}"
    ttl_seconds = max(0, int(settings.trading_jangar_control_plane_cache_ttl_seconds))
    now = datetime.now(timezone.utc)

    if ttl_seconds > 0:
        with _QUANT_HEALTH_CACHE_LOCK:
            cached = cast(dict[str, Any] | None, _QUANT_HEALTH_CACHE.get(cache_key))
            if cached is not None:
                checked_at = cast(datetime | None, cached.get("checked_at"))
                if checked_at is not None and now - checked_at <= timedelta(
                    seconds=ttl_seconds
                ):
                    return dict(cast(Mapping[str, Any], cached["payload"]))

    status_payload: dict[str, object]
    try:
        request = Request(
            request_url, method="GET", headers={"accept": "application/json"}
        )
        with urlopen(
            request, timeout=settings.trading_jangar_control_plane_timeout_seconds
        ) as response:
            status_code = int(getattr(response, "status", 200))
            if status_code < 200 or status_code >= 300:
                raise RuntimeError(f"quant_health_http_{status_code}")
            decoded = json.loads(response.read().decode("utf-8"))
        if not isinstance(decoded, Mapping):
            raise RuntimeError("quant_health_payload_invalid")
        payload = cast(Mapping[str, Any], decoded)
        if payload.get("ok") is not True:
            message = str(
                payload.get("message") or "quant_health_request_failed"
            ).strip()
            raise RuntimeError(message)
        latest_metrics_count = _safe_int(payload.get("latestMetricsCount"))
        empty_latest_store_alarm = bool(payload.get("emptyLatestStoreAlarm"))
        missing_update_alarm = bool(payload.get("missingUpdateAlarm"))
        stages_raw = payload.get("stages")
        stages = (
            list(cast(Sequence[object], stages_raw))
            if isinstance(stages_raw, Sequence)
            and not isinstance(stages_raw, (str, bytes, bytearray))
            else []
        )
        blocking_reasons: list[str] = []
        if latest_metrics_count <= 0:
            blocking_reasons.append("quant_latest_metrics_empty")
        if empty_latest_store_alarm:
            blocking_reasons.append("quant_latest_store_alarm")
        if missing_update_alarm:
            blocking_reasons.append("quant_metrics_update_missing")
        if len(stages) == 0:
            blocking_reasons.append("quant_pipeline_stages_missing")
        elif any(
            _safe_bool(cast(Mapping[str, Any], stage).get("ok")) is False
            for stage in stages
            if isinstance(stage, Mapping)
        ):
            blocking_reasons.append("quant_pipeline_degraded")

        raw_status = str(payload.get("status") or "").strip().lower()
        if not blocking_reasons and raw_status not in {"ok", "healthy"}:
            blocking_reasons.append("quant_health_degraded")

        status_payload = {
            "required": required,
            "ok": len(blocking_reasons) == 0 or not required,
            "status": "healthy" if len(blocking_reasons) == 0 else "degraded",
            "reason": "ready" if len(blocking_reasons) == 0 else blocking_reasons[0],
            "blocking_reasons": blocking_reasons if required else [],
            "informational_reasons": [] if required else blocking_reasons,
            "account": account or None,
            "window": window,
            "source_url": request_url,
            "latest_metrics_count": latest_metrics_count,
            "latest_metrics_updated_at": payload.get("latestMetricsUpdatedAt"),
            "empty_latest_store_alarm": empty_latest_store_alarm,
            "missing_update_alarm": missing_update_alarm,
            "metrics_pipeline_lag_seconds": payload.get("metricsPipelineLagSeconds"),
            "stage_count": len(stages),
            "max_stage_lag_seconds": payload.get("maxStageLagSeconds"),
            "stages": stages,
            "as_of": payload.get("asOf"),
        }
    except Exception as exc:
        blocking_reasons = ["quant_health_fetch_failed"] if required else []
        status_payload = {
            "required": required,
            "ok": not required,
            "status": "unknown",
            "reason": "quant_health_fetch_failed",
            "blocking_reasons": blocking_reasons,
            "informational_reasons": [] if required else ["quant_health_fetch_failed"],
            "account": account or None,
            "window": window,
            "source_url": request_url,
            "message": str(exc),
            "latest_metrics_count": None,
            "latest_metrics_updated_at": None,
            "empty_latest_store_alarm": None,
            "missing_update_alarm": None,
            "metrics_pipeline_lag_seconds": None,
            "stage_count": None,
            "max_stage_lag_seconds": None,
            "stages": [],
            "as_of": None,
        }

    if ttl_seconds > 0:
        with _QUANT_HEALTH_CACHE_LOCK:
            _QUANT_HEALTH_CACHE[cache_key] = {
                "checked_at": now,
                "payload": dict(status_payload),
            }
    return dict(status_payload)


def critical_trading_toggle_snapshot() -> dict[str, object]:
    return {
        "TRADING_ENABLED": settings.trading_enabled,
        "TRADING_AUTONOMY_ENABLED": settings.trading_autonomy_enabled,
        "TRADING_AUTONOMY_ALLOW_LIVE_PROMOTION": settings.trading_autonomy_allow_live_promotion,
        "TRADING_KILL_SWITCH_ENABLED": settings.trading_kill_switch_enabled,
        "TRADING_MODE": settings.trading_mode,
    }


def build_shadow_first_toggle_parity() -> dict[str, object]:
    expected = {
        "TRADING_ENABLED": True,
        "TRADING_AUTONOMY_ENABLED": False,
        "TRADING_AUTONOMY_ALLOW_LIVE_PROMOTION": False,
        "TRADING_KILL_SWITCH_ENABLED": False,
        "TRADING_MODE": "live",
    }
    effective = critical_trading_toggle_snapshot()
    mismatches = [
        key
        for key, expected_value in expected.items()
        if effective.get(key) != expected_value
    ]
    return {
        "status": "aligned" if not mismatches else "diverged",
        "mismatches": mismatches,
        "expected": expected,
        "effective": effective,
    }


def resolve_active_capital_stage(
    hypothesis_summary: Mapping[str, Any] | None,
) -> str | None:
    if not isinstance(hypothesis_summary, Mapping):
        return None
    totals_raw = hypothesis_summary.get("capital_stage_totals")
    if not isinstance(totals_raw, Mapping):
        return None
    totals = cast(Mapping[str, Any], totals_raw)
    for stage in reversed(_CAPITAL_STAGE_ORDER):
        count = totals.get(stage)
        if isinstance(count, int) and count > 0:
            return stage
    return "shadow" if totals else None


def build_hypothesis_runtime_summary(
    session: Session,
    *,
    state: object,
    market_context_status: Mapping[str, Any],
    tca_summary: Mapping[str, Any] | None = None,
    dependency_quorum: Any | None = None,
    feature_readiness: Mapping[str, Any] | None = None,
) -> dict[str, object]:
    registry = load_hypothesis_registry()
    if dependency_quorum is None:
        dependency_quorum = resolve_hypothesis_dependency_quorum(registry)
    items = compile_hypothesis_runtime_statuses(
        registry=registry,
        state=state,
        tca_summary=tca_summary
        if tca_summary is not None
        else build_tca_gate_inputs(
            session=session,
            account_label=settings.trading_account_label,
        ),
        market_context_status=market_context_status,
        jangar_dependency_quorum=dependency_quorum,
        feature_readiness=feature_readiness,
        market_session_open=cast(
            bool | None, getattr(state, "market_session_open", None)
        ),
        route_symbol_filter_enabled=settings.trading_pipeline_mode == "simple",
    )
    evidence = _load_latest_certificate_evidence(
        session,
        hypothesis_ids=[item.hypothesis_id for item in registry.items],
    )
    items = _merge_runtime_certificate_evidence(
        items,
        evidence=evidence,
        now=datetime.now(timezone.utc),
        max_age_seconds=max(
            0, int(settings.trading_drift_live_promotion_max_evidence_age_seconds)
        ),
    )
    summary = summarize_hypothesis_runtime_statuses(
        items,
        registry=registry,
        dependency_quorum=dependency_quorum,
    )
    summary["items"] = items
    return summary


def _extract_runtime_summary(
    hypothesis_summary: Mapping[str, Any] | None,
) -> tuple[Mapping[str, Any], list[Mapping[str, Any]]]:
    if not isinstance(hypothesis_summary, Mapping):
        return {}, []
    nested_summary = hypothesis_summary.get("summary")
    if isinstance(nested_summary, Mapping):
        items_raw = hypothesis_summary.get("items")
        items = (
            [
                cast(Mapping[str, Any], item)
                for item in cast(Sequence[object], items_raw)
                if isinstance(item, Mapping)
            ]
            if isinstance(items_raw, Sequence)
            and not isinstance(items_raw, (str, bytes, bytearray))
            else []
        )
        return cast(Mapping[str, Any], nested_summary), items
    items_raw = hypothesis_summary.get("items")
    items = (
        [
            cast(Mapping[str, Any], item)
            for item in cast(Sequence[object], items_raw)
            if isinstance(item, Mapping)
        ]
        if isinstance(items_raw, Sequence)
        and not isinstance(items_raw, (str, bytes, bytearray))
        else []
    )
    return hypothesis_summary, items


def _refresh_runtime_summary_totals(
    summary: Mapping[str, Any],
    runtime_items: Sequence[Mapping[str, Any]],
) -> dict[str, object]:
    state_totals: dict[str, int] = {}
    reason_totals: dict[str, int] = {}
    informational_reason_totals: dict[str, int] = {}
    capital_stage_totals: dict[str, int] = {}
    capital_multiplier_by_hypothesis: dict[str, str] = {}
    promotion_eligible_total = 0
    rollback_required_total = 0

    for item in runtime_items:
        state = str(item.get("state") or "unknown")
        state_totals[state] = state_totals.get(state, 0) + 1

        capital_stage = str(item.get("capital_stage") or "shadow")
        capital_stage_totals[capital_stage] = (
            capital_stage_totals.get(capital_stage, 0) + 1
        )

        hypothesis_id = str(item.get("hypothesis_id") or "unknown")
        capital_multiplier_by_hypothesis[hypothesis_id] = str(
            item.get("capital_multiplier") or "0"
        )

        if bool(item.get("promotion_eligible")):
            promotion_eligible_total += 1
        if bool(item.get("rollback_required")):
            rollback_required_total += 1

        for reason in cast(Sequence[object], item.get("reasons") or []):
            reason_code = str(reason).strip()
            if reason_code:
                reason_totals[reason_code] = reason_totals.get(reason_code, 0) + 1
        for reason in cast(Sequence[object], item.get("informational_reasons") or []):
            reason_code = str(reason).strip()
            if reason_code:
                informational_reason_totals[reason_code] = (
                    informational_reason_totals.get(reason_code, 0) + 1
                )

    refreshed = dict(summary)
    refreshed.update(
        {
            "hypotheses_total": len(runtime_items),
            "state_totals": dict(sorted(state_totals.items())),
            "reason_totals": dict(sorted(reason_totals.items())),
            "informational_reason_totals": dict(
                sorted(informational_reason_totals.items())
            ),
            "capital_stage_totals": dict(sorted(capital_stage_totals.items())),
            "capital_multiplier_by_hypothesis": capital_multiplier_by_hypothesis,
            "promotion_eligible_total": promotion_eligible_total,
            "rollback_required_total": rollback_required_total,
            "items": list(runtime_items),
        }
    )
    return refreshed


def build_submission_gate_market_context_status(state: object) -> dict[str, object]:
    return {
        "last_symbol": getattr(state, "last_market_context_symbol", None),
        "last_checked_at": getattr(state, "last_market_context_checked_at", None),
        "last_as_of": getattr(state, "last_market_context_as_of", None),
        "last_freshness_seconds": getattr(
            state, "last_market_context_freshness_seconds", None
        ),
        "last_domain_states": dict(
            cast(
                Mapping[str, str],
                getattr(state, "last_market_context_domain_states", {}),
            )
        ),
        "last_risk_flags": list(
            cast(Sequence[str], getattr(state, "last_market_context_risk_flags", []))
        ),
        "alert_active": bool(getattr(state, "market_context_alert_active", False)),
        "alert_reason": getattr(state, "market_context_alert_reason", None),
    }


def _load_latest_certificate_evidence(
    session: Session,
    *,
    hypothesis_ids: Sequence[str],
) -> list[dict[str, object]]:
    normalized_ids = [
        hypothesis_id for hypothesis_id in hypothesis_ids if hypothesis_id
    ]
    if not normalized_ids:
        return []

    latest_windows: dict[str, StrategyHypothesisMetricWindow] = {}
    window_rows = session.execute(
        select(StrategyHypothesisMetricWindow)
        .where(StrategyHypothesisMetricWindow.hypothesis_id.in_(normalized_ids))
        .order_by(
            StrategyHypothesisMetricWindow.window_ended_at.desc().nullslast(),
            StrategyHypothesisMetricWindow.created_at.desc(),
        )
    ).scalars()
    for row in window_rows:
        if row.hypothesis_id in latest_windows:
            continue
        latest_windows[row.hypothesis_id] = row

    latest_promotions: dict[str, list[StrategyPromotionDecision]] = {}
    promotion_rows = session.execute(
        select(StrategyPromotionDecision)
        .where(
            StrategyPromotionDecision.hypothesis_id.in_(normalized_ids),
            StrategyPromotionDecision.allowed.is_(True),
        )
        .order_by(StrategyPromotionDecision.created_at.desc())
    ).scalars()
    for row in promotion_rows:
        latest_promotions.setdefault(row.hypothesis_id, []).append(row)

    evidence: list[dict[str, object]] = []
    for hypothesis_id in normalized_ids:
        metric_window = latest_windows.get(hypothesis_id)
        promotion_decision = None
        for decision in latest_promotions.get(hypothesis_id, []):
            if metric_window is None or _promotion_decision_matches_metric_window(
                decision,
                metric_window=metric_window,
            ):
                promotion_decision = decision
                break
        evidence.append(
            {
                "hypothesis_id": hypothesis_id,
                "metric_window": metric_window,
                "promotion_decision": promotion_decision,
            }
        )
    return evidence


def _promotion_decision_matches_metric_window(
    promotion_decision: StrategyPromotionDecision,
    *,
    metric_window: StrategyHypothesisMetricWindow,
) -> bool:
    if _safe_text(promotion_decision.run_id) != _safe_text(metric_window.run_id):
        return False
    if _safe_text(promotion_decision.hypothesis_id) != _safe_text(
        metric_window.hypothesis_id
    ):
        return False
    if _safe_text(promotion_decision.candidate_id) != _safe_text(
        metric_window.candidate_id
    ):
        return False
    if _safe_text(promotion_decision.promotion_target) != _safe_text(
        metric_window.observed_stage
    ):
        return False
    return True


def _window_evidence_issued_at(
    metric_window: StrategyHypothesisMetricWindow,
) -> datetime | None:
    return _coerce_aware_datetime(
        metric_window.window_ended_at or metric_window.created_at
    )


def _certificate_evidence_is_fresh(
    metric_window: StrategyHypothesisMetricWindow,
    *,
    max_age_seconds: int,
    now: datetime,
) -> bool:
    issued_at = _window_evidence_issued_at(metric_window)
    if issued_at is None:
        return False
    return max_age_seconds <= 0 or issued_at >= now - timedelta(seconds=max_age_seconds)


def _certificate_capital_stage(
    metric_window: StrategyHypothesisMetricWindow,
    promotion_decision: StrategyPromotionDecision,
) -> str | None:
    window_stage = _safe_text(metric_window.capital_stage)
    decision_stage = _safe_text(promotion_decision.state)
    ranked_stages = [
        stage
        for stage in (window_stage, decision_stage)
        if stage is not None and _stage_rank(stage) >= 0
    ]
    if not ranked_stages:
        return None
    return min(ranked_stages, key=_stage_rank)


def _metric_window_activity_reason_codes(
    metric_window: StrategyHypothesisMetricWindow,
) -> list[str]:
    reasons: list[str] = []
    if _safe_int(metric_window.market_session_count) <= 0:
        reasons.append("hypothesis_window_market_sessions_missing")
    if _safe_int(metric_window.decision_count) <= 0:
        reasons.append("hypothesis_window_decisions_missing")
    if _safe_int(metric_window.trade_count) <= 0:
        reasons.append("hypothesis_window_trades_missing")
    if _safe_int(metric_window.order_count) <= 0:
        reasons.append("hypothesis_window_orders_missing")

    expectancy_bps = _safe_decimal(metric_window.post_cost_expectancy_bps)
    if expectancy_bps is None or expectancy_bps <= 0:
        reasons.append("hypothesis_window_post_cost_expectancy_non_positive")
    payload_raw = getattr(metric_window, "payload_json", None)
    payload: Mapping[str, object] = (
        cast(Mapping[str, object], payload_raw)
        if isinstance(payload_raw, Mapping)
        else cast(Mapping[str, object], {})
    )
    basis_counts: object | None = payload.get("post_cost_basis_counts")
    if (
        isinstance(basis_counts, Mapping)
        and _safe_int(payload.get("post_cost_promotion_sample_count")) <= 0
    ):
        reasons.append("hypothesis_window_post_cost_pnl_basis_missing")

    avg_abs_slippage_bps = _safe_decimal(metric_window.avg_abs_slippage_bps)
    slippage_budget_bps = _safe_decimal(metric_window.slippage_budget_bps)
    if (
        avg_abs_slippage_bps is not None
        and slippage_budget_bps is not None
        and avg_abs_slippage_bps > slippage_budget_bps
    ):
        reasons.append("hypothesis_window_slippage_budget_exceeded")
    return reasons


def _merge_runtime_certificate_evidence(
    items: Sequence[Mapping[str, Any]],
    *,
    evidence: Sequence[Mapping[str, object]],
    now: datetime,
    max_age_seconds: int,
) -> list[dict[str, object]]:
    evidence_by_hypothesis = {
        str(row.get("hypothesis_id") or "").strip(): row
        for row in evidence
        if str(row.get("hypothesis_id") or "").strip()
    }
    merged: list[dict[str, object]] = []
    for item in items:
        updated: dict[str, object] = dict(item)
        hypothesis_id = str(updated.get("hypothesis_id") or "").strip()
        row = evidence_by_hypothesis.get(hypothesis_id)
        if not row:
            merged.append(updated)
            continue

        metric_window = cast(
            StrategyHypothesisMetricWindow | None, row.get("metric_window")
        )
        promotion_decision = cast(
            StrategyPromotionDecision | None, row.get("promotion_decision")
        )
        if metric_window is None or promotion_decision is None:
            merged.append(updated)
            continue
        if _safe_bool(getattr(promotion_decision, "allowed", True)) is False:
            merged.append(updated)
            continue
        if not _certificate_evidence_is_fresh(
            metric_window,
            max_age_seconds=max_age_seconds,
            now=now,
        ):
            merged.append(updated)
            continue
        if not bool(metric_window.continuity_ok) or not bool(metric_window.drift_ok):
            merged.append(updated)
            continue
        if _safe_text(metric_window.dependency_quorum_decision) != "allow":
            merged.append(updated)
            continue
        activity_reason_codes = _metric_window_activity_reason_codes(metric_window)
        if activity_reason_codes:
            observed = (
                dict(cast(Mapping[str, Any], updated.get("observed")))
                if isinstance(updated.get("observed"), Mapping)
                else {}
            )
            observed.update(
                {
                    "runtime_window_certificate_rejected": True,
                    "runtime_window_rejection_reasons": activity_reason_codes,
                    "metric_window_id": str(metric_window.id),
                    "promotion_decision_id": str(promotion_decision.id),
                    "metric_window_market_session_count": metric_window.market_session_count,
                    "metric_window_decision_count": metric_window.decision_count,
                    "metric_window_trade_count": metric_window.trade_count,
                    "metric_window_order_count": metric_window.order_count,
                    "metric_window_avg_abs_slippage_bps": metric_window.avg_abs_slippage_bps,
                    "metric_window_post_cost_expectancy_bps": metric_window.post_cost_expectancy_bps,
                }
            )
            prior_reasons = [
                str(reason).strip()
                for reason in cast(Sequence[object], updated.get("reasons") or [])
                if str(reason).strip()
            ]
            updated["reasons"] = _normalize_reason_codes(
                [*prior_reasons, *activity_reason_codes]
            )
            updated["informational_reasons"] = sorted(
                {
                    *[
                        str(reason)
                        for reason in cast(
                            Sequence[object],
                            updated.get("informational_reasons") or [],
                        )
                        if str(reason).strip()
                    ],
                    "runtime_window_certificate_rejected",
                }
            )
            updated["observed"] = observed
            merged.append(updated)
            continue

        capital_stage = _certificate_capital_stage(metric_window, promotion_decision)
        if capital_stage is None:
            merged.append(updated)
            continue
        if _stage_rank(capital_stage) <= _stage_rank("shadow"):
            if _safe_text(getattr(metric_window, "observed_stage", None)) != "paper":
                merged.append(updated)
                continue
            issued_at = _window_evidence_issued_at(metric_window)
            candidate_id = (
                _safe_text(metric_window.candidate_id)
                or _safe_text(promotion_decision.candidate_id)
                or _safe_text(updated.get("candidate_id"))
            )
            observed = (
                dict(cast(Mapping[str, Any], updated.get("observed")))
                if isinstance(updated.get("observed"), Mapping)
                else {}
            )
            observed.update(
                {
                    "runtime_window_certificate_readiness_applied": True,
                    "runtime_window_prior_reasons": list(
                        cast(Sequence[object], updated.get("reasons") or [])
                    ),
                    "metric_window_id": str(metric_window.id),
                    "promotion_decision_id": str(promotion_decision.id),
                    "metric_window_issued_at": issued_at.isoformat()
                    if issued_at is not None
                    else None,
                    "metric_window_market_session_count": metric_window.market_session_count,
                    "metric_window_decision_count": metric_window.decision_count,
                    "metric_window_trade_count": metric_window.trade_count,
                    "metric_window_order_count": metric_window.order_count,
                    "metric_window_avg_abs_slippage_bps": metric_window.avg_abs_slippage_bps,
                    "metric_window_post_cost_expectancy_bps": metric_window.post_cost_expectancy_bps,
                }
            )
            if candidate_id is not None:
                updated["candidate_id"] = candidate_id
            updated.update(
                {
                    "state": "shadow",
                    "capital_stage": capital_stage or "shadow",
                    "capital_multiplier": "0",
                    "promotion_eligible": True,
                    "rollback_required": False,
                    "reasons": [],
                    "informational_reasons": sorted(
                        {
                            *[
                                str(reason)
                                for reason in cast(
                                    Sequence[object],
                                    updated.get("informational_reasons") or [],
                                )
                                if str(reason).strip()
                            ],
                            "runtime_window_certificate_readiness_applied",
                        }
                    ),
                    "promotion_decision_id": str(promotion_decision.id),
                    "metric_window_id": str(metric_window.id),
                    "observed": observed,
                }
            )
            merged.append(updated)
            continue

        issued_at = _window_evidence_issued_at(metric_window)
        candidate_id = (
            _safe_text(metric_window.candidate_id)
            or _safe_text(promotion_decision.candidate_id)
            or _safe_text(updated.get("candidate_id"))
        )
        observed = (
            dict(cast(Mapping[str, Any], updated.get("observed")))
            if isinstance(updated.get("observed"), Mapping)
            else {}
        )
        observed.update(
            {
                "runtime_window_certificate_applied": True,
                "runtime_window_prior_reasons": list(
                    cast(Sequence[object], updated.get("reasons") or [])
                ),
                "metric_window_id": str(metric_window.id),
                "promotion_decision_id": str(promotion_decision.id),
                "metric_window_issued_at": issued_at.isoformat()
                if issued_at is not None
                else None,
                "metric_window_market_session_count": metric_window.market_session_count,
                "metric_window_decision_count": metric_window.decision_count,
                "metric_window_trade_count": metric_window.trade_count,
                "metric_window_order_count": metric_window.order_count,
                "metric_window_avg_abs_slippage_bps": metric_window.avg_abs_slippage_bps,
                "metric_window_post_cost_expectancy_bps": metric_window.post_cost_expectancy_bps,
            }
        )
        if candidate_id is not None:
            updated["candidate_id"] = candidate_id
        updated.update(
            {
                "state": "canary_live"
                if _stage_rank(capital_stage) < _stage_rank("0.50x live")
                else "scaled_live",
                "capital_stage": capital_stage,
                "capital_multiplier": {
                    "0.10x canary": "0.10",
                    "0.25x canary": "0.25",
                    "0.50x live": "0.50",
                    "1.00x live": "1.00",
                }.get(capital_stage, str(updated.get("capital_multiplier") or "0")),
                "promotion_eligible": True,
                "rollback_required": False,
                "reasons": [],
                "informational_reasons": sorted(
                    {
                        *[
                            str(reason)
                            for reason in cast(
                                Sequence[object],
                                updated.get("informational_reasons") or [],
                            )
                            if str(reason).strip()
                        ],
                        "runtime_window_certificate_applied",
                    }
                ),
                "promotion_decision_id": str(promotion_decision.id),
                "metric_window_id": str(metric_window.id),
                "observed": observed,
            }
        )
        merged.append(updated)
    return merged


def _segment_summary(
    *,
    state: object,
    runtime_items: Sequence[Mapping[str, Any]],
    blocking_toggle_mismatches: Sequence[str],
    empirical_ready: bool | None,
    dspy_mode: str,
    dspy_live_ready: bool | None,
) -> dict[str, dict[str, object]]:
    market_context_ref = build_submission_gate_market_context_status(state)
    domain_states = {
        str(key): str(value).strip().lower()
        for key, value in cast(
            Mapping[str, Any], market_context_ref.get("last_domain_states", {})
        ).items()
        if str(key).strip()
    }
    market_context_reasons: list[str] = []
    if bool(market_context_ref.get("alert_active")):
        market_context_reasons.append(
            str(market_context_ref.get("alert_reason") or "market_context_alert_active")
        )
    stale_domains = [
        domain
        for domain, segment_state in sorted(domain_states.items())
        if segment_state in _STALE_SEGMENT_STATES
    ]
    market_context_reasons.extend(
        [
            f"market_context_domain_{domain}_{domain_states[domain]}"
            for domain in stale_domains
        ]
    )

    ta_core_reasons: list[str] = []
    if bool(getattr(state, "signal_continuity_alert_active", False)):
        ta_core_reasons.append("signal_continuity_alert_active")
    if (
        _safe_int(getattr(getattr(state, "metrics", None), "signal_lag_seconds", None))
        > 0
    ):
        signal_lag = _safe_int(
            getattr(getattr(state, "metrics", None), "signal_lag_seconds", None)
        )
        if signal_lag > 0 and bool(
            getattr(state, "signal_continuity_alert_active", False)
        ):
            ta_core_reasons.append("signal_lag_exceeded")
    for item in runtime_items:
        item_reasons = [
            str(reason).strip()
            for reason in cast(Sequence[object], item.get("reasons") or [])
            if str(reason).strip() in _TA_CORE_REASON_CODES
        ]
        ta_core_reasons.extend(item_reasons)

    execution_reasons = (
        ["critical_toggle_parity_diverged"] if list(blocking_toggle_mismatches) else []
    )
    empirical_reasons = (
        [] if empirical_ready is not False else ["empirical_jobs_not_ready"]
    )
    llm_review_reasons: list[str] = []
    if dspy_mode == "active" and dspy_live_ready is False:
        llm_review_reasons.append("dspy_live_runtime_not_ready")

    raw_segments = {
        "market-context": market_context_reasons,
        "ta-core": ta_core_reasons,
        "execution": execution_reasons,
        "empirical": empirical_reasons,
        "llm-review": llm_review_reasons,
    }
    return {
        segment: {
            "state": "ok" if not reasons else "blocked",
            "reason_codes": _normalize_reason_codes(reasons),
        }
        for segment, reasons in sorted(raw_segments.items())
    }


def _evaluate_certificate_candidates(
    *,
    evidence: Sequence[Mapping[str, object]],
    segment_summary: Mapping[str, Mapping[str, object]],
    runtime_items: Sequence[Mapping[str, Any]],
    registry_items: Sequence[Mapping[str, object]],
    max_age_seconds: int,
    now: datetime,
    window: str | None,
    account: str | None,
) -> tuple[list[dict[str, object]], list[dict[str, object]]]:
    manifests = {
        str(item.get("hypothesis_id") or ""): item
        for item in registry_items
        if str(item.get("hypothesis_id") or "").strip()
    }
    runtime_by_hypothesis = {
        str(item.get("hypothesis_id") or ""): item
        for item in runtime_items
        if str(item.get("hypothesis_id") or "").strip()
    }
    evaluated: list[dict[str, object]] = []
    valid: list[dict[str, object]] = []
    for row in evidence:
        hypothesis_id = str(row.get("hypothesis_id") or "").strip()
        if not hypothesis_id:
            continue
        manifest = cast(Mapping[str, Any], manifests.get(hypothesis_id) or {})
        runtime_item = cast(
            Mapping[str, Any], runtime_by_hypothesis.get(hypothesis_id) or {}
        )
        metric_window = cast(
            StrategyHypothesisMetricWindow | None, row.get("metric_window")
        )
        promotion_decision = cast(
            StrategyPromotionDecision | None, row.get("promotion_decision")
        )
        reasons: list[str] = []
        metric_window_id: str | None = None
        promotion_decision_id: str | None = None
        candidate_id = None
        capital_stage = None
        issued_at = None

        if metric_window is None:
            reasons.append("hypothesis_window_evidence_missing")
        else:
            metric_window_id = str(metric_window.id)
            candidate_id = metric_window.candidate_id
            capital_stage = metric_window.capital_stage
            issued_at = metric_window.window_ended_at or metric_window.created_at
            if issued_at.tzinfo is None:
                issued_at = issued_at.replace(tzinfo=timezone.utc)
            if max_age_seconds > 0 and issued_at < now - timedelta(
                seconds=max_age_seconds
            ):
                reasons.append("hypothesis_window_evidence_stale")
            if not bool(metric_window.continuity_ok):
                reasons.append("hypothesis_window_continuity_failed")
            if not bool(metric_window.drift_ok):
                reasons.append("hypothesis_window_drift_failed")
            if _safe_text(metric_window.dependency_quorum_decision) != "allow":
                reasons.append("hypothesis_window_dependency_quorum_not_allow")
            reasons.extend(_metric_window_activity_reason_codes(metric_window))

        if promotion_decision is None:
            reasons.append("promotion_decision_evidence_missing")
        else:
            promotion_decision_id = str(promotion_decision.id)
            if candidate_id is None:
                candidate_id = promotion_decision.candidate_id
            if capital_stage is None:
                capital_stage = promotion_decision.state
        if candidate_id is None:
            candidate_id = _safe_text(manifest.get("candidate_id"))
        if _safe_text(capital_stage) in {None, "shadow"}:
            reasons.append("promotion_certificate_shadow_only")

        segment_dependencies = [
            str(segment).strip()
            for segment in cast(
                Sequence[object], manifest.get("segment_dependencies") or []
            )
            if str(segment).strip()
        ]
        blocked_segments: list[str] = []
        if runtime_item:
            if not bool(runtime_item.get("promotion_eligible")):
                reasons.append("alpha_hypothesis_not_promotion_eligible")
            runtime_stage = _safe_text(runtime_item.get("capital_stage"))
            if runtime_stage in {None, "shadow"}:
                reasons.append("alpha_hypothesis_shadow_only")
        elif runtime_items:
            reasons.append("alpha_hypothesis_runtime_missing")
        for segment in segment_dependencies:
            segment_payload = cast(
                Mapping[str, Any], segment_summary.get(segment) or {}
            )
            if str(segment_payload.get("state") or "").strip() != "ok":
                blocked_segments.append(segment)
                reasons.extend(
                    [
                        f"segment_{segment}_blocked",
                        *cast(Sequence[str], segment_payload.get("reason_codes") or []),
                    ]
                )

        evaluated_row: dict[str, object] = {
            "hypothesis_id": hypothesis_id,
            "candidate_id": candidate_id,
            "strategy_id": manifest.get("strategy_id")
            or manifest.get("strategy_family"),
            "dataset_snapshot_ref": manifest.get("dataset_snapshot_ref"),
            "account": account,
            "window": window,
            "capital_state": capital_stage or "observe",
            "capital_stage": capital_stage or "shadow",
            "segment_dependencies": segment_dependencies,
            "blocked_segments": sorted(set(blocked_segments)),
            "reason_codes": _normalize_reason_codes(reasons),
            "metric_window_id": metric_window_id,
            "promotion_decision_id": promotion_decision_id,
            "issued_at": issued_at,
            "expires_at": (
                issued_at + timedelta(seconds=max_age_seconds)
                if issued_at is not None and max_age_seconds > 0
                else None
            ),
        }
        evaluated.append(evaluated_row)
        if not evaluated_row["reason_codes"]:
            valid.append(evaluated_row)
    return evaluated, valid


def _default_lineage_ref(
    *,
    status: str = "unverified",
    candidate_id: str | None = None,
    hypothesis_id: str | None = None,
) -> dict[str, object]:
    return {
        "status": status,
        "candidate_id": candidate_id,
        "hypothesis_id": hypothesis_id,
        "dataset_snapshot_count": 0,
        "dataset_snapshot_id": None,
        "dataset_snapshot_ref": None,
        "dataset_snapshot_run_id": None,
        "strategy_hypothesis_count": 0,
        "strategy_hypothesis_id": None,
        "lane_id": None,
        "strategy_family": None,
    }


def _attach_lineage_refs(
    session: Session,
    *,
    evaluated_rows: Sequence[Mapping[str, object]],
) -> list[dict[str, object]]:
    candidate_ids = sorted(
        {
            candidate_id
            for row in evaluated_rows
            if (candidate_id := _safe_text(row.get("candidate_id"))) is not None
        }
    )
    hypothesis_ids = sorted(
        {
            hypothesis_id
            for row in evaluated_rows
            if (hypothesis_id := _safe_text(row.get("hypothesis_id"))) is not None
        }
    )

    dataset_snapshots_by_candidate: dict[str, list[VNextDatasetSnapshot]] = {}
    if candidate_ids:
        dataset_rows = (
            session.execute(
                select(VNextDatasetSnapshot)
                .where(VNextDatasetSnapshot.candidate_id.in_(candidate_ids))
                .order_by(VNextDatasetSnapshot.created_at.desc())
            )
            .scalars()
            .all()
        )
        for row in dataset_rows:
            candidate_id = _safe_text(row.candidate_id)
            if candidate_id is None:
                continue
            dataset_snapshots_by_candidate.setdefault(candidate_id, []).append(row)

    hypotheses_by_id: dict[str, list[StrategyHypothesis]] = {}
    if hypothesis_ids:
        hypothesis_rows = (
            session.execute(
                select(StrategyHypothesis)
                .where(
                    StrategyHypothesis.hypothesis_id.in_(hypothesis_ids),
                    StrategyHypothesis.active.is_(True),
                )
                .order_by(StrategyHypothesis.created_at.desc())
            )
            .scalars()
            .all()
        )
        for row in hypothesis_rows:
            hypothesis_id = _safe_text(row.hypothesis_id)
            if hypothesis_id is None:
                continue
            hypotheses_by_id.setdefault(hypothesis_id, []).append(row)

    attached_rows: list[dict[str, object]] = []
    for row in evaluated_rows:
        evaluated_row = dict(row)
        candidate_id = _safe_text(evaluated_row.get("candidate_id"))
        hypothesis_id = _safe_text(evaluated_row.get("hypothesis_id"))
        reason_codes = list(
            cast(Sequence[str], evaluated_row.get("reason_codes") or [])
        )

        dataset_rows = (
            dataset_snapshots_by_candidate.get(candidate_id, [])
            if candidate_id is not None
            else []
        )
        declared_dataset_snapshot_ref = _safe_text(
            evaluated_row.get("dataset_snapshot_ref")
        )
        hypothesis_rows = (
            hypotheses_by_id.get(hypothesis_id, []) if hypothesis_id is not None else []
        )

        if (
            candidate_id is not None
            and not dataset_rows
            and declared_dataset_snapshot_ref is None
        ):
            reason_codes.append("dataset_snapshot_missing")
        if hypothesis_id is not None and not hypothesis_rows:
            reason_codes.append("strategy_hypothesis_missing")

        dataset_row = dataset_rows[0] if dataset_rows else None
        hypothesis_row = hypothesis_rows[0] if hypothesis_rows else None
        lineage_missing = (
            candidate_id is not None
            and not dataset_rows
            and declared_dataset_snapshot_ref is None
        ) or (hypothesis_id is not None and not hypothesis_rows)
        lineage_ref = _default_lineage_ref(
            status=(
                "missing"
                if lineage_missing
                else "manifest_declared"
                if declared_dataset_snapshot_ref is not None and not dataset_rows
                else "ready"
            ),
            candidate_id=candidate_id,
            hypothesis_id=hypothesis_id,
        )
        lineage_ref.update(
            {
                "dataset_snapshot_count": len(dataset_rows),
                "dataset_snapshot_id": (
                    str(dataset_row.id) if dataset_row is not None else None
                ),
                "dataset_snapshot_ref": (
                    dataset_row.artifact_ref
                    if dataset_row is not None
                    else declared_dataset_snapshot_ref
                ),
                "dataset_snapshot_run_id": (
                    dataset_row.run_id if dataset_row is not None else None
                ),
                "strategy_hypothesis_count": len(hypothesis_rows),
                "strategy_hypothesis_id": (
                    str(hypothesis_row.id) if hypothesis_row is not None else None
                ),
                "lane_id": hypothesis_row.lane_id
                if hypothesis_row is not None
                else None,
                "strategy_family": (
                    hypothesis_row.strategy_family
                    if hypothesis_row is not None
                    else None
                ),
            }
        )

        evaluated_row["reason_codes"] = _normalize_reason_codes(reason_codes)
        evaluated_row["lineage_ref"] = lineage_ref
        attached_rows.append(evaluated_row)

    return attached_rows


def _load_profit_promotion_table_counts(session: Session) -> dict[str, Any]:
    portfolio_rows = list(
        session.execute(select(AutoresearchPortfolioCandidate)).scalars()
    )
    current_oracle_ready = 0
    current_policy_blocked = 0
    ready_refs: set[str] = set()
    ready_source_candidate_ids: set[str] = set()
    for row in portfolio_rows:
        current_oracle_passed = _autoresearch_portfolio_current_oracle_passed(row)
        if (
            row.status in _AUTORESEARCH_PORTFOLIO_READY_STATUSES
            and current_oracle_passed
        ):
            current_oracle_ready += 1
            if portfolio_candidate_id := _safe_text(row.portfolio_candidate_id):
                ready_refs.add(f"portfolio_candidate_id:{portfolio_candidate_id}")
            raw_source_candidate_ids = row.source_candidate_ids_json
            if isinstance(raw_source_candidate_ids, Sequence) and not isinstance(
                raw_source_candidate_ids, (str, bytes, bytearray)
            ):
                for raw_source_id in cast(Sequence[object], raw_source_candidate_ids):
                    source_candidate_id = _safe_text(raw_source_id)
                    if source_candidate_id is None:
                        continue
                    ready_source_candidate_ids.add(source_candidate_id)
                    ready_refs.add(f"source_candidate_id:{source_candidate_id}")
                    ready_refs.add(f"candidate_spec_id:{source_candidate_id}")
        if (
            row.status not in _AUTORESEARCH_PORTFOLIO_READY_STATUSES
            or not current_oracle_passed
        ):
            current_policy_blocked += 1

    if ready_source_candidate_ids:
        spec_rows = session.execute(
            select(AutoresearchCandidateSpec).where(
                AutoresearchCandidateSpec.candidate_spec_id.in_(
                    sorted(ready_source_candidate_ids)
                )
            )
        ).scalars()
        for spec_row in spec_rows:
            if hypothesis_id := _safe_text(spec_row.hypothesis_id):
                ready_refs.add(f"hypothesis_id:{hypothesis_id}")

    return {
        "research_candidates": int(
            session.execute(select(func.count(ResearchCandidate.id))).scalar_one()
        ),
        "research_promotions": int(
            session.execute(select(func.count(ResearchPromotion.id))).scalar_one()
        ),
        "strategy_promotion_decisions": int(
            session.execute(
                select(func.count(StrategyPromotionDecision.id))
            ).scalar_one()
        ),
        "vnext_promotion_decisions": int(
            session.execute(select(func.count(VNextPromotionDecision.id))).scalar_one()
        ),
        "autoresearch_epochs": int(
            session.execute(select(func.count(AutoresearchEpoch.id))).scalar_one()
        ),
        "autoresearch_candidate_specs": int(
            session.execute(
                select(func.count(AutoresearchCandidateSpec.id))
            ).scalar_one()
        ),
        "autoresearch_proposal_scores": int(
            session.execute(
                select(func.count(AutoresearchProposalScore.id))
            ).scalar_one()
        ),
        "autoresearch_portfolio_candidates": int(
            session.execute(
                select(func.count(AutoresearchPortfolioCandidate.id))
            ).scalar_one()
        ),
        "autoresearch_portfolio_ready": current_oracle_ready,
        "autoresearch_portfolio_blocked": current_policy_blocked,
        "autoresearch_portfolio_ready_refs": sorted(ready_refs),
    }


def _coerce_aware_datetime(value: object) -> datetime | None:
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, str) and value.strip():
        normalized = value.strip()
        if normalized.endswith("Z"):
            normalized = f"{normalized[:-1]}+00:00"
        try:
            parsed = datetime.fromisoformat(normalized)
        except ValueError:
            return None
    else:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _build_profit_data_readiness_summary(
    state: object,
    *,
    clickhouse_ta_status: Mapping[str, Any] | None = None,
) -> dict[str, object]:
    metrics = getattr(state, "metrics", None)
    rows = _safe_int(getattr(metrics, "feature_batch_rows_total", 0))
    symbols = 0
    source_ref = "scheduler.metrics.feature_batch_rows_total"
    observed_at = None
    fresh_until = None
    clickhouse_status = (
        dict(clickhouse_ta_status) if isinstance(clickhouse_ta_status, Mapping) else {}
    )
    clickhouse_rows = _safe_int(
        clickhouse_status.get("signal_rows")
        or clickhouse_status.get("equity_ta_rows")
        or clickhouse_status.get("row_count")
        or clickhouse_status.get("rows")
        or 0
    )
    clickhouse_symbols = _safe_int(
        clickhouse_status.get("symbol_count")
        or clickhouse_status.get("equity_ta_symbols")
        or clickhouse_status.get("symbols")
        or 0
    )
    if rows <= 0 and clickhouse_rows > 0:
        rows = clickhouse_rows
        symbols = clickhouse_symbols
        source_ref = (
            _safe_text(clickhouse_status.get("source_ref")) or "clickhouse:ta_signals"
        )
        observed_at = _coerce_aware_datetime(
            clickhouse_status.get("latest_signal_at")
            or clickhouse_status.get("readiness_window_end")
            or clickhouse_status.get("as_of")
        )
        fresh_until = _coerce_aware_datetime(clickhouse_status.get("fresh_until"))
        if fresh_until is None and observed_at is not None:
            fresh_until = observed_at + timedelta(
                milliseconds=max(1, settings.trading_feature_max_staleness_ms)
            )
    null_rate = getattr(metrics, "feature_null_rate", {}) if metrics else {}
    staleness_ms_p95 = _safe_int(getattr(metrics, "feature_staleness_ms_p95", 0))
    duplicate_ratio = getattr(metrics, "feature_duplicate_ratio", None)
    return {
        "equity_ta_rows": rows,
        "equity_ta_symbols": symbols,
        "equity_ta_source_ref": source_ref,
        "observed_at": observed_at,
        "fresh_until": fresh_until,
        "feature_null_rate": dict(cast(Mapping[str, float], null_rate))
        if isinstance(null_rate, Mapping)
        else {},
        "feature_staleness_ms_p95": staleness_ms_p95,
        "feature_duplicate_ratio": duplicate_ratio,
    }


def _load_persisted_profit_rejection_summary(
    session: Session,
    *,
    account_label: str | None,
    now: datetime,
) -> dict[str, object]:
    lookback_start = now - timedelta(days=7)
    filters = [TradeDecision.created_at >= lookback_start]
    if account_label:
        filters.append(TradeDecision.alpaca_account_label == account_label)
    rows = session.execute(
        select(TradeDecision.status, func.count())
        .where(*filters)
        .group_by(TradeDecision.status)
    ).all()
    status_totals: dict[str, int] = {}
    for status, count in rows:
        normalized = str(status or "unknown").strip().lower() or "unknown"
        status_totals[normalized] = status_totals.get(normalized, 0) + _safe_int(count)
    rejected = status_totals.get("rejected", 0)
    blocked = status_totals.get("blocked", 0)
    filled = status_totals.get("filled", 0)
    planned = status_totals.get("planned", 0) + status_totals.get("submitted", 0)
    total = sum(status_totals.values())
    rejection_drag_ratio = (
        float(rejected + blocked) / float(total) if total > 0 else None
    )
    return {
        "rejected": rejected,
        "blocked": blocked,
        "filled": filled,
        "planned": planned,
        "total": total,
        "rejection_drag_ratio": rejection_drag_ratio,
        "status_totals": status_totals,
        "source_ref": "postgres:trade_decisions:7d",
    }


def _build_profit_rejection_summary(
    state: object,
    *,
    session: Session | None = None,
    account_label: str | None = None,
    now: datetime | None = None,
) -> dict[str, object]:
    metrics = getattr(state, "metrics", None)
    state_totals = getattr(metrics, "decision_state_total", {}) if metrics else {}
    decision_state_total = (
        dict(cast(Mapping[str, int], state_totals))
        if isinstance(state_totals, Mapping)
        else {}
    )
    rejected = _safe_int(decision_state_total.get("rejected"))
    blocked = _safe_int(decision_state_total.get("blocked"))
    filled = _safe_int(decision_state_total.get("filled"))
    planned = _safe_int(decision_state_total.get("planned"))
    total = sum(_safe_int(value) for value in decision_state_total.values())
    if total == 0:
        total = rejected + blocked + filled + planned
    if total <= 0 and session is not None:
        return _load_persisted_profit_rejection_summary(
            session,
            account_label=account_label,
            now=now or datetime.now(timezone.utc),
        )
    rejection_drag_ratio = (
        float(rejected + blocked) / float(total) if total > 0 else None
    )
    return {
        "rejected": rejected,
        "blocked": blocked,
        "filled": filled,
        "planned": planned,
        "total": total,
        "rejection_drag_ratio": rejection_drag_ratio,
        "source_ref": "scheduler.metrics.decision_state_total",
    }


def _build_profit_live_controls(state: object) -> dict[str, object]:
    rollback_ready = not bool(getattr(state, "emergency_stop_active", False)) and bool(
        getattr(state, "rollback_incident_evidence_path", None)
    )
    live_submission_enabled = (
        settings.trading_mode == "live"
        and settings.trading_enabled
        and not settings.trading_kill_switch_enabled
        and settings.trading_autonomy_allow_live_promotion
    )
    return {
        "live_submission_enabled": live_submission_enabled,
        "rollback_ready": rollback_ready,
        "deployer_approved": False,
    }


def build_live_submission_gate_payload(
    state: object,
    *,
    hypothesis_summary: Mapping[str, Any] | None,
    empirical_jobs_status: Mapping[str, Any] | None = None,
    dspy_runtime_status: Mapping[str, Any] | None = None,
    quant_health_status: Mapping[str, Any] | None = None,
    quant_account_label: str | None = None,
    session: Session | None = None,
    promotion_certificate_evidence: Sequence[Mapping[str, object]] | None = None,
    clickhouse_ta_status: Mapping[str, Any] | None = None,
) -> dict[str, object]:
    summary: Mapping[str, Any] = hypothesis_summary or {}
    summary, runtime_items = _extract_runtime_summary(hypothesis_summary)
    dependency_quorum_payload: dict[str, Any] = (
        dict(cast(Mapping[str, Any], summary.get("dependency_quorum")))
        if isinstance(summary.get("dependency_quorum"), Mapping)
        else {}
    )
    dependency_decision = (
        str(dependency_quorum_payload.get("decision") or "").strip().lower()
        or "unknown"
    )
    empirical_ready = (
        bool(empirical_jobs_status.get("ready"))
        if isinstance(empirical_jobs_status, Mapping)
        else None
    )
    dspy_mode = (
        str(dspy_runtime_status.get("mode") or "").strip().lower()
        if isinstance(dspy_runtime_status, Mapping)
        else ""
    )
    dspy_live_ready = (
        bool(dspy_runtime_status.get("live_ready"))
        if isinstance(dspy_runtime_status, Mapping) and dspy_mode == "active"
        else None
    )
    configured_live_promotion = bool(settings.trading_autonomy_allow_live_promotion)
    autonomy_promotion_eligible = bool(
        getattr(state, "last_autonomy_promotion_eligible", False)
    )
    autonomy_promotion_action = getattr(state, "last_autonomy_promotion_action", None)
    drift_live_promotion_eligible = bool(
        getattr(state, "drift_live_promotion_eligible", False)
    )
    critical_toggle_parity = build_shadow_first_toggle_parity()
    critical_toggle_mismatches = list(
        cast(list[str], critical_toggle_parity.get("mismatches") or [])
    )
    quant_evidence = (
        dict(quant_health_status)
        if isinstance(quant_health_status, Mapping)
        else load_quant_evidence_status(account_label=quant_account_label)
    )
    quant_required = bool(quant_evidence.get("required"))
    quant_ready = bool(quant_evidence.get("ok"))
    quant_reason = str(quant_evidence.get("reason") or "").strip() or "unknown"
    quant_blocking_reasons = [
        str(item).strip()
        for item in cast(Sequence[object], quant_evidence.get("blocking_reasons") or [])
        if str(item).strip()
    ]
    blocking_toggle_mismatches = [
        mismatch
        for mismatch in critical_toggle_mismatches
        if mismatch in _LIVE_SUBMISSION_BLOCKING_TOGGLE_MISMATCHES
    ]
    market_context_ref = build_submission_gate_market_context_status(state)
    max_age_seconds = max(
        0, int(settings.trading_drift_live_promotion_max_evidence_age_seconds)
    )
    now = datetime.now(timezone.utc)
    registry = load_hypothesis_registry()
    evidence_rows = (
        [dict(item) for item in promotion_certificate_evidence]
        if promotion_certificate_evidence is not None
        else _load_latest_certificate_evidence(
            session,
            hypothesis_ids=[item.hypothesis_id for item in registry.items],
        )
        if session is not None
        else []
    )
    readiness_evidence_rows: list[Mapping[str, object]] = []
    for row in evidence_rows:
        metric_window = cast(
            StrategyHypothesisMetricWindow | None, row.get("metric_window")
        )
        promotion_decision = cast(
            StrategyPromotionDecision | None, row.get("promotion_decision")
        )
        if metric_window is None or promotion_decision is None:
            continue
        if _safe_text(getattr(metric_window, "observed_stage", None)) != "paper":
            continue
        if _certificate_capital_stage(metric_window, promotion_decision) != "shadow":
            continue
        readiness_evidence_rows.append(row)
    if runtime_items and readiness_evidence_rows:
        runtime_items = _merge_runtime_certificate_evidence(
            runtime_items,
            evidence=readiness_evidence_rows,
            now=now,
            max_age_seconds=max_age_seconds,
        )
        summary = _refresh_runtime_summary_totals(summary, runtime_items)
    promotion_eligible_total = _safe_int(summary.get("promotion_eligible_total"))
    active_capital_stage = resolve_active_capital_stage(summary)
    segment_summary = _segment_summary(
        state=state,
        runtime_items=runtime_items,
        blocking_toggle_mismatches=blocking_toggle_mismatches,
        empirical_ready=empirical_ready,
        dspy_mode=dspy_mode,
        dspy_live_ready=dspy_live_ready,
    )
    promotion_table_counts = (
        _load_profit_promotion_table_counts(session) if session is not None else {}
    )
    profit_lease_projection = build_profit_lease_projection(
        runtime_items=runtime_items,
        quant_evidence=quant_evidence,
        empirical_jobs_status=empirical_jobs_status,
        dependency_quorum=dependency_quorum_payload,
        rejection_summary=_build_profit_rejection_summary(
            state,
            session=session,
            account_label=_safe_text(quant_evidence.get("account"))
            or quant_account_label,
            now=now,
        ),
        promotion_table_counts=promotion_table_counts,
        data_readiness=_build_profit_data_readiness_summary(
            state,
            clickhouse_ta_status=clickhouse_ta_status,
        ),
        live_controls=_build_profit_live_controls(state),
        account=_safe_text(quant_evidence.get("account")),
        window=_safe_text(quant_evidence.get("window")),
        now=now,
    )

    if settings.trading_mode != "live":
        profit_window_contract = build_profit_window_contract(
            runtime_items=runtime_items,
            quant_evidence=quant_evidence,
            empirical_jobs_status=empirical_jobs_status,
            market_context_ref=market_context_ref,
            segment_summary=segment_summary,
            account=_safe_text(quant_evidence.get("account")),
            window=_safe_text(quant_evidence.get("window")),
            market_session_open=getattr(state, "market_session_open", None),
            replay=bool(getattr(state, "simulation_replay_active", False)),
            now=now,
        )
        return {
            "allowed": True,
            "reason": "non_live_mode",
            "blocked_reasons": [],
            "certificate_id": None,
            "capital_stage": settings.trading_mode,
            "capital_state": settings.trading_mode,
            "issued_at": None,
            "expires_at": None,
            "configured_live_promotion": configured_live_promotion,
            "autonomy_promotion_eligible": autonomy_promotion_eligible,
            "autonomy_promotion_action": autonomy_promotion_action,
            "drift_live_promotion_eligible": drift_live_promotion_eligible,
            "promotion_eligible_total": promotion_eligible_total,
            "dependency_quorum_decision": dependency_decision,
            "empirical_jobs_ready": empirical_ready,
            "dspy_live_ready": dspy_live_ready,
            "critical_toggle_parity": critical_toggle_parity,
            "critical_toggle_parity_blocking_mismatches": blocking_toggle_mismatches,
            "active_capital_stage": active_capital_stage,
            "reason_codes": ["non_live_mode"],
            "quant_evidence": quant_evidence,
            "segment_summary": segment_summary,
            "quant_health_ref": {
                "account": quant_evidence.get("account"),
                "window": quant_evidence.get("window"),
                "status": quant_evidence.get("status"),
                "source_url": quant_evidence.get("source_url"),
                "latest_metrics_updated_at": quant_evidence.get(
                    "latest_metrics_updated_at"
                ),
            },
            "market_context_ref": market_context_ref,
            "evidence_tuple": {
                "hypothesis_id": None,
                "candidate_id": None,
                "strategy_id": None,
                "account": quant_evidence.get("account"),
                "window": quant_evidence.get("window"),
                "capital_state": settings.trading_mode,
            },
            "lineage_ref": _default_lineage_ref(),
            "evaluated_tuples": [],
            "profit_window_contract": profit_window_contract,
            "profit_lease_projection": profit_lease_projection,
        }

    blocked_reasons: list[str] = []
    if blocking_toggle_mismatches:
        blocked_reasons.append("critical_toggle_parity_diverged")
    if promotion_eligible_total <= 0:
        blocked_reasons.append("alpha_readiness_not_promotion_eligible")
    if empirical_ready is False:
        blocked_reasons.append("empirical_jobs_not_ready")
    if dspy_live_ready is False:
        blocked_reasons.append("dspy_live_runtime_not_ready")
    if dependency_decision != "allow":
        blocked_reasons.append(f"dependency_quorum_{dependency_decision}")
    if quant_required and not quant_ready:
        blocked_reasons.extend(quant_blocking_reasons or [quant_reason])

    evaluated_tuples, valid_candidates = _evaluate_certificate_candidates(
        evidence=evidence_rows,
        segment_summary=segment_summary,
        runtime_items=runtime_items,
        registry_items=[item.model_dump(mode="json") for item in registry.items],
        max_age_seconds=max_age_seconds,
        now=now,
        window=_safe_text(quant_evidence.get("window")),
        account=_safe_text(quant_evidence.get("account")),
    )
    if session is not None and evaluated_tuples:
        evaluated_tuples = _attach_lineage_refs(
            session,
            evaluated_rows=evaluated_tuples,
        )
        valid_candidates = [
            item for item in evaluated_tuples if not item.get("reason_codes")
        ]

    if promotion_eligible_total > 0 and not valid_candidates:
        if not evaluated_tuples:
            blocked_reasons.append("promotion_certificate_missing")
            blocked_reasons.append("hypothesis_window_evidence_missing")
        else:
            candidate_reason_codes = [
                reason
                for item in evaluated_tuples
                for reason in cast(Sequence[str], item.get("reason_codes") or [])
            ]
            blocked_reasons.extend(candidate_reason_codes)
            blocked_reasons.append("promotion_certificate_missing")

    blocked_reasons = _normalize_reason_codes(blocked_reasons)

    chosen_candidate = (
        max(valid_candidates, key=lambda item: _stage_rank(item.get("capital_stage")))
        if valid_candidates
        else None
    )
    allowed = chosen_candidate is not None and not blocked_reasons

    certificate_id: str | None = None
    issued_at = None
    expires_at = None
    capital_stage = "shadow"
    capital_state = "observe"
    reason_codes: list[str]
    reason = blocked_reasons[0] if blocked_reasons else "promotion_certificate_missing"
    if allowed and chosen_candidate is not None:
        capital_stage = str(chosen_candidate.get("capital_stage") or "shadow")
        capital_state = capital_stage
        issued_at = chosen_candidate.get("issued_at")
        expires_at = chosen_candidate.get("expires_at")
        certificate_basis = "|".join(
            [
                str(chosen_candidate.get("hypothesis_id") or ""),
                str(chosen_candidate.get("candidate_id") or ""),
                str(chosen_candidate.get("strategy_id") or ""),
                str(chosen_candidate.get("account") or ""),
                str(chosen_candidate.get("window") or ""),
                capital_state,
                str(chosen_candidate.get("metric_window_id") or ""),
                str(chosen_candidate.get("promotion_decision_id") or ""),
            ]
        )
        certificate_id = hashlib.sha256(certificate_basis.encode("utf-8")).hexdigest()[
            :24
        ]
        reason = "promotion_certificate_valid"
        reason_codes = ["promotion_certificate_valid"]
    else:
        reason_codes = blocked_reasons or ["promotion_certificate_missing"]

    evidence_tuple = {
        "hypothesis_id": chosen_candidate.get("hypothesis_id")
        if chosen_candidate
        else None,
        "candidate_id": chosen_candidate.get("candidate_id")
        if chosen_candidate
        else None,
        "strategy_id": chosen_candidate.get("strategy_id")
        if chosen_candidate
        else None,
        "account": quant_evidence.get("account"),
        "window": quant_evidence.get("window"),
        "capital_state": capital_state,
    }
    lineage_ref = _default_lineage_ref(
        status="missing" if evaluated_tuples else "unverified",
    )
    if chosen_candidate is not None and isinstance(
        chosen_candidate.get("lineage_ref"),
        Mapping,
    ):
        lineage_ref = dict(
            cast(Mapping[str, object], chosen_candidate.get("lineage_ref"))
        )
    elif evaluated_tuples and isinstance(
        evaluated_tuples[0].get("lineage_ref"), Mapping
    ):
        lineage_ref = dict(
            cast(Mapping[str, object], evaluated_tuples[0].get("lineage_ref"))
        )

    profit_window_contract = build_profit_window_contract(
        runtime_items=runtime_items,
        quant_evidence=quant_evidence,
        empirical_jobs_status=empirical_jobs_status,
        market_context_ref=market_context_ref,
        segment_summary=segment_summary,
        lineage_ref=lineage_ref,
        account=_safe_text(quant_evidence.get("account")),
        window=_safe_text(quant_evidence.get("window")),
        market_session_open=getattr(state, "market_session_open", None),
        replay=bool(getattr(state, "simulation_replay_active", False)),
        now=now,
    )

    return {
        "allowed": allowed,
        "reason": reason,
        "blocked_reasons": blocked_reasons,
        "certificate_id": certificate_id,
        "capital_stage": capital_stage,
        "capital_state": capital_state,
        "issued_at": issued_at,
        "expires_at": expires_at,
        "configured_live_promotion": configured_live_promotion,
        "autonomy_promotion_eligible": autonomy_promotion_eligible,
        "autonomy_promotion_action": autonomy_promotion_action,
        "drift_live_promotion_eligible": drift_live_promotion_eligible,
        "promotion_eligible_total": promotion_eligible_total,
        "dependency_quorum_decision": dependency_decision,
        "empirical_jobs_ready": empirical_ready,
        "dspy_live_ready": dspy_live_ready,
        "critical_toggle_parity": critical_toggle_parity,
        "critical_toggle_parity_blocking_mismatches": blocking_toggle_mismatches,
        "active_capital_stage": active_capital_stage,
        "reason_codes": reason_codes,
        "quant_evidence": quant_evidence,
        "segment_summary": {
            "segments": segment_summary,
            "evaluated_hypotheses": evaluated_tuples,
        },
        "quant_health_ref": {
            "account": quant_evidence.get("account"),
            "window": quant_evidence.get("window"),
            "status": quant_evidence.get("status"),
            "source_url": quant_evidence.get("source_url"),
            "latest_metrics_updated_at": quant_evidence.get(
                "latest_metrics_updated_at"
            ),
        },
        "market_context_ref": market_context_ref,
        "evidence_tuple": evidence_tuple,
        "lineage_ref": lineage_ref,
        "evaluated_tuples": evaluated_tuples,
        "profit_window_contract": profit_window_contract,
        "profit_lease_projection": profit_lease_projection,
    }


__all__ = [
    "build_hypothesis_runtime_summary",
    "build_live_submission_gate_payload",
    "build_shadow_first_toggle_parity",
    "build_submission_gate_market_context_status",
    "critical_trading_toggle_snapshot",
    "load_quant_evidence_status",
    "resolve_active_capital_stage",
    "resolve_quant_health_url",
]
