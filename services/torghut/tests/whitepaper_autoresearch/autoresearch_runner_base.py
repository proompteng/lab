from __future__ import annotations

# ruff: noqa: F401,F403,F405
from tests.whitepaper_autoresearch.autoresearch_runner_support import *


class WhitepaperAutoresearchRunnerTestCaseBase(TestCase):
    def setUp(self) -> None:
        self.engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
        Base.metadata.create_all(self.engine)

    def tearDown(self) -> None:
        self.engine.dispose()

    def _args(self, output_dir: Path) -> Namespace:
        return Namespace(
            output_dir=output_dir,
            epoch_id="",
            paper_run_id=[],
            source_jsonl=[],
            feedback_evidence_jsonl=[],
            candidate_specs=[],
            seed_recent_whitepapers=True,
            target_net_pnl_per_day="500",
            max_candidates=8,
            top_k=4,
            exploration_slots=2,
            feedback_block_reaudit_slots=0,
            selection_only=False,
            portfolio_size_min=2,
            portfolio_size_max=4,
            replay_mode="synthetic",
            program=Path(
                "config/trading/research-programs/portfolio-profit-autoresearch-500-v1.yaml"
            ),
            strategy_configmap=Path(
                "argocd/applications/torghut/strategy-configmap.yaml"
            ),
            family_template_dir=Path("config/trading/families"),
            seed_sweep_dir=Path("config/trading"),
            clickhouse_http_url="http://example.invalid:8123",
            clickhouse_username="torghut",
            clickhouse_password="secret",
            start_equity="31590.02",
            chunk_minutes=10,
            symbols=",".join(_CHIP_UNIVERSE),
            progress_log_seconds=30,
            max_frontier_candidates_per_spec=runner._DEFAULT_MAX_FRONTIER_CANDIDATES_PER_SPEC,
            max_total_frontier_candidates=0,
            staged_train_screen_multiplier=0,
            capture_rejected_seed_full_window_ledger=False,
            capture_positive_rejected_full_window_ledgers=0,
            symbol_prune_iterations=0,
            symbol_prune_candidates=0,
            symbol_prune_min_universe_size=0,
            loss_repair_iterations=0,
            loss_repair_candidates=0,
            consistency_repair_iterations=0,
            consistency_repair_candidates=0,
            real_replay_timeout_seconds=0,
            real_replay_shard_size=0,
            real_replay_shard_timeout_seconds=runner._DEFAULT_REAL_REPLAY_SHARD_TIMEOUT_SECONDS,
            real_replay_shard_workers=runner._DEFAULT_REAL_REPLAY_SHARD_WORKERS,
            real_replay_max_parallel_frontier_candidates=runner._DEFAULT_REAL_REPLAY_MAX_PARALLEL_FRONTIER_CANDIDATES,
            real_replay_failed_spec_retries=1,
            real_replay_retry_timeout_seconds=0,
            real_replay_retry_max_frontier_candidates_per_spec=1,
            train_days=6,
            holdout_days=3,
            full_window_start_date="2026-02-23",
            full_window_end_date="2026-02-27",
            expected_last_trading_day="",
            allow_stale_tape=False,
            prefetch_full_window_rows=False,
            replay_tape_path=None,
            replay_tape_manifest=None,
            replay_tape_preview_top_k=0,
            replay_tape_preview_min_rows=2,
            replay_tape_exact_candidate_cap=runner._DEFAULT_FAST_REPLAY_EXACT_CANDIDATE_CAP,
            replay_tape_frontier_exploitation_slots=runner._DEFAULT_FAST_REPLAY_EXPLOITATION_SLOTS,
            replay_tape_frontier_exploration_slots=runner._DEFAULT_FAST_REPLAY_EXPLORATION_SLOTS,
            materialize_replay_tape=False,
            coverage_diagnostic_output=None,
            latest_complete_window_min_days=0,
            latest_complete_window_receipt_output=None,
            min_executable_rows_per_symbol_day=1,
            min_quote_valid_ratio="0",
            max_coverage_spread_bps="1000000000",
            max_executable_gap_seconds=999999,
            min_daily_net_pnl=None,
            persist_results=False,
        )

    def _source_jsonl_args(
        self,
        output_dir: Path,
        *,
        source_count: int = 1,
    ) -> Namespace:
        source_path = output_dir.parent / "source.jsonl"
        rows: list[str] = []
        for index in range(source_count):
            source_payload = _source_jsonl_payload()
            source_payload["run_id"] = f"paper-jsonl-{index}"
            rows.append(json.dumps(source_payload))
        source_path.write_text("\n".join(rows) + "\n", encoding="utf-8")
        args = self._args(output_dir)
        args.seed_recent_whitepapers = False
        args.source_jsonl = [source_path]
        return args

    def _coverage_row(
        self,
        *,
        raw: int,
        executable: int,
        microbar: int,
        symbol_count: int = 2,
    ) -> dict[str, object]:
        return {
            "raw_signal_rows": raw,
            "executable_signal_rows": executable,
            "quote_sane_signal_rows": executable,
            "spread_sane_signal_rows": executable,
            "microbar_rows": microbar,
            "raw_signal_symbol_count": symbol_count,
            "executable_signal_symbol_count": symbol_count,
            "microbar_symbol_count": symbol_count,
            "min_executable_rows_per_symbol_day": executable,
            "min_spread_sane_rows_per_symbol_day": executable,
            "quote_valid_ratio": "1",
            "min_quote_valid_ratio_by_symbol_day": "1",
            "max_executable_gap_seconds": 0,
        }

    def _candidate_spec(
        self,
        candidate_spec_id: str,
        *,
        family_template_id: str = "microbar_cross_sectional_pairs_v1",
        entry_minute_after_open: str = "45",
        selection_mode: str = "reversal",
    ) -> runner.CandidateSpec:
        return runner.CandidateSpec(
            schema_version="torghut.candidate-spec.v1",
            candidate_spec_id=candidate_spec_id,
            hypothesis_id=f"hyp-{candidate_spec_id}",
            family_template_id=family_template_id,
            candidate_kind="sleeve",
            runtime_family=family_template_id.replace("_v1", ""),
            runtime_strategy_name=f"{family_template_id}-runtime",
            feature_contract={
                "mechanism": "deterministic test spec",
                "required_features": ("spread_bps", "depth_proxy"),
                "source_run_id": f"source-{candidate_spec_id}",
                "family_selection": {"rank": 1},
            },
            parameter_space={},
            strategy_overrides={
                "max_notional_per_trade": "7500",
                "max_position_pct_equity": "0.25",
                "params": {
                    "entry_minute_after_open": entry_minute_after_open,
                    "exit_minute_after_open": "150",
                    "max_hold_seconds": "5400",
                    "entry_cooldown_seconds": "1200",
                    "long_stop_loss_bps": "8",
                    "long_trailing_stop_activation_profit_bps": "6",
                    "long_trailing_stop_drawdown_bps": "3",
                    "selection_mode": selection_mode,
                    "signal_motif": "open_window_reversal",
                    "rank_feature": "cross_section_session_open_rank",
                    "top_n": "2",
                },
                "universe_symbols": ["NVDA", "AAPL", "INTC"],
            },
            objective={"target_net_pnl_per_day": "500"},
            hard_vetoes={},
            expected_failure_modes=(),
            promotion_contract={},
        )


__all__ = [name for name in globals() if not name.startswith("__")]
