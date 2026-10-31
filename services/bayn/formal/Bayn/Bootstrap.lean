module
public import Bayn.Economics
import Lean.Elab.Tactic.Omega

@[expose] public section

namespace Bayn

def nextRandom (state : UInt32) : UInt32 :=
  let state := state ^^^ (state <<< 13)
  let state := state ^^^ (state >>> 17)
  state ^^^ (state <<< 5)

def blockStart (state : UInt32) : Nat := state.toNat * 20 / 4294967296

theorem block_start_in_range (state : UInt32) : blockStart state < 20 := by
  have h := state.toNat_lt
  unfold blockStart
  omega

def sampleBlocks : Nat → UInt32 → UInt32 × List Nat
  | 0, state => (state, [])
  | n + 1, state =>
    let state := nextRandom state
    let start := blockStart state
    let (finalState, rest) := sampleBlocks n state
    (finalState, start :: (start + 1) % 20 :: rest)

theorem sample_count (blocks : Nat) (state : UInt32) :
    (sampleBlocks blocks state).2.length = 2 * blocks := by
  induction blocks generalizing state with
  | zero => simp [sampleBlocks]
  | succ n ih => simp [sampleBlocks, ih]; omega

theorem sampled_indices_in_range (blocks : Nat) (state : UInt32) :
    ∀ i ∈ (sampleBlocks blocks state).2, i < 20 := by
  induction blocks generalizing state with
  | zero => simp [sampleBlocks]
  | succ n ih =>
    simp only [sampleBlocks, List.mem_cons]
    intro i h
    rcases h with h | h | h
    · subst i; exact block_start_in_range _
    · subst i; omega
    · exact ih _ i h

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
    let (next, indices) := sampleBlocks 10 state
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

theorem frozen_sample_has_twenty_sessions (state : UInt32) : (sampleBlocks 10 state).2.length = 20 := by
  exact sample_count 10 state

end Bayn
