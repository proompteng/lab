# 68. Jangar Evidence Clock Arbiter and Rollout Veto Contract (2026-05-05)

Status: Approved for implementation (`discover`)
Date: `2026-05-05`
Owner: Victor Chen (Jangar Engineering)
Mission: `codex/swarm-jangar-control-plane-discover`
Swarm impacts:

- `jangar-control-plane`
- `torghut-quant`

Companion doc:

- `docs/torghut/design-system/v6/73-torghut-profit-evidence-clock-and-capital-veto-contract-2026-05-05.md`

Extends:

- `66-jangar-recovery-release-lanes-and-rollout-proof-fence-contract-2026-03-21.md`
- `65-jangar-recovery-epoch-cutover-and-backlog-seat-enforcement-contract-2026-03-21.md`
- `59-jangar-authority-session-bus-and-rollout-lease-contract-2026-03-20.md`

## Executive Summary

The decision is to build an **Evidence Clock Arbiter** for Jangar. Serving readiness can stay available when the
HTTP surface is usable, but dispatch, scheduled launch, rollout widening, and downstream live-capital promotion must
cite fresh, typed evidence clocks before they are allowed to proceed.

I am choosing this over a local patch-only fix because the live evidence shows multiple clocks disagreeing at once:

- `GET /ready` on Jangar returned `status="ok"` while `execution_trust.status="degraded"`;
- `GET /api/agents/control-plane/status?namespace=agents` reported healthy database state with `25/25` Kysely
  migrations applied, but stale discover/plan/implement/verify stages and five pending requirements;
- `kubectl -n agents get pods` showed one `agents-controllers` pod at `0/1 Ready`, and `kubectl describe` showed
  repeated readiness probe `503` responses;
- scheduled Jangar and Torghut swarm CronJobs failed with a Bun inline `-e` parse error in the generated schedule
  runner command;
- the supporting controller logs reported `workspace pvc watch failed` because `persistentvolumeclaim` is emitted as a
  watched resource but is not supported by the Kubernetes resource resolver;
- Torghut schema checks were healthy, but market-context domains were stale and all current hypotheses were
  non-promotable.

The tradeoff is that this adds one more control-plane layer before enforcement. I am accepting that cost because the
six-month risk is not a single broken CronJob. The durable risk is that rollout health, controller heartbeat, scheduled
dispatch, and Torghut profitability evidence can all tell different stories and still let work or capital move.

## Success Criteria

This architecture is done when engineer and deployer stages can prove all of the following:

1. every launchable scheduled run has a fresh `schedule_runner_clock` produced by code that parsed successfully before
   the CronJob was written;
2. every watched control-plane resource has a typed resolver or an explicit soft-degraded unsupported-resource clock;
3. `/api/agents/control-plane/status`, `/ready`, deploy verification, and schedule dispatch all expose the same
   evidence-clock ids and freshness decisions;
4. fresh controller heartbeats take precedence over rollout-derived fallback status, so a degraded heartbeat cannot be
   hidden by an otherwise available deployment;
5. rollout widening fails closed when required clocks are stale, contradictory, or absent;
6. Torghut receives the Jangar clock summary as a promotion input, not as a best-effort advisory string.

## Evidence Snapshot

### Runtime Inputs

- repository: `proompteng/lab`
- base: `main`
- head: `codex/swarm-jangar-control-plane-discover`
- swarmName: `jangar-control-plane`
- swarmStage: `discover`
- objective: assess cluster, source, and database state and merge architecture artifacts that improve Jangar
  resilience/reliability and Torghut profitability

### Cluster, Rollout, and Event Evidence

Read-only Kubernetes access used the `agents` service account. The account can list pods, jobs, CronJobs, events, and
Jangar/Torghut namespaces, but cannot list nodes, Argo CD Applications, CNPG cluster objects, deployments in several
namespaces, or exec into database pods. That RBAC shape is acceptable for an agent-runner, but it means deploy gates
must use typed status surfaces and durable projections rather than privileged shell checks.

Current cluster facts:

- `kubectl -n jangar get pods -o wide` showed the primary Jangar pod, Jangar database pod, Redis, OpenWebUI, Bumba,
  and Symphony pods running.
- `kubectl -n agents get pods -o wide` showed one `agents-controllers` replica ready and one replica running but not
  ready. The not-ready pod used the promoted `17e7d865` image and failed readiness with HTTP `503`.
- `kubectl -n agents get job,cronjob` showed older scheduled Jangar and Torghut swarm CronJobs failed while hotfix jobs
  completed and fresh agent-runner jobs were running.
- `kubectl -n agents logs job/jangar-control-plane-discover-sched-cron-29632805 --tail=160` and the Torghut discover
  equivalent both failed in the same generated Bun command with `Expected ";" but found "import"`.
- `kubectl -n agents get events --sort-by=.lastTimestamp | tail -n 80` showed `UnexpectedJob` warnings for hotfix jobs
  and fresh schedule-created jobs.
- `kubectl -n torghut get pods -o wide` showed the live Torghut service running, ClickHouse and Postgres running, and a
  Torghut simulation revision in `ImagePullBackOff` because the digest had no matching platform manifest on one node.
- `kubectl -n torghut get events --sort-by=.lastTimestamp | tail -n 80` showed a failed `torghut-00200` and
  `torghut-sim-00280` revision followed by `torghut-00201` becoming ready.

Interpretation: the cluster is serving, but it is not proving promotion safety. Rollout availability, schedule launch
correctness, controller heartbeat health, and downstream data freshness are currently separable and sometimes
contradictory.

### Source Architecture and Test-Gap Evidence

High-risk source surfaces:

- `services/jangar/src/server/supporting-primitives-controller.ts`
  - `buildScheduleRunnerCommand()` returns an inline module script joined by newlines and passed to `bun -e`;
  - the live CronJob failure proves this command needs a parser/golden test and a pre-admission build artifact, not just
    runtime best effort;
  - workspace PVC watching calls `startResourceWatch({ resource: 'persistentvolumeclaim', ... })`.
- `services/jangar/src/server/primitives-kube.ts`
  - `resolveTargetFromResource()` has custom-resource lookup and builtin mapping, but no builtin entry for
    `persistentvolumeclaim`;
  - unsupported resources throw, which converts a watch-contract gap into control-plane warning churn.
- `services/jangar/src/server/control-plane-status.ts`
  - status can use heartbeat authority when present, but it can also derive healthy controller/runtime status from
    rollout availability;
  - the live status endpoint alternated between rollout-derived healthy answers and heartbeat-derived degraded answers,
    which is useful evidence but unsafe as a promotion gate unless the precedence is explicit.
- `services/jangar/src/routes/ready.tsx`
  - serving readiness stays intentionally narrower than promotion health;
  - that separation is correct, but the response must publish the clocks it is ignoring so operators do not infer
    promotion safety from HTTP availability.

Existing tests are broad, especially under `services/jangar/src/server/__tests__`, but this incident identifies missing
coverage:

- no schedule-runner generated-command parse test that would have failed before the CronJob did;
- no resource resolver regression for core resources watched by supporting primitives, especially PVCs;
- no status precedence test proving a fresh degraded heartbeat wins over rollout-derived availability;
- no cross-route parity test requiring `/ready`, status, and deploy verification to cite the same clock ids.

### Database, Data, and Freshness Evidence

Jangar database status:

- `GET /api/agents/control-plane/status?namespace=agents` reported `database.connected=true`;
- migration table: `kysely_migration`;
- registered migrations: `25`;
- applied migrations: `25`;
- latest registered and applied migration: `20260418_embedding_dimension_4096`;
- observed latency was single-digit milliseconds in the sampled response.

Torghut data status:

- `GET /healthz` returned `{"status":"ok","service":"torghut"}`;
- `GET /db-check` returned `ok=true`, current Alembic head `0029_whitepaper_embedding_dimension_4096`, and
  `schema_graph_lineage_ready=true`;
- the same `/db-check` response still reported migration parent-fork warnings, which are documented but should remain
  visible in promotion evidence;
- `GET /trading/health` returned Postgres and ClickHouse `ok=true`, Alpaca `broker_ok`, and live submission
  `capital_stage="live"`;
- the same Torghut health response reported `dependency_quorum.decision="unknown"`, `hypotheses_total=3`,
  `promotion_eligible_total=0`, and `rollback_required_total=3`;
- `GET /api/torghut/market-context/health?symbol=NVDA` through Jangar reported `overallState="degraded"` with stale
  technicals, fundamentals, news, and regime domains.

Interpretation: database schema is not the blocking problem. The problem is freshness and consistency across
data-derived authority surfaces.

## Problem Statement

Jangar has enough telemetry to see risk, but it does not yet have one control-plane object that can arbitrate risk.
Today a rollout can look healthy, a controller heartbeat can be degraded, a scheduled launch can fail on generated
JavaScript, and Torghut can still expose live-capital readiness language while its dependency and hypothesis evidence
are not promotable.

The current failure modes are:

1. serving health is mistaken for promotion health;
2. rollout-derived fallback can be treated as equivalent to a fresh controller heartbeat;
3. generated schedule-runner code is admitted before parse proof exists;
4. unsupported watch resources degrade the controller after deployment instead of being caught in contract tests;
5. downstream consumers cannot compare Jangar evidence with their own profit-readiness evidence by id, observed time,
   and expiry.

## Alternatives Considered

### Option A: Patch the Local Defects Only

Patch the generated schedule-runner command, add the missing PVC resource resolver, and keep the current status model.

Pros:

- fastest path to reducing current warning and CronJob noise;
- smallest code change;
- likely enough to make the next scheduled run succeed.

Cons:

- does not address contradictory status authority;
- does not give deployers a rollout-veto object;
- does not give Torghut a stable promotion input;
- repeats the same pattern the next time a generated command, watch resource, or readiness source changes.

Decision: rejected as the architecture answer. These patches are still part of the implementation scope, but they are
not the six-month control-plane design.

### Option B: Make `/ready` Fail on Any Degraded Evidence

Treat serving readiness as the global safety gate: if execution trust, Torghut freshness, controller heartbeats, or
schedule launch evidence degrade, return HTTP `503`.

Pros:

- easy for operators and Kubernetes to understand;
- reduces optimistic green surfaces;
- forces attention when evidence is stale.

Cons:

- creates unnecessary serving outages when the UI/API can still help recovery;
- risks restart loops during exactly the periods when humans need status;
- couples Torghut profit evidence to Jangar HTTP availability too tightly;
- encourages every subsystem to overload one readiness bit.

Decision: rejected. Serving must stay recoverable. Promotion must become stricter.

### Option C: Add an Evidence Clock Arbiter With Promotion and Rollout Vetoes

Write every required safety input as an evidence clock with a subject, producer, observed time, expiry, class, decision,
and reason codes. Let `/ready` expose clocks but only block on serving-class clocks. Let dispatch, schedule launch,
rollout widening, and Torghut capital promotion require promotion-class clocks.

Pros:

- fixes the actual truth split without taking down the serving surface;
- makes controller heartbeat, generated code, Kubernetes watch, rollout, database, and Torghut data freshness
  comparable;
- enables shadow rollout before enforcement;
- gives engineer and deployer stages concrete acceptance gates.

Cons:

- requires additive schema, status, and tests;
- requires careful precedence rules so the arbiter does not become another ambiguous summary;
- enforcement will take at least two rollout steps.

Decision: selected.

## Decision

Build the Evidence Clock Arbiter and make it the authority for promotion-class decisions.

The arbiter has four jobs:

1. collect typed clocks from controllers, schedules, database checks, Kubernetes watch startup, rollout health,
   execution trust, and downstream Torghut capability checks;
2. publish one clock summary through `/api/agents/control-plane/status`, `/ready`, and deploy verification;
3. produce rollout and dispatch vetoes when required promotion clocks are stale, contradictory, or absent;
4. emit a stable consumer contract for Torghut so capital movement can cite Jangar evidence ids rather than parse prose.

## Target Model

Add an additive projection, either as tables first or as CR status fields if the engineer chooses to stage in Kubernetes
before database persistence:

```text
control_plane_evidence_clocks
  clock_id
  subject_kind              # controller, schedule_runner, kube_watch, rollout, execution_trust, database, consumer
  subject_namespace
  subject_name
  evidence_class            # serving, promotion, profit, diagnostic
  producer
  producer_pod
  observed_at
  fresh_until
  decision                  # allow, delay, block, unknown, diagnostic
  reason_codes
  evidence_digest
  payload_ref
  created_at

control_plane_rollout_vetoes
  veto_id
  rollout_ref
  required_clock_ids
  decision                  # allow, delay, block
  reason_codes
  evaluated_at
  expires_at
```

Clock producers required in the first implementation wave:

- `controller_heartbeat_clock`
  - heartbeat status, deployment, pod, and freshness;
  - a fresh degraded heartbeat wins over rollout fallback.
- `schedule_runner_clock`
  - generated command digest;
  - parse result;
  - target kind;
  - service account and namespace;
  - last successful launch id.
- `kube_watch_clock`
  - watched resource;
  - resolver target;
  - startup result;
  - restart/error counters.
- `database_schema_clock`
  - migration table;
  - registered and applied counts;
  - latest migration id;
  - latency and connection status.
- `execution_trust_clock`
  - dependency quorum, stale stages, pending requirement counts, and freshness.
- `consumer_profit_clock`
  - Torghut capability and freshness summary from the companion contract.

## Implementation Scope

Engineer stage should implement this in four ordered slices.

1. Fix and prove local contract defects.
   - Add a `persistentvolumeclaim` builtin resolver in `primitives-kube.ts`.
   - Add unit coverage for the PVC watch resource.
   - Extract schedule-runner command construction behind a parser-tested helper.
   - Add a regression test that compiles or parses the generated Bun script exactly as CronJob will receive it.

2. Add shadow evidence clocks.
   - Start with in-process clock emission and status projection if schema work would delay the fix.
   - Persist clocks once the schema is ready.
   - Expose clocks in `/api/agents/control-plane/status` and `/ready` without changing enforcement.

3. Add arbiter decisions.
   - Define required clocks for `dispatch`, `schedule_launch`, `rollout_widen`, and `torghut_capital_promotion`.
   - Emit `allow`, `delay`, `block`, or `unknown` with reason codes.
   - Keep serving readiness separate from promotion vetoes.

4. Enforce in rings.
   - Ring 0: shadow only, no behavioral block.
   - Ring 1: block newly generated broken schedules and unsupported watches.
   - Ring 2: block rollout widening and dispatch when promotion clocks are stale.
   - Ring 3: require Torghut live capital promotion to cite the Jangar clock summary.

## Validation Gates

Local validation for engineer stage:

- `bun --cwd services/jangar run test -- src/server/__tests__/primitives-kube.test.ts`
- `bun --cwd services/jangar run test -- src/server/__tests__/supporting-primitives-controller.test.ts`
- `bun --cwd services/jangar run test -- src/server/__tests__/control-plane-status.test.ts`
- `bun --cwd services/jangar run tsc`
- `bun --cwd services/jangar run lint`

Required new tests:

- generated schedule-runner script parses before it can be embedded in a CronJob;
- PVC resource watching resolves as a core Kubernetes resource;
- a fresh degraded heartbeat beats rollout-derived fallback status;
- `/ready` exposes promotion-clock degradation while keeping serving semantics explicit;
- deploy verification blocks rollout widening when the arbiter returns `block`;
- Torghut consumer projection rejects unknown or stale Jangar promotion clocks for non-observe capital.

Cluster validation for deployer stage:

- `kubectl -n agents get pods -o wide` shows all controller pods ready after rollout;
- `kubectl -n agents get events --sort-by=.lastTimestamp | tail -n 80` has no new schedule-runner parse failures;
- `GET /api/agents/control-plane/status?namespace=agents` includes evidence-clock ids, freshness, and arbiter decisions;
- `GET /ready` remains serving-readable and names any ignored promotion blockers;
- a controlled shadow schedule launch produces a fresh `schedule_runner_clock`;
- Torghut `/trading/health` consumes the Jangar clock summary before allowing non-observe capital.

## Rollout Plan

1. Land parser and resolver fixes first with tests.
2. Ship shadow clock emission with a disabled enforcement flag:
   - `JANGAR_EVIDENCE_CLOCKS_ENABLED=true`
   - `JANGAR_EVIDENCE_CLOCKS_ENFORCEMENT=shadow`
3. Confirm parity across status, readiness, deploy verification, and schedule-runner clocks for one full scheduled
   cadence.
4. Enable `schedule_launch` enforcement only.
5. Enable rollout-widen enforcement.
6. Enable Torghut capital-promotion enforcement after the companion Torghut contract is deployed.

## Rollback Plan

Rollback must not require schema deletion.

- Set `JANGAR_EVIDENCE_CLOCKS_ENFORCEMENT=shadow` to stop behavioral blocks while preserving evidence.
- If shadow emission itself fails, set `JANGAR_EVIDENCE_CLOCKS_ENABLED=false`.
- Keep parser and PVC resolver fixes in place; they are safe forward fixes, not experimental enforcement.
- If a rollout is already blocked by stale clocks, deployer may clear only the enforcement mode, not delete historical
  clock rows.
- After rollback, run the same status and schedule checks to prove the system returned to the previous serving model.

## Risks and Open Questions

- The arbiter can become another summary layer if reason codes and required clocks are not strict. Implementation must
  keep reason codes typed and testable.
- Clock storage volume may grow quickly. Retention should default to seven days for detailed payloads and thirty days
  for compact decisions unless operations chooses a different policy.
- The first version should not require privileged database or cluster access for deploy verification. It should consume
  status projections because agent-runner RBAC cannot exec into DB pods or list cluster-scope nodes.
- The controller currently has multiple status authorities. The implementation must explicitly document precedence:
  fresh heartbeat, then typed arbiter clock, then rollout fallback only when no fresh heartbeat exists.

## Handoff to Engineer

Implement the first two slices together: local defect fixes plus shadow clock projection. Do not begin enforcement until
the generated schedule-runner parse test, PVC resolver test, and heartbeat precedence test are green.

Acceptance gates:

- schedule CronJobs no longer fail on inline Bun import parsing;
- workspace PVC watch startup no longer logs unsupported-resource errors;
- status includes at least controller, schedule-runner, database, execution-trust, and Kubernetes-watch clocks;
- `/ready` stays explicit about serving versus promotion class;
- no promotion-class decision is inferred from rollout health alone.

## Handoff to Deployer

Deploy in shadow mode first. Do not widen enforcement until one scheduled cadence has fresh clocks for Jangar discover,
plan, implement, and verify lanes and no new schedule-runner parse failures.

Rollback gate:

- if any controller pod is not ready or clock emission blocks serving readiness, revert enforcement to `shadow` and keep
  the parser/resolver fixes deployed.
