# 82. Jangar Proof Runway Cutover and Consumer Authority (2026-05-05)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-05
Owner: Victor Chen, Jangar Engineering
Scope: Jangar control-plane resilience, safer schedule launch, least-privilege rollout proof, and Torghut capital
consumer authority.

Companion Torghut contract:

- `docs/torghut/design-system/v6/86-torghut-profit-repair-auction-and-proof-runway-consumer-2026-05-05.md`

Extends:

- `79-jangar-control-plane-proof-runway-and-consumer-gated-rollout-2026-05-05.md`
- `81-jangar-action-class-proof-fuses-and-quant-health-quarantine-2026-05-05.md`
- `72-jangar-materialized-run-proof-and-storage-backed-admission-contract-2026-05-05.md`
- `71-jangar-least-privilege-evidence-projection-broker-and-deploy-gates-2026-05-05.md`

## Decision

Jangar should move the proof-runway work from design vocabulary into a cutover contract: every schedule launch,
rollout widening, and Torghut capital consumer must cite a fresh `ControlPlaneProofRunway` or remain in shadow, hold,
or repair. I am choosing a release-scoped runway with `ConsumerAuthorityResult` projections over two easier paths:
patching local defects one by one, or freezing all work on any degraded signal.

The reason is the current evidence is mixed, not binary. Jangar serving is available, controllers are heartbeating,
database migrations are aligned, and watch reliability is healthy. At the same time, execution trust is degraded on
verify freshness, the dependency quorum is blocked by stale empirical jobs, the agents namespace still has image-pull
and backoff leftovers, and Torghut has no fresh execution/TCA proof for capital widening. A pod can be ready while
dispatch is unsafe. A schema can be current while capital proof is stale. The architecture has to preserve serving and
repair while failing closed for higher-risk action classes.

The tradeoff is one more durable authority object. I accept that cost because the alternative is worse: operators,
schedule code, deployers, and Torghut would keep interpreting readiness, status, route health, and empirical proof
differently.

## Evidence Captured

All cluster and database checks were read-only.

### Cluster, Rollout, and Events

- `kubectl get pods -n jangar -o wide` showed Jangar, Jangar DB, Redis, Bumba, Symphony, Open WebUI, and Alloy running.
- `GET http://jangar.jangar.svc.cluster.local/ready` returned `status=ok` with leader election active on
  `jangar-584d75f4f6-zt9b2`.
- `GET /api/agents/control-plane/status?namespace=agents` reported all three controller heartbeats healthy,
  `rollout_health.status=healthy`, and watch reliability healthy with 133 events, 0 errors, and 0 restarts in a
  15-minute window.
- The same status reported `execution_trust.status=degraded` because `jangar-control-plane:verify` was stale, and
  `dependency_quorum.decision=block` on `empirical_jobs_degraded`.
- `kubectl get pods -n agents -o wide` showed agents controllers running, active plan/discover/verify jobs, and old
  pods in `ImagePullBackOff` or `Error` from prior Jangar and Torghut swarm attempts.
- `kubectl get events -n agents --sort-by=.lastTimestamp` showed readiness probe timeouts, `BackoffLimitExceeded`,
  preemption, scheduling backpressure, `UnexpectedJob`, and image pull failures on older run pods.
- `kubectl get pods -n torghut -o wide` showed Torghut live and sim serving pods, Postgres, ClickHouse, Keeper, TA
  workers, options services, websocket forwarders, and exporters running.
- The current service account can list pods, services, events, CronJobs, and AgentRuns, but cannot list Deployments,
  Knative Services, or CNPG clusters. It also cannot exec into `jangar-db-1` or `torghut-db-1`. Deploy safety therefore
  cannot require privileged Kubernetes reads as the only proof path.

### Source Architecture and Test Gaps

- `services/jangar/src/server/control-plane-status.ts` is already the right aggregator for database status, execution
  trust, rollout health, watch reliability, runtime admission, workflows, and dependency quorum. It returns facts; it
  does not yet materialize one release-scoped authority for schedule, rollout, and consumer decisions.
- `services/jangar/src/server/control-plane-runtime-admission.ts` already issues runtime kits and admission passports.
  The missing step is to bind those passports to release digest, schedule materialization proof, image/platform proof,
  storage proof, and consumer proof before launch.
- `services/jangar/src/server/supporting-primitives-controller.ts` owns schedule template ConfigMaps, CronJobs,
  workspace PVCs, and schedule/PVC watches. This is the enforcement point, so it needs a pre-create proof path rather
  than learning from failed pods after the fact.
- `services/jangar/src/server/primitives-kube.ts` has built-in targets for common Kubernetes resources but no
  `PersistentVolumeClaim` alias, while the supporting controller already uses `persistentvolumeclaim` for workspace
  read, delete, and watch paths. That split is a concrete storage-proof reliability gap.
- Tests exist for readiness, status, runtime admission, watch reliability, supporting primitive schedules, and
  primitives kube behavior. The missing test class is cross-surface parity: `/ready`, control-plane status, schedule
  launch, deploy verification, and Torghut consumer decisions must agree on the same runway digest.

### Database, Data Quality, and Freshness

- Jangar status reported `database.configured=true`, `database.connected=true`, `status=healthy`, `latency_ms=2`, 25
  registered migrations, 25 applied migrations, and latest migration `20260418_embedding_dimension_4096`.
- Direct SQL into Jangar Postgres was blocked by RBAC: the agents service account cannot create `pods/exec` in
  namespace `jangar`.
- Torghut `/db-check` returned `ok=true`, `schema_current=true`, current and expected head
  `0029_whitepaper_embedding_dimension_4096`, one expected migration branch, and lineage ready. Historical parent-fork
  warnings remain for `0010_execution_provenance_and_governance_trace` and `0015_whitepaper_workflow_tables`.
- Torghut `/trading/status` reported `mode=live`, active revision `torghut-00217`, `execution_lane=simple`, live gate
  `allowed=false` on `simple_submit_disabled`, three hypotheses all capped at `shadow`, zero promotion eligible, and
  three rollback required.
- Torghut signal continuity was alerting on `no_signals_in_window`; empirical jobs were degraded and stale; TCA was
  last computed on 2026-04-02 with high average absolute slippage; runtime profitability over 72 hours had 8 decisions,
  0 executions, and 0 TCA samples.
- Direct SQL into Torghut Postgres was blocked by the same `pods/exec` RBAC constraint.
- Memory retrieval through the repo helper failed twice during the run: once with `ECONNRESET`, and once with a Jangar
  memory retrieve HTTP 500 timeout. That is route-level evidence, not a blocker for this design work.

## Problem

Jangar has accumulated the right local primitives, but cutover authority is still distributed. Serving readiness says
one thing. Control-plane status says another. Schedule reconciliation can create a pod and discover image/storage
failure later. Torghut can report a live service and current schema while every profitability signal says capital
should stay in shadow.

That creates five production failure modes:

1. a schedule is admitted before its ConfigMap, image platform, service account, and storage proof are known runnable;
2. rollout widening can read healthy controller heartbeats while stale verify or empirical proof remains unresolved;
3. least-privilege deployers cannot prove safety if the gate depends on Deployment listing or database exec;
4. stale Torghut proof can be read as capital authority because it is truthful but not fresh;
5. old failed jobs can either poison all work forever or be ignored entirely because no release-scoped lineage exists.

The next architecture step is not another status page. It is one authority record with explicit action classes and
freshness rules.

## Alternatives Considered

### Option A: Patch Local Defects Only

Patch `PersistentVolumeClaim` support, add image digest/platform checks, tighten quant-health timeouts, and make Torghut
prefer the proof-aware submission council.

Pros:

- fastest way to remove known sharp edges;
- small PRs and focused tests;
- reduces current event noise quickly.

Cons:

- does not give deployers one authority to cite;
- leaves route-local interpretation in place;
- does not preserve negative evidence by release digest;
- does not force Torghut capital to consume the same proof as Jangar rollout.

Decision: required implementation work, but not the architecture.

### Option B: Global Freeze on Any Degraded Signal

Freeze all schedules, rollout widening, and Torghut capital whenever execution trust, dependency quorum, route probes,
or empirical proof is degraded.

Pros:

- conservative incident posture;
- easy to explain during a major outage;
- prevents accidental widening.

Cons:

- blocks observe, repair, replay, and verify work that are needed to recover;
- treats image pull leftovers, stale market proof, and database privilege limits as the same failure;
- encourages manual bypass because the gate is too blunt;
- does not solve least-privilege deploy verification.

Decision: keep a global emergency brake, but reject it as the default architecture.

### Option C: Proof Runway Cutover with Consumer Authority

Materialize a release-scoped `ControlPlaneProofRunway`, then project `ConsumerAuthorityResult` decisions for schedule
launch, rollout widening, and Torghut capital.

Pros:

- one authority digest for mixed evidence;
- preserves serving and repair while holding unsafe dispatch or capital;
- supports least-privilege deployment because the proof route is queryable without privileged reads;
- binds stale jobs to release/stage lineage instead of global folklore;
- gives Torghut a stable platform proof to include in order and capital warrants.

Cons:

- adds one durable proof object and route contract;
- requires shadow-mode comparison before enforcement;
- needs careful operator language so `serve=allow` is not read as global health.

Decision: select Option C.

## Chosen Architecture

### ControlPlaneProofRunway

Jangar produces one runway per release digest, namespace, swarm, and stage:

```text
control_plane_proof_runway
  runway_id
  namespace
  swarm
  stage
  release_digest
  image_ref
  image_digest
  observed_node_architectures
  image_platform_decision
  schedule_template_digest
  schedule_template_readback
  target_manifest_digest
  service_account_ref
  workspace_storage_decision
  runtime_kit_digest
  admission_passport_id
  database_schema_digest
  database_route_proof
  execution_trust_digest
  rollout_event_window_digest
  watch_reliability_digest
  consumer_proof_digests
  negative_evidence_refs
  observed_at
  fresh_until
  enforcement_mode
```

The runway is not a dashboard. Missing, expired, wrong-digest, wrong-stage, or wrong-account proof means hold for
non-repair action classes.

### ConsumerAuthorityResult

Every consumer receives a projection with the same digest:

```text
consumer_authority_result
  runway_id
  consumer_class
  consumer_ref
  scope_digest
  observed_at
  fresh_until
  action_classes:
    serve
    observe
    repair
    verify
    dispatch
    widen
    paper_submit
    live_submit
  blocked_reasons
  repair_hints
  evidence_refs
```

Initial rules:

- `serve` requires serving readiness and leader election health.
- `observe` requires serving plus bounded read-path failures that return typed negative evidence.
- `repair` remains allowed when serving or Kubernetes read evidence is available.
- `verify` is held when the stage has no fresh successful run.
- `dispatch` requires schedule template readback, service account resolution, runtime passport allow, image platform
  proof for observed node architectures, workspace storage proof, and no active release-lineage job failure.
- `widen` requires `dispatch=allow`, healthy rollout/watch windows, and no current event-window negative evidence for
  the release digest.
- `paper_submit` requires Torghut proof freshness, Jangar `dispatch` or scoped waiver, and no action-class hold for the
  account/window.
- `live_submit` requires `paper_submit=allow`, fresh empirical jobs, nonzero current execution/TCA samples, quant
  health configured and fresh, and no rollback-required hypotheses.

### Least-Privilege Proof Projection

Jangar must publish proof through application routes and a bounded store so deployers do not need broad cluster or
database privileges:

- `GET /api/agents/control-plane/proof-runway?namespace=&swarm=&stage=&release_digest=`
- compact runway projection inside `/api/agents/control-plane/status`
- serving-safe projection inside `/ready` without failing readiness for non-serving holds
- NATS/Jangar event on runway change with runway id, action class, and blocked reasons

Privileged SQL and Deployment listing remain optional forensic inputs. They are not required acceptance gates.

## Engineer Scope

Implement in this order:

1. Add `PersistentVolumeClaim` built-in aliases to `primitives-kube` and tests for get, list, delete, and status/watch
   parity where applicable.
2. Add the pure runway builder with fixtures for the May 5 evidence: serving healthy, verify stale, dependency quorum
   blocked, old image-pull failures, Torghut proof stale.
3. Add route projection and status projection in shadow mode.
4. Wire supporting schedule reconciliation to write or compute a shadow runway before CronJob/Job creation.
5. Add enforcement for Jangar control-plane schedule `dispatch` only after shadow parity passes.
6. Add deployer smoke that reads the runway route and fails widening on held action classes.
7. Hand the `ConsumerAuthorityResult` digest to Torghut for paper and live capital gates.

## Validation Gates

- Unit: `persistentvolumeclaim` and `persistentvolumeclaims` resolve in `primitives-kube`.
- Unit: missing schedule ConfigMap readback holds `dispatch` with a repair hint.
- Unit: image digest missing an observed node architecture holds `dispatch` before pod creation.
- Unit: healthy `/ready` can coexist with `verify=hold`, `dispatch=hold`, `widen=hold`, and `live_submit=block`.
- Unit: old image-pull failures block only when they match active release digest, stage, or retry lineage.
- Contract: status route, proof-runway route, schedule launch decision, deployer smoke, and Torghut consumer projection
  expose the same `runway_id`.
- Integration: stale Torghut empirical jobs and zero execution/TCA samples hold `paper_submit` and block `live_submit`
  while `repair` remains allowed.
- Manual validation: a least-privilege runner can read the runway without Deployment list or database exec privileges.

## Rollout Plan

1. Shadow mode: compute runway and authority results but do not enforce.
2. Read authority: display runway id, action classes, and blocked reasons in Jangar status and deployer smoke.
3. Dispatch fuse: block new Jangar control-plane schedule launches on held `dispatch`, preserving repair.
4. Widen fuse: require `widen=allow` before rollout widening or deployer ready signals.
5. Capital fuse: require Torghut to cite `paper_submit` or `live_submit` authority before capital leaves shadow.

## Rollback Plan

- Set runway enforcement to `disabled`; keep proof writes and negative evidence.
- If the route regresses, remove the compact `/ready` projection first and keep the dedicated proof route.
- If persistence regresses, fall back to an in-memory hold runway with `database_route_proof=unavailable`.
- If schedule enforcement blocks repair, disable `dispatch` enforcement but keep shadow comparison.
- If Torghut consumption regresses, force Torghut capital to shadow and continue recording consumer proof mismatches.

Rollback is complete only when `serve`, `observe`, and `repair` still emit explicit decisions after enforcement is
disabled.

## Risks and Open Questions

- Image manifest inspection must be cached, or schedule reconciliation will depend on registry latency.
- Stale old failures must not block forever. The release, stage, and retry-lineage match rules need tests.
- Torghut account and window scoping must be exact; `paper/15m` proof cannot authorize live capital.
- Manual overrides need actor, reason, expiry, release digest, account/window scope, and maximum capital exposure.
- UI surfaces must lead with held action classes so operators do not overread `serve=allow`.

## Handoff

Engineer acceptance gate: the May 5 evidence fixture must produce `serve=allow`, `observe=allow`, `repair=allow`,
`verify=hold`, `dispatch=hold`, `widen=hold`, `paper_submit=hold`, and `live_submit=block`, with deterministic repair
hints for stale verify, stale empirical jobs, and missing execution/TCA proof.

Deployer acceptance gate: no rollout widening from pod readiness alone. A deployer must read the runway route, verify
the expected release digest, confirm fresh proof clocks, and check that the specific action being widened is `allow`.
