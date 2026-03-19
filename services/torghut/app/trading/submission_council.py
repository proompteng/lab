"""Shared live-submission gate helpers for status and runtime paths."""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from datetime import datetime, timedelta, timezone
from threading import Lock
from typing import Any, cast
from urllib.parse import urlencode, urlsplit, urlunsplit
from urllib.request import Request, urlopen

from sqlalchemy.orm import Session

from ..config import settings
from .hypotheses import (
    compile_hypothesis_runtime_statuses,
    load_hypothesis_registry,
    load_jangar_dependency_quorum,
    summarize_hypothesis_runtime_statuses,
)
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
_QUANT_HEALTH_CACHE_LOCK = Lock()
_QUANT_HEALTH_CACHE: dict[str, object] = {}


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


def _derive_quant_health_url(value: str | None) -> str | None:
    raw = (value or "").strip()
    if not raw:
        return None
    parsed = urlsplit(raw)
    if not parsed.scheme or not parsed.netloc:
        return None
    return urlunsplit(
        (
            parsed.scheme,
            parsed.netloc,
            "/api/torghut/trading/control-plane/quant/health",
            "",
            "",
        )
    )


def resolve_quant_health_url() -> str | None:
    for candidate in (
        settings.trading_jangar_quant_health_url,
        settings.trading_jangar_control_plane_status_url,
        settings.trading_market_context_url,
    ):
        resolved = _derive_quant_health_url(candidate)
        if resolved:
            return resolved
    return None


def load_quant_evidence_status(
    *, account_label: str | None = None
) -> dict[str, object]:
    window = settings.trading_jangar_quant_window
    account = (account_label or settings.trading_account_label or "").strip()
    base_url = resolve_quant_health_url()
    if not base_url:
        return {
            "required": False,
            "ok": True,
            "status": "skipped",
            "reason": "quant_health_not_configured",
            "blocking_reasons": [],
            "account": account or None,
            "window": window,
            "source_url": None,
        }

    query = urlencode({"account": account, "window": window})
    request_url = f"{base_url}?{query}" if query else base_url
    ttl_seconds = max(0, int(settings.trading_jangar_control_plane_cache_ttl_seconds))
    now = datetime.now(timezone.utc)

    if ttl_seconds > 0:
        with _QUANT_HEALTH_CACHE_LOCK:
            cached = cast(dict[str, Any] | None, _QUANT_HEALTH_CACHE.get(request_url))
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
            "required": True,
            "ok": len(blocking_reasons) == 0,
            "status": "healthy" if len(blocking_reasons) == 0 else "degraded",
            "reason": "ready" if len(blocking_reasons) == 0 else blocking_reasons[0],
            "blocking_reasons": blocking_reasons,
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
        status_payload = {
            "required": True,
            "ok": False,
            "status": "unknown",
            "reason": "quant_health_fetch_failed",
            "blocking_reasons": ["quant_health_fetch_failed"],
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
            _QUANT_HEALTH_CACHE[request_url] = {
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
        "TRADING_EXECUTION_ADAPTER_POLICY": settings.trading_execution_adapter_policy,
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
) -> dict[str, object]:
    registry = load_hypothesis_registry()
    dependency_quorum = load_jangar_dependency_quorum()
    items = compile_hypothesis_runtime_statuses(
        registry=registry,
        state=state,
        tca_summary=build_tca_gate_inputs(session=session),
        market_context_status=market_context_status,
        jangar_dependency_quorum=dependency_quorum,
    )
    return summarize_hypothesis_runtime_statuses(
        items,
        registry=registry,
        dependency_quorum=dependency_quorum,
    )


def build_submission_gate_market_context_status(state: object) -> dict[str, object]:
    return {
        "last_freshness_seconds": getattr(
            state, "last_market_context_freshness_seconds", None
        ),
    }


def build_live_submission_gate_payload(
    state: object,
    *,
    hypothesis_summary: Mapping[str, Any] | None,
    empirical_jobs_status: Mapping[str, Any] | None = None,
    dspy_runtime_status: Mapping[str, Any] | None = None,
    quant_health_status: Mapping[str, Any] | None = None,
    quant_account_label: str | None = None,
) -> dict[str, object]:
    summary: Mapping[str, Any] = hypothesis_summary or {}
    dependency_quorum_payload: dict[str, Any] = (
        dict(cast(Mapping[str, Any], summary.get("dependency_quorum")))
        if isinstance(summary.get("dependency_quorum"), Mapping)
        else {}
    )
    dependency_decision = (
        str(dependency_quorum_payload.get("decision") or "").strip().lower()
        or "unknown"
    )
    promotion_eligible_total = _safe_int(summary.get("promotion_eligible_total"))
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
    active_capital_stage = resolve_active_capital_stage(summary)
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
    if settings.trading_mode != "live":
        return {
            "allowed": True,
            "reason": "non_live_mode",
            "blocked_reasons": [],
            "capital_stage": settings.trading_mode,
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
            "capital_state": settings.trading_mode,
            "reason_codes": ["non_live_mode"],
            "quant_evidence": quant_evidence,
            "segment_summary": dependency_quorum_payload,
            "quant_health_ref": {
                "account": quant_evidence.get("account"),
                "window": quant_evidence.get("window"),
                "status": quant_evidence.get("status"),
                "source_url": quant_evidence.get("source_url"),
                "latest_metrics_updated_at": quant_evidence.get(
                    "latest_metrics_updated_at"
                ),
            },
            "market_context_ref": build_submission_gate_market_context_status(state),
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
    if (
        not configured_live_promotion
        and not autonomy_promotion_eligible
        and not drift_live_promotion_eligible
    ):
        blocked_reasons.append("live_promotion_disabled")

    allowed = len(blocked_reasons) == 0
    if allowed and active_capital_stage == "shadow":
        active_capital_stage = "0.10x canary"
    allowed_reason = "ready"
    if configured_live_promotion:
        allowed_reason = "configured_live_promotion"
    elif autonomy_promotion_eligible:
        allowed_reason = "autonomy_promotion_eligible"
    elif drift_live_promotion_eligible:
        allowed_reason = "drift_live_promotion_eligible"
    capital_state = active_capital_stage if allowed else "observe"

    return {
        "allowed": allowed,
        "reason": allowed_reason if allowed else blocked_reasons[0],
        "blocked_reasons": blocked_reasons,
        "capital_stage": active_capital_stage,
        "capital_state": capital_state,
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
        "reason_codes": [allowed_reason] if allowed else blocked_reasons,
        "quant_evidence": quant_evidence,
        "segment_summary": dependency_quorum_payload,
        "quant_health_ref": {
            "account": quant_evidence.get("account"),
            "window": quant_evidence.get("window"),
            "status": quant_evidence.get("status"),
            "source_url": quant_evidence.get("source_url"),
            "latest_metrics_updated_at": quant_evidence.get(
                "latest_metrics_updated_at"
            ),
        },
        "market_context_ref": build_submission_gate_market_context_status(state),
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
