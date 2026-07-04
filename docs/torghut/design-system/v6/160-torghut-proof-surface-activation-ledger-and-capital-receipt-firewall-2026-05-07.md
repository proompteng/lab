# 160. Torghut Proof Surface Activation Ledger And Capital Receipt Firewall (2026-05-07)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-07
Owner: Gideon Park, Torghut Traders Architecture
Scope: Torghut profitability, proof-surface activation, source/runtime drift, capital receipt firewall, measurable
trading hypotheses, validation, rollout, rollback, and implementation acceptance gates.

Companion Jangar contract:

- `docs/agents/designs/156-jangar-runtime-activation-receipts-and-source-drift-quarantine-2026-05-07.md`

Extends:

- `159-torghut-capital-cohort-frontier-and-routeability-repair-board-2026-05-07.md`
- `158-torghut-route-reacquisition-and-market-context-repair-cells-2026-05-07.md`
- `158-torghut-capital-proof-provenance-and-routeable-edge-repair-ledger-2026-05-07.md`

## Decision

I am selecting a proof-surface activation ledger with a capital receipt firewall as the next Torghut profitability
architecture step.

The trading system is doing the right conservative thing: live capital is zero-notional, live submit is disabled, the
proof floor is `repair_only`, and the active route universe is not routeable. The new finding is more subtle. Source
now contains the route reacquisition book that should make route repair measurable, but the active runtime has not
activated it yet. The current repository head includes the reducer, proof-floor wiring, API wiring, and tests. The live
and simulation deployments still run `TORGHUT_COMMIT=4c3eab33120e247e1a4bd235d63098f2beac6fab`, and their runtime
responses do not emit `route_reacquisition_book`.

That gap matters for profitability. A route repair book only improves PnL if the deployed runtime is producing it from
current data, and capital gates can cite it. A merged source file is not enough. A healthy Knative revision is not
enough. A fresh ClickHouse stream is not enough. Torghut needs a proof-surface activation ledger that records which
runtime revision emitted which receipt shape, which data snapshot it used, and which capital decision is allowed to
consume it.

The selected design adds a `proof_surface_activation_ledger` and a `capital_receipt_firewall`. The ledger records
activation state for material proof surfaces such as route reacquisition, proof floor, quant health, empirical jobs,
market context, and execution TCA. The firewall rejects paper/live capital decisions that cite source-only, stale,
shape-missing, or runtime-mismatched receipts.

The tradeoff is slower paper activation after profitable source changes merge. I accept that. If source and runtime
disagree, the profitable action is not to force a trade. It is to complete the release activation path, verify the
receipt shape, and then let a symbol or hypothesis earn capital under the proof floor.

## Runtime Objective And Success Metrics

Success means:

- Torghut publishes `proof_surface_activation_ledger` from `/readyz`, `/trading/health`, and `/trading/status`.
- The ledger includes one row per material proof surface and endpoint contract.
- `route_reacquisition_book` is not considered active until the deployed runtime emits
  `torghut.route-reacquisition-book.v1`.
- `capital_receipt_firewall` blocks paper/live gates when proof surfaces are source-only, stale, shape-missing,
  runtime-mismatched, or not tied to a current Jangar activation receipt.
- Live capital remains `zero_notional` while live submit is disabled, the route universe is empty, market context is
  stale, empirical jobs are stale, or activation receipts are missing.
- Paper repair can resume only after the route book and required receipts are active in runtime, not merely merged in
  source.
- Deployer handoff can cite one activation ledger ID and one Jangar activation receipt ID for each capital-relevant
  proof surface.

## Evidence Snapshot

All evidence was collected read-only on 2026-05-07. I did not mutate Kubernetes resources, database records,
ClickHouse tables, broker state, AgentRun objects, GitOps resources, trading flags, or empirical artifacts.

### Cluster Evidence

- Repository head was `f65301040` on `main`, with latest merge title
  `feat(torghut): add route reacquisition book (#5918)`.
- Active live revision was `torghut-00272`; active simulation revision was `torghut-sim-00372`.
- Both revisions were `1/1` available and used image digest
  `registry.ide-newton.ts.net/lab/torghut@sha256:05fd4b6fc045a50adb049acc98c34278592cea12786aa08597d259ea05c0b464`.
- Both active revisions advertised `TORGHUT_VERSION=v0.568.5-392-g4c3eab331` and
  `TORGHUT_COMMIT=4c3eab33120e247e1a4bd235d63098f2beac6fab`.
- Torghut pods were running for Postgres, ClickHouse, Keeper, live, sim, live TA, sim TA, options TA, websocket
  services, options catalog, options enricher, guardrail exporters, Symphony, and Alloy.
- A retained `torghut-whitepaper-autoresearch-profit-target-8r6w6` pod was in `Error`.
- Recent Torghut events included duplicate ClickHouse PDB matches, DB migrations, empirical/whitepaper backfills,
  websocket rollout readiness transients, and options TA restart/initialization.
- The service account could read pods, deployments, events, and secrets needed for read-only database checks, but could
  not list Knative services, list CNPG cluster resources, list nodes, or exec into DB pods.

### Live Trading Evidence

- Live `/healthz` returned `status=ok`.
- Live `/readyz` returned `status=degraded`.
- Live scheduler was running, startup grace was inactive, Postgres and ClickHouse were healthy, Alpaca live account
  `PA3SX7FYNUTF` was active, and Jangar universe was fresh with eight symbols.
- Live proof floor was `repair_only`, route state `repair_only`, capital state `zero_notional`, and `max_notional=0`.
- Live proof-floor blockers were `hypothesis_not_promotion_eligible`, `degraded`,
  `execution_tca_route_universe_empty`, `market_context_stale`, and `simple_submit_disabled`.
- Live submission gate was `allowed=false`, reason `simple_submit_disabled`, capital stage `shadow`.
- Live alpha readiness showed three hypotheses, all `shadow`, zero promotion eligible, and three rollback-required.
- Live empirical jobs were stale relative to the 86400 second budget even though all four expected jobs existed and
  were truthful: `benchmark_parity`, `foundation_router_parity`, `janus_event_car`, and `janus_hgrm_reward`.
- Live quant evidence was not required for the current gate and had fresh latest metrics, but stage evidence was
  missing in the 15 minute account/window read.
- Live `route_reacquisition_book` was absent from `/trading/status`, `/trading/health`, and `/readyz` despite source
  code containing the route book implementation.

### Execution And Market Evidence

- Live execution TCA source ref had 7334 orders and 7245 filled executions.
- Latest TCA was `2026-05-07T14:23:43Z`.
- Latest execution creation was `2026-04-02T19:00:29Z`, so the execution base is old even though TCA was refreshed.
- Average absolute slippage was `13.8203637593029676` bps against an `8` bps guardrail.
- The live route universe had zero routeable symbols, five blocked symbols, and three missing symbols:
  - blocked: `AAPL`, `AMD`, `AVGO`, `INTC`, `NVDA`;
  - missing: `AMZN`, `GOOGL`, `ORCL`.
- ClickHouse live data was fresh. `torghut.ta_signals` had 1185313 rows, 23 symbols, newest event
  `2026-05-07T17:12:40Z`, and newest ingest `2026-05-07T17:12:41Z`. `torghut.ta_microbars` had 1785949 rows,
  23 symbols, newest event `2026-05-07T17:12:41Z`, and newest ingest `2026-05-07T17:12:41Z`.
- Signal data freshness is not the blocker. Routeability, market context, empirical freshness, and activation truth
  are the blockers.

### Database And Data Evidence

- `/db-check` returned `ok=true`, `schema_current=true`, expected head
  `0029_whitepaper_embedding_dimension_4096`, one migration branch, lineage ready, account scope ready, no duplicate
  revisions, and no orphan parents.
- Direct read-only Postgres query through the app secret showed 69 public base tables and Alembic version
  `0029_whitepaper_embedding_dimension_4096`.
- Counts and freshness:
  - `trade_decisions=147623`, newest `2026-05-06T17:44:19Z`;
  - `executions=13778`, newest `2026-04-03T05:32:38Z`;
  - `execution_order_events=0`;
  - `execution_tca_metrics=13775`, newest `2026-05-07T14:23:41Z`;
  - `position_snapshots=43216`, newest `2026-05-07T17:11:48Z`;
  - `strategy_hypothesis_metric_windows=3`, all paper/shadow;
  - `vnext_empirical_job_runs=20`, newest `2026-05-06T16:27:32Z`.
- ClickHouse simulation data was uneven: 51 simulation databases, 20 nonempty sim tables, and 82 empty sim tables.
  The nonempty recent sim databases were concentrated in `2026_05_05` chip runs.

### Source Evidence

- `services/torghut/app/trading/route_reacquisition.py` defines the route book reducer.
- `services/torghut/app/trading/proof_floor.py` source wires the route book into the proof-floor receipt.
- `services/torghut/app/main.py` source exposes route book fields from readiness, health, and status paths.
- Tests cover route book normalization, malformed rows, live zero-routeable blockers, sim repair-probe behavior, and
  API passthrough.
- High-risk modules remain:
  - `services/torghut/app/main.py`: large API assembly surface;
  - `services/torghut/app/trading/proof_floor.py`: proof dimensions, route state, blockers, repair ladder;
  - `services/torghut/app/trading/tca.py`: TCA materialization and routeability math;
  - `services/torghut/app/trading/revenue_repair.py`: repair value digest;
  - `services/torghut/app/trading/submission_council.py`: deterministic final submission gate.
- The missing test surface is source/runtime activation classification: source contains the route book, active runtime
  does not emit it, and capital gates must treat that as source-only.

## Problem

Torghut has moved from "can we describe the blocker?" to "can we prove the blocker was repaired by the runtime that is
currently serving?" That distinction matters because profit repairs are now becoming code and receipt surfaces, not
just notes.

Current failure modes:

1. Route reacquisition exists in source but not in the active runtime response.
2. Live proof floor can correctly hold capital, but it cannot yet say whether a missing proof surface is source-only,
   not deployed, not emitting, or stale.
3. Fresh ClickHouse data can coexist with stale empirical jobs, old executions, and no routeable live symbols.
4. Simulation databases can be nonempty while most historical sim tables remain empty, so sim evidence must be tied to
   a concrete activation and dataset.
5. Deployer stages can see Argo healthy and miss that capital-relevant endpoint contracts are not active.

The missing object is not another alpha. It is an activation ledger that makes proof surfaces auditable before capital
can cite them.

## Alternatives Considered

### Option A: Wait For Release Automation And Rely On Existing Proof Floor

Pros:

- No new Torghut object.
- The current proof floor already fails closed.
- Release automation should eventually promote the source to runtime.

Cons:

- It leaves no audit row explaining source-only versus runtime-active proof surfaces.
- It requires manual endpoint-shape checks after each material release.
- It does not help capital gates distinguish a missing receipt from a stale receipt.
- It does not make profitability learning faster; it only waits.

Decision: reject as insufficient. The proof floor is safe, but it needs activation provenance.

### Option B: Fast-Track Paper Once Route Reacquisition Source Is Merged

Pros:

- Faster paper feedback after the route book feature lands.
- Uses the newly merged repair reducer and tests.
- Could create fresh execution samples sooner.

Cons:

- The active runtime does not emit the route book yet.
- Live has zero routeable symbols and live submit is disabled.
- Empirical jobs are stale and market context is stale.
- It would treat source intent as runtime evidence, which is exactly the wrong lesson.

Decision: reject. This would weaken the guardrail that is currently protecting capital.

### Option C: Add Proof Surface Activation Ledger And Capital Receipt Firewall

Pros:

- Turns source/runtime activation into a first-class trading gate.
- Preserves the fail-closed proof floor while improving deployer and engineer visibility.
- Lets Torghut rank repair work by active receipt surfaces rather than merged intent.
- Creates a measurable path from source merge to runtime receipt to paper repair.

Cons:

- Adds a new reducer and receipt firewall.
- Requires Jangar activation receipts to be available and fresh.
- Keeps paper closed until endpoint shape is proven active.

Decision: select Option C.

## Architecture

Add `proof_surface_activation_ledger` as a pure Torghut reducer under `services/torghut/app/trading/`.

It consumes:

- local build metadata: `TORGHUT_COMMIT`, `TORGHUT_VERSION`, `K_REVISION`;
- proof-floor receipt;
- route reacquisition book if present;
- live submission gate;
- market context status;
- empirical job status;
- quant evidence status;
- TCA routeability source refs;
- Jangar `runtime_activation_receipts`;
- data freshness summaries for Postgres and ClickHouse.

`ProofSurfaceActivationRecord` fields:

- `activation_id`
- `surface`: `proof_floor`, `route_reacquisition_book`, `execution_tca`, `market_context`, `empirical_jobs`,
  `quant_evidence`, `submission_gate`, or `capital_frontier`
- `endpoint`
- `required_schema_version`
- `observed_schema_version`
- `source_ref`
- `source_head_sha`
- `runtime_commit`
- `runtime_revision`
- `jangar_activation_receipt_id`
- `data_snapshot_ref`
- `freshness_seconds`
- `threshold_seconds`
- `decision`: `active`, `source_only`, `missing_shape`, `stale`, `runtime_mismatch`, or `blocked`
- `capital_effect`: `none`, `paper_hold`, `live_hold`, `paper_candidate`, or `live_candidate`
- `reason_codes`
- `observed_at`
- `expires_at`

`CapitalReceiptFirewall` fields:

- `firewall_id`
- `capital_stage`: `zero_notional`, `shadow`, `paper_probe`, `paper_canary`, `live_micro_canary`, or `live_scale`
- `decision`: `allow`, `repair_only`, `hold`, or `block`
- `blocking_surface_ids`
- `required_activation_ids`
- `missing_activation_ids`
- `stale_activation_ids`
- `runtime_mismatch_ids`
- `max_notional`
- `rollback_target`
- `next_unblocker`

Initial material surfaces:

- `proof_floor`: must always be active before any capital stage above zero-notional.
- `route_reacquisition_book`: required before any route-repair paper probe or paper canary can cite route repair.
- `execution_tca`: required before paper/live routes can be considered routeable.
- `empirical_jobs`: required before alpha readiness or paper canary can cite research proof.
- `market_context`: required when the strategy or hypothesis depends on context freshness.
- `quant_evidence`: required when quant ingestion is configured as required, otherwise informational.
- `submission_gate`: required before live capital and paper broker actions.

## Measurable Trading Hypotheses

### H-ACTIVATE-ROUTEBOOK-01: Runtime Route Book Activation Reduces Repair Ambiguity

Hypothesis: when route reacquisition source is promoted to runtime and emits
`torghut.route-reacquisition-book.v1`, repair prioritization becomes less ambiguous than proof-floor blockers alone.

Pass gate:

- active runtime emits the route book on `/readyz`, `/trading/health`, and `/trading/status`;
- ledger classifies `route_reacquisition_book` as `active`;
- route book has records for all eight configured live symbols;
- capital remains zero-notional while routeable live symbol count is zero.

Rollback:

- if the route book disappears, changes schema without version bump, or omits scoped symbols, ledger marks
  `missing_shape` or `blocked`, and the firewall returns to `zero_notional`.

### H-REPAIR-FRESHNESS-02: Fresh Empirical Receipts Improve Candidate Quality

Hypothesis: paper repair should not cite empirical jobs older than their freshness budget, even when they were
truthful at creation time.

Pass gate:

- all required empirical jobs refresh inside 86400 seconds;
- candidate ID and dataset snapshot ref match the active activation ledger;
- stale jobs cannot make `promotion_eligible_total` positive.

Rollback:

- any stale empirical job moves the empirical surface to `stale` and blocks paper canary.

### H-ROUTE-COST-03: Routeability Beats Broad Signal Freshness For Current Capital Unlock

Hypothesis: with ClickHouse signals fresh and live routes empty, the highest leverage repair is routeability, not more
signal ingestion.

Pass gate:

- at least two live symbols move from `blocked` or `missing` to routeable across two fresh TCA windows;
- average absolute slippage is at or below `8` bps for each routeable symbol;
- max slippage outliers are below the hard-cap policy;
- market context and empirical surfaces are active.

Rollback:

- a routeable symbol returns to `blocked` on any TCA window above guardrail or missing activation receipt.

### H-SOURCE-DRIFT-04: Source-Only Proof Surfaces Must Not Authorize Capital

Hypothesis: capital gates that reject source-only proof surfaces reduce false activation risk without slowing safe
read-only observability.

Pass gate:

- source/runtime mismatch produces `decision=source_only` or `runtime_mismatch`;
- `serve_readonly` remains allowed;
- paper/live capital remains held;
- deployer receives a single next unblocker: promote a Torghut image built from the source commit and verify endpoint
  shape.

Rollback:

- if the ledger false-holds after confirmed runtime activation, downgrade only that surface to informational while
  keeping live capital zero-notional until proof floor passes independently.

## Capital Rules

- `zero_notional` remains the default when any required activation record is missing, stale, runtime-mismatched, or
  source-only.
- `shadow` can consume source-only records for analysis, but the payload must mark them `not_capital_authority`.
- `paper_probe` requires active proof floor, active route book, active TCA, active empirical jobs, fresh market context
  where required, and non-live submission policy.
- `paper_canary` requires at least two routeable symbols, fresh route book, active Jangar activation receipt, and no
  stale empirical jobs.
- `live_micro_canary` requires all paper gates plus live submit enabled, live promotion explicitly configured, and
  active Jangar/Torghut activation receipts.
- `live_scale` is out of scope until live micro canary produces post-cost evidence across the defined observation
  window.

## Rollout Plan

Phase 0: document and shadow.

- Add the ledger reducer in shadow mode.
- Emit ledger and firewall from `/readyz`, `/trading/health`, and `/trading/status`.
- Classify the current state as `route_reacquisition_book=source_only` or `missing_shape`.
- Do not change capital decisions yet; current proof floor already holds capital.

Phase 1: gate paper repair.

- Require `route_reacquisition_book=active` before any paper route-repair probe can cite route repair.
- Require empirical jobs to be fresh before paper canary.
- Keep live capital blocked.

Phase 2: consume Jangar activation receipts.

- Add Jangar receipt ID and expiry to every material activation record.
- Reject capital receipts that cite expired or absent Jangar activation.
- Include ledger IDs in release handoff artifacts.

Phase 3: enforce live firewall.

- Live micro canary requires active ledger records for proof floor, route book, TCA, market context, empirical jobs,
  quant evidence when required, and submission gate.
- Any runtime mismatch returns live capital to `zero_notional`.

## Rollback Plan

- Disable enforcement by marking the firewall `shadow` while keeping ledger emission.
- Keep proof-floor behavior unchanged: live capital remains closed under existing blockers.
- If ledger shape checks are too strict, downgrade only the affected surface to informational and keep route/TCA/live
  capital gates intact.
- If Jangar activation receipts are unavailable, hold paper/live capital rather than bypassing receipt checks.
- If a release activates the wrong runtime commit, roll forward through GitOps to the intended digest; do not manually
  patch Knative services for normal changes.

## Validation Gates

Engineer gates:

- Unit: source has route book but runtime response omits it -> `route_reacquisition_book=source_only` or
  `missing_shape`.
- Unit: runtime emits route book schema `torghut.route-reacquisition-book.v1` with all scoped symbols -> `active`.
- Unit: stale empirical jobs produce `empirical_jobs=stale` and firewall `paper_hold`.
- Unit: live submit disabled produces firewall `live_hold` regardless of other active surfaces.
- Unit: two routeable symbols with passing TCA can produce `paper_candidate` only when empirical and market-context
  surfaces are active.
- API tests: `/readyz`, `/trading/health`, and `/trading/status` expose the ledger and firewall.

Data gates:

- Postgres schema current at `0029_whitepaper_embedding_dimension_4096`.
- TCA metrics freshness under 86400 seconds for routeability decisions.
- Empirical job freshness under 86400 seconds for candidate authority.
- ClickHouse signal and microbar newest ingest under the configured market-session lag budget.
- Simulation datasets must cite the database and dataset snapshot used; empty sim tables cannot be treated as evidence.

Deployer gates:

- Confirm active runtime commit matches the intended source commit.
- Confirm endpoint shape exists in live and sim before declaring proof-surface activation complete.
- Confirm Jangar activation receipt is active and unexpired.
- Confirm firewall blocks live capital when live submit is disabled or routeable live symbol count is zero.

## Handoff To Engineer

Build the reducer without changing broker behavior first.

Implementation ownership:

- `services/torghut/app/trading/proof_surface_activation.py`
- API assembly in `services/torghut/app/main.py`
- focused tests in `services/torghut/tests/test_proof_surface_activation.py` and existing trading API tests

The first fixture should match this run:

- source contains `route_reacquisition_book`;
- runtime commit is `4c3eab331`;
- active responses omit `route_reacquisition_book`;
- live proof floor is `repair_only`;
- empirical jobs are stale;
- live routeable symbol count is zero.

Expected result: firewall stays `zero_notional`, route book activation is not active, and next unblocker is release
promotion plus endpoint-shape verification.

## Handoff To Deployer

Do not treat source merge or Argo health as capital readiness.

Before promoting paper repair or live capital, verify:

- active Torghut runtime commit;
- active endpoint schema for every material surface;
- Jangar activation receipt `decision=active`;
- Torghut firewall `decision=allow` for the requested capital stage;
- proof floor `max_notional` above zero only when the requested stage is paper/live eligible.

For the current state, the smallest unblocker is a standard Torghut release promotion that deploys the commit
containing `route_reacquisition_book`, followed by `curl /trading/status`, `curl /trading/health`, and `curl /readyz`
shape checks. Until those checks pass, paper and live capital should remain held.

## Risks

- The ledger could duplicate proof-floor logic. Keep it focused on activation and receipt authority, not route math.
- The firewall could slow paper learning if contracts are too broad. Keep initial material surfaces small.
- Runtime commit metadata can be misconfigured. Treat absent or contradictory commit metadata as `runtime_mismatch`.
- Simulation evidence can look cleaner than live because many sim tables are empty. Require dataset refs and nonempty
  data checks.
- A false active receipt is worse than a false hold. Prefer `hold` over `allow` when activation evidence is ambiguous.

## Final Position

I am choosing activated proof over optimistic source intent.

The next profitable step is not to loosen capital. It is to prove that the runtime now emits the route repair and
capital receipt surfaces we just added in source, then let those receipts earn paper repair under strict freshness and
routeability gates. Until that happens, Torghut should keep serving observability and keep capital at zero-notional.
