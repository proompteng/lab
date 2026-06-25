"""Extracted Torghut API route and support functions."""

from __future__ import annotations

import json
from collections.abc import Mapping
from decimal import Decimal
from pathlib import Path
from typing import cast

from sqlalchemy import func, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.api.common import logger
from app.db import SessionLocal
from app.models import (
    VNextDatasetSnapshot,
    VNextExperimentRun,
    VNextExperimentSpec,
    VNextFeatureViewSpec,
    VNextModelArtifact,
    VNextPromotionDecision,
    VNextShadowLiveDeviation,
    VNextSimulationCalibration,
)
from app.trading.llm.evaluation import build_llm_evaluation_metrics
from app.trading.scheduler import TradingScheduler

from .health_checks import sqlalchemy_error_indicates_statement_timeout

_sqlalchemy_error_indicates_statement_timeout = (
    sqlalchemy_error_indicates_statement_timeout
)


def _rollback_status_read_session(session: Session, *, context: str) -> None:
    from .status_helpers import rollback_status_read_session as rollback

    rollback(session, context=context)


def _apply_status_read_statement_timeout(
    session: Session,
    *,
    milliseconds: int,
) -> None:
    from .status_helpers import (
        apply_status_read_statement_timeout as apply_statement_timeout,
    )

    apply_statement_timeout(session, milliseconds=milliseconds)


def _budget_unavailable_llm_evaluation_payload(reason: str) -> dict[str, object]:
    from .status_helpers import (
        budget_unavailable_llm_evaluation_payload as budget_unavailable_payload,
    )

    return budget_unavailable_payload(reason)


def _build_autonomy_bridge_status(
    scheduler: TradingScheduler,
) -> dict[str, object]:
    gate_artifact_path = str(
        getattr(scheduler.state, "last_autonomy_gates", "") or ""
    ).strip()
    gate_payload = _load_json_artifact_payload(gate_artifact_path)
    actuation_artifact_path = str(
        getattr(scheduler.state, "last_autonomy_actuation_intent", "") or ""
    ).strip()
    actuation_payload = _load_json_artifact_payload(actuation_artifact_path)
    actuation_gates = _to_str_map(actuation_payload.get("gates"))
    provenance_payload = _to_str_map(gate_payload.get("provenance"))
    drift_path = str(
        getattr(scheduler.state, "drift_last_outcome_path", "") or ""
    ).strip()
    drift_payload = _load_json_artifact_payload(drift_path)
    drift_reasons_raw = drift_payload.get("reasons")
    drift_reason_codes_raw = drift_payload.get("reason_codes")
    drift_eligible = drift_payload.get("eligible_for_live_promotion")
    metrics_payload = _to_str_map(gate_payload.get("metrics"))
    drawdown = None
    max_drawdown_raw = metrics_payload.get("max_drawdown")
    if max_drawdown_raw is not None:
        try:
            drawdown = abs(float(str(max_drawdown_raw)))
        except (TypeError, ValueError):
            drawdown = None

    if not gate_payload:
        return {
            "source": "unavailable",
            "run_id": str(gate_payload.get("run_id") or "").strip() or None,
            "strategy_compilation": {
                "total": 0,
                "spec_compiled": 0,
                "compiler_sources": [],
            },
            "simulation_calibration": None,
            "shadow_live_deviation": None,
            "evidence_authority": {
                "gate_report_trace_id": None,
                "recommendation_trace_id": None,
                "authoritative_count": 0,
                "total_count": 0,
                "missing": [],
            },
            "persisted_vnext_objects": None,
        }

    source = "gate_report"
    if (
        str(gate_payload.get("status") or "").strip() == "skipped"
        and str(gate_payload.get("dataset_snapshot_ref") or "").strip()
        == "no_signal_window"
    ):
        source = "no_signal"

    promotion_evidence_raw = gate_payload.get("promotion_evidence")
    promotion_evidence = (
        cast(dict[str, object], promotion_evidence_raw)
        if isinstance(promotion_evidence_raw, dict)
        else {}
    )
    dependency_quorum_payload = (
        cast(dict[str, object], gate_payload.get("dependency_quorum"))
        if isinstance(gate_payload.get("dependency_quorum"), dict)
        else {}
    )
    alpha_readiness_payload = (
        cast(dict[str, object], gate_payload.get("alpha_readiness"))
        if isinstance(gate_payload.get("alpha_readiness"), dict)
        else {}
    )
    authority_raw = provenance_payload.get("promotion_evidence_authority")
    authority_payload = (
        cast(dict[str, object], authority_raw)
        if isinstance(authority_raw, dict)
        else {}
    )
    vnext_raw = gate_payload.get("vnext")
    vnext_payload = (
        cast(dict[str, object], vnext_raw) if isinstance(vnext_raw, dict) else {}
    )
    strategy_compilation_raw = vnext_payload.get("strategy_compilation")
    portfolio_promotion_raw = vnext_payload.get("portfolio_promotion")
    strategy_compilation_items = (
        [
            cast(dict[str, object], item)
            for item in cast(list[object], strategy_compilation_raw)
            if isinstance(item, dict)
        ]
        if isinstance(strategy_compilation_raw, list)
        else []
    )
    spec_compiled = sum(
        1 for item in strategy_compilation_items if bool(item.get("spec_compiled"))
    )
    compiler_sources = sorted(
        {
            str(item.get("compiler_source") or "").strip()
            for item in strategy_compilation_items
            if str(item.get("compiler_source") or "").strip()
        }
    )

    authoritative_count = 0
    missing_authority: list[str] = []
    for evidence_name in promotion_evidence:
        authority_value = authority_payload.get(evidence_name)
        if not isinstance(authority_value, Mapping):
            missing_authority.append(str(evidence_name))
            continue
        if bool(cast(Mapping[object, object], authority_value).get("authoritative")):
            authoritative_count += 1

    return {
        "source": source,
        "run_id": str(gate_payload.get("run_id") or "").strip() or None,
        "strategy_compilation": {
            "total": len(strategy_compilation_items),
            "spec_compiled": spec_compiled,
            "compiler_sources": compiler_sources,
        },
        "dependency_quorum": (
            dependency_quorum_payload if dependency_quorum_payload else None
        ),
        "alpha_readiness": (
            alpha_readiness_payload if alpha_readiness_payload else None
        ),
        "portfolio_promotion": (
            cast(dict[str, object], portfolio_promotion_raw)
            if isinstance(portfolio_promotion_raw, dict)
            else None
        ),
        "simulation_calibration": (
            promotion_evidence.get("simulation_calibration")
            if isinstance(promotion_evidence.get("simulation_calibration"), dict)
            else None
        ),
        "shadow_live_deviation": {
            **(
                cast(dict[str, object], promotion_evidence.get("shadow_live_deviation"))
                if isinstance(promotion_evidence.get("shadow_live_deviation"), dict)
                else {}
            ),
            "drift_status": getattr(scheduler.state, "drift_status", None),
            "eligible_for_live_promotion": (
                bool(drift_eligible) if drift_eligible is not None else None
            ),
            "reason_codes": (
                [
                    str(item)
                    for item in cast(list[object], drift_reason_codes_raw)
                    if str(item).strip()
                ]
                if isinstance(drift_reason_codes_raw, list)
                else []
            ),
            "reasons": (
                [
                    str(item)
                    for item in cast(list[object], drift_reasons_raw)
                    if str(item).strip()
                ]
                if isinstance(drift_reasons_raw, list)
                else []
            ),
            "max_drawdown": drawdown,
        }
        if source == "gate_report"
        else None,
        "evidence_authority": {
            "gate_report_trace_id": str(
                provenance_payload.get("gate_report_trace_id")
                or actuation_gates.get("gate_report_trace_id")
                or ""
            ).strip()
            or None,
            "recommendation_trace_id": str(
                provenance_payload.get("recommendation_trace_id")
                or actuation_gates.get("recommendation_trace_id")
                or ""
            ).strip()
            or None,
            "authoritative_count": authoritative_count,
            "total_count": len(promotion_evidence),
            "missing": sorted(set(missing_authority)),
        },
        "persisted_vnext_objects": _build_persisted_vnext_status(
            str(gate_payload.get("run_id") or "").strip() or None
        ),
    }


def _build_persisted_vnext_status(run_id: str | None) -> dict[str, object] | None:
    if not run_id:
        return None
    try:
        with SessionLocal() as session:
            dataset_snapshots = session.execute(
                select(func.count(VNextDatasetSnapshot.id)).where(
                    VNextDatasetSnapshot.run_id == run_id
                )
            ).scalar_one()
            feature_view_specs = session.execute(
                select(func.count(VNextFeatureViewSpec.id)).where(
                    VNextFeatureViewSpec.run_id == run_id
                )
            ).scalar_one()
            model_artifacts = session.execute(
                select(func.count(VNextModelArtifact.id)).where(
                    VNextModelArtifact.run_id == run_id
                )
            ).scalar_one()
            experiment_specs = session.execute(
                select(func.count(VNextExperimentSpec.id)).where(
                    VNextExperimentSpec.run_id == run_id
                )
            ).scalar_one()
            experiment_runs = session.execute(
                select(func.count(VNextExperimentRun.id)).where(
                    VNextExperimentRun.run_id == run_id
                )
            ).scalar_one()
            simulation_calibrations = session.execute(
                select(func.count(VNextSimulationCalibration.id)).where(
                    VNextSimulationCalibration.run_id == run_id
                )
            ).scalar_one()
            shadow_live_deviations = session.execute(
                select(func.count(VNextShadowLiveDeviation.id)).where(
                    VNextShadowLiveDeviation.run_id == run_id
                )
            ).scalar_one()
            promotion_decisions = session.execute(
                select(func.count(VNextPromotionDecision.id)).where(
                    VNextPromotionDecision.run_id == run_id
                )
            ).scalar_one()
    except Exception:
        return None

    return {
        "dataset_snapshots": int(dataset_snapshots),
        "feature_view_specs": int(feature_view_specs),
        "model_artifacts": int(model_artifacts),
        "experiment_specs": int(experiment_specs),
        "experiment_runs": int(experiment_runs),
        "simulation_calibrations": int(simulation_calibrations),
        "shadow_live_deviations": int(shadow_live_deviations),
        "promotion_decisions_v2": int(promotion_decisions),
    }


def _load_json_artifact_payload(path: str) -> dict[str, object]:
    if not path:
        return {}
    if "://" in path and not path.startswith("file://"):
        return {}
    resolved = Path(path.replace("file://", "", 1))
    if not resolved.exists() or not resolved.is_file():
        return {}
    try:
        payload = json.loads(resolved.read_text(encoding="utf-8"))
    except Exception:
        return {}
    if isinstance(payload, dict):
        return cast(dict[str, object], payload)
    return {}


def _extract_gate_result(gates: list[object], *, gate_id: str) -> dict[str, object]:
    for raw_gate in gates:
        if not isinstance(raw_gate, Mapping):
            continue
        gate = cast(Mapping[object, object], raw_gate)
        gate_name = str(gate.get("gate_id") or "").strip()
        if gate_name != gate_id:
            continue
        reasons_raw = gate.get("reasons")
        artifact_refs_raw = gate.get("artifact_refs")
        return {
            "gate_id": gate_name,
            "status": str(gate.get("status") or "unknown").strip() or "unknown",
            "reasons": (
                [
                    str(item)
                    for item in cast(list[object], reasons_raw)
                    if str(item).strip()
                ]
                if isinstance(reasons_raw, list)
                else []
            ),
            "artifact_refs": (
                [
                    str(item)
                    for item in cast(list[object], artifact_refs_raw)
                    if str(item).strip()
                ]
                if isinstance(artifact_refs_raw, list)
                else []
            ),
        }
    return {
        "gate_id": gate_id,
        "status": "unknown",
        "reasons": [],
        "artifact_refs": [],
    }


def _to_str_map(value: object) -> dict[str, object]:
    if not isinstance(value, Mapping):
        return {}
    source = cast(Mapping[object, object], value)
    return {str(key): item for key, item in source.items()}


def _normalized_adapter_name(value: str | None) -> str:
    normalized = str(value or "").strip().lower()
    return normalized or "unknown"


def _decimal_average(values: list[Decimal]) -> Decimal | None:
    if not values:
        return None
    return sum(values, Decimal("0")) / Decimal(len(values))


def _decimal_percentile(values: list[Decimal], percentile: int) -> Decimal | None:
    if not values:
        return None
    bounded = max(1, min(100, percentile))
    ordered = sorted(values)
    index = ((len(ordered) * bounded) + 99) // 100 - 1
    if index < 0:
        index = 0
    return ordered[index]


def _decimal_to_string(value: Decimal | None) -> str | None:
    if value is None:
        return None
    text = format(value, "f")
    if "." not in text:
        return text
    normalized = text.rstrip("0").rstrip(".")
    return normalized or "0"


def _safe_int(value: object) -> int:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    return 0


def _safe_float(value: object) -> float:
    if isinstance(value, bool):
        return float(value)
    if isinstance(value, (int, float)):
        return float(value)
    return 0.0


def _load_llm_evaluation(session: Session) -> dict[str, object]:
    try:
        _apply_status_read_statement_timeout(session, milliseconds=500)
        return build_llm_evaluation_metrics(session)
    except SQLAlchemyError as exc:
        logger.warning("LLM evaluation status summary unavailable: %s", exc)
        _rollback_status_read_session(session, context="LLM evaluation")
        reason = (
            "llm_evaluation_query_timeout"
            if _sqlalchemy_error_indicates_statement_timeout(exc)
            else "database_unavailable"
        )
        return _budget_unavailable_llm_evaluation_payload(reason)


build_autonomy_bridge_status = _build_autonomy_bridge_status
load_json_artifact_payload = _load_json_artifact_payload
extract_gate_result = _extract_gate_result
to_str_map = _to_str_map
normalized_adapter_name = _normalized_adapter_name
decimal_average = _decimal_average
decimal_percentile = _decimal_percentile
decimal_to_string = _decimal_to_string
safe_int = _safe_int
safe_float = _safe_float
load_llm_evaluation = _load_llm_evaluation


__all__ = [
    "_build_autonomy_bridge_status",
    "_build_persisted_vnext_status",
    "_load_json_artifact_payload",
    "_extract_gate_result",
    "_to_str_map",
    "_normalized_adapter_name",
    "_decimal_average",
    "_decimal_percentile",
    "_decimal_to_string",
    "_safe_int",
    "_safe_float",
    "_load_llm_evaluation",
    "build_autonomy_bridge_status",
    "load_json_artifact_payload",
    "extract_gate_result",
    "to_str_map",
    "normalized_adapter_name",
    "decimal_average",
    "decimal_percentile",
    "decimal_to_string",
    "safe_int",
    "safe_float",
    "load_llm_evaluation",
]
