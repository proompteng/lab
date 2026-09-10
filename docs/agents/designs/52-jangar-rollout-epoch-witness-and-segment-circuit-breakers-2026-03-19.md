# 52. Jangar Rollout Epoch Witness and Segment Circuit Breakers (2026-03-19)

Status: Ready for merge (discover architecture lane)
Date: `2026-03-19`
Owner: Gideon Park (Torghut Traders Architecture)
Related mission: `codex/swarm-torghut-quant-discover`
Swarm impacts:

- `jangar-control-plane`
- `torghut-quant`

Extends:

- `49-jangar-control-plane-authority-ledger-and-expiry-watchdog-2026-03-19.md`
- `50-torghut-hypothesis-capital-governor-and-data-quorum-2026-03-19.md`

## Executive summary

The March 19 live state shows that Jangar has improved raw control-plane health, but rollout truth is still too
optimistic and too producer-centric:

- `GET /api/agents/control-plane/status?namespace=agents` reports `dependency_quorum.decision = allow`,
  `rollout_health.status = healthy`, and `database.status = healthy`;
- the same payload also shows `watch_reliability.total_restarts = 5` in the last 15 minutes and
  `leader_election.lease_namespace = default`;
- Torghut reports `critical_toggle_parity.status = diverged` because
  `TRADING_AUTONOMY_ALLOW_LIVE_PROMOTION` is effectively `true` while the shadow-first contract expects `false`;
- required Huly worker verification timed out while calling
  `GET /api/v1/account/c9b87368-e7a2-483f-885f-ff179e258950` on
  `http://transactor.huly.svc.cluster.local`, which means a collaboration dependency can fail before the stage can
  publish its artifacts.

The architecture change in this document is to move from "Jangar says the control plane looks healthy" to a
**Rollout Epoch Witness** that only becomes authoritative after consumers acknowledge the expected revision and config
contract. Failures are then handled by **segment circuit breakers** so collaboration, watch churn, or one consumer's
config drift cannot silently advance rollout or freeze unrelated runtime segments.

## Mission inputs and success criteria

Observed mission inputs:

- repository: `proompteng/lab`
- base: `main`
- head: `codex/swarm-torghut-quant-discover`
- swarmName: `torghut-quant`
- swarmStage: `discover`
- ownerChannel: `swarm://owner/trading`

Success for this architecture artifact is:

1. current cluster, source, database, and collaboration failure evidence captured with concrete read-only proof;
2. alternatives considered and one chosen with explicit tradeoffs;
3. engineer and deployer stages receive a single rollout-truth contract rather than multiple partially trusted
   endpoints;
4. rollout and rollback behavior become testable in terms of revision acknowledgement, segment health, and expiry.

## Assessment snapshot

### Cluster health, rollout, and collaboration evidence

Read-only evidence captured on `2026-03-19`:

- `curl -fsS 'http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status?namespace=agents' | jq '{generated_at,leader_election,watch_reliability,rollout_health,dependency_quorum,database}'`
  - `rollout_health.status = "healthy"`
  - `dependency_quorum.decision = "allow"`
  - `database.status = "healthy"`
  - `watch_reliability.total_restarts = 5` across five watched streams in the last `15` minutes
  - `leader_election.lease_namespace = "default"`
- `curl -fsS http://torghut.torghut.svc.cluster.local/trading/status | jq '{shadow_first,live_submission_gate,control_plane_contract}'`
  - `shadow_first.capital_stage = "shadow"`
  - `live_submission_gate.allowed = true`
  - `live_submission_gate.capital_stage = "0.10x canary"`
  - `control_plane_contract.critical_toggle_parity.status = "diverged"`
- `python3 skills/huly-api/scripts/huly-api.py --operation account-info ...`
  - timed out while calling `GET /api/v1/account/c9b87368-e7a2-483f-885f-ff179e258950`
- `python3 skills/huly-api/scripts/huly-api.py --operation list-channel-messages ...`
  - timed out on the same account lookup path before any channel read could happen
- `python3 skills/huly-api/scripts/huly-api.py --operation account-info --base-url https://huly.proompteng.ai ...`
  - returned Cloudflare `403 / Error 1010`, so the public host is not a reliable worker fallback

Interpretation:

- Jangar can currently declare healthy rollout segments without proving that consumers applied the expected config or
  toggle state.
- Collaboration is operationally mandatory but architecturally invisible; today it fails as an opaque precondition,
  not as a tracked dependency segment.
- Watch restarts are observable, but they do not create an epoch boundary that forces re-acknowledgement from
  dependent runtimes.

### Source architecture and high-risk modules

Relevant implementation surfaces on the current branch:

- `services/jangar/src/server/control-plane-status.ts`
  - `DEFAULT_EXECUTION_TRUST_ENABLED = false`
  - rollout, watch, leader-election, and database health are reported, but consumer acknowledgement is not a required
    predicate for `dependency_quorum = allow`
- `services/jangar/scripts/codex/codex-implement.ts`
  - cross-swarm Huly initialization calls `listChannelMessages(...)` and `verifyChatAccess(...)` before continuing
  - failures are rethrown, so collaboration transport problems can fail the stage before owner updates or mission
    artifact repair
- `services/torghut/app/main.py`
  - `_build_shadow_first_toggle_parity()` exposes config drift
  - `_build_live_submission_gate_payload(...)` can still set `capital_stage = "0.10x canary"` when allowed and the
    active capital stage is only `shadow`
- `services/jangar/src/server/torghut-quant-runtime.ts`
  - quant control-plane state is still stored in `globalThis` and refreshed by per-process `setInterval(...)` loops
  - that is workable for one replica, but it is not yet an acknowledged multi-writer contract
- existing docs already define an authority ledger and capital governor, but neither document introduces
  a required **consumer-side acknowledgement** that the live runtime accepted the exact rollout epoch Jangar intended.

Current missing tests:

- no regression proving `dependency_quorum = allow` is impossible when a dependent consumer reports config-hash drift;
- no regression proving watch restarts force a new rollout epoch rather than remaining informational noise;
- no regression proving Huly collaboration timeouts become a segment-local hold instead of aborting the whole mission
  path;
- no regression proving the Jangar quant runtime behaves idempotently once more than one web process emits control-plane
  metrics;
- no deployer drill proving one unhealthy consumer blocks only its own promotion lane rather than the entire control
  plane.

### Database and data continuity evidence

The Jangar database itself is healthy:

- `database.connected = true`
- `database.migration_consistency.applied_count = 24`
- `database.migration_consistency.unapplied_count = 0`

The problem is not storage health. The problem is missing **cross-system truth continuity**:

- Jangar can persist a healthy control-plane view;
- Torghut can simultaneously report config drift and contradictory capital semantics;
- the system has no durable row that says "epoch X was published, consumer Y acknowledged config hash Z, and segment
  Q was still degraded at T".

## Problem statement

The current control-plane topology still has four dangerous blind spots:

1. rollout truth is based on producer health and inferred consumer behavior, not explicit consumer acknowledgement;
2. collaboration/auth transport failures are hard blockers in practice but are not modeled as first-class segment
   failures;
3. watch churn has no durable epoch boundary, so healthy-looking summaries can outlive the evidence that justified
   them;
4. deployer stages cannot answer "which revision, config hash, and dependency segments were actually acknowledged by
   Torghut when Jangar allowed promotion?"

That means safer rollout behavior still depends on reading several endpoints and making human inferences. The next
architecture step must make acknowledgement and expiry explicit.

## Alternatives considered

### Option A: keep the current authority-ledger and tune thresholds

Pros:

- smallest implementation delta
- reuses the March 19 ledger work

Cons:

- still no consumer acknowledgement contract
- still no clean way to represent Huly transport failure as a segment-local hold
- watch restarts remain a warning, not a rollout epoch boundary

### Option B: add Torghut acknowledgement only

Pros:

- directly addresses config drift between Jangar and Torghut
- limited scope

Cons:

- does not solve collaboration failures
- does not generalize to other dependent runtimes or future consumers
- still lacks a common circuit-breaker contract for rollout, evidence, and external services

### Option C: Rollout Epoch Witness plus Segment Circuit Breakers

Pros:

- makes rollout truth depend on both producer health and consumer acknowledgement
- allows collaboration, watch, or evidence failures to degrade the right segment without silently advancing rollout
- produces durable evidence for rollout, rollback, and incident replay

Cons:

- broader schema and controller changes
- requires explicit expiry semantics and acknowledgement plumbing in dependent runtimes

## Decision

Adopt **Option C**.

The March 19 evidence shows that the current architecture is close to healthy but still lacks the one property needed
for safer rollout: a single durable record that ties `published intent` to `consumer acknowledgement` and
`segment health`. Threshold tuning alone does not close that gap.

## Proposed architecture

### 1. Rollout Epoch Witness

Introduce a durable `control_plane_rollout_epochs` record keyed by `{service, revision, rollout_epoch_id}` with:

- `published_revision`
- `expected_config_hash`
- `expected_toggle_hash`
- `authority_decision_id`
- `required_segments`
- `published_at`
- `expires_at`
- `rollback_epoch_id`
- `evidence_bundle_ref`

Jangar becomes the publisher of the epoch. A rollout is not authoritative until the intended consumers acknowledge it.

### 2. Consumer acknowledgement rows

Introduce `control_plane_epoch_acknowledgements` keyed by `{rollout_epoch_id, consumer}` with:

- `consumer` (`torghut`, `agents-controllers`, `jangar-worker`, future runtimes)
- `observed_revision`
- `effective_config_hash`
- `effective_toggle_hash`
- `ack_state` (`aligned`, `drifted`, `expired`, `missing`)
- `observed_at`
- `expires_at`
- `segment_snapshot`

This closes the current truth gap where Torghut can expose `critical_toggle_parity = diverged` while Jangar still says
dependency quorum is healthy.

### 3. Segment circuit breakers

Model rollout health as explicit segments rather than one summary:

- `control_runtime`
- `consumer_config_parity`
- `watch_stream`
- `database_migration`
- `evidence_authority`
- `simulation_capacity`
- `external_collaboration`

Each segment has `status in {healthy, hold, block, unknown}` plus reason codes and expiry. The important behavior
change is that a failure in `external_collaboration` or one consumer's `consumer_config_parity` can block the affected
lane without falsely rewriting unrelated segment truth.

### 4. Safe rollout semantics

Rollout progression becomes:

1. publish rollout epoch;
2. wait for required acknowledgements;
3. allow `shadow -> canary` only when `control_runtime`, `consumer_config_parity`, `database_migration`, and
   `evidence_authority` are healthy;
4. keep `external_collaboration` mandatory for mission-closeout artifacts, but do not let it erase or overwrite an
   already acknowledged runtime epoch;
5. expire the epoch automatically if acknowledgements are stale or watch-stream churn crosses the epoch threshold.

This is safer than the current model because watch restarts and config drift now force re-acknowledgement instead of
remaining passive warnings.

### 5. Collaboration outbox and replay

When Huly verification or mission upsert fails:

- write a `collaboration_outbox` row with the intended issue, document, and channel payloads;
- mark `external_collaboration = hold`;
- preserve the rollout epoch and all runtime acknowledgements;
- replay the outbox when the collaborator path is healthy again.

The mission still fails its collaboration acceptance gate, but the system no longer loses the runtime truth that
existed at the time of failure.

### 6. Evidence bundle shape

Each epoch references an immutable bundle containing:

- Jangar control-plane status snapshot
- dependent consumer status snapshot
- config and toggle hashes
- collaboration probe result
- warning event digest
- rollout intent and rollback target

Engineer and deployer then share the same proof artifact when diagnosing a blocked or expired epoch.

## Validation gates

Engineer gates:

- add control-plane tests proving a `drifted` or `missing` acknowledgement blocks rollout even when rollout health is
  otherwise healthy;
- add tests proving watch restart churn opens a new epoch and expires the old one;
- add `codex-implement.ts` tests proving Huly timeout writes collaboration outbox state and segment status instead of
  only throwing;
- add Torghut/Jangar contract tests proving the reported config hash and toggle hash match the acknowledged epoch.

Deployer gates:

- one drill where Torghut reports config drift must keep rollout in `hold` and prevent canary;
- one drill where Huly times out must preserve the runtime epoch while failing the artifact-closeout gate;
- one drill where watch-stream churn exceeds policy must expire the old epoch and require fresh acknowledgement;
- no merge to live rollout unless the active epoch has unexpired acknowledgements for every required consumer.

## Rollout plan

1. Add additive tables for rollout epochs, acknowledgements, and collaboration outbox.
2. Emit config/toggle hashes from Torghut and other consumers into status responses.
3. Teach Jangar to publish epochs and read acknowledgements in advisory mode.
4. Switch rollout admission to epoch-backed mode in canary.
5. Move Huly failure handling from fatal precondition to tracked `external_collaboration` segment plus replay outbox.

## Rollback plan

If epoch-backed admission proves too strict:

- keep writing epochs and acknowledgements;
- revert deployment admission to advisory mode;
- preserve collaboration outbox and evidence bundles for replay;
- never delete the epoch rows from an incident window.

## Risks and tradeoffs

- more persistence means more retention and schema management;
- config-hash canonicalization must stay stable across services;
- collaboration outbox replay adds operational moving parts.

Mitigations:

- derive hashes from a versioned manifest serializer;
- version the evidence bundle schema;
- bound outbox retries and publish explicit expiry reasons.

## Engineer and deployer handoff contract

Engineer must deliver:

1. rollout epoch and acknowledgement schemas;
2. consumer-side config and toggle hash publication;
3. segment circuit-breaker evaluation logic;
4. Huly collaboration outbox and replay handling;
5. regression coverage for drift, timeout, expiry, and watch churn.

Deployer must validate:

1. rollout never advances without a fresh acknowledged epoch;
2. config drift blocks only the affected consumer lane;
3. Huly transport failure blocks artifact completion without erasing runtime truth;
4. rollback reuses the same epoch/evidence model instead of ad hoc log reconstruction.
