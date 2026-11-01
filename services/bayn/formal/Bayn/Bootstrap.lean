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

def sampleBlocks (sessions : Nat) : Nat → UInt32 → UInt32 × List Nat
  | 0, state => (state, [])
  | n + 1, state =>
    let state := nextRandom state
    let start := blockStart sessions state
    let (finalState, rest) := sampleBlocks sessions n state
    (finalState, start :: (start + 1) % sessions :: rest)

theorem sample_count (sessions blocks : Nat) (state : UInt32) :
    (sampleBlocks sessions blocks state).2.length = 2 * blocks := by
  induction blocks generalizing state with
  | zero => simp [sampleBlocks]
  | succ n ih => simp [sampleBlocks, ih]; omega

theorem sampled_indices_in_range (sessions : Nat) (positive : 0 < sessions) (blocks : Nat) (state : UInt32) :
    ∀ i ∈ (sampleBlocks sessions blocks state).2, i < sessions := by
  induction blocks generalizing state with
  | zero => simp [sampleBlocks]
  | succ n ih =>
    simp only [sampleBlocks, List.mem_cons]
    intro i h
    rcases h with h | h | h
    · subst i; exact block_start_in_range sessions positive _
    · subst i; exact Nat.mod_lt _ positive
    · exact ih _ i h

def sampleSessions (sessions : Nat) (state : UInt32) : UInt32 × List Nat :=
  let (next, indices) := sampleBlocks sessions ((sessions + 1) / 2) state
  (next, indices.take sessions)

theorem sample_has_registered_length (sessions : Nat) (state : UInt32) :
    (sampleSessions sessions state).2.length = sessions := by
  simp [sampleSessions, sample_count]
  omega

theorem session_sample_indices_in_range (sessions : Nat) (positive : 0 < sessions) (state : UInt32) :
    ∀ i ∈ (sampleSessions sessions state).2, i < sessions := by
  intro i member
  exact sampled_indices_in_range sessions positive _ state i (List.mem_of_mem_take member)

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

def frozenBootstrap (candidate : Array Int) (controls : Array (Array Int)) (attempt : Nat) : BootstrapResult := Id.run do
  let mut state : UInt32 := 20260921
  let mut totals : Array Int := #[]
  let mut differences : Array (Array Int) := controls.map fun _ => #[]
  for _ in [:10000] do
    let (next, indices) := sampleSessions candidate.size state
    state := next
    let total := sampledTotal candidate indices
    totals := totals.push total
    differences := differences.mapIdx fun i values => values.push (total - sampledTotal controls[i]! indices)
  let sorted := totals.qsort (· < ·)
  let comparisonIndex := 9999 / (60 * attempt * (attempt + 1))
  let lowerProfitTotal := sorted[499]!
  let lowerIncrementalTotals := differences.map fun values => (values.qsort (· < ·))[comparisonIndex]!
  return { lowerProfitTotal, lowerIncrementalTotals }

def tailResolutionSupported (attempt : Nat) : Prop := 0 < attempt ∧ 60 * attempt * (attempt + 1) ≤ 10000

instance (attempt : Nat) : Decidable (tailResolutionSupported attempt) := by
  unfold tailResolutionSupported; infer_instance

theorem odd_window_has_exactly_registered_sessions :
    (sampleSessions 3 20260921).2.length = 3 ∧ (sampleSessions 21 20260921).2.length = 21 := by
  constructor <;> exact sample_has_registered_length _ _

end Bayn
