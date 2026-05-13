from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime, timezone
from typing import Any

from app.trading.zero_notional_repair_executor import (
    ZERO_NOTIONAL_REPAIR_EXECUTION_SCHEMA_VERSION,
    build_zero_notional_repair_execution_receipt,
    run_zero_notional_repair,
)


NOW = datetime(2026, 5, 13, 0, 20, tzinfo=timezone.utc)


def _frontier(action: str = "refresh_stale_market_context_domains") -> dict[str, Any]:
    return {
        "schema_version": "torghut.profit-freshness-frontier.v1",
        "frontier_id": "profit-freshness-frontier:test",
        "capital_posture": {
            "capital_state": "zero_notional",
            "paper_notional_limit": "0",
            "live_notional_limit": "0",
            "capital_behavior_changed": False,
        },
        "selected_zero_notional_repairs": [
            {
                "lot_id": "profit-freshness-repair-lot:test",
                "candidate_id": "candidate-a",
                "hypothesis_id": "H-AAPL",
                "blocked_dimension": "market_context",
                "zero_notional_action": action,
                "before_refs": ["market_context:AAPL"],
                "paper_notional_limit": "0",
                "live_notional_limit": "0",
                "state": "selected_zero_notional_repair",
            }
        ],
    }


def test_dry_run_receipt_keeps_selected_repair_zero_notional() -> None:
    receipt = build_zero_notional_repair_execution_receipt(
        account_label="paper",
        trading_mode="live",
        torghut_revision="torghut-00320",
        source_commit="abc123",
        profit_freshness_frontier=_frontier(),
        execute=False,
        now=NOW,
    )

    assert receipt["schema_version"] == ZERO_NOTIONAL_REPAIR_EXECUTION_SCHEMA_VERSION
    assert receipt["execution_state"] == "dry_run_ready"
    assert receipt["command_exit_code"] == 0
    assert receipt["order_submission_enabled"] is False
    assert receipt["paper_notional_limit"] == "0"
    assert receipt["live_notional_limit"] == "0"
    assert receipt["before_refs"] == ["market_context:AAPL"]
    assert receipt["value_gate"] == "zero_notional_or_stale_evidence_rate"


def test_execute_runs_allowlisted_tca_runner_without_widening_notional() -> None:
    called: list[Mapping[str, Any]] = []

    def runner(repair: Mapping[str, Any]) -> Mapping[str, object]:
        called.append(repair)
        return {
            "execution_state": "executed",
            "command_exit_code": 0,
            "after_refs": ["execution_tca_metrics"],
        }

    receipt = run_zero_notional_repair(
        account_label="paper",
        trading_mode="live",
        torghut_revision="torghut-00320",
        source_commit="abc123",
        profit_freshness_frontier=_frontier("recompute_route_tca_and_fill_quality"),
        execute=True,
        runners={"recompute_route_tca_and_fill_quality": runner},
        now=NOW,
    )

    assert len(called) == 1
    assert receipt["execution_state"] == "executed"
    assert receipt["command_exit_code"] == 0
    assert receipt["after_refs"] == ["execution_tca_metrics"]
    assert receipt["value_gate"] == "fill_tca_or_slippage_quality"
    assert receipt["capital_behavior_changed"] is False
    assert receipt["paper_notional_limit"] == "0"
    assert receipt["live_notional_limit"] == "0"


def test_runner_required_action_reports_admission_block_when_executed_without_runner() -> (
    None
):
    receipt = run_zero_notional_repair(
        account_label="paper",
        trading_mode="live",
        torghut_revision="torghut-00320",
        source_commit="abc123",
        profit_freshness_frontier=_frontier("renew_empirical_proof_jobs"),
        execute=True,
        runners={},
        now=NOW,
    )

    assert receipt["execution_state"] == "runner_admission_required"
    assert receipt["command_exit_code"] == 78
    assert receipt["requires_jangar_admission"] is True
    assert "zero_notional_runner_admission_required" in receipt["blocked_reasons"]
    assert receipt["order_submission_enabled"] is False


def test_nonzero_frontier_notional_blocks_repair_execution() -> None:
    frontier = _frontier("recompute_route_tca_and_fill_quality")
    frontier["capital_posture"]["paper_notional_limit"] = "5"

    receipt = run_zero_notional_repair(
        account_label="paper",
        trading_mode="live",
        torghut_revision="torghut-00320",
        source_commit="abc123",
        profit_freshness_frontier=frontier,
        execute=True,
        runners={
            "recompute_route_tca_and_fill_quality": lambda _repair: {
                "execution_state": "executed",
                "command_exit_code": 0,
            }
        },
        now=NOW,
    )

    assert receipt["execution_state"] == "capital_safety_blocked"
    assert receipt["command_exit_code"] == 78
    assert "frontier_paper_notional_nonzero" in receipt["blocked_reasons"]
    assert receipt["after_refs"] == []


def test_fallback_repair_lot_selection_keeps_route_tca_repair_dry_run_ready() -> None:
    frontier = _frontier("recompute_route_tca_and_fill_quality")
    frontier.pop("selected_zero_notional_repairs")
    frontier["repair_lots"] = [
        {
            "lot_id": "ignored",
            "state": "blocked",
            "zero_notional_action": "renew_empirical_proof_jobs",
        },
        {
            "lot_id": "profit-freshness-repair-lot:tca",
            "candidate_id": "candidate-b",
            "hypothesis_id": "H-MSFT",
            "blocked_dimension": "execution_tca",
            "zero_notional_action": "recompute_route_tca_and_fill_quality",
            "before_refs": ["execution_tca:MSFT"],
            "paper_notional_limit": "0",
            "live_notional_limit": "0",
            "state": "selected_zero_notional_repair",
        },
    ]

    receipt = run_zero_notional_repair(
        account_label="paper",
        trading_mode="live",
        torghut_revision="torghut-00320",
        source_commit="abc123",
        profit_freshness_frontier=frontier,
        execute=False,
        runners={},
        now=NOW,
    )

    assert receipt["execution_state"] == "dry_run_ready"
    assert receipt["repair_lot_ref"] == "profit-freshness-repair-lot:tca"
    assert receipt["before_refs"] == ["execution_tca:MSFT"]
    assert receipt["executor"] == "route_tca_recompute"


def test_missing_or_unsupported_repair_is_fail_closed() -> None:
    frontier_without_repair = _frontier()
    frontier_without_repair["selected_zero_notional_repairs"] = []

    missing_receipt = build_zero_notional_repair_execution_receipt(
        account_label="paper",
        trading_mode="live",
        torghut_revision="torghut-00320",
        source_commit="abc123",
        profit_freshness_frontier=frontier_without_repair,
        execute=True,
        now=NOW,
    )

    assert missing_receipt["execution_state"] == "no_selected_repair"
    assert missing_receipt["command_exit_code"] == 78
    assert (
        "profit_freshness_frontier_selected_repair_missing"
        in missing_receipt["blocked_reasons"]
    )
    assert missing_receipt["zero_notional_action"] is None

    unsupported_frontier = _frontier("")
    unsupported_receipt = build_zero_notional_repair_execution_receipt(
        account_label="paper",
        trading_mode="live",
        torghut_revision="torghut-00320",
        source_commit="abc123",
        profit_freshness_frontier=unsupported_frontier,
        execute=True,
        now=NOW,
    )

    assert unsupported_receipt["execution_state"] == "unsupported_action"
    assert unsupported_receipt["command_exit_code"] == 78
    assert (
        "zero_notional_action_not_allowlisted:"
        in unsupported_receipt["blocked_reasons"]
    )


def test_execute_without_local_runner_is_fail_closed() -> None:
    receipt = run_zero_notional_repair(
        account_label="paper",
        trading_mode="live",
        torghut_revision="torghut-00320",
        source_commit="abc123",
        profit_freshness_frontier=_frontier("recompute_route_tca_and_fill_quality"),
        execute=True,
        runners={},
        now=NOW,
    )

    assert receipt["execution_state"] == "runner_not_configured"
    assert receipt["command_exit_code"] == 78
    assert "zero_notional_runner_not_configured" in receipt["blocked_reasons"]
    assert receipt["order_submission_enabled"] is False


def test_all_nonzero_notional_and_capital_change_markers_block_execution() -> None:
    frontier = _frontier("recompute_route_tca_and_fill_quality")
    frontier["capital_posture"]["paper_notional_limit"] = "1"
    frontier["capital_posture"]["live_notional_limit"] = "2"
    frontier["capital_posture"]["capital_behavior_changed"] = "true"
    selected_repair = frontier["selected_zero_notional_repairs"][0]
    selected_repair["paper_notional_limit"] = "3"
    selected_repair["live_notional_limit"] = "4"

    receipt = run_zero_notional_repair(
        account_label="paper",
        trading_mode="live",
        torghut_revision="torghut-00320",
        source_commit="abc123",
        profit_freshness_frontier=frontier,
        execute=True,
        runners={
            "recompute_route_tca_and_fill_quality": lambda _repair: {
                "execution_state": "executed",
                "command_exit_code": 0,
            }
        },
        now=NOW,
    )

    assert receipt["execution_state"] == "capital_safety_blocked"
    assert receipt["command_exit_code"] == 78
    assert receipt["blocked_reasons"] == [
        "frontier_paper_notional_nonzero",
        "frontier_live_notional_nonzero",
        "repair_paper_notional_nonzero",
        "repair_live_notional_nonzero",
        "frontier_capital_behavior_changed",
    ]
