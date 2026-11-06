module
public import Mathlib.Data.Nat.Log
public import Mathlib.Data.Nat.Sqrt
public import Bayn.Qualification

@[expose] public section

namespace Bayn

def ceilSquareRoot (n : Nat) : Nat :=
  if Nat.sqrt n * Nat.sqrt n = n then Nat.sqrt n else Nat.sqrt n + 1

theorem ceil_square_root_is_outward (n : Nat) : n ≤ ceilSquareRoot n * ceilSquareRoot n := by
  unfold ceilSquareRoot
  split
  · omega
  · exact Nat.le_of_lt (Nat.lt_succ_sqrt n)

def conditionalAlphaDenominator (attempt claims : Nat) : Nat := 20 * attempt * (attempt + 1) * claims

def conditionalLogBound (denominator : Nat) : Nat :=
  if denominator ≤ 1 then 0 else (denominator - 1).log2 + 1

theorem conditional_log_rounds_outward (denominator : Nat) :
    denominator ≤ 2 ^ conditionalLogBound denominator := by
  unfold conditionalLogBound
  split
  · omega
  · have bound := Nat.lt_pow_succ_log_self (by decide : 1 < 2) (denominator - 1)
    rw [← Nat.log2_eq_log_two] at bound
    omega

def conditionalRadius (count width denominator : Nat) : Nat :=
  ceilSquareRoot ((count * width * width * conditionalLogBound denominator + 1) / 2)

theorem conditional_radius_never_understates_variance (count width denominator : Nat) :
    count * width * width * conditionalLogBound denominator ≤
      2 * (conditionalRadius count width denominator) ^ 2 := by
  have square := ceil_square_root_is_outward ((count * width * width * conditionalLogBound denominator + 1) / 2)
  unfold conditionalRadius
  simp only [Nat.pow_two]
  omega

def conditionalLowerSum (values : List Int) (width denominator : Nat) : Int :=
  values.sum - (conditionalRadius values.length width denominator : Int)

theorem zero_width_has_no_uncertainty_penalty (values : List Int) (denominator : Nat) :
    conditionalLowerSum values 0 denominator = values.sum := by
  simp [conditionalLowerSum, conditionalRadius, ceilSquareRoot]

structure ConditionalQualificationEvidence where
  sessionCount : Nat
  controlCount : Nat
  netProfit : Int
  profitLowerBoundTotal : Int
  pairedLowerBoundTotals : List Int
  maximumSessionLoss : Nat
  maximumDrawdown : Nat
  maximumSessionLossLimit : Nat
  maximumDrawdownLimit : Nat
  reliability : List (Nat × Nat)
  safetyViolations : Nat
  completeEvidence : Bool
  supportedRealism : Bool
  deriving Repr

def conditionalEconomicTargets (e : ConditionalQualificationEvidence) : Prop :=
  0 < e.sessionCount ∧ 0 < e.controlCount ∧ 0 < e.netProfit ∧ 0 < e.profitLowerBoundTotal ∧
  e.pairedLowerBoundTotals.length = e.controlCount ∧ (∀ bound ∈ e.pairedLowerBoundTotals, 0 < bound) ∧
  e.maximumSessionLoss ≤ e.maximumSessionLossLimit ∧ e.maximumDrawdown ≤ e.maximumDrawdownLimit

def conditionalQualificationPass (e : ConditionalQualificationEvidence) : Prop :=
  conditionalEconomicTargets e ∧ operationalReliability e.reliability ∧
  e.safetyViolations = 0 ∧ e.completeEvidence = true ∧ e.supportedRealism = true

instance (e : ConditionalQualificationEvidence) : Decidable (conditionalEconomicTargets e) := by
  unfold conditionalEconomicTargets; infer_instance
instance (e : ConditionalQualificationEvidence) : Decidable (conditionalQualificationPass e) := by
  unfold conditionalQualificationPass; infer_instance

theorem conditional_qualification_preserves_every_requirement (e : ConditionalQualificationEvidence)
    (passes : conditionalQualificationPass e) :
    conditionalEconomicTargets e ∧ operationalReliability e.reliability ∧
      e.safetyViolations = 0 ∧ e.completeEvidence = true ∧ e.supportedRealism = true := passes

theorem conditional_qualification_cannot_use_losing_controls_instead_of_profit (e : ConditionalQualificationEvidence)
    (noProfit : e.netProfit ≤ 0) : ¬ conditionalQualificationPass e := by
  unfold conditionalQualificationPass conditionalEconomicTargets
  omega

theorem conditional_qualification_cannot_ignore_missing_evidence (e : ConditionalQualificationEvidence)
    (missing : e.completeEvidence = false) : ¬ conditionalQualificationPass e := by
  simp [conditionalQualificationPass, missing]

theorem conditional_qualification_preserves_zero_safety_budget (e : ConditionalQualificationEvidence)
    (violation : 0 < e.safetyViolations) : ¬ conditionalQualificationPass e := by
  unfold conditionalQualificationPass
  omega

def singleSessionQualification : ConditionalQualificationEvidence := {
  sessionCount := 1, controlCount := 1, netProfit := 1000000, profitLowerBoundTotal := 1000000,
  pairedLowerBoundTotals := [500000], maximumSessionLoss := 0, maximumDrawdown := 0,
  maximumSessionLossLimit := 1000000000, maximumDrawdownLimit := 2500000000,
  reliability := [(390,390),(780,780),(1,1),(0,0)], safetyViolations := 0,
  completeEvidence := true, supportedRealism := true
}

theorem single_session_without_arbitrary_activity_quota_is_reachable :
    conditionalQualificationPass singleSessionQualification := by decide

theorem one_missed_equity_decision_cannot_meet_999 :
    ¬ conditionalQualificationPass {singleSessionQualification with reliability := [(389,390),(780,780),(1,1),(0,0)]} := by decide

example : conditionalAlphaDenominator 1 2 = 80 ∧
    conditionalLowerSum [1, 1] 4 80 ≤ 0 ∧
    conditionalLowerSum [1000] 0 80 = 1000 := by decide +kernel

end Bayn
