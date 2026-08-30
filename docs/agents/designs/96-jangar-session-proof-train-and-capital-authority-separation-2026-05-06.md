# 96. Jangar Session Proof Train and Capital Authority Separation (2026-05-06)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-06
Owner: Gideon Park, Torghut Traders
Scope: Jangar control-plane resilience, swarm action admission, Torghut proof recency, capital authority separation,
safe rollout, and engineer/deployer acceptance gates.

Companion Torghut contract:

- `docs/torghut/design-system/v6/100-torghut-session-proof-train-and-profitability-warrants-2026-05-06.md`

Extends:

- `95-jangar-evidence-settlement-slo-and-launch-escrow-runway-2026-05-05.md`
- `95-jangar-torghut-evidence-credit-ladder-and-profit-repair-council-2026-05-05.md`
- `docs/torghut/design-system/v6/99-torghut-hypothesis-repair-council-and-evidence-credit-ladder-2026-05-05.md`

## Decision

I am choosing a **session proof train with capital authority separation** as the next Jangar control-plane architecture.

The cluster has recovered from the early degraded soak in important ways: Jangar is serving, the `agents-controller`
replicas are ready, Torghut live and sim revisions are running, both swarms are `Active` and `Ready=True`, and aggregate
Jangar quant health is fresh. The remaining blocker is different: Torghut proof authority is stale or shadow-only.
Empirical jobs are still from `2026-03-21`, Torghut readiness is degraded, live submission is blocked, the last persisted
decision is `2026-05-04T17:25:57Z`, and the 72-hour profitability window has eight rejected decisions and zero
executions.

Jangar should stop treating that state as a broad control-plane permission problem. It should keep serving, discovery,
and bounded engineering work alive when Jangar's own control surfaces are healthy, while it keeps paper and live capital
closed until Torghut publishes fresh session proof. The way to do that is a short-lived proof train per market session:
Jangar admits only bounded zero-notional proof refresh work onto the train, records what proof debt it should reduce,
and lets capital authority consume the resulting receipts separately.

The tradeoff is another admission layer. I accept it because the current evidence says the system is safe but stagnant.
The control plane needs to reduce failure amplification without opening a path to unproven capital.

## Evidence Snapshot

All evidence for this design pass was read-only. No Kubernetes resources or database records were changed.

### Cluster And Rollout Evidence

- Repository branch: `codex/swarm-torghut-quant-discover`; base and head were both
  `67af595a224b90389616299c1e83a41d299a148c` before this design change.
- `kubectl config current-context` was unset, but read-only Kubernetes calls succeeded as the in-cluster
  `system:serviceaccount:agents:agents-sa` identity.
- Namespaces `agents`, `jangar`, and `torghut` were `Active`.
- `kubectl get swarms,agentruns,implementationspecs -n agents -o wide` showed both `jangar-control-plane` and
  `torghut-quant` as `Active`, `lights-out`, and `Ready=True`.
- The prior not-ready controller replica had recovered. `agents-controllers-9d7b77bb8-lv4q9` and
  `agents-controllers-9d7b77bb8-wgwpb` were both `1/1 Running`.
- Recent `agents` pods still showed mixed execution debt: completed discover/plan/implement jobs, failed verify jobs,
  and several running verify/discover attempts in the same window.
- Recent events included `BackoffLimitExceeded` for Jangar verify, newly created Torghut discover jobs, successful
  scheduled jobs, and non-control-plane storage/runner noise. This is not clean enough for unbounded launches.
- Jangar deployment `jangar` was `1/1 Available` on image `a4c52389@sha256:8cd77a...`; the pod was `2/2 Running`.
- Torghut live revision `torghut-00225` and sim revision `torghut-sim-00306` were each `2/2 Running` on image
  `18d356df...`; the previous sim image pull failure was no longer present.
- Recent Torghut events still showed readiness probe failures on the superseded `torghut-00224`/`torghut-sim-00305`
  revisions during rollout. The rollout is serving now, but the train must account for recent failure tails.

### Route And Control-Plane Evidence

- `GET /api/agents/control-plane/status?namespace=agents` returned a dependency quorum decision of `block` with reason
  `empirical_jobs_degraded`. Its segment summaries were otherwise healthy for control runtime, freshness authority,
  evidence authority, market data context, and watch stream.
- The Jangar status payload showed the `jangar-control-plane` swarm at `phase=Active`, `ready=true`,
  `requirements_pending=0`, and recent stage timestamps.
- `GET /api/torghut/trading/control-plane/quant/health` returned `ok=true`, `status=ok`, `latestMetricsCount=3780`,
  `latestMetricsUpdatedAt=2026-05-06T00:10:01.742Z`, and `metricsPipelineLagSeconds=1`.
- The same quant health route omitted scoped pipeline stages because account and window were not provided. Aggregate
  quant freshness is useful, but it is not a capital receipt.

### Torghut Data Evidence Consumed By Jangar

- `GET /healthz` on Torghut returned HTTP 200 with `status=ok`.
- `GET /db-check` returned `ok=true`, `schema_current=true`, current and expected Alembic head
  `0029_whitepaper_embedding_dimension_4096`, one current head, one expected head, no missing heads, no unexpected
  heads, and lineage-ready state with known parent-fork warnings.
- `GET /readyz` and `GET /trading/health` returned degraded payloads. Postgres, ClickHouse, Alpaca, and database schema
  were healthy; live submission was blocked by `simple_submit_disabled`; capital stage was `shadow`; empirical jobs
  were degraded; quant evidence was `not_required` with `quant_health_not_configured`.
- `GET /trading/status` showed `mode=live`, `running=true`, `active_revision=torghut-00225`,
  `last_decision_at=2026-05-04T17:25:57.901670Z`, zero promotion-eligible hypotheses, three rollback-required
  hypotheses, and Jangar dependency quorum `block` due to `empirical_jobs_degraded`.
- `GET /trading/empirical-jobs` returned `ready=false`, `status=degraded`, `authority=blocked`, and stale completed
  jobs `benchmark_parity`, `foundation_router_parity`, `janus_event_car`, and `janus_hgrm_reward`, all created
  `2026-03-21T09:03:22.150009+00:00`.
- `GET /trading/profitability/runtime` returned a 72-hour window with eight decisions, zero executions, zero TCA
  samples, and all decisions rejected for `microbar-volume-continuation-long-top2-v11` across `AAPL`, `AMD`, `INTC`,
  and `NVDA`.
- Direct `pods/exec` into CNPG Postgres and ClickHouse was forbidden. That is correct for the runtime identity and means
  routine proof admission must rely on typed routes, response digests, and durable artifacts.

### Source And Test Evidence

- `services/jangar/src/server/control-plane-status.ts` already aggregates rollout health, database status, workflows,
  watch reliability, execution trust, runtime admission, failure-domain leases, and empirical services. It is the right
  read model for proof-train decisions.
- `services/jangar/src/server/control-plane-workflows.ts` currently maps `empirical_jobs_degraded` into a dependency
  quorum block. That is appropriate for capital authority, but too broad for every non-capital action class.
- `services/jangar/src/server/supporting-primitives-controller.ts` owns schedule launches and already has runtime
  admission hooks. It should consume a proof-train decision, not grow another large embedded policy.
- `services/jangar/src/routes/api/torghut/trading/control-plane/quant/health.ts` already materializes fresh aggregate
  quant health and can support scoped proof reads when account and window are passed.
- Jangar tests cover control-plane status quorum, empirical-service degradation, failure-domain leases, runtime
  admission, watch reliability, and supporting-primitives launch behavior. Missing coverage is action-class separation:
  empirical proof debt blocking capital while serving/discover/repair remain bounded and auditable.

## Problem

Jangar has become better at seeing degraded state than at pricing which actions the degraded state should stop.

The current dependency quorum is conservative, which is the right default for live trading. But it flattens a specific
Torghut proof debt into a broad block reason. That creates five failure modes:

1. **Capital debt can stop platform repair.** Stale empirical jobs should close capital, not prevent bounded
   zero-notional repair or fresh discovery evidence.
2. **Serving health and proof authority share one vocabulary.** A healthy Jangar status route and a stale Torghut
   empirical bundle are very different facts, but both are currently collapsed into a global quorum decision.
3. **Recent rollout failures are not budgeted.** Failed verify jobs and probe failures should reduce launch concurrency
   and runtime windows, not produce an all-or-nothing platform answer.
4. **Aggregate quant freshness can be over-read.** The aggregate quant route is fresh, but capital needs account/window
   receipts with scoped stages.
5. **Least-privilege evidence has no first-class settlement.** Runtime agents cannot exec into databases, so the system
   needs typed proof routes and artifact digests as the normal audit path.

The architecture needs to keep Jangar resilient while preventing accidental capital reentry.

## Alternatives Considered

### Option A: Keep A Single Global Dependency Quorum

Leave `empirical_jobs_degraded` as a global block and require every stage to wait for empirical proof recovery.

Pros:

- Safest immediate interpretation for live capital.
- Minimal implementation work.
- Easy to explain during incidents.

Cons:

- Couples capital evidence debt to control-plane repair capacity.
- Encourages manual overrides when teams need to refresh the very proof causing the block.
- Does not distinguish serving, discover, verify, zero-notional repair, paper capital, and live capital.

Decision: reject as the six-month architecture. Keep the conservative capital block, but split non-capital actions.

### Option B: Refresh Empirical Jobs As A One-Off Repair

Run the four stale empirical jobs and leave control-plane admission unchanged.

Pros:

- Directly addresses the current Torghut blocker.
- Uses existing empirical job contracts.
- Has clear success criteria.

Cons:

- Does not prevent the same broad-block coupling from recurring tomorrow.
- Does not bound launch concurrency while verify jobs are already failing.
- Does not handle account-scoped quant evidence or rejected-decision proof.

Decision: use as an initial train cargo item, not the architecture.

### Option C: Session Proof Train With Capital Authority Separation

Jangar materializes a session proof train, admits bounded zero-notional proof refresh work onto it, and emits separate
action decisions for control-plane work and capital authority.

Pros:

- Keeps Jangar available for useful repair while capital remains fail-closed.
- Turns stale proof into scheduled, bounded, auditable work.
- Converts recent rollout and verify failures into launch budgets instead of manual interpretation.
- Preserves least-privilege operation by relying on typed proof routes and artifacts.
- Gives engineer and deployer stages exact acceptance gates.

Cons:

- Adds a new read model and expiry clock.
- Requires careful shadow rollout so it does not fight existing failure-domain leases.
- Needs tests that prove empirical proof debt cannot leak into live capital.

Decision: select Option C.

## Architecture

### SessionProofTrain

Jangar publishes one train per trading session and namespace:

```text
session_proof_train
  train_id
  namespace
  market_session
  generated_at
  fresh_until
  producer_revision
  control_plane_health
  rollout_debt
  route_budgets
  action_class_decisions
  cargo_slots
  evidence_refs
```

The train is a read model first. It does not replace Swarm, AgentRun, failure-domain lease, or runtime admission
objects. It summarizes whether new work is allowed and, if allowed, what proof debt that work is expected to reduce.

### Capital Authority Separation

The train emits separate decisions for:

- `serve`
- `discover`
- `plan`
- `implement`
- `verify`
- `zero_notional_repair`
- `paper_capital`
- `live_capital`

Rules:

- `serve` can be `allow`, `brownout`, or `block`.
- `discover`, `plan`, `implement`, and `verify` consume rollout and execution debt budgets.
- `zero_notional_repair` can be `allow` while empirical jobs are stale, but only with bounded parallelism and a declared
  proof debt target.
- `paper_capital` requires fresh empirical proof, scoped quant health, dependency quorum not blocked for capital, and no
  unresolved route-budget breach.
- `live_capital` never delays. It is `allow` only after paper-capital proof passes; otherwise it is `block`.

`empirical_jobs_degraded` is a capital authority block. It should not automatically block `serve`, `discover`, or a
bounded `zero_notional_repair` when Jangar's own control runtime is healthy.

### Cargo Slots

Each train has bounded cargo slots:

```text
cargo_slot
  slot_id
  action_class
  target_debt
  max_parallelism
  max_runtime_seconds
  required_route_budget_ms
  expected_receipt
  rollback_trigger
```

Initial cargo classes:

- `refresh_empirical_job_bundle`
- `collect_account_scoped_quant_health`
- `attribute_rejected_decisions`
- `measure_status_route_budget`
- `prove_paper_capital_preconditions`

The train can admit zero cargo if rollout debt or route latency is too high. That is an explicit decision, not a hidden
failure.

### SessionProofReceipt

Every admitted train item must write a receipt:

```text
session_proof_receipt
  receipt_id
  train_id
  slot_id
  action_class
  started_at
  completed_at
  status
  debt_before
  debt_after
  evidence_refs
  response_digests
  artifact_refs
```

Receipts are consumed by Torghut's companion `ProfitabilityWarrant` contract. Jangar does not infer profitability from
a receipt; it only proves that a bounded proof refresh ran and what debt changed.

## Failure-Mode Reduction

- **Controller ready but verify debt high:** reduce or block `verify` cargo slots while still allowing serving.
- **Empirical jobs stale:** block `paper_capital` and `live_capital`; allow one zero-notional empirical refresh slot if
  rollout debt is under budget.
- **Route reads slow or failing:** brownout `serve` read enrichment and block capital receipts that depend on timed-out
  routes.
- **Aggregate quant health fresh but scoped proof absent:** keep aggregate status informational; require scoped
  account/window receipts before paper or live capital.
- **Database exec forbidden:** require route digests and artifact refs; do not depend on privileged DB shells.
- **Recent rollout probe failures:** set shorter train freshness and lower launch concurrency until the failure tail
  clears.

## Implementation Scope

Jangar engineer stage should:

- Add `SessionProofTrain`, `TrainActionDecision`, `CargoSlot`, and `SessionProofReceipt` types outside
  `supporting-primitives-controller.ts`.
- Build the train from `control-plane-status.ts`, failure-domain leases, runtime admission, workflow state, rollout
  health, empirical services, and Torghut proof route summaries.
- Reclassify `empirical_jobs_degraded` as a capital-authority block in the train while preserving the existing global
  dependency quorum until the train is shadowed.
- Expose the train in `/api/agents/control-plane/status` as additive data with a schema version and source refs.
- Add launch-admission hooks for `zero_notional_repair`, `paper_capital`, and `live_capital` after shadow parity passes.
- Add tests for healthy Jangar plus stale Torghut empirical jobs, failed verify debt with serving allowed, scoped quant
  proof missing, and expired train receipts.

Torghut engineer stage should implement the companion profitability warrant route and receipt consumer described in the
Torghut document.

## Validation Gates

Before enforcement:

- Unit tests prove the train emits `serve=allow`, `zero_notional_repair=allow`, `paper_capital=block`, and
  `live_capital=block` for the current evidence shape.
- Unit tests prove recent verify failure debt can delay `verify` without changing capital decisions.
- Control-plane status includes train payload with `schema_version`, `fresh_until`, action decisions, and source refs.
- Shadow logs show at least one full market session where train decisions match operator expectations.

Before any paper-capital admission:

- Torghut empirical jobs are fresh under the configured stale window.
- Torghut scoped quant health is configured and returns non-empty latest metrics and stage data for the target account
  and window.
- Torghut profitability runtime has nonzero paper execution or TCA samples for the candidate hypothesis.
- Jangar train for `paper_capital` is `allow` and fresh.

Before any live-capital admission:

- Paper-capital receipt passes for two consecutive eligible sessions.
- No unresolved `verify` or rollout debt above train threshold.
- Live submission gate is no longer blocked by `simple_submit_disabled`.
- Jangar train for `live_capital` is `allow` and fresh.

## Rollout Plan

1. Add train computation in shadow mode only.
2. Publish train payloads in status and NATS/Jangar UI without changing launch behavior.
3. Compare train action decisions against existing dependency quorum for one full session.
4. Enable enforcement for `zero_notional_repair` only.
5. Enable enforcement for `paper_capital`.
6. Enable `live_capital` only after paper receipts pass and Torghut live gate is explicitly opened.

## Rollback Plan

- Disable train enforcement with a single feature flag; keep status publication for diagnosis.
- If train computation fails, all capital classes fail closed and non-capital launch classes fall back to existing
  runtime admission.
- If train receipts become stale, block capital and zero-notional repair until a fresh train is computed.
- If a train admits too much work, lower cargo slot parallelism to zero while keeping serve decisions independent.

## Risks

- The train could duplicate existing failure-domain leases. Mitigation: build it as an additive read model first and
  reuse lease decisions as inputs.
- Proof routes could become the bottleneck. Mitigation: require route budgets and response digests rather than full
  payload fan-out.
- Operators might treat zero-notional repair as capital progress. Mitigation: receipts never grant capital; only
  Torghut warrants can request paper or live authority.
- Conservative train defaults may delay useful work. Mitigation: shadow mode with decision diffs before enforcement.

## Engineer Handoff

Acceptance gates for engineer stage:

- Add typed train and receipt builders with focused tests.
- Demonstrate the current observed state emits capital blocks and bounded repair allowance.
- Add source refs for Kubernetes object summaries, Jangar status, Torghut DB schema head, empirical job timestamps,
  quant health timestamp, and runtime profitability window.
- Keep `supporting-primitives-controller.ts` policy changes small by delegating train decisions to a separate module.

## Deployer Handoff

Acceptance gates for deployer stage:

- Deploy shadow train status with no behavior change first.
- Confirm train freshness and action decisions in Jangar after rollout.
- Confirm no live-capital path can open while Torghut empirical jobs are stale, quant evidence is not configured, or
  `simple_submit_disabled` remains active.
- Roll back enforcement immediately if train computation latency or route budgets degrade Jangar serving paths.
