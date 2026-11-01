module
import Lean.Elab.Tactic.Omega

@[expose] public section

namespace Bayn

structure ExpenseIdentity where
  request : String
  stage : String
  receipt : Option String
  handoff : Option String
  chartClaim : Option String
  chartTerminal : Option String
  stageClaim : Option String
  stageTerminal : Option String
  stageSkip : Option String
  deriving Repr, DecidableEq

structure FrozenExpense where
  identity : ExpenseIdentity
  verified : Bool
  cost : Option Nat
  deriving Repr, DecidableEq

structure ExpenseCoverage where
  missing : Nat
  unverified : Nat
  gap : Nat
  deriving Repr, DecidableEq

def ExpenseCoverage.complete (coverage : ExpenseCoverage) : Prop :=
  coverage.missing = 0 ∧ coverage.unverified = 0 ∧ coverage.gap = 0

instance (coverage : ExpenseCoverage) : Decidable coverage.complete :=
  inferInstanceAs (Decidable (coverage.missing = 0 ∧ coverage.unverified = 0 ∧ coverage.gap = 0))

def currentExpenses (line : ExpenseIdentity) (frozen : List FrozenExpense) : List FrozenExpense :=
  frozen.filter (fun quote => decide (quote.identity = line))

def expenseLineCoverage (line : ExpenseIdentity) (frozen : List FrozenExpense) : Option ExpenseCoverage :=
  match currentExpenses line frozen with
  | [] => some ⟨1, 0, 0⟩
  | [quote] => some ⟨0, if quote.verified then 0 else 1, if quote.cost.isSome then 0 else 1⟩
  | _ => none

def addExpenseCoverage (left right : ExpenseCoverage) : ExpenseCoverage :=
  ⟨left.missing + right.missing, left.unverified + right.unverified, left.gap + right.gap⟩

def expenseCoverage (lines : List ExpenseIdentity) (frozen : List FrozenExpense) : Option ExpenseCoverage :=
  match lines with
  | [] => some ⟨0, 0, 0⟩
  | line :: rest => do
    let first ← expenseLineCoverage line frozen
    let tail ← expenseCoverage rest frozen
    return addExpenseCoverage first tail

theorem complete_expense_line_has_one_verified_priced_current_quote
    (line : ExpenseIdentity) (frozen : List FrozenExpense) (coverage : ExpenseCoverage)
    (accepted : expenseLineCoverage line frozen = some coverage) (complete : coverage.complete) :
    ∃ quote, currentExpenses line frozen = [quote] ∧ quote.identity = line ∧
      quote.verified = true ∧ quote.cost.isSome = true := by
  unfold expenseLineCoverage at accepted
  cases matching : currentExpenses line frozen with
  | nil => simp [matching, ExpenseCoverage.complete] at accepted complete; subst coverage; simp_all
  | cons quote rest =>
    cases rest with
    | cons next tail => simp [matching] at accepted
    | nil =>
      simp only [matching, Option.some.injEq] at accepted
      subst coverage
      have member : quote ∈ currentExpenses line frozen := by simp [matching]
      have identity : quote.identity = line := by
        simpa [currentExpenses] using (List.mem_filter.mp member).2
      refine ⟨quote, rfl, identity, ?_, ?_⟩
      · simpa [ExpenseCoverage.complete] using complete.2.1
      · cases cost : quote.cost <;> simp_all [ExpenseCoverage.complete]

theorem missing_current_expense_is_not_complete (line : ExpenseIdentity) (frozen : List FrozenExpense)
    (missing : currentExpenses line frozen = []) :
    expenseLineCoverage line frozen = some ⟨1, 0, 0⟩ := by
  simp [expenseLineCoverage, missing]

theorem duplicate_current_expenses_are_rejected (line : ExpenseIdentity) (frozen : List FrozenExpense)
    (first second : FrozenExpense) (rest : List FrozenExpense)
    (duplicates : currentExpenses line frozen = first :: second :: rest) :
    expenseLineCoverage line frozen = none := by
  simp [expenseLineCoverage, duplicates]

theorem old_receipt_cannot_cover_current_expense (line : ExpenseIdentity) (quote : FrozenExpense)
    (different : quote.identity.receipt ≠ line.receipt) :
    expenseLineCoverage line [quote] = some ⟨1, 0, 0⟩ := by
  have identity : quote.identity ≠ line := by intro equal; exact different (congrArg ExpenseIdentity.receipt equal)
  simp [expenseLineCoverage, currentExpenses, identity]

theorem another_provider_cannot_cover_current_expense (line : ExpenseIdentity) (quote : FrozenExpense)
    (different : quote.identity.stage ≠ line.stage) :
    expenseLineCoverage line [quote] = some ⟨1, 0, 0⟩ := by
  have identity : quote.identity ≠ line := by intro equal; exact different (congrArg ExpenseIdentity.stage equal)
  simp [expenseLineCoverage, currentExpenses, identity]

theorem changed_handoff_cannot_cover_current_expense (line : ExpenseIdentity) (quote : FrozenExpense)
    (different : quote.identity.handoff ≠ line.handoff) :
    expenseLineCoverage line [quote] = some ⟨1, 0, 0⟩ := by
  have identity : quote.identity ≠ line := by intro equal; exact different (congrArg ExpenseIdentity.handoff equal)
  simp [expenseLineCoverage, currentExpenses, identity]

theorem changed_chart_claim_cannot_cover_current_expense (line : ExpenseIdentity) (quote : FrozenExpense)
    (different : quote.identity.chartClaim ≠ line.chartClaim) :
    expenseLineCoverage line [quote] = some ⟨1, 0, 0⟩ := by
  have identity : quote.identity ≠ line := by intro equal; exact different (congrArg ExpenseIdentity.chartClaim equal)
  simp [expenseLineCoverage, currentExpenses, identity]

theorem old_chart_terminal_cannot_cover_current_expense (line : ExpenseIdentity) (quote : FrozenExpense)
    (different : quote.identity.chartTerminal ≠ line.chartTerminal) :
    expenseLineCoverage line [quote] = some ⟨1, 0, 0⟩ := by
  have identity : quote.identity ≠ line := by intro equal; exact different (congrArg ExpenseIdentity.chartTerminal equal)
  simp [expenseLineCoverage, currentExpenses, identity]

theorem coverage_addition_cannot_erase_gaps (left right : ExpenseCoverage) :
    (addExpenseCoverage left right).complete ↔ left.complete ∧ right.complete := by
  simp only [ExpenseCoverage.complete, addExpenseCoverage]
  omega

theorem changed_stage_claim_cannot_cover_current_expense (line : ExpenseIdentity) (quote : FrozenExpense)
    (different : quote.identity.stageClaim ≠ line.stageClaim) :
    expenseLineCoverage line [quote] = some ⟨1, 0, 0⟩ := by
  have identity : quote.identity ≠ line := by intro equal; exact different (congrArg ExpenseIdentity.stageClaim equal)
  simp [expenseLineCoverage, currentExpenses, identity]

theorem old_stage_terminal_cannot_cover_current_expense (line : ExpenseIdentity) (quote : FrozenExpense)
    (different : quote.identity.stageTerminal ≠ line.stageTerminal) :
    expenseLineCoverage line [quote] = some ⟨1, 0, 0⟩ := by
  have identity : quote.identity ≠ line := by intro equal; exact different (congrArg ExpenseIdentity.stageTerminal equal)
  simp [expenseLineCoverage, currentExpenses, identity]

theorem changed_stage_skip_cannot_cover_current_expense (line : ExpenseIdentity) (quote : FrozenExpense)
    (different : quote.identity.stageSkip ≠ line.stageSkip) :
    expenseLineCoverage line [quote] = some ⟨1, 0, 0⟩ := by
  have identity : quote.identity ≠ line := by intro equal; exact different (congrArg ExpenseIdentity.stageSkip equal)
  simp [expenseLineCoverage, currentExpenses, identity]

theorem complete_expense_cut_covers_every_provider_stage
    (lines : List ExpenseIdentity) (frozen : List FrozenExpense) (coverage : ExpenseCoverage)
    (accepted : expenseCoverage lines frozen = some coverage) (complete : coverage.complete) :
    ∀ line ∈ lines, ∃ quote, currentExpenses line frozen = [quote] ∧ quote.identity = line ∧
      quote.verified = true ∧ quote.cost.isSome = true := by
  induction lines generalizing coverage with
  | nil => simp
  | cons first rest ih =>
    cases headResult : expenseLineCoverage first frozen with
    | none => simp [expenseCoverage, headResult] at accepted
    | some head =>
      cases tailResult : expenseCoverage rest frozen with
      | none => simp [expenseCoverage, headResult, tailResult] at accepted
      | some tail =>
        simp [expenseCoverage, headResult, tailResult] at accepted
        subst coverage
        obtain ⟨headComplete, tailComplete⟩ := (coverage_addition_cannot_erase_gaps head tail).mp complete
        intro line member
        rcases List.mem_cons.mp member with rfl | later
        · exact complete_expense_line_has_one_verified_priced_current_quote line frozen head headResult headComplete
        · exact ih tail tailResult tailComplete line later

theorem expense_coverage_reachable_with_late_receipt :
    expenseCoverage [⟨"request", "JEV", some "late", some "handoff", none, none, none, none, none⟩]
      [⟨⟨"request", "JEV", none, some "handoff", none, none, none, none, none⟩, true, none⟩,
       ⟨⟨"request", "JEV", some "late", some "handoff", none, none, none, none, none⟩, true, some 42⟩] = some ⟨0, 0, 0⟩ := by decide

theorem expense_coverage_reachable_with_late_chart_terminal :
    expenseCoverage [⟨"request", "CHART", none, none, some "claim", some "late", none, none, none⟩]
      [⟨⟨"request", "CHART", none, none, some "claim", none, none, none, none⟩, true, none⟩,
       ⟨⟨"request", "CHART", none, none, some "claim", some "late", none, none, none⟩, true, some 42⟩] = some ⟨0, 0, 0⟩ := by decide

theorem undispatched_zero_is_priced :
    expenseCoverage [⟨"request", "JEV", none, some "hold", none, none, none, none, none⟩]
      [⟨⟨"request", "JEV", none, some "hold", none, none, none, none, none⟩, true, some 0⟩] = some ⟨0, 0, 0⟩ := by decide

end Bayn
