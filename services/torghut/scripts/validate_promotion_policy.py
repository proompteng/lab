#!/usr/bin/env python3
"""Validate Torghut promotion prerequisites and rollback readiness policies."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from app.trading.autonomy.policy_checks import evaluate_promotion_prerequisites, evaluate_rollback_readiness


def _load_json(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(payload, dict):
        raise ValueError(f'Expected JSON object at {path}')
    return payload


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description='Validate Torghut v3 promotion and rollback policy checks.')
    parser.add_argument('--policy', type=Path, required=True, help='Gate and operational policy JSON.')
    parser.add_argument('--state', type=Path, required=True, help='Candidate state JSON.')
    parser.add_argument('--gate-report', type=Path, required=True, help='Gate evaluation report JSON.')
    parser.add_argument('--artifact-root', type=Path, required=True, help='Artifact root directory for prerequisite files.')
    parser.add_argument('--promotion-target', choices=('shadow', 'paper', 'live'), default='paper')
    parser.add_argument(
        '--output',
        type=Path,
        help='Optional output JSON file for combined check results. Prints to stdout regardless.',
    )
    return parser


def main() -> int:
    parser = _build_parser()
    args = parser.parse_args()

    policy = _load_json(args.policy)
    state = _load_json(args.state)
    gate_report = _load_json(args.gate_report)

    promotion = evaluate_promotion_prerequisites(
        policy_payload=policy,
        gate_report_payload=gate_report,
        candidate_state_payload=state,
        promotion_target=args.promotion_target,
        artifact_root=args.artifact_root,
    )
    rollback = evaluate_rollback_readiness(
        policy_payload=policy,
        candidate_state_payload=state,
    )

    payload = {
        'promotion_target': args.promotion_target,
        'promotion_prerequisites': promotion.to_payload(),
        'rollback_readiness': rollback.to_payload(),
        'promotion_progression_allowed': promotion.allowed and rollback.ready,
    }
    rendered = json.dumps(payload, indent=2, sort_keys=True)
    print(rendered)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered + '\n', encoding='utf-8')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
