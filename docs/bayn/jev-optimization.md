# Native Jev question optimization with GEPA

Bayn uses GEPA `optimize_anything` with one `gepa` engine, pinned to
`8f287de942f41a6d1e0e7e5b2d576247c4bedee9`. The former Harness2 runner, dependency, commands and active editor
contracts are removed. Historical registrations and receipts remain immutable records.

## Model and execution ownership

Jev is the native typed System One decision model. GEPA's explicitly selected Flamingo or OpenCode free editor proposes a complete JSON
instruction document containing only one `entry` string, bounded to 2,000 characters. The editor cannot alter
state, the independent setup question, plan construction, arithmetic, quantities, risk, protection or authority.
Question editing does not train Jev's weights.

GEPA receives an explicit numeric objective and native failure diagnostics. Its evaluator uses the ordinary
portfolio executable with a compiled data-only instruction replacement. Every execution pass is retained losslessly in `passes.ndjson.gz` as concatenated gzip members. Its byte hash,
encoding and record count are bound into the native report. Full provider records remain separately retained.
Native request/response hashes, rejected
responses, costs, fills, cash, inventory, reconciliation and the compiler receipt are checked before fitness.
A different choice, concentrated probability or plausible explanation is not financial improvement.

The editor uses the existing signed Restate workflow, immutable store, serving attestation and stream/expense
verification. Registration `sourceRevision` binds the frozen native evaluator. Each receipt separately records
`workerSourceRevision`, so an unrelated worker rollout does not replace the frozen evaluator or abort the trial.
The worker still enforces the signed registration and its exact serving policy. The sole active registration is `bayn.jev-editor.v1`; its native structured response becomes a
`bayn.research-receipt.v2`. Factor selection, XML proposals and separate reflection requests cannot be submitted.
The migration requires outstanding priced historical expenses to be settled first. Existing evidence is retained
without enabling retired decoders or new legacy inference.

## OpenCode free inference

`opencode-research` runs the pinned native OpenCode 2.1.3 CLI on CPU in the standalone `opencode`
Application/namespace and its own image/Kargo release. Personal development uses a separate workload and PVC.
Bayn workers retain the Bayn image and release. Its internal proposal endpoint is reachable only from the research worker. The native
API and provider relay listen on loopback. The pod has no broker, Jev, database, research approval, storage API or
Kubernetes credential. A protected PVC holds native session history and exclusive attempt claims across restarts.

The worker's `BAYN_RESEARCH_INFERENCE_POLICIES` contains the exact admitted Flamingo and OpenCode policies. Select
one policy in each frozen study; neither endpoint falls back to the other. OpenCode admits only
`glm-5.3-flash-free`, with one hosted model call, low reasoning effort, 32 KiB of actual provider input and 4,096 completion tokens per
proposal. The native agent keeps one native-generated session per study, with an exclusive retained mapping. Before
each proposal it clears earlier messages through the native revert API and verifies that no earlier user input remains.
Each attempt's original registration, provider request, response and receipt remain retained separately. Feedback is
inline, and the frozen provider request requires `tool_choice: none`; proposals cannot request tool round trips.
Title, summary, compaction, sharing, updates, warming and other agents are disabled. Native
configuration is hashed into the policy. No Console login or paid key is required for this path.

The loopback relay checks the actual model, session, output schema, input size, deadline and remaining call count
before external I/O. All requests use the fixed OpenCode inference URL through the existing egress proxy on its separate OpenCode-only listener, port 3129. Kubernetes admits that listener
only from the proposer; the ordinary trading/research listener cannot reach OpenCode. It
forwards the native CLI's provider request; it does not imitate CLI headers in another inference client. Paid or
unregistered calls and hidden extra model calls fail. An attempt that requires another model step is rejected.
OpenCode's free-tier availability and models can change, so an unavailable free model stops the attempt.

Receipts retain the actual native provider request bytes, their hash, the original provider SSE, model usage,
configuration hash, native session ID, observed provider first-token time, both actual server and worker source revisions and zero provider charge. Hosted weights,
tokenizer and server image are not observable and are not assigned fictional self-hosted identities. The frozen
native evaluator revision remains independent of the research worker revision. CPU operating allocations remain
separate; a free provider does not make total research or Jev evaluation cost zero. Failed or timed-out claims cannot
be retried, and deadline cancellation interrupts the provider relay and native agent.

The Nix build exercises the actual pinned binary against an in-process provider fixture on both architectures. It
checks receipt verification, one session across server restart, refusal to replay a claimed attempt, cancellation and
child-process release. This contract test spends no hosted-model inference. Live hosted inference and native financial
comparisons remain separate rollout evidence.

## Frozen study and existing data

`bayn.jev-gepa-study.v1` freezes these fields before model work:

- Exact reviewed `sourceRevision`, existing `imageRepository` and published `imageDigest`.
- The unchanged `baseline` question document and `editor` policy/cost basis.
- `maximumSearchEvaluations`, `maximumEditorCalls`, `maximumNativeCalls`, `maximumWallSeconds` and `seed`.
- Ordered `development` and later `evaluation` blocks, with no overlapping execution/label interval.

Each block contains `id`, the complete ordinary native backtest `input`, `arrivalsPath`, `sourceReceiptPath`,
`sourceReceiptSha256` and per-session `operatingAllocations`. The native source validator checks acquired symbols,
original versus modeled availability, calendar, exclusions, ordering and hashes. Missing observations remain missing.
The input's baseline instruction hash and exact source/image must match the study. Paths refer to private retained
operator evidence; no credential belongs in the manifest.

Use existing captured or retained sessions. One existing session can support a bounded diagnostic with valid
chronological blocks and closed outcomes. There is no requirement to collect twenty new sessions for this tooling
experiment. Data already inspected during candidate selection is development evidence, regardless of a library's
`test_set` name. A descriptive delta is separate from evidence of generalization or durable profitability.

The GEPA search uses development feedback only. Its final candidate is frozen before evaluation. The runner
retains baseline, candidate and an independent unchanged-question repeat on evaluation blocks. The repeat measures
observed execution/provider variation; it does not establish statistical power.

## Run the published native evaluator

The published image contains `bayn-gepa`, `bayn-gepa-native`, `bayn-jev-evaluate`, `bayn-control-study`, the pinned
Python package, Bun and Git. Run a study in an isolated research environment using that image. Mount the existing
clean checkout and its Git metadata read-only, the selected source data read-only, and a new private output directory.
The compiler requires that exact committed revision and verifies its dependency bytes against the published image's
`/app/services/bayn/dist/jev-compiler-dependencies.json`. No new repository copy is needed.

Provision separate empty local replay databases before the study. `BAYN_GEPA_DATABASE_URLS` is a private JSON array
of their URLs, indexed by reservation ordinal. The native command selects one URL as `BAYN_BACKTEST_POSTGRES_URL`;
the existing backtest validator rejects non-local or improperly named targets. Supply the existing isolated
`BAYN_BACKTEST_TIGERBEETLE_ADDRESS`, cluster and ledger configuration. Never point a study at production accounting.

Keep the existing Jev key, proxy, signed research approval, Restate origin and private storage credentials in the
environment through their current paths. No new identity, grant or broker order is required.

```sh
bayn-gepa --version
bayn-jev-evaluate --baseline
bayn-gepa --manifest /private/study.json --output /private/gepa \
  --checkout /existing/lab \
  --dependencies /app/services/bayn/dist/jev-compiler-dependencies.json
```

The immutable image includes baseline and control evaluators. Frozen question variants are compiled from the same
reviewed source and dependency bytes. `bayn.jev-instruction-variant.v1` selects only `portfolio` or `entry-controls`
entry points, and has no arbitrary editable source path. It replaces the instruction data module exactly once.
Variant build receipts bind the executable, instructions, source, base image, dependency receipt and strategy hashes.
The ordinary trading build has no environment flag for installing an optimizer candidate.

## Cost objective and failure handling

Search fitness is explicitly native P&L after **known** execution, inference and allocated operating costs. Unknown
data or operating allocations remain null and produce `KNOWN_COSTS_ONLY`; they are never reported as zero expenses
or all-cost profit. Unpriced model requests, unclosed inventory, inexact accounting, unresolved mutations and invalid
native evidence cannot supply fitness. Retain exclusions and unavailable decisions in the diagnostics.

An HTTP 402 response from the native Jev provider is retained before the current replay pass fails. The research
command stops instead of dispatching later opportunities against an account requiring payment. Calls already in
flight retain their original outcomes and costs; missing metering remains unresolved. The failed reservation is not
refunded or retried.

`maximumSearchEvaluations` is GEPA's library budget. The outer native-call budget additionally reserves the full
per-evaluation provider cap across search, held-out evaluation, unchanged repeats and failed work. Editor calls have
a separate finite cap. Library test passes occur outside the library search budget but inside Bayn's reservations.

Every paid operation has a conditional private storage reservation before transmission under
`gepa/jev-v1/<studyId>/`. A completed exact evaluation may be reused within the study. An incomplete or rejected paid
attempt cannot be retransmitted or bypassed through a fresh slot. Native subprocess timeouts terminate their process
group. Retained ambiguous work remains inconclusive. There are no automatic paid retries.

Completed results can be read without model calls. `result.json` records the selected document, whether its bytes
changed, paired known-cost outcomes, the unchanged repeat and immutable identities. It always remains `UNQUALIFIED`;
search completion does not authorize production adoption or capital.

## Numerical controls and full portfolio outcomes

Use the existing breakout and relative-momentum controls before adding a learner. Their common mechanical exit
policy keeps exit rules fixed across entry policies. Compare unchanged Jev and the frozen selected question in that same entry-control
engine using independent portfolios, source, allocation, quote availability and declared/measured timing. Report
those results separately from full native portfolios, which retain Jev-selected protection plans and complete
production accounting/recovery behavior.

This development comparison measures selection together with measured Jev latency and cost. It does not isolate
selection from latency or replace the separately frozen matched-entry acceptance experiment.

The control input `bayn.control-study-input.v9` requires an explicit `costObjective`. `ALL_COSTS` retains the priced
data requirement. `KNOWN_COST_DIAGNOSTIC` can report known-cost outcomes with unknown data allocation kept null and
all-cost net results unavailable. It grants no qualification and cannot bypass Ridge's training provenance/cost
requirements. See [control portfolios](control-portfolios.md) and [matched entry study](matched-entry-study.md).

The economic objective is incremental execution value above cash and numerical controls under unchanged risk.
Both losing less than baseline and matching a numerical control are valid measured outcomes. Neither establishes
positive alpha. Preserve every trial and failed screen, source limitations, timing assumptions and missing costs.
A successful search does not automatically edit `jev/instructions.ts`; any adoption is a reviewed source change
through the existing identity, authority and Kargo delivery contracts.

## Shared proposal model

The editor uses Flamingo's `qwen36-flamingo`, backed by `unsloth/Qwen3.6-35B-A3B-NVFP4`, through
`http://flamingo.flamingo.svc.cluster.local/v1/chat/completions`. The model and tokenizer revisions are pinned to
`739af1e7aac320af1682ed1e0cce369af4c5265d`. Every accepted response must contain Flamingo's loaded serving identity
and the matching model name in the stream. The registered policy enables thinking with a 4,096-token output cap,
temperature 0.6, top-p 0.95 and top-k 20. The complete wire response and actual usage remain in the immutable receipt.

New editor requests use only Flamingo, with no model fallback. The former dedicated deployment, server code, image workflow and release enrollment are removed. Shared GPU contention can affect proposal latency. Existing
worker deadlines, single-attempt reservations and cost-coverage limits still apply. A failed or truncated proposal
is retained and cannot trigger an automatic paid retry. Jev inference and trading execution do not call Flamingo.
The protected cache PVC of the removed dedicated service remains retained; it consumes no GPU allocation.

Retained old-policy registrations remain readable only for receipt verification and expense recovery. Current
admission and inference still accept only the Flamingo policy. The cutover follows shared Flamingo
serving-identity verification and a successful worker proposal receipt before dedicated-service retirement.
