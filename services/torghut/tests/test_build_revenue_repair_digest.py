from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from contextlib import redirect_stdout
from datetime import datetime, timezone
from io import StringIO
from pathlib import Path
from typing import cast
from unittest import TestCase

from scripts.build_revenue_repair_digest import (
    _bool,
    _build_repair_queue,
    _business_state,
    _collect_blocking_reasons,
    _int,
    _load_json_object,
    _parse_generated_at,
    _sequence,
    build_revenue_repair_digest,
    main,
)


NOW = datetime(2026, 5, 7, 16, 0, tzinfo=timezone.utc)


def _repair_only_readyz() -> dict[str, object]:
    return {
        "status": "degraded",
        "dependencies": {
            "live_submission_gate": {
                "ok": False,
                "detail": "simple_submit_disabled",
                "capital_stage": "shadow",
            },
            "profitability_proof_floor": {
                "ok": False,
                "detail": "repair_only",
                "capital_state": "zero_notional",
                "required": True,
            },
            "quant_evidence": {
                "ok": False,
                "detail": "quant_pipeline_degraded",
                "required": True,
            },
        },
    }


def _repair_only_status() -> dict[str, object]:
    return {
        "mode": "live",
        "pipeline_mode": "simple",
        "build": {"active_revision": "torghut-00252"},
        "live_submission_gate": {
            "allowed": False,
            "reason": "simple_submit_disabled",
            "blocked_reasons": ["simple_submit_disabled"],
            "capital_stage": "shadow",
            "configured_live_promotion": False,
        },
        "proof_floor": {
            "schema_version": "torghut.profitability-proof-floor.v1",
            "floor_state": "fail",
            "route_state": "repair_only",
            "capital_state": "zero_notional",
            "max_notional": "0",
            "blocking_reasons": [
                "alpha_readiness_not_promotion_eligible",
                "execution_tca_stale",
                "quant_pipeline_degraded",
                "simple_submit_disabled",
            ],
            "repair_ladder": [
                {},
                {
                    "code": "live_submit_gate_closed",
                    "reason": "simple_submit_disabled",
                    "priority": 80,
                    "expected_unblock_value": 1,
                },
                {
                    "code": "repair_alpha_readiness",
                    "reason": "alpha_readiness_not_promotion_eligible",
                    "priority": 70,
                    "expected_unblock_value": 3,
                },
                {
                    "code": "repair_execution_tca",
                    "reason": "execution_tca_stale",
                    "priority": 65,
                    "expected_unblock_value": 3,
                },
                {
                    "code": "repair_quant_ingestion",
                    "reason": "quant_pipeline_degraded",
                    "priority": 60,
                    "expected_unblock_value": 1,
                },
            ],
            "proof_dimensions": [
                {"dimension": "market_context"},
                {
                    "dimension": "alpha_readiness",
                    "source_ref": {
                        "promotion_eligible_total": 0,
                        "rollback_required_total": 3,
                        "state_totals": {"blocked": 1, "shadow": 2},
                        "hypothesis_ids": ["H-AAPL-ROUTE-REHAB"],
                        "blocked_hypothesis_ids": ["H-AAPL-ROUTE-REHAB"],
                        "promotion_eligible_hypothesis_ids": [],
                        "repair_target_count": 1,
                        "blocked_repair_target_count": 1,
                        "promotion_eligible_repair_target_count": 0,
                        "repair_targets": [
                            {
                                "hypothesis_id": "H-AAPL-ROUTE-REHAB",
                                "state": "shadow",
                                "promotion_eligible": False,
                                "reasons": [
                                    "alpha_readiness_not_promotion_eligible",
                                    "post_cost_expectancy_non_positive",
                                ],
                                "informational_reasons": [
                                    "closed_session_market_context_hold"
                                ],
                                "candidate_id": "chip-paper-microbar-composite@execution-proof",
                                "strategy_id": "intraday_tsmom_v1@paper",
                                "lane_id": "continuation",
                                "strategy_family": "intraday_continuation",
                            }
                        ],
                    },
                },
                {
                    "dimension": "execution_tca",
                    "state": "stale",
                    "reason": "execution_tca_stale",
                    "freshness_seconds": 2990000,
                    "threshold_seconds": 604800,
                    "source_ref": {
                        "order_count": 13775,
                        "last_computed_at": "2026-04-02T20:59:45.136640+00:00",
                        "avg_abs_slippage_bps": "568.6138848199565249",
                    },
                },
            ],
            "route_reacquisition_book": {
                "schema_version": "torghut.route-reacquisition-book.v1",
                "state": "repair_only",
                "capital_rule": "live_zero_notional_unchanged",
                "summary": {
                    "routeable_symbol_count": 0,
                    "probing_symbol_count": 0,
                    "blocked_symbol_count": 5,
                    "missing_symbol_count": 3,
                    "candidate_symbols": [],
                    "repair_candidate_count": 1,
                    "repair_candidate_symbols": ["AAPL"],
                    "repair_candidates": [
                        {
                            "rank": 1,
                            "symbol": "AAPL",
                            "state": "blocked",
                            "next_repair_action": "repair_route_evidence_before_paper_probe",
                            "paper_probe_notional_limit": "0",
                        }
                    ],
                    "expected_unblock_value": 13,
                },
            },
        },
        "quant_evidence": {
            "ok": False,
            "status": "degraded",
            "reason": "quant_pipeline_degraded",
            "max_stage_lag_seconds": 56287,
            "blocking_reasons": ["quant_pipeline_degraded"],
        },
        "capital_replay_board": {
            "schema_version": "torghut.capital-replay-board.v1",
            "board_id": "capital-replay:test",
            "selected_replays": ["replay:aapl-route-rehab"],
            "summary": {
                "selected_replay_count": 1,
                "zero_notional_replay_count": 1,
                "paper_replay_candidate_count": 0,
                "capital_ready": False,
            },
            "replay_items": [
                {
                    "replay_id": "replay:aapl-route-rehab",
                    "hypothesis_id": "H-AAPL-ROUTE-REHAB",
                    "replay_class": "route_rehab",
                    "target_symbols": ["AAPL"],
                    "remaining_blockers": [
                        "alpha_readiness_not_promotion_eligible",
                        "market_context_stale",
                    ],
                    "required_after_refs": [
                        "alpha_readiness_receipt",
                        "hypothesis_promotion_receipt",
                    ],
                    "max_notional": "0",
                }
            ],
        },
        "executable_alpha_receipts": {
            "schema_version": "torghut.executable-alpha-receipts.v1",
            "generated_at": "2026-05-07T16:00:00+00:00",
            "summary": {
                "receipts_total": 1,
                "zero_notional_receipt_count": 1,
                "paper_replay_candidate_count": 0,
                "capital_ready": False,
                "graduation_state_totals": {"candidate": 1},
            },
            "receipts": [
                {
                    "receipt_id": "receipt:aapl-route-rehab",
                    "replay_id": "replay:aapl-route-rehab",
                    "hypothesis_id": "H-AAPL-ROUTE-REHAB",
                    "graduation_state": "candidate",
                    "remaining_blockers": [
                        "alpha_readiness_not_promotion_eligible",
                    ],
                    "guardrail_result": {"state": "blocked", "passed": False},
                    "capital_effect": {
                        "capital_state": "zero_notional",
                        "max_notional": "0",
                    },
                }
            ],
        },
        "simple_lane_reject_reason_totals": {
            "insufficient_buying_power": 8,
        },
    }


def _ready_status() -> dict[str, object]:
    return {"status": "ok"}


def _ready_trading_status() -> dict[str, object]:
    return {
        "mode": "live",
        "pipeline_mode": "simple",
        "build": {"commit": "commit-1", "active_revision": "torghut-00253"},
        "live_submission_gate": {
            "allowed": True,
            "reason": "ready",
            "blocked_reasons": [],
            "configured_live_promotion": True,
        },
        "proof_floor": {
            "route_state": "candidate",
            "capital_state": "micro_canary",
            "max_notional": "25",
            "blocking_reasons": [],
            "repair_ladder": [],
            "proof_dimensions": [
                {
                    "dimension": "alpha_readiness",
                    "state": "pass",
                    "reason": "promotion_eligible",
                    "source_ref": {
                        "promotion_eligible_total": 2,
                        "rollback_required_total": 0,
                        "state_totals": {"candidate": 2},
                    },
                },
            ],
        },
        "quant_evidence": {"ok": True, "status": "healthy", "reason": "ready"},
    }


class TestBuildRevenueRepairDigest(TestCase):
    def test_direct_script_execution_supports_help(self) -> None:
        service_root = Path(__file__).resolve().parents[1]
        script_path = service_root / "scripts" / "build_revenue_repair_digest.py"

        result = subprocess.run(
            [sys.executable, str(script_path), "--help"],
            cwd=service_root,
            check=False,
            capture_output=True,
            text=True,
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("--readyz", result.stdout)

    def test_repair_only_payload_prioritizes_evidence_before_live_submit(self) -> None:
        digest = build_revenue_repair_digest(
            readyz_payload=_repair_only_readyz(),
            status_payload=_repair_only_status(),
            generated_at=NOW,
        )

        self.assertFalse(digest["revenue_ready"])
        self.assertEqual(digest["business_state"], "repair_only")
        capital = digest["capital"]
        self.assertIsInstance(capital, dict)
        self.assertEqual(capital["capital_state"], "zero_notional")
        self.assertEqual(capital["max_notional"], "0")
        blockers = {
            str(item["reason"]) for item in digest["blockers"] if isinstance(item, dict)
        }
        self.assertGreaterEqual(
            blockers,
            {
                "alpha_readiness_not_promotion_eligible",
                "execution_tca_stale",
                "quant_pipeline_degraded",
                "simple_submit_disabled",
            },
        )
        repair_queue = digest["repair_queue"]
        self.assertIsInstance(repair_queue, list)
        self.assertEqual(repair_queue[0]["code"], "repair_alpha_readiness")
        self.assertEqual(repair_queue[0]["value_gate"], "routeable_candidate_count")
        self.assertEqual(
            repair_queue[0]["required_output_receipt"],
            "torghut.executable-alpha-receipts.v1",
        )
        self.assertEqual(repair_queue[0]["max_notional"], "0")
        self.assertEqual(
            repair_queue[0]["capital_rule"],
            "zero_notional_repair_only",
        )
        self.assertEqual(repair_queue[1]["code"], "repair_execution_tca")
        self.assertNotIn("repair_repair_only", [item["code"] for item in repair_queue])
        self.assertIn(
            "keep_submit_disabled",
            str(
                [
                    item
                    for item in repair_queue
                    if item["code"] == "live_submit_gate_closed"
                ][0]["action"]
            ),
        )
        evidence = cast(dict[str, object], digest["evidence"])
        self.assertIsInstance(evidence, dict)
        alpha_readiness = evidence["alpha_readiness"]
        self.assertIsInstance(alpha_readiness, dict)
        self.assertEqual(
            alpha_readiness["hypothesis_ids"],
            ["H-AAPL-ROUTE-REHAB"],
        )
        self.assertEqual(
            alpha_readiness["blocked_hypothesis_ids"],
            ["H-AAPL-ROUTE-REHAB"],
        )
        self.assertEqual(alpha_readiness["repair_target_count"], 1)
        repair_targets = alpha_readiness["repair_targets"]
        self.assertIsInstance(repair_targets, list)
        self.assertEqual(repair_targets[0]["hypothesis_id"], "H-AAPL-ROUTE-REHAB")
        self.assertEqual(
            repair_targets[0]["candidate_id"],
            "chip-paper-microbar-composite@execution-proof",
        )
        self.assertEqual(repair_targets[0]["strategy_id"], "intraday_tsmom_v1@paper")
        capital_replay_board = alpha_readiness["capital_replay_board"]
        self.assertIsInstance(capital_replay_board, dict)
        self.assertEqual(
            capital_replay_board["board_id"],
            "capital-replay:test",
        )
        self.assertEqual(capital_replay_board["zero_notional_replay_count"], 1)
        self.assertFalse(capital_replay_board["capital_ready"])
        top_replays = capital_replay_board["top_zero_notional_replays"]
        self.assertIsInstance(top_replays, list)
        self.assertEqual(top_replays[0]["hypothesis_id"], "H-AAPL-ROUTE-REHAB")
        self.assertEqual(top_replays[0]["max_notional"], "0")
        executable_receipts = alpha_readiness["executable_alpha_receipts"]
        self.assertIsInstance(executable_receipts, dict)
        self.assertEqual(executable_receipts["zero_notional_receipt_count"], 1)
        self.assertFalse(executable_receipts["capital_ready"])
        candidate_receipts = executable_receipts["candidate_receipts"]
        self.assertIsInstance(candidate_receipts, list)
        self.assertEqual(candidate_receipts[0]["guardrail_state"], "blocked")
        self.assertFalse(candidate_receipts[0]["guardrail_passed"])
        self.assertEqual(candidate_receipts[0]["max_notional"], "0")
        route_reacquisition = evidence["route_reacquisition"]
        self.assertIsInstance(route_reacquisition, dict)
        self.assertEqual(route_reacquisition["state"], "repair_only")
        self.assertEqual(route_reacquisition["blocked_symbol_count"], 5)
        self.assertEqual(route_reacquisition["missing_symbol_count"], 3)
        self.assertEqual(route_reacquisition["repair_candidate_count"], 1)
        self.assertEqual(
            route_reacquisition["repair_candidate_symbols"],
            ["AAPL"],
        )
        self.assertEqual(
            route_reacquisition["repair_candidates"],
            [
                {
                    "rank": 1,
                    "symbol": "AAPL",
                    "state": "blocked",
                    "next_repair_action": "repair_route_evidence_before_paper_probe",
                    "paper_probe_notional_limit": "0",
                }
            ],
        )
        self.assertEqual(route_reacquisition["expected_unblock_value"], 13)

    def test_digest_defaults_generated_at_and_handles_missing_tca_dimension(
        self,
    ) -> None:
        status = _ready_trading_status()
        proof_floor = status["proof_floor"]
        self.assertIsInstance(proof_floor, dict)
        proof_floor["proof_dimensions"] = [
            item
            for item in proof_floor["proof_dimensions"]
            if isinstance(item, dict) and item.get("dimension") != "execution_tca"
        ]

        digest = build_revenue_repair_digest(
            readyz_payload=_ready_status(),
            status_payload=status,
        )

        self.assertTrue(str(digest["generated_at"]).endswith("+00:00"))
        evidence = digest["evidence"]
        self.assertIsInstance(evidence, dict)
        execution_tca = evidence["execution_tca"]
        self.assertIsInstance(execution_tca, dict)
        self.assertEqual(execution_tca["reason"], "missing")

    def test_digest_exposes_route_universe_repair_details(self) -> None:
        status = _repair_only_status()
        proof_floor = status["proof_floor"]
        self.assertIsInstance(proof_floor, dict)
        proof_floor["blocking_reasons"] = [
            "alpha_readiness_not_promotion_eligible",
            "execution_tca_route_universe_empty",
            "simple_submit_disabled",
        ]
        proof_floor["repair_ladder"] = [
            {
                "code": "repair_route_universe",
                "reason": "execution_tca_route_universe_empty",
                "priority": 78,
                "expected_unblock_value": 4,
            }
        ]
        execution_tca_dimension = [
            item
            for item in proof_floor["proof_dimensions"]
            if isinstance(item, dict) and item.get("dimension") == "execution_tca"
        ][0]
        source_ref = execution_tca_dimension["source_ref"]
        self.assertIsInstance(source_ref, dict)
        execution_tca_dimension["state"] = "fail"
        execution_tca_dimension["reason"] = "execution_tca_route_universe_empty"
        source_ref["slippage_guardrail_bps"] = "8"
        source_ref["aggregate_reason"] = "execution_tca_slippage_guardrail_exceeded"
        source_ref["symbol_routes"] = {
            "scope_symbols": ["AAPL", "NVDA", "ORCL"],
            "scope_symbol_count": 3,
            "slippage_guardrail_bps": "8",
            "routeable_symbol_count": 0,
            "blocked_symbol_count": 2,
            "missing_symbol_count": 1,
            "routeable_symbols": [],
            "blocked_symbols": [
                {"symbol": "AAPL", "order_count": 2033},
                {"symbol": "NVDA", "order_count": 3289},
            ],
            "missing_symbols": ["ORCL"],
        }

        digest = build_revenue_repair_digest(
            readyz_payload=_repair_only_readyz(),
            status_payload=status,
            generated_at=NOW,
        )

        blockers = {
            str(item["reason"]) for item in digest["blockers"] if isinstance(item, dict)
        }
        self.assertIn("execution_tca_route_universe_empty", blockers)
        evidence = digest["evidence"]
        self.assertIsInstance(evidence, dict)
        execution_tca = evidence["execution_tca"]
        self.assertIsInstance(execution_tca, dict)
        self.assertEqual(
            execution_tca["reason"],
            "execution_tca_route_universe_empty",
        )
        self.assertEqual(
            execution_tca["aggregate_reason"],
            "execution_tca_slippage_guardrail_exceeded",
        )
        symbol_routes = execution_tca["symbol_routes"]
        self.assertIsInstance(symbol_routes, dict)
        self.assertEqual(symbol_routes["routeable_symbol_count"], 0)
        self.assertEqual(symbol_routes["missing_symbols"], ["ORCL"])
        repair_queue = digest["repair_queue"]
        self.assertIsInstance(repair_queue, list)
        self.assertEqual(repair_queue[0]["code"], "repair_route_universe")
        self.assertEqual(
            repair_queue[0]["action"],
            "produce_executable_route_universe_before_capital",
        )

    def test_digest_does_not_prioritize_pass_state_route_exclusions(self) -> None:
        status = _repair_only_status()
        proof_floor = status["proof_floor"]
        self.assertIsInstance(proof_floor, dict)
        proof_floor["blocking_reasons"] = [
            "alpha_readiness_not_promotion_eligible",
            "simple_submit_disabled",
        ]
        proof_floor["repair_ladder"] = [
            {
                "code": "repair_route_universe",
                "reason": "execution_tca_route_universe_exclusions_applied",
                "action": "exclude_missing_or_high_slippage_symbols_before_promotion",
                "priority": 78,
                "expected_unblock_value": 7,
            },
            {
                "code": "repair_alpha_readiness",
                "reason": "alpha_readiness_not_promotion_eligible",
                "priority": 70,
                "expected_unblock_value": 3,
            },
        ]
        execution_tca_dimension = [
            item
            for item in proof_floor["proof_dimensions"]
            if isinstance(item, dict) and item.get("dimension") == "execution_tca"
        ][0]
        execution_tca_dimension["state"] = "pass"
        execution_tca_dimension["reason"] = (
            "execution_tca_route_universe_exclusions_applied"
        )

        digest = build_revenue_repair_digest(
            readyz_payload=_repair_only_readyz(),
            status_payload=status,
            generated_at=NOW,
        )

        repair_queue = digest["repair_queue"]
        self.assertIsInstance(repair_queue, list)
        self.assertEqual(repair_queue[0]["code"], "repair_alpha_readiness")
        self.assertNotIn(
            "execution_tca_route_universe_exclusions_applied",
            {str(item["reason"]) for item in repair_queue if isinstance(item, dict)},
        )

    def test_status_degraded_quant_reason_becomes_blocker_when_ok_flag_is_true(
        self,
    ) -> None:
        readyz = _ready_status()
        status = _ready_trading_status()
        status["quant_evidence"] = {
            "ok": True,
            "status": "degraded",
            "reason": "quant_pipeline_degraded",
        }

        reasons = _collect_blocking_reasons(readyz, status)

        self.assertIn("quant_pipeline_degraded", reasons)

    def test_scalar_helpers_cover_string_and_numeric_variants(self) -> None:
        self.assertEqual(_sequence(("a", "b")), ["a", "b"])
        self.assertEqual(_sequence("not-a-list"), [])
        self.assertTrue(_bool("allow"))
        self.assertFalse(_bool("blocked", default=True))
        self.assertTrue(_bool("not-recognized", default=True))
        self.assertEqual(_int(True), 1)
        self.assertEqual(_int(3.8), 3)
        self.assertEqual(_int("7.0"), 7)
        self.assertEqual(_int("not-a-number", default=9), 9)

    def test_repair_queue_derives_unknown_blocker_and_skips_empty_reasons(self) -> None:
        repair_queue = _build_repair_queue(
            {"route_state": "candidate", "repair_ladder": []},
            {"simple_lane_reject_reason_totals": {"insufficient_buying_power": 4}},
            ["", "insufficient_buying_power", "custom_blocker"],
        )

        repair_codes = [item["code"] for item in repair_queue]
        self.assertIn("repair_buying_power", repair_codes)
        self.assertIn("repair_custom_blocker", repair_codes)

    def test_business_state_distinguishes_capital_blocked_and_not_ready(self) -> None:
        self.assertEqual(
            _business_state(
                revenue_ready=False,
                proof_floor={"route_state": "candidate", "capital_state": "micro"},
                live_submission_gate={"allowed": False},
            ),
            "capital_blocked",
        )
        self.assertEqual(
            _business_state(
                revenue_ready=False,
                proof_floor={"route_state": "candidate", "capital_state": "micro"},
                live_submission_gate={"allowed": True},
            ),
            "not_revenue_ready",
        )

    def test_load_json_object_rejects_malformed_json(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "payload.json"
            path.write_text("{", encoding="utf-8")

            with self.assertRaises(ValueError):
                _load_json_object(path, field_name="status")

    def test_parse_generated_at_handles_empty_z_suffix_and_naive_values(self) -> None:
        self.assertIsNone(_parse_generated_at(None))
        self.assertIsNone(_parse_generated_at(" "))
        parsed = _parse_generated_at("2026-05-07T16:00:00Z")
        self.assertIsNotNone(parsed)
        self.assertEqual(parsed.tzinfo, timezone.utc)
        with self.assertRaises(ValueError):
            _parse_generated_at("2026-05-07T16:00:00")

    def test_cli_prints_digest_to_stdout(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            readyz_path = tmp / "readyz.json"
            status_path = tmp / "status.json"
            readyz_path.write_text(json.dumps(_ready_status()), encoding="utf-8")
            status_path.write_text(
                json.dumps(_ready_trading_status()), encoding="utf-8"
            )
            stdout = StringIO()

            with redirect_stdout(stdout):
                exit_code = main(
                    [
                        "--readyz-json",
                        str(readyz_path),
                        "--status-json",
                        str(status_path),
                    ]
                )

            self.assertEqual(exit_code, 0)
            payload = json.loads(stdout.getvalue())
            self.assertTrue(payload["revenue_ready"])
            self.assertEqual(payload["business_state"], "revenue_candidate")
            self.assertEqual(payload["repair_queue"], [])

    def test_cli_writes_digest_to_output_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            readyz_path = tmp / "readyz.json"
            status_path = tmp / "status.json"
            output_path = tmp / "digest.json"
            readyz_path.write_text(json.dumps(_repair_only_readyz()), encoding="utf-8")
            status_path.write_text(json.dumps(_repair_only_status()), encoding="utf-8")

            exit_code = main(
                [
                    "--readyz-json",
                    str(readyz_path),
                    "--status-json",
                    str(status_path),
                    "--generated-at",
                    NOW.isoformat(),
                    "--output",
                    str(output_path),
                ]
            )

            self.assertEqual(exit_code, 0)
            payload = json.loads(output_path.read_text(encoding="utf-8"))
            self.assertEqual(payload["business_state"], "repair_only")

    def test_cli_rejects_non_object_payload(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            readyz_path = tmp / "readyz.json"
            status_path = tmp / "status.json"
            readyz_path.write_text("[]", encoding="utf-8")
            status_path.write_text(json.dumps(_repair_only_status()), encoding="utf-8")

            exit_code = main(
                [
                    "--readyz-json",
                    str(readyz_path),
                    "--status-json",
                    str(status_path),
                ]
            )

            self.assertEqual(exit_code, 2)
