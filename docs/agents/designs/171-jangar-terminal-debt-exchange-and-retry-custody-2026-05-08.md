# 171. Jangar Terminal Debt Exchange And Retry Custody (2026-05-08)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-08
Owner: Victor Chen, Jangar Engineering Architecture
Scope: Jangar control-plane terminal run evidence, failed Kubernetes jobs, rollout handoff debt, retry custody,
cleanup admission, material-action gates, and Torghut repair consumption.

Companion Torghut contract:

- `docs/torghut/design-system/v6/175-torghut-failure-costed-context-repair-and-route-custody-2026-05-08.md`

Extends:

- `170-jangar-continuity-witness-ledger-and-attested-dispatch-packets-2026-05-08.md`
- `169-jangar-ready-action-evidence-exchange-and-deployer-custody-2026-05-07.md`
- `167-jangar-terminal-evidence-half-life-and-debris-retirement-2026-05-07.md`
- `docs/torghut/design-system/v6/174-torghut-continuity-priced-route-repair-market-and-capital-holds-2026-05-08.md`

## Decision

I am selecting a **terminal debt exchange with retry custody** as the next Jangar control-plane architecture step.

The current cluster has recovered serving capacity, but recovery has left debt behind. On 2026-05-08 at 00:23Z,
`deployment/jangar`, `deployment/agents`, and `deployment/agents-controllers` were available on revision
`ef2bba88`. Jangar `/ready` returned `status=ok`, the status route reported a healthy Jangar database with 28
registered and 28 applied Kysely migrations, and watch reliability had no errors in the sampled 15 minute window.
Those are good serving facts.

The same read-only pass showed why serving health is not enough. The Jangar rollout emitted readiness failures during
handoff before the current pod became ready. The Agents namespace still contained a large population of terminal run
pods, and fresh Torghut market-context provider jobs for `INTC`, `AMZN`, and `ORCL` ended with
`BackoffLimitExceeded`. The control-plane status route still held `dispatch_repair`, `dispatch_normal`,
`deploy_widen`, and `merge_ready` because source/GitOps revision evidence was missing, controller heartbeat was not
current for material action purposes, and multiple witness refs were unsettled.

The decision is to make terminal evidence a first-class exchange rather than background debris. Jangar will publish a
typed `terminal_debt_note` for terminal pods, failed jobs, rollout handoff gaps, source attestation gaps, controller
projection splits, and consumer capital holds. Cleanup and retry are separate custody actions. A failed job can be
cleaned only after the debt note is snapshotted. A retry can be launched only with a retry budget that names the
failure class, cooldown, circuit state, expected consumer value, and rollback target.

The tradeoff is extra accounting before retrying routine failures. I accept that cost. The six-month reliability risk
is not one failed market-context job; it is a control plane that repeatedly retries, deletes, or ignores terminal
evidence until the dashboard looks quieter while material action authority is still unpriced.

## Success Metrics

Success means:

- Jangar exposes `terminal_debt_exchange` in shadow mode with counts by namespace, debt class, age, producer revision,
  cleanup eligibility, retry eligibility, and material-action effect.
- Every terminal Kubernetes pod or failed job matching an owned control-plane workload has a durable debt note before
  cleanup is allowed.
- Market-context `BackoffLimitExceeded` jobs create retry custody notes that preserve symbol, domain, failure category,
  provider circuit state, active run state, attempt budget, and cooldown.
- Rollout handoff readiness failures are retained as `rollout_handoff` notes until a continuity epoch proves the
  replacement pod has source, endpoint, controller, watch, and database continuity.
- `serve_readonly` and Torghut observe actions can stay allowed during debt settlement.
- `dispatch_repair`, `dispatch_normal`, `deploy_widen`, and `merge_ready` remain held while unacknowledged terminal
  debt can change the source, controller, or consumer proof state.
- The deployer can run a cleanup plan that is evidence-preserving, bounded, and reversible at the Jangar action gate.
- Torghut receives debt refs it can price into context repair and route custody before any paper/live capital upgrade.

## Evidence Snapshot

All evidence in this pass was collected read-only. I did not mutate Kubernetes resources or database records.

### Cluster And Rollout Evidence

- The workspace branch was `codex/swarm-jangar-control-plane-plan` and was clean before edits.
- `kubectl config current-context` was unset in the Coder workspace. `kubectl auth whoami` still verified
  `system:serviceaccount:agents:agents-sa`, so the service account had read access to the relevant namespaces.
- Jangar namespace deployments `bumba`, `jangar`, `jangar-alloy`, `symphony`, and `symphony-jangar` were available.
- `deployment/jangar` was serving revision `registry.ide-newton.ts.net/lab/jangar:ef2bba88` through pod
  `jangar-57fd7b7c84-t97l8` with ready endpoints on port 8080.
- Recent Jangar events recorded the prior pod deletion and readiness probe failures during startup before the current
  pod became ready.
- Agents namespace deployments `agents`, `agents-controllers`, and `agents-alloy` were available on the sampled
  revision. The active controller heartbeat came from `agents-controllers-87fd5bfbb-2mz9t`.
- The Agents namespace had many historical terminal run pods. Fresh Torghut market-context jobs for
  `fundamentals-intc`, `news-intc`, `fundamentals-amzn`, `news-amzn`, `fundamentals-orcl`, and related provider
  domains reached `BackoffLimitExceeded` around the sampled window.
- Torghut namespace had active live and sim revisions, Postgres, ClickHouse, TA, options, and websocket workloads
  running. Events still showed rollout readiness/startup probe failures on recent revisions and repeated
  `MultiplePodDisruptionBudgets` warnings for ClickHouse pods.

### Source Evidence

- `services/jangar/src/server/supporting-primitives-controller.ts` is 3,314 lines and owns schedule launch admission,
  runtime admission traces, run template generation, runner cleanup, CRD checks, and status reconciliation. It is the
  right producer for schedule-runner terminal debt, but it is too large to hide cleanup semantics inside local helper
  paths.
- `services/jangar/src/server/primitives-kube.ts` now supports `PersistentVolumeClaim` and aliases such as `pvc`,
  which means the earlier storage-proof gap is repaired. The next risk is not missing PVC support; it is missing debt
  custody for the objects the controller already knows how to observe and delete.
- `services/jangar/src/server/control-plane-status.ts` is 787 lines and already joins rollout health, database health,
  watch reliability, source rollout truth, negative evidence, route stability, and material action receipts. It should
  project terminal debt, not own the debt reducer.
- `services/jangar/src/server/control-plane-source-rollout-truth-exchange.ts` is 632 lines and already produces the
  strongest source/GitOps and controller evidence for material actions. Terminal debt should consume that authority
  rather than duplicate it.
- `services/jangar/src/agents/torghut-market-context-agents.ts` is 2,028 lines and already classifies provider
  failures, circuit state, active runs, stale-last-good snapshots, cooldown suppression, and attempt budgets. The gap
  is cross-plane custody: Kubernetes job failure and provider circuit failure are not yet priced into Jangar material
  action or Torghut route repair admission as one debt note.
- Existing tests cover schedule runner command construction, admission blocked cleanup, unavailable snapshot
  fail-closed behavior, PVC object handling, provider circuits, stale snapshot dispatch, active run suppression, and
  cooldown suppression. The missing tests are the terminal debt reducer, cleanup-before-snapshot denial, and retry
  budget admission.

### Database And Data Evidence

- Jangar status reported database `configured=true`, `connected=true`, `status=healthy`, and low latency.
- Jangar Kysely migrations were consistent with `registered_count=28`, `applied_count=28`, `unapplied_count=0`,
  `unexpected_count=0`, and latest migration `20260505_torghut_quant_pipeline_health_window_index`.
- Direct CNPG `psql` access was forbidden for the service account in both `jangar` and `torghut` namespaces. That is a
  least-privilege constraint, not a blocker, because the application health surfaces already expose schema state. It
  does mean any future debt table validation should be exposed through Jangar status or a read-only report endpoint.
- Torghut `/db-check` was `ok=true` with Alembic head `0029_whitepaper_embedding_dimension_4096`; lineage warnings
  remained for known parent forks after revisions `0010_execution_provenance_and_governance_trace` and
  `0015_whitepaper_workflow_tables`.
- Torghut `/readyz` was degraded with proof floor `repair_only`, capital state `zero_notional`, alpha readiness at
  3 total hypotheses and 0 promotion-eligible, and route TCA incomplete across 8 scoped symbols.
- Torghut market context had market-closed staleness that remained informational, but the fresh provider job
  `BackoffLimitExceeded` events are stronger negative evidence than a normal closed-market stale snapshot.

## Problem

Jangar currently treats several failure signals as status detail, while operational workflows treat them as cleanup or
retry chores. That gap is dangerous:

1. Terminal pods can be cleaned to reduce namespace noise before the failure is preserved as action-grade evidence.
2. Failed provider jobs can be retried without a bounded budget tied to symbol, domain, cooldown, and expected value.
3. Rollout handoff readiness failures can disappear behind the final ready endpoint state.
4. Material action verdicts can hold for source or controller reasons while another lane continues to generate
   retries that change downstream Torghut proof state.
5. Torghut can see degraded market-context and route evidence, but it does not receive a Jangar-owned debt ref that
   explains whether repair is allowed, blocked, or merely observable.

The control plane needs a durable market for negative evidence. Cleanup is not neutral; it is an action that changes
what deployers and consumers can prove later. Retry is not neutral either; it spends provider budget and can make stale
or failed data look fresh if it is not tied to a failure class.

## Alternatives Considered

### Option A: Keep Status-Only Holds

Continue to expose terminal pods, rollout events, and provider failures through Kubernetes status, Jangar status, and
Torghut readiness. Rely on existing material-action verdicts to prevent dangerous promotion.

Advantages:

- Lowest implementation cost.
- Keeps current reducers and tests intact.
- Avoids creating another persisted control-plane model.

Disadvantages:

- Does not preserve cleanup intent or retry history.
- Forces deployers to correlate Kubernetes job failures with source rollout truth and Torghut proof floor manually.
- Lets terminal evidence remain namespace noise instead of becoming an ordered repair queue.

Decision: reject as the main direction. The current holds are useful, but they do not price terminal evidence.

### Option B: Aggressive TTL Cleanup

Add stronger TTL cleanup for completed and failed runner pods and let provider jobs retry on their existing schedules.

Advantages:

- Reduces the obvious namespace clutter quickly.
- Keeps Kubernetes object count under control.
- Requires little consumer contract work.

Disadvantages:

- Deletes evidence before it becomes a durable audit artifact.
- Can hide repeated failure classes by smoothing the namespace view.
- Does not tell Torghut whether a failed context job is cheap retry debt or a capital-blocking data dependency.

Decision: keep TTL cleanup as a consumer of the exchange, never as the source of authority.

### Option C: Terminal Debt Exchange With Retry Custody

Persist typed debt notes for terminal and failed objects, separate cleanup from retry, and require material actions to
consider unsettled debt before promotion.

Advantages:

- Converts negative evidence into an auditable, testable control-plane surface.
- Lets read-only serving continue while cleanup and retry are bounded.
- Gives Torghut a single Jangar debt ref for failure-costed context repair and route custody.
- Improves reliability by reducing repeated unpriced retries and evidence-erasing cleanup.

Disadvantages:

- Requires a new reducer, status projection, and migration.
- Adds more explicit holds during early rollout.
- Requires deployers to learn a cleanup plan that snapshots before deleting.

Decision: select Option C.

## Architecture

Jangar adds a `terminal_debt_exchange` read model backed by durable notes. A note is created whenever Jangar observes
terminal evidence that can influence rollout, dispatch, cleanup, retry, or consumer capital authority.

```text
terminal_debt_note
  schema_version
  note_id
  produced_at
  producer_revision
  namespace
  debt_class
  debt_state
  object_refs
  owner_kind
  owner_name
  source_head_sha
  gitops_revision
  continuity_epoch_id
  first_seen_at
  last_seen_at
  stale_after
  evidence_weight
  cleanup_allowed
  cleanup_after_snapshot_id
  retry_allowed
  retry_budget_ref
  material_action_effect
  consumer_refs
  rollback_target
```

The initial debt classes are:

- `rollout_handoff`: readiness/startup failures, endpoint gaps, or leader changes during a rollout.
- `terminal_run_debris`: completed, failed, or errored AgentRun pods and jobs whose evidence has not been snapshotted.
- `market_context_provider_failure`: Torghut context provider jobs with structured failure categories or Kubernetes
  `BackoffLimitExceeded`.
- `source_attestation_gap`: missing source head, GitOps revision, or worktree snapshot evidence required for material
  actions.
- `controller_projection_split`: disagreement between `/ready`, controller heartbeat, watch epoch, and status-route
  controller state.
- `consumer_capital_hold`: downstream proof-floor or capital holds that must block Jangar promotion actions.

Debt states are `observed`, `acknowledged`, `settling`, `settled`, `expired`, and `waived`. Waiver is allowed only for
documented non-material objects and must cite the producer revision and deployer approval reason.

## Retry Custody

Retry custody is a second reducer that consumes debt notes and emits bounded retry leases.

```text
retry_custody_lease
  lease_id
  debt_note_id
  workload_kind
  namespace
  symbol
  domain
  failure_category
  provider_circuit_state
  active_run_ref
  attempt_budget
  cooldown_until
  expected_unblock_value
  max_parallelism
  paper_or_live_effect
  expires_at
  rollback_target
```

Rules:

1. A retry lease cannot exist without a debt note.
2. A cleanup decision cannot delete the referenced Kubernetes object until `cleanup_after_snapshot_id` exists.
3. `provider_circuit_open` and `BackoffLimitExceeded` require cooldown and attempt budget before retry.
4. Market-closed staleness may be informational; provider job failure is not informational when it changes route,
   alpha, or context receipts.
5. A retry lease can unblock `serve_readonly` and Torghut observe repair, but it cannot upgrade paper/live capital by
   itself.
6. `source_attestation_gap` and `controller_projection_split` debt keeps `dispatch_repair`, `dispatch_normal`,
   `deploy_widen`, and `merge_ready` held until settled or explicitly waived.

## Material Action Effects

The exchange feeds the existing material action verdict reducer:

- `serve_readonly`: allow when route, database, and runtime readiness are healthy, even if terminal debt exists.
- `torghut_observe`: allow when debt is snapshotted and retry/cleanup remains zero-notional.
- `dispatch_repair`: hold while source, controller, or market-context provider debt is unsettled unless the dispatch is
  the bounded repair named by a retry custody lease.
- `dispatch_normal`: hold while any action-grade debt is unsettled.
- `deploy_widen`: hold while rollout handoff or source attestation debt exists.
- `merge_ready`: hold until terminal debt, continuity witness, and consumer proof-floor refs are settled for the target
  revision.
- `paper_canary`, `live_micro_canary`, and `live_scale`: block unless Torghut consumes the debt refs and returns a
  passing proof-floor/capital packet.

This preserves the current conservative behavior while making the reason actionable.

## Implementation Scope

Engineer stage:

- Add a database migration for `terminal_debt_notes` and `retry_custody_leases`.
- Implement a terminal debt reducer under `services/jangar/src/server/` that accepts Kubernetes object summaries,
  rollout events, source rollout truth, controller witness state, and Torghut provider failure summaries.
- Extend `supporting-primitives-controller` so cleanup plans ask the reducer for `cleanup_allowed` and write snapshot
  refs before deleting runner resources.
- Extend market-context provider orchestration so `BackoffLimitExceeded`, provider circuit open, attempt timeout,
  payload validation failure, and finalize callback failure all create debt notes with retry custody metadata.
- Project debt counts and top blocking notes through `/api/agents/control-plane/status`.
- Add tests for debt-note classification, cleanup-before-snapshot denial, retry budget cooldown, material-action
  effect mapping, and controller projection split detection.

Deployer stage:

- Roll out the exchange in shadow mode with write enabled and enforcement disabled.
- Compare debt counts against Kubernetes terminal pod/job counts before enabling cleanup admission.
- Enable cleanup admission for `terminal_run_debris` only after snapshot coverage is 100 percent for a full rollout
  window.
- Enable retry custody for market-context provider jobs before allowing any context repair packet to influence Torghut
  paper admission.
- Keep `dispatch_normal`, `deploy_widen`, `merge_ready`, and live Torghut actions on the existing conservative verdict
  until shadow debt and material verdicts agree for two consecutive observation windows.

## Validation Gates

Engineer acceptance:

- Unit tests prove each debt class maps to the correct material-action effect.
- A failed market-context Kubernetes job with `BackoffLimitExceeded` emits one stable debt note and one retry custody
  candidate, not repeated independent retries.
- Cleanup tests prove a runner object cannot be deleted before its debt note has a snapshot id.
- Status-route tests prove healthy `/ready` cannot hide `controller_projection_split` debt.
- Regression tests cover the prior schedule-runner namespace expression failure path as terminal debt, even when the
  newer command template is fixed.

Deployer acceptance:

- Shadow exchange reports terminal pod/job counts within one object of `kubectl get pods,jobs -n agents` for owned
  labels.
- The fresh Torghut market-context failures produce `market_context_provider_failure` notes with symbol/domain
  metadata.
- The current Jangar source/GitOps and heartbeat holds produce `source_attestation_gap` or
  `controller_projection_split` notes.
- Cleanup dry-run shows the exact objects to delete, snapshot ids, and rollback plan.
- Torghut observe repair remains allowed; paper/live remains blocked while proof floor is `repair_only` and capital
  state is `zero_notional`.

## Rollout Plan

1. Ship the schema and reducer behind `JANGAR_TERMINAL_DEBT_EXCHANGE_MODE=shadow`.
2. Emit status projection only, with no cleanup or retry behavior changes.
3. Backfill active terminal pod/job notes from Kubernetes summaries and recent controller status evidence.
4. Enable cleanup admission for completed objects after snapshot coverage is proven.
5. Enable failed-job retry custody for market-context jobs with cooldown and attempt budgets.
6. Feed debt refs into material action verdicts in hold-only mode.
7. Allow Torghut to consume the debt refs for failure-costed context repair.
8. Promote to enforcement only after deployer evidence shows no mismatch between debt refs and existing conservative
   holds.

## Rollback Plan

Rollback disables enforcement before disabling writes:

1. Set the exchange mode back to `shadow`.
2. Disable retry custody lease creation.
3. Leave existing debt notes readable for audit and cleanup reconciliation.
4. Revert material-action verdict inputs to the previous source rollout truth, controller witness, route stability, and
   proof-floor reducers.
5. Keep cleanup paused for objects whose debt note was created during the rollback window until a deployer snapshots
   them manually.

This rollback keeps evidence durable even if enforcement is withdrawn.

## Risks And Mitigations

- Risk: debt-note volume grows quickly in the Agents namespace. Mitigation: store compact object refs, aggregate settled
  notes by owner after retention, and expose counts before full note lists.
- Risk: retry custody slows legitimate repair. Mitigation: allow bounded repair dispatch when the retry lease is the
  named settlement action and the lease is zero-notional.
- Risk: cleanup admission blocks namespace hygiene. Mitigation: start with shadow mode and completed-object cleanup
  before failed-object cleanup.
- Risk: provider failures are double-counted by Kubernetes and application status. Mitigation: derive stable note ids
  from namespace, owner, symbol, domain, failure category, and first terminal transition.
- Risk: direct DB validation remains forbidden to the service account. Mitigation: expose debt exchange schema and
  freshness through Jangar status and CI tests instead of relying on ad hoc `psql`.

## Handoff To Engineer

Build the terminal debt exchange as an additive control-plane surface. Do not start by changing cleanup behavior. The
first implementation milestone is a reducer and status projection that can prove the live terminal pod/job count, the
fresh market-context failures, and the existing material-action holds can be represented as debt notes.

Acceptance gates:

- `terminal_debt_notes` migration plus typed reducer tests.
- `supporting-primitives-controller` cleanup denial test for missing snapshot id.
- `torghut-market-context-agents` test for `BackoffLimitExceeded` to retry custody.
- `control-plane-status` projection test showing debt counts and top blocking reasons.
- Material-action reducer test proving `serve_readonly` can allow while `merge_ready` holds on unsettled debt.

## Handoff To Deployer

Deploy only in shadow mode first. Capture three numbers before enabling cleanup: owned terminal pod/job count in
Kubernetes, debt notes by class, and notes with snapshot ids. They should reconcile before deletion is allowed.

Promotion gates:

- Jangar `/ready` remains ok and status route shows debt exchange fresh.
- Jangar database migrations are current and debt projection has no stale producer revision.
- The current `BackoffLimitExceeded` market-context failures are represented as retry custody candidates.
- Cleanup dry-run produces object refs, snapshot ids, and rollback target.
- Torghut `/readyz` may remain degraded, but its route/context repair board must cite Jangar debt refs before paper or
  live capital can move beyond zero-notional.
