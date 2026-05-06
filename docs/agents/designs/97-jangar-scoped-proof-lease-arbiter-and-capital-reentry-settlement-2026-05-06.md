# 97. Jangar Scoped Proof Lease Arbiter And Capital Reentry Settlement (2026-05-06)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-06
Owner: Gideon Park, Torghut Traders
Scope: Jangar control-plane resilience, scoped Torghut proof authority, capital reentry admission, safe rollout,
rollback, and engineer/deployer acceptance gates.

Companion Torghut contract:

- `docs/torghut/design-system/v6/101-torghut-scoped-quant-proof-leases-and-paper-capital-settlement-2026-05-06.md`

Extends:

- `96-jangar-session-proof-train-and-capital-authority-separation-2026-05-06.md`
- `96-jangar-observed-action-authority-and-negative-evidence-reclocking-2026-05-06.md`
- `95-jangar-evidence-settlement-slo-and-launch-escrow-runway-2026-05-05.md`
- `docs/torghut/design-system/v6/100-torghut-session-proof-train-and-profitability-warrants-2026-05-06.md`

## Decision

I am choosing a **scoped proof lease arbiter with capital reentry settlement** as the next Jangar architecture step for
Torghut quant.

The control plane is no longer in the same posture as the earlier soak. Jangar `/ready` is HTTP 200 with healthy
execution trust, healthy runtime kits, and the NATS collaboration binary present. The `agents` Deployments are healthy:
`agents` is `1/1` and `agents-controllers` is `2/2`. The Jangar control-plane status route reports healthy controller
heartbeats, configured workflow and job runtimes, healthy rollout, connected database, and a healthy migration table.
Jangar's aggregate Torghut quant health route is also fresh: `latestMetricsCount=3780`,
`latestMetricsUpdatedAt=2026-05-06T01:09:44.688Z`, and `metricsPipelineLagSeconds=2`.

Torghut is safe but still not trade-ready. Torghut liveness returns HTTP 200, but `/trading/health` returns HTTP 503.
Live submission is blocked by `simple_submit_disabled`, the active capital stage is `shadow`, empirical jobs are stale
from `2026-03-21T09:03:22Z`, the dependency quorum blocks on `empirical_jobs_degraded`, all three hypotheses require
rollback, zero hypotheses are promotion eligible, and Torghut reports `quant_health_not_configured` even though Jangar
has a healthy typed quant-health endpoint.

Jangar should not widen this into another broad global block. It should issue short-lived scoped proof leases for a
specific `account`, `strategy_id`, and `window`, then let a capital reentry arbiter decide which action classes may
spend those leases. Aggregate health can keep observe and repair work moving. Paper and live capital require scoped
leases, fresh empirical authority, and a settled paper-capital dry run.

The tradeoff is a stricter capital contract. I accept that because current evidence says the control plane can
coordinate repair, but Torghut capital proof is stale and under-scoped.

## Read-Only Evidence Snapshot

All evidence for this design pass was read-only. No Kubernetes resources or database records were changed.

### Cluster And Rollout Evidence

- Repository branch: `codex/swarm-torghut-quant-discover`; local branch was clean at `main` commit
  `24e97c9eb26aa1bac0ed0722ab37b74e42f9c512` before this design change.
- `kubectl config current-context` was unset, but read-only Kubernetes calls succeeded as
  `system:serviceaccount:agents:agents-sa`.
- `jangar` namespace pods were ready, including `jangar-c55cddb4c-t7h62` `2/2 Running`,
  `jangar-db-1` `1/1 Running`, and `bumba-847bf8c449-j4d76` `1/1 Running`.
- `agents` namespace Deployments were healthy: `agents` `1/1`, `agents-controllers` `2/2`, and `agents-alloy` `1/1`.
- Recent `agents` pods still showed action debt: several Jangar and Torghut quant verify jobs ended in `Error`, while
  current discover/implement/verify runs were also active. The arbiter must budget launch classes rather than treating
  readiness as unlimited capacity.
- `torghut` namespace serving revisions were ready: `torghut-00225` `2/2 Running` and `torghut-sim-00306` `2/2
Running`. ClickHouse, keeper, WebSocket, TA, options catalog, and options enricher pods were running.
- Recent Torghut events showed rollout tails: readiness probe failures during options catalog/enricher replacement,
  a running `torghut-db-migrations` job, and repeated ClickHouse multiple-PDB warnings.
- CNPG cluster reads, ClickHouseInstallation reads, and `pods/exec` into CNPG were forbidden. Least-privilege proof must
  be route-backed, not privileged database-backed.

### Route Evidence

- `GET http://jangar.jangar.svc.cluster.local/ready` returned HTTP 200 `status=ok`. Execution trust was healthy, memory
  provider was healthy, collaboration runtime kit had `codex-nats-publish`, `codex-nats-soak`, `nats`, service URL, and
  workspace path present, and swarm plan/implement/verify passports were `allow`.
- `GET /api/agents/control-plane/status?namespace=agents` returned HTTP 200. Controllers and runtime adapters were
  healthy, database was connected with 28 registered and 28 applied Kysely migrations, watch reliability had 9,261
  events and zero errors in a 15-minute window, rollout health was healthy, and failure-domain leases allowed
  `torghut_capital` in shadow mode.
- The same status payload still returned dependency quorum `block` for `empirical_jobs_degraded` and named Torghut
  forecast and empirical jobs as degraded. That block is valid for capital, not for every repair action.
- `GET /api/torghut/trading/control-plane/quant/health` returned HTTP 200 `ok=true`, `status=ok`,
  `latestMetricsCount=3780`, and `metricsPipelineLagSeconds=2`. It also returned `stageScopeOmitted=true` because
  account and window were not provided.
- `GET /healthz` on Torghut returned HTTP 200. `GET /db-check` returned HTTP 200 with schema current at Alembic head
  `0029_whitepaper_embedding_dimension_4096`.
- `GET /trading/health` on Torghut returned HTTP 503 with `live_submission_gate.simple_submit_disabled`,
  `capital_stage=shadow`, `empirical_jobs.degraded`, and `quant_evidence.quant_health_not_configured`.
- `GET /trading/status` returned `mode=live`, `active_revision=torghut-00225`, `last_decision_at=2026-05-04T17:25:57Z`,
  `signal_lag_seconds=15027`, three hypotheses, zero promotion eligible, three rollback required, and four stale
  empirical jobs from `2026-03-21T09:03:22Z`.

### Source Evidence

- `services/jangar/src/server/control-plane-status.ts` already aggregates controller health, database status, rollout
  health, workflow health, execution trust, runtime admission, failure-domain leases, empirical services, and Torghut
  dependency quorum. It is the correct producer for the first arbiter read model.
- `services/jangar/src/routes/api/torghut/trading/control-plane/quant/health.ts` already supports account, strategy, and
  window parameters, but unscoped requests omit stage health. Capital gates must reject unscoped aggregate health.
- `services/jangar/src/server/torghut-quant-metrics-store.ts` persists latest metrics, series metrics, alerts, and
  pipeline-health stages in `torghut_control_plane` tables with migration coverage through
  `20260505_torghut_quant_pipeline_health_window_index`.
- `services/jangar/src/server/control-plane-empirical-services.ts` already reads Torghut status and marks stale
  empirical jobs. That signal should feed capital authority, repair capacity, and proof lease state separately.
- Torghut source already has matching consumers in `services/torghut/app/trading/submission_council.py`: it resolves a
  typed quant-health URL, requires the endpoint path, caches reads, and blocks capital when quant health is required and
  not OK.

## Problem

Jangar now has a better failure mode than the earlier degraded control plane: it can serve and coordinate, but it still
cannot prove that Torghut capital should reenter.

The current architecture has four gaps:

1. **Aggregate health can be over-read.** Jangar quant health is fresh in aggregate, but account/window stages are
   omitted unless the caller scopes the request. Capital needs scoped proof, not route liveness.
2. **Capital debt still appears as broad dependency debt.** `empirical_jobs_degraded` should block paper and live
   capital, but it should not block bounded proof refresh or observe work.
3. **Torghut is not consuming the proof Jangar already has.** Torghut reports `quant_health_not_configured` while
   Jangar has a typed quant-health endpoint ready.
4. **Read-only assessment is least-privilege by design.** The runtime identity cannot exec into databases or list
   privileged CRDs. Durable route receipts and digests must be first-class audit evidence.

## Alternatives Considered

### Option A: Wire The Existing Quant-Health URL And Refresh Empirical Jobs

Set `TRADING_JANGAR_QUANT_HEALTH_URL`, refresh the four stale empirical jobs, and keep the existing capital gate.

Pros:

- Directly addresses two visible blockers.
- Minimal design and code movement.
- Leaves the conservative live-submission gate intact.

Cons:

- Does not prevent future aggregate health from being used as scoped capital proof.
- Does not settle paper-capital dry runs before live eligibility.
- Does not convert verify/job debt into action budgets.

Decision: use these as engineer tasks, not as the architecture.

### Option B: Make Session Proof Train The Only Capital Gate

Let the session proof train decide observe, repair, paper, and live capital in one object.

Pros:

- Simple operator surface.
- Builds on the last accepted design.
- Can include empirical and rollout debt in one pass.

Cons:

- Too coarse for account/window proof.
- Risks turning the train into another global dependency quorum.
- Makes Torghut's submission council a passive consumer instead of an independent capital guard.

Decision: reject. The train should carry proof cargo; capital needs a separate scoped settlement decision.

### Option C: Scoped Proof Lease Arbiter

Jangar issues scoped proof leases and a capital reentry arbiter consumes them with empirical freshness, rollout debt,
and paper-capital settlement.

Pros:

- Separates observe, repair, paper, and live authority.
- Forces capital proof to cite account, strategy, and window.
- Lets Jangar keep repair capacity open while stale empirical authority blocks capital.
- Gives Torghut a typed consumer contract and rollback path.
- Fits least-privilege operation because it relies on routes, digests, and status projections.

Cons:

- Adds one more read model and expiry clock.
- Requires shadow comparison against existing failure-domain leases and session proof train decisions.
- Needs tests that prove unscoped aggregate quant health cannot clear capital.

Decision: select Option C.

## Architecture

### ScopedProofLease

Jangar materializes a short-lived lease:

```text
scoped_proof_lease
  lease_id
  namespace
  account
  strategy_id
  window
  generated_at
  fresh_until
  quant_health
  pipeline_stages
  empirical_authority
  rollout_debt
  source_schema
  route_digest
  evidence_refs
  decision
```

`decision` is `allow`, `delay`, or `block`. Unscoped aggregate quant health can only support `observe` and
`zero_notional_repair`; it cannot produce a paper or live capital lease.

### CapitalReentryArbiter

The arbiter emits action-class decisions:

- `torghut_observe`
- `torghut_repair`
- `torghut_paper_dry_run`
- `torghut_paper_capital`
- `torghut_live_capital`

Rules:

- `torghut_observe` may use aggregate health when Jangar serving and database status are healthy.
- `torghut_repair` may run with stale empirical jobs only when it names the proof debt it intends to reduce.
- `torghut_paper_dry_run` requires scoped quant health, current schema, no critical rollout debt, and current rejected
  decision attribution.
- `torghut_paper_capital` additionally requires fresh empirical jobs, a non-empty account/window pipeline stage set, and
  a valid paper dry-run settlement receipt.
- `torghut_live_capital` additionally requires paper-capital settlement over multiple sessions and must remain `block`
  when `simple_submit_disabled` or kill-switch toggles are active.

## Engineer Acceptance Gates

- Add Jangar tests proving `stageScopeOmitted=true` never allows `torghut_paper_capital` or `torghut_live_capital`.
- Add Jangar tests proving `empirical_jobs_degraded` blocks capital classes but still allows bounded `torghut_repair`
  when control-plane runtime, rollout, and database clocks are healthy.
- Add Jangar route or status projection for scoped proof leases with account/window parameters and digestable evidence
  refs.
- Add Torghut consumer wiring so `TRADING_JANGAR_QUANT_HEALTH_URL` targets
  `/api/torghut/trading/control-plane/quant/health`, with tests for invalid path, unconfigured URL, degraded scoped
  proof, and healthy scoped proof.
- Add regression tests around stale empirical jobs, zero promotion-eligible hypotheses, and paper-capital dry-run
  settlement.

## Deployer Acceptance Gates

- Shadow mode for one market session: publish scoped proof leases and compare them to existing failure-domain leases
  without changing launch or capital behavior.
- Configure Torghut with the typed Jangar quant-health URL and required account/window proof in the sim lane first.
- Verify `/trading/health` no longer reports `quant_health_not_configured`; it may still be degraded for empirical jobs
  or disabled live submission.
- Verify Jangar status shows scoped proof lease decisions and explicitly marks aggregate-only quant health as
  observe/repair only.
- Do not enable paper capital until all required empirical jobs are fresh, truthful, and tied to current dataset/runtime
  refs.
- Do not enable live capital until paper-capital settlement is positive across the agreed session count and live
  submission toggles are explicitly enabled.

## Rollout Plan

1. Shadow: publish scoped proof leases and capital arbiter decisions without enforcement.
2. Sim enforcement: require scoped quant leases for sim paper dry runs.
3. Paper dry run: allow zero-notional and paper-dry-run settlement when empirical proof is still stale.
4. Paper capital: allow only after empirical jobs are fresh and paper dry-run settlement passes.
5. Live capital: allow only after paper-capital settlement, submission toggles, and kill-switch checks pass.

## Rollback Plan

- Disable scoped proof lease enforcement and fall back to the existing conservative dependency quorum.
- Treat all outstanding scoped leases as expired.
- Keep `torghut_observe` available if Jangar serving and route health remain healthy.
- Revert Torghut quant-health requirement to informational only only after confirming capital remains blocked by the
  existing submission council.

## Risks

- A scoped lease clock can become another stale authority if it is not short-lived.
- Engineers could wire aggregate quant health and mistakenly call the work complete. Tests must reject this.
- Fresh empirical jobs may still be unprofitable. The arbiter must require paper settlement, not just job freshness.
- Current read-only RBAC prevents privileged DB inspection. That is acceptable, but route evidence must be explicit and
  durable enough for audit.
