# 157. Torghut Profit Contract Actuation And Capital Surface Truth (2026-05-07)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-07
Owner: Victor Chen, Jangar Engineering
Scope: Torghut profitability, capital-surface truth, design contract actuation, repair receipt convergence,
validation, rollout, rollback, and implementation handoff.

Companion Jangar contract:

- `docs/agents/designs/153-jangar-design-actuation-ledger-and-contract-convergence-gates-2026-05-07.md`

Extends:

- `156-torghut-repair-closure-yield-ledger-and-capital-unlock-receipts-2026-05-07.md`
- `155-torghut-capital-repair-outcome-ledger-and-edge-reacquisition-gates-2026-05-07.md`
- `154-torghut-marginal-proof-spend-portfolio-and-capital-repair-budget-2026-05-07.md`

## Decision

I am selecting a profit contract actuation ledger and capital-surface truth gate for Torghut.

Torghut is economically blocked for the right reasons. Live `/readyz` returned `503`, proof floor is `repair_only`,
capital is `zero_notional`, alpha readiness has no promotion-eligible hypotheses, execution TCA is above the
guardrail, market context is stale, and live submission is disabled. The service is not down. It is refusing capital.

The risk is subtler: recent profitability contracts now describe repair closure yield, capital unlock receipts, and
Jangar material verdict authority, but the live Torghut status payload does not publish `repair_closure_yield_ledger`
or `capital_unlock_receipts`, and Jangar does not yet publish `material_verdict_authority`. Torghut should not wait on
imaginary receipts, and it should not let a planned receipt become a capital exception.

The selected design makes capital-surface truth explicit. Torghut will publish a `profit_contract_actuation` ledger
that distinguishes implemented proof-floor surfaces from design-only profit contracts. Capital gates may cite only
`live` receipts. Planned receipts can guide repair priority, but they cannot authorize paper or live notional.

The tradeoff is that Torghut will stay zero-notional even when a document says the next unlock receipt exists. I accept
that. Profitability comes from measured edge and capital discipline, not from treating future contracts as present
evidence.

## Runtime Objective And Success Metrics

Success means:

- Torghut publishes `profit_contract_actuation` from `/readyz`, `/trading/health`, and `/trading/status`.
- Each capital-relevant contract is classified as `design_only`, `shadow`, `live`, `blocked`, `superseded`, or
  `retired`.
- `profitability_proof_floor` starts as `live` because it is present in ready/status payloads and has tests.
- `repair_closure_yield_ledger`, `capital_unlock_receipts`, and `capital_repair_outcomes` start as `design_only`
  until implemented.
- Live and paper capital decisions cannot cite a design-only receipt.
- The proof floor emits `capital_contract_not_actuated` when a requested paper/live gate depends on a non-live
  contract.
- Observation and zero-notional repair remain available when dependencies are healthy enough to measure.
- Jangar consumes Torghut contract actuation state before allowing `paper_canary`, `live_micro_canary`, or
  `live_scale`.

## Evidence Snapshot

All evidence was collected read-only on 2026-05-07. I did not mutate Kubernetes resources, database records,
ClickHouse tables, broker state, AgentRun objects, GitOps resources, or trading flags.

### Runtime And Cluster Evidence

- Torghut live active deployment was `torghut-00268-deployment=1/1`.
- Torghut simulation active deployment was `torghut-sim-00368-deployment=1/1`.
- Both active deployments used image digest
  `sha256:9c5c85848ba0b46253f374f7f670fd5d201c043e33a2bc7d85149efc1db3f4b0`.
- Torghut Postgres, ClickHouse, Keeper, TA, TA simulation, options TA, guardrail exporters, WebSocket services,
  options catalog, options enricher, Symphony, and Alloy pods were running.
- A retained `torghut-whitepaper-autoresearch-profit-target-8r6w6` pod was in `Error`.
- Recent Torghut events showed DB migration and options rollout activity, transient readiness failures for options
  catalog/enricher, duplicate ClickHouse PodDisruptionBudget warnings, and Flink status-modified-externally warnings.

### Data And Capital Evidence

- Live `/readyz` returned HTTP `503` with `status=degraded`.
- Live dependencies were healthy for Postgres, ClickHouse, Alpaca live account `PA3SX7FYNUTF`, Jangar universe,
  empirical jobs, and database schema.
- Live database schema was current at Alembic head `0029_whitepaper_embedding_dimension_4096`.
- Schema lineage had one branch, no duplicate revisions, no orphan parents, and known parent-fork warnings at
  `0010_execution_provenance_and_governance_trace` and `0015_whitepaper_workflow_tables`.
- Live proof floor was `repair_only`, route state `repair_only`, capital state `zero_notional`, and `max_notional=0`.
- Live blockers were `hypothesis_not_promotion_eligible`, `execution_tca_slippage_guardrail_exceeded`,
  `market_context_stale`, and `simple_submit_disabled`.
- Live alpha readiness had three shadow hypotheses, zero promotion-eligible hypotheses, and three rollback-required
  hypotheses.
- Live TCA had 7334 orders, 7245 filled executions, average absolute slippage `13.8203637593029676` bps, and guardrail
  `8` bps.
- Live symbol routes had zero routeable symbols, five blocked symbols, and three missing symbols.
- Live quant evidence was informational but degraded: compute was fresh, ingestion lag was `78254` seconds, and
  materialization lag was 23 seconds.
- Simulation `/readyz` returned HTTP `200` in paper mode, but simulation proof floor remained `repair_only` and
  `zero_notional`; market context and alpha readiness still blocked paper capital.
- Direct CNPG SQL was RBAC-blocked for `torghut-db-1`, so typed runtime endpoints are the available database witness.

### Source Evidence

- `services/torghut/app/main.py` is 4186 lines and should not absorb more capital-contract state.
- `services/torghut/app/trading/proof_floor.py` is 653 lines and already emits proof dimensions, blockers, repair
  ladder entries, and capital state.
- `services/torghut/app/trading/revenue_repair.py` is 616 lines and can summarize repair direction, but it does not
  issue capital unlock receipts.
- `services/torghut/app/trading/tca.py` is 969 lines and owns execution TCA metrics.
- `services/torghut/app/trading/submission_council.py` is 1199 lines and remains the final deterministic order gate.
- `services/torghut/app/trading/scheduler/pipeline.py` is 4349 lines and should consume contract-actuation decisions,
  not become the contract registry.
- Existing tests cover proof floor, TCA, submission council, trading API readiness, empirical jobs, and quant
  readiness. The missing tests prove that a capital gate cannot use a design-only receipt.

## Problem

Torghut now has a profitability contract stack with more concepts than implemented surfaces. That is not inherently
bad. It is a normal architecture-to-implementation sequence. It becomes dangerous when capital gates cannot tell the
difference between a planned receipt and a live receipt.

The current failure modes are:

1. Paper or live capital can be discussed as if `CapitalUnlockReceipt` exists while the endpoint has no such field.
2. A repair can be treated as economically settled before `CapitalRepairOutcome` or closure-yield records exist.
3. Jangar can be asked to consume `material_verdict_authority` before Jangar publishes it.
4. Proof-floor blockers can stay clear in one dimension while a missing contract should still block capital.
5. The scheduler can run repair work without an explicit answer to whether the repair depends on design-only
   evidence.

## Alternatives Considered

### Option A: Let Proof Floor Stay The Only Capital Surface

Pros:

- It already exists and is tested.
- It keeps Torghut conservative.
- It avoids adding another status block.

Cons:

- It cannot distinguish missing planned receipts from passed capital conditions.
- It forces deployers to read design docs to learn what is implemented.
- It does not help Jangar understand which Torghut receipts are real.

Decision: reject as incomplete.

### Option B: Implement Closure Yield And Capital Unlock First

Pros:

- Directly attacks the capital reentry path.
- Produces the receipt the previous contract wants.
- May accelerate useful paper learning.

Cons:

- It is broad and touches proof floor, repair, TCA, submission, and scheduler paths.
- It can still drift unless Torghut also tracks contract actuation state.
- It is risky while Jangar watch reliability is degraded and Jangar material authority is not live.

Decision: reject as the first move. It remains the next implementation lane after actuation.

### Option C: Add Profit Contract Actuation And Capital-Surface Truth

Pros:

- Makes live versus planned capital evidence explicit.
- Keeps zero-notional safety intact.
- Lets repair work continue in observation mode.
- Gives Jangar one stable Torghut input for contract state.

Cons:

- Adds one reducer and schema surface.
- Will keep capital closed until receipts are implemented and measured.
- Requires CI fixtures so it does not become another static list.

Decision: select Option C.

## Architecture

Add a `profit_contract_actuation` reducer under `services/torghut/app/trading/`. It consumes current ready/status
payloads, source-owned contract registry entries, Jangar `contract_actuation_ledger` when available, and proof-floor
state.

`ProfitContractActuationRecord` fields:

- `contract_id`
- `document_ref`
- `companion_ref`
- `capital_surface`: `observe`, `repair`, `paper`, `live_micro`, or `live_scale`
- `implementation_state`: `design_only`, `shadow`, `live`, `blocked`, `superseded`, or `retired`
- `source_modules`
- `status_fields`
- `test_refs`
- `jangar_contract_refs`
- `capital_blocking_reason`
- `fresh_until`
- `promotion_requirements`
- `rollback_target`

Initial classifications:

- `profitability_proof_floor`: `live`.
- `execution_tca`: `live` for measurement, not for capital allow when guardrail fails.
- `submission_council`: `live` for deterministic submission gating.
- `revenue_repair_digest`: `shadow`, because it summarizes repair posture but does not settle capital.
- `capital_repair_outcomes`: `design_only`.
- `repair_closure_yield_ledger`: `design_only`.
- `capital_unlock_receipts`: `design_only`.
- Jangar `material_verdict_authority`: `design_only` until Jangar publishes it.

Capital-surface truth rules:

- A paper or live gate may depend on a contract only when state is `live`.
- A `shadow` contract may annotate a proof-floor repair ladder but cannot raise notional above zero.
- A `design_only` contract adds `capital_contract_not_actuated` to the blocker list when it is required for the
  requested capital surface.
- Live submit stays disabled until proof floor, submission council, Jangar material authority, and required Torghut
  capital receipts are live and passing.
- Simulation can remain HTTP `200` while still reporting zero-notional if the missing contract applies only to capital.

## Measurable Trading Hypotheses

Hypothesis 1: If repair work is ranked only by proof-floor blocker priority, then at least one repair class will
produce fresh evidence without improving routeable symbols or post-cost edge. Guardrail: no paper widening until a
live outcome contract shows blocker closure and positive post-cost edge.

Hypothesis 2: If execution TCA remains above 8 bps for the active live account, then capital unlock remains negative
even when market context and alpha readiness improve. Guardrail: `execution_tca_slippage_guardrail_exceeded` blocks
paper/live capital unless a live contract scopes the canary to routeable symbols with passing TCA.

Hypothesis 3: If Jangar dependency quorum is blocked by watch reliability, then Torghut alpha readiness should remain
shadow-only even if empirical jobs are healthy. Guardrail: Jangar contract actuation must be live or explicitly
shadow-observe before alpha promotion feeds paper capital.

## Validation Gates

Engineer validation:

- Add `services/torghut/app/trading/profit_contract_actuation.py`.
- Add tests proving `capital_unlock_receipts` starts as `design_only` when status fields are absent.
- Add tests proving proof floor adds `capital_contract_not_actuated` when a requested paper/live surface cites a
  design-only contract.
- Add tests proving observe-only and zero-notional repair remain available.
- Add a fixture where Jangar contract actuation is absent and prove Torghut fails closed for capital but not for
  observation.

Deployer validation:

- Before paper or live widening, query Torghut `/readyz` and `/trading/status`.
- Require `profit_contract_actuation` to mark all cited capital contracts `live`.
- Require proof floor not `repair_only`, TCA below guardrail for the scoped route, market context fresh, alpha
  readiness promotable, and live submission policy explicitly enabled.
- If any of those fail, keep `capital_state=zero_notional` and allow only observe or repair work.

## Rollout

Phase 0 adds the reducer and status field with existing contracts classified conservatively.

Phase 1 wires proof floor to include `capital_contract_not_actuated` for paper/live surfaces that cite design-only
contracts.

Phase 2 lets Jangar consume Torghut `profit_contract_actuation` in shadow mode.

Phase 3 implements `capital_repair_outcomes` or `repair_closure_yield_ledger` as the first contract to move from
`design_only` to `shadow`.

Phase 4 allows paper canary only after the required Torghut and Jangar contracts are live and the proof-floor blockers
are closed for the scoped hypothesis window.

## Rollback

If `profit_contract_actuation` fails, omit the field and keep existing proof-floor zero-notional behavior.

If the reducer incorrectly blocks simulation readiness, scope its blocker to capital surfaces only and leave simulation
HTTP readiness based on service health.

If a contract is incorrectly marked live, downgrade it to `shadow`, add `capital_contract_not_actuated`, and return to
proof-floor repair-only behavior.

## Risks

- The reducer can become a static checklist unless tests prove it reads actual status fields.
- Capital can remain closed longer while receipts are implemented.
- A contract may be live for observation but not for capital; the state model must make that explicit through
  `capital_surface`.
- Jangar and Torghut ledgers can disagree during rollout. Torghut must fail closed for capital on disagreement.

## Handoff To Engineer

Implement Torghut after the Jangar contract ledger exists or in parallel behind a local fixture. The smallest slice is:

1. Add `profit_contract_actuation.py` with pure classification over current status data.
2. Publish `profit_contract_actuation` from `/readyz`, `/trading/health`, and `/trading/status`.
3. Mark proof floor, TCA, and submission council live for their existing scopes.
4. Mark repair closure yield, capital unlock receipts, and capital repair outcomes design-only.
5. Add tests that design-only capital contracts cannot authorize paper or live notional.

## Handoff To Deployer

Treat `profit_contract_actuation` as a capital preflight. If it is absent, unknown, or marks a cited capital contract
anything other than `live`, keep Torghut at zero notional. Observation and repair-only work can continue when service
health is acceptable and the action remains zero-notional. Do not widen paper or live based on the design document
alone.
