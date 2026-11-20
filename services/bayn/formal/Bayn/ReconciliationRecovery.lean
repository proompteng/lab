module
import Lean.Elab.Tactic.Omega

@[expose] public section

namespace Bayn

/-- A sorted, lossless field representation of a decoded broker order, not a precomputed match flag. -/
abbrev ProtectionOrderFields := List (String × String)

def protectionOrderPayload (fields : ProtectionOrderFields) : ProtectionOrderFields :=
  fields.filter fun field => field.1 != "observedAt" && field.1 != "parentBrokerOrderId"

/-- The verified nested observation owns parent identity; a flat representation may omit it. -/
def sameProtectionObservation (nested standalone : ProtectionOrderFields) : Bool :=
  decide ((standalone.lookup "parentBrokerOrderId" = none ∨
    standalone.lookup "parentBrokerOrderId" = nested.lookup "parentBrokerOrderId") ∧
    protectionOrderPayload nested = protectionOrderPayload standalone)

theorem accepted_protection_overlap_preserves_complete_payload (nested standalone : ProtectionOrderFields)
    (accepted : sameProtectionObservation nested standalone = true) :
    protectionOrderPayload nested = protectionOrderPayload standalone := by
  exact (of_decide_eq_true accepted).2

theorem conflicting_protection_payload_cannot_canonicalize (nested standalone : ProtectionOrderFields)
    (conflict : protectionOrderPayload nested ≠ protectionOrderPayload standalone) :
    sameProtectionObservation nested standalone = false := by
  simp [sameProtectionObservation, conflict]

theorem foreign_protection_parent_cannot_canonicalize (nested standalone : ProtectionOrderFields)
    (present : standalone.lookup "parentBrokerOrderId" ≠ none)
    (foreign : standalone.lookup "parentBrokerOrderId" ≠ nested.lookup "parentBrokerOrderId") :
    sameProtectionObservation nested standalone = false := by
  simp [sameProtectionObservation, present, foreign]

/-- Two different broker orders cannot be identified merely because their client IDs match. -/
def brokerClientIdentityCompatible (leftBroker leftClient rightBroker rightClient : String) : Bool :=
  decide (leftClient ≠ rightClient ∨ leftBroker = rightBroker)

theorem genuine_client_collision_is_rejected (leftBroker rightBroker client : String)
    (distinct : leftBroker ≠ rightBroker) :
    brokerClientIdentityCompatible leftBroker client rightBroker client = false := by
  simp [brokerClientIdentityCompatible, distinct]

inductive ReconciliationRecoveryAuthority where
  | observe | execution
  deriving Repr, DecidableEq

/-- A confirmed durable restriction, not merely an attempted containment write. -/
structure RestrictedReconciliationState where
  account : String
  identity : String
  version : Nat
  restrictedAt : Int
  containmentConfirmed : Bool
  killed : Bool
  effective : ReconciliationRecoveryAuthority
  reason : String
  deriving Repr, DecidableEq

/-- Abstract evidence required by the recovery contract; database authenticity is not proved here. -/
structure ReconciliationRecoveryEvidence where
  account : String
  identity : String
  expectedVersion : Nat
  successorVersion : Nat
  status : String
  expectedHash : String
  observedHash : String
  discrepancies : Nat
  reconciledAt : Int
  settledAt : Int
  activatedAt : Int
  openPositions : Nat
  openOrUnboundOrders : Nat
  unresolvedMutations : Nat
  unsettledIntents : Nat
  deriving Repr, DecidableEq

def reconciliationRecoveryEligible (state : RestrictedReconciliationState)
    (evidence : ReconciliationRecoveryEvidence) : Prop :=
  state.containmentConfirmed = true ∧ state.killed = true ∧ state.effective = .observe ∧
  state.reason = "reconciliation pass incomplete" ∧
  evidence.account = state.account ∧ evidence.identity = state.identity ∧
  evidence.expectedVersion = state.version ∧ evidence.successorVersion = state.version + 1 ∧
  evidence.status = "EXACT" ∧ evidence.expectedHash = evidence.observedHash ∧ evidence.discrepancies = 0 ∧
  state.restrictedAt < evidence.reconciledAt ∧ evidence.settledAt < evidence.reconciledAt ∧
  evidence.reconciledAt < evidence.activatedAt ∧ evidence.openPositions = 0 ∧
  evidence.openOrUnboundOrders = 0 ∧ evidence.unresolvedMutations = 0 ∧ evidence.unsettledIntents = 0

instance (state : RestrictedReconciliationState) (evidence : ReconciliationRecoveryEvidence) :
    Decidable (reconciliationRecoveryEligible state evidence) := by
  unfold reconciliationRecoveryEligible
  infer_instance

def guardedReconciliationRecovery (state : RestrictedReconciliationState)
    (evidence : ReconciliationRecoveryEvidence) : Option RestrictedReconciliationState :=
  if reconciliationRecoveryEligible state evidence then
    some { state with
      version := evidence.successorVersion
      restrictedAt := evidence.activatedAt
      killed := false
      effective := .observe
      reason := "" }
  else none

theorem recovered_state_has_valid_evidence (state next : RestrictedReconciliationState)
    (evidence : ReconciliationRecoveryEvidence)
    (recovered : guardedReconciliationRecovery state evidence = some next) :
    reconciliationRecoveryEligible state evidence := by
  unfold guardedReconciliationRecovery at recovered
  split at recovered
  · assumption
  · contradiction

theorem reconciliation_recovery_never_grants_execution (state next : RestrictedReconciliationState)
    (evidence : ReconciliationRecoveryEvidence)
    (recovered : guardedReconciliationRecovery state evidence = some next) :
    next.effective = .observe ∧ next.killed = false ∧ next.account = state.account ∧
    next.identity = state.identity ∧ next.version = state.version + 1 := by
  unfold guardedReconciliationRecovery at recovered
  split at recovered
  next eligible =>
    cases Option.some.inj recovered
    exact ⟨rfl, rfl, rfl, rfl, eligible.2.2.2.2.2.2.2.1⟩
  next => contradiction

theorem stale_reconciliation_cannot_clear_kill (state : RestrictedReconciliationState)
    (evidence : ReconciliationRecoveryEvidence) (stale : evidence.reconciledAt ≤ state.restrictedAt) :
    guardedReconciliationRecovery state evidence = none := by
  have notFresh : ¬state.restrictedAt < evidence.reconciledAt := by omega
  simp [guardedReconciliationRecovery, reconciliationRecoveryEligible, notFresh]

theorem unresolved_mutation_cannot_clear_kill (state : RestrictedReconciliationState)
    (evidence : ReconciliationRecoveryEvidence) (unresolved : evidence.unresolvedMutations ≠ 0) :
    guardedReconciliationRecovery state evidence = none := by
  simp [guardedReconciliationRecovery, reconciliationRecoveryEligible, unresolved]

theorem unconfirmed_containment_cannot_claim_recovery (state : RestrictedReconciliationState)
    (evidence : ReconciliationRecoveryEvidence) (unconfirmed : state.containmentConfirmed = false) :
    guardedReconciliationRecovery state evidence = none := by
  simp [guardedReconciliationRecovery, reconciliationRecoveryEligible, unconfirmed]

theorem stale_recovery_owner_cannot_clear_kill (state : RestrictedReconciliationState)
    (evidence : ReconciliationRecoveryEvidence) (stale : evidence.expectedVersion ≠ state.version) :
    guardedReconciliationRecovery state evidence = none := by
  simp [guardedReconciliationRecovery, reconciliationRecoveryEligible, stale]

/-- A possible guarded step, not a scheduler fairness or eventual broker-response theorem. -/
theorem repaired_settled_evidence_permits_observe_step (state : RestrictedReconciliationState)
    (evidence : ReconciliationRecoveryEvidence) (eligible : reconciliationRecoveryEligible state evidence) :
    ∃ next, guardedReconciliationRecovery state evidence = some next := by
  simp [guardedReconciliationRecovery, eligible]

theorem repaired_reconciliation_has_reachable_success :
    let state : RestrictedReconciliationState :=
      ⟨"account", "sandbox-identity", 1, 10, true, true, .observe, "reconciliation pass incomplete"⟩
    let evidence : ReconciliationRecoveryEvidence :=
      ⟨"account", "sandbox-identity", 1, 2, "EXACT", "same-hash", "same-hash", 0, 13, 12, 14, 0, 0, 0, 0⟩
    (guardedReconciliationRecovery state evidence).isSome = true := by decide

end Bayn
