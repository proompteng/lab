# 157. Jangar Shadow Parity Ledger And Enforcement Release Train (2026-05-07)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-07
Owner: Victor Chen, Jangar Engineering
Scope: Jangar control-plane reliability, shadow-to-enforced promotion, material-action safety, rollout behavior,
Torghut capital handoff, validation, rollback, and implementation acceptance gates.

Companion Torghut contract:

- `docs/torghut/design-system/v6/161-torghut-shadow-capital-parity-and-no-notional-release-train-2026-05-07.md`

Extends:

- `155-jangar-execution-cohort-settlement-and-launch-quarantine-2026-05-07.md`
- `154-jangar-source-provenance-leases-and-material-action-escrow-2026-05-07.md`
- `153-jangar-design-actuation-ledger-and-contract-convergence-gates-2026-05-07.md`

## Decision

I am selecting a shadow parity ledger with an enforcement release train as the next Jangar control-plane architecture
step.

The current system is doing the right conservative thing, but it lacks the proof needed to graduate. Jangar is serving,
Agents rollout health is green, workflow reliability is clean, execution trust is healthy, and the database migration
surface is current. At the same time, the highest-value action gates remain shadow-mode. Source rollout truth holds
dispatch, deploy widen, merge readiness, paper canary, and live capital because source/GitOps provenance, image parity,
controller ingestion, and empirical proof are not settled. Material action verdicts are also shadow-mode. They produce
useful holds and one clear contradiction, but deployers still do not have a durable answer to the question: when is a
shadow verdict proven enough to become an enforced gate?

The next reliability gain is to stop treating shadow mode as an open-ended holding pattern. Jangar should publish a
`shadow_parity_ledger` and `enforcement_release_train` that compare each shadow decision with the currently enforced
runtime behavior over bounded windows. A gate can move from `shadow_collecting` to `repair_enforced`,
`material_enforced`, or `retired` only when it has enough samples, no unsafe false allows, bounded false blocks, fresh
source and controller witnesses, and a rollback target.

The tradeoff is more patience before enforcement. I accept that. Enforcing a new verdict without parity evidence would
make rollout safety depend on confidence in the design rather than observed behavior. A release train gives us a way to
move quickly without letting a shadow gate surprise schedule runners, deployers, or Torghut capital consumers.

## Runtime Objective And Success Metrics

Success means:

- `/api/agents/control-plane/status?namespace=agents` publishes `shadow_parity_ledger` and
  `enforcement_release_train`.
- Every shadow-mode material action source has a parity record: source rollout truth, route stability escrow,
  material action verdict epoch, controller witness, runtime admission proof, and any Torghut capital proof consumer.
- Every action class has an explicit promotion state: `shadow_collecting`, `parity_candidate`, `repair_enforced`,
  `material_enforced`, `rollback`, `retired`, or `blocked`.
- A shadow verdict that would have allowed an action while the current enforced path blocked it records
  `false_allow` and cannot promote.
- A shadow verdict that would have blocked an action while the current enforced path allowed it records
  `false_block`; it may promote only after deployers accept the extra hold as intentional.
- `serve_readonly` stays independent from material enforcement and may remain allowed when parity is incomplete.
- `dispatch_repair` is the first promotable action class, and it can enforce only bounded repair work with max
  dispatches, max runtime, source lease, controller witness, and rollback target.
- `dispatch_normal`, `deploy_widen`, and `merge_ready` require at least two stable parity windows and no unsafe false
  allows.
- `paper_canary`, `live_micro_canary`, and `live_scale` require the Torghut companion `shadow_capital_parity` to be
  current and zero-notional rollback to be tested.
- Deployer checks consume the release train state instead of independently deciding whether a shadow gate is ready to
  enforce.

## Evidence Snapshot

All evidence was collected read-only on 2026-05-07. I did not mutate Kubernetes resources, database records,
ClickHouse tables, broker state, AgentRun objects, GitOps resources, trading flags, or empirical artifacts.

### Cluster And Rollout Evidence

- The workspace had no configured current Kubernetes context, but the in-cluster service account could read the
  required namespaces.
- Namespaces `agents`, `jangar`, `torghut`, and `argocd` were active.
- Agents deployments were available: `agents=1/1`, `agents-controllers=2/2`, and `agents-alloy=1/1`.
- Jangar deployments and runtime pods were running, including `jangar-594b6746fd-5lhwp` with two containers ready.
- Recent Agents events showed a successful rollout and current cron jobs completing, but also readiness probe timeouts
  on controller pods and retained schedule-runner errors from earlier windows.
- Argo CD reported `agents`, `jangar`, `symphony-jangar`, and `symphony-torghut` as synced and healthy; `torghut` was
  healthy but out of sync, and `torghut-options` had recently progressed to healthy after a sync.
- The service account could read deployments, pods, services, events, and Argo Applications, but could not list CNPG
  cluster resources, secrets, or Knative service resources. Typed runtime status endpoints are therefore the available
  database/data witnesses for this pass.

### Jangar Status And Database Evidence

- `GET http://jangar.jangar.svc.cluster.local/ready` returned `status=ok`.
- The ready response showed leader election healthy with `jangar-594b6746fd-5lhwp` as leader.
- `GET /api/agents/control-plane/status?namespace=agents` generated at `2026-05-07T17:22:47.302Z`.
- Jangar database status was healthy: configured, connected, `latency_ms=17`, migration table `kysely_migration`,
  `registered_count=28`, `applied_count=28`, `unapplied_count=0`, and latest applied
  `20260505_torghut_quant_pipeline_health_window_index`.
- Rollout health was healthy for the two observed Agents deployments.
- Workflow reliability was high-confidence over 15 minutes: zero active job runs, zero recent failed jobs, zero backoff
  limit jobs, and zero collection errors.
- Execution trust was healthy with no blocking windows.
- Watch reliability was healthy over 15 minutes with four streams, 2887 events, zero errors, and four restarts.
- `source_rollout_truth_exchange` was `shadow` and held `dispatch_repair`, `dispatch_normal`, `deploy_widen`,
  `merge_ready`, `paper_canary`, `live_micro_canary`, and `live_scale`.
- The freshest source rollout blocker was `source_rollout_truth_missing:source_or_gitops_revision`.
- `route_stability_escrow` was `shadow`; route state was stable, but it still held material dispatch and paper classes
  while live capital classes remained blocked.
- `material_action_verdict_epoch` was `shadow`, emitted final verdicts, and identified a contradiction for
  `merge_ready`: budget held while an action clock allowed.

### Source Evidence

- `services/jangar/src/server/control-plane-status.ts` is the central status assembly point and now imports many
  reducers: source rollout truth, route stability escrow, material verdict epoch, negative evidence, runtime
  admission, failure-domain leases, controller witness, and execution trust.
- `services/jangar/src/server/control-plane-source-rollout-truth-exchange.ts` already publishes shadow receipts and
  action decisions, but it does not decide when its own decisions become enforceable.
- `services/jangar/src/server/control-plane-material-action-verdict.ts` emits final verdicts and contradictions, but
  its producer revision is still a shadow revision.
- `services/jangar/src/server/supporting-primitives-controller.ts` already has runtime admission enforcement flags,
  schedule-runner checks, and launch behavior. This is the place enforcement will eventually touch, so parity evidence
  must be explicit before changing behavior.
- Existing tests cover status assembly, route stability escrow, material action verdicts, negative evidence,
  controller witness, runtime admission, and supporting-primitives enforcement toggles. The missing test surface is a
  cross-gate parity ledger that proves a shadow verdict can graduate without unsafe false allows.

### Torghut Capital Evidence

- Live Torghut `/readyz` returned HTTP `503` with `status=degraded`.
- Live proof floor was `repair_only`, route state `repair_only`, capital state `zero_notional`, and `max_notional=0`.
- Live blockers were `hypothesis_not_promotion_eligible`, `degraded`, `execution_tca_route_universe_empty`,
  `market_context_stale`, and `simple_submit_disabled`.
- Live execution TCA had 7334 orders, 7245 filled executions, average absolute slippage
  `13.8203637593029676` bps, guardrail `8` bps, zero routeable symbols, five blocked symbols, and three missing
  symbols.
- Live market context remained stale and alpha readiness had three shadow hypotheses, zero promotion-eligible
  hypotheses, and three rollback-required hypotheses.
- Simulation `/readyz` returned HTTP `200`, but simulation proof floor was still `repair_only` and `zero_notional`.
  Simulation had one probing symbol, `NVDA`, and seven missing symbols.

## Problem

Jangar now has enough shadow evidence to be useful, but not enough parity evidence to enforce it safely. The failure
mode is not missing signals. The failure mode is promoting a signal without proving that it agrees with current
production behavior in the windows that matter.

The concrete risks are:

1. A shadow reducer can correctly hold an action today but still be too noisy to enforce tomorrow.
2. A shadow reducer can allow `serve_readonly` and `torghut_observe`, while a deployer infers broader enforcement
   maturity from the same status block.
3. A material action contradiction can be visible but not assigned to an enforcement release stage.
4. Runtime admission has enforcement toggles, but source rollout truth, route stability, and material verdicts do not
   share one promotion ledger.
5. Torghut capital can ask whether a Jangar gate is live when Jangar can only say the gate is shadow.

## Alternatives Considered

### Option A: Enforce The Current Shadow Verdicts Immediately

Pros:

- Removes ambiguity quickly.
- Converts useful holds into real protection.
- Forces source and controller witness repairs to happen before material work continues.

Cons:

- No rolling false-allow or false-block evidence.
- A single bad reducer or stale input could stop schedules, PR merges, or deploy widening.
- Rollback would be a manual env-flag exercise without a compact reason ledger.

Decision: reject. The current evidence supports the conservative decisions, not immediate enforcement.

### Option B: Keep Shadow Gates Informational Until All Source And Contract Actuation Work Is Complete

Pros:

- Lowest operational risk.
- Keeps serving and schedule work stable.
- Gives engineers time to implement source provenance, contract actuation, and launch quarantine first.

Cons:

- Shadow mode can become permanent.
- Deployer behavior stays inconsistent because each gate has its own promotion story.
- Torghut capital remains unable to distinguish a strong shadow hold from a live capital blocker.

Decision: reject as too passive. We need a promotion mechanism, not another waiting room.

### Option C: Add A Shadow Parity Ledger And Enforcement Release Train

Pros:

- Converts shadow evidence into measured release candidates.
- Gives deployers one promotion and rollback state per action class.
- Allows repair enforcement to graduate before higher-risk dispatch, merge, and capital classes.
- Produces concrete false-allow and false-block counts for engineering review.

Cons:

- Adds a reducer and eventually a small persistence surface.
- Requires historical samples before enforcement.
- Forces each shadow reducer to define its legacy comparator and rollback target.

Decision: select Option C.

## Architecture

Add a pure reducer named `control-plane-shadow-parity-ledger` under `services/jangar/src/server/`. It should not query
Kubernetes or databases directly. It consumes assembled status evidence and recent action outcome summaries already
available to the control plane.

Inputs:

- `source_rollout_truth_exchange.receipts`
- `route_stability_escrow.material_action_contracts`
- `material_action_verdict_epoch.final_verdicts`
- `negative_evidence_router`
- `control_plane_controller_witness`
- `runtime_kits`, `admission_passports`, and `recovery_warrants`
- `rollout_health`, `workflows`, `watch_reliability`, and `database.migration_consistency`
- schedule-runner and AgentRun outcome summaries
- deployer-observed action outcomes when available
- Torghut `shadow_capital_parity` for capital action classes

`ShadowParityRecord` fields:

- `record_id`
- `action_class`
- `shadow_source`: `source_rollout_truth`, `route_stability_escrow`, `material_verdict_epoch`,
  `controller_witness`, `runtime_admission`, or `torghut_capital`
- `shadow_decision`
- `legacy_decision`
- `decision_delta`: `match`, `false_allow`, `false_block`, `incomparable`, or `unknown`
- `sample_count`
- `false_allow_count`
- `false_block_count`
- `incomparable_count`
- `first_observed_at`
- `last_observed_at`
- `fresh_until`
- `evidence_refs`
- `promotion_state`
- `blocking_reason_codes`
- `rollback_target`

`EnforcementReleaseTrain` fields:

- `release_train_id`
- `generated_at`
- `fresh_until`
- `action_class`
- `current_state`: `shadow_collecting`, `parity_candidate`, `repair_enforced`, `material_enforced`, `rollback`,
  `retired`, or `blocked`
- `required_sample_count`
- `required_clean_windows`
- `observed_clean_windows`
- `unsafe_false_allow_count`
- `accepted_false_block_count`
- `required_source_refs`
- `required_controller_refs`
- `required_torghut_refs`
- `next_promotion_candidate`
- `promotion_blockers`
- `rollback_target`

State rules:

- `shadow_collecting`: shadow data exists but sample count or clean windows are below threshold.
- `parity_candidate`: sample thresholds are met with zero unsafe false allows.
- `repair_enforced`: only bounded repair actions may consume the gate.
- `material_enforced`: normal dispatch, deploy widen, merge, or capital gates may consume the gate.
- `rollback`: enforcement was disabled after a regression or contradiction.
- `retired`: a newer live gate superseded the shadow source.
- `blocked`: source, controller, database, or Torghut capital evidence is missing.

Initial promotion policy:

- `serve_readonly`: no promotion required; it remains a serving-health action.
- `torghut_observe`: may promote after one clean window because max notional remains zero.
- `dispatch_repair`: may promote after two clean windows, no unsafe false allows, and a bounded max-dispatch policy.
- `dispatch_normal`, `deploy_widen`, and `merge_ready`: may promote after four clean windows, no unsafe false allows,
  source/GitOps provenance current, and controller ingestion witness current.
- `paper_canary`: may promote only when Torghut shadow capital parity is a clean candidate and proof floor is not
  repair-only.
- `live_micro_canary` and `live_scale`: may not promote until paper has enforced successfully with rollback tested.

## Validation Gates

Engineer validation:

- Add `services/jangar/src/server/control-plane-shadow-parity-ledger.ts`.
- Add `services/jangar/src/server/__tests__/control-plane-shadow-parity-ledger.test.ts`.
- Fixture: shadow hold and legacy hold for `dispatch_normal` records `match` and increments clean windows.
- Fixture: shadow allow and legacy hold records `false_allow` and blocks promotion.
- Fixture: shadow hold and legacy allow records `false_block` and requires deployer acceptance before promotion.
- Fixture: missing source/GitOps provenance keeps `deploy_widen` in `blocked` even if route and database are healthy.
- Extend `control-plane-status.test.ts` to assert `shadow_parity_ledger` and `enforcement_release_train` are present
  and do not fail `serve_readonly`.

Deployer validation:

- Query `/api/agents/control-plane/status?namespace=agents`.
- Require every enforced action class to have `current_state` of `repair_enforced` or `material_enforced`.
- Reject dispatch, deploy widen, merge, paper, or live action if `unsafe_false_allow_count > 0`.
- Reject promotion if `source_rollout_truth_missing:source_or_gitops_revision` remains in any required source ref.
- For capital classes, require the Torghut companion parity record to be current and zero-notional rollback tested.

## Rollout

Phase 0 ships the reducer in status-only mode. No runtime behavior changes.

Phase 1 records one day of shadow samples for `torghut_observe` and `dispatch_repair`. Deployer checks may read the
release train but must not enforce it.

Phase 2 enforces `dispatch_repair` only when parity is clean. Max dispatches and max runtime remain bounded.

Phase 3 graduates `dispatch_normal`, `deploy_widen`, and `merge_ready` after source/GitOps provenance and controller
ingestion are current across the required windows.

Phase 4 enables paper canary enforcement only after Torghut publishes clean shadow capital parity. Live capital remains
blocked until paper rollback has been exercised.

## Rollback

Rollback is staged:

1. Set the release train state for the affected action class to `rollback`.
2. Disable the enforcement toggle for that action class while keeping parity emission active.
3. Keep `serve_readonly` and `torghut_observe` available if their lower-level health remains good.
4. Revert to current material action receipts and runtime admission enforcement for launch behavior.
5. Require a new clean-window sequence before re-enabling enforcement.

Rollback should not delete parity records. The history is the evidence needed to understand whether the fault was a
bad shadow reducer, stale input, or an unsafe promotion threshold.

## Risks And Tradeoffs

- The ledger can become another dashboard if enforcement states are not wired into deployer checks. The deployer gate
  must consume it before any material promotion.
- False blocks may slow work. That is acceptable for dispatch and merge; deployers can accept them explicitly only
  after the reason is understood.
- False allows are not negotiable. Any unsafe false allow resets promotion for the action class.
- The first implementation should avoid durable storage if status history is not yet needed. Once enforcement starts,
  persist compact parity records so restarts do not erase promotion evidence.
- Torghut capital should never infer enforcement from Jangar shadow mode. It must consume the explicit release-train
  state.

## Handoff To Engineer

Implement the reducer as a pure function first. Feed it with status evidence and a small in-memory or persisted sample
provider behind an interface. Keep behavior report-only until tests prove false-allow blocking, false-block accounting,
source/GitOps blocking, and Torghut capital dependency behavior.

The smallest useful slice is:

1. Compute parity for `source_rollout_truth_exchange` versus material action verdicts for the nine action classes.
2. Publish `shadow_parity_ledger` and `enforcement_release_train` from the status route.
3. Add tests for match, false allow, false block, missing source, and capital dependency.
4. Leave all runtime enforcement toggles unchanged.

## Handoff To Deployer

Do not enforce a shadow gate because the status route is healthy. Enforce only when the release train says the action
class is promoted and the required clean windows are current. For this evidence window, material classes stay held,
capital stays zero-notional, and the next deployer action is to validate parity emission in production before enabling
any repair enforcement.
