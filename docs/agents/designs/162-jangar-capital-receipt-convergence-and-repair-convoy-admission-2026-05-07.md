# 162. Jangar Capital Receipt Convergence And Repair Convoy Admission (2026-05-07)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-07
Owner: Gideon Park, Torghut Traders Architecture
Scope: Jangar control-plane resilience, material-action admission, Torghut receipt convergence, repair convoy budgets,
safe rollout, rollback, validation, and handoff.

Companion Torghut contract:

- `docs/torghut/design-system/v6/166-torghut-executable-profit-receipts-and-repair-convoy-settlement-2026-05-07.md`

Extends:

- `161-jangar-stage-debt-clearinghouse-and-freshness-credit-ledger-2026-05-07.md`
- `161-jangar-repair-outcome-brownout-market-and-stage-freeze-clearing-2026-05-07.md`
- `159-jangar-authority-surface-settlement-and-quant-stage-cohort-gates-2026-05-07.md`
- `docs/torghut/design-system/v6/165-torghut-outcome-priced-repair-market-and-capital-shadow-swaps-2026-05-07.md`

## Decision

I am selecting **capital receipt convergence with repair convoy admission** as Jangar's next control-plane architecture
step.

The current system is healthier than the early degraded soak, but it is still not ready for capital. The `agents`,
`jangar`, and `torghut` namespaces are active. `agents`, `agents-controllers`, `jangar`, Torghut live
`torghut-00280`, Torghut simulation `torghut-sim-00380`, and the Torghut options catalog/enricher deployments are
available. Argo CD reports `jangar`, `torghut`, and `torghut-options` as `Synced/Healthy` at
`5549fe9bb4f34cac56f5db3619b0cb53405b7783`. Jangar execution trust is healthy.

The material-action blocker is narrower: Jangar dependency quorum still blocks on `empirical_jobs_degraded`, Torghut
live proof floor is `repair_only` with `capital_state=zero_notional`, live routeability is zero of eight symbols, live
submit remains disabled, market context is stale, and no alpha hypothesis is promotion eligible. Simulation gives one
useful seed, `NVDA`, but it has empty quant latest metrics, no quant stages, stale TCA, one unsettled execution, and
seven missing symbols.

The important architecture gap is not another status name. Recent accepted docs define stage-debt clearing,
repair-outcome brownout markets, quant stage cohorts, freshness debt ledgers, and outcome-priced repair markets. The
current source/status surface does not yet expose `stage_debt_clearinghouse`, `repair_outcome_brownout_market`,
`quant_stage_cohort`, `quant_freshness_debt_ledger`, or `outcome_priced_repair_market`. What is live today is more
basic and more useful: Torghut already publishes proof-floor and route-reacquisition receipts, Jangar already computes
dependency quorum, execution trust, material-action verdicts, route-stability escrow, source rollout truth, runtime
kits, and runtime proof cells.

Jangar should converge those existing receipts into one **CapitalReceiptEpoch** before it admits any material action.
It should then admit only bounded **RepairConvoys**: small zero-notional work bundles that cite the exact receipt gap
they reduce, the before evidence, the required after evidence, the dispatch budget, and the rollback trigger.

The tradeoff is discipline over breadth. This design intentionally defers enforcement of the larger unimplemented
ledger vocabulary until the receipt spine exists. That is the right tradeoff because the present failure mode is
contract drift: accepted architecture is ahead of executable status contracts, and deployers cannot use missing
objects as gates.

## Evidence Snapshot

All evidence for this pass was read-only. I did not mutate Kubernetes resources, databases, GitOps resources,
AgentRuns, broker state, or Torghut flags.

### Cluster And Rollout Evidence

- Branch: `codex/swarm-torghut-quant-discover`; local branch was based on `origin/main` at
  `5549fe9bb4f34cac56f5db3619b0cb53405b7783` before this design change.
- The Kubernetes context was bootstrapped from the in-cluster service account. `kubectl auth whoami` identified
  `system:serviceaccount:agents:agents-sa`.
- Namespaces `agents`, `jangar`, and `torghut` were `Active`.
- `agents` was `1/1`, and `agents-controllers` was `2/2`; recent events still showed readiness probe timeouts on
  `agents` and one controller replica, but the current deployments were available.
- Both swarms, `jangar-control-plane` and `torghut-quant`, were `Active`, `lights-out`, and `Ready=True`.
- Recent AgentRun history showed completed discover, plan, implement, and verify jobs, plus current running discover
  and verify work. There were older failed verify runs and a recent `FailedMount` for a Torghut verify attempt whose
  ConfigMap was missing. Jangar must keep launch admission bounded even while the control plane is broadly serving.
- Jangar deployment `jangar` was `1/1` on image
  `registry.ide-newton.ts.net/lab/jangar:c7f3aa1b@sha256:6ca018b8a975365550fa450e8cd1abdb746e1179e0c75e1d96b153e09c587fbb`.
- Torghut live `torghut-00280-deployment` and sim `torghut-sim-00380-deployment` were each `1/1` on image
  `registry.ide-newton.ts.net/lab/torghut@sha256:0927f669a37ccc4130ab7693a5ea91b446f4bc0cfb7709613fa49e00b8b95a4b`.
- Torghut options catalog and enricher were each `1/1` on the same Torghut digest.
- Recent Torghut events showed successful DB migration, empirical jobs backfill, semantic backfill, and whitepaper
  bootstrap jobs on the latest image. They also showed startup/readiness probe failures during revision handoff and
  options readiness failures before the new pods became available.
- Direct Knative service listing was forbidden to this worker, and direct CNPG `psql` was forbidden because the service
  account cannot create `pods/exec` in `torghut` or `jangar`. Typed HTTP routes are therefore the normal proof surface.

### Jangar Evidence

- `GET /api/agents/control-plane/status?namespace=agents` reported dependency quorum `decision=block` with reason
  `empirical_jobs_degraded`.
- The same status payload classified control runtime, dependency quorum segment health, freshness authority, evidence
  authority, market data context, and watch stream as healthy.
- Jangar execution trust was `healthy` with no blocking windows.
- The status payload included keys for `material_action_activation_receipts`, `material_action_verdict_epoch`,
  `material_action_verdicts`, `route_stability_escrow`, `source_rollout_truth_exchange`, `runtime_kits`,
  `runtime_proof_cells`, and `stages`.
- The status payload did not expose `stage_debt_clearinghouse` or `repair_outcome_brownout_market`, despite those
  being accepted design targets.
- Unscoped Jangar quant health returned `ok=true`, `status=ok`, `latestMetricsCount=4284`, update time
  `2026-05-07T20:11:48.265Z`, no missing update alarm, and no stage receipts.
- Live account/window quant health returned 144 latest metrics and three stages. Compute was fresh, ingestion was not:
  ingestion lag was `538528` seconds, and materialization was not OK with `lagSeconds=23`.
- Simulation account/window quant health returned `latestMetricsCount=0`, `emptyLatestStoreAlarm=true`, and no stages.

### Torghut Data Evidence

- Torghut `/healthz` returned `status=ok`.
- Torghut `/db-check` returned `ok=true`, `schema_current=true`, current and expected Alembic head
  `0029_whitepaper_embedding_dimension_4096`, one current head, one expected head, no missing heads, no unexpected
  heads, and lineage-ready schema graph. Parent-fork warnings remain documented at
  `0010_execution_provenance_and_governance_trace` and `0015_whitepaper_workflow_tables`.
- Torghut live `/trading/health` returned `status=degraded`.
- Live dependencies were mostly healthy: Postgres OK, ClickHouse OK, Alpaca live account `PA3SX7FYNUTF` active,
  Jangar universe fresh with eight symbols, readiness cache fresh, and quant evidence informational.
- Live submission gate was closed by `simple_submit_disabled`, capital stage `shadow`, proof floor `repair_only`,
  route state `repair_only`, capital state `zero_notional`, and max notional `0`.
- Live alpha readiness had three shadow hypotheses, zero promotion eligible, and three rollback required.
- Live proof-floor blockers were `hypothesis_not_promotion_eligible`, `degraded`,
  `execution_tca_route_universe_empty`, `market_context_stale`, and `simple_submit_disabled`.
- Live routeability had zero routeable symbols, five blocked symbols, and three missing symbols. Blocked symbols were
  `AAPL`, `AMD`, `AVGO`, `INTC`, and `NVDA`; missing symbols were `AMZN`, `GOOGL`, and `ORCL`.
- Live TCA had 7334 orders, 7245 filled executions, latest TCA at `2026-05-07T14:23:43.480686Z`, latest execution
  created at `2026-04-02T19:00:29.586040Z`, average absolute slippage `13.8203637593029676` bps, and guardrail
  `8` bps.
- Torghut `/trading/empirical-jobs` returned `ready=false`, `status=degraded`, `authority=blocked`, and four stale
  completed job rows created at `2026-05-06T16:27:32.941330+00:00`.
- Live `/trading/profitability/runtime` covered a 72-hour window with 17 decisions, zero executions, and 13571 TCA
  samples.
- Torghut options catalog `/readyz` returned `ready=true` but `last_success_ts=null`; that is still a weak proof
  receipt for options-dependent capital.
- Torghut sim `/trading/health` was operationally `status=ok`, but proof floor remained `repair_only`,
  `capital_state=zero_notional`, and alpha readiness still had zero promotion-eligible hypotheses.
- Sim routeability had one `NVDA` probing path, seven missing symbols, TCA freshness above the 86400 second threshold,
  one unsettled execution, empty quant latest metrics, and no quant stages.

### Source And Test Evidence

- `services/jangar/src/server/control-plane-status.ts` is the right aggregation surface for convergence; it is 787
  lines and already pulls multiple control-plane safety signals into one status read model.
- `services/jangar/src/server/control-plane-material-action-verdict.ts`, `control-plane-route-stability-escrow.ts`,
  and `control-plane-source-rollout-truth-exchange.ts` already provide material-action, route-stability, and
  source-truth ingredients.
- `services/torghut/app/main.py` remains broad at 4188 lines. Torghut should not absorb more admission policy into the
  HTTP assembly layer.
- `services/torghut/app/trading/scheduler/pipeline.py` is 4401 lines and remains the highest-risk execution path.
- `services/torghut/app/trading/proof_floor.py`, `route_reacquisition.py`, `submission_council.py`, and
  `revenue_repair.py` are the executable receipt producers available now.
- Source search found the newer objects only in docs, not in implementation: `quant_stage_cohort`,
  `quant_freshness_debt_ledger`, `outcome_priced_repair_market`, `stage_debt_clearinghouse`, and
  `repair_outcome_brownout_market`.
- The Torghut service has 144 Python tests, and Jangar has 175 TypeScript test/spec/e2e files. Missing coverage is not
  basic health; it is convergence semantics: missing higher-level receipts must produce finite hold reasons, not
  ambiguous deployer gates.

## Problem

Jangar can see that the system is blocked, but the control plane does not yet have a single executable convergence
contract that says which receipts are missing, which receipts are stale, and which zero-notional repairs are allowed to
try to close them.

That creates four failure modes:

1. **Design-status drift.** Accepted docs name richer objects than the current status route emits. Engineer and
   deployer stages can end up waiting for objects that do not exist yet.
2. **Capital proof and repair proof blur together.** Torghut proof floor correctly keeps capital closed, but Jangar
   needs a different decision for bounded repair convoy admission.
3. **Healthy rollout can be over-read.** Deployments and Argo apps are healthy, but that only proves serving. It does
   not prove routeability, quant ingestion, empirical authority, market context, or alpha readiness.
4. **Least-privilege proof has to be first-class.** Runtime workers cannot exec into Postgres or ClickHouse. The typed
   route receipts are not a fallback; they are the audit path.

For the next six months, Jangar should become the convergence arbiter for capital receipts and the budget owner for
repair convoys. It should not guess trading value, and it should not open capital. It should prove that every material
action depends on receipts that actually exist.

## Alternatives Considered

### Option A: Implement The Full Stage-Debt And Brownout Market Vocabulary First

Build `stage_debt_clearinghouse`, `repair_outcome_brownout_market`, and every companion Torghut ledger before changing
admission behavior.

Pros:

- Matches the latest accepted docs directly.
- Provides rich long-term vocabulary.
- Avoids a bridging contract.

Cons:

- Slowest route to deployer-usable gates.
- Requires several unimplemented reducers before the first actionable convergence result.
- Risks another design layer getting ahead of status reality.

Decision: reject as the immediate architecture. Keep the vocabulary as future extensions, but first build the receipt
spine that can carry it.

### Option B: Clear The Current Empirical Block As A One-Off

Refresh empirical jobs, repair quant ingestion, and let existing Jangar dependency quorum clear when data becomes
fresh.

Pros:

- Directly targets the current `empirical_jobs_degraded` blocker.
- Minimal Jangar source change.
- Easy to validate in one trading window.

Cons:

- Does not address missing status contracts.
- Does not bound repair work during future rollout or verify debt.
- Does not turn live routeability, sim quant emptiness, options timestamp weakness, or alpha readiness into one
  deployer-readable receipt set.

Decision: keep as a convoy cargo item, not the architecture.

### Option C: Capital Receipt Convergence With Repair Convoy Admission

Jangar materializes a `CapitalReceiptEpoch` from existing receipts and admits only bounded `RepairConvoy` work that can
name the exact gap it will reduce.

Pros:

- Uses source/status surfaces that exist now.
- Reduces failure amplification by separating serving health, repair admission, paper rehearsal, and live capital.
- Makes missing future ledgers explicit `missing_receipt` reasons instead of hidden assumptions.
- Fits least-privilege operation because route receipts are the canonical evidence.
- Gives engineer and deployer stages finite validation gates.

Cons:

- Adds a bridging read model.
- Requires careful compatibility with existing dependency quorum and material-action verdicts.
- Will keep paper and live capital closed even if one repair looks promising.

Decision: select Option C.

## Architecture

### CapitalReceiptEpoch

Jangar publishes one epoch per namespace, Torghut service revision, account, and proof window:

```text
capital_receipt_epoch
  schema_version
  epoch_id
  namespace
  account_label
  trading_mode
  torghut_revision
  torghut_image_digest
  jangar_revision
  generated_at
  fresh_until
  receipt_inputs
  receipt_state
  action_decisions
  missing_receipts
  stale_receipts
  contradiction_receipts
  repair_convoy_admission
  capital_gate
  rollback_target
```

Initial receipt inputs:

- `jangar_control_plane_status`
- `jangar_dependency_quorum`
- `jangar_execution_trust`
- `jangar_material_action_verdict_epoch`
- `jangar_route_stability_escrow`
- `jangar_source_rollout_truth_exchange`
- `jangar_quant_health_unscoped`
- `jangar_quant_health_account_window`
- `torghut_db_check`
- `torghut_profitability_proof_floor`
- `torghut_route_reacquisition_book`
- `torghut_empirical_jobs`
- `torghut_profitability_runtime`
- `torghut_options_catalog_readyz`

Receipt states:

- `present_fresh`
- `present_stale`
- `present_degraded`
- `missing`
- `contradictory`
- `not_required`

Every missing accepted-but-unimplemented design object must be represented explicitly as `missing`, not silently
ignored, when a downstream gate references it.

### Action Decisions

The epoch emits decisions for:

- `serve`
- `observe`
- `discover`
- `zero_notional_repair`
- `paper_rehearsal`
- `paper_canary`
- `live_micro`
- `live_scale`

Rules:

- `serve` is blocked only by Jangar serving failure, database disconnection that affects the status route, or route
  timeouts above budget.
- `observe` can continue when Torghut capital receipts are degraded.
- `zero_notional_repair` can be allowed only through a repair convoy with finite budget and no notional authority.
- `paper_rehearsal` requires route, quant, market-context, alpha, empirical, TCA, and Jangar material-action receipts
  to be present and fresh for the same account/window.
- `paper_canary`, `live_micro`, and `live_scale` are blocked until lower action classes produce fresh receipts.
- `live_*` actions never brownout or degrade open. They are `allow` or `block`.

### RepairConvoyAdmission

A repair convoy is a bounded bundle of zero-notional work:

```text
repair_convoy
  convoy_id
  target_receipt_gap
  action_class
  account_label
  trading_mode
  before_refs
  required_after_refs
  max_parallelism
  max_runtime_seconds
  route_budget_ms
  max_notional
  admission_decision
  rollback_trigger
```

Initial convoy classes:

1. `empirical_authority_refresh`
   - Target: stale empirical jobs.
   - Admission: allowed only when Jangar execution trust is healthy and current rollout debt is below budget.
   - After receipt: fresh empirical jobs with the same candidate and dataset refs as Torghut proof floor.

2. `live_quant_ingestion_repair`
   - Target: live account ingestion lag and materialization failure.
   - Admission: no notional, scoped to account/window, and route budget below threshold.
   - After receipt: live account/window quant stages fresh, with ingestion and materialization OK.

3. `simulation_quant_refill`
   - Target: `TORGHUT_SIM/15m` empty latest store.
   - Admission: no paper notional and no capital inference from the one NVDA probing path.
   - After receipt: nonempty sim latest metrics and required stages present.

4. `route_reacquisition_probe`
   - Target: zero live routeable symbols and seven sim missing symbols.
   - Admission: max notional zero; execution path must be replay, shadow, or synthetic.
   - After receipt: route-reacquisition book updates with before/after symbol states.

5. `market_context_receipt_refresh`
   - Target: stale market context.
   - Admission: allowed only if refresh jobs are not already failing within the current rollout window.
   - After receipt: market context domain states and freshness timestamps present.

6. `options_success_timestamp_repair`
   - Target: options catalog `ready=true` with `last_success_ts=null`.
   - Admission: only for hypotheses declaring options proof in scope.
   - After receipt: non-null success timestamp or explicit out-of-scope receipt.

## Engineer Implementation Scope

Jangar engineer stage should:

1. Add a pure `capital-receipt-epoch` reducer under `services/jangar/src/server/`.
2. Feed it from existing status inputs first; do not require direct DB exec or new cluster privileges.
3. Add `capital_receipt_epoch` and `repair_convoy_admission` to the control-plane status response in shadow mode.
4. Represent missing future objects, including `stage_debt_clearinghouse` and `repair_outcome_brownout_market`, as
   explicit missing receipts when referenced by a gate.
5. Add a small adapter for Torghut typed route receipts with timeouts and finite response-size guards.
6. Wire repair convoy admission into schedule launch policy only after shadow parity.
7. Keep `live_micro` and `live_scale` blocked unless every required receipt is present and fresh.

Do not:

- add database or Kubernetes mutation from the status reducer;
- infer profitability from aggregate quant health;
- route around Torghut proof floor;
- grant paper or live notional from a repair convoy;
- increase `supporting-primitives-controller.ts` with embedded trading policy.

## Validation Gates

Required unit tests:

- healthy Jangar plus Torghut `empirical_jobs_degraded` yields `serve=allow`, `observe=allow`,
  `zero_notional_repair=allow_with_convoy`, and all capital actions `block`;
- missing `stage_debt_clearinghouse` and `repair_outcome_brownout_market` become finite missing-receipt reasons;
- live account quant ingestion lag blocks paper rehearsal even when latest metrics are nonempty;
- simulation empty quant latest store blocks paper rehearsal even with `NVDA` probing;
- `simple_submit_disabled` blocks live actions regardless of other receipts;
- routeability zero blocks paper and live actions;
- direct database exec failure is not fatal when typed route receipts are available.

Required local checks:

- `bun run --filter @proompteng/jangar test -- src/server/__tests__/control-plane-status.test.ts`
- `bun run --filter @proompteng/jangar test -- src/server/__tests__/control-plane-material-action-verdict.test.ts`
- a new focused test file for capital receipt epochs and repair convoy admission;
- `bun run --filter @proompteng/jangar tsc`
- `bun run --filter @proompteng/jangar lint`

Required deployed validation:

- `curl -fsS 'http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status?namespace=agents' | jq '.capital_receipt_epoch'`
- `curl -fsS 'http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status?namespace=agents' | jq '.repair_convoy_admission'`
- `curl -fsS 'http://torghut.torghut.svc.cluster.local/trading/health' | jq '.proof_floor'`
- `curl -fsS 'http://torghut-sim.torghut.svc.cluster.local/trading/health' | jq '.proof_floor'`

Acceptance gate: deployer can reject paper or live capital with one epoch id, one receipt gap, and one convoy state
without reading raw route payloads.

## Rollout

1. Ship the reducer in shadow/status-only mode.
2. Log epoch id, missing receipt ids, stale receipt ids, and action decisions in Jangar status and NATS progress.
3. Compare epoch decisions against current dependency quorum and material-action verdicts for at least one full market
   session.
4. Enable convoy admission for `zero_notional_repair` only.
5. Keep paper and live action enforcement read-only until Torghut emits executable profit receipts.
6. Promote paper rehearsal admission only after two consecutive sessions where the epoch agrees with Torghut proof
   floor and no required receipt is missing.

## Rollback

Rollback is operationally simple:

- disable status publication with `JANGAR_CAPITAL_RECEIPT_EPOCH_MODE=off`;
- ignore `repair_convoy_admission` in schedule policy;
- fall back to current dependency quorum and material-action verdict behavior;
- keep Torghut capital at zero notional;
- do not run manual capital work as a rollback substitute.

Rollback must be immediate if status-route latency exceeds the existing budget, route receipt fetches cause timeouts,
or convoy admission contradicts Torghut proof floor.

## Risks

- Receipt convergence can become another large object. Mitigation: start with existing receipts and make every field
  route-backed.
- Missing future ledgers may look like failure. Mitigation: classify them as `missing` only when a gate references
  them, and keep capital fail-closed.
- Repair convoys can hide broad work. Mitigation: require one target receipt gap, finite parallelism, finite runtime,
  and max notional zero.
- Route payloads can grow. Mitigation: store compact summaries and source refs in Jangar, not full Torghut responses.
- Teams may pressure paper from the sim NVDA probe. Mitigation: paper rehearsal requires sim quant, market context,
  alpha readiness, TCA, and Jangar receipts, not one symbol.

## Handoff

Engineer handoff: build the capital receipt epoch as the first convergence reducer. Use current proof-floor,
route-reacquisition, quant health, empirical, and Jangar status receipts. Treat accepted-but-missing future objects as
finite missing receipts. Keep all capital blocked.

Deployer handoff: after rollout, prove that Jangar can answer one status payload with `capital_receipt_epoch`, identify
live routeability zero, sim quant empty store, live ingestion lag, stale empirical jobs, stale market context, and
closed submit gate, then admit only zero-notional repair convoys. Paper and live remain closed until the epoch has no
missing, stale, or contradictory capital receipts.
