# 50. Torghut Hypothesis Capital Governor and Data Quorum (2026-03-19)

Status: Ready for merge (discover architecture lane)
Date: `2026-03-19`
Owner: Victor Chen (Jangar Engineering Architecture)
Related mission: `codex/swarm-jangar-control-plane-discover`
Swarm impact: `torghut-quant`
Companion doc:

- `49-jangar-control-plane-authority-ledger-and-expiry-watchdog-2026-03-19.md`

## Executive summary

Torghut currently exposes a profitability control contradiction:

- runtime readiness reports `live_submission_gate.allowed = true` with capital stage `0.10x canary`
- the same readiness payload reports `hypotheses_total = 3`, all in `shadow`, with `promotion_eligible_total = 0`
- Jangar quant control-plane health reports `status = degraded`, `latestMetricsCount = 0`, and `emptyLatestStoreAlarm = true`
- the active strategy snapshot returns an empty metric frame

The architecture change in this document is to insert a **Hypothesis Capital Governor** between hypothesis readiness and any non-shadow capital stage. The governor combines fresh quant evidence, dependency segment health, and hypothesis eligibility into a single capital decision that can be audited and rolled back.

## Assessment snapshot

### Cluster health and rollout evidence

Fresh runtime evidence captured during this discover run:

- `kubectl get pods -n torghut -o wide`
  - `torghut-options-catalog` in `CrashLoopBackOff`
  - `torghut-options-enricher` in `CrashLoopBackOff`
  - `torghut-options-ta` in `ImagePullBackOff`
  - `torghut-ws-options` running but with high restart churn
- `kubectl get events -A --field-selector type=Warning --sort-by='.lastTimestamp' | tail -n 80`
  - recurring readiness/liveness failures and backoff restarts remain live in the Torghut surface

### Runtime data and database evidence

`curl -fsS http://torghut.torghut.svc.cluster.local/readyz | jq ...` showed:

- `dependencies.database.schema_current = true`
- expected/current migration head `0024_simulation_runtime_context`
- migration lineage warnings still exist because parent forks are present in the schema graph
- `alpha_readiness.state_totals = {"shadow": 3}`
- `alpha_readiness.promotion_eligible_total = 0`
- `live_submission_gate.allowed = true`
- `live_submission_gate.capital_stage = "0.10x canary"`

Direct read-only data-store checks showed:

- Torghut Postgres (`torghut-db-app`)
  - `alembic_version = 0024_simulation_runtime_context`
  - `trade_decisions = 29700`, `max(created_at) = 2026-03-19T17:44:25.133Z`
  - `executions = 3`, `max(created_at) = 2026-03-14T19:17:43.858Z`
  - `torghut_options_watermarks.max(last_success_ts) = 2026-03-11T01:08:11.973Z`
- Torghut ClickHouse (`torghut-clickhouse`)
  - `ta_signals.engine = ReplicatedReplacingMergeTree`, `max(event_ts) = 2026-03-19 17:45:13`
  - `ta_microbars.engine = ReplicatedReplacingMergeTree`, `max(event_ts) = 2026-03-19 17:45:13`

`curl -fsS 'http://jangar.jangar.svc.cluster.local/api/torghut/trading/control-plane/quant/health?account=paper&window=15m'`
returned:

- `status = "degraded"`
- `latestMetricsUpdatedAt = null`
- `latestMetricsCount = 0`
- `emptyLatestStoreAlarm = true`
- `stages = []`

`curl -fsS 'http://jangar.jangar.svc.cluster.local/api/torghut/trading/control-plane/quant/snapshot?strategy_id=4b0051ba-ae40-43c1-9d8b-ad5a57a2b8f6&account=paper&window=15m'`
returned:

- `metrics = []`
- `alerts = []`

### Source architecture and test gaps

Current code already has useful building blocks:

- `services/torghut/app/trading/hypotheses.py`
  - computes per-hypothesis state, capital stage, promotion eligibility, rollback requirement
- `services/torghut/app/main.py`
  - builds `live_submission_gate` from hypothesis summary, empirical jobs, and dependency quorum
- `services/jangar/src/routes/api/torghut/trading/control-plane/quant/health.ts`
  - exposes freshness alarms and empty metric store state
- `services/jangar/src/routes/api/torghut/trading/control-plane/quant/snapshot.ts`
  - exposes concrete frame payloads and alerts

The missing piece is not instrumentation. The missing piece is a single policy layer that says:

- empty quant evidence means no capital beyond shadow
- segment-local failures demote only the affected hypotheses
- readiness cannot declare a live gate without a matching evidence-backed capital decision

## Problem framing

1. Capital stage decisions are still vulnerable to contradictions between readiness, hypothesis summary, and quant metric freshness.
2. Segment-local failures in Torghut options/data services do not yet translate into explicit per-hypothesis capital demotion rules, even when Postgres watermarks and runtime pods are stale while ClickHouse TA ingestion is fresh.
3. Profitability evidence exists, but it is not packaged as a governor contract with immutable acceptance and rollback criteria.
4. Database schema health alone is being interpreted too generously; a current schema does not mean current trading evidence.

## Architecture alternatives

### Option A: tighten thresholds inside existing hypothesis logic only

Pros:

- smallest implementation delta
- reuses current state model

Cons:

- still leaves multiple endpoints responsible for final capital truth
- still weak on auditability and segment scoping

### Option B: force global live gate off whenever any quant metric surface is degraded

Pros:

- simple safety improvement

Cons:

- too coarse
- turns local options/data incidents into portfolio-wide freezes

### Option C: add a Hypothesis Capital Governor with segment-aware data quorum

Pros:

- preserves local failure isolation
- makes capital allocation explicitly evidence-driven
- gives deployer-stage rollout and rollback a deterministic source of truth

Cons:

- requires explicit contract plumbing across Torghut and Jangar read surfaces

## Decision

Adopt **Option C**.

The March 19 runtime picture is clear: schema health and dependency quorum are not sufficient for profitability promotion. Capital stage must be constrained by fresh quant evidence and matched hypothesis state.

## Proposed architecture

### 1. Hypothesis Capital Governor

Introduce a governor that produces a single record per hypothesis family:

- `governor_decision_id`
- `hypothesis_id`
- `strategy_family`
- `segment_dependencies`
- `data_quorum_state`
- `capital_state`
- `reason_codes`
- `evidence_bundle_refs`
- `expires_at`

`capital_state` becomes the only deployable capital truth:

- `shadow`
- `observe`
- `0.10x canary`
- `0.25x canary`
- `0.50x live`
- `1.00x live`
- `rollback_required`

No other endpoint may synthesize a more permissive capital state than the governor.

### 2. Data quorum before capital quorum

The governor must refuse any non-shadow capital stage when one of these is true:

- `latestMetricsCount == 0`
- `emptyLatestStoreAlarm == true`
- quant `stages` is empty for the required evaluation window
- active strategy frame contains no metrics
- required dependency segment is `blocked` or `hold`

This is the core contract change: **schema-current is necessary, but not sufficient**.

### 3. Segment-scoped dependency mapping

Attach each hypothesis to explicit dependency segments, for example:

- `market-context`
- `ta-core`
- `options-data`
- `execution`
- `empirical`
- `llm-review`

If `options-data` is degraded, only the hypotheses that declare `options-data` are demoted to `observe` or `shadow`. Unrelated hypotheses may stay eligible.

This reduces blast radius while staying economically honest.

### 4. Measurable hypothesis acceptance windows

The governor must evaluate each hypothesis across at least two windows:

- `freshness window`
  - metrics present, route coverage present, update lag within policy
- `performance window`
  - sample count, slippage, expectancy, rejection ratio, and continuity pass

Baseline policy contract:

- freshness:
  - `latestMetricsCount > 0`
  - required frame window non-empty
  - no missing-update alarm during active session
- performance:
  - `promotion_eligible_total > 0`
  - effect size above manifest threshold
  - no guardrail breach for two consecutive windows

If freshness fails, performance is not even evaluated for promotion.

### 5. Portfolio guardrails

Add portfolio-level brakes above the per-hypothesis governor:

- maximum simultaneous non-shadow hypotheses per regime
- maximum capital concentration per strategy family
- forced `observe` mode if two governor decisions expire without fresh evidence renewal
- automatic rollback if a live hypothesis loses data quorum for two consecutive windows

This keeps stale evidence from quietly inheriting live capital.

### 6. Immutable evidence bundles

Each governor decision must reference an immutable evidence bundle containing:

- hypothesis summary snapshot
- quant health snapshot
- frame snapshot identifiers
- dependency segment summary
- live submission gate payload
- decision timestamp and expiry

Engineer and deployer stages then reason from the same bundle rather than different endpoints.

## Validation gates

Engineer gates:

- add tests in `services/torghut/app` for:
  - `promotion_eligible_total = 0` forces `capital_state = shadow|observe`
  - empty metric store blocks any non-shadow capital stage
  - degraded dependency segment demotes only affected hypotheses
- add tests in `services/jangar/src/routes/api/torghut/trading/control-plane/quant/health.ts`
  - freshness failures map cleanly into governor inputs
- add status contract tests proving `live_submission_gate` cannot report a more permissive state than the governor

Deployer gates:

- no move to `0.10x canary` unless a fresh governor decision exists
- one induced empty-metrics drill must demote the affected hypothesis to `shadow` or `observe`
- one segment-local options outage drill must leave unrelated hypotheses eligible while demoting affected ones
- rollback evidence must include the precise failing freshness or performance window

## Rollout plan

1. Add governor record schema and read model.
2. Emit governor decision alongside current readiness and alpha-readiness payloads.
3. Switch `live_submission_gate` to consume the governor decision rather than raw summary fields.
4. Enable per-segment demotion in canary before enabling portfolio-level capital guardrails.

## Rollback plan

If the governor proves too strict in early rollout:

- keep collecting governor decisions
- demote consumption to advisory-only
- preserve non-shadow decisions only when both existing and governor paths agree

Rollback must never discard the evidence bundles that justified a previous demotion or hold.

## Risks and tradeoffs

- stricter freshness requirements can reduce trading throughput during data turbulence
- segment mapping adds contract maintenance overhead
- more explicit capital state means more deployer discipline

Mitigations:

- ship default dependency maps per strategy family
- use expiry-based renewal so stale evidence naturally ages out
- stage rollout with observe-only governance first

## Engineer and deployer handoff contract

Engineer must deliver:

1. governor data model and decision builder
2. segment dependency mapping for each live hypothesis family
3. live gate consumption of governor outputs
4. regression coverage for empty metrics, empty frames, and segment-local demotion
5. evidence bundle emission and retention

Deployer must validate:

1. capital stage never advances when quant evidence is empty or stale
2. segment-local outages only demote dependent hypotheses
3. portfolio guardrails can force observe/rollback without global shutdown
4. every live-capital decision is backed by a fresh evidence bundle

## Success criteria

- no hypothesis can reach non-shadow capital with empty quant evidence
- live submission gate and hypothesis summary cannot contradict each other
- segment-local failures reduce blast radius instead of freezing the whole portfolio
- capital decisions become explicit, measurable, and auditable
