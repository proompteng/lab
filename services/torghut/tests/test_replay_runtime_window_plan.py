from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from unittest.mock import patch

import pytest
from app.trading.discovery.replay_ledger_ranker import ReplayLedgerRankingPolicy
from app.trading.discovery.replay_runtime_window_plan import (
    build_replay_runtime_window_handoff,
)
from scripts import build_replay_runtime_window_plan as cli


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


def _frontier_payload() -> dict[str, object]:
    return {
        "family": "microbar_cross_sectional_pairs",
        "strategy_name": "microbar-cross-sectional-pairs-v1",
        "family_template": {
            "runtime_harness": {
                "family": "microbar_cross_sectional_pairs",
                "strategy_name": "microbar-cross-sectional-pairs-v1",
            }
        },
        "dataset_snapshot_receipt": {"snapshot_id": "snapshot-1"},
    }


def _write_replay_ledger(
    path: Path,
    *,
    candidate_id: str,
    include_lineage: bool = True,
) -> Path:
    rows = _round_trip(21)
    if include_lineage:
        for row in rows:
            if row.get("event_type") == "fill":
                row["adv_source"] = "observed_microbar_notional_by_symbol_day"
                row["adv_notional"] = "10000000"
                row["participation_rate"] = "0.001"
                row["capacity_warning_codes"] = []
    payload: dict[str, object] = {
        "schema_version": "torghut.exact_replay_ledger.rows.v1",
        "candidate_id": candidate_id,
        "candidate_identity": {
            "candidate_id": candidate_id,
            "candidate_identity_hash": f"identity-{candidate_id}",
            "source_manifest_ref": f"manifests/{candidate_id}.json",
        },
        "candidate_identity_hash": f"identity-{candidate_id}",
        "window_start": "2026-05-18",
        "window_end": "2026-05-22",
        "account_label": "TORGHUT_REPLAY",
        "execution_policy_hash": "policy-sha",
        "cost_model_hash": "cost-sha",
        "cost_lineage": {
            "cost_lineage_hash": f"cost-lineage-{candidate_id}",
            "adv_source": "observed_microbar_notional_by_symbol_day",
            "warning_contract": ["missing_adv", "participation_exceeds_max"],
        },
        "cost_lineage_hash": f"cost-lineage-{candidate_id}",
        "lineage_hash": "lineage-sha",
        "promotion_authority": "replay_artifact_only_not_live",
        "stage": "replay",
        "runtime_ledger_rows": rows,
    }
    if not include_lineage:
        for key in (
            "candidate_id",
            "candidate_identity",
            "candidate_identity_hash",
            "cost_lineage",
            "cost_lineage_hash",
        ):
            payload.pop(key, None)
    path.write_text(
        json.dumps(payload),
        encoding="utf-8",
    )
    return path


def test_handoff_builds_non_promotional_runtime_window_target(
    tmp_path: Path,
) -> None:
    artifact_path = _write_replay_ledger(
        tmp_path / "candidate-exact-replay-ledger.json",
        candidate_id="candidate-strong-one-day",
    )

    handoff = build_replay_runtime_window_handoff(
        ledger_paths=[artifact_path],
        policy=_policy(),
        hypothesis_id="H-PAIRS-01",
        source_manifest_ref="config/trading/hypotheses/h-pairs-01.json",
        frontier_payload=_frontier_payload(),
    )

    assert handoff["promotion_allowed"] is False
    assert handoff["candidate_board"]["promotion_allowed"] is False
    plan = handoff["runtime_window_import_plan"]
    assert plan["promotion_allowed"] is False
    assert len(plan["targets"]) == 1
    target = plan["targets"][0]
    assert target["candidate_id"] == "candidate-strong-one-day"
    assert (
        target["replay_candidate_identity_hash"]
        == "identity-candidate-strong-one-day"
    )
    assert target["replay_cost_lineage_hash"] == "cost-lineage-candidate-strong-one-day"
    assert target["replay_fills_with_adv_notional"] == 2
    assert target["replay_fills_with_participation_rate"] == 2
    assert target["replay_fills_with_capacity_warning_contract"] == 2
    assert target["replay_capacity_warning_counts"] == {}
    assert target["hypothesis_id"] == "H-PAIRS-01"
    assert target["strategy_family"] == "microbar_cross_sectional_pairs"
    assert target["strategy_name"] == "microbar-cross-sectional-pairs-v1"
    assert target["dataset_snapshot_ref"] == "snapshot-1"
    assert target["runtime_ledger_artifact_refs"] == [str(artifact_path.resolve())]
    assert target["runtime_ledger_artifact_row_count"] == 6
    assert target["runtime_ledger_artifact_fill_count"] == 2
    assert target["replay_window_weekday_count"] == 5
    assert target["replay_min_window_weekday_count"] == 20
    assert target["replay_target_net_pnl_per_day"] == "500"
    assert target["paper_probation_authorized"] is False
    assert target["promotion_allowed"] is False
    assert target["final_promotion_authorized"] is False
    assert (
        "window_weekday_count_below_min_observed_trading_days"
        in target["runtime_ledger_target_metadata_blockers"]
    )
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
    artifact_path = _write_replay_ledger(
        tmp_path / "candidate-exact-replay-ledger.json",
        candidate_id="candidate-without-harness",
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


def test_handoff_blocks_probation_when_replay_lineage_is_missing(
    tmp_path: Path,
) -> None:
    artifact_path = _write_replay_ledger(
        tmp_path / "candidate-missing-lineage.json",
        candidate_id="candidate-missing-lineage",
        include_lineage=False,
    )

    handoff = build_replay_runtime_window_handoff(
        ledger_paths=[artifact_path],
        policy=ReplayLedgerRankingPolicy(
            target_net_pnl_per_day=Decimal("1"),
            min_window_weekday_count=1,
            min_avg_filled_notional_per_day=Decimal("1"),
            max_best_day_share=Decimal("1.0"),
            max_gross_exposure_pct_equity=Decimal("10.0"),
            start_equity=Decimal("100000"),
        ),
        hypothesis_id="H-PAIRS-01",
        source_manifest_ref="config/trading/hypotheses/h-pairs-01.json",
        frontier_payload=_frontier_payload(),
    )

    plan = handoff["runtime_window_import_plan"]
    target = plan["targets"][0]
    assert target["paper_probation_authorized"] is False
    assert target["probation_allowed"] is False
    assert "candidate_id_missing" in target["final_promotion_blockers"]
    assert "exact_replay_cost_lineage_missing" in target["final_promotion_blockers"]
    assert any(
        item["blocker"] == "exact_replay_search_blockers_remaining"
        and "fill_adv_notional_missing" in item["blocking_reasons"]
        for item in plan["blockers"]
    )


def test_handoff_blocks_target_when_no_ledger_candidate_exists() -> None:
    handoff = build_replay_runtime_window_handoff(
        ledger_paths=[],
        policy=_policy(),
        hypothesis_id="H-PAIRS-01",
        source_manifest_ref="config/trading/hypotheses/h-pairs-01.json",
        frontier_payload=_frontier_payload(),
    )

    plan = handoff["runtime_window_import_plan"]
    assert plan["targets"] == []
    assert plan["blockers"] == [
        {
            "blocker": "exact_replay_ledger_candidate_missing",
            "remediation": "produce_exact_replay_ledger_artifacts",
        }
    ]


def test_cli_writes_handoff_from_glob_and_frontier(tmp_path: Path) -> None:
    ledger_dir = tmp_path / "ledgers"
    ledger_dir.mkdir()
    _write_replay_ledger(
        ledger_dir / "candidate-exact-replay-ledger.json",
        candidate_id="candidate-from-cli-glob",
    )
    frontier_path = tmp_path / "frontier.json"
    frontier_path.write_text(json.dumps(_frontier_payload()), encoding="utf-8")
    output_path = tmp_path / "handoff" / "plan.json"

    with patch.object(
        sys,
        "argv",
        [
            "build_replay_runtime_window_plan.py",
            "--ledger-glob",
            str(ledger_dir / "*.json"),
            "--frontier-result",
            str(frontier_path),
            "--hypothesis-id",
            "H-PAIRS-01",
            "--source-manifest-ref",
            "config/trading/hypotheses/h-pairs-01.json",
            "--run-id",
            "runtime-window-cli-run",
            "--target-net-pnl-per-day",
            "500",
            "--start-equity",
            "31590.02",
            "--limit",
            "5",
            "--output",
            str(output_path),
        ],
    ):
        assert cli.main() == 0

    payload = json.loads(output_path.read_text(encoding="utf-8"))
    target = payload["runtime_window_import_plan"]["targets"][0]
    assert target["run_id"] == "runtime-window-cli-run"
    assert target["candidate_id"] == "candidate-from-cli-glob"
    assert target["strategy_family"] == "microbar_cross_sectional_pairs"
    assert target["strategy_name"] == "microbar-cross-sectional-pairs-v1"
    assert target["dataset_snapshot_ref"] == "snapshot-1"
    assert target["promotion_allowed"] is False


def test_cli_prints_handoff_to_stdout_without_frontier(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    artifact_path = _write_replay_ledger(
        tmp_path / "candidate-exact-replay-ledger.json",
        candidate_id="candidate-from-cli-stdout",
    )

    with patch.object(
        sys,
        "argv",
        [
            "build_replay_runtime_window_plan.py",
            str(artifact_path),
            "--hypothesis-id",
            "H-PAIRS-01",
            "--source-manifest-ref",
            "config/trading/hypotheses/h-pairs-01.json",
            "--strategy-family",
            "manual_family",
            "--strategy-name",
            "manual-strategy-v1",
            "--source-kind",
            "manual_exact_replay",
            "--observed-stage",
            "live",
        ],
    ):
        assert cli.main() == 0

    payload = json.loads(capsys.readouterr().out)
    target = payload["runtime_window_import_plan"]["targets"][0]
    assert target["candidate_id"] == "candidate-from-cli-stdout"
    assert target["strategy_family"] == "manual_family"
    assert target["strategy_name"] == "manual-strategy-v1"
    assert target["source_kind"] == "manual_exact_replay"
    assert target["observed_stage"] == "live"


def test_cli_rejects_invalid_frontier_payload(tmp_path: Path) -> None:
    frontier_path = tmp_path / "frontier.json"
    frontier_path.write_text("[1, 2, 3]", encoding="utf-8")

    with pytest.raises(SystemExit, match=f"frontier_result_invalid:{frontier_path}"):
        cli._frontier_payload(frontier_path)


def test_cli_requires_ledger_paths() -> None:
    with patch.object(
        sys,
        "argv",
        [
            "build_replay_runtime_window_plan.py",
            "--hypothesis-id",
            "H-PAIRS-01",
            "--source-manifest-ref",
            "config/trading/hypotheses/h-pairs-01.json",
        ],
    ):
        with pytest.raises(
            SystemExit,
            match="provide at least one ledger path or --ledger-glob",
        ):
            cli.main()
