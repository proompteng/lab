from __future__ import annotations

import app.trading.discovery.evidence_bundles as evidence_bundles
import app.trading.discovery.replay_tape as replay_tape
from app.trading.discovery.candidate_specs import CandidateSpec
from app.trading.discovery.fast_replay.extract_price import (
    extract_microprice_bias_bps,
    extract_ofi_pressure,
    extract_price,
    extract_quote_depth_imbalance,
    extract_spread_bps,
    extract_volume,
    float_or_none,
    mapping,
)
from app.trading.discovery.fast_replay.frontier_selection_blockers_for_row import (
    candidate_direction,
    candidate_symbols,
)
import scripts.local_intraday_tsmom_replay as replay_mod
import scripts.materialize_replay_tape as replay_materializer
import scripts.whitepaper_autoresearch_runner.artifact_io as artifact_io
import scripts.whitepaper_autoresearch_runner.queue_metadata as queue_metadata

from tests.whitepaper_autoresearch.autoresearch_runner_base import (
    Decimal,
    Namespace,
    Path,
    Sequence,
    SignalEnvelope,
    TemporaryDirectory,
    WhitepaperAutoresearchRunnerTestCaseBase,
    date,
    datetime,
    json,
    materialize_signal_tape,
    patch,
    replace,
    runner,
    timezone,
)
import scripts.whitepaper_autoresearch_runner.preview_narrowing as preview_narrowing
import scripts.whitepaper_autoresearch_runner.replay_models as replay_models


class TestAutoresearchRunnerMaterializedReplay(
    WhitepaperAutoresearchRunnerTestCaseBase
):
    def test_materialize_replay_tape_writes_run_artifacts_and_updates_args(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            output_dir = root / "epoch"
            output_dir.mkdir()
            strategy_configmap = root / "strategy-configmap.yaml"
            strategy_configmap.write_text("{}", encoding="utf-8")
            args = self._args(output_dir)
            args.strategy_configmap = strategy_configmap
            args.replay_mode = "real"
            args.materialize_replay_tape = True
            args.symbols = "NVDA"
            rows = [
                SignalEnvelope(
                    event_ts=datetime(2026, 2, day, 15, 30, tzinfo=timezone.utc),
                    symbol="NVDA",
                    timeframe="1Sec",
                    seq=seq,
                    source="ta",
                    payload={"price": Decimal("100"), "spread": Decimal("0.01")},
                )
                for seq, day in enumerate(range(23, 28), start=1)
            ]

            with patch.object(replay_mod, "_iter_signal_rows", return_value=rows):
                updated_args, receipt = (
                    queue_metadata._maybe_materialize_epoch_replay_tape(
                        args=args,
                        output_dir=output_dir,
                        epoch_id="epoch-materialized",
                    )
                )
            tape = replay_tape.load_replay_tape(updated_args.replay_tape_path)
            self.assertIsNotNone(receipt)
            assert receipt is not None
            self.assertEqual(
                updated_args.replay_tape_path, output_dir / "replay-tape.jsonl"
            )
            self.assertEqual(
                updated_args.replay_tape_manifest,
                output_dir / "replay-tape.jsonl.manifest.json",
            )
            self.assertEqual(receipt["status"], "materialized")
            self.assertEqual(receipt["row_count"], 5)
            self.assertEqual(receipt["row_symbols"], ["NVDA"])
            self.assertTrue((output_dir / "replay-tape-receipt.json").exists())
            self.assertEqual(tape.manifest.dataset_snapshot_ref, "epoch-materialized")
            self.assertEqual(tape.manifest.row_count, 5)
            self.assertEqual(tape.manifest.missing_trading_days, ())

    def test_materialize_replay_tape_fails_closed_on_missing_days(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            output_dir = root / "epoch"
            output_dir.mkdir()
            strategy_configmap = root / "strategy-configmap.yaml"
            strategy_configmap.write_text("{}", encoding="utf-8")
            args = self._args(output_dir)
            args.strategy_configmap = strategy_configmap
            args.replay_mode = "real"
            args.materialize_replay_tape = True
            args.symbols = "NVDA"
            rows = [
                SignalEnvelope(
                    event_ts=datetime(2026, 2, 23, 15, 30, tzinfo=timezone.utc),
                    symbol="NVDA",
                    timeframe="1Sec",
                    seq=1,
                    source="ta",
                    payload={"price": Decimal("100"), "spread": Decimal("0.01")},
                )
            ]

            with patch.object(replay_mod, "_iter_signal_rows", return_value=rows):
                with self.assertRaisesRegex(
                    ValueError,
                    "replay_tape_incomplete_coverage:missing_days=2026-02-24,2026-02-25,2026-02-26,2026-02-27",
                ):
                    queue_metadata._maybe_materialize_epoch_replay_tape(
                        args=args,
                        output_dir=output_dir,
                        epoch_id="epoch-materialized",
                    )

            self.assertFalse((output_dir / "replay-tape.jsonl").exists())
            self.assertFalse((output_dir / "replay-tape.jsonl.manifest.json").exists())

    def test_materialize_replay_tape_skips_provided_tape_and_fails_closed(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            output_dir = root / "epoch"
            output_dir.mkdir()
            args = self._args(output_dir)
            args.materialize_replay_tape = True
            args.replay_tape_path = root / "provided-tape.jsonl"

            updated_args, receipt = queue_metadata._maybe_materialize_epoch_replay_tape(
                args=args,
                output_dir=output_dir,
                epoch_id="epoch-skip",
            )

            self.assertIs(updated_args, args)
            self.assertIsNone(receipt)

            args.replay_tape_path = None
            args.replay_mode = "synthetic"
            with self.assertRaisesRegex(
                ValueError, "replay_tape_materialization_requires_real_replay"
            ):
                queue_metadata._maybe_materialize_epoch_replay_tape(
                    args=args,
                    output_dir=output_dir,
                    epoch_id="epoch-synthetic",
                )

            args.replay_mode = "real"
            args.selection_only = True
            with self.assertRaisesRegex(
                ValueError, "replay_tape_materialization_requires_replay_execution"
            ):
                queue_metadata._maybe_materialize_epoch_replay_tape(
                    args=args,
                    output_dir=output_dir,
                    epoch_id="epoch-selection-only",
                )

            args.selection_only = False
            args.full_window_start_date = ""
            with self.assertRaisesRegex(
                ValueError,
                "replay_tape_materialization_requires_full_window_start_date",
            ):
                queue_metadata._maybe_materialize_epoch_replay_tape(
                    args=args,
                    output_dir=output_dir,
                    epoch_id="epoch-missing-window",
                )

    def test_materialized_replay_tape_window_preflight_updates_args(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            output_dir = root / "epoch"
            output_dir.mkdir()
            args = self._args(output_dir)
            args.replay_mode = "real"
            args.materialize_replay_tape = True
            args.symbols = "NVDA,AAPL"
            args.full_window_start_date = "2026-02-23"
            args.full_window_end_date = "2026-02-27"
            args.latest_complete_window_min_days = 3
            coverage = {
                "schema_version": "torghut.replay-coverage-diagnostic.v1",
                "requested_trading_days": [
                    "2026-02-23",
                    "2026-02-24",
                    "2026-02-25",
                    "2026-02-26",
                    "2026-02-27",
                ],
                "rows_by_trading_day": {
                    "2026-02-23": self._coverage_row(
                        raw=10,
                        executable=0,
                        microbar=10,
                    ),
                    "2026-02-24": self._coverage_row(
                        raw=10,
                        executable=3,
                        microbar=10,
                    ),
                    "2026-02-25": self._coverage_row(
                        raw=10,
                        executable=3,
                        microbar=10,
                    ),
                    "2026-02-26": self._coverage_row(
                        raw=10,
                        executable=3,
                        microbar=10,
                    ),
                    "2026-02-27": self._coverage_row(
                        raw=10,
                        executable=3,
                        microbar=10,
                    ),
                },
                "missing_executable_signal_days": ["2026-02-23"],
            }

            with patch.object(
                replay_materializer,
                "_fetch_coverage_diagnostics",
                return_value=coverage,
            ) as fetch:
                updated_args, receipt = (
                    queue_metadata._maybe_preflight_materialized_replay_tape_window(
                        args=args,
                        output_dir=output_dir,
                    )
                )

            self.assertEqual(fetch.call_count, 1)
            self.assertIsNotNone(receipt)
            assert receipt is not None
            self.assertEqual(updated_args.full_window_start_date, "2026-02-24")
            self.assertEqual(updated_args.full_window_end_date, "2026-02-27")
            self.assertEqual(updated_args.expected_last_trading_day, "2026-02-27")
            self.assertEqual(
                receipt["selected_trading_days"],
                ["2026-02-24", "2026-02-25", "2026-02-26", "2026-02-27"],
            )
            self.assertTrue(
                (output_dir / "replay-source-latest-complete-window.json").exists()
            )

    def test_replay_tape_preview_error_paths_and_fallback_selection(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            output_dir = root / "epoch"
            tape_path = root / "preview-tape.jsonl"
            args = self._args(output_dir)
            args.replay_tape_preview_top_k = 1
            args.full_window_start_date = "2026-02-23"
            args.full_window_end_date = "2026-02-27"
            args.symbols = "NVDA"
            args.replay_tape_dataset_snapshot_ref = "preview-snapshot"
            requested_symbols = artifact_io._candidate_universe_symbols_from_args(args)
            materialize_signal_tape(
                rows=[
                    SignalEnvelope(
                        event_ts=datetime(2026, 2, day, 15, 30, tzinfo=timezone.utc),
                        symbol="NVDA",
                        timeframe="1Sec",
                        seq=seq,
                        source="ta",
                        payload={"price": Decimal("100")},
                    )
                    for seq, day in enumerate(range(23, 28), start=1)
                ],
                tape_path=tape_path,
                dataset_snapshot_ref="preview-snapshot",
                symbols=requested_symbols,
                start_date=date(2026, 2, 23),
                end_date=date(2026, 2, 27),
                source_query_digest=queue_metadata._materialized_replay_tape_source_query_digest(
                    args=args,
                    symbols=requested_symbols,
                    start_date=date(2026, 2, 23),
                    end_date=date(2026, 2, 27),
                ),
                feature_schema_hash=queue_metadata._materialized_replay_tape_feature_schema_hash(
                    args
                ),
                cost_model_hash=queue_metadata._materialized_replay_tape_cost_model_hash(
                    args
                ),
                strategy_family=queue_metadata._materialized_replay_tape_strategy_family(
                    args
                ),
            )
            spec = self._candidate_spec("spec-preview-fallback")
            selection = {
                "selected_candidate_spec_ids": [spec.candidate_spec_id],
                "rows": [
                    {
                        "candidate_spec_id": spec.candidate_spec_id,
                        "selected_for_replay": True,
                    }
                ],
                "budget": {"selected_count": 1},
            }
            with self.assertRaisesRegex(
                ValueError, "fast_replay_preview_requires_real_replay"
            ):
                preview_narrowing._apply_fast_replay_preview_narrowing(
                    args=args,
                    output_dir=output_dir,
                    specs=[spec],
                    candidate_selection=selection,
                )
            args.replay_mode = "real"
            args.replay_tape_path = None
            with self.assertRaisesRegex(
                ValueError, "fast_replay_preview_requires_replay_tape_path"
            ):
                preview_narrowing._apply_fast_replay_preview_narrowing(
                    args=args,
                    output_dir=output_dir,
                    specs=[spec],
                    candidate_selection=selection,
                )
            args.replay_tape_path = tape_path
            args.full_window_start_date = ""
            with self.assertRaisesRegex(
                ValueError, "fast_replay_preview_requires_full_window_start_date"
            ):
                preview_narrowing._apply_fast_replay_preview_narrowing(
                    args=args,
                    output_dir=output_dir,
                    specs=[spec],
                    candidate_selection=selection,
                )

            class UnknownPreview:
                selected_candidate_spec_ids = ("missing-spec",)
                rows = ()

                def to_manifest_payload(self) -> dict[str, object]:
                    return {
                        "schema_version": "torghut.fast-replay-preview.v1",
                        "promotion_proof": False,
                    }

            args.full_window_start_date = "2026-02-23"
            args.symbols = "NVDA"
            with patch.object(
                preview_narrowing,
                "build_fast_replay_preview",
                return_value=UnknownPreview(),
            ):
                narrowed, updated = (
                    preview_narrowing._apply_fast_replay_preview_narrowing(
                        args=args,
                        output_dir=output_dir,
                        specs=[spec],
                        candidate_selection=selection,
                    )
                )

        self.assertEqual(
            [item.candidate_spec_id for item in narrowed], [spec.candidate_spec_id]
        )
        self.assertEqual(
            updated["selected_candidate_spec_ids"], [spec.candidate_spec_id]
        )

    def test_fast_replay_preview_covers_signal_field_fallbacks(self) -> None:
        no_universe_spec = replace(
            self._candidate_spec("spec-no-universe"),
            runtime_strategy_name="NVDA",
            strategy_overrides={
                "params": {
                    "selection_mode": "continuation",
                    "signal_motif": "opening_continuation",
                }
            },
        )
        self.assertEqual(candidate_symbols(no_universe_spec), ("NVDA",))
        self.assertEqual(candidate_direction(no_universe_spec), 1.0)
        self.assertEqual(
            extract_price(
                SignalEnvelope(
                    event_ts=datetime(2026, 2, 23, 15, 30, tzinfo=timezone.utc),
                    symbol="NVDA",
                    payload={"bid": Decimal("100"), "ask": Decimal("102")},
                )
            ),
            101.0,
        )
        self.assertIsNone(
            extract_price(
                SignalEnvelope(
                    event_ts=datetime(2026, 2, 23, 15, 30, tzinfo=timezone.utc),
                    symbol="NVDA",
                    payload={},
                )
            )
        )
        bid_ask_spread = extract_spread_bps(
            SignalEnvelope(
                event_ts=datetime(2026, 2, 23, 15, 30, tzinfo=timezone.utc),
                symbol="NVDA",
                payload={"bid": Decimal("100"), "ask": Decimal("101")},
            )
        )
        self.assertAlmostEqual(bid_ask_spread or 0.0, 99.50248756218905)
        self.assertEqual(
            extract_spread_bps(
                SignalEnvelope(
                    event_ts=datetime(2026, 2, 23, 15, 30, tzinfo=timezone.utc),
                    symbol="NVDA",
                    payload={"price": Decimal("100"), "spread": Decimal("0.05")},
                )
            ),
            5.0,
        )
        self.assertAlmostEqual(
            extract_quote_depth_imbalance(
                SignalEnvelope(
                    event_ts=datetime(2026, 2, 23, 15, 30, tzinfo=timezone.utc),
                    symbol="NVDA",
                    payload={
                        "bid_size": Decimal("200"),
                        "ask_size": Decimal("100"),
                    },
                )
            )
            or 0.0,
            1.0 / 3.0,
        )
        self.assertAlmostEqual(
            extract_ofi_pressure(
                SignalEnvelope(
                    event_ts=datetime(2026, 2, 23, 15, 30, tzinfo=timezone.utc),
                    symbol="NVDA",
                    payload={"order_flow_imbalance": Decimal("50")},
                )
            )
            or 0.0,
            0.46211715726000974,
        )
        self.assertGreater(
            extract_microprice_bias_bps(
                SignalEnvelope(
                    event_ts=datetime(2026, 2, 23, 15, 30, tzinfo=timezone.utc),
                    symbol="NVDA",
                    payload={
                        "bid": Decimal("100"),
                        "ask": Decimal("101"),
                        "bid_size": Decimal("200"),
                        "ask_size": Decimal("100"),
                    },
                )
            )
            or 0.0,
            0.0,
        )
        self.assertEqual(
            extract_volume(
                SignalEnvelope(
                    event_ts=datetime(2026, 2, 23, 15, 30, tzinfo=timezone.utc),
                    symbol="NVDA",
                    payload={"microbar_volume": Decimal("12345")},
                )
            ),
            12345.0,
        )
        self.assertIsNone(
            extract_spread_bps(
                SignalEnvelope(
                    event_ts=datetime(2026, 2, 23, 15, 30, tzinfo=timezone.utc),
                    symbol="NVDA",
                    payload={},
                )
            )
        )
        self.assertIsNone(float_or_none("not-a-number"))
        self.assertIsNone(float_or_none(float("nan")))
        self.assertEqual(mapping("not-a-mapping"), {})

    def test_candidate_specs_replay_skips_compiler_and_replays_selected_specs(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "epoch"
            selected_specs_path = Path(tmpdir) / "selected-candidate-specs.jsonl"
            direct_a_base = self._candidate_spec("spec-direct-a")
            direct_a_spec = replace(
                direct_a_base,
                feature_contract={
                    **direct_a_base.feature_contract,
                    "source_claims": [
                        {
                            "claim_id": "direct-route-tca-required",
                            "claim_type": "execution_assumption",
                            "data_requirements": ["route_tca"],
                        }
                    ],
                },
                parameter_space={
                    "mechanism_overlay_ids": ["queue_position_survival_fill_curve"]
                },
                promotion_contract={
                    "requires_route_tca": True,
                    "requires_runtime_ledger": True,
                },
            )
            specs = (
                direct_a_spec,
                self._candidate_spec(
                    "spec-direct-b",
                    family_template_id="momentum_pullback_v1",
                    selection_mode="pullback",
                ),
            )
            selected_specs_path.write_text(
                "\n".join(
                    json.dumps(spec.to_payload(), sort_keys=True) for spec in specs
                )
                + "\n",
                encoding="utf-8",
            )
            captured_spec_ids: list[str] = []

            def fake_replay(
                *,
                args: Namespace,
                output_dir: Path,
                specs: Sequence[CandidateSpec],
            ) -> replay_models.EpochReplayResult:
                del args
                captured_spec_ids.extend(spec.candidate_spec_id for spec in specs)
                bundle = evidence_bundles.evidence_bundle_from_frontier_candidate(
                    candidate_spec_id=specs[0].candidate_spec_id,
                    candidate={
                        "candidate_id": "cand-direct-a",
                        "objective_scorecard": {
                            "net_pnl_per_day": "25",
                            "active_day_ratio": "1",
                            "positive_day_ratio": "1",
                            "exact_replay_ledger_artifact_ref": "direct-exact-ledger.json",
                            "exact_replay_ledger_artifact_row_count": 12,
                            "exact_replay_ledger_artifact_fill_count": 4,
                            "runtime_window_start": "2026-05-18T13:30:00+00:00",
                            "runtime_window_end": "2026-05-18T20:00:00+00:00",
                        },
                    },
                    dataset_snapshot_id="snap-direct",
                    result_path=str(output_dir / "direct-a.json"),
                )
                return replay_models.EpochReplayResult(
                    evidence_bundles=(bundle,),
                    replay_results=({"status": "ok"},),
                )

            args = self._args(output_dir)
            args.seed_recent_whitepapers = False
            args.candidate_specs = [selected_specs_path]
            args.replay_mode = "real"
            args.portfolio_size_min = 1

            with (
                patch.object(
                    runner,
                    "compile_sources_to_hypothesis_cards",
                    side_effect=AssertionError("source compiler must not run"),
                ) as source_compiler_mock,
                patch.object(
                    runner,
                    "compile_whitepaper_candidate_specs",
                    side_effect=AssertionError("candidate compiler must not run"),
                ) as candidate_compiler_mock,
                patch.object(
                    runner,
                    "_select_candidate_specs_for_replay",
                    side_effect=AssertionError("selection must not run"),
                ) as selection_mock,
                patch.object(
                    runner,
                    "_run_replay_with_optional_timeout",
                    side_effect=fake_replay,
                ) as replay_mock,
            ):
                payload = runner.run_whitepaper_autoresearch_profit_target(args)

            selection = json.loads(
                (output_dir / "candidate-selection-manifest.json").read_text(
                    encoding="utf-8"
                )
            )
            selected_candidate_specs = [
                json.loads(line)
                for line in (output_dir / "selected-candidate-specs.jsonl")
                .read_text(encoding="utf-8")
                .splitlines()
                if line
            ]
            compiler_report = json.loads(
                (output_dir / "candidate-compiler-report.json").read_text(
                    encoding="utf-8"
                )
            )
            profitability_goal = json.loads(
                (output_dir / "profitability-search-goal.json").read_text(
                    encoding="utf-8"
                )
            )

        self.assertEqual(captured_spec_ids, ["spec-direct-a", "spec-direct-b"])
        self.assertEqual(payload["candidate_spec_count"], 2)
        self.assertEqual(payload["replay_candidate_spec_count"], 2)
        self.assertEqual(
            payload["selected_candidate_spec_ids"], ["spec-direct-a", "spec-direct-b"]
        )
        self.assertEqual(selection["selection_mode"], "direct_candidate_specs_handoff")
        self.assertEqual(
            selection["selected_candidate_spec_ids"],
            ["spec-direct-a", "spec-direct-b"],
        )
        direct_selection_row = next(
            row
            for row in selection["rows"]
            if row["candidate_spec_id"] == "spec-direct-a"
        )
        self.assertGreater(
            Decimal(str(direct_selection_row["paper_contract_prior_score"])),
            Decimal("0"),
        )
        self.assertEqual(
            direct_selection_row["paper_mechanism_overlay_ids"],
            ["queue_position_survival_fill_curve"],
        )
        self.assertIn(
            "runtime_ledger", direct_selection_row["paper_required_evidence_tokens"]
        )
        self.assertEqual(
            [spec["candidate_spec_id"] for spec in selected_candidate_specs],
            ["spec-direct-a", "spec-direct-b"],
        )
        self.assertEqual(
            compiler_report["status"], "loaded_candidate_specs_for_direct_replay"
        )
        self.assertEqual(
            profitability_goal["recommended_next_epoch"][
                "direct_candidate_specs_artifacts"
            ],
            [str(selected_specs_path)],
        )
        self.assertIn(
            "--candidate-specs",
            profitability_goal["recommended_next_epoch"]["argv"],
        )
        self.assertIn(
            str(selected_specs_path),
            profitability_goal["recommended_next_epoch"]["argv"],
        )
        direct_sleeve_row = next(
            row
            for row in profitability_goal["sleeve_plan"]["rows"]
            if row["candidate_spec_id"] == "spec-direct-a"
        )
        self.assertEqual(
            direct_sleeve_row["replay_selection_reason"],
            "direct_candidate_specs_handoff",
        )
        self.assertTrue(direct_sleeve_row["paper_contract_candidate"])
        self.assertTrue(direct_sleeve_row["paper_contract_selected_for_replay"])
        self.assertEqual(
            direct_sleeve_row["paper_mechanism_overlay_ids"],
            ["queue_position_survival_fill_curve"],
        )
        self.assertIn(
            "runtime_ledger", direct_sleeve_row["paper_required_evidence_tokens"]
        )
        self.assertEqual(
            direct_sleeve_row["exact_replay_ledger_artifact_refs"],
            ["direct-exact-ledger.json"],
        )
        self.assertNotIn("runtime_ledger_artifact_refs", direct_sleeve_row)
        self.assertNotIn("runtime_ledger_artifact_ref", direct_sleeve_row)
        self.assertEqual(
            direct_sleeve_row["exact_replay_ledger_artifact_row_count"], 12
        )
        self.assertEqual(
            direct_sleeve_row["exact_replay_ledger_artifact_fill_count"], 4
        )
        source_compiler_mock.assert_not_called()
        candidate_compiler_mock.assert_not_called()
        selection_mock.assert_not_called()
        replay_mock.assert_called_once()

    def test_candidate_specs_replay_rejects_duplicate_spec_ids(self) -> None:
        with TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "epoch"
            selected_specs_path = Path(tmpdir) / "selected-candidate-specs.jsonl"
            spec = self._candidate_spec("spec-direct-duplicate")
            selected_specs_path.write_text(
                "\n".join(
                    json.dumps(spec.to_payload(), sort_keys=True) for _ in range(2)
                )
                + "\n",
                encoding="utf-8",
            )
            args = self._args(output_dir)
            args.seed_recent_whitepapers = False
            args.candidate_specs = [selected_specs_path]
            args.replay_mode = "real"

            with patch.object(
                runner,
                "_run_replay_with_optional_timeout",
                side_effect=AssertionError("invalid input must not run replay"),
            ) as replay_mock:
                payload = runner.run_whitepaper_autoresearch_profit_target(args)

        self.assertEqual(payload["status"], "invalid_candidate_specs")
        self.assertIn(
            "candidate_specs_jsonl_duplicate_candidate_spec_id",
            payload["failure_reason"],
        )
        replay_mock.assert_not_called()

    def test_main_treats_selection_only_as_success(self) -> None:
        with (
            patch.object(runner, "_parse_args", return_value=Namespace()),
            patch.object(
                runner,
                "run_whitepaper_autoresearch_profit_target",
                return_value={"status": "selection_only"},
            ),
            patch("builtins.print"),
        ):
            exit_code = runner.main()

        self.assertEqual(exit_code, 0)
