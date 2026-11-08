module

@[expose] public section

namespace Bayn

def currentEntryMarketAllowed (market : String) : Bool := market == "EQUITY"

/-- Scope eligibility is followed by the existing capital, ownership and risk checks. -/
def currentSubmissionMarketAllowed (market : String) (sell : Bool) : Bool :=
  currentEntryMarketAllowed market || sell

theorem crypto_entry_is_disabled : currentEntryMarketAllowed "CRYPTO" = false := by decide

theorem crypto_buy_cannot_pass_submission_scope :
    currentSubmissionMarketAllowed "CRYPTO" false = false := by decide

theorem crypto_submission_scope_requires_a_sell (sell : Bool)
    (allowed : currentSubmissionMarketAllowed "CRYPTO" sell = true) : sell = true := by
  cases sell <;> simp_all [currentSubmissionMarketAllowed, currentEntryMarketAllowed]

theorem equity_keeps_submission_scope (sell : Bool) :
    currentSubmissionMarketAllowed "EQUITY" sell = true := by
  cases sell <;> decide

end Bayn
