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
from app.trading.revenue_repair import _summarize_runtime_window_import_repair


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
                "paper_route_probe": {
                    "configured_enabled": True,
                    "configured_max_notional": "25.0",
                    "active": False,
                    "effective_max_notional": "0",
                    "next_session_max_notional": "25.0",
                    "eligible_symbol_count": 1,
                    "eligible_symbols": ["AAPL"],
                    "active_symbols": [],
                    "blocking_reasons": ["market_session_closed"],
                    "capital_authority": "none",
                },
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
                            "paper_route_probe": {
                                "eligible": True,
                                "active": False,
                                "notional_limit": "0",
                                "next_session_notional_limit": "25.0",
                                "blocking_reasons": ["market_session_closed"],
                                "capital_authority": "none",
                            },
                        }
                    ],
                    "paper_route_probe_eligible_symbols": ["AAPL"],
                    "paper_route_probe_active_symbols": [],
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
        "repair_bid_settlement_ledger": {
            "schema_version": "torghut.repair-bid-settlement-ledger.v1",
            "ledger_id": "repair-bid-settlement-ledger:test",
            "account_id": "PA3SX7FYNUTF",
            "session_id": "15m",
            "trading_mode": "live",
            "capital_decision": "repair_only",
            "max_notional": "0",
            "routeable_candidate_count": 0,
            "active_dedupe_keys": [],
            "compacted_lots": [
                {
                    "lot_id": "compacted-repair-lot:promotion",
                    "lot_class": "promotion_custody",
                    "target_value_gate": "routeable_candidate_count",
                    "priority": 60,
                    "expected_gate_delta": "retire_alpha_readiness_not_promotion_eligible",
                    "raw_reason_codes": ["alpha_readiness_not_promotion_eligible"],
                    "required_output_receipt": "torghut.promotion-custody-decision-receipt.v1",
                    "dedupe_key": "PA3SX7FYNUTF:15m:promotion_custody",
                    "ttl_seconds": 900,
                    "max_runtime_seconds": 1200,
                    "max_notional": "0",
                    "state": "held",
                    "dispatchable": False,
                    "hold_reason_codes": ["selection_limit_exceeded"],
                    "source_bid_ids": ["route-evidence-repair-bid:promotion"],
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
        self.assertEqual(digest["top_repair_queue_item"], repair_queue[0])
        self.assertEqual(digest["selected_value_gate"], "routeable_candidate_count")
        self.assertEqual(
            digest["required_output_receipt"],
            "torghut.executable-alpha-receipts.v1",
        )
        self.assertEqual(
            digest["required_receipts"],
            [
                "alpha_readiness_receipt",
                "hypothesis_promotion_receipt",
                "capital_replay_board",
            ],
        )
        self.assertEqual(digest["capital_state"], "zero_notional")
        self.assertEqual(digest["capital_stage"], "shadow")
        self.assertFalse(digest["live_submission_allowed"])
        self.assertEqual(digest["max_notional"], "0")
        self.assertEqual(
            digest["selected_hypothesis_id"],
            "H-AAPL-ROUTE-REHAB",
        )
        self.assertEqual(
            digest["selected_candidate_id"],
            "chip-paper-microbar-composite@execution-proof",
        )
        self.assertEqual(digest["selected_strategy_id"], "intraday_tsmom_v1@paper")
        self.assertEqual(digest["routeable_candidate_count_before"], 0)
        self.assertEqual(digest["routeable_candidate_count_after"], 0)
        self.assertEqual(digest["accepted_routeable_candidate_count"], 0)
        self.assertEqual(digest["routeable_candidate_delta"], 0)
        self.assertEqual(digest["no_delta_reentry_decision"], "deny")
        self.assertEqual(
            digest["repair_bid_settlement_status"],
            "repair_only",
        )
        self.assertEqual(
            digest["repair_bid_settlement_held_lot_ids"],
            ["compacted-repair-lot:promotion"],
        )
        evidence = digest["evidence"]
        self.assertIsInstance(evidence, dict)
        route_reacquisition = evidence["route_reacquisition"]
        self.assertIsInstance(route_reacquisition, dict)
        self.assertEqual(
            route_reacquisition["paper_route_probe_eligible_symbols"], ["AAPL"]
        )
        self.assertEqual(route_reacquisition["paper_route_probe_active_symbols"], [])
        paper_route_probe = route_reacquisition["paper_route_probe"]
        self.assertIsInstance(paper_route_probe, dict)
        self.assertTrue(paper_route_probe["configured_enabled"])
        self.assertFalse(paper_route_probe["active"])
        self.assertEqual(paper_route_probe["next_session_max_notional"], "25.0")
        self.assertEqual(paper_route_probe["eligible_symbols"], ["AAPL"])
        self.assertEqual(
            paper_route_probe["blocking_reasons"], ["market_session_closed"]
        )
        self.assertEqual(paper_route_probe["capital_authority"], "none")
        self.assertIn(
            "jangar_material_evidence_settlement_ref_unavailable",
            digest["field_unavailable_reason_codes"],
        )
        self.assertIn(
            "uv run --frozen pytest tests/test_build_revenue_repair_digest.py -k revenue_repair",
            digest["validation_commands"],
        )
        self.assertIn("max_notional=0", str(digest["rollback_target"]))
        strike_ledger = digest["alpha_readiness_strike_ledger"]
        self.assertIsInstance(strike_ledger, dict)
        self.assertEqual(
            strike_ledger["schema_version"],
            "torghut.alpha-readiness-strike-ledger.v1",
        )
        self.assertEqual(strike_ledger["status"], "dispatchable")
        self.assertEqual(
            strike_ledger["selected_business_blocker"]["value_gate"],
            "routeable_candidate_count",
        )
        strike_slots = strike_ledger["strike_slots"]
        self.assertIsInstance(strike_slots, list)
        self.assertEqual(strike_slots[0]["lot_class"], "promotion_custody")
        self.assertEqual(
            strike_slots[0]["required_output_receipt"],
            "torghut.promotion-custody-decision-receipt.v1",
        )
        self.assertEqual(strike_slots[0]["max_notional"], "0")
        self.assertGreaterEqual(
            set(strike_ledger["guarded_action_classes"]),
            {"paper_canary", "live_micro_canary", "live_scale"},
        )
        self.assertIn("max_notional=0", strike_ledger["rollback_target"])
        repair_receipts = digest["executable_alpha_repair_receipts"]
        self.assertIsInstance(repair_receipts, dict)
        self.assertEqual(
            repair_receipts["schema_version"],
            "torghut.executable-alpha-repair-receipts.v1",
        )
        self.assertEqual(repair_receipts["status"], "selected")
        self.assertEqual(
            repair_receipts["target_value_gate"], "routeable_candidate_count"
        )
        self.assertEqual(repair_receipts["max_notional"], "0")
        selected_repair_receipt = repair_receipts["selected_receipt"]
        self.assertIsInstance(selected_repair_receipt, dict)
        self.assertEqual(
            selected_repair_receipt["schema_version"],
            "torghut.executable-alpha-repair-receipt.v1",
        )
        self.assertEqual(
            selected_repair_receipt["hypothesis_id"],
            "H-AAPL-ROUTE-REHAB",
        )
        self.assertEqual(
            selected_repair_receipt["target_value_gate"],
            "routeable_candidate_count",
        )
        self.assertEqual(selected_repair_receipt["max_notional"], "0")
        self.assertTrue(selected_repair_receipt["no_delta_settlement_required"])
        settlement_slots = digest["executable_alpha_settlement_slots"]
        self.assertIsInstance(settlement_slots, dict)
        self.assertEqual(
            settlement_slots["schema_version"],
            "torghut.executable-alpha-settlement-slots.v1",
        )
        self.assertEqual(settlement_slots["status"], "settled")
        self.assertEqual(settlement_slots["max_notional"], "0")
        selected_slot = settlement_slots["selected_slot"]
        self.assertIsInstance(selected_slot, dict)
        self.assertEqual(
            selected_slot["schema_version"],
            "torghut.executable-alpha-settlement-slot.v1",
        )
        self.assertEqual(
            selected_slot["selected_receipt_id"],
            selected_repair_receipt["receipt_id"],
        )
        self.assertEqual(selected_slot["settlement_state"], "no_delta")
        self.assertEqual(
            selected_slot["no_delta_reason"],
            "routeable_candidate_count_unchanged",
        )
        self.assertEqual(len(settlement_slots["no_delta_debt"]), 1)
        closure_board = digest["alpha_repair_closure_board"]
        self.assertIsInstance(closure_board, dict)
        self.assertEqual(
            closure_board["schema_version"],
            "torghut.alpha-repair-closure-board.v1",
        )
        self.assertEqual(closure_board["status"], "selected")
        self.assertEqual(
            closure_board["selected_value_gate"], "routeable_candidate_count"
        )
        self.assertEqual(closure_board["max_notional"], "0")
        repair_closures = closure_board["repair_closures"]
        self.assertIsInstance(repair_closures, list)
        self.assertEqual(repair_closures[0]["queue_code"], "repair_alpha_readiness")
        self.assertEqual(
            repair_closures[0]["required_output_receipt"],
            "torghut.executable-alpha-receipts.v1",
        )
        self.assertEqual(
            repair_closures[0]["no_delta_reason"],
            "routeable_candidate_count_unchanged",
        )
        self.assertEqual(len(closure_board["no_delta_debt"]), 1)
        alpha_foundry = digest["alpha_evidence_foundry"]
        self.assertIsInstance(alpha_foundry, dict)
        self.assertEqual(
            alpha_foundry["schema_version"],
            "torghut.alpha-evidence-foundry.v1",
        )
        self.assertEqual(alpha_foundry["status"], "selected")
        self.assertEqual(alpha_foundry["selected_queue_code"], "repair_alpha_readiness")
        self.assertEqual(
            alpha_foundry["selected_value_gate"], "routeable_candidate_count"
        )
        self.assertEqual(
            alpha_foundry["required_output_receipt"],
            "torghut.alpha-evidence-window-receipt.v1",
        )
        self.assertEqual(alpha_foundry["routeable_candidate_count_before"], 0)
        self.assertEqual(alpha_foundry["max_notional"], "0")
        alpha_window_receipts = alpha_foundry["receipts"]
        self.assertIsInstance(alpha_window_receipts, list)
        self.assertEqual(
            alpha_window_receipts[0]["hypothesis_id"],
            "H-AAPL-ROUTE-REHAB",
        )
        self.assertEqual(
            alpha_window_receipts[0]["post_cost_expectancy_state"],
            "blocked",
        )
        self.assertEqual(len(alpha_foundry["no_delta_debt"]), 1)
        settlement_conveyor = digest["alpha_readiness_settlement_conveyor"]
        self.assertIsInstance(settlement_conveyor, dict)
        self.assertEqual(
            settlement_conveyor["schema_version"],
            "torghut.alpha-readiness-settlement-conveyor.v1",
        )
        self.assertEqual(settlement_conveyor["status"], "no_delta")
        self.assertEqual(
            settlement_conveyor["selected_value_gate"],
            "routeable_candidate_count",
        )
        self.assertEqual(
            settlement_conveyor["required_output_receipt"],
            "torghut.alpha-readiness-settlement-receipt.v1",
        )
        self.assertEqual(settlement_conveyor["max_notional"], "0")
        selected_lane = settlement_conveyor["selected_lane"]
        self.assertIsInstance(selected_lane, dict)
        self.assertEqual(
            selected_lane["repeat_launch_decision"],
            "deny",
        )
        alpha_dividend_ledger = digest["alpha_repair_dividend_ledger"]
        self.assertIsInstance(alpha_dividend_ledger, dict)
        self.assertEqual(
            alpha_dividend_ledger["schema_version"],
            "torghut.alpha-repair-dividend-ledger.v1",
        )
        self.assertEqual(alpha_dividend_ledger["dividend_state"], "no_delta")
        self.assertEqual(
            alpha_dividend_ledger["selected_value_gate"],
            "routeable_candidate_count",
        )
        self.assertEqual(alpha_dividend_ledger["max_notional"], "0")
        self.assertEqual(
            alpha_dividend_ledger["jangar_custody"]["required_recorder_schema"],
            "jangar.material-action-custody-flight-recorder.v1",
        )
        self.assertEqual(
            alpha_dividend_ledger["jangar_custody"]["launch_decision"],
            "deny",
        )
        controller_carry = digest["jangar_controller_ingestion_carry"]
        self.assertIsInstance(controller_carry, dict)
        self.assertEqual(
            controller_carry["schema_version"],
            "torghut.jangar-controller-ingestion-carry.v1",
        )
        self.assertEqual(controller_carry["carry_state"], "unavailable")
        self.assertEqual(controller_carry["selected_ticket_class"], "none")
        self.assertEqual(controller_carry["max_notional"], "0")
        self.assertIn(
            "jangar_controller_ingestion_settlement_missing",
            controller_carry["reason_codes"],
        )
        no_delta_auction = digest["no_delta_repair_reentry_auction"]
        self.assertIsInstance(no_delta_auction, dict)
        self.assertEqual(
            no_delta_auction["schema_version"],
            "torghut.no-delta-repair-reentry-auction.v1",
        )
        self.assertEqual(no_delta_auction["reentry_decision"], "deny")
        self.assertEqual(
            no_delta_auction["selected_value_gate"],
            "routeable_candidate_count",
        )
        self.assertEqual(no_delta_auction["selected_ticket"], None)
        self.assertEqual(no_delta_auction["max_notional"], "0")
        self.assertEqual(
            no_delta_auction["jangar_controller_ingestion_carry"]["carry_state"],
            "unavailable",
        )
        self.assertIn(
            "duplicate_no_delta_reentry_denied",
            no_delta_auction["reason_codes"],
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
                    "paper_route_probe": {
                        "eligible": True,
                        "active": False,
                        "notional_limit": "0",
                        "next_session_notional_limit": "25.0",
                        "blocking_reasons": ["market_session_closed"],
                        "capital_authority": "none",
                    },
                }
            ],
        )
        self.assertEqual(route_reacquisition["expected_unblock_value"], 13)

    def test_repair_only_payload_surfaces_source_collection_import_targets(
        self,
    ) -> None:
        status = _repair_only_status()
        live_gate = status["live_submission_gate"]
        self.assertIsInstance(live_gate, dict)
        live_gate["blocked_reasons"] = [
            "simple_submit_disabled",
            "runtime_ledger_source_collection_pending",
        ]
        live_gate["runtime_ledger_paper_probation_import_plan"] = {
            "schema_version": "torghut.runtime-ledger-paper-probation-import-plan.v1",
            "source": "runtime_ledger_paper_probation_and_source_collection_candidates",
            "purpose": "paper_stage_runtime_ledger_source_evidence_collection",
            "target_count": 1,
            "paper_probation_target_count": 0,
            "source_collection_target_count": 1,
            "skipped_target_count": 0,
            "promotion_allowed": False,
            "final_promotion_allowed": False,
            "targets": [
                {
                    "hypothesis_id": "H-TSMOM-LIQ-01",
                    "candidate_id": "cand-source-collection",
                    "observed_stage": "paper",
                    "strategy_family": "intraday_tsmom_consistent",
                    "strategy_name": "intraday-tsmom-profit-v3",
                    "account_label": "TORGHUT_SIM",
                    "source_account_label": "TORGHUT_SIM",
                    "source_dsn_env": "SIM_DB_DSN",
                    "target_dsn_env": "SIM_DB_DSN",
                    "source_kind": "runtime_ledger_source_collection_candidate",
                    "source_manifest_ref": (
                        "config/trading/hypotheses/h-tsmom-liq-01.json"
                    ),
                    "dataset_snapshot_ref": "portfolio-profit-autoresearch-500-v1",
                    "window_start": "2026-06-02T13:30:00+00:00",
                    "window_end": "2026-06-02T20:00:00+00:00",
                    "source_collection_authorized": True,
                    "source_collection_authorization_scope": (
                        "source_window_evidence_collection_only"
                    ),
                    "source_collection_reason_codes": [
                        "paper_probe_runtime_activity_positive"
                    ],
                    "final_promotion_blockers": [
                        "runtime_ledger_source_collection_only",
                        "runtime_ledger_pnl_basis_missing",
                    ],
                    "candidate_blockers": ["runtime_ledger_candidate_mismatch"],
                    "handoff": "runtime_ledger_source_collection_import",
                    "probation_reason": "source_window_evidence_collection_pending",
                    "max_notional": "0",
                    "promotion_allowed": False,
                    "final_promotion_allowed": False,
                    "final_promotion_authorized": False,
                    "final_authority_ok": False,
                }
            ],
            "skipped_targets": [],
        }

        digest = build_revenue_repair_digest(
            readyz_payload=_repair_only_readyz(),
            status_payload=status,
            generated_at=NOW,
        )

        repair_queue = digest["repair_queue"]
        self.assertIsInstance(repair_queue, list)
        self.assertEqual(repair_queue[0]["code"], "repair_source_runtime_window_import")
        self.assertEqual(
            repair_queue[0]["action"],
            "import_source_collection_runtime_ledger_window_before_alpha_promotion",
        )
        self.assertEqual(
            repair_queue[0]["required_output_receipt"],
            "torghut.runtime-window-import-readback.v1",
        )
        self.assertEqual(repair_queue[0]["max_notional"], "0")
        self.assertFalse(repair_queue[0].get("promotion_allowed", False))
        self.assertEqual(
            digest["runtime_window_import_repair_status"],
            "source_collection_pending",
        )
        self.assertEqual(
            digest["runtime_window_import_next_action"],
            "run_runtime_window_import_for_source_collection_targets",
        )
        self.assertEqual(digest["runtime_window_import_target_count"], 1)
        self.assertEqual(
            digest["runtime_window_import_source_collection_target_count"], 1
        )
        self.assertEqual(
            digest["runtime_window_import_paper_probation_target_count"], 0
        )
        evidence = digest["evidence"]
        self.assertIsInstance(evidence, dict)
        runtime_import = evidence["runtime_window_import_repair"]
        self.assertIsInstance(runtime_import, dict)
        self.assertEqual(runtime_import["promotion_allowed"], False)
        self.assertEqual(runtime_import["final_promotion_allowed"], False)
        top_targets = runtime_import["top_targets"]
        self.assertIsInstance(top_targets, list)
        self.assertEqual(top_targets[0]["hypothesis_id"], "H-TSMOM-LIQ-01")
        self.assertEqual(top_targets[0]["candidate_id"], "cand-source-collection")
        self.assertEqual(top_targets[0]["source_dsn_env"], "SIM_DB_DSN")
        self.assertEqual(top_targets[0]["target_dsn_env"], "SIM_DB_DSN")
        self.assertEqual(top_targets[0]["observed_stage"], "paper")
        self.assertTrue(top_targets[0]["source_collection_authorized"])
        self.assertEqual(
            top_targets[0]["source_collection_authorization_scope"],
            "source_window_evidence_collection_only",
        )
        self.assertEqual(top_targets[0]["max_notional"], "0")
        self.assertFalse(top_targets[0]["promotion_allowed"])
        self.assertFalse(top_targets[0]["final_promotion_allowed"])
        self.assertIn(
            "runtime_ledger_pnl_basis_missing",
            top_targets[0]["final_promotion_blockers"],
        )
        self.assertIn(
            "runtime_ledger_candidate_mismatch",
            top_targets[0]["candidate_blockers"],
        )

    def test_runtime_window_import_repair_summarizes_non_source_plan_states(
        self,
    ) -> None:
        paper_summary = _summarize_runtime_window_import_repair(
            {
                "blocked_reasons": ["runtime_ledger_paper_probation_pending"],
                "runtime_ledger_paper_probation_import_plan": {
                    "schema_version": (
                        "torghut.runtime-ledger-paper-probation-import-plan.v1"
                    ),
                    "target_count": 1,
                    "paper_probation_target_count": 1,
                    "source_collection_target_count": 0,
                    "targets": [
                        {
                            "hypothesis_id": "H-PAPER",
                            "candidate_id": "cand-paper",
                            "source_kind": "paper_route_probe_runtime_observed",
                            "paper_probation_authorized": True,
                            "handoff": "runtime_ledger_paper_probation_import",
                            "max_notional": "0",
                        }
                    ],
                },
            }
        )
        self.assertEqual(paper_summary["status"], "paper_probation_import_pending")
        self.assertEqual(
            paper_summary["next_action"],
            "run_runtime_window_import_for_paper_probation_targets",
        )
        paper_targets = paper_summary["top_targets"]
        self.assertIsInstance(paper_targets, list)
        self.assertEqual(paper_targets[0]["candidate_id"], "cand-paper")
        self.assertFalse(paper_targets[0]["source_collection_authorized"])
        self.assertTrue(paper_targets[0]["paper_probation_authorized"])

        skipped_summary = _summarize_runtime_window_import_repair(
            {
                "blocked_reasons": ["runtime_ledger_source_collection_pending"],
                "runtime_ledger_paper_probation_import_plan": {
                    "target_count": 0,
                    "skipped_target_count": 1,
                    "targets": [],
                    "skipped_targets": [
                        {
                            "hypothesis_id": "H-SKIP",
                            "candidate_id": "cand-skip",
                            "reason": (
                                "runtime_ledger_paper_probation_target_missing_required_fields"
                            ),
                            "missing_fields": ["window_start"],
                        }
                    ],
                },
            }
        )
        self.assertEqual(skipped_summary["status"], "target_plan_repair_required")
        self.assertEqual(
            skipped_summary["next_action"], "repair_runtime_window_import_target_fields"
        )
        skipped_targets = skipped_summary["skipped_targets"]
        self.assertIsInstance(skipped_targets, list)
        self.assertEqual(skipped_targets[0]["missing_fields"], ["window_start"])

        raw_target_summary = _summarize_runtime_window_import_repair(
            {
                "runtime_ledger_paper_probation_import_plan": {
                    "target_count": 1,
                    "targets": [
                        {
                            "hypothesis_id": "H-RAW",
                            "candidate_id": "cand-raw",
                            "source_kind": "paper_route_candidate_unclassified",
                            "max_notional": "0",
                        }
                    ],
                    "skipped_targets": [],
                },
            }
        )
        self.assertEqual(raw_target_summary["status"], "empty")
        self.assertEqual(
            raw_target_summary["next_action"],
            "wait_for_runtime_window_import_candidates",
        )
        raw_targets = raw_target_summary["top_targets"]
        self.assertIsInstance(raw_targets, list)
        self.assertEqual(raw_targets[0]["candidate_id"], "cand-raw")

    def test_repair_only_payload_selects_repairable_jangar_carry_ticket(self) -> None:
        status_payload = _repair_only_status()
        status_payload["dependency_quorum"] = {
            "controller_ingestion_settlement": {
                "settlement_id": "controller-ingestion-settlement:repairable",
                "decision": "repair_only",
                "controller_ingestion_current": False,
                "selected_repair_ticket": {
                    "ticket_id": "verify-trust-foreclosure-ticket:repairable",
                    "ticket_class": "jangar_verify_carry",
                    "required_output_receipt": (
                        "jangar.verify-trust-foreclosure-ticket.v1"
                    ),
                    "validation_commands": [
                        "bun run --filter jangar test -- services/jangar/src/server/__tests__/control-plane-verify-trust-foreclosure.test.ts"
                    ],
                },
            }
        }

        digest = build_revenue_repair_digest(
            readyz_payload=_repair_only_readyz(),
            status_payload=status_payload,
            generated_at=NOW,
        )

        controller_carry = cast(
            dict[str, object], digest["jangar_controller_ingestion_carry"]
        )
        self.assertEqual(controller_carry["carry_state"], "repairable")
        self.assertEqual(
            controller_carry["selected_ticket_class"], "jangar_verify_carry"
        )
        no_delta_auction = cast(
            dict[str, object], digest["no_delta_repair_reentry_auction"]
        )
        self.assertEqual(no_delta_auction["reentry_decision"], "allow")
        selected_ticket = cast(dict[str, object], no_delta_auction["selected_ticket"])
        self.assertEqual(selected_ticket["ticket_class"], "jangar_verify_carry")
        self.assertEqual(
            selected_ticket["release_condition"],
            "jangar_controller_ingestion_current",
        )
        self.assertEqual(selected_ticket["max_notional"], "0")

    def test_repair_only_payload_carries_readyz_database_contract(self) -> None:
        readyz_payload = _repair_only_readyz()
        dependencies = readyz_payload["dependencies"]
        self.assertIsInstance(dependencies, dict)
        dependencies["database"] = {
            "ok": True,
            "schema_current": True,
            "schema_current_heads": ["0029_live_submission_gate"],
        }

        digest = build_revenue_repair_digest(
            readyz_payload=readyz_payload,
            status_payload=_repair_only_status(),
            generated_at=NOW,
        )

        closure_board = digest["alpha_repair_closure_board"]
        self.assertIsInstance(closure_board, dict)
        self.assertTrue(closure_board["db_schema_current"])
        self.assertNotIn("db_check_not_provided", closure_board["reason_codes"])

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
