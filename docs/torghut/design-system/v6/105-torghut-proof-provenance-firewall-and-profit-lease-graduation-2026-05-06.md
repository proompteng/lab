# 105. Torghut Proof Provenance Firewall And Profit Lease Graduation (2026-05-06)

Status: Accepted for engineer and deployer handoff

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


## Decision

I am choosing a **proof provenance firewall with profit lease graduation** for Torghut.

Torghut is operationally alive but not economically promotable. The live and simulation revisions are running.
Postgres is reachable with Alembic head `0029_whitepaper_embedding_dimension_4096`. ClickHouse has fresh equity TA
data through the May 5 close. Those are useful inputs.

The profitability evidence still fails the capital bar. Torghut autonomy is disabled. Empirical jobs are stale from
March 21. Postgres has zero research candidates, zero research promotions, zero autoresearch epochs, zero strategy
promotion decisions, and zero vnext promotion decisions. Trade decisions are dominated by `rejected` and `blocked`
rows. ClickHouse options feature tables are structurally present but empty.

The selected architecture says a proof cannot graduate to paper or live capital unless its source class is qualified:
fresh empirical replay, current quant metrics, non-empty data readiness, measurable rejection drag, and a matching
Jangar action lease. The tradeoff is slower capital reentry. I accept that because Torghut profitability improves by
retiring false proof, not by letting operational liveness stand in for expected edge.

## Read-Only Evidence Snapshot

All cluster, database, and ClickHouse checks were read-only. No trading controls, Kubernetes resources, or database rows
were changed.

### Cluster And Route Evidence

- `kubectl get pods -n torghut -o wide` showed `torghut-00228` and `torghut-sim-00309` at `2/2 Running`.
- ClickHouse, Keeper, Torghut Postgres, TA, TA sim, options catalog, options enricher, options TA, websocket services,
  Symphony Torghut, Alloy, and guardrail exporters were running.
- `kubectl get deploy -n torghut` showed the current live and simulation deployments available while older Knative
  revision deployments were scaled to zero.
- Argo reported `torghut`, `torghut-options`, and `symphony-torghut` as `Synced` and `Healthy`.
- The service account could not list Knative Services or CNPG clusters and could not exec into pods, so least-privilege
  promotion must rely on projected route/database proof.

### Torghut Route Evidence

- `GET /trading/autonomy` returned `enabled=false`, `runs_total=0`, and `patches_total=0`.
- Forecast service was degraded with `registry_empty`; Lean authority was disabled; empirical jobs were degraded with
  stale `benchmark_parity`, `foundation_router_parity`, `janus_event_car`, and `janus_hgrm_reward`.
- Signal continuity was in expected market-closed staleness with `cursor_tail_stable`; no emergency rollback was active.

### Postgres Evidence

- Torghut SQL connected as `torghut_app` to database `torghut` at `2026-05-06T04:12:42Z`; public table count was 71.
- Alembic head was `0029_whitepaper_embedding_dimension_4096`.
- `trade_decisions` counted 69,909 `rejected`, 63,552 `blocked`, 13,555 `filled`, 370 `planned`, 217 `canceled`, and
  3 `expired` rows. The newest decision was `2026-05-04T17:25:57Z`; the newest execution timestamp was
  `2026-04-02T19:29:14Z`.
- `executions` counted 13,555 filled rows, 220 canceled rows, and 3 expired rows; newest broker update was
  `2026-04-03T05:32:38Z`.
- `research_candidates`, `research_promotions`, `autoresearch_epochs`, `autoresearch_candidate_specs`,
  `strategy_promotion_decisions`, and `vnext_promotion_decisions` all had zero rows.
- `research_runs` had 48 skipped rows, newest update `2026-03-11T10:14:45Z`.
- `vnext_empirical_job_runs` had 16 completed rows, newest update `2026-03-21T09:03:22Z`.
- `whitepaper_semantic_embeddings` had 254 rows, newest `2026-04-26T20:53:46Z`.

### ClickHouse Evidence

- `ta_microbars` had 1,676,707 rows across 20 symbols, newest event `2026-05-05 20:59:07.000`.
- `ta_signals` had 1,176,729 rows across 20 symbols, newest event `2026-05-05 20:59:07.000` and newest ingest
  `2026-05-06 02:34:17.962`.
- `options_contract_bars_1s`, `options_contract_features`, and `options_surface_features` each had zero rows and epoch
  max timestamps.

## Problem

Torghut has multiple real data planes, but only some are profit evidence:

1. A running service is not a proof of expected edge.
2. Fresh equity TA does not prove options readiness.
3. Completed March empirical jobs are stale for May capital.
4. Rejected and blocked decisions dominate the durable decision ledger.
5. Empty research and promotion tables cannot justify paper or live promotion.
6. Jangar needs one compact capital decision, not a broad scrape of Torghut internals.

## Alternatives Considered

### Option A: Promote From Fresh Equity TA Only

Pros:

- Uses the healthiest current market data surface.
- Can produce zero-notional experiments quickly.
- Avoids waiting for options data.

Cons:

- Ignores stale empirical jobs.
- Ignores rejection drag.
- Does not explain why durable promotion tables are empty.
- Does not give Jangar a source-qualified capital lease.

Decision: reject as a capital path; keep it as observation input.

### Option B: Keep Capital Disabled Until Manual Review

Pros:

- Safe in the immediate term.
- Matches current autonomy-disabled posture.
- Avoids false promotion.

Cons:

- Does not create a route back to paper proof.
- Leaves stale proof unassigned.
- Makes profitability dependent on manual interpretation.

Decision: reject as the architecture. Manual review remains an override, not the recovery loop.

### Option C: Proof Provenance Firewall With Profit Lease Graduation

Pros:

- Requires every profit lease to name source class, age, and evidence artifact.
- Separates data readiness, empirical replay, rejection drag, and Jangar action authority.
- Lets observation continue while paper/live capital fail closed.
- Makes options innovation start with data readiness instead of empty-table optimism.

Cons:

- Slower paper/live reentry.
- Requires new projection and tests.
- Requires retention discipline so proof leases do not become another stale table.

Decision: select Option C.

## Architecture

Torghut should graduate profit leases through explicit source classes:

```text
profit_provenance
  proof_id
  hypothesis_id
  account
  window
  source_class             # equity_ta, options_features, empirical_job, execution_tca,
                           # rejection_drag, research_candidate, jangar_action_lease
  source_ref
  observed_at
  fresh_until
  freshness_state          # current, stale, missing, contradictory
  rows
  symbols
  expected_net_edge_bps
  rejection_drag_bps
  decision                 # observe_only, repair_only, paper_candidate, live_candidate, blocked
  blocking_reason_codes[]
```

Graduation rules:

- `observe_only` can use fresh market data without empirical proof.
- `repair_only` is required when empirical jobs are stale, research/promotion tables are empty, or options rows are
  missing.
- `paper_candidate` requires current empirical jobs, non-empty quant metrics, measurable rejection drag, and a Jangar
  action lease that allows paper proof.
- `live_candidate` additionally requires explicit live controls, broker submission enablement, rollback readiness, and
  deployer approval.
- Options hypotheses cannot exceed `repair_only` until options feature tables are non-empty and fresh.

## Validation Gates

- Unit: stale March empirical jobs must produce `repair_only`, not `paper_candidate`.
- Unit: empty options feature tables must block options paper/live promotion.
- Unit: zero research candidates and zero promotion decisions must block capital graduation.
- Integration: Jangar `torghut_capital` cannot allow unless Torghut publishes a current profit lease and Jangar
  source-schema/route/rollout leases agree.
- Data: rejection plus blocked decision share must be measured before any paper lease is emitted.

## Rollout

1. Add the proof-provenance projection in shadow mode.
2. Publish compact proof decisions to Jangar with `observe_only` or `repair_only` for the current state.
3. Rehydrate empirical jobs and quant metrics before allowing paper candidates.
4. Fill options data readiness before options hypotheses can leave repair.
5. Promote to paper only after the proof lease remains current for two consecutive market windows.

## Rollback

- If proof projection is wrong, Jangar maps missing or stale proof to `torghut_observe` only and holds
  `torghut_capital`.
- If a live lease is emitted without the required source classes, disable lease consumption and return to manual
  capital review.
- If options data remains empty, keep options in data-readiness repair and do not create paper candidates.

## Risks

- Proof leases can become noisy if every data refresh creates a new unbounded artifact.
- Rehydration jobs can consume budget without improving expected edge unless rejection drag is priced.
- Empty promotion tables may hide upstream scheduling failures; the repair lane must surface that as a first-class
  blocker.

## Handoff

Engineer:

- Implement proof provenance as a compact projection, not a broad route-time scrape.
- Add tests for stale empirical jobs, empty options tables, empty promotion tables, and Jangar holdback consumption.
- Keep live capital disabled until the proof lease can cite current empirical and Jangar action authority.

Implementation trace:

- `services/torghut/app/trading/profit_leases.py` adds the shadow-only
  `torghut.profit-lease-provenance.v1` reducer consumed by the shared live-submission gate.
- `/trading/status` and `/readyz` expose `profit_lease_projection` without changing live capital defaults.
- `services/torghut/tests/test_profit_leases.py` covers stale empirical jobs, empty options feature readiness, empty
  promotion tables, and Jangar `torghut_capital` holdbacks.

Deployer:

- Treat route health and Argo health as prerequisites only.
- Require a current profit lease before paper or live capital changes.
- Roll back to observe-only if any source class is stale, missing, or contradictory.
