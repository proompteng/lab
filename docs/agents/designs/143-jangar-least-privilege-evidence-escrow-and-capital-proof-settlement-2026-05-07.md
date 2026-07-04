# 143. Jangar Least-Privilege Evidence Escrow And Capital Proof Settlement (2026-05-07)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-07
Owner: Victor Chen, Jangar Engineering
Scope: Jangar control-plane resilience, database/schema evidence, AgentRun ingestion authority, Torghut capital proof,
safe rollout, validation, and rollback.

Companion Torghut contract:

- `docs/torghut/design-system/v6/147-torghut-proof-escrow-hypothesis-repair-and-capital-settlement-2026-05-07.md`

Extends:

- `142-jangar-repair-dividend-handoff-gates-and-actuation-contracts-2026-05-07.md`
- `141-jangar-controller-witness-escrow-and-repair-dividend-settlement-2026-05-07.md`
- `135-jangar-database-witness-and-schema-authority-exchange-2026-05-07.md`
- `129-jangar-consumer-evidence-leases-and-readiness-decoupling-2026-05-06.md`

## Decision

I am selecting **least-privilege evidence escrow with capital proof settlement** as the next Jangar architecture
increment.

The current system is not failing in the obvious way. At `2026-05-07T11:23Z`, Jangar and the agents control-plane were
serving image `3c7e24de`; `deployment/agents` was `1/1`; `deployment/agents-controllers` was `2/2`;
`deployment/jangar` was `1/1`; `/ready` returned `status=ok`; execution trust was healthy; runtime kits were fresh;
watch reliability was healthy in the latest 15 minute window; and database projection reported `28` registered Kysely
migrations, `28` applied migrations, zero unapplied migrations, zero unexpected migrations, and `24` ms latency.

The risk is more structural. The same status route still projected `agentrun_ingestion.status=unknown` with message
`agents controller not started` even while controller heartbeat authority was healthy. Direct CNPG and database shell
reads were blocked by RBAC in both `jangar` and `torghut`, and CNPG cluster CR reads were forbidden. That is the correct
least-privilege posture for routine plan workers, but it means the control plane must publish database, schema,
freshness, and ingestion proof as first-class route evidence. Otherwise every serious rollout or capital decision
quietly falls back to privileged inspection, stale route fragments, or human judgement.

The decision is to make Jangar the escrow authority for route-readable evidence. Jangar will issue a short-lived
`control_plane_evidence_escrow` receipt that binds database projection, schema migration parity, controller heartbeat,
AgentRun ingestion witness, watch reliability, rollout digest, Torghut consumer proof, and direct-inspection access
gaps into one settlement object. Material actions and Torghut capital gates consume that receipt instead of treating
`/ready`, database health, watch health, and proof-floor state as independent facts.

The tradeoff is that Jangar will hold some material actions even when every deployment is available. I accept that.
Availability is now good enough that the next failure class is optimistic action on incomplete proof.

## Runtime Objective And Success Metrics

Success means:

- Jangar keeps `/ready` fast and green for serving process health while material action receipts consume evidence
  escrow.
- The escrow receipt is generated without pod exec, database shell, secret reads, or CNPG cluster reads.
- The receipt names every evidence surface, freshness window, source route, producer revision, observed digest, and
  access gap that influenced the decision.
- `agentrun_ingestion=unknown` becomes a first-class escrow debt even when controller heartbeat is healthy.
- Database proof includes connection health, latency, registered/applied migration counts, latest migration ID, and a
  stable schema-quality digest.
- Torghut capital gates require an escrow receipt whose Torghut consumer proof is current for account, window, and
  hypothesis scope.
- Rollout widening, merge readiness, paper canary, and live capital gates can cite one escrow decision instead of
  rehydrating Jangar and Torghut status by hand.
- Deployer rollback can disable enforcement while preserving shadow receipts for comparison.

## Evidence Snapshot

All evidence was collected read-only. I did not mutate Kubernetes resources, database rows, broker state, GitOps
resources, trading flags, AgentRun objects, empirical artifacts, or ClickHouse tables.

### Shared NATS Context

The latest shared NATS context from `2026-05-05T09:05Z` reported Jangar serving pods running, many historical failed
pods in `agents`, one controller replica stuck unready, schedule-runner failures from an older namespace expression,
Torghut sim image-pull trouble, source risk around schedule generation and PVC support, and data evidence showing
fresh Jangar rows but structurally empty Torghut promotion/autoresearch tables. I treated that as stale but useful
context and rechecked the current cluster, route, and source state before selecting this design.

### Cluster, Rollout, And Event Evidence

- `kubectl auth whoami` identified this runner as `system:serviceaccount:agents:agents-sa`.
- `kubectl config current-context` is unset in this workspace, but explicit namespace reads work through the service
  account.
- `deployment/agents` was available `1/1` on
  `registry.ide-newton.ts.net/lab/jangar-control-plane:3c7e24de@sha256:69242fa86f31d113f6d93d5a5b9e06847585582720c45a132af5b9af502748d9`.
- `deployment/agents-controllers` was available `2/2` on
  `registry.ide-newton.ts.net/lab/jangar:3c7e24de@sha256:8154e11e2ede8274f1b80a7161c146aa3aa6dc5be1a4d25d990d6f3dfe1e6213`.
- `deployment/jangar` in namespace `jangar` was available `1/1` on the same Jangar image digest.
- Current `agents` pod counts were `Completed=174`, `Error=61`, and `Running=7`; current job counts were
  `Complete=176`, `Failed=17`, and `Running=3`.
- Recent agents events showed normal rollout to `3c7e24de` plus readiness warnings on the previous agents and
  controller replicas during replacement.
- Jangar events showed normal image rollout plus startup readiness failures before `jangar-6b4447477b-6n5fd`
  recovered.
- Torghut live revision `torghut-00254` and sim revision `torghut-sim-00354` were available `1/1`; data-plane pods for
  Postgres, ClickHouse, Keeper, TA, sim TA, options services, websocket services, Alloy, and guardrail exporters were
  running.
- Torghut events still reported ambiguous ClickHouse PodDisruptionBudget matches and a Keeper PDB with no matching
  pods, so disruption policy remains a rollout-risk debt.

### Jangar Route And Database Evidence

- `GET http://agents.agents.svc.cluster.local/ready` returned `status=ok`.
- `/ready` reported leader election healthy with lease `jangar-controller-leader`, execution trust healthy, and fresh
  serving, swarm plan, swarm implement, and swarm verify admission passports.
- `GET /api/agents/control-plane/status?namespace=agents` returned
  `generated_at=2026-05-07T11:23:52.697Z`.
- Database projection was healthy: configured, connected, `latency_ms=24`, migration table `kysely_migration`,
  `registered_count=28`, `applied_count=28`, `unapplied_count=0`, `unexpected_count=0`, and latest registered/applied
  migration `20260505_torghut_quant_pipeline_health_window_index`.
- Watch reliability was healthy: `window_minutes=15`, `observed_streams=5`, `total_events=455`, `total_errors=0`, and
  `total_restarts=0`.
- Dependency quorum was `allow` with all segments healthy.
- Controller heartbeat authority was healthy for `agents-controller`, `supporting-controller`, and
  `orchestration-controller`, all sourced from `agents-controllers-644fcf9dd6-s9jls`.
- AgentRun ingestion was `unknown` with message `agents controller not started`, `last_watch_event_at=null`, and
  `last_resync_at=null`. This is the main split-brain evidence for the selected design.
- Negative evidence routing was in `observe` mode with positive refs for controller witness, database projection,
  rollout, runtime kits, and watch reliability. It still downgraded Torghut paper/live budgets because Torghut consumer
  evidence was missing.
- `kubectl cnpg psql -n jangar jangar-db -- -c 'select now();'` failed because the service account cannot create
  `pods/exec` in namespace `jangar`.
- `kubectl get cluster.postgresql.cnpg.io -n jangar jangar-db -o json` failed because the service account cannot get
  CNPG `clusters` in namespace `jangar`.

### Torghut Consumer Evidence

- `GET http://torghut.torghut.svc.cluster.local/trading/health` returned `status=degraded`.
- Postgres, ClickHouse, Alpaca, Jangar universe, readiness cache, empirical jobs, DSPy runtime, and quant evidence were
  individually reachable or informationally OK.
- Live submission was closed by `simple_submit_disabled`, `capital_stage=shadow`, and `promotion_eligible_total=0`.
- Proof floor was `repair_only`, `capital_state=zero_notional`, `max_notional=0`, with blockers
  `hypothesis_not_promotion_eligible`, `execution_tca_stale`, `market_context_stale`, and
  `simple_submit_disabled`.
- Quant latest metrics were available for account `PA3SX7FYNUTF`, window `15m`, with `144` latest metrics, empty-store
  alarm false, missing-update alarm false, and low route lag, but pipeline stages were missing.
- Torghut hypotheses were loaded: `3` total, `1` blocked, `2` shadow, `0` promotion eligible, and `3` rollback
  required.
- `H-CONT-01` and `H-REV-01` were shadow-only; `H-MICRO-01` was blocked. All carried stale signal/TCA evidence, and
  `H-MICRO-01` also lacked feature rows and drift checks.
- TCA had `13,775` orders but was last computed at `2026-04-02T20:59:45.136640Z`; average absolute slippage was about
  `568.61` bps against an `8` bps guardrail.
- Direct Torghut DB and CNPG reads failed with the same least-privilege boundary: no `pods/exec` and no CNPG cluster
  get permission.

### Source Evidence

- `services/jangar/src/server/control-plane-status.ts` is the aggregation boundary for database status, controllers,
  runtime adapters, execution trust, watch reliability, negative evidence, and Torghut action SLO budgets.
- `services/jangar/src/server/control-plane-negative-evidence-router.ts` maps AgentRun ingestion, Torghut consumer
  evidence, market context, quant alerts, and runtime status to action consequences.
- `services/jangar/src/server/control-plane-watch-reliability.ts` is compact and suitable as an escrow input.
- `services/jangar/src/server/agents-controller/index.ts` is `1,827` lines and owns ingestion assessment behavior.
- `services/jangar/src/server/supporting-primitives-controller.ts` is `3,301` lines and owns schedules, runners,
  workspaces, PVC lifecycle, swarms, freezes, requirements, and dispatch. Escrow logic should not be added there.
- `services/jangar/src/server/primitives-kube.ts` has first-class PVC aliases, so the older PVC blind spot is closed.
- Focused tests already cover control-plane status, negative evidence routing, material action verdicts, watch
  reliability, controller witness, AgentRun ingestion degradation, and primitive Kubernetes resources. The missing
  fixture is an end-to-end escrow reducer that proves route-readable evidence is sufficient when direct inspection is
  forbidden.

## Problem

Jangar has enough route and controller evidence to serve safely, but it does not yet package that evidence as a
least-privilege settlement artifact for material actions and Torghut capital decisions.

The current failure modes are:

1. **Healthy availability can hide proof gaps.** `/ready`, database projection, watch reliability, and deployments can
   all be green while AgentRun ingestion is still unknown.
2. **Privileged database access is not a runtime contract.** Normal agents cannot rely on CNPG, pod exec, or secret
   reads to confirm database and schema state.
3. **Database proof is under-specified for consumers.** Jangar reports migration parity, but there is no stable
   schema-quality digest or fresh-until bound that consumers can cite.
4. **Torghut evidence enters Jangar as a downgrade, not as a settled escrow member.** Capital gates need account,
   window, and hypothesis scope.
5. **Large controllers are the wrong place for this logic.** The escrow reducer must sit beside the status reducer and
   consume existing facts, not expand `supporting-primitives-controller.ts`.

## Alternatives Considered

### Option A: Treat Current `/ready` And Status Fields As Sufficient

Pros:

- Minimal implementation work.
- Uses already deployed status and readiness routes.
- Keeps clients flexible.

Cons:

- Clients must reimplement the same proof interpretation.
- AgentRun ingestion can stay unknown while unrelated green fields dominate attention.
- Does not solve the RBAC gap for database/schema proof.

Decision: reject.

### Option B: Grant Plan/Verify Workers Read-Only Database And CNPG Permissions

Pros:

- Fast direct evidence for schema and table quality.
- Easier ad hoc debugging during incidents.
- Avoids a new status object.

Cons:

- Expands blast radius for routine automation.
- Makes capital and rollout gates depend on privileged side channels.
- Still does not create a durable receipt that Torghut or deployer workflows can consume.

Decision: reject.

### Option C: Least-Privilege Evidence Escrow And Capital Proof Settlement

Pros:

- Fits the current RBAC model.
- Converts route-readable evidence into one short-lived settlement receipt.
- Makes ingestion unknown, database/schema parity, rollout digest, watch reliability, and Torghut proof explicit.
- Gives engineer, deployer, and Torghut one object to validate and replay.
- Keeps enforcement reversible through shadow mode.

Cons:

- Adds a reducer and status payload.
- Requires careful freshness and digest semantics.
- May hold material actions while route availability looks green.

Decision: select Option C.

## Architecture

Jangar emits one escrow receipt per namespace and status window.

```text
control_plane_evidence_escrow
  escrow_id
  namespace
  generated_at
  fresh_until
  producer_revision
  enforcement_mode              # shadow | enforce
  database_projection_member
  schema_quality_member
  controller_heartbeat_member
  agentrun_ingestion_member
  watch_reliability_member
  rollout_digest_member
  torghut_consumer_members[]
  direct_inspection_gaps[]
  material_action_settlements[]
```

Each member has the same decision vocabulary.

```text
evidence_escrow_member
  member_id
  source_route
  source_ref
  observed_at
  fresh_until
  decision                     # accept | degrade | hold | block | unknown
  reason_codes[]
  required_for_actions[]
  digest
```

The first implementation should synthesize escrow from existing status facts:

- Database projection member from `database.status` and `database.migration_consistency`.
- Schema quality member from registered/applied migration IDs and source migration count.
- Controller heartbeat member from `controllers[].authority`.
- AgentRun ingestion member from `agentrun_ingestion`.
- Watch reliability member from `watch_reliability`.
- Rollout digest member from current image/digest status already used by rollout health.
- Torghut consumer member from Torghut action SLO budgets and route-backed proof-floor/quant evidence.
- Direct inspection gaps from blocked CNPG, pod exec, ClickHouse shell, or secret reads when those checks are attempted
  by a least-privilege verifier.

Material action settlement consumes the worst required member.

```text
material_action_settlement
  action_class                 # serve_readonly | dispatch_repair | dispatch_normal | deploy_widen | merge_ready |
                               # paper_canary | live_micro_canary | live_scale
  decision                     # allow | bounded | shadow_only | hold | block
  required_member_ids[]
  blocking_member_ids[]
  fresh_until
  rollback_target
```

## Implementation Scope

Engineer lane:

1. Add `services/jangar/src/server/control-plane-evidence-escrow.ts`.
2. Add types to `control-plane-status-types.ts` and project `evidence_escrow` from `control-plane-status.ts`.
3. Keep `/ready` process-focused; do not make `/ready` perform database or Torghut proof work.
4. Add fixture tests for:
   - database and watch healthy, AgentRun ingestion unknown, Torghut missing: serve allowed, repair bounded,
     normal/merge/paper held, live blocked;
   - all escrow members accepted: dispatch and paper can graduate in shadow;
   - direct database access forbidden: escrow records the gap and still uses route projection;
   - schema mismatch: material actions above read-only are held.
5. Keep escrow reducer out of `supporting-primitives-controller.ts`.

Deployer lane:

1. Roll out with `evidence_escrow.enforcement_mode=shadow`.
2. Compare escrow decisions against current material action receipts for at least one full schedule interval.
3. Require `agentrun_ingestion` not `unknown` before enforcing merge-ready or deploy-widen.
4. Require a Torghut consumer member for account/window/hypothesis before paper or live capital gates.
5. Enforce only after shadow receipts are stable and all current CI checks pass.

## Validation Gates

Local:

- `bunx vitest run --config services/jangar/vitest.config.ts services/jangar/src/server/__tests__/control-plane-status.test.ts services/jangar/src/server/__tests__/control-plane-negative-evidence-router.test.ts`
- `bunx oxfmt --check services/jangar/src/server/control-plane-evidence-escrow.ts services/jangar/src/server/control-plane-status.ts services/jangar/src/server/control-plane-status-types.ts`
- `bunx oxlint --config .oxlintrc.json services/jangar/src/server/control-plane-evidence-escrow.ts services/jangar/src/server/control-plane-status.ts services/jangar/src/server/control-plane-status-types.ts`

Cluster:

- `curl -fsS http://agents.agents.svc.cluster.local/ready | jq .status`
- `curl -fsS 'http://agents.agents.svc.cluster.local/api/agents/control-plane/status?namespace=agents' | jq '.evidence_escrow'`
- Confirm `evidence_escrow.direct_inspection_gaps` records forbidden DB/CNPG checks when verifier evidence is present.
- Confirm action settlements do not allow merge-ready, paper, or live if AgentRun ingestion is unknown or Torghut proof
  is missing.

Torghut:

- `curl -fsS http://torghut.torghut.svc.cluster.local/trading/status | jq '.hypotheses.summary'`
- `curl -fsS http://torghut.torghut.svc.cluster.local/trading/health | jq '.proof_floor'`
- Confirm paper/live gates cite one fresh Jangar escrow ref and one Torghut settlement ref.

## Rollout

1. Ship route types and reducer in shadow mode.
2. Display escrow summary in the existing control-plane status UI after the route shape is stable.
3. Add deployer verification to capture the escrow receipt during rollout validation.
4. Turn on material action enforcement for `merge_ready` and `deploy_widen`.
5. Only after Torghut consumes account/window/hypothesis escrow should paper canary enforcement be enabled.

## Rollback

- Set enforcement back to `shadow`.
- Keep `/ready`, database projection, watch reliability, and negative evidence routing unchanged.
- Preserve shadow receipts for postmortem comparison.
- If escrow computation becomes expensive, disable Torghut consumer member fetches first and keep local Jangar members.
- If status payload growth affects UI or route latency, serve a compact summary at status root and move member detail to
  an expandable sub-route.

## Risks And Open Questions

- Escrow freshness can become too strict during closed market windows. The Torghut contract must carry market-window
  semantics rather than treating every closed-session stale signal as a production outage.
- AgentRun ingestion currently reports `unknown` despite healthy controller heartbeat. The engineer lane must decide
  whether this is a source bug, an initialization race, or a legitimate missing witness.
- Schema-quality digest needs a stable definition. I would start with migration registry/applied IDs and later add table
  row freshness if Jangar exposes route-safe table summaries.
- Torghut consumer proof may be expensive if every status request fetches all accounts/windows. The first cut should be
  account/window scoped and cached.

## Handoff Contract

Engineer accepts this work when:

- `evidence_escrow` is visible on `/api/agents/control-plane/status?namespace=agents`.
- Unit tests cover the healthy availability plus ingestion-unknown split.
- The reducer records RBAC access gaps without requiring privileged access.
- Material action decisions cite escrow member IDs.

Deployer accepts this work when:

- Shadow receipts are captured before and after rollout.
- Enforcement stays off until shadow receipts match current material action posture.
- Rollback is a config change, not a database migration.
- Torghut paper/live gates remain zero-notional unless the companion Torghut settlement is current and Jangar escrow is
  fresh.
