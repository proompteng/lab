module
import Lean.Elab.Tactic.Omega

@[expose] public section

namespace Bayn

structure HandoffIdentity where
  hash : String
  payload : String
  deriving Repr, DecidableEq

structure HandoffState where
  stored : Option HandoffIdentity
  resolved : Bool
  deriving Repr, DecidableEq

structure HandoffAdmission where
  state : HandoffState
  dispatch : Bool
  deriving Repr, DecidableEq

def commitInferenceHandoff (ambientTransaction : Bool) (state : HandoffState)
    (input : HandoffIdentity) : Option HandoffAdmission :=
  if ambientTransaction then none else
    match state.stored with
    | none => some ⟨⟨some input, state.resolved⟩, !state.resolved⟩
    | some previous => if previous = input then some ⟨state, false⟩ else none

theorem handoff_requires_independent_commit (state : HandoffState) (input : HandoffIdentity) :
    commitInferenceHandoff true state input = none := rfl

theorem handoff_replay_retains_first_record (input : HandoffIdentity) (resolved : Bool) :
    commitInferenceHandoff false ⟨some input, resolved⟩ input =
      some ⟨⟨some input, resolved⟩, false⟩ := by simp [commitInferenceHandoff]

theorem changed_handoff_is_rejected (first next : HandoffIdentity) (resolved : Bool)
    (different : first ≠ next) :
    commitInferenceHandoff false ⟨some first, resolved⟩ next = none := by
  simp [commitInferenceHandoff, different]

theorem resolved_request_retains_cost_without_dispatch (input : HandoffIdentity) :
    commitInferenceHandoff false ⟨none, true⟩ input = some ⟨⟨some input, true⟩, false⟩ := rfl

theorem accepted_handoff_preserves_resolution_and_exact_record (ambient : Bool)
    (state : HandoffState) (input : HandoffIdentity) (result : HandoffAdmission)
    (accepted : commitInferenceHandoff ambient state input = some result) :
    result.state.stored = some input ∧ result.state.resolved = state.resolved := by
  cases ambient with
  | true => simp [commitInferenceHandoff] at accepted
  | false =>
    cases stored : state.stored with
    | none => simp [commitInferenceHandoff, stored] at accepted; subst result; simp
    | some previous =>
      by_cases same : previous = input
      · simp [commitInferenceHandoff, stored, same] at accepted
        subst result
        simp [stored, same]
      · simp [commitInferenceHandoff, stored, same] at accepted

theorem committed_handoff_cannot_dispatch_again (ambient : Bool) (state : HandoffState)
    (previous input : HandoffIdentity) (result : HandoffAdmission)
    (stored : state.stored = some previous)
    (accepted : commitInferenceHandoff ambient state input = some result) : result.dispatch = false := by
  cases ambient with
  | true => simp [commitInferenceHandoff] at accepted
  | false =>
    by_cases same : previous = input
    · simp [commitInferenceHandoff, stored, same] at accepted
      subst result
      rfl
    · simp [commitInferenceHandoff, stored, same] at accepted

theorem two_committed_handoffs_allow_at_most_one_dispatch (ambient nextAmbient : Bool)
    (initial : HandoffState) (firstInput nextInput : HandoffIdentity) (first next : HandoffAdmission)
    (firstAccepted : commitInferenceHandoff ambient initial firstInput = some first)
    (nextAccepted : commitInferenceHandoff nextAmbient first.state nextInput = some next) :
    next.dispatch = false := by
  have stored := (accepted_handoff_preserves_resolution_and_exact_record ambient initial firstInput first firstAccepted).1
  exact committed_handoff_cannot_dispatch_again nextAmbient first.state firstInput nextInput next stored nextAccepted

theorem handoff_dispatch_is_reachable :
    commitInferenceHandoff false ⟨none, false⟩ ⟨"hash", "canonical payload"⟩ =
      some ⟨⟨some ⟨"hash", "canonical payload"⟩, false⟩, true⟩ := by decide

structure VisualClaimState where
  stored : Option HandoffIdentity
  resolved : Bool
  handedOff : Bool
  stageQuoted : Bool
  deriving Repr, DecidableEq

structure VisualClaimAdmission where
  state : VisualClaimState
  dispatch : Bool
  deriving Repr, DecidableEq

def commitVisualClaim (ambientTransaction : Bool) (state : VisualClaimState)
    (input : HandoffIdentity) (observedAt claimedAt commitAt expiresAt : Int) : Option VisualClaimAdmission :=
  if ambientTransaction ∨ claimedAt < observedAt ∨ expiresAt ≤ claimedAt then none else
    match state.stored with
    | some previous => if previous = input then some ⟨state, false⟩ else none
    | none =>
      if expiresAt ≤ commitAt ∨ state.resolved ∨ state.handedOff then some ⟨state, false⟩ else
        if commitAt < claimedAt ∨ state.stageQuoted then none else
          some ⟨{ state with stored := some input }, true⟩

theorem visual_claim_requires_independent_commit (state : VisualClaimState) (input : HandoffIdentity)
    (observedAt claimedAt commitAt expiresAt : Int) :
    commitVisualClaim true state input observedAt claimedAt commitAt expiresAt = none := by
  simp [commitVisualClaim]

theorem visual_dispatch_requires_original_deadline (ambient : Bool) (state : VisualClaimState)
    (input : HandoffIdentity) (observedAt claimedAt commitAt expiresAt : Int) (result : VisualClaimAdmission)
    (accepted : commitVisualClaim ambient state input observedAt claimedAt commitAt expiresAt = some result)
    (dispatch : result.dispatch = true) :
    ambient = false ∧ observedAt ≤ claimedAt ∧ claimedAt ≤ commitAt ∧ commitAt < expiresAt ∧
      state.resolved = false ∧ state.handedOff = false ∧ state.stageQuoted = false ∧
      result.state.stored = some input := by
  unfold commitVisualClaim at accepted
  split at accepted
  · simp_all
  · cases stored : state.stored with
    | some previous =>
      simp only [stored] at accepted
      split at accepted
      · simp only [Option.some.injEq] at accepted
        subst result
        contradiction
      · contradiction
    | none =>
      simp only [stored] at accepted
      split at accepted
      · simp only [Option.some.injEq] at accepted
        subst result
        contradiction
      · split at accepted
        · contradiction
        · simp only [Option.some.injEq] at accepted
          subst result
          simp_all

theorem committed_visual_claim_cannot_dispatch_again (ambient : Bool) (state : VisualClaimState)
    (previous input : HandoffIdentity) (observedAt claimedAt commitAt expiresAt : Int) (result : VisualClaimAdmission)
    (stored : state.stored = some previous)
    (accepted : commitVisualClaim ambient state input observedAt claimedAt commitAt expiresAt = some result) :
    result.dispatch = false := by
  unfold commitVisualClaim at accepted
  split at accepted
  · simp_all
  · simp only [stored] at accepted
    split at accepted
    · simp only [Option.some.injEq] at accepted
      subst result
      rfl
    · contradiction

theorem two_visual_claims_allow_at_most_one_dispatch (ambient nextAmbient : Bool)
    (initial : VisualClaimState) (firstInput nextInput : HandoffIdentity)
    (observedAt claimedAt commitAt nextClaimedAt nextCommitAt expiresAt : Int)
    (first next : VisualClaimAdmission)
    (firstAccepted : commitVisualClaim ambient initial firstInput observedAt claimedAt commitAt expiresAt = some first)
    (firstDispatch : first.dispatch = true)
    (nextAccepted : commitVisualClaim nextAmbient first.state nextInput observedAt nextClaimedAt nextCommitAt expiresAt = some next) :
    next.dispatch = false := by
  have stored := (visual_dispatch_requires_original_deadline ambient initial firstInput observedAt claimedAt
    commitAt expiresAt first firstAccepted firstDispatch).2.2.2.2.2.2.2
  exact committed_visual_claim_cannot_dispatch_again nextAmbient first.state firstInput nextInput observedAt
    nextClaimedAt nextCommitAt expiresAt next stored nextAccepted

theorem visual_dispatch_at_last_valid_instant_is_reachable :
    commitVisualClaim false ⟨none, false, false, false⟩ ⟨"hash", "payload"⟩ 10 10 19 20 =
      some ⟨⟨some ⟨"hash", "payload"⟩, false, false, false⟩, true⟩ := by decide

theorem visual_dispatch_at_expiry_is_denied :
    commitVisualClaim false ⟨none, false, false, false⟩ ⟨"hash", "payload"⟩ 10 10 20 20 =
      some ⟨⟨none, false, false, false⟩, false⟩ := by decide

inductive EntryProviderOutcome where
  | received | failed | notRequested | notDispatched | omittedByPolicy
  deriving Repr, DecidableEq

def entryCompletionAdmitted (ablation ready : Bool) (outcome : EntryProviderOutcome)
    (recordedAt completedAt expiresAt : Int) : Bool :=
  if completedAt < recordedAt then false else
    if !ready then decide (outcome = .notRequested) else
      if ablation then decide (outcome = .omittedByPolicy) else
        match outcome with
        | .received | .failed => true
        | .notDispatched => decide (expiresAt ≤ completedAt)
        | .notRequested | .omittedByPolicy => false

theorem candidate_cannot_omit_provider (ready : Bool) (recordedAt completedAt expiresAt : Int) :
    entryCompletionAdmitted false ready .omittedByPolicy recordedAt completedAt expiresAt = false := by
  cases ready <;> simp [entryCompletionAdmitted]

theorem ready_ablation_requires_omission (outcome : EntryProviderOutcome)
    (recordedAt completedAt expiresAt : Int)
    (accepted : entryCompletionAdmitted true true outcome recordedAt completedAt expiresAt = true) :
    outcome = .omittedByPolicy := by
  cases outcome <;> simp_all [entryCompletionAdmitted]

theorem unprepared_entry_cannot_dispatch (ablation : Bool) (outcome : EntryProviderOutcome)
    (recordedAt completedAt expiresAt : Int)
    (accepted : entryCompletionAdmitted ablation false outcome recordedAt completedAt expiresAt = true) :
    outcome = .notRequested := by
  cases outcome <;> simp_all [entryCompletionAdmitted]

theorem undispatched_candidate_requires_original_expiry (recordedAt completedAt expiresAt : Int)
    (accepted : entryCompletionAdmitted false true .notDispatched recordedAt completedAt expiresAt = true) :
    expiresAt ≤ completedAt := by
  simp_all [entryCompletionAdmitted]

theorem accepted_completion_follows_committed_handoff (ablation ready : Bool) (outcome : EntryProviderOutcome)
    (recordedAt completedAt expiresAt : Int)
    (accepted : entryCompletionAdmitted ablation ready outcome recordedAt completedAt expiresAt = true) :
    recordedAt ≤ completedAt := by
  by_cases h : completedAt < recordedAt
  · simp [entryCompletionAdmitted, h] at accepted
  · exact Int.le_of_not_gt h

theorem ablation_omission_is_reachable :
    entryCompletionAdmitted true true .omittedByPolicy 10 11 20 = true := by decide

end Bayn
