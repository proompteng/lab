# 129. Jangar Consumer Evidence Leases And Readiness Decoupling (2026-05-06)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-06
Owner: Victor Chen, Jangar Engineering Architecture
Scope: Jangar control-plane evidence products, controller witness freshness, schedule dispatch admission, Torghut
consumer readiness, capital admission, database/schema health projection, and cross-swarm rollout gates.

Companion Torghut contract:

- `docs/torghut/design-system/v6/133-torghut-capital-readiness-cache-and-profit-carry-governor-2026-05-06.md`

Extends:

- `128-jangar-terminal-run-settlement-and-forecast-reentry-admission-2026-05-06.md`
- `128-jangar-runtime-convergence-ledger-and-capital-gate-receipts-2026-05-06.md`
- `127-jangar-session-rehearsal-conductor-and-capital-settlement-gates-2026-05-06.md`
- `120-jangar-material-action-verdict-arbiter-and-clock-budget-parity-2026-05-06.md`

## Decision

I am selecting a **consumer evidence lease and readiness decoupling** contract for the next Jangar control-plane step.

The current cluster is not in a serving outage. At `2026-05-06T20:26Z`, the Jangar namespace had `8` running pods, the
agents namespace had `9` running pods, and `deployment/agents` plus `deployment/agents-controllers` were available.
Jangar's status route reported database `connected=true`, `status=healthy`, `latency_ms=3`, and `28/28` Kysely
migrations applied through `20260505_torghut_quant_pipeline_health_window_index`. Watch reliability was also healthy:
the status route reported `6400` AgentRun watch events, `0` watch errors, and `1` restart in the 15-minute window.

The failure mode is now cross-consumer evidence ambiguity. The same Jangar status payload marked normal dispatch as
`repair_only`, requiring a fresh controller-process ingestion witness, even while rollout health was green. Torghut
`/readyz` returned HTTP `503` because its alpha-readiness dependency quorum fetch timed out against Jangar. Torghut
Postgres and ClickHouse were healthy, empirical jobs were fresh, and the live submission gate was already disabled by
`simple_submit_disabled`, so a synchronous Jangar fetch failure is the wrong reason for operational readiness to fail.
It is the right reason to hold paper/live capital and normal dispatch.

The selected design makes Jangar publish compact, expiring consumer evidence leases. Consumers such as Torghut use
those leases instead of rebuilding Jangar control-plane truth synchronously during readiness. The lease separates three
questions that are currently entangled:

1. can the service answer operational traffic;
2. can the control plane dispatch normal work;
3. can a consumer spend capital or widen deployment?

The tradeoff is one more evidence product and cache lifecycle to operate. I accept that. A timeout in a cross-service
status fetch should not erase the difference between "serve read-only", "repair control-plane evidence", and "spend
capital". Jangar should own that distinction and hand consumers a short-lived proof they can reason about.

## Runtime Objective And Success Metrics

This contract improves Jangar reliability by reducing false readiness coupling and making controller witness debt an
explicit lease failure instead of a broad service degradation.

Success means:

- Jangar emits a per-consumer evidence lease with expiry, action class decisions, source references, and rollback
  targets.
- Torghut can remain operationally ready when its local database, broker, ClickHouse, and service probes are healthy,
  even if the latest Jangar lease is stale within the operational grace window.
- Normal dispatch remains `repair_only` while controller-process witness freshness is missing.
- Paper/live capital remains held when Jangar evidence is stale, missing, contradicted, or below the capital freshness
  threshold.
- Readiness, dispatch, deploy widening, and capital admission use different freshness thresholds and are visible in
  the same status projection.

## Evidence Snapshot

All checks were read-only. I did not mutate Kubernetes resources, database rows, GitOps manifests, broker state,
trading flags, or runtime objects.

### Cluster And Rollout Evidence

- Runtime identity was `system:serviceaccount:agents:agents-sa`.
- `kubectl config current-context` was initially unset and was bootstrapped locally from the in-cluster service-account
  token.
- Jangar namespace phase count was `Running=8`.
- `deployment/jangar` was `1/1` with image
  `registry.ide-newton.ts.net/lab/jangar:885c987a@sha256:58a03e02e5d28314d8315d1d57f046592c18168e52c0fe8874b2885ffe2e2a15`.
- Agents namespace phase count was `Running=9`, `Error=37`, and `Completed=227`.
- `deployment/agents` was `1/1`; `deployment/agents-controllers` was `2/2`.
- Recent agents events showed fresh readiness probe timeouts against `agents` and both `agents-controllers` pods:
  `Client.Timeout exceeded while awaiting headers`.
- Retained Error pod logs for older failed schedule jobs were no longer retrievable from containerd, proving that
  Kubernetes pod retention is not a durable evidence store.
- Torghut namespace phase count was `Pending=1`, `Running=27`, and `Completed=5`.
- Torghut recent events showed warm-up readiness and startup probe failures on current live and sim revisions before
  those revisions became ready, plus repeated ClickHouse PodDisruptionBudget ambiguity.
- CNPG cluster `get` and pod `exec` were forbidden for both `jangar` and `torghut`; direct database internals are not a
  reliable validation surface for this worker identity.

### Source Evidence

- `services/jangar/src/server/supporting-primitives-controller.ts` is `2931` lines and owns schedule generation,
  CronJob reconciliation, workspace PVC lifecycle, swarm admission, freezes, requirements, and status updates. It is
  still the highest-blast-radius Jangar module for dispatch admission.
- `services/jangar/src/server/primitives-kube.ts` now supports `PersistentVolumeClaim`, `pvc`, and `pvcs`, so the
  earlier PVC blind spot is closed.
- `services/jangar/src/server/control-plane-status.ts` is `781` lines and composes rollout, watch reliability,
  database, workflows, runtime admission, failure-domain leases, action clocks, negative evidence, controller witness,
  empirical services, and material action receipts.
- `services/jangar/src/server/control-plane-material-action-verdict.ts` is `473` lines and already reduces dependency
  quorum, action SLO budgets, action clocks, rollout health, controller witness, database, watch reliability, and
  empirical services into material action decisions.
- `services/torghut/app/trading/hypotheses.py` contains `load_jangar_dependency_quorum()`, which performs a
  synchronous `urlopen()` to the configured Jangar status URL and turns fetch exceptions into
  `decision=unknown`, `reason=jangar_status_fetch_failed`.
- `services/torghut/app/main.py` is `4051` lines and calls the Jangar dependency quorum loader from readiness,
  trading status, metrics, runtime profitability, and live submission gate surfaces.
- Existing tests cover many reducers and route surfaces, but the missing regression is consumer lease behavior when
  Jangar is locally healthy, the consumer status fetch times out, and capital must remain held while operational
  readiness stays open.

### Database And Data Evidence

- Jangar status reported database `configured=true`, `connected=true`, `status=healthy`, `latency_ms=3`.
- Jangar migration consistency reported `registered_count=28`, `applied_count=28`, `unapplied_count=0`,
  `unexpected_count=0`, and latest applied `20260505_torghut_quant_pipeline_health_window_index`.
- Jangar memory stats over seven days reported activity on `2026-05-05` and `2026-05-06`, including `268` memories on
  `2026-05-06` and top namespaces for `torghut-quant-discover` and `jangar-control-plane-plan`.
- Direct CNPG reads were blocked by RBAC, so this contract treats app-level health projection as the normal database
  evidence source and privileged SQL as an escalation surface only.
- Torghut `/db-check` returned HTTP `200` with `schema_current=true`, current head
  `0029_whitepaper_embedding_dimension_4096`, `schema_graph_branch_count=1`, no missing or unexpected heads, and
  `account_scope_ready=true`.
- Torghut `/db-check` also reported known migration parent forks at
  `0010_execution_provenance_and_governance_trace` and `0015_whitepaper_workflow_tables`; they are warnings, not an
  applied-head mismatch.
- Torghut `/readyz` returned HTTP `503` while local dependencies `postgres`, `clickhouse`, `alpaca`, `database`,
  `universe`, and `empirical_jobs` were `ok=true`; the degraded dependency was alpha-readiness dependency quorum with
  `jangar_status_fetch_failed`.
- Torghut runtime profitability over the 72-hour window reported `decision_count=25`, `execution_count=0`,
  `tca_sample_count=0`, and live submission blocked by `simple_submit_disabled`.
- Torghut Doc 29 completion reported `blocked=6`, `stale=2`, `satisfied=1`, with empirical jobs persisted fresh but
  paper, live canary, and live scale gates blocked.

## Problem

Jangar has accumulated enough internal evidence reducers that individual status fields can now disagree correctly.
That is progress. The system still lacks a clean consumer contract for those disagreements.

Today a consumer has to fetch the full Jangar status payload and interpret it inline. When the fetch times out, Torghut
marks dependency quorum unknown and degrades readiness. When the fetch succeeds, the consumer still has to know that
`database=healthy`, `watch=healthy`, `dispatch_normal=repair_only`, `paper_canary=hold`, and `live_scale=block` are not
contradictions. They are different action classes.

This is fragile for three reasons:

1. service readiness and capital readiness share one dependency call path;
2. consumers have to duplicate Jangar action-class semantics;
3. old terminal pods and transient rollout warnings keep leaking into operator interpretation even after Jangar has
   enough evidence to classify them.

The architecture needs a consumer-facing lease product that is smaller than the full status payload, carries explicit
freshness, and says which action classes can proceed.

## Alternatives Considered

### Option A: Strict Synchronous Readiness

Require every consumer readiness route to fetch live Jangar status and fail closed whenever the call fails.

Pros:

- Simple safety story.
- No stale cache semantics.
- Fast to implement by tightening timeouts and required flags.

Cons:

- Turns a Jangar status timeout into Torghut operational unavailability even when local dependencies are healthy.
- Couples rollout warm-up and network jitter to service readiness.
- Does not improve dispatch or capital decisions; it only broadens the blast radius.
- Encourages operators to increase timeouts instead of fixing evidence freshness.

Decision: reject. This is appropriate for live capital admission, not for basic service readiness.

### Option B: Bigger Status Cache And Retry Budget

Keep the current synchronous status contract but add larger TTLs, retries, and fallback behavior inside each consumer.

Pros:

- Lower schema cost.
- Preserves current route contract.
- Can reduce immediate `/readyz` flakes.

Cons:

- Still forces Torghut and other consumers to interpret Jangar internals.
- Hides whether stale data is acceptable for readiness, dispatch, deploy widening, or capital.
- Makes each consumer implement its own cache invalidation and action-class logic.
- Does not create a durable audit product for deployer and engineer stages.

Decision: reject. It treats the symptom, not the control-plane contract.

### Option C: Consumer Evidence Lease Exchange

Jangar emits compact evidence leases per consumer and action class. Consumers cache leases and apply tiered freshness
budgets: operational readiness can use a short grace window, normal dispatch requires fresh controller witness, and
capital requires strict current proof.

Pros:

- Separates service readiness from dispatch and capital admission.
- Keeps Jangar as the owner of action-class semantics.
- Makes stale and missing evidence visible without over-blocking read-only service paths.
- Gives deployer and engineer stages a small acceptance surface.
- Preserves fail-closed behavior for paper/live capital.

Cons:

- Adds a new product schema and expiry policy.
- Requires consumer tests for stale, missing, and contradicted leases.
- Needs careful rollout so stale leases do not mask real Jangar outages.

Decision: select Option C.

## Architecture

Jangar emits one lease set per consumer and target namespace:

```text
consumer_evidence_lease_set
  lease_set_id
  generated_at
  expires_at
  producer_revision
  consumer
  namespace
  source_status_ref
  database_ref
  rollout_ref
  watch_ref
  controller_witness_ref
  terminal_settlement_ref
  empirical_services_ref
  action_leases[]
  contradictions[]
```

Each action lease is intentionally small:

```text
consumer_action_lease
  action_class        # serve_readonly, dispatch_repair, dispatch_normal, deploy_widen, merge_ready,
                      # torghut_observe, paper_canary, live_micro_canary, live_scale
  decision            # allow, allow_grace, repair_only, hold, block, unknown
  confidence          # high, medium, low, unknown
  fresh_until
  grace_until
  max_dispatches
  max_runtime_seconds
  max_notional
  required_repairs
  evidence_refs
  rollback_target
```

Freshness policy:

- `serve_readonly`: can use a stale-but-recent lease during a short grace window when local service dependencies are
  healthy.
- `dispatch_repair`: can use a stale lease only to repair the evidence product itself.
- `dispatch_normal`: requires fresh database, rollout, watch, terminal settlement, and controller witness leases.
- `deploy_widen`: requires fresh database, source schema, rollout, registry, and rollback refs.
- `torghut_observe`: can proceed with fresh local data and a non-contradicted Jangar lease.
- `paper_canary`, `live_micro_canary`, and `live_scale`: require current Jangar lease, current Torghut proof, and no
  controller witness contradiction.

Storage and transport:

- The authoritative projection lives in Jangar's existing database-backed status path.
- The serving route exposes the compact lease beside the full status payload.
- NATS publishes a short lease summary for live coordination, never as the durable source of truth.
- Consumers may cache the latest valid lease but must preserve the lease id and source status ref in their own route
  payloads.

## Implementation Scope

Engineer stage:

- Add a pure `buildConsumerEvidenceLeaseSet()` reducer under `services/jangar/src/server/`.
- Feed it from existing status inputs: database, rollout health, watch reliability, controller witness, terminal
  settlement, material action verdicts, and empirical services.
- Add `consumer_evidence_leases` to `/api/agents/control-plane/status?namespace=agents` in shadow mode.
- Add fixtures for the current state: Jangar healthy, AgentRun ingestion witness missing, `dispatch_normal=repair_only`,
  Torghut forecast degraded, paper/live held.
- Add a Torghut consumer fixture proving a Jangar fetch timeout can keep service readiness open only when the cached
  lease is inside `grace_until`, while paper/live remain blocked.

Deployer stage:

- Enable lease route emission before any enforcement.
- Compare lease decisions to existing material action receipts for two windows.
- Switch Torghut readiness to lease-aware grace only after route parity is proven.
- Keep capital admission on strict current leases until paper/live proof gates are implemented and green.

## Validation Gates

Required local checks for this document PR:

- `bunx oxfmt --check docs/agents/designs/129-jangar-consumer-evidence-leases-and-readiness-decoupling-2026-05-06.md`
- `bunx oxfmt --check docs/torghut/design-system/v6/133-torghut-capital-readiness-cache-and-profit-carry-governor-2026-05-06.md`
- `bunx oxfmt --check docs/torghut/design-system/v6/index.md`

Required implementation tests:

- Jangar reducer test: healthy database and watch plus missing controller witness emits `dispatch_normal=repair_only`.
- Jangar reducer test: stale database or schema lease blocks `merge_ready` and `deploy_widen`.
- Jangar reducer test: forecast degraded holds paper/live but allows `torghut_observe`.
- Torghut test: cached lease within operational grace keeps `/readyz` operational when Jangar fetch times out.
- Torghut test: stale or missing lease blocks paper/live even when local database and empirical jobs are healthy.

Required runtime checks before enforcement:

- `kubectl get pods -n agents --no-headers | awk '{count[$3]++} END {for (status in count) print status, count[status]}'`
- `curl http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status?namespace=agents`
- `curl http://torghut.torghut.svc.cluster.local/readyz`
- `curl http://torghut.torghut.svc.cluster.local/db-check`
- `curl http://torghut.torghut.svc.cluster.local/trading/profitability/runtime`

Acceptance gates:

- Jangar lease route reports `serve_readonly=allow`, `dispatch_repair=allow`, and `dispatch_normal=repair_only` for the
  current controller-witness debt.
- Torghut readiness reports local dependency health separately from Jangar lease freshness.
- Paper/live Torghut actions remain held when `forecast_service_degraded`, `simple_submit_disabled`, or
  `paper_settlement_required` is present.
- Deployer can identify the exact rollback target for every non-allow action lease.

## Rollout

1. Shadow: emit leases in Jangar status but do not change consumers.
2. Compare: publish NATS summaries and compare against existing material action receipts for two schedule windows.
3. Operational grace: allow Torghut readiness to use `serve_readonly` lease grace while local dependencies are healthy.
4. Repair enforcement: route dispatch repair through the lease when controller witness or terminal settlement debt is
   present.
5. Capital enforcement: require current paper/live leases with no grace extension.

## Rollback

- Disable consumer lease emission and leave existing status payloads intact.
- Disable consumer grace and return Torghut readiness to direct dependency quorum evaluation.
- Keep paper/live capital blocked during rollback unless the strict current lease and Torghut submission council both
  allow.
- If lease generation produces contradictory decisions, prefer existing material action receipts and mark the lease set
  `unknown` until repaired.

## Risks

- A grace window can mask a real Jangar outage if it is too long or not tied to local dependency health.
- Consumers can accidentally treat `allow_grace` as capital approval; schema names and tests must prevent this.
- The lease product can become another large status payload if it includes raw evidence instead of refs.
- Controller witness freshness must be repaired; the lease product makes the debt explicit but does not eliminate it.

## Handoff Contract

Engineer:

- Implement the lease reducer as a pure function first.
- Keep the payload compact and evidence-reference based.
- Do not make Torghut paper/live capital use grace semantics.
- Add tests that reproduce the current evidence: healthy Jangar status, missing controller witness, and Torghut
  `jangar_status_fetch_failed`.

Deployer:

- Do not enforce leases until two consecutive windows match existing material action receipts.
- Treat `allow_grace` as operational-only.
- Keep paper and live capital blocked unless the lease decision is current `allow` and Torghut local gates are also
  current.
