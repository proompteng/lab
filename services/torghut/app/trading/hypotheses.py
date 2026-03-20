"""Hypothesis registry loading and runtime alpha-readiness compilation."""

from __future__ import annotations

import json
from collections import Counter
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from threading import Lock
from typing import Any, Literal, cast
from urllib.request import Request, urlopen

import yaml
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from ..config import settings

HypothesisState = Literal['blocked', 'shadow', 'canary_live', 'scaled_live']
CapitalStage = Literal[
    'shadow',
    '0.10x canary',
    '0.25x canary',
    '0.50x live',
    '1.00x live',
]
DependencyQuorumDecision = Literal['allow', 'delay', 'block', 'unknown']

_KNOWN_DEPENDENCY_CAPABILITIES = {
    'jangar_dependency_quorum',
    'signal_continuity',
    'drift_governance',
    'feature_coverage',
    'market_context_freshness',
    'evidence_continuity',
}

_JANGAR_QUORUM_CACHE_LOCK = Lock()
_JANGAR_QUORUM_CACHE: dict[str, object] = {}


def _stable_string_list(values: Sequence[str]) -> list[str]:
    normalized = [value.strip() for value in values if value.strip()]
    return sorted(set(normalized))


def _coerce_decimal(value: object, default: Decimal = Decimal('0')) -> Decimal:
    if isinstance(value, Decimal):
        return value
    if isinstance(value, (int, float)):
        return Decimal(str(value))
    if isinstance(value, str) and value.strip():
        return Decimal(value.strip())
    return default


def _optional_int(value: object) -> int | None:
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
            return None
    return None


def _parse_iso8601(value: object) -> datetime | None:
    if not isinstance(value, str):
        return None
    normalized = value.strip()
    if not normalized:
        return None
    if normalized.endswith('Z'):
        normalized = f'{normalized[:-1]}+00:00'
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _decimal_to_string(value: Decimal) -> str:
    normalized = value.normalize()
    rendered = format(normalized, 'f')
    return rendered.rstrip('0').rstrip('.') if '.' in rendered else rendered


def _normalize_dependency_capability(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = value.strip().lower().replace('-', '_')
    return normalized if normalized else None


def _resolve_required_dependency_capabilities(manifest: HypothesisManifest) -> tuple[set[str], set[str]]:
    explicit = {
        item
        for item in (
            _normalize_dependency_capability(item)
            for item in manifest.required_dependency_capabilities
        )
        if item is not None
    }
    if explicit:
        unknown = explicit - _KNOWN_DEPENDENCY_CAPABILITIES
        return explicit, unknown

    return {
        'jangar_dependency_quorum',
        'signal_continuity',
        'drift_governance',
        'feature_coverage',
        'evidence_continuity',
        'market_context_freshness',
    }, set()


def _is_dependency_required(required: set[str], capability: str) -> bool:
    return capability in required


class HypothesisEntryRequirements(BaseModel):
    """Entry requirements that determine whether a lane can leave shadow or blocked."""

    model_config = ConfigDict(extra='forbid')

    max_signal_lag_seconds: int | None = None
    max_no_signal_streak: int | None = None
    max_market_context_freshness_seconds: int | None = None
    max_evidence_age_minutes: int | None = None
    min_feature_batch_rows: int = 1
    require_feature_rows: bool = True
    require_drift_checks: bool = True
    require_evidence_continuity: bool = True
    required_dependency_quorum: Literal['allow', 'allow_or_delay'] = 'allow'


class HypothesisManifest(BaseModel):
    """Source-controlled runtime contract for one alpha hypothesis."""

    model_config = ConfigDict(extra='forbid')

    schema_version: Literal['torghut.hypothesis-manifest.v1']
    hypothesis_id: str
    lane_id: str
    strategy_family: str
    initial_state: Literal['shadow', 'blocked'] = 'shadow'
    market_regimes: list[str] = Field(default_factory=list)
    required_feature_sets: list[str] = Field(default_factory=list)
    required_dependency_capabilities: list[str] = Field(default_factory=list)
    segment_dependencies: list[str] = Field(default_factory=list)
    expected_gross_edge_bps: Decimal
    max_allowed_slippage_bps: Decimal
    min_sample_count_for_live_canary: int
    min_sample_count_for_scale_up: int
    max_rolling_drawdown_bps: Decimal
    rollback_triggers: list[str] = Field(default_factory=list)
    promotion_gates: list[str] = Field(default_factory=list)
    entry_requirements: HypothesisEntryRequirements = Field(
        default_factory=HypothesisEntryRequirements
    )

    @field_validator(
        'market_regimes',
        'required_feature_sets',
        'required_dependency_capabilities',
        'segment_dependencies',
        'rollback_triggers',
        'promotion_gates',
        mode='before',
    )
    @classmethod
    def _normalize_list(cls, value: Any) -> list[str]:
        if value is None:
            return []
        if isinstance(value, str):
            return _stable_string_list([item for item in value.split(',')])
        if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
            return _stable_string_list([str(item) for item in cast(Sequence[object], value)])
        raise ValueError('manifest list fields must be a list or comma-delimited string')

    @field_validator('hypothesis_id', 'lane_id', 'strategy_family')
    @classmethod
    def _require_text(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError('manifest text fields cannot be empty')
        return normalized


@dataclass(frozen=True)
class HypothesisRegistryLoadResult:
    path: str | None
    loaded: bool
    items: list[HypothesisManifest]
    errors: list[str]


@dataclass(frozen=True)
class JangarDependencyQuorumStatus:
    decision: DependencyQuorumDecision
    reasons: list[str]
    message: str

    def as_payload(self) -> dict[str, object]:
        return {
            'decision': self.decision,
            'reasons': list(self.reasons),
            'message': self.message,
        }


def resolve_hypothesis_registry_path(path_value: str | None = None) -> Path | None:
    raw = (path_value or settings.trading_hypothesis_registry_path or '').strip()
    if not raw:
        return None
    path = Path(raw).expanduser()
    if path.is_absolute():
        return path
    service_root = Path(__file__).resolve().parents[2]
    return service_root / path


def _load_manifest_payload(path: Path) -> Any:
    raw = path.read_text(encoding='utf-8')
    if not raw.strip():
        raise ValueError(f'hypothesis manifest is empty: {path}')
    suffix = path.suffix.lower()
    if suffix == '.json':
        return json.loads(raw)
    if suffix in {'.yaml', '.yml'}:
        return yaml.safe_load(raw)
    raise ValueError(f'unsupported hypothesis manifest extension: {path.name}')


def load_hypothesis_registry(
    *,
    path_value: str | None = None,
    raise_on_error: bool = False,
) -> HypothesisRegistryLoadResult:
    resolved = resolve_hypothesis_registry_path(path_value)
    if resolved is None:
        return HypothesisRegistryLoadResult(
            path=None,
            loaded=False,
            items=[],
            errors=['hypothesis_registry_path_not_configured'],
        )
    if not resolved.exists():
        message = f'hypothesis registry path not found: {resolved}'
        if raise_on_error:
            raise RuntimeError(message)
        return HypothesisRegistryLoadResult(
            path=str(resolved),
            loaded=False,
            items=[],
            errors=[message],
        )

    manifest_paths: list[Path]
    if resolved.is_dir():
        manifest_paths = sorted(
            path
            for path in resolved.iterdir()
            if path.is_file() and path.suffix.lower() in {'.json', '.yaml', '.yml'}
        )
    else:
        manifest_paths = [resolved]

    items: list[HypothesisManifest] = []
    errors: list[str] = []
    seen_ids: set[str] = set()

    for path in manifest_paths:
        try:
            payload = _load_manifest_payload(path)
            if not isinstance(payload, Mapping):
                raise ValueError('hypothesis manifest payload must be an object')
            manifest = HypothesisManifest.model_validate(payload)
        except (
            OSError,
            json.JSONDecodeError,
            ValidationError,
            ValueError,
            yaml.YAMLError,
        ) as exc:
            errors.append(f'{path}: {exc}')
            continue
        if manifest.hypothesis_id in seen_ids:
            errors.append(f'{path}: duplicate hypothesis_id {manifest.hypothesis_id}')
            continue
        seen_ids.add(manifest.hypothesis_id)
        items.append(manifest)

    if errors and raise_on_error:
        raise RuntimeError('; '.join(errors))
    return HypothesisRegistryLoadResult(
        path=str(resolved),
        loaded=len(errors) == 0,
        items=items if len(errors) == 0 else [],
        errors=errors,
    )


def validate_hypothesis_registry_from_settings() -> None:
    load_hypothesis_registry(raise_on_error=True)


def _fallback_quorum_from_legacy_status(payload: Mapping[str, Any]) -> JangarDependencyQuorumStatus:
    workflows = payload.get('workflows')
    if isinstance(workflows, Mapping):
        workflows_map = cast(Mapping[str, Any], workflows)
        confidence = str(workflows_map.get('data_confidence') or '').strip()
        backoff_jobs = max(0, _optional_int(workflows_map.get('backoff_limit_exceeded_jobs')) or 0)
        if confidence == 'unknown':
            return JangarDependencyQuorumStatus(
                decision='block',
                reasons=['workflows_data_unknown'],
                message='Jangar workflow reliability is unavailable.',
            )
        if backoff_jobs > 0 or confidence == 'degraded':
            return JangarDependencyQuorumStatus(
                decision='delay',
                reasons=['workflows_degraded'],
                message='Jangar workflow reliability is degraded.',
            )
    namespaces = payload.get('namespaces')
    if isinstance(namespaces, Sequence) and not isinstance(
        namespaces, (str, bytes, bytearray)
    ):
        for raw_item in cast(Sequence[object], namespaces):
            if not isinstance(raw_item, Mapping):
                continue
            item = cast(Mapping[str, Any], raw_item)
            if str(item.get('status') or '').strip() == 'degraded':
                return JangarDependencyQuorumStatus(
                    decision='delay',
                    reasons=['jangar_namespace_degraded'],
                    message='Jangar namespace health is degraded.',
                )
    return JangarDependencyQuorumStatus(
        decision='unknown',
        reasons=['jangar_dependency_quorum_missing'],
        message='Jangar control-plane status did not include dependency_quorum.',
    )


def load_jangar_dependency_quorum() -> JangarDependencyQuorumStatus:
    status_url = (settings.trading_jangar_control_plane_status_url or '').strip()
    if not status_url:
        return JangarDependencyQuorumStatus(
            decision='unknown',
            reasons=['jangar_control_plane_status_url_missing'],
            message='TRADING_JANGAR_CONTROL_PLANE_STATUS_URL is not configured.',
        )

    ttl_seconds = max(0, int(settings.trading_jangar_control_plane_cache_ttl_seconds))
    if ttl_seconds > 0:
        now = datetime.now(timezone.utc)
        with _JANGAR_QUORUM_CACHE_LOCK:
            cached = cast(dict[str, Any] | None, _JANGAR_QUORUM_CACHE.get(status_url))
            if cached is not None:
                checked_at = cast(datetime | None, cached.get('checked_at'))
                if (
                    checked_at is not None
                    and now - checked_at <= timedelta(seconds=ttl_seconds)
                ):
                    return cast(JangarDependencyQuorumStatus, cached['status'])

    decoded: Any = None
    try:
        request = Request(status_url, method='GET', headers={'accept': 'application/json'})
        with urlopen(request, timeout=settings.trading_jangar_control_plane_timeout_seconds) as response:
            if response.status < 200 or response.status >= 300:
                return JangarDependencyQuorumStatus(
                    decision='unknown',
                    reasons=[f'jangar_status_http_{response.status}'],
                    message=f'Jangar control-plane status returned HTTP {response.status}.',
                )
            decoded = json.loads(response.read().decode('utf-8'))
    except Exception as exc:
        return JangarDependencyQuorumStatus(
            decision='unknown',
            reasons=['jangar_status_fetch_failed'],
            message=f'Jangar control-plane status fetch failed: {exc}',
        )

    if not isinstance(decoded, Mapping):
        return JangarDependencyQuorumStatus(
            decision='unknown',
            reasons=['jangar_status_payload_invalid'],
            message='Jangar control-plane status payload was invalid.',
        )
    payload = cast(Mapping[str, Any], decoded)
    raw_quorum = payload.get('dependency_quorum')
    if isinstance(raw_quorum, Mapping):
        quorum = cast(Mapping[str, Any], raw_quorum)
        decision = str(quorum.get('decision') or '').strip()
        if decision in {'allow', 'delay', 'block', 'unknown'}:
            reasons = [
                str(item).strip()
                for item in cast(Sequence[object], quorum.get('reasons') or [])
                if str(item).strip()
            ]
            status = JangarDependencyQuorumStatus(
                decision=cast(DependencyQuorumDecision, decision),
                reasons=reasons,
                message=str(quorum.get('message') or '').strip(),
            )
        else:
            status = _fallback_quorum_from_legacy_status(payload)
    else:
        status = _fallback_quorum_from_legacy_status(payload)

    if ttl_seconds > 0:
        with _JANGAR_QUORUM_CACHE_LOCK:
            _JANGAR_QUORUM_CACHE[status_url] = {
                'checked_at': datetime.now(timezone.utc),
                'status': status,
            }
    return status


def compile_hypothesis_runtime_statuses(
    *,
    registry: HypothesisRegistryLoadResult,
    state: object,
    tca_summary: Mapping[str, Any],
    market_context_status: Mapping[str, Any],
    jangar_dependency_quorum: JangarDependencyQuorumStatus,
    now: datetime | None = None,
) -> list[dict[str, object]]:
    if not registry.loaded:
        return []

    now = now or datetime.now(timezone.utc)
    metrics = getattr(state, 'metrics', None)
    feature_batch_rows_total = max(
        0,
        _optional_int(getattr(metrics, 'feature_batch_rows_total', 0)) or 0,
    )
    drift_detection_checks_total = max(
        0,
        _optional_int(getattr(metrics, 'drift_detection_checks_total', 0)) or 0,
    )
    evidence_continuity_checks_total = max(
        0,
        _optional_int(getattr(metrics, 'evidence_continuity_checks_total', 0)) or 0,
    )
    signal_lag_seconds = _optional_int(getattr(metrics, 'signal_lag_seconds', None))
    no_signal_streak = max(0, _optional_int(getattr(state, 'autonomy_no_signal_streak', 0)) or 0)
    signal_continuity_alert_active = bool(
        getattr(state, 'signal_continuity_alert_active', False)
    )
    evidence_report = getattr(state, 'last_evidence_continuity_report', None)
    evidence_ok = True
    evidence_age_minutes: int | None = None
    if isinstance(evidence_report, Mapping):
        report_map = cast(Mapping[str, Any], evidence_report)
        if 'ok' in report_map:
            evidence_ok = bool(report_map.get('ok'))
        checked_at = _parse_iso8601(report_map.get('checked_at'))
        if checked_at is not None:
            evidence_age_minutes = max(
                0,
                int((now - checked_at).total_seconds() / 60),
            )
    market_context_freshness_seconds = _optional_int(
        market_context_status.get('last_freshness_seconds')
    )

    tca_order_count = max(0, _optional_int(tca_summary.get('order_count')) or 0)
    avg_abs_slippage_bps = _coerce_decimal(tca_summary.get('avg_abs_slippage_bps'))
    avg_realized_shortfall_bps = _coerce_decimal(
        tca_summary.get('avg_realized_shortfall_bps')
    )
    post_cost_expectancy_bps_proxy = -avg_realized_shortfall_bps

    statuses: list[dict[str, object]] = []
    for manifest in registry.items:
        required_dependency_capabilities, unknown_dependency_capabilities = _resolve_required_dependency_capabilities(
            manifest
        )
        reasons: list[str] = []
        requirements = manifest.entry_requirements

        if (
            _is_dependency_required(required_dependency_capabilities, 'feature_coverage')
            and requirements.require_feature_rows
            and feature_batch_rows_total < max(
                1,
                requirements.min_feature_batch_rows,
            )
        ):
            reasons.append('feature_rows_missing')
        if (
            _is_dependency_required(required_dependency_capabilities, 'drift_governance')
            and requirements.require_drift_checks
            and drift_detection_checks_total <= 0
        ):
            reasons.append('drift_checks_missing')
        if (
            _is_dependency_required(required_dependency_capabilities, 'evidence_continuity')
            and requirements.require_evidence_continuity
        ):
            if evidence_continuity_checks_total <= 0:
                reasons.append('evidence_continuity_missing')
            elif not evidence_ok:
                reasons.append('evidence_continuity_failed')
            if (
                requirements.max_evidence_age_minutes is not None
                and evidence_age_minutes is not None
                and evidence_age_minutes > requirements.max_evidence_age_minutes
            ):
                reasons.append('evidence_continuity_stale')
        if (
            requirements.max_signal_lag_seconds is not None
            and (signal_lag_seconds is None or signal_lag_seconds > requirements.max_signal_lag_seconds)
        ):
            reasons.append('signal_lag_exceeded')
        if (
            requirements.max_no_signal_streak is not None
            and no_signal_streak > requirements.max_no_signal_streak
        ):
            reasons.append('no_signal_streak_exceeded')
        if (
            _is_dependency_required(required_dependency_capabilities, 'signal_continuity')
            and signal_continuity_alert_active
        ):
            reasons.append('signal_continuity_alert_active')
        if (
            _is_dependency_required(required_dependency_capabilities, 'market_context_freshness')
            and requirements.max_market_context_freshness_seconds is not None
            and (
                market_context_freshness_seconds is None
                or market_context_freshness_seconds > requirements.max_market_context_freshness_seconds
            )
        ):
            reasons.append('market_context_stale')
        if (
            _is_dependency_required(required_dependency_capabilities, 'jangar_dependency_quorum')
            and requirements.required_dependency_quorum == 'allow'
        ):
            if jangar_dependency_quorum.decision == 'delay':
                reasons.append('jangar_dependency_delay')
            elif jangar_dependency_quorum.decision in {'block', 'unknown'}:
                reasons.append('jangar_dependency_block')
        elif (
            _is_dependency_required(required_dependency_capabilities, 'jangar_dependency_quorum')
            and jangar_dependency_quorum.decision == 'block'
        ):
            reasons.append('jangar_dependency_block')

        if unknown_dependency_capabilities:
            reasons.extend(
                f'dependency_capability_unknown:{capability}'
                for capability in sorted(unknown_dependency_capabilities)
            )

        if (
            manifest.initial_state == 'blocked'
            and manifest.required_feature_sets
            and feature_batch_rows_total <= 0
        ):
            reasons.append('required_feature_set_unavailable')

        readiness_blockers = set(reasons)

        capital_stage: CapitalStage = 'shadow'
        capital_multiplier = Decimal('0')
        promotion_eligible = False
        rollback_required = bool(
            {'jangar_dependency_delay', 'jangar_dependency_block', 'signal_continuity_alert_active'}
            & readiness_blockers
        )

        if not readiness_blockers:
            if tca_order_count < manifest.min_sample_count_for_live_canary:
                reasons.append('sample_count_below_canary_minimum')
            elif avg_abs_slippage_bps > manifest.max_allowed_slippage_bps:
                reasons.append('slippage_budget_exceeded')
                rollback_required = True
            elif post_cost_expectancy_bps_proxy <= Decimal('0'):
                reasons.append('post_cost_expectancy_non_positive')
                rollback_required = True
            elif post_cost_expectancy_bps_proxy < manifest.expected_gross_edge_bps:
                reasons.append('post_cost_expectancy_below_manifest_threshold')
            else:
                promotion_eligible = True
                if tca_order_count >= manifest.min_sample_count_for_scale_up:
                    if avg_abs_slippage_bps <= manifest.max_allowed_slippage_bps * Decimal('0.60'):
                        capital_stage = '1.00x live'
                        capital_multiplier = Decimal('1.00')
                    else:
                        capital_stage = '0.50x live'
                        capital_multiplier = Decimal('0.50')
                else:
                    if avg_abs_slippage_bps <= manifest.max_allowed_slippage_bps * Decimal('0.75'):
                        capital_stage = '0.25x canary'
                        capital_multiplier = Decimal('0.25')
                    else:
                        capital_stage = '0.10x canary'
                        capital_multiplier = Decimal('0.10')

        if manifest.initial_state == 'blocked' and (
            'required_feature_set_unavailable' in reasons or 'feature_rows_missing' in reasons
        ):
            state_name: HypothesisState = 'blocked'
            capital_stage = 'shadow'
            capital_multiplier = Decimal('0')
        elif capital_multiplier >= Decimal('0.50'):
            state_name = 'scaled_live'
        elif capital_multiplier > 0:
            state_name = 'canary_live'
        else:
            state_name = 'shadow'

        statuses.append(
            {
                'hypothesis_id': manifest.hypothesis_id,
                'lane_id': manifest.lane_id,
                'strategy_family': manifest.strategy_family,
                'initial_state': manifest.initial_state,
                'state': state_name,
                'capital_stage': capital_stage,
                'capital_multiplier': _decimal_to_string(capital_multiplier),
                'promotion_eligible': promotion_eligible,
                'rollback_required': rollback_required,
                'reasons': sorted(set(reasons)),
                'required_feature_sets': list(manifest.required_feature_sets),
                'required_dependency_capabilities': list(
                    manifest.required_dependency_capabilities
                ),
                'segment_dependencies': list(manifest.segment_dependencies),
                'observed': {
                    'signal_lag_seconds': signal_lag_seconds,
                    'no_signal_streak': no_signal_streak,
                    'feature_batch_rows_total': feature_batch_rows_total,
                    'drift_detection_checks_total': drift_detection_checks_total,
                    'evidence_continuity_checks_total': evidence_continuity_checks_total,
                    'evidence_continuity_ok': evidence_ok,
                    'evidence_age_minutes': evidence_age_minutes,
                    'market_context_freshness_seconds': market_context_freshness_seconds,
                    'tca_order_count': tca_order_count,
                    'avg_abs_slippage_bps': _decimal_to_string(avg_abs_slippage_bps),
                    'post_cost_expectancy_bps_proxy': _decimal_to_string(
                        post_cost_expectancy_bps_proxy
                    ),
                },
                'dependency_capabilities': {
                    'required': sorted(required_dependency_capabilities),
                    'unknown': sorted(unknown_dependency_capabilities),
                },
                'entry_contract': {
                    'max_signal_lag_seconds': requirements.max_signal_lag_seconds,
                    'max_no_signal_streak': requirements.max_no_signal_streak,
                    'max_market_context_freshness_seconds': requirements.max_market_context_freshness_seconds,
                    'max_evidence_age_minutes': requirements.max_evidence_age_minutes,
                    'min_feature_batch_rows': requirements.min_feature_batch_rows,
                },
                'promotion_contract': {
                    'min_sample_count_for_live_canary': manifest.min_sample_count_for_live_canary,
                    'min_sample_count_for_scale_up': manifest.min_sample_count_for_scale_up,
                    'min_post_cost_expectancy_bps': _decimal_to_string(
                        manifest.expected_gross_edge_bps
                    ),
                    'max_avg_abs_slippage_bps': _decimal_to_string(
                        manifest.max_allowed_slippage_bps
                    ),
                },
                'dependency_quorum': jangar_dependency_quorum.as_payload(),
            }
        )
    return statuses


def summarize_hypothesis_runtime_statuses(
    statuses: Sequence[Mapping[str, Any]],
    *,
    registry: HypothesisRegistryLoadResult,
    dependency_quorum: JangarDependencyQuorumStatus,
) -> dict[str, object]:
    state_totals = Counter(str(item.get('state') or 'unknown') for item in statuses)
    capital_stage_totals = Counter(
        str(item.get('capital_stage') or 'shadow') for item in statuses
    )
    capital_multiplier_by_hypothesis = {
        str(item.get('hypothesis_id') or 'unknown'): str(
            item.get('capital_multiplier') or '0'
        )
        for item in statuses
    }
    promotion_eligible_total = sum(
        1 for item in statuses if bool(item.get('promotion_eligible'))
    )
    rollback_required_total = sum(
        1 for item in statuses if bool(item.get('rollback_required'))
    )
    return {
        'registry_loaded': registry.loaded,
        'registry_path': registry.path,
        'registry_errors': list(registry.errors),
        'hypotheses_total': len(statuses),
        'state_totals': dict(sorted(state_totals.items())),
        'capital_stage_totals': dict(sorted(capital_stage_totals.items())),
        'capital_multiplier_by_hypothesis': capital_multiplier_by_hypothesis,
        'promotion_eligible_total': promotion_eligible_total,
        'rollback_required_total': rollback_required_total,
        'dependency_quorum': dependency_quorum.as_payload(),
    }


__all__ = [
    'HypothesisManifest',
    'HypothesisRegistryLoadResult',
    'JangarDependencyQuorumStatus',
    'compile_hypothesis_runtime_statuses',
    'load_hypothesis_registry',
    'load_jangar_dependency_quorum',
    'resolve_hypothesis_registry_path',
    'summarize_hypothesis_runtime_statuses',
    'validate_hypothesis_registry_from_settings',
]
