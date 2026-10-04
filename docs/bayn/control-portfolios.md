# Full-session development control portfolios

`services/bayn/tools/control-study.ts` evaluates deterministic controls over complete retained sessions. Each
portfolio owns cash, inventory, execution fees, daily turnover, exit triggers, and completed position episodes.
It evaluates opportunities from its own position state, including periods when the original Jev replay held a
position. It never synthesizes Jev responses or supplies production trading authority.

This command produces development evidence. It does not satisfy the frozen
[Jev acceptance protocol](jev-migration-acceptance-v2.json). Management must be selected explicitly: `MECHANICAL`
removes model decisions, while `JEV` gives each repeated control its own native Jev management. The retained close
control always uses its original close lifecycle. The full acceptance experiment still needs frozen control
definitions, calibrated timing and execution assumptions, and untouched prospective sessions.

## Fixed policies

| Policy                       | Entry selection                                                                                      | Size                                  | Exit                                                        |
| ---------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------- | ----------------------------------------------------------- |
| `RETAINED_BREAKOUT_CLOSE`    | Retained six-symbol breakout thresholds                                                              | 10% of bounded allocation             | Close window                                                |
| `REPEATED_BREAKOUT`          | Retained breakout thresholds across Jev's candidate universe                                         | Explicit research weight, at most 20% | 15-minute maximum hold, 50 bp protective stop, close window |
| `REPEATED_RELATIVE_MOMENTUM` | Exact positive 30-minute and benchmark-relative return, with the native spread and liquidity filters | Same research weight                  | Same mechanical management                                  |

The table describes the mechanical lifecycles. In `JEV` mode, native model exits are also available to the two
repeated controls. Existing exit triggers, protective stops, maximum holding time and the close window take
precedence over a new inference. Each management request contains the control's own actual simulated fill quantity,
cost basis, fees, entry time and current market evidence. Candidate strategy decisions are never reused as control
management decisions. Entry and management track completed windows independently; partial exit retries preserve
the original model trigger and require no new inference.

The source-controlled Jev protocol supplies the universe, rolling window, freshness rules, close window, and
mechanical holding limits. Breakout policies call the retained decision core, including its breakout-strength and
range-position tie-breaks. Relative momentum ranks by exact benchmark-relative return, then symbol. Candidate-local
source exclusions are retained. A successful observation consumes that signal window, so a canceled entry waits
for fresh evidence from a later window.

Polls stay on a fixed schedule anchored to session open. Decision and routing latency consume time without shifting
that schedule. If work lasts beyond a scheduled poll, the portfolio resumes at the first scheduled poll at or after
completion. It evaluates the latest eligible window at that time; it never rewinds the source or reconstructs a
missed decision with later information. This research schedule does not reproduce the native controller's durable
scheduling machinery.

The retained control reproduces its selection and successful-entry close lifecycle. This lightweight runner does
not reproduce the historical strategy's persistence, reconciliation, authority, retry machinery, or market-close
fallback. Use the native execution engine to verify those behaviors.

## Frozen residual-shock falsification candidate

Input `bayn.control-study-input.v4` explicitly adds `SPY_RELATIVE_SHOCK_REBOUND_60S_V1` to the three legacy controls.
It requires `management: "MECHANICAL"`, `repeatedTargetWeightPpm: 200000`, a declared `turnoverPolicy`, and
`falsificationCandidate: "SPY_RELATIVE_SHOCK_REBOUND_60S_V1"`. The existing backtest input must use the native
30,000 ms polling cadence. Decision latency, routing delay, execution assumptions, data allocation and turnover
policy remain explicit, hash-bound scenario inputs; freeze them before any outcome and never choose a favorable
scenario afterward. The v4 definition is `bayn.control-study-definition.v6`. Legacy v2/v3 policy sets, definitions
and run identities are unchanged.

The candidate definition in `services/bayn/src/intraday-replay/residual-shock.ts` has canonical SHA-256
`76afb9108e06eaacb0231bbfc6a1dc00861451f2677cc8b99aee263691af68d6`. It is a bounded falsification hypothesis,
not a fitted model or an assertion of positive expected net returns. It does not activate or register a production
strategy. No provider calls, data acquisition, raw exporter or new evaluation engine are introduced.

### Frozen signal and lifecycle

- Use the 30 chronological, contiguous, point-in-time verified IEX minute closes for each candidate and SPY.
  The existing source publication and candidate-exclusion policy remains binding. Never impute a missing minute,
  substitute SIP, or use a revision unavailable at the observation cut.
- For each of the 29 adjacent pairs, compute simple return in basis points as
  `10000 * (current close / previous close - 1)`. Residual is stock return minus SPY return with coefficient one.
  This is SPY-relative, not an estimated beta-neutral return. Prices use the existing native micro-dollar conversion;
  every subsequent operation and comparison is exact rational arithmetic.
- Compute mean and sample variance from the first 28 residual returns only, with variance denominator 27.
  The latest return never enters its own baseline. Require negative latest stock return, negative latest residual,
  negative centered residual and squared centered residual at least `95481/10000` times the sample variance.
  This is the inclusive `z <= -3.09` rule, not a calibrated empirical tail probability.
- Zero baseline variance is an ordinary no-signal. Missing or malformed required evidence is unavailable and
  remains incomplete; candidate-local source exclusions are retained separately. Candidates must pass the native
  positive-size, 10-second freshness and signal-time 5-bp spread filters. This is not a guaranteed realized spread
  ceiling: later submission and arrival quotes retain native freshness, side and limit checks, without imposing a
  new spread filter. SPY retains its required benchmark freshness/liquidity
  checks. Rank eligible candidates by squared z descending, then symbol ascending.
- Preserve the source universe of 15 candidates plus benchmark-only SPY, long-only, one position, and at most
  20% of bounded allocation. Shared cash, turnover, order and symbol limits can further reduce size.
- Evaluate each successfully observed completed-minute window once. A canceled entry consumes that window.
  The 2-second completed-bar delay and 30-second session-anchored poll schedule remain unchanged. A minute closing
  at 10:00 is ordinarily first eligible at the 10:00:30 poll, before declared decision and routing delays.
- Begin the exit at the first poll at or after the first actual partial entry fill plus 60 seconds. Close-window
  and 50-bp protective-stop triggers take precedence. The native 15-minute holding ceiling remains a fallback.
  Routing, missing quotes and partial-fill retries can extend actual holding beyond 60 or 90 seconds. A target is
  not a guaranteed execution deadline. No take-profit, learned management or same-window entry retry is added.

Selected and unselected candidate calculations are retained as rational numerators/denominators alongside the
snapshot hash. Orders, fills, quote hashes, partial fills, retry triggers, missing observations and session marks
use the existing report. Episode net includes quote-side execution and fees; session net additionally deducts the
explicit data allocation. The existing stress adds 10 bp per filled dollar of turnover, roughly 20 bp for a
round trip, on top of quote-side spread and modeled execution costs.

### Evidence and stopping limits

The motivating [one-minute crash/rebound research](https://d-nb.info/1255615907/34) does not validate this
SPY-relative, 28-return standardized, long-only IEX adaptation. Native polling may miss the early rebound and the
additional round-trip cost stress is substantial. Implementation tests establish software behavior only.

The existing exposed opening-RVOL observations and all other inspected historical sessions remain development
data, never untouched holdout. Archive reconstruction and REST receipts marked `NOT_OBSERVED` cannot prove
original observation availability or complete prospective opportunities. Sparse retained decision snapshots do
not supply missing periods while a prior strategy held a position.

Before a qualified future experiment, independently freeze candidate/input/source-code identity and scenario
hashes; obtain original availability receipts and complete full-session IEX source cuts for all 15 candidates plus
SPY; retain no-signal, excluded, missing and zero-trade opportunities; and calibrate timing, quote-size interpretation
and costs. Acquisition/export readiness is a separate prerequisite. No current data or future collection date is
promised by this code. Preserve negative, incomplete and failed runs. Any later parameter change is a new hypothesis
requiring a new version and untouched data, not a retry of this frozen one.

A later prospective registration should fix its calendar block of 60 consecutive exchange sessions in advance,
including zero-opportunity and missing-data days. A 100-episode floor is only a coverage requirement, not sufficient
statistical evidence. Do not replace incomplete days or extend the block until a result becomes significant.
The primary economic estimand is daily strategy net including zero-trade days, failures and all applicable costs;
unknown outcomes stay unknown rather than being assigned zero. Freeze the tested hypotheses, endpoints, dependence
model and inference method before outcomes. Too few independent event-days or unresolved receipt completeness,
costs or cross-day dependence leaves the result inconclusive. The motivating paper's regression coefficients are
not realizable returns from this candidate. This change implements no statistical acceptance engine.

## Execution and accounting

The command validates the native replay input, calendar, assets, frozen source manifest, and independent source
receipt. It reads the entire source chronologically in a separate scoped pass for each policy. A cursor cannot
move backward. Session cash carries forward; an unresolved position prevents a reset into another session.

Entry sizing uses Bayn's target-capital and order/symbol/turnover calculations. Whole shares must fit available
cash including cumulative fees at the adverse limit price. Fresh decision and arrival quotes feed the shared IOC
execution core. The shared ledger accounts for actual fills and fees. Partial entry fills create one position;
partial exits keep the original exit trigger and retry the remaining shares. Only a flat-to-position-to-flat
interval counts as a completed episode. Risk-reducing exits remain possible after the daily turnover cap.

Each portfolio tracks consumed liquidity by quote identity, symbol, and side. Retrying against the same quote can
fill only its remaining whole-share budget after the declared availability fraction. A later quote supplies a new
budget. Native replay applies the same per-quote consumption rule. Counterfactual portfolios have independent budgets.

The declared `decisionLatencyMs` covers the research scenario's full construction, evaluation, and persistence
delay. Routing delay comes from the native replay assumptions and is added separately. The command does not
measure full runtime latency. A scenario value cannot be presented as observed p95 latency. Jev management measures
provider and simulation-journal work against an independent clock. Its elapsed time advances the market source,
and expired responses cannot authorize model exits. This measures the offline persistence implementation, not the
production PostgreSQL/controller path; the frozen comparison still requires common calibrated timing assumptions.
The management pass advances its deadline clock without reading historical source records. After measurement ends,
the source and equity marks catch up to that clock, including on failure. Replay parsing time never becomes model
latency or changes the management deadline.

Every session retains opening, closing, and one-minute marked equity at a fresh bid with positive displayed size.
It also marks each poll, decision completion, and the portfolio before and after each order outcome. Every valid
mark records broker equity and net equity after cumulative external expenses separately. Broker equity and its
carried peak govern entry risk checks. Intermediate broker peaks remain binding after the position closes and
carry into later sessions. Net equity and its own carried peak determine reported drawdown and session loss.
A zero-size bid produces a missing mark even if liquidity returns and the position closes later. Positive displayed
size does not prove that the full position could be liquidated at that price. Missing observations,
execution quotes, or marks make the session `INCOMPLETE`. Canceled IOC orders remain recorded. Unclosed positions
retain a null realized result. Mechanical controls have zero model calls and charges. In `JEV` mode, known usage
is priced with the frozen native replay tariff, including usable billing evidence from failed or late responses.
Unresolved usage makes the session incomplete and leaves `modelCostMicros` null; `knownModelCostMicros` and
`netPnlAfterKnownCostsMicros` retain only the known charges. Allocated data costs
are charged once per policy per session, including zero-trade sessions. As in native replay, these external expenses
reduce reported net equity; they never debit broker cash, shrink position sizes, or consume broker loss limits.
Each policy carries broker cash, its broker and net equity peaks, and cumulative external expenses independently.
A session's net result deducts only that session's expense, without charging prior expenses again. Reports also subtract an additional 10 bp
from each filled dollar of turnover as a cost stress.

The report uses `bayn.control-study-report.v3` and definition `bayn.control-study-definition.v5` for legacy inputs
or `bayn.control-study-definition.v6` for the opted-in falsification candidate. Marks expose
`brokerEquityMicros` and `netEquityAfterKnownCostsMicros`; `closingCapital` contains the carried state. Previous v1
reports charged external expenses to broker cash and are not comparable at nonzero allocated data cost. Retain
their original evidence and generate a new report with the corrected executable when comparing net performance.

Jev mode requires a new evidence directory. Its registration binds the input, source receipt, policy definitions
and risk policy before inference. Each policy has separate source observations, native batches, request claims,
terminal receipts and resolutions, and provider call records. Files are flushed before a request can proceed or a
response can be used. A pending request cannot trigger another provider call; a late receipt cannot reverse an
abandoned request. Reusing an existing directory is rejected, including after interruption. Preserve an interrupted
attempt and its unknown charges; this command does not resume it. These simulation records do not satisfy or weaken
the production stores' authority, reconciliation and order-source checks.

Displayed quote sizes retain their source units. Those units and market impact still need independent calibration.
A completed development replay does not prove executable capacity or live profitability.

## Run

Create an input with the following shape. `backtest` is the complete existing `bayn.backtest.v3` document, including
its source receipt bindings and native build/strategy identity. It identifies the source experiment; it does not
claim that controls made Jev calls or executed the production interpreter.

```json
{
  "schemaVersion": "bayn.control-study-input.v2",
  "management": "MECHANICAL",
  "backtest": {},
  "decisionLatencyMs": 1000,
  "repeatedTargetWeightPpm": 100000
}
```

The empty object above is a placeholder for the validated native document. Freeze candidate weights and timing
scenarios before viewing their outcomes. Preserve negative and incomplete results.

```sh
bun services/bayn/tools/control-study.ts \
  --input /absolute/path/control-input.json \
  --input-sha256 <sha256-of-input-bytes> \
  --arrivals /absolute/path/arrivals.ndjson.gz \
  --source-receipt /absolute/path/source-receipt.json \
  --source-receipt-sha256 <sha256-of-receipt-bytes> \
  --output /absolute/path/new-report.json
```

The command refuses duplicate or incomplete flags, hash mismatches, and an existing output file. Keep the exact
executable Git commit, input hashes, command, exit status, and report hash in the experiment receipt. A report
records the source and policy definitions but does not independently prove which Git commit executed the command.

For a separately registered managed study, set `management` to `JEV`, bind `BAYN_JEV_API_KEY` through the existing
secret path, and add `--evidence-directory /absolute/path/new-evidence-directory`. That mode makes paid provider
calls. It fails when the key or evidence directory is missing; it never silently switches to mechanical management.
