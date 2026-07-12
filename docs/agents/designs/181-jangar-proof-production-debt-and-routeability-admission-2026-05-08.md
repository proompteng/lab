# 181. Jangar Proof-Production Debt And Routeability Admission (2026-05-08)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-08
Owner: Gideon Park, Torghut Traders Architecture Lead
Scope: Jangar control-plane reliability, proof-production debt, Torghut routeability admission, rollout backpressure,
capital safety, validation, rollout, rollback, and handoff.

Companion Torghut contract:

- `docs/torghut/design-system/v6/185-torghut-routeability-repair-acceptance-ledger-2026-05-08.md`

Extends:

- `180-jangar-execution-trust-debt-retirement-and-profit-repair-settlement-2026-05-08.md`
- `179-jangar-controller-witness-stability-escrow-and-capital-reentry-backpressure-2026-05-08.md`
- `67-jangar-runtime-cells-and-rollout-backpressure-contract-2026-05-05.md`
- `../torghut/design-system/v6/184-torghut-execution-trusted-profit-repair-settlement-2026-05-08.md`

## Decision

I am selecting **proof-production debt retirement with routeability admission** as the next Jangar architecture step for
Torghut quant.

The current control plane is healthier than the May 5 soak, but it is not free to spend capital authority. Read-only
cluster evidence at `2026-05-08T12:27Z` showed `agents-controllers` at `2/2`, Jangar at `2/2`, Torghut and Torghut sim
at `2/2`, and Torghut Postgres, ClickHouse, Keeper, TA, options TA, WebSocket, options catalog, and options enricher
running. The May 5 contradiction of HTTP serving while controller quorum was degraded has improved.

The new contradiction is proof production. Recent scheduled plan, discover, implement, and verify cron pods still show
Error entries. Torghut `/readyz` is degraded even though Postgres, ClickHouse, and migrations are current. Jangar quant
health for `PA3SX7FYNUTF/15m` is `ok=true` but `status=degraded`: 144 latest metrics exist, the latest metrics update
was `2026-05-08T12:25:51.593Z`, runtime is enabled, and `missingPipelineHealthStages=true` with no scoped stages
recorded. Torghut also reports market-context staleness for news, regime, and technicals.

Jangar must not translate recovered pod health into route admission. It should admit only proof-production work that
can retire a named Torghut value-gate debt lot while preserving zero-notional safety. The tradeoff is lower apparent
throughput: some agent work that can run will be held until it declares which proof debt it retires. That is the right
tradeoff while Torghut's business state is `repair_only`.

## Current Evidence

All checks below were read-only. I did not mutate Kubernetes resources, database records, GitOps state, broker state, or
trading flags.

### Cluster And Rollout

- `kubectl auth whoami` used the in-cluster service account `system:serviceaccount:agents:agents-sa`.
- `kubectl get deploy -n agents` reported `agents-controllers 2/2`, `agents 1/1`, and `agents-alloy 1/1`.
- `kubectl get pods -n jangar` reported `jangar-7cd957c744-mhlg5 2/2 Running` plus running Jangar DB and supporting
  services.
- `kubectl get pods -n torghut` reported `torghut-00308-deployment-7d87dd9db-4bjt6 2/2 Running` and
  `torghut-sim-00406-deployment-5f7646d6cd-fx54s 2/2 Running`.
- Knative service reads were forbidden for this service account, so rollout evidence used deployments, pods, services,
  and events.
- Recent Torghut events showed normal `torghut-00308` and `torghut-sim-00406` revision readiness after startup probe
  and readiness probe warmup.
- Recent Torghut events also showed repeated ClickHouse multiple-PDB warnings and a no-pods keeper PDB warning. Those
  are not route blockers by themselves, but they are rollout-noise sources deployers should clear.

### Torghut And Data Signals Consumed By Jangar

- Torghut `/healthz` returned HTTP 200 with `{"status":"ok","service":"torghut"}`.
- Torghut `/readyz` returned HTTP 503 and `status=degraded`.
- `/readyz` dependencies for Postgres, ClickHouse, and database schema were OK. Alembic current and expected heads were
  both `0030_evidence_epochs`; schema lineage was ready, with parent-fork warnings already known.
- The live submission gate was closed: `simple_submit_disabled`, `capital_stage=shadow`, and blocked reasons
  `hypothesis_not_promotion_eligible` plus `simple_submit_disabled`.
- The proof floor was `repair_only`, `capital_state=zero_notional`, and required.
- Revenue repair digest reported `revenue_ready=false`, `business_state=repair_only`, and blockers
  `hypothesis_not_promotion_eligible`, `simple_submit_disabled`, and `quant_pipeline_stages_missing`.
- Quant health had 144 latest metrics and no empty-store alarm, but zero scoped pipeline stages and
  `missingPipelineHealthStages=true`.
- Market context last checked ORCL at `2026-05-08T12:27:40Z`; fundamentals were OK, while technicals, news, and regime
  were stale.

### Source Risk

- Jangar quant runtime and store logic is concentrated in `services/jangar/src/server/torghut-quant-runtime.ts` and
  `services/jangar/src/server/torghut-quant-metrics-store.ts`.
- Torghut readiness and status projection is concentrated in `services/torghut/app/main.py`, which is already over
  5,000 lines.
- Torghut has focused tests for quant readiness, revenue repair digest, capital reentry cohorts, quality-adjusted
  frontier, and Jangar consumer evidence. The missing test surface is the cross-plane admission invariant: Jangar may
  run repair work while Torghut stays zero-notional, but Jangar may not admit routeability or paper action from pod
  health alone.

## Problem

Jangar now has enough runtime health to keep work moving, but not enough proof quality to make routeability claims for
Torghut.

The failure modes are concrete:

1. Controller replicas can be ready while scheduled proof-producing jobs still fail.
2. Quant latest metrics can be present while scoped pipeline stages are missing.
3. Torghut `/healthz` can be 200 while `/readyz` is degraded and revenue is repair-only.
4. Market-context agents can produce a recent bundle while individual domains remain stale.
5. Jangar can see a running Torghut revision but miss the capital gate state unless it consumes the typed revenue
   repair digest.
6. A successful agent run can create audit volume without reducing any business gate.

## Alternatives Considered

### Option A: Treat Recovered Deployments As The Admission Signal

Advantages:

- Simple to implement.
- Restores throughput quickly.
- Avoids deeper coupling to Torghut proof payloads.

Disadvantages:

- Recreates the May 5 problem in a new form: serving health is not proof health.
- Does not distinguish repair-only work from paper/live capital work.
- Can inflate routeable candidate counts without settled evidence.

Decision: reject. Deployment health is a prerequisite, not an admission contract.

### Option B: Freeze All Torghut Quant Agent Work Until `/readyz` Is Healthy

Advantages:

- Strong safety posture.
- Easy to reason about.
- Prevents accidental paper or live action.

Disadvantages:

- Blocks the zero-notional repair work needed to make `/readyz` healthy.
- Treats market-context refresh, quant-stage repair, TCA repair, and capital action as one risk class.
- Leaves `routeable_candidate_count` and stale-evidence rates unchanged.

Decision: reject as default. Keep it as an emergency brake if Jangar controller quorum or Torghut capital gate
integrity fails.

### Option C: Proof-Production Debt Retirement With Routeability Admission

Advantages:

- Lets Jangar run repair work while preserving Torghut zero-notional safety.
- Forces every admitted run to cite a Torghut value gate and a proof-debt lot.
- Separates control-plane availability from routeability and capital authority.
- Gives deployers an observable reason when proof work is held.

Disadvantages:

- Adds another admission reducer and status surface.
- Requires Jangar to consume Torghut repair ledger payloads without becoming the source of capital truth.
- Some runnable work will wait until it declares a measurable proof outcome.

Decision: select Option C.

## Architecture

Jangar adds a derived routeability admission layer for Torghut-facing work:

```text
jangar_routeability_admission
  schema_version
  generated_at
  swarm_name
  action_class
  torghut_revision
  torghut_revenue_repair_ref
  torghut_routeability_ledger_ref
  jangar_runtime_cell_state
  proof_production_debt_lots[]
  admission_decision
  hold_reasons[]
  allowed_repair_classes[]
  blocked_action_classes[]
  rollback_target
```

The admission layer consumes Torghut's routeability repair ledger, not raw database tables. It can allow work in these
classes while Torghut is `repair_only`:

- `quant_stage_repair`
- `market_context_refresh`
- `route_tca_repair`
- `forecast_registry_repair`
- `alpha_readiness_evidence`
- `schema_lineage_witness`
- `rejection_drag_measurement`

It must hold these classes until Torghut and Jangar receipts settle:

- `paper_route_probe`
- `live_submission`
- `capital_increase`
- `slippage_threshold_loosening`
- `routeable_candidate_claim`

Rules:

- Pod health cannot produce `routeable_candidate_count`.
- Every admitted repair run cites one of `post_cost_daily_net_pnl`, `routeable_candidate_count`,
  `zero_notional_or_stale_evidence_rate`, `fill_tca_or_slippage_quality`, or `capital_gate_safety`.
- While Torghut revenue repair digest is `business_state=repair_only`, paper and live action classes are held.
- Missing scoped quant stages are debt even when latest metrics are present.
- Market-context domain staleness is debt even when a bundle exists.
- Forbidden direct database access is observer limitation, not proof success.

## Validation Gates

Local engineer checks:

- Add unit tests for routeability admission decisions when Torghut is healthy, degraded, repair-only, missing scoped
  quant stages, stale market context, and closed live submission.
- Add a fixture where `agents-controllers=2/2` and Jangar pod is running, but Torghut `/readyz` is degraded; paper route
  action must remain held.
- Add a fixture where Torghut revenue repair exposes only zero-notional repair lots; admission may allow repair work but
  must block routeable candidate claims.
- Run the Jangar test slice that covers control-plane Torghut consumer evidence and quant runtime materialization.

Runtime deployer checks:

- `agents-controllers` remains `2/2`.
- Jangar routeability admission payload is fresh.
- Torghut `/readyz` can be degraded without enabling paper/live action.
- Admitted repair runs cite a Torghut ledger lot and a value gate.
- `capital_gate_safety` remains intact: live max notional stays zero while Torghut proof floor is repair-only.

## Rollout

1. Ship admission in observe mode and publish decisions without blocking existing repair work.
2. Compare admission decisions against Torghut revenue repair digest for one market session.
3. Enforce holds for paper/live/action-class claims while allowing zero-notional repair classes.
4. Wire NATS/Jangar status to report held action classes and the top proof-production debt lots.
5. Promote only after held decisions are stable and no repair class is incorrectly blocked.

## Rollback

- Disable routeability admission enforcement and keep observe-only payloads.
- Keep Torghut proof floor and submission gate as the capital source of truth.
- Do not loosen slippage, alpha, quant, or market-context gates as a rollback.
- If Jangar controller quorum regresses below `2/2`, hold all Torghut paper/live action classes and continue only
  explicitly safe zero-notional diagnostics.

## Risks And Tradeoffs

- Admission coupling: Jangar now depends on Torghut payload shape. Mitigation: consume a versioned ledger ref and fail
  closed for action classes while allowing diagnostics.
- Throughput loss: some agent work will wait. Mitigation: repair classes remain allowed when they cite debt lots.
- False debt: stale or missing stage evidence may be an instrumentation gap. Mitigation: count it as
  `zero_notional_or_stale_evidence_rate` debt until a receipt proves freshness.
- Operator confusion: `/healthz=ok` and `/readyz=degraded` must be presented plainly. Mitigation: Jangar status should
  show business state, not just pod state.

## Handoff

Engineer handoff: implement the routeability admission reducer and tests in Jangar, reading Torghut's ledger as a
consumer. Do not make Jangar the source of capital truth. The first accepted implementation must prove that a healthy
Jangar pod plus degraded Torghut `/readyz` keeps paper/live action held while allowing named zero-notional repair work.

Deployer handoff: deploy observe-only first. Acceptance is a fresh admission payload, no non-zero live notional while
Torghut is `repair_only`, admitted repair runs tied to value gates, and Jangar status showing the top debt lots:
`quant_pipeline_stages_missing`, `market_context_stale`, `hypothesis_not_promotion_eligible`, and
`simple_submit_disabled`.
