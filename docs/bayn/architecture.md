# Bayn architecture

## Boundary

Bayn is a single-writer, paper-only quantitative qualification runtime. It evaluates one compiled
`risk-balanced-trend` candidate against one immutable Signal snapshot, journals the deterministic simulation, verifies
the accounting result, and exposes the resulting qualification evidence. It has no order-submission entry point or
capital-promotion authority. A dedicated paper credential may build the GET-only Alpaca read adapter while authority
remains `OBSERVE`; paper mutation and recovery remain dormant. Public status reports maximum authority independently
of credential presence.

The runtime has three external I/O boundaries:

- Signal ClickHouse, read-only, for the configured finalized publication;
- a dedicated Bayn TigerBeetle cluster for deterministic simulation accounting; and
- the existing `EvidenceStore` interface for durable qualification evidence.

Alpaca is reachable only through the existing paper-host CONNECT proxy. Credentials provide runtime-decoded GET-only
broker access. Under `OBSERVE`, the canonical non-dispatchable autonomous shadow loop composes `PaperStore` and
`WriterFence` and performs one same-pass reconciliation when it builds a decision; broker mutation remains absent.
Exact asset reads retain status, tradability, fractionability, and normalized attributes as policy-neutral evidence.

The implementation behind `EvidenceStore` is deliberately outside this document. Non-database cleanup must preserve
that interface and every persisted evidence contract.

## Runtime flow

1. The composition root loads Effect Config, decodes the compiled protocol, verifies its parameter hash against the
   build, verifies the compiled behavior identity, and constructs one pure `Strategy` value.
2. Startup inspects the configured finalized Signal V2 publication before loading bars. The manifest must match the
   compiled universe, symbol hash, feed, adjustment, calendar, and evaluation bounds.
3. Bayn derives the candidate identity and opens the immutable qualification lock through the existing evidence
   boundary. A terminal result is recovered; an incomplete lock fails closed.
4. For a new candidate, Bayn loads the locked bars, evaluates the strategy and benchmarks, journals the simulation to
   TigerBeetle, and requires exact reconciliation.
5. The evaluation graph and one terminal qualification result are committed through the existing evidence boundary.
6. A health probe then verifies Signal identity, TigerBeetle state, durable evidence, and dependency connectivity.
   Readiness opens only when startup evidence exists and every probe is available.

`BAYN_QUALIFICATION_RUN_ID` selects the recovery path. That path verifies the stored strategy, Signal, and execution
bindings and does not load bars, open a new lock, evaluate, journal, or persist. Continuous health checks still verify
the recovered run after startup.

A strategy rejection is terminal economic evidence, not an operational crash. ClickHouse and PostgreSQL layer
acquisition retry a transient SQL failure twice at one-second intervals. PostgreSQL connection failures reported by
the driver as `UnknownError` are retryable only when the `connect` operation carries `ECONNREFUSED`; authentication,
TLS configuration, and other terminal failures fail immediately. A transient startup dependency failure that remains
after bounded acquisition escapes the scoped runtime, closes HTTP and acquired clients, and lets the Deployment
restart the process. A deterministic contract or evidence failure enters `FAILED` and keeps HTTP available for
diagnosis with readiness closed.

## Dormant paper mutation boundary

Paper mutation uses one deliberately small transaction/I/O boundary:

1. A committed approved intent and current paper authority acquire the single-writer fence.
2. PostgreSQL records `SUBMIT_STARTED`, the exact request hash, deterministic client-order ID, and immutable broker
   consistency delay before the first POST.
3. The coordinator rechecks the committed risk-decision expiry with the Effect clock immediately before POST or
   DELETE. The interval is half-open, so the exact cutoff instant makes zero broker mutations.
4. Exactly one Alpaca request is made. Decoded 4xx rejections are terminal; a timeout, interruption, malformed response,
   server response, or post-send crash remains `UNKNOWN`.
5. Recovery waits the committed delay and performs `GET /v2/orders:by_client_order_id`. It never wraps POST or DELETE
   in a generic retry.
6. Cancel targets only a recorded broker order ID. A kill may permit that cancellation, but it cannot authorize a new
   exposure-increasing intent.

`mutation_events` is append-only and enforces the transition sequence, request identity, response identity, broker
order identity, and consistency delay in PostgreSQL. Any unresolved submit or cancel blocks later exposure-increasing
intents; terminal recovery releases that block. There is no scheduler, public order route, arbitrary order API, blind
flatten, runtime registry, or alternate writer.

This path is intentionally dormant: credentials provide GET-only broker access, while `OBSERVE` composes `PaperStore`
and `WriterFence` for one same-pass reconciliation inside the canonical non-dispatchable autonomous shadow loop.
`BrokerMutation`, `IntentStore`, `MutationStore`, and the coordinator remain absent. `PAPER` startup fails closed until
the PROOMPT-375 Phase B authority generation and dispatch transition exists.

## Effect composition

Effect is used at resource and failure boundaries, not as a container for ordinary TypeScript:

- `Strategy`, protocol values, calculations, hashing, and qualification analysis are plain immutable values and pure
  functions.
- `MarketData`, `Journal`, and `EvidenceStore` are Effect services because they own external I/O and resource
  lifecycles.
- `src/index.ts` is the only composition root. It loads configuration, builds the pure strategy, assembles the three
  I/O layers, and hands them to `run`.
- `run` owns one scoped lifetime. It starts the HTTP layer, performs initialization, and forks the repeating health
  monitor with `forkScoped`; scope closure releases the server and clients.
- `startup.ts` and `health.ts` own lifecycle decisions; `ledger-plan.ts` is deterministic accounting, while
  `tigerbeetle-client.ts` owns DNS, client acquisition, invalidation, and release.
- Versioned protocol and evidence types come from their Effect Schemas. `types.ts` is a compatibility export surface,
  not a second hand-written contract.
- Operational timeouts and typed `OperationalError` values are applied where an external operation enters the
  lifecycle. Domain functions throw only inside an `Effect.try` boundary that assigns the owning component and
  operation.
- HTTP receives the runtime state and the narrow evidence-read callback it needs. It does not depend on the strategy or
  the complete evidence service.
- The Alpaca read adapter enters runtime composition for GET-only access under `OBSERVE`. `PaperStore` and
  `WriterFence` support one same-pass reconciliation inside the canonical non-dispatchable autonomous shadow loop.
  `BrokerMutation`, `IntentStore`, `MutationStore`, and the coordinator remain outside composition, and `PAPER` startup
  fails closed until the PROOMPT-375 Phase B authority generation and dispatch transition exists.

Do not introduce a `Context.Service` or `Layer` for a pure value merely to make it injectable. Add an Effect service
only when a capability needs acquisition, release, configuration, retry, concurrency, or typed I/O failure.

## Runtime state and probes

The internal operational states are `STARTING`, `READY`, `DEGRADED`, and `FAILED`. Each health observation
records one sequence number and independent `UNKNOWN`, `AVAILABLE`, or `UNAVAILABLE` results for PostgreSQL,
Signal, TigerBeetle, and durable evidence. Readiness requires:

- operational state `READY`;
- an active evaluation or recovered qualification; and
- every dependency result `AVAILABLE`.

The monitor runs immediately after initialization and then at `BAYN_HEALTH_INTERVAL_MS`. A transient defect moves a
previously ready runtime to `DEGRADED`; a later complete probe can reopen readiness without discarding the last valid
evidence. `BAYN_OPERATION_TIMEOUT_MS` bounds every external startup and health operation.

`GET /livez` proves only that the process and HTTP server are alive. `GET /readyz` exposes the current readiness
decision. `GET /v1/status` keeps operational health, data identity, evidence, economic verdict, qualification,
accounting, build provenance, and fixed authority separate. `economic.verdict` is the economic gate result;
`qualification.verdict` is the terminal qualification result. Neither field implies execution authority, which is
fixed exclusively by `authority`.

## Strategy and economic contract

The compiled `bayn.risk-balanced-trend.protocol.v3` precommit uses the exact `cross-asset-taa-v1` universe:

`DBC, EFA, IEF, SPY, VNQ`.

The cross-asset Signal history is finalized and accepted. The explicit M2.2 release removes the terminal
`equity-infrastructure-v1` M2.1 runtime run-ID pin while preserving the historical PostgreSQL graph, ephemeral operator
audit output, and TigerBeetle journal unchanged. Runtime recovery reads the durable EvidenceStore graph by run ID; no
dossier file is mounted.

The released cross-asset run is terminal `REJECTED` but non-authorizing because its execution contract was not
live-causal. Its retrospective audit also fails closed: ClickHouse records pre-lock Bayn/operator reads of the bars
table, but cannot prove after the fact that the results contained only bounded publication count/hash evidence. The
audit therefore fails candidate-bar chronology and principal checks. GitOps may pin that terminal run ID for immutable
database recovery under `OBSERVE`; the pin clears no qualification or mutation gate.

At each month-end close, the strategy computes volatility-normalized returns over 21, 63, 126, and 252 sessions,
averages them into a composite score, and assigns weight only to positive scores. Weights are redistributed under a 35%
per-symbol cap, quantized deterministically, and scaled down when estimated portfolio volatility exceeds 10%. Residual
exposure remains cash. The strategy parameters and thresholds are unchanged from the rejected v2 run.

The v3 execution model is live-causal. Once the signal session is finalized, planning uses that session's close-price
vector and a content-hashed reconciled broker state observed before planning. The bounded Alpaca calendar response
binds its request range, source/version, complete normalized session set, response hash, and the selected future
session's exact UTC open and close. Decoding revalidates the response hash and requires that selected session to be the
first post-signal session in the bound observation.
Ordinary non-extended `DAY` market orders may be submitted only after the plan is committed and before a fixed
15-minute pre-open cutoff. Risk approval is valid in `[submissionOpenAt, submissionCutoffAt)`. Planned buys reserve
aggregate pre-submit buying power and cannot spend planned sell proceeds. The selected session open is a fill outcome:
changing it may alter fills, gaps, slippage, shortfall, and performance, but cannot alter planned quantities.

The source-controlled precommit identities are behavior
`dc614c54bbf43842d83cd88497e835f7bb25c413eb6e8bd7cbab0a925ec9b2dd` and parameters
`e5e4cc5d22b84c4dc8fc65c306d097fda063b0058253da5b900fe1d462d437b3`. They do not relabel
the terminal v2 rejection and do not constitute a new qualification.

The evaluator compares the candidate with buy-and-hold, direct-volatility timing, and doubled-cost results over aligned
dates. Qualification also applies the committed statistical and walk-forward policy. Every decision, benchmark,
execution assumption, gate, and result remains bound to the run identity; refactoring composition must not alter those
values.

## Reproducibility and failure semantics

The executable embeds the source revision, image repository, strategy behavior hash, and parameter hash. Production
startup rejects absent or mismatched embedded facts. GitOps supplies the immutable image-index digest, and the run ID
also binds the complete decoded protocol, finalized Signal provenance, calendar, and explicit bounds.

The local `dev` and `start` scripts select `development-configured` provenance because those artifacts do not
contain production build metadata. This changes only how provenance is verified and reported; it does not disable
evaluation, journaling, health checks, or fail-closed behavior.

Repeated execution of the same inputs is deterministic and must either recover exact terminal evidence or reproduce
the same journal objects. Any mismatched manifest, universe, build identity, lock, journal object, reconciliation,
qualification, or durable evidence closes readiness and never expands authority.

## Deployment contract

GitOps owns one `apps/v1 Deployment` configured as a single writer and a dedicated three-replica TigerBeetle cluster.
`maxSurge: 0` prevents overlapping writers during rollout. The pod has no Kubernetes API token. A broker Secret may be
consumed only by this Deployment and does not expand authority. Scaling to zero is a maintenance state, not a second
deployment mode.

Every promoted image requires live acceptance against one coherent writer: the pod spec's digest-pinned image reference
must match the GitOps OCI index digest. The runtime image ID is supporting evidence: its digest must be either that same
index digest or the matching platform manifest declared by that index for the scheduled node architecture. Startup must
produce or recover durable terminal evidence, readiness must remain open across continuous probes, all dependencies
must remain available, accounting must be exact, and HTTP status must retain observe-only authority. An Argo
`Synced/Healthy` result without those observations is not sufficient.

Outside an explicit one-shot qualification release, GitOps pins `BAYN_QUALIFICATION_RUN_ID` to one terminal run. The
release writer preserves that pin while compiled strategy identity, Signal identity and bounds, TigerBeetle cluster
ID, and TigerBeetle ledger remain identical. TigerBeetle replica addresses are transport routing, not qualification
identity, so an explicit reviewed candidate may change them without relabeling terminal evidence. A cluster-ID or
ledger change still requires a fresh Signal snapshot. The writer has no source-coded current snapshot: ordinary image
promotion reads the deployed runtime, while a qualification transition must supply the complete candidate runtime.
After a fresh snapshot removes the pin, the complete deployed candidate becomes immutable: source, image digest,
compiled strategy, Signal and TigerBeetle runtime may only be replayed exactly until its terminal run is pinned. A
controlled invocation may install the exact independently accepted terminal run only for that deployed candidate. It
cannot replace an old pin and advance to a fresh candidate in the same change. A later pinned operational release may
change source while preserving identical compiled strategy and qualification identity. Automatic image promotion
never creates a qualification pin.
