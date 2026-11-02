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

    def test_dispatchable_only_skips_execute_for_no_selected_repair(self) -> None:
        args = script.parse_args(
            [
                "--service-url",
                "http://torghut-sim.torghut.svc.cluster.local",
                "--execute",
                "--execute-policy",
                "dispatchable-only",
                "--allow-no-selected-repair",
                "--json",
            ]
        )
        no_op_receipt = _capital_safe_receipt(
            execution_state="no_selected_repair",
            command_exit_code=78,
            blocked_reasons=[
                "profit_freshness_frontier_matching_repair_missing:"
                "rerun_drift_checks_for_blocked_hypotheses"
            ],
        )

        with patch.object(
            script.urllib.request,
            "urlopen",
            return_value=_FakeResponse(no_op_receipt),
        ) as urlopen:
            exit_code, receipt = script.run(args)

        self.assertEqual(exit_code, 0)
        self.assertEqual(urlopen.call_count, 1)
        request = urlopen.call_args.args[0]
        self.assertIn("&execute=false&", request.full_url)
        self.assertEqual(receipt["execute_policy"], "dispatchable-only")
        self.assertEqual(receipt["preflight_skipped_execute"], True)
        self.assertEqual(receipt["preflight_dispatchable"], False)
        self.assertEqual(receipt["preflight_command_exit_code"], 78)
        self.assertEqual(receipt["command_exit_code"], 0)
        self.assertIn("&execute=true&", receipt["execute_request_url"])

    def test_dispatchable_only_executes_after_concrete_preflight_repair(
        self,
    ) -> None:
        args = script.parse_args(
            [
                "--service-url",
                "http://torghut.torghut.svc.cluster.local",
                "--execute",
                "--execute-policy",
                "dispatchable-only",
                "--json",
            ]
        )
        preflight_receipt = _capital_safe_receipt(
            execution_state="repair_selected",
            zero_notional_action="recompute_route_tca_and_fill_quality",
            candidate_id="candidate-a",
            requires_repair_lot_dispatch_ticket=True,
            repair_lot_dispatch_ticket_launch_allowed=True,
        )
        execute_receipt = _capital_safe_receipt(
            execution_state="executed",
            zero_notional_action="recompute_route_tca_and_fill_quality",
            candidate_id="candidate-a",
        )

        with patch.object(
            script.urllib.request,
            "urlopen",
            side_effect=[
                _FakeResponse(preflight_receipt),
                _FakeResponse(execute_receipt),
            ],
        ) as urlopen:
            exit_code, receipt = script.run(args)

        self.assertEqual(exit_code, 0)
        self.assertEqual(urlopen.call_count, 2)
        first_request = urlopen.call_args_list[0].args[0]
        second_request = urlopen.call_args_list[1].args[0]
        self.assertIn("&execute=false&", first_request.full_url)
        self.assertIn("&execute=true&", second_request.full_url)
        self.assertEqual(receipt["preflight_dispatchable"], True)
        self.assertEqual(receipt["preflight_skipped_execute"], False)
        self.assertEqual(receipt["preflight_execution_state"], "repair_selected")

    def test_dispatchable_repair_requires_concrete_safe_action(self) -> None:
        self.assertFalse(
            script._is_dispatchable_repair(
                _capital_safe_receipt(execution_state="repair_selected")
            )
        )
        self.assertFalse(
            script._is_dispatchable_repair(
                _capital_safe_receipt(
                    execution_state="repair_selected",
                    zero_notional_action="recompute_route_tca_and_fill_quality",
                    requires_repair_lot_dispatch_ticket=True,
                    repair_lot_dispatch_ticket_launch_allowed=False,
                )
            )
        )
        self.assertTrue(
            script._is_dispatchable_repair(
                _capital_safe_receipt(
                    execution_state="repair_selected",
                    candidate_id="candidate-a",
                )
            )
        )

    def test_dispatchable_only_rejects_invalid_preflight_receipt(self) -> None:
        args = script.parse_args(
            [
                "--service-url",
                "http://torghut.torghut.svc.cluster.local",
                "--execute",
                "--execute-policy",
                "dispatchable-only",
                "--json",
            ]
        )
        invalid_preflight_receipt = _capital_safe_receipt(
            execution_state="repair_selected",
            zero_notional_action="recompute_route_tca_and_fill_quality",
            order_submission_enabled=True,
        )

        with patch.object(
            script.urllib.request,
            "urlopen",
            return_value=_FakeResponse(invalid_preflight_receipt),
        ) as urlopen:
            exit_code, receipt = script.run(args)

        self.assertEqual(exit_code, 1)
        self.assertEqual(urlopen.call_count, 1)
        self.assertEqual(receipt["preflight_dispatchable"], False)
        self.assertEqual(receipt["preflight_skipped_execute"], True)
        self.assertIn("receipt_order_submission_enabled", receipt["validation_errors"])

    def test_dispatchable_only_returns_nonzero_preflight_without_execute(
        self,
    ) -> None:
        args = script.parse_args(
            [
                "--service-url",
                "http://torghut.torghut.svc.cluster.local",
                "--execute",
                "--execute-policy",
                "dispatchable-only",
                "--json",
            ]
        )
        blocked_receipt = _capital_safe_receipt(
            execution_state="runner_blocked",
            command_exit_code=78,
            blocked_reasons=["unexpected_zero_notional_repair_block"],
        )

        with patch.object(
            script.urllib.request,
            "urlopen",
            return_value=_FakeResponse(blocked_receipt),
        ) as urlopen:
            exit_code, receipt = script.run(args)

        self.assertEqual(exit_code, 78)
        self.assertEqual(urlopen.call_count, 1)
        self.assertEqual(receipt["preflight_dispatchable"], False)
        self.assertEqual(receipt["preflight_skipped_execute"], True)
        self.assertNotIn("preflight_command_exit_code", receipt)

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
