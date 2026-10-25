# Matched Jev entry experiment

`services/bayn/tools/matched-entry-study.ts` tests one frozen question: does retained Jev entry selection add value
over immediately executable positive benchmark-relative momentum on the same observed opportunities? It runs entirely offline and
never calls a provider, places orders, changes safeguards or promotes a strategy.

The definition is TypeScript in `src/intraday-replay/matched-entry-study.ts`. It fixes five consecutive exchange sessions or continuous UTC observation days,
at least twenty different selections, a USD 10,000 budget quantized by frozen broker instrument increments per opportunity, five-second management polls,
a 50 bp price stop, a 100 bp estimated execution-net profit target including adverse exit allowance, a 15-minute maximum hold and the five-minute close window. Three independent arms use identical execution assumptions and mechanical management. Immediate momentum starts
at witnessed deterministic completion; delayed momentum and Jev start at witnessed decision commitment. One IOC entry is followed by
persistent reducing exit retries; actual partial fills and consumed quote liquidity remain in the ledger.
Idle management keeps the five-second cadence regardless of routing latency. Only an actual pending exit skips
crossed polls; a partial exit retries on the next eligible poll after its arrival. No model management is used.

This is an opportunity-label experiment. Labels can overlap, and naturally retained flat-entry opportunities are
endogenous to the current strategy. Never sum their returns into portfolio P&L, turnover, trade frequency or
independent confidence intervals. The older resolved-only signal screen answers a different development question.

## Freeze and witness

Keep all registrations, trading evidence and outputs private, outside Git and CI artifacts.
Decode registrations with `MatchedRegistrationSchema`:

- `schemaVersion: "bayn.matched-entry-registration.v2"`
- Canonical `definitionHash`, native `protocolHash`, and reviewed code `sourceRevision`.
- `registeredAt`, `dataRole` (`DEVELOPMENT` or `PROSPECTIVE`), and five ordered unique `sessionDates`.
- `latencyMs` and canonical `executionAssumptionsHash` for the complete `study.assumptions` object.
- `latencyEvidenceHash` and `capacityEvidenceHash`; unknown witnesses are `null`.

`study.assumptions.instruments` is required and pins `minimumQuantityAtoms`, `quantityIncrementAtoms`, and
`priceIncrementAtoms` for every traded symbol. The study does not substitute equity precision for crypto.
The definition freezes the first-tier taker rate at 25 bp per leg. Buy fees debit received coins; sell fees debit USD.
Coin fees round up to an atom and cash fees to a cent as explicit conservative research assumptions, not a claim about
provider receipt rounding. Multipliers stress both legs. Net sell quantity comes from the fee-adjusted ledger.
Missing inference, operating, or original timing evidence still makes the comparison incomplete.

Continuous studies include weekends and keep elapsed holding deadlines across midnight. UTC days group observations;
they do not impose a midnight liquidation. Each arm has the same 15-minute hold and three-minute recovery budget.
Equity studies retain their exchange close and five-minute flattening window.

Freeze the code, threshold/prompt/protocol, universe, arrival model, costs and execution assumptions before the first
prospective market open. Independently record the registration byte SHA-256 and code revision in a review receipt.
The command requires its executing Git checkout to be clean and match `sourceRevision`, before evaluation and again
before writing the report. Staged, unstaged and untracked changes fail; a different caller working directory cannot
substitute another checkout. The command also checks definition/protocol/assumptions, five
consecutive retained calendar sessions and the pre-open timestamp; it cannot prove that an asserted timestamp
was recorded prospectively. The independent review receipt must establish that fact.

Retained batches may arrive in any order. Their calendars must agree on overlapping session dates and hours, and
their query ranges must cover the complete registered date interval, including closed dates. Missing earlier-session
coverage cannot be inferred from a later batch; prospective timing always uses the earliest registered open.

Measure routing/persistence latency from completed-batch-to-order evidence, including tails and exit retries.
Inference and acknowledged persistence are measured separately. The immediate arm does not wait for either;
the delayed and Jev arms use the same witnessed commitment clock.
Nominal API duration is insufficient. Supplied latency without a calibration witness remains incomplete.
Quote size units, source timing and executable capacity need separate evidence; paper fills do not prove capacity.

## Private input

`MatchedStudyInputSchema` defines `bayn.matched-entry-input.v2`:

| Field       | Evidence                                                                                                                                                                                                                                                                                                         |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `study`     | Existing `SignalStudyInputSchema`: run ID, complete source manifest, execution assumptions, every original batch including missing results and management batches.                                                                                                                                               |
| `inventory` | One read-only database inventory per session: `sessionDate`, all `entryBatchIds`, `evidenceHash`. Zero-batch sessions need witnesses too.                                                                                                                                                                        |
| `timings`   | Per entry `batchId`, a native timing witness or explicit `null`. The witness contains input readiness, deterministic completion, batch completion, decision commitment, selected momentum symbol, the timing file SHA-256 `evidenceHash`, and the native execution-decision file SHA-256 `decisionEvidenceHash`. |
| `costs`     | Per entry `batchId`, `inference` and `sharedOperating`. Each is `null` or `{ costMicros, evidenceHash, unresolvedCount }`.                                                                                                                                                                                       |
| `witnesses` | `[{ sha256, path }]` for each referenced witness; the command verifies its bytes.                                                                                                                                                                                                                                |

An inventory's `evidenceHash` pins the raw bytes of `inventory.json` from the existing
[native session export](study-evidence-export.md). The command decodes `bayn.jev-study-inventory.v1`, verifies its
embedded export receipt, and binds account, session and inline entry IDs. Every supplied entry and management batch
must match its batch, cycle, observation, purpose and nullable result hash. Duplicate or malformed inventories fail;
omitted batches, changed results and cuts taken before the registered session close make all headline means
unavailable. Reports retain the complete witnessed cycles and batches, including no-batch and pending cycles.
Every retained cycle must bind the registered protocol, including blocked and no-batch cycles. A foreign protocol
keeps that cycle visible and makes the study incomplete even when all supplied batch protocols match.
Pending or active cycles also make the study incomplete, even after session close: later recovery can still append
their batches or results. Preserve that cut and take a new export after the cycles become terminal.
Independent review must still establish that the witness is the complete native export; a self-consistent JSON hash
does not prove that provenance. Missing historical witnesses remain `null` and incomplete. Do not manufacture them
from a selected subset, reuse another session's witness or relabel an old report.

Use the native inference-cost report with request/receipt/resolution coverage and effective-dated tariffs.
Allocate every entry call, including abstentions, failures and unselected symbols. Missing/unpriced calls remain
unknown: an unpriced known subtotal of zero is not zero expense. Carry missing coverage in `unresolvedCount`.
Shared infrastructure, data and subscription allocations need explicit witnessed scope; otherwise use `null`.
These are witnessed allocation scenarios, not invoice reconciliation. Hashes establish identity; review the
allocation's source joins and accounting scope independently.

Every referenced witness is read and hashed as raw bytes, including latency, capacity, zero-batch inventories and
both cost allocations. Missing, unreadable or changed files fail the command before evaluation. Timing and native
decision decoders consume those same verified bytes without rereading a mutable path.

Every original native observation remains independently validated. Its selected bars, quotes, trades, feature
payloads (including optional technical indicators), model-relevant session/window context and exact source
coordinates must reproduce from the frozen capture. Missing technical evidence is distinct from present evidence.
Native receipt sequence/availability provenance can differ from capture provenance, but technical topic, partition,
offset and full producer payload must agree. Timestamp spellings are compared as
integer nanoseconds; one-nanosecond changes still fail. Native receipt sequence and provenance are preserved.
Reconstructed/REST sources remain development diagnostics and cannot complete the experiment because original stream
availability is unobserved. The full source is hash/cut/order validated and consumed before writing a report.
Both captured-Kafka and original-capture sources retain their own independently pinned receipt and arrival contracts;
recognizing either transport does not waive source verification, session coverage or any other completeness witness.
Candidate exclusions remain in the report; omitted entire batches fail the independent inventory gate.

### Timing and report versions

Definition and report are `bayn.matched-entry-definition.v8` and `bayn.matched-entry-study.v8`. Input is v2;
registration is v2 with the new definition hash, native millisecond timing contract and frozen profit-target lifecycle. Old input contracts and registrations are rejected.
Historical reports retain their original identities and must not be relabeled as prospective evidence.

The in-process recorder and its interval replay API have been removed. Producing new timing witnesses through that
path is unavailable. The [market-data archive boundary](market-data-archive.md) keeps its replacement outside trading;
an independent Kafka archive cannot reconstruct the trading worker's original arrival or decision-commit clocks.

The native `bayn.jev.batch-plan` trace span now carries `bayn.entry_timing.batch_id`, `observation_hash`,
`snapshot_hash`, and the worker's actual `input_available_at`. For current momentum-first entry batch v6, it also carries
`deterministic_selected_at`, observed after the existing ranking and batch construction finish and before inference
admission. This includes the actual observation-persistence delay; it is not a hypothetical earlier computation.
The selected control symbol must be reproduced from the same retained snapshot with `jevMomentumEntryCandidates`.
No extra ranking, database write, archive upload, or research RPC is added to execution.

The native `bayn.jev.entry-decision-binding` span identifies the decision and exact batch completion. Its PostgreSQL
children inherit those identities. Cycle-pass, planning, binding, writer-fence and COMMIT stages also carry
`bayn.native_wall.clock=effect.Clock.currentTimeMillis`, `started_at` and `finished_at`. These markers use the same
clock as native observations and decisions. An independent timing exporter must use the successful writer-fence
`bayn.postgres.commit` stage's native wall completion marker, require `binding_changed=true` and
`binding_accepted=true` on the enclosing binding span, and verify the retained native decision document. Replays,
failed or interrupted commits, missing spans, and conflicting clocks provide no witness. The trace resource must
identify the exact registered source revision. Trace export remains asynchronous and does not gate trading or
protective closures. Retain original trace bytes and independent capture/review seals; these annotations alone do
not supply a complete Kafka source archive or qualify a strategy comparison.

Each timing witness must point to a retained, independently verified private `bayn.jev-entry-timing.v2` file with
`clock=effect.Clock.currentTimeMillis`.
The study command reads and hashes that file, checks source revision, batch, observation
and snapshot identities, clock order, retained batch completion and frozen momentum selection. The required
`decisionEvidenceHash` references the complete committed native execution-decision document exported read-only from
the cycle store. The native decoder verifies its semantic and content identity; the study binds the timing receipt's
`decisionHash` to that document's `contentHash`, its exact entry batch/result and snapshot, and requires creation before
acknowledged commitment. Another valid decision for the same batch cannot replace the committed document. An inline timing
claim cannot replace the retained file. Preserve the verified capture seal/frame chain and independent review
receipt; a JSON hash alone cannot prove clocks were genuinely observed. Missing or uncommitted timing makes the
comparison incomplete. Earlier captures without the producer cannot supply an immediate counterfactual.

The [incremental-value audit](jev-incremental-audit.md) explains why selection and delay require separate arms.

### Export a retained native timing witness

`services/bayn/tools/entry-timing-export.ts` derives the v2 timing receipt from one independently retained
Tempo trace query response and the exact committed native execution-decision document. It runs offline, reproduces
the current native decision and momentum selection, and has no database, broker or model client.

```sh
bun services/bayn/tools/entry-timing-export.ts \
  --trace /private/tempo-trace.json --trace-sha256 <pinned-original-trace-sha256> \
  --decision /private/native-decision.json --decision-sha256 <pinned-original-decision-sha256> \
  --source-revision <instrumented-worker-source-revision> \
  --output /private/new-timing-directory
```

The trace must be the original JSON returned by Tempo's `/api/traces/<traceId>` query endpoint: a `batches` envelope,
canonical protobuf base64 trace/span identifiers and string enums. This is a Tempo query representation, not the
different OTLP/JSON ingestion wire format. The command validates both input hashes before decoding those same bytes;
each input is limited to 16 MiB and the trace to 10,000 spans. It rejects malformed or duplicate identities and
attributes. Preserve the private original files, capture/review seals and exporter code revision; hashes do not prove
that a trace or native document was independently captured.

The native planning and accepted binding must belong to the same successful cycle pass, source revision and worker
instance. The command requires exactly one successful direct writer-fence child of that binding and one successful
COMMIT child of the fence, matching the exact native decision, batch and result. Replays, rejected bindings, rollback,
missing or ambiguous spans, foreign processes, inconsistent ancestry and conflicting clocks fail without a completed
export. Valid native abstentions can supply timing; unavailable inference or an uncommitted batch cannot.
Historical protocol documents are not rewritten and have no decoding fallback.

Raw span chronology and containment use integer nanoseconds within the trace clock. Native chronology and parent
containment use the explicit millisecond markers. Effect's Unix-nanosecond clock projects monotonic time onto a wall
epoch and can drift from its `Date.now()` millisecond clock; the exporter never compares these clocks as one exact
timeline. Missing markers, wrong clock identities, clock reversals and parent-containment failures are rejected.

Commitment uses the upper bound of the native millisecond bucket observed after COMMIT acknowledgement, adding one
millisecond to the completion marker. It therefore never starts a delayed control earlier than that observation.
The receipt retains both the original trace nanoseconds and explicit native wall intervals. Older v1 traces and
receipts remain historical artifacts and cannot supply a v2 witness through a fallback.

The new directory has mode `0700`, with `timing.json` and `receipt.json` at `0600`. Existing destinations are never
overwritten. The `bayn.jev-entry-timing-export.v2` receipt binds both input byte hashes, the timing-file hash, exact
selected trace/span identities and nanosecond boundaries, native clock intervals and commitment upper bound. A directory
without a complete receipt is an incomplete attempt. The command prints only output receipt metadata.
Pin the raw `timing.json` hash as the matched input's `evidenceHash`, and the original native-decision file hash as
`decisionEvidenceHash`; copy the timing fields from that verified receipt into the inline witness.

An export establishes only observed entry timing. It remains `UNQUALIFIED` and does not provide complete source,
session or controller coverage, latency/capacity calibration, cost allocations or profitability evidence. Every
existing matched-study inventory, registration, source, cost and completeness requirement remains in force.

## Run

The command remains available for validated retained inputs and development fixtures. A new prospective matched-entry
comparison is blocked until complete source and timing witnesses are available. Running the command does not establish
those witnesses or make an invalidated legacy capture eligible. From the reviewed checkout:

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

Every opportunity has three arms, including abstentions and known unfilled entries. An evidenced abstention or unfilled entry has zero execution P&L.
Unavailable answers, missing entry tasks or stop observations, residual inventory, partial exits and unknown costs
remain missing. Jev pays inference even when it abstains; all arms pay the same shared allocation.
Returns use the fixed budget. Each arm owns its lifecycle even when symbols match, because entry fills, stops and hold deadlines can differ.
Selection is `Jev - delayed momentum`; delay is `delayed momentum - immediate momentum`; total is
`Jev - immediate momentum`. The three net micro-USD differences satisfy selection plus delay equals total.
All three resolved arms are required for the common headline population.

Missing any session inventory, source coverage/availability, calibration, selected outcome or cost blocks all headline
means. Fewer than twenty different selections is inconclusive. Every fill, exit trigger, order, quote hash, candidate
exclusion and failure remains reviewable.

With complete prospective evidence, nonpositive Jev net budget return or total increment over immediate momentum in either the base
scenario or an additional ten bps per filled leg stops prioritizing this entry hypothesis. Positive results only earn
the separate frozen portfolio acceptance test. No outcome grants authority or strategy promotion. Preserve all five
scheduled sessions and failed runs; do not retune thresholds, prompts, universe, exits, sampling or costs mid-window.

The v7 definition uses an independent mechanical control exit profile. Its results do not qualify the v14 strategy's
range-derived prices or broker-held bracket, OCO or stop-limit lifecycle. Historical registrations cannot be reused
against a changed definition hash. Native lifecycle acceptance requires the production engine and broker evidence.
