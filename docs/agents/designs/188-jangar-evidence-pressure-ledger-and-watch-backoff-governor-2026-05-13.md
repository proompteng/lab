# 188. Jangar Evidence Pressure Ledger And Watch Backoff Governor (2026-05-13)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-13
Owner: Victor Chen, Jangar Engineering Architecture
Scope: Jangar control-plane resilience, Kubernetes watch pressure, evidence transport health, scheduler admission,
GitHub review ingestion, rollout proof, Torghut repair dispatch, validation, rollback, and cross-stage handoff.

Companion Torghut contract:

- `docs/torghut/design-system/v6/192-torghut-freshness-carry-and-repair-proof-slo-2026-05-13.md`

Extends:

- `docs/agents/designs/187-jangar-stage-credit-ledger-and-runner-slot-futures-2026-05-13.md`
- `docs/agents/designs/187-jangar-main-source-ci-retention-and-source-serving-verdicts-2026-05-13.md`
- `docs/agents/designs/185-jangar-clearance-market-and-rollout-truth-settlement-2026-05-12.md`
- `docs/agents/designs/140-jangar-watch-reliability-state-exchange-and-capital-action-governor-2026-05-07.md`
- `docs/agents/designs/177-jangar-evidence-quality-admission-ledger-and-degradation-backpressure-2026-05-08.md`
- `services/jangar/README.md`

## Decision

I am selecting an **evidence pressure ledger with a watch backoff governor** as the next Jangar architecture increment.

The control plane is past the stage where "is the API pod ready" is a sufficient question. On the 2026-05-13 evidence
pass, Jangar itself was `Synced/Healthy` and serving, but the proof path that makes Jangar trustworthy was under
pressure: `agents` was `Synced/Progressing`, `agents-controllers` was only `1/2` ready, the not-ready controller
replica had a recent `503` readiness failure, Jangar logs showed Kubernetes watch failures including `Too Many
Requests` and `storage is (re)initializing`, and metrics export to Mimir was repeatedly failing. In the same window,
Jangar review ingestion could not resolve several deleted or missing branch refs, while retained AgentRun state since
2026-05-12T00:00Z showed `11` failed runs against `80` succeeded, `11` pending, and `6` running.

The selected design adds a pressure ledger that sits underneath stage credit. Stage credit decides whether a stage has
spendable runner credit. The pressure ledger decides whether the evidence plane is calm enough to spend that credit
without creating more blind retries. It measures Kubernetes watch pressure, API-server 429s, controller replica
agreement, metrics-sink health, review-ingest ref failures, database inspection reachability, and Torghut freshness
debt. It then emits an action-class decision and a backoff policy. The scheduler and deployer can keep read-only
serving open, admit one bounded repair when it retires a named pressure source, and hold normal dispatch, deploy
widening, and merge-ready claims while the proof path is unreliable.

The tradeoff is that this design slows work during noisy control-plane windows. I accept that. The business metric is
not raw run volume; it is fewer failed AgentRuns and shorter time from a green PR to a truly healthy GitOps rollout.
Spending another runner slot while the controller watch path is returning 429s is not leverage. It just makes the
handoff harder to trust.

## Governing Runtime Requirements

This design binds to the current swarm validation contract:

- every run must cite the governing design or runtime requirement before changing code;
- implement stages must produce production PRs with tests or report the exact blocker to code;
- verify stages must merge only green PRs and prove Argo, workload readiness, and service health after rollout;
- final handoff must name the control-plane metric improved or the smallest blocker preventing improvement.

Every milestone maps to at least one value gate:

- `failed_agentrun_rate`
- `pr_to_rollout_latency`
- `ready_status_truth`
- `manual_intervention_count`
- `handoff_evidence_quality`

## Read-Only Evidence Snapshot

All evidence in this pass was collected read-only on 2026-05-13. I did not mutate Kubernetes resources, database
records, GitOps resources, AgentRuns, broker state, Torghut flags, or trading data.

### Cluster And Rollout Evidence

- Runtime scope resolved to repository `proompteng/lab`, base `main`, head
  `codex/swarm-jangar-control-plane-discover`, stage `discover`, owner channel `swarm://owner/platform`, live channel
  `general`, mission ledger `/workspace/.agentrun/swarm/jangar-control-plane-mission-ledger.md`, and business metric
  "reduce failed AgentRuns and shorten green PR-to-healthy GitOps rollout time for the Jangar control plane".
- The local `codex/swarm-jangar-control-plane-discover` branch was aligned with `origin/main` at
  `fdc164d70 fix(jangar): stamp stage credit launch evidence` before this artifact was authored. The previous PR on
  the same head branch, `#5648`, was already merged at `b995800c313ac37f8829ea2f6b4df3374bfbfd5e`.
- Kubernetes auth resolved to `system:serviceaccount:agents:agents-sa`.
- Argo CD reported `jangar=Synced/Healthy`, `torghut=Synced/Healthy`, `torghut-options=Synced/Healthy`,
  `symphony-jangar=Synced/Healthy`, `symphony-torghut=Synced/Healthy`, `agents-ci=Synced/Healthy`, and
  `agents=Synced/Progressing`. `jangar` had last finished successfully at `2026-05-13T06:39:48Z`; `torghut` had last
  finished successfully at `2026-05-13T07:52:58Z`.
- Jangar namespace pods were all Running. `deployment/jangar` was `1/1`, `deployment/bumba` was `1/1`,
  `deployment/symphony-jangar` was `1/1`, and `deployment/jangar-alloy` was `1/1`. The Jangar pod had `2/2` containers
  ready.
- Agents namespace had `agents-controllers-f688965b5-4pf4d` ready and
  `agents-controllers-f688965b5-m8r2m` not ready with one restart. `deployment/agents-controllers` reported
  `1/2` ready, `2/2` updated, and `Available=False:MinimumReplicasUnavailable`.
- Agents events included a recent readiness probe failure for the not-ready controller replica:
  `Readiness probe failed: HTTP probe failed with statuscode: 503`.
- AgentRuns created since `2026-05-12T00:00:00Z` summarized to `80` Succeeded, `11` Failed, `11` Pending, and `6`
  Running. Failed reasons included `BackoffLimitExceeded`, `WorkflowStepTimedOut`, and `ProviderCapacityExhausted`.
- Jangar application logs showed Kubernetes watch failures for orchestration, signal delivery, and approval-policy
  resources. The most important class was HTTP `429` with body `storage is (re)initializing`, which means the watch
  client was correct to back off instead of multiplying list pressure.
- Jangar and agents-controller logs showed repeated metrics export failures to
  `observability-mimir-nginx.observability.svc.cluster.local/otlp/v1/metrics`, with `FailedToOpenSocket` and
  `ConnectionRefused`. That is not a launch blocker by itself, but it degrades the evidence sink that operators use to
  prove the rollout window.
- Jangar review ingest logged repeated `worktree snapshot refresh failed` messages for missing or deleted refs such as
  `codex/swarm-jangar-control-plane`, `codex/swarm-torghut-quant`, and release branches. Those are not runtime
  failures, but they create stale PR evidence unless the ingest path classifies missing refs as terminal, not retryable
  pressure.

### Source Evidence

- `services/jangar/src/server/control-plane-watch-reliability.ts` records events, errors, and restarts by watched
  resource and namespace. It degrades when errors are present or restart thresholds are crossed. The current gap is
  that it does not price API-server pressure, metrics-sink failure, or GitHub evidence-ingest churn into scheduler
  launch posture.
- `services/jangar/src/server/control-plane-stage-credit-ledger.ts` already turns clearance-market and stage-clearance
  evidence into spendable accounts and open runner-slot futures. The pressure ledger should feed this reducer as a
  debt tax and should not replace it.
- `services/jangar/src/server/supporting-primitives-schedule-runner.ts` already refreshes the control-plane status at
  fire time and stamps stage-credit fields on launched AgentRuns. That is the narrow integration point for a future
  pressure-gated hold mode.
- `services/jangar/src/server/github-review-ingest.ts` and
  `services/jangar/src/server/github-worktree-snapshot.ts` own the unresolved-ref failure class seen in logs. The
  design should classify deleted head refs as closed evidence, not hot retry work.
- `services/jangar/src/server/metrics.ts` and `services/jangar/src/server/metrics-config.ts` own OTLP/Mimir export.
  Metrics sink failure should be a proof-quality debt for deployer claims, not a reason to make the serving pod
  unready.
- Existing tests cover watch reliability, source-serving verdicts, stage credit, clearance market, repair-bid
  admission, control-plane status, and supporting-primitives scheduler stamping. The missing test family is pressure
  accounting: a watch-429 burst must hold normal dispatch while keeping read-only serving and bounded repair open.

### Database And Data Evidence

- Direct database inspection was RBAC-limited for this service account. CNPG cluster listing was forbidden,
  `kubectl cnpg psql -n jangar jangar-db` failed because `pods/exec` was forbidden on `pod/jangar-db-1`, and secret
  listing in `jangar` was forbidden. The smallest unblocker for row-level DB evidence is a read-only database
  credential or an explicit read-only psql/CNPG exec permission for this worker service account.
- The Jangar deployment still exposes the expected DB wiring through secret refs: `DATABASE_URL` from
  `jangar-db-app/uri`, `TORGHUT_DB_DSN` from `torghut-db-app/uri`, `JANGAR_DB_CA_CERT`, and `TORGHUT_DB_CA_CERT`.
- Torghut migration logs showed the app database and superuser database ready, and Alembic used transactional DDL. That
  is enough to classify schema migration startup as healthy, but not enough to validate row-level freshness.
- Torghut health was split. `/healthz` returned `{"status":"ok","service":"torghut"}`, while `/readyz` and
  `/trading/health` returned HTTP `503` from the latest private Knative revision.
- Torghut options catalog and enricher were ready. `torghut-options-catalog` returned `status=ok` with
  `last_success_ts=null`; `torghut-options-enricher` returned `status=ready` with
  `last_success_ts=2026-05-13T08:11:42.555315+00:00`.
- ClickHouse guardrail metrics were reachable. Both replicas were up, no replicated table was read-only, disk free
  ratio was near `0.97`, `ta_signals` max event time was `2026-05-12T20:57:00Z`, `ta_microbars` max window end was
  `2026-05-12T18:48:40Z`, and freshness low-memory fallback counters were nonzero for both tracked tables.
- Direct ClickHouse SQL returned HTTP `401`, so the design treats guardrail exporter metrics as the permitted read-only
  evidence surface for this worker.

## Problem

Jangar currently has strong action-level gates, but it does not have a single pressure budget for the evidence path that
feeds those gates.

The concrete failure modes are:

1. A deployment can be ready while one controller replica is not ready.
2. A watch stream can be returning Kubernetes `429` pressure while schedulers continue to submit more work.
3. Metrics export can fail, making rollout proof harder to audit, while readiness remains green.
4. Review-ingest can keep retrying missing branch refs and pollute the evidence channel with non-actionable errors.
5. Database row evidence can be unavailable to a worker, but the status surface may not say whether the proof is
   app-derived, exporter-derived, or DB-derived.
6. Torghut readiness can be `503` while liveness is OK and ClickHouse metrics are partly fresh.
7. Stage credit can reserve a runner slot without knowing that the evidence plane itself is under pressure.

That combination raises failed AgentRun rate and stretches PR-to-rollout latency. It also weakens handoff quality:
operators see healthy serving pods and have to infer whether proof transport is good enough to widen.

## Alternatives Considered

### Option A: Increase Controller Replicas And Keep Scheduling

The first path is to add more controller replicas and rely on Kubernetes to smooth over transient 503s and watch
reconnects.

Advantages:

- Simple operational story.
- More replicas can help with process crashes.
- Does not require a new payload section.

Disadvantages:

- It can increase API-server list/watch pressure during a 429 window.
- It does not classify missing GitHub refs or metrics sink failures.
- It does not tell the scheduler which action class is still safe.
- It can turn pressure into more duplicate work rather than less.

Decision: use replica work only after pressure accounting exists. Do not make it the architecture.

### Option B: Freeze All Non-Read-Only Work During Any Evidence Degradation

The second path is a hard freeze when any watch, controller, metrics, review-ingest, DB, or Torghut evidence surface is
degraded.

Advantages:

- Strong short-term safety.
- Easy to reason about during incidents.
- Reduces accidental normal dispatch.

Disadvantages:

- Blocks the zero-notional repair work needed to clear pressure.
- Treats a missing deleted Git ref the same as an active API-server 429.
- Pushes operators back to manual exceptions.
- Can increase PR-to-healthy latency by waiting for low-value sinks that are not material to the rollout.

Decision: keep as an emergency posture, not the default policy.

### Option C: Evidence Pressure Ledger With Watch Backoff Governor

The selected path emits a pressure ledger and an action-class governor. It ranks pressure sources, assigns TTLs and
severity, opens bounded repair where the repair retires pressure, and holds normal dispatch/deploy claims while the
proof path is not trustworthy.

Advantages:

- Separates serving readiness from proof-transport readiness.
- Converts watch 429s and metrics sink failures into typed debt instead of noisy logs.
- Keeps read-only serving and bounded repair available.
- Lets schedulers apply the same pressure budget before creating AgentRuns.
- Gives deployers a single receipt for why a green PR is or is not rollout-healthy.
- Fits the existing clearance-market and stage-credit model.

Disadvantages:

- Adds one more reducer and status payload.
- Requires careful reason-code normalization so harmless terminal failures do not block useful work.
- Requires scheduler adoption after the read model is validated.

Decision: select Option C.

## Architecture

Jangar emits one `evidence_pressure_ledger` per control-plane status generation.

```text
evidence_pressure_ledger
  schema_version = jangar.evidence-pressure-ledger.v1
  ledger_id
  namespace
  generated_at
  fresh_until
  governing_design_refs[]
  observed_revision
  evidence_mode                  # observe | shadow | hold | enforce
  pressure_sources[]
  watch_backoff_policy
  action_pressure_budget[]
  scheduler_handoff
  deployer_handoff
```

Each `pressure_source` is an evidence-plane fact:

```text
pressure_source
  source_id
  source_class                   # kubernetes_watch | controller_replica | metrics_sink | github_ingest | db_access | torghut_freshness
  severity                       # info | warning | hold | block
  observed_at
  expires_at
  evidence_ref
  message
  retryable
  terminal
  suggested_backoff_seconds
  value_gates[]
```

The watch backoff governor is explicit:

```text
watch_backoff_policy
  state                          # calm | pressured | brownout | blind
  max_new_list_requests_per_minute
  max_new_agent_runs_per_stage
  jitter_seconds
  retry_after_seconds
  stop_retry_reason_codes[]
  open_repair_reason_codes[]
```

Action pressure budgets map directly to the existing Jangar action classes:

```text
action_pressure_budget
  action_class                   # serve_readonly | dispatch_repair | dispatch_normal | deploy_widen | merge_ready | ...
  decision                       # allow | repair_only | hold | block
  pressure_tax
  max_dispatches
  max_runtime_seconds
  max_notional
  required_repair_receipts[]
  reason_codes[]
  rollback_target
```

Decision rules:

- `serve_readonly` remains allowed while the serving pod is healthy unless the pressure ledger is `blind`.
- `torghut_observe` remains allowed when Torghut consumer evidence can be read, even if capital is repair-only.
- `dispatch_repair` is `repair_only` when a current repair lot names a pressure source and has zero notional,
  bounded runtime, dedupe key, and required receipt.
- `dispatch_normal`, `deploy_widen`, and `merge_ready` are held while watch pressure is `pressured` or `brownout`, a
  controller replica split is current, or deployer proof sinks are unavailable.
- `paper_canary`, `live_micro_canary`, and `live_scale` remain held or blocked unless Torghut route warrants,
  source-serving proof, and freshness carry all pass.
- Missing or deleted GitHub refs are terminal evidence after one successful classification and should not keep
  retrying as active pressure.

## Implementation Scope

Engineer milestone 1 is read-model only:

- Add `control-plane-evidence-pressure-ledger.ts`.
- Consume watch reliability, controller witness, rollout health, metrics exporter health, GitHub review-ingest failure
  classes, database evidence authority, Torghut consumer evidence, and ClickHouse guardrail freshness.
- Emit `evidence_pressure_ledger` on `/api/agents/control-plane/status` and `/ready` in observe mode.
- Add unit tests for watch 429 pressure, controller replica split, metrics sink failure, deleted GitHub refs, and DB
  access denied evidence.
- Update `stage_credit_ledger` to include pressure-tax refs only after the read model is stable.

Engineer milestone 2 is scheduler adoption:

- Teach fire-time schedule runners to read `evidence_pressure_ledger`.
- In `hold` mode, fail closed for normal dispatch, deploy widening, and merge-ready when the ledger is stale or held.
- Keep read-only serving and one bounded repair path open when the pressure ledger names a current repair lot.
- Stamp `swarmEvidencePressureLedgerId`, `swarmEvidencePressureDecision`, and pressure reason codes on launched
  AgentRuns.

Engineer milestone 3 is evidence cleanup:

- Classify missing GitHub refs as terminal and stop hot retry loops.
- Add OTLP/Mimir sink pressure to status without making Jangar unready.
- Add a read-only DB evidence authority field so handoffs can distinguish app-derived proof from direct SQL proof.

Deployer milestone:

- Gate "green PR to healthy rollout" claims on a fresh `evidence_pressure_ledger` with `deploy_widen` and
  `merge_ready` decisions of `allow`.
- If the ledger is held only by metrics-sink proof debt, record the sink debt explicitly and keep service rollout
  separate from audit-proof completeness.

## Validation Gates

Local validation for the Jangar implementation:

- `bun run --filter @proompteng/jangar test -- control-plane-evidence-pressure-ledger`
- `bun run --filter @proompteng/jangar test -- supporting-primitives-controller`
- `bunx oxfmt --check services/jangar/src/server/control-plane-evidence-pressure-ledger.ts services/jangar/src/server/__tests__/control-plane-evidence-pressure-ledger.test.ts`

Cluster validation after deploy:

- `kubectl get app -n argocd jangar -o jsonpath='{.status.health.status} {.status.sync.status} {.status.operationState.phase}'`
- `kubectl get deploy -n agents agents-controllers -o wide`
- `kubectl get agentruns -n agents -o json` summarized by phase for the last 24 hours.
- `kubectl logs -n jangar deploy/jangar -c app --tail=200` checked for watch `429`, metrics sink, and review-ingest
  pressure classification.
- `curl -fsS http://jangar.jangar.svc.cluster.local/ready` confirming `evidence_pressure_ledger` is present and fresh.

Acceptance gates:

- `failed_agentrun_rate`: normal dispatch is held when pressure debt is active; repeated pressure-window failures fall
  over two rollout cycles.
- `pr_to_rollout_latency`: deployer handoff names whether latency is blocked by rollout, service health, Torghut proof,
  or evidence-sink debt.
- `ready_status_truth`: `/ready` and control-plane status distinguish service readiness from evidence pressure.
- `manual_intervention_count`: missing GitHub refs stop retrying after terminal classification.
- `handoff_evidence_quality`: every hold includes a ledger id, pressure source id, TTL, and smallest repair.

## Rollout

Phase 0 is documentation and handoff. This document is the governing design.

Phase 1 ships the reducer in observe mode. No scheduling behavior changes. Operators compare the pressure ledger
against existing watch reliability, stage credit, and rollout truth.

Phase 2 enables shadow scheduler reads. Schedule runners stamp pressure ledger refs on AgentRuns but do not block.

Phase 3 enables hold mode for `dispatch_normal`, `deploy_widen`, and `merge_ready`. `serve_readonly`,
`torghut_observe`, and bounded zero-notional pressure repair remain available.

Phase 4 evaluates whether `dispatch_repair` should require pressure-source receipts for specific Torghut repair lots.

## Rollback

Rollback is explicit and low risk:

- Set `JANGAR_EVIDENCE_PRESSURE_LEDGER_ENABLED=false` to remove the status projection.
- Set `JANGAR_EVIDENCE_PRESSURE_LEDGER_MODE=observe` to preserve the read model while disabling scheduler holds.
- Keep the existing stage-credit, clearance-market, source-serving verdict, runtime-admission, and dependency-quorum
  gates as fallback authority.
- If metrics sink evidence is wrong, ignore only `metrics_sink` pressure sources and keep Kubernetes watch pressure
  active.

Rollback does not require database mutation, Kubernetes object deletion, or Torghut capital changes.

## Risks And Mitigations

- Risk: pressure debt becomes a blanket blocker. Mitigation: action-class decisions keep read-only and bounded repair
  available.
- Risk: missing GitHub refs are misclassified as active failure. Mitigation: terminal classification with one retry and
  evidence retention.
- Risk: metrics sink failure blocks service rollout. Mitigation: sink failure is deployer proof debt, not serving
  readiness debt.
- Risk: direct database evidence remains unavailable. Mitigation: ledger records DB authority mode and exact RBAC
  blocker; implementation can proceed using app/exporter proof until read-only credentials exist.
- Risk: stage-credit and pressure-ledger decisions diverge. Mitigation: stage credit consumes pressure tax only after
  observe-mode comparison tests pass.

## Handoff

Engineer:

- Build the pure pressure-ledger reducer first.
- Keep the first PR observe-only with focused tests.
- Do not add scheduler blocking until pressure sources have stable reason codes and TTLs.
- Treat Kubernetes 429, controller replica split, metrics sink failure, missing GitHub refs, DB access denied, and
  Torghut freshness debt as separate source classes.

Deployer:

- Do not claim green PR-to-healthy rollout from Argo health alone.
- Require the rollout settlement, stage credit, source-serving verdict, and evidence pressure ledger to be fresh.
- If `merge_ready` is held, cite the pressure source id and smallest repair.
- Roll back enforcement by mode flag before rolling back service images.

The next bounded implementation milestone is:

```text
Add observe-mode evidence_pressure_ledger to Jangar status and /ready, with tests proving Kubernetes watch 429 pressure
holds normal dispatch while preserving serve_readonly and bounded zero-notional repair.
```
