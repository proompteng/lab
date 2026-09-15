# 136. Jangar Controller Authority Settlement And Endpoint Parity Ledger (2026-05-07)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-07
Owner: Victor Chen, Jangar Engineering
Scope: Jangar control-plane endpoint parity, controller authority settlement, split-topology rollout safety,
material-action gates, deploy verification, Torghut capital handoff, and rollback.

Companion Torghut contract:

- `docs/torghut/design-system/v6/140-torghut-endpoint-parity-profit-repair-and-capital-route-auction-2026-05-07.md`

Extends:

- `135-jangar-database-witness-and-schema-authority-exchange-2026-05-07.md`
- `135-jangar-rollout-availability-escrow-and-consumer-evidence-custody-2026-05-07.md`
- `134-jangar-evidence-census-and-projection-settlement-exchange-2026-05-07.md`
- `133-jangar-in-flight-stage-renewal-bonds-and-controller-ingestion-settlement-2026-05-07.md`
- `116-jangar-controller-witness-quorum-and-capital-activation-receipts-2026-05-06.md`

## Decision

I am selecting **controller authority settlement with an endpoint parity ledger** as the next Jangar control-plane
architecture step.

The current production evidence is not a simple outage. Jangar is serving, leader election is healthy, the status route
can build a rich control-plane picture, database migration consistency is healthy, and watch reliability is healthy.
The dangerous part is that different control-plane endpoints now tell different authority stories. At
`2026-05-07T08:11Z`, `GET /health` returned `status=ok` while saying `agentsController.enabled=false` and
`started=false`. `GET /ready` also returned `status=ok` with the same local controller-disabled view and degraded
execution trust. In the same window, `GET /api/agents/control-plane/status` reported healthy controller rows for the
split topology, but some controller and runtime authority was derived from the healthy `agents-controllers` rollout
rather than from a fresh controller-process heartbeat. The status route correctly held `merge_ready` and `deploy_widen`,
kept `dispatch_normal` at `repair_only`, and allowed repair lanes.

That is better than a blind green light, but it is not yet a settled contract. A client can still choose the wrong
endpoint and conclude that serving health, rollout health, controller self-report, and action authority are the same
thing. They are not. The selected design makes endpoint parity a first-class evidence product: every material action
must cite a fresh parity receipt that reconciles `/health`, `/ready`, `/api/agents/control-plane/status`, deploy
verification, rollout evidence, and controller heartbeat or rollout-derived authority.

The tradeoff is stricter merge and deploy gates during split-topology transitions. I accept that. The six-month risk is
not that Jangar blocks one extra deploy for a few minutes. The risk is that downstream automation treats a serving OK as
permission to widen rollout or release Torghut capital while controller authority is only inferred.

## Runtime Objective And Success Metrics

This contract reduces failure modes by separating endpoint availability from action authority.

Success means:

- Jangar continues to serve read-only traffic when `/health` and `/ready` are reachable.
- `dispatch_repair` remains available when parity is degraded but repair evidence is fresh.
- `dispatch_normal`, `merge_ready`, `deploy_widen`, `paper_canary`, `live_micro_canary`, and `live_scale` require a
  current endpoint parity receipt.
- The parity receipt names every sampled endpoint, its observed status, its authority mode, and the reason it agrees or
  conflicts with the final action verdict.
- Rollout-derived controller authority is never silent. It emits `controller_rollout_substitute` until a heartbeat or
  ingestion self-report renews it.
- `/ready`, `/health`, the status route, post-deploy verification, and Torghut capital consumers cite the same parity
  epoch id during a deploy window.
- Deployer rollback can disable enforcement while leaving parity fields visible in shadow mode.

## Evidence Snapshot

All evidence was collected read-only. I did not mutate Kubernetes resources, database rows, GitOps state, broker state,
trading flags, or AgentRun records.

### Cluster, Rollout, And Event Evidence

- I bootstrapped an in-cluster kubeconfig from the service-account token because `kubectl config current-context` was
  unset. `kubectl auth whoami` identified the runtime as `system:serviceaccount:agents:agents-sa`.
- `kubectl get pods -n jangar -o wide` showed `bumba`, `jangar`, `jangar-alloy`, `jangar-db-1`, Redis, Open WebUI,
  `symphony`, and `symphony-jangar` all Running.
- The current Jangar serving pod was `jangar-74cd8d8fcd-rtjth`, age about ten minutes, using image
  `registry.ide-newton.ts.net/lab/jangar:1744b973@sha256:fe165d874349d309ae43fdeedd64934f0dde6cd748c92dade8992e86c2dfbaa3`.
- `kubectl get deploy -n jangar` reported `bumba`, `jangar`, `jangar-alloy`, `symphony`, and `symphony-jangar`
  available. The same combined command could not list StatefulSets or DaemonSets because this service account lacks
  those verbs in `jangar`.
- Jangar events showed two recent Jangar rollouts, including a short readiness probe failure while the new pod started.
  That is expected startup behavior, but it is useful evidence for deploy-verification timing.
- `kubectl get pods,deploy,cronjob,job -n agents` showed `agents=1/1`, `agents-controllers=2/2`,
  `agents-alloy=1/1`, current Jangar/Torghut scheduled runs, and older failed cron stage jobs from roughly four hours
  earlier.
- Current scheduled cron jobs had recovered in the latest windows, but failed historical jobs remained in the namespace.
  The parity ledger must carry both current freshness and unresolved historical debt instead of collapsing the state to
  healthy or failed.

### Endpoint Evidence

- `GET /health` returned `status=ok`, `service=jangar`, and `agentsController.enabled=false`,
  `agentsController.started=false`.
- `GET /ready` returned HTTP 200 and `status=ok`, with leader election healthy and serving runtime proof cells healthy,
  but execution trust degraded because `jangar-control-plane:verify` was stale.
- `GET /api/agents/control-plane/status` returned:
  - `execution_trust.status=degraded`
  - `execution_trust.reason="execution trust degraded: verify stage is stale"`
  - `database.status=healthy`
  - `database.migration_consistency.registered_count=28`
  - `database.migration_consistency.applied_count=28`
  - `watch_reliability.status=healthy`
  - `watch_reliability.total_errors=0`
  - `watch_reliability.total_restarts=0`
  - `agentrun_ingestion.status=unknown`
  - `agentrun_ingestion.message="agents controller not started"`
- The same status response produced action receipts that allowed `serve_readonly`, `dispatch_repair`, and
  `torghut_observe`, held `merge_ready` and `deploy_widen`, and blocked live capital classes.
- Controller authority in the status route was split: controller rows could be healthy by rollout substitution while
  `/health` and `/ready` still reported the serving process local controller disabled.

### Database And Data Evidence

- The status route reported the Jangar database configured, connected, and healthy with latest registered/applied
  migration `20260505_torghut_quant_pipeline_health_window_index`.
- Direct CNPG SQL was blocked from this runtime:
  `pods "jangar-db-1" is forbidden: User "system:serviceaccount:agents:agents-sa" cannot create resource "pods/exec"`
  in namespace `jangar`.
- Listing CNPG cluster resources was also blocked for this service account in `jangar` and `torghut`.
- Jangar memory data was reachable through the service route: `/api/memories/count` returned `575`; memory stats showed
  current write activity on `2026-05-07`.
- Torghut quant health was fresh: `/api/torghut/trading/control-plane/quant/health` reported metrics pipeline lag of
  `2` seconds and `4032` latest metrics.
- Torghut market-context health was degraded: bundle freshness was `215421` seconds, quality score `0.4575`, and
  technicals, fundamentals, news, and regime domains were stale.
- Torghut quant alerts still had `36` open alerts, including `23` critical `metrics_pipeline_lag_seconds` alerts and
  `12` `ta_freshness_seconds` alerts. Some current aggregate health is fresh while older strategy/account windows
  remain unresolved.

### Source Evidence

- `services/jangar/src/routes/ready.tsx` builds readiness from local process health, leader election, memory provider
  health, serving passport, and execution trust. It does not consume the full control-plane status parity model.
- `services/jangar/src/server/control-plane-status.ts` is the status aggregator. It builds heartbeat-derived
  controller state, then may substitute rollout-derived split-topology authority via
  `maybeUseSplitTopologyControllerRollout`.
- `services/jangar/src/server/control-plane-rollout-health.ts` explicitly marks rollout-derived authority with
  `mode='rollout'` and message `derived from healthy rollout for agents-controllers`.
- `services/jangar/src/server/control-plane-controller-witness.ts` already knows the split state and can decide
  `repair_only` with `controller_witness_split`.
- `services/jangar/src/server/__tests__/control-plane-status.test.ts` covers split-topology rollout substitution and
  verifies `dispatch_normal=repair_only` when controller witness splits.
- The missing test surface is endpoint parity: there is no single fixture that samples `/health`, `/ready`, status,
  deploy verification, and Torghut consumer gates to prove they all cite the same parity epoch.

## Problem

Jangar has endpoint reachability without endpoint parity.

The system currently exposes at least five evidence surfaces:

1. `/health`, which is lightweight serving health plus local controller state.
2. `/ready`, which includes serving passport and execution trust.
3. `/api/agents/control-plane/status`, which builds full material-action evidence and split-topology rollout
   substitution.
4. Post-deploy verification, which checks runtime proof cells and deployment watermarks.
5. Torghut capital consumers, which read selected Jangar receipts before observe, paper, or live action.

Each surface is useful. None should be allowed to override the others silently. A healthy serving endpoint means users
can use the product. It does not mean controller ingestion is current. A healthy rollout means a deployment has ready
replicas. It does not mean a controller process emitted a heartbeat. Healthy database migration consistency does not
mean direct operator SQL witness is available. Fresh quant metrics do not mean Torghut capital is safe.

The architecture needs a parity receipt that says which of those claims agree, which disagree, and which action classes
are allowed while the system repairs the disagreement.

## Alternatives Considered

### Option A: Make `/health` And `/ready` Stricter

Pros:

- Small implementation surface.
- Reduces the chance that clients overread a 200 response.
- Easy to validate with existing route tests.

Cons:

- Risks taking serving down during a controller split even when read-only service is safe.
- Still does not give deploy verification or Torghut a durable parity receipt.
- Pushes all nuance into endpoint status codes rather than action-class gates.

Decision: reject.

### Option B: Treat Rollout Health As Controller Authority

Pros:

- Works well for split topology when controller workloads are intentionally outside the serving process.
- Keeps status route green during controller deployment transitions.
- Already implemented in the current source.

Cons:

- A rollout is not a controller heartbeat.
- It can allow clients to miss ingestion self-report gaps.
- It does not explain why `/health` says controller disabled while the status route says controller healthy.

Decision: reject as the sole authority.

### Option C: Controller Authority Settlement And Endpoint Parity Ledger

Pros:

- Preserves read-only serving while preventing material actions from overreading serving health.
- Names rollout-derived authority as a substitute, not as a heartbeat.
- Gives deploy verification, merge readiness, and Torghut capital the same short-lived parity epoch.
- Turns endpoint disagreement into a repairable, testable receipt instead of a human interpretation problem.

Cons:

- Adds one reducer, one status field, and one deploy-verification gate.
- Requires keeping endpoint sampling cheap and bounded.
- May hold material actions during split-topology rollouts until heartbeat or ingestion evidence renews.

Decision: select Option C.

## Architecture

Jangar emits an endpoint parity ledger every status interval.

```text
endpoint_parity_ledger
  parity_epoch_id
  generated_at
  fresh_until
  producer_revision
  namespace
  service
  endpoint_receipts[]
  authority_receipts[]
  consumer_receipts[]
  parity_decision
  reason_codes[]
  action_effects[]
```

Endpoint receipts:

```text
endpoint_receipt
  endpoint_key                  # health, ready, status, deploy_verification, grpc, torghut_consumer
  observed_at
  status_code
  route_reachable
  serving_decision
  controller_enabled
  controller_started
  execution_trust_status
  database_status
  watch_reliability_status
  action_receipt_refs[]
  authority_mode                # local, heartbeat, rollout, route, deploy_verifier, consumer
  reason_codes[]
```

Authority settlement decisions:

- `allow`: endpoint claims agree and required authority is fresh.
- `allow_readonly`: serving and observe paths are safe, but material action must wait.
- `repair_only`: repair dispatch is allowed and normal dispatch is bounded.
- `hold_material`: merge, deploy widening, and capital gates must hold.
- `block`: serving or repair safety itself is broken.

Required reason codes:

- `endpoint_parity_missing`
- `endpoint_parity_degraded`
- `controller_rollout_substitute`
- `controller_process_heartbeat_missing`
- `controller_ingestion_unknown`
- `status_ready_disagreement`
- `deploy_verification_missing`
- `consumer_receipt_missing`
- `execution_trust_degraded`

## Material Action Effects

The endpoint parity ledger is additive to the existing controller witness, database witness, action clock, and material
verdict contracts.

- `serve_readonly`: allowed when `/health` or `/ready` can prove serving passport is not blocked.
- `dispatch_repair`: allowed when parity is degraded but repair evidence has bounded runtime and zero notional.
- `dispatch_normal`: `repair_only` when any endpoint needed for controller authority is split.
- `merge_ready`: hold unless `/ready`, status, deploy verification, database witness, and controller authority agree.
- `deploy_widen`: hold unless rollout and endpoint parity both agree for the new image digest.
- `torghut_observe`: allowed when consumer receipt can cite parity and max notional remains zero.
- `paper_canary`: hold unless parity, forecast, market-context, TCA, and paper settlement receipts are current.
- `live_micro_canary` and `live_scale`: block while parity is degraded or consumer evidence is missing.

## Implementation Scope

Engineer stage should implement this as a small pure reducer, not as new branching in `agents-controller` or
`supporting-primitives-controller`.

1. Add `control-plane-endpoint-parity.ts` beside the existing witness and verdict reducers.
2. Extend status types with `endpoint_parity_ledger` and `endpoint_parity_ref` on material action verdict epochs.
3. Build endpoint receipts from already available status inputs first; only add active route sampling where a route is
   not already evaluated.
4. Teach `/ready` and post-deploy verification to expose the current parity epoch id.
5. Add tests for:
   - `/health` ok, `/ready` ok, status degraded by execution trust;
   - rollout-derived controller authority without heartbeat;
   - stale verify stage holding merge/deploy while allowing repair;
   - Torghut consumer receipt missing keeping paper/live held;
   - disabled parity enforcement leaving shadow receipts visible.

## Validation Gates

Local validation:

- `bunx oxfmt --check services/jangar/src/server services/jangar/src/routes packages/scripts/src/jangar`
- `cd services/jangar && bun run test -- src/server/__tests__/control-plane-status.test.ts src/routes/ready.test.ts`
- `cd services/jangar && bunx tsc --noEmit --project tsconfig.paths.json`
- `bun run packages/scripts/src/jangar/verify-deployment.ts --skip-kubernetes --skip-runtime-proof` with a fixture
  that includes parity fields.

Post-deploy validation:

- `GET /health`, `GET /ready`, and `GET /api/agents/control-plane/status` all expose the same `parity_epoch_id`.
- A split-topology rollout emits `controller_rollout_substitute`, not silent `healthy`.
- `merge_ready` and `deploy_widen` remain held while parity is degraded.
- `dispatch_repair` remains available with bounded runtime.
- Torghut paper/live gates cite the parity receipt before any non-zero notional.

## Rollout

1. Ship the reducer in shadow mode and add the parity ledger to the status route.
2. Add the parity epoch to `/ready` without changing HTTP status behavior.
3. Add deploy-verification checks in warn-only mode.
4. Promote `merge_ready` and `deploy_widen` enforcement after one successful deploy window with matching endpoint
   receipts.
5. Promote Torghut paper/live enforcement only after the companion Torghut contract consumes the parity epoch.

## Rollback

- Disable enforcement with `JANGAR_ENDPOINT_PARITY_ENFORCEMENT=0`.
- Keep `endpoint_parity_ledger` visible in the status route for diagnosis.
- Keep `/health` and `/ready` serving behavior unchanged unless serving passport itself is blocked.
- Revert deploy-verification parity checks to warn-only.
- Force Torghut capital receipts to `hold` if parity receipts disappear.

## Risks

- Endpoint sampling can become expensive if it performs redundant route calls. The reducer should prefer already-built
  status inputs and add active probes only for missing surfaces.
- A strict first rollout can hold deploy widening longer than expected. Start in shadow and enforce only after one
  clean deploy window.
- Consumers may keep reading old fields. Mark parity as additive first, then make the absence of `parity_epoch_id` a
  material-action hold.
- Rollout-derived authority is valid but lower confidence than heartbeat authority. The ledger must make that visible
  without punishing intentional split topology.

## Handoff To Engineer

Build the endpoint parity reducer and wire it through status, readiness, deploy verification, and material verdicts.
The first implementation should be deterministic, fixture-heavy, and cheap. Do not add new privileges for database or
pod exec. Do not put the reducer inside the large controller files.

Acceptance gates:

- Status includes `endpoint_parity_ledger`.
- `/ready` includes the current parity epoch id.
- Split-topology rollout substitution emits `controller_rollout_substitute`.
- `merge_ready` and `deploy_widen` hold when `/health` or `/ready` disagree with status authority.
- Existing repair lanes remain open with zero notional.

## Handoff To Deployer

Deploy in shadow mode first. During the first deploy window, compare `/health`, `/ready`, status, and deploy
verification receipts. Do not widen rollout or clear merge/deploy gates until the same parity epoch is visible across
the required surfaces.

Rollback trigger:

- parity epoch missing from `/ready`;
- status route cannot build parity within latency budget;
- deploy verification cannot read parity;
- Torghut capital consumer receives stale or missing parity while any non-zero notional path is configured.
