# 162. Jangar Contract Witness Notary And Material Action Gates (2026-05-07)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-07
Owner: Victor Chen, Jangar Engineering
Scope: Jangar control-plane contract convergence, source/database witness custody, material-action admission,
Torghut zero-notional repair evidence, validation, rollout, rollback, and engineer/deployer acceptance gates.

Companion Torghut contract:

- `docs/torghut/design-system/v6/166-torghut-paper-edge-witness-notary-and-zero-notional-repair-queue-2026-05-07.md`

Extends:

- `161-jangar-stage-debt-clearinghouse-and-freshness-credit-ledger-2026-05-07.md`
- `161-jangar-repair-outcome-brownout-market-and-stage-freeze-clearing-2026-05-07.md`
- `160-jangar-split-authority-repair-escrow-and-dispatch-reentry-packets-2026-05-07.md`
- `148-jangar-source-rollout-truth-exchange-and-proof-floor-settlement-2026-05-07.md`
- `120-jangar-material-action-verdict-arbiter-and-clock-budget-parity-2026-05-06.md`

## Decision

I am selecting a contract witness notary with material-action gates as the next Jangar control-plane architecture step.

The platform is not down. Argo CD reports Jangar, Agents, Torghut, and Symphony Jangar synced and healthy at revision
`5549fe9bb4f34cac56f5db3619b0cb53405b7783`. Jangar serving is healthy, Agents controller deployments are available,
the status route reports healthy rollout, workflow, database, and watch windows, and current Jangar stages are fresh.

The problem is contract convergence. We now have a strong architecture stack, but live runtime truth is not caught up
with every accepted contract. The latest accepted designs call for `stage_debt_clearinghouse` and
`quant_freshness_debt_ledger`; the current live payloads do not publish those fields yet. Direct CNPG database
inspection is blocked by RBAC, so the database witness is the typed Jangar route projection, not raw SQL. AgentRun
ingestion is still `unknown` because the serving process is not the controller, while the source-rollout truth exchange
shows a split controller witness. Torghut can observe, but paper and live capital are still correctly held.

The control plane needs a notary that distinguishes three states that are currently mixed together:

1. A design contract exists and is accepted.
2. A live route emits a current witness for that contract.
3. A material action may rely on that witness.

The tradeoff is one more reducer in an already large status surface. I accept that because it removes a worse failure
mode: humans treating design intent as runtime evidence, or treating a healthy serving route as permission to widen
dispatch. The notary makes contract absence visible and gives deployer tooling one place to decide whether a gate is
implemented, missing, stale, or blocked by access.

## Runtime Objective And Success Metrics

Success means:

- `/api/agents/control-plane/status?namespace=agents` publishes `contract_witness_notary`.
- Each accepted Jangar/Torghut runtime contract has a witness row with `expected_contract`, `required_route_field`,
  `observed_state`, `fresh_until`, `evidence_ref`, `missing_reason`, and `consumer_action_classes`.
- Accepted documentation never grants action authority by itself. A material action may cite a design document only
  when a live witness row proves the route field exists and is current.
- `stage_debt_clearinghouse` and `quant_freshness_debt_ledger` are represented as `accepted_missing_runtime_witness`
  until implementation publishes them.
- Direct CNPG denial is represented as `direct_database_witness_unavailable`, with the typed route database projection
  as the current fallback witness.
- `serve_readonly` may remain allowed with a missing optional contract witness when serving, database projection, and
  route health are current.
- `torghut_observe` may remain allowed when proof floor is `repair_only` and max notional is `0`.
- `measure_zero_notional` may be introduced as an explicit material action class for read-only or zero-notional repair
  measurement.
- `dispatch_repair`, `dispatch_normal`, `deploy_widen`, `merge_ready`, `paper_canary`, `live_micro_canary`, and
  `live_scale` require all mandatory witness rows for their action class to be implemented, current, and non-blocking.
- Deployer output can answer: which contract is accepted, which live witness is missing, which action classes are
  affected, and what smallest implementation closes the gap.

## Evidence Snapshot

Evidence was collected read-only on 2026-05-07 from 20:06Z to 20:11Z. I did not mutate Kubernetes resources,
database records, ClickHouse data, broker state, GitOps resources, AgentRun objects, or trading flags.

### Cluster And Rollout Evidence

- The workspace was on `codex/swarm-jangar-control-plane-discover`, based on `main` at
  `5549fe9bb4f34cac56f5db3619b0cb53405b7783`.
- The kube context was bootstrapped to `in-cluster`; `kubectl auth whoami` identified
  `system:serviceaccount:agents:agents-sa`.
- Argo CD reported `jangar`, `agents`, `torghut`, and `symphony-jangar` as `Synced`, `Healthy`, and operation
  `Succeeded` at revision `5549fe9bb4f34cac56f5db3619b0cb53405b7783`.
- Jangar deployments were available: `jangar=1/1`, `bumba=1/1`, `jangar-alloy=1/1`, `symphony=1/1`, and
  `symphony-jangar=1/1`.
- Jangar pod `jangar-865f8f4768-bq94m` was `2/2 Running` on image
  `registry.ide-newton.ts.net/lab/jangar:c7f3aa1b@sha256:6ca018b8...`.
- Agents deployments were available: `agents=1/1`, `agents-controllers=2/2`, and `agents-alloy=1/1`.
- Recent Agents events showed transient readiness probe timeouts on `agents` and `agents-controllers`, followed by
  healthy deployment state.
- Agents events still showed a missing ConfigMap mount for
  `torghut-quant-verify-sched-knvpz-step-1-attempt-1-pk8k8`.
- Torghut current live and simulation Knative revisions were available as `torghut-00280=1/1` and
  `torghut-sim-00380=1/1`; older revisions were scaled to zero.
- Listing Knative services in `torghut` was forbidden to the `agents-sa` service account, so deployment, pod, service,
  event, and HTTP route evidence were the available cluster witnesses.

### Jangar Status And Database Evidence

- `GET http://jangar.jangar.svc.cluster.local/health` returned `status=ok`.
- `GET http://jangar.jangar.svc.cluster.local/ready` returned `status=ok`; leader election was active and current, and
  orchestration controller was started.
- The serving readiness payload still showed `agentsController.enabled=false` and `agentsController.started=false`.
- The status route database projection was healthy: `configured=true`, `connected=true`, `latency_ms=21`,
  `registered_count=28`, `applied_count=28`, `unapplied_count=0`, latest applied
  `20260505_torghut_quant_pipeline_health_window_index`.
- Direct CNPG inspection was blocked in both `jangar` and `torghut`. A direct CNPG cluster permission check returned
  `no`, and `kubectl cnpg psql` failed because `agents-sa` cannot create `pods/exec`.
- Rollout health was healthy for `agents` and `agents-controllers`, with zero unavailable replicas.
- Watch reliability was healthy over the current 15 minute window: three streams, `2798` events, `0` errors, and
  three restarts.
- Workflow reliability was healthy over the current 15 minute window: `active_job_runs=0`, `recent_failed_jobs=0`,
  and `collection_errors=0`.
- Jangar stage freshness was current for `discover`, `plan`, `implement`, and `verify`.
- `agentrun_ingestion.status` was `unknown` with message `agents controller not started`.
- `source_rollout_truth_exchange` ran in `shadow` mode, had `source_head_sha=null` and `gitops_revision=null`, and
  reported a split controller heartbeat because the controller heartbeat is authoritative while the serving process is
  not the controller.
- Material-action verdicts allowed `torghut_observe`, held `dispatch_normal`, `deploy_widen`, `merge_ready`, and
  `paper_canary`, and blocked live capital actions.
- `merge_ready` included a contradiction where an action clock allowed while the material budget held.

### Torghut Data Evidence

- Live `/trading/status` reported mode `live`, `running=true`, `enabled=true`, `kill_switch_enabled=false`, and
  `autonomy_enabled=false`.
- Torghut live `active_capital_stage` was `shadow`; `alpha_readiness_promotion_eligible_total=0` and
  `alpha_readiness_rollback_required_total=3`.
- Live empirical jobs were degraded because `benchmark_parity`, `foundation_router_parity`, `janus_event_car`, and
  `janus_hgrm_reward` were stale from `2026-05-06T16:27:32Z`.
- Live proof floor was `repair_only`, `route_state=repair_only`, `capital_state=zero_notional`, and
  `max_notional=0`.
- Live proof floor blockers were `hypothesis_not_promotion_eligible`, `degraded`,
  `execution_tca_route_universe_empty`, `market_context_stale`, and `simple_submit_disabled`.
- Live routeability had zero routeable symbols; `AAPL`, `AMD`, `AVGO`, `INTC`, and `NVDA` were blocked, while
  `AMZN`, `GOOGL`, and `ORCL` were missing.
- Live TCA had `7334` orders, `7245` filled executions, average absolute slippage about `13.82 bps`, and guardrail
  `8 bps`.
- Jangar quant health for `PA3SX7FYNUTF/15m` had `latestMetricsCount=144`, metrics updated at
  `2026-05-07T20:10:13.985Z`, but `status=degraded` because ingestion lag was `538452` seconds and materialization
  was not OK.
- Simulation status was mode `paper`, but critical toggle parity diverged from expected `TRADING_MODE=live`.
- Simulation proof floor was also `repair_only` and zero-notional; it had one `NVDA` probing path, seven missing
  symbols, stale TCA, and one unsettled execution.
- Jangar quant health for `TORGHUT_SIM/15m` had zero latest metrics, an empty latest store alarm, and no stages.
- Market-context provider checks for `NVDA` succeeded, but the bundle was degraded: technicals, fundamentals, news,
  and regime were stale.

## Source Assessment

- `services/jangar/src/server/control-plane-status.ts` is the correct integration point. It already assembles database,
  rollout, workflows, watches, source rollout truth, dependency quorum, and material-action verdicts, but it does not
  yet expose a contract-convergence witness layer.
- `services/jangar/src/server/control-plane-source-rollout-truth-exchange.ts` already computes the strongest source,
  image, controller, route, database, watch, and Torghut proof-floor receipts. It should feed the notary rather than
  becoming the notary itself.
- `services/jangar/src/server/control-plane-material-action-verdict.ts` already produces action-class verdicts. It
  needs a mandatory input for contract witness rows so an accepted design cannot be interpreted as implemented
  runtime evidence.
- `services/jangar/src/server/control-plane-execution-trust.ts` and
  `services/jangar/src/server/control-plane-workflows.ts` have enough stage and job evidence to identify fresh stages,
  but the proposed `stage_debt_clearinghouse` contract is not live yet.
- The codebase has focused tests for status assembly, material-action verdicts, source rollout truth, watch
  reliability, and migration consistency. The missing regression surface is contract absence: an accepted design with
  no live route field must hold dependent material actions and name the implementation gap.
- The current high-risk surface is size and coupling. The status integration path spans several reducers and more than
  10,000 lines across Jangar/Torghut control-plane modules. The notary must stay a pure reducer with small fixtures,
  not a collector with side effects.

## Problem

Jangar now has enough architecture contracts to improve resilience, but the runtime cannot yet say which contracts are
implemented. That matters because material-action gates are making decisions from a mix of:

- route health;
- deployment rollout state;
- database projection state;
- source/GitOps identity;
- watch and workflow windows;
- AgentRun ingestion custody;
- Torghut proof floor and quant health;
- accepted architecture documents.

The accepted documents are valuable, but they are not runtime evidence. The system must not let "documented" drift
into "safe". It also must not make operators inspect a large JSON payload to discover that a contract field is absent.

The current payload demonstrates the gap. `source_rollout_truth_exchange` exists and is useful. The newest accepted
`stage_debt_clearinghouse` and `quant_freshness_debt_ledger` fields do not exist in live status yet. Torghut proof
floor is conservative and zero-notional, but Jangar does not have one compact witness that says which downstream
contract is missing and which action classes are affected.

## Options Considered

### Option A: Tighten Dependency Quorum And Keep Everything Held

This option keeps the current posture: dependency quorum blocks on empirical jobs, source rollout truth holds
dispatch, and proof floor keeps Torghut zero-notional.

Advantages:

- Lowest implementation cost.
- Safest immediate capital posture.
- Avoids another status reducer.

Disadvantages:

- Does not distinguish missing contract implementation from real runtime degradation.
- Keeps humans reading raw status payloads to infer why a gate is held.
- Does not give engineers a precise acceptance target for closing design-to-runtime gaps.

Decision: reject as the primary architecture. Keep the conservative gates, but add the missing witness layer.

### Option B: Implement Each Missing Contract Independently

This option builds `stage_debt_clearinghouse`, `quant_freshness_debt_ledger`, and later contracts directly in their
own routes without a convergence layer.

Advantages:

- Moves the latest designs toward implementation.
- Keeps each contract domain-specific.
- Avoids a central registry.

Disadvantages:

- Repeats the same problem for every new contract.
- Does not tell material-action verdicts whether a downstream contract is present or absent.
- Makes deployer acceptance depend on field-by-field route inspection.

Decision: useful as implementation work, but incomplete as the system architecture.

### Option C: Contract Witness Notary With Material-Action Gates

This option adds a small notary reducer that compares accepted contracts with live witness rows, then feeds material
action gates.

Advantages:

- Makes missing route fields explicit and auditable.
- Separates design acceptance from runtime implementation.
- Gives every material action a compact dependency set.
- Lets deployer tooling fail on one missing witness instead of parsing raw route details.
- Preserves zero-notional Torghut observation while holding paper and live capital.

Disadvantages:

- Adds one more reducer and status field.
- Requires a maintained registry of contract-to-field mappings.
- Can become bureaucracy if it is allowed to own collection or business logic.

Decision: select Option C.

## Architecture

### Contract Registry

Jangar owns a small in-code registry of contract witnesses. Each registry row is static and reviewable:

```text
contract_registry_item
  contract_id
  design_artifact
  owner_system                 # jangar, torghut
  required_route               # control-plane/status, trading/status, trading/health, autonomy, quant/health
  required_field_path
  required_for_action_classes
  optional_for_action_classes
  fallback_witness_policy      # none, typed_route_projection, manual_readonly_evidence
  missing_runtime_state        # accepted_missing_runtime_witness
```

Initial registry rows:

- `source_rollout_truth_exchange`: implemented, required for dispatch, deploy, merge, paper, and live.
- `material_action_verdict_epoch`: implemented, required for every material action except route health.
- `stage_debt_clearinghouse`: accepted, missing runtime witness, required before stale-stage debt can be retired.
- `repair_outcome_brownout_market`: accepted, missing runtime witness, required before measured repair dispatch.
- `quant_freshness_debt_ledger`: accepted, missing runtime witness, required before Torghut paper candidates.
- `proof_floor`: implemented in Torghut, required for paper and live.
- `market_context_health`: implemented in Jangar, required for paper and live.
- `direct_cnpg_database_probe`: blocked by RBAC, fallback to typed route database projection.

### Witness Receipt

The reducer emits one receipt per registry row:

```text
contract_witness
  witness_id
  contract_id
  observed_state               # current, stale, accepted_missing_runtime_witness, blocked_by_rbac, failed
  observed_at
  fresh_until
  design_artifact
  required_route
  required_field_path
  evidence_ref
  fallback_evidence_ref
  missing_reason_codes
  affected_action_classes
  smallest_unblocker
```

The receipt is a read model. It does not query Kubernetes, GitHub, CNPG, or Torghut directly. It consumes the existing
status inputs and optional fetched Torghut route snapshots already used by `control-plane-status.ts`.

### Material-Action Gate Integration

Material-action verdicts consume a compact map from `action_class` to required witness IDs.

Gate precedence:

1. `block` if a required witness is `failed`, stale beyond TTL, or missing with no fallback.
2. `hold` if a witness is accepted but not implemented, or if the fallback is typed route evidence rather than direct
   database evidence.
3. `allow_zero_notional` for `measure_zero_notional` only when runtime, database projection, route health, and Torghut
   proof floor agree that max notional is `0`.
4. `allow` only when every required witness is current and action-specific risk gates pass.

`serve_readonly` remains separate. It may rely on the existing serving passport, database projection, and route
health. It must still display missing contract witnesses so operators do not confuse serving with action readiness.

### Database Witness Policy

Direct SQL is useful but not guaranteed from the worker runtime. The notary treats direct CNPG denial as evidence, not
as silence.

Policy:

- If `pods/exec` or CNPG `clusters` access is denied, emit `blocked_by_rbac`.
- If the typed route database projection is healthy, emit a fallback witness with `fallback_policy=typed_route_projection`.
- Keep `serve_readonly` and `torghut_observe` available when fallback witness is healthy.
- Hold deploy, merge, and capital actions when a direct database witness is required by the contract and only fallback
  evidence exists.

### Torghut Witness Policy

Torghut proof floor and quant health are downstream evidence, not Jangar authority by themselves. The notary records:

- live proof floor state and blockers;
- simulation proof floor state and blockers;
- quant health for live account and simulation account;
- market-context health by symbol when available;
- routeability summary and zero-notional status.

Jangar uses those receipts to decide action classes. Torghut uses the companion paper-edge witness notary to rank
repair work.

## Engineer Scope

1. Add `services/jangar/src/server/control-plane-contract-witness-notary.ts` as a pure reducer.
2. Add fixture tests for implemented, accepted-missing, stale, and RBAC-blocked witnesses.
3. Extend `ControlPlaneStatus` with `contract_witness_notary`.
4. Feed the notary from existing status inputs: database projection, workflow reliability, stages, watch reliability,
   source rollout truth, material verdicts, and Torghut route snapshots.
5. Add material-action verdict tests proving accepted-but-missing witnesses hold dependent action classes.
6. Add UI rendering that groups witnesses by `current`, `accepted_missing_runtime_witness`, `blocked_by_rbac`, and
   `stale`.
7. Keep collection outside the reducer. If a source is unavailable, pass an explicit unavailable input and let the
   reducer emit the receipt.

## Validation Gates

Local validation:

- `bun test services/jangar/src/server/__tests__/control-plane-contract-witness-notary.test.ts`
- `bun test services/jangar/src/server/__tests__/control-plane-material-action-verdict.test.ts -t witness`
- `bun test services/jangar/src/server/__tests__/control-plane-status.test.ts -t contract_witness_notary`
- `bunx oxfmt --check services/jangar/src/server/control-plane-contract-witness-notary.ts services/jangar/src/server/__tests__/control-plane-contract-witness-notary.test.ts docs/agents/designs/162-jangar-contract-witness-notary-and-material-action-gates-2026-05-07.md`
- `bun run --filter @proompteng/jangar tsc`

Cluster validation after deploy:

- `curl -fsS 'http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status?namespace=agents' | jq '.contract_witness_notary.summary'`
- Confirm `stage_debt_clearinghouse` and `quant_freshness_debt_ledger` show
  `accepted_missing_runtime_witness` until their implementation PRs land.
- Confirm `direct_cnpg_database_probe` shows `blocked_by_rbac` with fallback database projection healthy.
- Confirm `serve_readonly` and `torghut_observe` remain allowed.
- Confirm `dispatch_normal`, `deploy_widen`, `merge_ready`, `paper_canary`, `live_micro_canary`, and `live_scale`
  remain held or blocked while mandatory witnesses are missing.

## Rollout Plan

1. Ship the notary in shadow mode. It must not change existing verdict decisions for the first deploy.
2. Compare notary witness states with current material-action verdict blockers for at least one full schedule cadence.
3. Enable verdict annotation: material-action verdicts include witness IDs in `evidence_refs` and reason codes.
4. Enable enforcement for `dispatch_repair` and `merge_ready` first, because those are where documentation/runtime
   confusion is most likely.
5. Enable paper and live capital enforcement only after Torghut companion queue emits current paper-edge witness rows.

## Rollback Plan

- Disable notary enforcement and keep `contract_witness_notary` as observe-only.
- Keep existing source rollout truth, dependency quorum, material-action verdicts, and proof-floor gates active.
- If the notary emits false missing witnesses, remove the affected registry row from enforcement and leave the raw
  status field as the source of truth.
- If status payload size becomes a problem, keep only the summary in the main route and expose full witnesses through a
  detail route.

## Risks

- The registry can drift from design documents. Mitigation: require a small unit test fixture for every registry row.
- The notary can grow into a collector. Mitigation: keep it pure and feed it already-collected inputs.
- Optional witnesses can be misclassified as mandatory. Mitigation: action-class-specific requirements, not global
  severity.
- RBAC-blocked database checks may be overinterpreted as database health failure. Mitigation: distinguish direct
  witness availability from typed route projection health.
- Deployer tooling may begin relying on witness names before they stabilize. Mitigation: version the registry and
  expose stable `contract_id` values.

## Handoff To Engineer And Deployer

Engineer owns the pure reducer, status integration, material-action verdict integration, UI grouping, and tests. The
first implementation should make accepted-but-missing contracts visible without changing action outcomes. Enforcement
comes after one cadence of shadow comparison.

Deployer owns live evidence capture. A rollout is acceptable only when the notary reports current witnesses for already
implemented contracts, accepted-missing witnesses for unimplemented contracts, and no accidental widening of dispatch,
merge, paper, or live capital gates. The deployer should treat a missing notary field as a failed rollout once the
implementation PR is merged.
