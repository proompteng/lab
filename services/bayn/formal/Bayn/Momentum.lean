module
public import Bayn.Economics
import Lean.Elab.Tactic.Omega

@[expose] public section

namespace Bayn

structure MomentumPrices where
  symbol : String
  reference : Int
  bid : Int
  ask : Int
  benchmarkReference : Int
  benchmarkBid : Int
  benchmarkAsk : Int
  quoteAllowed : Bool
  deriving Repr, DecidableEq

structure MomentumScore where
  symbol : String
  numerator : Int
  denominator : Int
  deriving Repr, DecidableEq

def momentumScore (p : MomentumPrices) : MomentumScore := {
  symbol := p.symbol
  numerator := (p.bid + p.ask - 2 * p.reference) * p.benchmarkReference -
    (p.benchmarkBid + p.benchmarkAsk - 2 * p.benchmarkReference) * p.reference
  denominator := 2 * p.reference * p.benchmarkReference
}

def momentumEligible (p : MomentumPrices) : Bool :=
  p.quoteAllowed && decide (0 < p.reference ∧ 0 < p.benchmarkReference ∧
    2 * p.reference < p.bid + p.ask ∧ 0 < (momentumScore p).numerator)

theorem momentum_excess_is_unrounded (p : MomentumPrices) :
    (momentumScore p).numerator =
      (p.bid + p.ask) * p.benchmarkReference - (p.benchmarkBid + p.benchmarkAsk) * p.reference := by
  have common : (2 * p.reference) * p.benchmarkReference = (2 * p.benchmarkReference) * p.reference := by
    simp only [Int.mul_comm, Int.mul_left_comm]
  simp only [momentumScore, Int.sub_mul]
  omega

theorem eligible_momentum_has_positive_absolute_and_excess_return (p : MomentumPrices)
    (h : momentumEligible p = true) :
    p.quoteAllowed = true ∧ 2 * p.reference < p.bid + p.ask ∧
      0 < (momentumScore p).numerator ∧ 0 < (momentumScore p).denominator := by
  simp only [momentumEligible, Bool.and_eq_true, decide_eq_true_eq] at h
  exact ⟨h.1, h.2.2.2.1, h.2.2.2.2, Int.mul_pos (Int.mul_pos (by decide) h.2.1) h.2.2.1⟩

def momentumPreferred (a b : MomentumScore) : Bool :=
  let left := a.numerator * b.denominator
  let right := b.numerator * a.denominator
  if left = right then decide (a.symbol ≤ b.symbol) else decide (right < left)

def momentumAtLeast (a b : MomentumScore) : Prop :=
  b.numerator * a.denominator ≤ a.numerator * b.denominator

instance (a b : MomentumScore) : Decidable (momentumAtLeast a b) := inferInstanceAs (Decidable (_ ≤ _))

theorem preferred_momentum_never_has_lower_score (a b : MomentumScore)
    (h : momentumPreferred a b = true) : momentumAtLeast a b := by
  by_cases tie : a.numerator * b.denominator = b.numerator * a.denominator
  · unfold momentumAtLeast; omega
  · simp [momentumPreferred, tie] at h
    exact Int.le_of_lt h

theorem nonpreferred_momentum_never_has_higher_score (a b : MomentumScore)
    (h : momentumPreferred a b = false) : momentumAtLeast b a := by
  by_cases tie : a.numerator * b.denominator = b.numerator * a.denominator
  · unfold momentumAtLeast; omega
  · simp [momentumPreferred, tie] at h
    exact h

theorem equal_momentum_scores_use_symbol_order (a b : MomentumScore)
    (tie : a.numerator * b.denominator = b.numerator * a.denominator) :
    momentumPreferred a b = decide (a.symbol ≤ b.symbol) := by
  simp [momentumPreferred, tie]

theorem momentum_score_order_transitive (a b c : MomentumScore)
    (ad : 0 < a.denominator) (bd : 0 < b.denominator) (cd : 0 < c.denominator)
    (ab : momentumAtLeast a b) (bc : momentumAtLeast b c) : momentumAtLeast a c := by
  unfold momentumAtLeast at *
  have first := Int.mul_le_mul_of_nonneg_right ab (Int.le_of_lt cd)
  have second := Int.mul_le_mul_of_nonneg_right bc (Int.le_of_lt ad)
  have middle : b.numerator * a.denominator * c.denominator = b.numerator * c.denominator * a.denominator := by
    simp only [Int.mul_comm, Int.mul_left_comm]
  have left : c.numerator * b.denominator * a.denominator = (c.numerator * a.denominator) * b.denominator := by
    simp only [Int.mul_comm, Int.mul_left_comm]
  have right : a.numerator * b.denominator * c.denominator = (a.numerator * c.denominator) * b.denominator := by
    simp only [Int.mul_comm, Int.mul_left_comm]
  have combined : (c.numerator * a.denominator) * b.denominator ≤ (a.numerator * c.denominator) * b.denominator := by
    omega
  by_cases ordered : c.numerator * a.denominator ≤ a.numerator * c.denominator
  · exact ordered
  · have strict : a.numerator * c.denominator < c.numerator * a.denominator := by omega
    have impossible := Int.mul_lt_mul_of_pos_right strict bd
    omega

def bestMomentum (prices : List MomentumPrices) : Option MomentumScore :=
  match prices with
  | [] => none
  | p :: rest =>
    if momentumEligible p then
      match bestMomentum rest with
      | none => some (momentumScore p)
      | some previous => some (if momentumPreferred (momentumScore p) previous then momentumScore p else previous)
    else bestMomentum rest

theorem best_momentum_is_an_eligible_source (prices : List MomentumPrices) (selected : MomentumScore)
    (h : bestMomentum prices = some selected) :
    ∃ p ∈ prices, momentumEligible p = true ∧ momentumScore p = selected := by
  induction prices with
  | nil => simp [bestMomentum] at h
  | cons p rest ih =>
    simp only [bestMomentum] at h
    split at h
    next eligible =>
      cases previous : bestMomentum rest with
      | none =>
        simp only [previous, Option.some.injEq] at h
        exact ⟨p, by simp, eligible, h⟩
      | some score =>
        simp only [previous, Option.some.injEq] at h
        split at h
        next => exact ⟨p, by simp, eligible, h⟩
        next =>
          subst selected
          obtain ⟨source, member, allowed, identity⟩ := ih previous
          exact ⟨source, by simp [member], allowed, identity⟩
    next =>
      obtain ⟨source, member, allowed, identity⟩ := ih h
      exact ⟨source, by simp [member], allowed, identity⟩

theorem best_momentum_exists_for_eligible (prices : List MomentumPrices) (p : MomentumPrices)
    (member : p ∈ prices) (eligible : momentumEligible p = true) : bestMomentum prices ≠ none := by
  induction prices with
  | nil => simp at member
  | cons first rest ih =>
    simp only [bestMomentum]
    split
    · cases bestMomentum rest <;> simp
    · apply ih
      rcases List.mem_cons.mp member with same | inRest
      · subst p; contradiction
      · exact inRest

theorem best_momentum_dominates_every_eligible_source (prices : List MomentumPrices) (selected : MomentumScore)
    (h : bestMomentum prices = some selected) :
    ∀ p ∈ prices, momentumEligible p = true → momentumAtLeast selected (momentumScore p) := by
  induction prices generalizing selected with
  | nil => simp [bestMomentum] at h
  | cons first rest ih =>
    intro p member eligible
    simp only [bestMomentum] at h
    split at h
    next firstEligible =>
      cases previous : bestMomentum rest with
      | none =>
        simp only [previous, Option.some.injEq] at h
        subst selected
        rcases List.mem_cons.mp member with same | inRest
        · subst p; exact Int.le_refl _
        · exact False.elim (best_momentum_exists_for_eligible rest p inRest eligible previous)
      | some score =>
        simp only [previous, Option.some.injEq] at h
        have tailBest := ih score previous
        obtain ⟨source, sourceMember, sourceEligible, scoreIdentity⟩ := best_momentum_is_an_eligible_source rest score previous
        have scorePositive : 0 < score.denominator := by
          rw [← scoreIdentity]; exact (eligible_momentum_has_positive_absolute_and_excess_return source sourceEligible).2.2.2
        have firstPositive := (eligible_momentum_has_positive_absolute_and_excess_return first firstEligible).2.2.2
        have pPositive := (eligible_momentum_has_positive_absolute_and_excess_return p eligible).2.2.2
        split at h
        next preferred =>
          subst selected
          rcases List.mem_cons.mp member with same | inRest
          · subst p; exact Int.le_refl _
          · exact momentum_score_order_transitive _ _ _ firstPositive scorePositive pPositive
              (preferred_momentum_never_has_lower_score _ _ preferred) (tailBest p inRest eligible)
        next notPreferred =>
          subst selected
          rcases List.mem_cons.mp member with same | inRest
          · subst p; exact nonpreferred_momentum_never_has_higher_score _ _ (Bool.eq_false_iff.mpr notPreferred)
          · exact tailBest p inRest eligible
    next notEligible =>
      rcases List.mem_cons.mp member with same | inRest
      · subst p; contradiction
      · exact ih selected h p inRest eligible

/-- Funding is tested only for the winner. A failed funding attempt cannot select another candidate. -/
def fundedMomentumSelection (prices : List MomentumPrices) (funded : Bool) : Option String :=
  if funded then (bestMomentum prices).map (·.symbol) else none

theorem unfunded_momentum_never_reselects (prices : List MomentumPrices) :
    fundedMomentumSelection prices false = none := rfl

def momentumRequiredTargetNet (acquisition : Nat) : Nat := (acquisition * 10100 + 9999) / 10000

theorem momentum_target_covers_frozen_profit_floor (acquisition : Nat) :
    acquisition * 10100 ≤ momentumRequiredTargetNet acquisition * 10000 := by
  unfold momentumRequiredTargetNet
  omega

theorem momentum_target_exceeds_positive_acquisition (acquisition : Nat) (positive : 0 < acquisition) :
    acquisition < momentumRequiredTargetNet acquisition := by
  have floor := momentum_target_covers_frozen_profit_floor acquisition
  omega

def momentumFundedPayoffs (acquisition stopNet targetNet : Int) : Bool :=
  decide (0 < acquisition ∧ 0 < stopNet ∧ stopNet < acquisition ∧
    acquisition * 10100 ≤ targetNet * 10000)

theorem funded_momentum_retains_loss_and_possible_profit (acquisition stopNet targetNet : Int)
    (accepted : momentumFundedPayoffs acquisition stopNet targetNet = true) :
    stopNet < acquisition ∧ acquisition < targetNet := by
  simp only [momentumFundedPayoffs, decide_eq_true_eq] at accepted
  omega

theorem momentum_selection_is_reachable :
    (bestMomentum [⟨"AAPL", 100, 102, 102, 100, 100, 100, true⟩]).map (·.symbol) = some "AAPL" := by decide

theorem momentum_ties_use_symbol_order :
    (bestMomentum [⟨"AMZN", 100, 102, 102, 100, 100, 100, true⟩,
      ⟨"AAPL", 100, 102, 102, 100, 100, 100, true⟩]).map (·.symbol) = some "AAPL" := by decide

theorem momentum_requires_both_absolute_and_relative_advantage :
    bestMomentum [⟨"AAPL", 100, 99, 99, 100, 98, 98, true⟩,
      ⟨"AMZN", 100, 101, 101, 100, 102, 102, true⟩] = none := by decide

theorem funded_momentum_does_not_establish_positive_expectancy (acquisition stopNet targetNet cost : Int)
    (accepted : momentumFundedPayoffs acquisition stopNet targetNet = true) (costNonnegative : 0 ≤ cost) :
    binaryEdgeNumerator (targetNet - acquisition) (acquisition - stopNet) cost 0 1 < 0 := by
  have loss := (funded_momentum_retains_loss_and_possible_profit acquisition stopNet targetNet accepted).1
  unfold binaryEdgeNumerator
  omega

theorem funded_momentum_can_have_negative_expected_net_profit :
    momentumFundedPayoffs 10000 9950 10100 = true ∧
    binaryEdgeNumerator 100 50 1 1 10 < 0 := by decide

structure NativeControlCommitments where
  strategyHash : String
  parametersHash : String
  protocolHash : String
  promptsHash : String
  executionModelHash : String
  deriving Repr, DecidableEq

def nativeControlAdmitted (expected actual : NativeControlCommitments) : Bool := decide (actual = expected)

theorem admitted_native_control_preserves_all_commitments (expected actual : NativeControlCommitments)
    (accepted : nativeControlAdmitted expected actual = true) :
    actual.strategyHash = expected.strategyHash ∧ actual.parametersHash = expected.parametersHash ∧
    actual.protocolHash = expected.protocolHash ∧ actual.promptsHash = expected.promptsHash ∧
    actual.executionModelHash = expected.executionModelHash := by
  have equal : actual = expected := of_decide_eq_true accepted
  subst actual
  simp

theorem native_control_cannot_add_unregistered_providers (expected actual : NativeControlCommitments)
    (changed : actual.promptsHash ≠ expected.promptsHash) : nativeControlAdmitted expected actual = false := by
  simp only [nativeControlAdmitted, decide_eq_false_iff_not]
  intro equal
  exact changed (congrArg NativeControlCommitments.promptsHash equal)

theorem unchanged_native_control_is_reachable (expected : NativeControlCommitments) :
    nativeControlAdmitted expected expected = true := by simp [nativeControlAdmitted]

end Bayn
