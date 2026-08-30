# 168. Jangar Source Heartbeat Witness Settlement And Material Action Bonds (2026-05-07)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-07
Owner: Gideon Park, Torghut Traders Architecture
Scope: Jangar material-action admission, source rollout truth, controller heartbeats, AgentRun ingestion, Torghut
capital handoff, validation, rollout, rollback, and failure-mode reduction.

Companion Torghut contract:

- `docs/torghut/design-system/v6/172-torghut-repair-yield-ledger-and-session-proof-capital-gates-2026-05-07.md`

Extends:

- `167-jangar-terminal-evidence-half-life-and-debris-retirement-2026-05-07.md`
- `166-jangar-repair-cadence-ledger-and-capital-surface-admission-2026-05-07.md`
- `148-jangar-source-rollout-truth-exchange-and-proof-floor-settlement-2026-05-07.md`
- `docs/torghut/design-system/v6/171-torghut-profit-evidence-half-life-and-capital-carry-governor-2026-05-07.md`

## Decision

I am selecting a source-heartbeat witness settlement layer with material-action bonds as the next Jangar architecture
step.

The control plane is healthier than the original discover soak. Jangar, Agents, and Agents controllers are ready.
Jangar status reports healthy database connectivity, migration consistency, rollout health, watch reliability,
execution trust, runtime kits, and workflow/job runtime adapters. The NATS runtime-kit gap from the earlier soak is
closed. Direct Jangar SQL confirms fresh component heartbeats from `agents-controllers-5476c9bf9-zbk9g`, fresh
`resources_current`, and four healthy component heartbeat rows.

The remaining failure mode is sharper: the same status payload allows `serve_readonly` and `torghut_observe`, but
holds `dispatch_repair`, `dispatch_normal`, `deploy_widen`, `merge_ready`, `paper_canary`, `live_micro_canary`, and
`live_scale`. The reasons are not generic unavailability. They are witness settlement gaps:
`source_rollout_truth_missing:source_or_gitops_revision`, `controller_heartbeat_not_current`, and an
`agentrun_ingestion` state that can still read as unknown while controller heartbeats are fresh. That is exactly the
kind of cross-surface disagreement that leads to unsafe retries if consumers only read the green parts.

Jangar should emit a `source_heartbeat_witness_settlement` and bind every material action to a
`material_action_bond`. The bond does not replace the final verdict. It explains whether the final verdict is backed
by converged source, rollout, heartbeat, ingestion, and consumer evidence, and it names the smallest missing witness
when the answer is hold. A green rollout remains evidence. It is not enough to widen dispatch or Torghut capital until
the bond settles.

The tradeoff is that some actions remain held after the cluster looks healthy. I accept that. For the next six months,
the control plane needs fewer ambiguous action widens and more precise proof of why a held action can safely move.

## Runtime Objective And Success Metrics

Success means:

- `/api/agents/control-plane/status?namespace=agents` exposes `source_heartbeat_witness_settlement`.
- Every material action verdict includes one `material_action_bond_id`.
- Bonds cover `serve_readonly`, `dispatch_repair`, `dispatch_normal`, `deploy_widen`, `merge_ready`,
  `torghut_observe`, `paper_canary`, `live_micro_canary`, and `live_scale`.
- `serve_readonly` and `torghut_observe` can stay allowed when current rollout, database, route handling, and runtime
  kits are healthy.
- `dispatch_repair` requires source or GitOps revision truth, a fresh controller heartbeat, settled AgentRun ingestion,
  and an explicit repair target.
- `dispatch_normal`, `deploy_widen`, and `merge_ready` require the same witness set plus no high-carry terminal debris
  without a retirement snapshot.
- `paper_canary`, `live_micro_canary`, and `live_scale` require a settled Torghut consumer-evidence bond from the
  companion repair-yield ledger.
- Any disagreement between rollout health, heartbeat authority, source truth, AgentRun ingestion, and material verdicts
  appears as a finite `witness_variance_code`, not as free-form text.
- A deployer can block a rollout with one bond ID, one missing witness, one next repair action, and one rollback target.

## Evidence Snapshot

Evidence was collected read-only on 2026-05-07 between 23:08Z and 23:17Z. I did not mutate Kubernetes resources,
database records, secrets, AgentRuns, GitOps resources, broker state, Torghut flags, or trading data.

### Cluster Evidence

- Branch: `codex/swarm-torghut-quant-discover`, based on `main` at
  `250e2e1fd chore(torghut): promote image 476f73d0 (#5982)`.
- `kubectl config current-context` was unset, but explicit namespace reads and `kubectl auth whoami` worked as
  `system:serviceaccount:agents:agents-sa`.
- Jangar namespace was serving: `jangar`, `bumba`, `jangar-alloy`, `jangar-db`, `open-webui`, `symphony`, and
  `symphony-jangar` were running.
- Agents namespace had `agents=1/1`, `agents-controllers=2/2`, and `agents-alloy=1/1`.
- Recent Jangar and Agents events still showed readiness probe failures during the latest rollout: Jangar at 52 minutes
  prior, Agents and Agents controllers at 22 to 60 minutes prior.
- Torghut was rolling through `torghut-00289` and `torghut-sim-00388` while the evidence pass ran. Earlier live
  revision `torghut-00288` and sim revision `torghut-sim-00387` were ready; the newer pods were starting and emitting
  startup/readiness probe warnings.
- Torghut events also showed repeated ClickHouse PodDisruptionBudget ambiguity warnings and FlinkDeployment external
  status modification warnings.

### Control-Plane Evidence

- Jangar status generated at `2026-05-07T23:11:40.163Z` reported:
  - database status `healthy`, 28 registered Kysely migrations, 28 applied, latest
    `20260505_torghut_quant_pipeline_health_window_index`;
  - rollout health `healthy` for `agents` and `agents-controllers`;
  - watch reliability `healthy` with 4,509 AgentRun watch events, zero errors, and two stream restarts;
  - execution trust `healthy`;
  - runtime kits `serving` and `collaboration` healthy, including `codex-nats-publish`, `codex-nats-soak`, and `nats`;
  - workflow and job runtime adapters configured with fresh heartbeat authority.
- The same status allowed `serve_readonly` and `torghut_observe`.
- The same status held or blocked wider material actions because the source rollout truth exchange lacked source or
  GitOps revision truth, the material verdict carried `controller_heartbeat_not_current`, and AgentRun ingestion
  reported `unknown` with message `agents controller not started`.
- Direct SQL in `agents_control_plane.component_heartbeats` contradicted the stale-heartbeat interpretation: four
  rows for `agents-controller`, `orchestration-controller`, `supporting-controller`, and `workflow-runtime` were
  healthy, observed at `2026-05-07T23:16:20.228Z`, and expiring at `2026-05-07T23:18:20.228Z`.

### Database And Data Evidence

- Direct Jangar SQL used the app credential and a read-only transaction.
- `agents_control_plane.resources_current` had about 4,451 live rows, fresh autovacuum at
  `2026-05-07T23:16:02.717Z`, and fresh autoanalyze at `2026-05-07T23:15:00.843Z`.
- `agents_control_plane.component_heartbeats` had four live rows and fresh autovacuum/autoanalyze at
  `2026-05-07T23:16:04Z`.
- `torghut_control_plane.quant_metrics_latest` had about 4,284 live rows and fresh maintenance.
- `torghut_control_plane.quant_pipeline_health` still had about 51,100,665 live rows with no sampled autovacuum or
  autoanalyze timestamp.
- `public.torghut_market_context_snapshots` had stale fundamentals and news witnesses: fundamentals newest `as_of`
  was `2026-03-12T13:43:25Z`; news newest `as_of` was `2026-05-07T17:42:31Z`.
- Listing secrets by namespace was forbidden, but direct named secret reads for app DB credentials were allowed. Listing
  StatefulSets in `torghut` was forbidden. These RBAC limits should be represented as delegated or unavailable
  witnesses, not silent blanks.

### Source Evidence

- `services/jangar/src/server/control-plane-status.ts` is 787 lines and assembles the status response.
- `services/jangar/src/server/control-plane-source-rollout-truth-exchange.ts` is 632 lines and already emits
  `source_rollout_truth_missing:source_or_gitops_revision` and `controller_heartbeat_not_current`.
- `services/jangar/src/server/control-plane-material-action-verdict.ts` is 528 lines and already finalizes action
  decisions.
- `services/jangar/src/server/control-plane-controller-witness.ts` is 448 lines and includes an `agentrun_ingestion`
  witness surface.
- `services/jangar/src/server/control-plane-action-clock.ts` is 276 lines and already separates action-clock
  projections from final verdicts.
- Jangar has 160 co-located TS/TSX tests under `services/jangar/src`.

## Problem

The control plane no longer has a broad health outage. It has a witness convergence problem.

That is more dangerous than a simple outage because the evidence is partly green. Operators can see ready deployments,
fresh heartbeats, a healthy database, and a working route. At the same time, material actions correctly stay held
because source and ingestion witnesses are not settled. Without one settlement object, each consumer has to decide
which surface to trust.

The current status can therefore produce these conflicting interpretations:

1. Green rollout says the controllers are available.
2. Direct heartbeat SQL says controller authority is fresh.
3. The material-action verdict says controller heartbeat is not current.
4. AgentRun ingestion says unknown.
5. Source rollout truth says source or GitOps revision is missing.
6. Torghut capital consumers see observe allowed and paper/live held.

All six can be true. They need one reducer that turns them into action bonds.

## Alternatives Considered

### Option A: Trust Healthy Rollout And Fresh Heartbeats

Treat ready deployments and healthy component heartbeat rows as sufficient authority for repair dispatch and deploy
widening.

Advantages:

- Fastest path to resume normal automation.
- Uses evidence that is already fresh and easy to observe.
- Reduces operator friction after a recovery.

Disadvantages:

- Ignores missing source or GitOps revision truth.
- Ignores AgentRun ingestion unknowns.
- Lets one green surface erase a stricter material verdict.
- Does not give Torghut a durable reason to keep capital closed.

Decision: reject. It would reduce visible friction by moving risk into the trading boundary.

### Option B: Freeze Every Material Action Until All Surfaces Are Green

Block all non-read-only work whenever any source, heartbeat, ingestion, or terminal-debris witness is missing.

Advantages:

- Simple and conservative.
- Easy to explain during incidents.
- Prevents accidental widening under disagreement.

Disadvantages:

- Over-blocks bounded repair work.
- Treats source-provenance gaps, old probe bursts, and current controller failures as the same risk.
- Encourages manual bypasses because every hold looks equally severe.

Decision: keep as an emergency fallback only.

### Option C: Source-Heartbeat Witness Settlement With Material-Action Bonds

Compute a bond per action class. The bond records source truth, rollout truth, controller heartbeat, AgentRun
ingestion, terminal evidence carry, and Torghut consumer evidence. Each missing or contradictory surface becomes a
finite variance code and a smallest unblocker.

Advantages:

- Keeps read-only and observation paths available.
- Preserves bounded repair only when the repair target and authority are explicit.
- Prevents source, heartbeat, and ingestion disagreements from being hidden by green rollout.
- Gives deployers and Torghut capital gates a compact, auditable object.

Disadvantages:

- Adds another reducer and payload to an already rich status route.
- Requires tests across mixed green/hold states.
- Forces teams to maintain stable witness names and variance codes.

Decision: select Option C.

## Architecture

Add a pure reducer under `services/jangar/src/server/`, tentatively
`control-plane-source-heartbeat-witness-settlement.ts`. It must not call Kubernetes, GitHub, NATS, Torghut, or a
database directly. The status assembly layer passes already collected evidence into it.

Input evidence:

- database migration and connectivity status;
- rollout health;
- watch reliability;
- runtime kits and runtime adapters;
- controller list and component heartbeats;
- AgentRun ingestion status;
- source rollout truth exchange;
- terminal evidence half-life ledger when available;
- route stability escrow;
- material action verdict epoch;
- Torghut repair-yield or consumer-evidence summary when available.

Output:

```text
source_heartbeat_witness_settlement
  schema_version
  settlement_id
  namespace
  generated_at
  fresh_until
  source_truth
  rollout_truth
  heartbeat_truth
  ingestion_truth
  terminal_carry_truth
  torghut_consumer_truth
  witness_variance_ledger
  material_action_bonds
  rollback_target
```

Each `material_action_bond` includes:

```text
material_action_bond
  bond_id
  action_class
  final_verdict_id
  final_verdict_decision
  settlement_decision
  confidence
  source_revision_ref
  gitops_revision_ref
  rollout_ref
  controller_heartbeat_ref
  agentrun_ingestion_ref
  terminal_carry_ref
  torghut_consumer_ref
  witness_variance_codes
  smallest_unblocker
  allowed_until
  max_dispatches
  max_runtime_seconds
  max_notional
  rollback_target
```

Settlement decisions:

- `settled_allow`
- `settled_observe_only`
- `settled_repair_only`
- `held_missing_witness`
- `held_contradictory_witness`
- `blocked_capital_witness`

Variance codes:

- `source_revision_missing`
- `gitops_revision_missing`
- `desired_live_image_mismatch`
- `controller_heartbeat_stale`
- `controller_heartbeat_conflicts_with_sql`
- `agentrun_ingestion_unknown`
- `watch_epoch_stale`
- `terminal_carry_unretired`
- `torghut_consumer_evidence_missing`
- `torghut_repair_yield_below_gate`
- `rbac_witness_unavailable`

## Implementation Scope

Engineer stage:

- Add the reducer and types under `services/jangar/src/server/`.
- Add `source_heartbeat_witness_settlement` to the control-plane status response.
- Attach `material_action_bond_id` to every material verdict.
- Write unit tests for:
  - healthy rollout plus missing source truth holds dispatch;
  - fresh SQL heartbeat plus stale verdict heartbeat produces a variance code;
  - AgentRun ingestion unknown holds repair dispatch unless the action is observe-only;
  - Torghut observe remains allowed with zero notional;
  - paper/live actions remain held without a Torghut repair-yield bond;
  - rollback target is stable for every held and blocked decision.

Deployer stage:

- Roll out in advisory mode first.
- Compare bond decisions against existing material verdicts for one full schedule cycle.
- Switch enforcement only after advisory output is stable and no green final verdict is downgraded without a named
  variance code.
- Keep the old final verdict fields during the migration.

## Validation Gates

Local validation:

- `bun run --cwd services/jangar test -- src/server/__tests__/control-plane-source-heartbeat-witness-settlement.test.ts`
- `bun run --cwd services/jangar test -- src/server/__tests__/control-plane-status.test.ts`
- `bun run --cwd services/jangar check:module-sizes`
- `bunx oxfmt --check services/jangar/src/server/control-plane-source-heartbeat-witness-settlement.ts services/jangar/src/server/__tests__/control-plane-source-heartbeat-witness-settlement.test.ts`

Cluster validation:

- `curl -fsS 'http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status?namespace=agents'`
- Verify each material verdict has `material_action_bond_id`.
- Verify `serve_readonly` and `torghut_observe` are settled observe-only or allow.
- Verify `dispatch_repair`, `dispatch_normal`, `deploy_widen`, and `merge_ready` stay held when source or ingestion
  witnesses are missing.
- Verify `paper_canary`, `live_micro_canary`, and `live_scale` cite the Torghut consumer-evidence or repair-yield bond.

## Rollout Plan

1. Ship advisory payload with no decision enforcement.
2. Add dashboard columns for settlement decision, missing witness, and smallest unblocker.
3. Run one full hourly Jangar/Torghut cycle and compare bonds to final verdicts.
4. Enable enforcement for `deploy_widen` and `merge_ready`.
5. Enable enforcement for `dispatch_repair` and `dispatch_normal`.
6. Enable Torghut capital handoff enforcement only after the companion Torghut repair-yield ledger is live.

## Rollback Plan

Rollback is configuration-only:

- keep collecting the settlement payload;
- disable enforcement and return consumers to existing material verdict decisions;
- leave `material_action_bond_id` in responses as advisory evidence;
- preserve variance codes for incident review.

If the reducer misclassifies a healthy action as held, set enforcement to advisory and repair the reducer. If it
misclassifies a held action as settled, disable enforcement immediately and treat the affected variance class as
`held_missing_witness` until fixed.

## Risks And Mitigations

- Risk: operators treat the bond as another status page field.
  Mitigation: every wider action must cite the bond ID in deployer and Torghut handoff output.
- Risk: stale source truth blocks useful repair for too long.
  Mitigation: allow `settled_repair_only` when the repair target is the source or GitOps witness itself and max
  notional is zero.
- Risk: heartbeat rows and material verdict heartbeat interpretation disagree.
  Mitigation: make the disagreement a variance code and require engineer investigation before widening.
- Risk: RBAC gaps are mistaken for absence of risk.
  Mitigation: represent forbidden reads as `rbac_witness_unavailable` with delegated authority, not as pass.

## Handoff Contract

Engineer acceptance gates:

- The status route emits `source_heartbeat_witness_settlement`.
- Every material verdict has a bond ID.
- Tests cover mixed healthy and held evidence.
- No network or database calls occur inside the reducer.

Deployer acceptance gates:

- Advisory output is stable for one schedule cycle.
- Every held material action has one variance code and one smallest unblocker.
- Torghut observe remains available with max notional `0`.
- Paper/live capital remains blocked until the companion Torghut repair-yield bond settles.
