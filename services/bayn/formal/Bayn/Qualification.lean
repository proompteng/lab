module
public import Bayn.Economics
public import Bayn.Reliability
import Lean.Elab.Tactic.Omega

@[expose] public section

namespace Bayn

structure TariffInterval where
  starts : Int
  ends : Int
  deriving Repr

def tariffCoveredUntil (frontier : Int) : List TariffInterval → Int
  | [] => frontier
  | rate :: rest =>
    if frontier < rate.starts then frontier
    else tariffCoveredUntil (max frontier rate.ends) rest

def tariffCoversWindow (opening closing : Int) (rates : List TariffInterval) : Bool :=
  decide (closing < tariffCoveredUntil opening rates)

theorem tariff_frontier_has_no_invented_coverage (rates : List TariffInterval) (frontier time : Int)
    (afterStart : frontier ≤ time) (beforeEnd : time < tariffCoveredUntil frontier rates) :
    ∃ rate ∈ rates, rate.starts ≤ time ∧ time < rate.ends := by
  induction rates generalizing frontier with
  | nil => simp [tariffCoveredUntil] at beforeEnd; omega
  | cons rate rest ih =>
    simp only [tariffCoveredUntil] at beforeEnd
    split at beforeEnd
    · omega
    · rename_i connects
      by_cases reached : time < max frontier rate.ends
      · exact ⟨rate, by simp, by omega, by omega⟩
      · obtain ⟨later, member, bound⟩ := ih (max frontier rate.ends) (by omega) beforeEnd
        exact ⟨later, by simp [member], bound⟩

theorem accepted_tariff_prices_every_instant_through_close (opening closing time : Int)
    (rates : List TariffInterval) (accepted : tariffCoversWindow opening closing rates = true)
    (inWindow : opening ≤ time ∧ time ≤ closing) :
    ∃ rate ∈ rates, rate.starts ≤ time ∧ time < rate.ends := by
  simp only [tariffCoversWindow, decide_eq_true_eq] at accepted
  exact tariff_frontier_has_no_invented_coverage rates opening time inWindow.1 (by omega)

theorem tariff_gap_cannot_cover_later_sessions :
    tariffCoversWindow 10 30 [⟨10, 20⟩, ⟨21, 40⟩] = false := by decide

theorem tariff_expiring_at_close_is_insufficient :
    tariffCoversWindow 10 30 [⟨10, 30⟩] = false := by decide

theorem consecutive_tariffs_are_reachable :
    tariffCoversWindow 10 30 [⟨9, 20⟩, ⟨20, 31⟩] = true := by decide

structure ControlIdentity where
  strategyHash : String
  parametersHash : String
  protocolHash : String
  executionModelHash : String
  promptsHash : String
  continuationAndExitsHash : String
  deriving Repr, DecidableEq

def frozenDeployedControlIdentity : ControlIdentity := {
  strategyHash := "3da39b009a0cb2052b007ae9ba51f448c16b69281a37cf5ffe122314f1d801af",
  parametersHash := "cd004b8b43e50dde70ba70fb43deff19c5c65d60f4455e84a2e8df9991c0335f",
  protocolHash := "f38c7d47dc0b8eedb13da1ae7e29faa3da2ce8983fee05f4a2c89dc0ec59eb97",
  executionModelHash := "b7fed391f5dc25a41a257de470c96c337715477f1032c1d5d802020b35144b68",
  promptsHash := "2efd63f39ac6d6d16008b63bb5924c9925b1d7eb0b56e3aa6d07c313a5a998e6",
  continuationAndExitsHash := "861f6179c7ce96d3b7aa8f6f45e34d67612da42c92ae639edcceb2f2ca9e48c3"
}

def deployedControlPreserved (actual : ControlIdentity) : Prop := actual = frozenDeployedControlIdentity

instance (actual : ControlIdentity) : Decidable (deployedControlPreserved actual) :=
  inferInstanceAs (Decidable (actual = frozenDeployedControlIdentity))

theorem deployed_control_admission_preserves_every_identity (actual : ControlIdentity)
    (accepted : deployedControlPreserved actual) :
    actual.strategyHash = frozenDeployedControlIdentity.strategyHash ∧
      actual.parametersHash = frozenDeployedControlIdentity.parametersHash ∧
      actual.protocolHash = frozenDeployedControlIdentity.protocolHash ∧
      actual.executionModelHash = frozenDeployedControlIdentity.executionModelHash ∧
      actual.promptsHash = frozenDeployedControlIdentity.promptsHash ∧
      actual.continuationAndExitsHash = frozenDeployedControlIdentity.continuationAndExitsHash := by
  cases accepted
  simp

theorem changed_deployed_parameters_are_rejected (actual : ControlIdentity)
    (changed : actual.parametersHash ≠ frozenDeployedControlIdentity.parametersHash) :
    ¬ deployedControlPreserved actual := by
  intro accepted
  exact changed (deployed_control_admission_preserves_every_identity actual accepted).2.1

theorem changed_deployed_execution_model_is_rejected (actual : ControlIdentity)
    (changed : actual.executionModelHash ≠ frozenDeployedControlIdentity.executionModelHash) :
    ¬ deployedControlPreserved actual := by
  intro accepted
  exact changed (congrArg ControlIdentity.executionModelHash accepted)

theorem changed_deployed_prompts_is_rejected (actual : ControlIdentity)
    (changed : actual.promptsHash ≠ frozenDeployedControlIdentity.promptsHash) :
    ¬ deployedControlPreserved actual := by
  intro accepted
  exact changed (congrArg ControlIdentity.promptsHash accepted)

theorem changed_deployed_continuation_is_rejected (actual : ControlIdentity)
    (changed : actual.continuationAndExitsHash ≠ frozenDeployedControlIdentity.continuationAndExitsHash) :
    ¬ deployedControlPreserved actual := by
  intro accepted
  exact changed (congrArg ControlIdentity.continuationAndExitsHash accepted)

theorem original_deployed_control_is_reachable : deployedControlPreserved frozenDeployedControlIdentity := rfl

structure RegisteredRiskLimits where
  order : Nat
  symbol : Nat
  gross : Nat
  net : Nat
  turnover : Nat
  deriving Repr, DecidableEq

def withinFrozenRiskLimits (limits : RegisteredRiskLimits) : Prop :=
  limits.order ≤ 40000000000 ∧ limits.symbol ≤ 40000000000 ∧
  limits.gross ≤ 100000000000 ∧ limits.net ≤ 100000000000 ∧ limits.turnover ≤ 200000000000

instance (limits : RegisteredRiskLimits) : Decidable (withinFrozenRiskLimits limits) := by
  unfold withinFrozenRiskLimits
  infer_instance

structure RegisteredRiskBinding where
  declaredPolicyHash : String
  materialPolicyHash : String
  declaredAccountHash : String
  materialAccountHash : String
  approvedPolicyHashes : List String
  limits : RegisteredRiskLimits
  deriving Repr, DecidableEq

def registeredRiskPreserved (binding : RegisteredRiskBinding) : Prop :=
  binding.declaredPolicyHash = binding.materialPolicyHash ∧
  binding.declaredAccountHash = binding.materialAccountHash ∧
  binding.declaredPolicyHash ∈ binding.approvedPolicyHashes ∧
  withinFrozenRiskLimits binding.limits

instance (binding : RegisteredRiskBinding) : Decidable (registeredRiskPreserved binding) := by
  unfold registeredRiskPreserved
  infer_instance

theorem admitted_risk_preserves_material_and_account (binding : RegisteredRiskBinding)
    (accepted : registeredRiskPreserved binding) :
    binding.declaredPolicyHash = binding.materialPolicyHash ∧
      binding.declaredAccountHash = binding.materialAccountHash := ⟨accepted.1, accepted.2.1⟩

theorem unapproved_risk_cannot_register (binding : RegisteredRiskBinding)
    (unapproved : binding.declaredPolicyHash ∉ binding.approvedPolicyHashes) :
    ¬ registeredRiskPreserved binding := fun accepted => unapproved accepted.2.2.1

theorem admitted_risk_preserves_every_frozen_ceiling (binding : RegisteredRiskBinding)
    (accepted : registeredRiskPreserved binding) : withinFrozenRiskLimits binding.limits := accepted.2.2.2

theorem expanded_turnover_cannot_register (binding : RegisteredRiskBinding)
    (expanded : 200000000000 < binding.limits.turnover) : ¬ registeredRiskPreserved binding := by
  intro accepted
  have bounded := accepted.2.2.2.2.2.2.2
  omega

theorem matched_approved_risk_is_reachable : registeredRiskPreserved {
    declaredPolicyHash := "retained", materialPolicyHash := "retained",
    declaredAccountHash := "account", materialAccountHash := "account",
    approvedPolicyHashes := ["retained", "paper"],
    limits := ⟨40000000000, 40000000000, 100000000000, 100000000000, 200000000000⟩ } := by decide

structure QualificationEvidence where
  netProfit : Int
  bestControlProfit : Int
  profitLowerBoundTotal : Int
  pairedLowerBoundTotals : List Int
  profitWithoutBest : Int
  additionalCostProfit : Int
  latencyStressProfit : Int
  maximumSessionLoss : Nat
  maximumDrawdown : Nat
  completedEpisodes : Nat
  filledNotional : Nat
  reliability : List (Nat × Nat)
  safetyViolations : Nat
  completeEvidence : Bool
  supportedRealism : Bool
  deriving Repr

def economicTargets (e : QualificationEvidence) : Prop :=
  5000000000 ≤ e.netProfit ∧
  5 * e.bestControlProfit ≤ 4 * e.netProfit ∧
  0 < e.profitLowerBoundTotal ∧
  e.pairedLowerBoundTotals.length = 3 ∧
  (∀ bound ∈ e.pairedLowerBoundTotals, 1000000000 < bound) ∧
  0 < e.profitWithoutBest ∧ 0 < e.additionalCostProfit ∧ 0 < e.latencyStressProfit ∧
  e.maximumSessionLoss ≤ 1000000000 ∧ e.maximumDrawdown ≤ 2500000000 ∧
  200 ≤ e.completedEpisodes ∧ 2000000000000 ≤ e.filledNotional

def qualificationPass (e : QualificationEvidence) : Prop :=
  economicTargets e ∧ e.reliability.length = 4 ∧
  (∀ counts ∈ e.reliability, reliabilityPass counts.1 counts.2) ∧
  e.safetyViolations = 0 ∧ e.completeEvidence = true ∧ e.supportedRealism = true

instance (e : QualificationEvidence) : Decidable (economicTargets e) := by unfold economicTargets; infer_instance
instance (e : QualificationEvidence) : Decidable (qualificationPass e) := by unfold qualificationPass; infer_instance

theorem qualification_implies_all_requirements (e : QualificationEvidence) (h : qualificationPass e) :
    economicTargets e ∧ e.reliability.length = 4 ∧
    (∀ counts ∈ e.reliability, reliabilityPass counts.1 counts.2) ∧
    e.safetyViolations = 0 ∧ e.completeEvidence = true ∧ e.supportedRealism = true := h

theorem missing_evidence_cannot_qualify (e : QualificationEvidence) (h : e.completeEvidence = false) :
    ¬ qualificationPass e := by
  simp [qualificationPass, h]

theorem safety_has_no_error_budget (e : QualificationEvidence) (h : 0 < e.safetyViolations) :
    ¬ qualificationPass e := by
  simp only [qualificationPass]
  omega

theorem losing_control_cannot_replace_absolute_profit (e : QualificationEvidence) (h : e.netProfit ≤ 0) :
    ¬ qualificationPass e := by
  unfold qualificationPass economicTargets
  omega

def qualifyingExample : QualificationEvidence := {
  netProfit := 20000000000, bestControlProfit := 2000000000,
  profitLowerBoundTotal := 20000000000,
  pairedLowerBoundTotals := [18000000000, 18000000000, 18000000000],
  profitWithoutBest := 19000000000, additionalCostProfit := 18000000000,
  latencyStressProfit := 19000000000,
  maximumSessionLoss := 0, maximumDrawdown := 0,
  completedEpisodes := 200, filledNotional := 2000000000000,
  reliability := [(1000, 1000), (1000, 1000), (1000, 1000), (1000, 1000)],
  safetyViolations := 0, completeEvidence := true, supportedRealism := true
}

theorem qualification_is_reachable : qualificationPass qualifyingExample := by
  decide

end Bayn
