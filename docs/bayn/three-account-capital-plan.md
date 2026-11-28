# Bayn three-account capital plan — Wave 17-9

**Decision: keep all three sleeves in Paper.** The $50k split starts Account #1 above the legacy $25k PDT
threshold but fails the 5 bp stress. The $100k split is the first tested split to clear that stress for B0
and Phase 2. The $250k split clears the 10 bp buffer test, but at that cost Account #1 loses money in both
variants. A bigger buffer is not an economic reason to fund the strategy.

This is retrospective research over **2,741 regular sessions, 2016-01-04 through 2026-11-25 (10.89 years)**.
The dollar allocations are planning scenarios, not instructions to transfer, trade, change a live limit, or
open additional accounts.

## Capital ladder

Use the three slots in the [Paper account design](multi-account-sleeve-architecture.md). #2 and #3 each have
a $10k Paper test balance. Do not infer that three distinct live accounts are available from the Paper limit.

| Total | #1: intraday v3 reference | #2: F4 | #3: O1 | Planning decision                                                                                                                    |
| ----: | ------------------------: | -----: | -----: | ------------------------------------------------------------------------------------------------------------------------------------ |
|  $30k |                      $10k |   $10k |   $10k | Long-only with settled cash in the model. Use as a small-account Paper comparison, not as proof that the signed B0 book can run.     |
|  $50k |                      $30k |   $10k |   $10k | First signed scenario: $5k initial legacy PDT headroom, insufficient at 5 and 10 bp.                                                 |
| $100k |                      $40k |   $35k |   $25k | First signed split clearing 5 bp legacy stress. Consider only after an independent economic and live-account review; it fails 10 bp. |
| $250k |                     $100k |   $90k |   $60k | Lowest rounding tracking error at 5 bp; clears 10 bp legacy stress but does not rescue the intraday economics.                       |

- **#1, Pillar 1:** [Wave 9B B0](evidence/2026-11-27-10yr-qqq-smh-conditioning/README.md), QQQ + SMH.
  The separate Phase 2 diagnostic adds XLK from the start of the same replay, without retuning. Both end
  every modeled session flat. The replay does not implement the production protection stack.
- **#2, Pillar 2:** [F4](macro-etf-core-architecture.md), next regular open only. SPY, QQQ, IEF, TLT,
  GLD, HYG and SHY are representative holdings, not a hard ticker restriction. Use the full registered
  F4 vector: no exclusion, haircut, or redistribution of its QQQ target.
- **#3, Pillar 2B:** [Wave 5D O1](evidence/2026-11-27-etf-canary-macro-v2/README.md), macro canary,
  time-series momentum (TSMOM), and macro regime, next regular open only. This is the research reference,
  not a performance claim for the [production O1 planner](macro-canary-etf-rollout.md).
  #2 and #3 each trade at most once per symbol per regular open; neither generates same-session round trips.

## Combined results and rounding

B0 below uses **whole shares**. Costs are **one-way bp**, plus the sell-side fee. The last two columns compare
against the same strategy with fractional quantities. A negative delta means smaller whole-share CAGR; a small
positive delta can occur when rounding changes exposures, turnover, or the deadband decision. It is not an edge.

| Total | Cost (bp) |   CAGR | Ann. vol. | Sharpe | Sortino | Max DD | Calmar | CAGR delta (bp) | Tracking error (bp/yr) |
| ----: | --------: | -----: | --------: | -----: | ------: | -----: | -----: | --------------: | ---------------------: |
|  $30k |         2 |  5.57% |     4.43% |  1.247 |   1.873 |  8.94% |  0.623 |          -26.99 |                  73.64 |
|  $30k |         5 |  4.82% |     4.61% |  1.046 |   1.530 |  9.60% |  0.502 |          -15.17 |                  61.76 |
|  $30k |        10 |  3.76% |     4.60% |  0.826 |   1.171 | 10.10% |  0.372 |          -16.70 |                  74.86 |
|  $50k |         2 |  6.94% |     5.54% |  1.241 |   2.001 |  4.77% |  1.455 |          -16.13 |                  43.42 |
|  $50k |         5 |  3.45% |     5.08% |  0.693 |   1.053 |  6.82% |  0.505 |          -11.28 |                  42.50 |
|  $50k |        10 | -0.10% |     4.66% |  0.001 |   0.002 | 23.51% | -0.004 |          -14.74 |                  63.39 |
| $100k |         2 |  6.94% |     4.83% |  1.416 |   2.216 |  7.25% |  0.957 |           -7.61 |                  33.03 |
| $100k |         5 |  4.60% |     4.71% |  0.979 |   1.460 |  8.40% |  0.547 |          -13.76 |                  34.50 |
| $100k |        10 |  2.73% |     4.93% |  0.573 |   0.814 | 12.81% |  0.213 |           +0.62 |                  46.63 |
| $250k |         2 |  6.91% |     4.84% |  1.407 |   2.203 |  7.42% |  0.931 |           -0.82 |                  17.40 |
| $250k |         5 |  4.60% |     4.75% |  0.974 |   1.448 |  8.53% |  0.540 |           -6.76 |                  18.52 |
| $250k |        10 |  2.61% |     4.92% |  0.549 |   0.778 | 12.93% |  0.202 |           -5.04 |                  36.57 |

At 5 bp with B0, the daily sleeves contribute most of the tracking error. They also have high positive
correlation; separate ledgers protect ownership, not diversification.

The [coordinated F4/O1 v2 proposal](macro-portfolio-v2.md) targets those two daily books, with a separate
walk-forward comparison. It does not change this plan, the three-account results, or the Paper decision.

| Total | Tracking error #1 / #2 / #3 (bp/yr) | Corr. #1–#2 | Corr. #1–#3 | Corr. #2–#3 | Phase 2 combined CAGR, 2 / 5 / 10 bp |
| ----: | ----------------------------------: | ----------: | ----------: | ----------: | -----------------------------------: |
|  $30k |             18.16 / 145.68 / 131.78 |       0.201 |       0.257 |       0.737 |                5.60% / 4.84% / 3.78% |
|  $50k |             10.02 / 145.68 / 131.78 |       0.013 |       0.019 |       0.737 |               7.16% / 3.59% / -0.04% |
| $100k |                6.06 / 57.68 / 70.58 |       0.010 |       0.023 |       0.763 |                7.08% / 4.69% / 2.77% |
| $250k |                2.97 / 32.66 / 36.72 |       0.008 |       0.017 |       0.775 |                7.04% / 4.70% / 2.65% |

The JSON contains all 24 scenarios, whole and fractional account and portfolio metrics, paired rounding
deltas (including ending dollars), and 3×3 Pearson matrices in #1/#2/#3 order for every cost and variant.

## Account #1: legacy $25,000 PDT stress

[FINRA Notice 26-10](https://www.finra.org/rules-guidance/notices/26-10) replaced PDT with intraday
margin standards effective June 4, 2026, with phase-in through October 20, 2027. Alpaca's
[Trading API guide](https://docs.alpaca.markets/us/docs/understanding-finras-new-intraday-margin-rule-and-the-end-of-pdt)
describes the new regime, but its [customer agreement](https://files.alpaca.markets/disclosures/library/AcctAppMarginAndCustAgmt.pdf)
allows phased adoption by account during the transition. Verify the exact intended live account's regime, short
eligibility, buying power, intraday margin and house limits. This $25k table is a **legacy scenario or internal
risk reference**, not a current broker rule for every account.

For each signed whole-share path, apply its worst peak-to-close drawdown **D** to starting equity. The minimum
starting balance for that shock is the first cent strictly above `$25,000 / (1 − D)`. This is stricter than
simply checking whether the realized path started above the threshold. Observed closes and the shock test are
separate: the replay continues through a breach to measure downside; it does not simulate a broker freeze.

| Total | #1 start | Cost (bp) | B0 minimum (closes at/below $25k) | Phase 2 minimum (closes at/below $25k) | Start clears both shocks? |
| ----: | -------: | --------: | --------------------------------: | -------------------------------------: | :------------------------ |
|  $30k |     $10k |       All |                  N/A (cash proxy) |                       N/A (cash proxy) | Not a legacy PDT book     |
|  $50k |     $30k |         2 |                    $27,733.10 (0) |                         $27,658.06 (0) | Yes                       |
|  $50k |     $30k |         5 |                  $32,566.82 (167) |                       $32,965.66 (287) | No                        |
|  $50k |     $30k |        10 |                $74,445.92 (2,492) |                     $72,498.58 (2,463) | No                        |
| $100k |     $40k |         2 |                    $27,742.84 (0) |                         $27,672.58 (0) | Yes                       |
| $100k |     $40k |         5 |                    $32,593.49 (0) |                         $32,950.85 (0) | Yes                       |
| $100k |     $40k |        10 |                $74,810.14 (1,857) |                     $72,244.02 (1,841) | No                        |
| $250k |    $100k |         2 |                    $27,743.54 (0) |                         $27,679.54 (0) | Yes                       |
| $250k |    $100k |         5 |                    $32,600.73 (0) |                         $32,994.95 (0) | Yes                       |
| $250k |    $100k |        10 |                    $75,034.51 (0) |                         $72,496.84 (0) | Yes                       |

Example: at $50k total and 5 bp, B0's worst drawdown is 23.23%; applying the unrounded loss to $30k leaves
$23,029.58. The $250k split absorbs the 10 bp shock but B0 loses 8.98% annualized within that account.
These floors are conditional on the observed path, not guarantees after rescaling: changing the initial equity
changes rounding and cap exposure. They use daily closes, not the intraday equity low, and are not funding targets.
The $30k cash proxy assumes modern [T+1 settlement](https://syndication.finra.org/content/frequent-intraday-trading-understanding-basics)
across the whole tape, no shorts, and no reuse of same-session proceeds. [Alpaca retail does not offer cash accounts](https://alpaca.markets/support/alpaca-cash-accounts);
do not apply the cash result to an unverified margin account or use it to infer an allowed day-trade count.

## Graduation gates

1. **Identity and isolation.** Reuse the approved Paper UUIDs and maintain separate account writers, ledgers,
   balances and order journals per the [multi-account runbook](multi-account-sleeve-architecture.md). Verify
   complete adjusted signal evidence and raw whole-share planning evidence for next-open trades. Use the
   [read-only corporate-action verifier](corporate-action-hygiene.md) to check these price bases and B0's gap and
   short-borrow evidence. Before proposing a live split, obtain broker confirmation of three approved isolated live
   books, each account's actual margin or settled-cash rules, and handling of overlapping QQQ orders under its
   [order protections](https://docs.alpaca.markets/us/docs/user-protection). Hold in Paper if that topology is
   unsupported; don't combine sleeves or change credential identities to approximate it.
2. **Prospective Paper evidence.** Pin the protocol and register the eligible sessions, limits, comparator
   and cost budget before observing outcomes. Follow the [Paper scorecard](profitability-master-playbook.md#daily-scorecard-and-the-promotion-boundary)
   and [O1 acceptance plan](macro-canary-etf-rollout.md#prospective-120-session-acceptance). Require terminal
   decisions, reconciled fills/fees/inventory, no unresolved or duplicate orders, Account #1 flat at each close,
   and each daily sleeve trading only at the authorized next open. Count all registered sessions, including
   skips. Compare real order sizes, costs, residual cash and tracking against the independently reviewed model.
3. **Economics and loss limits before live.** Require each sleeve to clear its registered net-of-all-costs
   economic and drawdown tests; don't let another account's gains hide a failing sleeve. For legacy PDT or
   an internal equity limit, choose a deployable buffer above the adverse result with an extra margin of safety
   and stop new entries before breaching it. Under the new regime, demonstrate the broker's intraday and
   house-margin controls instead. Require a reviewed account-specific risk budget, recovery and independent
   authority grant. Move one sleeve at a time only with that grant, and reconcile the first natural fills
   before another increase. This study grants no capital or mutation authority.
4. **XLK is a separate decision.** Require the [five-session SIP parity and capacity gates](consolidated-sip-shadow-rollout.md#phase-2-decision)
   and a preregistered, same-feed evaluation and review. Do not introduce XLK on the strength of the small
   retrospective uplift here.

## Reproduce and interpret

From the repository root on a runner with the existing read-only Rook-Ceph `agents-artifacts` identity:

```sh
bun services/bayn/tools/research-3account-capital-allocation.ts --output /tmp/bayn-three-account-capital.json
```

Use a fresh path for every run. The tool only reads pinned market data and creates a new JSON report; it does
not update any freeze, write to a broker, or need Alpaca credentials. It authenticates the original SIP manifests,
calendar cuts and gzip receipts (including the blind gzip suffix), accounts for **8,641,719** older and
**3,923,737** recent 5-minute rows, reconstitutes the $100k fixed B0 Wave 9B oracle at **2 and 5 bp round trip**,
and checks hashes for **63 F4** and **119 O1** reviews against [Wave 8A](evidence/2026-11-27-macro-etf-core-dual-horizon/README.md).
The signed cases retain the known B0 held-bar gap on 2016-02-02 with an observed exit; a missing exit fails the
study. The held gap prevents treating this as complete execution evidence.

- **Sizing:** Reinvest in each account without transfers or cross-account netting; combine by summing marked
  account equities, not by rebalancing the opening allocations. #1 reserves up to 1× start-of-session equity
  ($180k entry budget cap) at the greater of the decision mark and the next 5-minute open plus a 10 bp reserve.
  Use B0's inverse-volatility weights and exits; no reallocating a name's unused budget. This is not
  4× DTBP or an intraday marked-gross or locate simulation. #2 and #3 start in SHY and use fully funded,
  post-fee budgets capped at $150k on reviews, not forced trims between reviews. Use F4's 10% aggregate drift
  band and O1's 5 percentage-point per-symbol band; preserve O1's separate residual SHY sweep.
- **Costs and evidence:** Apply the 2/5/10 bp assumption at both buy and sell, plus 0.21 bp on sell proceeds.
  Whole-share quantities are rounded down; residual cash earns nothing. Daily shares are in adjusted
  price units (not raw historical broker shares); the ideal fractional short is only a mathematical reference.
  No terminal liquidation, leverage financing, point-in-time short inventory, auction/queue or impact model,
  taxes, or operating expenses. Do not infer future profitability or large-order fill quality.
- **Statistics:** CAGR uses the inclusive calendar span / 365.2425. Volatility and tracking error (sample
  deviation of matched whole-minus-fractional daily returns) annualize with √252. Sharpe and Sortino use a
  zero hurdle; downside RMS includes all dates. Max drawdown is positive peak-to-trough loss, and Calmar
  divides CAGR by that loss. Undefined ratios and correlations are `null`.
