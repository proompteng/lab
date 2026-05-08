from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime, timezone
from typing import Any, cast

from app.trading.profit_signal_quorum import build_profit_signal_quorum


NOW = datetime(2026, 5, 8, 12, 30, tzinfo=timezone.utc)


def _hypothesis(**overrides: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "hypothesis_id": "H-CONT-01",
        "lane_id": "continuation",
        "strategy_family": "intraday-continuation",
        "candidate_id": "candidate-cont",
        "strategy_id": "strategy-cont",
        "promotion_eligible": True,
        "promotion_decision_id": "promotion-cont",
        "rollback_required": False,
        "reasons": [],
        "observed": {
            "market_session_open": True,
            "tca_order_count": 7334,
            "avg_abs_slippage_bps": "4.5",
            "post_cost_expectancy_bps_proxy": "9.2",
            "route_tca_symbols": ["AAPL"],
        },
    }
    payload.update(overrides)
    return payload


def _build(
    *,
    hypothesis: Mapping[str, Any] | None = None,
    quant_evidence: Mapping[str, Any] | None = None,
    market_context_status: Mapping[str, Any] | None = None,
    jangar_stage_clearance_packet: Mapping[str, Any] | None = None,
    route_rows: list[Mapping[str, Any]] | None = None,
) -> dict[str, object]:
    hypothesis_item = dict(hypothesis or _hypothesis())
    return build_profit_signal_quorum(
        account_label="PA3SX7FYNUTF",
        trading_mode="live",
        torghut_revision="torghut-00307",
        hypothesis_payload={"items": [hypothesis_item]},
        quant_evidence=quant_evidence
        or {
            "ok": True,
            "status": "ok",
            "latest_metrics_count": 4284,
            "stage_count": 3,
            "source_url": "http://jangar/api/torghut/trading/control-plane/quant/health",
        },
        market_context_status=market_context_status
        or {"overallState": "ok", "risk_flags": []},
        proof_floor_receipt={
            "schema_version": "torghut.profitability-proof-floor.v1",
            "capital_state": "zero_notional",
            "blocking_reasons": [],
        },
        route_reacquisition_board={
            "jangar_broker_ref": "jangar-continuity:current",
            "rows": route_rows
            if route_rows is not None
            else [
                {
                    "symbol": "AAPL",
                    "state": "routeable",
                    "hypothesis_ids": ["H-CONT-01"],
                    "avg_abs_slippage_bps": "4.5",
                    "slippage_guardrail_bps": "8",
                }
            ],
        },
        live_submission_gate={
            "allowed": False,
            "blocked_reasons": ["simple_submit_disabled"],
        },
        jangar_stage_clearance_packet=(
            {
                "packet_id": "stage-clearance:repair",
                "decision": "dispatch_repair",
            }
            if jangar_stage_clearance_packet is None
            else jangar_stage_clearance_packet
        ),
        now=NOW,
    )


def _only_quorum(payload: Mapping[str, object]) -> Mapping[str, Any]:
    quorums = cast(list[Mapping[str, Any]], payload["quorums"])
    assert len(quorums) == 1
    return quorums[0]


def test_global_quant_green_but_scoped_pipeline_degraded_stays_zero_notional() -> None:
    payload = _build(
        quant_evidence={
            "ok": True,
            "status": "ok",
            "latest_metrics_count": 4284,
            "stage_count": 0,
        }
    )
    quorum = _only_quorum(payload)

    assert quorum["decision"] == "repair_only"
    assert quorum["max_notional"] == "0"
    assert "quant_pipeline_stages_missing" in quorum["reason_codes"]
    assert quorum["required_repair_action"] == "refresh_scoped_quant_pipeline_stages"


def test_context_route_down_names_market_context_repair_without_capital() -> None:
    payload = _build(
        hypothesis=_hypothesis(hypothesis_id="H-REV-01"),
        route_rows=[
            {
                "symbol": "AAPL",
                "state": "routeable",
                "hypothesis_ids": ["H-REV-01"],
                "avg_abs_slippage_bps": "4.5",
                "slippage_guardrail_bps": "8",
            }
        ],
        market_context_status={"overallState": "down", "risk_flags": ["news_stale"]},
    )
    quorum = _only_quorum(payload)

    assert quorum["decision"] == "repair_only"
    assert "market_context_route_down" in quorum["reason_codes"]
    assert (
        quorum["required_repair_action"]
        == "repair_market_context_route_or_domain_freshness"
    )


def test_missing_lineage_and_promotion_decision_block_candidate_count() -> None:
    payload = _build(
        hypothesis=_hypothesis(
            candidate_id="",
            strategy_id="",
            promotion_eligible=False,
            promotion_decision_id="",
            reasons=["strategy_hypothesis_lineage_missing"],
        )
    )
    quorum = _only_quorum(payload)

    assert quorum["decision"] == "repair_only"
    assert "hypothesis_candidate_id_missing" in quorum["reason_codes"]
    assert "hypothesis_strategy_id_missing" in quorum["reason_codes"]
    assert "promotion_decision_missing" in quorum["reason_codes"]
    assert payload["summary"]["routeable_candidate_count"] == 0


def test_missing_stage_clearance_packet_keeps_quorum_observe_only() -> None:
    payload = _build(jangar_stage_clearance_packet={})
    quorum = _only_quorum(payload)

    assert quorum["decision"] == "observe_only"
    assert quorum["jangar_stage_clearance_packet_id"] is None
    assert "stage_clearance_packet_missing" in quorum["reason_codes"]
    assert (
        quorum["required_repair_action"]
        == "publish_current_jangar_stage_clearance_packet"
    )
