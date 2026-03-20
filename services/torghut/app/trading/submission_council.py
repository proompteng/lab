"""Shared live-submission gate helpers for status and runtime paths."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping, Sequence
from datetime import datetime, timedelta, timezone
from threading import Lock
from typing import Any, cast
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
from urllib.request import Request, urlopen

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import settings
from ..models import StrategyHypothesisMetricWindow, StrategyPromotionDecision
from .hypotheses import (
    compile_hypothesis_runtime_statuses,
    load_hypothesis_registry,
    load_jangar_dependency_quorum,
    summarize_hypothesis_runtime_statuses,
)
from .tca import build_tca_gate_inputs

_CAPITAL_STAGE_ORDER = (
    'shadow',
    '0.10x canary',
    '0.25x canary',
    '0.50x live',
    '1.00x live',
)
_LIVE_SUBMISSION_BLOCKING_TOGGLE_MISMATCHES = frozenset(
    {
        'TRADING_ENABLED',
        'TRADING_KILL_SWITCH_ENABLED',
        'TRADING_MODE',
    }
)
_QUANT_HEALTH_CACHE_LOCK = Lock()
_QUANT_HEALTH_CACHE: dict[str, object] = {}
_STALE_SEGMENT_STATES = frozenset({'stale', 'down', 'degraded', 'error', 'blocked'})
_TA_CORE_REASON_CODES = frozenset(
    {
        'feature_rows_missing',
        'no_signal_streak_exceeded',
        'required_feature_set_unavailable',
        'signal_continuity_alert_active',
        'signal_lag_exceeded',
    }
)


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
        if normalized in {'true', '1', 'yes', 'y', 'on'}:
            return True
        if normalized in {'false', '0', 'no', 'n', 'off'}:
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
    raw = (value or '').strip()
    if not raw:
        return None
    parsed = urlsplit(raw)
    if not parsed.scheme or not parsed.netloc:
        return None
    path = parsed.path if preserve_path else ''
    query = parsed.query if preserve_path else ''
    resolved_path = path if preserve_path and path else '/api/torghut/trading/control-plane/quant/health'
    return urlunsplit(
        (
            parsed.scheme,
            parsed.netloc,
            resolved_path,
            query,
            '',
        )
    )


def resolve_quant_health_url() -> str | None:
    for candidate, preserve_path in (
        (settings.trading_jangar_quant_health_url, True),
        (settings.trading_jangar_control_plane_status_url, False),
        (settings.trading_market_context_url, False),
    ):
        resolved = _derive_quant_health_url(
            candidate,
            preserve_path=preserve_path,
        )
        if resolved:
            return resolved
    return None


def _build_quant_health_request_url(
    base_url: str,
    *,
    account: str,
    window: str,
) -> str:
    parsed = urlsplit(base_url)
    query_params = dict(parse_qsl(parsed.query, keep_blank_values=True))
    if account:
        query_params['account'] = account
    if window:
        query_params['window'] = window
    query = urlencode(query_params)
    return urlunsplit(
        (
            parsed.scheme,
            parsed.netloc,
            parsed.path,
            query,
            '',
        )
    )


def load_quant_evidence_status(
    *, account_label: str | None = None
) -> dict[str, object]:
    window = settings.trading_jangar_quant_window
    account = (account_label or settings.trading_account_label or '').strip()
    base_url = resolve_quant_health_url()
    if not base_url:
        return {
            'required': False,
            'ok': True,
            'status': 'skipped',
            'reason': 'quant_health_not_configured',
            'blocking_reasons': [],
            'account': account or None,
            'window': window,
            'source_url': None,
        }

    request_url = _build_quant_health_request_url(
        base_url,
        account=account,
        window=window,
    )
    ttl_seconds = max(0, int(settings.trading_jangar_control_plane_cache_ttl_seconds))
    now = datetime.now(timezone.utc)

    if ttl_seconds > 0:
        with _QUANT_HEALTH_CACHE_LOCK:
            cached = cast(dict[str, Any] | None, _QUANT_HEALTH_CACHE.get(request_url))
            if cached is not None:
                checked_at = cast(datetime | None, cached.get('checked_at'))
                if checked_at is not None and now - checked_at <= timedelta(
                    seconds=ttl_seconds
                ):
                    return dict(cast(Mapping[str, Any], cached['payload']))

    status_payload: dict[str, object]
    try:
        request = Request(
            request_url, method='GET', headers={'accept': 'application/json'}
        )
        with urlopen(
            request, timeout=settings.trading_jangar_control_plane_timeout_seconds
        ) as response:
            status_code = int(getattr(response, 'status', 200))
            if status_code < 200 or status_code >= 300:
                raise RuntimeError(f'quant_health_http_{status_code}')
            decoded = json.loads(response.read().decode('utf-8'))
        if not isinstance(decoded, Mapping):
            raise RuntimeError('quant_health_payload_invalid')
        payload = cast(Mapping[str, Any], decoded)
        if payload.get('ok') is not True:
            message = str(
                payload.get('message') or 'quant_health_request_failed'
            ).strip()
            raise RuntimeError(message)
        latest_metrics_count = _safe_int(payload.get('latestMetricsCount'))
        empty_latest_store_alarm = bool(payload.get('emptyLatestStoreAlarm'))
        missing_update_alarm = bool(payload.get('missingUpdateAlarm'))
        stages_raw = payload.get('stages')
        stages = (
            list(cast(Sequence[object], stages_raw))
            if isinstance(stages_raw, Sequence)
            and not isinstance(stages_raw, (str, bytes, bytearray))
            else []
        )
        blocking_reasons: list[str] = []
        if latest_metrics_count <= 0:
            blocking_reasons.append('quant_latest_metrics_empty')
        if empty_latest_store_alarm:
            blocking_reasons.append('quant_latest_store_alarm')
        if missing_update_alarm:
            blocking_reasons.append('quant_metrics_update_missing')
        if len(stages) == 0:
            blocking_reasons.append('quant_pipeline_stages_missing')
        elif any(
            _safe_bool(cast(Mapping[str, Any], stage).get('ok')) is False
            for stage in stages
            if isinstance(stage, Mapping)
        ):
            blocking_reasons.append('quant_pipeline_degraded')

        raw_status = str(payload.get('status') or '').strip().lower()
        if not blocking_reasons and raw_status not in {'ok', 'healthy'}:
            blocking_reasons.append('quant_health_degraded')

        status_payload = {
            'required': True,
            'ok': len(blocking_reasons) == 0,
            'status': 'healthy' if len(blocking_reasons) == 0 else 'degraded',
            'reason': 'ready' if len(blocking_reasons) == 0 else blocking_reasons[0],
            'blocking_reasons': blocking_reasons,
            'account': account or None,
            'window': window,
            'source_url': request_url,
            'latest_metrics_count': latest_metrics_count,
            'latest_metrics_updated_at': payload.get('latestMetricsUpdatedAt'),
            'empty_latest_store_alarm': empty_latest_store_alarm,
            'missing_update_alarm': missing_update_alarm,
            'metrics_pipeline_lag_seconds': payload.get('metricsPipelineLagSeconds'),
            'stage_count': len(stages),
            'max_stage_lag_seconds': payload.get('maxStageLagSeconds'),
            'stages': stages,
            'as_of': payload.get('asOf'),
        }
    except Exception as exc:
        status_payload = {
            'required': True,
            'ok': False,
            'status': 'unknown',
            'reason': 'quant_health_fetch_failed',
            'blocking_reasons': ['quant_health_fetch_failed'],
            'account': account or None,
            'window': window,
            'source_url': request_url,
            'message': str(exc),
            'latest_metrics_count': None,
            'latest_metrics_updated_at': None,
            'empty_latest_store_alarm': None,
            'missing_update_alarm': None,
            'metrics_pipeline_lag_seconds': None,
            'stage_count': None,
            'max_stage_lag_seconds': None,
            'stages': [],
            'as_of': None,
        }

    if ttl_seconds > 0:
        with _QUANT_HEALTH_CACHE_LOCK:
            _QUANT_HEALTH_CACHE[request_url] = {
                'checked_at': now,
                'payload': dict(status_payload),
            }
    return dict(status_payload)


def critical_trading_toggle_snapshot() -> dict[str, object]:
    return {
        'TRADING_ENABLED': settings.trading_enabled,
        'TRADING_AUTONOMY_ENABLED': settings.trading_autonomy_enabled,
        'TRADING_AUTONOMY_ALLOW_LIVE_PROMOTION': settings.trading_autonomy_allow_live_promotion,
        'TRADING_KILL_SWITCH_ENABLED': settings.trading_kill_switch_enabled,
        'TRADING_MODE': settings.trading_mode,
        'TRADING_EXECUTION_ADAPTER_POLICY': settings.trading_execution_adapter_policy,
    }


def build_shadow_first_toggle_parity() -> dict[str, object]:
    expected = {
        'TRADING_ENABLED': True,
        'TRADING_AUTONOMY_ENABLED': False,
        'TRADING_AUTONOMY_ALLOW_LIVE_PROMOTION': False,
        'TRADING_KILL_SWITCH_ENABLED': False,
        'TRADING_MODE': 'live',
    }
    effective = critical_trading_toggle_snapshot()
    mismatches = [
        key
        for key, expected_value in expected.items()
        if effective.get(key) != expected_value
    ]
    return {
        'status': 'aligned' if not mismatches else 'diverged',
        'mismatches': mismatches,
        'expected': expected,
        'effective': effective,
    }


def resolve_active_capital_stage(
    hypothesis_summary: Mapping[str, Any] | None,
) -> str | None:
    if not isinstance(hypothesis_summary, Mapping):
        return None
    totals_raw = hypothesis_summary.get('capital_stage_totals')
    if not isinstance(totals_raw, Mapping):
        return None
    totals = cast(Mapping[str, Any], totals_raw)
    for stage in reversed(_CAPITAL_STAGE_ORDER):
        count = totals.get(stage)
        if isinstance(count, int) and count > 0:
            return stage
    return 'shadow' if totals else None


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
    summary = summarize_hypothesis_runtime_statuses(
        items,
        registry=registry,
        dependency_quorum=dependency_quorum,
    )
    summary['items'] = items
    return summary


def _extract_runtime_summary(
    hypothesis_summary: Mapping[str, Any] | None,
) -> tuple[Mapping[str, Any], list[Mapping[str, Any]]]:
    if not isinstance(hypothesis_summary, Mapping):
        return {}, []
    nested_summary = hypothesis_summary.get('summary')
    if isinstance(nested_summary, Mapping):
        items_raw = hypothesis_summary.get('items')
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
    items_raw = hypothesis_summary.get('items')
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


def build_submission_gate_market_context_status(state: object) -> dict[str, object]:
    return {
        'last_symbol': getattr(state, 'last_market_context_symbol', None),
        'last_checked_at': getattr(state, 'last_market_context_checked_at', None),
        'last_as_of': getattr(state, 'last_market_context_as_of', None),
        'last_freshness_seconds': getattr(
            state, 'last_market_context_freshness_seconds', None
        ),
        'last_domain_states': dict(
            cast(
                Mapping[str, str],
                getattr(state, 'last_market_context_domain_states', {}),
            )
        ),
        'last_risk_flags': list(
            cast(Sequence[str], getattr(state, 'last_market_context_risk_flags', []))
        ),
        'alert_active': bool(getattr(state, 'market_context_alert_active', False)),
        'alert_reason': getattr(state, 'market_context_alert_reason', None),
    }


def _load_latest_certificate_evidence(
    session: Session,
    *,
    hypothesis_ids: Sequence[str],
) -> list[dict[str, object]]:
    normalized_ids = [hypothesis_id for hypothesis_id in hypothesis_ids if hypothesis_id]
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

    latest_promotions: dict[str, StrategyPromotionDecision] = {}
    promotion_rows = session.execute(
        select(StrategyPromotionDecision)
        .where(
            StrategyPromotionDecision.hypothesis_id.in_(normalized_ids),
            StrategyPromotionDecision.allowed.is_(True),
        )
        .order_by(StrategyPromotionDecision.created_at.desc())
    ).scalars()
    for row in promotion_rows:
        if row.hypothesis_id in latest_promotions:
            continue
        latest_promotions[row.hypothesis_id] = row

    evidence: list[dict[str, object]] = []
    for hypothesis_id in normalized_ids:
        metric_window = latest_windows.get(hypothesis_id)
        promotion_decision = latest_promotions.get(hypothesis_id)
        evidence.append(
            {
                'hypothesis_id': hypothesis_id,
                'metric_window': metric_window,
                'promotion_decision': promotion_decision,
            }
        )
    return evidence


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
            Mapping[str, Any], market_context_ref.get('last_domain_states', {})
        ).items()
        if str(key).strip()
    }
    market_context_reasons: list[str] = []
    if bool(market_context_ref.get('alert_active')):
        market_context_reasons.append(
            str(market_context_ref.get('alert_reason') or 'market_context_alert_active')
        )
    stale_domains = [
        domain
        for domain, segment_state in sorted(domain_states.items())
        if segment_state in _STALE_SEGMENT_STATES
    ]
    market_context_reasons.extend(
        [f'market_context_domain_{domain}_{domain_states[domain]}' for domain in stale_domains]
    )

    ta_core_reasons: list[str] = []
    if bool(getattr(state, 'signal_continuity_alert_active', False)):
        ta_core_reasons.append('signal_continuity_alert_active')
    if _safe_int(getattr(getattr(state, 'metrics', None), 'signal_lag_seconds', None)) > 0:
        signal_lag = _safe_int(getattr(getattr(state, 'metrics', None), 'signal_lag_seconds', None))
        if signal_lag > 0 and bool(getattr(state, 'signal_continuity_alert_active', False)):
            ta_core_reasons.append('signal_lag_exceeded')
    for item in runtime_items:
        item_reasons = [
            str(reason).strip()
            for reason in cast(Sequence[object], item.get('reasons') or [])
            if str(reason).strip() in _TA_CORE_REASON_CODES
        ]
        ta_core_reasons.extend(item_reasons)

    execution_reasons = (
        ['critical_toggle_parity_diverged'] if list(blocking_toggle_mismatches) else []
    )
    empirical_reasons = [] if empirical_ready is not False else ['empirical_jobs_not_ready']
    llm_review_reasons: list[str] = []
    if dspy_mode == 'active' and dspy_live_ready is False:
        llm_review_reasons.append('dspy_live_runtime_not_ready')

    raw_segments = {
        'market-context': market_context_reasons,
        'ta-core': ta_core_reasons,
        'execution': execution_reasons,
        'empirical': empirical_reasons,
        'llm-review': llm_review_reasons,
    }
    return {
        segment: {
            'state': 'ok' if not reasons else 'blocked',
            'reason_codes': _normalize_reason_codes(reasons),
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
        str(item.get('hypothesis_id') or ''): item
        for item in registry_items
        if str(item.get('hypothesis_id') or '').strip()
    }
    runtime_by_hypothesis = {
        str(item.get('hypothesis_id') or ''): item
        for item in runtime_items
        if str(item.get('hypothesis_id') or '').strip()
    }
    evaluated: list[dict[str, object]] = []
    valid: list[dict[str, object]] = []
    for row in evidence:
        hypothesis_id = str(row.get('hypothesis_id') or '').strip()
        if not hypothesis_id:
            continue
        manifest = cast(Mapping[str, Any], manifests.get(hypothesis_id) or {})
        runtime_item = cast(Mapping[str, Any], runtime_by_hypothesis.get(hypothesis_id) or {})
        metric_window = cast(
            StrategyHypothesisMetricWindow | None, row.get('metric_window')
        )
        promotion_decision = cast(
            StrategyPromotionDecision | None, row.get('promotion_decision')
        )
        reasons: list[str] = []
        metric_window_id: str | None = None
        promotion_decision_id: str | None = None
        candidate_id = None
        capital_stage = None
        issued_at = None

        if metric_window is None:
            reasons.append('hypothesis_window_evidence_missing')
        else:
            metric_window_id = str(metric_window.id)
            candidate_id = metric_window.candidate_id
            capital_stage = metric_window.capital_stage
            issued_at = metric_window.window_ended_at or metric_window.created_at
            if issued_at.tzinfo is None:
                issued_at = issued_at.replace(tzinfo=timezone.utc)
            if max_age_seconds > 0 and issued_at < now - timedelta(seconds=max_age_seconds):
                reasons.append('hypothesis_window_evidence_stale')
            if not bool(metric_window.continuity_ok):
                reasons.append('hypothesis_window_continuity_failed')
            if not bool(metric_window.drift_ok):
                reasons.append('hypothesis_window_drift_failed')
            if _safe_text(metric_window.dependency_quorum_decision) != 'allow':
                reasons.append('hypothesis_window_dependency_quorum_not_allow')

        if promotion_decision is not None:
            promotion_decision_id = str(promotion_decision.id)
            if candidate_id is None:
                candidate_id = promotion_decision.candidate_id
            if capital_stage is None:
                capital_stage = promotion_decision.state
        if _safe_text(capital_stage) in {None, 'shadow'}:
            reasons.append('promotion_certificate_shadow_only')

        segment_dependencies = [
            str(segment).strip()
            for segment in cast(
                Sequence[object], manifest.get('segment_dependencies') or []
            )
            if str(segment).strip()
        ]
        blocked_segments: list[str] = []
        if runtime_item:
            if not bool(runtime_item.get('promotion_eligible')):
                reasons.append('alpha_hypothesis_not_promotion_eligible')
            runtime_stage = _safe_text(runtime_item.get('capital_stage'))
            if runtime_stage in {None, 'shadow'}:
                reasons.append('alpha_hypothesis_shadow_only')
        elif runtime_items:
            reasons.append('alpha_hypothesis_runtime_missing')
        for segment in segment_dependencies:
            segment_payload = cast(Mapping[str, Any], segment_summary.get(segment) or {})
            if str(segment_payload.get('state') or '').strip() != 'ok':
                blocked_segments.append(segment)
                reasons.extend(
                    [
                        f'segment_{segment}_blocked',
                        *cast(Sequence[str], segment_payload.get('reason_codes') or []),
                    ]
                )

        evaluated_row: dict[str, object] = {
            'hypothesis_id': hypothesis_id,
            'candidate_id': candidate_id,
            'strategy_id': manifest.get('strategy_family'),
            'account': account,
            'window': window,
            'capital_state': capital_stage or 'observe',
            'capital_stage': capital_stage or 'shadow',
            'segment_dependencies': segment_dependencies,
            'blocked_segments': sorted(set(blocked_segments)),
            'reason_codes': _normalize_reason_codes(reasons),
            'metric_window_id': metric_window_id,
            'promotion_decision_id': promotion_decision_id,
            'issued_at': issued_at,
            'expires_at': (
                issued_at + timedelta(seconds=max_age_seconds)
                if issued_at is not None and max_age_seconds > 0
                else None
            ),
        }
        evaluated.append(evaluated_row)
        if not evaluated_row['reason_codes']:
            valid.append(evaluated_row)
    return evaluated, valid


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
) -> dict[str, object]:
    summary: Mapping[str, Any] = hypothesis_summary or {}
    summary, runtime_items = _extract_runtime_summary(hypothesis_summary)
    dependency_quorum_payload: dict[str, Any] = (
        dict(cast(Mapping[str, Any], summary.get('dependency_quorum')))
        if isinstance(summary.get('dependency_quorum'), Mapping)
        else {}
    )
    dependency_decision = (
        str(dependency_quorum_payload.get('decision') or '').strip().lower()
        or 'unknown'
    )
    promotion_eligible_total = _safe_int(summary.get('promotion_eligible_total'))
    empirical_ready = (
        bool(empirical_jobs_status.get('ready'))
        if isinstance(empirical_jobs_status, Mapping)
        else None
    )
    dspy_mode = (
        str(dspy_runtime_status.get('mode') or '').strip().lower()
        if isinstance(dspy_runtime_status, Mapping)
        else ''
    )
    dspy_live_ready = (
        bool(dspy_runtime_status.get('live_ready'))
        if isinstance(dspy_runtime_status, Mapping) and dspy_mode == 'active'
        else None
    )
    configured_live_promotion = bool(settings.trading_autonomy_allow_live_promotion)
    autonomy_promotion_eligible = bool(
        getattr(state, 'last_autonomy_promotion_eligible', False)
    )
    autonomy_promotion_action = getattr(state, 'last_autonomy_promotion_action', None)
    drift_live_promotion_eligible = bool(
        getattr(state, 'drift_live_promotion_eligible', False)
    )
    active_capital_stage = resolve_active_capital_stage(summary)
    critical_toggle_parity = build_shadow_first_toggle_parity()
    critical_toggle_mismatches = list(
        cast(list[str], critical_toggle_parity.get('mismatches') or [])
    )
    quant_evidence = (
        dict(quant_health_status)
        if isinstance(quant_health_status, Mapping)
        else load_quant_evidence_status(account_label=quant_account_label)
    )
    quant_required = bool(quant_evidence.get('required'))
    quant_ready = bool(quant_evidence.get('ok'))
    quant_reason = str(quant_evidence.get('reason') or '').strip() or 'unknown'
    quant_blocking_reasons = [
        str(item).strip()
        for item in cast(Sequence[object], quant_evidence.get('blocking_reasons') or [])
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
    segment_summary = _segment_summary(
        state=state,
        runtime_items=runtime_items,
        blocking_toggle_mismatches=blocking_toggle_mismatches,
        empirical_ready=empirical_ready,
        dspy_mode=dspy_mode,
        dspy_live_ready=dspy_live_ready,
    )

    if settings.trading_mode != 'live':
        return {
            'allowed': True,
            'reason': 'non_live_mode',
            'blocked_reasons': [],
            'certificate_id': None,
            'capital_stage': settings.trading_mode,
            'capital_state': settings.trading_mode,
            'issued_at': None,
            'expires_at': None,
            'configured_live_promotion': configured_live_promotion,
            'autonomy_promotion_eligible': autonomy_promotion_eligible,
            'autonomy_promotion_action': autonomy_promotion_action,
            'drift_live_promotion_eligible': drift_live_promotion_eligible,
            'promotion_eligible_total': promotion_eligible_total,
            'dependency_quorum_decision': dependency_decision,
            'empirical_jobs_ready': empirical_ready,
            'dspy_live_ready': dspy_live_ready,
            'critical_toggle_parity': critical_toggle_parity,
            'critical_toggle_parity_blocking_mismatches': blocking_toggle_mismatches,
            'active_capital_stage': active_capital_stage,
            'reason_codes': ['non_live_mode'],
            'quant_evidence': quant_evidence,
            'segment_summary': segment_summary,
            'quant_health_ref': {
                'account': quant_evidence.get('account'),
                'window': quant_evidence.get('window'),
                'status': quant_evidence.get('status'),
                'source_url': quant_evidence.get('source_url'),
                'latest_metrics_updated_at': quant_evidence.get(
                    'latest_metrics_updated_at'
                ),
            },
            'market_context_ref': market_context_ref,
            'evidence_tuple': {
                'hypothesis_id': None,
                'candidate_id': None,
                'strategy_id': None,
                'account': quant_evidence.get('account'),
                'window': quant_evidence.get('window'),
                'capital_state': settings.trading_mode,
            },
            'evaluated_tuples': [],
        }

    blocked_reasons: list[str] = []
    if blocking_toggle_mismatches:
        blocked_reasons.append('critical_toggle_parity_diverged')
    if promotion_eligible_total <= 0:
        blocked_reasons.append('alpha_readiness_not_promotion_eligible')
    if empirical_ready is False:
        blocked_reasons.append('empirical_jobs_not_ready')
    if dspy_live_ready is False:
        blocked_reasons.append('dspy_live_runtime_not_ready')
    if dependency_decision != 'allow':
        blocked_reasons.append(f'dependency_quorum_{dependency_decision}')
    if quant_required and not quant_ready:
        blocked_reasons.extend(quant_blocking_reasons or [quant_reason])

    evidence_rows = (
        [
            dict(item) for item in promotion_certificate_evidence
        ]
        if promotion_certificate_evidence is not None
        else _load_latest_certificate_evidence(
            session,
            hypothesis_ids=[item.hypothesis_id for item in registry.items],
        )
        if session is not None
        else []
    )
    evaluated_tuples, valid_candidates = _evaluate_certificate_candidates(
        evidence=evidence_rows,
        segment_summary=segment_summary,
        runtime_items=runtime_items,
        registry_items=[item.model_dump(mode='json') for item in registry.items],
        max_age_seconds=max_age_seconds,
        now=now,
        window=_safe_text(quant_evidence.get('window')),
        account=_safe_text(quant_evidence.get('account')),
    )

    if promotion_eligible_total > 0 and not valid_candidates:
        if not evaluated_tuples:
            blocked_reasons.append('promotion_certificate_missing')
            blocked_reasons.append('hypothesis_window_evidence_missing')
        else:
            candidate_reason_codes = [
                reason
                for item in evaluated_tuples
                for reason in cast(Sequence[str], item.get('reason_codes') or [])
            ]
            blocked_reasons.extend(candidate_reason_codes)
            blocked_reasons.append('promotion_certificate_missing')

    blocked_reasons = _normalize_reason_codes(blocked_reasons)

    chosen_candidate = (
        max(valid_candidates, key=lambda item: _stage_rank(item.get('capital_stage')))
        if valid_candidates
        else None
    )
    allowed = chosen_candidate is not None and not blocked_reasons

    certificate_id: str | None = None
    issued_at = None
    expires_at = None
    capital_stage = 'shadow'
    capital_state = 'observe'
    reason_codes: list[str]
    reason = blocked_reasons[0] if blocked_reasons else 'promotion_certificate_missing'
    if allowed and chosen_candidate is not None:
        capital_stage = str(chosen_candidate.get('capital_stage') or 'shadow')
        capital_state = capital_stage
        issued_at = chosen_candidate.get('issued_at')
        expires_at = chosen_candidate.get('expires_at')
        certificate_basis = '|'.join(
            [
                str(chosen_candidate.get('hypothesis_id') or ''),
                str(chosen_candidate.get('candidate_id') or ''),
                str(chosen_candidate.get('strategy_id') or ''),
                str(chosen_candidate.get('account') or ''),
                str(chosen_candidate.get('window') or ''),
                capital_state,
                str(chosen_candidate.get('metric_window_id') or ''),
                str(chosen_candidate.get('promotion_decision_id') or ''),
            ]
        )
        certificate_id = hashlib.sha256(certificate_basis.encode('utf-8')).hexdigest()[:24]
        reason = 'promotion_certificate_valid'
        reason_codes = ['promotion_certificate_valid']
    else:
        reason_codes = blocked_reasons or ['promotion_certificate_missing']

    evidence_tuple = {
        'hypothesis_id': chosen_candidate.get('hypothesis_id') if chosen_candidate else None,
        'candidate_id': chosen_candidate.get('candidate_id') if chosen_candidate else None,
        'strategy_id': chosen_candidate.get('strategy_id') if chosen_candidate else None,
        'account': quant_evidence.get('account'),
        'window': quant_evidence.get('window'),
        'capital_state': capital_state,
    }

    return {
        'allowed': allowed,
        'reason': reason,
        'blocked_reasons': blocked_reasons,
        'certificate_id': certificate_id,
        'capital_stage': capital_stage,
        'capital_state': capital_state,
        'issued_at': issued_at,
        'expires_at': expires_at,
        'configured_live_promotion': configured_live_promotion,
        'autonomy_promotion_eligible': autonomy_promotion_eligible,
        'autonomy_promotion_action': autonomy_promotion_action,
        'drift_live_promotion_eligible': drift_live_promotion_eligible,
        'promotion_eligible_total': promotion_eligible_total,
        'dependency_quorum_decision': dependency_decision,
        'empirical_jobs_ready': empirical_ready,
        'dspy_live_ready': dspy_live_ready,
        'critical_toggle_parity': critical_toggle_parity,
        'critical_toggle_parity_blocking_mismatches': blocking_toggle_mismatches,
        'active_capital_stage': active_capital_stage,
        'reason_codes': reason_codes,
        'quant_evidence': quant_evidence,
        'segment_summary': {
            'segments': segment_summary,
            'evaluated_hypotheses': evaluated_tuples,
        },
        'quant_health_ref': {
            'account': quant_evidence.get('account'),
            'window': quant_evidence.get('window'),
            'status': quant_evidence.get('status'),
            'source_url': quant_evidence.get('source_url'),
            'latest_metrics_updated_at': quant_evidence.get(
                'latest_metrics_updated_at'
            ),
        },
        'market_context_ref': market_context_ref,
        'evidence_tuple': evidence_tuple,
        'evaluated_tuples': evaluated_tuples,
    }


__all__ = [
    'build_hypothesis_runtime_summary',
    'build_live_submission_gate_payload',
    'build_shadow_first_toggle_parity',
    'build_submission_gate_market_context_status',
    'critical_trading_toggle_snapshot',
    'load_quant_evidence_status',
    'resolve_active_capital_stage',
    'resolve_quant_health_url',
]
