# 51. Torghut Profit Reservations, Schema Witness, and Simulation Slot Ledger (2026-03-19)

Status: Ready for merge (discover architecture lane)
Date: `2026-03-19`
Owner: Gideon Park (Torghut Traders Architecture)
Related mission: `codex/swarm-torghut-quant-discover`
Companion docs:

- `docs/agents/designs/52-jangar-rollout-epoch-witness-and-segment-circuit-breakers-2026-03-19.md`
- `docs/agents/designs/50-torghut-hypothesis-capital-governor-and-data-quorum-2026-03-19.md`

## Executive summary

The March 19 live runtime exposes a profitability control contradiction that the current architecture does not fully
close:

- `GET /trading/status` reports `live_submission_gate.allowed = true` and upgrades `shadow` to `0.10x canary`;
- the same payload reports `active_capital_stage = "shadow"`,
  `alpha_readiness_promotion_eligible_total = 0`, and
  `critical_toggle_parity.status = "diverged"`;
- runtime logs show `lean_strategy_shadow_evaluations.parity_status` rejecting
  `blocked_missing_empirical_authority` because the column is only `varchar(32)`, which then cascades into
  `PendingRollbackError` and `torghut.runtime.loop_failed`;
- options-lane services are failing before steady state because database auth and image pull are red;
- historical simulation workflows are repeatedly failing on
  `simulation_runtime_lock_held:<run_id>:<dataset_id>` because there is only one namespace-wide runtime lock.

The architecture change in this document is to make non-shadow capital depend on an expiring **Profit Reservation**
that is backed by a **Schema Witness** and a **Simulation Slot Ledger**. A hypothesis may only hold canary/live
capital while its reservation remains fresh, its required subsystem segments are healthy, and its prove loop owns a
compatible simulation slot.

## Assessment snapshot

### Cluster health, rollout, and runtime evidence

Read-only evidence captured on `2026-03-19`:

- `kubectl get pods -n torghut --no-headers | awk '$3!="Running" && $3!="Completed" {print $1, $2, $3, $4, $5}'`
  - `torghut-options-catalog ... CrashLoopBackOff`
  - `torghut-options-enricher ... CrashLoopBackOff`
  - `torghut-options-ta ... ImagePullBackOff`
  - `torghut-dspy-cluster-runner ... Error`
- `kubectl get pods -n argo-workflows | rg 'torghut-historical-simulation'`
  - recent workflow pods remain dominated by `Error`
- `kubectl get events -n torghut --sort-by=.lastTimestamp | tail -n 40`
  - `torghut-00153` had startup, readiness, and liveness failures before stabilizing
  - options pods are still in backoff and image-pull failure loops
- `kubectl logs -n argo-workflows torghut-historical-simulation-2blt5 -c main --tail=120`
  - failed with `simulation_runtime_lock_held:sim-proof-884bec35-march18-refresh-20260319-080910:torghut-full-day-20260318-884bec35`

Interpretation:

- the core Torghut runtime is still available;
- prove, options, and support lanes are not reliable enough to be treated as implicit prerequisites for live capital;
- a single namespace-wide simulation lock is too coarse for repeated empirical workflows.

### Source architecture and test gaps

Relevant current-branch implementation surfaces:

- `services/torghut/app/main.py`
  - `_build_live_submission_gate_payload(...)` sets `allowed = true` when promotion, empirical, DSPy, and dependency
    checks pass, then upgrades `shadow` to `0.10x canary`
  - `_build_shadow_first_toggle_parity()` correctly exposes config drift, but that drift does not currently force a
    stricter gate than `allowed = true`
- `services/torghut/app/trading/hypotheses.py`
  - `compile_hypothesis_runtime_statuses(...)` evaluates every manifest against one shared TCA summary
  - `max_rolling_drawdown_bps` exists in the manifest, but the promotion path does not currently enforce it
- `services/torghut/app/models/entities.py`
  - `lean_strategy_shadow_evaluations.parity_status` is `String(length=32)`
- `services/torghut/app/db.py` and `services/torghut/app/main.py`
  - startup still calls `metadata.create_all()` / `Base.metadata.create_all()`
  - that can create ORM-declared tables outside Alembic and weaken drift detection for migration-only objects
- `services/torghut/migrations/versions/0012_lean_multilane_foundation.py`
  - creates the same `String(length=32)` column in the database
- `services/torghut/app/lean_runner.py`
  - emits `blocked_missing_empirical_authority`, which is longer than the current schema
- `services/torghut/app/options_lane/catalog_service.py` and `services/torghut/app/options_lane/enricher_service.py`
  - construct `OptionsRepository(...)` and call `ensure_rate_bucket_defaults(...)` at module import time
  - this makes DB auth drift a boot-time crash rather than a surfaced readiness segment
- `services/torghut/scripts/start_historical_simulation.py`
  - uses a single namespace-wide `ConfigMap/torghut-historical-simulation-lock`
  - when a different run owns it, the workflow fails with `simulation_runtime_lock_held`

Current missing tests:

- no regression proving `critical_toggle_parity = diverged` forces capital to stay `observe` or `shadow`;
- no regression proving TCA profitability inputs remain isolated per hypothesis or strategy family;
- no regression proving `max_rolling_drawdown_bps` changes readiness or capital state;
- no regression proving schema-write incompatibility blocks canary/live reservations;
- no regression proving options bootstrap red status leaves unrelated hypotheses free to collect evidence while
  keeping options-dependent hypotheses in `observe`;
- no regression proving multiple empirical workflows can queue by dataset/hypothesis without clobbering one another.

### Database and data quality evidence

Read-only evidence captured on `2026-03-19`:

- `curl -fsS http://torghut.torghut.svc.cluster.local/db-check`
  - `schema_current = true`
  - current head is `0024_simulation_runtime_context`
  - lineage warnings remain because parent forks are present
- `curl -fsS http://torghut.torghut.svc.cluster.local/trading/status | jq '{shadow_first,live_submission_gate,market_context,metrics,control_plane_contract}'`
  - `shadow_first.capital_stage = "shadow"`
  - `live_submission_gate.allowed = true`
  - `market_context.alert_active = true`
  - fundamentals and news are stale
  - `metrics.orders_submitted_total = 0`
  - `metrics.orders_rejected_total = 23`
  - `metrics.domain_telemetry_event_total["torghut.runtime.loop_failed"] = 18`
  - `metrics.lean_strategy_shadow_total = {"blocked_missing_empirical_authority":16,"error":16}`
- `kubectl logs -n torghut torghut-00153-deployment-... -c user-container --tail=120`
  - repeated `StringDataRightTruncation` on `lean_strategy_shadow_evaluations.parity_status`
  - followed by `PendingRollbackError`, which contaminates later runtime work in the same session
- `kubectl logs -n torghut torghut-options-catalog-... --tail=120`
  - `password authentication failed for user "torghut_app"`
- `kubectl logs -n torghut torghut-options-enricher-... --tail=120`
  - same DB auth failure

Interpretation:

- `schema_current = true` is not sufficient for capital safety;
- ORM startup DDL can mask migration drift, so the witness has to reason about write compatibility and ownership, not
  only current Alembic heads;
- the live runtime needs a notion of **schema fitness for the writes it will actually attempt**;
- options readiness and simulation capacity must become explicit reservation dependencies rather than incidental pod
  symptoms.

## Problem statement

The current Torghut architecture still lets several dangerous contradictions coexist:

1. status and scheduler can imply live-capital readiness even when the active hypothesis state is only `shadow`;
2. profitability inputs are still partially shared across hypotheses, which lets one lane's TCA window influence
   unrelated promotion decisions;
3. schema drift is treated as binary `current/not current`, which misses write-compatibility failures such as the
   `parity_status` width mismatch;
4. prove workflows contend on one coarse lock, turning empirical automation into a source of recurring failures;
5. options-lane boot failures are visible only as pod crashes, not as a typed dependency segment that the capital path
   can consume.

Minor bug fixes would help, but they would not create a durable capital contract. The system needs a capital object
that expires, carries evidence, and can be withdrawn when its dependencies degrade.

## Alternatives considered

### Option A: patch each failure individually

Pros:

- quickest path to partial improvement
- addresses today's concrete bugs

Cons:

- still no authoritative capital object
- still no shared status/scheduler/runtime contract
- simulation prove loops would remain globally serialized in a fragile way

### Option B: enforce a stricter global gate

Pros:

- simple to explain
- safer than today's optimistic gate

Cons:

- too coarse
- turns options or prove-lane failures into whole-portfolio freezes
- does not isolate hypotheses by required subsystems

### Option C: Profit Reservations + Schema Witness + Simulation Slot Ledger

Pros:

- makes capital explicit, expiring, and auditable
- isolates failures to the hypotheses and lanes that depend on the broken subsystem
- turns simulation contention into a schedulable resource instead of a namespace-wide collision

Cons:

- larger schema and contract surface
- requires shared status/scheduler/runtime adoption

## Decision

Adopt **Option C**.

The runtime evidence is already telling us what the architecture is missing: capital cannot be a derived side effect of
several summaries. It needs to be a first-class reservation object that is granted, renewed, or revoked based on
measurable evidence and subsystem health.

## Proposed architecture

### 1. Profit Reservation ledger

Introduce `profit_reservations` keyed by `{hypothesis_id, candidate_id, account, reservation_window}` with:

- `reservation_id`
- `capital_state_requested`
- `capital_state_granted`
- `rollout_epoch_id`
- `schema_witness_id`
- `simulation_slot_id`
- `required_segments`
- `blocked_reasons`
- `evidence_bundle_refs`
- `granted_at`
- `expires_at`

Use standardized granted states:

- `observe`
- `canary_0_10x`
- `canary_0_25x`
- `live`
- `scale`
- `quarantine`

Non-shadow order submission requires an unexpired reservation in one of the non-observe states.

### 2. Schema Witness

Introduce a `schema_witnesses` record that extends `/db-check` with write-contract compatibility:

- `schema_head_signature`
- `schema_graph_signature`
- `lineage_warning_count`
- `write_contract_version`
- `write_contract_hash`
- `compatibility_state`
- `failing_tables`
- `failing_columns`
- `observed_at`
- `expires_at`

Examples of witness failures:

- `lean_strategy_shadow_evaluations.parity_status` cannot hold the longest emitted status string
- startup-created ORM tables drift from Alembic ownership or omit migration-only structures
- required options tables or grants are missing
- runtime writes are failing even though migration heads are current

Capital reservations must treat `compatibility_state != healthy` as a blocking reason.

### 3. Segment-scoped reservation dependencies

Each hypothesis declares its required segments, for example:

- `market_context`
- `ta_core`
- `options_data`
- `lean_shadow`
- `empirical_jobs`
- `simulation_capacity`
- `consumer_config_parity`

This preserves blast-radius isolation:

- an options-lane outage blocks only options-dependent reservations;
- a schema witness failure in `lean_shadow` blocks hypotheses that depend on shadow parity proof;
- a consumer config drift from the rollout epoch blocks any reservation that requires aligned capital policy.

### 4. Simulation Slot Ledger

Replace the single namespace-wide ConfigMap lock with `simulation_slots` keyed by:

- `dataset_snapshot_ref`
- `hypothesis_family`
- `account`
- `window`

Each slot carries:

- `slot_id`
- `owner_run_id`
- `slot_state` (`queued`, `leased`, `expired`, `released`)
- `leased_at`
- `lease_expires_at`
- `replayable`
- `artifact_root`

Multiple prove workflows can then queue safely when they target different datasets or hypothesis families, while exact
conflicts become explicit leased slots rather than hard failures.

### 5. Shared decision function

`/trading/status`, scheduler submission, and execution adapters must all consume the same reservation decision:

- if `critical_toggle_parity = diverged`, reservations fall back to `observe`;
- if `promotion_eligible_total <= 0`, reservations cannot exceed `observe`;
- if `market_context` or other required segments are stale, reservations expire or remain blocked;
- if the schema witness or slot lease is invalid, live-capital submission is denied even when the old gate would have
  said `allowed = true`.

This removes the current contradiction where status can expose drift while the live gate still claims readiness.

### 6. Guardrails for measurable trading hypotheses

Every hypothesis must define reservation guardrails in two windows:

- freshness window
  - required segments fresh
  - schema witness healthy
  - simulation slot either not required or currently leased
  - no critical runtime-loop failure burst
- performance window
  - minimum sample count
  - minimum post-cost expectancy
  - maximum slippage
  - maximum rejection ratio
  - no repeated rollback condition

Reservation renewal requires both windows to pass. Expiry or repeated failure forces `observe` or `quarantine`.

### 7. Options subsystem contract

Options-capable hypotheses cannot leave `observe` until:

- image availability is proven for the options TA worker;
- DB auth succeeds for catalog and enricher services;
- rate-bucket bootstrap completed after service start, not only at import time;
- readiness publishes an explicit `options_bootstrap` state with heartbeat freshness.

This converts today's crash loops into typed reservation reasons such as:

- `options_db_auth_invalid`
- `options_image_unavailable`
- `options_bootstrap_incomplete`
- `options_schema_incompatible`

## Validation gates

Engineer gates:

- add status/scheduler parity tests proving `critical_toggle_parity = diverged` cannot coexist with a non-observe
  reservation;
- add schema witness tests covering the `parity_status` width mismatch and other write-contract failures;
- add options readiness tests proving DB auth drift becomes a typed segment failure rather than only a boot crash;
- add simulation slot tests proving conflicting runs queue or lease cleanly instead of failing with a shared lock
  collision.

Deployer gates:

- no hypothesis receives `canary_0_10x` or above without a fresh reservation and schema witness;
- induce a schema-write failure and confirm reservations downgrade to `observe` or `quarantine`;
- induce an options bootstrap failure and confirm only options-dependent hypotheses are blocked;
- run concurrent empirical workflows and confirm slot leasing is deterministic and observable.

## Rollout plan

1. Add additive tables for profit reservations, schema witnesses, and simulation slots.
2. Emit reservation and witness payloads alongside existing status responses.
3. Switch scheduler admission to reservation-backed mode in advisory shadow.
4. Move options bootstrap and schema-fitness checks into typed readiness segments.
5. Replace the namespace-wide simulation lock with slot leasing and expiry.

## Rollback plan

If reservation-backed admission is too strict:

- keep writing reservations, schema witnesses, and slot rows;
- demote consumption back to advisory mode;
- preserve the evidence rows for replay and tuning;
- do not reintroduce the namespace-wide simulation lock once slot state exists.

## Risks and tradeoffs

- more stateful control objects increase schema and retention cost;
- reservation expiry tuning can be noisy if freshness windows are too tight;
- slot scheduling adds queueing behavior that must be visible to operators.

Mitigations:

- version the witness and reservation schemas;
- keep expiry defaults conservative and tune from observed windows;
- export slot, witness, and reservation metrics directly in `/trading/status`.

## Engineer and deployer handoff contract

Engineer must deliver:

1. reservation, witness, and slot data models;
2. one shared reservation decision function for status and scheduler;
3. schema-fitness probes for live runtime writes;
4. options bootstrap publication as readiness state;
5. regression coverage for drift, schema mismatch, slot contention, and segment-local demotion.

Deployer must validate:

1. non-observe capital never exists without a fresh reservation;
2. schema incompatibility downgrades capital before runtime loops fail repeatedly;
3. options failures remain hypothesis-local;
4. empirical workflows can run concurrently through slot leasing without recreating the current lock backlog.
