"""Verify Torghut LEAN multi-lane runtime and data-path health checks.

This script is intended for operational validation in stage/prod clusters.
"""

from __future__ import annotations

import argparse
import http.client
import json
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlparse


SUPPORTED_NAMESPACE = 'torghut'


@dataclass
class CheckResult:
    name: str
    passed: bool
    detail: str


def _http_json(url: str, timeout: int = 5) -> dict[str, Any]:
    parsed = urlparse(url)
    if parsed.scheme not in {'http', 'https'} or not parsed.netloc:
        raise ValueError(f'unsupported URL: {url!r}')

    path = parsed.path or '/'
    if parsed.query:
        path = f'{path}?{parsed.query}'

    connection_cls = http.client.HTTPSConnection if parsed.scheme == 'https' else http.client.HTTPConnection
    connection = connection_cls(parsed.netloc, timeout=timeout)
    try:
        connection.request('GET', path, headers={'accept': 'application/json'})
        response = connection.getresponse()
        raw = response.read().decode('utf-8').strip()
    finally:
        connection.close()

    if not raw:
        return {}
    payload = json.loads(raw)
    if isinstance(payload, dict):
        return payload
    return {}


def _kubectl_get_kafka_topic() -> subprocess.CompletedProcess[str]:
    if Path('/usr/bin/kubectl').exists():
        return subprocess.run(
            ['/usr/bin/kubectl', '-n', 'kafka', 'get', 'kafkatopic', 'torghut.ta.signals.v1'],
            check=False,
            text=True,
            capture_output=True,
        )
    if Path('/usr/local/bin/kubectl').exists():
        return subprocess.run(
            ['/usr/local/bin/kubectl', '-n', 'kafka', 'get', 'kafkatopic', 'torghut.ta.signals.v1'],
            check=False,
            text=True,
            capture_output=True,
        )
    if Path('/opt/homebrew/bin/kubectl').exists():
        return subprocess.run(
            ['/opt/homebrew/bin/kubectl', '-n', 'kafka', 'get', 'kafkatopic', 'torghut.ta.signals.v1'],
            check=False,
            text=True,
            capture_output=True,
        )
    return subprocess.CompletedProcess(args=['kubectl'], returncode=127, stdout='', stderr='kubectl not found')


def _kubectl_get_torghut_flink() -> subprocess.CompletedProcess[str]:
    if Path('/usr/bin/kubectl').exists():
        return subprocess.run(
            ['/usr/bin/kubectl', '-n', 'torghut', 'get', 'flinkdeployment', 'torghut-ta', '-o', 'json'],
            check=False,
            text=True,
            capture_output=True,
        )
    if Path('/usr/local/bin/kubectl').exists():
        return subprocess.run(
            ['/usr/local/bin/kubectl', '-n', 'torghut', 'get', 'flinkdeployment', 'torghut-ta', '-o', 'json'],
            check=False,
            text=True,
            capture_output=True,
        )
    if Path('/opt/homebrew/bin/kubectl').exists():
        return subprocess.run(
            ['/opt/homebrew/bin/kubectl', '-n', 'torghut', 'get', 'flinkdeployment', 'torghut-ta', '-o', 'json'],
            check=False,
            text=True,
            capture_output=True,
        )
    return subprocess.CompletedProcess(args=['kubectl'], returncode=127, stdout='', stderr='kubectl not found')


def _kubectl_get_torghut_clickhouse() -> subprocess.CompletedProcess[str]:
    if Path('/usr/bin/kubectl').exists():
        return subprocess.run(
            ['/usr/bin/kubectl', '-n', 'torghut', 'get', 'clickhouseinstallation', 'torghut-clickhouse'],
            check=False,
            text=True,
            capture_output=True,
        )
    if Path('/usr/local/bin/kubectl').exists():
        return subprocess.run(
            ['/usr/local/bin/kubectl', '-n', 'torghut', 'get', 'clickhouseinstallation', 'torghut-clickhouse'],
            check=False,
            text=True,
            capture_output=True,
        )
    if Path('/opt/homebrew/bin/kubectl').exists():
        return subprocess.run(
            ['/opt/homebrew/bin/kubectl', '-n', 'torghut', 'get', 'clickhouseinstallation', 'torghut-clickhouse'],
            check=False,
            text=True,
            capture_output=True,
        )
    return subprocess.CompletedProcess(args=['kubectl'], returncode=127, stdout='', stderr='kubectl not found')


def check_http(base_url: str) -> list[CheckResult]:
    checks: list[CheckResult] = []
    endpoints = [
        ('torghut_healthz', '/healthz', lambda payload: payload.get('status') == 'ok'),
        ('trading_status', '/trading/status', lambda payload: bool(payload.get('running') in {True, False})),
        ('lean_shadow_parity', '/trading/lean/shadow/parity', lambda payload: 'events_total' in payload),
    ]
    for name, path, predicate in endpoints:
        url = f'{base_url.rstrip("/")}{path}'
        try:
            payload = _http_json(url)
            passed = predicate(payload)
            checks.append(CheckResult(name=name, passed=passed, detail=json.dumps(payload)[:300]))
        except Exception as exc:
            checks.append(CheckResult(name=name, passed=False, detail=str(exc)))
    return checks


def check_kafka_flink_clickhouse(namespace: str) -> list[CheckResult]:
    checks: list[CheckResult] = []
    if namespace != SUPPORTED_NAMESPACE:
        checks.append(
            CheckResult(
                name='namespace_supported',
                passed=False,
                detail=f'namespace must be {SUPPORTED_NAMESPACE!r}, got {namespace!r}',
            )
        )
        return checks

    topic_result = _kubectl_get_kafka_topic()
    checks.append(
        CheckResult(
            name='kafka_topic_torghut_ta_signals',
            passed=topic_result.returncode == 0,
            detail=(topic_result.stdout or topic_result.stderr).strip()[:300],
        )
    )

    flink_result = _kubectl_get_torghut_flink()
    if flink_result.returncode != 0:
        checks.append(
            CheckResult(
                name='flink_ta_deployment',
                passed=False,
                detail=(flink_result.stderr or flink_result.stdout).strip()[:300],
            )
        )
    else:
        payload = json.loads(flink_result.stdout)
        state = payload.get('status', {}).get('jobManagerDeploymentStatus', '').strip().lower()
        checks.append(
            CheckResult(
                name='flink_ta_deployment',
                passed=state in {'ready', 'running'},
                detail=f'jobManagerDeploymentStatus={state or "unknown"}',
            )
        )

    clickhouse_result = _kubectl_get_torghut_clickhouse()
    checks.append(
        CheckResult(
            name='clickhouse_installation',
            passed=clickhouse_result.returncode == 0,
            detail=(clickhouse_result.stdout or clickhouse_result.stderr).strip()[:300],
        )
    )

    return checks


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--torghut-url', default='http://torghut.torghut.svc.cluster.local:8181')
    parser.add_argument('--namespace', default='torghut')
    parser.add_argument('--skip-k8s', action='store_true')
    args = parser.parse_args()

    results = check_http(args.torghut_url)
    if not args.skip_k8s:
        results.extend(check_kafka_flink_clickhouse(args.namespace))

    failed = [check for check in results if not check.passed]
    for check in results:
        status = 'PASS' if check.passed else 'FAIL'
        print(f'[{status}] {check.name}: {check.detail}')

    if failed:
        print(f'Lean multi-lane verification failed ({len(failed)} check(s)).', file=sys.stderr)
        return 1
    print('Lean multi-lane verification passed.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
