# 132. Jangar Stage Freshness Escrow And Capital Authority Reclocking (2026-05-07)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-07
Owner: Gideon Park, Torghut Traders Architecture
Scope: Jangar control-plane resilience, execution-trust stage freshness, material-action authority, Torghut capital
escrow, rollout safety, repair dispatch, rollback, and read-only validation.

Companion Torghut contract:

- `docs/torghut/design-system/v6/136-torghut-stage-coherent-profit-escrow-and-proof-age-arbitrage-2026-05-07.md`

Extends:

- `131-jangar-capital-qualification-receipts-and-rollout-repair-arbiter-2026-05-06.md`
- `130-jangar-synthetic-readiness-settlement-and-evidence-probe-fuses-2026-05-06.md`
- `129-jangar-consumer-evidence-leases-and-readiness-decoupling-2026-05-06.md`
- `124-jangar-disruption-budget-arbiter-and-data-freshness-settlement-2026-05-06.md`

## Decision

I am selecting **stage freshness escrow with capital authority reclocking** as the next Jangar control-plane contract
for Torghut quant.

The old failure mode from the May 5 soak has changed. Jangar is serving, agents and agents-controller deployments are
healthy, workflow and job runtimes are configured, the temporal runtime is configured, and the collaboration runtime
kit now proves that `codex-nats-publish`, `codex-nats-soak`, and `nats` are present. The controller is not simply
down.

The new failure mode is stale execution trust. At `2026-05-07T04:55Z`, Jangar control-plane status returned
`dependency_quorum.decision=delay` with reason `execution_trust_degraded`. The degraded execution-trust windows were
specific: Jangar control-plane discover, plan, implement, and verify stages were stale. In the same status payload,
controller heartbeats were healthy, runtime kits were healthy, rollout health was healthy, and recent failed jobs in
the 15-minute workflow window were `0`.

That mix is exactly why Jangar needs a stage freshness escrow. A healthy controller and healthy runtime kit must not
let stale stage evidence carry material-action authority. Jangar should continue to serve, observe, publish NATS
updates, and dispatch zero-notional repair. It should withhold `merge_ready`, `deploy_widen`, `paper_canary`,
`live_micro_canary`, and `live_scale` until every required stage has been reclocked under the current evidence epoch.

The Torghut data plane proves the capital risk. Torghut live/sim are rolled to `00250`, but `/readyz` is HTTP `503`
degraded. Live submission is disabled, capital is shadow, proof floor is `repair_only`, and quant ingestion is stale
by about `40265` seconds. Postgres has three paper/shadow metric windows from May 6 that recorded
`dependency_quorum_decision=allow`, while Jangar's current dependency quorum is `delay`. ClickHouse TA tables are
populated but stale since `2026-05-06T20:59:37Z`, and all options feature tables sampled are empty.

The selected design makes Jangar issue a `stage_freshness_escrow_receipt` for each material action. The receipt does
not replace dependency quorum; it gives dependency quorum a clock. Any prior `allow` is reclocked to `hold` when
required stages are stale. This reduces a concrete failure mode: stale stage receipts can no longer authorize a
Torghut capital path just because the controller has recovered.

The tradeoff is more explicit holds during partial recovery. I accept that. Jangar's job is not to make the UI look
green; it is to keep material actions tied to current evidence.

## Runtime Objective And Success Metrics

This contract increases control-plane resilience by separating serving health from material-action authority and by
making stage staleness a typed, recoverable hold instead of an implicit degradation.

Success means:

- Jangar emits a `stage_freshness_escrow_receipt` for every material action class.
- Healthy controller/runtime status remains necessary but never sufficient for capital or rollout widening.
- `observe` and zero-notional `repair_dispatch` stay allowed when serving, controller, and runtime-kit evidence are
  healthy.
- `merge_ready`, `deploy_widen`, `paper_canary`, `live_micro_canary`, and `live_scale` require current stage freshness
  for all configured required stages.
- A stale stage turns prior `allow` evidence into `hold` until that stage is reclocked.
- Receipts include the source stage, last observed completion time, freshness threshold, current decision, repair
  action, rollback target, and consumer references.
- Torghut can attach the current Jangar stage epoch to every profit proof, paper window, and capital request.

## Evidence Snapshot

All evidence was collected read-only. I did not mutate Kubernetes resources, database records, broker state, trading
flags, GitOps manifests, ClickHouse rows, or empirical artifacts.

### Cluster And Rollout Evidence

- The workspace was on `codex/swarm-torghut-quant-discover` at current `origin/main`
  `6c84303fe chore(jangar): promote image 39c27b12 (#5775)` before this artifact.
- I bootstrapped `kubectl` to an in-cluster context using the mounted service account token and verified identity as
  `system:serviceaccount:agents:agents-sa`.
- Jangar pod `jangar-56bdb9885b-dss9q` was `2/2 Running`; Jangar DB, Open WebUI, Redis, Bumba, Alloy, and Symphony
  pods were running.
- Agents deployment `agents-664f557846-twfrz` and both `agents-controllers-8459c79974` replicas were running.
- Jangar status reported rollout health healthy for `agents` and `agents-controllers`, with `2` configured
  deployments healthy and `0` degraded deployments.
- Recent agents events showed older cron-created swarm lane jobs failed in batches, but current manual jobs completed
  and current scheduled jobs were running. The Jangar status workflow window reported `recent_failed_jobs=0`.
- Torghut live `torghut-00250` and sim `torghut-sim-00350` were current ready revisions. Rollout events showed DB
  migrations completed and prior revisions scaled down.
- Torghut ClickHouse pods continued to emit `MultiplePodDisruptionBudgets` warnings. The service account cannot list
  PDBs, so Jangar must preserve those warnings as event-derived uncertainty rather than requiring PDB read authority.
- The service account cannot create `pods/exec`, list statefulsets, list PDBs, or list CNPG clusters in `torghut`.
  Least-privilege validation must use projected routes, events, and read-only application/database credentials.

### Jangar Route Evidence

- Jangar `/health` returned HTTP `200`.
- `/api/agents/control-plane/status?namespace=agents` at `2026-05-07T04:55:41Z` returned:
  - dependency quorum `delay`
  - dependency reason `execution_trust_degraded`
  - controller heartbeats healthy for agents, supporting, and orchestration controllers
  - workflow runtime configured
  - job runtime configured
  - temporal runtime configured
  - runtime kit `serving` healthy
  - runtime kit `collaboration` healthy with `codex-nats-publish`, `codex-nats-soak`, `nats`, `/app/services/jangar`,
    and `NATS_URL` present
  - rollout health healthy
  - negative evidence router mode `observe`
- Execution trust was `degraded` because:
  - `jangar-control-plane:discover` stage is stale
  - `jangar-control-plane:plan` stage is stale
  - `jangar-control-plane:implement` stage is stale
  - `jangar-control-plane:verify` stage is stale
- The positive evidence refs included controller witness, database projection, failure-domain leases, runtime kits,
  rollout healthy, and watch reliability healthy.
- The only negative runtime evidence in the status sample was the execution-trust stale-stage set.

### Torghut Consumer Evidence

- Torghut `/healthz` returned HTTP `200`; `/readyz` returned HTTP `503` with status `degraded`.
- Torghut readiness showed scheduler, Postgres, ClickHouse, Alpaca, database, universe, and empirical jobs healthy.
- Torghut readiness showed live submission gate not OK, profitability proof floor not OK, and quant evidence degraded.
- `/trading/status` reported `mode=live`, live submission closed by `simple_submit_disabled`, capital stage `shadow`,
  proof floor `repair_only`, capital state `zero_notional`, and `max_notional=0`.
- Torghut quant evidence source is Jangar quant health for `PA3SX7FYNUTF`, window `15m`; it returned
  `latestMetricsCount=144`, compute lag `1` second, ingestion lag about `40265` seconds, materialization lag about
  `17` seconds, and status `degraded`.
- Torghut empirical jobs were healthy and fresh for four jobs tied to
  `chip-paper-microbar-composite@execution-proof`.
- Torghut TCA was stale from `2026-04-02T20:59:45Z` with average absolute slippage about `568.6` bps.
- Read-only Postgres showed the latest strategy metric windows stored `dependency_quorum_decision=allow`, but those
  windows ended on `2026-05-06T18:01Z`, before the current Jangar `delay` sample.

### Source Evidence

- `services/jangar/src/server/control-plane-status.ts` is `781` lines and already composes dependency quorum, stages,
  runtime adapters, runtime kits, rollout health, execution trust, negative evidence, and material action surfaces.
- `services/jangar/src/server/control-plane-workflows.ts` already adds `execution_trust_degraded` as a dependency
  quorum delay reason.
- `services/jangar/src/server/control-plane-runtime-admission.ts` already marks runtime admission reason codes with
  `execution_trust_degraded`.
- `services/jangar/src/server/control-plane-material-action-verdict.ts` already has a dependency quorum source for
  material-action holds.
- `services/jangar/src/server/control-plane-negative-evidence-router.ts` already publishes negative evidence refs for
  execution trust and consumer refs for Torghut, deployer, engineer, Jangar, and agents.
- Jangar tests already cover dependency quorum, execution-trust-degraded runtime admission, material-action verdicts,
  quant health, and negative evidence. The missing architecture is not a status route; it is a stable receipt that
  consumers can attach to capital and rollout decisions.

## Problem

Jangar can currently tell us that execution trust is stale, but the stale-stage evidence is not yet a first-class
clock for downstream capital authority.

The current failure modes are:

1. A controller can be healthy while stage evidence is stale.
2. Runtime kits can be healthy while discover/plan/implement/verify outputs are stale.
3. Torghut can persist metric windows with `dependency_quorum_decision=allow`, then later consume those windows after
   Jangar has moved to `delay`.
4. A material-action verdict can cite dependency quorum, but downstream systems still need a receipt id and epoch to
   compare against persisted proof.
5. Least-privilege RBAC prevents privileged inspection, so the stage clock must be carried in route evidence.
6. Rollout widening and capital admission share failure modes but require different hold/repair actions.

## Alternatives Considered

### Option A: Keep Dependency Quorum As The Only Consumer Contract

This option tells Torghut and deployers to consume the current `dependency_quorum.decision` and reasons directly.

Pros:

- Minimal implementation.
- Uses an existing route and existing tests.
- Keeps the mental model simple.

Cons:

- Gives consumers no stable epoch to compare against persisted metric windows.
- Does not distinguish current `delay` from stale historical `allow` in downstream records.
- Does not provide per-stage expiry or repair actions.
- Makes audit evidence depend on a large status payload rather than a compact receipt.

Decision: reject.

### Option B: Block All Material Actions Whenever Execution Trust Is Degraded

This option makes execution-trust degradation a hard global block for every action, including repair.

Pros:

- Strong safety posture.
- Easy to implement in material-action verdicts.
- Prevents stale-stage capital promotion.

Cons:

- Blocks zero-notional repair even when repair is exactly how stages get fresh again.
- Makes Jangar less useful during partial recovery.
- Conflates capital actions, rollout actions, read-only observe actions, and repair actions.
- Gives engineers no prioritized path to restore authority.

Decision: reject.

### Option C: Stage Freshness Escrow With Capital Authority Reclocking

This option issues action-scoped stage receipts. Stale required stages hold material authority, while observe and
zero-notional repair can continue under a healthy serving/runtime base.

Pros:

- Converts stale execution trust into compact, auditable receipts.
- Lets consumers compare persisted proof windows to the current stage epoch.
- Keeps Jangar useful during degraded periods.
- Separates `serve`, `observe`, `repair_dispatch`, `merge_ready`, `deploy_widen`, and capital action classes.
- Reduces rollout and capital false positives caused by stale stage evidence.

Cons:

- Adds a receipt reducer and policy table.
- Requires consumers to store or echo a new epoch id.
- Requires careful threshold tuning to avoid over-holding deploys.

Decision: select Option C.

## Architecture

Jangar emits one stage freshness escrow receipt per material action class.

```text
stage_freshness_escrow_receipt
  receipt_id
  generated_at
  consumer
  requested_action_class
  serving_status
  controller_status
  runtime_kit_status
  dependency_quorum_decision
  required_stages
  stage_observations
  current_stage_epoch_id
  prior_authority_decision
  reclocked_authority_decision
  allowed_zero_notional_actions
  blocked_material_actions
  repair_actions
  rollback_target
  evidence_refs
  fresh_until
```

Required stage observation:

```text
stage_observation
  lane
  stage              # discover, plan, implement, verify
  last_succeeded_at
  last_started_at
  last_failed_at
  freshness_threshold_seconds
  age_seconds
  decision           # fresh, stale, missing, failed, unknown
  source_ref
  repair_action
```

Action policy:

- `serve_readonly`: allowed when Jangar route, DB projection, runtime kit, and controller heartbeat are healthy.
- `observe`: allowed when `serve_readonly` is allowed.
- `repair_dispatch`: allowed when requested max notional is `0` and serving/runtime/controller evidence is healthy.
- `merge_ready`: held when any required stage is stale.
- `deploy_widen`: held when any required stage is stale or rollout/PDB event uncertainty is unresolved.
- `paper_canary`: held when any required stage is stale or Torghut proof floor is `repair_only`.
- `live_micro_canary`: held when any required stage is stale, Torghut proof floor is not capital-qualified, or TCA is
  stale.
- `live_scale`: held unless live micro receipts, stage freshness, rollout health, data freshness, and rollback target
  are all current.

Authority reclocking:

- If a consumer presents prior authority without a current stage epoch, Jangar returns `hold_missing_epoch`.
- If a consumer presents an older epoch and any required stage is now stale, Jangar returns `hold_epoch_expired`.
- If prior authority was `allow` but current dependency quorum is `delay`, Jangar returns `hold_reclocked_delay`.
- If requested action is repair with `max_notional=0`, Jangar returns `allow_repair_dispatch` plus required repair
  actions.

## Failure-Mode Reduction

This contract explicitly removes these failure modes:

- **Recovered controller, stale evidence:** controller health cannot authorize material actions without fresh stages.
- **Historical allow leak:** stored Torghut windows with old `allow` cannot authorize capital after the stage epoch
  expires.
- **Runtime-kit false green:** healthy `nats` and healthy runtime kits do not override stale execution trust.
- **Privileged-inspection dependency:** consumers can validate receipts from route evidence and events without pod exec
  or CNPG listing.
- **Repair deadlock:** zero-notional repair remains allowed while capital and rollout widening are held.

## Engineer Handoff

Implement this as a Jangar reducer plus route field, not as a broad controller rewrite.

Required code scope:

- Add a pure `stage-freshness-escrow` reducer under `services/jangar/src/server/`.
- Add policy data for action classes and required stages.
- Extend control-plane status with `stage_freshness_escrow_receipts`.
- Extend material-action verdicts to include receipt id and current stage epoch id.
- Add a compact Torghut consumer projection for `paper_canary`, `live_micro_canary`, and `repair_dispatch`.
- Keep evidence refs tied to existing execution trust, workflow stage status, runtime kits, rollout health, and negative
  evidence router refs.
- Do not require broader Kubernetes RBAC.

Validation commands:

- `bun run --filter jangar test -- services/jangar/src/server/__tests__/control-plane-status.test.ts services/jangar/src/server/__tests__/control-plane-runtime-admission.test.ts`
- `bun run --filter jangar test -- services/jangar/src/server/__tests__/control-plane-material-action-verdict.test.ts`
- `bun run --filter jangar test -- services/jangar/src/routes/api/torghut/trading/control-plane/quant/-health.test.ts`
- `bunx oxfmt --check services/jangar/src/server services/jangar/src/routes/api/torghut/trading/control-plane/quant`

Acceptance gates:

- A test proves stale discover/plan/implement/verify stages produce dependency quorum `delay` and receipt
  `reclocked_authority_decision=hold`.
- A test proves `repair_dispatch` remains allowed when max notional is `0`.
- A test proves `paper_canary` and `live_micro_canary` are held when current stage epoch is stale, even if prior
  authority was `allow`.
- A test proves receipt ids and stage epoch ids are stable for identical evidence and change when stage freshness
  changes.
- A test proves runtime-kit `collaboration=healthy` does not override stale execution trust.

## Deployer Handoff

Before widening Jangar or Torghut:

- Capture Jangar `/api/agents/control-plane/status?namespace=agents`.
- Confirm stage freshness escrow receipt for the target action is `allow`, not just dependency quorum.
- Confirm every required stage has `decision=fresh`.
- Confirm runtime kits are healthy and NATS remains present.
- Confirm rollout health has no degraded deployment.
- Confirm Torghut proof floor is not `repair_only` for the requested paper/live action.
- Confirm rollback target is explicit.

Rollout sequence:

1. Ship receipts in observe-only mode.
2. Compare receipt decisions against existing dependency quorum for at least one control-plane cycle.
3. Wire Torghut paper/live capital gates to receipt id and stage epoch id.
4. Enforce `merge_ready` and `deploy_widen` holds after receipt decisions match dependency quorum for one day.
5. Keep zero-notional repair allowed throughout.

Rollback:

- Disable enforcement and return material-action verdicts to dependency-quorum-only mode.
- Keep emitting receipts for audit.
- Keep Torghut capital at `zero_notional` while enforcement is rolled back.
- Do not delete stage evidence or receipt history.

## Risks

- Stage freshness thresholds can be too strict and hold legitimate deploys. Start with observe-only receipts and
  promote enforcement after one day of parity.
- Consumers may initially forget to attach stage epoch ids. Treat missing epoch as hold for capital and warning for
  observe.
- Receipts can become noisy if every action produces a unique id. Hash normalized evidence and policy inputs so
  identical evidence yields stable ids.
- Repair dispatch could become a loophole if notional is not enforced. Jangar must require `max_notional=0` for
  repair dispatch under stale stages.

## Final Position

Jangar is healthy enough to serve, but not fresh enough to authorize capital or rollout widening. That distinction is
the point.

My decision is to reclock every material action against current stage freshness. Serve and repair can continue; stale
stages cannot spend capital.
