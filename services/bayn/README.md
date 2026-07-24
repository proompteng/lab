# Bayn

Bayn is a single-writer, paper-only quantitative qualification runtime. The released cross-asset one-shot is terminal
`REJECTED`, pinned by `BAYN_QUALIFICATION_RUN_ID`, and non-authorizing. The next source-controlled precommit is
`bayn.risk-balanced-trend.protocol.v3`: the same strategy parameters and thresholds with a corrected live-causal
execution contract. It is not qualified and this change does not rerun qualification. GitOps remains `OBSERVE`; the
paper mutation capability, execution entry point, and capital-promotion path remain dormant.

## Runtime contract

- Node.js is the production runtime; Effect owns dependency acquisition, failure handling, and shutdown.
- Effect Config validates environment input. `BAYN_OPERATION_TIMEOUT_MS` bounds dependency operations, and
  `BAYN_HEALTH_INTERVAL_MS` controls the continuous health interval; both default to 30 seconds.
- `BAYN_MAXIMUM_AUTHORITY` is a closed `OBSERVE`/`PAPER` process ceiling and defaults to `OBSERVE`. It never creates a
  broker capability; the deployed runtime remains `OBSERVE` and does not compose the submit/cancel capability.
- Public egress is denied from the Bayn Pod. A separate CONNECT proxy permits only
  `paper-api.alpaca.markets:443`. A configured Alpaca credential is accepted only after account, position, order,
  order-lookup, and fill reads pass the runtime-decoded preflight through that proxy.
- Signal ClickHouse is read-only at runtime. Data publication and provider credentials are owned by the separate Signal
  adjusted-daily publisher; Bayn contains no DDL or backfill command.
- Bayn owns a two-instance CloudNativePG cluster. The runtime uses the generated application URI over verified TLS,
  runs versioned Effect SQL migrations at startup, and keeps a bounded two-connection pool.
- PostgreSQL stores paper mutation transitions in one append-only `mutation_events` table. Request identity, broker
  response identity, and the lookup delay are committed before use; unresolved outcomes block later exposure. The
  deployed observe-only runtime does not create mutation rows.
- Paper execution is long-only: risk blocks an existing short or a sell beyond reconciled long inventory before broker
  I/O. Fill accounting persists Alpaca's full source timestamp and orders equal timestamps by fill ID, rejects late
  predecessors, and records a receipt only after the complete TigerBeetle transaction-tag transfer set matches.
- The composition root builds one pure strategy value and passes it explicitly to the lifecycle. Effect services and
  layers are reserved for I/O resources. The compiled `bayn.risk-balanced-trend.protocol.v3` owns its authoritative
  universe and causal execution contract; the HTTP and startup lifecycle remain strategy-independent. Protocol v2
  remains decodable only so immutable historical evidence can be recovered.
- The typed protocol is compiled into the image and runtime-decoded with Effect Schema. Strategies remain reviewed
  TypeScript rather than JSON.
- The executable embeds source, repository, and strategy-behavior identity. Startup verifies the compiled behavior and
  parameter hashes against those embedded facts, and status exposes the promoted image digest, parameter hash, and
  contract versions. The v3 precommit uses behavior hash
  `dc614c54bbf43842d83cd88497e835f7bb25c413eb6e8bd7cbab0a925ec9b2dd` and parameter hash
  `e5e4cc5d22b84c4dc8fc65c306d097fda063b0058253da5b900fe1d462d437b3`.
- The package `dev` and `start` scripts use explicit `development-configured` provenance because their artifacts are
  not OCI production builds. That mode is visible in status and cannot override an executable with embedded metadata;
  it does not change lifecycle or authority. The Nix image starts in the default production mode and fails closed if
  embedded facts are absent.
- The reader selects one configured finalized Signal snapshot by content-addressed ID. Before reading bars, it verifies
  the publisher manifest and exact exchange calendar and derives the candidate identity and evaluation window. After
  lock acquisition it verifies every bar, SIP/all provenance, the canonical universe, content hashes, and explicit
  data, lookback, and evaluation bounds before exposing numeric bars.
- The run ID binds source and image identity, compiled strategy behavior and decoded parameters, complete finalized
  snapshot provenance, calendar version, and explicit bounds.
- `BAYN_QUALIFICATION_RUN_ID` optionally pins one terminal qualification across operational image updates. Startup
  verifies the stored strategy and Signal bindings, then recovers it without inspecting bars, opening a lock,
  evaluating, journaling, or persisting.
- Production GitOps carries that pin outside an explicit one-shot qualification release. Once a fresh candidate is
  deployed without a pin, its source, image digest, compiled strategy, and complete runtime are immutable until the
  exact independently accepted terminal run is pinned. Fresh-candidate deployment and pin installation cannot be
  combined, and automatic image promotion supplies neither candidate material nor a run ID. Once pinned, a later
  operational release may change source only while preserving compiled strategy and qualification identity. This
  prevents extra trials or rebinding evidence to implicit inputs.
- The compiled risk-balanced trend decision function records every normalized trend horizon, volatility estimate,
  portfolio-volatility scale, and target weight at a month-end close. Quantities are planned only after that Signal
  session is finalized, using its close prices and reconciled broker state observed before planning. Ordinary
  non-extended `DAY` market orders may be submitted only after the plan is committed and before the fixed 15-minute
  pre-open cutoff. The next exchange-session open affects fills and performance, never planned quantities; planned
  buys reserve only pre-submit cash and cannot spend proceeds from planned sells.
- After exact TigerBeetle reconciliation, one PostgreSQL transaction records the immutable protocol lock, input
  snapshot reference, run identity, metrics, simulated orders, fills, cash changes, daily position marks, daily
  returns, turnover, fees, drawdown, aligned benchmark series, the full equity series, independent marked-equity
  proof, reconciliation receipt, gate outcomes, and status history. A content-addressed dossier manifest binds every
  artifact, event, and gate hash to the exact source, image, protocol, snapshot, calendar, and execution contract.
- Ordered artifacts can be read internally through contiguous pages capped at 256 items. PostgreSQL triggers make the
  complete evidence graph append-only and permit an evaluation row only its exact `WRITING` to `COMPLETE` transition.
- Every completed evaluation without a qualification lock is recorded once as a burned trial. Observed results cannot
  later be presented as untouched evidence, and the trial record cannot be updated, deleted, or truncated.
- Before reading candidate bars, Bayn atomically opens one immutable lock for the exact candidate run and snapshot. The
  lock binds the protocol, source and image, finalized data and bounds, universe rationale, every prior burned trial,
  every prior terminal qualification attempt, and content-hashed benchmark, threshold, statistical, and execution
  policies. Concurrent attempts converge on that same lock; a different lock for the candidate or snapshot fails
  closed.
- Qualification uses deterministic paired complete-rebalance-block bootstrap inference, Bonferroni-adjusted one-sided
  bounds, an explicit power requirement, and expanding-origin walk-forward gates. `QUALIFIED` requires both the
  economic evaluation and every statistical gate to pass; every other terminal outcome is `REJECTED`.
- The complete evaluation graph and its single terminal qualification result commit in one PostgreSQL transaction.
  Any terminal-result failure rolls the evaluation graph back and leaves the lock visibly incomplete. An incomplete
  lock is never silently retried and blocks every new candidate; a locked candidate cannot bypass the terminal result
  through the ordinary persistence path.
- The current-only migration chain owns the unprefixed evidence, qualification, intent, and mutation schema. Startup
  rejects a legacy migration tracker or retired migration history after the hard cut; it never reads, converts, or
  falls back to legacy records.
- Credentials provide GET-only Alpaca access under `OBSERVE`. The canonical non-dispatchable autonomous shadow loop
  composes `PaperStore` and `WriterFence` and performs one same-pass reconciliation when it builds a decision.
  `BrokerMutation`, `IntentStore`, `MutationStore`, and the coordinator remain absent; `PAPER` startup fails closed until
  the PROOMPT-375 Phase B authority generation and dispatch transition exists.
- Exact Alpaca asset reads preserve the returned status, tradability, fractionability, and normalized attributes as
  content-hashed evidence; the read adapter does not decide execution eligibility.
- The bounded Alpaca calendar observation is content-hashed with its request range, source/version, and normalized UTC
  sessions. A causal execution-session binding retains and revalidates that complete observation, selects its first
  post-signal session, and binds the session's exact open, close, pre-open cutoff, finalized Signal identity, and
  reconciled planning-state identity. Paper risk approves only in `[submissionOpenAt, submissionCutoffAt)` and
  reserves aggregate buying power across planned buys. The submit path rechecks the committed risk-decision expiry
  with the Effect clock, then atomically revalidates it in the fenced mutation-start transaction immediately before
  POST; the cutoff instant permits no new exposure and no durable `SUBMIT_STARTED` event. Cancellation is restricted
  to the exact broker order identified by the durable submit, the writer fence, maximum `PAPER`, and mutation-store
  authority. That de-risking path remains available after cutoff or approval expiry and while the kill is active.
- The execution path and independent reducer use integer micros for cash, quantity, prices, spread, slippage, fees,
  cash yield, positions, and every marked-equity point. Full, partial, and rejected orders are durable. Evaluation and
  recovery require exact zero-difference cash, fee, position, and equity reconstruction.
- On restart, Bayn derives the expected run ID from the verified Signal manifest and current executable identity. An
  exact terminal lock recovers the complete runtime-decoded PostgreSQL record without reading bars or mutating
  TigerBeetle. An opened lock without a terminal result, or altered or incompatible evidence, fails closed.
- After startup, one scoped Effect loop continuously checks PostgreSQL, the configured Signal manifest, the active
  TigerBeetle run, and the complete durable evidence record without loading bars or writing accounting state. Readiness
  closes on any defect and reopens only after every check succeeds; the last valid evidence remains observable.
- A transient dependency failure during startup exits the scoped process after releasing HTTP and clients so the
  Deployment can restart it. Deterministic contract, identity, or evidence failures remain observable as `FAILED`
  with readiness closed.
- A run becomes ready only after ClickHouse validation, evaluation, TigerBeetle journal creation, exact reconciliation,
  the PostgreSQL commit, and one successful continuous check. Strategy rejection is an auditable economic
  `FAIL_CLOSED`; it remains separate from operational health and never expands authority.

## PAPER proof discovery

The production executable has one explicit non-mutating proof-discovery mode. With neither `BAYN_PAPER_COMMAND` nor
`BAYN_PAPER_PREPARE_PHASE` set, Bayn follows its existing OBSERVE service and HTTP lifecycle unchanged. The only
accepted command pair is `BAYN_PAPER_COMMAND=PREPARE` with `BAYN_PAPER_PREPARE_PHASE=DISCOVER`; it has no default,
requires maximum authority `OBSERVE`, a terminal qualification pin, and a complete GET-only Alpaca account binding,
and exits before the HTTP application or autonomous loop is constructed.

DISCOVER opens one PostgreSQL `REPEATABLE READ, READ ONLY` transaction through the shared client and uses only
`CycleObservability` and `CycleStore` domain reads. It does not run migrations, create a reconciliation, re-run the
strategy or target planner, or compose `PaperStore`, `WriterFence`, any intent/mutation store, or broker mutation. The
latest cycle must be `COMPLETED` with zero unfinished cycles, and its strict persisted shadow document must remain
`PLANNED`, unexpired, bound to the same cycle, operational snapshot, account, terminal qualification, strategy,
source-controlled risk policy, and latest exact reconciliation. Durable maximum and effective authority must both be
`OBSERVE`, the durable authority generation must match the configured decoded generation hash, and every delta must
have only the mandatory `AuthorityNotPaper` risk failure.

After that immutable read snapshot, DISCOVER performs exactly one account GET and one asset GET for every ordered
persisted target delta, with bounded concurrency and restored document order. It emits every candidate without
selecting or filtering one. Persisted quantity, reference-price, notional, and risk values are labeled as historical
OBSERVE plan facts; they are non-authorizing and are not a future quantity cap. Asset eligibility is an explicit
review fact covering US equity class, active, tradable, fractionable, non-OTC, no `ipo`, and no `ptp_no_exception`;
ineligible assets remain in the receipt with all reasons and raw normalized evidence.

The ephemeral typed receipt contains an immutable cycle/document binding hash, a semantic `candidateFactsHash` that
excludes volatile observation timestamps and request metadata, and a complete observation receipt hash that changes
with fresh broker evidence. It exposes no Alpaca account number or credentials, writes no dossier, and reports
`consistencyDelayMs.status=REQUIRED_UNBOUND`; final PREPARE/SUBMIT/CANCEL/RECOVER and fresh SUBMIT-time planning remain
separate gated work.

## Endpoints

- `GET /livez`: process liveness.
- `GET /readyz`: current dependency, evidence, and accounting readiness.
- `GET /v1/status`: operational dependencies, data and evidence identity, terminal qualification, economic verdict,
  accounting, current build provenance, qualification-execution provenance, and the configured authority ceiling.
- `GET /v1/evaluations/:runId`: complete content-hashed evidence for one exact run ID. The service is ClusterIP-only
  and the Bayn network policy limits HTTP ingress to the namespace.

## Validation

```sh
bun run --filter @proompteng/bayn test
bun run --filter @proompteng/bayn tsc
bun run --filter @proompteng/bayn build
bun run --filter @proompteng/bayn lint:oxlint
```

For a terminal locked candidate, `audit:qualification` performs an operator-side, read-only reproduction. It reads the
evidence graph in one PostgreSQL `REPEATABLE READ, READ ONLY` transaction, reloads the finalized Signal snapshot,
replays the candidate and all benchmarks without importing the production strategy, checks ClickHouse query-start
chronology on every physical ClickHouse replica with a separately supplied audit principal, and checks authoritative
`origin/main` history. Query-log classification uses ClickHouse's recorded table metadata rather than spoofable SQL
text. It emits one `bayn.qualification-audit.v2` JSON report and exits nonzero on any failed check. Run it twice and
require identical `auditHash` values.

The current auditor independently replays only causal protocol v3 evidence. Protocol v2 remains recoverable by run ID,
but its rejected qualification must be replayed with the source revision and immutable image recorded on that run; a
current-source audit fails explicitly instead of applying v3 semantics to historical evidence.

```sh
BAYN_AUDIT_RUN_ID=<run-id> \
BAYN_AUDIT_POSTGRES_URL=<authenticated-postgres-uri> \
BAYN_AUDIT_SIGNAL_URL=<signal-clickhouse-url> \
BAYN_AUDIT_SIGNAL_USERNAME=<readonly-bayn-user> \
BAYN_AUDIT_SIGNAL_PUBLISHER_USERNAME=<signal-publisher-user> \
BAYN_AUDIT_SIGNAL_PASSWORD=<readonly-bayn-password> \
BAYN_AUDIT_CLICKHOUSE_URLS=<replica-0-audit-url>,<replica-1-audit-url> \
BAYN_AUDIT_CLICKHOUSE_USERNAME=<query-log-audit-user> \
BAYN_AUDIT_CLICKHOUSE_PASSWORD=<query-log-audit-password> \
BAYN_AUDIT_REPOSITORY_PATH=<lab-checkout> \
  bun run --filter @proompteng/bayn audit:qualification
```

The audit command is not part of the deployed runtime and never calls TigerBeetle or a broker. Its privileged
ClickHouse credential is operator-supplied only to read `system.query_log`; the service keeps its normal Signal
read-only identity. Any recorded bars-table access takes fail-closed precedence over sessions or manifests; SQL aliases
cannot relabel a read. The log cannot retroactively prove that an operator query returned only bounded count/hash
evidence, so any Signal-table read by a principal other than the candidate or declared publisher makes the audit fail.

Before the one-shot qualification release, `candidate:qualification` verifies one exact natural Signal publication
without opening a qualification lock or changing any system. It requires two direct physical ClickHouse endpoints and
uses the declared Signal publisher principal to select the latest correction for the compiled Bayn universe on each
replica with ClickHouse `readonly=1`. It then fully loads and cryptographically verifies the manifest, sessions, bars,
duplicate keys, cardinalities, and content hashes on both replicas; requires identical canonical snapshot bytes and
complete topology coverage; and checks in a PostgreSQL `REPEATABLE READ, READ ONLY` transaction that the snapshot has no
qualification lock.

The publisher principal is deliberate: this command reads candidate bars before Bayn opens the lock, so the later
qualification audit must receive the same value as `BAYN_AUDIT_SIGNAL_PUBLISHER_USERNAME`. Using the ordinary Bayn
principal for this pre-lock full read contaminates the candidate chronology. The command emits deterministic
`bayn.qualification-candidate.v1` JSON containing the complete `BaynCandidateRuntime` expected by the release writer,
with Signal bounds derived only from the compiled protocol and the supplied TigerBeetle identity. It does not publish
Signal data, invoke a backfill, acquire a lock, run Bayn, or write PostgreSQL.

When PostgreSQL TLS is enabled, `BAYN_CANDIDATE_POSTGRES_TLS_SERVER_NAME` is required and must be the DNS identity in
the CNPG server certificate; for Bayn it is `bayn-db-rw.bayn`. Node-postgres replaces an explicit TLS server name when
the connection host is a non-IP DNS name, so a local port-forward URI must use `127.0.0.1`, never `localhost`. A DNS
connection host is accepted only when it exactly equals the configured certificate identity. TLS or routing query
parameters are forbidden because connection-string parameters can override the explicit verified SSL object. Derive
the authenticated `postgresql://...@127.0.0.1:<dynamic-port>/bayn` URI in memory from the approved CNPG secret, load
the publisher password without echoing it, and keep shell tracing disabled. When PostgreSQL TLS is disabled, both
TLS-only variables must be absent rather than silently ignored.

```sh
(
  set -euo pipefail
  set +x
  umask 077

  : "${BAYN_CANDIDATE_SIGNAL_PUBLICATION_DATE:?required}"
  : "${BAYN_CANDIDATE_CLICKHOUSE_URLS:?required}"
  : "${BAYN_CANDIDATE_SIGNAL_PUBLISHER_USERNAME:?required}"
  : "${BAYN_CANDIDATE_SIGNAL_PUBLISHER_PASSWORD:?load securely without printing}"
  : "${BAYN_CANDIDATE_POSTGRES_URL:?load securely without printing}"
  : "${BAYN_CANDIDATE_POSTGRES_TLS:?required}"
  : "${BAYN_CANDIDATE_TIGERBEETLE_CLUSTER_ID:?required}"
  : "${BAYN_CANDIDATE_TIGERBEETLE_ADDRESSES:?required}"
  : "${BAYN_CANDIDATE_TIGERBEETLE_LEDGER:?required}"
  if [[ "${BAYN_CANDIDATE_POSTGRES_TLS}" == true ]]; then
    : "${BAYN_CANDIDATE_POSTGRES_CA_PATH:?required with PostgreSQL TLS}"
    : "${BAYN_CANDIDATE_POSTGRES_TLS_SERVER_NAME:?required with PostgreSQL TLS}"
  fi

  candidate_tmp_root="${TMPDIR:-/tmp}"
  candidate_tmp_root="${candidate_tmp_root%/}"
  candidate_tmp_dir="$(mktemp -d "${candidate_tmp_root}/bayn-candidate.XXXXXXXX")"
  candidate_stderr="${candidate_tmp_dir}/verifier.stderr"
  cleanup_candidate() {
    rm -f -- "${candidate_stderr}"
    rmdir -- "${candidate_tmp_dir}"
  }
  trap cleanup_candidate EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM

  if candidate_receipt="$(bun run --filter @proompteng/bayn candidate:qualification 2>"${candidate_stderr}")"; then
    :
  else
    status=$?
    # The command's typed stderr is credential-safe; emit it once before the EXIT trap deletes the private file.
    cat -- "${candidate_stderr}" >&2
    printf 'candidate verification failed with status %d; stop without retry\n' "${status}" >&2
    exit "${status}"
  fi

  unset BAYN_CANDIDATE_SIGNAL_PUBLISHER_PASSWORD BAYN_CANDIDATE_POSTGRES_URL
  jq -e \
    --arg publication "${BAYN_CANDIDATE_SIGNAL_PUBLICATION_DATE}" \
    --arg principal "${BAYN_CANDIDATE_SIGNAL_PUBLISHER_USERNAME}" '
    .snapshotCanonicalHash as $snapshotHash
    | .schemaVersion == "bayn.qualification-candidate.v1"
    and .publicationDate == $publication
    and .publisherPrincipal == $principal
    and .qualificationLockCount == 0
    and ($snapshotHash | test("^[a-f0-9]{64}$"))
    and (.inputManifestHash | test("^[a-f0-9]{64}$"))
    and (([.replicas[].replica] | sort) == [
      "chi-torghut-clickhouse-default-0-0-0",
      "chi-torghut-clickhouse-default-0-1-0"
    ])
    and (([.replicas[].endpointHost] | unique | length) == 2)
    and (([.replicas[].snapshotCanonicalHash] | unique) == [$snapshotHash])
    and (.candidateRuntime.BAYN_SIGNAL_SNAPSHOT_ID | test("^[a-f0-9]{64}$"))
    and .candidateRuntime.BAYN_SIGNAL_PUBLICATION_ASOF == $publication
    and .candidateRuntime.BAYN_SIGNAL_DATA_END == $publication
    and .candidateRuntime.BAYN_SIGNAL_EVALUATION_END == $publication
    and (.candidateRuntime | all(.[]; type == "string" and length > 0))
  ' <<<"${candidate_receipt}" >/dev/null

  # The separately authorized writer must be the next command in this subshell and consume candidate_receipt directly.
  # Otherwise exit here and let the subshell discard it. Never tee or redirect the receipt into a repository,
  # worktree, generated dossier, or persistent JSON file.
)
```

Set `BAYN_AUDIT_OUTPUT=dossier` on the same command to emit `bayn.qualification-dossier.v2`. The deterministic dossier
binds the full audited subject, evidence-set hashes, immutable lock/result, prior trials, contamination records,
verdict, and observe-only authority. It is ephemeral operator/CI evidence, not runtime configuration. Runtime recovery
uses only `BAYN_QUALIFICATION_RUN_ID` to load the immutable EvidenceStore graph; Bayn never mounts or reads a dossier
file.

The PostgreSQL integration suite requires an isolated local database whose name ends in `_test`:

```sh
BAYN_TEST_POSTGRES_URL=postgresql://bayn:bayn@127.0.0.1:5432/bayn_test \
  bun test services/bayn/src/db/evidence-store.integration.test.ts
```

The current candidate reads `adjusted_daily_bars_v2`, `exchange_sessions_v1`, and `snapshot_manifests_v2` through the
official Effect ClickHouse client. Bayn's Signal identity is read-only and has no DDL, insert, or mutation authority.
