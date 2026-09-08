#!/usr/bin/env python3
"""Validate market-context finalize payloads before submission."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

ALLOWED_RUN_STATUS = {'succeeded', 'partial', 'failed', 'submitted'}


def _load_json(path: Path) -> dict[str, Any]:
    raw = path.read_text(encoding='utf-8')
    parsed = json.loads(raw)
    if not isinstance(parsed, dict):
        raise ValueError('payload must be a JSON object')
    return parsed


def _expect_string(payload: dict[str, Any], key: str) -> str:
    value = payload.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f'{key} must be a non-empty string')
    return value.strip()


def _expect_number(payload: dict[str, Any], key: str) -> float:
    value = payload.get(key)
    if not isinstance(value, (int, float)):
        raise ValueError(f'{key} must be a number')
    return float(value)


def _validate_citations(payload: dict[str, Any]) -> None:
    citations = payload.get('citations')
    if not isinstance(citations, list):
        raise ValueError('citations must be an array')
    for idx, citation in enumerate(citations):
        if not isinstance(citation, dict):
            raise ValueError(f'citations[{idx}] must be an object')
        source = citation.get('source')
        published_at = citation.get('publishedAt')
        if not isinstance(source, str) or not source.strip():
            raise ValueError(f'citations[{idx}].source must be a non-empty string')
        if not isinstance(published_at, str) or not published_at.strip():
            raise ValueError(f'citations[{idx}].publishedAt must be a non-empty string')


def _validate_payload(domain: str, payload: dict[str, Any]) -> None:
    symbol = _expect_string(payload, 'symbol')
    payload_domain = _expect_string(payload, 'domain')
    if payload_domain != domain:
        raise ValueError(f'domain mismatch: expected {domain}, got {payload_domain}')

    _expect_string(payload, 'asOfUtc')
    request_id = _expect_string(payload, 'requestId')
    run_status = _expect_string(payload, 'runStatus').lower()
    if run_status not in ALLOWED_RUN_STATUS:
        raise ValueError(f'runStatus must be one of {sorted(ALLOWED_RUN_STATUS)}')

    quality_score = _expect_number(payload, 'qualityScore')
    if quality_score < 0 or quality_score > 1:
        raise ValueError('qualityScore must be in [0, 1]')

    source_count = _expect_number(payload, 'sourceCount')
    if source_count < 0:
        raise ValueError('sourceCount must be >= 0')

    body = payload.get('payload')
    if not isinstance(body, dict):
        raise ValueError('payload field must be an object')

    risk_flags = payload.get('riskFlags')
    if risk_flags is not None and not isinstance(risk_flags, list):
        raise ValueError('riskFlags must be an array when provided')

    _validate_citations(payload)

    if domain == 'news':
        headlines = body.get('headlines')
        if not isinstance(headlines, list):
            raise ValueError('news payload.headlines must be an array')
    if domain == 'fundamentals':
        for key in ('valuation', 'growth', 'profitability', 'balanceSheet'):
            if key not in body:
                raise ValueError(f'fundamentals payload must contain {key}')

    _expect_string(payload, 'provider')

    _ = symbol
    _ = request_id


def main() -> int:
    parser = argparse.ArgumentParser(description='Validate market-context payload JSON')
    parser.add_argument('--domain', choices=['fundamentals', 'news'], required=True)
    parser.add_argument('--file', required=True)
    args = parser.parse_args()

    payload = _load_json(Path(args.file))
    _validate_payload(args.domain, payload)

    print(json.dumps({'ok': True, 'domain': args.domain, 'file': args.file}, separators=(',', ':')))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
