# 127. Jangar Session Rehearsal Conductor And Capital Settlement Gates (2026-05-06)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-06
Owner: Gideon Park, Torghut Traders Architecture
Scope: Jangar control-plane resilience, Torghut capital admission, session-timed rollout safety, evidence-product
settlement, repair dispatch, and deployer rollback gates.

Companion Torghut contract:

- `docs/torghut/design-system/v6/131-torghut-session-capital-bonds-and-profit-rehearsal-exchange-2026-05-06.md`

Extends:

- `126-jangar-projection-witness-exchange-and-material-evidence-products-2026-05-06.md`
- `125-jangar-run-settlement-watermarks-and-consumer-evidence-escrow-2026-05-06.md`
- `120-jangar-material-action-verdict-arbiter-and-clock-budget-parity-2026-05-06.md`
- `116-jangar-controller-witness-quorum-and-capital-activation-receipts-2026-05-06.md`

## Decision

I am selecting a **session rehearsal conductor with capital settlement gates** as the next Jangar control-plane
contract.

The evidence-product exchange is the right substrate, but it is not yet enough. It defines what evidence means. It
does not define when a trading session may consume that evidence, when a rollout may widen, or when a stale proof
domain must become repair work instead of a generic capital hold.

At `2026-05-06T18:10Z`, Jangar was materially healthier than the earlier degraded soak. `/ready` returned HTTP `200`.
Control-plane status reported healthy database connectivity, migration consistency at `28/28`, healthy execution trust,
healthy watch reliability, available workflow and job runtimes, and healthy `agents` and `agents-controllers`
rollouts. Runtime kits also showed the NATS collaboration tools present. The remaining Jangar risks were narrower:
retained failed AgentRun pods, recent readiness timeouts during rollout, RBAC denial for deeper rollout and database
inspection, and an `agentrun_ingestion` status that still read `unknown` while controller rollout evidence was healthy.

Torghut evidence was also split. Live service dependencies were OK, but live `/readyz` returned HTTP `503` because
`simple_submit_disabled` keeps live submission in shadow. Sim `/readyz` returned HTTP `200`, but scoped sim quant
latest for `TORGHUT_SIM/15m` was empty. Global Jangar quant health was fresh with `4032` latest metrics, while scoped
`paper/1d` was empty. Market context was degraded across technicals, fundamentals, news, and regime. Quant alerts
reported `57` open alerts, `44` of them critical pipeline-lag alerts. Runtime profitability showed `25` decisions and
`0` executions over 72 hours, no TCA samples in that window, and all active hypotheses at zero capital.

The selected design puts a session-level conductor between material evidence products and material actions. Jangar will
issue three session receipts: `preopen_rehearsal`, `intraday_observation`, and `postclose_settlement`. Torghut capital
and Torghut-impacting deploy widening cannot advance beyond shadow unless the relevant session receipt cites fresh
products and an explicit capital settlement decision.

The tradeoff is deliberate friction. Jangar will sometimes hold a technically healthy rollout because the session
window or Torghut evidence settlement is wrong. I accept that. The failure mode we need to remove is capital or rollout
movement that is correct by local health checks but wrong for the trading session.

## Runtime Objective And Success Metrics

This contract improves Jangar reliability by making material action timing explicit. It improves Torghut profitability
by turning partial evidence into zero-notional rehearsal and ranked repair while keeping paper and live capital blocked
until the session has settled products.

Success means:

- Every `torghut_capital`, `deploy_widen`, and `merge_ready` receipt that can affect Torghut cites a current
  `session_rehearsal_id`.
- `/ready` remains a serving health signal, not a capital signal.
- Healthy controller rollout evidence can allow `serve_readonly` and `dispatch_repair` while `agentrun_ingestion`
  ambiguity keeps `dispatch_normal` and Torghut-impacting widening under session scrutiny.
- `preopen_rehearsal` fails closed when scoped quant is empty, market context is stale, critical quant alerts are open,
  or live submission is shadow-only.
- `intraday_observation` allows zero-notional learning even when capital is held.
- `postclose_settlement` decides which proof debts become the next repair dispatches and which candidates lose capital
  priority.
- Deployer rollout checks can answer one question: which session receipt allows this action now?

## Evidence Snapshot

All evidence was collected read-only. I did not mutate Kubernetes resources, database rows, broker state, GitOps
manifests, trading flags, workflow objects, or runtime resources.

### Cluster And Rollout Evidence

- `kubectl auth whoami` reported `system:serviceaccount:agents:agents-sa`.
- `kubectl config current-context` was unset, but in-cluster auth worked.
- Jangar pods were running, including `jangar-5d47c56476-27rsc`, `jangar-db-1`, Redis, Bumba, Alloy, Symphony,
  `symphony-jangar`, and Open WebUI.
- Jangar deployment was `1/1` available.
- Agents deployments were available: `agents=1/1`, `agents-controllers=2/2`, and `agents-alloy=1/1`.
- Agents active pod listing still included retained failed AgentRun pods from Jangar control-plane verify, Torghut
  quant discover, Torghut quant implement, and market-context provider runs.
- Recent Agents events showed the `agents` and `agents-controllers` rollout to image `eb0d955b`, then transient
  readiness probe timeouts on the new pods.
- Torghut live `torghut-00241` was `2/2 Running`; Torghut sim `torghut-sim-00339` was `2/2 Running`.
- Torghut TA, sim TA, options TA, options catalog/enricher, websockets, Postgres, ClickHouse, Keeper, guardrail
  exporters, Alloy, and Symphony were running.
- Recent Torghut events showed a failed sim teardown analysis, a restarted sim TA Flink deployment, and duplicate
  ClickHouse PDB matches.
- Listing Argo Rollouts, Knative services/revisions, FlinkDeployment CRDs, CNPG clusters, backups, and scheduled backups
  was forbidden to this service account. Pod exec into both Jangar and Torghut Postgres was also forbidden.

### Source Evidence

- `services/jangar/src/server/control-plane-status.ts` composes controller status, runtime adapters, execution trust,
  database status, watch reliability, AgentRun ingestion, failure-domain leases, action clocks, negative evidence, and
  material action receipts.
- `services/jangar/src/server/control-plane-controller-witness.ts` already distinguishes controller deployment, watch
  epoch, and AgentRun ingestion witnesses, and can hold material action when witness agreement is incomplete.
- `services/jangar/src/server/control-plane-action-clock.ts` already reduces leases into action-class decisions.
- `services/jangar/src/server/control-plane-negative-evidence-router.ts` already accepts Torghut-side inputs such as
  market-context stale domains and open quant alerts.
- `services/jangar/src/server/control-plane-db-status.ts` projects database health through application-owned
  connectivity and migration consistency.
- `services/jangar/src/server/supporting-primitives-controller.ts` remains high leverage and high blast radius at
  `2931` lines.

### Database And Data Evidence

- Jangar control-plane status reported `database.status=healthy`, `latency_ms=12`, and migration consistency
  `registered_count=28`, `applied_count=28`, `unapplied_count=0`, `unexpected_count=0`.
- Latest Jangar migration was `20260505_torghut_quant_pipeline_health_window_index`.
- Repo-declared Jangar Postgres is one CNPG instance with `200Gi`, checksums, `pgcrypto`, `vector`, Barman S3 backups,
  and `14d` retention.
- Jangar has a daily ScheduledBackup at `0 0 11 * * *`.
- Torghut live database schema was current at Alembic head `0029_whitepaper_embedding_dimension_4096`.
- Repo-declared Torghut Postgres is one CNPG instance with `50Gi`, checksums, Barman S3 backups, `14d` retention, and a
  daily ScheduledBackup at `0 0 2 * * *`.
- ClickHouse guardrails showed both replicas up, disk free ratio near `0.96`, no read-only replica, and last scrape
  success.
- LLM guardrails showed last scrape success, LLM disabled, effective shadow mode active, no policy violation, and
  governance evidence incomplete.

## Problem

Jangar now has enough local health to run. Torghut has enough empirical proof to learn. Neither condition is sufficient
for capital.

The live risk is timing. A route can be healthy after the opening bell while scoped quant is empty. A controller rollout
can be available while retained failed jobs and recent readiness timeouts still indicate operational churn. A sim
revision can be ready while teardown analysis failed. A global quant route can be fresh while the account/window that
capital needs is empty.

If Jangar only answers "is this component healthy?" it will keep producing locally correct but session-blind decisions.
The control plane needs to answer "is this action allowed in this trading session, for this consumer, with this settled
evidence?"

## Alternatives Considered

### Option A: Treat Current Jangar Health As Enough For Torghut Capital

Pros:

- Fastest path to operational green.
- Uses the recent improvement in Jangar readiness, controller rollout, runtime kits, and DB status.
- Minimal implementation beyond existing status reducers.

Cons:

- Ignores empty scoped quant stores.
- Ignores stale market context.
- Ignores open critical pipeline-lag alerts.
- Ignores that Torghut runtime profitability has zero executions in the current window.
- Lets deploy widening and capital admission share a generic healthy control-plane signal.

Decision: reject.

### Option B: Keep The Evidence-Product Order Book As The Only Next Step

Pros:

- Already fits the current design stack.
- Provides typed products and repair priorities.
- Keeps least privilege by using producer-owned projections.

Cons:

- Does not define trading-session timing.
- Does not tell deployers whether a rollout should wait until preopen or postclose.
- Does not resolve the gap between `serve_readonly`, `dispatch_repair`, `dispatch_normal`, and Torghut capital timing.
- Can rank repair without deciding when capital can reenter.

Decision: keep as substrate, reject as the complete next architecture.

### Option C: Session Rehearsal Conductor With Capital Settlement Gates

Jangar owns session-timed receipts. Evidence products feed those receipts. Material actions consume the receipts.

Pros:

- Separates serving health from action timing.
- Gives deployer and engineer lanes exact gates.
- Lets repair dispatch continue while capital stays held.
- Converts stale or empty Torghut products into session debt.
- Creates a clean boundary for rollout freezes during market-open risk.

Cons:

- Adds time-window logic and session state.
- Requires Torghut to emit or adapt session bond evidence.
- Needs careful handling for holidays, half-days, and non-US trading windows.

Decision: select Option C.

## Architecture

### SessionRehearsalReceipt

Jangar emits one receipt per session, account, and action class.

```text
session_rehearsal_receipt
  session_rehearsal_id
  trading_session_id
  account_label
  action_class                 # torghut_observe, paper_canary, live_micro_canary, deploy_widen, merge_ready
  phase                        # preopen_rehearsal, intraday_observation, postclose_settlement
  decision                     # allow, observe_only, repair_only, hold, block
  generated_at
  expires_at
  consumed_product_ids
  missing_product_ids
  stale_product_ids
  negative_evidence_refs
  controller_witness_ref
  rollout_health_ref
  workflow_reliability_ref
  repair_dispatch_refs
  rollback_target
```

Phase rules:

- `preopen_rehearsal` must close before any paper or live widening for the session.
- `intraday_observation` can allow zero-notional activity when capital products are missing.
- `postclose_settlement` is required before the next session may treat today's empirical proof as earned capital.

### Material Action Mapping

Jangar maps receipts to actions:

- `serve_readonly`: allowed from normal readiness and database health.
- `dispatch_repair`: allowed when collaboration runtime and storage evidence are fresh, even if capital is held.
- `dispatch_normal`: allowed only when controller witness and AgentRun ingestion are not contradictory.
- `deploy_widen`: blocked during market-open windows unless the receipt is `allow` for the affected Torghut producer or
  the rollout is a repair that reduces a blocking product.
- `merge_ready`: allowed for documentation and non-runtime work when source schema and CI are clean; runtime-impacting
  merges must cite postclose or preopen receipt status.
- `torghut_capital`: cannot exceed the receipt decision for the exact account and session.

### Session Debt Ledger

Every `hold` or `block` receipt writes session debt.

```text
session_evidence_debt
  debt_id
  session_rehearsal_id
  product_id
  debt_class                  # scoped_quant_empty, market_context_stale, quant_alert_open, teardown_failed
  severity
  owner_stage                 # engineer, deployer, architect
  first_observed_at
  due_before_phase
  repair_lane
  expected_capital_unlocked
  settlement_status
```

Initial debt from current evidence:

- scoped quant empty for `paper/1d` and `TORGHUT_SIM/15m`;
- critical `metrics_pipeline_lag_seconds` alerts across short and long windows;
- stale technicals, regime, news, and fundamentals;
- sim teardown analysis failure;
- live submission shadow-only brake;
- LLM governance evidence incomplete for live phases.

## Validation Gates

Engineer gates:

- Unit test: Jangar emits `observe_only` when `/ready` is healthy but scoped Torghut quant is empty.
- Unit test: `dispatch_repair` remains allowed when `paper_canary` is held by session debt.
- Unit test: `deploy_widen` is held during market-open windows when affected Torghut products are stale or missing.
- Unit test: `postclose_settlement` converts open critical quant alerts into debt records.
- Route test: control-plane status exposes `session_rehearsal_receipts` and `session_evidence_debt` with stable ids.

Deployer gates:

- Before paper canary, Jangar status must show a current preopen or intraday receipt with `decision=allow` for the
  exact account, action class, and session.
- Before live micro-canary, Jangar must show postclose settlement for the prior paper session and fresh live-specific
  products.
- During market hours, Torghut-impacting rollouts must either cite an active repair debt or wait for postclose.
- If direct CRD or database inspection is forbidden, application-projected products are the authoritative evidence.

## Rollout Plan

Phase 0, document and shadow:

- Add receipt and debt fields to status payloads behind a feature flag.
- Build receipts from existing material evidence products or shadow adapter products.
- Do not enforce capital or rollout changes.

Phase 1, repair dispatch:

- Allow `dispatch_repair` receipts to create engineer work for scoped quant, market context, and alert settlement.
- Keep paper and live capital at current behavior.

Phase 2, deploy timing:

- Enforce market-session deploy widening holds for Torghut-impacting producers unless the action is a repair with a
  debt id.
- Keep non-Torghut docs and non-runtime merges outside the session gate.

Phase 3, capital enforcement:

- Require session receipts for paper canary.
- Require prior postclose settlement and live governance products for live micro-canary.

## Rollback

- Disable session receipt enforcement by action class.
- Continue emitting receipts and debt in shadow so the failed decision can be diagnosed.
- Keep `simple_submit_disabled` and existing Torghut broker brakes intact.
- If receipt generation is unavailable, fail closed for paper/live capital and fail open only for `serve_readonly`.
- Revert deploy widening enforcement before deleting any persisted receipt rows.

## Risks

- Time-window policy can block urgent repair if the repair is not labeled correctly.
- Half-days and non-US sessions can create false holds unless calendars are explicit.
- Session debt can become noise if every stale alert creates a separate repair ticket.
- A healthy Jangar status can mask stale Torghut products if product ingestion lags.
- Deployer pressure may try to bypass receipts with manual cluster checks; the contract forbids that for capital.

## Handoff To Engineer

Implement the reducer as pure status logic first. Do not change broker submission behavior in the first PR.

Acceptance gates:

- Receipt fixtures cover healthy Jangar plus empty scoped quant.
- Debt fixtures cover market-context staleness, open critical quant alerts, sim teardown failure, and LLM governance
  incomplete.
- `dispatch_repair` and `paper_canary` diverge correctly: repair can run, capital stays held.
- Tests prove `serve_readonly` does not require a session receipt.

## Handoff To Deployer

Treat session receipts as the deploy and capital go/no-go surface once the feature flag is enabled.

Acceptance gates:

- A Torghut-impacting rollout during market hours must cite a repair debt id or wait for postclose.
- Paper canary must cite a current `preopen_rehearsal` or `intraday_observation` receipt.
- Live micro-canary must cite prior paper settlement, LLM governance completion, TCA evidence, and live-submission
  policy.
- Roll back enforcement immediately if an action moves without a session receipt id.
