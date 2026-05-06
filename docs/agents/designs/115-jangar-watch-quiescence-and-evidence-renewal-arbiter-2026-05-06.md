# 115. Jangar Watch Quiescence And Evidence Renewal Arbiter (2026-05-06)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-06
Owner: Victor Chen, Jangar Engineering Architecture
Scope: Jangar control-plane watch reliability, material-action admission, rollout widening, Torghut proof freshness,
and capital-safe repair scheduling.

Companion Torghut contract:

- `docs/torghut/design-system/v6/119-torghut-evidence-renewal-batches-and-capital-quiescence-gates-2026-05-06.md`

Extends:

- `113-jangar-contradiction-settlement-and-profit-repair-auction-2026-05-06.md`
- `114-jangar-evidence-transport-ledger-and-watch-restart-circuit-breakers-2026-05-06.md`
- `112-jangar-session-scoped-proof-settlement-and-stale-alert-netting-2026-05-06.md`
- `111-jangar-negative-evidence-router-and-action-slo-budgets-2026-05-06.md`

## Decision

I am selecting a **watch quiescence arbiter with evidence-renewal admission gates** as the next Jangar control-plane
architecture step.

The current system is not down. In the read-only sample at `2026-05-06T12:09Z`, `agents` and `jangar` were Argo
`Synced` and `Healthy` at revision `f15d5b1fd8be1e61c053bf9bdaeeace397d77ff3`, `deployment/agents` was `1/1`,
`deployment/agents-controllers` was `2/2`, and `deployment/jangar` was `1/1`. Jangar `/health`, Agents `/health`,
and Agents `/ready` returned HTTP `200`. The Jangar database projection was healthy, connected in `16 ms`, and showed
`28/28` Kysely migrations applied with latest migration `20260505_torghut_quant_pipeline_health_window_index`.

The current system is also not safe to widen. The same Jangar status payload reported watch reliability `degraded`:
`5` observed streams, `1745` events, `0` errors, and `1075` restarts in the 15-minute window. Dependency quorum returned
`decision=block` with `watch_reliability_blocked`. The Kubernetes event sample showed recent readiness timeouts and
HTTP `503` readiness failures for `agents` and `agents-controllers`, while runtime admission passports still allowed
`serving`, `swarm_plan`, `swarm_implement`, and `swarm_verify`.

That is a settlement gap. Existing contracts know how to report negative evidence, SLO budgets, and contradiction
settlement. They do not yet define the receipt that proves the watch fabric has stopped churning before Jangar widens a
rollout, declares a merge ready, or lets Torghut graduate capital. A restart storm with zero watch errors is not the
same failure as a lost watch stream, but both must hold material action until a fresh quiescence receipt exists.

The selected design creates a `watch_quiescence_epoch` for each control-plane watch stream and a global
`evidence_renewal_window` for action admission. Serving and bounded proof repair can continue under degraded watch
reliability. Dispatch normal, rollout widening, merge readiness, paper canaries, and live capital require a current
quiescence receipt plus renewed consumer evidence from Torghut.

The tradeoff is deliberate latency before material action after noisy relists or controller restarts. I accept that
because the six-month risk is not slow repair. It is promotion from a healthy HTTP surface while the evidence fabric is
too turbulent to prove that all relevant controllers have seen the same world.

## Evidence Snapshot

All cluster and database checks for this decision were read-only. No Kubernetes resources, database rows, broker topics,
trading flags, or Argo applications were mutated.

### Cluster And Rollout Evidence

- Runtime identity: `system:serviceaccount:agents:agents-sa`.
- Branch: `codex/swarm-jangar-control-plane-discover`, based on `main`.
- Argo CD reported:
  - `agents`: `Synced`, `Healthy`, revision `f15d5b1fd8be1e61c053bf9bdaeeace397d77ff3`.
  - `jangar`: `Synced`, `Healthy`, revision `f15d5b1fd8be1e61c053bf9bdaeeace397d77ff3`.
  - `torghut`: `OutOfSync`, `Healthy`, revision `f15d5b1fd8be1e61c053bf9bdaeeace397d77ff3`.
- `deployment/agents` was `1/1` available on image
  `registry.ide-newton.ts.net/lab/jangar-control-plane:856f5579@sha256:a296b3a8e23b3adeb87abb1882a1d2e26df40a98bd84c848130b457624ebda54`.
- `deployment/agents-controllers` was `2/2` available on image
  `registry.ide-newton.ts.net/lab/jangar:856f5579@sha256:ddcf27ec8bc22bdef4cc53309845452a6416236b8cd83d57185b7fb252cec45c`.
- `deployment/jangar` was `1/1` available on the same `856f5579` Jangar image digest.
- Pod phase samples showed retained execution debt in `agents`: `9` Running, `33` Error, and `153` Completed pods.
- The `jangar` namespace had `8` Running pods.
- The `torghut` namespace had `27` Running pods and `1` Completed pod.
- Recent `agents` events included readiness probe timeouts for `agents-8665748649-8zkrj` and
  `agents-controllers-69b9f9dd59-*`, including one HTTP `503` readiness failure.
- Recent `jangar` events showed the current Jangar pod started successfully after rollout, but also one startup
  readiness miss and Bumba readiness/liveness warnings.
- Recent `torghut` events showed sim rollout churn, readiness/startup probe misses, duplicate ClickHouse
  PodDisruptionBudget matches, and Keeper PDB `NoPods`.

### Database And Data Evidence

- Direct `kubectl cnpg psql` probes for `jangar-db` and `torghut-db` failed because the service account cannot create
  `pods/exec` in `jangar` or `torghut`. That is an expected RBAC boundary, so deployer validation must rely on
  service-owned projections unless the deployer has a higher-privilege read-only path.
- Jangar `/api/agents/control-plane/status?namespace=agents` reported database `configured=true`, `connected=true`,
  `status=healthy`, `latency_ms=16`, registered migrations `28`, applied migrations `28`, and no missing or unexpected
  migrations.
- Jangar watch reliability reported `status=degraded`, `window_minutes=15`, `observed_streams=5`, `total_events=1745`,
  `total_errors=0`, and `total_restarts=1075`.
- The highest restart streams were `agentruns.agents.proompteng.ai`, `versioncontrolproviders.agents.proompteng.ai`,
  `agentproviders.agents.proompteng.ai`, and `implementationsources.agents.proompteng.ai`.
- Jangar dependency quorum returned `decision=block`, `reasons=["watch_reliability_blocked"]`, and
  `degradation_scope=global`.
- Runtime admission passports still returned `allow` for serving and the three swarm stage classes.
- Torghut `/db-check` returned HTTP `200`, `ok=true`, `schema_current=true`, `schema_graph_lineage_ready=true`, and
  `account_scope_ready=true`.
- Torghut `/readyz` returned HTTP `503` with body `{"detail":"database unavailable"}`.
- Torghut `/trading/health` returned HTTP `503`; live submission was blocked by `simple_submit_disabled`, and quant
  evidence was informational because `quant_health_not_configured`.
- Torghut `/trading/autonomy` returned stale empirical jobs for `benchmark_parity`, `foundation_router_parity`,
  `janus_event_car`, and `janus_hgrm_reward`, all tied to `intraday_tsmom_v1@prod`.
- Jangar typed quant health for the live account returned HTTP `200`, `status=ok`, `latestMetricsCount=108`, and
  `metricsPipelineLagSeconds=67329`.
- Jangar typed quant health for `TORGHUT_SIM` returned HTTP `200`, `status=degraded`, `latestMetricsCount=0`, and
  `emptyLatestStoreAlarm=true`.
- Jangar market-context health for `AAPL` returned `overallState=down`; ClickHouse ingestion was unconfigured
  (`CH_HOST is not configured`), technicals and regime were `error`, and fundamentals/news were `missing`.
- Jangar quant alerts returned `199` open alerts: `105` critical and `94` warning.

### Source Evidence

- `services/jangar/src/server/control-plane-watch-reliability.ts` tracks watch events, errors, restarts, and
  per-stream top offenders, then degrades when errors exist or one stream crosses the restart threshold.
- `services/jangar/src/server/control-plane-workflows.ts` turns degraded watch reliability into
  `watch_reliability_blocked` when restart volume crosses the dependency-quorum threshold.
- `services/jangar/src/server/control-plane-negative-evidence-router.ts` already translates watch degradation into
  negative evidence and action SLO budget holds, but it does not define quiescence epochs or stable-after receipts.
- `services/jangar/src/server/control-plane-status.ts` composes database health, rollout health, watch reliability,
  execution trust, dependency quorum, runtime admission, and Torghut evidence into one status payload.
- `services/jangar/src/server/supporting-primitives-controller.ts` is still the largest Jangar control-plane risk
  surface at `2883` lines; it owns schedules, runner ConfigMaps, CronJobs, requirements, freezes, workspace state, and
  PVC lifecycle.
- `services/torghut/app/main.py` is still the largest Torghut service surface at `4051` lines.
- `services/torghut/app/trading/scheduler/pipeline.py` is `4349` lines and owns signal continuity, market-context
  observations, rejection accounting, LLM decision context, and order preparation.
- Focused tests exist for Jangar watch reliability, control-plane status, runtime admission, negative evidence routing,
  failure-domain leases, Torghut quant health, market context, DB checks, and submission-council quant health. The
  missing system-level test is watch quiescence gating across dependency quorum, action budgets, and Torghut capital
  admission.

## Problem

Jangar currently has three independently true signals:

1. The serving path is healthy and schema-current.
2. The watch fabric is unstable enough for dependency quorum to block material action.
3. Torghut proof surfaces are stale, partially unconfigured, or non-capital-grade even when some database/schema checks
   are green.

The existing negative evidence router can hold action, and the contradiction settlement contract can explain conflicts.
What is missing is a positive receipt that says the control-plane watch fabric has become quiet again after a restart
storm. Without that receipt, material action can oscillate between "HTTP healthy" and "dependency blocked" without a
specific recovery gate.

The failure mode is especially sharp for Torghut. Profit repair work needs to run while capital remains at zero. If
Jangar globally freezes every degraded watch window, it prevents the repairs that clear stale empirical jobs and quant
proof. If Jangar ignores watch churn because HTTP health is green, it can widen deployment or capital while the
controllers may not have converged on the same evidence.

## Alternatives Considered

### Option A: Raise The Watch Restart Threshold

Pros:

- Lowest implementation cost.
- Reduces noisy dependency-quorum blocks when watches relist frequently.
- Fits the current `control-plane-watch-reliability.ts` model.

Cons:

- Hides real restart storms instead of explaining them.
- Does not distinguish normal relist churn from controller instability or API pressure.
- Gives deployer and engineer stages no closure receipt.
- Does not connect watch recovery to Torghut proof renewal or capital admission.

Decision: reject. Threshold tuning can be a tactical follow-up, but it is not the architecture.

### Option B: Treat Any Watch Degradation As A Global Freeze

Pros:

- Conservative for deployment widening and capital.
- Simple to operationalize.
- Avoids false confidence during controller turbulence.

Cons:

- Blocks read-only repair dispatch when repair is the only path to clear stale proof.
- Treats zero-error restart churn the same as watch data loss.
- Leaves Jangar serving health and runtime admission passports hard to reconcile for operators.
- Reduces Torghut profitability by starving proof renewal work.

Decision: reject as the default posture. Keep it as emergency mode for unknown watch errors or lost controller
authority.

### Option C: Watch Quiescence Arbiter With Evidence-Renewal Gates

Pros:

- Converts restart storms into explicit quiescence epochs with stable-after receipts.
- Keeps serving and bounded repair available while holding material action.
- Gives rollout, merge, and capital gates a measurable recovery condition.
- Lets Torghut run zero-notional evidence-renewal batches while Jangar waits for watch stability.
- Reduces manual interpretation when HTTP readiness, runtime admission, dependency quorum, and Torghut proof disagree.

Cons:

- Adds a new control-plane projection and another receipt required by material actions.
- Requires careful restart-cause taxonomy so normal Kubernetes relists do not hold the system longer than needed.
- Needs paired Torghut renewal receipts before capital gates become fully useful.

Decision: select Option C.

## Architecture

Jangar adds a `watch_quiescence_epoch` projection.

```text
watch_quiescence_epoch
  epoch_id
  generated_at
  expires_at
  namespace
  stream_resource
  window_minutes
  event_count
  error_count
  restart_count
  last_event_at
  last_error_at
  last_restart_at
  stable_since
  quiescent_after
  restart_rate_per_minute
  cause_bucket              # normal_relist, controller_restart, api_pressure, transport_restart, unknown
  confidence                # high, medium, low
  decision                  # quiescent, warming, blocked, unknown
  evidence_refs
```

The global `evidence_renewal_window` is derived from the stream epochs, rollout health, dependency quorum, and consumer
evidence:

```text
evidence_renewal_window
  renewal_window_id
  generated_at
  expires_at
  action_class
  required_watch_epochs
  required_consumer_receipts
  decision                  # allow, hold, block
  blocked_reasons
  repair_allowed
  material_action_allowed
  rollback_target
```

Admission rules:

- `serve_readonly` remains `allow` when HTTP health and database projection are healthy, even while watch epochs are
  warming.
- `dispatch_repair` remains `allow` or `hold` with bounded runtime when the repair does not mutate GitOps, widen
  rollout, or submit capital.
- `dispatch_normal`, `merge_ready`, and `deploy_widen` require all required watch streams to be `quiescent` for the
  configured action window.
- `paper_canary`, `live_micro_canary`, and `live_scale` require watch quiescence plus a Torghut
  `evidence_renewal_batch` receipt.
- Any stream with watch errors, unknown cause, or no post-restart event remains `blocked` for material actions until a
  fresh event proves the watch path is alive again.

## Implementation Scope

Engineer stage:

1. Extend `ControlPlaneWatchReliabilityStream` with `last_restart_at`, `last_error_at`, `stable_since`,
   `restart_rate_per_minute`, and an initial `cause_bucket`.
2. Add a pure `buildWatchQuiescenceEpochs` reducer with unit tests for:
   - zero-error restart storms,
   - watch errors,
   - one-stream churn,
   - post-restart fresh events,
   - expired or unknown streams.
3. Feed quiescence epochs into `buildDependencyQuorumStatus` and `buildNegativeEvidenceRouterStatus`.
4. Add `evidence_renewal_window` fields to the status payload in shadow first.
5. Add action budget tests that prove serving and bounded repair stay open while deploy widening, merge readiness, and
   capital are held.
6. Add a cross-service fixture that combines Jangar watch churn with Torghut stale empirical jobs and quant alerts.

Deployer stage:

1. Roll out shadow-only status projection first.
2. Confirm the status payload includes quiescence epochs for all required watch streams.
3. Confirm a restart storm produces `material_action_allowed=false` and `repair_allowed=true`.
4. Confirm a quiet stability window flips material action only after the configured quiescence duration.
5. Enable enforcement for `deploy_widen` and `merge_ready` before enabling any Torghut capital gate.

## Validation Gates

- `bun run --cwd services/jangar test -- src/server/__tests__/control-plane-watch-reliability.test.ts`
- `bun run --cwd services/jangar test -- src/server/__tests__/control-plane-negative-evidence-router.test.ts`
- `bun run --cwd services/jangar test -- src/server/__tests__/control-plane-status.test.ts`
- `bunx oxfmt --check docs/agents/designs/115-jangar-watch-quiescence-and-evidence-renewal-arbiter-2026-05-06.md`
- Read-only cluster validation:
  - `curl http://agents.agents.svc.cluster.local/api/agents/control-plane/status?namespace=agents`
  - `kubectl get events -n agents --sort-by=.lastTimestamp`
  - `kubectl get application -n argocd agents jangar torghut -o json`

Promotion requires:

- Jangar database projection healthy and migration consistency healthy.
- Required watch streams have quiescent epochs.
- Dependency quorum is not blocked by watch reliability.
- No fresh controller readiness HTTP `503` event in the deployer-defined stability window.
- Torghut capital gates remain zero-notional until the companion renewal-batch receipt is present.

## Rollout And Rollback

Rollout:

1. Ship quiescence epochs as shadow-only status fields.
2. Add UI/status visibility and NATS handoff summaries.
3. Enforce on `deploy_widen` and `merge_ready`.
4. Enforce on Torghut `paper_canary`.
5. Enforce on live capital only after paper canary receipts prove the contract.

Rollback:

- Disable enforcement with a single feature flag and keep shadow projection visible.
- If status computation regresses Jangar readiness, revert the Jangar image/config GitOps PR and let Argo reconcile.
- If quiescence logic is too conservative, lower enforcement to `hold` for material action while keeping receipts for
  audit.
- Never bypass Torghut live capital with a manual override unless the override cites a fresh renewal batch and an
  explicit owner-approved rollback target.

## Risks

- Normal Kubernetes relists could be misclassified as instability. Mitigation: cause buckets start conservative, and
  enforcement is shadow-first.
- A long watch quiet window can slow deployer throughput. Mitigation: only material action waits; bounded repair and
  serving stay open.
- Torghut proof renewal could be starved if Jangar treats every repair dispatch as material. Mitigation:
  `dispatch_repair` gets a separate bounded budget with zero notional and no rollout mutation.
- Direct database verification is unavailable from the current service account. Mitigation: use service-owned DB
  projections for routine gates and have deployers run higher-privilege read-only CNPG checks when needed.

## Handoff Contract

Engineer acceptance gates:

- A fixture with `1075` watch restarts and zero errors produces quiescence `warming` or `blocked`, not material
  `allow`.
- Serving and repair budgets remain available in that fixture.
- `deploy_widen`, `merge_ready`, `paper_canary`, `live_micro_canary`, and `live_scale` are held until quiescence and
  renewal receipts are present.
- Tests cover restart threshold, error override, post-restart fresh event, and expired stream behavior.

Deployer acceptance gates:

- Shadow projection is visible in Jangar status before enforcement.
- Enforcement is staged by action class.
- Rollback is a GitOps revert or feature-flag disable, not a direct cluster mutation.
- The deployer records the active quiescence epoch ids in the release handoff before widening any Jangar rollout or
  approving Torghut capital.
