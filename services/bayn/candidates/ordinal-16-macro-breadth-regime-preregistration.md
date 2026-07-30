# Bayn Candidate 16 preregistration: macro-breadth regime rotation

## Immutable attempt binding

- Candidate ordinal: `16`.
- Prior consumed trial count: `15`.
- Candidate-development protocol: the exact source-controlled protocol on base commit
  `edc45bf0c588b8fbcbcc4a81fee5483db2ad2187`.
- Development calendar: the frozen 1,762 official sessions from `2016-01-04` through `2022-12-30`.
- Holdout: `2023-01-03` through `2025-12-31`; it must not be queried, loaded, summarized, or inspected during this
  attempt.
- Snapshot: `2a91f0177684f7022f746207333e510c8268f9b77a04b778a04220a33ccf79e0`.
- Exactly one metric-bearing development execution is permitted. A process failure before development bars are loaded
  does not consume the attempt. Once bars are loaded, no rerun, retune, reseed, threshold change, family substitution,
  or implementation repair is permitted.

## Materially distinct hypothesis

Candidate 16 is a fixed three-state macro-breadth regime classifier, not a trend-weighted portfolio, relative-strength
ranking, minimum-variance optimizer, volatility target, seasonal rule, volume rule, range-volatility rule, 52-week-high
rule, residual-momentum rule, intraday-return ranker, or stock-bond-correlation classifier.

The economic hypothesis is that broad risk-asset participation identifies a durable growth regime, while disagreement
between commodity and Treasury trends distinguishes inflationary from deflationary defensive regimes. The strategy
therefore uses market breadth only to select the risk-on state and uses a fixed commodity-versus-Treasury comparison
only after breadth has failed. It never ranks all assets or tunes allocations from realized performance.

## Frozen data and universe

- Universe: `DBC,EFA,IEF,SPY,VNQ`, sorted exactly as written.
- Required adjusted fields: open, high, low, close, and volume from `signal.adjusted_daily_bars_v2`.
- Every official session must contain exactly one valid bar for every universe symbol.
- Adjusted prices must be finite and strictly positive. Volume must be finite and strictly positive.
- Missing bars, duplicates, unexpected symbols, non-finite values, wrong bounds, wrong session count, wrong calendar
  identity, wrong snapshot, or wrong content hashes fail closed.
- No imputation, interpolation, forward fill, alternate provider, later publication, holdout row, or intraday data is
  permitted.

## Frozen schedule and causality

- Signal sessions: every official month-end session from the frozen calendar.
- Execution sessions: the immediately following official session.
- Feature lookback: `126` finalized sessions, with `127` adjusted closes including the signal close.
- The first eligible signal is the first official month-end with 126 prior close-to-close returns.
- Every decision may use only bars through its finalized signal-session close.
- Orders execute at the next official session open under the existing Bayn execution model.
- The final governed signal is the official `2022-11-30` month-end and its `2022-12-01` next-session execution is a
  mandatory all-cash liquidation. Every path remains in cash through `2022-12-30`.

## Frozen feature construction

For each eligible month-end signal session:

1. Compute 126-session simple total return for each of `SPY`, `EFA`, and `VNQ` from adjusted closes.
2. A risk sleeve is positive only when its total return is strictly greater than zero.
3. `positiveRiskSleeves` is the integer count of positive returns across `SPY`, `EFA`, and `VNQ`.
4. Compute 126-session simple total return for `DBC` and `IEF` from adjusted closes.
5. Round every total return to 12 decimal places before classification.

No mean, volatility, covariance, correlation, ranking score, optimization, price level, volume statistic, or future bar
may affect the state.

## Frozen state classifier

- `GROWTH`: `positiveRiskSleeves >= 2` and `SPY` total return is strictly positive.
- `INFLATION_DEFENSE`: growth is false and `DBC` total return is strictly greater than `IEF` total return.
- `DEFLATION_DEFENSE`: every other case, including an exact `DBC`/`IEF` return tie.

## Frozen allocation

- `GROWTH`: `0.95 SPY`, `0.05 cash`.
- `INFLATION_DEFENSE`: `0.95 DBC`, `0.05 cash`.
- `DEFLATION_DEFENSE`: `0.95 IEF`, `0.05 cash`.
- All non-selected symbols have exact target weight zero.
- Gross exposure is exactly `0.95` before terminal liquidation.
- Long-only, unlevered, maximum one non-cash position.
- No volatility scaling, risk parity, position cap adjustment, turnover suppression, stop, trailing rule, or discretionary
  override is permitted.

## Frozen benchmark and gates

- Buy-and-hold benchmark: 100% `SPY` from the selected observation-window start through terminal liquidation.
- Direct-volatility benchmark: the existing Bayn direct-volatility timing rule applied to `SPY`, with no candidate
  feature input.
- Selected benchmark: exactly the stronger benchmark under the source-controlled cash-adjusted Sharpe rule.
- All bootstrap annualized-return differences, Sharpe differences, and walk-forward return differences must be computed
  against that selected benchmark, never against cash.
- The official candidate-development power, bootstrap, Bonferroni, walk-forward, drawdown, and selected-benchmark gates
  are unchanged.

## Frozen doubled-cost contract

- Baseline execution costs use multiplier `1x`.
- Stress execution costs use multiplier `2x`.
- The stress path replays the exact baseline signal decisions and exact ordered requested and filled quantity path.
- Cash, fees, fill prices, cost basis, marked equity, returns, and drawdown are recomputed causally under `2x` costs.
- Any changed signal, changed requested or filled quantity, changed execution model, negative cash, or incomplete terminal
  liquidation is `INVALID_PROTOCOL_DEVIATION`, not a valid rejection.

## Frozen selection and outcome rule

- Exactly one specification exists; no parameter grid or candidate-family selection occurs.
- `PASS` requires every source-controlled candidate-development comparison gate to pass and the conforming `2x` fixed-
  quantity path to have positive annualized return and terminal cash.
- Otherwise the valid result is `HOLD_REJECT` unless a protocol invariant fails, in which case it is
  `INVALID_PROTOCOL_DEVIATION`.
- A `PASS` authorizes only the next normal qualification boundary. It does not authorize holdout access, broker
  mutation, order submission, capital authority, runtime selection, or deployment.

## Mutation boundary

This attempt may read only the frozen development calendar and development bars. It must not write PostgreSQL,
TigerBeetle, ClickHouse, broker state, capital grants, runtime configuration, GitOps manifests, Kubernetes resources,
or orders. The only durable writes before evaluation are the Git commits that bind this preregistration and the exact
evaluated implementation.
