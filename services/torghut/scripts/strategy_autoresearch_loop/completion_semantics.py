"""Terminal completion semantics for strategy autoresearch candidates."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Mapping


TerminalValidationStatus = Literal["valid", "discarded", "invalid", "duplicate"]
SearchAction = Literal["continue", "stop"]


@dataclass(frozen=True)
class CandidateCompletionDecision:
    """Separate raw objective scoring from the terminal search decision."""

    raw_objective_met: bool
    objective_met: bool
    terminal_validation_status: TerminalValidationStatus
    terminal_validation_reason: str
    search_action: SearchAction
    search_reason: str

    @property
    def should_stop(self) -> bool:
        return self.search_action == "stop"

    def to_payload(self) -> dict[str, bool | str]:
        return {
            "raw_objective_met": self.raw_objective_met,
            "objective_met": self.objective_met,
            "terminal_validation_status": self.terminal_validation_status,
            "terminal_validation_reason": self.terminal_validation_reason,
            "search_action": self.search_action,
            "search_reason": self.search_reason,
        }


def evaluate_candidate_completion(
    *,
    candidate_id: str,
    selection_status: str,
    raw_objective_met: bool,
    validation_blocker: str,
    stop_when_objective_met: bool,
) -> CandidateCompletionDecision:
    """Return the only decision allowed to update the loop objective."""

    if not candidate_id:
        validation_status: TerminalValidationStatus = "invalid"
        validation_reason = "candidate_id_missing"
    elif validation_blocker == "duplicate_candidate_identity":
        validation_status = "duplicate"
        validation_reason = validation_blocker
    elif selection_status != "keep":
        validation_status = "discarded"
        validation_reason = "candidate_not_selected"
    elif validation_blocker:
        validation_status = "invalid"
        validation_reason = validation_blocker
    else:
        validation_status = "valid"
        validation_reason = "terminal_validation_passed"

    objective_met = validation_status == "valid" and raw_objective_met
    if objective_met and stop_when_objective_met:
        search_action: SearchAction = "stop"
        search_reason = "validated_objective_met"
    elif objective_met:
        search_action = "continue"
        search_reason = "validated_objective_met_stop_disabled"
    elif validation_status == "valid":
        search_action = "continue"
        search_reason = "objective_not_met"
    else:
        search_action = "continue"
        search_reason = validation_reason

    return CandidateCompletionDecision(
        raw_objective_met=raw_objective_met,
        objective_met=objective_met,
        terminal_validation_status=validation_status,
        terminal_validation_reason=validation_reason,
        search_action=search_action,
        search_reason=search_reason,
    )


def append_search_decision(
    search_decisions: list[dict[str, object]],
    *,
    event_type: str,
    action: str,
    reason: str,
    context: Mapping[str, object] | None = None,
) -> dict[str, object]:
    record: dict[str, object] = {
        "sequence": len(search_decisions) + 1,
        "event_type": event_type,
        "action": action,
        "reason": reason,
    }
    if context:
        record.update(dict(context))
    search_decisions.append(record)
    return record


__all__ = (
    "CandidateCompletionDecision",
    "SearchAction",
    "TerminalValidationStatus",
    "append_search_decision",
    "evaluate_candidate_completion",
)
