# 154. Jangar Repair Cell Admission And Market Context Trust Gates (2026-05-07)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-07
Owner: Gideon Park, Torghut Traders Architecture
Scope: Jangar control-plane resilience, repair-cell admission, market-context trust, failed provider jobs, rollout safety,
Torghut evidence consumption, validation, rollback, and handoff.

Companion Torghut contract:

- `docs/torghut/design-system/v6/158-torghut-route-reacquisition-and-market-context-repair-cells-2026-05-07.md`

Extends:

- `153-jangar-design-actuation-ledger-and-contract-convergence-gates-2026-05-07.md`
- `151-jangar-repair-outcome-settlement-and-schedule-debt-roi-exchange-2026-05-07.md`
- `150-jangar-controller-brownout-budgets-and-proof-spend-admission-exchange-2026-05-07.md`

## Decision

I am selecting a repair-cell admission layer for Jangar.

The cluster is no longer failing at the coarse availability layer. At `2026-05-07T16:11:14Z`,
`/api/agents/control-plane/status?namespace=agents` reported dependency quorum `allow`, execution trust `healthy`,
serving and collaboration runtime kits `healthy`, and rollout health `healthy` for `agents=1/1` and
`agents-controllers=2/2`. Jangar `/health` returned `status=ok`. Argo reported `agents`, `jangar`, `torghut`, and
`torghut-options` as `Synced` and `Healthy`.

The failure mode has moved. Jangar still sees repair work as generic schedules and provider jobs, while Torghut needs
specific profitable repair outcomes. The live evidence shows this split plainly:

- Jangar empirical jobs were fresh, but empirical forecast was `degraded` with `registry_empty`, so the namespace stayed
  degraded by `empirical:forecast`.
- A market-context news batch job in `agents` hit `BackoffLimitExceeded` after `/usr/local/bin/codex-implement`
  timed out at 600 seconds and the runner then raised `TypeError: write() argument must be str, not bytes`.
- Jangar namespace events also showed Knative Kafka webhook TLS failures for a Consumer update.
- Torghut market context was degraded: technicals and regime were fresh, but fundamentals were stale by about
  4,847,305 seconds and news by about 4,480,491 seconds.
- Torghut live capital stayed `zero_notional` because the proof floor was `repair_only`, TCA had zero routeable symbols,
  and all three hypotheses were still shadow.

Jangar needs to admit repair as a first-class action class. A repair cell is a bounded, typed attempt to retire one
piece of evidence debt: refresh market context, reacquire routeable TCA symbols, restore scoped quant pipeline health,
or calibrate a forecast registry. The control plane should decide whether a cell may run, how much runtime budget it
may spend, what receipt it must publish, and whether the receipt can be consumed by Torghut.

The tradeoff is that Jangar will reject some helpful-looking jobs that do not declare a cell, budget, consumer, and
receipt. I accept that. A failed repair job without a typed receipt is operational noise; a failed repair cell is useful
evidence with a bounded next action.

## Runtime Objective And Success Metrics

Success means:

- Jangar publishes `repair_cell_admission` from `/api/agents/control-plane/status`.
- Repair cells are scoped to one evidence debt class: `market_context`, `route_tca`, `quant_pipeline`,
  `alpha_readiness`, or `forecast_registry`.
- Every admitted cell carries a cell id, owner, consumer, runtime budget, freshness budget, input evidence digest,
  expected receipt schema, and rollback action.
- Market-context provider jobs no longer appear only as generic failed pods. Their failures are reflected as
  `market_context_repair` cells with reason, provider, timeout, attempt count, and stale domains.
- A failed cell cannot block `serve_readonly`, but it can hold `dispatch_normal`, rollout widening, Torghut paper
  promotion, or Torghut live capital.
- A successful cell can be consumed by Torghut only when its receipt is fresh, schema-valid, source-bound, and produced
  by an admitted cell.
- Repeated cell failures trigger brownout: lower concurrency, longer backoff, and no schedule fanout for that debt
  class until a smaller diagnostic cell succeeds.

## Evidence Snapshot

All evidence was collected read-only on 2026-05-07. I did not mutate Kubernetes resources, database rows, broker state,
GitOps resources, AgentRun objects, trading flags, or market data.

### Cluster And Rollout Evidence

- Branch and base: `codex/swarm-torghut-quant-discover` on `main`, initially no local diff.
- `kubectl get applications.argoproj.io -n argocd` showed `agents`, `agents-ci`, `jangar`, `symphony-jangar`,
  `symphony-torghut`, `torghut`, and `torghut-options` as `Synced` and `Healthy`.
- Jangar pods were available: `jangar-67ffbb64-dlrs5` was `2/2 Running`, `bumba` was `1/1`, and `jangar-db-1` was
  `1/1`.
- Agents pods were available: `agents-b7bff85dd-hzgfn` was `1/1`, and two `agents-controllers-6445c68c54` pods were
  `1/1`.
- Recent agents events still included readiness timeouts on both agents and controller pods during rollout, an
  `UnexpectedJob` event for a discover schedule cron, and `BackoffLimitExceeded` for the market-context news batch.
- Recent Jangar events included a Knative Kafka webhook TLS verification failure while binding a Consumer and transient
  Jangar readiness failures during image replacement.

### Jangar Status Evidence

- `GET /health` returned `status=ok` with the in-process agents controller disabled in the Jangar app surface.
- `GET /api/agents/control-plane/status?namespace=agents` at `2026-05-07T16:11:14.645Z` returned:
  - dependency quorum `allow`;
  - execution trust `healthy`;
  - serving and collaboration runtime kits `healthy`;
  - workflow, job, and temporal runtime adapters `configured`;
  - rollout health `healthy` for both agents deployments;
  - workflows with zero active job runs, zero recent failed jobs, and zero backoff-limit-exceeded jobs in the status
    window;
  - empirical jobs `healthy`, empirical forecast `degraded` with `registry_empty`, and lean `disabled`.
- The status namespace summary was still `degraded` because of `empirical:forecast`.

### Torghut Consumer Evidence

- Torghut active live deployment was `torghut-00271-deployment=1/1`; active simulation was
  `torghut-sim-00371-deployment=1/1`.
- Live `/db-check` returned `ok=true`, `schema_current=true`, current and expected Alembic head
  `0029_whitepaper_embedding_dimension_4096`, schema lineage ready, and account scope ready.
- Direct CNPG pod exec was RBAC-blocked for both Jangar and Torghut DB pods, so typed application endpoints are the
  available data witnesses for this lane.
- Live Torghut `/trading/health` returned `status=degraded` even though scheduler, Postgres, ClickHouse, Alpaca,
  Jangar universe, and empirical jobs were healthy.
- Live proof floor was `repair_only`, `capital_state=zero_notional`, with blockers
  `hypothesis_not_promotion_eligible`, `execution_tca_route_universe_empty`, `market_context_stale`, and
  `simple_submit_disabled`.
- Market-context health for `AAPL` was degraded despite fresh technicals and regime. Fundamentals and news were stale
  by multiple weeks.
- Scoped Jangar quant health for account `PA3SX7FYNUTF` and `window=1d` was degraded with
  `missingUpdateAlarm=true`; aggregate quant health was fresh but skipped stage checks because account and window were
  omitted.

## Problem

Jangar can now serve while the evidence needed for profitable Torghut action is stale, missing, or trapped in generic
job failures. That is the correct serving behavior, but it is not enough for a trading system. Profitability depends on
how fast the control plane can identify the highest-value repair, spend bounded runtime on it, and publish a receipt
Torghut can trust.

The current failure modes are:

1. Market-context provider failures are visible as job failures, but not as repair receipts with consumer impact.
2. Runtime availability is green even when the specific repair job that would unblock Torghut market context is failing.
3. Empirical forecast degradation is visible, but it is not tied to a bounded forecast-registry repair cell.
4. Torghut can see stale fundamentals/news and route TCA failures, but Jangar does not yet prioritize repair cells by
   expected capital unblock value.
5. Deployer stages can over-read Argo `Healthy` as action readiness when the profitable action receipts are absent.

## Alternatives Considered

### Option A: Keep Using Generic Schedules And Jobs

Pros:

- No new status surface.
- Uses existing AgentRun and schedule machinery.
- Keeps provider jobs simple.

Cons:

- Failed jobs do not say which Torghut capital blocker they were meant to repair.
- The control plane cannot budget repeated repair attempts by expected value.
- Torghut gets stale or missing data, not a trusted repair receipt.

Decision: reject. This matches the current evidence and leaves the system reactive.

### Option B: Implement Torghut-Side Repair Only

Pros:

- Directly targets the proof-floor blockers.
- Avoids adding Jangar control-plane objects.
- Lets Torghut own trading semantics.

Cons:

- It duplicates runtime admission and budget logic already owned by Jangar.
- It cannot fix provider job fanout, timeout, or schedule debt.
- It gives deployers no Jangar-side signal about whether a repair was admitted or just attempted.

Decision: reject as the system-level direction. Torghut should consume repair receipts, not own the whole repair
control plane.

### Option C: Add Jangar Repair-Cell Admission

Pros:

- Converts generic repair work into typed, budgeted, auditable cells.
- Separates serving health from profitable action readiness.
- Gives Torghut fresh receipts for market context, route TCA, quant pipeline, and forecast repair.
- Lets deployers reject rollout widening or capital unlocks that cite non-admitted repair work.

Cons:

- Adds a status reducer and a receipt schema.
- Requires provider jobs to declare their intended consumer and evidence debt class.
- Keeps capital closed when a repair ran but did not produce a valid receipt.

Decision: select Option C.

## Architecture

Add `repair_cell_admission` to the Jangar control-plane status layer. It is a pure projection over current status,
schedule/job evidence, provider failure evidence, Torghut health reads, and a static repair-cell policy registry.

`RepairCellAdmission` fields:

- `cell_id`
- `debt_class`: `market_context`, `route_tca`, `quant_pipeline`, `alpha_readiness`, or `forecast_registry`
- `consumer`: `torghut_live`, `torghut_paper`, `jangar_rollout`, or `operator_only`
- `decision`: `admit`, `hold`, `block`, or `brownout`
- `reason`
- `runtime_budget_seconds`
- `attempt_budget`
- `freshness_budget_seconds`
- `input_evidence_digest`
- `expected_receipt_schema`
- `receipt_status`: `missing`, `invalid`, `fresh`, `stale`, or `failed`
- `capital_effect`: `none`, `paper_hold`, `live_hold`, `paper_candidate`, or `live_candidate`
- `rollback_action`

Initial cells:

- `market_context:aapl:regular-session`: repairs stale fundamentals/news and publishes a market-context receipt.
- `route_tca:semis-eight-symbols`: reacquires routeable symbols and publishes a TCA route receipt.
- `quant_pipeline:pa3sx7fynutf:15m`: proves scoped metric and stage health for the live account.
- `forecast_registry:foundation-router`: repairs `registry_empty` before forecast can be authoritative.
- `alpha_readiness:shadow-to-paper`: consumes the above receipts and proposes paper-only promotion candidates.

Admission rules:

- A cell with a failed provider job in the last hour is `hold` unless its next attempt narrows the scope or raises a
  distinct diagnostic receipt.
- A debt class with two consecutive timeout failures enters `brownout`: no fanout, one diagnostic cell, doubled
  backoff, and no downstream capital receipt.
- A cell can be `admit` only when dependency quorum is `allow`, runtime kit is healthy, and the consumer exists.
- `serve_readonly` ignores cell holds; `dispatch_normal`, rollout widening, and Torghut capital gates consume cell
  state.
- A receipt is `fresh` only when it names the admitted cell id, has a schema version, cites source evidence, and is
  inside its freshness budget.

## Implementation Scope

Engineer stage:

- Add a pure Jangar status reducer for `repair_cell_admission`.
- Teach market-context provider jobs to emit compact repair receipts on success and typed failure receipts on timeout.
- Add a schema fixture for each initial receipt type.
- Add tests proving failed market-context jobs become `market_context` repair-cell holds, not generic green status.
- Add a Torghut consumer fixture that proves a fresh market-context receipt can be cited by proof-floor repair logic.

Deployer stage:

- Roll out in shadow first. The status field is visible, but it does not block schedules for one release.
- Enable `dispatch_normal` holds for repeated timeout cells after shadow evidence is stable.
- Keep live capital at zero unless Torghut proof floor is passing and every cited repair receipt is fresh.

## Validation Gates

- Unit: fake market-context timeout produces a `market_context` cell with `decision=hold` and `receipt_status=failed`.
- Unit: stale fundamentals/news produce `capital_effect=paper_hold` for the Torghut consumer.
- Unit: empirical forecast `registry_empty` creates a `forecast_registry` repair cell.
- Integration: `/api/agents/control-plane/status` includes repair cells without breaking existing status fields.
- E2E smoke: one successful provider repair updates the cell receipt and Jangar no longer reports only a pod failure.
- Rollout: Argo remains `Synced/Healthy`, agents deployments stay available, and failed repair cells do not break
  `/health` or `serve_readonly`.

## Rollout And Rollback

Rollout:

1. Ship the status reducer and receipt schemas in shadow mode.
2. Route market-context provider success/failure into receipts while keeping existing jobs unchanged.
3. Enable deployer read-only checks against `repair_cell_admission`.
4. Allow Torghut to consume only `fresh` receipts for paper repair candidates.
5. Only after two sessions, allow non-live capital gates to cite the receipts.

Rollback:

- Disable repair-cell enforcement and keep receipts informational.
- Keep provider jobs on the existing schedule path.
- Preserve emitted receipts for audit, but mark them `retired` or `ignored` in status.
- Torghut remains governed by existing proof floor, submission council, and zero-notional rollback.

## Risks

- Repair cells could become another static list. Require source-bound receipts and tests before any cell can authorize
  a consumer.
- Provider jobs may still timeout. Brownout rules must lower fanout instead of retrying the same expensive prompt.
- A fresh market-context receipt may not improve profitability if TCA remains blocked. Torghut must require route and
  context receipts together before paper capital.
- Jangar status can grow too large. Keep receipts compact and link heavy artifacts by URI.

## Handoff

Engineer acceptance gates:

- `repair_cell_admission` appears in the control-plane status payload with at least the five initial cells.
- Failed market-context news batch evidence is represented as a typed cell failure.
- Tests cover stale market context, forecast registry empty, timeout brownout, and fresh receipt promotion to shadow.

Deployer acceptance gates:

- Shadow rollout preserves Jangar `/health=ok` and Argo `Synced/Healthy`.
- No rollout widening or Torghut paper/live gate cites a repair job unless the matching cell is `admit` or fresh.
- Any repeated provider timeout switches the debt class to brownout before the next fanout cycle.
