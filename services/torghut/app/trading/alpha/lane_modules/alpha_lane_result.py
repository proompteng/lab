# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
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

# ruff: noqa: F401,F811,F821


@dataclass(frozen=True)
class AlphaLaneResult:
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
    stage_trace_ids: dict[str, str] = field(default_factory=dict)
    stage_lineage_root: str | None = None
    paper_patch_path: Path | None = None


@dataclass(frozen=True)
class _StageManifestRecord:
    stage: str
    stage_index: int
    stage_trace_id: str
    lineage_hash: str
    artifact_hashes: dict[str, str]
    stage_payload_hash: str
    created_at: str
    created_by: str = "run_alpha_discovery_lane"
    parent_lineage_hash: str | None = None
    parent_stage: str | None = None
    inputs: dict[str, str] = field(default_factory=dict)


_ALPHA_LANE_SCHEMA_VERSION = "alpha-discovery-lane-stage-manifest-v1"

_STAGE_CANDIDATE_GENERATION = "candidate-generation"

_STAGE_EVALUATION = "evaluation"

_STAGE_RECOMMENDATION = "promotion-recommendation"


def _stable_hash(payload: object) -> str:
    payload_json = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload_json.encode("utf-8")).hexdigest()


def _sha256_path(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _artifact_hashes(artifacts: Mapping[str, Path | None]) -> dict[str, str]:
    digests: dict[str, str] = {}
    for key, artifact_path in artifacts.items():
        if artifact_path is not None and artifact_path.exists():
            digests[key] = _sha256_path(artifact_path)
    return digests


def _readable_iteration_number(notes_dir: Path) -> int:
    pattern = re.compile(r"^iteration-(\d+)\.md$")
    highest = 0
    for item in notes_dir.glob("iteration-*.md"):
        match = pattern.match(item.name)
        if not match:
            continue
        try:
            candidate = int(match.group(1))
        except (TypeError, ValueError):
            continue
        if candidate > highest:
            highest = candidate
    return highest + 1


def _coerce_str(raw: Any, default: str = "") -> str:
    if isinstance(raw, str):
        return raw.strip() or default
    return default


def _coalesce_alpha_inputs(
    *,
    repository: str | None,
    base: str | None,
    head: str | None,
    priority_id: str | None,
    priorityId: str | None = None,
    notes_artifact_path: str | None,
    artifactPath: str | None = None,
    execution_context: Mapping[str, Any] | None,
) -> tuple[str | None, str | None, str | None, str | None, Path | None]:
    raw_execution_context = (
        execution_context if isinstance(execution_context, Mapping) else {}
    )
    nested_execution_context = (
        raw_execution_context.get("execution_context")
        if isinstance(raw_execution_context.get("execution_context"), Mapping)
        else raw_execution_context
    )
    runtime_context = (
        cast(Mapping[str, Any], nested_execution_context)
        if isinstance(nested_execution_context, Mapping)
        else {}
    )

    repository_resolved = (
        repository
        if repository is not None
        else _coerce_str(runtime_context.get("repository"))
    )
    base_resolved = (
        base if base is not None else _coerce_str(runtime_context.get("base"))
    )
    head_resolved = (
        head if head is not None else _coerce_str(runtime_context.get("head"))
    )
    priority_id_resolved = (
        priority_id if priority_id is not None else _coerce_str(priorityId)
    )
    if not priority_id_resolved:
        priority_id_resolved = _coerce_str(runtime_context.get("priorityId"))
    artifact_root = (
        _coerce_str(notes_artifact_path)
        or _coerce_str(artifactPath)
        or _coerce_str(runtime_context.get("artifactPath"))
    )
    resolved_artifact_path = Path(artifact_root) if artifact_root else None

    return (
        repository_resolved,
        base_resolved,
        head_resolved,
        priority_id_resolved,
        resolved_artifact_path,
    )


def _to_decimal(value: object, *, default: str) -> Decimal:
    if isinstance(value, Decimal):
        return value
    if isinstance(value, int | float):
        return Decimal(str(value))
    if value is None:
        return Decimal(default)
    raw = str(value).strip()
    if not raw:
        return Decimal(default)
    return Decimal(raw)


def _normalize_prices(values: pd.DataFrame, *, label: str) -> pd.DataFrame:
    prices = values.copy()
    if prices.empty:
        raise ValueError(f"{label} prices are empty")

    if isinstance(prices.index, pd.RangeIndex) and len(prices.columns) > 0:
        date_like = prices.iloc[:, 0]
        if not pd.api.types.is_numeric_dtype(date_like.dtype):
            parsed_dates = pd.to_datetime(date_like, errors="coerce", utc=True)
            if parsed_dates.notna().sum() >= max(1, int(len(parsed_dates) * 0.8)):
                prices = prices.iloc[:, 1:]
                prices.index = parsed_dates

    numeric_prices = prices.apply(pd.to_numeric, errors="coerce")
    numeric_prices = numeric_prices.dropna(axis=1, how="all").dropna(how="all")
    if numeric_prices.empty:
        raise ValueError(f"{label} prices contain no numeric columns")
    if isinstance(numeric_prices.index, pd.DatetimeIndex):
        numeric_prices = numeric_prices.sort_index()
    return numeric_prices.astype("float64")


def _frame_signature(values: pd.DataFrame) -> dict[str, Any]:
    csv_payload = values.to_csv(float_format="%.12f", index=True)
    return {
        "shape": [int(values.shape[0]), int(values.shape[1])],
        "columns": [str(column) for column in values.columns],
        "hash": hashlib.sha256(csv_payload.encode("utf-8")).hexdigest(),
    }


def _coerce_promotion_target(value: str) -> Literal["shadow", "paper", "live"]:
    if value not in {"shadow", "paper", "live"}:
        raise ValueError(f"unsupported promotion target: {value}")
    return cast(Literal["shadow", "paper", "live"], value)


def _coerce_jsonable(value: Any) -> Any:
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, pd.Series):
        return value.to_dict()
    if isinstance(value, pd.DataFrame):
        return value.to_dict(orient="list")
    if isinstance(value, list):
        return [_coerce_jsonable(item) for item in value]
    if isinstance(value, tuple):
        return [_coerce_jsonable(item) for item in value]
    if isinstance(value, dict):
        return {str(key): _coerce_jsonable(item) for key, item in value.items()}
    if isinstance(value, set):
        return sorted(value)
    return value


def _persist_prices(prices: pd.DataFrame, output_dir: Path, name: str) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    path = output_dir / f"{name}.csv"
    if isinstance(prices.index, pd.DatetimeIndex):
        prices.to_csv(path, float_format="%.12f")
    else:
        prices.to_csv(path, float_format="%.12f", index_label="date")
    return path


def _write_json(path: Path, payload: Mapping[str, Any]) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(dict(payload), indent=2), encoding="utf-8")
    return path


def _decimal_or_none(value: object) -> Decimal | None:
    if value is None:
        return None
    return Decimal(str(value))


def _read_policy_payload(path: Path | None) -> dict[str, Any]:
    if path is None:
        return {
            "policy_version": "alpha-lane-policy-v1",
            "alpha_min_train_total_return": "-1000000",
            "alpha_min_test_total_return": "0",
            "alpha_min_train_sharpe": "-1000000",
            "alpha_min_test_sharpe": "0",
            "alpha_max_test_drawdown_abs": "1",
            "require_candidate_accepted": True,
        }

    policy_payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(policy_payload, dict):
        raise ValueError("alpha gate policy must be an object")
    payload = dict(policy_payload)
    payload.setdefault("policy_version", "alpha-lane-policy-v1")
    payload.setdefault("alpha_min_train_total_return", "-1000000")
    payload.setdefault("alpha_min_test_total_return", "0")
    payload.setdefault("alpha_min_train_sharpe", "-1000000")
    payload.setdefault("alpha_min_test_sharpe", "0")
    payload.setdefault("alpha_max_test_drawdown_abs", "1")
    payload.setdefault("require_candidate_accepted", True)
    return payload


def _evaluate_candidate(
    search_result: SearchResult,
    policy_payload: Mapping[str, Any],
) -> tuple[bool, list[dict[str, str]], list[str], dict[str, Any]]:
    min_train_total_return = _to_decimal(
        policy_payload.get("alpha_min_train_total_return"),
        default="-1000000",
    )
    min_test_total_return = _to_decimal(
        policy_payload.get("alpha_min_test_total_return"),
        default="0",
    )
    min_train_sharpe = _to_decimal(
        policy_payload.get("alpha_min_train_sharpe"),
        default="-1000000",
    )
    min_test_sharpe = _to_decimal(
        policy_payload.get("alpha_min_test_sharpe"),
        default="0",
    )
    max_test_drawdown_abs = _to_decimal(
        policy_payload.get("alpha_max_test_drawdown_abs"),
        default="1",
    )
    require_candidate_accepted = bool(
        policy_payload.get("require_candidate_accepted", True)
    )

    checks: list[dict[str, str]] = []
    reasons: list[str] = []
    best = search_result.best

    if require_candidate_accepted and not search_result.accepted:
        reason = str(search_result.reason).strip() or "candidate_rejected_by_search"
        checks.append(
            {
                "check": "search_acceptance",
                "status": "fail",
                "reason": reason,
            }
        )
        reasons.append(reason)
    else:
        checks.append(
            {
                "check": "search_acceptance",
                "status": "pass",
                "reason": "",
            }
        )

    if best.train.total_return < float(min_train_total_return):
        reason = "train_total_return_below_threshold"
        checks.append(
            {
                "check": "train_total_return",
                "status": "fail",
                "reason": reason,
            }
        )
        reasons.append(reason)
    else:
        checks.append(
            {
                "check": "train_total_return",
                "status": "pass",
                "reason": "",
            }
        )

    if (best.test.total_return or 0.0) < float(min_test_total_return):
        reason = "test_total_return_below_threshold"
        checks.append(
            {
                "check": "test_total_return",
                "status": "fail",
                "reason": reason,
            }
        )
        reasons.append(reason)
    else:
        checks.append(
            {
                "check": "test_total_return",
                "status": "pass",
                "reason": "",
            }
        )

    if best.train.sharpe is None or float(best.train.sharpe) < float(min_train_sharpe):
        reason = "train_sharpe_below_threshold"
        checks.append(
            {
                "check": "train_sharpe",
                "status": "fail",
                "reason": reason,
            }
        )
        reasons.append(reason)
    else:
        checks.append(
            {
                "check": "train_sharpe",
                "status": "pass",
                "reason": "",
            }
        )

    if best.test.sharpe is None or float(best.test.sharpe) < float(min_test_sharpe):
        reason = "test_sharpe_below_threshold"
        checks.append(
            {
                "check": "test_sharpe",
                "status": "fail",
                "reason": reason,
            }
        )
        reasons.append(reason)
    else:
        checks.append(
            {
                "check": "test_sharpe",
                "status": "pass",
                "reason": "",
            }
        )

    if best.test.max_drawdown is not None:
        if abs(float(best.test.max_drawdown)) > float(max_test_drawdown_abs):
            reason = "test_drawdown_exceeds_threshold"
            checks.append(
                {
                    "check": "test_drawdown_abs",
                    "status": "fail",
                    "reason": reason,
                }
            )
            reasons.append(reason)
        else:
            checks.append(
                {
                    "check": "test_drawdown_abs",
                    "status": "pass",
                    "reason": "",
                }
            )
    else:
        checks.append(
            {
                "check": "test_drawdown_abs",
                "status": "pass",
                "reason": "max_drawdown_unavailable",
            }
        )

    evaluation_context = {
        "accepted_by_search": bool(search_result.accepted),
        "checks": [
            {
                "check": check.get("check"),
                "status": check.get("status"),
                "reason": check.get("reason"),
            }
            for check in checks
        ],
    }
    return len(reasons) == 0, checks, reasons, evaluation_context


def _write_stage_manifest(
    *,
    stage: str,
    stage_index: int,
    stage_output_dir: Path,
    run_id: str,
    candidate_id: str,
    lineage_parent_hash: str | None,
    lineage_parent_stage: str | None,
    inputs: dict[str, str],
    input_artifacts: Mapping[str, Path | None],
    output_artifacts: Mapping[str, Path | None],
    created_at: datetime,
) -> _StageManifestRecord:
    stage_manifest = {
        "schema_version": _ALPHA_LANE_SCHEMA_VERSION,
        "stage": stage,
        "stage_index": stage_index,
        "run_id": run_id,
        "candidate_id": candidate_id,
        "created_at": created_at.isoformat(),
        "inputs": dict(inputs),
        "input_artifacts": {
            key: {
                "path": str(path),
                "sha256": _sha256_path(path),
            }
            for key, path in input_artifacts.items()
            if path is not None
        },
        "output_artifacts": {
            key: {
                "path": str(path),
                "sha256": _sha256_path(path),
            }
            for key, path in output_artifacts.items()
            if path is not None
        },
        "parent_lineage_hash": lineage_parent_hash,
        "parent_stage": lineage_parent_stage,
    }
    stage_payload_hash = _stable_hash(stage_manifest)
    stage_trace_id = stage_payload_hash[:24]
    artifact_hashes = _artifact_hashes(output_artifacts)
    record = _StageManifestRecord(
        stage=stage,
        stage_index=stage_index,
        stage_trace_id=stage_trace_id,
        lineage_hash=stage_payload_hash,
        artifact_hashes=artifact_hashes,
        stage_payload_hash=stage_payload_hash,
        created_at=created_at.isoformat(),
        parent_lineage_hash=lineage_parent_hash,
        parent_stage=lineage_parent_stage,
        inputs=dict(inputs),
    )
    stage_manifest["stage_trace_id"] = stage_trace_id
    stage_manifest["lineage_hash"] = stage_payload_hash
    stage_manifest["artifact_hashes"] = artifact_hashes
    manifest_path = stage_output_dir / f"{stage}-manifest.json"
    stage_manifest["artifact_count"] = len(artifact_hashes)
    manifest_path.write_text(json.dumps(stage_manifest, indent=2), encoding="utf-8")
    return record


def _build_stage_lineage_payload(
    stage_records: Sequence[_StageManifestRecord],
    manifest_paths: Mapping[str, Path],
) -> dict[str, Any]:
    stages_payload: dict[str, Any] = {}
    for record in stage_records:
        manifest_path = manifest_paths.get(record.stage)
        stages_payload[record.stage] = {
            "index": record.stage_index,
            "stage_trace_id": record.stage_trace_id,
            "lineage_hash": record.lineage_hash,
            "parent_stage": record.parent_stage,
            "parent_lineage_hash": record.parent_lineage_hash,
            "stage_payload_hash": record.stage_payload_hash,
            "created_at": record.created_at,
            "created_by": record.created_by,
            "inputs": record.inputs,
            "artifact_hashes": record.artifact_hashes,
            "manifest_path": str(manifest_path) if manifest_path else None,
        }
    return {
        "schema_version": _ALPHA_LANE_SCHEMA_VERSION,
        "root_lineage_hash": stage_records[0].lineage_hash if stage_records else None,
        "stages": stages_payload,
    }


def _write_iteration_notes(
    *,
    artifact_root: Path,
    run_id: str,
    candidate_id: str,
    stage_records: Sequence[_StageManifestRecord],
    repository: str | None,
    base: str | None,
    head: str | None,
    priority_id: str | None,
) -> Path:
    notes_dir = artifact_root / "notes"
    notes_dir.mkdir(parents=True, exist_ok=True)
    iteration = _readable_iteration_number(notes_dir)
    notes_path = notes_dir / f"iteration-{iteration}.md"

    lines = [
        f"# Alpha lane iteration {iteration}",
        "",
        f"- run_id: {run_id}",
        f"- candidate_id: {candidate_id}",
    ]
    if repository:
        lines.append(f"- repository: {repository}")
    if base:
        lines.append(f"- base: {base}")
    if head:
        lines.append(f"- head: {head}")
    if priority_id:
        lines.append(f"- priority_id: {priority_id}")

    lines.extend(["", "## Stage progression", ""])
    for record in stage_records:
        lines.append(f"- {record.stage} (index {record.stage_index})")
        lines.append(f"  - trace={record.stage_trace_id}")
        if record.parent_stage:
            lines.append(
                f"  - parent: {record.parent_stage} (hash={record.parent_lineage_hash})"
            )

    notes_path.write_text("\n".join(lines), encoding="utf-8")
    return notes_path


normalize_prices = _normalize_prices

__all__ = [name for name in globals() if not name.startswith("__")]
