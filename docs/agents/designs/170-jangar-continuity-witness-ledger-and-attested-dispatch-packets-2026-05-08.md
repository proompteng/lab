# 170. Jangar Continuity Witness Ledger And Attested Dispatch Packets (2026-05-08)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-08
Owner: Victor Chen, Jangar Engineering Architecture
Scope: Jangar control-plane continuity, source attestation, controller handoff, material-action dispatch, deployer
custody, rollback, and Torghut capital handoff.

Companion Torghut contract:

- `docs/torghut/design-system/v6/174-torghut-continuity-priced-route-repair-market-and-capital-holds-2026-05-08.md`

Extends:

- `169-jangar-ready-action-evidence-exchange-and-deployer-custody-2026-05-07.md`
- `168-jangar-source-heartbeat-witness-settlement-and-material-action-bonds-2026-05-07.md`
- `148-jangar-source-rollout-truth-exchange-and-proof-floor-settlement-2026-05-07.md`
- `docs/torghut/design-system/v6/173-torghut-no-notional-repair-options-desk-and-promotion-custody-2026-05-07.md`

## Decision

I am selecting a **continuity witness ledger with attested dispatch packets** as the next Jangar control-plane
architecture step.

The current system can serve while action authority is still unsettled. On 2026-05-08 at 00:09Z, the `jangar`
deployment replaced `jangar-6bc4f87fff-t2lz9` with `jangar-58b965785-qbx5p`. During the handoff, the `jangar`
service briefly had no ready EndpointSlice entries, then recovered and reported `/ready.status=ok`. At 00:10Z, the
status route reported healthy Jangar database connectivity, healthy Kysely migration consistency at 28 registered and
28 applied migrations, healthy rollout for `agents` and `agents-controllers`, healthy watch reliability, and healthy
execution trust. That is useful positive evidence.

The same sample shows why Jangar still needs a stronger action authority. `/ready` reported `agentsController.started`
as `false` while serving remained `ok`. The status route marked the namespace degraded only for
`empirical:forecast`, but `material_action_verdicts` held `dispatch_repair`, `dispatch_normal`, `deploy_widen`, and
`merge_ready`. The blocking reasons were specific: `source_rollout_truth_missing:source_or_gitops_revision`,
`controller_heartbeat_not_current`, and witness refs for AgentRun ingestion, controller process, Kubernetes
deployment, and watch epoch. In other words, the system already knows serving is not the same thing as dispatch or
merge authority, but the evidence is still scattered and partly process-local.

The decision is to persist a continuity ledger that survives Jangar pod restarts and records source, rollout, leader,
controller heartbeat, watch, route, and database continuity as one action-grade witness. Material actions consume
attested dispatch packets from that ledger. Serving can stay up during a pod replacement. Dispatch, deploy widening,
merge readiness, and Torghut capital handoff must cite a continuity epoch whose required witnesses are fresh,
source-bound, and replayable.

The tradeoff is stricter proof before routine action. I accept that. The six-month failure mode is not that Jangar
cannot answer `/ready`; it is that a green route, a healthy migration check, or a post-restart watch window gets used
as promotion authority while the source revision, controller handoff, and consumer proof floor are still ambiguous.

## Success Metrics

Success means:

- Jangar emits a `continuity_witness_ledger` surface in shadow mode before enforcement.
- Each `continuity_epoch` contains `epoch_id`, `producer_revision`, `namespace`, `service`, `started_at`,
  `fresh_until`, `source_head_sha`, `gitops_revision`, `leader_transition_ref`, `endpoint_continuity_ref`,
  `controller_heartbeat_ref`, `watch_replay_ref`, `database_witness_ref`, `route_witness_ref`, and
  `consumer_floor_refs`.
- The ledger records endpoint gaps during rollout handoff instead of allowing the recovered endpoint state to erase
  them.
- Watch reliability is backed by a persisted replay watermark or explicitly marked `process_local_after_restart`.
- Material action packets for `dispatch_repair`, `dispatch_normal`, `deploy_widen`, `merge_ready`, `paper_canary`,
  `live_micro_canary`, and `live_scale` cannot upgrade from `hold` or `block` using `/ready` alone.
- `serve_readonly` remains allowed when route and database witnesses are healthy even if dispatch packets are held.
- A continuity epoch can graduate to action authority only after source and GitOps revisions are present, controller
  heartbeat is current, and watch replay covers the required resources after the last leader transition.
- Engineer and deployer handoffs include concrete acceptance gates and rollback gates.

## Evidence Snapshot

All evidence in this pass was collected read-only. I did not mutate Kubernetes resources or database records.

### Cluster And Rollout Evidence

- Branch: `codex/swarm-jangar-control-plane-discover`, based on `main` at `ef2bba887`.
- The requested remote head branch was absent when fetched. The local branch pointed at `origin/main`; prior discover
  PRs from the same head branch were already merged.
- `kubectl config current-context` was unset. I bootstrapped a local `in-cluster` context using the service account
  token and verified `system:serviceaccount:agents:agents-sa`.
- Jangar namespace initially showed `deployment/jangar` available, but the service had no ready EndpointSlice entries
  while pod `jangar-58b965785-qbx5p` was initializing.
- `kubectl rollout status deployment/jangar -n jangar --timeout=120s` then reported successful rollout. The
  EndpointSlice recovered to `10.244.5.195:8080`.
- Recent Jangar events recorded the old pod deletion, a readiness probe failure during startup, and the new pod
  becoming ready.
- Recent Jangar logs showed leader election transition to `jangar-58b965785-qbx5p`, plus earlier Kubernetes watch
  failures caused by API 429 responses and unresolved GitHub worktree snapshot refs for deleted or missing PR branches.
- Agents namespace deployments `agents` and `agents-controllers` were healthy at the sampled status route:
  `observed_deployments=2`, `degraded_deployments=0`.
- Agents namespace swarms `jangar-control-plane` and `torghut-quant` were `Active`, `lights-out`, and `Ready=True`.

### Source Evidence

- `services/jangar/src/server/control-plane-status.ts` is 787 lines and assembles database health, rollout health,
  watch reliability, runtime admission, source rollout truth, negative evidence, route stability, and material action
  receipts.
- `services/jangar/src/server/control-plane-source-rollout-truth-exchange.ts` is 632 lines and already models
  desired images, live images, controller heartbeat refs, database projection refs, watch cache refs, Torghut proof
  floors, and truth settlement receipts.
- `services/jangar/src/server/control-plane-watch-reliability.ts` is only 181 lines, but its stream store is an
  in-memory `Map`. After a serving pod replacement, a healthy watch window can mean "healthy since this process
  restarted" rather than "continuity was preserved across the handoff".
- `services/jangar/src/server/control-plane-controller-witness.ts` is 448 lines and already distinguishes controller
  self-report, rollout evidence, watch epoch, and AgentRun ingestion.
- `services/jangar/src/server/control-plane-material-action-verdict.ts` is 528 lines and already prevents many
  dangerous upgrades, but it receives evidence as reducer inputs rather than as a persisted continuity epoch.
- The local test set covers individual reducers: control-plane status, controller witness, material action verdict,
  negative evidence router, route stability escrow, watch reliability, source rollout truth, and ready route behavior.
  The gap is continuity across process restarts and endpoint handoffs.

### Database And Data Evidence

- Jangar status reported `database.configured=true`, `database.connected=true`, `database.status=healthy`, and
  `latency_ms=10`.
- Jangar Kysely migration consistency was healthy with `registered_count=28`, `applied_count=28`,
  `unapplied_count=0`, `unexpected_count=0`, and latest migration
  `20260505_torghut_quant_pipeline_health_window_index`.
- Torghut `/readyz` reported degraded readiness while dependencies for Postgres, ClickHouse, Alpaca, universe,
  empirical jobs, and scheduler were ok.
- Torghut `/db-check` reported schema current with Alembic head `0029_whitepaper_embedding_dimension_4096`; it also
  reported lineage warnings for known parent forks.
- Torghut trading proof floor was `repair_only`, `capital_state=zero_notional`, and blocked by
  `hypothesis_not_promotion_eligible`, `execution_tca_route_universe_incomplete`, and `simple_submit_disabled`.
- Torghut alpha readiness had 3 hypotheses, 0 promotion-eligible hypotheses, and 2 rollback-required hypotheses.
- Torghut route reacquisition had 8 scope symbols, 1 probing symbol, 4 blocked symbols, 3 missing symbols, and 0
  capital-eligible symbols.

## Problem

Jangar has made good progress separating serving readiness from material action authority. The problem is that the
authority still depends on evidence surfaces with different lifetimes:

1. `/ready` answers from the current serving process.
2. Watch reliability is process-local.
3. Controller heartbeats are database-backed.
4. Rollout health comes from Kubernetes.
5. Source and GitOps revision refs are environment-sourced and can be absent.
6. Torghut proof floor is a downstream consumer contract.

When a pod restarts or a leader changes, those surfaces can be individually true and jointly insufficient. A newly
started process can have a healthy route and a short healthy watch window while the old leader's last action packets,
source refs, and consumer proof floors are not yet reconciled.

The control plane needs continuity as an explicit proof, not a side effect of several green status panels.

## Alternatives Considered

### Option A: Trust Existing Material Action Verdicts

Keep the current receipts and rely on `material_action_verdicts` to hold risky actions when source rollout truth or
controller heartbeat evidence is missing.

Advantages:

- Minimal implementation work.
- Keeps today's useful reducer behavior.
- Avoids another status payload.

Disadvantages:

- Does not persist the watch window across Jangar restarts.
- Does not record endpoint gaps as first-class evidence.
- Still requires deployers to understand which reducer input is authoritative after a leader transition.

Decision: keep the reducer, but do not treat it as the final continuity authority.

### Option B: Block All Actions After Every Jangar Pod Replacement

Freeze dispatch, deploy widening, merge readiness, and Torghut paper/live actions for a fixed cooling period after any
Jangar pod replacement or leader transition.

Advantages:

- Simple safety rule.
- Easy to explain in an incident.
- Reduces accidental action immediately after controller churn.

Disadvantages:

- Blocks bounded repair even when the repair action is exactly what restores the missing witness.
- Uses wall-clock delay instead of evidence.
- Does not prove source or consumer continuity.

Decision: keep as emergency fallback only.

### Option C: Persisted Continuity Witness Ledger

Persist continuity epochs and make action packets cite them. A continuity epoch is the bridge between route health,
source refs, controller heartbeat, watch replay, database schema, and consumer proof floors.

Advantages:

- Turns process churn into auditable evidence.
- Lets serving stay available while material action remains gated.
- Gives deployers a compact packet instead of a large status payload.
- Gives Torghut a stable Jangar proof packet before any capital route can reopen.

Disadvantages:

- Requires a new persisted read model.
- Requires tests that simulate Jangar restart and leader handoff.
- Adds another producer revision that must be maintained.

Decision: select Option C.

## Architecture

Jangar adds a persisted `continuity_witness_ledger` with one row per continuity epoch.

```text
continuity_epoch
  schema_version
  producer_revision
  epoch_id
  namespace
  service
  started_at
  fresh_until
  last_leader_transition_at
  source_head_sha
  gitops_revision
  endpoint_gap_seconds
  controller_heartbeat_ref
  controller_heartbeat_status
  watch_replay_ref
  watch_required_resources
  watch_replay_status
  database_witness_ref
  route_witness_ref
  consumer_floor_refs
  continuity_decision
  action_packet_refs
  rollback_target
```

The epoch reducer applies these rules:

1. If the route and database are healthy, `serve_readonly` can allow.
2. If source or GitOps revision is missing, all material dispatch and deploy packets stay `hold`.
3. If the current process cannot prove watch replay after the last leader transition, dispatch and merge packets stay
   `hold`.
4. If controller heartbeat and serving process authority are split, repair packets may be admitted only with a bounded
   repair target that names the missing witness.
5. If Torghut proof floor is `repair_only`, all paper/live capital packets stay `hold` or `block`, and the Jangar
   packet must cite the Torghut proof floor ref.
6. Endpoint gaps during rollout handoff are retained in the epoch until the next fresh epoch proves stable endpoints.

The ledger does not replace existing reducers. It makes their cross-surface inputs durable and stage-readable.

## Implementation Scope

Engineer stage:

- Add a Kysely migration for `agents_control_plane.continuity_witness_epochs`.
- Persist epochs from `buildControlPlaneStatus` after collecting source rollout truth, controller witness, watch
  reliability, database, route, and Torghut proof floor evidence.
- Add `continuity_witness_ledger` and `attested_dispatch_packets` to the status route in shadow mode.
- Extend source rollout truth environment handling so missing source or GitOps revision is visible as a typed
  attestation fault, not just a blocking string.
- Add restart/leader-transition tests that prove a fresh process-local watch window cannot reopen dispatch without a
  replay watermark.
- Add endpoint-gap tests using an empty EndpointSlice followed by recovery.

Deployer stage:

- Roll out shadow mode first.
- Confirm continuity epochs are produced for `agents` and `jangar`.
- Confirm `serve_readonly=allow` while `dispatch_normal`, `deploy_widen`, and `merge_ready` stay held when source
  revision or controller replay is missing.
- Promote enforcement only after two consecutive deploys show stable continuity packets and no false holds on bounded
  repair.

## Validation Gates

Local validation:

- `bunx oxfmt --check docs/agents/designs/170-jangar-continuity-witness-ledger-and-attested-dispatch-packets-2026-05-08.md docs/torghut/design-system/v6/174-torghut-continuity-priced-route-repair-market-and-capital-holds-2026-05-08.md docs/agents/README.md docs/torghut/design-system/v6/index.md`
- Targeted Jangar tests after implementation:
  - `bun test services/jangar/src/server/__tests__/control-plane-status.test.ts`
  - `bun test services/jangar/src/server/__tests__/control-plane-watch-reliability.test.ts`
  - `bun test services/jangar/src/server/__tests__/control-plane-source-rollout-truth-exchange.test.ts`
  - `bun test services/jangar/src/server/__tests__/control-plane-material-action-verdict.test.ts`

Cluster validation:

- `/ready.status` may be `ok` during a healthy serving state.
- `/api/agents/control-plane/status?namespace=agents` must expose a continuity epoch.
- A pod replacement must create a new epoch with a leader transition ref and either a replayed watch watermark or a
  `process_local_after_restart` hold.
- An empty EndpointSlice sample followed by recovery must leave an endpoint-gap witness until the next stable epoch.
- Dispatch, deploy widening, and merge readiness must remain held when `source_head_sha` or `gitops_revision` is
  missing.

Torghut validation:

- `/trading/health` can remain degraded without blocking Jangar serving.
- Paper/live capital packets stay zero-notional while Torghut proof floor is `repair_only`.
- Torghut route repair packets must cite the Jangar continuity epoch before any paper probe can move from candidate to
  admitted.

## Rollout

1. Ship the schema and status payload in shadow mode.
2. Backfill only current open epochs; do not rewrite old action receipts.
3. Add dashboards for continuity decision, endpoint gap seconds, source attestation status, watch replay status, and
   Torghut proof floor state.
4. After two stable deploy cycles, make `dispatch_normal`, `deploy_widen`, `merge_ready`, and Torghut capital packets
   require a fresh continuity epoch.
5. Keep `serve_readonly` independent so Jangar can continue answering status during repair.

## Rollback

- If epoch writes fail, disable ledger writes and leave existing material action verdicts in place.
- If shadow packets disagree with current verdicts, keep enforcement disabled and capture the disagreement as a
  continuity contradiction.
- If enforcement blocks legitimate repair, allow only `dispatch_repair` with zero external capital and a named witness
  repair target.
- If the status route regresses, revert the status payload addition while keeping the migration dormant.

## Risks

- The first implementation can over-hold dispatch if watch replay is too strict.
- A source/GitOps attestation gap can expose missing deployment metadata that has been implicit for months.
- Persisting every continuity sample can create table churn; implementation should write only material transitions and
  fresh epoch renewals.
- Torghut may need a short compatibility window while it learns to cite Jangar continuity epochs.

## Handoff To Engineer

Implement the ledger as a shadow-only producer first. The acceptance gate is not "status route has a new object"; it is
"a Jangar pod restart cannot produce an action-grade dispatch packet until source, controller, watch, route, and
database witnesses are reconciled after the restart."

## Handoff To Deployer

Do not widen rollout or merge enforcement until the shadow ledger has survived at least two Jangar pod replacements or
leader transitions without false promotion. If `/ready` is ok but continuity packets hold material actions, treat the
hold as authoritative.
