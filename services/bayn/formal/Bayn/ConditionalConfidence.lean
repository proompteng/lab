module
public import Mathlib.Data.Nat.Log
public import Mathlib.Data.Nat.Sqrt
public import Bayn.Qualification

@[expose] public section

namespace Bayn

def ceilSquareRoot (n : Nat) : Nat :=
  if Nat.sqrt n * Nat.sqrt n = n then Nat.sqrt n else Nat.sqrt n + 1

theorem ceil_square_root_is_outward (n : Nat) : n ≤ ceilSquareRoot n * ceilSquareRoot n := by
  unfold ceilSquareRoot
  split
  · omega
  · exact Nat.le_of_lt (Nat.lt_succ_sqrt n)

def conditionalAlphaDenominator (attempt claims : Nat) : Nat := 20 * attempt * (attempt + 1) * claims

def conditionalLogBound (denominator : Nat) : Nat :=
  if denominator ≤ 1 then 0 else (denominator - 1).log2 + 1

theorem conditional_log_rounds_outward (denominator : Nat) :
    denominator ≤ 2 ^ conditionalLogBound denominator := by
  unfold conditionalLogBound
  split
  · omega
  · have bound := Nat.lt_pow_succ_log_self (by decide : 1 < 2) (denominator - 1)
    rw [← Nat.log2_eq_log_two] at bound
    omega

def conditionalRadius (count width denominator : Nat) : Nat :=
  ceilSquareRoot ((count * width * width * conditionalLogBound denominator + 1) / 2)

theorem conditional_radius_never_understates_variance (count width denominator : Nat) :
    count * width * width * conditionalLogBound denominator ≤
      2 * (conditionalRadius count width denominator) ^ 2 := by
  have square := ceil_square_root_is_outward ((count * width * width * conditionalLogBound denominator + 1) / 2)
  unfold conditionalRadius
  simp only [Nat.pow_two]
  omega

def conditionalLowerSum (values : List Int) (width denominator : Nat) : Int :=
  values.sum - (conditionalRadius values.length width denominator : Int)

theorem zero_width_has_no_uncertainty_penalty (values : List Int) (denominator : Nat) :
    conditionalLowerSum values 0 denominator = values.sum := by
  simp [conditionalLowerSum, conditionalRadius, ceilSquareRoot]

structure ConditionalSupport where
  policy : String
  lower : Int
  upper : Int
  deriving Repr

structure ConditionalSeries where
  policy : String
  values : List Int
  deriving Repr

structure ConditionalBounds where
  denominator : Nat
  profit : Int
  paired : List (String × Int)
  deriving Repr, DecidableEq

def supportedSeries (support : ConditionalSupport) (series : ConditionalSeries) : Bool :=
  support.policy == series.policy && decide (support.lower ≤ support.upper) &&
  series.values.all (fun value => decide (support.lower ≤ value ∧ value ≤ support.upper))

def conditionalSeriesBounds (supports : List ConditionalSupport) (series : List ConditionalSeries)
    (attempt : Nat) : Option ConditionalBounds := do
  let candidate ← series.head?
  if attempt = 0 || candidate.values.isEmpty || series.length < 2 ||
      supports.length != series.length || !(supports.map (·.policy)).Nodup ||
      !(series.map (·.policy)).Nodup then none else do
    if !series.all (fun row => row.values.length == candidate.values.length &&
        supports.any (fun support => supportedSeries support row)) then none else do
      let support ← supports.find? (fun support => support.policy == candidate.policy)
      let denominator := conditionalAlphaDenominator attempt series.length
      let paired ← series.tail.mapM fun control => do
        let bound ← supports.find? (fun bound => bound.policy == control.policy)
        let values := List.zipWith (· - ·) candidate.values control.values
        pure (control.policy, conditionalLowerSum values
          ((support.upper - support.lower) + (bound.upper - bound.lower)).toNat denominator)
      pure { denominator, profit := conditionalLowerSum candidate.values (support.upper-support.lower).toNat denominator, paired }

theorem supported_series_contains_every_observation (support : ConditionalSupport) (series : ConditionalSeries)
    (accepted : supportedSeries support series = true) (value : Int) (member : value ∈ series.values) :
    support.lower ≤ value ∧ value ≤ support.upper := by
  have all := (Bool.and_eq_true_iff.mp accepted).2
  exact of_decide_eq_true (List.all_eq_true.mp all value member)

theorem conditional_lower_bound_cannot_exceed_observed_profit (values : List Int) (width denominator : Nat) :
    conditionalLowerSum values width denominator ≤ values.sum := by
  unfold conditionalLowerSum
  omega

structure EconomicSession where
  date : String
  profit : Int
  opening : Int
  closing : Int
  minimum : Int
  maximum : Int
  drawdown : Int
  deriving Repr

structure EconomicPolicy where
  policy : String
  sessions : List EconomicSession
  deriving Repr

def economicSessionsReconcile : Int → List String → List EconomicSession → Bool
  | _, [], [] => true
  | prior, date :: dates, session :: sessions =>
    session.date == date && decide (session.opening = prior ∧ session.closing - session.opening = session.profit ∧
      session.minimum ≤ session.opening ∧ session.minimum ≤ session.closing ∧
      session.opening ≤ session.maximum ∧ session.closing ≤ session.maximum ∧
      session.opening - session.minimum ≤ session.drawdown ∧ session.maximum - session.closing ≤ session.drawdown) &&
      economicSessionsReconcile session.closing dates sessions
  | _, _, _ => false

def economicDrawdown (peak : Int) : List EconomicSession → Int
  | [] => 0
  | session :: rest => max (max (peak - session.minimum) session.drawdown)
      (economicDrawdown (max peak session.maximum) rest)

structure EconomicChecks where
  netProfit : Bool
  positiveProfitLowerBound : Bool
  pairedIncrementalLowerBounds : Bool
  drawdown : Bool
  sessionLoss : Bool
  deriving Repr

def EconomicChecks.pass (checks : EconomicChecks) : Bool :=
  checks.netProfit && checks.positiveProfitLowerBound && checks.pairedIncrementalLowerBounds &&
    checks.drawdown && checks.sessionLoss

def evaluateEconomicEvidence (dates : List String) (allocation lossLimit drawdownLimit : Int)
    (attempt : Nat) (supports : List ConditionalSupport) (policies : List EconomicPolicy) : Option EconomicChecks := do
  if !(policies.map (·.policy)).Nodup then none else pure ()
  let candidate ← policies.find? (fun policy => policy.policy == "JEV")
  if !policies.all (fun policy => economicSessionsReconcile allocation dates policy.sessions) then none else do
    let series := candidate :: policies.filter (fun policy => policy.policy != "JEV")
    let bounds ← conditionalSeriesBounds supports
      (series.map (fun policy => ⟨policy.policy, policy.sessions.map (·.profit)⟩)) attempt
    pure {
      netProfit := decide (0 < (candidate.sessions.map (·.profit)).sum),
      positiveProfitLowerBound := decide (0 < bounds.profit),
      pairedIncrementalLowerBounds := bounds.paired.all (fun bound => decide (0 < bound.2)),
      drawdown := decide (max 0 (economicDrawdown allocation candidate.sessions) ≤ drawdownLimit),
      sessionLoss := candidate.sessions.all (fun session => decide (max 0 (session.opening-session.minimum) ≤ lossLimit))
    }

theorem evaluated_economics_requires_positive_observed_profit
    (dates : List String) (allocation lossLimit drawdownLimit : Int) (attempt : Nat)
    (supports : List ConditionalSupport) (policies : List EconomicPolicy) (checks : EconomicChecks)
    (evaluated : evaluateEconomicEvidence dates allocation lossLimit drawdownLimit attempt supports policies = some checks)
    (passed : checks.pass = true) :
    ∃ candidate, policies.find? (fun policy => policy.policy == "JEV") = some candidate ∧
      0 < (candidate.sessions.map (·.profit)).sum := by
  by_cases distinct : (policies.map (·.policy)).Nodup
  ·
    cases found : policies.find? (fun policy => policy.policy == "JEV") with
    | none => simp [evaluateEconomicEvidence, distinct, found] at evaluated
    | some candidate =>
      refine ⟨candidate, rfl, ?_⟩
      by_cases reconcile : policies.all (fun policy => economicSessionsReconcile allocation dates policy.sessions) = true
      · cases bounds : conditionalSeriesBounds supports
            ((candidate :: policies.filter (fun policy => policy.policy != "JEV")).map
              (fun policy => ⟨policy.policy, policy.sessions.map (·.profit)⟩)) attempt with
        | none =>
          simp only [List.map_cons] at bounds
          simp [evaluateEconomicEvidence, distinct, found, reconcile, bounds] at evaluated
        | some value =>
          simp only [List.map_cons] at bounds
          simp [evaluateEconomicEvidence, distinct, found, reconcile, bounds] at evaluated
          subst checks
          simp only [EconomicChecks.pass, Bool.and_eq_true_iff, decide_eq_true_eq] at passed
          exact passed.1.1.1.1
      · simp [evaluateEconomicEvidence, distinct, found, reconcile] at evaluated
  · simp [evaluateEconomicEvidence, distinct] at evaluated

theorem mismatched_calendar_cannot_reconcile (allocation : Int) (dates : List String) (sessions : List EconomicSession)
    (accepted : economicSessionsReconcile allocation dates sessions = true) : dates.length = sessions.length := by
  induction dates generalizing allocation sessions with
  | nil => cases sessions <;> simp_all [economicSessionsReconcile]
  | cons date dates ih =>
    cases sessions with
    | nil => simp [economicSessionsReconcile] at accepted
    | cons session sessions =>
      have tail := (Bool.and_eq_true_iff.mp accepted).2
      simpa using ih session.closing sessions tail

example : conditionalSeriesBounds [⟨"JEV",1,1⟩,⟨"CONTROL",0,0⟩]
    [⟨"JEV",[1]⟩,⟨"CONTROL",[0]⟩] 1 = some ⟨80,1,[("CONTROL",1)]⟩ := by decide +kernel
example : conditionalSeriesBounds [⟨"JEV",-3,1⟩,⟨"CONTROL",-4,-4⟩]
    [⟨"JEV",[2]⟩,⟨"CONTROL",[-4]⟩] 1 = none := by decide +kernel

end Bayn
