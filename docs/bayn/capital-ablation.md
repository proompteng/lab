# Shared-capital Jev entry cost ablation

`services/bayn/tools/capital-study.ts` compares frozen native **v7 algorithm + Jev entry decisions** against the same
entries with an offline cost hurdle. Each arm owns one cash balance and one position slot across the supplied equity
and crypto sources. It reuses the existing execution simulator, capital allocation constraints, instrument precision,
fee ledger, and persistent reducing IOC exit lifecycle. It never calls inference or broker APIs and cannot select a
live strategy, change risk configuration, grant capital authority, or place orders.

This fills the gap after the [matched-entry label study](matched-entry-study.md): overlapping labels cannot be summed
into portfolio dollars. The new evaluator admits or blocks them chronologically, resizes later entries from the
arm's remaining cash, and retains every opportunity, including abstentions, busy capital, missing or late decisions,
cost rejections, and unfilled orders. The two ordered opportunity lists must hash identically before a report is returned.

## Question and scope

The baseline reproduces the retained native entry choice, including the native algorithm candidate screen and Jev's
chosen model action without the retired entry-probability floor. Both arms use the same five-second mechanical
protective-stop and maximum-hold exits,
quote arrivals, instrument increments and IOC rules. Equity closes retain the native session cutoff. Crypto holds
retain elapsed deadlines across UTC dates. Exit attempts continue after entry risk limits bind.

The candidate admits the native selected symbol only when:

```
projected entry notional × floor(native lookback return in bps) / 10,000
  > immediate flat-price round-trip loss + allocated inference + allocated operating expense + frozen margin
```

The left side is an **uncalibrated momentum proxy**, not expected net payoff. Jev's enter probability remains a
semantic choice probability; it is never treated as trade win probability. The round-trip estimate uses only the
fresh commitment quote and the declared scenario, including both fee legs. Insufficient immediate round-trip
capacity is an explicit candidate rejection. Unknown cost evidence is retained, never converted to a zero fee.
The candidate receives the same already-observed inference as baseline and gets no inference savings for rejecting.

This is always a `DEVELOPMENT_SCENARIO`, even if its upstream registration says prospective. Frozen responses are not
regenerated for counterfactual cash or account context. This evaluates entry admission with common mechanical exits,
not native Jev position management. Retained flat-entry observations are endogenous to the original strategy;
missing opportunities while it held inventory remain unknown. It cannot establish a full-market trade frequency,
calibrated edge, held-out performance, or profitability.

## Private input

`CapitalStudyInputSchema` in `src/intraday-replay/capital-study.ts` defines `bayn.capital-study-input.v1`:

- `evaluatorSourceRevision`: the clean executing Git commit, checked before reading and again before writing results.
- `sources`: one or two disjoint market groups. Each contains `matched` (`MatchedStudyInputSchema`), `registration`
  (`MatchedRegistrationSchema`), `arrivalsPath`, `receiptPath`, and independently pinned `receiptSha256`.
- `capital`: `openingCashMicros`, frozen `policy` (`bayn.execution-risk-policy.v3`), explicit `instruments`,
  `costHurdleMarginBps`, and one to sixteen uniquely named `scenarios`.
- Each scenario pins `id`, `latencyMs`, `slippageBps`, `availableLiquidityPpm`, and `feeMultiplierPpm`.

Each market group passes the existing matched-study inventory, source reproduction, original witness byte hashes,
committed native decision, cost allocation and timing checks before comparison. The current unmodified Jev v7
protocol hash and account must match every opportunity; retired protocol evidence and changed current parameters fail.
Protocol and input-definition report metadata derive from that same native definition. The native crypto source
profile binds its shared raw channel topic and separate feature topic to three partitions each; generic topic
aliasing and spoofed crypto identities remain invalid. Distinct
market calendars and archives feed one combined event clock and one shared portfolio per arm/scenario. Source
universes must be disjoint. A commitment beyond source coverage still has an accounting/opportunity row and no
fabricated execution. Every cursor is consumed and verified in full, including records after the last order.

Inventory completeness remains strict: do not trim a native account export to fit a market group. If a supplied
per-market inventory omits other market batches, its inherited completeness failure withholds the headline delta.
A self-consistent hash does not establish that an export or allocation is complete; independent review still must.

Capital is a declared scenario: flat opening inventory, no open broker orders or external cash flows, and initially
zero New York daily turnover. Supply the relevant reviewed risk envelope explicitly. Sizing uses reviewed capital weights and
shared cash/order/symbol/gross/net limits, with an entry plus expected-exit turnover reserve. Daily turnover, daily
loss and peak drawdown guards use the existing New York accounting date. Missing held-price marks prevent later
entries from claiming complete risk evidence. These inputs do not reconstruct an actual live account history.

The existing crypto fee schedule is a research assumption, including coin-debit buys, cash-debit sells, and conservative
rounding. A multiplier of 1,000,000 means that schedule, not a verified account fee tier. Use additional scenarios for
higher fees, adverse slippage, reduced displayed capacity and routing delays. Unknown tariffs and incomplete call
allocations remain unknown. Retain rejected, late and no-trade call spending in the existing witnessed allocations.

## Run and inspect

Keep inputs, witness files, archives and reports private, outside Git and CI artifacts. From the clean reviewed checkout:

```sh
bun services/bayn/tools/capital-study.ts \
  --input /private/capital-input.json --input-sha256 <pinned-input-sha256> \
  --output /private/new-capital-report.json
```

The output must be a new file. No credentials, network access, paid data, production recorder changes or external
telemetry uploads are required. The report binds evaluator revision, registered source revisions, input/definition/
protocol hashes, upstream matched reports and capture receipts. Freeze the complete input before comparison;
changing a cost hurdle after looking at results is development iteration, not a held-out test.

Inspect each arm's ledger, opportunity statuses, requested and actual entry quantities, partial exits, canceled IOC
orders, consumed quote hashes and residual positions. Metrics include net execution dollars, net dollars after
inference and all supplied costs, known expense subtotals, unknown allocations, filled entries, entry-order fill rate,
admitted opportunity fraction, partial entries, turnover, closed episodes and sampled drawdown. Throughput uses
**elapsed hours between source bounds**, including any uncovered gaps, and cannot imply whole-market coverage.

Fees book once through the replay ledger. Bid/ask spread and slippage are already embedded in fills; neither is
subtracted again. Cost-hurdle estimates never book as expenses. Inference and operating allocations charge every
retained opportunity in both arms and remain separate from broker cash. Net-after-cost metrics are null when their
inputs are unknown. The candidate-minus-baseline headline is null unless every upstream matched study is complete
and both simulated portfolios and cost allocations resolve. Per-arm diagnostics remain inspectable when the
upstream evidence is incomplete; those diagnostics are not an economic acceptance result.

Drawdown uses fresh marked bids at event/poll times and known allocated expenses. It excludes an additional
hypothetical liquidation fee, cannot observe between polls, and is withheld as a complete metric when marks,
execution or expenses are unresolved. Missing marks count unique timestamps, so pre/post valuation of one event
cannot duplicate the evidence gap. An incomplete valuation path also withholds the headline net-dollar comparison,
even if both portfolios later close and their terminal cash P&L is known. Historical consumed data remains development evidence. Passing the tests or
producing a positive scenario delta never authorizes trading or deployment.

## Deterministic accounting result

The native BTC fixture with flat $100 bid / $100.02 ask, $100,000 opening cash, reviewed capital weights and the declared
base fee schedule closes one episode with $39,946.010798 turnover, $99.870001 execution fees, and **-$103.870202**
after $0.01 inference and $0.001 operating allocation. Doubling the fee multiplier yields **-$203.480204** after the
same allocations. Both metrics are asserted in the regression. These are synthetic zero-edge accounting checks,
not historical returns, evidence of a better candidate, or a verified account fee tier. No private dataset is bundled.
