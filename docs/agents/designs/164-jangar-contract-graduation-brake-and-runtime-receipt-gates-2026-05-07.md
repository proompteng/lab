# 164. Jangar Contract Graduation Brake And Runtime Receipt Gates (2026-05-07)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-07
Owner: Gideon Park, Torghut Traders Architecture
Scope: Jangar control-plane resilience, accepted-contract graduation, runtime receipt custody, safer rollout brakes,
Torghut capital guardrail consumption, validation, rollback, and engineer/deployer acceptance gates.

Companion Torghut contract:

- `docs/torghut/design-system/v6/168-torghut-executable-alpha-receipts-and-capital-replay-board-2026-05-07.md`

Extends:

- `163-jangar-scoped-evidence-debt-and-retained-failure-quarantine-2026-05-07.md`
- `162-jangar-contract-witness-notary-and-material-action-gates-2026-05-07.md`
- `162-jangar-capital-receipt-convergence-and-repair-convoy-admission-2026-05-07.md`
- `docs/torghut/design-system/v6/167-torghut-scoped-profit-repair-options-and-freshness-debt-retirement-2026-05-07.md`

## Decision

I am selecting a **contract graduation brake with runtime receipt gates** as the next Jangar control-plane architecture
step.

The current cluster is serving. Jangar is healthy, Agents is healthy, and Torghut rolled forward to live revision
`torghut-00284` and simulation revision `torghut-sim-00384`. The hard outage shape from the earlier soak is gone. The
remaining control-plane risk is design-to-runtime drift. Jangar status has healthy database projection, healthy
workflow collection, and healthy execution trust, but dependency quorum still blocks on stale empirical jobs. Material
actions hold on missing source/GitOps revision, missing controller ingestion self-report, a split controller witness,
and stale Torghut proof. The field `contract_witness_notary` is not live, even though it is now an accepted design
contract. Torghut likewise does not emit the accepted `paper_edge_witness_notary` or `zero_notional_repair_queue`
fields.

The architecture answer is to stop treating an accepted document as the end of the control-plane lifecycle. Accepted
contracts must graduate through runtime receipt gates before they can widen material action. The new Jangar read model
is a `ContractGraduationBrake`: it lists accepted contracts, the runtime field or route that proves each one, the
consumer action classes that depend on it, and the graduation state. If a contract is accepted but absent at runtime,
normal dispatch, deploy widening, merge-ready, paper canary, and live capital stay held. Bounded repair is allowed only
when the repair targets one missing contract and names the receipt that will graduate it.

The tradeoff is deliberate friction. This brake will hold action classes even when deployment health is green. I accept
that because the evidence shows the worse failure mode: the platform can have many accepted architecture artifacts
while the live route still has null fields for the newest contracts. Six months from now, the control plane should tell
us which contracts are implemented, which are design-only, and which action class is being protected by the hold.

## Success Metrics

Success means:

- `/api/agents/control-plane/status?namespace=agents` emits `contract_graduation_brake`.
- Every current accepted Jangar/Torghut runtime contract has a `contract_ref`, `expected_runtime_witness`,
  `graduation_state`, `consumer_action_classes`, `fresh_until`, and `smallest_next_repair`.
- `contract_witness_notary`, `scoped_evidence_debt_ledger`, `paper_edge_witness_notary`,
  `zero_notional_repair_queue`, `scoped_profit_repair_option_book`, and
  `freshness_debt_retirement_receipt` start as `accepted_missing_runtime_witness` until their live fields exist.
- `serve_readonly` and `torghut_observe` may stay allowed when route, database projection, and proof-floor observation
  are current.
- `dispatch_repair` may run only against one named missing contract, with max dispatches and max runtime bounded by the
  existing material-action verdict.
- `dispatch_normal`, `deploy_widen`, `merge_ready`, `paper_canary`, `live_micro_canary`, and `live_scale` remain held
  or blocked while mandatory contract graduation states are missing, stale, contradicted, or unsupported by source
  rollout truth.
- Deployer output can answer, in one payload, "which accepted contract has not graduated, what route field proves it,
  what action class is held, and what receipt graduates it."

## Evidence Snapshot

All evidence in this pass was collected read-only on 2026-05-07. I did not mutate Kubernetes resources, database
records, GitOps resources, AgentRuns, broker state, Torghut flags, or ClickHouse data.

### Cluster And Rollout Evidence

- Branch: `codex/swarm-torghut-quant-discover`, based on `main` at
  `50106870a1cf3ef983306b77023e71e9ec8830fd`.
- `kubectl auth whoami` identified `system:serviceaccount:agents:agents-sa`; `kubectl config current-context` was not
  set, but in-cluster authentication worked.
- Argo CD reported `torghut` as `Synced`, `Healthy`, and operation `Succeeded` at revision
  `50106870a1cf3ef983306b77023e71e9ec8830fd` after the active rollout converged.
- Jangar deployments were available: `jangar=1/1`, `bumba=1/1`, `jangar-alloy=1/1`, `symphony=1/1`, and
  `symphony-jangar=1/1`.
- Agents deployments were available: `agents=1/1`, `agents-controllers=2/2`, and `agents-alloy=1/1`.
- Torghut live `torghut-00284-deployment` and sim `torghut-sim-00384-deployment` were both `1/1` on image digest
  `sha256:014b9a46cd6690a9fd689b2e5cb170c35148c258358dfe53f3b86a46977c8421`.
- Recent Torghut events showed the rollout handoff: database migrations completed, options catalog and enricher rolled,
  revisions `00284` and `00384` were created, and startup/readiness probe failures cleared after the new pods became
  available.
- Recent Agents events still showed one Torghut verify attempt with missing ConfigMap volumes, while newer discover
  and verify cron jobs were created and several jobs were running or completing.
- Listing Knative services in `torghut` was forbidden to `agents-sa`; deployment, pod, event, and typed HTTP route
  evidence are the available rollout witnesses.

### Source Evidence

- `services/jangar/src/server/control-plane-status.ts` is the convergence surface and is 787 lines. It already assembles
  database consistency, workflows, watches, execution trust, material-action verdicts, and source rollout truth.
- `services/jangar/src/server/control-plane-source-rollout-truth-exchange.ts` is 632 lines and already computes source,
  image, controller, route, database, watch, and Torghut proof-floor receipts. It reports useful settlement state but
  does not yet graduate accepted contracts through runtime route witnesses.
- `services/jangar/src/server/control-plane-material-action-verdict.ts` is 528 lines and already holds action classes on
  dependency, SLO, action-clock, and source-rollout evidence. It does not yet consume contract graduation state as a
  mandatory input.
- `services/jangar/src/server/control-plane-execution-trust.ts` is 506 lines and reports execution trust healthy in the
  current window. The missing contract fields are not execution-trust failures; they are graduation failures.
- Source search found accepted terms such as `contract_witness_notary`, `scoped_evidence_debt_ledger`, and Torghut
  repair ledgers mostly in documentation, not in live reducers and route payloads.
- Jangar has focused tests for quant health routes, source rollout truth, material actions, and execution trust. The
  missing regression surface is a route payload where deployment and database health are green but accepted contract
  fields are absent, and material actions must remain held.

### Database And Data Evidence

- Jangar `/ready` returned `status=ok`; leader election was current, orchestration controller was started, and serving
  `agentsController.enabled=false` remained explicit.
- Jangar status database projection was healthy: `configured=true`, `connected=true`, latency about `3 ms`,
  `registered_count=28`, `applied_count=28`, and latest applied migration
  `20260505_torghut_quant_pipeline_health_window_index`.
- Jangar dependency quorum returned `decision=block` with reason `empirical_jobs_degraded`.
- Jangar execution trust returned `status=healthy` with no blocking windows.
- Jangar material actions allowed `serve_readonly` and `torghut_observe`, held `dispatch_repair`, `dispatch_normal`,
  `deploy_widen`, `merge_ready`, and `paper_canary`, and blocked `live_micro_canary` and `live_scale`.
- The material-action holds included `source_rollout_truth_missing:source_or_gitops_revision`, a missing AgentRun
  ingestion witness, a split controller heartbeat, stale empirical jobs, and `workflow_artifact.configmap_missing`.
- `contract_witness_notary` was absent from the live Jangar status payload.
- Direct CNPG cluster reads and `pods/exec` were forbidden in both `jangar` and `torghut`, so typed route database
  projections are the least-privilege database proof surface for this worker.
- Torghut `/db-check` returned `ok=true`, `schema_current=true`, expected and current head
  `0029_whitepaper_embedding_dimension_4096`, one schema branch, no missing or unexpected heads, and lineage-ready
  graph. It still warns about parent forks at `0010_execution_provenance_and_governance_trace` and
  `0015_whitepaper_workflow_tables`.

## Problem

The architecture corpus is moving faster than runtime contract graduation. That creates four failure modes:

1. **Design-as-evidence**: an accepted document gets treated as permission even though no live route emits the field.
2. **Hidden absence**: operators must inspect large payloads to notice a contract field is null.
3. **False green rollout**: a healthy deployment, database projection, and execution-trust window hide missing consumer
   receipts.
4. **Unsafe repair broadening**: a repair run can target a general health issue without naming the exact accepted
   contract it will graduate.

The control plane already has conservative action verdicts, but they are still forced to infer contract absence from
secondary symptoms. Contract graduation needs to become a first-class admission input.

## Alternatives Considered

### Option A: Implement Each Missing Accepted Contract Directly

Build `contract_witness_notary`, `scoped_evidence_debt_ledger`, and the Torghut companion fields one by one without a
graduation brake.

Advantages:

- Directly closes the known null fields.
- Keeps each reducer domain-specific.
- Avoids another read model in the status payload.

Disadvantages:

- Repeats the same design-to-runtime drift for the next accepted contract.
- Does not let material-action verdicts reason over "accepted but not live" uniformly.
- Gives deployers no single list of contracts that have not graduated.

Decision: necessary implementation work, but insufficient as the architecture.

### Option B: Add A Broad Control-Plane Contract Dashboard

Publish a dashboard or summary that reports whether the newest architecture fields exist.

Advantages:

- Low implementation risk.
- Useful for humans.
- Avoids changing action gates at first.

Disadvantages:

- Observability alone does not prevent action broadening.
- It can drift from material-action verdicts.
- It does not define repair receipts or rollback behavior.

Decision: useful as a view over the brake, not as the brake itself.

### Option C: Contract Graduation Brake With Runtime Receipt Gates

Make accepted-contract graduation a typed Jangar reducer and mandatory material-action input.

Advantages:

- Prevents accepted documents from masquerading as runtime evidence.
- Gives every held action class a precise missing contract and smallest repair.
- Converts source/GitOps split, controller ingestion split, and missing contract fields into one admission story.
- Allows bounded repair without opening normal dispatch or capital.
- Gives engineer and deployer stages deterministic acceptance gates.

Disadvantages:

- Adds one more reducer to an already dense status surface.
- Requires stable contract naming and route-field ownership.
- Will keep some actions held longer than a broad health dashboard would.

Decision: select Option C.

## Architecture

### ContractGraduationBrake

Jangar emits one brake per namespace and control-plane status generation.

```text
contract_graduation_brake
  schema_version
  brake_id
  namespace
  generated_at
  fresh_until
  source_rollout_truth_exchange_ref
  database_projection_ref
  controller_witness_ref
  contract_rows
  allowed_action_classes
  held_action_classes
  blocked_action_classes
  smallest_next_repairs
  rollback_target
```

Each contract row includes:

```text
contract_graduation_row
  contract_ref
  contract_title
  owner_surface
  accepted_at
  expected_runtime_witness
  expected_route
  observed_state
  observed_ref
  missing_reason
  required_for_action_classes
  optional_for_action_classes
  graduation_state
  fresh_until
  smallest_next_repair
```

Graduation states:

- `design_only`: the contract is accepted but no runtime witness is expected yet.
- `accepted_missing_runtime_witness`: the contract requires a runtime witness and the field or route is absent.
- `runtime_witness_present`: the field exists and has a current payload.
- `consumer_asserted`: the downstream material action or Torghut route cites the witness.
- `graduated`: source, image, route, database projection, and consumer assertion are current.
- `stale`: the witness exists but is outside its freshness window.
- `contradicted`: the witness conflicts with another accepted proof source.
- `retired`: the contract has been superseded by a newer accepted contract with an active witness.

### Mandatory Initial Rows

The first implementation should seed rows for the active architecture stack:

- Jangar `contract_witness_notary`.
- Jangar `scoped_evidence_debt_ledger`.
- Jangar `retained_failure_quarantine`.
- Jangar `contract_graduation_brake`.
- Torghut `paper_edge_witness_notary`.
- Torghut `zero_notional_repair_queue`.
- Torghut `scoped_profit_repair_option_book`.
- Torghut `freshness_debt_retirement_receipt`.
- Torghut `executable_alpha_receipt`.
- Torghut `capital_replay_board`.

Rows may start as `accepted_missing_runtime_witness`; that is the point. Missing is allowed for observation and bounded
repair. Missing is not allowed for normal dispatch, paper canary, or live capital.

### Material Action Integration

`control-plane-material-action-verdict.ts` consumes the brake after dependency quorum and source rollout truth:

- `serve_readonly`: allowed when database projection, route generation, and controller observation are current.
- `torghut_observe`: allowed when Torghut proof floor is observable and max notional is zero.
- `dispatch_repair`: held by default, but may become bounded allow when exactly one missing contract row is selected
  and the repair has a graduation receipt target.
- `dispatch_normal`, `deploy_widen`, and `merge_ready`: held until mandatory rows for those action classes are
  `graduated` or explicitly `retired`.
- `paper_canary`, `live_micro_canary`, and `live_scale`: held or blocked until Torghut companion capital receipts cite
  graduated Jangar rows.

### Runtime Receipt Gate

A repair graduates a contract only by producing a receipt:

```text
runtime_contract_graduation_receipt
  receipt_id
  contract_ref
  repair_run_ref
  before_state
  after_state
  source_head_sha
  gitops_revision
  live_image_digest
  route_field_ref
  database_projection_ref
  consumer_assertion_ref
  validation_refs
  graduation_decision
  remaining_blockers
```

`graduation_decision` is one of `graduated`, `reduced`, `unchanged`, `failed`, or `contradicted`.

## Validation Gates

Engineer gates:

- Add a pure Jangar reducer for `contract_graduation_brake`; do not perform Kubernetes, database, or GitHub mutation in
  the reducer.
- Unit tests must cover green rollout plus missing contract field, stale contract witness, contradicted witness,
  retired contract, and bounded repair for one selected missing row.
- Material-action tests must prove normal dispatch, deploy widening, merge-ready, paper canary, and live capital do not
  widen when a mandatory contract row is `accepted_missing_runtime_witness`.
- Source rollout truth tests must prove source/GitOps absence remains visible in the brake instead of being masked by
  healthy live image digest.
- Route payload tests must prove absent optional rows do not block `serve_readonly`, but absent mandatory rows block
  their action classes.

Deployer gates:

- Capture Jangar status before rollout and verify the brake lists all mandatory rows.
- Roll the route in shadow first; the first accepted outcome for a new row may be
  `accepted_missing_runtime_witness`.
- Do not widen dispatch until the route emits the brake and existing material-action decisions still match the current
  conservative state.
- For every graduation, attach before and after refs for route payload, source/GitOps identity, image digest, database
  projection, and consumer assertion.

## Rollout

1. Add the reducer and static accepted-contract registry behind an additive status field.
2. Emit rows as informational while material-action verdicts are unchanged.
3. Add material-action consumption for `dispatch_repair` only.
4. After one healthy rollout, make missing mandatory rows hold `dispatch_normal`, `deploy_widen`, and `merge_ready`.
5. After Torghut emits companion alpha receipts, wire paper/live capital action classes to the brake.

## Rollback

Rollback is additive and conservative:

- If the new reducer throws, omit `contract_graduation_brake` and keep existing material-action holds.
- If rows are malformed, mark the brake `contradicted` and hold all non-observation action classes.
- If a graduated row later goes stale, degrade it to `stale` and return affected action classes to hold/block.
- If deployer needs to remove the field, no capital action should widen because existing proof-floor and dependency
  gates remain conservative.

## Risks

- Registry sprawl: too many accepted docs can become rows. Mitigation: only rows with runtime witnesses or action-class
  dependencies enter the brake.
- False holds: a row can be mandatory too early. Mitigation: rows start optional for observation and become mandatory
  only with an explicit consumer action class.
- Stale receipts: graduation receipts can age out. Mitigation: every row carries `fresh_until` and returns to `stale`.
- Coupling: material-action verdicts can become too dependent on one reducer. Mitigation: keep the brake pure and feed
  it after source rollout truth, not before.

## Handoff

Engineer stage should implement the Jangar reducer, status projection, and tests first. Deployer stage should accept
the first rollout only when the brake is present, missing rows are explicit, and current conservative decisions remain
unchanged: observation allowed, normal dispatch held, paper canary held, and live capital blocked.
