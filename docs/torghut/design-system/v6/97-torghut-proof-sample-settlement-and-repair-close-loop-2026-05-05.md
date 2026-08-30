# 97. Torghut Proof Sample Settlement and Repair Close Loop (2026-05-05)

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

Torghut should make the control-plane proof feed settleable. The producer route should emit a deterministic sample id,
sample digest, freshness clock, route-budget receipt, source refs, and repair candidates. Jangar should be able to cite
that sample even when its own consumer read times out or disagrees.

The latest read-only evidence shows why this matters. Torghut is not simply down: the latest revision returned root and
`/healthz` successfully; `/db-check` proved Alembic head `0029_whitepaper_embedding_dimension_4096`; ClickHouse
guardrails reported both replicas reachable and not read-only; `/trading/empirical-jobs` exposed stale but truthful
March proof; `/trading/profitability/runtime` showed eight recent rejected decisions and no executions; `/trading/status`
later answered through Istio in about 1.4 seconds. Jangar nevertheless had a status sample where empirical services
were degraded as `torghut status unavailable`.

I am choosing a settleable producer sample over more route-specific patches. The system should not need a direct
database exec privilege or a perfect monolithic status sample to know the profitable next action. It should be able to
say: proof is stale, capital is held, and the next zero-notional repair is empirical refresh or quant-health
configuration.

The tradeoff is that Torghut owns another API surface and a digest contract. I accept that because profitability work
needs proof that is cheap, reproducible, and auditable across Jangar and Torghut.

## Evidence Snapshot

All assessment for this pass was read-only.

### Cluster Evidence

- The Torghut namespace was accessible for pod listing, service listing, jobs, events, and HTTP service reads.
- Direct Deployment, endpoint, CNPG cluster, and pod exec access were forbidden to
  `system:serviceaccount:agents:agents-sa`. The architecture must not require those privileges for normal assessment.
- `kubectl get pods -n torghut -o wide` showed core runtime pods running: Postgres, ClickHouse, Keeper, live Torghut,
  sim Torghut, Flink job managers and task managers, websocket pods, options catalog/enricher, guardrail exporters, and
  Alloy.
- `torghut-00224-deployment-787547645-x4phf` and `torghut-sim-00305-deployment-6c6d68799c-t2kvc` were both
  `2/2 Running`.
- Torghut events showed the latest live and sim revisions became ready after startup/readiness probe failures.
- Torghut events repeatedly warned that ClickHouse pods match multiple PodDisruptionBudgets and that the keeper PDB has
  no matching pods.
- `kubectl get jobs -n torghut` showed only `torghut-empirical-artifacts-retention-29632577` as a recent completed job;
  no fresh empirical repair job was active.

### Data and Route Evidence

- `GET /` on the latest private revision returned service `torghut`, version `v0.568.5-65-gb65302e2b`, and commit
  `b65302e2b561f5fdf93f15ccf7bb95450801dadc`.
- `GET /healthz` returned HTTP 200.
- `GET /readyz` returned HTTP 503 with structured degraded state, not an opaque failure.
- Readiness dependencies showed Postgres OK, ClickHouse OK, Alpaca live broker OK, DB schema current, empirical jobs
  degraded, live submission blocked, and quant evidence not configured.
- `GET /db-check` returned `ok=true`, current and expected Alembic head `0029_whitepaper_embedding_dimension_4096`,
  no missing heads, no unexpected heads, one current head, lineage-ready state, and parent-fork warnings that are known
  schema history rather than current drift.
- `GET /trading/health` returned three hypotheses, zero promotion-eligible hypotheses, three rollback-required
  hypotheses, `simple_submit_disabled`, shadow capital, and dependency quorum blocked by `empirical_jobs_degraded`.
- `GET /trading/empirical-jobs` returned stale jobs `benchmark_parity`, `foundation_router_parity`, `janus_event_car`,
  and `janus_hgrm_reward`. Each job was completed, truthful, persisted as empirical authority, promotion-authority
  eligible, associated with candidate `intraday_tsmom_v1@prod`, dataset `torghut-full-day-20260318-884bec35`, and March
  21 S3 artifacts.
- `GET /trading/profitability/runtime` returned a 72-hour window with 8 decisions, 0 executions, 0 TCA samples, and all
  recent AAPL, AMD, INTC, and NVDA decisions rejected by `microbar-volume-continuation-long-top2-v11`.
- ClickHouse guardrail metrics reported two reachable replicas, no read-only replicated tables, free-disk ratios above
  0.96, successful last scrape, and fresh TA timestamps.
- The ClickHouse guardrail exporter also showed prior low-memory freshness fallback counters. That is a useful route
  budget signal and should be carried into proof samples.
- LLM guardrail metrics reported scrape success, LLM disabled, effective shadow mode active, compliant policy
  resolution, no active policy violation, and incomplete governance evidence.
- Options catalog `/healthz` returned `ready=true` while `last_success_ts` was null and `last_error_detail` referenced a
  timeout. Ready state alone is not enough proof for trading authority.

### Jangar Consumer Evidence

- Jangar control-plane status reported healthy controller heartbeats, healthy runtime adapters, healthy watch
  reliability, healthy rollout health, and healthy database migration consistency.
- Jangar execution trust was degraded because the Jangar verify stage was stale.
- Jangar dependency quorum was blocked because empirical services were degraded.
- Jangar empirical services still reported `torghut status unavailable` even though Torghut had narrow route evidence
  that classified the state more precisely.
- Runtime kits now found NATS collaboration tooling, so the earlier missing-NATS risk from shared context was resolved
  by the time of this pass.

### Source and Test Evidence

- `services/torghut/app/main.py` is 3,981 lines and owns human status, machine readiness, DB checks, trading status,
  empirical jobs, profitability runtime, TCA, market context, simulation, whitepapers, and live submission. It should
  not be the only machine proof route.
- `services/torghut/app/trading/empirical_jobs.py` already produces stale/truthful/lineage classifications.
- `services/torghut/app/trading/hypotheses.py` already produces hypothesis counts, promotion eligibility, rollback
  requirements, and dependency quorum reasons.
- `services/torghut/app/trading/submission_council.py` already treats quant-health as a typed evidence input and holds
  capital when it is missing or unhealthy.
- `services/jangar/src/server/control-plane-empirical-services.ts` currently maps a failed Torghut status read into
  degraded empirical services.
- Existing Torghut tests cover empirical jobs, DB schema checks, hypothesis quorum, submission council, trading API
  payloads, profitability runtime, quant readiness, and route parity. The missing target is a producer sample compiler
  and digest parity tests against the existing routes.

## Problem

Torghut has enough evidence to be safe, but not enough settleable proof to be profitable.

The current state is safe because capital is held: live submit is disabled, empirical jobs are stale, quant evidence is
not configured, and no hypotheses are promotion eligible. The current state is less profitable because the repair queue
is not first-class. Four stale empirical jobs and eight recent rejected decisions should automatically become a ranked
zero-notional repair plan. Instead, Jangar can flatten that detail into `torghut status unavailable`.

The problem is not a missing health endpoint. It is missing proof settlement across producer and consumer:

- Torghut can prove stale empirical lineage through narrow routes.
- Jangar can observe a route failure and lose that lineage.
- Operators can see ready pods while proof remains stale.
- Data guardrails can be healthy while capital remains correctly held.
- Repair work is possible but not represented as a bounded action class.

Torghut needs a producer-owned sample that captures the proof state before Jangar interprets it.

## Alternatives Considered

### Option A: Keep Improving `/trading/status`

Cache expensive sections, tighten slow calls, and keep Jangar pointed at the aggregate status route.

Pros:

- Improves a useful human route.
- Avoids another endpoint.
- Reduces some transient Jangar degradation.

Cons:

- Keeps Jangar coupled to a broad route.
- Does not produce a digest or settle producer-vs-consumer disagreement.
- Still makes repair ranking dependent on one request-time aggregate.
- Ready route, status route, guardrail metrics, and proof routes can still disagree with no settlement object.

Decision: reject as the architecture. `/trading/status` should remain useful, but not be the authority boundary.

### Option B: Materialize Only Empirical Job Proof

Expose a compact empirical-job route and have Jangar consume it before the full proof-feed work exists.

Pros:

- Directly addresses the current stale job issue.
- Small implementation surface.
- Good first migration step.

Cons:

- Ignores database schema, profitability runtime, hypothesis state, guardrail exporter health, and live submission.
- Does not handle quant-health configuration or options/data route budgets.
- Does not create a single sample id for capital warrants and repair receipts.

Decision: use as a seed inside the broader producer sample, not as the final contract.

### Option C: Settleable Control-Plane Proof Sample

Torghut emits one compact proof sample. The sample includes route-budget metadata, source route refs, digest, freshness,
capital posture, and zero-notional repair candidates.

Pros:

- Lets Jangar and Torghut cite the same sample id.
- Makes stale proof actionable without allowing capital.
- Preserves least-privilege operation.
- Gives deployers a deterministic gate for rollout and rollback.
- Turns data freshness and route-cost facts into repair inputs.

Cons:

- Adds compiler and fixtures.
- Requires digest stability across services.
- Adds another freshness clock that must be monitored.

Decision: select Option C.

## Chosen Architecture

### Producer Route

Add:

```text
GET /trading/control-plane/proof-sample
```

The route returns a compact JSON payload. It must be bounded, deterministic, and safe to call frequently.

```text
torghut_control_plane_proof_sample
  schema_version
  sample_id
  sample_digest
  generated_at
  fresh_until
  active_revision
  producer_commit
  route_budget
  database_schema
  empirical_jobs
  hypothesis_summary
  profitability_runtime
  live_submission_gate
  quant_evidence
  data_guardrails
  repair_candidates
  source_route_refs
```

The route does not mutate database records, submit orders, launch jobs, or call broker order APIs.

### Route Budget

The producer owns route-budget accounting:

```text
route_budget
  budget_ms
  elapsed_ms
  timed_out_sections
  fallback_sections
  low_memory_sections
  source_status
  cache_state
  reason_codes
```

Current evidence should map low-memory ClickHouse freshness fallbacks into `low_memory_sections` and the options catalog
timeout detail into `source_status`, not into a global outage.

### Data Guardrails

The sample carries compact data state:

```text
data_guardrails
  postgres_schema_current
  postgres_schema_head
  schema_lineage_ready
  clickhouse_replicas_reachable
  clickhouse_readonly_replicas
  clickhouse_freshness
  guardrail_scrape_success
  llm_governance_evidence_complete
  options_catalog_ready
  options_catalog_last_success
```

This lets Jangar know that Postgres and ClickHouse can be healthy while empirical proof remains stale and capital must
stay held.

### Repair Candidates

The sample ranks repair candidates:

```text
repair_candidate
  repair_id
  repair_kind
  action_class
  stale_subjects
  affected_hypotheses
  expected_gate_reopened
  expected_net_edge_delta_bps
  proof_cost_budget
  max_runtime_minutes
  capital_impact
  reason_codes
```

Initial candidates for the current state:

- Refresh empirical jobs for `intraday_tsmom_v1@prod` on `torghut-full-day-20260318-884bec35`.
- Configure and verify quant-health source URL for the live account/window.
- Repair Jangar verify freshness before allowing swarm plan, implement, or verify material actions.
- Re-evaluate rejected AAPL, AMD, INTC, and NVDA decisions with zero-notional route attribution.

Every candidate starts with `capital_impact=none`. Paper or live capital can only be considered after fresh producer and
consumer settlement closes the relevant gates.

### Digest Rules

- `sample_digest` is computed from canonical JSON excluding volatile transport fields.
- `sample_id` includes the active revision, generated-at bucket, and digest prefix.
- `source_route_refs` include route name, observed time, status code, and source digest for `/db-check`,
  `/trading/empirical-jobs`, `/trading/profitability/runtime`, `/trading/health`, and guardrail metrics.
- If a source route is unavailable, the sample remains valid but marks that source unavailable and holds capital.
- If required sources contradict each other, the sample sets `proof_contradictory` and Jangar must hold repair and
  capital.

### Capital Rules

- Fresh producer sample alone never allows paper or live capital.
- Capital requires fresh producer sample, matching Jangar consumer receipt, fresh empirical jobs, configured healthy
  quant evidence, live submission gate allow, and no execution-trust hold.
- Stale empirical jobs can allow repair but cannot allow capital.
- Quant evidence `not_required` is diagnostic-only for non-capital paths; capital requires an explicit configured
  source.

## Implementation Scope

Engineer stage should implement:

1. `app/trading/control_plane_proof_sample.py` as a pure compiler.
2. `GET /trading/control-plane/proof-sample` in `app/main.py`, calling existing helpers rather than duplicating
   database logic.
3. Unit tests for canonical digest stability, stale empirical jobs, database schema current, quant evidence missing,
   route-budget fallback, and repair candidate ranking.
4. Trading API tests proving `/trading/status`, `/trading/health`, `/trading/empirical-jobs`, and the proof sample
   agree on empirical job state and live submission gate posture.
5. A fixture matching the May 5 evidence: three hypotheses, zero promotion eligibility, four stale empirical jobs,
   eight recent rejected decisions, no executions, current DB schema, ClickHouse guardrail OK, capital held.

The implementation must not change order submission behavior.

## Validation Gates

Required Torghut tests:

- `uv run --frozen pytest tests/test_empirical_jobs.py tests/test_submission_council.py tests/test_trading_api.py`
- New proof-sample tests covering digest stability and source-route parity.
- `uv run --frozen pyright --project pyrightconfig.json`
- `uv run --frozen pyright --project pyrightconfig.alpha.json`
- `uv run --frozen pyright --project pyrightconfig.scripts.json`
- `uv run --frozen ruff check app tests scripts`

Manual validation after rollout:

- `GET /trading/control-plane/proof-sample` returns under the configured budget.
- The payload includes sample id, digest, fresh-until, source route refs, and repair candidates.
- `sample_digest` is stable across repeated reads when source evidence has not changed.
- Jangar status cites the same sample id and either a matching consumer receipt or a precise disagreement class.
- Paper and live submission remain held in the current state.

## Rollout Plan

1. Shadow route: deploy the producer route and expose it only to Jangar and operators. Do not change Jangar quorum.
2. Parity window: compare proof sample with `/trading/status`, `/trading/health`, `/trading/empirical-jobs`, and
   `/trading/profitability/runtime` for seven trading sessions.
3. Repair mode: allow Jangar to use repair candidates for zero-notional empirical refresh and quant-health repair.
4. Quorum mode: Jangar replaces status-route empirical service classification with sample settlement.
5. Capital mode: after sustained parity and fresh proof, allow capital gates to require sample settlement. Do not allow
   capital from the sample alone.

## Rollback

- Disable the proof-sample route with a feature flag or return `503 proof_sample_disabled`.
- Keep `/trading/status`, `/trading/health`, `/trading/empirical-jobs`, and `/db-check` unchanged.
- Jangar falls back to its prior status reader, with capital held.
- If digest parity fails, continue serving the route as diagnostic-only and set `proof_contradictory`.
- If the compiler creates route pressure, increase sampling interval and rely on cached source refs; do not widen
  capital while cache is stale.

## Risks

- Digest instability can create false mismatch. Mitigation: canonical JSON tests and volatile-field exclusions.
- Route budget accounting can hide slow source routes. Mitigation: every fallback and timeout is explicit in
  `route_budget`.
- Repair candidates can look like trading recommendations. Mitigation: `capital_impact` must be explicit and default to
  `none`.
- The first proof route can duplicate existing helper logic. Mitigation: call existing helper functions and test parity
  against existing routes.
- Least-privilege assessors cannot query databases directly. Mitigation: the producer route must expose enough schema,
  freshness, and lineage evidence for read-only assessment.

## Handoff

Engineer acceptance gate: the proof-sample route returns a compact, deterministic payload for the current degraded
state and ranks zero-notional repair while keeping capital held.

Deployer acceptance gate: after rollout, Jangar and Torghut cite the same sample id and digest. A rollout cannot widen
because pods are ready; it widens only after proof-sample settlement allows the relevant action class.

Owner acceptance gate: Torghut Traders can point to one sample and know whether the next profitable action is empirical
refresh, quant-health repair, Jangar verify repair, or continued capital hold.
