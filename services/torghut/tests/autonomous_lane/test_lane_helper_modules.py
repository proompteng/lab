from __future__ import annotations

import json
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace
from typing import Any, cast

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from app.models import Base, ResearchRun
from app.trading.autonomy import lane
from app.trading.autonomy import lane_common
from app.trading.autonomy import lane_candidate_payloads as candidate_payloads
from app.trading.autonomy import lane_phase_payloads as phase_payloads
from app.trading.autonomy import lane_profitability_manifest as profitability_manifest
from app.trading.autonomy import lane_regime_artifacts as regime_artifacts
from app.trading.autonomy import lane_stage_artifacts as stage_artifacts
from app.trading.autonomy import lane_strategy_factory as strategy_factory
from app.trading.autonomy.gates import GateEvaluationReport, GateResult
from app.trading.autonomy.lane_common import (
    LANE_AUTONOMY_PHASE_ORDER,
    StageManifestRecord,
)
from app.trading.autonomy.policy_checks import RollbackReadinessResult
from app.trading.autonomy.runtime import StrategyRuntimeConfig
from app.trading.evaluation import WalkForwardDecision
from app.trading.features import SignalFeatures
from app.trading.models import SignalEnvelope, StrategyDecision
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


def _hmm_params(
    *,
    regime_id: str = "R2",
    posterior: dict[str, str] | None = None,
    entropy_band: str = "low",
    transition_shock: bool = False,
    stale: bool = False,
    fallback: bool = False,
) -> dict[str, object]:
    return {
        "schema_version": "hmm_regime_context_v1",
        "hmm_regime_id": regime_id,
        "hmm_state_posterior": posterior or {regime_id: "0.75"},
        "hmm_entropy": "0.42",
        "hmm_entropy_band": entropy_band,
        "hmm_predicted_next": "R3",
        "hmm_transition_shock": transition_shock,
        "hmm_duration_ms": 7,
        "hmm_guardrail": {
            "stale": stale,
            "fallback_to_defensive": fallback,
            "reason": "aging_output" if stale else None,
        },
        "hmm_artifact": {
            "model_id": "hmm-regime-v1",
            "feature_schema": "hmm-v1",
            "training_run_id": "train-1",
        },
    }


def _walk_decision(
    params: dict[str, object], *, event_second: int = 0
) -> WalkForwardDecision:
    event_ts = datetime(2026, 1, 1, 12, 0, event_second, tzinfo=timezone.utc)
    return WalkForwardDecision(
        decision=StrategyDecision(
            strategy_id="s1",
            symbol="BTC",
            event_ts=event_ts,
            timeframe="1m",
            action="buy",
            qty=Decimal("1"),
            params=params,
        ),
        features=SignalFeatures(
            macd=Decimal("1"),
            macd_signal=Decimal("0.5"),
            rsi=Decimal("45"),
            price=Decimal("100"),
            volatility=Decimal("0.1"),
        ),
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


def test_candidate_payload_helpers_normalize_runbooks_and_alpha_readiness(
    tmp_path: Path, monkeypatch: Any
) -> None:
    assert candidate_payloads.normalize_strategy_artifacts(["direct"]) == ["direct"]
    assert (
        candidate_payloads.normalize_strategy_artifacts({"kind": "ConfigMap"}) is None
    )
    assert (
        candidate_payloads.normalize_strategy_artifacts(
            {"kind": "ConfigMap", "data": {"strategies.yaml": 123}}
        )
        is None
    )
    assert (
        candidate_payloads.normalize_strategy_artifacts(
            {"kind": "ConfigMap", "data": {"strategies.yaml": "["}}
        )
        is None
    )

    configmap_path = tmp_path / "strategy-configmap.yaml"
    configmap_path.write_text(
        "kind: ConfigMap\n"
        "data:\n"
        "  strategies.yaml: |\n"
        "    strategies:\n"
        "      - id: s1\n",
        encoding="utf-8",
    )
    assert candidate_payloads.is_runbook_valid(configmap_path)
    missing_path = tmp_path / "missing.yaml"
    assert not candidate_payloads.is_runbook_valid(missing_path)
    scalar_path = tmp_path / "scalar.yaml"
    scalar_path.write_text("not-a-strategy-list", encoding="utf-8")
    assert not candidate_payloads.is_runbook_valid(scalar_path)
    empty_config_path = tmp_path / "empty-config.yaml"
    empty_config_path.write_text("strategies: []", encoding="utf-8")
    assert not candidate_payloads.is_runbook_valid(empty_config_path)
    list_config_path = tmp_path / "list-config.yaml"
    list_config_path.write_text("- id: s1\n", encoding="utf-8")
    assert candidate_payloads.is_runbook_valid(list_config_path)

    state_payload = candidate_payloads.build_candidate_state_payload(
        candidate_id="cand-1",
        run_id="run-1",
        promotion_target="live",
        approval_token=None,
        runtime_strategies=[],
        now=datetime(2026, 1, 1, tzinfo=timezone.utc),
        code_version="",
        runbook_validated=False,
        dependency_quorum_payload={"decision": "block"},
        alpha_readiness_payload={"promotion_eligible": False},
    )
    assert state_payload["rollbackReadiness"]["rollbackTarget"] == "unknown"
    assert state_payload["rollbackReadiness"]["gitopsRevertDryRunPassed"] is False

    registry = SimpleNamespace(
        loaded=False,
        errors=["parse_failed"],
        path="registry.yaml",
        items=[SimpleNamespace(strategy_family="mapped_family", hypothesis_id="hyp-1")],
    )
    quorum = SimpleNamespace(
        decision="block",
        as_payload=lambda: {"decision": "block", "required": ["jangar"]},
    )
    monkeypatch.setattr(
        candidate_payloads, "load_hypothesis_registry", lambda: registry
    )
    monkeypatch.setattr(
        candidate_payloads,
        "resolve_hypothesis_dependency_quorum",
        lambda _registry: quorum,
    )

    readiness, dependency_quorum = (
        candidate_payloads.build_candidate_alpha_readiness_payload(
            runtime_strategies=[
                _runtime_strategy("s1", strategy_type="mapped_family"),
                _runtime_strategy("s2", strategy_type="unmapped_family"),
                _runtime_strategy("s3", strategy_type=" "),
            ]
        )
    )

    assert dependency_quorum == {"decision": "block", "required": ["jangar"]}
    assert readiness["promotion_eligible"] is False
    assert readiness["matched_hypothesis_ids"] == ["hyp-1"]
    assert readiness["missing_strategy_families"] == ["unmapped_family"]
    assert readiness["reasons"] == [
        "hypothesis_registry_unavailable",
        "hypothesis_registry_errors_present",
        "strategy_family_hypothesis_unmapped",
        "jangar_dependency_quorum_block",
    ]


def test_stage_artifact_helpers_cover_payload_authority_and_notes(
    tmp_path: Path,
) -> None:
    artifact_root = tmp_path / "artifacts"
    artifact_root.mkdir()
    source = _write_json(
        artifact_root / "research" / "candidate.json",
        {"schema_version": "candidate-v1", "status": "pass"},
    )
    output = _write_json(
        artifact_root / "gates" / "benchmark-parity.json",
        {"schema_version": "benchmark-v1"},
    )
    record = stage_artifacts.write_stage_manifest(
        stage="research",
        stage_index=1,
        stage_output_dir=artifact_root,
        run_id="run-1",
        candidate_id="cand-1",
        lineage_parent_hash=None,
        lineage_parent_stage=None,
        inputs={"source": "fixture"},
        input_artifacts={"source": source},
        output_artifacts={"benchmark": output},
        created_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
    )
    assert (
        stage_artifacts.artifact_hashes({"missing": artifact_root / "missing.json"})
        == {}
    )
    notes_dir = artifact_root / "notes"
    notes_dir.mkdir()
    (notes_dir / "iteration-2.md").write_text("old", encoding="utf-8")
    (notes_dir / "iteration-draft.md").write_text("ignored", encoding="utf-8")
    assert stage_artifacts.readable_notes_iteration_number(notes_dir) == 3

    lineage = stage_artifacts.build_stage_lineage_payload(
        [record], {"research": artifact_root / "research-manifest.json"}
    )
    assert lineage["root_lineage_hash"] == record.lineage_hash
    assert (
        stage_artifacts.build_stage_lineage_payload([], {})["root_lineage_hash"] is None
    )
    assert (
        stage_artifacts.manifest_relative_path(artifact_root, output)
        == "gates/benchmark-parity.json"
    )
    assert stage_artifacts.manifest_relative_path(
        artifact_root, tmp_path.parent / "external.json"
    ).endswith("external.json")

    scaffold = stage_artifacts.artifact_authority_for_check(
        stage_name="execution", check_name="benchmark_parity_present"
    )
    replay = stage_artifacts.artifact_authority_for_check(
        stage_name="validation", check_name="evaluation_report_present"
    )
    assert scaffold is not None and scaffold["placeholder"] is True
    assert replay is not None and replay["calibration_summary"]["stage"] == "validation"
    assert (
        stage_artifacts.artifact_authority_for_check(
            stage_name="x", check_name="unknown"
        )
        is None
    )
    assert (
        stage_artifacts.artifact_authority_for_evidence("janus_q")["placeholder"]
        is True
    )
    assert (
        stage_artifacts.artifact_authority_for_evidence("custom")[
            "calibration_summary"
        ]["evidence_name"]
        == "custom"
    )

    payload_path = _write_json(
        tmp_path / "empirical.json", {"schema_version": "expected"}
    )
    loaded_payload = stage_artifacts.load_configured_empirical_payload(
        path_value=str(payload_path),
        expected_schema_version="expected",
        evidence_name="empirical",
    )
    assert loaded_payload is not None
    assert loaded_payload["artifact_authority"]["authoritative"] is True
    assert (
        stage_artifacts.load_configured_empirical_payload(
            path_value=None,
            expected_schema_version=None,
            evidence_name="missing",
        )
        is None
    )
    assert str(stage_artifacts.resolve_optional_service_path("relative.json")).endswith(
        "services/torghut/relative.json"
    )
    with pytest.raises(RuntimeError, match="schema_mismatch"):
        stage_artifacts.load_configured_empirical_payload(
            path_value=str(payload_path),
            expected_schema_version="other",
            evidence_name="empirical",
        )
    invalid_payload = _write_json(tmp_path / "empirical-list.json", ["bad"])
    with pytest.raises(RuntimeError, match="configured_empirical_payload_invalid"):
        stage_artifacts.load_configured_empirical_payload(
            path_value=str(invalid_payload),
            expected_schema_version=None,
            evidence_name="empirical",
        )

    janus_summary = stage_artifacts.build_janus_q_summary_from_payloads(
        event_car_payload={"schema_version": "event", "summary": {"event_count": 0}},
        hgrm_reward_payload={
            "schema_version": "reward",
            "summary": {
                "reward_count": 2,
                "event_mapped_count": 1,
                "direction_gate_pass_ratio": "0.5",
            },
        },
        event_car_artifact_ref="event.json",
        hgrm_reward_artifact_ref="reward.json",
    )
    assert janus_summary["evidence_complete"] is False
    assert janus_summary["reasons"] == [
        "janus_event_count_missing",
        "janus_reward_event_mapping_incomplete",
    ]
    empty_janus_summary = stage_artifacts.build_janus_q_summary_from_payloads(
        event_car_payload={"summary": {"event_count": 1}},
        hgrm_reward_payload={"summary": {"reward_count": 0}},
        event_car_artifact_ref="event.json",
        hgrm_reward_artifact_ref="reward.json",
    )
    assert empty_janus_summary["reasons"] == ["janus_reward_count_missing"]
    bridge_payload = stage_artifacts.build_bridge_evidence_payload(
        {"schema_version": "bridge", "status": "pass", "summary": {"x": 1}},
        artifact_ref="bridge.json",
        summary_fields=["summary", "missing"],
    )
    assert bridge_payload["artifact_authority"] == {}
    assert bridge_payload["summary"] == {"x": 1}

    artifact_payload = stage_artifacts.manifest_artifact_payload(
        artifact_root,
        output,
        "execution",
        "benchmark_parity_present",
    )
    assert artifact_payload is not None
    assert artifact_payload["artifact_authority"]["placeholder"] is True
    assert (
        stage_artifacts.manifest_artifact_payload(artifact_root, None, "x", "y") is None
    )
    bad_json_path = artifact_root / "bad.json"
    bad_json_path.write_text("{", encoding="utf-8")
    assert stage_artifacts.load_json_if_exists(bad_json_path) is None
    list_json_path = _write_json(artifact_root / "list.json", ["not-object"])
    assert stage_artifacts.load_json_if_exists(list_json_path) is None

    notes_path = stage_artifacts.write_iteration_notes(
        artifact_root=artifact_root,
        run_id="run-1",
        candidate_id="cand-1",
        stage_records=[
            record,
            StageManifestRecord(
                stage="validation",
                stage_index=2,
                stage_trace_id="trace-2",
                lineage_hash="hash-2",
                artifact_hashes={},
                stage_payload_hash="hash-2",
                created_at="2026-01-01T00:00:00+00:00",
                parent_lineage_hash=record.lineage_hash,
                parent_stage=record.stage,
            ),
        ],
        repository="proompteng/lab",
        base="main",
        head="codex/test",
        priority_id="prio-1",
    )
    notes_text = notes_path.read_text(encoding="utf-8")
    assert "- repository: proompteng/lab" in notes_text
    assert "parent: research" in notes_text
    assert stage_artifacts.extract_janus_q_metrics(
        {
            "event_car": {"event_count": "3"},
            "hgrm_reward": {"reward_count": "2"},
            "reasons": ["", "gap"],
        }
    ) == (3, 2, False, ["gap"])
    vnext_summary = stage_artifacts.build_vnext_gate_summary(
        runtime_strategies=[
            _runtime_strategy(
                "s1",
                symbols=["BTC", ""],
                promotion_metadata={
                    "promotion_policy_ref": "policy-a",
                    "risk_profile_ref": "risk-a",
                    "sizing_policy_ref": "sizing-a",
                    "execution_policy_ref": "exec-a",
                },
            ),
            _runtime_strategy("s2", symbols=["btc", "ETH"]),
        ],
        simulation_calibration_payload={
            "schema_version": "simulation-v1",
            "status": "pass",
            "order_count": 12,
            "ignored": "field",
        },
        shadow_live_deviation_payload={
            "schema_version": "shadow-v1",
            "status": "pass",
            "trade_count": 4,
        },
        dependency_quorum_payload={"decision": "allow"},
        hypothesis_registry_payload={"loaded": True},
    )
    portfolio = vnext_summary["portfolio_promotion"]
    assert portfolio["mode"] == "portfolio_aware"
    assert portfolio["overlapping_symbols"] == ["BTC"]
    assert portfolio["missing_policy_refs"] == [
        "s2:execution_policy_ref",
        "s2:promotion_policy_ref",
        "s2:risk_profile_ref",
        "s2:sizing_policy_ref",
    ]
    assert vnext_summary["dependency_quorum"] == {"decision": "allow"}


def test_regime_artifacts_cover_hmm_and_expert_router_paths(tmp_path: Path) -> None:
    now = datetime(2026, 1, 1, tzinfo=timezone.utc)
    output_dir = tmp_path / "lane"
    output_dir.mkdir()
    walkforward_path = _write_json(output_dir / "backtest" / "walkforward.json", {})
    gate_policy_path = _write_json(output_dir / "gates" / "policy.json", {})
    strategy_config_path = _write_json(output_dir / "config" / "strategies.yaml", {})
    hmm_path = _write_json(output_dir / "gates" / "hmm.json", {})

    contamination = regime_artifacts.build_contamination_registry_payload(
        output_dir=output_dir,
        run_id="run-1",
        candidate_id="cand-1",
        now=now,
        artifact_refs=[walkforward_path, tmp_path / "outside.json"],
    )
    assert contamination["status"] == "pass"
    assert "artifact_hash" in contamination
    assert regime_artifacts.normalize_hmm_regime_id("  ") == "unknown"

    decisions = [
        _walk_decision(
            _hmm_params(regime_id="R2", posterior={"R2": "0.75"}),
            event_second=1,
        ),
        _walk_decision(
            _hmm_params(
                regime_id="R3",
                posterior={"R3": "Infinity"},
                entropy_band="high",
                transition_shock=True,
                stale=True,
            ),
            event_second=2,
        ),
    ]
    hmm_payload = regime_artifacts.build_hmm_state_posterior_payload(
        output_dir=output_dir,
        run_id="run-1",
        candidate_id="cand-1",
        now=now,
        walk_decisions=decisions,
        walkforward_results_path=walkforward_path,
        gate_policy_path=gate_policy_path,
    )
    assert hmm_payload["samples_total"] == 2
    assert hmm_payload["authoritative_samples"] == 1
    assert hmm_payload["transition_shock_samples"] == 1
    assert hmm_payload["stale_or_defensive_samples"] == 1
    assert hmm_payload["top_regime_by_posterior_mass"] == "r2"

    assert regime_artifacts.decimal_or_zero("NaN") == Decimal("0")
    assert regime_artifacts.decimal_or_none("Infinity") is None
    assert regime_artifacts.normalize_expert_weights({})["defensive"] == Decimal("0.80")

    context = regime_artifacts.resolve_hmm_context(_hmm_params())
    assert (
        regime_artifacts.build_expert_router_weights(
            regime_label="trend", context=context
        )[1]
        is False
    )
    assert (
        regime_artifacts.build_expert_router_weights(
            regime_label="breakout", context=context
        )[0]["breakout"]
        > 0
    )
    assert (
        regime_artifacts.build_expert_router_weights(
            regime_label="reversal", context=context
        )[0]["reversal"]
        > 0
    )
    assert (
        regime_artifacts.build_expert_router_weights(
            regime_label="stress", context=context
        )[0]["defensive"]
        > 0
    )
    assert (
        regime_artifacts.build_expert_router_weights(
            regime_label="unknown", context=context
        )[0]["trend"]
        > 0
    )
    high_entropy_context = regime_artifacts.resolve_hmm_context(
        _hmm_params(entropy_band="high")
    )
    assert (
        regime_artifacts.build_expert_router_weights(
            regime_label="unknown", context=high_entropy_context
        )[1]
        is True
    )

    registry_payload = regime_artifacts.build_expert_router_registry_payload(
        output_dir=output_dir,
        run_id="run-1",
        candidate_id="cand-1",
        now=now,
        walk_decisions=decisions,
        walkforward_results_path=walkforward_path,
        gate_policy_path=gate_policy_path,
        strategy_config_path=strategy_config_path,
        hmm_state_posterior_path=hmm_path,
        policy_payload={
            "promotion_expert_router_max_fallback_rate": "0.01",
            "promotion_expert_router_max_expert_concentration": "0.10",
        },
    )
    assert registry_payload["slo_feedback"]["overall_status"] == "fail"
    assert registry_payload["slo_feedback"]["reasons"] == [
        "fallback_rate_exceeds_threshold",
        "expert_concentration_exceeds_threshold",
    ]
    empty_registry_payload = regime_artifacts.build_expert_router_registry_payload(
        output_dir=output_dir,
        run_id="run-empty",
        candidate_id="cand-empty",
        now=now,
        walk_decisions=[],
        walkforward_results_path=walkforward_path,
        gate_policy_path=gate_policy_path,
        strategy_config_path=strategy_config_path,
        hmm_state_posterior_path=hmm_path,
        policy_payload={},
    )
    assert empty_registry_payload["slo_feedback"]["reasons"] == [
        "router_decisions_missing"
    ]


def test_strategy_factory_helpers_cover_bridge_and_gate_decisions(
    tmp_path: Path, monkeypatch: Any
) -> None:
    assert (
        strategy_factory.build_strategy_factory_bridge(
            output_dir=tmp_path,
            notes_artifact_root=None,
            train_prices_path=None,
            test_prices_path=tmp_path / "test.csv",
            alpha_gate_policy_path=None,
            repository=None,
            base=None,
            head=None,
            priority_id=None,
            promotion_target="paper",
            now=datetime(2026, 1, 1, tzinfo=timezone.utc),
        )
        is None
    )

    result_paths = {
        name: _write_json(tmp_path / f"{name}.json", payload)
        for name, payload in {
            "candidate": {
                "strategy_factory": {
                    "economic_validity_card": {"status": "pass"},
                    "null_comparator_summary": {"baseline_outperformed": True},
                    "posterior_edge_summary": {"edge_bps": "2"},
                }
            },
            "evaluation": {"status": "pass"},
            "recommendation": {"recommendation": {"eligible": True}},
            "attempt": {"status": "pass"},
            "sequential": {"status": "paper_ready"},
            "cost": {"status": "calibrated"},
            "candidate_generation_manifest": {},
            "evaluation_manifest": {},
            "recommendation_manifest": {},
            "validation": {"status": "pass"},
        }.items()
    }
    fake_result = SimpleNamespace(
        candidate_spec_path=result_paths["candidate"],
        evaluation_report_path=result_paths["evaluation"],
        recommendation_artifact_path=result_paths["recommendation"],
        attempt_ledger_path=result_paths["attempt"],
        sequential_trial_path=result_paths["sequential"],
        cost_calibration_path=result_paths["cost"],
        candidate_generation_manifest_path=result_paths[
            "candidate_generation_manifest"
        ],
        evaluation_manifest_path=result_paths["evaluation_manifest"],
        recommendation_manifest_path=result_paths["recommendation_manifest"],
        validation_artifact_paths={
            "present": result_paths["validation"],
            "missing": tmp_path / "missing-validation.json",
        },
    )
    monkeypatch.setattr(strategy_factory, "_load_price_frame", lambda _path: object())
    monkeypatch.setattr(
        strategy_factory, "run_alpha_discovery_lane", lambda **_kwargs: fake_result
    )
    bridge = strategy_factory.build_strategy_factory_bridge(
        output_dir=tmp_path,
        notes_artifact_root="notes",
        train_prices_path=tmp_path / "train.csv",
        test_prices_path=tmp_path / "test.csv",
        alpha_gate_policy_path=None,
        repository="proompteng/lab",
        base="main",
        head="codex/test",
        priority_id="prio",
        promotion_target="live",
        now=datetime(2026, 1, 1, tzinfo=timezone.utc),
    )
    assert bridge is not None
    assert sorted(bridge.validation_payloads) == ["present"]
    allowed, reasons, summary = strategy_factory.strategy_factory_gate_summary(
        bridge, promotion_target="live"
    )
    assert allowed is True
    assert reasons == []
    assert summary["cost_calibration_status"] == "calibrated"

    failing_bridge = strategy_factory.StrategyFactoryBridge(
        result=cast(Any, fake_result),
        candidate_spec_payload={
            "strategy_factory": {
                "economic_validity_card": {"status": "fail"},
                "null_comparator_summary": {"baseline_outperformed": False},
            }
        },
        evaluation_payload={},
        recommendation_payload={"recommendation": {"eligible": False}},
        attempt_payload={},
        validation_payloads={},
        sequential_trial_payload={"status": "paper_only"},
        cost_calibration_payload={"status": "estimated"},
    )
    allowed, reasons, _summary = strategy_factory.strategy_factory_gate_summary(
        failing_bridge, promotion_target="live"
    )
    assert allowed is False
    assert reasons == [
        "strategy_factory_recommendation_not_eligible",
        "strategy_factory_economic_validity_failed",
        "strategy_factory_baseline_not_outperformed",
        "strategy_factory_live_requires_paper_ready",
        "strategy_factory_live_requires_calibrated_costs",
    ]
    _paper_allowed, paper_reasons, _paper_summary = (
        strategy_factory.strategy_factory_gate_summary(
            strategy_factory.StrategyFactoryBridge(
                result=cast(Any, fake_result),
                candidate_spec_payload={
                    "strategy_factory": {
                        "economic_validity_card": {"status": "pass"},
                        "null_comparator_summary": {"baseline_outperformed": True},
                    }
                },
                evaluation_payload={},
                recommendation_payload={"recommendation": {"eligible": True}},
                attempt_payload={},
                validation_payloads={},
                sequential_trial_payload={"status": "draft"},
                cost_calibration_payload={"status": "estimated"},
            ),
            promotion_target="paper",
        )
    )
    assert paper_reasons == ["strategy_factory_sequential_not_ready"]
    assert strategy_factory.strategy_factory_artifact_refs(None) == []
    assert len(strategy_factory.strategy_factory_artifact_refs(bridge)) == 11
    price_csv = tmp_path / "prices.csv"
    price_csv.write_text("date,A\n2026-01-01,1\n", encoding="utf-8")
    assert list(strategy_factory.load_price_frame(price_csv).columns) == ["A"]


def test_profitability_manifest_aggregates_failures_and_replay_hashes(
    tmp_path: Path,
) -> None:
    output_dir = tmp_path / "lane"
    now = datetime(2026, 1, 1, tzinfo=timezone.utc)
    paths = {
        name: _write_json(output_dir / rel, {"schema_version": name, "status": "pass"})
        for name, rel in {
            "walkforward": "backtest/walkforward-results.json",
            "baseline": "backtest/baseline-evaluation-report.json",
            "benchmark": "gates/profitability-benchmark-v4.json",
            "contamination": "gates/contamination-leakage-report-v1.json",
            "benchmark_parity": "gates/benchmark-parity-report-v1.json",
            "foundation_router": "gates/foundation-router-parity-report-v1.json",
            "deeplob": "gates/deeplob-bdlob-report-v1.json",
            "advisor": "gates/advisor-fallback-slo-report-v1.json",
            "profitability_evidence": "gates/profitability-evidence-v4.json",
            "simulation": "gates/simulation-calibration.json",
            "shadow": "gates/shadow-live-deviation.json",
            "hmm": "gates/hmm-state-posterior-v1.json",
            "expert_router": "gates/expert-router-registry-v1.json",
            "janus_event": "gates/janus-event-car-v1.json",
            "janus_reward": "gates/janus-hgrm-reward-v1.json",
            "recalibration": "gates/recalibration-report.json",
            "gate": "gates/gate-report.json",
            "rollback": "gates/rollback-readiness.json",
        }.items()
    }
    invalid_validation = output_dir / "gates" / "profitability-evidence-validation.json"
    invalid_validation.parent.mkdir(parents=True, exist_ok=True)
    invalid_validation.write_text("{", encoding="utf-8")

    payload = profitability_manifest.build_profitability_stage_manifest(
        output_dir=output_dir,
        run_id="run-1",
        candidate_id="cand-1",
        strategy_family="legacy",
        llm_artifact_ref=None,
        router_artifact_ref="router.json",
        run_context={"repository": "proompteng/lab", "run_id": "run-ctx"},
        research_manifest_path=output_dir / "research" / "missing-manifest.json",
        candidate_spec_path=output_dir / "research" / "missing-candidate.json",
        evaluation_report_path=output_dir / "backtest" / "missing-evaluation.json",
        walkforward_results_path=paths["walkforward"],
        baseline_evaluation_report_path=paths["baseline"],
        gate_report_payload={"promotion_allowed": False},
        gate_report_path=paths["gate"],
        profitability_benchmark_path=paths["benchmark"],
        contamination_registry_path=paths["contamination"],
        benchmark_parity_path=paths["benchmark_parity"],
        foundation_router_parity_path=paths["foundation_router"],
        deeplob_bdlob_report_path=paths["deeplob"],
        advisor_fallback_slo_report_path=paths["advisor"],
        profitability_evidence_path=paths["profitability_evidence"],
        profitability_validation_path=invalid_validation,
        simulation_calibration_report_path=paths["simulation"],
        shadow_live_deviation_report_path=paths["shadow"],
        hmm_state_posterior_path=paths["hmm"],
        expert_router_registry_path=paths["expert_router"],
        janus_event_car_path=paths["janus_event"],
        janus_hgrm_reward_path=paths["janus_reward"],
        recalibration_report_path=paths["recalibration"],
        rollback_check=RollbackReadinessResult(
            ready=False,
            reasons=["kill_switch_missing"],
            required_checks=["kill_switch"],
            missing_checks=["kill_switch"],
        ),
        drift_gate_check={"allowed": False},
        patch_path=None,
        now=now,
    )

    assert payload["overall_status"] == "fail"
    assert "candidate_spec_present" in payload["failure_reasons"]
    assert "profitability_validation_payload_valid_json" in payload["failure_reasons"]
    assert "gate_matrix_approval" in payload["failure_reasons"]
    assert payload["stages"]["governance"]["artifacts"]["rollback_readiness"][
        "path"
    ] == ("gates/rollback-readiness.json")
    assert payload["replay_contract"]["artifact_hashes"]
    assert payload["content_hash"]


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
        lane,
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
