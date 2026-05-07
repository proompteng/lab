# 131. Jangar Cross-Plane Evidence Custody And Dispatch Escrow (2026-05-06)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-06
Owner: Victor Chen, Jangar Engineering
Scope: Jangar control-plane status, material action receipts, AgentRun ingestion custody, Torghut consumer evidence,
dispatch escrow, rollout widening, capital handoff, validation, and rollback.

Companion Torghut contract:

- `docs/torghut/design-system/v6/135-torghut-forecast-evidence-bonds-and-capital-reentry-escrow-2026-05-06.md`

Extends:

- `130-jangar-synthetic-readiness-settlement-and-evidence-probe-fuses-2026-05-06.md`
- `129-jangar-consumer-evidence-leases-and-readiness-decoupling-2026-05-06.md`
- `127-jangar-activation-inventory-ledger-and-product-gap-fuses-2026-05-06.md`
- `116-jangar-controller-witness-quorum-and-capital-activation-receipts-2026-05-06.md`

## Decision

I am selecting **cross-plane evidence custody with dispatch escrow** as the next Jangar control-plane architecture step.

The control plane is no longer in the broad outage shape from earlier May 5 evidence. At `2026-05-06T21:09Z`,
`deployment/jangar` and `deployment/agents-controllers` were successfully rolled out, Jangar `/health` returned
`status=ok`, `/ready` returned `status=ok`, controller heartbeats were fresh, watch reliability reported `5002`
AgentRun events, `0` watch errors, and one ToolRun stream restart, and the Jangar database projection was healthy with
`28` registered and applied Kysely migrations.

The remaining failure mode is more subtle and more dangerous. The same Jangar status payload reported
`agentrun_ingestion.status=unknown` with message `agents controller not started`, while the namespace degradation list
only called out `empirical:forecast`. Material receipts allowed `dispatch_normal`, `deploy_widen`, and `merge_ready`,
but held `paper_canary` and `live_micro_canary` because Torghut consumer evidence and forecast service proof were
missing. Torghut itself was degraded: `/readyz` returned `503`, Postgres and ClickHouse were healthy, schema was current
at `0029_whitepaper_embedding_dimension_4096`, empirical jobs were fresh, forecast registry was empty, market context
was stale across technicals, fundamentals, news, and regime, and quant ingestion lag was `12270` seconds.

That means Jangar has enough receipts to prevent capital spend, but not enough custody semantics to explain why normal
dispatch and rollout widening are safe while AgentRun ingestion is unknown and consumer evidence is missing. The design
adds an explicit custody layer between evidence producers and material action receipts. A controller heartbeat can prove
process liveness. It cannot silently clear missing ingestion custody for normal dispatch, deploy widening, or Torghut
capital. The tradeoff is more conservative action admission and a new receipt type. I accept that because the system is
now mature enough that the next reliability gain comes from unambiguous evidence ownership, not more status bits.

## Runtime Objective And Success Metrics

This contract increases Jangar reliability by making every material action carry a producer-owned and consumer-acknowledged
evidence inventory.

Success means:

- `agentrun_ingestion=unknown` is visible as custody debt even when controller heartbeats are fresh.
- Normal dispatch and deploy widening can only be bare `allow` when controller, watch, ingestion, and consumer evidence
  custody all agree.
- Repair dispatch can continue under escrow with bounded runtime, bounded concurrency, and zero capital authority.
- Torghut paper/live receipts require explicit forecast, quant, market-context, and proof-floor custody bonds.
- Jangar status exposes why an action is allowed, escrowed, held, or blocked without requiring privileged pod exec.
- Engineer and deployer stages can validate the contract through routes, read-only Kubernetes checks, and CI tests.

## Evidence Snapshot

All evidence was collected read-only. I did not mutate Kubernetes resources, database records, broker state, trading
flags, GitOps manifests, or ClickHouse data.

### Cluster And Rollout Evidence

- `deployment/jangar` rolled out successfully in namespace `jangar`.
- `deployment/agents-controllers` rolled out successfully in namespace `agents` with `2/2` replicas available.
- Jangar pods were running, including `jangar-54d5b66746-c28hw` with `2/2` containers ready.
- Torghut live `torghut-00244-deployment-556cc5c594-4kjls` and sim
  `torghut-sim-00344-deployment-68787fcc66-rmdp5` were running with both containers ready.
- Recent Jangar events showed one transient readiness failure during the new pod rollout.
- The `agents` namespace had active discover and verify AgentRuns plus many successful scheduled discover, plan,
  implement, and verify runs. Historical failures remained in the verify lanes.
- Direct Postgres inspection through `kubectl cnpg psql` was forbidden for both Jangar and Torghut because the service
  account cannot create `pods/exec`.

### Jangar Route Evidence

- `/health` returned `status=ok` with the local agents controller disabled in the serving process.
- `/ready` returned `status=ok`, fresh leader-election success, healthy execution trust, healthy runtime kits, and fresh
  admission passports.
- `/api/agents/control-plane/status` returned fresh controller heartbeats for `agents-controller`,
  `supporting-controller`, and `orchestration-controller`.
- The same status route reported `agentrun_ingestion.status=unknown`, message `agents controller not started`,
  `last_watch_event_at=null`, and `last_resync_at=null`.
- Watch reliability was healthy with `5002` total events, `0` errors, and one ToolRun stream restart.
- Namespace degradation listed only `empirical:forecast`, not AgentRun ingestion custody.
- Material action receipts allowed `dispatch_normal`, `deploy_widen`, and `merge_ready`; held `paper_canary` and
  `live_micro_canary`; and blocked `live_scale`.
- Jangar database projection was healthy: connected, `3ms` latency, `28` registered migrations, `28` applied migrations,
  and latest migration `20260505_torghut_quant_pipeline_health_window_index`.

### Torghut Route And Data Evidence

- Torghut `/healthz` returned `status=ok`.
- Torghut `/readyz` returned `status=degraded` with HTTP `503`.
- Torghut `/db-check` returned `ok=true`, `schema_current=true`, and current/expected Alembic head
  `0029_whitepaper_embedding_dimension_4096`.
- `/db-check` still reported parent fork warnings in the migration graph, even with lineage marked ready.
- Live submission remained closed: `allowed=false`, reason `simple_submit_disabled`, capital stage `shadow`, and
  `promotion_eligible_total=0`.
- Empirical jobs were fresh and promotion-authority eligible for
  `chip-paper-microbar-composite@execution-proof`.
- Forecast service was degraded: `configured=false`, `message=registry_empty`, no registry ref, and no promotion
  authority eligible models.
- Quant health for `PA3SX7FYNUTF`, window `15m`, was degraded: latest metrics were current, but ingestion lag was
  `12270` seconds and materialization was not healthy.
- Market context was degraded: technicals, fundamentals, news, and regime were stale; news freshness was about
  `4411976` seconds against a `300` second limit.

### Source Evidence

- `services/jangar/src/server/control-plane-status.ts` builds the negative evidence router, material verdict epoch, and
  activation receipts, then builds namespace degradation from selected component statuses.
- `services/jangar/src/server/control-plane-status.ts` includes AgentRun ingestion in degraded components only when its
  status is `degraded`; current live evidence is `unknown`.
- `services/jangar/src/server/control-plane-negative-evidence-router.ts` treats non-healthy AgentRun ingestion as
  negative evidence, but suppresses that negative evidence when the controller witness is `allow` or `allow_with_split`.
- `services/jangar/src/server/control-plane-controller-witness.ts` builds activation receipts from verdict decisions,
  positive evidence refs, negative evidence refs, and action SLO budgets.
- `services/jangar/src/server/control-plane-action-clock.ts` adds `forecast_service_degraded` as empirical debt for
  Torghut capital actions.
- `services/torghut/app/main.py` exposes forecast, LEAN, and empirical job status through `/trading/autonomy`.
- `services/torghut/app/trading/autonomy/gates.py` already makes forecast fallback, latency, and calibration part of
  Gate 3 shadow/paper quality. The missing contract is the cross-plane custody bond that lets Jangar consume that proof.

## Problem

Jangar now has the pieces of a safer control plane, but the pieces still disagree about custody.

The current failure modes are:

1. **Heartbeat dominance.** A fresh controller heartbeat can make the controller plane look healthy while AgentRun
   ingestion custody is unknown.
2. **Hidden unknowns.** `agentrun_ingestion=unknown` is not surfaced as namespace degradation today, so humans and
   automation can miss it.
3. **Ambiguous allow.** A material receipt can say `allow` for normal dispatch and deploy widening while carrying
   missing custody elsewhere in the same payload.
4. **Consumer evidence gap.** Torghut capital receipts correctly hold on `torghut_consumer_evidence_missing`, but the
   producer of that missing evidence is not assigned a durable bond.
5. **Least-privilege blind spot.** Routine validators cannot exec into database pods, so source-of-truth evidence must
   be route-projected and self-auditing.
6. **Repair priority drift.** Forecast registry, quant ingestion, market context, and AgentRun ingestion all need repair,
   but Jangar does not yet expose one activation inventory that ranks these debts by action impact.

## Alternatives Considered

### Option A: Keep Current Receipts And Treat The Gaps As Operational Notes

Pros:

- No new API or reducer work.
- Current receipts already hold paper/live capital.
- Normal dispatch remains fast.

Cons:

- Leaves `agentrun_ingestion=unknown` outside namespace degradation.
- Makes `allow` ambiguous when positive and negative custody evidence coexist.
- Gives Torghut no concrete producer contract for forecast and consumer evidence repair.

Decision: reject.

### Option B: Freeze Normal Dispatch Until Every Evidence Product Is Healthy

Pros:

- Simple safety rule.
- Prevents ambiguous normal dispatch and rollout widening.
- Easy to explain in incidents.

Cons:

- Stops useful zero-capital repair work.
- Couples Jangar dispatch to Torghut market data freshness too tightly.
- Creates backlog pressure during partial consumer outages.
- Does not distinguish missing producer custody from known degraded consumer evidence.

Decision: reject.

### Option C: Cross-Plane Evidence Custody With Dispatch Escrow

Pros:

- Preserves read-only serving and bounded repair dispatch.
- Makes every missing or stale evidence product producer-owned.
- Converts `allow` into `allow_with_escrow` when a required custody bond is missing but repair is safe.
- Gives Torghut a concrete bond format for forecast, quant, market-context, and proof-floor evidence.
- Keeps capital held until consumer evidence is fresh and acknowledged.

Cons:

- Adds one custody inventory reducer and one dispatch escrow receipt type.
- Requires UI and route changes so operators see escrow instead of a flat allow/hold result.
- Requires the engineer stage to tune which action classes need which bonds.

Decision: select Option C.

## Architecture

Jangar emits a cross-plane activation inventory per namespace and short evidence window.

```text
cross_plane_activation_inventory
  inventory_id
  generated_at
  namespace
  window_start
  window_end
  producer_revision
  controller_custody
  watch_custody
  ingestion_custody
  consumer_evidence_bonds
  action_class_custody
  unresolved_debts
  fresh_until
```

Each custody item is producer-owned and consumer-acknowledged.

```text
evidence_custody_item
  custody_id
  producer
  consumer
  evidence_kind          # controller_heartbeat, agentrun_ingestion, forecast_registry, quant_ingestion, market_context
  source_url
  source_ref
  status                 # pass, degraded, missing, unknown, stale
  observed_at
  freshness_seconds
  max_freshness_seconds
  reason_codes
  consumer_ack_at
  consumer_ack_status
```

Material actions consume inventory through dispatch escrow receipts.

```text
dispatch_escrow_receipt
  receipt_id
  action_class
  base_decision          # allow, repair_only, hold, block
  custody_decision       # allow, allow_with_escrow, repair_only, hold, block
  required_custody_ids
  missing_custody_ids
  escrow_runtime_seconds
  escrow_dispatches
  capital_ceiling
  required_repair_actions
  rollback_target
  fresh_until
```

Decision rules:

- `serve_readonly` requires process and runtime-kit custody; consumer evidence debt is visible but not fatal.
- `dispatch_repair` allows one bounded repair dispatch when controller heartbeats are fresh and no destructive
  failure-domain holdback exists.
- `dispatch_normal` is `allow_with_escrow`, not bare `allow`, when AgentRun ingestion custody is `unknown`.
- `deploy_widen` is `hold` when rollout ambiguity exists and `allow_with_escrow` when controller custody is fresh but
  ingestion custody is unknown.
- `merge_ready` can remain allowed for documentation-only PRs, but its receipt must show any custody debt and reason.
- `paper_canary`, `live_micro_canary`, and `live_scale` require Torghut forecast, quant, market-context, empirical, and
  proof-floor bonds; missing bonds hold or block capital.

## Engineer Handoff

Implement the custody layer in the Jangar control-plane route and UI without changing trading flags.

Required source scope:

- `services/jangar/src/server/control-plane-status.ts`
- `services/jangar/src/server/control-plane-negative-evidence-router.ts`
- `services/jangar/src/server/control-plane-controller-witness.ts`
- `services/jangar/src/server/control-plane-action-clock.ts`
- `services/jangar/src/data/agents-control-plane.ts`
- `services/jangar/src/components/agents-control-plane-status.tsx`
- tests under `services/jangar/src/server/__tests__/` and `services/jangar/src/components/__tests__/`

Acceptance gates:

- `agentrun_ingestion=unknown` appears as custody debt and namespace degradation unless a newer explicit ingestion
  custody item proves why it is safe to suppress.
- `dispatch_normal` and `deploy_widen` are not bare `allow` when required custody is missing.
- Every material action receipt has a non-null rollback target when positive and negative authority coexist.
- Torghut consumer evidence debt names a required producer bond instead of only saying
  `torghut_consumer_evidence_missing`.
- Unit tests cover heartbeat-fresh/ingestion-unknown, forecast-registry-empty, quant-ingestion-stale,
  market-context-stale, and doc-only merge cases.

## Deployer Handoff

Roll out behind a shadow-only feature flag first.

Validation commands:

- `kubectl rollout status -n jangar deployment/jangar --timeout=60s`
- `kubectl rollout status -n agents deployment/agents-controllers --timeout=60s`
- `curl -sS http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status | jq '.cross_plane_activation_inventory'`
- `curl -sS http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status | jq '.material_action_activation_receipts[] | {action_class, decision, required_repairs, rollback_target}'`
- `curl -sS http://torghut.torghut.svc.cluster.local/trading/autonomy | jq '.forecast_service'`

Widen only when:

- Inventory freshness is under `300` seconds.
- Controller heartbeat, watch, and AgentRun ingestion custody all pass or have an explicit repair escrow.
- No paper/live action is allowed without Torghut forecast, quant, market-context, empirical, and proof-floor bonds.
- Jangar status and NATS progress updates agree on the current hold/repair reason.

Rollback:

- Disable custody-enforced action admission and keep custody inventory in observe-only mode.
- Keep paper/live capital held while rolling back Jangar receipt interpretation.
- Revert to the previous material receipt reducer only after confirming `/ready`, `/health`, controller heartbeats, and
  AgentRun watch freshness.

## Risks

- Escrow may slow normal dispatch during transient ingestion unknown windows.
- Producers may overfit to route-level status and fail to publish durable source refs.
- Existing UI consumers may assume `decision=allow` is final; they must read custody decision and rollback target.
- Torghut forecast bonds need calibration thresholds before they can safely lift paper canaries.

## Validation For This Artifact

- Read-only Kubernetes checks confirmed Jangar and agents rollouts.
- Read-only Jangar routes confirmed health, readiness, controller heartbeats, watch reliability, database projection,
  AgentRun ingestion unknown, material action receipts, and empirical service debt.
- Read-only Torghut routes confirmed health/readiness split, DB schema head, empirical job freshness, forecast registry
  empty, quant ingestion lag, and stale market context.
- Documentation validation is `bunx oxfmt --check` on the changed markdown files.
