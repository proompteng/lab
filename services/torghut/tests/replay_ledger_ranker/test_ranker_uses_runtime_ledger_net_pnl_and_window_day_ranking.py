from __future__ import annotations

from tests.replay_ledger_ranker.support import (
    Decimal,
    Path,
    ReplayLedgerRankingPolicy,
    _payload,
    _policy,
    _round_trip,
    _with_execution_quality,
    _with_lob_reality_gap_evidence,
    _with_microstructure_stress_evidence,
    build_replay_ledger_ranking_report,
    datetime,
    default_replay_ledger_ranking_policy,
    json,
    pytest,
    rank_replay_ledger_files,
    rank_replay_ledger_payload,
    ranker,
    timezone,
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


def test_ranker_uses_market_limit_queue_execution_quality_for_adjusted_ranking(
    tmp_path: Path,
) -> None:
    cleaner = _payload(
        "cleaner-limit-fill-evidence",
        _with_execution_quality(
            _round_trip(
                day=18,
                symbol="NVDA",
                qty="1000",
                buy_price="100",
                sell_price="100.90",
                prefix="cleaner",
            ),
            order_type="limit",
            shortfall_bps="1",
            limit_fill_probability="0.82",
            queue_position="0.15",
            opportunity_cost_bps="2",
            price_improvement_bps="3",
        ),
    )
    raw_winner_execution_risk = _payload(
        "raw-winner-execution-risk",
        _with_execution_quality(
            _round_trip(
                day=18,
                symbol="NVDA",
                qty="1000",
                buy_price="100",
                sell_price="101.00",
                prefix="riskier",
            ),
            order_type="limit",
            shortfall_bps="18",
        ),
    )
    cleaner_path = tmp_path / "cleaner.json"
    riskier_path = tmp_path / "riskier.json"
    cleaner_path.write_text(json.dumps(cleaner))
    riskier_path.write_text(json.dumps(raw_winner_execution_risk))

    report = build_replay_ledger_ranking_report(
        [cleaner_path, riskier_path],
        policy=ReplayLedgerRankingPolicy(
            target_net_pnl_per_day=Decimal("1"),
            min_window_weekday_count=1,
            min_avg_filled_notional_per_day=Decimal("1"),
            max_best_day_share=Decimal("1.0"),
            max_gross_exposure_pct_equity=Decimal("1000.0"),
            start_equity=Decimal("100000000"),
        ),
    )
    top = report["candidates"][0]
    raw_winner = report["candidates"][1]

    assert top["candidate_id"] == "cleaner-limit-fill-evidence"
    assert top["execution_quality_penalty_bps"] == "0"
    assert top["execution_quality"]["limit_fill_rate"] == "1"
    assert top["execution_quality"]["limit_fill_probability_sample_count"] == 4
    assert top["execution_quality"]["queue_position_sample_count"] == 4
    assert raw_winner["candidate_id"] == "raw-winner-execution-risk"
    assert (
        "limit_fill_probability_evidence_incomplete"
        in raw_winner["execution_quality_blockers"]
    )
    assert (
        "queue_position_survival_evidence_incomplete"
        in raw_winner["execution_quality_blockers"]
    )
    assert Decimal(
        str(top["execution_quality_adjusted_window_net_pnl_per_day"])
    ) > Decimal(str(raw_winner["execution_quality_adjusted_window_net_pnl_per_day"]))


def test_ranker_penalizes_missing_closing_auction_mechanism_evidence(
    tmp_path: Path,
) -> None:
    complete = _payload(
        "complete-closing-auction-evidence",
        _with_execution_quality(
            _round_trip(
                day=18,
                symbol="NVDA",
                qty="1000",
                buy_price="100",
                sell_price="100.80",
                prefix="complete-closing",
            ),
            order_type="limit",
            shortfall_bps="1",
            limit_fill_probability="0.80",
            queue_position="0.20",
            opportunity_cost_bps="2",
            price_improvement_bps="3",
        ),
    )
    missing_mechanism = _payload(
        "missing-closing-auction-evidence",
        _with_execution_quality(
            _round_trip(
                day=18,
                symbol="NVDA",
                qty="1000",
                buy_price="100",
                sell_price="100.82",
                prefix="missing-closing",
            ),
            order_type="limit",
            shortfall_bps="1",
            limit_fill_probability="0.80",
            queue_position="0.20",
            opportunity_cost_bps="2",
            price_improvement_bps="3",
            include_closing_auction_evidence=False,
        ),
    )
    complete_path = tmp_path / "complete.json"
    missing_path = tmp_path / "missing.json"
    complete_path.write_text(json.dumps(complete))
    missing_path.write_text(json.dumps(missing_mechanism))

    report = build_replay_ledger_ranking_report(
        [complete_path, missing_path],
        policy=ReplayLedgerRankingPolicy(
            target_net_pnl_per_day=Decimal("1"),
            min_window_weekday_count=1,
            min_avg_filled_notional_per_day=Decimal("1"),
            max_best_day_share=Decimal("1.0"),
            max_gross_exposure_pct_equity=Decimal("1000.0"),
            start_equity=Decimal("100000000"),
        ),
    )
    top = report["candidates"][0]
    missing = report["candidates"][1]

    assert top["candidate_id"] == "complete-closing-auction-evidence"
    assert top["execution_quality"]["closing_window_sample_count"] == 4
    assert top["execution_quality"]["closing_auction_sample_count"] == 4
    assert top["execution_quality"]["closing_auction_projection_sample_count"] == 4
    assert top["execution_quality"]["closing_auction_clearing_price_sample_count"] == 4
    assert top["execution_quality"]["terminal_inventory_path_sample_count"] == 4
    assert "closing_window_evidence_incomplete" not in top["execution_quality_blockers"]
    assert missing["candidate_id"] == "missing-closing-auction-evidence"
    assert {
        "closing_window_evidence_incomplete",
        "closing_auction_evidence_incomplete",
        "closing_auction_projection_evidence_incomplete",
        "closing_auction_clearing_price_evidence_incomplete",
        "terminal_inventory_path_evidence_incomplete",
    }.issubset(set(missing["execution_quality_blockers"]))
    assert Decimal(str(missing["execution_quality_penalty_bps"])) > Decimal("0")
    assert missing["promotion_status"] == "blocked_pending_runtime_promotion_proof"


def test_ranker_discounts_fragile_lob_reality_gap_candidates(
    tmp_path: Path,
) -> None:
    stable = _payload(
        "stable-lob-lower-raw-pnl",
        _with_lob_reality_gap_evidence(
            _with_execution_quality(
                _round_trip(
                    day=18,
                    symbol="NVDA",
                    qty="1000",
                    buy_price="100",
                    sell_price="100.90",
                    prefix="stable-lob",
                ),
                order_type="limit",
                shortfall_bps="1",
                limit_fill_probability="0.82",
                queue_position="0.15",
                opportunity_cost_bps="2",
                price_improvement_bps="3",
            ),
            fragile=False,
        ),
    )
    fragile_raw_winner = _payload(
        "fragile-lob-higher-raw-pnl",
        _with_lob_reality_gap_evidence(
            _with_execution_quality(
                _round_trip(
                    day=18,
                    symbol="NVDA",
                    qty="1000",
                    buy_price="100",
                    sell_price="101.00",
                    prefix="fragile-lob",
                ),
                order_type="limit",
                shortfall_bps="1",
                limit_fill_probability="0.82",
                queue_position="0.15",
                opportunity_cost_bps="2",
                price_improvement_bps="3",
            ),
            fragile=True,
        ),
    )
    stable_path = tmp_path / "stable.json"
    fragile_path = tmp_path / "fragile.json"
    stable_path.write_text(json.dumps(stable))
    fragile_path.write_text(json.dumps(fragile_raw_winner))

    report = build_replay_ledger_ranking_report(
        [stable_path, fragile_path],
        policy=ReplayLedgerRankingPolicy(
            target_net_pnl_per_day=Decimal("1"),
            min_window_weekday_count=1,
            min_avg_filled_notional_per_day=Decimal("1"),
            max_best_day_share=Decimal("1.0"),
            max_gross_exposure_pct_equity=Decimal("1000.0"),
            start_equity=Decimal("100000000"),
        ),
    )
    top = report["candidates"][0]
    fragile = report["candidates"][1]

    assert top["candidate_id"] == "stable-lob-lower-raw-pnl"
    assert fragile["candidate_id"] == "fragile-lob-higher-raw-pnl"
    assert Decimal(str(fragile["window_net_pnl_per_day"])) > Decimal(
        str(top["window_net_pnl_per_day"])
    )
    assert Decimal(str(fragile["lob_reality_gap_penalty_bps"])) > Decimal(
        str(top["lob_reality_gap_penalty_bps"])
    )
    assert Decimal(
        str(top["replay_quality_adjusted_window_net_pnl_per_day"])
    ) > Decimal(str(fragile["replay_quality_adjusted_window_net_pnl_per_day"]))
    assert "arxiv-2603.24137" in {
        item["source_id"] for item in fragile["lob_reality_gap_stress"]["source_papers"]
    }
    assert fragile["lob_reality_gap_stress"]["promotion_authority"] is False


def test_ranker_discounts_microstructure_fragile_candidates(
    tmp_path: Path,
) -> None:
    stable = _payload(
        "stable-microstructure-lower-raw-pnl",
        _with_microstructure_stress_evidence(
            _with_execution_quality(
                _round_trip(
                    day=18,
                    symbol="NVDA",
                    qty="1000",
                    buy_price="100",
                    sell_price="100.90",
                    prefix="stable-microstructure",
                ),
                order_type="limit",
                shortfall_bps="1",
                limit_fill_probability="0.82",
                queue_position="0.15",
                opportunity_cost_bps="2",
                price_improvement_bps="3",
            ),
            fragile=False,
        ),
    )
    fragile_raw_winner = _payload(
        "fragile-microstructure-higher-raw-pnl",
        _with_microstructure_stress_evidence(
            _with_execution_quality(
                _round_trip(
                    day=18,
                    symbol="NVDA",
                    qty="1000",
                    buy_price="100",
                    sell_price="101.00",
                    prefix="fragile-microstructure",
                ),
                order_type="market",
                shortfall_bps="1",
                limit_fill_probability="0.82",
                queue_position="0.15",
                opportunity_cost_bps="2",
                price_improvement_bps="3",
            ),
            fragile=True,
        ),
    )
    stable_path = tmp_path / "stable-microstructure.json"
    fragile_path = tmp_path / "fragile-microstructure.json"
    stable_path.write_text(json.dumps(stable))
    fragile_path.write_text(json.dumps(fragile_raw_winner))

    report = build_replay_ledger_ranking_report(
        [stable_path, fragile_path],
        policy=ReplayLedgerRankingPolicy(
            target_net_pnl_per_day=Decimal("1"),
            min_window_weekday_count=1,
            min_avg_filled_notional_per_day=Decimal("1"),
            max_best_day_share=Decimal("1.0"),
            max_gross_exposure_pct_equity=Decimal("1000.0"),
            start_equity=Decimal("100000000"),
        ),
    )
    top = report["candidates"][0]
    fragile = report["candidates"][1]

    assert top["candidate_id"] == "stable-microstructure-lower-raw-pnl"
    assert fragile["candidate_id"] == "fragile-microstructure-higher-raw-pnl"
    assert Decimal(str(fragile["window_net_pnl_per_day"])) > Decimal(
        str(top["window_net_pnl_per_day"])
    )
    assert Decimal(str(fragile["microstructure_stress_penalty_bps"])) > Decimal(
        str(top["microstructure_stress_penalty_bps"])
    )
    assert Decimal(
        str(top["replay_quality_adjusted_window_net_pnl_per_day"])
    ) > Decimal(str(fragile["replay_quality_adjusted_window_net_pnl_per_day"]))
    source_ids = {
        item["source_id"] for item in fragile["microstructure_stress"]["source_papers"]
    }
    assert {
        "arxiv-2504.20349",
        "arxiv-2507.06345",
        "arxiv-2605.19584",
    }.issubset(source_ids)
    assert fragile["microstructure_stress"]["promotion_authority"] is False
    assert fragile["microstructure_stress"]["proof_authority"] is False


def test_lob_reality_gap_summary_fails_closed_without_signal_rows() -> None:
    summary = ranker._lob_reality_gap_stress_summary(
        [{"symbol": "NVDA", "executed_at": "bad-date"}]
    )

    assert summary["row_count"] == 0
    assert summary["promotion_authority"] is False
    assert summary["effective_replay_rank_penalty_bps"] == Decimal("2")
    assert summary["lob_reality_gap_blockers"] == (
        "lob_reality_gap_missing_lob_reality_gap_rows",
    )


def test_microstructure_stress_summary_fails_closed_without_signal_rows() -> None:
    summary = ranker._microstructure_stress_summary(
        [{"symbol": "NVDA", "executed_at": "bad-date"}]
    )

    assert summary["source_papers"] == []
    assert summary["stress_components"] == {
        "adaptive_market_limit_allocation": {},
        "order_book_observability": {},
        "cluster_lob": {},
    }
    assert summary["adaptive_market_limit_penalty_bps"] == Decimal("0")
    assert summary["order_book_observability_penalty_bps"] == Decimal("0")
    assert summary["cluster_lob_warning_penalty_bps"] == Decimal("0")
    assert summary["microstructure_warning_penalty_bps"] == Decimal("1.5")
    assert summary["effective_replay_rank_penalty_bps"] == Decimal("1.5")
    assert summary["microstructure_stress_blockers"] == (
        "microstructure_stress_missing_microstructure_signal_rows",
    )
    assert summary["promotion_authority"] is False
    assert summary["proof_authority"] is False


def test_microstructure_helpers_cover_nested_penalties_and_source_dedupe() -> None:
    assert ranker._stress_penalty_bps(
        {"ranking_features": {"replay_rank_penalty_bps": "-7"}}
    ) == Decimal("0")
    assert ranker._stress_penalty_bps(
        {"ranking_features": {"replay_rank_penalty_bps": "12.5"}}
    ) == Decimal("12.5")

    papers = ranker._dedupe_source_papers(
        (
            "not-a-paper-list",
            [{"source_id": ""}, "not-a-paper", {"source_id": "paper-a"}],
            [{"source_id": "paper-a"}, {"source_id": "paper-b"}],
        )
    )

    assert [paper["source_id"] for paper in papers] == ["paper-a", "paper-b"]


def test_lob_signal_rows_use_fallback_timestamps_and_ingest_fields() -> None:
    signals = ranker._lob_signal_rows(
        [
            {
                "symbol": "NVDA",
                "submitted_at": "2026-05-18T14:31:00Z",
                "ingested_at": "2026-05-18T14:31:01Z",
                "source": "historical_lob_replay",
                "timeframe": "1m",
            },
            {
                "symbol": "",
                "executed_at": "2026-05-18T14:32:00Z",
            },
        ]
    )

    assert len(signals) == 1
    assert signals[0].event_ts == datetime(2026, 5, 18, 14, 31, tzinfo=timezone.utc)
    assert signals[0].ingest_ts == datetime(2026, 5, 18, 14, 31, 1, tzinfo=timezone.utc)
    assert signals[0].source == "historical_lob_replay"
    assert signals[0].timeframe == "1m"


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
