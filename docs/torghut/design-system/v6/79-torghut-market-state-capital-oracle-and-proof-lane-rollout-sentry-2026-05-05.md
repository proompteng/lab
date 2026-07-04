# 79. Torghut Market-State Capital Oracle and Proof-Lane Rollout Sentry (2026-05-05)

Status: Approved for implementation (`discover`)

## Source Implementation Audit (2026-07-04)

- Source baseline inspected: `6473f3ee7 ci(arc): fit ten lab runners per node (#11877)`.
- Implementation status: Implemented/partially evolved: Torghut GitOps, migrations, release workflows, and scripts exist; post-deploy verification wiring has changed over time.
- Matched implementation area: CI/CD, release, GitOps, Argo, Knative, and deployment automation.
- Current source evidence:
  - `argocd/applications/torghut/knative-service.yaml`
  - `argocd/applications/torghut/db-migrations-job.yaml`
  - `.github/workflows/torghut-ci.yml`
  - `.github/workflows/torghut-release.yml`
  - `packages/scripts/src/torghut/update-manifests.ts`
- Design drift note: Deployment docs must be checked against current workflows because old names have been retired or replaced.


## Decision

Torghut should add a Market-State Capital Oracle that consumes Jangar rollout sentry proof, Torghut data-plane proof,
and hypothesis-level profit proof before allowing capital to move beyond observe or shadow.

I am choosing this because the current system has useful alpha infrastructure but weak authority under rollout stress.
ClickHouse contains recent equity TA data, but Postgres service endpoints refused connections during the assessment,
options analytic tables are empty, sim analytic databases are empty, and the live cluster is actively rotating through
image-pull timeouts, node disruption, and volume attach contention. That is not a condition for capital expansion.
It is a condition for building a sharper oracle that can say "serve", "collect evidence", "paper trade", "canary",
or "hold" with a reason code tied to the same evidence the deployer sees.

The tradeoff is that profitable candidates may wait behind proof freshness and rollout health. I accept that. A quant
system that cannot prove its data and runtime state will eventually spend into stale or non-reproducible edge.

## Runtime Inputs and Success Metrics

Inputs confirmed for this architecture run:

- repository: `proompteng/lab`
- base: `main`
- head: `codex/swarm-torghut-quant-discover`
- swarm: `torghut-quant`
- stage: `discover`
- objective: assess cluster/source/database state and merge architecture artifacts that improve, maintain, and
  innovate Torghut quant.

Success means:

1. a future engineer can implement the oracle without guessing which surfaces are authoritative;
2. each hypothesis promotion cites a `market_state_capital_oracle_id`;
3. capital cannot move when Jangar sentry proof is missing, expired, or degraded;
4. capital cannot move when Postgres is unavailable, ClickHouse freshness is stale, options/sim proof is empty for the
   target lane, empirical proof is stale, or execution cost evidence violates the hypothesis budget;
5. deployers can prove rollout and rollback through explicit acceptance gates.

## Evidence Assessed

All cluster and database assessment work was read-only.

### Cluster and Rollout Evidence

The current cluster is mixed rather than cleanly healthy:

- Torghut pods included running ClickHouse, TA, options catalog/enricher, and exporters, but also pending Knative
  revision pods, terminating old revision pods, and image pull failures for `torghut-ws`, `torghut-ws-options`,
  `torghut-options-ta`, and `torghut-ta-sim`;
- Torghut events reported private-registry `i/o timeout`, `ImagePullBackOff`, `ErrImagePull`, sim
  `LatestReadyFailed`, and Symphony volume multi-attach;
- Jangar pods included a main `jangar` pod in init, Redis liveness/readiness timeouts, DB pod termination, and
  Symphony volume multi-attach;
- agents pods included controller image-pull failures and a large failed-run tail from earlier swarm executions;
- node reads were forbidden, but namespace events consistently referenced node-not-ready and TaintManager eviction
  churn.

The inference is not "the cluster is down". The inference is that the rollout substrate is noisy enough that Torghut
needs platform proof before capital proof can be trusted.

### Route and Service Evidence

Route checks were unstable during the assessment:

- `curl http://torghut.torghut.svc.cluster.local/readyz` timed out after five seconds;
- `curl http://torghut.torghut.svc.cluster.local/healthz` also timed out after five seconds in this run;
- `curl http://jangar.jangar.svc.cluster.local/health` failed to connect;
- direct Postgres checks using the CNPG app secret failed with TCP `ECONNREFUSED` for both Torghut and Jangar.

That route behavior reinforces the design. A capital decision cannot depend on one transient route read. It must
consume a fresh oracle snapshot that records what was unreachable and why.

### Database and Data Evidence

Postgres evidence:

- `kubectl cnpg psql -n torghut torghut-db` failed because the worker cannot create `pods/exec`;
- direct TCP using the `torghut-db-app` URI failed with `connect ECONNREFUSED 10.105.214.188:5432`;
- direct TCP using the `jangar-db-app` URI failed with `connect ECONNREFUSED 10.98.225.178:5432`;
- both DB pod objects had deletion timestamps while still reporting the postgres container ready.

ClickHouse evidence:

- authenticated HTTP query succeeded against `torghut-clickhouse`;
- server version was `25.3.6.10034.altinitystable`;
- `torghut.ta_microbars` had `1,625,888` rows, max `event_ts=2026-05-04 20:58:15 UTC`, `12` symbols, and no blank
  symbols;
- `torghut.ta_signals` had `1,133,243` rows by system table metadata/source aggregation;
- `ta_signals` source split was:
  - `ta`: `946,486` rows, max `event_ts=2026-05-04 20:58:15 UTC`;
  - `rest`: `135,036` rows, max `event_ts=2026-05-04 19:55:00 UTC`;
  - `ws`: `51,721` rows, max `event_ts=2026-05-04 20:53:00 UTC`;
- live options tables `options_contract_bars_1s`, `options_contract_features`, and `options_surface_features` had
  zero rows;
- discovered `torghut_sim_*` databases had zero-row `ta_signals` and `ta_microbars` tables;
- ClickHouse reported `41` Torghut-prefixed databases, `71` active parts, and `0` inactive parts.

Data conclusion: the equity TA store is useful but not sufficient for capital expansion. Options and sim lanes have
empty analytic proof, and Postgres was unavailable at the service endpoint when assessed.

### Source and Test Evidence

Torghut has enough source surface and test investment to support this contract, but the current route shape is too
large for humans to reason across manually:

- `services/torghut/app` has `106,242` Python lines;
- `services/torghut/tests` has `95,907` Python lines;
- high-risk source modules include:
  - `app/trading/autonomy/lane.py` at `7,377` lines;
  - `app/trading/autonomy/policy_checks.py` at `6,072` lines;
  - `app/trading/research_sleeves.py` at `5,254` lines;
  - `app/trading/scheduler/pipeline.py` at `4,273` lines;
  - `app/main.py` at `3,978` lines;
- tests already cover trading pipeline, strategy runtime, policy checks, decisions, autonomous lane, trading API,
  scheduler autonomy/safety, order idempotency, profitability evidence, promotion truthfulness, local replay, and
  discovery harness behavior;
- source migrations currently include `31` files, with source head `0029_whitepaper_embedding_dimension_4096`;
- `app/main.py` already evaluates database contract, schema lineage, Jangar dependency quorum, quant evidence,
  scheduler state, live submission gates, alpha readiness, rollback state, and health routes.

The test gap is cross-plane authority parity: the same oracle snapshot must drive `/readyz`, `/trading/status`,
scheduler capital gates, and deployer proof checks.

## Problem

Torghut is getting better at finding candidates. It is not yet strict enough about when a candidate is allowed to
spend capital.

The current authority model is fragmented:

- ClickHouse says one data plane has recent equity TA rows;
- Postgres service endpoints refused during a rollout-sensitive moment;
- options analytic proof is empty;
- sim analytic proof is empty;
- route health timed out;
- source has route-level readiness and governance checks, but not one market-state authority object;
- Jangar can be degraded or unavailable while Torghut still needs a capital decision.

The profitable next system is not a bigger strategy factory alone. It is a strategy factory plus a capital oracle that
turns runtime, data, cost, and hypothesis evidence into a bounded spend decision.

## Alternatives Considered

### Option A: Continue Evidence Settlement and Capital Routing as Previously Designed

Keep implementing the evidence settlement receipts from document 78 and add only minor reason-code expansions for
today's findings.

Pros:

- lowest architecture churn;
- consistent with existing design sequence;
- easy to hand to engineers as incremental work.

Cons:

- does not make rollout substrate state a first-class capital input;
- does not handle the current cross-plane registry, DB endpoint, and storage-attach failure class;
- may leave capital routing as a Torghut-only concept instead of a Jangar/Torghut contract.

Decision: reject as sufficient. Keep the receipt vocabulary, but add a sentry-backed oracle above it.

### Option B: Accelerate Research and Candidate Generation

Prioritize new alpha from whitepaper autoresearch, MLX proposal lanes, Janus-Q event reasoning, options surface
features, and microstructure hypotheses.

Pros:

- highest upside if proof and rollout state are already trustworthy;
- uses active Torghut research machinery;
- can produce more daily-profit candidates.

Cons:

- current data says options and sim analytic proof are empty;
- Postgres was not reachable;
- route and rollout state were unstable;
- more candidates increase review load before the authority path can admit or reject them cleanly.

Decision: reject as the primary move. Research acceleration remains useful behind oracle gates.

### Option C: Market-State Capital Oracle with Proof-Lane Rollout Sentry

Add a single oracle snapshot per account/window/hypothesis family. It consumes Jangar sentry proof, Torghut data-plane
freshness, DB schema/endpoint proof, empirical proof, cost evidence, and hypothesis constraints. It emits the only
capital-stage decision allowed to move beyond observe or shadow.

Pros:

- attacks the current failure modes directly;
- increases profitability by making capital scarce and proof-priced;
- allows serving and research to continue during rollout incidents;
- gives deployers one object to inspect before promotion or rollback;
- creates a path for options and sim lanes to become capital-eligible only after they stop being empty.

Cons:

- adds one new authority surface;
- requires strict expiry and route parity tests;
- may hold promising candidates longer than a human would.

Decision: select Option C.

## Chosen Architecture

### MarketStateCapitalOracle

The oracle produces an append-only or materialized snapshot.

Required fields:

- `market_state_capital_oracle_id`
- `account_label`
- `window`
- `capital_context`: `live`, `paper`, `simulation`, or `research`
- `hypothesis_family`
- `hypothesis_id`
- `rollout_sentry_certificate_id`
- `database_schema_head`
- `database_endpoint_status`
- `clickhouse_freshness_digest`
- `options_freshness_digest`
- `simulation_freshness_digest`
- `empirical_proof_digest`
- `execution_cost_digest`
- `market_context_digest`
- `source_quality_digest`
- `decision`: `serve_only`, `observe`, `shadow`, `paper`, `canary`, `scale`, `hold`, `quarantine`, or `rollback`
- `capital_limit_bps`
- `capital_limit_notional`
- `reason_codes`
- `issued_at`
- `fresh_until`
- `rollback_target`

No snapshot may authorize capital after `fresh_until`.

### Proof Inputs

The oracle consumes these proof groups:

- Jangar rollout sentry certificate;
- Torghut Postgres endpoint and migration/schema head proof;
- ClickHouse equity TA freshness;
- options analytic freshness;
- simulation analytic freshness;
- empirical job recency and dataset digest;
- TCA/execution-cost proof;
- source-quality gates for the hypothesis family;
- market-context/regime freshness;
- rollback and emergency-stop state.

Missing proof is not neutral. It is `hold` unless the target context is explicitly research-only.

### Decisions

Decision semantics:

- `serve_only`: service may answer routes but no capital work may start;
- `observe`: collect data and evidence only;
- `shadow`: simulate/paper compute with zero live order authority;
- `paper`: paper orders allowed within policy;
- `canary`: tightly bounded live capital allowed;
- `scale`: increased live allocation allowed;
- `hold`: proof missing or stale, retry later;
- `quarantine`: rollout or data-plane fault requires deployer action;
- `rollback`: active capital must demote to the last safe stage.

### Measurable Trading Hypotheses

Initial oracle hypotheses should be ambitious but falsifiable.

`H-MICRO-CLUSTERLOB`

- Claim: clustered order-flow imbalance can improve short-horizon equity signals over aggregate order-flow baselines.
- Required data: TA microbars, order-flow proxy features, spread/quote-quality proof, at least `60` fresh samples per
  trading day in the target universe.
- Promotion gate: post-cost expectancy `>= 8 bps`, average absolute slippage `<= 8 bps`, drawdown within family
  budget, no data freshness gap greater than `90` seconds during active market.
- Current state: not promotable because Postgres endpoint proof failed and no current oracle exists.

`H-EXEC-OBI`

- Claim: executed-trade order-book imbalance can improve directional association for intraday returns when filtered by
  event intensity and liquidity regime.
- Required data: trade/quote event reconstruction, event-time freshness, execution-cost proof, regime count proof.
- Promotion gate: post-cost expectancy `>= 10 bps`, at least `3` regime buckets passing holdout, slippage `<= 10 bps`,
  and no source freshness veto.
- Current state: research-only until the data feature store proves the required fields.

`H-OPTIONS-SURFACE`

- Claim: options surface dislocation can route a separate paper/canary sleeve when contract bars and surface features
  are fresh.
- Required data: `options_contract_bars_1s`, `options_contract_features`, and `options_surface_features` with non-zero
  rows, contract catalog watermarks, and rate-limit proof.
- Promotion gate: non-empty live options analytic tables, paper-trading fills within cost budget, and no stale
  underlying/contract mismatch.
- Current state: blocked because all live options analytic tables assessed here had zero rows.

`H-JANUS-EVENT`

- Claim: event-centric CAR labels plus gated reward models can improve event-driven reversion/continuation decisions.
- Required data: whitepaper claim graph, event labels, CAR windows, empirical proof, and human/agent verdict lineage.
- Promotion gate: fresh empirical proof, out-of-window holdout, no hallucinated source refs, post-cost expectancy
  `>= 8 bps`, and Jangar sentry `allow`.
- Current state: shadow-only until empirical proof is refreshed and route/database proof is stable.

## Implementation Scope for Engineers

Phase 1 should be additive and non-invasive:

1. define the oracle schema and typed reason codes;
2. create an in-process read model first, backed by existing route/data probes;
3. add a Jangar sentry client that reads the companion `RolloutSentryCertificate`;
4. expose `GET /trading/capital-oracle` for current account/window/hypothesis snapshots;
5. wire `/readyz`, `/trading/status`, and scheduler capital gates to cite the same oracle id;
6. add metrics for decisions, reason codes, expiry, and proof ages;
7. leave live capital promotion disabled until deployer gates pass.

Phase 2 can persist oracle snapshots in Postgres once endpoint stability is back. The initial implementation should
not require new writes during incident assessment.

Out of scope:

- enabling live capital;
- mutating cluster resources from Torghut;
- using privileged DB exec as a required validation step;
- treating options or sim lanes as eligible while their analytic proof tables are empty.

## Validation Gates

Engineer tests:

- oracle returns `hold` when Jangar sentry proof is missing or expired;
- oracle returns `hold` when Postgres endpoint proof is refused even if ClickHouse is fresh;
- oracle returns `hold` for options hypotheses when options analytic tables are empty;
- oracle returns `hold` for sim hypotheses when sim analytic tables are empty;
- oracle returns `quarantine` for image-pull or storage-attach sentry reasons;
- `/readyz`, `/trading/status`, and scheduler capital gates all cite the same oracle snapshot id.

Data validation:

- ClickHouse freshness query for `ta_signals` and `ta_microbars`;
- non-empty options feature table check before any options capital stage;
- non-empty sim database check before any sim promotion proof;
- empirical proof recency check with dataset digest;
- TCA and slippage checks against hypothesis budgets.

CI validation:

- docs-only PRs run repository markdown/format checks where available;
- service implementation PRs run `uv sync --frozen --extra dev`;
- service implementation PRs run all three Torghut pyright profiles;
- touched trading modules add targeted pytest coverage and property/stateful tests where the README requires them.

## Rollout Plan

1. Ship oracle in read-only observe mode.
2. Publish oracle snapshots in routes and metrics without changing capital decisions.
3. Compare oracle decisions to existing status and scheduler gates across one market session.
4. Enable oracle as a hard blocker for promotion beyond shadow.
5. Enable paper/canary eligibility only for hypotheses with fresh Jangar sentry, Postgres, ClickHouse, empirical, and
   cost proof.
6. Enable options and sim hypotheses only after their analytic proof tables are non-empty and fresh.

## Rollback Plan

Rollback should preserve evidence:

- switch oracle enforcement back to advisory mode;
- keep oracle snapshot route and metrics enabled for diagnosis;
- demote active hypotheses to the last safe capital stage when the oracle emits `rollback`;
- quarantine only the failing hypothesis family or rollout scope unless the Jangar sentry emits a shared-platform
  freeze;
- never delete proof snapshots during rollback.

## Risks

- The oracle can become stale if `fresh_until` is ignored. Treat expiry as a hard hold.
- A single oracle can become too broad. Keep snapshots account/window/hypothesis scoped.
- Route probes can add latency. Cache only within the freshness budget and surface the cache age.
- Operators may want manual override. Allow override only as a separately audited reason code with capital capped to
  paper/shadow until the proof gap is closed.
- Options and sim lanes may stay blocked for a while. That is correct until they produce non-empty current evidence.

## Handoff

Engineer acceptance:

- implement the oracle as an additive read model with stable reason codes;
- add route and scheduler parity tests around a shared oracle snapshot id;
- keep live capital disabled;
- document every new reason code in the route contract.

Deployer acceptance:

- verify Jangar sentry `allow` is required before Torghut can emit `paper`, `canary`, or `scale`;
- verify Postgres endpoint refusal holds capital even when ClickHouse is fresh;
- verify current zero-row options and sim analytic tables block their hypothesis families;
- verify rollback to advisory mode is one configuration change and preserves proof evidence.
