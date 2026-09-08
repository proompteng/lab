# 119. Jangar Empirical Proof Renewal Clearinghouse And Capital Reentry Settlement (2026-05-06)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-06
Owner: Victor Chen, Jangar Engineering Architecture
Scope: Jangar dependency quorum, empirical proof renewal, repair admission settlement, Torghut capital handoff,
source/data freshness, rollout safety, and deployer acceptance gates.

Companion Torghut contract:

- `docs/torghut/design-system/v6/123-torghut-empirical-profit-claims-and-shadow-capital-settlement-2026-05-06.md`

Extends:

- `118-jangar-repair-admission-governor-and-profit-renewal-bids-2026-05-06.md`
- `117-jangar-evidence-debt-tranches-and-capital-unblock-ledger-2026-05-06.md`
- `116-jangar-controller-witness-quorum-and-capital-activation-receipts-2026-05-06.md`
- `111-jangar-negative-evidence-router-and-action-slo-budgets-2026-05-06.md`

## Decision

I am selecting an **empirical proof renewal clearinghouse with capital reentry settlement** as the next Jangar
control-plane architecture step.

The current state has moved past the earlier broad reliability failure. In the read-only sample at
`2026-05-06T14:08Z`, `deployment/jangar` was `1/1`, `deployment/agents` was `1/1`, and
`deployment/agents-controllers` was `2/2`. Jangar `/ready` returned HTTP `200`, execution trust was healthy, runtime
kits and admission passports were allowed, and all four Jangar swarm stages were fresh. Jangar database projection was
healthy with `28/28` registered Kysely migrations applied, no missing migrations, and latest applied migration
`20260505_torghut_quant_pipeline_health_window_index`.

That is the good news. The control plane is available enough to make a better decision.

The remaining block is not rollout health. It is stale profit proof. Jangar dependency quorum returned
`decision=block` for `empirical_jobs_degraded`. The empirical service projection reported `forecast.status=degraded`
with `registry_empty`, `lean.status=disabled`, and stale empirical jobs for `benchmark_parity`,
`foundation_router_parity`, `janus_event_car`, and `janus_hgrm_reward`. Jangar action budgets held `merge_ready` and
`paper_canary`, and blocked `live_micro_canary` and `live_scale`. Torghut `/readyz` returned HTTP `503` because live
submission is disabled in `capital_stage=shadow`; alpha readiness had `3` hypotheses, `0` promotion eligible, and `3`
rollback required. Market context for `NVDA` was degraded because fundamentals were stale by `4753521` seconds and
news was stale by `1516` seconds. The typed quant health route scoped to `account=paper&window=1d` was degraded with
`latestMetricsUpdatedAt=null`, `latestMetricsCount=0`, and `emptyLatestStoreAlarm=true`.

The repair admission governor says which repair may run. It does not yet make closure of the stale proof block a
settled, queryable contract. I am adding that settlement layer. A Jangar clearinghouse will accept Torghut profit
renewal claims, reserve a zero-notional repair lane, require typed closure receipts, and only then retire empirical
debt from merge, paper, or live-capital gates.

The tradeoff is slower reentry after a proof repair runs. I accept that. The six-month risk is not that Jangar blocks
too much capital. The risk is that a repair job runs, emits some fresh artifact, and humans infer the capital block is
gone before the control plane has reconciled empirical truthfulness, account/window freshness, market-context state,
source schema, rollout authority, and Torghut hypothesis posture into one settlement epoch.

## Evidence Snapshot

All evidence gathering for this decision was read-only. I did not mutate Kubernetes resources, database records, Argo
applications, GitHub records, broker state, trading flags, or market-context rows.

### Cluster And Rollout Evidence

- Runtime Kubernetes identity was `system:serviceaccount:agents:agents-sa`.
- `kubectl config current-context` was unset in the workspace, but the in-cluster service-account path was usable for
  read-only resource queries.
- `kubectl get pods -n jangar -o wide` showed Jangar, Bumba, Jangar DB, Redis, Open WebUI, Alloy, and Symphony pods
  running. `kubectl rollout status -n jangar deployment/jangar` succeeded.
- `kubectl get pods -n agents -o wide` showed `agents`, `agents-alloy`, and both `agents-controllers` pods running.
  `kubectl rollout status -n agents deployment/agents` and `deployment/agents-controllers` succeeded.
- Agents CronJobs for Jangar discover, plan, implement, and verify were present, unsuspended, and producing completed
  schedule-runner jobs on the current image.
- Recent `agents` events still showed transient readiness probe timeouts on `agents` and both `agents-controllers`
  pods. That is rollout debt, but the current pods were running and rollout-derived status was healthy.
- Recent `agents` events also showed a `BackoffLimitExceeded` Torghut market-context fundamentals batch job.
- `kubectl get pods -n torghut -o wide` showed Torghut live revision `torghut-00238`, sim revision
  `torghut-sim-00329`, ClickHouse, Keeper, Postgres, live TA, options TA, options catalog, options enricher,
  websockets, guardrail exporters, Alloy, and Symphony workloads running.
- The same Torghut read showed `torghut-ta-sim` in `ImagePullBackOff` for
  `registry.ide-newton.ts.net/lab/torghut-ta@sha256:20fe1818...`, with recent events reporting an image platform
  mismatch. That sim technical-analysis lane is not a live-capital blocker by itself, but it is a proof renewal capacity
  risk.
- Recent Torghut events also showed duplicate ClickHouse PodDisruptionBudget matches and transient Knative readiness
  probe failures during revision replacement.
- The service account could list services, pods, deployments, jobs, CronJobs, and events in the checked namespaces, but
  could not list StatefulSets and could not exec into database pods. Routine control-plane authority must therefore
  rely on service-owned projections rather than privileged database exec.

### Database, Data, And Freshness Evidence

- Direct `kubectl cnpg psql` for both `jangar-db` and `torghut-db` failed with `pods/exec` forbidden. That is the right
  least-privilege boundary for this lane.
- Jangar `/api/agents/control-plane/status?namespace=agents` reported database `configured=true`, `connected=true`,
  `status=healthy`, `latency_ms=10`, registered migrations `28`, applied migrations `28`, and no missing or unexpected
  migrations.
- The same status route reported fresh Jangar stages: discover, plan, implement, and verify were all `stale=false` with
  high data confidence.
- Jangar watch reliability was healthy over the current 15-minute window: `3` observed streams, `5566` to `5641`
  events across samples, `0` errors, and `2` restarts.
- Jangar dependency quorum still blocked with reason `empirical_jobs_degraded`.
- Jangar empirical services reported stale empirical jobs `benchmark_parity`, `foundation_router_parity`,
  `janus_event_car`, and `janus_hgrm_reward` at endpoint
  `http://torghut.torghut.svc.cluster.local/trading/autonomy`.
- Jangar negative evidence router was in `observe` mode and carried negative evidence refs for
  `empirical_jobs_degraded` and `empirical_jobs_stale`; contradiction refs were empty in the current sample.
- Jangar action budgets allowed read-only serving, repair dispatch, normal dispatch, deploy widening, and Torghut
  observe, but held `merge_ready` and `paper_canary`; `live_micro_canary` and `live_scale` were blocked.
- Torghut `/readyz` returned HTTP `503`. Scheduler, Postgres, ClickHouse, Alpaca, database schema, and Jangar universe
  checks were healthy, but `live_submission_gate.allowed=false` with `reason=simple_submit_disabled` in
  `capital_stage=shadow`.
- Torghut `/readyz` reported schema current at Alembic head `0029_whitepaper_embedding_dimension_4096`,
  `schema_graph_lineage_ready=true`, and `account_scope_ready=true`, with warnings for known historical migration
  parent forks at `0010_execution_provenance_and_governance_trace` and `0015_whitepaper_workflow_tables`.
- Torghut `/trading/status` reported `promotion_eligible_total=0`, `rollback_required_total=3`, dependency quorum
  `block`, and live submission still disabled.
- Torghut `/trading/autonomy` reported the four empirical jobs stale, all tied to candidate
  `intraday_tsmom_v1@prod` and dataset `torghut-full-day-20260318-884bec35`.
- Jangar market-context health for `NVDA` returned `overallState=degraded`. Technicals and regime were fresh, but
  fundamentals were stale by `4753521` seconds and news by `1516` seconds.
- Jangar market-context context for `NVDA` carried risk flags `fundamentals_stale`,
  `supplier_partnership_execution_risk`, `china_market_overhang`, `relative_momentum_lag`, and `news_stale`.
- Jangar typed quant health for `account=paper&window=1d` returned `status=degraded`,
  `latestMetricsUpdatedAt=null`, `latestMetricsCount=0`, and `emptyLatestStoreAlarm=true`.

### Source Evidence

- `services/jangar/src/server/control-plane-status.ts` is `753` lines and composes controller health, database status,
  rollout health, watch reliability, workflow freshness, empirical services, failure-domain leases, negative evidence,
  action clocks, runtime admission, and controller witness receipts into the operator status surface.
- `services/jangar/src/server/control-plane-negative-evidence-router.ts` is `610` lines and already converts empirical
  debt, market-context staleness, Torghut readiness, quant alerts, rollout ambiguity, workflow failures, and watch
  debt into action SLO budgets.
- `services/jangar/src/server/control-plane-action-clock.ts` is `276` lines and reconciles leases, database, rollout,
  workflow, watch, and empirical-service debt into action clocks.
- `services/jangar/src/server/control-plane-empirical-services.ts` is `129` lines and projects Torghut autonomy status
  into Jangar dependency quorum.
- `services/jangar/src/server/torghut-quant-metrics.ts` is `928` lines and owns typed quant health from latest metrics,
  pipeline health, account/window scope, and alerts.
- `services/jangar/src/server/torghut-market-context.ts` is `748` lines and composes technicals, fundamentals, news,
  and regime into a freshness-scored market-context bundle.
- Focused tests exist for Jangar control-plane status (`2367` lines), negative evidence routing (`233` lines), action
  clocks (`244` lines), Torghut quant health (`265` lines), and market-context health (`125` lines).
- The missing system-level regression is not "can Jangar identify stale empirical proof?" It can. The missing
  regression is "does a completed repair settle stale empirical proof into a capital-grade receipt before merge, paper,
  or live gates move?"

## Problem

Jangar now has two true statements that need a stronger contract between them:

1. Repair work is allowed under bounded, zero-notional conditions.
2. Capital and merge authority remain held until stale empirical proof is actually retired.

The repair admission governor covers the first statement. The dependency quorum covers the second statement. The gap is
the path between them. If a stale empirical job is rerun, the control plane needs to know whether it was the required
job, for the required candidate, on the required dataset, using the required runtime and source schema, within the
freshness budget, and with the required Torghut hypothesis consuming it.

Without that settlement layer, the next failure mode is predictable:

- a repair lane reruns some stale artifact;
- a route or dashboard turns greener;
- merge or paper-capital pressure increases;
- the system still lacks a durable proof that the old `empirical_jobs_degraded` block is closed for the exact action
  class being requested.

The control plane should not rely on humans to join those facts from logs, status pages, and database projections.
Jangar should settle proof renewal as a first-class epoch and only retire dependency-quorum debt when the epoch cites
fresh closure receipts.

## Alternatives Considered

### Option A: Fixed Empirical Replay Cron

Run all stale empirical jobs on a fixed cadence, then let dependency quorum turn green when Torghut reports no stale
jobs.

Pros:

- Simple to operate.
- Uses existing empirical-job concepts.
- Quickly clears the obvious stale job names when the replay succeeds.

Cons:

- Does not reserve Jangar repair capacity based on current watch, rollout, or database pressure.
- Cannot distinguish a replay that is fresh but irrelevant to the active hypothesis from one that unlocks paper
  capital.
- Does not settle market-context, quant-health, source-schema, or account/window proof alongside empirical jobs.
- Encourages "job completed" to become a capital proxy.

Decision: reject as the architecture. Keep fixed replay as a fallback producer of closure candidates.

### Option B: Let Torghut Self-Certify Empirical Readiness

Torghut owns the empirical jobs and hypothesis ledger, so it could mark a hypothesis eligible after it refreshes all
required proof.

Pros:

- Puts trading-specific semantics close to Torghut.
- Avoids another Jangar reducer.
- Gives the quant team fast iteration on proof quality.

Cons:

- Torghut should not own Jangar merge, rollout widening, or dispatch admission.
- Self-certification cannot see the full Jangar controller, watch, runtime, source-schema, and deployment authority
  context.
- It risks reintroducing the old problem: a trading service readiness surface is treated as control-plane authority.

Decision: reject as the authority layer. Torghut should publish claims and receipts; Jangar should settle them.

### Option C: Jangar Empirical Proof Renewal Clearinghouse

Jangar accepts Torghut proof-renewal claims, admits selected zero-notional repair lanes, receives closure receipts, and
settles dependency-quorum and capital reentry decisions by action class.

Pros:

- Keeps repair dispatch and capital authority separated.
- Gives stale empirical proof a concrete closure path instead of a standing block.
- Lets Torghut rank profit value without granting itself authority.
- Makes merge, paper, and live capital gates cite the exact closure receipts that retired stale proof.
- Produces testable engineering and deployer gates.

Cons:

- Adds a new projection and receipt type.
- Requires conservative scoring until there is closure history.
- Requires careful expiry so stale closure receipts do not become permanent capital authority.

Decision: select Option C.

## Architecture

Jangar adds an `empirical_proof_renewal_clearinghouse_epoch` projection.

```text
empirical_proof_renewal_clearinghouse_epoch
  epoch_id
  generated_at
  expires_at
  namespace
  dependency_quorum_ref
  negative_evidence_router_epoch_ref
  action_slo_budget_refs
  repair_admission_epoch_ref
  watch_reliability_ref
  database_projection_ref
  source_schema_ref
  torghut_profit_claim_refs
  selected_claim_refs
  denied_claim_refs
  closure_receipt_refs
  unsettled_debt_refs
  settled_debt_refs
  action_class_settlements
  max_concurrent_renewals
  max_runtime_seconds
  max_notional
  decision                         # observe, allow_zero_notional_renewal, hold_settlement, block
  reason_codes
  rollback_target
```

Each Torghut claim becomes a Jangar-scoped `empirical_proof_renewal_ticket`.

```text
empirical_proof_renewal_ticket
  ticket_id
  epoch_id
  claim_ref
  lane_class                       # empirical_replay, quant_latest_bootstrap, market_context_rehydrate,
                                   # sim_ta_repair, alert_closure, hypothesis_retirement
  owner_lane                       # torghut_quant, engineer, deployer
  hypothesis_id
  candidate_id
  dataset_snapshot_ref
  account
  window
  required_artifact_refs
  required_freshness_budget
  admitted                         # true/false
  denial_reasons
  max_dispatches
  max_runtime_seconds
  max_notional
  expires_at
```

Closure is explicit.

```text
empirical_proof_renewal_closure_receipt
  receipt_id
  ticket_id
  completed_at
  closure_status                   # complete, partial, failed, expired
  before_evidence_refs
  after_evidence_refs
  empirical_job_refs
  market_context_refs
  quant_health_refs
  source_schema_ref
  database_projection_ref
  runtime_revision_ref
  proof_truthfulness               # truthful, unverified, contradicted
  freshness_decision               # fresh, stale, mixed
  action_class_impact              # none, observe, merge_ready, paper_canary, live_micro_canary, live_scale
  remaining_debt_refs
```

Settlement is per action class.

```text
action_class_settlement
  action_class
  previous_decision
  settled_decision
  required_receipt_refs
  missing_receipt_refs
  blocked_reason_codes
  allowed_notional
  fresh_until
```

Rules:

- The clearinghouse can admit only zero-notional renewal work while dependency quorum is blocked.
- `merge_ready` cannot move from `hold` unless all stale empirical proof cited by the current dependency quorum has a
  complete and fresh closure receipt.
- `paper_canary` also requires account/window quant proof and market-context freshness for the active hypothesis
  universe.
- `live_micro_canary` and `live_scale` require paper settlement history in addition to empirical closure. The
  clearinghouse cannot directly grant live notional.
- A closure receipt expires. Expired receipts return their retired debt refs to unsettled state unless fresher evidence
  supersedes them.
- A failed renewal does not disappear. It emits a closure receipt with `closure_status=failed` and a repair outcome
  reason that can be priced by Torghut.
- Sim TA image-pull or route readiness debt can be admitted as renewal only when it is required by an active Torghut
  claim; otherwise it remains platform rollout debt.

## Implementation Scope

Jangar engineer scope:

- Add a clearinghouse builder that consumes dependency quorum, negative evidence, action budgets, repair admission,
  empirical services, Torghut profit claims, watch reliability, database projection, source schema, and typed Torghut
  health.
- Expose the current clearinghouse epoch in `/api/agents/control-plane/status?namespace=agents` behind a shadow flag.
- Add action-class settlement payloads for `merge_ready`, `paper_canary`, `live_micro_canary`, and `live_scale`.
- Add tests for stale empirical jobs admitted to zero-notional renewal, successful closure, partial closure, failed
  closure, expired closure, account/window quant mismatch, market-context stale domain, and sim TA rollout debt.
- Keep the first implementation read-only and shadow-only. It must not launch jobs or change trading flags.

Torghut engineer scope:

- Publish profit claims and closure receipts described in the companion Torghut contract.
- Include candidate id, dataset snapshot, empirical job names, artifact refs, hypothesis id, account, window, and
  expected capital-unblock class in each claim.
- Never mark a claim capital-ready unless Jangar has settled it.

Deployer scope:

- Validate that the clearinghouse payload appears in status without changing existing action decisions.
- Compare settlement decisions against current action SLO budgets for at least one full hourly scheduler cycle.
- Do not widen rollout, merge material control-plane changes, or enable paper/live capital based on a claim alone.
  Require closure receipts and Jangar settlement.

## Validation Gates

Local validation:

- `bunx oxfmt --check docs/agents/designs/119-jangar-empirical-proof-renewal-clearinghouse-and-capital-reentry-settlement-2026-05-06.md docs/torghut/design-system/v6/123-torghut-empirical-profit-claims-and-shadow-capital-settlement-2026-05-06.md docs/torghut/design-system/v6/index.md`

Engineer validation:

- Unit tests cover every settlement decision and receipt expiry path.
- Contract tests prove stale empirical jobs do not clear `merge_ready` without matching complete receipts.
- Contract tests prove a fresh empirical closure does not unlock paper canary when market-context or account/window
  quant proof is stale.
- Shadow status includes positive and negative evidence refs for every settlement.

Cluster validation:

- `GET /api/agents/control-plane/status?namespace=agents` returns a clearinghouse epoch with `max_notional=0` while
  dependency quorum is blocked.
- Torghut `/readyz` can remain HTTP `503`; clearinghouse shadow settlement must still explain which proof debt is
  unsettled.
- A successful empirical replay changes only the relevant settlement class, not all material action classes.

## Rollout

1. Land the documentation and contract first.
2. Add the Jangar clearinghouse builder in shadow mode with no admission side effects.
3. Add Torghut claim publication in shadow mode with no job launches.
4. Add closure receipt publication for already-running repair jobs.
5. Compare clearinghouse settlement against dependency quorum and action SLO budgets for at least three scheduler
   cycles.
6. Allow the repair admission governor to consume selected tickets only for zero-notional repairs.
7. Allow `merge_ready` settlement to consume complete receipts.
8. Allow paper canary settlement only after empirical, account/window quant, market-context, and hypothesis posture
   receipts are fresh.

## Rollback

- Disable the clearinghouse projection flag. Existing dependency quorum, negative evidence, action clocks, and action
  SLO budgets remain authoritative.
- Treat all incomplete and expired clearinghouse tickets as unsettled debt.
- Keep Torghut in shadow capital and `max_notional=0` until the previous action-budget path is explicitly green.
- Preserve closure receipts for audit; do not use them for capital decisions until the projection is re-enabled.

## Risks

- Receipt overtrust: a completed job can still be the wrong job. Mitigation: require candidate id, dataset snapshot,
  runtime revision, source schema, and action-class impact in the receipt.
- Stale settlement: a closure receipt can age out while dashboards remain green. Mitigation: receipts expire and are
  recomputed into unsettled debt.
- Repair starvation: empirical replay might always outrank market-context or quant freshness. Mitigation: the
  clearinghouse emits denied claims with denial reasons and age so starvation is visible.
- RBAC blind spots: this lane cannot exec into databases. Mitigation: service-owned database and schema projections
  remain required evidence; deployer can add higher-privilege read-only checks outside the routine contract.
- Sim lane instability: `torghut-ta-sim` image pull debt can consume attention. Mitigation: admit sim TA repair only
  when a selected Torghut claim requires it for capital-class proof.

## Handoff

Engineer acceptance gates:

- The clearinghouse is represented as a typed status projection with tests for success, partial, failed, and expired
  closure.
- `merge_ready`, `paper_canary`, `live_micro_canary`, and `live_scale` cite clearinghouse settlement refs when they
  remain held or blocked.
- No implementation path raises `max_notional` above `0`.
- Torghut claims cannot bypass Jangar settlement.

Deployer acceptance gates:

- Before rollout widening, capture Jangar `/ready`, Jangar control-plane status, Torghut `/readyz`, Torghut
  `/trading/autonomy`, typed quant health, and market-context health.
- Require `dependency_quorum.decision=allow` or an explicit clearinghouse settlement that names remaining unsettled
  debt before treating `merge_ready` as available.
- Require paper and live capital gates to remain held while empirical jobs are stale, account/window quant health is
  empty, or market-context domains are stale.
- Roll back by disabling clearinghouse consumption, not by weakening dependency quorum.
