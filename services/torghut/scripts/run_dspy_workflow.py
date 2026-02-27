#!/usr/bin/env python3
"""Submit DSPy dataset-build -> compile -> eval -> [gepa] -> promote AgentRuns."""

from __future__ import annotations

import argparse
import json

from app.config import settings
from app.db import SessionLocal
from app.trading.llm.dspy_compile import orchestrate_dspy_agentrun_workflow


def _default_base_url() -> str:
    if settings.jangar_base_url:
        return settings.jangar_base_url.rstrip("/")
    return "http://jangar.jangar.svc.cluster.local"


def _build_lane_overrides(args: argparse.Namespace) -> dict[str, dict[str, str]]:
    artifact_root = args.artifact_root.rstrip("/")
    dataset_ref = args.dataset_ref or f"{artifact_root}/dataset-build/dspy-dataset.json"
    compile_result_ref = (
        args.compile_result_ref or f"{artifact_root}/compile/dspy-compile-result.json"
    )
    eval_report_ref = (
        args.eval_report_ref or f"{artifact_root}/eval/dspy-eval-report.json"
    )
    artifact_hash = args.artifact_hash or f"{compile_result_ref}#artifactHash"

    overrides: dict[str, dict[str, str]] = {
        "dataset-build": {
            "datasetWindow": args.dataset_window,
            "universeRef": args.universe_ref,
        },
        "compile": {
            "datasetRef": dataset_ref,
            "metricPolicyRef": args.metric_policy_ref,
            "optimizer": args.optimizer,
        },
        "eval": {
            "compileResultRef": compile_result_ref,
            "gatePolicyRef": args.gate_policy_ref,
        },
        "promote": {
            "evalReportRef": eval_report_ref,
            "artifactHash": artifact_hash,
            "promotionTarget": args.promotion_target,
            "approvalRef": args.approval_ref,
        },
    }

    if args.include_gepa_experiment:
        baseline_ref = args.gepa_baseline_ref or compile_result_ref
        overrides["gepa-experiment"] = {
            "baselineArtifactRef": baseline_ref,
            "experimentName": args.gepa_experiment_name,
        }

    return overrides


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--repository", required=True, help="VCS repository slug, e.g. proompteng/lab"
    )
    parser.add_argument("--base", default="main", help="VCS base branch")
    parser.add_argument("--head", required=True, help="VCS head branch")
    parser.add_argument(
        "--issue-number",
        default="0",
        help="Issue number metadata required by codex agent runner (default: 0)",
    )
    parser.add_argument(
        "--run-prefix", required=True, help="Stable run prefix for idempotency keys"
    )
    parser.add_argument(
        "--artifact-root", required=True, help="Artifact root path for lane outputs"
    )

    parser.add_argument(
        "--base-url", default=_default_base_url(), help="Jangar base URL"
    )
    parser.add_argument(
        "--auth-token",
        default=settings.jangar_api_key or "",
        help="Optional bearer token for Jangar /v1/agent-runs",
    )
    parser.add_argument(
        "--timeout-seconds",
        type=int,
        default=20,
        help="Submit request timeout in seconds",
    )

    parser.add_argument(
        "--dataset-window", default="P30D", help="Dataset extraction window"
    )
    parser.add_argument(
        "--universe-ref",
        default="torghut:equity:enabled",
        help="Universe selector reference",
    )
    parser.add_argument(
        "--dataset-ref", default="", help="Optional dataset artifact reference"
    )
    parser.add_argument(
        "--metric-policy-ref", default=settings.llm_dspy_compile_metrics_policy_ref
    )
    parser.add_argument("--optimizer", default="miprov2")
    parser.add_argument(
        "--gate-policy-ref", default=settings.llm_dspy_compile_metrics_policy_ref
    )

    parser.add_argument(
        "--compile-result-ref",
        default="",
        help="Optional compile result artifact reference",
    )
    parser.add_argument(
        "--eval-report-ref", default="", help="Optional eval report artifact reference"
    )
    parser.add_argument(
        "--artifact-hash", default="", help="Approved artifact hash (or hash reference)"
    )
    parser.add_argument(
        "--promotion-target",
        default="constrained_live",
        choices=["paper", "shadow", "constrained_live", "scaled_live"],
    )
    parser.add_argument("--approval-ref", default="risk-committee")

    parser.add_argument("--include-gepa-experiment", action="store_true")
    parser.add_argument("--gepa-baseline-ref", default="")
    parser.add_argument("--gepa-experiment-name", default="torghut-dspy-gepa-v1")

    parser.add_argument("--namespace", default="agents")
    parser.add_argument("--agent-name", default="codex-agent")
    parser.add_argument("--vcs-ref-name", default="github")
    parser.add_argument(
        "--secret-binding-ref", default=settings.llm_dspy_secret_binding_ref
    )
    parser.add_argument(
        "--ttl-seconds-after-finished",
        type=int,
        default=settings.llm_dspy_agentrun_ttl_seconds,
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    lane_overrides = _build_lane_overrides(args)

    with SessionLocal() as session:
        responses = orchestrate_dspy_agentrun_workflow(
            session,
            base_url=args.base_url,
            repository=args.repository,
            base=args.base,
            head=args.head,
            artifact_root=args.artifact_root,
            run_prefix=args.run_prefix,
            auth_token=(args.auth_token.strip() or None),
            issue_number=args.issue_number,
            lane_parameter_overrides=lane_overrides,
            include_gepa_experiment=bool(args.include_gepa_experiment),
            namespace=args.namespace,
            agent_name=args.agent_name,
            vcs_ref_name=args.vcs_ref_name,
            secret_binding_ref=args.secret_binding_ref,
            ttl_seconds_after_finished=max(int(args.ttl_seconds_after_finished), 0),
            timeout_seconds=max(int(args.timeout_seconds), 1),
        )

    output = {
        "ok": True,
        "runPrefix": args.run_prefix,
        "repository": args.repository,
        "base": args.base,
        "head": args.head,
        "artifactRoot": args.artifact_root,
        "includeGepaExperiment": bool(args.include_gepa_experiment),
        "responses": responses,
    }
    print(json.dumps(output, sort_keys=True, separators=(",", ":"), ensure_ascii=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
