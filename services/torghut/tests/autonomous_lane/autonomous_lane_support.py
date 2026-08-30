from __future__ import annotations

import hashlib
import json
import os
import tempfile
from datetime import datetime, timezone, timedelta
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from unittest import TestCase
import pandas as pd
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from typing import Any

from scripts import run_autonomous_lane as run_autonomous_lane_script
from app.trading.autonomy.lane import (
    _AUTONOMY_PHASE_ORDER,
    _deterministic_run_id,
    _build_phase_manifest,
    _persist_hypothesis_governance_rows,
    _STRESS_METRICS_CASES,
    _resolve_paper_patch_path,
    _resolve_gate_forecast_metrics,
    _resolve_gate_fragility_inputs,
    _resolve_hypothesis_window_evidence,
    run_autonomous_lane,
    upsert_autonomy_no_signal_run,
)
from app.trading.autonomy.policy_checks import (
    PromotionPrerequisiteResult,
    RollbackReadinessResult,
)
from app.trading.autonomy.phase_manifest_contract import (
    coerce_phase_status,
    build_runtime_and_rollback_governance_payloads,
    build_phase_manifest_payload_with_runtime_and_rollback,
    build_rollback_proof_phase,
    build_runtime_governance_phase,
    required_slo_gate_ids,
    normalize_phase_manifest_phases,
)
from app.trading.autonomy.gates import GateEvaluationReport, GateResult
from app.trading.evaluation import WalkForwardDecision
from app.trading.parity import (
    BENCHMARK_PARITY_REQUIRED_FAMILIES,
    BENCHMARK_PARITY_REQUIRED_RUN_FIELDS,
    BENCHMARK_PARITY_REQUIRED_SCORECARDS,
    BENCHMARK_PARITY_SCHEMA_VERSION,
)
from app.trading.features import SignalFeatures
from app.trading.models import SignalEnvelope, StrategyDecision
from app.trading.reporting import PromotionEvidenceSummary, PromotionRecommendation
from app.models import (
    Base,
    ResearchAttempt,
    ResearchCandidate,
    ResearchCostCalibration,
    ResearchFoldMetrics,
    ResearchPromotion,
    ResearchRun,
    ResearchSequentialTrial,
    ResearchStressMetrics,
    ResearchValidationTest,
    StrategyCapitalAllocation,
    StrategyHypothesis,
    StrategyHypothesisMetricWindow,
    StrategyHypothesisVersion,
    StrategyPromotionDecision,
    VNextCompletionGateResult,
    VNextDatasetSnapshot,
    VNextExperimentRun,
    VNextExperimentSpec,
    VNextFeatureViewSpec,
    VNextModelArtifact,
    VNextPromotionDecision,
    VNextShadowLiveDeviation,
    VNextSimulationCalibration,
)


class AutonomousLaneTestCaseBase(TestCase):
    def _artifact_sha256(self, path: Path) -> str:
        return hashlib.sha256(path.read_bytes()).hexdigest()

    def _empty_session_factory(self) -> sessionmaker:
        engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            future=True,
            connect_args={"check_same_thread": False},
        )
        Base.metadata.create_all(engine)
        return sessionmaker(bind=engine, expire_on_commit=False, future=True)

    def _write_alpha_price_csvs(self, root: Path) -> tuple[Path, Path]:
        index = pd.date_range("2025-01-01", periods=220, freq="D", tz="UTC")
        train = pd.DataFrame(
            {
                "AAPL": [100 + (i * 0.2) for i in range(180)],
                "MSFT": [200 + (i * 0.15) for i in range(180)],
            },
            index=index[:180],
        )
        test = pd.DataFrame(
            {
                "AAPL": [136 + (i * 0.25) for i in range(40)],
                "MSFT": [227 + (i * 0.20) for i in range(40)],
            },
            index=index[180:220],
        )
        train_path = root / "alpha-train.csv"
        test_path = root / "alpha-test.csv"
        train.to_csv(train_path)
        test.to_csv(test_path)
        return train_path, test_path


__all__: tuple[str, ...] = (
    "Any",
    "AutonomousLaneTestCaseBase",
    "BENCHMARK_PARITY_REQUIRED_FAMILIES",
    "BENCHMARK_PARITY_REQUIRED_RUN_FIELDS",
    "BENCHMARK_PARITY_REQUIRED_SCORECARDS",
    "BENCHMARK_PARITY_SCHEMA_VERSION",
    "Base",
    "Decimal",
    "GateEvaluationReport",
    "GateResult",
    "Path",
    "PromotionEvidenceSummary",
    "PromotionPrerequisiteResult",
    "PromotionRecommendation",
    "ResearchAttempt",
    "ResearchCandidate",
    "ResearchCostCalibration",
    "ResearchFoldMetrics",
    "ResearchPromotion",
    "ResearchRun",
    "ResearchSequentialTrial",
    "ResearchStressMetrics",
    "ResearchValidationTest",
    "RollbackReadinessResult",
    "SignalEnvelope",
    "SignalFeatures",
    "SimpleNamespace",
    "StrategyCapitalAllocation",
    "StrategyDecision",
    "StrategyHypothesis",
    "StrategyHypothesisMetricWindow",
    "StrategyHypothesisVersion",
    "StrategyPromotionDecision",
    "TestCase",
    "VNextCompletionGateResult",
    "VNextDatasetSnapshot",
    "VNextExperimentRun",
    "VNextExperimentSpec",
    "VNextFeatureViewSpec",
    "VNextModelArtifact",
    "VNextPromotionDecision",
    "VNextShadowLiveDeviation",
    "VNextSimulationCalibration",
    "WalkForwardDecision",
    "_AUTONOMY_PHASE_ORDER",
    "_STRESS_METRICS_CASES",
    "_build_phase_manifest",
    "_deterministic_run_id",
    "_persist_hypothesis_governance_rows",
    "_resolve_gate_forecast_metrics",
    "_resolve_gate_fragility_inputs",
    "_resolve_hypothesis_window_evidence",
    "_resolve_paper_patch_path",
    "build_phase_manifest_payload_with_runtime_and_rollback",
    "build_rollback_proof_phase",
    "build_runtime_and_rollback_governance_payloads",
    "build_runtime_governance_phase",
    "coerce_phase_status",
    "create_engine",
    "datetime",
    "hashlib",
    "json",
    "normalize_phase_manifest_phases",
    "os",
    "patch",
    "pd",
    "required_slo_gate_ids",
    "run_autonomous_lane",
    "run_autonomous_lane_script",
    "select",
    "sessionmaker",
    "tempfile",
    "timedelta",
    "timezone",
    "upsert_autonomy_no_signal_run",
)
