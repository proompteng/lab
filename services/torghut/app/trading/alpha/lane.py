"""Deterministic offline alpha discovery lane."""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any, Iterable, Literal, Mapping, Sequence, cast

import pandas as pd

from .metrics import to_jsonable
from .search import SearchResult, candidate_to_jsonable, run_tsmom_grid_search
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

    if (best.train.sharpe or float("-inf")) < float(min_train_sharpe):
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

    if (best.test.sharpe or float("-inf")) < float(min_test_sharpe):
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

    notes_path.write_text("\\n".join(lines), encoding="utf-8")
    return notes_path


def run_alpha_discovery_lane(
    *,
    artifact_path: Path,
    train_prices: pd.DataFrame,
    test_prices: pd.DataFrame,
    repository: str | None = None,
    base: str | None = None,
    head: str | None = None,
    priority_id: str | None = None,
    lookback_days: Iterable[int] = (20, 40, 60),
    vol_lookback_days: Iterable[int] = (10, 20, 40),
    target_daily_vols: Iterable[float] = (0.0075, 0.01, 0.0125),
    max_gross_leverages: Iterable[float] = (0.75, 1.0),
    long_only: bool = True,
    cost_bps_per_turnover: float = 5.0,
    gate_policy_path: Path | None = None,
    promotion_target: str = "paper",
    evaluated_at: datetime | None = None,
) -> AlphaLaneResult:
    """Run deterministic alpha candidate generation, evaluation, and recommendation."""

    train = _normalize_prices(train_prices, label="train")
    test = _normalize_prices(test_prices, label="test")
    if train.empty or test.empty:
        raise ValueError("train and test prices must be non-empty")

    now = evaluated_at or datetime.now(timezone.utc)
    output_dir = artifact_path
    research_dir = output_dir / "research"
    stages_output_dir = output_dir / "stages"
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
        "repository": repository or "",
        "base": base or "",
        "head": head or "",
        "priority_id": priority_id or "",
        "train_signature": _frame_signature(train),
        "test_signature": _frame_signature(test),
        "lookback_days": lookback_values,
        "vol_lookback_days": vol_lookback_values,
        "target_daily_vols": target_daily_vol_values,
        "max_gross_leverages": max_gross_leverage_values,
        "long_only": bool(long_only),
        "cost_bps_per_turnover": float(cost_bps_per_turnover),
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
            "run_id": run_id,
            "candidate_id": candidate_id,
            "repository": repository or "",
            "base": base or "",
            "head": head or "",
            "priority_id": priority_id or "",
        },
        input_artifacts={
            "train_prices": train_snapshot_path,
            "test_prices": test_snapshot_path,
            "gate_policy": gate_policy_path,
        },
        output_artifacts={
            "search_result": search_result_path,
            "best_candidate": best_candidate_path,
        },
        created_at=now,
    )
    stage_records.append(candidate_generation_stage_record)
    manifest_paths[_STAGE_CANDIDATE_GENERATION] = (
        stages_output_dir / f"{_STAGE_CANDIDATE_GENERATION}-manifest.json"
    )
    stage_trace_ids[_STAGE_CANDIDATE_GENERATION] = (
        candidate_generation_stage_record.stage_trace_id
    )

    evaluation_passed, checks, reasons, evaluation_context = _evaluate_candidate(
        search_result,
        policy_payload,
    )
    evidence_summary = PromotionEvidenceSummary(
        fold_metrics_count=1,
        stress_metrics_count=1,
        rationale_present=True,
        evidence_complete=len(checks) > 0 and all(
            item.get("status") == "pass" for item in checks
        ),
        reasons=sorted(reasons),
    )
    recommendation = build_promotion_recommendation(
        run_id=run_id,
        candidate_id=candidate_id,
        requested_mode=requested_mode,
        recommended_mode=requested_mode,
        gate_allowed=evaluation_passed,
        prerequisite_allowed=True,
        rollback_ready=True,
        fold_metrics_count=1,
        stress_metrics_count=1,
        rationale="alpha lane recommendation",
        reasons=sorted(reasons),
    )
    recommendation_trace_id = recommendation.trace_id

    evaluation_payload = {
        "schema_version": "alpha-evaluation-v1",
        "run_id": run_id,
        "candidate_id": candidate_id,
        "policy": _coerce_jsonable(policy_payload),
        "search_accepted": search_result.accepted,
        "search_reason": search_result.reason,
        "checks": checks,
        "evaluation_passed": evaluation_passed,
        "recommendation": recommendation.to_payload(),
        "evidence": {
            "best_total_return": search_result.best.test.total_return,
            "best_sharpe": search_result.best.test.sharpe,
            "best_train_total_return": search_result.best.train.total_return,
            "best_train_sharpe": search_result.best.train.sharpe,
            "best_test_max_drawdown": search_result.best.test.max_drawdown,
            "top_n": 5,
        },
        "evidence_summary": evidence_summary.to_payload(),
        "evaluation_context": _coerce_jsonable(evaluation_context),
        "summary": {
            "train": {
                "rows": int(train.shape[0]),
                "symbols": int(train.shape[1]),
                "columns": [str(column) for column in train.columns],
            },
            "test": {
                "rows": int(test.shape[0]),
                "symbols": int(test.shape[1]),
                "columns": [str(column) for column in test.columns],
            },
        },
        "evidence_detail": {
            "best_train": to_jsonable(search_result.best.train),
            "best_test": to_jsonable(search_result.best.test),
        },
    }
    evaluation_report_path.write_text(
        json.dumps(evaluation_payload, indent=2),
        encoding="utf-8",
    )

    evaluation_stage_record = _write_stage_manifest(
        stage=_STAGE_EVALUATION,
        stage_index=2,
        stage_output_dir=stages_output_dir,
        run_id=run_id,
        candidate_id=candidate_id,
        lineage_parent_hash=candidate_generation_stage_record.lineage_hash,
        lineage_parent_stage=candidate_generation_stage_record.stage,
        inputs={
            "run_id": run_id,
            "candidate_id": candidate_id,
            "recommendation_trace_id": recommendation_trace_id,
        },
        input_artifacts={
            "search_result": search_result_path,
            "best_candidate": best_candidate_path,
        },
        output_artifacts={
            "evaluation_report": evaluation_report_path,
        },
        created_at=now,
    )
    stage_records.append(evaluation_stage_record)
    manifest_paths[_STAGE_EVALUATION] = (
        stages_output_dir / f"{_STAGE_EVALUATION}-manifest.json"
    )
    stage_trace_ids[_STAGE_EVALUATION] = evaluation_stage_record.stage_trace_id

    recommendation_payload: dict[str, Any] = {
        "schema_version": "alpha-promotion-recommendation-v1",
        "run_id": run_id,
        "candidate_id": candidate_id,
        "promotion_target": requested_mode,
        "recommendation": recommendation.to_payload(),
        "checks": {
            "policy": _coerce_jsonable(policy_payload),
            "evaluation_checks": checks,
        },
        "evaluation_passed": evaluation_passed,
        "evidence": evidence_summary.to_payload(),
        "recommendation_trace_id": recommendation_trace_id,
    }
    recommendation_artifact_path.write_text(
        json.dumps(recommendation_payload, indent=2),
        encoding="utf-8",
    )

    recommendation_stage_record = _write_stage_manifest(
        stage=_STAGE_RECOMMENDATION,
        stage_index=3,
        stage_output_dir=stages_output_dir,
        run_id=run_id,
        candidate_id=candidate_id,
        lineage_parent_hash=evaluation_stage_record.lineage_hash,
        lineage_parent_stage=evaluation_stage_record.stage,
        inputs={
            "run_id": run_id,
            "candidate_id": candidate_id,
            "recommendation_trace_id": recommendation_trace_id,
        },
        input_artifacts={
            "evaluation_report": evaluation_report_path,
        },
        output_artifacts={
            "recommendation": recommendation_artifact_path,
        },
        created_at=now,
    )
    stage_records.append(recommendation_stage_record)
    manifest_paths[_STAGE_RECOMMENDATION] = (
        stages_output_dir / f"{_STAGE_RECOMMENDATION}-manifest.json"
    )
    stage_trace_ids[_STAGE_RECOMMENDATION] = recommendation_stage_record.stage_trace_id

    stage_lineage_payload = _build_stage_lineage_payload(
        stage_records=stage_records,
        manifest_paths=manifest_paths,
    )
    replay_artifact_hashes = _artifact_hashes(
        {
            "train_prices": train_snapshot_path,
            "test_prices": test_snapshot_path,
            "search_result": search_result_path,
            "best_candidate": best_candidate_path,
            "evaluation_report": evaluation_report_path,
            "recommendation_artifact": recommendation_artifact_path,
            "candidate_generation_manifest": manifest_paths[_STAGE_CANDIDATE_GENERATION],
            "evaluation_manifest": manifest_paths[_STAGE_EVALUATION],
            "recommendation_manifest": manifest_paths[_STAGE_RECOMMENDATION],
        }
    )
    candidate_spec_payload = {
        "schema_version": "alpha-candidate-spec-v1",
        "run_id": run_id,
        "candidate_id": candidate_id,
        "generated_at": now.isoformat(),
        "train_prices": {
            "path": str(train_snapshot_path),
            "sha256": _sha256_path(train_snapshot_path),
        },
        "test_prices": {
            "path": str(test_snapshot_path),
            "sha256": _sha256_path(test_snapshot_path),
        },
        "search": {
            "params": {
                "lookback_days": lookback_values,
                "vol_lookback_days": vol_lookback_values,
                "target_daily_vols": target_daily_vol_values,
                "max_gross_leverages": max_gross_leverage_values,
                "long_only": bool(long_only),
                "cost_bps_per_turnover": float(cost_bps_per_turnover),
            },
            "best_total_return": search_result.best.test.total_return,
            "best_sharpe": search_result.best.test.sharpe,
            "best_train_total_return": search_result.best.train.total_return,
            "best_train_sharpe": search_result.best.train.sharpe,
        },
        "artifacts": {
            "train_prices": str(train_snapshot_path),
            "test_prices": str(test_snapshot_path),
            "search_result": str(search_result_path),
            "best_candidate": str(best_candidate_path),
            "evaluation_report": str(evaluation_report_path),
            "recommendation_artifact": str(recommendation_artifact_path),
            "candidate_generation_manifest": str(manifest_paths[_STAGE_CANDIDATE_GENERATION]),
            "evaluation_manifest": str(manifest_paths[_STAGE_EVALUATION]),
            "recommendation_manifest": str(manifest_paths[_STAGE_RECOMMENDATION]),
        },
        "replay_artifact_hashes": replay_artifact_hashes,
        "recommendation": recommendation.to_payload(),
        "evidence_summary": evidence_summary.to_payload(),
        "stage_manifest_refs": {
            _STAGE_CANDIDATE_GENERATION: str(
                manifest_paths[_STAGE_CANDIDATE_GENERATION]
            ),
            _STAGE_EVALUATION: str(manifest_paths[_STAGE_EVALUATION]),
            _STAGE_RECOMMENDATION: str(manifest_paths[_STAGE_RECOMMENDATION]),
        },
        "stage_trace_ids": {
            _STAGE_CANDIDATE_GENERATION: candidate_generation_stage_record.stage_trace_id,
            _STAGE_EVALUATION: evaluation_stage_record.stage_trace_id,
            _STAGE_RECOMMENDATION: recommendation_stage_record.stage_trace_id,
        },
        "stage_lineage": stage_lineage_payload,
        "input_context": {
            "repository": repository,
            "base": base,
            "head": head,
            "priority_id": priority_id,
        },
        "policy": _coerce_jsonable(policy_payload),
    }
    candidate_spec_path.write_text(
        json.dumps(candidate_spec_payload, indent=2),
        encoding="utf-8",
    )

    _write_iteration_notes(
        artifact_root=output_dir,
        run_id=run_id,
        candidate_id=candidate_id,
        stage_records=stage_records,
        repository=repository,
        base=base,
        head=head,
        priority_id=priority_id,
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
        recommendation_trace_id=recommendation_trace_id,
        stage_trace_ids=stage_trace_ids,
        stage_lineage_root=stage_records[0].lineage_hash if stage_records else None,
        paper_patch_path=None,
    )
