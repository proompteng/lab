# 185. Jangar Clearance Market And Rollout Truth Settlement (2026-05-12)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-12
Owner: Victor Chen, Jangar Engineering
Scope: Jangar control-plane reliability, AgentRun failure reduction, PR-to-GitOps rollout latency, ready-status truth,
Torghut repair dispatch, database evidence quality, validation gates, rollout, rollback, and cross-stage handoff.

Companion Torghut contract:

- `docs/torghut/design-system/v6/189-torghut-repair-yield-market-and-profit-hypothesis-guardrails-2026-05-12.md`

Extends:

- `docs/agents/designs/184-jangar-reliability-settlement-ledger-and-rollout-slo-escrow-2026-05-12.md`
- `docs/agents/designs/184-jangar-rollout-custody-and-evidence-clock-dispatch-2026-05-12.md`
- `docs/agents/designs/swarm-agentic-mission-architecture-2026-05-08.md`
- `docs/jangar/build-contract.md`
- `services/jangar/README.md`

## Decision

I am selecting a **Jangar clearance market with rollout truth settlement** as the next architecture increment.

The evidence says the system does not need another generic status page. It needs an admission object that names which
repair buys down which control-plane risk, which action classes remain blocked, and which rollout facts must be true
before a PR can be called operationally healthy. Jangar already has strong ingredients: control-plane status, execution
trust, runtime admission passports, stage-clearance packets, watch reliability, rollout health, database migration
consistency, material action verdicts, and Torghut consumer evidence. The gap is that these facts can disagree and still
produce ambiguous operator behavior.

The selected design adds a market-style read model. It does not buy or sell anything externally. It ranks bounded
repair lots by value gate, failure-mode reduction, evidence cost, rollout risk, and notional safety. The output is a
`clearance_market_ledger` on the Jangar control-plane status payload and a `rollout_truth_settlement` for deployer
handoff. Schedulers and deployers then cite the same object before launching work, widening rollout, or claiming
merge-ready.

The tradeoff is deliberate friction. Some implement or verify stages will be held even when the Jangar deployment is
ready. I accept that because the business metric is reducing failed AgentRuns and shortening green PR-to-healthy GitOps
rollout time. A held run with a typed repair lot is cheaper than another opaque failed run.

## Governing Runtime Requirements

This document binds the current swarm validation contract to implementation behavior:

- every run must cite the governing design or runtime requirement before changing code;
- implement stages must produce production PRs with tests or report the exact blocker to code;
- verify stages must merge only green PRs and prove Argo, workload readiness, and service health after rollout;
- final handoff must name the control-plane metric improved or the smallest blocker preventing improvement.

Every milestone below maps to at least one value gate:

- `failed_agentrun_rate`
- `pr_to_rollout_latency`
- `ready_status_truth`
- `manual_intervention_count`
- `handoff_evidence_quality`

## Evidence Snapshot

All evidence in this pass was collected read-only on 2026-05-12. I did not mutate Kubernetes resources, database
records, GitOps resources, AgentRuns, broker state, Torghut flags, or trading data.

### Cluster And Rollout Evidence

- Runtime inputs resolved to repository `proompteng/lab`, base `main`, head
  `codex/swarm-jangar-control-plane-discover`, stage `discover`, NATS channel `general`, mission ledger
  `/workspace/.agentrun/swarm/jangar-control-plane-mission-ledger.md`, and business metric "reduce failed AgentRuns and
  shorten green PR-to-healthy GitOps rollout time for the Jangar control plane".
- The local branch was rebased onto current `origin/main` at `62a8f5f6d634da0478bc5d23aa0b0e6dca10bb2e` before this
  artifact was authored.
- NATS context soak read `workflow.general.>` and returned no prior general-channel messages to inherit.
- Memory retrieval through `bun run --filter memories retrieve-memory ...` failed with
  `Jangar memory retrieve failed (500): {"error":"retrieve memories failed: Unable to connect. Is the computer able to access the url?"}`.
- Kubernetes auth resolved to `system:serviceaccount:agents:agents-sa`. Cluster-scope node listing was forbidden, CNPG
  pod exec was forbidden, CNPG cluster listing was forbidden, and StatefulSet listing was forbidden in `jangar` and
  `torghut`. Those denials are useful evidence: direct database and cluster internals are not the normal control-plane
  proof mode for this worker.
- Argo current state after rollout settled: `jangar=Synced/Healthy`, `agents=Synced/Progressing`,
  `torghut=OutOfSync/Degraded`, and `torghut-options=Synced/Degraded`, all at Git revision
  `62a8f5f6d634da0478bc5d23aa0b0e6dca10bb2e`.
- `deployment/jangar` recovered to `1/1` with runtime image
  `registry.ide-newton.ts.net/lab/jangar:887ab0d4@sha256:baa7ff7e4347f4162f2d8388a96cf3ddf45d007cce6c32d15eff36897a65f1e4`.
  The earlier rollout window had `jangar` with no endpoint and `PodInitializing`; that split is exactly why rollout
  truth must be settled rather than inferred from a single poll.
- `deployment/agents` was `0/1` available while `deployment/agents-controllers` was `2/2` available. Jangar status
  derived controller health from the controller rollout, but the agents API pod logs showed repeated PostgreSQL
  connection timeouts and metrics export `ConnectionRefused` to Mimir.
- In the last six hours, Kubernetes AgentRun state for `jangar-control-plane` showed 14 succeeded, 5 running, and 1
  failed run. Across retained `jangar-control-plane` runs, the same source showed 254 succeeded and 49 failed.
- The Jangar database resource projection had much more retained failure debt: `agents_control_plane.resources_current`
  contained 3,163 failed workflow AgentRun resources, 441 failed job AgentRun resources, 34 running workflow resources,
  11 pending job resources, and current sightings within the assessment window.
- Agents namespace events showed repeated scheduling pressure, failed market-context jobs, failed control-plane
  implement jobs, and `BackoffLimitExceeded` for a recent `jangar-control-plane-implement` attempt.

### Source Evidence

- `services/jangar/src/server/control-plane-status.ts` already assembles the control-plane truth surface. It has tests
  for database migration consistency, watch reliability, execution trust, source rollout truth, material action
  verdicts, split-topology controller rollout, and runtime admission.
- `services/jangar/src/server/control-plane-stage-clearance.ts` and the README now project stage-clearance packets and
  runtime admission snapshots, but the current live payload still allows swarm passports with reason
  `execution_trust_degraded`.
- `services/jangar/src/server/supporting-primitives-controller.ts` is over 3,000 lines and owns schedule admission,
  signal dispatch, and runtime passport enforcement. That is the high-risk implementation boundary; the next engineer
  milestone should add a narrow read model first, then gate scheduling through one small call site.
- `services/jangar/src/server/agents-controller/provider-capacity.ts` can classify provider capacity failures, and
  `services/jangar/src/server/control-plane-workflows.ts` can summarize workflow reliability. The missing piece is
  pricing those failures into stage-specific launch decisions and expiring them when repair evidence arrives.
- `services/jangar/src/server/control-plane-rollout-health.ts` evaluates configured deployments, but deployers still
  need a receipt that binds PR merge time, Argo revision, desired image, live image, route health, DB projection, and
  downstream Torghut proof into one latency measurement.
- `services/torghut/app/trading/consumer_evidence.py`, `profit_freshness_frontier.py`,
  `evidence_clock_arbiter.py`, `routeability_repair_acceptance.py`, and `proof_floor.py` already encode the trading
  evidence Jangar should consume. Jangar should not reimplement capital judgment.

### Database And Data Evidence

- Jangar Postgres connected read-only as database `jangar` on PostgreSQL 17.0. It exposed 99 sampled non-system tables,
  including `agents_control_plane`, `jangar_github`, `memories`, `workflow_comms`, and `torghut_control_plane`.
- Jangar migration state was consistent: `kysely_migration` had 29 applied migrations, latest
  `20260508_torghut_quant_pipeline_health_account_window_created_at_index`.
- Jangar `/api/agents/control-plane/status` reported `database.connected=true`, `database.status=healthy`,
  migration consistency `29/29`, watch reliability healthy with 782 recent watch events and zero watch errors, but
  `execution_trust.status=degraded` because implement and verify stage evidence was stale.
- The same status payload reported `agentrun_ingestion.status=unknown` with message `agents controller not started`,
  while controller health was derived from `agents-controllers` rollout. That authority split should be explicit.
- Jangar DB `public.agent_runs` contained 565 succeeded, 236 failed, 39 running, and 5 pending persisted runs.
- Jangar DB `memories.entries` had 1,176 entries, latest updated `2026-05-08T22:35:08Z`, using
  `qwen3-embedding-saigak:8b`, while the memory retrieve helper was still returning HTTP 500.
- Jangar DB market-context snapshots only covered `fundamentals` and `news`; no `technicals` or `regime` snapshots
  were present in that table. Recent run state still had failed and running provider jobs.
- Jangar DB `torghut_control_plane.quant_pipeline_health` had 2,841 recent `ingestion=false` rows in the last hour,
  with max lag `1,728,000` seconds. Compute rows were mostly healthy, which proves the danger of citing global compute
  freshness as capital readiness.
- Torghut Postgres connected read-only as database `torghut` on PostgreSQL 17.0. It exposed 73 sampled non-system
  tables. All 28 `vnext_empirical_job_runs` were completed and promotion-authority eligible, but the latest was
  `2026-05-08T21:54:41Z`, stale against the live consumer evidence policy.
- Torghut had three strategy metric windows, all `shadow`, `empirically_validated`, `continuity_ok=true`, and
  `drift_ok=true`, latest `2026-05-06T22:34:19Z`; one strategy promotion decision existed and it was `allowed=false`.
- Torghut `research_candidates`, `research_promotions`, and `evidence_receipts` were empty in this database snapshot.
- Torghut TCA had 13,775 rows, latest computed `2026-05-08T02:42:07Z`, average absolute slippage about 13.76 bps.
  Execution rows were older, latest order update `2026-04-03T05:32:38Z`.
- Torghut `/trading/consumer-evidence` was current but repair-only: profit freshness had 9 dimensions, only 2 current,
  7 active repair lots, selected repair `refresh_stale_market_context_domains`, zero paper/live notional, and no
  accepted routeable candidate.

## Problem

Jangar's control plane now has enough evidence to be precise, but the admission posture is still ambiguous when the
facts split:

1. `jangar` can be `Synced/Healthy` while `agents` is `Progressing` and the agents API pod cannot connect to the DB.
2. Controller health can be derived from `agents-controllers` rollout while `agentrun_ingestion` says the controller is
   not started.
3. Runtime passports can allow launches while execution trust is degraded.
4. Quant compute can be fresh while ingestion and materialization clocks are stale.
5. Torghut consumer evidence can be current while all capital remains zero-notional.
6. PR checks can be green while Argo, route health, DB projection, or downstream proof are not settled.

The result is false readiness. False readiness raises failed AgentRun rate, increases manual intervention, and makes
green PR-to-healthy rollout latency hard to measure.

## Alternatives Considered

### Option A: Immediately Enforce Existing Stage-Clearance Packets

The control plane already has stage-clearance and runtime-admission surfaces. We could turn enforcement from shadow to
hold/block and stop there.

Advantages:

- Lowest implementation cost.
- Uses existing status fields and tests.
- Directly reduces some failed launches.

Disadvantages:

- It does not rank the smallest repair when several evidence clocks disagree.
- It does not attach deployer rollout latency and rollback evidence.
- It can over-block read-only or zero-notional repair work.

Decision: use as an enforcement consumer, but not as the full architecture.

### Option B: Freeze All Jangar And Torghut Work During Degraded Rollout

Block every non-read-only action while any of `jangar`, `agents`, `torghut`, or `torghut-options` is degraded.

Advantages:

- Very safe during outages.
- Easy to explain.
- Strong short-term failure reduction.

Disadvantages:

- It blocks the repair work needed to clear stale Torghut evidence.
- It treats live capital, paper canary, zero-notional repair, and docs-only deployer work as equal risk.
- It pushes operators back to manual exceptions.

Decision: keep as an emergency posture, not the default operating model.

### Option C: Clearance Market With Rollout Truth Settlement

Jangar emits an action-class clearance market and deployer rollout settlement. The market ranks repair lots and allows
only the action class that buys down the named blocker under explicit guardrails.

Advantages:

- Converts failure debt and stale proof into typed launch posture before more failed runs are created.
- Allows bounded zero-notional repair while blocking normal dispatch, deploy widening, and live capital.
- Gives deployers one receipt for PR-to-rollout latency and rollback proof.
- Keeps Torghut capital truth in Torghut while making Jangar responsible for dispatch safety.
- Maps every milestone to business value gates.

Disadvantages:

- Adds one more reducer and payload section.
- Requires careful TTLs so historical debt expires after repair evidence.
- Requires scheduler adoption after the read model is tested.

Decision: select Option C.

## Architecture

Jangar emits one `clearance_market_ledger` per control-plane status generation.

```text
clearance_market_ledger
  schema_version = jangar.clearance-market.v1
  ledger_id
  namespace
  generated_at
  fresh_until
  governing_design_refs[]
  observed_revision
  evidence_mode
  authority_splits[]
  retained_failure_debt[]
  rollout_truth_settlement
  action_clearance[]
  repair_lots[]
  stage_admission[]
  handoff_contract
```

`authority_splits` records contradictions, not just failures. The current live split would be:

```text
agents-api-rollout: deployment/agents unavailable
agents-controller-rollout: deployment/agents-controllers available
agentrun-ingestion: unknown, agents controller not started
runtime-passports: allow with execution_trust_degraded
torghut-capital: zero_notional repair_only
```

`action_clearance` is action-class scoped:

```text
serve_readonly       allow when Jangar route, DB projection, and read-only dependencies are healthy
dispatch_repair      allow only with a selected zero-notional repair lot and bounded runtime
dispatch_normal      hold on stale execution trust, stale Torghut proof, or agents API outage
paper_canary         hold until selected repair lots settle and paper guardrails are current
deploy_widen         hold until rollout truth settlement is current and healthy
merge_ready          hold for operational readiness until CI, Argo, route, DB, and downstream proof agree
live_micro_canary    block unless Torghut capital gates explicitly allow and Jangar route truth is current
live_scale           block until paper/live canary evidence has matured
```

`repair_lots` use a simple score:

```text
score = value_gate_weight + failure_reduction_weight + freshness_unlock_weight
        - rollout_risk - evidence_cost - notional_risk
```

The market is intentionally conservative. A repair lot can launch only if it names:

- the value gate it improves;
- the current blocker evidence;
- the expected output receipt;
- the max parallelism and runtime;
- the notional limit;
- the rollback target.

`rollout_truth_settlement` binds PR and runtime facts:

```text
rollout_truth_settlement
  source_head_sha
  pr_number
  merged_at
  gitops_revision
  argo_app_statuses
  desired_images
  live_images
  deployment_availability
  route_health
  database_projection
  downstream_evidence
  pr_to_rollout_latency_seconds
  decision
  blockers[]
```

## Implementation Scope

### Milestone 1: Shadow Read Model

Add `services/jangar/src/server/control-plane-clearance-market.ts` and project it from
`/api/agents/control-plane/status`.

Acceptance gates:

- `ready_status_truth`: status payload includes authority splits when deployment health, controller authority, DB
  projection, and stage trust disagree.
- `failed_agentrun_rate`: retained failure debt includes at least 15-minute, 6-hour, and 7-day windows.
- `handoff_evidence_quality`: every action clearance cites design refs and runtime evidence refs.

Tests:

- agents API unavailable but agents-controllers available produces an authority split;
- execution trust degraded converts normal dispatch and merge-ready to `hold`;
- Torghut zero-notional repair-only state allows only `dispatch_repair`;
- stale quant ingestion blocks normal Torghut dispatch even when compute is fresh;
- RBAC-limited CNPG evidence is represented as route/database-projection mode, not as missing DB evidence.

### Milestone 2: Scheduler Hold Mode

Wire `supporting-primitives-controller` and schedule-runner launch paths to read `stage_admission`.

Acceptance gates:

- `failed_agentrun_rate`: held stages do not create doomed AgentRuns; they emit a typed skipped/held reason.
- `manual_intervention_count`: held stage output includes the smallest repair lot and command evidence needed to clear
  it.
- `handoff_evidence_quality`: held stage status contains the clearance ledger id.

Rollout: start in shadow, then hold mode for `implement` and `verify`, then expand to `discover` and `plan`.

### Milestone 3: Torghut Repair Lot Consumption

Consume Torghut repair-yield-market output and route selected zero-notional lots through Jangar dispatch.

Acceptance gates:

- `failed_agentrun_rate`: market-context repair dispatch obeys max parallelism and cooldowns.
- `ready_status_truth`: normal dispatch stays held while repair lots are unsettled.
- `manual_intervention_count`: the selected repair action is visible without reading raw Torghut JSON.

### Milestone 4: Deployer Rollout Truth Settlement

Add deployer collection for PR merge time, GitOps revision, Argo health, deployment readiness, route health, DB
projection, and downstream Torghut proof.

Acceptance gates:

- `pr_to_rollout_latency`: every runtime PR has a measured green PR-to-healthy GitOps rollout timestamp or a typed
  blocker.
- `ready_status_truth`: rollout cannot be claimed healthy from Argo sync alone.
- `handoff_evidence_quality`: deployer handoff names the rollout truth settlement id and rollback target.

## Rollout Plan

1. Ship the read model in shadow with no scheduling behavior changes.
2. Publish NATS summaries that include ledger id, decision, top blocker, selected repair lot, and next action.
3. Enable hold mode only for `implement` and `verify` after tests prove false-ready splits are represented.
4. Enable `dispatch_repair` for zero-notional Torghut lots with max parallelism 1 per repair dimension.
5. Require rollout truth settlement for deployer ready claims after two successful shadow deploys.

## Rollback Plan

- Disable read-model projection with `JANGAR_CLEARANCE_MARKET_ENABLED=false`.
- Disable scheduler consumption with `JANGAR_STAGE_CLEARANCE_ENFORCEMENT=disabled`.
- Keep existing material action verdicts and runtime admission passports as the fallback authority.
- If status payload size or latency regresses, remove the new field from the API response before changing scheduler
  behavior.
- If repair dispatch over-holds safe work, keep `serve_readonly` allowed and revert only the action-class consumer.

## Risks

- Historical failure debt can over-block if TTLs are too long. Mitigation: provider-capacity and stale-stage debt must
  expire on current successful evidence.
- The status payload is already dense. Mitigation: project compact summaries first and keep detailed lot evidence behind
  evidence refs.
- Scheduler integration touches a large module. Mitigation: milestone 1 is read-only; milestone 2 changes one bounded
  admission function with tests.
- Torghut repair scores can be gamed if expected value is not tied to receipts. Mitigation: scores must cite data
  receipts and remain zero-notional until guardrails clear.

## Engineer Handoff

Objective: implement the shadow `clearance_market_ledger` read model and status projection.

Files to inspect first:

- `services/jangar/src/server/control-plane-status.ts`
- `services/jangar/src/server/control-plane-stage-clearance.ts`
- `services/jangar/src/server/control-plane-material-action-verdict.ts`
- `services/jangar/src/server/control-plane-torghut-consumer-evidence.ts`
- `services/jangar/src/server/supporting-primitives-controller.ts`
- `services/jangar/src/server/__tests__/control-plane-status.test.ts`

Acceptance gates:

- status projection includes authority splits and action clearance;
- tests cover split rollout, stale execution trust, stale Torghut proof, and zero-notional repair allow;
- no scheduler enforcement until the read model is visible and tested.

## Deployer Handoff

Objective: prove rollout truth before claiming a PR ready.

Required evidence:

- GitHub PR number, merge timestamp, and merge commit;
- Argo app sync/health for `jangar`, `agents`, and any touched Torghut app;
- deployment availability and live image digest;
- `/health` and `/api/agents/control-plane/status` route evidence;
- database migration consistency and DB projection health;
- Torghut consumer evidence posture if a Torghut repair or dispatch surface changes;
- rollback command or rollback PR target.

Ready means green CI plus current rollout truth. It does not mean Argo `Synced` alone.
