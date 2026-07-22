# Bayn architecture

## Boundary

Bayn is a single-writer, paper-only quantitative qualification runtime. It evaluates one compiled
`risk-balanced-trend` candidate against one immutable Signal snapshot, journals the deterministic simulation, verifies
the accounting result, and exposes the resulting qualification evidence. It has no runtime broker credential,
order-submission entry point, or capital-promotion authority. The source tree includes dormant paper-only read and
mutation adapters plus a recovery coordinator; the composition root does not build them and the pod has no broker
credential. Public status currently reports maximum authority `observe` independently of that dormant code.

The runtime has three external I/O boundaries:

- Signal ClickHouse, read-only, for the configured finalized publication;
- a dedicated Bayn TigerBeetle cluster for deterministic simulation accounting; and
- the existing `EvidenceStore` interface for durable qualification evidence.

The dormant paper path would add Alpaca through the existing egress proxy only after a qualified strategy, a dedicated
paper account, a reviewed credential, and explicit GitOps authority are present.

The implementation behind `EvidenceStore` is deliberately outside this document. Non-database cleanup must preserve
that interface and every persisted evidence contract.

## Runtime flow

1. The composition root loads Effect Config, decodes the compiled protocol, verifies its parameter hash against the
   build, and constructs one pure `Strategy` value.
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
the driver as `UnknownError` are retryable only for its `connect` operation; authentication and other terminal
failures fail immediately. A transient startup dependency failure that remains after bounded acquisition escapes the
scoped runtime, closes HTTP and acquired clients, and lets the Deployment restart the process. A deterministic
contract or evidence failure enters `FAILED` and keeps HTTP available for diagnosis with readiness closed.

## Dormant paper mutation boundary

Paper mutation uses one deliberately small transaction/I/O boundary:

1. A committed approved intent and current paper authority acquire the single-writer fence.
2. PostgreSQL records `SUBMIT_STARTED`, the exact request hash, deterministic client-order ID, and immutable broker
   consistency delay before the first POST.
3. Exactly one Alpaca request is made. Decoded 4xx rejections are terminal; a timeout, interruption, malformed response,
   server response, or post-send crash remains `UNKNOWN`.
4. Recovery waits the committed delay and performs `GET /v2/orders:by_client_order_id`. It never wraps POST or DELETE
   in a generic retry.
5. Cancel targets only a recorded broker order ID. A kill may permit that cancellation, but it cannot authorize a new
   exposure-increasing intent.

`mutation_events` is append-only and enforces the transition sequence, request identity, response identity, broker
order identity, and consistency delay in PostgreSQL. Any unresolved submit or cancel blocks later exposure-increasing
intents; terminal recovery releases that block. There is no scheduler, public order route, arbitrary order API, blind
flatten, runtime registry, or alternate writer.

This path is intentionally dormant: `src/index.ts` does not provide `BrokerMutation` or invoke the coordinator, GitOps
does not mount an Alpaca credential, and the current qualification is not execution authority. Enabling paper operation
requires a separate reviewed change and live readback against the dedicated paper account.

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
- The Alpaca read and mutation adapters, risk evaluator, intent and mutation stores, writer fence, and recovery
  coordinator remain outside the runtime composition until the qualification and authority gates explicitly permit a
  paper slice.

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

The compiled `bayn.risk-balanced-trend.protocol.v2` uses the exact `equity-infrastructure-v1` universe:

`AMD, AVGO, COHR, CRDO, LITE, MRVL, MU, NVDA, WDC`.

At each month-end close, the strategy computes volatility-normalized returns over 21, 63, 126, and 252 sessions,
averages them into a composite score, and assigns weight only to positive scores. Weights are redistributed under a 35%
per-symbol cap, quantized deterministically, and scaled down when estimated portfolio volatility exceeds 10%. Residual
exposure remains cash. Decisions execute only at the next exchange-session open under the compiled paper execution
model.

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
`maxSurge: 0` prevents overlapping writers during rollout. The pod has no broker secret and no Kubernetes API token.
Scaling to zero is a maintenance state, not a second deployment mode.

Every promoted image requires live acceptance against one coherent writer: the pod spec's digest-pinned image reference
must match the GitOps OCI index digest. The runtime image ID is supporting evidence: its digest must be either that same
index digest or the matching platform manifest declared by that index for the scheduled node architecture. Startup must
produce or recover durable terminal evidence, readiness must remain open across continuous probes, all dependencies
must remain available, accounting must be exact, and HTTP status must retain observe-only authority. An Argo
`Synced/Healthy` result without those observations is not sufficient.

Outside an explicit one-shot qualification release, GitOps pins `BAYN_QUALIFICATION_RUN_ID` to one terminal run. The
release writer preserves that pin while strategy and runtime bindings remain identical. After a fresh snapshot removes
the pin for its one allowed source revision, promotion rejects a different source revision on that same unpinned
snapshot; operational releases therefore cannot create extra qualification trials.
