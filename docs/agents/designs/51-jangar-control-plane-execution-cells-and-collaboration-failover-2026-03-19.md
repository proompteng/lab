# 51. Jangar Control-Plane Execution Cells and Collaboration Failover (2026-03-19)

Status: Approved for implementation (`plan`)
Date: `2026-03-19`
Owner: Victor Chen (Jangar Engineering)
Mission: `codex/swarm-jangar-control-plane-plan`
Swarm: `jangar-control-plane`

Supersedes or extends:

- `49-jangar-control-plane-authority-ledger-and-expiry-watchdog-2026-03-19.md`
- `49-jangar-control-plane-execution-truth-spine-and-torghut-profit-circuit-2026-03-19.md`
- `50-torghut-hypothesis-capital-governor-and-data-quorum-2026-03-19.md`

Companion document:

- `docs/torghut/design-system/v6/50-torghut-submission-parity-council-and-options-bootstrap-escrow-2026-03-19.md`

## Executive summary

The March 19 design pack correctly identified authority-ledger drift and profitability-governance contradictions, but
the live runtime still exposes one more systemic problem: Jangar still has no authoritative distinction between
service-level readiness, collaboration health, and canary-capable control-plane authority.

Read-only evidence captured on `2026-03-19` shows:

- `http://jangar.jangar.svc.cluster.local/ready` still returns `status=ok` while
  `agentsController.enabled=false` and `supportingController.enabled=false`;
- `http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status?namespace=agents` reports
  `watch_reliability.status="healthy"` and `dependency_quorum.decision="allow"`, but the richer `execution_trust`
  surface is still absent because it remains optional;
- Huly collaboration is a hard dependency in practice, but the worker-scoped account probe and `find-all` query both
  time out against `http://transactor.huly.svc.cluster.local` even though `GET /api/v1/version` succeeds;
- Torghut remains in a mixed state where core trading is up, but quant latest-store evidence is empty, the options lane
  is materially red, and ClickHouse freshness guardrails are falling back under load.

The selected architecture replaces "whole swarm frozen or healthy" with durable **Execution Cells**. Each cell owns a
bounded failure domain, a durable lease, an evidence bundle, and a rollout policy. Schedules are preserved when a cell
is unhealthy; only dispatch is suspended. Collaboration outages become a first-class cell with replayable outbox
semantics instead of silently blocking unrelated control-plane work. Safe rollout then depends on the cell graph, not
on a stale swarm phase or a green deployment probe.

## Live assessment snapshot

### Cluster health, rollout, and events

Evidence captured during this plan run:

- `curl -fsS http://jangar.jangar.svc.cluster.local/ready`
  - returned `{"status":"ok",...}`
  - `leaderElection.isLeader=true`
  - `agentsController.enabled=false`
  - `supportingController.enabled=false`
- `curl -fsS "http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status?namespace=agents"`
  - `watch_reliability.status = "healthy"`
  - `dependency_quorum.decision = "allow"`
  - `execution_trust` field absent because the feature flag is still effectively optional
- `kubectl -n torghut get events --sort-by=.lastTimestamp | tail -n 35`
  - repeated startup/readiness/liveness failures for `torghut-00153-deployment`
  - `torghut-options-catalog` and `torghut-options-enricher` remain in restart backoff
  - `torghut-options-ta` is still in `ImagePullBackOff`
  - `torghut-ws-options` remains probe-unhealthy
- `kubectl -n torghut get pod torghut-options-catalog-676574bcc9-wkqp5 -o json`
  - `restartCount=871`
  - `state.waiting.reason="CrashLoopBackOff"`
- `kubectl -n torghut get pod torghut-options-ta-7987889f4f-zxl5g -o json`
  - configured image digest is missing and the pod is stuck in `ImagePullBackOff`
- `python3 skills/huly-api/scripts/huly-api.py --operation account-info ...`
  - timed out on `GET /api/v1/account/c9b87368-e7a2-483f-885f-ff179e258950`
- `python3 skills/huly-api/scripts/huly-api.py --operation list-channel-messages ...`
  - timed out on `POST /api/v1/find-all/c9b87368-e7a2-483f-885f-ff179e258950`

Interpretation:

- Jangar can look service-ready while still lacking controller proof and collaboration proof for safe rollout.
- Torghut still has live mixed-state failures that should not collapse into one global freeze.
- Huly is not unreachable, but authenticated control-plane reads are hanging long enough to behave like an authority
  fault for mission delivery.

### Source architecture and high-risk modules

Highest-risk code seams:

- `services/jangar/src/server/control-plane-status.ts`
  - calculates `ready` as `phase.toLowerCase() !== 'frozen' && !freezeActive`, which means a stale frozen phase can
    continue to poison trust even after `freeze.until` has expired;
  - `DEFAULT_EXECUTION_TRUST_ENABLED = false`, so the authoritative truth surface is still optional;
  - dependency quorum already models segments, but those segments are not yet durable execution cells with ownership,
    expiry, or rollout policy.
- `services/jangar/src/server/supporting-primitives-controller.ts`
  - stale-stage detection is derived from recent runs and status timestamps;
  - unfreeze still depends on `swarmUnfreezeTimers`, which is process-local;
  - schedule intent and stage topology are not preserved separately from active dispatch.
- `services/jangar/src/routes/ready.tsx`
  - readiness only blocks on execution trust when the feature flag is enabled.
- `services/torghut/app/main.py`
  - `/readyz` and `/trading/status` expose richer capital semantics than the live scheduler actually enforces.
- `services/torghut/app/trading/scheduler/pipeline.py`
  - `_live_submission_gate()` only checks runtime flags and autonomy booleans, not the richer data/evidence quorum used
    in the API surface.
- `services/torghut/app/trading/completion.py`
  - `continuity_ok` and `dependency_allow` are flattened across rows, which makes it harder to distinguish which
    continuity dimension failed and whether the failure should demote one lane or all lanes.
- `services/torghut/app/options_lane/catalog_service.py` and `services/torghut/app/options_lane/enricher_service.py`
  - both instantiate `OptionsRepository(...)` and call `ensure_rate_bucket_defaults(...)` at module import time, so a
    DB auth issue crashes the service before readiness can publish explicit bootstrap state.

### Database and data assessment

Database access from this service account is read-only but RBAC-limited:

- `kubectl cnpg psql -n jangar jangar-db -- ...`
  - failed with `pods "jangar-db-1" is forbidden ... cannot create resource "pods/exec"`
- `kubectl cnpg psql -n torghut torghut-db -- ...`
  - failed with `pods "torghut-db-1" is forbidden ... cannot create resource "pods/exec"`

Service-level read-only evidence still shows the necessary data-state:

- `curl -fsS http://torghut.torghut.svc.cluster.local/db-check`
  - `ok = true`
  - `expected_heads = ["0024_simulation_runtime_context"]`
  - `schema_graph_branch_count = 1`
  - lineage warnings remain for forked parents at revisions `0010` and `0015`
- `curl -fsS http://torghut.torghut.svc.cluster.local/trading/status`
  - `live_submission_gate.allowed = true`
  - `capital_stage = "0.10x canary"`
  - `promotion_eligible_total = 0`
  - `hypotheses_total = 3`
  - `capital_stage_totals.shadow = 3`
- `curl -fsS http://jangar.jangar.svc.cluster.local/api/torghut/market-context/health?symbol=NVDA`
  - `overallState = "down"`
  - `bundleFreshnessSeconds = 275280`
  - ClickHouse ingestion reports `clickhouse_query_failed`
  - fundamentals and news are stale; technicals and regime are `error`
- `curl -fsS http://jangar.jangar.svc.cluster.local/api/torghut/trading/control-plane/quant/health?...`
  - `status = "degraded"`
  - `latestMetricsCount = 0`
  - `stages = []`
- `curl -fsS http://torghut.torghut.svc.cluster.local/metrics`
  - `torghut_trading_execution_clean_ratio 0.0`
  - `torghut_trading_alpha_readiness_promotion_eligible_total 0`
- `curl -fsS http://torghut-ws.torghut.svc.cluster.local:9090/metrics`
  - `torghut_ws_desired_symbols_fetch_degraded 0`
- `curl -fsS http://torghut-clickhouse-guardrails-exporter.torghut.svc.cluster.local:9108/metrics`
  - one replica reports `nan` freshness timestamps
  - `freshness_fallback_total` is elevated for both `ta_signals` and `ta_microbars`
- `curl -fsS http://jangar.jangar.svc.cluster.local/api/torghut/trading/control-plane/quant/alerts?...`
  - open critical alerts for `metrics_pipeline_lag_seconds` across `1m`, `5m`, `15m`, `1h`, `1d`, `5d`, and `20d`
- `kubectl -n torghut get pod torghut-db-1 -o json`
  - Postgres is ready, but `restartCount=38`

Interpretation:

- schema-current is not enough to authorize rollout or capital;
- freshness, ingestion, collaboration, and bootstrap need separate execution ownership;
- a database-access gap in the control-plane identity should surface as evidence, not as silent trust loss;
- healthy desired-symbol fetch and ready database pods are supporting signals, not substitutes for latest-store proof.

### Collaboration assessment

Required Huly checks were attempted with the dedicated architect token and expected actor id. The result was a platform
timeout, not a credential mismatch:

- `GET /api/v1/version` on `transactor.huly.svc.cluster.local` returns immediately;
- `GET /api/v1/account/c9b87368-e7a2-483f-885f-ff179e258950` times out;
- `POST /api/v1/find-all/c9b87368-e7a2-483f-885f-ff179e258950` also times out.

This must become a modeled collaboration cell with replayable local buffering. It cannot remain an implicit fatal
dependency for every stage.

## Problem statement

The current system still over-couples unrelated failures:

1. stale swarm phase, stage cadence, and freeze expiry can disagree for days;
2. unfreeze is partially driven by process-local timers instead of durable authority;
3. schedule definitions disappear or become operationally invisible when a swarm is frozen;
4. collaboration failures have no scoped degrade path and no replay contract;
5. Torghut profitability decisions are still allowed to diverge across `/readyz`, `/trading/status`, and the live
   scheduler.

That topology creates the wrong operational behavior: mixed-state failures turn into ambiguous global freezes, while
truly dangerous contradictions still slip through apparently healthy readiness surfaces.

## Alternatives considered

### Option A: keep the authority ledger and only patch stale-freeze handling

Pros:

- smallest implementation delta
- reuses the March 19 ledger work

Cons:

- does not preserve schedules as durable intent
- does not isolate collaboration failures
- still leaves Torghut submission parity as a downstream problem

Decision: rejected.

### Option B: introduce a global hard gate across collaboration, data, and rollout

Pros:

- simple to reason about
- maximum safety in the short term

Cons:

- too coarse for mixed-state production systems
- Huly timeouts or options bootstrap failures would block unrelated Jangar plan/discover work
- explicit failure-mode reduction is lost because everything fails the same way

Decision: rejected.

### Option C: execution cells with schedule preservation, collaboration failover, and submission parity

Pros:

- failure domains become explicit and durable
- rollout can be blocked narrowly by the cells affected by a change
- collaboration outages get an auditable degraded mode instead of becoming invisible fatal blockers
- Torghut profitability can consume the same execution-cell graph without forcing one global ready bit

Cons:

- requires additive schema, controller, and status-surface work
- demands disciplined dependency ownership metadata

Decision: selected.

## Decision

Adopt **Option C**.

The next control-plane layer is not another status summary. It is a durable execution-cell graph that preserves stage
intent, isolates failure domains, and turns collaboration plus profitability contradictions into explicit evidence.

## Proposed architecture

### 1. Durable execution cells

Add additive persistence owned by Jangar:

- `control_plane_execution_cells`
  - one row per `{swarm, cell_name, lane_scope}`
  - fields: `cell_type`, `owner_component`, `state`, `policy_mode`, `lease_expires_at`, `depends_on`, `reason_codes`
- `control_plane_execution_cell_events`
  - immutable append-only event log for state transitions
- `control_plane_execution_cell_evidence`
  - references to Kubernetes objects, HTTP snapshots, alert snapshots, and external dependency errors

Required first-wave cells:

- `stage-discover`
- `stage-plan`
- `stage-implement`
- `stage-verify`
- `controller-orchestration`
- `controller-supporting-primitives`
- `collaboration-huly`
- `source-auth-codex`
- `torghut-market-context`
- `torghut-quant-materialization`
- `torghut-options-bootstrap`

Each cell declares:

- `blocking_policy`: `hard`, `soft`, or `detached`
- `affected_surfaces`: status, readiness, rollout, submission, collaboration
- `degrade_scope`: `cell`, `lane`, `swarm`, or `global`

### 2. Preserve schedule intent even while dispatch is suspended

Freezing or holding a swarm must never erase or hide schedule intent.

New rules:

- schedule manifests remain the durable source of stage intent;
- unhealthy cells suspend dispatch, not configuration;
- the UI and `/api/agents/control-plane/status` always surface preserved schedules plus the cell that is currently
  blocking dispatch;
- expired freeze state becomes a derived execution-cell transition, never a long-lived raw swarm phase.

Implementation expectation:

- move from `phase == Frozen` as operational truth to `cell_state in {hold, blocked, recovering}`;
- persist the desired next stage dispatch in the execution-cell graph so engineer and deployer can replay it after
  recovery.

### 3. Replace process-local unfreeze with durable reconciliation leases

`swarmUnfreezeTimers` can remain an optimization, but it must stop being the authority.

Required behavior:

- the authoritative unfreeze decision is derived from cell leases stored in the database;
- controller restarts must be able to reconstruct pending unfreeze work from persisted rows;
- `/ready` fails closed when a required cell is expired or stale, regardless of whether the in-process timer fired.

### 4. Collaboration failover and replayable outbox

Add `control_plane_collaboration_outbox` with:

- `channel_kind`
- `message_class`
- `payload_ref`
- `attempted_at`
- `delivery_state`
- `error_class`
- `replay_after`

Behavior:

- if Huly account lookup or `find-all` times out, the `collaboration-huly` cell becomes `degraded`;
- stage work that requires human-facing audit artifacts writes to the outbox and references the outbox item in the
  execution-cell evidence bundle;
- rollout and deploy stages remain blocked if their required collaboration policy is `hard`;
- discover and plan stages may proceed in `detached` mode only when GitHub PR/merge evidence and local handoff
  artifacts are present.

That gives us bounded failure scope without losing auditability.

### 5. Rollout predicates consume the cell graph and emit clearance leases

Rollout and `/ready` must stop reasoning from a loose mix of rollout health, stale swarm phase, and optional trust.

Required contract:

- `/ready`
  - returns non-200 when any `hard` required cell is `blocked`, `expired`, or `unreconciled`
- `/api/agents/control-plane/status`
  - always includes execution cells, their owners, expiry, evidence refs, and degrade scope
- rollout controller
  - writes a WAL row that includes the cell snapshot used for each canary decision
  - blocks only on cells mapped to the changed subsystem

Example mapping:

- Jangar controller changes depend on `stage-*`, `controller-*`, `source-auth-codex`, `collaboration-huly`
- Torghut options changes depend on `torghut-options-bootstrap`, `torghut-market-context`, `torghut-quant-materialization`
- Torghut quant-only changes need not block on options bootstrap when the changed hypotheses do not declare
  `options-data`

The deployable view of this graph is a **clearance lease**:

- a lease is valid only while every required hard cell is fresh;
- the lease records the exact cell snapshot used for the decision;
- Torghut and deployer tooling must treat a missing or expired lease as `observe` or `hold`, never as implicit canary.

### 6. Torghut submission parity plugs into the same cell graph

The Torghut submission council defined in the companion v6 document must consume execution cells as first-class
dependency inputs. That gives one shared truth for:

- `live_submission_gate`
- Jangar quant status
- rollout approval for profitability-affecting changes

Execution cells therefore become the common contract between reliability and profitability.

## Validation gates

Engineer gates:

- add regression tests in `services/jangar/src/server/__tests__/control-plane-status.test.ts`
  - expired `freeze.until` plus stale `phase == Frozen` becomes `recovering` or `blocked_expired`, not silently ready
- add regression tests in `services/jangar/src/routes/ready.test.ts`
  - `/ready` must fail when a required hard cell is expired or collaboration is hard-blocked
- add controller tests in `services/jangar/src/server/__tests__/supporting-primitives-controller.test.ts`
  - frozen swarms preserve schedules and dispatch intent
  - controller restarts reconstruct unfreeze work from durable rows
- add parity tests across Torghut status and scheduler inputs
  - same evidence bundle must produce the same gate decision in API and runtime

Deployer gates:

- induce one stage-staleness drill and prove preserved schedules remain visible while dispatch is blocked;
- induce one Huly timeout drill and prove the outbox captures the message plus replay state;
- no rollout progression when any required `hard` cell is not healthy or recovering within policy;
- no canary-capable lease when `latestMetricsCount == 0` or `torghut_trading_execution_clean_ratio < 0.75` for the
  affected profitability lanes;
- store and archive the cell snapshot used for every canary step.

## Rollout plan

1. Add execution-cell, evidence, and outbox tables without changing readiness behavior.
2. Mirror current truth into cells and surface them in `/api/agents/control-plane/status`.
3. Preserve schedules during freeze/hold and add durable unfreeze reconstruction.
4. Switch `/ready` and rollout predicates from legacy phase logic to cell logic in canary.
5. Make Torghut submission parity consume the same cell graph.

## Rollback plan

If cell-based gating creates false positives:

- keep writing execution-cell and outbox rows;
- revert readiness and rollout predicates to advisory mode;
- preserve all evidence bundles, cell events, and outbox entries for replay and incident review.

Do not delete cell state during rollback. The incident record is part of the control-plane contract.

## Risks and tradeoffs

- More schema and cell metadata increases complexity.
- Incorrect `blocking_policy` defaults could either over-block or under-block rollout.
- Detached collaboration mode could be abused if evidence requirements are weak.

Mitigations:

- ship with a small fixed cell taxonomy first;
- require explicit owner and degrade scope for every cell;
- gate detached collaboration mode on durable GitHub/PR evidence and local handoff artifacts;
- keep an operator-visible mapping from changed subsystem to required cells.
