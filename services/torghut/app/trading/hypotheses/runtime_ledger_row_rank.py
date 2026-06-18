"""Hypothesis registry loading and runtime alpha-readiness compilation."""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any, cast
from urllib.request import Request, urlopen

import yaml
from pydantic import ValidationError

from ...config import settings
from ..runtime_ledger import POST_COST_PNL_BASIS


from .shared_context import (
    DependencyQuorumDecision,
    HypothesisManifest,
    HypothesisRegistryLoadResult,
    JangarDependencyQuorumStatus,
)
from . import shared_context as _shared_context_private_26

from . import extract_stage_renewal_bonds as _extract_stage_renewal_bonds_private_68
from .extract_stage_renewal_bonds import (
    RuntimeLedgerReadinessInputs as _RuntimeLedgerReadinessInputs,
)

_CAPITAL_STAGE_RANK = getattr(_shared_context_private_26, "_CAPITAL_STAGE_RANK")
_DEPENDENCY_REASONS = getattr(_shared_context_private_26, "_DEPENDENCY_REASONS")
_EDGE_OR_COST_REASONS = getattr(_shared_context_private_26, "_EDGE_OR_COST_REASONS")
_EVIDENCE_REFRESH_REASONS = getattr(
    _shared_context_private_26, "_EVIDENCE_REFRESH_REASONS"
)
_JANGAR_QUORUM_CACHE = getattr(_shared_context_private_26, "_JANGAR_QUORUM_CACHE")
_JANGAR_QUORUM_CACHE_LOCK = getattr(
    _shared_context_private_26, "_JANGAR_QUORUM_CACHE_LOCK"
)
_KNOWN_DEPENDENCY_CAPABILITIES = getattr(
    _shared_context_private_26, "_KNOWN_DEPENDENCY_CAPABILITIES"
)
_KNOWN_RUNTIME_LEDGER_SCHEMA_VERSIONS = getattr(
    _shared_context_private_26, "_KNOWN_RUNTIME_LEDGER_SCHEMA_VERSIONS"
)
_RUNTIME_LEDGER_PROVENANCE_REASONS = getattr(
    _shared_context_private_26, "_RUNTIME_LEDGER_PROVENANCE_REASONS"
)
_SAMPLE_REASONS = getattr(_shared_context_private_26, "_SAMPLE_REASONS")
_as_payload_dict = getattr(_shared_context_private_26, "_as_payload_dict")
_as_payload_dict_list = getattr(_shared_context_private_26, "_as_payload_dict_list")
_bounded_route_evidence_collection_readiness = getattr(
    _shared_context_private_26, "_bounded_route_evidence_collection_readiness"
)
_candidate_blocker_class = getattr(
    _shared_context_private_26, "_candidate_blocker_class"
)
_candidate_blocker_rank = getattr(_shared_context_private_26, "_candidate_blocker_rank")
_coerce_decimal = getattr(_shared_context_private_26, "_coerce_decimal")
_decimal_to_string = getattr(_shared_context_private_26, "_decimal_to_string")
_empty_payload_dict = getattr(_shared_context_private_26, "_empty_payload_dict")
_empty_payload_dict_list = getattr(
    _shared_context_private_26, "_empty_payload_dict_list"
)
_extract_stage_trust = getattr(_shared_context_private_26, "_extract_stage_trust")
_first_matching_reason = getattr(_shared_context_private_26, "_first_matching_reason")
_is_dependency_required = getattr(_shared_context_private_26, "_is_dependency_required")
_normalize_dependency_capability = getattr(
    _shared_context_private_26, "_normalize_dependency_capability"
)
_optional_bool = getattr(_shared_context_private_26, "_optional_bool")
_optional_decimal = getattr(_shared_context_private_26, "_optional_decimal")
_optional_int = getattr(_shared_context_private_26, "_optional_int")
_parse_iso8601 = getattr(_shared_context_private_26, "_parse_iso8601")
_ranked_candidate_dossiers = getattr(
    _shared_context_private_26, "_ranked_candidate_dossiers"
)
_resolve_required_dependency_capabilities = getattr(
    _shared_context_private_26, "_resolve_required_dependency_capabilities"
)
_sequence = getattr(_shared_context_private_26, "_sequence")
_stable_string_list = getattr(_shared_context_private_26, "_stable_string_list")
_DelayAdjustedDepthStressInputs = getattr(
    _extract_stage_renewal_bonds_private_68, "_DelayAdjustedDepthStressInputs"
)
_NON_AUTHORITY_TCA_DECISION_MODES = getattr(
    _extract_stage_renewal_bonds_private_68, "_NON_AUTHORITY_TCA_DECISION_MODES"
)
_NON_AUTHORITY_TCA_SOURCE_KINDS = getattr(
    _extract_stage_renewal_bonds_private_68, "_NON_AUTHORITY_TCA_SOURCE_KINDS"
)
_TcaReadinessInputs = getattr(
    _extract_stage_renewal_bonds_private_68, "_TcaReadinessInputs"
)
_extract_controller_ingestion_settlement = getattr(
    _extract_stage_renewal_bonds_private_68, "_extract_controller_ingestion_settlement"
)
_extract_foreclosure_carry_rollout_witness = getattr(
    _extract_stage_renewal_bonds_private_68,
    "_extract_foreclosure_carry_rollout_witness",
)
_extract_repair_slot_escrow = getattr(
    _extract_stage_renewal_bonds_private_68, "_extract_repair_slot_escrow"
)
_extract_stage_debt_repair_admission = getattr(
    _extract_stage_renewal_bonds_private_68, "_extract_stage_debt_repair_admission"
)
_extract_stage_renewal_bonds = getattr(
    _extract_stage_renewal_bonds_private_68, "_extract_stage_renewal_bonds"
)
_extract_verify_trust_foreclosure_board = getattr(
    _extract_stage_renewal_bonds_private_68, "_extract_verify_trust_foreclosure_board"
)
_latest_tca_timestamp = getattr(
    _extract_stage_renewal_bonds_private_68, "_latest_tca_timestamp"
)
_manifest_pair_contract_blockers = getattr(
    _extract_stage_renewal_bonds_private_68, "_manifest_pair_contract_blockers"
)
_normalized_route_token = getattr(
    _extract_stage_renewal_bonds_private_68, "_normalized_route_token"
)
_resolve_delay_adjusted_depth_stress_inputs = getattr(
    _extract_stage_renewal_bonds_private_68,
    "_resolve_delay_adjusted_depth_stress_inputs",
)
_resolve_tca_readiness_inputs = getattr(
    _extract_stage_renewal_bonds_private_68, "_resolve_tca_readiness_inputs"
)
_route_tca_adverse_slippage = getattr(
    _extract_stage_renewal_bonds_private_68, "_route_tca_adverse_slippage"
)
_route_tca_authority_blockers = getattr(
    _extract_stage_renewal_bonds_private_68, "_route_tca_authority_blockers"
)
_route_tca_bool = getattr(_extract_stage_renewal_bonds_private_68, "_route_tca_bool")
_route_tca_diagnostic = getattr(
    _extract_stage_renewal_bonds_private_68, "_route_tca_diagnostic"
)
_route_tca_target_blockers = getattr(
    _extract_stage_renewal_bonds_private_68, "_route_tca_target_blockers"
)
_route_tca_text = getattr(_extract_stage_renewal_bonds_private_68, "_route_tca_text")
_runtime_ledger_rows_for_hypothesis = getattr(
    _extract_stage_renewal_bonds_private_68, "_runtime_ledger_rows_for_hypothesis"
)
_runtime_ledger_target_blockers = getattr(
    _extract_stage_renewal_bonds_private_68, "_runtime_ledger_target_blockers"
)
_runtime_target_token = getattr(
    _extract_stage_renewal_bonds_private_68, "_runtime_target_token"
)
_runtime_text = getattr(_extract_stage_renewal_bonds_private_68, "_runtime_text")
_weighted_decimal_average = getattr(
    _extract_stage_renewal_bonds_private_68, "_weighted_decimal_average"
)


def _runtime_ledger_row_rank(
    row: Mapping[str, Any],
    *,
    candidate_id: str | None,
    strategy_family: str | None,
) -> tuple[int, int, datetime]:
    target_blockers = _runtime_ledger_target_blockers(
        row,
        candidate_id=candidate_id,
        strategy_family=strategy_family,
    )
    row_at = (
        _parse_iso8601(row.get("bucket_ended_at"))
        or _parse_iso8601(row.get("window_ended_at"))
        or _parse_iso8601(row.get("created_at"))
        or datetime.min.replace(tzinfo=timezone.utc)
    )
    return (
        0 if target_blockers else 1,
        1 if _runtime_text(row.get("observed_stage")) == "live" else 0,
        row_at,
    )


def _runtime_ledger_latest_row(
    rows: Sequence[Mapping[str, Any]],
    *,
    candidate_id: str | None,
    strategy_family: str | None,
) -> Mapping[str, Any] | None:
    if not rows:
        return None
    return max(
        rows,
        key=lambda row: _runtime_ledger_row_rank(
            row,
            candidate_id=candidate_id,
            strategy_family=strategy_family,
        ),
    )


def _hash_count(value: object) -> int:
    if isinstance(value, Mapping):
        mapping = cast(Mapping[object, object], value)
        return sum(1 for key in mapping.keys() if str(key).strip())
    return 0


def _dedupe_runtime_ledger_blockers(blockers: Sequence[str]) -> tuple[str, ...]:
    seen: set[str] = set()
    deduped: list[str] = []
    for blocker in blockers:
        reason = str(blocker).strip()
        if not reason or reason in seen:
            continue
        seen.add(reason)
        deduped.append(reason)
    return tuple(deduped)


def _runtime_ledger_provenance_blockers(
    *,
    ledger_schema_version: str | None,
    pnl_basis: str | None,
    execution_policy_hash_count: int,
    cost_model_hash_count: int,
    lineage_hash_count: int,
) -> tuple[str, ...]:
    blockers: list[str] = []
    if ledger_schema_version is None:
        blockers.append("runtime_ledger_schema_version_missing")
    elif ledger_schema_version not in _KNOWN_RUNTIME_LEDGER_SCHEMA_VERSIONS:
        blockers.append("runtime_ledger_schema_version_invalid")

    if pnl_basis is None:
        blockers.append("runtime_ledger_pnl_basis_missing")
    elif pnl_basis != POST_COST_PNL_BASIS:
        blockers.append("runtime_ledger_pnl_basis_invalid")

    if execution_policy_hash_count <= 0:
        blockers.append("runtime_ledger_execution_policy_hash_missing")
    if cost_model_hash_count <= 0:
        blockers.append("runtime_ledger_cost_model_hash_missing")
    if lineage_hash_count <= 0:
        blockers.append("runtime_ledger_lineage_hash_missing")
    return tuple(blockers)


def _runtime_ledger_window_bound_blockers(
    *,
    bucket_started_at: datetime | None,
    bucket_ended_at: datetime | None,
) -> tuple[str, ...]:
    if bucket_started_at is None or bucket_ended_at is None:
        return ("runtime_ledger_window_bounds_missing",)
    if bucket_ended_at < bucket_started_at:
        return ("runtime_ledger_window_bounds_mismatch",)
    return ()


def _runtime_ledger_blockers(row: Mapping[str, Any]) -> tuple[str, ...]:
    raw: object = (
        row.get("blockers")
        or row.get("blockers_json")
        or row.get("runtime_ledger_blockers")
        or []
    )
    blockers: list[str] = []
    for item in _sequence(raw):
        reason = str(item).strip()
        if reason:
            blockers.append(reason)
    seen: set[str] = set()
    deduped: list[str] = []
    for blocker in blockers:
        if blocker in seen:
            continue
        seen.add(blocker)
        deduped.append(blocker)
    return tuple(deduped)


def _resolve_runtime_ledger_readiness_inputs(
    runtime_ledger_summary: Mapping[str, Any] | None,
    *,
    manifest: HypothesisManifest,
) -> _RuntimeLedgerReadinessInputs:
    row = _runtime_ledger_latest_row(
        _runtime_ledger_rows_for_hypothesis(
            runtime_ledger_summary,
            hypothesis_id=manifest.hypothesis_id,
        ),
        candidate_id=manifest.candidate_id,
        strategy_family=manifest.strategy_family,
    )
    if row is None:
        return _RuntimeLedgerReadinessInputs(
            proof_present=False,
            candidate_id=None,
            observed_stage=None,
            runtime_strategy_name=None,
            strategy_family=None,
            fill_count=0,
            submitted_order_count=0,
            closed_trade_count=0,
            open_position_count=0,
            filled_notional=Decimal("0"),
            net_strategy_pnl_after_costs=Decimal("0"),
            post_cost_expectancy_bps=None,
            bucket_started_at=None,
            bucket_ended_at=None,
            blockers=("runtime_ledger_proof_missing",),
            execution_policy_hash_count=0,
            cost_model_hash_count=0,
            lineage_hash_count=0,
            ledger_schema_version=None,
            pnl_basis=None,
        )

    execution_policy_hash_count = _hash_count(row.get("execution_policy_hash_counts"))
    cost_model_hash_count = _hash_count(row.get("cost_model_hash_counts"))
    lineage_hash_count = _hash_count(row.get("lineage_hash_counts"))
    ledger_schema_version = _runtime_text(row.get("ledger_schema_version"))
    pnl_basis = _runtime_text(row.get("pnl_basis"))
    bucket_started_at = _parse_iso8601(row.get("bucket_started_at"))
    bucket_ended_at = _parse_iso8601(row.get("bucket_ended_at"))
    blockers = _dedupe_runtime_ledger_blockers(
        (
            *_runtime_ledger_blockers(row),
            *_runtime_ledger_target_blockers(
                row,
                candidate_id=manifest.candidate_id,
                strategy_family=manifest.strategy_family,
            ),
            *_runtime_ledger_provenance_blockers(
                ledger_schema_version=ledger_schema_version,
                pnl_basis=pnl_basis,
                execution_policy_hash_count=execution_policy_hash_count,
                cost_model_hash_count=cost_model_hash_count,
                lineage_hash_count=lineage_hash_count,
            ),
            *_runtime_ledger_window_bound_blockers(
                bucket_started_at=bucket_started_at,
                bucket_ended_at=bucket_ended_at,
            ),
        )
    )
    return _RuntimeLedgerReadinessInputs(
        proof_present=True,
        candidate_id=_runtime_text(row.get("candidate_id")),
        observed_stage=_runtime_text(row.get("observed_stage")),
        runtime_strategy_name=_runtime_text(row.get("runtime_strategy_name"))
        or _runtime_text(row.get("strategy_id")),
        strategy_family=_runtime_text(row.get("strategy_family")),
        fill_count=max(0, _optional_int(row.get("fill_count")) or 0),
        submitted_order_count=max(
            0, _optional_int(row.get("submitted_order_count")) or 0
        ),
        closed_trade_count=max(0, _optional_int(row.get("closed_trade_count")) or 0),
        open_position_count=max(0, _optional_int(row.get("open_position_count")) or 0),
        filled_notional=_coerce_decimal(row.get("filled_notional")),
        net_strategy_pnl_after_costs=_coerce_decimal(
            row.get("net_strategy_pnl_after_costs")
        ),
        post_cost_expectancy_bps=_optional_decimal(row.get("post_cost_expectancy_bps")),
        bucket_started_at=bucket_started_at,
        bucket_ended_at=bucket_ended_at,
        blockers=blockers,
        execution_policy_hash_count=execution_policy_hash_count,
        cost_model_hash_count=cost_model_hash_count,
        lineage_hash_count=lineage_hash_count,
        ledger_schema_version=ledger_schema_version,
        pnl_basis=pnl_basis,
    )


def resolve_hypothesis_registry_path(path_value: str | None = None) -> Path | None:
    raw = (path_value or settings.trading_hypothesis_registry_path or "").strip()
    if not raw:
        return None
    path = Path(raw).expanduser()
    if path.is_absolute():
        return path
    for parent in Path(__file__).resolve().parents:
        if (parent / "pyproject.toml").is_file() and (parent / "app").is_dir():
            service_root = parent
            break
    else:
        service_root = Path(__file__).resolve().parents[3]
    return service_root / path


def _load_manifest_payload(path: Path) -> Any:
    raw = path.read_text(encoding="utf-8")
    if not raw.strip():
        raise ValueError(f"hypothesis manifest is empty: {path}")
    suffix = path.suffix.lower()
    if suffix == ".json":
        return json.loads(raw)
    if suffix in {".yaml", ".yml"}:
        return yaml.safe_load(raw)
    raise ValueError(f"unsupported hypothesis manifest extension: {path.name}")


def load_hypothesis_registry(
    *,
    path_value: str | None = None,
    raise_on_error: bool = False,
) -> HypothesisRegistryLoadResult:
    resolved = resolve_hypothesis_registry_path(path_value)
    if resolved is None:
        return HypothesisRegistryLoadResult(
            path=None,
            loaded=False,
            items=[],
            errors=["hypothesis_registry_path_not_configured"],
        )
    if not resolved.exists():
        message = f"hypothesis registry path not found: {resolved}"
        if raise_on_error:
            raise RuntimeError(message)
        return HypothesisRegistryLoadResult(
            path=str(resolved),
            loaded=False,
            items=[],
            errors=[message],
        )

    manifest_paths: list[Path]
    if resolved.is_dir():
        manifest_paths = sorted(
            path
            for path in resolved.iterdir()
            if path.is_file() and path.suffix.lower() in {".json", ".yaml", ".yml"}
        )
    else:
        manifest_paths = [resolved]

    items: list[HypothesisManifest] = []
    errors: list[str] = []
    seen_ids: set[str] = set()

    for path in manifest_paths:
        try:
            payload = _load_manifest_payload(path)
            if not isinstance(payload, Mapping):
                raise ValueError("hypothesis manifest payload must be an object")
            manifest = HypothesisManifest.model_validate(payload)
        except (
            OSError,
            json.JSONDecodeError,
            ValidationError,
            ValueError,
            yaml.YAMLError,
        ) as exc:
            errors.append(f"{path}: {exc}")
            continue
        if manifest.hypothesis_id in seen_ids:
            errors.append(f"{path}: duplicate hypothesis_id {manifest.hypothesis_id}")
            continue
        seen_ids.add(manifest.hypothesis_id)
        items.append(manifest)

    if errors and raise_on_error:
        raise RuntimeError("; ".join(errors))
    return HypothesisRegistryLoadResult(
        path=str(resolved),
        loaded=len(errors) == 0,
        items=items if len(errors) == 0 else [],
        errors=errors,
    )


def validate_hypothesis_registry_from_settings() -> None:
    load_hypothesis_registry(raise_on_error=True)


def _fallback_quorum_from_legacy_status(
    payload: Mapping[str, Any],
) -> JangarDependencyQuorumStatus:
    workflows = payload.get("workflows")
    if isinstance(workflows, Mapping):
        workflows_map = cast(Mapping[str, Any], workflows)
        confidence = str(workflows_map.get("data_confidence") or "").strip()
        backoff_jobs = max(
            0, _optional_int(workflows_map.get("backoff_limit_exceeded_jobs")) or 0
        )
        if confidence == "unknown":
            return JangarDependencyQuorumStatus(
                decision="block",
                reasons=["workflows_data_unknown"],
                message="Torghut workflow reliability is unavailable.",
                controller_ingestion_settlement=_extract_controller_ingestion_settlement(
                    payload,
                    {},
                ),
                verify_trust_foreclosure_board=_extract_verify_trust_foreclosure_board(
                    payload,
                    {},
                ),
                repair_slot_escrow=_extract_repair_slot_escrow(payload, {}),
                stage_debt_repair_admission=_extract_stage_debt_repair_admission(
                    payload,
                    {},
                ),
                foreclosure_carry_rollout_witness=_extract_foreclosure_carry_rollout_witness(
                    payload,
                    {},
                ),
            )
        if backoff_jobs > 0 or confidence == "degraded":
            return JangarDependencyQuorumStatus(
                decision="delay",
                reasons=["workflows_degraded"],
                message="Torghut workflow reliability is degraded.",
                controller_ingestion_settlement=_extract_controller_ingestion_settlement(
                    payload,
                    {},
                ),
                verify_trust_foreclosure_board=_extract_verify_trust_foreclosure_board(
                    payload,
                    {},
                ),
                repair_slot_escrow=_extract_repair_slot_escrow(payload, {}),
                stage_debt_repair_admission=_extract_stage_debt_repair_admission(
                    payload,
                    {},
                ),
                foreclosure_carry_rollout_witness=_extract_foreclosure_carry_rollout_witness(
                    payload,
                    {},
                ),
            )
    namespaces = payload.get("namespaces")
    if isinstance(namespaces, Sequence) and not isinstance(
        namespaces, (str, bytes, bytearray)
    ):
        for raw_item in cast(Sequence[object], namespaces):
            if not isinstance(raw_item, Mapping):
                continue
            item = cast(Mapping[str, Any], raw_item)
            if str(item.get("status") or "").strip() == "degraded":
                return JangarDependencyQuorumStatus(
                    decision="delay",
                    reasons=["jangar_namespace_degraded"],
                    message="Torghut namespace health is degraded.",
                    controller_ingestion_settlement=_extract_controller_ingestion_settlement(
                        payload,
                        {},
                    ),
                    verify_trust_foreclosure_board=_extract_verify_trust_foreclosure_board(
                        payload,
                        {},
                    ),
                    repair_slot_escrow=_extract_repair_slot_escrow(payload, {}),
                    stage_debt_repair_admission=_extract_stage_debt_repair_admission(
                        payload,
                        {},
                    ),
                    foreclosure_carry_rollout_witness=_extract_foreclosure_carry_rollout_witness(
                        payload,
                        {},
                    ),
                )
    return JangarDependencyQuorumStatus(
        decision="unknown",
        reasons=["jangar_dependency_quorum_missing"],
        message="Torghut control-plane status did not include dependency_quorum.",
        controller_ingestion_settlement=_extract_controller_ingestion_settlement(
            payload,
            {},
        ),
        verify_trust_foreclosure_board=_extract_verify_trust_foreclosure_board(
            payload,
            {},
        ),
        repair_slot_escrow=_extract_repair_slot_escrow(payload, {}),
        stage_debt_repair_admission=_extract_stage_debt_repair_admission(payload, {}),
        foreclosure_carry_rollout_witness=_extract_foreclosure_carry_rollout_witness(
            payload,
            {},
        ),
    )


def load_jangar_dependency_quorum(
    *,
    omit_torghut_consumer_evidence: bool = False,
) -> JangarDependencyQuorumStatus:
    status_url = (settings.trading_jangar_control_plane_status_url or "").strip()
    if not status_url:
        return JangarDependencyQuorumStatus(
            decision="unknown",
            reasons=["jangar_control_plane_status_url_missing"],
            message="TRADING_JANGAR_CONTROL_PLANE_STATUS_URL is not configured.",
        )
    cache_key = (
        f"{status_url}#omit_torghut_consumer_evidence="
        f"{str(omit_torghut_consumer_evidence).lower()}"
    )

    ttl_seconds = max(0, int(settings.trading_jangar_control_plane_cache_ttl_seconds))
    if ttl_seconds > 0:
        now = datetime.now(timezone.utc)
        with _JANGAR_QUORUM_CACHE_LOCK:
            cached = cast(dict[str, Any] | None, _JANGAR_QUORUM_CACHE.get(cache_key))
            if cached is not None:
                checked_at = cast(datetime | None, cached.get("checked_at"))
                if checked_at is not None and now - checked_at <= timedelta(
                    seconds=ttl_seconds
                ):
                    return cast(JangarDependencyQuorumStatus, cached["status"])

    decoded: Any = None
    try:
        headers = {"accept": "application/json"}
        if omit_torghut_consumer_evidence:
            headers["x-torghut-consumer-evidence-mode"] = "omit"
        request = Request(status_url, method="GET", headers=headers)
        with urlopen(
            request, timeout=settings.trading_jangar_control_plane_timeout_seconds
        ) as response:
            if response.status < 200 or response.status >= 300:
                return JangarDependencyQuorumStatus(
                    decision="unknown",
                    reasons=[f"jangar_status_http_{response.status}"],
                    message=f"Torghut control-plane status returned HTTP {response.status}.",
                )
            decoded = json.loads(response.read().decode("utf-8"))
    except Exception as exc:
        return JangarDependencyQuorumStatus(
            decision="unknown",
            reasons=["jangar_status_fetch_failed"],
            message=f"Torghut control-plane status fetch failed: {exc}",
        )

    if not isinstance(decoded, Mapping):
        return JangarDependencyQuorumStatus(
            decision="unknown",
            reasons=["jangar_status_payload_invalid"],
            message="Torghut control-plane status payload was invalid.",
        )
    payload = cast(Mapping[str, Any], decoded)
    raw_quorum = payload.get("dependency_quorum")
    if isinstance(raw_quorum, Mapping):
        quorum = cast(Mapping[str, Any], raw_quorum)
        decision = str(quorum.get("decision") or "").strip()
        if decision in {"allow", "delay", "block", "unknown"}:
            reasons = [
                str(item).strip()
                for item in cast(Sequence[object], quorum.get("reasons") or [])
                if str(item).strip()
            ]
            status = JangarDependencyQuorumStatus(
                decision=cast(DependencyQuorumDecision, decision),
                reasons=reasons,
                message=str(quorum.get("message") or "").strip(),
                stage_trust=_extract_stage_trust(payload, quorum),
                stage_renewal_bonds=_extract_stage_renewal_bonds(payload, quorum),
                controller_ingestion_settlement=_extract_controller_ingestion_settlement(
                    payload,
                    quorum,
                ),
                verify_trust_foreclosure_board=_extract_verify_trust_foreclosure_board(
                    payload,
                    quorum,
                ),
                repair_slot_escrow=_extract_repair_slot_escrow(payload, quorum),
                stage_debt_repair_admission=_extract_stage_debt_repair_admission(
                    payload,
                    quorum,
                ),
                foreclosure_carry_rollout_witness=_extract_foreclosure_carry_rollout_witness(
                    payload,
                    quorum,
                ),
                generated_at=str(
                    payload.get("generated_at")
                    or payload.get("generatedAt")
                    or quorum.get("generated_at")
                    or quorum.get("generatedAt")
                    or ""
                ).strip()
                or None,
            )
        else:
            status = _fallback_quorum_from_legacy_status(payload)
    else:
        status = _fallback_quorum_from_legacy_status(payload)

    if ttl_seconds > 0:
        with _JANGAR_QUORUM_CACHE_LOCK:
            _JANGAR_QUORUM_CACHE[cache_key] = {
                "checked_at": datetime.now(timezone.utc),
                "status": status,
            }
    return status


__all__ = (
    "resolve_hypothesis_registry_path",
    "load_hypothesis_registry",
    "validate_hypothesis_registry_from_settings",
    "load_jangar_dependency_quorum",
)

# Public aliases used by split modules.
dedupe_runtime_ledger_blockers = _dedupe_runtime_ledger_blockers
fallback_quorum_from_legacy_status = _fallback_quorum_from_legacy_status
hash_count = _hash_count
load_manifest_payload = _load_manifest_payload
resolve_runtime_ledger_readiness_inputs = _resolve_runtime_ledger_readiness_inputs
runtime_ledger_blockers = _runtime_ledger_blockers
runtime_ledger_latest_row = _runtime_ledger_latest_row
runtime_ledger_provenance_blockers = _runtime_ledger_provenance_blockers
runtime_ledger_row_rank = _runtime_ledger_row_rank
runtime_ledger_window_bound_blockers = _runtime_ledger_window_bound_blockers
