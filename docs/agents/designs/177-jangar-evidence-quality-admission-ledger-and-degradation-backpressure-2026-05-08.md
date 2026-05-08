# 177. Jangar Evidence-Quality Admission Ledger And Degradation Backpressure (2026-05-08)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-08
Owner: Victor Chen, Jangar Engineering Architecture
Scope: Jangar control-plane reliability, schedule-runner failure reduction, database/data quality authority, Torghut
consumer proof, validation, rollout, rollback, and acceptance gates.

Companion Torghut contract:

- `docs/torghut/design-system/v6/181-torghut-quality-adjusted-profit-frontier-and-hypothesis-escrow-2026-05-08.md`

Extends:

- `176-jangar-resource-pressure-escrow-and-runner-qos-gates-2026-05-08.md`
- `175-jangar-failure-debt-clearance-and-action-reentry-frontier-2026-05-08.md`
- `173-jangar-action-broker-and-proof-carrying-rollout-cells-2026-05-08.md`
- `docs/torghut/design-system/v6/180-torghut-resource-priced-evidence-frontier-and-context-spend-escrow-2026-05-08.md`

## Decision

I am selecting an **evidence-quality admission ledger with degradation backpressure** as the next Jangar
control-plane architecture step.

The current runtime is serving, but it is not yet quality-safe. On 2026-05-08 between 03:20Z and 03:31Z,
`deployment/jangar` was available `1/1`, `deployment/agents` was available `1/1`, and
`deployment/agents-controllers` was available `2/2` on image family `9e7b87d8`. The `agents` namespace still held
61 failed pods, 10 running pods, and 255 succeeded pods. Recent Jangar control-plane and Torghut quant schedule-runner
CronJob failures ended in Bun `AbortError`, while the same namespace also showed readiness probe timeouts and
temporary failed scheduling from node affinity or taint pressure. The system recovers by retrying; it does not yet
reduce the failure mode before the next cron tick.

The data surface is the stronger reason for this decision. A read-only database pass through the Jangar application
secret and a read-only transaction showed 4,284 Torghut latest quant metrics updated within seconds, but 4,163 of
those rows had degraded quality (`stale`, `error`, or `insufficient_data`). The public quant health endpoint still
returned `status=ok` because it primarily checks empty store and freshness lag. A scoped account/window health call
returned `status=ok` with `pipelineHealthScoped=true`, but no recent stage rows. Market-context snapshots were also
mixed: 9 of 14 fundamentals snapshots and 15 of 23 news snapshots were older than one day; every fundamentals
snapshot and 16 news snapshots carried risk flags. The simulation dataset cache had not updated since March 19.

The selected design adds one ledger that grades evidence before it can satisfy launch, dispatch, merge, deploy, or
capital gates. Freshness, resource cleanliness, route reachability, pod outcome, database projection, metric quality,
consumer risk flags, and retry lineage become a single admission input. The control plane can keep serving and allow
observe-only repair, but normal schedule launches and Torghut capital-facing evidence cannot advance from fresh but
degraded proof.

The tradeoff is that some work will be held even when the top-line health route says `ok`. I accept that. The
six-month reliability risk is not that Jangar waits a few minutes. It is that a fresh timestamp hides poor evidence
quality, then the system spends runner capacity or capital authority on proof that should have been repaired first.

## Success Metrics

Success means:

- Jangar emits an `evidence_quality_ledger` projection in shadow mode beside route-stability, failure-debt, and
  resource-pressure escrow.
- Each entry records `evidence_id`, `evidence_class`, `producer_ref`, `consumer_ref`, `quality_state`,
  `freshness_state`, `resource_state`, `route_state`, `retry_state`, `schema_state`, `risk_flags`, `decision`,
  `fresh_until`, and `rollback_target`.
- Schedule runners classify status-route `AbortError`, route refusal, and timeout as typed degradation evidence before
  retrying.
- Cron schedules apply backpressure when the latest quality ledger says a stage is degraded, rather than launching a
  new identical runner on every schedule tick.
- Quant health cannot return action-grade `ok` when the latest store is mostly degraded, recent pipeline stages are
  absent, or account/window evidence is missing.
- Market-context evidence can remain informational during expected market-closed staleness, but only if the receipt
  lineage is resource-clean and risk flags are bounded.
- Bounded summary and quality endpoints stay responsive even when the full control-plane status payload is large.
- Engineer and deployer handoffs include exact local tests, cluster validation, rollout phases, and rollback levers.

## Evidence Snapshot

All evidence was collected read-only. I did not mutate Kubernetes resources, database records, GitOps manifests,
trading flags, or AgentRun objects.

### Cluster And Rollout Evidence

- `kubectl config current-context` was unset, but namespace-scoped read operations worked as
  `system:serviceaccount:agents:agents-sa`.
- Jangar namespace pods were all `Running`: `bumba`, `jangar`, `jangar-alloy`, `jangar-db-1`,
  `jangar-openwebui-redis-0`, `open-webui-0`, `symphony`, and `symphony-jangar`.
- Jangar deployments `bumba`, `jangar`, `jangar-alloy`, `symphony`, and `symphony-jangar` were available.
- Listing `statefulsets`, `jobs`, and `cronjobs` in the Jangar namespace was forbidden for this service account, so
  the database assessment used application credentials and read-only SQL instead of `pods/exec`.
- Agents deployments were available: `agents` `1/1`, `agents-alloy` `1/1`, and `agents-controllers` `2/2`.
- `kubectl get pods -n agents -o json` grouped to 61 `Failed`, 10 `Running`, and 255 `Succeeded` pods.
- Failed pod groups included 8 Jangar discover, 9 Jangar implement, 8 Jangar plan, 11 Jangar verify, and Torghut
  market-context plus quant schedule failures.
- Recent schedule-runner failure logs for Jangar plan and Torghut quant plan ended in Bun `AbortError`.
- Agents events showed readiness timeouts for `agents` and both controller pods, plus temporary failed scheduling:
  one node did not match affinity and another had an untolerated taint.
- Jangar logs showed repeated OTLP metrics export failures to
  `observability-mimir-nginx.observability.svc.cluster.local`, so observability itself needs to be quality-scored
  instead of assumed available.

### Source Evidence

- `services/jangar/src/server/supporting-primitives-controller.ts` owns schedule generation and embeds
  `buildScheduleRunnerCommand`. The generated runner uses `AbortController` for admission-status fetches and then
  posts directly to the Kubernetes API. Abort, refusal, and timeout are not currently first-class ledger entries.
- The same controller renders CronJobs with `concurrencyPolicy: Forbid`, `successfulJobsHistoryLimit: 3`, and
  `failedJobsHistoryLimit: 1`. That controls overlap and retention, not quality backpressure.
- `services/jangar/src/server/torghut-quant-metrics-store.ts` persists latest and series metrics with explicit
  `quality`, `status`, `formula_version`, `as_of`, and `freshness_seconds`. Those fields are available, but current
  health projection does not use degraded-quality ratio as an action-grade gate.
- `services/jangar/src/routes/api/torghut/trading/control-plane/quant/health.ts` computes overall state from empty
  store, missing update alarm, and recent stage rows. It can report `ok` while latest metrics are mostly degraded.
- `services/jangar/src/server/migrations/20260212_torghut_quant_control_plane.ts` and the 2026-05-05 indexes give the
  schema enough shape to add quality rollups without changing the source of truth.
- `services/jangar/src/server/torghut-market-context-agents.ts` already records snapshots, runs, run events, evidence,
  quality score, citations, risk flags, and provider state. The missing layer is a capital-facing quality decision
  that distinguishes informational staleness from degrading evidence.

### Database And Data Evidence

- CNPG `psql` through `kubectl cnpg` failed because this service account cannot create `pods/exec` in namespace
  `jangar`. Direct application DB access was read-only and did not expose secrets in artifacts.
- The database identity query observed database `jangar`, user `jangar`, at `2026-05-08T03:26:56.716Z`.
- Tables present included `agents_control_plane.resources_current`, `agents_control_plane.component_heartbeats`,
  public `torghut_market_context_*` tables, and `torghut_control_plane` tables for quant metrics, quant alerts,
  pipeline health, simulation runs, campaign runs, lane leases, and dataset cache.
- `agents_control_plane.resources_current` held 496 non-deleted resources: 461 AgentRuns, 24 ImplementationSpecs,
  8 Agents, 6 AgentProviders, and 1 VersionControlProvider. AgentRun phases were 420 `Succeeded`, 21 `Failed`,
  4 `Running`, and 12 `Template`.
- The same cache had 471 of 496 rows with `updated_at` older than 10 minutes and 393 rows with
  `resource_updated_at` older than 6 hours. Some objects are static, so the ledger must grade freshness by evidence
  class rather than by one global cache age.
- Quant latest metrics had 4,284 rows, max `updated_at=2026-05-08T03:26:59.341Z`, max
  `as_of=2026-05-08T03:26:55.942Z`, and 4,163 degraded-quality rows.
- Open quant alerts remained from April: 2 critical and 10 warning alerts were still open.
- Market-context snapshots had 14 fundamentals rows and 23 news rows. Fundamentals averaged quality `0.8914` but had
  9 stale-over-one-day rows and risk flags on all 14. News averaged quality `0.7826` with 15 stale-over-one-day rows
  and 16 rows with risk flags.
- Market-context runs in the last 24 hours had 5 succeeded fundamentals, 15 succeeded news, and one running row in
  each domain.
- Torghut simulation runs were stale as a capital authority source: dataset cache had 19 rows, 37 total hits, and
  max `updated_at=2026-03-19T10:08:32.208Z`.

## Problem

Jangar has several strong pieces of control-plane evidence, but they are not yet settled into one quality admission
contract.

The current failure modes are:

1. A schedule-runner route timeout becomes a failed pod rather than a typed launch-quality signal.
2. Fresh quant metric timestamps can mask degraded metric quality.
3. Market-context staleness can be informational or blocking, but the distinction is not tied to resource lineage,
   risk flags, and capital class.
4. Full status can be large or slow while bounded summary endpoints are healthy, which encourages consumers to
   over-rely on one monolithic route.
5. AgentRun cache counts, pod failures, CronJob failures, and market-context job failures live in separate surfaces.
6. Torghut can observe fresh receipts while proof quality still requires zero-notional repair.

The control plane needs a quality ledger that decides which evidence can be spent, not just whether evidence exists.

## Alternatives Considered

### Option A: Improve Schedule Retries And Leave Data Quality To Consumers

Add better retry/backoff behavior for schedule runners and let Torghut or other consumers interpret metric quality and
market-context flags.

Advantages:

- Fastest local fix for recurring CronJob failures.
- Keeps Jangar schedule logic narrow.
- Avoids a new status section.

Disadvantages:

- More retries can generate more degraded evidence.
- Consumers will keep inventing separate quality rules.
- It does not explain why quant health says `ok` while most latest metrics are degraded.

Decision: reject as the primary architecture. Retry repair is necessary, but it is not sufficient.

### Option B: Tighten Existing Health Endpoints

Patch quant health, market-context health, and status endpoints so each one returns a stricter state.

Advantages:

- Uses existing route contracts.
- Lower implementation cost than a new ledger.
- Gives operators immediate signal improvements.

Disadvantages:

- Leaves cross-surface admission scattered.
- Does not tie schedule backpressure, material actions, and Torghut capital to the same evidence id.
- Does not solve pod, AgentRun, and data-quality disagreement.

Decision: useful as an implementation step, but incomplete.

### Option C: Evidence-Quality Admission Ledger With Degradation Backpressure

Create one ledger that grades evidence quality across cluster outcomes, schedule failures, database projections,
metric quality, market-context risk, route stability, and resource cleanliness. Consumers use the ledger for launch
and action admission.

Advantages:

- Converts retry noise and degraded data into one admission contract.
- Lets serving and observe-only repair continue while holding normal dispatch and capital authority.
- Gives Torghut one upstream decision to cite in proof-floor and hypothesis gates.
- Creates a place to implement bounded status projections instead of expanding the full status payload.

Disadvantages:

- Adds a reducer and payload shape.
- Requires careful per-evidence-class freshness rules.
- May initially hold work that previously launched under optimistic health.

Decision: select Option C.

## Architecture

Jangar adds a pure `evidence_quality_ledger` reducer. It consumes Kubernetes pod/job/CronJob summaries, AgentRun cache,
schedule-runner outcomes, route-stability escrow, resource-pressure escrow, quant health rows, market-context runs,
database migration status, and Torghut consumer proof.

```text
evidence_quality_ledger
  ledger_id
  generated_at
  namespace
  evidence_entries[]
  aggregate_decisions
  fresh_until
  rollback_target
```

Each entry is action-scoped:

```text
evidence_quality_entry
  evidence_id
  evidence_class          # schedule | agentrun | quant_metric | market_context | simulation | route | database
  producer_ref
  consumer_ref
  source_revision
  observed_at
  fresh_until
  freshness_state         # fresh | aging | stale | absent | not_applicable
  quality_state           # good | degraded | failed | unknown
  resource_state          # clean | dirty | missing | not_required
  route_state             # live | escrowed | refused | timeout | not_required
  retry_state             # none | retrying | clean_retry | failed_retry | retry_debt
  schema_state            # current | drifted | unknown
  risk_flags
  metrics
  decision                # allow | observe_only | repair_only | hold | block
  reasons
  rollback_target
```

Admission consumes the ledger:

```text
degradation_backpressure_gate
  action_class
  required_evidence_classes
  max_degraded_ratio
  require_clean_resource_lineage
  require_live_route
  allow_escrowed_route_for_repair
  min_schema_state
  decision
  ledger_refs
```

Initial rules:

- `serve_readonly` can allow with fresh database migration status and bounded route health.
- `torghut_observe` can allow with degraded evidence, but it must mark evidence non-promoting.
- `dispatch_repair` requires a ledger entry naming the debt it repairs and must not create worse degradation.
- `dispatch_normal`, `deploy_widen`, and `merge_ready` require live or route-stable status, clean resource lineage,
  and no action-critical degraded evidence.
- `paper_canary`, `live_micro`, and `live_scale` require quality-good quant, route/TCA, market-context, hypothesis,
  and Jangar resource evidence.
- A fresh timestamp cannot override `quality_state=degraded`.
- A retry after `AbortError` or route refusal must cite a new schedule-quality entry.

## Implementation Scope

1. Add `services/jangar/src/server/control-plane-evidence-quality-ledger.ts` as a pure reducer.
2. Add unit tests for schedule-runner `AbortError`, status-route refusal, fresh-but-degraded quant metrics, stale
   market-context snapshots, open quant alerts, and stale simulation cache.
3. Add a bounded `/api/agents/control-plane/quality?namespace=agents` projection that does not expand full runtime
   proof cells or every historical pod.
4. Feed ledger aggregate decisions into material action verdicts in shadow mode.
5. Update quant health so degraded-quality ratio and absent recent stage rows can produce `status=degraded`.
6. Add schedule backpressure in `supporting-primitives-controller.ts` after the pure reducer exists.
7. Emit Torghut consumer fields: `jangar_evidence_quality_ref`, `quality_state`, `quality_reasons`, and
   `non_promoting_receipt`.

Do not put scoring policy directly into the schedule controller. The controller should render facts, call the reducer,
and consume a decision.

## Validation Gates

Local validation:

- Reducer test: schedule-runner `AbortError` produces `route_state=timeout` and blocks normal dispatch while allowing
  observe-only repair.
- Reducer test: 4,163 degraded rows out of 4,284 quant latest metrics produces `quality_state=degraded`.
- Health route test: quant health returns `degraded` when latest metrics are mostly degraded or scoped stage rows are
  absent.
- Market-context test: stale snapshots with risk flags remain non-promoting even when a newer run succeeded.
- Material verdict test: `dispatch_normal`, `merge_ready`, `paper_canary`, and `live_micro` hold without a clean
  quality ledger.

Cluster validation:

- `GET /api/agents/control-plane/quality?namespace=agents` returns under 2 seconds for the current namespace.
- One 30 minute shadow window records schedule-runner route failures as ledger entries, not only failed pods.
- Current quant health reports degraded when degraded-quality ratio exceeds the configured floor.
- Torghut proof floor receives `jangar_evidence_quality_ref` and keeps capital zero-notional while quality is dirty.

## Rollout

1. Shadow reducer and bounded quality endpoint.
2. Quant health quality correction and market-context non-promoting receipt fields.
3. Schedule-runner failure classification with no launch holds.
4. Repair-only backpressure for repeated route timeout and degraded evidence.
5. Normal dispatch and merge-ready enforcement.
6. Torghut paper/live enforcement.

## Rollback

Rollback is policy-level first:

- Disable quality-ledger enforcement and keep shadow reporting.
- Keep quant health stricter if it only changes status payloads and not capital action.
- Disable schedule backpressure if it creates starvation, but keep failure classification.
- Fall back to resource-pressure and failure-debt gates for capital protection.

The safe fallback is `serve_readonly`, `torghut_observe`, and explicitly targeted `dispatch_repair`.

## Risks

- A global degraded-ratio rule can over-hold work if old static metrics dominate the store. Use per-account,
  per-window, and per-evidence-class thresholds.
- The quality endpoint can become another monolith if it expands every historical object. Cap age, count, and fields.
- Backpressure can starve repair if it is not debt-targeted.
- Consumers may treat `observe_only` evidence as promoting unless the API marks non-promoting receipts explicitly.
- The first thresholds will need calibration from shadow data.

## Handoff To Engineer

Build the pure reducer first. Use fixtures from this assessment: 61 failed pods, Bun `AbortError` schedule failures,
4,163 degraded quant latest rows out of 4,284, stale market-context snapshots, April open quant alerts, and stale
simulation cache. Keep the controller integration small and testable.

Acceptance gates:

- Fresh-but-degraded evidence cannot satisfy normal dispatch or capital gates.
- Schedule-runner route failures become typed ledger entries.
- Bounded quality status is fast and does not depend on privileged `pods/exec`.
- Quant health cannot claim action-grade `ok` for a mostly degraded latest store.

## Handoff To Deployer

Deploy in shadow mode before any holds. Watch the quality endpoint and schedule-runner classification for a full
market session. Do not enable paper/live enforcement until Torghut receives the ledger ref and proves receipts are
non-promoting when quality is dirty.

Acceptance gates:

- Bounded quality endpoint responds under 2 seconds during active swarms.
- Repeated schedule-runner `AbortError` events create backpressure candidates instead of cron pileups.
- Torghut capital stays zero-notional while quality ledger is dirty.
- Rollback is a feature flag or config toggle, not a manifest revert under pressure.
