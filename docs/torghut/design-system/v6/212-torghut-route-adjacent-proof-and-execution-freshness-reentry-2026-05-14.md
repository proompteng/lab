# 212. Torghut Route-Adjacent Proof And Execution-Freshness Reentry (2026-05-14)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-14
Owner: Gideon Park, Torghut Traders Architecture
Scope: Torghut route-adjacent workload proof, execution freshness, alpha-readiness no-delta reentry, zero-notional
repair lots, validation gates, rollout, rollback, and cross-swarm handoff.

Companion Jangar contract:

- `docs/agents/designs/206-jangar-route-adjacent-proof-custody-and-torghut-reentry-admission-2026-05-14.md`

Extends:

- `211-torghut-controller-ingestion-carry-and-alpha-no-delta-release-2026-05-14.md`
- `210-torghut-source-bound-verification-carry-import-and-no-delta-release-2026-05-14.md`
- `209-torghut-verification-carry-import-and-alpha-repair-release-2026-05-14.md`
- `208-torghut-jangar-verification-carry-bridge-and-no-delta-reentry-market-2026-05-14.md`
- `206-torghut-no-delta-repair-reentry-auction-and-verification-carry-2026-05-14.md`
- `205-torghut-alpha-readiness-settlement-conveyor-and-routeable-profit-runway-2026-05-14.md`
- `188-torghut-evidence-clock-arbiter-and-routeable-profit-candidate-exchange-2026-05-12.md`
- `186-torghut-routeability-acceptance-cutover-and-fill-quality-loop-2026-05-08.md`

## Decision

I am selecting **route-adjacent proof plus execution-freshness reentry** as Torghut's next architecture slice.

The current live system is safer than it was earlier today, but it is still not revenue-ready. Controller-ingestion
carry is no longer absent; `/trading/revenue-repair` now emits it and classifies it as `lagging`. That is progress.
The profit blocker has moved to the next boundary: Torghut cannot prove that the active route-adjacent workloads and
active-session execution samples are fresh enough to let alpha-readiness repair produce a routeable candidate.

The evidence is concrete. `/trading/revenue-repair` is `repair_only`, `revenue_ready=false`, `capital_state=zero_notional`,
and `max_notional=0`. The top queue item is still `repair_alpha_readiness`, reason
`hypothesis_not_promotion_eligible`, value gate `routeable_candidate_count`, and required output
`torghut.executable-alpha-receipts.v1`. The route evidence clearinghouse says source freshness is current, but execution
freshness is held for stale active-session execution samples, rollout image proof is held for
`route_adjacent_workload_proof_missing`, profit-window custody is held, and capital is held. The execution book has
fresh computation, but its newest execution sample is from 2026-04-02.

The selected design adds a Torghut-side proof import and repair ticket model. Torghut should consume Jangar's
route-adjacent custody object, convert it into `torghut.route-adjacent-workload-proof.v1`, and let no-delta reentry
select exactly one zero-notional ticket when the missing proof is repairable. The first implementation should target
`zero_notional_or_stale_evidence_rate` and `fill_tca_or_slippage_quality`; only after those move should we expect
`routeable_candidate_count` to improve.

The tradeoff is that H-MICRO-01 remains denied while proof is lagging. I accept that. A repeat alpha launch against an
unchanged no-delta key is not innovation; it is churn. The leverage is to make the next repair receipt attributable
enough that routeability can move without touching live capital.

## Governing Runtime Requirements

This design is the governing Torghut requirement for the next implementation stage:

- every code-changing run must cite this doc or the companion Jangar doc;
- implementation PRs must improve data freshness, execution quality, routeability evidence, or capital safety;
- verification must prove image promotion, Argo sync, live service health, and revenue-repair status after rollout;
- final handoff must name the revenue metric improved or the smallest blocker preventing revenue impact.

Value-gate mapping:

- `post_cost_daily_net_pnl`: no direct movement in this slice; it remains blocked until routeable candidates exist and
  capital gates pass.
- `routeable_candidate_count`: the selected alpha-readiness repair remains H-MICRO-01 or its successor, and it must
  show a changed release condition before another zero-delta alpha launch is allowed.
- `zero_notional_or_stale_evidence_rate`: route-adjacent workload proof and execution freshness must become current
  before stale-evidence debt can fall.
- `fill_tca_or_slippage_quality`: active-session execution sample age, missing expected-shortfall samples, and slippage
  guardrail state are first-class gates.
- `capital_gate_safety`: every repair stays `max_notional=0`; live submit and paper widening remain disabled.

## Current Assessment

All evidence was collected read-only on 2026-05-14 between 20:24Z and 20:27Z.

### Cluster Assessment

- Argo reported `agents`, `jangar`, and `torghut` as `Synced/Healthy` at
  `57095de61842f69a8dce99b09afec438c46a5945`.
- Torghut live revision `torghut-00417` was running with `2/2` containers ready. Torghut sim revision
  `torghut-sim-00512`, options catalog, options enricher, TA, websocket, ClickHouse, and guardrail exporter pods were
  running.
- Recent events showed execution TCA refresh jobs starting and completing every five minutes.
- Several old profit-feedback and whitepaper autoresearch pods were failed. Those failures explain why empirical and
  profit-feedback evidence should be treated as debt until selected receipts prove otherwise.

### Source Assessment

- The current branch is based on main `57095de61842f69a8dce99b09afec438c46a5945`.
- The relevant merged Torghut history includes controller-ingestion carry import, Jangar carry evidence import,
  no-delta repair reentry auction, and carry ticket restriction fixes.
- High-risk modules for the next implementation are:
  - `services/torghut/app/trading/revenue_repair.py`;
  - `services/torghut/app/trading/evidence_clock_arbiter.py`;
  - `services/torghut/app/trading/no_delta_repair_reentry_auction.py`;
  - `services/torghut/app/trading/jangar_controller_ingestion_carry.py`;
  - `services/torghut/tests/test_build_revenue_repair_digest.py`;
  - `services/torghut/tests/test_no_delta_repair_reentry_auction.py`.
- Existing tests already protect digest assembly, no-delta selection, controller-ingestion carry classification, and
  consumer evidence exposure. The missing regression family is route-adjacent proof custody: healthy Argo with missing
  route proof, fresh TCA computation with stale execution samples, repairable route proof selected, contradictory proof
  denied, and capital held throughout.

### Database And Data Assessment

- `/db-check` returned `ok=true`, `schema_current=true`, and `schema_graph_lineage_ready=true`.
- Direct CNPG cluster reads and Postgres exec are blocked for the swarm worker by RBAC. That is acceptable for this
  role and should not be bypassed for normal planning or verification.
- Revenue repair is the live business evidence surface. It reports:
  - `business_state=repair_only`;
  - `revenue_ready=false`;
  - `route_state=repair_only`;
  - `capital_state=zero_notional`;
  - `max_notional=0`;
  - source freshness `current`;
  - execution freshness `hold`;
  - rollout image proof `hold`;
  - profit-window custody `hold`;
  - capital hold `hold`.
- Execution freshness details are internally inconsistent in a useful way: `last_computed_at` is fresh, but
  `latest_execution_created_at=2026-04-02T19:00:29.586040+00:00`. The next repair must prove fresh samples, not only a
  successful refresh job.

### Business Evidence

- The active top queue item is `repair_alpha_readiness`, reason `hypothesis_not_promotion_eligible`, value gate
  `routeable_candidate_count`, required output `torghut.executable-alpha-receipts.v1`, `max_notional=0`.
- Controller-ingestion carry is present with `carry_state=lagging`, settlement decision `hold`, and reasons including
  `source_serving_block`, `torghut_verification_carry_unavailable`, and `empirical_jobs_degraded`.
- No-delta reentry remains denied. The selected ticket is `none`.
- The repair bid book names top zero-notional debts across forecast registry, autoresearch candidates, hypothesis
  promotion eligibility, empirical jobs, simple submit, alpha readiness, execution TCA, and route-adjacent workload
  proof.

## Problem

Torghut has enough source and controller evidence to know that the previous blocker evolved, but it cannot yet retire
the route-adjacent and execution freshness blockers. The current model still allows four bad interpretations:

1. A healthy Argo application can be mistaken for fresh route proof.
2. A completed TCA cron job can be mistaken for current active-session execution samples.
3. A lagging Jangar carry state can be mistaken for a changed no-delta release condition.
4. A broad empirical repair can consume capacity while the top alpha-readiness routeability queue stays unchanged.

The architecture must make those interpretations impossible.

## Alternatives Considered

### Option A: Prioritize Empirical Jobs

Torghut would route the next engineer stage to repair empirical job readiness and autoresearch candidates.

Advantages:

- Empirical jobs are visible in the repair queue.
- Failed profit and whitepaper pods show real debt.
- It could improve future post-cost PnL evidence.

Disadvantages:

- It does not clear `route_adjacent_workload_proof_missing`.
- It does not address stale active-session execution samples.
- It can leave H-MICRO-01 with zero routeable candidates.

Decision: reject as the next architecture slice, but keep as a later repair once route-adjacent proof is settled.

### Option B: Run Another Alpha-Readiness Repair

Torghut would re-run H-MICRO-01 alpha readiness after the controller-ingestion carry changes.

Advantages:

- It directly targets the top queue item.
- It keeps the value gate focused on `routeable_candidate_count`.
- It is easy to explain to the business owner.

Disadvantages:

- Live no-delta reentry says the release key is still active and selected ticket is none.
- Carry is `lagging`, not current or repairable.
- It risks another zero-delta launch without retiring the proof gap.

Decision: reject until route-adjacent proof or execution freshness changes.

### Option C: Route-Adjacent Proof Plus Execution-Freshness Reentry

Torghut imports route-adjacent proof custody, models active-session execution freshness explicitly, and only selects a
zero-notional no-delta reentry ticket when a missing proof can be repaired.

Advantages:

- It targets the live proof blockers.
- It preserves capital safety.
- It gives Jangar and deployer stages a single acceptance surface.
- It creates measurable movement before asking routeable candidates to change.
- It is robust to healthy Argo with stale execution data.

Disadvantages:

- It adds another import and compact receipt path.
- It requires careful tests around stale samples and source/serving split.
- It can hold alpha repair longer than operators may want.

Decision: select Option C.

## Architecture

Torghut adds three additive evidence contracts.

### Route-Adjacent Workload Proof

`torghut.route-adjacent-workload-proof.v1` is a compact import from Jangar custody plus local runtime facts.

```yaml
schema_version: torghut.route-adjacent-workload-proof.v1
proof_id: route-adjacent-workload-proof:<digest>
generated_at: <iso8601>
fresh_until: <iso8601>
source_jangar_custody_ref: <id|null>
source_commit: <sha>
serving_revision: <revision>
serving_image_digest: <digest>
workloads:
  torghut_live: current|missing|stale|split
  torghut_sim: current|missing|stale|split
  options_catalog: current|missing|stale|split
  options_enricher: current|missing|stale|split
  execution_tca_refresh: current|missing|stale|split
state: current|repairable|hold|block
reason_codes: []
max_notional: '0'
rollback_target: <string>
```

### Execution Freshness Sweep

`torghut.execution-freshness-sweep-receipt.v1` proves that active-session execution samples, expected-shortfall inputs,
and slippage quality are current.

```yaml
schema_version: torghut.execution-freshness-sweep-receipt.v1
receipt_id: execution-freshness-sweep:<digest>
generated_at: <iso8601>
account_id: <account>
window: <window>
latest_execution_created_at: <iso8601|null>
last_computed_at: <iso8601|null>
max_age_seconds: <number>
avg_abs_slippage_bps: <number|null>
expected_shortfall_sample_count: <number>
state: current|stale|missing|non_promoting
value_gate: fill_tca_or_slippage_quality
max_notional: '0'
reason_codes: []
```

### Reentry Ticket

`torghut.route-adjacent-reentry-ticket.v1` is the only ticket no-delta reentry can select from this design.

```yaml
schema_version: torghut.route-adjacent-reentry-ticket.v1
ticket_id: route-adjacent-reentry-ticket:<digest>
selected_queue_code: repair_alpha_readiness
selected_value_gate: routeable_candidate_count
repair_class: route_adjacent_proof|execution_freshness
required_output_receipt: torghut.route-adjacent-workload-proof.v1|torghut.execution-freshness-sweep-receipt.v1
release_condition: route_adjacent_proof_current|active_execution_samples_current
max_notional: '0'
validation_commands: []
```

No-delta reentry rules:

1. Deny repeat alpha repair while `carry_state=lagging`, route-adjacent proof is missing, and active execution samples
   are stale.
2. Select one route-adjacent or execution freshness ticket only when the imported proof says the ticket is repairable.
3. Do not select empirical, market-context, or submit-gate repair ahead of the top alpha-readiness queue unless the
   live top queue changes.
4. Keep all selected tickets zero-notional.
5. Treat missing Jangar custody as hold, not allow.

## Implementation Milestones

Milestone 1: custody import and digest exposure.

- Value gates: `zero_notional_or_stale_evidence_rate`, `capital_gate_safety`.
- Add Torghut import and compact ref for Jangar route-adjacent custody.
- Expose it in `/trading/revenue-repair` and `/trading/consumer-evidence`.
- Add tests for missing, stale, repairable, current, and contradictory custody.

Milestone 2: execution freshness sweep.

- Value gates: `fill_tca_or_slippage_quality`, `zero_notional_or_stale_evidence_rate`.
- Prove active-session sample age and expected-shortfall sample count separately from cron job recency.
- Add tests for fresh computation with stale executions.

Milestone 3: no-delta reentry selection.

- Value gates: `routeable_candidate_count`, `capital_gate_safety`.
- Permit exactly one zero-notional route-adjacent or execution freshness ticket when a release condition changes.
- Deny alpha re-run until the selected receipt is current.

Milestone 4: deployer verification.

- Value gates: all five, with no direct `post_cost_daily_net_pnl` claim unless routeable candidates and capital gates
  move.
- Verify Argo sync, service health, image promotion, revenue repair, consumer evidence, and zero-notional capital.

## Validation Gates

Local validation for implementation PRs:

- `uv sync --frozen --extra dev` in `services/torghut`.
- Targeted pytest for revenue repair digest, consumer evidence, no-delta reentry, and the new proof models.
- Ruff check and format check for touched Python.
- Pyright with all three Torghut profiles if Python source changes.
- Jangar targeted TypeScript tests if the companion custody reducer changes Jangar code.

Runtime validation after promotion:

- Argo `agents`, `jangar`, and `torghut` are `Synced/Healthy`.
- Torghut active revision and image digest match the promoted source.
- `/db-check` remains `ok=true`, `schema_current=true`, and `schema_graph_lineage_ready=true`.
- `/trading/revenue-repair` emits route-adjacent proof and execution freshness receipts.
- `route_adjacent_workload_proof_missing` and active execution sample staleness either retire or are preserved with a
  named blocker.
- `capital_state=zero_notional`, `max_notional=0`, and live submission remains disabled.

## Rollout

Roll out observe-mode evidence first:

1. Merge Jangar custody and Torghut import code with green CI.
2. Promote through the existing CI/CD and GitOps pipeline.
3. Verify Argo and workload readiness.
4. Verify revenue repair, consumer evidence, and db-check.
5. Hold no-delta selection until at least one fresh custody window agrees across Jangar and Torghut.
6. Enable no-delta ticket selection only for zero-notional route-adjacent or execution freshness repair.

## Rollback

Rollback is a deletion or feature flag rollback of the additive evidence:

- Stop emitting route-adjacent custody from Jangar.
- Torghut treats missing custody as hold and keeps controller-ingestion carry plus no-delta auction behavior.
- Remove route-adjacent ticket selection from no-delta reentry.
- Keep existing alpha-readiness settlement, dividend ledger, and capital hold intact.
- Capital remains zero-notional.

## Risks

- Healthy workload status can hide stale data. Validation must compare active execution sample age, not just pod
  readiness.
- Failed historical profit jobs can pollute the proof surface. Only active selected proof sources should affect the
  custody decision.
- A route proof receipt can reduce stale-evidence debt without moving routeable candidates. That is acceptable for the
  first slice, but the handoff must avoid claiming PnL impact until routeable candidates and capital gates move.
- Direct database access is unavailable by design. If db-check and typed evidence disagree, typed evidence wins for
  capital safety and the database mismatch is a blocker.

## Handoff

Engineer: implement milestones 1 and 2 as one bounded production PR only if the diff stays small. Otherwise implement
milestone 1 first. Cite this design before changing Torghut code. The smallest acceptable revenue movement is retiring
`route_adjacent_workload_proof_missing` or reducing stale-evidence debt while capital remains zero-notional.

Deployer: after promotion, verify Argo sync, active revision, `/db-check`, `/trading/revenue-repair`, and
`/trading/consumer-evidence`. Do not claim live trading readiness until routeable candidates are nonzero, TCA quality is
current, and capital gates independently authorize notional.
