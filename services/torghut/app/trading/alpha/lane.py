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
from ..reporting import (
    PromotionEvidenceSummary,
    build_promotion_recommendation,
)


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
        repository if repository is not None else _coerce_str(runtime_context.get("repository"))
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
        session.execute(
            delete(ResearchAttempt).where(ResearchAttempt.run_id == run_id)
        )
        for table in (
            ResearchValidationTest,
            ResearchSequentialTrial,
            ResearchStressMetrics,
            ResearchFoldMetrics,
            ResearchPromotion,
        ):
            session.execute(delete(table).where(table.candidate_id == candidate_id))
        session.execute(
            delete(ResearchCandidate).where(ResearchCandidate.candidate_id == candidate_id)
        )

        calibration_id = str(cost_calibration_payload['calibration_id'])
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
                status='passed' if promotion_allowed or evaluation_passed else 'failed',
                strategy_id='strategy_factory_alpha',
                strategy_name='strategy_factory_alpha',
                strategy_type=strategy_factory_summary['candidate_family'],
                strategy_version='alpha-lane-v2',
                code_commit=resolved_head,
                signal_source='alpha-search',
                dataset_from=dataset_from,
                dataset_to=dataset_to,
                runner_version='run_alpha_discovery_lane',
                runner_binary_hash=hashlib.sha256(run_id.encode('utf-8')).hexdigest(),
                recommendation_trace_id=recommendation_trace_id,
                discovery_mode='strategy_factory_alpha_v1',
                generator_family='tsmom_grid_v1',
                grammar_version='tsmom.dsl.v1',
                search_budget=search_budget,
                selection_protocol_version='alpha-selection-protocol-v1',
                pilot_program_id='torghut-strategy-factory-pilot-v1',
                kill_criteria_version='pilot-kill-criteria-v1',
            )
            session.add(run_row)
        else:
            run_row.status = 'passed' if promotion_allowed or evaluation_passed else 'failed'
            run_row.strategy_id = 'strategy_factory_alpha'
            run_row.strategy_name = 'strategy_factory_alpha'
            run_row.strategy_type = str(strategy_factory_summary['candidate_family'])
            run_row.strategy_version = 'alpha-lane-v2'
            run_row.code_commit = resolved_head
            run_row.signal_source = 'alpha-search'
            run_row.dataset_from = dataset_from
            run_row.dataset_to = dataset_to
            run_row.runner_version = 'run_alpha_discovery_lane'
            run_row.runner_binary_hash = hashlib.sha256(run_id.encode('utf-8')).hexdigest()
            run_row.recommendation_trace_id = recommendation_trace_id
            run_row.discovery_mode = 'strategy_factory_alpha_v1'
            run_row.generator_family = 'tsmom_grid_v1'
            run_row.grammar_version = 'tsmom.dsl.v1'
            run_row.search_budget = search_budget
            run_row.selection_protocol_version = 'alpha-selection-protocol-v1'
            run_row.pilot_program_id = 'torghut-strategy-factory-pilot-v1'
            run_row.kill_criteria_version = 'pilot-kill-criteria-v1'

        evidence_bundle = {
            'attempt_count': len(attempt_payload.get('attempts', [])),
            'validation_test_count': len(validation_payloads),
            'stage_lineage': stage_lineage_payload,
            'stage_trace_ids': dict(stage_trace_ids),
            'stage_manifest_refs': {
                key: str(value) for key, value in manifest_paths.items()
            },
            'replay_artifact_hashes': dict(replay_artifact_hashes),
            'cost_calibration': cost_calibration_payload,
            'sequential_trial': sequential_trial_payload,
            'strategy_factory': strategy_factory_summary,
        }
        candidate_row = ResearchCandidate(
            run_id=run_id,
            candidate_id=candidate_id,
            candidate_hash=str(strategy_factory_summary['semantic_hash']),
            parameter_set=strategy_factory_summary['canonical_spec'],
            decision_count=int(test.shape[0]),
            trade_count=int(test.shape[0]),
            symbols_covered=[str(column) for column in test.columns],
            universe_definition={
                'repository': resolved_repository,
                'autonomy_lifecycle': {
                    'role': 'challenger',
                    'status': 'promoted_champion' if promotion_allowed else 'retained_challenger',
                },
            },
            promotion_target=requested_mode,
            lifecycle_role='challenger',
            lifecycle_status='promoted' if promotion_allowed else 'evaluated',
            metadata_bundle=evidence_bundle,
            recommendation_bundle=recommendation_payload['recommendation'],
            candidate_family=str(strategy_factory_summary['candidate_family']),
            canonical_spec=strategy_factory_summary['canonical_spec'],
            semantic_hash=str(strategy_factory_summary['semantic_hash']),
            economic_rationale=str(strategy_factory_summary['economic_rationale']),
            complexity_score=_decimal_or_none(strategy_factory_summary['complexity_score']),
            discovery_rank=int(strategy_factory_summary['discovery_rank']),
            posterior_edge_summary=strategy_factory_summary['posterior_edge_summary'],
            economic_validity_card=strategy_factory_summary['economic_validity_card'],
            valid_regime_envelope=strategy_factory_summary['valid_regime_envelope'],
            invalidation_clauses=strategy_factory_summary['invalidation_clauses'],
            null_comparator_summary=strategy_factory_summary['null_comparator_summary'],
        )
        session.add(candidate_row)

        fold_bundle = strategy_factory_summary['fold_stat_bundle']
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
        test_summary = cast(dict[str, Any], fold_bundle['test_summary'])
        session.add(
            ResearchFoldMetrics(
                candidate_id=candidate_id,
                fold_name='holdout-1',
                fold_order=1,
                train_start=train_start,
                train_end=train_end,
                test_start=test_start,
                test_end=test_end,
                decision_count=int(test.shape[0]),
                trade_count=int(test.shape[0]),
                gross_pnl=_decimal_or_none(test_summary.get('total_return')),
                net_pnl=_decimal_or_none(test_summary.get('total_return')),
                max_drawdown=_decimal_or_none(test_summary.get('max_drawdown')),
                turnover_ratio=_decimal_or_none(fold_bundle.get('test_turnover_mean')),
                cost_bps=_decimal_or_none(
                    cost_calibration_payload.get('modeled_slippage_bps')
                ),
                cost_assumptions={
                    'modeled_slippage_bps': cost_calibration_payload.get(
                        'modeled_slippage_bps'
                    ),
                },
                regime_label='trend_following',
                stat_bundle=fold_bundle,
                purge_window=0,
                embargo_window=0,
                feature_availability_hash=hashlib.sha256(
                    b'tsmom-lookback-vol-shift-v1'
                ).hexdigest(),
            )
        )

        for stress_payload in cast(list[dict[str, Any]], strategy_factory_summary['stress_results']):
            session.add(
                ResearchStressMetrics(
                    candidate_id=candidate_id,
                    stress_case=str(stress_payload['stress_case']),
                    metric_bundle=stress_payload['metric_bundle'],
                    pessimistic_pnl_delta=_decimal_or_none(
                        stress_payload.get('pessimistic_pnl_delta')
                    ),
                )
            )

        for attempt in cast(list[dict[str, Any]], attempt_payload.get('attempts', [])):
            session.add(
                ResearchAttempt(
                    attempt_id=str(attempt['attempt_id']),
                    run_id=run_id,
                    candidate_hash=cast(str | None, attempt.get('candidate_hash')),
                    generator_family=cast(str | None, attempt.get('generator_family')),
                    attempt_stage=str(attempt['attempt_stage']),
                    status=str(attempt['status']),
                    reason_codes=attempt.get('reason_codes'),
                    artifact_ref=cast(str | None, attempt.get('artifact_ref')),
                    metadata_bundle=attempt.get('metadata_bundle'),
                )
            )

        for test_name, payload in validation_payloads.items():
            session.add(
                ResearchValidationTest(
                    candidate_id=candidate_id,
                    test_name=test_name,
                    status=str(payload['status']),
                    metric_bundle=payload,
                    artifact_ref=f'validation/{payload["artifact_name"]}',
                    computed_at=now,
                )
            )

        session.add(
            ResearchSequentialTrial(
                candidate_id=candidate_id,
                trial_stage=str(sequential_trial_payload['trial_stage']),
                account=str(sequential_trial_payload['account']),
                start_at=datetime.fromisoformat(str(sequential_trial_payload['start_at'])),
                last_update_at=datetime.fromisoformat(
                    str(sequential_trial_payload['last_update_at'])
                ),
                sample_count=int(sequential_trial_payload['sample_count']),
                confidence_sequence_lower=_decimal_or_none(
                    sequential_trial_payload.get('confidence_sequence_lower')
                ),
                confidence_sequence_upper=_decimal_or_none(
                    sequential_trial_payload.get('confidence_sequence_upper')
                ),
                posterior_edge_mean=_decimal_or_none(
                    sequential_trial_payload.get('posterior_edge_mean')
                ),
                posterior_edge_lower=_decimal_or_none(
                    sequential_trial_payload.get('posterior_edge_lower')
                ),
                status=str(sequential_trial_payload['status']),
                reason_codes=sequential_trial_payload.get('reason_codes'),
            )
        )

        session.add(
            ResearchCostCalibration(
                calibration_id=str(cost_calibration_payload['calibration_id']),
                scope_type=str(cost_calibration_payload['scope_type']),
                scope_id=str(cost_calibration_payload['scope_id']),
                window_start=(
                    datetime.fromisoformat(str(cost_calibration_payload['window_start']))
                    if cost_calibration_payload.get('window_start')
                    else None
                ),
                window_end=(
                    datetime.fromisoformat(str(cost_calibration_payload['window_end']))
                    if cost_calibration_payload.get('window_end')
                    else None
                ),
                modeled_slippage_bps=_decimal_or_none(
                    cost_calibration_payload.get('modeled_slippage_bps')
                ),
                realized_slippage_bps=_decimal_or_none(
                    cost_calibration_payload.get('realized_slippage_bps')
                ),
                modeled_shortfall_bps=_decimal_or_none(
                    cost_calibration_payload.get('modeled_shortfall_bps')
                ),
                realized_shortfall_bps=_decimal_or_none(
                    cost_calibration_payload.get('realized_shortfall_bps')
                ),
                calibration_error_bundle=cost_calibration_payload.get(
                    'calibration_error_bundle'
                ),
                status=str(cost_calibration_payload['status']),
                computed_at=datetime.fromisoformat(
                    str(cost_calibration_payload['computed_at'])
                ),
            )
        )

        session.add(
            ResearchPromotion(
                candidate_id=candidate_id,
                requested_mode=requested_mode,
                approved_mode=requested_mode if promotion_allowed else None,
                approver='strategy_factory_alpha',
                approver_role='system',
                approve_reason=recommendation_rationale if promotion_allowed else None,
                deny_reason=None if promotion_allowed else recommendation_rationale,
                effective_time=now if promotion_allowed else None,
                decision_action=str(recommendation_payload['recommendation']['action']),
                decision_rationale=recommendation_rationale,
                evidence_bundle=evidence_bundle,
                recommendation_trace_id=recommendation_trace_id,
            )
        )
        session.commit()


def run_alpha_discovery_lane(
    *,
    artifact_path: Path,
    train_prices: pd.DataFrame,
    test_prices: pd.DataFrame,
    repository: str | None = None,
    base: str | None = None,
    head: str | None = None,
    priority_id: str | None = None,
    priorityId: str | None = None,
    notes_artifact_path: str | None = None,
    artifactPath: str | None = None,
    lookback_days: Iterable[int] = (20, 40, 60),
    vol_lookback_days: Iterable[int] = (10, 20, 40),
    target_daily_vols: Iterable[float] = (0.0075, 0.01, 0.0125),
    max_gross_leverages: Iterable[float] = (0.75, 1.0),
    long_only: bool = True,
    cost_bps_per_turnover: float = 5.0,
    gate_policy_path: Path | None = None,
    promotion_target: str = "paper",
    evaluated_at: datetime | None = None,
    execution_context: Mapping[str, Any] | None = None,
    persist_results: bool = False,
    session_factory: Callable[[], Session] | None = None,
    challenge_lane: bool = False,
    economic_rationale: str | None = None,
) -> AlphaLaneResult:
    """Run deterministic alpha candidate generation, evaluation, and recommendation."""

    train = _normalize_prices(train_prices, label="train")
    test = _normalize_prices(test_prices, label="test")
    if train.empty or test.empty:
        raise ValueError("train and test prices must be non-empty")
    if persist_results and session_factory is None:
        raise ValueError("session_factory is required when persist_results is true")

    now = evaluated_at or datetime.now(timezone.utc)
    output_dir = artifact_path
    (
        resolved_repository,
        resolved_base,
        resolved_head,
        resolved_priority_id,
        notes_artifact_root,
    ) = _coalesce_alpha_inputs(
        repository=repository,
        base=base,
        head=head,
        priority_id=priority_id,
        priorityId=priorityId,
        notes_artifact_path=notes_artifact_path,
        artifactPath=artifactPath,
        execution_context=execution_context,
    )
    research_dir = output_dir / "research"
    stages_output_dir = output_dir / "stages"
    notes_root = notes_artifact_root or output_dir
    output_dir.mkdir(parents=True, exist_ok=True)
    research_dir.mkdir(parents=True, exist_ok=True)
    stages_output_dir.mkdir(parents=True, exist_ok=True)

    requested_mode = _coerce_promotion_target(promotion_target)
    lookback_values = list(lookback_days)
    vol_lookback_values = list(vol_lookback_days)
    target_daily_vol_values = list(target_daily_vols)
    max_gross_leverage_values = list(max_gross_leverages)
    if not (
        lookback_values
        and vol_lookback_values
        and target_daily_vol_values
        and max_gross_leverage_values
    ):
        raise ValueError("search grid must contain at least one value each")

    policy_payload = _read_policy_payload(gate_policy_path)
    run_signature = {
        "repository": resolved_repository or "",
        "base": resolved_base or "",
        "head": resolved_head or "",
        "priority_id": resolved_priority_id or "",
        "train_signature": _frame_signature(train),
        "test_signature": _frame_signature(test),
        "lookback_days": lookback_values,
        "vol_lookback_days": vol_lookback_values,
        "target_daily_vols": target_daily_vol_values,
        "max_gross_leverages": max_gross_leverage_values,
        "long_only": bool(long_only),
        "cost_bps_per_turnover": float(cost_bps_per_turnover),
        "challenge_lane": bool(challenge_lane),
        "economic_rationale": (economic_rationale or "").strip(),
        "policy": policy_payload,
    }
    run_id = _stable_hash(run_signature)[:24]
    candidate_id = f"cand-{run_id[:12]}"

    train_snapshot_path = _persist_prices(
        train,
        research_dir,
        name=f"train-prices-{candidate_id}",
    )
    test_snapshot_path = _persist_prices(
        test,
        research_dir,
        name=f"test-prices-{candidate_id}",
    )

    search_result = run_tsmom_grid_search(
        train,
        test,
        lookback_days=lookback_values,
        vol_lookback_days=vol_lookback_values,
        target_daily_vols=target_daily_vol_values,
        max_gross_leverages=max_gross_leverage_values,
        long_only=bool(long_only),
        cost_bps_per_turnover=float(cost_bps_per_turnover),
    )

    search_result_path = research_dir / "search-result.json"
    best_candidate_path = research_dir / "best-candidate.json"
    evaluation_report_path = research_dir / "evaluation-report.json"
    recommendation_artifact_path = research_dir / "recommendation.json"
    candidate_spec_path = research_dir / "candidate-spec.json"
    attempt_ledger_path = research_dir / "attempt-ledger.json"
    sequential_trial_path = research_dir / "sequential-trial.json"
    validation_dir = research_dir / "validation"
    cost_calibration_path = validation_dir / "cost-calibration-report-v1.json"

    search_payload = {
        "schema_version": "alpha-search-result-v1",
        "run_id": run_id,
        "candidate_id": candidate_id,
        "accepted": search_result.accepted,
        "reason": search_result.reason,
        "search_space": {
            "lookback_days": lookback_values,
            "vol_lookback_days": vol_lookback_values,
            "target_daily_vols": target_daily_vol_values,
            "max_gross_leverages": max_gross_leverage_values,
            "long_only": bool(long_only),
            "cost_bps_per_turnover": float(cost_bps_per_turnover),
        },
        "best": candidate_to_jsonable(search_result.best),
        "candidates_top": [candidate_to_jsonable(item) for item in search_result.candidates[:5]],
    }
    search_result_path.write_text(json.dumps(search_payload, indent=2), encoding="utf-8")
    best_candidate_path.write_text(
        json.dumps(candidate_to_jsonable(search_result.best), indent=2),
        encoding="utf-8",
    )

    best_cfg = TSMOMConfig(
        lookback_days=search_result.best.config.lookback_days,
        vol_lookback_days=search_result.best.config.vol_lookback_days,
        target_daily_vol=search_result.best.config.target_daily_vol,
        max_gross_leverage=search_result.best.config.max_gross_leverage,
        long_only=bool(long_only),
        cost_bps_per_turnover=float(cost_bps_per_turnover),
    )
    train_equity, train_debug = backtest_tsmom(train, best_cfg)
    test_equity, test_debug = backtest_tsmom(test, best_cfg)
    incumbent_cfg = TSMOMConfig(
        lookback_days=60,
        vol_lookback_days=20,
        target_daily_vol=0.01,
        max_gross_leverage=1.0,
        long_only=bool(long_only),
        cost_bps_per_turnover=float(cost_bps_per_turnover),
    )
    incumbent_equity, _incumbent_debug = backtest_tsmom(test, incumbent_cfg)
    strategy_factory = build_strategy_factory_evaluation(
        run_id=run_id,
        candidate_id=candidate_id,
        best_candidate=search_result.best,
        all_candidates=search_result.candidates,
        train_debug=train_debug,
        test_debug=test_debug,
        train_summary=search_result.best.train,
        test_summary=search_result.best.test,
        incumbent_summary=summarize_equity_curve(incumbent_equity),
        cost_bps_per_turnover=float(cost_bps_per_turnover),
        evaluated_at=now,
        challenge_lane=bool(challenge_lane),
        economic_rationale=economic_rationale,
    )

    validation_artifact_paths: dict[str, Path] = {}
    validation_payloads: dict[str, dict[str, Any]] = {}
    for validation_test in strategy_factory.validation_tests:
        payload = {
            'schema_version': 'strategy-factory-validation-v1',
            'run_id': run_id,
            'candidate_id': candidate_id,
            **validation_test.to_payload(),
        }
        artifact_path = validation_dir / validation_test.artifact_name
        _write_json(artifact_path, payload)
        validation_artifact_paths[validation_test.test_name] = artifact_path
        validation_payloads[validation_test.test_name] = payload

    attempt_payload = {
        'schema_version': 'research-attempt-ledger-v1',
        'run_id': run_id,
        'candidate_id': candidate_id,
        'attempts': strategy_factory.attempts,
    }
    _write_json(attempt_ledger_path, attempt_payload)

    cost_calibration_payload = {
        'schema_version': 'cost-calibration-report-v1',
        **strategy_factory.cost_calibration.to_payload(),
    }
    _write_json(cost_calibration_path, cost_calibration_payload)

    sequential_trial = build_sequential_trial_summary(
        net_returns=test_debug['port_ret_net'],
        started_at=(
            test.index.min().to_pydatetime()
            if isinstance(test.index, pd.DatetimeIndex) and len(test.index) > 0
            else now
        ),
        updated_at=now,
        cost_calibration_status=strategy_factory.cost_calibration.status,
        baseline_outperformed=bool(
            strategy_factory.null_comparator_summary.get('baseline_outperformed')
        ),
    )
    sequential_trial_payload = {
        'schema_version': 'sequential-trial-state-v1',
        **sequential_trial.to_payload(),
    }
    _write_json(sequential_trial_path, sequential_trial_payload)

    stage_records: list[_StageManifestRecord] = []
    manifest_paths: dict[str, Path] = {}
    stage_trace_ids: dict[str, str] = {}

    candidate_generation_stage_record = _write_stage_manifest(
        stage=_STAGE_CANDIDATE_GENERATION,
        stage_index=1,
        stage_output_dir=stages_output_dir,
        run_id=run_id,
        candidate_id=candidate_id,
        lineage_parent_hash=None,
        lineage_parent_stage=None,
        inputs={
            'run_id': run_id,
            'candidate_id': candidate_id,
            'repository': resolved_repository or '',
            'base': resolved_base or '',
            'head': resolved_head or '',
            'priority_id': resolved_priority_id or '',
        },
        input_artifacts={
            'train_prices': train_snapshot_path,
            'test_prices': test_snapshot_path,
            'gate_policy': gate_policy_path,
        },
        output_artifacts={
            'search_result': search_result_path,
            'best_candidate': best_candidate_path,
            'attempt_ledger': attempt_ledger_path,
        },
        created_at=now,
    )
    stage_records.append(candidate_generation_stage_record)
    manifest_paths[_STAGE_CANDIDATE_GENERATION] = (
        stages_output_dir / f'{_STAGE_CANDIDATE_GENERATION}-manifest.json'
    )
    stage_trace_ids[_STAGE_CANDIDATE_GENERATION] = (
        candidate_generation_stage_record.stage_trace_id
    )

    evaluation_passed, checks, reasons, evaluation_context = _evaluate_candidate(
        search_result,
        policy_payload,
    )
    validation_failures = [
        f'validation_{item.test_name}_failed'
        for item in strategy_factory.validation_tests
        if item.status != 'pass'
    ]
    gate_allowed = evaluation_passed and not validation_failures
    prerequisite_reasons: list[str] = []
    if requested_mode == 'live':
        if strategy_factory.cost_calibration.status != 'calibrated':
            prerequisite_reasons.append('cost_calibration_not_calibrated')
        if sequential_trial.status != 'paper_ready':
            prerequisite_reasons.append('sequential_trial_not_live_ready')
    elif requested_mode == 'paper':
        if sequential_trial.status not in {'paper_ready', 'paper_only'}:
            prerequisite_reasons.append('sequential_trial_not_paper_ready')
    prerequisite_allowed = len(prerequisite_reasons) == 0
    combined_reasons = sorted(set(reasons + validation_failures + prerequisite_reasons))
    evidence_summary = PromotionEvidenceSummary(
        fold_metrics_count=1,
        stress_metrics_count=len(strategy_factory.stress_results),
        rationale_present=True,
        evidence_complete=gate_allowed and prerequisite_allowed,
        reasons=combined_reasons,
    )
    recommendation = build_promotion_recommendation(
        run_id=run_id,
        candidate_id=candidate_id,
        requested_mode=requested_mode,
        recommended_mode=requested_mode,
        gate_allowed=gate_allowed,
        prerequisite_allowed=prerequisite_allowed,
        rollback_ready=True,
        fold_metrics_count=1,
        stress_metrics_count=len(strategy_factory.stress_results),
        rationale='strategy factory alpha recommendation',
        reasons=combined_reasons,
    )
    recommendation_trace_id = recommendation.trace_id

    evaluation_payload = {
        'schema_version': 'alpha-evaluation-v2',
        'run_id': run_id,
        'candidate_id': candidate_id,
        'policy': _coerce_jsonable(policy_payload),
        'search_accepted': search_result.accepted,
        'search_reason': search_result.reason,
        'checks': checks,
        'evaluation_passed': evaluation_passed,
        'gate_allowed': gate_allowed,
        'validation_failures': validation_failures,
        'recommendation': recommendation.to_payload(),
        'evidence': {
            'best_total_return': search_result.best.test.total_return,
            'best_sharpe': search_result.best.test.sharpe,
            'best_train_total_return': search_result.best.train.total_return,
            'best_train_sharpe': search_result.best.train.sharpe,
            'best_test_max_drawdown': search_result.best.test.max_drawdown,
            'top_n': 5,
        },
        'evidence_summary': evidence_summary.to_payload(),
        'evaluation_context': _coerce_jsonable(evaluation_context),
        'summary': {
            'train': {
                'rows': int(train.shape[0]),
                'symbols': int(train.shape[1]),
                'columns': [str(column) for column in train.columns],
            },
            'test': {
                'rows': int(test.shape[0]),
                'symbols': int(test.shape[1]),
                'columns': [str(column) for column in test.columns],
            },
        },
        'evidence_detail': {
            'best_train': to_jsonable(search_result.best.train),
            'best_test': to_jsonable(search_result.best.test),
            'train_equity': {
                'start': float(train_equity.iloc[0]),
                'end': float(train_equity.iloc[-1]),
            },
            'test_equity': {
                'start': float(test_equity.iloc[0]),
                'end': float(test_equity.iloc[-1]),
            },
        },
        'strategy_factory': {
            'candidate_family': strategy_factory.candidate_family,
            'canonical_spec': strategy_factory.canonical_spec,
            'semantic_hash': strategy_factory.semantic_hash,
            'economic_rationale': strategy_factory.economic_rationale,
            'complexity_score': strategy_factory.complexity_score,
            'discovery_rank': strategy_factory.discovery_rank,
            'posterior_edge_summary': strategy_factory.posterior_edge_summary,
            'economic_validity_card': strategy_factory.economic_validity_card,
            'valid_regime_envelope': strategy_factory.valid_regime_envelope,
            'invalidation_clauses': strategy_factory.invalidation_clauses,
            'null_comparator_summary': strategy_factory.null_comparator_summary,
            'fold_stat_bundle': strategy_factory.fold_stat_bundle,
            'validation_tests': [
                item.to_payload() for item in strategy_factory.validation_tests
            ],
            'cost_calibration': cost_calibration_payload,
            'sequential_trial_seed': sequential_trial_payload,
        },
    }
    _write_json(evaluation_report_path, evaluation_payload)

    evaluation_output_artifacts: dict[str, Path | None] = {
        'evaluation_report': evaluation_report_path,
        'attempt_ledger': attempt_ledger_path,
        'cost_calibration': cost_calibration_path,
    }
    for test_name, artifact_path in validation_artifact_paths.items():
        evaluation_output_artifacts[f'validation_{test_name}'] = artifact_path

    evaluation_stage_record = _write_stage_manifest(
        stage=_STAGE_EVALUATION,
        stage_index=2,
        stage_output_dir=stages_output_dir,
        run_id=run_id,
        candidate_id=candidate_id,
        lineage_parent_hash=candidate_generation_stage_record.lineage_hash,
        lineage_parent_stage=candidate_generation_stage_record.stage,
        inputs={
            'run_id': run_id,
            'candidate_id': candidate_id,
            'recommendation_trace_id': recommendation_trace_id,
        },
        input_artifacts={
            'search_result': search_result_path,
            'best_candidate': best_candidate_path,
        },
        output_artifacts=evaluation_output_artifacts,
        created_at=now,
    )
    stage_records.append(evaluation_stage_record)
    manifest_paths[_STAGE_EVALUATION] = (
        stages_output_dir / f'{_STAGE_EVALUATION}-manifest.json'
    )
    stage_trace_ids[_STAGE_EVALUATION] = evaluation_stage_record.stage_trace_id

    recommendation_payload: dict[str, Any] = {
        'schema_version': 'alpha-promotion-recommendation-v2',
        'run_id': run_id,
        'candidate_id': candidate_id,
        'promotion_target': requested_mode,
        'recommendation': recommendation.to_payload(),
        'checks': {
            'policy': _coerce_jsonable(policy_payload),
            'evaluation_checks': checks,
            'validation_tests': [item.to_payload() for item in strategy_factory.validation_tests],
            'prerequisite_reasons': prerequisite_reasons,
        },
        'evaluation_passed': evaluation_passed,
        'gate_allowed': gate_allowed,
        'prerequisite_allowed': prerequisite_allowed,
        'evidence': evidence_summary.to_payload(),
        'strategy_factory': {
            'cost_calibration': cost_calibration_payload,
            'sequential_trial': sequential_trial_payload,
            'null_comparator_summary': strategy_factory.null_comparator_summary,
        },
        'recommendation_trace_id': recommendation_trace_id,
    }
    _write_json(recommendation_artifact_path, recommendation_payload)

    recommendation_stage_record = _write_stage_manifest(
        stage=_STAGE_RECOMMENDATION,
        stage_index=3,
        stage_output_dir=stages_output_dir,
        run_id=run_id,
        candidate_id=candidate_id,
        lineage_parent_hash=evaluation_stage_record.lineage_hash,
        lineage_parent_stage=evaluation_stage_record.stage,
        inputs={
            'run_id': run_id,
            'candidate_id': candidate_id,
            'recommendation_trace_id': recommendation_trace_id,
        },
        input_artifacts={
            'evaluation_report': evaluation_report_path,
            'cost_calibration': cost_calibration_path,
        },
        output_artifacts={
            'recommendation': recommendation_artifact_path,
            'sequential_trial': sequential_trial_path,
        },
        created_at=now,
    )
    stage_records.append(recommendation_stage_record)
    manifest_paths[_STAGE_RECOMMENDATION] = (
        stages_output_dir / f'{_STAGE_RECOMMENDATION}-manifest.json'
    )
    stage_trace_ids[_STAGE_RECOMMENDATION] = recommendation_stage_record.stage_trace_id

    stage_lineage_payload = _build_stage_lineage_payload(
        stage_records=stage_records,
        manifest_paths=manifest_paths,
    )
    replay_artifacts: dict[str, Path | None] = {
        'train_prices': train_snapshot_path,
        'test_prices': test_snapshot_path,
        'search_result': search_result_path,
        'best_candidate': best_candidate_path,
        'attempt_ledger': attempt_ledger_path,
        'evaluation_report': evaluation_report_path,
        'recommendation_artifact': recommendation_artifact_path,
        'sequential_trial': sequential_trial_path,
        'cost_calibration': cost_calibration_path,
        'candidate_generation_manifest': manifest_paths[_STAGE_CANDIDATE_GENERATION],
        'evaluation_manifest': manifest_paths[_STAGE_EVALUATION],
        'recommendation_manifest': manifest_paths[_STAGE_RECOMMENDATION],
    }
    for test_name, artifact_path in validation_artifact_paths.items():
        replay_artifacts[f'validation_{test_name}'] = artifact_path
    replay_artifact_hashes = _artifact_hashes(replay_artifacts)
    candidate_spec_payload = {
        'schema_version': 'alpha-candidate-spec-v2',
        'run_id': run_id,
        'candidate_id': candidate_id,
        'generated_at': now.isoformat(),
        'train_prices': {
            'path': str(train_snapshot_path),
            'sha256': _sha256_path(train_snapshot_path),
        },
        'test_prices': {
            'path': str(test_snapshot_path),
            'sha256': _sha256_path(test_snapshot_path),
        },
        'search': {
            'params': {
                'lookback_days': lookback_values,
                'vol_lookback_days': vol_lookback_values,
                'target_daily_vols': target_daily_vol_values,
                'max_gross_leverages': max_gross_leverage_values,
                'long_only': bool(long_only),
                'cost_bps_per_turnover': float(cost_bps_per_turnover),
            },
            'best_total_return': search_result.best.test.total_return,
            'best_sharpe': search_result.best.test.sharpe,
            'best_train_total_return': search_result.best.train.total_return,
            'best_train_sharpe': search_result.best.train.sharpe,
        },
        'strategy_factory': {
            'candidate_family': strategy_factory.candidate_family,
            'canonical_spec': strategy_factory.canonical_spec,
            'semantic_hash': strategy_factory.semantic_hash,
            'economic_rationale': strategy_factory.economic_rationale,
            'complexity_score': strategy_factory.complexity_score,
            'discovery_rank': strategy_factory.discovery_rank,
            'posterior_edge_summary': strategy_factory.posterior_edge_summary,
            'economic_validity_card': strategy_factory.economic_validity_card,
            'valid_regime_envelope': strategy_factory.valid_regime_envelope,
            'invalidation_clauses': strategy_factory.invalidation_clauses,
            'null_comparator_summary': strategy_factory.null_comparator_summary,
            'fold_stat_bundle': strategy_factory.fold_stat_bundle,
            'challenge_lane': bool(challenge_lane),
            'attempt_count': len(strategy_factory.attempts),
        },
        'artifacts': {
            key: str(value) for key, value in replay_artifacts.items() if value is not None
        },
        'replay_artifact_hashes': replay_artifact_hashes,
        'recommendation': recommendation.to_payload(),
        'evidence_summary': evidence_summary.to_payload(),
        'stage_manifest_refs': {
            _STAGE_CANDIDATE_GENERATION: str(
                manifest_paths[_STAGE_CANDIDATE_GENERATION]
            ),
            _STAGE_EVALUATION: str(manifest_paths[_STAGE_EVALUATION]),
            _STAGE_RECOMMENDATION: str(manifest_paths[_STAGE_RECOMMENDATION]),
        },
        'stage_trace_ids': {
            _STAGE_CANDIDATE_GENERATION: candidate_generation_stage_record.stage_trace_id,
            _STAGE_EVALUATION: evaluation_stage_record.stage_trace_id,
            _STAGE_RECOMMENDATION: recommendation_stage_record.stage_trace_id,
        },
        'stage_lineage': stage_lineage_payload,
        'input_context': {
            'repository': resolved_repository,
            'base': resolved_base,
            'head': resolved_head,
            'priority_id': resolved_priority_id,
        },
        'policy': _coerce_jsonable(policy_payload),
    }
    _write_json(candidate_spec_path, candidate_spec_payload)

    if persist_results and session_factory is not None:
        _persist_strategy_factory_results(
            session_factory=session_factory,
            run_id=run_id,
            candidate_id=candidate_id,
            now=now,
            requested_mode=requested_mode,
            resolved_repository=resolved_repository,
            resolved_head=resolved_head,
            train=train,
            test=test,
            search_result=search_result,
            stage_lineage_payload=stage_lineage_payload,
            stage_trace_ids=stage_trace_ids,
            manifest_paths=manifest_paths,
            replay_artifact_hashes=replay_artifact_hashes,
            recommendation_trace_id=recommendation_trace_id,
            strategy_factory_summary={
                'candidate_family': strategy_factory.candidate_family,
                'canonical_spec': strategy_factory.canonical_spec,
                'semantic_hash': strategy_factory.semantic_hash,
                'economic_rationale': strategy_factory.economic_rationale,
                'complexity_score': strategy_factory.complexity_score,
                'discovery_rank': strategy_factory.discovery_rank,
                'posterior_edge_summary': strategy_factory.posterior_edge_summary,
                'economic_validity_card': strategy_factory.economic_validity_card,
                'valid_regime_envelope': strategy_factory.valid_regime_envelope,
                'invalidation_clauses': strategy_factory.invalidation_clauses,
                'null_comparator_summary': strategy_factory.null_comparator_summary,
                'fold_stat_bundle': strategy_factory.fold_stat_bundle,
                'stress_results': strategy_factory.stress_results,
            },
            validation_payloads=validation_payloads,
            attempt_payload=attempt_payload,
            cost_calibration_payload=cost_calibration_payload,
            sequential_trial_payload=sequential_trial_payload,
            evaluation_passed=evaluation_passed,
            promotion_allowed=bool(recommendation.eligible),
            recommendation_payload=recommendation_payload,
            recommendation_rationale='strategy factory alpha recommendation',
        )

    _write_iteration_notes(
        artifact_root=notes_root,
        run_id=run_id,
        candidate_id=candidate_id,
        stage_records=stage_records,
        repository=resolved_repository,
        base=resolved_base,
        head=resolved_head,
        priority_id=resolved_priority_id,
    )

    return AlphaLaneResult(
        run_id=run_id,
        candidate_id=candidate_id,
        output_dir=output_dir,
        train_prices_path=train_snapshot_path,
        test_prices_path=test_snapshot_path,
        search_result_path=search_result_path,
        best_candidate_path=best_candidate_path,
        evaluation_report_path=evaluation_report_path,
        recommendation_artifact_path=recommendation_artifact_path,
        candidate_spec_path=candidate_spec_path,
        candidate_generation_manifest_path=manifest_paths[_STAGE_CANDIDATE_GENERATION],
        evaluation_manifest_path=manifest_paths[_STAGE_EVALUATION],
        recommendation_manifest_path=manifest_paths[_STAGE_RECOMMENDATION],
        attempt_ledger_path=attempt_ledger_path,
        validation_artifact_paths=validation_artifact_paths,
        sequential_trial_path=sequential_trial_path,
        cost_calibration_path=cost_calibration_path,
        recommendation_trace_id=recommendation_trace_id,
        stage_trace_ids=stage_trace_ids,
        stage_lineage_root=stage_records[0].lineage_hash if stage_records else None,
        paper_patch_path=None,
    )
