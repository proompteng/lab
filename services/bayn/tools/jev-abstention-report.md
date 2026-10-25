# Imported realized-evidence join

Run the existing CLI with `<private-cohort.json> --realized-evidence`, or call
`reportJevRealizedEvidence(input)`. Input version `bayn.jev-realized-evidence-input.v1`
contains `cycles`, including NO_TRADE, BLOCKED and ACTIVE denominator rows, not just winners or closed positions.
Every row carries source revision and authority generation; the tool never pools them or fits a calibrator.

This is **UNQUALIFIED_IMPORTED_EVIDENCE_JOIN**, not a ledger verifier. Export the original sealed decision,
its canonical strategy-decision hash, cycle-linked accounting transactions, and an existing `PositionOutcome`
with its canonical content hash. The join reproduces the sealed decision and checks cycle/account/selected-symbol,
transaction IDs, episode boundaries, counts, fill-time duration, notionals, gross result and reported net arithmetic.
It does not use cumulative forward-performance envelope totals as a cycle result.

The exporter must verify the durable cycle/intent linkage and original receipt/ledger/fee evidence separately.
The outcome canonical hash is checked; transaction content/ledger-plan hashes and the exit source hash are only
retained identifiers, not recomputed or authenticated. Source revision is declared/unverified; authority generation
must match the sealed decision when present and is declared/unverified otherwise.
Hashes establish consistency, not source authenticity. Imported fee attribution and quantity conservation are not
independently reverified here. Missing fee allocation stays unknown; imported accrued net is never settled or
fully loaded profit. Model, infrastructure and abstention costs must not be assumed zero or allocated from a
cumulative session total. This first-stage join does not produce an all-in return or calibration statistic.

Optional exit observations bind their source hash, cycle and opening transaction. They are imported observations,
not proof of target-before-stop. Target paths remain UNKNOWN/censored, including after recovery or a completed
exit; missing native market-path coverage cannot be repaired by a closed trade. BLOCKED may include executions
that stopped during recovery; those transactions remain visible, not mislabeled as no-entry. An open/partial execution without
an outcome remains UNKNOWN_OR_OPEN. The supplied denominator is retained but does not prove an independent
complete opportunity schedule. Setup/plan choice mass remains categorical, not target-hit or profit probability.

# Sealed Jev abstention diagnostics

## Optional historical fee research

The library function `reportJevAbstention(document, historicalMatchedFees)` optionally
adds historical fee provenance and hypothetical crypto fee sensitivity. The CLI and
default report are unchanged. This argument is not a policy input and never changes
live fees, admission, risk limits, model choices, or profitability qualification.

The strict input is `{ source, expectedSourceHash }`, where the hash is the canonical
SHA-256 of `source`. Source schema `bayn.historical-matched-fees.v1` requires Alpaca
sandbox scope, the exact sealed account, historical effective/observed timestamps,
`OBSERVED_PROVIDER_DEBITS_NOT_INFERRED_RATES` rounding, and nonempty `matches`.
Each match carries a distinct source-fill and provider-activity hash, symbol/side,
fill quantity atoms and notional USD micros, provider account/environment/symbol/side,
and equal provider/matched debit objects. Buy debits are `COIN` quantity atoms;
sell debits are `CASH` USD micros. Unknown fields (including asserted fee tiers),
identity mismatches, duplicate source events, inverted/future timestamps, and
unequal matches fail closed. Keep all evidence private; use synthetic test inputs.

These are caller-supplied export assertions, not authenticated provider receipts.
Hashes establish integrity only, not provider authenticity. Output always says
`historicalOnly: true`, `currentTier: UNKNOWN`, and independently verified provider
authenticity is false. Debit ratios are truncated to 0.001bps for description, not
inferred tier assignments; atom/cent rounding prevents treating ratios as exact tiers.
Historical sandbox simulation is not evidence of current live exchange fees.

Fixed 25/22/20/18bps-per-side scenarios use native received-coin and cent-rounded
sell-fee functions with the same acquisition, prices, and protocol allowances.
The 25bps scenario must reproduce sealed received-quantity atoms and the sealed
break-even bid, with a safe integer-micro roundtrip of its numeric USD field. Lower scenarios
are hypothetical, not substitutions derived from a receipt or a recommendation to
lower the configured ceiling. Incomplete input coverage, unknown fills/capacity and
operating costs remain unqualified; lower break-even prices do not prove profitable
execution. Existing plan-path and coverage reports are not recalculated or upgraded.

From `services/bayn`, run:

```sh
bun tools/jev-abstention-report.ts /private/path/decision.json
```

The input is an existing persisted PAPER decision document containing `bindings.cycleId`
and `strategyDecision`, the same envelope used by `verify-jev-plan.ts`. The tool reads
one local file and prints JSON. It makes no model, database, broker, or network calls.
Keep input and output private: output includes source identifiers and position-sized
hypothetical profit/loss estimates. Do not commit production evidence.

The current source must reproduce the decision, including its sealed requests and
model receipts, before diagnostics are emitted. Unsupported historical contracts or
tampered evidence fail rather than being silently reinterpreted. Protocol version
`bayn.jev.protocol.v22` is distinct from input state version
`bayn.jev-trading-signal-state.v20`; both appear in report v2.

Each requested candidate reports funded-plan count, minimum/maximum target rise from
the observed bid, minimum/maximum net reward/risk, per-plan estimated gains/losses,
holding horizon, existing entry economics and fees, bar/trade coverage, chosen setup and action,
the setup distribution and conditional plan-choice masses. The action evaluates an actual complete trade after costs; the independent setup answer must also support entry. Excluded candidates retain their exclusion reason.
Missing model answers, unavailable latest-trade age, and empty plan ranges are null,
not zero. Reported masses remain unnormalized, preserving provider rounding.

Funding establishes accounting validity, not likely target attainment. Reward/risk
uses conservative target gain divided by conservative stop loss; it is not expected
value and excludes unmodeled operating costs. Choice mass is not a calibrated profit
probability. Summed plan mass can exceed the largest individual option without
changing the provider's argmax. This report never changes selection, fees, horizons,
authority, or admission guards, and does not supply a model rationale or prove edge.

## Exact-plan quote paths

Historical protocol v16 / input v15 / entry-target v5 evidence requires the
version-pinned offline source `d285f01c1fe2c5815dbb54b44aaae3dc0ab4af2b`.
That revision reproduced the retained historical PAPER cohort with its original
native source bundle. Use a separate checkout of that exact commit for historical
reproduction, never the live deployment. Current protocol v17 / input v16 /
entry-target v6 source rejects the older envelope; do not rewrite version tags or
reinterpret old one-stage choices as new setup/conditional-plan judgments. Neither
historical observations nor this source pin grant current execution authority.
The historical pin predates the additional full bootstrap/source-identity binding
below. Its result is not a substitute for the current provenance checks. For the
retained cohort, the source-projected bootstrap and market identities were checked
separately against the original sealed manifest; they matched. Do not generalize
that one-cohort readback to other historical inputs.

```sh
bun tools/jev-abstention-report.ts /private/decision.json /private/assumptions.json /private/native-bundle.json
```

The optional two-file extension invokes `auditNativeArrivalCoverage` directly on
the original bundle bytes. It does not trust a supplied audit report, quote array,
or completeness flag. Bundle bytes must match the manifest SHA256; the validated
consumer epoch must match the sealed snapshot, the audited interval must exactly
match the declared window, and in-window projection sequences must follow the
sealed snapshot cut. Unknown assumption fields and foreign evidence fail closed.
All bootstrap fields, including every partition offset, must match after the same
source-topic projection used by `constructStreamingSnapshot`. The source universe
identities and all three sealed market topics must also match. Self-consistent
hashes and provenance bindings are not independent provider authentication.
See `native-arrival-coverage.md` for the private bundle format and bounded capture
validation. Its controller and commit-acknowledgement unknowns are retained in the
output. This is a repository-checkout tool, not a deployed trading command.

The research-only `reportJevPlanPath` function reproduces the sealed decision and
describes original quote deliveries against one explicitly declared funded plan.
It does not replace the original model choice. The assumption manifest binds the
decision hash and source-bundle SHA256, plan choice, quantity, instrument rules,
entry latency, fee stress, and observation or hypothetical first-fill clock.
Quantities must fit the sealed funded maximum and declared instrument increments.
Instrument rules are declared assumptions, not independently verified broker terms.
Fee multipliers below the existing fee basis are rejected. The multiplier is only
a declared research assumption: no fees or cash flows are calculated or applied.

An observation-anchored window is not an actual holding period. A hypothetical
first-fill anchor must follow declared entry arrival and precede request expiry;
it remains an assumption, not proof of an executable entry. Native holding time
starts at actual first fill. Original quote delivery order is preserved, including
same-millisecond sequence ordering. Quote freshness uses the sealed protocol and
the existing native replay validity predicate. Targets use the exact plan limit;
stops use the existing protective-stop predicate. The tool never substitutes the
mechanical control's fixed target/stop distances.

Every path is permanently `INCOMPLETE` and `UNQUALIFIED`, with null economic P&L.
The report includes first observed threshold crossings, quote rejection counts,
and leading, internal, and trailing delivery gaps. These are observations, not
fills, a target-before-stop execution outcome, or a win rate. Missing quotes do
not become zero returns. GTC order/controller parity, entry capacity and partial
fills, actual first-fill timing, full capture/controller completeness, and
operating-cost allocation are not established by quote crossings. Neither a
STOPPED capture nor matching durable counts proves controller completion.
