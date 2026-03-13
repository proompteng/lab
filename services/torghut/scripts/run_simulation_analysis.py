#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import time
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from scripts.historical_simulation_verification import (
    _artifact_bundle,
    _current_activity_report,
    _replace_database_in_dsn,
    _runtime_verify,
    _teardown_clean,
)


@dataclass(frozen=True)
class _Resources:
    run_id: str
    run_token: str
    dataset_id: str
    target_mode: str
    namespace: str
    ta_configmap: str
    ta_deployment: str
    torghut_service: str
    torghut_forecast_service: str
    clickhouse_signal_table: str
    clickhouse_price_table: str
    clickhouse_db: str
    simulation_topic_by_role: dict[str, str]
    order_feed_group_id: str
    ta_group_id: str
    warm_lane_enabled: bool = False


@dataclass(frozen=True)
class _PostgresConfig:
    simulation_dsn: str
    simulation_db: str

    @property
    def torghut_runtime_dsn(self) -> str:
        return self.simulation_dsn


@dataclass(frozen=True)
class _ClickHouseConfig:
    http_url: str
    username: str | None
    password: str | None


def _normalize_run_token(run_id: str) -> str:
    import re

    token = re.sub(r'[^a-zA-Z0-9]+', '_', run_id.strip().lower()).strip('_')
    token = re.sub(r'_+', '_', token)
    if not token:
        raise SystemExit('run-id must contain at least one alphanumeric character')
    return token


def _clickhouse_database_from_table_name(table_name: str) -> str:
    table_name = table_name.strip()
    if not table_name:
        return ''
    database, separator, _table = table_name.partition('.')
    return database.strip() if separator else ''


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description='Run Torghut simulation analysis gates.')
    parser.add_argument('--json', action='store_true', help='Emit compact JSON')

    subparsers = parser.add_subparsers(dest='command', required=True)

    runtime = subparsers.add_parser('runtime-ready')
    runtime.add_argument('--json', action='store_true', help=argparse.SUPPRESS)
    runtime.add_argument('--run-id', required=True)
    runtime.add_argument('--dataset-id', required=True)
    runtime.add_argument('--namespace', required=True)
    runtime.add_argument('--torghut-service', required=True)
    runtime.add_argument('--ta-deployment', required=True)
    runtime.add_argument('--forecast-service', required=True)
    runtime.add_argument('--window-start', required=True)
    runtime.add_argument('--window-end', required=True)
    runtime.add_argument('--signal-table', required=True)
    runtime.add_argument('--price-table', required=True)
    runtime.add_argument('--runtime-timeout-seconds', type=int, default=180)
    runtime.add_argument('--runtime-poll-seconds', type=int, default=5)

    activity = subparsers.add_parser('activity')
    activity.add_argument('--json', action='store_true', help=argparse.SUPPRESS)
    activity.add_argument('--run-id', required=True)
    activity.add_argument('--dataset-id', required=True)
    activity.add_argument('--namespace', required=True)
    activity.add_argument('--torghut-service', required=True)
    activity.add_argument('--ta-deployment', required=True)
    activity.add_argument('--forecast-service', required=True)
    activity.add_argument('--window-start', required=True)
    activity.add_argument('--window-end', required=True)
    activity.add_argument('--signal-table', required=True)
    activity.add_argument('--price-table', required=True)
    activity.add_argument('--postgres-base-dsn', default='')
    activity.add_argument('--postgres-base-dsn-env', default='DB_DSN')
    activity.add_argument('--postgres-database', required=True)
    activity.add_argument('--clickhouse-http-url', required=True)
    activity.add_argument('--clickhouse-username', default='')
    activity.add_argument('--clickhouse-password-env', default='TORGHUT_CLICKHOUSE_PASSWORD')
    activity.add_argument('--monitor-timeout-seconds', type=int, default=900)
    activity.add_argument('--monitor-poll-seconds', type=int, default=15)
    activity.add_argument('--min-trade-decisions', type=int, default=1)
    activity.add_argument('--min-executions', type=int, default=1)
    activity.add_argument('--min-execution-tca-metrics', type=int, default=1)
    activity.add_argument('--min-execution-order-events', type=int, default=0)
    activity.add_argument('--cursor-grace-seconds', type=int, default=120)

    teardown = subparsers.add_parser('teardown-clean')
    teardown.add_argument('--json', action='store_true', help=argparse.SUPPRESS)
    teardown.add_argument('--run-id', required=True)
    teardown.add_argument('--dataset-id', required=True)
    teardown.add_argument('--namespace', required=True)
    teardown.add_argument('--ta-configmap', required=True)
    teardown.add_argument('--ta-deployment', required=True)
    teardown.add_argument('--torghut-service', required=True)
    teardown.add_argument('--forecast-service', required=True)
    teardown.add_argument('--signal-table', required=True)
    teardown.add_argument('--price-table', required=True)
    teardown.add_argument('--postgres-base-dsn', default='')
    teardown.add_argument('--postgres-base-dsn-env', default='DB_DSN')
    teardown.add_argument('--postgres-database', required=True)

    artifact = subparsers.add_parser('artifact-bundle')
    artifact.add_argument('--json', action='store_true', help=argparse.SUPPRESS)
    artifact.add_argument('--run-dir', required=True)

    return parser


def _emit(payload: Mapping[str, Any], *, json_only: bool) -> None:
    if json_only:
        print(json.dumps(dict(payload), sort_keys=True, separators=(',', ':')))
        return
    print(json.dumps(dict(payload), indent=2, sort_keys=True))


def _resources_from_args(args: argparse.Namespace) -> _Resources:
    run_token = _normalize_run_token(args.run_id)
    signal_table = getattr(args, 'signal_table', '')
    price_table = getattr(args, 'price_table', '')
    clickhouse_db = _clickhouse_database_from_table_name(signal_table) or _clickhouse_database_from_table_name(price_table)
    warm_lane_enabled = clickhouse_db == 'torghut_sim_default'
    default_order_updates_topic = 'torghut.sim.trade-updates.v1'
    return _Resources(
        run_id=args.run_id,
        run_token=run_token,
        dataset_id=args.dataset_id,
        target_mode='dedicated_service',
        namespace=args.namespace,
        ta_configmap=getattr(args, 'ta_configmap', 'torghut-ta-sim-config'),
        ta_deployment=args.ta_deployment,
        torghut_service=args.torghut_service,
        torghut_forecast_service=args.forecast_service,
        clickhouse_signal_table=signal_table,
        clickhouse_price_table=price_table,
        clickhouse_db=clickhouse_db,
        simulation_topic_by_role={
            'order_updates': f'{default_order_updates_topic}.{run_token}',
        },
        order_feed_group_id='torghut-order-feed-sim-default' if warm_lane_enabled else f'torghut-order-feed-sim-{run_token}',
        ta_group_id='torghut-ta-sim-default' if warm_lane_enabled else f'torghut-ta-sim-{run_token}',
        warm_lane_enabled=warm_lane_enabled,
    )


def _manifest_from_args(args: argparse.Namespace) -> dict[str, Any]:
    manifest: dict[str, Any] = {}
    window_start = getattr(args, 'window_start', '')
    window_end = getattr(args, 'window_end', '')
    if window_start and window_end:
        manifest['window'] = {
            'start': window_start,
            'end': window_end,
        }
    if hasattr(args, 'monitor_timeout_seconds'):
        manifest['monitor'] = {
            'timeout_seconds': args.monitor_timeout_seconds,
            'poll_seconds': args.monitor_poll_seconds,
            'min_trade_decisions': args.min_trade_decisions,
            'min_executions': args.min_executions,
            'min_execution_tca_metrics': args.min_execution_tca_metrics,
            'min_execution_order_events': args.min_execution_order_events,
            'cursor_grace_seconds': args.cursor_grace_seconds,
        }
    return manifest


def _postgres_config(args: argparse.Namespace) -> _PostgresConfig:
    base_dsn = args.postgres_base_dsn or ''
    if not base_dsn:
        import os

        base_dsn = os.environ.get(args.postgres_base_dsn_env, '')
    if not base_dsn:
        raise SystemExit('postgres base dsn is required')
    return _PostgresConfig(
        simulation_dsn=_replace_database_in_dsn(
            base_dsn,
            database=args.postgres_database,
            label='postgres base dsn',
        ),
        simulation_db=args.postgres_database,
    )


def _clickhouse_config(args: argparse.Namespace) -> _ClickHouseConfig:
    import os

    return _ClickHouseConfig(
        http_url=args.clickhouse_http_url.rstrip('/'),
        username=args.clickhouse_username or None,
        password=os.environ.get(args.clickhouse_password_env),
    )


def _wait_for_runtime_ready(
    *,
    resources: _Resources,
    manifest: Mapping[str, Any],
    timeout_seconds: int,
    poll_seconds: int,
) -> dict[str, Any]:
    if timeout_seconds <= 0:
        raise SystemExit('runtime-timeout-seconds must be > 0')
    if poll_seconds <= 0:
        raise SystemExit('runtime-poll-seconds must be > 0')
    deadline = time.monotonic() + timeout_seconds
    latest_report = _runtime_verify(resources=resources, manifest=manifest)
    while latest_report.get('runtime_state') != 'ready' and time.monotonic() < deadline:
        time.sleep(poll_seconds)
        latest_report = _runtime_verify(resources=resources, manifest=manifest)
    return latest_report


def main() -> None:
    args = _parser().parse_args()
    if args.command == 'artifact-bundle':
        report = _artifact_bundle(run_dir=Path(args.run_dir))
        _emit(report, json_only=bool(args.json))
        if report['status'] != 'ok':
            raise SystemExit(1)
        return

    resources = _resources_from_args(args)
    manifest = _manifest_from_args(args)

    if args.command == 'runtime-ready':
        report = _wait_for_runtime_ready(
            resources=resources,
            manifest=manifest,
            timeout_seconds=args.runtime_timeout_seconds,
            poll_seconds=args.runtime_poll_seconds,
        )
        _emit(report, json_only=bool(args.json))
        if report.get('runtime_state') != 'ready':
            raise SystemExit(1)
        return

    postgres_config = _postgres_config(args)

    if args.command == 'teardown-clean':
        report = _teardown_clean(resources=resources, postgres_config=postgres_config)
        _emit(report, json_only=bool(args.json))
        if report.get('status') != 'ok':
            raise SystemExit(1)
        return

    clickhouse_config = _clickhouse_config(args)
    runtime_verify = _runtime_verify(resources=resources, manifest=manifest)
    report = _current_activity_report(
        resources=resources,
        manifest=manifest,
        postgres_config=postgres_config,
        clickhouse_config=clickhouse_config,
        runtime_verify=runtime_verify,
    )
    _emit(report, json_only=bool(args.json))
    if report.get('status') != 'ok':
        raise SystemExit(1)


if __name__ == '__main__':
    main()
