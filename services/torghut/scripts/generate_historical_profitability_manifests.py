#!/usr/bin/env python3
"""Generate deterministic full-day historical simulation manifests for an OOS proof window."""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Sequence

import yaml


@dataclass(frozen=True)
class ManifestWindow:
    trading_day: date
    manifest_path: Path
    dataset_id: str
    simulation_database: str


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--start-date', required=True, help='Inclusive UTC trading-day start in YYYY-MM-DD format.')
    parser.add_argument('--end-date', required=True, help='Inclusive UTC trading-day end in YYYY-MM-DD format.')
    parser.add_argument(
        '--digest',
        required=True,
        help='Frozen torghut digest, for example sha256:abc123... or registry...@sha256:abc123...',
    )
    parser.add_argument('--output-dir', required=True, help='Directory where manifests should be written.')
    parser.add_argument('--cache-policy', default='refresh', help='Replay cache policy for each generated manifest.')
    parser.add_argument('--candidate-id', default='intraday_tsmom_v1@prod')
    parser.add_argument('--baseline-candidate-id', default='intraday_tsmom_v1@baseline')
    parser.add_argument('--strategy-spec-ref', default='strategy-specs/intraday_tsmom_v1@1.1.0.json')
    parser.add_argument('--model-ref', action='append', default=['rules/intraday_tsmom_v1'])
    parser.add_argument('--json', action='store_true')
    return parser.parse_args()


def _parse_day(raw: str) -> date:
    try:
        return date.fromisoformat(raw)
    except ValueError as exc:
        raise RuntimeError(f'invalid_date:{raw}') from exc


def _normalized_digest(raw: str) -> str:
    text = raw.strip()
    if not text:
        raise RuntimeError('digest_required')
    if '@sha256:' in text:
        return text.split('@sha256:', 1)[1]
    if text.startswith('sha256:'):
        return text.split('sha256:', 1)[1]
    return text


def _iter_trading_days(*, start_day: date, end_day: date) -> list[date]:
    if end_day < start_day:
        raise RuntimeError('date_range_invalid')
    days: list[date] = []
    cursor = start_day
    while cursor <= end_day:
        if cursor.weekday() < 5:
            days.append(cursor)
        cursor += timedelta(days=1)
    if not days:
        raise RuntimeError('no_trading_days_in_range')
    return days


def _manifest_payload(
    *,
    trading_day: date,
    digest: str,
    digest_short: str,
    cache_policy: str,
    candidate_id: str,
    baseline_candidate_id: str,
    strategy_spec_ref: str,
    model_refs: Sequence[str],
) -> dict[str, object]:
    day_compact = trading_day.strftime('%Y%m%d')
    day_iso = trading_day.isoformat()
    return {
        'dataset_id': f'torghut-full-day-{day_compact}-{digest_short}',
        'dataset_snapshot_ref': f'torghut-full-day-{day_compact}-{digest_short}',
        'candidate_id': candidate_id,
        'baseline_candidate_id': baseline_candidate_id,
        'strategy_spec_ref': strategy_spec_ref,
        'model_refs': list(model_refs),
        'runtime_version_refs': [
            f'services/torghut@sha256:{digest}',
            f'services/torghut-forecast@sha256:{digest}',
        ],
        'cachePolicy': cache_policy,
        'performance': {
            'replayProfile': 'full_day',
            'dumpFormat': 'jsonl.zst',
        },
        'ta_restore': {
            'mode': 'stateless',
        },
        'window': {
            'profile': 'us_equities_regular',
            'trading_day': day_iso,
            'timezone': 'America/New_York',
            'start': f'{day_iso}T13:30:00Z',
            'end': f'{day_iso}T20:00:00Z',
            'min_coverage_minutes': 390,
            'strict_coverage_ratio': 0.95,
        },
        'kafka': {
            'bootstrap_servers': 'kafka-kafka-bootstrap.kafka.svc.cluster.local:9092',
            'runtime_bootstrap_servers': 'kafka-kafka-bootstrap.kafka.svc.cluster.local:9092',
            'security_protocol': 'SASL_PLAINTEXT',
            'sasl_mechanism': 'SCRAM-SHA-512',
            'sasl_username': 'kafka-codex-credentials',
            'sasl_password_env': 'TORGHUT_SIM_KAFKA_PASSWORD',
            'runtime_security_protocol': 'SASL_PLAINTEXT',
            'runtime_sasl_mechanism': 'SCRAM-SHA-512',
            'runtime_sasl_username': 'kafka-codex-credentials',
            'runtime_sasl_password_env': 'TORGHUT_SIM_KAFKA_PASSWORD',
            'default_partitions': 8,
            'replication_factor': 1,
        },
        'clickhouse': {
            'http_url': 'http://torghut-clickhouse.torghut.svc.cluster.local:8123',
            'username': 'torghut',
            'password_env': 'TORGHUT_CLICKHOUSE_PASSWORD',
            'password_secret_name': 'torghut-clickhouse-auth',
            'password_secret_key': 'torghut_password',
            'secret_namespace': 'torghut',
            'simulation_database': f'torghut_sim_{trading_day.strftime("%Y_%m_%d")}_full_day_{digest_short}',
        },
        'postgres': {
            'admin_dsn': 'postgresql://postgres@torghut-db-rw.torghut.svc.cluster.local:5432/postgres',
            'admin_dsn_password_env': 'TORGHUT_POSTGRES_ADMIN_PASSWORD',
            'simulation_dsn': (
                'postgresql://torghut_app@torghut-db-rw.torghut.svc.cluster.local:5432/'
                f'torghut_sim_{trading_day.strftime("%Y_%m_%d")}_full_day_{digest_short}'
            ),
            'simulation_dsn_password_env': 'TORGHUT_POSTGRES_PASSWORD',
            'runtime_simulation_dsn': (
                'postgresql://torghut_app@torghut-db-rw.torghut.svc.cluster.local:5432/'
                f'torghut_sim_{trading_day.strftime("%Y_%m_%d")}_full_day_{digest_short}'
            ),
            'runtime_simulation_dsn_password_env': 'TORGHUT_POSTGRES_PASSWORD',
            'migrations_command': '/opt/venv/bin/alembic upgrade heads',
        },
        'runtime': {
            'target_mode': 'dedicated_service',
            'namespace': 'torghut',
            'ta_configmap': 'torghut-ta-sim-config',
            'ta_deployment': 'torghut-ta-sim',
            'torghut_service': 'torghut-sim',
            'torghut_forecast_service': 'torghut-forecast-sim',
            'output_root': 'artifacts/torghut/simulations',
        },
        'rollouts': {
            'enabled': True,
            'namespace': 'torghut',
            'runtime_template': 'torghut-simulation-runtime-ready',
            'activity_template': 'torghut-simulation-activity',
            'teardown_template': 'torghut-simulation-teardown-clean',
            'artifact_template': 'torghut-simulation-artifact-bundle',
        },
        'replay': {
            'pace_mode': 'max_throughput',
            'acceleration': 1,
            'max_sleep_seconds': 0,
            'auto_offset_reset': 'earliest',
            'flush_every_records': 50000,
            'flush_timeout_seconds': 60,
            'final_flush_timeout_seconds': 180,
            'status_update_every_records': 25000,
            'status_update_every_seconds': 30,
        },
        'monitor': {
            'timeout_seconds': 14400,
            'poll_seconds': 30,
            'min_trade_decisions': 1,
            'min_executions': 1,
            'min_execution_tca_metrics': 1,
            'min_execution_order_events': 1,
            'cursor_grace_seconds': 120,
        },
        'argocd': {
            'manage_automation': True,
            'applicationset_name': 'product',
            'applicationset_namespace': 'argocd',
            'app_name': 'torghut',
            'desired_mode_during_run': 'manual',
            'restore_mode_after_run': 'previous',
            'verify_timeout_seconds': 900,
        },
        'reporting': {
            'commission_bps': '0',
            'per_trade_fee': '0',
        },
    }


def generate_profitability_manifests(
    *,
    start_day: date,
    end_day: date,
    digest: str,
    output_dir: Path,
    cache_policy: str,
    candidate_id: str,
    baseline_candidate_id: str,
    strategy_spec_ref: str,
    model_refs: Sequence[str],
    generated_at: datetime | None = None,
) -> dict[str, object]:
    normalized_digest = _normalized_digest(digest)
    digest_short = normalized_digest[:8]
    output_dir.mkdir(parents=True, exist_ok=True)
    generated_timestamp = (generated_at or datetime.now(UTC)).isoformat()

    manifests: list[ManifestWindow] = []
    for trading_day in _iter_trading_days(start_day=start_day, end_day=end_day):
        filename = f'full-day-{trading_day.isoformat()}-{cache_policy}-{digest_short}-proof.yaml'
        manifest_path = output_dir / filename
        simulation_database = f'torghut_sim_{trading_day.strftime("%Y_%m_%d")}_full_day_{digest_short}'
        payload = _manifest_payload(
            trading_day=trading_day,
            digest=normalized_digest,
            digest_short=digest_short,
            cache_policy=cache_policy,
            candidate_id=candidate_id,
            baseline_candidate_id=baseline_candidate_id,
            strategy_spec_ref=strategy_spec_ref,
            model_refs=model_refs,
        )
        manifest_path.write_text(yaml.safe_dump(payload, sort_keys=False), encoding='utf-8')
        manifests.append(
            ManifestWindow(
                trading_day=trading_day,
                manifest_path=manifest_path,
                dataset_id=str(payload['dataset_id']),
                simulation_database=simulation_database,
            )
        )

    index_payload = {
        'schema_version': 'torghut.historical-profitability-manifest-index.v1',
        'generated_at': generated_timestamp,
        'digest': normalized_digest,
        'cache_policy': cache_policy,
        'manifests': [
            {
                'trading_day': item.trading_day.isoformat(),
                'manifest_path': str(item.manifest_path),
                'dataset_id': item.dataset_id,
                'simulation_database': item.simulation_database,
            }
            for item in manifests
        ],
    }
    (output_dir / 'manifest-index.json').write_text(json.dumps(index_payload, indent=2), encoding='utf-8')
    return index_payload


def main() -> int:
    args = _parse_args()
    summary = generate_profitability_manifests(
        start_day=_parse_day(args.start_date),
        end_day=_parse_day(args.end_date),
        digest=args.digest,
        output_dir=Path(args.output_dir),
        cache_policy=args.cache_policy,
        candidate_id=args.candidate_id,
        baseline_candidate_id=args.baseline_candidate_id,
        strategy_spec_ref=args.strategy_spec_ref,
        model_refs=args.model_ref,
    )
    if args.json:
        print(json.dumps(summary, indent=2))
    else:
        print(json.dumps(summary))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
