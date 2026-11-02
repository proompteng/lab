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
from app.trading.revenue_repair import (
    summarize_runtime_window_import_repair as _summarize_runtime_window_import_repair,
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
                "hypothesis_not_promotion_eligible",
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
                    "reason": "hypothesis_not_promotion_eligible",
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
                                    "hypothesis_not_promotion_eligible",
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
                        "hypothesis_not_promotion_eligible",
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
                        "hypothesis_not_promotion_eligible",
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
                    "expected_gate_delta": "retire_hypothesis_not_promotion_eligible",
                    "raw_reason_codes": ["hypothesis_not_promotion_eligible"],
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
        "execution": {
            "reject_reason_totals": {
                "insufficient_buying_power": 8,
            },
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


class _TestBuildRevenueRepairDigestBase(TestCase):
    pass


__all__: tuple[str, ...] = (
    "NOW",
    "Path",
    "StringIO",
    "TestCase",
    "_TestBuildRevenueRepairDigestBase",
    "_bool",
    "_build_repair_queue",
    "_business_state",
    "_collect_blocking_reasons",
    "_int",
    "_load_json_object",
    "_parse_generated_at",
    "_ready_status",
    "_ready_trading_status",
    "_repair_only_readyz",
    "_repair_only_status",
    "_sequence",
    "_summarize_runtime_window_import_repair",
    "build_revenue_repair_digest",
    "cast",
    "datetime",
    "json",
    "main",
    "redirect_stdout",
    "subprocess",
    "sys",
    "tempfile",
    "timezone",
)
