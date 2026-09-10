# 206. Jangar Material Evidence Settlement Spine And Repair Dispatch Budget (2026-05-14)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-14
Owner: Victor Chen, Jangar Engineering Architecture
Scope: Jangar material readiness, AgentRun failure debt, Torghut revenue-repair evidence custody, database witness
access, repair dispatch budgeting, validation, rollout, rollback, and cross-swarm handoff.

Companion Torghut contract:

- `docs/torghut/design-system/v6/212-torghut-revenue-repair-topline-contract-and-alpha-evidence-budget-2026-05-14.md`

Extends:

- `205-jangar-controller-ingestion-settlement-and-verification-carry-cutover-2026-05-14.md`
- `204-jangar-source-bound-verification-carry-exchange-and-repair-slot-reconciliation-2026-05-14.md`
- `203-jangar-foreclosure-carry-rollout-witness-and-stage-debt-repair-2026-05-14.md`
- `201-jangar-verify-trust-foreclosure-and-alpha-repair-reentry-2026-05-14.md`
- `188-jangar-ready-truth-arbiter-and-stage-credit-cutover-2026-05-13.md`
- `187-jangar-stage-credit-ledger-and-runner-slot-futures-2026-05-13.md`
- `163-jangar-scoped-evidence-debt-and-retained-failure-quarantine-2026-05-07.md`

## Decision

I am selecting a **material evidence settlement spine with a repair dispatch budget** as the next Jangar
control-plane architecture increment.

The live system is serving. At 2026-05-14T20:23Z to 20:26Z, Argo reported `agents`, `jangar`, and `torghut` as
`Synced/Healthy`. The `agents` deployment was `1/1` ready, `agents-controllers` was `2/2`, and the Jangar deployment
was `1/1`. `/ready` returned `status=ok`, fresh projection watermarks, healthy execution trust, and Torghut
`business_state=repair_only`. That is the right serving posture.

The material posture is not ready. The agents namespace had 344 pods: 72 `Failed`, 261 `Succeeded`, and 11 `Running`.
The failed container reasons were 64 `Error` and 8 `OOMKilled`. Jobs showed 204 total, 32 failed-only, and 7 active.
AgentRuns showed 886 total: 724 `Succeeded`, 132 `Failed`, 11 `Pending`, 7 `Running`, and 12 templates. Recent
AgentRun failures were dominated by `BackoffLimitExceeded` and `ProviderCapacityExhausted`. The full status payload
held `dispatch_normal`, `deploy_widen`, `merge_ready`, and `paper_canary`, while blocking `dispatch_repair`,
`live_micro_canary`, and `live_scale`.

The most dangerous split is evidence semantics, not workload availability. `/ready` surfaced the Torghut top repair as
`repair_alpha_readiness`, value gate `routeable_candidate_count`, and required receipt
`torghut.executable-alpha-receipts.v1`. A direct read of `/trading/revenue-repair` returned
`business_state=repair_only` and the same first queue item, but the top-level `top_repair_queue_item`,
routeable-candidate counts, route-warrant state, evidence-clock state, and repair-bid settlement fields were absent or
null on that endpoint. Jangar full status then emitted reasons such as `business_state_missing` and
`revenue_repair_top_item_missing` while the serving endpoint had current business evidence. That is not a trading
decision; it is a transport and projection custody gap.

The selected design adds a single additive object:
`jangar.material-evidence-settlement-spine.v1`. It joins serving readiness, full material status, controller-ingestion
settlement, terminal failure debt, database witness health, Argo and deployment rollout facts, Torghut consumer
evidence, Torghut revenue-repair topline evidence, and stage credit. It then produces a repair dispatch budget with
one selected zero-notional lane, or no lane, and explains the difference between:

- serving truth: Jangar can answer read-only requests;
- material truth: Jangar can safely launch, widen, merge, or dispatch repair work;
- transport truth: an upstream evidence endpoint timed out, returned partial fields, or disagreed with another
  endpoint;
- business truth: Torghut is deliberately `repair_only`, routeable candidates are zero, or capital must remain zero;
- audit truth: retained failures remain visible without blocking new work by themselves.

The tradeoff is strictness. Some useful-looking repair work will stay held until its evidence packet is current,
source-bound, and budgeted. I accept that. The business metric is to reduce failed AgentRuns and shorten green
PR-to-healthy GitOps rollout time, not to keep every scheduler active.

## Runtime Requirements

This contract implements the active swarm validation contract:

- every run must cite the governing design or runtime requirement before changing code;
- implement stages must produce production PRs with tests or report the exact blocker to code;
- verify stages must merge only green PRs and prove Argo, workload readiness, and service health after rollout;
- final handoff must name the control-plane metric improved or the smallest blocker preventing improvement.

Value-gate mapping:

- `failed_agentrun_rate`: failed pods, jobs, and AgentRuns are classified as active debt, retained audit debt, or
  collection debt before any stage is admitted.
- `pr_to_rollout_latency`: deployer evidence is reduced to one source-to-serving settlement packet with source SHA,
  live image, Argo sync, deployment readiness, service health, and material gate decision.
- `ready_status_truth`: `/ready.status=ok` remains serving truth; material actions read the settlement decision.
- `manual_intervention_count`: operators stop comparing `/ready`, full status, Argo, Torghut, and database witnesses
  by hand.
- `handoff_evidence_quality`: every engineer and deployer handoff cites settlement id, selected repair budget,
  validation commands, and rollback target.

Torghut value-gate mapping:

- `routeable_candidate_count`: the selected repair lane must target the live alpha-readiness queue item or a named
  prerequisite to that item.
- `zero_notional_or_stale_evidence_rate`: missing, stale, or split evidence keeps repair budget at zero or one
  bounded zero-notional ticket.
- `fill_tca_or_slippage_quality`: execution TCA work competes only when it is a named release condition for the alpha
  lane.
- `post_cost_daily_net_pnl`: no paper or live capital follows from this settlement.
- `capital_gate_safety`: every admitted repair ticket carries `max_notional=0`; live submission remains disabled.

## Current Evidence

All evidence below was collected read-only on 2026-05-14. I did not mutate Kubernetes resources, database records,
GitOps resources, AgentRuns, trading flags, broker state, or market data.

### Cluster, Rollout, And Events

- Working branch: `codex/swarm-jangar-control-plane-plan` at `57095de61842f69a8dce99b09afec438c46a5945`, matching
  `origin/main` when this pass started.
- Argo CD reported `agents=Synced/Healthy`, `jangar=Synced/Healthy`, and `torghut=Synced/Healthy`.
- `agents` deployment: `1/1`, image
  `registry.ide-newton.ts.net/lab/jangar-control-plane:2fa5bf6d@sha256:2441f0658e8bd91f9d48f8fb862c3d4fe11503f2bcab425f349392a6f10b467c`.
- `agents-controllers` deployment: `2/2`, image
  `registry.ide-newton.ts.net/lab/jangar:2fa5bf6d@sha256:7415690c826f7a6674eea3dbc90fa779f3d5dc00f5c64dc8040e447c126b636e`.
- `jangar` deployment: `1/1`, same Jangar image plus Docker sidecar; `bumba` was updated but had no ready/available
  status in the deployment summary.
- Torghut live revision `torghut-00417` and sim revision `torghut-sim-00512` were running with `2/2` containers.
- Recent agents events included a rollout replacement, readiness probe timeouts on old and current pods, two
  `BackoffLimitExceeded` cron jobs at the same schedule minute, and later successful cron completions.
- Agents namespace retained 72 failed pods and 32 failed-only jobs. AgentRun status retained 132 failed runs and 7
  running runs.

### Jangar Control Plane

- `GET http://agents.agents.svc.cluster.local/ready` returned `status=ok`, service `jangar`, leader election active,
  `business_state=repair_only`, `revenue_ready=false`, and `affected_value_gate=routeable_candidate_count`.
- `/ready.top_repair_queue_item` was `repair_alpha_readiness` with reason
  `hypothesis_not_promotion_eligible`, priority `70`, required receipt
  `torghut.executable-alpha-receipts.v1`, and `max_notional=0`.
- `/ready.execution_trust.status=healthy`; projection watermarks for `jangar_ready`, `control_plane_status`, and
  `deploy_verification` were fresh.
- `GET http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status?namespace=agents` reported
  `ready_truth_arbiter.serving_readiness=ok` and `ready_truth_arbiter.material_readiness=hold`.
- Full status allowed `serve_readonly` and `torghut_observe`; held `dispatch_normal`, `deploy_widen`,
  `merge_ready`, and `paper_canary`; and blocked `dispatch_repair`, `live_micro_canary`, and `live_scale`.
- Full status reason codes included controller witness split, stage credit hold, source rollout truth hold,
  route-stability hold, empirical job degradation, Torghut repair-only state, and revenue-repair custody denial.
- The status reducer also emitted `business_state_missing` and `revenue_repair_top_item_missing` even though `/ready`
  had a top repair item. That is the exact projection split this design targets.

### Database And Data Quality

- Jangar status database witness was healthy: `configured=true`, `connected=true`, latency `3ms`, registered
  migrations `29`, applied migrations `29`, unapplied `0`, unexpected `0`, latest
  `20260508_torghut_quant_pipeline_health_account_window_created_at_index`.
- Torghut `/db-check` returned `ok=true`, `schema_current=true`, no missing heads, no unexpected heads, head delta
  count `0`, and `schema_graph_lineage_ready=true`.
- Torghut `/readyz` returned HTTP `503` with `status=degraded` because `live_submission_gate=simple_submit_disabled`
  and `profitability_proof_floor=repair_only`. Postgres, ClickHouse, Alpaca, database schema, static universe, and
  quant evidence were acceptable for observation.
- Torghut database lineage still reported parent-fork warnings for
  `0010_execution_provenance_and_governance_trace` and `0015_whitepaper_workflow_tables`.
- Direct SQL access was blocked by RBAC, which is acceptable for normal swarm workers but important audit evidence:
  `pods "jangar-db-1" is forbidden: User "system:serviceaccount:agents:agents-sa" cannot create resource "pods/exec"
in API group "" in the namespace "jangar"`.
- Secret enumeration was also blocked:
  `secrets is forbidden: User "system:serviceaccount:agents:agents-sa" cannot list resource "secrets" in API group ""
in the namespace "jangar"`.

### Torghut Business Evidence

- `GET http://torghut.torghut.svc.cluster.local/trading/revenue-repair` returned
  `business_state=repair_only`.
- The endpoint did not return a top-level `top_repair_queue_item` in the direct read, but `repair_queue[0]` was
  `repair_alpha_readiness`, reason `hypothesis_not_promotion_eligible`, dimension `alpha_readiness`, priority
  `70`, value gate `routeable_candidate_count`, required receipt `torghut.executable-alpha-receipts.v1`, and
  `max_notional=0`.
- The next queue items were `live_submit_gate_closed`, `repair_empirical_jobs`, `repair_degraded`, and
  `repair_empirical_jobs_not_ready`, all under `max_notional=0`.
- Torghut `/readyz` alpha readiness showed 3 hypotheses, 0 promotion-eligible hypotheses, H-MICRO-01 as the only
  lineage-ready candidate, stale or missing alpha evidence, empirical jobs not ready, and stale market-context
  domains.
- Torghut pods showed live and sim services running, but many retained failed profit-feedback and whitepaper
  autoresearch pods. Those should be audit debt unless they enter the current material action window.

### Source And Test Surface

- Jangar status assembly is `services/jangar/src/server/control-plane-status.ts` (773 lines).
- Jangar ready route is `services/jangar/src/routes/ready.tsx` (419 lines).
- Controller-ingestion settlement is `services/jangar/src/server/control-plane-controller-ingestion-settlement.ts`
  (321 lines).
- Terminal debt compaction is `services/jangar/src/server/control-plane-terminal-debt-compaction.ts` (642 lines).
- Torghut revenue repair digest is `services/torghut/app/trading/revenue_repair.py` (1208 lines).
- Torghut no-delta auction is `services/torghut/app/trading/no_delta_repair_reentry_auction.py` (891 lines).
- Torghut API assembly is `services/torghut/app/main.py` (7102 lines), a high-risk integration point.
- Existing Jangar tests cover controller witness, stage clearance, ready truth, terminal debt, revenue repair custody,
  material gate digest, verify trust foreclosure, controller-ingestion settlement, and status assembly.
- Missing test family: material evidence settlement spine, transport-vs-business split, revenue-repair topline
  fallback, active-vs-retained failure budget, database witness RBAC blocker, and single repair dispatch budget.

## Problem

Jangar has enough individual evidence surfaces to make a correct decision, but they are not yet settled into one
transport-aware material contract.

The concrete failure modes are:

1. `/ready.status=ok` can be mistaken for broad dispatch or merge readiness.
2. A direct Torghut revenue-repair read can omit top-level fields that `/ready` already carries, causing Jangar to
   report business evidence missing instead of transport evidence partial.
3. Retained failed pods, jobs, and AgentRuns can pressure material decisions without being separated from fresh
   active failure debt.
4. Argo and deployments can be healthy while stage credit holds normal work for source rollout truth, controller
   witness, route stability, or Torghut repair-only state.
5. Database schema currentness can be healthy while direct SQL access remains intentionally unavailable to the
   worker, which makes service-owned witness endpoints the only acceptable evidence path.
6. Torghut alpha readiness is the live business target, but broad repair dispatch can still spend capacity on stale
   or duplicate no-delta work.

The control plane needs one material settlement spine that normalizes these surfaces before any action class is
admitted.

## Alternatives Considered

### Option A: Keep Existing Ready Truth And Stage Credit As Separate Gates

This option leaves `/ready`, full status, stage credit, controller-ingestion settlement, and Torghut revenue repair as
separate read models.

Advantages:

- Lowest implementation cost.
- Keeps existing tests and consumers stable.
- Operators can still inspect every underlying reducer.

Disadvantages:

- It preserves the observed `business_state_missing` split.
- It leaves humans to decide whether missing fields are transport gaps or business blockers.
- It does not give schedulers one repair budget.
- It will not reduce duplicate or stale AgentRuns by itself.

Decision: reject as architecture. Keep the read models, but add a settlement spine above them.

### Option B: Hard Freeze All Non-Serving Work Until Every Surface Is Clean

This option blocks normal dispatch, repair dispatch, deploy widening, and merge-ready claims while any retained
failure, Torghut degraded readiness, or missing revenue-repair field exists.

Advantages:

- Strongest short-term failure-rate reduction.
- Simple to explain.
- Prevents stale retries.

Disadvantages:

- It blocks the bounded zero-notional repair work needed to clear the alpha-readiness queue.
- It turns retained audit debt into manual intervention.
- It conflates Torghut's correct capital-safety `503` with service outage.
- It delays green PR-to-healthy rollout when serving evidence is good but material proof is narrow.

Decision: reject. The control plane needs a budget, not a blanket freeze.

### Option C: Material Evidence Settlement Spine With Repair Dispatch Budget

This option adds one additive settlement object that joins serving, material, transport, business, database, rollout,
and failure debt evidence.

Advantages:

- Directly addresses the observed evidence split.
- Keeps serving readiness independent from material action authority.
- Lets retained failures stay visible without automatically blocking work.
- Budgets at most one zero-notional repair lane when evidence is good enough.
- Gives engineer and deployer stages one acceptance packet.
- Keeps Torghut alpha readiness and `routeable_candidate_count` as the business target.

Disadvantages:

- Adds another reducer and test surface.
- Requires Torghut to export a stricter revenue-repair topline contract.
- May hold useful work when transport evidence is partial.

Decision: accept.

## Architecture Contract

`jangar.material-evidence-settlement-spine.v1` is additive. It must not replace `/ready`, full status, stage credit,
controller-ingestion settlement, terminal debt, or Torghut consumer evidence in the first rollout.

Minimum fields:

- `settlement_id`, `schema_version`, `mode`, `namespace`, `generated_at`, `fresh_until`.
- `governing_design_refs` including this document and the companion Torghut contract.
- `serving_truth`: `/ready` status, execution trust, leader election, projection watermarks.
- `material_truth`: ready-truth arbiter decisions, stage-credit account decisions, controller-ingestion settlement,
  source-serving verdict, rollout proof passport, material gate digest.
- `transport_truth`: Torghut revenue-repair fetch status, consumer-evidence fetch status, timeout class, schema
  mismatch class, and projection source.
- `business_truth`: Torghut business state, revenue ready flag, top repair queue item, selected value gate, required
  receipt, routeable candidate counts, max notional, capital rule.
- `database_truth`: Jangar migration witness, Torghut schema witness, direct SQL access status, and whether direct
  database inspection is expected for the runtime.
- `failure_debt_truth`: active 15m, active 6h, retained 7d, collection error, and retained audit summary.
- `repair_dispatch_budget`: selected action class, selected repair ticket, max parallelism, max runtime seconds, max
  notional, validation commands, and rollback target.

Transport semantics:

- `business_state_missing` is allowed only when both consumer evidence and revenue repair lack a business state.
- If `/trading/revenue-repair.repair_queue[0]` exists while `top_repair_queue_item` is absent, record
  `topline_inferred_from_queue_head` and keep material actions in `hold` until Torghut emits the explicit field.
- If Torghut times out, record `revenue_repair_transport_timeout`; do not convert it to a business denial.
- If `/ready` and full status disagree, record `serving_material_split` with both evidence refs.
- If direct SQL is forbidden but service-owned database witnesses are healthy, record
  `database_direct_sql_forbidden_expected` and continue. If both service-owned witnesses are missing, hold.

Repair budget rules:

- `serve_readonly` remains `allow` when Jangar can answer read-only status and execution trust is not blocked.
- `torghut_observe` remains `allow` when Torghut evidence endpoints are current enough for observation.
- `dispatch_normal`, `deploy_widen`, and `merge_ready` require material settlement `allow`.
- `dispatch_repair` can be `repair_only` with exactly one selected ticket when all of the following are true:
  `max_notional=0`, top repair is alpha readiness or a named prerequisite, active 15m failure debt is clear or
  explicitly waived by the selected ticket, controller ingestion is current or the selected ticket repairs it, and
  revenue-repair transport is current or explicitly inferred from queue head.
- `live_micro_canary` and `live_scale` remain `block` while business state is `repair_only`, revenue is not ready, or
  Torghut max notional is zero.

## Implementation Scope

Engineer stage should implement this in three bounded changes:

1. Add `control-plane-material-evidence-settlement.ts` plus unit tests for transport split, top queue inference,
   active failure debt, retained audit debt, DB witness RBAC, and single repair budget.
2. Wire the settlement into `control-plane-status.ts`, `ready.tsx`, and the Jangar UI as observe-mode fields.
3. Update schedule-runner and supporting-primitives snapshots to stamp the settlement id on new AgentRuns, but keep
   enforcement in observe mode until deployer evidence proves parity.

The first code PR must not require direct pod exec or secret reads. It must rely on service-owned database witnesses
and Kubernetes list/watch/get surfaces already available to the agents service account.

## Validation Gates

Required local checks for Jangar implementation:

- `bun test services/jangar/src/server/__tests__/control-plane-material-evidence-settlement.test.ts`
- `bun test services/jangar/src/server/__tests__/control-plane-status.test.ts -t "material evidence settlement"`
- `bun test services/jangar/src/routes/ready.test.ts -t "material evidence settlement"`
- `bunx oxfmt --check services/jangar/src/server services/jangar/src/routes services/jangar/src/data`

Required live read-only checks after rollout:

- `kubectl get applications -n argocd agents jangar torghut`
- `kubectl get deploy -n agents`
- `kubectl get deploy -n jangar`
- `curl -fsS http://agents.agents.svc.cluster.local/ready | jq '.material_evidence_settlement_spine'`
- `curl -fsS 'http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status?namespace=agents' | jq
'.material_evidence_settlement_spine'`
- `curl -sS http://torghut.torghut.svc.cluster.local/readyz`
- `curl -fsS http://torghut.torghut.svc.cluster.local/trading/revenue-repair | jq
'{business_state,top_repair_queue_item,repair_queue}'`

Acceptance gates:

- `failed_agentrun_rate`: new normal/repair dispatch is held unless the settlement selects one current ticket.
- `pr_to_rollout_latency`: deployer packet contains source SHA, image digest, Argo sync, workload readiness, service
  health, and settlement decision.
- `ready_status_truth`: `/ready.status=ok` can coexist with material `hold` without ambiguity.
- `manual_intervention_count`: operator handoff can be completed from one settlement packet.
- `handoff_evidence_quality`: handoff cites governing design refs, validation commands, and rollback target.

## Rollout

1. Ship the reducer in observe mode:
   `JANGAR_MATERIAL_EVIDENCE_SETTLEMENT_MODE=observe`.
2. Emit the object on full status and `/ready`; do not change admission decisions on the first deployment.
3. Compare three consecutive refresh windows against ready truth, stage credit, and Torghut revenue repair.
4. If parity holds, allow schedule-runner and deployer handoffs to cite the settlement id.
5. Only after a green verify PR and deployer evidence should `dispatch_repair` consume the one-ticket budget.

## Rollback

Rollback is operationally simple because the contract is additive:

- set `JANGAR_MATERIAL_EVIDENCE_SETTLEMENT_MODE=observe` or ignore the object in consumers;
- keep ready truth, stage credit, controller-ingestion settlement, terminal debt, and Torghut revenue-repair custody as
  the active gates;
- keep Torghut `max_notional=0` and live submission disabled;
- do not delete retained debt records or Kubernetes jobs as part of rollback.

## Risks

- Torghut may keep returning partial topline fields; the companion contract makes that a typed transport hold instead
  of a business denial.
- A strict one-ticket budget can underuse available capacity. That is acceptable until failed AgentRun debt drops.
- Retained audit debt can hide a fresh failure if windows are wrong. The implementation must test 15m, 6h, and 7d
  classifications explicitly.
- Direct SQL remains unavailable to this worker identity. The design intentionally relies on service-owned DB witness
  endpoints.
- `business_state_missing` and `revenue_repair_top_item_missing` may already be consumed by downstream dashboards; the
  reducer must add new reason codes before removing or reclassifying old ones.

## Engineer Handoff

2026-05-14 implementation note:

- Jangar now emits observe-mode `material_evidence_settlement_spine` on full control-plane status and `/ready`.
- The reducer distinguishes stale, missing, unavailable, schema-mismatched, summary-only, and queue-head-inferred
  Torghut revenue-repair topline evidence before selecting a repair budget.
- The first implementation keeps enforcement additive: it can select one zero-notional `dispatch_repair` ticket for
  alpha readiness or controller-ingestion repair, but global block conditions such as nonzero notional evidence
  dominate any selected ticket.
- Local coverage now includes queue-head inference, material-gate duplicate no-delta holds, controller-ingestion
  repair budgeting, nonzero-notional blocking, status projection, and `/ready` projection. Schedule-runner stamping
  remains a later observe-mode consumer step after deployer parity evidence.

Next implementation milestone:

- Objective: implement observe-mode `material_evidence_settlement_spine` in Jangar and add a Torghut topline parser
  that distinguishes transport gaps from business repair-only truth.
- Files likely changed: `services/jangar/src/server/control-plane-material-evidence-settlement.ts`,
  `services/jangar/src/server/control-plane-status.ts`, `services/jangar/src/routes/ready.tsx`,
  `services/jangar/src/server/control-plane-status-types.ts`, and focused tests under `services/jangar/src/server/__tests__`.
- Production gate: one selected repair budget or a typed hold; never broad dispatch from partial Torghut evidence.
- Required evidence: local tests above plus live `/ready` and full-status settlement payload after deployment.

2026-05-14 scheduler trace follow-up:

- Schedule-runner launch validation now copies the current `material_evidence_settlement_spine` id, decision, mode,
  freshness, reason codes, selected repair ticket, value gate, business state, max notional, and governing design refs
  into new `AgentRun`/`OrchestrationRun` annotations and parameters when a fresh status snapshot is available.
- Supporting-primitives stage-clearance snapshots expose the same material-evidence trace in launch admission status, so
  schedule and requirement handoffs can cite the material authority packet that governed a launch attempt.
- Enforcement remains observe-mode and additive. If the settlement is missing or stale, existing runtime admission,
  stage clearance, stage credit, evidence pressure, and Torghut zero-notional gates remain authoritative.

2026-05-14 revenue-repair custody alignment follow-up:

- The revenue-repair custody reducer now treats three alpha evidence shapes as valid settlement evidence:
  `alpha_readiness_settlement_conveyor`, `alpha_repair_closure_board`, and
  `executable_alpha_repair_receipts.selected_receipt`.
- When Torghut consumer evidence carries a current queue head, custody derives `repair_only` from that queue instead
  of reporting `business_state_missing`; this removes a false transport-missing signal from ready truth while
  preserving material holds.
- If the current closure board has an active no-delta budget or pending no-delta settlement market, custody returns
  `deny` with the active release key and closure-board reason codes. It does not convert no-delta evidence into a
  repair budget.
- The implementation remains additive to the material settlement spine and keeps Torghut `max_notional=0` as a hard
  safety condition.

## Deployer Handoff

After engineer PR merge and image promotion, deployer must prove:

- Argo `agents`, `jangar`, and `torghut` are `Synced/Healthy`.
- `agents` and `agents-controllers` deployments are ready.
- Jangar `/ready` is HTTP 200 with serving readiness `ok`.
- Full status contains `material_evidence_settlement_spine.mode=observe`.
- The settlement names the same Torghut top repair as `/trading/revenue-repair`.
- Live and paper capital remain blocked or held while `business_state=repair_only` and `max_notional=0`.
