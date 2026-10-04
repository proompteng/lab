# 56. Jangar Capability Receipts and Consumer Binding Contract (2026-03-20)

Status: Approved for implementation (`plan`)
Date: `2026-03-20`
Owner: Gideon Park (Torghut Traders)
Mission: `codex/swarm-torghut-quant-plan`
Swarm impacts:

- `jangar-control-plane`
- `torghut-quant`

Companion doc:

- `docs/torghut/design-system/v6/55-torghut-hypothesis-settlement-exchange-and-lane-capability-leases-2026-03-20.md`

Extends:

- `54-jangar-admission-receipts-rollout-shadow-and-anti-entropy-reconciliation-2026-03-20.md`
- `54-jangar-witness-mirror-quorum-and-promotion-veto-2026-03-20.md`
- `53-jangar-dependency-provenance-ledger-and-consumer-acknowledged-admission-2026-03-19.md`
- `51-jangar-control-plane-execution-cells-and-collaboration-failover-2026-03-19.md`

## Executive summary

The decision is to make Jangar publish one durable capability-receipt fabric and one binding contract for every
consumer that depends on rollout truth. `/ready`, `/api/agents/control-plane/status`, deploy verification, and Torghut
profitability consumers must project the same receipts instead of recomputing permissive answers from different source
subsets.

The reason is visible in the live system on `2026-03-20`:

- `GET http://jangar.jangar.svc.cluster.local/ready`
  - returns `status="ok"`
  - reports `agentsController.enabled=false`
  - reports `supportingController.enabled=false`
- `GET http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status?namespace=agents`
  - reports `controllers.agents-controller.status="healthy"`
  - reports `controllers.supporting-controller.status="healthy"`
  - reports `rollout_health.status="healthy"`
  - reports `dependency_quorum.decision="allow"`
  - also reports `empirical_services.forecast.status="degraded"`
- `kubectl get pods -n jangar -o wide`
  - shows the active `jangar` and `jangar-worker` pods on the `3734f9c9` image with fresh rollouts
- `kubectl get events -n jangar --sort-by=.lastTimestamp | tail -n 40`
  - shows a transient readiness failure during startup, then clean rollout completion
- `packages/scripts/src/jangar/verify-deployment.ts`
  - still validates Argo sync, rollout health, and image digests independently from Jangar runtime receipt truth
- `services/torghut/app/trading/submission_council.py`
  - falls back from `TRADING_JANGAR_QUANT_HEALTH_URL` to `TRADING_JANGAR_CONTROL_PLANE_STATUS_URL`
  - therefore lets a generic control-plane endpoint masquerade as quant-evidence authority

The tradeoff is deliberate: more persisted authority state, stronger receipt TTLs, and stricter consumer binding
validation. That is the correct trade because the current system can see contradictory evidence and still emit
consumer-specific green answers.

## Mission inputs and success criteria

Observed mission inputs:

- repository: `proompteng/lab`
- base: `main`
- head: `codex/swarm-torghut-quant-plan`
- swarmName: `torghut-quant`
- swarmStage: `plan`
- objective: assess cluster/source/database state and create/update+merge required design-document PRs that improve,
  maintain, and innovate Torghut quant

This artifact succeeds when:

1. Jangar emits one receipt graph that every control-plane and Torghut consumer can reference by id and digest;
2. missing, stale, or contradictory critical receipts become `hold` or `block`, never implicit warnings;
3. deployer validation depends on the same receipt contract used by runtime status surfaces;
4. the engineer and deployer stages can test receipt parity, rollout safety, and rollback semantics without reading
   multiple ad hoc endpoints.

## Assessment snapshot

### Cluster health, rollout, and event evidence

Current live evidence shows that Jangar health is stronger than yesterday, but the authority contract is still split:

- Jangar workload rollout is healthy right now:
  - `jangar-88b89fd75-p2wg7` and `jangar-worker-55d988b84d-qp5q9` are `Running` with zero restarts on the current
    image;
  - the last namespace events show clean delete-create-replace rollout behavior after one startup readiness miss.
- Jangar route truth is still inconsistent:
  - `/ready` reports controller enablement from local route state;
  - `/api/agents/control-plane/status` derives controller health from rollout and heartbeat evidence;
  - the two routes therefore publish materially different controller truth for the same moment.
- Jangar still tolerates incomplete downstream truth:
  - control-plane status marks forecast degraded, but top-level `dependency_quorum` remains `allow`;
  - Torghut can therefore observe a green control-plane verdict while a profit-relevant capability is degraded.

Interpretation:

- Jangar has enough evidence to distinguish "cluster healthy" from "all consumers may safely promote";
- the missing primitive is not more metrics, but one receipt compiler that all consumers are forced to reuse.

### Source architecture and high-risk modules

The current branch explains the live contradiction directly:

- `services/jangar/src/routes/ready.tsx`
  - builds readiness from local controller helpers and optional execution trust;
  - it does not project the richer receipt set already available to control-plane status;
  - local enablement flags can therefore disagree with rollout-derived authority.
- `services/jangar/src/server/control-plane-status.ts`
  - can see leader election, rollout health, watch reliability, workflow health, and empirical service status;
  - still compresses that evidence into a single `dependency_quorum` answer without publishing a reusable receipt id;
  - allows consumer-specific interpretation because receipts are not first-class objects yet.
- `packages/scripts/src/jangar/verify-deployment.ts`
  - verifies rollout and Argo state independently from runtime receipt truth;
  - can therefore disagree with runtime health semantics and still pass deployment verification.
- `services/torghut/app/trading/submission_council.py`
  - falls back to a generic control-plane status endpoint when explicit quant-health wiring is absent;
  - this is proof that Jangar currently exposes too little typed capability authority to downstream consumers.

Current missing regression coverage:

- no regression proving `/ready`, `/api/agents/control-plane/status`, and deployment verification project the same
  receipt set and digest;
- no regression proving critical receipt freshness expiry forces `hold` or `block`;
- no regression proving an untyped generic endpoint cannot satisfy a quant-evidence binding;
- no regression proving degraded downstream capability subjects are visible as receipt-level vetoes rather than
  consumer-specific warnings.

### Database, schema, and continuity evidence

Database continuity is healthy enough to support additive receipt persistence.

- control-plane status reports:
  - `database.status="healthy"`
  - `migration_consistency.applied_count=24`
  - `migration_consistency.unapplied_count=0`
- direct database exec remains RBAC-forbidden for this worker:
  - `kubectl cnpg psql -n jangar jangar-db ...`
  - returns `pods/exec is forbidden`
- that limitation does not change the architectural conclusion:
  - storage is reachable by Jangar;
  - the missing capability is durable receipt compilation and consumer binding, not raw database access.

## Problem statement

Jangar still has four authority gaps that matter for the next six months:

1. route-level readiness and control-plane status are not projections of one durable authority object;
2. downstream consumers can satisfy critical bindings from generic or lossy endpoints;
3. deployment verification has no requirement to match runtime receipt truth;
4. receipt freshness, provenance, and acknowledgement are visible in parts of the system, but not enforced as one
   consumer contract.

That weakens rollout safety and it weakens Torghut profitability. The same ambiguity that lets Jangar say "ready" from
two different evidence sets also lets Torghut treat the wrong Jangar endpoint as admissible profit evidence.

## Alternatives considered

### Option A: centralize all rollout and profit authority inside Jangar

Summary:

- Jangar owns every receipt, including Torghut hypothesis-capital decisions;
- Torghut becomes a thin consumer of Jangar-issued promotion answers.

Pros:

- one control-plane owner;
- strongest central consistency;
- easiest deployer story.

Cons:

- Jangar becomes coupled to Torghut lane economics and hypothesis semantics;
- failure-domain isolation is worse because one control plane would own both infrastructure truth and local profit
  truth;
- future option value is reduced because every strategy-specific gate becomes a Jangar change.

Decision: rejected.

### Option B: keep current endpoints and add more warnings plus stronger docs

Summary:

- preserve `/ready`, control-plane status, and deploy verification as separate computations;
- document how consumers should interpret the differences.

Pros:

- smallest code delta;
- no new persistence.

Cons:

- preserves the current contradiction;
- keeps rollout safety dependent on human interpretation;
- does not prevent generic endpoints from satisfying the wrong consumer.

Decision: rejected.

### Option C: Jangar capability receipts plus explicit consumer bindings

Summary:

- Jangar compiles typed capability receipts;
- each consumer declares the exact receipts, freshness, and digest constraints it requires;
- consumers project the same receipt graph rather than re-deriving truth.

Pros:

- preserves Jangar as infrastructure-truth owner without making it the owner of Torghut lane economics;
- makes wrong-endpoint or stale-endpoint usage structurally impossible;
- gives deployers and runtime the same authority source;
- expands cleanly as more capabilities or consumers arrive.

Cons:

- adds receipt and binding persistence;
- requires a staged migration because existing consumers will dual-read for a period.

Decision: selected.

## Decision

Adopt **Option C**.

Jangar will become the issuer of typed capability receipts and explicit consumer-binding contracts. Consumers may still
render their own payloads, but they may not choose a different source of truth.

## Architecture

### 1. Capability receipt compiler

Add additive Jangar persistence:

- `control_plane_capability_receipts`
  - `receipt_id`
  - `subject_kind`
  - `subject_name`
  - `source_system`
  - `status` (`allow`, `hold`, `block`, `unknown`)
  - `fresh_until`
  - `observed_at`
  - `rollout_epoch`
  - `evidence_digest`
  - `evidence_refs_json`
  - `payload_json`
- `control_plane_capability_compiler_runs`
  - one row per receipt compilation pass with digest summary, changed-subject count, and failure summary

Initial receipt subjects:

- `control-plane.rollout.jangar`
- `control-plane.workflow.agents`
- `control-plane.watch-stream.agents`
- `control-plane.collaboration.huly`
- `torghut.quant-evidence.<account>.<window>`
- `torghut.market-context.<symbol-or-bundle>`
- `torghut.options-bootstrap.catalog`
- `torghut.options-bootstrap.enricher`
- `torghut.options-bootstrap.ta`
- `torghut.empirical.forecast`

Rule:

- receipt subjects are typed and non-interchangeable;
- a generic control-plane summary cannot satisfy a quant-evidence binding.

### 2. Consumer binding contract

Add `control_plane_capability_bindings`:

- `consumer_name`
- `required_subject_kind`
- `required_subject_name_pattern`
- `min_status`
- `max_staleness_seconds`
- `digest_scope`
- `block_on_unknown`
- `notes`

Initial consumers:

- `jangar.ready-route`
- `jangar.control-plane-status`
- `jangar.verify-deployment`
- `torghut.live-submission-gate`
- `torghut.scheduler`
- `torghut.readyz`

Example:

- `torghut.live-submission-gate` must bind to:
  - `torghut.quant-evidence.<account>.<window>`
  - `torghut.market-context.<bundle>`
  - `control-plane.rollout.jangar`
  - any lane-specific `torghut.options-bootstrap.*` subject when the hypothesis requests options capability

### 3. Projection rules

Projection changes:

- `/ready`
  - no longer computes final readiness from local helper fragments alone;
  - it reads the `jangar.ready-route` binding result and projects the same receipt digest used everywhere else.
- `/api/agents/control-plane/status`
  - publishes the receipt graph summary plus binding outcomes;
  - keeps human-readable summaries, but the authoritative unit is receipt id plus digest.
- deploy verification
  - must read the `jangar.verify-deployment` binding outcome and confirm digest parity with runtime;
  - rollout, Argo sync, and digest checks remain inputs, not final authority.

### 4. Anti-entropy and acknowledgement

Receipt truth needs anti-entropy because some producers are pull-based and some are push-based.

Add:

- background recompiler on fixed cadence;
- digest comparison between latest producer payload and latest receipt;
- `control_plane_capability_acknowledgements` for downstream consumers that have consumed a given receipt digest.

Important rule:

- Jangar may only claim promotion-friendly authority when required receipt subjects are fresh and the required consumer
  acknowledgements for the active rollout epoch exist.

### 5. Config and contract hardening

Jangar becomes the owner of typed capability endpoints, not just a generic status blob.

Implementation contract:

- expose and document typed endpoint contracts for:
  - quant health
  - market context
  - options bootstrap
  - control-plane rollout authority
- reject ambiguous consumer configuration during startup or deploy verification;
- publish machine-readable binding metadata in the control-plane status response.

## Validation gates

Engineer acceptance gates:

1. add targeted tests proving `/ready`, control-plane status, and deployment verification share one receipt digest;
2. add a regression proving `unknown` or stale critical receipts force `hold` or `block`;
3. add a regression proving a generic control-plane URL cannot satisfy a quant-evidence binding;
4. add a regression proving consumer acknowledgement is required before rollout-friendly authority is emitted.

Deployer acceptance gates:

1. runtime and deploy verification must report the same receipt digest for the active rollout epoch;
2. any critical receipt in `unknown` or expired state blocks rollout completion;
3. Torghut consumers must show receipt ids for the capability subjects they depend on;
4. rollback is mandatory if digest parity breaks across `/ready`, control-plane status, and deploy verification after
   cutover.

## Rollout plan

1. Ship receipt writes and binding definitions in shadow mode.
2. Publish digest-parity fields in `/ready` and control-plane status without changing top-level verdicts.
3. Update deploy verification to require digest parity, but only warn on mismatch for one release.
4. Switch `/ready` and deploy verification to receipt-bound verdicts.
5. Cut Torghut consumers to typed bindings only after parity has held for one release window.

## Rollback plan

If receipt cutover causes noisy or incorrect holds:

1. keep writing receipts and compiler runs;
2. switch consumer verdicts back to legacy logic behind a feature flag;
3. preserve binding-mismatch telemetry so the parity gap can be fixed before re-cutover.

Rollback is a projection rollback, not a schema rollback.

## Risks and open questions

- The main risk is receipt explosion if subjects are defined too granularly. Start with capability-level subjects, not
  per-pod receipts.
- Binding strictness can create noisy holds if freshness budgets are unrealistic. That is why the rollout includes a
  shadow phase and explicit deployer parity gates.
- Huly collaboration should remain a typed capability subject for swarm stages, but it must not be allowed to block
  unrelated market-data consumers.

## Handoff contract

Engineer handoff:

- implement additive receipt and binding tables;
- wire `/ready`, control-plane status, and deploy verification to emit receipt ids and digests;
- add explicit endpoint typing so Torghut cannot consume the wrong Jangar authority surface;
- land the receipt/binding regression suite before enabling verdict cutover.

Deployer handoff:

- require digest parity across runtime and deploy verification before approving rollout;
- treat stale, unknown, or contradictory critical receipts as a rollout block;
- keep rollback limited to projection cutover unless storage or compiler integrity is compromised.
