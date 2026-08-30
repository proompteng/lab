# 172. Jangar Evidence-Reconciliation Broker And Capital Action Firewall (2026-05-08)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-08
Owner: Gideon Park, Torghut Traders Architecture
Scope: Jangar control-plane resilience, Torghut evidence reconciliation, material action firewalling, source truth,
rollout safety, rollback, and engineer/deployer acceptance gates.

Companion Torghut contract:

- `docs/torghut/design-system/v6/176-torghut-source-bound-evidence-reconciliation-and-capital-admission-ledger-2026-05-08.md`

Extends:

- `171-jangar-terminal-debt-exchange-and-retry-custody-2026-05-08.md`
- `170-jangar-profit-witness-broker-and-source-truth-capital-custody-2026-05-08.md`
- `docs/torghut/design-system/v6/175-torghut-failure-costed-context-repair-and-route-custody-2026-05-08.md`

## Decision

I am selecting an **evidence-reconciliation broker with a capital action firewall** for Jangar.

The control plane has recovered enough to serve and observe. Controllers are healthy, leader election is current,
workflow and job runtimes are configured, execution trust is healthy, database migrations are consistent, watch
reliability is healthy, and the collaboration runtime kit includes `codex-nats-publish`, `codex-nats-soak`, `nats`, the
workspace path, and `NATS_URL`.

That recovered state is still not capital authority. Jangar already holds or blocks the right action classes because
source rollout truth is missing, controller witness custody is split, Torghut consumer evidence is missing, forecast
service is degraded, paper settlement is required, and Torghut proof floor remains repair-only. The next reliability
step is to make those holds depend on reconciled Torghut evidence, not just on individual status fields.

The broker consumes Torghut's source-bound capital admission ledger and turns its contradictions into Jangar action
decisions. Healthy serving can still allow `serve_readonly` and `torghut_observe`. `dispatch_repair`, `dispatch_normal`,
`deploy_widen`, `merge_ready`, `paper_canary`, `live_micro_canary`, and `live_scale` cannot become more permissive while
Torghut reports unresolved source-bound contradictions.

The tradeoff is that Jangar will block some actions even when its own controller health is green. I accept that because
the failure mode to reduce is authority inflation: a recovered control plane must not make stale, empty, or divergent
profit evidence spendable.

## Current Evidence

All evidence in this pass was collected read-only on 2026-05-08. I did not mutate Kubernetes resources, database
records, secrets, AgentRuns, GitOps resources, or trading state.

### Jangar Evidence

- Jangar `/health` returned HTTP 200 with `status=ok`.
- Jangar control-plane status generated at `2026-05-08T01:14Z`.
- `agents-controller`, `supporting-controller`, and `orchestration-controller` were healthy with fresh heartbeat
  authority from `agents-controllers-76cfc88f88-6w7fk`.
- Leader election was enabled, required, and current.
- Runtime adapters were available or configured: workflow, job, Temporal, and custom.
- Database was connected with 2 ms latency, and Kysely migration consistency was healthy with 28 registered and 28
  applied migrations.
- Execution trust was healthy.
- Watch reliability was healthy with 2 observed streams, 1,897 events, zero errors, and zero restarts.
- Runtime kits were healthy for serving and collaboration.

### Action-Custody Evidence

- Source rollout truth exchange was in shadow mode.
- Source head SHA and GitOps revision were null.
- Controller heartbeat settlement was `allow_with_split`, meaning heartbeat was authoritative while the serving process
  was not the controller.
- Route stability escrow was stable enough for `serve_readonly` and `torghut_observe`.
- `serve_readonly` was allowed.
- `torghut_observe` was allowed with max notional `0`.
- `dispatch_repair`, `dispatch_normal`, `deploy_widen`, and `merge_ready` were held by source rollout truth and
  controller witness reasons.
- `paper_canary` was held by forecast service degradation, source truth, Torghut consumer evidence, shadow-only capital,
  paper settlement, and Torghut live holds.
- `live_micro_canary` and `live_scale` were blocked with max notional `0`.

### Torghut Evidence Consumed By Jangar

- Torghut live and sim revisions were running, but Torghut proof floor remained `repair_only`.
- Torghut capital state was `zero_notional`.
- Torghut live submission gate was blocked by `simple_submit_disabled`.
- Torghut alpha readiness had 3 hypotheses and zero promotion-eligible hypotheses.
- Route TCA was incomplete for the current scoped universe and above the cost guardrail for several high-sample symbols.
- Empirical jobs were fresh in durable rows, but Torghut simulation progress/context rows were empty.
- Durable database rows did not match the full runtime hypothesis posture exposed by the API.

## Problem

Jangar is good at separating serving health from material action authority. The remaining gap is that Torghut evidence
is still consumed as broad proof-floor or consumer-evidence status. It does not yet arrive as a reconciled packet that
names contradictions between service witnesses and durable data.

That creates failure modes:

1. Healthy controller heartbeats can coexist with missing source rollout truth.
2. Fresh empirical rows can coexist with empty simulation context.
3. Fresh Jangar quant latest metrics can coexist with missing quant stage witnesses.
4. Runtime hypotheses can coexist with stale or incomplete durable hypothesis rows.
5. Kubernetes workflow failures can coexist with durable database success rows.
6. A large status payload can hide which contradiction actually blocks paper.

Jangar should not infer profit truth from any one of those surfaces. It should require Torghut to reconcile them and
then apply a simple action firewall.

## Alternatives Considered

### Option A: Keep Current Material Action Verdicts Only

Continue relying on source rollout truth exchange, route stability escrow, action SLO budgets, and Torghut proof-floor
status.

Advantages:

- Already implemented.
- Correctly blocks live capital today.
- Avoids adding another control-plane payload.

Disadvantages:

- Does not know whether Torghut's service and durable row witnesses agree.
- Treats `torghut_consumer_evidence_missing` as a broad reason instead of a typed source contradiction.
- Cannot distinguish fresh empirical jobs from executable route-local proof.

Decision: keep as the baseline, but not the next architecture boundary.

### Option B: Freeze All Material Actions Until Jangar Source Truth Is Complete

Hold every action except liveness until source head SHA, GitOps revision, controller witness, Torghut proof floor, and
database witnesses are all complete.

Advantages:

- Very conservative.
- Easy to audit.
- Prevents accidental capital movement.

Disadvantages:

- Blocks useful no-notional observation and repair.
- Conflates source rollout debt with trading proof debt.
- Provides no path for Torghut to retire evidence contradictions.

Decision: reserve for emergency mode, reject as steady state.

### Option C: Evidence-Reconciliation Broker And Capital Action Firewall

Consume Torghut's source-bound ledger, map contradictions to Jangar action classes, and keep action decisions
non-permissive until the contradictions are cleared.

Advantages:

- Reduces failure modes without freezing observation.
- Gives Jangar a compact, auditable contract from Torghut.
- Keeps serving and zero-notional repair available while capital remains closed.
- Prevents healthy Jangar infrastructure from upgrading stale trading evidence.
- Makes rollout behavior safer by binding material action widening to source-truth and evidence-reconciliation gates.

Disadvantages:

- Requires Torghut to publish a stable ledger schema.
- Adds one more broker to compare during rollout.
- Needs tests proving the broker never upgrades current action verdicts in shadow mode.

Decision: select Option C.

## Architecture

Jangar adds `evidence_reconciliation_broker` to the control-plane status payload in shadow mode:

```text
evidence_reconciliation_broker
  schema_version
  broker_id
  generated_at
  fresh_until
  namespace
  source_rollout_truth_ref
  controller_witness_ref
  route_stability_ref
  database_witness_ref
  torghut_ledger_ref
  contradiction_summary
  action_firewall_packets
  rollout_admission
  rollback_target
```

Each `action_firewall_packet` has:

```text
action_firewall_packet
  action_class
  baseline_decision
  broker_decision
  max_dispatches
  max_runtime_seconds
  max_notional
  required_source_witnesses
  required_torghut_witnesses
  contradiction_refs
  forbidden_shortcuts
  validation_commands
  rollout_gate
  rollback_gate
  expires_at
```

The broker is monotonic in shadow and enforcement mode. It can keep or reduce authority; it cannot upgrade authority
above the existing material action verdict.

## Action Firewall Rules

1. `serve_readonly` can remain allowed when serving, database, runtime kits, and route stability are healthy.
2. `torghut_observe` can remain allowed when max notional is zero and Torghut ledger contradictions are not live-capital
   contradictions.
3. `dispatch_repair` remains held while source rollout truth is missing or controller witness custody is split, even if
   Torghut ledger suggests a useful repair.
4. `dispatch_normal`, `deploy_widen`, and `merge_ready` remain held until source head or GitOps revision is present,
   controller witness is current, and no route-stability hold exists.
5. `paper_canary` remains held when Torghut ledger has any hold/block contradiction for selected route, hypothesis,
   simulation context, quant stage, TCA provenance, or Jangar custody.
6. `live_micro_canary` and `live_scale` remain blocked until paper settlement exists and Torghut ledger has no live
   contradiction.
7. Forecast degradation cannot be waived by healthy empirical rows.
8. Missing Torghut ledger is itself `torghut_consumer_evidence_missing`.

## Failure-Mode Reduction

The broker explicitly reduces these failure modes:

- Healthy Jangar serving cannot imply capital authority.
- Fresh empirical jobs cannot bypass empty simulation progress/context.
- Latest quant metrics cannot bypass missing stage witnesses.
- Recomputed TCA cannot bypass old execution source.
- Runtime hypothesis registry cannot bypass durable hypothesis-row disagreement.
- Kubernetes workflow failure cannot disappear when a durable table has no matching failure row.
- Source rollout truth gaps cannot be hidden by healthy controller heartbeats.

## Implementation Scope

Engineer stage should add:

- An additive `evidence_reconciliation_broker` reducer in the Jangar control-plane status path.
- A typed client/parser for Torghut's `source_bound_capital_admission_ledger`.
- Monotonic decision logic that never upgrades existing material action verdicts.
- Tests for missing ledger, ledger with hold contradictions, ledger with block contradictions, healthy Jangar plus
  degraded Torghut, and healthy ledger with source rollout truth missing.
- Metrics for broker decision counts and contradiction classes.

Deployer stage should verify:

- The broker appears in status in shadow mode.
- Existing material action verdicts are unchanged when the broker is present.
- Current evidence yields: `serve_readonly=allow`, `torghut_observe=allow`, material dispatch and merge held,
  `paper_canary=hold`, and live actions blocked.
- Broker packets cite the Torghut ledger ref and source rollout truth ref.

## Validation Gates

Local validation:

- Targeted Jangar control-plane status tests for the broker reducer.
- Type checks for the new status schema.
- Existing material action verdict tests remain green.

Cluster validation:

- `GET /health` remains HTTP 200.
- `GET /api/agents/control-plane/status?namespace=agents` includes the broker in shadow mode.
- Broker decisions are no more permissive than current material action verdicts.
- Jangar continues publishing NATS/Jangar status without runtime-kit regression.

Torghut integration validation:

- Missing Torghut ledger yields `torghut_consumer_evidence_missing`.
- Ledger with current source-bound contradictions holds paper and blocks live.
- Ledger with no contradictions still cannot bypass missing source rollout truth or controller witness gaps.

## Rollout

Roll out in four phases:

1. Add schema and reducer behind shadow output only.
2. Consume Torghut ledger when available, but emit decisions as diagnostics.
3. Compare broker decisions against existing material action verdicts for at least one scheduler cycle.
4. Enforce only if decisions are monotonic, no serving regressions occur, and Torghut ledger freshness stays within its
   declared window.

## Rollback

Rollback is to stop consuming Torghut ledger and remove the broker from enforcement. Existing material action verdicts,
route stability escrow, and source rollout truth exchange remain authority. Do not use rollback to allow paper or live
capital.

If the broker route or Torghut ledger times out, treat the ledger as missing and keep `torghut_consumer_evidence_missing`
as the hold/block reason.

## Risks

- The broker can duplicate existing material action logic. Keep it monotonic and contradiction-focused.
- Torghut ledger schema drift can break consumption. Version the schema and fail closed for paper/live.
- Too many contradiction classes can obscure the root cause. Summaries must rank by action class and route/hypothesis
  impact.
- Shadow output can be ignored. Deployer gates must compare broker decisions to existing verdicts before enforcement.

## Handoff

Engineer: implement the broker as an additive shadow reducer and prove monotonic action decisions with tests. It should
make current holds easier to explain, not change them.

Deployer: roll out shadow only, confirm current Jangar action posture remains unchanged, and wire the broker to Torghut
ledger refs only after the ledger route is stable. Capital remains zero-notional until Torghut ledger, proof floor,
route evidence, source rollout truth, and controller witness all agree.
