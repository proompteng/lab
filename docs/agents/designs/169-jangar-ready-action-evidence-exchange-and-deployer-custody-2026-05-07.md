# 169. Jangar Ready-Action Evidence Exchange And Deployer Custody (2026-05-07)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-07
Owner: Victor Chen, Jangar Engineering
Scope: Jangar control-plane evidence settlement, stage-specific action packets, engineer acceptance gates, deployer
custody, rollout, rollback, and Torghut capital handoff.

Companion Torghut contract:

- `docs/torghut/design-system/v6/173-torghut-no-notional-repair-options-desk-and-promotion-custody-2026-05-07.md`

Extends:

- `168-jangar-source-heartbeat-witness-settlement-and-material-action-bonds-2026-05-07.md`
- `167-jangar-terminal-evidence-half-life-and-debris-retirement-2026-05-07.md`
- `148-jangar-source-rollout-truth-exchange-and-proof-floor-settlement-2026-05-07.md`
- `docs/torghut/design-system/v6/172-torghut-repair-yield-ledger-and-session-proof-capital-gates-2026-05-07.md`

## Decision

I am selecting a **ready-action evidence exchange with deployer custody receipts** as the next Jangar control-plane
architecture step.

The current platform is no longer broadly unavailable. Argo CD reports `agents`, `jangar`, and `torghut`
`Synced/Healthy` at main `250e2e1fd8a14ea235215ab8bb93cb8cf9e40421`. Jangar is serving, agents controllers are
available, database connectivity and migration consistency are healthy, watch reliability is healthy, and the
controller heartbeat table is current. That positive state matters.

The same run also shows why a green rollout is not the same thing as a ready action. The agents namespace still has
38 failed pods and 14 failed jobs, with 4 active jobs. Jangar status still reports `agentrun_ingestion.status=unknown`
from the serving route even though the database heartbeat projection says the controller components are healthy. The
status route carries many useful receipts, but an engineer or deployer still has to interpret which receipt matters for
which action class. Torghut is worse as a consumer: `/trading/health` is degraded, proof floor is `repair_only`,
maximum notional is `0`, market context is stale, route TCA is incomplete, and promotion evidence tables are mostly
empty.

The design answer is not another global red/green reducer. Jangar should publish a ready-action exchange that converts
cluster, source, and database evidence into typed packets for the next stage: what is allowed, what is held, who owns
the next proof, which evidence references are authoritative, and what rollback keeps the system safe if the packet is
wrong. This makes the control plane more resilient because a deployer cannot widen rollout or capital scope by
pointing at one healthy surface while another action-specific gate is still unsettled.

The tradeoff is more explicit ceremony before promotion. I am accepting that cost because the existing architecture
already has enough evidence surfaces; the next leverage point is custody. The system should say "repair route evidence
under zero notional" or "do not dispatch normal work until controller ingestion witness is current" without requiring a
human to reverse-engineer that from a large status payload.

## Success Metrics

Success means:

- `/api/agents/control-plane/status?namespace=agents` emits `ready_action_exchange` in advisory mode first.
- Each exchange includes `exchange_id`, `namespace`, `generated_at`, `fresh_until`, `source_revision_ref`,
  `evidence_snapshot_ref`, `action_packets`, `custody_receipts`, `handoff_contract`, and `rollback_target`.
- Packets exist for `serve_readonly`, `dispatch_repair`, `dispatch_normal`, `deploy_widen`, `merge_ready`,
  `torghut_observe`, `paper_canary`, `live_micro_canary`, and `live_scale`.
- Each packet has a decision, owner lane, required evidence, forbidden evidence shortcuts, smallest unblocker,
  validation commands, rollout gate, rollback gate, and expiration.
- `serve_readonly` can allow while cluster/database status is healthy.
- `dispatch_repair` can allow only when the repair names a debt class and stays inside a bounded runtime/notional
  budget.
- `dispatch_normal`, `deploy_widen`, and `merge_ready` stay held while source rollout truth, controller ingestion,
  terminal debris, or database witness custody is unsettled.
- Torghut paper/live packets stay held while proof floor is `repair_only`, market context is stale, route TCA is
  incomplete, promotion evidence is absent, or Jangar terminal/action packets are above carry budget.
- Deployer handoff is a first-class payload field, not a prose-only note.

## Evidence Snapshot

All evidence in this pass was collected read-only on 2026-05-07. I did not mutate Kubernetes resources, database
records, secrets, AgentRuns, GitOps resources, or Torghut flags.

### Cluster And Rollout Evidence

- Branch: `codex/swarm-jangar-control-plane-plan`, based on `main` at `250e2e1fd`.
- `kubectl config current-context` was unset. Reads used the in-cluster service account
  `system:serviceaccount:agents:agents-sa`.
- Argo CD reported:
  - `agents`: `Synced`, revision `250e2e1fd8a14ea235215ab8bb93cb8cf9e40421`, `Healthy`, last operation succeeded at
    `2026-05-07T22:18:19Z`.
  - `jangar`: `Synced`, same revision, `Healthy`, last operation succeeded at `2026-05-07T22:17:42Z`.
  - `torghut`: `Synced`, same revision, `Healthy`, last operation succeeded at `2026-05-07T23:11:36Z`.
- Jangar namespace: `deployment/jangar` was `1/1`, pod `jangar-6bc4f87fff-t2lz9` was `2/2 Running`, and the service
  endpoint pointed at that pod.
- Agents namespace: deployments `agents` and `agents-controllers` were available; pod phase counts were 8 `Running`,
  188 `Succeeded`, and 38 `Failed`.
- Agents jobs: 204 total, 186 succeeded, 14 failed, and 4 active at sampling time.
- AgentRun CRs: 357 `Succeeded`, 19 `Failed`, 4 `Running`, and 12 `Template`.
- Recent agents events showed current schedule-runner CronJobs completing on the current Jangar image, but retained
  failed schedule CronJobs and failed manual attempts are still present.
- Torghut namespace: live revision `torghut-00289` and sim revision `torghut-sim-00388` were running. Recent events
  still included startup and readiness probe failures before those revisions became ready.

### Source Evidence

- `services/jangar/src/server/supporting-primitives-controller.ts` is still the highest-risk module at 3,314 lines.
  It owns schedule generation, supporting primitive reconciliation, runtime dispatch, PVC lifecycle, and status.
- `services/jangar/src/server/agents-controller/index.ts` is 1,827 lines and owns the AgentRun ingestion runtime state
  that can mark ingestion stalled or recovered.
- `services/jangar/src/server/control-plane-status.ts` is 787 lines and already assembles controller authority,
  database health, watch reliability, runtime admission, negative evidence, route stability escrow, and material
  action receipts.
- `services/jangar/src/server/control-plane-negative-evidence-router.ts` maps controller ingestion, Torghut readiness,
  market context, quant alerts, source schema, rollout ambiguity, and failure-domain holdbacks into action budgets.
- The source already has good test coverage around individual reducers: `control-plane-status`,
  `control-plane-negative-evidence-router`, `control-plane-route-stability-escrow`, `control-plane-controller-witness`,
  `agents-controller`, and Torghut readiness/profitability tests. The gap is cross-surface custody: no single contract
  tells engineer and deployer stages which packet is ready, which proof owns the decision, and which rollback applies.

### Database And Data Evidence

- Direct Jangar Postgres reads succeeded with the app credential. `current_database()` returned `jangar`; latest
  Kysely migrations included the three 2026-05-05 Torghut quant indexes.
- `agents_control_plane.resources_current` had about 3,660 live rows, fresh autovacuum/autoanalyze at
  `2026-05-07T23:23Z`, and current rows for 3,621 AgentRuns, 24 ImplementationSpecs, 8 Agents, 6 AgentProviders, and
  1 VersionControlProvider.
- `agents_control_plane.component_heartbeats` had fresh healthy rows for `agents-controller`,
  `orchestration-controller`, `supporting-controller`, and `workflow-runtime` at `2026-05-07T23:24Z`.
- The status route still reported `agentrun_ingestion.status=unknown` with message `agents controller not started`.
  That is a custody split: the database projection is current, but the serving route cannot locally assert the
  controller ingestion witness.
- `torghut_control_plane.quant_metrics_latest` was fresh through `2026-05-07T23:24Z`; the sampled account
  `PA3SX7FYNUTF` had 144 rows per window.
- `torghut_control_plane.quant_pipeline_health` carried about 51,102,150 live rows with no sampled autovacuum and no
  sampled autoanalyze timestamp.
- Torghut Postgres reads succeeded. `trade_decisions` had 147,623 rows with newest decision
  `2026-05-06T17:44:19Z`; `execution_tca_metrics` had 13,775 rows with newest computation `2026-05-07T14:23:44Z`;
  `strategy_promotion_decisions` had 1 shadow row with `allowed=false`; `research_promotions`,
  `vnext_promotion_decisions`, and autoresearch epoch/spec tables had zero rows.
- Torghut table statistics were not a reliable readiness proxy: `pg_stat_user_tables` estimated only 17 live rows for
  `trade_decisions` while the exact count was 147,623, and no autovacuum/autoanalyze timestamp was sampled for that
  table.

## Problem

Jangar now has several receipts that are individually useful:

1. Rollout and Argo CD health say the deployed system is available.
2. Database and migration checks say the app can read its schema.
3. Watch reliability says the status route is receiving events.
4. Component heartbeats say controller processes are alive.
5. Negative evidence and material action receipts say several action classes are still held.
6. Torghut proof floor says trading capital remains zero-notional.

The failure mode is interpretation drift. Each stage can cherry-pick the receipt that makes its local action look
reasonable. Serving can point at rollout health. Dispatch can point at watch health. Deployer can point at Argo
Healthy. Torghut can point at fresh quant metrics. None of those should override the stricter packet for normal
dispatch, deploy widening, merge readiness, paper canary, or live capital.

The control plane needs a small, stable exchange layer that turns evidence into packets. Packets are easier to test,
easier to hand off, and harder to misuse.

## Alternatives Considered

### Option A: Keep The Existing Receipt Set And Rely On Docs

Keep `material_action_activation_receipts`, `route_stability_escrow`, `source_rollout_truth_exchange`, and terminal
evidence docs as separate surfaces. Teach operators to read them together.

Advantages:

- No new payload surface.
- Reuses existing reducers and tests.
- Avoids another concept in the status route.

Disadvantages:

- Leaves too much interpretation in human handoff.
- Does not assign custody for the next proof.
- Does not give Torghut a compact action contract.

Decision: reject as the final stage contract.

### Option B: Freeze Until Every Evidence Surface Is Green

Block dispatch, deploy widening, merge readiness, and Torghut paper/live until retained failures are gone, controller
ingestion is locally healthy, all database stats are fresh, and all Torghut proof dimensions pass.

Advantages:

- Conservative.
- Easy to audit.
- Reduces accidental promotion.

Disadvantages:

- Blocks bounded repair while current serving is healthy.
- Treats stale evidence and dangerous evidence as the same class.
- Incentivizes evidence deletion instead of debt retirement.

Decision: keep as emergency posture only.

### Option C: Ready-Action Evidence Exchange

Build a compact exchange where each action class has a packet with decision, evidence refs, owner, validation gates,
and rollback.

Advantages:

- Converts evidence into stage-specific work.
- Allows safe repair without normal dispatch or capital promotion.
- Makes deployer custody explicit.
- Gives Torghut a clean consumer for Jangar control-plane state.

Disadvantages:

- Adds a new status payload.
- Requires stable action packet names.
- Needs tests that prove healthy receipts cannot upgrade stricter packets.

Decision: select Option C.

## Architecture

Jangar emits:

```text
ready_action_exchange
  schema_version
  exchange_id
  namespace
  generated_at
  fresh_until
  source_revision_ref
  evidence_snapshot_ref
  action_packets
  custody_receipts
  handoff_contract
  rollback_target
```

Each packet includes:

```text
ready_action_packet
  packet_id
  action_class
  decision              # allow | repair_only | hold | block
  owner_lane            # engineer | deployer | torghut | observer
  evidence_refs
  blocking_debt_classes
  allowed_scope
  forbidden_shortcuts
  smallest_unblocker
  validation_commands
  rollout_gate
  rollback_gate
  expires_at
```

Initial action classes:

- `serve_readonly`
- `dispatch_repair`
- `dispatch_normal`
- `deploy_widen`
- `merge_ready`
- `torghut_observe`
- `paper_canary`
- `live_micro_canary`
- `live_scale`

Initial debt classes:

- `controller_ingestion_witness_split`
- `terminal_debris_carry`
- `source_rollout_truth_missing`
- `database_stats_stale`
- `quant_pipeline_carry`
- `torghut_market_context_stale`
- `torghut_route_tca_incomplete`
- `promotion_evidence_absent`

The exchange does not replace existing evidence. It references existing receipts and makes the decision consumable.
The reducer must be monotonic: a healthy weaker receipt cannot upgrade a stricter packet. For example, Argo `Healthy`
can support `serve_readonly`, but it cannot unlock `deploy_widen` while source rollout truth is missing. Fresh quant
metrics can support `torghut_observe`, but they cannot unlock `paper_canary` while market context is stale and
promotion evidence is absent.

## Implementation Scope

Engineer scope:

1. Add `control-plane-ready-action-exchange.ts` as a collector module.
2. Feed it existing status inputs: rollout health, database status, watch reliability, controller witness,
   AgentRun ingestion, negative evidence router, material action receipts, route stability escrow, source rollout truth
   exchange, terminal evidence half-life, and Torghut proof floor.
3. Add typed API data structures and UI rendering for packet decisions, smallest unblockers, and validation gates.
4. Add tests proving packet monotonicity and the current split-state case:
   - rollout healthy plus database healthy allows `serve_readonly`;
   - `agentrun_ingestion=unknown` keeps `dispatch_normal`, `deploy_widen`, and `merge_ready` held;
   - Torghut `proof_floor=repair_only` keeps `paper_canary` and live classes held;
   - stale database stats become debt, not a serving outage.

Deployer scope:

1. Treat `ready_action_exchange.handoff_contract` as the deployer stage input.
2. Do not widen rollout or mark merge-ready from Argo health alone.
3. For a held packet, execute only the packet's smallest unblocker or explicitly document why the packet is stale.
4. Roll back by disabling exchange enforcement and returning packets to advisory mode while preserving collection.

## Validation Gates

Required local validation for implementation:

- `bun run --cwd services/jangar test -- src/server/__tests__/control-plane-status.test.ts`
- `bun run --cwd services/jangar test -- src/server/__tests__/control-plane-negative-evidence-router.test.ts`
- `bun run --cwd services/jangar test -- src/server/__tests__/control-plane-route-stability-escrow.test.ts`
- `bun run --cwd services/jangar test -- src/components/__tests__/agents-control-plane-status.test.tsx`
- `bun run --cwd services/jangar tsc`
- `bun run --cwd services/jangar lint`

Required read-only deployer validation:

- `kubectl -n argocd get applications.argoproj.io agents jangar torghut -o json`
- `kubectl -n agents get deploy,pods,jobs,agentruns.agents.proompteng.ai`
- `curl -sS http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status?namespace=agents`
- `curl -sS http://torghut.torghut.svc.cluster.local/trading/health`
- Read-only SQL for `agents_control_plane.resources_current`, `agents_control_plane.component_heartbeats`,
  `torghut_control_plane.quant_metrics_latest`, `torghut_control_plane.quant_pipeline_health`, Torghut
  `trade_decisions`, TCA, and promotion tables.

## Rollout

1. Ship the collector in shadow mode and render packets in the control-plane UI.
2. Compare packet decisions against existing material action receipts for at least one full schedule cycle.
3. Enable advisory NATS/Jangar updates that summarize held packet names and smallest unblockers.
4. Gate `deploy_widen` and `merge_ready` consumers on the exchange after packet parity is stable.
5. Let Torghut consume only `torghut_observe`, `paper_canary`, and live capital packets. Torghut must not infer capital
   eligibility directly from Jangar rollout health.

## Rollback

Rollback target:

- Set the exchange to advisory mode.
- Keep existing material action receipts, route stability escrow, source rollout truth exchange, and terminal evidence
  reducers active.
- Preserve packet collection so operators can compare pre-rollback and post-rollback evidence.
- Keep Torghut capital at zero notional until proof floor and promotion evidence independently pass.

Rollback is safe because this design adds an exchange layer. It should not delete evidence, mutate AgentRuns, change
CronJobs, or alter database records.

## Risks And Tradeoffs

- More visible holds can frustrate fast deploys. That is acceptable because the packet names the unblocker.
- Packet names can drift if reducers evolve without tests. Monotonicity tests are mandatory.
- A stale packet can block useful repair. Packets therefore expire and must carry `fresh_until`.
- The exchange can become a dumping ground if it grows unbounded. Keep packets action-class scoped and keep detailed
  evidence in the existing collectors.

## Handoff Contract

Engineer acceptance gates:

- Implement the exchange as a collector, not inside `supporting-primitives-controller.ts`.
- Preserve current serving behavior while packets are advisory.
- Add regression fixtures for the current state: Argo healthy, Jangar DB healthy, component heartbeat current,
  `agentrun_ingestion=unknown`, retained failed jobs/pods, and Torghut proof floor `repair_only`.
- Prove that no healthy single surface upgrades `dispatch_normal`, `deploy_widen`, `merge_ready`, `paper_canary`, or
  live capital while stricter packet debt remains.

Deployer acceptance gates:

- Before widening rollout, confirm `ready_action_exchange.action_packets[deploy_widen].decision=allow`.
- Before merge-ready, confirm `ready_action_exchange.action_packets[merge_ready].decision=allow`.
- Before any Torghut paper canary, confirm Jangar `paper_canary=allow`, Torghut proof floor is above `repair_only`,
  market context is fresh, route TCA is complete, and promotion evidence exists.
- For rollback, disable enforcement only; do not delete evidence or terminal debris as the rollback mechanism.
