# 170. Jangar Profit-Witness Broker And Source-Truth Capital Custody (2026-05-08)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-08
Owner: Gideon Park, Torghut Traders Architecture
Scope: Jangar control-plane resilience, source-truth settlement, Torghut profit-witness custody, material action
admission, rollout, rollback, and engineer/deployer gates.

Companion Torghut contract:

- `docs/torghut/design-system/v6/174-torghut-route-local-profit-lab-and-capital-frontier-2026-05-08.md`

Extends:

- `169-jangar-ready-action-evidence-exchange-and-deployer-custody-2026-05-07.md`
- `168-jangar-source-heartbeat-witness-settlement-and-material-action-bonds-2026-05-07.md`
- `166-jangar-evidence-capability-ledger-and-observer-lease-gates-2026-05-07.md`
- `docs/torghut/design-system/v6/173-torghut-no-notional-repair-options-desk-and-promotion-custody-2026-05-07.md`

## Decision

I am selecting a **profit-witness broker with source-truth capital custody** as the next Jangar architecture step.

The current platform is not in the same state as the older soak. Jangar is serving, `agents-controllers` is `2/2`,
workflow and job runtime adapters are configured, the collaboration runtime kit is healthy with `nats` present, and
Jangar control-plane status reports database connectivity plus migration consistency as healthy. That recovery is
real. It should allow read-only serving and bounded repair.

The recovered state is still not capital authority. The same status route holds `dispatch_repair`, `dispatch_normal`,
`deploy_widen`, and `merge_ready` because source rollout truth is missing, controller ingestion witness custody is
split, and the material action receipts do not have a current controller-process witness. Torghut observe is allowed,
but `paper_canary`, `live_micro_canary`, and `live_scale` remain held or blocked while Torghut proof floor is
`repair_only`, proof-floor capital is `zero_notional`, and consumer evidence is missing. That split is the failure mode
to reduce: a green deployment or healthy database can be confused with permission to spend capital or widen dispatch.

The broker makes Jangar the custodian of profit witnesses, not the inventor of trading edge. Torghut owns the route,
hypothesis, TCA, quant, and promotion evidence. Jangar owns whether that evidence is fresh, source-bound, controller
witnessed, and safe for a specific material action. The broker emits one custody decision per action class, with the
source-truth gap and controller-witness gap named as hard blockers for material dispatch and capital promotion.

The tradeoff is that Jangar will reject some work even when the cluster looks healthy. I am accepting that because the
current risk is not outage; it is accidental authority inflation. The control plane needs to say "serve and observe are
fine, capital remains closed" without relying on a human to interpret a large status payload.

## Current Evidence

All evidence in this pass was collected read-only on 2026-05-08. I did not mutate Kubernetes resources, database
records, secrets, AgentRuns, GitOps resources, or trading state.

### Cluster And Rollout Evidence

- Runtime branch: `codex/swarm-torghut-quant-discover`, based on `main` at `ef2bba887`.
- `kubectl config current-context` was initially unset; I set a local in-cluster context using the service-account
  token and confirmed identity `system:serviceaccount:agents:agents-sa`.
- `jangar` namespace deployments were available: `jangar`, `bumba`, `symphony`, `symphony-jangar`, and
  `jangar-alloy` were all `1/1`.
- `agents` namespace deployments were available: `agents` `1/1` and `agents-controllers` `2/2`.
- Current scheduler CronJobs completed quickly, but retained failed jobs still exist from the earlier failure wave:
  Jangar control-plane discover/plan/implement/verify CronJobs failed about 19-20 hours before this pass, with later
  CronJobs completing.
- Recent agents events still showed readiness probe timeouts for `agents`, `agents-controllers`, and current schedule
  pods during load.
- Torghut live and sim revisions were running on digest `4621e645...`: `torghut-00291-deployment` and
  `torghut-sim-00390-deployment` were both `1/1`.
- Torghut events showed recent readiness probe failures during revision transitions, duplicate ClickHouse
  PodDisruptionBudget selection warnings, and external modification churn on the `torghut-options-ta` FlinkDeployment
  status.

### Jangar Status Evidence

- `/health` returned `status=ok`, but the small health payload still showed `agentsController.enabled=false`. The
  control-plane status route is therefore the authoritative custody surface, not the liveness route.
- `/api/agents/control-plane/status?namespace=agents` reported:
  - leader election enabled and current;
  - controllers healthy;
  - workflow, job, temporal, and custom runtimes available or configured;
  - execution trust healthy;
  - database connected, Kysely migrations consistent, 28 registered and 28 applied;
  - watch reliability healthy with two observed streams, 786 events, zero errors, and zero restarts;
  - collaboration runtime kit healthy with `codex-nats-publish`, `codex-nats-soak`, `nats`, workspace path, and
    `NATS_URL` present.
- The same payload still carried material-action holds:
  - `source_rollout_truth_missing:source_or_gitops_revision`;
  - `witness:agentrun_ingestion`;
  - `witness:kubernetes_deployment`;
  - `witness:serving_process`;
  - `witness:watch_epoch`;
  - `controller_heartbeat_not_current`.
- Torghut observe was allowed, while paper and live capital action classes were held or blocked because Torghut proof
  floor remains repair-only and consumer evidence is missing.
- Direct CNPG custom-resource reads and pod exec were forbidden by RBAC. That is acceptable for this lane, but it
  means Jangar must publish service-owned database witnesses rather than assuming engineer/deployer stages can inspect
  databases directly.

### Source Evidence

- `services/jangar/src/server/control-plane-status.ts` already assembles the main evidence spine at 787 lines.
- `services/jangar/src/server/control-plane-route-stability-escrow.ts` provides route stability escrow at 490 lines.
- `services/jangar/src/server/agents-controller/index.ts` is 1,827 lines and owns AgentRun ingestion runtime state.
- `services/jangar/src/server/supporting-primitives-controller.ts` remains the largest risk module at 3,314 lines; it
  mixes schedule generation, supporting primitive reconciliation, runtime dispatch, PVC lifecycle, and status effects.
- Jangar has strong reducer-level tests around controller witness, material verdicts, negative evidence, route
  stability escrow, runtime admission, watch reliability, agents-controller behavior, and Torghut quant/runtime
  surfaces.
- The gap is cross-surface authority: no single broker binds source rollout truth, controller witness, Torghut
  profitability proof, and material action class into an expiring custody decision that engineer and deployer stages can
  validate.

### Database And Data Evidence

- Direct database access through CNPG or pod exec was blocked for this service account:
  - `clusters.postgresql.cnpg.io` list/get was forbidden in `jangar` and `torghut`.
  - `pods/exec` into `jangar-db-1` and `torghut-db-1` was forbidden.
  - listing `torghut` secrets was forbidden.
- Jangar service-owned database evidence was healthy through the control-plane status route:
  - `database.connected=true`;
  - `migration_consistency.status=healthy`;
  - latest registered and applied migration `20260505_torghut_quant_pipeline_health_window_index`.
- Torghut service-owned database evidence was healthy through `/db-check`:
  - `schema_current=true`;
  - current and expected Alembic head `0029_whitepaper_embedding_dimension_4096`;
  - `schema_graph_branch_count=1`;
  - lineage ready with warnings for historical migration parent forks;
  - account-scope checks bypassed because multi-account trading is disabled.
- Jangar quant health was fresh globally, but account/window Torghut evidence showed why capital should stay blocked:
  `latest_metrics_count=144` for account `PA3SX7FYNUTF`, while ingestion stage lag was `552911` seconds.

## Problem

Jangar has recovered availability, but the action boundary is still too easy to blur. A deployer can see healthy
rollouts. An engineer can see healthy watch reliability. Torghut can see fresh global quant metrics. None of those
prove that paper or live capital is safe.

The recurring failure mode is a split authority graph:

1. Source rollout truth is missing from the action receipt.
2. Controller process witnesses and rollout-derived authority can disagree.
3. Database health is available only as service-owned summaries under this RBAC profile.
4. Torghut proof dimensions are scoped by account, window, route, and hypothesis, while Jangar action receipts are
   mostly action-class scoped.
5. Failed historical jobs remain visible after later CronJobs succeed.

The next control-plane layer must turn these facts into custody decisions that are hard to misuse.

## Alternatives Considered

### Option A: Treat Healthy Control-Plane Status As Admission

Allow dispatch and deploy widening whenever controllers, runtime kits, database, and watch reliability are healthy.

Advantages:

- Simple to explain.
- Uses the recovered cluster state.
- Reduces friction for engineering work.

Disadvantages:

- Ignores source rollout truth and controller witness splits.
- Lets database health override Torghut capital evidence.
- Recreates the failure mode where a healthy global plane masks a degraded scoped consumer.

Decision: reject. This is operationally convenient but architecturally unsafe.

### Option B: Freeze All Action Classes Until Every Receipt Is Green

Block serving, repair, normal dispatch, deploy widening, merge readiness, and Torghut observe until source truth,
controller witness, Torghut proof floor, route TCA, quant ingestion, and promotion evidence are all green.

Advantages:

- Very conservative.
- Easy to audit.
- Reduces accidental rollout or capital exposure.

Disadvantages:

- Blocks useful read-only observation and zero-notional repair.
- Conflates dangerous capital actions with safe evidence work.
- Encourages evidence deletion rather than debt retirement.

Decision: keep as emergency posture only.

### Option C: Profit-Witness Broker With Source-Truth Capital Custody

Emit a brokered custody decision per action class. The broker consumes source rollout truth, controller witnesses,
runtime kits, database witnesses, route stability, and Torghut profit witnesses. It allows read-only/observe work,
allows bounded repair only when the debt and budget are explicit, and holds material dispatch/capital until scoped
profit witnesses are current.

Advantages:

- Reduces failure modes by separating availability from authority.
- Keeps repair moving while capital remains closed.
- Gives engineer and deployer stages one packet to validate.
- Preserves least-privilege database posture by relying on service-owned witnesses.

Disadvantages:

- Adds one more status payload.
- Requires source-truth and Torghut profit-witness schemas to stay stable.
- Requires tests proving healthy global receipts cannot upgrade scoped capital packets.

Decision: select Option C.

## Architecture

Jangar adds a broker payload in advisory mode first:

```text
profit_witness_broker
  schema_version
  broker_id
  generated_at
  fresh_until
  namespace
  source_truth_ref
  controller_witness_ref
  database_witness_ref
  runtime_kit_refs
  torghut_profit_witness_refs
  action_custody_packets
  rollback_target
```

Each `action_custody_packet` has:

```text
action_class
decision                 # allow | hold | block
authority_basis          # serving | rollout | heartbeat | brokered_profit | emergency
required_witnesses
accepted_debt_classes
forbidden_shortcuts
owner_lane
validation_commands
rollout_gate
rollback_gate
expires_at
```

Action class rules:

- `serve_readonly`: can allow on healthy serving, database, and runtime-kit witnesses.
- `torghut_observe`: can allow on healthy route plus zero-notional guarantee.
- `dispatch_repair`: can allow only when the repair names a debt class, has zero capital exposure, and has a bounded
  runtime budget.
- `dispatch_normal`, `deploy_widen`, and `merge_ready`: hold while source rollout truth or controller witness custody
  is missing.
- `paper_canary`: hold while Torghut proof floor is repair-only, route-local TCA is incomplete, quant ingestion is
  degraded for the account/window, or no promotion-eligible hypothesis exists.
- `live_micro_canary` and `live_scale`: block until paper custody has passed and all brokered profit witnesses are
  fresh.

## Implementation Scope

Engineer stage:

- Add `profit_witness_broker` to the Jangar control-plane status payload in shadow/advisory mode.
- Source inputs from existing reducers first: control-plane status, runtime admission, controller witness, route
  stability escrow, material action verdicts, database migration consistency, and Torghut quant/proof-floor consumers.
- Add tests that cover:
  - healthy deployment does not upgrade paper/live capital;
  - missing source truth holds dispatch and merge packets;
  - stale controller witness holds normal dispatch;
  - Torghut repair-only proof floor holds paper and blocks live;
  - observe remains allowed under zero-notional repair posture.
- Keep the payload additive and non-breaking.

Deployer stage:

- Roll out in advisory mode.
- Compare broker decisions against existing `material_action_contracts` for at least one full scheduler cycle.
- Promote the broker from advisory to enforced only after the packet decisions match existing holds for material
  classes and expose no unexpected blocks for serve/read-only actions.

## Validation Gates

Local validation:

- `bunx oxfmt --check docs/agents/designs/170-jangar-profit-witness-broker-and-source-truth-capital-custody-2026-05-08.md`
- Jangar targeted tests once implemented:
  `bun run --filter jangar test -- services/jangar/src/server/__tests__/control-plane-status.test.ts`
  `bun run --filter jangar test -- services/jangar/src/server/__tests__/control-plane-material-action-verdict.test.ts`
  `bun run --filter jangar test -- services/jangar/src/server/__tests__/control-plane-route-stability-escrow.test.ts`

Cluster validation:

- `kubectl get deployments -n jangar`
- `kubectl get deployments -n agents`
- `curl /api/agents/control-plane/status?namespace=agents`
- Confirm broker packets preserve current safe decisions:
  - serve/read-only allowed;
  - Torghut observe allowed;
  - dispatch/deploy/merge held until source/controller witnesses are current;
  - paper/live capital held or blocked until Torghut profit witnesses pass.

## Rollout

1. Ship advisory broker payload behind a feature flag.
2. Publish broker packet refs in NATS/Jangar updates for engineer and deployer stages.
3. Run shadow comparison against current material-action receipts for one full scheduler cadence.
4. Enforce only `dispatch_normal`, `deploy_widen`, and `merge_ready` holds first.
5. Enforce `paper_canary`, `live_micro_canary`, and `live_scale` after Torghut emits route-local profit settlement
   receipts.

## Rollback

- Disable the broker feature flag and continue using existing material-action receipts.
- Treat all broker packets as advisory if packet freshness expires.
- Keep Torghut capital at zero notional unless both old receipts and broker packets allow paper/live.
- If source-truth or controller-witness code regresses, fall back to `serve_readonly` plus bounded repair only.

## Risks

- Broker drift: new packet logic could diverge from existing material-action receipts. Mitigation: shadow comparison
  before enforcement.
- Payload growth: status route can become too large. Mitigation: include compact refs in the broker and keep detailed
  evidence in existing surfaces.
- False holds: missing source truth could block useful deploy work. Mitigation: allow bounded repair with explicit debt
  class and zero capital exposure.
- Least-privilege blind spots: DB direct reads are unavailable. Mitigation: require service-owned DB witnesses with
  migration head, schema graph, and freshness fields.

## Handoff Contract

Engineer acceptance gates:

- Additive `profit_witness_broker` payload exists.
- Tests prove healthy global receipts cannot upgrade scoped capital packets.
- Packet decisions are deterministic for the current evidence snapshot.
- Packet freshness and rollback fields are present for every material action class.

Deployer acceptance gates:

- Advisory broker is visible in Jangar status.
- Broker packets match current safe posture for at least one scheduler cadence.
- No paper/live capital action is allowed while Torghut proof floor remains `repair_only`.
- Rollback is a feature-flag disable, not a database edit or manual resource mutation.
