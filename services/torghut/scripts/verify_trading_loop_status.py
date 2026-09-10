from __future__ import annotations

import argparse
import json
import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, cast
from urllib.request import Request, urlopen


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Fail unless Torghut has hard proof that the trading loop works.",
    )
    parser.add_argument(
        "--status-url",
        default="http://torghut.torghut.svc.cluster.local/trading/loop/status",
        help="Torghut /trading/loop/status URL.",
    )
    parser.add_argument(
        "--status-file",
        type=Path,
        help="Read a saved /trading/loop/status payload instead of calling the URL.",
    )
    parser.add_argument("--timeout-seconds", type=float, default=10.0)
    parser.add_argument("--min-fills", type=int, default=3)
    parser.add_argument("--required-passes", type=int, default=1)
    parser.add_argument("--interval-seconds", type=float, default=0.0)
    parser.add_argument("--max-attempts", type=int, default=1)
    args = parser.parse_args(argv)

    if args.required_passes < 1:
        raise SystemExit("--required-passes must be >= 1")
    if args.max_attempts < args.required_passes:
        raise SystemExit("--max-attempts must be >= --required-passes")
    if args.interval_seconds < 0:
        raise SystemExit("--interval-seconds must be >= 0")

    request = VerificationRequest(
        status_file=args.status_file,
        status_url=args.status_url,
        timeout_seconds=args.timeout_seconds,
        min_fills=args.min_fills,
        required_passes=args.required_passes,
        interval_seconds=args.interval_seconds,
        max_attempts=args.max_attempts,
    )
    result = _verify_with_retries(request)
    report = {
        "schema_version": "torghut.trading-loop-status-verifier.v1",
        "ok": result.ok,
        "failures": result.failures,
        "attempts": result.attempts,
        "consecutive_passes": result.consecutive_passes,
        "required_passes": args.required_passes,
        "status": result.status,
    }
    if result.last_failure is not None:
        report["last_failure"] = result.last_failure
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0 if result.ok else 1


@dataclass(frozen=True)
class VerificationRequest:
    status_file: Path | None
    status_url: str
    timeout_seconds: float
    min_fills: int
    required_passes: int
    interval_seconds: float
    max_attempts: int


class VerificationResult:
    def __init__(
        self,
        *,
        ok: bool,
        failures: list[str],
        attempts: int,
        consecutive_passes: int,
        status: Mapping[str, object],
        last_failure: Mapping[str, object] | None,
    ) -> None:
        self.ok = ok
        self.failures = failures
        self.attempts = attempts
        self.consecutive_passes = consecutive_passes
        self.status = status
        self.last_failure = last_failure


def _verify_with_retries(request: VerificationRequest) -> VerificationResult:
    consecutive_passes = 0
    attempts = 0
    last_payload: Mapping[str, Any] = {}
    last_failures: list[str] = []
    last_failure: Mapping[str, object] | None = None
    for attempt_index in range(request.max_attempts):
        attempts = attempt_index + 1
        last_payload = _load_payload(
            request.status_file,
            request.status_url,
            request.timeout_seconds,
        )
        failures = evaluate_loop_status(last_payload, min_fills=request.min_fills)
        if failures:
            consecutive_passes = 0
            last_failures = failures
            last_failure = {
                "failures": failures,
                "status": _status_summary(last_payload),
            }
        else:
            consecutive_passes += 1
            if consecutive_passes >= request.required_passes:
                return VerificationResult(
                    ok=True,
                    failures=[],
                    attempts=attempts,
                    consecutive_passes=consecutive_passes,
                    status=_status_summary(last_payload),
                    last_failure=last_failure,
                )
        if attempt_index + 1 < request.max_attempts and request.interval_seconds > 0:
            time.sleep(request.interval_seconds)
    if not last_failures:
        last_failures = ["required_consecutive_passes_not_met"]
    return VerificationResult(
        ok=False,
        failures=last_failures,
        attempts=attempts,
        consecutive_passes=consecutive_passes,
        status=_status_summary(last_payload),
        last_failure=last_failure,
    )


def evaluate_loop_status(
    payload: Mapping[str, Any],
    *,
    min_fills: int = 3,
) -> list[str]:
    failures: list[str] = []
    _require(payload.get("restored") is True, "loop_status_not_restored", failures)
    _require(
        _mapping(payload.get("runtime")).get("status") == "ok",
        "runtime_not_ok",
        failures,
    )
    _require(
        _mapping(payload.get("market_data")).get("fresh") is True,
        "market_data_not_fresh",
        failures,
    )
    alpha_model = _mapping(payload.get("alpha_model"))
    _require(
        alpha_model.get("present") is True, "multifactor_alpha_model_missing", failures
    )
    _require(
        alpha_model.get("factor_snapshot_present") is True,
        "multifactor_factor_snapshot_missing",
        failures,
    )
    _require(
        alpha_model.get("forecast_present") is True,
        "multifactor_forecast_missing",
        failures,
    )
    _require(
        _mapping(payload.get("risk_forecast")).get("present") is True,
        "multifactor_risk_forecast_missing",
        failures,
    )
    portfolio_target = _mapping(payload.get("portfolio_target"))
    _require(
        portfolio_target.get("present") is True,
        "multifactor_portfolio_target_missing",
        failures,
    )
    if (
        portfolio_target.get("present") is True
        and alpha_model.get("present") is True
        and alpha_model.get("factor_snapshot_present") is True
        and alpha_model.get("forecast_present") is True
    ):
        _require(
            portfolio_target.get("target_notional_positive") is True,
            "multifactor_target_notional_not_positive",
            failures,
        )
    _require(
        _mapping(payload.get("execution_intent")).get("present") is True,
        "multifactor_execution_intent_missing",
        failures,
    )
    _require(
        _mapping(payload.get("submitted_order")).get("present") is True,
        "submitted_order_missing",
        failures,
    )
    _require(
        _mapping(payload.get("exchange_order_state")).get("ack_seen") is True,
        "exchange_order_ack_missing",
        failures,
    )
    fills = _mapping(payload.get("fills"))
    _require(
        _int(fills.get("recent_count")) >= min_fills,
        "recent_fills_below_floor",
        failures,
    )
    position = _mapping(payload.get("position"))
    _require(
        position.get("account_snapshot_fresh") is True,
        "account_snapshot_not_fresh",
        failures,
    )
    _require(position.get("reconciled") is True, "position_not_reconciled", failures)
    stale_open_orders = _mapping(payload.get("stale_open_orders"))
    _require(
        _int(stale_open_orders.get("count")) == 0, "stale_open_orders_present", failures
    )
    alpaca_guard = _mapping(payload.get("alpaca_guard"))
    _require(
        _int(alpaca_guard.get("unexpected_live_order_count_24h")) == 0,
        "unexpected_live_alpaca_orders_present",
        failures,
    )
    blocker_reasons = payload.get("blocker_reasons")
    _require(not blocker_reasons, "status_blocker_reasons_present", failures)
    return failures


def _load_payload(
    status_file: Path | None,
    status_url: str,
    timeout_seconds: float,
) -> Mapping[str, Any]:
    if status_file is not None:
        loaded = json.loads(status_file.read_text(encoding="utf-8"))
    else:
        request = Request(status_url, headers={"Accept": "application/json"})
        with urlopen(request, timeout=timeout_seconds) as response:
            loaded = json.loads(response.read().decode("utf-8"))
    if not isinstance(loaded, Mapping):
        raise SystemExit("status payload must be a JSON object")
    return cast(Mapping[str, Any], loaded)


def _status_summary(payload: Mapping[str, Any]) -> dict[str, object]:
    return {
        "generated_at": payload.get("generated_at"),
        "restored": payload.get("restored"),
        "blocker_reasons": payload.get("blocker_reasons"),
        "market_data": _mapping(payload.get("market_data")),
        "algorithm": _mapping(payload.get("algorithm")),
        "execution_intent": _mapping(payload.get("execution_intent")),
        "submitted_order": _mapping(payload.get("submitted_order")),
        "exchange_order_state": _mapping(payload.get("exchange_order_state")),
        "fills": _mapping(payload.get("fills")),
        "position": _mapping(payload.get("position")),
        "stale_open_orders": _mapping(payload.get("stale_open_orders")),
        "alpaca_guard": _mapping(payload.get("alpaca_guard")),
    }


def _require(condition: bool, reason: str, failures: list[str]) -> None:
    if not condition:
        failures.append(reason)


def _mapping(value: object) -> Mapping[str, Any]:
    if isinstance(value, Mapping):
        return cast(Mapping[str, Any], value)
    return {}


def _int(value: object) -> int:
    if isinstance(value, bool):
        return 0
    if isinstance(value, int):
        return value
    if value is None:
        return 0
    try:
        return int(str(value))
    except ValueError:
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
