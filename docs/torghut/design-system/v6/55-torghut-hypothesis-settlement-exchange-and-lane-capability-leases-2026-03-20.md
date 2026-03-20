# 55. Torghut Hypothesis Settlement Exchange and Lane Capability Leases (2026-03-20)

Status: Approved for implementation (`plan`)
Date: `2026-03-20`
Owner: Gideon Park (Torghut Traders)
Mission: `codex/swarm-torghut-quant-plan`
Swarm impacts:

- `torghut-quant`
- `jangar-control-plane`

Companion doc:

- `docs/agents/designs/56-jangar-capability-receipts-and-consumer-binding-contract-2026-03-20.md`

Extends:

- `50-torghut-submission-parity-council-and-options-bootstrap-escrow-2026-03-19.md`
- `53-torghut-capital-leases-and-profit-trial-firebreaks-2026-03-20.md`
- `53-torghut-cross-plane-profit-certificate-veto-and-options-auth-isolation-2026-03-20.md`
- `docs/agents/designs/54-jangar-admission-receipts-rollout-shadow-and-anti-entropy-reconciliation-2026-03-20.md`

## Executive summary

The decision is to move Torghut from ephemeral gate payloads to a **Hypothesis Settlement Exchange** that issues
lane-scoped capability leases. Jangar owns infrastructure and dependency capability receipts; Torghut owns
hypothesis-level capital truth by binding those receipts to local profit evidence, data quality, and lane-specific
bootstrap state.

The reason is concrete in the live system on `2026-03-20`:

- `GET http://torghut.torghut.svc.cluster.local/readyz`
  - returns HTTP `503`
  - shows `schema_current=true`
  - shows `live_submission_gate.ok=false`
  - shows `promotion_eligible_total=0`
  - shows `quant_evidence.reason="quant_health_fetch_failed"`
- `GET http://torghut.torghut.svc.cluster.local/trading/status`
  - returns HTTP `200`
  - shows `build.active_revision="torghut-00155"`
  - shows `live_submission_gate.allowed=false`
  - shows `active_capital_stage="shadow"`
  - shows the quant-evidence source URL as `http://jangar.../api/agents/control-plane/status?...`
- `GET http://torghut.torghut.svc.cluster.local/db-check`
  - reports schema head `0025_widen_lean_shadow_parity_status`
  - still reports migration parent-fork lineage warnings
- `GET http://jangar.jangar.svc.cluster.local/api/torghut/market-context/health?symbol=NVDA`
  - reports `overallState="degraded"`
  - reports `bundleFreshnessSeconds=38149`
  - reports stale technicals, fundamentals, news, and regime domains
- `GET http://torghut-clickhouse-guardrails-exporter.torghut.svc.cluster.local:9108/metrics`
  - shows elevated `freshness_fallback_total` for `ta_signals` and `ta_microbars`
- `kubectl get pods -n torghut -o wide`
  - shows core Torghut revision healthy
  - shows forecast pods not ready
  - shows options catalog and enricher in `CrashLoopBackOff`
  - shows options TA in `ImagePullBackOff`
- `kubectl logs -n torghut torghut-options-catalog-...`
  - ends with `password authentication failed for user "torghut_app"`
- `kubectl logs -n torghut torghut-options-enricher-...`
  - ends with the same DB auth failure

The tradeoff is more explicit persistence, stricter startup config validation, and lane-scoped lease expiry. That is
worth paying because the current failure mode is local convenience: wrong endpoints, boot crashes, and mixed evidence
all collapse into one coarse gate payload.

## Mission inputs and success criteria

Observed mission inputs:

- repository: `proompteng/lab`
- base: `main`
- head: `codex/swarm-torghut-quant-plan`
- swarmName: `torghut-quant`
- swarmStage: `plan`
- objective: assess cluster/source/database state and create/update+merge required design-document PRs that improve,
  maintain, and innovate Torghut quant

This artifact succeeds when:

1. Torghut has one durable hypothesis-capital truth object referenced by scheduler, `/readyz`, and `/trading/status`;
2. each hypothesis declares lane-specific capability requirements rather than inheriting whole-system failure;
3. quant evidence, market-context evidence, and options bootstrap become typed lease inputs instead of implicit URL
   or import-time behavior;
4. the design defines measurable profitability hypotheses, guardrails, rollout gates, and rollback rules.

## Assessment snapshot

### Cluster health, rollout, and event evidence

Current live evidence shows the runtime is healthier than March 19, but the profitability contract is still brittle:

- the core Torghut revision is serving traffic on `torghut-00155`;
- readiness correctly fails closed today, which is better than the previous optimistic state;
- the failure reason is not a single business truth artifact, but a mix of:
  - `promotion_eligible_total=0`,
  - `live_promotion_disabled`,
  - `quant_health_fetch_failed`,
  - stale or degraded data dependencies,
  - lane-specific options failures.
- events still show repeated forecast readiness misses, options restart loops, and stale image pull failures.

Interpretation:

- Torghut already has the raw data to fail safely;
- Torghut still lacks the durable settlement object that explains whether a hypothesis may hold capital, why, and until
  when.

### Source architecture and high-risk modules

The source tree matches the live inconsistency:

- `services/torghut/app/trading/submission_council.py`
  - centralizes gate calculation, but still produces an ephemeral payload;
  - resolves quant evidence from `TRADING_JANGAR_QUANT_HEALTH_URL`, then falls back to the generic
    `TRADING_JANGAR_CONTROL_PLANE_STATUS_URL`, which is the exact wrong-endpoint risk seen live today.
- `services/torghut/app/trading/hypotheses.py`
  - only keeps `decision`, `reasons`, and `message` for Jangar dependency quorum;
  - discards typed capability provenance that lane-specific leases need.
- `services/torghut/app/trading/scheduler/pipeline.py`
  - still reads in-process gate payloads rather than a durable settlement record;
  - scheduler truth can therefore drift from route truth over time.
- `services/torghut/app/main.py`
  - `/readyz` and `/trading/status` rebuild live gate payloads from current state rather than one persisted lease.
- `services/torghut/app/options_lane/catalog_service.py`
  - constructs `OptionsRepository` and seeds rate buckets at import time;
  - turns DB auth drift into process crash instead of typed lane capability loss.
- `services/torghut/app/options_lane/enricher_service.py`
  - has the same import-time failure mode.

Current missing regression coverage:

- no regression proving generic control-plane status cannot satisfy quant-evidence authority;
- no regression proving scheduler, `/readyz`, and `/trading/status` share one settlement record id;
- no regression proving options DB auth failure degrades options-dependent leases without freezing unrelated equity
  hypotheses;
- no regression proving stale or degraded market-context bundles expire settlement eligibility;
- no regression proving lease issuance is impossible when `promotion_eligible_total=0` and quant evidence is missing.

### Database, schema, quality, freshness, and consistency evidence

The data layer is where the next architecture step matters most.

- schema state:
  - `db-check` reports `schema_current=true`;
  - head is `0025_widen_lean_shadow_parity_status`;
  - lineage warnings remain for forked parents, so schema freshness is not the same as schema simplicity.
- persistent governance tables already exist in source:
  - `strategy_hypotheses`
  - `strategy_hypothesis_metric_windows`
  - `strategy_capital_allocations`
  - `strategy_promotion_decisions`
- direct database exec is RBAC-forbidden for this worker:
  - `kubectl cnpg psql -n torghut torghut-db ...`
  - returns `pods/exec is forbidden`
- live data quality remains mixed:
  - market-context freshness is far outside budget;
  - ClickHouse fallback counters remain elevated;
  - options services cannot authenticate to Postgres with the current runtime credentials.

Interpretation:

- Torghut already has persistence primitives it can extend;
- the missing piece is a settlement ledger that binds existing governance tables to fresh capability receipts and local
  evidence bundles.

## Problem statement

Torghut still has five profitability-critical gaps:

1. hypothesis capital truth is computed, not settled;
2. the wrong Jangar endpoint can satisfy the right-looking config surface;
3. lane-specific dependency loss becomes boot crash or generic gate noise instead of typed lease degradation;
4. scheduler, readiness, and status surfaces do not yet share one durable settlement id;
5. data freshness and bootstrap quality are observed, but not expressed as explicit lease terms with expiry.

That keeps the system safe enough to block, but not rigorous enough to scale profitably.

## Alternatives considered

### Option A: let Jangar own both infrastructure truth and final Torghut capital decisions

Summary:

- Jangar issues the final capital answer for each hypothesis;
- Torghut only renders or executes that answer.

Pros:

- strongest single control point;
- simplest deployer story.

Cons:

- couples Jangar to Torghut hypothesis semantics and lane economics;
- slows future strategy work because every profit-model change becomes a control-plane change;
- increases blast radius if Jangar receipt logic misclassifies local Torghut evidence.

Decision: rejected.

### Option B: keep local Torghut submission-council truth and patch each missing condition

Summary:

- tighten `submission_council.py`;
- keep scheduler and route-local projection logic;
- fix options bootstrap and endpoint config as isolated patches.

Pros:

- smallest implementation delta;
- fast to land.

Cons:

- preserves ephemeral truth;
- keeps route/runtime drift possible;
- does not create a durable settlement object for audit, replay, or deploy verification.

Decision: rejected.

### Option C: dual-plane capability lease exchange with hypothesis settlement

Summary:

- Jangar issues typed capability receipts;
- Torghut issues hypothesis settlement records and lane-scoped leases that reference those receipts plus local profit
  evidence.

Pros:

- preserves clear ownership boundaries;
- makes wrong-endpoint usage structurally invalid;
- allows lane-local degradation rather than whole-system freeze;
- creates one durable capital truth per hypothesis.

Cons:

- requires additive persistence and dual-read migration;
- raises the bar for config validation and rollout parity.

Decision: selected.

## Decision

Adopt **Option C**.

Torghut will consume typed Jangar capability receipts and settle its own hypothesis-capital authority through durable
records and lane-scoped capability leases.

## Architecture

### 1. Explicit Jangar capability intake contract

Torghut must stop inferring capability type from whatever Jangar URL is present.

Contract changes:

- `TRADING_JANGAR_CONTROL_PLANE_STATUS_URL`
  - valid only for control-plane summary and dependency-quorum semantics.
- `TRADING_JANGAR_QUANT_HEALTH_URL`
  - mandatory for live-capital capable deployments;
  - must resolve to the quant-health contract, never the generic status route.
- `TRADING_MARKET_CONTEXT_URL`
  - remains a separate typed capability input.

Engineer rule:

- Torghut startup must reject a quant-health URL that points to the generic control-plane status path;
- if live capital is configured, missing typed quant-health configuration is a startup or readiness failure, not a
  silent fallback.

### 2. Hypothesis settlement exchange

Add additive Torghut persistence:

- `hypothesis_settlement_records`
  - `settlement_id`
  - `hypothesis_id`
  - `account_label`
  - `observed_stage`
  - `capital_state`
  - `allowed`
  - `expires_at`
  - `jangar_receipt_digest`
  - `local_evidence_digest`
  - `reason_codes_json`
  - `payload_json`
- `hypothesis_capability_leases`
  - `lease_id`
  - `settlement_id`
  - `lane_id`
  - `capability_subject`
  - `required`
  - `status`
  - `source_receipt_id`
  - `source_receipt_digest`
  - `fresh_until`
  - `payload_json`

Read path:

- scheduler reads the latest non-expired settlement for the active hypothesis/account;
- `/readyz` and `/trading/status` render the same settlement id and lease ids;
- no consumer re-derives a more permissive answer than the settled record.

### 3. Lane capability leases

Each hypothesis declares the capability subjects it needs.

Examples:

- equity-only hypothesis:
  - quant evidence
  - market context
  - control-plane rollout
  - empirical jobs
- options-dependent hypothesis:
  - all of the above, plus:
    - `torghut.options-bootstrap.catalog`
    - `torghut.options-bootstrap.enricher`
    - `torghut.options-bootstrap.ta`

Effect:

- options auth or image failures degrade options-capable hypotheses to `observe`;
- unrelated equity hypotheses remain eligible for `shadow` or `canary` if their own capability set is healthy.

### 4. Bootstrap supervisor for options capability

The options lane needs to stop using process crash as its capability signal.

Implementation contract:

- move DB repository construction and default seeding out of module import and into a bootstrap supervisor;
- publish typed capability state:
  - `auth_ok`
  - `schema_ok`
  - `catalog_hotset_ready`
  - `snapshot_fresh`
  - `ta_image_ok`
- settlement records consume that typed state instead of inferring from pod crash behavior.

### 5. Measurable profitability hypotheses and guardrails

This architecture is only worth landing if it improves decision quality, not just documentation quality.

Profitability hypotheses:

1. explicit settlement records will reduce contradictory capital truth to zero:
   - target: `torghut_settlement_parity_mismatch_total = 0`
   - guardrail: any mismatch between scheduler, `/readyz`, and `/trading/status` blocks rollout.
2. lane-scoped options capability leases will preserve non-options profit opportunity during options outages:
   - target: equity hypotheses may still issue shadow/canary settlements while options capability is degraded;
   - guardrail: no options capability incident may yield a portfolio-wide live-capital allow.
3. typed quant-evidence intake will remove false `unknown` capital denials caused by wrong endpoints:
   - target: `quant_health_fetch_failed` caused by URL misbinding goes to zero after cutover;
   - guardrail: live-capital capable config fails fast if the quant-health binding is missing or ambiguous.

### 6. Reuse existing governance tables rather than replacing them

The existing governance schema remains useful:

- `strategy_hypothesis_metric_windows`
  - remains the evidence window ledger;
- `strategy_capital_allocations`
  - records applied capital changes;
- `strategy_promotion_decisions`
  - records promotion outcomes.

The new settlement and lease tables sit above them and reference them by id or digest rather than replacing them.

## Validation gates

Engineer acceptance gates:

1. add a regression that startup or readiness rejects generic status URL use for quant evidence;
2. add a parity regression proving scheduler, `/readyz`, and `/trading/status` share one settlement id;
3. add a regression proving options bootstrap failure degrades only options-dependent leases;
4. add a regression proving stale market-context or quant-evidence receipts expire settlement eligibility;
5. add a regression proving settlement issuance is impossible when `promotion_eligible_total=0`.

Deployer acceptance gates:

1. runtime responses must include settlement id plus referenced receipt digests;
2. a live rollout is blocked if settlement parity mismatches across scheduler and routes;
3. options capability loss must appear as typed lease degradation, not pod-crash-only evidence;
4. rollback is mandatory if lease issuance or expiry behaves differently between shadow mode and enforced mode.

## Rollout plan

1. Add settlement and lease writes in shadow mode while current gate payloads remain primary.
2. Emit settlement ids in `/trading/status` and `/readyz` without changing top-level allow semantics.
3. Cut scheduler reads to settlement records first.
4. Cut `/trading/status` and `/readyz` to settlement-bound truth after parity has held.
5. Require typed Jangar endpoint configuration and remove generic quant-health fallback.

## Rollback plan

If settlement cutover creates invalid blocks or misses:

1. keep writing settlement and lease records for diagnosis;
2. move consumers back to current submission-council projection behind a feature flag;
3. preserve startup validation for typed endpoint contracts, because wrong-endpoint fallback is not a safe rollback.

Rollback is consumer-projection rollback, not persistence rollback.

## Risks and open questions

- Lane decomposition must stay economically meaningful. If hypotheses over-declare capabilities, the system becomes too
  conservative.
- Lease TTLs must be tuned against real data-arrival patterns, especially for off-session or low-activity periods.
- Options bootstrap capability should become typed state first, before any attempt to widen options profit scope.

## Handoff contract

Engineer handoff:

- implement typed endpoint validation and remove permissive quant-health fallback for live-capital capable paths;
- add settlement and lease tables above the existing governance schema;
- move scheduler and routes to settlement-bound truth;
- refactor options bootstrap to publish typed capability state instead of relying on import-time crash semantics.

Deployer handoff:

- require settlement id and receipt-digest parity during rollout verification;
- keep non-options hypotheses isolated from options capability incidents;
- revert consumer projection cutover if parity or expiry behavior diverges in production.
