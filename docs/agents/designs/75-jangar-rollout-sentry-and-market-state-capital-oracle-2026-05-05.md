# 75. Jangar Rollout Sentry and Market-State Capital Oracle Contract (2026-05-05)

Status: Approved for implementation (`discover`)
Date: `2026-05-05`
Owner: Gideon Park (Torghut Traders architecture)
Scope: Jangar control-plane rollout safety, Torghut quant market-state proof consumption, failure-mode reduction,
evidence settlement, and deployer rollback gates.

Companion doc:

- `docs/torghut/design-system/v6/79-torghut-market-state-capital-oracle-and-proof-lane-rollout-sentry-2026-05-05.md`

Extends:

- `docs/agents/designs/74-jangar-evidence-settlement-cells-and-torghut-hypothesis-revenue-governor-2026-05-05.md`
- `docs/agents/designs/73-jangar-evidence-settlement-and-runtime-freshness-leases-2026-05-05.md`
- `docs/torghut/design-system/v6/78-torghut-quant-evidence-settlement-and-capital-routing-2026-05-05.md`

## Decision

I am choosing a Rollout Sentry architecture for Jangar and making Torghut the first high-value consumer through a
Market-State Capital Oracle.

The control-plane decision is that Jangar must not treat a healthy route, a green Deployment, or a newly rendered
manifest as rollout authority. A rollout is promotable only when Jangar issues a fresh `RolloutSentryCertificate`
covering the controller revision, runtime kit, registry reachability, node disruption evidence, storage attach safety,
database endpoint liveness, and downstream market-state readiness.

The Torghut decision is that capital movement must depend on the same sentry evidence. The trading system can remain
up, collect evidence, and run research while the oracle holds capital when the platform is in a weak rollout state.
That matters because the current assessment showed live surfaces in motion: image pulls timing out against the private
registry, DB pods in deletion flow, volume multi-attach warnings, route timeouts, and ClickHouse data that is present
but not enough to prove today's capital can be safely spent.

The tradeoff is deliberate latency before promotion. We will spend one more proof hop to avoid confusing service
availability with execution authority.

## Runtime Inputs and Success Metrics

Inputs confirmed for this run:

- repository: `proompteng/lab`
- base: `main`
- head: `codex/swarm-torghut-quant-discover`
- swarm: `torghut-quant`
- stage: `discover`
- owner channel: `swarm://owner/trading`
- NATS channel: `general`

This design succeeds when:

1. every Jangar control-plane rollout, schedule launch, and Torghut capital-stage promotion cites a
   `rollout_sentry_certificate_id`;
2. registry, node, storage, DB endpoint, runtime-kit, and data-freshness failures become explicit reason codes before
   they create a bad promotion;
3. Torghut can keep serving and collecting evidence while the oracle emits `hold`, `shadow_only`, or `quarantine`;
4. deployers can roll back one failure domain without deleting evidence or freezing unrelated research lanes;
5. engineer and deployer stages can validate the contract using read-only cluster checks and route/database probes
   under the existing worker RBAC.

## Evidence Assessed

All cluster and database checks were read-only.

### Shared-State and Runtime Context

The NATS context soak for `workflow.general.>` returned no filtered prior messages for this repository and branch at
the start of the run. I published progress back to `general` through `codex-nats-publish` after confirming scope and
after evidence collection.

The memories helper failed before work began:

- command: `bun run --filter memories retrieve-memory --query ... --limit 10`
- result: `ConnectionRefused` for `http://jangar.jangar.svc.cluster.local/api/memories`

I am treating this as evidence that memory retrieval is not a hard runtime gate and that Jangar-visible memory health
must be projected as a proof input rather than assumed.

### Cluster Health, Rollout, and Events

The assessment identity was `system:serviceaccount:agents:agents-sa`. The local Kubernetes context had to be
bootstrapped to `in-cluster`; after that `kubectl auth whoami` confirmed the same service account.

RBAC evidence:

- the worker can list pods, services, jobs, CronJobs, events, and named secrets in target namespaces;
- it cannot list Deployments, StatefulSets, HPAs, PDBs, Argo CD Applications, CNPG clusters, Kafka topics, Knative
  services, ClickHouseInstallation objects, node objects, or `pods/exec`;
- direct DB exec and privileged controller inspection are therefore not valid acceptance gates for this worker class.

Torghut namespace evidence:

- `kubectl get pods -n torghut -o wide` showed multiple replacement pods in `Pending`, `ContainerCreating`,
  `Terminating`, and `ImagePullBackOff` while older pods still held work.
- `torghut-ws`, `torghut-ws-options`, `torghut-options-ta`, and `torghut-ta-sim` reported image pull timeouts against
  `registry.ide-newton.ts.net`.
- `torghut-00207` and `torghut-sim-00285` replacement pods were pending while prior pods terminated.
- Torghut events showed `LatestReadyFailed` for `torghut-sim`, `Multi-Attach` on Symphony storage, and repeated
  `ErrImagePull` / `ImagePullBackOff` on promoted image digests.

Jangar namespace evidence:

- `kubectl get pods -n jangar -o wide` showed the main `jangar` pod stuck in init, `jangar-db-1` terminating,
  Redis liveness and readiness probe timeouts, and Symphony volume multi-attach.
- `curl http://jangar.jangar.svc.cluster.local/health` failed to connect during the assessment window.
- Jangar events showed DB backup retrying because it could not find target pod `jangar-db-1`.

Agents namespace evidence:

- active controller pods were split between running and image-pull failure.
- many historical swarm jobs remained `Error`, while the current Torghut discover worker was running.
- warning events showed image pull timeouts for both `jangar-control-plane` and `jangar` images, plus mass
  TaintManager eviction churn after node disruption.

Cluster-level inference:

- the same private-registry timeout class hit Jangar, agents, Torghut websocket, TA, and sim lanes;
- the same storage-attach class hit Jangar and Torghut Symphony pods;
- these are cross-plane rollout failure modes, not one service-specific readiness bugs.

### Database, Schema, Freshness, and Consistency

Postgres was not reachable through normal service endpoints during the assessment:

- Torghut app secret-based TCP check to `torghut-db-rw` failed with `connect ECONNREFUSED 10.105.214.188:5432`;
- Jangar app secret-based TCP check to `jangar-db-rw` failed with `connect ECONNREFUSED 10.98.225.178:5432`;
- both `torghut-db-1` and `jangar-db-1` pod objects had deletion timestamps while still reporting container ready;
- `kubectl cnpg psql` failed because the worker cannot create `pods/exec`.

ClickHouse was reachable through the typed HTTP surface:

- `select now(), currentDatabase(), version()` succeeded with version `25.3.6.10034.altinitystable`;
- `torghut.ta_microbars` had `1,625,888` rows, `12` symbols, no blank symbols, and max event time
  `2026-05-04 20:58:15 UTC`;
- `torghut.ta_signals` had `1,133,243` rows by system table metadata and source aggregation, with max event times:
  `ta=2026-05-04 20:58:15 UTC`, `ws=2026-05-04 20:53:00 UTC`, and `rest=2026-05-04 19:55:00 UTC`;
- options analytic tables in the live `torghut` database had zero rows;
- every discovered `torghut_sim_*` `ta_signals` and `ta_microbars` table had zero rows;
- ClickHouse showed `41` Torghut-prefixed databases, `71` active parts, and `0` inactive parts.

Interpretation: the hot analytic plane contains useful recent equity TA data, but the platform cannot promote capital
while Postgres endpoints refuse, options tables are empty, and sim analytic databases are empty.

### Source Architecture and Test Surface

Torghut source is broad and high leverage, but it is too large for route-by-route interpretation under rollout
pressure:

- `services/torghut/app` contains `106,242` lines of Python;
- `services/torghut/tests` contains `95,907` lines of Python tests;
- large hot-path modules include `trading/autonomy/lane.py` at `7,377` lines,
  `trading/autonomy/policy_checks.py` at `6,072`, `trading/research_sleeves.py` at `5,254`,
  `trading/scheduler/pipeline.py` at `4,273`, and `app/main.py` at `3,978`;
- Torghut has `31` migration files with current source head `0029_whitepaper_embedding_dimension_4096`;
- route code already evaluates database contract, schema graph lineage, Jangar quorum, empirical evidence, hypothesis
  readiness, live submission gates, rollback state, and signal continuity.

The gap is not missing vocabulary. The gap is a cross-plane object that binds those facts to the rollout that produced
them and the capital decision that consumed them.

## Problem

Jangar has been moving toward evidence settlement, but rollout safety still has one unresolved failure class: the
control plane can have enough information to make a good decision while the cluster is unable to materialize that
decision safely.

Current failure modes:

1. registry reachability can fail after a digest is selected;
2. node disruption can leave old pods terminating while replacement pods are pending;
3. RWO volumes can block replacement pods through multi-attach;
4. database pods can be "ready" and terminating while service endpoints refuse connections;
5. Jangar route health can be unavailable while workers still need coordination;
6. Torghut ClickHouse data can be present while Postgres, options, and sim proof are unavailable;
7. Torghut `live` mode can be visible while capital should remain held.

These are not dashboard problems. They are promotion authority problems.

## Alternatives Considered

### Option A: Fix Current Rollout Incidents First

Repair registry reachability, wait for DB pods to settle, and handle storage attach warnings through ordinary
operations.

Pros:

- fastest path to fewer warnings;
- required incident response work;
- keeps architecture surface small.

Cons:

- does not stop the next bad promotion from confusing liveness with authority;
- does not give Torghut a durable reason code for capital hold;
- still asks deployers to manually correlate registry, node, DB, route, and market-state evidence.

Decision: reject as the architecture. Do it operationally, but it is not enough.

### Option B: Global Freeze on Any Cross-Plane Rollout Fault

Freeze all Jangar schedules and Torghut capital movement whenever registry, node, DB, route, or storage evidence is
degraded.

Pros:

- conservative and easy to reason about during incidents;
- sharply reduces bad rollout probability;
- simple initial implementation.

Cons:

- blocks unrelated research and repair lanes;
- can hide which failure domain actually needs work;
- reduces future option value by turning nuanced evidence into a global stop.

Decision: reject as the steady-state architecture. Keep as an emergency lever.

### Option C: Rollout Sentry Certificates Feeding a Market-State Capital Oracle

Add a bounded certificate that proves whether a rollout and its downstream market state are promotable. Torghut
consumes the certificate before moving hypotheses or capital beyond observe/shadow.

Pros:

- reduces the exact failure modes observed in this run;
- preserves repair and research lanes while holding capital;
- produces stable reason codes for deployer rollback and engineer acceptance tests;
- works under least-privilege worker RBAC because it relies on typed probes and certificates, not privileged exec.

Cons:

- adds a proof compiler and a consumer contract;
- requires careful freshness and expiry rules;
- requires cross-route parity tests so Torghut does not keep interpreting raw status independently.

Decision: select Option C.

## Chosen Architecture

### RolloutSentryCertificate

Jangar issues one certificate per rollout scope and stage.

Required fields:

- `rollout_sentry_certificate_id`
- `scope`: `jangar-control-plane`, `torghut-runtime`, `torghut-data-plane`, `swarm-stage`, or `shared-platform`
- `stage`: `discover`, `plan`, `implement`, `verify`, `deploy`, or `capital`
- `producer_revision`
- `image_digests`
- `runtime_kit_digest`
- `admission_passport_id`
- `registry_status`: `allow`, `hold`, or `quarantine`
- `node_disruption_status`
- `storage_attach_status`
- `database_endpoint_status`
- `route_health_status`
- `market_state_status`
- `decision`: `allow`, `hold`, `quarantine`, `rollback`, or `freeze`
- `reason_codes`
- `observed_at`
- `fresh_until`
- `rollback_target`
- `evidence_refs`

The certificate expires quickly. For active trading windows the initial `fresh_until` budget should be no more than
`120` seconds unless the deployer explicitly chooses a lower-frequency maintenance window.

### Registry and Runtime Sentry

Before a Jangar or Torghut rollout is promotable, the sentry must prove:

- selected image digests are pullable from the private registry from at least two current nodes or through an
  equivalent registry canary;
- runtime-kit binaries required by the stage are present in the deployed image, including NATS tooling for
  collaboration lanes;
- an image-pull timeout on the new digest marks the certificate `hold`, not `allow`;
- an older running pod does not grant authority to promote a replacement digest.

### Storage and Node Sentry

The sentry must classify storage and node disruption separately:

- `node_disruption_status=hold` when old pods are terminating because a node is not ready and replacement pods are
  pending;
- `storage_attach_status=quarantine` when the new pod cannot attach a volume already held by the old pod;
- `allow` only when replacement pods are running or the target rollout is explicitly marked as read-only/no-storage.

### Database Endpoint Sentry

The certificate must include endpoint liveness, not just pod readiness:

- `database_endpoint_status=hold` on TCP `ECONNREFUSED` to the configured app DSN;
- `database_endpoint_status=quarantine` when the active DB pod has a deletion timestamp and no new endpoint is
  reachable;
- `allow` only when read-only transaction checks succeed or the target stage does not require that database.

### Market-State Capital Oracle Input

Jangar must expose the latest sentry certificate to Torghut through a typed route and, later, a database-backed mirror.
Torghut consumes:

- certificate id;
- decision;
- reason codes;
- market-state status;
- `fresh_until`;
- rollback target;
- evidence refs for registry, DB, route, storage, and runtime kit.

Torghut may keep serving when the certificate is `hold`, but it may not promote capital beyond shadow.

## Failure-Mode Reduction

The design explicitly removes these failure paths:

- image pull timeout no longer hides behind an older ready pod;
- DB pod readiness no longer hides a refused service endpoint;
- RWO multi-attach no longer looks like ordinary rollout delay;
- stale or empty market-state evidence no longer competes with liveness;
- runtime-kit drift no longer becomes a live coordination failure after launch;
- a global freeze is not needed when only one certificate scope should be quarantined.

## Implementation Scope for Engineers

Phase 1 should be additive:

1. add a Jangar sentry compiler that reads current rollout, pod, event, service, runtime-kit, and route evidence under
   existing worker RBAC;
2. persist or materialize the latest `RolloutSentryCertificate` with stable reason codes;
3. expose a typed Jangar route for certificate reads by scope and stage;
4. add Torghut client parsing and route parity tests so `/readyz`, `/trading/status`, scheduler capital gates, and
   Jangar quant-health consumption agree on the same certificate id;
5. emit metrics for certificate decisions and reason codes;
6. keep enforcement in observe/shadow mode until deployer validation passes.

Out of scope for Phase 1:

- direct cluster mutation by the sentry;
- database writes during assessment jobs;
- global schedule freeze as the default action;
- live capital promotion.

## Validation Gates

Engineer gates:

- unit tests for every reason-code classifier;
- route contract tests for certificate shape and expiry;
- Torghut tests proving capital stays shadow when certificate is `hold`, `quarantine`, `rollback`, expired, or missing;
- regression tests for DB endpoint refused while pod object is still ready;
- regression tests for image-pull timeout on the new digest while old pod is still running.

Deployer gates:

- read-only `kubectl get pods/services/events` evidence for the target namespaces;
- registry canary result for target images;
- TCP read-only database probe for required Postgres DSNs;
- ClickHouse freshness probe for `torghut.ta_signals` and `torghut.ta_microbars`;
- proof that the certificate is mirrored in Jangar and consumed by Torghut before any promotion.

CI gates:

- semantic PR title and commit checks;
- docs lint/format checks for changed docs;
- Torghut targeted tests once implementation touches `services/torghut`;
- Jangar targeted tests once implementation touches `services/jangar`.

## Rollout Plan

1. Ship certificate producer in write-observe mode.
2. Compare certificate decisions against current Jangar and Torghut route decisions for at least one trading day.
3. Enable Torghut consumption as advisory blockers only; no live capital movement changes yet.
4. Enable shadow enforcement for capital stage promotion.
5. Enable deployer gate enforcement for rollout promotion after registry, DB endpoint, and storage classifiers have
   clean parity with incidents.

## Rollback Plan

Rollback must be scoped:

- disable certificate enforcement while keeping certificate writes enabled;
- revert Torghut consumer to advisory mode;
- keep reason-code metrics and evidence refs for incident review;
- do not delete certificate records unless they contain secret material, which the contract forbids;
- if the sentry itself causes route latency, disable the route from promotion checks and keep local route health as
  read-only evidence.

## Risks

- The certificate can become another stale read model if expiry is too generous. Keep `fresh_until` short and visible.
- A registry canary can be expensive if it pulls full images too often. Prefer manifest/head checks plus node-class
  sampling, with full pulls during rollout gates.
- Least-privilege RBAC may hide some details. Treat forbidden reads as explicit `unknown` or `hold` reasons rather
  than blank success.
- Over-enforcement could slow research. Keep observe/shadow lanes available while holding capital.

## Handoff

Engineer acceptance:

- produce `RolloutSentryCertificate` objects with deterministic reason codes for registry, node, storage, DB endpoint,
  runtime-kit, route, and market-state failures;
- add Torghut consumption tests that prove one certificate id drives readiness, status, and capital gating;
- no live capital promotion in the implementation PR.

Deployer acceptance:

- verify the sentry can report the current private-registry timeout class as `hold` or `quarantine`;
- verify DB endpoint refusal produces `database_endpoint_refused`;
- verify ClickHouse freshness remains readable without Postgres access;
- verify rollback to advisory mode requires one flag and preserves evidence.
