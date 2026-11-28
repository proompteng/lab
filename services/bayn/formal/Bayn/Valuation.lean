module
import Lean.Elab.Tactic.Omega

@[expose] public section

namespace Bayn

structure BidPosition where
  symbol : String
  quantity : Nat
  bidMicros : Nat
  costBasisMicros : Nat
  deriving Repr, DecidableEq

def bidPositionValue (p : BidPosition) : Nat := p.quantity * p.bidMicros / 1000000000

def bidInventoryValue (positions : List BidPosition) : Nat := (positions.map bidPositionValue).sum

def bidInventoryValid (positions : List BidPosition) : Prop :=
  (positions.map BidPosition.symbol).Nodup ∧ ∀ p ∈ positions, 0 < p.quantity ∧ 0 < p.bidMicros

instance (positions : List BidPosition) : Decidable (bidInventoryValid positions) := by
  unfold bidInventoryValid
  infer_instance

def bidMarkedEquity (cash : Option Int) (positions : Option (List BidPosition)) : Option Int :=
  match cash, positions with
  | some amount, some values => if bidInventoryValid values then some (amount + bidInventoryValue values) else none
  | _, _ => none

theorem unknown_cash_has_no_equity (ps : Option (List BidPosition)) : bidMarkedEquity none ps = none := by
  cases ps <;> rfl

theorem unknown_inventory_has_no_equity (cash : Int) : bidMarkedEquity (some cash) none = none := rfl

theorem invalid_inventory_has_no_equity (cash : Int) (ps : List BidPosition) (h : ¬bidInventoryValid ps) :
    bidMarkedEquity (some cash) (some ps) = none := by simp [bidMarkedEquity, h]

theorem bid_mark_conserves_cash_inventory (cash total : Int) (ps : List BidPosition)
    (h : bidMarkedEquity (some cash) (some ps) = some total) :
    total = cash + bidInventoryValue ps ∧ bidInventoryValid ps := by
  change (if bidInventoryValid ps then some (cash + bidInventoryValue ps) else none) = some total at h
  split at h
  next valid => simp only [Option.some.injEq] at h; exact ⟨h.symm, valid⟩
  next => contradiction

theorem flat_inventory_is_cash (cash : Int) : bidMarkedEquity (some cash) (some []) = some cash := by
  simp [bidMarkedEquity, bidInventoryValid, bidInventoryValue]

theorem bid_value_never_rounds_up (p : BidPosition) :
    bidPositionValue p * 1000000000 ≤ p.quantity * p.bidMicros := by
  exact Nat.div_mul_le_self _ _

theorem duplicated_position_cannot_create_equity (cash : Int) (p : BidPosition) (ps : List BidPosition) :
    bidMarkedEquity (some cash) (some (p :: p :: ps)) = none := by
  simp [bidMarkedEquity, bidInventoryValid]

theorem reachable_fractional_bid_mark :
    bidMarkedEquity (some 100) (some [{ symbol := "AAPL", quantity := 1500000001, bidMicros := 100000001, costBasisMicros := 150000000 }]) =
      some 150000101 := by decide

structure MarkedInventoryValue where
  equity : Int
  unrealized : Int
  positionCount : Nat
  deriving Repr, DecidableEq

def bidMarkedValue (cash : Option Int) (positions : Option (List BidPosition)) : Option MarkedInventoryValue :=
  match bidMarkedEquity cash positions, positions with
  | some equity, some ps => some {
      equity := equity,
      unrealized := (bidInventoryValue ps : Int) - (ps.map BidPosition.costBasisMicros).sum,
      positionCount := ps.length
    }
  | _, _ => none

theorem marked_unrealized_uses_actual_basis (cash : Option Int) (ps : List BidPosition) (value : MarkedInventoryValue)
    (h : bidMarkedValue cash (some ps) = some value) :
    value.unrealized + (ps.map BidPosition.costBasisMicros).sum = bidInventoryValue ps := by
  cases known : bidMarkedEquity cash (some ps) with
  | none => simp [bidMarkedValue, known] at h
  | some equity =>
    simp only [bidMarkedValue, known, Option.some.injEq] at h
    rw [← h]
    dsimp
    omega

theorem missing_cash_cannot_measure_unrealized (ps : Option (List BidPosition)) : bidMarkedValue none ps = none := by
  cases ps <;> rfl

theorem reachable_marked_gain_with_open_inventory :
    bidMarkedValue (some 100) (some [{ symbol := "AAPL", quantity := 1500000001, bidMicros := 100000001, costBasisMicros := 150000000 }]) = some { equity := 150000101, unrealized := 1, positionCount := 1 } := by decide

end Bayn
