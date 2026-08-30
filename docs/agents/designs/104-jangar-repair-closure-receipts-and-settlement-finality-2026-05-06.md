# 104. Jangar Repair Closure Receipts And Settlement Finality (2026-05-06)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-06
Owner: Victor Chen, Jangar Engineering
Scope: Jangar control-plane resilience, material-action settlement finality, repair lane closure, dependency quorum
retirement, Torghut proof repair consumption, rollout safety, merge readiness, deploy widening, and capital-adjacent
settlement.

Companion Torghut contract:

- `docs/torghut/design-system/v6/108-torghut-proof-repair-closure-receipts-and-profit-settlement-2026-05-06.md`

Extends:

- `103-jangar-material-action-settlement-board-and-profit-repair-gates-2026-05-06.md`
- `103-jangar-torghut-decision-custody-cells-and-rollout-proof-exchange-2026-05-06.md`
- `102-jangar-dual-authority-dispatch-ledger-and-capital-proof-firewall-2026-05-06.md`
- `101-jangar-typed-evidence-authority-and-readiness-debt-gates-2026-05-06.md`

## Decision

I am choosing **repair closure receipts with settlement finality** as the next Jangar architecture step.

The current control plane is healthier than the older May 5 soak. Jangar is serving. The `agents` and
`agents-controllers` deployments are available. The control-plane status projection reports healthy execution trust,
healthy watch reliability, healthy database migration consistency, fresh stage clocks for discover, plan, implement,
and verify, and no pending swarm requirements. Torghut has rolled to `torghut-00232`, schema is current, Postgres,
ClickHouse, Alpaca, and Jangar universe projections are healthy, and a recent empirical-jobs backfill job completed.

That is still not settlement. Jangar dependency quorum remains `block` because empirical jobs are still stale. Torghut
live readiness remains HTTP 503 because `simple_submit_disabled` is true. All three Torghut hypotheses remain shadow or
blocked, zero are promotion eligible, signal proof is stale under the current market-closed posture, and the last 72
hours show eight rejected decisions and zero executions. The important failure mode is now "repair activity completed,
but proof debt is not retired."

The selected architecture makes proof-gap retirement explicit. Jangar should not close `empirical_jobs_degraded`,
`quant_health_not_configured`, `simple_submit_disabled`, `zero_promotion_eligible`, or stale TCA proof because a
Kubernetes Job completed, a rollout became ready, or a repair lane started. Jangar closes a material-action block only
when the owning producer emits a typed closure receipt, the evidence after the repair is fresh and source-qualified, and
the material-action settlement board recomputes the affected action class.

The tradeoff is that completed repair jobs can remain visibly unfinished. I accept that. A completed job is execution
evidence. It is not proof that the data plane changed, the hypothesis is promotable, or capital can move.

## Read-Only Evidence Snapshot

No Kubernetes resources, database rows, broker settings, trading settings, or runtime objects were mutated during this
assessment.

### Cluster And Rollout Evidence

- `kubectl auth whoami` identified the runtime as `system:serviceaccount:agents:agents-sa`; `kubectl config
current-context` is unset, but in-cluster service-account auth works.
- `jangar` pods were running: `jangar-bcf6fc945-fhsmv`, `bumba`, `jangar-db-1`, Redis, Open WebUI, Symphony, and
  telemetry pods were available.
- Jangar deployments were available: `jangar=1/1`, `bumba=1/1`, `jangar-alloy=1/1`, `symphony=1/1`, and
  `symphony-jangar=1/1`.
- Agents deployments were available: `agents=1/1`, `agents-controllers=2/2`, and `agents-alloy=1/1`.
- The Agents namespace retained many historical scheduled pods: a status count over Jangar and Torghut scheduled runs
  showed `Completed=113`, `Error=30`, and `Running=4`. Recent events were healthy scheduled creations and completions.
- `jangar-control-plane` stage clocks were current in Jangar status at `2026-05-06T07:07:15Z`: discover last ran at
  `06:05:10Z`, plan at `06:20:10Z`, implement at `05:35:12Z`, and verify at `06:50:07Z`; all were below the two-hour
  stale window.
- Torghut rolled during this assessment. `torghut-00232-deployment` and `torghut-sim-00313-deployment` were running,
  while `torghut-00231` was terminating.
- Torghut events recorded a completed `torghut-db-migrations` job, new `torghut-00232` and `torghut-sim-00313`
  revisions, transient startup and readiness probe failures, completed whitepaper/bootstrap jobs, and a completed
  `torghut-empirical-jobs-backfill` job.

### Database And Data Evidence

- Direct CNPG cluster listing was RBAC-blocked in both `jangar` and `torghut` for this service account. This pass used
  service-owned database projections and API evidence.
- Jangar `/api/agents/control-plane/status?namespace=agents` reported `database.status=healthy`, `configured=true`,
  `connected=true`, migration table `kysely_migration`, 28 registered and applied migrations, no missing or unexpected
  migrations, and latest migration `20260505_torghut_quant_pipeline_health_window_index`.
- The same Jangar status reported `execution_trust.status=healthy`, `watch_reliability.status=healthy` with 9,833
  AgentRun watch events in the 15-minute window, and configured workflow, job, Temporal, and custom runtime adapters.
- Jangar failure-domain leases remained in `shadow` mode and allowed `dispatch_normal`, `merge_ready`, `deploy_widen`,
  and `torghut_capital` as local lease holdbacks.
- Jangar dependency quorum still returned `decision=block`, `reasons=["empirical_jobs_degraded"]`, and
  `degradation_scope=global`.
- Jangar empirical services still marked `benchmark_parity`, `foundation_router_parity`, `janus_event_car`, and
  `janus_hgrm_reward` stale, all originating from `2026-03-21T09:03:22Z`.
- Torghut `/db-check` returned schema current at Alembic head `0029_whitepaper_embedding_dimension_4096`, lineage ready,
  no orphan parents, and known parent-fork warnings at migrations `0010` and `0015`.
- Torghut `/readyz` and `/trading/health` returned HTTP 503 even though scheduler, Postgres, ClickHouse, Alpaca,
  schema, and universe checks were healthy. The live submission gate was blocked by `simple_submit_disabled`.
- Torghut `/trading/status` reported active revision `torghut-00232`, mode `live`, `capital_stage=shadow`,
  `TRADING_AUTONOMY_ENABLED=false`, `TRADING_AUTONOMY_ALLOW_LIVE_PROMOTION=false`, three hypotheses total, two shadow,
  one blocked, zero promotion eligible, and three rollback required.
- Torghut runtime profitability showed an active 72-hour window with 8 decisions, 0 executions, and 0 TCA samples.
- The latest sampled decisions were May 4 pre-submit rejects for `insufficient_buying_power`, with requested notionals
  around `157950.10` against buying power around `141543.88`.
- TCA history remains old: 13,775 historical rows, `last_computed_at=2026-04-02T20:59:45Z`,
  `expected_shortfall_sample_count=0`, and `expected_shortfall_coverage=0`.

### Source Evidence

- `services/jangar/src/server/control-plane-status.ts` is the right Jangar projection boundary. It already composes
  controller authority, runtime adapters, database status, rollout health, execution trust, workflows, empirical
  services, runtime admission, and failure-domain leases.
- `services/jangar/src/server/__tests__/control-plane-status.test.ts` already covers dependency quorum, watch
  reliability, execution trust, runtime kits, admission passports, and failure-domain lease behavior.
- `services/jangar/src/server/control-plane-failure-domain-leases.ts` can remain a necessary input, but it is not the
  final settlement reducer.
- `services/torghut/app/trading/submission_council.py` owns live submission gate payloads, dependency quorum
  consumption, empirical readiness, quant evidence, and capital stage resolution.
- `services/torghut/app/trading/scheduler/pipeline.py` owns the hot path that currently consumes live submission gates
  before decision and submission behavior.
- High-risk module size is still real: `control-plane-status.ts` is 629 lines, Torghut `main.py` is 4,051 lines,
  `pipeline.py` is 4,288 lines, and `submission_council.py` is 1,196 lines.
- Test coverage exists around Jangar control-plane status, failure-domain leases, runtime admission, quant routes,
  Torghut submission council, empirical jobs, readiness, scheduler safety, TCA, and risk. The missing regression is
  proof-gap closure: a completed repair job with unchanged stale evidence must keep the block open.

## Problem

Jangar now has enough status surfaces to route around outages. It does not yet have finality for repair.

Current evidence shows the distinction:

1. A Torghut empirical repair job completed, but Jangar dependency quorum still blocks on stale empirical jobs.
2. Torghut deployment and schema are current, but live readiness is still HTTP 503 because capital action is disabled.
3. Failure-domain leases can locally allow material actions while dependency quorum and Torghut profit proof still say
   no.
4. Historical failed scheduled pods remain useful audit evidence, but recent schedules are running and completing.
5. Operators need to know whether a proof gap is open, repair-running, receipt-pending, settled, expired, or rolled back.

Without finality, every stage after discover has to infer whether repair is done. That turns closure into a judgment call
and creates pressure to treat job completion as proof.

## Alternatives Considered

### Option A: Treat Kubernetes Job Completion As Repair Closure

Pros:

- Simple to implement.
- Uses a source Jangar already watches.
- Gives deployers a fast visual signal.

Cons:

- Current evidence disproves it: `torghut-empirical-jobs-backfill` completed, but empirical jobs remain stale.
- A job can succeed without changing the target table, projection, or route state.
- It cannot prove account/window freshness, hypothesis eligibility, or TCA settlement.

Decision: reject. Job completion is necessary execution evidence, not closure.

### Option B: Require Manual Operator Sign-Off For Every Proof Gap

Pros:

- Conservative.
- Useful for exceptional live-capital changes.
- Avoids over-trusting partial automation.

Cons:

- Does not scale to hourly repair lanes.
- Makes the audit trail weaker because the sign-off can outlive the evidence that justified it.
- Does not give Jangar a deterministic reducer for merge readiness, deploy widening, or Torghut capital.

Decision: keep manual approval for capital widening, but reject it as the main proof-gap closure mechanism.

### Option C: Require Typed Repair Closure Receipts

Pros:

- Separates execution completion from evidence retirement.
- Gives Jangar one durable closure contract for dependency quorum, material-action settlement, and Torghut capital.
- Lets repair remain open while material actions stay held.
- Supports automated tests using before/after evidence fixtures.
- Gives deployers a rollback handle when a receipt expires or is contradicted by later projection state.

Cons:

- Adds a producer/consumer contract.
- Requires Torghut to emit after-state evidence, not only route status.
- Requires shadow comparison before enforcement.

Decision: select Option C.

## Chosen Architecture

Jangar adds a `RepairClosureReceiptArbiter` as a companion to the material-action settlement board.

```text
repair_closure_receipt
  receipt_id
  proof_gap_id                 # empirical_jobs_degraded, quant_latest_metrics_empty, simple_submit_disabled
  producer                     # torghut, jangar, agents-controller, deployer
  target_ref                   # account, hypothesis, strategy, namespace, deployment, action class
  repair_job_ref               # optional Kubernetes job, workflow, or run id
  pre_repair_evidence_refs[]
  post_repair_evidence_refs[]
  retired_reason_codes[]
  remaining_reason_codes[]
  closure_decision             # accepted, rejected, partial, expired, contradicted
  source_projection_digest
  observed_at
  fresh_until
```

The arbiter computes finality:

```text
repair_finality
  proof_gap_id
  current_state                # open, repair_running, receipt_pending, partially_settled, settled, expired, rolled_back
  accepted_receipt_id
  settlement_effects[]         # material actions that may be recomputed
  blocked_actions[]
  repair_only_actions[]
  reason_codes[]
```

Initial reducer rules:

- A Kubernetes job can move a proof gap to `receipt_pending`, never directly to `settled`.
- A receipt is accepted only when the post-repair projection names the retired reason code and has a fresh-until window.
- A receipt is rejected when the source projection still contains the retired reason code.
- A partial receipt can open a narrower repair lane, but it cannot allow `merge_ready`, `deploy_widen`, or
  `torghut_capital`.
- `empirical_jobs_degraded` is settled only when the four named empirical jobs are fresh, truthful, promotion-eligible,
  and newer than the configured freshness window.
- `simple_submit_disabled` is settled only by an explicit submission-gate rehearsal receipt, not by service readiness.
- `quant_health_not_configured` and empty latest metrics are settled only by account/window quant receipts.
- TCA promotion proof is settled only when expected-shortfall calibration has non-zero sample coverage and current
  computation time.

For the current evidence snapshot, the expected finality is:

```text
empirical_jobs_degraded          receipt_pending or open
quant_health_not_configured      open
simple_submit_disabled           open
zero_promotion_eligible          open
stale_tca_settlement             open

observe                          allow
repair:empirical_jobs            repair_only
repair:quant_metrics             repair_only
normal_dispatch                  hold
merge_ready                      block
deploy_widen                     hold
torghut_capital                  block
```

## API And Status Contract

Jangar should extend `/api/agents/control-plane/status` with:

```text
repair_closure
  mode                           # shadow, enforce_repair_finality, enforce_material_finality
  generated_at
  receipts[]
  finality[]
  settlement_recomputations[]
  receipt_disagreements[]
```

The material-action settlement board consumes `repair_closure.finality`, not raw repair jobs, when deciding whether a
block has been retired.

## Engineer Handoff

Implement closure receipts as a pure reducer before enforcement.

Required slices:

- Add a Jangar reducer for repair closure receipts and finality.
- Feed it with existing job/workflow observations and Torghut reduced settlement receipts.
- Add fixture tests for this exact evidence shape: a completed empirical backfill job plus unchanged stale empirical
  projection keeps `empirical_jobs_degraded` open and `torghut_capital=block`.
- Add tests that an accepted empirical receipt recomputes `normal_dispatch`, `merge_ready`, and `torghut_capital` but
  still respects live submission and promotion eligibility.
- Add tests proving expired receipts reopen the affected proof gap.
- Keep supporting-primitives and deploy widening consumers reading the reduced material-action settlement result.

Acceptance gates:

- Job completion cannot settle a proof gap without an accepted receipt.
- Every accepted receipt names pre-repair and post-repair evidence refs.
- Material actions list the receipt ids that affected their decision.
- Torghut capital remains blocked while any capital proof gap is open, partial, expired, or contradicted.

## Deployer Handoff

Roll out in three stages:

1. `shadow`: emit closure finality beside existing material-action settlement. No behavior changes.
2. `enforce_repair_finality`: let repair lanes close only when receipts are accepted; observation stays open.
3. `enforce_material_finality`: require accepted finality before merge readiness, deploy widening, or Torghut capital
   can move from hold/block to allow.

Deployment gates:

- Jangar status remains healthy and keeps stage clocks fresh.
- Torghut emits reduced proof repair receipts for empirical, quant, submission-gate, hypothesis, and TCA repair lanes.
- No unexpected disagreement exists between job completion and closure receipts for two scheduled cycles.
- Direct DB introspection remains optional only while service-owned projections are healthy; deployer incident response
  still needs a scoped read-only database path.

Rollback:

- Return closure mode to `shadow`.
- Keep receipt emission enabled for diagnosis.
- Treat missing, expired, or contradicted receipts as open proof gaps.
- Do not roll back by widening Torghut capital; capital remains blocked until settlement finality is healthy.

## Validation Plan

- `bunx oxfmt --check docs/agents/designs/104-jangar-repair-closure-receipts-and-settlement-finality-2026-05-06.md
docs/torghut/design-system/v6/108-torghut-proof-repair-closure-receipts-and-profit-settlement-2026-05-06.md
docs/torghut/design-system/v6/index.md`
- Future engineer test: `bun test services/jangar/src/server/control-plane-repair-closure.test.ts`
- Future engineer test: `bun test services/jangar/src/server/control-plane-status.test.ts`
- Read-only smoke: `curl http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status?namespace=agents`
- Read-only smoke: `curl http://torghut.torghut.svc.cluster.local/readyz`
- Read-only smoke: `curl http://torghut.torghut.svc.cluster.local/trading/status`

## Risks

- A receipt producer can be wrong. The mitigation is source-qualified before/after evidence and contradiction handling.
- Receipt finality can slow repair closure. The mitigation is to keep repair-only lanes open while material actions stay
  held.
- The contract can become too broad. The first implementation should cover only empirical jobs, quant health, live
  submission, hypothesis promotion, and TCA settlement.
- Direct database access is unavailable to this service account. Service projections are enough for this design pass,
  but deployers need a read-only DB evidence path before incident response depends on table-level proof.
