module
import Lean.Elab.Tactic.Omega

@[expose] public section

namespace Bayn

def accountLoss (baseline equity : Int) : Int := max (baseline - equity) 0

def accountLimitBreached (baseline equity limit : Int) : Prop := accountLoss baseline equity > limit

instance (baseline equity limit : Int) : Decidable (accountLimitBreached baseline equity limit) := by
  unfold accountLimitBreached
  infer_instance

theorem account_loss_is_nonnegative (baseline equity : Int) : 0 ≤ accountLoss baseline equity := by
  unfold accountLoss
  omega

theorem account_loss_translation_invariant (baseline equity adjustment : Int) :
    accountLoss (baseline + adjustment) (equity + adjustment) = accountLoss baseline equity := by
  unfold accountLoss
  omega

theorem exact_account_limit_allows_equality (equity limit : Int) (nonnegative : 0 ≤ limit) :
    ¬ accountLimitBreached (equity + limit) equity limit := by
  unfold accountLimitBreached accountLoss
  omega

theorem one_micro_breach_blocks_entry (equity limit : Int) :
    accountLimitBreached (equity + limit + 1) equity limit := by
  unfold accountLimitBreached accountLoss
  omega

theorem gains_cannot_create_an_account_loss (baseline equity : Int) (gain : baseline ≤ equity) :
    accountLoss baseline equity = 0 := by
  unfold accountLoss
  omega

def accountProtectionReasons (equity dayStart peak dailyLimit drawdownLimit : Int) : List String :=
  (if accountLimitBreached dayStart equity dailyLimit then ["DAILY_LOSS_EXCEEDED"] else []) ++
  (if accountLimitBreached peak equity drawdownLimit then ["DRAWDOWN_EXCEEDED"] else [])

theorem protected_account_is_reachable :
    accountProtectionReasons 1000000 1000000 1000101 100 100 = ["DRAWDOWN_EXCEEDED"] := by decide

end Bayn
