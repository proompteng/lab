# 126. Jangar Projection Witness Exchange And Material Evidence Products (2026-05-06)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-06
Owner: Victor Chen, Jangar Engineering Architecture
Scope: Jangar control-plane resilience, rollout admission, projected database authority, Torghut capital evidence,
read-only validation, and material-action receipts.

Companion Torghut contract:

- `docs/torghut/design-system/v6/130-torghut-evidence-product-order-book-and-profit-carry-ladder-2026-05-06.md`

Extends:

- `125-jangar-run-settlement-watermarks-and-consumer-evidence-escrow-2026-05-06.md`
- `124-jangar-disruption-budget-arbiter-and-data-freshness-settlement-2026-05-06.md`
- `116-jangar-controller-witness-quorum-and-capital-activation-receipts-2026-05-06.md`
- `111-jangar-negative-evidence-router-and-action-slo-budgets-2026-05-06.md`

## Decision

I am selecting a **projection witness exchange with material evidence products** as the next Jangar control-plane
contract.

The live system is no longer in the May 5 broad degraded posture, but the evidence is still split across authorities.
At `2026-05-06T17:23Z`, Jangar control-plane status reported a healthy dependency quorum, healthy database
connectivity, migration consistency at `28/28`, workflow failures at `0` in a 15-minute window, current controller
heartbeats from `agents-controllers-64d77db57c-z7b48`, and fresh runtime admission passports. The same serving
application returned `/ready` as HTTP `503` because this pod was not the controller leader and its local controller
surfaces were disabled. That is a correct split-topology signal, but it is not yet a first-class evidence product with
action-specific meaning.

Torghut shows the same pattern on the consumer side. Core dependencies are up: live Postgres, ClickHouse, Alpaca,
database schema, and Jangar universe all reported OK. Empirical jobs are now fresh and truthful for
`chip-paper-microbar-composite@execution-proof`. But material capital evidence is still not settled: live submission is
blocked by `simple_submit_disabled`, scoped `paper/1d` quant latest is empty, market context is degraded with stale
technicals, fundamentals, news, and regime, and Jangar quant alerts show `213` open alerts with critical pipeline-lag
examples.

The selected design turns every producer-owned observation into a typed, expiring, action-scoped
`material_evidence_product`. Material-action receipts then consume products by quorum rules instead of reading raw
routes, raw Kubernetes warnings, or privileged databases directly.

The tradeoff is that Jangar will require more explicit evidence projection before it widens deploys or grants
Torghut capital. I accept that. The failure mode to remove over the next six months is a control plane that has
accurate local status pages but no shared contract for what those facts allow.

## Runtime Objective And Success Metrics

This contract increases Jangar resilience by separating raw observation from action authority. It increases Torghut
profitability by letting capital decisions consume fresh proof products while stale products become priced repair work,
not generic blockers.

Success means:

- Every material action receipt cites the evidence products it consumed, not only reducer-level reason codes.
- `/ready` remains a pod-local readiness signal; `/api/agents/control-plane/status` becomes a material evidence
  product producer with split-topology authority.
- Database health is accepted from application-projected `select 1` and migration consistency products, not from broad
  pod exec or Secret reads.
- RBAC denial is modeled as `observation_right=missing` or `producer_unavailable`, never silently ignored.
- `serve_readonly` and `dispatch_repair` can continue when the serving pod is not leader but controller heartbeats,
  database, NATS, and storage products are fresh.
- `dispatch_normal`, `deploy_widen`, and `merge_ready` hold when controller witness, run settlement, source schema, or
  workflow reliability products are missing or contradictory.
- `torghut_observe` stays allowed at zero notional while stale or empty Torghut data products are repaired.
- `paper_canary`, `live_micro_canary`, and `live_scale` require current Torghut consumer products for scoped quant,
  market context, empirical proof, TCA, execution settlement, and live-submission policy.

## Evidence Snapshot

All evidence was collected read-only. I did not mutate Kubernetes resources, database rows, GitOps manifests, trading
flags, broker records, or runtime objects while gathering evidence for this contract.

### Cluster And Rollout Evidence

- The branch is `codex/swarm-jangar-control-plane-plan` and was clean at `origin/main` before documentation edits.
- `kubectl auth whoami` reported `system:serviceaccount:agents:agents-sa`.
- Jangar namespace pods were running, including `jangar-b6b87bffd-5xtt9` at `2/2 Running`, `jangar-db-1`,
  `open-webui-0`, Redis, Bumba, Alloy, Symphony, and `symphony-jangar`.
- Agents deployments were available: `agents=1/1`, `agents-controllers=2/2`, and `agents-alloy=1/1`.
- Agents pod status still carried retained history: `203 Completed`, `36 Error`, and `8 Running` pods.
- Recent Agents events showed readiness probe failures on old `agents` and `agents-controllers` ReplicaSets during
  rollout, followed by the new `ba2f1c8e` controller image becoming available.
- Torghut pods were running for live `torghut-00241`, sim `torghut-sim-00337`, Postgres, ClickHouse, Keeper, TA,
  sim TA, options TA, options catalog/enricher, websocket services, guardrail exporters, Alloy, and Symphony.
- Recent Torghut events showed transient readiness/startup probe failures during new live and sim revision warm-up,
  followed by both latest revisions becoming ready.
- Listing CNPG clusters, CNPG backups, statefulsets, rollouts, Secrets, and pod exec was forbidden to this service
  account. That is the right production bias for this lane, but it requires stronger application-projected evidence.

### Source Evidence

- `services/jangar/src/server/control-plane-status.ts` composes database status, heartbeat authority, rollout health,
  workflow reliability, watch reliability, execution trust, failure-domain leases, negative evidence, runtime
  admission, action clocks, and material receipts.
- `services/jangar/src/server/control-plane-db-status.ts` already projects the database contract through a `select 1`
  probe and Kysely migration comparison. It checks registered migrations against the live migration table and reports
  unapplied or unexpected counts.
- `services/jangar/src/server/control-plane-controller-witness.ts` already models controller process, deployment,
  watch epoch, and AgentRun ingestion witnesses. It chooses `allow_with_split` when heartbeat authority is current even
  though the serving process is not the controller.
- `services/jangar/src/server/supporting-primitives-controller.ts` remains the largest Jangar controller file at
  `2931` lines. Its queueing and optional swarm watch logic are high leverage but high blast radius.
- `services/jangar/src/server/primitives-kube.ts` now supports `persistentvolumeclaim`, `persistentvolumeclaims`,
  `pvc`, and `pvcs`, so the older workspace PVC blind spot is closed in source.
- `services/torghut/app/main.py` is `4051` lines and assembles readiness, trading health, schema checks, empirical
  jobs, quant evidence, market context, and live submission gates.
- `services/torghut/app/trading/submission_council.py` consumes Jangar quant health, hypothesis readiness, empirical
  proof, market context, TCA, dependency quorum, and capital stage. It is the right Torghut consumer for evidence
  products.
- `services/torghut/app/trading/empirical_jobs.py` already verifies artifact truthfulness, lineage, authority, and
  freshness for benchmark parity, foundation router parity, Janus event CAR, and Janus HGRM reward.
- `services/torghut/app/trading/market_context.py` already evaluates stale, low-quality, error, disabled, and degraded
  last-good market context states.

### Database And Data Evidence

- Direct CNPG CRD reads were forbidden in both Jangar and Torghut. Direct pod exec into `jangar-db-1`,
  `torghut-db-1`, and ClickHouse pods was also forbidden.
- Repo-declared Jangar Postgres is one CNPG instance, `200Gi`, `dataChecksums=true`, `pgcrypto`, `vector`, Barman S3
  backups, and `14d` retention. Jangar has a daily ScheduledBackup at `0 0 11 * * *`.
- Repo-declared Torghut Postgres is one CNPG instance, `50Gi`, `dataChecksums=true`, Barman S3 backups, and `14d`
  retention. No Torghut ScheduledBackup artifact was observed in the reviewed path.
- Jangar control-plane status reported `database.configured=true`, `database.connected=true`, `status=healthy`,
  `latency_ms=11`, and migration consistency `registered_count=28`, `applied_count=28`, `unapplied_count=0`,
  `unexpected_count=0`.
- Jangar's latest registered and applied migration was
  `20260505_torghut_quant_pipeline_health_window_index`.
- Jangar `/ready` returned HTTP `503` with `status=degraded`, `leaderElection.isLeader=false`, and
  `leaderElection.lastError=terminating`, while runtime kits and admission passports were healthy.
- Torghut live `/readyz` returned HTTP `503` because `simple_submit_disabled` holds live submission in `shadow`.
  Scheduler, Postgres, ClickHouse, Alpaca, database schema, and universe were OK.
- Torghut live database schema was current at Alembic head `0029_whitepaper_embedding_dimension_4096`; lineage was
  ready with known parent-fork warnings.
- Torghut sim `/readyz` returned HTTP `200`, but sim quant evidence for `TORGHUT_SIM/15m` was degraded with
  `latest_metrics_count=0`, `empty_latest_store_alarm=true`, and no stages.
- Jangar global Torghut quant health was fresh with `latestMetricsCount=3780`, updated within seconds, and no missing
  update alarm.
- Jangar scoped quant health for `paper/1d` was degraded with `latestMetricsCount=0`,
  `latestMetricsUpdatedAt=null`, and `emptyLatestStoreAlarm=true`.
- Torghut market-context health was degraded: technicals and regime were stale by `162287` seconds, fundamentals by
  `4765265` seconds, and news by `4398452` seconds.
- ClickHouse guardrail metrics were healthy for availability and disk: both replicas were up, free ratio was about
  `0.96`, no replica was read-only, and the last scrape succeeded.
- LLM guardrail metrics reported last scrape success and compliant policy resolution, but LLM was disabled,
  effective shadow mode was active, and governance evidence was incomplete.

## Problem

Jangar has accumulated strong local evidence reducers. What it lacks is a shared producer/consumer contract that says
which evidence product authorizes which material action.

The current gap has four concrete failure modes:

1. **Split readiness ambiguity.** `/ready` can be degraded because this pod is not the controller leader while
   heartbeat-backed control-plane status is materially healthy.
2. **Privilege mismatch.** The worker can validate application projections but cannot read CNPG, Secrets, or pod exec.
   That is safer, but the status model must treat producer projections as first-class evidence.
3. **Freshness mismatch.** Torghut global quant can be fresh while scoped paper or sim evidence is empty, and market
   context can be stale while core service dependencies are green.
4. **Receipt opacity.** Material receipts carry decisions and reason codes, but the evidence that generated the
   decision is not yet normalized across controller, database, Kubernetes, and Torghut producer surfaces.

This is now a systems problem, not a local route bug. The control plane needs an evidence exchange.

## Alternatives Considered

### Option A: Fix `/ready` And Retention Locally

This option makes `/ready` aware of split controller topology and separately cleans up retained Error/Completed pods.

Pros:

- Directly reduces a visible degraded status.
- Smaller implementation.
- Makes deployer dashboards easier to read.

Cons:

- Does not settle database projection authority.
- Does not price Torghut scoped quant emptiness, market-context staleness, or live-submission shadow mode.
- Still leaves material receipts dependent on reducer-specific payloads.
- Treats evidence as local health, not action authority.

Decision: reject as the architecture. Keep it as an engineer task inside the broader product contract.

### Option B: Expand Runtime RBAC For Direct Database And Cluster Inspection

This option grants the worker or status path access to CNPG resources, PDBs, statefulsets, Secrets, and pod exec.

Pros:

- More direct cluster and database visibility.
- Easier ad hoc debugging.
- Reduces reliance on service-owned status projections.

Cons:

- Violates least-privilege posture for architecture and automation lanes.
- Increases blast radius of every AgentRun.
- Still does not tell Torghut which evidence is fresh enough for capital.
- Makes durability depend on broad access rather than typed producer contracts.

Decision: reject. Missing observation rights should be typed; privileged reads should not become the default.

### Option C: Projection Witness Exchange With Material Evidence Products

Each producer emits typed, expiring products. Jangar validates product freshness and confidence, then material receipts
consume products through action-specific quorum rules.

Pros:

- Keeps least privilege: application projections become the audited read path.
- Separates pod readiness from material action authority.
- Lets stale, empty, or missing Torghut products become repairable debt.
- Gives engineer and deployer lanes exact acceptance gates.
- Scales across future producers without adding bespoke reason-code glue.

Cons:

- Adds a product schema and projection registry.
- Requires compatibility work in status payloads and tests.
- Needs a shadow period to tune false holds.

Decision: select Option C.

## Architecture

### MaterialEvidenceProduct

Every producer emits an action-scoped product.

```text
material_evidence_product
  product_id
  schema_version
  producer
  producer_revision
  subject_ref
  generated_at
  observed_at
  expires_at
  scope
  observation_right
  confidence
  decision                 # allow, observe_only, repair_only, hold, block, unavailable
  freshness_seconds
  max_freshness_seconds
  quality_score
  row_count
  positive_evidence_refs
  negative_evidence_refs
  missing_evidence_refs
  affected_action_classes
  required_repairs
  rollback_target
```

Initial producers:

- `jangar.serving_readiness`: pod-local `/ready` result.
- `jangar.control_plane_status`: dependency quorum, controller witness, action clocks, material receipts.
- `jangar.database_projection`: `select 1`, latency, migration consistency, latest migration.
- `jangar.workflow_reliability`: recent failed jobs, active job pressure, backoff limit exceeded.
- `jangar.watch_reliability`: watch events, errors, restarts, last seen timestamps.
- `jangar.source_schema`: code registered migrations, CRD availability, runtime kit evidence.
- `torghut.quant_latest`: global and scoped latest metrics.
- `torghut.market_context`: domain freshness and quality.
- `torghut.empirical_jobs`: truthfulness, lineage, freshness, eligibility.
- `torghut.clickhouse_guardrails`: replica up, disk free, read-only state, TA freshness.
- `torghut.llm_guardrails`: policy resolution, governance completeness, circuit state.

### ProjectionWitnessExchange

The exchange is a reducer that builds an action-specific quorum from products.

```text
projection_witness_exchange
  exchange_id
  generated_at
  namespace
  action_class
  required_product_classes
  optional_product_classes
  consumed_products
  missing_products
  stale_products
  contradictory_products
  decision
  reason_codes
  required_repairs
  rollback_target
```

Rules:

1. `serve_readonly` consumes route and database products; controller-leader split may degrade readiness but not block
   read-only serving when database and runtime kits are healthy.
2. `dispatch_repair` consumes NATS, storage, controller heartbeat, and workflow products. It can proceed when raw
   controller self-report is split if heartbeat authority is fresh.
3. `dispatch_normal` requires controller witness, workflow reliability, source schema, runtime admission, and database
   products.
4. `deploy_widen` and `merge_ready` require fresh source schema, migration consistency, rollout, controller witness,
   run settlement, and negative-evidence products.
5. `torghut_observe` requires only zero-notional Torghut read products and can continue during repair.
6. `paper_canary` requires fresh scoped quant, empirical, market-context, and action-clock products.
7. `live_micro_canary` adds live-submission policy, TCA, execution settlement, LLM governance, and no unresolved
   critical data alerts.
8. `live_scale` requires positive post-cost evidence, no open rollback debt, and a deployer-approved capital product.

### Storage And Transport

The first implementation should stay simple:

- Expose products in Jangar status JSON before adding persistent storage.
- Persist only product summaries needed for audit in the Jangar database after schema review.
- Do not store Secrets, raw database credentials, or full broker payloads in products.
- Hash large payload refs and store durable artifact URIs when available.
- Use existing NATS updates for live visibility, but treat the in-repo design and PR as the durable audit source.

## Rollout Plan

Phase 0, design and fixtures:

- Define TypeScript product types under the Jangar control-plane data surface.
- Add fixture builders for healthy, split-leader, missing-RBAC, stale-market-context, empty-scoped-quant, and
  incomplete-LLM-governance products.
- Add Torghut fixture payloads for empirical-fresh but quant-scoped-empty state.

Phase 1, shadow projection:

- Add products to `/api/agents/control-plane/status` under a `material_evidence_products` array.
- Add `projection_witness_exchange` decisions beside existing action clocks and receipts.
- Keep existing action receipt enforcement unchanged.

Phase 2, receipt binding:

- Attach consumed product ids to material action activation receipts.
- Make `merge_ready`, `deploy_widen`, `paper_canary`, and `live_micro_canary` depend on exchange decisions in shadow.
- Emit explicit downgrade reasons when `/ready` and status disagree because of split topology.

Phase 3, enforcement:

- Enforce exchange decisions for `deploy_widen` and `merge_ready`.
- Enforce `paper_canary` only after Torghut publishes scoped quant, empirical, and market-context products.
- Keep `live_micro_canary` and `live_scale` blocked until LLM governance and execution-settlement products are
  complete.

## Validation Gates

Engineer gates:

- Unit tests cover product construction for database, controller witness, workflow, and Torghut products.
- Control-plane status tests prove split `/ready` does not block `serve_readonly` when heartbeat and database products
  are fresh.
- Tests prove missing CNPG/PDB/Secret/pod-exec observation rights become product fields, not thrown failures.
- Tests prove `paper_canary` holds on empty scoped quant even when global quant is fresh.
- Tests prove `dispatch_repair` remains allowed during missing Torghut consumer proof.

Deployer gates:

- `curl /ready` and `curl /api/agents/control-plane/status?namespace=agents` can explain any disagreement using
  product ids and reason codes.
- `kubectl get deploy -n agents` shows `agents` and `agents-controllers` available before any widen.
- Jangar database product reports migration consistency with `unapplied_count=0` and `unexpected_count=0`.
- Torghut products show scoped quant count, market-context age, empirical freshness, ClickHouse guardrail status, and
  LLM governance completeness before paper or live capital.
- Rollout notes include the exact rollback target from the blocking product.

## Rollback

Rollback is product-layer only during phases 1 and 2:

- Keep existing material action reducers as the enforcement source.
- Hide or ignore `material_evidence_products` and `projection_witness_exchange` through a feature flag.
- Preserve old `/ready` behavior until deployer dashboards explicitly consume split-topology products.
- For false product holds, downgrade enforcement to `observe_only` and keep `dispatch_repair` available.

After phase 3 enforcement:

- Roll back by returning exchange enforcement to shadow while retaining product emission.
- Do not broaden RBAC or use pod exec as the emergency path.
- If database products fail but application routes are serving, allow `serve_readonly` only and require repair before
  dispatch, merge, deploy, or capital.

## Risks

- Product schema churn can create consumer drift if Jangar and Torghut land independently.
- False holds are possible if product freshness windows are too tight for market close or overnight data.
- Product arrays can become noisy unless the UI and status routes group by action class.
- Missing observation rights must not become a reason to skip evidence; they must create repair tasks.
- Capital products must avoid leaking broker account details or credentials.

## Handoff To Engineer

Implement the product schema and shadow exchange first. Own the Jangar status route, product builders, tests, and
receipt references. Do not change cluster RBAC or database privileges in the first PR. Add Torghut fixture payloads
that reproduce the current evidence: empirical fresh, scoped quant empty, market context stale, live submission shadow,
and LLM governance incomplete.

Acceptance gates:

- `bun run --filter @proompteng/jangar test -- src/server/__tests__/control-plane-status.test.ts`
- `bun run --filter @proompteng/jangar test -- src/server/__tests__/control-plane-controller-witness.test.ts`
- `bun run --filter @proompteng/jangar test -- src/routes/api/torghut/trading/control-plane/quant/-health.test.ts`
- `bun run --filter @proompteng/jangar lint`
- A read-only cluster check shows product decisions explain the `/ready` versus status split.

## Handoff To Deployer

Deploy in shadow first. Do not widen deploy or capital action from product decisions until the product ids appear in
material action receipts and the dashboard explains split readiness. Validate that existing green signals remain
visible, but require product-level evidence for `merge_ready`, `deploy_widen`, `paper_canary`, and live capital.

Rollback gate:

- If product projection creates false holds, disable exchange enforcement and keep products visible for audit.
- If Jangar database product reports migration drift, stop deploy widening and run the existing migration remediation
  path before re-enabling material actions.
