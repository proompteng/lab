module
public import Bayn.Economics
import Lean.Elab.Tactic.Omega

@[expose] public section

namespace Bayn

-- day is the already-normalized New York session date encoded as YYYYMMDD.
def datedEquityTafRate (retained : Bool) (day rate : Nat) : Option Nat :=
  if retained then some rate
  else if day < 20260701 ∨ 20290101 ≤ day then none
  else some (if 20261001 ≤ day ∧ day < 20270101 then 0 else rate)

theorem retained_fee_rate_is_unchanged (day rate : Nat) :
    datedEquityTafRate true day rate = some rate := by simp [datedEquityTafRate]

theorem documented_taf_pause_is_zero (day rate : Nat) (opening : 20261001 ≤ day) (closing : day < 20270101) :
    datedEquityTafRate false day rate = some 0 := by
  simp [datedEquityTafRate, show ¬ (day < 20260701 ∨ 20290101 ≤ day) by omega, opening, closing]

theorem unsupported_future_fee_is_unknown (day rate : Nat) (future : 20290101 ≤ day) :
    datedEquityTafRate false day rate = none := by simp [datedEquityTafRate, future]

def quantizeDown (value increment : Nat) : Nat := value / increment * increment
def ceilingDivide (value divisor : Nat) : Nat := if value = 0 then 0 else (value - 1) / divisor + 1
def desiredQuantity (equity weight price increment : Nat) : Nat :=
  quantizeDown (equity * weight * 1000000000 / (1000000000000 * price)) increment

theorem quantized_quantity_does_not_exceed_raw (value increment : Nat) :
    quantizeDown value increment ≤ value := by
  exact Nat.div_mul_le_self value increment

theorem quantity_respects_registered_step (value increment : Nat) : increment ∣ quantizeDown value increment := by
  exact ⟨value / increment, Nat.mul_comm _ _⟩

theorem funded_size_obeys_both_limits (allocated funded : Nat) :
    min allocated funded ≤ allocated ∧ min allocated funded ≤ funded := by omega

theorem desired_quantity_cannot_round_up (equity weight price increment : Nat) :
    desiredQuantity equity weight price increment ≤ equity * weight * 1000000000 / (1000000000000 * price) := by
  exact quantized_quantity_does_not_exceed_raw _ _

def limitTimeInForce (equity : Bool) : String := if equity then "DAY" else "IOC"

theorem crypto_limit_expires_instead_of_resting : limitTimeInForce false = "IOC" := rfl

def roundedUnits (amount quantum : Nat) : Nat := ((amount + quantum / 2) / quantum) * quantum

def reportedCash (amount : Int) (quantum : Nat) : Int :=
  if amount < 0 then -(roundedUnits amount.natAbs quantum : Int) else roundedUnits amount.natAbs quantum

theorem rounded_cash_is_quantized (amount quantum : Nat) : quantum ∣ roundedUnits amount quantum := by
  exact ⟨(amount + quantum / 2) / quantum, Nat.mul_comm _ _⟩

theorem rounding_adjustment_conserves_cash (amount : Int) (quantum : Nat) :
    amount + (reportedCash amount quantum - amount) = reportedCash amount quantum := by omega

structure Controller where
  active : Bool
  epoch : Nat
  sequence : Nat
  source : String
  deriving Repr, DecidableEq

def controllerTick (state : Option Controller) (epoch sequence : Nat) (source : String) : String :=
  match state with
  | none => "Inactive"
  | some s =>
    if !s.active then "Inactive"
    else if epoch ≠ s.epoch then "StaleEpoch"
    else if sequence ≠ s.sequence then "StaleSequence"
    else if source ≠ s.source then "conflict"
    else if s.sequence = 9007199254740991 then "counter-exhausted"
    else "Advance"

theorem inactive_controller_never_advances (s : Controller) (epoch sequence : Nat) (source : String)
    (h : s.active = false) : controllerTick (some s) epoch sequence source ≠ "Advance" := by
  simp [controllerTick, h]

theorem stale_controller_epoch_never_advances (s : Controller) (epoch sequence : Nat) (source : String)
    (h : epoch ≠ s.epoch) : controllerTick (some s) epoch sequence source ≠ "Advance" := by
  simp [controllerTick, h]; split <;> decide

theorem foreign_worker_never_advances (s : Controller) (epoch sequence : Nat) (source : String)
    (h : source ≠ s.source) : controllerTick (some s) epoch sequence source ≠ "Advance" := by
  unfold controllerTick
  by_cases active : s.active = true <;>
    by_cases epochMatches : epoch = s.epoch <;>
    by_cases sequenceMatches : sequence = s.sequence <;>
    simp [active, epochMatches, sequenceMatches, h]

structure AuthorityBinding where
  account : String
  strategy : String
  generation : String
  deriving Repr, DecidableEq

def boundAuthority (expected observed : AuthorityBinding) : String :=
  if observed.account ≠ expected.account then "IntentAccountMismatch"
  else if observed.strategy ≠ expected.strategy then "IntentStrategyMismatch"
  else if observed.generation ≠ expected.generation then "IntentAuthorityGenerationMismatch"
  else "PASS"

theorem authority_binding_pass_is_exact (expected observed : AuthorityBinding)
    (h : boundAuthority expected observed = "PASS") : observed = expected := by
  cases expected; cases observed
  simp only [boundAuthority] at h
  split at h <;> simp_all
  split at h <;> simp_all

def causalInput (availableAt decisionAt : Int) : Bool := decide (availableAt ≤ decisionAt)

theorem later_arrival_is_not_available (availableAt decisionAt : Int) (h : decisionAt < availableAt) :
    causalInput availableAt decisionAt = false := by simp [causalInput]; omega

inductive ExecutionPricingBasis where
  | spotQuote (source : String) (availableAt freshUntil : Int)
  | nativeProtection (source : String) (availableAt : Int)
  | reconciledLiquidation (source : String) (availableAt : Int)
  deriving Repr

def executionPricingSource : ExecutionPricingBasis → String
  | .spotQuote source .. | .nativeProtection source .. | .reconciledLiquidation source .. => source

def supportedExecutionPricing (basis : ExecutionPricingBasis) (kind side : String)
    (verifiedSources : List String) (dispatchedAt : Int) : Prop :=
  executionPricingSource basis ∈ verifiedSources ∧
  match basis with
  | .spotQuote _ availableAt freshUntil => availableAt ≤ dispatchedAt ∧ dispatchedAt ≤ freshUntil
  | .nativeProtection _ availableAt | .reconciledLiquidation _ availableAt =>
    availableAt ≤ dispatchedAt ∧ kind = "BROKER_RECEIPT" ∧ side = "SELL"

instance (basis : ExecutionPricingBasis) (kind side : String) (sources : List String) (dispatched : Int) :
    Decidable (supportedExecutionPricing basis kind side sources dispatched) := by
  cases basis <;> unfold supportedExecutionPricing <;> infer_instance

structure ExecutionTiming where
  decisionAt : Int
  persistedAt : Int
  routingStartedAt : Int
  requestDispatchedAt : Int
  pricing : ExecutionPricingBasis
  evidenceKind : String
  side : String
  verifiedSources : List String
  submissionDeadlineAt : Int
  filledAt : Int
  expiresAt : Int
  deriving Repr

def supportedExecutionTiming (t : ExecutionTiming) : Prop :=
  t.decisionAt ≤ t.persistedAt ∧ t.persistedAt ≤ t.routingStartedAt ∧
  t.routingStartedAt ≤ t.requestDispatchedAt ∧
  supportedExecutionPricing t.pricing t.evidenceKind t.side t.verifiedSources t.requestDispatchedAt ∧
  t.requestDispatchedAt < t.submissionDeadlineAt ∧
  t.requestDispatchedAt ≤ t.filledAt ∧ t.filledAt ≤ t.expiresAt

instance (t : ExecutionTiming) : Decidable (supportedExecutionTiming t) := inferInstanceAs (Decidable (_ ∧ _))

theorem supported_routing_follows_durable_decision (t : ExecutionTiming) (h : supportedExecutionTiming t) :
    t.persistedAt ≤ t.requestDispatchedAt := by unfold supportedExecutionTiming at h; omega

theorem waiting_in_guard_cannot_hide_stale_quote (t : ExecutionTiming) (source : String) (available fresh : Int)
    (basis : t.pricing = .spotQuote source available fresh)
    (h : fresh < t.requestDispatchedAt) : ¬ supportedExecutionTiming t := by
  simp [supportedExecutionTiming, supportedExecutionPricing, basis]
  omega

theorem unverified_pricing_cannot_establish_support (t : ExecutionTiming)
    (missing : executionPricingSource t.pricing ∉ t.verifiedSources) : ¬ supportedExecutionTiming t := by
  intro h
  exact missing h.2.2.2.1.1

theorem conditional_protection_requires_actual_sell (source kind side : String) (available dispatched : Int)
    (sources : List String)
    (h : supportedExecutionPricing (.nativeProtection source available) kind side sources dispatched) :
    kind = "BROKER_RECEIPT" ∧ side = "SELL" := h.2.2

theorem reconciled_liquidation_requires_actual_sell (source kind side : String) (available dispatched : Int)
    (sources : List String)
    (h : supportedExecutionPricing (.reconciledLiquidation source available) kind side sources dispatched) :
    kind = "BROKER_RECEIPT" ∧ side = "SELL" := h.2.2

theorem expired_admission_cannot_route (t : ExecutionTiming)
    (h : t.submissionDeadlineAt ≤ t.requestDispatchedAt) : ¬ supportedExecutionTiming t := by
  unfold supportedExecutionTiming; omega

theorem execution_timing_has_reachable_success : supportedExecutionTiming
    ⟨0, 1, 2, 3, .spotQuote "quote" 0 4, "BROKER_RECEIPT", "BUY", ["quote"], 5, 4, 10⟩ := by decide

theorem conditional_protection_has_reachable_success : supportedExecutionTiming
    ⟨0, 1, 2, 3, .nativeProtection "approval" 0, "BROKER_RECEIPT", "SELL", ["approval"], 5, 8, 10⟩ := by decide

end Bayn
