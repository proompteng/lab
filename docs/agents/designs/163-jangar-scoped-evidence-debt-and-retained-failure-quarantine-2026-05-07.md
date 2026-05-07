# 163. Jangar Scoped Evidence Debt And Retained Failure Quarantine (2026-05-07)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-07
Owner: Victor Chen, Jangar Engineering
Scope: Jangar control-plane resilience, scoped proof admission, retained failure classification, safer rollout, Torghut
capital guardrails, validation, rollback, and handoff.

Companion Torghut contract:

- `docs/torghut/design-system/v6/167-torghut-scoped-profit-repair-options-and-freshness-debt-retirement-2026-05-07.md`

Extends:

- `162-jangar-capital-receipt-convergence-and-repair-convoy-admission-2026-05-07.md`
- `161-jangar-stage-debt-clearinghouse-and-freshness-credit-ledger-2026-05-07.md`
- `157-jangar-shadow-parity-ledger-and-enforcement-release-train-2026-05-07.md`
- `docs/torghut/design-system/v6/166-torghut-executable-profit-receipts-and-repair-convoy-settlement-2026-05-07.md`

## Decision

I am selecting **scoped evidence debt with retained failure quarantine** as the next Jangar control-plane architecture
step.

The cluster is no longer in the broad outage shape reported by the earlier soak. Jangar is serving, the agents
controllers are available, Torghut live and simulation revisions are running, Jangar reports database migrations
healthy at 28 registered and 28 applied migrations, Torghut reports its Alembic head current at
`0029_whitepaper_embedding_dimension_4096`, and ClickHouse guardrails show both replicas reachable, writable, and
about 96 percent free on disk.

The remaining risk is more subtle. The control plane can look healthy while the evidence needed for material action is
not scoped enough to the action being admitted. The agents namespace still carries 38 failed pods and 15 failed-only
jobs. Newer scheduled jobs are completing, but older retained failures still pollute the operator view. Jangar
`/api/agents/control-plane/status` shows watch reliability healthy, but `agentrun_ingestion.status=unknown` with
message `agents controller not started`; route-stability escrow allows only read-only and Torghut observation while
holding dispatch, deploy widening, merge-ready, paper canary, and live capital classes. Torghut live proof floor is
`repair_only` with `capital_state=zero_notional`, live routeability is zero of eight symbols, market context is stale,
empirical jobs are stale, and alpha readiness has zero promotion-eligible hypotheses. Scoped paper quant health can be
empty while unscoped quant health reports OK.

The design answer is not another broad health flag. Jangar needs a **ScopedEvidenceDebtLedger** that says which
account, window, route, controller, rollout, schema, and market-data debts are still open for each action class. It
also needs a **RetainedFailureQuarantine** that separates current blockers from old failed pods, failed jobs, and stale
runner artifacts that have been superseded by later successful runs. Normal dispatch and capital remain closed when the
scoped debt is open. Bounded repair can proceed only when it targets one named debt class and defines the receipt that
will retire it.

The tradeoff is that Jangar will be stricter than the broad rollout view. A green deployment, green database, or green
unscoped metric will not clear a scoped paper or live gate. I accept that tradeoff because the current system is already
proving the opposite failure mode: healthy serving surfaces can coexist with zero routeable symbols, stale context, and
empty scoped quant proof.

## Evidence Snapshot

All evidence in this pass was collected read-only. I did not mutate Kubernetes resources, database records, GitOps
resources, AgentRuns, broker state, Torghut flags, or ClickHouse tables.

### Cluster And Rollout Evidence

- Branch: `codex/swarm-jangar-control-plane-plan`, fast-forwarded to current `origin/main` before edits.
- `kubectl auth whoami` identified `system:serviceaccount:agents:agents-sa`.
- Namespaces `agents`, `jangar`, `torghut`, `nats`, and `argocd` were active.
- Jangar pods were running: `jangar-865f8f4768-bq94m` was `2/2`, `jangar-db-1` was `1/1`, and OpenWebUI, Bumba,
  Symphony, Redis, and Alloy were running.
- Agents deployments were available: `agents=1/1`, `agents-controllers=2/2`, and `agents-alloy=1/1`.
- Agents pod summary was 9 running, 168 succeeded, and 38 failed. Jobs summary was 4 active, 167 succeeded, and 15
  failed-only.
- Recent agents events still showed readiness probe timeouts on `agents` and one controller replica, plus a
  `FailedMount` for a Torghut verify attempt whose ConfigMap was missing. More recent schedule cron jobs completed.
- Torghut live `torghut-00280-deployment` and sim `torghut-sim-00380-deployment` were both `1/1` on image digest
  `sha256:0927f669a37ccc4130ab7693a5ea91b446f4bc0cfb7709613fa49e00b8b95a4b`.
- Torghut options catalog, options enricher, TA, TA sim, ClickHouse, Keeper, WebSocket, and guardrail exporters were
  running. One retained `torghut-whitepaper-autoresearch-profit-target` pod remained in `Error`.
- Direct `pods/exec` and secret listing were forbidden in `jangar` and `torghut`, so typed HTTP status routes and
  exporter metrics are the database and data proof surfaces available to this worker.

### Source Evidence

- `services/jangar/src/server/control-plane-status.ts` is the convergence surface and is 787 lines. It already combines
  leader election, controller status, runtime adapters, database consistency, watch reliability, execution trust,
  material action verdicts, route stability escrow, runtime kits, proof cells, and empirical service status.
- `services/jangar/src/server/control-plane-route-stability-escrow.ts`,
  `control-plane-material-action-verdict.ts`, and `control-plane-source-rollout-truth-exchange.ts` already hold action
  admission ingredients, but they do not classify retained failure artifacts as retired versus active debt.
- `services/jangar/src/server/supporting-primitives-controller.ts` is 3314 lines and embeds the generated schedule
  runner script. The current script correctly separates pod namespace from schedule namespace and refreshes admission
  receipts, but retained pods from older cron runs still show as failed in the namespace.
- `services/jangar/src/server/primitives-kube.ts` has PVC support and typed Kubernetes primitives, but the same client
  exposes read and write operations. Engineer work should keep debt classification pure and route any mutation through
  existing admission paths.
- Source search found the newer vocabulary such as `stage_debt_clearinghouse`, `repair_outcome_brownout_market`,
  `quant_stage_cohort`, and `outcome_priced_repair_market` primarily in docs. This design makes missing higher-order
  ledgers explicit debt entries rather than hidden gates.

### Database And Data Evidence

- Jangar status reported `database.connected=true`, `status=healthy`, latency around 2-3 ms, and migration consistency
  healthy with 28 registered and 28 applied migrations. The latest registered and applied migration was
  `20260505_torghut_quant_pipeline_health_window_index`.
- Torghut `/db-check` returned `ok=true`, `schema_current=true`, expected and current head
  `0029_whitepaper_embedding_dimension_4096`, no missing or unexpected heads, and lineage-ready schema graph.
- Torghut schema still carries documented parent-fork warnings at `0010_execution_provenance_and_governance_trace` and
  `0015_whitepaper_workflow_tables`. Account-scope checks are marked ready, but with the warning that they are bypassed
  while multi-account trading is disabled.
- ClickHouse guardrail metrics reported both replicas reachable, no replicated table in read-only mode, disk free
  ratio about `0.968` and `0.964`, and TA signal/microbar freshness around `2026-05-07T20:21:28Z`.
- Jangar unscoped Torghut quant health for `15m` reported `status=ok`, 612 latest metrics, and 5 seconds of pipeline
  lag, but explicitly skipped account/window scoping.
- Jangar scoped paper quant health for `paper/1m` reported `status=degraded`, zero latest metrics, empty latest-store
  alarm, no stages, and stage scope not omitted.
- Jangar market-context health reported overall `degraded`: technicals and regime freshness around 812 seconds,
  fundamentals around 4,862,536 seconds, and news around 9,754 seconds.
- Torghut `/readyz` reported Postgres, ClickHouse, schema, universe, and readiness cache healthy, but service status
  `degraded` because live submit was disabled, profit proof floor was `repair_only`, scoped quant evidence had
  `quant_pipeline_stages_missing`, market context was stale, and capital remained zero notional.

## Problem

Jangar currently treats several different conditions as one broad readiness story:

1. Serving and rollout health.
2. Current controller/watch freshness.
3. Retained failures from earlier runs.
4. Scoped data proof for one account, window, symbol set, and action class.
5. Torghut profit proof and routeability.

Those conditions must not clear each other. A healthy rollout does not clear stale empirical proof. A healthy unscoped
quant store does not clear an empty account/window quant store. A retained failed pod does not necessarily block a
fresh schedule, but it must not disappear from audit. A current cron completion does not prove the earlier failure
class was retired unless the control plane can name the newer receipt that superseded it.

Without a scoped evidence debt ledger, deployers must infer too much from large status payloads. Without retained
failure quarantine, operators see a namespace full of old failed pods and cannot tell which failures still represent
active risk.

## Alternatives Considered

### Option A: Continue Extending The Broad Status Payload

Add more status fields to `/api/agents/control-plane/status` and let operators interpret them.

Pros:

- Fastest source change.
- Fits the current route.
- Avoids a new read model.

Cons:

- Repeats the current failure mode: the payload grows while action-specific gates remain implicit.
- Does not distinguish unscoped OK from scoped debt.
- Does not classify retained failures as retired, active, or superseded.

Decision: reject as the primary architecture.

### Option B: Clean Up Old Failures And Refresh Torghut Proof Directly

Treat the problem as operational debt: delete old failed pods, rerun empirical jobs, refresh market context, and refill
scoped quant proof.

Pros:

- Directly improves the current screen.
- Likely clears some blockers quickly.
- Minimal design work.

Cons:

- Cluster cleanup would be a mutation, outside this architecture lane.
- The same ambiguity returns after the next rollout.
- It does not make scoped proof a durable admission contract.

Decision: use as future repair work, not as the control-plane design.

### Option C: Scoped Evidence Debt Ledger And Retained Failure Quarantine

Materialize action-scoped evidence debt and separately classify retained failures as active, superseded, stale audit
debt, or retired by a later receipt.

Pros:

- Converts broad health into explicit action gates.
- Prevents unscoped data from satisfying scoped capital requirements.
- Lets old failed jobs remain visible without blocking unrelated current work.
- Uses typed routes and exporter metrics as first-class proof when direct DB access is not allowed.
- Gives engineer and deployer stages deterministic acceptance gates.

Cons:

- Adds one more read model to the control plane.
- Requires stable failure fingerprints across pods, jobs, schedules, and runner logs.
- Will hold normal dispatch longer until scoped proof is complete.

Decision: select Option C.

## Architecture

### ScopedEvidenceDebtLedger

Jangar publishes one ledger per namespace, consumer, action class, account, proof window, and evidence scope.

Required fields:

```text
scoped_evidence_debt_ledger
  schema_version
  ledger_id
  namespace
  consumer
  action_class
  account_label
  proof_window
  generated_at
  fresh_until
  rollout_ref
  database_ref
  watch_ref
  controller_ref
  torghut_ref
  debt_items
  action_decision
  allowed_repair_classes
  held_action_classes
  blocked_action_classes
  rollback_target
```

Debt item classes:

- `controller_witness`: `agentrun_ingestion.status=unknown`, missing controller heartbeat, or witness split.
- `retained_failure`: failed pods/jobs that lack a superseding success receipt.
- `schedule_runner`: ConfigMap missing, stale admission, stale namespace expression, or runner timeout.
- `schema`: migration mismatch, parent-fork error, account-scope error, or forbidden direct DB proof without a typed
  route replacement.
- `quant_scope`: account/window omitted, empty latest store, missing stages, lag, or materialization alarm.
- `market_context`: stale domain, low quality score, provider failure, or citation debt.
- `empirical`: stale or missing empirical jobs.
- `route_tca`: zero routeable symbols, stale TCA, unsettled execution, or slippage above guardrail.
- `capital_gate`: submit disabled, proof floor repair-only, shadow capital, or live/paper block.

### RetainedFailureQuarantine

Retained failures are not binary blockers. Jangar classifies them by fingerprint:

```text
retained_failure
  fingerprint
  namespace
  owner_kind
  owner_name
  resource_name
  first_seen_at
  last_seen_at
  phase
  reason
  failure_class
  superseding_receipt_ref
  quarantine_state
  action_effect
```

States:

- `active_blocker`: same failure class still occurring inside the action freshness window.
- `superseded`: a later successful run for the same schedule/stage exists, but the failure is still retained.
- `audit_only`: old failure kept for TTL and audit, not an admission blocker.
- `retired`: matched to a durable repair receipt and outside the retention risk window.

No controller may delete pods or jobs as part of this ledger. Deletion remains normal retention policy work. The ledger
only decides whether a retained object should affect action admission.

### Admission Policy

- `serve_readonly` can proceed when serving, database, and watch refs are current, even with retained failures.
- `torghut_observe` can proceed when typed Torghut routes are reachable and max notional is zero.
- `dispatch_repair` can proceed only when the repair targets one debt item and declares its retirement receipt.
- `dispatch_normal`, `deploy_widen`, and `merge_ready` hold while controller witness, retained failure, schedule
  runner, or schema debt is active.
- `paper_canary` holds while any quant scope, market context, empirical, route TCA, alpha readiness, or proof-floor
  debt remains open.
- `live_micro_canary` and `live_scale` block until paper receipts close and scoped capital proof is current.

## Validation Gates

Engineer gates:

- Add pure reducers for `ScopedEvidenceDebtLedger` and `RetainedFailureQuarantine` under the Jangar control-plane
  server code. Do not add mutation paths.
- Unit tests must cover unscoped quant OK plus scoped quant empty, retained failed cron plus later successful cron,
  ConfigMap-missing active failure, market-context stale domains, empirical job staleness, zero routeability, and
  schema-current with account-scope bypass warning.
- Status route tests must prove each material action class returns a finite decision and finite repair list.
- Snapshot tests must prove unknown new debt classes serialize as `unknown_debt` rather than being ignored.

Deployer gates:

- Before rollout, capture current `/api/agents/control-plane/status`, `/readyz`, `/db-check`, market-context health,
  quant health for the target account/window, and agents pod/job summaries.
- After rollout, `ScopedEvidenceDebtLedger` must show `serve_readonly=allow`, `torghut_observe=allow`,
  `dispatch_repair` either allow or hold with a named debt, and all paper/live capital classes held or blocked until
  Torghut proof closes.
- Retained failures may remain in Kubernetes, but each retained failed job older than the freshness window must be
  classified as `superseded`, `audit_only`, or `retired`; otherwise normal dispatch stays held.
- No paper/live notional change is allowed from this design.

## Rollout

1. Ship reducers in shadow mode and expose them under the control-plane status payload.
2. Compare decisions against current material-action verdicts for at least one full schedule cycle.
3. Promote `dispatch_repair` consumers to read the scoped debt ledger, still with max notional zero.
4. Only after parity is stable, let deployer gates use retained failure quarantine to distinguish active blockers from
   audit-only failures.

## Rollback

Rollback is straightforward because the new artifacts are read models:

- Hide `scoped_evidence_debt_ledger` and `retained_failure_quarantine` from status consumers.
- Continue using existing material-action verdicts, route-stability escrow, source-rollout truth, and Torghut proof
  floor receipts.
- Keep paper and live capital at zero notional until the old proof-floor and dependency-quorum gates clear.
- Do not delete retained failures as rollback. Retention cleanup is a separate operational policy.

## Risks

- Failure fingerprints can be too coarse and accidentally supersede unrelated failures. Mitigation: include namespace,
  owner, schedule/stage labels, image digest, exit reason, and relevant log signature when available.
- The ledger can over-hold repair if typed Torghut routes disagree with exporter metrics. Mitigation: classify route
  disagreement as explicit contradiction debt and allow only observation.
- Account/window scoping can be unavailable for some legacy consumers. Mitigation: legacy consumers stay observation
  only until they declare account and window.
- Broad status payload size can grow again. Mitigation: expose compact ledger summaries by default and keep raw debt
  details behind focused route/query parameters.

## Handoff

Engineer: implement the ledger and quarantine as pure reducers, add focused tests around the evidence cases above, and
wire the summary into the control-plane status route without changing Kubernetes or trading state.

Deployer: treat broad rollout health as serving evidence only. Normal dispatch and capital must follow scoped debt
decisions. Retained failures can be tolerated only when the quarantine state says they are superseded, audit-only, or
retired by a specific receipt.

## 2026-05-07 21:10Z Evidence Refresh

This refresh keeps the selected architecture unchanged. The newer evidence narrows the active risk: Jangar has recovered
the broad serving and schedule failure shape, but material action is still correctly held because the scoped debt is not
closed.

Read-only evidence collected from the `agents` service account showed:

- `GET /ready` returned `status=ok`, leader election current, execution trust healthy, and fresh runtime proof cells.
- Jangar pods were running, including `jangar-865f8f4768-bq94m` at `2/2`, `jangar-db-1` at `1/1`, and the supporting
  Bumba, OpenWebUI, Redis, Symphony, and Alloy pods.
- Agents pods showed `agents=1/1`, both `agents-controllers` replicas at `1/1`, and `agents-alloy=1/1`.
- Recent Jangar and Torghut scheduled cron jobs completed after the older failed cron wave. The retained failures are
  still visible in `agents`, which confirms the need for quarantine classification rather than manual interpretation.
- Recent events still showed transient readiness timeouts for `agents` and `agents-controllers`, plus a Torghut verify
  pod with missing input/spec ConfigMaps. Those failures must classify as active, superseded, or audit-only before
  normal dispatch can reenter.
- `GET /api/agents/control-plane/status?namespace=agents` reported database healthy with `28/28` migrations applied and
  latest migration `20260505_torghut_quant_pipeline_health_window_index`.
- The same status route reported watch reliability healthy over the current 15 minute window, but
  `agentrun_ingestion.status=unknown` with message `agents controller not started`.
- Controller authority was split by surface: agents and supporting controller status could be rollout-derived while the
  orchestration controller had heartbeat authority in the compact status sample.
- Route-stability and material-action evidence allowed serving and Torghut observation, but held `dispatch_repair`,
  `dispatch_normal`, `deploy_widen`, `merge_ready`, and `paper_canary`; live capital classes remained blocked.
- The held repair lists still named `source_rollout_truth_missing:source_or_gitops_revision`, AgentRun ingestion
  witness debt, Kubernetes/serving-process witness debt, watch-reliability repair, and missing
  `workflow_artifact.configmap_missing` closure for normal dispatch.

Torghut evidence reinforced the same scoped-debt boundary:

- The active live revision `torghut-00283` and simulation revision `torghut-sim-00383` were both running.
- `/db-check` was healthy with current and expected Alembic head `0029_whitepaper_embedding_dimension_4096`, no missing
  heads, no duplicate revisions, no orphan parents, and lineage-ready graph.
- Parent-fork warnings at `0010_execution_provenance_and_governance_trace` and
  `0015_whitepaper_workflow_tables` remained visible; account-scope checks were ready only under the documented
  multi-account-disabled bypass.
- Jangar market-context health for `NVDA` was degraded: technicals and regime were about `922s` old, news about
  `12363s`, and fundamentals about `4865116s`.
- Torghut `/readyz` returned HTTP `503` with proof floor `repair_only`, capital state `zero_notional`, live submission
  disabled, stale market context, degraded empirical jobs, zero promotion-eligible hypotheses, and route/TCA debt.

The implementation implication is sharper than the original text: do not spend engineering time on a new broad health
flag. The next reducer should make the current held state explainable by scoped debt IDs and retained-failure states.
The engineer acceptance gate for this refresh is that a fresh status sample can answer, without reading pod lists, why
`serve_readonly` and `torghut_observe` are open while dispatch, deploy widening, paper, and live capital are not.
