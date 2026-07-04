# 186. Torghut Routeability Acceptance Cutover And Fill-Quality Loop (2026-05-08)

Status: Accepted for engineer and deployer handoff

## Source Implementation Audit (2026-07-04)

- Source baseline inspected: `6473f3ee7 ci(arc): fit ten lab runners per node (#11877)`.
- Implementation status: Partially implemented and evolved: execution route/gate/status modules exist, with live submission controlled by scheduler and submission-council gates.
- Matched implementation area: Execution, live submission, and broker path.
- Current source evidence:
  - `services/torghut/app/trading/execution_runtime.py`
  - `services/torghut/app/trading/execution_adapters/adapter_types.py`
  - `services/torghut/app/trading/execution_policy/order_rules.py`
  - `services/torghut/app/trading/submission_council/__init__.py`
  - `services/torghut/app/trading/scheduler/pipeline/submission_policy.py`
- Design drift note: Old monolithic order executor/live path claims are stale; current source uses split execution/runtime/gate modules.


## Decision

I am selecting a **routeability acceptance cutover with a fill-quality proof loop** as Torghut's next architecture
step.

The acceptance-ledger design is right, and the implementation candidate is already visible in PR #6127. The live
runtime has not adopted it yet. At `2026-05-08T16:12Z`, Torghut was serving live revision `torghut-00311`, but
`/trading/status`, `/trading/revenue-repair`, and `/trading/consumer-evidence` still returned
`routeability_acceptance_ledger=null`. The runtime remained `repair_only`: live submission was blocked by
`simple_submit_disabled`, the proof floor held capital at `zero_notional`, alpha readiness had three shadow hypotheses
with zero promotion-eligible hypotheses, and `routeable_candidate_count` stayed `0`.

The fresh evidence says routeability must now be promoted from a proposed ledger to a cutover contract. A Torghut
route can count only after the live service emits the acceptance ledger, the lot receipts settle, and fill-quality
proof is fresh enough for the active route. Historical TCA is useful but not sufficient: current `/trading/tca` shows
7,334 orders and average absolute slippage near `13.82` bps, but the latest execution timestamp is
`2026-04-02T19:00:29Z`, and AMZN, GOOGL, and ORCL still have zero route samples. Quant and context are also partial:
Jangar quant health has latest metrics, but scoped stage lag can be hundreds of thousands of seconds, while market
context remains degraded by stale news.

The tradeoff is that routeable candidate count will remain zero longer. I accept that. A routeable candidate that has
not passed current fill-quality, scoped quant, context, alpha, and Jangar admission receipts is not a business asset.
It is unretired proof debt.

## Evidence Snapshot

All evidence was collected read-only. I did not mutate Kubernetes resources, database rows, broker state, trading
flags, GitOps manifests, or AgentRun objects.

### Cluster And Rollout

- Local work is on `codex/swarm-torghut-quant-discover` at `main` commit
  `5b5e94d175626ac94d4ea3c5d9152522824e2bd3`.
- Argo reports `jangar`, `agents`, `torghut`, and `torghut-options` as `Synced` and `Healthy`.
- Jangar pod `jangar-77c49fd877-t4vcg` is `2/2 Running`; `deployment/jangar` is `1/1`.
- `deployment/agents-controllers` is `2/2`, and both controller pods are ready, but recent events still include
  readiness probe timeouts and one `BackoffLimitExceeded` schedule attempt.
- Torghut live pod `torghut-00311-deployment-59b74ddc99-8vhdk` and sim pod
  `torghut-sim-00409-deployment-5b8b455c84-t52lm` are each `2/2 Running`.
- Torghut ClickHouse and Postgres pods are running; recent events still show repeated ClickHouse multiple-PDB warnings
  and a no-pods Keeper PDB warning.
- Some Torghut whitepaper/autoresearch jobs are in Error, so research automation health is weaker than live serving
  health.

### Runtime And Data

- `/healthz` returns HTTP 200.
- `/readyz` and `/trading/health` return `status=degraded`; Postgres, ClickHouse, broker connectivity, schema, and
  universe checks are OK.
- `/db-check` returns `ok=true`, expected Alembic head `0030_evidence_epochs`, schema graph branch count `1`, and
  known parent-fork warnings at `0010...` and `0015...`.
- Direct secret and database access is forbidden for `system:serviceaccount:agents:agents-sa`, so database evidence for
  this pass comes from the Torghut runtime database contracts and Kubernetes endpoints.
- `/trading/status` reports `enabled=true`, `mode=live`, `running=true`, live submission
  `allowed=false`, and blocked reasons `hypothesis_not_promotion_eligible` and `simple_submit_disabled`.
- `profit_signal_quorum` reports three observe-only quorums, three zero-notional quorums, zero paper candidates, zero
  routeable candidates, and fourteen blocked or stale evidence cells.
- `/trading/revenue-repair` reports `business_state=repair_only`, `revenue_ready=false`, and blockers
  `hypothesis_not_promotion_eligible`, `market_context_stale`, `simple_submit_disabled`, and
  `quant_pipeline_stages_missing`.
- `/trading/consumer-evidence` reports route-proven profit state `repair`, proof floor `repair_only`,
  capital state `zero_notional`, seven zero-notional repair lots, and zero routeable candidates.
- `routeability_acceptance_ledger` is absent from the live Torghut status, revenue repair, and consumer evidence
  payloads.
- Jangar quant health for `PA3SX7FYNUTF/15m` reports `ok=true`, `status=degraded`, latest metrics count `180`, runtime
  enabled and started, scoped pipeline health enabled, six stage rows in the direct sample, and max stage lag
  `610572` seconds.
- Torghut's own sampled quant evidence still reports `quant_metrics_update_missing` and, in some payloads,
  `quant_pipeline_stages_missing` with zero stages, so the contract must treat scoped stage evidence as unstable until
  the acceptance ledger records the settled stage view.
- Market context is degraded: technicals, fundamentals, and regime are OK in the current Jangar route, but news is
  stale at about `1861` seconds against a `600` second budget.
- TCA has 7,334 orders, 7,245 filled executions, average absolute slippage about `13.82` bps, and latest execution
  creation at `2026-04-02T19:00:29Z`; AMZN, GOOGL, and ORCL have no route samples.

### Source And Test Surface

- `services/torghut/app/main.py` is 5,298 lines and already assembles readiness, status, revenue repair, consumer
  evidence, and trading health. The cutover must stay in pure reducers under `services/torghut/app/trading/`.
- `profit_signal_quorum.py`, `profit_repair_settlement.py`, `quality_adjusted_profit_frontier.py`,
  `route_reacquisition.py`, and `tca.py` are the relevant upstream proof producers.
- Existing tests cover profit-signal quorum, revenue repair, capital reentry, route/TCA evidence, quant readiness, and
  consumer evidence.
- The missing test is the cutover invariant: a route cannot become accepted merely because the implementation PR is
  green, a pod is healthy, or latest metrics are fresh. It must be present in the live payload and pass fill-quality
  proof.

## Problem

Torghut now has an architecture and an implementation candidate for routeability acceptance, but production still lacks
the live acceptance surface. That creates a dangerous middle state:

1. Operators can see a green or clean PR and overread it as production proof.
2. Live runtime can serve while acceptance-ledger fields remain absent.
3. Fresh latest metrics can coexist with stale scoped stage evidence.
4. Historical TCA can coexist with no active-session route samples for several symbols.
5. A market-context bundle can be mostly fresh while a required domain is stale.
6. Repair jobs can complete without retiring a routeability lot or improving routeable candidate count.

The system needs a cutover contract that separates proposed implementation, deployed payload presence, lot
acceptance, and current fill-quality proof.

## Alternatives Considered

### Option A: Count #6127 As The Cutover Once CI Is Green

Advantages:

- Fastest path to an operator milestone.
- PR #6127 is clean and its visible checks are green.
- Minimizes design churn because the acceptance ledger is already specified.

Disadvantages:

- #6127 changes more than 1,000 lines and is blocked by the mandatory Codex review-capacity gate.
- A green PR is not runtime adoption.
- Live payloads still return `routeability_acceptance_ledger=null`.
- It would blur CI proof with capital proof.

Decision: reject. PR state is audit evidence, not routeability acceptance.

### Option B: Wait For Full `/readyz=ok` Before Any Routeability Acceptance Work Counts

Advantages:

- Simple and conservative.
- Prevents any routeability inflation.
- Keeps deployer verification easy.

Disadvantages:

- Blocks zero-notional repairs that are required to make `/readyz` healthy.
- Treats route/TCA, quant-stage, context, alpha, and submit-gate debt as one class.
- Does not tell engineer stages which proof lot must be retired next.

Decision: reject as the normal path. Keep it for paper/live notional.

### Option C: Acceptance Cutover With Fill-Quality Proof Loop

Advantages:

- Separates implementation readiness from live runtime adoption.
- Lets zero-notional proof repair continue while routeable candidates stay at zero.
- Requires active fill/TCA quality before routeability count increases.
- Gives Jangar one cutover packet to use for admission and backpressure.
- Maps directly to `routeable_candidate_count`, `zero_notional_or_stale_evidence_rate`,
  `fill_tca_or_slippage_quality`, and `capital_gate_safety`.

Disadvantages:

- Adds one more packet and one more deployer check.
- Requires careful clock handling because quant stage evidence can differ between direct Jangar and Torghut samples.
- Keeps the revenue path conservative while proof quality catches up.

Decision: select Option C.

## Architecture

Torghut adds a cutover packet around the existing acceptance ledger:

```text
routeability_acceptance_cutover_packet
  schema_version
  cutover_id
  generated_at
  fresh_until
  torghut_revision
  source_commit
  acceptance_ledger_ref
  acceptance_ledger_present
  acceptance_ledger_schema_version
  profit_signal_quorum_ref
  revenue_repair_ref
  consumer_evidence_ref
  jangar_routeability_admission_ref
  fill_quality_clock
  scoped_quant_clock
  market_context_clock
  alpha_readiness_clock
  lot_acceptance_summary
  accepted_routeable_candidate_count
  zero_notional_or_stale_evidence_rate
  capital_decision
  rollback_target
```

The fill-quality clock is explicit:

```text
fill_quality_clock
  latest_execution_created_at
  latest_tca_computed_at
  route_sample_symbols
  missing_route_sample_symbols
  average_abs_slippage_bps
  p95_abs_slippage_bps
  expected_shortfall_coverage
  decision
  reason_codes[]
```

Rules:

- If `acceptance_ledger_present=false`, accepted routeable candidates must be zero.
- If any required lot is `missing`, `stale`, `blocked`, or `repairing`, accepted routeable candidates must be zero.
- If the fill-quality clock is stale for the active session, the lot may remain a repair candidate but cannot be
  routeable.
- If scoped quant stage evidence is missing or materially stale, the lot remains stale even when latest metrics exist.
- If market-context news or another required domain is stale, event-sensitive lots remain blocked.
- `simple_submit_disabled` and `proof_floor=repair_only` keep paper and live notional at zero regardless of ledger
  state.
- Jangar admission can allow only named zero-notional repair work until the cutover packet is present and settled.

## Implementation Scope

Engineer milestone 1:

- Land the routeability acceptance ledger with tests and keep all unsettled lots at zero notional.
- Expose the ledger in `/readyz`, `/trading/status`, `/trading/revenue-repair`, and `/trading/consumer-evidence`.
- Add a cutover packet that records whether the live payload is present and which lots are accepted.

Engineer milestone 2:

- Add the fill-quality clock from current route/TCA samples.
- Treat AMZN, GOOGL, and ORCL as missing route samples until active-session evidence exists.
- Treat the latest execution timestamp of `2026-04-02T19:00:29Z` as stale for paper/live routeability.

Engineer milestone 3:

- Feed the cutover packet into Jangar routeability admission.
- Deny `routeable_candidate_claim`, `paper_route_probe`, and `live_submission` while the packet is absent or unsettled.

Deployer milestone:

- Prove the live service emits the ledger and cutover packet after rollout.
- Prove `accepted_routeable_candidate_count=0` until current fill-quality, scoped quant, context, alpha, forecast, and
  Jangar receipts settle.
- Record the rollback target and prior known-good Torghut digest before any enforcement is enabled.

## Validation Gates

- `post_cost_daily_net_pnl`: no PnL improvement is claimed until a settled paper route records post-cost evidence.
- `routeable_candidate_count`: remains zero while the live acceptance ledger is absent or unsettled.
- `zero_notional_or_stale_evidence_rate`: every missing lot, stale domain, stale fill clock, and scoped stage gap is
  counted as stale evidence.
- `fill_tca_or_slippage_quality`: historical TCA is advisory until active-session fill quality meets thresholds.
- `capital_gate_safety`: paper and live notional limits remain zero while proof floor is `repair_only` or live submit
  is disabled.

## Rollout

1. Ship the acceptance ledger and cutover packet in observe mode.
2. Verify payload presence across `/readyz`, `/trading/status`, `/trading/revenue-repair`, and
   `/trading/consumer-evidence`.
3. Compare cutover decisions with profit-signal quorum and revenue repair for one market session.
4. Enable Jangar admission holds for absent or unsettled cutover packets.
5. Permit a paper route proposal only after at least one lot is accepted with current fill-quality proof and capital
   gates remain explicit.

## Rollback

- Hide the cutover packet and keep the existing profit-signal quorum, proof floor, and revenue repair behavior.
- Disable Jangar enforcement while preserving observe-only packet publication.
- Keep `simple_submit_disabled`, zero-notional proof floor, and alpha readiness gates unchanged.
- Revert the Torghut implementation PR or promote the prior known-good image through the normal GitOps release path if
  payload shape breaks consumers.

## Risks And Tradeoffs

- PR #6127 is blocked by mandatory Codex review capacity. Mitigation: do not treat it as production until a
  current-head Codex review posts, all threads are resolved, and the PR merges.
- Scoped quant stage evidence can fluctuate by route and cache. Mitigation: the cutover packet records the settled
  stage view and fails closed for routeability.
- The fill-quality clock may hold routeable candidates even when historical TCA looks acceptable. Mitigation: keep
  zero-notional repair open and require active-session evidence before routeability.
- The cutover packet adds another payload. Mitigation: keep it small, derived, and versioned; do not duplicate the
  full revenue repair digest.

## Handoff

Engineer handoff: finish the acceptance-ledger implementation, add the cutover packet and fill-quality clock, and prove
with tests that production cannot count a routeable candidate while the ledger is absent, unsettled, or backed only by
stale TCA.

Deployer handoff: after merge and image promotion, verify Argo sync, live/sim pod readiness, `/healthz`, degraded but
truthful `/readyz`, the live acceptance ledger, the cutover packet, zero accepted routeable candidates, and zero
paper/live notional. Do not call the routeability release revenue-impacting until a settled lot creates current
post-cost paper evidence.
