# 198. Jangar Material Gate Digest And Alpha Closure Carry (2026-05-14)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-14
Owner: Victor Chen, Jangar Engineering Architecture
Scope: Jangar material-readiness proof, Torghut compact closure evidence carry, AgentRun launch admission, status-route
latency, zero-notional no-delta custody, validation, rollout, rollback, and implementation handoff.

Companion Torghut contract:

- `docs/torghut/design-system/v6/203-torghut-alpha-closure-dividend-slo-and-consumer-evidence-carry-2026-05-14.md`

Extends:

- `docs/agents/designs/197-jangar-compact-alpha-closure-ingestion-and-stage-credit-repair-gate-2026-05-14.md`
- `docs/agents/designs/197-jangar-alpha-evidence-foreclosure-governor-and-runner-custody-2026-05-14.md`
- `docs/torghut/design-system/v6/202-torghut-compact-alpha-closure-export-and-no-delta-lease-2026-05-14.md`
- `docs/torghut/design-system/v6/202-torghut-alpha-evidence-foreclosure-and-routeable-candidate-reentry-2026-05-14.md`
- `docs/agents/designs/188-jangar-ready-truth-arbiter-and-stage-credit-cutover-2026-05-13.md`

## Decision

I am selecting a **material gate digest with alpha closure carry** as the next Jangar control-plane architecture
increment.

The evidence points to a projection problem, not a lack of proof. On 2026-05-14, Argo reported `agents`, `jangar`,
and `torghut` `Synced/Healthy` at `60ea7ce8935a77676696b415bcd16fddbedd0575`. The service pods were available:
`agents=1/1`, `agents-controllers=2/2`, `jangar=1/1`, Torghut live revision `torghut-00377=2/2`, and Torghut sim
revision `torghut-sim-00475=2/2`. `GET http://agents.agents.svc.cluster.local/ready` returned `status=ok`,
leader-election active, execution trust healthy, and Torghut consumer evidence current.

That is serving truth. It is not material launch truth. The same `/ready` payload exposed `business_state=repair_only`,
`revenue_ready=false`, top repair queue item `repair_alpha_readiness`, value gate `routeable_candidate_count`, and
`max_notional=0`. Jangar's repair-bid admission stayed in `observe` mode with `status=block`, but it still emitted a
launch-allowed dispatch ticket for `compacted-repair-lot:f7db48978857ae33628f`, lot class `promotion_custody`, and
dedupe key `PA3SX7FYNUTF:15m:promotion_custody`.

Torghut now has the missing negative evidence. `GET /trading/consumer-evidence` includes compact
`torghut.alpha-repair-closure-board-ref.v1` with selected hypothesis `H-MICRO-01`, selected value gate
`routeable_candidate_count`, settlement market `alpha-closure-settlement-market:89e028004ab04284dd5c7cac`,
required settlement receipt `torghut.alpha-closure-settlement-receipt.v1`, active dedupe key
`26ad0e6f5062ffa349b21e8a`, `no_delta_budget_state=consumed`, `no_delta_debt_count=1`, and `max_notional=0`.
Jangar `/ready` does not carry that board ref yet; its observed contract list still stops at
`executable_alpha_repair_receipts`. That is why a generic repair dispatch ticket can look allowed even while the
current closure market says the same evidence window consumed its no-delta budget.

The material status route is also too expensive for the hot path. Two read-only attempts to call
`/api/agents/control-plane/status?namespace=agents` with a 10 second client timeout returned no bytes. That route is
still valuable for diagnostics, but launch admission and deployer proof cannot depend on a full reducer pass that may
time out while `/ready` stays green.

The selected design introduces a small `jangar.material-gate-digest.v1` projection. It is built from already typed
inputs: serving readiness, repair-bid admission, source/rollout truth when available, database witness status,
Torghut consumer evidence, and the compact alpha closure board ref. It is small enough to serve from `/ready` and
stable enough for schedule runners, implement stages, verify stages, and deployers to cite. The digest carries the
decision for each material action class plus the alpha closure carry that explains whether a zero-notional repair
slot is allowed, held, or denied.

The tradeoff is strict pre-launch denial when the digest is stale or missing. I accept that tradeoff. The business
metric is fewer failed AgentRuns and shorter green PR-to-healthy GitOps rollout time, not higher runner start volume.
A fast serving endpoint that says "hold because no-delta debt is active" is more useful than a slow full status route
plus another failed repair pod.

## Governing Runtime Requirements

This contract implements the active swarm validation requirements:

- every run must cite the governing design or runtime requirement before changing code;
- implement stages must produce production PRs with tests or report the exact blocker to code;
- verify stages must merge only green PRs and prove Argo, workload readiness, and service health after rollout;
- final handoff must name the control-plane metric improved or the smallest blocker preventing improvement.

Value-gate mapping:

- `failed_agentrun_rate`: unchanged or consumed alpha closure keys deny launch before creating another runner pod.
- `pr_to_rollout_latency`: deployer verification can read one bounded digest from `/ready` instead of waiting on the
  full material status route.
- `ready_status_truth`: `/ready=ok` stays serving truth, while `material_gate_digest.decision` is material truth.
- `manual_intervention_count`: operators get one selected closure carry, one no-delta state, one release condition set,
  and one next implementation action.
- `handoff_evidence_quality`: engineer and deployer handoffs cite the digest id, source revision, Argo revision,
  Torghut board id, settlement market id, no-delta state, validation command, and rollback target.

## Current Evidence

All evidence was collected read-only on 2026-05-14. I did not mutate Kubernetes resources, database rows, trading
flags, broker state, GitOps resources, AgentRuns, or market data.

### Cluster, Rollout, And Runner Debt

- Work branch: `codex/swarm-jangar-control-plane-plan`, based on `origin/main`.
- Kubernetes identity: `system:serviceaccount:agents:agents-sa`. The local kube context was bootstrapped as
  `in-cluster` from the service-account token because no current context was configured.
- Argo applications `agents`, `jangar`, and `torghut` were `Synced/Healthy` at
  `60ea7ce8935a77676696b415bcd16fddbedd0575`.
- Workloads were available: `agents=1/1`, `agents-controllers=2/2`, `jangar=1/1`, `bumba=1/1`, Torghut live
  `torghut-00377=2/2`, and Torghut sim `torghut-sim-00475=2/2`.
- AgentRuns created since `2026-05-14T00:00:00Z` showed 22 total, with 18 `Succeeded`, 2 `Failed`, and 2 `Running`.
  Jangar control-plane had 11 total with 10 `Succeeded`, 1 `Running`, and 0 failed. Torghut quant had 11 total with
  8 `Succeeded`, 2 `Failed`, and 1 `Running`; the failures were implement and verify `BackoffLimitExceeded`.
- Pods in the agents namespace created since `2026-05-14T00:00:00Z` showed 114 total, with 37 `Succeeded`,
  72 `Failed`, and 5 `Running`; terminated container reasons included 68 `Error` and 4 `OOMKilled`. That is the
  launch-pressure tail this digest should reduce.
- Recent events showed normal rollout churn and readiness probe noise while images were replaced, then successful
  starts for the current agents, Jangar, and Torghut revisions.

### Ready, Business, And Material Truth

- `GET http://agents.agents.svc.cluster.local/ready` returned `status=ok`, leader election active, and execution trust
  healthy.
- The same payload reported `business_state=repair_only`, `revenue_ready=false`, and top repair queue item
  `repair_alpha_readiness` for `hypothesis_not_promotion_eligible`.
- The affected value gate was `routeable_candidate_count`; the required output receipt was
  `torghut.executable-alpha-receipts.v1`; capital remained `zero_notional_repair_only`.
- Jangar repair-bid admission was `mode=observe` and `status=block`, but still produced a launch-allowed
  `promotion_custody` dispatch ticket for dedupe key `PA3SX7FYNUTF:15m:promotion_custody`.
- Two calls to `GET /api/agents/control-plane/status?namespace=agents` with a 10 second timeout returned no bytes.
  The full status route should remain diagnostic, not a launch hot path.
- Jangar did not project Torghut's compact alpha closure board into `/ready`; its observed contracts still omitted
  `alpha_repair_closure_board` and `alpha_evidence_foundry`.

### Torghut Business And Data State

- `GET http://torghut.torghut.svc.cluster.local/db-check` returned a current schema witness: current head
  `0031_autoresearch_candidate_spec_epoch_uniqueness`, one schema graph branch, no lineage errors, and only known
  parent-fork warnings under historical migration roots.
- `GET /readyz` returned HTTP 503 with `status=degraded`, which is the correct capital-safe state while live submit is
  disabled and no hypothesis is promotion eligible.
- `GET /trading/revenue-repair` returned `business_state=repair_only`, `revenue_ready=false`, queue count 5, and top
  queue item `repair_alpha_readiness`.
- The full alpha closure board was selected, with selected value gate `routeable_candidate_count`, settlement market
  `alpha-closure-settlement-market:89e028004ab04284dd5c7cac`, selected hypothesis `H-MICRO-01`, repair class
  `feature_replay_closure`, required settlement receipt `torghut.alpha-closure-settlement-receipt.v1`, and
  no-delta budget `consumed`.
- The pending settlement receipt preserved `drift_checks_missing`, `feature_rows_missing`,
  `required_feature_set_unavailable`, and `closed_session_signal_hold`; routeable candidate count stayed `0`;
  `next_allowed_attempt_after` was `2026-05-14T04:53:40.994334+00:00`.
- `GET /trading/consumer-evidence` already emitted compact `torghut.alpha-repair-closure-board-ref.v1` with
  `no_delta_budget_state=consumed`, `no_delta_debt_count=1`, and `max_notional=0`.

### Source Architecture And Test Gaps

- Jangar high-risk modules remain broad: `supporting-primitives-controller.ts` is 3312 lines,
  `control-plane-torghut-consumer-evidence.ts` is 784 lines, `control-plane-status.ts` is 757 lines,
  `control-plane-stage-credit-ledger.ts` is 594 lines, and `control-plane-repair-bid-admission.ts` is 440 lines.
- Torghut high-risk modules are also broad: `app/main.py` is 6925 lines, `revenue_repair.py` is 1111 lines,
  `alpha_repair_closure_board.py` is 820 lines, `repair_bid_settlement.py` is 716 lines, and
  `alpha_evidence_foundry.py` is 608 lines.
- Existing tests cover many individual reducers, including ready truth, stage credit, repair-bid admission, Torghut
  consumer evidence, alpha closure boards, and revenue repair. The missing cross-plane test family is material gate
  digest behavior: current board ref, missing board ref, stale board ref, consumed no-delta budget, nonzero notional,
  full status timeout fallback, and source/rollout mismatch.

## Problem

Jangar has reached a split-brain point between serving health and material launch proof.

The concrete failure modes are:

1. `/ready=ok` can coexist with `repair_only`, zero-notional capital, and active Torghut no-delta debt.
2. The full material status route can exceed a 10 second client timeout, which makes it poor as a scheduler or deployer
   hot path.
3. Torghut now exposes compact alpha closure refs, but Jangar's `/ready` projection does not carry them.
4. Jangar can emit a launch-allowed repair ticket from repair-bid settlement while Torghut's closure market says the
   current evidence window consumed its no-delta budget.
5. AgentRun objects look mostly healthy in the current window, while pod-level runner debt shows 72 failed pods since
   midnight. The launch gate must see both material truth and runner debt before starting more work.
6. Deployer handoff has to stitch together Argo, workload readiness, `/ready`, full status, `/db-check`,
   `/trading/revenue-repair`, and `/trading/consumer-evidence` manually.

The system needs a small material gate digest that is fast enough for launch admission and rich enough to prevent the
wrong zero-notional repair from launching.

## Alternatives Considered

### Option A: Keep The Full Status Route As The Material Gate

Jangar would continue to require `/api/agents/control-plane/status?namespace=agents` for launch and deployer proof.

Advantages:

- No new status object.
- Preserves the richest diagnostic view.
- Keeps existing reducer ownership.

Disadvantages:

- The route timed out at 10 seconds in this evidence window.
- Schedule runners need a bounded proof surface, not a full diagnostic reducer pass.
- Deployer proof remains slow and manual.
- The route still needs Torghut compact closure carry before it can deny no-delta repeats.

Decision: reject as the hot path. Keep it for diagnostics and backfill.

### Option B: Broaden Stage Clearance Until All Proof Surfaces Are Green

This option keeps every material action held until status, source, rollout, Torghut, and database witnesses are green.

Advantages:

- Simple and conservative.
- Avoids accidental capital or rollout widening.
- Keeps the current safety posture intact.

Disadvantages:

- Deadlocks zero-notional repairs that are required to clear the top revenue blocker.
- Does not explain why a specific repair is denied.
- Increases manual exceptions.
- Does not improve deployer latency.

Decision: reject as the default. It remains the emergency rollback posture.

### Option C: Add A Material Gate Digest With Alpha Closure Carry

Jangar builds a small digest from existing typed inputs and serves it through `/ready` and the status route. Schedule
runners and deployers use the digest, while full status remains diagnostic.

Advantages:

- Converts no-delta debt into pre-launch denial.
- Gives deployers one bounded proof object.
- Keeps serving readiness separate from material readiness.
- Lets Jangar use Torghut compact evidence without polling full revenue repair on every decision.
- Reduces repeated runner starts when proof cannot change the value gate.

Disadvantages:

- Adds a compatibility surface that needs tests.
- Requires shadow comparison before enforcement.
- Can over-hold repair work if the digest is stale or the compact board ref is missing.

Decision: select Option C.

## Architecture

Jangar emits `jangar.material-gate-digest.v1`.

```text
jangar.material-gate-digest.v1
  digest_id
  generated_at
  fresh_until
  producer_revision
  serving_readiness
  material_readiness
  action_class_decisions[]
    action_class
    decision: allow | hold | deny | block
    reason_codes[]
    source_refs[]
    validation_refs[]
    rollback_target
  alpha_closure_carry
    schema_version: jangar.alpha-closure-carry.v1
    source: torghut.consumer-evidence
    board_id
    settlement_market_id
    selected_hypothesis_id
    selected_value_gate
    required_settlement_receipt
    active_dedupe_key
    no_delta_budget_state
    no_delta_debt_count
    next_allowed_attempt_after
    max_notional
    capital_rule
    decision
    release_conditions[]
  rollout_truth_ref
  database_witness_ref
  runner_debt_summary
```

The digest is intentionally smaller than full control-plane status.

Inputs:

- Jangar serving readiness from `/ready`.
- Jangar repair-bid admission state.
- Torghut consumer evidence compact `alpha_repair_closure_board` and `alpha_evidence_foundry` refs.
- Torghut `/db-check` status through the existing application witness path.
- Argo revision and workload readiness when cached or already available.
- Runner debt summary from AgentRun and pod status caches.
- Full control-plane status only as a background enrichment source, never as a synchronous requirement for serving the
  digest.

Decision rules:

- `serve_readonly` can allow when serving readiness is ok and the digest is fresh.
- `torghut_observe` can allow when Torghut consumer evidence is current, even while capital remains zero.
- `dispatch_repair` holds when the compact closure ref is missing, stale, nonzero-notional, wrong value gate, or has
  consumed no-delta budget.
- `dispatch_repair` can allow exactly one zero-notional repair only when the compact closure ref is fresh, no-delta
  budget is available, the dedupe key is inactive, and the validation command is present.
- `dispatch_normal`, `deploy_widen`, `merge_ready`, `paper_canary`, `live_micro_canary`, and `live_scale` remain held
  or blocked while `business_state=repair_only`, `revenue_ready=false`, or source/rollout proof is unsettled.
- If the full status route times out, the digest records `full_status_unavailable` but does not make serving readiness
  fail. Material actions fail closed.

## Validation Plan

Engineer stage must add focused tests before enforcement:

- Jangar parses `torghut.alpha-repair-closure-board-ref.v1` from consumer evidence.
- Missing, stale, wrong-gate, nonzero-notional, and consumed no-delta refs hold `dispatch_repair`.
- A fresh available no-delta budget allows exactly one zero-notional repair ticket and stamps the selected board id.
- Full status timeout does not fail `/ready`, but it marks material action classes held.
- Source/rollout mismatch keeps `deploy_widen` and `merge_ready` held even when repair observe is allowed.
- Runner debt is surfaced in the digest but does not override capital safety.

Targeted commands for the implementation PR:

- `bun --cwd services/jangar run test -- src/server/__tests__/control-plane-torghut-consumer-evidence.test.ts`
- `bun --cwd services/jangar run test -- src/server/__tests__/control-plane-repair-bid-admission.test.ts`
- `bun --cwd services/jangar run test -- src/routes/ready.test.ts`
- `bun --cwd services/jangar run tsc`

Deployer validation:

- `kubectl get application -n argocd agents jangar torghut -o wide`
- `kubectl rollout status -n agents deployment/agents`
- `kubectl rollout status -n agents deployment/agents-controllers`
- `kubectl rollout status -n jangar deployment/jangar`
- `curl -fsS http://agents.agents.svc.cluster.local/ready | jq .material_gate_digest`
- `curl -fsS http://torghut.torghut.svc.cluster.local/trading/consumer-evidence | jq .alpha_repair_closure_board`
- `curl -sS -w '\n%{http_code}\n' http://torghut.torghut.svc.cluster.local/readyz`

## Rollout

Phase 0 is observe-only. Emit the digest on `/ready` and the full status route, compare it against existing ready
truth and repair-bid admission, and record mismatches as diagnostics.

Phase 1 holds duplicate `dispatch_repair` when the compact alpha closure ref is missing, stale, or no-delta consumed.
No CronJob or AgentRun launch behavior changes for normal, deploy, merge, paper, or live classes.

Phase 2 lets exactly one fresh zero-notional repair slot launch when the closure carry is current and no-delta budget
is available. The launch must stamp the digest id, board id, settlement market id, active dedupe key, and required
receipt.

Phase 3 allows deployer stages to treat the digest as the primary material readiness proof for green PR-to-healthy
rollout handoff. Full status remains required for debugging when the digest reports stale or unavailable inputs.

## Rollback

- Set `JANGAR_MATERIAL_GATE_DIGEST_MODE=disabled` or equivalent config.
- Keep `/ready` serving readiness unchanged.
- Keep existing ready truth, stage credit, repair-bid admission, and Torghut consumer evidence reducers active.
- Keep Torghut max notional at `0` and live submit disabled.
- Do not delete AgentRuns, jobs, database rows, no-delta receipts, or closure boards.
- Revert to emergency posture: hold `dispatch_repair`, `dispatch_normal`, `deploy_widen`, `merge_ready`,
  `paper_canary`, and live action classes until full status and Torghut evidence are manually verified.

## Risks

- A stale digest could over-hold useful zero-notional repairs. Mitigation: short freshness window and explicit
  `digest_stale` reason.
- A compact board schema mismatch could hide Torghut evidence. Mitigation: observe-mode comparison against
  `/trading/consumer-evidence` and full `/trading/revenue-repair`.
- A fast digest could be mistaken for capital authority. Mitigation: every action decision carries `max_notional=0`
  and paper/live action classes stay held or blocked while Torghut is repair-only.
- Full status route slowness could mask a deeper reducer regression. Mitigation: keep a separate diagnostic SLO for
  the full route and alert when it exceeds the deployer budget.

## Engineer And Deployer Handoff

Next engineer milestone: implement the additive material gate digest in observe mode, parse Torghut compact alpha
closure refs into Jangar consumer evidence, and make consumed no-delta budget visible on `/ready`.

Acceptance gates:

- `/ready` includes `material_gate_digest`.
- The digest carries the Torghut board id, settlement market id, selected hypothesis, active dedupe key,
  no-delta state, max notional, and capital rule.
- Current live evidence produces `dispatch_repair=hold` or `deny` because no-delta budget is consumed.
- The existing repair-bid dispatch ticket is no longer the only visible launch proof.
- Tests cover current, missing, stale, wrong-gate, nonzero-notional, consumed no-delta, and full-status-timeout cases.

Next deployer milestone: after the implementation PR merges, prove Argo, workload readiness, `/ready` digest presence,
Torghut consumer evidence board ref, Torghut `/db-check`, and Torghut repair-only capital safety. The metric improved
first is `failed_agentrun_rate`; the smallest blocker for revenue impact remains `routeable_candidate_count=0` until
Torghut settles a feature replay receipt that retires H-MICRO-01 feature evidence blockers.
