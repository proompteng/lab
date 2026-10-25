# Full-session development control portfolios

`bayn-control-study` evaluates native Jev entry and deterministic controls over complete retained sessions. Each
portfolio owns cash, inventory, execution fees, daily turnover, exit triggers, and completed position episodes.
It evaluates opportunities from its own position state, including periods when the original Jev replay held a
position. It never synthesizes Jev responses or supplies production trading authority.

Build the offline commands with `bun run --filter @proompteng/bayn build:research`, then run
`node services/bayn/dist/research/control-study-command.js` with the same flags. The published Bayn image also
contains `bayn-control-study`.
`--help` requires no credentials. `--mode preflight` verifies the supplied source and writes coverage diagnostics
without requesting model evaluations. An incomplete preflight writes its diagnostic and exits unsuccessfully.
Installing the command does not schedule a capture, run a study, or qualify the input.

This command produces development evidence. It does not satisfy the frozen
[Jev acceptance protocol](jev-migration-acceptance-v2.json). `entry: "JEV"` adds an independent native entry
portfolio with mechanical exits. `entry: "DETERMINISTIC"` retains deterministic entries. Only
`management: "MECHANICAL"` is executable. The retired research model-management path is removed. The independent
control profile does not qualify strategy-derived prices or the broker-held protection lifecycle. Acceptance
still needs frozen definitions, calibrated execution assumptions and untouched prospective sessions.

Controls require a complete regular broker session inside the replay interval. The broker calendar's `open` and
`close` fields define that session, including early closes. Wider `session_open` and `session_close` bounds describe
provider hours; the separate data window does not replace regular trading hours. Keep the original calendar and
source unchanged. Preparation retains the complete reviewed Jev protocol for native observation and journal
validation. The separate equity market profile selects source symbols; it cannot replace protocol fields or add
market metadata to the serialized native protocol. Preparation rejects an interval with no complete regular
session before any model dispatch.

## Offline input preflight

Run the command with `--mode preflight` and the same pinned input, arrivals and source receipt before an economic
study. It writes `bayn.control-input-preflight.v1` to the new `--output` path without selecting signals, constructing
a portfolio, computing returns, calling Jev or opening a broker or database connection. This also works for a `JEV`
study input without an API key. Do not supply `--evidence-directory` in preflight mode.

The checker uses one source cursor across sessions and retains the source reader's whole-file verification and
replay checks. It uses the control runner's entry query and native snapshot constructor for every session-anchored
entry-eligible poll across the complete candidate universe. It
does not skip a repeated minute window after a successful observation or model a held position. Warmup and cutoff
polls remain in the denominator. Per-session counts distinguish unavailable snapshots from candidate-local
exclusions, and retain the first native failure message and observation time for each failure reason.

`COMPLETE` requires at least one eligible poll per session and no missing snapshot or candidate exclusion.
`INCOMPLETE` and `NO_ELIGIBLE_POLLS` write the diagnostic report and then exit nonzero. A malformed or corrupt source
fails before a report is written, including corruption after the last inspected poll. Output files are never
overwritten. This is a strict input-coverage screen, not a replacement for production candidate-local admission.
An available benchmark with every candidate excluded cannot pass it. Partial coverage is not a zero-return result.

The original source receipt is retained unchanged. A complete screen does not establish original stream
availability, prospective completeness, executable liquidity, calibrated latency, costs or profitability. Keep the
input and diagnostic output private, outside Git and CI artifacts. Omitting `--mode`, or using `--mode study`, retains
the registered study behavior. The sole development input contract is v9. Preflight never starts that study
automatically.

## Fixed policies

| Policy                       | Entry selection                                                                                                            | Size                                   | Exit                                                                                            |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `RETAINED_BREAKOUT_CLOSE`    | Retained six-symbol breakout thresholds                                                                                    | 10% of bounded allocation              | Close window                                                                                    |
| `REPEATED_BREAKOUT`          | Retained breakout thresholds across Jev's candidate universe                                                               | Explicit research weight, at most 20%  | 15-minute maximum hold, 50 bp protective stop, 100 bp estimated net-profit target, close window |
| `REPEATED_JEV_ENTRY`         | Native observation, model batch, entry probability gate and decision against this portfolio                                | Native allocation, matched to momentum | Same mechanical exits                                                                           |
| `REPEATED_RELATIVE_MOMENTUM` | Positive return from the earliest common observed candidate and benchmark minute, with native spread and liquidity filters | Same research weight                   | Same mechanical management                                                                      |

The table describes the mechanical lifecycles. Jev selects entries and does not manage held positions in this
comparison. Each portfolio retains its own simulated fills, cash, fees and inventory. Existing exit triggers,
protective stops, net-profit targets, maximum holding time and the close window take precedence over another entry.
Partial exit retries preserve the original mechanical trigger and require no new inference.

Every policy starts polling after the first completed session minute and the native two-second delay. The protocol's
30-minute lookback bounds the available context; it does not require 30 bars or delay admission by 30 minutes.
Preflight and training artifact schedules use the same first eligible poll.

The source-controlled Jev protocol supplies the universe, history limit, freshness rules, close window, and
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

Input `bayn.control-study-input.v9` adds `SPY_RELATIVE_SHOCK_REBOUND_60S_V1` when explicitly selected through
`falsificationCandidate`. It requires deterministic entry, mechanical management, `repeatedTargetWeightPpm: 200000`,
a declared `turnoverPolicy`, and native 30,000 ms polling. Freeze timing, execution and data-cost scenarios before
any outcome. It cannot be combined with the Jev entry or Ridge experiments.

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
- Begin the exit at the first poll at or after the first actual partial entry fill plus 60 seconds. Close-window, 50-bp protective-stop and 100-bp estimated net-profit triggers take precedence. The native 15-minute holding ceiling remains a fallback.
  Routing, missing quotes and partial-fill retries can extend actual holding beyond 60 or 90 seconds. A target is
  not a guaranteed execution deadline. The shared net-profit target applies; learned management and same-window entry retry remain absent.

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
measure full runtime latency. A scenario value cannot be presented as observed p95 latency. Native Jev entry
measures provider and simulation-journal work against an independent clock before order pricing. This offline journal
does not establish production PostgreSQL/controller latency. Cancellation retains elapsed cleanup time and can leave
an uncertain durable prefix; preserve the interrupted directory and start a new registered experiment. Never resume
it or infer successful persistence from the existence of a file.

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

### Scheduled opportunity accounting

Input v8 always includes opportunity accounting. Current reports use `bayn.control-study-report.v6` and definition
`bayn.control-study-definition.v12`. Older development input contracts are rejected; preserve old reports as historical
artifacts. The optional Ridge and residual-shock experiments retain their frozen mathematical definitions.

Each session adds `simulatedOpportunityAccounting`. Its denominator is every session-open anchored poll strictly
before session close, including zero-trade and incomplete sessions. `scheduledPollCount` is the ceiling of session
duration divided by the integer poll interval. An internal contiguous-ordinal check rejects gaps, overlaps and
out-of-range accounting, and requires `accountedPollCount` to equal the scheduled count at completion.
The fixed-size summary does not retain a new row or snapshot for each poll.

Every scheduled poll has exactly one disposition. The existing post-management entry branch determines the reason:

- `EXITING` and `HOLDING` take precedence while the portfolio owns inventory
- A flat portfolio records `WARMUP`, then `ENTRY_CUTOFF`, then `WINDOW_ALREADY_CONSUMED` when applicable
- A new entry observation records `INPUT_UNAVAILABLE`, `SELECTION_UNAVAILABLE`, `NO_SIGNAL` or `SELECTED`
- Scheduled ticks passed during decision, management or routing work record `SKIPPED_WHILE_BUSY`. They are never
  classified as observed no-signal ticks, and the engine does not execute them

`SELECTED` describes the entry selection. Later expiry, missing prices, risk blocks and execution outcomes remain
in the existing decisions and orders. Available entry snapshots with candidate exclusions have separate,
non-additive counts. The existing decision exclusions retain their details; excluded inputs do not become evidence
that every candidate had no signal. All disposition counts sum to `scheduledPollCount`, which also equals
`engineStartedPollCount` plus `SKIPPED_WHILE_BUSY`.

This summary proves coverage of the simulated engine schedule. It does not prove delivery to a production controller.
`capturedControllerStarts` and `capturedControllerTerminals` remain null because this report has no such evidence.
Missing financial outcomes retain their existing null values. These simulated counters are separate from the native capture sampler and do not establish production controller coverage.

Marks expose `brokerEquityMicros` and `netEquityAfterKnownCostsMicros`; `closingCapital` carries broker cash and
external expenses separately. Older reports that charged external costs to broker cash are not comparable at nonzero
allocated data cost. Retain their evidence and run a new experiment with the current executable.

### Independent native Jev entry

Set `entry: "JEV"` and `management: "MECHANICAL"` to add `REPEATED_JEV_ENTRY` beside the deterministic controls.
Its allocation must equal the bound protocol's native maximum gross/symbol allocation and the repeated momentum
weight. Each policy starts with the same capital and owns a separate ledger, liquidity consumption and source cursor.
This permits different opportunity timing while another policy is holding; responses are never borrowed from an
original account or another control. Native model entry does not combine with Ridge or residual shock in this input.

Each flat Jev portfolio constructs a native reconciled observation from its own cash and accounting hash, evaluates
its own batch, applies `decideJevEntry`, and fsyncs its decision before pricing. The measured provider and journal clock
consume scheduled opportunities. `decisionLatencyMs` applies only to deterministic controls; it is not added again
to model work. Entry abstentions retain paid calls. Failed, expired or interrupted model work remains unavailable;
an interrupted journal cannot be reused and the experiment remains incomplete. Mechanical stops, net-profit targets, maximum hold,
partial fills, exit retries and close deadlines use the existing portfolio engine.

The report retains `entryMode`, native batch/observation/decision hashes and commitment time in each decision.
Model costs include entry calls even when no trade is selected. A new evidence directory is required for either
native entry or native management. Preflight still makes no model call. Native entry and management are separate
ablations; this contract requires mechanical exits for the entry comparison.

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

Create an input with the following shape. `backtest` is the complete existing `bayn.backtest.v5` document, including
its source receipt bindings and native build/strategy identity. It identifies the source experiment; it does not
claim that controls made Jev calls or executed the production interpreter.

```json
{
  "schemaVersion": "bayn.control-study-input.v9",
  "costObjective": "ALL_COSTS",
  "entry": "DETERMINISTIC",
  "turnoverPolicy": "ENTRY_AND_EXPECTED_EXIT",
  "management": "MECHANICAL",
  "backtest": {},
  "decisionLatencyMs": 1000,
  "repeatedTargetWeightPpm": 100000
}
```

The empty object above is a placeholder for the validated native document. Freeze candidate weights and timing
scenarios before viewing their outcomes. Preserve negative and incomplete results.

```sh
node services/bayn/dist/research/control-study-command.js \
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
