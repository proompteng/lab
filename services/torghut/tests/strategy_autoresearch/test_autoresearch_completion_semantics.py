from __future__ import annotations

from scripts.strategy_autoresearch_loop.completion_semantics import (
    evaluate_candidate_completion,
)


def test_valid_candidate_below_objective_continues() -> None:
    decision = evaluate_candidate_completion(
        candidate_id="valid-below",
        selection_status="keep",
        raw_objective_met=False,
        validation_blocker="",
        stop_when_objective_met=True,
    )

    assert decision.terminal_validation_status == "valid"
    assert decision.raw_objective_met is False
    assert decision.objective_met is False
    assert decision.search_action == "continue"
    assert decision.search_reason == "objective_not_met"


def test_valid_candidate_above_objective_stops() -> None:
    decision = evaluate_candidate_completion(
        candidate_id="valid-above",
        selection_status="keep",
        raw_objective_met=True,
        validation_blocker="",
        stop_when_objective_met=True,
    )

    assert decision.terminal_validation_status == "valid"
    assert decision.objective_met is True
    assert decision.should_stop is True
    assert decision.search_reason == "validated_objective_met"


def test_valid_objective_hit_continues_when_automatic_stop_is_disabled() -> None:
    decision = evaluate_candidate_completion(
        candidate_id="valid-above",
        selection_status="keep",
        raw_objective_met=True,
        validation_blocker="",
        stop_when_objective_met=False,
    )

    assert decision.objective_met is True
    assert decision.should_stop is False
    assert decision.search_reason == "validated_objective_met_stop_disabled"


def test_invalid_or_duplicate_candidate_cannot_satisfy_raw_objective() -> None:
    vetoed = evaluate_candidate_completion(
        candidate_id="vetoed",
        selection_status="keep",
        raw_objective_met=True,
        validation_blocker="candidate_vetoed",
        stop_when_objective_met=True,
    )
    duplicate = evaluate_candidate_completion(
        candidate_id="duplicate",
        selection_status="keep",
        raw_objective_met=True,
        validation_blocker="duplicate_candidate_identity",
        stop_when_objective_met=True,
    )

    assert vetoed.terminal_validation_status == "invalid"
    assert vetoed.objective_met is False
    assert vetoed.search_reason == "candidate_vetoed"
    assert duplicate.terminal_validation_status == "duplicate"
    assert duplicate.objective_met is False
    assert duplicate.search_reason == "duplicate_candidate_identity"
