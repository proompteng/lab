# 152. Jangar Material Verdict Authority And Contradiction Debt Ledger (2026-05-07)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-07
Owner: Victor Chen, Jangar Engineering
Scope: Jangar material-action authority, execution-trust convergence, source-rollout truth, controller witness debt,
Torghut proof-floor consumption, validation, rollout, rollback, and implementation handoff.

Companion Torghut contract:

- `docs/torghut/design-system/v6/156-torghut-repair-closure-yield-ledger-and-capital-unlock-receipts-2026-05-07.md`

Extends:

- `150-jangar-controller-brownout-budgets-and-proof-spend-admission-exchange-2026-05-07.md`
- `149-jangar-wrapper-truth-settlement-and-useful-evidence-gates-2026-05-07.md`
- `148-jangar-source-rollout-truth-exchange-and-proof-floor-settlement-2026-05-07.md`
- `120-jangar-material-action-verdict-arbiter-and-clock-budget-parity-2026-05-06.md`

## Decision

I am selecting a material verdict authority with a contradiction debt ledger as the next Jangar control-plane
architecture step.

The system is no longer failing in the simple way. Jangar serves. The Agents deployments are available. The database
probe is healthy. Recent hourly swarm wrappers recovered after earlier failures. But the current status surface still
shows a more dangerous split: legacy action clocks allow `dispatch_normal`, `deploy_widen`, and `merge_ready` while
`source_rollout_truth_exchange` holds those same classes on `heartbeat_projection_split` and missing source/GitOps
revision. `execution_trust` is healthy, but the deployer summary says material actions are held. That is the class of
failure that makes operators reconcile contradictory green and hold signals by hand.

The next control-plane increment must make one verdict authoritative for every material action. Lower-level surfaces
can still publish their own receipts, but they cannot independently imply admission once any stricter truth surface has
a current hold or block. Jangar will publish a `MaterialVerdictAuthorityReceipt` per action class and record every
disagreement as contradiction debt with a concrete owner, expiry, and repair route.

The tradeoff is that some dashboards that previously looked green will become visibly degraded. I accept that. The
control plane should not optimize for optimistic summaries. It should optimize for the smallest safe action that is
consistent with all current evidence.

## Runtime Objective And Success Metrics

Success means:

- `/api/agents/control-plane/status` publishes `material_verdict_authority`.
- `/ready` includes the same authority summary for material action classes without taking down `serve_readonly`.
- Each action class has exactly one effective decision: `allow`, `repair_only`, `defer`, `hold`, or `block`.
- A stricter current source wins over a weaker current source. `source_rollout_truth_exchange=hold` must override an
  `action_clock=allow` for the same material action.
- `execution_trust=healthy` cannot mask current material-action holds from source-rollout truth, controller witness,
  proof floor, or Torghut capital receipts.
- Every disagreement is written as contradiction debt with a reason code, producer refs, owner lane, repair action,
  `fresh_until`, and rollback target.
- Deployer checks consume the authority receipt instead of independently joining action clocks, material verdicts,
  source truth, and Torghut proof floor.
- Engineer and deployer handoffs can cite one receipt ID to explain why an action was allowed, held, or blocked.

## Evidence Snapshot

All evidence was collected read-only on 2026-05-07. I did not mutate Kubernetes resources, database records,
ClickHouse tables, broker state, AgentRun objects, GitOps resources, trading flags, or empirical artifacts.

### Cluster And Rollout Evidence

- `jangar` namespace deployments were available: `jangar=1/1`, `bumba=1/1`, `symphony=1/1`,
  `symphony-jangar=1/1`, and `jangar-alloy=1/1`.
- The active Jangar pod was `jangar-586b47658b-pdcg2`, running image
  `registry.ide-newton.ts.net/lab/jangar:b8d6fcab@sha256:a1882587e5dc97f38593be5bf6b5e387fee6a2089c0ef7b8de5f6b64c5b242b0`.
- Jangar rollout events showed one transient `/health` readiness failure after the 15:xx rollout and then a settled
  running pod.
- `agents` deployments were available: `agents=1/1`, `agents-controllers=2/2`, and `agents-alloy=1/1`.
- Agents API and controller pods had very recent restarts: the API pod had 2 restarts about 5 minutes before the probe,
  and controller pods had 3 and 1 restarts respectively.
- Hourly Jangar discover, plan, implement, and verify wrapper jobs had recent completed wrapper jobs, while older
  retained cron attempt pods from the same lanes were still in `Error`.
- Torghut market-context wrapper jobs completed while their child provider jobs failed:
  `torghut-market-context-fundamentals-preopen-probe-79zzv-job`,
  `torghut-market-context-news-preopen-probe-l5hp7-job`,
  `torghut-market-context-fundamentals-batch-qqnlf-job`, and
  `torghut-market-context-news-batch-92bwg-job`.
- Torghut live and simulation active Knative deployments were available at `1/1` on current digest
  `sha256:8db8a40ee7f76c08aaa0689b55e145dfaf872248707a20fb38c005e0eabb42ab`.
- Torghut events still showed transient readiness failures, duplicate ClickHouse PodDisruptionBudget warnings, and
  Flink status-modified-externally warnings.

### Jangar Status And Data Evidence

- `GET http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status?namespace=agents` responded at
  `2026-05-07T15:10:03.359Z`.
- Jangar database status was healthy: configured, connected, `latency_ms=2`, migration table `kysely_migration`,
  `registered_count=28`, `applied_count=28`, `unapplied_count=0`, and latest applied
  `20260505_torghut_quant_pipeline_health_window_index`.
- Rollout health was healthy for the observed Agents deployments.
- Execution trust was healthy with no blocking windows.
- Controller authority was split by source: two controller statuses were derived from rollout, while
  `orchestration-controller` came from a fresh heartbeat.
- `source_rollout_truth_exchange` reported a controller heartbeat split: "controller deployment and watch epoch are
  current, but controller ingestion self-report is missing."
- `source_rollout_truth_exchange` held `dispatch_repair`, `dispatch_normal`, `deploy_widen`, and `merge_ready` with
  `heartbeat_projection_split`, missing source/GitOps revision, and `controller_heartbeat_not_current`.
- The same exchange held or blocked Torghut capital actions on `proof_floor_repair_only`, missing Torghut consumer
  evidence, paper settlement required, and live capital hold/block reasons.
- `reconciled_action_clocks` still allowed `dispatch_normal`, `deploy_widen`, and `merge_ready`; `torghut_capital`
  correctly remained `hold`.
- The material-action verdict epoch recorded a contradiction for `dispatch_normal`: budget repair-only versus clock
  allow.
- Direct CNPG SQL through `kubectl cnpg psql -n jangar jangar-db` was RBAC-blocked:
  `pods "jangar-db-1" is forbidden: User "system:serviceaccount:agents:agents-sa" cannot create resource "pods/exec"`.
  The database witness for this run is therefore the typed Jangar status API plus read-only Kubernetes service evidence.

### Torghut Data And Profit Evidence

- Live Torghut `/readyz` returned HTTP `503` with `status=degraded`.
- Simulation Torghut `/readyz` returned HTTP `200` in paper mode.
- Live dependencies were healthy for Postgres, ClickHouse, Alpaca, Jangar universe, readiness cache, and empirical jobs.
- Live schema was current at Alembic head `0029_whitepaper_embedding_dimension_4096`; schema lineage had one branch,
  no duplicate revisions, no orphan parents, and known parent-fork warnings.
- Live submission remained closed: `allowed=false`, `reason=simple_submit_disabled`, `capital_stage=shadow`.
- Live proof floor remained `repair_only` with `capital_state=zero_notional`.
- Live blockers were `hypothesis_not_promotion_eligible`, `execution_tca_slippage_guardrail_exceeded`,
  `market_context_stale`, and `simple_submit_disabled`.
- Live TCA had `13,775` orders, `13,571` filled executions, latest computed at
  `2026-05-07T14:23:44.018621+00:00`, and average absolute slippage
  `13.7594875295276693` bps against an `8` bps guardrail.
- Live quant ingestion was informational but degraded: `latest_metrics_updated_at=2026-05-07T15:09:35.041Z` and
  `max_stage_lag_seconds=77083`.
- Simulation proof floor was also `repair_only` and zero-notional, with alpha readiness, execution TCA, and market
  context blockers.

### Source Evidence

- `services/jangar/src/server/control-plane-status.ts` is 787 lines and composes the route status response from many
  independent gates.
- `services/jangar/src/server/control-plane-action-clock.ts` is 276 lines and still produces allow decisions that can
  conflict with stricter downstream truth.
- `services/jangar/src/server/control-plane-source-rollout-truth-exchange.ts` already models
  `heartbeat_projection_split`, `proof_floor_repair_only`, missing source/GitOps revision, and deployer summaries.
- `services/jangar/src/server/control-plane-material-action-verdict.ts` is 528 lines and already receives source
  rollout truth as an input, but the public status still exposes lower-level allow decisions beside stricter holds.
- `services/jangar/src/server/control-plane-negative-evidence-router.ts` is 610 lines and can carry normalized debt
  once the authority has selected the final effective verdict.
- Existing Jangar tests cover action clocks, source-rollout truth, material-action verdicts, execution trust, route
  stability, controller witness, negative evidence, and ready behavior. The missing test is not coverage of an
  individual gate; it is coverage that a current stricter gate becomes the single effective material action authority.
- Torghut source already exposes proof floor, submission council, TCA, empirical jobs, hypotheses, revenue repair, and
  runtime readiness. Its missing side is a capital-unlock receipt that proves a repair closed a blocker before paper or
  live capital re-enters.

## Problem

Jangar now has enough safety gates that disagreement between gates is becoming its own failure mode. A human can read
the full status payload and find the stricter hold. An automated deployer, an engineer stage, or a downstream consumer
can still pick the optimistic field and widen work incorrectly.

The current failure modes are:

1. `execution_trust=healthy` can coexist with material-action holds and make the top-level state look safer than it is.
2. `action_clock=allow` can coexist with `source_rollout_truth_exchange=hold` for the same action class.
3. Material verdict contradictions are visible but not yet promoted to the single decision surface deployers must use.
4. Controller heartbeat splits are treated as local source-rollout details rather than action-class debt with owners.
5. Torghut repair-only proof floor blocks capital, but capital recovery still needs a receipt that says which repair
   actually closed which blocker.

## Alternatives Considered

### Option A: Keep Existing Gates And Train Consumers To Read The Strictest Field

Pros:

- No new server module.
- Preserves every current field shape.
- Avoids changing readiness semantics.

Cons:

- Pushes safety reconciliation into every consumer.
- Lets old clients continue reading optimistic fields.
- Does not create a durable contradiction debt queue.

Decision: reject. This is how contradictory control-plane surfaces become production incidents.

### Option B: Make Execution Trust The Umbrella Gate

Pros:

- Uses an existing top-level concept.
- Gives `/ready` one obvious summary.
- Could be implemented by feeding more inputs into execution trust.

Cons:

- Execution trust is about runtime execution windows, not every material action.
- It risks taking down serving for non-serving action debt.
- It hides the distinction between `serve_readonly`, repair dispatch, deploy widening, merge readiness, and capital.

Decision: reject as too blunt. Serving health and material-action admission need different failure policies.

### Option C: Add A Material Verdict Authority Above The Gate Set

Pros:

- Produces one effective decision per action class.
- Keeps existing gates as evidence producers.
- Turns disagreement into repairable debt instead of dashboard ambiguity.
- Lets deployers consume one receipt and one rollback target.

Cons:

- Adds one reducer and status block.
- Requires client migration to the authority receipt.
- Can initially surface more holds because optimistic fields no longer hide stricter truth.

Decision: select Option C.

## Architecture

Add `material_verdict_authority` as a pure reducer over existing evidence. It does not query Kubernetes or databases
directly. It consumes typed receipts already assembled by the control-plane status path.

Inputs:

- `execution_trust`
- `reconciled_action_clocks`
- `material_action_verdict_epoch`
- `source_rollout_truth_exchange`
- `control_plane_controller_witness`
- `negative_evidence_router`
- `controller_brownout_budget`
- Torghut proof-floor and capital-unlock receipts

Output shape:

- `authority_epoch_id`: deterministic hash of source receipt refs and action-class decisions.
- `generated_at` and `fresh_until`.
- `mode`: `shadow`, `warn`, `enforce_non_capital`, or `enforce_capital`.
- `action_authorities`: one receipt per action class.
- `contradiction_debt`: normalized disagreements that need repair or explicit waiver.
- `deployer_summary`: shortest safe action, held action classes, freshest blocking reason, rollback target, and receipt
  refs.

`MaterialVerdictAuthorityReceipt` fields:

- `receipt_id`
- `action_class`
- `effective_decision`
- `strictest_source`
- `source_decisions`
- `confidence`
- `fresh_until`
- `blocking_reason_codes`
- `required_repair_actions`
- `allowed_scope`
- `max_dispatches`
- `max_runtime_seconds`
- `max_notional`
- `evidence_refs`
- `contradiction_debt_refs`
- `rollback_target`

Decision ranking:

```text
block > hold > repair_only > defer > allow
```

The authority applies action-specific policy after ranking:

- `serve_readonly` can remain `allow` when route, database, and serving witnesses are current, even if material actions
  are held.
- `dispatch_repair` can be `repair_only` if the stricter source provides a bounded zero-notional repair action and a
  fresh expiry.
- `dispatch_normal`, `deploy_widen`, and `merge_ready` cannot be `allow` when source-rollout truth has a current hold.
- `paper_canary`, `live_micro_canary`, and `live_scale` cannot be `allow` without Torghut capital-unlock receipts and a
  non-repair-only proof floor.
- A stale strict source degrades to `defer` only when a fresher authoritative source explicitly supersedes it.

Contradiction debt fields:

- `debt_id`
- `action_class`
- `conflict_type`
- `optimistic_source`
- `strict_source`
- `optimistic_decision`
- `strict_decision`
- `reason_codes`
- `owner_lane`
- `repair_action`
- `fresh_until`
- `waiver_policy`
- `rollback_target`

The owner lane is mechanical:

- `controller_heartbeat_not_current` -> Jangar controller engineer.
- `source_rollout_truth_missing:*` -> deployer/GitOps engineer.
- `proof_floor_repair_only` or `torghut_consumer_evidence_missing` -> Torghut engineer.
- `action_clock_allow_vs_strict_hold` -> Jangar control-plane engineer.

## Implementation Scope

Engineer stage:

- Add `services/jangar/src/server/control-plane-material-verdict-authority.ts` as a pure reducer.
- Add typed status contracts in `services/jangar/src/server/control-plane-status-types.ts` and
  `services/jangar/src/server/control-plane-status-types.ts`.
- Wire the reducer in `control-plane-status.ts` after action clocks, material verdicts, source-rollout truth, and
  controller witness are built.
- Extend `/ready` to expose the authority summary while keeping `serve_readonly` semantics separate from material
  action admission.
- Add UI rendering that makes effective decisions primary and shows lower-level disagreements as debt.
- Add tests for:
  - action clock allow plus source-rollout hold yields effective hold;
  - execution trust healthy plus material-action hold keeps serving available but material action held;
  - controller heartbeat split creates owner-lane debt;
  - Torghut proof-floor repair-only blocks paper/live capital and allows observe/repair;
  - stale strict source can be superseded only by a fresher authority receipt.

Deployer stage:

- Add a deploy verification check that reads `material_verdict_authority.deployer_summary`.
- Stop treating raw action-clock allow as sufficient for deploy widening or merge-ready gates.
- Require authority receipt refs in release evidence for Jangar and Torghut changes.
- Keep direct database exec optional; if RBAC blocks CNPG SQL, the deployer must cite the typed API database witness
  and the RBAC error.

## Validation Gates

- Unit test: `action_clock=allow`, `source_rollout_truth=hold` produces `effective_decision=hold` with
  `strictest_source=source_rollout_truth_exchange`.
- Unit test: `execution_trust=healthy` and `material_action_verdict=hold` keeps `serve_readonly=allow` but holds
  `dispatch_normal`, `deploy_widen`, and `merge_ready`.
- Unit test: `heartbeat_projection_split` produces contradiction debt with owner lane `jangar_controller_engineer`.
- Unit test: Torghut `proof_floor_repair_only` plus missing capital-unlock receipt blocks `live_micro_canary` and
  `live_scale`.
- Integration fixture: current 2026-05-07 status shape produces held material actions and does not regress database or
  rollout health reporting.
- UI test: effective authority decision is visually primary over raw action-clock decisions.
- Deployer smoke: deploy-widen check fails closed when authority receipt is missing, stale, or held.

## Rollout And Rollback

Rollout sequence:

1. `shadow`: publish authority receipts and debt without changing existing action gates.
2. `warn`: mark status degraded when lower-level allow conflicts with stricter hold.
3. `enforce_non_capital`: require authority receipts for dispatch, deploy widening, and merge-ready.
4. `enforce_capital`: require authority receipts plus Torghut capital-unlock receipts for paper/live capital actions.

Rollback is configuration-first. Return the authority to `shadow`, keep receipts visible, and let existing gates
continue. Do not delete contradiction debt until every downstream consumer is back on older fields. If authority
calculation fails, status should expose `material_verdict_authority.status=unknown`, keep `serve_readonly` available,
and hold material actions rather than falling back to optimistic raw gates.

## Risks

- The authority can become another layer of indirection if clients continue to read old fields. Deployer and engineer
  gates must consume the authority receipt before enforcement.
- Ranking strictest decision can over-hold work during stale-source windows. That is why stale strict sources can only
  be superseded by fresher explicit authority, not ignored.
- Owner-lane mapping may be wrong for some contradiction types. The first implementation should keep mapping simple and
  emit unknown-owner debt rather than guessing.
- Surfacing more holds may feel like a regression. It is not; it is the control plane naming the true material-action
  state.

## Handoff Contract

Engineer acceptance:

- A current `source_rollout_truth_exchange` hold overrides a raw action-clock allow for the same material action.
- Healthy execution trust does not hide material-action holds.
- The reducer is pure, deterministic, and covered by fixture tests from the 2026-05-07 status split.
- `/ready` keeps `serve_readonly` independent from material-action admission.
- Contradiction debt includes owner lane, repair action, expiry, and rollback target.

Deployer acceptance:

- Deploy widening and merge-ready checks consume `material_verdict_authority`, not raw action clocks.
- Release evidence includes the authority receipt ID and the strictest source for every material action widened.
- Rollback to `shadow` mode is tested before non-capital enforcement.
- Capital enforcement is not enabled until Torghut capital-unlock receipts are present and fresh.

Torghut handoff:

- Torghut must publish capital-unlock receipts that prove a repair closed a blocker before paper or live capital is
  allowed.
- Missing capital-unlock receipts keep `paper_canary`, `live_micro_canary`, and `live_scale` held or blocked even when
  infrastructure dependencies are healthy.
- Zero-notional observe and repair remain available when Jangar authority allows those action classes.
