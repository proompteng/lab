module
import Lean.Elab.Tactic.Omega

@[expose] public section

namespace Bayn

def registeredMarketWindow (sessionOpen sessionClose observedAt : Int) : Bool :=
  decide (sessionOpen ≤ observedAt ∧ observedAt < sessionClose)

theorem accepted_market_evidence_is_inside_window (sessionOpen sessionClose observedAt : Int)
    (accepted : registeredMarketWindow sessionOpen sessionClose observedAt = true) :
    sessionOpen ≤ observedAt ∧ observedAt < sessionClose := by
  simpa [registeredMarketWindow] using accepted

theorem continuous_market_cannot_extend_registered_hours (sessionOpen sessionClose observedAt : Int)
    (outside : observedAt < sessionOpen ∨ sessionClose ≤ observedAt) :
    registeredMarketWindow sessionOpen sessionClose observedAt = false := by
  simp [registeredMarketWindow]
  omega

theorem registered_market_window_boundaries :
    registeredMarketWindow 10 20 10 = true ∧ registeredMarketWindow 10 20 20 = false ∧
      registeredMarketWindow 10 10 10 = false := by decide

def signalWindowEnd (observedAt delay : Int) : Int := (observedAt - delay) / 60000 * 60000

def signalDue (windowEnd delay : Int) : Int := windowEnd + delay

def firstSignalDue (sessionOpen delay : Int) : Int := (sessionOpen / 60000 + 1) * 60000 + delay

theorem signal_window_precedes_availability (observedAt delay : Int) :
    signalDue (signalWindowEnd observedAt delay) delay ≤ observedAt ∧
    observedAt < signalDue (signalWindowEnd observedAt delay) delay + 60000 := by
  unfold signalDue signalWindowEnd
  omega

theorem first_signal_uses_completed_session_data (sessionOpen delay : Int) :
    sessionOpen < firstSignalDue sessionOpen delay - delay ∧
    firstSignalDue sessionOpen delay - delay ≤ sessionOpen + 60000 := by
  unfold firstSignalDue
  omega

def decisionWindowCount (sessionOpen sessionClose delay : Int) : Nat :=
  ((sessionClose - firstSignalDue sessionOpen delay + 59999) / 60000).toNat

def decisionDue (sessionOpen delay : Int) (index : Nat) : Int :=
  firstSignalDue sessionOpen delay + (index : Int) * 60000

theorem scheduled_windows_are_exact (sessionOpen sessionClose delay : Int) (index : Nat) :
    index < decisionWindowCount sessionOpen sessionClose delay ↔
      decisionDue sessionOpen delay index < sessionClose := by
  unfold decisionWindowCount decisionDue
  omega

theorem different_windows_cannot_share_a_due_time (sessionOpen delay : Int) (a b : Nat)
    (same : decisionDue sessionOpen delay a = decisionDue sessionOpen delay b) : a = b := by
  unfold decisionDue at same
  omega

def decisionWindows (sessionOpen sessionClose delay deadline : Int) : List (Int × Int) :=
  (List.range (decisionWindowCount sessionOpen sessionClose delay)).map fun index =>
    let due := decisionDue sessionOpen delay index
    (due, min (due + deadline) sessionClose)

structure HoldCompletion where
  observedAt : Int
  passObservedAt : Int
  completedAt : Int
  witnessedAt : Int
  validUntil : Int
  deriving Repr

def supportedHoldCompletion (e : HoldCompletion) : Prop :=
  e.observedAt ≤ e.passObservedAt ∧ e.passObservedAt ≤ e.completedAt ∧
  e.completedAt ≤ e.witnessedAt ∧ e.witnessedAt < e.validUntil

instance (e : HoldCompletion) : Decidable (supportedHoldCompletion e) := by
  unfold supportedHoldCompletion
  infer_instance

theorem expired_hold_cannot_count (e : HoldCompletion) (expired : e.validUntil ≤ e.witnessedAt) :
    ¬ supportedHoldCompletion e := by
  unfold supportedHoldCompletion
  omega

theorem hold_is_visible_before_expiry (e : HoldCompletion) (valid : supportedHoldCompletion e) :
    e.observedAt ≤ e.witnessedAt ∧ e.completedAt < e.validUntil := by
  unfold supportedHoldCompletion at valid
  omega

theorem hold_completion_is_reachable : supportedHoldCompletion ⟨1, 2, 3, 4, 5⟩ := by decide

end Bayn
