#!/usr/bin/env python3
"""Compile deterministic Torghut DSPy artifacts from dataset and metric policy refs."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from app.trading.llm.dspy_compile.compiler import compile_dspy_program_artifacts


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
        help="Directory where compile artifacts are written.",
    )
    parser.add_argument(
        "--dataset-ref",
        required=True,
        help="Local path or file:// URI to dspy-dataset.json.",
    )
    parser.add_argument(
        "--metric-policy-ref",
        required=True,
        help="Local path or file:// URI to metric policy YAML.",
    )
    parser.add_argument(
        "--optimizer",
        required=True,
        help="DSPy optimizer id (for example miprov2).",
    )
    parser.add_argument(
        "--program-name",
        default="trade-review-committee-v1",
        help="Logical DSPy program name.",
    )
    parser.add_argument(
        "--signature-version",
        default="v1",
        help="Trade review signature version.",
    )
    parser.add_argument(
        "--seed",
        default="torghut-dspy-compile-seed-v1",
        help="Deterministic compile seed.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    result = compile_dspy_program_artifacts(
        repository=args.repository,
        base=args.base,
        head=args.head,
        artifact_path=args.artifact_path,
        dataset_ref=args.dataset_ref,
        metric_policy_ref=args.metric_policy_ref,
        optimizer=args.optimizer,
        program_name=args.program_name,
        signature_version=args.signature_version,
        seed=args.seed,
    )
    payload = {
        "ok": True,
        "artifactPath": str(args.artifact_path),
        "datasetRef": args.dataset_ref,
        "metricPolicyRef": args.metric_policy_ref,
        "optimizer": args.optimizer,
        "compileResultRef": str(result.compile_result_path),
        "compiledArtifactUri": result.compiled_artifact_uri,
        "compiledArtifactPath": str(result.compiled_artifact_path),
        "compileMetricsRef": str(result.compile_metrics_path),
        "artifactHash": result.compile_result.artifact_hash,
        "reproducibilityHash": result.compile_result.reproducibility_hash,
    }
    print(json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
