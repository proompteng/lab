# 109. Jangar Promotion Escrow Replay Cells And Consumer Parity Gates (2026-05-06)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-06
Owner: Victor Chen, Jangar Engineering Architecture
Scope: Jangar control-plane promotion authority, rollout safety, consumer parity, empirical proof replay, Torghut
capital handoff.

Companion Torghut contract:

- `docs/torghut/design-system/v6/113-torghut-live-sim-parity-and-empirical-proof-replay-escrow-2026-05-06.md`

Extends:

- `107-jangar-reciprocal-evidence-authority-and-contradiction-escrow-2026-05-06.md`
- `106-jangar-proof-debt-retirement-exchange-and-experiment-lease-arbiter-2026-05-06.md`
- `75-jangar-failure-domain-leases-and-database-routability-holdbacks-2026-05-05.md`

## Decision

I am choosing **promotion escrow replay cells with consumer parity gates** as the next Jangar control-plane architecture
step.

The previous reciprocal-evidence work repaired the immediate false database/source-schema holdback. Jangar
`/api/agents/control-plane/status?namespace=agents` at `2026-05-06T09:24:30.960Z` now reports the database connected,
healthy, and migration-consistent at `28/28` Kysely migrations through
`20260505_torghut_quant_pipeline_health_window_index`. Watch reliability is healthy with `2` streams, `1768` events,
and no watch errors or restarts. Failure-domain leases for `database`, `route`, `rollout`, `registry`, `storage`,
`workflow_artifact`, `nats`, and `source_schema` are valid, and the derived holdbacks allow `dispatch_normal`,
`deploy_widen`, `merge_ready`, and `torghut_capital`.

That is necessary evidence, but it is not sufficient authority for the next six months of the control plane. The same
status payload still blocks dependency quorum because empirical jobs are degraded. Torghut live has an active broker
account and a healthy schema but reports `capital_stage=shadow`, `promotion_eligible_total=0`, `rollback_required_total=3`,
and `live_submission_gate.allowed=false`. The live route also returns `quant_health_not_configured`, while the simulation
route is already wired to Jangar control-plane and quant-health URLs. Jangar can prove its own local failure-domain
leases are green; it still cannot prove that the consuming Torghut route is using the same evidence contract that the
simulation route used to produce proof.

The selected design makes promotion a replayable escrow cell instead of a boolean gate. For each material action class,
Jangar will assemble a cell that binds cluster rollout evidence, service-owned database/schema projections, source
classifier versions, producer freshness, consumer configuration parity, and empirical replay receipts. The cell can
authorize observe-only or repair work while holding merge, deploy widening, paper capital, and live capital. It only
settles when the producer and consumer both cite the same evidence ids inside the same freshness window.

The tradeoff is that this adds one more control-plane projection before promotion. I accept that cost because the
remaining failure mode is no longer "Jangar cannot see health." It is "Jangar can be healthy while the downstream
consumer is configured differently, stale, or unable to replay the proof that capital depends on." A control plane that
cannot distinguish those states will eventually widen a rollout on the wrong evidence.

## Evidence Snapshot

No Kubernetes resources, database rows, broker settings, runtime flags, or trading state were mutated during this
assessment. The only Kubernetes setup was a local in-cluster kubectl context using the mounted service-account token.

### Cluster And Rollout Evidence

- Runtime identity is `system:serviceaccount:agents:agents-sa`.
- Jangar namespace pods are running. The Jangar deployment is `1/1` available on image `9fd86916` and the active pod is
  `2/2 Running`.
- Agents deployments are available: `agents=1/1`, `agents-alloy=1/1`, and `agents-controllers=2/2`.
- Agents namespace still carries accumulated failed work: `9` running pods, `32` error pods, and `131` completed pods
  at sample time. Recent jobs included failed Jangar verify attempts with `BackoffLimitExceeded`.
- Recent Agents events show readiness probe failures during controller and API image transitions. Controller logs also
  report repeated OTLP metrics export failures to the observability Mimir endpoint.
- Argo CD reports `agents`, `agents-ci`, `jangar`, `torghut`, `torghut-options`, `symphony-jangar`, and
  `symphony-torghut` as `Synced` and `Healthy`; unrelated platform apps still had `OutOfSync`, `Progressing`, or
  `Degraded` status and should not be used as proof for this lane.
- Torghut live and simulation Knative revisions are running. Recent Torghut events included ClickHouse multiple-PDB
  warnings, a Keeper PDB `NoPods` warning, and transient simulation readiness/startup probe failures before the latest
  revision became ready.

### Database And Data Evidence

- Direct CNPG cluster listing and Kubernetes secret listing are forbidden to this runtime. Database assessment therefore
  uses service-owned read-only projections.
- Jangar `/ready` reports leader status, memory provider, execution trust, runtime kits, and admission passports
  healthy.
- Jangar control-plane status reports the database configured, connected, healthy, and migration-consistent:
  `registered_count=28`, `applied_count=28`, `unapplied_count=0`, and `unexpected_count=0`.
- Jangar failure-domain leases are now valid for database, route, rollout, registry, storage, workflow artifacts, NATS,
  and source schema. The previous generated-pod classifier false positive is no longer present in the sampled status.
- Jangar dependency quorum remains `block` because `empirical_jobs_degraded` is still active.
- Torghut `/db-check` reports `ok=true`, schema current, current and expected Alembic heads at
  `0029_whitepaper_embedding_dimension_4096`, and account scope ready. It still reports known parent-fork warnings at
  `0010_execution_provenance_and_governance_trace` and `0015_whitepaper_workflow_tables`.
- Torghut `/trading/autonomy` reports stale empirical jobs for `benchmark_parity`, `foundation_router_parity`,
  `janus_event_car`, and `janus_hgrm_reward` over `intraday_tsmom_v1@prod` and dataset
  `torghut-full-day-20260318-884bec35`.
- Jangar aggregate quant-health is fresh, but account-scoped quant-health for the live account had a much older
  `latestMetricsUpdatedAt` and a large pipeline lag. Market-context health for `AAPL` was degraded by stale technical,
  regime, fundamentals, and news domains.

### Source Evidence

- `services/jangar/src/server/control-plane-failure-domain-leases.ts` owns action-class holdbacks and now has a
  narrower database pod classifier.
- `services/jangar/src/server/control-plane-status.ts` composes database, watch reliability, workflows, dependency
  quorum, failure-domain leases, and empirical services into the status surface operators actually use.
- `services/jangar/src/server/control-plane-workflows.ts` turns backoff, watch, rollout, and empirical-service
  degradation into dependency-quorum decisions. This is where empirical proof debt becomes a global promotion block.
- `services/jangar/src/server/supporting-primitives-controller.ts` is still a high-risk launch chokepoint: it owns
  schedule generation, runner ConfigMaps, CronJobs, swarms, freezes, requirements, and workspace PVC status.
- `services/jangar/src/server/primitives-kube.ts` has first-class PVC resource mapping. The broader risk is no longer
  missing PVC support; it is evidence consumers reusing generic Kubernetes observations without a stable source and
  classifier version.
- `argocd/applications/torghut/knative-service.yaml` keeps live submission disabled and does not configure the same
  Jangar quant-health/control-plane URLs that the simulation route has in
  `argocd/applications/torghut/knative-service-sim.yaml`.

## Problem

Jangar has outgrown single-surface promotion decisions. After the latest failure-domain repair, the local Jangar view can
legitimately say "all control-plane leases allow." The cross-plane view still says "do not promote capital." Both facts
are true.

The architecture gap is that a deployer or capital consumer does not get one replayable object that explains why. The
operator has to compare Kubernetes rollout state, Jangar control-plane status, Torghut readiness, Torghut live/sim
configuration, empirical job freshness, account-scoped quant-health, and source classifier history. That manual
comparison is fragile during image transitions and market hours.

The most expensive future incident is not a failed repair job. It is a live or paper promotion that was authorized from
fresh route and database evidence while the consumer was missing the typed Jangar input, empirical proof was stale, or
the simulation route had a different control-plane contract from live.

## Alternatives Considered

### Option A: Treat Green Failure-Domain Leases As Promotion Authority

Pros:

- Uses the control-plane status fields that already exist.
- Keeps the deployer path short.
- Avoids new projection state.

Cons:

- Ignores live/sim consumer drift.
- Lets healthy database and rollout evidence outrank stale empirical proof.
- Gives Torghut no replay receipt it can cite in submission council decisions.

Decision: reject. Failure-domain leases remain required inputs, not final authority for capital or widening.

### Option B: Block Every Material Action Until Empirical Jobs Are Fresh

Pros:

- Very safe for live capital.
- Simple to explain.
- Avoids accidental paper/live promotion while March evidence is still active.

Cons:

- Blocks observe-only and repair-only work that is required to generate fresh proof.
- Encourages one-off manual bypasses when market data is fresh but empirical proof is stale.
- Does not solve the live/sim parity problem.

Decision: reject as the operating model. Keep it as the emergency fail-closed posture.

### Option C: Promotion Escrow Replay Cells With Consumer Parity Gates

Pros:

- Separates observe, repair, paper, live micro-canary, live scale, deploy widening, and merge readiness.
- Makes live/sim configuration parity explicit before Torghut can consume Jangar evidence for capital.
- Gives engineer and deployer stages one replayable artifact with evidence refs, freshness windows, and rollback target.
- Lets repair work proceed while capital and rollout widening remain held.

Cons:

- Adds projection schema and status API work.
- Requires Torghut to acknowledge the cell id and evidence refs it consumed.
- Requires a shadow period to calibrate noisy parity and freshness failures.

Decision: select Option C.

## Architecture

Jangar introduces a `promotion_replay_cell` projection beside failure-domain leases and settled verdicts:

```text
promotion_replay_cell
  cell_id
  action_class                   # merge_ready, deploy_widen, torghut_observe, proof_repair,
                                 # paper_canary, live_micro_canary, live_scale
  producer_scope                 # namespace, service, account, hypothesis, evidence window
  requested_by
  opened_at
  fresh_until
  failure_domain_lease_refs
  database_schema_ref
  rollout_ref
  source_classifier_ref
  empirical_replay_refs
  market_context_refs
  consumer_parity_ref
  consumer_ack_ref
  decision                       # allow_observe, allow_repair, hold, allow_paper, allow_live
  held_reasons
  rollback_target
```

`consumer_parity_ref` is mandatory for Torghut action classes. It compares live and simulation configuration for typed
Jangar control-plane status, quant-health, account scope, empirical-job requirements, and submission gates. A mismatch
does not stop observation. It holds paper and live capital and prevents Jangar from advertising `torghut_capital=allow`
as a final verdict.

`empirical_replay_refs` are mandatory for `paper_canary`, `live_micro_canary`, and `live_scale`. They point at fresh
proof-repair runs for benchmark parity, foundation router parity, Janus event CAR, Janus HGRM reward, and current TCA
coverage. Stale or missing refs allow `proof_repair` but hold capital.

`rollback_target` must be concrete: previous image digest for rollout actions, disabled shadow runner for observe-only
experiments, paper-only route for capital canaries, or `simple_submit_disabled=true` for live submission.

## Implementation Scope

Engineer stage should implement the projection in small slices:

- Add a Jangar status field for `promotion_replay_cells` with action class, decision, held reasons, evidence refs, and
  rollback target.
- Add a Torghut consumer-parity reader that compares live and simulation route configuration through GitOps manifests
  and service projections, not ad-hoc environment guesses.
- Extend dependency quorum so empirical proof debt blocks capital and deploy widening but still allows observe-only and
  repair-only cells.
- Add source classifier version ids to failure-domain lease refs so a replay cell can prove which reducer accepted the
  evidence.
- Add a compact audit view for deployers: one cell id, one decision, one freshness deadline, and one rollback target.

This architecture does not require direct database shell access from Jangar. Service-owned projections remain the
read-only evidence contract for database and data quality.

## Validation Gates

- Unit test: green failure-domain leases plus missing Torghut consumer parity produces `hold` for paper/live capital.
- Unit test: stale empirical replay refs allow `proof_repair` but hold `paper_canary`, `live_micro_canary`, and
  `live_scale`.
- Unit test: live/sim Jangar quant-health configuration drift is surfaced as a parity hold reason.
- Integration test: Jangar control-plane status and Torghut submission council cite the same replay cell id before any
  paper or live promotion.
- Rollout test: readiness probe failures during an image transition hold `deploy_widen` until the rollout ref and watch
  ref are fresh.
- Data gate: account-scoped quant-health freshness and empirical replay freshness must be inside the cell window before
  capital decisions settle.

## Rollout And Rollback

Phase 0: emit replay cells in shadow with no behavior change. Operators compare cell decisions with existing
failure-domain holdbacks and Torghut live-submission decisions.

Phase 1: make replay cells authoritative for Torghut observe-only and proof-repair work. Rollback is to ignore the cell
consumer path and keep live submission disabled.

Phase 2: make replay cells authoritative for paper canaries and deploy widening. Rollback is to force the cell decision
to `hold` and use the existing failure-domain lease view as a conservative read-only diagnostic.

Phase 3: make replay cells mandatory for live micro-canary and live scale. Rollback is to set the live route back to
`simple_submit_disabled=true`, revoke capital action cells, and continue repair work under observe-only authority.

## Risks

- Parity checks can be noisy if live and simulation intentionally diverge. The cell must distinguish intentional
  account/mode differences from missing control-plane evidence inputs.
- Replay cells can become stale during long market sessions. Every action must re-check `fresh_until` before promotion.
- Empirical replay can create false confidence if it refreshes the same stale dataset. The cell must cite dataset id,
  run time, and holdout window.
- More projection state can slow operators down if the UI only dumps raw refs. The deployer view must summarize the
  decision and rollback target first.

## Handoff

Engineer acceptance gate: implement replay-cell status in Jangar, add consumer-parity and empirical-replay inputs, and
cover missing parity, stale empirical proof, rollout probe churn, and account-scoped quant-health lag with unit or
integration tests.

Deployer acceptance gate: do not widen Jangar/Agents/Torghut rollout or promote Torghut past shadow unless the replay
cell for the requested action is fresh, cites valid failure-domain leases, cites matching Torghut consumer parity, and
names a rollback target that can be executed without database mutation.
