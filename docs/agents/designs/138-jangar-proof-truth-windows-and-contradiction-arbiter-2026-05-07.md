# 138. Jangar Proof Truth Windows And Contradiction Arbiter (2026-05-07)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-07
Owner: Gideon Park, Torghut Traders Architecture
Scope: Jangar control-plane resilience, contradiction arbitration, least-privilege evidence custody, material-action
admission, Torghut capital handoff, validation, rollout, and rollback.

Companion Torghut contract:

- `docs/torghut/design-system/v6/142-torghut-alpha-truth-windows-and-capital-reentry-warrants-2026-05-07.md`

Extends:

- `137-jangar-watch-debt-clearing-and-profit-repair-leases-2026-05-07.md`
- `136-jangar-verification-trust-escrow-and-query-budgeted-evidence-settlement-2026-05-07.md`
- `135-jangar-database-witness-and-schema-authority-exchange-2026-05-07.md`
- `120-jangar-material-action-verdict-arbiter-and-clock-budget-parity-2026-05-06.md`

## Decision

I am selecting **proof truth windows with a contradiction arbiter** as the next Jangar control-plane architecture step.

The current cluster is not in the same failure mode as the earlier discover soak. Jangar is serving, `/ready` reports
healthy execution trust, the collaboration runtime kit proves `codex-nats-publish`, `codex-nats-soak`, `nats`,
workspace, and `NATS_URL` are present, and `agents-controllers` is now `2/2` ready. That is real improvement. It is
also not enough to give downstream material actions or Torghut capital a clean answer.

The contradictions are the point:

- Jangar control-plane status reports healthy controller rollouts and healthy workflow/job adapters, while Jangar logs
  still show Kubernetes watch `429` failures and GitHub review ingest failures for deleted branch refs.
- Material-action verdicts allow read-only service and bounded repair, but `dispatch_normal` remains `repair_only`
  because the controller witness is split.
- Paper and live Torghut action classes are still held or blocked because forecast proof is degraded, Torghut consumer
  evidence is missing, and paper settlement is required.
- Torghut global quant health is fresh, but scoped account/window health for `PA3SX7FYNUTF` is degraded because
  ingestion lag is roughly `55,645s`.
- Torghut DB schema is current through `/db-check`, but this worker cannot use direct CNPG SQL or pod exec; production
  validation cannot depend on privileged inspection as the normal path.

The selected design makes Jangar publish a small proof truth window per namespace and action class. The window does not
hide contradictions behind a single green or red bit. It records which witnesses agree, which witnesses conflict, which
witnesses are inaccessible under least privilege, and which material actions are allowed, held, repair-only, or blocked.

The tradeoff is that some routes that look healthy will no longer be allowed to stand alone as action authority. I accept
that. For the next six months the larger risk is not an extra receipt. The risk is letting a green aggregate route
override a stale scoped proof, a split controller witness, or a missing Torghut capital receipt.

## Runtime Objective And Success Metrics

This contract increases Jangar resilience by reducing four failure modes:

- **Aggregate-green drift:** a global route is healthy while scoped evidence is stale or contradictory.
- **Privileged-witness dependency:** deployer validation requires SQL exec, secrets, or pod exec that normal agents do
  not have.
- **Action-class ambiguity:** read-only serving, repair dispatch, normal dispatch, deploy widening, paper canary, and
  live capital all consume the same broad dependency signal.
- **Contradiction loss:** the status surface shows a final decision but drops the disagreement that explains what to
  repair next.

Success means:

- `/ready` and `/api/agents/control-plane/status?namespace=agents` expose one current `proof_truth_window`.
- Every material-action verdict cites the active proof truth window and at least one action-class effect from it.
- A route-level green signal can only upgrade `serve_readonly` or `observe` unless scoped proof agrees.
- A direct SQL or pod-exec denial becomes `witness_access_limited`, not an unknown hole in the evidence story.
- `dispatch_repair` remains possible with zero Torghut notional when the window names a bounded repair that can retire
  one contradiction.
- `deploy_widen`, `merge_ready`, `paper_canary`, `live_micro_canary`, and `live_scale` require contradiction-free truth
  windows for their action class.
- Operators and deployers can validate the window with bounded HTTP and permitted Kubernetes reads, not manual DB exec.

Initial SLOs:

- Proof truth window freshness: generated every status refresh; stale after `2m`.
- Route budget: `/ready` p95 under `1s`; control-plane status p95 under `2s` when reading settled windows.
- Contradiction retention: at least the last `20` window contradictions remain visible by id for audit.
- Action-class safety: no action with notional above `0` may cite a window that contains an unresolved capital
  contradiction.

## Evidence Snapshot

All evidence was collected read-only. I did not mutate Kubernetes resources, database records, GitOps state, broker
state, trading flags, AgentRuns, or empirical artifacts.

### Cluster And Rollout Evidence

- Local kube context was bootstrapped from the in-cluster service-account token. `kubectl auth whoami` identified
  `system:serviceaccount:agents:agents-sa`.
- `kubectl get pods,deploy,job,cronjob,svc -n jangar` showed `deployment/jangar` `1/1` available on image
  `registry.ide-newton.ts.net/lab/jangar:885368c6@sha256:209c72e339afc54ee854a24f62d4941480931f23ae0ed5cb31fd1d9fec19ed06`.
- Jangar events showed recent rollout readiness refusals during startup and repeated `NoPods` events for an
  Elasticsearch PDB with no matching pods.
- `kubectl get deployment -n agents agents agents-controllers` showed `agents=1/1` and `agents-controllers=2/2`.
- Agents namespace events still included recent `/ready` timeouts for `agents`, `/ready` timeouts for both controller
  pods, and an earlier liveness restart on `agents-controllers`.
- Torghut live and sim Knative deployments were both `1/1` on Torghut build
  `315dde4b8581598309238c2989b95451a167c110`; old revisions were scaled to `0/0`.
- This worker cannot list StatefulSets, PDBs, HPAs, CNPG cluster CRs, ClickHouse installation CRs, secrets, or create
  pod exec in the assessed namespaces. That access boundary is part of the architecture input.

### Runtime Route Evidence

- `GET /ready` returned `status=ok`, healthy leader election, healthy execution trust, and healthy runtime kits.
- `GET /api/agents/control-plane/status?namespace=agents` returned healthy controllers, healthy workflow/job runtime
  adapters, Temporal configured, dependency quorum `allow`, and empirical jobs healthy.
- The same status payload still projected `dispatch_normal` as `repair_only` due to `controller_witness_split`.
- `paper_canary` and `live_micro_canary` were `hold` with `forecast_service_degraded` and
  `torghut_consumer_evidence_missing`; `live_scale` was `block` with `paper_settlement_required`.
- Jangar logs showed watch failures with Kubernetes `Too Many Requests` and repeated GitHub review snapshot refresh
  failures for missing refs such as `codex/swarm-jangar-control-plane`.
- `GET /api/torghut/trading/control-plane/quant/health` returned global `status=ok`, `latestMetricsCount=4032`, and
  `metricsPipelineLagSeconds=0`.
- The scoped route for account `PA3SX7FYNUTF` and `window=15m` returned `status=degraded`, `latestMetricsCount=144`,
  and an ingestion stage with `ok=false` and `lagSeconds=55645`.

### Database And Data Evidence

- Torghut `/db-check` returned `ok=true`, `schema_current=true`, current and expected Alembic head
  `0029_whitepaper_embedding_dimension_4096`, and schema lineage ready with known parent-fork warnings.
- Direct CNPG SQL failed with:
  `pods "torghut-db-1" is forbidden: User "system:serviceaccount:agents:agents-sa" cannot create resource "pods/exec"`.
- Pod exec into the live Torghut service failed with the same `pods/exec` RBAC denial, and secret listing in `torghut`
  was forbidden.
- Torghut `/trading/profitability/runtime` reported a 72-hour window with `25` decisions, `0` executions, and `0` TCA
  samples.
- Torghut `/trading/tca?limit=5` reported `13,775` historical TCA rows, but `last_computed_at` was
  `2026-04-02T20:59:45Z`.
- Torghut `/trading/completion/doc29` reported `9` gates: `1` satisfied, `2` stale, and `6` blocked.
- Empirical jobs were healthy and authoritative for `chip-paper-microbar-composite@execution-proof`, but that proof
  does not settle the blocked full-day simulation, paper, live canary, and live scale gates.

### Source Evidence

- `services/jangar/src/data/agents-control-plane.ts` already models material-action verdicts, controller witness
  decisions, action SLO budgets, and runtime-kit projections.
- `services/jangar/src/routes/api/agents/control-plane/status.ts` is the route boundary that should read the settled
  proof truth window.
- `services/jangar/src/routes/api/torghut/trading/control-plane/quant/health.ts` already distinguishes global health
  from scoped account/window health; the contradiction is visible but not yet action-class settled.
- `services/torghut/app/main.py` composes `/db-check`, `/trading/status`, `/trading/health`,
  `/trading/profitability/runtime`, `/trading/tca`, and doc29 completion evidence.
- `services/torghut/app/trading/proof_floor.py` already maps stale TCA and submission gate failures into a repair-only
  proof floor.
- The high-risk source shape is aggregation breadth: Jangar and Torghut already have many correct local reducers, but
  no one receipt tells deployers when those reducers disagree and what action class must inherit the stricter result.

## Problem

Jangar can now produce many useful health and custody signals, but it cannot yet arbitrate their contradictions in a
single action-class window.

That matters because the system is no longer failing as a simple outage. A simple outage is easy to hold. The current
state is harder:

1. The platform can be healthy enough to serve while still unsafe for normal dispatch.
2. The global quant latest store can be fresh while a scoped account/window ingestion stage is stale.
3. The schema can be current while direct DB validation is intentionally inaccessible to the runtime worker.
4. Empirical jobs can be fresh while the proof floor is still zero-notional.
5. Material-action verdicts can be correct, but the evidence disagreement behind them is spread across multiple
   endpoints and logs.

The architecture needs one place to answer: what is true enough for this action class, what contradicts it, what witness
was unavailable, and what bounded repair would clear the contradiction?

## Alternatives Considered

### Option A: Trust The Healthiest Aggregate Route

This option lets `/ready` and the top-level control-plane status decide action admission when they are green.

Pros:

- Fastest to implement.
- Good operator ergonomics during normal serving.
- Keeps current payload consumers mostly unchanged.

Cons:

- Global green signals can hide scoped account/window debt.
- A healthy rollout is not proof that every controller witness and consumer receipt is current.
- Torghut capital could be inferred from a control-plane green route even while TCA, forecast, and doc29 gates are
  still blocked.

Decision: reject.

### Option B: Require Privileged SQL And Pod Exec For Merge Or Capital

This option makes deployer-stage SQL and pod exec evidence mandatory before merge, paper, or live action.

Pros:

- Can answer row-count and freshness questions directly.
- Useful during incident forensics.
- Keeps service endpoints smaller.

Cons:

- Violates least-privilege operation for normal workers.
- Reintroduces manual validation as a production dependency.
- Does not help Jangar choose action effects while privileged access is absent.

Decision: reject as the normal architecture. Privileged SQL remains an emergency or deployer-deep-dive path.

### Option C: Proof Truth Windows With Contradiction Arbitration

This option creates a settled window that records witness agreement, contradictions, witness-access limits, and
action-class effects. Material actions consume the window, not the healthiest individual route.

Pros:

- Preserves read-only serving while holding unsafe material action.
- Makes least-privilege validation first class.
- Turns route disagreement into named repair work.
- Gives Torghut a compact upstream warrant input rather than a large status payload to reinterpret.
- Avoids route-time scans over hot proof tables.

Cons:

- Adds one reducer and one payload family.
- Requires test fixtures for contradiction precedence.
- May hold paper or deploy widening when a human could manually inspect privileged evidence and decide faster.

Decision: select Option C.

## Architecture

Jangar emits one proof truth window per namespace and refresh window.

```text
proof_truth_window
  window_id
  namespace
  generated_at
  fresh_until
  producer_revision
  witness_access[]
  witness_facts[]
  contradictions[]
  action_effects[]
  torghut_capital_summary
  validation_budget
```

Witness access records whether the runtime can validate a family through a permitted surface.

```text
witness_access
  witness_family              # rollout, controller, route, database, quant, torghut_status, torghut_profit
  access_mode                 # permitted_route, permitted_kube_read, privileged_denied, skipped
  source_ref
  observed_at
  reason_codes
```

Witness facts are normalized so a route can be healthy without becoming universal authority.

```text
witness_fact
  fact_id
  family
  scope                       # global, namespace, account_window, action_class, hypothesis
  state                       # healthy, degraded, stale, missing, blocked
  confidence                  # high, medium, low
  evidence_ref
  fresh_until
  action_classes[]
```

Contradictions are durable and action scoped.

```text
proof_contradiction
  contradiction_id
  scope
  stronger_fact_ref
  weaker_fact_ref
  action_class
  effect                      # no_effect, observe_only, repair_only, hold, block
  repair_action
  reason_codes[]
```

Action effects are the only part material-action verdicts may use for admission.

```text
proof_truth_action_effect
  action_class                # serve_readonly, dispatch_repair, dispatch_normal, deploy_widen, merge_ready,
                              # torghut_observe, paper_canary, live_micro_canary, live_scale
  decision                    # allow, observe_only, repair_only, hold, block
  max_notional
  max_dispatches
  required_clean_windows
  blocking_contradiction_refs[]
  repair_refs[]
```

Precedence rules:

1. A scoped contradiction beats a global green route for the same action class.
2. A privileged witness denial cannot block read-only serving by itself, but it prevents paper/live capital unless a
   service-owned receipt covers the same fact.
3. Fresh empirical jobs can create repair priority; they cannot override stale TCA, missing paper settlement, or scoped
   quant ingestion debt.
4. `serve_readonly` and `torghut_observe` can allow under contradiction if no notional changes.
5. `dispatch_repair` can allow only with zero notional and a named repair action.
6. `deploy_widen`, `merge_ready`, `paper_canary`, `live_micro_canary`, and `live_scale` require no unresolved
   contradictions for their action class.

## Implementation Scope

Engineer stage should implement this in Jangar without moving policy into the largest reconcilers.

- Add a small server reducer, tentatively `services/jangar/src/server/control-plane-proof-truth-window.ts`.
- Feed it from existing rollout health, controller witness, watch debt, runtime kit, execution trust, material-action,
  quant health, empirical service, and Torghut status summaries.
- Add `proof_truth_window` to `/api/agents/control-plane/status?namespace=agents`.
- Add a compact `proof_truth_window_ref` and worst action-class effect to `/ready`.
- Make material-action verdict generation cite the current window and inherit stricter action effects.
- Keep route-time database work bounded. The reducer reads settled facts and service-owned endpoints, not raw hot proof
  tables.
- Add fixtures for:
  - global quant green plus scoped account/window degraded;
  - `/ready` healthy plus material `dispatch_normal=repair_only`;
  - direct SQL witness denied plus service-owned DB check current;
  - empirical jobs fresh plus paper gate blocked.

Deployer stage should not grant this worker privileged SQL just to make validation pass. The product behavior should be
validatable from permitted routes first.

## Validation Gates

Required local and CI validation for engineer implementation:

- `bun run --filter jangar test -- control-plane`
- `bunx oxfmt --check services/jangar/src docs/agents/designs docs/torghut/design-system/v6`
- Status smoke:
  - `GET /ready` returns within `1s` and includes a current truth-window ref.
  - `GET /api/agents/control-plane/status?namespace=agents` returns within `2s` and includes contradictions.
  - A fixture with scoped quant ingestion lag keeps `paper_canary` and `live_micro_canary` held.
  - A fixture with direct SQL denied but `/db-check` current records `witness_access_limited` without blocking
    `serve_readonly`.

Required deployer validation:

- `kubectl get deployment -n agents agents agents-controllers -o wide`
- `kubectl get events -n agents --sort-by=.lastTimestamp | tail -n 50`
- `curl /ready`
- `curl /api/agents/control-plane/status?namespace=agents`
- `curl /api/torghut/trading/control-plane/quant/health?account=PA3SX7FYNUTF&window=15m`
- Confirm material-action verdicts cite the current truth window before deploy widening or capital release.

## Rollout

1. Ship the reducer in shadow mode and expose the window under a new field.
2. Compare action effects against existing material-action verdicts for at least one day.
3. Enable material-action citation enforcement for `dispatch_normal`, `deploy_widen`, and `merge_ready`.
4. Enable Torghut capital consumers to require the truth-window ref for paper and live action classes.
5. Remove shadow-only warnings after two clean deploy cycles and one market session with scoped quant health current.

## Rollback

- If the reducer fails, keep existing material-action verdicts and omit the truth-window field.
- If route latency regresses, disable truth-window generation from route handlers and serve the last good window with
  `state=stale`.
- If contradiction precedence is too strict, degrade only `paper_canary`, `live_micro_canary`, and `live_scale` while
  keeping deploy and merge under the prior material-action policy.
- Never rollback by allowing paper or live capital from a global green route alone.

## Risks

- The first implementation may over-hold action classes because contradictions are easier to detect than to repair.
- If Torghut does not emit compact service-owned DB/data receipts, Jangar may mark too much capital evidence as
  access-limited.
- Route consumers may initially treat `status=ok` and `proof_truth_window.action_effect=hold` as inconsistent. The UI
  must display the action-class effect as the authority.
- The system still needs deployer-deep-dive SQL for rare incidents. The design removes it from the normal gate, not
  from operations entirely.

## Handoff

Engineer acceptance:

- Jangar publishes proof truth windows in status.
- Material-action verdicts cite the window.
- Tests cover global/scoped contradiction precedence and least-privilege witness denial.
- Route budgets stay within the SLOs above.

Deployer acceptance:

- The deployed status route shows a current window.
- Read-only serving remains allowed.
- Normal dispatch, paper, and live capital inherit the strictest unresolved contradiction.
- Rollback can remove the new window without mutating Torghut capital or database state.
