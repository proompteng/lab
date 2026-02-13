#!/usr/bin/env python3
"""Execute the standardized Torghut TA replay rollout workflow."""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
from dataclasses import dataclass
from typing import Any

import yaml


TA_CONFIGMAP = "torghut-ta-config"
TA_DEPLOYMENT = "torghut-ta"
CONFIRMATION_TOKEN = "REPLAY_TA_CANARY"


@dataclass(frozen=True)
class ReplayState:
    namespace: str
    ta_group_id: str
    ta_auto_offset_reset: str
    flink_job_state: str | None
    flink_restart_nonce: int
    flink_status_state: str | None


def _require_kubectl() -> None:
    if shutil.which("kubectl") is None:
        raise SystemExit("kubectl not found in PATH")


def _run_kubectl(namespace: str, *args: str, capture_output: bool = True) -> subprocess.CompletedProcess[str]:
    command = ("kubectl", "-n", namespace, *args)
    return subprocess.run(
        command,
        check=True,
        text=True,
        capture_output=capture_output,
    )


def _run_kubectl_json(namespace: str, *args: str) -> dict[str, Any]:
    result = _run_kubectl(namespace, *args, "-o", "json")
    return json.loads(result.stdout)


def _parse_int(value: object, fallback: int = 0) -> int:
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        try:
            return int(value)
        except ValueError:
            pass
    return fallback


def _load_state(namespace: str) -> ReplayState:
    cm = _run_kubectl_json(namespace, "get", "configmap", TA_CONFIGMAP)
    cm_data = cm.get("data", {})
    if not isinstance(cm_data, dict):
        raise SystemExit("configmap data is not parseable")

    ta_group_id = str(cm_data.get("TA_GROUP_ID", "")).strip()
    ta_auto_offset_reset = str(cm_data.get("TA_AUTO_OFFSET_RESET", "latest")).strip()
    if not ta_group_id:
        raise SystemExit("TA_GROUP_ID missing in torghut-ta-config")

    flink = _run_kubectl_json(namespace, "get", "flinkdeployment", TA_DEPLOYMENT)
    spec = flink.get("spec")
    if not isinstance(spec, dict):
        raise SystemExit("flinkdeployment spec is missing")
    job_spec = spec.get("job")
    job_state = None
    restart_nonce = 0
    if isinstance(job_spec, dict):
        job_state = job_spec.get("state")
        if isinstance(job_state, str):
            job_state = job_state.strip() or None

    restart_nonce = _parse_int(spec.get("restartNonce"), 0)

    status = flink.get("status")
    flink_status_state = None
    if isinstance(status, dict):
        job_status = status.get("jobStatus")
        if isinstance(job_status, dict):
            flink_status_state = job_status.get("state")
            if isinstance(flink_status_state, str):
                flink_status_state = flink_status_state.strip() or None

    return ReplayState(
        namespace=namespace,
        ta_group_id=ta_group_id,
        ta_auto_offset_reset=ta_auto_offset_reset,
        flink_job_state=job_state,
        flink_restart_nonce=restart_nonce,
        flink_status_state=flink_status_state,
    )


def _plan_command(replay_id: str, group_prefix: str, auto_offset_reset: str) -> dict[str, str]:
    if not replay_id:
        raise SystemExit("replay-id must be provided")
    normalized_prefix = group_prefix.strip().replace("__", "-")
    normalized_id = replay_id.strip().replace("__", "-")
    replay_group_id = f"{normalized_prefix}-{normalized_id}"
    auto_offset_reset = auto_offset_reset.strip() or "earliest"
    return {
        "replay_group_id": replay_group_id,
        "ta_auto_offset_reset": auto_offset_reset,
    }


def _emit_plan(state: ReplayState, plan: dict[str, str], namespace: str, dry_run: bool = True) -> None:
    print("Current replay state:")
    print(f"  namespace: {namespace}")
    print(f"  TA_GROUP_ID: {state.ta_group_id}")
    print(f"  TA_AUTO_OFFSET_RESET: {state.ta_auto_offset_reset}")
    print(f"  TA job state: {state.flink_job_state or 'unknown'}")
    print(f"  TA restartNonce: {state.flink_restart_nonce}")
    print(f"  TA status state: {state.flink_status_state or 'unknown'}")
    print("")
    print("Planned action:")
    print(f"  replay-group: {plan['replay_group_id']}")
    print(f"  ta-auto-offset-reset: {plan['ta_auto_offset_reset']}")
    if state.ta_group_id == plan["replay_group_id"]:
        print("  note: replay-group is already set; this run is effectively idempotent.")
    if state.ta_auto_offset_reset == plan["ta_auto_offset_reset"] and dry_run:
        print("  note: TA_AUTO_OFFSET_RESET already matches requested target.")
    print("")
    print("Execution sequence (non-destructive replay mode):")
    print("  1) Set TA_GROUP_ID and TA_AUTO_OFFSET_RESET in torghut-ta-config")
    print("  2) Suspend torghut-ta if currently running")
    print("  3) Resume torghut-ta with an incremented restartNonce")


def _apply_plan(state: ReplayState, plan: dict[str, str], namespace: str) -> ReplayState:
    cm_patch = {
        "data": {
            "TA_GROUP_ID": plan["replay_group_id"],
            "TA_AUTO_OFFSET_RESET": plan["ta_auto_offset_reset"],
        }
    }
    _run_kubectl(
        namespace,
        "patch",
        "configmap",
        TA_CONFIGMAP,
        "--type",
        "merge",
        "-p",
        yaml.safe_dump(cm_patch),
    )

    if state.flink_job_state != "suspended":
        suspend_patch = {"spec": {"job": {"state": "suspended"}}}
        _run_kubectl(
            namespace,
            "patch",
            "flinkdeployment",
            TA_DEPLOYMENT,
            "--type",
            "merge",
            "-p",
            yaml.safe_dump(suspend_patch),
        )

    resume_patch = {
        "spec": {
            "restartNonce": state.flink_restart_nonce + 1,
            "job": {"state": "running"},
        }
    }
    _run_kubectl(
        namespace,
        "patch",
        "flinkdeployment",
        TA_DEPLOYMENT,
        "--type",
        "merge",
        "-p",
        yaml.safe_dump(resume_patch),
    )

    return _load_state(namespace)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Standardize TA replay rollout actions for torghut.")
    parser.add_argument("--namespace", default="torghut", help="Kubernetes namespace for torghut resources.")
    parser.add_argument("--replay-id", required=True, help="Replay id used for group-id isolation.")
    parser.add_argument(
        "--group-prefix",
        default="torghut-ta-replay",
        help="Prefix for generated TA_GROUP_ID.",
    )
    parser.add_argument(
        "--auto-offset-reset",
        default="earliest",
        choices=("earliest", "latest", "none"),
        help="Target TA_AUTO_OFFSET_RESET value.",
    )
    parser.add_argument(
        "--mode",
        choices=("plan", "apply"),
        default="plan",
        help="Plan only (default) or apply via kubectl patches.",
    )
    parser.add_argument(
        "--confirm",
        default="",
        help="Required when --mode=apply. Must be REPLAY_TA_CANARY.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    _require_kubectl()

    if args.mode == "apply" and args.confirm != CONFIRMATION_TOKEN:
        raise SystemExit(
            f"--mode=apply requires --confirm {CONFIRMATION_TOKEN}"
        )

    state = _load_state(args.namespace)
    plan = _plan_command(args.replay_id, args.group_prefix, args.auto_offset_reset)
    _emit_plan(state, plan, args.namespace, dry_run=args.mode == "plan")

    if args.mode == "plan":
        print(
            "Use --mode=apply --confirm REPLAY_TA_CANARY to execute the plan."
        )
        return 0

    print("Applying plan now...")
    state = _apply_plan(state, plan, args.namespace)
    print("Patch complete.")
    print("Updated state:")
    _emit_plan(state, plan, args.namespace, dry_run=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
