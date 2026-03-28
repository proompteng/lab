"""Archive bundle and proof helpers for historical profitability validation."""

from __future__ import annotations

import hashlib
import json
import math
import random
import shutil
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from statistics import NormalDist
from typing import Any, Mapping, Sequence, cast

import psycopg
import yaml
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import VNextDatasetSnapshot
from .evidence_contracts import ArtifactProvenance

MARKET_DAY_INVENTORY_SCHEMA_VERSION = 'torghut.market-day-inventory.v1'
EXECUTION_DAY_INVENTORY_SCHEMA_VERSION = 'torghut.execution-day-inventory.v1'
REPLAY_DAY_MANIFEST_SCHEMA_VERSION = 'torghut.replay-day-manifest.v1'
DATA_SUFFICIENCY_SCHEMA_VERSION = 'torghut.data-sufficiency.v1'
TRIAL_LEDGER_SCHEMA_VERSION = 'torghut.trial-ledger.v1'
STATISTICAL_VALIDITY_SCHEMA_VERSION = 'torghut.statistical-validity.v1'
PROFITABILITY_CERTIFICATE_SCHEMA_VERSION = 'torghut.profitability-certificate.v1'

SUFFICIENCY_STATUS_INSUFFICIENT_HISTORY = 'insufficient_history'
SUFFICIENCY_STATUS_RESEARCH_ONLY = 'research_only'
SUFFICIENCY_STATUS_HISTORICAL_READY = 'historical_ready'
SUFFICIENCY_STATUS_PAPER_READY = 'paper_ready'

CERTIFICATE_STATUS_INSUFFICIENT_HISTORY = 'insufficient_history'
CERTIFICATE_STATUS_RESEARCH_ONLY = 'research_only'
CERTIFICATE_STATUS_HISTORICAL_PROVEN = 'historical_proven'
CERTIFICATE_STATUS_PAPER_PROVEN = 'paper_proven'
CERTIFICATE_STATUS_LIVE_CAPPED = 'live_capped'
CERTIFICATE_STATUS_LIVE_FULL = 'live_full'

ARCHIVE_STATUS_ARCHIVED = 'archived'
ARCHIVE_STATUS_PARTIAL = 'partial'
ARCHIVE_STATUS_INSUFFICIENT = 'insufficient_history'

_UTC = timezone.utc
_NORMAL_DIST = NormalDist()
_REALITY_CHECK_BOOTSTRAP_REPLICATES = 500
_REALITY_CHECK_MIN_SAMPLE_DAYS = 20
_DSR_MIN_SAMPLE_DAYS = 5
_COPYABLE_ARTIFACTS: tuple[str, ...] = (
    'run-manifest.json',
    'replay-report.json',
    'runtime-verify.json',
    'signal-activity.json',
    'decision-activity.json',
    'execution-activity.json',
    'activity-debug.json',
    'strategy-proof.json',
    'performance.json',
    'run-summary.json',
    'completion-trace.json',
    'report/simulation-report.json',
    'report/simulation-report.md',
    'report/trade-pnl.csv',
    'report/execution-latency.csv',
    'report/llm-review-summary.csv',
)


@dataclass(frozen=True)
class ArchiveWalkForwardFold:
    name: str
    train_days: list[str]
    validation_days: list[str]
    test_days: list[str]
    embargo_days: list[str]

    def to_payload(self) -> dict[str, object]:
        return {
            'name': self.name,
            'train_days': list(self.train_days),
            'validation_days': list(self.validation_days),
            'test_days': list(self.test_days),
            'embargo_days': list(self.embargo_days),
        }


@dataclass(frozen=True)
class ArchivedTradingDayBundle:
    trading_day: str
    candidate_id: str
    run_id: str
    archived_run_dir: Path
    original_run_dir: Path
    market_day_inventory: dict[str, Any]
    execution_day_inventory: dict[str, Any]
    replay_day_manifest: dict[str, Any]

    @property
    def net_pnl_estimated(self) -> Decimal:
        return _as_decimal(self.execution_day_inventory.get('net_pnl_estimated'))

    @property
    def estimated_cost_total(self) -> Decimal:
        return _as_decimal(self.execution_day_inventory.get('estimated_cost_total'))

    @property
    def replayable_market_day(self) -> bool:
        return bool(self.market_day_inventory.get('replayable_market_day', False))

    @property
    def execution_day_eligible(self) -> bool:
        return bool(self.execution_day_inventory.get('execution_day_eligible', False))


def _as_dict(value: object) -> dict[str, Any]:
    return dict(cast(Mapping[str, Any], value)) if isinstance(value, Mapping) else {}


def _as_list(value: object) -> list[Any]:
    return list(cast(Sequence[Any], value)) if isinstance(value, list) else []


def _as_text(value: object) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _as_int(value: object) -> int:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str):
        text = value.strip()
        if text:
            try:
                return int(text)
            except ValueError:
                return 0
    return 0


def _as_float(value: object) -> float | None:
    if value is None:
        return None
    if isinstance(value, bool):
        return float(value)
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        text = value.strip()
        if text:
            try:
                return float(text)
            except ValueError:
                return None
    return None


def _as_decimal(value: object) -> Decimal:
    try:
        return Decimal(str(value))
    except Exception:
        return Decimal('0')


def _json_default(value: object) -> str:
    if isinstance(value, datetime):
        if value.tzinfo is None:
            return value.replace(tzinfo=_UTC).isoformat()
        return value.astimezone(_UTC).isoformat()
    if isinstance(value, Decimal):
        return format(value, 'f')
    if isinstance(value, Path):
        return str(value)
    return str(value)


def _stable_hash(payload: object) -> str:
    encoded = json.dumps(
        payload,
        sort_keys=True,
        separators=(',', ':'),
        default=_json_default,
    ).encode('utf-8')
    return hashlib.sha256(encoded).hexdigest()


def _write_json(path: Path, payload: Mapping[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, indent=2, sort_keys=True, default=_json_default),
        encoding='utf-8',
    )


def _load_json(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(payload, Mapping):
        raise RuntimeError(f'json_mapping_required:{path}')
    return {str(key): value for key, value in cast(Mapping[str, Any], payload).items()}


def _load_manifest(path: Path) -> dict[str, Any]:
    raw = path.read_text(encoding='utf-8')
    if path.suffix.lower() in {'.yaml', '.yml'}:
        payload = yaml.safe_load(raw)
    else:
        payload = json.loads(raw)
    if not isinstance(payload, Mapping):
        raise RuntimeError(f'manifest_mapping_required:{path}')
    return {str(key): value for key, value in cast(Mapping[str, Any], payload).items()}


def _simulation_report_path(run_dir: Path) -> Path:
    return run_dir / 'report' / 'simulation-report.json'


def _manifest_trading_day(manifest: Mapping[str, Any], simulation_report: Mapping[str, Any]) -> str:
    window = _as_dict(manifest.get('window'))
    trading_day = _as_text(window.get('trading_day'))
    if trading_day:
        return trading_day
    coverage = _as_dict(simulation_report.get('coverage'))
    window_start = _as_text(coverage.get('window_start'))
    if window_start is None:
        raise RuntimeError('trading_day_missing')
    return window_start.split('T', 1)[0]


def _candidate_id(manifest: Mapping[str, Any], run_manifest: Mapping[str, Any]) -> str:
    lineage = _as_dict(run_manifest.get('evidence_lineage'))
    candidate_id = _as_text(lineage.get('candidate_id')) or _as_text(manifest.get('candidate_id'))
    if candidate_id is None:
        raise RuntimeError('candidate_id_missing')
    return candidate_id


def _source_topics_for_manifest(manifest: Mapping[str, Any]) -> list[str]:
    from scripts.simulation_lane_contracts import simulation_lane_contract_for_manifest

    contract = simulation_lane_contract_for_manifest(manifest)
    return [contract.source_topic_by_role[role] for role in contract.replay_roles]


def _source_roles_for_manifest(manifest: Mapping[str, Any]) -> list[str]:
    from scripts.simulation_lane_contracts import simulation_lane_contract_for_manifest

    contract = simulation_lane_contract_for_manifest(manifest)
    return list(contract.replay_roles)


def _artifacts_for_copy(run_dir: Path) -> list[Path]:
    paths: dict[Path, Path] = {}
    for relative in _COPYABLE_ARTIFACTS:
        candidate = run_dir / relative
        if candidate.exists() and candidate.is_file():
            paths[candidate] = candidate
    for candidate in sorted(run_dir.glob('source-dump*')):
        if candidate.is_file():
            paths[candidate] = candidate
    return list(paths.values())


def copy_archive_artifacts(
    *,
    run_dir: Path,
    archive_run_dir: Path,
    manifest_path: Path,
) -> dict[str, dict[str, str]]:
    copied: dict[str, dict[str, str]] = {}
    archive_run_dir.mkdir(parents=True, exist_ok=True)

    copied_manifest_path = archive_run_dir / f'source-manifest{manifest_path.suffix or ".json"}'
    shutil.copy2(manifest_path, copied_manifest_path)
    copied['source_manifest'] = {
        'path': str(copied_manifest_path),
        'sha256': hashlib.sha256(copied_manifest_path.read_bytes()).hexdigest(),
    }

    for source_path in _artifacts_for_copy(run_dir):
        relative_path = source_path.relative_to(run_dir)
        destination = archive_run_dir / relative_path
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source_path, destination)
        copied[str(relative_path)] = {
            'path': str(destination),
            'sha256': hashlib.sha256(destination.read_bytes()).hexdigest(),
        }

    simulation_report_key = 'report/simulation-report.json'
    simulation_report_entry = copied.get(simulation_report_key)
    if simulation_report_entry is not None:
        simulation_report_path = Path(simulation_report_entry['path'])
        simulation_report = _load_json(simulation_report_path)
        run_metadata = _as_dict(simulation_report.get('run_metadata'))
        run_metadata['manifest_path'] = str(copied_manifest_path)
        simulation_report['run_metadata'] = run_metadata
        _write_json(simulation_report_path, simulation_report)
        copied[simulation_report_key]['sha256'] = hashlib.sha256(
            simulation_report_path.read_bytes()
        ).hexdigest()

    return copied


def collect_simulation_postgres_counts(simulation_dsn: str) -> dict[str, int]:
    dsn = simulation_dsn.strip()
    if not dsn:
        return {}

    query = """
        SELECT
          CASE WHEN to_regclass('public.trade_decisions') IS NULL THEN 0 ELSE (SELECT count(*) FROM trade_decisions) END AS trade_decisions,
          CASE WHEN to_regclass('public.executions') IS NULL THEN 0 ELSE (SELECT count(*) FROM executions) END AS executions,
          CASE WHEN to_regclass('public.position_snapshots') IS NULL THEN 0 ELSE (SELECT count(*) FROM position_snapshots) END AS position_snapshots,
          CASE WHEN to_regclass('public.execution_order_events') IS NULL THEN 0 ELSE (SELECT count(*) FROM execution_order_events) END AS execution_order_events,
          CASE WHEN to_regclass('public.execution_tca_metrics') IS NULL THEN 0 ELSE (SELECT count(*) FROM execution_tca_metrics) END AS execution_tca_metrics
    """
    with psycopg.connect(dsn) as conn:
        with conn.cursor() as cursor:
            cursor.execute(query)
            row = cursor.fetchone()
    if row is None:
        return {}
    return {
        'trade_decisions': _as_int(row[0]),
        'executions': _as_int(row[1]),
        'position_snapshots': _as_int(row[2]),
        'execution_order_events': _as_int(row[3]),
        'execution_tca_metrics': _as_int(row[4]),
    }


def build_market_day_inventory(
    *,
    manifest: Mapping[str, Any],
    run_manifest: Mapping[str, Any],
    replay_report: Mapping[str, Any],
    simulation_report: Mapping[str, Any],
    artifact_refs: Mapping[str, Mapping[str, str]],
    topic_retention_ms_by_topic: Mapping[str, int] | None = None,
    observed_at: datetime | None = None,
) -> dict[str, Any]:
    trading_day = _manifest_trading_day(manifest, simulation_report)
    source_topics = _source_topics_for_manifest(manifest)
    source_roles = _source_roles_for_manifest(manifest)
    records_by_topic = _as_dict(_as_dict(run_manifest.get('dump')).get('records_by_topic'))
    coverage = _as_dict(simulation_report.get('coverage'))
    dump_coverage = _as_dict(run_manifest.get('dump_coverage'))
    coverage_ratio = (
        _as_float(dump_coverage.get('coverage_ratio'))
        or _as_float(coverage.get('window_coverage_ratio_from_dump'))
        or 0.0
    )
    required_topics: list[str] = []
    for role in source_roles:
        if role == 'status':
            continue
        from scripts.simulation_lane_contracts import simulation_lane_contract_for_manifest

        contract = simulation_lane_contract_for_manifest(manifest)
        required_topics.append(contract.source_topic_by_role[role])
    missing_topics = [
        topic
        for topic in required_topics
        if _as_int(records_by_topic.get(topic)) <= 0
    ]
    symbols = sorted(
        {
            str(item)
            for item in _as_list(_as_dict(simulation_report.get('stability')).get('clickhouse', {}).get('symbols'))
            if str(item).strip()
        }
    )
    if not symbols:
        stability_clickhouse = _as_dict(_as_dict(simulation_report.get('stability')).get('clickhouse'))
        raw_symbols = stability_clickhouse.get('symbols')
        if isinstance(raw_symbols, list):
            normalized_symbols = [str(item) for item in cast(list[object], raw_symbols) if str(item).strip()]
            symbols = sorted(set(normalized_symbols))
    market_day_inventory: dict[str, Any] = {
        'schema_version': MARKET_DAY_INVENTORY_SCHEMA_VERSION,
        'trading_day': trading_day,
        'window': dict(_as_dict(manifest.get('window'))),
        'lane': _as_text(manifest.get('lane')) or 'equity',
        'source_topics': source_topics,
        'source_topic_retention_ms_by_topic': {
            topic: int(value)
            for topic, value in (topic_retention_ms_by_topic or {}).items()
            if str(topic).strip()
        },
        'source_offsets': {},
        'source_records_by_topic': {
            str(topic): _as_int(value) for topic, value in records_by_topic.items()
        },
        'symbols': symbols,
        'clickhouse_coverage': {
            'window_coverage_ratio_from_dump': coverage.get('window_coverage_ratio_from_dump'),
            'decision_signal_min_ts': coverage.get('decision_signal_min_ts'),
            'decision_signal_max_ts': coverage.get('decision_signal_max_ts'),
            'dump_signal_min_ts': coverage.get('dump_signal_min_ts'),
            'dump_signal_max_ts': coverage.get('dump_signal_max_ts'),
        },
        'clickhouse_day_exports': {
            key: value['path']
            for key, value in artifact_refs.items()
            if key.startswith('report/')
        },
        'replayable_market_day': (
            _as_int(_as_dict(run_manifest.get('dump')).get('records')) > 0
            and coverage_ratio >= (_as_float(_as_dict(run_manifest.get('window_policy')).get('strict_coverage_ratio')) or 0.95)
            and not missing_topics
        ),
        'missing_topics': missing_topics,
        'missing_partitions': [],
        'missing_symbols': [],
        'reconstruction_source_provenance': ArtifactProvenance.HISTORICAL_MARKET_REPLAY.value,
        'observed_at': (observed_at or datetime.now(_UTC)).astimezone(_UTC).isoformat(),
    }
    return market_day_inventory


def build_execution_day_inventory(
    *,
    manifest: Mapping[str, Any],
    simulation_report: Mapping[str, Any],
    artifact_refs: Mapping[str, Mapping[str, str]],
    postgres_counts: Mapping[str, int] | None = None,
    empirical_artifact_refs: Sequence[str] | None = None,
    observed_at: datetime | None = None,
) -> dict[str, Any]:
    funnel = _as_dict(simulation_report.get('funnel'))
    execution_quality = _as_dict(simulation_report.get('execution_quality'))
    slippage = _as_dict(execution_quality.get('slippage_bps'))
    pnl = _as_dict(simulation_report.get('pnl'))
    counts = dict(postgres_counts or {})
    trade_decisions = counts.get('trade_decisions', _as_int(funnel.get('trade_decisions')))
    executions = counts.get('executions', _as_int(funnel.get('executions')))
    position_snapshots = counts.get('position_snapshots', 0)
    execution_order_events = counts.get(
        'execution_order_events',
        _as_int(funnel.get('execution_order_events_total') or funnel.get('execution_order_events')),
    )
    execution_tca_metrics = counts.get(
        'execution_tca_metrics',
        _as_int(funnel.get('execution_tca_metrics')),
    )
    missing_surfaces: list[str] = []
    if trade_decisions <= 0:
        missing_surfaces.append('trade_decisions')
    if executions <= 0:
        missing_surfaces.append('executions')
    if position_snapshots <= 0:
        missing_surfaces.append('position_snapshots')
    if execution_order_events <= 0:
        missing_surfaces.append('execution_order_events')
    if execution_tca_metrics <= 0:
        missing_surfaces.append('execution_tca_metrics')
    if not counts:
        missing_surfaces.append('simulation_postgres_snapshot_missing')

    return {
        'schema_version': EXECUTION_DAY_INVENTORY_SCHEMA_VERSION,
        'trading_day': _manifest_trading_day(manifest, simulation_report),
        'candidate_scope': {
            'candidate_id': _as_text(manifest.get('candidate_id')),
            'baseline_candidate_id': _as_text(manifest.get('baseline_candidate_id')),
            'strategy_spec_ref': _as_text(manifest.get('strategy_spec_ref')),
            'model_refs': [
                str(item)
                for item in _as_list(manifest.get('model_refs'))
                if str(item).strip()
            ],
        },
        'trade_decisions_present': trade_decisions > 0,
        'executions_present': executions > 0,
        'execution_order_events_present': execution_order_events > 0,
        'position_snapshots_present': position_snapshots > 0,
        'execution_tca_metrics_present': execution_tca_metrics > 0,
        'postgres_day_exports': {
            'counts': {
                'trade_decisions': trade_decisions,
                'executions': executions,
                'position_snapshots': position_snapshots,
                'execution_order_events': execution_order_events,
                'execution_tca_metrics': execution_tca_metrics,
            },
            'report_paths': {
                key: value['path']
                for key, value in artifact_refs.items()
                if key in {'run-summary.json', 'report/simulation-report.json', 'report/trade-pnl.csv'}
            },
        },
        'empirical_artifact_refs': [str(item) for item in (empirical_artifact_refs or []) if str(item).strip()],
        'rejections_by_reason': {},
        'broker_failures_by_reason': {
            str(key): _as_int(value)
            for key, value in _as_dict(execution_quality.get('fallback_reason_counts')).items()
        },
        'decision_status_counts': {
            str(key): _as_int(value)
            for key, value in _as_dict(funnel.get('decision_status_counts')).items()
        },
        'net_pnl_estimated': format(_as_decimal(pnl.get('net_pnl_estimated')), 'f'),
        'estimated_cost_total': format(_as_decimal(pnl.get('estimated_cost_total')), 'f'),
        'execution_notional_total': format(_as_decimal(pnl.get('execution_notional_total')), 'f'),
        'avg_abs_slippage_bps': slippage.get('avg_abs'),
        'p95_abs_slippage_bps': slippage.get('p95_abs'),
        'execution_day_eligible': not missing_surfaces,
        'missing_execution_surfaces': missing_surfaces,
        'observed_at': (observed_at or datetime.now(_UTC)).astimezone(_UTC).isoformat(),
    }


def build_replay_day_manifest(
    *,
    manifest: Mapping[str, Any],
    run_manifest: Mapping[str, Any],
    replay_report: Mapping[str, Any],
    archive_dir: Path,
    original_run_dir: Path,
    artifact_refs: Mapping[str, Mapping[str, str]],
    market_day_inventory: Mapping[str, Any],
    execution_day_inventory: Mapping[str, Any],
    observed_at: datetime | None = None,
) -> dict[str, Any]:
    evidence_lineage = _as_dict(run_manifest.get('evidence_lineage'))
    bundle_inputs = {
        'artifact_refs': artifact_refs,
        'market_day_inventory': market_day_inventory,
        'execution_day_inventory': execution_day_inventory,
        'run_manifest_dump_sha256': _as_text(_as_dict(run_manifest.get('dump')).get('sha256')),
        'replay_report_dump_sha256': _as_text(replay_report.get('dump_sha256')),
    }
    archive_status = ARCHIVE_STATUS_ARCHIVED
    if not bool(market_day_inventory.get('replayable_market_day', False)):
        archive_status = ARCHIVE_STATUS_PARTIAL
    if not bool(execution_day_inventory.get('execution_day_eligible', False)):
        archive_status = ARCHIVE_STATUS_PARTIAL if archive_status == ARCHIVE_STATUS_ARCHIVED else archive_status

    return {
        'schema_version': REPLAY_DAY_MANIFEST_SCHEMA_VERSION,
        'run_id': _as_text(run_manifest.get('run_id')) or original_run_dir.name,
        'dataset_id': _as_text(manifest.get('dataset_id')) or _as_text(run_manifest.get('dataset_id')) or original_run_dir.name,
        'dataset_snapshot_ref': _as_text(manifest.get('dataset_snapshot_ref')),
        'candidate_id': _as_text(evidence_lineage.get('candidate_id')) or _as_text(manifest.get('candidate_id')),
        'baseline_candidate_id': _as_text(evidence_lineage.get('baseline_candidate_id')) or _as_text(manifest.get('baseline_candidate_id')),
        'trading_day': _manifest_trading_day(manifest, market_day_inventory),
        'window': dict(_as_dict(manifest.get('window'))),
        'source_dump_ref': (
            _as_text(_as_dict(artifact_refs.get('source-dump.jsonl.zst.manifest.json')).get('path'))
            or _as_text(_as_dict(artifact_refs.get('source-dump.jsonl.gz.manifest.json')).get('path'))
            or _as_text(_as_dict(artifact_refs.get('source-dump.ndjson.manifest.json')).get('path'))
        ),
        'source_dump_sha256': (
            _as_text(replay_report.get('dump_sha256'))
            or _as_text(_as_dict(run_manifest.get('dump')).get('sha256'))
        ),
        'run_manifest_ref': _as_text(_as_dict(artifact_refs.get('run-manifest.json')).get('path')),
        'analysis_report_ref': _as_text(_as_dict(artifact_refs.get('report/simulation-report.json')).get('path')),
        'simulation_database': _as_text(_as_dict(manifest.get('clickhouse')).get('simulation_database')),
        'runtime_version_refs': [
            str(item) for item in _as_list(evidence_lineage.get('runtime_version_refs')) if str(item).strip()
        ],
        'model_refs': [
            str(item) for item in _as_list(evidence_lineage.get('model_refs')) if str(item).strip()
        ],
        'strategy_spec_ref': _as_text(evidence_lineage.get('strategy_spec_ref')) or _as_text(manifest.get('strategy_spec_ref')),
        'artifact_bundle_sha256': _stable_hash(bundle_inputs),
        'archive_status': archive_status,
        'original_run_dir': str(original_run_dir),
        'archived_run_dir': str(archive_dir),
        'artifact_refs': {
            key: value['path']
            for key, value in artifact_refs.items()
        },
        'observed_at': (observed_at or datetime.now(_UTC)).astimezone(_UTC).isoformat(),
    }


def upsert_dataset_snapshot(
    session: Session,
    *,
    run_id: str,
    candidate_id: str | None,
    dataset_id: str,
    dataset_from: datetime | None,
    dataset_to: datetime | None,
    artifact_ref: str,
    payload_json: Mapping[str, Any],
) -> VNextDatasetSnapshot:
    existing = session.execute(
        select(VNextDatasetSnapshot).where(
            VNextDatasetSnapshot.run_id == run_id,
            VNextDatasetSnapshot.dataset_id == dataset_id,
        )
    ).scalar_one_or_none()
    snapshot = existing or VNextDatasetSnapshot(
        run_id=run_id,
        candidate_id=candidate_id,
        dataset_id=dataset_id,
        source=ArtifactProvenance.HISTORICAL_MARKET_REPLAY.value,
    )
    snapshot.candidate_id = candidate_id
    snapshot.dataset_version = run_id
    snapshot.dataset_from = dataset_from
    snapshot.dataset_to = dataset_to
    snapshot.artifact_ref = artifact_ref
    snapshot.payload_json = dict(payload_json)
    if existing is None:
        session.add(snapshot)
    session.flush()
    return snapshot


def _resolve_manifest_path(run_dir: Path, manifest_path: Path) -> Path:
    if manifest_path.is_absolute() and manifest_path.exists():
        return manifest_path
    for candidate in (run_dir / manifest_path, Path.cwd() / manifest_path):
        if candidate.exists():
            return candidate
    return manifest_path


def archive_historical_simulation_run(
    *,
    run_dir: Path,
    archive_root: Path,
    manifest_path: Path | None = None,
    topic_retention_ms_by_topic: Mapping[str, int] | None = None,
    postgres_counts: Mapping[str, int] | None = None,
    session: Session | None = None,
    observed_at: datetime | None = None,
) -> dict[str, Any]:
    simulation_report_path = _simulation_report_path(run_dir)
    if not simulation_report_path.exists():
        raise RuntimeError(f'simulation_report_missing:{run_dir}')
    run_manifest_path = run_dir / 'run-manifest.json'
    replay_report_path = run_dir / 'replay-report.json'
    if not run_manifest_path.exists():
        raise RuntimeError(f'run_manifest_missing:{run_dir}')
    if not replay_report_path.exists():
        raise RuntimeError(f'replay_report_missing:{run_dir}')

    simulation_report = _load_json(simulation_report_path)
    run_manifest = _load_json(run_manifest_path)
    replay_report = _load_json(replay_report_path)
    resolved_manifest_path = manifest_path
    if resolved_manifest_path is None:
        run_metadata = _as_dict(simulation_report.get('run_metadata'))
        manifest_text = _as_text(run_metadata.get('manifest_path'))
        if manifest_text is None:
            raise RuntimeError(f'manifest_path_missing:{run_dir}')
        resolved_manifest_path = Path(manifest_text)
    resolved_manifest_path = _resolve_manifest_path(run_dir, resolved_manifest_path)
    manifest = _load_manifest(resolved_manifest_path)
    trading_day = _manifest_trading_day(manifest, simulation_report)
    candidate_id = _candidate_id(manifest, run_manifest)
    run_id = _as_text(run_manifest.get('run_id')) or run_dir.name
    archive_dir = archive_root / trading_day / candidate_id / run_id
    artifact_refs = copy_archive_artifacts(
        run_dir=run_dir,
        archive_run_dir=archive_dir,
        manifest_path=resolved_manifest_path,
    )
    actual_postgres_counts = dict(postgres_counts or {})
    if not actual_postgres_counts:
        simulation_dsn = _as_text(_as_dict(manifest.get('postgres')).get('simulation_dsn')) or ''
        if simulation_dsn:
            try:
                actual_postgres_counts = collect_simulation_postgres_counts(simulation_dsn)
            except Exception:
                actual_postgres_counts = {}
    market_day_inventory = build_market_day_inventory(
        manifest=manifest,
        run_manifest=run_manifest,
        replay_report=replay_report,
        simulation_report=simulation_report,
        artifact_refs=artifact_refs,
        topic_retention_ms_by_topic=topic_retention_ms_by_topic,
        observed_at=observed_at,
    )
    execution_day_inventory = build_execution_day_inventory(
        manifest=manifest,
        simulation_report=simulation_report,
        artifact_refs=artifact_refs,
        postgres_counts=actual_postgres_counts,
        observed_at=observed_at,
    )
    replay_day_manifest = build_replay_day_manifest(
        manifest=manifest,
        run_manifest=run_manifest,
        replay_report=replay_report,
        archive_dir=archive_dir,
        original_run_dir=run_dir,
        artifact_refs=artifact_refs,
        market_day_inventory=market_day_inventory,
        execution_day_inventory=execution_day_inventory,
        observed_at=observed_at,
    )

    market_day_inventory_path = archive_dir / 'market_day_inventory.json'
    execution_day_inventory_path = archive_dir / 'execution_day_inventory.json'
    replay_day_manifest_path = archive_dir / 'replay_day_manifest.json'
    _write_json(market_day_inventory_path, market_day_inventory)
    _write_json(execution_day_inventory_path, execution_day_inventory)
    _write_json(replay_day_manifest_path, replay_day_manifest)

    if session is not None:
        window = _as_dict(manifest.get('window'))
        dataset_from = _parse_optional_timestamp(_as_text(window.get('start')))
        dataset_to = _parse_optional_timestamp(_as_text(window.get('end')))
        upsert_dataset_snapshot(
            session,
            run_id=run_id,
            candidate_id=candidate_id,
            dataset_id=_as_text(manifest.get('dataset_id')) or run_id,
            dataset_from=dataset_from,
            dataset_to=dataset_to,
            artifact_ref=str(archive_dir),
            payload_json={
                'market_day_inventory': market_day_inventory,
                'execution_day_inventory': execution_day_inventory,
                'replay_day_manifest': replay_day_manifest,
            },
        )

    return {
        'trading_day': trading_day,
        'candidate_id': candidate_id,
        'run_id': run_id,
        'archive_dir': str(archive_dir),
        'market_day_inventory_path': str(market_day_inventory_path),
        'execution_day_inventory_path': str(execution_day_inventory_path),
        'replay_day_manifest_path': str(replay_day_manifest_path),
        'archive_status': replay_day_manifest['archive_status'],
    }


def _parse_optional_timestamp(value: str | None) -> datetime | None:
    if value is None:
        return None
    cleaned = value.replace('Z', '+00:00')
    try:
        parsed = datetime.fromisoformat(cleaned)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=_UTC)
    return parsed.astimezone(_UTC)


def load_archived_trading_day_bundles(archive_root: Path) -> list[ArchivedTradingDayBundle]:
    bundles: list[ArchivedTradingDayBundle] = []
    for replay_manifest_path in sorted(archive_root.rglob('replay_day_manifest.json')):
        archive_dir = replay_manifest_path.parent
        replay_day_manifest = _load_json(replay_manifest_path)
        market_day_inventory = _load_json(archive_dir / 'market_day_inventory.json')
        execution_day_inventory = _load_json(archive_dir / 'execution_day_inventory.json')
        trading_day = _as_text(replay_day_manifest.get('trading_day'))
        candidate_id = _as_text(replay_day_manifest.get('candidate_id'))
        run_id = _as_text(replay_day_manifest.get('run_id'))
        original_run_dir = _as_text(replay_day_manifest.get('original_run_dir'))
        archived_run_dir = _as_text(replay_day_manifest.get('archived_run_dir')) or str(archive_dir)
        if trading_day is None or candidate_id is None or run_id is None or original_run_dir is None:
            raise RuntimeError(f'archived_bundle_invalid:{archive_dir}')
        bundles.append(
            ArchivedTradingDayBundle(
                trading_day=trading_day,
                candidate_id=candidate_id,
                run_id=run_id,
                archived_run_dir=Path(archived_run_dir),
                original_run_dir=Path(original_run_dir),
                market_day_inventory=market_day_inventory,
                execution_day_inventory=execution_day_inventory,
                replay_day_manifest=replay_day_manifest,
            )
        )
    return bundles


def summarize_data_sufficiency(
    bundles: Sequence[ArchivedTradingDayBundle],
    *,
    min_research_days: int = 20,
    min_historical_days: int = 60,
    min_execution_days: int = 20,
    generated_at: datetime | None = None,
) -> dict[str, Any]:
    replayable = sorted(
        {bundle.trading_day for bundle in bundles if bundle.replayable_market_day}
    )
    execution_days = sorted(
        {bundle.trading_day for bundle in bundles if bundle.execution_day_eligible}
    )
    symbols = sorted(
        {
            symbol
            for bundle in bundles
            for symbol in cast(list[str], bundle.market_day_inventory.get('symbols') or [])
            if str(symbol).strip()
        }
    )
    missing_days = _missing_business_days(replayable)
    retention_risk_days_remaining = _min_retention_days(bundles)
    blockers: list[str] = []
    status = SUFFICIENCY_STATUS_PAPER_READY
    if len(replayable) < min_research_days:
        status = SUFFICIENCY_STATUS_INSUFFICIENT_HISTORY
        blockers.append('replay_ready_market_days_below_research_minimum')
    elif len(replayable) < min_historical_days:
        status = SUFFICIENCY_STATUS_RESEARCH_ONLY
        blockers.append('replay_ready_market_days_below_historical_minimum')
    elif len(execution_days) < min_execution_days:
        status = SUFFICIENCY_STATUS_HISTORICAL_READY
        blockers.append('execution_days_below_paper_minimum')
    else:
        status = SUFFICIENCY_STATUS_PAPER_READY
    if missing_days:
        blockers.append('missing_business_days_in_archive_window')
    if not bundles:
        blockers.append('archive_bundle_set_empty')
        status = SUFFICIENCY_STATUS_INSUFFICIENT_HISTORY
    return {
        'schema_version': DATA_SUFFICIENCY_SCHEMA_VERSION,
        'generated_at': (generated_at or datetime.now(_UTC)).astimezone(_UTC).isoformat(),
        'market_days_available': len({bundle.trading_day for bundle in bundles}),
        'execution_days_available': len(execution_days),
        'replay_ready_market_days': len(replayable),
        'proof_eligible_days': len(
            {
                bundle.trading_day
                for bundle in bundles
                if bundle.replayable_market_day and bundle.execution_day_eligible
            }
        ),
        'symbol_coverage': {
            'count': len(symbols),
            'symbols': symbols,
        },
        'missing_days': missing_days,
        'source_provenance': sorted(
            {
                str(bundle.market_day_inventory.get('reconstruction_source_provenance'))
                for bundle in bundles
                if str(bundle.market_day_inventory.get('reconstruction_source_provenance') or '').strip()
            }
        ),
        'retention_risk_days_remaining': retention_risk_days_remaining,
        'status': status,
        'blockers': blockers,
    }


def build_trial_ledger(
    bundles: Sequence[ArchivedTradingDayBundle],
    *,
    generated_at: datetime | None = None,
) -> dict[str, Any]:
    candidate_ids = sorted({bundle.candidate_id for bundle in bundles})
    entries: list[dict[str, Any]] = []
    selected_candidate_id: str | None = None
    best_sort_key: tuple[Decimal, Decimal, Decimal] | None = None
    for candidate_id in candidate_ids:
        candidate_bundles = [bundle for bundle in bundles if bundle.candidate_id == candidate_id]
        replayable_bundles = [bundle for bundle in candidate_bundles if bundle.replayable_market_day]
        execution_bundles = [bundle for bundle in candidate_bundles if bundle.execution_day_eligible]
        proof_eligible_bundles = [
            bundle
            for bundle in replayable_bundles
            if bundle.execution_day_eligible
        ]
        daily_pnls = [bundle.net_pnl_estimated for bundle in proof_eligible_bundles]
        average_daily = _decimal_mean(daily_pnls)
        median_daily = _decimal_median(daily_pnls)
        profitable_ratio = _safe_decimal_ratio(
            Decimal(sum(1 for value in daily_pnls if value > 0)),
            Decimal(len(daily_pnls)),
        )
        entry = {
            'candidate_id': candidate_id,
            'sleeve_id': candidate_id,
            'parameter_hash': _stable_hash(candidate_id),
            'search_batch_id': 'archive-bundle-v1',
            'dataset_snapshot_refs': sorted(
                {
                    str(bundle.replay_day_manifest.get('dataset_snapshot_ref'))
                    for bundle in candidate_bundles
                    if str(bundle.replay_day_manifest.get('dataset_snapshot_ref') or '').strip()
                }
            ),
            'trading_days': sorted({bundle.trading_day for bundle in candidate_bundles}),
            'selection_status': 'rejected',
            'selection_reason': 'not_selected',
            'metrics_summary': {
                'market_days_available': len({bundle.trading_day for bundle in replayable_bundles}),
                'execution_days_available': len({bundle.trading_day for bundle in execution_bundles}),
                'proof_eligible_days': len({bundle.trading_day for bundle in proof_eligible_bundles}),
                'average_daily_net_pnl': format(average_daily, 'f'),
                'median_daily_net_pnl': format(median_daily, 'f'),
                'profitable_day_ratio': format(profitable_ratio, 'f'),
                'total_net_pnl': format(sum(daily_pnls, Decimal('0')), 'f'),
                'average_abs_slippage_bps': _mean_optional_floats(
                    [
                        _as_float(bundle.execution_day_inventory.get('avg_abs_slippage_bps'))
                        for bundle in execution_bundles
                    ]
                ),
            },
        }
        sort_key = (average_daily, median_daily, profitable_ratio)
        if best_sort_key is None or sort_key > best_sort_key:
            best_sort_key = sort_key
            selected_candidate_id = candidate_id
        entries.append(entry)
    for entry in entries:
        if entry['candidate_id'] == selected_candidate_id:
            entry['selection_status'] = 'selected'
            entry['selection_reason'] = 'highest_average_daily_net_pnl'
    return {
        'schema_version': TRIAL_LEDGER_SCHEMA_VERSION,
        'generated_at': (generated_at or datetime.now(_UTC)).astimezone(_UTC).isoformat(),
        'trial_count': len(entries),
        'selected_candidate_id': selected_candidate_id,
        'entries': entries,
    }


def generate_archive_walkforward_folds(
    trading_days: Sequence[str],
    *,
    train_days: int,
    validation_days: int,
    test_days: int,
    step_days: int,
    embargo_days: int,
) -> list[ArchiveWalkForwardFold]:
    if train_days <= 0 or validation_days <= 0 or test_days <= 0 or step_days <= 0 or embargo_days < 0:
        raise ValueError('invalid_walkforward_window')
    ordered_days = sorted({str(day) for day in trading_days})
    folds: list[ArchiveWalkForwardFold] = []
    cursor = 0
    fold_index = 1
    while True:
        train_start = cursor
        train_end = train_start + train_days
        validation_start = train_end + embargo_days
        validation_end = validation_start + validation_days
        test_start = validation_end + embargo_days
        test_end = test_start + test_days
        if test_end > len(ordered_days):
            break
        embargo_window = ordered_days[train_end:validation_start] + ordered_days[validation_end:test_start]
        folds.append(
            ArchiveWalkForwardFold(
                name=f'fold_{fold_index}',
                train_days=ordered_days[train_start:train_end],
                validation_days=ordered_days[validation_start:validation_end],
                test_days=ordered_days[test_start:test_end],
                embargo_days=embargo_window,
            )
        )
        fold_index += 1
        cursor += step_days
    return folds


def _proof_eligible_bundles(
    bundles: Sequence[ArchivedTradingDayBundle],
    *,
    candidate_id: str | None = None,
) -> list[ArchivedTradingDayBundle]:
    return [
        bundle
        for bundle in bundles
        if bundle.replayable_market_day
        and bundle.execution_day_eligible
        and (candidate_id is None or bundle.candidate_id == candidate_id)
    ]


def _candidate_daily_net_pnl_by_day(
    bundles: Sequence[ArchivedTradingDayBundle],
) -> dict[str, dict[str, Decimal]]:
    series: dict[str, dict[str, Decimal]] = {}
    for bundle in _proof_eligible_bundles(bundles):
        candidate_series = series.setdefault(bundle.candidate_id, {})
        candidate_series[bundle.trading_day] = bundle.net_pnl_estimated
    return series


def _fold_selection_rows(
    *,
    candidate_daily_net_pnl_by_day: Mapping[str, Mapping[str, Decimal]],
    folds: Sequence[ArchiveWalkForwardFold],
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    candidate_ids = sorted(candidate_daily_net_pnl_by_day)
    for fold in folds:
        is_days = [*fold.train_days, *fold.validation_days]
        oos_days = list(fold.test_days)
        candidate_metrics: list[dict[str, Any]] = []
        for candidate_id in candidate_ids:
            day_map = candidate_daily_net_pnl_by_day[candidate_id]
            is_values = [day_map[day] for day in is_days if day in day_map]
            oos_values = [day_map[day] for day in oos_days if day in day_map]
            if not is_values or not oos_values:
                continue
            candidate_metrics.append(
                {
                    'candidate_id': candidate_id,
                    'is_avg': _decimal_mean(is_values),
                    'oos_avg': _decimal_mean(oos_values),
                    'oos_sum': sum(oos_values, Decimal('0')),
                }
            )
        if len(candidate_metrics) < 2:
            continue
        candidate_metrics.sort(
            key=lambda item: (cast(Decimal, item['is_avg']), str(item['candidate_id'])),
            reverse=True,
        )
        selected = candidate_metrics[0]
        oos_ranked = sorted(
            candidate_metrics,
            key=lambda item: (cast(Decimal, item['oos_avg']), str(item['candidate_id'])),
            reverse=True,
        )
        oos_rank_by_candidate = {
            str(item['candidate_id']): len(oos_ranked) - index
            for index, item in enumerate(oos_ranked)
        }
        selected_candidate_id = str(selected['candidate_id'])
        relative_rank = Decimal(oos_rank_by_candidate[selected_candidate_id]) / Decimal(len(oos_ranked) + 1)
        omega = min(max(float(relative_rank), 1e-6), 1 - 1e-6)
        rows.append(
            {
                'fold_name': fold.name,
                'selected_candidate_id': selected_candidate_id,
                'is_avg_daily_net_pnl': format(cast(Decimal, selected['is_avg']), 'f'),
                'oos_avg_daily_net_pnl': format(cast(Decimal, selected['oos_avg']), 'f'),
                'oos_total_net_pnl': format(cast(Decimal, selected['oos_sum']), 'f'),
                'oos_relative_rank': float(relative_rank),
                'oos_logit': math.log(omega / (1.0 - omega)),
                'candidate_count': len(oos_ranked),
            }
        )
    return rows


def _estimate_pbo(fold_rows: Sequence[Mapping[str, Any]]) -> float | None:
    if not fold_rows:
        return None
    below_median = sum(1 for row in fold_rows if float(row.get('oos_logit') or 0.0) < 0.0)
    return below_median / len(fold_rows)


def _fit_slope(x_values: Sequence[float], y_values: Sequence[float]) -> float | None:
    if len(x_values) != len(y_values) or len(x_values) < 2:
        return None
    mean_x = sum(x_values) / len(x_values)
    mean_y = sum(y_values) / len(y_values)
    numerator = sum((x_value - mean_x) * (y_value - mean_y) for x_value, y_value in zip(x_values, y_values, strict=True))
    denominator = sum((x_value - mean_x) ** 2 for x_value in x_values)
    if denominator <= 0:
        return None
    return numerator / denominator


def _sample_stddev(values: Sequence[float]) -> float | None:
    if len(values) < 2:
        return None
    mean_value = sum(values) / len(values)
    variance = sum((value - mean_value) ** 2 for value in values) / (len(values) - 1)
    if variance <= 0:
        return None
    return math.sqrt(variance)


def _daily_sharpe_ratio(values: Sequence[Decimal]) -> float | None:
    resolved = [float(value) for value in values]
    stddev = _sample_stddev(resolved)
    if stddev is None or stddev <= 0:
        return None
    return (sum(resolved) / len(resolved)) / stddev


def _skewness_and_kurtosis(values: Sequence[Decimal]) -> tuple[float, float]:
    resolved = [float(value) for value in values]
    if len(resolved) < 3:
        return (0.0, 3.0)
    mean_value = sum(resolved) / len(resolved)
    centered = [value - mean_value for value in resolved]
    second = sum(value**2 for value in centered) / len(centered)
    if second <= 0:
        return (0.0, 3.0)
    third = sum(value**3 for value in centered) / len(centered)
    fourth = sum(value**4 for value in centered) / len(centered)
    skewness = third / (second ** 1.5)
    kurtosis = fourth / (second**2)
    return (skewness, kurtosis)


def _estimate_deflated_sharpe_ratio(
    *,
    selected_values: Sequence[Decimal],
    candidate_daily_net_pnl_by_day: Mapping[str, Mapping[str, Decimal]],
    oos_days: Sequence[str],
    trial_count: int,
) -> dict[str, float | int | None]:
    if len(selected_values) < _DSR_MIN_SAMPLE_DAYS:
        return {
            'sample_size': len(selected_values),
            'selected_daily_sharpe_ratio': None,
            'benchmark_sharpe_threshold': None,
            'deflated_sharpe_ratio': None,
            'deflated_sharpe_z_score': None,
        }

    selected_sharpe = _daily_sharpe_ratio(selected_values)
    if selected_sharpe is None:
        return {
            'sample_size': len(selected_values),
            'selected_daily_sharpe_ratio': None,
            'benchmark_sharpe_threshold': None,
            'deflated_sharpe_ratio': None,
            'deflated_sharpe_z_score': None,
        }

    trial_sharpes: list[float] = []
    for day_map in candidate_daily_net_pnl_by_day.values():
        candidate_values = [day_map[day] for day in oos_days if day in day_map]
        candidate_sharpe = _daily_sharpe_ratio(candidate_values)
        if candidate_sharpe is not None:
            trial_sharpes.append(candidate_sharpe)
    trial_reference_count = max(trial_count, len(trial_sharpes))
    if trial_reference_count < 2:
        return {
            'sample_size': len(selected_values),
            'selected_daily_sharpe_ratio': selected_sharpe,
            'benchmark_sharpe_threshold': None,
            'deflated_sharpe_ratio': None,
            'deflated_sharpe_z_score': None,
        }

    trial_sharpe_mean = sum(trial_sharpes) / len(trial_sharpes) if trial_sharpes else 0.0
    trial_sharpe_stddev = _sample_stddev(trial_sharpes) or 0.0
    euler_gamma = 0.5772156649015329
    first_extreme = _NORMAL_DIST.inv_cdf(1.0 - (1.0 / trial_reference_count))
    second_extreme = _NORMAL_DIST.inv_cdf(1.0 - (1.0 / (trial_reference_count * math.e)))
    benchmark_sharpe_threshold = trial_sharpe_mean + trial_sharpe_stddev * (
        (1.0 - euler_gamma) * first_extreme + euler_gamma * second_extreme
    )

    skewness, kurtosis = _skewness_and_kurtosis(selected_values)
    denominator = math.sqrt(
        max(
            1e-12,
            1.0
            - (skewness * selected_sharpe)
            + (((kurtosis - 1.0) / 4.0) * (selected_sharpe**2)),
        )
    )
    z_score = ((selected_sharpe - benchmark_sharpe_threshold) * math.sqrt(len(selected_values) - 1)) / denominator
    return {
        'sample_size': len(selected_values),
        'selected_daily_sharpe_ratio': selected_sharpe,
        'benchmark_sharpe_threshold': benchmark_sharpe_threshold,
        'deflated_sharpe_ratio': _NORMAL_DIST.cdf(z_score),
        'deflated_sharpe_z_score': z_score,
    }


def _moving_block_bootstrap_indices(
    *,
    length: int,
    block_size: int,
    rng: random.Random,
) -> list[int]:
    indices: list[int] = []
    while len(indices) < length:
        start = rng.randrange(length)
        for offset in range(block_size):
            indices.append((start + offset) % length)
            if len(indices) >= length:
                break
    return indices


def _estimate_reality_check_p_value(
    *,
    candidate_daily_net_pnl_by_day: Mapping[str, Mapping[str, Decimal]],
    oos_days: Sequence[str],
    bootstrap_replicates: int,
) -> float | None:
    if len(oos_days) < _REALITY_CHECK_MIN_SAMPLE_DAYS:
        return None
    aligned_series: list[list[float]] = []
    for day_map in candidate_daily_net_pnl_by_day.values():
        if all(day in day_map for day in oos_days):
            aligned_series.append([float(day_map[day]) for day in oos_days])
    if len(aligned_series) < 2:
        return None

    observed = max(sum(series) / len(series) for series in aligned_series)
    if observed <= 0:
        return 1.0

    centered_series = [
        [value - (sum(series) / len(series)) for value in series]
        for series in aligned_series
    ]
    block_size = max(2, int(round(math.sqrt(len(oos_days)))))
    rng = random.Random(0)
    exceedances = 0
    for _ in range(bootstrap_replicates):
        sample_indices = _moving_block_bootstrap_indices(
            length=len(oos_days),
            block_size=block_size,
            rng=rng,
        )
        bootstrap_statistic = max(
            sum(series[index] for index in sample_indices) / len(sample_indices)
            for series in centered_series
        )
        if bootstrap_statistic >= observed:
            exceedances += 1
    return (exceedances + 1) / (bootstrap_replicates + 1)


def build_statistical_validity_report(
    *,
    selected_candidate_id: str | None,
    bundles: Sequence[ArchivedTradingDayBundle],
    trial_ledger: Mapping[str, Any],
    data_sufficiency: Mapping[str, Any],
    folds: Sequence[ArchiveWalkForwardFold],
    profit_target_daily_net_usd: Decimal = Decimal('250'),
    median_target_daily_net_usd: Decimal = Decimal('125'),
    profitable_day_ratio_target: Decimal = Decimal('0.60'),
    reality_check_bootstrap_replicates: int = _REALITY_CHECK_BOOTSTRAP_REPLICATES,
    generated_at: datetime | None = None,
) -> dict[str, Any]:
    blockers: list[str] = []
    if selected_candidate_id is None:
        blockers.append('selected_candidate_missing')
    selected_bundles = _proof_eligible_bundles(bundles, candidate_id=selected_candidate_id)
    selected_by_day = {bundle.trading_day: bundle for bundle in selected_bundles}
    if not folds:
        blockers.append('walkforward_folds_unavailable')
    test_day_values: list[Decimal] = []
    for fold in folds:
        for trading_day in fold.test_days:
            bundle = selected_by_day.get(trading_day)
            if bundle is not None:
                test_day_values.append(bundle.net_pnl_estimated)
    if not test_day_values:
        blockers.append('walkforward_test_days_empty')

    average_daily = _decimal_mean(test_day_values)
    median_daily = _decimal_median(test_day_values)
    profitable_ratio = _safe_decimal_ratio(
        Decimal(sum(1 for value in test_day_values if value > 0)),
        Decimal(len(test_day_values)),
    )
    after_cost_positive = sum(test_day_values, Decimal('0')) > 0

    trial_count = _as_int(trial_ledger.get('trial_count'))
    candidate_daily_net_pnl_by_day = _candidate_daily_net_pnl_by_day(bundles)
    fold_rows = _fold_selection_rows(
        candidate_daily_net_pnl_by_day=candidate_daily_net_pnl_by_day,
        folds=folds,
    )
    pbo = _estimate_pbo(fold_rows)
    selected_oos_days = sorted({day for fold in folds for day in fold.test_days if day in selected_by_day})
    dsr_payload = _estimate_deflated_sharpe_ratio(
        selected_values=test_day_values,
        candidate_daily_net_pnl_by_day=candidate_daily_net_pnl_by_day,
        oos_days=selected_oos_days,
        trial_count=trial_count,
    )
    dsr = cast(float | None, dsr_payload.get('deflated_sharpe_ratio'))
    dsr_z_score = cast(float | None, dsr_payload.get('deflated_sharpe_z_score'))
    reality_check_p_value: float | None = None
    if trial_count < 2:
        blockers.append('selection_bias_metrics_unavailable_due_to_trial_count')
    else:
        reality_check_p_value = _estimate_reality_check_p_value(
            candidate_daily_net_pnl_by_day=candidate_daily_net_pnl_by_day,
            oos_days=selected_oos_days,
            bootstrap_replicates=max(reality_check_bootstrap_replicates, 50),
        )
    if average_daily < profit_target_daily_net_usd:
        blockers.append('average_daily_net_pnl_below_target')
    if median_daily < median_target_daily_net_usd:
        blockers.append('median_daily_net_pnl_below_target')
    if profitable_ratio < profitable_day_ratio_target:
        blockers.append('profitable_day_ratio_below_target')
    if not after_cost_positive:
        blockers.append('after_cost_net_pnl_not_positive')
    if pbo is None:
        blockers.append('pbo_unavailable')
    elif pbo > 0.20:
        blockers.append('pbo_above_threshold')
    if dsr is None or dsr_z_score is None:
        blockers.append('dsr_unavailable')
    elif dsr_z_score <= 0:
        blockers.append('dsr_below_threshold')
    if reality_check_p_value is None:
        blockers.append('reality_check_unavailable')
    elif reality_check_p_value >= 0.05:
        blockers.append('reality_check_p_value_above_threshold')
    historical_gate_passed = not blockers

    performance_degradation_beta = _fit_slope(
        [float(row.get('is_avg_daily_net_pnl') or 0.0) for row in fold_rows],
        [float(row.get('oos_avg_daily_net_pnl') or 0.0) for row in fold_rows],
    )
    probability_of_loss = None
    if fold_rows:
        probability_of_loss = sum(
            1 for row in fold_rows if float(row.get('oos_avg_daily_net_pnl') or 0.0) < 0.0
        ) / len(fold_rows)

    return {
        'schema_version': STATISTICAL_VALIDITY_SCHEMA_VERSION,
        'generated_at': (generated_at or datetime.now(_UTC)).astimezone(_UTC).isoformat(),
        'candidate_id': selected_candidate_id,
        'status': 'passed' if historical_gate_passed else 'blocked',
        'historical_gate_passed': historical_gate_passed,
        'blockers': sorted(set(blockers)),
        'proof_window': {
            'fold_count': len(folds),
            'folds': [fold.to_payload() for fold in folds],
            'test_days': sorted({day for fold in folds for day in fold.test_days}),
        },
        'metrics': {
            'average_daily_net_pnl': format(average_daily, 'f'),
            'median_daily_net_pnl': format(median_daily, 'f'),
            'profitable_day_ratio': format(profitable_ratio, 'f'),
            'after_cost_net_pnl_positive': after_cost_positive,
        },
        'selection_bias_metrics': {
            'trial_count': trial_count,
            'fold_sample_size': len(fold_rows),
            'pbo_method': 'forward_walk_relative_rank_logit',
            'pbo': pbo,
            'performance_degradation_beta': performance_degradation_beta,
            'probability_of_loss': probability_of_loss,
            'dsr_method': 'deflated_sharpe_ratio_daily_oos',
            'dsr': dsr,
            'dsr_z_score': dsr_z_score,
            'selected_daily_sharpe_ratio': dsr_payload.get('selected_daily_sharpe_ratio'),
            'benchmark_sharpe_threshold': dsr_payload.get('benchmark_sharpe_threshold'),
            'reality_check_method': 'moving_block_bootstrap_max_mean',
            'reality_check_p_value': reality_check_p_value,
            'fold_rows': fold_rows,
        },
        'thresholds': {
            'profit_target_daily_net_usd': format(profit_target_daily_net_usd, 'f'),
            'median_target_daily_net_usd': format(median_target_daily_net_usd, 'f'),
            'profitable_day_ratio_target': format(profitable_day_ratio_target, 'f'),
            'pbo_max': '0.20',
            'dsr_min': '0',
            'reality_check_p_value_max': '0.05',
        },
        'data_sufficiency': dict(data_sufficiency),
    }


def build_profitability_certificate(
    *,
    selected_candidate_id: str | None,
    data_sufficiency: Mapping[str, Any],
    trial_ledger: Mapping[str, Any],
    statistical_validity_report: Mapping[str, Any],
    artifact_refs: Sequence[str],
    profit_target_daily_net_usd: Decimal = Decimal('250'),
    generated_at: datetime | None = None,
) -> dict[str, Any]:
    promotion_blockers = list(cast(list[str], statistical_validity_report.get('blockers') or []))
    promotion_blockers.extend(
        [str(item) for item in _as_list(data_sufficiency.get('blockers')) if str(item).strip()]
    )
    status = CERTIFICATE_STATUS_INSUFFICIENT_HISTORY
    sufficiency_status = _as_text(data_sufficiency.get('status')) or SUFFICIENCY_STATUS_INSUFFICIENT_HISTORY
    historical_gate_passed = bool(statistical_validity_report.get('historical_gate_passed', False))
    if sufficiency_status == SUFFICIENCY_STATUS_RESEARCH_ONLY:
        status = CERTIFICATE_STATUS_RESEARCH_ONLY
    elif sufficiency_status == SUFFICIENCY_STATUS_HISTORICAL_READY:
        status = (
            CERTIFICATE_STATUS_HISTORICAL_PROVEN
            if historical_gate_passed
            else CERTIFICATE_STATUS_RESEARCH_ONLY
        )
    elif sufficiency_status == SUFFICIENCY_STATUS_PAPER_READY:
        status = (
            CERTIFICATE_STATUS_HISTORICAL_PROVEN
            if historical_gate_passed
            else CERTIFICATE_STATUS_RESEARCH_ONLY
        )

    return {
        'schema_version': PROFITABILITY_CERTIFICATE_SCHEMA_VERSION,
        'generated_at': (generated_at or datetime.now(_UTC)).astimezone(_UTC).isoformat(),
        'status': status,
        'candidate_id': selected_candidate_id,
        'sleeve_ids': [selected_candidate_id] if selected_candidate_id else [],
        'profit_target_daily_net_usd': format(profit_target_daily_net_usd, 'f'),
        'data_sufficiency': dict(data_sufficiency),
        'proof_window': dict(_as_dict(statistical_validity_report.get('proof_window'))),
        'trial_count': _as_int(trial_ledger.get('trial_count')),
        'promotion_blockers': sorted(set(promotion_blockers)),
        'historical_metrics': dict(_as_dict(statistical_validity_report.get('metrics'))),
        'paper_metrics': {},
        'execution_realism_summary': {},
        'dataset_snapshot_refs': sorted(
            {
                str(ref)
                for entry in _as_list(trial_ledger.get('entries'))
                for ref in _as_list(_as_dict(entry).get('dataset_snapshot_refs'))
                if str(ref).strip()
            }
        ),
        'artifact_refs': sorted({str(path) for path in artifact_refs if str(path).strip()}),
    }


def _min_retention_days(bundles: Sequence[ArchivedTradingDayBundle]) -> int | None:
    days: list[int] = []
    for bundle in bundles:
        raw = _as_dict(bundle.market_day_inventory.get('source_topic_retention_ms_by_topic'))
        for value in raw.values():
            retention_ms = _as_int(value)
            if retention_ms > 0:
                days.append(max(retention_ms // 86_400_000, 0))
    if not days:
        return None
    return min(days)


def _missing_business_days(trading_days: Sequence[str]) -> list[str]:
    if not trading_days:
        return []
    ordered = sorted({date.fromisoformat(item) for item in trading_days})
    missing: list[str] = []
    cursor = ordered[0]
    end = ordered[-1]
    available = set(ordered)
    while cursor <= end:
        if cursor.weekday() < 5 and cursor not in available:
            missing.append(cursor.isoformat())
        cursor += timedelta(days=1)
    return missing


def _decimal_mean(values: Sequence[Decimal]) -> Decimal:
    if not values:
        return Decimal('0')
    return sum(values, Decimal('0')) / Decimal(len(values))


def _decimal_median(values: Sequence[Decimal]) -> Decimal:
    if not values:
        return Decimal('0')
    ordered = sorted(values)
    midpoint = len(ordered) // 2
    if len(ordered) % 2 == 1:
        return ordered[midpoint]
    return (ordered[midpoint - 1] + ordered[midpoint]) / Decimal('2')


def _safe_decimal_ratio(numerator: Decimal, denominator: Decimal) -> Decimal:
    if denominator <= 0:
        return Decimal('0')
    return numerator / denominator


def _mean_optional_floats(values: Sequence[float | None]) -> float | None:
    resolved = [value for value in values if value is not None]
    if not resolved:
        return None
    return sum(resolved) / len(resolved)


__all__ = [
    'ARCHIVE_STATUS_ARCHIVED',
    'ARCHIVE_STATUS_INSUFFICIENT',
    'ARCHIVE_STATUS_PARTIAL',
    'ArchiveWalkForwardFold',
    'ArchivedTradingDayBundle',
    'CERTIFICATE_STATUS_HISTORICAL_PROVEN',
    'CERTIFICATE_STATUS_INSUFFICIENT_HISTORY',
    'CERTIFICATE_STATUS_LIVE_CAPPED',
    'CERTIFICATE_STATUS_LIVE_FULL',
    'CERTIFICATE_STATUS_PAPER_PROVEN',
    'CERTIFICATE_STATUS_RESEARCH_ONLY',
    'DATA_SUFFICIENCY_SCHEMA_VERSION',
    'EXECUTION_DAY_INVENTORY_SCHEMA_VERSION',
    'MARKET_DAY_INVENTORY_SCHEMA_VERSION',
    'PROFITABILITY_CERTIFICATE_SCHEMA_VERSION',
    'REPLAY_DAY_MANIFEST_SCHEMA_VERSION',
    'STATISTICAL_VALIDITY_SCHEMA_VERSION',
    'SUFFICIENCY_STATUS_HISTORICAL_READY',
    'SUFFICIENCY_STATUS_INSUFFICIENT_HISTORY',
    'SUFFICIENCY_STATUS_PAPER_READY',
    'SUFFICIENCY_STATUS_RESEARCH_ONLY',
    'TRIAL_LEDGER_SCHEMA_VERSION',
    'archive_historical_simulation_run',
    'build_execution_day_inventory',
    'build_market_day_inventory',
    'build_profitability_certificate',
    'build_replay_day_manifest',
    'build_statistical_validity_report',
    'build_trial_ledger',
    'collect_simulation_postgres_counts',
    'copy_archive_artifacts',
    'generate_archive_walkforward_folds',
    'load_archived_trading_day_bundles',
    'summarize_data_sufficiency',
    'upsert_dataset_snapshot',
]
