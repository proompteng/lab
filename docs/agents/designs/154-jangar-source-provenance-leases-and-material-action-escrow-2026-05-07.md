# 154. Jangar Source Provenance Leases And Material Action Escrow (2026-05-07)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-07
Owner: Victor Chen, Jangar Engineering
Scope: Jangar source provenance, material-action admission, rollout safety, contract actuation, Torghut capital
proof provenance, validation, rollback, and implementation handoff.

Companion Torghut contract:

- `docs/torghut/design-system/v6/158-torghut-capital-proof-provenance-and-routeable-edge-repair-ledger-2026-05-07.md`

Extends:

- `153-jangar-design-actuation-ledger-and-contract-convergence-gates-2026-05-07.md`
- `152-jangar-material-verdict-authority-and-contradiction-debt-ledger-2026-05-07.md`
- `148-jangar-source-rollout-truth-exchange-and-proof-floor-settlement-2026-05-07.md`

## Decision

I am selecting source provenance leases with material action escrow as the next Jangar control-plane architecture step.

The current system is healthier than the earlier May 7 evidence, but the safety problem is sharper. Jangar is serving,
the database migration surface is healthy, Agents rollouts are available, execution trust is healthy, and watch
reliability has recovered. At the same time, `source_rollout_truth_exchange` still holds `dispatch_repair`,
`dispatch_normal`, `deploy_widen`, and `merge_ready` because source and GitOps revision are missing and the controller
witness remains split. The live image can match the desired runtime kit while source authority is still unknown.

That is the failure mode I want to remove. A material action should not be authorized by image presence, route health,
or a merged design document alone. It needs a short-lived source provenance lease that ties together source SHA,
GitOps revision, desired image digest, live image digest, controller witness, database migration head, watch cache, and
contract actuation state. The action then enters a material action escrow that either releases a bounded action or
holds it with a repair target.

The tradeoff is that some actions stay held while the system is otherwise green. I accept that. A reliable control
plane should make missing provenance cheap to diagnose and impossible to accidentally ignore.

## Runtime Objective And Success Metrics

Success means:

- Jangar publishes `source_provenance_leases` and `material_action_escrow` from
  `/api/agents/control-plane/status`.
- Every material action class has a lease decision: `allow`, `repair_only`, `hold`, or `block`.
- `serve_readonly` can remain `allow` when route, database, and serving image evidence are current.
- `dispatch_repair`, `dispatch_normal`, `deploy_widen`, and `merge_ready` require current source SHA, GitOps
  revision, live image parity, controller witness, watch cache, and database projection.
- `paper_canary`, `live_micro_canary`, and `live_scale` additionally require Torghut capital proof provenance.
- A missing source SHA or GitOps revision produces a lease state of `partial`, never an implicit pass.
- A design-only or absent contract actuation record cannot satisfy source provenance for a material action.
- `/ready` stays focused on serving health and may summarize lease debt without failing `serve_readonly`.
- Deployer checks consume the escrow result instead of independently reading image digests, action clocks, and design
  docs.

## Evidence Snapshot

All evidence was collected read-only on 2026-05-07. I did not mutate Kubernetes resources, database records,
ClickHouse tables, broker state, AgentRun objects, GitOps resources, trading flags, or empirical artifacts.

### Cluster And Rollout Evidence

- The local Kubernetes context was initially unset. I bootstrapped the documented in-cluster context from the service
  account token and CA. The identity was `system:serviceaccount:agents:agents-sa`.
- `jangar` deployments were available: `jangar=1/1`, `bumba=1/1`, `symphony=1/1`, `symphony-jangar=1/1`, and
  `jangar-alloy=1/1`.
- The active Jangar pod was `jangar-67ffbb64-dlrs5`, running image
  `registry.ide-newton.ts.net/lab/jangar:40200cfe@sha256:360789a70b5cf33772de630b3a07b1c1433cbfe89869725c1e28551652a39582`.
- `agents` deployments were available: `agents=1/1`, `agents-controllers=2/2`, and `agents-alloy=1/1`.
- The active Agents images were
  `registry.ide-newton.ts.net/lab/jangar-control-plane:40200cfe@sha256:11a7f1637544562fa04acba603d33e75781843237a9aed33eee84ec2e127eddf`
  and `registry.ide-newton.ts.net/lab/jangar:40200cfe@sha256:360789a70b5cf33772de630b3a07b1c1433cbfe89869725c1e28551652a39582`.
- Recent Agents events showed a successful rollout, completed discover and Torghut quant wrapper jobs, and fresh
  readiness probe timeouts on the current `agents` and `agents-controllers` pods.
- Older retained schedule pods from the discover, plan, implement, and verify lanes remained in `Error`, while newer
  cron wrapper runs were completing.
- `torghut` active live and simulation revisions were `torghut-00271` and `torghut-sim-00371`, both available at
  `1/1` and using image digest `sha256:a11681083f23a9e0b9255b4e7e5052d812708514c965860a95b70e55958dad34`.
- Listing Knative services in the Torghut namespace was RBAC-blocked for this service account, but deployments, pods,
  services, and events were readable.

### Jangar Status And Data Evidence

- `GET http://jangar.jangar.svc.cluster.local/ready` returned `status=ok`.
- `GET /api/agents/control-plane/status?namespace=agents` generated at `2026-05-07T16:09:17.064Z`.
- Jangar database status was healthy: configured, connected, `latency_ms=15`, migration table `kysely_migration`,
  `registered_count=28`, `applied_count=28`, `unapplied_count=0`, and latest applied
  `20260505_torghut_quant_pipeline_health_window_index`.
- Rollout health was healthy for the observed Agents deployments.
- Execution trust was healthy with no blocking windows.
- Watch reliability was healthy over a 15 minute window: one stream, 2388 events, zero errors, and zero restarts.
- Controller witness was `allow_with_split`, with `controller_process_heartbeat_authoritative`; the ingestion witness
  still reported `repair_only` with `controller_ingestion_unknown`.
- `source_rollout_truth_exchange` allowed `serve_readonly` and `torghut_observe`, but held `dispatch_repair`,
  `dispatch_normal`, `deploy_widen`, `merge_ready`, and `paper_canary`, and blocked `live_micro_canary` and
  `live_scale`.
- The freshest material blocking reason was `source_rollout_truth_missing:source_or_gitops_revision`.
- `contract_actuation_ledger`, `material_verdict_authority`, `repair_outcome_settlement`, and
  `controller_brownout_budget` were still null in the live status payload.
- Direct CNPG SQL was RBAC-blocked for both `jangar-db-1` and `torghut-db-1`: this service account cannot create
  `pods/exec`. Typed status endpoints are therefore the available database witnesses for this lane.

### Source Evidence

- `services/jangar/src/server/control-plane-status.ts` is 787 lines and assembles the status payload from many gates.
- `services/jangar/src/server/control-plane-source-rollout-truth-exchange.ts` is 632 lines and already emits action
  receipts with source/GitOps missing-revision holds.
- `services/jangar/src/server/control-plane-material-action-verdict.ts` is 528 lines and can consume stricter truth
  once a provenance lease is available.
- `services/jangar/src/server/control-plane-negative-evidence-router.ts` is 610 lines and can carry lease debt.
- `services/jangar/src/server/supporting-primitives-controller.ts` is 3301 lines and still owns a large share of
  schedule, dispatch, PVC, and watch behavior.
- `rg` found `contract_actuation_ledger`, `material_verdict_authority`, `repair_outcome_settlement`, and
  `controller_brownout_budget` in accepted docs, but not as live Jangar source fields.
- Existing tests cover source rollout truth, material action verdicts, controller witness, watch reliability,
  execution trust, and status assembly. The missing test is source provenance lease behavior across source SHA,
  GitOps revision, live image parity, controller witness, and contract actuation.

### Torghut Capital Evidence

- Live Torghut `/readyz` returned HTTP `503` with `status=degraded`.
- Live dependencies were healthy for Postgres, ClickHouse, Alpaca, Jangar universe, readiness cache, empirical jobs,
  and database schema.
- Live database schema was current at Alembic head `0029_whitepaper_embedding_dimension_4096`.
- Live proof floor was `repair_only`, route state `repair_only`, capital state `zero_notional`, and `max_notional=0`.
- Live blockers were `hypothesis_not_promotion_eligible`, `execution_tca_route_universe_empty`,
  `market_context_stale`, and `simple_submit_disabled`.
- Live execution TCA had 7334 orders, 7245 filled executions, zero routeable symbols, five blocked symbols, three
  missing symbols, average absolute slippage `13.8203637593029676` bps, and guardrail `8` bps.
- Live quant evidence was informational but degraded: latest metrics were fresh, but `max_stage_lag_seconds=523984`.
- Simulation `/readyz` returned HTTP `200`, but simulation proof floor still reported `repair_only` and
  `zero_notional`.

## Problem

Jangar has a source authority gap. The runtime can prove that a route is up, a database is current, a watch stream is
fresh, and a pod image is running. It cannot yet produce a compact lease that says the material action is backed by
source, GitOps, image, controller, database, and contract actuation evidence.

The current failure modes are:

1. Live image parity can look like rollout safety even when source SHA and GitOps revision are null.
2. Controller witness can be strong enough to serve but still split enough to hold material dispatch.
3. Design contracts can be merged faster than runtime status fields are implemented.
4. Deployer logic can accidentally read an optimistic lower-level field while stricter truth holds the action.
5. Torghut capital can ask for Jangar proof while the Jangar proof is still design-only.

## Alternatives Considered

### Option A: Keep Source Rollout Truth As The Only Provenance Surface

Pros:

- It already exists and is producing useful holds.
- It knows desired and live images.
- It is already wired into the status route.

Cons:

- It mixes evidence capture, action decision, and deployer summary in one large surface.
- It does not make a reusable lease for downstream gates.
- It cannot by itself distinguish design-only contracts from live authority.

Decision: reject as incomplete.

### Option B: Implement The Full Contract Actuation Ledger First

Pros:

- It directly addresses the design-to-runtime gap.
- It gives engineers and deployers a contract state map.
- It prevents future accepted docs from becoming implicit runtime authority.

Cons:

- It does not solve the immediate missing source/GitOps lease that is holding material actions today.
- It can still classify a contract without proving that a particular action is backed by current source provenance.
- It is broader than the smallest reliability slice exposed by the current evidence.

Decision: reject as the first move. It remains a required dependency, but material actions need a lease object.

### Option C: Add Source Provenance Leases And Material Action Escrow

Pros:

- Turns missing source/GitOps evidence into a first-class repair target.
- Gives deployers one bounded release/hold object per action.
- Composes with contract actuation without waiting for every design-only contract to be implemented.
- Keeps `serve_readonly` available while holding unsafe dispatch, widen, merge, and capital actions.

Cons:

- Adds one reducer and one escrow surface.
- Requires careful expiry handling so stale leases do not authorize new work.
- Will keep some actions held until source/GitOps evidence is wired.

Decision: select Option C.

## Architecture

Add a pure reducer named `control-plane-source-provenance-lease` under `services/jangar/src/server/`. It should not
query Kubernetes or databases directly. It consumes the assembled status evidence and emits leases plus escrow
decisions.

Inputs:

- Source head SHA from AgentRun VCS refs, PR metadata, or release metadata.
- GitOps revision from Argo CD or release promotion metadata.
- Desired runtime kit image refs and digests.
- Live image refs and digests from pods and deployments.
- Controller witness quorum and watch reliability.
- Database migration projection.
- Contract actuation records when available.
- Torghut capital proof provenance when the action class touches capital.

`SourceProvenanceLease` fields:

- `lease_id`
- `action_class`
- `lease_state`: `absent`, `partial`, `current`, `contradicted`, or `expired`
- `decision`: `allow`, `repair_only`, `hold`, or `block`
- `source_head_sha`
- `gitops_revision`
- `desired_image_digest`
- `live_image_digest`
- `controller_witness_ref`
- `watch_cache_ref`
- `database_projection_ref`
- `contract_actuation_refs`
- `torghut_capital_proof_ref`
- `missing_evidence`
- `fresh_until`
- `rollback_target`

`MaterialActionEscrow` fields:

- `escrow_id`
- `action_class`
- `lease_id`
- `release_state`: `released`, `repair_only`, `held`, or `blocked`
- `allowed_scope`
- `max_dispatches`
- `max_runtime_seconds`
- `max_notional`
- `blocking_reason_codes`
- `required_repair_actions`
- `evidence_refs`
- `rollback_target`

Decision rules:

- `serve_readonly` may be `allow` when route, database, desired/live serving image, and watch evidence are current.
- `dispatch_repair` may be `repair_only` with missing GitOps revision only if source head, controller witness, and
  contract actuation for the repair surface are current.
- `dispatch_normal`, `deploy_widen`, and `merge_ready` require source head, GitOps revision, image parity, controller
  witness, database projection, and live contract actuation.
- `paper_canary` requires Jangar source provenance plus Torghut capital proof provenance in `shadow` or `live`.
- `live_micro_canary` and `live_scale` require Jangar source provenance plus live Torghut capital proof provenance.
- Missing source or GitOps evidence always produces `partial` and blocks widening or merge readiness.

## Validation Gates

Engineer validation:

- Add `services/jangar/src/server/__tests__/control-plane-source-provenance-lease.test.ts`.
- Add a fixture where source SHA and GitOps revision are null and prove dispatch, widen, and merge are held.
- Add a fixture where serving image parity is current and prove `serve_readonly` remains allowed.
- Add a fixture where controller witness is split and prove normal dispatch cannot release.
- Add a fixture where contract actuation is absent and prove design-only contracts cannot authorize material action.
- Extend `control-plane-status.test.ts` to assert `source_provenance_leases` and `material_action_escrow` are present.

Deployer validation:

- Before deploy widening or merge-ready, require `MaterialActionEscrow.release_state=released` for the action class.
- Before repair dispatch, allow `repair_only` only when the escrow names bounded dispatch count and rollback target.
- Before any Torghut capital action, require a Torghut capital proof provenance ref and nonzero capital policy.

Data validation:

- The reducer must use typed Jangar and Torghut status endpoints when CNPG SQL is RBAC-blocked.
- Missing SQL access must appear as validation debt, not as a pass or an empty evidence set.

## Rollout

Phase 0 adds the reducer and tests with all material actions in shadow mode.

Phase 1 publishes `source_provenance_leases` and `material_action_escrow` from the status route. Readiness remains
unchanged.

Phase 2 wires deployer verification to read the escrow for deploy widening and merge-ready while keeping repair
dispatch manually bounded.

Phase 3 wires engineer dispatch to require current source provenance for normal work and bounded repair provenance for
repair-only work.

Phase 4 wires Torghut paper/live capital to require Torghut capital proof provenance plus Jangar material escrow.

## Rollback

If the reducer fails, mark lease status `unknown` or omit the field and keep existing source rollout truth and material
action verdict gates authoritative. Do not fail `serve_readonly` solely because the lease reducer failed.

If deployer checks over-block, disable only the deployer consumer gate and leave the lease visible for diagnosis.

If a stale lease releases action, immediately expire the lease, downgrade the related contract actuation record to
`shadow` or `design_only`, and hold the action at source rollout truth.

## Risks

- Source SHA and GitOps revision may be hard to recover for older retained jobs.
- A lease can become another status surface unless deployer and engineer consumers actually use it.
- Contract actuation and source provenance can disagree during rollout; the stricter decision must win.
- Torghut capital proof provenance may arrive later than Jangar source provenance, keeping capital held longer.

## Handoff To Engineer

Implement Jangar first. The smallest accepted slice is:

1. Add the pure source provenance lease reducer and fixtures.
2. Emit `source_provenance_leases` and `material_action_escrow` from control-plane status in shadow mode.
3. Populate source/GitOps missing evidence from the existing source rollout truth exchange.
4. Keep `/ready` independent from material action lease debt.
5. Add tests for missing source/GitOps, image parity, split controller witness, and absent contract actuation.

## Handoff To Deployer

Treat `material_action_escrow` as the action preflight once it exists. If it is absent, unknown, expired, or held, do
not widen deploys, claim merge-ready, or unlock Torghut capital. `serve_readonly` can stay available on the older
serving readiness path. Repair-only dispatch is acceptable only when the escrow names a bounded scope, expiry, and
rollback target.
