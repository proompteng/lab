from __future__ import annotations

from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace
from typing import cast
from unittest.mock import patch

from app.trading.discovery.autoresearch import (
    StrategyObjective,
    candidate_meets_objective,
    candidate_metrics_meet_objective,
)
from app.trading.discovery.mlx_features import MlxCandidateDescriptor
from app.trading.discovery.mlx_proposal_models import (
    ProposalScore,
    ProposalSelectionEntry,
)
from scripts.strategy_autoresearch_loop import candidate_processing
from scripts.strategy_autoresearch_loop.candidate_processing import (
    CandidateBatchRequest,
    _CandidateBatchSelection,
    _CandidateEvaluationRequest,
)


def _descriptor(candidate_id: str) -> MlxCandidateDescriptor:
    return cast(
        MlxCandidateDescriptor,
        SimpleNamespace(
            candidate_id=candidate_id,
            descriptor_id=f"descriptor-{candidate_id}",
            family_template_id="family-1",
            side_policy="long",
        ),
    )


def _score(candidate_id: str, rank: int) -> ProposalScore:
    return cast(
        ProposalScore,
        SimpleNamespace(candidate_id=candidate_id, score=float(100 - rank), rank=rank),
    )


def _batch_request(
    candidates: list[dict[str, object]],
    *,
    seen: set[str] | None = None,
    force_keep: bool = False,
) -> CandidateBatchRequest:
    family_plan = SimpleNamespace(
        keep_top_candidates=1,
        force_keep_top_candidate_if_all_vetoed=force_keep,
    )
    return cast(
        CandidateBatchRequest,
        SimpleNamespace(
            candidates=candidates,
            current=SimpleNamespace(family_plan=family_plan),
            program=SimpleNamespace(
                replay_budget=SimpleNamespace(
                    max_candidates_per_round=1,
                    exploration_slots=0,
                ),
                proposal_model_policy=SimpleNamespace(top_k=1, exploration_slots=0),
            ),
            existing_history=(),
            existing_seen_candidate_ids=seen or set(),
        ),
    )


def test_prepare_selection_excludes_seen_and_in_batch_duplicate_ids() -> None:
    candidates = [
        {"candidate_id": "seen", "ranking": {"vetoed": False}},
        {"candidate_id": "repeat", "ranking": {"vetoed": False}},
        {"candidate_id": "repeat", "ranking": {"vetoed": False}},
        {"candidate_id": "fresh", "ranking": {"vetoed": False}},
    ]
    descriptors = [
        _descriptor(str(candidate["candidate_id"])) for candidate in candidates
    ]
    scores = [
        _score(item.candidate_id, rank) for rank, item in enumerate(descriptors, 1)
    ]
    selected_inputs: list[list[str]] = []

    def select_first(*, descriptors: list[MlxCandidateDescriptor], **_: object):
        selected_inputs.append([item.candidate_id for item in descriptors])
        item = descriptors[0]
        return [
            ProposalSelectionEntry(
                candidate_id=item.candidate_id,
                descriptor_id=item.descriptor_id,
                selection_reason="top_k",
                score=1.0,
                rank=1,
                family_template_id=item.family_template_id,
                side_policy=item.side_policy,
            )
        ]

    with (
        patch.object(
            candidate_processing,
            "descriptor_from_candidate_payload",
            side_effect=descriptors,
        ),
        patch.object(
            candidate_processing,
            "rank_candidate_descriptors",
            return_value=scores,
        ),
        patch.object(
            candidate_processing,
            "select_proposal_batch",
            side_effect=select_first,
        ),
    ):
        selection = candidate_processing._prepare_selection(
            _batch_request(candidates, seen={"seen"})
        )

    assert selected_inputs == [["fresh"]]
    assert selection.keep_ids == frozenset({"fresh"})
    assert selection.duplicate_ids == frozenset({"seen", "repeat"})


def test_force_keep_fallback_skips_duplicate_identity() -> None:
    candidates = [
        {"candidate_id": "seen", "ranking": {"vetoed": True}},
        {"candidate_id": "fresh", "ranking": {"vetoed": True}},
    ]
    descriptors = [
        _descriptor(str(candidate["candidate_id"])) for candidate in candidates
    ]
    scores = [
        _score(item.candidate_id, rank) for rank, item in enumerate(descriptors, 1)
    ]

    with (
        patch.object(
            candidate_processing,
            "descriptor_from_candidate_payload",
            side_effect=descriptors,
        ),
        patch.object(
            candidate_processing,
            "rank_candidate_descriptors",
            return_value=scores,
        ),
        patch.object(candidate_processing, "select_proposal_batch", return_value=[]),
    ):
        selection = candidate_processing._prepare_selection(
            _batch_request(candidates, seen={"seen"}, force_keep=True)
        )

    assert selection.keep_ids == frozenset({"fresh"})
    assert selection.keep_reason_by_id == {"fresh": "fallback_force_keep"}


def test_hard_veto_preserves_raw_metric_objective_hit() -> None:
    objective = StrategyObjective(
        target_net_pnl_per_day=Decimal("500"),
        min_active_day_ratio=Decimal("0.80"),
        min_positive_day_ratio=Decimal("0.60"),
        min_daily_notional=Decimal("300000"),
        max_best_day_share=Decimal("0.35"),
        max_worst_day_loss=Decimal("450"),
        max_drawdown=Decimal("1000"),
        require_every_day_active=False,
        min_regime_slice_pass_rate=Decimal("0.40"),
        stop_when_objective_met=True,
    )
    candidate: dict[str, object] = {
        "candidate_id": "vetoed-target-hit",
        "hard_vetoes": ["execution_quality_failed"],
        "ranking": {"vetoed": True},
        "objective_scorecard": {
            "net_pnl_per_day": "600",
            "active_day_ratio": "0.90",
            "positive_day_ratio": "0.70",
            "avg_filled_notional_per_day": "350000",
            "best_day_share": "0.30",
            "worst_day_loss": "300",
            "max_drawdown": "900",
            "regime_slice_pass_rate": "0.50",
        },
        "full_window": {"trading_day_count": 1, "active_days": 1},
    }
    descriptor = _descriptor("vetoed-target-hit")
    score = _score("vetoed-target-hit", 1)
    selection = _CandidateBatchSelection(
        descriptors=(descriptor,),
        scores=(score,),
        keep_ids=frozenset({"vetoed-target-hit"}),
        keep_reason_by_id={"vetoed-target-hit": "top_k"},
        score_by_id={"vetoed-target-hit": score},
        duplicate_ids=frozenset(),
        candidate_ids=("vetoed-target-hit",),
    )
    batch = cast(
        CandidateBatchRequest,
        SimpleNamespace(
            program=SimpleNamespace(objective=objective),
            runner_run_id="run-1",
            experiment_index=1,
            current=SimpleNamespace(
                family_plan=SimpleNamespace(max_iterations=1),
                iteration=1,
                mutation_label="seed",
                parent_candidate_id=None,
                sweep_config={},
            ),
            sweep_config_path=Path("sweep.yaml"),
            result_path=Path("result.json"),
            dataset_snapshot_id="snapshot-1",
            search_decision_offset=0,
        ),
    )

    assert candidate_metrics_meet_objective(candidate, objective=objective)
    assert not candidate_meets_objective(candidate, objective=objective)
    with (
        patch.object(
            candidate_processing, "_history_record", side_effect=lambda **kwargs: kwargs
        ),
        patch.object(
            candidate_processing, "_continuation_work_item", return_value=None
        ),
    ):
        evaluation = candidate_processing._evaluate_candidate(
            _CandidateEvaluationRequest(
                batch=batch,
                selection=selection,
                candidate=candidate,
                descriptor=descriptor,
                rank=1,
                objective_already_met=False,
            )
        )

    assert evaluation.history_record["raw_objective_met"] is True
    assert evaluation.history_record["objective_met"] is False
    assert evaluation.history_record["terminal_validation_status"] == "invalid"
    assert evaluation.history_record["terminal_validation_reason"] == "candidate_vetoed"
    assert evaluation.search_decision["raw_objective_met"] is True
    assert evaluation.search_decision["objective_met"] is False
