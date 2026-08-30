# 77. Torghut Profit Admission Cells and Materialized Evidence Contract (2026-05-05)

Status: Ready for implementation

## Source Implementation Audit (2026-07-04)

- Source baseline inspected: `6473f3ee7 ci(arc): fit ten lab runners per node (#11877)`.
- Implementation status: Partially implemented: typed proof/readiness/repair/capital surfaces exist across API, trading, and Jangar consumer modules; contract text remains broader than runtime.
- Matched implementation area: Proof, evidence, freshness, repair, and capital gating.
- Current source evidence:
  - `services/torghut/app/api/readiness_helpers/trading_health_proof_lane.py`
  - `services/torghut/app/api/proof_floor_payloads/proof_floor_receipts.py`
  - `services/torghut/app/trading/consumer_evidence.py`
  - `services/torghut/app/trading/freshness_carry.py`
  - `services/torghut/app/trading/revenue_repair/repair_queue.py`
  - `services/jangar/src/server/control-plane-torghut-consumer-evidence.ts`
- Design drift note: Most May 2026 proof/capital docs are implemented as distributed surfaces, not single resources named after each document.


## Executive Summary

The decision is to introduce **profit admission cells** that bind Torghut hypothesis authority to Jangar materialized
evidence. Jangar's companion contract proves platform materialization: schedules, runtime kits, workspace storage, and
profit-read evidence are runnable and fresh. Torghut's profit admission cell decides whether a specific hypothesis,
account, window, and capital stage may move beyond observe or shadow.

I am choosing this because the current live evidence shows Torghut is operationally alive but not profit-admissible.
`/healthz` is healthy and `/db-check` is schema-current, but `/readyz` timed out during this pass. `/trading/status`
reports `mode="live"` and `live_submission_gate.allowed=true`, while quant evidence is not required, Jangar dependency
quorum is informational in the submission gate, empirical jobs are stale, signal lag is over thirteen hours, all three
configured hypotheses require rollback, and Jangar market context for `NVDA` is stale across technicals, fundamentals,
news, and regime. Jangar quant health for the default `paper` account reports an empty latest store.

The tradeoff is stricter capital admission. Torghut may continue to run and collect observations, but it must not treat
operational liveness as economic permission. The upside is leverage: healthy lanes can advance when their own evidence
is fresh instead of being blocked by unrelated stale domains, while stale lanes fail closed with measurable reasons.

## Success Criteria

This design is complete when:

1. every non-observe capital decision cites one `profit_admission_cell_id` and one Jangar
   `materialized_run_proof_id`;
2. `/readyz`, `/trading/status`, scheduler live submission, hypothesis runtime status, and Jangar quant-health all cite
   the same active profit admission receipt for the account/window they report;
3. `quant_health_not_configured`, empty latest store, stale market context, stale empirical jobs, dependency-quorum
   block, signal lag, and schema warnings are distinct reason codes;
4. stale data vetoes only hypotheses that require the stale domain;
5. live submission can remain operationally available while capital stages stay observe/shadow;
6. deployer rollback can force all cells to observe/shadow without deleting admission evidence.

## Current Evidence

All assessment was read-only.

### Cluster and Rollout

- Torghut namespace pods were running: service revision `torghut-00204`, `torghut-sim`, DB, ClickHouse, Keeper, TA
  workers, websocket forwarders, options workers, and exporters.
- Recent Torghut events showed revisions becoming ready after readiness warnings, DB migration and empirical backfill
  jobs completing, and ClickHouse pods matching multiple PDBs.
- The worker cannot list deployments or exec into database pods, so deployer validation must consume projected Jangar
  and Torghut evidence rather than privileged shell checks.

### Source Architecture

Relevant source surfaces:

- `services/torghut/app/trading/submission_council.py` builds the live-submission gate, already fetches typed Jangar
  quant health when configured, and has a typed vocabulary for quant evidence, Jangar dependency quorum, market
  context, capital stages, and submission blocking.
- `services/torghut/app/trading/hypotheses.py` compiles hypothesis runtime status from registry requirements, feature
  rows, drift checks, evidence continuity, signal lag, market-context freshness, and Jangar dependency quorum.
- `services/torghut/app/trading/completion.py` evaluates empirical jobs and hypothesis metric windows for completion
  gates.
- `services/jangar/src/routes/api/torghut/trading/control-plane/quant/health.ts` reports account/window-scoped latest
  metric count, empty-store alarm, missing-update alarm, and pipeline health; this should feed a profit admission cell,
  not remain an optional route-time fetch.
- Existing tests in `services/torghut/tests/test_submission_council.py`,
  `services/torghut/tests/test_trading_api.py`, and hypothesis/empirical tests provide the right style for regression
  coverage.

### Database, Schema, Freshness, and Consistency

Schema evidence:

- `GET /db-check` returned `ok=true`.
- current and expected Alembic head are both `0029_whitepaper_embedding_dimension_4096`.
- `schema_graph_lineage_ready=true`.
- duplicate revisions and orphan parents are empty.
- parent-fork warnings remain for
  `0010_execution_provenance_and_governance_trace` and `0015_whitepaper_workflow_tables`.

Runtime/data evidence:

- `GET /readyz` timed out.
- `GET /trading/status` returned live mode, running scheduler, last run at `2026-05-05T10:23:29Z`, and last reconcile
  at `2026-05-05T10:23:31Z`.
- `live_submission_gate.allowed=true`, but `dependency_quorum_decision="informational_only"`.
- `quant_evidence.required=false`, `status="not_required"`, and `reason="quant_health_not_configured"`.
- signal lag was about `48314s`; market was closed, but the signal-lag number still belongs in proof because it is one
  of the configured hypothesis entry gates.
- all configured hypotheses were shadow or blocked, `promotion_eligible=false`, `capital_multiplier="0"`, and
  `rollback_required=true`.
- empirical jobs were stale from March 2026 even though persisted as truthful/eligible at the time they were created.
- Jangar market-context health for `NVDA` was `overallState="degraded"`, with technicals/regime stale by roughly
  `49452s`, fundamentals stale by millions of seconds, and news stale by millions of seconds.
- Jangar quant health for `account=paper&window=15m` returned an empty latest store.

Interpretation: Torghut has good schema hygiene and strong local safety vocabulary. The missing piece is making capital
admission consume a materialized evidence cell instead of treating operational liveness as enough.

## Problem Statement

Torghut has too many partially true answers to "Can capital move?"

Operational health says yes. Schema health says yes. Hypothesis readiness says no. Market context says stale. Empirical
jobs say stale. Quant health is not configured for the live submission gate. Jangar dependency quorum is informational
in one path and blocking in another. That inconsistency is a profitability risk because it can spend attention and,
eventually, capital on stale evidence.

The expensive failure modes are:

1. live mode language hides the fact that all configured hypotheses are shadow/blocked;
2. quant health is optional even when a lane's promotion contract requires Jangar quant evidence;
3. market-context staleness is global text instead of a hypothesis-local veto;
4. Jangar dependency quorum has different authority in submission and hypothesis paths;
5. a default account/window mismatch can make Jangar quant health look empty while Torghut reports another account;
6. empirical proof from March remains truthful history but should not be current promotion authority.

## Alternatives Considered

### Option A: Make Quant Health and Market Context Required Globally

Set `TRADING_JANGAR_QUANT_HEALTH_REQUIRED=true` and `TRADING_MARKET_CONTEXT_REQUIRED=true` for the whole service.

Pros:

- simple operational posture;
- immediately stops capital from moving on missing Jangar quant evidence;
- aligns with the current degraded evidence.

Cons:

- over-blocks lanes that do not depend on market context or Jangar quant health;
- does not solve route parity or account/window mismatch;
- does not record one durable admission id.

Decision: rejected as the long-term architecture, useful as an emergency flag.

### Option B: Keep Current Submission Gate and Add More Status Text

Leave `live_submission_gate` as the main gate and add clearer reasons for quant evidence, dependency quorum, and
market-context state.

Pros:

- small implementation surface;
- improves operator comprehension quickly;
- reuses existing status route payloads.

Cons:

- still mixes operational liveness with capital authority;
- route callers can observe different decisions;
- no hypothesis-local materialized evidence receipt;
- no direct tie to Jangar schedule/storage proof.

Decision: rejected.

### Option C: Profit Admission Cells With Materialized Evidence

Each hypothesis/account/window/capital-stage pair receives a profit admission cell. The cell consumes Jangar
materialized proof, local schema witness, market-context clocks, quant-health state, empirical jobs, signal continuity,
TCA, and execution revision state. Non-observe capital consumes the cell decision.

Pros:

- makes capital authority hypothesis-local;
- records account/window and avoids default-route ambiguity;
- lets operational serving continue while capital is held;
- integrates directly with Jangar materialized proof;
- creates concrete measurable hypotheses and rollback gates.

Cons:

- adds persistence and route wiring;
- requires tests across scheduler, status, and hypothesis paths;
- will hold current lanes in observe/shadow until evidence is refreshed.

Decision: selected.

## Decision

Implement Torghut Profit Admission Cells.

Cell decisions:

- `observe`: collect evidence only; no capital.
- `shadow`: generate decisions without submission authority.
- `canary`: allow bounded live canary when all entry and proof gates pass.
- `scale`: allow larger capital stage after canary proof passes.
- `quarantine`: stop new decisions for the hypothesis until repair evidence is fresh.
- `veto`: fail closed; operator intervention or proof refresh required.

Non-observe capital requires:

- fresh Jangar materialized proof with action class `torghut_profit_projection_read`;
- schema-current Torghut DB check;
- account/window-scoped quant health when the lane declares `jangar_dependency_quorum` or `feature_coverage`;
- domain-fresh market context when the lane declares `market_context_freshness`;
- fresh empirical jobs within the configured proof horizon;
- signal lag below the lane entry threshold;
- TCA within the lane promotion contract;
- no kill switch and no blocking live-toggle mismatch.

## Target Model

Add or project:

```text
profit_admission_cells
  cell_id
  jangar_materialized_run_proof_id
  hypothesis_id
  lane_id
  strategy_family
  account
  window
  requested_capital_stage
  current_capital_stage
  decision
  reason_codes
  schema_head_signature
  market_context_clock_digest
  quant_health_digest
  empirical_jobs_digest
  signal_continuity_digest
  tca_digest
  execution_revision
  issued_at
  fresh_until
  rollback_action
```

The cell is durable. Routes read the current cell; they do not recompute capital authority independently.

## Measurable Trading Hypotheses and Guardrails

Initial cells map to the current runtime hypotheses:

- `H-CONT-01`, continuation:
  - measurable hypothesis: continuation alpha can move to canary only when signal lag is <= `90s`, Jangar dependency
    quorum is `allow`, feature rows are present, and post-cost expectancy is >= `6 bps`;
  - guardrails: max average absolute slippage `12 bps`, at least `40` live-canary samples before scale-up, fresh TCA
    and empirical proof.
- `H-MICRO-01`, microstructure breakout:
  - measurable hypothesis: microstructure alpha can leave blocked only with fresh order-book/liquidity features, drift
    governance checks, and Jangar dependency quorum `allow`;
  - guardrails: max average absolute slippage `8 bps`, at least `60` canary samples before scale-up, no stale feature
    rows.
- `H-REV-01`, event reversion:
  - measurable hypothesis: event-reversion alpha can enter canary only when market context freshness is <= `120s`,
    Jangar dependency quorum is `allow`, and post-cost expectancy is >= `8 bps`;
  - guardrails: max average absolute slippage `12 bps`, at least `30` canary samples before scale-up, market-context
    domains fresh for the event's required domains.

Current evidence would produce `shadow` or `veto` for all three, which is correct.

## Implementation Scope

Engineer scope:

1. Add additive persistence for profit admission cells in Torghut.
2. Extend `submission_council.py` to consume Jangar materialized proof and produce a cell id for live submission.
3. Extend `hypotheses.py` so Jangar dependency quorum has the same authority in runtime status and live submission.
4. Configure quant-health requirement by lane instead of treating `quant_health_not_configured` as harmless when the
   lane declares a Jangar/feature dependency.
5. Extend `/readyz`, `/trading/status`, and scheduler telemetry to cite the same active cell id.
6. Add route parity tests that prove timeout, empty latest store, stale market context, stale empirical jobs, and
   dependency quorum block are separate reasons.
7. Add deployer-friendly rollback flags that force all cells to observe/shadow without deleting evidence.

Non-goals:

- no automatic live promotion from this design;
- no global capital scale-up while current empirical jobs are stale;
- no direct DB exec requirement in deploy verification;
- no removal of existing kill switch or broker safety controls.

## Validation Gates

Required tests:

- `test_submission_council.py`: missing Jangar materialized proof blocks non-observe capital and records
  `jangar_materialized_proof_missing`.
- `test_submission_council.py`: empty quant latest store records `quant_latest_store_empty` separately from
  `quant_health_not_configured`.
- `test_trading_api.py`: `/readyz` and `/trading/status` cite the same active cell id.
- migration test: cell persistence is additive.
- `test_trading_scheduler_safety.py`: live submission remains operationally available while the capital cell is
  observe/shadow.
- Jangar companion test: Torghut consumes `torghut_profit_projection_read` proof with matching account/window.

Runtime validation:

- `GET /db-check` remains `ok=true`;
- `GET /trading/status` includes `profit_admission_cell_id`;
- every current hypothesis has a cell with explicit reason codes;
- current degraded evidence results in no `canary` or `scale` decision;
- forcing observe/shadow rollback changes decisions without deleting cell rows.

## Rollout

Phase 0: shadow cells.

- Write cells and route ids.
- Do not change live submission enforcement.
- Compare cell decisions against current live gate for one full market session and one off-hours session.

Phase 1: non-observe enforcement.

- Enforce cells only when a lane requests canary or scale.
- Keep observe and shadow collection active.
- Require Jangar materialized proof for all canary/scale requests.

Phase 2: route parity enforcement.

- `/readyz`, `/trading/status`, scheduler, and hypothesis runtime status must cite the same cell id.
- Jangar quant-health account/window mismatches become typed vetoes.

## Rollback

Rollback posture:

1. set profit admission enforcement to shadow-only;
2. continue writing cells for audit;
3. set all non-observe decisions to observe/shadow;
4. leave kill switch and broker controls unchanged;
5. preserve reason-code payloads for post-incident profitability analysis.

## Risks and Mitigations

Risk: all current hypotheses stay blocked, reducing opportunity collection.

Mitigation: observe/shadow remains active. The goal is to collect evidence without pretending stale proof is capital
authority.

Risk: Jangar proof route outage blocks Torghut.

Mitigation: fail non-observe capital closed, but keep service liveness and shadow decision generation available.

Risk: account/window proof mismatch creates false negatives.

Mitigation: require account/window in the cell key and expose mismatch as `jangar_quant_account_window_mismatch`.

Risk: stale empirical jobs are truthful historical artifacts but not current promotion proof.

Mitigation: separate `truthful_history=true` from `promotion_current=true`; current capital uses the latter.

## Handoff to Engineer

Start with shadow persistence and route parity. Do not enforce canary/scale until the Jangar companion proof exists and
the route tests prove shared cell ids. Keep all current hypotheses in observe/shadow under today's evidence.

Acceptance gates:

- every current hypothesis has a profit admission cell;
- current evidence produces no non-observe capital;
- `/readyz`, `/trading/status`, scheduler status, and hypothesis runtime status cite one cell id per account/window;
- missing Jangar materialized proof, empty quant latest store, stale market context, stale empirical jobs, and
  dependency-quorum block are distinguishable.

## Handoff to Deployer

Roll out in shadow mode. Watch live submission, cell write latency, market-context freshness, quant latest-store count,
empirical job freshness, and route parity. Enforce only after one market session proves cell decisions match expected
guardrails and do not increase scheduler errors.

Rollback gate:

- force all cells to observe/shadow if cell freshness expires globally, if route parity breaks, or if Jangar
  materialized proof is unavailable. Do not delete cell rows.
