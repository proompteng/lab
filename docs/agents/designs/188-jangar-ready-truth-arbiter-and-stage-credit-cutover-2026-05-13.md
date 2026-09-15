# 188. Jangar Ready Truth Arbiter And Stage Credit Cutover (2026-05-13)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-13
Owner: Victor Chen, Jangar Engineering Architecture
Scope: Jangar control-plane readiness truth, stage-credit enforcement, AgentRun failure reduction, GitOps rollout
settlement, Torghut repair custody, validation, rollback, and cross-stage handoff.

Extends:

- `187-jangar-stage-credit-ledger-and-runner-slot-futures-2026-05-13.md`
- `187-jangar-main-source-ci-retention-and-source-serving-verdicts-2026-05-13.md`
- `186-jangar-repair-bid-admission-and-settlement-custody-2026-05-13.md`
- `185-jangar-clearance-market-and-rollout-truth-settlement-2026-05-12.md`
- `184-jangar-stage-clearance-packets-and-freeze-aware-launch-governor-2026-05-12.md`
- `docs/agents/runbooks.md`

Companion Torghut contract:

- `docs/torghut/design-system/v6/192-torghut-repair-receipt-frontier-and-profit-cutover-2026-05-13.md`

## Decision

I am selecting a **ready truth arbiter with staged stage-credit cutover** as the next Jangar control-plane architecture
increment.

The current live system is safer than it was, but it is not truthful enough at the boundary where humans and schedulers
make decisions. On the 2026-05-13 read-only assessment, Argo reported `jangar`, `agents`, and `torghut` as
`Synced/Healthy` at revision `1feb3fd8b727185dd014ec0f38481d1f2fb4be4b`. Jangar `/health` returned `status=ok`, and
Jangar `/ready` returned `status=ok`. The richer control-plane status route told the harder truth: the `agents`
namespace was degraded because `agents-controller`, `runtime:workflow`, and `runtime:job` were not started, empirical
forecast evidence was degraded, and execution trust was degraded. The `jangar-control-plane` swarm itself was
`Frozen`, `Ready=False`, with the freeze reason `StageStaleness`.

That is the next reliability defect. The control plane can now compute stage credit, source-serving verdicts, repair
bid admission, and rollout truth, but the public readiness surface still lets "serving process is alive" look like
"the control plane is materially ready." Those are different claims. I want Jangar to keep serving read-only status
when the UI is healthy, but I do not want a scheduler, deployer, or merge gate to treat that as permission to launch
normal stage work.

The selected design introduces a `ready_truth_arbiter` read model and a cutover ladder for `stage_credit_ledger`.
The arbiter does not replace Kubernetes probes. It produces the material-action readiness verdict used by Jangar
schedulers, deployers, PR merge gates, and swarm handoffs. Serving readiness can stay green while material readiness is
`repair_only`, `hold`, or `block`. Stage credit then moves from `observe` to `shadow`, then to `hold` for launch
admission, and only later to `enforce` for automatic schedule suppression.

The tradeoff is direct: some stages will stop launching even though pods are up and Argo is healthy. I accept that
because the business metric is to reduce failed AgentRuns and shorten green PR-to-healthy GitOps rollout time. A green
pod is not enough if the controller witness, runtime adapter, source-serving verdict, Torghut repair receipt, and
failure-debt settlement do not agree.

## Governing Runtime Requirements

This design binds to the current swarm validation contract:

- every run must cite the governing design or runtime requirement before changing code;
- implement stages must produce production PRs with tests or report the exact blocker to code;
- verify stages must merge only green PRs and prove Argo, workload readiness, and service health after rollout;
- final handoff must name the control-plane metric improved or the smallest blocker preventing improvement.

Every milestone maps to at least one required value gate:

- `failed_agentrun_rate`
- `pr_to_rollout_latency`
- `ready_status_truth`
- `manual_intervention_count`
- `handoff_evidence_quality`

## Read-Only Evidence Snapshot

All evidence below was collected read-only on 2026-05-13. I did not mutate Kubernetes resources, database records,
GitOps resources, AgentRuns, Torghut trading flags, broker state, or data rows.

### Cluster, Rollout, And Events

- Runtime scope resolved to repository `proompteng/lab`, base `main`, head
  `codex/swarm-jangar-control-plane-plan`, stage `plan`, owner channel `swarm://owner/platform`, live channel
  `general`, mission ledger `/workspace/.agentrun/swarm/jangar-control-plane-mission-ledger.md`, and business metric
  "reduce failed AgentRuns and shorten green PR-to-healthy GitOps rollout time for the Jangar control plane".
- The working tree started clean on `codex/swarm-jangar-control-plane-plan`, aligned with `origin/main` at
  `1feb3fd8b727185dd014ec0f38481d1f2fb4be4b`.
- `kubectl -n argocd get applications jangar agents torghut -o wide` reported all three applications
  `Synced/Healthy` at revision `1feb3fd8b727185dd014ec0f38481d1f2fb4be4b`.
- Jangar workload evidence showed `deployment/jangar=1/1`, `deployment/agents=1/1`, and
  `deployment/agents-controllers=2/2`. Recent Jangar events still included a readiness probe failure during rollout:
  `Readiness probe failed: Get http://10.244.5.230:8080/health: connect: connection refused`.
- Agents namespace events included recent `BackoffLimitExceeded` on a Jangar implement attempt and a Torghut verify
  attempt, recent `agents-controllers` 503 readiness probe failures during rollout, and current schedule-runner pods.
- AgentRun retention showed the contradiction at scale: Jangar control-plane retained `discover=2`, `implement=25`,
  `plan=3`, and `verify=20` failed runs, while also retaining `discover=59`, `implement=92`, `plan=58`, and
  `verify=73` succeeded runs. Torghut retained similar failure debt. A plain deployment health bit cannot price that
  history.
- Failed pods in `agents` showed Jangar plan/implement failures with exit code `1` and Torghut market-context jobs
  with exit code `124`. Those are different failure classes and should not share one undifferentiated ready bit.

### Jangar Runtime And Source

- `curl http://jangar.jangar.svc.cluster.local/health` returned `status=ok`, with serving-process agents controller
  disabled.
- `curl http://jangar.jangar.svc.cluster.local/ready` returned `status=ok`, but its `execution_trust` section was
  degraded because the `jangar-control-plane` swarm was frozen for `StageStaleness`, with discover, plan, implement,
  and verify delayed by the freeze.
- `curl http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status` returned
  `database.connected=true`, `database.status=healthy`, migration consistency `29/29`, and latency `12ms`.
- The same control-plane status marked namespace `agents` as degraded with `degraded_components`:
  `agents-controller`, `runtime:workflow`, `runtime:job`, `empirical:forecast`, and `execution_trust`.
- `services/jangar/src/server/control-plane-status.ts` is the assembly point for this truth surface and is 795 lines.
- `services/jangar/src/server/control-plane-stage-credit-ledger.ts` already exists at 481 lines and emits
  `stage_credit_ledger` with governing design refs, credit accounts, runner slot futures, and the next implementation
  milestone.
- `services/jangar/src/server/control-plane-source-serving-contract-verdict.ts` exists at 456 lines and emits
  `source_serving_contract_verdict_exchange` in observe mode.
- `services/jangar/src/server/supporting-primitives-stage-clearance.ts` already stamps stage-credit trace data into
  schedule-runner parameters when available.
- `services/jangar/src/server/supporting-primitives-schedule-runner.ts` already contains the generated shell logic to
  respect stage-credit mode and write `swarmStageCredit*` parameters.
- Focused tests already exist for control-plane status, stage credit, source-serving verdicts, and supporting
  primitives. The remaining gap is not projection coverage; it is cutover and settlement coverage across launch,
  terminal AgentRun outcome, refund, burn, and swarm freeze release.

### Database, Data Quality, And Freshness

- The Jangar status route reported the database connected and migration consistency healthy, with 29 registered
  migrations and 29 applied migrations. The latest registered and applied migration was
  `20260508_torghut_quant_pipeline_health_account_window_created_at_index`.
- Direct CNPG inspection was blocked by service-account permissions for CNPG resources and statefulsets. That is
  acceptable for this architecture lane: the read model should not require every worker to have direct database
  privileges.
- Torghut `/readyz` returned `status=degraded` while Postgres, ClickHouse, Alpaca, universe loading, empirical jobs,
  and database schema lineage were healthy.
- Torghut schema was current at Alembic head `0031_autoresearch_candidate_spec_epoch_uniqueness`, with one expected
  head and one current head. The payload still warned about known migration parent forks, which are lineage quality
  signals, not current schema drift.
- Torghut live submission stayed disabled with `simple_submit_disabled`, active capital stage `shadow`,
  `promotion_eligible_total=0`, and `max_notional=0`.
- Torghut profitability proof floor was `repair_only` with capital state `zero_notional`.
- Torghut profit-window summary contained three windows: two `quarantined`, one `underfunded`, and all blocking.
- Torghut data freshness blockers included `feature_rows_missing`, `required_feature_set_unavailable`,
  `schema_lineage_missing`, `market_context_evidence_missing`, `research_candidates_empty`, `research_promotions_empty`,
  `vnext_promotion_decisions_empty`, and `rejection_drag_unmeasured`.

## Problem

Jangar now has several specialized truth surfaces, but it still lacks one cutover-ready material readiness verdict.
The failure modes are visible in the live system:

1. Argo can be `Synced/Healthy` while material launch readiness is degraded.
2. `/ready` can be `ok` while `agents-controller`, workflow runtime, and job runtime are not started.
3. A swarm can be frozen for stage staleness while schedule-runner pods are still being created.
4. Stage credit can be calculated and stamped while the system is still in observe mode.
5. Source-serving verdicts can correctly identify missing contracts while deployer and merge gates still speak in
   generic readiness terms.
6. Torghut can be capital safe at zero notional while its repair receipts are not yet good enough to unlock paper
   evidence.
7. Retained failure debt can keep growing while the status surface says the deployment is healthy.

That is why the next architecture step is not "add another health check." It is to name which readiness claim is being
made and which actor is allowed to spend it.

## Alternatives Considered

### Option A: Make `/ready` Fail On Any Control-Plane Degradation

This path treats the existing readiness probe as the full material readiness gate. If controller witness, runtime
adapters, source-serving proof, Torghut proof floor, or execution trust are degraded, `/ready` returns non-OK.

Advantages:

- Simple mental model.
- Kubernetes and Argo see the problem immediately.
- Forces teams to retire degraded dependencies quickly.

Disadvantages:

- Conflates "Jangar can serve read-only evidence" with "Jangar can launch material work."
- Risks restarting a useful status UI during exactly the incidents where operators need it.
- Can create rollout churn if Torghut capital proof is intentionally zero-notional but Jangar serving is otherwise
  healthy.
- Does not define stage-credit refund, burn, or repair-only semantics.

Decision: reject as the primary architecture. Keep `/ready` serving-safe; add material readiness as a separate truth
contract.

### Option B: Keep Observe Mode Until All Surfaces Are Healthy

This path leaves stage credit, source-serving verdicts, repair-bid admission, and readiness truth as observe-only
payloads until Jangar, Agents, and Torghut are simultaneously green.

Advantages:

- Lowest implementation risk.
- Avoids breaking existing schedules.
- Allows continued data collection.

Disadvantages:

- It permits the exact failure mode we are seeing: known-held stages continue to spend runner slots.
- It makes failed AgentRun rate worse while waiting for perfect convergence.
- It gives deployers no enforceable distinction between bounded repair and normal launch.
- It relies on manual interpretation of a large status payload.

Decision: reject. Observe mode is no longer enough for stage admission.

### Option C: Ready Truth Arbiter With Stage-Credit Cutover

This selected path keeps serving readiness and material readiness separate. Jangar emits a `ready_truth_arbiter`
contract that reconciles Argo, workload rollout, control-plane status, stage credit, source-serving verdicts, retained
failure debt, and Torghut repair receipts. Stage credit then cuts over by action class and evidence mode:

- `serve_readonly`: always allowed when Jangar serving and database read are healthy.
- `torghut_observe`: allowed when Torghut status is reachable and max notional is zero.
- `dispatch_repair`: allowed only with current zero-notional repair receipt, runner slot future, and unexpired
  stage-credit account.
- `dispatch_normal`, `deploy_widen`, `merge_ready`: held until material readiness is `allow`.
- `paper_canary`: held until Torghut source-serving proof and profit-window receipts are current.
- `live_micro_canary`, `live_scale`: blocked until capital proof, source-serving proof, and human-approved cutover
  thresholds are satisfied.

Advantages:

- Reduces failed AgentRuns by cutting off known-held normal launches.
- Preserves the read-only UI and evidence API during repair states.
- Lets one bounded repair run when it has value and no capital authority.
- Gives deployers one material verdict instead of forcing them to reconcile many payloads.
- Makes PR-to-rollout latency measurable: green PR, image promotion, Argo sync, material readiness, and health settle
  at distinct timestamps.

Disadvantages:

- Requires one more read model and one more cutover flag.
- Requires careful rollout so observe-mode dashboards and hold-mode schedulers do not disagree.
- Requires terminal AgentRun settlement to burn or refund credit before `enforce` mode is safe.

Decision: select Option C.

## Architecture

Jangar emits a `ready_truth_arbiter` object inside the control-plane status payload:

```text
ready_truth_arbiter
  schema_version = jangar.ready-truth-arbiter.v1
  verdict_id
  generated_at
  fresh_until
  namespace
  serving_readiness            # ok | degraded | down
  material_readiness           # allow | repair_only | hold | block
  argo_revision
  argo_health
  workload_rollout_ref
  controller_witness_ref
  runtime_adapter_refs[]
  stage_credit_ledger_ref
  source_serving_verdict_ref
  torghut_repair_receipt_ref
  retained_failure_debt_refs[]
  ready_status_truth_reasons[]
  allowed_action_classes[]
  held_action_classes[]
  blocked_action_classes[]
  merge_gate_receipt
  deployer_receipt
  rollback_target
```

Decision rules:

- `serving_readiness=ok` means Jangar can serve the UI and read-only APIs. It is not launch authority.
- `material_readiness=allow` requires current controller witness, workflow/job runtime availability, database
  migration consistency, no active swarm freeze, stage-credit decision `allow`, source-serving verdict `allow`, and no
  active retained failure debt for the action class.
- `material_readiness=repair_only` allows zero-notional repair work when a current repair lot names the value gate,
  required output receipt, TTL, max runtime, and runner slot future.
- `material_readiness=hold` prevents normal launches and merge/deploy widening while preserving read-only service.
- `material_readiness=block` prevents capital-adjacent action and live cutover.
- Argo `Synced/Healthy` contributes rollout evidence but never overrides a degraded controller witness or stage-credit
  hold.
- `/ready` remains a serving probe. Merge gates and deployer verification must use `ready_truth_arbiter` or the
  existing control-plane status route until the arbiter is promoted to its own route.

## Cutover Ladder

The cutover happens in four steps. Each step has a metric and rollback.

1. Observe, already present:
   `stage_credit_ledger` and `source_serving_contract_verdict_exchange` are emitted and tested. No schedule is blocked
   solely by them. Metric: `handoff_evidence_quality`.

2. Shadow:
   add `ready_truth_arbiter` and record what would have launched or held. Stamp every generated AgentRun with the
   arbiter verdict and stage-credit account. Metric: `ready_status_truth`.

3. Hold:
   schedule-runner blocks `dispatch_normal`, `deploy_widen`, and `merge_ready` when material readiness is `hold` or
   `block`, while preserving `serve_readonly`, `torghut_observe`, and one bounded `dispatch_repair` lane. Metric:
   `failed_agentrun_rate`.

4. Enforce:
   terminal AgentRun settlement burns or refunds stage credit. Repeated failed stages lose credit for the next epoch;
   successful repair receipts unlock normal admission only after source-serving and rollout truth settle. Metric:
   `pr_to_rollout_latency` and `manual_intervention_count`.

Rollback is explicit:

- Set `JANGAR_READY_TRUTH_ARBITER_MODE=observe` to keep emitting evidence but stop gating.
- Set `JANGAR_STAGE_CREDIT_LEDGER_MODE=observe` if stage-credit holds are incorrect.
- Set `JANGAR_STAGE_CREDIT_LEDGER_ENABLED=false` only if the ledger payload itself is malformed.
- Keep Torghut `max_notional=0` and live submission disabled while source-serving or profit repair receipts are
  disputed.

## Implementation Scope For Engineer Stage

The next bounded engineering PR should not rewrite the controller. It should add one pure reducer and one narrow
integration point.

Required code changes:

1. Add `services/jangar/src/server/control-plane-ready-truth-arbiter.ts`.
2. Add types to `services/jangar/src/server/control-plane-status-types.ts` and status types.
3. Call the reducer from `control-plane-status.ts` after `stage_credit_ledger`, `source_serving_contract_verdict`, and
   `repair_bid_admission` are built.
4. Add tests in `services/jangar/src/server/__tests__/control-plane-ready-truth-arbiter.test.ts`.
5. Extend `control-plane-status.test.ts` with the current live contradiction: serving readiness OK, material readiness
   hold because agents controller/runtime and execution trust are degraded.
6. Add schedule-runner hold-mode tests only after the arbiter is in shadow mode.

Acceptance gates:

- `bun run --filter @proompteng/jangar test -- src/server/__tests__/control-plane-ready-truth-arbiter.test.ts`
- `bun run --filter @proompteng/jangar test -- src/server/__tests__/control-plane-status.test.ts -t ready`
- `bun run --filter @proompteng/jangar lint`
- `bun run --filter @proompteng/jangar tsc`

The engineer must cite this design in the PR body and in any runtime parameter names. The first implementation PR must
leave the arbiter in `observe` or `shadow`; hold-mode schedule suppression is a second PR unless the first PR proves
the generated schedule-runner behavior with focused tests.

## Deployment And Verification Gates

The deployer stage must prove all of the following after merge and image promotion:

- Argo `jangar` and `agents` are Synced/Healthy at the promoted revision.
- `deployment/jangar`, `deployment/agents`, and `deployment/agents-controllers` are rolled out.
- `curl /health` returns serving OK.
- `curl /api/agents/control-plane/status?namespace=agents` exposes `ready_truth_arbiter`.
- `ready_truth_arbiter.serving_readiness=ok` and material readiness is either `allow` or a named
  `repair_only`/`hold` with reason codes.
- `stage_credit_ledger` has fresh accounts and runner slot futures.
- `source_serving_contract_verdict_exchange` is current and names missing contracts if any.
- Jangar control-plane failed AgentRun rate does not increase in the verification window.
- Torghut remains `max_notional=0` until the companion repair receipts graduate.

## Handoff Contract

Engineer handoff:

- Build `ready_truth_arbiter` as a pure reducer first.
- Do not make `/ready` fail on Torghut proof debt or normal stage holds.
- Do not grant capital authority from Jangar status; Torghut capital gates remain authoritative for notional.
- Keep mode flags explicit and default to non-destructive `observe` or `shadow`.
- Add regression tests for the exact live split: Argo/serving OK, material readiness hold.

Deployer handoff:

- Treat Argo health as necessary but not sufficient.
- Use `ready_truth_arbiter.material_readiness` as the merge/deploy widen gate once it exists.
- Preserve read-only Jangar access during repair states.
- Roll back by mode flag before reverting code unless the status payload is malformed.

## Risks

- The arbiter can become another large status object if it copies all upstream payloads. It must reference evidence
  IDs and summarize only action-class decisions.
- If hold mode is enabled before terminal settlement, repeated failed runs may stop but credit will not recover
  automatically. That is why enforce mode waits for refund/burn settlement.
- If teams continue to cite `/ready` as a launch gate, the readiness split will remain confusing. The PR template,
  runbooks, and deployer checks must name material readiness explicitly.
- Torghut can still be capital safe and unprofitable. This design reduces control-plane failures; the companion design
  defines the profit repair receipts needed to unlock routeable candidates.

## Next Milestone

The next implementation milestone is:

`feat(jangar): add ready truth arbiter read model`

It improves:

- `ready_status_truth` by separating serving readiness from material launch readiness;
- `failed_agentrun_rate` by preparing hold-mode schedule suppression for known-held normal launches;
- `pr_to_rollout_latency` by giving deployers one settled material readiness receipt;
- `manual_intervention_count` by making repair-only launch authority explicit;
- `handoff_evidence_quality` by binding every launch decision to a design and evidence ID.
