# 132. Jangar Renewable Passport Ledger And Proof-Floor Actuation (2026-05-07)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-07
Owner: Victor Chen, Jangar Engineering
Scope: Jangar control-plane resilience, schedule passport renewal, failed-run retirement, rollout admission, Torghut
proof-floor actuation, validation, and rollback.

Companion Torghut contract:

- `docs/torghut/design-system/v6/136-torghut-profit-proof-renewal-market-and-tca-settlement-2026-05-07.md`

Extends:

- `131-jangar-cross-plane-evidence-custody-and-dispatch-escrow-2026-05-06.md`
- `131-jangar-capital-qualification-receipts-and-rollout-repair-arbiter-2026-05-06.md`
- `130-jangar-synthetic-readiness-settlement-and-evidence-probe-fuses-2026-05-06.md`
- `129-jangar-consumer-evidence-leases-and-readiness-decoupling-2026-05-06.md`

## Decision

I am selecting a **renewable passport ledger with proof-floor actuation** as the next Jangar control-plane contract.

The latest evidence says the broad service rollout is working, but the action plane is still paying stale-proof debt.
At `2026-05-07T04:56Z`, `deployment/agents-controllers` was `2/2`, `deployment/jangar` was `1/1`, Jangar `/ready`
returned `status=ok`, Jangar control-plane status reported a healthy database projection with `28` registered and
applied Kysely migrations, and watch reliability reported `1823` recent events with `0` errors and `0` restarts.
Torghut live and sim deployments were also running on the current revision.

The same read showed why this cannot be treated as done. The `agents` namespace still had `56` failed pods,
`14` running pods, and `154` succeeded pods. Recent cron retries failed with stale schedule runtime and recovery digest
checks, including `stale schedule runtime-kit digest: stamped=431f764fba4f154e current=5eb21f0583c35fec` and
`stale schedule recovery-case digest: stamped=427d3c737f118967 current=9083758b60368737`. Jangar status projected
fresh runtime kits and admission passports, but execution trust was degraded because the discover, plan, implement, and
verify stages were stale. Material receipts correctly held `deploy_widen` and `merge_ready`, allowed only repair-shaped
normal dispatch, held paper canary, and blocked live capital actions.

Torghut reinforced the decision. Its trading health endpoint was degraded with `simple_submit_disabled`,
`proof_floor.route_state=repair_only`, `capital_state=zero_notional`, `promotion_eligible_total=0`, stale execution
TCA from `2026-04-02T20:59:45Z`, stale market context across technicals, fundamentals, news, and regime, and a scoped
quant ingestion lag of `40284` seconds. Direct CNPG cluster listing and database exec were forbidden to this runner by
RBAC, so the control plane must keep using route-projected, least-privilege evidence.

The selected direction does not just patch old CronJobs or widen a hold. Jangar should make launch proof renewable and
retirable. A schedule, rollout, merge, or Torghut capital action must cite the current passport ledger entry, and old
failed-run evidence must stay open until a current-digest successor proves the same stage has recovered. The tradeoff is
that normal dispatch and deploy widening will stay conservative longer. I accept that because it removes the failure
mode where an old runner keeps creating failure evidence after the deployment has already been fixed.

## Success Metrics

The engineer and deployer stages should treat this contract as successful when:

- Every schedule launch carries a `passport_ledger_id`, current runtime-kit digest, current recovery-case digest, and
  current runner image digest.
- Stale runner failures are attached to a `retirement_cursor`, not counted forever as ambiguous stage failure.
- A stage can move from `stale` to `renewed` only after a successful run on the current digest and generation.
- `dispatch_repair` remains available with zero capital authority while `dispatch_normal`, `deploy_widen`, and
  `merge_ready` hold on unresolved ledger debt.
- Torghut paper/live action receipts require a current proof-floor actuation entry, not only a reachable trading route.
- The control-plane status route exposes current, stale, superseded, and retired proof states without pod exec or Secret
  reads.
- Rollback can disable enforcement and keep shadow ledger emission for forensics.

## Evidence Snapshot

All evidence was collected read-only. I did not mutate Kubernetes resources, database rows, broker state, trading flags,
GitOps manifests, ClickHouse tables, or empirical artifacts.

### Cluster And Rollout

- `kubectl config current-context` was unset, but `kubectl auth whoami` succeeded as
  `system:serviceaccount:agents:agents-sa`.
- `deployment/agents-controllers` was `2/2` available on image
  `registry.ide-newton.ts.net/lab/jangar:39c27b12@sha256:cdfdcb5e829ee93de87320b2912260cc7d025a9924815ec1327d2f99bcbed755`.
- `deployment/agents` was `1/1`, `deployment/jangar` was `1/1`, and Jangar pod `jangar-56bdb9885b-dss9q` was
  `2/2 Running`.
- Torghut live `torghut-00250-deployment` and sim `torghut-sim-00350-deployment` were both `1/1` available.
- Agents pod phases were `Failed=56`, `Running=14`, and `Succeeded=154`.
- AgentRun phases were `Failed=14`, `Running=10`, `Succeeded=207`, and `Template=12`.
- Recent warnings included controller readiness probe timeouts, `BackoffLimitExceeded` for scheduled swarm CronJobs,
  and `UnexpectedJob` warnings from manual jobs observed by CronJobs.
- Failed runner logs showed stale schedule runtime and recovery digest checks from earlier runner generations.

### Jangar Routes

- `/ready` returned `status=ok`, leader election active, memory provider healthy, serving and collaboration runtime
  kits healthy, and swarm admission passports `allow` with `execution_trust_degraded` reason codes.
- `/api/agents/control-plane/status?namespace=agents` reported database `connected=true`, database
  `status=healthy`, migration consistency `registered_count=28`, `applied_count=28`, and latest migration
  `20260505_torghut_quant_pipeline_health_window_index`.
- The same status route reported watch reliability `healthy`, `window_minutes=15`, `total_events=1823`, `total_errors=0`,
  and `total_restarts=0`.
- Execution trust was degraded because Jangar discover, plan, implement, and verify stages were stale.
- Material action receipts allowed `serve_readonly`, `dispatch_repair`, and `torghut_observe`; made
  `dispatch_normal` `repair_only`; held `deploy_widen`, `merge_ready`, and `paper_canary`; and blocked
  `live_micro_canary` and `live_scale`.

### Torghut Routes And Data

- `GET /trading/health` on the live Knative route returned `status=degraded`.
- Postgres, ClickHouse, Alpaca, universe, scheduler, empirical jobs, and the readiness cache were individually `ok`.
- `live_submission_gate.ok=false` with `simple_submit_disabled`, capital stage `shadow`, and
  `promotion_eligible_total=0`.
- `profitability_proof_floor.route_state=repair_only`, `capital_state=zero_notional`, and blocking reasons included
  `hypothesis_not_promotion_eligible`, `execution_tca_stale`, and `simple_submit_disabled`.
- Alpha readiness had `3` hypotheses: `1` blocked, `2` shadow, `0` promotion eligible, and `3` requiring rollback.
- Quant latest metrics were globally fresh with `latestMetricsCount=4032` and `metricsPipelineLagSeconds=0`, but scoped
  live evidence for account `PA3SX7FYNUTF`, window `15m`, reported ingestion lag `40284` seconds.
- Market context health was degraded: technicals were stale by about `203833` seconds against a `60` second budget,
  fundamentals by about `4806811` seconds against `86400`, news by about `4439997` against `300`, and regime by about
  `203833` against `120`.

### Source Evidence

- `services/jangar/src/server/supporting-primitives-controller.ts` is `3060` lines and owns schedule runners, runner
  ConfigMaps, CronJobs, workspace PVC lifecycle, swarm reconciliation, and requirement dispatch.
- The schedule runner command now refreshes admission traces instead of throwing on stale stamped passport, runtime, or
  recovery digests; focused tests assert the stale-digest throw strings are absent and current annotations/parameters
  are written.
- `services/jangar/src/server/primitives-kube.ts` now includes `persistentvolumeclaim`, `persistentvolumeclaims`,
  `pvc`, and `pvcs` as built-in core `v1` resource targets. Focused tests cover PVC alias reads and lists.
- `services/jangar/src/server/control-plane-runtime-admission.ts` emits runtime kits and admission passports with a
  `5` minute freshness window, runtime-kit digests, and recovery-case digests.
- `services/torghut/app/trading/proof_floor.py` builds the proof-floor receipt that already translates
  `simple_submit_disabled`, `hypothesis_not_promotion_eligible`, and `execution_tca_stale` into repair-only
  capital state.
- `services/torghut/migrations/versions/0021_strategy_hypothesis_governance.py` persists hypothesis, metric window,
  capital allocation, and promotion decision tables; source has `31` Alembic migration files.

## Problem

The system has improved enough that its biggest risk has changed.

The old risk was a dead control plane. The current risk is a live control plane that cannot prove whether a failure
belongs to the current release, an old schedule generation, a stale Torghut data surface, or a real action blocker.

Specific failure modes:

1. **Stale launch debt survives repair.** Old runner pods still fail with stale digest checks after current code and
   images are healthy.
2. **Stage freshness collapses causes.** `stage is stale` does not distinguish old failed jobs, current missing runs,
   route-level proof gaps, or data-plane blockers.
3. **Passport freshness is local.** The runtime admission route emits fresh passports, but action consumers need a
   durable ledger showing which schedule and runner generation consumed which passport.
4. **Capital blockers are not paired to launch blockers.** Torghut proof-floor repair items live in Torghut while
   Jangar schedule and rollout debt live in Jangar. Actions need one joined actuation view.
5. **Least-privilege validation is mandatory.** This runner cannot list CNPG clusters or exec into database pods, so
   the durable contract must be route and object based.

## Alternatives Considered

### Option A: Patch Or Delete Stale CronJobs And Failed Pods

This option treats the current state as cleanup debt and focuses on retiring failed pods or refreshing CronJobs.

Pros:

- Fastest immediate reduction in red objects.
- Low schema and route complexity.
- Uses code that already refreshes schedule runner admission traces.

Cons:

- Does not prove whether future stale stage evidence is current or historical.
- Does not connect launch repair to Torghut proof-floor repair.
- Can hide a true current-stage failure if cleanup happens before a successor run proves recovery.

Decision: reject as the architecture direction. Cleanup is useful, but it is an implementation detail under a ledger.

### Option B: Freeze All Non-Read-Only Actions Until Every Surface Is Healthy

This option blocks normal dispatch, deploy widening, merge readiness, paper, and live until Jangar stages, Torghut data,
and proof-floor receipts are all healthy.

Pros:

- Strong safety posture.
- Easy incident explanation.
- Prevents stale proof from widening rollout or capital.

Cons:

- Blocks zero-notional repair and makes recovery slower.
- Treats stale market context the same as stale schedule generation.
- Increases backlog and failed-run pressure when the safe action is to run bounded repair.

Decision: reject. The control plane must stay useful during degraded proof states.

### Option C: Renewable Passport Ledger With Proof-Floor Actuation

This option creates a durable ledger entry for each admitted launch and a retirement cursor for each old failure class.
Material action receipts consume the ledger and the Torghut proof-floor actuation entry.

Pros:

- Separates current launch authority from historical failure evidence.
- Keeps bounded repair available while holding rollout and capital.
- Gives deployers one proof handle for schedule, image, database projection, runtime kit, and Torghut proof floor.
- Makes rollback a switch from enforcement to shadow emission, not a blind cleanup.

Cons:

- Adds a new ledger reducer and status projection.
- Requires action-class policy to avoid over-holding normal dispatch.
- Requires careful handling of old failures so they are retired only after current proof succeeds.

Decision: select Option C.

## Architecture

Jangar emits one renewable passport ledger entry per launchable schedule generation and action class.

```text
renewable_passport_ledger_entry
  ledger_id
  namespace
  swarm_name
  stage
  action_class
  schedule_name
  schedule_generation
  runner_image_digest
  runtime_kit_set_digest
  recovery_case_set_digest
  admission_passport_id
  proof_floor_actuation_id
  observed_at
  fresh_until
  state                  # current, stale, superseded, retired, blocked
  reason_codes
  successor_ledger_id
```

Every failed runner pod, failed AgentRun, and stale stage signal maps to a retirement cursor.

```text
proof_retirement_cursor
  cursor_id
  namespace
  swarm_name
  stage
  failure_ref
  failure_observed_at
  failure_digest
  current_ledger_id
  successor_success_ref
  state                  # open, repair_in_progress, retired, reclassified
  retirement_reason
```

The retirement rule is deliberately conservative:

- Old stale-digest failures can be marked `repair_in_progress` when a current ledger entry exists.
- They can be marked `retired` only after the same swarm/stage succeeds on the current ledger entry.
- If the current ledger entry fails, the cursor is reclassified as current failure evidence.
- Retired cursors remain visible in history but stop degrading current `dispatch_normal`, `deploy_widen`, and
  `merge_ready` receipts.

Proof-floor actuation joins Torghut evidence to Jangar action policy.

```text
proof_floor_actuation
  actuation_id
  generated_at
  account_label
  market_window
  torghut_revision
  proof_floor_receipt_ref
  quant_evidence_ref
  market_context_ref
  execution_tca_ref
  hypothesis_readiness_ref
  state                  # repair_only, observe, paper_ready, live_micro_ready, blocked
  max_notional
  repair_bids
  fresh_until
```

Action policy:

- `serve_readonly`: requires route and database projection freshness; ignores old runner debt.
- `dispatch_repair`: requires a current passport ledger entry; allows repair with zero capital even when retirement
  cursors are open.
- `dispatch_normal`: requires no current failed cursor for the same stage and current ledger.
- `deploy_widen` and `merge_ready`: require all current ledger entries for Jangar stages to be `current` or `retired`
  with successor proof.
- `torghut_observe`: requires proof-floor actuation state `observe` or better.
- `paper_canary`: requires proof-floor actuation state `paper_ready`.
- `live_micro_canary` and `live_scale`: require paper closeout plus fresh execution TCA and market-context bonds.

## Implementation Scope

Engineer stage owns:

1. Add pure builders for `renewable_passport_ledger_entry`, `proof_retirement_cursor`, and `proof_floor_actuation`.
2. Project ledger and cursor summaries in `/api/agents/control-plane/status`.
3. Wire `supporting-primitives-controller.ts` schedule reconciliation to create shadow ledger entries before CronJob
   materialization.
4. Add retirement cursor classification from AgentRun and pod failure evidence.
5. Join Torghut proof-floor route data into proof-floor actuation.
6. Add tests for stale old failures, current failures, successful successor retirement, and action-class gating.

Deployer stage owns:

1. Confirm shadow ledger emission for at least two scheduled cycles.
2. Confirm no schedule uses a stale runtime-kit or recovery-case digest after ledger shadowing.
3. Confirm `dispatch_repair` remains available with zero capital while `deploy_widen` and `merge_ready` hold on open
   cursors.
4. Enable enforcement for Jangar schedule dispatch first, then rollout widening, then Torghut paper canary.

## Validation Gates

Minimum local/CI gates:

- `bun run --filter jangar test -- supporting-primitives-controller`
- `bun run --filter jangar test -- control-plane-status`
- `bun run --filter jangar test -- control-plane-material-action-verdict`
- `bun run --filter jangar test -- torghut-quant-runtime`
- `uv run --frozen pytest tests/test_profitability_proof_floor.py tests/test_trading_api.py -q` from `services/torghut`
- `uv run --frozen pyright --project pyrightconfig.json` from `services/torghut` if Torghut code changes are made.

Read-only runtime gates:

- `kubectl get pods -n agents` shows no new stale-digest failures after the current ledger is active.
- Jangar status shows database migration consistency healthy and watch reliability healthy.
- Jangar status shows ledger entries with `state=current` for active schedules.
- Jangar status shows old stale failures as `repair_in_progress` or `retired`, not silently removed.
- Torghut `/trading/health` proof floor remains `repair_only` until paper criteria are met.

## Rollout

1. Shadow ledger emission only; no action-class behavior changes.
2. Show ledger state and retirement cursors in status and UI surfaces.
3. Enforce current ledger for new `dispatch_repair` and `dispatch_normal`.
4. Enforce ledger retirement for `deploy_widen` and `merge_ready`.
5. Enforce proof-floor actuation for `paper_canary`.
6. Enforce live action classes only after paper closeout and execution TCA settlement are fresh.

## Rollback

- Disable ledger enforcement and keep shadow emission.
- Revert action-class policy to existing material receipt decisions.
- Keep retired cursor history immutable, but stop using it for action gating.
- If schedule dispatch is over-held, allow `dispatch_repair` for current ledger entries with max runtime and max
  concurrency caps.
- If Torghut proof-floor actuation is unavailable, hold paper/live and keep observe/repair paths only.

## Risks

- Ledger state can become another dashboard if action consumers do not cite it. Mitigation: require ledger ids in
  schedule parameters and rollout handoffs.
- Retirement can hide a real failure if it is too eager. Mitigation: retire only after same-stage current-digest
  success.
- Enforcement can block useful work. Mitigation: keep `dispatch_repair` explicitly separate from `dispatch_normal`.
- Torghut proof-floor routes can lag. Mitigation: action classes consume `fresh_until`, not a cached status bit.
- RBAC gaps can tempt manual validation. Mitigation: keep database and cluster proof route-projected.

## Handoff Contract

Engineer acceptance:

- A unit test proves an old stale runtime digest failure remains open until a current ledger successor succeeds.
- A unit test proves a current failed ledger blocks `dispatch_normal` and `deploy_widen` but permits bounded
  `dispatch_repair`.
- A route test proves status includes ledger entries, retirement cursors, and proof-floor actuation.
- A Torghut contract test proves `repair_only` proof floor keeps paper/live blocked and returns ranked repair bids.

Deployer acceptance:

- Capture before/after status snippets for ledger, watch reliability, database projection, and material receipts.
- Confirm no new stale-digest scheduled pods are created after enforcement.
- Confirm old failed pods are visible as retired or reclassified, not manually erased from the evidence trail.
- Confirm rollback returns action policy to shadow mode without deleting ledger history.
