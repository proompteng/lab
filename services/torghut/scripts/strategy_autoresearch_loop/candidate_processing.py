"""Terminal validation and continuation planning for frontier candidates."""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path
from typing import Mapping, Sequence, cast

from app.trading.discovery.autoresearch import (
    ProposalModelPolicy,
    StrategyAutoresearchProgram,
    apply_program_objective,
    build_mutated_sweep_config,
    candidate_metrics_meet_objective,
)
from app.trading.discovery.mlx_features import (
    MlxCandidateDescriptor,
    descriptor_from_candidate_payload,
)
from app.trading.discovery.mlx_proposal_models import (
    ProposalScore,
    ProposalSelectionEntry,
    rank_candidate_descriptors,
    select_proposal_batch,
)

from .completion_semantics import (
    append_search_decision,
    evaluate_candidate_completion,
)
from .load_yaml import _history_record
from .shared_context import (
    WorkItem,
    _apply_exact_replay_guidance_to_next_sweep,
    _apply_objective_capital_limits,
    _keep_candidate_limit,
    _mapping,
    _string,
)


@dataclass(frozen=True)
class CandidateBatchRequest:
    candidates: Sequence[Mapping[str, object]]
    current: WorkItem
    program: StrategyAutoresearchProgram
    existing_history: Sequence[Mapping[str, object]]
    existing_seen_candidate_ids: set[str]
    search_decision_offset: int
    runner_run_id: str
    experiment_index: int
    sweep_config_path: Path
    result_path: Path
    dataset_snapshot_id: str
    latest_exact_replay_ledger_remediation: Mapping[str, object]
    start_equity: Decimal
    holdout_days: int
    full_window_day_count: int


@dataclass(frozen=True)
class CandidateBatchOutcome:
    descriptors: tuple[MlxCandidateDescriptor, ...]
    proposal_scores: tuple[ProposalScore, ...]
    history_records: tuple[dict[str, object], ...]
    search_decisions: tuple[dict[str, object], ...]
    continuation_work: tuple[WorkItem, ...]
    seen_candidate_ids: frozenset[str]
    objective_met: bool
    termination: dict[str, object] | None


@dataclass(frozen=True)
class _CandidateBatchSelection:
    descriptors: tuple[MlxCandidateDescriptor, ...]
    scores: tuple[ProposalScore, ...]
    keep_ids: frozenset[str]
    keep_reason_by_id: Mapping[str, str]
    score_by_id: Mapping[str, ProposalScore]
    duplicate_ids: frozenset[str]
    candidate_ids: tuple[str, ...]


@dataclass(frozen=True)
class _CandidateEvaluationRequest:
    batch: CandidateBatchRequest
    selection: _CandidateBatchSelection
    candidate: Mapping[str, object]
    descriptor: MlxCandidateDescriptor
    rank: int
    objective_already_met: bool


@dataclass(frozen=True)
class _CandidateEvaluation:
    history_record: dict[str, object]
    search_decision: dict[str, object]
    continuation_work: WorkItem | None
    objective_met: bool
    should_stop: bool


def _selection_entries(
    request: CandidateBatchRequest,
    descriptors: Sequence[MlxCandidateDescriptor],
    scores: Sequence[ProposalScore],
    *,
    duplicate_ids: frozenset[str],
) -> list[ProposalSelectionEntry]:
    descriptor_by_id = {item.candidate_id: item for item in descriptors}
    score_by_id = {item.candidate_id: item for item in scores}
    non_vetoed_ids = [
        _string(candidate.get("candidate_id"))
        for candidate in request.candidates
        if _string(candidate.get("candidate_id"))
        and _string(candidate.get("candidate_id")) not in duplicate_ids
        and not bool(_mapping(candidate.get("ranking")).get("vetoed"))
    ]
    eligible_descriptors = [
        descriptor_by_id[candidate_id]
        for candidate_id in non_vetoed_ids
        if candidate_id in descriptor_by_id
    ]
    eligible_scores = [
        score_by_id[candidate_id]
        for candidate_id in non_vetoed_ids
        if candidate_id in score_by_id
    ]
    selected = select_proposal_batch(
        descriptors=eligible_descriptors,
        proposal_scores=eligible_scores,
        limit=_keep_candidate_limit(
            family_plan=request.current.family_plan,
            replay_budget_max_candidates_per_round=int(
                request.program.replay_budget.max_candidates_per_round
            ),
        ),
        top_k=max(1, int(request.program.proposal_model_policy.top_k)),
        exploration_slots=min(
            max(0, int(request.program.proposal_model_policy.exploration_slots)),
            max(0, int(request.program.replay_budget.exploration_slots)),
        ),
    )
    if (
        selected
        or not request.current.family_plan.force_keep_top_candidate_if_all_vetoed
        or not request.candidates
    ):
        return selected
    first_candidate_id = next(
        (
            candidate_id
            for candidate in request.candidates
            if (candidate_id := _string(candidate.get("candidate_id")))
            and candidate_id not in duplicate_ids
        ),
        "",
    )
    descriptor = descriptor_by_id.get(first_candidate_id)
    score = score_by_id.get(first_candidate_id)
    if descriptor is None or score is None:
        return []
    return [
        ProposalSelectionEntry(
            candidate_id=first_candidate_id,
            descriptor_id=descriptor.descriptor_id,
            selection_reason="fallback_force_keep",
            score=score.score,
            rank=score.rank,
            family_template_id=descriptor.family_template_id,
            side_policy=descriptor.side_policy,
        )
    ]


def _prepare_selection(request: CandidateBatchRequest) -> _CandidateBatchSelection:
    candidate_ids = tuple(
        _string(candidate.get("candidate_id")) for candidate in request.candidates
    )
    candidate_id_counts = Counter(
        candidate_id for candidate_id in candidate_ids if candidate_id
    )
    duplicate_ids = frozenset(
        candidate_id
        for candidate_id, count in candidate_id_counts.items()
        if count > 1 or candidate_id in request.existing_seen_candidate_ids
    )
    descriptors = tuple(
        descriptor_from_candidate_payload(
            candidate_payload=candidate,
            family_plan=request.current.family_plan,
        )
        for candidate in request.candidates
    )
    scores = tuple(
        rank_candidate_descriptors(
            descriptors=descriptors,
            history_rows=request.existing_history,
            policy=cast(
                ProposalModelPolicy,
                request.program.proposal_model_policy,
            ),
        )
    )
    selected = _selection_entries(
        request,
        descriptors,
        scores,
        duplicate_ids=duplicate_ids,
    )
    return _CandidateBatchSelection(
        descriptors=descriptors,
        scores=scores,
        keep_ids=frozenset(item.candidate_id for item in selected),
        keep_reason_by_id={
            item.candidate_id: item.selection_reason for item in selected
        },
        score_by_id={item.candidate_id: item for item in scores},
        duplicate_ids=duplicate_ids,
        candidate_ids=candidate_ids,
    )


def _validation_blocker(
    candidate: Mapping[str, object],
    *,
    duplicate_identity: bool,
) -> str:
    if duplicate_identity:
        return "duplicate_candidate_identity"
    if bool(candidate.get("hard_vetoes")) or bool(
        _mapping(candidate.get("ranking")).get("vetoed")
    ):
        return "candidate_vetoed"
    return ""


def _continuation_work_item(
    request: CandidateBatchRequest,
    candidate: Mapping[str, object],
    candidate_id: str,
    *,
    eligible: bool,
) -> WorkItem | None:
    if not eligible:
        return None
    next_sweep_config, mutation_label = build_mutated_sweep_config(
        base_sweep_config=request.current.sweep_config,
        candidate_payload=candidate,
        family_plan=request.current.family_plan,
    )
    next_sweep_config = apply_program_objective(
        sweep_config=next_sweep_config,
        objective=request.program.objective,
        holdout_day_count=max(1, request.holdout_days),
        full_window_day_count=request.full_window_day_count,
    )
    next_sweep_config, mutation_label = _apply_exact_replay_guidance_to_next_sweep(
        sweep_config=next_sweep_config,
        mutation_label=mutation_label,
        remediation_report=request.latest_exact_replay_ledger_remediation,
    )
    next_sweep_config = _apply_objective_capital_limits(
        sweep_config=next_sweep_config,
        max_gross_exposure_pct_equity=(
            request.program.objective.max_gross_exposure_pct_equity
        ),
        start_equity=request.start_equity,
    )
    return WorkItem(
        family_plan=request.current.family_plan,
        iteration=request.current.iteration + 1,
        sweep_config=next_sweep_config,
        mutation_label=mutation_label,
        parent_candidate_id=candidate_id,
    )


def _evaluate_candidate(
    request: _CandidateEvaluationRequest,
) -> _CandidateEvaluation:
    batch = request.batch
    candidate_id = _string(request.candidate.get("candidate_id"))
    selection_status = (
        "keep" if candidate_id in request.selection.keep_ids else "discard"
    )
    duplicate_identity = candidate_id in request.selection.duplicate_ids
    completion = evaluate_candidate_completion(
        candidate_id=candidate_id,
        selection_status=selection_status,
        raw_objective_met=candidate_metrics_meet_objective(
            request.candidate,
            objective=batch.program.objective,
        ),
        validation_blocker=_validation_blocker(
            request.candidate,
            duplicate_identity=duplicate_identity,
        ),
        stop_when_objective_met=bool(batch.program.objective.stop_when_objective_met),
    )
    history_record = _history_record(
        runner_run_id=batch.runner_run_id,
        experiment_index=batch.experiment_index,
        family_plan=batch.current.family_plan,
        iteration=batch.current.iteration,
        mutation_label=batch.current.mutation_label,
        parent_candidate_id=batch.current.parent_candidate_id,
        sweep_config_path=batch.sweep_config_path,
        result_path=batch.result_path,
        candidate_payload=request.candidate,
        rank=request.rank,
        status=selection_status,
        objective_met=completion.objective_met,
        dataset_snapshot_id=batch.dataset_snapshot_id,
        raw_objective_met=completion.raw_objective_met,
        terminal_validation_status=completion.terminal_validation_status,
        terminal_validation_reason=completion.terminal_validation_reason,
        search_action=completion.search_action,
        search_reason=completion.search_reason,
        descriptor=request.descriptor,
        proposal_score=request.selection.score_by_id.get(
            request.descriptor.candidate_id
        ),
        proposal_selected=candidate_id in request.selection.keep_ids,
        proposal_selection_reason=request.selection.keep_reason_by_id.get(
            candidate_id, ""
        ),
        disable_other_strategies=bool(
            batch.current.sweep_config.get("disable_other_strategies", True)
        ),
    )
    decision_log: list[dict[str, object]] = []
    search_decision = append_search_decision(
        decision_log,
        event_type="candidate",
        action=completion.search_action,
        reason=completion.search_reason,
        context={
            "experiment_index": batch.experiment_index,
            "candidate_id": candidate_id,
            "rank": request.rank,
            "selection_status": selection_status,
            "raw_objective_met": completion.raw_objective_met,
            "objective_met": completion.objective_met,
            "terminal_validation_status": completion.terminal_validation_status,
            "terminal_validation_reason": completion.terminal_validation_reason,
        },
    )
    search_decision["sequence"] = batch.search_decision_offset + request.rank
    continuation_work = _continuation_work_item(
        batch,
        request.candidate,
        candidate_id,
        eligible=(
            selection_status == "keep"
            and bool(candidate_id)
            and not duplicate_identity
            and batch.current.iteration < batch.current.family_plan.max_iterations
            and not (
                (request.objective_already_met or completion.objective_met)
                and batch.program.objective.stop_when_objective_met
            )
        ),
    )
    return _CandidateEvaluation(
        history_record=history_record,
        search_decision=search_decision,
        continuation_work=continuation_work,
        objective_met=completion.objective_met,
        should_stop=completion.should_stop,
    )


def process_candidate_batch(
    request: CandidateBatchRequest,
) -> CandidateBatchOutcome:
    selection = _prepare_selection(request)
    history_records: list[dict[str, object]] = []
    search_decisions: list[dict[str, object]] = []
    continuation_work: list[WorkItem] = []
    objective_met = False
    termination: dict[str, object] | None = None
    for rank, (candidate, descriptor) in enumerate(
        zip(request.candidates, selection.descriptors, strict=True),
        start=1,
    ):
        if objective_met and request.program.objective.stop_when_objective_met:
            break
        evaluation = _evaluate_candidate(
            _CandidateEvaluationRequest(
                batch=request,
                selection=selection,
                candidate=candidate,
                descriptor=descriptor,
                rank=rank,
                objective_already_met=objective_met,
            )
        )
        history_records.append(evaluation.history_record)
        search_decisions.append(evaluation.search_decision)
        if evaluation.continuation_work is not None:
            continuation_work.append(evaluation.continuation_work)
        objective_met = objective_met or evaluation.objective_met
        if evaluation.should_stop:
            termination = evaluation.search_decision

    return CandidateBatchOutcome(
        descriptors=selection.descriptors,
        proposal_scores=selection.scores,
        history_records=tuple(history_records),
        search_decisions=tuple(search_decisions),
        continuation_work=tuple(continuation_work),
        seen_candidate_ids=frozenset(
            candidate_id for candidate_id in selection.candidate_ids if candidate_id
        ),
        objective_met=objective_met,
        termination=termination,
    )


__all__ = (
    "CandidateBatchOutcome",
    "CandidateBatchRequest",
    "process_candidate_batch",
)
