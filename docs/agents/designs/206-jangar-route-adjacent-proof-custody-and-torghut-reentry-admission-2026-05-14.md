# 206. Jangar Route-Adjacent Proof Custody And Torghut Reentry Admission (2026-05-14)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-14
Owner: Gideon Park, Torghut Traders Architecture
Scope: Jangar control-plane custody for Torghut route-adjacent proof, execution freshness, no-delta reentry admission,
zero-notional repair dispatch, rollout evidence, rollback, and cross-swarm handoff.

Companion Torghut contract:

- `docs/torghut/design-system/v6/212-torghut-route-adjacent-proof-and-execution-freshness-reentry-2026-05-14.md`

Extends:

- `205-jangar-controller-ingestion-settlement-and-verification-carry-cutover-2026-05-14.md`
- `204-jangar-source-bound-verification-carry-exchange-and-repair-slot-reconciliation-2026-05-14.md`
- `203-jangar-foreclosure-carry-rollout-witness-and-stage-debt-repair-2026-05-14.md`
- `201-jangar-verify-trust-foreclosure-and-alpha-repair-reentry-2026-05-14.md`
- `200-jangar-revenue-repair-settlement-conveyor-and-stage-health-custody-2026-05-14.md`
- `188-jangar-ready-truth-arbiter-and-stage-credit-cutover-2026-05-13.md`

## Decision

I am selecting **route-adjacent proof custody with bounded Torghut reentry admission** as the next Jangar control-plane
increment.

The previous carry work did what we asked. Torghut now receives `torghut.jangar-controller-ingestion-carry.v1` from
live revenue repair, and Jangar exposes `jangar.controller-ingestion-settlement.v1`. That changed the failure mode from
opaque missing carry to a precise `lagging` carry state. It did not make revenue routeable. Live Torghut still reports
`business_state=repair_only`, `revenue_ready=false`, `routeable_candidate_count=0`, and `max_notional=0`. The new
blocking shape is route-adjacent proof and execution freshness: live revenue repair names
`route_adjacent_workload_proof_missing`, `active_session_execution_samples_stale`,
`execution_tca_expected_shortfall_samples_missing_non_promoting`, `empirical_jobs_degraded`, and
`hypothesis_not_promotion_eligible`.

The system should not respond by launching broader repair traffic. Jangar should produce one compact custody object
that joins Torghut live revision, source commit, serving digest, route-adjacent workload readiness, execution TCA
refresh recency, empirical job state, and the active no-delta release key. Only then should stage clearance admit a
zero-notional repair ticket. Normal dispatch, paper canary, live micro canary, and live scale remain blocked until the
same custody object proves that route-adjacent proof and execution freshness are current.

The tradeoff is stricter admission. Some repairs that look useful in isolation will stay held because they do not
retire the top revenue queue item. I accept that. The business metric is routeable post-cost profit evidence with
capital safety intact, not repair volume.

## Governing Runtime Requirements

This contract implements the current swarm validation contract:

- every run must cite the governing design or runtime requirement before changing code;
- implementation stages must ship production PRs that improve readiness, profit evidence, data freshness, execution
  quality, or capital safety;
- verification stages must merge only green PRs and prove image promotion, Argo sync, live service health, and trading
  or evidence status after rollout;
- the final handoff must name the revenue metric improved or the smallest blocker preventing revenue impact.

Jangar value-gate mapping:

- `failed_agentrun_rate`: hold broad dispatch while route-adjacent proof is missing and no-delta release debt is
  active.
- `pr_to_rollout_latency`: one custody object carries source commit, serving digest, Argo revision, and Torghut active
  revision.
- `ready_status_truth`: `/ready.status=ok` remains serving truth; route-adjacent custody is material action truth.
- `manual_intervention_count`: operators no longer have to compare Argo, Knative revisions, Torghut revenue repair,
  and TCA refresh jobs by hand.
- `handoff_evidence_quality`: handoffs cite custody id, selected repair ticket, value gate, validation commands, and
  rollback target.

Torghut value-gate mapping:

- `routeable_candidate_count`: the selected repair must plausibly move H-MICRO-01 or a successor lane from zero to at
  least one routeable candidate.
- `zero_notional_or_stale_evidence_rate`: stale execution samples, missing route-adjacent proof, or stale empirical
  jobs keep the zero-notional stale-evidence rate high and capital locked.
- `fill_tca_or_slippage_quality`: execution freshness must be measured with current active-session samples, not only a
  recent cron run timestamp.
- `post_cost_daily_net_pnl`: no paper or live widening follows from custody alone.
- `capital_gate_safety`: all admitted repair tickets remain `max_notional=0`.

## Current Evidence

Evidence was collected read-only on 2026-05-14 between 20:24Z and 20:27Z. I did not mutate Kubernetes resources,
database records, AgentRuns, GitOps state, broker state, market data, or trading flags.

### Cluster, Rollout, And Events

- Argo reported `agents`, `jangar`, and `torghut` as `Synced/Healthy` at revision
  `57095de61842f69a8dce99b09afec438c46a5945`.
- Torghut served active revision `torghut-00417` on image digest
  `sha256:60dfc10974c03aa8909f2f8ddd42dc34fea56c7a44bea1a3be2dc29608d6a837`.
- Torghut live, sim, options catalog, options enricher, TA, websocket, guardrail exporters, and ClickHouse pods were
  running. Several old profit feedback and whitepaper autoresearch pods were failed, with exit codes including `2`,
  `127`, `143`, `255`, and wait-container artifact errors. Those failed pods are not serving-blocking, but they are
  evidence that profit-feedback and autoresearch runners should not be treated as healthy proof sources.
- Recent Torghut events showed execution TCA refresh jobs completing every five minutes. Revenue repair still reported
  `latest_execution_created_at=2026-04-02T19:00:29.586040+00:00`, so a recent refresh job alone does not prove active
  execution samples are current.

### Jangar Control-Plane Evidence

- Jangar `/ready` returned `status=ok`, leader election healthy, and `execution_trust.status=healthy`.
- Jangar control-plane status reported `dependency_quorum.decision=block`.
- `verify_trust_foreclosure_board` was present and fresh, but material actions still blocked dispatch repair with
  reasons including `source_rollout_truth_split`, `controller_witness_stale`, `torghut_no_delta_active`,
  `jangar_verification_carry_unavailable`, `jangar_controller_ingestion_settlement_missing`, and
  `revenue_repair_settlement_custody_deny`.
- `controller_ingestion_settlement` was present with `decision=hold`, `agentrun_ingestion_current=false`,
  `source_serving_status=block`, `torghut_verification_carry_status=unavailable`, and selected repair reason codes
  `source_serving_block` and `torghut_verification_carry_unavailable`.

### Torghut Business Evidence

- `/trading/revenue-repair` returned `business_state=repair_only`, `revenue_ready=false`, `route_state=repair_only`,
  `capital_state=zero_notional`, and `max_notional=0`.
- The active source commit in revenue repair was `03213d0bd7f1be055cafc3031c1b792ade249dd4`.
- The top repair queue item remained `repair_alpha_readiness` with reason
  `hypothesis_not_promotion_eligible`, value gate `routeable_candidate_count`, required output
  `torghut.executable-alpha-receipts.v1`, and `max_notional=0`.
- Torghut emitted `jangar_controller_ingestion_carry.carry_state=lagging` with source settlement ref
  `controller-ingestion-settlement:*`, verification board ref `verify-trust-foreclosure-board:*`, repair-slot escrow
  ref `repair-slot-escrow:*`, and reason codes including `empirical_jobs_degraded`, `source_serving_block`,
  `torghut_verification_carry_unavailable`, `jangar_controller_ingestion_hold`, and
  `jangar_controller_ingestion_lagging`.
- Route evidence books reported source freshness current, execution freshness held, rollout image held because
  `route_adjacent_workload_proof_missing`, profit-window custody held, and capital held.
- The execution book had `order_count=5388`, `filled_execution_count=5353`, a fresh computation timestamp, but the
  newest execution sample remained more than 3.6 million seconds old.
- `/trading/consumer-evidence` exposed a compact controller-ingestion carry ref, but the active no-delta auction still
  denied reentry and selected no ticket.

### Database And Data Evidence

- `/db-check` returned `ok=true`, `schema_current=true`, and `schema_graph_lineage_ready=true`.
- CNPG cluster reads were blocked by RBAC:
  `clusters.postgresql.cnpg.io is forbidden` for the `agents-sa` service account in namespace `torghut`.
- Direct Postgres exec was blocked by RBAC:
  `pods/exec` forbidden on `torghut-db-1`.
- I am treating that access boundary as correct for swarm workers. Jangar should depend on typed service evidence and
  database health endpoints, not privileged direct database reads.

### Source And Test Surface

- Recent merged source history includes:
  - `feat(torghut): import controller ingestion carry`;
  - `fix(torghut): import jangar controller carry evidence`;
  - `fix(torghut): restrict jangar carry repair tickets`.
- Relevant Torghut tests now cover controller-ingestion carry classification, no-delta reentry selection and denial,
  revenue repair digest assembly, and consumer evidence exposure.
- High-risk modules for the next slice are Torghut `revenue_repair.py`, `evidence_clock_arbiter.py`,
  `no_delta_repair_reentry_auction.py`, `jangar_controller_ingestion_carry.py`, and Jangar control-plane status,
  stage-clearance, revenue-repair settlement custody, and Torghut evidence normalizers.

## Problem

The system can now say that Jangar carry exists and is lagging. It cannot yet say which route-adjacent proof must be
current before alpha reentry can make a routeable candidate. That leaves three failure modes:

1. Argo and Knative can look healthy while route-adjacent workload proof is missing.
2. TCA refresh jobs can complete while active execution samples remain stale.
3. No-delta alpha reentry can stay denied without a bounded repair ticket that names the route-adjacent proof gap.

The next architecture has to connect those surfaces without weakening the capital gate.

## Alternatives Considered

### Option A: Treat Argo Healthy And Revision Match As Route Proof

Jangar would accept Synced/Healthy Argo apps and live Torghut revision as enough proof to clear route-adjacent workload
debt.

Advantages:

- Minimal implementation cost.
- Fast deployer handoff.
- Easy for operators to understand.

Disadvantages:

- Live evidence disproves it. Argo is healthy while revenue repair still emits `route_adjacent_workload_proof_missing`.
- It ignores options catalog/enricher, sim, TCA refresh, and old failed profit-feedback pods.
- It could clear a capital safety hold from deployment health alone.

Decision: reject.

### Option B: Dispatch Execution TCA Refresh First

Jangar would select execution freshness repair whenever active-session samples are stale.

Advantages:

- Directly maps to `fill_tca_or_slippage_quality`.
- There is already a TCA refresh cron surface.
- It is bounded and zero-notional.

Disadvantages:

- It does not retire route-adjacent workload proof.
- Recent refresh jobs are already completing without making active execution samples current.
- It can burn repair slots while the top queue item remains alpha readiness.

Decision: reject as the sole architecture. Keep it as one input to custody.

### Option C: Route-Adjacent Proof Custody With Bounded Reentry Admission

Jangar emits a route-adjacent custody object and admits a zero-notional Torghut repair only when that object names a
specific missing proof.

Advantages:

- Targets the live blocker without broad dispatch.
- Separates serving health from material route proof.
- Gives deployers one acceptance object after image promotion.
- Keeps no-delta alpha repair denied until the release condition changes.
- Maintains `max_notional=0`.

Disadvantages:

- Adds a new reducer and companion Torghut import.
- Requires tests across Argo, Torghut evidence, and execution freshness.
- It may hold otherwise useful empirical or market-context repairs until route-adjacent proof is settled.

Decision: select Option C.

## Architecture

Jangar adds `jangar.route-adjacent-proof-custody.v1` to control-plane status and later to `/ready` after the payload is
small enough for the hot path.

Proposed schema:

```yaml
schema_version: jangar.route-adjacent-proof-custody.v1
custody_id: route-adjacent-proof-custody:<namespace>:<digest>
mode: observe|shadow|enforce
generated_at: <iso8601>
fresh_until: <iso8601>
namespace: agents
decision: allow|repair_only|hold|block
source_commit: <torghut source commit>
argo_revision: <gitops revision>
serving_revision: <torghut active revision>
serving_image_digest: <digest>
route_adjacent_workloads:
  torghut_live: current|missing|stale|split
  torghut_sim: current|missing|stale|split
  options_catalog: current|missing|stale|split
  options_enricher: current|missing|stale|split
  execution_tca_refresh: current|missing|stale|split
execution_freshness:
  state: current|stale|missing|non_promoting
  latest_execution_created_at: <iso8601|null>
  computed_at: <iso8601|null>
  avg_abs_slippage_bps: <number|null>
torghut_revenue_repair_ref: <route evidence clearinghouse id>
controller_ingestion_carry_ref: <carry id>
selected_repair_ticket:
  ticket_class: route_adjacent_proof|execution_freshness|none
  target_value_gate: routeable_candidate_count|fill_tca_or_slippage_quality|capital_gate_safety
  required_output_receipt: <receipt schema>
  validation_commands: []
  max_notional: '0'
reason_codes: []
rollback_target: <string>
```

Decision rules:

- `allow`: all route-adjacent workloads are current, execution freshness is current, controller-ingestion carry is
  current or repairable, and Torghut remains zero-notional until separate capital gates pass.
- `repair_only`: exactly one missing proof can be repaired with a bounded zero-notional ticket.
- `hold`: proof is stale, broad, or ambiguous, or Torghut no-delta debt is active without a changed release condition.
- `block`: proof is contradictory, source/serving digests split in a way that cannot be reconciled, or any nonzero
  notional path is requested.

Jangar stage clearance consumes the object this way:

- `serve_readonly`: allow when Jangar serving health is ok.
- `torghut_observe`: allow when Torghut revenue repair is reachable.
- `dispatch_repair`: allow only for the selected zero-notional ticket when `decision=repair_only`.
- `dispatch_normal`, `paper_canary`, `live_micro_canary`, `live_scale`, `deploy_widen`: hold or block until
  `decision=allow` and Torghut capital gates independently pass.
- `merge_ready`: remains governed by PR checks, but deployer handoffs must cite the custody object before claiming
  revenue-readiness movement.

## Implementation Scope

Engineer stage should implement the smallest production slice:

1. Add the Jangar route-adjacent custody reducer and tests for current, repair-only, hold, and contradiction states.
2. Add a compact ref to control-plane status; defer `/ready` until payload size and latency are proven.
3. Add Torghut import support for the custody ref in revenue repair and consumer evidence.
4. Convert `route_adjacent_workload_proof_missing` into a selected zero-notional ticket only when custody says the
   ticket is repairable.
5. Keep `max_notional=0`, live submit disabled, and no paper widening throughout the slice.

Do not implement broker submission, capital widening, or a generic empirical runner in this milestone.

## Validation Gates

Required local checks for the next implementation PR:

- Jangar targeted tests for route-adjacent custody and stage clearance admission.
- Torghut targeted tests for revenue repair digest, consumer evidence import, and no-delta reentry denial/selection.
- Format and lint checks for touched TypeScript and Python files.
- For `services/torghut`, all three Pyright profiles must pass when Python source changes:
  `pyrightconfig.json`, `pyrightconfig.alpha.json`, and `pyrightconfig.scripts.json`.

Required live verification after promotion:

- Argo `agents`, `jangar`, and `torghut` are `Synced/Healthy`.
- Jangar status emits `route_adjacent_proof_custody` with a fresh `custody_id`.
- Torghut `/trading/revenue-repair` emits the custody ref and no longer reports
  `route_adjacent_workload_proof_missing` if the selected proof is current.
- `routeable_candidate_count` is still `0` or improved with an explicit reason; no silent promotion is allowed.
- `capital_state=zero_notional`, `max_notional=0`, and live submit remains disabled until capital gates pass.

## Rollout

Roll out in observe mode first:

1. Merge the Jangar/Torghut implementation PR with green CI.
2. Let CI build and promote images through the existing GitOps pipeline.
3. Verify Argo sync and workload readiness.
4. Verify Jangar status and Torghut revenue repair surfaces.
5. Move from observe to shadow only after the custody object is stable across at least two refresh windows.
6. Consider enforce only after a repair-only ticket retires a named blocker without increasing notional.

## Rollback

Rollback is fail-closed:

- Stop emitting `route_adjacent_proof_custody`.
- Torghut treats missing custody as `hold`, preserves existing controller-ingestion carry behavior, and keeps
  no-delta reentry denied.
- Jangar stage clearance falls back to existing controller-ingestion settlement, verification foreclosure board, and
  revenue-repair settlement custody.
- Capital remains zero-notional.

## Risks

- A reducer that overtrusts Argo health could clear a proof hold without fresh execution samples. Tests must include
  healthy Argo with stale executions.
- A reducer that overtrusts TCA cron completion could clear a stale execution sample hold. Tests must include a fresh
  computation timestamp with old `latest_execution_created_at`.
- Old failed profit-feedback pods can create noisy evidence. The reducer should ignore terminal historical pods unless
  they are selected proof sources for the active ticket.
- Direct database access is intentionally unavailable to normal swarm workers. The architecture must keep using typed
  service evidence, not privileged SQL.

## Handoff

Engineer: implement the route-adjacent custody reducer and Torghut import as a zero-notional production slice. Cite
this doc and the companion Torghut doc before changing code. The first revenue metric to move is
`zero_notional_or_stale_evidence_rate`; the next route metric is `routeable_candidate_count`.

Deployer: after merge and promotion, verify the custody object is fresh, Argo is healthy, Torghut revenue repair still
holds capital at zero notional, and either `route_adjacent_workload_proof_missing` is retired or the exact remaining
reason is named.
