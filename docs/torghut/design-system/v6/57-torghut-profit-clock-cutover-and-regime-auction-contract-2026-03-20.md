# 57. Torghut Profit-Clock Cutover and Regime Auction Contract (2026-03-20)

Status: Approved for implementation (`plan`)
Date: `2026-03-20`
Owner: Gideon Park (Torghut Traders)
Mission: `codex/swarm-torghut-quant-plan`
Swarm impacts:

- `torghut-quant`
- `jangar-control-plane`

Companion doc:

- `docs/agents/designs/58-jangar-authority-capsule-cutover-and-freeze-expiry-repair-contract-2026-03-20.md`

Extends:

- `56-torghut-profit-clocks-and-capital-allocation-auction-2026-03-20.md`
- `55-torghut-hypothesis-settlement-exchange-and-lane-capability-leases-2026-03-20.md`
- `54-torghut-capital-lease-receipts-and-profit-falsification-ledger-2026-03-20.md`
- `53-torghut-cross-plane-profit-certificate-veto-and-options-auth-isolation-2026-03-20.md`

## Executive summary

The decision is to cut Torghut over from coarse live gate payloads to durable **Profit Clocks** plus a
regime-scoped **Capital Auction** that reads typed Jangar capsule subjects. Torghut will continue to own hypothesis
economics and portfolio decisions, but it will stop using the generic Jangar control-plane status route as a substitute
for typed quant authority.

The reason is concrete in the live system on `2026-03-20`:

- `GET http://torghut.torghut.svc.cluster.local/readyz`
  - returns HTTP `503`
  - reports `schema_current=true`
  - reports `quant_evidence.reason="quant_health_fetch_failed"`
  - reports `source_url="http://jangar.../api/agents/control-plane/status?..."`
- `GET http://torghut.torghut.svc.cluster.local/trading/status`
  - returns HTTP `200`
  - reports active revision `torghut-00156`
  - reports `active_capital_stage="shadow"`
  - reports `promotion_eligible_total=0`
  - reports stale empirical jobs and `dependency_quorum_unknown`
- `GET http://jangar.jangar.svc.cluster.local/api/torghut/trading/control-plane/quant/health?account=PA3SX7FYNUTF&window=15m`
  - returns HTTP `200`
  - reports `latestMetricsCount=36`
  - reports `metricsPipelineLagSeconds=12`
  - reports `maxStageLagSeconds=85346`
- `GET http://jangar.jangar.svc.cluster.local/api/torghut/market-context/health?symbol=NVDA`
  - returns HTTP `200`
  - reports `overallState="down"`
  - reports `bundleFreshnessSeconds=368368`
  - reports `bundleQualityScore=0.4525`
- `kubectl get pods -n torghut -o wide`
  - shows `torghut-00156` and `torghut-sim-00264` healthy
  - shows four forecast pods `0/1 Running`
  - shows `torghut-lean-runner-69dfc4c888-lpvm4` healthy
- `kubectl get events -n torghut --sort-by=.metadata.creationTimestamp | tail -n 40`
  - shows repeated forecast readiness `503`
  - shows a recent liveness timeout on `torghut-00156`
- `curl http://torghut-clickhouse-guardrails-exporter.torghut.svc.cluster.local:9108/metrics`
  - reports `torghut_clickhouse_guardrails_last_scrape_success 0`
  - reports elevated `torghut_clickhouse_guardrails_freshness_fallback_total`

The tradeoff is stricter endpoint binding, more durable state, and a more explicit auction model. I am keeping that
trade because the current system is safe enough to block but not disciplined enough to answer the next question:
which lanes deserve scarce canary capital when the portfolio is mixed rather than fully green or fully red?

## Mission inputs and success criteria

Observed mission inputs:

- repository: `proompteng/lab`
- base: `main`
- head: `codex/swarm-torghut-quant-plan`
- swarmName: `torghut-quant`
- swarmStage: `plan`
- objective: assess cluster/source/database state and create or update merged design documents that improve Torghut
  profitability and Jangar resilience

This artifact succeeds when:

1. scheduler, `/readyz`, `/trading/status`, and persisted trading evidence share one `profit_clock_id`;
2. Torghut requires explicit typed Jangar endpoints and capsule digests for quant and market-context authority;
3. capital is allocated per lane and regime rather than by one coarse portfolio gate;
4. measurable hypothesis contracts and guardrails define who can bid for capital and who must be demoted.

## Assessment snapshot

### Cluster health, rollout, and event evidence

The core Torghut runtime is partially healthy, but its authority inputs are still mixed.

- `kubectl get pods -n torghut -o wide`
  - confirms the live and simulation revisions are healthy
  - confirms forecast is unhealthy in both live and simulation planes
- `kubectl get events -n torghut`
  - confirms repeated forecast readiness failures and a fresh liveness timeout on the active Torghut revision
- `curl http://torghut-forecast.torghut.svc.cluster.local:8089/healthz`
  - fails to connect from this worker, which matches the not-ready pod state
- `curl http://torghut-lean-runner.torghut.svc.cluster.local:8088/readyz`
  - returns HTTP `200`
  - reports `status="ok"`

Interpretation:

- Torghut is not uniformly unhealthy.
- The core failure is mixed authority: some dependencies are healthy, some are degraded, and the current gate path
  collapses them into a coarse answer without durable lane-local state.

### Source architecture and high-risk modules

The relevant source hot spots are concrete:

- `services/torghut/app/trading/submission_council.py`
  - `resolve_quant_health_url()` falls back from `TRADING_JANGAR_QUANT_HEALTH_URL` to
    `TRADING_JANGAR_CONTROL_PLANE_STATUS_URL` and then to `TRADING_MARKET_CONTEXT_URL`;
  - that lets a generic route stand in for typed quant authority.
- `services/torghut/app/trading/hypotheses.py`
  - loads Jangar dependency quorum from the generic status URL;
  - compiles per-hypothesis readiness but still reduces most upstream truth to reasons and decisions.
- `argocd/applications/torghut/knative-service.yaml`
  - sets `TRADING_JANGAR_CONTROL_PLANE_STATUS_URL`
  - does not set `TRADING_JANGAR_QUANT_HEALTH_URL`
- `argocd/applications/torghut/knative-service-sim.yaml`
  - has the same omission for the simulation lane
- `services/torghut/app/trading/portfolio.py`
  - already has deterministic budget and fragility logic;
  - does not yet price lane capability freshness or profit-clock confidence into budget multipliers.

### Database, schema, freshness, and consistency evidence

The current Torghut database is ready for additive persistence.

- `GET /db-check`
  - reports head `0025_widen_lean_shadow_parity_status`
  - reports `schema_current=true`
  - reports lineage warnings for two migration parent forks
- the migration chain already includes:
  - `0021_strategy_hypothesis_governance.py`
  - `0024_simulation_runtime_context.py`
  - `0025_widen_lean_shadow_parity_status.py`
- existing governance tables already cover:
  - `strategy_hypotheses`
  - `strategy_hypothesis_metric_windows`
  - `strategy_capital_allocations`
  - `strategy_promotion_decisions`
- direct SQL execution is unavailable from this worker because `pods/exec` is forbidden

Interpretation:

- the database contract should extend, not reset;
- the bigger issue is freshness and binding correctness:
  - quant materialization is current while ingestion is stale;
  - market context is down;
  - empirical jobs are complete but stale.

## Problem statement

Torghut still has five profitability-critical gaps:

1. it can still treat the wrong Jangar endpoint as valid quant authority;
2. it computes gate truth at request time rather than settling a durable profit-clock record;
3. healthy lanes cannot compete for capital when unrelated dependencies are degraded;
4. scheduler, `/readyz`, and `/trading/status` can still drift because they do not share one durable decision id;
5. empirical freshness, forecast health, market context, and quant ingestion freshness are still too coarse at the
   final allocation boundary.

That protects the system from obvious mistakes, but it leaves too much option value on the table during mixed market
conditions.

## Alternatives considered

### Option A: patch the explicit quant URL and keep the global gate

Summary:

- set `TRADING_JANGAR_QUANT_HEALTH_URL`;
- remove the wrong fallback path;
- keep capital allocation global and gate-based.

Pros:

- smallest change;
- immediately removes one incorrect authority path.

Cons:

- does not create durable decision ids;
- does not let healthy lanes compete under mixed conditions;
- keeps profitability decisions too dependent on route-time reduction.

Decision: rejected.

### Option B: move final capital decisions into Jangar

Summary:

- Jangar would decide capital eligibility and stage transitions;
- Torghut would become a thin execution engine.

Pros:

- one place to inspect authority;
- simple operator story on paper.

Cons:

- couples infrastructure authority to trading economics;
- increases blast radius from Jangar mistakes;
- slows future experimentation across hypotheses and regimes.

Decision: rejected.

### Option C: profit-clock cutover plus regime auction and execution cohorts

Summary:

- Jangar provides typed capsule subjects;
- Torghut settles lane-local profit clocks from those subjects plus local evidence;
- the allocator runs a deterministic auction over those profit clocks by regime and capital stage.

Pros:

- fixes the wrong-endpoint problem structurally;
- preserves ownership boundaries;
- turns mixed health into selective capital decisions rather than one coarse block;
- creates durable ids for audit, scheduler, status, and rollback.

Cons:

- adds additive persistence and auction logic;
- requires dual-read rollout;
- makes lane guardrails explicit and therefore stricter.

Decision: selected.

## Decision

Adopt **Option C**.

Torghut will settle durable profit clocks and regime-scoped bids from typed Jangar capsule subjects plus local
evidence, then allocate capital through a deterministic auction over those clocks.

## Architecture

### 1. Profit-clock and auction persistence

Add additive Torghut tables:

- `profit_clock_snapshots`
  - `profit_clock_id`
  - `hypothesis_id`
  - `lane_id`
  - `strategy_id`
  - `account`
  - `regime_label`
  - `capsule_digest_set`
  - `decision`
  - `decision_reason_codes`
  - `fresh_until`
  - `evidence_refs`
- `capital_auction_rounds`
  - `auction_round_id`
  - `account`
  - `capital_stage`
  - `opened_at`
  - `closed_at`
  - `portfolio_constraints`
  - `winning_clock_ids`
- `capital_auction_bids`
  - `auction_round_id`
  - `profit_clock_id`
  - `bid_score`
  - `requested_notional`
  - `approved_notional`
  - `decision`
  - `clipping_reasons`

Rule:

- `/readyz`, `/trading/status`, and the scheduler must all name the current `profit_clock_id` and `auction_round_id`
  when they are making a capital-sensitive decision.

### 2. Typed upstream bindings

Mandatory runtime contract:

- `TRADING_JANGAR_QUANT_HEALTH_URL` must be set explicitly in live and sim manifests
- `TRADING_JANGAR_CONTROL_PLANE_STATUS_URL` remains for dependency-quorum and capsule fetches
- `TRADING_MARKET_CONTEXT_URL` remains explicit and cannot masquerade as quant authority

Policy:

- `resolve_quant_health_url()` may not fall back to the generic control-plane status route once the cutover reaches
  enforcement;
- generic status remains allowed only for dependency quorum and capsule retrieval.

### 3. Regime auction and execution cohorts

The first-wave bidding cohorts are the current hypothesis contracts already visible in runtime status:

- `H-CONT-01`
  - lane: `continuation`
  - requires `jangar_dependency_quorum` and `signal_continuity`
  - canary threshold: `40` samples
  - scale threshold: `80` samples
  - post-cost expectancy guardrail: `>= 6 bps`
  - avg abs slippage guardrail: `<= 12 bps`
- `H-MICRO-01`
  - lane: `microstructure-breakout`
  - requires `drift_governance`, `feature_coverage`, and `jangar_dependency_quorum`
  - canary threshold: `60` samples
  - scale threshold: `120` samples
  - post-cost expectancy guardrail: `>= 10 bps`
  - avg abs slippage guardrail: `<= 8 bps`
- `H-REV-01`
  - lane: `event-reversion`
  - requires `jangar_dependency_quorum` and `market_context_freshness`
  - market-context freshness guardrail: `<= 120 seconds`
  - canary threshold: `30` samples
  - scale threshold: `60` samples
  - post-cost expectancy guardrail: `>= 8 bps`
  - avg abs slippage guardrail: `<= 12 bps`

Auction scoring inputs:

- profit-clock decision confidence;
- required capsule freshness;
- empirical job freshness;
- signal continuity and quant ingestion lag;
- forecast availability for lanes that require it;
- market-context quality for lanes that require it;
- existing deterministic portfolio and fragility caps.

### 4. Lane-local degradation semantics

Expected behavior under the current live failure mix:

- forecast degradation blocks or clips only forecast-dependent bids;
- market-context `overallState="down"` blocks `H-REV-01` but does not automatically zero every continuation lane;
- stale quant ingestion can keep a lane in `observe` while another lane with fresh required inputs remains eligible for
  a lower-stage canary bid;
- stale empirical jobs block non-observe promotion but do not erase the current profit clock history.

### 5. Shared evidence ids

Every capital-sensitive path must expose:

- `profit_clock_id`
- `auction_round_id`
- `capsule_digest_set`
- `lane_decision`
- `guardrail_reason_codes`

That includes:

- `/readyz`
- `/trading/status`
- scheduler decisions
- promotion or rollback audit events

## Validation gates

Engineer gates:

1. regression proving generic control-plane status cannot satisfy quant-evidence authority;
2. regression proving `/readyz`, `/trading/status`, and scheduler share the same `profit_clock_id`;
3. regression proving `H-REV-01` blocks on stale market context without zeroing unrelated lanes;
4. regression proving stale empirical jobs block promotion but preserve the prior profit-clock record;
5. regression proving auction clipping reasons are deterministic and auditable.

Deployer gates:

1. live and sim manifests both set `TRADING_JANGAR_QUANT_HEALTH_URL`;
2. one dual-read window shows the explicit quant endpoint and capsule digests in status outputs;
3. one canary round shows healthy lanes receiving capital while a degraded lane remains clipped or observe-only;
4. one rollback drill revokes capital by `profit_clock_id` and leaves unaffected lanes intact.

## Rollout plan

Phase 0: explicit binding

- add the explicit quant-health URL to live and simulation manifests;
- emit warnings when generic fallback would have been used.

Phase 1: dual-write profit clocks

- compute profit clocks and auction rounds in shadow mode;
- continue using the legacy gate for final decisions;
- diff legacy decisions against profit-clock decisions.

Phase 2: enforce shared ids

- require `profit_clock_id` in `/readyz`, `/trading/status`, and scheduler logs;
- require typed Jangar subjects for quant and market-context authority.

Phase 3: enable regime auction for capped capital

- allow only observe-to-canary bids for the first wave;
- cap approved notional by current deterministic portfolio limits;
- require explicit deployer review before any live-stage expansion.

## Rollback plan

Rollback triggers:

- profit-clock computation diverges from legacy gates without a known reason code;
- quant-health endpoint becomes unavailable after manifest cutover;
- auction logic allocates capital to a lane missing a required capsule subject;
- clipped or revoked bids fail to surface in audit records.

Rollback action:

1. keep writing profit clocks and auction rounds for forensic continuity;
2. revert final allocation to the legacy gate path;
3. preserve explicit quant endpoint binding;
4. re-open observe-only mode for affected lanes.

## Risks and open questions

- profit-clock persistence adds one more source of truth if ids are not surfaced everywhere;
- auction scoring can overfit if it is not constrained by deterministic guardrails and explicit thresholds;
- lane-local degradation is only safe if deployers can inspect which capsule or freshness input blocked each bid.

Open questions to resolve in implementation:

- whether forecast health should be mandatory only for model-routed lanes or for all non-observe capital;
- how much stale empirical history may remain referenceable after a lane is forced back to `observe`;
- whether the first auction rounds should score by expected edge only or by a weighted blend of edge, freshness, and
  realized slippage.

## Handoff contract

Engineer acceptance:

1. add explicit quant-health binding to configuration and tests;
2. implement additive profit-clock and auction tables;
3. surface `profit_clock_id` and `auction_round_id` through readiness, status, and scheduler;
4. add regression tests for lane-local degradation, auction clipping, and wrong-endpoint rejection.

Deployer acceptance:

1. verify live and sim revisions read the explicit quant-health route after rollout;
2. verify forecast and market-context degradation clip only the required cohorts;
3. verify one canary auction round and one rollback round with persisted ids and reason codes;
4. do not approve any live-stage increase until the first observe-to-canary round is green and auditable.
