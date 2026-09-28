# 49. Jangar Control-Plane Execution Truth Spine and Torghut Profit Circuit (2026-03-19)

Status: Approved for implementation (`plan`)
Date: `2026-03-19`
Owner: Victor Chen (Jangar Engineering)
Mission: `codex/swarm-jangar-control-plane-plan`
Swarm: `jangar-control-plane`

Supersedes:

- `docs/agents/designs/47-jangar-control-plane-resilience-and-torghut-profitability-architecture-2026-03-16.md`
- `docs/agents/designs/48-jangar-control-plane-resilience-and-torghut-profitability-implementation-contract-2026-03-16.md`
- `docs/torghut/design-system/v6/47-torghut-quant-plan-merge-contract-and-handoff-implementation-2026-03-16.md`
- `docs/torghut/design-system/v6/48-torghut-quant-discover-implementation-readiness-and-handoff-contract-2026-03-16.md`

## Executive summary

The March 16 contracts correctly identified stage staleness, rollout ambiguity, and profitability-governance drift, but
the live system on March 19 shows a more specific failure shape:

- Jangar still converts one stale stage into a whole-swarm freeze and deletes all stage schedules.
- Swarm-run execution can fail on Codex auth refresh before any stage-level logic becomes useful.
- Huly collaboration is a hard dependency in practice, yet its dedicated-worker account probe times out at the
  transactor account endpoint.
- Torghut profitability APIs expose stale or degraded data, but the live scheduler and candidate-governance paths still
  permit weaker or shared-evidence promotion semantics than the architecture expects.
- The options lane is boot-coupled to database auth and image availability, so it fails before it can publish a clean
  readiness contract.

The selected architecture replaces "whole swarm healthy or frozen" with an execution-truth spine and replaces
"shared profitability status" with a lane-local profit circuit. The result is narrower blast radius, safer rollout
behavior, and measurable promotion guardrails that match the runtime actually in production.

## Mission inputs and success criteria

Observed mission inputs:

- repository: `proompteng/lab`
- base: `main`
- head: `codex/swarm-jangar-control-plane-plan`
- swarmName: `jangar-control-plane`
- swarmStage: `plan`
- ownerChannel: `swarm://owner/platform`

Success for this artifact is:

1. current cluster, source, and database/data state captured with concrete evidence;
2. ambitious system-level alternatives considered and one chosen;
3. implementation scope made explicit enough for engineer and deployer stages to execute without reopening the design;
4. rollout, rollback, and validation gates defined in testable terms.

## Live assessment snapshot

### Cluster health, rollout, and events

Read-only evidence collected on `2026-03-19`:

- `kubectl -n agents get swarm jangar-control-plane torghut-quant -o json`
  - both swarms report `phase=Frozen`;
  - `jangar-control-plane.status.freeze.until=2026-03-11T16:36:12.630Z`;
  - `torghut-quant.status.freeze.until=2026-03-11T16:36:17.456Z`;
  - the stored freeze deadline is already in the past, but the swarms remain frozen;
  - `jangar-control-plane.status.requirements.pending=5` and `queuedNeeds=5`.
- `kubectl -n agents logs pod/jangar-swarm-verify-template-step-1-attempt-1-d867z`
  - failed with `refresh_token_reused` / `Your access token could not be refreshed because your refresh token was already used`.
- `kubectl -n agents logs pod/torghut-swarm-plan-template-step-1-attempt-1-c9rn5`
  - failed with the same `refresh_token_reused` auth path.
- `kubectl -n torghut get pods`
  - `torghut-options-catalog` and `torghut-options-enricher` in `CrashLoopBackOff`;
  - `torghut-options-ta` in `ImagePullBackOff`;
  - `torghut-ws-options` repeatedly restarting;
  - core `torghut`, `torghut-ta`, ClickHouse, and Postgres pods still running.
- `kubectl -n torghut get events --sort-by=.lastTimestamp`
  - repeated readiness/liveness failures in the options and Knative surfaces;
  - backoff and image-pull failures are live, not historical.

Interpretation:

- Jangar has a stale freeze-state problem, not merely a legitimate active freeze.
- The current freeze model is too coarse: one stale stage or auth failure freezes all stage schedules.
- Torghut is operating in a mixed-state world where the core runtime remains available while several profitability
  adjuncts are broken. The control-plane must understand that difference explicitly.

### Source architecture and high-risk modules

Jangar implementation surfaces most relevant to the current failure shape:

- `services/jangar/src/server/supporting-primitives-controller.ts`
  - stage staleness promotes to whole-swarm freeze;
  - frozen swarms delete every stage schedule;
  - requirement dispatch is skipped whenever freeze is active.
- `services/jangar/src/server/control-plane-status.ts`
  - `executionTrust` exists, but top-level blocked reasons are still not reliably mapped to segment ownership.
- `services/jangar/scripts/codex/codex-implement.ts`
  - active Huly channel resolution already prefers `swarmRequirementChannel`, then `hulyChannelName`, then
    `hulyChannelUrl`, but collaboration success still depends on a blocking account probe.
- `services/jangar/src/server/torghut-market-context.ts` and
  `services/jangar/src/server/torghut-market-context-agents.ts`
  - provider health, domain health, and risk flags already exist and can become first-class execution-truth inputs.
- `services/jangar/src/server/torghut-quant-metrics.ts` and
  `services/jangar/src/server/torghut-quant-metrics-store.ts`
  - current quant health derives `ta_freshness_seconds`, `context_freshness_seconds`, and
    `metrics_pipeline_lag_seconds` from live data paths.

Torghut implementation surfaces most relevant to the current failure shape:

- `services/torghut/app/trading/scheduler/pipeline.py`
  - live submission can remain materially weaker than the richer readiness gate exposed by `/trading/status`.
- `services/torghut/app/main.py`
  - readiness/status computes stronger dependency-quorum and empirical-readiness requirements than the live scheduler
    consumes today.
- `services/torghut/app/trading/hypotheses.py`
  - profitability evidence is still compiled from a shared runtime snapshot rather than hypothesis-local windows.
- `services/torghut/app/trading/autonomy/lane.py` and
  `services/torghut/app/trading/completion.py`
  - candidate-scoped persistence allows multiple matched hypotheses to contaminate one another's proof windows;
  - `continuity_ok` is flattened to dependency-quorum allow/deny rather than a separate continuity contract.
- `services/torghut/app/options_lane/catalog_service.py`,
  `services/torghut/app/options_lane/enricher_service.py`,
  `services/torghut/app/options_lane/repository.py`
  - both services write DB rate-bucket defaults at module import time, which turns DB auth drift into boot failure.

Current missing-test pattern:

- no regression that proves a stale stage can be isolated while unrelated stages continue;
- no parity test that forces the scheduler and status API to agree on live-submission eligibility;
- no regression that proves hypothesis windows remain isolated when one candidate matches multiple hypotheses;
- no regression that proves continuity can fail independently of dependency quorum.

### Database and data-state assessment

Direct pod exec and CNPG cluster reads are RBAC-blocked from this identity, so the assessment uses read-only logs,
runtime APIs, and source schema surfaces rather than in-pod SQL.

Read-only evidence collected:

- `curl http://jangar.jangar.svc.cluster.local/api/torghut/symbols`
  - returns `12` active symbols (`AAPL`, `AMAT`, `AMD`, `AVGO`, `GOOG`, `INTC`, `META`, `MSFT`, `MU`, `NVDA`, `PLTR`,
    `SHOP`).
- `curl http://jangar.jangar.svc.cluster.local/api/torghut/market-context/health`
  - `overallState=down`;
  - technicals and regime domains are `error`;
  - fundamentals freshness is `618808s` and stale;
  - news freshness is `251995s` and stale;
  - ClickHouse ingestion reports `clickhouse_query_failed`.
- `curl http://jangar.jangar.svc.cluster.local/api/torghut/market-context/providers/fundamentals?symbol=NVDA`
  - last successful fundamentals snapshot is `2026-03-12T13:43:18Z`.
- `curl http://jangar.jangar.svc.cluster.local/api/torghut/market-context/providers/news?symbol=NVDA`
  - last successful news snapshot is `2026-03-16T13:37:07Z`;
  - returned risk flags include `market_context_stale`.
- `curl http://jangar.jangar.svc.cluster.local/api/torghut/trading/control-plane/quant/health?...`
  - `status=degraded`;
  - `metricsPipelineLagSeconds=18`;
  - `missingUpdateAlarm=true`;
  - both ingestion stages show `lagSeconds=300`.
- `curl http://jangar.jangar.svc.cluster.local/api/torghut/trading/control-plane/quant/snapshot?...`
  - `metrics_pipeline_lag_seconds=300`;
  - `ta_freshness_seconds=4`;
  - `context_freshness_seconds=32`;
  - most profitability metrics are still `insufficient_data` or stale.
- `curl http://jangar.jangar.svc.cluster.local/api/torghut/trading/control-plane/quant/alerts`
  - open critical alerts for `metrics_pipeline_lag_seconds` across `1m`, `5m`, `15m`, `1h`, `1d`, `5d`, and `20d`;
  - open warning alert for `sharpe_annualized` below threshold.
- `kubectl -n torghut logs pod/torghut-options-catalog-...`
  - `password authentication failed for user "torghut_app"`.
- `kubectl -n torghut logs pod/torghut-options-enricher-...`
  - same `torghut_app` auth failure.

Interpretation:

- Torghut does not have a single data outage. It has a split condition:
  - TA freshness is good;
  - market-context freshness and ClickHouse-backed context ingestion are degraded;
  - quant materialization still runs, but its ingestion inputs lag;
  - options-lane services fail before steady-state due DB auth and image issues.
- The database/data contract therefore must become lane-local and component-local, not one global "Torghut ready" bit.

### Huly collaboration assessment

Required Huly dedicated-worker checks were attempted with:

- `--require-worker-token`
- `--token-env-key HULY_API_TOKEN_VICTOR_CHEN_JANGAR_ARCHITECT`
- `--require-expected-actor-id`
- `--expected-actor-env-key HULY_EXPECTED_ACTOR_ID_VICTOR_CHEN_JANGAR_ARCHITECT`

Observed result:

- both `list-channel-messages` and `verify-chat-access` timed out in `build_context(...)` while calling
  `GET /api/v1/account/c9b87368-e7a2-483f-885f-ff179e258950` on
  `http://transactor.huly.svc.cluster.local`;
- unauthenticated reachability of the transactor host is fine (`curl /api/version` returns promptly), so this is an
  authenticated account-read timeout, not DNS failure or a missing env var.

Interpretation:

- collaboration is currently a blocking dependency with opaque failure semantics;
- that failure must be represented as a segment in the execution-truth spine instead of being allowed to freeze or stall
  unrelated work silently.

## Problem statement

The current system is still organized around optimistic coupling:

1. any stale stage can freeze the whole swarm;
2. collaboration/auth problems are discovered late and block complete mission delivery;
3. Torghut profitability readiness is exposed through richer APIs than the live scheduler actually enforces;
4. hypothesis and completion evidence remain partially shared across lanes;
5. data readiness for TA, market context, execution, and options is not modeled as separate contracts.

That coupling is now the main reliability risk. The design goal is not "more dashboards." The goal is to change the
control topology so failures degrade the right scope and rollout only advances when the same truth contract is green in
every surface that matters.

## Alternatives considered

### Option A: patch the existing freeze and alert thresholds

Description:

- keep the whole-swarm freeze model;
- retune stale thresholds and alert windows;
- add more runbook steps for auth and collaboration failures.

Pros:

- lowest implementation cost;
- minimal schema churn.

Cons:

- does not address stale historical freeze entries;
- preserves whole-swarm blast radius;
- leaves the scheduler/status parity problem unsolved;
- keeps profitability evidence shared and ambiguous.

Decision: rejected.

### Option B: move to a global hard gate across all surfaces

Description:

- require Jangar, Huly, Codex auth, Torghut, market context, and options data to all be green before any stage or
  rollout continues.

Pros:

- simple to reason about;
- maximizes safety in the short term.

Cons:

- too coarse for mixed-state production systems;
- collaboration or options-lane issues would block unrelated Jangar planning or deployment work;
- fails the mission objective of reducing explicit failure modes by scope.

Decision: rejected.

### Option C: execution-truth spine plus lane-local profit circuit

Description:

- introduce a single execution-truth model with segment ownership, TTL-based leases, scoped holds, and explicit
  evidence refs;
- make Torghut profitability a lane-local contract keyed by strategy, hypothesis, account, and evidence window;
- unify scheduler and status API gating;
- move options-lane bootstrap from import-time DB writes into an explicit readiness contract.

Pros:

- matches the live failure pattern;
- reduces blast radius without hiding hard blockers;
- creates measurable rollout, rollback, and profitability promotion semantics.

Cons:

- requires schema, controller, and test work in both Jangar and Torghut;
- requires vocabulary cleanup across docs and runtime payloads.

Decision: selected.

## Decision

Adopt Option C and make this document the source-of-truth architecture for the current plan lane.

Canonical rollout vocabulary from this point forward:

- Jangar segment states: `allow | hold | block | recover`
- Torghut capital states: `observe | canary | live | scale | quarantine`
- Failure classes: `transient | systemic | critical`

These terms replace mixed historical language such as `shadow`, `pilot`, `full`, `warn`, and implicit "frozen means
everything is blocked" semantics when new implementation work is written.

## Selected architecture

### 1) Jangar execution-truth spine

Create one canonical truth surface consumed by swarm status, readiness, schedule reconciliation, rollout, and
handoff artifacts.

The spine is keyed by `swarm`, `stage`, and `segment`.

Required segments:

- `scheduler`
- `execution_auth`
- `collaboration`
- `requirement_bridge`
- `delivery`
- `rollout`
- `profit_readiness`

Each segment publishes a lease object:

- `segment`
- `scope`: `swarm | stage | lane | strategy`
- `decision`: `allow | hold | block | recover`
- `failureClass`
- `reasonCode`
- `observedAt`
- `expiresAt`
- `ttlSeconds`
- `evidenceRefs[]`
- `owner`: controller/module responsible for the decision

Rules:

- stage staleness produces a stage-scoped `scheduler` lease first;
- a whole-swarm freeze is legal only when:
  - `delivery` or `rollout` is `critical`, or
  - two or more core segments are `systemic`, or
  - operator override explicitly promotes a stage-local hold to swarm-wide block;
- expired freeze entries must self-clear into `recover` instead of persisting an already-expired `Frozen` phase.

Implication:

- Jangar no longer deletes every stage schedule because one stage became stale;
- the affected stage is held, evidence is attached, and unrelated stages can continue when their segment leases are
  still `allow`.

### 2) Collaboration and execution auth become first-class segments

Codex auth refresh and Huly account-read failures are not generic job errors. They are explicit control-plane inputs.

Required behavior:

- `refresh_token_reused` creates a scoped `execution_auth=block` lease for the impacted stage or run family;
- Huly account-read timeout creates `collaboration=hold` unless the mission explicitly requires Huly artifact delivery,
  in which case it becomes `collaboration=block`;
- collaboration failure must never silently freeze unrelated schedules;
- requirement dispatch and PR merge logic must record whether the lane is blocked by collaboration, execution auth, or
  delivery separately.

Implication:

- the system stops conflating "could not post to Huly" with "the entire swarm must remain frozen";
- handoff artifacts can say exactly why a run stopped and what the smallest unblocker is.

### 3) Safe rollout capsule

The rollout capsule consumes the execution-truth spine and is the only authority allowed to advance canary weights,
approve merges, or clear freeze state.

Before advancing rollout:

1. `rollout`, `delivery`, and the relevant stage segment must all be `allow`;
2. `execution_auth` must be `allow`;
3. `collaboration` must be `allow` when the mission requires Huly artifacts;
4. recent evidence bundle must exist for any segment that was in `hold` or `recover` during the last two windows;
5. Torghut profit-readiness must be `allow` for strategies affected by the change.

Evidence bundle contract:

- swarm status snapshot;
- stage/segment lease graph;
- recent failed run references;
- relevant warning events;
- Huly outcome (`success`, `timeout`, `actor mismatch`, `not attempted`);
- PR/CI evidence refs once the change reaches GitHub.

### 4) Torghut profit circuit

Torghut promotion moves to a lane-local contract keyed by:

- `hypothesis_id`
- `strategy_id`
- `candidate_id`
- `account`
- `window`
- `capital_state`

Mandatory rule changes:

- the scheduler and `/trading/status` must consume the same readiness function;
- live submission is impossible unless the same dependency quorum, empirical readiness, and data-readiness inputs say
  `allow`;
- profitability windows are hypothesis-local, not shared across every matched hypothesis;
- completion gates query by `hypothesis_id` and `candidate_id`, not just candidate or stage;
- `continuity_ok` is derived from:
  - dependency quorum,
  - signal continuity,
  - empirical evidence continuity,
  - data freshness continuity,
    each tracked independently.

Capital-state rules:

- `observe`: evidence collection only, no live submission.
- `canary`: `0.10x` or lower capital, but only after two consecutive complete evidence windows.
- `live`: broader live submission for one strategy/account pair.
- `scale`: only after profitability, freshness, and continuity stay green across the configured windows.
- `quarantine`: immediate downgrade state after repeated guardrail or continuity breach.

### 5) Data quality spine for profitability

Torghut readiness is decomposed into lane-specific contracts:

- TA freshness contract
  - authoritative from `ta_freshness_seconds`;
  - good TA freshness alone is not sufficient for live promotion.
- Market-context contract
  - authoritative from domain/provider health plus `market_context_stale`;
  - technicals/regime errors block profit-readiness for strategies that require them.
- Execution/metrics contract
  - authoritative from `metrics_pipeline_lag_seconds`, `trade_count`, `net_pnl`, and profitability windows;
  - open critical lag alerts block `scale`.
- Options-lane contract
  - authoritative from image readiness, DB auth verification, and schema/bootstrap state;
  - options-lane failure must not be hidden inside generic pod health.

Implementation consequence:

- Jangar exposes profit-readiness as a composed contract rather than a single top-level green/red output;
- deployer can promote a strategy only when the specific contracts that strategy depends on are green.

### 6) Options-lane bootstrap redesign

The current options services fail before readiness because `ensure_rate_bucket_defaults(...)` executes at import time
and requires valid DB auth immediately.

Replace that with:

- a bootstrap step or init controller that:
  - verifies image pull,
  - verifies DB auth,
  - verifies required tables/schema fingerprint,
  - seeds rate buckets,
  - writes a bootstrap heartbeat row;
- application startup only marks readiness once bootstrap state is present and fresh;
- auth mismatch becomes an explicit `profit_readiness=block` reason such as `options_db_auth_invalid`, not a generic
  crash loop.

## Implementation scope

### Jangar engineer scope

- `services/jangar/src/server/supporting-primitives-controller.ts`
  - replace whole-swarm freeze with segment-aware hold/block behavior;
  - preserve unaffected stage schedules;
  - write lease/evidence state to status.
- `services/jangar/src/server/control-plane-status.ts`
  - segment attribution for execution-trust reasons;
  - expose canonical segment graph and segment ownership.
- `services/jangar/scripts/codex/codex-implement.ts`
  - collaboration/auth outcomes emitted as structured evidence and segment decisions.
- `services/jangar/src/server/torghut-market-context.ts`
  - expose domain/provider state directly into profit-readiness composition.
- `services/jangar/src/server/torghut-quant-metrics*.ts`
  - expose lane-local readiness decisions, not only raw metric rows.

### Torghut engineer scope

- `services/torghut/app/trading/scheduler/pipeline.py`
  - import and enforce the same gate that status APIs use.
- `services/torghut/app/main.py`
  - factor readiness into shared policy surface.
- `services/torghut/app/trading/hypotheses.py`
  - compile profitability per hypothesis, not per shared snapshot.
- `services/torghut/app/trading/autonomy/lane.py`
  - persist hypothesis-local windows and continuity dimensions separately.
- `services/torghut/app/trading/completion.py`
  - query completion state by hypothesis/candidate/window.
- `services/torghut/app/options_lane/*`
  - move bootstrap out of import time and publish explicit readiness reasons.

## Validation gates

### Engineering gates

Required targeted regressions:

- Jangar:
  - one stale stage produces `scheduler=hold` for that stage and does not delete unrelated schedules;
  - `execution_auth=block` is visible in the segment graph;
  - `collaboration=hold|block` is visible with exact reason code and evidence refs;
  - expired freeze state transitions to `recover` or `allow`.
- Torghut:
  - scheduler and `/trading/status` must agree on live-submission eligibility;
  - profitability evidence remains isolated when one candidate matches multiple hypotheses;
  - continuity can fail even when dependency quorum still allows;
  - options-lane DB auth or image failure surfaces as explicit readiness reason rather than crash-only state.

Suggested smallest commands:

- `bun run --filter @proompteng/jangar test -- src/server/__tests__/supporting-primitives-controller.test.ts -t "stale stage cadence"`
- `bun run --filter @proompteng/jangar test -- src/server/__tests__/control-plane-status.test.ts -t "execution trust"`
- `python -m pytest services/torghut/tests/test_trading_pipeline.py -k "live_submission"`
- `python -m pytest services/torghut/tests/test_hypotheses.py -k "compile_hypothesis_runtime_statuses"`
- `python -m pytest services/torghut/tests/test_completion_trace.py -k "doc29_completion_status"`
- `python -m pytest services/torghut/tests/test_autonomous_lane.py -k "persist_hypothesis_governance_rows"`

### Deployer gates

Cluster/runtime acceptance:

1. One stale Jangar stage does not globally freeze the swarm.
2. A Codex auth failure blocks only the impacted stage family.
3. Huly timeout is surfaced explicitly and does not silently erase stage schedules.
4. `metrics_pipeline_lag_seconds` must stay within threshold for the promoted window before `scale`.
5. Open critical lag alerts or `market_context.overallState=down` block live capital expansion.
6. Options-lane promotion is impossible while DB auth/image bootstrap is red.

## Rollout plan

1. Add the lease schema and additive API fields first. No enforcement yet.
2. Switch scheduler/status API parity for Torghut live-submission gating.
3. Enable stage-local holds in Jangar while keeping whole-swarm freeze behind a feature flag.
4. Move options-lane bootstrap into explicit readiness state.
5. Turn on enforcement for `canary`, then `live`, then `scale`.

## Rollback plan

- If segment attribution or lease expiry misbehaves, disable execution-truth enforcement and fall back to additive
  status-only mode while preserving written evidence.
- If scheduler/status parity causes false negatives, revert to `observe` capital state for the affected strategies only.
- If options bootstrap produces false blocks, disable the bootstrap gate and keep the lane in `observe`, not `live`.
- If Huly remains unavailable, keep collaboration-segment blocking explicit and continue merging only for lanes where
  Huly is not a runtime acceptance requirement.

## Risks and mitigations

Risk: vocabulary drift across old docs and runtime payloads.

Mitigation:

- use the canonical terms in this document for all new fields;
- map legacy states explicitly rather than inventing new synonyms.

Risk: too many segment states create operator confusion.

Mitigation:

- keep segment list small and fixed;
- require every blocked state to include one owner and one reason code.

Risk: lane-local profitability windows increase schema and test surface.

Mitigation:

- prefer additive keys and composite indexes over replacing existing rows in place;
- land parity tests before enabling live enforcement.

## Handoff to engineer

Engineer acceptance is complete only when:

1. the execution-truth spine exists as a concrete schema/API contract;
2. stage-local hold versus swarm-wide block is test-covered;
3. scheduler/status API parity is enforced in Torghut;
4. hypothesis/candidate completion evidence is isolated by hypothesis id;
5. options-lane bootstrap publishes explicit readiness reasons instead of crash-only failure.

## Handoff to deployer

Deployer acceptance is complete only when:

1. one isolated stale stage proves unaffected stages still schedule;
2. one forced collaboration or auth fault shows explicit segment blocking with evidence refs;
3. no strategy reaches `scale` while market context is `down` or quant lag alerts remain open;
4. options-lane readiness proves image + DB auth + schema bootstrap before any options capital state exceeds
   `observe`;
5. rollback from `canary` or `live` to `observe` / `quarantine` is deterministic and auditable.
