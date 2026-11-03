module
import Lean.Elab.Tactic.Omega

@[expose] public section

namespace Bayn

def decisionAdmissionEligible (sourceCommitted sourceMatches : Bool) : Bool := sourceCommitted && sourceMatches

theorem admitted_source_is_committed_and_owned (committed owned : Bool)
    (h : decisionAdmissionEligible committed owned = true) : committed = true ∧ owned = true := by
  simpa [decisionAdmissionEligible] using h

def mutationAdmissionIndependent (ambient : Bool) : Bool := !ambient

def supportedProtectionAdmission (sourceCommitted riskCommitted sourceMatches : Bool)
    (outcome : String) (decided admitted expires : Int) : Prop :=
  sourceCommitted = true ∧ sourceMatches = true ∧ riskCommitted = true ∧ outcome = "APPROVED" ∧
  decided ≤ admitted ∧ admitted ≤ expires

instance (sourceCommitted riskCommitted sourceMatches : Bool) (outcome : String) (decided admitted expires : Int) :
    Decidable (supportedProtectionAdmission sourceCommitted riskCommitted sourceMatches outcome decided admitted expires) :=
  inferInstanceAs (Decidable (_ ∧ _))

theorem replacement_admission_requires_committed_approval (sourceCommitted riskCommitted sourceMatches : Bool)
    (outcome : String) (decided admitted expires : Int)
    (h : supportedProtectionAdmission sourceCommitted riskCommitted sourceMatches outcome decided admitted expires) :
    riskCommitted = true ∧ outcome = "APPROVED" := ⟨h.2.2.1, h.2.2.2.1⟩

theorem expired_replacement_approval_cannot_supply_persistence (sourceCommitted riskCommitted sourceMatches : Bool)
    (outcome : String) (decided admitted expires : Int) (late : expires < admitted) :
    ¬ supportedProtectionAdmission sourceCommitted riskCommitted sourceMatches outcome decided admitted expires := by
  unfold supportedProtectionAdmission; omega

theorem replacement_admission_has_reachable_success :
    supportedProtectionAdmission true true true "APPROVED" 0 1 2 := by decide

def decisionCommitmentUpperBound (receiptValid admissionIndependent routed : Bool)
    (created admitted routing observed asOf : Int) : Option Int :=
  if receiptValid && admissionIndependent && routed && decide (created ≤ admitted) &&
      decide (admitted ≤ routing) && decide (routing ≤ asOf) && decide (observed ≤ asOf)
    then some routing else none

theorem a_decision_bound_uses_its_routing_event (receipt independent routed : Bool)
    (created admitted routing observed asOf bound : Int)
    (h : decisionCommitmentUpperBound receipt independent routed created admitted routing observed asOf = some bound) :
    bound = routing ∧ created ≤ bound := by
  simp only [decisionCommitmentUpperBound] at h
  split at h
  next condition =>
    simp only [Bool.and_eq_true, decide_eq_true_eq] at condition
    have equality := Option.some.inj h
    rcases condition with ⟨⟨⟨⟨⟨⟨_, _⟩, _⟩, beforeAdmission⟩, beforeRouting⟩, _⟩, _⟩
    constructor
    · exact equality.symm
    · omega
  next => contradiction

theorem an_uncommitted_admission_cannot_bound_a_decision
    (receipt routed : Bool) (created admitted routing observed asOf : Int) :
    decisionCommitmentUpperBound receipt false routed created admitted routing observed asOf = none := by
  simp [decisionCommitmentUpperBound]

theorem an_ambient_transaction_cannot_be_independent : mutationAdmissionIndependent true = false := by decide

theorem a_later_database_clock_does_not_reverse_causal_admission :
    decisionCommitmentUpperBound true true true 0 1 2 9 10 = some 2 := by decide

theorem a_routing_bound_contains_the_actual_commit
    (committed admitted routed : Int) (sourceCommitted : committed ≤ admitted)
    (admissionBeforeRouting : admitted ≤ routed) : committed ≤ routed := by omega

def persistenceObservation (created knownBy routing : Int) : String :=
  if knownBy < created then "VIOLATED"
  else if knownBy ≤ routing then "SUPPORTED"
  else "INCOMPLETE"

theorem a_late_observation_alone_does_not_prove_a_violation (created knownBy routing : Int)
    (afterDecision : created ≤ knownBy) (afterRouting : routing < knownBy) :
    persistenceObservation created knownBy routing = "INCOMPLETE" := by
  have notBefore : ¬ knownBy < created := by omega
  have notRouted : ¬ knownBy ≤ routing := by omega
  simp [persistenceObservation, notBefore, notRouted]

theorem an_observation_before_creation_is_impossible (created knownBy routing : Int)
    (beforeCreation : knownBy < created) : persistenceObservation created knownBy routing = "VIOLATED" := by
  simp [persistenceObservation, beforeCreation]

end Bayn
