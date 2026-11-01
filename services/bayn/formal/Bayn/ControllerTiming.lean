module
import Lean.Elab.Tactic.Omega

@[expose] public section

namespace Bayn

structure ControllerClock where
  issuedAt : Int
  observedAt : Int
  completedAt : Int
  witnessedAt : Int
  deriving Repr

def orderedControllerClock (c : ControllerClock) : Prop :=
  c.issuedAt ≤ c.observedAt ∧ c.observedAt ≤ c.completedAt ∧ c.completedAt ≤ c.witnessedAt

instance (c : ControllerClock) : Decidable (orderedControllerClock c) := by
  unfold orderedControllerClock
  infer_instance

def controllerDurations (c : ControllerClock) : Option (Int × Int) :=
  if orderedControllerClock c then
    some (c.completedAt - c.issuedAt, c.witnessedAt - c.issuedAt)
  else none

theorem controller_durations_are_nonnegative (c : ControllerClock)
    (ordered : orderedControllerClock c) :
    0 ≤ c.completedAt - c.issuedAt ∧ 0 ≤ c.witnessedAt - c.issuedAt := by
  unfold orderedControllerClock at ordered
  omega

theorem durable_visibility_bounds_completion (c : ControllerClock)
    (ordered : orderedControllerClock c) :
    c.completedAt - c.issuedAt ≤ c.witnessedAt - c.issuedAt := by
  unfold orderedControllerClock at ordered
  omega

theorem later_witness_cannot_improve_latency (issued first later : Int) (ordered : first ≤ later) :
    first - issued ≤ later - issued := by omega

theorem invalid_controller_clock_has_no_duration (c : ControllerClock) (invalid : ¬ orderedControllerClock c) :
    controllerDurations c = none := by simp [controllerDurations, invalid]

def nearestRank95Index (count : Nat) : Nat := (95 * count + 99) / 100 - 1

theorem nonempty_p95_index_in_range (count : Nat) (nonempty : 0 < count) :
    nearestRank95Index count < count := by
  unfold nearestRank95Index
  omega

def nearestRank95Value (values : List Int) : Option Int :=
  if values.any (· < 0) then none else
    (values.mergeSort (· ≤ ·))[nearestRank95Index values.length]?

theorem empty_p95_is_unknown : nearestRank95Value [] = none := by
  simp [nearestRank95Value, nearestRank95Index]

theorem measured_controller_timing_is_reachable :
    controllerDurations ⟨1, 2, 3, 4⟩ = some (2, 3) ∧ nearestRank95Value [1, 2, 3] = some 3 := by
  constructor
  · decide
  · have sorted : ([1, 2, 3] : List Int).Pairwise (fun a b => (decide (a ≤ b)) = true) := by decide
    simp [nearestRank95Value, nearestRank95Index, List.mergeSort_of_pairwise sorted]

def latestBatchCompletion (batch : Int) : List Int → Int
  | [] => batch
  | time :: rest => max time (latestBatchCompletion batch rest)

def orderedFullBatchClock (issued observed batch : Int) (completions : List Int) : Prop :=
  issued ≤ observed ∧ observed ≤ batch ∧ completions ≠ [] ∧ ∀ time ∈ completions, batch ≤ time

instance (issued observed batch : Int) (completions : List Int) :
    Decidable (orderedFullBatchClock issued observed batch completions) := by
  unfold orderedFullBatchClock
  infer_instance

def fullBatchDuration (issued observed batch : Int) (completions : List Int) : Option Int :=
  if orderedFullBatchClock issued observed batch completions then
    some (latestBatchCompletion batch completions - issued)
  else none

theorem full_batch_completion_bounds_inference (batch : Int) (completions : List Int) :
    batch ≤ latestBatchCompletion batch completions := by
  induction completions with
  | nil => simp [latestBatchCompletion]
  | cons time rest ih => exact Int.le_trans ih (Int.le_max_right _ _)

theorem full_batch_completion_bounds_every_stage (batch time : Int) (completions : List Int)
    (present : time ∈ completions) : time ≤ latestBatchCompletion batch completions := by
  induction completions with
  | nil => simp at present
  | cons head rest ih =>
    rcases List.mem_cons.mp present with equal | remaining
    · subst time
      exact Int.le_max_left _ _
    · exact Int.le_trans (ih remaining) (Int.le_max_right _ _)

theorem full_batch_duration_is_nonnegative (issued observed batch : Int) (completions : List Int)
    (ordered : orderedFullBatchClock issued observed batch completions) :
    0 ≤ latestBatchCompletion batch completions - issued := by
  have bound := full_batch_completion_bounds_inference batch completions
  unfold orderedFullBatchClock at ordered
  omega

theorem additional_stage_cannot_shorten_batch (issued batch extra : Int) (completions : List Int) :
    latestBatchCompletion batch completions - issued ≤
      latestBatchCompletion batch (extra :: completions) - issued := by
  have bound : latestBatchCompletion batch completions ≤ max extra (latestBatchCompletion batch completions) := Int.le_max_right _ _
  simp only [latestBatchCompletion]
  omega

theorem invalid_full_batch_clock_has_no_duration (issued observed batch : Int) (completions : List Int)
    (invalid : ¬ orderedFullBatchClock issued observed batch completions) :
    fullBatchDuration issued observed batch completions = none := by
  simp [fullBatchDuration, invalid]

theorem empty_full_batch_clock_is_unknown (issued observed batch : Int) :
    fullBatchDuration issued observed batch [] = none := by
  simp [fullBatchDuration, orderedFullBatchClock]

theorem full_batch_timing_is_reachable : fullBatchDuration 1 2 3 [4, 6, 5] = some 5 := by decide

def validReplayBatchClock (issued completed p95 : Int) : Prop :=
  -8640000000000000 ≤ issued ∧ issued ≤ 8640000000000000 ∧
  -8640000000000000 ≤ completed ∧ completed ≤ 8640000000000000 ∧
  0 ≤ p95 ∧ p95 ≤ 9007199254740991 ∧ issued ≤ completed ∧
  -8640000000000000 ≤ issued + p95 ∧ issued + p95 ≤ 8640000000000000

instance (issued completed p95 : Int) : Decidable (validReplayBatchClock issued completed p95) := by
  unfold validReplayBatchClock
  infer_instance

def replayDecisionReleaseAt (issued completed p95 : Int) : Option Int :=
  if validReplayBatchClock issued completed p95 then some (max completed (issued + p95)) else none

theorem batch_release_bounds_completion_and_floor (issued completed p95 released : Int)
    (accepted : replayDecisionReleaseAt issued completed p95 = some released) :
    completed ≤ released ∧ issued + p95 ≤ released := by
  unfold replayDecisionReleaseAt at accepted
  split at accepted
  · cases accepted
    exact ⟨Int.le_max_left _ _, Int.le_max_right _ _⟩
  · cases accepted

theorem slower_batch_work_is_preserved (issued completed p95 : Int)
    (valid : validReplayBatchClock issued completed p95) (slower : issued + p95 ≤ completed) :
    replayDecisionReleaseAt issued completed p95 = some completed := by
  simp [replayDecisionReleaseAt, valid, Int.max_eq_left slower]

theorem invalid_batch_release_is_unknown (issued completed p95 : Int)
    (invalid : ¬ validReplayBatchClock issued completed p95) :
    replayDecisionReleaseAt issued completed p95 = none := by
  simp [replayDecisionReleaseAt, invalid]

theorem negative_batch_stress_is_unknown (issued completed p95 : Int) (negative : p95 < 0) :
    replayDecisionReleaseAt issued completed p95 = none := by
  apply invalid_batch_release_is_unknown
  intro valid
  unfold validReplayBatchClock at valid
  omega

theorem batch_release_is_a_valid_date (issued completed p95 released : Int)
    (accepted : replayDecisionReleaseAt issued completed p95 = some released) :
    -8640000000000000 ≤ released ∧ released ≤ 8640000000000000 := by
  unfold replayDecisionReleaseAt at accepted
  split at accepted
  · rename_i valid
    cases accepted
    unfold validReplayBatchClock at valid
    omega
  · cases accepted

theorem stressed_batch_release_is_reachable :
    replayDecisionReleaseAt 100 120 50 = some 150 ∧ replayDecisionReleaseAt 100 200 50 = some 200 := by decide

end Bayn
