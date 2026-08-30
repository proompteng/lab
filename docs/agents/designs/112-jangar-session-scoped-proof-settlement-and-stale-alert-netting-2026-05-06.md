# 112. Jangar Session-Scoped Proof Settlement And Stale Alert Netting (2026-05-06)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-06
Owner: Gideon Park, Torghut Traders Architecture
Scope: Jangar control-plane reliability, rollout safety, dependency-quorum precision, negative evidence settlement,
Torghut quant proof consumption, and capital-action handoff.

Companion Torghut contract:

- `docs/torghut/design-system/v6/116-torghut-session-scoped-alpha-ledger-and-replay-capital-scheduler-2026-05-06.md`

Extends:

- `111-jangar-negative-evidence-router-and-action-slo-budgets-2026-05-06.md`
- `110-jangar-gitops-convergence-escrow-and-promotion-evidence-ledger-2026-05-06.md`
- `96-jangar-session-proof-train-and-capital-authority-separation-2026-05-06.md`

## Decision

I am selecting a **session-scoped proof settlement layer with stale-alert netting** as the next Jangar control-plane
step.

The current cluster is no longer a simple control-plane outage. Jangar is serving, `agents` and `agents-controllers`
are rolled out, runtime adapters are configured, execution trust is healthy, NATS collaboration tooling is present,
the Jangar database migration set is current, and watch reliability reports zero errors in a 15-minute window. That
should keep read-only serving, orchestration, and repair dispatch open.

The same status payload still blocks dependency quorum because Torghut empirical jobs are stale. Torghut live and sim
pods are running, core dependencies are healthy, and global quant metrics are fresh with `3780` latest metrics and
pipeline lag of about three seconds. But capital is not safe: Torghut `/readyz` is HTTP `503`, live submission is
disabled, all three tracked hypotheses require rollback, no hypothesis is promotion eligible, market context for
`AAPL` is degraded with stale technicals/fundamentals/news/regime, and quant alerts still include open critical scoped
lag alerts from May 5.

The failure mode is not missing facts. It is facts with different clocks being reduced into a global block or a global
allow. Jangar needs a session proof settlement layer between negative-evidence routing and capital handoff. That layer
must distinguish current session blockers from expected closed-market staleness, stale but unresolved alert debt, and
fresh global projections that do not prove scoped account/window readiness.

The tradeoff is a stricter proof model. Deployer dashboards will have one more settlement object to inspect before
widening or capital actions. I accept that because the current false choice is worse: either ignore stale proof because
pods are green, or freeze useful repair work because capital is held.

## Evidence Snapshot

All cluster and database assessment for this document was read-only. Direct CNPG database access remained forbidden to
the runner service account, so database evidence comes from service-owned health projections and source schema
inspection.

### Cluster And Rollout Evidence

- Branch: `codex/swarm-torghut-quant-discover`, based on `origin/main` at `934c5335d`.
- Runtime identity: `system:serviceaccount:agents:agents-sa`.
- `kubectl get pods -n jangar -o wide` showed Jangar, Bumba, Jangar DB, Redis, Open WebUI, Alloy, and Symphony pods
  running. `deployment/jangar` was `1/1` available on image digest `ddcf27ec...`.
- `kubectl get deploy -n agents -o wide` showed `agents=1/1` and `agents-controllers=2/2`; the current earlier
  readiness risk has recovered at rollout level.
- `kubectl get pods -n nats -o wide` showed `nats-0`, `nats-1`, and `nats-2` all `2/2 Running`.
- `kubectl get pods -n temporal -o wide` showed core Temporal services running, but `elasticsearch-master-1` was
  `Pending`; events reported anti-affinity could not schedule the third Elasticsearch replica on two nodes.
- `kubectl get pods -n torghut -o wide` showed Torghut live revision `00235`, Torghut sim revision `00319`,
  Postgres, ClickHouse replicas, Keeper, options services, TA services, websocket services, exporters, Alloy, and
  Symphony running.
- Recent Torghut events still showed failed `teardown-clean` and `activity` analysis runs, Knative startup/readiness
  probe misses during sim promotion, duplicate ClickHouse PodDisruptionBudget matches, and Keeper PDB `NoPods`.
- Rook/Ceph events showed OSD scheduling failures and CephCluster reconcile failures; this matters because Flink
  checkpoints and proof artifact storage depend on reliable storage behavior.

### Database And Data Evidence

- `kubectl cnpg psql -n torghut torghut-db` and `kubectl cnpg psql -n jangar jangar-db` failed because the service
  account cannot create `pods/exec` in those namespaces.
- Listing CNPG clusters in `torghut` and `jangar` was also forbidden by RBAC.
- Jangar `/api/agents/control-plane/status?namespace=agents` reported database `configured=true`, `connected=true`,
  `status=healthy`, `registered_count=28`, `applied_count=28`, `unapplied_count=0`, and latest applied migration
  `20260505_torghut_quant_pipeline_health_window_index`.
- The same Jangar status reported execution trust `healthy`, rollout health `healthy`, runtime kits `healthy`,
  watch reliability `healthy`, and dependency quorum `block` with reason `empirical_jobs_degraded`.
- Jangar failure-domain leases were valid in shadow for database, route, rollout, registry, storage, workflow artifact,
  NATS, and source schema. They allowed `torghut_capital` in shadow despite the dependency quorum block.
- Torghut `/db-check` returned HTTP `200`, schema current at `0029_whitepaper_embedding_dimension_4096`,
  `schema_graph_lineage_ready=true`, and `account_scope_ready=true`. It still warned about historical migration parent
  forks at `0010_execution_provenance_and_governance_trace` and `0015_whitepaper_workflow_tables`.
- Torghut `/readyz` returned HTTP `503`: live submission was disabled, capital stage was `shadow`, empirical jobs were
  degraded, promotion eligible count was `0`, and rollback required count was `3`.
- Jangar quant health returned fresh global metrics: `latestMetricsCount=3780`, `latestMetricsUpdatedAt` around
  `2026-05-06T11:11:51Z`, and `metricsPipelineLagSeconds=3`.
- Jangar quant alerts still returned open critical scoped `metrics_pipeline_lag_seconds` alerts from May 5 for
  strategy/window tuples.
- Jangar market-context health for `AAPL` was degraded: technicals and regime were about `139965` seconds stale,
  fundamentals about `4742943` seconds stale, and news about `4376129` seconds stale.

### Source Evidence

- `services/jangar/src/server/control-plane-status.ts` composes rollout, database, execution trust, runtime admission,
  workflows, empirical services, failure-domain leases, and Torghut dependency quorum into the status surface.
- `services/jangar/src/server/control-plane-workflows.ts` currently makes `empirical_jobs_degraded` a dependency-quorum
  block.
- `services/jangar/src/server/control-plane-failure-domain-leases.ts` can still allow `torghut_capital` in shadow
  because it evaluates infrastructure domains, not session-scoped proof settlement.
- `services/jangar/src/server/control-plane-execution-trust.ts`, `control-plane-runtime-admission.ts`, and
  `control-plane-rollout-health.ts` are the right input producers; none should become the final capital router.
- `services/torghut/app/main.py` and `services/torghut/app/trading/submission_council.py` already expose quant
  evidence, live-submission gates, dependency quorum, and hypothesis readiness for the consumer side.
- `services/torghut/app/trading/hypotheses.py` marks dependency quorum, signal continuity, market context freshness,
  and rollback requirements as promotion inputs.

## Problem

Jangar needs to reduce false global blocks without weakening capital safety.

The current state has three different kinds of negative evidence:

1. Current action blockers: stale empirical jobs, rollback-required hypotheses, stale market context, and scoped quant
   alerts.
2. Expected session conditions: signal lag while the market is closed, with Torghut explicitly reporting
   `expected_market_closed_staleness`.
3. Infrastructure risk: Temporal search degradation and Rook/Ceph OSD scheduling issues that do not stop serving, but
   should reduce confidence in proof replay and rollout widening.

These clocks should not settle the same way. Closed-market signal staleness should open replay work. Stale empirical
jobs should block paper/live capital. Fresh global quant metrics should allow observation, but not prove a scoped
strategy/window. Storage and search-plane issues should tighten rollout and proof-artifact budgets without stopping
read-only operators.

## Alternatives Considered

### Option A: Keep Dependency Quorum As A Global Block

Pros:

- Conservative for capital.
- Simple to show in Jangar UI and Torghut readiness.
- Reuses existing `dependency_quorum` plumbing.

Cons:

- Blocks too much during closed-market windows when repair work is the right response.
- Does not distinguish stale alert debt from fresh session evidence.
- Allows failure-domain leases and dependency quorum to disagree about `torghut_capital` without a settlement record.
- Makes deployer decisions depend on a broad reason string instead of scoped proof.

Decision: reject as the target. Keep dependency quorum as an input.

### Option B: Trust Fresh Global Quant Health Over Stale Scoped Alerts

Pros:

- Makes the fresh metrics pipeline visible and useful.
- Reduces noisy old alerts.
- Fast path to paper canaries once global pipeline is healthy.

Cons:

- Global freshness does not prove the active account, strategy, and window.
- Old unresolved critical alerts still represent audit debt until they are netted, expired, or replayed.
- Does not address empirical jobs or market-context staleness.

Decision: reject as unsafe for capital. Use global freshness only to keep observation and repair open.

### Option C: Session-Scoped Proof Settlement With Stale-Alert Netting

Pros:

- Settles proof by market session, account, strategy, window, and action class.
- Nets stale alerts only when superseded by fresher scoped proof or explicitly expires them as debt.
- Keeps repair/replay lanes open while paper and live capital remain blocked.
- Gives deployers a concrete object to inspect before rollout widening or capital reentry.
- Aligns Jangar action budgets with Torghut market-session semantics.

Cons:

- Adds one more reducer and schema/projection contract.
- Requires careful expiry policy so old alerts do not disappear silently.
- Requires Torghut to produce scoped replay receipts for each candidate capital path.

Decision: select Option C.

## Architecture

Jangar introduces `session_proof_settlement` as a durable projection, fed by existing control-plane status, quant
health, quant alerts, market-context health, empirical-service status, rollout health, and Torghut session state.

```text
session_proof_settlement
  settlement_id
  settlement_epoch
  account
  strategy_id
  hypothesis_id
  window
  market_session_id
  action_class
  decision                 # allow, repair_only, delay, block
  reasons
  positive_evidence_refs
  negative_evidence_refs
  netted_alert_refs
  unresolved_alert_refs
  replay_receipt_refs
  rollout_confidence       # high, medium, low
  capital_confidence       # none, shadow, paper, live_micro, live_scale
  observed_at
  expires_at
```

Settlement rules:

- `serve_readonly` stays allowed when Jangar route, database, and runtime-kit evidence are healthy.
- `dispatch_repair` stays allowed when the missing proof is repairable and no current infrastructure hard block exists.
- `deploy_widen` is delayed when storage/search/rollout evidence is degraded or proof artifacts are not replayable.
- `torghut_observe` is allowed on fresh global quant proof even when scoped capital proof is missing.
- `paper_capital` requires scoped quant freshness, market-context freshness for the active universe, no unresolved
  critical alert for the same account/strategy/window, and a current empirical replay receipt.
- `live_capital` requires paper settlement, broker reconciliation, TCA freshness, rollback rehearsal, and no open
  rollback-required hypothesis in the selected path.

Stale-alert netting is explicit:

- An alert is `superseded` only when a newer scoped metric for the same account/strategy/window clears the threshold.
- An alert is `session_expired` when it belongs to a closed session and no longer applies to the current action, but it
  remains audit debt until a replay receipt exists.
- An alert is `unresolved` when it still applies to the proposed action class.
- Global metrics can reduce repair urgency, but cannot net scoped capital alerts.

## Validation Gates

Engineer acceptance:

- Unit tests cover `dependency_quorum=block` from empirical jobs while `dispatch_repair` remains allowed.
- Unit tests cover fresh global quant health plus open scoped alerts producing `torghut_observe=allow` and
  `paper_capital=block`.
- Unit tests cover market-closed signal staleness producing replay work rather than a normal-dispatch freeze.
- Integration tests prove the status API exposes settlement IDs, action decisions, unresolved alert refs, expiry, and
  replay receipt refs.

Deployer acceptance:

- Before widening Jangar or Torghut rollout, the deployer can show current `deploy_widen` settlement is `allow` or an
  explicit `delay` with bounded reasons.
- Before any paper/live Torghut action, the deployer can show the matching account/strategy/window settlement and its
  replay receipt.
- Rollback can be triggered by setting the settlement layer to shadow-only consumption while keeping existing
  dependency-quorum behavior.

## Rollout Plan

1. Ship the settlement reducer in shadow mode and log decisions next to existing dependency quorum and failure-domain
   leases.
2. Add the Jangar API projection and UI readout for settlement decisions by action class.
3. Teach Torghut to read settlement IDs and include them in readiness, hypothesis readiness, and submission council
   payloads.
4. Enforce settlement only for paper capital after seven consecutive healthy settlement epochs.
5. Enforce settlement for live micro-canary only after a paper canary closes with clean broker reconciliation and TCA.

## Rollback Plan

- Disable settlement enforcement with a feature flag and continue using current dependency quorum and failure-domain
  leases.
- Keep settlement records readable for audit even when not enforced.
- If stale-alert netting misclassifies proof debt, mark all netted alerts for the affected account/strategy/window as
  `unresolved` and force `paper_capital` and `live_capital` to `block`.

## Risks

- A too-aggressive expiry policy could hide valid negative evidence. Mitigation: expiry never grants capital without a
  newer replay or metric receipt.
- A too-conservative policy could keep capital blocked indefinitely. Mitigation: every block must name the repair lane
  and validation command.
- Storage/search degradation can make proof replay flaky. Mitigation: `deploy_widen` and replay-dependent capital
  actions consume rollout confidence separately from read-only serving.

## Handoff

Engineer stage should implement the shadow reducer, tests, and status projection. The smallest useful slice is Jangar
status plus Torghut consumer parsing; no broker behavior changes are needed in the first slice.

Deployer stage should validate three live reads before enforcement: Jangar settlement projection, Torghut `/readyz`
capital block with settlement refs, and one replay receipt that nets or carries forward stale alert debt. No live
capital should move until the session settlement for the exact account/strategy/window says paper or live is allowed.
