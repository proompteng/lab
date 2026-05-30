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
    StrategyRuntimeLedgerBucket,
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
from .market_context_domains import (
    active_market_context_mapping,
    active_market_context_reasons,
)
from .discovery.profit_target_oracle import evaluate_profit_target_oracle
from .profit_windows import build_profit_window_contract
from .profit_leases import build_profit_lease_projection
from .runtime_ledger import POST_COST_PNL_BASIS
from .runtime_ledger_source_authority import (
    runtime_ledger_promotion_source_authority_blockers,
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
_RUNTIME_LEDGER_REPAIR_SCAN_LIMIT = 256
_RUNTIME_LEDGER_REPAIR_CANDIDATE_LIMIT = 8
_RUNTIME_WINDOW_IMPORT_CONTINUITY_READY_STATES = frozenset(
    {
        "signals_present",
        "expected_market_closed_staleness",
    }
)


def _runtime_window_import_continuity_signal(state: object) -> tuple[str, str, str]:
    state_text = _safe_attr_text(state, "last_signal_continuity_state")
    reason = _safe_attr_text(state, "last_signal_continuity_reason")
    actionable = _safe_bool(getattr(state, "last_signal_continuity_actionable", None))
    alert_active = bool(getattr(state, "signal_continuity_alert_active", False))
    alert_reason = _safe_attr_text(state, "signal_continuity_alert_reason")
    if alert_active:
        return (
            "false",
            "signal_continuity",
            alert_reason or "signal_continuity_alert_active",
        )
    if actionable is True:
        return (
            "false",
            "signal_continuity",
            reason or state_text or "signal_continuity_actionable",
        )
    if state_text in _RUNTIME_WINDOW_IMPORT_CONTINUITY_READY_STATES:
        return "true", "signal_continuity", state_text
    if actionable is False and state_text:
        return "true", "signal_continuity", state_text
    return "false", "missing", "signal_continuity_missing"


def _runtime_window_import_drift_signal(state: object) -> tuple[str, str, str]:
    if hasattr(state, "drift_live_promotion_eligible"):
        eligible = bool(getattr(state, "drift_live_promotion_eligible", False))
        return (
            "true" if eligible else "false",
            "drift_live_promotion_eligible",
            "drift_live_promotion_eligible"
            if eligible
            else "drift_live_promotion_ineligible",
        )
    return "false", "missing", "drift_live_promotion_eligible_missing"


def _runtime_window_import_health_gate_inputs(
    state: object,
    *,
    dependency_quorum_decision: str,
) -> dict[str, object]:
    continuity_ok, continuity_source, continuity_reason = (
        _runtime_window_import_continuity_signal(state)
    )
    drift_ok, drift_source, drift_reason = _runtime_window_import_drift_signal(state)
    blockers: list[str] = []
    promotion_blockers: list[str] = []
    if dependency_quorum_decision != "allow":
        blockers.append("dependency_quorum_not_allow")
    if continuity_source == "missing":
        blockers.append("runtime_window_import_continuity_missing")
    elif continuity_ok != "true":
        blockers.append("evidence_continuity_not_ok")
    if drift_source == "missing":
        promotion_blockers.append("runtime_window_import_drift_missing")
    elif drift_ok != "true":
        promotion_blockers.append("drift_checks_not_ok")
    return {
        "continuity_ok": continuity_ok,
        "continuity_source": continuity_source,
        "continuity_reason": continuity_reason,
        "drift_ok": drift_ok,
        "drift_source": drift_source,
        "drift_reason": drift_reason,
        "runtime_window_import_health_gate": {
            "schema_version": "torghut.runtime-window-import-health-gate.v1",
            "source": "live_submission_gate",
            "dependency_quorum_decision": dependency_quorum_decision,
            "dependency_quorum_source": "dependency_quorum",
            "continuity_ok": continuity_ok,
            "continuity_source": continuity_source,
            "continuity_reason": continuity_reason,
            "drift_ok": drift_ok,
            "drift_source": drift_source,
            "drift_reason": drift_reason,
            "ready": not blockers,
            "blockers": blockers,
            "promotion_blockers": promotion_blockers,
        },
        "runtime_window_import_health_gate_blockers": blockers,
        "runtime_window_import_promotion_blockers": promotion_blockers,
    }


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


def _safe_attr_text(value: object, name: str) -> str | None:
    return _safe_text(cast(object, getattr(value, name, None)))


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
    runtime_ledger_summary = _load_latest_runtime_ledger_summary(
        session,
        hypothesis_ids=[item.hypothesis_id for item in registry.items],
    )
    items = compile_hypothesis_runtime_statuses(
        registry=registry,
        state=state,
        tca_summary=tca_summary
        if tca_summary is not None
        else build_tca_gate_inputs(
            session=session,
            account_label=settings.trading_account_label,
        ),
        runtime_ledger_summary=runtime_ledger_summary,
        market_context_status=market_context_status,
        jangar_dependency_quorum=dependency_quorum,
        feature_readiness=feature_readiness,
        market_session_open=cast(
            bool | None, getattr(state, "market_session_open", None)
        ),
        route_symbol_filter_enabled=settings.trading_pipeline_mode == "simple",
    )
    max_age_seconds = max(
        0, int(settings.trading_drift_live_promotion_max_evidence_age_seconds)
    )
    now = datetime.now(timezone.utc)
    evidence = _load_latest_certificate_evidence(
        session,
        hypothesis_ids=[item.hypothesis_id for item in registry.items],
        now=now,
        max_age_seconds=max_age_seconds,
    )
    items = _merge_runtime_certificate_evidence(
        items,
        evidence=evidence,
        now=now,
        max_age_seconds=max_age_seconds,
    )
    summary = summarize_hypothesis_runtime_statuses(
        items,
        registry=registry,
        dependency_quorum=dependency_quorum,
    )
    summary["items"] = items
    return summary


def _runtime_ledger_bucket_payload(
    row: StrategyRuntimeLedgerBucket,
) -> dict[str, object]:
    payload_json: Mapping[str, object]
    raw_payload_json: object = row.payload_json
    if isinstance(raw_payload_json, Mapping):
        payload_json = {
            str(key): value
            for key, value in cast(Mapping[object, object], raw_payload_json).items()
        }
    else:
        payload_json = {}
    return {
        "run_id": row.run_id,
        "candidate_id": row.candidate_id,
        "hypothesis_id": row.hypothesis_id,
        "observed_stage": row.observed_stage,
        "bucket_started_at": row.bucket_started_at.isoformat(),
        "bucket_ended_at": row.bucket_ended_at.isoformat(),
        "account_label": row.account_label,
        "runtime_strategy_name": row.runtime_strategy_name,
        "strategy_family": row.strategy_family,
        "fill_count": row.fill_count,
        "decision_count": row.decision_count,
        "submitted_order_count": row.submitted_order_count,
        "cancelled_order_count": row.cancelled_order_count,
        "rejected_order_count": row.rejected_order_count,
        "unfilled_order_count": row.unfilled_order_count,
        "closed_trade_count": row.closed_trade_count,
        "open_position_count": row.open_position_count,
        "filled_notional": str(row.filled_notional),
        "gross_strategy_pnl": str(row.gross_strategy_pnl),
        "cost_amount": str(row.cost_amount),
        "net_strategy_pnl_after_costs": str(row.net_strategy_pnl_after_costs),
        "post_cost_expectancy_bps": str(row.post_cost_expectancy_bps)
        if row.post_cost_expectancy_bps is not None
        else None,
        "ledger_schema_version": row.ledger_schema_version,
        "pnl_basis": row.pnl_basis,
        "execution_policy_hash_counts": row.execution_policy_hash_counts or {},
        "cost_model_hash_counts": row.cost_model_hash_counts or {},
        "lineage_hash_counts": row.lineage_hash_counts or {},
        "source_window_start": payload_json.get("source_window_start")
        or payload_json.get("runtime_ledger_source_window_start"),
        "source_window_end": payload_json.get("source_window_end")
        or payload_json.get("runtime_ledger_source_window_end"),
        "source_refs": payload_json.get("source_refs") or [],
        "source_ref": payload_json.get("source_ref"),
        "source_row_counts": payload_json.get("source_row_counts") or {},
        "trade_decision_ids": payload_json.get("trade_decision_ids") or [],
        "execution_ids": payload_json.get("execution_ids") or [],
        "execution_order_event_ids": (
            payload_json.get("execution_order_event_ids") or []
        ),
        "source_offsets": payload_json.get("source_offsets") or [],
        "source_materialization": payload_json.get("source_materialization"),
        "authority_class": payload_json.get("authority_class"),
        "authority_reason": payload_json.get("authority_reason"),
        "pnl_derivation": payload_json.get("pnl_derivation"),
        "blockers": row.blockers_json or [],
    }


def _normalized_strategy_family(value: object) -> str | None:
    text = _safe_text(value)
    return text.replace("-", "_").lower() if text is not None else None


def _runtime_ledger_hash_count(
    payload: Mapping[str, object],
    *,
    payload_key: str,
    observed: Mapping[str, object],
    observed_key: str,
) -> int:
    payload_counts = payload.get(payload_key)
    if isinstance(payload_counts, Mapping):
        typed_counts = cast(Mapping[str, object], payload_counts)
        total = 0
        for raw_value in typed_counts.values():
            count = _safe_int(raw_value)
            if count > 0:
                total += count
        return total
    return _safe_int(observed.get(observed_key))


def _runtime_ledger_payload_from_runtime_item(
    runtime_item: Mapping[str, object],
) -> dict[str, object]:
    observed_raw = runtime_item.get("observed")
    observed = (
        cast(Mapping[str, object], observed_raw)
        if isinstance(observed_raw, Mapping)
        else cast(Mapping[str, object], {})
    )
    if not bool(observed.get("runtime_ledger_proof_present")):
        return {}
    return {
        "candidate_id": observed.get("runtime_ledger_candidate_id"),
        "hypothesis_id": runtime_item.get("hypothesis_id"),
        "observed_stage": observed.get("runtime_ledger_observed_stage"),
        "runtime_strategy_name": observed.get("runtime_ledger_runtime_strategy_name"),
        "strategy_family": observed.get("runtime_ledger_strategy_family")
        or runtime_item.get("strategy_family"),
        "fill_count": observed.get("runtime_ledger_fill_count"),
        "submitted_order_count": observed.get("runtime_ledger_submitted_order_count"),
        "closed_trade_count": observed.get("runtime_ledger_closed_trade_count"),
        "open_position_count": observed.get("runtime_ledger_open_position_count"),
        "filled_notional": observed.get("runtime_ledger_filled_notional"),
        "net_strategy_pnl_after_costs": observed.get(
            "runtime_ledger_net_strategy_pnl_after_costs"
        ),
        "post_cost_expectancy_bps": observed.get(
            "runtime_ledger_post_cost_expectancy_bps"
        ),
        "blockers": observed.get("runtime_ledger_blockers"),
        "ledger_schema_version": observed.get("runtime_ledger_schema_version"),
        "pnl_basis": observed.get("runtime_ledger_pnl_basis"),
    }


def _runtime_ledger_bucket_within_metric_window(
    *,
    bucket_started_at: object,
    bucket_ended_at: object,
    metric_window: StrategyHypothesisMetricWindow,
) -> bool:
    window_started_at = _coerce_aware_datetime(
        cast(object, getattr(metric_window, "window_started_at", None))
    )
    window_ended_at = _coerce_aware_datetime(
        cast(object, getattr(metric_window, "window_ended_at", None))
    )
    bucket_start = _coerce_aware_datetime(bucket_started_at)
    bucket_end = _coerce_aware_datetime(bucket_ended_at)
    if (
        window_started_at is None
        or window_ended_at is None
        or bucket_start is None
        or bucket_end is None
    ):
        return False
    if window_ended_at < window_started_at or bucket_end < bucket_start:
        return False
    return window_started_at <= bucket_start and bucket_end <= window_ended_at


def _runtime_ledger_bucket_matches_metric_window(
    ledger: StrategyRuntimeLedgerBucket,
    *,
    metric_window: StrategyHypothesisMetricWindow,
) -> bool:
    return _runtime_ledger_bucket_within_metric_window(
        bucket_started_at=ledger.bucket_started_at,
        bucket_ended_at=ledger.bucket_ended_at,
        metric_window=metric_window,
    )


def _runtime_ledger_bucket_window_reason_code(
    payload: Mapping[str, object],
    *,
    metric_window: StrategyHypothesisMetricWindow,
) -> str | None:
    window_started_at = cast(object, getattr(metric_window, "window_started_at", None))
    window_ended_at = cast(object, getattr(metric_window, "window_ended_at", None))
    if window_started_at is None or window_ended_at is None:
        return None
    bucket_started_at = payload.get("bucket_started_at")
    bucket_ended_at = payload.get("bucket_ended_at")
    if bucket_started_at is None or bucket_ended_at is None:
        return "runtime_ledger_window_bounds_missing"
    if not _runtime_ledger_bucket_within_metric_window(
        bucket_started_at=bucket_started_at,
        bucket_ended_at=bucket_ended_at,
        metric_window=metric_window,
    ):
        return "runtime_ledger_window_bounds_mismatch"
    return None


def _certificate_runtime_ledger_payload(
    *,
    evidence_row: Mapping[str, object],
    runtime_item: Mapping[str, object],
) -> dict[str, object]:
    payload = evidence_row.get("runtime_ledger_bucket")
    if "runtime_ledger_bucket" in evidence_row and not isinstance(payload, Mapping):
        return {}
    if isinstance(payload, Mapping):
        return dict(cast(Mapping[str, object], payload))
    return _runtime_ledger_payload_from_runtime_item(runtime_item)


def _certificate_runtime_ledger_reason_codes(
    *,
    evidence_row: Mapping[str, object],
    runtime_item: Mapping[str, object],
    metric_window: StrategyHypothesisMetricWindow,
    promotion_decision: StrategyPromotionDecision,
) -> list[str]:
    ledger_payload = _certificate_runtime_ledger_payload(
        evidence_row=evidence_row,
        runtime_item=runtime_item,
    )
    if not ledger_payload:
        return ["runtime_ledger_proof_missing"]

    reasons: list[str] = []
    observed_raw = runtime_item.get("observed")
    observed = (
        cast(Mapping[str, object], observed_raw)
        if isinstance(observed_raw, Mapping)
        else cast(Mapping[str, object], {})
    )
    ledger_hypothesis_id = _safe_text(
        ledger_payload.get("hypothesis_id") or runtime_item.get("hypothesis_id")
    )
    metric_hypothesis_id = (
        _safe_attr_text(metric_window, "hypothesis_id")
        or _safe_text(evidence_row.get("hypothesis_id"))
        or _safe_text(runtime_item.get("hypothesis_id"))
    )
    if ledger_hypothesis_id != metric_hypothesis_id:
        reasons.append("runtime_ledger_hypothesis_mismatch")

    ledger_run_id = _safe_text(ledger_payload.get("run_id"))
    metric_run_id = _safe_attr_text(metric_window, "run_id")
    if (
        ledger_run_id is not None
        and metric_run_id is not None
        and ledger_run_id != metric_run_id
    ):
        reasons.append("runtime_ledger_run_id_mismatch")
    window_reason = _runtime_ledger_bucket_window_reason_code(
        ledger_payload,
        metric_window=metric_window,
    )
    if window_reason is not None:
        reasons.append(window_reason)

    certificate_candidate_id = (
        _safe_attr_text(metric_window, "candidate_id")
        or _safe_attr_text(promotion_decision, "candidate_id")
        or _safe_text(runtime_item.get("candidate_id"))
    )
    ledger_candidate_id = _safe_text(
        ledger_payload.get("candidate_id")
        or observed.get("runtime_ledger_candidate_id")
        or runtime_item.get("candidate_id")
    )
    if ledger_candidate_id is None:
        reasons.append("runtime_ledger_candidate_missing")
    elif (
        certificate_candidate_id is not None
        and ledger_candidate_id != certificate_candidate_id
    ):
        reasons.append("runtime_ledger_candidate_mismatch")

    if _safe_text(ledger_payload.get("observed_stage")) != "live":
        reasons.append("runtime_ledger_stage_not_live")

    ledger_family = _normalized_strategy_family(ledger_payload.get("strategy_family"))
    runtime_family = _normalized_strategy_family(runtime_item.get("strategy_family"))
    if (
        ledger_family is not None
        and runtime_family is not None
        and ledger_family != runtime_family
    ):
        reasons.append("runtime_ledger_strategy_family_mismatch")

    blockers = [
        str(reason).strip()
        for reason in cast(Sequence[object], ledger_payload.get("blockers") or [])
        if str(reason).strip()
    ]
    reasons.extend(blockers)

    if _safe_text(ledger_payload.get("pnl_basis")) != POST_COST_PNL_BASIS:
        reasons.append("runtime_ledger_pnl_basis_missing")

    filled_notional = _safe_decimal(ledger_payload.get("filled_notional"))
    if filled_notional is None or filled_notional <= 0:
        reasons.append("runtime_ledger_filled_notional_missing")

    expectancy_bps = _safe_decimal(ledger_payload.get("post_cost_expectancy_bps"))
    if expectancy_bps is None:
        reasons.append("runtime_ledger_expectancy_missing")
    elif expectancy_bps <= 0:
        reasons.append("post_cost_expectancy_non_positive")

    if _safe_int(ledger_payload.get("closed_trade_count")) <= 0:
        reasons.append("runtime_ledger_closed_trades_missing")
    if _safe_int(ledger_payload.get("open_position_count")) > 0:
        reasons.append("unclosed_position")

    submitted_order_count = _safe_int(ledger_payload.get("submitted_order_count"))
    if submitted_order_count <= 0:
        reasons.append("runtime_order_lifecycle_missing")
    elif submitted_order_count < _safe_int(
        cast(object, getattr(metric_window, "order_count", None))
    ):
        reasons.append("runtime_ledger_submitted_order_count_mismatch")

    if (
        _runtime_ledger_hash_count(
            ledger_payload,
            payload_key="execution_policy_hash_counts",
            observed=observed,
            observed_key="runtime_ledger_execution_policy_hash_count",
        )
        <= 0
    ):
        reasons.append("runtime_ledger_execution_policy_hash_missing")
    if (
        _runtime_ledger_hash_count(
            ledger_payload,
            payload_key="cost_model_hash_counts",
            observed=observed,
            observed_key="runtime_ledger_cost_model_hash_count",
        )
        <= 0
    ):
        reasons.append("runtime_ledger_cost_model_hash_missing")
    if (
        _runtime_ledger_hash_count(
            ledger_payload,
            payload_key="lineage_hash_counts",
            observed=observed,
            observed_key="runtime_ledger_lineage_hash_count",
        )
        <= 0
    ):
        reasons.append("runtime_ledger_lineage_hash_missing")

    return _normalize_reason_codes(reasons)


def _mark_runtime_certificate_rejected(
    updated: dict[str, object],
    *,
    metric_window: StrategyHypothesisMetricWindow,
    promotion_decision: StrategyPromotionDecision,
    reason_codes: Sequence[object],
) -> dict[str, object]:
    normalized_reasons = _normalize_reason_codes(reason_codes)
    observed_raw = updated.get("observed")
    observed = (
        dict(cast(Mapping[str, object], observed_raw))
        if isinstance(observed_raw, Mapping)
        else {}
    )
    observed.update(
        {
            "runtime_window_certificate_rejected": True,
            "runtime_window_rejection_reasons": normalized_reasons,
            "metric_window_id": str(metric_window.id),
            "promotion_decision_id": str(promotion_decision.id),
            "metric_window_market_session_count": metric_window.market_session_count,
            "metric_window_decision_count": metric_window.decision_count,
            "metric_window_trade_count": metric_window.trade_count,
            "metric_window_order_count": metric_window.order_count,
            "metric_window_avg_abs_slippage_bps": metric_window.avg_abs_slippage_bps,
            "metric_window_post_cost_expectancy_bps": (
                metric_window.post_cost_expectancy_bps
            ),
        }
    )
    prior_reasons = [
        str(reason).strip()
        for reason in cast(Sequence[object], updated.get("reasons") or [])
        if str(reason).strip()
    ]
    updated["reasons"] = _normalize_reason_codes([*prior_reasons, *normalized_reasons])
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
    updated["promotion_eligible"] = False
    updated["promotion_decision_id"] = str(promotion_decision.id)
    updated["metric_window_id"] = str(metric_window.id)
    updated["observed"] = observed
    return updated


def _load_latest_runtime_ledger_summary(
    session: Session,
    *,
    hypothesis_ids: Sequence[str],
) -> dict[str, object]:
    normalized_ids = [
        hypothesis_id for hypothesis_id in hypothesis_ids if hypothesis_id
    ]
    by_hypothesis: dict[str, dict[str, object]] = {}
    if not normalized_ids:
        return {"by_hypothesis": by_hypothesis, "runtime_ledger_buckets": []}

    rows_by_hypothesis: dict[str, int] = {}
    retained_rows: list[dict[str, object]] = []
    rows = session.execute(
        select(StrategyRuntimeLedgerBucket)
        .where(StrategyRuntimeLedgerBucket.hypothesis_id.in_(normalized_ids))
        .order_by(
            StrategyRuntimeLedgerBucket.bucket_ended_at.desc(),
            StrategyRuntimeLedgerBucket.created_at.desc(),
        )
    ).scalars()
    for row in rows:
        payload = _runtime_ledger_bucket_payload(row)
        retained_count = rows_by_hypothesis.get(row.hypothesis_id, 0)
        if retained_count < 8:
            retained_rows.append(payload)
            rows_by_hypothesis[row.hypothesis_id] = retained_count + 1

        current = by_hypothesis.get(row.hypothesis_id)
        if current is None:
            by_hypothesis[row.hypothesis_id] = payload
            continue
        current_is_live = str(current.get("observed_stage") or "").strip() == "live"
        row_is_live = str(payload.get("observed_stage") or "").strip() == "live"
        if row_is_live and not current_is_live:
            by_hypothesis[row.hypothesis_id] = payload
    return {"by_hypothesis": by_hypothesis, "runtime_ledger_buckets": retained_rows}


def _runtime_ledger_selection_score(payload: Mapping[str, object] | None) -> int:
    if not isinstance(payload, Mapping):
        return 0

    score = 0
    blockers = [
        str(reason).strip()
        for reason in cast(Sequence[object], payload.get("blockers") or [])
        if str(reason).strip()
    ]
    if not blockers:
        score += 1
    if _safe_text(payload.get("pnl_basis")) == POST_COST_PNL_BASIS:
        score += 1
    if (_safe_decimal(payload.get("filled_notional")) or Decimal("0")) > 0:
        score += 1
    if (_safe_decimal(payload.get("post_cost_expectancy_bps")) or Decimal("0")) > 0:
        score += 1
    if _safe_int(payload.get("closed_trade_count")) > 0:
        score += 1
    if _safe_int(payload.get("open_position_count")) == 0:
        score += 1
    if (
        _runtime_ledger_hash_count(
            payload,
            payload_key="execution_policy_hash_counts",
            observed={},
            observed_key="runtime_ledger_execution_policy_hash_count",
        )
        > 0
    ):
        score += 1
    if (
        _runtime_ledger_hash_count(
            payload,
            payload_key="cost_model_hash_counts",
            observed={},
            observed_key="runtime_ledger_cost_model_hash_count",
        )
        > 0
    ):
        score += 1
    if (
        _runtime_ledger_hash_count(
            payload,
            payload_key="lineage_hash_counts",
            observed={},
            observed_key="runtime_ledger_lineage_hash_count",
        )
        > 0
    ):
        score += 1
    return score


def _certificate_evidence_authority_score(
    *,
    observed_stage: str | None,
    runtime_ledger_bucket: Mapping[str, object] | None,
) -> int:
    if observed_stage == "live":
        return 2 if _runtime_ledger_selection_score(runtime_ledger_bucket) >= 9 else 0
    if observed_stage == "paper":
        return 1
    return 0


def _runtime_ledger_target_reason_codes(
    payload: Mapping[str, object],
    *,
    manifest: Mapping[str, object],
) -> list[str]:
    reasons: list[str] = []
    expected_candidates = _runtime_ledger_manifest_candidate_ids(manifest)
    actual_candidate = _safe_text(payload.get("candidate_id"))
    if expected_candidates:
        if actual_candidate is None:
            reasons.append("runtime_ledger_candidate_missing")
        elif actual_candidate not in expected_candidates:
            reasons.append("runtime_ledger_candidate_mismatch")

    expected_family = _normalized_strategy_family(manifest.get("strategy_family"))
    actual_family = _normalized_strategy_family(payload.get("strategy_family"))
    if (
        expected_family is not None
        and actual_family is not None
        and actual_family != expected_family
    ):
        reasons.append("runtime_ledger_strategy_family_mismatch")
    return reasons


def _runtime_ledger_manifest_candidate_ids(
    manifest: Mapping[str, object],
) -> set[str]:
    candidates: set[str] = set()
    primary_candidate = _safe_text(manifest.get("candidate_id"))
    if primary_candidate is not None:
        candidates.add(primary_candidate)
    raw_probation_candidates = manifest.get("paper_probation_candidate_ids")
    if isinstance(raw_probation_candidates, Sequence) and not isinstance(
        raw_probation_candidates, (str, bytes, bytearray)
    ):
        for raw_candidate in cast(Sequence[object], raw_probation_candidates):
            candidate = _safe_text(raw_candidate)
            if candidate is not None:
                candidates.add(candidate)
    return candidates


def _runtime_ledger_repair_reason_codes(
    payload: Mapping[str, object],
    *,
    manifest: Mapping[str, object],
) -> list[str]:
    reasons = [
        str(reason).strip()
        for reason in cast(Sequence[object], payload.get("blockers") or [])
        if str(reason).strip()
    ]
    reasons.extend(runtime_ledger_promotion_source_authority_blockers(payload))
    reasons.extend(_runtime_ledger_target_reason_codes(payload, manifest=manifest))
    if _safe_text(payload.get("observed_stage")) != "live":
        reasons.append("runtime_ledger_stage_not_live")
    if _safe_text(payload.get("pnl_basis")) != POST_COST_PNL_BASIS:
        reasons.append("runtime_ledger_pnl_basis_missing")
    if (_safe_decimal(payload.get("filled_notional")) or Decimal("0")) <= 0:
        reasons.append("runtime_ledger_filled_notional_missing")
    if _safe_int(payload.get("fill_count")) <= 0:
        reasons.append("runtime_ledger_fills_missing")
    if _safe_int(payload.get("closed_trade_count")) <= 0:
        reasons.append("runtime_ledger_closed_trades_missing")
    if _safe_int(payload.get("open_position_count")) > 0:
        reasons.append("unclosed_position")
    if (
        _safe_decimal(payload.get("net_strategy_pnl_after_costs")) or Decimal("0")
    ) <= 0:
        reasons.append("post_cost_pnl_non_positive")
    expectancy_bps = _safe_decimal(payload.get("post_cost_expectancy_bps"))
    if expectancy_bps is None:
        reasons.append("runtime_ledger_expectancy_missing")
    elif expectancy_bps <= 0:
        reasons.append("post_cost_expectancy_non_positive")
    if (
        _runtime_ledger_hash_count(
            payload,
            payload_key="execution_policy_hash_counts",
            observed={},
            observed_key="runtime_ledger_execution_policy_hash_count",
        )
        <= 0
    ):
        reasons.append("runtime_ledger_execution_policy_hash_missing")
    if (
        _runtime_ledger_hash_count(
            payload,
            payload_key="cost_model_hash_counts",
            observed={},
            observed_key="runtime_ledger_cost_model_hash_count",
        )
        <= 0
    ):
        reasons.append("runtime_ledger_cost_model_hash_missing")
    if (
        _runtime_ledger_hash_count(
            payload,
            payload_key="lineage_hash_counts",
            observed={},
            observed_key="runtime_ledger_lineage_hash_count",
        )
        <= 0
    ):
        reasons.append("runtime_ledger_lineage_hash_missing")
    return _normalize_reason_codes(reasons)


def _runtime_ledger_repair_score(
    candidate: Mapping[str, object],
) -> tuple[int, int, int, int, int, Decimal, Decimal, Decimal, float]:
    reason_codes = set(
        str(reason).strip()
        for reason in cast(Sequence[object], candidate.get("reason_codes") or [])
        if str(reason).strip()
    )
    filled_notional = _safe_decimal(candidate.get("filled_notional")) or Decimal("0")
    net_pnl = _safe_decimal(candidate.get("net_strategy_pnl_after_costs")) or Decimal(
        "0"
    )
    expectancy_bps = _safe_decimal(
        candidate.get("post_cost_expectancy_bps")
    ) or Decimal("0")
    ended_at = _coerce_aware_datetime(candidate.get("bucket_ended_at"))
    observed_stage = _safe_text(candidate.get("observed_stage"))
    return (
        (
            int(filled_notional > 0),
            int(_safe_int(candidate.get("fill_count")) > 0),
            int(_safe_int(candidate.get("closed_trade_count")) > 0),
            int(net_pnl > 0),
            int(expectancy_bps > 0),
            net_pnl,
            expectancy_bps,
            filled_notional,
            ended_at.timestamp() if ended_at is not None else 0.0,
        )
        if observed_stage != "live" or reason_codes
        else (
            2,
            2,
            2,
            2,
            2,
            net_pnl,
            expectancy_bps,
            filled_notional,
            ended_at.timestamp() if ended_at is not None else 0.0,
        )
    )


_RUNTIME_LEDGER_PAPER_PROBATION_REASON = "runtime_ledger_stage_not_live"
_RUNTIME_LEDGER_PAPER_PROBATION_ALLOWED_REASONS = {
    _RUNTIME_LEDGER_PAPER_PROBATION_REASON
}
_RUNTIME_LEDGER_PAPER_PROBATION_IMPORT_SCHEMA_VERSION = (
    "torghut.runtime-ledger-paper-probation-import-plan.v1"
)
_RUNTIME_LEDGER_PAPER_PROBATION_SOURCE_KIND = "durable_runtime_ledger_bucket"
_RUNTIME_LEDGER_PAPER_PROBATION_SOURCE_DSN_ENV = (
    "TORGHUT_DURABLE_RUNTIME_LEDGER_SOURCE_DSN"
)
_RUNTIME_LEDGER_PAPER_PROBATION_PROMOTION_BLOCKERS = (
    _RUNTIME_LEDGER_PAPER_PROBATION_REASON,
    "paper_probation_evidence_collection_only",
    "live_runtime_ledger_required",
)


def _runtime_ledger_paper_probation_eligible(
    candidate: Mapping[str, object],
) -> bool:
    reasons = {
        str(reason).strip()
        for reason in cast(Sequence[object], candidate.get("reason_codes") or [])
        if str(reason).strip()
    }
    return (
        _safe_text(candidate.get("observed_stage")) == "paper"
        and reasons == _RUNTIME_LEDGER_PAPER_PROBATION_ALLOWED_REASONS
        and _safe_text(candidate.get("pnl_basis")) == POST_COST_PNL_BASIS
        and (_safe_decimal(candidate.get("filled_notional")) or Decimal("0")) > 0
        and _safe_int(candidate.get("fill_count")) > 0
        and _safe_int(candidate.get("closed_trade_count")) > 0
        and _safe_int(candidate.get("open_position_count")) == 0
        and (
            _safe_decimal(candidate.get("net_strategy_pnl_after_costs")) or Decimal("0")
        )
        > 0
        and (_safe_decimal(candidate.get("post_cost_expectancy_bps")) or Decimal("0"))
        > 0
    )


def _runtime_ledger_paper_probation_candidates(
    candidates: Sequence[Mapping[str, object]],
) -> list[dict[str, object]]:
    return [
        {
            **dict(candidate),
            "paper_probation_eligible": True,
            "paper_probation_scope": "evidence_collection_only",
            "paper_probation_reason_codes": [_RUNTIME_LEDGER_PAPER_PROBATION_REASON],
            "paper_probation_target_capital_stage": "shadow",
            "max_notional": "0",
        }
        for candidate in candidates
        if _runtime_ledger_paper_probation_eligible(candidate)
    ]


def _strategy_name_from_strategy_id(strategy_id: object) -> str | None:
    text = _safe_text(strategy_id)
    if text is None:
        return None
    base = text.split("@", 1)[0].strip()
    return base.replace("_", "-") if base else None


def _strategy_lookup_names(*values: object) -> list[str]:
    names: list[str] = []
    for value in values:
        raw_items: Sequence[object]
        if isinstance(value, Sequence) and not isinstance(
            value, (str, bytes, bytearray)
        ):
            raw_items = cast(Sequence[object], value)
        else:
            raw_items = (value,)
        for raw_item in raw_items:
            text = _safe_text(raw_item)
            if text is not None and text not in names:
                names.append(text)
    return names


def _hypothesis_manifest_ref(hypothesis_id: object) -> str | None:
    text = _safe_text(hypothesis_id)
    if text is None:
        return None
    slug = text.lower().replace("_", "-")
    return f"config/trading/hypotheses/{slug}.json"


def _runtime_ledger_paper_probation_strategy_name(
    candidate: Mapping[str, object],
) -> str | None:
    return _safe_text(candidate.get("runtime_strategy_name")) or (
        _strategy_name_from_strategy_id(candidate.get("strategy_id"))
    )


def _runtime_ledger_paper_probation_bucket_ref(
    candidate: Mapping[str, object],
) -> str | None:
    run_id = _safe_text(candidate.get("run_id"))
    started_at = _safe_text(candidate.get("bucket_started_at"))
    ended_at = _safe_text(candidate.get("bucket_ended_at"))
    if run_id is None or started_at is None or ended_at is None:
        return None
    return f"strategy_runtime_ledger_buckets:{run_id}:{started_at}:{ended_at}"


def _runtime_ledger_paper_probation_import_plan(
    candidates: Sequence[Mapping[str, object]],
) -> dict[str, object]:
    targets: list[dict[str, object]] = []
    skipped_targets: list[dict[str, object]] = []
    seen_target_keys: set[tuple[str, ...]] = set()
    for candidate in candidates:
        hypothesis_id = _safe_text(candidate.get("hypothesis_id"))
        candidate_id = _safe_text(candidate.get("candidate_id"))
        strategy_family = _safe_text(candidate.get("strategy_family"))
        strategy_id = _safe_text(candidate.get("strategy_id"))
        candidate_strategy_name = _safe_text(candidate.get("strategy_name"))
        strategy_name = _runtime_ledger_paper_probation_strategy_name(candidate)
        strategy_lookup_names = _strategy_lookup_names(
            candidate.get("strategy_lookup_names"),
            strategy_name,
            candidate_strategy_name,
            _strategy_name_from_strategy_id(strategy_id),
        )
        account_label = _safe_text(candidate.get("account")) or "TORGHUT_SIM"
        window_start = _safe_text(candidate.get("bucket_started_at"))
        window_end = _safe_text(candidate.get("bucket_ended_at"))
        source_manifest_ref = _safe_text(candidate.get("source_manifest_ref")) or (
            _hypothesis_manifest_ref(hypothesis_id)
        )
        dataset_snapshot_ref = _safe_text(candidate.get("dataset_snapshot_ref"))
        missing = [
            field
            for field, value in (
                ("hypothesis_id", hypothesis_id),
                ("candidate_id", candidate_id),
                ("strategy_family", strategy_family),
                ("strategy_name", strategy_name),
                ("window_start", window_start),
                ("window_end", window_end),
                ("source_manifest_ref", source_manifest_ref),
            )
            if value is None
        ]
        if missing:
            skipped_targets.append(
                {
                    "hypothesis_id": hypothesis_id,
                    "candidate_id": candidate_id,
                    "missing_fields": missing,
                    "reason": "runtime_ledger_paper_probation_target_missing_required_fields",
                }
            )
            continue

        target_key = (
            hypothesis_id or "",
            candidate_id or "",
            strategy_family or "",
            strategy_name or "",
            account_label,
            dataset_snapshot_ref or "",
            source_manifest_ref or "",
            _RUNTIME_LEDGER_PAPER_PROBATION_SOURCE_KIND,
            window_start or "",
            window_end or "",
        )
        bucket_ref = _runtime_ledger_paper_probation_bucket_ref(candidate)
        if target_key in seen_target_keys:
            skipped_targets.append(
                {
                    "hypothesis_id": hypothesis_id,
                    "candidate_id": candidate_id,
                    "strategy_family": strategy_family,
                    "strategy_name": strategy_name,
                    "window_start": window_start,
                    "window_end": window_end,
                    "runtime_ledger_bucket_ref": bucket_ref,
                    "reason": "duplicate_runtime_ledger_paper_probation_target",
                }
            )
            continue
        seen_target_keys.add(target_key)

        reason_codes = _normalize_reason_codes(
            [
                str(reason).strip()
                for reason in cast(
                    Sequence[object], candidate.get("reason_codes") or []
                )
                if str(reason).strip()
            ]
        )
        target: dict[str, object] = {
            "hypothesis_id": hypothesis_id,
            "candidate_id": candidate_id,
            "observed_stage": "paper",
            "strategy_family": strategy_family,
            "strategy_name": strategy_name,
            "strategy_id": strategy_id or "",
            "runtime_strategy_name": strategy_name,
            "strategy_lookup_names": strategy_lookup_names,
            "account_label": account_label,
            "source_dsn_env": _RUNTIME_LEDGER_PAPER_PROBATION_SOURCE_DSN_ENV,
            "dataset_snapshot_ref": dataset_snapshot_ref or "",
            "source_manifest_ref": source_manifest_ref,
            "source_kind": _RUNTIME_LEDGER_PAPER_PROBATION_SOURCE_KIND,
            "window_start": window_start,
            "window_end": window_end,
            "paper_probation_authorized": True,
            "paper_probation_authorization_scope": "evidence_collection_only",
            "evidence_collection_stage": "paper",
            "probation_allowed": True,
            "probation_reason": "paper_stage_runtime_ledger_positive_after_costs",
            "promotion_allowed": False,
            "final_promotion_authorized": False,
            "final_promotion_allowed": False,
            "final_promotion_blockers": list(
                _RUNTIME_LEDGER_PAPER_PROBATION_PROMOTION_BLOCKERS
            ),
            "candidate_blockers": reason_codes,
            "runtime_ledger_target_metadata_blockers": list(
                _RUNTIME_LEDGER_PAPER_PROBATION_PROMOTION_BLOCKERS
            ),
            "handoff": "runtime_ledger_paper_probation_import",
            "promotion_gate": "runtime_ledger_live_or_live_paper_required",
            "selected_by": "runtime_ledger_paper_probation",
            "selection_reason": "positive_post_cost_runtime_ledger_bucket",
            "max_notional": "0",
        }
        if bucket_ref:
            target["runtime_ledger_bucket_ref"] = bucket_ref
        targets.append(target)

    return {
        "schema_version": _RUNTIME_LEDGER_PAPER_PROBATION_IMPORT_SCHEMA_VERSION,
        "source": "runtime_ledger_paper_probation_candidates",
        "purpose": "paper_stage_runtime_ledger_evidence_collection",
        "promotion_allowed": False,
        "final_promotion_authorized": False,
        "final_promotion_allowed": False,
        "target_count": len(targets),
        "skipped_target_count": len(skipped_targets),
        "targets": targets,
        "skipped_targets": skipped_targets,
    }


def _paper_probation_eligible_total_with_runtime_ledger(
    *,
    legacy_total: int,
    runtime_items: Sequence[Mapping[str, Any]],
    runtime_ledger_candidates: Sequence[Mapping[str, object]],
) -> int:
    keys: set[tuple[str, str]] = set()
    for item in runtime_items:
        if not bool(item.get("paper_probation_eligible")):
            continue
        hypothesis_id = _safe_text(item.get("hypothesis_id")) or ""
        candidate_id = _safe_text(item.get("candidate_id")) or ""
        keys.add((hypothesis_id, candidate_id))
    for candidate in runtime_ledger_candidates:
        hypothesis_id = _safe_text(candidate.get("hypothesis_id")) or ""
        candidate_id = _safe_text(candidate.get("candidate_id")) or ""
        keys.add((hypothesis_id, candidate_id))
    return max(legacy_total, len(keys))


def _load_runtime_ledger_repair_candidates(
    session: Session,
    *,
    registry_items: Sequence[Mapping[str, object]],
    limit: int = _RUNTIME_LEDGER_REPAIR_CANDIDATE_LIMIT,
) -> list[dict[str, object]]:
    manifests = {
        str(item.get("hypothesis_id") or "").strip(): item
        for item in registry_items
        if str(item.get("hypothesis_id") or "").strip()
    }
    hypothesis_ids = sorted(manifests)
    if not hypothesis_ids or limit <= 0:
        return []

    rows = (
        session.execute(
            select(StrategyRuntimeLedgerBucket)
            .where(StrategyRuntimeLedgerBucket.hypothesis_id.in_(hypothesis_ids))
            .order_by(
                StrategyRuntimeLedgerBucket.bucket_ended_at.desc(),
                StrategyRuntimeLedgerBucket.created_at.desc(),
            )
            .limit(_RUNTIME_LEDGER_REPAIR_SCAN_LIMIT)
        )
        .scalars()
        .all()
    )

    candidates: list[dict[str, object]] = []
    seen: set[tuple[str, str, str, str, str]] = set()
    for row in rows:
        payload = _runtime_ledger_bucket_payload(row)
        if (
            _safe_int(payload.get("submitted_order_count")) <= 0
            and _safe_int(payload.get("fill_count")) <= 0
            and _safe_int(payload.get("closed_trade_count")) <= 0
        ):
            continue
        manifest = manifests.get(row.hypothesis_id) or {}
        candidate_key = (
            str(payload.get("hypothesis_id") or ""),
            str(payload.get("candidate_id") or ""),
            str(payload.get("run_id") or ""),
            str(payload.get("bucket_started_at") or ""),
            str(payload.get("bucket_ended_at") or ""),
        )
        if candidate_key in seen:
            continue
        seen.add(candidate_key)
        reason_codes = _runtime_ledger_repair_reason_codes(
            payload,
            manifest=manifest,
        )
        candidates.append(
            {
                "source": "strategy_runtime_ledger_buckets",
                "promotion_authority": "runtime_ledger_candidate_only",
                "hypothesis_id": payload.get("hypothesis_id"),
                "candidate_id": payload.get("candidate_id"),
                "strategy_id": manifest.get("strategy_id")
                or payload.get("runtime_strategy_name"),
                "dataset_snapshot_ref": manifest.get("dataset_snapshot_ref"),
                "source_manifest_ref": manifest.get("source_manifest_ref")
                or _hypothesis_manifest_ref(payload.get("hypothesis_id")),
                "strategy_family": payload.get("strategy_family")
                or manifest.get("strategy_family"),
                "runtime_strategy_name": payload.get("runtime_strategy_name"),
                "observed_stage": payload.get("observed_stage"),
                "run_id": payload.get("run_id"),
                "bucket_started_at": payload.get("bucket_started_at"),
                "bucket_ended_at": payload.get("bucket_ended_at"),
                "account": payload.get("account_label"),
                "fill_count": payload.get("fill_count"),
                "decision_count": payload.get("decision_count"),
                "submitted_order_count": payload.get("submitted_order_count"),
                "closed_trade_count": payload.get("closed_trade_count"),
                "open_position_count": payload.get("open_position_count"),
                "filled_notional": payload.get("filled_notional"),
                "net_strategy_pnl_after_costs": payload.get(
                    "net_strategy_pnl_after_costs"
                ),
                "post_cost_expectancy_bps": payload.get("post_cost_expectancy_bps"),
                "ledger_schema_version": payload.get("ledger_schema_version"),
                "pnl_basis": payload.get("pnl_basis"),
                "source_window_start": payload.get("source_window_start"),
                "source_window_end": payload.get("source_window_end"),
                "source_refs": payload.get("source_refs"),
                "source_row_counts": payload.get("source_row_counts"),
                "reason_codes": reason_codes,
                "runtime_ledger_bucket": payload,
            }
        )

    return sorted(candidates, key=_runtime_ledger_repair_score, reverse=True)[:limit]


def _certificate_evidence_selection_key(
    row: Mapping[str, object],
    *,
    now: datetime | None,
    max_age_seconds: int | None,
) -> tuple[int, int, int, int, int, int, int, int, Decimal, float]:
    metric_window = cast(
        StrategyHypothesisMetricWindow | None, row.get("metric_window")
    )
    promotion_decision = cast(
        StrategyPromotionDecision | None, row.get("promotion_decision")
    )
    runtime_ledger_bucket = cast(
        Mapping[str, object] | None, row.get("runtime_ledger_bucket")
    )
    if metric_window is None:
        return (0, 0, 0, 0, 0, 0, 0, 0, Decimal("0"), 0.0)

    issued_at = _coerce_aware_datetime(
        getattr(metric_window, "window_ended_at", None)
        or getattr(metric_window, "created_at", None)
    )
    fresh_score = 1
    if now is not None and max_age_seconds is not None and max_age_seconds > 0:
        fresh_score = int(
            issued_at is not None
            and issued_at >= now - timedelta(seconds=max_age_seconds)
        )
    observed_stage = _safe_text(getattr(metric_window, "observed_stage", None))
    stage_score = {"live": 2, "paper": 1}.get(observed_stage or "", 0)
    runtime_ledger_score = _runtime_ledger_selection_score(runtime_ledger_bucket)
    authority_score = _certificate_evidence_authority_score(
        observed_stage=observed_stage,
        runtime_ledger_bucket=runtime_ledger_bucket,
    )
    decision_score = 0
    if promotion_decision is not None:
        decision_score = int(
            _safe_bool(getattr(promotion_decision, "allowed", False)) is True
            and not _promotion_decision_blocking_reason_codes(promotion_decision)
        )
    activity_score = int(not _metric_window_activity_reason_codes(metric_window))
    continuity_score = int(
        bool(getattr(metric_window, "continuity_ok", False))
        and bool(getattr(metric_window, "drift_ok", False))
        and _safe_text(getattr(metric_window, "dependency_quorum_decision", None))
        == "allow"
    )
    capital_rank = max(0, _stage_rank(getattr(metric_window, "capital_stage", None)))
    sample_count = _safe_int(getattr(metric_window, "order_count", None))
    expectancy_bps = _safe_decimal(
        getattr(metric_window, "post_cost_expectancy_bps", None)
    ) or Decimal("0")
    issued_ts = issued_at.timestamp() if issued_at is not None else 0.0
    return (
        fresh_score,
        decision_score,
        activity_score,
        continuity_score,
        authority_score,
        stage_score,
        runtime_ledger_score,
        capital_rank + sample_count,
        expectancy_bps,
        issued_ts,
    )


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
    paper_probation_eligible_total = 0
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
        if bool(item.get("paper_probation_eligible")):
            paper_probation_eligible_total += 1
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
            "paper_probation_eligible_total": paper_probation_eligible_total,
            "rollback_required_total": rollback_required_total,
            "items": list(runtime_items),
        }
    )
    return refreshed


def build_submission_gate_market_context_status(state: object) -> dict[str, object]:
    last_domain_states = {
        key: str(value).strip().lower()
        for key, value in active_market_context_mapping(
            cast(
                Mapping[str, Any],
                getattr(state, "last_market_context_domain_states", {}),
            )
        ).items()
    }
    last_risk_flags = active_market_context_reasons(
        cast(Sequence[str], getattr(state, "last_market_context_risk_flags", []))
    )
    raw_alert_active = bool(getattr(state, "market_context_alert_active", False))
    alert_reason = (
        getattr(state, "market_context_alert_reason", None)
        or "market_context_alert_active"
        if raw_alert_active
        else None
    )
    active_alert_reasons = active_market_context_reasons([alert_reason])
    filtered_alert_reason = active_alert_reasons[0] if active_alert_reasons else None
    return {
        "last_symbol": getattr(state, "last_market_context_symbol", None),
        "last_checked_at": getattr(state, "last_market_context_checked_at", None),
        "last_as_of": getattr(state, "last_market_context_as_of", None),
        "last_freshness_seconds": getattr(
            state, "last_market_context_freshness_seconds", None
        ),
        "last_domain_states": last_domain_states,
        "last_risk_flags": last_risk_flags,
        "alert_active": raw_alert_active and filtered_alert_reason is not None,
        "alert_reason": filtered_alert_reason,
    }


def _load_latest_certificate_evidence(
    session: Session,
    *,
    hypothesis_ids: Sequence[str],
    now: datetime | None = None,
    max_age_seconds: int | None = None,
) -> list[dict[str, object]]:
    normalized_ids = [
        hypothesis_id for hypothesis_id in hypothesis_ids if hypothesis_id
    ]
    if not normalized_ids:
        return []

    windows_by_hypothesis: dict[str, list[StrategyHypothesisMetricWindow]] = {}
    window_rows = session.execute(
        select(StrategyHypothesisMetricWindow)
        .where(StrategyHypothesisMetricWindow.hypothesis_id.in_(normalized_ids))
        .order_by(
            StrategyHypothesisMetricWindow.window_ended_at.desc().nullslast(),
            StrategyHypothesisMetricWindow.created_at.desc(),
        )
    ).scalars()
    for row in window_rows:
        windows_by_hypothesis.setdefault(row.hypothesis_id, []).append(row)

    latest_promotions: dict[str, list[StrategyPromotionDecision]] = {}
    promotion_rows = session.execute(
        select(StrategyPromotionDecision)
        .where(
            StrategyPromotionDecision.hypothesis_id.in_(normalized_ids),
        )
        .order_by(StrategyPromotionDecision.created_at.desc())
    ).scalars()
    for row in promotion_rows:
        latest_promotions.setdefault(row.hypothesis_id, []).append(row)

    latest_runtime_ledgers: dict[str, list[StrategyRuntimeLedgerBucket]] = {}
    runtime_ledger_rows = session.execute(
        select(StrategyRuntimeLedgerBucket)
        .where(StrategyRuntimeLedgerBucket.hypothesis_id.in_(normalized_ids))
        .order_by(
            StrategyRuntimeLedgerBucket.bucket_ended_at.desc(),
            StrategyRuntimeLedgerBucket.created_at.desc(),
        )
    ).scalars()
    for row in runtime_ledger_rows:
        latest_runtime_ledgers.setdefault(row.hypothesis_id, []).append(row)

    evidence: list[dict[str, object]] = []
    for hypothesis_id in normalized_ids:
        candidate_rows: list[dict[str, object]] = []
        for metric_window in windows_by_hypothesis.get(hypothesis_id, []):
            promotion_decision = None
            for decision in latest_promotions.get(hypothesis_id, []):
                if _promotion_decision_matches_metric_window(
                    decision,
                    metric_window=metric_window,
                ):
                    promotion_decision = decision
                    break
            runtime_ledger_bucket = None
            for ledger in latest_runtime_ledgers.get(hypothesis_id, []):
                if (
                    _safe_text(ledger.run_id) != _safe_text(metric_window.run_id)
                    or _safe_text(ledger.candidate_id)
                    != _safe_text(metric_window.candidate_id)
                    or _safe_text(ledger.observed_stage)
                    != _safe_text(metric_window.observed_stage)
                    or not _runtime_ledger_bucket_matches_metric_window(
                        ledger,
                        metric_window=metric_window,
                    )
                ):
                    continue
                runtime_ledger_bucket = _runtime_ledger_bucket_payload(ledger)
                break
            candidate_rows.append(
                {
                    "hypothesis_id": hypothesis_id,
                    "metric_window": metric_window,
                    "promotion_decision": promotion_decision,
                    "runtime_ledger_bucket": runtime_ledger_bucket,
                }
            )
        if not candidate_rows:
            evidence.append(
                {
                    "hypothesis_id": hypothesis_id,
                    "metric_window": None,
                    "promotion_decision": None,
                    "runtime_ledger_bucket": None,
                }
            )
            continue
        evidence.append(
            max(
                candidate_rows,
                key=lambda row: _certificate_evidence_selection_key(
                    row,
                    now=now,
                    max_age_seconds=max_age_seconds,
                ),
            )
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
    observed_stage = _safe_text(getattr(metric_window, "observed_stage", None))
    if observed_stage == "live":
        promotion_sample_count = _safe_int(
            payload.get("post_cost_promotion_sample_count")
        )
        runtime_ledger_sample_count = _safe_int(
            payload.get("runtime_ledger_notional_weighted_sample_count")
        )
        aggregation = _safe_text(payload.get("post_cost_expectancy_aggregation"))
        if (
            promotion_sample_count <= 0
            or runtime_ledger_sample_count < promotion_sample_count
            or aggregation != "runtime_ledger_notional_weighted"
        ):
            reasons.append("runtime_ledger_pnl_basis_missing")

    avg_abs_slippage_bps = _safe_decimal(metric_window.avg_abs_slippage_bps)
    slippage_budget_bps = _safe_decimal(metric_window.slippage_budget_bps)
    if (
        avg_abs_slippage_bps is not None
        and slippage_budget_bps is not None
        and avg_abs_slippage_bps > slippage_budget_bps
    ):
        reasons.append("hypothesis_window_slippage_budget_exceeded")
    return reasons


def _promotion_decision_blocking_reason_codes(
    promotion_decision: StrategyPromotionDecision,
) -> list[str]:
    payload_raw = getattr(promotion_decision, "payload_json", None)
    payload: Mapping[str, object] = (
        cast(Mapping[str, object], payload_raw)
        if isinstance(payload_raw, Mapping)
        else cast(Mapping[str, object], {})
    )
    reasons = [
        str(reason).strip()
        for reason in cast(
            Sequence[object], payload.get("promotion_blocking_reasons") or []
        )
        if str(reason).strip()
    ]
    summary = _safe_text(getattr(promotion_decision, "reason_summary", None))
    satisfied_summaries = {
        "runtime_evidence_thresholds_satisfied",
        "paper_runtime_evidence_thresholds_satisfied",
        "ready",
    }
    if summary and summary not in satisfied_summaries:
        reasons.extend(
            reason.strip() for reason in summary.split(",") if reason.strip()
        )
    if _safe_bool(getattr(promotion_decision, "allowed", True)) is False:
        reasons.append("promotion_decision_not_allowed")
    return _normalize_reason_codes(reasons)


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
        decision_blockers = _promotion_decision_blocking_reason_codes(
            promotion_decision
        )
        if decision_blockers:
            updated = _mark_runtime_certificate_rejected(
                updated,
                metric_window=metric_window,
                promotion_decision=promotion_decision,
                reason_codes=decision_blockers,
            )
            merged.append(updated)
            continue
        activity_reason_codes = _metric_window_activity_reason_codes(metric_window)
        if activity_reason_codes:
            updated = _mark_runtime_certificate_rejected(
                updated,
                metric_window=metric_window,
                promotion_decision=promotion_decision,
                reason_codes=activity_reason_codes,
            )
            merged.append(updated)
            continue

        capital_stage = _certificate_capital_stage(metric_window, promotion_decision)
        if capital_stage is None:
            merged.append(updated)
            continue
        observed_stage = _safe_text(getattr(metric_window, "observed_stage", None))
        if observed_stage == "paper":
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
                    "runtime_window_paper_probation_applied": True,
                    "paper_probation_evidence_collection_only": True,
                    "paper_probation_target_capital_stage": capital_stage,
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
                    "capital_stage": "shadow",
                    "capital_multiplier": "0",
                    "promotion_eligible": False,
                    "paper_probation_eligible": True,
                    "paper_probation_target_capital_stage": capital_stage,
                    "rollback_required": False,
                    "reasons": ["paper_probation_evidence_collection_only"],
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
                            "runtime_window_paper_probation_applied",
                        }
                    ),
                    "promotion_decision_id": str(promotion_decision.id),
                    "metric_window_id": str(metric_window.id),
                    "observed": observed,
                }
            )
            merged.append(updated)
            continue
        if observed_stage != "live":
            merged.append(updated)
            continue
        if _stage_rank(capital_stage) <= _stage_rank("shadow"):
            merged.append(updated)
            continue
        runtime_ledger_reason_codes = _certificate_runtime_ledger_reason_codes(
            evidence_row=row,
            runtime_item=updated,
            metric_window=metric_window,
            promotion_decision=promotion_decision,
        )
        if runtime_ledger_reason_codes:
            updated = _mark_runtime_certificate_rejected(
                updated,
                metric_window=metric_window,
                promotion_decision=promotion_decision,
                reason_codes=runtime_ledger_reason_codes,
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
        key: str(value).strip().lower()
        for key, value in active_market_context_mapping(
            cast(Mapping[str, Any], market_context_ref.get("last_domain_states", {}))
        ).items()
    }
    market_context_reasons: list[str] = []
    if bool(market_context_ref.get("alert_active")):
        market_context_reasons.extend(
            active_market_context_reasons(
                [
                    str(
                        market_context_ref.get("alert_reason")
                        or "market_context_alert_active"
                    )
                ]
            )
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
            Mapping[str, object], runtime_by_hypothesis.get(hypothesis_id) or {}
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
            if _safe_text(getattr(metric_window, "observed_stage", None)) != "live":
                reasons.append("promotion_certificate_not_live_runtime")
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
            if (
                _safe_text(getattr(metric_window, "observed_stage", None)) == "live"
                and promotion_decision is not None
            ):
                reasons.extend(
                    _certificate_runtime_ledger_reason_codes(
                        evidence_row=row,
                        runtime_item=runtime_item,
                        metric_window=metric_window,
                        promotion_decision=promotion_decision,
                    )
                )

        if promotion_decision is None:
            reasons.append("promotion_decision_evidence_missing")
        else:
            promotion_decision_id = str(promotion_decision.id)
            if candidate_id is None:
                candidate_id = promotion_decision.candidate_id
            if capital_stage is None:
                capital_stage = promotion_decision.state
            reasons.extend(
                _promotion_decision_blocking_reason_codes(promotion_decision)
            )
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


def _runtime_hypothesis_ids_for_gate_scope(
    runtime_items: Sequence[Mapping[str, Any]],
    *,
    eligibility_key: str,
) -> set[str]:
    return {
        hypothesis_id
        for item in runtime_items
        if bool(item.get(eligibility_key))
        for hypothesis_id in [str(item.get("hypothesis_id") or "").strip()]
        if hypothesis_id
    }


def _runtime_ledger_hypothesis_ids_for_gate_scope(
    runtime_ledger_candidates: Sequence[Mapping[str, object]],
) -> set[str]:
    return {
        hypothesis_id
        for candidate in runtime_ledger_candidates
        for hypothesis_id in [str(candidate.get("hypothesis_id") or "").strip()]
        if hypothesis_id
    }


def _candidate_reason_codes_for_gate_scope(
    evaluated_tuples: Sequence[Mapping[str, object]],
    *,
    hypothesis_ids: set[str],
) -> list[str]:
    scoped_tuples = [
        item
        for item in evaluated_tuples
        if str(item.get("hypothesis_id") or "").strip() in hypothesis_ids
    ]
    source_tuples = scoped_tuples if scoped_tuples else list(evaluated_tuples)
    return [
        reason
        for item in source_tuples
        for reason in cast(Sequence[str], item.get("reason_codes") or [])
    ]


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
    runtime_window_import_health_gate = _runtime_window_import_health_gate_inputs(
        state,
        dependency_quorum_decision=dependency_decision,
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
    registry_item_payloads = [item.model_dump(mode="json") for item in registry.items]
    runtime_ledger_repair_candidates = (
        _load_runtime_ledger_repair_candidates(
            session,
            registry_items=registry_item_payloads,
        )
        if session is not None
        else []
    )
    runtime_ledger_paper_probation_candidates = (
        _runtime_ledger_paper_probation_candidates(runtime_ledger_repair_candidates)
    )
    runtime_ledger_paper_probation_import_plan = (
        _runtime_ledger_paper_probation_import_plan(
            runtime_ledger_paper_probation_candidates
        )
    )
    evidence_rows = (
        [dict(item) for item in promotion_certificate_evidence]
        if promotion_certificate_evidence is not None
        else _load_latest_certificate_evidence(
            session,
            hypothesis_ids=[item.hypothesis_id for item in registry.items],
            now=now,
            max_age_seconds=max_age_seconds,
        )
        if session is not None
        else []
    )
    runtime_evidence_rows: list[Mapping[str, object]] = []
    for row in evidence_rows:
        metric_window = cast(
            StrategyHypothesisMetricWindow | None, row.get("metric_window")
        )
        promotion_decision = cast(
            StrategyPromotionDecision | None, row.get("promotion_decision")
        )
        if metric_window is None or promotion_decision is None:
            continue
        if _safe_text(getattr(metric_window, "observed_stage", None)) not in {
            "paper",
            "live",
        }:
            continue
        runtime_evidence_rows.append(row)
    claimed_promotion_eligible_total = _safe_int(
        summary.get("promotion_eligible_total")
    )
    if runtime_items and runtime_evidence_rows:
        runtime_items = _merge_runtime_certificate_evidence(
            runtime_items,
            evidence=runtime_evidence_rows,
            now=now,
            max_age_seconds=max_age_seconds,
        )
        summary = _refresh_runtime_summary_totals(summary, runtime_items)
    promotion_eligible_total = _safe_int(summary.get("promotion_eligible_total"))
    paper_probation_eligible_total = _safe_int(
        summary.get("paper_probation_eligible_total")
    )
    paper_probation_eligible_total = (
        _paper_probation_eligible_total_with_runtime_ledger(
            legacy_total=paper_probation_eligible_total,
            runtime_items=runtime_items,
            runtime_ledger_candidates=runtime_ledger_paper_probation_candidates,
        )
    )
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
            "paper_probation_eligible_total": paper_probation_eligible_total,
            "dependency_quorum_decision": dependency_decision,
            **runtime_window_import_health_gate,
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
            "runtime_ledger_repair_candidates": runtime_ledger_repair_candidates,
            "runtime_ledger_paper_probation_candidates": (
                runtime_ledger_paper_probation_candidates
            ),
            "runtime_ledger_paper_probation_eligible_total": len(
                runtime_ledger_paper_probation_candidates
            ),
            "runtime_ledger_paper_probation_import_plan": (
                runtime_ledger_paper_probation_import_plan
            ),
            "profit_window_contract": profit_window_contract,
            "profit_lease_projection": profit_lease_projection,
        }

    blocked_reasons: list[str] = []
    if blocking_toggle_mismatches:
        blocked_reasons.append("critical_toggle_parity_diverged")
    if promotion_eligible_total <= 0:
        blocked_reasons.append("alpha_readiness_not_promotion_eligible")
        if runtime_ledger_paper_probation_candidates:
            blocked_reasons.append("paper_probation_evidence_collection_only")
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
        registry_items=registry_item_payloads,
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

    promotion_scope_hypothesis_ids = _runtime_hypothesis_ids_for_gate_scope(
        runtime_items,
        eligibility_key="promotion_eligible",
    )
    paper_probation_scope_hypothesis_ids = _runtime_hypothesis_ids_for_gate_scope(
        runtime_items,
        eligibility_key="paper_probation_eligible",
    )
    paper_probation_scope_hypothesis_ids.update(
        _runtime_ledger_hypothesis_ids_for_gate_scope(
            runtime_ledger_paper_probation_candidates
        )
    )
    if (
        promotion_eligible_total > 0 or claimed_promotion_eligible_total > 0
    ) and not valid_candidates:
        if not evaluated_tuples:
            blocked_reasons.append("promotion_certificate_missing")
            blocked_reasons.append("hypothesis_window_evidence_missing")
        else:
            blocked_reasons.extend(
                _candidate_reason_codes_for_gate_scope(
                    evaluated_tuples,
                    hypothesis_ids=promotion_scope_hypothesis_ids,
                )
            )
            blocked_reasons.append("promotion_certificate_missing")
    elif paper_probation_eligible_total > 0 and evaluated_tuples:
        blocked_reasons.extend(
            _candidate_reason_codes_for_gate_scope(
                evaluated_tuples,
                hypothesis_ids=paper_probation_scope_hypothesis_ids,
            )
        )

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
        "paper_probation_eligible_total": paper_probation_eligible_total,
        "dependency_quorum_decision": dependency_decision,
        **runtime_window_import_health_gate,
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
        "runtime_ledger_repair_candidates": runtime_ledger_repair_candidates,
        "runtime_ledger_paper_probation_candidates": (
            runtime_ledger_paper_probation_candidates
        ),
        "runtime_ledger_paper_probation_eligible_total": len(
            runtime_ledger_paper_probation_candidates
        ),
        "runtime_ledger_paper_probation_import_plan": (
            runtime_ledger_paper_probation_import_plan
        ),
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
