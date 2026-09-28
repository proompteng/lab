# 97. Jangar Discover Cutover Handoff And Proof Debt Gates (2026-05-06)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-06
Owner: Victor Chen, Jangar Engineering
Scope: Jangar control-plane discover cutover, action-class gates, proof debt retirement, Torghut repair admission,
rollout widening, and ready-to-implement validation.

Companion Torghut contract:

- `docs/torghut/design-system/v6/101-torghut-proof-debt-retirement-and-shadow-capital-handoff-2026-05-06.md`

Extends:

- `96-jangar-observed-action-authority-and-negative-evidence-reclocking-2026-05-06.md`
- `96-jangar-session-proof-train-and-capital-authority-separation-2026-05-06.md`
- `95-jangar-evidence-settlement-slo-and-launch-escrow-runway-2026-05-05.md`
- `76-jangar-rollout-settlement-fuses-and-proof-reclocking-2026-05-05.md`

## Decision

I am choosing a **discover cutover receipt with proof debt gates** as the next architecture handoff for Jangar.

The earlier May 5 and May 6 designs selected the right control-plane direction: evidence clocks, observed-action
authority, rollout settlement, and session proof trains. The live system has now moved past the first failure reported
in the shared soak. The scheduled CronJob wrappers are parsing and completing, Jangar is serving, both agents
controller replicas are ready, execution trust is healthy, and rollout health is green. The remaining risk is not
whether the control plane can serve. The risk is whether Jangar will treat a healthy serving surface as permission to
widen rollout, normal dispatch, merge readiness, or downstream capital while proof debt is still open.

The cutover receipt is not a new abstract control plane. It is the implementation handoff that binds the existing
authority and proof-train contracts to the current evidence window. It says which action classes are allowed now, which
must stay bounded, which proof debt must close first, what tests prove the engineer stage is complete, and what rollback
the deployer can execute without deleting evidence.

The tradeoff is that normal dispatch and rollout widening may wait even when `/ready` and Deployment status are green.
I accept that. The current evidence says Jangar can keep serving and repairing, but Torghut empirical proof and market
context are still not capital-authoritative.

## Evidence Snapshot

All assessment was read-only. No Kubernetes resources or database records were changed.

### Runtime Inputs

- Repository: `proompteng/lab`
- Base: `main`
- Head branch: `codex/swarm-jangar-control-plane-discover`
- Local and base commit before this artifact: `24e97c9eb26aa1bac0ed0722ab37b74e42f9c512`
- Runtime identity: `system:serviceaccount:agents:agents-sa`
- `kubectl config current-context` was unset, but authenticated read-only calls succeeded through the in-cluster service
  account.

### Cluster, Rollout, And Event Evidence

- Jangar namespace pods were running, including `jangar-c55cddb4c-t7h62` at `2/2 Running`, `jangar-db-1`, Bumba,
  Symphony, Redis, Alloy, and Open WebUI.
- Agents namespace API and controller pods were ready: `agents-7fb85466b-kwntz` at `1/1 Running` and both
  `agents-controllers-75b8f88866-*` pods at `1/1 Running`.
- Scheduled discover, plan, implement, and verify CronJob wrapper jobs were completing in the latest window. The
  previous Bun inline import parse failure was not reproduced by the current CronJob generation.
- The namespace still has execution debt. Recent verify-stage jobs include multiple `Failed` pods and several retries,
  while discover and implement work continues to run. This is a launch-budget problem, not a serving outage.
- Recent agents events included readiness probe timeouts on `agents` and `agents-controllers` pods even after rollout
  recovery. Those events should reduce dispatch and widening budget until the settlement window clears.
- Torghut namespace workloads were broadly up. The live revision `torghut-00225-deployment-6c9bbff5f6-bj9xx` and sim
  revision `torghut-sim-00306-deployment-75fb7bf4d9-c2k7m` were both `2/2 Running`.
- Recent Torghut events still show repeated `MultiplePodDisruptionBudgets` warnings for ClickHouse pods and `NoPods` for
  the keeper PDB. That does not block Jangar serving, but it is negative evidence for capital and rollout widening.

### Route And Control-Plane Evidence

- `GET /ready` on Jangar returned `status="ok"` and leader election healthy for
  `jangar-c55cddb4c-t7h62_5af26c74-ac6e-4d3d-89c2-4a99233477c2`.
- `GET /api/agents/control-plane/status?namespace=agents` at `2026-05-06T01:08:08Z` reported database
  `connected=true`, migration consistency healthy, 28 registered migrations, 28 applied migrations, and latest migration
  `20260505_torghut_quant_pipeline_health_window_index`.
- The same status payload reported `dependency_quorum.decision="block"` for `empirical_jobs_degraded`.
- Execution trust was healthy, rollout health observed two healthy Deployments, and watch reliability observed 9,253
  events with zero errors and zero restarts in the current 15 minute window.
- Empirical service evidence remains degraded: the forecast registry is empty and the empirical jobs segment names stale
  `benchmark_parity`, `foundation_router_parity`, `janus_event_car`, and `janus_hgrm_reward` jobs.

### Database, Schema, Freshness, And Consistency

- Jangar database health is not the blocker. The typed status route reports connection, latency, migration parity, and no
  missing or unexpected migrations.
- Torghut `/db-check` returned `ok=true`, `schema_current=true`, current and expected Alembic head
  `0029_whitepaper_embedding_dimension_4096`, one current head, one expected head, no missing heads, no unexpected
  heads, no duplicate revisions, no orphan parent references, and lineage-ready state.
- Torghut schema still reports known parent-fork warnings around
  `0010_execution_provenance_and_governance_trace` and `0015_whitepaper_workflow_tables`; these should remain visible in
  proof receipts but do not by themselves block repair work.
- Torghut `/trading/health` returned HTTP 503 with precise degraded reasons: Postgres, ClickHouse, Alpaca, scheduler,
  and schema were OK; universe evaluation had zero symbols; empirical jobs were degraded; live submission was blocked by
  `simple_submit_disabled`; capital stage was `shadow`.
- Alpha readiness reported three hypotheses, zero promotion-eligible hypotheses, and three rollback-required hypotheses.
- Jangar market-context health for `NVDA` was degraded. Technicals and regime were stale by 15,456 seconds, fundamentals
  by 4,706,690 seconds, and news by 4,361,461 seconds, even though fundamentals and news providers had fresh successful
  attempts. Provider liveness is therefore not a data-freshness receipt.

### Source And Test Evidence

- `services/jangar/src/server/control-plane-status.ts` is the correct first aggregation point. It already joins database
  status, rollout health, workflows, watch reliability, execution trust, runtime admission, leases, and empirical
  services.
- `services/jangar/src/server/control-plane-workflows.ts` currently maps empirical job degradation into dependency
  quorum. That is right for capital but too broad unless action classes are separated.
- `services/jangar/src/server/supporting-primitives-controller.ts` remains the actuation choke point for schedules,
  swarms, runtime admission, resource watches, and workspace lifecycle.
- `services/jangar/src/server/control-plane-rollout-health.ts`,
  `services/jangar/src/server/control-plane-db-status.ts`, and
  `services/jangar/src/server/control-plane-watch-reliability.ts` already produce the raw clocks needed for the receipt.
- Jangar has 123 server test files. The missing regression is cutover behavior: a healthy `/ready`, healthy Deployment
  rollout, and healthy execution trust must not authorize `deploy_widen`, `merge_ready`, or Torghut capital while
  empirical proof and market-context debt remain open.

## Problem

Jangar has recovered enough that a global outage posture would now be the wrong answer. It also has not recovered enough
to widen every action class.

The current failure modes are:

1. **Green serving can be over-read.** `/ready`, controller readiness, and Deployment rollout are green, but dependency
   quorum still blocks on stale empirical proof.
2. **Cron launch recovered, verify confidence did not.** The Cron wrapper parse issue appears fixed in the live window,
   but verify jobs still carry recent failure debt.
3. **Database parity can hide freshness debt.** Jangar and Torghut schema heads are current while empirical jobs,
   market-context domains, and universe proof are stale or empty.
4. **Capital and repair need different answers.** Torghut repair should run to close stale proof; paper and live capital
   should remain blocked.
5. **Least-privilege evidence must be enough.** The runtime service account cannot depend on privileged database shells
   or Argo reads, so the cutover has to cite typed routes, Kubernetes objects, events, and artifact digests.

## Alternatives Considered

### Option A: Declare The Existing May 5/May 6 Docs Complete And Open No New Artifact

Pros:

- Avoids more design corpus churn.
- The main architecture direction is already present in merged docs.
- Lets engineers start from existing evidence-clock and proof-train contracts immediately.

Cons:

- Does not capture the current state change from parse-failure/heartbeat degradation to recovered serving plus proof
  debt.
- Leaves engineer and deployer stages to infer which action classes are open today.
- Does not provide a concise merged handoff for the required discover run.

Decision: reject. The prior docs are the architecture base; this artifact is the cutover handoff.

### Option B: Freeze All Non-Serving Work While Dependency Quorum Blocks

Pros:

- Strong safety posture.
- Easy operational rule.
- Prevents accidental capital reentry.

Cons:

- Blocks the repair jobs needed to close the empirical proof debt.
- Treats stale Torghut proof as if Jangar control runtime were unhealthy.
- Encourages manual bypasses when proof refresh work needs to run.

Decision: reject as steady state. Keep it as an emergency override only.

### Option C: Cutover Receipt With Action-Class Proof Debt Gates

Jangar emits a discover-cutover receipt that consumes the existing observed-action authority and proof-train inputs,
then maps the current evidence into action-class decisions and explicit debt closure gates.

Pros:

- Preserves serving and bounded repair.
- Blocks normal dispatch, widening, merge readiness, and capital while proof debt is open.
- Gives engineer and deployer stages one testable acceptance contract.
- Uses least-privilege evidence and route digests rather than privileged ad hoc checks.

Cons:

- Requires a shadow period before enforcement.
- Adds another receipt to status payloads and tests.
- Requires careful expiry rules so recovered evidence does not remain held forever.

Decision: select Option C.

## Chosen Architecture

### DiscoverCutoverReceipt

The receipt is materialized by Jangar and exposed through the control-plane status route in shadow mode first:

```text
discover_cutover_receipt
  receipt_id
  namespace
  swarm
  generated_at
  fresh_until
  producer_revision
  evidence_window_seconds
  action_class_decisions
  proof_debts
  positive_evidence_refs
  negative_evidence_refs
  route_digest_refs
  rollout_event_refs
  validation_gates
  rollback_trigger
```

Initial action classes:

- `serve_readonly`: allow while `/ready`, leader election, and controller heartbeats are healthy.
- `dispatch_repair`: allow with launch escrow, bounded parallelism, and a named proof debt target.
- `dispatch_normal`: hold while verify failures or dependency quorum blocks remain in the current window.
- `deploy_widen`: hold while recent readiness probe failures, verify failures, or unresolved rollout events are present.
- `merge_ready`: hold until the cutover receipt, local checks, and required CI are green.
- `torghut_observe`: allow from route liveness and schema health.
- `torghut_repair`: allow for empirical job and market-context proof refresh.
- `torghut_paper_capital`: block until empirical jobs are fresh, market context is lane-fresh, and scoped quant proof is
  configured.
- `torghut_live_capital`: block until paper evidence passes and the companion capital gates explicitly allow it.

### Proof Debts

The current receipt must include these debts:

- `empirical_jobs_stale`: four stale Torghut empirical jobs.
- `market_context_stale`: stale technicals, fundamentals, news, and regime domains.
- `universe_empty`: Torghut health reports zero Jangar-sourced universe symbols.
- `verify_recent_failures`: recent verify-stage failed jobs and retries.
- `rollout_probe_tail`: readiness probe timeouts after the latest agents rollout.
- `clickhouse_pdb_conflict`: repeated ClickHouse multiple-PDB warnings.

Each debt carries owner, action classes blocked, smallest closing proof, and expiry.

## Implementation Scope

Engineer stage:

1. Add a pure cutover receipt builder over the existing Jangar control-plane status components.
2. Emit the receipt in `/api/agents/control-plane/status?namespace=agents` behind shadow enforcement.
3. Feed the receipt into supporting primitive admission for schedules after shadow parity is proven.
4. Add route digests for Torghut empirical jobs, market-context health, trading health, and scoped quant health.
5. Add tests proving current evidence allows serve/observe/repair but holds dispatch normal, widening, merge readiness,
   paper capital, and live capital.

Deployer stage:

1. Verify `/ready` remains green when serving evidence is healthy.
2. Verify the receipt names all active proof debts and blocks the expected action classes.
3. Verify repair jobs can launch only with proof debt targets and bounded parallelism.
4. Verify dispatch normal and rollout widening reopen only after the receipt freshens and the negative event window
   clears.
5. Verify Torghut capital remains shadow until the companion proof-debt retirement gates pass.

## Validation Gates

- Unit tests cover all action-class decisions listed above.
- Regression tests reproduce this evidence window: Jangar serving healthy, database healthy, execution trust healthy,
  dependency quorum blocked by empirical jobs, and Torghut capital blocked.
- Status snapshot tests prove receipt fields are compact and do not dump raw event logs.
- Route tests prove Torghut 503 health payloads can still produce `torghut_observe=allow` and `torghut_repair=allow`.
- Integration smoke verifies the Cron wrapper job completes, then verifies recent verify failures still hold
  `merge_ready`.
- Documentation checks pass with `oxfmt`.

## Rollout And Rollback

Roll out in four steps:

1. Shadow emit the receipt with no enforcement.
2. Enforce `merge_ready` and deployer reporting from the receipt.
3. Enforce schedule admission for `dispatch_normal`, while leaving `dispatch_repair` open under launch escrow.
4. Enforce Torghut paper/live capital consumption only after the companion Torghut gates pass.

Rollback is configuration-only:

- Disable cutover receipt enforcement while keeping receipt emission.
- Return schedule admission to the prior dependency quorum behavior.
- Keep repair artifacts and negative evidence rows; do not delete them during rollback.
- If the receipt builder itself fails, treat all non-serving action classes as `hold` and keep `/ready` scoped to
  serving health.

## Risks

- The receipt can become another ambiguous summary if every debt does not name the exact blocked action classes.
- Event-tail windows can over-hold rollout widening if expiry is not explicit.
- Repair lanes can become a backdoor for normal work unless launch escrow requires target debt and maximum runtime.
- Torghut capital consumers may over-read `torghut_observe=allow`; docs and route contracts must keep observe, repair,
  paper, and live separate.

## Handoff

Engineer acceptance gate: with the current 2026-05-06T01:08Z evidence shape, the cutover receipt allows
`serve_readonly`, `torghut_observe`, and bounded `torghut_repair`; it holds `dispatch_normal`, `deploy_widen`,
`merge_ready`, `torghut_paper_capital`, and `torghut_live_capital`.

Deployer acceptance gate: before widening rollout or marking merge-ready, read the receipt from Jangar status, confirm
no active `verify_recent_failures` or `rollout_probe_tail` debt, confirm database migration parity is still healthy, and
confirm Torghut companion gates keep paper/live capital closed unless all proof debts are explicitly fresh.
