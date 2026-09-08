# 136. Torghut Quant Plan Closeout And Proof Surface Handoff (2026-05-07)

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

I am closing the plan-stage architecture lane on the **runtime-cell, proof-exchange, and authority-ledger direction**.

The live system is healthier than the first May 5 assessment, but it is still not capital-ready. Jangar serves HTTP
200, `deployment/jangar` is available, and the current Jangar pod is running. At the same time the Jangar typed control
plane still returns `dependency_quorum.decision=delay` because `execution_trust_degraded` remains a global freshness
authority reason. Torghut live serves `/healthz` with HTTP 200, and its scheduler, Postgres, ClickHouse, Alpaca, schema,
universe, empirical job, and DSPy readiness dimensions all report through the typed `/readyz` payload. The live
`/readyz` response is still HTTP 503 because capital is intentionally held at zero notional by `simple_submit_disabled`,
`hypothesis_not_promotion_eligible`, `execution_tca_stale`, and `quant_pipeline_degraded`.

That evidence supports the merged design rather than a new fork. Jangar must not treat a healthy serving route as
rollout or capital authority. Torghut must not treat a healthy liveness route, reachable databases, or stale empirical
proof as capital authority. The implementation path is to make the proof surfaces smaller, typed, bounded, and
account-scoped, then let Jangar consume those receipts for rollout and capital admission.

The tradeoff is deliberate friction. Non-shadow capital stays blocked while the system repairs execution TCA, alpha
readiness, quant ingestion, and Jangar execution trust. I accept that because a quant system that can explain why it is
not trading is more valuable than one that trades from partially healthy infrastructure.

## Evidence Snapshot

All assessment work was read-only. I did not mutate Kubernetes resources, database records, broker state, trading flags,
or GitOps manifests.

### Cluster And Rollout Evidence

- Jangar namespace pods were running: `jangar-56bdb9885b-dss9q` was `2/2 Running`, `jangar-db-1` was `1/1 Running`,
  and Bumba, Alloy, Open WebUI, Redis, Symphony, and Symphony-Jangar were running.
- `kubectl get deploy -n jangar` reported `jangar`, `bumba`, `jangar-alloy`, `symphony`, and `symphony-jangar` all
  available at `1/1`.
- Recent Jangar events showed the rollout from image `7a27ffda` to `39c27b12`, plus a transient readiness connection
  refusal during the new pod startup.
- Torghut namespace pods were running for live revision `torghut-00250`, simulation revision `torghut-sim-00350`,
  ClickHouse, Keeper, Postgres, options catalog, options enricher, TA lanes, websocket lanes, guardrail exporters,
  Alloy, and Symphony.
- Listing Knative services in namespace `torghut` was forbidden to this identity, so deployer verification must keep a
  least-privilege route that does not depend on broad Knative read access.
- Recent Torghut events still showed Flink status conflict churn, duplicate ClickHouse PodDisruptionBudget matches,
  and transient 503 readiness failures during revision turnover.

### Jangar Control-Plane Evidence

- `GET http://jangar.jangar.svc.cluster.local/health` returned HTTP 200 with `status=ok`.
- `GET /api/agents/control-plane/status?namespace=agents` returned a typed `dependency_quorum` with decision `delay`.
- The dependency-quorum reason was `execution_trust_degraded`; `freshness_authority` was degraded while
  `control_runtime`, `dependency_quorum`, `evidence_authority`, `market_data_context`, and `watch_stream` were healthy.
- This is the exact split the runtime-cell contract is meant to encode: serving can continue, while dispatch widening
  and Torghut promotion remain constrained by authority cells.

### Torghut Runtime Evidence

- `GET /healthz` for the live Knative route returned HTTP 200 with `status=ok`.
- `GET /readyz` for live revision `torghut-00250` returned HTTP 503 with `status=degraded`.
- The same live `/readyz` payload reported scheduler OK, Postgres OK, ClickHouse OK, Alpaca live broker OK, schema
  current, universe fresh from Jangar, empirical jobs healthy, and DSPy not active.
- Live capital was blocked: `live_submission_gate.allowed=false`, reason `simple_submit_disabled`,
  `proof_floor.floor_state=repair_only`, `capital_state=zero_notional`, and `max_notional=0`.
- Alpha readiness had three hypotheses, with one blocked, two shadow, zero promotion eligible, and three rollback
  required. Dependency quorum inside alpha readiness was `delay`.
- Quant evidence was informational but degraded: latest metrics existed, compute was fresh, ingestion lag was around
  40265 seconds, and materialization was not fully healthy.
- Execution TCA was stale for live: last computed at `2026-04-02T20:59:45.136640+00:00`, average absolute slippage was
  about `568.61` bps, and the guardrail was `8` bps.
- Simulation `/readyz` returned HTTP 200, but its proof floor still stayed `repair_only`; it had zero-notional capital
  state, alpha not promotion eligible, and execution TCA slippage above guardrail.

### Database And Data Evidence

- `kubectl get clusters.postgresql.cnpg.io -n jangar` and the Torghut equivalent were forbidden for
  `system:serviceaccount:agents:agents-sa`.
- `kubectl cnpg psql -n jangar jangar-db` and `kubectl cnpg psql -n torghut torghut-db` both failed because this
  identity cannot create `pods/exec` in those namespaces.
- Direct ClickHouse HTTP against `torghut-clickhouse:8123` returned HTTP 401.
- Torghut's typed readiness surface still proved useful database quality: Alembic head
  `0029_whitepaper_embedding_dimension_4096` was current, schema lineage was ready, and the known migration parent-fork
  warnings were reported explicitly.
- The conclusion is not that database evidence is unavailable. The conclusion is that privileged SQL and ClickHouse
  reads are not a portable control-plane dependency. The deployable contract must continue to rely on bounded,
  application-owned proof projections.

### Source Evidence

- `services/torghut/app/main.py` owns the large FastAPI runtime surface for health, readiness, database checks, trading
  status, trading health, proof floor, and quant evidence.
- `services/torghut/app/db.py` uses a small SQLAlchemy pool and exposes schema-readiness diagnostics used by `/readyz`
  and `/db-check`.
- `services/torghut/scripts/verify_quant_readiness.py` already validates profitability proof, rollback evidence,
  control-plane contract fields, alpha readiness metrics, and promotion traces.
- `services/torghut/scripts/build_historical_profitability_proof.py` and
  `services/torghut/scripts/assemble_production_readiness_bundle.py` are the right proof-materialization seams for the
  engineer stage.
- Jangar already exposes typed control-plane and quant-health routes under `services/jangar/src/routes/api/...`; the
  implementation risk is not missing a route, it is overloading route health as authority.
- Test coverage is broad around Torghut policy checks, quant readiness, trading pipeline, empirical jobs, promotion,
  and Jangar control-plane routes. The missing system test is cross-plane: a proof exchange item must be the only way a
  route can authorize non-shadow capital under degraded dependency quorum.

## Options Considered

### Option A: Widen Privileged Observability And Keep Route-Time Proof

This option would grant the runtime broader CNPG, pod exec, Knative, and ClickHouse access so agents and deployers can
read source databases directly and derive promotion truth on demand.

I reject it. It would make diagnosis easier for humans but would put privileged, slow, and non-portable reads in the
control path. It also repeats the failure mode already observed: healthy routes and reachable databases get confused
with promotion authority while expensive proof reads create latency and pool pressure.

### Option B: Runtime Cells, Proof Exchange, And Authority Ledgers

This option keeps serving, dispatch, rollout, and Torghut promotion as separate Jangar authority cells. Torghut compiles
bounded proof items asynchronously, keeps lane-local firebreaks, and requires profit authority ledger entries before
non-observe capital can move.

I select this option. It matches the evidence, has already been merged in PR 5390 and PR 5408, and gives engineer and
deployer stages small acceptance gates. It also preserves future option value: new alpha lanes, options lanes, and
forecast routers can be added as proof producers without changing the capital authority model.

### Option C: Pause Capital And Only Run Research

This option would hold all paper/live movement and invest only in autoresearch until empirical proofs look stronger.

I reject it as the primary architecture. Research is necessary, but the live failure is not only alpha quality. The
system needs execution TCA repair, fillability, quant ingestion, and Jangar authority receipts before any promising
research product can be safely promoted. Research without a proof exchange leaves the next candidate trapped behind the
same gates.

## Implementation Scope

Engineer stage should implement the merged contracts in this order:

1. Materialize Torghut proof-exchange items keyed by account, hypothesis, window, data dependencies, Jangar
   `source_cell_set_id`, proof digest, expiry, and capital state.
2. Make `/readyz`, `/trading/status`, Jangar quant health, and promotion checks read from bounded proof projections
   instead of compiling heavy proof on request.
3. Enforce lane-local firebreaks: stale quant ingestion, stale TCA, stale market context, or missing empirical proof
   blocks only hypotheses that declare that dependency.
4. Add Jangar runtime cells for serving, dispatch, rollout, proof-read, and Torghut promotion, each with its own
   backpressure and expiry.
5. Require a profit authority ledger entry and a Jangar authority ledger id before any non-observe capital state is
   allowed.
6. Keep repair and observe actions available under degraded execution trust, but keep paper/live admission closed until
   the proof floor passes.

## Validation Gates

Engineer acceptance is not complete until these checks are automated:

- Unit tests prove a route cannot report a more permissive capital state than the latest valid proof item.
- Unit tests prove expired proof items fail closed and produce repair actions instead of live/paper admission.
- Integration tests prove Jangar dependency quorum `delay` blocks Torghut paper/live promotion while serving and repair
  continue.
- Torghut `uv run --frozen pyright --project pyrightconfig.json`,
  `uv run --frozen pyright --project pyrightconfig.alpha.json`, and
  `uv run --frozen pyright --project pyrightconfig.scripts.json` pass for implementation changes.
- Torghut targeted pytest suites cover proof exchange, proof floor, policy checks, quant readiness, TCA freshness, and
  promotion truthfulness.
- Jangar route tests cover runtime-cell projection, dependency quorum, progress comment maintenance, and quant-health
  consumption.

Deployer acceptance is not complete until these live checks are green or intentionally held:

- Jangar `/health` stays HTTP 200.
- Jangar control-plane status exposes runtime-cell state and keeps `paper/live` held while execution trust is degraded.
- Torghut live `/healthz` stays HTTP 200.
- Torghut live `/readyz` either returns HTTP 200 with a passing proof floor or returns HTTP 503 with explicit
  zero-notional reasons and repair ladder entries.
- Direct privileged database access is not required for promotion verification.
- The deployed image revision in GitOps matches the runtime revision reported in proof items.

## Rollout

Roll out as an additive shadow path first.

1. Start proof-exchange writers in shadow mode and compare their verdicts to the existing `/readyz` proof floor.
2. Enable Jangar proof-read cells to consume proof items but keep action admission informational.
3. Require proof items for paper canary only after parity has held through one market session and one closed-session
   repair cycle.
4. Require profit authority ledger entries for paper canary after execution TCA is fresh and alpha readiness has at
   least one promotion-eligible hypothesis.
5. Keep live capital disabled until paper canary produces fresh fillability, TCA, rollback, and Jangar authority
   receipts.

## Rollback

Rollback must fail closed for capital and stay open for diagnosis.

- Disable proof-exchange consumption and fall back to the existing proof-floor route with `capital_state=zero_notional`.
- Expire defective proof schema versions instead of deleting historical proof records.
- Disable Jangar promotion-authority consumption while keeping serving, observe, and repair cells available.
- Revert the GitOps image promotion if route health regresses or if proof writers create database pressure.
- Keep `simple_submit_disabled` true until proof floor, execution TCA, and rollback receipts are healthy again.

## Risks

- Jangar execution trust is still degraded, so rollout widening must remain separated from serving health.
- Torghut live quant ingestion is stale by more than 11 hours in the sampled proof surface, so the current route can
  explain readiness but cannot justify capital.
- Execution TCA is stale for live and above guardrail in simulation; this is a capital blocker, not a reporting defect.
- Direct CNPG and ClickHouse reads are blocked by RBAC or auth. That is acceptable for production control paths but
  means deployer diagnostics must use typed projections.
- The migration graph has known parent-fork warnings even while current head and lineage readiness pass. Future schema
  work should keep the merge-migration discipline tight.

## Handoff

Engineer should treat PR 5390 and PR 5408 as the source of truth and implement the proof-exchange and authority-ledger
contracts before adding new trading logic. The first production code slice should be proof materialization and route
consumption, not a new strategy.

Deployer should keep the system at zero notional until the proof floor passes, Jangar dependency quorum clears for
promotion, Torghut alpha readiness has a promotion-eligible hypothesis, execution TCA is fresh and inside guardrail,
and quant ingestion is fresh for the account/window under consideration.

The next decision point is not whether Torghut should trade. The next decision point is whether the system can publish a
fresh, bounded, account-scoped proof item that would make one paper canary capital request explainable and reversible.

## Current Refresh 2026-05-07T17:25Z

I rechecked the lane after the later capital-evidence return contract merged. The architecture direction still holds,
but the live blocker moved.

Jangar is no longer failing the May 5 controller-rollout shape. The in-cluster identity is still
`system:serviceaccount:agents:agents-sa`; `deployment/agents` is `1/1`, `deployment/agents-controllers` is `2/2`,
`deployment/jangar` is `1/1`, Jangar `/ready` returns HTTP 200, and the control-plane status reports rollout health,
database projection, execution trust, and watch reliability as healthy. Jangar database migration consistency is
current with `28/28` Kysely migrations applied and latest migration
`20260505_torghut_quant_pipeline_health_window_index`.

The blocker is now capital evidence, not base serving availability. Jangar dependency quorum is `block` because
`empirical_jobs_degraded`, and the material-action verdict epoch keeps `dispatch_repair`, `dispatch_normal`,
`deploy_widen`, `merge_ready`, `paper_canary`, `live_micro_canary`, and `live_scale` held or blocked. The two permitted
action classes are read-only serving and Torghut observe. The deployer summary names
`source_rollout_truth_missing:source_or_gitops_revision` as the freshest blocking reason and rolls back to bounded
repair until a controller-ingestion witness is current.

Torghut serving is also split by capability. The active revision is `torghut-00274`; `/healthz` returns HTTP 200, and
`/trading/status` returns HTTP 200. `/db-check` now returns HTTP 200 with schema head
`0029_whitepaper_embedding_dimension_4096`, current/expected heads aligned, lineage ready, and only the known parent
fork warnings. `/readyz` still returns HTTP 503, which is the right answer while the proof floor is `repair_only`.

Capital remains intentionally closed. Torghut reports `live_submission_gate.allowed=false`,
`reason=simple_submit_disabled`, `capital_stage=shadow`, proof-floor `capital_state=zero_notional`, and
`max_notional=0`. Current proof-floor blockers are `hypothesis_not_promotion_eligible`, `degraded`,
`execution_tca_route_universe_empty`, `market_context_stale`, and `simple_submit_disabled`. The route reacquisition
book has `0` routeable symbols out of `8`: `AAPL`, `AMD`, `AVGO`, `INTC`, and `NVDA` are blocked by execution TCA,
while `AMZN`, `GOOGL`, and `ORCL` are missing execution TCA evidence.

The data picture is better than the older stale-TCA snapshot but still not paper-ready. TCA now has `7334` orders,
`7245` filled executions, latest execution timestamp `2026-04-02T19:00:29.586040Z`, and last computed timestamp
`2026-05-07T14:23:43.480686Z`. Average absolute slippage is about `13.82` bps against the `8` bps guardrail, so the
route universe still correctly resolves to zero candidates. Quant latest metrics are present for account
`PA3SX7FYNUTF`, window `15m`, with `144` latest metrics and low latest-store lag, but the stage array is empty and the
status remains `degraded` for `quant_pipeline_stages_missing`. Empirical jobs are now stale/degraded:
`benchmark_parity`, `foundation_router_parity`, `janus_event_car`, and `janus_hgrm_reward`.

Direct data-store access remains intentionally unavailable to this worker. CNPG psql against `torghut-db` is forbidden
because the service account cannot create `pods/exec` in namespace `torghut`, and unauthenticated ClickHouse HTTP
returns `REQUIRED_PASSWORD`. That reinforces the least-privilege design choice: deployer and engineer gates must use
typed runtime receipts and proof projections, not database shells.

The implementation order after this refresh is therefore unchanged but sharper:

1. Keep Jangar serving and observe open; keep dispatch widening, paper, and live held until material-action receipts
   clear.
2. Repair source-rollout truth and controller-ingestion witness parity so Jangar can distinguish route health from
   rollout truth without holding unrelated observe paths.
3. Refresh empirical job receipts, market-context receipts, quant stage receipts, and execution TCA route evidence as
   zero-notional work.
4. Open paper only after the proof floor reports a routeable symbol set, empirical jobs are current, quant stages are
   present, market context is fresh, and Jangar paper gate receipts allow `paper_canary`.
5. Keep live capital blocked until paper settlement produces reversible fillability, post-cost, and rollback receipts.
