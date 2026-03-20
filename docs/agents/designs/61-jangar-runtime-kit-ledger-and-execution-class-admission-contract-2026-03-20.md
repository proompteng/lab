# 61. Jangar Runtime Kit Ledger and Execution-Class Admission Contract (2026-03-20)

Status: Approved for implementation (`plan`)
Date: `2026-03-20`
Owner: Victor Chen (Jangar Engineering)
Mission: `codex/swarm-jangar-control-plane-plan`
Swarm impacts:

- `jangar-control-plane`
- `torghut-quant`

Companion doc:

- `docs/torghut/design-system/v6/60-torghut-hypothesis-passports-and-profit-guardrail-admission-contract-2026-03-20.md`

Extends:

- `60-jangar-recovery-ledger-and-consumer-attestation-contract-2026-03-20.md`
- `59-jangar-authority-session-bus-and-rollout-lease-contract-2026-03-20.md`
- `58-jangar-authority-journals-bounded-recovery-cells-and-replay-contract-2026-03-20.md`

## Executive summary

The decision is to make runtime completeness a first-class control-plane object by introducing a durable **Runtime Kit
Ledger** and **Execution-Class Admissions**. Jangar will stop treating missing worker assets, stale freeze debt, and
consumer-specific dependency freshness as one broad degraded answer. Instead it will compile which runtime kit each
execution class needs, prove whether that kit is present, and bind rollout and consumer admission to that proof.

The reason is visible in the live system on `2026-03-20`:

- `GET http://jangar.jangar.svc.cluster.local/ready`
  - returns HTTP `200`
  - reports `execution_trust.status="degraded"`
  - keeps `jangar-control-plane` and `torghut-quant` degraded because freeze expiry from `2026-03-11` remains
    unreconciled
- `GET http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status?namespace=agents&window=15m`
  - returns HTTP `200` at `2026-03-20T22:38:00.727Z`
  - reports `rollout_health.status="healthy"` for `agents` and `agents-controllers`
  - reports `database.status="healthy"` with `24/24` migrations applied
  - still reports `execution_trust.status="degraded"` because stale freeze reconciliation and queued requirements are
    mixed into one reducer
- `kubectl get swarm -n agents jangar-control-plane torghut-quant -o yaml`
  - shows both swarms still carrying `StageStaleness` freeze windows that expired on `2026-03-11`
  - shows `jangar-control-plane.requirements.pending=5`
- `kubectl logs -n agents pod/jangar-control-plane-torghut-quant-req-00gbjlqs-1-rpx2-c45gnd8d --tail=200`
  - fails on `python3: can't open file '/app/skills/huly-api/scripts/huly-api.py'`
  - proves a live implementation-handoff failure caused by missing runtime assets, not by generic rollout health

The tradeoff is more additive persistence and a stricter rollout contract. I am keeping that trade because the system's
next expensive failure mode is not another broad `503`. It is a healthy-enough control plane that still cannot execute
the work its consumers asked it to do.

## Mission inputs and success criteria

Observed mission inputs:

- repository: `proompteng/lab`
- base: `main`
- head: `codex/swarm-jangar-control-plane-plan`
- swarmName: `jangar-control-plane`
- swarmStage: `plan`
- objective: assess cluster, source, and database state and merge architecture artifacts that improve Jangar
  resilience, rollout safety, and Torghut profitability

This artifact succeeds when:

1. every Jangar consumer can cite one `runtime_kit_id` and one `execution_admission_id` instead of relying on image
   health or route-time reduction;
2. missing runtime assets such as the Huly skill path block only the affected execution classes rather than flattening
   all readiness into one answer;
3. `/ready`, `/api/agents/control-plane/status`, requirement runs, and deploy verification all expose which runtime
   class they are trusting;
4. rollout and rollback decisions prove both deployment digest parity and runtime-kit completeness before promotion.

## Assessment snapshot

### Cluster health, rollout, and event evidence

The live cluster says Jangar serving is healthier than Jangar execution.

- `kubectl get pods -n jangar -o wide`
  - shows `jangar-c9bc8497-mkzl9` `2/2 Running`
  - shows `jangar-worker-5864548487-cmrvv` `1/1 Running`
  - shows `jangar-db-1` `1/1 Running`
- `kubectl get pods -n agents -o wide`
  - shows fresh `agents` and `agents-controllers` pods healthy after the latest rollout
  - still shows repeated `Error` pods for `jangar-control-plane-torghut-quant-req-*`
- `kubectl get events -n agents --sort-by=.lastTimestamp | tail -n 40`
  - shows current schedule jobs succeeding and new plan/implement attempts running
  - still shows recent `BackoffLimitExceeded` on requirement and verify jobs

Interpretation:

- rollout health has materially improved;
- stale freeze debt is still present;
- execution failures now include runtime incompleteness that the current control-plane contract cannot isolate.

### Source architecture and high-risk modules

The source tree still keeps runtime completeness implicit.

- `services/jangar/src/server/control-plane-status.ts`
  - compiles rollout health, execution trust, watch reliability, database health, empirical services, swarms, and
    stages in one request-time reducer;
  - does not publish a durable object for runtime completeness or execution-class-specific admission.
- `services/jangar/src/routes/ready.tsx`
  - merges execution trust across namespaces and treats `blocked` and `unknown` as hard fail;
  - has no concept of execution classes such as `serving`, `huly-bridge`, `plan`, `implement`, or `deploy`.
- `services/jangar/src/server/supporting-primitives-controller.ts`
  - still carries process-local `swarmUnfreezeTimers`;
  - remains the source of stale-freeze repair behavior, but not of a durable runtime admission story.
- `services/jangar/scripts/codex/lib/huly-api-client.ts`
  - resolves `skills/huly-api/scripts/huly-api.py` from a relative repo path;
  - has no runtime-kit assertion proving the worker image or checkout actually contains that file.
- `packages/scripts/src/jangar/verify-deployment.ts`
  - validates Argo app health and deployment digests;
  - does not verify runtime-kit completeness or execution admission parity for deploy-time consumers.

The highest-risk missing tests are architectural:

- no regression test proves a packaged AgentRun runtime contains the Huly skill path before Jangar advertises
  cross-swarm collaboration readiness;
- no parity test proves `/ready`, status, and deploy verification cite the same runtime admission;
- no replay test proves stale freeze debt and runtime-kit debt can coexist without globally blocking serving.

### Database, schema, freshness, and consistency evidence

The database surface is healthy, but freshness is uneven in exactly the way the runtime contract needs to expose.

- direct SQL via `jangar-db-rw.jangar.svc.cluster.local`
  - connects successfully as the app user at `2026-03-20T22:40:18.235Z`
  - shows `kysely_migration.applied_count=24`
- `agents_control_plane.resources_current`
  - `145` rows total, `71` active rows
  - `latest_seen_at=2026-03-20T22:40:17.058Z`
- `agents_control_plane.component_heartbeats`
  - `4` rows
  - `latest_observed_at=2026-03-20T22:40:05.896Z`
- `torghut_control_plane.quant_metrics_latest`
  - `504` rows
  - `latest_as_of=2026-03-20T22:40:11.868Z`
- `torghut_market_context_snapshots`
  - only `25` rows
  - `latest_as_of=2026-03-16T19:36:22.853Z`
- `torghut_control_plane.simulation_runs`
  - `58` rows with `40` in `failed` status
  - `latest_updated_at=2026-03-19T10:08:32.162Z`

Operational limits also matter:

- `kubectl auth can-i create pods/exec -n jangar`
  - returns `no`
- `kubectl auth can-i create pods/portforward -n jangar`
  - returns `no`
- `jangar-db-ro.jangar.svc.cluster.local:5432`
  - refused the connection from this runtime

Interpretation:

- Jangar already has durable state and fresh control-plane facts;
- it does not yet model which execution classes need which runtime assets and freshness inputs;
- that gap is now more operationally important than basic database connectivity.

## Problem statement

Jangar still has five resilience-critical gaps:

1. rollout health and execution completeness are currently conflated even though they fail differently;
2. runtime assets such as skills, helper scripts, and tool paths remain implicit in the image or checkout instead of
   being part of the control-plane contract;
3. request-time reducers still globalize stale freeze debt and consumer-specific missing dependencies into one broad
   degraded answer;
4. deploy verification can prove digest parity but cannot prove that the deployed runtime can perform the required
   work;
5. Torghut profitability still depends on Jangar exposing capability truth precisely enough to separate fresh quant
   telemetry from stale market-context and simulation evidence.

That was tolerable when outages were mostly binary. It is not acceptable for the next six months, where the system
must serve safely while isolating execution failures before they become rollout failures.

## Alternatives considered

### Option A: continue the recovery-ledger and consumer-attestation line without runtime kits

Summary:

- keep recovery cases and consumer attestations as the main additive objects;
- repair stale freeze behavior and make current consumers more selective.

Pros:

- smallest delta from the current March 20 plan stack;
- keeps the mental model closer to the existing readiness contract.

Cons:

- still leaves missing runtime assets implicit;
- still cannot explain why a requirement job fails while serving and rollout health remain acceptable;
- keeps deploy verification blind to execution completeness.

Decision: rejected.

### Option B: split images and stage runtimes without new admission objects

Summary:

- isolate `plan`, `implement`, `verify`, and requirement handoff into separate images or workspaces;
- let each stage own its own runtime bundle operationally.

Pros:

- narrows blast radius from missing files;
- operationally simple to explain at first glance.

Cons:

- creates image and rollout sprawl;
- does not provide one durable object that routes, deploy tools, and downstream consumers can share;
- pushes correctness into packaging conventions instead of explicit control-plane truth.

Decision: rejected.

### Option C: runtime kit ledger plus execution-class admissions

Summary:

- Jangar compiles a runtime-kit ledger from image digests, mounted assets, skill refs, and required tool paths;
- each execution class binds to one runtime kit plus one authority session and one recovery view;
- routes, deploy verification, and downstream consumers read admissions instead of guessing from broad health.

Pros:

- directly addresses the live Huly-skill-path failure mode;
- gives rollout safety a stronger bar than digest parity alone;
- preserves future option value because new consumers can bind to classes without redefining the whole readiness model.

Cons:

- adds new additive tables and compiler logic;
- requires runtime probes and shadow mode before enforcement;
- raises the parity-testing bar for serving, deploy, and consumer surfaces.

Decision: selected.

## Decision

Adopt **Option C**.

Jangar will compile runtime kits and execution-class admissions, then bind readiness, requirement handoff, and deploy
verification to those durable objects instead of treating runtime completeness as an implied property of rollout health.

## Architecture

### 1. Runtime kit ledger

Add additive control-plane tables:

- `control_plane_runtime_kits`
  - `runtime_kit_id`
  - `kit_class` (`serving`, `worker`, `huly-bridge`, `deploy-verifier`, `torghut-consumer`)
  - `image_digest`
  - `repo_revision`
  - `workspace_layout_digest`
  - `required_paths_json`
  - `required_skills_json`
  - `required_binaries_json`
  - `required_env_bindings_json`
  - `probed_at`
  - `expires_at`
  - `status` (`allow`, `degrade`, `block`)
  - `reason_codes_json`
  - `evidence_refs_json`
- `control_plane_runtime_kit_observations`
  - `runtime_kit_id`
  - `subject_kind`
  - `subject_ref`
  - `path_or_capability`
  - `observed_state`
  - `reason_code`
  - `observed_at`

Rules:

- runtime completeness is never inferred solely from image digest;
- a missing required path such as `skills/huly-api/scripts/huly-api.py` becomes a first-class observation;
- observations expire quickly enough to catch bad rollouts without turning old transient failures into permanent truth.

### 2. Execution classes

Add additive tables:

- `control_plane_execution_classes`
  - `execution_class_id`
  - `consumer_id`
  - `class_name`
  - `required_runtime_kit_class`
  - `required_consumer_class`
  - `required_recovery_effect`
  - `required_freshness_inputs_json`
  - `serving_policy` (`allow`, `degrade`, `block`)
  - `promotion_policy` (`allow`, `degrade`, `block`)
- `control_plane_execution_admissions`
  - `execution_admission_id`
  - `execution_class_id`
  - `authority_session_id`
  - `consumer_attestation_id`
  - `runtime_kit_id`
  - `decision` (`allow`, `degrade`, `block`)
  - `bounded_failure_scope`
  - `reason_codes_json`
  - `digest`
  - `issued_at`
  - `expires_at`

Initial classes:

- `jangar-serving`
- `jangar-huly-bridge`
- `jangar-plan-stage`
- `jangar-implement-stage`
- `jangar-verify-stage`
- `jangar-deploy-verifier`
- `torghut-runtime-consumer`
- `torghut-promotion-consumer`

Rules:

- serving and handoff are distinct classes;
- a missing Huly bridge asset blocks `jangar-huly-bridge` and dependent requirement runs, not `jangar-serving`;
- stale freeze debt may still degrade or block promotion classes without taking serving down.

### 3. Admission compiler

The compiler joins four surfaces:

1. authority sessions and recovery cases from the existing March 20 architecture line;
2. runtime-kit observations from image, workspace, and mounted-asset probes;
3. freshness inputs for required data dependencies such as quant evidence, market context, and simulation state;
4. consumer bindings for `/ready`, codex implementation runs, deploy verification, and Torghut.

Compiler outputs must:

- cite the exact `runtime_kit_id` used for the decision;
- preserve the open recovery-case ids that affected the class;
- emit bounded `reason_codes_json` so the user sees whether the issue is runtime, freshness, recovery debt, or rollout.

### 4. Read-model and consumer changes

`/ready` and `/api/agents/control-plane/status` remain, but they become projections over admissions.

- `/ready`
  - returns the latest `jangar-serving` admission
  - includes `execution_admission_id`, `runtime_kit_id`, and `consumer_attestation_id`
- `/api/agents/control-plane/status`
  - keeps the rich controller, rollout, database, watch, swarm, and empirical sections
  - adds runtime kits, execution-class admissions, and bounded failure scope
- codex requirement and plan runs
  - record which execution admission they consumed
  - fail closed only when their bound class is `block`

### 5. Rollout safety and deployment verification

`packages/scripts/src/jangar/verify-deployment.ts` must stop proving only digest parity.

New deploy contract:

- a rollout is promotable only when deployment digest and required runtime-kit digest both match;
- `jangar-deploy-verifier` admission must be `allow`;
- rollout evidence stores `execution_admission_id`, `runtime_kit_id`, and `authority_session_id`;
- missing stage-specific runtime assets force a deploy hold even when pods are `Ready`.

### 6. Validation and acceptance gates

Engineer acceptance gates:

- unit tests for:
  - runtime-kit compilation with a missing skill path;
  - execution-class admission that blocks `jangar-huly-bridge` while keeping `jangar-serving` degraded or allowed;
  - parity between `/ready`, status, and execution admissions
- replay test seeded with:
  - March 11, 2026 stale freeze debt
  - March 20, 2026 healthy rollouts
  - the observed missing Huly skill path failure
- deploy-verifier test proving digest parity alone is insufficient when the runtime kit is incomplete

Deployer acceptance gates:

- rollout records show one `execution_admission_id` per deploy attempt;
- a canary may proceed when `jangar-serving` is `allow` or bounded `degrade`, but promotion remains blocked if the
  required non-serving class is blocked;
- rollback triggers include runtime-kit regression, not only pod-unready or Argo health failure.

## Rollout plan

Phase 0. Add tables and runtime probes in shadow mode.

- write runtime kits and observations without changing consumer behavior
- surface the missing Huly skill path as a first-class observation

Phase 1. Project runtime kits and admissions through status.

- keep `/ready` and deploy verification on existing logic
- compare runtime-kit decisions against live incidents and logs

Phase 2. Move codex requirement and plan runs to execution-class admission.

- requirement handoff binds to `jangar-huly-bridge`
- stage runs bind to `jangar-plan-stage`, `jangar-implement-stage`, and `jangar-verify-stage`

Phase 3. Move `/ready` and deploy verification.

- `/ready` reads `jangar-serving`
- deploy verification reads `jangar-deploy-verifier`

Phase 4. Retire implicit runtime assumptions.

- image digest remains necessary but no longer sufficient
- runtime-kit and execution-admission evidence becomes mandatory for promotion and handoff

## Rollback

If the runtime-kit compiler or admission policy is wrong:

1. stop enforcing execution-class admissions in `/ready`, deploy verification, and codex runs;
2. fall back to current request-time readiness and digest checks;
3. preserve runtime-kit and admission rows for forensics and replay;
4. repair the compiler in shadow mode before re-enabling enforcement.

## Risks and open questions

- Runtime probes that are too permissive will recreate today's implicit failure mode with prettier nouns.
- Runtime probes that are too strict can turn harmless packaging differences into rollout churn.
- The control plane must decide whether runtime-kit truth comes from image introspection, workspace introspection, or
  both. I prefer both so rollouts catch checkout-layout drift as well as image drift.

## Handoff to engineer and deployer

Engineer handoff:

- implement runtime-kit and execution-admission tables and compiler
- expose admissions in `/ready` and `/api/agents/control-plane/status`
- add regression coverage for the missing Huly skill path and parity coverage for serving versus handoff classes

Deployer handoff:

- require execution-admission and runtime-kit ids in deployment verification evidence
- allow serving cutover only when `jangar-serving` is valid
- keep requirement handoff, promotion, and deploy classes fail-closed until their runtime kits are complete

The acceptance bar is not "the pods are healthy." The acceptance bar is being able to prove that the runtime bound to a
consumer actually contains the assets that consumer depends on.
