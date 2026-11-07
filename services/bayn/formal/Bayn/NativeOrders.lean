module
import Lean.Elab.Tactic.Omega

@[expose] public section

namespace Bayn

structure NativeOrderOwner where
  intent : String
  decision : String
  generation : String
  account : String
  symbol : String
  deriving Repr, BEq, DecidableEq

structure NativeOrderReceipt where
  owner : NativeOrderOwner
  orderIntent : Option String
  brokerId : String
  clientId : String
  parentId : Option String
  side : String
  orderType : String
  timeInForce : String
  quantity : Option Int
  notional : Option Int
  limitPrice : Option Int
  stopPrice : Option Int
  deriving Repr, BEq, DecidableEq

inductive NativeProtectionTerms where
  | none
  | stopLimit (stop : Int)
  | bracket (stop stopLimit profit : Int)
  | oco (stop stopLimit profit : Int)
  deriving Repr, BEq, DecidableEq

structure NativeOrderTarget where
  owner : NativeOrderOwner
  side : String
  orderType : String
  timeInForce : String
  quantity : Int
  limitPrice : Int
  protection : NativeProtectionTerms
  deriving Repr, BEq, DecidableEq

inductive NativeOrderBinding where
  | invalid
  | missing
  | bound (quantity limitPrice : Int) (protection : String)
  deriving Repr, BEq, DecidableEq

def nativeOwnerAgrees (target : NativeOrderTarget) (row : NativeOrderReceipt) : Bool :=
  decide (row.owner = target.owner) && row.orderIntent == some target.owner.intent

def nativeParentAgrees (target : NativeOrderTarget) (root : NativeOrderReceipt) : Bool :=
  root.parentId == none && root.side == target.side && root.orderType == target.orderType &&
  root.timeInForce == target.timeInForce && root.quantity == some target.quantity &&
  root.notional == none && root.limitPrice == some target.limitPrice

def nativeExitPricesAgree (stop profit : NativeOrderReceipt) (trigger limit target : Int) : Bool :=
  stop.stopPrice == some trigger && stop.limitPrice == some limit &&
  profit.limitPrice == some target && profit.stopPrice == none

def nativeProtectionLegAdmissible (maximum : Int) (row : NativeOrderReceipt) : Bool :=
  row.side == "SELL" && row.timeInForce == "DAY" && row.notional == none &&
  decide (0 < row.quantity.getD 0) && decide (row.quantity.getD 0 ≤ maximum)

def nativeOrderIdsUnique (rows : List NativeOrderReceipt) : Bool :=
  (rows.map (·.brokerId)).eraseDups.length == rows.length &&
  (rows.map (·.clientId)).eraseDups.length == rows.length

def nativeProtectionGroupAdmissible (root : NativeOrderReceipt) (children : List NativeOrderReceipt)
    (target : NativeOrderTarget) (stop profit : NativeOrderReceipt) (bracket : Bool)
    (trigger limit profitPrice : Int) : Bool :=
  children.length == (if bracket then 2 else 1) && decide (0 < target.quantity) &&
  target.quantity % 1000000000 == 0 && root.side == (if bracket then "BUY" else "SELL") &&
  root.orderType == "LIMIT" && root.timeInForce == "DAY" && root.stopPrice == none &&
  nativeOrderIdsUnique (root :: children) && children.all (·.parentId == some root.brokerId) &&
  nativeProtectionLegAdmissible target.quantity stop && nativeProtectionLegAdmissible target.quantity profit &&
  nativeExitPricesAgree stop profit trigger limit profitPrice

def bindNativeProtectionOrder (id : String) (root : NativeOrderReceipt)
    (children : List NativeOrderReceipt) (target : NativeOrderTarget) (order : NativeOrderReceipt) : NativeOrderBinding :=
  let isRoot := id == root.brokerId
  match target.protection with
  | .none | .stopLimit _ =>
    let expectedStop := match target.protection with | .stopLimit stop => some stop | _ => none
    if children.isEmpty && isRoot && root.stopPrice == expectedStop
      then .bound target.quantity target.limitPrice "NONE" else .invalid
  | .bracket trigger limit profitPrice | .oco trigger limit profitPrice =>
    let bracket := match target.protection with | .bracket .. => true | _ => false
    let expected := if bracket then 2 else 1
    if children.length < expected then .missing else
      match children.find? (·.orderType == "STOP_LIMIT"),
          (if bracket then children.find? (·.orderType == "LIMIT") else some root) with
      | some stop, some profit =>
        if nativeProtectionGroupAdmissible root children target stop profit bracket trigger limit profitPrice then
          let kind := if bracket then "Bracket" else "Oco"
          if isRoot then .bound target.quantity target.limitPrice kind else
            if order.brokerId == stop.brokerId || order.brokerId == profit.brokerId then
              match order.quantity, order.limitPrice with
              | some quantity, some price => .bound quantity price kind
              | _, _ => .invalid
            else .invalid
        else .invalid
      | _, _ => .invalid

def resolveNativeOrderGroup (id : String) (root : NativeOrderReceipt)
    (children : List NativeOrderReceipt) (target : NativeOrderTarget) : NativeOrderBinding :=
  let selected := if root.brokerId == id then some root else children.find? (·.brokerId == id)
  match selected with
  | none => .invalid
  | some order =>
    if (root :: children).all (nativeOwnerAgrees target) && nativeParentAgrees target root &&
        (id == root.brokerId || order.parentId == some root.brokerId)
      then bindNativeProtectionOrder id root children target order else .invalid

theorem admitted_native_parent_preserves_quantity_and_limit (target : NativeOrderTarget) (root : NativeOrderReceipt)
    (h : nativeParentAgrees target root = true) :
    root.quantity = some target.quantity ∧ root.limitPrice = some target.limitPrice := by
  simp_all [nativeParentAgrees]

theorem admitted_native_exits_preserve_both_sealed_prices (stop profit : NativeOrderReceipt)
    (trigger limit target : Int) (h : nativeExitPricesAgree stop profit trigger limit target = true) :
    stop.stopPrice = some trigger ∧ stop.limitPrice = some limit ∧ profit.limitPrice = some target := by
  simp_all [nativeExitPricesAgree]

theorem admitted_native_leg_cannot_exceed_parent (maximum : Int) (leg : NativeOrderReceipt)
    (h : nativeProtectionLegAdmissible maximum leg = true) :
    0 < leg.quantity.getD 0 ∧ leg.quantity.getD 0 ≤ maximum := by
  simp_all [nativeProtectionLegAdmissible]

theorem admitted_native_owner_is_exact (target : NativeOrderTarget) (row : NativeOrderReceipt)
    (h : nativeOwnerAgrees target row = true) :
    row.owner = target.owner ∧ row.orderIntent = some target.owner.intent := by
  simpa [nativeOwnerAgrees] using h

theorem resolved_native_order_requires_sealed_parent (id : String) (root : NativeOrderReceipt)
    (children : List NativeOrderReceipt) (target : NativeOrderTarget) (quantity price : Int) (kind : String)
    (h : resolveNativeOrderGroup id root children target = .bound quantity price kind) :
    nativeParentAgrees target root = true := by
  cases selected : (if root.brokerId == id then some root else children.find? (·.brokerId == id)) with
  | none => simp only [resolveNativeOrderGroup, selected] at h; contradiction
  | some order =>
    simp only [resolveNativeOrderGroup, selected] at h
    split at h
    next admission =>
      simp only [Bool.and_eq_true] at admission
      exact admission.1.2
    next => contradiction

theorem resolved_native_order_requires_every_owner (id : String) (root : NativeOrderReceipt)
    (children : List NativeOrderReceipt) (target : NativeOrderTarget) (quantity price : Int) (kind : String)
    (h : resolveNativeOrderGroup id root children target = .bound quantity price kind) :
    ∀ row ∈ root :: children, nativeOwnerAgrees target row = true := by
  cases selected : (if root.brokerId == id then some root else children.find? (·.brokerId == id)) with
  | none => simp only [resolveNativeOrderGroup, selected] at h; contradiction
  | some order =>
    simp only [resolveNativeOrderGroup, selected] at h
    split at h
    next admission =>
      simp only [Bool.and_eq_true] at admission
      simpa only [List.all_eq_true] using admission.1.1
    next => contradiction

theorem incomplete_bracket_cannot_bind (id : String) (root order : NativeOrderReceipt)
    (children : List NativeOrderReceipt) (target : NativeOrderTarget) (trigger limit profit : Int)
    (kind : target.protection = .bracket trigger limit profit) (short : children.length < 2) :
    bindNativeProtectionOrder id root children target order = .missing := by
  simp [bindNativeProtectionOrder, kind, short]

theorem admitted_native_group_preserves_exit_prices (root stop profit : NativeOrderReceipt)
    (children : List NativeOrderReceipt) (target : NativeOrderTarget) (bracket : Bool) (trigger limit price : Int)
    (h : nativeProtectionGroupAdmissible root children target stop profit bracket trigger limit price = true) :
    nativeExitPricesAgree stop profit trigger limit price = true := by
  simp only [nativeProtectionGroupAdmissible, Bool.and_eq_true] at h
  exact h.2

theorem bound_bracket_requires_admitted_group (id : String) (root order : NativeOrderReceipt)
    (children : List NativeOrderReceipt) (target : NativeOrderTarget) (trigger limit price quantity boundPrice : Int)
    (kind : String) (protection : target.protection = .bracket trigger limit price)
    (h : bindNativeProtectionOrder id root children target order = .bound quantity boundPrice kind) :
    ∃ stop profit, children.find? (·.orderType == "STOP_LIMIT") = some stop ∧
      children.find? (·.orderType == "LIMIT") = some profit ∧
      nativeProtectionGroupAdmissible root children target stop profit true trigger limit price = true := by
  simp only [bindNativeProtectionOrder, protection, ite_true] at h
  split at h
  next => contradiction
  next =>
    cases stopCase : children.find? (·.orderType == "STOP_LIMIT") with
    | none => simp only [stopCase] at h; contradiction
    | some stop =>
      cases profitCase : children.find? (·.orderType == "LIMIT") with
      | none => simp only [stopCase, profitCase] at h; contradiction
      | some profit =>
        simp only [stopCase, profitCase] at h
        split at h
        next group => exact ⟨stop, profit, rfl, rfl, group⟩
        next => contradiction

theorem bound_oco_requires_admitted_group (id : String) (root order : NativeOrderReceipt)
    (children : List NativeOrderReceipt) (target : NativeOrderTarget) (trigger limit price quantity boundPrice : Int)
    (kind : String) (protection : target.protection = .oco trigger limit price)
    (h : bindNativeProtectionOrder id root children target order = .bound quantity boundPrice kind) :
    ∃ stop, children.find? (·.orderType == "STOP_LIMIT") = some stop ∧
      nativeProtectionGroupAdmissible root children target stop root false trigger limit price = true := by
  simp only [bindNativeProtectionOrder, protection, Bool.false_eq_true, ite_false] at h
  split at h
  next => contradiction
  next =>
    cases stopCase : children.find? (·.orderType == "STOP_LIMIT") with
    | none => simp only [stopCase] at h; contradiction
    | some stop =>
      simp only [stopCase] at h
      split at h
      next group => exact ⟨stop, rfl, group⟩
      next => contradiction

theorem resolved_native_order_has_bound_helper (id : String) (root : NativeOrderReceipt)
    (children : List NativeOrderReceipt) (target : NativeOrderTarget) (quantity price : Int) (kind : String)
    (h : resolveNativeOrderGroup id root children target = .bound quantity price kind) :
    ∃ order, bindNativeProtectionOrder id root children target order = .bound quantity price kind := by
  cases selected : (if root.brokerId == id then some root else children.find? (·.brokerId == id)) with
  | none => simp only [resolveNativeOrderGroup, selected] at h; contradiction
  | some order =>
    simp only [resolveNativeOrderGroup, selected] at h
    split at h
    next => exact ⟨order, h⟩
    next => contradiction

theorem resolved_bracket_preserves_sealed_exit_prices (id : String) (root : NativeOrderReceipt)
    (children : List NativeOrderReceipt) (target : NativeOrderTarget) (trigger limit price quantity boundPrice : Int)
    (kind : String) (protection : target.protection = .bracket trigger limit price)
    (h : resolveNativeOrderGroup id root children target = .bound quantity boundPrice kind) :
    ∃ stop profit, children.find? (·.orderType == "STOP_LIMIT") = some stop ∧
      children.find? (·.orderType == "LIMIT") = some profit ∧
      stop.stopPrice = some trigger ∧ stop.limitPrice = some limit ∧ profit.limitPrice = some price := by
  obtain ⟨order, helper⟩ := resolved_native_order_has_bound_helper id root children target quantity boundPrice kind h
  obtain ⟨stop, profit, stopCase, profitCase, group⟩ :=
    bound_bracket_requires_admitted_group id root order children target trigger limit price quantity boundPrice kind protection helper
  have prices := admitted_native_exits_preserve_both_sealed_prices stop profit trigger limit price
    (admitted_native_group_preserves_exit_prices root stop profit children target true trigger limit price group)
  exact ⟨stop, profit, stopCase, profitCase, prices⟩

theorem resolved_oco_preserves_sealed_exit_prices (id : String) (root : NativeOrderReceipt)
    (children : List NativeOrderReceipt) (target : NativeOrderTarget) (trigger limit price quantity boundPrice : Int)
    (kind : String) (protection : target.protection = .oco trigger limit price)
    (h : resolveNativeOrderGroup id root children target = .bound quantity boundPrice kind) :
    ∃ stop, children.find? (·.orderType == "STOP_LIMIT") = some stop ∧
      stop.stopPrice = some trigger ∧ stop.limitPrice = some limit ∧ root.limitPrice = some price := by
  obtain ⟨order, helper⟩ := resolved_native_order_has_bound_helper id root children target quantity boundPrice kind h
  obtain ⟨stop, stopCase, group⟩ :=
    bound_oco_requires_admitted_group id root order children target trigger limit price quantity boundPrice kind protection helper
  have prices := admitted_native_exits_preserve_both_sealed_prices stop root trigger limit price
    (admitted_native_group_preserves_exit_prices root stop root children target false trigger limit price group)
  exact ⟨stop, stopCase, prices⟩

theorem admitted_native_group_bounds_both_legs (root stop profit : NativeOrderReceipt)
    (children : List NativeOrderReceipt) (target : NativeOrderTarget) (bracket : Bool) (trigger limit price : Int)
    (h : nativeProtectionGroupAdmissible root children target stop profit bracket trigger limit price = true) :
    (0 < stop.quantity.getD 0 ∧ stop.quantity.getD 0 ≤ target.quantity) ∧
    (0 < profit.quantity.getD 0 ∧ profit.quantity.getD 0 ≤ target.quantity) := by
  simp only [nativeProtectionGroupAdmissible, Bool.and_eq_true] at h
  exact ⟨admitted_native_leg_cannot_exceed_parent target.quantity stop h.1.1.2,
    admitted_native_leg_cannot_exceed_parent target.quantity profit h.1.2⟩

def nativeBracketExampleOwner : NativeOrderOwner := ⟨"intent", "decision", "generation", "account", "AAPL"⟩
def nativeBracketExampleParent : NativeOrderReceipt := {
  owner := nativeBracketExampleOwner, orderIntent := some "intent", brokerId := "parent", clientId := "parent-client",
  parentId := none, side := "BUY", orderType := "LIMIT", timeInForce := "DAY", quantity := some 1000000000,
  notional := none, limitPrice := some 100, stopPrice := none
}
def nativeBracketExampleProfit : NativeOrderReceipt := { nativeBracketExampleParent with
  brokerId := "profit", clientId := "profit-client", parentId := some "parent", side := "SELL", limitPrice := some 110
}
def nativeBracketExampleStop : NativeOrderReceipt := { nativeBracketExampleParent with
  brokerId := "stop", clientId := "stop-client", parentId := some "parent", side := "SELL", orderType := "STOP_LIMIT",
  quantity := some 500000000, limitPrice := some 89, stopPrice := some 90
}
def nativeBracketExampleTarget : NativeOrderTarget := {
  owner := nativeBracketExampleOwner, side := "BUY", orderType := "LIMIT", timeInForce := "DAY",
  quantity := 1000000000, limitPrice := 100, protection := .bracket 90 89 110
}

theorem native_parent_has_reachable_binding :
    resolveNativeOrderGroup "parent" nativeBracketExampleParent [nativeBracketExampleProfit, nativeBracketExampleStop]
      nativeBracketExampleTarget = .bound 1000000000 100 "Bracket" := by decide

theorem broker_adjusted_fractional_stop_has_reachable_binding :
    resolveNativeOrderGroup "stop" nativeBracketExampleParent [nativeBracketExampleProfit, nativeBracketExampleStop]
      nativeBracketExampleTarget = .bound 500000000 89 "Bracket" := by decide

theorem missing_sibling_is_detected_in_reachable_group :
    resolveNativeOrderGroup "stop" nativeBracketExampleParent [nativeBracketExampleStop]
      nativeBracketExampleTarget = .missing := by decide

theorem native_oco_has_reachable_binding :
    resolveNativeOrderGroup "stop" { nativeBracketExampleProfit with parentId := none }
      [{ nativeBracketExampleStop with parentId := some "profit" }]
      { nativeBracketExampleTarget with side := "SELL", limitPrice := 110, protection := .oco 90 89 110 }
      = .bound 500000000 89 "Oco" := by decide

theorem standalone_fractional_stop_has_reachable_binding :
    resolveNativeOrderGroup "stop" { nativeBracketExampleStop with parentId := none, timeInForce := "GTC" } []
      { nativeBracketExampleTarget with
        side := "SELL", orderType := "STOP_LIMIT", timeInForce := "GTC",
        quantity := 500000000, limitPrice := 89, protection := .stopLimit 90 }
      = .bound 500000000 89 "NONE" := by decide

def protectiveDisposalBudget (available disposed quantity : Int) : Bool :=
  decide (disposed + quantity ≤ available)

theorem a_protective_fill_cannot_overdraw_observed_inventory (available disposed quantity : Int)
    (h : protectiveDisposalBudget available disposed quantity = true) : disposed + quantity ≤ available := by
  simpa [protectiveDisposalBudget] using h

theorem both_protective_legs_share_one_budget (available first second : Int)
    (h : protectiveDisposalBudget available first second = true) : first + second ≤ available := by
  simpa [protectiveDisposalBudget] using h

theorem a_later_entry_cannot_fund_an_earlier_protective_fill (quantity : Int) (positive : 0 < quantity) :
    protectiveDisposalBudget 0 0 quantity = false := by simp [protectiveDisposalBudget]; omega

end Bayn
