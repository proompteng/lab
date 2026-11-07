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


structure ScheduledWork where
  id : String
  kind : String
  due : Int
  deadline : Int
  deriving Repr

structure CompletedWork where
  id : String
  completedAt : Int
  correct : Bool
  deriving Repr

def reliabilityKinds : List String := ["DECISION", "RECONCILIATION", "MUTATION", "RECOVERY"]

def workGood (work : ScheduledWork) (completions : List CompletedWork) : Bool :=
  match completions.find? (fun completion => completion.id == work.id) with
  | none => false
  | some completion => completion.correct && decide (work.due ≤ completion.completedAt ∧ completion.completedAt ≤ work.deadline)

def workPending (asOf : Int) (work : ScheduledWork) (completions : List CompletedWork) : Bool :=
  decide (asOf < work.deadline) && !(completions.any (fun completion => completion.id == work.id))

structure ReliabilityClassResult where
  kind : String
  status : String
  scheduled : Nat
  good : Nat
  pending : Nat
  missed : List String
  deriving Repr, DecidableEq

def measureWorkClass (asOf : Int) (retained recoveryComplete : Bool)
    (schedule : List ScheduledWork) (completions : List CompletedWork) (kind : String) : ReliabilityClassResult :=
  let work := schedule.filter (fun obligation => obligation.kind == kind)
  let good := (work.filter (fun obligation => workGood obligation completions)).length
  let pending := (work.filter (fun obligation => workPending asOf obligation completions)).length
  let missed := (work.filter (fun obligation => !workGood obligation completions &&
    !workPending asOf obligation completions)).map (·.id)
  let status := if !retained && recoveryComplete && kind == "RECOVERY" && work.isEmpty then "NOT_APPLICABLE"
    else if 0 < pending || work.isEmpty then "UNDETERMINED"
    else if 999 * work.length ≤ 1000 * good then "MEETS_TARGET" else "MISSES_TARGET"
  ⟨kind, status, work.length, good, pending, missed⟩

def measureWork (asOf : Int) (retained recoveryComplete : Bool)
    (schedule : List ScheduledWork) (completions : List CompletedWork) : Option (List ReliabilityClassResult) :=
  if !(schedule.map (·.id)).Nodup || !(completions.map (·.id)).Nodup ||
      !schedule.all (fun work => reliabilityKinds.contains work.kind && decide (work.due ≤ work.deadline)) ||
      !completions.all (fun completion => decide (completion.completedAt ≤ asOf) && schedule.any
        (fun work => completion.id == work.id && decide (work.due ≤ completion.completedAt))) then none
  else some (reliabilityKinds.map (measureWorkClass asOf retained recoveryComplete schedule completions))

def measuredWorkStatus (classes : List ReliabilityClassResult) : String :=
  if classes.any (fun result => result.status == "MISSES_TARGET") then "MISSES_TARGET"
  else if classes.all (fun result => result.status == "MEETS_TARGET" || result.status == "NOT_APPLICABLE")
    then "MEETS_TARGET" else "UNDETERMINED"

theorem absent_completion_cannot_be_good (work : ScheduledWork) : workGood work [] = false := by
  simp [workGood]

theorem late_original_completion_cannot_be_good (work : ScheduledWork) (completion : CompletedWork)
    (same : completion.id = work.id) (late : work.deadline < completion.completedAt) : workGood work [completion] = false := by
  simp [workGood, same, show ¬completion.completedAt ≤ work.deadline by omega]

theorem counted_successes_cannot_exceed_registered_work (work : List ScheduledWork) (completions : List CompletedWork) :
    (work.filter (fun obligation => workGood obligation completions)).length ≤ work.length :=
  List.length_filter_le _ _

example : measureWork 10 false true [⟨"missing", "DECISION", 0, 5⟩] [] =
    some [⟨"DECISION","MISSES_TARGET",1,0,0,["missing"]⟩,
      ⟨"RECONCILIATION","UNDETERMINED",0,0,0,[]⟩,
      ⟨"MUTATION","UNDETERMINED",0,0,0,[]⟩,
      ⟨"RECOVERY","NOT_APPLICABLE",0,0,0,[]⟩] := by decide

end Bayn
