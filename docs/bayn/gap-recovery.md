# Gap-recovery decision replay

`bayn-gap-recovery` evaluates the fixed long-only gap-recovery rule over two
original-receipt replay sources. It is packaged in the Bayn image but is not the
active strategy. It does not call a model or broker, submit orders, acquire
credentials, configure capture, or grant capital authority.

The prior-close reference is the retained midquote thirty seconds before the
preceding broker session closes. The opening reference is thirty seconds after
the current session opens. The decision is thirty minutes and thirty seconds
after that open. These are quote proxies, not official auction prices. The
supplied chronological broker calendar determines session boundaries, including
shortened sessions and daylight-saving changes; its exact hash must match.

Entry requires a positive SPY opening return, a candidate overnight gap of at
most minus fifty basis points, an opening recovery of at least twenty-five basis
points, and a decision price still below the prior-close reference. Among
eligible candidates, the lowest SPY-relative overnight gap wins, with symbol
order breaking ties. Comparisons and ranking use exact decimal integers and
cross-products, not rounded percentages. The definition is source-controlled
in `src/intraday-replay/gap-recovery.ts`; the input has no strategy parameters.

The decision also requires the existing native six-bar evidence contract.
Original receipt availability, producer ordering, first-publication witnesses,
benchmark trade freshness, spread, and displayed-size checks remain intact.
These evidence checks are stricter than an archive-only development screen.
An archive reconstruction cannot be relabeled as an original observation to
satisfy this command.

Missing candidate endpoints or six-bar inputs are retained as exclusions.
Other eligible candidates can still produce a `SELECTED` research observation.
Missing required SPY endpoints produce `BENCHMARK_UNAVAILABLE`. A missing
possible candidate is not an observed `NO_SIGNAL`. `inputComplete` describes
only the required endpoint and feature observations, never controller coverage,
whole-feed completeness, executable capacity, or prospective profitability.
All reports retain `UNQUALIFIED`, `UNKNOWN` controller coverage, and no capital
authority, even when the command exits successfully.

## Input and command

The input uses `bayn.gap-recovery-study.v1` with `session`, `previousSource`, and
`currentSource`. The session uses `bayn.gap-recovery-session.v1`, a session date,
the retained broker calendar response, and its canonical hash. Each source uses
the existing `bayn.backtest-source.v1` manifest with `original-capture` transport.
Supply the two exact `bayn.original-capture-replay-receipt.v1` receipts and their
externally retained hashes. Obtain sources through the existing verified capture
interval export; hashes supplied alongside unverified bytes are not independent
proof of a capture.

```sh
bayn-gap-recovery \
  --input /evidence/gap-input.json --input-sha256 "$INPUT_SHA256" \
  --previous-arrivals /evidence/previous.ndjson.gz \
  --previous-receipt /evidence/previous-receipt.json \
  --previous-receipt-sha256 "$PREVIOUS_RECEIPT_SHA256" \
  --current-arrivals /evidence/current.ndjson.gz \
  --current-receipt /evidence/current-receipt.json \
  --current-receipt-sha256 "$CURRENT_RECEIPT_SHA256" \
  --output /evidence/new-gap-report.json
```

Each input or receipt file is limited to 512 KiB and hash-checked as bytes before
UTF-8 decoding. Arrival streams retain the existing replay loader's private
snapshot, full-byte verification, receipt ordering, and scoped cleanup. The
sources are opened sequentially. Large arrival streams still need a separately
budgeted research environment; the small-input limit is not a source-file or
runtime-memory limit.

The command refuses to overwrite a report. Incomplete decision inputs produce
a hashed diagnostic report and a nonzero exit code. Invalid provenance, hashes,
ordering, or source bytes fail without publishing a successful decision report.
The source-mode equivalent is `bun services/bayn/src/gap-recovery-command.ts`.

## Position lifecycle

`decideGapRecoveryExit` evaluates a supplied hypothetical position against an
original-receipt cursor. It requests an exit when the fresh bid reaches the
fifty-basis-point protective stop or five minutes remain before the session
close. A pending exit remains latched. There is no fifteen-minute hold limit.
Missing management quotes remain unavailable; a required closing exit never
invents execution pricing. The close deadline is explicit.

This helper supplies neither fills nor authorization. The command reports an
entry decision only. Native portfolio integration, one-attempt ownership,
partial fills, broker reconciliation, complete prospective observations, and
after-cost economic qualification remain separate prerequisites for activating
this rule as the trading strategy. Packaging the command does not satisfy them.
