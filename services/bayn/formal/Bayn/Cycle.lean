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

structure EntryWindowScope where
  schemaVersion : String
  identitySchemaVersion : String
  strategy : String
  protocol : String
  qualification : String
  account : String
  executionPolicy : String
  calendarSchema : String
  calendarSource : String
  calendar : String
  session : String
  deriving Repr, DecidableEq

def stableEntryWindowScope (scope : EntryWindowScope) : EntryWindowScope :=
  if scope.calendarSchema = "bayn.continuous-market-hours.v1" ∧ scope.calendarSource = "alpaca-crypto-us" then
    { scope with calendar := "", session := "" }
  else scope

theorem equity_window_scope_preserves_its_exact_calendar (scope : EntryWindowScope) :
    stableEntryWindowScope { scope with calendarSchema := "bayn.alpaca-market-calendar-observation.v2" } =
      { scope with calendarSchema := "bayn.alpaca-market-calendar-observation.v2" } := by
  simp [stableEntryWindowScope]

theorem continuous_window_scope_ignores_only_the_rolling_lease (scope : EntryWindowScope)
    (calendar session : String)
    (continuous : scope.calendarSchema = "bayn.continuous-market-hours.v1")
    (source : scope.calendarSource = "alpaca-crypto-us") :
    stableEntryWindowScope { scope with calendar := calendar, session := session } = stableEntryWindowScope scope := by
  simp [stableEntryWindowScope, continuous, source]

def entryWindowScopeCompatible (entry : Bool) (targetCycle previousCycle : String)
    (target previous : EntryWindowScope) : Bool :=
  decide (targetCycle = previousCycle ∨ entry = true ∧ stableEntryWindowScope target = stableEntryWindowScope previous)

theorem sharing_entry_requires_the_same_policy_and_market_scope
    (entry : Bool) (targetCycle previousCycle : String) (target previous : EntryWindowScope)
    (different : targetCycle ≠ previousCycle)
    (shared : entryWindowScopeCompatible entry targetCycle previousCycle target previous = true) :
    entry = true ∧ stableEntryWindowScope target = stableEntryWindowScope previous := by
  simpa [entryWindowScopeCompatible, different] using shared

structure EntryWindowSource where
  cycle : String
  scope : EntryWindowScope
  jev : Bool
  entry : Bool
  windowEnd : Int
  deriving Repr, DecidableEq

def entryWindowSourceEligible (entry : Bool) (targetCycle : String) (target : EntryWindowScope)
    (source : EntryWindowSource) : Bool :=
  source.jev && (source.entry == entry) &&
    entryWindowScopeCompatible entry targetCycle source.cycle target source.scope

def latestCompatibleEntryWindow (entry : Bool) (targetCycle : String) (target : EntryWindowScope) :
    List EntryWindowSource → Option Int
  | [] => none
  | source :: rest =>
      let latest := latestCompatibleEntryWindow entry targetCycle target rest
      if entryWindowSourceEligible entry targetCycle target source then
        some (max source.windowEnd (latest.getD source.windowEnd))
      else latest

theorem ineligible_window_cannot_supply_a_source (entry : Bool) (targetCycle : String)
    (target : EntryWindowScope) (source : EntryWindowSource)
    (ineligible : entryWindowSourceEligible entry targetCycle target source = false) :
    latestCompatibleEntryWindow entry targetCycle target [source] = none := by
  simp [latestCompatibleEntryWindow, ineligible]

theorem latest_compatible_window_is_an_actual_eligible_source (entry : Bool) (targetCycle : String)
    (target : EntryWindowScope) (sources : List EntryWindowSource) (window : Int)
    (selected : latestCompatibleEntryWindow entry targetCycle target sources = some window) :
    ∃ source ∈ sources, entryWindowSourceEligible entry targetCycle target source = true ∧ source.windowEnd = window := by
  induction sources generalizing window with
  | nil => simp [latestCompatibleEntryWindow] at selected
  | cons source rest ih =>
    simp only [latestCompatibleEntryWindow] at selected
    split at selected
    · rename_i eligible
      generalize priorEq : latestCompatibleEntryWindow entry targetCycle target rest = prior at selected
      cases prior with
      | none =>
        simp at selected
        exact ⟨source, by simp, eligible, selected⟩
      | some priorWindow =>
        simp only [Option.getD_some, Option.some.injEq] at selected
        by_cases le : priorWindow ≤ source.windowEnd
        · have same : source.windowEnd = window := by simpa [Int.max_eq_left le] using selected
          exact ⟨source, by simp, eligible, same⟩
        · rcases ih priorWindow priorEq with ⟨earlier, member, allowed, same⟩
          have le' : source.windowEnd ≤ priorWindow := by omega
          have chosen : priorWindow = window := by simpa [Int.max_eq_right le'] using selected
          exact ⟨earlier, by simp [member], allowed, same.trans chosen⟩
    · rcases ih window selected with ⟨earlier, member, allowed, same⟩
      exact ⟨earlier, by simp [member], allowed, same⟩

def entryAttemptSuccessor (state : CycleState) (native recovered : Bool) (terminalAt : Option Int)
    (now cutoff : Int) (ordinal : Nat) : Option Nat :=
  match terminalAt with
  | none => none
  | some terminal =>
      if native = true ∧ (state = .completed ∨ state = .noTrade ∨ state = .blocked ∧ recovered = true) ∧
          terminal ≤ now ∧ now < cutoff ∧ ordinal < 2147483647 then some (ordinal + 1)
      else none

theorem entry_handoff_preserves_terminal_cutoff_and_counter_bounds (state : CycleState)
    (native recovered : Bool) (terminal now cutoff : Int) (ordinal next : Nat)
    (accepted : entryAttemptSuccessor state native recovered (some terminal) now cutoff ordinal = some next) :
    native = true ∧ (state = .completed ∨ state = .noTrade ∨ state = .blocked ∧ recovered = true) ∧
      terminal ≤ now ∧ now < cutoff ∧ ordinal < 2147483647 ∧ next = ordinal + 1 := by
  simp only [entryAttemptSuccessor] at accepted
  split at accepted
  · rename_i admitted
    cases accepted
    exact ⟨admitted.1, admitted.2.1, admitted.2.2.1, admitted.2.2.2.1, admitted.2.2.2.2, rfl⟩
  · contradiction

theorem missing_terminal_cannot_rearm (state : CycleState) (native recovered : Bool)
    (now cutoff : Int) (ordinal : Nat) :
    entryAttemptSuccessor state native recovered none now cutoff ordinal = none := rfl

example : entryAttemptSuccessor .noTrade true false (some 53000) 53001 600000 42 = some 43 := by decide

def unusedEntryExpiry (cycle : CycleEvidence) : Int :=
  min cycle.submissionCutoffAt (max cycle.createdAt cycle.submissionOpenAt + 60000)

def unusedEntryHandoffContinuation (expiredTerminal : Bool) (cycle : CycleEvidence) (now : Int) : Option Nat :=
  if expiredTerminal = true ∧ cycle.state = .blocked ∧ cycle.snapshotId = none ∧ cycle.decisionHash = none ∧
      unusedEntryExpiry cycle ≤ now ∧ now < cycle.submissionCutoffAt then some 1
  else none

theorem unused_entry_handoff_requires_an_ended_unbound_attempt (expiredTerminal : Bool)
    (cycle : CycleEvidence) (now : Int) (delay : Nat)
    (wake : unusedEntryHandoffContinuation expiredTerminal cycle now = some delay) :
    expiredTerminal = true ∧ cycle.state = .blocked ∧ cycle.snapshotId = none ∧ cycle.decisionHash = none ∧
      unusedEntryExpiry cycle ≤ now ∧ now < cycle.submissionCutoffAt ∧ delay = 1 := by
  unfold unusedEntryHandoffContinuation at wake
  split at wake
  · rename_i ended
    cases wake
    exact ⟨ended.1, ended.2.1, ended.2.2.1, ended.2.2.2.1, ended.2.2.2.2.1, ended.2.2.2.2.2, rfl⟩
  · contradiction

def expiredUnusedEntry (cycle : CycleEvidence) (now : Int) : Bool :=
  decide (cycle.snapshotId = none ∧ cycle.decisionHash = none ∧ unusedEntryExpiry cycle ≤ now)

def unboundEntryRetryAllowed (expiredWaiting : Bool) (cycle : CycleEvidence) (now : Int) : Prop :=
  expiredWaiting = true ∧ cycle.state = .active ∧ cycle.snapshotId = none ∧ cycle.decisionHash = none ∧
  max cycle.createdAt cycle.submissionOpenAt ≤ now ∧ now < unusedEntryExpiry cycle

instance (expiredWaiting : Bool) (cycle : CycleEvidence) (now : Int) :
    Decidable (unboundEntryRetryAllowed expiredWaiting cycle now) := inferInstanceAs (Decidable (_ ∧ _))

def expiredInferenceContinuation (expiredWaiting : Bool) (cycle : CycleEvidence) (now : Int) : Option Nat :=
  if unboundEntryRetryAllowed expiredWaiting cycle now then some 1 else none

theorem expired_inference_retry_requires_original_window (expiredWaiting : Bool) (cycle : CycleEvidence)
    (now : Int) (delay : Nat) (retry : expiredInferenceContinuation expiredWaiting cycle now = some delay) :
    unboundEntryRetryAllowed expiredWaiting cycle now := by
  unfold expiredInferenceContinuation at retry
  split at retry
  · assumption
  · contradiction

theorem expired_inference_cannot_retry_after_original_deadline (expiredWaiting : Bool) (cycle : CycleEvidence)
    (now : Int) (expired : unusedEntryExpiry cycle ≤ now) :
    expiredInferenceContinuation expiredWaiting cycle now = none := by
  have unavailable : ¬unboundEntryRetryAllowed expiredWaiting cycle now := by
    rintro ⟨_, _, _, _, _, before⟩
    omega
  simp [expiredInferenceContinuation, unavailable]

/-- `pending` covers a captured query for initial inputs or a later unconsumed input cut. -/
def pendingMarketInputsContinuation (pending : Bool) (cycle : CycleEvidence) (now : Int)
    (normalDelay : Nat) : Option Nat :=
  if unboundEntryRetryAllowed pending cycle now then
    some (min (min 1000 normalDelay) (unusedEntryExpiry cycle - now).toNat)
  else none

theorem pending_inputs_retry_retains_original_admission (pending : Bool) (cycle : CycleEvidence)
    (now : Int) (normalDelay delay : Nat)
    (retry : pendingMarketInputsContinuation pending cycle now normalDelay = some delay) :
    unboundEntryRetryAllowed pending cycle now ∧ delay ≤ 1000 ∧ delay ≤ normalDelay ∧
      delay ≤ (unusedEntryExpiry cycle - now).toNat := by
  unfold pendingMarketInputsContinuation at retry
  split at retry
  · rename_i admitted
    cases retry
    exact ⟨admitted, Nat.le_trans (Nat.min_le_left _ _) (Nat.min_le_left _ _),
      Nat.le_trans (Nat.min_le_left _ _) (Nat.min_le_right _ _), Nat.min_le_right _ _⟩
  · contradiction

theorem pending_inputs_cannot_retry_after_original_deadline (pending : Bool) (cycle : CycleEvidence)
    (now : Int) (normalDelay : Nat) (expired : unusedEntryExpiry cycle ≤ now) :
    pendingMarketInputsContinuation pending cycle now normalDelay = none := by
  have unavailable : ¬unboundEntryRetryAllowed pending cycle now := by
    rintro ⟨_, _, _, _, _, before⟩
    omega
  simp [pendingMarketInputsContinuation, unavailable]

theorem pending_inputs_wake_is_within_original_deadline (pending : Bool) (cycle : CycleEvidence)
    (now : Int) (normalDelay delay : Nat)
    (retry : pendingMarketInputsContinuation pending cycle now normalDelay = some delay) :
    now + delay ≤ unusedEntryExpiry cycle := by
  obtain ⟨admitted, _, _, remaining⟩ :=
    pending_inputs_retry_retains_original_admission pending cycle now normalDelay delay retry
  rcases admitted with ⟨_, _, _, _, _, before⟩
  omega

/-- Reuse is a read optimization for a flat, unbound source wait, never submit authority. -/
def sourceWaitReconciliationReusable
    (exact accounting sameGeneration sameVersion flat clearMutations clearOrders : Bool)
    (oldest newest now maximumAge : Int) : Bool :=
  decide (exact = true ∧ accounting = true ∧ sameGeneration = true ∧ sameVersion = true ∧
    flat = true ∧ clearMutations = true ∧ clearOrders = true ∧ newest ≤ now ∧ now < oldest + maximumAge)

theorem source_wait_reuse_preserves_authority_and_original_freshness
    (exact accounting sameGeneration sameVersion flat clearMutations clearOrders : Bool)
    (oldest newest now maximumAge : Int)
    (reused : sourceWaitReconciliationReusable exact accounting sameGeneration sameVersion flat clearMutations
      clearOrders oldest newest now maximumAge = true) :
    exact = true ∧ accounting = true ∧ sameGeneration = true ∧ sameVersion = true ∧
      flat = true ∧ clearMutations = true ∧ clearOrders = true ∧ newest ≤ now ∧ now < oldest + maximumAge := by
  simpa [sourceWaitReconciliationReusable] using reused

theorem source_wait_cannot_reuse_at_original_freshness_boundary
    (exact accounting sameGeneration sameVersion flat clearMutations clearOrders : Bool)
    (oldest newest now maximumAge : Int) (expired : oldest + maximumAge ≤ now) :
    sourceWaitReconciliationReusable exact accounting sameGeneration sameVersion flat clearMutations
      clearOrders oldest newest now maximumAge = false := by
  simp [sourceWaitReconciliationReusable, show ¬now < oldest + maximumAge by omega]

example : sourceWaitReconciliationReusable true true true true true true true 0 0 1000 30000 = true := by decide
example : sourceWaitReconciliationReusable true true true true true true true 0 0 30000 30000 = false := by decide

def sourceWindowContinuation (known : Bool) (cycle : CycleEvidence) (now availableAt : Int)
    (normalDelay : Nat) : Option Nat :=
  if unboundEntryRetryAllowed known cycle now ∧ now < availableAt ∧
      availableAt < unusedEntryExpiry cycle ∧ availableAt - now < normalDelay then
    some (availableAt - now).toNat
  else none

theorem source_window_wake_preserves_original_admission (known : Bool) (cycle : CycleEvidence)
    (now availableAt : Int) (normalDelay delay : Nat)
    (wake : sourceWindowContinuation known cycle now availableAt normalDelay = some delay) :
    unboundEntryRetryAllowed known cycle now ∧ now + delay = availableAt ∧
      availableAt < unusedEntryExpiry cycle ∧ delay < normalDelay := by
  unfold sourceWindowContinuation at wake
  split at wake
  · rename_i allowed
    rcases allowed with ⟨admitted, future, before, shorter⟩
    cases wake
    have exactDelay := Int.toNat_of_nonneg (show 0 ≤ availableAt - now by omega)
    exact ⟨admitted, by omega, before, by omega⟩
  · contradiction

theorem source_window_cannot_wake_at_original_expiry (known : Bool) (cycle : CycleEvidence)
    (now availableAt : Int) (normalDelay : Nat) (late : unusedEntryExpiry cycle ≤ availableAt) :
    sourceWindowContinuation known cycle now availableAt normalDelay = none := by
  unfold sourceWindowContinuation
  split
  · rename_i allowed
    rcases allowed with ⟨_, _, before, _⟩
    omega
  · rfl

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

theorem expired_inference_retry_is_reachable :
    expiredInferenceContinuation true reachableCycle 12548 = some 1 ∧
    expiredInferenceContinuation true reachableCycle 60000 = none := by decide

theorem pending_inputs_retry_is_reachable :
    pendingMarketInputsContinuation true reachableCycle 37171 30000 = some 1000 ∧
    pendingMarketInputsContinuation true reachableCycle 59900 30000 = some 100 ∧
    pendingMarketInputsContinuation true reachableCycle 60000 30000 = none ∧
    pendingMarketInputsContinuation false reachableCycle 37171 30000 = none := by decide

theorem source_window_wake_is_reachable :
    sourceWindowContinuation true reachableCycle 33864 38335 30000 = some 4471 ∧
    sourceWindowContinuation true reachableCycle 33864 60000 30000 = none ∧
    sourceWindowContinuation false reachableCycle 33864 38335 30000 = none ∧
    33864 + 30000 > unusedEntryExpiry reachableCycle := by decide

def reachableCycleDecision : CycleDecisionEvidence :=
  ⟨reachableCycle.identity, "decision", true, ⟨"snapshot", "content", 1⟩,
    some ⟨"snapshot", "content", 1⟩, none, 1, 100000⟩

theorem cycle_binding_has_reachable_success :
    cycleDecisionBinding reachableCycle reachableCycleDecision 2 0 false = "Persist" := by decide

theorem cycle_completion_has_reachable_success :
    cycleCompletion { reachableCycle with decisionHash := some "decision" } true 2 = "VerifyDecision" ∧
    cycleCompletionDocumentPass true "decision" [⟨"decision", true, false, true, false, true⟩] = true := by decide

end Bayn
