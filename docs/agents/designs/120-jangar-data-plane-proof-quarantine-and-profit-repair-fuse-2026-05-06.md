# 120. Jangar Data-Plane Proof Quarantine And Profit-Repair Fuse (2026-05-06)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-06
Owner: Gideon Park, Torghut Traders
Scope: Jangar repair admission, downstream image evidence, Torghut profit-renewal bids, rollout safety, capital
readmission, and deployer acceptance gates.

Companion Torghut contract:

- `docs/torghut/design-system/v6/124-torghut-data-plane-proof-quarantine-and-profit-renewal-fuse-2026-05-06.md`

Extends:

- `118-jangar-repair-admission-governor-and-profit-renewal-bids-2026-05-06.md`
- `119-jangar-empirical-proof-renewal-clearinghouse-and-capital-reentry-settlement-2026-05-06.md`
- `117-jangar-evidence-debt-tranches-and-capital-unblock-ledger-2026-05-06.md`
- `114-jangar-evidence-transport-ledger-and-watch-restart-circuit-breakers-2026-05-06.md`
- `111-jangar-negative-evidence-router-and-action-slo-budgets-2026-05-06.md`

## Decision

I am selecting a **data-plane proof quarantine with a profit-repair fuse** as the next Jangar control-plane
architecture step.

The current system has recovered from the earlier broad control-plane degradation, but it has exposed a sharper
failure mode. Agents and Jangar are synced, healthy, and available. Jangar can serve status, the database projection is
healthy, watch reliability is healthy, and execution trust is healthy. Torghut live and sim routes answer. At the same
time, Torghut is still `Progressing`, `torghut-ta-sim` is in `ImagePullBackOff` because the promoted
`torghut-ta` digest has no platform manifest for the node, empirical jobs are stale, sim quant latest metrics are
empty, live quant proof is stale or not wired into live health, market context is stale, options catalog says ready
with no success timestamp, and capital remains shadow.

The right control-plane move is not another general repair auction. Jangar should quarantine any profit-repair bid
whose evidence path depends on a data-plane lane without current image, rollout, and freshness proof. The quarantine
does not freeze serving or zero-notional observation. It prevents repair capacity, paper canary, merge readiness, or
live capital from being granted by stale empirical proof while the underlying simulator or data producer cannot pull
its own image.

The tradeoff is stricter admission before repair dispatch. I accept that. A profitable quant system does not just need
more repair jobs. It needs repair jobs that run on evidence-producing lanes we can prove are actually converged.

## Evidence Snapshot

All checks for this decision were read-only. I did not mutate Kubernetes resources, database rows, trading flags,
broker topics, Argo applications, or GitHub records.

### Cluster And Rollout Evidence

- Argo CD reported `agents` and `jangar` as `Synced` and `Healthy` at revision
  `000d3b9750eaa04d4eb8238915fdff1a6450caec`.
- Argo CD reported `torghut` as `Synced` and `Progressing` at the same revision.
- `deployment/agents` was `1/1` available and `deployment/agents-controllers` was `2/2` available on the
  `94a6b857` Jangar image family.
- `deployment/jangar` was `1/1` available, and the active Jangar pod was `2/2 Running`.
- Recent agents events still included readiness probe timeouts for `agents` and both controller pods, even though the
  current deployments were available.
- Jangar namespace events were quiet except for the known Elasticsearch PDB `NoPods` condition and one startup
  readiness miss during the Jangar rollout.
- Torghut live revision `torghut-00238` and sim revision `torghut-sim-00329` were running on Torghut image digest
  `af92e76b6844ec5614a0d00b3651713d8102f2ff25eaa6ceadf0be63c089483e`.
- `torghut-ta-sim` was `0/1` available and its pod was `ImagePullBackOff`.
- The failed sim TA image was
  `registry.ide-newton.ts.net/lab/torghut-ta@sha256:20fe1818a7c5239d58d4e3888804163025b9b3b2ee1a1674fd7db77007f682af`.
- Kubelet reported `no match for platform in manifest` for that digest. This is a registry/platform evidence failure,
  not a trading hypothesis result.
- Recent Torghut events also showed sim rollout churn, a successful sim runtime-ready analysis, one failed sim activity
  analysis, duplicate ClickHouse PodDisruptionBudget matches, and the stale Keeper PDB `NoPods` warning.

### Database And Data Evidence

- Direct CNPG `psql` for `torghut-db` failed because the agents service account cannot create `pods/exec` in the
  `torghut` namespace. That RBAC boundary is correct; routine validation must use service-owned projections unless a
  deployer runs a higher-privilege read-only check.
- Jangar `/health` returned HTTP `200`, but the serving process reported the agents controller as not started. The
  controller deployment is available, so controller-process witness and serving-process status remain distinct.
- Jangar control-plane status reported database `connected=true`, migration consistency `28/28`, latest applied
  migration `20260505_torghut_quant_pipeline_health_window_index`, watch reliability `healthy`, `4979` AgentRun watch
  events, `0` watch errors, and `2` restarts in the 15-minute window.
- Jangar dependency quorum returned `block` with reason `empirical_jobs_degraded`.
- Jangar action SLO budgets allowed `serve_readonly`, `dispatch_repair`, `deploy_widen`, and `torghut_observe`;
  downgraded `dispatch_normal` to `repair_only` for `controller_witness_split`; held `merge_ready` and `paper_canary`;
  and blocked `live_micro_canary` and `live_scale`.
- Torghut `/db-check` returned HTTP `200`, `ok=true`, `schema_current=true`, `schema_graph_lineage_ready=true`, and
  `account_scope_ready=true`.
- Torghut live `/readyz` returned HTTP `503` in about `4.9s` with `simple_submit_disabled`, `capital_stage=shadow`,
  and live quant evidence `not_required` because `quant_health_not_configured`.
- Torghut live `/trading/health` returned HTTP `503`, `hypotheses_total=3`, `promotion_eligible_total=0`, and
  `rollback_required_total=3`.
- Torghut `/trading/autonomy` returned HTTP `200` with stale empirical jobs `benchmark_parity`,
  `foundation_router_parity`, `janus_event_car`, and `janus_hgrm_reward`, all tied to
  `intraday_tsmom_v1@prod` and dataset `torghut-full-day-20260318-884bec35`.
- Torghut sim `/readyz` and `/trading/health` returned HTTP `200`, but sim quant evidence was degraded:
  `latest_metrics_count=0`, `empty_latest_store_alarm=true`, and `stage_count=0`.
- Jangar live-account quant health returned `latestMetricsCount=108`, `latestMetricsUpdatedAt=2026-05-05T17:28:03.839Z`,
  and `metricsPipelineLagSeconds=74590`.
- Jangar market-context health for `AAPL` was degraded with `bundleFreshnessSeconds=150798`,
  `bundleQualityScore=0.4575`, and stale technicals, fundamentals, news, and regime domains.
- Jangar quant alerts returned `50` open alerts, including `37` critical alerts.
- Torghut options catalog `/readyz` returned HTTP `200` and `ready=true` with `last_success_ts=null`.
- Torghut options enricher `/readyz` returned HTTP `200` with a current `last_success_ts`.

### Source Evidence

- `services/jangar/src/server/control-plane-status.ts` composes database status, controller health, rollout health,
  watch reliability, empirical services, runtime admission, failure-domain leases, negative evidence, controller
  witness quorum, action clocks, and execution trust.
- `services/jangar/src/server/control-plane-failure-domain-leases.ts` already detects image-pull failures for Jangar's
  own failure-domain leases, including `ErrImagePull`, `ImagePullBackOff`, and `InvalidImageName`.
- `services/jangar/src/server/control-plane-negative-evidence-router.ts` already maps empirical job, market-context,
  quant-alert, readiness, and paper-settlement debt into action budgets.
- The missing shape is downstream data-plane quarantine: Jangar can hold actions on stale empirical proof, but it does
  not yet bind a Torghut profit-repair bid to a concrete image/platform/runtime witness for the data lane that will
  produce the repair evidence.
- `services/torghut/app/main.py` is still the broadest Torghut route assembly surface at `4051` lines.
- `services/torghut/app/trading/scheduler/pipeline.py` is `4349` lines and owns market-context observations, signal
  continuity, rejection accounting, and order preparation.
- Focused tests exist for Jangar status, failure-domain leases, negative evidence, watch reliability, controller
  witness, Torghut empirical jobs, market context, quant health, submission council, and quant readiness. The missing
  system-level test is profit-repair admission under a downstream image/platform quarantine.

## Problem

Jangar can block unsafe material action, but it does not yet know when a Torghut repair depends on a data-plane lane
that cannot currently prove its own runtime.

That gap matters because a repair is not free. A zero-notional empirical replay, sim quant bootstrap, or market-context
refresh consumes controller attention, queue capacity, database queries, registry bandwidth, object storage, and
operator trust. If the sim technical-analysis lane is in `ImagePullBackOff`, a repair that depends on fresh sim TA is
not merely stale. It is non-evidential. It cannot produce a capital-grade closure receipt until the image/platform
witness is repaired.

The current architecture separates many action classes, but it still lets the phrase `dispatch_repair` hide the
critical question: "repair what, on which runtime, with which converged image, and for which capital gate?"

## Alternatives Considered

### Option A: Keep Profit-Renewal Bids As The Only Repair Ranking

Pros:

- Builds on the accepted Jangar repair admission governor.
- Lets Torghut express expected information gain and capital-unblock value.
- Keeps live notional at zero while stale proof is repaired.

Cons:

- A high-value bid can still depend on an unpullable downstream image.
- The bid score can overstate profit value when the evidence-producing lane is not converged.
- Deployer acceptance has to infer image/platform readiness manually from Kubernetes events.

Decision: reject as sufficient. Profit-renewal bids remain inputs, but they need a data-plane fuse.

### Option B: Freeze All Torghut Repair While Torghut Is Progressing

Pros:

- Very conservative.
- Easy to reason about during an image-pull or rollout failure.
- Prevents false paper-capital confidence.

Cons:

- Blocks independent zero-notional repairs such as market-context evidence capture or controller witness publication.
- Treats a sim TA image manifest failure the same as all Torghut route reads.
- Delays repairs that could reduce evidence debt without relying on the quarantined lane.

Decision: reject as the default. Keep it as emergency posture for unknown ownership, database pressure, or data loss.

### Option C: Data-Plane Proof Quarantine With Profit-Repair Fuse

Pros:

- Separates "Jangar may serve" from "this Torghut data lane can produce capital-grade repair evidence."
- Keeps independent observe and repair lanes open while quarantining bids that depend on broken image/runtime proof.
- Gives deployers a concrete closure receipt: image digest pullable on the target platform, runtime ready, route proof
  fresh, and data freshness inside threshold.
- Prevents stale empirical jobs from being repaired against a partially converged simulator.
- Improves profitability by spending scarce repair capacity only where evidence can actually change a capital gate.

Cons:

- Adds another reducer and receipt type.
- Requires Jangar to ingest a compact Torghut data-plane witness instead of reading every downstream object directly.
- Early fuse scoring will be conservative until closure history exists.

Decision: select Option C.

## Architecture

Jangar adds a `control_plane_data_plane_quarantine_epoch`.

```text
control_plane_data_plane_quarantine_epoch
  epoch_id
  generated_at
  expires_at
  namespace
  source_revision
  affected_system
  affected_lanes
  data_plane_witness_refs
  registry_witness_refs
  rollout_witness_refs
  route_witness_refs
  freshness_witness_refs
  dependency_quorum_ref
  action_slo_budget_refs
  quarantine_decision           # none, lane_quarantine, system_quarantine, emergency_freeze
  reason_codes
  allowed_repair_classes
  denied_repair_classes
  max_concurrent_repairs
  max_notional
  rollback_target
```

Torghut publishes compact `data_plane_runtime_witness` records for Jangar to consume.

```text
data_plane_runtime_witness
  witness_id
  generated_at
  expires_at
  lane                         # live_service, sim_service, live_ta, sim_ta, options_ta,
                               # options_catalog, options_enricher, empirical_replay
  desired_image_ref
  observed_image_ref
  image_pull_status            # pullable, pending, failed, unknown
  platform_status              # matched, no_platform_manifest, unknown
  rollout_status               # ready, progressing, failed, unknown
  runtime_status               # running, degraded, blocked, unknown
  route_status                 # ok, degraded, timeout, unavailable
  freshness_status             # fresh, stale, empty, not_applicable
  evidence_refs
  closure_requirements
```

Jangar then emits one `profit_repair_fuse_decision` for every selected Torghut profit-renewal bid.

```text
profit_repair_fuse_decision
  fuse_id
  generated_at
  expires_at
  bid_id
  requested_repair_class
  dependent_lane_witness_refs
  quarantine_epoch_ref
  decision                     # allow, hold, quarantine, deny
  max_runtime_seconds
  max_notional
  required_closure_receipts
  blocked_reasons
  fallback_repair_class
```

## Initial Rules

- `serve_readonly` remains allowed while Jangar serving, database, watch reliability, and execution trust are healthy.
- `torghut_observe` remains allowed when Torghut routes answer, even when capital remains shadow.
- A downstream `ImagePullBackOff` creates `lane_quarantine` for the affected lane and every bid that depends on it.
- `sim_quant_bootstrap` is held while `sim_ta` is quarantined.
- `empirical_replay` can run only when its dataset, runtime image, and data-producing lane witnesses are current, or
  when the bid explicitly declares the lane out of scope and stays zero-notional.
- `market_context_rehydrate` may run under quarantine only when it does not claim to unlock paper or live capital.
- `paper_canary`, `live_micro_canary`, and `live_scale` require `quarantine_decision=none` for every dependent lane.
- `merge_ready` remains held while a current PR would make a quarantined lane worse or remove its rollback target.

## Implementation Scope

Jangar engineer stage:

1. Add the quarantine reducer beside the negative-evidence router and repair admission governor.
2. Extend failure-domain image-pull evidence to accept downstream Torghut data-plane witnesses, not only Jangar local
   Kubernetes evidence.
3. Add `profit_repair_fuse_decision` to control-plane status and action SLO budget evidence refs.
4. Add tests for a Torghut sim TA `ImagePullBackOff` that holds sim quant bootstrap and paper canary while keeping
   serve and independent repair allowed.
5. Add tests that market-context repair can remain allowed when it does not depend on the quarantined lane.

Torghut engineer stage:

1. Publish data-plane witnesses for live service, sim service, live TA, sim TA, options catalog, options enricher, and
   empirical replay.
2. Attach data-plane witness refs to every profit-renewal bid.
3. Attach Jangar fuse decisions to capital shadow ledger receipts.

## Validation Gates

- Jangar status names `data_plane_image_quarantine` when a dependent Torghut lane is `ImagePullBackOff`.
- The status payload cites the image digest, platform failure reason, lane, and Kubernetes evidence ref.
- `dispatch_repair` remains allowed only for repair classes whose dependent lanes are not quarantined, with
  `max_notional=0`.
- `paper_canary`, `live_micro_canary`, and `live_scale` are held or blocked while any dependent data-plane witness is
  failed, stale, or empty.
- Torghut sim quant bootstrap is not marked complete until sim TA image pull, runtime readiness, and latest quant
  metrics are all current.
- Deployer validation proves the failed digest has either been replaced by a pullable digest or is quarantined with an
  explicit rollback target.

## Rollout Plan

1. Shadow-compile quarantine epochs from existing Kubernetes events, failure-domain leases, and Torghut route evidence.
2. Add Torghut data-plane witness refs to bids without changing action budgets.
3. Gate Jangar repair admission on the fuse for `paper_canary` and `sim_quant_bootstrap`.
4. Extend the fuse to `merge_ready`, `live_micro_canary`, and `live_scale`.
5. Keep `serve_readonly`, `torghut_observe`, and independent zero-notional repairs open while the lane quarantine is
   active.

## Rollback Plan

- Disable fuse enforcement and fall back to the existing negative-evidence router and dependency quorum.
- Keep quarantine epochs observable so deployers can still see the downstream image failure.
- If witness publication is wrong, ignore Torghut data-plane witnesses and use direct Kubernetes evidence as the
  temporary source of truth.
- If the quarantine reducer blocks too broadly, fall back to a fixed deny list for the affected lane:
  `sim_quant_bootstrap`, `paper_canary`, and any bid that claims sim TA freshness.

## Handoff

Engineer handoff:

- Implement the quarantine as evidence first, action second.
- Do not let a profit-renewal bid claim paper-capital progress while its dependent data-plane witness is failed.
- Start with the current `torghut-ta-sim` platform-manifest failure as the regression fixture.

Deployer handoff:

- Before paper canary, capture the Jangar fuse id, Torghut data-plane witness ids, the replacement or rollback image
  digest, sim quant latest metrics, empirical replay receipts, and market-context freshness proof.
- Do not treat a running sim route as enough. The data lane that produces the proof must also have current image,
  runtime, and freshness evidence.
