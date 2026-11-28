module
import Lean.Elab.Tactic.Omega

@[expose] public section

namespace Bayn

inductive AuthorityLevel where
  | observe | execution
  deriving Repr, DecidableEq, BEq

inductive AuthorityKill where
  | clear | active
  deriving Repr, DecidableEq, BEq

inductive MutationOperationKind where
  | submit | cancel
  deriving Repr, DecidableEq

structure MutationAuthoritySnapshot where
  maximum : AuthorityLevel
  effective : AuthorityLevel
  kill : AuthorityKill
  generationHash : String
  generationMaximum : Option AuthorityLevel
  generationAccountId : Option String
  deriving Repr

def mutationAuthority (snapshot : Option MutationAuthoritySnapshot) (operation : MutationOperationKind)
    (closeOnly : Bool) : Option (String × String) :=
  match snapshot with
  | none => none
  | some authority =>
    let permitted := match operation with
      | .submit => decide (authority.effective = .execution ∧ authority.kill = .clear) || closeOnly
      | .cancel => decide (authority.effective = .execution ∨ authority.kill = .active)
    if authority.maximum = .execution ∧ authority.generationMaximum = some .execution ∧ permitted = true then
      authority.generationAccountId.map (fun account => (account, authority.generationHash))
    else none

theorem absent_authority_cannot_admit (operation : MutationOperationKind) (closeOnly : Bool) :
    mutationAuthority none operation closeOnly = none := rfl

theorem observe_maximum_cannot_admit (a : MutationAuthoritySnapshot) (operation : MutationOperationKind)
    (closeOnly : Bool) (h : a.maximum = .observe) : mutationAuthority (some a) operation closeOnly = none := by
  simp [mutationAuthority, h]

theorem unbound_generation_cannot_admit (a : MutationAuthoritySnapshot) (operation : MutationOperationKind)
    (closeOnly : Bool) (h : a.generationAccountId = none) : mutationAuthority (some a) operation closeOnly = none := by
  simp [mutationAuthority, h]

theorem killed_authority_cannot_admit_ordinary_submit (a : MutationAuthoritySnapshot) (h : a.kill = .active) :
    mutationAuthority (some a) .submit false = none := by
  simp [mutationAuthority, h]

theorem observe_generation_cannot_admit (a : MutationAuthoritySnapshot) (operation : MutationOperationKind)
    (closeOnly : Bool) (h : a.generationMaximum = some .observe) :
    mutationAuthority (some a) operation closeOnly = none := by
  simp [mutationAuthority, h]

theorem admitted_mutation_retains_generation (a : MutationAuthoritySnapshot) (operation : MutationOperationKind)
    (closeOnly : Bool) (account generation : String)
    (h : mutationAuthority (some a) operation closeOnly = some (account, generation)) :
    generation = a.generationHash ∧ a.generationAccountId = some account := by
  cases operation <;> cases accountBinding : a.generationAccountId <;> simp_all [mutationAuthority]

theorem restricted_authority_retains_bounded_close_and_cancel :
    let a : MutationAuthoritySnapshot := ⟨.execution, .observe, .active, "generation", some .execution, some "account"⟩
    mutationAuthority (some a) .submit false = none ∧
    mutationAuthority (some a) .submit true = some ("account", "generation") ∧
    mutationAuthority (some a) .cancel false = some ("account", "generation") := by decide

inductive MutationEventKind where
  | submitStarted | submitAccepted | submitRejected | submitDenied | submitUnknown
  | recoveryFound | recoveryNotFound | recoveryUnknown
  | cancelStarted | cancelAccepted | cancelUnknown
  deriving Repr, DecidableEq

def isRecoveryOutcome (next : MutationEventKind) : Bool :=
  decide (next = .recoveryFound ∨ next = .recoveryNotFound ∨ next = .recoveryUnknown)

def allowsMutationOutcome (previous next : MutationEventKind) : Bool :=
  match previous with
  | .submitStarted => decide (next = .submitAccepted ∨ next = .submitRejected ∨ next = .submitDenied ∨ next = .submitUnknown)
  | .cancelStarted => decide (next = .cancelAccepted ∨ next = .cancelUnknown)
  | .submitRejected | .submitDenied => false
  | .submitAccepted | .submitUnknown | .cancelAccepted | .cancelUnknown
    | .recoveryFound | .recoveryNotFound | .recoveryUnknown => isRecoveryOutcome next

theorem outcome_cannot_start_another_submission (previous : MutationEventKind) :
    allowsMutationOutcome previous .submitStarted = false := by cases previous <;> rfl

theorem outcome_cannot_start_another_cancellation (previous : MutationEventKind) :
    allowsMutationOutcome previous .cancelStarted = false := by cases previous <;> rfl

theorem uncertain_submission_accepts_only_recovery (next : MutationEventKind)
    (h : allowsMutationOutcome .submitUnknown next = true) :
    next = .recoveryFound ∨ next = .recoveryNotFound ∨ next = .recoveryUnknown := by
  cases next <;> simp_all [allowsMutationOutcome, isRecoveryOutcome]

theorem uncertain_cancellation_accepts_only_recovery (next : MutationEventKind)
    (h : allowsMutationOutcome .cancelUnknown next = true) :
    next = .recoveryFound ∨ next = .recoveryNotFound ∨ next = .recoveryUnknown := by
  cases next <;> simp_all [allowsMutationOutcome, isRecoveryOutcome]

theorem rejected_submission_cannot_append_outcome (next : MutationEventKind) :
    allowsMutationOutcome .submitRejected next = false := rfl

theorem denied_submission_cannot_append_outcome (next : MutationEventKind) :
    allowsMutationOutcome .submitDenied next = false := rfl

theorem uncertainty_has_reachable_recovery :
    allowsMutationOutcome .submitStarted .submitUnknown = true ∧
    allowsMutationOutcome .submitUnknown .recoveryFound = true := by decide

structure MutationRouting where
  startedAt : Int
  requestDispatchedAt : Option Int
  completedAt : Int
  deriving Repr, DecidableEq

structure MutationOutcomeEvidence where
  kind : MutationEventKind
  requestId : Option String
  responseStatus : Option Nat
  responseContentHash : Option String
  routing : Option MutationRouting
  denialReason : Option String
  brokerOrderId : Option String
  deriving Repr, DecidableEq

def sameMutationOutcome (previous next : MutationOutcomeEvidence) : Bool := decide (previous = next)

theorem outcome_replay_preserves_all_evidence (previous next : MutationOutcomeEvidence)
    (h : sameMutationOutcome previous next = true) : previous = next := of_decide_eq_true h

theorem outcome_replay_cannot_change_dispatch (previous next : MutationOutcomeEvidence)
    (h : sameMutationOutcome previous next = true) :
    previous.routing.map (·.requestDispatchedAt) = next.routing.map (·.requestDispatchedAt) := by
  rw [outcome_replay_preserves_all_evidence previous next h]

theorem missing_routing_cannot_replay_observed_routing (previous next : MutationOutcomeEvidence)
    (missing : previous.routing = none) (observed : next.routing ≠ none) :
    sameMutationOutcome previous next = false := by
  simp only [sameMutationOutcome, decide_eq_false_iff_not]
  intro h
  rw [← h, missing] at observed
  exact observed rfl

end Bayn
