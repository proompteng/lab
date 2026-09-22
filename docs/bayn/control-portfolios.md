# Full-session development control portfolios

`services/bayn/tools/control-study.ts` evaluates deterministic controls over complete retained sessions. Each
portfolio owns cash, inventory, execution fees, daily turnover, exit triggers, and completed position episodes.
It evaluates opportunities from its own position state, including periods when the original Jev replay held a
position. It never synthesizes Jev responses or supplies production trading authority.

This command produces development evidence. It does not satisfy the frozen
[Jev acceptance protocol](jev-migration-acceptance-v2.json). In particular, mechanical exits in these controls
are not matched to the deployed candidate's model-driven management. The full acceptance experiment still needs
registered controls with common management, verified execution assumptions, and untouched prospective sessions.

## Fixed policies

| Policy                       | Entry selection                                                                                      | Size                                  | Exit                                                        |
| ---------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------- | ----------------------------------------------------------- |
| `RETAINED_BREAKOUT_CLOSE`    | Retained six-symbol breakout thresholds                                                              | 10% of bounded allocation             | Close window                                                |
| `REPEATED_BREAKOUT`          | Retained breakout thresholds across Jev's candidate universe                                         | Explicit research weight, at most 20% | 15-minute maximum hold, 50 bp protective stop, close window |
| `REPEATED_RELATIVE_MOMENTUM` | Exact positive 30-minute and benchmark-relative return, with the native spread and liquidity filters | Same research weight                  | Same mechanical management                                  |

The source-controlled Jev protocol supplies the universe, rolling window, freshness rules, close window, and
mechanical holding limits. Breakout policies call the retained decision core, including its breakout-strength and
range-position tie-breaks. Relative momentum ranks by exact benchmark-relative return, then symbol. Candidate-local
source exclusions are retained. A successful observation consumes that signal window, so a canceled entry waits
for fresh evidence from a later window.

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

The declared `decisionLatencyMs` covers the research scenario's full construction, evaluation, and persistence
delay. Routing delay comes from the native replay assumptions and is added separately. The command does not
measure full runtime latency. A scenario value cannot be presented as observed p95 latency.

Every session retains opening, closing, and one-minute marked equity at executable bid. Missing observations,
execution quotes, or marks make the session `INCOMPLETE`. Canceled IOC orders remain recorded. Unclosed positions
retain a null realized result. Model charges are zero because controls make no model calls. Allocated data costs
are charged once per policy per session, including zero-trade sessions. Reports also subtract an additional 10 bp
from each filled dollar of turnover as a cost stress.

Displayed quote sizes retain their source units. Those units and market impact still need independent calibration.
A completed development replay does not prove executable capacity or live profitability.

## Run

Create an input with the following shape. `backtest` is the complete existing `bayn.backtest.v3` document, including
its source receipt bindings and native build/strategy identity. It identifies the source experiment; it does not
claim that controls made Jev calls or executed the production interpreter.

```json
{
  "schemaVersion": "bayn.control-study-input.v1",
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
