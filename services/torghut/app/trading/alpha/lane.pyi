from __future__ import annotations

# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportPrivateUsage=false
# ruff: noqa: F401,F403,F405,F811,F821
from typing import Any
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
from ...models import (
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
from ..discovery import (
    build_sequential_trial_summary,
    build_strategy_factory_evaluation,
)
from .metrics import summarize_equity_curve, to_jsonable
from .search import SearchResult, candidate_to_jsonable, run_tsmom_grid_search
from .tsmom import TSMOMConfig, backtest_tsmom
from ..reporting import PromotionEvidenceSummary, build_promotion_recommendation

class AlphaLaneResult:
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    run_id: str
    candidate_id: str
    output_dir: Path
    train_prices_path: Path
    test_prices_path: Path
    search_result_path: Path
    best_candidate_path: Path
    evaluation_report_path: Path
    recommendation_artifact_path: Path
    candidate_spec_path: Path
    candidate_generation_manifest_path: Path
    evaluation_manifest_path: Path
    recommendation_manifest_path: Path
    attempt_ledger_path: Path
    validation_artifact_paths: dict[str, Path]
    sequential_trial_path: Path
    cost_calibration_path: Path
    recommendation_trace_id: str
    stage_trace_ids: dict[str, str]
    stage_lineage_root: str | None
    paper_patch_path: Path | None

class _StageManifestRecord:
    def __init__(*args: Any, **kwargs: Any) -> None: ...
    stage: str
    stage_index: int
    stage_trace_id: str
    lineage_hash: str
    artifact_hashes: dict[str, str]
    stage_payload_hash: str
    created_at: str
    created_by: str
    parent_lineage_hash: str | None
    parent_stage: str | None
    inputs: dict[str, str]

_ALPHA_LANE_SCHEMA_VERSION: Any
_STAGE_CANDIDATE_GENERATION: Any
_STAGE_EVALUATION: Any
_STAGE_RECOMMENDATION: Any

def _stable_hash(*args: Any, **kwargs: Any) -> Any: ...
def _sha256_path(*args: Any, **kwargs: Any) -> Any: ...
def _artifact_hashes(*args: Any, **kwargs: Any) -> Any: ...
def _readable_iteration_number(*args: Any, **kwargs: Any) -> Any: ...
def _coerce_str(*args: Any, **kwargs: Any) -> Any: ...
def _coalesce_alpha_inputs(*args: Any, **kwargs: Any) -> Any: ...
def _to_decimal(*args: Any, **kwargs: Any) -> Any: ...
def _normalize_prices(*args: Any, **kwargs: Any) -> Any: ...
def _frame_signature(*args: Any, **kwargs: Any) -> Any: ...
def _coerce_promotion_target(*args: Any, **kwargs: Any) -> Any: ...
def _coerce_jsonable(*args: Any, **kwargs: Any) -> Any: ...
def _persist_prices(*args: Any, **kwargs: Any) -> Any: ...
def _write_json(*args: Any, **kwargs: Any) -> Any: ...
def _decimal_or_none(*args: Any, **kwargs: Any) -> Any: ...
def _read_policy_payload(*args: Any, **kwargs: Any) -> Any: ...
def _evaluate_candidate(*args: Any, **kwargs: Any) -> Any: ...
def _write_stage_manifest(*args: Any, **kwargs: Any) -> Any: ...
def _build_stage_lineage_payload(*args: Any, **kwargs: Any) -> Any: ...
def _write_iteration_notes(*args: Any, **kwargs: Any) -> Any: ...
def _persist_strategy_factory_results(*args: Any, **kwargs: Any) -> Any: ...
def run_alpha_discovery_lane(*args: Any, **kwargs: Any) -> Any: ...
