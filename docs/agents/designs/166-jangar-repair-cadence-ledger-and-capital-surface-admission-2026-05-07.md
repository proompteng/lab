# 166. Jangar Repair Cadence Ledger And Capital Surface Admission (2026-05-07)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-07
Owner: Gideon Park, Torghut Traders Architecture
Scope: Jangar control-plane resilience, repair admission, capital-surface gating, rollout safety, and Torghut quant
profitability handoff.

Companion Torghut contract:

- `docs/torghut/design-system/v6/170-torghut-capital-surface-repair-cadence-and-route-edge-market-2026-05-07.md`

Extends:

- `165-jangar-proof-settlement-broker-and-profit-repair-packet-gates-2026-05-07.md`
- `159-jangar-authority-surface-settlement-and-quant-stage-cohort-gates-2026-05-07.md`
- `docs/torghut/design-system/v6/169-torghut-route-reacquisition-board-and-profit-repair-packets-2026-05-07.md`

## Decision

I am selecting a repair cadence ledger with capital-surface admission as the next Jangar architecture layer.

The current control plane has recovered enough to serve read-only observation, but not enough to let every green
sub-surface become dispatch or capital authority. Jangar pods are running, Agents controllers are ready, Torghut live
and simulation revisions are running on the promoted digest, and Torghut database schema checks pass. That is the
availability story. The trust story is weaker: recent events still show readiness probe timeouts for Agents and
Torghut, an etcd status update timeout for a Torghut pod autoscaler, failed scheduled jobs, a retained Torghut
autoresearch error pod, and Torghut runtime data that says capital must remain zero notional.

Jangar should publish a `repair_cadence_ledger` that admits bounded repair work in a cadence, not as ad hoc retries.
Each entry connects a control-plane authority state, a Torghut capital surface, the current blocker class, the allowed
repair action, and the evidence that must come back before the next wider surface opens. The ledger is not a scheduler
replacement. It is the settlement object that tells schedulers, engineers, and deployers which work is safe while the
system is degraded.

The selected direction keeps read-only observation and no-notional repair available while holding normal dispatch,
merge-ready deployment widening, paper canary, live micro canary, and live scale. The tradeoff is slower widening after
a rollout looks healthy. I accept that because the profitable system needs fewer ambiguous retries, not faster retries.

## Runtime Objective And Success Metrics

Success means:

- `/api/agents/control-plane/status?namespace=agents` exposes `repair_cadence_ledger`.
- Every ledger row has one `capital_surface`: `observe`, `no_notional_repair`, `paper_candidate`,
  `live_micro_candidate`, or `live_scale_candidate`.
- Every row has one `admission_decision`: `allow`, `repair_only`, `hold`, or `block`.
- A row can cite multiple evidence surfaces, but it must pick one canonical authority settlement.
- `serve_readonly` and `torghut_observe` remain allowed when Jangar serving, database status, watches, and controller
  heartbeats are current.
- `dispatch_repair` can run only finite no-notional repairs while capital is held.
- `dispatch_normal`, `merge_ready`, `paper_canary`, `live_micro_canary`, and `live_scale` require converged authority
  surfaces, current source and rollout truth, complete Torghut cohort receipts, and no unresolved capital blockers.
- A failed repair cadence produces an explicit `cooldown_until`, not another immediate scheduled retry.
- Deployer output can reject an action with one ledger ID, one cohort ID, one capital surface, and finite reason codes.

## Evidence Snapshot

Evidence was collected read-only on 2026-05-07 between 22:08Z and 22:11Z. I did not mutate Kubernetes resources,
database records, ClickHouse tables, GitOps resources, AgentRun objects, broker state, empirical artifacts, or trading
flags.

### Cluster Evidence

- The branch was `codex/swarm-torghut-quant-discover`, based on `main` at
  `068aec918 chore(torghut): promote image 70b00284 (#5971)`.
- `kubectl config current-context` returned `current-context is not set`, but namespace, pod, deployment, service, and
  event reads succeeded as the in-cluster service account.
- Jangar namespace pods were running: `jangar`, `bumba`, `jangar-alloy`, `jangar-db`, `open-webui`,
  `symphony`, and `symphony-jangar`.
- Agents namespace showed `agents=1/1`, `agents-controllers=2/2`, and `agents-alloy=1/1`.
- Recent Agents events still recorded readiness probe timeouts on `agents` and both `agents-controllers` pods.
- Torghut live revision `torghut-00285` and simulation revision `torghut-sim-00385` were `2/2 Running` on
  `registry.ide-newton.ts.net/lab/torghut@sha256:65eed94f51fc8aa5159d52a424413188e63a14fcc217a5307b73f9a625a4d7a4`.
- Torghut events showed transient startup/readiness probe failures during revision handoff, an etcd status update
  timeout for `podautoscaler/torghut-00284`, multiple ClickHouse PDB matches, and a retained
  `torghut-whitepaper-autoresearch-profit-target-8r6w6` Error pod.
- The service account could not list CNPG clusters or StatefulSets in the relevant namespaces and could not exec into
  Postgres or ClickHouse pods. That limits direct table-level inspection in this pass.

### Data And Control Evidence

- Torghut `/healthz` returned `{"status":"ok","service":"torghut"}`.
- Torghut `/db-check` returned `ok=true`, current and expected Alembic head
  `0029_whitepaper_embedding_dimension_4096`, one expected head, one current head, no duplicate revisions, no orphan
  parents, and known parent-fork warnings at `0010_execution_provenance_and_governance_trace` and
  `0015_whitepaper_workflow_tables`.
- Torghut `/readyz` and `/trading/health` returned `status=degraded`, with Postgres, ClickHouse, Alpaca, and universe
  healthy.
- Jangar quant evidence for account `PA3SX7FYNUTF` and window `15m` had `latest_metrics_count=144`,
  `latest_metrics_updated_at=2026-05-07T22:10:25.550Z`, and `metrics_pipeline_lag_seconds=6`, but `stage_count=0` and
  reason `quant_pipeline_stages_missing`.
- Torghut empirical jobs were healthy in the endpoint witness and cited
  `chip-paper-microbar-composite@execution-proof` over dataset `torghut-chip-full-day-20260505-4c330ce9-r1`.
- Torghut proof floor remained `repair_only`, route state `repair_only`, capital state `zero_notional`, and max
  notional `0`.
- Runtime blockers were `hypothesis_not_promotion_eligible`, `execution_tca_route_universe_incomplete`,
  `market_context_stale`, and `simple_submit_disabled`.
- The route book had one probing symbol, four blocked symbols, and three missing symbols. A separate TCA summary still
  reported one routeable symbol, which is exactly the type of cross-surface contradiction the ledger must settle.

### Source Evidence

- `services/jangar/src/server/control-plane-status.ts` is 787 lines and assembles many authority surfaces in one
  response.
- `services/jangar/src/server/torghut-quant-metrics.ts` is 928 lines and already distinguishes latest metric
  freshness from stage coverage.
- `services/jangar/src/server/control-plane-route-stability-escrow.ts` is 490 lines and already separates read-only
  actions from dispatch and capital actions.
- `services/jangar/src/server/control-plane-source-rollout-truth-exchange.ts` is 632 lines and already records source
  and image truth blockers.
- The missing design contract is not another raw collector. It is the reducer that binds these facts into a finite
  repair cadence and a capital-surface decision.

## Problem

Jangar has become good at exposing facts, but the consumer still has to infer the safe action from multiple surfaces.
That breaks down in this run state:

1. Pods are ready, but recent events show probe and status-update instability.
2. Database schema is current, but direct database inspection is not available to this service account.
3. Quant latest metrics are fresh, but quant stage receipts are empty.
4. Empirical jobs are fresh, but routeability, alpha readiness, market context, and live submit remain blocked.
5. A healthy read route can coexist with a capital hold.

The control plane should represent that as one admitted cadence: observe now, run bounded no-notional repair next,
then re-check before widening. It should not let each scheduler rediscover the same blocker class.

## Alternatives Considered

### Option A: Freeze All Non-Read-Only Work

Pros:

- Maximally fail-closed.
- Simple to implement in deployer and scheduler code.
- Avoids spending runtime on repairs while authority surfaces disagree.

Cons:

- It leaves stale market context, missing stage receipts, and route edge repair untouched.
- It creates pressure for manual exceptions.
- It does not improve future option value because no repair evidence is generated.

Decision: reject as the default. It remains the correct fallback if database, controller heartbeat, watches, or source
truth become unavailable.

### Option B: Treat Healthy Pods And Schema As Normal Dispatch Authority

Pros:

- Fastest way to resume scheduled work.
- Makes recent rollout success visible immediately.
- Uses existing readiness and status routes.

Cons:

- It ignores the degraded Torghut proof floor.
- It would conflate observation health with capital safety.
- It repeats failed or low-value jobs without requiring before/after repair receipts.

Decision: reject. This is how the system accumulates evidence debt.

### Option C: Admit Repair By Cadence And Capital Surface

Pros:

- Preserves observation and bounded repair while capital is closed.
- Converts transient runtime health and durable proof blockers into separate decisions.
- Gives deployers one finite object to cite when holding or widening.
- Creates before/after receipts that can be audited by engineer and deployer stages.

Cons:

- Adds a reducer and new tests.
- Slows widening after a green rollout.
- Requires all repair jobs to return typed receipts instead of only logs.

Decision: select Option C.

## Architecture

Add a pure `repair_cadence_ledger` reducer under `services/jangar/src/server/`. The reducer must not call Kubernetes,
databases, GitHub, NATS, or Torghut directly. It consumes already assembled evidence:

- Jangar authority-surface settlement.
- Route-stability escrow.
- Source rollout truth exchange.
- Watch reliability state.
- Controller heartbeat and ingestion state.
- Database migration status.
- Runtime kit and execution trust status.
- Torghut proof floor.
- Torghut quant stage cohort.
- Torghut route reacquisition book.
- Recent warning-event summaries when available.

Ledger fields:

- `ledger_id`
- `generated_at`
- `fresh_until`
- `namespace`
- `canonical_authority_surface_id`
- `capital_surface`
- `action_class`
- `admission_decision`
- `reason_codes`
- `allowed_repair_classes`
- `blocked_repair_classes`
- `cooldown_until`
- `required_return_receipts`
- `next_widening_gate`
- `rollback_target`

Repair classes:

- `refresh_market_context_domains`
- `materialize_quant_stage_receipts`
- `settle_route_edge_probe`
- `refresh_execution_tca_settlement`
- `clear_alpha_readiness_blockers`
- `close_autoresearch_error_artifact`
- `verify_controller_authority_surface`

Capital-surface rules:

- `observe`: allow when Jangar serving, database status, watch reliability, and controller heartbeat are current.
- `no_notional_repair`: allow only finite repair classes with receipt requirements and cooldown.
- `paper_candidate`: hold until Torghut cohort has stage coverage, fresh market context, route edge, TCA under
  guardrail, and promotion-eligible alpha readiness.
- `live_micro_candidate`: block until paper candidate has completed and live submit is explicitly enabled.
- `live_scale_candidate`: block until live micro has profit and rollback receipts over the required windows.

## Validation Gates

Engineer acceptance:

- Unit tests cover healthy observe plus degraded capital, missing quant stages, route-edge contradictions, stale market
  context, fresh empirical jobs with blocked capital, failed recent events with repair-only admission, and cooldown
  behavior after a failed repair.
- The reducer is pure and has no I/O.
- Status output contains finite reason codes and no free-text-only blockers.
- `dispatch_repair` cannot include paper or live notional when `capital_surface=no_notional_repair`.
- Routeable/probing disagreement produces a settlement reason code instead of being ignored.

Deployer acceptance:

- After rollout, `/ready` and `/api/agents/control-plane/status?namespace=agents` are reachable.
- The status payload has `repair_cadence_ledger.generated_at` within the expected freshness window.
- Read-only actions are allowed while paper/live are held in the current degraded Torghut state.
- A no-notional repair job emits all required return receipts or enters cooldown.
- Any missing ledger field, unknown action class, or non-finite reason list fails deployment widening.

Suggested local checks for the implementation PR:

- `bun run --filter @proompteng/jangar test -- services/jangar/src/server/__tests__/control-plane-status.test.ts`
- `bun run --filter @proompteng/jangar test -- services/jangar/src/server/__tests__/control-plane-route-stability-escrow.test.ts`
- `bunx oxfmt --check services/jangar/src/server services/jangar/src/server/__tests__`

## Rollout Plan

1. Ship the reducer behind additive status output only.
2. Let Jangar publish the ledger for read-only consumers for one full repair cadence without making it a hard gate.
3. Turn `dispatch_repair` admission on for no-notional repair classes that already have return receipts.
4. Require deployer widening to cite a current ledger before any paper candidate.
5. Keep live micro and live scale blocked until Torghut proves cohort completion and explicit live-submit readiness.

## Rollback Plan

Rollback is a GitOps/source rollback, not a local cluster mutation.

- If the ledger misclassifies read-only observation as blocked, revert the reducer change and fall back to the current
  route-stability escrow output.
- If the ledger admits repair without complete return receipt requirements, disable the repair consumer flag and keep
  only observation.
- If the ledger causes status latency or payload-size regressions, remove the additive field while preserving existing
  control-plane status fields.
- Capital rollback is always zero-notional: paper/live surfaces stay held until a later PR proves otherwise.

## Risks

- The service account still cannot directly inspect Postgres or ClickHouse. The smallest unblocker for deeper data
  inspection is read-only CNPG cluster access plus read-only SQL access or an approved typed data witness endpoint.
- The ledger can become another large status object if it repeats raw evidence. It should cite evidence IDs and compact
  summaries, not embed full payloads.
- Repair cadence can mask chronic failure if cooldowns are not visible. Cooldown and repeated-failure counts must be
  first-class fields.
- A green no-notional repair may still not open paper. That is acceptable and must be explicit in user-facing output.

## Handoff Contract

Engineer stage:

- Implement `repair_cadence_ledger` as a pure reducer with tests.
- Add it to control-plane status as an additive field.
- Add typed reason codes for route-edge contradiction, missing quant stages, market-context stale, alpha readiness
  blocked, live submit disabled, recent event debt, and database-inspection unavailable.
- Return no-notional repair receipt requirements for every admitted repair class.

Deployer stage:

- Validate that read-only observe remains available.
- Validate that no-notional repair is admitted only with receipt requirements.
- Validate that paper/live surfaces remain held in the current Torghut blocker set.
- Roll back by source/GitOps revert if status payloads regress or repair admission is broader than this contract.
