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

end Bayn
