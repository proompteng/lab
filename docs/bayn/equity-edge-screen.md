# Retrospective equity edge screen

`services/bayn/tools/equity-edge-screen.ts` is an offline development command. It compares thirteen fixed long-only
bar-based policies without constructing a broker client, using a model, changing a mandate, or touching the live
controller. It does not replace the original-arrival and execution witnesses required by the
[matched-entry experiment](matched-entry-study.md) or [portfolio controls](control-portfolios.md).

Build the offline command with `bun run --filter @proompteng/bayn build:research`, then run
`bun run --filter @proompteng/bayn equity:screen` with the arguments shown below. `--help` needs no configuration.
Use an independent research process with bounded private storage. The command has no broker, database or model dependency.

## Frozen hypotheses

The source definition retains six late-session candidates: positive benchmark-relative momentum, opening-range
breakout with above-average opening volume, and a VWAP recovery, each with 15- and 60-minute holds. These start
after thirty completed minutes. They are not replications of a five-minute opening strategy.

Three additional candidates test volatility-sized residual reversals with 15-/60-minute holds and a volatility-sized
60-minute late opening-range strategy. Four early opening-range candidates combine 15-/60-minute holds with fixed
or volatility risk. The early family admits at most one position per session, during minutes 5–30, following an
opening-high breakout with above-average opening volume, a bullish opening candle, and a nonnegative benchmark.
Opening volume is compared only with the fourteen prior calendar sessions. Missing required minutes exclude that
candidate; they are not imputed from later bars or another feed.

The complete definitions and thirteen policy identities are included in the report. Development selects a policy
only when its modeled execution P&L is positive. Validation and holdout never change that choice. Every candidate,
not only the selected one, is retained under base and stressed costs. Zero-activity sessions remain in the denominator.
These mechanisms do not prove that a caller preserved an untouched holdout or registered a candidate prospectively.
Record trial history and any prior inspection of the dates independently.

Required benchmark windows, the selected candidate's arrival price and every held-position minute must be present.
A gap in any of these stops the path as `INCOMPLETE`, with null full-period P&L. Partial earlier sessions are retained
for diagnosis but cannot participate in selection. Candidate-specific signal gaps alone permit exclusion. An empty
benchmark stream is not a completed cash-only strategy, and an unknown stop interval is not a successful hold.
Every candidate-specific missing signal/opening/history window records its symbol, decision time, first missing
minute when known, reason and zero target weight, even if another candidate is selected at that decision.

## Input and execution

The command accepts a pinned historical raw page stream: one `calendar` header with the broker's native exchange
calendar; consecutively numbered `bars` envelopes containing V2 bars and their continuation tokens; and one
`complete` envelope with the feed, adjustment, page count, row count, and acquisition time. It verifies the exact
UTF-8 source hash, progressive pagination, unique symbol/minute keys, finite OHLC values, symbol scope, and ordered
regular-session hours. It reports minute coverage for every symbol/session. Calendar `open`/`close` are interpreted
in New York; Bayn's separate extended data-session normalization is not used for this regular-session screen.
Each symbol's source timestamps must be strictly ascending within and across pages. The decoder rejects ordering
regressions rather than normalizing malformed source evidence into a sorted map.

Every bars envelope requires `requestPageToken`: `null` for page zero, then exactly the preceding response's
`next_page_token`. The acquisition process records the token actually sent before following each continuation.
Missing tokens, spliced chains, repeated tokens, and impossible calendar timestamps are rejected even after rehashing.
Earlier captures without request-token evidence remain superseded diagnostics; do not infer those tokens from
responses or retrofit them into old captures. Acquire and pin new source bytes instead.

The strict input is `bayn.equity-edge-screen-input.v2` with `sourceSha256`, `symbols` including benchmark-only SPY,
and `development`, `validation`, and `holdout` objects, each containing ISO `start` and `end` dates. Partition
endpoints must be retained exchange sessions, periods must be chronological and disjoint, and at least fourteen
earlier calendar sessions must be available. Keep input, raw data, reports, and registrations on private research
storage outside Git and CI artifacts.

The required `calendar` object supplies `start`, `end`, and `expectedHash`: the canonical hash of the complete
native `MarketCalendarResponseSchema` decoded inventory from an independently retained calendar read. Pin this
inventory before evaluating source; deriving the pin only from the source being checked cannot establish completeness.
The header must retain its actual calendar request URL with those exact bounds. An omitted interior day, changed
hours, or a narrower request is rejected against the independent inventory. The page's actual request URL must
bind the same range, symbols, feed, `1Min`, raw adjustment, ascending order, page size 10000, end-date symbol mapping,
and actual continuation token. Unknown or duplicate query parameters and out-of-range bars fail. The current
request origins are the existing PAPER calendar API and market-data API. Version 1 inputs without these bindings
are rejected. This pin still requires independent source review; it is not cryptographic proof of provider authenticity.

The optional `feed` is `iex` by default or explicitly `sip` for historical consolidated-data research. The completion
receipt must match that pinned feed. Historical SIP access does not establish real-time entitlement, the native live
feed, or prospective executability. No missing IEX minute is filled from SIP; a separately acquired and pinned SIP
corpus is a distinct retrospective sensitivity study, not a repair to an original IEX observation.

```sh
bun services/bayn/tools/equity-edge-screen.ts \
  --input /private/input.json --input-sha256 <independently-pinned-input-sha256> \
  --source /private/iex-bars-pages.ndjson --output /private/new-report.json
```

The source limit is 128 MiB and the input limit is 1 MiB. The command uses a separate research process, not an API
or execution-worker pod. It refuses an existing output path and writes reports with mode 0600. Preserve source
receipts and every rejected or superseded trial. Hashes bind bytes, not source authenticity or observed arrival time.

Each partition starts with $100,000 and carries capital between its sessions. Positions are serial, long-only,
whole-share, and limited to 20% of current equity. Fixed risk uses a 50 bp stop. Volatility risk uses twice the
completed-window minute-return volatility scaled to the holding horizon, bounded to 50–200 bp, and limits modeled
stop exposure to 0.1% of equity by reducing size. It does not guarantee that gap or execution losses fit that budget.

Signals use completed bars only; quantity is fixed from the signal close with an adverse-price reserve, before the
next-minute arrival. A cheaper arrival cannot increase order size. An arrival exceeding its reserved allocation is
rejected rather than resized with future prices. Base/stress prices apply 10/20 bp adverse execution on each side
plus the native current fee model. Price rounding and fees use integer micro-USD accounting after scenario pricing.
The report includes the fee-model hash. This is a cost scenario, not a reconstruction of historical broker tariffs.
Fee charges are the delta of the native cumulative session-by-fee-type total. Rejected hypothetical entries do not
consume the fee state; every accepted simulated order contributes one fill, retaining per-order TAF caps. Independent
per-fill cent rounding is not substituted for the native session aggregation. VWAP must also lie inside each bar's
reported low/high before evaluation, and missing opening/history evidence is recorded before return-based filters.
Definition v6 searches the maximum affordable whole-share order including its cumulative session fee delta;
low-priced instruments are not omitted just because fees exceed one share's value.

Protective stops react to a completed bar, then use the next available opening price within three minutes. Losses
through a stop are not clipped to the stop. A missing exit leaves an incomplete path, never a fabricated flat mark.
All positions are scheduled to close five minutes before regular close. The screen uses its stated daily loss and
turnover boundaries, but is not the live strategy or a reproduction of every native mandate rule.

## Interpretation

Report v3 retains base development paths in `development` and the corresponding 20 bp-per-side paths in
`developmentStress`, in the same policy order. Selection and `developmentReportHash` continue to use only the base
development paths. Later results retain their existing paired base/stress structure. Stress diagnostics do not
retune or replace the frozen base-cost selector.

`executionNetPnlMicros` is scenario P&L, not actual fills or all-in profit. The command always returns `qualified=false`
and `allInProfit=null`. An apparently positive candidate earns only native execution and prospective validation.
Missing original arrivals, quotes, spread histories, depth, IOC/limit-fill behavior, partial fills, market impact,
and infrastructure/data/inference cost allocations prevent profitability qualification. A contemporary fixed universe
also carries historical selection and survivor bias. Do not sum independently reset partitions into a single account.

The first internal prototype incorrectly sized at the later opening price. Definition v2 fixes this with a regression
where a favorable future price must not increase shares. Definition v3 also invalidates paths with missing benchmark,
entry-pricing or held-position bars; merely counting such gaps was insufficient. Earlier internal reports are superseded and retained; dates
already inspected through that prototype cannot be relabeled as a newly untouched holdout after the correction.
No tested screen result authorizes a live strategy, holding-period change, risk change, or capital promotion.
