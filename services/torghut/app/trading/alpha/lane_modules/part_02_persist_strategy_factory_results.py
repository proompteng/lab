# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportPrivateUsage=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
"""Deterministic offline alpha discovery lane."""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any, Callable, Iterable, Literal, Mapping, Sequence, cast

import pandas as pd
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from ....models import (
    ResearchAttempt,
    ResearchCandidate,
    ResearchCostCalibration,
    ResearchFoldMetrics,
    ResearchPromotion,
    ResearchRun,
    ResearchSequentialTrial,
    ResearchStressMetrics,
    ResearchValidationTest,
)
from ...discovery import (
    build_sequential_trial_summary,
    build_strategy_factory_evaluation,
)
from ..metrics import summarize_equity_curve, to_jsonable
from ..search import SearchResult, candidate_to_jsonable, run_tsmom_grid_search
from ..tsmom import TSMOMConfig, backtest_tsmom
from ...reporting import (
    PromotionEvidenceSummary,
    build_promotion_recommendation,
)

# ruff: noqa: F401,F403,F405,F811,F821

from .part_01_alphalaneresult import *


def _persist_strategy_factory_results(
    *,
    session_factory: Callable[[], Session],
    run_id: str,
    candidate_id: str,
    now: datetime,
    requested_mode: Literal["shadow", "paper", "live"],
    resolved_repository: str | None,
    resolved_head: str | None,
    train: pd.DataFrame,
    test: pd.DataFrame,
    search_result: SearchResult,
    stage_lineage_payload: dict[str, Any],
    stage_trace_ids: dict[str, str],
    manifest_paths: Mapping[str, Path],
    replay_artifact_hashes: dict[str, str],
    recommendation_trace_id: str,
    strategy_factory_summary: dict[str, Any],
    validation_payloads: Mapping[str, dict[str, Any]],
    attempt_payload: dict[str, Any],
    cost_calibration_payload: dict[str, Any],
    sequential_trial_payload: dict[str, Any],
    evaluation_passed: bool,
    promotion_allowed: bool,
    recommendation_payload: dict[str, Any],
    recommendation_rationale: str,
) -> None:
    with session_factory() as session:
        session.execute(delete(ResearchAttempt).where(ResearchAttempt.run_id == run_id))
        for table in (
            ResearchValidationTest,
            ResearchSequentialTrial,
            ResearchStressMetrics,
            ResearchFoldMetrics,
            ResearchPromotion,
        ):
            session.execute(delete(table).where(table.candidate_id == candidate_id))
        session.execute(
            delete(ResearchCandidate).where(
                ResearchCandidate.candidate_id == candidate_id
            )
        )

        calibration_id = str(cost_calibration_payload["calibration_id"])
        session.execute(
            delete(ResearchCostCalibration).where(
                ResearchCostCalibration.calibration_id == calibration_id
            )
        )

        run_row = session.execute(
            select(ResearchRun).where(ResearchRun.run_id == run_id)
        ).scalar_one_or_none()
        dataset_from = (
            train.index.min().to_pydatetime()
            if isinstance(train.index, pd.DatetimeIndex) and len(train.index) > 0
            else None
        )
        dataset_to = (
            test.index.max().to_pydatetime()
            if isinstance(test.index, pd.DatetimeIndex) and len(test.index) > 0
            else None
        )
        search_budget = len(search_result.candidates)
        if run_row is None:
            run_row = ResearchRun(
                run_id=run_id,
                status="passed" if promotion_allowed or evaluation_passed else "failed",
                strategy_id="strategy_factory_alpha",
                strategy_name="strategy_factory_alpha",
                strategy_type=strategy_factory_summary["candidate_family"],
                strategy_version="alpha-lane-v2",
                code_commit=resolved_head,
                signal_source="alpha-search",
                dataset_from=dataset_from,
                dataset_to=dataset_to,
                runner_version="run_alpha_discovery_lane",
                runner_binary_hash=hashlib.sha256(run_id.encode("utf-8")).hexdigest(),
                recommendation_trace_id=recommendation_trace_id,
                discovery_mode="strategy_factory_alpha_v1",
                generator_family="tsmom_grid_v1",
                grammar_version="tsmom.dsl.v1",
                search_budget=search_budget,
                selection_protocol_version="alpha-selection-protocol-v1",
                pilot_program_id="torghut-strategy-factory-pilot-v1",
                kill_criteria_version="pilot-kill-criteria-v1",
            )
            session.add(run_row)
        else:
            run_row.status = (
                "passed" if promotion_allowed or evaluation_passed else "failed"
            )
            run_row.strategy_id = "strategy_factory_alpha"
            run_row.strategy_name = "strategy_factory_alpha"
            run_row.strategy_type = str(strategy_factory_summary["candidate_family"])
            run_row.strategy_version = "alpha-lane-v2"
            run_row.code_commit = resolved_head
            run_row.signal_source = "alpha-search"
            run_row.dataset_from = dataset_from
            run_row.dataset_to = dataset_to
            run_row.runner_version = "run_alpha_discovery_lane"
            run_row.runner_binary_hash = hashlib.sha256(
                run_id.encode("utf-8")
            ).hexdigest()
            run_row.recommendation_trace_id = recommendation_trace_id
            run_row.discovery_mode = "strategy_factory_alpha_v1"
            run_row.generator_family = "tsmom_grid_v1"
            run_row.grammar_version = "tsmom.dsl.v1"
            run_row.search_budget = search_budget
            run_row.selection_protocol_version = "alpha-selection-protocol-v1"
            run_row.pilot_program_id = "torghut-strategy-factory-pilot-v1"
            run_row.kill_criteria_version = "pilot-kill-criteria-v1"

        evidence_bundle = {
            "attempt_count": len(attempt_payload.get("attempts", [])),
            "validation_test_count": len(validation_payloads),
            "stage_lineage": stage_lineage_payload,
            "stage_trace_ids": dict(stage_trace_ids),
            "stage_manifest_refs": {
                key: str(value) for key, value in manifest_paths.items()
            },
            "replay_artifact_hashes": dict(replay_artifact_hashes),
            "cost_calibration": cost_calibration_payload,
            "sequential_trial": sequential_trial_payload,
            "strategy_factory": strategy_factory_summary,
        }
        candidate_row = ResearchCandidate(
            run_id=run_id,
            candidate_id=candidate_id,
            candidate_hash=str(strategy_factory_summary["semantic_hash"]),
            parameter_set=strategy_factory_summary["canonical_spec"],
            decision_count=int(test.shape[0]),
            trade_count=int(test.shape[0]),
            symbols_covered=[str(column) for column in test.columns],
            universe_definition={
                "repository": resolved_repository,
                "autonomy_lifecycle": {
                    "role": "challenger",
                    "status": "promoted_champion"
                    if promotion_allowed
                    else "retained_challenger",
                },
            },
            promotion_target=requested_mode,
            lifecycle_role="challenger",
            lifecycle_status="promoted" if promotion_allowed else "evaluated",
            metadata_bundle=evidence_bundle,
            recommendation_bundle=recommendation_payload["recommendation"],
            candidate_family=str(strategy_factory_summary["candidate_family"]),
            canonical_spec=strategy_factory_summary["canonical_spec"],
            semantic_hash=str(strategy_factory_summary["semantic_hash"]),
            economic_rationale=str(strategy_factory_summary["economic_rationale"]),
            complexity_score=_decimal_or_none(
                strategy_factory_summary["complexity_score"]
            ),
            discovery_rank=int(strategy_factory_summary["discovery_rank"]),
            posterior_edge_summary=strategy_factory_summary["posterior_edge_summary"],
            economic_validity_card=strategy_factory_summary["economic_validity_card"],
            valid_regime_envelope=strategy_factory_summary["valid_regime_envelope"],
            invalidation_clauses=strategy_factory_summary["invalidation_clauses"],
            null_comparator_summary=strategy_factory_summary["null_comparator_summary"],
        )
        session.add(candidate_row)

        fold_bundle = strategy_factory_summary["fold_stat_bundle"]
        train_start = (
            train.index.min().to_pydatetime()
            if isinstance(train.index, pd.DatetimeIndex) and len(train.index) > 0
            else now
        )
        train_end = (
            train.index.max().to_pydatetime()
            if isinstance(train.index, pd.DatetimeIndex) and len(train.index) > 0
            else now
        )
        test_start = (
            test.index.min().to_pydatetime()
            if isinstance(test.index, pd.DatetimeIndex) and len(test.index) > 0
            else now
        )
        test_end = (
            test.index.max().to_pydatetime()
            if isinstance(test.index, pd.DatetimeIndex) and len(test.index) > 0
            else now
        )
        test_summary = cast(dict[str, Any], fold_bundle["test_summary"])
        session.add(
            ResearchFoldMetrics(
                candidate_id=candidate_id,
                fold_name="holdout-1",
                fold_order=1,
                train_start=train_start,
                train_end=train_end,
                test_start=test_start,
                test_end=test_end,
                decision_count=int(test.shape[0]),
                trade_count=int(test.shape[0]),
                gross_pnl=_decimal_or_none(test_summary.get("total_return")),
                net_pnl=_decimal_or_none(test_summary.get("total_return")),
                max_drawdown=_decimal_or_none(test_summary.get("max_drawdown")),
                turnover_ratio=_decimal_or_none(fold_bundle.get("test_turnover_mean")),
                cost_bps=_decimal_or_none(
                    cost_calibration_payload.get("modeled_slippage_bps")
                ),
                cost_assumptions={
                    "modeled_slippage_bps": cost_calibration_payload.get(
                        "modeled_slippage_bps"
                    ),
                },
                regime_label="trend_following",
                stat_bundle=fold_bundle,
                purge_window=0,
                embargo_window=0,
                feature_availability_hash=hashlib.sha256(
                    b"tsmom-lookback-vol-shift-v1"
                ).hexdigest(),
            )
        )

        for stress_payload in cast(
            list[dict[str, Any]], strategy_factory_summary["stress_results"]
        ):
            session.add(
                ResearchStressMetrics(
                    candidate_id=candidate_id,
                    stress_case=str(stress_payload["stress_case"]),
                    metric_bundle=stress_payload["metric_bundle"],
                    pessimistic_pnl_delta=_decimal_or_none(
                        stress_payload.get("pessimistic_pnl_delta")
                    ),
                )
            )

        for attempt in cast(list[dict[str, Any]], attempt_payload.get("attempts", [])):
            session.add(
                ResearchAttempt(
                    attempt_id=str(attempt["attempt_id"]),
                    run_id=run_id,
                    candidate_hash=cast(str | None, attempt.get("candidate_hash")),
                    generator_family=cast(str | None, attempt.get("generator_family")),
                    attempt_stage=str(attempt["attempt_stage"]),
                    status=str(attempt["status"]),
                    reason_codes=attempt.get("reason_codes"),
                    artifact_ref=cast(str | None, attempt.get("artifact_ref")),
                    metadata_bundle=attempt.get("metadata_bundle"),
                )
            )

        for test_name, payload in validation_payloads.items():
            session.add(
                ResearchValidationTest(
                    candidate_id=candidate_id,
                    test_name=test_name,
                    status=str(payload["status"]),
                    metric_bundle=payload,
                    artifact_ref=f"validation/{payload['artifact_name']}",
                    computed_at=now,
                )
            )

        session.add(
            ResearchSequentialTrial(
                candidate_id=candidate_id,
                trial_stage=str(sequential_trial_payload["trial_stage"]),
                account=str(sequential_trial_payload["account"]),
                start_at=datetime.fromisoformat(
                    str(sequential_trial_payload["start_at"])
                ),
                last_update_at=datetime.fromisoformat(
                    str(sequential_trial_payload["last_update_at"])
                ),
                sample_count=int(sequential_trial_payload["sample_count"]),
                confidence_sequence_lower=_decimal_or_none(
                    sequential_trial_payload.get("confidence_sequence_lower")
                ),
                confidence_sequence_upper=_decimal_or_none(
                    sequential_trial_payload.get("confidence_sequence_upper")
                ),
                posterior_edge_mean=_decimal_or_none(
                    sequential_trial_payload.get("posterior_edge_mean")
                ),
                posterior_edge_lower=_decimal_or_none(
                    sequential_trial_payload.get("posterior_edge_lower")
                ),
                status=str(sequential_trial_payload["status"]),
                reason_codes=sequential_trial_payload.get("reason_codes"),
            )
        )

        session.add(
            ResearchCostCalibration(
                calibration_id=str(cost_calibration_payload["calibration_id"]),
                scope_type=str(cost_calibration_payload["scope_type"]),
                scope_id=str(cost_calibration_payload["scope_id"]),
                window_start=(
                    datetime.fromisoformat(
                        str(cost_calibration_payload["window_start"])
                    )
                    if cost_calibration_payload.get("window_start")
                    else None
                ),
                window_end=(
                    datetime.fromisoformat(str(cost_calibration_payload["window_end"]))
                    if cost_calibration_payload.get("window_end")
                    else None
                ),
                modeled_slippage_bps=_decimal_or_none(
                    cost_calibration_payload.get("modeled_slippage_bps")
                ),
                realized_slippage_bps=_decimal_or_none(
                    cost_calibration_payload.get("realized_slippage_bps")
                ),
                modeled_shortfall_bps=_decimal_or_none(
                    cost_calibration_payload.get("modeled_shortfall_bps")
                ),
                realized_shortfall_bps=_decimal_or_none(
                    cost_calibration_payload.get("realized_shortfall_bps")
                ),
                calibration_error_bundle=cost_calibration_payload.get(
                    "calibration_error_bundle"
                ),
                status=str(cost_calibration_payload["status"]),
                computed_at=datetime.fromisoformat(
                    str(cost_calibration_payload["computed_at"])
                ),
            )
        )

        session.add(
            ResearchPromotion(
                candidate_id=candidate_id,
                requested_mode=requested_mode,
                approved_mode=requested_mode if promotion_allowed else None,
                approver="strategy_factory_alpha",
                approver_role="system",
                approve_reason=recommendation_rationale if promotion_allowed else None,
                deny_reason=None if promotion_allowed else recommendation_rationale,
                effective_time=now if promotion_allowed else None,
                decision_action=str(recommendation_payload["recommendation"]["action"]),
                decision_rationale=recommendation_rationale,
                evidence_bundle=evidence_bundle,
                recommendation_trace_id=recommendation_trace_id,
            )
        )
        session.commit()


__all__ = [name for name in globals() if not name.startswith("__")]
