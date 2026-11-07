module
import Lean.Elab.Tactic.Omega

@[expose] public section

namespace Bayn

structure ReplaySessionEvidence where
  finalWindow : Bool
  failedPassCount : Nat
  unavailableDecisionPassCount : Nat
  valuationFailureCount : Nat
  reconciliationExact : Bool
  accountingExact : Bool
  discrepancyCount : Nat
  cashDifference : Int
  positionDifference : Int
  equityDifference : Int
  unknownOrderCount : Nat
  unknownMutationCount : Nat
  remainingPositionCount : Nat
  remainingOpenOrderCount : Nat
  deriving Repr

def replaySessionPass (e : ReplaySessionEvidence) : Prop :=
  e.failedPassCount = 0 ∧ e.unavailableDecisionPassCount = 0 ∧ e.valuationFailureCount = 0 ∧
  e.reconciliationExact = true ∧ e.accountingExact = true ∧ e.discrepancyCount = 0 ∧
  e.cashDifference = 0 ∧ e.positionDifference = 0 ∧ e.equityDifference = 0 ∧
  e.unknownOrderCount = 0 ∧ e.unknownMutationCount = 0 ∧
  (e.finalWindow = false ∨ (e.remainingPositionCount = 0 ∧ e.remainingOpenOrderCount = 0))

instance (e : ReplaySessionEvidence) : Decidable (replaySessionPass e) := by
  unfold replaySessionPass
  infer_instance

theorem replay_session_completion_preserves_failures (e : ReplaySessionEvidence)
    (h : replaySessionPass e) :
    e.failedPassCount = 0 ∧ e.unavailableDecisionPassCount = 0 ∧ e.valuationFailureCount = 0 :=
  ⟨h.1, h.2.1, h.2.2.1⟩

theorem replay_session_completion_requires_exact_accounting (e : ReplaySessionEvidence)
    (h : replaySessionPass e) :
    e.reconciliationExact = true ∧ e.accountingExact = true ∧ e.discrepancyCount = 0 ∧
    e.cashDifference = 0 ∧ e.positionDifference = 0 ∧ e.equityDifference = 0 := by
  rcases h with ⟨_, _, _, a, b, c, d, f, g, _⟩
  exact ⟨a, b, c, d, f, g⟩

theorem replay_session_completion_requires_resolved_mutations (e : ReplaySessionEvidence)
    (h : replaySessionPass e) : e.unknownOrderCount = 0 ∧ e.unknownMutationCount = 0 := by
  rcases h with ⟨_, _, _, _, _, _, _, _, _, a, b, _⟩
  exact ⟨a, b⟩

theorem final_replay_session_is_flat (e : ReplaySessionEvidence)
    (final : e.finalWindow = true) (h : replaySessionPass e) :
    e.remainingPositionCount = 0 ∧ e.remainingOpenOrderCount = 0 := by
  simp only [replaySessionPass, final, Bool.true_eq_false, false_or] at h
  exact h.2.2.2.2.2.2.2.2.2.2.2

theorem failed_replay_session_cannot_complete (e : ReplaySessionEvidence)
    (failed : 0 < e.failedPassCount ∨ 0 < e.unavailableDecisionPassCount ∨ 0 < e.valuationFailureCount) :
    ¬ replaySessionPass e := by
  intro h
  have := replay_session_completion_preserves_failures e h
  omega

def completeReplaySessionExample : ReplaySessionEvidence := {
  finalWindow := true, failedPassCount := 0, unavailableDecisionPassCount := 0,
  valuationFailureCount := 0, reconciliationExact := true, accountingExact := true,
  discrepancyCount := 0, cashDifference := 0, positionDifference := 0, equityDifference := 0,
  unknownOrderCount := 0, unknownMutationCount := 0,
  remainingPositionCount := 0, remainingOpenOrderCount := 0
}

theorem replay_session_completion_is_reachable : replaySessionPass completeReplaySessionExample := by decide

theorem intermediate_replay_inventory_is_not_a_flat_close :
    replaySessionPass { completeReplaySessionExample with finalWindow := false, remainingPositionCount := 1 } ∧
    ¬ replaySessionPass { completeReplaySessionExample with remainingPositionCount := 1 } := by decide

end Bayn
