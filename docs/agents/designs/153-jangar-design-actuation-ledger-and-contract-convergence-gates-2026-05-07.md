# 153. Jangar Design Actuation Ledger And Contract Convergence Gates (2026-05-07)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-07
Owner: Victor Chen, Jangar Engineering
Scope: Jangar control-plane resilience, architecture contract actuation, status-schema convergence, rollout gating,
Torghut capital-surface truth, validation, rollback, and implementation handoff.

Companion Torghut contract:

- `docs/torghut/design-system/v6/157-torghut-profit-contract-actuation-and-capital-surface-truth-2026-05-07.md`

Extends:

- `152-jangar-material-verdict-authority-and-contradiction-debt-ledger-2026-05-07.md`
- `151-jangar-repair-outcome-settlement-and-schedule-debt-roi-exchange-2026-05-07.md`
- `150-jangar-controller-brownout-budgets-and-proof-spend-admission-exchange-2026-05-07.md`

## Decision

I am selecting a design actuation ledger with contract convergence gates as the next Jangar architecture step.

The evidence says the system is no longer missing ideas. It is missing a reliable distinction between accepted design
authority and live operational authority. Jangar is serving on the new `061ec2b2` rollout, the route is healthy, the
database probe is healthy, and the Agents deployments are available. At the same time, watch reliability is degraded,
controller witness holds material dispatch, and the latest accepted contracts are ahead of the implemented status
surface. The public status payload does not yet publish `controller_brownout_budget`, `repair_outcome_settlement`, or
`material_verdict_authority`, even though those contracts are now referenced as current handoff direction.

That gap is now a control-plane failure mode. Operators and downstream stages can cite a merged document and believe
an authority exists, while the only live API still exposes older receipts. The next layer must make contract actuation
itself a typed control-plane object. Every accepted architecture contract must carry a state: `design_only`, `shadow`,
`live`, `blocked`, `superseded`, or `retired`. Deployer and engineer stages can read the design, but they cannot use a
contract to authorize dispatch, rollout widening, merge readiness, or Torghut capital until the actuation ledger proves
source ownership, a status field, schema tests, and a consumer gate.

The tradeoff is that some current reading lists will become visibly less flattering. I accept that. A control plane
that names unimplemented authority as accepted creates false confidence. A control plane that names implementation
state plainly gives engineers and deployers a safer sequence.

## Runtime Objective And Success Metrics

Success means:

- Jangar publishes `contract_actuation_ledger` from `/api/agents/control-plane/status`.
- Each current design contract has one `ContractActuationRecord` with source module, status field, schema fixture,
  owner lane, current state, and expiry.
- `design_only` and `blocked` contracts cannot authorize material actions.
- `shadow` contracts can emit evidence and UI panels but cannot override live gates.
- `live` contracts require a non-null status field, a schema test, a route/API fixture, and a deployer consumption
  check.
- Existing fields such as `source_rollout_truth_exchange`, `material_action_verdict_epoch`, and
  `control_plane_controller_witness` remain valid because their source modules and tests exist.
- Missing promised fields such as `controller_brownout_budget`, `repair_outcome_settlement`, and
  `material_verdict_authority` are marked `design_only` or `blocked` until implemented.
- `/ready` stays about serving health. It may summarize contract actuation debt, but it must not fail
  `serve_readonly` solely because a new contract is still design-only.
- Engineer handoff lists the smallest implementation slice that can move one contract from `design_only` to `shadow`.
- Deployer handoff uses the ledger to reject any rollout or capital action that cites a non-live contract as
  authority.

## Evidence Snapshot

All evidence was collected read-only on 2026-05-07. I did not mutate Kubernetes resources, database records,
ClickHouse tables, broker state, AgentRun objects, GitOps resources, or trading flags.

### Cluster And Rollout Evidence

- `kubectl config current-context` was initially unset, so I bootstrapped the local in-cluster context from the service
  account token and CA as required by the repo guidance.
- The active identity was `system:serviceaccount:agents:agents-sa`.
- `jangar` deployments were available: `jangar=1/1`, `bumba=1/1`, `symphony=1/1`, `symphony-jangar=1/1`, and
  `jangar-alloy=1/1`.
- The active Jangar pod was `jangar-75cc8d8dc5-cjq66`, `2/2 Running`, with zero restarts and age about nine minutes
  at the evidence pass.
- `agents` deployments were available: `agents=1/1`, `agents-controllers=2/2`, and `agents-alloy=1/1`.
- The new Agents rollout used `registry.ide-newton.ts.net/lab/jangar-control-plane:061ec2b2` and
  `registry.ide-newton.ts.net/lab/jangar:061ec2b2`.
- Recent `agents` events showed the old `agents` and `agents-controllers` pods timing out during readiness, a
  controller liveness failure, and one controller pod restart during the rollout.
- The current plan cron had two fresh `Error` pods before a completed wrapper, and the current plan step pod was
  running.
- `torghut` live and simulation active deployments were available as `torghut-00268-deployment=1/1` and
  `torghut-sim-00368-deployment=1/1` on digest
  `sha256:9c5c85848ba0b46253f374f7f670fd5d201c043e33a2bc7d85149efc1db3f4b0`.
- Torghut events still included startup readiness failures for options services, duplicate ClickHouse
  PodDisruptionBudget warnings, and Flink status-modified-externally warnings.

### Jangar Status And Data Evidence

- `GET http://jangar.jangar.svc.cluster.local/ready` returned `status=ok`.
- Jangar leader election was active and healthy; the ready response identified `jangar-75cc8d8dc5-cjq66` as leader.
- `GET /api/agents/control-plane/status?namespace=agents` generated at `2026-05-07T15:28:28.187Z`.
- Database status was healthy: configured, connected, `latency_ms=1`, `registered_count=28`, `applied_count=28`,
  `unapplied_count=0`, and latest migration `20260505_torghut_quant_pipeline_health_window_index`.
- Rollout health was healthy for two Agents deployments.
- Execution trust was healthy with no blocking windows.
- Watch reliability was degraded over a 15 minute window: five streams, 850 events, eight errors, and 16 restarts.
- Controller witness was `hold_material` with `watch_epoch_not_current` and `controller_ingestion_unknown`.
- Source rollout truth was in shadow mode and held material classes because source/GitOps revision was missing,
  watch cache was unhealthy, and controller heartbeat was not current.
- `controller_brownout_budget`, `repair_outcome_settlement`, and `material_verdict_authority` were absent/null in the
  live status response.
- Direct CNPG SQL was RBAC-blocked for both `jangar-db-1` and `torghut-db-1`: the service account cannot create
  `pods/exec` in those namespaces. The typed application status endpoints are therefore the available data witnesses
  for this lane.

### Source Evidence

- `services/jangar/src/server/control-plane-status.ts` is 787 lines and currently assembles live status fields.
- The implemented Jangar authority modules include `control-plane-source-rollout-truth-exchange.ts` at 632 lines,
  `control-plane-material-action-verdict.ts` at 528 lines, `control-plane-negative-evidence-router.ts` at 610 lines,
  and `control-plane-controller-witness.ts`.
- `supporting-primitives-controller.ts` is 3301 lines and still owns a large share of schedule, dispatch, PVC, and
  watch behavior.
- `rg` found `design_artifact` constants in implemented Jangar modules, which is the right pattern for contract
  provenance.
- `rg` found the promised `controller_brownout_budget`, `repair_outcome_settlement`, and
  `material_verdict_authority` fields only in accepted docs, not in live source modules.
- Existing tests cover status, watch reliability, source rollout truth, material verdicts, negative evidence,
  controller witness, and route stability. The missing test surface is contract actuation: prove that a current design
  contract is not treated as live until source, schema, status, and consumer evidence exist.

### Torghut Consumer Evidence

- Live Torghut `/readyz` returned HTTP `503` with `status=degraded`.
- Live dependencies were healthy for Postgres, ClickHouse, Alpaca, Jangar universe, empirical jobs, and database
  schema.
- Live proof floor was `repair_only`, route state `repair_only`, capital state `zero_notional`, and `max_notional=0`.
- Live blockers were `hypothesis_not_promotion_eligible`, `execution_tca_slippage_guardrail_exceeded`,
  `market_context_stale`, and `simple_submit_disabled`.
- Execution TCA had 7334 orders, 7245 filled executions, average absolute slippage `13.8203637593029676` bps, and
  guardrail `8` bps. Five symbols were blocked and three were missing.
- Quant ingestion had fresh compute metrics but a failed ingestion stage with `max_stage_lag_seconds=78254`.
- Simulation `/readyz` returned HTTP `200`, but simulation proof floor still reported `repair_only` and
  `zero_notional`.

## Problem

Jangar now has a design-to-runtime convergence problem. The repository contains many accepted contracts, and several
of them are good. The live API implements only some of them. That is expected during staged delivery, but it becomes
unsafe when the docs are promoted as current authority without an explicit actuation state.

The current failure modes are:

1. A deployer can cite an accepted document and assume a field exists when it is null in the live status payload.
2. An engineer can implement a later contract before the earlier dependency contract exists.
3. A dashboard can mix `design_artifact` references from implemented modules with accepted-but-not-implemented docs.
4. Torghut can wait for a Jangar receipt, while Jangar has only a design for that receipt.
5. CI can merge architecture docs without proving they have a planned source module, status schema, and validation
   gate.

## Alternatives Considered

### Option A: Keep The Docs-First Stack And Let Implementers Infer Actuation

Pros:

- No new control-plane surface.
- Preserves the current writing cadence.
- Avoids arguing about implementation state in architecture docs.

Cons:

- Keeps false authority possible.
- Forces every engineer and deployer to rediscover which contracts are live.
- Does not help Torghut distinguish planned capital receipts from real capital receipts.

Decision: reject. This is the failure mode in the evidence.

### Option B: Stop New Architecture And Implement Every Accepted Contract Immediately

Pros:

- Directly reduces design debt.
- Makes the status payload closer to the current reading lists.
- Avoids another meta-layer.

Cons:

- Too broad for a degraded watch window.
- Touches large modules with high blast radius, including `supporting-primitives-controller.ts` and Torghut trading
  assembly.
- Does not prevent the next contract from drifting in the same way.

Decision: reject as the primary move. Implementation should follow, but without a ledger it will stay one-off.

### Option C: Add A Contract Actuation Ledger And Convergence Gates

Pros:

- Makes implementation state explicit.
- Gives deployers one place to check whether a contract can authorize action.
- Lets engineering move one contract at a time from `design_only` to `shadow` to `live`.
- Prevents Torghut capital from depending on planned receipts.

Cons:

- Adds one more status reducer and schema surface.
- Will expose uncomfortable design debt.
- Requires README and PR-template discipline so docs cannot silently claim live authority.

Decision: select Option C.

## Architecture

Add a pure reducer named `contract-actuation-ledger` under `services/jangar/src/server/`. It should not query
Kubernetes or databases directly. It consumes a static contract registry, implemented status modules, the generated
status payload, test fixture metadata, and deployer-consumer policy.

`ContractActuationRecord` fields:

- `contract_id`: stable slug from the design doc path.
- `document_ref`: repository path to the accepted design document.
- `companion_refs`: related Jangar or Torghut contracts.
- `owner_lane`: `jangar`, `torghut`, `deployer`, or `shared`.
- `contract_class`: `serving`, `dispatch`, `rollout`, `database`, `capital`, `repair`, `schema`, or `deployer`.
- `implementation_state`: `design_only`, `shadow`, `live`, `blocked`, `superseded`, or `retired`.
- `source_modules`: files that own the implementation.
- `status_fields`: status paths that must be non-null.
- `schema_fixtures`: tests or fixtures that pin the response shape.
- `consumer_gates`: deployer, engineer, or Torghut gates that consume the contract.
- `blocking_reason_codes`: why the contract cannot be promoted.
- `fresh_until`: expiry for the implementation-state claim.
- `promotion_requirements`: smallest set of work needed to move to the next state.
- `rollback_target`: prior contract or gate to use if the contract regresses.

State rules:

- `design_only`: accepted document exists, but no live source module or status field exists.
- `shadow`: source module and status field exist, but no material action depends on the contract.
- `live`: status field is non-null, schema tests pass, and at least one consumer gate reads it.
- `blocked`: contract cannot progress because a prerequisite contract, schema, or access path is missing.
- `superseded`: a newer live contract replaces it.
- `retired`: no active consumer should read it.

Initial ledger classification:

- `source_rollout_truth_exchange`: `shadow`, because the field and module exist and it already emits receipts, but
  deployer consumption is still being hardened.
- `material_action_verdict_epoch`: `shadow`, because it emits final verdicts but the stronger authority surface is not
  live.
- `controller_witness`: `shadow`, because it emits `hold_material` and source receipts.
- `controller_brownout_budget`: `design_only`, because the accepted field is null.
- `repair_outcome_settlement`: `design_only`, because the accepted field is null.
- `material_verdict_authority`: `design_only`, because the accepted field is null.
- Torghut `capital_unlock_receipts`: `design_only`, because Torghut status does not publish them.

## Validation Gates

Engineer validation:

- Add `services/jangar/src/server/__tests__/control-plane-contract-actuation-ledger.test.ts`.
- Add a fixture where `controller_brownout_budget` is absent and prove the ledger marks that contract `design_only`.
- Add a fixture where a status field exists but no consumer gate is registered and prove the state is `shadow`.
- Add a fixture where source, status, schema, and consumer evidence exist and prove the state is `live`.
- Extend `control-plane-status.test.ts` to assert `contract_actuation_ledger` is present and does not fail
  `serve_readonly`.

Deployer validation:

- Add a deploy verification check that fails if a rollout or capital gate cites a contract whose state is not `live`.
- Permit `shadow` only when the action class is observation or zero-notional repair.
- Require PR descriptions for architecture contracts to name intended initial state and promotion gate.

Data validation:

- The ledger must use typed Jangar and Torghut status endpoints as data witnesses when direct CNPG SQL is RBAC-blocked.
- The ledger must expose RBAC limitations as validation debt, not as a hidden pass.

## Rollout

Phase 0 is docs and registry only. Add the contract registry and tests with all newly accepted but unimplemented
contracts marked `design_only`.

Phase 1 adds `contract_actuation_ledger` to `/api/agents/control-plane/status` in shadow mode. UI can display it, but
no material action depends on it.

Phase 2 wires deploy verification to reject non-live contract authority for deploy widening and merge-ready.

Phase 3 wires Torghut capital gates to reject non-live Jangar authority receipts while continuing to allow observe-only
and zero-notional repair.

Phase 4 retires stale reading-list authority. Docs remain historical evidence, but only live or shadow contracts stay
in current source-of-truth lists.

## Rollback

If the reducer fails, omit the ledger field or mark `contract_actuation_ledger.status=unknown` and keep existing
status gates authoritative. Do not fail `/ready` for a ledger calculation error.

If deployer checks over-block, disable only the deployer check and leave the ledger visible for diagnosis.

If a contract was incorrectly marked live, downgrade it to `shadow` or `design_only`, require the prior live gate, and
record the downgrade as negative evidence.

## Risks

- The ledger can become another stale registry if it is not checked in CI.
- The first pass may mark too many contracts `design_only`, which will slow rollout velocity.
- A schema-only implementation could game the ledger unless consumer gates are required for `live`.
- Long reading lists may need pruning so engineers do not treat superseded docs as current authority.

## Handoff To Engineer

Implement the Jangar reducer first. The smallest accepted slice is:

1. Create the contract registry with the contracts named in this document.
2. Emit `contract_actuation_ledger` from control-plane status.
3. Add focused tests for `design_only`, `shadow`, and `live`.
4. Keep readiness independent from contract actuation debt.
5. Mark `controller_brownout_budget`, `repair_outcome_settlement`, and `material_verdict_authority` as
   `design_only` until their modules and tests exist.

## Handoff To Deployer

Do not use a design document as rollout authority by itself. Before widening Jangar, merge-ready, or Torghut capital
actions, require the corresponding `ContractActuationRecord.implementation_state` to be `live`. For observation and
zero-notional repair, `shadow` is acceptable when the record names a rollback target and a fresh expiry. If the ledger
is absent, fall back to the older implemented gates and keep material widening held.
