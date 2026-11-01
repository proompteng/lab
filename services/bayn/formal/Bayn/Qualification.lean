module
public import Bayn.Economics
public import Bayn.Reliability
public import Bayn.Bootstrap
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

structure RegisteredRiskBinding where
  declaredPolicyHash : String
  materialPolicyHash : String
  declaredAccountHash : String
  materialAccountHash : String
  approvedPolicyHashes : List String
  deriving Repr, DecidableEq

def registeredRiskPreserved (binding : RegisteredRiskBinding) : Prop :=
  binding.declaredPolicyHash = binding.materialPolicyHash ∧
  binding.declaredAccountHash = binding.materialAccountHash ∧
  binding.declaredPolicyHash ∈ binding.approvedPolicyHashes

instance (binding : RegisteredRiskBinding) : Decidable (registeredRiskPreserved binding) := by
  unfold registeredRiskPreserved
  infer_instance

theorem admitted_risk_preserves_material_and_account (binding : RegisteredRiskBinding)
    (accepted : registeredRiskPreserved binding) :
    binding.declaredPolicyHash = binding.materialPolicyHash ∧
      binding.declaredAccountHash = binding.materialAccountHash := ⟨accepted.1, accepted.2.1⟩

theorem unapproved_risk_cannot_register (binding : RegisteredRiskBinding)
    (unapproved : binding.declaredPolicyHash ∉ binding.approvedPolicyHashes) :
    ¬ registeredRiskPreserved binding := fun accepted => unapproved accepted.2.2

theorem matched_approved_risk_is_reachable : registeredRiskPreserved {
    declaredPolicyHash := "retained", materialPolicyHash := "retained",
    declaredAccountHash := "account", materialAccountHash := "account",
    approvedPolicyHashes := ["retained", "paper"] } := by decide

structure QualificationEvidence where
  sessionCount : Nat
  controlCount : Nat
  blockLength : Nat
  bootstrapReplicates : Nat
  attemptIndex : Nat
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

def economicTargets (e : QualificationEvidence) : Prop :=
  0 < e.blockLength ∧ e.blockLength < e.sessionCount ∧
  tailResolutionSupported e.attemptIndex e.controlCount e.bootstrapReplicates ∧
  0 < e.netProfit ∧ 0 < e.profitLowerBoundTotal ∧
  0 < e.controlCount ∧ e.pairedLowerBoundTotals.length = e.controlCount ∧ (∀ bound ∈ e.pairedLowerBoundTotals, 0 < bound) ∧
  e.maximumSessionLoss ≤ e.maximumSessionLossLimit ∧ e.maximumDrawdown ≤ e.maximumDrawdownLimit

def operationalReliability (counts : List (Nat × Nat)) : Prop :=
  counts.length = 4 ∧ (∀ pair ∈ counts.take 3, reliabilityPass pair.1 pair.2) ∧
  (∀ pair ∈ counts.drop 3, (pair.1 = 0 ∧ pair.2 = 0) ∨ reliabilityPass pair.1 pair.2)

def qualificationPass (e : QualificationEvidence) : Prop :=
  economicTargets e ∧ operationalReliability e.reliability ∧
  e.safetyViolations = 0 ∧ e.completeEvidence = true ∧ e.supportedRealism = true

instance (e : QualificationEvidence) : Decidable (economicTargets e) := by unfold economicTargets; infer_instance
instance (counts : List (Nat × Nat)) : Decidable (operationalReliability counts) := by unfold operationalReliability; infer_instance
instance (e : QualificationEvidence) : Decidable (qualificationPass e) := by unfold qualificationPass; infer_instance

theorem qualification_implies_all_requirements (e : QualificationEvidence) (h : qualificationPass e) :
    economicTargets e ∧ operationalReliability e.reliability ∧
    e.safetyViolations = 0 ∧ e.completeEvidence = true ∧ e.supportedRealism = true := h

theorem missing_evidence_cannot_qualify (e : QualificationEvidence) (h : e.completeEvidence = false) :
    ¬ qualificationPass e := by simp [qualificationPass, h]

theorem safety_has_no_error_budget (e : QualificationEvidence) (h : 0 < e.safetyViolations) :
    ¬ qualificationPass e := by unfold qualificationPass; omega

theorem losing_control_cannot_replace_absolute_profit (e : QualificationEvidence) (h : e.netProfit ≤ 0) :
    ¬ qualificationPass e := by unfold qualificationPass economicTargets; omega

def qualifyingExample : QualificationEvidence := {
  sessionCount := 4, controlCount := 1, blockLength := 2, bootstrapReplicates := 10000, attemptIndex := 1, netProfit := 1000000, profitLowerBoundTotal := 500000,
  pairedLowerBoundTotals := [500000], maximumSessionLoss := 0, maximumDrawdown := 0,
  maximumSessionLossLimit := 5000000000, maximumDrawdownLimit := 5000000000,
  reliability := [(1000, 1000), (1000, 1000), (1000, 1000), (0, 0)],
  safetyViolations := 0, completeEvidence := true, supportedRealism := true
}

theorem qualification_is_reachable : qualificationPass qualifyingExample := by decide

theorem unused_recovery_does_not_require_an_incident : operationalReliability [(1000,1000),(1000,1000),(1000,1000),(0,0)] := by decide

theorem empty_required_work_cannot_qualify : ¬ qualificationPass { qualifyingExample with reliability := [(0,0),(1000,1000),(1000,1000),(0,0)] } := by decide

theorem no_control_cannot_establish_edge (e : QualificationEvidence) (empty : e.pairedLowerBoundTotals = []) :
    ¬ qualificationPass e := by
  simp only [qualificationPass, economicTargets, empty, List.length_nil]
  omega

theorem empty_window_cannot_qualify (e : QualificationEvidence) (empty : e.sessionCount = 0) :
    ¬ qualificationPass e := by
  simp only [qualificationPass, economicTargets, empty]
  omega

end Bayn
