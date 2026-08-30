# 206. Jangar Consumer-Evidence Parity Settlement And Alpha Release Custody (2026-05-14)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-14
Owner: Victor Chen, Jangar Engineering Architecture
Scope: Jangar consumer-evidence parity settlement, Torghut alpha-release custody, AgentRun failure reduction,
rollout gating, validation, rollback, and cross-swarm handoff.

Companion Torghut contract:

- `docs/torghut/design-system/v6/212-torghut-consumer-evidence-parity-and-alpha-release-freshness-2026-05-14.md`

Extends:

- `205-jangar-controller-ingestion-settlement-and-verification-carry-cutover-2026-05-14.md`
- `docs/torghut/design-system/v6/211-torghut-controller-ingestion-carry-and-alpha-no-delta-release-2026-05-14.md`
- `201-jangar-verify-trust-foreclosure-and-alpha-repair-reentry-2026-05-14.md`
- `198-jangar-material-gate-digest-and-alpha-closure-carry-2026-05-14.md`
- `188-jangar-typed-torghut-evidence-admission-and-repair-dispatch-2026-05-13.md`
- `187-jangar-main-source-ci-retention-and-source-serving-verdicts-2026-05-13.md`

## Decision

I am selecting a **consumer-evidence parity settlement** as the next Jangar control-plane architecture increment.

The prior controller-ingestion design is now live enough to expose the next failure mode. On 2026-05-14 between
20:08Z and 20:11Z, `/ready` returned `status=ok`, leader election was active, rollout proof cells were fresh, and the
serving process was healthy. The same payload reported `business_state=repair_only`, `revenue_ready=false`, top repair
`repair_alpha_readiness`, value gate `routeable_candidate_count`, and accepted routeable candidates at `0`.

Full Jangar status was more specific. It reported database health as `healthy`, migration consistency as
`29/29 applied`, rollout health as `2 configured deployment(s) healthy`, and a current
`controller_ingestion_settlement`. That settlement was `decision=hold`, with
`agentrun_ingestion_current=false`, `source_serving_status=block`, and
`torghut_verification_carry_status=unavailable`. It also had the right governing design refs and a bounded
zero-notional rollback target.

Torghut then showed why another broad repair launch would be waste. Direct `/trading/revenue-repair` reported
`business_state=repair_only`, `readyz_status=degraded`, active revision `torghut-00415`, selected lane `H-MICRO-01`,
`routeable_candidate_count_before=0`, `routeable_candidate_count_after=0`, and
`jangar_controller_ingestion_carry.carry_state=lagging` with a non-null Jangar settlement ref. The Jangar-facing
`/trading/consumer-evidence` compact path, sampled in the same window, could still surface
`jangar_controller_ingestion_carry.carry_state=unavailable` with `source_jangar_settlement_ref=null`.

That split is the control-plane problem. Jangar consumes Torghut through the consumer-evidence boundary, not through
operator memory of the richer revenue-repair digest. If the compact boundary lags, drops refs, or normalizes a lagging
state to unavailable, stage clearance and material gates can hold for the wrong reason, or worse, can admit a duplicate
repair after the no-delta key has already proven no routeable-candidate movement.

The selected design adds `jangar.consumer-evidence-parity-settlement.v1`. It compares the Jangar-facing
consumer-evidence payload, the direct Torghut revenue-repair digest when reachable, and Jangar's local
controller-ingestion settlement. It produces one material action decision:

- `allow` only when the consumer-evidence compact refs agree with direct revenue repair and the Jangar settlement is
  current;
- `repair_only` when a bounded projection refresh or carry-sync repair can make parity current without paper or live
  notional;
- `hold` when serving is healthy but parity is lagging, stale, or missing enough refs to make the top repair unsafe;
- `block` when the surfaces contradict each other, report nonzero notional, or would admit alpha repair against an
  unchanged no-delta release key.

The tradeoff is stricter admission while projections converge. I accept that because the business metric is fewer
failed AgentRuns and shorter green PR-to-healthy GitOps rollout time. A repair runner that starts from stale compact
evidence is not progress; it is failure debt with a new timestamp.

## Governing Runtime Requirements

This contract implements the active swarm validation contract:

- every run must cite the governing design or runtime requirement before changing code;
- implement stages must produce production PRs with tests or report the exact blocker to code;
- verify stages must merge only green PRs and prove Argo, workload readiness, and service health after rollout;
- final handoff must name the control-plane metric improved or the smallest blocker preventing improvement.

Value-gate mapping:

- `failed_agentrun_rate`: deny duplicate alpha repair and broad dispatch while consumer evidence and revenue repair
  disagree about carry state, no-delta release key, selected lane, or routeable-candidate count.
- `pr_to_rollout_latency`: make source-to-live and projection-to-consumer lag visible as one parity packet instead of
  forcing deployers to compare `/ready`, full status, `/trading/revenue-repair`, and `/trading/consumer-evidence`.
- `ready_status_truth`: preserve `/ready.status=ok` as serving truth while material actions cite parity truth.
- `manual_intervention_count`: replace manual endpoint diffing with a reducer that names the stale or missing ref.
- `handoff_evidence_quality`: require engineer and deployer handoffs to cite parity settlement id, compared refs,
  selected value gate, decision, validation commands, and rollback target.

Torghut value-gate mapping:

- `routeable_candidate_count`: the top alpha-readiness lane remains the objective, but it can only relaunch after
  parity proves the current no-delta key and selected H-MICRO evidence window are the same on both surfaces.
- `zero_notional_or_stale_evidence_rate`: stale compact evidence becomes first-class repair debt.
- `fill_tca_or_slippage_quality`: TCA repair remains lower priority unless parity proves the alpha lane released it.
- `post_cost_daily_net_pnl`: no paper or live widening follows from parity alone.
- `capital_gate_safety`: every selected repair remains `max_notional=0`.

## Current Evidence

All evidence below was collected read-only on 2026-05-14. I did not mutate Kubernetes resources, database rows,
GitOps resources, AgentRuns, trading flags, broker state, or market data.

### Cluster, Rollout, And Events

- Argo reported `agents`, `jangar`, and `symphony-jangar` as `Synced/Healthy`. `torghut` was `OutOfSync/Healthy`
  during the initial sweep while newer `torghut-00415` Knative revisions were rolling.
- The agents namespace deployments were ready: `agents=1/1`, `agents-controllers=2/2`, both running images built from
  commit `2fa5bf6d4ff92c1d11303c916d50e817e0008762`.
- The Jangar namespace deployment `jangar=1/1` and `symphony-jangar=1/1` were ready.
- The Torghut namespace had `torghut-00415-deployment=1/1` and `torghut-sim-00510-deployment=1/1` after revision
  rollout; older revisions were scaled down.
- The agents namespace still carried material failure debt: `132` failed AgentRuns, `723` succeeded AgentRuns,
  `11` pending, `6` running, and one unknown in the current list. Current pod summaries showed Jangar/Torghut plan
  and verify lanes with recent Error and OOMKilled pods.
- Events in `agents` and `torghut` showed normal rollouts, but also transient readiness failures during rollout and
  `BackoffLimitExceeded` for a Torghut market-context fundamentals job.

### Jangar Control-Plane Evidence

- `/ready` returned `status=ok`, `business_state=repair_only`, `revenue_ready=false`, top repair
  `repair_alpha_readiness`, affected value gate `routeable_candidate_count`, and Torghut consumer evidence marked
  `current`.
- `/ready.torghut_consumer_evidence` still reported accepted routeable candidates as `0`, routeability state
  `blocked`, evidence-clock state `split`, and evidence-clock custody `missing`.
- Full status reported database `healthy`, `latency_ms=3`, migration consistency `registered_count=29`,
  `applied_count=29`, `unapplied_count=0`, and `unexpected_count=0`.
- Full status reported rollout health `healthy` for `agents` and `agents-controllers`.
- `controller_ingestion_settlement` existed and was `decision=hold`. It had `deployment_available=true`,
  `watch_epoch_current=true`, `controller_self_report_current=true`, `agentrun_ingestion_current=false`,
  `execution_trust_status=healthy`, `database_status=healthy`, `source_serving_status=block`, and
  `torghut_verification_carry_status=unavailable`.
- `verify_trust_foreclosure_board.alpha_repair_reentry_admission.decision=deny`.
- `repair_slot_escrow.status=block`, with a blocked slot caused by
  `selected_receipt_source_revenue_repair_ref_mismatch`,
  `material_reentry_receipt_missing_for_selected_executable_alpha`, and active no-delta debt.
- `material_gate_digest.material_readiness=repair_only`, and `dispatch_repair` was denied because alpha closure
  no-delta budget was consumed and no-delta debt was active.

### Torghut Business And Data Evidence

- Direct `/trading/revenue-repair` returned `business_state=repair_only`, `revenue_ready=false`,
  `readyz_status=degraded`, active revision `torghut-00415`, and operating rule
  `keep_live_submit_disabled_until_repair_queue_clears`.
- The top repair was `repair_alpha_readiness`, reason `hypothesis_not_promotion_eligible`, value gate
  `routeable_candidate_count`, required output `torghut.executable-alpha-receipts.v1`, and `max_notional=0`.
- `routeability_acceptance.accepted_routeable_candidate_count=0` and
  `route_evidence_clearinghouse.accepted_routeable_candidate_count=0`.
- `alpha_readiness_settlement_conveyor.status=no_delta`, selected lane `H-MICRO-01`, strategy
  `microbar_volume_continuation_long_top2_chip_v1@paper`, reason `drift_checks_missing`, measured routeable-candidate
  delta `0`, and required receipts including `feature_replay_receipt`, `drift_check_receipt`, and
  `required_feature_set_receipt`.
- Direct revenue repair reported `jangar_controller_ingestion_carry.carry_state=lagging`, a non-null
  `source_jangar_settlement_ref`, and reason codes including `agentrun_ingestion_unknown`,
  `source_serving_block`, and `torghut_verification_carry_unavailable`.
- The compact Jangar-facing consumer-evidence route could still report carry `unavailable` with
  `source_jangar_settlement_ref=null` in the same evidence window. That is the parity gap this design addresses.
- Torghut `/db-check` returned `ok=true`, `schema_current=true`, and `schema_graph_lineage_ready=true`.
- Direct CNPG cluster reads are correctly blocked for this worker:
  `clusters.postgresql.cnpg.io is forbidden` for both `jangar` and `torghut`. Database assessment therefore relies on
  application-level health and schema endpoints plus pod readiness, not privileged database inspection.

### Source And Test Surface

- Jangar currently has `70` top-level `control-plane*.ts` server modules and `36` matching server test files under
  `services/jangar/src/server/__tests__`.
- The new implementation surface is tightly bounded:
  - `services/jangar/src/server/control-plane-consumer-evidence-parity-settlement.ts` for the reducer;
  - `services/jangar/src/server/control-plane-status.ts` for full status projection;
  - `services/jangar/src/routes/ready.tsx` only for compact readback after full status proves stable;
  - `services/jangar/src/server/control-plane-status-types.ts` for typed status shape;
  - `services/jangar/src/server/__tests__/control-plane-consumer-evidence-parity-settlement.test.ts` and
    `control-plane-status.test.ts` for coverage.
- Torghut already has implementation and tests for the adjacent contracts:
  `test_jangar_controller_ingestion_carry.py`, `test_no_delta_repair_reentry_auction.py`,
  `test_alpha_readiness_settlement_conveyor.py`, `test_alpha_repair_dividend_ledger.py`, and
  `test_build_revenue_repair_digest.py`.
- The missing test family is cross-surface parity: compact consumer evidence current, compact lagging behind direct
  revenue repair, compact missing Jangar settlement ref, changed no-delta release key, stale compact TTL, and
  contradiction between compact and direct selected lane.

## Problem

The system now has the right individual claims, but it does not have a single admission object for whether the
Jangar-facing Torghut projection is the same truth as the direct Torghut business surface.

Concrete failure modes:

1. `/ready.status=ok` can be true while material actions are correctly held.
2. Full Jangar status can hold on `torghut_verification_carry_unavailable` while direct Torghut revenue repair has
   already classified the carry as `lagging` with a settlement ref.
3. Torghut can deny no-delta reentry from direct revenue repair while consumer evidence still lacks the refs Jangar
   needs to explain the denial.
4. Repair-slot escrow can block on source-revenue-repair ref mismatch without a first-class parity packet that names
   which endpoint or projection is stale.
5. Engineers can rerun alpha repair against an unchanged H-MICRO no-delta release key because the compact boundary did
   not carry the richer direct evidence.
6. Deployer handoffs can claim a green rollout while the Jangar business evidence surface still contains stale compact
   evidence.

The control plane needs to settle projection parity before it admits another material alpha repair or deploy-widening
action.

## Alternatives Considered

### Option A: Enforce Controller-Ingestion Settlement Immediately

This option promotes `controller_ingestion_settlement` from observe mode to an admission gate and leaves Torghut
consumer-evidence parity to later.

Advantages:

- Uses a reducer that already exists.
- Directly addresses AgentRun ingestion and source-serving hold.
- Gives a simple operator rule: no broad work unless the settlement allows it.

Disadvantages:

- It does not explain why direct revenue repair and consumer evidence disagree.
- It can hold on `torghut_verification_carry_unavailable` after direct Torghut has already advanced to `lagging`.
- It risks hardening a stale compact projection into a runtime gate.
- It does not tell Torghut whether the next useful zero-notional action is projection refresh or H-MICRO feature
  replay.

Decision: reject as the next architecture increment. Controller-ingestion remains a dependency, not the final gate.

### Option B: Launch H-MICRO Feature Replay As The Next Repair

This option treats `drift_checks_missing` and missing feature-set evidence as the next revenue repair and asks
engineers to fund `feature_replay_receipt`, `drift_check_receipt`, and `required_feature_set_receipt` for H-MICRO.

Advantages:

- It targets the top business value gate directly.
- It is the path most likely to increase `routeable_candidate_count`.
- It uses current Torghut lane scoring.

Disadvantages:

- The active no-delta release key says repeated launch is denied.
- It does not reduce failed AgentRuns if the compact consumer projection remains stale.
- It can spend repair capacity before Jangar and Torghut agree on the selected lane and release key.
- It weakens the "every run cites governing design or runtime requirement" contract because the consumer boundary
  would still be ambiguous.

Decision: reject for immediate implementation. H-MICRO feature replay is the next bounded repair only after parity is
current or the parity reducer selects it as a changed release condition.

### Option C: Add Consumer-Evidence Parity Settlement

This option adds a Jangar settlement that compares compact consumer evidence, direct revenue repair, and local
controller-ingestion settlement before stage clearance or material gates admit another alpha repair.

Advantages:

- Targets the live split directly.
- Preserves `/ready` as serving truth while giving material actions a stronger business-evidence truth source.
- Reduces failed AgentRuns by preventing duplicate no-delta repair launches from stale compact evidence.
- Gives deployers a single packet for projection lag and source-to-live lag.
- Creates a clean Torghut handoff: either refresh consumer evidence, or fund the H-MICRO feature replay after parity.

Disadvantages:

- Adds another reducer and test surface.
- Requires careful timeout and caching so `/ready` does not depend on a slow direct Torghut call.
- Keeps repair actions held when the system is serving but parity is stale.

Decision: select Option C.

## Architecture

### Contract Shape

Jangar adds an observe-first status object:

```yaml
schema_version: jangar.consumer-evidence-parity-settlement.v1
settlement_id: consumer-evidence-parity:<namespace>:<digest>
generated_at: <iso8601>
fresh_until: <iso8601>
namespace: agents
mode: observe|enforce
decision: allow|repair_only|hold|block
serving_readiness: ok|degraded|down
business_state: repair_only|ready|blocked|unknown
revenue_ready: true|false|null
selected_value_gate: routeable_candidate_count
selected_hypothesis_id: H-MICRO-01|null
consumer_evidence_ref: <torghut consumer evidence receipt/ref|null>
revenue_repair_ref: <torghut revenue repair digest ref|null>
controller_ingestion_settlement_ref: <jangar settlement ref|null>
consumer_carry_state: current|repairable|lagging|unavailable|stale|contradicted|unknown
revenue_carry_state: current|repairable|lagging|unavailable|stale|contradicted|unknown
consumer_no_delta_release_key: <key|null>
revenue_no_delta_release_key: <key|null>
consumer_routeable_candidate_count: <int|null>
revenue_routeable_candidate_count: <int|null>
parity_state: current|lagging|stale|missing|contradicted
selected_repair_ticket_class: none|consumer_evidence_projection_refresh|controller_ingestion|alpha_feature_replay
selected_repair_ticket_ref: <ref|null>
max_notional: '0'
reason_codes: []
validation_commands: []
rollback_target: <string>
```

The reducer must compare:

- selected value gate;
- selected hypothesis id;
- routeable candidate count before and after;
- no-delta release key;
- no-delta reentry decision;
- Jangar controller-ingestion settlement ref;
- Jangar carry state;
- verify-trust foreclosure board ref;
- repair-slot escrow ref;
- freshness and expiry windows;
- max notional.

### Decision Rules

`allow` requires all of the following:

- consumer evidence is fresh;
- direct revenue repair is fresh or explicitly unavailable with a cached last-good digest that has not expired;
- consumer and direct surfaces agree on selected value gate, selected hypothesis, no-delta release key, routeable
  candidate count, carry state, and max notional;
- Jangar controller-ingestion settlement is `allow` or `repair_only` with a selected zero-notional repair;
- material gate is not `block`.

`repair_only` is emitted when one bounded action can repair parity:

- compact consumer evidence is stale or missing a ref that direct revenue repair has;
- direct revenue repair and Jangar status agree that a projection refresh is enough;
- controller ingestion is the only stale witness and the selected ticket stays zero-notional.

`hold` is emitted when serving is healthy but the correct repair action is not attributable:

- consumer evidence and direct revenue repair disagree on carry state;
- consumer evidence lacks the Jangar settlement ref direct revenue repair has;
- source-serving status is block or hold while the direct Torghut digest has advanced;
- the no-delta release key is active and unchanged.

`block` is emitted when:

- any compared surface reports nonzero notional;
- selected hypothesis or value gate contradicts across fresh surfaces;
- direct revenue repair says no-delta deny while compact consumer evidence would select an alpha repair;
- freshness windows are expired on all compared surfaces.

### Runtime Placement

The first implementation should attach the settlement to full control-plane status only. `/ready` can expose a compact
parity ref after full status proves stable for one rollout. The full status route may call direct Torghut revenue repair
with a short timeout and must preserve the last known compact consumer evidence if the direct call is unavailable.

The hot `/ready` path must not become dependent on a slow direct Torghut fetch. The serving readiness contract remains
Kubernetes, runtime kits, leader election, memory provider, and existing hot-path Torghut consumer evidence. Material
actions use the parity settlement.

## Implementation Scope

Engineer milestone 1: Jangar parity reducer.

- Add `services/jangar/src/server/control-plane-consumer-evidence-parity-settlement.ts`.
- Add types in `services/jangar/src/server/control-plane-status-types.ts`.
- Unit-test allow, repair-only projection refresh, hold on compact/direct carry mismatch, hold on missing settlement
  ref, block on nonzero notional, and block on selected-hypothesis contradiction.
- Value gates: `failed_agentrun_rate`, `ready_status_truth`, `handoff_evidence_quality`.

Engineer milestone 2: Status projection and action packet.

- Attach the settlement to `services/jangar/src/server/control-plane-status.ts`.
- Feed settlement decision into material gate digest and repair-slot escrow as observe-mode evidence only.
- Add control-plane status tests proving the settlement cites design refs and validation commands.
- Value gates: `pr_to_rollout_latency`, `manual_intervention_count`, `handoff_evidence_quality`.

Engineer milestone 3: Torghut companion parity export.

- Consume `torghut.consumer-evidence-parity-ledger.v1` compact refs once Torghut exports them.
- Treat `consumer_evidence_projection_refresh` as the only selected repair when compact parity is stale.
- Value gates: `routeable_candidate_count`, `zero_notional_or_stale_evidence_rate`, `capital_gate_safety`.

## Validation Gates

Required local checks for the Jangar implementation PR:

```bash
bun run --filter jangar test -- services/jangar/src/server/__tests__/control-plane-consumer-evidence-parity-settlement.test.ts
bun run --filter jangar test -- services/jangar/src/server/__tests__/control-plane-status.test.ts
bunx oxfmt --check services/jangar/src/server/control-plane-consumer-evidence-parity-settlement.ts services/jangar/src/server/__tests__/control-plane-consumer-evidence-parity-settlement.test.ts services/jangar/src/server/control-plane-status-types.ts
```

Required rollout checks before deployer marks the implementation healthy:

```bash
kubectl get applications.argoproj.io -n argocd agents jangar torghut symphony-jangar
kubectl get deployments -n agents agents agents-controllers
curl -fsS 'http://agents.agents.svc.cluster.local/api/agents/control-plane/status?namespace=agents' | jq '.consumer_evidence_parity_settlement'
curl -fsS http://agents.agents.svc.cluster.local/ready | jq '{status,business_state,revenue_ready,top_repair_queue_item}'
curl -fsS http://torghut.torghut.svc.cluster.local/trading/revenue-repair | jq '{business_state,revenue_ready,jangar_controller_ingestion_carry,no_delta_repair_reentry_auction}'
curl -fsS http://torghut.torghut.svc.cluster.local/trading/consumer-evidence | jq '.consumer_evidence_parity_ledger'
```

Acceptance requires:

- parity settlement exists on full status;
- settlement cites this design and the Torghut companion design;
- `max_notional` remains `0`;
- `dispatch_repair` is not admitted while parity is `lagging`, `stale`, `missing`, or `contradicted`;
- if the selected ticket is `consumer_evidence_projection_refresh`, the handoff names the stale compact refs;
- if the selected ticket is `alpha_feature_replay`, the handoff proves the no-delta release key changed or was retired.

## Rollout Plan

1. Ship in observe mode on full status.
2. Verify status projection, unit tests, and Argo workload readiness.
3. Add compact `/ready` ref only after full status is stable for one healthy rollout.
4. Enable material-gate consumption in observe mode.
5. Consider enforcement only after two consecutive rollout windows show parity current or attributable repair-only.

## Rollback Plan

Rollback is configuration and consumer-level:

- ignore `consumer_evidence_parity_settlement` in material gate digest and repair-slot escrow;
- keep `/ready` serving semantics unchanged;
- keep controller-ingestion settlement, source-serving verdicts, repair-slot escrow, no-delta auction, and Torghut
  `max_notional=0` as the active safety boundaries;
- remove the direct revenue-repair comparison if it causes latency, while retaining compact consumer evidence.

Rollback success is:

- `/ready` still returns serving status;
- full status still returns controller-ingestion settlement;
- Torghut remains `repair_only`;
- no paper or live notional is enabled by the rollback.

## Risks And Mitigations

- Risk: direct Torghut revenue-repair fetch makes status slow. Mitigation: short timeout, cached last-known digest, and
  no dependency from `/ready`.
- Risk: parity reducer becomes another opaque gate. Mitigation: every reason code must include compared refs and a
  validation command.
- Risk: compact and direct surfaces intentionally differ. Mitigation: the Torghut companion contract defines which
  fields must be compact parity fields and which remain diagnostic only.
- Risk: engineers treat parity current as capital readiness. Mitigation: parity only proves projection truth;
  `routeable_candidate_count`, profit proof, capital gates, and `max_notional=0` remain separate.
- Risk: repeated hold states increase manual intervention. Mitigation: `repair_only` must name
  `consumer_evidence_projection_refresh` when a bounded projection repair is possible.

## Handoff Contract

Engineer handoff must include:

- governing design refs: this document and the Torghut companion;
- files changed and tests run;
- sample full-status parity payload;
- whether the selected ticket is projection refresh, controller ingestion, or alpha feature replay;
- whether `routeable_candidate_count` moved above `0`; if not, the smallest blocker.

Deployer handoff must include:

- PR URL and merge commit;
- Argo status for `agents`, `jangar`, `torghut`, and `symphony-jangar`;
- workload readiness for `agents`, `agents-controllers`, Jangar, and Torghut active revision;
- `/ready` serving result;
- full status parity result;
- Torghut revenue-repair result;
- rollback target.

The next bounded implementation milestone is Jangar milestone 1: add the parity reducer and full-status projection in
observe mode. It directly maps to `failed_agentrun_rate`, `ready_status_truth`, `manual_intervention_count`, and
`handoff_evidence_quality`.
