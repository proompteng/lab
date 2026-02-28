#!/usr/bin/env python3
"""Market-context run lifecycle API helper for AgentRun skills.

This script posts run lifecycle events (start/progress/evidence/finalize) to Jangar market-context endpoints
using the in-cluster service-account token when available.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

DEFAULT_TOKEN_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/token'


def _read_json(path: Path) -> dict[str, Any]:
    try:
        raw = path.read_text(encoding='utf-8')
    except OSError as exc:
        raise SystemExit(f'failed to read JSON file {path}: {exc}') from exc

    try:
        value = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise SystemExit(f'invalid JSON in {path}: {exc}') from exc

    if not isinstance(value, dict):
        raise SystemExit(f'JSON file must contain an object: {path}')
    return value


def _read_evidence(path: Path) -> list[dict[str, Any]]:
    try:
        raw = path.read_text(encoding='utf-8')
    except OSError as exc:
        raise SystemExit(f'failed to read evidence file {path}: {exc}') from exc

    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise SystemExit(f'invalid JSON in evidence file {path}: {exc}') from exc

    if isinstance(parsed, dict):
        candidate = parsed.get('evidence', parsed.get('items'))
    else:
        candidate = parsed

    if not isinstance(candidate, list):
        raise SystemExit('evidence file must contain an array or object with evidence/items array')

    result: list[dict[str, Any]] = []
    for item in candidate:
        if isinstance(item, dict):
            result.append(item)
    if not result:
        raise SystemExit('evidence file contains no valid object rows')
    return result


def _resolve_base_url(callback_url: str) -> str:
    base = callback_url.strip().rstrip('/')
    for suffix in ('/ingest', '/runs/finalize'):
        if base.endswith(suffix):
            base = base[: -len(suffix)]
            break
    if not base:
        raise SystemExit('callback URL is empty')
    return base


def _resolve_endpoint(action: str, callback_url: str, request_id: str | None) -> str:
    base = _resolve_base_url(callback_url)
    if action == 'start':
        return f'{base}/runs/start'
    if action == 'progress':
        return f'{base}/runs/progress'
    if action == 'evidence':
        return f'{base}/runs/evidence'
    if action == 'finalize':
        return f'{base}/runs/finalize'
    if action == 'status':
        if not request_id:
            raise SystemExit('requestId is required for status calls')
        return f'{base}/runs/{request_id}'
    raise SystemExit(f'unsupported action: {action}')


def _load_token(token_path: str) -> str | None:
    path = Path(token_path)
    if not path.exists() or not path.is_file():
        return None
    token = path.read_text(encoding='utf-8').strip()
    return token or None


def _request_json(
    *,
    method: str,
    url: str,
    payload: dict[str, Any] | None,
    timeout_seconds: float,
    expected_statuses: set[int],
    token: str | None,
    retries: int,
) -> dict[str, Any]:
    body = None
    headers: dict[str, str] = {'accept': 'application/json'}
    if payload is not None:
        body = json.dumps(payload, separators=(',', ':'), ensure_ascii=True).encode('utf-8')
        headers['content-type'] = 'application/json'
    if token:
        headers['authorization'] = f'Bearer {token}'

    attempt = 0
    while True:
        attempt += 1
        req = urllib.request.Request(url=url, data=body, method=method.upper(), headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=timeout_seconds) as response:
                status = response.getcode()
                raw = response.read().decode('utf-8')
                if status not in expected_statuses:
                    raise SystemExit(f'unexpected status {status}; body={raw}')
                if not raw.strip():
                    return {'ok': status in expected_statuses, 'status': status}
                decoded = json.loads(raw)
                if not isinstance(decoded, dict):
                    raise SystemExit(f'endpoint returned non-object JSON: {decoded!r}')
                return decoded
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode('utf-8', errors='replace')
            if attempt > retries + 1:
                raise SystemExit(f'HTTP {exc.code} calling {url}; body={raw}') from exc
        except urllib.error.URLError as exc:
            if attempt > retries + 1:
                raise SystemExit(f'network error calling {url}: {exc}') from exc
        except TimeoutError as exc:
            if attempt > retries + 1:
                raise SystemExit(f'timeout calling {url}: {exc}') from exc

        time.sleep(min(1.0 * attempt, 5.0))


def _parse_expected(values: list[int]) -> set[int]:
    if not values:
        return {200}
    return {int(value) for value in values}


def _build_payload(args: argparse.Namespace) -> dict[str, Any] | None:
    metadata: dict[str, Any] = {}
    if args.metadata_file:
        metadata = _read_json(Path(args.metadata_file))

    if args.action == 'status':
        return None

    payload: dict[str, Any] = {}
    if args.request_id:
        payload['requestId'] = args.request_id
    if args.symbol:
        payload['symbol'] = args.symbol
    if args.domain:
        payload['domain'] = args.domain

    if args.action == 'start':
        if args.run_name:
            payload['runName'] = args.run_name
        if args.reason:
            payload['reason'] = args.reason
        payload['provider'] = args.provider
        if args.seq is not None:
            payload['seq'] = args.seq
        if metadata:
            payload['metadata'] = metadata
        return payload

    if args.action == 'progress':
        if args.seq is None:
            raise SystemExit('--seq is required for progress')
        payload['seq'] = args.seq
        payload['status'] = args.status
        if args.message:
            payload['message'] = args.message
        if metadata:
            payload['metadata'] = metadata
        return payload

    if args.action == 'evidence':
        if args.seq is None:
            raise SystemExit('--seq is required for evidence')
        if not args.evidence_file:
            raise SystemExit('--evidence-file is required for evidence')
        payload['seq'] = args.seq
        payload['evidence'] = _read_evidence(Path(args.evidence_file))
        if metadata:
            payload['metadata'] = metadata
        return payload

    if args.action == 'finalize':
        if not args.payload_file:
            raise SystemExit('--payload-file is required for finalize')
        payload = _read_json(Path(args.payload_file))
        if args.request_id and not payload.get('requestId'):
            payload['requestId'] = args.request_id
        if metadata:
            existing = payload.get('metadata')
            if isinstance(existing, dict):
                merged = dict(existing)
                merged.update(metadata)
                payload['metadata'] = merged
            else:
                payload['metadata'] = metadata
        return payload

    raise SystemExit(f'unsupported action: {args.action}')


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description='Market-context run lifecycle API helper')
    parser.add_argument('action', choices=['start', 'progress', 'evidence', 'finalize', 'status'])
    parser.add_argument('--callback-url', required=True)
    parser.add_argument('--request-id')
    parser.add_argument('--symbol')
    parser.add_argument('--domain', choices=['fundamentals', 'news'])
    parser.add_argument('--run-name')
    parser.add_argument('--reason')
    parser.add_argument('--provider', default='codex-spark')
    parser.add_argument('--seq', type=int)
    parser.add_argument('--status', default='running')
    parser.add_argument('--message')
    parser.add_argument('--payload-file')
    parser.add_argument('--evidence-file')
    parser.add_argument('--metadata-file')
    parser.add_argument('--token-path', default=DEFAULT_TOKEN_PATH)
    parser.add_argument('--timeout-seconds', type=float, default=20.0)
    parser.add_argument('--expect-status', type=int, action='append', default=[])
    parser.add_argument('--retries', type=int, default=1)
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    if args.action != 'status' and not args.request_id:
        raise SystemExit('--request-id is required for start/progress/evidence/finalize')

    payload = _build_payload(args)
    endpoint = _resolve_endpoint(args.action, args.callback_url, args.request_id)
    token = _load_token(args.token_path)
    expected = _parse_expected(args.expect_status)
    method = 'GET' if args.action == 'status' else 'POST'

    response = _request_json(
        method=method,
        url=endpoint,
        payload=payload,
        timeout_seconds=args.timeout_seconds,
        expected_statuses=expected,
        token=token,
        retries=max(0, args.retries),
    )
    sys.stdout.write(json.dumps(response, separators=(',', ':'), ensure_ascii=True))
    sys.stdout.write('\n')

    ok_value = response.get('ok')
    if isinstance(ok_value, bool) and not ok_value:
        raise SystemExit(f'endpoint returned ok=false: {response}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
