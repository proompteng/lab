from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime, timezone
from typing import Any

from app.trading.zero_notional_repair_executor import (
    REPAIR_LOT_DISPATCH_TICKET_SCHEMA_VERSION,
    ZERO_NOTIONAL_REPAIR_EXECUTION_SCHEMA_VERSION,
    build_zero_notional_repair_execution_receipt,
    run_zero_notional_repair,
)


NOW = datetime(2026, 5, 13, 0, 20, tzinfo=timezone.utc)


def _frontier(action: str = "renew_empirical_proof_jobs") -> dict[str, Any]:
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
                "blocked_dimension": "empirical_proof",
                "zero_notional_action": action,
                "before_refs": ["empirical:H-AAPL"],
                "paper_notional_limit": "0",
                "live_notional_limit": "0",
                "state": "selected_zero_notional_repair",
            }
        ],
    }


def _dispatch_ticket(
    lot_id: str = "profit-freshness-repair-lot:test",
    overrides: Mapping[str, object] | None = None,
) -> dict[str, object]:
    ticket: dict[str, object] = {
        "schema_version": REPAIR_LOT_DISPATCH_TICKET_SCHEMA_VERSION,
        "ticket_id": "repair-lot-dispatch-ticket:test",
        "admission_receipt_id": "repair-bid-admission-receipt:test",
        "torghut_lot_id": lot_id,
        "lot_class": "empirical_replay",
        "target_value_gate": "zero_notional_or_stale_evidence_rate",
        "dedupe_key": "torghut-repair:test",
        "required_output_receipt": "torghut.empirical-proof-refresh-receipt.v1",
        "launch_allowed": True,
        "launch_reason": "current_zero_notional_compacted_lot",
        "stop_conditions": ["fresh_until_expired", "dedupe_key_became_active"],
        "max_runtime_seconds": 1200,
        "max_notional": 0,
        "expected_gate_delta": 1,
        "rollback_target": "keep Torghut max_notional=0",
    }
    if overrides:
        ticket.update(overrides)
    return ticket


def _freshness_carry_ledger(
    dimension_id: str = "empirical",
    *,
    dispatchable: bool = True,
) -> dict[str, object]:
    output_receipt_by_dimension = {
        "empirical": "torghut.empirical-proof-refresh-receipt.v1",
        "tca": "torghut.execution-tca-refresh-receipt.v1",
    }
    value_gate_by_dimension = {
        "empirical": "post_cost_daily_net_pnl",
        "tca": "fill_tca_or_slippage_quality",
    }
    return {
        "schema_version": "torghut.freshness-carry-ledger.v1",
        "ledger_id": "freshness-carry-ledger:test",
        "dimensions": [
            {
                "dimension_id": dimension_id,
                "state": "stale",
                "proof_authority": "app_health",
                "stale_reason_codes": [f"{dimension_id}_stale"],
            }
        ],
        "repair_proof_slos": [
            {
                "repair_id": f"freshness-repair-slo:{dimension_id}",
                "target_dimension_id": dimension_id,
                "target_value_gate": value_gate_by_dimension[dimension_id],
                "required_output_receipts": [output_receipt_by_dimension[dimension_id]],
                "dispatchable": dispatchable,
                "hold_reason_codes": []
                if dispatchable
                else ["source_serving_not_current"],
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
        freshness_carry_ledger=_freshness_carry_ledger(),
        now=NOW,
    )

    assert receipt["schema_version"] == ZERO_NOTIONAL_REPAIR_EXECUTION_SCHEMA_VERSION
    assert receipt["execution_state"] == "dry_run_ready"
    assert receipt["command_exit_code"] == 0
    assert receipt["order_submission_enabled"] is False
    assert receipt["paper_notional_limit"] == "0"
    assert receipt["live_notional_limit"] == "0"
    assert receipt["before_refs"] == ["empirical:H-AAPL"]
    assert receipt["value_gate"] == "zero_notional_or_stale_evidence_rate"
    assert receipt["freshness_carry_ledger_ref"] == "freshness-carry-ledger:test"
    assert receipt["freshness_citation_required"] is True
    assert receipt["freshness_citation_state"] == "cited"
    assert receipt["freshness_dimension_id"] == "empirical"
    assert receipt["freshness_repair_proof_slo_ref"] == (
        "freshness-repair-slo:empirical"
    )
    assert receipt["freshness_required_output_receipts"] == [
        "torghut.empirical-proof-refresh-receipt.v1"
    ]
    assert receipt["requires_repair_lot_dispatch_ticket"] is True
    assert receipt["repair_lot_dispatch_ticket_ref"] is None


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
        freshness_carry_ledger=_freshness_carry_ledger("tca"),
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


def test_retired_market_context_action_is_unsupported() -> None:
    receipt = build_zero_notional_repair_execution_receipt(
        account_label="paper",
        trading_mode="live",
        torghut_revision="torghut-00320",
        source_commit="abc123",
        profit_freshness_frontier=_frontier("refresh_stale_market_context_domains"),
        execute=False,
        now=NOW,
    )

    assert receipt["execution_state"] == "unsupported_action"
    assert receipt["command_exit_code"] == 78
    assert receipt["executor"] is None
    assert receipt["order_submission_enabled"] is False


def test_execute_runs_allowlisted_drift_runner_without_widening_notional() -> None:
    called: list[Mapping[str, Any]] = []

    def runner(repair: Mapping[str, Any]) -> Mapping[str, object]:
        called.append(repair)
        return {
            "execution_state": "executed",
            "command_exit_code": 0,
            "after_refs": ["drift_detection_checks"],
            "result": {"signals_evaluated": 8},
        }

    receipt = run_zero_notional_repair(
        account_label="paper",
        trading_mode="live",
        torghut_revision="torghut-00320",
        source_commit="abc123",
        profit_freshness_frontier=_frontier(
            "rerun_drift_checks_for_blocked_hypotheses"
        ),
        execute=True,
        runners={"rerun_drift_checks_for_blocked_hypotheses": runner},
        now=NOW,
    )

    assert len(called) == 1
    assert receipt["execution_state"] == "executed"
    assert receipt["command_exit_code"] == 0
    assert receipt["executor"] == "hypothesis_drift_check_replay"
    assert receipt["value_gate"] == "zero_notional_or_stale_evidence_rate"
    assert receipt["after_refs"] == ["drift_detection_checks"]
    assert receipt["runner_result"] == {
        "execution_state": "executed",
        "command_exit_code": 0,
        "after_refs": ["drift_detection_checks"],
        "result": {"signals_evaluated": 8},
    }
    assert receipt["capital_behavior_changed"] is False
    assert receipt["order_submission_enabled"] is False
    assert receipt["paper_notional_limit"] == "0"
    assert receipt["live_notional_limit"] == "0"


def test_execute_runs_feature_coverage_runner_without_widening_notional() -> None:
    called: list[Mapping[str, Any]] = []

    def runner(repair: Mapping[str, Any]) -> Mapping[str, object]:
        called.append(repair)
        return {
            "execution_state": "executed",
            "command_exit_code": 0,
            "after_refs": ["feature_coverage_rows"],
            "result": {"rows_total": 12},
        }

    receipt = run_zero_notional_repair(
        account_label="paper",
        trading_mode="live",
        torghut_revision="torghut-00320",
        source_commit="abc123",
        profit_freshness_frontier=_frontier("rebuild_required_feature_rows"),
        execute=True,
        runners={"rebuild_required_feature_rows": runner},
        now=NOW,
    )

    assert len(called) == 1
    assert receipt["execution_state"] == "executed"
    assert receipt["command_exit_code"] == 0
    assert receipt["executor"] == "hypothesis_feature_coverage_replay"
    assert receipt["value_gate"] == "zero_notional_or_stale_evidence_rate"
    assert receipt["after_refs"] == ["feature_coverage_rows"]
    assert receipt["runner_result"] == {
        "execution_state": "executed",
        "command_exit_code": 0,
        "after_refs": ["feature_coverage_rows"],
        "result": {"rows_total": 12},
    }
    assert receipt["capital_behavior_changed"] is False
    assert receipt["order_submission_enabled"] is False
    assert receipt["paper_notional_limit"] == "0"
    assert receipt["live_notional_limit"] == "0"


def test_preferred_action_can_execute_queued_route_tca_repair() -> None:
    frontier = _frontier("renew_empirical_proof_jobs")
    frontier["repair_lots"] = [
        {
            "lot_id": "profit-freshness-repair-lot:empirical",
            "state": "selected_zero_notional_repair",
            "zero_notional_action": "renew_empirical_proof_jobs",
        },
        {
            "lot_id": "profit-freshness-repair-lot:tca",
            "candidate_id": "candidate-b",
            "hypothesis_id": "H-NVDA",
            "blocked_dimension": "tca_fill_quality",
            "zero_notional_action": "recompute_route_tca_and_fill_quality",
            "before_refs": ["execution_tca:NVDA"],
            "paper_notional_limit": "0",
            "live_notional_limit": "0",
            "state": "queued_zero_notional_repair",
        },
    ]
    called: list[Mapping[str, Any]] = []

    receipt = run_zero_notional_repair(
        account_label="paper",
        trading_mode="live",
        torghut_revision="torghut-00320",
        source_commit="abc123",
        profit_freshness_frontier=frontier,
        execute=True,
        preferred_action="recompute_route_tca_and_fill_quality",
        freshness_carry_ledger=_freshness_carry_ledger("tca"),
        runners={
            "recompute_route_tca_and_fill_quality": lambda repair: (
                called.append(repair)
                or {
                    "execution_state": "executed",
                    "command_exit_code": 0,
                    "after_refs": ["execution_tca_metrics"],
                }
            )
        },
        now=NOW,
    )

    assert [repair["lot_id"] for repair in called] == [
        "profit-freshness-repair-lot:tca"
    ]
    assert receipt["execution_state"] == "executed"
    assert receipt["zero_notional_action"] == "recompute_route_tca_and_fill_quality"
    assert (
        receipt["preferred_zero_notional_action"]
        == "recompute_route_tca_and_fill_quality"
    )
    assert receipt["repair_lot_ref"] == "profit-freshness-repair-lot:tca"
    assert receipt["before_refs"] == ["execution_tca:NVDA"]
    assert receipt["after_refs"] == ["execution_tca_metrics"]
    assert receipt["order_submission_enabled"] is False


def test_preferred_action_missing_is_fail_closed() -> None:
    receipt = run_zero_notional_repair(
        account_label="paper",
        trading_mode="live",
        torghut_revision="torghut-00320",
        source_commit="abc123",
        profit_freshness_frontier=_frontier("renew_empirical_proof_jobs"),
        execute=True,
        preferred_action="recompute_route_tca_and_fill_quality",
        runners={
            "recompute_route_tca_and_fill_quality": lambda _repair: {
                "execution_state": "executed",
                "command_exit_code": 0,
            }
        },
        now=NOW,
    )

    assert receipt["execution_state"] == "no_selected_repair"
    assert receipt["command_exit_code"] == 78
    assert (
        "profit_freshness_frontier_matching_repair_missing:recompute_route_tca_and_fill_quality"
        in receipt["blocked_reasons"]
    )
    assert receipt["order_submission_enabled"] is False


def test_runner_required_action_requires_dispatch_ticket_before_runner_admission() -> (
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

    assert receipt["execution_state"] == "repair_lot_dispatch_ticket_required"
    assert receipt["command_exit_code"] == 78
    assert receipt["requires_torghut_admission"] is True
    assert receipt["requires_repair_lot_dispatch_ticket"] is True
    assert "repair_lot_dispatch_ticket_missing" in receipt["blocked_reasons"]
    assert receipt["order_submission_enabled"] is False


def test_runner_required_action_does_not_call_runner_without_dispatch_ticket() -> None:
    called: list[Mapping[str, Any]] = []

    receipt = run_zero_notional_repair(
        account_label="paper",
        trading_mode="live",
        torghut_revision="torghut-00320",
        source_commit="abc123",
        profit_freshness_frontier=_frontier("renew_empirical_proof_jobs"),
        execute=True,
        runners={
            "renew_empirical_proof_jobs": lambda repair: (
                called.append(repair)
                or {
                    "execution_state": "executed",
                    "command_exit_code": 0,
                }
            ),
        },
        now=NOW,
    )

    assert called == []
    assert receipt["execution_state"] == "repair_lot_dispatch_ticket_required"
    assert receipt["command_exit_code"] == 78
    assert receipt["blocked_reasons"] == ["repair_lot_dispatch_ticket_missing"]
    assert receipt["repair_lot_dispatch_ticket_ref"] is None
    assert receipt["order_submission_enabled"] is False


def test_runner_required_action_executes_with_matching_dispatch_ticket() -> None:
    called: list[Mapping[str, Any]] = []

    receipt = run_zero_notional_repair(
        account_label="paper",
        trading_mode="live",
        torghut_revision="torghut-00320",
        source_commit="abc123",
        profit_freshness_frontier=_frontier("renew_empirical_proof_jobs"),
        execute=True,
        repair_lot_dispatch_ticket=_dispatch_ticket(),
        freshness_carry_ledger=_freshness_carry_ledger(),
        runners={
            "renew_empirical_proof_jobs": lambda repair: (
                called.append(repair)
                or {
                    "execution_state": "executed",
                    "command_exit_code": 0,
                    "after_refs": ["empirical:H-AAPL:renewed"],
                }
            ),
        },
        now=NOW,
    )

    assert [repair["lot_id"] for repair in called] == [
        "profit-freshness-repair-lot:test"
    ]
    assert receipt["execution_state"] == "executed"
    assert receipt["command_exit_code"] == 0
    assert receipt["after_refs"] == ["empirical:H-AAPL:renewed"]
    assert receipt["requires_repair_lot_dispatch_ticket"] is True
    assert (
        receipt["repair_lot_dispatch_ticket_ref"] == "repair-lot-dispatch-ticket:test"
    )
    assert (
        receipt["repair_lot_dispatch_ticket_lot_ref"]
        == "profit-freshness-repair-lot:test"
    )
    assert receipt["repair_lot_dispatch_ticket_launch_allowed"] is True
    assert receipt["freshness_citation_state"] == "cited"
    assert receipt["freshness_dimension_id"] == "empirical"
    assert receipt["freshness_repair_proof_slo_dispatchable"] is True
    assert receipt["paper_notional_limit"] == "0"
    assert receipt["live_notional_limit"] == "0"
    assert receipt["order_submission_enabled"] is False


def test_runner_required_action_rejects_mismatched_dispatch_ticket() -> None:
    called: list[Mapping[str, Any]] = []

    receipt = run_zero_notional_repair(
        account_label="paper",
        trading_mode="live",
        torghut_revision="torghut-00320",
        source_commit="abc123",
        profit_freshness_frontier=_frontier("renew_empirical_proof_jobs"),
        execute=True,
        repair_lot_dispatch_ticket=_dispatch_ticket(
            "profit-freshness-repair-lot:other",
            {
                "launch_allowed": False,
                "max_notional": 1,
                "target_value_gate": "capital_gate_safety",
            },
        ),
        runners={
            "renew_empirical_proof_jobs": lambda repair: (
                called.append(repair)
                or {
                    "execution_state": "executed",
                    "command_exit_code": 0,
                }
            ),
        },
        now=NOW,
    )

    assert called == []
    assert receipt["execution_state"] == "repair_lot_dispatch_ticket_required"
    assert receipt["command_exit_code"] == 78
    assert receipt["blocked_reasons"] == [
        "repair_lot_dispatch_ticket_not_allowed",
        "repair_lot_dispatch_ticket_notional_nonzero",
        "repair_lot_dispatch_ticket_value_gate_mismatch",
        "repair_lot_dispatch_ticket_lot_mismatch",
    ]
    assert (
        receipt["repair_lot_dispatch_ticket_ref"] == "repair-lot-dispatch-ticket:test"
    )
    assert receipt["repair_lot_dispatch_ticket_launch_allowed"] is False


def test_runner_required_action_rejects_malformed_dispatch_ticket() -> None:
    called: list[Mapping[str, Any]] = []

    receipt = run_zero_notional_repair(
        account_label="paper",
        trading_mode="live",
        torghut_revision="torghut-00320",
        source_commit="abc123",
        profit_freshness_frontier=_frontier("renew_empirical_proof_jobs"),
        execute=True,
        repair_lot_dispatch_ticket={
            "schema_version": "jangar.repair-lot-dispatch-ticket.v0",
            "ticket_id": "",
            "torghut_lot_id": "",
            "target_value_gate": "",
            "dedupe_key": "",
            "required_output_receipt": "",
            "launch_allowed": "no",
            "max_runtime_seconds": "not-a-ttl",
        },
        runners={
            "renew_empirical_proof_jobs": lambda repair: (
                called.append(repair)
                or {
                    "execution_state": "executed",
                    "command_exit_code": 0,
                }
            ),
        },
        now=NOW,
    )

    assert called == []
    assert receipt["execution_state"] == "repair_lot_dispatch_ticket_required"
    assert receipt["command_exit_code"] == 78
    assert receipt["blocked_reasons"] == [
        "repair_lot_dispatch_ticket_schema_mismatch",
        "repair_lot_dispatch_ticket_id_missing",
        "repair_lot_dispatch_ticket_not_allowed",
        "repair_lot_dispatch_ticket_notional_missing",
        "repair_lot_dispatch_ticket_dedupe_key_missing",
        "repair_lot_dispatch_ticket_output_receipt_missing",
        "repair_lot_dispatch_ticket_ttl_invalid",
        "repair_lot_dispatch_ticket_value_gate_missing",
        "repair_lot_dispatch_ticket_lot_missing",
    ]
    assert receipt["repair_lot_dispatch_ticket_ref"] == ""
    assert receipt["repair_lot_dispatch_ticket_launch_allowed"] is False


def test_nonzero_frontier_notional_blocks_repair_execution() -> None:
    frontier = _frontier("recompute_route_tca_and_fill_quality")
    frontier["capital_posture"]["paper_notional_limit"] = "5"
    called: list[Mapping[str, Any]] = []

    receipt = run_zero_notional_repair(
        account_label="paper",
        trading_mode="live",
        torghut_revision="torghut-00320",
        source_commit="abc123",
        profit_freshness_frontier=frontier,
        execute=True,
        runners={
            "recompute_route_tca_and_fill_quality": lambda repair: (
                called.append(repair)
                or {
                    "execution_state": "executed",
                    "command_exit_code": 0,
                }
            ),
        },
        now=NOW,
    )

    assert called == []
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
        freshness_carry_ledger=_freshness_carry_ledger("tca"),
        runners={},
        now=NOW,
    )

    assert receipt["execution_state"] == "runner_not_configured"
    assert receipt["command_exit_code"] == 78
    assert "zero_notional_runner_not_configured" in receipt["blocked_reasons"]
    assert receipt["order_submission_enabled"] is False


def test_execute_freshness_targeted_repair_requires_dispatchable_freshness_slo() -> (
    None
):
    called: list[Mapping[str, Any]] = []

    receipt = run_zero_notional_repair(
        account_label="paper",
        trading_mode="live",
        torghut_revision="torghut-00320",
        source_commit="abc123",
        profit_freshness_frontier=_frontier("recompute_route_tca_and_fill_quality"),
        execute=True,
        freshness_carry_ledger=_freshness_carry_ledger("tca", dispatchable=False),
        runners={
            "recompute_route_tca_and_fill_quality": lambda repair: (
                called.append(repair)
                or {
                    "execution_state": "executed",
                    "command_exit_code": 0,
                }
            ),
        },
        now=NOW,
    )

    assert called == []
    assert receipt["execution_state"] == "freshness_repair_slo_required"
    assert receipt["command_exit_code"] == 78
    assert receipt["freshness_citation_state"] == "not_dispatchable"
    assert receipt["freshness_dimension_id"] == "tca"
    assert receipt["freshness_repair_proof_slo_ref"] == "freshness-repair-slo:tca"
    assert receipt["blocked_reasons"] == [
        "freshness_repair_proof_slo_not_dispatchable:tca",
        "source_serving_not_current",
    ]
    assert receipt["order_submission_enabled"] is False


def test_all_nonzero_notional_and_capital_change_markers_block_execution() -> None:
    frontier = _frontier("recompute_route_tca_and_fill_quality")
    frontier["capital_posture"]["paper_notional_limit"] = "1"
    frontier["capital_posture"]["live_notional_limit"] = "2"
    frontier["capital_posture"]["capital_behavior_changed"] = "true"
    selected_repair = frontier["selected_zero_notional_repairs"][0]
    selected_repair["paper_notional_limit"] = "3"
    selected_repair["live_notional_limit"] = "4"
    called: list[Mapping[str, Any]] = []

    receipt = run_zero_notional_repair(
        account_label="paper",
        trading_mode="live",
        torghut_revision="torghut-00320",
        source_commit="abc123",
        profit_freshness_frontier=frontier,
        execute=True,
        runners={
            "recompute_route_tca_and_fill_quality": lambda repair: (
                called.append(repair)
                or {
                    "execution_state": "executed",
                    "command_exit_code": 0,
                }
            ),
        },
        now=NOW,
    )

    assert called == []
    assert receipt["execution_state"] == "capital_safety_blocked"
    assert receipt["command_exit_code"] == 78
    assert receipt["blocked_reasons"] == [
        "frontier_paper_notional_nonzero",
        "frontier_live_notional_nonzero",
        "repair_paper_notional_nonzero",
        "repair_live_notional_nonzero",
        "frontier_capital_behavior_changed",
    ]
