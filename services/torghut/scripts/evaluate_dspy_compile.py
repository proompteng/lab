#!/usr/bin/env python3
"""Evaluate compiled Torghut DSPy artifact against promotion gate policy."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from app.trading.llm.dspy_compile import evaluate_dspy_compile_artifact


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--repository", required=True, help="Repository slug (owner/name)."
    )
    parser.add_argument("--base", required=True, help="Base branch name.")
    parser.add_argument("--head", required=True, help="Head branch name.")
    parser.add_argument(
        "--artifact-path",
        required=True,
        type=Path,
        help="Directory where dspy-eval-report.json is written.",
    )
    parser.add_argument(
        "--compile-result-ref",
        required=True,
        help="Local path or file:// URI to dspy-compile-result.json.",
    )
    parser.add_argument(
        "--gate-policy-ref",
        required=True,
        help="Local path or file:// URI to eval gate policy YAML.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    result = evaluate_dspy_compile_artifact(
        repository=args.repository,
        base=args.base,
        head=args.head,
        artifact_path=args.artifact_path,
        compile_result_ref=args.compile_result_ref,
        gate_policy_ref=args.gate_policy_ref,
    )

    eval_report = result.eval_report
    payload = {
        "ok": True,
        "artifactPath": str(args.artifact_path),
        "compileResultRef": args.compile_result_ref,
        "gatePolicyRef": args.gate_policy_ref,
        "evalReportRef": str(result.eval_report_path),
        "artifactHash": eval_report.artifact_hash,
        "schemaValidRate": eval_report.schema_valid_rate,
        "vetoAlignmentRate": eval_report.veto_alignment_rate,
        "falseVetoRate": eval_report.false_veto_rate,
        "latencyP95Ms": eval_report.latency_p95_ms,
        "gateCompatibility": eval_report.gate_compatibility,
        "promotionRecommendation": eval_report.promotion_recommendation,
        "evalHash": eval_report.eval_hash,
    }
    print(json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
