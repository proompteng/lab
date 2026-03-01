#!/usr/bin/env python3
"""Run deterministic alpha discovery lane."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import pandas as pd

from app.trading.alpha.lane import run_alpha_discovery_lane


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run deterministic alpha discovery lane.")
    parser.add_argument("--train-csv", type=Path, required=True, help="Train-price CSV path.")
    parser.add_argument("--test-csv", type=Path, required=True, help="Test-price CSV path.")
    parser.add_argument("--output-dir", type=Path, required=True, help="Artifact output directory.")
    parser.add_argument(
        "--repository", type=str, default=None, help="Repository context for the run."
    )
    parser.add_argument("--base", type=str, default=None, help="Base reference.")
    parser.add_argument("--head", type=str, default=None, help="Head reference.")
    parser.add_argument(
        "--priority-id",
        type=str,
        default=None,
        help="Priority identifier for candidate generation cycle.",
    )
    parser.add_argument(
        "--artifact-path",
        type=Path,
        default=None,
        help="Optional artifact root for execution-context notes.",
    )
    parser.add_argument(
        "--gate-policy",
        type=Path,
        default=None,
        help="Optional JSON policy constraints for lane evaluation.",
    )
    parser.add_argument(
        "--promotion-target",
        choices=("shadow", "paper", "live"),
        default="paper",
        help="Requested promotion target.",
    )
    parser.add_argument(
        "--lookbacks", default="20,40,60", help="Comma-separated lookback days."
    )
    parser.add_argument(
        "--vol-lookbacks",
        default="10,20,40",
        help="Comma-separated volatility lookback days.",
    )
    parser.add_argument(
        "--target-vols",
        default="0.0075,0.01,0.0125",
        help="Comma-separated target daily volatility levels.",
    )
    parser.add_argument(
        "--max-grosses",
        default="0.75,1.0",
        help="Comma-separated max gross leverage values.",
    )
    parser.add_argument(
        "--allow-shorts",
        action="store_true",
        help="Disable long-only restriction.",
    )
    parser.add_argument(
        "--cost-bps",
        type=float,
        default=5.0,
        help="Cost in bps per unit turnover.",
    )
    return parser.parse_args()


def _parse_ints(raw: str) -> list[int]:
    values = [int(item.strip()) for item in raw.split(",") if item.strip()]
    if not values:
        raise ValueError("expected at least one integer value")
    return values


def _parse_floats(raw: str) -> list[float]:
    values = [float(item.strip()) for item in raw.split(",") if item.strip()]
    if not values:
        raise ValueError("expected at least one float value")
    return values


def _load_price_frame(path: Path) -> pd.DataFrame:
    frame = pd.read_csv(path, index_col=0, parse_dates=True)
    return frame


def main() -> int:
    args = parse_args()
    train = _load_price_frame(args.train_csv)
    test = _load_price_frame(args.test_csv)

    result = run_alpha_discovery_lane(
        artifact_path=args.output_dir,
        train_prices=train,
        test_prices=test,
        repository=args.repository,
        base=args.base,
        head=args.head,
        priority_id=args.priority_id,
        lookback_days=_parse_ints(args.lookbacks),
        vol_lookback_days=_parse_ints(args.vol_lookbacks),
        target_daily_vols=_parse_floats(args.target_vols),
        max_gross_leverages=_parse_floats(args.max_grosses),
        long_only=not args.allow_shorts,
        cost_bps_per_turnover=args.cost_bps,
        gate_policy_path=args.gate_policy,
        promotion_target=args.promotion_target,
        execution_context={
            "execution_context": {
                "artifactPath": str(args.artifact_path)
            }
        }
        if args.artifact_path
        else None,
    )

    payload = {
        "run_id": result.run_id,
        "candidate_id": result.candidate_id,
        "output_dir": str(result.output_dir),
        "candidate_generation_manifest_path": str(result.candidate_generation_manifest_path),
        "evaluation_manifest_path": str(result.evaluation_manifest_path),
        "recommendation_manifest_path": str(result.recommendation_manifest_path),
        "recommendation_artifact_path": str(result.recommendation_artifact_path),
        "candidate_spec_path": str(result.candidate_spec_path),
        "stage_trace_ids": result.stage_trace_ids,
        "stage_lineage_root": result.stage_lineage_root,
        "recommendation_trace_id": result.recommendation_trace_id,
        "train_prices_path": str(result.train_prices_path),
        "test_prices_path": str(result.test_prices_path),
        "search_result_path": str(result.search_result_path),
        "best_candidate_path": str(result.best_candidate_path),
        "evaluation_report_path": str(result.evaluation_report_path),
    }
    print(json.dumps(payload, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
