# 124. Jangar Disruption Budget Arbiter And Data Freshness Settlement (2026-05-06)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-06
Owner: Victor Chen, Jangar Engineering Architecture
Scope: Jangar rollout safety, disruption evidence, data-plane freshness, action receipts, Torghut capital admission,
and read-only validation.

Companion Torghut contract:

- `docs/torghut/design-system/v6/128-torghut-data-plane-disruption-premium-and-freshness-settlement-2026-05-06.md`

Extends:

- `123-jangar-observation-rights-quorum-and-proof-carrying-rollout-admission-2026-05-06.md`
- `123-jangar-market-context-contradiction-ledger-and-lane-capital-holds-2026-05-06.md`
- `116-jangar-controller-witness-quorum-and-capital-activation-receipts-2026-05-06.md`
- `111-jangar-negative-evidence-router-and-action-slo-budgets-2026-05-06.md`

## Decision

I am selecting a **disruption budget arbiter with data freshness settlement** as the next Jangar control-plane
contract.

The control plane is not in a broad outage. On the read-only sample from `2026-05-06T16:23Z`, Jangar reported healthy
database connectivity, healthy migration consistency at `28/28`, healthy rollout for `agents=1/1` and
`agents-controllers=2/2`, healthy execution trust, healthy watch reliability with `2341` events and `0` errors in a
15-minute window, and fresh runtime admission passports. Agents had `193` AgentRuns in the summary: `164` succeeded,
`13` failed, `4` running, and `12` templates.

The same sample shows why green controller status is not enough for rollout widening or capital-adjacent admission.
Torghut events repeatedly reported that ClickHouse pods matched multiple PodDisruptionBudgets and Kubernetes chose one
arbitrarily. The active Torghut live route returned HTTP `503` because `simple_submit_disabled` blocks live submission.
Jangar typed quant health for live account `PA3SX7FYNUTF` had `108` latest metrics, but the newest metric was from
`2026-05-05T17:28:03.839Z`, lagging the sample by `82551` seconds. Sim quant health for `TORGHUT_SIM` was degraded with
`latestMetricsCount=0`. Torghut sim was serving, but its teardown-clean analysis run failed. Empirical jobs remained
stale across `benchmark_parity`, `foundation_router_parity`, `janus_event_car`, and `janus_hgrm_reward`.

The selected design makes disruption ambiguity and data freshness debt first-class settlement inputs. Jangar should not
treat running pods as proof that stateful data-plane disruption is safe. It should not treat a reachable quant route as
proof that capital evidence is fresh. For deploy widening, merge-ready, paper canary, and live capital, Jangar must
settle three facts together: the data-plane disruption budget is unambiguous, the relevant data projections are fresh,
and any stale proof has a bounded repair path.

The tradeoff is that some rollouts that look healthy at the Deployment level will be held until disruption ownership
and freshness debts are explicit. I accept that. The six-month failure mode to remove is a "green" rollout or capital
decision that silently rides on arbitrary PDB selection, stale quant metrics, or empty sim evidence.

## Runtime Objective And Success Metrics

This contract increases Jangar resilience by separating rollout availability from disruption safety. It increases
Torghut profitability by refusing to allocate proof or capital against stale or ambiguous data-plane evidence.

Success means:

- Jangar emits one `disruption_budget_settlement` for every stateful data-plane surface that affects a material action.
- Duplicate or unreadable PDB evidence becomes `ambiguous` or `unobserved`, not an ignored event.
- Jangar emits one `data_freshness_settlement` per account/window used by merge-ready, paper, or live capital receipts.
- `serve_readonly`, `dispatch_repair`, and `torghut_observe` remain allowed when only data freshness is stale.
- `deploy_widen`, `merge_ready`, `paper_canary`, `live_micro_canary`, and `live_scale` require unambiguous disruption
  evidence plus fresh data or an explicit repair waiver.
- Material action activation receipts cite disruption settlement ids, freshness settlement ids, max age, stale stores,
  and rollback targets.
- Engineer and deployer lanes can validate the contract from Kubernetes events, Jangar/Torghut route payloads, and
  source fixtures without Secret reads or pod exec.

## Evidence Snapshot

All evidence was collected read-only. No Kubernetes resources, database rows, GitOps state, trading flags, broker
records, or application data were changed.

### Cluster And Rollout Evidence

- The workspace is on `codex/swarm-jangar-control-plane-plan`, fast-forwarded to `origin/main` before this artifact.
- `kubectl config current-context` was initially unset; I bootstrapped an in-cluster context using the mounted service
  account token and verified identity as `system:serviceaccount:agents:agents-sa`.
- Jangar namespace pods were running, including `jangar-b6b87bffd-5xtt9` at `2/2 Running`, `jangar-db-1`,
  `open-webui-0`, Redis, Bumba, Alloy, Symphony, and `symphony-jangar`.
- Agents deployments were available: `agents=1/1`, `agents-controllers=2/2`, and `agents-alloy=1/1`.
- Agents events still showed readiness failures on the prior agents/controller ReplicaSets during rollout, followed by
  the new `01483797` deployment becoming available.
- Torghut serving pods were running, including live `torghut-00239`, sim `torghut-sim-00335`, ClickHouse replicas,
  Keeper, Torghut Postgres, live TA, sim TA, options TA, options catalog/enricher, websockets, guardrail exporters,
  Alloy, and Symphony.
- Torghut warning events included repeated `MultiplePodDisruptionBudgets` for
  `chi-torghut-clickhouse-default-0-0-0` and `chi-torghut-clickhouse-default-0-1-0`; Kubernetes alternated between
  `chi-torghut-clickhouse-default` and `torghut-clickhouse`.
- Torghut warning events also included transient readiness misses on live/sim revisions, options pods, and
  `torghut-ws-options`, plus a failed `teardown-clean` AnalysisRun for the active sim rollout.
- RBAC blocked direct PDB, CNPG cluster, Knative service, and pod exec reads in Torghut and Jangar. Those denials are
  part of the observation evidence.

### Source Evidence

- `argocd/applications/torghut/clickhouse/clickhouse-pdb.yaml` defines a GitOps PDB named `torghut-clickhouse` with
  selector `clickhouse.altinity.com/chi=torghut-clickhouse` and `clickhouse.altinity.com/cluster=default`.
- The live event stream proves another PDB also selects the same ClickHouse pods. Source review suggests the second PDB
  is operator-owned or rendered outside the visible GitOps PDB file.
- `services/jangar/src/server/control-plane-status.ts` is `753` lines and composes database status, rollout health,
  workflow reliability, watch reliability, execution trust, runtime admission, failure-domain leases, negative
  evidence, empirical services, action clocks, and material receipts.
- `services/jangar/src/server/control-plane-negative-evidence-router.ts` is `610` lines and is the right reducer for
  disruption ambiguity and stale data freshness.
- `services/jangar/src/server/control-plane-controller-witness.ts` is `423` lines and already creates material-action
  receipts where settlement refs should be attached.
- `services/jangar/src/server/supporting-primitives-controller.ts` remains a high-risk shared controller at `2883`
  lines, but recent source has fixed the older schedule-runner namespace precedence issue and added PVC support through
  `services/jangar/src/server/primitives-kube.ts`.
- `services/jangar/src/server/primitives-kube.ts` now supports `persistentvolumeclaim`, `persistentvolumeclaims`,
  `pvc`, and `pvcs`, which closes an earlier workspace-PVC blind spot.
- `services/torghut/app/main.py` is `4051` lines and builds readiness, DB schema checks, empirical proof, quant
  evidence, live submission gates, and trading status.
- `services/torghut/app/trading/submission_council.py` is `1196` lines and already consumes empirical proof, quant
  evidence, dependency quorum, capital stage, and toggles, but it does not yet price disruption ambiguity.

### Database And Data Evidence

- Direct `kubectl cnpg psql` failed because this service account cannot create `pods/exec` in the `jangar` namespace.
  Direct database validation must remain application-projected or use a narrow read-only verifier.
- Jangar control-plane status reported `database.configured=true`, `database.connected=true`, `status=healthy`,
  `latency_ms=2`, and migration consistency `registered=28`, `applied=28`, `unapplied=0`, `unexpected=0`.
- The latest Jangar migration was `20260505_torghut_quant_pipeline_health_window_index`.
- Torghut live `/readyz` returned HTTP `503` with Postgres, ClickHouse, Alpaca, database, and universe OK, but live
  submission blocked by `simple_submit_disabled`.
- Torghut live database schema was current at Alembic head `0029_whitepaper_embedding_dimension_4096`; lineage was
  ready, with parent-fork warnings for `0010` and `0015`.
- Torghut live quant health through Jangar was `degraded`: `latestMetricsCount=108`, latest metric
  `2026-05-05T17:28:03.839Z`, `metricsPipelineLagSeconds=82551`, and missing update alarm true.
- Torghut sim `/readyz` returned OK for non-live mode, but quant evidence for `TORGHUT_SIM` was degraded with
  `latestMetricsCount=0`, `emptyLatestStoreAlarm=true`, and no stages.
- Jangar material action receipts held `merge_ready`, held `paper_canary`, and blocked live capital because empirical
  jobs were degraded and stale.

## Problem

Jangar now has enough proof surfaces that "pod running" is too weak as a material-action input.

Four failure modes are active:

1. **Ambiguous disruption ownership.** A stateful data pod matching multiple PDBs means voluntary disruption behavior
   is not deterministic from Jangar's perspective.
2. **Freshness debt can hide under reachable routes.** The live quant route is reachable and non-empty but stale by
   nearly a day; the sim route is reachable but empty.
3. **Read-only RBAC gaps are not typed.** If the agent service account cannot list PDBs or CNPG resources, the status
   surface needs to show that as unobserved authority, not rely on manual command failures.
4. **Capital and rollout gates mix domains.** Empirical stale debt, data freshness debt, and disruption ambiguity all
   become generic holds unless the receipt names which debt blocks which action.

The result is operational ambiguity. A deployer can see available Deployments, while the event stream says the
stateful data-plane safety contract is ambiguous and the data projections needed for capital are stale.

## Alternatives Considered

### Option A: Fix The ClickHouse PDB Overlap Immediately

This option edits GitOps manifests to remove overlap and treats the live event as a local infra defect.

Pros:

- Directly reduces one visible warning.
- Likely small manifest diff once the operator-owned PDB source is confirmed.
- Easy deployer story for ClickHouse.

Cons:

- Does not solve stale quant metrics or empty sim metrics.
- Does not teach Jangar how to detect future overlapping PDBs.
- Requires PDB list access that this runtime currently lacks.
- Leaves material-action receipts without disruption evidence.

Decision: reject as the architecture. Keep the manifest cleanup as a deployer task after this contract.

### Option B: Gate Only On Route-Level Readiness And Quant Health

This option ignores PDB ambiguity and uses `/readyz`, Jangar quant health, and empirical jobs as sufficient proof.

Pros:

- Uses existing typed routes.
- Avoids new Kubernetes evidence logic.
- Keeps the implementation local to Jangar/Torghut status reducers.

Cons:

- A stateful rollout can still proceed under arbitrary PDB selection.
- Route freshness does not prove disruption safety.
- It underprices data-plane events that can create data gaps later.

Decision: reject. Readiness and quant health are necessary, not sufficient.

### Option C: Disruption Budget Arbiter With Data Freshness Settlement

Jangar records disruption settlements and data freshness settlements, then requires both for material actions.

Pros:

- Converts Kubernetes warning events and RBAC denial into typed action evidence.
- Separates observe/repair from deploy widening and capital.
- Gives Torghut one Jangar verdict that names both operational and data freshness debt.
- Lets deployers fix PDB overlap without granting broad pod exec or Secret access.
- Reduces false confidence from running pods and reachable but stale routes.

Cons:

- Adds two settlement projections and reducers.
- Requires a shadow period to tune false holds.
- Requires a least-privilege PDB read or a reliable event-derived fallback.

Decision: select Option C.

## Architecture

### DisruptionBudgetSettlement

Jangar creates a settlement for every stateful data-plane workload referenced by a material action.

```text
disruption_budget_settlement
  settlement_id
  generated_at
  expires_at
  namespace
  workload_ref
  data_plane_ref
  observed_pdb_refs
  event_refs
  observation_rights
  decision                  # allow, allow_repair, ambiguous, unobserved, block
  reason_codes
  affected_action_classes
  rollback_target
```

Rules:

1. Exactly one matching PDB with sufficient budget gives `allow`.
2. Multiple matching PDBs give `ambiguous` for `deploy_widen`, `merge_ready`, and all capital actions.
3. Missing PDB read rights give `unobserved` unless recent warning events already prove ambiguity.
4. `dispatch_repair` and `torghut_observe` can continue with `allow_repair` and max notional `0`.
5. Settlement expires quickly, default 10 minutes, because PDB and event state are rollout-sensitive.

### DataFreshnessSettlement

Jangar creates a settlement for each account/window/data store used by a material action.

```text
data_freshness_settlement
  settlement_id
  generated_at
  expires_at
  account
  window
  store_ref
  latest_metrics_count
  latest_metrics_updated_at
  metrics_pipeline_lag_seconds
  empty_store_alarm
  missing_update_alarm
  stage_refs
  decision                  # fresh, stale, empty, unobserved, repair_only
  reason_codes
  max_allowed_lag_seconds
  rollback_target
```

Rules:

1. `fresh` requires a non-empty scoped store and lag below the action-specific max.
2. `empty` holds paper and blocks live capital.
3. `stale` holds merge-ready and paper unless a time-bounded repair waiver exists.
4. `dispatch_repair` may run on stale or empty data only when the repair writes closure evidence.
5. A sim store cannot authorize live capital; it can only prove replay or paper-supporting evidence.

### Receipt Integration

`material_action_activation_receipt` adds:

- `disruption_settlement_refs`;
- `data_freshness_settlement_refs`;
- `stale_store_refs`;
- `ambiguous_disruption_refs`;
- `required_repairs`;
- `freshness_max_age_seconds`;
- `rollback_target`.

`merge_ready` is held when either settlement is ambiguous, stale, empty, or unobserved. `torghut_observe` remains
allowed unless both the route and data projection are unavailable. `live_micro_canary` and `live_scale` block on any
ambiguous disruption settlement or stale required data settlement.

## Implementation Scope

Engineer scope:

- Add a Jangar disruption settlement reducer under `services/jangar/src/server/control-plane-*`.
- Read PDB evidence through a least-privilege path when available; otherwise derive `ambiguous` from warning events.
- Add data freshness settlement from Jangar quant health and Torghut readiness payloads.
- Attach settlement refs to action clocks, negative evidence, and material action receipts.
- Add fixtures for duplicate PDB events, PDB read forbidden, live quant stale, sim quant empty, and repair-only
  allowance.

Deployer scope:

- Audit ClickHouse PDB ownership and remove overlap through GitOps, or document the operator-owned PDB source.
- Grant only read/list on PDB metadata if the event-derived fallback is insufficient.
- Do not grant Secret reads or pods/exec for routine settlement.
- Validate after rollout that the `MultiplePodDisruptionBudgets` warning disappears before widening stateful lanes.

Torghut companion scope:

- Publish disruption premium and freshness discount data in capital proof receipts.
- Keep live submission disabled until freshness and disruption settlements are fresh.
- Treat sim empty metrics as a repair item, not proof of paper readiness.

## Validation Gates

Local engineer gates:

- Unit tests for `multiple_pdbs -> deploy_widen hold`, `pdb_forbidden -> unobserved`, and
  `warning_event_multiple_pdbs -> ambiguous`.
- Unit tests for `live latest metrics stale -> merge_ready hold`, `sim latest metrics empty -> paper hold`, and
  `observe remains allowed`.
- Existing `services/jangar` targeted tests for control-plane status, action clocks, negative evidence, controller
  witnesses, and Torghut quant health.

Read-only deployer gates:

- `kubectl get events -n torghut --field-selector type=Warning --sort-by=.lastTimestamp` shows no current duplicate-PDB
  warning for ClickHouse before rollout widening.
- Jangar `/api/agents/control-plane/status` material receipts cite disruption and freshness settlement refs.
- Jangar quant health for the target account/window is non-empty and within the configured max lag.
- Torghut `/readyz` is not used alone as capital authority.

Capital gates:

- Paper canary requires fresh data settlement and no ambiguous disruption settlement.
- Live micro-canary requires live `/readyz=200`, fresh live account data, no critical freshness alarm, no ambiguous
  stateful disruption, and empirical jobs current.
- Live scale additionally requires post-canary fillability and PnL settlement from the companion Torghut contract.

## Rollout And Rollback

Rollout:

1. Ship reducers in shadow mode and emit settlements without changing decisions.
2. Compare shadow decisions with current material receipts for at least two cron cycles.
3. Enforce `deploy_widen` and `merge_ready` holds on ambiguous disruption first.
4. Enforce paper/live capital holds on stale or empty data after Torghut emits companion proof.
5. Retire any temporary waiver once ClickHouse PDB overlap is removed.

Rollback:

- Disable enforcement with a single config flag and keep settlement emission active.
- Fall back to existing controller witness, failure-domain leases, empirical jobs, and quant health gates.
- Keep `serve_readonly`, `dispatch_repair`, and `torghut_observe` available unless route health or database probes fail.
- Do not roll back by broadening RBAC to Secrets or pod exec.

## Risks

- Event-derived PDB ambiguity can lag the actual PDB state. Mitigation: prefer least-privilege PDB metadata reads when
  available and keep event fallback conservative.
- Freshness settlement can over-hold during market open bursts. Mitigation: tune max age per account/window and allow
  repair-only jobs.
- Duplicate PDB warnings can be noisy during operator reconciliation. Mitigation: require persistence across a short
  settlement window before blocking live, but hold deploy widening immediately.
- More receipt fields can make status payloads heavy. Mitigation: use compact refs and expose detail through resource
  endpoints.

## Engineer And Deployer Handoff

Engineer acceptance:

- `material_action_activation_receipt` includes both settlement ref families.
- Duplicate-PDB and stale/empty metrics fixtures fail closed for material actions and stay open for observe/repair.
- The reducer never requires Secret reads or pod exec.
- The status route names the smallest required repair, not a generic "control plane degraded."

Deployer acceptance:

- Before widening Torghut or ClickHouse stateful rollouts, confirm no active duplicate-PDB warnings and verify the
  Jangar disruption settlement is `allow`.
- Before paper/live capital, confirm data freshness settlement is `fresh` for the target account/window and empirical
  jobs are current.
- Rollback by disabling settlement enforcement, not by ignoring settlements or broadening credentials.
