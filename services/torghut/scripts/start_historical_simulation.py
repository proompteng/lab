#!/usr/bin/env python3
"""Single-entrypoint historical simulation workflow for Torghut."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import shlex
import shutil
import subprocess
import time
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, Sequence, cast
from urllib.parse import quote_plus, urlsplit
from http.client import HTTPConnection, HTTPSConnection

import psycopg
from psycopg import sql
import yaml

APPLY_CONFIRMATION_PHRASE = 'START_HISTORICAL_SIMULATION'
DEFAULT_NAMESPACE = 'torghut'
DEFAULT_TA_CONFIGMAP = 'torghut-ta-config'
DEFAULT_TA_DEPLOYMENT = 'torghut-ta'
DEFAULT_TORGHUT_SERVICE = 'torghut'
DEFAULT_OUTPUT_ROOT = Path('artifacts/torghut/simulations')

PRODUCTION_TOPIC_BY_ROLE = {
    'trades': 'torghut.trades.v1',
    'quotes': 'torghut.quotes.v1',
    'bars': 'torghut.bars.1m.v1',
    'status': 'torghut.status.v1',
    'ta_microbars': 'torghut.ta.bars.1s.v1',
    'ta_signals': 'torghut.ta.signals.v1',
    'ta_status': 'torghut.ta.status.v1',
    'order_updates': 'torghut.trade-updates.v1',
}

SIMULATION_TOPIC_BY_ROLE = {
    'trades': 'torghut.sim.trades.v1',
    'quotes': 'torghut.sim.quotes.v1',
    'bars': 'torghut.sim.bars.1m.v1',
    'status': 'torghut.sim.status.v1',
    'ta_microbars': 'torghut.sim.ta.bars.1s.v1',
    'ta_signals': 'torghut.sim.ta.signals.v1',
    'ta_status': 'torghut.sim.ta.status.v1',
    'order_updates': 'torghut.sim.trade-updates.v1',
}

TA_TOPIC_KEY_BY_ROLE = {
    'trades': 'TA_TRADES_TOPIC',
    'quotes': 'TA_QUOTES_TOPIC',
    'bars': 'TA_BARS1M_TOPIC',
    'ta_microbars': 'TA_MICROBARS_TOPIC',
    'ta_signals': 'TA_SIGNALS_TOPIC',
}

TORGHUT_ENV_KEYS = [
    'DB_DSN',
    'TRADING_MODE',
    'TRADING_LIVE_ENABLED',
    'TRADING_FEATURE_FLAGS_ENABLED',
    'TRADING_SIGNAL_TABLE',
    'TRADING_PRICE_TABLE',
    'TRADING_ORDER_FEED_ENABLED',
    'TRADING_ORDER_FEED_BOOTSTRAP_SERVERS',
    'TRADING_ORDER_FEED_TOPIC',
    'TRADING_ORDER_FEED_TOPIC_V2',
    'TRADING_ORDER_FEED_GROUP_ID',
    'TRADING_EXECUTION_ADAPTER',
    'TRADING_EXECUTION_FALLBACK_ADAPTER',
    'TRADING_SIMULATION_ENABLED',
    'TRADING_SIMULATION_RUN_ID',
    'TRADING_SIMULATION_DATASET_ID',
    'TRADING_SIMULATION_ORDER_UPDATES_TOPIC',
    'TRADING_SIMULATION_ORDER_UPDATES_BOOTSTRAP_SERVERS',
]


@dataclass(frozen=True)
class KafkaRuntimeConfig:
    bootstrap_servers: str
    security_protocol: str | None
    sasl_mechanism: str | None
    sasl_username: str | None
    sasl_password: str | None

    def kafka_client_kwargs(self) -> dict[str, Any]:
        kwargs: dict[str, Any] = {
            'bootstrap_servers': [
                item.strip()
                for item in self.bootstrap_servers.split(',')
                if item.strip()
            ],
        }
        if self.security_protocol:
            kwargs['security_protocol'] = self.security_protocol
        if self.sasl_mechanism:
            kwargs['sasl_mechanism'] = self.sasl_mechanism
        if self.sasl_username:
            kwargs['sasl_plain_username'] = self.sasl_username
        if self.sasl_password:
            kwargs['sasl_plain_password'] = self.sasl_password
        return kwargs


@dataclass(frozen=True)
class ClickHouseRuntimeConfig:
    http_url: str
    username: str | None
    password: str | None


@dataclass(frozen=True)
class PostgresRuntimeConfig:
    admin_dsn: str
    simulation_dsn: str
    simulation_db: str
    migrations_command: str


@dataclass(frozen=True)
class SimulationResources:
    run_id: str
    run_token: str
    dataset_id: str
    namespace: str
    ta_configmap: str
    ta_deployment: str
    torghut_service: str
    output_root: Path
    source_topic_by_role: dict[str, str]
    simulation_topic_by_role: dict[str, str]
    replay_topic_by_source_topic: dict[str, str]
    ta_group_id: str
    order_feed_group_id: str
    clickhouse_db: str
    clickhouse_signal_table: str
    clickhouse_price_table: str


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description='Plan/apply/teardown historical simulation runs with isolated Kafka and storage targets.',
    )
    parser.add_argument('--mode', choices=['plan', 'apply', 'teardown'], default='plan')
    parser.add_argument('--run-id', required=True, help='Stable simulation run id (used for all isolation names).')
    parser.add_argument('--dataset-manifest', required=True, help='JSON or YAML manifest describing dataset + infra endpoints.')
    parser.add_argument('--confirm', default='', help=f'Apply confirmation phrase: {APPLY_CONFIRMATION_PHRASE}')
    parser.add_argument('--json', action='store_true', help='Emit machine-readable JSON output only.')
    parser.add_argument('--force-replay', action='store_true', help='Replay dump even when replay marker exists.')
    parser.add_argument('--force-dump', action='store_true', help='Re-dump source topics even when dump file exists.')
    parser.add_argument(
        '--allow-missing-state',
        action='store_true',
        help='Allow teardown without an existing state file (no-op restore).',
    )
    return parser.parse_args()


def _load_manifest(path: Path) -> dict[str, Any]:
    if not path.exists():
        raise SystemExit(f'dataset manifest not found: {path}')
    raw = path.read_text(encoding='utf-8')
    suffix = path.suffix.lower()
    if suffix in {'.yaml', '.yml'}:
        payload = yaml.safe_load(raw)
    else:
        payload = json.loads(raw)
    if not isinstance(payload, Mapping):
        raise SystemExit('dataset manifest must parse to a mapping object')
    return {str(key): value for key, value in cast(Mapping[str, Any], payload).items()}


def _normalize_run_token(run_id: str) -> str:
    token = re.sub(r'[^a-zA-Z0-9]+', '_', run_id.strip().lower()).strip('_')
    token = re.sub(r'_+', '_', token)
    if not token:
        raise SystemExit('run-id must contain at least one alphanumeric character')
    return token


def _as_mapping(value: Any) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        return {}
    return {str(key): item for key, item in cast(Mapping[str, Any], value).items()}


def _as_text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    return text


def _parse_rfc3339_timestamp(value: str | None, *, label: str) -> datetime:
    if value is None:
        raise SystemExit(f'{label} is required in manifest')
    cleaned = value.replace('Z', '+00:00')
    try:
        parsed = datetime.fromisoformat(cleaned)
    except ValueError as exc:
        raise SystemExit(f'invalid {label} timestamp: {value}') from exc
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _build_kafka_runtime_config(manifest: Mapping[str, Any]) -> KafkaRuntimeConfig:
    kafka = _as_mapping(manifest.get('kafka'))
    bootstrap_servers = _as_text(kafka.get('bootstrap_servers'))
    if not bootstrap_servers:
        raise SystemExit('manifest.kafka.bootstrap_servers is required')
    password = _as_text(kafka.get('sasl_password'))
    password_env = _as_text(kafka.get('sasl_password_env'))
    if password is None and password_env:
        password = _as_text(os.environ.get(password_env))
    return KafkaRuntimeConfig(
        bootstrap_servers=bootstrap_servers,
        security_protocol=_as_text(kafka.get('security_protocol')),
        sasl_mechanism=_as_text(kafka.get('sasl_mechanism')),
        sasl_username=_as_text(kafka.get('sasl_username')),
        sasl_password=password,
    )


def _build_clickhouse_runtime_config(manifest: Mapping[str, Any]) -> ClickHouseRuntimeConfig:
    clickhouse = _as_mapping(manifest.get('clickhouse'))
    http_url = _as_text(clickhouse.get('http_url'))
    if not http_url:
        raise SystemExit('manifest.clickhouse.http_url is required')
    return ClickHouseRuntimeConfig(
        http_url=http_url.rstrip('/'),
        username=_as_text(clickhouse.get('username')),
        password=_as_text(clickhouse.get('password')),
    )


def _derive_simulation_dsn(admin_dsn: str, db_name: str) -> str:
    parsed = urlsplit(admin_dsn)
    if not parsed.scheme or not parsed.netloc:
        raise SystemExit('manifest.postgres.admin_dsn must be a valid URL')
    suffix = f'?{parsed.query}' if parsed.query else ''
    return f'{parsed.scheme}://{parsed.netloc}/{quote_plus(db_name)}{suffix}'


def _build_postgres_runtime_config(
    manifest: Mapping[str, Any],
    *,
    simulation_db: str,
) -> PostgresRuntimeConfig:
    postgres = _as_mapping(manifest.get('postgres'))
    admin_dsn = _as_text(postgres.get('admin_dsn'))
    if not admin_dsn:
        raise SystemExit('manifest.postgres.admin_dsn is required')

    simulation_dsn = _as_text(postgres.get('simulation_dsn'))
    simulation_template = _as_text(postgres.get('simulation_dsn_template'))
    if simulation_dsn is None and simulation_template is not None:
        simulation_dsn = simulation_template.replace('{db}', simulation_db)
    if simulation_dsn is None:
        simulation_dsn = _derive_simulation_dsn(admin_dsn, simulation_db)

    migrations_command = (
        _as_text(postgres.get('migrations_command'))
        or 'uv run --frozen alembic upgrade head'
    )
    return PostgresRuntimeConfig(
        admin_dsn=admin_dsn,
        simulation_dsn=simulation_dsn,
        simulation_db=simulation_db,
        migrations_command=migrations_command,
    )


def _merge_topics(
    base: Mapping[str, str],
    override: Mapping[str, Any],
) -> dict[str, str]:
    merged = {key: str(value) for key, value in base.items()}
    for key, value in override.items():
        text = _as_text(value)
        if not text:
            continue
        merged[str(key)] = text
    return merged


def _build_resources(run_id: str, manifest: Mapping[str, Any]) -> SimulationResources:
    run_token = _normalize_run_token(run_id)
    dataset_id = _as_text(manifest.get('dataset_id'))
    if not dataset_id:
        raise SystemExit('manifest.dataset_id is required')

    runtime = _as_mapping(manifest.get('runtime'))
    output_root_raw = _as_text(runtime.get('output_root'))
    output_root = Path(output_root_raw) if output_root_raw else DEFAULT_OUTPUT_ROOT

    source_topics = _merge_topics(
        PRODUCTION_TOPIC_BY_ROLE,
        _as_mapping(manifest.get('source_topics')),
    )
    simulation_topics = _merge_topics(
        SIMULATION_TOPIC_BY_ROLE,
        _as_mapping(manifest.get('simulation_topics')),
    )

    replay_topic_by_source_topic = {
        source_topics['trades']: simulation_topics['trades'],
        source_topics['quotes']: simulation_topics['quotes'],
        source_topics['bars']: simulation_topics['bars'],
        source_topics['status']: simulation_topics['status'],
    }

    clickhouse_cfg = _as_mapping(manifest.get('clickhouse'))
    clickhouse_db = (
        _as_text(clickhouse_cfg.get('simulation_database'))
        or f'torghut_sim_{run_token}'
    )
    clickhouse_signal_table = f'{clickhouse_db}.ta_signals'
    clickhouse_price_table = f'{clickhouse_db}.ta_microbars'

    return SimulationResources(
        run_id=run_id,
        run_token=run_token,
        dataset_id=dataset_id,
        namespace=_as_text(runtime.get('namespace')) or DEFAULT_NAMESPACE,
        ta_configmap=_as_text(runtime.get('ta_configmap')) or DEFAULT_TA_CONFIGMAP,
        ta_deployment=_as_text(runtime.get('ta_deployment')) or DEFAULT_TA_DEPLOYMENT,
        torghut_service=_as_text(runtime.get('torghut_service')) or DEFAULT_TORGHUT_SERVICE,
        output_root=output_root,
        source_topic_by_role=source_topics,
        simulation_topic_by_role=simulation_topics,
        replay_topic_by_source_topic=replay_topic_by_source_topic,
        ta_group_id=f'torghut-ta-sim-{run_token}',
        order_feed_group_id=f'torghut-order-feed-sim-{run_token}',
        clickhouse_db=clickhouse_db,
        clickhouse_signal_table=clickhouse_signal_table,
        clickhouse_price_table=clickhouse_price_table,
    )


def _ensure_supported_binary(name: str) -> None:
    if shutil.which(name) is None:
        raise SystemExit(f'{name} not found in PATH')


def _run_command(
    args: Sequence[str],
    *,
    cwd: Path | None = None,
    env: Mapping[str, str] | None = None,
    input_text: str | None = None,
) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            list(args),
            check=True,
            text=True,
            capture_output=True,
            cwd=str(cwd) if cwd is not None else None,
            env=dict(env) if env is not None else None,
            input=input_text,
        )
    except subprocess.CalledProcessError as exc:
        stdout = (exc.stdout or '').strip()
        stderr = (exc.stderr or '').strip()
        detail = stderr or stdout or str(exc)
        raise RuntimeError(f'command_failed: {" ".join(args)}: {detail}') from exc


def _kubectl_json(namespace: str, args: Sequence[str]) -> dict[str, Any]:
    result = _run_command(['kubectl', '-n', namespace, *args])
    payload = json.loads(result.stdout)
    if not isinstance(payload, Mapping):
        raise RuntimeError('kubectl did not return a mapping payload')
    return {str(key): value for key, value in cast(Mapping[str, Any], payload).items()}


def _kubectl_patch(namespace: str, kind: str, name: str, patch: Mapping[str, Any]) -> None:
    _run_command(
        [
            'kubectl',
            '-n',
            namespace,
            'patch',
            kind,
            name,
            '--type',
            'merge',
            '-p',
            json.dumps(dict(patch), separators=(',', ':')),
        ]
    )


def _kservice_env(service: Mapping[str, Any]) -> tuple[str, list[dict[str, Any]]]:
    spec = _as_mapping(service.get('spec'))
    template = _as_mapping(spec.get('template'))
    template_spec = _as_mapping(template.get('spec'))
    containers = template_spec.get('containers')
    if not isinstance(containers, list) or not containers:
        raise RuntimeError('kservice container spec missing')
    first = containers[0]
    if not isinstance(first, Mapping):
        raise RuntimeError('kservice container spec invalid')
    container = _as_mapping(first)
    container_name = _as_text(container.get('name')) or 'user-container'
    env_raw = container.get('env')
    env: list[dict[str, Any]] = []
    if isinstance(env_raw, list):
        for item in env_raw:
            if isinstance(item, Mapping):
                env.append(_as_mapping(item))
    return container_name, env


def _merge_env_entries(
    env: list[dict[str, Any]],
    updates: Mapping[str, Any],
) -> list[dict[str, Any]]:
    merged = [dict(item) for item in env]
    index_by_name = {
        _as_text(item.get('name')): idx
        for idx, item in enumerate(merged)
        if _as_text(item.get('name'))
    }
    for key, raw_value in updates.items():
        if raw_value is None:
            existing_idx = index_by_name.get(key)
            if existing_idx is not None:
                merged.pop(existing_idx)
                index_by_name = {
                    _as_text(item.get('name')): idx
                    for idx, item in enumerate(merged)
                    if _as_text(item.get('name'))
                }
            continue
        if isinstance(raw_value, Mapping):
            entry = {'name': key, **_as_mapping(raw_value)}
        else:
            entry = {'name': key, 'value': str(raw_value)}
        existing_idx = index_by_name.get(key)
        if existing_idx is None:
            merged.append(entry)
            index_by_name[key] = len(merged) - 1
        else:
            merged[existing_idx] = entry
    return merged


def _state_paths(resources: SimulationResources) -> tuple[Path, Path, Path]:
    run_dir = resources.output_root / resources.run_token
    state_path = run_dir / 'state.json'
    run_manifest_path = run_dir / 'run-manifest.json'
    dump_path = run_dir / 'source-dump.ndjson'
    return state_path, run_manifest_path, dump_path


def _ensure_directory(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)


def _save_json(path: Path, payload: Mapping[str, Any]) -> None:
    _ensure_directory(path)
    path.write_text(json.dumps(dict(payload), indent=2, sort_keys=True), encoding='utf-8')


def _load_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        raise SystemExit(f'expected file is missing: {path}')
    payload = json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(payload, Mapping):
        raise SystemExit(f'file must contain a JSON object: {path}')
    return {str(key): value for key, value in cast(Mapping[str, Any], payload).items()}


def _build_plan_report(
    *,
    resources: SimulationResources,
    kafka_config: KafkaRuntimeConfig,
    clickhouse_config: ClickHouseRuntimeConfig,
    postgres_config: PostgresRuntimeConfig,
    manifest: Mapping[str, Any],
) -> dict[str, Any]:
    state_path, run_manifest_path, dump_path = _state_paths(resources)
    window = _as_mapping(manifest.get('window'))
    return {
        'status': 'ok',
        'run_id': resources.run_id,
        'dataset_id': resources.dataset_id,
        'resources': {
            'namespace': resources.namespace,
            'ta_configmap': resources.ta_configmap,
            'ta_deployment': resources.ta_deployment,
            'torghut_service': resources.torghut_service,
            'source_topics': resources.source_topic_by_role,
            'simulation_topics': resources.simulation_topic_by_role,
            'replay_topic_by_source_topic': resources.replay_topic_by_source_topic,
            'ta_group_id': resources.ta_group_id,
            'order_feed_group_id': resources.order_feed_group_id,
            'clickhouse_database': resources.clickhouse_db,
            'clickhouse_signal_table': resources.clickhouse_signal_table,
            'clickhouse_price_table': resources.clickhouse_price_table,
            'postgres_database': postgres_config.simulation_db,
            'postgres_simulation_dsn': postgres_config.simulation_dsn,
        },
        'window': {
            'start': _as_text(window.get('start')),
            'end': _as_text(window.get('end')),
        },
        'kafka': {
            'bootstrap_servers': kafka_config.bootstrap_servers,
            'security_protocol': kafka_config.security_protocol,
        },
        'clickhouse': {
            'http_url': clickhouse_config.http_url,
            'username': clickhouse_config.username,
        },
        'artifacts': {
            'state_path': str(state_path),
            'run_manifest_path': str(run_manifest_path),
            'dump_path': str(dump_path),
        },
        'confirmation_phrase': APPLY_CONFIRMATION_PHRASE,
    }


def _http_clickhouse_query(
    *,
    config: ClickHouseRuntimeConfig,
    query: str,
) -> tuple[int, str]:
    query_param = quote_plus(query)
    request_url = f'{config.http_url}/?query={query_param}'
    parsed = urlsplit(request_url)
    scheme = parsed.scheme.lower()
    if scheme not in {'http', 'https'}:
        raise RuntimeError(f'unsupported_clickhouse_scheme:{scheme or "missing"}')
    if not parsed.hostname:
        raise RuntimeError('invalid_clickhouse_host')

    headers = {'Content-Type': 'text/plain'}
    if config.username:
        headers['X-ClickHouse-User'] = config.username
    if config.password:
        headers['X-ClickHouse-Key'] = config.password

    path = parsed.path or '/'
    if parsed.query:
        path = f'{path}?{parsed.query}'
    connection_class = HTTPSConnection if scheme == 'https' else HTTPConnection
    connection = connection_class(parsed.hostname, parsed.port)
    try:
        connection.request('GET', path, headers=headers)
        response = connection.getresponse()
        body = response.read().decode('utf-8', errors='replace').strip()
        return response.status, body
    finally:
        connection.close()


def _ensure_clickhouse_database(
    *,
    config: ClickHouseRuntimeConfig,
    database: str,
) -> None:
    if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', database):
        raise RuntimeError(f'invalid_clickhouse_database_name:{database}')
    create_query = f'CREATE DATABASE IF NOT EXISTS {database}'
    status, body = _http_clickhouse_query(config=config, query=create_query)
    if status < 200 or status >= 300:
        raise RuntimeError(f'clickhouse_create_database_failed:{status}:{body[:200]}')


def _ensure_postgres_database(config: PostgresRuntimeConfig) -> None:
    with psycopg.connect(config.admin_dsn, autocommit=True) as conn:
        with conn.cursor() as cursor:
            cursor.execute('SELECT 1 FROM pg_database WHERE datname = %s', (config.simulation_db,))
            exists = cursor.fetchone() is not None
            if not exists:
                cursor.execute(
                    sql.SQL('CREATE DATABASE {}').format(
                        sql.Identifier(config.simulation_db)
                    )
                )


def _run_migrations(config: PostgresRuntimeConfig) -> None:
    repo_root = Path(__file__).resolve().parents[1]
    env = dict(os.environ)
    env['DB_DSN'] = config.simulation_dsn
    _run_command(
        shlex.split(config.migrations_command),
        cwd=repo_root,
        env=env,
    )


def _capture_cluster_state(resources: SimulationResources) -> dict[str, Any]:
    ta_config = _kubectl_json(
        resources.namespace,
        ['get', 'configmap', resources.ta_configmap, '-o', 'json'],
    )
    ta_data = _as_mapping(ta_config.get('data'))

    ta_deployment = _kubectl_json(
        resources.namespace,
        ['get', 'flinkdeployment', resources.ta_deployment, '-o', 'json'],
    )
    deployment_spec = _as_mapping(ta_deployment.get('spec'))
    deployment_job = _as_mapping(deployment_spec.get('job'))

    service = _kubectl_json(
        resources.namespace,
        ['get', 'kservice', resources.torghut_service, '-o', 'json'],
    )
    _container_name, env_entries = _kservice_env(service)
    env_by_name = {
        _as_text(entry.get('name')): entry
        for entry in env_entries
        if _as_text(entry.get('name'))
    }

    return {
        'captured_at': datetime.now(timezone.utc).isoformat(),
        'ta_data': ta_data,
        'ta_restart_nonce': int(deployment_spec.get('restartNonce') or 0),
        'ta_job_state': _as_text(deployment_job.get('state')),
        'torghut_env_snapshot': {
            key: env_by_name.get(key)
            for key in TORGHUT_ENV_KEYS
        },
    }


def _replace_clickhouse_jdbc_database(raw_url: str, new_database: str) -> str:
    match = re.match(r'^(jdbc:clickhouse://[^/]+/)([^?]+)(.*)$', raw_url.strip())
    if match is None:
        raise RuntimeError(f'invalid_clickhouse_jdbc_url:{raw_url}')
    return f'{match.group(1)}{new_database}{match.group(3)}'


def _configure_ta_for_simulation(
    *,
    resources: SimulationResources,
    ta_data: Mapping[str, Any],
    clickhouse_database: str,
    auto_offset_reset: str,
) -> None:
    updates: dict[str, str] = {
        'TA_GROUP_ID': resources.ta_group_id,
        'TA_AUTO_OFFSET_RESET': auto_offset_reset,
    }

    for role, key in TA_TOPIC_KEY_BY_ROLE.items():
        topic = resources.simulation_topic_by_role.get(role)
        if not topic:
            continue
        updates[key] = topic

    existing_jdbc = _as_text(ta_data.get('TA_CLICKHOUSE_URL'))
    if existing_jdbc:
        updates['TA_CLICKHOUSE_URL'] = _replace_clickhouse_jdbc_database(
            existing_jdbc,
            clickhouse_database,
        )

    _kubectl_patch(
        resources.namespace,
        'configmap',
        resources.ta_configmap,
        {'data': updates},
    )


def _restart_ta_deployment(resources: SimulationResources, *, desired_state: str) -> int:
    deployment = _kubectl_json(
        resources.namespace,
        ['get', 'flinkdeployment', resources.ta_deployment, '-o', 'json'],
    )
    spec = _as_mapping(deployment.get('spec'))
    current_state = _as_text(_as_mapping(spec.get('job')).get('state')) or 'running'
    restart_nonce = int(spec.get('restartNonce') or 0)

    if current_state != 'suspended':
        _kubectl_patch(
            resources.namespace,
            'flinkdeployment',
            resources.ta_deployment,
            {'spec': {'job': {'state': 'suspended'}}},
        )
    next_nonce = restart_nonce + 1
    _kubectl_patch(
        resources.namespace,
        'flinkdeployment',
        resources.ta_deployment,
        {
            'spec': {
                'restartNonce': next_nonce,
                'job': {'state': desired_state},
            }
        },
    )
    return next_nonce


def _configure_torghut_service_for_simulation(
    *,
    resources: SimulationResources,
    postgres_config: PostgresRuntimeConfig,
    kafka_config: KafkaRuntimeConfig,
) -> None:
    service = _kubectl_json(
        resources.namespace,
        ['get', 'kservice', resources.torghut_service, '-o', 'json'],
    )
    container_name, current_env = _kservice_env(service)

    updates = {
        'DB_DSN': postgres_config.simulation_dsn,
        'TRADING_MODE': 'paper',
        'TRADING_LIVE_ENABLED': 'false',
        'TRADING_FEATURE_FLAGS_ENABLED': 'false',
        'TRADING_SIGNAL_TABLE': resources.clickhouse_signal_table,
        'TRADING_PRICE_TABLE': resources.clickhouse_price_table,
        'TRADING_ORDER_FEED_ENABLED': 'true',
        'TRADING_ORDER_FEED_BOOTSTRAP_SERVERS': kafka_config.bootstrap_servers,
        'TRADING_ORDER_FEED_TOPIC': resources.simulation_topic_by_role['order_updates'],
        'TRADING_ORDER_FEED_TOPIC_V2': '',
        'TRADING_ORDER_FEED_GROUP_ID': resources.order_feed_group_id,
        'TRADING_EXECUTION_ADAPTER': 'simulation',
        'TRADING_EXECUTION_FALLBACK_ADAPTER': 'none',
        'TRADING_SIMULATION_ENABLED': 'true',
        'TRADING_SIMULATION_RUN_ID': resources.run_id,
        'TRADING_SIMULATION_DATASET_ID': resources.dataset_id,
        'TRADING_SIMULATION_ORDER_UPDATES_TOPIC': resources.simulation_topic_by_role['order_updates'],
        'TRADING_SIMULATION_ORDER_UPDATES_BOOTSTRAP_SERVERS': kafka_config.bootstrap_servers,
    }
    merged_env = _merge_env_entries(current_env, updates)
    _kubectl_patch(
        resources.namespace,
        'kservice',
        resources.torghut_service,
        {
            'spec': {
                'template': {
                    'spec': {
                        'containers': [
                            {
                                'name': container_name,
                                'env': merged_env,
                            }
                        ]
                    }
                }
            }
        },
    )


def _restore_ta_configuration(resources: SimulationResources, state: Mapping[str, Any]) -> None:
    ta_data = _as_mapping(state.get('ta_data'))
    _kubectl_patch(
        resources.namespace,
        'configmap',
        resources.ta_configmap,
        {'data': ta_data},
    )


def _restore_torghut_env(resources: SimulationResources, state: Mapping[str, Any]) -> None:
    service = _kubectl_json(
        resources.namespace,
        ['get', 'kservice', resources.torghut_service, '-o', 'json'],
    )
    container_name, current_env = _kservice_env(service)
    snapshot = _as_mapping(state.get('torghut_env_snapshot'))
    merged = list(current_env)
    for key in TORGHUT_ENV_KEYS:
        snapshot_entry = snapshot.get(key)
        if snapshot_entry is None:
            merged = _merge_env_entries(merged, {key: None})
            continue
        entry_map = _as_mapping(snapshot_entry)
        entry_map.pop('name', None)
        merged = _merge_env_entries(merged, {key: entry_map})

    _kubectl_patch(
        resources.namespace,
        'kservice',
        resources.torghut_service,
        {
            'spec': {
                'template': {
                    'spec': {
                        'containers': [
                            {
                                'name': container_name,
                                'env': merged,
                            }
                        ]
                    }
                }
            }
        },
    )


def _kafka_admin_client(config: KafkaRuntimeConfig) -> Any:
    from kafka.admin import KafkaAdminClient  # type: ignore[import-not-found]

    kwargs = config.kafka_client_kwargs()
    kwargs['client_id'] = f'torghut-sim-admin-{int(time.time())}'
    return KafkaAdminClient(**kwargs)


def _source_topic_partition_counts(admin: Any, topics: Sequence[str]) -> dict[str, int]:
    counts: dict[str, int] = {}
    topic_descriptions = admin.describe_topics(list(topics))
    if not isinstance(topic_descriptions, list):
        return counts
    for item in topic_descriptions:
        if not isinstance(item, Mapping):
            continue
        topic = _as_text(item.get('topic'))
        partitions = item.get('partitions')
        if topic is None or not isinstance(partitions, list):
            continue
        counts[topic] = len(partitions)
    return counts


def _ensure_topics(
    *,
    resources: SimulationResources,
    config: KafkaRuntimeConfig,
    manifest: Mapping[str, Any],
) -> dict[str, Any]:
    from kafka.admin import NewTopic  # type: ignore[import-not-found]

    kafka = _as_mapping(manifest.get('kafka'))
    default_partitions = int(kafka.get('default_partitions') or 6)
    replication_factor = int(kafka.get('replication_factor') or 1)

    admin = _kafka_admin_client(config)
    try:
        existing_topics = set(admin.list_topics())
        source_topics = list(resources.replay_topic_by_source_topic.keys())
        source_partition_counts = _source_topic_partition_counts(admin, source_topics)

        planned_topics = set(resources.simulation_topic_by_role.values())
        new_topics: list[Any] = []
        for topic in sorted(planned_topics):
            if topic in existing_topics:
                continue
            partitions = default_partitions
            for source_topic, replay_topic in resources.replay_topic_by_source_topic.items():
                if replay_topic == topic:
                    partitions = source_partition_counts.get(source_topic, default_partitions)
                    break
            new_topics.append(
                NewTopic(
                    name=topic,
                    num_partitions=max(partitions, 1),
                    replication_factor=max(replication_factor, 1),
                )
            )

        if new_topics:
            admin.create_topics(new_topics=new_topics, validate_only=False)
        return {
            'existing': sorted(existing_topics),
            'created': [topic.name for topic in new_topics],
        }
    finally:
        admin.close()


def _consumer_for_dump(config: KafkaRuntimeConfig, run_token: str) -> Any:
    from kafka import KafkaConsumer  # type: ignore[import-not-found]

    kwargs = config.kafka_client_kwargs()
    kwargs.update(
        {
            'client_id': f'torghut-sim-dump-{run_token}',
            'enable_auto_commit': False,
            'auto_offset_reset': 'earliest',
            'consumer_timeout_ms': 1000,
            'value_deserializer': None,
            'key_deserializer': None,
        }
    )
    return KafkaConsumer(**kwargs)


def _producer_for_replay(config: KafkaRuntimeConfig, run_token: str) -> Any:
    from kafka import KafkaProducer  # type: ignore[import-not-found]

    kwargs = config.kafka_client_kwargs()
    kwargs.update(
        {
            'client_id': f'torghut-sim-replay-{run_token}',
            'acks': 'all',
            'retries': 3,
            'linger_ms': 5,
            'value_serializer': None,
            'key_serializer': None,
        }
    )
    return KafkaProducer(**kwargs)


def _bytes_to_b64(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, bytes):
        return base64.b64encode(value).decode('ascii')
    if isinstance(value, bytearray):
        return base64.b64encode(bytes(value)).decode('ascii')
    return base64.b64encode(str(value).encode('utf-8')).decode('ascii')


def _b64_to_bytes(value: Any) -> bytes | None:
    if value is None:
        return None
    return base64.b64decode(str(value).encode('ascii'))


def _headers_to_json(value: Any) -> list[list[str | None]]:
    if not isinstance(value, list):
        return []
    headers: list[list[str | None]] = []
    for item in value:
        if not isinstance(item, tuple) or len(item) != 2:
            continue
        key = _as_text(item[0])
        if key is None:
            continue
        encoded = _bytes_to_b64(item[1])
        headers.append([key, encoded])
    return headers


def _json_to_headers(value: Any) -> list[tuple[str, bytes]]:
    if not isinstance(value, list):
        return []
    headers: list[tuple[str, bytes]] = []
    for item in value:
        if not isinstance(item, list) or len(item) != 2:
            continue
        key = _as_text(item[0])
        payload_b64 = item[1]
        if key is None or payload_b64 is None:
            continue
        headers.append((key, _b64_to_bytes(payload_b64) or b''))
    return headers


def _offset_for_time_lookup(*, metadata: Any, fallback: int) -> int:
    if metadata is None:
        return fallback
    raw_offset = getattr(metadata, 'offset', None)
    try:
        offset = int(raw_offset)
    except (TypeError, ValueError):
        return fallback
    if offset < 0:
        return fallback
    return offset


def _dump_topics(
    *,
    resources: SimulationResources,
    kafka_config: KafkaRuntimeConfig,
    manifest: Mapping[str, Any],
    dump_path: Path,
    force: bool,
) -> dict[str, Any]:
    if dump_path.exists() and not force:
        checksum = hashlib.sha256(dump_path.read_bytes()).hexdigest()
        return {
            'path': str(dump_path),
            'records': _count_lines(dump_path),
            'sha256': checksum,
            'reused_existing_dump': True,
        }

    window = _as_mapping(manifest.get('window'))
    start = _parse_rfc3339_timestamp(_as_text(window.get('start')), label='window.start')
    end = _parse_rfc3339_timestamp(_as_text(window.get('end')), label='window.end')
    if end <= start:
        raise RuntimeError('window.end must be after window.start')

    start_ms = int(start.timestamp() * 1000)
    end_ms = int(end.timestamp() * 1000)

    from kafka import TopicPartition  # type: ignore[import-not-found]

    consumer = _consumer_for_dump(kafka_config, resources.run_token)
    hasher = hashlib.sha256()
    count = 0
    count_by_topic: dict[str, int] = {}
    try:
        topic_partitions: list[Any] = []
        for topic in resources.replay_topic_by_source_topic.keys():
            partitions = consumer.partitions_for_topic(topic)
            if not partitions:
                raise RuntimeError(f'source topic has no partitions or does not exist: {topic}')
            for partition in sorted(partitions):
                topic_partitions.append(TopicPartition(topic, int(partition)))

        consumer.assign(topic_partitions)
        beginning_offsets = consumer.beginning_offsets(topic_partitions)
        end_offsets = consumer.end_offsets(topic_partitions)
        start_offsets_raw = consumer.offsets_for_times(
            {tp: start_ms for tp in topic_partitions}
        )
        stop_offsets_raw = consumer.offsets_for_times(
            {tp: end_ms + 1 for tp in topic_partitions}
        )

        start_offsets: dict[Any, int] = {}
        stop_offsets: dict[Any, int] = {}
        for tp in topic_partitions:
            start_meta = start_offsets_raw.get(tp)
            stop_meta = stop_offsets_raw.get(tp)
            partition_beginning = int(beginning_offsets[tp])
            partition_end = int(end_offsets[tp])
            start_offset = _offset_for_time_lookup(
                metadata=start_meta,
                fallback=partition_end,
            )
            stop_offset = _offset_for_time_lookup(
                metadata=stop_meta,
                fallback=partition_end,
            )
            start_offsets[tp] = min(max(start_offset, partition_beginning), partition_end)
            stop_offsets[tp] = min(max(stop_offset, start_offsets[tp]), partition_end)
            consumer.seek(tp, start_offsets[tp])

        _ensure_directory(dump_path)
        done: set[Any] = set()
        with dump_path.open('w', encoding='utf-8') as handle:
            idle_polls = 0
            while len(done) < len(topic_partitions):
                polled = consumer.poll(timeout_ms=1000, max_records=2000)
                if not polled:
                    idle_polls += 1
                    for tp in topic_partitions:
                        if tp in done:
                            continue
                        if consumer.position(tp) >= stop_offsets[tp]:
                            done.add(tp)
                    if idle_polls > 4 and all(
                        consumer.position(tp) >= stop_offsets[tp]
                        for tp in topic_partitions
                    ):
                        break
                    continue

                idle_polls = 0
                for tp, records in polled.items():
                    stop_offset = stop_offsets.get(tp)
                    if stop_offset is None:
                        continue
                    for record in records:
                        if int(record.offset) >= stop_offset:
                            done.add(tp)
                            break
                        source_topic = str(record.topic)
                        replay_topic = resources.replay_topic_by_source_topic[source_topic]
                        line_payload = {
                            'source_topic': source_topic,
                            'source_partition': int(record.partition),
                            'source_offset': int(record.offset),
                            'source_timestamp_ms': int(record.timestamp),
                            'dataset_event_id': f'{source_topic}:{record.partition}:{record.offset}',
                            'replay_topic': replay_topic,
                            'key_b64': _bytes_to_b64(record.key),
                            'value_b64': _bytes_to_b64(record.value),
                            'headers': _headers_to_json(getattr(record, 'headers', [])),
                        }
                        line = json.dumps(line_payload, sort_keys=True)
                        handle.write(line)
                        handle.write('\n')
                        hasher.update(line.encode('utf-8'))
                        hasher.update(b'\n')
                        count += 1
                        count_by_topic[source_topic] = count_by_topic.get(source_topic, 0) + 1
                    if consumer.position(tp) >= stop_offset:
                        done.add(tp)

        return {
            'path': str(dump_path),
            'records': count,
            'sha256': hasher.hexdigest(),
            'records_by_topic': count_by_topic,
            'start': start.isoformat(),
            'end': end.isoformat(),
            'reused_existing_dump': False,
        }
    finally:
        consumer.close()


def _pacing_delay_seconds(
    *,
    mode: str,
    previous_timestamp_ms: int | None,
    current_timestamp_ms: int | None,
    acceleration: float,
) -> float:
    if mode == 'max_throughput':
        return 0.0
    if previous_timestamp_ms is None or current_timestamp_ms is None:
        return 0.0
    delta_ms = current_timestamp_ms - previous_timestamp_ms
    if delta_ms <= 0:
        return 0.0
    if mode == 'event_time':
        return delta_ms / 1000.0
    if mode == 'accelerated':
        return (delta_ms / 1000.0) / max(acceleration, 0.0001)
    raise RuntimeError(f'unsupported replay pace mode: {mode}')


def _count_lines(path: Path) -> int:
    if not path.exists():
        return 0
    with path.open('r', encoding='utf-8') as handle:
        return sum(1 for _ in handle)


def _dump_sha256_for_replay(path: Path) -> str:
    hasher = hashlib.sha256()
    with path.open('r', encoding='utf-8') as handle:
        for line in handle:
            stripped = line.strip()
            if not stripped:
                continue
            hasher.update(stripped.encode('utf-8'))
            hasher.update(b'\n')
    return hasher.hexdigest()


def _replay_dump(
    *,
    resources: SimulationResources,
    kafka_config: KafkaRuntimeConfig,
    manifest: Mapping[str, Any],
    dump_path: Path,
    force: bool,
) -> dict[str, Any]:
    if not dump_path.exists():
        raise RuntimeError(f'dump file does not exist: {dump_path}')

    marker_path = dump_path.with_suffix('.replay-marker.json')
    if marker_path.exists() and not force:
        marker_payload = _load_json(marker_path)
        marker_dump_sha = _as_text(marker_payload.get('dump_sha256'))
        current_dump_sha = _dump_sha256_for_replay(dump_path)
        if marker_dump_sha == current_dump_sha:
            marker_payload['reused_existing_replay'] = True
            return marker_payload

    replay_cfg = _as_mapping(manifest.get('replay'))
    pace_mode = (_as_text(replay_cfg.get('pace_mode')) or 'max_throughput').lower()
    acceleration = float(replay_cfg.get('acceleration') or 60.0)
    max_sleep_seconds = float(replay_cfg.get('max_sleep_seconds') or 5.0)

    producer = _producer_for_replay(kafka_config, resources.run_token)
    count = 0
    count_by_topic: dict[str, int] = {}
    previous_ts_ms: int | None = None
    checksum = hashlib.sha256()
    try:
        with dump_path.open('r', encoding='utf-8') as handle:
            for line in handle:
                stripped = line.strip()
                if not stripped:
                    continue
                checksum.update(stripped.encode('utf-8'))
                checksum.update(b'\n')

                payload = json.loads(stripped)
                if not isinstance(payload, Mapping):
                    continue
                row = _as_mapping(payload)
                source_topic = _as_text(row.get('source_topic'))
                replay_topic = _as_text(row.get('replay_topic'))
                if replay_topic is None and source_topic is not None:
                    replay_topic = resources.replay_topic_by_source_topic.get(source_topic)
                if replay_topic is None:
                    raise RuntimeError('dump row is missing replay_topic and cannot infer mapping')

                current_ts_ms = cast(int | None, row.get('source_timestamp_ms'))
                delay = _pacing_delay_seconds(
                    mode=pace_mode,
                    previous_timestamp_ms=previous_ts_ms,
                    current_timestamp_ms=current_ts_ms,
                    acceleration=acceleration,
                )
                if delay > 0:
                    time.sleep(min(delay, max_sleep_seconds))

                key = _b64_to_bytes(row.get('key_b64'))
                value = _b64_to_bytes(row.get('value_b64'))
                headers = _json_to_headers(row.get('headers'))
                producer.send(
                    replay_topic,
                    key=key,
                    value=value,
                    headers=headers,
                    timestamp_ms=current_ts_ms,
                )
                count += 1
                count_by_topic[replay_topic] = count_by_topic.get(replay_topic, 0) + 1
                previous_ts_ms = current_ts_ms
                if count % 1000 == 0:
                    producer.flush(timeout=5)
        producer.flush(timeout=30)
    finally:
        producer.close(timeout=10)

    marker_payload = {
        'reused_existing_replay': False,
        'records': count,
        'records_by_topic': count_by_topic,
        'pace_mode': pace_mode,
        'acceleration': acceleration,
        'dump_sha256': checksum.hexdigest(),
        'completed_at': datetime.now(timezone.utc).isoformat(),
    }
    _save_json(marker_path, marker_payload)
    return marker_payload


def _verify_isolation_guards(
    *,
    resources: SimulationResources,
    postgres_config: PostgresRuntimeConfig,
    ta_data: Mapping[str, Any],
) -> dict[str, bool]:
    checks = {
        'clickhouse_db_isolated': resources.clickhouse_db != 'torghut',
        'postgres_db_isolated': postgres_config.simulation_db != 'torghut',
        'order_updates_topic_isolated': resources.simulation_topic_by_role['order_updates']
        != PRODUCTION_TOPIC_BY_ROLE['order_updates'],
        'ta_group_isolated': resources.ta_group_id != _as_text(ta_data.get('TA_GROUP_ID')),
    }
    if not all(checks.values()):
        failed = [key for key, passed in checks.items() if not passed]
        raise RuntimeError(f'isolation_guard_failed:{",".join(failed)}')
    return checks


def _apply(
    *,
    resources: SimulationResources,
    manifest: Mapping[str, Any],
    kafka_config: KafkaRuntimeConfig,
    clickhouse_config: ClickHouseRuntimeConfig,
    postgres_config: PostgresRuntimeConfig,
    force_dump: bool,
    force_replay: bool,
) -> dict[str, Any]:
    _ensure_supported_binary('kubectl')

    state_path, run_manifest_path, dump_path = _state_paths(resources)
    _ensure_directory(state_path)

    if state_path.exists():
        state = _load_json(state_path)
    else:
        state = _capture_cluster_state(resources)
        _save_json(state_path, state)

    ta_data = _as_mapping(state.get('ta_data'))
    _verify_isolation_guards(
        resources=resources,
        postgres_config=postgres_config,
        ta_data=ta_data,
    )

    topics_report = _ensure_topics(
        resources=resources,
        config=kafka_config,
        manifest=manifest,
    )
    _ensure_clickhouse_database(config=clickhouse_config, database=resources.clickhouse_db)
    _ensure_postgres_database(postgres_config)
    _run_migrations(postgres_config)

    dump_report = _dump_topics(
        resources=resources,
        kafka_config=kafka_config,
        manifest=manifest,
        dump_path=dump_path,
        force=force_dump,
    )
    replay_report = _replay_dump(
        resources=resources,
        kafka_config=kafka_config,
        manifest=manifest,
        dump_path=dump_path,
        force=force_replay,
    )

    replay_cfg = _as_mapping(manifest.get('replay'))
    auto_offset_reset = (_as_text(replay_cfg.get('auto_offset_reset')) or 'earliest').lower()
    _configure_ta_for_simulation(
        resources=resources,
        ta_data=ta_data,
        clickhouse_database=resources.clickhouse_db,
        auto_offset_reset=auto_offset_reset,
    )
    ta_restart_nonce = _restart_ta_deployment(resources, desired_state='running')

    _configure_torghut_service_for_simulation(
        resources=resources,
        postgres_config=postgres_config,
        kafka_config=kafka_config,
    )

    report = {
        'status': 'ok',
        'mode': 'apply',
        'run_id': resources.run_id,
        'dataset_id': resources.dataset_id,
        'applied_at': datetime.now(timezone.utc).isoformat(),
        'state_path': str(state_path),
        'dump': dump_report,
        'replay': replay_report,
        'topics': topics_report,
        'ta_restart_nonce': ta_restart_nonce,
        'resources': asdict(resources)
        | {
            'output_root': str(resources.output_root),
        },
        'postgres': {
            'simulation_dsn': postgres_config.simulation_dsn,
            'simulation_db': postgres_config.simulation_db,
        },
        'clickhouse': {
            'http_url': clickhouse_config.http_url,
            'database': resources.clickhouse_db,
        },
    }
    _save_json(run_manifest_path, report)
    return report


def _teardown(
    *,
    resources: SimulationResources,
    allow_missing_state: bool,
) -> dict[str, Any]:
    _ensure_supported_binary('kubectl')
    state_path, run_manifest_path, dump_path = _state_paths(resources)
    if not state_path.exists():
        if allow_missing_state:
            return {
                'status': 'ok',
                'mode': 'teardown',
                'run_id': resources.run_id,
                'teardown_at': datetime.now(timezone.utc).isoformat(),
                'state_found': False,
            }
        raise SystemExit(f'state file not found: {state_path}')

    state = _load_json(state_path)
    _restore_ta_configuration(resources, state)
    _restore_torghut_env(resources, state)

    original_state = _as_text(state.get('ta_job_state')) or 'running'
    ta_restart_nonce = _restart_ta_deployment(resources, desired_state=original_state)
    report = {
        'status': 'ok',
        'mode': 'teardown',
        'run_id': resources.run_id,
        'teardown_at': datetime.now(timezone.utc).isoformat(),
        'state_path': str(state_path),
        'run_manifest_path': str(run_manifest_path),
        'dump_path': str(dump_path),
        'ta_restart_nonce': ta_restart_nonce,
        'restored_ta_state': original_state,
    }
    _save_json(run_manifest_path.with_name('teardown-manifest.json'), report)
    return report


def _render_report(payload: Mapping[str, Any], *, json_only: bool) -> None:
    if json_only:
        print(json.dumps(dict(payload), sort_keys=True, separators=(',', ':')))
        return
    print(json.dumps(dict(payload), indent=2, sort_keys=True))


def main() -> None:
    args = _parse_args()
    manifest_path = Path(args.dataset_manifest)
    manifest = _load_manifest(manifest_path)
    resources = _build_resources(args.run_id, manifest)
    kafka_config = _build_kafka_runtime_config(manifest)
    clickhouse_config = _build_clickhouse_runtime_config(manifest)
    postgres_config = _build_postgres_runtime_config(
        manifest,
        simulation_db=f'torghut_sim_{resources.run_token}',
    )

    plan_report = _build_plan_report(
        resources=resources,
        kafka_config=kafka_config,
        clickhouse_config=clickhouse_config,
        postgres_config=postgres_config,
        manifest=manifest,
    )

    if args.mode == 'plan':
        _render_report(plan_report, json_only=args.json)
        return

    if args.mode == 'apply':
        if args.confirm != APPLY_CONFIRMATION_PHRASE:
            raise SystemExit(
                f'--confirm must equal {APPLY_CONFIRMATION_PHRASE!r} when mode=apply'
            )
        report = _apply(
            resources=resources,
            manifest=manifest,
            kafka_config=kafka_config,
            clickhouse_config=clickhouse_config,
            postgres_config=postgres_config,
            force_dump=bool(args.force_dump),
            force_replay=bool(args.force_replay),
        )
        _render_report(report, json_only=args.json)
        return

    report = _teardown(
        resources=resources,
        allow_missing_state=bool(args.allow_missing_state),
    )
    _render_report(report, json_only=args.json)


if __name__ == '__main__':
    main()
