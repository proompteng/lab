from __future__ import annotations

from tests.autonomous_lane.autonomous_lane_support import (
    AutonomousLaneTestCaseBase,
    Base,
    GateEvaluationReport,
    GateResult,
    Path,
    PromotionEvidenceSummary,
    PromotionPrerequisiteResult,
    PromotionRecommendation,
    ResearchCandidate,
    ResearchPromotion,
    ResearchRun,
    RollbackReadinessResult,
    _STRESS_METRICS_CASES,
    create_engine,
    datetime,
    json,
    patch,
    run_autonomous_lane,
    select,
    sessionmaker,
    tempfile,
    timezone,
    upsert_autonomy_no_signal_run,
)


class TestAutonomousLanePersistenceB(AutonomousLaneTestCaseBase):
    @patch(
        "app.trading.autonomy.lane.evaluate_promotion_prerequisites",
        return_value=PromotionPrerequisiteResult(
            allowed=True,
            reasons=[],
            required_artifacts=[],
            missing_artifacts=[],
            reason_details=[],
            artifact_refs=[],
            required_throughput={"signal_count": 1, "decision_count": 1},
            observed_throughput={"signal_count": 1, "decision_count": 1},
        ),
    )
    @patch(
        "app.trading.autonomy.lane.evaluate_rollback_readiness",
        return_value=RollbackReadinessResult(
            ready=True,
            reasons=[],
            required_checks=[],
            missing_checks=[],
        ),
    )
    @patch(
        "app.trading.autonomy.lane.evaluate_gate_matrix",
        return_value=GateEvaluationReport(
            policy_version="v3-gates-1",
            promotion_target="paper",
            promotion_allowed=True,
            recommended_mode="paper",
            gates=[
                GateResult(gate_id="gate0_data_integrity", status="pass"),
                GateResult(gate_id="gate1_statistical_robustness", status="pass"),
                GateResult(gate_id="gate2_risk_capacity", status="pass"),
                GateResult(gate_id="gate3_shadow_paper_quality", status="pass"),
                GateResult(gate_id="gate4_operational_readiness", status="pass"),
                GateResult(gate_id="gate6_profitability_evidence", status="pass"),
                GateResult(gate_id="gate5_live_ramp_readiness", status="pass"),
            ],
            reasons=[],
            uncertainty_gate_action="pass",
            coverage_error="0.01",
            conformal_interval_width="1.0",
            shift_score="0.10",
            recalibration_run_id=None,
            evaluated_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
            code_version="test-sha",
        ),
    )
    @patch(
        "app.trading.autonomy.lane.build_promotion_recommendation",
        return_value=PromotionRecommendation(
            action="promote",
            requested_mode="paper",
            recommended_mode="paper",
            eligible=True,
            rationale="promoted_for_immutable_evidence_test",
            reasons=[],
            evidence=PromotionEvidenceSummary(
                fold_metrics_count=1,
                stress_metrics_count=4,
                rationale_present=True,
                evidence_complete=True,
                reasons=[],
            ),
            trace_id="promote-test-trace",
        ),
    )
    def test_lane_persists_immutable_lineage_for_promoted_candidate(
        self,
        _mock_build_recommendation: object,
        _mock_gate: object,
        _mock_rollback: object,
        _mock_prerequisites: object,
    ) -> None:
        fixture_path = (
            Path(__file__).parents[1] / "fixtures" / "walkforward_signals.json"
        )
        strategy_config_path = (
            Path(__file__).parents[2] / "config" / "autonomous-strategy-sample.yaml"
        )
        gate_policy_path = (
            Path(__file__).parents[2] / "config" / "autonomous-gate-policy.json"
        )
        strategy_configmap_path = (
            Path(__file__).parents[4]
            / "argocd"
            / "applications"
            / "torghut"
            / "strategy-configmap.yaml"
        )
        engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            future=True,
            connect_args={"check_same_thread": False},
        )
        Base.metadata.create_all(engine)
        session_factory = sessionmaker(bind=engine, expire_on_commit=False, future=True)

        with tempfile.TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "lane-promoted"
            result = run_autonomous_lane(
                signals_path=fixture_path,
                strategy_config_path=strategy_config_path,
                gate_policy_path=gate_policy_path,
                output_dir=output_dir,
                promotion_target="paper",
                strategy_configmap_path=strategy_configmap_path,
                code_version="test-sha",
                persist_results=True,
                session_factory=session_factory,
            )
            self.assertIsNotNone(result.paper_patch_path)

            candidate_spec = json.loads(
                result.candidate_spec_path.read_text(encoding="utf-8")
            )
            actuation_payload = json.loads(
                result.actuation_intent_path.read_text(encoding="utf-8")
                if result.actuation_intent_path
                else "{}"
            )
            with session_factory() as session:
                candidate = session.execute(
                    select(ResearchCandidate).where(
                        ResearchCandidate.candidate_id == result.candidate_id
                    )
                ).scalar_one()
                promotion_row = session.execute(
                    select(ResearchPromotion).where(
                        ResearchPromotion.candidate_id == result.candidate_id
                    )
                ).scalar_one()
            self.assertEqual(candidate.lifecycle_role, "champion")
            self.assertEqual(candidate.lifecycle_status, "active")
            self.assertIsNotNone(candidate.candidate_hash)
            self.assertEqual(candidate_spec["candidate_hash"], candidate.candidate_hash)
            self.assertEqual(
                actuation_payload["candidate_hash"],
                candidate.candidate_hash,
            )
            self.assertEqual(
                actuation_payload["audit"]["stage_lineage"],
                candidate_spec["stage_lineage"],
            )
            self.assertEqual(
                actuation_payload["audit"]["replay_artifact_hashes"],
                candidate_spec["replay_artifact_hashes"],
            )
            self.assertIn("stage_lineage", candidate.metadata_bundle)
            self.assertIn("stage_manifest_refs", candidate.metadata_bundle)
            self.assertIn("replay_artifact_hashes", candidate.metadata_bundle)
            self.assertIn("stage_trace_ids", candidate.metadata_bundle)
            self.assertEqual(
                candidate.metadata_bundle["stage_lineage"]["root_lineage_hash"],
                result.stage_lineage_root,
            )
            self.assertEqual(
                candidate.metadata_bundle["stage_lineage"]["root_lineage_hash"],
                candidate_spec["stage_lineage"]["root_lineage_hash"],
            )
            self.assertEqual(
                candidate.metadata_bundle["stage_manifest_refs"],
                candidate_spec["stage_manifest_refs"],
            )
            self.assertEqual(
                candidate.metadata_bundle["stage_trace_ids"],
                candidate_spec["stage_trace_ids"],
            )
            self.assertEqual(
                candidate.metadata_bundle["replay_artifact_hashes"],
                candidate_spec["replay_artifact_hashes"],
            )
            self.assertEqual(promotion_row.approved_mode, "paper")
            self.assertEqual(promotion_row.decision_action, "promote")
            self.assertIsNotNone(promotion_row.approve_reason)
            self.assertEqual(
                promotion_row.evidence_bundle["stage_lineage"]["root_lineage_hash"],
                result.stage_lineage_root,
            )
            self.assertEqual(
                promotion_row.evidence_bundle["replay_artifact_hashes"],
                candidate.metadata_bundle["replay_artifact_hashes"],
            )

            for artifact_key, expected_hash in candidate_spec[
                "replay_artifact_hashes"
            ].items():
                artifact_path = candidate_spec["artifacts"].get(artifact_key)
                self.assertIsNotNone(
                    artifact_path,
                    f"artifact {artifact_key} should be included in candidate spec artifacts",
                )
                self.assertEqual(
                    expected_hash,
                    self._artifact_sha256(Path(artifact_path)),
                    f"artifact hash for {artifact_key} should be immutable",
                )

    def test_lane_fails_closed_when_required_stage_artifact_is_missing(self) -> None:
        fixture_path = (
            Path(__file__).parents[1] / "fixtures" / "walkforward_signals.json"
        )
        strategy_config_path = (
            Path(__file__).parents[2] / "config" / "autonomous-strategy-sample.yaml"
        )
        policy_payload = {
            "promotion_required_artifacts": [
                "research/candidate-spec.json",
                "backtest/evaluation-report.json",
                "gates/gate-evaluation.json",
                "stages/does-not-exist-manifest.json",
            ],
            "promotion_require_patch_targets": [],
            "gate6_require_profitability_evidence": False,
            "gate6_require_janus_evidence": False,
            "promotion_require_janus_evidence": False,
        }

        with tempfile.TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "lane-missing-artifact"
            policy_path = Path(tmpdir) / "policy.json"
            policy_path.write_text(json.dumps(policy_payload), encoding="utf-8")
            result = run_autonomous_lane(
                signals_path=fixture_path,
                strategy_config_path=strategy_config_path,
                gate_policy_path=policy_path,
                output_dir=output_dir,
                promotion_target="paper",
                code_version="test-sha",
            )

            actuation_payload = json.loads(
                result.actuation_intent_path.read_text(encoding="utf-8")
                if result.actuation_intent_path
                else "{}"
            )
            promotion_reqs = json.loads(
                (output_dir / "gates" / "promotion-prerequisites.json").read_text(
                    encoding="utf-8"
                )
            )

        self.assertFalse(actuation_payload["actuation_allowed"])
        self.assertIn(
            "required_artifacts_missing",
            actuation_payload["gates"]["recommendation_reasons"],
        )
        self.assertIn("required_artifacts_missing", promotion_reqs["reasons"])
        self.assertIn(
            "stages/does-not-exist-manifest.json",
            promotion_reqs["missing_artifacts"],
        )

    def test_lane_fails_closed_still_records_stage_lineage(self) -> None:
        fixture_path = (
            Path(__file__).parents[1] / "fixtures" / "walkforward_signals.json"
        )
        strategy_config_path = (
            Path(__file__).parents[2] / "config" / "autonomous-strategy-sample.yaml"
        )
        policy_payload = {
            "promotion_required_artifacts": [
                "research/candidate-spec.json",
                "backtest/evaluation-report.json",
                "stages/candidate-generation-manifest.json",
                "stages/evaluation-manifest.json",
                "stages/promotion-recommendation-manifest.json",
            ],
            "promotion_require_patch_targets": [],
            "gate6_require_profitability_evidence": False,
            "gate6_require_janus_evidence": False,
            "promotion_require_janus_evidence": False,
        }

        with tempfile.TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "lane-fail-closed"
            policy_path = Path(tmpdir) / "policy.json"
            policy_path.write_text(json.dumps(policy_payload), encoding="utf-8")
            result = run_autonomous_lane(
                signals_path=fixture_path,
                strategy_config_path=strategy_config_path,
                gate_policy_path=policy_path,
                output_dir=output_dir,
                promotion_target="paper",
                code_version="test-sha",
            )

            candidate_manifest = json.loads(
                result.candidate_generation_manifest_path.read_text(encoding="utf-8")
            )
            evaluation_manifest = json.loads(
                result.evaluation_manifest_path.read_text(encoding="utf-8")
            )
            recommendation_manifest = json.loads(
                result.recommendation_manifest_path.read_text(encoding="utf-8")
            )

            self.assertEqual(candidate_manifest["stage"], "candidate-generation")
            self.assertEqual(evaluation_manifest["stage"], "evaluation")
            self.assertEqual(
                recommendation_manifest["stage"],
                "promotion-recommendation",
            )
            self.assertEqual(
                evaluation_manifest["parent_lineage_hash"],
                candidate_manifest["lineage_hash"],
            )
            self.assertEqual(
                recommendation_manifest["parent_lineage_hash"],
                evaluation_manifest["lineage_hash"],
            )

            gate_payload = json.loads(
                result.gate_report_path.read_text(encoding="utf-8")
            )
            self.assertFalse(gate_payload["promotion_decision"]["promotion_allowed"])
            self.assertFalse(result.paper_patch_path)

            actuation_payload = json.loads(
                result.actuation_intent_path.read_text(encoding="utf-8")
            )
            self.assertFalse(actuation_payload["actuation_allowed"])

            candidate_spec = json.loads(
                result.candidate_spec_path.read_text(encoding="utf-8")
            )
            self.assertIn("candidate_hash", candidate_spec)
            self.assertEqual(
                candidate_spec["stage_trace_ids"],
                result.stage_trace_ids,
            )
            self.assertEqual(
                candidate_spec["stage_lineage"]["root_lineage_hash"],
                result.stage_lineage_root,
            )
            self.assertIn("audit", actuation_payload)
            self.assertIn("stage_lineage", actuation_payload["audit"])
            self.assertIn("replay_artifact_hashes", actuation_payload["audit"])
            self.assertEqual(
                actuation_payload["candidate_hash"],
                candidate_spec["candidate_hash"],
            )
            self.assertIn("promotion-recommendation", candidate_spec["stage_trace_ids"])
            self.assertIn(
                "stage_lineage",
                candidate_spec,
            )

    def test_upsert_no_signal_run_records_skipped_research_run(self) -> None:
        strategy_config_path = (
            Path(__file__).parents[2] / "config" / "autonomous-strategy-sample.yaml"
        )
        gate_policy_path = (
            Path(__file__).parents[2] / "config" / "autonomous-gate-policy.json"
        )

        engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            future=True,
            connect_args={"check_same_thread": False},
        )
        Base.metadata.create_all(engine)
        session_factory = sessionmaker(bind=engine, expire_on_commit=False, future=True)

        query_start = datetime(2026, 1, 1, 0, 0, tzinfo=timezone.utc)
        query_end = datetime(2026, 1, 1, 0, 15, tzinfo=timezone.utc)

        run_id = upsert_autonomy_no_signal_run(
            session_factory=session_factory,
            query_start=query_start,
            query_end=query_end,
            strategy_config_path=strategy_config_path,
            gate_policy_path=gate_policy_path,
            no_signal_reason="cursor_ahead_of_stream",
            now=query_start,
            code_version="test-sha",
        )

        with session_factory() as session:
            run_row = session.execute(
                select(ResearchRun).where(ResearchRun.run_id == run_id)
            ).scalar_one()

        def _as_utc(value: datetime) -> datetime:
            return (
                value
                if value.tzinfo is not None
                else value.replace(tzinfo=timezone.utc)
            )

        self.assertEqual(run_row.status, "skipped")
        self.assertEqual(_as_utc(run_row.dataset_from), query_start)
        self.assertEqual(_as_utc(run_row.dataset_to), query_end)
        self.assertEqual(run_row.runner_version, "run_autonomous_lane_no_signals")
        self.assertEqual(run_row.dataset_snapshot_ref, "no_signal_window")

    @patch("app.trading.autonomy.lane._persist_run_outputs")
    def test_lane_persistence_failure_marks_run_failed(
        self, mock_persist: object
    ) -> None:
        fixture_path = (
            Path(__file__).parents[1] / "fixtures" / "walkforward_signals.json"
        )
        strategy_config_path = (
            Path(__file__).parents[2] / "config" / "autonomous-strategy-sample.yaml"
        )
        gate_policy_path = (
            Path(__file__).parents[2] / "config" / "autonomous-gate-policy.json"
        )

        engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            future=True,
            connect_args={"check_same_thread": False},
        )
        Base.metadata.create_all(engine)
        session_factory = sessionmaker(bind=engine, expire_on_commit=False, future=True)
        mock_persist.side_effect = RuntimeError("ledger_write_failed")

        with tempfile.TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "lane-ledger-fail"
            with self.assertRaises(RuntimeError) as ctx:
                run_autonomous_lane(
                    signals_path=fixture_path,
                    strategy_config_path=strategy_config_path,
                    gate_policy_path=gate_policy_path,
                    output_dir=output_dir,
                    promotion_target="paper",
                    code_version="test-sha",
                    persist_results=True,
                    session_factory=session_factory,
                )
            self.assertIn("autonomous_lane_persistence_failed", str(ctx.exception))

            with session_factory() as session:
                run_rows = session.execute(select(ResearchRun)).scalars().all()
                candidate_rows = (
                    session.execute(select(ResearchCandidate)).scalars().all()
                )

            self.assertEqual(len(run_rows), 1)
            self.assertEqual(run_rows[0].status, "failed")
            self.assertEqual(len(candidate_rows), 0)

    def test_lane_promotion_audit_rows_are_append_only_for_repeat_runs(self) -> None:
        fixture_path = (
            Path(__file__).parents[1] / "fixtures" / "walkforward_signals.json"
        )
        strategy_config_path = (
            Path(__file__).parents[2] / "config" / "autonomous-strategy-sample.yaml"
        )
        gate_policy_path = (
            Path(__file__).parents[2] / "config" / "autonomous-gate-policy.json"
        )

        engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            future=True,
            connect_args={"check_same_thread": False},
        )
        Base.metadata.create_all(engine)
        session_factory = sessionmaker(bind=engine, expire_on_commit=False, future=True)

        with tempfile.TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "lane-ledger-repeat"
            first = run_autonomous_lane(
                signals_path=fixture_path,
                strategy_config_path=strategy_config_path,
                gate_policy_path=gate_policy_path,
                output_dir=output_dir / "first",
                promotion_target="paper",
                code_version="test-sha",
                persist_results=True,
                session_factory=session_factory,
            )
            second = run_autonomous_lane(
                signals_path=fixture_path,
                strategy_config_path=strategy_config_path,
                gate_policy_path=gate_policy_path,
                output_dir=output_dir / "second",
                promotion_target="paper",
                code_version="test-sha",
                persist_results=True,
                session_factory=session_factory,
            )

        self.assertEqual(first.candidate_id, second.candidate_id)
        with session_factory() as session:
            promotion_rows = (
                session.execute(
                    select(ResearchPromotion).where(
                        ResearchPromotion.candidate_id == first.candidate_id
                    )
                )
                .scalars()
                .all()
            )
        self.assertGreaterEqual(len(promotion_rows), 2)

    def test_lane_counts_rsi_alias_for_gate_null_rate(self) -> None:
        strategy_config_path = (
            Path(__file__).parents[2] / "config" / "autonomous-strategy-sample.yaml"
        )
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            signals_path = tmp / "signals.json"
            policy_path = tmp / "policy.json"
            output_dir = tmp / "lane-rsi-alias"

            signals_path.write_text(
                json.dumps(
                    [
                        {
                            "event_ts": datetime(
                                2026, 1, 1, 0, 0, tzinfo=timezone.utc
                            ).isoformat(),
                            "ingest_ts": datetime(
                                2026, 1, 1, 0, 0, tzinfo=timezone.utc
                            ).isoformat(),
                            "symbol": "AAPL",
                            "timeframe": "1Min",
                            "payload": {
                                "macd": {"macd": "1.2", "signal": "0.8"},
                                "rsi": "24",
                                "price": "101.5",
                            },
                            "seq": 1,
                            "source": "fixture",
                        }
                    ]
                ),
                encoding="utf-8",
            )
            policy_path.write_text(
                json.dumps(
                    {
                        "policy_version": "v3-gates-1",
                        "required_feature_schema_version": "v3",
                        "gate0_max_null_rate": "0",
                        "gate0_max_staleness_ms": 120000,
                        "gate0_min_symbol_coverage": 1,
                        "gate1_min_decision_count": 0,
                        "gate1_min_trade_count": 0,
                        "gate1_min_net_pnl": "-100000",
                        "gate1_max_negative_fold_ratio": "1",
                        "gate1_max_net_pnl_cv": "100",
                        "gate2_max_drawdown": "100000",
                        "gate2_max_turnover_ratio": "1000",
                        "gate2_max_cost_bps": "1000",
                        "gate3_max_llm_error_ratio": "1",
                        "gate5_live_enabled": False,
                    }
                ),
                encoding="utf-8",
            )

            result = run_autonomous_lane(
                signals_path=signals_path,
                strategy_config_path=strategy_config_path,
                gate_policy_path=policy_path,
                output_dir=output_dir,
                promotion_target="paper",
                code_version="test-sha",
            )
            gate_payload = json.loads(
                result.gate_report_path.read_text(encoding="utf-8")
            )
            gate0 = next(
                item
                for item in gate_payload["gates"]
                if item["gate_id"] == "gate0_data_integrity"
            )
            self.assertEqual(gate0["status"], "pass")

    def test_intraday_strategy_candidate_blocks_paper_patch_without_tca_evidence(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            config_dir = Path(tmpdir) / "configs"
            config_dir.mkdir(parents=True, exist_ok=True)
            signals_path = config_dir / "intraday_signals.json"
            strategy_config_path = config_dir / "intraday_strategy_candidate.json"
            gate_policy_path = config_dir / "autonomous_gate_policy_short.json"
            signals_path.write_text(
                json.dumps(
                    [
                        {
                            "event_ts": datetime(
                                2026, 1, 1, 0, 1, tzinfo=timezone.utc
                            ).isoformat(),
                            "ingest_ts": datetime(
                                2026, 1, 1, 0, 1, tzinfo=timezone.utc
                            ).isoformat(),
                            "symbol": "AAPL",
                            "timeframe": "1Min",
                            "payload": {
                                "macd": {"macd": "0.12", "signal": "0.03"},
                                "rsi14": "56",
                                "price": "101.5",
                                "ema12": "101.0",
                                "ema26": "100.5",
                                "vol_realized_w60s": "0.008",
                            },
                            "seq": 1,
                            "source": "fixture",
                        },
                        {
                            "event_ts": datetime(
                                2026, 1, 1, 0, 2, tzinfo=timezone.utc
                            ).isoformat(),
                            "ingest_ts": datetime(
                                2026, 1, 1, 0, 2, tzinfo=timezone.utc
                            ).isoformat(),
                            "symbol": "AAPL",
                            "timeframe": "1Min",
                            "payload": {
                                "macd": {"macd": "-0.22", "signal": "-0.10"},
                                "rsi14": "72",
                                "price": "100.0",
                                "ema12": "100.3",
                                "ema26": "100.8",
                                "vol_realized_w60s": "0.006",
                            },
                            "seq": 2,
                            "source": "fixture",
                        },
                    ]
                ),
                encoding="utf-8",
            )

            strategy_config_path.write_text(
                json.dumps(
                    {
                        "strategies": [
                            {
                                "strategy_id": "candidate-intraday",
                                "strategy_type": "intraday_tsmom_v1",
                                "version": "1.1.0",
                                "enabled": True,
                            }
                        ]
                    },
                    sort_keys=False,
                ),
                encoding="utf-8",
            )
            gate_policy_path.write_text(
                json.dumps(
                    {
                        "policy_version": "test-policy",
                        "required_feature_schema_version": "3.0.0",
                        "gate1_min_decision_count": 0,
                        "gate1_min_trade_count": 0,
                        "gate1_min_net_pnl": "-100000",
                        "gate1_max_negative_fold_ratio": "1",
                        "gate1_max_net_pnl_cv": "100",
                        "gate2_max_drawdown": "100000",
                        "gate2_max_turnover_ratio": "1000",
                        "gate2_max_cost_bps": "1000",
                        "gate3_max_llm_error_ratio": "1",
                        "gate6_require_profitability_evidence": False,
                        "gate5_live_enabled": False,
                    },
                    sort_keys=True,
                ),
                encoding="utf-8",
            )

            output_dir = Path(tmpdir) / "lane-tsmom"
            session_factory = self._empty_session_factory()
            result = run_autonomous_lane(
                signals_path=signals_path,
                strategy_config_path=strategy_config_path,
                gate_policy_path=gate_policy_path,
                output_dir=output_dir,
                promotion_target="paper",
                session_factory=session_factory,
                code_version="test-sha",
            )
            self.assertIsNone(result.paper_patch_path)
            gate_payload = json.loads(
                result.gate_report_path.read_text(encoding="utf-8")
            )
            self.assertFalse(gate_payload["promotion_decision"]["promotion_allowed"])
            self.assertIn(
                "tca_order_count_below_minimum",
                gate_payload["promotion_decision"]["reason_codes"],
            )

    def test_lane_blocks_promotion_when_profitability_threshold_not_met(self) -> None:
        fixture_path = (
            Path(__file__).parents[1] / "fixtures" / "walkforward_signals.json"
        )
        strategy_config_path = (
            Path(__file__).parents[2] / "config" / "autonomous-strategy-sample.yaml"
        )

        with tempfile.TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "lane-profitability-block"
            policy_path = Path(tmpdir) / "strict-policy.json"
            policy_path.write_text(
                json.dumps(
                    {
                        "policy_version": "v3-gates-1",
                        "required_feature_schema_version": "3.0.0",
                        "gate0_max_null_rate": "0.01",
                        "gate0_max_staleness_ms": 120000,
                        "gate0_min_symbol_coverage": 1,
                        "gate1_min_decision_count": 1,
                        "gate1_min_trade_count": 1,
                        "gate1_min_net_pnl": "0",
                        "gate1_max_negative_fold_ratio": "1",
                        "gate1_max_net_pnl_cv": "100",
                        "gate2_max_drawdown": "100000",
                        "gate2_max_turnover_ratio": "1000",
                        "gate2_max_cost_bps": "1000",
                        "gate3_max_llm_error_ratio": "1",
                        "gate6_min_market_net_pnl_delta": "999999",
                        "gate6_min_regime_slice_pass_ratio": "1",
                        "gate6_min_return_over_drawdown": "999999",
                        "gate6_max_cost_bps": "1",
                        "gate6_max_calibration_error": "0.01",
                        "gate6_min_reproducibility_hashes": 20,
                        "gate5_live_enabled": False,
                    }
                ),
                encoding="utf-8",
            )

            result = run_autonomous_lane(
                signals_path=fixture_path,
                strategy_config_path=strategy_config_path,
                gate_policy_path=policy_path,
                output_dir=output_dir,
                promotion_target="paper",
                code_version="test-sha",
            )

            gate_payload = json.loads(
                result.gate_report_path.read_text(encoding="utf-8")
            )
            self.assertFalse(gate_payload["promotion_allowed"])
            self.assertIn(
                "profitability_evidence_validation_failed", gate_payload["reasons"]
            )
            self.assertIsNone(result.paper_patch_path)

    def test_lane_promotion_demotes_previous_champion_with_audit(self) -> None:
        fixture_path = (
            Path(__file__).parents[1] / "fixtures" / "walkforward_signals.json"
        )
        engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            future=True,
            connect_args={"check_same_thread": False},
        )
        Base.metadata.create_all(engine)
        session_factory = sessionmaker(bind=engine, expire_on_commit=False, future=True)

        with tempfile.TemporaryDirectory() as tmpdir:
            strategy_a = Path(tmpdir) / "strategy-a.json"
            strategy_b = Path(tmpdir) / "strategy-b.json"
            gate_policy_path = Path(tmpdir) / "permissive-gate-policy.json"
            strategy_a.write_text(
                json.dumps(
                    {
                        "strategies": [
                            {
                                "strategy_id": "candidate-a",
                                "strategy_type": "legacy_macd_rsi",
                                "version": "1.0.0",
                                "enabled": True,
                            }
                        ]
                    }
                ),
                encoding="utf-8",
            )
            gate_policy_path.write_text(
                json.dumps(
                    {
                        "policy_version": "v3-gates-1",
                        "required_feature_schema_version": "3.0.0",
                        "gate0_max_null_rate": "1",
                        "gate0_max_staleness_ms": 120000,
                        "gate0_min_symbol_coverage": 1,
                        "gate1_min_decision_count": 0,
                        "gate1_min_trade_count": 0,
                        "gate1_min_net_pnl": "-1000000",
                        "gate1_max_negative_fold_ratio": "1",
                        "gate1_max_net_pnl_cv": "999",
                        "gate2_max_drawdown": "1000000",
                        "gate2_max_turnover_ratio": "1000000",
                        "gate2_max_cost_bps": "1000000",
                        "gate3_max_llm_error_ratio": "1",
                        "gate6_require_profitability_evidence": False,
                        "gate5_live_enabled": False,
                    }
                ),
                encoding="utf-8",
            )
            strategy_b.write_text(
                json.dumps(
                    {
                        "strategies": [
                            {
                                "strategy_id": "candidate-b",
                                "strategy_type": "legacy_macd_rsi",
                                "version": "1.0.1",
                                "enabled": True,
                            }
                        ]
                    }
                ),
                encoding="utf-8",
            )

            forced_gate = GateEvaluationReport(
                policy_version="v3-gates-1",
                promotion_target="paper",
                promotion_allowed=True,
                recommended_mode="paper",
                gates=[
                    GateResult(gate_id="gate0_data_integrity", status="pass"),
                    GateResult(gate_id="gate1_statistical_robustness", status="pass"),
                    GateResult(gate_id="gate2_risk_capacity", status="pass"),
                    GateResult(gate_id="gate3_shadow_paper_quality", status="pass"),
                    GateResult(gate_id="gate4_operational_readiness", status="pass"),
                    GateResult(gate_id="gate6_profitability_evidence", status="pass"),
                    GateResult(gate_id="gate5_live_ramp_readiness", status="pass"),
                ],
                reasons=[],
                uncertainty_gate_action="pass",
                coverage_error="0.02",
                conformal_interval_width="1.00",
                shift_score="0.10",
                recalibration_run_id=None,
                evaluated_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
                code_version="test-sha",
            )
            with patch(
                "app.trading.autonomy.lane.evaluate_gate_matrix",
                return_value=forced_gate,
            ):
                with patch(
                    "app.trading.autonomy.lane.build_promotion_recommendation",
                    return_value=PromotionRecommendation(
                        action="promote",
                        requested_mode="paper",
                        recommended_mode="paper",
                        eligible=True,
                        rationale="forced_test_rationale",
                        reasons=[],
                        evidence=PromotionEvidenceSummary(
                            fold_metrics_count=1,
                            stress_metrics_count=len(_STRESS_METRICS_CASES),
                            rationale_present=True,
                            evidence_complete=True,
                            reasons=[],
                        ),
                        trace_id="forced-trace",
                    ),
                ):
                    first = run_autonomous_lane(
                        signals_path=fixture_path,
                        strategy_config_path=strategy_a,
                        gate_policy_path=gate_policy_path,
                        output_dir=Path(tmpdir) / "lane-a",
                        promotion_target="paper",
                        code_version="test-sha",
                        persist_results=True,
                        session_factory=session_factory,
                    )
                    second = run_autonomous_lane(
                        signals_path=fixture_path,
                        strategy_config_path=strategy_b,
                        gate_policy_path=gate_policy_path,
                        output_dir=Path(tmpdir) / "lane-b",
                        promotion_target="paper",
                        code_version="test-sha",
                        persist_results=True,
                        session_factory=session_factory,
                    )

            with session_factory() as session:
                first_candidate = session.execute(
                    select(ResearchCandidate).where(
                        ResearchCandidate.candidate_id == first.candidate_id
                    )
                ).scalar_one()
                second_candidate = session.execute(
                    select(ResearchCandidate).where(
                        ResearchCandidate.candidate_id == second.candidate_id
                    )
                ).scalar_one()
                demotion_row = session.execute(
                    select(ResearchPromotion).where(
                        ResearchPromotion.candidate_id == first.candidate_id,
                        ResearchPromotion.decision_action == "demote",
                        ResearchPromotion.successor_candidate_id == second.candidate_id,
                    )
                ).scalar_one_or_none()

            self.assertEqual(second_candidate.lifecycle_role, "champion")
            self.assertEqual(second_candidate.lifecycle_status, "active")
            self.assertEqual(first_candidate.lifecycle_role, "demoted")
            self.assertEqual(first_candidate.lifecycle_status, "standby")
            self.assertIsNotNone(demotion_row)
            assert demotion_row is not None
            self.assertEqual(demotion_row.rollback_candidate_id, first.candidate_id)
