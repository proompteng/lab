# 61. Torghut Evidence Seats and Profit Repair Exchange Contract (2026-03-20)

Status: Approved for implementation (`discover`)
Date: `2026-03-20`
Owner: Gideon Park (Torghut Traders)
Mission: `codex/swarm-torghut-quant-discover`
Swarm impacts:

- `torghut-quant`
- `jangar-control-plane`

Companion doc:

- `docs/agents/designs/62-jangar-execution-receipts-and-stage-recovery-cells-contract-2026-03-20.md`

Extends:

- `60-torghut-hypothesis-passports-and-capability-quote-auction-contract-2026-03-20.md`
- `60-torghut-hypothesis-passports-and-profit-guardrail-admission-contract-2026-03-20.md`
- `59-torghut-lane-balance-sheet-and-dataset-seat-auction-contract-2026-03-20.md`

## Executive summary

The decision is to replace Torghut's coarse route-time trading gate with two durable objects: **Evidence Seats** and a
**Profit Repair Exchange**.

The live evidence from `2026-03-20` shows why:

- `GET http://torghut.torghut.svc.cluster.local/trading/status`
  - reports `live_submission_gate.blocked_reasons` including `quant_health_fetch_failed`;
  - reports `quant_evidence.source_url="http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status?account=PA3SX7FYNUTF&window=15m"`;
  - reports all three hypotheses in `shadow` or `blocked`.
- `GET http://torghut.torghut.svc.cluster.local/trading/health`
  - reports database healthy and schema current;
  - reports `empirical_jobs.ok=false`;
  - still reports `quant_evidence.detail="quant_health_fetch_failed"`.
- `GET http://jangar.jangar.svc.cluster.local/api/torghut/trading/control-plane/quant/health?account=PA3SX7FYNUTF&window=15m`
  - returns `ok=true`, `status="degraded"`, `latestMetricsCount=36`, `metricsPipelineLagSeconds=9`,
    `maxStageLagSeconds=97061`.
- `kubectl -n torghut get pods`
  - shows main Torghut live revision running;
  - still shows both forecast and forecast-sim surfaces unready.
- `GET http://torghut.torghut.svc.cluster.local/db-check`
  - returns `ok=true`;
  - confirms head `0025_widen_lean_shadow_parity_status`;
  - also reports migration-fork warnings that need to remain visible in trading contracts.
- `services/torghut/app/trading/autonomy/lane.py`
  - still persists `ResearchRun.dataset_snapshot_ref` from `strategy_config_path`;
  - still persists `VNextDatasetSnapshot.artifact_ref` from run-scoped artifact payloads.
- `services/torghut/app/trading/autonomy/evidence.py`
  - still treats continuity largely as row presence across research tables.

The tradeoff is more additive state and stricter capital admission. I am keeping that trade because Torghut is no
longer failing from lack of any evidence. It is failing from mixing fresh and stale evidence into one coarse answer.

## Mission inputs and success criteria

Observed mission inputs:

- repository: `proompteng/lab`
- base: `main`
- head: `codex/swarm-torghut-quant-discover`
- swarmName: `torghut-quant`
- swarmStage: `discover`
- objective: assess cluster, source, and database state and merge architecture artifacts that improve Torghut
  profitability with measurable guardrails

This document succeeds when:

1. every hypothesis lane can cite one `evidence_seat_id`, one `execution_receipt_id`, and one `profit_repair_exchange_id`;
2. Torghut stops falling back from the typed quant-health route to the generic Jangar status endpoint once shadow
   parity proves the typed route is stable;
3. stale forecast, market-context, simulation, or empirical evidence can only clamp the affected lanes instead of
   globalizing all capital to one `observe` answer;
4. the new contract defines measurable profitability hypotheses and hard caps for degraded-mode probe capital.

## Assessment snapshot

### Cluster health, rollout, and runtime evidence

Torghut is operating in a mixed-evidence regime, not a full outage.

- `GET /trading/status`
  - returns HTTP `200`;
  - reports `signal_lag_seconds=7753`;
  - reports `alpha_readiness_blocked_total=1` and `alpha_readiness_shadow_total=2`.
- `GET /trading/health`
  - returns degraded health because empirical jobs and quant evidence are not ready;
  - still shows Postgres, ClickHouse, and Alpaca dependencies healthy.
- `kubectl -n torghut get events --sort-by=.lastTimestamp | tail -n 40`
  - shows forecast readiness failing with HTTP `503`;
  - shows recent startup and liveness failures on the live revision before settling.

Interpretation:

- the main service can still answer and collect evidence;
- the profitability contract remains too coarse to exploit that safely;
- typed evidence needs to become durable before capital logic can become more profitable.

### Source architecture and test-gap evidence

The current source tree keeps too much trading truth in mutable route-time composition.

- `services/torghut/app/trading/submission_council.py`
  - `resolve_quant_health_url()` still falls back from the explicit quant-health URL to generic control-plane or
    market-context URLs;
  - `build_live_submission_gate_payload(...)` still settles one shared gate and one certificate id.
- `services/torghut/app/trading/autonomy/lane.py`
  - still stores dataset truth through mutable local paths and run-scoped artifact refs;
  - cannot yet guarantee that promotion evidence refers to one immutable dataset object.
- `services/torghut/app/trading/autonomy/evidence.py`
  - validates continuity by checking that research rows exist;
  - does not yet prove that the referenced artifacts, ClickHouse batches, and promotion evidence are immutable and
    mutually consistent.
- `services/torghut/app/trading/scheduler/pipeline.py`
  - reuses shared mutable runtime state when building decisions and status surfaces;
  - does not persist seat ids that can be replayed later.
- `services/torghut/app/main.py`
  - exposes `/readyz`, `/trading/status`, and `/trading/health`;
  - does not project one durable evidence-seat or exchange id across all three surfaces.
- `services/torghut/app/options_lane/repository.py`
  - still overwrites watermarks in place on success;
  - cannot yet preserve why a contract was ranked, skipped, or starved as append-only profitability evidence.
- `docs/torghut/design-system/v3/full-loop/05-dataset-feature-versioning-spec.md`
  - already promises a stronger immutable dataset and feature registry than the current source implements.

Architectural test gaps:

- no regression proves the typed quant-health route is mandatory once seat shadow parity is enabled;
- no parity test proves `/readyz`, `/trading/status`, and `/trading/health` expose the same seat ids;
- no regression proves forecast degradation clips only forecast-dependent hypotheses while continuation-style lanes stay
  in bounded probe or shadow states.
- no regression proves mutable dataset paths are rejected once immutable seats become authoritative;
- no regression proves options observations are append-only rather than just current-state watermarks.

### Database, schema, freshness, and consistency evidence

Torghut already has enough persistence to carry richer economic truth.

- `GET /db-check`
  - confirms schema head parity and lineage readiness;
  - still surfaces parent-fork warnings that should become seat-level evidence, not hidden footnotes.
- `GET /trading/status`
  - shows `datasets=null` and `latest_store=null`;
  - makes the missing evidence explicit, but only as route-time emptiness.
- direct typed quant-health route
  - shows fresh compute and materialization stages;
  - also shows `ingestion` lagging by `97061` seconds.

Interpretation:

- the system already knows enough to price evidence quality honestly;
- it does not yet persist that pricing as a contract the runtime and status surfaces can share;
- the next architecture move must therefore be content-addressed evidence and append-only settlement, not more route
  composition.

## Alternatives considered

### Option A: remove the bad quant-health fallback and keep the global gate

Pros:

- smallest implementation delta;
- fixes one correctness bug quickly.

Cons:

- still globalizes mixed evidence;
- still leaves profitability truth in route-time composition;
- does not create measurable degraded-mode learning.

Decision: rejected.

### Option B: move final capital admission into Jangar

Pros:

- one control-plane authority for operators;
- less Torghut-local compiler work.

Cons:

- couples platform runtime truth to trading economics too tightly;
- makes Jangar mistakes more expensive;
- reduces Torghut option value for lane-local experimentation.

Decision: rejected.

### Option C: evidence seats plus profit repair exchange

Pros:

- prices fresh and stale evidence explicitly per lane;
- preserves strict safety while recovering bounded probe value under mixed health;
- gives every status surface one replayable identifier to trust.

Cons:

- adds new tables and compiler logic;
- requires shadow rollout before any capital effect.

Decision: selected.

## Decision

Adopt **Option C**.

Torghut will compile evidence seats for each required evidence surface, then settle a profit repair exchange per lane
that converts those seats and Jangar execution receipts into bounded `observe`, `repair-probe`, `canary`, `live`, or
`quarantine` outcomes.

## Architecture

### 1. Evidence seats

Add additive persistence:

- `trading_evidence_seats`
  - `evidence_seat_id`
  - `hypothesis_id`
  - `lane_id`
  - `seat_kind` (`quant_health`, `market_context`, `forecast`, `simulation`, `empirical_jobs`, `schema_lineage`)
  - `source_ref`
  - `source_url`
  - `content_hash`
  - `manifest_ref`
  - `signal_batch_id`
  - `schema_signature`
  - `freshness_seconds`
  - `quality_score`
  - `status` (`fresh`, `stale`, `missing`, `degraded`)
  - `reason_codes_json`
  - `evidence_digest`
  - `observed_at`
  - `expires_at`

Rules:

- seats are lane-scoped and hypothesis-scoped, not portfolio-global;
- the typed quant-health route becomes the only valid source for `quant_health` seats after shadow parity;
- migration-lineage warnings and stale forecast readiness become explicit seat reasons instead of hidden route details.

Add append-only observation history:

- `trading_options_observation_events`
  - `observation_event_id`
  - `contract_symbol`
  - `event_kind` (`ranked`, `skipped`, `snapshot_succeeded`, `snapshot_failed`, `provider_silent`, `watermark_advanced`)
  - `payload_json`
  - `observed_at`

This lets Torghut separate provider silence from control-plane failure and reuse options evidence in the same exchange
spine as equity lanes.

### 2. Profit repair exchange

Add additive persistence:

- `profit_repair_exchanges`
  - `profit_repair_exchange_id`
  - `hypothesis_id`
  - `lane_id`
  - `execution_receipt_id`
  - `required_evidence_seat_ids_json`
  - `decision` (`observe`, `repair_probe`, `canary`, `live`, `quarantine`)
  - `capital_cap_bps`
  - `loss_cap_bps`
  - `repair_window_minutes`
  - `reason_codes_json`
  - `issued_at`
  - `expires_at`

Rules:

- `repair_probe` is the only degraded-mode capital class;
- `repair_probe` caps must remain below live and canary budgets and never bypass hard blockers;
- `quarantine` is required whenever the execution receipt is blocked or any mandatory seat is missing.

### 3. Runtime projection and profitability hypotheses

Implementation surfaces must consume the new objects:

- `services/torghut/app/trading/submission_council.py`
  - reads evidence seats and exchange ids instead of constructing one shared gate from mutable inputs.
- `services/torghut/app/trading/scheduler/pipeline.py`
  - persists seat ids during decision compilation.
- `services/torghut/app/main.py`
  - exposes shared seat and exchange ids on `/readyz`, `/trading/status`, and `/trading/health`.

Measurable trading hypotheses:

1. typed evidence seats reduce false portfolio-wide blocks by at least `50%` relative to the current shared gate
   while keeping `canary` and `live` blocked whenever any mandatory seat is stale or missing;
2. the profit repair exchange recovers at least `25%` more shadow or repair-probe observation time during mixed
   evidence periods without increasing drawdown beyond the existing paper-mode guardrails;
3. requiring typed quant-health seats eliminates `quant_health_fetch_failed` caused by generic-status fallbacks.

## Validation, rollout, and rollback

Engineer acceptance gates:

1. Add regression coverage proving `resolve_quant_health_url()` stops accepting generic Jangar status URLs once the
   typed seat contract is enabled.
2. Add parity coverage proving `/readyz`, `/trading/status`, and `/trading/health` expose the same
   `evidence_seat_id` and `profit_repair_exchange_id` values.
3. Add lane-scoped tests proving forecast `503` failures degrade only forecast-dependent hypotheses.
4. Add regression coverage proving mutable dataset paths and missing content hashes are rejected once immutable seats
   are authoritative.
5. Add append-only repository coverage proving options observations preserve ranking and snapshot history instead of
   only the latest watermark.

Deployer acceptance gates:

1. `curl -sS http://torghut.torghut.svc.cluster.local/trading/status | jq '.hypotheses.items, .live_submission_gate'`
2. `curl -sS http://torghut.torghut.svc.cluster.local/trading/health | jq '.dependencies, .live_submission_gate'`
3. `curl -sS 'http://jangar.jangar.svc.cluster.local/api/torghut/trading/control-plane/quant/health?account=PA3SX7FYNUTF&window=15m' | jq '.'`
4. no `canary` or `live` exchange while any mandatory seat is `missing`, the paired Jangar execution receipt is
   blocked, or `repair_probe` capital exceeds its configured cap.

Rollout plan:

1. shadow-write evidence seats and exchange ids while the current shared gate remains authoritative;
2. surface ids on status routes and metrics without changing capital decisions;
3. require the typed quant-health route and keep the old fallback only as a logged diagnostic;
4. enable `repair_probe` only after seat parity and cap enforcement are stable in paper mode.

Rollback plan:

- disable exchange enforcement and fall back to the current shared gate;
- keep shadow-writing seats and exchange rows for comparison;
- revert typed-route enforcement only if the explicit quant-health route itself is degraded.

## Risks and open questions

- Seat explosion is a real risk if every low-value observation becomes its own required seat.
- A profitable repair-probe policy needs discipline; without strict caps it becomes live capital by another name.
- Forecast, market-context, and simulation freshness windows must stay hypothesis-specific or the exchange will drift
  back toward a single global gate.
