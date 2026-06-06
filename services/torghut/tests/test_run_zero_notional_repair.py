from __future__ import annotations

import json
import io
from unittest import TestCase
from unittest.mock import patch

from scripts import run_zero_notional_repair as script


class _FakeResponse:
    def __init__(self, payload: object) -> None:
        self.payload = payload

    def __enter__(self) -> _FakeResponse:
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def read(self) -> bytes:
        return json.dumps(self.payload).encode("utf-8")


def _capital_safe_receipt(**overrides: object) -> dict[str, object]:
    receipt: dict[str, object] = {
        "schema_version": script.ZERO_NOTIONAL_REPAIR_RECEIPT_SCHEMA_VERSION,
        "execution_state": "executed",
        "command_exit_code": 0,
        "blocked_reasons": [],
        "order_submission_enabled": False,
        "paper_notional_limit": "0",
        "live_notional_limit": "0",
        "safety_invariants": {
            "max_notional": "0",
            "paper_live_capital_unchanged": True,
            "order_submission_disabled": True,
        },
    }
    receipt.update(overrides)
    return receipt


class TestRunZeroNotionalRepair(TestCase):
    def test_normalizers_handle_missing_and_non_boolean_values(self) -> None:
        self.assertEqual(script._text(None, "fallback"), "fallback")
        self.assertEqual(script._strings("not-a-list"), [])
        self.assertTrue(script._bool_false("false"))

    def test_run_posts_capital_safe_repair_request(self) -> None:
        args = script.parse_args(
            [
                "--service-url",
                "http://torghut-sim.torghut.svc.cluster.local/",
                "--execute",
                "--drift-limit",
                "321",
                "--json",
            ]
        )

        with patch.object(
            script.urllib.request,
            "urlopen",
            return_value=_FakeResponse(_capital_safe_receipt()),
        ) as urlopen:
            exit_code, receipt = script.run(args)

        self.assertEqual(exit_code, 0)
        self.assertEqual(receipt["execution_state"], "executed")
        self.assertEqual(receipt["fetch_attempts"], 1)
        request = urlopen.call_args.args[0]
        self.assertEqual(request.get_method(), "POST")
        self.assertEqual(request.data, b"{}")
        self.assertEqual(request.get_header("Accept"), "application/json")
        self.assertEqual(
            request.full_url,
            "http://torghut-sim.torghut.svc.cluster.local/trading/"
            "profit-freshness/zero-notional-repair?"
            "action=rerun_drift_checks_for_blocked_hypotheses"
            "&execute=true&drift_limit=321",
        )

    def test_rejects_receipt_that_would_enable_order_submission(self) -> None:
        args = script.parse_args(
            [
                "--service-url",
                "http://torghut.torghut.svc.cluster.local",
                "--execute",
                "--json",
            ]
        )

        with patch.object(
            script.urllib.request,
            "urlopen",
            return_value=_FakeResponse(
                _capital_safe_receipt(order_submission_enabled=True)
            ),
        ):
            exit_code, receipt = script.run(args)

        self.assertEqual(exit_code, 1)
        self.assertIn("receipt_order_submission_enabled", receipt["validation_errors"])

    def test_rejects_malformed_receipt_invariants(self) -> None:
        errors = script._receipt_validation_errors(
            {
                "schema_version": "wrong",
                "order_submission_enabled": "no",
                "paper_notional_limit": "1",
                "live_notional_limit": "2",
            }
        )

        self.assertEqual(
            errors,
            [
                "receipt_schema_version_mismatch",
                "receipt_paper_notional_nonzero",
                "receipt_live_notional_nonzero",
                "receipt_safety_invariants_missing",
            ],
        )

    def test_rejects_safety_invariant_drift(self) -> None:
        errors = script._receipt_validation_errors(
            _capital_safe_receipt(
                safety_invariants={
                    "max_notional": "100",
                    "paper_live_capital_unchanged": False,
                    "order_submission_disabled": False,
                }
            )
        )

        self.assertEqual(
            errors,
            [
                "receipt_safety_max_notional_nonzero",
                "receipt_capital_invariant_not_true",
                "receipt_order_submission_invariant_not_true",
            ],
        )

    def test_rejects_non_object_http_response(self) -> None:
        with patch.object(
            script.urllib.request,
            "urlopen",
            return_value=_FakeResponse(["not", "a", "receipt"]),
        ):
            with self.assertRaisesRegex(
                RuntimeError, "zero_notional_repair_response_not_object"
            ):
                script._post_repair(
                    "http://torghut/trading/profit-freshness/zero-notional-repair",
                    timeout_seconds=0.1,
                )

    def test_accepts_missing_selected_repair_only_when_flagged(self) -> None:
        receipt = _capital_safe_receipt(
            execution_state="no_selected_repair",
            command_exit_code=1,
            blocked_reasons=[
                "profit_freshness_frontier_matching_repair_missing:"
                "rerun_drift_checks_for_blocked_hypotheses"
            ],
        )
        strict_exit_code, _ = script._receipt_exit_code(
            receipt,
            allow_no_selected_repair=False,
            allow_no_signal_blocked=False,
        )
        allowed_exit_code, _ = script._receipt_exit_code(
            receipt,
            allow_no_selected_repair=True,
            allow_no_signal_blocked=False,
        )

        self.assertEqual(strict_exit_code, 1)
        self.assertEqual(allowed_exit_code, 0)

    def test_accepts_matching_frontier_missing_block_only_when_flagged(self) -> None:
        receipt = _capital_safe_receipt(
            execution_state="runner_blocked",
            command_exit_code=1,
            blocked_reasons=[
                "profit_freshness_frontier_matching_repair_missing:"
                "rerun_drift_checks_for_blocked_hypotheses"
            ],
        )

        strict_exit_code, _ = script._receipt_exit_code(
            receipt,
            allow_no_selected_repair=False,
            allow_no_signal_blocked=False,
        )
        allowed_exit_code, _ = script._receipt_exit_code(
            receipt,
            allow_no_selected_repair=True,
            allow_no_signal_blocked=False,
        )

        self.assertEqual(strict_exit_code, 1)
        self.assertEqual(allowed_exit_code, 0)

    def test_accepts_no_signal_drift_block_only_when_flagged(self) -> None:
        receipt = _capital_safe_receipt(
            execution_state="runner_blocked",
            command_exit_code=1,
            blocked_reasons=["drift_check_no_signals:H-PAIRS-01"],
        )
        strict_exit_code, _ = script._receipt_exit_code(
            receipt,
            allow_no_selected_repair=False,
            allow_no_signal_blocked=False,
        )
        allowed_exit_code, _ = script._receipt_exit_code(
            receipt,
            allow_no_selected_repair=False,
            allow_no_signal_blocked=True,
        )

        self.assertEqual(strict_exit_code, 1)
        self.assertEqual(allowed_exit_code, 0)

    def test_retries_transient_request_failure(self) -> None:
        args = script.parse_args(
            [
                "--service-url",
                "http://torghut-sim.torghut.svc.cluster.local",
                "--execute",
                "--attempts",
                "2",
                "--retry-backoff-seconds",
                "0",
                "--json",
            ]
        )

        with (
            patch.object(
                script.urllib.request,
                "urlopen",
                side_effect=[
                    script.urllib.error.URLError("temporary"),
                    _FakeResponse(_capital_safe_receipt()),
                ],
            ) as urlopen,
            patch.object(script.time, "sleep") as sleep,
        ):
            exit_code, receipt = script.run(args)

        self.assertEqual(exit_code, 0)
        self.assertEqual(receipt["fetch_attempts"], 2)
        self.assertEqual(urlopen.call_count, 2)
        sleep.assert_called_once_with(0.0)

    def test_returns_capital_safe_failure_payload_after_terminal_request_error(
        self,
    ) -> None:
        args = script.parse_args(
            [
                "--service-url",
                "http://torghut-sim.torghut.svc.cluster.local",
                "--execute",
                "--attempts",
                "1",
                "--json",
            ]
        )

        with patch.object(
            script.urllib.request,
            "urlopen",
            side_effect=script.urllib.error.URLError("down"),
        ):
            exit_code, receipt = script.run(args)

        self.assertEqual(exit_code, 1)
        self.assertEqual(receipt["execution_state"], "request_failed")
        self.assertEqual(receipt["fetch_attempts"], 1)
        self.assertEqual(receipt["order_submission_enabled"], False)
        self.assertEqual(receipt["paper_notional_limit"], "0")
        self.assertEqual(receipt["live_notional_limit"], "0")
        self.assertEqual(
            receipt["blocked_reasons"], ["zero_notional_repair_request_failed"]
        )

    def test_main_can_print_json_and_operator_text(self) -> None:
        json_stdout = io.StringIO()
        text_stdout = io.StringIO()
        receipt = _capital_safe_receipt(fetch_attempts=1)

        with (
            patch.object(script, "run", return_value=(0, receipt)),
            patch("sys.stdout", json_stdout),
        ):
            json_exit_code = script.main(
                ["--service-url", "http://torghut", "--execute", "--json"]
            )

        with (
            patch.object(script, "run", return_value=(1, receipt)),
            patch("sys.stdout", text_stdout),
        ):
            text_exit_code = script.main(["--service-url", "http://torghut"])

        self.assertEqual(json_exit_code, 0)
        self.assertEqual(
            json.loads(json_stdout.getvalue())["execution_state"], "executed"
        )
        self.assertEqual(text_exit_code, 1)
        self.assertIn("execution_state=executed", text_stdout.getvalue())
        self.assertIn("blocked_reasons=", text_stdout.getvalue())
