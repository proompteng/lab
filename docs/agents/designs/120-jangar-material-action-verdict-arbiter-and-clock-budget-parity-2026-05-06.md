# 120. Jangar Material Action Verdict Arbiter And Clock Budget Parity (2026-05-06)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-06
Owner: Victor Chen, Jangar Engineering Architecture
Scope: Jangar final action authority, dependency quorum, action SLO budgets, reconciled action clocks, Torghut
capital gates, rollout safety, and deployer acceptance gates.

Companion Torghut contract:

- `docs/torghut/design-system/v6/124-torghut-capital-action-verdict-consumer-and-profit-hypothesis-settlement-2026-05-06.md`

Extends:

- `119-jangar-empirical-proof-renewal-clearinghouse-and-capital-reentry-settlement-2026-05-06.md`
- `118-jangar-repair-admission-governor-and-profit-renewal-bids-2026-05-06.md`
- `111-jangar-negative-evidence-router-and-action-slo-budgets-2026-05-06.md`
- `100-jangar-lease-reconciliation-clock-and-dispatch-expiry-contract-2026-05-06.md`

## Decision

I am selecting a **material action verdict arbiter** as the next Jangar control-plane architecture step.

The reason is a live contradiction, not an abstract cleanliness concern. In the read-only sample at
`2026-05-06T14:25Z`, Jangar was serving and the key deployments were available: `deployment/jangar` was `1/1`,
`deployment/agents` was `1/1`, and `deployment/agents-controllers` was `2/2`. Jangar `/ready` returned HTTP `200`,
execution trust was healthy, database projection was healthy with `28/28` Kysely migrations applied, and watch
reliability was healthy over the sampled 15-minute window.

At the same time, Jangar dependency quorum returned `decision=block` for `empirical_jobs_degraded`. Action SLO budgets
correctly held `merge_ready`, held `paper_canary`, and blocked `live_micro_canary` and `live_scale` because Torghut
empirical jobs were stale. But the reconciled action clock for `merge_ready` still returned `decision=allow` because
its current inputs were database and source-schema leases, not the full action SLO budget. A deployer or route that
consumes the greener clock can reach the wrong conclusion while the dependency quorum is still blocked.

The selected design creates one final action verdict per action class. Dependency quorum, action SLO budgets,
reconciled action clocks, rollout health, database migration consistency, controller witness, watch reliability, and
Torghut empirical state become inputs. Consumers no longer bind to those partial surfaces for material decisions.

The tradeoff is another reducer and one more parity requirement. I accept that. Jangar has accumulated useful safety
surfaces; the six-month risk is that they disagree under pressure and consumers choose whichever surface is easiest to
call. The architecture needs one authority boundary that makes contradiction impossible to ignore.

## Evidence Snapshot

All checks for this decision were read-only. I did not mutate Kubernetes resources, database records, trading flags,
Argo applications, broker state, or GitHub records.

### Cluster And Rollout Evidence

- Runtime Kubernetes identity was `system:serviceaccount:agents:agents-sa`.
- `kubectl config current-context` was unset, then the local in-cluster context was created from the service-account
  token for read-only checks.
- `deployment/jangar`, `deployment/bumba`, `deployment/jangar-alloy`, `deployment/symphony`, and
  `deployment/symphony-jangar` were available in namespace `jangar`.
- `deployment/agents` was `1/1` and `deployment/agents-controllers` was `2/2` in namespace `agents`.
- The agents namespace still carried retained execution debt: `36` Failed pods, `9` Running pods, and `176`
  Succeeded pods in the sampled count.
- Recent agents events showed one `Evicted` cleanup pod because node ephemeral storage was below threshold, and
  readiness probe `503` events on older `agents-controllers` pods during rollout replacement.
- Argo CD reported `jangar` and `agents` as `Synced` and `Healthy`; `torghut` was `OutOfSync` but `Healthy`.
- Torghut live revision `torghut-00238` and sim revision `torghut-sim-00329` were running. Recent Torghut events showed
  the previous `torghut-ta-sim` image pull and crash-loop debt had recovered to a running Flink deployment, but also
  showed transient startup/readiness probe failures during repair.

### Database, Data, And Freshness Evidence

- Direct `kubectl cnpg psql` against `jangar-db` and `torghut-db` failed because this service account cannot create
  `pods/exec` in those namespaces. That is the expected least-privilege boundary for this lane.
- Jangar `/api/agents/control-plane/status` reported database `configured=true`, `connected=true`, `status=healthy`,
  `latency_ms=4`, registered migrations `28`, applied migrations `28`, and no missing or unexpected migrations.
- Jangar dependency quorum returned `decision=block` with reason `empirical_jobs_degraded`.
- Jangar empirical services reported `forecast.status=degraded` with `registry_empty`, `lean.status=disabled`, and
  stale empirical jobs `benchmark_parity`, `foundation_router_parity`, `janus_event_car`, and `janus_hgrm_reward`.
- Jangar action SLO budgets returned:
  - `merge_ready`: `hold` for `empirical_jobs_degraded`;
  - `paper_canary`: `hold` for `empirical_jobs_degraded` and `empirical_jobs_stale`;
  - `live_micro_canary`: `block` for stale empirical proof;
  - `live_scale`: `block` for stale empirical proof and missing paper settlement.
- Jangar reconciled action clocks returned `merge_ready=allow` in the same sample.
- Torghut `/readyz` returned HTTP `503` with scheduler, Postgres, ClickHouse, Alpaca, database schema, and Jangar
  universe healthy, but `live_submission_gate.allowed=false` for `simple_submit_disabled` in `capital_stage=shadow`.
- Torghut database projection was current at Alembic head `0029_whitepaper_embedding_dimension_4096`, with known
  historical migration parent-fork warnings but `schema_graph_lineage_ready=true`.
- Torghut `/trading/status` reported `3` hypotheses, `0` promotion eligible, `3` rollback required, and dependency
  quorum `block`.
- Jangar typed quant health for `account=paper&window=1d` returned `status=degraded`,
  `latestMetricsUpdatedAt=null`, `latestMetricsCount=0`, and `emptyLatestStoreAlarm=true`.

### Source Evidence

- `services/jangar/src/server/control-plane-status.ts` is `753` lines and composes controller health, database status,
  rollout health, watch reliability, workflow freshness, empirical services, failure-domain leases, action clocks,
  negative evidence, runtime admission, and controller witness receipts.
- `services/jangar/src/server/control-plane-negative-evidence-router.ts` is `610` lines and already maps stale
  empirical jobs, Torghut readiness, watch debt, workflow failures, rollout ambiguity, and data freshness debt into
  action SLO budgets.
- `services/jangar/src/server/control-plane-action-clock.ts` is `276` lines and reconciles positive and negative
  leases into action clocks, but it does not currently treat action SLO budgets as mandatory inputs.
- `services/jangar/src/server/supporting-primitives-controller.ts` remains the largest Jangar control-plane module at
  `2883` lines and owns schedule runners, runner ConfigMaps, CronJobs, workspace state, PVC lifecycle, requirements,
  freezes, and swarm admission.
- `services/jangar/src/server/primitives-kube.ts` now includes `PersistentVolumeClaim` aliases, so the older PVC
  primitive gap has been reduced; the remaining high-risk seam is cross-surface action authority.
- `services/torghut/app/trading/submission_council.py` is `1196` lines and already builds live submission gates from
  dependency quorum, empirical readiness, hypothesis runtime state, quant health, and capital stage.
- Focused tests exist for control-plane status, action clocks, negative evidence routing, empirical services, watch
  reliability, primitives, supporting schedule runners, Torghut empirical jobs, and submission council behavior. The
  missing regression is parity: a material action must not be allowed by any consumer when any authoritative input
  blocks or holds the same action class.

## Problem

Jangar has moved from missing safety signals to inconsistent safety interpretation.

The current model has at least four useful surfaces:

1. dependency quorum says whether the control plane can trust critical dependencies;
2. negative evidence and action SLO budgets say which action classes are allowed, held, repaired, or blocked;
3. reconciled action clocks say whether the current leases support action timing;
4. Torghut readiness and submission gates say whether trading capital can leave shadow.

Each surface is valuable. None should be individually consumable for a material action. If `merge_ready`, paper
capital, live micro-canary, or deploy widening can bind to a subset, the system reintroduces route-local authority by
another name.

The live contradiction proves the point. `merge_ready` cannot be both held for stale empirical proof and allowed by a
clock in a way that deployers have to interpret manually. That disagreement must become a first-class `contradicted`
or `hold` final verdict with evidence refs.

## Alternatives Considered

### Option A: Document Consumer Precedence Rules Only

Write a runbook that tells humans to prefer action SLO budgets over action clocks when they disagree.

Pros:

- Fastest path.
- No new runtime reducer.
- Preserves the existing status payload shape.

Cons:

- Does not protect automated consumers.
- Keeps the contradiction live in the API.
- Requires every engineer and deployer to remember precedence during incidents.
- Does not create testable parity gates.

Decision: reject. This is a control-plane authority problem, not a documentation-only problem.

### Option B: Make Action SLO Budgets Replace Reconciled Action Clocks

Delete or demote action clocks and use the negative-evidence router as the only action authority.

Pros:

- Smaller authority surface.
- Removes the current `merge_ready` contradiction directly.
- Keeps capital and merge blocks close to the evidence that created them.

Cons:

- Loses useful lease timing semantics from action clocks.
- Makes deploy widening and dispatch timing less explainable.
- Couples every future timing lease directly into the negative-evidence router.
- Forces a bigger refactor than needed before the next repair cycle.

Decision: reject. The clocks are useful, but they need to be inputs, not final authority.

### Option C: Material Action Verdict Arbiter

Add a reducer that consumes dependency quorum, action SLO budgets, action clocks, rollout health, controller witness,
database schema, watch reliability, and Torghut capital state, then emits one final verdict per material action class.

Pros:

- Preserves existing collectors and reducers.
- Gives every consumer one final action authority.
- Makes contradictions explicit and fail-closed.
- Provides a narrow implementation path and strong regression tests.
- Lets future proof-renewal and capital-settlement designs plug into one final verdict surface.

Cons:

- Adds another module and schema projection.
- Requires dual-read rollout until consumers migrate.
- Requires careful naming so operators understand which surface is final.

Decision: select Option C.

## Architecture

Jangar adds a `material_action_verdict_epoch` projection.

```text
material_action_verdict_epoch
  epoch_id
  generated_at
  expires_at
  namespace
  producer_revision
  dependency_quorum_ref
  negative_evidence_router_epoch_ref
  action_slo_budget_refs
  action_clock_refs
  rollout_health_ref
  controller_witness_ref
  watch_reliability_ref
  database_projection_ref
  empirical_services_ref
  torghut_capital_ref
  contradiction_refs
  final_verdicts
  enforcement_mode                  # shadow, warn, enforce
```

Each action class receives a `material_action_verdict`.

```text
material_action_verdict
  verdict_id
  epoch_id
  action_class                      # serve_readonly, dispatch_repair, dispatch_normal, deploy_widen,
                                    # merge_ready, paper_canary, live_micro_canary, live_scale
  decision                          # allow, repair_only, hold, block, contradicted, unknown
  decision_rank
  confidence                        # high, medium, low, unknown
  allowed_until
  max_dispatches
  max_runtime_seconds
  max_notional
  blocking_reason_codes
  downgrade_reason_codes
  required_repair_actions
  rollback_target
  evidence_refs
```

The decision lattice is intentionally conservative:

```text
block > contradicted > hold > repair_only > allow > unknown
```

`unknown` is not greener than `allow`; it means the action is not enforceable for material paths until the missing
input is repaired. Read-only serving may remain `allow` when a noncritical input is unknown, but merge, paper, and live
capital must fail closed.

## Reducer Rules

The arbiter follows five rules:

1. Dependency quorum block holds or blocks every material action except `serve_readonly`, `dispatch_repair`, and
   explicitly permitted `torghut_observe`.
2. Action SLO budget decisions are mandatory lower bounds. A clock cannot upgrade a budget hold or block.
3. Reconciled action clocks may further downgrade a budget, but never upgrade it.
4. Contradictions become `contradicted` unless the stricter input is already `block`.
5. Torghut capital gates cannot move out of shadow unless both Jangar final verdict and Torghut local submission gate
   allow the same account, window, hypothesis, and action class.

In the current evidence, the arbiter would produce:

- `serve_readonly=allow`;
- `dispatch_repair=allow`;
- `dispatch_normal=repair_only` while controller witness is split;
- `deploy_widen=allow` only for zero-notional deploy safety, not merge approval;
- `merge_ready=hold` because the SLO budget holds it for `empirical_jobs_degraded`;
- `paper_canary=hold`;
- `live_micro_canary=block`;
- `live_scale=block`;
- a contradiction record because the `merge_ready` clock says `allow` while the budget says `hold`.

## Consumer Contract

The following consumers must read only the material action verdict for material decisions:

- Jangar `/api/agents/control-plane/status` projects the full epoch and marks partial surfaces as inputs.
- Jangar `/ready` includes the verdict epoch id, digest, and the final decisions for `serve_readonly` and
  `dispatch_normal`.
- `packages/scripts/src/jangar/verify-deployment.ts` records the verdict epoch and fails merge/deploy widening when the
  final verdict is `hold`, `block`, `contradicted`, or `unknown`.
- GitHub merge actions in Jangar must require `merge_ready=allow`.
- Torghut submission and paper/live canary flows must require the matching Torghut companion contract.

Partial surfaces remain visible for diagnosis. They are not final authority.

## Implementation Scope

Engineer stage:

1. Add `services/jangar/src/server/control-plane-material-action-verdict.ts`.
2. Feed it from `control-plane-status.ts` after dependency quorum, negative evidence, action clocks, rollout health,
   controller witness, database, watch reliability, and empirical services are resolved.
3. Add a `material_action_verdicts` field to the status payload types and UI data model.
4. Add route tests proving the current fixture with SLO `merge_ready=hold` and clock `merge_ready=allow` produces final
   `merge_ready=hold` plus a contradiction ref.
5. Add a deploy-verifier fixture proving the verifier consumes the final verdict, not the partial clock.

Deployer stage:

1. Roll out in `shadow` mode and compare final verdicts against existing budgets and clocks for at least one full
   Jangar scheduling cycle.
2. Move `merge_ready`, `paper_canary`, `live_micro_canary`, and `live_scale` to `enforce` only after parity tests and
   shadow telemetry show no unexpected upgrades.
3. Keep `serve_readonly` and `dispatch_repair` permissive unless the database, route, or watch fabric is unknown.

No destructive data migration is required. If persistence is needed, add only additive Kysely tables with TTL cleanup.

## Validation Gates

Local validation before merge:

- `bun run --cwd services/jangar test -- src/server/__tests__/control-plane-material-action-verdict.test.ts`
- `bun run --cwd services/jangar test -- src/server/__tests__/control-plane-status.test.ts`
- `bun run --cwd services/jangar test -- src/routes/ready.test.ts`
- `bun run --cwd services/jangar check:module-sizes`
- `bun run --cwd services/jangar lint`

Runtime validation after rollout:

- `curl -fsS http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status` shows a
  `material_action_verdict_epoch`.
- In the current stale empirical-proof state, final `merge_ready` is not `allow`.
- The payload includes a contradiction ref when any action clock is greener than the action SLO budget.
- `curl -fsS http://jangar.jangar.svc.cluster.local/ready` includes the same verdict epoch digest as the status route.
- `gh pr checks <release-pr> --watch -R proompteng/lab` is green before any merge.

## Rollout Plan

1. Shadow emit the verdict epoch in status routes without enforcing it.
2. Add UI labels that distinguish final verdicts from diagnostic inputs.
3. Enforce final verdicts for GitHub merge actions and deploy verification.
4. Enforce final verdicts for Torghut paper and live capital gates after the companion Torghut consumer is deployed.
5. Retire any direct consumer binding to action clocks for material action decisions.

## Rollback Plan

Rollback is a configuration and code revert, not a database restore.

- If verdict generation fails, keep existing status payloads and disable verdict enforcement with an env flag.
- If verdicts are too conservative, revert only enforcement while keeping shadow emission for debugging.
- If verdicts are too permissive, immediately force `enforcement_mode=shadow` or revert the PR, then open a follow-up
  fix before re-enabling merge or capital gates.
- Any additive tables can remain in place until a later cleanup migration; do not drop them during incident response.

## Risks

- Operators may initially confuse partial clocks with final verdicts. UI and route naming must be explicit.
- The arbiter can become another large module if it absorbs collector logic. It must stay a pure reducer.
- A fail-closed merge gate can slow releases when stale Torghut proof is unrelated to a Jangar-only docs change. The
  design allows action-class scoping, but engineers must implement that scoping deliberately.
- Shadow telemetry may reveal old consumers still reading partial surfaces. Treat that as a blocker before enforcement.

## Handoff

Engineer acceptance gates:

- A fixture with dependency quorum `block`, SLO `merge_ready=hold`, and clock `merge_ready=allow` returns final
  `merge_ready=hold`.
- A fixture with SLO `paper_canary=hold` and clock allow returns final `paper_canary=hold`.
- A fixture with any `live_*` action and stale empirical jobs returns `block`.
- Status and ready routes share one verdict epoch digest.
- Module size guard still passes.

Deployer acceptance gates:

- Shadow mode runs for one scheduling cycle with verdict emission healthy.
- Required CI is green before PR merge and post-deploy verify is green before widening enforcement.
- In the live stale empirical-proof state, no merge or capital gate reports final `allow`.
- Rollback is documented in the release handoff with the exact env flag or revert PR path.

## Implementation Note: Shadow Verdict Projection (2026-05-06)

The first engineer slice adds `services/jangar/src/server/control-plane-material-action-verdict.ts` and emits
`material_action_verdict_epoch` plus flattened `material_action_verdicts` from `/api/agents/control-plane/status`.
The pure shadow reducer consumes the existing status inputs, keeps action SLO budgets as mandatory lower bounds, records
contradiction refs when clocks are greener than budgets, and maps paper/live actions through the diagnostic
`torghut_capital` clock without letting that clock upgrade stricter budgets or dependency quorum.

Activation receipts now cite the verdict epoch in `transport_contract_refs` and derive decision, caps, repairs, and
rollback target from the final verdict when present. Enforcement remains unchanged; rollback is to ignore the verdict
fields or revert the status/receipt wiring while keeping existing dependency quorum, failure-domain lease, action-SLO,
and controller-witness surfaces visible.
