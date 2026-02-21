from __future__ import annotations

import json
import os
import tempfile
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from unittest.mock import patch
from unittest import TestCase
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from yaml import safe_load

from app.trading.autonomy.lane import (
    _resolve_gate_fragility_inputs,
    run_autonomous_lane,
    upsert_autonomy_no_signal_run,
)
from app.trading.autonomy.gates import GateEvaluationReport, GateResult
from app.trading.evaluation import WalkForwardDecision
from app.trading.features import SignalFeatures
from app.trading.models import StrategyDecision
from app.trading.reporting import PromotionEvidenceSummary, PromotionRecommendation
from app.models import (
    Base,
    ResearchCandidate,
    ResearchFoldMetrics,
    ResearchPromotion,
    ResearchRun,
    ResearchStressMetrics,
)


class TestAutonomousLane(TestCase):
    def test_gate_fragility_inputs_are_derived_from_decision_payloads(self) -> None:
        fallback_metrics = {
            "fragility_state": "elevated",
            "fragility_score": "0.40",
            "stability_mode_active": False,
        }
        decisions = [
            WalkForwardDecision(
                decision=StrategyDecision(
                    strategy_id="s1",
                    symbol="AAPL",
                    event_ts=datetime(2026, 1, 1, tzinfo=timezone.utc),
                    timeframe="1Min",
                    action="buy",
                    qty=Decimal("1"),
                    order_type="market",
                    time_in_force="day",
                    params={
                        "allocator": {
                            "fragility_state": "crisis",
                            "fragility_score": "0.92",
                            "stability_mode_active": True,
                        }
                    },
                ),
                features=SignalFeatures(
                    macd=None,
                    macd_signal=None,
                    rsi=None,
                    price=None,
                    volatility=None,
                ),
            )
        ]

        state, score, stability = _resolve_gate_fragility_inputs(
            metrics_payload=fallback_metrics, decisions=decisions
        )

        self.assertEqual(state, "crisis")
        self.assertEqual(score, Decimal("0.92"))
        self.assertTrue(stability)

    def test_lane_emits_gate_report_and_paper_patch(self) -> None:
        fixture_path = Path(__file__).parent / "fixtures" / "walkforward_signals.json"
        strategy_config_path = (
            Path(__file__).parent.parent / "config" / "autonomous-strategy-sample.yaml"
        )
        gate_policy_path = (
            Path(__file__).parent.parent / "config" / "autonomous-gate-policy.json"
        )
        strategy_configmap_path = (
            Path(__file__).parent.parent.parent.parent
            / "argocd"
            / "applications"
            / "torghut"
            / "strategy-configmap.yaml"
        )

        with tempfile.TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "lane"
            result = run_autonomous_lane(
                signals_path=fixture_path,
                strategy_config_path=strategy_config_path,
                gate_policy_path=gate_policy_path,
                output_dir=output_dir,
                promotion_target="paper",
                strategy_configmap_path=strategy_configmap_path,
                code_version="test-sha",
            )

            gate_payload = json.loads(
                result.gate_report_path.read_text(encoding="utf-8")
            )
            self.assertIn("gates", gate_payload)
            self.assertEqual(gate_payload["recommended_mode"], "paper")
            self.assertIn("promotion_evidence", gate_payload)
            self.assertIn("promotion_decision", gate_payload)
            evidence = gate_payload["promotion_evidence"]
            self.assertEqual(evidence["fold_metrics"]["count"], 1)
            self.assertEqual(evidence["stress_metrics"]["count"], 4)
            self.assertTrue(
                bool(evidence["promotion_rationale"].get("recommendation_trace_id"))
            )
            self.assertTrue(
                (output_dir / "gates" / "profitability-benchmark-v4.json").exists()
            )
            self.assertTrue(
                (output_dir / "gates" / "profitability-evidence-v4.json").exists()
            )
            self.assertTrue(
                (
                    output_dir / "gates" / "profitability-evidence-validation.json"
                ).exists()
            )
            self.assertTrue(
                (output_dir / "gates" / "promotion-evidence-gate.json").exists()
            )
            self.assertIsNotNone(result.paper_patch_path)
            assert result.paper_patch_path is not None
            self.assertTrue(result.paper_patch_path.exists())

    def test_lane_blocks_live_without_policy_enablement(self) -> None:
        fixture_path = Path(__file__).parent / "fixtures" / "walkforward_signals.json"
        strategy_config_path = (
            Path(__file__).parent.parent / "config" / "autonomous-strategy-sample.yaml"
        )
        gate_policy_path = (
            Path(__file__).parent.parent / "config" / "autonomous-gate-policy.json"
        )

        with tempfile.TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "lane-live"
            result = run_autonomous_lane(
                signals_path=fixture_path,
                strategy_config_path=strategy_config_path,
                gate_policy_path=gate_policy_path,
                output_dir=output_dir,
                promotion_target="live",
                code_version="test-sha",
            )

            gate_payload = json.loads(
                result.gate_report_path.read_text(encoding="utf-8")
            )
            self.assertFalse(gate_payload["promotion_allowed"])
            self.assertIn("live_rollout_disabled_by_policy", gate_payload["reasons"])
            self.assertIsNone(result.paper_patch_path)

    def test_lane_uses_repo_relative_default_configmap_path(self) -> None:
        fixture_path = Path(__file__).parent / "fixtures" / "walkforward_signals.json"
        strategy_config_path = (
            Path(__file__).parent.parent / "config" / "autonomous-strategy-sample.yaml"
        )
        gate_policy_path = (
            Path(__file__).parent.parent / "config" / "autonomous-gate-policy.json"
        )
        previous_cwd = Path.cwd()
        try:
            os.chdir(Path(__file__).parent.parent)
            with tempfile.TemporaryDirectory() as tmpdir:
                output_dir = Path(tmpdir) / "lane-default-path"
                result = run_autonomous_lane(
                    signals_path=fixture_path,
                    strategy_config_path=strategy_config_path,
                    gate_policy_path=gate_policy_path,
                    output_dir=output_dir,
                    promotion_target="paper",
                    code_version="test-sha",
                )
                self.assertIsNotNone(result.paper_patch_path)
                assert result.paper_patch_path is not None
                self.assertTrue(result.paper_patch_path.exists())

                patch_payload = safe_load(
                    result.paper_patch_path.read_text(encoding="utf-8")
                )
                self.assertIsNotNone(patch_payload)
                strategies_payload = safe_load(patch_payload["data"]["strategies.yaml"])
                self.assertIsInstance(strategies_payload, dict)
                strategies = strategies_payload.get("strategies", [])
                self.assertTrue(strategies)
                self.assertFalse(any("symbols" in strategy for strategy in strategies))
                self.assertEqual(strategies[0]["universe_type"], "static")
        finally:
            os.chdir(previous_cwd)

    def test_lane_persists_research_ledger_when_enabled(self) -> None:
        fixture_path = Path(__file__).parent / "fixtures" / "walkforward_signals.json"
        strategy_config_path = (
            Path(__file__).parent.parent / "config" / "autonomous-strategy-sample.yaml"
        )
        gate_policy_path = (
            Path(__file__).parent.parent / "config" / "autonomous-gate-policy.json"
        )

        engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            future=True,
            connect_args={"check_same_thread": False},
        )
        Base.metadata.create_all(engine)
        session_factory = sessionmaker(bind=engine, expire_on_commit=False, future=True)

        with tempfile.TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "lane-ledger"
            result = run_autonomous_lane(
                signals_path=fixture_path,
                strategy_config_path=strategy_config_path,
                gate_policy_path=gate_policy_path,
                output_dir=output_dir,
                promotion_target="paper",
                code_version="test-sha",
                persist_results=True,
                session_factory=session_factory,
            )

            self.assertIsNotNone(result.paper_patch_path)
            with session_factory() as session:
                run_row = session.execute(
                    select(ResearchRun).where(ResearchRun.run_id == result.run_id)
                ).scalar_one()
                candidate = session.execute(
                    select(ResearchCandidate).where(
                        ResearchCandidate.candidate_id == result.candidate_id
                    )
                ).scalar_one()
                fold_rows = (
                    session.execute(
                        select(ResearchFoldMetrics).where(
                            ResearchFoldMetrics.candidate_id == result.candidate_id
                        )
                    )
                    .scalars()
                    .all()
                )
                stress_rows = (
                    session.execute(
                        select(ResearchStressMetrics).where(
                            ResearchStressMetrics.candidate_id == result.candidate_id
                        )
                    )
                    .scalars()
                    .all()
                )
                promotion_row = session.execute(
                    select(ResearchPromotion).where(
                        ResearchPromotion.candidate_id == result.candidate_id
                    )
                ).scalar_one()

            self.assertEqual(run_row.status, "passed")
            self.assertIsNotNone(run_row.dataset_from)
            self.assertIsNotNone(run_row.dataset_to)
            self.assertIsInstance(candidate.decision_count, int)
            self.assertGreaterEqual(candidate.decision_count, 0)
            self.assertIsInstance(candidate.universe_definition, dict)
            assert isinstance(candidate.universe_definition, dict)
            lifecycle = candidate.universe_definition.get("autonomy_lifecycle")
            self.assertIsInstance(lifecycle, dict)
            assert isinstance(lifecycle, dict)
            self.assertEqual(lifecycle.get("role"), "challenger")
            self.assertIn(
                lifecycle.get("status"), {"promoted_champion", "retained_challenger"}
            )
            self.assertTrue(fold_rows)
            self.assertEqual(len(stress_rows), 4)
            self.assertEqual(promotion_row.requested_mode, "paper")
            self.assertIn(promotion_row.approved_mode, {"paper", None})
            self.assertIn(candidate.lifecycle_role, {"champion", "challenger"})
            self.assertIsInstance(candidate.metadata_bundle, dict)
            self.assertIsInstance(candidate.recommendation_bundle, dict)
            self.assertIsNotNone(promotion_row.decision_action)
            self.assertTrue((promotion_row.decision_rationale or "").strip())
            self.assertIsInstance(promotion_row.evidence_bundle, dict)
            self.assertIsNotNone(
                promotion_row.approve_reason or promotion_row.deny_reason
            )

    def test_upsert_no_signal_run_records_skipped_research_run(self) -> None:
        strategy_config_path = (
            Path(__file__).parent.parent / "config" / "autonomous-strategy-sample.yaml"
        )
        gate_policy_path = (
            Path(__file__).parent.parent / "config" / "autonomous-gate-policy.json"
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
        fixture_path = Path(__file__).parent / "fixtures" / "walkforward_signals.json"
        strategy_config_path = (
            Path(__file__).parent.parent / "config" / "autonomous-strategy-sample.yaml"
        )
        gate_policy_path = (
            Path(__file__).parent.parent / "config" / "autonomous-gate-policy.json"
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
        fixture_path = Path(__file__).parent / "fixtures" / "walkforward_signals.json"
        strategy_config_path = (
            Path(__file__).parent.parent / "config" / "autonomous-strategy-sample.yaml"
        )
        gate_policy_path = (
            Path(__file__).parent.parent / "config" / "autonomous-gate-policy.json"
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
            Path(__file__).parent.parent / "config" / "autonomous-strategy-sample.yaml"
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
                        "required_feature_schema_version": "3.0.0",
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

    def test_intraday_strategy_candidate_uses_intraday_universe_type(self) -> None:
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
            result = run_autonomous_lane(
                signals_path=signals_path,
                strategy_config_path=strategy_config_path,
                gate_policy_path=gate_policy_path,
                output_dir=output_dir,
                promotion_target="paper",
                code_version="test-sha",
            )
            self.assertIsNotNone(result.paper_patch_path)
            assert result.paper_patch_path is not None
            patch_payload = safe_load(
                result.paper_patch_path.read_text(encoding="utf-8")
            )
            strategies_payload = safe_load(patch_payload["data"]["strategies.yaml"])
            strategies = strategies_payload["strategies"]
            self.assertEqual(strategies[0]["universe_type"], "intraday_tsmom_v1")

    def test_lane_blocks_promotion_when_profitability_threshold_not_met(self) -> None:
        fixture_path = Path(__file__).parent / "fixtures" / "walkforward_signals.json"
        strategy_config_path = (
            Path(__file__).parent.parent / "config" / "autonomous-strategy-sample.yaml"
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
        fixture_path = Path(__file__).parent / "fixtures" / "walkforward_signals.json"
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
                            stress_metrics_count=4,
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

    def test_lane_marks_hold_recommendation_as_retained_challenger(self) -> None:
        fixture_path = Path(__file__).parent / "fixtures" / "walkforward_signals.json"
        strategy_config_path = (
            Path(__file__).parent.parent / "config" / "autonomous-strategy-sample.yaml"
        )
        gate_policy_path = (
            Path(__file__).parent.parent / "config" / "autonomous-gate-policy.json"
        )
        engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            future=True,
            connect_args={"check_same_thread": False},
        )
        Base.metadata.create_all(engine)
        session_factory = sessionmaker(bind=engine, expire_on_commit=False, future=True)

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
        with tempfile.TemporaryDirectory() as tmpdir:
            with patch(
                "app.trading.autonomy.lane.evaluate_gate_matrix",
                return_value=forced_gate,
            ):
                with patch(
                    "app.trading.autonomy.lane.build_promotion_recommendation",
                    return_value=PromotionRecommendation(
                        action="hold",
                        requested_mode="paper",
                        recommended_mode="shadow",
                        eligible=True,
                        rationale="hold_for_shadow_stage",
                        reasons=["shadow_mode_recommended"],
                        evidence=PromotionEvidenceSummary(
                            fold_metrics_count=1,
                            stress_metrics_count=4,
                            rationale_present=True,
                            evidence_complete=True,
                            reasons=[],
                        ),
                        trace_id="forced-hold-trace",
                    ),
                ):
                    result = run_autonomous_lane(
                        signals_path=fixture_path,
                        strategy_config_path=strategy_config_path,
                        gate_policy_path=gate_policy_path,
                        output_dir=Path(tmpdir) / "lane-hold",
                        promotion_target="paper",
                        code_version="test-sha",
                        persist_results=True,
                        session_factory=session_factory,
                    )

        with session_factory() as session:
            candidate = session.execute(
                select(ResearchCandidate).where(
                    ResearchCandidate.candidate_id == result.candidate_id
                )
            ).scalar_one()

        self.assertEqual(candidate.lifecycle_role, "challenger")
        self.assertEqual(candidate.lifecycle_status, "evaluated")
        self.assertIsInstance(candidate.universe_definition, dict)
        assert isinstance(candidate.universe_definition, dict)
        lifecycle = candidate.universe_definition.get("autonomy_lifecycle")
        self.assertIsInstance(lifecycle, dict)
        assert isinstance(lifecycle, dict)
        self.assertEqual(lifecycle.get("status"), "retained_challenger")
