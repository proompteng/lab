# 65. Torghut Quant Proof-Ledger Cutover Program and Handoff Contract (2026-03-21)

Status: Approved for implementation (`plan`)
Date: `2026-03-21`
Owner: Gideon Park (Torghut Traders)
Mission: `codex/swarm-torghut-quant-plan`
Swarm impacts:

- `torghut-quant`
- `jangar-control-plane`

Companion docs:

- `docs/agents/designs/65-jangar-recovery-warrants-and-runtime-proof-cells-contract-2026-03-21.md`
- `docs/torghut/design-system/v6/64-torghut-hypothesis-vaults-and-post-cost-profit-tapes-contract-2026-03-21.md`

Extends:

- `docs/agents/designs/64-jangar-recovery-epochs-and-backlog-seats-contract-2026-03-21.md`
- `docs/torghut/design-system/v6/63-torghut-profit-windows-and-evidence-escrow-contract-2026-03-21.md`
- `docs/agents/designs/63-jangar-consumer-projections-and-latency-class-admission-contract-2026-03-20.md`
- `docs/torghut/design-system/v6/62-torghut-lane-books-and-bounded-query-firebreak-contract-2026-03-20.md`

## Executive summary

The decision is to make the next six months of Torghut/Jangar work converge on one merged cutover program:
Jangar seals rollout and launch authority through **Recovery Warrants**, **Runtime Proof Cells**, and
**Projection Watermarks**, while Torghut settles promotion and rollback authority through
**Authority Mirrors**, **Hypothesis Vaults**, and **Post-Cost Profit Tapes**.

The reason is now stronger than it was in discover. The live cluster is no longer mostly unhealthy. It is healthy
enough to hide the real failures:

- Jangar rollout is healthy while backlog truth is still stale and March 11 freeze debt still dominates authority.
- Torghut dependencies are mostly healthy while mixed evidence is still collapsed into one route-time gate that blocks
  all lanes together.
- Both systems already have enough database and telemetry truth to carry durable authority ids; they are still short on
  the cross-plane program that makes those ids the only promotion-safe truth.

The tradeoff is more additive persistence and a stricter cutover sequence. I am keeping that trade because it buys the
highest leverage and the safest rollout behavior. More topology changes or tighter thresholds would still leave the hot
paths re-deriving truth from mutable state.

## Mission inputs and success criteria

Observed mission inputs:

- repository: `proompteng/lab`
- base: `main`
- head: `codex/swarm-torghut-quant-plan`
- swarmName: `torghut-quant`
- swarmStage: `plan`
- objective: assess cluster/source/database state and merge architecture artifacts that improve Jangar resilience and
  safer rollout behavior while defining measurable, bounded profitability improvements for Torghut

This program succeeds when:

1. Jangar readiness, status, launchers, and deploy verification all cite the same active `recovery_warrant_id` and
   fresh `projection_watermark_id` for a given execution class.
2. Torghut scheduler, `/trading/status`, `/readyz`, and promotion logic all cite the same active
   `hypothesis_vault_id`, `profit_window_id`, and latest settled `profit_tape_id` for a given hypothesis/account.
3. Stale backlog, missing runtime assets, stale empirical jobs, degraded market context, and stale quant latest-store
   authority degrade only the affected execution classes or hypotheses instead of collapsing everything into one global
   blocked answer.
4. Rollout and capital widening become stricter, not looser: no serving or launch promotion without sealed warrants,
   and no canary/live capital without funded vaults backed by settled post-cost tapes.

## Assessment synthesis

### Cluster and rollout state

- `GET http://jangar.jangar.svc.cluster.local/ready` at `2026-03-21T00:30:01Z`
  - returns HTTP `200`;
  - still reports `execution_trust.status="degraded"`;
  - still cites `requirements are degraded on jangar-control-plane: pending=5`;
  - still cites March 11 `StageStaleness` debt for both swarms.
- `GET http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status?namespace=agents&window=15m` at
  `2026-03-21T00:30:02Z`
  - reports `rollout_health.status="healthy"` with `agents=1/1` and `agents-controllers=2/2`;
  - still reports both swarms in `phase="Recovering"` and `updated_at` on `2026-03-11`;
  - proves rollout and recovery truth are still different objects.
- `kubectl -n agents get jobs`
  - shows repeated failed `jangar-control-plane-torghut-quant-req-*` jobs roughly `47m` to `134m` old;
  - also shows current plan/discover/verify work running on current images;
  - proves stale and fresh work are coexisting under a healthy-looking rollout.
- `kubectl -n agents logs job/jangar-control-plane-torghut-quant-req-00gc3cxb-3-ngvw-368131ff --tail=120`
  - still fails on missing `/app/skills/huly-api/scripts/huly-api.py` from image `jangar:c474fc44`;
  - proves runtime completeness is still a launch-admission problem.

Interpretation:

- Jangar now needs a proof ledger, not another liveness improvement.

### Trading and profitability state

- `GET http://torghut.torghut.svc.cluster.local/trading/status` at `2026-03-21T00:30:06Z`
  - reports `live_submission_gate.allowed=false`;
  - still cites `quant_health_fetch_failed`;
  - still points quant authority at the generic Jangar control-plane status route.
- `GET http://torghut.torghut.svc.cluster.local/trading/health` at `2026-03-21T00:30:41Z`
  - returns HTTP `503`;
  - still reports Postgres, ClickHouse, and Alpaca healthy;
  - remains blocked by stale empirical jobs plus missing quant authority.
- `GET http://jangar.jangar.svc.cluster.local/api/torghut/trading/control-plane/quant/health?account=PA3SX7FYNUTF&window=15m`
  - returns `ok=true`, `status="degraded"`, `latestMetricsCount=36`;
  - isolates the bad stage as `ingestion` with roughly `102k` seconds of lag;
  - proves the typed route is better than the generic fallback Torghut still uses.
- `GET http://torghut.torghut.svc.cluster.local/trading/empirical-jobs`
  - returns `ready=false`;
  - shows all four required jobs stale from `2026-03-19T10:31:27Z`;
  - proves truthful evidence exists but is too old to fund promotion.
- `GET http://jangar.jangar.svc.cluster.local/api/torghut/market-context/health?symbol=NVDA` at `2026-03-21T00:31:52Z`
  - returns `overallState="degraded"`;
  - shows stale fundamentals and stale news on very different time horizons;
  - proves market-context degradation should be hypothesis-local, not portfolio-global.

Interpretation:

- Torghut now needs a local economic authority path, not another remote fetch timeout rule.

### Database, schema, and freshness state

- direct Jangar Postgres queries at `2026-03-21T00:34:56Z`
  - show fresh component heartbeats and fresh quant control-plane rows;
  - prove the database can already carry warrant and watermark truth.
- direct Torghut Postgres queries at `2026-03-21T00:35:01Z`
  - confirm schema head `0025_widen_lean_shadow_parity_status`;
  - show `vnext_empirical_job_runs.latest_created_at="2026-03-19T10:31:27.462Z"` with no rows in the last `24`
    hours;
  - prove persistence exists, but promotion funding truth is still stale.
- direct ClickHouse queries at `2026-03-21T00:34Z`
  - show recent `ta_signals` and `ta_microbars` event/ingest timestamps;
  - prove the system has fresh signal data even while freshness guardrail metrics still show repeated fallback totals.
- `curl http://torghut-clickhouse-guardrails-exporter.torghut.svc.cluster.local:9108/metrics`
  - shows `freshness_fallback_total=829` for `ta_signals`;
  - shows `freshness_fallback_total=1944` for `ta_microbars`;
  - shows that retrieval cost and replica-local freshness debt must become economic evidence, not just operator notes.

Interpretation:

- the databases are not the bottleneck;
- the missing program is how their truth becomes authoritative.

## Alternatives considered

### Option A: service and topology split first

Summary:

- split more Jangar and Torghut hot paths into separate deployments, then revisit authority later.

Pros:

- reduces some request-path contention;
- may narrow some single-pod failures.

Cons:

- does not solve stale backlog replay;
- does not solve route-time authority drift;
- makes rollout complexity bigger before authority gets simpler.

Decision: rejected.

### Option B: continue with per-service contracts only

Summary:

- keep the current Jangar `65` and Torghut `64` contracts as the only active documents and let engineer/deployer
  stages reconcile the cutover order ad hoc.

Pros:

- no new vocabulary;
- smallest documentation delta.

Cons:

- leaves the cross-plane cutover order implicit;
- leaves engineer and deployer stages to invent their own merge contract;
- makes it easier for rollout and capital acceptance gates to drift again.

Decision: rejected.

### Option C: merged proof-ledger cutover program

Summary:

- keep the selected Jangar warrant/proof-cell/watermark path and Torghut mirror/vault/tape path;
- bind them with one cutover order, one validation matrix, and one handoff contract.

Pros:

- removes the remaining ambiguity about what lands first and what blocks promotion;
- aligns rollout safety and profitability funding on shared ids rather than shared intuition;
- preserves future option value because topology changes can still happen later without changing the authority model.

Cons:

- adds one more architecture artifact and a stricter staged rollout bar;
- requires coordination across Jangar and Torghut implementation work.

Decision: selected.

## Decision

Adopt **Option C**.

The selected implementation order is:

1. Jangar proof ledger first enough to stamp trustworthy projection watermarks.
2. Torghut local mirrors next so hot-path status and promotion stop depending on remote request-time fetches.
3. Hypothesis vaults and post-cost tapes next so capital is funded by settled evidence rather than mutable gate
   payloads.
4. Launch and promotion enforcement last, after shadow parity proves the new ids stay stable.

## Cutover program

### Wave 1. Proof ledger foundation

Jangar implementation scope:

- `control_plane_recovery_warrants`
- `control_plane_runtime_proof_cells`
- `control_plane_projection_watermarks`
- parity projection into `/ready`, `/api/agents/control-plane/status`, and deploy verification

Gate:

- no enforcement yet;
- active warrant and watermark ids are queryable and stable across those three surfaces.

### Wave 2. Local mirror foundation

Torghut implementation scope:

- `trading_authority_mirrors`
- mirror ingestion for typed Jangar quant, dependency quorum, market context, and recovery-warrant truth
- status and readiness read mirrors instead of live remote fetches on the hot path

Gate:

- mirror freshness and digest parity are visible beside the old route-time path for one full shadow session.

### Wave 3. Economic authority foundation

Torghut implementation scope:

- `trading_profit_windows` and `trading_evidence_escrows` remain as lower-level sources of truth;
- `trading_hypothesis_vaults`
- `trading_post_cost_profit_tapes`
- scheduler and promotion logic begin reading settled tape outcomes in shadow mode

Gate:

- every hypothesis/account pair can cite one active vault, one active window, and one latest settled tape.

### Wave 4. Launch and capital enforcement

Jangar enforcement:

- no launch under broken or superseded warrants;
- no rollout widening while required proof cells are degraded or active consumer watermarks point at broken warrants.

Torghut enforcement:

- no `canary` or `live` capital without funded vaults backed by settled fresh tapes;
- bounded `repair_probe` only when vault policy explicitly allows it;
- portfolio-wide block only when every active vault is underfunded, falsified, expired, or quarantined.

Gate:

- one full promotion cycle completes without warrant/tape parity drift.

## Engineer acceptance gates

1. migration coverage for all new Jangar and Torghut tables plus expiry semantics;
2. regression proving a missing helper asset creates a broken proof cell and blocks launches under the affected warrant;
3. regression proving route-time remote Jangar fetches are removed from the Torghut hot path once mirrors are active;
4. parity regression proving Jangar surfaces share one active warrant id and Torghut surfaces share one active vault and
   latest tape id;
5. regression proving stale empirical jobs remain visible as expired funding inputs and cannot fund `canary` or `live`;
6. regression proving degraded market-context or quant authority degrades only dependent hypotheses, not the entire
   portfolio.

## Deployer acceptance gates

1. shadow-write the Jangar proof ledger and Torghut mirror/vault/tape stack through one full market session before
   enforcement;
2. do not widen rollout while any required proof cell is degraded or any active projection watermark points at a
   broken warrant;
3. do not allow any hypothesis beyond `repair_probe` unless its active vault is funded and its latest settled tape is
   eligible;
4. treat launch under a broken or superseded warrant as a rollback trigger;
5. treat portfolio-wide block caused by one degraded authority kind as a rollback trigger until vault-local behavior is
   proven.

## Rollout and rollback expectations

Rollout order:

1. write-only Jangar proof ledger;
2. write-only Torghut authority mirrors;
3. write-only Torghut vault/tape settlement;
4. shadow parity on all affected surfaces;
5. Jangar launch enforcement;
6. Torghut capital enforcement.

Rollback order:

1. keep all new objects writing for forensics;
2. revert Jangar launch admission to the prior path if warrants misclassify live work;
3. revert Torghut promotion to shadow-only if mirrors, vaults, or tapes drift from observed safety;
4. restore the prior sealed warrant and quarantine the newer one if post-rollout parity disagrees.

## Risks

- mirror freshness thresholds can be tuned too tightly and create false underfunding;
- tape settlement can be tuned too loosely and hide intraday degradations;
- additive history tables will need retention and compaction planning;
- implementation may drift if engineer and deployer stages do not share the same cutover contract.

## Handoff to engineer and deployer

Engineer handoff:

- implement Wave 1 and Wave 2 before removing any hot-path fetch or launch fallback;
- keep the old reducers readable until parity is proven;
- land the parity and degradation regressions before enforcement.

Deployer handoff:

- require one shadow session before enforcing either rollout or capital changes;
- do not treat healthy rollout as sufficient without sealed warrants and fresh watermarks;
- do not treat healthy dependencies as sufficient without funded vaults and settled tapes;
- freeze widening immediately if warrant parity, watermark freshness, vault funding, or tape settlement drift.
