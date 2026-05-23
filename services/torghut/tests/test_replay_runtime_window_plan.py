from __future__ import annotations

import json
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path

from app.trading.discovery.replay_ledger_ranker import ReplayLedgerRankingPolicy
from app.trading.discovery.replay_runtime_window_plan import (
    build_replay_runtime_window_handoff,
)


def _ts(day: int, minute: int = 0) -> str:
    return datetime(2026, 5, day, 14, 30 + minute, tzinfo=timezone.utc).isoformat()


def _round_trip(day: int) -> list[dict[str, object]]:
    return [
        {
            "event_type": "decision",
            "executed_at": _ts(day, 0),
            "decision_id": "buy-decision",
            "order_id": "buy-order",
            "symbol": "AMZN",
        },
        {
            "event_type": "order_submitted",
            "executed_at": _ts(day, 1),
            "decision_id": "buy-decision",
            "order_id": "buy-order",
            "symbol": "AMZN",
        },
        {
            "event_type": "fill",
            "executed_at": _ts(day, 2),
            "decision_id": "buy-decision",
            "order_id": "buy-order",
            "symbol": "AMZN",
            "side": "buy",
            "filled_qty": "100",
            "avg_fill_price": "100",
            "cost_amount": "1",
        },
        {
            "event_type": "decision",
            "executed_at": _ts(day, 10),
            "decision_id": "sell-decision",
            "order_id": "sell-order",
            "symbol": "AMZN",
        },
        {
            "event_type": "order_submitted",
            "executed_at": _ts(day, 11),
            "decision_id": "sell-decision",
            "order_id": "sell-order",
            "symbol": "AMZN",
        },
        {
            "event_type": "fill",
            "executed_at": _ts(day, 12),
            "decision_id": "sell-decision",
            "order_id": "sell-order",
            "symbol": "AMZN",
            "side": "sell",
            "filled_qty": "100",
            "avg_fill_price": "120",
            "cost_amount": "1",
        },
    ]


def _policy() -> ReplayLedgerRankingPolicy:
    return ReplayLedgerRankingPolicy(
        target_net_pnl_per_day=Decimal("500"),
        min_window_weekday_count=20,
        min_avg_filled_notional_per_day=Decimal("300000"),
        max_best_day_share=Decimal("0.25"),
        max_gross_exposure_pct_equity=Decimal("1.0"),
        start_equity=Decimal("31590.02"),
    )


def test_handoff_builds_non_promotional_runtime_window_target(
    tmp_path: Path,
) -> None:
    artifact_path = tmp_path / "candidate-exact-replay-ledger.json"
    artifact_path.write_text(
        json.dumps(
            {
                "schema_version": "torghut.exact_replay_ledger.rows.v1",
                "candidate_id": "candidate-strong-one-day",
                "window_start": "2026-05-18",
                "window_end": "2026-05-22",
                "account_label": "TORGHUT_REPLAY",
                "execution_policy_hash": "policy-sha",
                "cost_model_hash": "cost-sha",
                "lineage_hash": "lineage-sha",
                "promotion_authority": "replay_artifact_only_not_live",
                "stage": "replay",
                "runtime_ledger_rows": _round_trip(21),
            }
        ),
        encoding="utf-8",
    )

    handoff = build_replay_runtime_window_handoff(
        ledger_paths=[artifact_path],
        policy=_policy(),
        hypothesis_id="H-PAIRS-01",
        source_manifest_ref="config/trading/hypotheses/h-pairs-01.json",
        frontier_payload={
            "family": "microbar_cross_sectional_pairs",
            "strategy_name": "microbar-cross-sectional-pairs-v1",
            "family_template": {
                "runtime_harness": {
                    "family": "microbar_cross_sectional_pairs",
                    "strategy_name": "microbar-cross-sectional-pairs-v1",
                }
            },
            "dataset_snapshot_receipt": {"snapshot_id": "snapshot-1"},
        },
    )

    assert handoff["promotion_allowed"] is False
    assert handoff["candidate_board"]["promotion_allowed"] is False
    plan = handoff["runtime_window_import_plan"]
    assert plan["promotion_allowed"] is False
    assert len(plan["targets"]) == 1
    target = plan["targets"][0]
    assert target["candidate_id"] == "candidate-strong-one-day"
    assert target["hypothesis_id"] == "H-PAIRS-01"
    assert target["strategy_family"] == "microbar_cross_sectional_pairs"
    assert target["strategy_name"] == "microbar-cross-sectional-pairs-v1"
    assert target["dataset_snapshot_ref"] == "snapshot-1"
    assert target["runtime_ledger_artifact_refs"] == [str(artifact_path.resolve())]
    assert target["runtime_ledger_artifact_row_count"] == 6
    assert target["runtime_ledger_artifact_fill_count"] == 2
    assert target["paper_probation_authorized"] is False
    assert target["promotion_allowed"] is False
    assert target["final_promotion_authorized"] is False
    assert (
        "paper_probation_evidence_collection_only" in target["final_promotion_blockers"]
    )
    assert any(
        item["blocker"] == "exact_replay_search_blockers_remaining"
        for item in plan["blockers"]
    )


def test_handoff_blocks_target_when_runtime_metadata_is_missing(
    tmp_path: Path,
) -> None:
    artifact_path = tmp_path / "candidate-exact-replay-ledger.json"
    artifact_path.write_text(
        json.dumps(
            {
                "schema_version": "torghut.exact_replay_ledger.rows.v1",
                "candidate_id": "candidate-without-harness",
                "window_start": "2026-05-18",
                "window_end": "2026-05-22",
                "account_label": "TORGHUT_REPLAY",
                "execution_policy_hash": "policy-sha",
                "cost_model_hash": "cost-sha",
                "lineage_hash": "lineage-sha",
                "promotion_authority": "replay_artifact_only_not_live",
                "stage": "replay",
                "runtime_ledger_rows": _round_trip(21),
            }
        ),
        encoding="utf-8",
    )

    handoff = build_replay_runtime_window_handoff(
        ledger_paths=[artifact_path],
        policy=_policy(),
        hypothesis_id="H-PAIRS-01",
        source_manifest_ref="config/trading/hypotheses/h-pairs-01.json",
    )

    plan = handoff["runtime_window_import_plan"]
    assert plan["targets"] == []
    assert plan["promotion_allowed"] is False
    assert plan["blockers"][0]["blocker"] == "runtime_window_plan_metadata_missing"
    assert plan["blockers"][0]["missing_fields"] == [
        "strategy_family",
        "strategy_name",
    ]
