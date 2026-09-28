# 73. Jangar Evidence Settlement and Runtime Freshness Leases (2026-05-05)

Status: Approved for implementation (`discover`)
Date: `2026-05-05`
Owner: Gideon Park (Torghut Traders)
Scope: Jangar control-plane resilience, stage freshness, runtime trust, rollout quarantine, and Torghut quant evidence
consumption.

Companion doc:

- `docs/torghut/design-system/v6/78-torghut-quant-evidence-settlement-and-capital-routing-2026-05-05.md`

Extends:

- `72-jangar-materialized-run-proof-and-storage-backed-admission-contract-2026-05-05.md`
- `72-jangar-route-authority-fuses-and-deploy-quarantine-2026-05-05.md`
- `71-jangar-least-privilege-evidence-projection-broker-and-deploy-gates-2026-05-05.md`
- `70-jangar-actuation-escrow-and-deploy-proof-lanes-2026-05-05.md`

## Decision

Jangar should settle runtime evidence into expiring freshness leases before it allows swarm stage advancement, deploy
widening, review ingestion, or Torghut capital authority to consume a control-plane answer.

The reason is current live evidence. Jangar is serving and the runtime kit view has recovered: `/health` returned
HTTP `200`, `/api/agents/control-plane/status?namespace=agents` returned HTTP `200`, the collaboration runtime kit
included `codex-nats-publish`, `codex-nats-soak`, `nats`, the Jangar workspace path, and `NATS_URL`, and rollout
health saw `agents` and `agents-controllers` healthy. The remaining failure is not serving liveness. It is stale
authority: execution trust is still `degraded` because the Jangar control-plane swarm has `requirements_pending=5` and
discover, plan, implement, and verify stages are stale. Dependency quorum is blocked by Torghut empirical jobs even
while Jangar's database, watch stream, and rollout surfaces are healthy.

The tradeoff is stricter actuation. I want `/health` and human repair surfaces to stay available, but stale stage
authority, stale Torghut proof, or missing route settlement must stop action consumers. That is the clean way to reduce
failure modes without turning every degraded fact into a full serving outage.

## Runtime Inputs

- repository: `proompteng/lab`
- base: `main`
- head: `codex/swarm-torghut-quant-discover`
- swarm: `torghut-quant`
- stage: `discover`
- owner channel: `swarm://owner/trading`
- live channel: `general`

Success means the engineer stage can build from this document without asking what to test, and the deployer stage can
validate the rollout through read-only routes and Kubernetes reads, not privileged database exec.

## Current Evidence

All Kubernetes and database checks were read-only.

### Cluster and Rollout

- The runner identity is `system:serviceaccount:agents:agents-sa`.
- `kubectl config current-context` is unset, but `kubectl auth whoami` succeeds through the in-cluster service account.
- `kubectl get pods -n jangar -o wide` showed Jangar, Bumba, Open WebUI, Jangar DB, Redis, Alloy, Symphony, and
  Symphony-Jangar running.
- `kubectl get pods -n agents -o wide` showed the current `agents` pod and both `agents-controllers` replicas
  running, alongside many older completed and errored swarm job pods.
- Recent `agents` events showed the current agents rollout recovered to two ready controller replicas, but the same
  window still contains failed mounts for missing step ConfigMaps and old backoff-limit/stale-stage debt.
- `kubectl get deploy -n jangar`, `kubectl get ksvc -n torghut`, `kubectl get workflows -n argo`, and CNPG
  cluster-wide listing are forbidden for this service account. That is acceptable worker RBAC and proves deploy gates
  need bounded evidence projections instead of privileged shell checks.
- `kubectl get pods -n kafka -o wide` showed the Kafka brokers, entity operator, exporter, Karapace, UI, and Strimzi
  operator running. The Strimzi operator had restarted recently, but the broker pool was up.

### Jangar Route and Data Surfaces

- `GET http://jangar.jangar.svc.cluster.local/health` returned HTTP `200`.
- `GET /api/agents/control-plane/status?namespace=agents` returned HTTP `200`.
- Leader election is enabled and the Jangar pod is leader.
- Controllers are healthy: agents, supporting, and orchestration controllers reported healthy authority.
- Runtime adapters `workflow`, `job`, and `temporal` are configured; `custom` is intentionally unknown per run.
- Runtime kits are healthy, including the collaboration kit with the `nats` binary present.
- Jangar DB is connected with `25` registered Kysely migrations and `25` applied migrations. Latest applied is
  `20260418_embedding_dimension_4096`.
- Watch reliability is healthy in the last 15 minutes: two observed streams, no stream errors, no restarts.
- Execution trust is degraded because Jangar stages are stale and Jangar control-plane requirements are pending.
- Dependency quorum is `block` with reason `empirical_jobs_degraded`.
- The status route's namespace summary marks `agents` degraded for `empirical:forecast`, `empirical:jobs`, and
  `execution_trust`.

### Torghut Dependency Evidence Consumed by Jangar

- Jangar quant health for account `PA3SX7FYNUTF`, window `15m`, returned HTTP `200` but `status="degraded"`.
- `latestMetricsCount=108`, `metricsPipelineLagSeconds=14`, and the latest store is not empty.
- Ingestion stages are degraded with `maxStageLagSeconds=333284`. At least one strategy has ingestion lag far outside
  a live promotion budget.
- Torghut live `/trading/status` reports stale empirical jobs from `2026-03-21T09:03:22Z`, no promotable hypotheses,
  and dependency quorum blocked by empirical jobs.
- Torghut sim `/readyz` returns HTTP `503`; its database contract reports current head `0023_simulation_run_progress`
  while the expected app head is `0029_whitepaper_embedding_dimension_4096`.

### Source and Test Surface

- `services/jangar/src/server/control-plane-status.ts` composes rollout health, runtime kits, execution trust,
  database status, watch reliability, workflows, dependency quorum, and Torghut empirical service status in one route.
- `services/jangar/src/server/control-plane-runtime-admission.ts` already has the vocabulary for runtime kits,
  admission passports, and execution-trust reason codes.
- `services/jangar/src/routes/api/torghut/trading/control-plane/quant/health.ts` reads account/window latest metrics
  and pipeline health on the route path.
- `services/jangar/src/server/torghut-quant-metrics-store.ts` has a compact latest metrics table, but route authority
  still depends on the freshness and interpretation of pipeline-health rows.
- Existing Jangar tests cover control-plane status, runtime admission, ready-route execution trust, and the Torghut
  quant-health route. The gap is not test style; it is a missing settled authority object tying those facts to stage
  and deploy decisions.

## Problem

Jangar has several healthy facts and one economically important unhealthy fact. Serving is up. Runtime kits are now
present. Rollouts are healthy. The DB and watch stream are healthy. At the same time, execution trust is degraded and
dependency quorum is blocked because downstream Torghut proof is stale.

If a consumer reads only the serving route, it can over-trust the platform. If a consumer reads the broad control-plane
status route every time, it inherits route latency and cross-domain ambiguity. The system needs a smaller authority
surface: settled evidence that says which consumer can act, until when, and under which rollback rule.

The failure modes to reduce are:

1. serving health being mistaken for swarm stage authority;
2. stale discover/plan/implement/verify stages being visible but not lease-expiring actuation;
3. Torghut empirical staleness blocking dependency quorum without a durable reason consumers can cite;
4. sim schema drift hiding behind a running pod;
5. partial RBAC making deploy verification dependent on checks the worker cannot perform;
6. route-time recomputation producing different answers for Jangar, Torghut live, and Torghut sim.

## Alternatives

### Option A: Keep Route Fuses and Add More Status Text

This option continues the current direction: route-authority fuses, richer status payloads, and stronger operator text.

Pros:

- Smallest implementation surface.
- Preserves current route contracts.
- Useful for human diagnosis.

Cons:

- Consumers still need to decide which status facts are authoritative.
- Stage freshness remains derived from route-time status, not settled as a lease.
- Torghut promotion still depends on another service's current read behavior.

Decision: reject as the primary architecture. Keep it as a presentation layer over settled leases.

### Option B: Freeze All Swarm Work on Any Degraded Execution Trust

This option treats `execution_trust != healthy` as a global stop.

Pros:

- Conservative.
- Easy to explain during incidents.
- Prevents unsafe stage advancement.

Cons:

- Blocks repair work and independent healthy lanes.
- Does not classify failures by consumer or stage.
- Gives Torghut no account/window proof of what is stale.

Decision: reject as the default. Keep global freeze as an operator emergency switch.

### Option C: Evidence Settlement Epochs and Runtime Freshness Leases

This option settles the broad status route into small expiring leases. Each lease is scoped to a consumer class,
stage, route, runtime kit, namespace, and downstream Torghut proof reference.

Pros:

- Keeps serving available while action consumers fail closed.
- Makes stale stage authority explicit and expiring.
- Gives deployers a read-only validation target.
- Lets Torghut cite one Jangar proof id instead of reinterpreting Jangar status.
- Limits blast radius by consumer class and stage.

Cons:

- Adds a persistence/read-model layer.
- Requires stage dispatch, review ingest, deploy gates, and Torghut proof reads to cite leases.
- Requires careful expiry defaults so stale last-good evidence cannot become false permission.

Decision: select Option C.

## Target Contracts

### EvidenceSettlementEpoch

The epoch is the immutable batch of facts Jangar can use for authority. It is produced by the control-plane projector,
not by an action route.

Required fields:

- `evidence_settlement_epoch_id`;
- `producer_revision`;
- `generated_at`;
- `fresh_until`;
- `namespaces`;
- `runtime_kit_set_digest`;
- `controller_authority_digest`;
- `rollout_health_digest`;
- `database_migration_digest`;
- `watch_reliability_digest`;
- `workflow_reliability_digest`;
- `torghut_evidence_mirror_digest`;
- `decision`: `allow`, `degrade`, `hold`, or `block`;
- `reason_codes`.

The epoch may be degraded and still serve human routes. It must not allow actuation when its consumer-specific lease is
expired, missing, or blocked.

### RuntimeFreshnessLease

The lease is what consumers cite.

Required fields:

- `runtime_freshness_lease_id`;
- `evidence_settlement_epoch_id`;
- `consumer_class`: `serving`, `swarm_discover`, `swarm_plan`, `swarm_implement`, `swarm_verify`, `review_ingest`,
  `deploy_widening`, or `torghut_promotion`;
- `namespace`;
- `stage`;
- `route_name`;
- `required_runtime_kits`;
- `required_torghut_accounts`;
- `decision`: `allow`, `degrade`, `hold`, or `block`;
- `reason_codes`;
- `issued_at`;
- `fresh_until`;
- `rollback_action`.

Lease rules:

- `serving` can be `allow` when `swarm_implement` is `hold` or `block`.
- `swarm_plan`, `swarm_implement`, and `swarm_verify` must hold on `execution_trust_degraded`.
- `torghut_promotion` must block on `empirical_jobs_degraded`, stale Torghut proof, sim schema drift for sim lanes,
  or quant-health ingestion lag above the lane budget.
- Missing runtime kits block action consumers before new pods are created.
- A lease cannot outlive the shortest fresh-until time among its required runtime kit, database, rollout, watch, and
  Torghut proof sources.

### TorghutEvidenceMirror

Jangar keeps a small mirror of Torghut evidence for action decisions.

Required fields:

- `torghut_evidence_mirror_id`;
- `evidence_settlement_epoch_id`;
- `account`;
- `window`;
- `active_revision`;
- `schema_head`;
- `schema_expected_head`;
- `empirical_jobs_status`;
- `quant_health_status`;
- `max_ingestion_lag_seconds`;
- `promotion_eligible_total`;
- `rollback_required_total`;
- `reason_codes`;
- `fresh_until`.

The mirror is not the full Torghut status payload. It is the bounded authority object Jangar needs to decide whether
it can admit a Torghut promotion or deploy widening.

## Implementation Scope

Engineer stage:

1. Add an evidence settlement projector behind the Jangar control-plane status route.
2. Persist or cache `EvidenceSettlementEpoch`, `RuntimeFreshnessLease`, and `TorghutEvidenceMirror` records with
   deterministic digests and clear expiry semantics.
3. Make swarm stage launch and review ingest cite the lease id selected for the consumer class.
4. Make deploy verification fail closed when the deploy-widening lease is missing, expired, or blocked.
5. Make the Torghut quant-health route expose the mirror id and reason codes instead of requiring consumers to parse
   broad status.
6. Add tests for serving-allowed/action-held split, stale stage leases, degraded execution trust, degraded empirical
   mirror, and expired lease behavior.

Deployer stage:

1. Verify `/health` remains HTTP `200` for repair even when `swarm_implement` is held.
2. Verify `/api/agents/control-plane/status?namespace=agents` exposes the active settlement epoch and leases.
3. Verify the collaboration runtime kit includes `nats`, `codex-nats-publish`, and `codex-nats-soak` in the deployed
   image.
4. Verify no stage moves from discover to plan, plan to implement, or implement to verify unless its lease is `allow`
   or an explicit operator break-glass receipt is present.
5. Verify Torghut promotion remains blocked while empirical jobs are stale or quant ingestion lag breaches the lane
   budget.

## Validation Gates

Local implementation gates:

- Jangar control-plane status unit tests cover epoch and lease derivation.
- Runtime admission tests cover present and missing collaboration tools.
- Ready-route tests prove serving can stay healthy while action leases hold or block.
- Torghut quant-health route tests cover degraded mirror, fresh mirror, expired mirror, and account/window mismatch.
- `bunx oxfmt --check` on changed Jangar TypeScript and docs paths.

Live rollout gates:

- Jangar `/health` responds within `500 ms`.
- Jangar control-plane status returns the active epoch and lease set within `750 ms` p95 over a five-minute window.
- The active collaboration runtime kit is healthy in the deployed image.
- `agents` rollout health reports desired equals ready equals available for `agents` and `agents-controllers`.
- A stale Jangar stage produces a hold/block lease without making `/health` fail.
- A stale Torghut evidence mirror blocks `torghut_promotion`.

## Rollout

1. Ship epoch and lease projection in shadow mode.
2. Expose epoch and lease ids on Jangar status and quant-health routes.
3. Log selected lease ids in swarm stage dispatch without enforcement.
4. Enforce leases for deploy widening and Torghut promotion first.
5. Enforce leases for plan, implement, and verify stage dispatch after two clean hourly settlements.
6. Keep global freeze as an emergency override, but do not use it as the normal stale-stage mechanism.

## Rollback

Rollback is configuration-first:

- disable lease enforcement while continuing to write epochs and leases;
- keep serving routes untouched;
- keep deploy widening blocked if the rollback itself cannot prove image/runtime parity;
- preserve all blocked/held lease records for audit;
- restore route-fuse-only behavior only for consumers explicitly listed in the rollback receipt.

Rollback is complete only when a fresh epoch proves the previous stage, deploy, and Torghut promotion decisions are
read-only visible again.

## Risks

- Lease sprawl can make operators chase too many identifiers. The mitigation is a single active-lease summary per
  consumer class.
- A projector bug could block healthy work. The mitigation is shadow rollout, deterministic digest tests, and a
  break-glass receipt that still records the stale proof.
- Torghut evidence could be fresher than the Jangar mirror. The mitigation is short mirror TTLs and an explicit
  `mirror_stale` reason that blocks promotion but not repair.
- Stage freshness could be gamed by no-op runs. The mitigation is to require the lease to cite stage output evidence,
  not merely a started job.

## Handoff

Engineer acceptance:

- implement the three target contracts;
- wire leases into stage launch, deploy verification, review ingest, and Torghut quant-health reads;
- prove with tests that stale execution trust holds action consumers while `/health` remains available.

Deployer acceptance:

- confirm runtime kits, rollout health, DB migration consistency, watch reliability, and Torghut mirrors through
  read-only routes;
- verify stale Torghut empirical jobs and sim schema drift block only the affected promotion/sim consumers;
- rollback by disabling enforcement, not by deleting evidence.
