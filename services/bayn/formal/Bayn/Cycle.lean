module
public import Bayn.Economics
import Lean.Elab.Tactic.Omega

@[expose] public section

namespace Bayn

inductive CycleState where
  | pending | active | completed | noTrade | blocked
  deriving Repr, DecidableEq

def cycleTransitionAllowed (before after : CycleState) : Bool :=
  match before with
  | .pending => decide (after = .active ∨ after = .blocked)
  | .active => decide (after = .completed ∨ after = .noTrade ∨ after = .blocked)
  | _ => false

structure CycleIdentity where
  cycleId : String
  strategyName : String
  strategyProtocolHash : String
  qualificationRunId : String
  accountId : String
  deriving Repr, DecidableEq

structure CycleEvidence where
  identity : CycleIdentity
  state : CycleState
  createdAt : Int
  updatedAt : Int
  submissionOpenAt : Int
  submissionCutoffAt : Int
  snapshotId : Option String
  decisionHash : Option String
  deriving Repr, DecidableEq

def unusedEntryExpiry (cycle : CycleEvidence) : Int :=
  min cycle.submissionCutoffAt (max cycle.createdAt cycle.submissionOpenAt + 60000)

def expiredUnusedEntry (cycle : CycleEvidence) (now : Int) : Bool :=
  decide (cycle.snapshotId = none ∧ cycle.decisionHash = none ∧ unusedEntryExpiry cycle ≤ now)

def cycleActivation (cycle : CycleEvidence) (now : Int) : String :=
  if cycle.state = .active then "Replay"
  else if !cycleTransitionAllowed cycle.state .active then "conflict"
  else if now ≥ cycle.submissionCutoffAt then
    if expiredUnusedEntry cycle now then "BLOCKED_UNUSED_ENTRY_EXPIRED" else "BLOCKED_MISSED_SUBMISSION_DEADLINE"
  else if now < cycle.updatedAt then "conflict"
  else "Persist"

structure CycleSnapshotIdentity where
  snapshotId : String
  contentHash : String
  observedAt : Int
  deriving Repr, DecidableEq

structure CycleDecisionEvidence where
  identity : CycleIdentity
  contentHash : String
  executionMode : Bool
  snapshot : CycleSnapshotIdentity
  executionMarketData : Option CycleSnapshotIdentity
  decisionMarketData : Option CycleSnapshotIdentity
  createdAt : Int
  submissionCutoffAt : Int
  deriving Repr, DecidableEq

def decisionSnapshotMatches (cycle : CycleEvidence) (document : CycleDecisionEvidence) : Bool :=
  let selected := document.decisionMarketData.or document.executionMarketData
  decide (cycle.snapshotId = none ∧ document.executionMarketData.isSome = true ∧ selected = some document.snapshot)

def decisionIdentityMatches (cycle : CycleEvidence) (document : CycleDecisionEvidence) (now : Int) : Prop :=
  document.identity.cycleId = cycle.identity.cycleId ∧
  document.identity.strategyName = cycle.identity.strategyName ∧
  document.identity.strategyProtocolHash = cycle.identity.strategyProtocolHash ∧
  (document.executionMode = true → document.identity.qualificationRunId = cycle.identity.qualificationRunId) ∧
  decisionSnapshotMatches cycle document = true ∧
  document.identity.accountId = cycle.identity.accountId ∧
  document.submissionCutoffAt = cycle.submissionCutoffAt ∧
  document.createdAt ≤ now ∧ cycle.updatedAt ≤ document.createdAt

instance (cycle : CycleEvidence) (document : CycleDecisionEvidence) (now : Int) :
    Decidable (decisionIdentityMatches cycle document now) := inferInstanceAs (Decidable (_ ∧ _))

def cycleDecisionBinding (cycle : CycleEvidence) (document : CycleDecisionEvidence) (now : Int)
    (storedCount : Nat) (storedEquivalent : Bool) : String :=
  match cycle.decisionHash with
  | some hash =>
    if hash = document.contentHash ∧ storedCount = 1 ∧ storedEquivalent = true then "Replay" else "conflict"
  | none =>
    if cycle.state ≠ .active then "conflict"
    else if expiredUnusedEntry cycle now then "BLOCKED_UNUSED_ENTRY_EXPIRED"
    else if now ≥ cycle.submissionCutoffAt then "BLOCKED_MISSED_SUBMISSION_DEADLINE"
    else if ¬decisionIdentityMatches cycle document now then "invariant"
    else if now < cycle.updatedAt then "conflict"
    else "Persist"

def cycleCompletion (cycle : CycleEvidence) (completed : Bool) (now : Int) : String :=
  let target := if completed then CycleState.completed else CycleState.noTrade
  if cycle.state = target then "Replay"
  else if !cycleTransitionAllowed cycle.state target then "conflict"
  else if now < cycle.updatedAt then "conflict"
  else if cycle.decisionHash.isNone then "invariant"
  else "VerifyDecision"

structure CycleCompletionDocument where
  contentHash : String
  planned : Bool
  noTrade : Bool
  executionMode : Bool
  riskBlocked : Bool
  completionEvidence : Bool
  deriving Repr, DecidableEq

def cycleCompletionDocumentPass (completed : Bool) (decisionHash : String)
    (documents : List CycleCompletionDocument) : Bool :=
  match documents with
  | [document] => decide (
    document.contentHash = decisionHash ∧
    (if completed then document.planned = true else document.noTrade = true) ∧
    ¬(document.executionMode = true ∧ document.riskBlocked = true) ∧
    ¬(document.executionMode = true ∧ completed = true ∧ document.completionEvidence = false))
  | _ => false

theorem terminal_cycle_cannot_transition (before after : CycleState)
    (terminal : before = .completed ∨ before = .noTrade ∨ before = .blocked) :
    cycleTransitionAllowed before after = false := by rcases terminal with h | h | h <;> simp [h, cycleTransitionAllowed]

theorem unused_lease_never_extends_submission_cutoff (cycle : CycleEvidence) :
    unusedEntryExpiry cycle ≤ cycle.submissionCutoffAt := by unfold unusedEntryExpiry; omega

theorem bound_decision_is_not_an_unused_entry (cycle : CycleEvidence) (now : Int) (hash : String)
    (bound : cycle.decisionHash = some hash) : expiredUnusedEntry cycle now = false := by
  simp [expiredUnusedEntry, bound]

theorem active_activation_is_replay (cycle : CycleEvidence) (now : Int) (active : cycle.state = .active) :
    cycleActivation cycle now = "Replay" := by simp [cycleActivation, active]

theorem activation_persistence_precedes_cutoff (cycle : CycleEvidence) (now : Int)
    (persist : cycleActivation cycle now = "Persist") : now < cycle.submissionCutoffAt := by
  by_cases active : cycle.state = .active <;>
    by_cases allowed : cycleTransitionAllowed cycle.state .active = true <;>
    by_cases cutoff : now ≥ cycle.submissionCutoffAt <;>
    by_cases expired : expiredUnusedEntry cycle now = true <;>
    simp_all [cycleActivation] <;> omega

theorem new_binding_preserves_identity_and_deadline (cycle : CycleEvidence) (document : CycleDecisionEvidence)
    (now : Int) (count : Nat) (equivalent : Bool)
    (persist : cycleDecisionBinding cycle document now count equivalent = "Persist") :
    cycle.decisionHash = none ∧ cycle.state = .active ∧ expiredUnusedEntry cycle now = false ∧
      now < cycle.submissionCutoffAt ∧ decisionIdentityMatches cycle document now := by
  cases bound : cycle.decisionHash with
  | none =>
    by_cases active : cycle.state = .active <;>
      by_cases expired : expiredUnusedEntry cycle now = true <;>
      by_cases cutoff : now ≥ cycle.submissionCutoffAt <;>
      by_cases identity : decisionIdentityMatches cycle document now <;>
      simp_all [cycleDecisionBinding]
  | some hash =>
    simp only [cycleDecisionBinding, bound] at persist
    split at persist <;> simp_all

theorem expired_unused_entry_cannot_bind (cycle : CycleEvidence) (document : CycleDecisionEvidence)
    (now : Int) (count : Nat) (equivalent : Bool) (expired : expiredUnusedEntry cycle now = true) :
    cycleDecisionBinding cycle document now count equivalent ≠ "Persist" := by
  intro persist
  have allowed := new_binding_preserves_identity_and_deadline cycle document now count equivalent persist
  simp_all

theorem bound_decision_replay_requires_exact_retained_document (cycle : CycleEvidence)
    (document : CycleDecisionEvidence) (now : Int) (count : Nat) (equivalent : Bool) (hash : String)
    (bound : cycle.decisionHash = some hash)
    (replay : cycleDecisionBinding cycle document now count equivalent = "Replay") :
    hash = document.contentHash ∧ count = 1 ∧ equivalent = true := by
  simp only [cycleDecisionBinding, bound] at replay
  split at replay <;> simp_all

theorem completion_requires_bound_current_decision (cycle : CycleEvidence) (completed : Bool) (now : Int)
    (verify : cycleCompletion cycle completed now = "VerifyDecision") :
    cycle.state = .active ∧ cycle.updatedAt ≤ now ∧ cycle.decisionHash.isSome = true := by
  cases state : cycle.state <;> cases completed <;>
    cases bound : cycle.decisionHash <;>
    by_cases reversed : now < cycle.updatedAt <;>
    simp_all [cycleCompletion, cycleTransitionAllowed]

theorem completion_requires_one_durable_document (completed : Bool) (hash : String)
    (documents : List CycleCompletionDocument) (accepted : cycleCompletionDocumentPass completed hash documents = true) :
    documents.length = 1 := by
  cases documents with
  | nil => simp [cycleCompletionDocumentPass] at accepted
  | cons first rest =>
    cases rest with
    | nil => rfl
    | cons second rest => simp [cycleCompletionDocumentPass] at accepted

theorem executed_completion_requires_financial_evidence (hash : String) (document : CycleCompletionDocument)
    (execution : document.executionMode = true)
    (accepted : cycleCompletionDocumentPass true hash [document] = true) :
    document.contentHash = hash ∧ document.planned = true ∧ document.riskBlocked = false ∧
      document.completionEvidence = true := by
  simp [cycleCompletionDocumentPass, execution] at accepted
  simpa using accepted

def reachableCycle : CycleEvidence :=
  ⟨⟨"cycle", "jev", "protocol", "qualification", "account"⟩, .active, 0, 1, 0, 100000, none, none⟩

def reachableCycleDecision : CycleDecisionEvidence :=
  ⟨reachableCycle.identity, "decision", true, ⟨"snapshot", "content", 1⟩,
    some ⟨"snapshot", "content", 1⟩, none, 1, 100000⟩

theorem cycle_binding_has_reachable_success :
    cycleDecisionBinding reachableCycle reachableCycleDecision 2 0 false = "Persist" := by decide

theorem cycle_completion_has_reachable_success :
    cycleCompletion { reachableCycle with decisionHash := some "decision" } true 2 = "VerifyDecision" ∧
    cycleCompletionDocumentPass true "decision" [⟨"decision", true, false, true, false, true⟩] = true := by decide

end Bayn
