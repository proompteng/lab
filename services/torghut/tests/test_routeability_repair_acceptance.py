from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime, timezone
from typing import Any, cast

from app.trading.routeability_repair_acceptance import (
    ROUTEABILITY_REPAIR_ACCEPTANCE_LEDGER_SCHEMA_VERSION,
    build_routeability_repair_acceptance_ledger,
)


NOW = datetime(2026, 5, 8, 12, 32, tzinfo=timezone.utc)


def _base_inputs() -> dict[str, object]:
    return {
        "account_label": "PA3SX7FYNUTF",
        "window": "15m",
        "trading_mode": "live",
        "torghut_revision": "torghut-00308",
        "revenue_repair_digest_ref": "/trading/revenue-repair",
        "consumer_evidence_receipt": {
            "receipt_id": "torghut-consumer-evidence:test",
            "fresh_until": "2026-05-08T12:33:00+00:00",
            "forecast_registry_state": "degraded",
            "reason_codes": [
                "forecast_registry_degraded",
                "simple_submit_disabled",
                "alpha_readiness_not_promotion_eligible",
            ],
        },
        "proof_floor_receipt": {
            "schema_version": "torghut.profitability-proof-floor.v1",
            "account_label": "PA3SX7FYNUTF",
            "route_state": "repair_only",
            "capital_state": "zero_notional",
            "max_notional": "0",
            "blocking_reasons": [
                "alpha_readiness_not_promotion_eligible",
                "simple_submit_disabled",
            ],
            "proof_dimensions": [
                {
                    "dimension": "alpha_readiness",
                    "state": "fail",
                    "source_ref": {"promotion_eligible_total": 0},
                }
            ],
        },
        "capital_reentry_cohort_ledger": {
            "ledger_id": "capital-reentry-ledger:test",
            "aggregate_state": "repair",
        },
        "quality_adjusted_profit_frontier": {
            "frontier_id": "quality-frontier:test",
            "blocked_capital_surfaces": [
                "research_candidates_empty",
                "vnext_promotion_decisions_empty",
            ],
        },
        "profit_repair_settlement_ledger": {
            "ledger_id": "profit-repair-settlement-ledger:test",
            "aggregate_state": "repair",
        },
        "route_reacquisition_board": {
            "summary": {"capital_eligible_symbol_count": 1},
            "rows": [
                {
                    "symbol": "AAPL",
                    "state": "probing",
                    "current_blocker": "route_tca_passed_but_dependency_receipts_block_capital",
                    "hypothesis_ids": ["H-AAPL"],
                },
                {
                    "symbol": "NVDA",
                    "state": "blocked",
                    "current_blocker": "execution_tca_route_universe_exclusions_applied",
                    "avg_abs_slippage_bps": "13.82",
                    "slippage_guardrail_bps": "8",
                    "hypothesis_ids": ["H-NVDA"],
                },
                {
                    "symbol": "ORCL",
                    "state": "missing",
                    "current_blocker": "execution_tca_symbol_missing",
                },
            ],
        },
        "live_submission_gate": {
            "allowed": False,
            "reason": "simple_submit_disabled",
            "blocked_reasons": ["simple_submit_disabled"],
            "profit_lease_projection": {
                "leases": [
                    {
                        "blocking_reason_codes": [
                            "research_candidates_empty",
                            "vnext_promotion_decisions_empty",
                        ]
                    }
                ]
            },
        },
        "quant_evidence": {
            "ok": True,
            "status": "degraded",
            "latest_metrics_count": 144,
            "stage_count": 0,
            "blocking_reasons": [],
        },
        "market_context_status": {
            "status": "healthy",
            "last_domain_states": {
                "technicals": {"status": "stale"},
                "news": {"stale": True},
                "regime": {"status": "stale"},
            },
        },
        "torghut_routeability_admission_ref": {
            "admission_ref": "jangar-routeability:test",
            "decision": "hold",
            "state": "degraded",
            "reason_codes": ["controller_witness_stale"],
        },
        "now": NOW,
    }


def _ledger(**overrides: object) -> dict[str, object]:
    payload = _base_inputs()
    payload.update(overrides)
    return build_routeability_repair_acceptance_ledger(**payload)


def _lot(ledger: Mapping[str, object], lot_type: str) -> Mapping[str, Any]:
    for raw_lot in cast(list[Mapping[str, Any]], ledger["lots"]):
        if raw_lot["lot_type"] == lot_type:
            return raw_lot
    raise AssertionError(f"missing lot {lot_type}")


def test_routeability_acceptance_ledger_projects_all_doc185_lots_at_zero_notional() -> (
    None
):
    ledger = _ledger()

    assert (
        ledger["schema_version"] == ROUTEABILITY_REPAIR_ACCEPTANCE_LEDGER_SCHEMA_VERSION
    )
    assert ledger["aggregate_state"] == "blocked"
    assert ledger["accepted_routeable_candidate_count"] == 0
    assert ledger["zero_notional_or_stale_evidence_rate"] == 1
    assert ledger["capital_reentry_ref"] == "capital-reentry-ledger:test"
    assert ledger["quality_frontier_ref"] == "quality-frontier:test"
    assert (
        ledger["profit_repair_settlement_ref"] == "profit-repair-settlement-ledger:test"
    )
    assert ledger["summary"]["lot_count"] == 7
    assert ledger["summary"]["zero_notional_lot_count"] == 7

    lots = cast(list[Mapping[str, Any]], ledger["lots"])
    assert {lot["paper_notional_limit"] for lot in lots} == {"0"}
    assert {lot["live_notional_limit"] for lot in lots} == {"0"}
    assert {lot["promotion_authority"] for lot in lots} == {False}
    assert ledger["promotion_authority"] is False
    assert {lot["lot_type"] for lot in lots} == {
        "quant_scoped_stage_repair",
        "market_context_domain_repair",
        "alpha_readiness_repair",
        "route_universe_tca_repair",
        "forecast_and_promotion_repair",
        "submit_gate_hold",
        "torghut_admission_witness",
    }


def test_quant_latest_metrics_do_not_accept_routeability_without_scoped_stages() -> (
    None
):
    ledger = _ledger()
    quant_lot = _lot(ledger, "quant_scoped_stage_repair")

    assert quant_lot["current_state"] == "missing"
    assert "quant_pipeline_stages_missing" in quant_lot["blocking_reason_codes"]
    assert ledger["accepted_routeable_candidate_count"] == 0


def test_optional_unconfigured_quant_health_does_not_create_routeability_lot() -> None:
    ledger = _ledger(
        quant_evidence={
            "required": False,
            "ok": True,
            "status": "not_required",
            "reason": "quant_health_not_configured",
            "blocking_reasons": [],
            "informational_reasons": ["quant_health_not_configured"],
            "source_url": None,
        }
    )

    quant_lot = _lot(ledger, "quant_scoped_stage_repair")

    assert quant_lot["current_state"] == "accepted"
    assert quant_lot["blocking_reason_codes"] == []
    assert (
        "quant_health_not_configured" not in ledger["aggregate_blocking_reason_codes"]
    )


def test_stale_market_context_domains_keep_acceptance_unsettled() -> None:
    ledger = _ledger()
    market_lot = _lot(ledger, "market_context_domain_repair")

    assert market_lot["current_state"] == "stale"
    assert (
        market_lot["acceptance_condition"]
        == "technicals, regime domains are fresh or not required"
    )
    assert "market_context_technicals_stale" in market_lot["blocking_reason_codes"]
    assert "market_context_news_stale" not in market_lot["blocking_reason_codes"]
    assert "market_context_regime_stale" in market_lot["blocking_reason_codes"]


def test_repair_only_route_tca_and_submit_gate_keep_candidate_count_zero() -> None:
    ledger = _ledger()
    route_lot = _lot(ledger, "route_universe_tca_repair")
    submit_lot = _lot(ledger, "submit_gate_hold")

    assert route_lot["current_state"] == "missing"
    assert route_lot["symbols"] == ["AAPL", "NVDA", "ORCL"]
    assert (
        "execution_tca_slippage_above_guardrail" in route_lot["blocking_reason_codes"]
    )
    assert "proof_floor_repair_only" in route_lot["blocking_reason_codes"]
    assert submit_lot["current_state"] == "blocked"
    assert "simple_submit_disabled" in submit_lot["blocking_reason_codes"]
    assert ledger["accepted_routeable_candidate_count"] == 0


def test_missing_or_degraded_torghut_admission_blocks_routeability_claims() -> None:
    ledger = _ledger(torghut_routeability_admission_ref={})
    jangar_lot = _lot(ledger, "torghut_admission_witness")

    assert jangar_lot["current_state"] == "missing"
    assert (
        "torghut_routeability_admission_missing" in jangar_lot["blocking_reason_codes"]
    )
    assert ledger["accepted_routeable_candidate_count"] == 0


def test_probing_route_rows_keep_routeability_unsettled_until_tca_acceptance() -> None:
    ledger = _ledger(
        consumer_evidence_receipt={
            "receipt_id": "torghut-consumer-evidence:ready",
            "fresh_until": "2026-05-08T12:33:00+00:00",
            "forecast_registry_state": "ready",
            "reason_codes": [],
        },
        proof_floor_receipt={
            "schema_version": "torghut.profitability-proof-floor.v1",
            "account_label": "PA3SX7FYNUTF",
            "route_state": "paper_candidate",
            "capital_state": "paper_allowed",
            "max_notional": "25",
            "blocking_reasons": [],
            "proof_dimensions": [
                {
                    "dimension": "alpha_readiness",
                    "state": "pass",
                    "source_ref": {"promotion_eligible_total": 1},
                }
            ],
        },
        quality_adjusted_profit_frontier={
            "frontier_id": "quality-frontier:ready",
            "blocked_capital_surfaces": [],
        },
        route_reacquisition_board={
            "summary": {"capital_eligible_symbol_count": 1},
            "rows": [
                {
                    "symbol": "AAPL",
                    "state": "probing",
                    "current_blocker": "route_tca_probing_pending_acceptance",
                    "hypothesis_ids": ["H-AAPL"],
                    "avg_abs_slippage_bps": "4",
                    "slippage_guardrail_bps": "8",
                }
            ],
        },
        live_submission_gate={
            "allowed": True,
            "reason": "ready",
            "blocked_reasons": [],
        },
        quant_evidence={
            "ok": True,
            "status": "healthy",
            "latest_metrics_count": 144,
            "stage_count": 3,
        },
        market_context_status={"status": "healthy", "last_domain_states": {}},
        torghut_routeability_admission_ref={
            "admission_ref": "jangar-routeability:ready",
            "decision": "allow",
            "state": "current",
            "reason_codes": [],
        },
    )

    route_lot = _lot(ledger, "route_universe_tca_repair")

    assert ledger["aggregate_state"] == "repairing"
    assert ledger["accepted_routeable_candidate_count"] == 0
    assert route_lot["current_state"] == "repairing"
    assert route_lot["symbols"] == ["AAPL"]
    assert route_lot["blocking_reason_codes"] == [
        "route_tca_probing_pending_acceptance"
    ]


def test_all_receipts_must_settle_before_accepting_routeable_candidates() -> None:
    ledger = _ledger(
        consumer_evidence_receipt={
            "receipt_id": "torghut-consumer-evidence:ready",
            "fresh_until": "2026-05-08T12:33:00+00:00",
            "forecast_registry_state": "ready",
            "reason_codes": [],
        },
        proof_floor_receipt={
            "schema_version": "torghut.profitability-proof-floor.v1",
            "account_label": "PA3SX7FYNUTF",
            "route_state": "paper_candidate",
            "capital_state": "paper_allowed",
            "max_notional": "25",
            "blocking_reasons": [],
            "proof_dimensions": [
                {
                    "dimension": "alpha_readiness",
                    "state": "pass",
                    "source_ref": {"promotion_eligible_total": 1},
                }
            ],
        },
        quality_adjusted_profit_frontier={
            "frontier_id": "quality-frontier:ready",
            "blocked_capital_surfaces": [],
        },
        route_reacquisition_board={
            "summary": {"capital_eligible_symbol_count": 1},
            "rows": [
                {
                    "symbol": "AAPL",
                    "state": "routeable",
                    "current_blocker": "",
                    "hypothesis_ids": ["H-AAPL"],
                    "avg_abs_slippage_bps": "4",
                    "slippage_guardrail_bps": "8",
                }
            ],
        },
        live_submission_gate={
            "allowed": True,
            "reason": "ready",
            "blocked_reasons": [],
        },
        quant_evidence={
            "ok": True,
            "status": "healthy",
            "latest_metrics_count": 144,
            "stage_count": 3,
        },
        market_context_status={"status": "healthy", "last_domain_states": {}},
        torghut_routeability_admission_ref={
            "admission_ref": "jangar-routeability:ready",
            "decision": "allow",
            "state": "current",
            "reason_codes": [],
        },
    )

    assert ledger["aggregate_state"] == "accepted"
    assert ledger["accepted_routeable_candidate_count"] == 1
    assert ledger["summary"]["accepted_lot_count"] == 7


def test_blocked_autoresearch_portfolios_keep_promotion_repair_unsettled() -> None:
    ledger = _ledger(
        consumer_evidence_receipt={
            "receipt_id": "torghut-consumer-evidence:autoresearch-blocked",
            "fresh_until": "2026-05-08T12:33:00+00:00",
            "forecast_registry_state": "ready",
            "reason_codes": [],
        },
        quality_adjusted_profit_frontier={
            "frontier_id": "quality-frontier:autoresearch-blocked",
            "blocked_capital_surfaces": [
                "autoresearch_portfolio_ready_empty",
                "autoresearch_portfolio_candidates_blocked",
            ],
        },
        live_submission_gate={
            "allowed": True,
            "reason": "ready",
            "blocked_reasons": [],
            "profit_lease_projection": {
                "blocking_reason_codes": [
                    "autoresearch_portfolio_ready_empty",
                    "autoresearch_portfolio_candidates_blocked",
                ],
                "leases": [],
            },
        },
    )

    promotion_lot = _lot(ledger, "forecast_and_promotion_repair")

    assert ledger["accepted_routeable_candidate_count"] == 0
    assert promotion_lot["current_state"] == "missing"
    assert (
        "autoresearch_portfolio_ready_empty" in promotion_lot["blocking_reason_codes"]
    )
    assert (
        "autoresearch_portfolio_candidates_blocked"
        in promotion_lot["blocking_reason_codes"]
    )
