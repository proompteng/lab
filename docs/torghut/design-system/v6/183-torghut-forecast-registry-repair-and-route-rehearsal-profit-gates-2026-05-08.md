# 183. Torghut Forecast-Registry Repair And Route-Rehearsal Profit Gates (2026-05-08)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-08
Owner: Victor Chen, Jangar Engineering Architecture
Scope: Torghut profitability, forecast registry repair, route rehearsal, Jangar controller-witness consumption,
capital guardrails, validation, rollout, rollback, and measurable trading hypotheses.

Governing requirement:

- `docs/agents/designs/swarm-agentic-mission-architecture-2026-05-08.md`

Companion Jangar contract:

- `docs/agents/designs/179-jangar-controller-witness-reconciliation-and-failure-debt-retirement-2026-05-08.md`

Extends:

- `182-torghut-route-proven-profit-receipts-and-consumer-evidence-canary-2026-05-08.md`
- `181-torghut-quality-adjusted-profit-frontier-and-hypothesis-escrow-2026-05-08.md`
- `180-torghut-dependency-priced-capital-frontier-and-session-reentry-2026-05-08.md`

## Decision

I am selecting **forecast-registry repair and route-rehearsal profit gates** as Torghut's next profitability
architecture step.

The route boundary improved since the previous plan document. On 2026-05-08 around 08:27Z, both live Torghut and
Torghut sim returned HTTP 200 from `/trading/consumer-evidence`. Live emitted a fresh
`torghut-consumer-evidence:*` receipt with empirical jobs healthy, TCA pass, forecast registry degraded,
`simple_submit_disabled`, `hypothesis_not_promotion_eligible`, and `max_notional=0`. Sim also emitted a fresh
receipt, but its TCA state failed because the route universe was empty. Route parity is no longer the blocker. Profit
quality is.

The live service is doing the right safe thing: `/readyz` is `degraded`, live submission is not allowed, proof floor
is `repair_only`, and capital stays zero-notional. The problem is that the repair path is not yet a measurable profit
program. Forecast registry repair, alpha readiness, route rehearsal, and Jangar controller witness truth are separate
signals. Torghut needs to turn them into a single sequence of gates that can say which repair earns the next unit of
paper capital option value.

The selected design creates two explicit profit gates. The first gate repairs the forecast registry until at least one
eligible calibrated model is present for the active candidate and account. The second gate rehearses route evidence in
sim and paper with zero or bounded notional until execution TCA produces at least one routeable symbol under guardrail.
Both gates consume Jangar's controller-witness reconciliation before they can move from observe/repair into paper
capital. Torghut should not spend capital while Jangar says the control plane cannot prove its own ingestion witness.

The tradeoff is that Torghut will continue to look conservative after the receipt route is fixed. I accept that.
Profitability comes from closing the next scarce proof gap, not from promoting because a route finally returns 200.

## Business Metrics And Profit Hypotheses

This design contributes to Jangar's business metric by preventing Torghut repair/capital work from creating failed
AgentRuns or manual rollout ambiguity. It contributes to Torghut profitability by converting proof-floor blockers into
ranked, measurable repair hypotheses.

Mapped value gates:

- `failed_agentrun_rate`: route rehearsals are bounded and admitted only when Jangar controller witness state permits
  repair work.
- `pr_to_rollout_latency`: Torghut deployers can validate consumer evidence, forecast registry, and route rehearsal
  with explicit gates instead of broad manual inspection.
- `ready_status_truth`: live `/readyz=degraded` remains truthful while zero-notional repair continues.
- `manual_intervention_count`: repair order is computed from forecast and route gate state.
- `handoff_evidence_quality`: receipts name candidate, dataset, forecast state, route state, TCA state, Jangar witness
  state, notional limit, and rollback target.

Measurable trading hypotheses:

- H1, forecast registry repair: if the forecast registry is non-empty and calibrated for
  `chip-paper-microbar-composite@execution-proof`, alpha readiness can move at least one hypothesis from `shadow` or
  `blocked` to paper-eligible without increasing max notional above zero.
- H2, route rehearsal: if sim creates fresh route/TCA receipts for missing symbols, `routeable_symbol_count` should
  move from zero to at least one under the slippage guardrail before paper capital is considered.
- H3, controlled paper unlock: if Jangar controller witness reconciliation is current, forecast registry is eligible,
  and route rehearsal has at least one routeable symbol, Torghut may propose a paper probe with an explicit small
  notional ceiling and automatic rollback to zero.

## Evidence Snapshot

All evidence was collected read-only. I did not mutate Kubernetes resources, database records, trading flags, or
GitOps manifests.

### Runtime And Cluster Evidence

- Argo CD reported Torghut and Torghut options Synced/Healthy at
  `00b0bc2c6b6591ce061af3efce7f9976e52deb11`.
- Torghut live pod `torghut-00302-deployment-6ddbcf6f46-nqcfk` was running and ready on image digest
  `sha256:056d6b0bc237adec3e3aa5e89a3f08ee81523ec18d8374c4a4e7d072e436f0f3`.
- Torghut sim pod `torghut-sim-00400-deployment-7f44b8675c-542mr` was running and ready on the same Torghut digest.
- Torghut Postgres, ClickHouse, Keeper, TA, WebSocket, options catalog, and options enricher pods were running.
- Torghut events still showed ClickHouse multiple-PDB ambiguity and `torghut-keeper` PDB `NoPods`, which should stay
  operational debt but not capital proof.

### Data And Schema Evidence

- Direct CNPG and pod exec reads were forbidden for this service account, so the database assessment used Torghut
  app endpoints and Jangar bounded status surfaces.
- Torghut `/db-check` returned `ok=true`, `schema_current=true`, head
  `0029_whitepaper_embedding_dimension_4096`, lineage ready, account scope ready, and known migration parent-fork
  warnings.
- Jangar quant health global view returned `status=ok`, `latestMetricsCount=4284`,
  `latestMetricsUpdatedAt=2026-05-08T08:27:36.452Z`, and `metricsPipelineLagSeconds=3`.
- Jangar quant health for `account=TORGHUT_SIM&window=15m` returned `status=degraded`, zero latest metrics, zero
  stages, and `emptyLatestStoreAlarm=true`.
- Torghut live `/readyz` returned `status=degraded` because live submission was disabled and proof floor was
  `repair_only`.
- Torghut sim `/readyz` returned `status=ok`, but its proof floor stayed `repair_only` because execution TCA route
  universe was empty and alpha readiness had no promotion-eligible hypotheses.

### Profit Evidence

- Live consumer evidence receipt was current, with empirical jobs healthy and candidate
  `chip-paper-microbar-composite@execution-proof` on dataset `torghut-chip-full-day-20260505-4c330ce9-r1`.
- Live receipt reason codes were `forecast_registry_degraded`, `simple_submit_disabled`, and
  `hypothesis_not_promotion_eligible`.
- Live proof floor kept `capital_state=zero_notional`, `route_state=repair_only`, and `max_notional=0`.
- Live route reacquisition board had 8 rows, with 4 blocked symbols, 3 missing symbols, 1 probing symbol, zero
  capital-eligible symbols, and expected unblock value 14.
- Sim receipt reason codes were `forecast_registry_degraded`, `hypothesis_not_promotion_eligible`, and
  `execution_tca_route_universe_empty`.
- Sim route reacquisition book had one blocked NVDA route and seven missing symbols, all with paper probe notional
  limit `0`.
- Jangar status reported Torghut consumer evidence `current`, empirical jobs `healthy`, forecast `degraded` with
  `registry_empty`, and material capital actions held or blocked.

### Source Evidence

- `services/torghut/app/main.py` assembles `/readyz`, `/db-check`, `/trading/status`, and
  `/trading/consumer-evidence`; at 4,366 lines it should not absorb more scoring logic.
- `services/torghut/app/trading/consumer_evidence.py` already creates stable consumer evidence receipts.
- `services/torghut/app/trading/proof_floor.py`, `route_reacquisition_board.py`, `forecast_runtime.py`,
  `hypotheses.py`, and `submission_council.py` are the likely consumers for gate enforcement.
- `services/jangar/src/server/control-plane-torghut-consumer-evidence.ts` now has a live route to consume; the next
  gap is richer receipt semantics, not fallback routing.
- Torghut tests already cover proof floor, submission council, hypotheses, trading API, strategy runtime, and revenue
  repair digest. The missing tests are for forecast-registry gate state, route-rehearsal transition rules, and Jangar
  controller-witness dependency in paper unlock decisions.

## Problem

Torghut has a live evidence route but no route to profitable action.

The current failure modes are:

1. Forecast registry degradation blocks paper/live readiness, but the repair gate does not name the smallest eligible
   registry artifact needed for the active candidate.
2. Route reacquisition ranks repair candidates, but route rehearsal is not yet an explicit gate with required receipts.
3. Sim can be `/readyz=ok` while still unable to produce routeable capital candidates.
4. Live can be truthful and degraded, but the proof floor does not yet expose a stepwise paper unlock proposal.
5. Jangar controller witness split should hold capital authority, but Torghut receipts do not yet cite the Jangar
   reconciliation decision that made the hold.
6. `simple_submit_disabled` is a correct safety gate, but it is too coarse to guide forecast and route repair order.

## Alternatives Considered

### Option A: Enable Paper Once Consumer Evidence Route Is Current

Treat HTTP 200 from `/trading/consumer-evidence` as the main blocker and move to paper once the receipt route is live.

Advantages:

- Fastest path to apparent activity.
- Easy deployer check.
- Uses the new route-proven receipt work.

Disadvantages:

- Ignores forecast registry degradation.
- Ignores zero routeable capital candidates.
- Ignores Jangar controller witness split.

Decision: reject. Route liveness is a transport proof, not a profit proof.

### Option B: Block All Torghut Work Until Forecast, TCA, Alpha, And Jangar Are Fully Green

Hold all Torghut observe, repair, paper, and live actions until every dependency is green.

Advantages:

- Simple and safe.
- Prevents proof ambiguity.
- Easy to rollback.

Disadvantages:

- Blocks the zero-notional repair work needed to become green.
- Does not rank repairs by expected unblock value.
- Increases manual intervention because every blocker looks equally terminal.

Decision: keep for live capital, reject for observe and repair.

### Option C: Forecast-Registry Repair And Route-Rehearsal Profit Gates

Create two explicit gates: forecast registry repair and route rehearsal. Both can run in observe/repair mode under
zero notional, and both must cite Jangar controller-witness reconciliation before proposing paper unlock.

Advantages:

- Preserves zero-notional safety.
- Converts proof-floor blockers into measurable repair work.
- Gives Jangar a clear consumer contract for capital holds.
- Ranks route repair by expected unblock value.

Disadvantages:

- Adds another gate object and tests.
- Requires calibration thresholds for forecast eligibility.
- May defer paper opportunities until route rehearsal catches up.

Decision: select Option C.

## Architecture

Torghut adds a pure `profit_repair_gate_set` generated beside the existing consumer evidence receipt.

```text
profit_repair_gate_set
  schema_version
  gate_set_id
  generated_at
  fresh_until
  account_label
  candidate_id
  dataset_snapshot_ref
  jangar_controller_witness_ref
  current_capital_state
  max_notional
  gates[]
  next_safe_action
  rollback_target
```

Each gate is explicit:

```text
profit_repair_gate
  gate_id
  gate_class                    # forecast_registry | route_rehearsal | alpha_readiness | submit_enablement
  state                         # pass | repair | hold | block
  current_evidence_ref
  required_receipts
  expected_unblock_value
  capital_effect                # none | zero_notional_repair | paper_probe_candidate | live_hold
  notional_limit
  reason_codes
  next_repair_action
  rollback_target
```

The receipt remains conservative:

- `max_notional=0` until forecast registry, route rehearsal, alpha readiness, Jangar witness, and submit enablement
  all clear the paper gate.
- Live remains blocked until paper settlement closes and live-specific guardrails pass.
- Forecast registry repair and route rehearsal can continue in zero-notional mode under Jangar bounded repair
  admission.

## Implementation Scope

Engineer stage:

1. Add a pure `services/torghut/app/trading/profit_repair_gates.py` module.
2. Build gate state from forecast runtime status, route reacquisition board/book, proof floor, alpha readiness,
   consumer evidence, and optional Jangar controller-witness reconciliation.
3. Include `profit_repair_gate_set` in `/trading/consumer-evidence` and `/trading/status`.
4. Keep live and paper notional at zero while gate state is `repair`, `hold`, or `block`.
5. Add tests for forecast registry empty, route universe empty, Jangar witness missing, sim route rehearsal, and paper
   unlock proposal.
6. Do not enable live submission in this milestone.

Deployer stage:

1. Verify `/trading/consumer-evidence` returns HTTP 200 for live and sim.
2. Verify the gate set appears and names forecast registry and route rehearsal blockers.
3. Verify `/readyz` remains degraded for live while live submission is disabled.
4. Verify sim remains `ok` but capital remains zero-notional when route rehearsal is incomplete.
5. Verify Jangar status consumes the receipt and keeps capital held until controller-witness reconciliation is current.

## Validation Gates

Local tests:

- `uv run --frozen pytest services/torghut/tests/test_profit_repair_gates.py`
- `uv run --frozen pytest services/torghut/tests/test_trading_api.py -k consumer_evidence`
- `bunx oxfmt --check docs/torghut/design-system/v6/183-torghut-forecast-registry-repair-and-route-rehearsal-profit-gates-2026-05-08.md`

CI gates:

- Torghut Pyright profiles pass.
- Torghut pytest and coverage pass.
- Semantic PR title and commit messages pass.

Runtime gates after merge:

- Argo `torghut` and `torghut-options` are Synced/Healthy at the merge revision.
- Live and sim consumer evidence routes return HTTP 200.
- `profit_repair_gate_set` is present and fresh.
- Forecast registry gate is not `pass` while registry is empty.
- Route rehearsal gate is not `pass` while routeable symbol count is zero.
- Paper/live notional remains zero until Jangar controller witness reconciliation is current and Torghut proof gates
  pass.

## Rollout

Phase 0, design: merge this document and companion Jangar contract.

Phase 1, shadow gate set: emit `profit_repair_gate_set` without changing proof-floor decisions.

Phase 2, paper proposal: allow the gate set to propose a paper probe only when all gates pass, but keep submission
disabled until deployer validation accepts the proposal.

Phase 3, bounded paper canary: enable a small paper probe only through GitOps and only after Jangar controller witness
reconciliation, forecast registry, route rehearsal, and alpha readiness are current.

## Rollback

- Remove the gate set from receipt consumers and continue using existing proof-floor decisions.
- Keep `max_notional=0` and `simple_submit_disabled` if any gate state is disputed.
- Revert the Torghut implementation PR if `/readyz`, `/trading/status`, or `/trading/consumer-evidence` latency or
  schema compatibility regresses.
- Do not mutate trade, execution, or hypothesis records as rollback.

## Risks

- Forecast eligibility thresholds may be too strict and starve paper probes. Mitigation: start shadow-only and report
  expected unblock value before enforcing.
- Route rehearsal could spend runner capacity without improving routeability. Mitigation: require Jangar bounded repair
  admission and stop rehearsal when expected unblock value does not improve over a configured window.
- Jangar witness dependency could keep Torghut conservative during a Jangar-only issue. Mitigation: observe and
  zero-notional repair remain allowed; paper/live capital stay held.
- Adding gate data to status payloads could make responses larger. Mitigation: keep raw route rows in the existing
  route book and publish only summaries in the gate set.

## Handoff

Engineer next milestone: implement the shadow `profit_repair_gate_set` in Torghut and include it in consumer evidence
with focused tests. This maps to `failed_agentrun_rate`, `ready_status_truth`, and `handoff_evidence_quality`.

Deployer next milestone: after the implementation PR merges, prove live/sim consumer evidence routes, gate presence,
zero-notional safety, Argo health, and Jangar receipt consumption. This maps to `pr_to_rollout_latency`,
`manual_intervention_count`, and `ready_status_truth`.
