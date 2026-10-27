# System assessment calculations

These pure modules define the arithmetic and evidence predicates used by the system-assessment integration. They do
not issue an account qualification, admit orders, or grant capital authority. A complete assessment must bind their
inputs to a prospective registration and verified source records.

## Economics

`cashInventoryTradingPnl` reconciles the change in cash-and-inventory equity after removing external funding and
passive cash yield. It adds back operating expenses paid from the trading account so the operating-cost report can
deduct those expenses once. `netTradingPnl` computes realized profit plus the change in unrealized profit, less
execution costs, with explicit cash-settlement rounding.

`binaryTradeEdge` represents `p * gain - (1 - p) * loss - cost` as an exact rational number of micro-USD. The break-even
probability is `(loss + cost) / (gain + loss)`. Positive edge requires the supplied probability to exceed that value;
an attractive target/stop ratio alone does not establish edge. The probability is an input assumption, not an estimate
established by this function.

`markedRisk` measures maximum drawdown and maximum loss from the opening mark on the supplied equity path. Its caller
must supply the complete, cash-flow-adjusted, cost-inclusive path and verify mark coverage. Missing session profit
propagates through `advanceQualificationEquity` instead of becoming zero.

## Reliability

`measureReliability` evaluates decision work, reconciliation, mutation handling, and recovery independently against
999/1000. A successful obligation has a correct durable completion no later than its original deadline. Scheduled
work that never starts stays in the denominator. The failure allowance is `floor(scheduled / 1000)`.

Empty classes and unfinished observation windows remain `UNDETERMINED`. Duplicate evidence, orphan completions, and
impossible timestamps fail validation. Safe failures and late recoveries count as missed service. Safety violations
are evaluated separately by the combined assessment and have no error budget.

## Realism

`measureRealism` verifies causal input availability, persistence and routing order, position ownership, fixed order
terms, fill quantity and precision, limit prices, and execution deadlines. Conservative model fills also require
verified liquidity capacity and cannot assume favorable price improvement. Repeated fills consume shared capacity.
Actual broker receipts retain their explicit evidence kind.

The function reports `VIOLATED` for contradictions and `INCOMPLETE` for absent evidence or unsupported assumptions.
The caller supplies the expected decisions and fills and a set of verified source hashes; source-cut admission must
bind those identities to the registered policy, account, generation, and window. `SUPPORTED` here does not establish
complete costs, statistical edge, or a combined qualification verdict.

## Validation

From the service directory:

```sh
bun test src/system-assessment/economics.test.ts src/system-assessment/reliability.test.ts src/system-assessment/realism.test.ts
```

The tests include arithmetic properties, positive trading profit consumed by costs, zero-trade operating losses,
missing cost evidence, absent scheduled work, independent class targets, future inputs, unsupported liquidity,
partial fills, and timing contradictions. Lean conformance and durable source joins remain separate integration gates.
