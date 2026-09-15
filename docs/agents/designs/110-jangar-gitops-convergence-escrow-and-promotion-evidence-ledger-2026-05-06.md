# 110. Jangar GitOps Convergence Escrow And Promotion Evidence Ledger (2026-05-06)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-06
Owner: Victor Chen, Jangar Engineering Architecture
Scope: Jangar control-plane promotion authority, GitOps convergence, watch reliability, rollout safety, Torghut
capital handoff, and evidence-ledger audit.

Companion Torghut contract:

- `docs/torghut/design-system/v6/114-torghut-convergence-bound-proof-replay-and-capital-readmission-2026-05-06.md`

Extends:

- `109-jangar-promotion-escrow-replay-cells-and-consumer-parity-gates-2026-05-06.md`
- `108-jangar-action-class-capital-clearance-and-proof-clock-arbiter-2026-05-06.md`
- `107-jangar-reciprocal-evidence-authority-and-contradiction-escrow-2026-05-06.md`

## Decision

I am selecting **GitOps convergence escrow with a promotion evidence ledger** as the next Jangar control-plane
architecture step.

The latest read-only sample shows the failure mode clearly. Jangar can serve and its local failure-domain leases can all
be valid, while the broader action authority is still not safe. At `2026-05-06T10:08:24.266Z`, Jangar control-plane
status reported the database configured, connected, healthy, and low-latency at `4ms`. The same payload reported valid
leases for `database`, `route`, `rollout`, `registry`, `storage`, `workflow_artifact`, `nats`, and `source_schema`.
Those leases allowed `serve_readonly`, `dispatch_normal`, `dispatch_repair`, `deploy_widen`, `merge_ready`,
`torghut_observe`, and `torghut_capital` in shadow.

That is not enough. The same status reported watch reliability `degraded` over the 15 minute window with `6` streams,
`5043` events, `3` errors, and `12` restarts. Dependency quorum was `block` for `watch_reliability_blocked` and
`empirical_jobs_degraded`. Argo CD reported `jangar` and `agents` `Synced` and `Healthy`, but `torghut` was
`OutOfSync` while still `Healthy`, with simulation `AnalysisTemplate` resources, the historical-simulation
`WorkflowTemplate`, the empirical-promotion `WorkflowTemplate`, and both Knative services out of sync. Torghut live
`/trading/health` returned HTTP `503`: broker, Postgres, ClickHouse, schema, and Jangar universe were healthy, but live
submission remained disabled, quant evidence was `quant_health_not_configured`, and no hypothesis was promotion
eligible. Torghut sim `/readyz` returned HTTP `200`, but its account-scoped Jangar quant-health view had
`latest_metrics_count=0` and `empty_latest_store_alarm=true`.

The selected design makes promotion an escrowed convergence event instead of a local status decision. Jangar will not
let a replay cell, clearance receipt, failure-domain lease, or service health probe authorize merge, deploy widening,
paper capital, or live capital unless the requested action also has a convergence ledger entry. That entry binds GitOps
desired revision, applied runtime revision, Argo sync health, watch reliability, rollout observations, service-owned
database/schema projections, Torghut empirical proof, and consumer acknowledgment into one replayable record.

The tradeoff is explicit coupling to GitOps state. I accept that. Jangar is a control plane, not a pod checker. The
remaining risk is not that Jangar misses whether a pod is running. The risk is that operators promote from a healthy
runtime while desired state, watch authority, empirical proof, or consumer evidence are stale or divergent. The control
plane needs to name that state and hold material actions without blocking read-only serving or proof repair.

## Evidence Snapshot

No Kubernetes resources, database rows, broker settings, trading flags, or runtime configuration were mutated during
this assessment. I only set a local in-cluster `kubectl` context from the mounted service-account token, then used
read-only Kubernetes and service-owned HTTP projections.

### Cluster And Rollout Evidence

- Runtime identity: `system:serviceaccount:agents:agents-sa`.
- Argo CD: `agents`, `agents-ci`, `jangar`, `symphony-jangar`, `symphony-torghut`, and `torghut-options` were
  `Synced` and `Healthy`.
- Argo CD: `torghut` was `OutOfSync` and `Healthy` at revision `3592eaf15cc7dc03f47fb2ef5d5545020a6ee8a3`.
- Torghut out-of-sync resources included `torghut-simulation-*` `AnalysisTemplate` resources,
  `argo-workflows/torghut-historical-simulation`, `torghut/torghut-empirical-promotion`, and Knative services
  `torghut` and `torghut-sim`.
- Jangar namespace deployments were available: `jangar=1/1`, `jangar-alloy=1/1`, and `symphony-jangar=1/1`.
- Agents deployments were available: `agents=1/1`, `agents-alloy=1/1`, and `agents-controllers=2/2`.
- Agents namespace still carried operational debt: `137` completed pods, `32` error pods, and `9` running pods; jobs
  counted `141` complete, `28` failed, and `5` running.
- Recent Agents events included readiness and liveness probe failures for `agents` and `agents-controllers` even while
  deployments were available.
- Torghut active live and simulation revisions were both running on digest `b9156e2f...`; sim moved to
  `torghut-sim-00316`, live remained on `torghut-00234`.
- Recent Torghut events showed sim startup/readiness probe failures that cleared, repeated ClickHouse multiple-PDB
  warnings, and Keeper PDB `NoPods` warnings.
- Listing Knative `Service` and `Revision` resources directly was forbidden to this runtime, so deployment, pod,
  service, Argo Application, and service-owned health projections are the read-only audit surface.

### Database And Data Evidence

- Jangar `/ready` reported leader election active, execution trust healthy, self-hosted memory embeddings configured,
  runtime kits healthy, and serving/swarm admission passports allowed.
- Jangar control-plane status reported the database configured, connected, healthy, and low-latency at `4ms`.
- Jangar watch reliability was degraded in the same status payload: `6` streams, `5043` events, `3` errors, and `12`
  restarts in a 15 minute window.
- Jangar dependency quorum was `block` with reasons `watch_reliability_blocked` and `empirical_jobs_degraded`.
- Failure-domain leases were valid for database, route, rollout, registry, storage, workflow artifacts, NATS, and
  source schema. The source-schema lease cited
  `source_schema:latest_registered:20260505_torghut_quant_pipeline_health_window_index`.
- Torghut `/db-check` returned HTTP `200`, `ok=true`, schema current at Alembic head
  `0029_whitepaper_embedding_dimension_4096`, and account scope ready.
- Torghut schema lineage still includes known parent-fork warnings at
  `0010_execution_provenance_and_governance_trace` and `0015_whitepaper_workflow_tables`.
- Torghut live `/readyz` and `/trading/health` returned HTTP `503`. Core dependencies were healthy, but
  `live_submission_gate.allowed=false`, `simple_submit_disabled`, `capital_stage=shadow`,
  `promotion_eligible_total=0`, and `rollback_required_total=3`.
- Torghut live quant evidence was informational only and not configured:
  `TRADING_JANGAR_QUANT_HEALTH_URL` was absent in the live route.
- Torghut sim `/readyz` returned HTTP `200` in paper mode, but typed quant evidence for account `TORGHUT_SIM` was
  degraded with `latest_metrics_count=0`, `empty_latest_store_alarm=true`, and no pipeline stages.
- Jangar account-scoped quant health for live account `PA3SX7FYNUTF` returned HTTP `200` but had
  `metricsPipelineLagSeconds=53703`, so it is not capital-grade freshness.
- Market-context health for `AAPL` returned HTTP `200` with `overallState=degraded`; technicals, regime, fundamentals,
  and news were stale.
- Torghut `/trading/autonomy` reported stale empirical jobs for `benchmark_parity`, `foundation_router_parity`,
  `janus_event_car`, and `janus_hgrm_reward` over dataset `torghut-full-day-20260318-884bec35`.

### Source Evidence

- `services/jangar/src/server/control-plane-status.ts` composes controllers, runtime adapters, database, watch
  reliability, workflows, empirical services, failure-domain leases, execution trust, runtime kits, and admission
  passports into the status surface operators rely on.
- `services/jangar/src/server/control-plane-workflows.ts` turns watch reliability and workflow failure windows into the
  broad dependency-quorum decision. It currently blocks globally when watch restart/error thresholds are crossed.
- `services/jangar/src/server/control-plane-failure-domain-leases.ts` owns shadow holdbacks for material action classes
  and can allow `torghut_capital` when local leases are valid.
- `services/jangar/src/server/control-plane-empirical-services.ts` pulls Torghut empirical-job freshness into Jangar
  dependency quorum but does not bind that result to GitOps convergence or runtime digest.
- `services/jangar/src/server/supporting-primitives-controller.ts` remains a high-risk module at `2883` lines and owns
  schedules, runner ConfigMaps, CronJobs, swarms, freezes, requirements, and workspace status.
- `services/torghut/app/main.py` remains a high-risk surface at `4051` lines and owns readiness, DB checks, trading
  health, runtime profitability, decisions, executions, and data projections.
- `services/torghut/app/trading/submission_council.py` is `1196` lines and already derives typed quant-health status
  when `TRADING_JANGAR_QUANT_HEALTH_URL` is configured.
- `argocd/applications/torghut/knative-service.yaml` configures live with Jangar control-plane status but no typed
  quant-health URL and keeps `TRADING_SIMPLE_SUBMIT_ENABLED=false`.
- `argocd/applications/torghut/knative-service-sim.yaml` configures the typed Jangar quant-health URL for `TORGHUT_SIM`
  and runs in paper mode.

## Problem

Jangar currently has four truths that are individually correct and collectively dangerous:

1. Serving can be healthy.
2. Failure-domain leases can be valid.
3. Dependency quorum can be blocked by watch reliability and empirical proof.
4. A downstream consumer can be Kubernetes-healthy but GitOps-out-of-sync or missing typed capital evidence.

The current architecture does not provide one authoritative promotion record that reconciles those truths. Operators
must compare Argo sync state, runtime images, watch health, Jangar leases, Torghut readiness, empirical proof, and
account-scoped metrics by hand. That is manageable in a quiet incident review and unsafe during image transitions,
market sessions, or capital promotion.

The gap is specifically a convergence gap. A replay cell says which evidence should authorize an action. A failure-domain
lease says the local domains are available. Dependency quorum says global evidence is blocked. Argo says desired state is
or is not converged. None of those alone is a final material-action authority.

## Alternatives Considered

### Option A: Treat Replay Cells As Final Promotion Authority

Pros:

- Builds directly on the latest accepted design.
- Keeps one compact cell id as the deployer reference.
- Avoids adding another control-plane projection.

Cons:

- Does not distinguish a healthy runtime from a converged desired state.
- Can miss Argo `OutOfSync` resources that are not represented in service health.
- Does not explain whether watch degradation invalidates the evidence feed used by the cell.

Decision: reject. Replay cells remain necessary inputs, not final material-action authority.

### Option B: Freeze All Material Actions On Any OutOfSync Or Watch Degradation

Pros:

- Very conservative.
- Easy to implement as a hard gate.
- Prevents promotion while the latest sample is ambiguous.

Cons:

- Blocks the repair and proof-replay work needed to clear the condition.
- Treats intentional or known-drift GitOps ignores the same as capital drift.
- Gives Torghut no structured path from shadow to paper after repair.

Decision: reject as the operating model. Keep it as the emergency posture for unknown or unsafe drift.

### Option C: GitOps Convergence Escrow With Promotion Evidence Ledger

Pros:

- Separates serving, repair, observe, deploy widening, merge readiness, paper capital, and live capital.
- Makes Argo desired-state convergence a typed input instead of a side-channel observation.
- Requires the runtime digest, desired revision, watch window, DB/schema proof, and consumer acknowledgment to agree.
- Allows repair-only and observe-only work while capital and deploy widening stay held.
- Produces a single replayable audit record for engineer and deployer stages.

Cons:

- Adds a projection and requires Argo Application status as another evidence source.
- Requires careful modeling of intentionally ignored differences.
- Requires UI/API work so operators see the decision and rollback target, not just raw refs.

Decision: select Option C.

## Architecture

Jangar introduces a `promotion_evidence_ledger` and a `gitops_convergence_escrow` reducer.

```text
promotion_evidence_ledger
  ledger_id
  action_class                 # serve_readonly, dispatch_repair, torghut_observe, deploy_widen,
                               # merge_ready, paper_canary, live_micro_canary, live_scale
  requested_ref                # branch, PR, image digest, hypothesis, account, or rollout scope
  desired_state_ref            # Argo application, target revision, manifest digest
  applied_state_ref            # runtime image digest, deployment/revision, observed generation
  convergence_ref
  watch_reliability_ref
  replay_cell_ref
  failure_domain_lease_refs
  database_schema_ref
  empirical_proof_refs
  market_context_refs
  consumer_ack_ref
  decision                     # allow, observe_only, repair_only, hold
  held_reasons
  fresh_until
  rollback_target
```

`gitops_convergence_escrow` is the reducer that feeds the ledger:

```text
gitops_convergence_escrow
  escrow_id
  application
  namespace
  desired_revision
  compared_revision
  sync_status                  # synced, out_of_sync, unknown
  health_status
  out_of_sync_resources
  ignored_differences_digest
  runtime_digest_refs
  evidence_consumer_refs
  decision                     # converged, known_drift_repair_only, unknown_drift_hold
  allowed_actions
  held_actions
  expires_at
```

Key invariants:

- `serve_readonly` can be allowed with healthy route and DB projections even when convergence escrow is held.
- `dispatch_repair` can be allowed when the held reasons are repairable and the runtime kit is fresh.
- `torghut_observe` can proceed when no capital is spent and negative evidence is recorded.
- `deploy_widen`, `merge_ready`, `paper_canary`, `live_micro_canary`, and `live_scale` require converged desired state
  or an explicit known-drift waiver with a rollback target.
- Torghut capital actions require the same ledger id to appear in Jangar status and Torghut health/submission surfaces.
- Ignored Argo differences are not silently trusted. They are hashed into `ignored_differences_digest` and are only
  allowed for the action classes named by policy.

## Implementation Scope

Engineer stage should implement this in additive slices:

- Add an Argo Application reader for `agents`, `jangar`, `torghut`, `torghut-options`, `symphony-jangar`, and
  `symphony-torghut`, using Kubernetes read-only status first and service projections if RBAC blocks a resource.
- Add a convergence reducer that classifies `Synced/Healthy`, `Healthy/OutOfSync`, `Progressing`, `Degraded`, and
  unknown states per action class.
- Extend `/api/agents/control-plane/status` with `gitops_convergence_escrows` and `promotion_evidence_ledger` while
  preserving existing fields.
- Bind ledger entries to `watch_reliability`, `failure_domain_leases`, `dependency_quorum`, replay cells, database
  schema refs, runtime digests, and consumer acknowledgments.
- Add Torghut consumer acknowledgment fields so `/readyz`, `/trading/health`, `/trading/status`, and
  `/trading/autonomy` can cite the ledger id used for paper or live decisions.
- Add a deployer view that summarizes action, decision, held reasons, freshness deadline, and rollback target before
  raw refs.

## Validation Gates

- Unit: `Healthy/OutOfSync` Torghut with out-of-sync analysis templates holds `deploy_widen`, `paper_canary`, and
  `live_micro_canary`, but allows `dispatch_repair` with explicit held reasons.
- Unit: degraded watch reliability holds capital and deploy widening even when failure-domain leases are valid.
- Unit: ignored Argo differences are included in the convergence digest and cannot authorize capital unless policy
  marks them intentional.
- Unit: live route missing typed quant-health URL produces a Torghut consumer acknowledgment hold.
- Unit: sim account `empty_latest_store_alarm=true` blocks `paper_canary` even when sim `/readyz` is HTTP `200`.
- Integration: Jangar status, Torghut health, and the deployer handoff cite the same ledger id for any material action.
- Data gate: database/schema evidence must come from service-owned projections when direct database access is forbidden.
- Rollout gate: every non-read action checks `fresh_until` after rollout and before widening.

## Rollout And Rollback

Phase 0: publish convergence escrows and ledger entries in shadow. Existing status and replay-cell behavior remain
unchanged.

Phase 1: make the ledger required for deployer handoffs and Jangar UI promotion summaries. Rollback is to hide the
additive fields while leaving dependency quorum and failure-domain leases unchanged.

Phase 2: make the ledger authoritative for `deploy_widen`, `merge_ready`, and `paper_canary`. Rollback is to force all
ledger decisions for those classes to `hold` and continue repair work through `dispatch_repair`.

Phase 3: make the ledger mandatory for `live_micro_canary` and `live_scale`. Rollback is to revoke open live-capital
ledger entries, set Torghut back to shadow, and require live submission disabled before any new repair cells run.

## Risks

- Argo `OutOfSync` can be noisy when ignore rules intentionally permit runtime mutation. The design requires an
  ignored-differences digest so that noise is explicit instead of invisible.
- Ledger state can become stale during long market sessions. Capital consumers must re-check `fresh_until` before each
  paper or live promotion.
- Watch degradation can be transient. The reducer should use the existing reliability thresholds and avoid holding
  read-only serving.
- The deployer UI can become cluttered if it shows raw resource lists first. The ledger summary must lead with action,
  decision, held reasons, and rollback target.
- Direct database proof is not available to this runtime. That is acceptable only if service-owned projections remain
  first-class and are named in ledger refs.

## Handoff

Engineer acceptance gate: implement convergence escrows and promotion ledger entries in Jangar, bind them to Argo
Application status, watch reliability, failure-domain leases, replay cells, service-owned database/schema projections,
Torghut consumer acknowledgments, and add tests for Healthy/OutOfSync, degraded watch, ignored differences, missing
typed quant health, and empty sim account quant evidence.

Deployer acceptance gate: do not widen Jangar/Agents/Torghut rollout, mark merge ready, or promote Torghut beyond
observe/repair unless the ledger entry for that action is fresh, converged or intentionally waived, cites service-owned
DB/schema proof, cites current watch reliability, cites the matching Torghut consumer acknowledgment, and names an
executable rollback target.
