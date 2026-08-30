# Torghut Research Validation And Promotion Design

Status: Proposed normative research and capital-promotion contract.

Source baseline: `9f6487ada0cf9222b65cbb1ee9b10d50a09b216e`.

Observed evidence: [current audit snapshot](current-audit-snapshot-2026-07-14.md).

System boundary: [adversarial profitability system design](adversarial-profitability-system-design.md).

## Purpose

This document defines how Torghut may discover, reject, validate, promote, size, monitor, and demote trading strategies.
It is intentionally stricter than a backtest-ranking workflow because selection, data, execution, accounting, capacity,
and live behavior can each erase an apparent edge.

The contract applies to US-equity strategy research first. Hyperliquid remains a separate testnet research system with
its own evidence, accounting, and capital authority.

## Objective Function

The system optimizes sustainable after-cost return under explicit risk and capacity constraints:

```text
net PnL
= filled notional
 x (gross alpha - spread - fees - slippage - impact - borrow/interest/tax)
 / 10,000
```

```text
capacity-adjusted net expectancy (bps)
= 10,000 x broker-reconciled net PnL / filled notional
```

```text
target-implied daily notional
= dollar target x 10,000 / conservative net-expectancy lower bound (bps)
```

The primary optimization is the lower confidence bound of capacity-adjusted net expectancy subject to portfolio
drawdown, expected shortfall, concentration, liquidity, operational, and reconciliation constraints. Dollar PnL is a
derived business result, not a shortcut around those constraints.

### `$500/day` Is A Capacity Hypothesis

The current repository target is useful for feasibility analysis but must not be reported as an expected return. At
the audit-time equity it implied about `1.21%` NAV per active day. At `$300,000` daily filled notional it requires
`16.67` net basis points before uncertainty. The best tiny historical row in the audit had `16.42 bps` on eight closed
trades, leaving no statistical, cost, impact, or capacity margin.

The target passes only if:

- broker-reconciled net-expectancy lower bounds remain positive at target-implied notional;
- nonlinear impact, participation, queue, missed-fill, borrow, concentration, and margin constraints allow that
  notional;
- return and loss expressed as `%NAV`, drawdown, and expected shortfall remain within approved budgets;
- paper and micro-live results remain inside the replay predictive envelope.

Otherwise the target is infeasible at the current capital, strategy, or capacity and must not be reached by increasing
leverage.

## Metric Dictionary

### North-Star Outcomes

| Metric                                   | Definition                                                                                           | Decision use                          |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------- |
| Broker-reconciled net PnL per active day | Realized plus marked unrealized strategy PnL less actual economic costs; exclude external cash flows | Business outcome and capital increase |
| Net return on cash-flow-adjusted NAV     | Broker-reconciled net PnL divided by NAV adjusted for deposits/withdrawals                           | Cross-capital comparability           |
| Capacity-adjusted net expectancy         | Net PnL in bps of filled notional at the tested participation                                        | Candidate comparison and sizing       |
| Drawdown                                 | Cash-flow-adjusted peak-to-trough NAV and sleeve equity                                              | Hard stop and demotion                |
| Expected shortfall                       | Mean loss beyond the approved portfolio tail quantile                                                | Tail-risk budget                      |

No single metric authorizes capital. The decision uses the joint statistical, economic, risk, data, and operational
contract.

### Evidence And Integrity Guardrails

| Metric                         | Exact contract                                                                         | Required state                                  |
| ------------------------------ | -------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Broker reconciliation coverage | Settled mandatory economic events reconciled / settled mandatory events                | `100%`, unexplained settled delta `0`           |
| Mutation lifecycle coverage    | Decision -> authority -> claim -> receipt -> broker event -> execution -> fill linkage | `100%`, duplicate economic intents `0`          |
| Point-in-time feature coverage | Causally available family-required field x symbol x session cells / required cells     | `100%`; fallback explicitly allowed and bounded |
| Cursor continuity              | Monotonic provider/Kafka/database positions with duplicate/gap accounting              | Gaps `0` or repaired before evidence use        |
| Cost-lineage coverage          | Fills with actual fee/cost identity, model digest, filled notional, and source lineage | `100%` for promoted evidence                    |
| Closed-round-trip coverage     | Attributed exits and open inventory explain every fill                                 | `100%`                                          |
| Envelope parity                | Replay/shadow/paper/live rows with identical envelope digest                           | `100%`                                          |
| Independent-ledger parity      | Canonical and independent reducers matching broker positions, cash, equity and PnL     | Exact within currency/rounding contract         |

### Research Diagnostics

- active and positive day ratios;
- profit factor and payoff ratio;
- hit rate with trade count and confidence interval;
- mean, median, p10, worst-day, best-day-share, and serial dependence of daily net PnL;
- Sharpe, Sortino, Calmar, drawdown duration, expected shortfall, skew, and tail concentration;
- deflated Sharpe probability, probability of backtest overfitting, White Reality Check, and Hansen SPA;
- performance by regime, volatility, liquidity, symbol, sector, time of day, weekday, long/short side, and market trend;
- turnover, holding period, side flips, fill rate, rejection rate, cancel rate, and unfilled opportunity cost;
- implementation shortfall, spread capture, fees, impact, and 1s/10s/60s markouts;
- sensitivity to delay, depth, queue depletion, participation, borrow, and cost shocks;
- contribution to portfolio return, drawdown, expected shortfall, factors, and correlated clusters.

Each metric declares formula, unit, grain, time window, denominator, source, material exclusions, and whether it is a
gate, diagnostic, or business target.

## Research Data Contract

### Point-In-Time Requirements

Every research row must prove what was available at the decision timestamp. Store separately:

- exchange/provider event time;
- provider publication/source time;
- Torghut ingest time;
- feature availability time;
- decision time;
- order-arrival and broker-event time.

Reject negative feature age, future timestamps, late corrections treated as contemporaneous knowledge, or corporate
actions unavailable at the historical decision time.

### Dataset Receipt

Every frozen dataset includes:

- dataset ID and content digest;
- source/feed identity and entitlement class;
- symbol universe and membership history;
- exchange calendar, timezone, session, and bar/event construction rules;
- raw/adjusted prices and corporate-action version;
- delisting, symbol-change, split, dividend, borrow, shortability, and survivor handling;
- field schema, unit, null, stale, duplicate, outlier, and repair policy;
- event/source/ingest time coverage;
- cursor/offset bounds and gap report;
- source retention reference and expiry.

For US equities, preserve whether the source is SIP or IEX. Alpaca describes SIP as consolidated US-exchange data and
IEX as a single-exchange feed in its [market-data FAQ](https://docs.alpaca.markets/us/docs/market-data-faq). Feed
identity is part of the model, not incidental metadata.

### Feature Receipt

Every candidate declares family-required fields. The receipt records coverage, freshness, source lineage, fallback,
proxy, and transformation by field x symbol x session. Required-field absence invalidates the run. Optional features
may fall back only when the family contract specifies the fallback and the research contains an explicit ablation.

No feature may be considered available merely because its name exists in the schema.

## Hypothesis And Trial Registry

Before evaluation, register:

- falsifiable economic hypothesis and expected mechanism;
- target universe, horizon, side, rebalance frequency, and capacity expectation;
- required data and features;
- baseline and negative-control strategies;
- primary metric and risk/capacity guardrails;
- train, validation, walk-forward, embargo, and untouched OOS plan;
- allowed parameter search space and maximum trial budget;
- expected failure modes and rejection conditions.

Every attempted variant is append-only, including parse failures, zero-trade runs, discarded candidates, retries, and
operator overrides. Record candidate/spec ID, parent, code/config/data/policy/envelope digests, random seed, parameters,
start/end time, status, metrics, blockers, and artifact references.

A discarded candidate cannot set run-level `objective_met`. A run stops only when a retained candidate or portfolio
passes the full configured gate and is eligible for the next authority stage.

## Evaluation Protocol

### Stage 1: Causal Sanity And Baselines

Before tuning:

- validate timestamp ordering, adjustment, universe, and feature receipts;
- compare against flat, long-only/market, random-entry, time-shifted, sign-flipped, and simple linear/rule baselines;
- run shuffled-label/block-permutation placebos that preserve relevant dependence;
- require the known-bad and future-leaking canaries to fail.

### Stage 2: Purged Walk-Forward Selection

Use chronological walk-forward folds with purge and embargo sized to the label horizon and holding period. Parameter
selection occurs inside each training window; validation and test windows cannot feed feature, parameter, universe, or
stopping decisions backward.

Use enough folds and observations to cover the intended regimes. The proposed initial policy requires at least five
walk-forward folds, but the final count is a versioned function of data horizon, dependence, and strategy frequency.

### Stage 3: Multiple-Testing Control

Naive best Sharpe is not a gate. The trial registry supplies the search count and dependence needed for:

- Deflated Sharpe Ratio, following Bailey and Lopez de Prado's
  [selection-aware Sharpe framework](https://www.davidhbailey.com/dhbpapers/deflated-sharpe.pdf);
- White's [Reality Check](https://onlinelibrary.wiley.com/doi/10.1111/1468-0262.00152);
- Hansen's [Superior Predictive Ability test](https://www.tandfonline.com/doi/abs/10.1198/073500105000000063);
- probability-of-backtest-overfitting diagnostics and Sharpe/profit haircuts informed by
  [Harvey and Liu's backtesting work](https://people.duke.edu/~charvey/backtesting/).

Provisional research defaults are:

- Deflated Sharpe probability at least `0.95`;
- probability of backtest overfitting at most `0.10`;
- White Reality Check or Hansen SPA `p <= 0.05` for the declared trial family.

These are policy defaults, not universal constants. Calibrate bootstrap/block length, dependence, trial family, and
sample sufficiency before implementation. Failure keeps the candidate research-only.

### Stage 4: Untouched Out-Of-Sample Release

Evaluate one frozen candidate/portfolio once on the untouched OOS interval after selection is complete. Opening the OOS
result consumes it. Further changes require a new future OOS interval and a new evidence epoch.

### Stage 5: Economic And Capacity Stress

Recompute from exact order/fill mechanics under:

- actual broker fees and observed spread/slippage distributions;
- `2x` observed variable-cost stress as an initial minimum;
- nonlinear impact and multiple participation rates;
- latency, delay, stale quote, queue position/depletion, partial fill, cancel, and missed-fill opportunity cost;
- shortability, borrow, buying power, cash reserve, rounding, and market-session rules;
- order-type and passive/marketable ablations;
- concentration, correlation, factor, and portfolio stress;
- block/bootstrap uncertainty around the after-cost estimate.

The net-expectancy `95%` lower bound must remain positive at the target-implied notional. The capacity curve must show
where marginal after-cost PnL turns nonpositive; that point caps capital even if account buying power is larger.

### Stage 6: Runtime Parity

Run the same code/config/data/policy/execution envelope through deterministic warm reruns, live shadow, paper, and
micro-live. Any digest mismatch or unexplained decision/fill difference invalidates the comparison.

## Execution And TCA Methodology

Every fill records:

- strategy decision and arrival price;
- bid, ask, mid, spread, quote age, and available depth at the decision;
- order route/type/time in force, limit, attempt, latency, participation, and queue assumptions;
- fill price, quantity, partial-fill sequence, fees, modeled/actual costs, and cancellation result;
- side-adjusted implementation shortfall;
- 1s, 10s, and 60s post-fill markouts;
- predicted p50/p95 shortfall and realized calibration error;
- missed-fill counterfactual/opportunity cost when an order does not execute.

TCA compares complete policies, not individual favorable fills. The initial experiment keeps the current conservative
one-attempt policy as control and evaluates bounded passive/aggressive schedules only after prediction coverage is
complete. Optimize net implementation shortfall plus missed opportunity, not fill rate.

Execution models follow the principle used by LEAN's
[reality-modeling contracts](https://www.quantconnect.com/docs/v2/writing-algorithms/reality-modeling/key-concepts):
fills, slippage, fees, buying power, and capacity are explicit versioned inputs. Torghut may implement those contracts
itself; adopting a framework is not required.

For larger orders, calibrate the risk/impact tradeoff rather than assuming linear cost, consistent with the
[Almgren-Chriss execution framework](https://www.smallake.kr/wp-content/uploads/2016/03/optliq.pdf). Queue/depth models
must be fitted to source-backed live observations before they can influence capital.

## Portfolio Construction And Risk

Candidate promotion and portfolio allocation are separate decisions. A statistically valid sleeve may receive zero
capital when it duplicates existing risk.

The allocator uses:

- volatility targeting with explicit estimation horizon and bounds;
- robust/shrunk covariance and factor exposure estimates;
- gross, net, beta, sector, factor, symbol, cluster, and correlated-sleeve limits;
- expected shortfall, drawdown, stress loss, and liquidity-adjusted risk;
- pending and unknown broker mutations plus reserved multi-leg exposure;
- turnover, borrow, ADV/participation, concentration, and cash reserve;
- marginal after-cost PnL and marginal contribution to tail risk.

The current semiconductor universe is one correlated cluster until evidence supports otherwise. Diversification claims
must be measured through factor and tail co-movement, not symbol count.

Volatility management is a research hypothesis, not an automatic improvement; test it against the evidence described
by [Moreira and Muir](https://onlinelibrary.wiley.com/doi/abs/10.1111/jofi.12513). Covariance estimation may use
shrinkage approaches such as
[Ledoit-Wolf](https://econ-papers.upf.edu/en/onepaper.php?id=691), with all parameters frozen in the envelope.
Fractional Kelly is not allowed until probabilities and costs are independently calibrated, and then remains capped by
the harder portfolio constraints.

## Strategy Research Queue

### 1. Residual Pairs And Statistical Arbitrage

Priority: first controlled challenger because the audit's only small positive clean rows were `H-PAIRS-01` variants.

Required design:

- diversify beyond one semiconductor cluster after data quality is proven;
- remove market, sector, beta, and common-factor returns before relationship testing;
- test rolling relationship/cointegration stability and break detection;
- model both legs, partial fills, legging risk, borrow, targeted unwind, and capacity;
- compare against simple distance/cointegration baselines such as the original
  [pairs-trading evidence](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=141615).

The historical 1-8 trade samples are motivation only.

### 2. Intraday Cross-Sectional Continuation And Reversal

Use causal spread, volatility, liquidity, relative return, quote validity, and order-flow features to determine when the
current chip-universe signals are executable. Evaluate continuation and reversal as competing hypotheses, with
time-of-day, opening/closing auction, sector, and market-regime controls.

### 3. Time-Series Momentum

Keep TSMOM as a diversification and control sleeve rather than the lead candidate while current clean rows are
negative. Reproduce the mechanism in
[Time Series Momentum](https://pages.stern.nyu.edu/~lpederse/papers/TimeSeriesMomentum.pdf), then explicitly test the
reversal and crash behavior documented in
[Momentum Crashes](https://www.kentdaniel.net/papers/published/jfe_16.pdf). Regime filters must be selected inside the
trial protocol, not added after observing OOS losses.

### 4. Order-Flow Imbalance And Microprice

Start as execution and timing features. The empirical relationship between order-flow imbalance and price impact is
described by [Cont, Kukanov, and Stoikov](https://arxiv.org/abs/1011.6402), but Torghut must prove causal L1/L2 coverage,
latency, queue semantics, and net live benefit. Schema names or proxy features are not sufficient.

### 5. Events And Options

Defer capital research until corporate actions, news/event availability time, OPRA/options-surface quality, borrow,
multi-leg execution, and assignment/exercise accounting are production-grade. They may run zero-notional data-quality
and replay studies earlier.

### 6. ML, Foundation Models, Synthetic Data, And RL

Allowed roles:

- hypothesis and feature proposal;
- bounded candidate ranking;
- residual/nonlinear challenger against simple baselines;
- synthetic rare-event and microstructure stress generation;
- explanation and incident summarization.

Forbidden roles:

- selecting or modifying untouched OOS after viewing it;
- generating synthetic outcomes used as source-backed profit evidence;
- bypassing causal feature receipts or the trial budget;
- granting, widening, or overriding capital authority;
- submitting broker mutations outside deterministic policy.

A model artifact must beat declared simple baselines on untouched OOS and broker-calibrated costs. Interpretability,
stability, latency, calibration, and failure behavior are part of the gate.

## Strategy-Scoped Promotion Ladder

This ladder must extend the existing promotion authority rather than coexist as a permissive second authority.

| Stage                | Capital                        | Entry evidence                                                                                           | Failure action                  |
| -------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `disabled`           | None                           | Explicit containment or no authority                                                                     | Remain disabled                 |
| `quarantined`        | None                           | Any blocking or unknown legacy state                                                                     | Resolve evidence; never infer   |
| `research_only`      | `$0`                           | Pre-registered hypothesis, causal data receipt, complete trial entry                                     | Reject run or continue research |
| `replay_verified`    | `$0`                           | Purged walk-forward, multiple-testing gates, untouched OOS, positive stressed net-expectancy lower bound | Remain research-only            |
| `shadow_allowed`     | `$0`                           | Exact live source path and envelope, complete decision lineage, no broker mutation                       | Automatic demotion              |
| `paper_probation`    | Bounded paper evidence only    | Paper entry gate below; explicit expiry/notional; no real-capital or final promotion authority           | Expire or demote                |
| `paper_verified`     | Paper only                     | Probation exit: at least 20 source-backed sessions, 300 closed trades, exact ledger/TCA/reconciliation   | Extend probation or demote      |
| `micro_live_allowed` | Smallest explicit tranche      | `paper_verified`, exact paper/live digest, rollback rehearsal, fresh mutation and reconciliation proof   | Stop entries, reduce-only close |
| `capital_allowed`    | Approved sleeve budget         | Completed micro-live proof, positive live lower bound, capacity and portfolio risk pass                  | Step down automatically         |
| `scaled`             | At most one approved increment | New completed proof window at current size; marginal after-cost PnL positive                             | Return to prior tranche         |

Initial scaling increments may be capped at `25%`, but the policy must derive the actual increment from liquidity,
uncertainty, drawdown, and tail-risk evidence. It is a provisional maximum, not a right to scale.

### Paper Probation Entry Gate

Preserve the distinction already expressed by
`services/torghut/app/trading/discovery/promotion_contract.py::probation_evidence_collection_contract`: probation may
collect bounded evidence but may not set final promotion authority. Entry requires:

- `replay_verified` plus live shadow validation on the exact source, policy, code, data, and envelope identities;
- selection-adjusted untouched-OOS and stressed capacity evidence sufficient to justify the paper experiment;
- the architecture's mutation fencing, strict recovery, broker activity, dual-ledger, risk-reduction, and readiness
  entry gate;
- an explicit paper account, maximum notional/order rate, loss guardrail, expiry, candidate identity, and proof epoch;
- automatic demotion on any causal-data, policy, lineage, mutation, reconciliation, or operational blocker.

This is evidence-collection authority, not evidence that the candidate is profitable.

### Paper Verification Exit Gate

Align the exit with
`services/torghut/app/trading/discovery/promotion_contract.py::final_authority_parameter_contract`:

- at least 20 source-backed trading days;
- at least 300 closed trades;
- broker-reconciled mean/median/p10/worst-day distribution;
- best-day and symbol/strategy concentration limits;
- absolute and sleeve-equity drawdown limits;
- target-implied filled-notional evidence;
- exact policy, source, code, image, data, and envelope identity;
- complete broker event, cost, TCA, ledger, and independent-reducer parity.

The sample thresholds are operational minimums, not a guarantee of statistical power. Low-frequency strategies need a
longer window. Passing creates `paper_verified`; it does not itself grant real capital.

### Micro-Live Gate

- use the smallest broker-executable tranche inside a separately approved loss budget;
- require the same candidate, code, data rules, and execution envelope proven in paper;
- validate actual fees, spread, slippage, markouts, fill survival, opportunity cost, and reconciliation;
- inject source, accounting, risk, and performance failures and prove automatic demotion;
- keep reduce-only exits available through every injected failure;
- open a new evidence epoch for any code, policy, feature, universe, execution, or sizing change.

### Scaling Gate

Scale one tranche only after a complete live proof window at the current tranche. Require:

- after-cost lower bound and marginal PnL still positive;
- TCA prediction calibrated and within the replay/paper distribution;
- no unresolved broker, ledger, data, database, or authority incident;
- portfolio expected shortfall, drawdown, factor, cluster, and liquidity budgets passing;
- nonlinear impact and participation evidence supporting the next size;
- a rehearsed automatic return to the prior size.

## Continuous Monitoring And Demotion

Every promoted strategy is a champion with at least one simple or new challenger running at zero notional. Monitor:

- rolling broker-reconciled net expectancy and confidence interval;
- actual versus predicted TCA and markouts;
- data/feature coverage, schema, fallback, and drift;
- regime and portfolio factor exposure;
- drawdown, expected shortfall, concentration, turnover, and capacity;
- reconciliation freshness, unexplained deltas, and mutation unknowns;
- code, image, policy, data, and envelope identity.

Demote on a hard integrity failure immediately. Use versioned statistical rules for performance decay so optional
stopping cannot become another unrecorded research degree of freedom.

## Required Negative Controls

- random-entry strategy with matched turnover and holding period;
- flat/no-trade strategy;
- market/sector beta benchmark;
- time-shifted and future-leaking features that must be rejected;
- sign-flipped and label/block-permuted outcomes;
- deliberately high-turnover tiny-edge strategy that must fail after costs;
- duplicate fill, correction, bust, and cursor-gap fixtures;
- replay/live envelope mismatch;
- missing required feature and unauthorized proxy;
- stale/missing broker reconciliation;
- discarded objective-hitting candidate;
- readiness surface that claims green while its authority gate is false.

The promotion implementation itself fails validation if these controls can pass.

## Reproducibility And Reporting

Every reported result includes:

- hypothesis and trial-family identifiers;
- complete attempted-variant count;
- data, feature, code, image, policy, and envelope digests;
- train/validation/walk-forward/OOS boundaries and release count;
- gross and broker-reconciled after-cost results with formulas;
- trade/day counts, confidence intervals, selection adjustments, and failure cases;
- capacity curve, participation, impact, and liquidity assumptions;
- regime, symbol, concentration, and tail-risk slices;
- raw evidence references and exact reproduction command;
- current authority stage and explicit blockers.

Reports must distinguish observed facts, computed metrics, model estimates, policy thresholds, and recommendations. A
chart or summary produced by the same candidate pipeline cannot promote the candidate.

## Acceptance Criteria

The research and promotion design is implemented when:

- every trial, including discarded and failed variants, is preserved;
- a discarded candidate cannot complete a run;
- point-in-time poison and known-bad strategies reliably fail;
- purged walk-forward, selection-adjusted, untouched OOS, cost, and capacity gates are reproducible;
- `paper_probation` can begin without circularly requiring its future observations, and `paper_verified` contains at
  least the current 20-session/300-trade minimum plus exact broker economics;
- replay, shadow, paper, and live cite one execution-envelope digest;
- only typed, unexpired strategy authority can increase risk;
- micro-live and scale decisions use completed evidence windows and automatic rollback;
- the canonical and independent ledgers match the broker with zero unexplained settled delta;
- no AI-generated verdict, synthetic outcome, report, or local artifact can grant capital.
