# 129. Jangar Consumer Evidence Return Ledger And Rollout Settlement (2026-05-06)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-06
Owner: Gideon Park, Torghut Traders architecture
Scope: Jangar control-plane resilience, Torghut consumer evidence, material-action receipt reconciliation, rollout
settlement, paper/live capital holds, and rollback-safe deployment gates.

Companion Torghut contract:

- `docs/torghut/design-system/v6/133-torghut-consumer-evidence-return-path-and-shadow-settlement-2026-05-06.md`

Extends:

- `128-jangar-runtime-convergence-ledger-and-capital-gate-receipts-2026-05-06.md`
- `128-jangar-terminal-run-settlement-and-forecast-reentry-admission-2026-05-06.md`
- `127-jangar-activation-inventory-ledger-and-product-gap-fuses-2026-05-06.md`
- `120-jangar-material-action-verdict-arbiter-and-clock-budget-parity-2026-05-06.md`

## Decision

I am selecting a **consumer evidence return ledger with rollout settlement** for Jangar's next control-plane
resilience step.

Jangar is currently healthy enough to produce control-plane truth, but it cannot yet prove that Torghut consumed that
truth before a material action. At about 20:13 UTC on 2026-05-06, Jangar reported healthy agents-controller,
supporting-controller, orchestration-controller, workflow runtime, job runtime, Temporal configuration, execution
trust, database migrations, runtime kits, watch reliability, and rollout health. The NATS collaboration runtime kit was
healthy and no longer missing the `nats` binary. The dependency quorum decision was `allow`.

The material-action surface still identified the right hold: paper canary and live micro canary were held on
`torghut_consumer_evidence_missing` plus `forecast_service_degraded`, and live scale was blocked by
`paper_settlement_required`. That is the correct safety posture. The missing architecture is a durable return path that
lets Torghut echo scoped evidence back to Jangar, so Jangar can distinguish "consumer did not report" from "consumer
reported current evidence and paper is held for precise reasons."

The selected design adds a Jangar ledger for Torghut consumer evidence receipts. Jangar will store receipts, validate
their freshness and revision binding, reconcile them with material-action verdicts, and keep rollout settlement in
shadow until both producer and consumer facts agree. This reduces failure modes where a healthy Jangar route or
healthy Torghut route is mistaken for capital readiness.

The tradeoff is another ledger table and reconciliation reducer. I accept it because the alternative is worse:
continuing to make deployers manually reconcile route JSON, rollout events, Postgres freshness, ClickHouse metrics,
and historical workflow failures every time Torghut advances.

## Runtime Objective And Success Metrics

This contract improves Jangar resilience by making material-action receipts consumer-acknowledged, not merely
producer-issued.

Success means:

- Jangar stores the latest Torghut receipt by account, action class, runtime mode, active revision, and source commit.
- Stale, missing, or revision-mismatched receipts keep `torghut_consumer_evidence_missing` or replace it with
  `torghut_consumer_evidence_stale`.
- Current receipts replace the generic missing-consumer blocker with exact Torghut reason codes.
- Paper and live decisions remain held while forecast, scoped quant, empirical, TCA, or live-submission blockers are
  present.
- Rollout settlement can prove both sides: Jangar control-plane producer truth and Torghut consumer acceptance.

## Evidence Snapshot

All evidence was collected read-only. I did not mutate Kubernetes resources, database rows, GitOps manifests, broker
state, trading flags, or runtime objects.

### Cluster And Runtime Evidence

- `deployment/jangar` was `1/1` available at image
  `registry.ide-newton.ts.net/lab/jangar:885c987a@sha256:58a03e02e5d28314d8315d1d57f046592c18168e52c0fe8874b2885ffe2e2a15`.
- `deployment/agents` was `1/1`, and `deployment/agents-controllers` was `2/2`.
- Recent agents events still showed transient readiness timeouts on `agents` and controller pods, so rollout
  settlement must be based on fresh observed receipts, not only current deployment availability.
- Agents namespace AgentRun history showed current scheduled Torghut and Jangar work running, many completed runs, and
  older failed verify/discover attempts. This supports keeping failure history in the ledger rather than treating the
  latest green status as complete truth.
- Argo Workflows had many recent `torghut-historical-simulation-*` pods in `Error`, which must remain visible to
  Torghut paper/live material-action decisions.

### Jangar Route Evidence

- Jangar `/api/agents/control-plane/status?namespace=agents` returned a healthy dependency quorum with high confidence.
- `watch_reliability` was healthy with two observed streams and zero errors in the 15-minute window.
- Runtime kits reported `runtime-kit:collaboration:fee1652baa2bb4e2` healthy with `codex-nats-publish`,
  `codex-nats-soak`, `nats`, workspace path, and `NATS_URL` present.
- Material-action receipts allowed `torghut_observe` and held `paper_canary` and `live_micro_canary`.
- The hold reasons included `torghut_consumer_evidence_missing` and `forecast_service_degraded`; live scale also had
  `paper_settlement_required`.
- Jangar empirical services reported forecast degraded with `registry_empty`, Lean disabled, and empirical jobs healthy
  on the live Torghut endpoint.

### Torghut Consumer Evidence

- Live Torghut was route-healthy but `/readyz` was degraded by the live submission gate.
- Live status reported `simple_submit_enabled=false`, `quant_health_not_configured`, `forecast_service=registry_empty`,
  empirical jobs fresh, and three hypotheses with zero promotion eligibility.
- Sim Torghut was route-ready, but scoped sim quant had `latest_metrics_count=0` and sim empirical jobs were missing.
- Postgres was current at Alembic `0029_whitepaper_embedding_dimension_4096`, but executions and TCA metrics had not
  updated since 2026-04-03.
- ClickHouse guardrail metrics were fresh and healthy, but direct app-user ClickHouse auth from this workspace failed;
  Jangar should not depend on broad direct ClickHouse credentials for this receipt loop.

### Source Evidence

- `services/jangar/src/server/control-plane-status.ts` already exposes the status projection that material-action
  receipts are built around.
- `services/jangar/src/server/control-plane-heartbeat-store.ts` already persists producer heartbeat truth.
- `services/jangar/src/server/control-plane-material-action-verdict.ts` already has action classes and reason codes
  that can consume receipt-derived evidence.
- `services/jangar/src/server/torghut-quant-metrics-store.ts` owns high-volume quant metrics and should remain the
  producer-side quant authority.
- The missing source surface is a consumer receipt store and reducer that reconciles Torghut's receipt with existing
  material-action verdicts.

## Problem

Jangar's current control-plane status can answer "are my controllers and runtime adapters healthy?" It cannot yet
answer "did Torghut consume my verdict and return scoped evidence for this action class?"

That gap creates four failure modes:

1. **Green producer, silent consumer.** Jangar can be healthy while Torghut never emits evidence for paper/live.
2. **Green route, unsafe capital.** Torghut routes can be healthy while sim quant, sim empirical jobs, or TCA
   settlement are missing.
3. **Stale receipt, false confidence.** A receipt from an older revision can survive a rollout unless Jangar binds it
   to source commit and active revision.
4. **Manual rollout settlement.** Deployers must manually interpret multiple systems during every promotion.

Jangar needs a ledger that turns consumer evidence into a first-class control-plane input with expiry, revision
binding, and action-class decisions.

## Alternatives Considered

### Option A: Keep `torghut_consumer_evidence_missing` Until Paper Is Ready

Do nothing in Jangar and leave paper/live holds as they are.

Pros:

- Safest short-term behavior.
- No new schema or route.
- No extra reconciliation code.

Cons:

- Gives engineers no precise repair target after Torghut starts producing evidence.
- Prevents observe receipts from proving rollout convergence.
- Keeps deployers in a manual evidence-joining loop.

Decision: reject.

### Option B: Treat Torghut `/trading/status` As The Receipt

Have Jangar scrape status and infer consumer evidence directly from the existing live and sim route payloads.

Pros:

- Fast implementation.
- Uses fields already exposed by Torghut.
- No new Torghut route required.

Cons:

- The route is a status surface, not a stable receipt contract.
- It is not action-class scoped.
- It lacks explicit expiry and Jangar verdict acknowledgment.
- It makes source-commit and active-revision mismatch handling fragile.

Decision: reject.

### Option C: Consumer Evidence Return Ledger

Add a typed Jangar ledger for Torghut receipts and reconcile it with material-action verdicts.

Pros:

- Makes consumer acknowledgment explicit.
- Supports least-privilege validation through route payloads and receipt storage.
- Replaces generic missing-consumer holds with precise blockers.
- Keeps paper/live held while allowing observe and repair to proceed.
- Produces durable evidence for deployer and owner handoff.

Cons:

- Adds a table, route, and reducer.
- Requires Torghut and Jangar cross-service tests.
- Needs disciplined TTL and revision invalidation.

Decision: select Option C.

## Architecture

Jangar stores one latest receipt projection and an append-only receipt history.

```text
torghut_consumer_evidence_receipts
  receipt_id
  account_label
  action_class
  runtime_mode
  active_revision
  source_commit
  image_digest
  generated_at
  expires_at
  decision
  reason_codes
  rollback_target
  payload_json
  payload_sha256
  accepted_at
  validation_status
  validation_reasons
```

The reconciliation reducer runs inside material-action projection:

```text
material_action_consumer_reconciliation
  action_class
  jangar_verdict_id
  torghut_receipt_id
  receipt_status       # missing, stale, revision_mismatch, accepted, rejected
  producer_decision
  consumer_decision
  reconciled_decision
  reason_codes
  required_repairs
  rollback_target
```

Validation rules:

- Receipt `expires_at` must be in the future.
- Receipt source commit must match the Torghut runtime commit observed by route or declared rollout source.
- Receipt active revision must match the current action-class target when the action class is paper or live.
- Receipt payload hash must match the stored payload.
- Paper and live action classes require a Jangar material-action verdict id in the receipt.
- Receipts cannot upgrade Jangar decisions; they can only replace missing-consumer blockers or add stricter blockers.

## Implementation Scope

Jangar engineer tasks:

- Add the receipt tables and Kysely migration.
- Add a write endpoint for Torghut receipts, authenticated by the existing in-cluster service-to-service path.
- Add a read endpoint that returns latest receipt status by account/action class.
- Extend material-action verdict projection to consume receipt status.
- Add tests for missing, stale, revision-mismatch, accepted, and stricter-consumer receipt cases.
- Keep the feature shadowed behind `JANGAR_TORGHUT_CONSUMER_EVIDENCE_LEDGER_ENABLED=false`.

Torghut engineer tasks are defined in the companion document.

## Validation Gates

Local validation:

- Targeted Jangar tests for control-plane status and material-action verdict reconciliation.
- Kysely migration validation.
- Existing Jangar lint/type checks for touched TypeScript files.

Cluster validation:

- Jangar status remains healthy before and after enabling receipt ingestion in shadow.
- A current Torghut observe receipt changes the receipt status from `missing` to `accepted` without changing paper/live
  notional.
- A stale receipt is rejected and continues to block paper/live.
- A receipt from an old Torghut revision is rejected after a rollout.
- Paper and live remain held when the receipt reports forecast degradation, scoped quant gaps, missing empirical jobs,
  stale TCA settlement, or live submission disabled.

## Rollout

Phase 0: merge documentation only.

Phase 1: ship schema and read-only status projection with the ledger disabled.

Phase 2: enable receipt writes in shadow mode and store receipts without changing material-action decisions.

Phase 3: expose reconciliation status in Jangar control-plane status and Jangar UI.

Phase 4: let observe and repair action classes use accepted receipts to clear `torghut_consumer_evidence_missing`.

Phase 5: allow paper action class to consume receipt-derived reasons only after Torghut sim scoped quant, empirical
jobs, forecast, and settlement gates are repaired.

Live action classes remain blocked until paper settlement proves post-cost performance and rollback rehearsal.

## Rollback

Rollback must never require deleting receipts.

- Disable `JANGAR_TORGHUT_CONSUMER_EVIDENCE_LEDGER_ENABLED`.
- Disable material-action reconciliation against Torghut receipts.
- Keep existing material-action verdict logic and missing-consumer holds.
- Expire all receipt-derived projections by ignoring rows after the feature flag is disabled.
- If schema rollback is required, leave the append-only table in place and stop writing to it until a cleanup PR is
  reviewed.

## Risks

- Receipt acceptance could be too permissive. The reducer must never let a Torghut receipt widen an action beyond
  Jangar's current verdict.
- Revision matching can be wrong during rapid Knative rollout. Use active revision plus source commit plus image digest
  where available.
- Torghut status route shape can change. The receipt payload should be versioned and validated independently from
  status JSON.
- Historical workflow failures can be hidden if the receipt only carries current route health. The schema must include
  simulation proof state and failure-derived blockers.
- Shadow mode can become permanent. Engineer and deployer handoff must define the repair gates needed to advance.

## Engineer Handoff

Build the ledger and reducer as a shadow feature. The first usable state is not paper approval; it is a Jangar status
that says: Torghut receipt accepted for observe, paper still held because sim quant/empirical/forecast evidence is not
ready, live still held because paper settlement and live submission are not ready.

Acceptance gates:

- Missing receipt remains a blocker.
- Current observe receipt clears only the missing-consumer blocker for observe/repair.
- Stale or revision-mismatched receipts are rejected.
- Receipt-derived blockers are visible in the Jangar status payload.
- Paper/live max notional remains zero in shadow rollout.

## Deployer Handoff

Deploy the ledger without changing capital behavior. Validate it with current live/sim receipts and a forced stale
receipt case if the engineer provides a test fixture route.

Deployment gates:

- Jangar and agents deployments remain available.
- Watch reliability remains healthy.
- Runtime kit collaboration remains healthy.
- The latest Torghut receipt expires and refreshes as expected after a rollout.
- Paper and live material-action receipts remain held until explicit follow-up gates are green.
