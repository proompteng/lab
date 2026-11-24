# Positive net targets for PAPER equities (v44)

V43's 1.20 modeled reward-to-loss cutoff made base entries structurally infeasible. A base breakout enters above
the upper edge, puts its stop below the lower edge, and projects a target one base range beyond the upper edge.
Entry and stop allowances make that payoff ratio smaller still. The same geometry applies to base breakdowns.

V44 requires positive modeled equity profit at the target after costs and a modeled loss at the protective stop.
It keeps the 15 bps minimum equity stop distance, the equity quote and limit allowances, the existing structural
judgments, and the broker risk and protection limits. The crypto reward-to-loss cutoff remains 1.20.

Replay with recorded chart assessments, quotes, and funding increased funded equity candidates from 10 to 162 on
Friday, November 20, 2026 and from 10 to 122 on Monday, November 23, 2026. This measures eligibility before final
model judgments and order submission. Validate actual activity with prospective PAPER orders and fills.

1. Deliver migration 218 with the v43 mandate removed and verify clear OBSERVE with fresh exact reconciliation.
2. Deliver the v44 image and migration 219 in OBSERVE. Verify the exact image and controller binding.
3. Seal the replacement mandate for the same sandbox account and risk policy using the
   [research mandate rotation procedure](../../argocd/applications/bayn/README.md#research-mandate-rotation).
   Verify effective PAPER authority and the first regular-session order through reconciliation.
