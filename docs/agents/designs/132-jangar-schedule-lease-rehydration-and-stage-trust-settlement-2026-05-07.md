# 132. Jangar Schedule Lease Rehydration And Stage Trust Settlement (2026-05-07)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-07
Owner: Victor Chen, Jangar Engineering
Scope: Jangar scheduled swarm execution, admission passport rehydration, recovery-case digest rollover, stage trust,
dispatch safety, rollout widening, Torghut capital handoff, validation, and rollback.

Companion Torghut contract:

- `docs/torghut/design-system/v6/136-torghut-capital-repair-escrow-and-freshness-auction-2026-05-07.md`

Extends:

- `131-jangar-cross-plane-evidence-custody-and-dispatch-escrow-2026-05-06.md`
- `130-jangar-synthetic-readiness-settlement-and-evidence-probe-fuses-2026-05-06.md`
- `129-jangar-heartbeat-lane-escrow-and-material-verdict-stability-2026-05-06.md`
- `125-jangar-run-settlement-watermarks-and-consumer-evidence-escrow-2026-05-06.md`

## Decision

I am selecting **schedule lease rehydration with stage trust settlement** as the next Jangar control-plane architecture
step.

The current live control plane is not down. At `2026-05-07T04:55Z`, Argo CD reported `agents` and `jangar` Synced and
Healthy at revision `6c84303fe49b3dc6e275f6302b0b42cd37d69562`. Jangar reported a healthy database with `28`
registered and applied Kysely migrations, healthy controller heartbeats for agents, supporting, and orchestration
controllers, healthy rollout for `deployment/agents` and `deployment/agents-controllers`, and healthy watch reliability
with `1720` events, `0` errors, and `0` restarts in the 15 minute window. That is a materially better posture than the
earlier May 5 outage evidence.

The failure mode has moved from broad availability to stale authority. Jangar execution trust was still degraded
because discover, plan, implement, and verify stages were stale. Scheduled cron jobs were failing even while current
pods and manual jobs could run: a discover schedule failed on `stale schedule admission passport` because the stamped
passport `passport:swarm_plan:f472523d5d549b90` no longer matched the current passport, and an implement schedule
failed on `stale schedule recovery-case digest` because stamped digest `427d3c737f118967` no longer matched
`9083758b60368737`. The schedule guard is doing its job by refusing stale authority, but the schedule object has no
first-class path to rehydrate before launching a doomed job. The result is control-plane churn, stale stage evidence,
and a dependency quorum that delays downstream capital promotion.

The selected design keeps the stale-authority guard and changes what gets stamped. Cron schedules should carry a
renewable lease request, not a long-lived admission passport snapshot. At job creation time, Jangar resolves the current
admission passport, recovery-case digest, runtime-kit digest, and stage window, then emits a stage trust settlement. If
the lease cannot be rehydrated, Jangar records bounded schedule debt and suppresses the material launch instead of
creating a predictable failed job. The tradeoff is one more controller path and a stricter separation between
schedule-intent and execution-authority. I accept that tradeoff because stale schedule failures are now the direct
source of degraded execution trust.

## Runtime Objective And Success Metrics

This contract increases Jangar reliability by making scheduled swarm execution self-rehydrating, auditable, and safe to
use as material trust evidence.

Success means:

- Cron schedules no longer stamp admission passports or recovery-case digests that can expire before launch.
- Each scheduled launch resolves a fresh lease from current runtime admission and recovery evidence.
- Stale lease resolution produces a `suppressed` or `repair_only` settlement, not a fan-out of failed jobs.
- Discover, plan, implement, and verify stages expose trust state from successful terminal AgentRuns and fresh schedule
  lease settlements.
- Normal dispatch and deploy widening can distinguish `stage_trust_current`, `stage_trust_repair_only`, and
  `stage_trust_stale`.
- Torghut receives a compact Jangar stage-trust receipt before paper or live capital reentry.
- Deployer validation stays least-privilege: routes, Kubernetes read/list, and job logs are enough.

## Evidence Snapshot

All evidence was collected read-only. I did not mutate Kubernetes resources, database rows, broker state, trading
flags, GitOps manifests, ClickHouse tables, or AgentRun records.

### Cluster And Rollout Evidence

- `deployment/jangar` in namespace `jangar` was `1/1` available on image
  `registry.ide-newton.ts.net/lab/jangar:39c27b12`.
- `deployment/agents` was `1/1` available, and `deployment/agents-controllers` was `2/2` available.
- Argo CD reported `agents` and `jangar` Synced and Healthy at revision
  `6c84303fe49b3dc6e275f6302b0b42cd37d69562`.
- The active Jangar pod `jangar-56bdb9885b-dss9q` had both containers running and no restarts.
- Recent Agents events showed manual scheduled jobs completing, current stage jobs starting, and cron-generated jobs
  failing when their stamped authority drifted from current control-plane evidence.
- RBAC blocked direct CNPG cluster listing, Secret listing, Knative service listing, and pod exec into Jangar and
  Torghut database pods. The normal validation path must remain route/projection based.

### Jangar Route And Database Evidence

- `/api/agents/control-plane/status?namespace=agents` generated evidence at `2026-05-07T04:55:54.016Z`.
- Jangar database status was healthy: configured, connected, `2ms` latency, `28` registered migrations, `28` applied
  migrations, `0` unapplied, `0` unexpected, latest migration
  `20260505_torghut_quant_pipeline_health_window_index`.
- Leader election was healthy and current: leader identity was `jangar-56bdb9885b-dss9q_...`, with last successful
  attempt at `2026-05-07T04:55:54.096Z`.
- Controller heartbeats were healthy for `agents-controller`, `supporting-controller`, and `orchestration-controller`.
- Watch reliability was healthy with `1720` total events, `0` errors, and `0` restarts.
- Workflows reported `0` active job runs, `0` recent failed jobs, and `0` backoff-limit jobs in the 15 minute status
  window, even though older cron job objects retained failed status.
- Execution trust was degraded because `jangar-control-plane:discover`, `plan`, `implement`, and `verify` stages were
  stale.
- Dependency quorum returned `decision=delay` with reason `execution_trust_degraded`.
- Admission passports were fresh and allowed serving, swarm plan, swarm implement, and swarm verify, but each carried
  reason `execution_trust_degraded`.

### Schedule Failure Evidence

- `job/jangar-control-plane-discover-sched-cron-29635445` failed with:
  `stale schedule admission passport: stamped=passport:swarm_plan:f472523d5d549b90 current=passport:swarm_plan:0c66cd7b8f147304`.
- `job/jangar-control-plane-implement-sched-cron-29635475` failed with:
  `stale schedule recovery-case digest: stamped=427d3c737f118967 current=9083758b60368737`.
- Similar cron-job error pods existed for discover, plan, implement, verify, and Torghut quant schedules during the
  sample window.
- The failure is not missing binaries or NATS tooling. Jangar `/ready` showed healthy collaboration runtime kits:
  `codex-nats-publish`, `codex-nats-soak`, `nats`, workspace path, and NATS URL were all present.
- The failure is not broad controller rollout. Current controller pods and the serving pod were running.

### Torghut Consumer Evidence

- Torghut `/healthz` returned `status=ok`, but `/readyz` returned `status=degraded`.
- Torghut database checks were healthy and schema-current at Alembic head
  `0029_whitepaper_embedding_dimension_4096`.
- Torghut readiness cache was stale by route policy: cache age was about `22.764` seconds against an `8` second TTL.
- Live submission was closed with `simple_submit_disabled`, capital stage `shadow`, and `promotion_eligible_total=0`.
- The proof floor was `repair_only`, capital state `zero_notional`, and max notional `0`.
- Quant evidence was degraded: latest metrics count was `144`, metrics pipeline lag was `5` seconds, but ingestion lag
  was `40241` seconds and materialization lag was `20` seconds.
- Market context was degraded: technicals and regime were stale by about `203766` seconds, fundamentals by about
  `4806744` seconds, and news by about `4439930` seconds.
- TCA settlement was stale from `2026-04-02T20:59:45.136640Z`, with `13775` orders and average absolute slippage about
  `568.6` bps.

### Source Evidence

- `services/jangar/src/server/control-plane-runtime-admission.ts` already builds admission passports and recovery
  warrants with runtime-kit and recovery-case digests.
- `services/jangar/src/server/control-plane-status.ts` already builds execution trust, dependency quorum, stage status,
  action clocks, and rollout health from route and controller evidence.
- `services/jangar/src/server/control-plane-workflows.ts` already evaluates recent workflow reliability from job
  outcomes and backoff-limit signals.
- `services/jangar/src/server/control-plane-watch-reliability.ts` already settles watch freshness and restart counts.
- The high-risk Jangar modules remain concentrated: `supporting-primitives-controller.ts` is `3060` lines,
  `codex-judge.ts` is `2728` lines, and `orchestration-controller.ts` is `2139` lines. Stage-trust logic should be a
  small reducer and controller seam, not more ad hoc branching in those files.
- Jangar has `149` colocated route/server tests. The engineer stage should add focused tests for stale schedule lease
  suppression, successful lease rehydration, and dependency-quorum state changes.

## Problem

Jangar currently prevents stale authority from executing, but it does so too late.

The current failure modes are:

1. **Expiring authority is stamped into schedules.** A CronJob can carry an admission passport or recovery digest that
   is valid at render time but stale by launch time.
2. **The guard creates failed jobs instead of schedule settlements.** Stale authority is detected inside the launched
   job, so the system spends cluster churn to learn a result the controller could have settled before launch.
3. **Stage trust depends on terminal job evidence that the scheduler keeps poisoning.** Repeated stale-authority
   failures make discover, plan, implement, and verify look stale even when the current runtime kit is healthy.
4. **Manual and cron paths diverge.** Manual jobs can complete against fresh authority while cron jobs fail against old
   annotations, which makes operator evidence hard to interpret.
5. **Downstream capital sees platform delay, not the exact stage debt.** Torghut receives `execution_trust_degraded`
   but not a precise schedule-lease repair target.
6. **Least-privilege validators cannot inspect the database directly.** Schedule trust must be projected through
   Jangar routes and Kubernetes status, not hidden in pod internals.

## Alternatives Considered

### Option A: Keep Stamped Schedule Passports And Increase Cron Refresh Frequency

Pros:

- Minimal controller change.
- Keeps the current safety guard untouched.
- Can reduce failures when refresh and launch happen close together.

Cons:

- Does not remove the race between refresh and job creation.
- Creates more schedule churn and more GitOps or controller writes.
- Still fails whenever recovery-case digest rollover happens between stamp and launch.
- Does not produce a first-class stage trust settlement.

Decision: reject.

### Option B: Stop Checking Schedule Passport And Recovery Digest Drift

Pros:

- Cron jobs stop failing for stale annotations.
- Implementation is small.
- Stage freshness may look better in the short term.

Cons:

- Reintroduces stale authority execution.
- Lets old runtime and recovery assumptions perform material work.
- Breaks the safety property introduced by runtime admission passports.
- Makes Torghut capital gates less trustworthy.

Decision: reject.

### Option C: Schedule Lease Rehydration With Stage Trust Settlement

Pros:

- Preserves the stale-authority guard while moving it before job fan-out.
- Uses current admission passports and recovery digests at launch time.
- Converts stale schedule evidence into explicit repair debt instead of failed jobs.
- Gives dependency quorum and Torghut capital gates precise stage-trust reason codes.
- Works with read-only deployer validation through routes and job status.

Cons:

- Requires a new lease resolver and settlement store/projection.
- Requires rollout care so existing CronJobs are not double-scheduling during cutover.
- Makes schedule launch dependent on a short path to current control-plane status.

Decision: select Option C.

## Architecture

Jangar adds a renewable lease layer between schedule intent and AgentRun launch.

```text
schedule_lease_request
  schedule_name
  namespace
  swarm_name
  stage
  consumer_class
  desired_runtime_profile
  required_recovery_case_set
  required_runtime_kits
  max_lease_age_seconds
  launch_window
```

At launch time, the scheduler asks the Jangar lease resolver for current authority:

```text
schedule_lease_receipt
  receipt_id
  request_ref
  generated_at
  fresh_until
  current_admission_passport_id
  current_recovery_case_digest
  current_runtime_kit_set_digest
  stage_window
  decision                  # allow, repair_only, suppress, block
  reason_codes
  launch_authority_ref
```

The stage-trust settlement consumes lease receipts and terminal AgentRun evidence:

```text
stage_trust_settlement
  settlement_id
  generated_at
  namespace
  swarm_name
  stage
  last_successful_run_ref
  last_successful_run_completed_at
  latest_schedule_receipt_ref
  schedule_authority_state  # current, rehydrated, suppressed, stale, missing
  trust_state               # current, repair_only, stale, blocked
  action_class_effects
  fresh_until
```

### Decision Semantics

- `allow`: launch the scheduled AgentRun with the current lease receipt attached.
- `repair_only`: launch only if the AgentRun has no capital authority and no deploy-widen authority.
- `suppress`: do not create a Kubernetes job; record schedule debt and expose it in status.
- `block`: hold the schedule because the lease resolver cannot prove current authority or runtime kits.

### Material Action Effects

- `serve_readonly`: allowed when Jangar readiness, database, and controller heartbeat are healthy.
- `dispatch_repair`: allowed when the affected stage is `repair_only` or better and runtime kit is healthy.
- `dispatch_normal`: allowed only when discover, plan, implement, and verify stage trust are current.
- `deploy_widen`: allowed only when stage trust is current and rollout health is healthy for the current revision.
- `paper_canary` and `live_micro_canary`: require current stage trust plus Torghut proof-floor clearance.

## Implementation Scope

Engineer stage should implement the minimum production slice:

- Add a schedule lease resolver that reads current runtime admission, recovery warrants, and runtime-kit digests.
- Change scheduled swarm jobs to carry a lease request reference rather than a stamped passport/digest pair.
- Add a stage-trust reducer that consumes lease receipts, terminal AgentRun status, and workflow reliability.
- Expose schedule lease and stage trust in `/api/agents/control-plane/status`.
- Update dependency quorum so stale schedule leases produce `stage_trust_degraded` instead of opaque
  `execution_trust_degraded`.
- Add tests for current lease success, stale stamp suppression, repair-only launch, and dependency-quorum delay.

Out of scope for the first implementation:

- Replacing AgentRun CRDs.
- Granting broader pod exec, Secret, CNPG, or Knative RBAC.
- Changing Torghut live submission toggles.
- Mutating database rows outside normal migrations.

## Validation Gates

Local validation:

- `bun run --filter @proompteng/jangar test -- src/server/__tests__/control-plane-runtime-admission.test.ts`
- `bun run --filter @proompteng/jangar test -- src/server/__tests__/control-plane-status.test.ts`
- `bun run --filter @proompteng/jangar lint`
- `bun run --filter @proompteng/jangar tsc`

Cluster validation after deploy:

- `kubectl -n agents get deploy agents agents-controllers -o wide`
- `kubectl -n jangar get deploy jangar -o wide`
- `curl -sS http://jangar.jangar/api/agents/control-plane/status?namespace=agents | jq '.database,.execution_trust,.dependency_quorum,.stage_trust'`
- Confirm no new cron job fails with `stale schedule admission passport` or `stale schedule recovery-case digest`
  during two schedule windows.
- Confirm a purposely stale test schedule records `decision=suppress` without creating a failed job.

## Rollout Plan

1. Ship status-only stage-trust projection with no schedule behavior change.
2. Enable lease resolution for one non-capital discover schedule.
3. Enable suppress-on-stale for discover and plan schedules.
4. Extend to implement and verify after two clean windows.
5. Make dependency quorum consume stage trust.
6. Let Torghut consume the Jangar stage-trust receipt for capital repair escrow.

## Rollback Plan

Rollback is feature-flagged and conservative:

- Disable schedule lease rehydration and fall back to existing stamped schedule validation.
- Keep stage-trust projection read-only for post-incident diagnosis.
- Leave live/paper Torghut capital held if stage trust is stale or unavailable.
- Revert the Jangar image through GitOps if lease resolution blocks healthy schedule launch.

## Risks And Mitigations

- **Lease resolver outage:** treat as `suppress` for normal dispatch and `repair_only` for explicitly safe repair lanes.
- **Clock skew:** compare freshness windows using Jangar server time and include observed source timestamps.
- **Duplicate launches:** use existing AgentRun idempotency plus lease receipt id as the launch key.
- **Over-conservative dispatch:** let read-only serving and bounded repair continue when stage trust is degraded.
- **Hidden consumer impact:** expose the stage, schedule, decision, and reason codes in the control-plane status route.

## Handoff To Engineer

Build the lease resolver and stage-trust reducer first. Do not widen RBAC to solve this. The acceptance bar is that a
stale schedule no longer creates a failed job just to discover its passport or recovery digest is stale. It should
create an auditable settlement, suppress or repair-only the launch, and update dependency quorum with a precise reason.

## Handoff To Deployer

Treat this rollout as a scheduler authority change, not a generic Jangar image promotion. Start with one discover
schedule. Hold deploy widening if any schedule lease receipt is missing, stale, or suppressing without a matching repair
ticket. Do not enable Torghut paper or live capital until Jangar stage trust is current and Torghut proof-floor
receipts clear.
