from __future__ import annotations

from tests.runtime_window_import.runtime_window_import_base import (
    Decimal,
    POST_COST_BASIS_RUNTIME_LEDGER,
    RuntimeWindowImportTestCaseBase,
    SimpleNamespace,
    _FakeSession,
    _complete_runtime_ledger_bucket,
    _parse_args,
    _persistence_session,
    _runtime_ledger_bucket_profit_proof_blockers,
    _runtime_ledger_bucket_profit_proof_present,
    _runtime_ledger_profit_proof_present,
    _runtime_observation_authority_payload,
    _source_row_matches_lineage,
    _sqlalchemy_dsn,
    _target_persistence_dsn,
    _with_runtime_ledger_source_authority_context,
    datetime,
    patch,
    timezone,
)


class TestRuntimeWindowImportConfig(RuntimeWindowImportTestCaseBase):
    def test_sqlalchemy_dsn_normalizes_postgres_urls(self) -> None:
        self.assertEqual(
            _sqlalchemy_dsn("postgresql://user:pass@postgres:5432/torghut_sim_default"),
            "postgresql+psycopg://user:pass@postgres:5432/torghut_sim_default",
        )
        self.assertEqual(
            _sqlalchemy_dsn("postgres://user:pass@postgres:5432/torghut"),
            "postgresql+psycopg://user:pass@postgres:5432/torghut",
        )

    def test_target_persistence_dsn_requires_configured_env(self) -> None:
        args = SimpleNamespace(target_dsn="", target_dsn_env="SIM_DB_DSN")

        with patch.dict("os.environ", {}, clear=True):
            with self.assertRaisesRegex(
                RuntimeError, "target_dsn_not_configured:SIM_DB_DSN"
            ):
                _target_persistence_dsn(args)

    def test_persistence_session_uses_target_dsn_env(self) -> None:
        class _FakeEngine:
            def __init__(self) -> None:
                self.disposed = False

            def dispose(self) -> None:
                self.disposed = True

        fake_engine = _FakeEngine()
        fake_session = _FakeSession()
        sessionmaker_calls: list[dict[str, object]] = []

        def fake_sessionmaker(**kwargs: object):
            sessionmaker_calls.append(dict(kwargs))

            def factory() -> _FakeSession:
                return fake_session

            return factory

        args = SimpleNamespace(target_dsn="", target_dsn_env="SIM_DB_DSN")

        with (
            patch.dict(
                "os.environ",
                {
                    "SIM_DB_DSN": "postgresql://user:pass@postgres:5432/torghut_sim_default"
                },
                clear=True,
            ),
            patch(
                "scripts.import_hypothesis_runtime_windows.create_engine",
                return_value=fake_engine,
            ) as create_engine_mock,
            patch(
                "scripts.import_hypothesis_runtime_windows.sessionmaker",
                side_effect=fake_sessionmaker,
            ),
        ):
            with _persistence_session(args) as session:
                self.assertIs(session, fake_session)

        create_engine_mock.assert_called_once_with(
            "postgresql+psycopg://user:pass@postgres:5432/torghut_sim_default",
            pool_pre_ping=True,
            future=True,
        )
        self.assertEqual(sessionmaker_calls[0]["bind"], fake_engine)
        self.assertTrue(fake_engine.disposed)

    def test_runtime_observation_authority_requires_runtime_ledger_profit_proof(
        self,
    ) -> None:
        payload = _runtime_observation_authority_payload(
            source_kind="live_runtime_observed",
            tca_rows=[
                {
                    "computed_at": datetime(2026, 3, 6, 14, 36, tzinfo=timezone.utc),
                    "abs_slippage_bps": Decimal("4"),
                    "post_cost_expectancy_bps": Decimal("12"),
                    "post_cost_expectancy_basis": "broker_tca_shortfall_estimate",
                    "post_cost_promotion_eligible": False,
                }
            ],
        )

        self.assertEqual(payload["authoritative"], False)
        self.assertEqual(
            payload["authority_reason"],
            "runtime_without_runtime_ledger_profit_proof",
        )
        self.assertEqual(payload["promotion_authority"], "blocked")
        self.assertEqual(payload["runtime_ledger_profit_proof_present"], False)

    def test_runtime_observation_authority_accepts_runtime_ledger_profit_proof(
        self,
    ) -> None:
        payload = _runtime_observation_authority_payload(
            source_kind="live_runtime_observed",
            tca_rows=[
                {
                    "computed_at": datetime(2026, 3, 6, 14, 36, tzinfo=timezone.utc),
                    "post_cost_expectancy_bps": Decimal("40"),
                    "post_cost_expectancy_basis": POST_COST_BASIS_RUNTIME_LEDGER,
                    "post_cost_promotion_eligible": True,
                    "runtime_ledger_bucket": _complete_runtime_ledger_bucket(),
                }
            ],
        )

        self.assertEqual(payload["authoritative"], True)
        self.assertEqual(payload["authority_reason"], "runtime_ledger_profit_proof")
        self.assertEqual(payload["promotion_authority"], "runtime_ledger")
        self.assertEqual(payload["runtime_ledger_profit_proof_present"], True)

    def test_runtime_observation_authority_accepts_source_backed_torghut_sim_proof(
        self,
    ) -> None:
        payload = _runtime_observation_authority_payload(
            source_kind="simulation_paper_runtime",
            tca_rows=[
                {
                    "computed_at": datetime(2026, 3, 6, 14, 36, tzinfo=timezone.utc),
                    "post_cost_expectancy_bps": Decimal("40"),
                    "post_cost_expectancy_basis": POST_COST_BASIS_RUNTIME_LEDGER,
                    "post_cost_promotion_eligible": True,
                    "runtime_ledger_bucket": _complete_runtime_ledger_bucket(),
                }
            ],
        )

        self.assertEqual(payload["authoritative"], True)
        self.assertEqual(payload["authority_reason"], "runtime_ledger_profit_proof")
        self.assertEqual(payload["promotion_authority"], "runtime_ledger")
        self.assertEqual(payload["runtime_ledger_profit_proof_present"], True)

    def test_runtime_observation_authority_keeps_simulation_replay_only_without_source_proof(
        self,
    ) -> None:
        payload = _runtime_observation_authority_payload(
            source_kind="simulation_paper_runtime",
            tca_rows=[
                {
                    "computed_at": datetime(2026, 3, 6, 14, 36, tzinfo=timezone.utc),
                    "post_cost_expectancy_bps": Decimal("40"),
                    "post_cost_expectancy_basis": POST_COST_BASIS_RUNTIME_LEDGER,
                    "post_cost_promotion_eligible": True,
                    "runtime_ledger_bucket": _complete_runtime_ledger_bucket(
                        source_window_ids=[],
                        trade_decision_ids=[],
                        execution_ids=[],
                        execution_order_event_ids=[],
                        source_offsets=[],
                        source_materialization="exact_replay_artifact",
                        authority_class="exact_replay_artifact_only_not_live",
                        authority_reason="exact_replay_artifact_not_runtime_proof",
                        pnl_derivation="exact_replay_artifact_only_not_live",
                        promotion_authority="blocked",
                        blockers=[],
                    ),
                }
            ],
        )

        self.assertEqual(payload["authoritative"], False)
        self.assertEqual(payload["authority_reason"], "simulation_source_replay_only")
        self.assertEqual(payload["promotion_authority"], "blocked")
        self.assertEqual(payload["runtime_ledger_profit_proof_present"], False)

    def test_parse_args_accepts_dataset_snapshot_ref(self) -> None:
        with patch(
            "sys.argv",
            [
                "import_hypothesis_runtime_windows.py",
                "--run-id",
                "run-1",
                "--candidate-id",
                "cand-1",
                "--hypothesis-id",
                "H-CONT-01",
                "--observed-stage",
                "paper",
                "--source-dsn",
                "postgresql://example",
                "--strategy-name",
                "intraday-tsmom-profit-v2",
                "--account-label",
                "TORGHUT_SIM",
                "--window-start",
                "2026-03-06T14:30:00Z",
                "--window-end",
                "2026-03-06T15:00:00Z",
                "--dataset-snapshot-ref",
                "torghut-runtime-window-cand-1",
                "--artifact-ref",
                "s3://torghut-runtime/cand-1/report.json",
                "--target-metadata-json",
                '{"paper_probation_authorized":true}',
                "--json",
            ],
        ):
            args = _parse_args()

        self.assertEqual(args.run_id, "run-1")
        self.assertEqual(args.dataset_snapshot_ref, "torghut-runtime-window-cand-1")
        self.assertEqual(args.artifact_ref, ["s3://torghut-runtime/cand-1/report.json"])
        self.assertEqual(
            args.target_metadata_json, '{"paper_probation_authorized":true}'
        )
        self.assertEqual(args.json, True)

    def test_source_row_lineage_accepts_plural_target_plan_ids(self) -> None:
        row = {
            "decision_json": {
                "params": {
                    "paper_route_probe": {
                        "source_candidate_ids": ["candidate-pairs-a"],
                        "source_hypothesis_ids": ["H-PAIRS-01"],
                    }
                }
            }
        }

        self.assertTrue(
            _source_row_matches_lineage(
                row,
                candidate_id="candidate-pairs-a",
                hypothesis_id="H-PAIRS-01",
                require_source_lineage=True,
            )
        )
        self.assertFalse(
            _source_row_matches_lineage(
                row,
                candidate_id="candidate-other",
                hypothesis_id="H-PAIRS-01",
                require_source_lineage=True,
            )
        )

    def test_runtime_ledger_profit_proof_rejects_malformed_bucket_payload(
        self,
    ) -> None:
        self.assertEqual(
            _runtime_ledger_profit_proof_present(
                [
                    {
                        "post_cost_expectancy_basis": POST_COST_BASIS_RUNTIME_LEDGER,
                        "runtime_ledger_bucket": "not-a-bucket",
                    }
                ]
            ),
            False,
        )

    def test_runtime_ledger_profit_proof_rejects_incomplete_bucket_payload(
        self,
    ) -> None:
        self.assertEqual(
            _runtime_ledger_profit_proof_present(
                [
                    {
                        "post_cost_expectancy_basis": POST_COST_BASIS_RUNTIME_LEDGER,
                        "runtime_ledger_bucket": {
                            "fill_count": 0,
                            "filled_notional": "0",
                            "post_cost_expectancy_bps": None,
                            "blockers": ["runtime_ledger_filled_notional_zero"],
                        },
                    }
                ]
            ),
            False,
        )

    def test_runtime_ledger_profit_proof_requires_lifecycle_and_lineage(
        self,
    ) -> None:
        incomplete = _complete_runtime_ledger_bucket(lineage_hash_counts={})
        complete = _complete_runtime_ledger_bucket()

        self.assertFalse(_runtime_ledger_bucket_profit_proof_present(incomplete))
        self.assertTrue(_runtime_ledger_bucket_profit_proof_present(complete))
        self.assertFalse(
            _runtime_ledger_profit_proof_present(
                [
                    {
                        "post_cost_expectancy_basis": POST_COST_BASIS_RUNTIME_LEDGER,
                        "runtime_ledger_bucket": incomplete,
                    }
                ]
            )
        )
        self.assertTrue(
            _runtime_ledger_profit_proof_present(
                [
                    {
                        "post_cost_expectancy_basis": POST_COST_BASIS_RUNTIME_LEDGER,
                        "runtime_ledger_bucket": complete,
                    }
                ]
            )
        )

    def test_runtime_ledger_profit_proof_rejects_each_incomplete_proof_field(
        self,
    ) -> None:
        invalid_cases = {
            "invalid_pnl_basis": {"pnl_basis": "simulation_report_net_pnl"},
            "invalid_schema": {"ledger_schema_version": "torghut.loose_ledger.v0"},
            "explicit_blocker": {"blockers": ["runtime_ledger_incomplete"]},
            "missing_fills": {"fill_count": 0},
            "missing_decisions": {"decision_count": 0},
            "missing_submitted_orders": {"submitted_order_count": 0},
            "missing_closed_trades": {"closed_trade_count": 0},
            "missing_open_position_count": {"open_position_count": None},
            "unclosed_position": {"open_position_count": 1},
            "missing_filled_notional": {"filled_notional": "0"},
            "missing_cost": {"cost_amount": None},
            "negative_cost": {"cost_amount": "-0.01"},
            "missing_expectancy": {"post_cost_expectancy_bps": None},
            "missing_execution_hash": {"execution_policy_hash_counts": "bad-shape"},
            "missing_cost_hash": {"cost_model_hash_counts": {}},
            "missing_lineage_hash": {"lineage_hash_counts": {}},
        }

        for name, overrides in invalid_cases.items():
            with self.subTest(name=name):
                self.assertFalse(
                    _runtime_ledger_bucket_profit_proof_present(
                        _complete_runtime_ledger_bucket(**overrides)
                    )
                )

    def test_runtime_ledger_profit_proof_blockers_name_missing_dimensions(
        self,
    ) -> None:
        blockers = _runtime_ledger_bucket_profit_proof_blockers(
            _complete_runtime_ledger_bucket(
                fill_count=0,
                submitted_order_count=0,
                closed_trade_count=0,
                open_position_count=1,
                cost_amount=None,
                cost_model_hash_counts={},
                lineage_hash_counts={},
                source_decision_mode_counts={"route_acquisition_probe": 2},
            )
        )

        self.assertIn("runtime_fills_missing", blockers)
        self.assertIn("submitted_order_lifecycle_missing", blockers)
        self.assertIn("closed_round_trip_missing", blockers)
        self.assertIn("unclosed_position", blockers)
        self.assertIn("runtime_ledger_cost_amount_missing", blockers)
        self.assertIn("runtime_ledger_cost_model_hash_missing", blockers)
        self.assertIn("runtime_ledger_lineage_hash_missing", blockers)
        self.assertIn("source_decision_mode_not_profit_proof_eligible", blockers)

    def test_runtime_ledger_profit_proof_distinguishes_diagnostic_expectancy(
        self,
    ) -> None:
        blockers = _runtime_ledger_bucket_profit_proof_blockers(
            _complete_runtime_ledger_bucket(
                open_position_count=1,
                post_cost_expectancy_bps=None,
                diagnostic_closed_trade_expectancy_bps="282.5",
                diagnostic_closed_trade_expectancy_basis=(
                    "realized_closed_trips_after_explicit_costs_not_promotion_grade"
                ),
            )
        )

        self.assertIn("unclosed_position", blockers)
        self.assertIn(
            "runtime_ledger_post_cost_expectancy_not_promotion_grade", blockers
        )
        self.assertNotIn("runtime_ledger_post_cost_expectancy_missing", blockers)
        self.assertFalse(
            _runtime_ledger_bucket_profit_proof_present(
                _complete_runtime_ledger_bucket(
                    open_position_count=1,
                    post_cost_expectancy_bps=None,
                    diagnostic_closed_trade_expectancy_bps="282.5",
                )
            )
        )

    def test_runtime_ledger_profit_proof_rejects_missing_source_decision_evidence(
        self,
    ) -> None:
        bucket = _complete_runtime_ledger_bucket(
            source_decision_mode_counts={},
            profit_proof_eligible=None,
        )

        self.assertIn(
            "source_decision_mode_profit_proof_missing",
            _runtime_ledger_bucket_profit_proof_blockers(bucket),
        )
        self.assertFalse(_runtime_ledger_bucket_profit_proof_present(bucket))

    def test_runtime_ledger_profit_proof_rejects_missing_source_window_or_refs(
        self,
    ) -> None:
        missing_window = _complete_runtime_ledger_bucket(
            source_window_start=None,
            source_window_end=None,
        )
        missing_refs = _complete_runtime_ledger_bucket(
            source_refs=[],
            source_ref=None,
            source_row_counts={},
        )

        self.assertIn(
            "runtime_ledger_source_window_missing",
            _runtime_ledger_bucket_profit_proof_blockers(missing_window),
        )
        self.assertFalse(_runtime_ledger_bucket_profit_proof_present(missing_window))
        self.assertIn(
            "runtime_ledger_source_refs_missing",
            _runtime_ledger_bucket_profit_proof_blockers(missing_refs),
        )
        self.assertFalse(_runtime_ledger_bucket_profit_proof_present(missing_refs))

    def test_runtime_ledger_profit_proof_rejects_aggregate_only_source_refs(
        self,
    ) -> None:
        aggregate_only = _complete_runtime_ledger_bucket(
            source_window_ids=[],
            trade_decision_ids=[],
            execution_ids=[],
            execution_order_event_ids=[],
            source_offsets=[],
            source_materialization=None,
            authority_class=None,
            authority_reason=None,
            pnl_derivation=None,
        )

        blockers = _runtime_ledger_bucket_profit_proof_blockers(aggregate_only)

        self.assertIn("runtime_ledger_trade_decision_refs_missing", blockers)
        self.assertIn("runtime_ledger_execution_refs_missing", blockers)
        self.assertIn("runtime_ledger_execution_order_event_refs_missing", blockers)
        self.assertIn("runtime_ledger_source_window_missing", blockers)
        self.assertIn("runtime_ledger_source_window_ids_missing", blockers)
        self.assertIn("runtime_ledger_source_offsets_missing", blockers)
        self.assertIn("runtime_ledger_source_materialization_missing", blockers)
        self.assertIn("runtime_ledger_authority_class_missing", blockers)
        self.assertFalse(_runtime_ledger_bucket_profit_proof_present(aggregate_only))

    def test_runtime_ledger_profit_proof_accepts_source_ref_aliases(
        self,
    ) -> None:
        source_window_ref_bucket = _complete_runtime_ledger_bucket(
            source_window_ids=[],
            source_window_refs=[
                "postgres:order_feed_source_windows:source-window-new-buy",
                "postgres:order_feed_source_windows:source-window-fill-buy",
                "postgres:order_feed_source_windows:source-window-new-sell",
                "postgres:order_feed_source_windows:source-window-fill-sell",
            ],
        )
        runtime_source_window_id_bucket = _complete_runtime_ledger_bucket(
            source_window_ids=[],
            runtime_ledger_source_window_ids=[
                "source-window-new-buy",
                "source-window-fill-buy",
                "source-window-new-sell",
                "source-window-fill-sell",
            ],
        )

        self.assertNotIn(
            "runtime_ledger_source_window_ids_missing",
            _runtime_ledger_bucket_profit_proof_blockers(source_window_ref_bucket),
        )
        self.assertTrue(
            _runtime_ledger_bucket_profit_proof_present(source_window_ref_bucket)
        )
        self.assertTrue(
            _runtime_ledger_bucket_profit_proof_present(runtime_source_window_id_bucket)
        )

    def test_runtime_ledger_source_context_writes_ref_aliases(self) -> None:
        payload = _with_runtime_ledger_source_authority_context(
            {"fill_count": 2},
            source_window_start=datetime(2026, 6, 5, 13, 30, tzinfo=timezone.utc),
            source_window_end=datetime(2026, 6, 5, 20, 0, tzinfo=timezone.utc),
            source_refs=[
                "postgres:trade_decisions",
                "postgres:executions",
                "postgres:execution_order_events",
                "postgres:order_feed_source_windows",
            ],
            source_row_counts={
                "trade_decisions": 1,
                "executions": 1,
                "execution_tca_metrics": 1,
                "execution_order_events": 1,
                "order_feed_source_windows": 1,
            },
            trade_decision_ids=["decision-1"],
            execution_ids=["execution-1"],
            execution_tca_metric_ids=["tca-1"],
            execution_order_event_ids=["event-1"],
            source_window_ids=["window-1"],
            source_offsets=[
                {"topic": "alpaca.trade_updates", "partition": 0, "offset": 1}
            ],
            source_materialization="execution_order_events",
            authority_class="runtime_order_feed_execution_source",
            authority_reason="event_sourced_runtime_ledger_profit_proof",
        )

        self.assertEqual(payload["trade_decision_refs"], ["decision-1"])
        self.assertEqual(payload["decision_refs"], ["decision-1"])
        self.assertEqual(payload["execution_refs"], ["execution-1"])
        self.assertEqual(payload["execution_tca_metric_refs"], ["tca-1"])
        self.assertEqual(payload["runtime_ledger_execution_tca_metric_refs"], ["tca-1"])
        self.assertEqual(payload["execution_order_event_refs"], ["event-1"])
        self.assertEqual(
            payload["runtime_ledger_execution_order_event_refs"], ["event-1"]
        )
        self.assertEqual(payload["source_window_refs"], ["window-1"])
        self.assertEqual(payload["runtime_ledger_source_window_refs"], ["window-1"])
