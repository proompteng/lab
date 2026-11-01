module
public import Bayn.Economics
import Lean.Elab.Tactic.Omega

@[expose] public section

namespace Bayn

def nextRandom (state : UInt32) : UInt32 :=
  let state := state ^^^ (state <<< 13)
  let state := state ^^^ (state >>> 17)
  state ^^^ (state <<< 5)

def blockStart (sessions : Nat) (state : UInt32) : Nat := state.toNat * sessions / 4294967296

theorem block_start_in_range (sessions : Nat) (positive : 0 < sessions) (state : UInt32) :
    blockStart sessions state < sessions := by
  have scaled := Nat.mul_lt_mul_of_pos_right state.toNat_lt positive
  unfold blockStart
  omega

def sampleWindow (sessions blockLength : Nat) : Nat → Nat → UInt32 → Nat → UInt32 × List Nat
  | 0, _, state, _ => (state, [])
  | n + 1, offset, state, start =>
    let next := if offset % blockLength == 0 then nextRandom state else state
    let start := if offset % blockLength == 0 then blockStart sessions next else start
    let (finalState, rest) := sampleWindow sessions blockLength n (offset + 1) next start
    (finalState, (start + offset % blockLength) % sessions :: rest)

theorem sample_count (sessions blockLength count offset start : Nat) (state : UInt32) :
    (sampleWindow sessions blockLength count offset state start).2.length = count := by
  induction count generalizing offset state start with
  | zero => simp [sampleWindow]
  | succ n ih => simp [sampleWindow, ih]

theorem sampled_indices_in_range (sessions blockLength : Nat) (positive : 0 < sessions)
    (count offset start : Nat) (state : UInt32) :
    ∀ i ∈ (sampleWindow sessions blockLength count offset state start).2, i < sessions := by
  induction count generalizing offset state start with
  | zero => simp [sampleWindow]
  | succ n ih =>
    simp only [sampleWindow, List.mem_cons]
    intro i h
    rcases h with h | h
    · subst i; exact Nat.mod_lt _ positive
    · exact ih _ _ _ i h

def sampleSessions (sessions blockLength : Nat) (state : UInt32) : UInt32 × List Nat :=
  sampleWindow sessions blockLength sessions 0 state 0

theorem sample_has_registered_length (sessions blockLength : Nat) (state : UInt32) :
    (sampleSessions sessions blockLength state).2.length = sessions := by
  exact sample_count _ _ _ _ _ _

theorem session_sample_indices_in_range (sessions blockLength : Nat) (positive : 0 < sessions) (state : UInt32) :
    ∀ i ∈ (sampleSessions sessions blockLength state).2, i < sessions := by
  exact sampled_indices_in_range _ _ positive _ _ _ _

def sampledTotal (pnl : Array Int) (indices : List Nat) : Int :=
  (indices.map fun i => pnl[i]!).sum

def pairedSample (candidate control : Array Int) (indices : List Nat) : Int :=
  (indices.map fun i => candidate[i]! - control[i]!).sum

theorem paired_samples_use_shared_indices (candidate control : Array Int) (indices : List Nat) :
    pairedSample candidate control indices = sampledTotal candidate indices - sampledTotal control indices := by
  induction indices with
  | nil => simp [pairedSample, sampledTotal]
  | cons i rest ih =>
    simp only [pairedSample, sampledTotal, List.map_cons, List.sum_cons] at *
    rw [ih]
    omega

structure BootstrapResult where
  lowerProfitTotal : Int
  lowerIncrementalTotals : Array Int
  deriving Repr

def registeredBootstrap (candidate : Array Int) (controls : Array (Array Int)) (attempt blockLength replicates seed : Nat) : BootstrapResult := Id.run do
  let mut state : UInt32 := UInt32.ofNat seed
  let mut totals : Array Int := #[]
  let mut differences : Array (Array Int) := controls.map fun _ => #[]
  for _ in [:replicates] do
    let (next, indices) := sampleSessions candidate.size blockLength state
    state := next
    let total := sampledTotal candidate indices
    totals := totals.push total
    differences := differences.mapIdx fun i values => values.push (total - sampledTotal controls[i]! indices)
  let sorted := totals.qsort (· < ·)
  let comparisonIndex := (replicates - 1) / (20 * (controls.size + 1) * attempt * (attempt + 1))
  let lowerProfitTotal := sorted[comparisonIndex]!
  let lowerIncrementalTotals := differences.map fun values => (values.qsort (· < ·))[comparisonIndex]!
  return { lowerProfitTotal, lowerIncrementalTotals }

def tailResolutionSupported (attempt controls replicates : Nat) : Prop :=
  0 < attempt ∧ 0 < controls ∧ 20 * (controls + 1) * attempt * (attempt + 1) ≤ replicates

instance (attempt controls replicates : Nat) : Decidable (tailResolutionSupported attempt controls replicates) := by
  unfold tailResolutionSupported; infer_instance

theorem later_attempts_can_reserve_adequate_resolution : tailResolutionSupported 13 3 20000 := by decide

theorem inadequate_budget_is_not_supported : ¬ tailResolutionSupported 13 3 10000 := by decide

theorem odd_window_has_exactly_registered_sessions :
    (sampleSessions 3 2 20260921).2.length = 3 ∧ (sampleSessions 21 3 20260921).2.length = 21 := by
  constructor <;> exact sample_has_registered_length _ _ _

end Bayn
