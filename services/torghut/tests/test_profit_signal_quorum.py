from __future__ import annotations

from datetime import datetime, timezone

from app.trading.profit_signal_quorum import build_profit_signal_quorum


NOW = datetime(2026, 5, 8, 12, 30, tzinfo=timezone.utc)


def _hypothesis(**overrides):
    payload = dict(
        hypothesis_id="H-CONT-01",
        candidate_id="candidate-cont",
        strategy_id="strategy-cont",
        promotion_eligible=True,
        promotion_decision_id="promotion-cont",
    )
    payload.update(overrides)
    return payload


def _build(
    hypothesis=None,
    quant=None,
    market=None,
    proof=None,
    gate=None,
    stage=None,
    rows=None,
):
    return build_profit_signal_quorum(
        account_label="PA3SX7FYNUTF",
        trading_mode="live",
        torghut_revision="torghut-00307",
        hypothesis_payload={"items": [dict(hypothesis or _hypothesis())]},
        quant_evidence=quant
        or dict(ok=True, status="ok", latest_metrics_count=4284, stage_count=3),
        market_context_status=market or {"overallState": "ok"},
        proof_floor_receipt=proof
        or {"schema_version": "torghut.profitability-proof-floor.v1"},
        route_reacquisition_board={
            "jangar_broker_ref": "jangar-continuity:current",
            "rows": rows
            if rows is not None
            else [
                dict(
                    symbol="AAPL",
                    state="routeable",
                    hypothesis_ids=["H-CONT-01"],
                    avg_abs_slippage_bps="4.5",
                    slippage_guardrail_bps="8",
                )
            ],
        },
        live_submission_gate=gate or {"allowed": False},
        torghut_stage_clearance_packet=stage
        if stage is not None
        else {"packet_id": "stage-clearance:repair", "decision": "dispatch_repair"},
        now=NOW,
    )


def _only_quorum(payload):
    quorums = payload["quorums"]
    assert len(quorums) == 1
    return quorums[0]


def test_complete_quorum_projects_candidate_or_canary_without_notional():
    candidate = _only_quorum(_build())
    canary = _only_quorum(_build(gate={"allowed": True}))

    assert candidate["decision"] == "paper_candidate"
    assert canary["decision"] == "paper_canary"
    assert candidate["reason_codes"] == []


def test_global_quant_green_but_scoped_pipeline_degraded_stays_zero_notional():
    quorum = _only_quorum(_build(quant=dict(ok=True, stage_count=0)))

    assert quorum["decision"] == "repair_only"
    assert quorum["max_notional"] == "0"
    assert "quant_pipeline_stages_missing" in quorum["reason_codes"]
    assert quorum["required_repair_action"] == "refresh_scoped_quant_pipeline_stages"


def test_optional_unconfigured_quant_health_does_not_degrade_quorum():
    quorum = _only_quorum(
        _build(
            quant=dict(
                required=False,
                ok=True,
                status="not_required",
                reason="quant_health_not_configured",
                blocking_reasons=[],
                informational_reasons=["quant_health_not_configured"],
                source_url=None,
            )
        )
    )

    assert quorum["decision"] == "paper_candidate"
    assert quorum["quant_signal"]["state"] == "fresh"
    assert quorum["quant_signal"]["reason_codes"] == []
    assert "quant_health_not_configured" not in quorum["reason_codes"]


def test_degraded_inputs_emit_scoped_repair_reasons_without_capital():
    quorum = _only_quorum(
        _build(
            quant=dict(
                ok=False,
                reason="quant_health_fetch_failed",
                status="degraded",
                latestMetricsCount=0,
                degradedMetricsCount=2,
                stageCount=3,
                blocking_reasons=["pipeline_ingestion_alarm"],
                pipelineStages=[
                    "ignore",
                    dict(
                        name="ingestion",
                        status="degraded",
                        lagSeconds="120",
                        maxLagSeconds="30",
                    ),
                ],
                ingestion_ok=False,
            ),
            market=dict(
                overall_state="ok",
                stale_snapshot_count=1,
                domains=dict(news=dict(state="stale")),
            ),
            rows=[
                {},
                dict(
                    symbol="AAPL",
                    state="blocked",
                    hypothesis_ids=["H-CONT-01"],
                    avg_abs_slippage_bps="bad",
                ),
                dict(
                    symbol="MSFT",
                    state="routeable",
                    hypothesis_ids=["H-CONT-01"],
                    avg_abs_slippage_bps="12",
                    slippage_guardrail_bps="8",
                ),
            ],
        )
    )
    expected = "quant_health_fetch_failed quant_status_degraded quant_latest_metrics_empty quant_latest_metrics_degraded pipeline_ingestion_alarm quant_pipeline_stage_ingestion_degraded quant_pipeline_stage_ingestion_stale market_context_snapshot_stale route_tca_blocked execution_tca_slippage_above_guardrail".split()

    assert quorum["decision"] == "repair_only"
    assert set(expected) <= set(quorum["reason_codes"])
    assert quorum["required_repair_action"] == "repair_route_tca_or_route_routability"


def test_lineage_and_promotion_debts_block_candidate_count():
    lineage = _only_quorum(
        _build(
            hypothesis=_hypothesis(
                candidate_id="",
                strategy_id="",
                promotion_eligible=False,
                promotion_decision_id="",
                reasons=["strategy_hypothesis_lineage_missing"],
            )
        )
    )

    assert {
        "hypothesis_candidate_id_missing",
        "promotion_decision_missing",
    } <= set(lineage["reason_codes"])


def test_missing_stage_clearance_packet_keeps_quorum_observe_only():
    missing = _only_quorum(_build(stage={}))

    assert missing["decision"] == "observe_only"
    assert "stage_clearance_packet_missing" in missing["reason_codes"]
    assert (
        missing["required_repair_action"]
        == "publish_current_torghut_stage_clearance_packet"
    )
