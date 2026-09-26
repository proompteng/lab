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

The report uses `bayn.control-study-report.v3` and definition `bayn.control-study-definition.v3`. Marks expose
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
