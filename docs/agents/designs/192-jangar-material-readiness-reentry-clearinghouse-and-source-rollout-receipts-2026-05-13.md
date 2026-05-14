# 192. Jangar Material Readiness Reentry Clearinghouse And Source Rollout Receipts (2026-05-13)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-13
Owner: Victor Chen, Jangar Engineering Architecture
Scope: Jangar material readiness, source-to-serving rollout truth, AgentRun launch admission, watch/cache authority,
stage credit, Torghut repair admission, validation, rollout, rollback, and cross-stage handoff.

Companion Torghut contract:

- `docs/torghut/design-system/v6/197-torghut-executable-alpha-repair-receipts-and-zero-notional-reentry-2026-05-13.md`

Extends:

- `docs/agents/designs/191-jangar-rollout-proof-passports-and-runner-capacity-futures-2026-05-13.md`
- `docs/agents/designs/190-jangar-projection-foreclosure-notary-and-stage-custody-repair-2026-05-13.md`
- `docs/agents/designs/189-jangar-authority-provenance-settlement-and-rollout-reentry-windows-2026-05-13.md`
- `docs/agents/designs/188-jangar-ready-truth-arbiter-and-stage-credit-cutover-2026-05-13.md`
- `docs/agents/designs/187-jangar-main-source-ci-retention-and-source-serving-verdicts-2026-05-13.md`
- `docs/agents/designs/140-jangar-watch-reliability-state-exchange-and-capital-action-governor-2026-05-07.md`
- `docs/agents/runbooks.md`

## Decision

I am selecting **material readiness reentry clearinghouse with source rollout receipts** as the next Jangar control
plane architecture increment.

The current system is healthy enough to serve, but not settled enough to widen or merge without an explicit reentry
receipt. On the 2026-05-13 read-only assessment, `http://agents.agents.svc.cluster.local/ready` returned
`status=ok`, leader election was active, execution trust was healthy, and projection watermarks for `jangar_ready`,
`control_plane_status`, and `deploy_verification` were fresh. Argo CD reported `agents`, `jangar`, `torghut`, and
`torghut-options` as `Synced/Healthy`. The `agents` deployments were ready at `agents=1/1` and
`agents-controllers=2/2`; the Jangar application database was connected with `29/29` Kysely migrations applied.

That serving evidence is not enough for material authority. The control-plane status route reported namespace
`agents` as degraded by `watch_reliability`. The watch reliability window had `1099` events, `123` errors, and all
watch errors were on `agentruns.agents.proompteng.ai` as `event_handler_error`. Ready truth allowed only
`serve_readonly` and `torghut_observe`; it held `dispatch_repair`, `dispatch_normal`, `deploy_widen`,
`merge_ready`, and `paper_canary`; it blocked `live_micro_canary` and `live_scale`. Authority provenance settled the
controller process with split authority, but held watch epoch, stage clearance, source/GitOps, and serving-image
truth. Stage credit for normal dispatch was zero because source rollout truth was missing, desired live image evidence
was mismatched, controller heartbeat was not current for material authority, and the watch cache was not healthy.

The selected design makes the reentry path explicit. A material readiness reentry clearinghouse receives compact,
expiring receipts for each reason a material action is held: watch reliability repair, controller ingestion repair,
source-to-serving rollout proof, stage credit restoration, Torghut zero-notional repair, and deployer post-rollout
proof. The clearinghouse does not replace ready truth or stage credit. It is the settlement boundary that tells a
worker which receipt must be produced next and tells the deployer when the hold is cleared enough to widen, merge, or
keep observing.

The tradeoff is that Jangar will become more opinionated about what counts as a completed repair. A worker may finish
a useful patch but still be held out of normal dispatch if it cannot attach the relevant receipt. I accept that. The
business metric is to reduce failed AgentRuns and shorten green PR-to-healthy GitOps rollout time, not to maximize the
number of scheduled runs. A named missing receipt is cheaper than another BackoffLimitExceeded, workflow timeout, or
manual debate over whether Argo health really proves source-to-serving truth.

## Governing Runtime Requirements

This contract implements the active swarm validation requirements:

- every run must cite the governing design or runtime requirement before changing code;
- implement stages must produce production PRs with tests or report the exact blocker to code;
- verify stages must merge only green PRs and prove Argo, workload readiness, and service health after rollout;
- final handoff must name the control-plane metric improved or the smallest blocker preventing improvement.

Every milestone maps to the required value gates:

- `failed_agentrun_rate`
- `pr_to_rollout_latency`
- `ready_status_truth`
- `manual_intervention_count`
- `handoff_evidence_quality`

## Current Evidence

Evidence was collected read-only on 2026-05-13. I did not mutate Kubernetes resources, database rows, GitOps
resources, AgentRuns, broker state, trading flags, or market data.

### Cluster And Rollout

- The shell was running on the required local branch `codex/swarm-jangar-control-plane-plan` at `main`
  `2ad2aa0fe`.
- The remote head `codex/swarm-jangar-control-plane-plan` was absent because earlier architecture PRs from this head
  had already been merged and the remote branch was removed. This run therefore creates the next commit from fresh
  `main` and pushes the same head name again.
- Argo CD reported `agents`, `agents-ci`, `jangar`, `symphony-jangar`, `symphony-torghut`, `torghut`, and
  `torghut-options` as `Synced/Healthy`.
- `agents` namespace deployments were ready: `agents=1/1`, `agents-controllers=2/2`, and `agents-alloy=1/1`.
- `jangar` namespace pods were ready, including `jangar`, `jangar-db-1`, `bumba`, `symphony`, and
  `symphony-jangar`.
- Recent `agents` events showed control-plane rollout churn that recovered: image pulls for Jangar `a29d185c`, old
  controller pods returning HTTP 503 readiness during termination, and successful replacement by ready pods.
- The same event stream showed AgentRun fragility that has not fully disappeared: a recent etcd request timeout while
  creating a discover job, an OOMKilled plan attempt earlier in the day, failed schedule-runner pods, and current
  active plan/discover/verify/implement jobs.
- Retained AgentRuns in the recent window included successful majority behavior but a material failure tail:
  BackoffLimitExceeded for some implement and market-context runs, WorkflowStepTimedOut for verify lanes, and failed
  pods in Jangar and Torghut scheduled work.

### Source And Runtime

- `GET /ready` on the agents service returned `status=ok`, `execution_trust.status=healthy`, fresh projection
  watermarks, and current Torghut consumer evidence.
- `GET /api/agents/control-plane/status` reported namespace `agents` as `degraded` by `watch_reliability`.
- `watch_reliability.status=degraded` with `1099` events, `123` errors, and `agentruns.agents.proompteng.ai`
  carrying all watch errors as `event_handler_error`.
- `rollout_health.status=healthy`, with `agents` and `agents-controllers` fully ready.
- `ready_truth_arbiter.serving_readiness=ok`, but `material_readiness=hold`,
  `projection_authority_decision=hold`, `merge_ready=hold`, and `deploy_widen=hold`.
- Ready truth required repair actions were specific: attach current Torghut execution TCA refresh receipt, attach
  current Torghut market-context freshness receipt, renew or retire `agentrun_execution`,
  `market_context_news`, and `market_context_fundamentals` projections, and restore projection notary evidence for
  `source_rollout_truth`.
- `authority_provenance_settlement` reported `settled_with_split`: controller heartbeat was the winning authority,
  database schema and workflow runtime were settled, but watch epoch, source GitOps, serving image, stage clearance,
  and Torghut capital were held or repairable splits.
- `stage_credit_ledger` kept normal dispatch and merge-ready at zero available credit because of watch reliability,
  missing source rollout truth, desired live image mismatch, controller heartbeat not current for material authority,
  and watch cache not healthy.
- High-risk source surfaces are large and cross-cutting: `control-plane-status.ts`, `control-plane-ready-truth-arbiter.ts`,
  `control-plane-stage-credit-ledger.ts`, `control-plane-source-rollout-truth-exchange.ts`,
  `control-plane-authority-provenance-settlement.ts`, `control-plane-watch-reliability.ts`, and
  `src/data/agents-control-plane.ts`. Existing tests cover many reducers, but the remaining gap is a cross-surface
  acceptance test proving a held material action maps to one next receipt instead of a long reason-code list.

### Database And Data Quality

- Jangar application database status was healthy through the control-plane status route: connected, latency under a
  few dozen milliseconds, `29` registered migrations, `29` applied migrations, no missing migrations, and no
  unexpected migrations. Latest applied and registered migration was
  `20260508_torghut_quant_pipeline_health_account_window_created_at_index`.
- Direct cluster-level node and CNPG cluster inspection was blocked by RBAC for this worker. That is acceptable and
  instructive: normal agents should not require privileged database-pod inspection to decide material readiness.
- Torghut `/db-check` returned `ok=true`, `schema_current=true`, current and expected Alembic head
  `0031_autoresearch_candidate_spec_epoch_uniqueness`, one expected head, one current head, no missing or unexpected
  heads, and lineage ready. It still exposed known parent-fork warnings, so schema quality is current but historically
  branchy.
- Torghut `/readyz` returned HTTP 503 with `status=degraded`, but Postgres, ClickHouse, Alpaca, database schema,
  universe, readiness cache, empirical jobs, and scheduler dependencies were OK. The blockers were capital and proof
  state, not storage reachability.
- Torghut `/trading/revenue-repair` returned `revenue_ready=false`, `business_state=repair_only`,
  `operating_rule=keep_live_submit_disabled_until_repair_queue_clears`, capital `max_notional=0`, and top repair
  queue item `repair_alpha_readiness` requiring `torghut.executable-alpha-receipts.v1`.

## Problem

Jangar now has several good truth surfaces, but the action path still leaks complexity to humans and runners.

The failure modes are concrete:

- Serving readiness can be green while material readiness is held.
- Argo can be green while source-to-serving evidence is split or missing manifest digest proof.
- Controller heartbeat can be authoritative for serving while AgentRun ingestion is unknown from the serving process.
- Watch reliability can be degraded even though deployments are healthy.
- Stage credit can correctly refuse normal dispatch, but the worker gets a broad reason-code list rather than the
  exact receipt that would clear the hold.
- Torghut can expose useful zero-notional repair evidence while paper and live capital must stay blocked.

The system needs a clearinghouse that converts a held action class into one bounded reentry contract. Without that
translation, the next engineer or deployer has to read ready truth, authority provenance, stage credit, source rollout
truth, projection foreclosure, repair bid admission, and Torghut evidence separately. That manual synthesis is slow,
and it lets failed AgentRuns become the discovery mechanism for missing proof.

## Alternatives Considered

### Option A: Keep The Existing Ledgers And Improve Handoff Text

This option leaves ready truth, stage credit, authority settlement, watch reliability, source rollout truth, and
Torghut repair evidence as separate surfaces. The handoff would tell engineers which fields to inspect.

Advantages:

- Lowest implementation cost.
- Preserves current reducer boundaries.
- Useful for immediate human debugging.

Disadvantages:

- Does not reduce failed AgentRuns before launch.
- Keeps manual interpretation in the deployer path.
- Does not create a single PR-to-rollout stopwatch.
- Leaves Torghut repair admission tied to long payload inspection.

Decision: reject as the primary direction. Handoff text is necessary, but it does not change admission behavior.

### Option B: Hard-Enforce Ready Truth For All Material Actions

This option makes `ready_truth_arbiter` the sole admission source and suppresses material actions whenever it is not
`allow`.

Advantages:

- Simple policy.
- Strongly reduces unsafe launches.
- Reuses an existing object that already names action classes.

Disadvantages:

- Too blunt for repair work because some repairs are how readiness recovers.
- Does not tell a worker which receipt to produce.
- Risks deadlocking source-rollout and Torghut repair recovery.
- Still does not settle runner capacity or source-to-serving proof as typed artifacts.

Decision: reject except as an incident fallback.

### Option C: Material Readiness Reentry Clearinghouse

This option creates a clearinghouse that consumes the existing ledgers and emits compact `material_reentry_receipt`
requirements per action class. A worker can launch or reenter only if it cites the governing design and either
produces the requested receipt or reports the exact blocker.

Advantages:

- Converts broad degraded state into bounded work.
- Keeps serving available while material action remains conservative.
- Lets repair work proceed when it has a typed receipt target.
- Gives deployers one source-to-serving proof contract before widening or merge-ready.
- Directly maps to failed AgentRun reduction and PR-to-rollout latency.

Disadvantages:

- Adds another read model and test matrix.
- Requires stable receipt schemas and reason-code normalization.
- May hold work that would otherwise succeed by luck.

Decision: select Option C.

## Architecture

### Material Reentry Receipt

The clearinghouse defines one receipt type that every held material action can point at:

```text
material_reentry_receipt
  schema_version = jangar.material-reentry-receipt.v1
  receipt_id
  generated_at
  fresh_until
  namespace
  action_class
  stage
  decision = allow | hold | block | repair_only
  receipt_class
  source_hold_refs[]
  required_output_receipt
  required_validation_commands[]
  value_gates[]
  expected_gate_delta
  max_parallelism
  max_runtime_seconds
  max_notional
  rollback_target
```

`receipt_class` is one of:

- `watch_reliability_repair`
- `controller_ingestion_repair`
- `source_rollout_receipt`
- `serving_image_receipt`
- `stage_credit_reentry`
- `torghut_executable_alpha_repair`
- `torghut_execution_tca_repair`
- `deployer_rollout_proof`
- `merge_ready_source_receipt`

Receipts are intentionally small. The large status payloads remain diagnostics. The receipt is the operational
contract.

### Reentry Clearinghouse

The clearinghouse is a read model built from existing runtime objects:

- ready truth arbiter;
- stage credit ledger;
- authority provenance settlement;
- source rollout truth exchange;
- source-serving contract verdict exchange;
- watch reliability summary;
- projection foreclosure notary;
- repair bid admission;
- Torghut consumer evidence;
- database status;
- rollout health.

For each action class, the clearinghouse emits one of three outputs:

- `open`: action can proceed and the receipt carries positive proof refs;
- `repair_required`: action is held, but the next bounded receipt is known;
- `blocked`: action cannot proceed because source, DB, runtime, or capital safety is missing.

When several holds are present, ordering is deterministic:

1. database/schema or runtime unavailable;
2. watch reliability blocked;
3. source/GitOps or serving-image split;
4. controller ingestion unknown;
5. stage credit insufficient;
6. Torghut capital or repair receipt missing;
7. deployer post-rollout proof missing.

This keeps handoffs short and avoids sending an implementer after Torghut alpha repair when the real next gate is
watch reliability or source rollout proof.

### Source Rollout Receipt

`source_rollout_receipt` is the deployer-facing receipt for `deploy_widen` and `merge_ready`. It is valid only when
all of these line up:

- PR head SHA;
- base branch SHA;
- source commit used to build image;
- image digest in GitOps manifest;
- Argo application revision and health;
- live deployment image digest;
- `/ready` serving passport;
- `/api/agents/control-plane/status` rollout health;
- database migration consistency;
- controller heartbeat or approved split authority;
- post-rollout service health check timestamp.

If Argo is healthy but the manifest digest or source CI retention receipt is missing, the receipt must be `hold` with
reason `source_rollout_receipt_missing_manifest_digest` or `source_rollout_receipt_missing_ci_retention`.

### Watch Reliability Receipt

`watch_reliability_repair` is valid when the watch window satisfies:

- no `event_handler_error` spike on `agentruns.agents.proompteng.ai`;
- cache freshness for AgentRun, Agent, ImplementationSpec, and ImplementationSource is under configured staleness;
- controller witness has a current watch epoch;
- at least two healthy resync windows occur after a watch error burst.

It can be generated in observe mode first. Enforcement should only block normal dispatch after the team proves it
does not create repair deadlocks.

### Torghut Reentry Receipt

Torghut repair receipt classes are zero-notional by default. The clearinghouse may admit a Torghut repair when:

- the Torghut companion receipt names `max_notional=0`;
- `/trading/revenue-repair` says the repair is the top queue item or a selected dispatchable lot;
- the receipt names a value gate such as `routeable_candidate_count` or `capital_gate_safety`;
- the receipt includes validation commands and expected no-delta behavior;
- Jangar stage credit has enough repair capacity after watch/source gates.

Paper and live capital remain blocked until Torghut emits a separate capital reentry receipt and ready truth moves
`paper_canary`, `live_micro_canary`, or `live_scale` to an allowed state.

## Implementation Scope

### Engineer Milestone 1: Clearinghouse Read Model

Add a Jangar read model, tentatively `control-plane-material-readiness-reentry.ts`, that builds receipts from the
existing status inputs. It should be pure and heavily unit-tested.

Acceptance gates:

- Given healthy DB and rollout but degraded AgentRun watch reliability, `dispatch_normal` returns
  `repair_required` with `receipt_class=watch_reliability_repair`.
- Given healthy watch but missing manifest digest, `deploy_widen` and `merge_ready` return `repair_required` with
  `receipt_class=source_rollout_receipt`.
- Given Torghut `repair_alpha_readiness` as the top revenue-repair queue item and Jangar repair capacity available,
  `torghut_observe` returns a zero-notional repair receipt and live capital stays blocked.
- Tests cite this design doc in fixture names or comments.

Suggested commands:

- `bun run --filter jangar test -- services/jangar/src/server/__tests__/control-plane-material-readiness-reentry.test.ts`
- `bun run --filter jangar test -- services/jangar/src/routes/ready.test.ts`
- `bun run --filter jangar test -- services/jangar/src/server/__tests__/control-plane-ready-truth-arbiter.test.ts`

Implementation note, 2026-05-14:

- Jangar now emits an observe-mode `material_reentry_clearinghouse` from
  `services/jangar/src/server/control-plane-material-reentry-clearinghouse.ts`.
- The reducer builds one compact `jangar.material-reentry-receipt.v1` per ready-truth action class and exposes it on
  `/api/agents/control-plane/status`.
- Held or blocked actions receive exactly one primary required output receipt, ordered by database/runtime safety,
  watch reliability, source rollout, stage credit, then Torghut repair admission.
- The Torghut alpha-readiness lane preserves zero-notional safety: when repair-bid admission exposes a fresh
  promotion-custody dispatch ticket for `routeable_candidate_count`, the clearinghouse cites that receipt while live
  capital actions stay blocked by existing material gates.
- This implementation is projection-only. It does not alter schedule-runner enforcement, live submission flags, GitOps
  promotion, or repair-bid admission.

### Engineer Milestone 2: API And Progress Surface

Expose the clearinghouse in `/api/agents/control-plane/status` and in the ready/status UI as a compact list of current
receipts. Do not duplicate the full diagnostic payload.

Acceptance gates:

- `/api/agents/control-plane/status` includes `material_reentry_clearinghouse.schema_version`.
- Each held action has exactly one primary `required_output_receipt`.
- The progress comment and handoff artifact can quote the current receipt without reading long status payloads.

### Engineer Milestone 3: Schedule Runner Observe Mode

Teach schedule-runner admission to read the clearinghouse in observe mode. It should log the receipt that would have
held a launch but must not block until deployer has compared predicted holds against real outcomes for at least one
day.

Acceptance gates:

- Existing schedules keep running.
- Observe-mode output records the action class, receipt class, and reason code.
- No increase in failed AgentRuns during observe mode.

### Deployer Milestone: Enforced Reentry

After observe-mode evidence is stable, enable enforcement for `dispatch_normal`, then `deploy_widen` and
`merge_ready`. Keep `serve_readonly` out of enforcement.

Acceptance gates:

- Argo reports `agents` and `jangar` `Synced/Healthy`.
- `kubectl get deploy -n agents agents agents-controllers` shows ready replicas equal desired replicas.
- `curl -fsS http://agents.agents.svc.cluster.local/ready` returns `status=ok`.
- `/api/agents/control-plane/status` reports healthy database migrations and either healthy watch reliability or a
  valid watch reentry receipt.
- A green PR has a source rollout receipt that names PR SHA, image digest, Argo revision, workload image, and
  post-rollout health timestamp.

## Validation Gates

This contract is successful when:

- `failed_agentrun_rate`: the 24-hour failed AgentRun tail drops after schedule-runner observe/enforce rollout, with
  specific reduction in `BackoffLimitExceeded`, `WorkflowStepTimedOut`, and failed schedule-runner pods.
- `pr_to_rollout_latency`: green PR-to-healthy rollout handoffs use one source rollout receipt instead of manual
  Argo, image, and `/ready` reconstruction.
- `ready_status_truth`: serving readiness and material readiness stay separated; `/ready` can be ok while material
  actions remain held with named receipts.
- `manual_intervention_count`: deployer does not need to inspect more than one receipt to know the next unblocker.
- `handoff_evidence_quality`: final handoffs cite receipt IDs, validation commands, rollback target, and metric delta.

## Rollout Plan

1. Ship the clearinghouse read model in shadow/observe mode.
2. Expose receipts in the status API and UI.
3. Run schedule-runner observe mode for all Jangar and Torghut schedules.
4. Compare observed receipts against actual run outcomes for at least one day.
5. Enforce only `dispatch_normal` after watch/source receipts prove stable.
6. Enforce `deploy_widen` and `merge_ready` after deployer post-rollout receipts are reliable.
7. Leave Torghut paper/live capital blocked until the Torghut companion contract produces capital reentry proof.

## Rollback Plan

Rollback is configuration-first:

- set the clearinghouse mode to `observe`;
- keep ready truth and stage credit as diagnostics;
- disable schedule-runner enforcement while retaining receipt generation;
- keep Torghut `max_notional=0`;
- fall back to existing ready truth, authority provenance, and source rollout truth fields for manual deployer
  decisions.

Rollback must preserve generated receipts for audit. Do not delete receipts during rollback; mark them superseded or
observe-only.

## Risks

- Receipt ordering can hide lower-priority blockers. Mitigation: expose secondary blocked reasons but keep one primary
  receipt.
- Over-enforcement can deadlock repair work. Mitigation: observe mode first and keep repair-only action classes
  separate from normal dispatch.
- Source rollout receipts depend on consistent image metadata. Mitigation: fail closed for deploy widening, but keep
  serve-readonly available.
- Torghut repair receipts can become noisy if the revenue-repair queue changes rapidly. Mitigation: require TTL,
  dedupe key, and zero-notional rollback target.

## Handoff To Engineer

Build the clearinghouse as a pure reducer over existing status inputs before touching schedule-runner behavior. The
first production PR should include:

- new receipt builder and tests;
- status API field in observe mode;
- no Kubernetes or database mutations;
- governing design refs in generated receipts;
- validation fixtures for watch degraded, source rollout missing digest, and Torghut alpha repair.

The bounded implementation milestone is: **produce `jangar.material-reentry-receipt.v1` for held
`dispatch_normal`, `deploy_widen`, `merge_ready`, and Torghut repair action classes without enforcing it**.

## Handoff To Deployer

Do not widen based only on Argo `Healthy`. Require a source rollout receipt that binds source SHA, image digest,
manifest digest, live workload image, `/ready`, DB migration consistency, and post-rollout status. If the receipt is
missing or held, keep deploy widening and merge-ready held and publish the receipt blocker.

For Torghut, keep paper and live capital blocked until executable alpha repair receipts retire the top
`repair_alpha_readiness` queue item and ready truth moves paper canary out of hold. Zero-notional observe and repair
work may proceed only when the clearinghouse names the required receipt and validation commands.

## Metrics And Reporting

The next verify handoff must include:

- failed AgentRun count and reason distribution before and after observe mode;
- PR-to-rollout receipt timestamp sequence;
- current ready truth split between serving and material readiness;
- manual intervention avoided or still required;
- receipt IDs for the top unblocker and rollback target.
