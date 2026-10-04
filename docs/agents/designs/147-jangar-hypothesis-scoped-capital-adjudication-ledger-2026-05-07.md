# 147. Jangar Hypothesis-Scoped Capital Adjudication Ledger (2026-05-07)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-07
Owner: Gideon Park, Torghut Traders Architecture
Scope: Jangar control-plane resilience, Torghut capital admission, proof-floor verdict consumption, forecast-debt
scoping, validation, rollout, rollback, and engineer/deployer handoff.

Companion Torghut contract:

- `docs/torghut/design-system/v6/151-torghut-hypothesis-scoped-capital-adjudication-and-profit-gates-2026-05-07.md`

Extends:

- `146-jangar-repair-warrant-exchange-and-schedule-debt-firebreak-2026-05-07.md`
- `145-jangar-observation-epoch-tripwire-and-capital-contradiction-arbiter-2026-05-07.md`
- `144-jangar-capital-evidence-return-lane-and-paper-gate-witness-quorum-2026-05-07.md`
- `docs/torghut/design-system/v6/150-torghut-repair-dividend-order-book-and-capital-warrants-2026-05-07.md`

## Decision

I am selecting **a hypothesis-scoped capital adjudication ledger in Jangar** as the next control-plane architecture
step.

The control plane has recovered enough to arbitrate. At `2026-05-07T13:10Z`, Argo CD reported `jangar`, `agents`, and
`torghut` as `Synced` and `Healthy`; `agents` and `agents-controllers` rolled out successfully; Jangar database
projection was connected and migration-current; workflow debt was zero in the 15 minute window; runtime kits were
healthy, including the NATS collaboration tools; controller heartbeats were fresh; watch reliability was healthy; and
material-action verdicts were being produced.

Torghut is still correctly held at zero notional. Live `/readyz` returned HTTP 503, live `/trading/status` returned
HTTP 200 for revision `torghut-00259`, and the proof floor stayed `repair_only` with blockers for alpha readiness,
execution TCA slippage, stale market context, and the disabled live-submit gate. Simulation status was reachable, but
simulation `/readyz` timed out and simulation quant latest metrics were empty.

The current Jangar verdict is safe but too coarse. `paper_canary` is held by `torghut_consumer_evidence_missing` plus
`forecast_service_degraded`; `live_micro_canary` is held for the same reasons; and `live_scale` is blocked by paper
settlement plus forecast debt. That shape hides the important distinction between:

- a hypothesis that is blocked by its own stale or bad proof;
- a hypothesis that does not depend on forecast authority;
- a service-wide forecast registry gap; and
- missing Torghut consumer evidence.

The design makes Jangar capital decisions hypothesis-scoped. Jangar remains the authority for action-class admission,
but it no longer treats Torghut as a single generic consumer. It consumes Torghut proof-floor verdicts per hypothesis,
account, action class, and evidence dimension, then emits a capital ledger that explains exactly which hypothesis can
observe, repair, paper-test, live-micro-test, or scale.

The tradeoff is a more specific reducer and schema. I accept it because the alternative is either over-blocking
profitable paper repair behind unrelated forecast debt or under-blocking live capital behind generic evidence labels.

## Runtime Objective And Success Metrics

Success means:

- Jangar publishes `hypothesis_capital_adjudication` in control-plane status.
- Each ledger row has `ledger_id`, `generated_at`, `account_label`, `torghut_revision`, `hypothesis_id`,
  `strategy_family`, `action_class`, `decision`, `max_dispatches`, `max_runtime_seconds`, `max_notional`,
  `confidence`, `fresh_until`, `blocking_reason_codes`, `downgrade_reason_codes`, `required_repair_actions`,
  `source_proof_refs`, `forecast_dependency`, `rollback_target`, and `contradiction_refs`.
- `torghut_consumer_evidence_missing` is replaced with concrete reason codes when a fresh Torghut proof-floor verdict
  exists.
- `forecast_service_degraded` blocks only hypotheses and action classes that declare forecast authority as required.
- `torghut_observe` remains allowed while control-plane health is clean.
- `proof_repair` remains zero-notional and can be admitted for a blocked hypothesis when Jangar's repair warrant is
  open.
- `paper_canary` remains closed until all required proof dimensions for a specific hypothesis pass.
- `live_micro_canary` requires prior paper settlement for the same hypothesis and account.
- `live_scale` requires live micro settlement, expected-shortfall coverage, and no rollback-required state.

## Read-Only Evidence Snapshot

I collected this evidence without mutating Kubernetes resources, database records, trading flags, broker state,
AgentRun objects, GitOps resources, or empirical artifacts.

### Cluster And Rollout Evidence

- The branch `codex/swarm-torghut-quant-discover` was clean and based on `origin/main`.
- The in-cluster identity was `system:serviceaccount:agents:agents-sa`.
- `kubectl get applications.argoproj.io -n argocd jangar agents torghut -o wide` reported all three applications
  `Synced` and `Healthy`.
- `kubectl get pods -n jangar -o wide` showed the Jangar app pod `2/2 Running`; Jangar Postgres, Redis, Open WebUI,
  Alloy, Bumba, and Symphony pods were also running.
- `kubectl rollout status -n agents deployment/agents` and `deployment/agents-controllers` both succeeded.
- `kubectl get pods -n agents --no-headers` counted `9` Running, `174` Completed, and `60` Error pods, so historical
  schedule debt still exists even though the current rollout is healthy.
- Recent Agents events showed a fresh rollout to image `93f80673` and readiness 503s only on old controller pods
  during scale-down.
- `kubectl get pods -n torghut -o wide` showed live revision `torghut-00259` and simulation revision
  `torghut-sim-00359` both `2/2 Running`; Torghut Postgres, ClickHouse, Keeper, TA, options, websocket, exporter,
  Alloy, and Symphony pods were running.
- Recent Torghut events showed startup/readiness probe failures during the latest rollout that cleared, plus ongoing
  duplicate ClickHouse PodDisruptionBudget warnings, Keeper `NoPods`, and FlinkDeployment status-modified warnings.
- Knative service listing in `torghut` was RBAC-blocked for the runner, so revision evidence came from pods, services,
  events, and typed routes.

### Jangar Control-Plane Evidence

- `GET /health` on Jangar returned HTTP 200 with `status=ok`.
- `GET /api/agents/control-plane/status?namespace=agents` returned a fresh status at `2026-05-07T13:10:57.315Z`.
- Database projection was configured, connected, healthy, and reported `latency_ms=22`.
- Migration consistency was healthy with `registered_count=28`, `applied_count=28`, `unapplied_count=0`, and latest
  migration `20260505_torghut_quant_pipeline_health_window_index`.
- Workflow status reported `active_job_runs=0`, `recent_failed_jobs=0`, and `backoff_limit_exceeded_jobs=0`.
- Runtime kits for serving and collaboration were healthy; collaboration included `codex-nats-publish`,
  `codex-nats-soak`, `nats`, workspace path, and `NATS_URL`.
- Controllers were healthy with fresh heartbeat authority for `agents-controller`, `supporting-controller`, and
  `orchestration-controller`.
- Watch reliability was healthy with two streams, more than 1,800 events, zero errors, and zero restarts.
- Material-action verdicts allowed `serve_readonly`, `dispatch_repair`, `dispatch_normal`, `deploy_widen`,
  `merge_ready`, and `torghut_observe`.
- `paper_canary` was held with `forecast_service_degraded` plus `torghut_consumer_evidence_missing`.
- `live_micro_canary` was held with `forecast_service_degraded` plus `torghut_consumer_evidence_missing`.
- `live_scale` was blocked by `paper_settlement_required` plus `forecast_service_degraded`.

### Torghut And Data Evidence

- Live `/healthz` returned HTTP 200; live `/readyz` returned HTTP 503.
- Live `/db-check` returned HTTP 200 with current Alembic head `0029_whitepaper_embedding_dimension_4096`.
- Schema lineage was ready with branch count `1`, no duplicate revisions, no orphan parents, and historic parent-fork
  warnings at `0010_execution_provenance_and_governance_trace` and `0015_whitepaper_workflow_tables`.
- Direct CNPG cluster listing in `torghut` was RBAC-blocked for `agents:agents-sa`, so this contract relies on typed
  database projections and service-owned read routes.
- Live `/trading/status` returned HTTP 200 for `mode=live`, active revision `torghut-00259`, build commit
  `0aa204cd446ba8ad24f4460eaa74d392a5ae3ea4`, `pipeline_mode=simple`, and `submit_enabled=false`.
- Live proof floor was `repair_only`, `capital_state=zero_notional`, `max_notional=0`, with blockers
  `hypothesis_not_promotion_eligible`, `execution_tca_slippage_guardrail_exceeded`, `market_context_stale`, and
  `simple_submit_disabled`.
- Live empirical jobs were healthy and promotion-authority eligible for candidate
  `chip-paper-microbar-composite@execution-proof` on dataset `torghut-chip-full-day-20260505-5e447b6d-r1`.
- Live TCA had `13,775` orders, average absolute slippage `568.6138848199565249` bps, an `8` bps guardrail, and
  expected-shortfall coverage `0`.
- Live quant evidence was degraded but informational: latest metrics count `144`, latest update
  `2026-05-07T13:09:33.290Z`, metrics pipeline lag about `30` seconds, and ingestion lag around `69,893` seconds.
- Live hypotheses totaled `3`; all were shadow, `0` were promotion eligible, and `3` required rollback.
- Simulation `/trading/status` returned HTTP 200 for `mode=paper` and revision `torghut-sim-00359`; simulation
  `/readyz` timed out after 12 seconds.
- Simulation proof floor was `repair_only`, simulation latest quant metrics were empty, stage count was `0`, average
  absolute TCA slippage was `17.4301320928571429` bps against an `8` bps guardrail, expected-shortfall coverage was
  `0`, and `3` executions were unsettled.

### Source Evidence

- `services/jangar/src/server/control-plane-status.ts` is `764` lines and remains the status assembly boundary.
- `services/jangar/src/server/control-plane-negative-evidence-router.ts` is `610` lines and already reduces generic
  Torghut consumer-evidence gaps.
- `services/jangar/src/server/control-plane-material-action-verdict.ts` is `473` lines and is the right consumer for
  final action-class decisions.
- `services/jangar/src/server/control-plane-action-clock.ts` is `276` lines and currently treats forecast degradation
  as broad empirical debt.
- `services/jangar/src/server/torghut-quant-runtime.ts` is `817` lines and should not become a capital admission
  reducer.
- Focused tests already cover control-plane status, material-action verdicts, negative evidence routing, action
  clocks, route stability escrow, runtime admission, empirical services, watch reliability, and Torghut quant runtime.

## Problem

Jangar is healthy enough to say "no", but not specific enough to say "no for this hypothesis because of this proof".

The current failure modes are:

1. A fresh Torghut proof floor can still be collapsed into `torghut_consumer_evidence_missing`.
2. `forecast_service_degraded` can hold every paper path even when a hypothesis does not require forecast authority.
3. Simulation and live accounts have different proof failures, but Jangar action-class verdicts do not expose that
   account split.
4. Engineers cannot tell whether to fix alpha readiness, TCA, market context, quant latest-store, or forecast registry
   first from the Jangar capital verdict alone.
5. Deployer gates remain safe but slow because they have to hand-join Jangar verdicts with Torghut proof-floor
   payloads.

## Alternatives Considered

### Option A: Keep Generic Capital Holds Until Every Service Is Green

Pros:

- Operationally conservative.
- Minimal Jangar code change.
- Avoids schema work.

Cons:

- Over-blocks paper repair behind unrelated forecast or consumer-evidence labels.
- Does not tell engineers which hypothesis can be repaired next.
- Makes profitability hostage to service-wide readiness rather than proof dimensions.

Decision: reject. This is safe but leaves too much future option value unused.

### Option B: Let Torghut Decide Paper Capital Locally

Pros:

- Torghut is closest to TCA, hypotheses, market context, and empirical data.
- Faster path from proof repair to paper testing.
- Avoids Jangar trading-specific reducers.

Cons:

- Torghut cannot see Jangar rollout health, schedule debt, runtime kits, watches, or controller heartbeats with the
  same authority.
- It would blur the line between profit evidence and control-plane admission.
- Live guardrails would become harder to audit.

Decision: reject as the authority model. Torghut should produce adjudication facts; Jangar should admit actions.

### Option C: Add A Jangar Hypothesis-Scoped Capital Ledger

Pros:

- Keeps Jangar as the admission authority while using concrete Torghut proof facts.
- Converts generic blockers into account, hypothesis, action-class, and dimension-specific verdicts.
- Lets forecast debt block only forecast-dependent hypotheses.
- Gives deployers a single status section to validate without opening privileged database or broker access.
- Preserves zero-notional repair and live-capital guardrails.

Cons:

- Adds a new reducer and fixture surface.
- Requires Torghut proof-floor payloads to stay stable enough for Jangar to consume.
- Requires careful contradiction handling when live and sim accounts disagree.

Decision: select Option C.

## Architecture

Jangar adds `hypothesis_capital_adjudication` as a pure reducer between Torghut proof receipts and material-action
verdicts.

```text
hypothesis_capital_adjudication
  generated_at
  namespace
  status
  source_epoch_id
  torghut_accounts[]
  rows[]
  contradictions[]
  summary_by_action_class
```

Each row is:

```text
hypothesis_capital_row
  ledger_id
  account_label
  torghut_revision
  hypothesis_id
  strategy_family
  action_class                 # observe, proof_repair, paper_canary, live_micro_canary, live_scale
  decision                     # allow, observe_only, repair_only, shadow_only, hold, block
  max_dispatches
  max_runtime_seconds
  max_notional
  confidence
  fresh_until
  forecast_dependency          # not_required, optional, required, degraded_required
  proof_dimension_states[]
  blocking_reason_codes[]
  downgrade_reason_codes[]
  required_repair_actions[]
  source_proof_refs[]
  contradiction_refs[]
  rollback_target
```

Reducer rules:

- If Torghut proof-floor evidence is missing or expired, keep `torghut_consumer_evidence_missing`.
- If proof-floor evidence is fresh, replace the generic consumer-evidence gap with dimension reasons such as
  `hypothesis_not_promotion_eligible`, `execution_tca_slippage_guardrail_exceeded`, `market_context_stale`,
  `quant_latest_metrics_empty`, `quant_ingestion_lag_exceeded`, or `simple_submit_disabled`.
- If a hypothesis declares no forecast dependency, `forecast_service_degraded` is a downgrade only, never a paper
  blocker.
- If a hypothesis declares forecast dependency required, `forecast_service_degraded` blocks paper and live for that
  hypothesis only.
- Live account and simulation account rows are evaluated separately; cross-account disagreement is a contradiction, not
  an averaging opportunity.
- `proof_repair` may be allowed only with `max_notional=0` and an active Jangar repair warrant.
- `paper_canary` requires the hypothesis row to have no capital-blocking proof dimensions and a fresh simulation row.
- `live_micro_canary` requires a settled paper row for the same hypothesis and account.
- `live_scale` requires live micro settlement, expected-shortfall coverage, and no rollback-required state.

Material-action verdicts then consume ledger summaries:

- `torghut_observe`: allow when Jangar serving and Torghut routes are observable.
- `paper_canary`: hold unless at least one hypothesis row is paper-ready and no global contradiction exists.
- `live_micro_canary`: hold unless the same hypothesis has paper settlement and live proof is current.
- `live_scale`: block unless live micro settlement and risk coverage are current.

## Validation Gates

Engineer acceptance gates:

- Add a pure Jangar reducer for `hypothesis_capital_adjudication`; keep route assembly in
  `control-plane-status.ts` thin.
- Add fixtures for fresh Torghut proof floor, expired proof floor, live/sim account disagreement, forecast-required
  hypothesis, forecast-not-required hypothesis, stale market context, empty simulation quant latest store, bad live
  TCA, and zero promotion-eligible hypotheses.
- Prove that fresh proof-floor evidence replaces `torghut_consumer_evidence_missing` with concrete reason codes.
- Prove that `forecast_service_degraded` blocks only forecast-required hypotheses.
- Prove that `torghut_observe` remains allowed, `proof_repair` remains zero-notional, `paper_canary` remains held for
  the current evidence, and live actions remain held or blocked.
- Add material-action tests showing ledger row evidence refs on Torghut verdicts.

Deployer acceptance gates:

- Do not widen paper or live capital from a generic Jangar green state.
- Before paper, require a fresh hypothesis ledger row with no capital-blocking dimensions, closed repair warrant,
  current simulation proof, and no account contradiction.
- Before live micro, require prior paper settlement for the same hypothesis and account, live proof current, submit
  gate still controlled, and rollback target present.
- Before live scale, require expected-shortfall coverage, live micro settlement, and no rollback-required hypothesis.
- Roll back by disabling ledger enforcement and returning to existing action SLO budgets and material-action verdicts.

Suggested local validation:

```bash
bun --cwd services/jangar run test -- \
  src/server/__tests__/control-plane-status.test.ts \
  src/server/__tests__/control-plane-material-action-verdict.test.ts \
  src/server/__tests__/control-plane-negative-evidence-router.test.ts \
  src/server/__tests__/control-plane-action-clock.test.ts
bun --cwd services/jangar run lint
```

## Rollout

Roll out in four phases:

1. `shadow`: compute the ledger, expose it in status, and do not change verdicts.
2. `explain`: add ledger row refs to material-action verdict evidence while preserving current decisions.
3. `replace-generic`: replace `torghut_consumer_evidence_missing` with concrete proof-floor reasons when evidence is
   fresh.
4. `scope-forecast`: apply forecast debt only to forecast-required hypotheses.

No phase opens live capital. Paper canary still requires closed repair warrants and clean proof rows.

## Rollback

Rollback is to disable ledger enforcement and keep current dependency quorum, negative evidence routing, action SLO
budgets, and material-action verdicts. Existing ledger rows become informational and expire through `fresh_until`.
No Kubernetes object, database row, broker setting, or GitOps resource needs manual mutation for rollback.

## Risks

- Torghut proof schema drift can make Jangar verdicts stale. Mitigation: versioned schema refs and expiration.
- Forecast dependency metadata can be wrong. Mitigation: default unknown dependencies to required until declared.
- Account disagreement can over-block paper. Mitigation: contradictions are explicit and unblock only after the
  affected account row is repaired.
- The ledger can become another large status payload. Mitigation: publish summaries by action class and keep full rows
  bounded to active hypotheses.

## Handoff

Engineer handoff: implement the reducer, fixtures, status projection, and material-action evidence refs. Keep Jangar's
job to admission, contradiction handling, expiry, and action-class verdicts; keep Torghut responsible for producing
hypothesis-scoped proof facts.

Deployer handoff: use the ledger as the capital checklist. A green control plane allows observation and repair, not
capital. Paper and live only move after the exact hypothesis, account, action class, and proof dimensions satisfy the
gates above.
