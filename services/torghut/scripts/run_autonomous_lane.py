#!/usr/bin/env python3
"""Run Torghut v3 deterministic autonomous lane (research -> gates -> paper patch)."""

from __future__ import annotations

import argparse
import json
import subprocess
from pathlib import Path

from app.trading.autonomy.lane import run_autonomous_lane


def _run_git_rev_parse() -> subprocess.CompletedProcess[str]:
    if Path('/usr/bin/git').exists():
        return subprocess.run(
            ['/usr/bin/git', 'rev-parse', 'HEAD'],
            check=True,
            capture_output=True,
            text=True,
        )
    if Path('/usr/local/bin/git').exists():
        return subprocess.run(
            ['/usr/local/bin/git', 'rev-parse', 'HEAD'],
            check=True,
            capture_output=True,
            text=True,
        )
    if Path('/opt/homebrew/bin/git').exists():
        return subprocess.run(
            ['/opt/homebrew/bin/git', 'rev-parse', 'HEAD'],
            check=True,
            capture_output=True,
            text=True,
        )
    raise FileNotFoundError('git not found in expected paths')


def _resolve_git_sha() -> str:
    try:
        result = _run_git_rev_parse()
    except (subprocess.SubprocessError, FileNotFoundError):
        return 'unknown'
    return result.stdout.strip() or 'unknown'


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Run deterministic autonomous Torghut lane."
    )
    parser.add_argument(
        "--signals", type=Path, required=True, help="Path to signal fixture JSON."
    )
    parser.add_argument(
        "--strategy-config",
        type=Path,
        required=True,
        help="Path to runtime strategy YAML/JSON.",
    )
    parser.add_argument(
        "--gate-policy", type=Path, required=True, help="Path to gate policy JSON."
    )
    parser.add_argument(
        "--output-dir", type=Path, required=True, help="Artifact output directory."
    )
    parser.add_argument(
        "--promotion-target", choices=("shadow", "paper", "live"), default="paper"
    )
    parser.add_argument(
        "--strategy-configmap",
        type=Path,
        default=Path("argocd/applications/torghut/strategy-configmap.yaml"),
        help="GitOps strategy configmap source for candidate patch generation.",
    )
    parser.add_argument(
        "--approval-token",
        type=str,
        help="Required for live target when enabled by policy.",
    )
    args = parser.parse_args()

    result = run_autonomous_lane(
        signals_path=args.signals,
        strategy_config_path=args.strategy_config,
        gate_policy_path=args.gate_policy,
        output_dir=args.output_dir,
        promotion_target=args.promotion_target,
        strategy_configmap_path=args.strategy_configmap,
        code_version=_resolve_git_sha(),
        approval_token=args.approval_token,
    )

    payload = {
        "run_id": result.run_id,
        "candidate_id": result.candidate_id,
        "output_dir": str(result.output_dir),
        "gate_report_path": str(result.gate_report_path),
        "paper_patch_path": str(result.paper_patch_path)
        if result.paper_patch_path
        else None,
        "profitability_benchmark_path": str(
            result.output_dir / "gates" / "profitability-benchmark-v4.json"
        ),
        "profitability_evidence_path": str(
            result.output_dir / "gates" / "profitability-evidence-v4.json"
        ),
        "profitability_validation_path": str(
            result.output_dir / "gates" / "profitability-evidence-validation.json"
        ),
        "janus_event_car_path": str(
            result.output_dir / "gates" / "janus-event-car-v1.json"
        ),
        "janus_hgrm_reward_path": str(
            result.output_dir / "gates" / "janus-hgrm-reward-v1.json"
        ),
        "promotion_gate_path": str(
            result.output_dir / "gates" / "promotion-evidence-gate.json"
        ),
    }
    print(json.dumps(payload, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
