from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path

import pytest

import app.trading.discovery.replay_ledger_ranker as ranker
import scripts.rank_replay_ledgers as rank_replay_ledgers_cli
from app.trading.discovery.replay_ledger_ranker import (
    ReplayLedgerRankingPolicy,
    build_replay_ledger_ranking_report,
    default_replay_ledger_ranking_policy,
    rank_replay_ledger_files,
    rank_replay_ledger_payload,
)


def _ts(day: int, minute: int = 0) -> str:
    return datetime(2026, 5, day, 14, 30 + minute, tzinfo=timezone.utc).isoformat()


def _round_trip(
    *,
    day: int,
    symbol: str,
    qty: str,
    buy_price: str,
    sell_price: str,
    prefix: str,
) -> list[dict[str, object]]:
    return [
        {
            "event_type": "decision",
            "executed_at": _ts(day, 0),
            "decision_id": f"{prefix}-buy-decision",
            "symbol": symbol,
        },
        {
            "event_type": "order_submitted",
            "executed_at": _ts(day, 1),
            "decision_id": f"{prefix}-buy-decision",
            "order_id": f"{prefix}-buy-order",
            "symbol": symbol,
        },
        {
            "event_type": "fill",
            "executed_at": _ts(day, 2),
            "decision_id": f"{prefix}-buy-decision",
            "order_id": f"{prefix}-buy-order",
            "symbol": symbol,
            "side": "buy",
            "filled_qty": qty,
            "avg_fill_price": buy_price,
            "cost_amount": "1",
        },
        {
            "event_type": "decision",
            "executed_at": _ts(day, 10),
            "decision_id": f"{prefix}-sell-decision",
            "symbol": symbol,
        },
        {
            "event_type": "order_submitted",
            "executed_at": _ts(day, 11),
            "decision_id": f"{prefix}-sell-decision",
            "order_id": f"{prefix}-sell-order",
            "symbol": symbol,
        },
        {
            "event_type": "fill",
            "executed_at": _ts(day, 12),
            "decision_id": f"{prefix}-sell-decision",
            "order_id": f"{prefix}-sell-order",
            "symbol": symbol,
            "side": "sell",
            "filled_qty": qty,
            "avg_fill_price": sell_price,
            "cost_amount": "1",
        },
    ]


def _payload(
    candidate_id: str,
    rows: list[dict[str, object]],
    *,
    promotion_authority: str = "replay_artifact_only_not_live",
    include_lineage: bool = True,
) -> dict[str, object]:
    if include_lineage:
        for row in rows:
            if row.get("event_type") == "fill":
                row["adv_source"] = "observed_microbar_notional_by_symbol_day"
                row["adv_notional"] = "10000000"
                row["participation_rate"] = "0.0001"
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
        "cost_basis": "local_replay_transaction_cost_model",
        "execution_policy_hash": "policy-sha",
        "cost_model_hash": "cost-sha",
        "cost_lineage": {
            "cost_lineage_hash": f"cost-lineage-{candidate_id}",
            "adv_source": "observed_microbar_notional_by_symbol_day",
            "warning_contract": ["missing_adv", "participation_exceeds_max"],
        },
        "cost_lineage_hash": f"cost-lineage-{candidate_id}",
        "lineage_hash": "lineage-sha",
        "promotion_authority": promotion_authority,
        "stage": "replay",
        "source": "local_intraday_tsmom_replay",
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
    return payload


def _policy() -> ReplayLedgerRankingPolicy:
    return ReplayLedgerRankingPolicy(
        target_net_pnl_per_day=Decimal("500"),
        min_window_weekday_count=20,
        min_avg_filled_notional_per_day=Decimal("300000"),
        max_best_day_share=Decimal("0.25"),
        max_gross_exposure_pct_equity=Decimal("1.0"),
        start_equity=Decimal("1000"),
    )


def test_ranker_uses_runtime_ledger_net_pnl_and_window_day_ranking(
    tmp_path: Path,
) -> None:
    concentrated = _payload(
        "concentrated-active-day-winner",
        _round_trip(
            day=18,
            symbol="NVDA",
            qty="10",
            buy_price="100",
            sell_price="110.2",
            prefix="concentrated",
        ),
    )
    distributed = _payload(
        "distributed-window-winner",
        [
            *_round_trip(
                day=18,
                symbol="NVDA",
                qty="4",
                buy_price="100",
                sell_price="110.5",
                prefix="dist-1",
            ),
            *_round_trip(
                day=19,
                symbol="AAPL",
                qty="4",
                buy_price="100",
                sell_price="110.5",
                prefix="dist-2",
            ),
            *_round_trip(
                day=20,
                symbol="AMD",
                qty="4",
                buy_price="100",
                sell_price="110.5",
                prefix="dist-3",
            ),
        ],
    )
    concentrated_path = tmp_path / "concentrated.json"
    distributed_path = tmp_path / "distributed.json"
    concentrated_path.write_text(json.dumps(concentrated))
    distributed_path.write_text(json.dumps(distributed))

    report = build_replay_ledger_ranking_report(
        [concentrated_path, distributed_path],
        policy=_policy(),
    )
    top = report["candidates"][0]

    assert top["candidate_id"] == "distributed-window-winner"
    assert top["total_net_pnl_after_costs"] == "120.0"
    assert top["window_net_pnl_per_day"] == "24.0"
    assert top["active_net_pnl_per_day"] == "40.0"


def test_ranker_blocks_replay_only_and_over_equity_artifacts() -> None:
    ranking = rank_replay_ledger_payload(
        _payload(
            "oversized-replay-only",
            _round_trip(
                day=18,
                symbol="NVDA",
                qty="20",
                buy_price="100",
                sell_price="101",
                prefix="oversized",
            ),
        ),
        artifact_ref="/tmp/oversized.json",
        policy=_policy(),
    )

    assert ranking.max_single_fill_notional_pct_equity == Decimal("2.02")
    assert "replay_artifact_only_not_live" in ranking.promotion_blockers
    assert "max_single_fill_notional_pct_equity_above_max" in ranking.promotion_blockers
    assert ranking.promotion_status == "blocked_pending_runtime_promotion_proof"


def test_ranker_blocks_missing_candidate_identity_and_cost_lineage() -> None:
    ranking = rank_replay_ledger_payload(
        _payload(
            "missing-lineage",
            _round_trip(
                day=18,
                symbol="NVDA",
                qty="20",
                buy_price="100",
                sell_price="160",
                prefix="missing-lineage",
            ),
            promotion_authority="live_paper_runtime_ledger",
            include_lineage=False,
        ),
        artifact_ref="/tmp/missing-lineage.json",
        policy=ReplayLedgerRankingPolicy(
            target_net_pnl_per_day=Decimal("1"),
            min_window_weekday_count=1,
            min_avg_filled_notional_per_day=Decimal("1"),
            max_best_day_share=Decimal("1.0"),
            max_gross_exposure_pct_equity=Decimal("10.0"),
            start_equity=Decimal("100000"),
        ),
    )

    assert ranking.candidate_id == "missing-lineage"
    assert "candidate_id_missing" in ranking.promotion_blockers
    assert "candidate_identity_missing" in ranking.promotion_blockers
    assert "exact_replay_cost_lineage_missing" in ranking.promotion_blockers
    assert "adv_capacity_lineage_missing" in ranking.promotion_blockers
    assert "fill_adv_notional_missing" in ranking.promotion_blockers
    assert ranking.promotion_status == "blocked_pending_runtime_promotion_proof"


def test_ranker_exposes_candidate_and_cost_lineage_when_present() -> None:
    ranking = rank_replay_ledger_payload(
        _payload(
            "lineaged-candidate",
            _round_trip(
                day=18,
                symbol="NVDA",
                qty="20",
                buy_price="100",
                sell_price="160",
                prefix="lineaged",
            ),
            promotion_authority="live_paper_runtime_ledger",
        ),
        artifact_ref="/tmp/lineaged.json",
        policy=ReplayLedgerRankingPolicy(
            target_net_pnl_per_day=Decimal("1"),
            min_window_weekday_count=1,
            min_avg_filled_notional_per_day=Decimal("1"),
            max_best_day_share=Decimal("1.0"),
            max_gross_exposure_pct_equity=Decimal("10.0"),
            start_equity=Decimal("100000"),
        ),
    )

    payload = ranking.to_payload()
    assert payload["candidate_identity_hash"] == "identity-lineaged-candidate"
    assert payload["cost_lineage_hash"] == "cost-lineage-lineaged-candidate"
    assert payload["fills_with_adv_notional"] == 2
    assert payload["fills_with_participation_rate"] == 2
    assert payload["fills_with_capacity_warning_contract"] == 2
    assert "candidate_id_missing" not in ranking.promotion_blockers
    assert "fill_adv_notional_missing" not in ranking.promotion_blockers


def test_default_policy_tracks_oracle_promotion_gates() -> None:
    policy = default_replay_ledger_ranking_policy(
        target_net_pnl_per_day=Decimal("250"),
        start_equity=Decimal("2000"),
    )

    assert policy.target_net_pnl_per_day == Decimal("250")
    assert policy.min_window_weekday_count == 20
    assert policy.min_avg_filled_notional_per_day == Decimal("300000")
    assert policy.start_equity == Decimal("2000")


def test_rank_files_reports_invalid_payloads_and_skips_duplicates(
    tmp_path: Path,
) -> None:
    invalid = tmp_path / "invalid.json"
    invalid.write_text("[]")
    missing = tmp_path / "missing.json"

    rankings, failures = rank_replay_ledger_files(
        [invalid, invalid, missing],
        policy=_policy(),
    )

    assert rankings == []
    assert [failure.reason for failure in failures] == [
        "ledger_payload_not_object",
        f"[Errno 2] No such file or directory: '{missing}'",
    ]
    assert failures[0].to_payload() == {
        "artifact_ref": str(invalid.resolve()),
        "reason": "ledger_payload_not_object",
    }


def test_rank_payload_rejects_malformed_ledger_inputs() -> None:
    valid_window = {
        "window_start": "2026-05-18",
        "window_end": "2026-05-22",
    }
    with pytest.raises(ValueError, match="runtime_ledger_rows_missing"):
        rank_replay_ledger_payload(
            valid_window, artifact_ref="/tmp/x.json", policy=_policy()
        )

    with pytest.raises(ValueError, match="runtime_ledger_rows_invalid"):
        rank_replay_ledger_payload(
            {**valid_window, "runtime_ledger_rows": ["not-a-row"]},
            artifact_ref="/tmp/x.json",
            policy=_policy(),
        )

    with pytest.raises(ValueError, match="window_bounds_missing"):
        rank_replay_ledger_payload(
            {
                "runtime_ledger_rows": _round_trip(
                    day=18,
                    symbol="NVDA",
                    qty="1",
                    buy_price="1",
                    sell_price="2",
                    prefix="missing-window",
                )
            },
            artifact_ref="/tmp/x.json",
            policy=_policy(),
        )

    with pytest.raises(ValueError, match="window_end_before_start"):
        rank_replay_ledger_payload(
            {
                "window_start": "2026-05-22",
                "window_end": "2026-05-18",
                "runtime_ledger_rows": _round_trip(
                    day=18,
                    symbol="NVDA",
                    qty="1",
                    buy_price="1",
                    sell_price="2",
                    prefix="reversed",
                ),
            },
            artifact_ref="/tmp/x.json",
            policy=_policy(),
        )


def test_rank_payload_rejects_windows_without_weekdays() -> None:
    with pytest.raises(ValueError, match="window_weekdays_missing"):
        rank_replay_ledger_payload(
            _payload(
                "weekend-only",
                _round_trip(
                    day=16,
                    symbol="NVDA",
                    qty="1",
                    buy_price="100",
                    sell_price="101",
                    prefix="weekend",
                ),
            )
            | {"window_start": "2026-05-16", "window_end": "2026-05-17"},
            artifact_ref="/tmp/weekend.json",
            policy=_policy(),
        )


def test_full_window_bucket_failure_is_reported(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        ranker, "build_runtime_ledger_buckets", lambda *args, **kwargs: []
    )

    with pytest.raises(ValueError, match="runtime_ledger_bucket_missing"):
        ranker.rank_replay_ledger_payload(
            _payload(
                "bucket-missing",
                _round_trip(
                    day=18,
                    symbol="NVDA",
                    qty="1",
                    buy_price="100",
                    sell_price="101",
                    prefix="bucket-missing",
                ),
            ),
            artifact_ref="/tmp/bucket.json",
            policy=_policy(),
        )


def test_ranker_flags_missing_equity_and_supports_helper_edge_cases() -> None:
    ranking = rank_replay_ledger_payload(
        _payload(
            "missing-equity",
            _round_trip(
                day=18,
                symbol="NVDA",
                qty="1",
                buy_price="100",
                sell_price="101",
                prefix="missing-equity",
            ),
        ),
        artifact_ref="/tmp/missing-equity.json",
        policy=ReplayLedgerRankingPolicy(
            target_net_pnl_per_day=Decimal("500"),
            min_window_weekday_count=20,
            min_avg_filled_notional_per_day=Decimal("300000"),
            max_best_day_share=Decimal("0.25"),
            max_gross_exposure_pct_equity=Decimal("1.0"),
            start_equity=None,
        ),
    )

    assert "start_equity_missing_for_exposure_check" in ranking.promotion_blockers
    assert ranker._daily_bucket_ranges(
        datetime(2026, 5, 18, 14, 30, tzinfo=timezone.utc),
        datetime(2026, 5, 18, 15, 0, tzinfo=timezone.utc),
    )[0][0] == datetime(2026, 5, 18, 14, 30, tzinfo=timezone.utc)
    assert ranker._parse_window_datetime("") is None
    assert ranker._parse_window_datetime("bad-date") is None
    assert ranker._parse_window_datetime("2026-05-18T14:30:00Z") == datetime(
        2026,
        5,
        18,
        14,
        30,
        tzinfo=timezone.utc,
    )
    assert ranker._utc(datetime(2026, 5, 18, 14, 30)) == datetime(
        2026,
        5,
        18,
        14,
        30,
        tzinfo=timezone.utc,
    )
    assert ranker._best_day_share(
        {"2026-05-18": Decimal("-1")}, Decimal("-1")
    ) == Decimal("1")
    assert ranker._profit_factor(
        {"2026-05-18": Decimal("3"), "2026-05-19": Decimal("-2")}
    ) == Decimal("1.5")
    assert ranker._fill_notional({"filled_notional": "123.45"}) == Decimal("123.45")
    assert ranker._fill_notional({"filled_qty": "0", "avg_fill_price": "100"}) is None
    assert ranker._event_type({"event_type": "filled"}) == "fill"
    assert ranker._event_type({"event_type": "trade_decision"}) == "decision"
    assert ranker._event_type({"event_type": "submitted"}) == "order_submitted"
    assert ranker._event_type({"filled_qty": "1"}) == "fill"
    assert ranker._positive_decimal("0") is None
    assert ranker._positive_decimal("not-decimal") is None
    assert ranker._safe_divide(Decimal("1"), Decimal("0")) == Decimal("0")
    assert ranker._dedupe(["a", "a", "b"]) == ["a", "b"]


def test_rank_replay_ledgers_cli_writes_output(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    ledger_path = tmp_path / "ledger.json"
    output_path = tmp_path / "report.json"
    ledger_path.write_text(
        json.dumps(
            _payload(
                "cli-ledger",
                _round_trip(
                    day=18,
                    symbol="NVDA",
                    qty="1",
                    buy_price="100",
                    sell_price="101",
                    prefix="cli",
                ),
            )
        )
    )
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "rank_replay_ledgers.py",
            str(ledger_path),
            "--output",
            str(output_path),
            "--limit",
            "1",
            "--target-net-pnl-per-day",
            "25",
            "--start-equity",
            "1000",
        ],
    )

    assert rank_replay_ledgers_cli.main() == 0
    report = json.loads(output_path.read_text())
    assert report["candidates"][0]["candidate_id"] == "cli-ledger"
    assert report["policy"]["target_net_pnl_per_day"] == "25"
    assert report["policy"]["start_equity"] == "1000"


def test_rank_replay_ledgers_cli_supports_glob_and_stdout(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    ledger_path = tmp_path / "ledger.json"
    ledger_path.write_text(
        json.dumps(
            _payload(
                "glob-ledger",
                _round_trip(
                    day=18,
                    symbol="NVDA",
                    qty="1",
                    buy_price="100",
                    sell_price="101",
                    prefix="glob",
                ),
            )
        )
    )
    monkeypatch.setattr(
        sys,
        "argv",
        ["rank_replay_ledgers.py", "--ledger-glob", str(tmp_path / "*.json")],
    )

    assert rank_replay_ledgers_cli.main() == 0
    report = json.loads(capsys.readouterr().out)
    assert report["candidates"][0]["candidate_id"] == "glob-ledger"


def test_rank_replay_ledgers_cli_requires_input(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(sys, "argv", ["rank_replay_ledgers.py"])

    with pytest.raises(SystemExit, match="provide at least one ledger path"):
        rank_replay_ledgers_cli.main()
