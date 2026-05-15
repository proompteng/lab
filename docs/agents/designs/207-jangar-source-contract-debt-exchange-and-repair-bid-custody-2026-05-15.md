# 207. Jangar Source-Contract Debt Exchange And Repair-Bid Custody (2026-05-15)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-15
Owner: Victor Chen, Jangar Engineering Architecture
Scope: Jangar ready truth, source-serving contract debt, repair-bid admission, Torghut route-warrant exchange,
zero-notional repair custody, validation, rollout, rollback, and cross-swarm handoff.

Companion Torghut contract:

- `docs/torghut/design-system/v6/213-torghut-repair-bid-settlement-ledger-and-route-warrant-runway-2026-05-15.md`

Extends:

- `206-jangar-material-evidence-settlement-spine-and-repair-dispatch-budget-2026-05-14.md`
- `205-jangar-controller-ingestion-settlement-and-verification-carry-cutover-2026-05-14.md`
- `200-jangar-revenue-repair-settlement-conveyor-and-stage-health-custody-2026-05-14.md`
- `188-jangar-ready-truth-arbiter-and-stage-credit-cutover-2026-05-13.md`
- `187-jangar-main-source-ci-retention-and-source-serving-verdicts-2026-05-13.md`
- `186-jangar-repair-bid-admission-and-settlement-custody-2026-05-13.md`

## Decision

I am selecting a **source-contract debt exchange with repair-bid custody** as the next Jangar control-plane
architecture increment.

The control plane is serving, but the material path is still held by a specific missing contract pair. On 2026-05-15
at 00:27Z, `deployment/agents`, `deployment/agents-controllers`, and `deployment/jangar` were successfully rolled out.
Argo reported `jangar=Synced/Healthy` and `torghut=Synced/Healthy`; `agents` was `OutOfSync/Healthy`. Jangar `/ready`
returned `status=ok`, leader election was active, and execution trust was healthy. That is good serving posture.

The same evidence says this is not merge, deploy, or Torghut repair authority. Full Jangar status reported
`ready_truth_arbiter.material_readiness=hold`. The merge and deploy receipts were held by
`source_serving_contract_missing:route_warrant_exchange`, `source_serving_contract_missing:repair_bid_settlement_ledger`,
`torghut_route_warrant_missing`, `repair_bid_settlement_ledger_missing`, repair-bid hold, stage-credit hold, route
stability hold, and source rollout truth hold. `controller_ingestion_settlement` was also `hold`: the controller
deployment, watch epoch, controller self-report, database, source SHA, serving commit, and image digests agreed, but
AgentRun ingestion remained unknown and source-serving stayed blocked by the same Torghut contracts.

The business surface points at the same gap. Torghut `/trading/revenue-repair` returned `business_state=repair_only`,
`revenue_ready=false`, top queue `repair_alpha_readiness`, value gate `routeable_candidate_count`, and
`max_notional=0`. The selected lane was `H-MICRO-01` under the alpha-readiness settlement conveyor. It recorded
`settlement_state=no_delta`, `routeable_candidate_count_before=0`, `routeable_candidate_count_after=0`, measured delta
`0`, and active no-delta leases. Jangar is correctly holding broad work, but it does not yet expose one compact debt
exchange that says which missing contract must be funded next and how duplicate repair launches are denied.

The selected design adds one Jangar authority object:
`jangar.source-contract-debt-exchange.v1`. It consumes ready truth, source-serving verdicts, repair-bid admission,
controller-ingestion settlement, Torghut revenue repair, Torghut consumer evidence, Argo rollout status, and database
application witnesses. It produces contract debt lots for missing source-serving contracts and one custody decision for
each material action class. The first implementation slice must fund exactly two debts: `route_warrant_exchange` and
`repair_bid_settlement_ledger`. Everything remains zero notional.

The tradeoff is deliberate. This adds another reducer instead of launching another repair run. I accept that cost
because the live blocker is no longer generic readiness. It is missing source-serving contracts that make every
operator compare several large payloads by hand. The debt exchange turns that comparison into a bounded contract with
clear acceptance gates.

## Governing Runtime Requirements

This contract implements the active swarm validation contract:

- every run must cite the governing design or runtime requirement before changing code;
- implement stages must produce production PRs with tests or report the exact blocker to code;
- verify stages must merge only green PRs and prove Argo, workload readiness, and service health after rollout;
- final handoff must name the control-plane metric improved or the smallest blocker preventing improvement.

Jangar value-gate mapping:

- `failed_agentrun_rate`: deny broad dispatch while the missing contract pair is unchanged and launch only one bounded
  zero-notional repair-bid custody run.
- `pr_to_rollout_latency`: make source-to-live and Argo state part of the debt exchange so deployers do not infer
  rollout readiness from pod readiness alone.
- `ready_status_truth`: preserve `/ready.status=ok` as serving truth while material action authority stays tied to
  settled contract debts.
- `manual_intervention_count`: replace hand comparison of ready truth, source-serving verdicts, repair-bid admission,
  revenue repair, and Torghut consumer evidence with one exchange packet.
- `handoff_evidence_quality`: require engineer and deployer handoffs to cite debt exchange id, selected debt lot,
  validation commands, rollback target, and Torghut top queue evidence.

Torghut value-gate mapping:

- `routeable_candidate_count`: the first debt lot must fund route warrant and repair-bid settlement evidence for the
  top alpha-readiness lane before any unrelated route work is admitted.
- `zero_notional_or_stale_evidence_rate`: stale or missing contract refs are explicit no-delta preservation evidence.
- `fill_tca_or_slippage_quality`: TCA work remains downstream until the route warrant names a routeable candidate set.
- `post_cost_daily_net_pnl`: no paper or live capital follows from this design.
- `capital_gate_safety`: every selected lot carries `max_notional=0`, and nonzero notional blocks the exchange.

## Current Evidence

All evidence below was collected read-only on 2026-05-15. I did not mutate Kubernetes resources, database records,
GitOps resources, AgentRuns, trading flags, broker state, or market data.

### Cluster, Rollout, And Events

- `kubectl rollout status deployment/agents -n agents`, `deployment/agents-controllers -n agents`, and
  `deployment/jangar -n jangar` all completed successfully.
- `kubectl get deployments -n agents` showed `agents=1/1` on
  `registry.ide-newton.ts.net/lab/jangar-control-plane:4947b00e@sha256:59ceafa...d348` and
  `agents-controllers=2/2` on `registry.ide-newton.ts.net/lab/jangar:4947b00e@sha256:03bcb2...44b`.
- `kubectl get deployments -n jangar` showed `jangar=1/1` on
  `registry.ide-newton.ts.net/lab/jangar:daa3db54@sha256:d1041f...16773`.
- Argo reported `agents=OutOfSync/Healthy`, `jangar=Synced/Healthy`, and `torghut=Synced/Healthy` at revision
  `ff98e82146135c9a592eee4c3676da47c2e83477`.
- The last-day Jangar/Torghut AgentRun sample had `105` runs: `86` succeeded, `15` failed, and `4` were running.
- Recent `agents` events included readiness probe timeouts on `agents` and `agents-controllers`, `BackoffLimitExceeded`
  for Jangar and Torghut verify jobs, and scheduling pressure for plan and market-context jobs.

### Jangar Control-Plane Evidence

- `GET http://agents.agents.svc.cluster.local/ready` returned `status=ok`, leader election active, and execution trust
  healthy. A later ready read also showed Torghut consumer evidence unavailable, which confirms the hot path is still
  volatile.
- Full status at 00:27Z reported database `healthy`, latency `541ms`, `registered_count=29`, `applied_count=29`,
  `unapplied_count=0`, and latest migration
  `20260508_torghut_quant_pipeline_health_account_window_created_at_index`.
- `controller_ingestion_settlement.decision=hold`. Deployment, watch epoch, controller self-report, source SHA,
  serving build commit, manifest digest, serving digest, execution trust, and database were current. The remaining
  reasons were `agentrun_ingestion_unknown`, `source_serving_block`,
  `source_serving_contract_missing:route_warrant_exchange`,
  `source_serving_contract_missing:repair_bid_settlement_ledger`, `torghut_route_warrant_missing`, and
  `repair_bid_settlement_ledger_missing`.
- `ready_truth_arbiter.material_readiness=hold`, with `serve_readonly` and `torghut_observe` allowed, repair, normal
  dispatch, deploy, merge, and paper canary held, and live micro/live scale blocked.
- `repair_bid_admission.status=block` on ready because Torghut repair-bid settlement was missing or not current.

### Torghut Business Evidence

- `/trading/revenue-repair` returned `business_state=repair_only`, `revenue_ready=false`, and top queue
  `repair_alpha_readiness` with value gate `routeable_candidate_count`, required output
  `torghut.executable-alpha-receipts.v1`, and `max_notional=0`.
- The alpha-readiness conveyor selected `H-MICRO-01`, candidate `chip-paper-microbar-composite@execution-proof`,
  strategy `microbar_volume_continuation_long_top2_chip_v1@paper`, and lane `microstructure-breakout`.
- The conveyor state was `no_delta`; routeable candidate count stayed `0 -> 0`, and active no-delta leases denied
  repeat launch until source ref, evidence window, blocker set, or required receipt set changes.
- `/trading/consumer-evidence` returned a compact alpha-readiness conveyor ref, but `route_warrant_state`,
  `repair_bid_settlement_status`, routeability aggregate state, and profit freshness state were null in the sampled
  response.

### Database And Data Evidence

- Direct CNPG list and psql are blocked for this worker identity:
  `clusters.postgresql.cnpg.io is forbidden` and `pods "jangar-db-1" is forbidden ... cannot create resource "pods/exec"`.
  That is acceptable least privilege for architecture assessment.
- Jangar application status still proves the database path through the service: connected, migration-consistent, and
  current at the latest registered migration.
- Torghut `/db-check` returned `ok=true`, `schema_current=true`, and `schema_graph_lineage_ready=true`.
- The architecture must therefore trust application-level DB and schema witnesses, not require swarm workers to exec
  into databases.

### Source And Test Surface

- High-risk Jangar files are `control-plane-status.ts` at `794` lines, `control-plane-ready-truth-arbiter.ts` at `506`
  lines, `control-plane-source-serving-contract-verdict.ts` at `467` lines,
  `control-plane-repair-bid-admission.ts` at `461` lines,
  `control-plane-revenue-repair-settlement-custody.ts` at `412` lines,
  `control-plane-controller-ingestion-settlement.ts` at `321` lines, and `routes/ready.tsx` at `613` lines.
- Matching tests exist for ready truth, source-serving verdicts, repair-bid admission, revenue-repair custody,
  controller-ingestion settlement, and full status assembly.
- The missing test family is source-contract debt exchange: missing contract lot creation, unchanged lot dedupe,
  nonzero-notional block, single repair lot selection, merge/deploy hold, and ready hot-path projection.

## Problem

Jangar now has enough evidence to hold unsafe work, but it does not yet give implementers the smallest useful next
debt to clear. The missing contracts are specific, repeated, and business-relevant. They should not be buried as
reason codes inside several status surfaces.

The concrete failure modes are:

1. `/ready.status=ok` can be misread as material action readiness when ready truth is holding deploy and merge.
2. `agents=OutOfSync/Healthy` can coexist with rolled-out deployments, which makes source-to-serving readiness easy to
   overstate.
3. `controller_ingestion_settlement` can prove most controller witnesses current while source-serving remains blocked.
4. `repair_bid_admission` blocks on missing Torghut settlement, but Jangar does not yet convert that into a selected
   debt lot with custody.
5. Torghut no-delta leases correctly deny duplicate alpha repair, but Jangar lacks a contract-level exchange that
   funds the missing route warrant and repair-bid settlement receipts.
6. Failed AgentRuns continue to accumulate while broad runs are cheaper to launch than targeted contract debt repair.

## Alternatives Considered

### Option A: Keep Existing Gates And Let Engineers Read Reason Codes

Jangar would keep ready truth, source-serving verdicts, repair-bid admission, and controller-ingestion settlement as
separate authorities. Engineers would read the reason codes and infer the next implementation milestone.

Advantages:

- No new reducer.
- Existing tests remain untouched.
- No schema coordination with Torghut.

Disadvantages:

- Keeps manual synthesis in the hot path.
- Does not suppress duplicate contract-debt repair attempts.
- Does not produce a single acceptance contract for engineer or deployer stages.
- Does not improve the current missing contract pair.

Decision: reject. The reason codes are precise enough to become a contract.

### Option B: Freeze All Material Actions Until Torghut Emits Every Missing Contract

Jangar would block dispatch, deploy, merge, paper, and live actions until Torghut publishes route warrant and
repair-bid settlement evidence with no missing fields.

Advantages:

- Strong safety posture.
- Simple to explain.
- Reduces duplicate broad work.

Disadvantages:

- Blocks the zero-notional implementation work needed to produce the missing contracts.
- Turns a bounded software gap into manual intervention.
- Does not tell Torghut which receipt Jangar will accept first.
- Increases PR-to-rollout latency because deployers still have to inspect multiple surfaces.

Decision: reject as steady state. Keep contradiction or nonzero-notional cases as hard blocks.

### Option C: Source-Contract Debt Exchange With Repair-Bid Custody

Jangar emits a compact exchange that materializes missing source-serving contracts as debt lots. It admits one bounded
zero-notional repair lot only when the lot directly funds `route_warrant_exchange` or
`repair_bid_settlement_ledger` for the live top Torghut repair queue.

Advantages:

- Targets the actual live blocker.
- Preserves serving health while tightening material authority.
- Gives Torghut a stable import target for route warrant and repair-bid settlement refs.
- Converts no-delta repetition into launch-deny evidence.
- Makes engineer and deployer handoffs testable.

Disadvantages:

- Adds one reducer and one companion Torghut export contract.
- Requires stable naming for contract refs.
- Initially holds some useful work until the exchange is emitted.

Decision: select Option C.

## Architecture

Jangar adds `jangar.source-contract-debt-exchange.v1` to full status and a compact projection to `/ready`.

```yaml
schema_version: jangar.source-contract-debt-exchange.v1
mode: shadow|observe|enforce
exchange_id: source-contract-debt-exchange:<namespace>:<digest>
generated_at: <iso8601>
fresh_until: <iso8601>
namespace: agents
serving_readiness: ok|degraded|unavailable
material_readiness: allow|repair_only|hold|block
source_serving_verdict_ref: <source-serving exchange id>
repair_bid_admission_ref: <repair-bid admission receipt id>
controller_ingestion_settlement_ref: <controller-ingestion settlement id>
torghut_revenue_repair_ref: <digest or receipt id>
top_repair_queue_code: repair_alpha_readiness|null
selected_value_gate: routeable_candidate_count|null
max_notional: '0'
contract_debts:
  - contract_name: route_warrant_exchange
    state: missing|stale|current|contradicted
    owner_plane: torghut
    value_gates: [routeable_candidate_count, ready_status_truth]
    required_output_receipt: torghut.route-warrant-exchange.v1
    selected: true
    dedupe_key: <stable hash over top queue, lane, source refs, and missing contract>
    validation_commands: []
  - contract_name: repair_bid_settlement_ledger
    state: missing|stale|current|contradicted
    owner_plane: torghut
    value_gates: [failed_agentrun_rate, routeable_candidate_count]
    required_output_receipt: torghut.repair-bid-settlement-ledger.v1
    selected: true|false
    dedupe_key: <stable hash>
action_decisions:
  serve_readonly: allow
  torghut_observe: allow
  dispatch_repair: allow|hold|block
  dispatch_normal: hold|block
  deploy_widen: hold|block
  merge_ready: hold|block
  paper_canary: hold|block
  live_micro_canary: block
  live_scale: block
reason_codes: []
rollback_target: JANGAR_SOURCE_CONTRACT_DEBT_EXCHANGE_MODE=observe
```

Decision rules:

- If any selected debt has nonzero notional, contradictory source-serving evidence, or live capital widening, the
  exchange is `block`.
- If `route_warrant_exchange` or `repair_bid_settlement_ledger` is missing for the live top queue, `dispatch_repair`
  is allowed only for a single zero-notional repair lot that produces one of those receipts.
- If the selected lot's dedupe key is unchanged and a no-delta lease is active, all repeat repair launches are denied
  until source ref, evidence window, blocker set, or required receipt set changes.
- `dispatch_normal`, `deploy_widen`, `merge_ready`, `paper_canary`, `live_micro_canary`, and `live_scale` remain held
  or blocked until both contracts are current and ready truth is not holding material readiness.
- `/ready` exposes only the compact exchange id, material readiness, selected debt names, and reason codes. Full
  receipts stay on the full status route.

## Rollout Plan

1. Shadow emit the exchange in full Jangar status from existing ready truth, source-serving verdict, repair-bid
   admission, controller-ingestion settlement, and Torghut evidence.
2. Add a compact `/ready` projection after full status tests prove the selected debt names and decisions are stable.
3. Wire `dispatch_repair` admission to read the exchange in observe mode. In observe mode it reports the intended
   decision without preventing existing launch paths.
4. Switch to enforce only after Torghut emits current `route_warrant_exchange` and
   `repair_bid_settlement_ledger` refs in consumer evidence and Jangar tests prove unchanged no-delta dedupe.
5. Deployer verifies Argo, workload rollout, `/ready`, full status, and Torghut revenue repair before calling the
   rollout healthy.

## Validation Gates

Required local checks for the first implementation PR:

- `bun run --filter @proompteng/jangar test -- services/jangar/src/server/__tests__/control-plane-source-contract-debt-exchange.test.ts`
- `bun run --filter @proompteng/jangar test -- services/jangar/src/server/__tests__/control-plane-status.test.ts -t "source contract debt"`
- `bunx oxfmt --check services/jangar/src/server services/jangar/src/routes`

Required live validation after rollout:

- `curl -fsS http://agents.agents.svc.cluster.local/ready | jq '.source_contract_debt_exchange'`
- `curl -fsS 'http://agents.agents.svc.cluster.local/api/agents/control-plane/status?namespace=agents' | jq '.source_contract_debt_exchange,.ready_truth_arbiter.merge_gate_receipt'`
- `curl -fsS http://torghut.torghut.svc.cluster.local/trading/revenue-repair | jq '.repair_queue[0],.alpha_readiness_settlement_conveyor'`
- `curl -fsS http://torghut.torghut.svc.cluster.local/trading/consumer-evidence | jq '.route_warrant_id,.repair_bid_settlement_ledger_id,.max_notional'`

Acceptance gates:

- The exchange selects `route_warrant_exchange` or `repair_bid_settlement_ledger` as the only repair debts.
- `serve_readonly` and `torghut_observe` remain allowed.
- `dispatch_repair` is allowed only for one zero-notional selected lot.
- `dispatch_normal`, deploy, merge, paper, and live actions remain held or blocked while either contract is missing.
- An unchanged no-delta release key denies repeat launch.
- Ready truth no longer requires a human to infer the missing contract pair from scattered reason codes.

## Rollback

Rollback is configuration-only for the first slice:

- Set `JANGAR_SOURCE_CONTRACT_DEBT_EXCHANGE_MODE=observe`.
- Ignore `source_contract_debt_exchange` consumers and fall back to ready truth, source-serving verdicts, repair-bid
  admission, and stage credit.
- Keep Torghut `max_notional=0`.
- Do not delete historical exchange receipts; they are audit evidence for failed AgentRun and handoff analysis.

## Risks

- False repair admission: mitigated by zero notional, single-lot custody, and nonzero-notional hard block.
- Schema drift between Jangar and Torghut contract names: mitigated by explicit `required_output_receipt` names and
  compatibility tests.
- Hot-path payload growth: mitigated by compact `/ready` projection and full receipt on status only.
- Over-holding useful work: accepted until the missing contract pair is current because broad work is currently less
  valuable than retiring the authority split.

## Engineer Handoff

Implement the first production slice in this order:

1. Add `buildSourceContractDebtExchange` in Jangar, plus tests for missing contract lots, dedupe, nonzero-notional
   block, and action decisions.
2. Add the exchange to full status and a compact projection to `/ready`.
3. Consume Torghut's companion `route_warrant_exchange` and `repair_bid_settlement_ledger` refs when present, but keep
   missing refs as explicit debts.
4. Keep mode in `shadow` or `observe`; do not enforce until deployer evidence proves the exchange is stable.

The implementation PR is complete when it reduces handoff ambiguity for `ready_status_truth` and
`manual_intervention_count` without widening capital or normal dispatch.

## Deployer Handoff

After the engineer PR merges and the image is promoted, verify:

- Argo `agents`, `jangar`, and `torghut` state;
- deployment rollout for `agents`, `agents-controllers`, and `jangar`;
- `/ready.status=ok`;
- `source_contract_debt_exchange` present with selected debts;
- `ready_truth_arbiter.merge_gate_receipt.decision` still held until both contracts are current;
- Torghut revenue repair still `repair_only` and `max_notional=0`.

Only call rollout healthy when the exchange proves the same missing contract pair seen before rollout or proves the
pair has been retired with current route warrant and repair-bid settlement refs.
