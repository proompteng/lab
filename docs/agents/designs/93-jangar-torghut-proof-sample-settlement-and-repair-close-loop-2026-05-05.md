# 93. Jangar Torghut Proof Sample Settlement and Repair Close Loop (2026-05-05)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-05
Owner: Gideon Park, Torghut Traders
Scope: Jangar control-plane resilience, Torghut proof-feed consumption, route-budget reconciliation, repair authority,
capital holdbacks, and safe rollout gates.

Companion Torghut contract:

- `docs/torghut/design-system/v6/97-torghut-proof-sample-settlement-and-repair-close-loop-2026-05-05.md`

Extends:

- `92-jangar-torghut-proof-feed-route-budget-and-quorum-split-2026-05-05.md`
- `91-jangar-evidence-warrants-and-lane-local-quorum-2026-05-05.md`
- `90-jangar-proof-capacity-leases-and-route-slo-governor-2026-05-05.md`
- `docs/torghut/design-system/v6/96-torghut-control-plane-proof-feed-and-profit-route-budget-contract-2026-05-05.md`

## Decision

Jangar should implement **TorghutProofSampleSettlement** before it enforces the proof-feed split. The previous proof-feed
decision is still the right direction, but the latest evidence changes the failure mode: Torghut's route can answer
while Jangar's empirical-services projection still reports `torghut status unavailable`. That is a sampling and
settlement problem, not proof absence.

The design is to record two facts for every Torghut proof read:

1. the **producer sample** that Torghut says it generated, including digest, freshness, route budget, and source route
   refs;
2. the **consumer receipt** that Jangar observed, including URL, timeout, status code, latency, body digest, and the
   decision class Jangar derived from that sample.

Jangar then settles the pair into one action-class result: `serve`, `repair`, `discover`, `plan`, `implement`,
`verify`, `paper_capital`, and `live_capital`. A consumer timeout is no longer allowed to erase Torghut's own stale but
truthful empirical proof if a fresh producer sample is available. Capital still fails closed. Repair gets a bounded
allow decision when the settled sample proves what is stale and what zero-notional action can refresh it.

The tradeoff is one more durable object and one more digest comparison. I accept that because the control plane's next
six-month risk is false global blocking and unactionable degradation, not the cost of an additional compact receipt.

## Evidence Snapshot

All assessment for this pass was read-only.

### Cluster and Rollout Evidence

- `kubectl config current-context` was unset, but the in-cluster service account could list namespaces and pods.
- The worker identity was `system:serviceaccount:agents:agents-sa`.
- `kubectl get pods -n jangar -o wide` showed `jangar-7766b4456b-q6jv8` at `2/2 Running`; Jangar DB, Redis, Bumba,
  OpenWebUI, Symphony, and Alloy pods were also running.
- `kubectl get pods -n agents -o wide` showed `agents-c46bccb7c-jmpnx` and two
  `agents-controllers-7cb5bfc595-*` pods at `1/1 Running`.
- `kubectl get agentruns -n agents` showed active Jangar and Torghut swarm runs, plus recent failed Torghut discover and
  verify runs. That means the control-plane workflow is moving, but failures are still present in the recent window.
- `kubectl get pods -n torghut -o wide` showed the latest live `torghut-00224` and sim `torghut-sim-00305` revisions at
  `2/2 Running`; the earlier sim image-pull failure from shared NATS context was no longer active.
- Torghut events still showed repeated ClickHouse multiple-PDB warnings and a keeper PDB with no matching pods.
- The service account could list pods, but it could not list Torghut Deployments, CNPG clusters, endpoints, or create
  `pods/exec`. Direct database exec and direct ClickHouse exec were therefore not available for this assessment.

### Jangar Evidence

- `GET http://jangar.jangar.svc.cluster.local/health` returned HTTP 200 with `status="ok"`.
- `GET /api/agents/control-plane/status` returned HTTP 200.
- Jangar leader election was enabled and healthy; the current leader was `jangar-7766b4456b-q6jv8`.
- Controller heartbeats for `agents-controller`, `supporting-controller`, and `orchestration-controller` were healthy
  and fresh.
- Runtime adapters for `workflow` and `job` were configured and available; the Temporal adapter was also configured.
- Runtime kits were healthy. The collaboration kit found `/usr/local/bin/codex-nats-publish`,
  `/usr/local/bin/codex-nats-soak`, `nats`, `/app/services/jangar`, and `NATS_URL`.
- Execution trust remained `degraded` because `jangar-control-plane:verify` was stale. Serving admission was degraded,
  and swarm plan, implement, and verify admission were held on `execution_trust_degraded`.
- Jangar database migration consistency was healthy: registered and applied migrations both counted 25, with latest
  migration `20260418_embedding_dimension_4096`.
- Dependency quorum was `block` because empirical services were degraded.
- Jangar empirical services pointed at `http://torghut.torghut.svc.cluster.local/trading/status` and reported
  `torghut status unavailable`.

### Torghut Evidence

- `GET http://torghut-00224-private.torghut.svc.cluster.local:8012/` returned HTTP 200 with service `torghut`,
  version `v0.568.5-65-gb65302e2b`, commit `b65302e2b561f5fdf93f15ccf7bb95450801dadc`.
- `GET /healthz` returned HTTP 200 with `status="ok"`.
- `GET /readyz` returned HTTP 503, but with structured evidence: Postgres OK, ClickHouse OK, Alpaca live broker OK,
  DB schema current, empirical jobs degraded, live submission blocked by `simple_submit_disabled`, and quant evidence
  not configured.
- `GET /db-check` returned `ok=true`, current and expected Alembic head `0029_whitepaper_embedding_dimension_4096`,
  one current head, no missing heads, no unexpected heads, lineage-ready state, and known parent-fork warnings.
- `GET /trading/health` returned HTTP 503 with `status="degraded"`, three hypotheses, zero promotion-eligible
  hypotheses, three rollback-required hypotheses, shadow capital, and dependency quorum blocked by
  `empirical_jobs_degraded`.
- `GET /trading/empirical-jobs` returned HTTP 200 with `ready=false`, `status="degraded"`, `authority="blocked"`, stale
  jobs `benchmark_parity`, `foundation_router_parity`, `janus_event_car`, and `janus_hgrm_reward`.
- Those stale jobs were completed, truthful, persisted as empirical authority, promotion-authority eligible, tied to
  dataset `torghut-full-day-20260318-884bec35`, candidate `intraday_tsmom_v1@prod`, and March 21 S3 artifacts.
- `GET /trading/profitability/runtime` returned a 72-hour window with 8 decisions, 0 executions, 0 TCA samples, and all
  recent AAPL, AMD, INTC, and NVDA decisions rejected.
- `GET http://torghut.torghut.svc.cluster.local/trading/status` later returned HTTP 200 through Istio with
  `x-envoy-upstream-service-time: 1398`. This confirms the problem is not simply "Torghut down"; Jangar needs a
  settlement record that explains what it sampled and how the sample was classified.
- ClickHouse guardrail exporter metrics reported both replicas reachable, both free-disk ratios above 0.96, no
  read-only replicated tables, fresh `ta_signals` and `ta_microbars` timestamps, and successful last scrape.
- LLM guardrail exporter metrics reported scrape success, LLM disabled, effective shadow mode active, compliant policy
  resolution, and incomplete governance evidence.
- Options catalog `/healthz` returned `ready=true`, but also `last_success_ts=null` and a previous timeout detail. This
  is another example of why ready state and useful proof state need separate sample receipts.

### Source and Test Evidence

- `services/jangar/src/server/control-plane-empirical-services.ts` currently performs one Torghut status read and maps
  failure to degraded empirical services.
- `services/jangar/src/server/control-plane-status.ts` already has the aggregation boundary where settled Torghut proof
  can be projected into dependency quorum, runtime admission, and action-class decisions.
- `services/jangar/src/server/control-plane-runtime-admission.ts` already expresses consumer classes such as serving and
  swarm stages; Torghut proof settlement should reuse that action-class vocabulary instead of inventing a new global
  health flag.
- `services/torghut/app/main.py` is 3,981 lines and still owns too many operator and machine proof routes. That makes it
  a poor high-frequency authority surface.
- `services/torghut/app/trading/empirical_jobs.py`, `services/torghut/app/trading/hypotheses.py`, and
  `services/torghut/app/trading/submission_council.py` already expose the proof ingredients Jangar needs.
- Existing tests cover control-plane empirical services, control-plane status, runtime admission, Torghut quant runtime,
  Torghut trading DB configuration, empirical jobs, hypothesis quorum, live submission gates, and trading API payloads.
- Missing tests: producer-vs-consumer sample disagreement, status-route timeout with narrow proof available, digest
  mismatch, stale empirical proof with repair allowed and capital held, and execution-trust hold independent of Torghut
  proof state.

## Problem

The system has moved past basic liveness. The current failure mode is split-brain evidence classification.

Jangar can say Torghut empirical services are unavailable while Torghut can answer narrow proof routes with enough
detail to rank repairs. That creates two losses:

- Jangar blocks dependency quorum for a broad reason without preserving the specific stale proof lineage;
- Torghut cannot use its stale-but-truthful proof to open zero-notional repair lanes, because the consumer sees only a
  failed aggregate read.

That is bad for reliability and profitability. Reliability suffers because global control-plane state becomes sensitive
to one route sample. Profitability suffers because blocked capital is not converted into the highest-value repair work.

The control plane needs to distinguish five states:

- Torghut producer proof is fresh and Jangar sampled it successfully.
- Torghut producer proof is fresh but Jangar's sample failed or timed out.
- Torghut producer proof is stale but truthful and can name repair candidates.
- Torghut producer proof is missing or contradictory.
- Jangar execution trust is degraded independently of Torghut proof.

The current status projection collapses those states.

## Alternatives Considered

### Option A: Increase Jangar Torghut Status Timeout

Raise `JANGAR_TORGHUT_STATUS_TIMEOUT_MS` and keep using `/trading/status`.

Pros:

- Minimal implementation effort.
- Likely reduces transient `torghut status unavailable` messages.
- Keeps one endpoint for existing status consumers.

Cons:

- Preserves the broad authority problem.
- Converts slow proof into slow control-plane status.
- Does not produce a digest or consumer receipt.
- Does not distinguish "producer proof stale" from "consumer sample failed."

Decision: reject as the architecture. Timeout tuning can be a temporary mitigation only.

### Option B: Jangar Fanout to Narrow Torghut Routes

Have Jangar call `/db-check`, `/trading/empirical-jobs`, `/trading/profitability/runtime`, and `/trading/health`
directly.

Pros:

- Uses routes that answered during the assessment.
- Recovers empirical job lineage quickly.
- Avoids waiting for a new Torghut producer route.

Cons:

- Moves composition and partial-failure logic into Jangar.
- Increases route pressure during degraded windows.
- Different consumers can observe different samples.
- Still lacks a producer digest and sample-set settlement record.

Decision: use as a bootstrap path behind the settlement contract, not as the final authority model.

### Option C: Proof Sample Settlement

Torghut emits a compact proof sample. Jangar records its consumer receipt. A settlement function converts the pair into
action-class decisions and durable reasons.

Pros:

- Separates producer proof from consumer route health.
- Preserves stale empirical lineage even when Jangar's read fails.
- Keeps capital fail-closed while allowing bounded repair.
- Produces audit evidence that engineer and deployer stages can test.
- Supports least-privilege operation because no direct database exec is required.

Cons:

- Adds a new table or materialized cache.
- Requires digest compatibility between Torghut and Jangar.
- Needs careful adoption so existing status displays keep working.

Decision: select Option C.

## Chosen Architecture

### TorghutProofProducerSample

Jangar expects Torghut to expose or materialize a compact producer sample:

```text
torghut_proof_producer_sample
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
  guardrail_exporters
  repair_candidates
  source_route_refs
```

The sample must be deterministic for the same source evidence and generated-at bucket. It is a proof projection, not an
order authority.

### JangarTorghutConsumerReceipt

For every read attempt, Jangar records:

```text
jangar_torghut_consumer_receipt
  receipt_id
  sample_id
  requested_url
  requested_at
  timeout_ms
  status_code
  latency_ms
  transport_error
  body_digest
  producer_digest
  parsed_schema_version
  consumer_revision
  decision_before_settlement
```

If the request times out, Jangar still records a receipt with `transport_error=timeout` and no body digest.

### TorghutProofSampleSettlement

The settlement result is the durable authority object:

```text
torghut_proof_sample_settlement
  settlement_id
  producer_sample_id
  consumer_receipt_id
  settlement_digest
  settled_at
  action_class_results
  disagreement_class
  blocked_reasons
  repair_allow_reasons
  capital_hold_reasons
  next_required_sample
```

Action classes:

- `serve`: Jangar and Torghut dashboards may serve degraded views when producer or consumer proof is stale but not
  contradictory.
- `repair`: allowed when producer proof is stale but truthful and repair candidates are zero-notional.
- `discover`: allowed when execution trust permits read-only assessment and proof is not contradictory.
- `plan`, `implement`, `verify`: held when Jangar execution trust is degraded, independent of Torghut proof state.
- `paper_capital`, `live_capital`: held unless the producer sample is fresh, consumer receipt matches, empirical jobs
  are fresh, quant evidence is configured and healthy, and live submission gate allows the stage.

### Disagreement Classes

Jangar records one of:

- `none`: producer and consumer agree.
- `consumer_timeout`: producer sample was known or later observed, but this Jangar read timed out.
- `producer_stale`: sample exists but `fresh_until` has passed.
- `digest_mismatch`: body digest or sample digest differs between producer and consumer.
- `schema_mismatch`: the payload parsed but did not match a supported schema.
- `proof_absent`: no producer sample and no acceptable fallback route.
- `proof_contradictory`: source route refs disagree on capital posture, empirical lineage, or schema state.

`consumer_timeout` is not a capital allow. It is also not evidence that empirical proof is missing. It opens a sampling
repair lane.

### Quorum Projection

Dependency quorum gets four separate segments:

- `platform_execution`: Jangar leader, controllers, runtime adapters, database, watch reliability, and execution trust.
- `torghut_proof_feed`: producer sample freshness, digest, source route refs, and consumer receipt.
- `torghut_repair`: zero-notional repair candidates and proof cost budget.
- `torghut_capital`: paper/live capital eligibility.

The current evidence would settle as:

- `platform_execution`: degraded because Jangar verify is stale;
- `torghut_proof_feed`: degraded because empirical jobs are stale and quant evidence is not configured;
- `torghut_repair`: allow bounded zero-notional repair for stale empirical jobs and quant-health configuration;
- `torghut_capital`: hold because live submit is disabled, empirical jobs are stale, and promotion eligibility is zero.

## Implementation Scope

Engineer stage should implement the smallest useful closed loop:

1. Add Jangar types for producer sample, consumer receipt, and settlement result.
2. Add a pure settlement function with fixtures for the current May 5 evidence.
3. Teach `control-plane-empirical-services.ts` to consume the proof sample endpoint when configured, with the old status
   route as fallback.
4. Project settled action-class results into `dependency_quorum`, `empirical_services`, and runtime admission.
5. Emit compact status JSON showing producer sample id, consumer receipt id, settlement id, action-class decisions, and
   disagreement class.
6. Keep capital gates fail-closed until Torghut producer sample, Jangar receipt, and settlement are all fresh and
   matching.

No Kubernetes mutation is required for the design implementation. Rollout remains GitOps.

## Validation Gates

Required Jangar tests:

- Status-route timeout with a fresh producer sample results in `consumer_timeout`, not `proof_absent`.
- Stale empirical jobs result in `repair=allow` and `paper_capital/live_capital=hold`.
- Jangar execution trust degraded holds swarm plan, implement, and verify even when Torghut proof feed is fresh.
- Digest mismatch holds all material action classes and reports `digest_mismatch`.
- Missing quant evidence holds capital but does not hide stale empirical job repair candidates.
- Old `/trading/status` fallback still returns the existing degraded empirical-service shape.

Required integration checks:

- `bun run --filter @proompteng/jangar test -- src/server/__tests__/control-plane-empirical-services.test.ts`
- `bun run --filter @proompteng/jangar test -- src/server/__tests__/control-plane-status.test.ts`
- `bun run --filter @proompteng/jangar test -- src/server/__tests__/control-plane-runtime-admission.test.ts`
- `bun run --filter @proompteng/jangar tsc`
- `bun run --filter @proompteng/jangar lint`

Manual deployer smoke:

- Query Jangar control-plane status after rollout.
- Verify it shows the Torghut producer sample id, consumer receipt id, settlement id, and action-class decisions.
- Force the Torghut proof endpoint URL to a blackhole in a non-production environment and confirm the result is
  `consumer_timeout` with capital held.
- Restore the endpoint and confirm the next sample clears timeout disagreement without restarting Jangar.

## Rollout Plan

1. Shadow write: compute settlement in memory and expose it under a debug/status field. Do not change dependency quorum.
2. Observability: add settlement ids and disagreement classes to Jangar status, NATS progress, and dashboard tiles.
3. Repair projection: allow repair to read settled stale-proof candidates while capital remains held.
4. Quorum projection: replace empirical-service `torghut status unavailable` with settled proof-feed reasons.
5. Capital readiness: only after Torghut producer and Jangar consumer are fresh and matching for seven consecutive
   trading sessions, allow capital gates to consume the settlement result.

## Rollback

- Disable proof sample settlement with a feature flag and fall back to the existing status-route reader.
- Keep all capital action classes held while the flag is disabled.
- Preserve consumer receipts for audit; do not delete settlement rows during rollback.
- If settlement storage fails, serve the last status route result as diagnostic-only and emit `proof_settlement_store_unavailable`.
- If digest mismatch rate rises, hold repair and capital while serving dashboards degraded.

## Risks

- Producer and consumer clocks can disagree. Mitigation: settle on producer `fresh_until` plus Jangar receipt time and
  record both.
- The first implementation can overfit to current stale empirical jobs. Mitigation: fixture the May 5 state, but model
  all fields generically.
- Route fanout during bootstrap can add pressure. Mitigation: Torghut feed producer owns fanout; Jangar reads one
  compact route once the feed exists.
- Operators may confuse repair allow with capital allow. Mitigation: action-class names must be visible and capital
  results must always include blocked reasons.

## Handoff

Engineer acceptance gate: Jangar must classify the current state as execution-trust degraded, proof-feed degraded,
repair allowed for zero-notional empirical refresh, and capital held. A status route timeout must not be reported as
missing empirical proof when a producer sample exists.

Deployer acceptance gate: after rollout, Jangar status must expose one producer sample id, one consumer receipt id, one
settlement id, and action-class decisions. Rollout widening must not proceed from pod readiness alone.

Owner acceptance gate: Torghut Traders can read one Jangar status payload and understand whether the next action is
repairing stale proof, fixing Jangar verify freshness, or holding capital.
