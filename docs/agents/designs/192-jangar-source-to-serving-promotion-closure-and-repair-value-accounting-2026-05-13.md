# 192. Jangar Source-To-Serving Promotion Closure And Repair Value Accounting (2026-05-13)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-13
Owner: Victor Chen, Jangar Engineering Architecture
Scope: Jangar source-to-serving proof closure, rollout admission, projection authority, runner capacity, Torghut
zero-notional repair value accounting, validation, rollout, rollback, and cross-stage handoff.

Companion Torghut contract:

- `docs/torghut/design-system/v6/197-torghut-serving-promotion-closure-and-no-delta-repair-value-2026-05-13.md`

Extends:

- `docs/agents/designs/191-jangar-rollout-proof-passports-and-runner-capacity-futures-2026-05-13.md`
- `docs/agents/designs/190-jangar-projection-foreclosure-notary-and-stage-custody-repair-2026-05-13.md`
- `docs/agents/designs/187-jangar-main-source-ci-retention-and-source-serving-verdicts-2026-05-13.md`
- `docs/agents/designs/186-jangar-repair-bid-admission-and-settlement-custody-2026-05-13.md`
- `docs/torghut/design-system/v6/196-torghut-profit-carry-passports-and-repair-capacity-futures-2026-05-13.md`

## Decision

I am selecting a **promotion closure ledger with repair value accounting** as the next Jangar control-plane
architecture increment.

The system is not down. The read-only evidence on 2026-05-13 shows `agents` and `jangar` Argo applications
`Synced/Healthy` at revision `6f1aa11d5a128d7cb6e42aa4aeb67660a380d57e`, `torghut` `Synced/Healthy` at revision
`d4703334a83b3fa8933486f56491626580eab8b6`, `agents=1/1`, `agents-controllers=2/2`, `jangar=1/1`, and the current
Torghut live and sim revisions ready. Jangar `/ready` returns `status=ok`, execution trust is healthy, watch
reliability saw `1343` AgentRun watch events in the 15 minute window with zero errors, and all recovery warrants and
projection watermarks in the serving response are sealed or fresh.

The blocker is more specific: the proof chain from source to serving is still incomplete for material action. Jangar
control-plane status reports `source_serving_contract_verdict_exchange.status=block` with
`source_ci_retention_receipt_missing`, `source_serving_build_mismatch`, and `manifest_image_digest_missing`.
Projection foreclosure is also not clean: `17` authoritative claims, `5` grace claims, `62` stale-foreclosed claims,
`1` contradictory claim, and `1` missing receipt. Normal dispatch, repair dispatch, deploy widening, merge-ready, and
paper canary are held even while service health is green.

Torghut shows the same pattern from the trading side. `/trading/revenue-repair` reports `business_state=repair_only`,
`revenue_ready=false`, `32` raw repair bids compacted into `5` selected lots, `3` dispatchable lots, routeable count
`0`, and max notional `0`. The top executable repair class is the selected `quant_pipeline` lot, followed by
`feature_lineage` and `execution_tca`. The newer profit-carry passport source exists in the repository, but the live
Torghut image is still commit `cde296cccb517ae640900ee9d01a13004a1ec6c2`, so the live payload does not yet expose
`profit_carry_passport_ledger`.

The selected design creates a promotion closure ledger that joins those facts into one admission object. It does not
replace the existing passport, notary, repair-bid, or source-serving ledgers. It decides which missing proof closes the
next value gate, whether a repair lot is worth spending a runner on, and which receipt must appear before the action
can graduate.

The tradeoff is that Jangar will hold more work in the short term. I accept that. Launching into known source/serving
mismatch or into a repair lot with no value receipt is how we inflate failed AgentRuns and lengthen PR-to-healthy
rollout time.

## Governing Runtime Requirements

This design binds to the active Jangar validation contract:

- every run must cite the governing design or runtime requirement before changing code;
- implement stages must produce production PRs with tests or report the exact blocker to code;
- verify stages must merge only green PRs and prove Argo, workload readiness, and service health after rollout;
- final handoff must name the control-plane metric improved or the smallest blocker preventing improvement.

The milestones map to the required value gates:

- `failed_agentrun_rate`
- `pr_to_rollout_latency`
- `ready_status_truth`
- `manual_intervention_count`
- `handoff_evidence_quality`

## Read-Only Evidence Snapshot

All evidence in this pass was collected read-only on 2026-05-13. I did not mutate Kubernetes resources, database rows,
GitOps resources, AgentRuns, broker state, trading flags, or market data.

### Cluster, Rollout, And Events

- The working branch was `codex/swarm-jangar-control-plane-discover`, clean before edits and based on current
  `origin/main`.
- Kubernetes auth resolved to `system:serviceaccount:agents:agents-sa`; `kubectl config current-context` was unset,
  but namespace-scoped reads worked.
- Argo reported `agents` and `jangar` `Synced/Healthy` at revision
  `6f1aa11d5a128d7cb6e42aa4aeb67660a380d57e`.
- Argo reported `torghut` `Synced/Healthy` at revision `d4703334a83b3fa8933486f56491626580eab8b6`; the active
  service image reported commit `cde296cccb517ae640900ee9d01a13004a1ec6c2` and digest
  `sha256:90ac72f8bcdd8964dbca684e461e44daedbd143070f7d437ade6560c21a10db8`.
- Argo reported `torghut-options` `Synced/Healthy` at revision
  `6f1aa11d5a128d7cb6e42aa4aeb67660a380d57e`.
- `agents` deployments were ready: `agents=1/1`, `agents-controllers=2/2`, and `agents-alloy=1/1`.
- `jangar` deployments were ready: `jangar=1/1`, `bumba=1/1`, `symphony=1/1`, `symphony-jangar=1/1`, and
  `jangar-alloy=1/1`.
- Torghut serving was in a rolling state but available: `torghut-00364-deployment=1/1` and
  `torghut-sim-00462-deployment=1/1`; older `00363` and `00461` pods were terminating or scaled down.
- Recent `agents` events included an AgentRun job `FailedCreate` caused by `etcdserver: request timed out`, transient
  readiness probe timeouts on `agents` and `agents-controllers`, and successful scheduled Jangar and Torghut jobs.
- Recent Torghut events included expected rollout probe failures during revision startup, completed DB migration and
  backfill jobs, and successful Knative revision readiness for the latest live and sim revisions.
- Retained AgentRuns summarized to `612` Succeeded, `119` Failed, `11` Pending, `5` Running, and `12` Template.
- AgentRuns created in the last 24 hours summarized to `97` Succeeded, `10` Failed, and `5` Running. Jangar
  control-plane AgentRuns in the same window summarized to `47` Succeeded, `3` Failed, and `2` Running.

### Jangar Runtime And Source

- `http://agents.agents.svc.cluster.local/ready` returned `status=ok`. It also reported serving-process controllers
  disabled (`agentsController.enabled=false`, `started=false`), which is correct for the serving deployment but means
  `/ready=ok` is not controller authority by itself.
- The same payload reported Torghut consumer evidence `current`, decision `repair`, evidence clock `split`, custody
  `missing`, repair-bid settlement `current`, three dispatchable lots, routeable count `0`, and max notional `0`.
- Runtime admission is healthy for local execution proof: `4` admission passports, `6` recovery warrants,
  `38` runtime proof cells, and `11` projection watermarks were present; all warrants were `sealed` and all
  watermarks were `fresh`.
- Jangar control-plane status reported database `healthy`, connected, latest migration
  `20260508_torghut_quant_pipeline_health_account_window_created_at_index`, execution trust `healthy`, watch
  reliability `healthy`, and control-plane status latency around `483ms`.
- `ready_action_exchange.status=block` in observe mode. It allowed `serve_readonly` and `torghut_observe`, held
  `dispatch_repair`, `dispatch_normal`, `deploy_widen`, `merge_ready`, and `paper_canary`, and blocked
  `live_micro_canary` and `live_scale`.
- `source_serving_contract_verdict_exchange.status=block` with reason codes
  `source_ci_retention_receipt_missing`, `source_serving_build_mismatch`, and `manifest_image_digest_missing`.
- `projection_foreclosure_notary.decision=hold`; claim totals were `authoritative=17`, `grace=5`,
  `stale_foreclosed=62`, `contradictory=1`, `missing_receipt=1`.
- The status route does not yet emit the 191 design surfaces: `rollout_proof_passport`, `runner_capacity_future`, or
  `stage_launch_ticket`.
- High-risk source modules remain large and cross-cutting: `supporting-primitives-controller.ts` is `3347` lines,
  `agents-controller/index.ts` is `1827` lines, `control-plane-status.ts` is `790` lines,
  `control-plane-runtime-admission.ts` is `504` lines, and `control-plane-runtime-proof-surface.ts` is `396` lines.
- The source already has tests for runtime admission, runtime proof, source-serving contract verdicts, repair-bid
  admission, projection foreclosure, stage credit, and ready truth. The missing test family is promotion closure: one
  reducer must prove that source CI retention, manifest digest, serving image, projection notary, and repair value
  receipts agree before material action graduates.

### Database, Data Quality, And Freshness

- Jangar database status was healthy through the application route. Migrations were current at the latest Jangar
  migration named above.
- Direct CNPG object and database pod inspection were not required for this pass. The normal worker path should rely on
  application-level database witnesses and least-privilege status routes.
- Torghut `/db-check` returned `ok=true`, schema current, expected and current Alembic head
  `0031_autoresearch_candidate_spec_epoch_uniqueness`, no missing heads, no unexpected heads, and lineage ready.
- Torghut schema quality still carries known parent-fork warnings around historical migration branches
  `0010_execution_provenance_and_governance_trace` and `0015_whitepaper_workflow_tables`.
- Torghut `/readyz` returned HTTP `503` with `status=degraded`, but dependencies were specific: Postgres,
  ClickHouse, Alpaca, database schema, universe, readiness cache, empirical jobs, and DSPy runtime were OK.
- Torghut live submission was blocked by `simple_submit_disabled`; profitability proof floor was `repair_only`;
  capital state remained zero-notional; alpha readiness had three shadow hypotheses, zero promotion eligible, and
  three rollback required.
- `/trading/revenue-repair` reported `business_state=repair_only`, `revenue_ready=false`, `32` raw repair bids,
  `5` selected compacted lots, `3` dispatchable compacted lots, routeable count `0`, max notional `0`, and blockers
  `hypothesis_not_promotion_eligible` and `simple_submit_disabled`.
- `/trading/consumer-evidence` exposed `repair_bid_settlement_ledger`, but not `profit_carry_passport_ledger` in the
  live payload. The repository source contains `services/torghut/app/trading/profit_carry_passports.py`, which proves a
  source-to-serving closure gap rather than missing architecture intent.

## Problem

The control plane now has enough typed evidence to avoid broad outage conclusions, but it still lacks one closure
contract that answers:

1. Which source-to-serving proof is missing for material action?
2. Which stale or contradictory projection must be retired before the stage can use that proof?
3. Which Torghut zero-notional repair lot is worth runner capacity?
4. Which receipt proves the repair moved a value gate rather than creating another terminal run?

The concrete failure modes are:

- Service readiness is green while material action is held by source/manifest proof gaps.
- Runtime admission warrants are sealed for local execution proof, but they do not prove merged source, manifest image
  digest, Argo revision, and serving image parity.
- Torghut source has a new profit-carry passport reducer, but live endpoints do not yet expose that ledger.
- Repair-bid settlement correctly compacts raw bids, but Jangar has no value-accounting closure object for no-delta
  repairs.
- Stale projection counts remain visible, but the next bounded implementation milestone is not ranked against
  source-serving closure and Torghut repair value.
- Verify and deployer stages still have to read several ledgers to decide whether a green PR is actually healthy in
  GitOps.

## Alternatives Considered

### Option A: Wait For The Existing 191/196 Contracts To Roll Out

This path treats the current gaps as implementation backlog only. Engineers would implement rollout proof passports,
runner capacity futures, and Torghut profit-carry passports independently.

Advantages:

- No new contract.
- Keeps existing design sequence intact.
- Avoids another status payload.

Disadvantages:

- Does not rank the missing proof chain when live source and repo source diverge.
- Leaves deployers to decide whether source CI retention, manifest digest, serving build mismatch, or Torghut repair
  value is the next blocker.
- Does not create no-delta accounting for repair lots that run without retiring a reason code.

Decision: reject as the primary next step. The prior contracts are necessary, but they need a closure ledger to turn
multiple partial contracts into an execution order.

### Option B: Freeze Material Work Until Source-Serving Verdict Is Fully Green

This path blocks normal dispatch, deploy widening, merge-ready, and repair dispatch whenever source-serving verdicts
are blocked.

Advantages:

- Strong safety posture.
- Easy to explain during incidents.
- Prevents launches against known source/serving mismatch.

Disadvantages:

- Freezes useful zero-notional Torghut repair lots.
- Does not tell engineers which proof to produce first.
- Can increase manual intervention if every blocked action becomes a human triage task.
- Does not improve Torghut profitability because repair-only work is how route blockers are retired.

Decision: reject as the steady-state architecture. Keep it as an emergency brake.

### Option C: Promotion Closure Ledger With Repair Value Accounting

This selected path emits one Jangar closure ledger that consumes source-serving verdicts, runtime admission proof,
projection foreclosure, stage credit, repair-bid admission, Torghut repair settlement, and recent scheduler events. It
ranks closure lots by value-gate movement and requires one output receipt per lot.

Advantages:

- Directly targets `pr_to_rollout_latency` by naming the next source-to-serving proof to close.
- Directly targets `failed_agentrun_rate` by holding launches that cannot cite a closure receipt.
- Preserves zero-notional Torghut repair while refusing low-value or duplicate work.
- Gives deployer and verifier stages one object to cite.
- Makes no-delta repair attempts first-class evidence rather than hidden terminal debt.

Disadvantages:

- Adds one reducer and status object.
- Requires stable receipt naming between Jangar and Torghut.
- Can hold speculative repair work until it states expected value and falsification rules.

Decision: select Option C.

## Architecture

Jangar emits `promotion_closure_ledger`:

```text
promotion_closure_ledger
  schema_version = jangar.promotion-closure-ledger.v1
  ledger_id
  generated_at
  fresh_until
  repository
  source_sha
  live_serving_sha
  argo_revisions[]
  source_serving_verdict_ref
  rollout_proof_passport_ref
  runtime_admission_refs[]
  projection_foreclosure_notary_ref
  repair_bid_admission_ref
  torghut_repair_settlement_ref
  torghut_profit_carry_passport_ledger_ref
  closure_lots[]
  selected_lot_ids[]
  held_lot_ids[]
  decision = allow | repair_only | hold | block
  value_gate_impacts[]
  rollback_target
```

Each closure lot records:

```text
promotion_closure_lot
  lot_id
  lot_class
  target_value_gate
  priority
  source_refs[]
  expected_output_receipt
  expected_gate_delta
  action_class
  max_runtime_seconds
  max_notional = 0
  dedupe_key
  state = selected | held | active | settled | no_delta | expired
  reason_codes[]
  validation_commands[]
```

Initial `lot_class` values:

- `source_ci_retention`: close `source_ci_retention_receipt_missing` by binding a green check run set to the source
  SHA and PR.
- `manifest_digest`: close `manifest_image_digest_missing` by binding GitOps manifest SHA, image digest, and live pod
  image digest.
- `serving_build_parity`: close `source_serving_build_mismatch` by proving the live service image commit includes the
  source contract being consumed.
- `projection_retirement`: close stale or contradictory projection authority from the projection notary.
- `runner_capacity`: close recent scheduling, mount, image, or timeout constraints before material launch.
- `torghut_repair_value`: launch only the selected zero-notional repair lot whose expected output receipt can retire a
  Torghut blocker.
- `no_delta_repair_accounting`: demote repeated repair attempts that did not produce their required receipt.

## Policy

- `serve_readonly` can remain available when the service, database, and serving recovery warrant are healthy.
- `torghut_observe` can remain available when Torghut endpoints are reachable and max notional is `0`.
- `dispatch_repair` requires a selected `torghut_repair_value` lot, a current repair-bid settlement ledger, and a
  matching expected output receipt.
- `dispatch_normal`, `deploy_widen`, and `merge_ready` require source CI retention, manifest digest, serving build
  parity, projection authority, and runner capacity lots to be settled or explicitly non-material.
- `paper_canary`, `live_micro_canary`, and `live_scale` remain blocked unless a later capital contract proves paper or
  live readiness. This design does not open capital.
- A repair lot that runs and does not produce its expected receipt becomes `no_delta` and loses priority until a new
  evidence tuple changes.
- A green Argo app is necessary but never sufficient for material launch if the closure ledger is `hold` or `block`.

## Implementation Milestones

### Milestone 1: Closure Ledger Read Model

Value gates: `ready_status_truth`, `handoff_evidence_quality`.

- Add `control-plane-promotion-closure-ledger.ts` as a pure Jangar reducer.
- Consume existing source-serving verdict, runtime admission, projection notary, repair-bid admission, Torghut
  consumer evidence, and recent event summaries.
- Emit `promotion_closure_ledger` on `/api/agents/control-plane/status`.
- Tests cover missing source CI retention, manifest digest missing, serving build mismatch, stale projection hold, and
  current serving-only allow.

### Milestone 2: Source, Manifest, And Image Receipts

Value gates: `pr_to_rollout_latency`, `ready_status_truth`.

- Define `jangar.source-ci-retention-receipt.v1`, `jangar.manifest-image-digest-receipt.v1`, and
  `jangar.serving-build-parity-receipt.v1`.
- Close source-serving reasons only when the receipt references source SHA, PR or merge SHA, Argo revision, and live
  image digest.
- Add tests for source ahead of serving, serving ahead of source, and digest mismatch.

### Milestone 3: Repair Value And No-Delta Accounting

Value gates: `failed_agentrun_rate`, `manual_intervention_count`.

- Bind Jangar repair-bid admission tickets to closure lots.
- Require one expected Torghut receipt per selected repair lot.
- Add `no_delta` state when a terminal repair run does not retire the targeted reason code.
- Feed no-delta state into terminal debt compaction so repeated low-value repairs lose priority.

### Milestone 4: Stage Launch Consumption

Value gates: `failed_agentrun_rate`, `pr_to_rollout_latency`, `ready_status_truth`.

- Wire the closure ledger into stage credit, ready truth, and action custody behind a configuration flag.
- Emit stage launch tickets with `promotion_closure_ledger_ref`.
- Hold normal dispatch, deploy widening, and merge-ready unless the closure ledger is `allow`.
- Keep repair dispatch bounded to zero-notional selected lots.

### Milestone 5: Deployer And Verifier Cutover

Value gates: `pr_to_rollout_latency`, `manual_intervention_count`, `handoff_evidence_quality`.

- Update deployer runbooks to require the closure ledger for green PR-to-healthy rollout claims.
- Verify after rollout: Argo healthy, workload ready, Jangar ready, control-plane status reachable, closure ledger
  allow or explicit repair-only, Torghut `/db-check` schema current, and Torghut max notional `0`.
- Record before and after failed AgentRun count, no-delta repair count, and PR-to-healthy duration.

## Validation Gates

Engineer stage is not complete until:

- unit tests cover every closure lot class;
- tests prove service readiness stays available while material launch is held by source-serving proof;
- tests prove a current repair-bid settlement without expected output receipt holds repair dispatch;
- tests prove source-serving build mismatch produces a selected closure lot, not a generic block;
- tests prove no-delta repair accounting demotes repeated lots;
- `bunx oxfmt --check` passes for touched Markdown and TypeScript paths;
- the nearest targeted Jangar tests pass for every touched reducer.

Verify stage is not complete until:

- `gh pr checks <pr> --watch -R proompteng/lab` is green before merge;
- Argo reports `agents`, `jangar`, `torghut`, and `torghut-options` synced and healthy, or exact non-healthy reasons
  are recorded;
- Jangar `/ready` and `/api/agents/control-plane/status?namespace=agents` are reachable;
- the status route includes `promotion_closure_ledger`;
- source-serving closure lots name source SHA, Argo revision, and live image digest;
- Torghut `/db-check` is schema-current;
- Torghut repair dispatch remains zero-notional.

## Rollout Plan

1. Ship the closure ledger in observe mode with no admission behavior change.
2. Add source CI, manifest image digest, and serving build parity receipts.
3. Add repair value and no-delta accounting for Torghut repair lots.
4. Enable stage launch ticket consumption for discover and plan normal dispatch.
5. Enable implement, verify, deploy widening, and merge-ready after one clean schedule cycle.
6. Keep paper and live capital blocked until a separate capital passport graduates.

## Rollback Plan

Rollback is configuration-first:

- set closure-ledger consumption to observe-only;
- keep emitting the ledger if stable for audit;
- fall back to source-serving verdict, runtime admission, stage credit, ready truth, and repair-bid admission;
- do not delete AgentRuns, jobs, database rows, or receipts as rollback;
- if the status payload destabilizes Jangar, roll back the Jangar deployment image and keep the design contract as the
  operator handoff source.

## Risks And Mitigations

- Risk: the ledger duplicates existing status reducers. Mitigation: it must be a read-side coordinator with references,
  not a new collector.
- Risk: missing GitHub or Argo access prevents complete closure. Mitigation: report missing access as a closure lot
  with the smallest unblocker rather than falling back to manual prose.
- Risk: repair value accounting blocks a useful exploratory repair. Mitigation: only repeated no-delta repairs lose
  priority; new evidence tuples can create new lots.
- Risk: deployers confuse repair-only with outage. Mitigation: the ledger separates service readiness from material
  launch and names max notional `0`.
- Risk: source-to-serving closure slows immediate merge. Mitigation: it shortens the full green PR-to-healthy path by
  making missing proof visible before verify or deployer stages rediscover it.

## Handoff To Engineer

Build the closure ledger as a pure reducer first. Do not change scheduler behavior in the first PR. The first
implementation should add the status payload, fixtures, and tests that prove the current live state: service healthy,
material launch held, source-serving proof incomplete, Torghut repair-only with selected zero-notional lots.

Acceptance gates:

- source CI retention missing, manifest digest missing, and serving build mismatch each produce a closure lot;
- stale projection and missing receipt counts are represented without mutating source rows;
- selected Torghut repair lots carry one expected output receipt and max notional `0`;
- no-delta state is represented but not enforced until the second PR;
- status route remains available with closure ledger enabled.

## Handoff To Deployer

Use the promotion closure ledger as the PR-to-healthy evidence object once it lands. Argo `Synced/Healthy`, workload
readiness, and `/ready=ok` are not enough for material launch when the ledger says source or repair proof is missing.

Rollout acceptance gates:

- Argo `agents`, `jangar`, `torghut`, and `torghut-options` synced and healthy;
- Jangar status emits the closure ledger for the deployed revision;
- closure ledger decision is `allow` for merge-ready, or `repair_only` with named zero-notional lots;
- Torghut `/db-check` schema current;
- Torghut max notional remains `0`;
- handoff names the closed receipt or the smallest remaining closure blocker.
