module
import Lean.Elab.Tactic.Omega

@[expose] public section

namespace Bayn

def weightedAllocationsAux (amount total cumulative : Int) : List Int → List Int
  | [] => []
  | weight :: rest =>
    (amount * (cumulative + weight) / total - amount * cumulative / total) ::
      weightedAllocationsAux amount total (cumulative + weight) rest

def allocateCostByWeights (amount : Int) (weights : List Int) : Option (List Int) :=
  if amount < 0 ∨ weights = [] ∨ weights.any (fun weight => decide (weight ≤ 0)) then none
  else some (weightedAllocationsAux amount weights.sum 0 weights)

theorem weighted_allocations_telescope (amount total cumulative : Int) (weights : List Int) :
    (weightedAllocationsAux amount total cumulative weights).sum =
      amount * (cumulative + weights.sum) / total - amount * cumulative / total := by
  induction weights generalizing cumulative with
  | nil => simp [weightedAllocationsAux]
  | cons weight rest ih =>
    simp only [weightedAllocationsAux, List.sum_cons]
    rw [ih, Int.add_assoc]
    omega

theorem positive_weights_positive_total (weights : List Int)
    (positive : ∀ weight ∈ weights, 0 < weight) (nonempty : weights ≠ []) : 0 < weights.sum := by
  induction weights with
  | nil => contradiction
  | cons weight rest ih =>
    have first := positive weight (by simp)
    have others : ∀ value ∈ rest, 0 < value := by
      intro value member
      exact positive value (by simp [member])
    cases rest with
    | nil => simpa using first
    | cons next remaining =>
      have tail := ih others (by simp)
      simp only [List.sum_cons] at tail ⊢
      omega

theorem accepted_weighted_allocation_domain (amount : Int) (weights values : List Int)
    (accepted : allocateCostByWeights amount weights = some values) :
    0 ≤ amount ∧ weights ≠ [] ∧ (∀ weight ∈ weights, 0 < weight) ∧
      values = weightedAllocationsAux amount weights.sum 0 weights := by
  unfold allocateCostByWeights at accepted
  split at accepted
  · simp at accepted
  · rename_i valid
    simp only [not_or] at valid
    refine ⟨by omega, valid.2.1, ?_, Option.some.inj accepted.symm⟩
    intro weight member
    by_cases nonpositive : weight ≤ 0
    · have bad : weights.any (fun weight => decide (weight ≤ 0)) = true :=
        List.any_eq_true.mpr ⟨weight, member, by simp [nonpositive]⟩
      exact False.elim (valid.2.2 bad)
    · omega

theorem weighted_allocation_conserves_every_microdollar (amount : Int) (weights values : List Int)
    (accepted : allocateCostByWeights amount weights = some values) : values.sum = amount := by
  obtain ⟨_, nonempty, positive, rfl⟩ := accepted_weighted_allocation_domain amount weights values accepted
  have total := positive_weights_positive_total weights positive nonempty
  rw [weighted_allocations_telescope]
  simp [Int.ne_of_gt total]

theorem weighted_allocations_nonnegative (amount total cumulative : Int) (weights : List Int)
    (ha : 0 ≤ amount) (ht : 0 < total) (positive : ∀ weight ∈ weights, 0 < weight) :
    ∀ value ∈ weightedAllocationsAux amount total cumulative weights, 0 ≤ value := by
  induction weights generalizing cumulative with
  | nil => simp [weightedAllocationsAux]
  | cons weight rest ih =>
    intro value member
    simp only [weightedAllocationsAux, List.mem_cons] at member
    rcases member with rfl | tail
    · have first := positive weight (by simp)
      have ordered : cumulative ≤ cumulative + weight := by omega
      have bound := Int.ediv_le_ediv ht (Int.mul_le_mul_of_nonneg_left ordered ha)
      omega
    · exact ih (cumulative + weight) (fun w hw => positive w (by simp [hw])) value tail

theorem accepted_weighted_allocation_nonnegative (amount : Int) (weights values : List Int)
    (accepted : allocateCostByWeights amount weights = some values) : ∀ value ∈ values, 0 ≤ value := by
  obtain ⟨ha, nonempty, positive, rfl⟩ := accepted_weighted_allocation_domain amount weights values accepted
  exact weighted_allocations_nonnegative amount weights.sum 0 weights ha
    (positive_weights_positive_total weights positive nonempty) positive

theorem weighted_allocation_reachable : allocateCostByWeights 10 [1, 2, 3] = some [1, 4, 5] := by decide
theorem weighted_allocations_zero (total cumulative : Int) (weights : List Int) :
    weightedAllocationsAux 0 total cumulative weights = weights.map (fun _ => 0) := by
  induction weights generalizing cumulative with
  | nil => rfl
  | cons weight rest ih => simp [weightedAllocationsAux, ih]

theorem weighted_allocation_zero_charge (weights values : List Int)
    (accepted : allocateCostByWeights 0 weights = some values) : values = weights.map (fun _ => 0) := by
  obtain ⟨_, _, _, rfl⟩ := accepted_weighted_allocation_domain 0 weights values accepted
  exact weighted_allocations_zero weights.sum 0 weights
theorem weighted_allocation_terminal_remainder : allocateCostByWeights 1 [1, 1, 1] = some [0, 0, 1] := by decide

def proportionalCost (amount weight total : Int) : Option Int :=
  if amount < 0 ∨ weight < 0 ∨ total ≤ 0 ∨ total < weight then none
  else some (amount * weight / total)

theorem proportional_cost_domain (amount weight total value : Int)
    (h : proportionalCost amount weight total = some value) :
    0 ≤ amount ∧ 0 ≤ weight ∧ 0 < total ∧ weight ≤ total := by
  unfold proportionalCost at h
  split at h <;> simp_all <;> omega

theorem proportional_cost_zero (amount total : Int) (ha : 0 ≤ amount) (ht : 0 < total) :
    proportionalCost amount 0 total = some 0 := by
  simp [proportionalCost, Int.not_lt.mpr ha, Int.not_le.mpr ht, Int.not_lt.mpr (Int.le_of_lt ht)]

theorem proportional_cost_full (amount total : Int) (ha : 0 ≤ amount) (ht : 0 < total) :
    proportionalCost amount total total = some amount := by
  simp [proportionalCost, Int.not_lt.mpr ha, Int.not_lt.mpr (Int.le_of_lt ht),
    Int.not_le.mpr ht, Int.ne_of_gt ht]

theorem proportional_cost_bounds (amount weight total value : Int)
    (h : proportionalCost amount weight total = some value) : 0 ≤ value ∧ value ≤ amount := by
  obtain ⟨ha, hw, ht, hwt⟩ := proportional_cost_domain amount weight total value h
  have hv : value = amount * weight / total := by
    simp [proportionalCost, Int.not_lt.mpr ha, Int.not_lt.mpr hw, Int.not_le.mpr ht,
      Int.not_lt.mpr hwt] at h
    exact h.symm
  rw [hv]
  constructor
  · exact Int.ediv_nonneg (Int.mul_nonneg ha hw) (Int.le_of_lt ht)
  · have bound := Int.ediv_le_ediv ht (Int.mul_le_mul_of_nonneg_left hwt ha)
    simpa [Int.ne_of_gt ht] using bound

theorem proportional_cost_monotone (amount earlier later total first last : Int)
    (h : earlier ≤ later) (hf : proportionalCost amount earlier total = some first)
    (hl : proportionalCost amount later total = some last) : first ≤ last := by
  obtain ⟨ha, he, ht, het⟩ := proportional_cost_domain amount earlier total first hf
  obtain ⟨_, hlw, _, hlt⟩ := proportional_cost_domain amount later total last hl
  simp [proportionalCost, Int.not_lt.mpr ha, Int.not_lt.mpr he, Int.not_le.mpr ht,
    Int.not_lt.mpr het] at hf
  simp [proportionalCost, Int.not_lt.mpr ha, Int.not_lt.mpr hlw, Int.not_le.mpr ht,
    Int.not_lt.mpr hlt] at hl
  rw [← hf, ← hl]
  exact Int.ediv_le_ediv ht (Int.mul_le_mul_of_nonneg_left h ha)

def costRecognitionAt (opening closing startedAt : Int) : Int := max opening (min closing startedAt)

theorem cost_recognition_inside_session (opening closing startedAt : Int) (h : opening ≤ closing) :
    opening ≤ costRecognitionAt opening closing startedAt ∧
    costRecognitionAt opening closing startedAt ≤ closing := by
  unfold costRecognitionAt
  omega

theorem in_session_request_not_recognized_early (opening closing startedAt time : Int)
    (ho : opening ≤ startedAt) (hc : startedAt ≤ closing) (ht : time < startedAt) :
    time < costRecognitionAt opening closing startedAt := by
  unfold costRecognitionAt
  omega

theorem before_open_request_recognized_at_open (opening closing startedAt : Int)
    (h : startedAt ≤ opening) : costRecognitionAt opening closing startedAt = opening := by
  unfold costRecognitionAt
  omega

structure CostRequest where
  startedAt : Int
  weight : Nat
  deriving Repr

def totalCostWeight (requests : List CostRequest) : Nat := (requests.map (·.weight)).sum

def recognizedCostWeight (requests : List CostRequest) (opening closing time : Int) : Nat :=
  (requests.map fun request =>
    if costRecognitionAt opening closing request.startedAt ≤ time then request.weight else 0).sum

theorem recognized_cost_weight_bounded (requests : List CostRequest) (opening closing time : Int) :
    recognizedCostWeight requests opening closing time ≤ totalCostWeight requests := by
  induction requests with
  | nil => simp [recognizedCostWeight, totalCostWeight]
  | cons request rest ih =>
    simp only [recognizedCostWeight, totalCostWeight, List.map_cons, List.sum_cons] at *
    split <;> omega

theorem recognized_cost_weight_monotone (requests : List CostRequest) (opening closing earlier later : Int)
    (h : earlier ≤ later) :
    recognizedCostWeight requests opening closing earlier ≤ recognizedCostWeight requests opening closing later := by
  induction requests with
  | nil => simp [recognizedCostWeight]
  | cons request rest ih =>
    simp only [recognizedCostWeight, List.map_cons, List.sum_cons] at *
    split <;> split <;> omega

theorem closing_recognizes_all_allocated_requests (requests : List CostRequest) (opening closing : Int)
    (h : opening ≤ closing) : recognizedCostWeight requests opening closing closing = totalCostWeight requests := by
  induction requests with
  | nil => rfl
  | cons request rest ih =>
    have bound := (cost_recognition_inside_session opening closing request.startedAt h).2
    simp [recognizedCostWeight, totalCostWeight, bound] at *
    exact ih

structure RecognizedOperatingCosts where
  operating : Int
  premium : Int
  deriving Repr, DecidableEq

def recognizeAllocatedCosts (fixed invoice premium : Nat) (opening closing time : Int)
    (requests : List CostRequest) : Option RecognizedOperatingCosts := do
  if closing ≤ opening ∨ time < opening ∨ closing < time then none else
    let total := totalCostWeight requests
    let duration := closing - opening
    let elapsed := time - opening
    let weight := if total = 0 then elapsed else (recognizedCostWeight requests opening closing time : Int)
    let basis := if total = 0 then duration else (total : Int)
    let fixedPart ← proportionalCost fixed elapsed duration
    let meteredPart ← proportionalCost invoice weight basis
    let premiumPart ← proportionalCost premium weight basis
    return { operating := fixedPart + meteredPart, premium := premiumPart }

theorem closing_retains_every_allocated_cost (fixed invoice premium : Nat) (opening closing : Int)
    (requests : List CostRequest) (h : opening < closing) :
    recognizeAllocatedCosts fixed invoice premium opening closing closing requests =
      some { operating := (fixed : Int) + invoice, premium := premium } := by
  have hd : 0 < closing - opening := by omega
  have hall := closing_recognizes_all_allocated_requests requests opening closing (Int.le_of_lt h)
  unfold recognizeAllocatedCosts
  simp only [Int.not_le.mpr h, Int.not_lt.mpr (Int.le_of_lt h), Int.lt_irrefl, or_self,
    ↓reduceIte, hall]
  split
  · simp [proportional_cost_full _ _ (Int.natCast_nonneg _) hd]
  · have hp : 0 < (totalCostWeight requests : Int) := by omega
    simp [proportional_cost_full _ _ (Int.natCast_nonneg _) hd,
      proportional_cost_full _ _ (Int.natCast_nonneg _) hp]

theorem cost_attribution_reachable :
    recognizeAllocatedCosts 4000 8400 8400 0 10000 5000
      [{ startedAt := 2500, weight := 4200000000 }, { startedAt := 7500, weight := 12600000000 }] =
      some { operating := 4100, premium := 2100 } := by decide

theorem zero_trade_costs_reachable :
    recognizeAllocatedCosts 4000 8400 0 0 10000 5000 [] = some { operating := 6200, premium := 0 } := by decide

structure EvidencedCostRequest where
  startedAt : Option Int
  weight : Nat
  deriving Repr

def recognizeEvidencedCosts (fixed invoice premium : Nat) (opening closing time : Int)
    (requests : List EvidencedCostRequest) : Option RecognizedOperatingCosts :=
  if requests.any (fun request => request.startedAt.isNone && decide (0 < request.weight)) then none
  else recognizeAllocatedCosts fixed invoice premium opening closing time
    (requests.map fun request => ⟨request.startedAt.getD opening, request.weight⟩)

theorem positive_cost_without_start_cannot_be_recognized
    (fixed invoice premium : Nat) (opening closing time : Int)
    (requests : List EvidencedCostRequest) (request : EvidencedCostRequest)
    (member : request ∈ requests) (missing : request.startedAt = none) (positive : 0 < request.weight) :
    recognizeEvidencedCosts fixed invoice premium opening closing time requests = none := by
  have absent : requests.any (fun item => item.startedAt.isNone && decide (0 < item.weight)) = true :=
    List.any_eq_true.mpr ⟨request, member, by simp [missing, positive]⟩
  simp [recognizeEvidencedCosts, absent]

theorem unknown_clock_for_zero_charge_is_reachable :
    recognizeEvidencedCosts 4000 8400 0 0 10000 5000 [⟨none, 0⟩] =
      some ⟨6200, 0⟩ := by decide

structure CostWindowDocument where
  identity : String
  fingerprint : String
  scope : String
  requiredScopes : List String
  deriving Repr

def costWindowConsistent (documents : List CostWindowDocument) : Bool :=
  documents.all fun document =>
    (documents.all fun other => decide (document.identity ≠ other.identity ∨ document.fingerprint = other.fingerprint)) &&
    document.requiredScopes.all fun scope =>
      documents.any fun other => decide (document.identity = other.identity ∧ scope = other.scope)

theorem accepted_cost_window_has_one_document_version (documents : List CostWindowDocument)
    (accepted : costWindowConsistent documents = true) (a b : CostWindowDocument)
    (ha : a ∈ documents) (hb : b ∈ documents) (identity : a.identity = b.identity) :
    a.fingerprint = b.fingerprint := by
  have row := List.all_eq_true.mp accepted a ha
  have pair := List.all_eq_true.mp (Bool.and_eq_true_iff.mp row).1 b hb
  simpa [identity] using pair

theorem accepted_cost_window_covers_allocations (documents : List CostWindowDocument)
    (accepted : costWindowConsistent documents = true) (document : CostWindowDocument)
    (hd : document ∈ documents) (scope : String) (hs : scope ∈ document.requiredScopes) :
    ∃ other ∈ documents, document.identity = other.identity ∧ scope = other.scope := by
  have row := List.all_eq_true.mp accepted document hd
  have required := List.all_eq_true.mp (Bool.and_eq_true_iff.mp row).2 scope hs
  simpa using List.any_eq_true.mp required

theorem contradictory_invoice_cannot_pass :
    costWindowConsistent [
      { identity := "invoice", fingerprint := "charge-second-day", scope := "first", requiredScopes := ["second"] },
      { identity := "invoice", fingerprint := "charge-first-day", scope := "second", requiredScopes := ["first"] }
    ] = false := by decide

theorem consistent_invoice_window_is_reachable :
    costWindowConsistent [
      { identity := "invoice", fingerprint := "3-and-5", scope := "first", requiredScopes := ["first", "second"] },
      { identity := "invoice", fingerprint := "3-and-5", scope := "second", requiredScopes := ["first", "second"] }
    ] = true := by decide

end Bayn
