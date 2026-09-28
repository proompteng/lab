# 172. Jangar Revision Carry Ledger And Source-To-Serving Action Bonds (2026-05-08)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-08
Owner: Victor Chen, Jangar Engineering Architecture
Scope: Jangar source-to-image convergence, rollout churn, controller handoff, schedule-runner image carry, material
action gates, deployer custody, rollback, and Torghut capital handoff.

Companion Torghut contract:

- `docs/torghut/design-system/v6/176-torghut-revision-priced-route-frontier-and-capital-carry-2026-05-08.md`

Extends:

- `171-jangar-terminal-debt-exchange-and-retry-custody-2026-05-08.md`
- `170-jangar-continuity-witness-ledger-and-attested-dispatch-packets-2026-05-08.md`
- `168-jangar-source-heartbeat-witness-settlement-and-material-action-bonds-2026-05-07.md`
- `148-jangar-source-rollout-truth-exchange-and-proof-floor-settlement-2026-05-07.md`
- `docs/torghut/design-system/v6/175-torghut-failure-costed-context-repair-and-route-custody-2026-05-08.md`

## Decision

I am selecting a **revision carry ledger with source-to-serving action bonds** as the next Jangar control-plane
architecture step.

The current control plane is serving, but it is not yet action-authoritative. On 2026-05-08 at 01:09Z, Jangar `/ready`
returned `status=ok`, leader election was healthy on pod `jangar-6745697cbc-cc5zs`, the Agents deployments were
available, execution trust was healthy, watch reliability observed 1098 events with 0 errors in a 15 minute window,
and the Jangar database reported 28 registered and 28 applied Kysely migrations. Those are good serving facts.

The same sample showed the authority gap. `source_rollout_truth_exchange.source_head_sha` and `gitops_revision` were
both null. Material actions for `dispatch_repair`, `dispatch_normal`, `deploy_widen`, and `merge_ready` were held
because source or GitOps revision evidence was missing, AgentRun ingestion remained repair-only, and controller
witnesses were split. The desired Jangar runtime image had converged to `093b1f79`, but active live pods still included
at least one Torghut runner on the prior `ef2bba88` digest. Kubernetes events showed multiple Jangar and Agents rollout
handoffs in the last hour, with readiness/liveness probe failures and one Jangar scheduling delay before the current
pod became ready.

The decision is to make revision carry explicit. Every rollout-adjacent action must name the source commit, GitOps
revision, desired image digest, live pod digests, controller witness, watch epoch, migration witness, terminal debt
state, and consumer proof floor that are being carried forward. Serving and observe-only repair can continue under a
fresh serving epoch. Dispatch, deploy widening, merge readiness, and Torghut paper/live capital need a revision carry
epoch that proves the new image is not spending authority from an unacknowledged old image, an in-flight runner, or a
missing source ref.

The tradeoff is stricter action gating after rapid promotions. I accept that. The six-month failure mode is not a
single healthy pod. It is a control plane that rolls forward quickly, lets dashboards recover, and then spends evidence
whose source, runner image, controller heartbeat, and consumer proof floor do not belong to the same revision epoch.

## Success Metrics

Success means:

- Jangar emits `revision_carry_ledger` in shadow mode beside source rollout truth and material action verdicts.
- Each revision carry epoch records `epoch_id`, `producer_revision`, `source_head_sha`, `gitops_revision`,
  `desired_image_refs`, `live_image_refs`, `runner_image_refs`, `controller_witness_ref`, `watch_epoch_ref`,
  `migration_witness_ref`, `terminal_debt_refs`, `consumer_floor_refs`, `carry_state`, and `fresh_until`.
- Missing source or GitOps refs force the epoch to `repair_only` even when desired and live image digests match.
- Active runners on a previous digest are recorded as carry debt until they complete, fail with a terminal debt note,
  or are explicitly excluded from material authority.
- Rollout readiness/liveness probe failures and scheduling delays create carry debits until a continuity epoch and
  controller witness both settle after the last transition.
- `serve_readonly` and `torghut_observe` can remain allowed from a fresh serving epoch.
- `dispatch_repair`, `dispatch_normal`, `deploy_widen`, `merge_ready`, `paper_canary`, `live_micro_canary`, and
  `live_scale` cannot upgrade using `/ready`, rollout health, or desired/live digest convergence alone.
- Engineer and deployer handoffs include concrete acceptance gates, rollout phases, rollback targets, and consumer
  contracts.

## Evidence Snapshot

All evidence in this pass was collected read-only. I did not mutate Kubernetes resources or database records.

### Cluster And Rollout Evidence

- Branch: `codex/swarm-jangar-control-plane-discover`, based on `main` at `7a7373368`.
- `kubectl config current-context` was unset in the workspace, while `kubectl auth whoami` verified
  `system:serviceaccount:agents:agents-sa`.
- Jangar namespace deployments `bumba`, `jangar`, `jangar-alloy`, `symphony`, and `symphony-jangar` were available.
- `deployment/jangar` was available on image `registry.ide-newton.ts.net/lab/jangar:093b1f79` through pod
  `jangar-6745697cbc-cc5zs`, with ready service endpoints on port 8080.
- Jangar events in the sampled hour showed rollout steps through `694d583e`, `ef2bba88`, and `093b1f79`; readiness
  probe failures during startup; pod deletion for older replicas; and a temporary scheduling failure before the
  current pod attached its volume and became ready.
- Agents namespace deployments `agents`, `agents-alloy`, and `agents-controllers` were available. The controllers
  were on `093b1f79` with two replicas, but recent events recorded readiness and liveness probe failures during the
  rollout.
- Swarms `jangar-control-plane` and `torghut-quant` were `Active`, `lights-out`, and `Ready=True`.
- The four Jangar control-plane cron schedules had current completions on `093b1f79`, but old cron jobs from the
  prior failure window remained failed at roughly 20 to 21 hours old.
- Torghut live revision `torghut-00291` and sim revision `torghut-sim-00390` were available, while older Knative
  revision deployments remained scaled to zero.

### Source Evidence

- `services/jangar/src/server/control-plane-status.ts` is 787 lines and joins database health, rollout health, watch
  reliability, runtime admission, source rollout truth, negative evidence, controller witness, material action
  verdicts, route stability, and namespace summaries.
- `services/jangar/src/server/control-plane-source-rollout-truth-exchange.ts` is 632 lines and already computes source
  head, GitOps revision, desired runtime images, live pod images, Torghut proof floor refs, and action receipts.
- That reducer already emits `source_rollout_truth_missing:source_or_gitops_revision`, `desired_live_image_mismatch`,
  and rollback targets, but it does not price carry debt from active runners on old images.
- `services/jangar/src/server/control-plane-controller-witness.ts` is 448 lines and distinguishes controller process,
  deployment, watch epoch, and AgentRun ingestion witnesses.
- `services/jangar/src/server/control-plane-material-action-verdict.ts` is 528 lines and already keeps material
  actions held or blocked when source rollout truth, controller witness, or Torghut consumer evidence is missing.
- `services/jangar/src/server/control-plane-watch-reliability.ts` is 181 lines and still reports a current in-process
  window. Revision carry must consume it as a witness, not treat it as cross-revision continuity by itself.
- `services/jangar/src/server/control-plane-runtime-proof-surface.ts` is 396 lines and provides runtime proof cells
  that can supply required helper and binary evidence for schedule launch.
- Tests cover control-plane status, source rollout truth, controller witness, material action verdicts, action clocks,
  runtime proof, watch reliability degradation, route stability, and market-context provider behavior. The missing test
  surface is a reducer that proves old runner images, missing source refs, and post-rollout probe failures keep
  material authority in repair-only even after the latest deployment is healthy.

### Database And Data Evidence

- Jangar status reported `database.configured=true`, `database.connected=true`, `database.status=healthy`, and
  `latency_ms=10`.
- Jangar migration consistency was healthy with `registered_count=28`, `applied_count=28`, `unapplied_count=0`,
  `unexpected_count=0`, and latest migration `20260505_torghut_quant_pipeline_health_window_index`.
- Direct CNPG database reads remain outside the service account's normal least-privilege surface, so database evidence
  for this architecture pass came from application health and schema projection endpoints.
- Torghut `/db-check` returned `ok=true` with Alembic head `0029_whitepaper_embedding_dimension_4096`; lineage
  warnings remained for known parent forks after revisions `0010_execution_provenance_and_governance_trace` and
  `0015_whitepaper_workflow_tables`.
- Torghut `/readyz` returned HTTP 503 degraded. The proof floor was `repair_only`, capital state was `zero_notional`,
  and blockers included `hypothesis_not_promotion_eligible`, `execution_tca_route_universe_incomplete`, and
  `simple_submit_disabled`.
- Torghut route reacquisition had 8 scoped symbols, 1 probing symbol, 4 blocked symbols, and 3 missing symbols. Recent
  market-context jobs showed mixed outcomes: old `INTC` and `AMZN` provider jobs failed, while fresh `INTC`, `AMZN`,
  and `AMD` context jobs completed on the current Jangar image.

## Problem

Jangar has the right ingredients, but the authority boundary is still too local to the latest surface. A rollout can
make `/ready`, deployment health, watch reliability, and desired/live digest convergence look good while the source
revision remains unknown, some runners are still using an older digest, and downstream Torghut capital proof remains
repair-only.

That creates five concrete failure modes:

1. A new Jangar pod inherits action authority from status windows produced after startup, not from the source and
   GitOps revision that produced the image.
2. Active runners on old image digests can keep generating evidence after the deployer believes the latest image is the
   only producer.
3. A rollout handoff readiness failure can disappear behind the final ready endpoint state before material actions
   price the handoff.
4. AgentRun ingestion can remain repair-only while other controller witnesses are healthy, creating split authority.
5. Torghut can consume fresh route or market-context evidence without knowing whether the evidence belongs to a
   source-settled Jangar revision.

The control plane needs to carry revision debt as an explicit budget, not infer it from independent green checks.

## Alternatives Considered

### Option A: Keep Source Rollout Truth As The Only Source Gate

Continue using source rollout truth receipts and material action verdicts as the action boundary.

Advantages:

- Minimal new implementation.
- Reuses current desired/live image and GitOps/source checks.
- The existing reducer is already wired into status and action verdicts.

Disadvantages:

- Does not distinguish a current deployment from older in-flight runners.
- Does not attach rollout handoff probe failures to a revision budget.
- Does not tell Torghut which Jangar revision produced a proof receipt.

Decision: keep source rollout truth, but do not make it the complete carry authority.

### Option B: Fixed Cooldown After Every Rollout

Hold dispatch, deploy widening, merge readiness, and Torghut paper/live capital for a fixed wall-clock period after
every Jangar or Agents rollout.

Advantages:

- Easy to reason about during incidents.
- Requires no new persisted schema.
- Reduces immediate post-rollout action risk.

Disadvantages:

- Blocks useful repair even when all evidence is already settled.
- Allows action after the timer even if source refs or old runner evidence are still missing.
- Uses time as a proxy for proof.

Decision: use fixed cooldown only as a fallback policy when revision carry cannot be computed.

### Option C: Revision Carry Ledger With Action Bonds

Persist a revision carry epoch and require material action bonds to cite it. The epoch joins source refs, GitOps refs,
desired images, live images, runner images, controller witnesses, watch epochs, migrations, terminal debt, and Torghut
proof floors.

Advantages:

- Converts rollout churn into auditable action authority.
- Lets serving stay available while material actions remain proof-bound.
- Prevents old runners from silently carrying stale authority into a new image epoch.
- Gives deployers and Torghut one reference for deciding whether evidence is source-settled.

Disadvantages:

- Requires a new reducer, status projection, and probably a Kysely table once shadow behavior is proven.
- Adds more explicit holds while source/GitOps metadata is missing.
- Requires CI tests that model active old runners, source ref absence, and rollout probe debits.

Decision: select Option C.

## Architecture

Jangar adds a shadow `revision_carry_ledger`. It is initially an in-memory/status projection backed by the existing
status inputs. After the reducer proves useful, it graduates to a durable table.

```text
revision_carry_epoch
  schema_version
  epoch_id
  producer_revision
  produced_at
  namespace
  source_head_sha
  gitops_revision
  desired_image_refs
  live_image_refs
  runner_image_refs
  rollout_generation_refs
  controller_witness_ref
  watch_epoch_ref
  migration_witness_ref
  terminal_debt_refs
  consumer_floor_refs
  carry_state                    # observe_only | repair_only | material_ready | capital_ready
  carry_debits
  fresh_until
  rollback_target
```

Each material action consumes an action bond:

```text
revision_action_bond
  action_class
  required_carry_state
  revision_carry_epoch_ref
  max_epoch_age_seconds
  accepted_image_digests
  blocked_image_digests
  controller_witness_ref
  terminal_debt_policy
  consumer_floor_policy
  decision
  reason_codes
  rollback_target
```

Carry state rules:

- `observe_only`: route and database are healthy, but source/GitOps refs, controller ingestion, terminal debt, or
  consumer floors are not settled.
- `repair_only`: source or controller authority is incomplete, but bounded zero-notional repair is useful and
  evidence-preserving.
- `material_ready`: source and GitOps refs are present, desired and live digests agree, old runner debt is settled,
  controller ingestion is current, and terminal debt is acknowledged.
- `capital_ready`: `material_ready` plus Torghut proof floor is no worse than paper-ready, paper settlement is current,
  and live submission is intentionally enabled.

The ledger does not replace source rollout truth, controller witness, or material action verdicts. It is the compact
epoch they all cite when deciding whether action authority belongs to the same revision.

## Implementation Scope

Engineer stage:

- Implement `control-plane-revision-carry-ledger.ts` with pure reducer inputs from source rollout truth, rollout health,
  controller witness, watch reliability, runtime proof cells, terminal debt, and Torghut proof floor.
- Add the projection to `/api/agents/control-plane/status?namespace=agents` behind a shadow feature flag.
- Add tests for missing source/GitOps refs, desired/live image convergence with an old active runner, rollout probe
  debit carry, controller ingestion repair-only, and Torghut proof-floor zero-notional carry.
- Add a migration only after the shadow reducer proves stable; the first implementation can be status-only.

Deployer stage:

- Verify after rollout that the latest Jangar, Agents, and schedule-runner images all cite the same digest set or are
  explicitly recorded as carry debt.
- Keep `serve_readonly` and `torghut_observe` available when route, database, and watch witnesses are healthy.
- Do not widen deployment, dispatch normal work, mark merge readiness, or unlock Torghut paper/live capital until
  `revision_carry_epoch.carry_state` reaches the action's required state.

## Validation Gates

Required local validation:

- `bunx oxfmt --check docs/agents/designs/172-jangar-revision-carry-ledger-and-source-to-serving-action-bonds-2026-05-08.md docs/torghut/design-system/v6/176-torghut-revision-priced-route-frontier-and-capital-carry-2026-05-08.md docs/torghut/design-system/v6/index.md`

Required engineer validation:

- Unit tests prove missing source/GitOps refs hold all material and capital actions.
- Unit tests prove a live old runner digest creates carry debt even if desired and primary live images match.
- Unit tests prove rollout readiness/liveness failures create debits until a post-transition continuity epoch settles.
- Status route tests prove `serve_readonly` remains allowed when carry state is only `observe_only`.
- Torghut consumer tests prove capital cannot consume proof receipts without a `revision_carry_epoch_ref`.

Required deployer validation:

- After a rollout, capture Jangar `/ready`, control-plane status, deployment image digests, and current runner digests.
- Confirm `source_head_sha` and `gitops_revision` are non-null before material action widening.
- Confirm no active old-digest runner is unacknowledged before merge-ready or deploy-widen actions.
- Confirm Torghut proof floor remains zero-notional until capital-ready carry exists.

## Rollout Plan

1. Ship the reducer in shadow mode with no action behavior change.
2. Surface carry state and carry debits in control-plane status.
3. Add deployer checks that read the shadow ledger after each Jangar and Agents rollout.
4. Move `deploy_widen` and `merge_ready` to require `material_ready` carry.
5. Move `dispatch_normal` to require `material_ready`; keep `dispatch_repair` at `repair_only` with zero notional.
6. Move Torghut `paper_canary`, `live_micro_canary`, and `live_scale` to require `capital_ready`.

## Rollback

- Disable revision carry enforcement and leave the shadow projection visible for diagnosis.
- Return material action verdicts to current source rollout truth, controller witness, and action-clock behavior.
- Keep source/GitOps missing refs as hard holds until an explicit operator review says the fallback is intentional.
- For Torghut, keep capital at zero notional and consume existing proof-floor blockers.

## Risks

- Source and GitOps revision refs may remain absent for longer than expected. That is a product integration gap, not a
  reason to bypass the ledger.
- Old runner detection can be noisy in busy swarm windows. The reducer should classify old images by action impact so
  harmless completed pods do not block material authority.
- Deployer workflows may initially see more holds. The benefit is that every hold names the exact revision debt that
  must be settled.

## Handoff To Engineer And Deployer

Engineer acceptance gate: implement a shadow revision carry reducer with tests for source-ref absence, old runner debt,
rollout handoff debit, controller ingestion split, and Torghut zero-notional carry.

Deployer acceptance gate: after rollout, do not widen, dispatch normal work, mark merge readiness, or unlock Torghut
capital unless the action cites a fresh revision carry epoch at the required state.

Rollback gate: if the ledger blocks unexpectedly, disable enforcement only, keep projection enabled, and preserve the
blocking epoch for analysis.
