# 190. Jangar Projection Foreclosure Notary And Stage Custody Repair (2026-05-13)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-13
Owner: Victor Chen, Jangar Engineering Architecture
Scope: Jangar stale projection foreclosure, stage custody repair, AgentRun and market-context data authority, ready truth,
stage credit, Torghut repair-only route custody, validation, rollout, rollback, and cross-stage handoff.

Companion Torghut contract:

- `docs/torghut/design-system/v6/195-torghut-stale-projection-foreclosure-and-route-custody-2026-05-13.md`

Extends:

- `docs/agents/designs/189-jangar-terminal-debt-compaction-and-repair-outcome-escrow-2026-05-13.md`
- `docs/agents/designs/189-jangar-authority-provenance-settlement-and-rollout-reentry-windows-2026-05-13.md`
- `docs/agents/designs/188-jangar-ready-truth-arbiter-and-stage-credit-cutover-2026-05-13.md`
- `docs/agents/designs/187-jangar-stage-credit-ledger-and-runner-slot-futures-2026-05-13.md`
- `docs/agents/designs/123-jangar-market-context-contradiction-ledger-and-lane-capital-holds-2026-05-06.md`

## Decision

I am selecting a **projection foreclosure notary** as the next Jangar control-plane architecture increment.

The previous discover increments moved the system from broad failure counting toward typed stage credit, ready truth,
terminal debt compaction, and repair outcome escrow. That was necessary, but the current read-only assessment shows one
remaining reliability gap: old database and evidence projections can still look active after the live authority surface
has moved on.

On 2026-05-13 the rollout surface was mostly healthy. The `jangar` namespace deployments were ready, the `agents`
controller deployments were ready, and Torghut serving deployments were ready after their latest rollout. Jangar
control-plane status reported healthy database, healthy watch reliability, healthy execution trust, and healthy
controller heartbeats from the active controller deployment. At the same time, the state stores still carried stale
active claims. Jangar Postgres had `31` `agent_runs` rows marked `Running`, with the oldest created on
`2026-03-11T03:36:00Z`, and `5` rows marked `Pending`. Jangar market-context run tables still contained
`running` and `started` rows whose heartbeats ranged from hours old to weeks old. Torghut Postgres had current TCA and
options watermark activity, but `evidence_epochs` and `evidence_receipts` were empty while Jangar route custody
reported `repair_only`, evidence-clock custody `blocked`, and required receipts that did not yet exist.

The selected design makes that split explicit. A projection can be current, grace-period current, stale-foreclosed,
contradictory, terminal audit, or missing-receipt. Foreclosure is not cleanup and does not mutate source rows. It is a
read-side notarization that says "this row or projection is still preserved, but it is no longer live authority for
stage credit, ready truth, rollout admission, or Torghut capital-adjacent repair."

The tradeoff is that implementation must carry another typed status object through Jangar. I accept that cost because
the business metric is reducing failed AgentRuns and shortening green PR-to-healthy GitOps rollout time. The fastest
way to improve both is to stop asking deployers and scheduled lanes to manually decide whether an old `Running` row,
old market-context batch, or empty receipt ledger is still authoritative.

## Governing Runtime Requirements

This design binds to the current Jangar swarm validation contract:

- every run must cite the governing design or runtime requirement before changing code;
- implement stages must produce production PRs with tests or report the exact blocker to code;
- verify stages must merge only green PRs and prove Argo, workload readiness, and service health after rollout;
- final handoff must name the control-plane metric improved or the smallest blocker preventing improvement.

Every milestone in this document maps to at least one required Jangar value gate:

- `failed_agentrun_rate`
- `pr_to_rollout_latency`
- `ready_status_truth`
- `manual_intervention_count`
- `handoff_evidence_quality`

## Read-Only Evidence Snapshot

All evidence in this pass was collected read-only on 2026-05-13. I did not mutate Kubernetes resources, database rows,
GitOps resources, AgentRuns, trading flags, broker state, or market data.

### Cluster, Rollout, And Events

- The working branch was `codex/swarm-jangar-control-plane-discover`, aligned with `origin/main` before this document
  was authored.
- Kubernetes auth resolved to `system:serviceaccount:agents:agents-sa`. The workspace kube context was bootstrapped to
  `in-cluster` from the mounted service-account token and CA before read-only checks.
- `jangar` namespace deployments were ready. `jangar` was `1/1` ready on image
  `registry.ide-newton.ts.net/lab/jangar:3382549b@sha256:1c72...`; `bumba`, `symphony`, `symphony-jangar`, and
  `jangar-alloy` were also ready.
- `agents` namespace deployments were ready. `agents` was `1/1`, `agents-controllers` was `2/2`, and `agents-alloy`
  was `1/1`.
- `torghut` namespace serving deployments were ready, including `torghut-00359-deployment` and
  `torghut-sim-00457-deployment`. Older Knative revisions remained scaled to `0/0`.
- Retained `agents` jobs summarized to `155` complete, `35` failed, and `3` running. Jangar lane jobs summarized to
  discover `10` complete and `1` running, implement `31` complete, `6` failed, and `1` running, plan `8` complete, and
  verify `25` complete, `1` failed, and `1` running.
- Retained AgentRun CR phases summarized to `598` Succeeded, `115` Failed, `11` Pending, `3` Running, and
  `12` Template. Jangar retained phases included discover `2` Failed and `61` Succeeded, implement `26` Failed and
  `98` Succeeded, plan `3` Failed and `60` Succeeded, and verify `21` Failed and `77` Succeeded.
- Market-context scheduled jobs were noisy: fundamentals summarized to `8` complete and `10` failed, while news
  summarized to `16` complete and `2` failed.
- Recent events showed transient rollout readiness probe failures, a `BackoffLimitExceeded` market-context
  fundamentals batch, and a temporary `FailedMount` for a discover CronJob schedule template ConfigMap. Those events
  had to be interpreted alongside later healthy deployments and completed scheduled work.
- Current Jangar discover AgentRun stage annotations held the lane with reason codes including
  `controller_heartbeat_not_current`, `controller_witness_allow_with_split`, `evidence_clock_custody_blocked`,
  `route_stability_hold`, and `source_rollout_truth_hold`. The required repair action named Torghut stage-custody
  settlement.

### Source Architecture And Test Surface

- `services/jangar/src/server/control-plane-status.ts` is the central status reducer. It is large enough to be a
  high-risk source of hidden coupling at `766` lines, even before consuming new projection state.
- `services/jangar/src/server/control-plane-terminal-debt-compaction.ts` already classifies failed AgentRuns, jobs, and
  pods into active windows and retained audit debt. It is the right place to extend the concept from terminal Kubernetes
  objects to stale database projections.
- `services/jangar/src/server/control-plane-stage-credit-ledger.ts` is `481` lines and already emits stage accounts,
  stage credit decisions, and debt refs. It does not yet require a projection foreclosure verdict before treating old
  state-store rows as non-authoritative.
- `services/jangar/src/server/control-plane-ready-truth-arbiter.ts` is `442` lines and correctly aggregates material
  readiness. It needs a typed projection verdict so ready truth can explain whether a hold comes from live authority,
  stale projection custody, or missing repair receipts.
- `services/jangar/src/server/control-plane-torghut-stage-custody.ts` is small at `114` lines and is the correct
  integration point for turning Torghut route-custody blockers into stage-local projection receipts.
- `services/jangar/src/server/agents-controller/index.ts`, `agent-run-reconciler.ts`, and
  `supporting-primitives-controller.ts` remain the highest-risk workflow surfaces at `1827`, `1190`, and `3351` lines.
  They own the live AgentRun and Job authority that the notary must compare against database projections.
- `services/jangar/src/server/torghut-market-context-agents.ts` is `1980` lines and currently handles market-context
  run lifecycle states, finalization, and evidence emission. It lacks a lane-local stale-run foreclosure contract for
  `running` or `started` records whose heartbeat has expired.
- Existing tests cover terminal debt compaction, stage credit, ready truth, control-plane status, Torghut consumer
  evidence, and market-context agents. The missing test family is stale projection foreclosure: old DB rows must remain
  queryable while losing authority over current launch and repair decisions.

### Database And Data Evidence

- Direct CNPG `psql` through `kubectl cnpg psql` was blocked by RBAC because this service account cannot exec into
  database pods. The assessment therefore used application read credentials and service endpoints for read-only
  database evidence.
- Jangar Postgres was reachable through the read service. Database time was `2026-05-13T16:11:39Z`. Extensions
  included `pgcrypto`, `plpgsql`, and `vector`.
- Jangar migrations were current. The latest applied migration was
  `20260508_torghut_quant_pipeline_health_account_window_created_at_index`.
- `agent_runs` in Jangar Postgres summarized to `655` Succeeded, `246` Failed, `31` Running, and `5` Pending. The
  oldest `Running` row was created on `2026-03-11T03:36:00Z`; the oldest `Pending` row was created on
  `2026-05-12T16:01:14Z`.
- `orchestration_runs` was empty, which means current orchestration truth comes from AgentRun/Kubernetes and status
  reducers rather than a populated orchestration ledger.
- `torghut_market_context_runs` in Jangar Postgres summarized fundamentals as `26` succeeded, `12` running,
  `6` failed, and `2` started. News summarized to `226` succeeded, `16` running, `7` failed, `4` started, and
  `2` partial.
- Market-context snapshots were recent in aggregate, but the projection rows were not clean. Fundamentals snapshots had
  newest `as_of` `2026-05-13T15:45:29Z`; news snapshots had newest `as_of` `2026-05-13T15:43:50Z`. At the same time,
  stale `running` and `started` records persisted with old update timestamps.
- Market-context evidence showed a domain split. Fundamentals had `95` evidence rows with newest published
  `2026-05-13T01:04:57Z` and ingested `2026-05-13T01:05:12Z`. News had `1167` rows with newest published
  `2026-05-13T16:00:00Z` and newest ingested `2026-05-13T04:20:39Z`.
- Torghut Postgres was reachable through the read service. Database time was `2026-05-13T16:13:32Z`, and Alembic head
  was `0031_autoresearch_candidate_spec_epoch_uniqueness`.
- Torghut `trade_decisions` still carried a large rejected and blocked surface: `69909` rejected decisions, newest
  `2026-05-04`, and `63665` blocked decisions, newest `2026-05-13T15:26Z`. Filled executions were stale at
  `13555`, newest `2026-04-02`.
- Torghut TCA metrics were active with `13775` rows and newest computed timestamp `2026-05-13T15:29:49Z`, but
  `evidence_epochs` and `evidence_receipts` were empty.
- Torghut autoresearch and empirical evidence was active but not promotion-ready: `342` eligible candidate specs,
  `32` completed empirical job runs marked promotion-authority eligible, and latest autoresearch epoch status
  `no_profit_target_candidate`.
- Torghut `/readyz` returned HTTP `503` with `status=degraded`. Scheduler, Postgres, ClickHouse, Alpaca, database,
  universe, and empirical jobs were healthy. Live submission was blocked by `simple_submit_disabled`, profitability
  proof floor was `repair_only`, capital state was `zero_notional`, and `alpha_readiness` had `3` shadow hypotheses,
  `0` promotion eligible, and `2` rollback required.

## Problem

Jangar has multiple sources that can describe the same operational fact:

- live Kubernetes AgentRun, Job, Pod, and Deployment objects;
- Jangar Postgres `agent_runs` and market-context run rows;
- control-plane status reducers;
- Torghut health, consumer-evidence, and route-custody endpoints;
- stage clearance annotations on active AgentRuns.

The control plane already knows how to stay conservative when these sources disagree. The missing behavior is how to
retire stale projections without deleting them and without asking humans to re-interpret them every run.

The concrete failure modes are:

1. A stale Jangar `agent_runs.running` row can outlive the live Kubernetes AgentRun and remain indistinguishable from
   an active run to downstream readers.
2. A stale market-context `running` or `started` row can coexist with newer snapshots and evidence, which lets one
   segment look healthy while another surface says freshness custody is blocked.
3. Torghut can show fresh TCA and options watermarks while empty evidence receipt tables keep route custody in
   repair-only mode.
4. Stage credit can hold because a projection is old, but the status route cannot prove whether the old projection is
   still live authority, stale debt, or missing receipt evidence.
5. Verify and deployer stages cannot shorten green PR-to-healthy rollout time while every stale state-store projection
   requires manual explanation.
6. Failed AgentRun rate is inflated by repeat repair runs that rediscover stale projections rather than retiring their
   authority.

## Alternatives Considered

### Option A: Preserve The Current Conservative Interpretation

This path keeps stale rows and missing receipts inside the existing status and stage-credit reason lists. Operators keep
using evidence context to decide which stale items matter.

Advantages:

- No new reducer or schema work.
- Keeps all old blockers visible.
- Lowest immediate implementation cost.

Disadvantages:

- Keeps manual interpretation in the critical path.
- Makes old state-store rows look like live authority.
- Does not reduce repeated repair AgentRuns.
- Does not improve green PR-to-healthy rollout time because every stale projection can still require human judgment.

Decision: reject. This path preserves safety but does not improve the business metric.

### Option B: Mutate Or Cleanup Stale Rows

This path marks old `Running` or `Pending` records terminal, deletes old market-context rows, or rewrites receipt state
when the control plane decides a projection is stale.

Advantages:

- Reduces noisy counts quickly.
- Makes simple dashboards easier to read.
- Could be implemented as a database maintenance job.

Disadvantages:

- Mutates history without the original owner completing its lifecycle.
- Risks closing real in-flight work during watch or database lag.
- Hides provenance that verify and incident reviews need.
- Violates the read-side nature of the discover evidence gathered here.

Decision: reject. Cleanup is useful only after a typed foreclosure receipt exists.

### Option C: Projection Foreclosure Notary

The selected path adds a read-side notary. It reads live authority, database projections, market-context lifecycle rows,
and Torghut receipt state, then emits a typed foreclosure verdict. Stale projections stay stored and auditable, but
their authority expires unless a live owner renews them.

Advantages:

- Preserves evidence while removing stale authority.
- Gives ready truth and stage credit one typed explanation for stale active claims.
- Lets implementation reduce manual repair loops before deleting any row.
- Creates a Torghut handoff that separates observe-mode evidence from capital-adjacent route custody.

Disadvantages:

- Adds another status object and test surface.
- Requires careful grace periods to avoid foreclosing legitimate long-running work.
- Needs Torghut companion receipts before paper or live capital can consume the verdict.

Decision: select Option C.

## Architecture

The projection foreclosure notary is a control-plane reducer. It does not own scheduling, cleanup, or trading. It owns
the statement of whether a projected claim is still authoritative.

```text
projection_foreclosure_notary
  schema_version = jangar.projection-foreclosure-notary.v1
  generated_at
  namespace
  source_revision
  decision = allow | observe_only | repair_only | hold
  active_authority_summary
  stale_projection_summary
  stage_custody_verdict
  claims[]
  foreclosure_receipts[]
  missing_receipts[]
  required_repair_actions[]
```

Each claim records:

```text
projection_claim
  claim_id
  claim_class
  source_ref
  source_owner
  lane
  status
  observed_at
  last_heartbeat_at
  fresh_until
  live_authority_ref
  projection_ref
  authority_state
  reason_codes[]
  value_gates[]
```

Initial `claim_class` values:

- `agentrun_execution`: a Jangar DB `agent_runs` projection compared to live AgentRun, Job, and Pod authority;
- `workflow_schedule`: a CronJob or schedule-template projection compared to the currently launched AgentRun;
- `market_context_fundamentals`: a fundamentals run or snapshot freshness projection;
- `market_context_news`: a news run or snapshot freshness projection;
- `torghut_route_custody`: a Torghut route, TCA, and repair receipt projection;
- `source_rollout_truth`: a source revision, image, deployment, and status-route projection;
- `stage_clearance`: an AgentRun stage annotation compared to the latest lane-local clearance packet.

Initial `authority_state` values:

- `authoritative`: live source, projection row, and freshness budget agree;
- `grace`: live source is still within a configured renewal budget;
- `stale_foreclosed`: projection exists but its owner did not renew inside the budget;
- `contradictory`: two current surfaces disagree and material action must hold;
- `missing_receipt`: a claim requires a typed receipt that does not exist;
- `terminal_audit`: old terminal evidence is preserved but cannot block current launch by itself;
- `unknown`: the notary could not inspect the required source and must hold material action.

The notary starts with read-only evidence. It can be implemented without database mutation by deriving claims from the
same readers that already feed `control-plane-status`, terminal debt compaction, stage credit, and Torghut stage
custody.

## Authority Budgets

Authority budgets must be explicit and lane-local. The first implementation should use conservative defaults and expose
them in status output:

- `agentrun_execution` claims are stale-foreclosed when a Jangar DB `Running` or `Pending` row is older than the
  larger of the AgentRun requested timeout, two schedule intervals, or six hours, and there is no matching live
  Kubernetes AgentRun or Job in a non-terminal phase.
- `workflow_schedule` claims are stale-foreclosed when a CronJob launched work, the schedule template has not changed,
  and the corresponding AgentRun is terminal or missing past its configured schedule interval plus grace.
- `market_context_fundamentals` claims are stale-foreclosed when `running` or `started` rows exceed their domain
  freshness SLO and newer snapshots cannot be tied to a completed run receipt.
- `market_context_news` claims are stale-foreclosed independently from fundamentals. A fresh news article timestamp
  cannot renew a stale fundamentals claim, and a fresh fundamentals snapshot cannot renew stale news ingestion.
- `torghut_route_custody` claims are stale-foreclosed when route evidence depends on receipts such as
  `torghut.execution-tca-refresh-receipt.v1` or `torghut.market-context-freshness-receipt.v1` and those receipts are
  absent, expired, or not bound to the current account/window.
- `source_rollout_truth` claims are contradictory rather than stale when source revision, running image, and status
  route disagree inside the active rollout window.

Budgets are not global. Discover, plan, implement, and verify can carry different grace periods because their cost of
staleness differs. Capital-adjacent Torghut claims get the strictest budget.

## Control-Plane Contracts

### Stage Credit

`control-plane-stage-credit-ledger` must consume the notary before issuing a stage account verdict.

- `stale_foreclosed` projections do not burn active stage credit by themselves.
- `contradictory`, `missing_receipt`, and `unknown` projections keep material stage credit in `hold`.
- A stage can launch observe-mode work when all material blockers are either `terminal_audit` or
  `stale_foreclosed`, and the lane has enough runner capacity.
- A stage cannot promote paper/live capital-adjacent work until Torghut route custody has current receipts for every
  required route dependency.

### Ready Truth

`control-plane-ready-truth-arbiter` must report projection authority separately from service health.

- Service health can be green while projection authority is `repair_only`.
- `/ready` should stay conservative for material serving semantics, but the status route must identify whether the
  readiness hold is caused by live service failure, stale projection custody, missing receipts, or rollout
  contradiction.
- The ready truth payload should include `projection_foreclosure_notary.decision`, `claim_totals_by_state`, and the
  top repair actions.

### Terminal Debt Compaction

Terminal debt compaction must link retained failed AgentRuns, jobs, and pods to notary receipts.

- A retained terminal object stays audit-visible.
- A failed repair run that did not retire a reason code becomes active debt until it emits a no-delta receipt.
- Old terminal debt can become `terminal_audit` only when no live projection points at it as current authority.

### Torghut Stage Custody

Torghut stage custody must stop treating "segment projected healthy" as sufficient for capital-adjacent work.

- Observe-mode market-context work can continue when stale projections are foreclosed and repair actions are named.
- Paper/live capital and promotion require current route-custody receipts bound to account, window, hypothesis, and
  data domain.
- Empty `evidence_epochs` or `evidence_receipts` tables must be represented as `missing_receipt`, not as generic
  degraded readiness.

## Implementation Milestones

### Milestone 1: Notary Reader And Schema

Value gates: `ready_status_truth`, `handoff_evidence_quality`, `manual_intervention_count`.

- Add `control-plane-projection-foreclosure-notary.ts`.
- Define claim and receipt types in the local Jangar status domain.
- Read AgentRun DB projections, live AgentRun/Job authority, market-context run rows, Torghut route custody, and source
  rollout truth without mutating those sources.
- Add fixtures for old `Running`, old `Pending`, current live run, stale market-context run, missing Torghut receipt,
  and current route receipt.
- Unit tests must prove that stale rows remain visible but lose authority.

### Milestone 2: Stage Credit And Ready Truth Consumption

Value gates: `failed_agentrun_rate`, `pr_to_rollout_latency`, `ready_status_truth`.

- Wire the notary into stage credit and ready truth.
- Split active blockers from stale-foreclosed projections in the status route.
- Add regression tests where old `Running` DB rows no longer force a material hold after live authority is terminal or
  absent.
- Add regression tests where missing Torghut receipts still hold capital-adjacent work even when service health is OK.

### Milestone 3: Market-Context Foreclosure

Value gates: `failed_agentrun_rate`, `manual_intervention_count`, `ready_status_truth`.

- Add market-context domain budgets for fundamentals and news.
- Require completed run receipts before stale `running` or `started` rows can be marked foreclosed.
- Emit domain-specific repair actions: fundamentals repair, news repair, or cross-domain receipt reconciliation.
- Add tests around stale fundamentals with fresh news, stale news with fresh fundamentals, and both stale.

### Milestone 4: Torghut Route-Custody Receipt Bridge

Value gates: `failed_agentrun_rate`, `ready_status_truth`, `handoff_evidence_quality`.

- Consume the companion Torghut stale projection foreclosure ledger.
- Require `torghut.execution-tca-refresh-receipt.v1` and
  `torghut.market-context-freshness-receipt.v1` for route-custody promotion.
- Keep observe-mode repair dispatch allowed when receipts are missing but repair lots are explicit.
- Add tests proving `max_notional=0` remains enforced through missing-receipt states.

### Milestone 5: Deployer Cutover

Value gates: `pr_to_rollout_latency`, `manual_intervention_count`, `handoff_evidence_quality`.

- Update deployer runbooks to check the projection notary, not raw stale row counts, before declaring a rollout
  healthy.
- Verify after rollout: Argo healthy, workload readiness healthy or explicitly held by projection custody, Jangar
  `/health`, Jangar status route, Torghut `/db-check`, Torghut `/readyz`, and Torghut route-custody receipts.
- Record before/after counts for stale active projections and repeated repair runs.

## Validation Gates

The engineer stage is not complete until these checks pass:

- Unit tests for the notary claim classifier.
- Unit tests for stage credit and ready truth consumption.
- Regression tests for stale Jangar `agent_runs` rows older than the authority budget.
- Regression tests for stale market-context fundamentals and news rows.
- Regression tests for missing Torghut route-custody receipts preserving zero-notional safety.
- `bunx oxfmt --check` on touched TypeScript and Markdown paths.
- The relevant Jangar test command from the nearest package or service README.

The verify stage is not complete until these runtime checks are recorded:

- Argo reports `jangar`, `agents`, and `torghut` synced and healthy, or the exact non-healthy application and reason.
- Jangar `/health` is OK.
- Jangar control-plane status includes `projection_foreclosure_notary` with claim totals by authority state.
- Stage credit and ready truth name stale projections separately from live service blockers.
- Torghut `/db-check` is schema-current.
- Torghut `/readyz` can remain degraded only if the degradation is explained by capital/profit guards and not by
  unknown projection authority.
- No paper or live notional is enabled by this change.

## Rollout Plan

1. Ship the notary in observe-only status output with no admission behavior change.
2. Add stage credit and ready truth consumption behind a configuration flag.
3. Enable the flag for discover and plan lanes first.
4. Enable implement and verify once stale projection counts and live authority comparisons match for one full schedule
   cycle.
5. Keep Torghut capital-adjacent promotion blocked until the companion route-custody receipt bridge is present.

## Rollback Plan

Rollback is configuration-first:

- disable notary consumption in stage credit and ready truth;
- keep the status payload emitted for audit if it is not causing failures;
- fall back to existing terminal debt compaction and stage credit behavior;
- preserve all foreclosure receipts generated during the rollout for incident review;
- do not delete or mutate Jangar or Torghut state-store rows during rollback.

If the notary itself causes status-route instability, roll back the deployment image and use the previous design
contracts: terminal debt compaction, ready truth, and repair outcome escrow.

## Risks And Mitigations

- Risk: foreclosing a legitimate long-running AgentRun. Mitigation: compare DB rows to live Kubernetes authority and
  use the larger of requested timeout, schedule interval, and a six-hour default before foreclosure.
- Risk: hiding a real market-context outage. Mitigation: domain-specific foreclosure keeps fundamentals and news
  separate and requires completed receipts before stale rows lose authority.
- Risk: deployers read `stale_foreclosed` as fixed. Mitigation: status wording must say preserved, non-authoritative,
  and repair-required when a receipt is missing.
- Risk: Torghut route custody becomes more restrictive. Mitigation: observe-mode repair stays allowed, but paper/live
  capital remains blocked until current receipts exist.
- Risk: additional status complexity slows implementation. Mitigation: implement the notary as a narrow reducer first,
  then wire consumers in later milestones.

## Handoff To Engineer

Build the notary as a small reducer with strong fixtures before touching scheduler behavior. The first production PR
should not mutate database rows or delete Kubernetes objects. It should make stale projection authority visible and
testable, then feed that verdict into ready truth and stage credit behind a safe flag.

Acceptance gates:

- stale Jangar `agent_runs.running` rows older than the authority budget produce `stale_foreclosed` claims;
- live Kubernetes AgentRuns inside their timeout remain `authoritative` or `grace`;
- missing Torghut receipts produce `missing_receipt` and keep capital-adjacent work held;
- old terminal objects remain audit-visible;
- tests cover each authority state.

## Implementation Note 2026-05-13

Milestone 1 is implemented in `services/jangar/src/server/control-plane-projection-foreclosure-notary.ts` as a
read-only status reducer. The reducer emits `projection_foreclosure_notary` on the Jangar control-plane status payload,
classifies stale `agent_runs` and market-context active rows without mutating them, and represents missing Torghut
route-custody receipts as `missing_receipt`.

Stage credit and ready truth now accept the notary verdict, but admission consumption is guarded by
`JANGAR_PROJECTION_FORECLOSURE_CONSUME`. The default rollout remains visibility-only; enabling the flag makes missing
receipts and contradictory/unknown projection authority hold material action classes while keeping read-only serving
separate.

Rollback remains configuration-first: set `JANGAR_PROJECTION_FORECLOSURE_NOTARY_ENABLED=false` to remove the status
payload, or leave the payload visible and set `JANGAR_PROJECTION_FORECLOSURE_CONSUME=false` to disable consumer impact.

## Handoff To Deployer

Deployers should stop using raw retained failure or stale row counts as the rollout truth once this lands. Use the
notary verdict to decide whether a rollout is healthy, held by live blockers, or held by stale projection custody.

Rollout acceptance gates:

- Argo and deployments are healthy for `jangar`, `agents`, and `torghut`;
- Jangar status route emits the notary payload;
- no stale projection is treated as authoritative without a live owner or fresh receipt;
- Torghut route custody remains `repair_only` with `max_notional=0` until required receipts are current;
- handoff evidence records the control-plane metric improved: lower manual interpretation count, lower repeated repair
  AgentRun rate, or the exact stale projection blocker that prevented improvement.
