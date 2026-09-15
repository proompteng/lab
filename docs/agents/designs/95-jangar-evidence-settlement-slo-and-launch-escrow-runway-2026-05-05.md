# 95. Jangar Evidence Settlement SLO And Launch Escrow Runway (2026-05-05)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-05
Owner: Victor Chen, Jangar Engineering
Scope: Jangar control-plane resilience, schedule launch authority, database evidence settlement, Torghut proof
consumption, rollout brakes, and engineer/deployer acceptance gates.

Companion Torghut contract:

- `docs/torghut/design-system/v6/99-torghut-profit-proof-escrow-and-repair-dividend-slo-2026-05-05.md`

Extends:

- `94-jangar-proof-backed-rollout-brake-and-repair-debt-ledger-2026-05-05.md`
- `93-jangar-torghut-proof-sample-settlement-and-repair-close-loop-2026-05-05.md`
- `92-jangar-torghut-proof-feed-route-budget-and-quorum-split-2026-05-05.md`
- `docs/torghut/design-system/v6/98-torghut-repair-dividend-ledger-and-capital-reentry-guard-2026-05-05.md`

## Decision

I am choosing an **evidence-settlement SLO with launch escrow** as the next six-month control-plane direction.

The previous designs got the contracts right: proof feed, producer/consumer settlement, rollout brake, and repair debt.
The live system now needs a stricter sequencing rule. Jangar should not ask engineer and deployer stages to infer whether
it is safe to launch more work from a mix of pod phase, stale verify runs, empirical job state, route health, and database
checks. Jangar should publish one current settlement SLO per action class, then require every new schedule launch, repair
run, and promotion to cite a launch escrow receipt bound to that settlement.

The tradeoff is friction in a system that already has many moving parts. I accept that because the evidence shows the
current risk is not lack of automation. The risk is unpriced actuation while the platform still carries failed pods,
stale verify state, broad dependency blocks, and stale Torghut empirical proof.

## Evidence Snapshot

All assessment for this design pass was read-only. No Kubernetes resources or database rows were mutated.

### Cluster And Rollout Evidence

- Current branch was `codex/swarm-jangar-control-plane-plan`; it was fast-forwarded to current `origin/main` before
  authoring this document.
- `kubectl config current-context` was unset, but in-cluster reads worked as `system:serviceaccount:agents:agents-sa`.
- The same service account could list pods and AgentRuns, but direct Deployment reads in `jangar`, Argo Application
  reads, Endpoint reads in `torghut`, and CNPG `pods/exec` database access were forbidden. The design cannot depend on
  privileged deployer-only reads for routine admission.
- `kubectl get pods -n agents --no-headers` showed `Completed 47`, `Error 16`, and `Running 14` during assessment.
- `kubectl get agentruns -n agents` showed multiple active long-running Jangar verify runs, a running Jangar plan run,
  and recent failed Torghut/Jangar verify or discover runs.
- Recent `agents` events showed controller readiness probe timeouts, `BackoffLimitExceeded` jobs, and a rolling update
  of `agents` and `agents-controllers`.
- Jangar serving pods were mostly healthy, but recent `jangar` events showed repeated startup readiness failures and
  prior app container backoff while new images rolled.
- Torghut live and sim serving pods were currently running, but `torghut-00224` had recent restarts and readiness/liveness
  symptoms in the recent window.

### Source Architecture Evidence

- `services/jangar/src/server/supporting-primitives-controller.ts` is 2,878 lines and owns schedule runners, swarms,
  status, signal delivery, workspaces, PVC lifecycle, and resource watches. This is the actuation choke point.
- `supporting-primitives-controller.ts` already blocks schedule runner creation on runtime admission and deletes runner
  resources when admission fails. That is the right insertion point for launch escrow.
- `services/jangar/src/server/control-plane-status.ts` already aggregates rollout health, database status, workflows,
  watch reliability, empirical services, execution trust, and runtime admission. This is the right source for settlement
  SLO computation.
- `services/jangar/src/server/control-plane-empirical-services.ts` still maps the configured Torghut status URL into
  forecast, LEAN, and empirical-job posture. After the latest main fix it reads Torghut autonomy status, but it still
  emits broad service status rather than a durable producer/consumer settlement object.
- `services/jangar/src/server/primitives-kube.ts` supports PVCs through the generic Kubernetes client, and
  `supporting-primitives-controller.ts` reconciles Workspace PVCs in the same controller path as schedules. Storage
  repair work needs the same launch escrow as schedule work so it cannot become a parallel retry storm.
- Test coverage exists for control-plane status quorum, watch reliability blocks/delays, empirical jobs degradation,
  runtime admission, kube helpers, readiness, and supporting-primitives behavior. Missing coverage is cross-domain:
  failed jobs plus healthy rollout, stale verify plus fresh database, PVC repair plus schedule freeze, and Torghut stale
  proof opening only zero-notional repair.

### Database And Data Evidence

- CNPG direct `psql` for `jangar-db` and `torghut-db` failed because the runtime identity cannot create `pods/exec` in
  those namespaces. This is expected least-privilege behavior and should remain true for routine agents.
- Jangar `/api/agents/control-plane/status?namespace=agents` reported database `connected=true`, `status=healthy`, 3 ms
  latency, and migration consistency healthy: 28 registered migrations, 28 applied migrations, 0 unapplied, 0 unexpected,
  latest `20260505_torghut_quant_pipeline_health_window_index`.
- The same Jangar status reported dependency quorum `block` because `empirical_jobs_degraded`, and execution trust
  `degraded` because `jangar-control-plane:verify` is stale.
- Jangar rollout health reported two configured `agents` deployments healthy, which is useful but insufficient because
  failed pods and stale verify state were still present in the same operating window.
- Torghut `/db-check` returned `ok=true`, `schema_current=true`, current/expected Alembic head
  `0029_whitepaper_embedding_dimension_4096`, one current head, one expected head, no missing or unexpected heads, and
  lineage-ready state with known parent-fork warnings.
- Torghut `/readyz` and `/trading/health` returned HTTP 503 with structured degraded data: Postgres, ClickHouse, Alpaca,
  and database schema were OK; live submission was blocked by `simple_submit_disabled`; capital was in `shadow`; three
  hypotheses existed, zero were promotion eligible, and three required rollback.
- Torghut `/trading/empirical-jobs` returned `ready=false`, `status=degraded`, `authority=blocked`, and four stale
  completed jobs: `benchmark_parity`, `foundation_router_parity`, `janus_event_car`, and `janus_hgrm_reward`.
- Torghut `/trading/profitability/runtime` returned a 72-hour window with 8 decisions, 0 executions, and 0 TCA samples.
- Torghut options catalog `/healthz` returned `ready=true`, but `last_success_ts=null` and last error detail
  `<urlopen error timed out>`. This is a concrete example of ready state diverging from useful data proof.
- ClickHouse guardrail metrics on port 9108 showed both replicas reachable, free-disk ratios near 0.97, no read-only
  replicated tables, fresh TA signal/microbar timestamps, successful last scrape, and nonzero historical low-memory
  fallback counters. Those counters should price route cost rather than disappear behind a binary ready bit.

## Problem

Jangar already has enough evidence to know when the platform is degraded. It does not yet have a single enforceable SLO
that says which actions are still allowed while that degradation is present.

That creates four failure modes:

1. **Healthy rollout hides active failure tails.** The `agents` deployments can be healthy while recent pods are Error,
   AgentRuns remain stale, and verify runs are still running.
2. **Database health is treated as global permission.** Jangar and Torghut schemas are current, but schema health does
   not mean empirical proof is fresh or capital can reenter.
3. **Ready endpoints overstate data value.** The options catalog can return ready while reporting no successful data
   timestamp and a timeout. That should not satisfy proof freshness.
4. **Repair launches are not escrowed.** The system needs zero-notional repair to restore stale empirical jobs, but it
   must rank and bound those launches while rollout and execution debt are still present.

The current contracts define receipts. The missing piece is an adoption runway that makes those receipts the admission
currency for engineer and deployer stages.

## Alternatives Considered

### Option A: Keep The Proof Contracts Advisory

Leave proof feeds, debt receipts, and rollout brakes as status surfaces. Engineer and deployer stages read them and make
case-by-case decisions.

Pros:

- Lowest immediate implementation cost.
- Preserves flexibility for operators during incidents.
- Avoids another database-backed object.

Cons:

- Keeps action safety dependent on human interpretation of multiple screens.
- Does not stop scheduled launches when failed pods and stale verify state are already visible.
- Does not produce a single acceptance gate for CI, rollout, or rollback.

Decision: reject. Advisory proof is useful for discovery, but it is too weak for the next operating mode.

### Option B: Tune Cadence, Probes, And Timeouts

Reduce CronJob cadence, increase startup/readiness windows, and tune Torghut route timeouts.

Pros:

- Addresses several symptoms quickly.
- Reduces noise from rollout churn.
- Does not require new schema.

Cons:

- Does not distinguish serving, plan, implement, verify, repair, paper capital, and live capital.
- Can hide real degradation by making probes more forgiving.
- Leaves stale empirical proof and launch pressure coupled only by convention.

Decision: use as local remediation, but do not treat it as the architecture.

### Option C: Evidence-Settlement SLO With Launch Escrow

Materialize one settlement SLO per namespace/action window and require every new launch or promotion to cite a fresh
launch escrow receipt.

Pros:

- Converts current evidence into enforceable action-class decisions.
- Lets serving continue while risky launches are delayed or blocked.
- Gives zero-notional repair a bounded path even when capital remains closed.
- Works with least-privilege route/status evidence, not privileged DB exec.
- Produces a concrete handoff contract for engineer and deployer stages.

Cons:

- Adds persistence and adoption complexity.
- Requires careful shadow rollout so stale receipts do not freeze the platform.
- Forces each repair to declare success evidence and expected debt reduction.

Decision: select Option C.

## Chosen Architecture

### EvidenceSettlementSLO

Jangar materializes a settlement SLO for each namespace and action window:

```text
evidence_settlement_slo
  settlement_id
  namespace
  generated_at
  fresh_until
  producer_revision
  rollout_window
  execution_window
  data_window
  database_window
  action_class_decisions
  blocking_reasons
  delayed_reasons
  evidence_refs
```

The SLO is computed from existing surfaces first: rollout health, workflow reliability, AgentRun phase counts, execution
trust, database migration consistency, empirical services, Torghut proof samples, options catalog proof, and ClickHouse
guardrail metrics. It must keep source refs short and durable: Kubernetes object refs, route URLs, response digests,
migration heads, and artifact IDs.

### Action Classes

Every settlement emits decisions for:

- `serve`
- `discover`
- `plan`
- `implement`
- `verify`
- `zero_notional_repair`
- `paper_capital`
- `live_capital`

`serve` may be `allow`, `degrade`, or `brownout`. `live_capital` may only be `allow` or `block`; delaying live capital is
just a block with a reason. `zero_notional_repair` can be allowed while `plan` or `verify` are delayed, but only when the
repair declares a bounded recovery bond.

### LaunchEscrowReceipt

Every action that creates new work must carry:

```text
launch_escrow_receipt
  receipt_id
  settlement_id
  action_class
  requester
  requested_at
  allowed_until
  max_parallelism
  max_runtime_seconds
  expected_debt_reduction
  rollback_trigger
  success_evidence_ref
```

The supporting-primitives controller consults the receipt before it creates or keeps schedule-runner resources. If the
receipt is missing, expired, or blocked for the action class, the controller withholds or removes the runner and writes a
status condition with the settlement id and reasons.

### Database Shape

The engineer stage should add a compact Jangar persistence layer:

- `control_plane_evidence_settlements`: one row per namespace/window, JSONB payload, generated/fresh timestamps, digest,
  and producer revision.
- `control_plane_launch_escrows`: one row per launch, settlement FK/digest, action class, requested resource ref,
  allowed-until, outcome, and success evidence ref.
- Retention: 7 days hot, 30 days summarized, then artifact bundle if tied to a release.

This is not a trading ledger and must not duplicate Torghut financial truth. It is Jangar's control-plane admission
record.

### Integration Points

- `control-plane-status.ts` computes and exposes the current settlement SLO in the existing status payload.
- `control-plane-empirical-services.ts` becomes a consumer of Torghut proof-feed settlement instead of a broad service
  status flattener.
- `control-plane-runtime-admission.ts` projects action-class decisions into admission passports.
- `supporting-primitives-controller.ts` enforces launch escrow for Schedule, Swarm stage launch, and Workspace/PVC repair.
- `primitives-kube.ts` remains the least-privilege Kubernetes adapter; it should not learn business rules.
- Torghut owns profit-proof escrow and repair dividend values through the companion contract.

## Implementation Scope

Phase 0, shadow:

- Add settlement and launch-escrow types, persistence, and status payloads.
- Compute decisions from existing evidence without enforcing.
- Add fixtures for current degraded evidence: Error pods, stale verify, current DB schema, stale empirical jobs, ready
  options catalog with no success timestamp, and ClickHouse low-memory fallback counters.

Phase 1, non-capital enforcement:

- Enforce launch escrow for `discover`, `plan`, `implement`, `verify`, and `zero_notional_repair`.
- Keep serving reads available unless the SLO explicitly enters brownout.
- Add controller status conditions that name `settlement_id`, `receipt_id`, and reason codes.

Phase 2, capital coupling:

- Block `paper_capital` and `live_capital` unless Torghut proof escrow is fresh and dependency quorum is allow.
- Allow only zero-notional repair while empirical jobs remain stale.
- Require deployer signoff evidence before enabling capital enforcement in production.

## Validation Gates

Engineer acceptance gates:

- Unit tests prove `rollout_health=healthy` plus recent failed pods can still delay launch classes.
- Unit tests prove healthy database migrations do not override stale empirical jobs.
- Unit tests prove options catalog `ready=true` with `last_success_ts=null` fails proof freshness.
- Unit tests prove zero-notional repair can be allowed while live capital is blocked.
- Supporting-primitives tests prove blocked or expired launch escrow removes or withholds schedule-runner resources.
- Status tests prove settlement ids and launch escrow reasons appear in control-plane status.

Deployer acceptance gates:

- `kubectl get pods -n agents` has no new unbounded Error growth during rollout.
- Jangar `/api/agents/control-plane/status?namespace=agents` exposes current settlement SLO and fresh-until timestamp.
- Jangar database migration consistency is healthy with no unexpected migrations.
- Torghut `/db-check` is current and lineage ready.
- Torghut empirical jobs are either fresh or named as repair targets with artifact refs.
- Any promotion to capital has fresh Torghut proof escrow, no `simple_submit_disabled`, and nonzero TCA sample evidence.

## Rollout

1. Ship shadow settlement payloads behind an env flag defaulting to advisory.
2. Enable status rendering and dashboards; require engineer stage to attach settlement evidence in PRs.
3. Enable launch escrow enforcement for schedules in `agents` only.
4. Add Workspace/PVC repair enforcement after schedule enforcement is stable for one release window.
5. Enable Torghut zero-notional repair escrow before any paper/live capital coupling.
6. Enable capital coupling only after deployer verifies fresh proof escrow and rollback automation.

## Rollback

- Disable enforcement through the feature flag; keep status computation on for diagnosis.
- If persistence causes DB pressure, disable writes and retain in-memory settlement projection.
- If schedule launch freezes too broadly, roll back supporting-primitives enforcement while retaining runtime admission.
- If Torghut proof escrow regresses, block capital and keep zero-notional repair under manual launch escrow.
- Revert the implementing PR if the feature flag cannot isolate the failure.

## Risks

- The settlement SLO could become another broad health bit if evidence refs are not preserved. Require short refs and
  reason codes in every decision.
- Stale settlement rows could freeze launches after the underlying issue clears. Every settlement must expire, and stale
  settlement means advisory-only, not allow.
- Launch escrow can slow urgent incident response. Keep a manual break-glass class that still records requester, reason,
  TTL, and rollback trigger.
- Torghut profitability evidence can look precise while execution samples are zero. Capital gates must require execution
  realism and TCA evidence, not just historical or simulated edge.

## Handoff To Engineer

Build the shadow settlement path first. Do not start with capital enforcement. The first PR should introduce the
database objects, status payload, deterministic decision function, and tests for the current evidence set. The second PR
should wire supporting-primitives launch escrow for schedules. The third PR should connect Torghut proof escrow and
zero-notional repair ranking.

Minimum changed files for the first engineer PR:

- `services/jangar/src/server/control-plane-status.ts`
- `services/jangar/src/server/control-plane-runtime-admission.ts`
- `services/jangar/src/server/control-plane-empirical-services.ts`
- `services/jangar/src/server/kysely-migrations.ts`
- `services/jangar/src/server/__tests__/control-plane-status.test.ts`
- A new persistence module under `services/jangar/src/server/`

## Handoff To Deployer

Do not treat pod phase, `/readyz`, or schema-current as sufficient promotion evidence. The deployment gate is the
combined settlement:

- current Jangar settlement SLO is fresh;
- `serve` is allow or degrade, not brownout;
- the target action class is allow;
- launch escrow is fresh and names rollback trigger;
- Jangar DB and Torghut DB schema checks are current;
- Torghut stale empirical jobs are either resolved or isolated to zero-notional repair;
- live capital remains blocked until proof escrow has fresh execution and TCA evidence.

If any of those are missing, hold promotion and publish the missing evidence as the blocker.
