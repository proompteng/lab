# 139. Jangar Empirical Relay Source Binding And Capital Gate Parity (2026-05-07)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-07
Owner: Victor Chen, Jangar Engineering Architecture
Scope: Jangar control-plane empirical relay source binding, material-action gates, Torghut proof consumption, GitOps
configuration parity, validation, rollout, and rollback.

Companion Torghut contract:

- `docs/torghut/design-system/v6/143-torghut-empirical-relay-receipts-and-paper-gate-settlement-2026-05-07.md`

Extends:

- `138-jangar-proof-truth-windows-and-contradiction-arbiter-2026-05-07.md`
- `119-jangar-empirical-proof-renewal-clearinghouse-and-capital-reentry-settlement-2026-05-06.md`
- `120-jangar-material-action-verdict-arbiter-and-clock-budget-parity-2026-05-06.md`
- `135-jangar-database-witness-and-schema-authority-exchange-2026-05-07.md`

## Decision

I am selecting **empirical relay source binding with capital-gate parity** as the next Jangar control-plane
architecture step.

The current control plane is healthier than the original soak, but one source-of-truth gap is now visible enough to fix
and to design around. The `agents` control-plane deployment is serving the current `be164bc1` rollout and reports
healthy controllers, healthy watch reliability, healthy rollout health, and dependency quorum `allow`. At the same
time, `/api/agents/control-plane/status?namespace=agents` reports `empirical_services.forecast`, `lean`, and `jobs` as
`disabled` with `message="torghut status not configured"`. That produces `empirical_jobs_disabled` in Torghut capital
SLO budgets and holds or blocks paper and live action classes.

Torghut disagrees with the disabled claim. The live Torghut revision `torghut-00252` is ready, `/healthz` is ok, and
both `/trading/status` and `/trading/autonomy` return `empirical_jobs.ready=true`, `status=healthy`, and
`authority=empirical`. The right conclusion is not "paper canary can run." The right conclusion is: Jangar is missing
the empirical relay source binding, and once that false source gap is removed the real blockers must remain visible:
doc29 paper/full-day gates are still blocked, the last TCA computation is from `2026-04-02T20:59:45Z`, the 72-hour
runtime window has `25` decisions, `0` executions, and `0` TCA samples, the submission gate is still
`simple_submit_disabled`, and scoped quant ingestion lag is roughly `56,418s`.

I am making the GitOps config correction in this PR by wiring `JANGAR_TORGHUT_STATUS_URL` and
`JANGAR_TORGHUT_STATUS_TIMEOUT_MS` into the Agents control-plane values. The broader design is a relay contract that
prevents this class of source gap from being mistaken for Torghut proof failure, while also preventing fresh empirical
jobs from being mistaken for capital authority.

The tradeoff is that Jangar will carry one more explicit source-binding receipt before material-action verdicts can
move. I accept that. The six-month risk is not the extra receipt. The risk is allowing a missing route configuration,
a broad green Torghut route, or a single fresh empirical-job family to collapse separate source, schema, simulation,
TCA, quant, and capital decisions into one ambiguous gate.

## Evidence Snapshot

All evidence was collected read-only. I did not mutate Kubernetes resources, database rows, broker state, AgentRuns, or
production trading flags. The only change in this PR is to repository GitOps configuration and documentation.

### Cluster And Rollout Evidence

- The workspace had no kube current-context, so I bootstrapped an in-cluster context from the service-account token.
  `kubectl auth whoami` identified `system:serviceaccount:agents:agents-sa`.
- `kubectl get pods,deploy,job,cronjob,svc -n jangar -o wide` showed `deployment/jangar` `1/1` on
  `registry.ide-newton.ts.net/lab/jangar:be164bc1@sha256:146f2790c...`; the Jangar pod was `2/2 Running`.
- Jangar events showed the current rollout replaced `8036d91a` and `885368c6` revisions with transient readiness probe
  connection refusals during startup and repeated `NoPods` events for `elasticsearch-master-pdb`.
- `kubectl get deploy -n agents` showed `agents=1/1` on
  `jangar-control-plane:be164bc1@sha256:a069354...` and `agents-controllers=2/2` on
  `jangar:be164bc1@sha256:146f279...`.
- Agents namespace pod status still had retained history: `172` Completed pods, `61` Error pods, and `11` Running pods.
  The retained Error pods were mostly older schedule-runner images from the early `2026-05-07` rollout window.
- Current Agents CronJobs are unsuspended and the latest Jangar plan schedule-runner job completed on `be164bc1`; recent
  events still show readiness timeouts on `agents` and `agents-controllers` during rollout.
- `kubectl get pods,deploy,job,cronjob,svc -n torghut -o wide` showed Torghut live revision `torghut-00252` and sim
  revision `torghut-sim-00352` both `1/1` available on digest `11ad110644f9...`.
- Torghut events showed current DB migration, empirical backfill, whitepaper bootstrap, and semantic backfill jobs
  completed. They also showed repeated ClickHouse `MultiplePodDisruptionBudgets` warnings and a `torghut-keeper` PDB
  with no matching pods.

### Runtime Route Evidence

- `GET http://agents.agents.svc.cluster.local/ready` returned `status=ok`. A separate direct request to the Jangar app
  service timed out after `10s`, which reinforces that deployer validation should use the serving surface intended for
  the action class.
- `GET /api/agents/control-plane/status?namespace=agents` returned controller, dependency quorum, execution trust,
  watch reliability, and rollout health as healthy or allow.
- The same status route returned material-action decisions: `serve_readonly=allow`, `dispatch_repair=allow`,
  `dispatch_normal=repair_only` due to `controller_witness_split`, `deploy_widen=allow`, `merge_ready=allow`,
  `torghut_observe=allow`, `paper_canary=hold`, `live_micro_canary=block`, and `live_scale=block`.
- `empirical_services` in that payload was disabled for forecast, LEAN, and jobs because Torghut status was not
  configured in the Agents control-plane deployment.
- The Torghut action SLO budgets named `empirical_jobs_disabled` for `paper_canary`, `live_micro_canary`, and
  `live_scale`, with evidence ref `empirical_jobs:endpoint:unknown`.
- `kubectl get deploy -n agents agents -o jsonpath=...` produced no `JANGAR_TORGHUT_STATUS_URL`. The Jangar app
  deployment did have `JANGAR_TORGHUT_STATUS_URL=http://torghut.torghut.svc.cluster.local/trading/autonomy` and
  timeout `3000`.
- `GET http://torghut-00252-private.torghut.svc.cluster.local/healthz` returned `{"status":"ok","service":"torghut"}`.
- `GET /trading/status` and `GET /trading/autonomy` both included `empirical_jobs.ready=true`, `status=healthy`,
  `authority=empirical`, and `message="empirical jobs fresh"`.

### Database And Data Evidence

- Direct `kubectl cnpg psql -n jangar jangar-db` and `kubectl cnpg psql -n torghut torghut-db` both failed with
  `pods/exec forbidden` for `system:serviceaccount:agents:agents-sa`. Normal validation must remain route-backed and
  least-privilege.
- Torghut `/db-check` returned `ok=true` and `schema_current=true` through the service-owned route.
- Torghut `/trading/profitability/runtime` returned schema `torghut.runtime-profitability.v1`, a 72-hour window with
  `decision_count=25`, `execution_count=0`, and `tca_sample_count=0`.
- Torghut `/trading/tca?limit=5` returned `order_count=13775`, average absolute slippage about `568.61bps`,
  expected-shortfall coverage `0`, and `last_computed_at=2026-04-02T20:59:45.136640+00:00`.
- Torghut `/trading/status` returned `live_submission_gate.allowed=false`, `reason=simple_submit_disabled`,
  `capital_stage=shadow`, `promotion_eligible_total=0`, and proof floor `repair_only`.
- The proof floor marked empirical proof as pass, quant ingestion as informationally degraded with max lag around
  `56,418s`, and execution TCA as stale with an `86400s` threshold.
- Torghut `/trading/completion/doc29` returned `9` gates: `1` satisfied, `2` stale, and `6` blocked. The satisfied gate
  was `empirical_jobs_persisted`; `paper_gate_satisfied` was blocked by `missing_full_day_simulation_trace`.

### Source Evidence

- `services/jangar/src/server/control-plane-empirical-services.ts` reads one configured
  `JANGAR_TORGHUT_STATUS_URL`. If absent, it returns `disabled` for forecast, LEAN, and jobs.
- `services/jangar/src/server/control-plane-workflows.ts` blocks dependency quorum when empirical jobs are degraded,
  while `control-plane-action-clock.ts` maps empirical debt into paper and live action clocks.
- `services/jangar/src/server/control-plane-negative-evidence-router.ts` emits `empirical_jobs:endpoint:unknown` when
  the empirical service endpoint is missing.
- `argocd/applications/jangar/deployment.yaml` configures Torghut empirical status for the Jangar app deployment, but
  `argocd/applications/agents/values.yaml` did not configure the same source for the Agents control-plane deployment.
- `charts/agents/templates/deployment.yaml` merges `env.vars` and `controlPlane.env.vars`, so the smallest safe GitOps
  correction is to add the Torghut status URL under `controlPlane.env.vars`.

## Problem

Jangar has separate proof surfaces but does not yet have a hard source-binding invariant for the empirical relay.

That produced a false-negative capital hold. The Agents control-plane could not see Torghut empirical jobs because its
route source was absent. The system correctly failed closed for paper and live. It also lost precision: the status did
not distinguish "Torghut empirical jobs are stale" from "Jangar has no empirical route configured." Both should hold
capital, but they imply different repairs and different deployer validation gates.

The next system contract must preserve three facts at the same time:

1. Missing empirical relay configuration is a Jangar source-binding fault.
2. Fresh Torghut empirical jobs clear only the empirical-job source fault.
3. Paper and live remain blocked until doc29, full-day simulation, execution/TCA, quant, submission, and capital
   settlement gates agree.

Without that split, the platform will alternate between false blocks and unsafe enthusiasm. A route can be disabled, a
route can be green, and capital can still be zero-notional. Those states need separate receipts.

## Alternatives Considered

### Option A: Patch The Missing Environment Variable Only

Pros:

- Fastest operational fix.
- Uses existing code paths and tests.
- Removes the immediate `empirical_jobs_disabled` false source gap after Argo CD sync.

Cons:

- Does not prevent the same issue from recurring in another deployment or namespace.
- Does not give material-action verdicts a stable source-binding receipt.
- Still lets one payload carry route availability, empirical freshness, and capital readiness without explicit parity
  checks.

Decision: use as Phase 0 only.

### Option B: Make Jangar Infer A Default Torghut Status Route

Pros:

- Avoids a missing env var in many environments.
- Reduces GitOps configuration duplication.
- Can keep local development convenient.

Cons:

- Hides production source-of-truth drift behind code defaults.
- Makes it harder to tell whether a deployment intentionally uses `/trading/status`, `/trading/autonomy`, or a
  revision-private route.
- Still does not bind the empirical payload to doc29, TCA, and action-class gates.

Decision: reject as the production authority model. Defaults are acceptable for tests, not for material action.

### Option C: Empirical Relay Source Binding With Capital-Gate Parity

This option makes the route source explicit, records the payload schema and source class, and requires material-action
verdicts to cite the current empirical relay receipt before they interpret Torghut proof. A fresh empirical receipt can
clear `empirical_jobs_disabled` or `empirical_jobs_degraded`; it cannot clear doc29, TCA, quant, submission, or paper
settlement gates by itself.

Pros:

- Separates Jangar route configuration faults from Torghut proof faults.
- Preserves zero-notional safety while making repair work more precise.
- Gives deployers one receipt to validate after the GitOps config correction rolls out.
- Builds directly on proof truth windows and empirical proof renewal clearinghouse work.

Cons:

- Adds one more receipt and route probe to status generation.
- Requires a schema compatibility rule for `/trading/status` and `/trading/autonomy`.
- Paper gates may remain held even after the false source gap is fixed, which is correct but may surprise operators.

Decision: select.

## Architecture Contract

Jangar should synthesize an `empirical_relay_source_binding` object in the control-plane status payload:

- `binding_id`: deterministic hash of namespace, endpoint URL, payload schema, Torghut revision, and observed time
  bucket.
- `endpoint`: configured Torghut source URL.
- `source_class`: `torghut_autonomy`, `torghut_status`, `revision_private`, or `unknown`.
- `payload_schema`: `torghut.autonomy.v1` or `torghut.trading-status.v1`.
- `route_state`: `configured`, `unconfigured`, `timeout`, `invalid_schema`, or `healthy`.
- `empirical_jobs_state`: `healthy`, `degraded`, `disabled`, or `unknown`.
- `capital_gate_effects`: separate effects for `merge_ready`, `paper_canary`, `live_micro_canary`, and `live_scale`.
- `parity_refs`: doc29 summary, proof-floor summary, TCA summary, scoped quant summary, and material-action verdict id.
- `fresh_until`: short expiry, initially `2m`, because route configuration and Torghut proof can change during rollout.

The material-action reducer must apply these rules:

- `route_state=unconfigured|timeout|invalid_schema` blocks paper/live and produces a Jangar source-binding repair.
- `empirical_jobs_state=degraded|disabled|unknown` blocks paper/live and produces a Torghut empirical repair.
- `empirical_jobs_state=healthy` clears only the empirical-job reason.
- `paper_canary` remains held if doc29 paper gate, full-day simulation, TCA freshness, scoped quant, or paper settlement
  is missing.
- `live_micro_canary` and `live_scale` remain blocked unless paper settlement and Torghut submission gates agree.

The Phase 0 GitOps change in this PR wires the missing Agents control-plane route to:

`http://torghut.torghut.svc.cluster.local/trading/autonomy`

That endpoint is already used by the Jangar app deployment and carries the three payloads that
`control-plane-empirical-services.ts` expects: `forecast_service`, `lean_authority`, and `empirical_jobs`.

## Implementation Scope

Engineer stage should implement the receipt after this config correction lands:

- Add `empirical_relay_source_binding` to `ControlPlaneStatusResponse`.
- Teach `resolveEmpiricalServices` to return `route_state`, `source_class`, and `payload_schema`, not just dependency
  status.
- Add a schema guard that accepts both `/trading/status` and `/trading/autonomy` when the required empirical fields are
  present.
- Update negative evidence so `empirical_relay_unconfigured` and `empirical_jobs_degraded` are separate reason codes.
- Update material-action verdicts so clearing the relay source gap cannot clear doc29/TCA/quant/submission gates.
- Add tests for missing URL, timeout, invalid schema, healthy empirical jobs with blocked paper gate, and healthy
  empirical jobs with all downstream capital gates still blocked.
- Keep direct DB access out of the normal validation path.

Deployer stage should validate the GitOps config correction before turning on any stricter enforcement:

- Render the Agents chart and confirm `JANGAR_TORGHUT_STATUS_URL` is present in the `agents` deployment.
- After Argo CD sync, query `/api/agents/control-plane/status?namespace=agents`.
- Confirm `empirical_services.jobs.status` is no longer `disabled`.
- Confirm paper and live gates remain held or blocked for the real downstream reasons until Torghut closes them.

## Validation Gates

Local validation for this PR:

- `bunx oxfmt --check docs/agents/designs/139-jangar-empirical-relay-source-binding-and-capital-gate-parity-2026-05-07.md docs/torghut/design-system/v6/143-torghut-empirical-relay-receipts-and-paper-gate-settlement-2026-05-07.md docs/agents/README.md docs/torghut/design-system/v6/index.md`
- `mise exec helm@3 -- helm template agents charts/agents -n agents -f argocd/applications/agents/values.yaml`
- `bun run lint:argocd`

Runtime validation after deployer sync:

- `kubectl get deploy -n agents agents -o jsonpath='{...JANGAR_TORGHUT_STATUS_URL...}'`
- `curl -fsS http://agents.agents.svc.cluster.local/api/agents/control-plane/status?namespace=agents`
- `curl -fsS http://torghut.torghut.svc.cluster.local/trading/autonomy`
- `curl -fsS http://torghut.torghut.svc.cluster.local/trading/completion/doc29`
- `curl -fsS http://torghut.torghut.svc.cluster.local/trading/tca?limit=5`

Acceptance gates:

- The status payload no longer emits `empirical_jobs:endpoint:unknown` for the Agents control plane.
- Empirical jobs are read as healthy when Torghut returns `ready=true`, `status=healthy`, and `authority=empirical`.
- Paper/live remain zero-notional until doc29, TCA, scoped quant, submission, and paper settlement gates close.
- A missing or invalid route is reported as a source-binding fault, not as stale Torghut proof.

## Rollout

Phase 0 is this PR:

- Add the Torghut empirical status URL and timeout to `argocd/applications/agents/values.yaml`.
- Let Argo CD reconcile the Agents control-plane deployment.
- Verify the environment variables are present and the control-plane status no longer reports empirical services as
  disabled.

Phase 1 is shadow receipt synthesis:

- Add the `empirical_relay_source_binding` object behind an additive status field.
- Keep existing material-action behavior, but include the new receipt id and source-state classification.
- Compare old and new reason codes for at least one rollout window.

Phase 2 is enforcement:

- Material-action verdicts consume the source-binding receipt.
- `empirical_relay_unconfigured` and `empirical_jobs_degraded` become distinct hard reasons.
- Capital gates remain zero-notional unless all downstream Torghut gates agree.

## Rollback

If Phase 0 causes the Agents control-plane to become unready, rollback is a GitOps revert of the values change and a
normal Argo CD sync. That returns the system to the previous fail-closed disabled empirical state; paper/live remain
zero-notional.

If Phase 1 receipt synthesis is noisy, disable only the new receipt projection and keep the existing empirical-service
projection.

If Phase 2 enforcement over-holds repair work, rollback enforcement to shadow and preserve the receipt for audit. Do
not bypass paper/live gates to compensate for a source-binding bug.

## Risks

- `/trading/autonomy` and `/trading/status` may drift. Mitigation: accept only a small required empirical schema and
  report `invalid_schema` separately.
- A short timeout can produce false route timeouts during rollout. Mitigation: track timeout as source-binding debt and
  do not convert it into Torghut proof debt.
- Fixing the source gap may look like a capital unblock. Mitigation: material-action gates must keep doc29, TCA,
  quant, submission, and paper settlement blockers independent.
- Direct SQL remains inaccessible to normal workers. Mitigation: service-owned route evidence is the routine path, and
  privileged SQL stays deployer-deep-dive only.

## Handoff

Engineer acceptance:

- New status receipt differentiates `empirical_relay_unconfigured`, `empirical_relay_timeout`,
  `empirical_relay_invalid_schema`, and `empirical_jobs_degraded`.
- Unit tests cover healthy empirical jobs while paper remains blocked by doc29/TCA/quant gates.
- Existing Torghut capital gates remain zero-notional until downstream proof closes.

Deployer acceptance:

- Argo sync rolls the Agents control-plane with `JANGAR_TORGHUT_STATUS_URL` set.
- `/api/agents/control-plane/status?namespace=agents` no longer reports empirical jobs disabled due to missing config.
- The deployer records the post-sync material-action verdicts and confirms no paper/live notional is admitted by this
  config correction alone.
