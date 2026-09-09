# 53. Jangar Dependency Provenance Ledger and Consumer-Acknowledged Admission (2026-03-19)

Status: Ready for merge (discover architecture lane)
Date: `2026-03-19`
Owner: Gideon Park (Torghut Traders Architecture)
Related mission: `codex/swarm-torghut-quant-discover`
Swarm impacts:

- `jangar-control-plane`
- `torghut-quant`

Extends:

- `51-jangar-control-plane-execution-cells-and-collaboration-failover-2026-03-19.md`
- `52-jangar-rollout-epoch-witness-and-segment-circuit-breakers-2026-03-19.md`

Companion doc:

- `docs/torghut/design-system/v6/52-torghut-profit-sleeves-segment-scoped-deallocation-and-evidence-decay-2026-03-19.md`

## Executive summary

The March 19 architecture pack improved rollout truth, but the current live and source state still leave one material
reliability gap: Jangar has segment concepts, rollout epochs, and watch health, yet it still cannot prove which
consumer accepted which dependency state, which segment actually caused a block, or whether a supposedly healthy
`allow` decision is still fresh enough to trust.

Read-only evidence captured on `2026-03-19` shows:

- `GET /ready` on `jangar` returns `status="ok"` while `agentsController.enabled=false` and
  `supportingController.enabled=false`;
- `GET /api/agents/control-plane/status?namespace=agents` reports healthy controllers, healthy rollout health, and
  `dependency_quorum.decision="allow"` even though both live `Swarm` objects remain frozen on stale March 11
  timestamps;
- the same mission cannot complete required Huly collaboration because worker-scoped `account-info` and
  `list-channel-messages` time out against `http://transactor.huly.svc.cluster.local`, while the public host returns
  Cloudflare `403 / Error 1010`;
- `services/jangar/src/server/control-plane-status.ts` can emit top-level block or delay reasons without attaching a
  corresponding segment reason, which makes the segment contract weaker than the top-level decision;
- `services/torghut/app/trading/hypotheses.py` collapses Jangar dependency truth to `decision/reasons/message` and a
  local TTL cache, discarding upstream segments, degradation scope, freshness timestamps, and rollout provenance.

The selected architecture introduces a durable **Dependency Provenance Ledger**. Jangar does not merely compute
`allow/delay/block`; it publishes consumer-addressable segment rows with freshness, evidence references, rollout epoch,
config hash, and acknowledgement status. Admission then becomes consumer-aware and fail-closed on stale or lossy data.

## Mission inputs and success criteria

Observed mission inputs:

- repository: `proompteng/lab`
- base: `main`
- head: `codex/swarm-torghut-quant-discover`
- swarmName: `torghut-quant`
- swarmStage: `discover`
- ownerChannel: `swarm://owner/trading`

This architecture artifact succeeds when:

1. cluster, source, database, and collaboration evidence are captured with concrete read-only proof;
2. rollout truth depends on persisted segment provenance instead of transient in-process summaries;
3. consumers such as Torghut can fail closed on stale or incomplete control-plane evidence without suppressing
   unrelated hypotheses;
4. engineer and deployer stages receive explicit validation, rollout, and rollback contracts.

## Assessment snapshot

### Cluster health, rollout, and collaboration evidence

Read-only evidence captured on `2026-03-19`:

- `curl -fsS http://jangar.jangar.svc.cluster.local/ready`
  - returned `status="ok"`
  - `agentsController.enabled=false`
  - `supportingController.enabled=false`
- `curl -fsS 'http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status?namespace=agents'`
  - `controllers[*].status="healthy"` for `agents-controller`, `supporting-controller`, and `orchestration-controller`
  - `dependency_quorum.decision="allow"`
  - `rollout_health.status="healthy"`
  - `watch_reliability.total_restarts=2`
  - `database.migration_consistency.applied_count=24`
- `kubectl -n agents get swarm jangar-control-plane torghut-quant -o yaml`
  - both swarms still report `phase: Frozen`
  - both retain `freeze.until` timestamps on `2026-03-11`
  - both show `StageStaleness` evidence based on March 8 stage executions
- `python3 skills/huly-api/scripts/huly-api.py --operation account-info ...`
  - timed out after `20s` on `GET /api/v1/account/c9b87368-e7a2-483f-885f-ff179e258950`
- `python3 skills/huly-api/scripts/huly-api.py --operation list-channel-messages ...`
  - timed out after `20s` on `POST /api/v1/find-all/c9b87368-e7a2-483f-885f-ff179e258950`
- `python3 skills/huly-api/scripts/huly-api.py --operation account-info --base-url https://huly.proompteng.ai ...`
  - returned Cloudflare `403` / `Error 1010: Access denied`

Interpretation:

- Jangar still exposes contradictory truths across readiness, control-plane status, and swarm status.
- Huly collaboration is still an infrastructure dependency, not a segment-local, replayable control-plane input.
- Operator trust is still partly based on transient views instead of persisted consumer acknowledgement.

### Source architecture and high-risk modules

Current-branch seams that motivate this design:

- `services/jangar/src/server/control-plane-status.ts`
  - computes top-level `blockReasons` and `delayReasons`, but `executionTrust` block/delay paths do not populate a
    matching segment reason, so `dependency_quorum.decision` can be stricter than `segments[]`;
  - still treats execution trust as an optional overlay (`DEFAULT_EXECUTION_TRUST_ENABLED = false`) for some entry
    points.
- `services/jangar/src/routes/ready.tsx`
  - only enforces execution trust when a feature flag is enabled, which allows `/ready` to disagree with the richer
    control-plane surface.
- `services/jangar/scripts/codex/codex-implement.ts`
  - resolves the active Huly channel correctly, but collaboration verification remains a blocking transport call with
    no durable outbox or replayable acknowledgement record.
- `services/torghut/app/trading/hypotheses.py`
  - `JangarDependencyQuorumStatus` carries only `decision`, `reasons`, and `message`;
  - the local cache is keyed by URL and local `checked_at`, not by upstream freshness or rollout epoch;
  - segment and degradation-scope detail is discarded before hypothesis decisions are computed.
- `services/jangar/src/server/torghut-quant-runtime.ts`
  - quant alerts materialize observability evidence, but they do not emit an authoritative `action_taken`,
    `next_check_at`, or capital-allocation consequence back to control-plane truth.

Current missing tests:

- no regression proving every non-healthy dependency decision must degrade or block at least one concrete segment;
- no regression proving stale consumer acknowledgement forces `delay` or `block`;
- no regression proving `/ready`, `/api/agents/control-plane/status`, and `Swarm.status` are derived from the same
  admission truth;
- no regression proving Huly transport failures degrade collaboration only and preserve replayable mission delivery;
- no regression proving Torghut hypothesis evaluation fails closed when Jangar freshness, epoch, or segment evidence is
  missing.

### Database and data continuity evidence

The databases are reachable enough to surface truth, but database health is not the missing contract:

- Jangar reports `database.status="healthy"` and `applied_count=24/unapplied_count=0`;
- Torghut reports `schema_current=true` and current head `0024_simulation_runtime_context`;
- direct `kubectl cnpg psql ...` access is RBAC-forbidden for this service account because `pods/exec` is disallowed.

That means the missing reliability primitive is not "more database checks." It is a durable representation of which
segments were fresh, which consumer saw them, and whether a control-plane decision has expired.

## Problem statement

The current system still fails reliability-critical questions:

1. Which segment actually caused `delay` or `block`?
2. Which consumer acknowledged the latest rollout epoch and config hash?
3. Is the `allow` decision fresh, or is it only cached local optimism?
4. Did collaboration fail as a transport dependency, or as a mission artifact write failure?
5. Should Torghut suppress one hypothesis, one dependency capability, or all capital changes?

Without those answers, rollout safety depends on operator interpretation instead of durable control-plane truth.

## Alternatives considered

### Option A: patch segment-reason propagation only

Pros:

- smallest immediate change
- directly fixes one discovered inconsistency

Cons:

- does not solve consumer acknowledgement
- does not create freshness or expiry truth for downstream consumers
- does not make collaboration replayable

Decision: rejected.

### Option B: rely on the existing rollout epoch witness and segment circuit breakers

Pros:

- builds on already-merged design contracts
- keeps the control-plane object model smaller

Cons:

- rollout epochs still do not identify which consumer accepted the epoch
- Torghut still receives a lossy, coarse dependency payload
- `/ready`, `Swarm.status`, and downstream cached status can still diverge

Decision: rejected.

### Option C: dependency provenance ledger plus consumer acknowledgement

Pros:

- reduces failure modes by making stale, lossy, or unacknowledged control-plane truth explicit
- gives Torghut hypothesis code segment-scoped dependency evidence instead of one coarse decision
- lets collaboration degrade locally with replay semantics instead of aborting unrelated mission paths

Cons:

- requires new persistence and status-shaping work in both Jangar and Torghut
- raises the bar for rollout and canary admission because acknowledgement becomes mandatory

Decision: selected.

## Decision

Jangar will publish a durable **Dependency Provenance Ledger** and derive all admission surfaces from it.

The ledger contains three first-class objects:

1. `dependency_segments`
   - one row per namespace, segment, rollout epoch, and producer snapshot
   - fields: `status`, `scope`, `reasons[]`, `observed_at`, `expires_at`, `evidence_refs[]`, `producer_revision`,
     `producer_config_hash`, `degradation_scope`
2. `consumer_acknowledgements`
   - one row per consumer, namespace, rollout epoch, and config hash
   - fields: `consumer`, `consumer_revision`, `consumer_config_hash`, `acknowledged_at`, `fresh_until`, `ack_state`
3. `collaboration_outbox`
   - one row per Huly mission artifact attempt
   - fields: `artifact_kind`, `target_channel`, `attempt_state`, `first_failed_at`, `last_attempt_at`,
     `replay_after`, `blocking_scope`

`/ready`, `/api/agents/control-plane/status`, `Swarm.status`, and downstream Torghut dependency fetches must all be
derived from the same ledger snapshot. If segment truth or acknowledgement is stale, admission becomes `delay` or
`block` according to explicit policy rather than cached optimism.

## Architecture

### 1. Segment provenance becomes authoritative

Each dependency segment must carry its own reasons and scope. A top-level `block` without a blocked segment is invalid.

Required segment classes:

- `control_runtime`
- `workflow_runtime`
- `watch_stream`
- `rollout_consumer_ack`
- `collaboration_huly`
- `market_data_context`
- `evidence_authority`
- `empirical_jobs`

Admission rules:

- any blocked segment with `scope=global` forces `decision=block`;
- degraded segments with `scope=single_capability` force `decision=delay` only for consumers that require them;
- missing segment freshness or missing reasons is itself a blocked provenance error;
- segment reasons are immutable evidence, not only rendered message text.

### 2. Consumer acknowledgement gates rollout and admission

Rollout epochs are not complete when Jangar emits them. They are complete when required consumers acknowledge:

- expected rollout epoch id
- expected config hash
- expected dependency schema version
- freshness deadline

For this mission, required consumers are:

- Torghut trading runtime
- Torghut quant control-plane materializer
- Jangar mission-delivery path for Huly collaboration

If Torghut has not acknowledged the current epoch or config hash, Jangar may still expose a healthy control plane, but
admission for profit-affecting decisions must degrade to `delay` or `block`.

### 3. Collaboration becomes a replayable dependency segment

Huly transport failure must not remain an opaque fatal precondition. Instead:

- `account-info`, `verify-chat-access`, `post-channel-message`, and `upsert-mission` attempts append to the
  collaboration outbox;
- the `collaboration_huly` segment is degraded when delivery is delayed and blocked only for stages that require a
  durable owner update before completion;
- engineer and deployer stages receive a replay cursor and can resume artifact publication when Huly recovers;
- the outbox captures exact failure cause (`timeout`, `actor_mismatch`, `cloudflare_block`, `auth_missing`).

### 4. Torghut consumes provenance, not only decisions

Torghut must stop collapsing Jangar truth to `decision/reasons/message`. The payload contract should include:

- `decision`
- `reasons`
- `segments[]`
- `degradation_scope`
- `generated_at`
- `observed_at`
- `expires_at`
- `rollout_epoch`
- `producer_revision`
- `producer_config_hash`
- `consumer_ack_required`

Torghut then maps required dependency capabilities to concrete segments. One degraded collaboration segment cannot
silence hypotheses that only require `market_data_context` and `evidence_authority`.

## Validation gates

Engineer-stage acceptance:

1. `dependency_quorum.decision != "allow"` always corresponds to at least one non-healthy segment with populated
   `reasons[]`.
2. `/ready`, `/api/agents/control-plane/status`, and `Swarm.status` agree on the active admission class for the same
   namespace and rollout epoch.
3. A stale or missing `consumer_acknowledgement` forces `delay` or `block`.
4. Huly timeout produces `collaboration_huly.status="degraded"` and an outbox row, not an untyped fatal exception.
5. Torghut rejects stale `allow` payloads when `expires_at` is in the past or required segment detail is missing.

Suggested regression coverage:

- `services/jangar/src/server/__tests__/control-plane-status.test.ts`
- `services/jangar/src/routes/ready.test.ts`
- `services/jangar/scripts/codex/__tests__/codex-implement.test.ts`
- `services/torghut/tests/test_hypotheses.py`

Deployer-stage acceptance:

1. one consumer can be held back while unrelated segments remain healthy and visible;
2. rollout dashboards show epoch id, producer config hash, consumer ack state, and collaboration outbox lag;
3. a synthetic Huly timeout leaves mission delivery replayable after recovery;
4. a synthetic Torghut config drift forces admission `delay` or `block` until the consumer acknowledges the new hash.

## Rollout plan

1. Land schema and contract changes for the provenance ledger and consumer acknowledgements behind read-only shadow
   writes.
2. Teach `control-plane-status` to emit segment reasons, freshness, and epoch data from the ledger while preserving the
   current payload shape.
3. Update `/ready` and `Swarm.status` derivation to use the same provenance snapshot.
4. Extend Torghut dependency fetch/parsing to consume segments, freshness, and rollout epoch details.
5. Enable fail-closed enforcement for profit-affecting consumers first, then for mission-delivery and deployment
   consumers.

## Rollback plan

- revert admission derivation to the previous `dependency_quorum` path;
- disable consumer-ack enforcement with one feature flag while leaving ledger writes intact for analysis;
- keep collaboration outbox writes enabled even if replay gating is disabled, because the outbox is diagnostic value on
  its own;
- roll back only if the new provenance contract causes false global blocks or materially delays non-dependent stages.

## Risks and tradeoffs

- consumer acknowledgement adds complexity and requires careful freshness defaults;
- fail-closed freshness can initially reduce automation until all consumers publish acknowledgements correctly;
- collaboration outbox retention must be bounded so one Huly outage does not produce unbounded backlog;
- segment taxonomy must remain small and stable or operators will lose the clarity this design is trying to create.

## Engineer and deployer handoff

Engineer contract:

- implement the provenance schema and status payload before changing rollout policy;
- add regression coverage for segment reasons, stale acknowledgement, and Huly replay;
- treat lossy or missing segment detail as a contract failure, not a best-effort parse.

Deployer contract:

- canary only after dashboards show matching producer/consumer hashes and fresh acknowledgements;
- block promotion if `collaboration_huly` or `rollout_consumer_ack` is blocked for required stages;
- use the outbox replay path before manually re-running missions after Huly recovery.
