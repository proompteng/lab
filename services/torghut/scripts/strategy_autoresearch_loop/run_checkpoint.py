"""Atomic committed-state checkpoints for deterministic autoresearch resume."""

from __future__ import annotations

import argparse
import hashlib
import json
from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path
from typing import Mapping, Sequence, cast

from app.trading.discovery.autoresearch import FamilyAutoresearchPlan
from app.trading.discovery.mlx_features import MlxCandidateDescriptor
from app.trading.discovery.mlx_proposal_models import ProposalScore
from app.trading.discovery.mlx_snapshot import MlxSignalBundleStats

from .shared_context import WorkItem


CHECKPOINT_FILENAME = "checkpoint.json"
CHECKPOINT_SCHEMA_VERSION = "torghut.strategy-autoresearch-checkpoint.v1"

_CONTRACT_ARGUMENTS = (
    "strategy_configmap",
    "clickhouse_http_url",
    "clickhouse_username",
    "start_equity",
    "chunk_minutes",
    "symbols",
    "shadow_validation_artifact",
    "train_days",
    "holdout_days",
    "second_oos_days",
    "full_window_start_date",
    "full_window_end_date",
    "expected_last_trading_day",
    "allow_stale_tape",
    "prefetch_full_window_rows",
    "replay_tape_path",
    "replay_tape_manifest",
    "materialize_replay_tape",
    "latest_complete_window_min_days",
    "min_executable_rows_per_symbol_day",
    "min_quote_valid_ratio",
    "max_coverage_spread_bps",
    "max_executable_gap_seconds",
    "max_frontier_runs",
    "max_candidates_per_frontier_run",
    "staged_train_screen_multiplier",
)


@dataclass(frozen=True)
class RestoredRunState:
    status: str
    generation: int
    setup_complete: bool
    runner_run_id: str
    frontier_runs: int
    objective_met: bool
    worklist: list[WorkItem]
    seen_sweeps: set[str]
    seen_candidate_ids: set[str]
    history: list[dict[str, object]]
    descriptors: list[MlxCandidateDescriptor]
    proposal_scores: list[ProposalScore]
    search_decisions: list[dict[str, object]]
    termination: dict[str, object]
    tape_freshness_receipts: list[dict[str, object]]
    snapshot_symbols: tuple[str, ...]
    resolved_full_window_start_date: str
    resolved_full_window_end_date: str
    effective_expected_last_trading_day: str
    signal_bundle_stats: MlxSignalBundleStats | None
    effective_replay_tape_path: Path | None
    effective_replay_tape_manifest: Path | None


@dataclass(frozen=True)
class RunCheckpointSnapshot:
    status: str
    generation: int
    setup_complete: bool
    program_id: str
    program_payload: Mapping[str, object]
    contract_digest: str
    runner_run_id: str
    frontier_runs: int
    objective_met: bool
    worklist: Sequence[WorkItem]
    seen_sweeps: set[str]
    seen_candidate_ids: set[str]
    history: Sequence[Mapping[str, object]]
    descriptors: Sequence[MlxCandidateDescriptor]
    proposal_scores: Sequence[ProposalScore]
    search_decisions: Sequence[Mapping[str, object]]
    termination: Mapping[str, object]
    tape_freshness_receipts: Sequence[Mapping[str, object]]
    snapshot_symbols: Sequence[str]
    resolved_full_window_start_date: str
    resolved_full_window_end_date: str
    effective_expected_last_trading_day: str
    signal_bundle_stats: MlxSignalBundleStats | None
    effective_replay_tape_path: Path | None
    effective_replay_tape_manifest: Path | None


def _json_safe(value: object) -> object:
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, Mapping):
        return {str(key): _json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(item) for item in value]
    if isinstance(value, set):
        return sorted(_json_safe(item) for item in value)
    return value


def _digest(payload: Mapping[str, object]) -> str:
    return hashlib.sha256(
        json.dumps(
            _json_safe(payload),
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()


def program_digest(program_payload: Mapping[str, object]) -> str:
    return _digest(program_payload)


def execution_contract_digest(
    *,
    args: argparse.Namespace,
    program_payload: Mapping[str, object],
    family_plans: Sequence[FamilyAutoresearchPlan],
) -> str:
    input_artifacts = {
        name: _input_artifact_payload(getattr(args, name, None))
        for name in (
            "strategy_configmap",
            "shadow_validation_artifact",
            "replay_tape_manifest",
        )
    }
    return _digest(
        {
            "program_digest": program_digest(program_payload),
            "arguments": {
                name: _json_safe(getattr(args, name, None))
                for name in _CONTRACT_ARGUMENTS
            },
            "input_artifacts": input_artifacts,
            "families": [
                {
                    "family_template": item.family_template.to_payload(),
                    "seed_sweep": _input_artifact_payload(item.seed_sweep_config),
                }
                for item in family_plans
            ],
        }
    )


def _input_artifact_payload(value: object) -> dict[str, str] | None:
    if value is None:
        return None
    path = Path(value).resolve()
    return {
        "path": str(path),
        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
    }


def _work_item_payload(item: WorkItem) -> dict[str, object]:
    return {
        "family_template_id": item.family_plan.family_template.family_id,
        "iteration": item.iteration,
        "sweep_config": item.sweep_config,
        "mutation_label": item.mutation_label,
        "parent_candidate_id": item.parent_candidate_id,
    }


def write_run_checkpoint(
    *,
    run_root: Path,
    snapshot: RunCheckpointSnapshot,
) -> Path:
    if snapshot.status not in {"running", "completed"}:
        raise ValueError(f"autoresearch_checkpoint_status_invalid:{snapshot.status}")
    payload: dict[str, object] = {
        "schema_version": CHECKPOINT_SCHEMA_VERSION,
        "status": snapshot.status,
        "generation": snapshot.generation,
        "setup_complete": snapshot.setup_complete,
        "program_id": snapshot.program_id,
        "program_digest": program_digest(snapshot.program_payload),
        "execution_contract_digest": snapshot.contract_digest,
        "runner_run_id": snapshot.runner_run_id,
        "frontier_runs": snapshot.frontier_runs,
        "objective_met": snapshot.objective_met,
        "worklist": [_work_item_payload(item) for item in snapshot.worklist],
        "seen_sweeps": sorted(snapshot.seen_sweeps),
        "seen_candidate_ids": sorted(snapshot.seen_candidate_ids),
        "history": [dict(item) for item in snapshot.history],
        "descriptors": [item.to_payload() for item in snapshot.descriptors],
        "proposal_scores": [item.to_payload() for item in snapshot.proposal_scores],
        "search_decisions": [dict(item) for item in snapshot.search_decisions],
        "termination": dict(snapshot.termination),
        "tape_freshness_receipts": [
            dict(item) for item in snapshot.tape_freshness_receipts
        ],
        "snapshot_symbols": list(snapshot.snapshot_symbols),
        "resolved_full_window_start_date": snapshot.resolved_full_window_start_date,
        "resolved_full_window_end_date": snapshot.resolved_full_window_end_date,
        "effective_expected_last_trading_day": (
            snapshot.effective_expected_last_trading_day
        ),
        "signal_bundle_stats": (
            snapshot.signal_bundle_stats.to_payload()
            if snapshot.signal_bundle_stats is not None
            else None
        ),
        "effective_replay_tape_path": (
            str(snapshot.effective_replay_tape_path)
            if snapshot.effective_replay_tape_path is not None
            else None
        ),
        "effective_replay_tape_manifest": (
            str(snapshot.effective_replay_tape_manifest)
            if snapshot.effective_replay_tape_manifest is not None
            else None
        ),
    }
    payload["state_digest"] = _digest(payload)
    path = run_root / CHECKPOINT_FILENAME
    temporary_path = run_root / f".{CHECKPOINT_FILENAME}.tmp"
    temporary_path.write_text(
        json.dumps(_json_safe(payload), indent=2, sort_keys=True),
        encoding="utf-8",
    )
    temporary_path.replace(path)
    return path


def _mapping(value: object, field: str) -> dict[str, object]:
    if not isinstance(value, Mapping):
        raise ValueError(f"autoresearch_checkpoint_field_invalid:{field}")
    return {str(key): item for key, item in value.items()}


def _mapping_list(value: object, field: str) -> list[dict[str, object]]:
    if not isinstance(value, list):
        raise ValueError(f"autoresearch_checkpoint_field_invalid:{field}")
    return [_mapping(item, field) for item in cast(list[object], value)]


def _string_list(value: object, field: str) -> list[str]:
    if not isinstance(value, list):
        raise ValueError(f"autoresearch_checkpoint_field_invalid:{field}")
    return [str(item) for item in cast(list[object], value)]


def _restore_worklist(
    payloads: Sequence[Mapping[str, object]],
    *,
    family_plans: Sequence[FamilyAutoresearchPlan],
) -> list[WorkItem]:
    family_by_id = {item.family_template.family_id: item for item in family_plans}
    worklist: list[WorkItem] = []
    for raw in payloads:
        payload = dict(raw)
        family_id = str(payload.get("family_template_id") or "")
        family_plan = family_by_id.get(family_id)
        if family_plan is None:
            raise ValueError(
                f"autoresearch_checkpoint_family_unknown:{family_id or 'missing'}"
            )
        worklist.append(
            WorkItem(
                family_plan=family_plan,
                iteration=int(payload.get("iteration") or 0),
                sweep_config=_mapping(payload.get("sweep_config"), "sweep_config"),
                mutation_label=str(payload.get("mutation_label") or ""),
                parent_candidate_id=(
                    str(payload["parent_candidate_id"])
                    if payload.get("parent_candidate_id") is not None
                    else None
                ),
            )
        )
    return worklist


def load_run_checkpoint(
    *,
    run_root: Path,
    program_id: str,
    program_payload: Mapping[str, object],
    contract_digest: str,
    family_plans: Sequence[FamilyAutoresearchPlan],
) -> RestoredRunState:
    path = run_root / CHECKPOINT_FILENAME
    if not path.is_file():
        raise ValueError(f"autoresearch_checkpoint_missing:{path}")
    payload = _mapping(json.loads(path.read_text(encoding="utf-8")), "root")
    state_digest = str(payload.pop("state_digest", ""))
    if not state_digest or state_digest != _digest(payload):
        raise ValueError("autoresearch_checkpoint_digest_mismatch")
    if payload.get("schema_version") != CHECKPOINT_SCHEMA_VERSION:
        raise ValueError("autoresearch_checkpoint_schema_unsupported")
    if payload.get("program_id") != program_id:
        raise ValueError("autoresearch_checkpoint_program_id_mismatch")
    if payload.get("program_digest") != program_digest(program_payload):
        raise ValueError("autoresearch_checkpoint_program_digest_mismatch")
    if payload.get("execution_contract_digest") != contract_digest:
        raise ValueError("autoresearch_checkpoint_execution_contract_mismatch")

    stats_payload = payload.get("signal_bundle_stats")
    signal_bundle_stats = (
        MlxSignalBundleStats(**_mapping(stats_payload, "signal_bundle_stats"))
        if stats_payload is not None
        else None
    )
    tape_path = payload.get("effective_replay_tape_path")
    tape_manifest = payload.get("effective_replay_tape_manifest")
    return RestoredRunState(
        status=str(payload.get("status") or ""),
        generation=int(payload.get("generation") or 0),
        setup_complete=bool(payload.get("setup_complete")),
        runner_run_id=str(payload.get("runner_run_id") or ""),
        frontier_runs=int(payload.get("frontier_runs") or 0),
        objective_met=bool(payload.get("objective_met")),
        worklist=_restore_worklist(
            _mapping_list(payload.get("worklist"), "worklist"),
            family_plans=family_plans,
        ),
        seen_sweeps=set(_string_list(payload.get("seen_sweeps"), "seen_sweeps")),
        seen_candidate_ids=set(
            _string_list(payload.get("seen_candidate_ids"), "seen_candidate_ids")
        ),
        history=_mapping_list(payload.get("history"), "history"),
        descriptors=[
            MlxCandidateDescriptor(**item)
            for item in _mapping_list(payload.get("descriptors"), "descriptors")
        ],
        proposal_scores=[
            ProposalScore(**item)
            for item in _mapping_list(payload.get("proposal_scores"), "proposal_scores")
        ],
        search_decisions=_mapping_list(
            payload.get("search_decisions"), "search_decisions"
        ),
        termination=_mapping(payload.get("termination"), "termination"),
        tape_freshness_receipts=_mapping_list(
            payload.get("tape_freshness_receipts"), "tape_freshness_receipts"
        ),
        snapshot_symbols=tuple(
            _string_list(payload.get("snapshot_symbols"), "snapshot_symbols")
        ),
        resolved_full_window_start_date=str(
            payload.get("resolved_full_window_start_date") or ""
        ),
        resolved_full_window_end_date=str(
            payload.get("resolved_full_window_end_date") or ""
        ),
        effective_expected_last_trading_day=str(
            payload.get("effective_expected_last_trading_day") or ""
        ),
        signal_bundle_stats=signal_bundle_stats,
        effective_replay_tape_path=Path(str(tape_path)) if tape_path else None,
        effective_replay_tape_manifest=(
            Path(str(tape_manifest)) if tape_manifest else None
        ),
    )


def read_uncommitted_lifecycle_decisions(
    *,
    run_root: Path,
    committed_count: int,
) -> list[dict[str, object]]:
    path = run_root / "search-decisions.jsonl"
    if not path.is_file():
        return []
    records = [
        _mapping(json.loads(line), "search_decision")
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    return [
        record
        for record in records[committed_count:]
        if record.get("event_type") == "run"
        and record.get("reason")
        in {"run_interrupted", "run_error", "run_resumed_from_checkpoint"}
    ]


__all__ = (
    "CHECKPOINT_FILENAME",
    "RestoredRunState",
    "RunCheckpointSnapshot",
    "execution_contract_digest",
    "load_run_checkpoint",
    "read_uncommitted_lifecycle_decisions",
    "write_run_checkpoint",
)
