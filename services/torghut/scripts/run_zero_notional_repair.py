from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Mapping
from typing import Any


DEFAULT_ACTION = "rerun_drift_checks_for_blocked_hypotheses"
ZERO_NOTIONAL_REPAIR_RECEIPT_SCHEMA_VERSION = (
    "torghut.zero-notional-repair-execution-receipt.v1"
)


def _text(value: object, default: str = "") -> str:
    if value is None:
        return default
    text = str(value).strip()
    return text or default


def _strings(value: object) -> list[str]:
    if not isinstance(value, list):
        return []
    result: list[str] = []
    for item in value:
        text = _text(item)
        if text:
            result.append(text)
    return result


def _is_zero(value: object) -> bool:
    return _text(value, "0") in {"", "0", "0.0", "0.00", "0.0000"}


def _bool_false(value: object) -> bool:
    if isinstance(value, bool):
        return not value
    return _text(value).lower() in {"", "0", "false", "no", "off"}


def _repair_url(
    service_url: str, *, action: str, execute: bool, drift_limit: int
) -> str:
    base = service_url.rstrip("/")
    query = urllib.parse.urlencode(
        {
            "action": action,
            "execute": "true" if execute else "false",
            "drift_limit": str(drift_limit),
        }
    )
    return f"{base}/trading/profit-freshness/zero-notional-repair?{query}"


def _post_repair(
    url: str,
    *,
    timeout_seconds: float,
    auth_token: str | None = None,
) -> dict[str, Any]:
    headers = {
        "Accept": "application/json",
        "Content-Type": "application/json",
    }
    if auth_token:
        headers["Authorization"] = f"Bearer {auth_token}"
    request = urllib.request.Request(
        url,
        data=b"{}",
        headers=headers,
        method="POST",
    )
    with urllib.request.urlopen(
        request,
        timeout=max(timeout_seconds, 1.0),
    ) as response:
        payload = json.loads(response.read().decode("utf-8"))
    if not isinstance(payload, dict):
        raise RuntimeError("zero_notional_repair_response_not_object")
    return payload


def _receipt_validation_errors(receipt: Mapping[str, Any]) -> list[str]:
    errors: list[str] = []
    if (
        _text(receipt.get("schema_version"))
        != ZERO_NOTIONAL_REPAIR_RECEIPT_SCHEMA_VERSION
    ):
        errors.append("receipt_schema_version_mismatch")
    if not _bool_false(receipt.get("order_submission_enabled")):
        errors.append("receipt_order_submission_enabled")
    if not _is_zero(receipt.get("paper_notional_limit")):
        errors.append("receipt_paper_notional_nonzero")
    if not _is_zero(receipt.get("live_notional_limit")):
        errors.append("receipt_live_notional_nonzero")
    safety = receipt.get("safety_invariants")
    if not isinstance(safety, Mapping):
        errors.append("receipt_safety_invariants_missing")
    else:
        if not _is_zero(safety.get("max_notional")):
            errors.append("receipt_safety_max_notional_nonzero")
        if safety.get("paper_live_capital_unchanged") is not True:
            errors.append("receipt_capital_invariant_not_true")
        if safety.get("order_submission_disabled") is not True:
            errors.append("receipt_order_submission_invariant_not_true")
    return errors


def _accepted_blocked_state(
    receipt: Mapping[str, Any],
    *,
    allow_no_selected_repair: bool,
    allow_no_signal_blocked: bool,
) -> bool:
    state = _text(receipt.get("execution_state"))
    blocked_reasons = _strings(receipt.get("blocked_reasons"))
    if allow_no_selected_repair and state == "no_selected_repair":
        return True
    if (
        allow_no_selected_repair
        and blocked_reasons
        and all(
            reason.startswith("profit_freshness_frontier_matching_repair_missing:")
            for reason in blocked_reasons
        )
    ):
        return True
    if (
        allow_no_signal_blocked
        and state == "runner_blocked"
        and blocked_reasons
        and all(
            reason.startswith("drift_check_no_signals:") for reason in blocked_reasons
        )
    ):
        return True
    return False


def _is_dispatchable_repair(receipt: Mapping[str, Any]) -> bool:
    if _text(receipt.get("execution_state")) == "no_selected_repair":
        return False
    has_concrete_repair = bool(
        _text(receipt.get("zero_notional_action")) or _text(receipt.get("candidate_id"))
    )
    if not has_concrete_repair:
        return False
    if receipt.get("requires_repair_lot_dispatch_ticket") is True:
        return receipt.get("repair_lot_dispatch_ticket_launch_allowed") is True
    return True


def _receipt_exit_code(
    receipt: Mapping[str, Any],
    *,
    allow_no_selected_repair: bool,
    allow_no_signal_blocked: bool,
) -> tuple[int, list[str]]:
    validation_errors = _receipt_validation_errors(receipt)
    if validation_errors:
        return 1, validation_errors

    command_exit_code = int(receipt.get("command_exit_code") or 0)
    execution_state = _text(receipt.get("execution_state"))
    if execution_state == "executed" and command_exit_code == 0:
        return 0, []
    if _accepted_blocked_state(
        receipt,
        allow_no_selected_repair=allow_no_selected_repair,
        allow_no_signal_blocked=allow_no_signal_blocked,
    ):
        return 0, []
    return command_exit_code if command_exit_code else 1, []


def _run_repair_request(
    url: str, args: argparse.Namespace
) -> tuple[int, dict[str, Any]]:
    attempts = max(1, int(args.attempts))
    attempt_errors: list[str] = []
    for attempt in range(1, attempts + 1):
        try:
            receipt = _post_repair(
                url,
                timeout_seconds=float(args.timeout_seconds),
                auth_token=_text(args.auth_token) or None,
            )
            receipt["request_url"] = url
            receipt["fetch_attempts"] = attempt
            exit_code, validation_errors = _receipt_exit_code(
                receipt,
                allow_no_selected_repair=bool(args.allow_no_selected_repair),
                allow_no_signal_blocked=bool(args.allow_no_signal_blocked),
            )
            if validation_errors:
                receipt["validation_errors"] = validation_errors
            return exit_code, receipt
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            attempt_errors.append(f"{type(exc).__name__}:{exc}")
            if attempt < attempts:
                time.sleep(max(0.0, float(args.retry_backoff_seconds)))
                continue
            return (
                1,
                {
                    "schema_version": ZERO_NOTIONAL_REPAIR_RECEIPT_SCHEMA_VERSION,
                    "execution_state": "request_failed",
                    "command_exit_code": 1,
                    "request_url": url,
                    "fetch_attempts": attempt,
                    "blocked_reasons": ["zero_notional_repair_request_failed"],
                    "attempt_errors": attempt_errors,
                    "order_submission_enabled": False,
                    "paper_notional_limit": "0",
                    "live_notional_limit": "0",
                    "safety_invariants": {
                        "max_notional": "0",
                        "paper_live_capital_unchanged": True,
                        "order_submission_disabled": True,
                    },
                },
            )


def run(args: argparse.Namespace) -> tuple[int, dict[str, Any]]:
    drift_limit = max(1, int(args.drift_limit))
    execute_url = _repair_url(
        args.service_url,
        action=args.action,
        execute=bool(args.execute),
        drift_limit=drift_limit,
    )
    if bool(args.execute) and args.execute_policy == "dispatchable-only":
        preflight_url = _repair_url(
            args.service_url,
            action=args.action,
            execute=False,
            drift_limit=drift_limit,
        )
        preflight_exit_code, preflight_receipt = _run_repair_request(
            preflight_url, args
        )
        preflight_receipt["execute_policy"] = args.execute_policy
        preflight_receipt["requested_execute"] = True
        preflight_receipt["execute_request_url"] = execute_url
        preflight_receipt["preflight_request_url"] = preflight_url
        preflight_validation_errors = _receipt_validation_errors(preflight_receipt)
        if preflight_validation_errors:
            preflight_receipt["preflight_dispatchable"] = False
            preflight_receipt["preflight_skipped_execute"] = True
            preflight_receipt["validation_errors"] = preflight_validation_errors
            return 1, preflight_receipt

        if not _is_dispatchable_repair(preflight_receipt):
            preflight_receipt["preflight_dispatchable"] = False
            preflight_receipt["preflight_skipped_execute"] = True
            if preflight_exit_code != 0:
                return preflight_exit_code, preflight_receipt
            preflight_receipt["preflight_command_exit_code"] = preflight_receipt.get(
                "command_exit_code"
            )
            preflight_receipt["command_exit_code"] = 0
            return 0, preflight_receipt

        execute_exit_code, execute_receipt = _run_repair_request(execute_url, args)
        execute_receipt["execute_policy"] = args.execute_policy
        execute_receipt["requested_execute"] = True
        execute_receipt["preflight_dispatchable"] = True
        execute_receipt["preflight_skipped_execute"] = False
        execute_receipt["preflight_request_url"] = preflight_url
        execute_receipt["preflight_execution_state"] = _text(
            preflight_receipt.get("execution_state")
        )
        return execute_exit_code, execute_receipt

    return _run_repair_request(execute_url, args)


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run a Torghut zero-notional repair endpoint and validate the receipt stays capital-safe."
    )
    parser.add_argument(
        "--service-url",
        required=True,
        help="Torghut service base URL, for example http://torghut-sim.torghut.svc.cluster.local.",
    )
    parser.add_argument("--action", default=DEFAULT_ACTION)
    parser.add_argument("--execute", action="store_true")
    parser.add_argument(
        "--execute-policy",
        choices=("always", "dispatchable-only"),
        default="always",
        help=(
            "always executes when --execute is set; dispatchable-only first "
            "preflights with execute=false and skips no-op receipts."
        ),
    )
    parser.add_argument("--drift-limit", type=int, default=1000)
    parser.add_argument("--attempts", type=int, default=3)
    parser.add_argument("--timeout-seconds", type=float, default=45.0)
    parser.add_argument(
        "--auth-token",
        default=os.getenv("TORGHUT_COMMAND_API_TOKEN", "").strip() or None,
        help="Torghut command bearer token (default: TORGHUT_COMMAND_API_TOKEN).",
    )
    parser.add_argument("--retry-backoff-seconds", type=float, default=5.0)
    parser.add_argument("--allow-no-selected-repair", action="store_true")
    parser.add_argument("--allow-no-signal-blocked", action="store_true")
    parser.add_argument("--json", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(list(argv if argv is not None else sys.argv[1:]))
    exit_code, receipt = run(args)
    if args.json:
        print(json.dumps(receipt, sort_keys=True, default=str))
    else:
        print(
            " ".join(
                [
                    f"execution_state={_text(receipt.get('execution_state'))}",
                    f"command_exit_code={receipt.get('command_exit_code')}",
                    f"fetch_attempts={receipt.get('fetch_attempts')}",
                    f"blocked_reasons={','.join(_strings(receipt.get('blocked_reasons')))}",
                ]
            )
        )
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
