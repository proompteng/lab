# 123. Jangar Observation Rights Quorum And Proof-Carrying Rollout Admission (2026-05-06)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-06
Owner: Gideon Park, Torghut Traders Architecture
Scope: Jangar control-plane resilience, observation authority, rollout admission, Torghut capital proof consumption,
read-only evidence RBAC, and failure-mode reduction.

Companion Torghut contract:

- `docs/torghut/design-system/v6/127-torghut-fillability-first-alpha-reentry-and-observation-backed-proof-exchange-2026-05-06.md`

Extends:

- `122-jangar-evidence-pressure-governor-and-data-cost-rollout-cells-2026-05-06.md`
- `121-jangar-controller-witness-uplink-and-proof-renewal-train-2026-05-06.md`
- `119-jangar-empirical-proof-renewal-clearinghouse-and-capital-reentry-settlement-2026-05-06.md`
- `114-jangar-evidence-transport-ledger-and-watch-restart-circuit-breakers-2026-05-06.md`

## Decision

I am choosing **observation-rights quorum with proof-carrying rollout admission** as the next Jangar architecture
increment for Torghut quant.

The current cluster is not failed. Jangar, NATS, and the agents controller are serving, current runtime kits include the
NATS collaboration helpers, and the Jangar quant store is updating with fresh metrics. The previous `torghut-sim`
image-pull failure has cleared into a running revision.

The current cluster is also not safe enough to treat green serving health as capital or rollout authority. Argo CD still
reports `torghut` as `OutOfSync` even while healthy. This service account can list many pods, Deployments, Services, and
events, but it is forbidden from listing CNPG clusters, Secrets, Knative serving resources, and pod exec in `jangar` and
`torghut`. Jangar `/ready` reported degraded execution trust because `torghut-quant:verify` was stale at
`2026-05-06T16:10:28Z`; the broader control-plane status route reported healthy execution trust 27 seconds later. That
race is exactly the class of ambiguity we need to settle before rollout widening or capital-adjacent decisions.

The selected design makes Jangar attach an observation receipt to every material decision. A receipt says which evidence
surface was visible, which read capability produced it, when it expires, and which action classes it can authorize. The
admission arbiter then requires a quorum of fresh receipts before schedule dispatch, release widening, merge-ready
claims, Torghut proof-repair allocation, paper capital, or live capital.

The tradeoff is stricter gating and more explicit denied-evidence states. I accept that. The failure mode to remove is
not a 500 page; it is a controller that widens rollout or consumes Torghut capital based on partial visibility.

## Runtime Objective And Success Metrics

This contract increases Jangar resilience by separating serving health from observed authority.

Success means:

- RBAC denial, stale watches, stale route data, Argo drift, and stale empirical proof become typed receipts, not log
  trivia.
- Serving, bounded repair, shadow proof, paper capital, live capital, and rollout widening have different receipt
  requirements.
- A healthy Deployment can continue serving while rollout widening is held by missing observation rights.
- Torghut receives one compact material-action verdict instead of reconstructing Jangar health from several routes.
- Deployer can verify the required evidence without pod exec or Secret reads.

## Evidence Snapshot

All cluster, source, and database/data assessment was read-only. No Kubernetes resources, database records, trading
flags, broker state, or GitOps resources were changed.

### Cluster And Rollout Evidence

- Current branch was `codex/swarm-torghut-quant-discover` at `01483797e`, matching `origin/main` before this change.
- `kubectl config current-context` was unset, but namespace and resource reads worked through the in-cluster service
  account.
- `kubectl -n jangar get deploy,pods,svc -o wide` showed `deployment/jangar` at `1/1` and
  `pod/jangar-7b6c986c76-g98bk` at `2/2 Running`; `jangar-db-1`, Alloy, Redis, Open WebUI, Bumba, and Symphony pods
  were running.
- `kubectl -n agents get deploy,pods,agentruns -o wide` showed `agents` at `1/1`, `agents-controllers` at `2/2`, and
  current Torghut/Jangar scheduled AgentRuns progressing. Recent events still showed readiness timeouts on
  `agents-controllers` and `agents`.
- `kubectl -n nats get deploy,pods,svc -o wide` showed `nats-0`, `nats-1`, and `nats-2` at `2/2 Running`; the earlier
  runtime-kit missing-NATS risk is no longer true for this sample.
- `kubectl -n torghut get deploy,pods,svc -o wide` showed `torghut-00239` and `torghut-sim-00334` running, plus
  ClickHouse, Postgres, live TA, sim TA, options TA, options catalog/enricher, and websocket services running.
- Argo CD reported `jangar`, `agents`, `agents-ci`, `nats`, `torghut-options`, and the Symphony apps as `Synced` and
  `Healthy`; it reported `torghut` as `OutOfSync` and `Healthy`.
- Torghut events still contained recent readiness 503s, Flink status conflict churn, duplicate ClickHouse PDB matches,
  and `torghut-ws-options` readiness 503s.
- RBAC blocked direct evidence reads: CNPG clusters, backups, scheduled backups, Secrets, Knative serving objects, and
  pod exec were forbidden for `system:serviceaccount:agents:agents-sa`.

### Runtime And Data Evidence

- `http://jangar.jangar.svc.cluster.local/health` returned HTTP 200 and identified Jangar as OK.
- `http://jangar.jangar.svc.cluster.local/ready` returned HTTP 200 with leader election healthy, runtime kits healthy,
  and NATS helper binaries present, but execution trust was degraded at `2026-05-06T16:10:28Z` because
  `torghut-quant:verify` was stale.
- `http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status` returned execution trust healthy at
  `2026-05-06T16:10:55Z`, rollout health healthy for `agents` and `agents-controllers`, watch reliability healthy, and
  runtime admission passports allowing serving, plan, implement, and verify.
- The same control-plane status route still reported Torghut empirical services degraded: forecast `registry_empty`,
  Lean disabled as deterministic scaffold, and jobs stale across `benchmark_parity`, `foundation_router_parity`,
  `janus_event_car`, and `janus_hgrm_reward`.
- Jangar quant health returned HTTP 200 with `latestMetricsCount=3780`, `metricsPipelineLagSeconds=0`, and runtime
  materialization enabled.
- A scoped quant snapshot for strategy `db327e20-4d37-45f3-bf18-5c51e844de31`, account empty, and window `5d` returned
  36 latest metrics, one matching alert, zero autoresearch epochs, and several insufficient-data metrics. Open quant
  alerts counted 37 critical and 13 warning.
- Direct database SQL was not available from this workspace because pod exec and Secret reads were forbidden. The
  database/data evidence in this design therefore uses application-owned read-only projections and explicitly records
  the RBAC denial as negative observation evidence.

### Source Evidence

- `services/jangar/src/server/control-plane-status.ts` already composes heartbeats, database status, rollout health,
  workflow reliability, watch reliability, execution trust, runtime admission, failure-domain leases, and empirical
  services. It does not yet persist action-specific observation receipts.
- `services/jangar/src/server/control-plane-execution-trust.ts` classifies stale swarm stages and pending requirements.
  The live `/ready` versus status-route race shows that per-action freshness windows need to be explicit.
- `services/jangar/src/server/control-plane-runtime-admission.ts` already emits runtime kits and admission passports.
  It is the natural place to consume observation quorums before a consumer class becomes `allow`.
- `services/jangar/src/server/torghut-quant-metrics-store.ts` persists latest metrics, series metrics, alerts, and
  pipeline health. It can produce quant receipts without forcing Torghut to scan Jangar internals.
- `services/torghut/app/trading/submission_council.py` already consumes Jangar dependency quorum and quant evidence for
  Torghut capital gating. The missing contract is a Jangar material-action verdict that says whether the evidence was
  observed with the required rights.

## Problem

Jangar currently has strong status surfaces but weak observation provenance. The failure modes are specific:

1. **Serving health overstates authority.** A route can be healthy while Argo drift, RBAC gaps, stale empirical jobs, or
   recent readiness failures make rollout widening unsafe.
2. **Observation rights are implicit.** If the runtime cannot see CNPG, Knative serving, pod exec, or Secrets, that is
   buried as a command failure rather than a typed input to admission.
3. **Evidence freshness races across routes.** `/ready` and `/api/agents/control-plane/status` can disagree during
   short catch-up windows. Consumers need stable receipts with explicit expiry.
4. **Torghut capital needs narrower truth.** Torghut should know whether Jangar observed the exact proof surfaces needed
   for capital, not whether Jangar is generally OK.
5. **Repair and widening should not share one gate.** Shadow repair should continue under degraded observation, but
   paper/live capital and rollout widening must be held until the required observation quorum is fresh.

## Alternatives Considered

### Option A: Expand RBAC Until The Architect Can Read Everything

This option grants broad read access to CNPG, Knative, Secrets, pods/exec, and controller internals so the architecture
lane can collect perfect evidence directly.

Pros:

- Simple operationally for an investigation.
- Reduces blind spots in one workspace.
- Gives direct database evidence when application projections are missing.

Cons:

- Conflates human investigation privileges with production admission rights.
- Makes Secret and pod exec access a dependency for routine control-plane confidence.
- Does not create a durable evidence contract for deployer or Torghut consumers.

Decision: reject as the architecture. We may need narrow read-only roles for metadata, but the system should not require
broad exec or Secret reads to decide rollout and capital safety.

### Option B: Trust Application Routes And Ignore Kubernetes RBAC Gaps

This option treats `/ready`, `/api/agents/control-plane/status`, `/trading/status`, `/trading/health`, and quant routes
as the full source of truth.

Pros:

- Fastest to implement.
- Uses existing typed routes.
- Avoids new database objects.

Cons:

- Hides whether the producer could observe the surfaces it summarizes.
- Leaves route disagreement as a consumer problem.
- Lets Torghut or rollout automation over-trust data that was generated under partial visibility.

Decision: reject as authority. Routes remain important producers, but their outputs must carry observation receipts.

### Option C: Observation-Rights Quorum And Proof-Carrying Rollout Admission

This option records typed observation receipts and requires per-action quorums before material action.

Pros:

- Converts RBAC denial into explicit negative evidence.
- Separates serving, repair, shadow proof, rollout widening, paper capital, and live capital.
- Gives deployers least-privilege verification paths.
- Lets Torghut consume one compact verdict for capital decisions.
- Reduces false confidence caused by route races and stale stores.

Cons:

- Adds a receipt model, reducer, and migration.
- Requires a shadow rollout to tune false holds.
- Requires teams to maintain receipt producers for new evidence surfaces.

Decision: select Option C.

## Architecture

### ObservationReceipt

Jangar records one current receipt per producer, surface, scope, and capability.

```text
observation_receipt
  receipt_id
  producer
  producer_revision
  observed_at
  fresh_until
  surface_type              # kubernetes, argocd, jangar_route, torghut_route, quant_store, broker_projection, db_projection
  surface_ref               # namespace/name, route path, table projection, or external dependency key
  capability                # list, get, watch, route_read, projection_read, broker_read
  scope
  decision                  # observed, observed_degraded, denied, stale, contradictory, unavailable
  confidence                # high, medium, low
  evidence_digest
  positive_evidence[]
  negative_evidence[]
  allowed_action_classes[]
  denial_code
```

The receipt does not store Secrets, raw pod logs, or broker credentials. It stores the evidence digest and bounded facts
needed for admission.

### ObservationRightsQuorum

Each action class declares required receipts.

```text
observation_rights_quorum
  action_class              # serving, repair, shadow_proof, rollout_widen, paper_capital, live_capital
  required_receipts[]
  optional_receipts[]
  max_receipt_age_seconds
  contradiction_policy      # hold, repair_only, block
  missing_policy            # allow, observe_only, repair_only, hold, block
```

Default policy:

- `serving`: require Jangar route and runtime-kit receipts; Argo drift degrades but does not block.
- `repair`: require Jangar route, collaboration runtime-kit, and at least one negative-evidence receipt.
- `shadow_proof`: require Torghut status, Torghut readiness, Jangar quant store, and empirical-service receipts.
- `rollout_widen`: require Argo, Kubernetes Deployment, pod readiness, watch reliability, and source-ref receipts.
- `paper_capital`: require Torghut readiness, live submission gate, empirical jobs, quant alerts, broker projection, and
  observation of Argo convergence.
- `live_capital`: require all paper-capital receipts plus rollback readiness, no open critical quant alert for the
  target window, and deployer sign-off receipt.

### Proof-Carrying Rollout Admission

Runtime admission passports become proof-carrying. A passport may only be `allow` when the required observation quorum
for the consumer class is satisfied.

The `reason_codes` field must include denied or stale receipt names, for example:

- `observation_denied:torghut:knative-serving`
- `observation_denied:torghut:cnpg`
- `argocd_out_of_sync:torghut`
- `torghut_empirical_jobs_stale`
- `quant_alerts_open:critical`
- `execution_trust_route_race`

Route races are handled by requiring a stable decision across the receipt freshness window. If `/ready` says degraded
and the status route says healthy inside the same window, rollout widening and paper/live capital hold until the next
two samples agree.

### Torghut Material-Action Verdict

Jangar publishes a compact verdict for Torghut:

```text
torghut_material_action_verdict
  verdict_id
  generated_at
  fresh_until
  target_account
  target_hypothesis
  action_class
  decision                  # allow_shadow, repair_only, hold_paper, hold_live, rollback
  observation_receipt_refs[]
  blocking_reasons[]
  allowed_next_actions[]
```

Torghut consumes this verdict before moving any hypothesis beyond shadow or before requesting Jangar repair capacity
for profit proof renewal.

## Implementation Scope

Engineer stage should implement:

- a Jangar migration for `control_plane.observation_receipts` and `control_plane.observation_quorum_decisions`;
- receipt producers for runtime kits, execution trust, Argo app status, Kubernetes rollout health, watch reliability,
  Torghut route status, Torghut empirical services, Jangar quant metrics, and RBAC-denied surfaces;
- a reducer in `control-plane-runtime-admission.ts` that joins receipts into consumer-class admission passports;
- a `GET /api/agents/control-plane/observation-quorum` route for deployer and Torghut verification;
- tests for denied CNPG/Knative/exec receipts, route disagreement, Argo OutOfSync hold, and critical quant alert hold;
- Torghut-facing verdict serialization with no Secret, token, or broker credential material.

Deployer stage should implement:

- least-privilege read-only RBAC for Argo app status, Deployment/Pod/Event metadata, Knative serving metadata, and CNPG
  cluster metadata where needed;
- no routine Secret read and no routine pod exec requirement;
- dashboard panels for receipt count, stale receipt count, denied receipt count, and action-class decision;
- alerting when rollout-widen or capital receipts are denied for more than two consecutive windows.

## Validation Gates

Before engineer completion:

- Unit tests cover receipt normalization, expiry, contradiction, and admission downgrade.
- Existing control-plane status tests still pass.
- A fixture reproduces the observed `/ready` degraded and status-route healthy race and proves rollout widening holds.
- A fixture reproduces `torghut` Argo `OutOfSync` and proves serving stays allowed while rollout widening holds.
- A fixture reproduces 37 critical quant alerts and stale empirical jobs and proves paper/live capital hold.

Before deployer completion:

- `kubectl auth can-i list configurations.serving.knative.dev -n torghut` and
  `kubectl auth can-i list clusters.postgresql.cnpg.io -n torghut` are either allowed by a narrow role or recorded as
  denied observation receipts.
- `GET /api/agents/control-plane/observation-quorum` shows fresh receipts for serving and repair.
- `rollout_widen` remains held while Argo reports `torghut OutOfSync`.
- `paper_capital` and `live_capital` remain held while Torghut empirical jobs are stale or critical quant alerts are
  open.

## Rollout Plan

1. Shadow materialization: write receipts and quorum decisions without changing admission behavior for 24 hours.
2. Repair enforcement: require observation quorum for repair dispatch and shadow proof only.
3. Rollout enforcement: require observation quorum for rollout widening and merge-ready claims.
4. Capital enforcement: require material-action verdicts for Torghut paper/live capital.
5. Tighten RBAC: add narrow read-only metadata roles only for surfaces that repeatedly deny observation and are truly
   required for an action class.

## Rollback Plan

Rollback is configuration-first:

- Disable proof-carrying enforcement while keeping receipt writes on.
- Downgrade action classes to observe-only if receipt producers are noisy.
- Keep serving admission independent from rollout-widen and capital gates.
- Revert the migration only after no runtime depends on receipt tables.

Emergency rollback trigger:

- Receipt reducer causes serving admission to block.
- Receipt writes materially degrade Jangar database latency.
- False holds prevent all repair dispatch for more than one scheduler window.

## Risks And Mitigations

- **Risk: false holds during route races.** Mitigate with shadow mode, two-sample stabilization, and per-action
  thresholds.
- **Risk: receipt sprawl.** Mitigate with current-row upserts keyed by producer, surface, scope, and capability.
- **Risk: over-granting RBAC.** Mitigate by recording denial receipts first and adding only narrow metadata reads.
- **Risk: Torghut treats observation as profitability proof.** Mitigate by keeping observation receipts separate from
  empirical profit proof and capital verdicts.
- **Risk: CI and dashboards overreact to transient Argo OutOfSync.** Mitigate by action-specific policies: serving
  degrades, rollout widening holds, repair may proceed.

## Handoff Contract

Engineer acceptance gates:

- Jangar persists observation receipts with expiry and action-class scope.
- Runtime admission passports consume observation quorums.
- Torghut material-action verdict is available through a typed route.
- Tests prove degraded observation cannot authorize rollout widening or paper/live capital.

Deployer acceptance gates:

- Read-only observation roles are least-privilege and do not require Secret reads or pod exec.
- The live cluster shows serving allowed, repair/shadow proof allowed or repair-only, and capital held under the current
  stale empirical proof state.
- Rollback can disable enforcement without deleting receipts.
