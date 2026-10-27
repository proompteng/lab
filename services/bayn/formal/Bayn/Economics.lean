module
import Lean.Elab.Tactic.Omega

@[expose] public section

namespace Bayn

structure OperatingCosts where
  invoice : Nat
  tariff : Nat
  data : Nat
  infrastructure : Nat
  research : Nat
  deriving Repr, DecidableEq

def operatingCost (c : OperatingCosts) : Int :=
  c.invoice + c.data + c.infrastructure + c.research

def tradingProfit (realized openingUnrealized closingUnrealized executionCost settlementRounding : Int) : Int :=
  realized + closingUnrealized - openingUnrealized - executionCost + settlementRounding

theorem settlement_rounding_counted_once (g u0 u1 fees adjustment : Int) :
    tradingProfit g u0 u1 fees adjustment = tradingProfit g u0 u1 fees 0 + adjustment := by
  simp [tradingProfit]

theorem execution_refund_increases_net_once (g u0 u1 fees adjustment refund : Int) :
    tradingProfit g u0 u1 (fees - refund) adjustment = tradingProfit g u0 u1 fees adjustment + refund := by
  unfold tradingProfit; omega

theorem marked_profit_matches_cash_inventory (g cash0 cash1 value0 value1 basis0 basis1 fees adjustment : Int)
    (accounted : g = cash1 - cash0 + basis1 - basis0 + fees - adjustment) :
    tradingProfit g (value0 - basis0) (value1 - basis1) fees adjustment =
      (cash1 + value1) - (cash0 + value0) := by
  unfold tradingProfit; omega

def economicProfit (trading : Int) (c : OperatingCosts) : Int :=
  trading - operatingCost c

def qualificationProfit (trading : Int) (c : OperatingCosts) : Int :=
  economicProfit trading c - ((max c.invoice c.tariff : Nat) - c.invoice : Nat)

def cashInventoryProfit (opening closing externalFlows passiveYield : Int) (paidOperating : Nat) : Int :=
  closing - opening - externalFlows - passiveYield + paidOperating

theorem profit_conservation (trading : Int) (c : OperatingCosts) :
    economicProfit trading c + operatingCost c = trading := by
  unfold economicProfit
  omega

theorem qualification_conservative (trading : Int) (c : OperatingCosts) :
    qualificationProfit trading c ≤ economicProfit trading c := by
  unfold qualificationProfit
  omega

theorem invoice_replaces_tariff (trading : Int) (c : OperatingCosts)
    (h : c.tariff ≤ c.invoice) :
    qualificationProfit trading c = economicProfit trading c := by
  simp [qualificationProfit, Nat.max_eq_left h]

theorem additional_cost_cannot_increase_profit (trading : Int) (c : OperatingCosts) (extra : Nat) :
    economicProfit trading { c with research := c.research + extra } =
      economicProfit trading c - extra := by
  unfold economicProfit operatingCost
  dsimp only
  omega

theorem external_funding_is_not_profit (opening closing flows yield amount : Int) (paid : Nat) :
    cashInventoryProfit opening (closing + amount) (flows + amount) yield paid =
      cashInventoryProfit opening closing flows yield paid := by
  unfold cashInventoryProfit
  omega

theorem account_paid_operating_cost_is_deducted_once (opening closing flows yield : Int) (paid : Nat) :
    cashInventoryProfit opening (closing - paid) flows yield paid =
      cashInventoryProfit opening closing flows yield 0 := by
  unfold cashInventoryProfit
  omega

def advanceQualificationEquity (opening profit : Option Int) : Option Int :=
  match opening, profit with
  | some balance, some net => some (balance + net)
  | _, _ => none

theorem missing_equity_cannot_restart (profit : Option Int) :
    advanceQualificationEquity none profit = none := by
  cases profit <;> rfl

theorem missing_profit_cannot_reset (opening : Option Int) :
    advanceQualificationEquity opening none = none := by
  cases opening <;> rfl

theorem unknown_prefix_remains_unknown (profits : List (Option Int)) :
    profits.foldl advanceQualificationEquity none = none := by
  induction profits with
  | nil => rfl
  | cons profit rest ih =>
    simpa only [List.foldl_cons, missing_equity_cannot_restart] using ih

theorem qualification_window_conserves_profit (opening : Int) (profits : List Int) :
    (profits.map some).foldl advanceQualificationEquity (some opening) = some (opening + profits.sum) := by
  induction profits generalizing opening with
  | nil => simp
  | cons profit rest ih =>
    simp only [List.map_cons, List.foldl_cons, advanceQualificationEquity]
    rw [ih]
    simp [Int.add_assoc]

theorem negative_session_reduces_equity (opening profit closing : Int) (h : profit < 0)
    (observed : advanceQualificationEquity (some opening) (some profit) = some closing) : closing < opening := by
  simp [advanceQualificationEquity] at observed
  omega

theorem losing_and_zero_trade_sessions_are_retained :
    ([some (-1000000000), some (-20000000), some 500000000] : List (Option Int)).foldl
      advanceQualificationEquity (some 100000000000) = some 99480000000 := by
  decide

def tariffMeetsFloor (inputRate outputRate inputFloor outputFloor : Nat) : Bool :=
  decide (inputFloor ≤ inputRate ∧ outputFloor ≤ outputRate)

theorem accepted_tariff_preserves_cost_floor (inputRate outputRate inputFloor outputFloor inputTokens outputTokens : Nat)
    (h : tariffMeetsFloor inputRate outputRate inputFloor outputFloor = true) :
    inputTokens * inputFloor + outputTokens * outputFloor ≤
      inputTokens * inputRate + outputTokens * outputRate := by
  have bounds : inputFloor ≤ inputRate ∧ outputFloor ≤ outputRate := of_decide_eq_true h
  exact Nat.add_le_add (Nat.mul_le_mul_left inputTokens bounds.1) (Nat.mul_le_mul_left outputTokens bounds.2)

theorem frozen_tariff_boundary :
    tariffMeetsFloor 42000 0 42000 0 = true ∧ tariffMeetsFloor 41999 0 42000 0 = false := by
  decide

def binaryEdgeNumerator (gain loss cost probabilityNumerator probabilityDenominator : Int) : Int :=
  probabilityNumerator * gain - (probabilityDenominator - probabilityNumerator) * loss -
    probabilityDenominator * cost

theorem binary_edge_break_even (gain loss cost p d : Int) :
    binaryEdgeNumerator gain loss cost p d > 0 ↔ p * (gain + loss) > d * (loss + cost) := by
  have identity : binaryEdgeNumerator gain loss cost p d = p * (gain + loss) - d * (loss + cost) := by
    unfold binaryEdgeNumerator
    simp only [Int.sub_mul, Int.mul_add]
    omega
  rw [identity]
  omega

theorem profitable_target_does_not_establish_edge :
    (2000000 : Int) > 1000000 ∧ binaryEdgeNumerator 2000000 1000000 100000 3 10 < 0 := by
  decide

structure JointOutcome where
  weight : Nat
  candidateNet : Int
  controlNet : Int
  operationalSuccess : Bool
  deriving Repr

def weightedNet (outcomes : List JointOutcome) : Int :=
  (outcomes.map fun o => (o.weight : Int) * o.candidateNet).sum

def weightedEdge (outcomes : List JointOutcome) : Int :=
  (outcomes.map fun o => (o.weight : Int) * (o.candidateNet - o.controlNet)).sum

def weightedControl (outcomes : List JointOutcome) : Int :=
  (outcomes.map fun o => (o.weight : Int) * o.controlNet).sum

theorem edge_is_net_advantage (outcomes : List JointOutcome) :
    weightedEdge outcomes = weightedNet outcomes - weightedControl outcomes := by
  induction outcomes with
  | nil => simp [weightedEdge, weightedNet, weightedControl]
  | cons o rest ih =>
    simp only [weightedEdge, weightedNet, weightedControl, List.map_cons, List.sum_cons] at *
    rw [ih]
    rw [Int.mul_sub]
    omega

theorem profit_includes_failure_periods (outcomes : List JointOutcome) :
    weightedNet outcomes =
      weightedNet (outcomes.filter fun o => o.operationalSuccess) +
      weightedNet (outcomes.filter fun o => !o.operationalSuccess) := by
  induction outcomes with
  | nil => simp [weightedNet]
  | cons o rest ih =>
    cases h : o.operationalSuccess <;>
      simp [h, weightedNet] at * <;> omega

structure FinancialMark where
  account : String
  source : String
  occurredAt : Int
  availableAt : Int
  deriving Repr, DecidableEq

def eligibleFinancialMark (account : String) (opening closing asOf : Int) (mark : FinancialMark) : Bool :=
  decide (mark.account = account ∧ opening ≤ mark.occurredAt ∧ mark.occurredAt ≤ closing ∧ mark.availableAt ≤ asOf)

def retainedFinancialMarks (marks : List FinancialMark) (account : String) (opening closing asOf : Int) : List FinancialMark :=
  marks.filter (eligibleFinancialMark account opening closing asOf)

theorem eligible_mark_cannot_be_omitted (marks : List FinancialMark) (account : String)
    (opening closing asOf : Int) (mark : FinancialMark) (present : mark ∈ marks)
    (eligible : eligibleFinancialMark account opening closing asOf mark = true) :
    mark ∈ retainedFinancialMarks marks account opening closing asOf := by
  exact List.mem_filter.mpr ⟨present, eligible⟩

theorem retained_mark_has_exact_scope (marks : List FinancialMark) (account : String)
    (opening closing asOf : Int) (mark : FinancialMark)
    (retained : mark ∈ retainedFinancialMarks marks account opening closing asOf) :
    mark ∈ marks ∧ mark.account = account ∧ opening ≤ mark.occurredAt ∧ mark.occurredAt ≤ closing ∧ mark.availableAt ≤ asOf := by
  simpa [retainedFinancialMarks, eligibleFinancialMark] using retained

theorem intraminute_mark_is_reachable :
    retainedFinancialMarks [
      { account := "candidate", source := "opening", occurredAt := 0, availableAt := 0 },
      { account := "candidate", source := "loss", occurredAt := 30, availableAt := 30 },
      { account := "control", source := "foreign", occurredAt := 30, availableAt := 30 },
      { account := "candidate", source := "unavailable", occurredAt := 40, availableAt := 121 },
      { account := "candidate", source := "closing", occurredAt := 120, availableAt := 120 }
    ] "candidate" 0 120 120 = [
      { account := "candidate", source := "opening", occurredAt := 0, availableAt := 0 },
      { account := "candidate", source := "loss", occurredAt := 30, availableAt := 30 },
      { account := "candidate", source := "closing", occurredAt := 120, availableAt := 120 }
    ] := by decide

end Bayn
