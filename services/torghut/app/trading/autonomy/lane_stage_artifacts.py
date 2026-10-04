"""Stage manifest and artifact payload helpers for the autonomous lane."""

from __future__ import annotations

import json
import re
from datetime import datetime
from pathlib import Path
from typing import Any, Mapping, Sequence, cast

from ..evidence_contracts import (
    ArtifactProvenance,
    EvidenceMaturity,
    contract_from_artifact_payload,
    evidence_contract_payload,
)
from .runtime import StrategyRuntimeConfig
from .lane_common import (
    AUTONOMY_LANE_SCHEMA_VERSION as _AUTONOMY_LANE_SCHEMA_VERSION,
    StageManifestRecord as _StageManifestRecord,
    as_object_dict as _as_object_dict,
    safe_int as _safe_int,
    sha256_path as _sha256_path,
    stable_hash as _stable_hash,
)


def _artifact_hashes(artifacts: Mapping[str, Path | None]) -> dict[str, str]:
    digests: dict[str, str] = {}
    for key, artifact_path in artifacts.items():
        if artifact_path is not None and artifact_path.exists():
            digests[key] = _sha256_path(artifact_path)
    return digests


def _readable_notes_iteration_number(notes_dir: Path) -> int:
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
        "schema_version": _AUTONOMY_LANE_SCHEMA_VERSION,
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
        "schema_version": _AUTONOMY_LANE_SCHEMA_VERSION,
        "root_lineage_hash": stage_records[0].lineage_hash if stage_records else None,
        "stages": stages_payload,
    }


def _manifest_relative_path(artifact_root: Path, artifact_path: Path) -> str:
    try:
        return str(artifact_path.relative_to(artifact_root))
    except ValueError:
        return str(artifact_path)


def _artifact_authority_for_check(
    *,
    stage_name: str,
    check_name: str,
) -> dict[str, Any] | None:
    if check_name in {
        "benchmark_parity_present",
        "foundation_router_parity_present",
        "janus_event_car_present",
        "janus_hgrm_reward_present",
        "expert_router_registry_present",
        "hmm_state_posterior_present",
    }:
        return evidence_contract_payload(
            provenance=ArtifactProvenance.SYNTHETIC_GENERATED,
            maturity=EvidenceMaturity.STUB,
            authoritative=False,
            placeholder=True,
            notes="Deterministic scaffold artifact; never promotion-authoritative.",
        )
    if check_name in {
        "evaluation_report_present",
        "walkforward_results_present",
        "baseline_evaluation_report_present",
        "profitability_benchmark_present",
        "profitability_evidence_present",
        "profitability_validation_present",
        "contamination_registry_present",
        "advisor_fallback_slo_present",
        "recalibration_report_present",
        "gate_report_present",
    }:
        return evidence_contract_payload(
            provenance=ArtifactProvenance.HISTORICAL_MARKET_REPLAY,
            maturity=EvidenceMaturity.UNCALIBRATED,
            calibration_summary={
                "status": "pending_calibration",
                "stage": stage_name,
                "check": check_name,
            },
        )
    return None


def _artifact_authority_for_evidence(name: str) -> dict[str, Any]:
    evidence_name = name.strip().lower()
    if evidence_name in {
        "benchmark_parity",
        "foundation_router_parity",
        "janus_event_car",
        "janus_hgrm_reward",
        "janus_q",
        "hmm_state_posterior",
        "expert_router_registry",
        "deeplob_bdlob_contract",
    }:
        return evidence_contract_payload(
            provenance=ArtifactProvenance.SYNTHETIC_GENERATED,
            maturity=EvidenceMaturity.STUB,
            authoritative=False,
            placeholder=True,
            notes="Synthetic or deterministic scaffold evidence; blocked for promotion.",
        )
    return evidence_contract_payload(
        provenance=ArtifactProvenance.HISTORICAL_MARKET_REPLAY,
        maturity=EvidenceMaturity.UNCALIBRATED,
        calibration_summary={
            "status": "pending_calibration",
            "evidence_name": evidence_name,
        },
    )


def _empirical_artifact_authority(
    *,
    evidence_name: str,
    provenance: ArtifactProvenance = ArtifactProvenance.HISTORICAL_MARKET_REPLAY,
) -> dict[str, Any]:
    return evidence_contract_payload(
        provenance=provenance,
        maturity=EvidenceMaturity.EMPIRICALLY_VALIDATED,
        authoritative=True,
        placeholder=False,
        calibration_summary={
            "status": "external_empirical_source",
            "evidence_name": evidence_name,
        },
        notes="Artifact loaded from configured empirical source.",
    )


def _resolve_optional_service_path(raw_value: str | None) -> Path | None:
    normalized = (raw_value or "").strip()
    if not normalized:
        return None
    path = Path(normalized).expanduser()
    if path.is_absolute():
        return path
    service_root = Path(__file__).resolve().parents[3]
    return service_root / path


def _load_configured_empirical_payload(
    *,
    path_value: str | None,
    expected_schema_version: str | None,
    evidence_name: str,
    provenance: ArtifactProvenance = ArtifactProvenance.HISTORICAL_MARKET_REPLAY,
) -> dict[str, Any] | None:
    resolved = _resolve_optional_service_path(path_value)
    if resolved is None or not resolved.exists() or not resolved.is_file():
        return None
    raw_payload = json.loads(resolved.read_text(encoding="utf-8"))
    if not isinstance(raw_payload, dict):
        raise RuntimeError(f"configured_empirical_payload_invalid:{resolved}")
    payload = dict(cast(dict[str, Any], raw_payload))
    schema_version = str(payload.get("schema_version") or "").strip()
    if expected_schema_version and schema_version != expected_schema_version:
        raise RuntimeError(
            f"configured_empirical_payload_schema_mismatch:{resolved}:{schema_version}"
        )
    if not isinstance(payload.get("artifact_authority"), dict):
        payload["artifact_authority"] = _empirical_artifact_authority(
            evidence_name=evidence_name,
            provenance=provenance,
        )
    return payload


def _build_janus_q_summary_from_payloads(
    *,
    event_car_payload: dict[str, Any],
    hgrm_reward_payload: dict[str, Any],
    event_car_artifact_ref: str,
    hgrm_reward_artifact_ref: str,
) -> dict[str, object]:
    event_summary = (
        cast(dict[str, Any], event_car_payload.get("summary"))
        if isinstance(event_car_payload.get("summary"), dict)
        else {}
    )
    reward_summary = (
        cast(dict[str, Any], hgrm_reward_payload.get("summary"))
        if isinstance(hgrm_reward_payload.get("summary"), dict)
        else {}
    )
    event_count = int(event_summary.get("event_count", 0) or 0)
    reward_count = int(reward_summary.get("reward_count", 0) or 0)
    mapped_count = int(reward_summary.get("event_mapped_count", 0) or 0)
    reasons: list[str] = []
    if event_count <= 0:
        reasons.append("janus_event_count_missing")
    if reward_count <= 0:
        reasons.append("janus_reward_count_missing")
    if reward_count > 0 and mapped_count < reward_count:
        reasons.append("janus_reward_event_mapping_incomplete")
    return {
        "schema_version": "janus-q-evidence-v1",
        "evidence_complete": not reasons,
        "reasons": reasons,
        "event_car": {
            "schema_version": event_car_payload.get("schema_version"),
            "event_count": event_count,
            "manifest_hash": event_car_payload.get("manifest_hash"),
            "artifact_ref": event_car_artifact_ref,
        },
        "hgrm_reward": {
            "schema_version": hgrm_reward_payload.get("schema_version"),
            "reward_count": reward_count,
            "event_mapped_count": mapped_count,
            "direction_gate_pass_ratio": str(
                reward_summary.get("direction_gate_pass_ratio", "0")
            ),
            "manifest_hash": hgrm_reward_payload.get("manifest_hash"),
            "artifact_ref": hgrm_reward_artifact_ref,
        },
    }


def _build_bridge_evidence_payload(
    report_payload: dict[str, Any],
    *,
    artifact_ref: str,
    summary_fields: Sequence[str],
) -> dict[str, Any]:
    artifact_authority = report_payload.get("artifact_authority")
    payload: dict[str, Any] = {
        "artifact_ref": artifact_ref,
        "artifact_authority": (
            cast(dict[str, Any], artifact_authority)
            if isinstance(artifact_authority, dict)
            else {}
        ),
        "schema_version": str(report_payload.get("schema_version", "")).strip(),
        "status": str(report_payload.get("status", "")).strip(),
    }
    for field_name in summary_fields:
        if field_name in report_payload:
            payload[field_name] = report_payload[field_name]
    return payload


def _build_vnext_gate_summary(
    *,
    runtime_strategies: list[StrategyRuntimeConfig],
    simulation_calibration_payload: dict[str, Any],
    shadow_live_deviation_payload: dict[str, Any],
    dependency_quorum_payload: Mapping[str, Any] | None = None,
    hypothesis_registry_payload: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "strategy_compilation": [
            {
                "strategy_id": strategy.strategy_id,
                "strategy_type": strategy.strategy_type,
                "version": strategy.version,
                "compiler_source": strategy.compiler_source,
                "spec_compiled": strategy.compiler_source == "spec_v2",
            }
            for strategy in runtime_strategies
        ],
        "simulation_calibration": {
            key: simulation_calibration_payload.get(key)
            for key in (
                "schema_version",
                "status",
                "order_count",
                "expected_shortfall_sample_count",
                "expected_shortfall_coverage",
                "avg_calibration_error_bps",
                "confidence_gate_action",
                "artifact_authority",
            )
            if key in simulation_calibration_payload
        },
        "shadow_live_deviation": {
            key: shadow_live_deviation_payload.get(key)
            for key in (
                "schema_version",
                "status",
                "order_count",
                "decision_count",
                "trade_count",
                "avg_abs_slippage_bps",
                "avg_abs_divergence_bps",
                "deviation_budget_utilization",
                "artifact_authority",
            )
            if key in shadow_live_deviation_payload
        },
        "portfolio_promotion": _build_portfolio_promotion_summary(runtime_strategies),
    }
    if dependency_quorum_payload is not None:
        payload["dependency_quorum"] = dict(dependency_quorum_payload)
    if hypothesis_registry_payload is not None:
        payload["hypothesis_registry"] = dict(hypothesis_registry_payload)
    return payload


def _build_portfolio_promotion_summary(
    runtime_strategies: Sequence[StrategyRuntimeConfig],
) -> dict[str, Any]:
    strategy_items = list(runtime_strategies)
    spec_compiled_count = sum(
        1 for item in strategy_items if item.compiler_source == "spec_v2"
    )
    symbol_usage: dict[str, list[str]] = {}
    missing_policy_refs: set[str] = set()
    promotion_policy_refs: set[str] = set()
    risk_profile_refs: set[str] = set()
    sizing_policy_refs: set[str] = set()
    execution_policy_refs: set[str] = set()

    for strategy in strategy_items:
        universe = (
            cast(dict[str, Any], strategy.strategy_spec.get("universe"))
            if isinstance(strategy.strategy_spec.get("universe"), dict)
            else {}
        )
        raw_symbols = universe.get("symbols")
        if isinstance(raw_symbols, list):
            for raw_symbol in cast(list[object], raw_symbols):
                symbol = str(raw_symbol).strip().upper()
                if not symbol:
                    continue
                symbol_usage.setdefault(symbol, []).append(strategy.strategy_id)
        promotion_metadata = (
            cast(dict[str, Any], strategy.compiled_targets.get("promotion_metadata"))
            if isinstance(strategy.compiled_targets.get("promotion_metadata"), dict)
            else {}
        )
        promotion_policy_ref = str(
            promotion_metadata.get("promotion_policy_ref") or ""
        ).strip()
        risk_profile_ref = str(promotion_metadata.get("risk_profile_ref") or "").strip()
        sizing_policy_ref = str(
            promotion_metadata.get("sizing_policy_ref") or ""
        ).strip()
        execution_policy_ref = str(
            promotion_metadata.get("execution_policy_ref") or ""
        ).strip()
        if promotion_policy_ref:
            promotion_policy_refs.add(promotion_policy_ref)
        else:
            missing_policy_refs.add(f"{strategy.strategy_id}:promotion_policy_ref")
        if risk_profile_ref:
            risk_profile_refs.add(risk_profile_ref)
        else:
            missing_policy_refs.add(f"{strategy.strategy_id}:risk_profile_ref")
        if sizing_policy_ref:
            sizing_policy_refs.add(sizing_policy_ref)
        else:
            missing_policy_refs.add(f"{strategy.strategy_id}:sizing_policy_ref")
        if execution_policy_ref:
            execution_policy_refs.add(execution_policy_ref)
        else:
            missing_policy_refs.add(f"{strategy.strategy_id}:execution_policy_ref")

    overlapping_symbols = sorted(
        symbol for symbol, owners in symbol_usage.items() if len(set(owners)) > 1
    )
    return {
        "mode": "portfolio_aware" if len(strategy_items) > 1 else "single_strategy",
        "strategy_count": len(strategy_items),
        "spec_compiled_count": spec_compiled_count,
        "unique_symbol_count": len(symbol_usage),
        "overlapping_symbols": overlapping_symbols,
        "promotion_policy_refs": sorted(promotion_policy_refs),
        "risk_profile_refs": sorted(risk_profile_refs),
        "sizing_policy_refs": sorted(sizing_policy_refs),
        "execution_policy_refs": sorted(execution_policy_refs),
        "missing_policy_refs": sorted(missing_policy_refs),
    }


def _manifest_artifact_payload(
    artifact_root: Path,
    artifact_path: Path | None,
    stage_name: str,
    check_name: str,
) -> dict[str, str] | None:
    if artifact_path is None or not artifact_path.exists():
        return None
    artifact_payload = _load_json_if_exists(artifact_path)
    contract = contract_from_artifact_payload(artifact_payload)
    if not contract:
        default_contract = _artifact_authority_for_check(
            stage_name=stage_name,
            check_name=check_name,
        )
        if default_contract:
            contract = default_contract
    payload: dict[str, Any] = {
        "path": _manifest_relative_path(artifact_root, artifact_path),
        "sha256": _sha256_path(artifact_path),
        "stage": stage_name,
        "check": check_name,
    }
    if contract:
        payload["artifact_authority"] = contract
    return cast(dict[str, str], payload)


def _load_json_if_exists(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict):
        return None
    return cast(dict[str, Any], payload)


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
    iteration = _readable_notes_iteration_number(notes_dir)
    notes_path = notes_dir / f"iteration-{iteration}.md"

    lines = [
        f"# Autonomous lane iteration {iteration}",
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


def _extract_janus_q_metrics(
    summary: dict[str, object],
) -> tuple[int, int, bool, list[str]]:
    event_car = _as_object_dict(summary.get("event_car"))
    hgrm_reward = _as_object_dict(summary.get("hgrm_reward"))
    reasons_raw = summary.get("reasons")
    reasons: list[str] = []
    if isinstance(reasons_raw, list):
        reason_values = cast(list[object], reasons_raw)
        reasons = [
            str(reason).strip() for reason in reason_values if str(reason).strip()
        ]
    return (
        _safe_int(event_car.get("event_count", 0)),
        _safe_int(hgrm_reward.get("reward_count", 0)),
        bool(summary.get("evidence_complete", False)),
        reasons,
    )


artifact_hashes = _artifact_hashes
readable_notes_iteration_number = _readable_notes_iteration_number
write_stage_manifest = _write_stage_manifest
build_stage_lineage_payload = _build_stage_lineage_payload
manifest_relative_path = _manifest_relative_path
artifact_authority_for_check = _artifact_authority_for_check
artifact_authority_for_evidence = _artifact_authority_for_evidence
empirical_artifact_authority = _empirical_artifact_authority
resolve_optional_service_path = _resolve_optional_service_path
load_configured_empirical_payload = _load_configured_empirical_payload
build_janus_q_summary_from_payloads = _build_janus_q_summary_from_payloads
build_bridge_evidence_payload = _build_bridge_evidence_payload
build_vnext_gate_summary = _build_vnext_gate_summary
build_portfolio_promotion_summary = _build_portfolio_promotion_summary
manifest_artifact_payload = _manifest_artifact_payload
load_json_if_exists = _load_json_if_exists
write_iteration_notes = _write_iteration_notes
extract_janus_q_metrics = _extract_janus_q_metrics

__all__ = [
    "artifact_hashes",
    "readable_notes_iteration_number",
    "write_stage_manifest",
    "build_stage_lineage_payload",
    "manifest_relative_path",
    "artifact_authority_for_check",
    "artifact_authority_for_evidence",
    "empirical_artifact_authority",
    "resolve_optional_service_path",
    "load_configured_empirical_payload",
    "build_janus_q_summary_from_payloads",
    "build_bridge_evidence_payload",
    "build_vnext_gate_summary",
    "build_portfolio_promotion_summary",
    "manifest_artifact_payload",
    "load_json_if_exists",
    "write_iteration_notes",
    "extract_janus_q_metrics",
]
