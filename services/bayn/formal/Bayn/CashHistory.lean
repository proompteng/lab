module
import Lean.Elab.Tactic.Omega

@[expose] public section

namespace Bayn

structure CashMovement where
  source : String
  earliest : Int
  latest : Int
  amount : Int
  deriving Repr, DecidableEq

structure CashHistory where
  completeFrom : Int
  completeThrough : Int
  changes : List CashMovement
  deriving Repr, DecidableEq

structure CashObservation where
  time : Int
  cash : Option Int
  deriving Repr, DecidableEq

structure CashAdjustment where
  time : Int
  amount : Int
  deriving Repr, DecidableEq

def cashHistoryValid (history : CashHistory) : Prop :=
  history.completeFrom ≤ history.completeThrough ∧ (history.changes.map CashMovement.source).Nodup ∧
  ∀ change ∈ history.changes, change.earliest ≤ change.latest ∧ change.latest ≤ history.completeThrough

instance (history : CashHistory) : Decidable (cashHistoryValid history) := by
  unfold cashHistoryValid
  infer_instance

def cashMovementTotal (history : CashHistory) (time : Int) : Option Int :=
  if cashHistoryValid history ∧ history.completeFrom ≤ time ∧ time ≤ history.completeThrough ∧
      ¬ ∃ change ∈ history.changes, change.earliest ≤ time ∧ time < change.latest then
    some ((history.changes.filter (fun change => change.latest ≤ time)).map CashMovement.amount).sum
  else none

def cumulativeCash (history : CashHistory) (flows : List CashAdjustment) (time : Int) : Option Int :=
  (cashMovementTotal history time).map (fun amount =>
    amount + ((flows.filter (fun flow => flow.time ≤ time)).map CashAdjustment.amount).sum)

def cashAnchor (marks : List CashObservation) (history : CashHistory) (flows : List CashAdjustment) : Option CashObservation :=
  marks.find? (fun mark => mark.cash.isSome && (cumulativeCash history flows mark.time).isSome)

def cashConflict (marks : List CashObservation) (history : CashHistory) (flows : List CashAdjustment) (baseline : Int) : Bool :=
  marks.any fun mark => match mark.cash, cumulativeCash history flows mark.time with
    | some cash, some delta => cash != baseline + delta
    | _, _ => false

def fillCashObservation (baseline : Int) (delta : Option Int) (mark : CashObservation) : CashObservation :=
  match mark.cash, delta with
  | none, some change => { mark with cash := some (baseline + change) }
  | _, _ => mark

def projectCash (marks : List CashObservation) (history : Option CashHistory)
    (flows : Option (List CashAdjustment)) (closeAt : Int) : List CashObservation :=
  match history, flows with
  | some h, some f =>
    if h.completeThrough < closeAt then marks else
    match cashAnchor marks h f with
    | none => marks
    | some anchor => match anchor.cash, cumulativeCash h f anchor.time with
      | some cash, some delta =>
        let baseline := cash - delta
        if cashConflict marks h f baseline then marks.map (fun mark => { mark with cash := none })
        else marks.map (fun mark => fillCashObservation baseline (cumulativeCash h f mark.time) mark)
      | _, _ => marks
  | _, _ => marks

theorem invalid_cash_history_is_unknown (h : CashHistory) (time : Int) (invalid : ¬cashHistoryValid h) :
    cashMovementTotal h time = none := by simp [cashMovementTotal, invalid]

theorem future_cash_history_is_unknown (h : CashHistory) (time : Int) (future : h.completeThrough < time) :
    cashMovementTotal h time = none := by simp [cashMovementTotal, show ¬time ≤ h.completeThrough by omega]

theorem before_cash_coverage_is_unknown (h : CashHistory) (time : Int) (earlier : time < h.completeFrom) :
    cashMovementTotal h time = none := by simp [cashMovementTotal, show ¬h.completeFrom ≤ time by omega]

theorem ambiguous_cash_movement_is_unknown (h : CashHistory) (time : Int)
    (ambiguous : ∃ change ∈ h.changes, change.earliest ≤ time ∧ time < change.latest) :
    cashMovementTotal h time = none := by simp [cashMovementTotal, ambiguous]

theorem no_history_cannot_invent_cash (marks : List CashObservation) (flows : Option (List CashAdjustment)) (closeAt : Int) :
    projectCash marks none flows closeAt = marks := rfl

theorem no_flow_coverage_cannot_invent_cash (marks : List CashObservation) (history : Option CashHistory) (closeAt : Int) :
    projectCash marks history none closeAt = marks := by cases history <;> rfl

theorem incomplete_cash_history_cannot_project (marks : List CashObservation) (h : CashHistory)
    (flows : List CashAdjustment) (closeAt : Int) (incomplete : h.completeThrough < closeAt) :
    projectCash marks (some h) (some flows) closeAt = marks := by simp [projectCash, incomplete]

theorem known_cash_observation_is_retained (baseline cash : Int) (delta : Option Int) (time : Int) :
    fillCashObservation baseline delta { time, cash := some cash } = { time, cash := some cash } := by
  cases delta <;> rfl

theorem ambiguous_cash_is_not_interpolated (baseline : Int) (mark : CashObservation) :
    fillCashObservation baseline none mark = mark := by
  cases h : mark.cash <;> simp [fillCashObservation, h]

theorem projected_cash_conserves_movement (anchorCash anchorDelta delta time : Int) :
    (fillCashObservation (anchorCash - anchorDelta) (some delta) { time, cash := none }).cash =
      some (anchorCash + (delta - anchorDelta)) := by
  simp [fillCashObservation]; omega

theorem conflicting_cash_invalidates_all (marks : List CashObservation) (h : CashHistory) (f : List CashAdjustment)
    (closeAt : Int) (complete : closeAt ≤ h.completeThrough) (anchor : CashObservation)
    (found : cashAnchor marks h f = some anchor) (cash delta : Int)
    (known : anchor.cash = some cash) (measured : cumulativeCash h f anchor.time = some delta)
    (conflict : cashConflict marks h f (cash - delta) = true) :
    projectCash marks (some h) (some f) closeAt = marks.map (fun mark => { mark with cash := none }) := by
  simp [projectCash, show ¬h.completeThrough < closeAt by omega, found, known, measured, conflict]

theorem reachable_backwards_cash_projection :
    projectCash [{ time := 0, cash := none }, { time := 30, cash := some 998 }, { time := 60, cash := none }]
      (some { completeFrom := 0, completeThrough := 120, changes := [{ source := "fill", earliest := 20, latest := 20, amount := -2 }] })
      (some []) 60 = [{ time := 0, cash := some 1000 }, { time := 30, cash := some 998 }, { time := 60, cash := some 998 }] := by decide

end Bayn
