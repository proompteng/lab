module
public import Bayn.ConditionalConfidence
public import Mathlib.Probability.Moments.SubGaussian

@[expose] public section
open MeasureTheory ProbabilityTheory
open scoped NNReal

namespace Bayn

theorem paired_support_without_independence (candidate control lowerC upperC lowerB upperB : ℝ)
    (c : lowerC ≤ candidate ∧ candidate ≤ upperC) (b : lowerB ≤ control ∧ control ≤ upperB) :
    lowerC-upperB ≤ candidate-control ∧ candidate-control ≤ upperC-lowerB := by constructor <;> linarith

theorem bounded_support_gives_centered_mgf {Ω : Type*} {mΩ : MeasurableSpace Ω} {μ : Measure Ω}
    [IsProbabilityMeasure μ] {X : Ω → ℝ} {lower upper : ℝ} (measurable : AEMeasurable X μ)
    (support : ∀ᵐ ω ∂μ, X ω ∈ Set.Icc lower upper) :
    HasSubgaussianMGF (fun ω => X ω - ∫ x, X x ∂μ) ((‖upper-lower‖₊/2)^2) μ :=
  hasSubgaussianMGF_of_mem_Icc measurable support

theorem conditional_exponential_budget (denominator : Nat) (positive : 0 < denominator) :
    Real.exp (-(conditionalLogBound denominator : ℝ)) ≤ 1 / (denominator : ℝ) := by
  have two_le : (2 : ℝ) ≤ Real.exp 1 := by
    have bound := Real.add_one_le_exp (1 : ℝ)
    norm_num at bound ⊢
    exact bound
  have power : (2 : ℝ) ^ conditionalLogBound denominator ≤ Real.exp (conditionalLogBound denominator) := by
    calc
      _ ≤ (Real.exp 1) ^ conditionalLogBound denominator := pow_le_pow_left₀ (by norm_num) two_le _
      _ = Real.exp ((conditionalLogBound denominator : ℝ) * 1) := (Real.exp_nat_mul 1 _).symm
      _ = _ := by rw [mul_one]
  have lower : (denominator : ℝ) ≤ (2 : ℝ) ^ conditionalLogBound denominator := by
    exact_mod_cast conditional_log_rounds_outward denominator
  have bound := one_div_le_one_div_of_le (by exact_mod_cast positive : (0 : ℝ) < denominator) (lower.trans power)
  simpa [Real.exp_neg, one_div] using bound

theorem finite_attempt_budget (n : Nat) :
    ∑ k ∈ Finset.range n, 1 / (20 * ((k : ℝ)+1) * ((k : ℝ)+2)) =
      (1 - 1 / ((n : ℝ)+1)) / 20 := by
  induction n with
  | zero => norm_num
  | succ n ih =>
    rw [Finset.sum_range_succ, ih]
    push_cast
    have first : (n : ℝ)+1 ≠ 0 := by positivity
    have next : (n : ℝ)+2 ≠ 0 := by positivity
    field_simp
    ring

theorem all_attempts_preserve_frozen_familywise_alpha (n : Nat) :
    ∑ k ∈ Finset.range n, 1 / (20 * ((k : ℝ)+1) * ((k : ℝ)+2)) ≤ 1/20 := by
  rw [finite_attempt_budget]
  have nonnegative : (0 : ℝ) ≤ 1 / ((n : ℝ)+1) := by positivity
  linarith

theorem matched_claims_share_one_attempt_budget (attempt claims : ℝ)
    (positiveAttempt : 0 < attempt) (positiveClaims : 0 < claims) :
    claims * (1 / (20 * attempt * (attempt+1) * claims)) = 1 / (20 * attempt * (attempt+1)) := by
  have nonzeroAttempt : attempt ≠ 0 := ne_of_gt positiveAttempt
  have next : attempt+1 ≠ 0 := by linarith
  have nonzeroClaims : claims ≠ 0 := ne_of_gt positiveClaims
  field_simp

theorem deterministic_support_forces_value (x lower upper : ℝ)
    (support : lower ≤ x ∧ x ≤ upper) (zeroWidth : lower = upper) : x = lower := by linarith

theorem conditional_process_tail_bound {Ω : Type*} {mΩ : MeasurableSpace Ω} {μ : Measure Ω}
    [IsProbabilityMeasure μ] [StandardBorelSpace Ω] {Y : ℕ → Ω → ℝ} {c : ℕ → ℝ≥0} {ℱ : Filtration ℕ mΩ}
    (adapted : StronglyAdapted ℱ Y) (first : HasSubgaussianMGF (Y 0) (c 0) μ) (n : ℕ)
    (conditional : ∀ i < n - 1, HasCondSubgaussianMGF (ℱ i) (ℱ.le i) (Y (i + 1)) (c (i + 1)) μ)
    {radius : ℝ} (nonnegative : 0 ≤ radius) :
    μ.real {ω | radius ≤ ∑ i ∈ Finset.range n, Y i ω} ≤
      Real.exp (-radius ^ 2 / (2 * ∑ i ∈ Finset.range n, c i)) := by
  exact measure_sum_ge_le_of_hasCondSubgaussianMGF adapted first n conditional nonnegative

/-- The market-side MGF and causal-filtration assumptions are printed in the assessment, not inferred from observations. -/
theorem rounded_radius_has_conservative_tail (variance radius logBound : ℝ)
    (positive : 0 < variance) (radiusBound : variance * logBound ≤ 2 * radius ^ 2) :
    Real.exp (-2 * radius ^ 2 / variance) ≤ Real.exp (-logBound) := by
  apply Real.exp_le_exp.mpr
  apply (div_le_iff₀ positive).2
  nlinarith

theorem conditional_lower_mean_exclusion_implies_tail (sample expected radius count : ℝ)
    (nonempty : 0 < count) (excluded : expected/count < (sample-radius)/count) :
    radius ≤ sample-expected := by
  have comparison := mul_lt_mul_of_pos_right excluded nonempty
  have nonzero : count ≠ 0 := ne_of_gt nonempty
  simp only [div_mul_cancel₀ _ nonzero] at comparison
  linarith

theorem conditional_process_covered_at_registered_alpha {Ω : Type*} {mΩ : MeasurableSpace Ω} {μ : Measure Ω}
    [IsProbabilityMeasure μ] [StandardBorelSpace Ω] {Y : ℕ → Ω → ℝ} {c : ℕ → ℝ≥0} {ℱ : Filtration ℕ mΩ}
    (adapted : StronglyAdapted ℱ Y) (first : HasSubgaussianMGF (Y 0) (c 0) μ) (n denominator : Nat)
    (conditional : ∀ i < n - 1, HasCondSubgaussianMGF (ℱ i) (ℱ.le i) (Y (i + 1)) (c (i + 1)) μ)
    (variance radius : ℝ) (variancePositive : 0 < variance) (radiusNonnegative : 0 ≤ radius)
    (varianceIdentity : 2 * ∑ i ∈ Finset.range n, (c i : ℝ) = variance/2)
    (radiusBound : variance * (conditionalLogBound denominator : ℝ) ≤ 2 * radius ^ 2)
    (positiveAlpha : 0 < denominator) :
    μ.real {ω | radius ≤ ∑ i ∈ Finset.range n, Y i ω} ≤ 1 / (denominator : ℝ) := by
  calc
    _ ≤ Real.exp (-radius^2/(2 * ∑ i ∈ Finset.range n, c i)) :=
      conditional_process_tail_bound adapted first n conditional radiusNonnegative
    _ = Real.exp (-2*radius^2/variance) := by
      push_cast
      rw [varianceIdentity]
      congr 1
      field_simp
    _ ≤ Real.exp (-(conditionalLogBound denominator : ℝ)) :=
      rounded_radius_has_conservative_tail variance radius _ variancePositive radiusBound
    _ ≤ _ := conditional_exponential_budget denominator positiveAlpha

/-- Fixed session means are a required registered model assumption. Random pathwise means are a different estimand. -/
theorem registered_expected_profit_bound {Ω : Type*} {mΩ : MeasurableSpace Ω} {μ : Measure Ω}
    [IsProbabilityMeasure μ] [StandardBorelSpace Ω] {X : ℕ → Ω → ℝ} {c : ℕ → ℝ≥0} {ℱ : Filtration ℕ mΩ}
    (means : ℕ → ℝ) (n denominator : Nat)
    (meanIdentity : ∀ i < n, means i = ∫ ω, X i ω ∂μ)
    (adapted : StronglyAdapted ℱ (fun i ω => X i ω - means i))
    (first : HasSubgaussianMGF (fun ω => X 0 ω - means 0) (c 0) μ)
    (conditional : ∀ i < n - 1, HasCondSubgaussianMGF (ℱ i) (ℱ.le i)
      (fun ω => X (i+1) ω - means (i+1)) (c (i+1)) μ)
    (variance radius : ℝ) (variancePositive : 0 < variance) (radiusNonnegative : 0 ≤ radius)
    (varianceIdentity : 2 * ∑ i ∈ Finset.range n, (c i : ℝ) = variance/2)
    (radiusBound : variance * (conditionalLogBound denominator : ℝ) ≤ 2 * radius ^ 2)
    (positiveAlpha : 0 < denominator) :
    μ.real {ω | radius ≤ (∑ i ∈ Finset.range n, X i ω) - (∑ i ∈ Finset.range n, ∫ x, X i x ∂μ)} ≤
      1 / (denominator : ℝ) := by
  have equalMeans : (∑ i ∈ Finset.range n, means i) = ∑ i ∈ Finset.range n, ∫ ω, X i ω ∂μ := by
    apply Finset.sum_congr rfl
    intro i hi
    exact meanIdentity i (Finset.mem_range.mp hi)
  have bound := conditional_process_covered_at_registered_alpha adapted first n denominator conditional
    variance radius variancePositive radiusNonnegative varianceIdentity radiusBound positiveAlpha
  simpa only [Finset.sum_sub_distrib, equalMeans] using bound


/-- Instantiate the concentration theorem with the exact radius computed by the executable model. -/
theorem executable_radius_covers_registered_expected_profit
    {Ω : Type*} {mΩ : MeasurableSpace Ω} {μ : Measure Ω}
    [IsProbabilityMeasure μ] [StandardBorelSpace Ω] {X : ℕ → Ω → ℝ} {ℱ : Filtration ℕ mΩ}
    (means : ℕ → ℝ) (n width denominator : Nat)
    (nonempty : 0 < n) (positiveWidth : 0 < width) (positiveAlpha : 0 < denominator)
    (meanIdentity : ∀ i < n, means i = ∫ ω, X i ω ∂μ)
    (adapted : StronglyAdapted ℱ (fun i ω => X i ω - means i))
    (first : HasSubgaussianMGF (fun ω => X 0 ω - means 0) ((width : ℝ≥0)^2/4) μ)
    (conditional : ∀ i < n - 1, HasCondSubgaussianMGF (ℱ i) (ℱ.le i)
      (fun ω => X (i+1) ω - means (i+1)) ((width : ℝ≥0)^2/4) μ) :
    μ.real {ω | (conditionalRadius n width denominator : ℝ) ≤
      (∑ i ∈ Finset.range n, X i ω) - (∑ i ∈ Finset.range n, ∫ x, X i x ∂μ)} ≤
        1 / (denominator : ℝ) := by
  apply registered_expected_profit_bound (c := fun _ => (width : ℝ≥0)^2/4) means n denominator meanIdentity adapted first conditional
    ((n : ℝ) * width^2) (conditionalRadius n width denominator)
  · positivity
  · positivity
  · simp only [Finset.sum_const, Finset.card_range, nsmul_eq_mul]
    push_cast
    ring
  · have normalized : n * width^2 * conditionalLogBound denominator ≤ 2 * (conditionalRadius n width denominator)^2 := by
      simpa only [pow_two, Nat.mul_assoc] using conditional_radius_never_understates_variance n width denominator
    exact_mod_cast normalized
  · exact positiveAlpha

end Bayn
