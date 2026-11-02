from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from app.models import Base, ResearchRun
from app.trading.autonomy import lane
from app.trading.autonomy import lane_common
from app.trading.autonomy import lane_persistence
from app.trading.autonomy import lane_phase_payloads as phase_payloads
from app.trading.autonomy.gates import GateEvaluationReport, GateResult
from app.trading.autonomy.lane_common import LANE_AUTONOMY_PHASE_ORDER
from app.trading.autonomy.runtime import StrategyRuntimeConfig
from app.trading.models import SignalEnvelope
from app.trading.reporting import PromotionEvidenceSummary, PromotionRecommendation


def _write_json(path: Path, payload: object) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


def _runtime_strategy(
    strategy_id: str,
    *,
    strategy_type: str = "legacy_macd_rsi",
    compiler_source: str = "spec_v2",
    symbols: list[str] | None = None,
    promotion_metadata: dict[str, object] | None = None,
) -> StrategyRuntimeConfig:
    return StrategyRuntimeConfig(
        strategy_id=strategy_id,
        strategy_type=strategy_type,
        version="1.0.0",
        params={},
        compiler_source=compiler_source,
        strategy_spec={"universe": {"symbols": symbols or []}},
        compiled_targets={"promotion_metadata": promotion_metadata or {}},
    )


def _gate_report(now: datetime, *, allowed: bool = True) -> GateEvaluationReport:
    return GateEvaluationReport(
        policy_version="v1",
        promotion_target="paper",
        promotion_allowed=allowed,
        recommended_mode="paper",
        gates=[
            GateResult(
                gate_id="g1",
                status="pass",
                artifact_refs=["gates/evidence.json"],
            )
        ],
        reasons=[] if allowed else ["blocked"],
        uncertainty_gate_action="pass" if allowed else "fail",
        coverage_error=None,
        conformal_interval_width=None,
        shift_score=None,
        recalibration_run_id=None,
        evaluated_at=now,
        code_version="test",
    )


def test_phase_manifest_normalizes_missing_phases_and_scalar_helpers(
    tmp_path: Path,
) -> None:
    now = datetime(2026, 1, 1, tzinfo=timezone.utc)
    output_dir = tmp_path / "lane"
    research_dir, backtest_dir, gates_dir, paper_dir, rollout_dir = (
        phase_payloads.prepare_lane_output_dirs(output_dir)
    )
    assert [
        path.name
        for path in (research_dir, backtest_dir, gates_dir, paper_dir, rollout_dir)
    ] == [
        "research",
        "backtest",
        "gates",
        "paper-candidate",
        "rollout",
    ]
    gate_report_path = _write_json(output_dir / "gates" / "gate-report.json", {})
    fallback_governance = phase_payloads.coalesce_governance_context(
        governance_inputs=None,
        governance_repository=None,
        governance_base=None,
        governance_head=None,
        governance_artifact_path=None,
        design_doc=None,
        priority_id=None,
        now=now,
    )
    assert fallback_governance["execution_context"]["repository"] == "proompteng/lab"
    assert fallback_governance["execution_context"]["base"] == "main"
    assert fallback_governance["execution_context"]["head"].startswith(
        "agentruns/torghut-autonomy-"
    )
    promotion_check = SimpleNamespace(
        allowed=False,
        missing_artifacts=["a"],
        required_artifacts=["a"],
        artifact_refs=[],
        required_throughput={"signals": 1},
        observed_throughput={"signals": 0},
        reasons=["missing"],
    )
    rollback_check = SimpleNamespace(
        ready=False,
        missing_checks=["kill"],
        required_checks=["kill"],
        reasons=["missing_kill"],
    )

    payload = phase_payloads.build_phase_manifest(
        run_id="run-1",
        candidate_id="cand-1",
        evaluated_at=now,
        output_dir=output_dir,
        signals=[
            SignalEnvelope(
                event_ts=now,
                symbol="BTC",
                payload={},
                timeframe="1m",
            )
        ],
        requested_promotion_target="live",
        gate_report=_gate_report(now, allowed=False),
        gate_report_payload={
            "gates": [
                {"gate_id": "", "status": "pass"},
                {"gate_id": "gate-1", "status": "", "reasons": ["gap"]},
            ],
            "throughput": {"signal_count": True, "decision_count": "bad"},
        },
        gate_report_path=gate_report_path,
        promotion_check=promotion_check,
        rollback_check=rollback_check,
        drift_gate_check={"allowed": False, "artifact_refs": [" drift.json ", ""]},
        patch_path=None,
        recommended_mode="shadow",
        promotion_reasons=["blocked"],
        governance_inputs={
            "execution_context": {"repository": "repo", "base": "main", "head": "head"},
            "runtime_governance": {
                "rollback_triggered": True,
                "artifact_refs": ["runtime.json"],
            },
            "rollback_proof": {"rollback_incident_evidence": "incident.json"},
        },
        drift_promotion_evidence={"evidence_artifact_refs": ["evidence.json", ""]},
    )

    phase_names = [phase["name"] for phase in payload["phases"]]
    assert phase_names == list(LANE_AUTONOMY_PHASE_ORDER)
    assert payload["status"] == "fail"
    assert (
        payload["runtime_governance"]["rollback_incident_evidence_path"]
        == "incident.json"
    )
    assert "incident.json" in payload["artifact_refs"]
    assert phase_payloads.coerce_int(True) == 1
    assert phase_payloads.coerce_int(2.9) == 2
    assert phase_payloads.coerce_int("bad", default=7) == 7
    assert phase_payloads.coerce_path_strings({"b", "", "a"}) == ["a", "b"]
    assert phase_payloads.coerce_path_strings("bad") == []
    assert phase_payloads.coerce_gate_phase_gates("bad") == []
    assert phase_payloads.coerce_gate_phase_gates(
        [
            {"gate_id": "", "status": "pass"},
            {"gate_id": "gate-2", "status": "", "value": 1},
        ]
    ) == [
        {
            "id": "gate-2",
            "status": "fail",
            "reasons": [],
            "value": 1,
            "threshold": None,
        }
    ]
    recommendation = PromotionRecommendation(
        action="promote",
        requested_mode="live",
        recommended_mode="paper",
        eligible=True,
        rationale="ok",
        reasons=[],
        evidence=PromotionEvidenceSummary(
            fold_metrics_count=1,
            stress_metrics_count=1,
            rationale_present=True,
            evidence_complete=True,
            reasons=[],
        ),
        trace_id="rec-trace",
    )
    actuation_payload = phase_payloads.build_actuation_intent_payload(
        run_id="run-1",
        candidate_id="cand-1",
        generated_at=now,
        recommendation_trace_id="rec-trace",
        gate_report_trace_id="gate-trace",
        promotion_target="live",
        recommended_mode="paper",
        actuation_allowed=True,
        promotion_check={"artifact_refs": ["promotion.json"]},
        rollback_check={"missing_checks": ["kill"]},
        candidate_state_payload={
            "rollbackReadiness": {
                "killSwitchDryRunPassed": True,
                "gitopsRevertDryRunPassed": True,
                "strategyDisableDryRunPassed": True,
                "humanApproved": True,
                "rollbackTarget": "v1",
                "dryRunCompletedAt": now.isoformat(),
            }
        },
        gate_report_path=gate_report_path,
        rollback_check_path=output_dir / "gates" / "rollback-readiness.json",
        candidate_spec_path=output_dir / "research" / "candidate-spec.json",
        candidate_generation_manifest_path=output_dir / "research" / "manifest.json",
        evaluation_manifest_path=output_dir / "backtest" / "evaluation-manifest.json",
        recommendation_manifest_path=output_dir
        / "rollout"
        / "recommendation-manifest.json",
        profitability_manifest_path=output_dir / "profitability" / "manifest.json",
        promotion_recommendation_path=output_dir / "rollout" / "recommendation.json",
        evaluation_report_path=output_dir / "backtest" / "evaluation-report.json",
        walk_results_path=output_dir / "backtest" / "walkforward-results.json",
        paper_patch_path=output_dir / "paper-candidate" / "patch.json",
        patch_required=True,
        profitability_benchmark_path=output_dir
        / "gates"
        / "profitability-benchmark.json",
        profitability_evidence_path=output_dir
        / "gates"
        / "profitability-evidence.json",
        profitability_validation_path=output_dir
        / "gates"
        / "profitability-validation.json",
        simulation_calibration_report_path=output_dir / "gates" / "simulation.json",
        shadow_live_deviation_report_path=output_dir / "gates" / "shadow.json",
        benchmark_parity_path=output_dir / "gates" / "benchmark.json",
        foundation_router_parity_path=output_dir / "gates" / "foundation.json",
        deeplob_bdlob_report_path=output_dir / "gates" / "deeplob.json",
        advisor_fallback_slo_report_path=output_dir / "gates" / "advisor.json",
        janus_event_car_path=output_dir / "gates" / "janus-event.json",
        janus_hgrm_reward_path=output_dir / "gates" / "janus-reward.json",
        recalibration_report_path=output_dir / "gates" / "recalibration.json",
        promotion_gate_path=output_dir / "gates" / "promotion-gate.json",
        promotion_recommendation=recommendation,
        recommendations=["promote"],
        governance_repository="proompteng/lab",
        governance_base="main",
        governance_head="codex/test",
        governance_artifact_path=str(output_dir),
        priority_id="prio",
        governance_change="promote",
        governance_reason="validated",
        stage_lineage_payload={"stages": {}},
        replay_artifact_hashes={"a": "b"},
        candidate_hash="candidate-hash",
    )
    assert actuation_payload["confirmation_phrase_required"] is True
    assert (
        actuation_payload["audit"]["rollback_readiness_readout"]["rollback_target"]
        == "v1"
    )
    assert "promotion.json" in actuation_payload["artifact_refs"]
    assert (
        phase_payloads.candidate_state_readiness_payload({"rollbackReadiness": []})
        == {}
    )
    assert lane_common.coerce_evidence_bool(True) is True
    assert lane_common.coerce_evidence_bool(float("nan")) is None
    assert lane_common.coerce_evidence_bool("yes") is True
    assert lane_common.coerce_evidence_bool("no") is False
    assert lane_common.coerce_evidence_bool("maybe") is None
    assert lane_common.safe_int("bad") == 0
    assert lane_common.as_object_dict(None) == {}
    assert lane_common.ensure_utc(datetime(2026, 1, 1)).tzinfo is not None
    assert str(lane_common.default_strategy_configmap_path()).endswith(
        "argocd/applications/torghut/strategy-configmap.yaml"
    )


def test_upsert_no_signal_run_updates_existing_research_run(
    tmp_path: Path, monkeypatch: Any
) -> None:
    engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        future=True,
        connect_args={"check_same_thread": False},
    )
    Base.metadata.create_all(engine)
    session_factory = sessionmaker(bind=engine, expire_on_commit=False, future=True)
    monkeypatch.setattr(
        lane_persistence,
        "load_runtime_strategy_config",
        lambda _path: [
            _runtime_strategy(
                "strategy-a",
                strategy_type="legacy_macd_rsi",
                compiler_source="legacy_runtime",
            )
        ],
    )
    strategy_config_path = tmp_path / "strategy.yaml"
    gate_policy_path = tmp_path / "gate.yaml"
    strategy_config_path.write_text("strategies: []", encoding="utf-8")
    gate_policy_path.write_text("policy: {}", encoding="utf-8")
    query_start = datetime(2026, 1, 1, tzinfo=timezone.utc)
    query_end = datetime(2026, 1, 2, tzinfo=timezone.utc)

    run_id = lane.upsert_autonomy_no_signal_run(
        session_factory=session_factory,
        query_start=query_start,
        query_end=query_end,
        strategy_config_path=strategy_config_path,
        gate_policy_path=gate_policy_path,
        no_signal_reason="no fresh signals",
        now=datetime(2026, 1, 3, tzinfo=timezone.utc),
        code_version="v1",
    )
    updated_run_id = lane.upsert_autonomy_no_signal_run(
        session_factory=session_factory,
        query_start=query_start,
        query_end=query_end,
        strategy_config_path=strategy_config_path,
        gate_policy_path=gate_policy_path,
        no_signal_reason="no fresh signals",
        now=datetime(2026, 1, 4, tzinfo=timezone.utc),
        code_version="v2",
    )

    assert updated_run_id == run_id
    with session_factory() as session:
        run = session.execute(
            select(ResearchRun).where(ResearchRun.run_id == run_id)
        ).scalar_one()
    assert run.status == "skipped"
    assert run.strategy_id == "strategy-a"
    assert run.code_commit == "v2"
    assert run.dataset_snapshot_ref == "no_signal_window"
