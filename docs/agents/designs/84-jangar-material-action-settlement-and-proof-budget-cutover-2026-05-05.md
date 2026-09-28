# 84. Jangar Material Action Settlement and Proof Budget Cutover (2026-05-05)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-05
Owner: Victor Chen, Jangar Engineering
Scope: Jangar control-plane resilience, safer rollout behavior, material action admission, least-privilege evidence
projection, and Torghut capital proof consumption.

Companion Torghut contract:

- `docs/torghut/design-system/v6/88-torghut-session-proof-budget-consumer-and-capital-reentry-contract-2026-05-05.md`

Extends:

- `83-jangar-lease-backed-proof-market-and-profit-aware-rollout-authority-2026-05-05.md`
- `83-jangar-clearance-repair-exchange-and-budgeted-proof-closures-2026-05-05.md`
- `82-jangar-proof-runway-cutover-and-consumer-authority-2026-05-05.md`
- `docs/torghut/design-system/v6/87-torghut-repair-alpha-exchange-and-session-proof-budgets-2026-05-05.md`

## Decision

Jangar should ship the next plan-stage implementation as a **material action settlement plane** with per-action proof
budgets. The proof-runway, lease-backed proof-market, and repair-exchange designs are correct, but the implementation
needs one sharper cut: every high-risk action must settle against the same typed decision before it is allowed to create
work, widen a rollout, or grant Torghut capital authority.

I am choosing this over local patching or a global freeze. The live evidence on 2026-05-05 is mixed in exactly the way
that breaks binary readiness gates. Jangar serving is up, leader election is held, controller heartbeats are healthy,
watch reliability is healthy, rollout health for agents deployments is healthy, and Jangar database migrations are
current. At the same time, execution trust is degraded because plan and verify stages are stale, the dependency quorum
blocks on degraded empirical jobs, the agents namespace still contains older `ImagePullBackOff` and `Error` jobs, and
recent events show manual/CronJob ownership warnings plus missing ConfigMap mounts on verify pods. Torghut is also
schema-current and reachable, but readiness is degraded because live submission is intentionally closed and empirical
proof is stale.

The correct system behavior is not "everything is healthy" and not "freeze everything." Serving, observation, and
bounded repair should stay open. Dispatch, rollout widening, deployment clearance, and Torghut paper/live capital must
require settled proof for the exact action class, digest, account, hypothesis, and freshness window.

## Success Metrics

The engineer and deployer stages should treat this document as the cutover contract. Success means:

1. schedule dispatch cannot create runner ConfigMaps, CronJobs, Jobs, or workspace storage unless a fresh
   `MaterialActionSettlement` for `action_class=dispatch` is present;
2. rollout widening cannot pass unless a fresh settlement binds release digest, route health, execution trust, database
   schema proof, watch reliability, and negative evidence for the target namespace;
3. deployers can verify a settlement through Jangar route projections without Kubernetes Deployment reads, CNPG CRD
   reads, secret reads, or database exec;
4. stale plan or verify stages create a repair budget, not a silent pass and not a permanent global freeze;
5. Torghut paper/live capital cannot exceed the matching platform settlement and Torghut session proof budget;
6. shadow-mode comparison runs for at least seven days before hard enforcement blocks existing dispatch behavior;
7. every settlement exposes an expiry timestamp, producer revision, input digests, open negative evidence, and rollback
   switch.

## Evidence Snapshot

All assessment in this pass was read-only.

### Cluster, Rollout, and Events

- `kubectl get pods -n jangar -o wide` showed Jangar, Jangar DB, Redis, Open WebUI, Bumba, Symphony, and Alloy running.
  The active Jangar pod was `2/2 Running`.
- `GET http://jangar.jangar/ready` returned `status=ok`, leader election enabled and required, and execution trust
  degraded instead of blocked.
- `GET /api/agents/control-plane/status?namespace=agents` reported controller heartbeats healthy for the agents,
  supporting, and orchestration controllers.
- The same status route reported Jangar database `configured=true`, `connected=true`, `status=healthy`, 25 registered
  migrations, 25 applied migrations, and latest applied migration `20260418_embedding_dimension_4096`.
- The same route reported watch reliability healthy over a 15-minute window, with 870 AgentRun events, zero errors,
  and zero restarts.
- The same route reported rollout health healthy for `agents` and `agents-controllers`, with three ready replicas
  across three desired replicas.
- The same route reported execution trust degraded because `jangar-control-plane:plan` and
  `jangar-control-plane:verify` were stale.
- The same route reported dependency quorum `decision=block` because `empirical_jobs_degraded` is still unresolved.
- `kubectl get pods -n agents -o wide` showed current controller and serving pods running, active plan/verify work,
  and older scheduled pods in `ImagePullBackOff`, `Error`, or long-running failed states.
- `kubectl get events -n agents --sort-by=.lastTimestamp` showed stale image digests failing with platform mismatch,
  `BackoffLimitExceeded`, `UnexpectedJob` warnings for manual jobs observed by CronJobs, and recent ConfigMap mount
  misses on Torghut verify attempts.
- `kubectl get pods -n torghut -o wide` showed live Torghut, sim Torghut, Postgres, ClickHouse, Keeper, TA workers,
  options services, websocket forwarders, guardrail exporters, Symphony, and Alloy running.
- This runner can list pods, services, jobs, CronJobs, secrets needed for DB read-only connection checks, and events.
  It cannot list CNPG clusters, Deployments, Knative Services, or exec into DB pods. The design must keep the primary
  safety proof least-privilege and route-projected.

### Source Architecture and Test Gaps

- `services/jangar/src/server/control-plane-status.ts` is already the fact aggregator for controller state, database
  status, execution trust, rollout health, watch reliability, runtime admission, workflows, and dependency quorum. It
  does not yet publish one action-settlement result that dispatch, deployer, and Torghut consumers must cite.
- `services/jangar/src/server/control-plane-execution-trust.ts` already calculates stale stages, freeze state, and
  failure classes. It should become an input to settlement, not the only action gate.
- `services/jangar/src/server/control-plane-runtime-admission.ts` already issues runtime kits and admission passports.
  Settlement should bind those passports to release digest, schedule template readback, image platform proof, storage
  proof, database proof, and consumer proof.
- `services/jangar/src/server/supporting-primitives-controller.ts` owns schedule runner materialization, schedule
  ConfigMaps, CronJobs, and workspace storage. It is the first enforcement point for `dispatch` settlements.
- `services/jangar/src/server/primitives-kube.ts` still lacks a first-class `PersistentVolumeClaim` target while
  supporting primitive code uses PVCs for workspace reads and watches. Storage proof must be explicit in settlement.
- Existing tests cover readiness, control-plane status, watch reliability, runtime admission, and supporting schedule
  behavior. The missing test class is cross-consumer settlement parity: `/ready`, status, schedule reconciliation,
  deploy verification, and Torghut capital decisions must agree on one settlement digest.

### Database and Data

- Direct read-only SQL to Jangar succeeded with role `jangar` at `2026-05-05T19:27:40Z`.
- Jangar direct SQL reported 25 applied Kysely migrations, latest `20260418_embedding_dimension_4096`, and four rows in
  `agents_control_plane.component_heartbeats`.
- Direct read-only SQL to Torghut succeeded with role `torghut_app` at `2026-05-05T19:27:38Z`.
- Torghut direct SQL reported Alembic head `0029_whitepaper_embedding_dimension_4096`, 16 rows in
  `vnext_empirical_job_runs`, latest empirical job at `2026-03-21T09:03:22.150Z`, and zero persisted
  `strategy_hypotheses` rows. Runtime hypotheses are registry-backed today, so persistence is not the source of truth.
- `GET http://torghut.torghut/db-check` returned `ok=true`, `schema_current=true`, current and expected head
  `0029_whitepaper_embedding_dimension_4096`, one current head, no head delta, and lineage warnings for two historical
  migration parent forks.
- `GET http://torghut.torghut/readyz` and `/trading/health` returned HTTP 503 because live submission is closed
  (`simple_submit_disabled`) and empirical jobs are degraded. Postgres, ClickHouse, Alpaca, universe, and schema checks
  were healthy.
- `GET /trading/status` reported live mode, active revision `torghut-00219`, three hypotheses, all capital multipliers
  at zero, zero promotion-eligible hypotheses, and three rollback-required hypotheses.
- Torghut empirical jobs are truthful but stale: `benchmark_parity`, `foundation_router_parity`, `janus_event_car`, and
  `janus_hgrm_reward` all point at candidate `intraday_tsmom_v1@prod` and dataset
  `torghut-full-day-20260318-884bec35`.

## Problem

Jangar currently exposes accurate facts, but material authority is still interpreted by each consumer. Serving readiness
does not mean dispatch is safe. Schema currency does not mean capital proof is fresh. Rollout health can be green while
stage proof is stale. Torghut can be live and connected while all capital lanes must remain shadow.

The result is a brittle operating model:

1. stale jobs and image pull failures can linger without a release-scoped action outcome;
2. schedule controllers can learn platform or storage failure after materializing work;
3. deployers with least-privilege access cannot prove safety if the authoritative check requires privileged cluster or
   database access;
4. Torghut has to translate Jangar dependency status and profit proof into capital decisions at runtime;
5. repair is not budgeted separately from ordinary dispatch, so recovery can either be blocked or over-broad.

## Alternatives Considered

### Option A: Patch Local Defects Only

Patch PVC target support, add image platform checks, tighten stale-stage calculation, fix ConfigMap mount races, and
refresh empirical job automation.

Pros:

- small implementation PRs;
- directly removes several current failure modes;
- easy to validate with targeted tests.

Cons:

- does not give consumers one action authority;
- leaves deployers without a least-privilege settlement record;
- keeps Torghut capital proof coupled to local interpretation;
- does not budget repair separately from ordinary dispatch.

Decision: required work, but insufficient as the architecture.

### Option B: Global Freeze on Any Degradation

Block all schedule dispatch, rollout widening, and capital transitions whenever execution trust, dependency quorum,
watch reliability, or empirical proof is degraded.

Pros:

- conservative during severe incidents;
- simple to implement and explain;
- prevents accidental widening.

Cons:

- blocks the repair and proof work needed to recover;
- treats stale empirical proof, stale verify, image pull leftovers, and route timeouts as equivalent;
- creates pressure for manual bypass;
- still does not provide a reusable settlement digest.

Decision: keep as emergency brake only.

### Option C: Material Action Settlement Plane

Create a typed settlement result per action class and subject. Settlement consumes proof inputs, negative evidence,
runtime admission, and repair budgets. Consumers fail closed for material actions and stay open for serving,
observation, replay, and bounded repair.

Pros:

- one digest for dispatch, rollout, deployer, and Torghut consumers;
- separates serving health from material action authority;
- supports least-privilege verification;
- turns stale or missing proof into repair budget instead of folklore;
- lets Torghut consume platform proof without reinterpreting Jangar internals.

Cons:

- adds persistence and route contracts;
- requires a shadow comparison period;
- needs strict expiry handling so stale proof never becomes implicit allow.

Decision: select Option C.

## Chosen Architecture

### MaterialActionSettlement

Jangar persists one settlement per action class, subject, namespace, release digest, and evidence cut:

```text
material_action_settlement
  settlement_id
  settlement_digest
  namespace
  action_class              # serve, observe, repair, verify, dispatch, widen, paper_submit, live_submit
  subject_kind              # schedule, swarm_stage, rollout, release, torghut_account_window
  subject_ref
  release_digest
  evidence_cut_digest
  decision                  # allow, degrade, hold, block
  enforcement_mode          # observe, shadow, enforce
  opened_at
  fresh_until
  producer_revision
  proof_refs
  negative_evidence_refs
  repair_budget_refs
  rollback_switch_ref
```

Expiry is fail-closed for material actions. Expiry opens a new proof request or repair budget; it never converts hold to
allow.

### Proof Budget

A proof budget authorizes work while normal material action remains held:

```text
proof_budget
  budget_id
  target_settlement_digest
  repair_class              # stage_reclock, image_attestation, route_probe, empirical_refresh, replay
  allowed_runner
  allowed_image_digest
  allowed_route_refs
  max_runtime_minutes
  max_retries
  retry_cooldown_seconds
  success_condition
  falsification_condition
  stop_condition
  issued_at
  expires_at
  state                     # issued, running, proven, falsified, expired, revoked
```

Proof budgets can run repair, replay, route probes, empirical refresh, and stage reclocking. They cannot submit broker
orders unless a later Torghut paper/live settlement explicitly permits it.

### Consumer Rules

- `/ready` may remain `ok` when serving is safe and material action is held.
- Control-plane status must expose the latest settlement digest and degraded reason classes.
- Supporting primitive schedule reconciliation must check `dispatch` settlement before materializing launch-capable
  resources in enforce mode.
- Deployer checks must accept route-projected settlement proof when privileged cluster or DB APIs are unavailable.
- Torghut must treat Jangar settlement `hold` or expired settlement as a platform capital blocker for paper/live
  actions, while still allowing zero-notional proof budgets.

## Implementation Scope

Engineer stage:

- add settlement schema and route projection in Jangar;
- feed settlement from database status, execution trust, watch reliability, rollout health, runtime admission, workflow
  failures, image/platform proof, and Torghut empirical-service proof;
- add a `dispatch` shadow check in `supporting-primitives-controller.ts`;
- add explicit PVC target coverage or storage proof normalization in the primitives layer;
- add regression tests for stale-stage settlement, image-pull negative evidence, ConfigMap proof, expiry, and
  settlement parity across route/status/schedule consumers;
- add Torghut consumer fields for platform settlement digest and proof budget references.

Deployer stage:

- validate settlement route from least-privilege identity;
- run a seven-day shadow comparison where legacy dispatch decisions and settlement decisions are emitted side by side;
- enable enforce mode first for deployer widening, then dispatch, then Torghut paper capital;
- record rollback switches and prove they restore observe-only behavior.

## Validation Gates

- `GET /ready` remains serving-safe while `dispatch` or `live_submit` is held.
- `GET /api/agents/control-plane/status?namespace=agents` exposes latest settlement digest, decision, expiry, and open
  negative evidence.
- A stale plan or verify stage produces `decision=hold` for dispatch in shadow mode and opens a proof budget.
- A healthy rollout with stale empirical jobs remains `allow` for observe and `hold` for Torghut paper/live capital.
- A least-privilege deployer can validate release digest, schema head, route proof, execution trust, watch reliability,
  and negative evidence without `deployments.apps`, CNPG CRDs, or `pods/exec`.
- Torghut paper/live submission remains blocked until both platform settlement and session proof budget are fresh.

## Rollout

1. Observe: persist settlements and proof budgets, expose route projections, no behavior change.
2. Shadow: compare settlement decisions with current dispatch, deployer, and Torghut decisions; emit mismatch counters
   and evidence links.
3. Enforce deployer widening: deployment promotion checks require `widen` settlement.
4. Enforce dispatch: schedule materialization requires `dispatch` settlement, with proof-budget repair exceptions.
5. Enforce Torghut paper capital: paper/live submission requires platform settlement plus Torghut session proof.

## Rollback

- Disable settlement enforcement flags and return to observe-only projections.
- Keep settlement rows and proof budgets for forensics.
- Revert to existing execution-trust and dependency-quorum gates for immediate operational safety.
- Rollback triggers:
  - settlement/legacy hard mismatch for two consecutive deployment windows;
  - false hold on a known-good dispatch path without negative evidence;
  - settlement route unavailable beyond its freshness budget;
  - Torghut paper/live block clears without fresh empirical or replay proof.

## Risks

- Settlement can become another dashboard if consumers are not forced to cite the digest.
- Producer bugs can create false allow or false hold; shadow comparison must run before enforcement.
- Proof-budget repair work can add cluster pressure unless retry budgets and cooldowns are strict.
- Torghut capital consumers may confuse platform clearance with profitability proof; both are required and neither
  substitutes for the other.

## Handoff Contract

Engineer acceptance:

- settlement schema, projection route, and shadow decision producer are implemented;
- dispatch shadow check lands with tests and no launch behavior change during observe mode;
- storage proof covers PVC-backed workspaces;
- Torghut status includes platform settlement and proof-budget references;
- tests cover expiry, stale stage, stale empirical proof, image-pull negative evidence, least-privilege route proof, and
  consumer parity.

Deployer acceptance:

- least-privilege validation runbook is updated;
- seven-day shadow mismatch report is collected;
- enforce-mode flags and rollback flags are documented;
- first enforcement starts with rollout widening, not broker capital;
- no paper/live Torghut capital reentry occurs without fresh platform settlement and fresh Torghut session proof.
