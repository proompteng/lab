module
import Lean.Elab.Tactic.Omega

@[expose] public section

namespace Bayn

structure ProtectionOwner where
  account : String
  cycle : String
  decision : String
  policy : String
  strategy : String
  generation : String
  entry : String
  symbol : String
  deriving Repr, DecidableEq

structure ProtectionEntry where
  owner : ProtectionOwner
  dispatchable : Bool
  maximumQuantity : Int
  stop : Int
  stopLimit : Int
  profit : Int
  createdAt : Int
  maximumBrokerAge : Int
  maximumRiskTtl : Int
  deriving Repr

structure ProtectionIntentEvidence where
  owner : ProtectionOwner
  sourceHash : String
  expectedSourceHash : String
  intent : String
  expectedIntent : String
  client : String
  expectedClient : String
  riskId : String
  expectedRiskId : String
  riskIntent : String
  riskPolicy : String
  riskOutcome : String
  reconciliationId : String
  expectedReconciliationId : String
  reconciliationHash : String
  expectedReconciliationHash : String
  reconciliationAccount : String
  reconciliationStatus : String
  replan : String
  expectedReplan : String
  side : String
  kind : String
  orderType : String
  timeInForce : String
  quantity : Int
  limitPrice : Int
  stop : Int
  stopLimit : Int
  profit : Int
  createdAt : Int
  decidedAt : Int
  expiresAt : Int
  reconciledAt : Int
  deriving Repr

def protectionIdentityAgrees (entry : ProtectionEntry) (e : ProtectionIntentEvidence) : Prop :=
  e.owner = entry.owner ∧ entry.dispatchable = true ∧
  e.sourceHash = e.expectedSourceHash ∧ e.intent = e.expectedIntent ∧ e.client = e.expectedClient ∧
  e.riskId = e.expectedRiskId ∧ e.riskIntent = e.intent ∧ e.riskPolicy = e.owner.policy ∧
  e.riskOutcome = "APPROVED" ∧ e.reconciliationId = e.expectedReconciliationId ∧
  e.reconciliationHash = e.expectedReconciliationHash ∧ e.reconciliationAccount = e.owner.account ∧
  e.reconciliationStatus = "EXACT" ∧ e.replan = e.expectedReplan

def protectionClockAdmissible (entry : ProtectionEntry) (e : ProtectionIntentEvidence) : Prop :=
  entry.createdAt ≤ e.createdAt ∧ e.createdAt ≤ e.decidedAt ∧ e.decidedAt < e.expiresAt ∧
  e.reconciledAt ≤ e.createdAt ∧ e.decidedAt - e.reconciledAt < entry.maximumBrokerAge ∧
  e.expiresAt - e.decidedAt ≤ entry.maximumRiskTtl

def protectionTermsAdmissible (entry : ProtectionEntry) (e : ProtectionIntentEvidence) : Prop :=
  e.side = "SELL" ∧ 0 < e.quantity ∧ e.quantity ≤ entry.maximumQuantity ∧ e.stop = entry.stop ∧
  if e.kind = "Oco" then
    e.orderType = "LIMIT" ∧ e.timeInForce = "DAY" ∧ e.quantity % 1000000000 = 0 ∧
    entry.owner.symbol.toList.contains '/' = false ∧ e.limitPrice = entry.profit ∧
    e.stopLimit = entry.stopLimit ∧ e.profit = entry.profit
  else
    e.kind = "StopLimit" ∧ e.orderType = "STOP_LIMIT" ∧
    e.timeInForce = (if entry.owner.symbol.toList.contains '/' then "GTC" else "DAY") ∧
    e.limitPrice = entry.stopLimit

def supportedProtectionIntent (entry : ProtectionEntry) (e : ProtectionIntentEvidence) : Prop :=
  protectionIdentityAgrees entry e ∧ protectionClockAdmissible entry e ∧ protectionTermsAdmissible entry e

instance (entry : ProtectionEntry) (e : ProtectionIntentEvidence) : Decidable (supportedProtectionIntent entry e) := by
  unfold supportedProtectionIntent protectionIdentityAgrees protectionClockAdmissible protectionTermsAdmissible
  infer_instance

theorem admitted_protection_preserves_exact_owner (entry : ProtectionEntry) (e : ProtectionIntentEvidence)
    (h : supportedProtectionIntent entry e) : e.owner = entry.owner := h.1.1

theorem admitted_protection_requires_approved_risk (entry : ProtectionEntry) (e : ProtectionIntentEvidence)
    (h : supportedProtectionIntent entry e) : e.riskOutcome = "APPROVED" := h.1.2.2.2.2.2.2.2.2.1

theorem admitted_protection_is_bounded_by_entry (entry : ProtectionEntry) (e : ProtectionIntentEvidence)
    (h : supportedProtectionIntent entry e) : 0 < e.quantity ∧ e.quantity ≤ entry.maximumQuantity :=
  ⟨h.2.2.2.1, h.2.2.2.2.1⟩

theorem admitted_protection_preserves_sealed_stop (entry : ProtectionEntry) (e : ProtectionIntentEvidence)
    (h : supportedProtectionIntent entry e) : e.stop = entry.stop := h.2.2.2.2.2.1

theorem admitted_protection_has_fresh_reconciliation (entry : ProtectionEntry) (e : ProtectionIntentEvidence)
    (h : supportedProtectionIntent entry e) :
    e.reconciledAt ≤ e.decidedAt ∧ e.decidedAt - e.reconciledAt < entry.maximumBrokerAge := by
  rcases h.2.1 with ⟨_, created, _, reconciled, fresh, _⟩
  constructor
  · omega
  · exact fresh

theorem admitted_protection_has_original_bounded_approval (entry : ProtectionEntry) (e : ProtectionIntentEvidence)
    (h : supportedProtectionIntent entry e) :
    e.createdAt ≤ e.decidedAt ∧ e.decidedAt < e.expiresAt ∧
    e.expiresAt - e.decidedAt ≤ entry.maximumRiskTtl := by
  unfold supportedProtectionIntent protectionClockAdmissible at h
  omega

theorem admitted_oco_preserves_sealed_exit_prices (entry : ProtectionEntry) (e : ProtectionIntentEvidence)
    (h : supportedProtectionIntent entry e) (kind : e.kind = "Oco") :
    e.limitPrice = entry.profit ∧ e.stopLimit = entry.stopLimit ∧ e.profit = entry.profit := by
  have terms := h.2.2
  simp only [protectionTermsAdmissible, kind, ite_true] at terms
  exact terms.2.2.2.2.2.2.2.2

theorem admitted_crypto_stop_retains_gtc (entry : ProtectionEntry) (e : ProtectionIntentEvidence)
    (h : supportedProtectionIntent entry e) (kind : e.kind ≠ "Oco")
    (crypto : entry.owner.symbol.toList.contains '/' = true) : e.timeInForce = "GTC" := by
  have terms := h.2.2
  simp only [protectionTermsAdmissible, kind, ite_false, crypto, ite_true] at terms
  exact terms.2.2.2.2.2.2.1

def reachableProtectionEntry : ProtectionEntry :=
  ⟨⟨"account", "cycle", "decision", "policy", "jev", "generation", "entry", "AAPL"⟩,
    true, 2000000000, 90, 89, 110, 0, 1000, 5000⟩

def reachableProtectionIntent : ProtectionIntentEvidence := {
  owner := reachableProtectionEntry.owner,
  sourceHash := "source", expectedSourceHash := "source", intent := "intent", expectedIntent := "intent",
  client := "client", expectedClient := "client", riskId := "risk", expectedRiskId := "risk",
  riskIntent := "intent", riskPolicy := "policy", riskOutcome := "APPROVED",
  reconciliationId := "reconciliation", expectedReconciliationId := "reconciliation",
  reconciliationHash := "reconciled", expectedReconciliationHash := "reconciled",
  reconciliationAccount := "account", reconciliationStatus := "EXACT", replan := "replan", expectedReplan := "replan",
  side := "SELL", kind := "Oco", orderType := "LIMIT", timeInForce := "DAY", quantity := 2000000000,
  limitPrice := 110, stop := 90, stopLimit := 89, profit := 110,
  createdAt := 1, decidedAt := 2, expiresAt := 10, reconciledAt := 0
}

theorem independent_oco_has_reachable_success :
    supportedProtectionIntent reachableProtectionEntry reachableProtectionIntent := by decide

theorem fractional_crypto_stop_has_reachable_success :
    let owner := { reachableProtectionEntry.owner with symbol := "BTC/USD" }
    supportedProtectionIntent { reachableProtectionEntry with owner := owner }
      { reachableProtectionIntent with
        owner := owner
        kind := "StopLimit"
        orderType := "STOP_LIMIT"
        timeInForce := "GTC"
        quantity := 123456789
        limitPrice := 89 } := by decide

end Bayn
