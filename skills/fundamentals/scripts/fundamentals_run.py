#!/usr/bin/env python3
"""Wrapper for fundamentals market-context run lifecycle calls."""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
RUN_API = REPO_ROOT / 'skills/market-context/scripts/market_context_run_api.py'
VALIDATE = REPO_ROOT / 'skills/market-context/scripts/validate_market_context_payload.py'


def _run(*args: str) -> None:
    command = ['python3', str(args[0]), *args[1:]]
    completed = subprocess.run(command, check=False)
    if completed.returncode != 0:
        raise SystemExit(completed.returncode)


def main() -> int:
    parser = argparse.ArgumentParser(description='Fundamentals market-context workflow helper')
    parser.add_argument('--callback-url', required=True)
    parser.add_argument('--request-id', required=True)
    parser.add_argument('--symbol', required=True)
    parser.add_argument('--reason', required=True)
    parser.add_argument('--payload-file', required=True)
    parser.add_argument('--evidence-file')
    parser.add_argument('--run-name')
    args = parser.parse_args()

    _run(str(RUN_API), 'start', '--callback-url', args.callback_url, '--request-id', args.request_id, '--symbol', args.symbol, '--domain', 'fundamentals', '--reason', args.reason, '--provider', 'codex-spark', *(('--run-name', args.run_name) if args.run_name else ()))
    _run(str(RUN_API), 'progress', '--callback-url', args.callback_url, '--request-id', args.request_id, '--seq', '1', '--status', 'running', '--message', 'fundamentals_collection_started')
    _run(str(VALIDATE), '--domain', 'fundamentals', '--file', args.payload_file)

    if args.evidence_file:
        _run(str(RUN_API), 'evidence', '--callback-url', args.callback_url, '--request-id', args.request_id, '--symbol', args.symbol, '--domain', 'fundamentals', '--seq', '2', '--evidence-file', args.evidence_file)

    _run(str(RUN_API), 'finalize', '--callback-url', args.callback_url, '--request-id', args.request_id, '--payload-file', args.payload_file, '--expect-status', '200')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
