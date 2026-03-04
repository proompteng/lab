#!/usr/bin/env python3
"""Compile deterministic Torghut DSPy artifacts from dataset and metric policy refs."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from urllib.parse import unquote, urlsplit

from app.trading.llm.dspy_compile.compiler import compile_dspy_program_artifacts

REPRO_ARTIFACT_PATH = Path("/tmp/torghut-dspy-spark-repro-20260304-045659/compile")
REPRO_DATASET_REF = (
    "/tmp/torghut-dspy-spark-repro-20260304-045659/dataset-build/dspy-dataset.json"
)
REPRO_METRIC_POLICY_REF = (
    Path(__file__).resolve().parents[1]
    / "config"
    / "trading"
    / "llm"
    / "dspy-metrics.yaml"
)
REPRO_OPTIMIZER = "miprov2"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--repository", required=True, help="Repository slug (owner/name)."
    )
    parser.add_argument("--base", required=True, help="Base branch name.")
    parser.add_argument("--head", required=True, help="Head branch name.")
    parser.add_argument(
        "--artifact-path",
        type=Path,
        default=REPRO_ARTIFACT_PATH,
        help="Directory where compile artifacts are written.",
    )
    parser.add_argument(
        "--dataset-ref",
        default=REPRO_DATASET_REF,
        help="Local path or file:// URI to dspy-dataset.json.",
    )
    parser.add_argument(
        "--metric-policy-ref",
        default=str(REPRO_METRIC_POLICY_REF),
        help="Local path or file:// URI to metric policy YAML.",
    )
    parser.add_argument(
        "--optimizer",
        default=REPRO_OPTIMIZER,
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
    parser.add_argument(
        "--schema-valid-rate",
        type=float,
        default=None,
        help="Optional observed schema validity rate [0,1] for eval gating.",
    )
    parser.add_argument(
        "--veto-alignment-rate",
        type=float,
        default=None,
        help="Optional observed veto alignment rate [0,1] for eval gating.",
    )
    parser.add_argument(
        "--false-veto-rate",
        type=float,
        default=None,
        help="Optional observed false veto rate [0,1] for eval gating.",
    )
    parser.add_argument(
        "--fallback-rate",
        type=float,
        default=None,
        help="Optional observed fallback rate [0,1] for eval gating.",
    )
    parser.add_argument(
        "--latency-p95-ms",
        type=int,
        default=None,
        help="Optional observed p95 latency in milliseconds for eval gating.",
    )
    return parser.parse_args()


def _resolve_local_ref(ref: str, *, field_name: str) -> str:
    parsed = urlsplit(ref)
    if parsed.scheme not in {"", "file"}:
        raise ValueError(f"{field_name}_must_be_local_path")
    if parsed.scheme == "file":
        candidate = Path(unquote(parsed.path))
    else:
        candidate = Path(ref)
    if not candidate.is_absolute():
        candidate = Path.cwd() / candidate
    return str(candidate.resolve())


def _assert_repro_guardrails(
    *,
    artifact_path: Path,
    dataset_ref: str,
    metric_policy_ref: str,
    optimizer: str,
) -> None:
    if artifact_path.resolve() != REPRO_ARTIFACT_PATH:
        raise ValueError("artifact_path_must_match_repro_guardrail")
    if _resolve_local_ref(dataset_ref, field_name="dataset_ref") != REPRO_DATASET_REF:
        raise ValueError("dataset_ref_must_match_repro_guardrail")
    metric_policy_path = _resolve_local_ref(metric_policy_ref, field_name="metric_policy_ref")
    if metric_policy_path != str(REPRO_METRIC_POLICY_REF):
        raise ValueError("metric_policy_ref_must_match_repro_guardrail")
    if optimizer.strip().lower() != REPRO_OPTIMIZER:
        raise ValueError("optimizer_must_be_miprov2")


def main() -> int:
    args = parse_args()
    _assert_repro_guardrails(
        artifact_path=args.artifact_path,
        dataset_ref=args.dataset_ref,
        metric_policy_ref=args.metric_policy_ref,
        optimizer=args.optimizer,
    )

    normalized_dataset_ref = _resolve_local_ref(
        args.dataset_ref, field_name="dataset_ref"
    )
    normalized_metric_policy_ref = _resolve_local_ref(
        args.metric_policy_ref, field_name="metric_policy_ref"
    )

    result = compile_dspy_program_artifacts(
        repository=args.repository,
        base=args.base,
        head=args.head,
        artifact_path=args.artifact_path,
        dataset_ref=normalized_dataset_ref,
        metric_policy_ref=normalized_metric_policy_ref,
        optimizer=REPRO_OPTIMIZER,
        program_name=args.program_name,
        signature_version=args.signature_version,
        seed=args.seed,
        schema_valid_rate=args.schema_valid_rate,
        veto_alignment_rate=args.veto_alignment_rate,
        false_veto_rate=args.false_veto_rate,
        fallback_rate=args.fallback_rate,
        latency_p95_ms=args.latency_p95_ms,
    )
    payload = {
        "ok": True,
        "artifactPath": str(args.artifact_path),
        "datasetRef": normalized_dataset_ref,
        "metricPolicyRef": normalized_metric_policy_ref,
        "optimizer": REPRO_OPTIMIZER,
        "compileResultRef": str(result.compile_result_path),
        "compiledArtifactUri": result.compiled_artifact_uri,
        "compiledArtifactPath": str(result.compiled_artifact_path),
        "compileMetricsRef": str(result.compile_metrics_path),
        "metricBundleHash": result.metric_bundle_hash,
        "artifactHash": result.compile_result.artifact_hash,
        "reproducibilityHash": result.compile_result.reproducibility_hash,
    }
    print(json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
