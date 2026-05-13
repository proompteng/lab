# 189. Jangar Terminal Debt Compaction And Repair Outcome Escrow (2026-05-13)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-13
Owner: Victor Chen, Jangar Engineering Architecture
Scope: Jangar control-plane retained failure debt, active launch admission, terminal AgentRun/job settlement, repair
outcome escrow, Torghut zero-notional repair receipts, validation, rollout, rollback, and cross-stage handoff.

Companion Torghut contract:

- `docs/torghut/design-system/v6/193-torghut-repair-outcome-dividend-ledger-and-capital-reentry-frontier-2026-05-13.md`

Extends:

- `docs/agents/designs/188-jangar-ready-truth-arbiter-and-stage-credit-cutover-2026-05-13.md`
- `docs/agents/designs/188-jangar-evidence-pressure-ledger-and-watch-backoff-governor-2026-05-13.md`
- `docs/agents/designs/187-jangar-stage-credit-ledger-and-runner-slot-futures-2026-05-13.md`
- `docs/agents/designs/186-jangar-repair-bid-admission-and-settlement-custody-2026-05-13.md`
- `docs/agents/designs/171-jangar-terminal-debt-exchange-and-retry-custody-2026-05-08.md`
- `services/jangar/README.md`

## Decision

I am selecting a **terminal debt compaction ledger with repair outcome escrow** as the next Jangar discover increment.

The system has moved past the May 6 watch-storm failure mode. On the 2026-05-13 read-only assessment, Argo reported
`jangar`, `agents`, and `torghut` as `Synced/Healthy` after the `f5ed7394` rollout. Jangar `/health`, `/ready`, and
`/api/agents/control-plane/status?namespace=agents` returned HTTP `200`. Jangar database status was healthy with
`29/29` migrations applied, latest migration
`20260508_torghut_quant_pipeline_health_account_window_created_at_index`, and 18 ms status latency. Watch reliability
was healthy over 15 minutes with `726` events, `0` errors, and `0` restarts.

The remaining reliability defect is not live watch pressure. It is that retained terminal debt and live action debt are
still blended in the control-plane decision loop. Kubernetes retained `112` failed AgentRuns overall, `13` failed
AgentRuns created in the last 24 hours, `32` failed jobs, and `51` failed pods in the `agents` namespace. The current
Jangar status route correctly held material readiness, but it also emitted long reason lists where current blockers,
historical failures, Torghut repair-only capital holds, and missing outcome receipts all share one channel. Stage credit
is still `observe`, stage accounts are `hold` for discover/plan/implement/verify, and runner slot futures are empty
even though recent workflow health is clean: `active_job_runs=0`, `recent_failed_jobs=0`, and
`backoff_limit_exceeded_jobs=0` over the same 15 minute window.

The selected design separates **active debt** from **retained audit debt**. Active debt can hold launch, burn credit,
or require repair. Retained audit debt is compacted into evidence cohorts that remain queryable but do not by
themselves block a new launch window. Every admitted repair lot must then close through outcome escrow: the repair
AgentRun either produces a typed receipt that retires named reason codes, proves no delta and rolls the lot forward, or
burns the slot with an explicit terminal debt record.

The tradeoff is that this design asks implementation to stop treating "failed objects exist" as a sufficient launch
blocker. That is a higher bar than blanket caution. I accept it because the business metric is reducing failed
AgentRuns and shortening green PR-to-healthy GitOps rollout time. We need less manual interpretation, not more stale red
objects in a namespace.

## Governing Runtime Requirements

This design binds to the current swarm validation contract:

- every run must cite the governing design or runtime requirement before changing code;
- implement stages must produce production PRs with tests or report the exact blocker to code;
- verify stages must merge only green PRs and prove Argo, workload readiness, and service health after rollout;
- final handoff must name the control-plane metric improved or the smallest blocker preventing improvement.

Every milestone maps to at least one required value gate:

- `failed_agentrun_rate`
- `pr_to_rollout_latency`
- `ready_status_truth`
- `manual_intervention_count`
- `handoff_evidence_quality`

## Read-Only Evidence Snapshot

All evidence in this pass was collected read-only on 2026-05-13. I did not mutate Kubernetes resources, database
records, GitOps resources, AgentRuns, Torghut trading flags, broker state, or data rows.

### Cluster, Rollout, And Events

- The working branch was `codex/swarm-jangar-control-plane-discover`, aligned with `origin/main` at
  `bbe9dd519 chore(jangar): promote image f5ed7394 (#6409)` before this artifact was authored.
- Previous same-head architecture PRs, including `#5680` and later `#6373`, were already merged. This is a fresh
  discover increment on the required head branch.
- Kubernetes auth resolved to `system:serviceaccount:agents:agents-sa`. The workspace kube context was bootstrapped to
  `in-cluster` from the service-account token and CA before cluster checks.
- `kubectl get applications.argoproj.io -A` reported `jangar=Synced/Healthy`, `agents=Synced/Healthy`, and
  `torghut=Synced/Healthy` after the current rollout settled. Earlier in the same run `agents` was
  `Synced/Progressing` while new `agents` and `agents-controllers` pods were replacing older replicas; the rollout
  settled without local mutation.
- Jangar namespace pods were all Running. The Jangar pod `jangar-9b5489d5c-8dtbn` was `2/2` ready on image
  `registry.ide-newton.ts.net/lab/jangar:f5ed7394@sha256:f8dcf217...`.
- Agents deployments were ready: `agents=1/1`, `agents-alloy=1/1`, and `agents-controllers=2/2`.
- Retained AgentRun phases in `agents` summarized to `576` Succeeded, `112` Failed, `11` Pending, `4` Running,
  `12` Template, and `1` Unknown. AgentRuns created in the last 24 hours summarized to `92` Succeeded, `13` Failed,
  `11` Pending, `4` Running, and `1` Unknown.
- Retained jobs in `agents` summarized to `136` Complete, `32` Failed, and `4` Active. Retained pods summarized to
  `205` Succeeded, `51` Failed, and `9` Running.
- Recent `agents` events showed normal CronJob creation/completion for Jangar and Torghut scheduled lanes plus rollout
  readiness noise during the image promotion. The currently observed Jangar control-plane status had
  `active_job_runs=0`, `recent_failed_jobs=0`, and `backoff_limit_exceeded_jobs=0` for the 15 minute workflow window.
- Jangar `/api/agents/control-plane/status?namespace=agents` reported `watch_reliability.status=healthy`,
  `observed_streams=2`, `total_events=726`, `total_errors=0`, and `total_restarts=0`.

### Source Architecture And Test Surface

- `services/jangar/src/server/agents-controller/index.ts` is 1,827 lines and owns AgentRun watch ingestion, resync,
  untouched-run detection, retention, and status adoption. It already records ingestion health, terminal outcomes, and
  retained untouchable backlog, but it does not compact terminal failure cohorts into an active-vs-retained debt
  boundary for schedulers.
- `services/jangar/src/server/agents-controller/agent-run-reconciler.ts` and
  `services/jangar/src/server/agents-controller/workflow-reconciler.ts` are both 1,190 lines. They are the high-risk
  transition surfaces for terminal state, idempotency, retry custody, and workflow step settlement.
- `services/jangar/src/server/agents-controller/job-runtime.ts` owns `ttlSecondsAfterFinished`, backoff limits, runner
  job creation, and job patching. It already supports bounded cleanup mechanics; the missing architecture is which
  terminal facts must be preserved before cleanup can stop affecting material readiness.
- `services/jangar/src/server/control-plane-status.ts` assembles the current status route and now emits
  `stage_credit_ledger`, `ready_truth_arbiter`, `watch_reliability`, and `repair_bid_admission`.
- `services/jangar/src/server/control-plane-stage-credit-ledger.ts` emits retained failure debt refs such as
  `clearance-failure-debt:15m:f76d3222`, `clearance-failure-debt:6h:69cfcb76`, and
  `clearance-failure-debt:7d:35a9115a`. The gap is that a retained cohort can still look operationally equivalent to
  current launch pressure.
- `services/jangar/src/server/control-plane-ready-truth-arbiter.ts` produces a material readiness `hold` with reason
  codes spanning controller witness, workflow runtime, source-serving, stage credit, repair bid, Torghut readiness, and
  capital proof. That is correct for safety, but it needs terminal debt classing so deployers know what is active.
- `services/jangar/src/server/control-plane-repair-bid-admission.ts` already admits three zero-notional Torghut repair
  lots while holding the rest. It needs an outcome escrow boundary so those admitted lots retire specific reason codes
  or come back as explicit no-delta debt.
- Existing tests cover watch reliability, control-plane status, stage credit, ready truth, repair-bid admission, and
  Torghut consumer evidence. The missing test family is terminal compaction: old failed AgentRuns must remain auditable
  while a clean 15 minute window and current controller witness can stop them from blocking normal material decisions.

### Database And Data Evidence

- Direct database inspection is intentionally not available to this worker service account. CNPG cluster listing was
  forbidden in `jangar` and `torghut`, `kubectl cnpg psql` failed because `pods/exec` is forbidden on `jangar-db-1`
  and `torghut-db-1`, and secret listing was forbidden in both namespaces. The smallest unblocker for direct row-level
  database evidence is a read-only database credential or a read-only psql/CNPG exec permission for this service
  account.
- Jangar app-derived database status is healthy: `configured=true`, `connected=true`, `status=healthy`,
  `latency_ms=18`, and migration consistency `29/29` with no missing or unexpected migrations.
- Torghut `/db-check` returned schema current with expected/current head
  `0031_autoresearch_candidate_spec_epoch_uniqueness`, one expected head, one current head, no missing/unexpected
  heads, lineage ready, and only known migration parent-fork warnings.
- Torghut `/readyz` and `/trading/health` returned HTTP `503` with `status=degraded` while Postgres, ClickHouse,
  Alpaca, universe, database, and empirical jobs were OK. Live submission remains blocked by `simple_submit_disabled`,
  active capital stage `shadow`, profitability proof floor `repair_only`, and capital state `zero_notional`.
- Torghut `/trading/consumer-evidence` returned HTTP `200` with schema
  `torghut.consumer-evidence-status.v1`, current receipt `torghut-consumer-evidence:9cdb5760d9d786dd`,
  fresh-until `2026-05-13T12:11:22.838424+00:00`, route warrant state `repair_only`, and three dispatchable
  zero-notional repair lots: `quant_pipeline`, `feature_lineage`, and `execution_tca`.
- Torghut repair evidence still carries blockers including `active_session_execution_samples_stale`,
  `execution_tca_stale`, `quant_health_not_configured`, `schema_lineage_missing`, `market_context_evidence_missing`,
  `research_candidates_empty`, `simple_submit_disabled`, and `profitability_proof_floor_repair_only`.

## Problem

Jangar has enough truth surfaces to know when it should hold material work. It does not yet have enough settlement
structure to distinguish stale terminal debris from active operational debt.

The concrete failure modes are:

1. Retained failed AgentRuns, failed Jobs, and failed Pods can keep a namespace looking unhealthy after the current
   rollout and 15 minute workflow window are clean.
2. Stage credit can name retained failure debt refs, but it does not classify whether each debt item is active,
   expired, compacted, settled, or audit-only.
3. Ready truth can correctly hold material readiness but cannot show which reason codes will clear automatically after
   a terminal compaction pass.
4. Repair-bid admission can launch zero-notional Torghut lots without a mandatory paired outcome receipt that proves a
   reason code was retired.
5. Deployer handoffs can report green Argo and healthy services while still inheriting old failed-object counts.
6. Operators fall back to manual interpretation because terminal objects are visible, but their material impact is not.
7. The failed AgentRun rate value gate is measured as a pile of terminal objects instead of a settled failure-debt
   flow.

## Alternatives Considered

### Option A: Keep Retained Terminal Counts As Stage-Credit Debt

The first path is to keep the current conservative behavior. Failed AgentRuns, failed Jobs, and failed Pods remain in
the status calculation until TTL or manual cleanup removes them.

Advantages:

- Simple and conservative.
- Preserves every terminal object for inspection.
- Avoids new settlement logic in the scheduler path.

Disadvantages:

- Keeps old failures operationally indistinguishable from current launch pressure.
- Makes PR-to-healthy rollout latency look worse after a successful rollout.
- Encourages manual cleanup as an implicit release gate.
- Does not tell Torghut whether an admitted repair lot produced a useful value-gate delta.

Decision: reject. Retention is necessary for audit, but retention cannot be the same as active launch debt.

### Option B: Aggressively Garbage Collect Failed Jobs And Pods

The second path is to lower TTLs and clean failed runtime objects faster.

Advantages:

- Reduces namespace noise.
- Makes pod/job counts easier to read.
- Uses existing Kubernetes TTL mechanics.

Disadvantages:

- Deletes evidence before it is compacted into a durable settlement record.
- Can hide recurring failure classes.
- Does not address AgentRun CR status or workflow-level failure debt.
- Does not pair repair dispatch tickets with outcome receipts.

Decision: reject as the primary architecture. Cleanup is useful only after settlement.

### Option C: Terminal Debt Compaction With Repair Outcome Escrow

The selected path introduces a durable terminal debt ledger. The ledger compacts terminal AgentRuns, Jobs, Pods,
workflow steps, and repair lots into typed cohorts. It assigns every cohort one of five states:

- `active`: current enough to affect launch, stage credit, or ready truth.
- `pending_settlement`: terminal object exists but the controller has not yet compacted it.
- `settled`: outcome receipt exists and names the reason codes retired or preserved.
- `retained_audit`: old enough that it remains queryable but no longer blocks launch.
- `suppressed_duplicate`: superseded by idempotency, retry custody, or a later successful attempt.

Advantages:

- Keeps audit evidence without letting old red objects block new work.
- Gives ready truth and stage credit a stable active-debt input.
- Converts repair dispatch into measurable outcome receipts.
- Reduces manual intervention by making cleanup safe after compaction.
- Lets deployers prove a green rollout without ignoring historical failures.

Disadvantages:

- Requires a new reducer and tests across controller, status, and scheduler surfaces.
- Needs careful TTL policy so fresh failures do not get prematurely demoted.
- Adds another evidence contract that implementers must cite.

Decision: select Option C.

## Architecture

The new status payload is `terminal_debt_compaction_ledger`.

```text
terminal_debt_compaction_ledger
  schema_version = jangar.terminal-debt-compaction-ledger.v1
  generated_at
  fresh_until
  evidence_mode = observe | shadow | hold | enforce
  namespace
  source_windows[]
  active_debt_summary
  retained_audit_summary
  cohorts[]
  repair_outcome_escrows[]
  scheduler_contract
  deployer_contract
  rollback_contract
```

Each cohort records:

```text
terminal_debt_cohort
  cohort_id
  class = agentrun | job | pod | workflow_step | torghut_repair_lot | source_ingest | metrics_sink
  stage
  action_class
  state
  first_seen_at
  last_seen_at
  expires_active_at
  retained_until
  count
  reason_codes[]
  representative_refs[]
  compacted_artifact_ref
  active_gate_effect = allow | hold | block | audit_only
  value_gates[]
```

Repair outcome escrow records:

```text
repair_outcome_escrow
  escrow_id
  dispatch_ticket_id
  repair_lot_id
  expected_output_receipt
  expected_reason_code_delta[]
  launched_agentrun_ref
  terminal_state = pending | succeeded | failed | timed_out | superseded
  outcome = pending | retired_reason_codes | no_delta | degraded | invalid_receipt
  retired_reason_codes[]
  preserved_reason_codes[]
  next_action = release_credit | burn_credit | roll_forward | hold
```

The reducer consumes:

- AgentRun CR phase, reason, start/completion timestamps, labels, annotations, and contract refs.
- Job status, `BackoffLimitExceeded`, `ttlSecondsAfterFinished`, pod exit codes, and owner refs.
- Jangar `workflows` 15 minute status.
- Watch reliability status and current controller witness.
- Stage credit ledger retained failure debt refs.
- Ready truth arbiter material readiness and merge/deployer receipts.
- Repair-bid admission dispatch tickets.
- Torghut `/trading/consumer-evidence` repair-bid settlement lots and fresh-until clocks.

The reducer emits two separate numbers for every consumer:

- `active_debt_count`: affects launch, ready truth, stage credit, and deployer claims.
- `retained_audit_count`: kept for history, review, and handoff quality, but does not block launch by itself.

## Scheduler Contract

The supporting-primitives schedule runner must use terminal debt as follows:

- `serve_readonly`: allowed when Jangar serving and database status are healthy, regardless of retained audit debt.
- `discover` and `plan`: held only when active debt exists for the same swarm/stage/action class or controller witness
  is not current.
- `implement`: allowed for bounded repair only when the repair outcome escrow can name an expected output receipt and
  reason-code delta.
- `verify`: allowed only when active debt for the target rollout window is zero or explicitly marked audit-only.
- `deploy_widen` and `merge_ready`: held when active debt is nonzero, but retained audit debt must be reported as
  context rather than a blocker.

When `evidence_mode=observe`, the scheduler only stamps terminal-debt fields on launches. In `shadow`, it logs the
would-hold decision. In `hold`, it suppresses matching schedule objects. In `enforce`, it also burns or refunds stage
credit based on terminal settlement.

## Torghut Repair Outcome Contract

Torghut repair lots remain zero-notional. Jangar must not widen capital because a repair lot ran. It can only release
the next repair tranche when a typed receipt proves one of these outcomes:

- `quant_pipeline`: retires `quant_health_not_configured` with a current `torghut.quant-pipeline-current-receipt.v1`.
- `feature_lineage`: retires `forecast_registry_degraded` or `schema_lineage_missing` with a current
  `torghut.feature-lineage-current-receipt.v1`.
- `execution_tca`: retires `execution_tca_stale` or records why TCA remains stale with a current
  `torghut.execution-tca-current-receipt.v1`.
- `market_context`: retires `market_context_evidence_missing` with a current
  `torghut.market-context-current-receipt.v1`.

The repair outcome escrow must preserve `max_notional=0`, `capital_stage=shadow`, and `simple_submit_disabled` until
the separate Torghut capital proof contracts are satisfied.

## Implementation Milestones

### Milestone 1: Observe-Mode Terminal Debt Ledger

Value gates: `ready_status_truth`, `handoff_evidence_quality`, `failed_agentrun_rate`.

Engineer scope:

- Add `control-plane-terminal-debt-compaction.ts`.
- Add `TerminalDebtCompactionLedger` types to `services/jangar/src/data/agents-control-plane.ts` and status types.
- Add the ledger to `/api/agents/control-plane/status`.
- Group retained AgentRuns, Jobs, and Pods into active and retained audit cohorts.
- Add tests proving a clean 15 minute workflow window with historical failures emits retained audit debt, not active
  debt.

Acceptance gates:

- `bun run --filter @proompteng/jangar test -- src/server/__tests__/control-plane-terminal-debt-compaction.test.ts`
- `bun run --filter @proompteng/jangar test -- src/server/__tests__/control-plane-status.test.ts`
- `bun run --filter @proompteng/jangar tsc`
- `bun run --filter @proompteng/jangar lint`

### Milestone 2: Stage Credit And Ready Truth Consumption

Value gates: `failed_agentrun_rate`, `pr_to_rollout_latency`, `ready_status_truth`.

Engineer scope:

- Feed `active_debt_summary` into stage credit and ready truth.
- Keep `retained_audit_summary` visible in receipts without making it a launch blocker.
- Stamp `terminalDebtLedgerId`, `activeDebtCount`, and `retainedAuditDebtCount` on schedule-runner launches.

Acceptance gates:

- Existing stage-credit and ready-truth tests gain cases for active vs retained debt.
- A dry-run status payload shows retained failures but `active_debt_count=0` when the current workflow window is clean.

### Milestone 3: Repair Outcome Escrow

Value gates: `failed_agentrun_rate`, `manual_intervention_count`, `handoff_evidence_quality`.

Engineer scope:

- Bind repair-bid admission dispatch tickets to an outcome escrow entry.
- Require accepted repair AgentRuns to declare the output receipt schema they will produce.
- Mark repair slots `retired_reason_codes`, `no_delta`, `invalid_receipt`, or `timed_out`.
- Roll forward no-delta lots without opening paper/live capital.

Acceptance gates:

- Repair-bid tests prove `dispatch_repair` requires an escrow and expected receipt.
- A failed repair AgentRun burns only the repair slot it consumed, not the whole stage.

### Milestone 4: Deployer Gate And Cleanup Safety

Value gates: `pr_to_rollout_latency`, `manual_intervention_count`, `ready_status_truth`.

Deployer scope:

- Use terminal debt active count in post-rollout verification.
- Treat retained audit count as evidence, not as a blocker.
- Only lower Kubernetes TTLs or delete terminal Jobs after a cohort has a compacted artifact ref.

Acceptance gates:

- Verify handoff includes Argo status, workload readiness, service health, terminal active debt, retained audit debt,
  and any rollback target.
- Rollback is a config-mode change to `observe` or `disabled`; no database row deletion is needed.

## Validation

Local validation for the architecture artifact:

- `bunx oxfmt --check docs/agents/designs/189-jangar-terminal-debt-compaction-and-repair-outcome-escrow-2026-05-13.md`
- `bunx oxfmt --check docs/torghut/design-system/v6/193-torghut-repair-outcome-dividend-ledger-and-capital-reentry-frontier-2026-05-13.md`
- `bunx oxfmt --check docs/agents/README.md docs/torghut/design-system/v6/index.md`

Production validation after implementation:

- Argo `jangar`, `agents`, and `torghut` are `Synced/Healthy`.
- Jangar `/ready` returns HTTP `200`.
- Jangar `/api/agents/control-plane/status?namespace=agents` returns `terminal_debt_compaction_ledger`.
- `terminal_debt_compaction_ledger.active_debt_summary.count` is zero for a settled rollout window before
  `merge_ready`.
- Retained failed AgentRuns remain visible through `retained_audit_summary`.
- Torghut `/trading/consumer-evidence` remains HTTP `200`, repair-only, and zero-notional.
- Every admitted repair dispatch ticket has a matching escrow or an explicit blocker.

## Rollout

1. Ship the ledger in `observe` mode and add status tests.
2. Enable `shadow` stamping for schedule-runner launches.
3. Enable `hold` for duplicate same-stage launches where active debt is nonzero.
4. Enable repair outcome escrow for zero-notional Torghut lots.
5. Enable deployer gate consumption after two green rollout windows show active/retained separation.

## Rollback

Rollback is intentionally cheap:

- Set terminal debt compaction mode to `observe` or `disabled`.
- Keep retained audit cohorts visible but stop using active debt in launch admission.
- Keep repair-bid admission in its current mode and preserve `max_notional=0`.
- Do not delete compacted artifacts or terminal AgentRuns during rollback.

## Risks

- A bad compaction window could demote a fresh failure too early. Mitigation: active TTLs are conservative and tied to
  creation/completion timestamps plus current workflow window health.
- A repair AgentRun can claim success without retiring the promised reason code. Mitigation: outcome escrow validates
  typed receipts and records `no_delta`.
- Status payload size can grow. Mitigation: cohorts carry representative refs and counts; detailed objects stay behind
  existing resource/log routes.
- Direct row-level database evidence is not available to this worker. Mitigation: app-derived DB status remains the
  normal evidence surface, and direct DB access is listed as an explicit unblocker when required.

## Handoff

Engineer next action: implement Milestone 1 in observe mode. The smallest production PR is the terminal debt reducer,
types, status attachment, and unit tests for active vs retained debt.

Deployer next action: after the engineer PR lands, verify Jangar/Agents/Torghut Argo health, Jangar `/ready`, Jangar
control-plane status, terminal active debt count, retained audit debt count, and Torghut zero-notional consumer
evidence before claiming `merge_ready`.

The control-plane metric improved by this architecture is `failed_agentrun_rate` through active debt admission and
`pr_to_rollout_latency` through a clearer distinction between current rollout blockers and retained audit evidence.
