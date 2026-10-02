# Matched Jev entry experiment

`services/bayn/tools/matched-entry-study.ts` tests one frozen question: does retained Jev entry selection add value
over positive exact benchmark-relative momentum on the same observed opportunities? It runs entirely offline and
never calls a provider, places orders, changes safeguards or promotes a strategy.

The definition is TypeScript in `src/intraday-replay/matched-entry-study.ts`. It fixes five consecutive sessions,
at least twenty different selections, a USD 10,000 whole-share budget per opportunity, five-second management polls,
a 50 bp protective stop, a 15-minute maximum hold and the five-minute close window. Both rules use the original
complete batch time, identical execution assumptions and mechanical management. One IOC entry is followed by
persistent reducing exit retries; actual partial fills and consumed quote liquidity remain in the ledger.
Routing work skips crossed polls. No model management is used.

This is an opportunity-label experiment. Labels can overlap, and naturally retained flat-entry opportunities are
endogenous to the current strategy. Never sum their returns into portfolio P&L, turnover, trade frequency or
independent confidence intervals. The older resolved-only signal screen answers a different development question.

## Freeze and witness

Keep all registrations, trading evidence and outputs private, outside Git and CI artifacts.
Decode registrations with `MatchedRegistrationSchema`:

- `schemaVersion: "bayn.matched-entry-registration.v1"`
- Canonical `definitionHash`, native `protocolHash`, and reviewed code `sourceRevision`.
- `registeredAt`, `dataRole` (`DEVELOPMENT` or `PROSPECTIVE`), and five ordered unique `sessionDates`.
- `latencyMs` and canonical `executionAssumptionsHash` for the complete `study.assumptions` object.
- `latencyEvidenceHash` and `capacityEvidenceHash`; unknown witnesses are `null`.

Freeze the code, threshold/prompt/protocol, universe, arrival model, costs and execution assumptions before the first
prospective market open. Independently record the registration byte SHA-256 and code revision in a review receipt.
The command requires its executing Git checkout to be clean and match `sourceRevision`, before evaluation and again
before writing the report. Staged, unstaged and untracked changes fail; a different caller working directory cannot
substitute another checkout. The command also checks definition/protocol/assumptions, five
consecutive retained calendar sessions and the pre-open timestamp; it cannot prove that an asserted timestamp
was recorded prospectively. The independent review receipt must establish that fact.

Measure routing/persistence latency from completed-batch-to-order evidence, including tails and exit retries.
Original inference work is already included in the batch completion time; both rules wait for it, isolating selection.
Nominal API duration is insufficient. Supplied latency without a calibration witness remains incomplete.
Quote size units, source timing and executable capacity need separate evidence; paper fills do not prove capacity.

## Private input

`MatchedStudyInputSchema` defines `bayn.matched-entry-input.v1`:

| Field | Evidence |
| --- | --- |
| `study` | Existing `SignalStudyInputSchema`: run ID, complete source manifest, execution assumptions, every original batch including missing results and management batches. |
| `inventory` | One read-only database inventory per session: `sessionDate`, all `entryBatchIds`, `evidenceHash`. Zero-batch sessions need witnesses too. |
| `costs` | Per entry `batchId`, `inference` and `sharedOperating`. Each is `null` or `{ costMicros, evidenceHash, unresolvedCount }`. |
| `witnesses` | `[{ sha256, path }]` for each referenced witness; the command verifies its bytes. |

Use the native inference-cost report with request/receipt/resolution coverage and effective-dated tariffs.
Allocate every entry call, including abstentions, failures and unselected symbols. Missing/unpriced calls remain
unknown: an unpriced known subtotal of zero is not zero expense. Carry missing coverage in `unresolvedCount`.
Shared infrastructure, data and subscription allocations need explicit witnessed scope; otherwise use `null`.
These are witnessed allocation scenarios, not invoice reconciliation. Hashes establish identity; review the
allocation's source joins and accounting scope independently.

Every original native observation remains independently validated. Its selected bars, quotes, trades, feature
payloads and exact source coordinates must reproduce from the frozen capture. Timestamp spellings are compared as
integer nanoseconds; one-nanosecond changes still fail. Native receipt sequence and provenance are preserved.
Reconstructed/REST sources remain development diagnostics and cannot complete the experiment because original stream
availability is unobserved. The full source is hash/cut/order validated and consumed before writing a report.
Candidate exclusions remain in the report; omitted entire batches fail the independent inventory gate.

## Run

From the reviewed checkout:

```sh
bun services/bayn/tools/matched-entry-study.ts \
  --input /private/matched-input.json --input-sha256 <pinned-input-sha256> \
  --registration /private/registration.json --registration-sha256 <independently-pinned-registration-sha256> \
  --arrivals /private/arrivals.ndjson.gz \
  --source-receipt /private/source-receipt.json --source-receipt-sha256 <pinned-receipt-sha256> \
  --output /private/new-report.json
```

The output path must be new. No broker, provider or database connection is needed.
Historical sessions remain development. Passing command tests does not complete future sessions or establish profit.

## Decision

Every opportunity is paired, including abstentions and known unfilled entries. Both have zero execution P&L.
Unavailable answers, missing entry tasks or stop observations, residual inventory, partial exits and unknown costs
remain missing. Jev pays inference even when it abstains; both sides pay the same shared allocation.
Returns use the fixed budget. Identical selections share a lifecycle and have zero execution increment before costs.

Missing any session inventory, source coverage/availability, calibration, selected outcome or cost blocks all headline
means. Fewer than twenty different selections is inconclusive. Every fill, exit trigger, order, quote hash, candidate
exclusion and failure remains reviewable.

With complete prospective evidence, nonpositive Jev net budget return or paired increment in either the base
scenario or an additional ten bps per filled leg stops prioritizing this entry hypothesis. Positive results only earn
the separate frozen portfolio acceptance test. No outcome grants authority or strategy promotion. Preserve all five
scheduled sessions and failed runs; do not retune thresholds, prompts, universe, exits, sampling or costs mid-window.
