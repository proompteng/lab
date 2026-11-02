# Crypto entry research and deadline recovery

## Findings

The October 17 investigation found two distinct obstacles: a runtime deadline failure stopped execution, and the
tested entry hypotheses did not establish positive returns after the account's actual fees. Fixing the deadline
failure does not establish a profitable strategy.

At 18:31 UTC, the deployed source was `6f71ad98c23938797ed80bc1653bd0cd1b7d6d51`, protocol v9. The controller
continued polling, but effective authority was OBSERVE with an active execution-loop restriction. Its latest
decision batch was at 13:42:47 UTC. Actual broker and native accounting readback at 18:31 found 127 retained
fills, flat inventory, exact reconciliation and verified TigerBeetle transfers. These were historical fills; no
new profitable v9 BTC/ETH/SOL round trip was demonstrated.

The 19 retained earlier-release crypto round trips lost $197.251644 on price movement and incurred $1,182.554501
in final broker fees, for $1,379.806145 net trading loss before operating costs. Two earlier ETH round trips were
net winners; they do not establish current-release profitability. A separate hindsight check read US quotes for the
first 15 minutes of every actual entry. Eighteen windows had quotes within ten seconds of both boundaries and no
interquote gap above ten seconds. In 15 of those windows, including all five BTC entries, even the largest observed
bid failed to cover the actual acquisition cost, received-coin deduction and cent-rounded 25 bp sell fee. One SOL
entry had a positive perfect-timing bound but actually lost. This optimistic check assumes a full exit at the best
observed bid, ignores depth, impact and operating costs, and leaves prices between quotes unobserved. It diagnoses
entry economics; it supplies no causal trading signal or achievable-profit claim.

Loki retained the actual failure at 13:43:59 UTC. The outer generation deadline interrupted a reconciliation while
PostgreSQL was committing. The preceding pass spent 15.4 seconds in reconciliation; the failed pass spent 25.7
seconds there, with its current commit already taking 4.2 seconds. These stage durations overlap and must not be
summed. Cancellation completed about 1.1 seconds after the deadline. The reported error became the generic
`run-cycle-pass` timeout, which permanently restricted the generation. The interrupted preflight had not entered
cycle execution.

The recovery driver now retains that distinction through both deadline owners. A preflight timeout remains a
reconciliation failure, invalidates its cadence and requires a new reconciliation. The pass cannot produce a
decision or order. The marker clears before any cycle advance; subsequent execution timeouts retain the existing
authority restriction. Deadline, quote freshness, broker-state freshness, writer fencing, intent recovery,
accounting and order-risk limits are unchanged. A deterministic regression makes the generation deadline win
one millisecond before the inner deadline, verifies cancellation and fresh retry, and independently verifies
that a timeout after preflight still restricts authority.

The same-account provider and native archive contained identical trade IDs and nanosecond timestamps during the
17:30–18:30 UTC interval: BTC 15, ETH 4 and SOL 6 market-data prints. This rules out a dropped-print explanation
for that interval. Prints are not broker fills. Current database replication was streaming with approximately
7 milliseconds flush lag at 18:37 UTC; that later measurement does not explain or erase the earlier commit stall.
No storage settings or durability guarantees were changed.

The first deadline repair reached the live controller at 19:09 UTC, but the full authority verifier still failed.
The restricted generation already contained terminal, zero-target `NO_TRADE` decisions from before the timeout.
Settlement accepted a new terminal cycle after restriction or a generation without any decisions, excluding this
legitimate intermediate case. The PostgreSQL regression reproduced that deadlock. Recovery now recognizes earlier
zero-target cycles only when every generation-bound decision matches the terminal account, plan, strategy, protocol,
cycle, snapshot and submission deadline, with no generation intents or active cycles. Planned targets, mismatched
bindings and non-dispatchable decisions cannot authorize that recovery. Fresh exact flat reconciliation and native OBSERVE-to-PAPER activation still apply.
Recovery also applies the normal decision-creation bounds: at or after cycle creation and submission open, and at or
before the durable cycle update. Regression cases cover every mismatched binding and each temporal bound both before
and after restriction.

## What the primary research supports

| Source | Relevant result | Consequence for Bayn |
| --- | --- | --- |
| [Liu and Tsyvinski, Risks and Returns of Cryptocurrency](https://www.nber.org/papers/w24877) | Finds crypto-specific momentum and attention predictability. | A broad momentum result does not validate a 15-minute Alpaca spot trade with Bayn's stop and fees. |
| [Short-horizon mean reversion, August 2026 preprint](https://arxiv.org/html/2608.21888v1) | Finds statistically measurable 15-minute reversal, but about 1.3 bp gross edge at its most selective against a 5 bp cheapest benchmark cost. The paper discloses survivor-universe and mechanism-identification limits. | Directional predictability can be real while economically unusable. Bayn's observed costs are substantially higher. This is counterevidence for generic short-term reversal, not a proof that every conditional strategy fails. |
| [Machine Learning-Based Bitcoin Trading Under Transaction Costs, 2026 preprint](https://arxiv.org/html/2606.00060v1) | A cost-aware threshold sharply reduces turnover on hourly BTC/USDT. The main configuration assumes 10 bp per position change; drawdowns remain severe, and bootstrap comparisons do not establish Sharpe superiority over buy-and-hold. | Test cost-aware abstention and turnover explicitly. Do not import its return, hourly holding policy, synthetic gap bars or drawdowns into Bayn's different contract. |
| [Rise of the Machines?, 2020 preprint](https://arxiv.org/pdf/2009.04200) | Studies five-minute intraday patterns in a two-month 2018 sample from European sources. | A historical seasonality observation is a hypothesis, not current USD-venue executable alpha or net profitability evidence. |
| [No arbitrage and lead-lag relationships](https://arxiv.org/abs/1712.09854) | Shows that lead-lag dependence can coexist with no arbitrage under transaction costs or waiting constraints. | A leading benchmark does not by itself make catch-up trades profitable. |
| [Bailey et al., The Probability of Backtest Overfitting](https://www.davidhbailey.com/dhbpapers/backtest-prob.pdf) | Formalizes selection bias across strategy trials. | Preserve unsuccessful trials and independent temporal evaluation. No Bayn PBO estimate is claimed without running it on an adequate experiment. |
| [Leakage-safe, search-aware LLM strategy discovery, August 2026 preprint](https://arxiv.org/html/2608.27734v1) | Separates leakage controls from statistical selection corrections; its planted leaking strategy survives statistical deflation. | Audit accessible timestamps and individual execution labels independently. Statistical confidence cannot repair look-ahead. This paper's equity results are not crypto profitability evidence. |

[Alpaca's crypto contract](https://docs.alpaca.markets/us/docs/crypto-trading) specifies fees in the credited asset,
cash buying power, no shorting, and continuous trading. Its published tier table is not evidence that this PAPER
account receives a lower tier. The account's actual retained evidence supports 25 bp coin buy fees and 25 bp
cent-rounded USD sell fees. Those are the research assumptions. A maker order is not assigned a lower fee without
actual attributable evidence. [PAPER simulation](https://docs.alpaca.markets/us/docs/paper-trading) also cannot prove
live queue position, market impact or scalable capacity.

## Additional registered mechanism experiment

After the corrected earlier development screens, a new experiment froze three mechanisms before scoring their
outcomes. All use source-valid own trades, fresh two-sided quotes, completed BTC/ETH benchmark bars, the same
account limits, 50 bp stop and 15-minute maximum hold. They replace momentum eligibility only inside research;
none was installed as an executable fallback.

1. Benchmark catch-up: benchmark common-window return at least 100 bp, candidate excess return at most minus
   100 bp, and a completed recovery minute of at least 5 bp.
2. Washout recovery: 15-minute candidate decline at least 100 bp, completed recovery at least 5 bp, quote at or
   above that completed close and in the lower half of its observed 30-minute range.
3. Confirmed breakout: five-minute candidate rise at least 100 bp, completed recovery at least 5 bp, completed
   close and quote at or above the preceding 30-minute high, and a positive benchmark return.

Each mechanism was tested with a quote-anchored LIMIT/IOC entry and two exits: the existing maximum hold or
earlier 25 bp fee-net profit capture, both preserving the stop. The six variants use a training-only per-asset
mean with a New York day-block bootstrap lower bound, requiring at least 32 known training fills and ten distinct
training days before forecasting an entry. Portfolio replay preserves one position, 20% allocation, $40,000 order
cap, $1 million daily turnover and the existing $5,000 loss/drawdown bounds.

The causal source produced 255 distinct observations. Catch-up had 77/6/5 BTC/ETH/SOL observations, washout
16/28/65, and breakout 14/12/35; a row can satisfy more than one mechanism. Every per-asset variant lacked the
registered independent training support. No variant qualified, no profitable forecast was established, and no
final holdout outcomes were scored. This is insufficient evidence, not an estimated zero return or proof that the
mechanisms can never work. Repeated development use is explicitly adaptive.

The financial kernel was previously checked against native integer quantity, coin-fee, cash-fee and closing-price
calculations. Historical provider event time still substitutes for original arrival evidence. Hypothetical
quote-crossing full PAPER fills do not establish exact controller timing, partial fills, recovery or operating
costs. Any future survivor needs independent native lifecycle validation, untouched temporal evaluation, reviewed
single-path deployment and actual broker/accounting evidence. Inference, data, infrastructure and research costs
remain unknown where attribution is unavailable.

## Extended historical screen

A second adaptive experiment froze completed-bar versions of those three mechanisms and a fixed 15-minute signal
cooldown before enumerating their outcomes. The cooldown starts on the signal, including when subsequent quote,
trade or fill evidence is unavailable. It cannot select a replacement event using later outcomes. Training spans
October 1, 2025 through June 1, 2026; development spans June 1 through August 17, 2026. A 45-minute partition purge
and the complete 15-minute, 11-second label embargo separate observations from later outcomes.

Complete same-venue source pagination produced 1,103,426 in-range raw bars, 373,606 trades and 3,545,852 quotes.
The causal source checks retained 624 observations across the three assets and mechanisms. Both exits were tested
again, making six extended variants. None qualified. Training cases with sufficient independent support had negative
hypothetical net returns: BTC catch-up averaged minus 163.21 bp over 78 known fills on 42 days, ETH washout minus
114.07 bp over 59 fills on 32 days, and ETH breakout minus 107.12 bp over 42 fills on 30 days. Their day-block
bootstrap lower bounds were also negative. Earlier profit capture did not yield a positive supported forecast.
An abstaining portfolio has zero submissions; that is not a profitable strategy.

All 577 new financial cases matched the actual native pricing, received-coin fee, cash-fee and inventory-basis
functions. This differential validates those integer calculations, not the complete hypothetical lifecycle.
Historical event time remains an arrival proxy, archived bars may include revisions, submission timing and
stop polling remain approximations, and partial fills and recovery are not fully simulated. Unknown deadline
quotes remain unknown. The original October 6–14 final holdout remains unscored. No failed research variant was
deployed, and the extended sample does not replace the missing frozen five-session Jev study.

## Remaining acceptance

Recover the execution loop through the normal reviewed main, immutable image, automatic Kargo and Argo path.
Verify natural current-source decisions and exact broker/ledger reconciliation after rollout. Profitable
BTC/ETH/SOL PAPER round trips remain unproven. The fixed next regular equity-open acceptance is October 19,
2026 at 09:30 America/New_York; Saturday readiness cannot establish that future fill. The original frozen
five-session Jev study remains blocked on its unrecovered registered source and arrival receipts.
