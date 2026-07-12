# 135. Torghut Forecast Evidence Bonds And Capital Reentry Escrow (2026-05-06)

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

I am selecting **forecast evidence bonds with capital reentry escrow** as Torghut's next profitability architecture step.

Torghut has useful proof, but not enough tradable proof. At `2026-05-06T21:09Z`, `/db-check` was current at Alembic
head `0029_whitepaper_embedding_dimension_4096`, Postgres and ClickHouse dependencies were healthy, empirical jobs were
fresh, and four empirical artifacts were promotion-authority eligible for
`chip-paper-microbar-composite@execution-proof`. That is real progress.

The same evidence says capital should stay locked. `/readyz` returned `503`; live submission was blocked with
`simple_submit_disabled`; no hypotheses were promotion eligible; forecast service was degraded because the registry was
empty; quant ingestion lag was `12270` seconds; market context was stale across every domain; and account-scope checks
were bypassed because multi-account trading was disabled. Jangar correctly held paper/live material receipts on missing
Torghut consumer evidence and forecast-service degradation.

The selected design makes forecast and consumer evidence a first-class bond that Torghut owes Jangar before capital
reentry. Fresh empirical jobs can fund repair, but they cannot substitute for a forecast registry, live quant ingestion,
fresh market context, or paper settlement. The tradeoff is slower reentry to paper canaries. I accept it because the
fast path to profitability is not another stale shadow cycle; it is retiring the exact evidence debts that block the
first valid paper canary.

## Runtime Objective And Success Metrics

This contract increases profitability by turning forecast, market, quant, and proof-floor readiness into auditable bonds
with capital ceilings.

Success means:

- Forecast service `registry_empty` becomes a named, measurable repair item instead of a generic degraded status.
- Torghut emits a forecast evidence bond even when the bond is missing or failed, so Jangar can assign custody.
- Paper reentry requires current quant ingestion, market context, empirical jobs, forecast registry, and Jangar custody.
- Live micro reentry requires a clean paper escrow closeout plus execution/TCA settlement.
- Zero-notional repair work continues while paper/live capital remains held.
- Each repair bid has an expected unblock value, validation gate, and rollback condition.

## Evidence Snapshot

All evidence was collected read-only. I did not mutate Kubernetes resources, database records, broker state, trading
flags, GitOps manifests, ClickHouse data, or empirical artifacts.

### Cluster And Runtime Evidence

- Torghut live revision `torghut-00244` and sim revision `torghut-sim-00344` were running.
- Supporting pods were ready, including Torghut Postgres, ClickHouse, keeper, TA, sim TA, options TA, options catalog,
  options enricher, websocket services, and guardrail exporters.
- Live `/healthz` returned `status=ok`.
- Live `/readyz` returned HTTP `503` with `status=degraded`.
- Direct database inspection through pod exec was forbidden by RBAC; routine proof must be emitted through routes and
  receipts.

### Database And Data Evidence

- `/db-check` returned `ok=true`, `schema_current=true`, current/expected head
  `0029_whitepaper_embedding_dimension_4096`, and `schema_graph_lineage_ready=true`.
- The migration graph still exposed parent fork warnings for revisions
  `0010_execution_provenance_and_governance_trace` and `0015_whitepaper_workflow_tables`.
- Account scope was marked ready, but the route also warned that account scope checks are bypassed when
  `trading_multi_account_enabled` is false.
- Empirical jobs were fresh with dataset snapshot `torghut-chip-full-day-20260505-5e447b6d-r1`.
- Eligible empirical jobs were `benchmark_parity`, `foundation_router_parity`, `janus_event_car`, and
  `janus_hgrm_reward`.

### Profitability Evidence

- Forecast service status was degraded: `configured=false`, `message=registry_empty`, `registry_ref=null`, and no
  promotion-authority eligible models.
- Allowed forecast model families were `chronos`, `financial_tsfm`, and `moment`, but no model was bonded to the active
  proof floor.
- Quant evidence was degraded: latest metrics count `144`, metrics pipeline lag about `14` seconds, and max stage lag
  `12270` seconds because ingestion was stale.
- Market context was degraded: technicals were about `175812` seconds stale against a `60` second budget,
  fundamentals about `4778790` seconds stale against `86400`, news about `4411976` seconds stale against `300`, and
  regime about `175812` seconds stale against `120`.
- Live submission was blocked: `allowed=false`, `simple_submit_disabled`, `capital_stage=shadow`, and
  `promotion_eligible_total=0`.
- Alpha readiness loaded three hypotheses, with one blocked, two shadow, and zero promotion eligible.

### Source Evidence

- `services/torghut/app/main.py` exposes `_forecast_service_status()`, `_lean_authority_status()`, and
  `_empirical_jobs_status()` for the autonomy and readiness surfaces.
- `services/torghut/app/trading/autonomy/gates.py` Gate 3 already checks forecast fallback rate, forecast inference
  latency p95, and forecast calibration score.
- `services/torghut/app/trading/submission_council.py` already combines promotion eligibility, active capital stage,
  empirical jobs, quant evidence, and live submission gate reasons.
- `services/jangar/src/server/control-plane-action-clock.ts` already treats `forecast_service_degraded` as empirical
  debt for Torghut capital actions.
- The missing architecture layer is an explicit forecast evidence bond that Jangar can consume before capital receipts
  move from hold to paper or live.

## Problem

Torghut's current proof floor is mixed: strong empirical artifacts, weak current-market proof, and no usable forecast
registry.

The current failure modes are:

1. **Fresh empirical proof can be over-read.** Empirical jobs are current, but they do not prove the active market,
   forecast, or execution path is ready.
2. **Forecast readiness is under-specified.** `registry_empty` says why the service is degraded but not what bond must
   be produced to clear it.
3. **Quant freshness is split.** Metrics are current while ingestion is more than three hours behind.
4. **Market context is stale in every domain.** LLM and event-reversion hypotheses cannot price current risk.
5. **Account-scope proof is bypassed.** The route is ready, but multi-account checks are not active.
6. **Capital receipts lack producer custody.** Jangar can hold paper/live capital, but Torghut must name the producer
   and validation gate for each missing bond.

## Alternatives Considered

### Option A: Promote Paper Because Empirical Jobs Are Fresh

Pros:

- Fastest way to collect more paper observations.
- Uses existing empirical artifacts and running revisions.
- Avoids new bond schemas.

Cons:

- Ignores forecast registry empty state.
- Ignores stale market context and stale quant ingestion.
- Ignores `/readyz` degradation and live submission gate closure.
- Risks converting stale proof into paper churn.

Decision: reject.

### Option B: Freeze All Trading And Repair Everything Manually

Pros:

- Strongest capital safety.
- Easy to reason about during incidents.
- Prevents stale proof from leaking into paper/live decisions.

Cons:

- Slows zero-notional repair.
- Does not rank forecast, quant, market-context, and hypothesis blockers.
- Wastes fresh empirical artifacts that can guide repair priority.
- Leaves Jangar without machine-readable producer custody.

Decision: reject.

### Option C: Forecast Evidence Bonds With Capital Reentry Escrow

Pros:

- Keeps capital at zero while preserving zero-notional repair throughput.
- Makes the missing forecast registry a concrete producer obligation.
- Lets Jangar consume Torghut bonds without privileged database access.
- Separates paper reentry from live micro reentry.
- Turns stale market/quant evidence into ranked repair bids.

Cons:

- Requires a bond schema and route additions.
- Requires calibration thresholds before the forecast bond can lift paper holds.
- Delays capital until the first clean bond set exists.

Decision: select Option C.

## Architecture

Torghut emits one forecast evidence bond per account, model family, strategy family, and market window.

```text
forecast_evidence_bond
  bond_id
  generated_at
  account_label
  strategy_family
  model_family
  registry_ref
  policy_ref
  calibration_window
  fallback_rate
  inference_latency_ms_p95
  calibration_score_min
  training_data_ref
  validation_artifact_refs
  status                 # pass, degraded, missing, stale, failed
  reason_codes
  fresh_until
```

Capital reentry consumes a bundle of bonds, not one global ready bit.

```text
capital_reentry_escrow
  escrow_id
  generated_at
  account_label
  jangar_inventory_id
  proof_floor_receipt_id
  forecast_bond_id
  quant_bond_id
  market_context_bond_id
  empirical_bond_id
  execution_settlement_bond_id
  state                  # repair_only, shadow_ready, paper_ready, live_micro_ready, blocked
  max_notional
  required_repairs
  rollback_target
  fresh_until
```

Repair bids compete for zero-notional capacity:

```text
evidence_repair_bid
  bid_id
  created_at
  repair_kind            # forecast_registry, quant_ingestion, market_context, account_scope, tca_settlement
  blocker_reason
  expected_unblock_value
  cost_budget
  validation_gate
  priority_score
  rollback_condition
```

Repair ranking for the current evidence:

1. Seed a forecast registry bond with at least one allowed family, policy ref, calibration window, and artifact ref.
2. Repair quant ingestion for `PA3SX7FYNUTF` until max stage lag is inside the `15m` proof-floor threshold.
3. Refresh market context domains, starting with news and technicals because their freshness budgets are shortest.
4. Produce account-scope proof with multi-account checks enabled or an explicit single-account waiver.
5. Recompute execution/TCA settlement before live micro reentry.

## Engineer Handoff

Implement the bond producer and Jangar consumer path without enabling paper/live capital.

Required source scope:

- `services/torghut/app/main.py`
- `services/torghut/app/trading/forecast_runtime.py`
- `services/torghut/app/trading/submission_council.py`
- `services/torghut/app/trading/autonomy/gates.py`
- `services/torghut/app/trading/autonomy/policy_checks.py`
- `services/jangar/src/server/control-plane-empirical-services.ts`
- `services/jangar/src/server/control-plane-action-clock.ts`
- `services/jangar/src/server/control-plane-negative-evidence-router.ts`

Acceptance gates:

- `/trading/autonomy` exposes a `forecast_evidence_bond` even when it is missing or degraded.
- `registry_empty` maps to `forecast_registry_bond_missing` with a producer, validation gate, and repair bid.
- Capital reentry escrow remains `repair_only` while forecast, quant, market-context, account-scope, or execution
  settlement bonds are missing.
- Jangar status replaces generic `torghut_consumer_evidence_missing` with named Torghut bond requirements.
- Tests cover registry-empty, forecast bond pass, quant ingestion stale, market context stale, account-scope bypass, and
  capital reentry blocked states.

## Deployer Handoff

Roll out the bond route in observe mode first.

Validation commands:

- `curl -sS http://torghut.torghut.svc.cluster.local/trading/autonomy | jq '.forecast_evidence_bond, .forecast_service'`
- `curl -sS http://torghut.torghut.svc.cluster.local/readyz | jq '.dependencies.quant_evidence, .live_submission_gate'`
- `curl -sS http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status | jq '.material_action_activation_receipts[] | select(.action_class | test("paper|live"))'`
- `curl -sS http://jangar.jangar.svc.cluster.local/api/torghut/market-context/health | jq '.health.domainHealth'`
- `curl -sS "http://jangar.jangar.svc.cluster.local/api/torghut/trading/control-plane/quant/health?account=PA3SX7FYNUTF&window=15m" | jq '.stages'`

Paper reentry gates:

- Forecast bond passes with non-empty registry ref and calibration score at or above policy.
- Quant ingestion and materialization are healthy for the active account/window.
- Market context domains are inside freshness budgets or have explicit hold waivers.
- Empirical jobs remain fresh and truthful for the candidate id.
- Jangar cross-plane inventory is fresh and acknowledges the Torghut bonds.

Live micro gates:

- All paper reentry gates pass.
- Paper settlement closes cleanly for the configured window.
- Execution/TCA settlement is current and inside slippage thresholds.
- Live submission gate is explicitly enabled and promotion eligibility is non-zero.

Rollback:

- Keep capital stage at `shadow` and continue emitting degraded bonds.
- Disable capital reentry escrow consumption before reverting bond producers.
- Revert to proof-floor hold behavior if Jangar cannot consume bond payloads.
- Never use empirical job freshness alone to lift paper or live holds.

## Risks

- Forecast registry seeding can create false confidence if calibration windows are too short.
- Market-context repair may consume data budget without improving promotion eligibility.
- Jangar consumers must handle missing bond fields during rollout.
- Account-scope bypass needs an explicit waiver path or it will keep blocking reentry.

## Validation For This Artifact

- Read-only Torghut routes confirmed DB schema currency, forecast registry empty state, empirical job freshness, quant
  ingestion lag, market-context staleness, and live submission hold.
- Read-only Jangar routes confirmed paper/live material receipts are already held on missing consumer evidence and
  forecast service degradation.
- Documentation validation is `bunx oxfmt --check` on the changed markdown files.
