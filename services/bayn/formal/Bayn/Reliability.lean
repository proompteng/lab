module
import Lean.Elab.Tactic.Omega

@[expose] public section

namespace Bayn

def reliabilityPass (good scheduled : Nat) : Prop :=
  0 < scheduled ∧ good ≤ scheduled ∧ 999 * scheduled ≤ 1000 * good

instance (good scheduled : Nat) : Decidable (reliabilityPass good scheduled) := by
  unfold reliabilityPass
  infer_instance

theorem reliability_error_budget (good scheduled : Nat) (bounded : good ≤ scheduled) :
    999 * scheduled ≤ 1000 * good ↔ scheduled - good ≤ scheduled / 1000 := by
  omega

theorem no_empty_perfect_reliability (good : Nat) : ¬ reliabilityPass good 0 := by
  simp [reliabilityPass]

theorem small_populations_allow_no_failures (good scheduled : Nat)
    (small : scheduled < 1000) (passes : reliabilityPass good scheduled) : good = scheduled := by
  unfold reliabilityPass at passes
  omega

theorem more_missed_work_cannot_improve_reliability (good scheduled added : Nat)
    (fails : ¬ reliabilityPass good scheduled) (nonempty : 0 < scheduled) (bounded : good ≤ scheduled) :
    ¬ reliabilityPass good (scheduled + added) := by
  unfold reliabilityPass at *
  omega

structure Obligation where
  dueAt : Int
  deadlineAt : Int
  deriving Repr

structure Completion where
  completedAt : Int
  correct : Bool
  deriving Repr

def correctOnTime (obligation : Obligation) (completion : Completion) : Prop :=
  completion.correct = true ∧ obligation.dueAt ≤ completion.completedAt ∧
    completion.completedAt ≤ obligation.deadlineAt

theorem late_completion_is_failure (o : Obligation) (c : Completion)
    (late : o.deadlineAt < c.completedAt) : ¬ correctOnTime o c := by
  unfold correctOnTime
  omega

def operationalAssessmentVerdict (reliability : String) (missing : Nat)
    (safetyComplete : Bool) (violations : Nat) : String :=
  if 0 < violations ∨ reliability = "MISSES_TARGET" then "REJECTED"
  else if missing = 0 ∧ reliability = "MEETS_TARGET" ∧ safetyComplete = true
    then "OPERATIONALLY_RELIABLE_PAPER" else "INCONCLUSIVE"

theorem operational_pass_requires_complete_reliability_and_zero_safety_violations
    (r : String) (m v : Nat) (s : Bool)
    (passes : operationalAssessmentVerdict r m s v = "OPERATIONALLY_RELIABLE_PAPER") :
    r = "MEETS_TARGET" ∧ m = 0 ∧ s = true ∧ v = 0 := by
  unfold operationalAssessmentVerdict at passes
  split at passes
  · contradiction
  · rename_i noFailure
    split at passes
    · rename_i complete
      exact ⟨complete.2.1, complete.1, complete.2.2, by omega⟩
    · contradiction

def nativeObligationDeadline (due window : Int) : Int := due + window

theorem reporting_end_cannot_shorten_native_deadline (due window periodEnd : Int)
    (crosses : periodEnd < due + window) : periodEnd < nativeObligationDeadline due window := by
  exact crosses

theorem native_deadline_retains_original_window (due window : Int) :
    nativeObligationDeadline due window - due = window := by
  unfold nativeObligationDeadline
  omega

def closedEntryWindowTimingSupported (issued evaluated available decided observed completed witnessed : Int)
    (entryEligible : Bool) : Bool :=
  !entryEligible && decide (issued ≤ evaluated ∧ evaluated ≤ decided ∧ available ≤ decided ∧
    decided ≤ observed ∧ observed ≤ completed ∧ completed ≤ witnessed)

theorem closed_window_requires_causal_evidence (i e a d o c w : Int) (eligible : Bool)
    (supported : closedEntryWindowTimingSupported i e a d o c w eligible = true) :
    eligible = false ∧ i ≤ e ∧ e ≤ d ∧ a ≤ d ∧ d ≤ o ∧ o ≤ c ∧ c ≤ w := by
  simpa [closedEntryWindowTimingSupported] using supported

theorem eligible_entry_cannot_be_a_closed_window (i e a d o c w : Int) :
    closedEntryWindowTimingSupported i e a d o c w true = false := by
  simp [closedEntryWindowTimingSupported]

def reconciliationCompletionSupported (due deadline observed witnessed : Int) : Bool :=
  decide (due ≤ observed ∧ observed ≤ witnessed ∧ witnessed ≤ deadline)

theorem reconciliation_batching_keeps_each_original_deadline (d e o w : Int)
    (supported : reconciliationCompletionSupported d e o w = true) :
    d ≤ o ∧ o ≤ w ∧ w ≤ e := by
  simpa [reconciliationCompletionSupported] using supported

theorem late_reconciliation_cannot_repair_an_expired_obligation (d e o w : Int)
    (late : e < w) : reconciliationCompletionSupported d e o w = false := by
  simp [reconciliationCompletionSupported]
  omega

example : closedEntryWindowTimingSupported 0 0 4 5 6 7 8 false = true ∧
    closedEntryWindowTimingSupported 0 0 9 5 6 7 8 false = false := by decide

example : operationalAssessmentVerdict "MEETS_TARGET" 0 true 0 = "OPERATIONALLY_RELIABLE_PAPER" ∧
    operationalAssessmentVerdict "UNDETERMINED" 0 true 0 = "INCONCLUSIVE" := by decide

end Bayn
