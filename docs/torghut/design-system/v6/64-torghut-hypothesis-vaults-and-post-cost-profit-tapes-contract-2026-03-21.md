# 64. Torghut Hypothesis Vaults and Post-Cost Profit Tapes Contract (2026-03-21)

Status: Approved for implementation (`plan`)
Date: `2026-03-21`
Owner: Gideon Park (Torghut Traders)
Mission: `codex/swarm-torghut-quant-plan`
Swarm impacts:

- `torghut-quant`
- `jangar-control-plane`

Companion doc:

- `docs/agents/designs/65-jangar-recovery-warrants-and-runtime-proof-cells-contract-2026-03-21.md`

Merged program:

- `docs/torghut/design-system/v6/65-torghut-quant-proof-ledger-cutover-program-and-handoff-contract-2026-03-21.md`

Extends:

- `63-torghut-profit-windows-and-evidence-escrow-contract-2026-03-21.md`
- `62-torghut-lane-books-and-bounded-query-firebreak-contract-2026-03-20.md`
- `docs/agents/designs/64-jangar-recovery-epochs-and-backlog-seats-contract-2026-03-21.md`

## Executive summary

The decision is to keep final profit authority inside Torghut, but stop letting that authority depend on live
request-time fetches and one mutable gate payload. Torghut will compile two new durable objects:
**Hypothesis Vaults** and **Post-Cost Profit Tapes**.

The March 21, 2026 evidence is explicit:

- `GET http://torghut.torghut.svc.cluster.local/trading/status` at `2026-03-21T00:30:06Z`
  - reports `live_submission_gate.allowed=false`;
  - reports `blocked_reasons` including `alpha_readiness_not_promotion_eligible`,
    `empirical_jobs_not_ready`, `dependency_quorum_unknown`, and `quant_health_fetch_failed`;
  - reports `quant_evidence.reason="quant_health_fetch_failed"` even though the typed Jangar quant-health route is
    reachable separately;
  - proves Torghut is still flattening multiple authority failures into one route-time answer.
- `GET http://torghut.torghut.svc.cluster.local/trading/decisions?limit=5` at `2026-03-21T00:30:07Z`
  - returns persisted decisions from `2026-03-19T20:11:43Z` through `2026-03-19T20:13:44Z`;
  - while `/trading/status` still reports `last_decision_at=null`;
  - proves route-time status and persisted decision truth are already drifting.
- `GET http://jangar.jangar.svc.cluster.local/api/torghut/trading/control-plane/quant/health?account=paper&window=1d`
  at `2026-03-21T00:30:34Z`
  - returns `status="degraded"`;
  - returns `latestMetricsCount=0`;
  - returns `emptyLatestStoreAlarm=true` with `stages=[]`;
  - proves the quant latest-store authority exists, but the live Torghut gate is not consuming it as a durable local
    record.
- `GET http://torghut.torghut.svc.cluster.local/trading/empirical-jobs` at `2026-03-21T00:30:37Z`
  - returns `ready=false`;
  - shows all four empirical jobs stale from `2026-03-19T10:31:27Z`;
  - proves truthful evidence is present and queryable, but too old to fund promotion.
- `GET http://jangar.jangar.svc.cluster.local/api/torghut/market-context/health?symbol=NVDA` at
  `2026-03-21T00:31:52Z`
  - returns `overallState="degraded"`;
  - shows `bundleFreshnessSeconds=12771`;
  - shows `fundamentals` stale for `730113` seconds and `news` stale for `384884` seconds;
  - proves market-context quality debt must be settled economically, not inferred informally.
- `curl http://torghut-clickhouse-guardrails-exporter.torghut.svc.cluster.local:9108/metrics` at
  `2026-03-21T00:30:33Z`
  - shows `torghut_clickhouse_guardrails_ta_signals_max_event_ts_seconds` and
    `torghut_clickhouse_guardrails_ta_microbars_max_window_end_seconds` as `nan` on one replica;
  - shows `torghut_clickhouse_guardrails_freshness_fallback_total{table="ta_signals"} 829`;
  - shows `torghut_clickhouse_guardrails_freshness_fallback_total{table="ta_microbars"} 1944`;
  - shows `torghut_clickhouse_guardrails_last_scrape_success 0`;
  - proves freshness debt is replica-local and persistent enough to become lane-local economic evidence.
- authenticated read-only ClickHouse queries against `torghut-clickhouse` at `2026-03-21T00:32:45Z`
  - show `ta_signals.max(event_ts)=2026-03-20 20:59:00`, `lag_seconds=12825`, `rows_24h=76738`;
  - show `system.replicas.is_readonly=0` for both `ta_signals` and `ta_microbars`;
  - prove the issue is stale or expensive authority, not read-only replica state.
- authenticated read-only ClickHouse freshness query against `ta_microbars` at `2026-03-21T00:32:46Z`
  - fails with `MEMORY_LIMIT_EXCEEDED`;
  - proves naive full-table freshness reads are not safe authority inputs for promotion.
- `kubectl logs -n torghut pod/torghut-forecast-7ff6d8658b-d2vg4 --tail=120` at `2026-03-21T00:30:26Z`
  - shows repeated `GET /healthz -> 200`;
  - shows repeated `GET /readyz -> 503`;
  - proves forecast evidence is partially alive and therefore needs lane-local economic treatment rather than a
    portfolio-wide binary interpretation.
- `GET http://torghut.torghut.svc.cluster.local/trading/executions?limit=5` at `2026-03-21T00:31:31Z`
  - returns newest visible rows from `2026-03-14`;
  - shows `execution_correlation_id=null` and `execution_idempotency_key=null` on those rows;
  - proves the settlement surface is not yet strong enough to audit post-cost profitability per hypothesis window.
- source inspection:
  - `services/torghut/app/trading/submission_council.py`
    still collapses quant-health fetch errors into a generic shared gate result;
  - `services/torghut/app/trading/hypotheses.py`
    still loads Jangar dependency quorum from one control-plane URL and downgrades to `unknown` on timeout;
  - searches for `profit_window`, `evidence_escrow`, `hypothesis_vault`, or `profit_tape` under
    `services/torghut/**` return only docs, not executable persistence or parity tests;
  - existing tests cover endpoint wiring and timeout handling, but not durable settlement parity.

The tradeoff is more additive persistence and a stricter local authority model. I am keeping that trade because the
next six-month profitability failure will not come from a missing route. It will come from stale-but-truthful evidence,
empty latest-store authority, and degraded freshness all being repriced ad hoc at request time.

## Mission inputs and success criteria

Observed mission inputs:

- repository: `proompteng/lab`
- base: `main`
- head: `codex/swarm-torghut-quant-plan`
- swarmName: `torghut-quant`
- swarmStage: `plan`
- objective: assess cluster/source/database state and create or update merged architecture artifacts that improve
  Jangar resilience and Torghut profitability with measurable hypotheses and guardrails

This document succeeds when:

1. every non-observe capital decision can cite one `hypothesis_vault_id`, one `profit_window_id`, and one settled
   `profit_tape_id`;
2. stale empirical jobs, empty quant latest-store data, or stale market-context evidence can freeze only the vaults
   that depend on them;
3. `/trading/status`, `/readyz`, the scheduler, and promotion logic consume the same local authority mirror and settled
   tape ids rather than issuing their own live HTTP truth requests;
4. measurable hypothesis progression is based on settled post-cost results and data-quality coverage, not only on
   instantaneous gate health.

## Assessment snapshot

### Cluster health, rollout, and runtime evidence

Torghut is serving, but it is still composing economic authority too late.

- `GET /trading/status`
  - proves the runtime is running and the critical toggle parity is aligned;
  - also proves the promotion gate still depends on live quant and dependency fetches that can return `unknown`.
- `GET /trading/empirical-jobs`
  - proves empirical artifacts exist and remain queryable;
  - also proves Torghut still lacks a durable notion of "stale but truthful evidence that may inform observation but
    may not fund capital."
- `GET /trading/executions?limit=5`
  - proves the visible settlement surface is old and incompletely correlated;
  - therefore the current gate cannot defend post-cost profitability claims with enough lineage.

Interpretation:

- Torghut has enough source truth to stop using one mutable gate as the only profit authority;
- it needs one settled ledger that records what each hypothesis actually earned, what it cost, and what evidence funded
  the claim.

### Source architecture and high-risk modules

The current source tree still keeps too much trading authority in synchronous reducers.

- `services/torghut/app/trading/submission_council.py`
  - validates the typed quant-health endpoint and caches fetches;
  - still returns `quant_health_fetch_failed` as a route-time blocker instead of consuming a durable local authority
    record.
- `services/torghut/app/trading/hypotheses.py`
  - still loads dependency quorum from `TRADING_JANGAR_CONTROL_PLANE_STATUS_URL`;
  - still reduces timeout into `decision='unknown'`, which is correct as a safety fallback but too coarse as lasting
    economic truth.
- `services/torghut/app/trading/scheduler/pipeline.py`
  - still relies on live market-context, feature-quality, and runtime readiness reducers to determine actionability;
  - cannot yet prove that a decision or rejection belonged to one immutable settled tape.
- tests:
  - `services/torghut/tests/test_submission_council.py` and `services/torghut/tests/test_hypotheses.py` prove the
    endpoint-wiring and timeout guardrails are correct;
  - there is no executable parity test keeping `/trading/status.last_decision_at` aligned with the persisted decisions
    surface;
  - there are no executable tests for `profit_window`, `evidence_escrow`, `hypothesis_vault`, or `profit_tape`
    persistence parity because those objects do not exist in runtime code yet.

### Database, schema, freshness, and consistency evidence

The database surface is healthy enough to carry stronger economic truth, but it is not settling that truth yet.

- `GET /db-check` at `2026-03-21T00:30:01Z`
  - returns `schema_current=true` and head `0025_widen_lean_shadow_parity_status`;
  - still surfaces lineage warnings on migration parent forks, which should remain attached to settled profit tapes.
- the typed quant-health route
  - proves latest-store emptiness with `latestMetricsCount=0` and `emptyLatestStoreAlarm=true`;
  - should therefore fund or block vaults explicitly instead of disappearing inside a generic fetch error.
- ClickHouse freshness exporter metrics
  - prove replica-local `nan` freshness and repeated low-memory fallbacks;
  - should become tape inputs because query quality affects whether a hypothesis is being judged on authoritative data.
- execution rows and empirical-job records
  - prove outcome and evidence objects exist in pieces;
  - do not yet compose into one durable post-cost hypothesis settlement contract.

## Problem statement

Torghut still has four profitability-killing common-mode behaviors:

1. live request-time fetch failures can outweigh more specific, already-available local evidence;
2. stale-but-truthful empirical jobs can remain visible without being priced explicitly in capital authority;
3. empty quant latest-store and stale market-context evidence block trading economically, but there is no settled local
   record tying that debt to one hypothesis and one window;
4. realized post-cost profitability is not yet being settled into the same authority object that promotion and rollback
   trust.

That is too weak for the next six months. The system needs to know not only whether evidence exists, but whether a
given hypothesis vault is funded, profitable, and falsified under post-cost settlement.

## Alternatives considered

### Option A: centralize final profit authority in Jangar

Pros:

- one system would compile both rollout and capital truth;
- fewer local Torghut persistence objects to manage initially.

Cons:

- couples trading economics to Jangar rollout and latency too tightly;
- makes Jangar timeouts more expensive than they already are;
- reduces Torghut option value for lane-local experiments and partial evidence handling.

Decision: rejected.

### Option B: keep profit windows and tighten route-time TTLs and thresholds

Pros:

- smallest implementation delta;
- preserves current status and scheduler wiring.

Cons:

- still leaves authority in live reducers and remote fetches;
- still does not settle realized post-cost outcomes per hypothesis;
- still makes stale truth and missing truth collapse together too often.

Decision: rejected.

### Option C: hypothesis vaults plus post-cost profit tapes fed by local authority mirrors

Pros:

- moves capital authority onto durable, replayable objects;
- lets each hypothesis carry its own guardrails, funding state, and falsification history;
- keeps final trading economics local to Torghut while consuming Jangar authority asynchronously.

Cons:

- adds new tables, mirror ingestion, and parity work;
- requires a staged cutover because status, scheduler, and promotion paths all consume gate payloads today.

Decision: selected.

## Decision

Adopt **Option C**.

Torghut will settle lane-local authority through `hypothesis_vaults`, `profit_tapes`, and local `authority_mirrors`.
Jangar remains the producer of typed external authority, but Torghut stops treating live remote calls as the final
economic source of truth.

## Architecture

### 1. Hypothesis vaults

Add additive persistence:

- `trading_hypothesis_vaults`
  - `hypothesis_vault_id`
  - `hypothesis_id`
  - `lane_id`
  - `account_label`
  - `lane_book_id`
  - `active_profit_window_id`
  - `active_authority_mirror_ids_json`
  - `latest_profit_tape_id`
  - `capital_state` (`observe`, `repair_probe`, `canary`, `live`, `scale`, `quarantine`)
  - `capital_cap_bps`
  - `max_window_loss_bps`
  - `empirical_valid_until`
  - `quant_coverage_min_ratio`
  - `market_context_max_staleness_seconds`
  - `status` (`funded`, `partially_funded`, `underfunded`, `falsified`, `expired`, `quarantined`)
  - `reason_codes_json`
  - `opened_at`
  - `updated_at`
  - `closed_at`

Rules:

- every active hypothesis/account pair has exactly one active vault;
- a vault may enter `repair_probe` only when its active profit window is at least partially funded and the missing
  authority inputs are marked probe-eligible by policy;
- `canary`, `live`, and `scale` require a funded vault plus one settled tape satisfying the hypothesis promotion
  contract.

### 2. Post-cost profit tapes

Add additive persistence:

- `trading_profit_tapes`
  - `profit_tape_id`
  - `hypothesis_vault_id`
  - `profit_window_id`
  - `account_label`
  - `window_start`
  - `window_end`
  - `decision_count`
  - `submitted_order_count`
  - `filled_order_count`
  - `gross_edge_bps`
  - `slippage_cost_bps`
  - `fees_cost_bps`
  - `post_cost_expectancy_bps`
  - `max_drawdown_bps`
  - `avg_abs_slippage_bps`
  - `quant_latest_metrics_count`
  - `quant_stage_count`
  - `market_context_freshness_seconds`
  - `feature_batch_rows_total`
  - `empirical_job_staleness_seconds`
  - `schema_lineage_warning_count`
  - `clickhouse_freshness_fallback_total`
  - `projection_watermark_digest`
  - `status` (`settled`, `partial`, `falsified`, `expired`, `quarantined`)
  - `reason_codes_json`
  - `settled_at`

Rules:

- tapes are append-only and become the only promotion/demotion evidence for a closed window;
- a tape can be `partial` when observation quality is adequate for learning but not for capital expansion;
- any tape that settles with stale empirical evidence, empty quant latest-store authority, or contradictory projection
  digests may inform diagnostics but may not fund higher capital states.

### 3. Local authority mirrors

Add additive persistence:

- `trading_authority_mirrors`
  - `authority_mirror_id`
  - `authority_kind` (`jangar_dependency_quorum`, `jangar_quant_health`, `jangar_market_context`, `jangar_recovery_warrant`)
  - `source_ref`
  - `source_url`
  - `source_digest`
  - `watermark_id`
  - `observed_at`
  - `expires_at`
  - `status` (`fresh`, `degraded`, `expired`, `quarantined`)
  - `reason_codes_json`
  - `payload_json`

Rules:

- `/trading/status`, `/readyz`, scheduler entry, and promotion evaluation must read mirrors, not remote URLs, on the
  hot path;
- mirror updates may be sourced from typed Jangar endpoints or stream delivery, but every update must produce a
  watermark and digest;
- if mirror freshness expires, only vaults that require that authority kind degrade.

### 4. Measurable hypotheses and guardrails

The implementation must settle the existing three runtime hypotheses against tapes instead of only against route-time
reducers:

1. `H-CONT-01` continuation momentum
   - may enter `canary` only if settled `post_cost_expectancy_bps >= 6`, `avg_abs_slippage_bps <= 12`,
     `quant_coverage_min_ratio >= 0.99`, and empirical evidence is fresh for the declared trial horizon.
2. `H-MICRO-01` microstructure breakout
   - may leave `blocked` only if feature-row and drift evidence are present in the tape and `post_cost_expectancy_bps`
     stays positive under the stricter slippage ceiling already declared in the manifest.
3. `H-REV-01` event reversion
   - may not leave `shadow` when market-context freshness is above its contract threshold, even if the rest of the
     gate is healthy.

Cross-hypothesis guardrails:

1. portfolio-wide blocking occurs only when every active vault is underfunded or falsified;
2. stale empirical jobs freeze live/canary expansion but still permit observation if the vault policy allows it;
3. empty quant latest-store authority is a hard block for any vault that requires fresh quant coverage;
4. missing execution correlation or idempotency on new settlement rows is a rollback trigger for tape authority.

### 5. Surface contracts

- `/trading/status`
  - returns active `hypothesis_vault_id`, `profit_window_id`, `latest_profit_tape_id`, and mirror watermarks per
    hypothesis/account.
- `/readyz`
  - reports whether required mirrors are fresh enough for the active vaults it is summarizing.
- scheduler
  - reads vault state plus promotion contracts from the latest settled tape, not only from live state reducers.
- promotion and rollback logic
  - consume settled tape outcomes and mirror digests;
  - may not widen capital on a vault whose latest tape is `partial`, `expired`, or `quarantined`.

### 6. Validation and rollout gates

Engineer-stage minimum validation:

1. regression proving `/trading/status`, `/readyz`, scheduler, and promotion code surface the same
   `hypothesis_vault_id` and `latest_profit_tape_id`;
2. regression proving `/trading/status.last_decision_at` matches the newest persisted decision row once mirrors and
   tapes are authoritative;
3. regression proving a typed quant-health route result with `latestMetricsCount=0` and `emptyLatestStoreAlarm=true`
   produces an underfunded or partial vault rather than a generic route-time ambiguity;
4. regression proving stale empirical jobs remain visible as expired inputs and cannot fund `canary` or `live`;
5. regression proving `torghut_clickhouse_guardrails_last_scrape_success=0`, `nan` freshness gauges, or
   `MEMORY_LIMIT_EXCEEDED` freshness reads demote only affected vaults and never fund `repair_probe`, `canary`, or
   `live`;
6. regression proving forecast `readyz=503` demotes only hypotheses that require that forecast capability;
7. regression proving route-time Jangar fetches are removed from the hot path once mirrors are authoritative;
8. regression proving new execution settlement rows include correlation and idempotency keys before tapes are allowed
   to fund capital progression.

Deployer-stage acceptance gates:

1. shadow-write mirrors, vaults, and tapes for one full market session before enforcement;
2. show stable parity between mirrors and the old live fetch path during shadow mode;
3. keep `repair_probe`, `canary`, and `live` blocked whenever freshness receipts are `nan`, exporter scrape success is
   `0`, or direct bounded freshness reads still fail;
4. keep `canary` and `live` blocked until one full session of settled tapes proves hypothesis-local eligibility;
5. treat any mismatch between gate payload and settled tape authority as a rollback trigger during cutover.

## Rollout plan

Phase 0. Write-only.

- emit authority mirrors, vaults, and profit tapes alongside the current shared gate;
- surface them in `/trading/status` without changing promotion logic.

Phase 1. Shadow settlement.

- settle tapes for each closed window using existing decision, execution, empirical, and mirror inputs;
- compare mirror-driven vault decisions to the legacy shared gate and record mismatches.

Phase 2. Enforce vault-funded capital.

- keep `observe` and bounded `repair_probe` available where policy permits;
- require settled funded tapes before any `canary`, `live`, or `scale` transition.

Phase 3. Remove hot-path remote authority.

- remove route-time dependency on Jangar status and quant-health fetches for status and promotion;
- keep mirrors and tape settlement as the only production authority path.

## Rollback plan

- keep the current shared gate readable during Phases 0-2 for parity and emergency fallback;
- if mirror settlement diverges materially from observed lane safety, revert capital authority to the prior gate,
  continue writing mirrors and tapes for forensics, and do not delete them;
- if settled tapes are missing execution lineage or disagree with funded vault state after enforcement, revert to
  shadow-only capital and mark affected vaults `quarantined`.

## Risks and open questions

- mirror lag can create false underfunding if watermark freshness is too strict;
- tape settlement can become too coarse if one window hides materially different intraday conditions;
- additive economic objects will grow quickly and require compaction or tiered retention;
- old execution rows without correlation lineage need a clear backfill or quarantine policy.

## Handoff to engineer and deployer

Engineer handoff:

- add the mirror, vault, and tape persistence plus parity projections;
- wire scheduler and promotion logic to settled tapes instead of live remote fetches;
- add the parity, quant-latest-store, stale-empirical, and settlement-lineage tests listed above.

Deployer handoff:

- keep the contract shadow-only through one full market session first;
- do not widen any hypothesis beyond `repair_probe` until settled funded tapes prove eligibility;
- treat mirror drift, missing settlement lineage, or portfolio-wide blocking caused by one degraded authority kind as a
  rollback condition until vault-local behavior is proven.
