# 125. Jangar Quant Proof Replication And Capital Admission Firebreak (2026-05-06)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-06
Owner: Gideon Park, Torghut Traders Architecture
Scope: Jangar control-plane resilience, Torghut quant evidence replication, controller witness gaps, paper/live
capital admission, rollout safety, and cross-plane handoff.

Companion Torghut contract:

- `docs/torghut/design-system/v6/129-torghut-bidirectional-quant-proof-receipts-and-profit-reentry-ledger-2026-05-06.md`

Extends:

- `124-jangar-disruption-budget-arbiter-and-data-freshness-settlement-2026-05-06.md`
- `123-jangar-observation-rights-quorum-and-proof-carrying-rollout-admission-2026-05-06.md`
- `121-jangar-controller-witness-uplink-and-proof-renewal-train-2026-05-06.md`
- `120-jangar-material-action-verdict-arbiter-and-clock-budget-parity-2026-05-06.md`
- `96-jangar-session-proof-train-and-capital-authority-separation-2026-05-06.md`

## Decision

Jangar will add a **quant proof replication firebreak** between healthy control-plane serving and Torghut paper/live
capital admission.

The control plane is healthier than the earlier soak, but it is not yet a complete capital authority. At
`2026-05-06T17:10:31Z`, `/ready` reported leader election healthy, execution trust healthy, runtime kits present,
and the collaboration kit included `codex-nats-publish`, `codex-nats-soak`, and `nats`. `/api/agents/control-plane/status`
reported dependency quorum `allow`, 28 of 28 Jangar migrations applied, healthy rollout for `agents` and
`agents-controllers`, and healthy watch reliability. The same payload still marked normal dispatch as `repair_only`
because the controller-process ingestion witness was unknown. It also marked paper canary `observe_only` and live
micro canary `hold` because Torghut consumer evidence was missing.

Torghut evidence is also contradictory. Torghut `/healthz` and `/db-check` were healthy, but `/trading/health`
returned `503`, `/readyz` and `/trading/status` timed out at 10 seconds, and Jangar quant health for
`account=paper&window=1d` returned `status=degraded`, `latestMetricsCount=0`, and `emptyLatestStoreAlarm=true`.
Direct read-only Torghut database queries showed `147606` `trade_decisions`, no decisions in the last day, zero rows in
`strategy_hypotheses`, zero rows in `strategy_hypothesis_versions`, and zero rows in
`strategy_hypothesis_metric_windows`. The runtime metrics exposed three loaded hypotheses, but no persisted
hypothesis custody rows and no metric windows.

I choose to keep Jangar as the capital admission authority, but only after it independently replicates and reconciles
Torghut proof receipts. Jangar serving health, rollout health, and dependency quorum can allow observation and bounded
repair. They cannot grant paper or live capital while Torghut's quant latest store is empty, Torghut status routes are
degraded, and the controller ingestion witness is unknown.

The tradeoff is deliberate: this slows paper reentry even when the control plane is green. The upside is that a green
Jangar route cannot hide a dead quant consumer, an empty latest store, or a runtime that only exposes hypotheses in
process memory.

## Context And Evidence

All evidence in this document was collected read-only. No Kubernetes resources, database records, trading flags, broker
state, or GitOps resources were changed.

### Cluster And Rollout

- The branch was `codex/swarm-torghut-quant-discover`, based on current `origin/main`.
- The remote head branch was absent before this run, so this PR creates a fresh branch with the required name.
- `kubectl auth whoami` identified the runtime as `system:serviceaccount:agents:agents-sa`.
- The runtime can list namespaces, pods, deployments, jobs, services, and events in the relevant namespaces.
- The runtime cannot list statefulsets or Knative services in `jangar` and `torghut`, and cannot create `pods/exec`.
  Architecture gates must therefore rely on service routes, Jangar status payloads, Kubernetes list/watch evidence
  already projected by controllers, and direct database connections where allowed.
- `jangar` serving pods were ready, including `jangar-b6b87bffd-5xtt9` with `2/2` containers ready.
- `agents` and `agents-controllers` were ready, with `agents-controllers` at `2/2`.
- Recent `agents` events still showed readiness probe timeouts for `agents`, `agents-controllers`, and controller
  pods, plus historical failed jobs in plan/verify lanes. The status projection currently classifies those as healthy
  inside the 15 minute window, but the ingestion witness remains unknown.
- Torghut pods were running, including live revision `torghut-00240`, sim revision `torghut-sim-00336`, ClickHouse,
  Postgres, websocket, TA, options catalog/enricher, options websocket, and options TA.
- Torghut events showed transient readiness 503s during revision turnover, duplicate ClickHouse PDB matches, and no
  current ImagePullBackOff for the promoted sim digest.

### Jangar Runtime Evidence

- `/ready` reported `status=ok`, leader election required and healthy, execution trust healthy, memory provider
  healthy, runtime kit `serving` healthy, runtime kit `collaboration` healthy, and swarm plan/implement/verify
  admission passports `allow`.
- `/api/agents/control-plane/status?namespace=agents` reported database healthy, `registered_count=28`,
  `applied_count=28`, latest migration `20260505_torghut_quant_pipeline_health_window_index`, dependency quorum
  `allow`, watch reliability healthy, and empirical jobs healthy.
- The same status payload had `agentrun_ingestion.status=unknown` with message `agents controller not started`.
- Material action receipts allowed read-only serve and bounded repair, but normal dispatch was `repair_only`.
- Paper canary was `observe_only` and live micro canary was `hold` because `torghut_consumer_evidence_missing`.
- Live scale was `block` because `paper_settlement_required`.

### Torghut Runtime And Data Evidence

- `curl http://torghut-00240.torghut.svc.cluster.local/healthz` returned `{"status":"ok","service":"torghut"}`.
- `/db-check` returned `ok=true`, Alembic head `0029_whitepaper_embedding_dimension_4096`, schema current, and known
  parent-fork warnings.
- `/trading/health` returned `503`.
- `/readyz` timed out after 10 seconds.
- `/trading/status` timed out after 10 seconds.
- `/metrics` was reachable and showed zero trading decisions, zero submitted orders, zero feature batch rows, zero
  drift detection checks, zero evidence-continuity checks, three hypotheses loaded, two in `shadow`, one in `blocked`,
  and zero promotion eligible.
- Jangar quant health for `account=paper&window=1d` returned `status=degraded`, `latestMetricsCount=0`,
  `emptyLatestStoreAlarm=true`, runtime started/enabled, and no pipeline stages.
- Direct read-only SQL through the Torghut app credential with `default_transaction_read_only=on` showed
  `trade_decisions=147606`, newest decision `2026-05-04T17:25:57.901Z`, rows in the last day `0`,
  `strategy_hypotheses=0`, `strategy_hypothesis_versions=0`, `strategy_hypothesis_metric_windows=0`, and
  `vnext_empirical_job_runs=20` completed with newest update `2026-05-06T16:27:32.941Z`.
- `torghut-db-ro` refused TCP connections, so the read-only probe had to use the primary service with an explicit
  read-only transaction option.

## Problem

Jangar has become good at answering whether the control plane is serving and whether its own action admission state is
fresh. Torghut needs a stronger question answered before paper or live capital:

Can a trading hypothesis prove, through at least two independent surfaces, that the evidence used to request capital is
fresh, persisted, replayable, and tied to the same account/window that Jangar will admit?

The current answer is no. Jangar is serving, but Torghut's account/window quant latest store is empty. Torghut has
runtime hypothesis metrics, but the governance tables are empty. The database has historical decisions, but none in
the last day. Empirical jobs are fresh enough in the database, but Jangar still holds paper because consumer evidence
is missing. Torghut status routes are too slow or degraded for a capital gate to depend on a single synchronous fetch.

If Jangar treats its own dependency quorum as sufficient, it can false-green paper capital when Torghut has no fresh
consumer evidence. If Jangar treats every missing Torghut route as a total block, it can also prevent useful
zero-notional repairs. The firebreak has to separate observe, repair, paper, live micro, and live scale.

## Alternatives Considered

### Option A: Keep Current Jangar Receipts And Let Torghut Repair Its Own Store

This option keeps Jangar action receipts as they are and asks Torghut engineers to refresh quant metrics, status
routes, and persisted hypothesis windows.

Pros:

- Lowest Jangar change.
- Preserves current authority boundaries.
- Useful when the only problem is a stale Torghut producer.

Cons:

- Does not explain why Jangar can show dependency quorum `allow` while paper canary is `observe_only`.
- Gives deployers no single replicated proof set to inspect.
- Lets Torghut status route latency remain a hidden capital blocker.
- Does not distinguish a transient route timeout from an empty persisted evidence store.

Decision: reject as the system-level answer. Torghut repair is necessary, but Jangar needs a replicated proof view.

### Option B: Move Capital Authority Into Torghut

Torghut would own all proof receipts, profitability gates, and paper/live promotion decisions. Jangar would only render
or observe.

Pros:

- Simplifies the trading team's local debugging.
- Keeps capital logic close to strategies, manifests, and execution.
- Avoids cross-service reconciliation for every paper decision.

Cons:

- Makes Torghut both the actor and the judge of its own evidence.
- Loses Jangar rollout, watch, runtime-kit, and controller-witness context at the admission boundary.
- Does not solve Jangar's need to hold material swarm/deploy actions when controller evidence is missing.

Decision: reject. Torghut should own proposed proof and profitability math; Jangar should own final material action
admission.

### Option C: Jangar Quant Proof Replication Firebreak

Jangar ingests Torghut proof receipts, independently checks Torghut DB freshness and Jangar quant latest freshness,
then emits one capital-admission verdict per account/window/hypothesis/action class.

Pros:

- Prevents serving-health false greens from becoming capital false greens.
- Converts slow Torghut status routes into typed stale-route evidence instead of opaque timeouts.
- Keeps zero-notional observe and bounded repair available while paper/live remain held.
- Makes controller ingestion witness gaps visible in the same admission record as quant evidence gaps.
- Gives engineer and deployer stages one testable acceptance contract.

Cons:

- Adds a replicated proof store and reconciliation path.
- Requires careful schema versioning so Torghut and Jangar can roll forward independently.
- Needs shadow comparison before enforcement to avoid over-blocking due to route latency alone.

Decision: select Option C.

## Architecture

### QuantProofReceipt

Torghut publishes and persists proposed proof receipts. Jangar replicates them and never treats the Torghut receipt as
final authority by itself.

Required fields:

```text
receipt_id
schema_version
generated_at
expires_at
producer_service
producer_revision
account
window
hypothesis_id
strategy_id
source_manifest_ref
trade_decision_watermark
metric_window_watermark
empirical_job_refs
quant_latest_ref
feature_batch_rows
drift_checks
evidence_continuity_checks
post_cost_expectancy_bps
avg_abs_slippage_bps
max_drawdown_bps
sample_count
status_route_observed
db_observed
payload_digest
```

The receipt can propose these decisions:

- `observe`: no capital, can run cheap diagnostics and dashboards.
- `repair`: no capital, can dispatch bounded repair jobs.
- `paper_candidate`: can be considered for paper only after Jangar replication agrees.
- `live_micro_candidate`: can be considered after paper settlement.
- `live_scale_candidate`: can be considered only after live micro and paper settlement prove clean.

### ReplicatedProofState

Jangar stores one replicated state row per account/window/hypothesis/action class. The state is computed from:

- latest Torghut proof receipt;
- Torghut database watermarks;
- Jangar `quant_metrics_latest` and `quant_pipeline_health`;
- Jangar controller witness and action receipts;
- Torghut route health observations;
- empirical job freshness;
- data-plane disruption and market-context settlement refs.

The result is:

```text
replicated_proof_state
  account
  window
  hypothesis_id
  action_class
  decision                  # allow, observe_only, repair_only, hold, block
  confidence                # high, medium, low
  generated_at
  expires_at
  torghut_receipt_ref
  jangar_quant_ref
  torghut_db_ref
  controller_witness_ref
  missing_refs
  contradiction_refs
  required_repairs
  max_notional
```

### Capital Admission Firebreak

Jangar keeps material action classes separate:

- `serve_readonly` can be allowed with Jangar route health alone.
- `dispatch_repair` can be allowed when repair scope is bounded and max notional is zero.
- `dispatch_normal` requires controller ingestion witness, workflow health, and no unresolved action-clock conflict.
- `paper_canary` requires fresh Torghut receipt, fresh Jangar quant latest metrics, at least one persisted metric
  window, recent trade decision or explicit no-signal receipt, and empirical job refs.
- `live_micro_canary` requires paper settlement plus clean route provenance and live account readiness.
- `live_scale` requires live micro settlement and a paper-to-live TCA sample with bounded slippage.

Empty latest store is never paper-eligible. Empty hypothesis custody tables are never live-eligible. A timed-out
Torghut status route is not automatically a total block, but it caps the action at `repair_only` until a durable
receipt and DB watermark agree.

## Implementation Scope

Engineer stage should implement this in four slices:

1. Add a Jangar-side replicated proof type and pure evaluator.
2. Add a read model that consumes Torghut receipts and Jangar quant store status without requiring `pods/exec`.
3. Project replicated proof state into `/api/agents/control-plane/status` and material action receipts.
4. Add Torghut companion receipt emission and persistence as described in the Torghut contract.

Initial enforcement must be shadow-only for paper and live. Repair gating can enforce earlier because it already uses
max notional `0`.

## Validation Gates

Engineer acceptance:

- Unit tests cover pure evaluator cases for empty latest store, stale Torghut DB watermark, missing controller witness,
  fresh receipt with empty metric windows, and fresh receipt with matching Jangar quant metrics.
- Jangar status tests assert paper canary is `observe_only` when `latestMetricsCount=0`.
- Jangar status tests assert dispatch remains `repair_only` when controller ingestion witness is unknown.
- Torghut receipt schema tests reject missing account/window/hypothesis/source manifest fields.
- No evaluator branch grants paper or live when `max_notional` is missing.

Deployer acceptance:

- `/ready` remains `status=ok` for serving when control-plane dependencies are healthy.
- `/api/agents/control-plane/status?namespace=agents` exposes replicated proof state with expiry, decision,
  missing refs, and required repairs.
- The status route can be queried by the agent service account without pod exec or secret reads.
- A live sample with Jangar quant latest count `0` yields paper `observe_only` or `hold`, never `allow`.
- A fresh Torghut receipt with stale Jangar quant latest yields `repair_only`.
- A fresh Torghut receipt plus fresh Jangar latest plus persisted metric windows yields shadow `allow`, then paper
  candidate only after shadow burn-in.

## Rollout

1. Ship schema and evaluator in shadow mode.
2. Project replicated proof state in Jangar status without changing existing admission decisions.
3. Compare the projected verdict against existing material action receipts for one full market session.
4. Enforce `dispatch_repair` and `paper_canary` holds when the replicated proof state is empty, stale, or contradictory.
5. Enforce live micro and live scale only after paper receipts show at least one clean session and no controller witness
   gaps.

## Rollback

Rollback is configuration-first:

- Disable replicated proof enforcement and keep shadow projection visible.
- Keep existing failure-domain leases, dependency quorum, and material action receipts active.
- Continue allowing `serve_readonly` and bounded `dispatch_repair`.
- Keep paper/live capital at zero if the rollback reason is empty latest store, missing controller witness, stale
  metric windows, or Torghut route timeouts.

Code rollback is safe because the replicated proof state is additive during phase 1.

## Risks

- A Torghut route timeout could overstate risk if the DB receipt path is fresh. Mitigation: route timeout caps paper
  only when DB/Jangar evidence is also stale or contradictory.
- Direct DB queries can become expensive. Mitigation: use watermarks and indexed latest rows, not broad scans.
- Receipts can drift from runtime behavior. Mitigation: require payload digests, source manifest refs, and Jangar-side
  quant latest agreement.
- The controller ingestion witness can remain unknown while deployments are healthy. Mitigation: allow repair, hold
  normal dispatch, and make the missing witness a first-class repair target.

## Handoff

Engineer: build the replicated proof evaluator and status projection first. Do not start with paper/live capital
changes. The first green test is a current-state replay where Jangar serving is healthy, quant latest is empty, Torghut
DB windows are empty, and paper canary remains `observe_only`.

Deployer: validate through service routes and Jangar status, not pod exec. The runtime service account cannot exec into
Jangar or Torghut pods and cannot list Knative services or statefulsets, so deployer gates must use the same surfaces
the swarm can actually see.

Owner acceptance: paper or live capital is not eligible until a Torghut receipt, Torghut DB watermark, Jangar quant
latest row, controller witness, and empirical job refs agree for the same account/window/hypothesis.
