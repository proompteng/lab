# 61. Jangar Runtime Kits and Admission Passports Contract (2026-03-20)

Status: Approved for implementation (`plan`)
Date: `2026-03-20`
Owner: Victor Chen (Jangar Engineering)
Mission: `codex/swarm-jangar-control-plane-plan`
Swarm impacts:

- `jangar-control-plane`
- `torghut-quant`

Companion doc:

- `docs/torghut/design-system/v6/60-torghut-hypothesis-passports-and-capability-quote-auction-contract-2026-03-20.md`

Extends:

- `60-jangar-recovery-ledger-and-consumer-attestation-contract-2026-03-20.md`
- `59-jangar-authority-session-bus-and-rollout-lease-contract-2026-03-20.md`
- `58-jangar-authority-journals-bounded-recovery-cells-and-replay-contract-2026-03-20.md`
- `57-jangar-authority-capsules-and-readiness-class-separation-2026-03-20.md`

## Executive summary

The decision is to add durable **Runtime Kits** and consumer-scoped **Admission Passports** on top of the current
authority-session stack. Jangar already models stale freeze debt and rollout truth well enough to describe the system,
but it still does not model whether a given runtime can actually execute the work it was admitted to do.

The reason is visible in the live system on `2026-03-20`:

- `kubectl get swarms.swarm.proompteng.ai -n agents -o wide`
  - still shows `jangar-control-plane` `Frozen` `Ready=False`
  - still shows `torghut-quant` `Frozen` `Ready=False`
- `kubectl get swarm jangar-control-plane -n agents -o yaml`
  - still shows `status.freeze.until="2026-03-11T16:36:12.630Z"`
  - still shows `status.updatedAt="2026-03-11T15:48:11.742Z"`
  - still shows `requirements.pending=5`
- `GET http://jangar.jangar.svc.cluster.local/ready`
  - returns HTTP `200`
  - reports `execution_trust.status="degraded"`
  - still lists both stale freeze reconciliation debt and pending requirements
- `GET http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status?namespace=agents&window=15m`
  - reports `database.status="healthy"`
  - reports `rollout_health.status="healthy"`
  - reports `watch_reliability.status="healthy"`
  - still reports `dependency_quorum.decision="block"`
  - still reports `execution_trust.blocking_windows` for unreconciled freeze debt
- `kubectl logs -n agents job/jangar-control-plane-torghut-quant-req-00gbjlqs-1-rpx2-c4597240`
  - fails with `python3: can't open file '/app/skills/huly-api/scripts/huly-api.py': [Errno 2] No such file or directory`
- `services/jangar/scripts/codex/lib/huly-api-client.ts`
  - resolves the Huly helper from a runtime filesystem path
- `services/jangar/scripts/codex/codex-implement.ts`
  - treats Huly initialization as a blocking mission prerequisite for cross-swarm handoff

The tradeoff is more persistence, one more compiler loop, and stricter admission semantics. I am keeping that trade
because the costlier failure mode for the next six months is not stale status anymore. It is healthy-enough pods and
healthy-enough rollout reporting that still launch work against incomplete runtimes.

## Mission inputs and success criteria

Observed mission inputs:

- repository: `proompteng/lab`
- base: `main`
- head: `codex/swarm-jangar-control-plane-plan`
- swarmName: `jangar-control-plane`
- swarmStage: `plan`
- objective: assess cluster/source/database state and merge architecture artifacts that improve Jangar resilience and
  Torghut profitability

This artifact succeeds when:

1. Jangar publishes one runtime-admissibility contract that includes both authority truth and execution-surface truth.
2. a missing runtime dependency such as `/app/skills/huly-api/scripts/huly-api.py` is represented as first-class
   control-plane debt instead of only a job crash.
3. `/ready`, `/api/agents/control-plane/status`, deploy verification, and stage launchers cite the same
   `admission_passport_id` and `runtime_kit_digest` set.
4. stale freeze debt blocks only the consumers that still require it, while unrelated serving classes can remain
   healthy.
5. engineer and deployer stages have explicit validation, rollout, and rollback gates that can be executed without
   inferring missing runtime state from pod logs.

## Assessment snapshot

### Cluster health, rollout, and event evidence

The live cluster says Jangar is now serving, but it is not yet proving that every admitted workload is executable.

- serving path:
  - Jangar `/ready` is back to HTTP `200`.
  - Jangar control-plane status reports rollout health and database health as `healthy`.
- authority debt:
  - both swarms remain frozen on March 11 expiry timestamps.
  - Jangar continues to expose stale-freeze and pending-requirement debt through execution trust.
- execution debt:
  - fresh requirement-driven jobs are still failing with `BackoffLimitExceeded`.
  - sampled job logs show a missing Huly helper file inside the runtime image or workspace.

Interpretation:

- the current March 20 architecture stack solved a large part of the authority-shaping problem;
- it did not yet solve runtime executability as a first-class control-plane subject;
- rollout can therefore look healthy while stage execution is still non-admissible.

### Source architecture and high-risk modules

The code paths match the live contradiction.

- `services/jangar/scripts/codex/lib/huly-api-client.ts`
  - resolves the Huly helper from `../../../../../skills/huly-api/scripts/huly-api.py`;
  - that path is correct in the repository checkout but still becomes a runtime correctness dependency;
  - the control plane has no durable record of whether the required helper actually exists in the admitted runtime.
- `services/jangar/scripts/codex/codex-implement.ts`
  - resolves the active Huly channel and performs `listChannelMessages(...)` plus `verifyChatAccess(...)` before the
    rest of the mission flow;
  - a missing helper therefore becomes a pre-execution hard stop rather than a typed control-plane condition.
- `services/jangar/src/routes/ready.tsx`
  - merges namespace execution trust dynamically;
  - it still answers only readiness, not whether specific execution classes are admissible.
- `services/jangar/src/server/control-plane-status.ts`
  - already computes rollout health, database health, watch reliability, dependency quorum, and execution-trust
    windows;
  - it does not yet model runtime kits, runtime component availability, or consumer-scoped admission objects.

Current missing tests are architectural:

- no regression proves that a missing mission runtime artifact becomes a typed degraded or blocked admission class
  before job launch;
- no regression proves `/ready`, status, and deploy verification share one passport digest;
- no regression proves serving remains healthy while collaboration-specific or planner-specific execution classes are
  blocked;
- no regression proves a repaired runtime kit clears the same passport without manual freeze surgery.

### Database, schema, freshness, and consistency evidence

The database is healthy enough to hold additive runtime-admission state.

- Jangar status reports:
  - `database.connected=true`
  - `database.latency_ms=3`
  - `migration_consistency.applied_count=24`
  - latest registered and applied migration `20260312_torghut_simulation_control_plane_v2`
- direct SQL remains intentionally constrained:
  - `kubectl cnpg psql -n jangar jangar-db -- ...`
  - fails with `pods/exec is forbidden`

Interpretation:

- this is not a migration-drift problem;
- it is an additive-persistence problem on top of a healthy control-plane database;
- the correct move is to persist runtime-admission truth, not to widen live database access.

## Problem statement

Jangar still has five resilience-critical gaps:

1. authority truth and runtime executability are still separate concerns, even though launch safety depends on both;
2. a job can fail because a required helper, binary, secret mount, or workspace path is missing without that debt
   becoming a first-class control-plane object;
3. `/ready` can be healthy while stage launchers still admit workloads into broken runtimes, or vice versa;
4. stale freeze debt and missing runtime artifacts are both currently flattened into generic degraded or blocked
   reducers;
5. deploy verification cannot yet prove that the rollout it is blessing also contains the runtime kit digests required
   by plan, implement, verify, and Torghut consumers.

That is not acceptable for the next six months of autonomous execution. The control plane needs to know not only
whether a decision is authoritative, but whether the runtime that will execute that decision is actually complete.

## Alternatives considered

### Option A: patch the missing path and add more smoke tests

Summary:

- fix the Huly helper path in the runtime;
- add a targeted smoke job and leave the broader architecture unchanged.

Pros:

- fastest local fix;
- minimal schema change;
- directly addresses the observed March 20 error.

Cons:

- still treats runtime completeness as a bug class, not a first-class contract;
- the next missing file, secret mount, or binary will fail the same way;
- does not align readiness, deploy verification, and stage launchers.

Decision: rejected.

### Option B: extend authority sessions with more runtime reason codes

Summary:

- keep the current authority-session and recovery-ledger shape;
- add runtime artifact failures as more reason codes on the same compiled objects.

Pros:

- smaller delta than a new runtime layer;
- reuses existing session and attestation work.

Cons:

- still leaves no durable representation of the runtime surface itself;
- forces launch-critical execution details into a broad status reducer;
- keeps consumer-specific admissibility too implicit.

Decision: rejected.

### Option C: runtime kits plus consumer-scoped admission passports

Summary:

- Jangar compiles durable runtime-kit records for each execution class;
- a passport compiler joins runtime kits, authority sessions, and recovery cases into consumer-scoped admission
  passports;
- every launcher, route, and deploy verifier binds to those passports instead of only broad reducers.

Pros:

- makes runtime completeness a first-class control-plane subject;
- reduces blast radius because missing collaboration assets do not have to block serving or unrelated execution
  classes;
- gives deployers one digest set to verify before promotion;
- increases future option value for new stage types, workers, and downstream consumers.

Cons:

- adds new tables and compiler work;
- requires shadow-mode rollout because current routes and launchers dual-read during migration;
- raises the bar for tests around digest parity and launch refusal semantics.

Decision: selected.

## Decision

Adopt **Option C**.

Jangar will compile runtime kits and consumer-scoped admission passports. Authority remains necessary, but authority is
not enough. A consumer is admissible only when the required authority session, recovery state, and runtime kit set are
all current and explicit.

## Architecture

### 1. Runtime-kit catalog

Add additive Jangar persistence:

- `control_plane_runtime_kits`
  - `runtime_kit_id`
  - `kit_class` (`serving`, `collaboration`, `plan_worker`, `implement_worker`, `verify_worker`, `torghut_quant`)
  - `subject_ref`
  - `image_ref`
  - `workspace_contract_version`
  - `component_digest`
  - `decision` (`healthy`, `degraded`, `blocked`, `unknown`)
  - `observed_at`
  - `fresh_until`
  - `producer_revision`
- `control_plane_runtime_kit_components`
  - `runtime_kit_id`
  - `component_kind` (`python_helper`, `binary`, `workspace_path`, `secret_mount`, `config_file`, `service_url`)
  - `component_ref`
  - `required`
  - `present`
  - `digest`
  - `reason_code`
  - `evidence_ref`
- `control_plane_runtime_kit_events`
  - append-only rows for `observed`, `missing`, `repaired`, `expired`, and `superseded`

Rules:

- a runtime kit is the smallest unit that may be admitted for an execution class;
- missing required components are not only log lines; they are typed kit debt;
- kit freshness must be explicit because image, workspace, and secret state can drift independently.

### 2. Admission-passport compiler

Add additive Jangar persistence:

- `control_plane_admission_passports`
  - `admission_passport_id`
  - `consumer_class` (`serving`, `deploy_verify`, `swarm_plan`, `swarm_implement`, `swarm_verify`, `torghut_probe`,
    `torghut_live`)
  - `authority_session_id`
  - `recovery_case_set_digest`
  - `runtime_kit_set_digest`
  - `decision` (`allow`, `degrade`, `hold`, `block`)
  - `reason_codes_json`
  - `required_subjects_json`
  - `required_runtime_kits_json`
  - `issued_at`
  - `fresh_until`
  - `producer_revision`
- `control_plane_admission_passport_subjects`
  - `admission_passport_id`
  - `subject_kind`
  - `subject_ref`
  - `required`
  - `decision`
  - `evidence_ref`

Rules:

- `/ready` must cite the current `serving` passport, not only merged execution trust;
- plan, implement, and verify launchers must cite their stage-specific passport before creating work;
- deploy verification must refuse promotion when the rollout image digest and required runtime-kit digest set do not
  match the admitted passport;
- Torghut typed consumers must cite a passport that includes both authority and runtime subjects.

### 3. Producer model

Runtime kits should be compiled from least-privilege producers, not a new monolith.

- image producer:
  - reports which baked helpers, binaries, and default workspace assets exist in the deployed image;
- workspace producer:
  - reports required repo paths, staged scripts, and writable mount layout for active stage workers;
- dependency producer:
  - reports required service URLs, secrets, and external helper availability;
- compiler:
  - joins those facts with authority-session and recovery-ledger state to issue passports.

This keeps runtime completeness auditable without broadening one service account into a cluster-wide super-reader.

### 4. Immediate implementation scope

Engineer stage should land the smallest credible slice:

1. migrations for runtime-kit and admission-passport tables;
2. a runtime-kit compiler for Huly helper presence, Python binary, workspace path contract, and required launcher
   config;
3. status payload additions:
   - `runtime_kits`
   - `admission_passports`
   - `serving_passport_id`
4. launcher behavior:
   - cross-swarm Huly steps fail as `passport=blocked` with missing-component evidence instead of opaque retries;
5. regression tests across:
   - `services/jangar/scripts/codex/lib/huly-api-client.ts`
   - `services/jangar/scripts/codex/codex-implement.ts`
   - `services/jangar/src/routes/ready.tsx`
   - `services/jangar/src/server/control-plane-status.ts`

### 5. Failure-mode reduction

This design removes four current failure classes:

- missing runtime helper becomes a typed `runtime_kit_component_missing` debt instead of only a pod log;
- serving readiness no longer has to block because a collaboration-only kit is missing;
- deploy verification gains a deterministic check for runtime completeness instead of inferring it from post-rollout
  job outcomes;
- stale freeze and runtime-kit debt can be tracked independently, which reduces accidental global blockage.

## Validation and rollout contract

### Engineer acceptance gates

The engineer stage is complete only when all of these are true:

1. a failing fixture with missing `/app/skills/huly-api/scripts/huly-api.py` produces a blocked `collaboration`
   runtime kit and a blocked `swarm_plan` or requirement passport;
2. `/ready` includes the serving passport id and remains HTTP `200` when only non-serving kits are degraded;
3. status includes the same passport digest set cited by deploy verification;
4. targeted regression coverage proves missing runtime assets are surfaced before or at launch admission, not only
   after job retries.

### Deployer acceptance gates

The deployer stage is complete only when all of these are true:

1. shadow mode compares legacy readiness and status decisions with passport decisions for at least one full rollout
   window;
2. rollout verification confirms the promoted image digest matches the admitted runtime-kit set for `serving`,
   `swarm_plan`, and `swarm_implement`;
3. fresh requirement jobs either run successfully or fail once with a typed passport refusal, not repeated opaque
   backoff;
4. Huly collaboration checks succeed under the admitted collaboration kit on the promoted revision.

## Rollout plan

1. Land migrations and compiler in shadow mode.
2. Publish runtime kits and passports into status without changing launch behavior.
3. Teach `/ready` and deploy verification to cite passports while keeping the legacy reducer visible for parity.
4. Flip launchers to require stage passports.
5. Remove legacy admission paths only after parity is proven and stale-freeze plus runtime-kit debt are independently
   visible in production.

## Rollback plan

Rollback is required if any of these occur after the cutover:

- serving readiness flips from HTTP `200` to `503` only because a non-serving passport regressed;
- passport compiler emits `unknown` for the current serving image digest;
- launchers begin refusing valid work because runtime-kit freshness or digest comparison is unstable;
- deploy verification cannot prove parity between rollout digest and serving or stage passports.

Rollback path:

- keep the new tables;
- disable passport enforcement and revert routes and launchers to legacy reducers;
- preserve runtime-kit observation so evidence is not lost while enforcement is rolled back.

## Risks and open questions

- runtime kits must not become an excuse to centralize too much image or build logic inside Jangar;
- freshness windows must be tuned carefully or runtime-kit expiry will create noisy false negatives;
- some runtime subjects will remain external and probabilistic; those should degrade narrowly, not force portfolio-wide
  blockage;
- the compiler should not trust a repo path alone when the live workload executes from a different image or mount
  layout.
