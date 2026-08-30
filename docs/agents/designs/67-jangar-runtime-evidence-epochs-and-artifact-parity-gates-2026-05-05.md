# 67. Jangar Runtime Evidence Epochs and Artifact Parity Gates (2026-05-05)

Status: Approved for implementation (`discover`)
Date: `2026-05-05`
Owner: Gideon Park (Torghut Traders architecture)
Mission: `codex/swarm-torghut-quant-discover`
Swarm impacts:

- `jangar-control-plane`
- `torghut-quant`

Companion doc:

- `docs/torghut/design-system/v6/72-torghut-cross-plane-evidence-epochs-and-portfolio-proof-lanes-2026-05-05.md`

Extends:

- `65-jangar-recovery-epoch-cutover-and-backlog-seat-enforcement-contract-2026-03-21.md`
- `65-jangar-recovery-warrants-and-runtime-proof-cells-contract-2026-03-21.md`
- `66-jangar-recovery-release-lanes-and-rollout-proof-fence-contract-2026-03-21.md`
- `63-jangar-consumer-projections-and-latency-class-admission-contract-2026-03-20.md`

## Executive summary

The decision is to extend Jangar recovery epochs into runtime evidence epochs and artifact parity gates. Jangar should
not only say whether it can serve `/ready`; it must say whether runtime tools, collaboration transport, stage
freshness, downstream Torghut evidence, and promoted artifacts are coherent enough for the target consumer.

The May 5 evidence is clear. Jangar `/ready` returned HTTP 200, but the same payload reported degraded execution trust
and `runtime_kit_component_missing:nats_cli`. Jangar control-plane status reported database health, but dependency
quorum was `block`, one `agents-controllers` replica was not ready, workflow/job runtimes were unavailable, and stage
evidence was stale. Agents events also showed hotfix-created jobs producing `UnexpectedJob` warnings on cronjobs.
Downstream, Torghut liveness passed while readiness, DB check, status, and quant-health calls timed out. Torghut sim
had an `ImagePullBackOff` because the promoted image digest lacked a matching platform for one scheduled node.

I am choosing a staged evidence-epoch gate rather than a topology split or another status reducer. The tradeoff is more
metadata in every stage transition. I accept it because the failure mode is not lack of status. It is status without a
single boundary that can stop stale work, missing tools, and platform-incompatible artifacts from being treated as
independent noise.

## Mission inputs and success criteria

Inputs:

- repository: `proompteng/lab`
- base: `main`
- head: `codex/swarm-torghut-quant-discover`
- swarmName: `torghut-quant`
- swarmStage: `discover`
- objective: improve Jangar resilience/reliability and Torghut profitability through merged architecture artifacts

Success means:

1. `/ready`, `/api/agents/control-plane/status`, dispatch, deploy verification, NATS publication, and Torghut consumer
   projections cite one runtime evidence epoch id;
2. Jangar distinguishes serving readiness, collaboration readiness, stage execution readiness, and downstream consumer
   readiness;
3. missing runtime tools such as `nats` block only the stages that need them, but block those stages decisively;
4. artifact digest/platform parity is checked before a release is promoted to Torghut sim, analysis, or live lanes;
5. stale cron, hotfix, and schedule work is reseated or quarantined under one epoch.

## Assessment snapshot

### Cluster health, rollout, and events

Jangar is available, but not execution-trust healthy.

- `curl http://jangar.jangar.svc.cluster.local/ready`
  - returned HTTP 200;
  - reported leader election healthy;
  - reported `execution_trust.status="degraded"`;
  - reported stale `jangar-control-plane` and `torghut-quant` stages;
  - reported a collaboration runtime kit with `runtime_kit_component_missing:nats_cli`.
- `curl http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status?namespace=agents`
  - returned HTTP 200;
  - reported `database.connected=true`, `status="healthy"`, and `25/25` migrations applied;
  - reported `rollout_health.status="degraded"`;
  - reported `agents-controllers` desired `2`, ready `1`, available `1`;
  - reported `dependency_quorum.decision="block"`;
  - reported workflow and job runtimes unavailable.
- `kubectl get pods -n agents -o wide`
  - showed one `agents-controllers` pod not ready and one ready;
  - showed many recent Jangar and Torghut swarm schedule pods in `Error`;
  - showed new discover, plan, implement, and verify pods running after hotfix jobs.
- `kubectl get events -n agents --sort-by=.lastTimestamp`
  - showed hotfix jobs completing;
  - showed `UnexpectedJob` warnings for cronjobs that saw hotfix-created jobs they did not own;
  - showed new stage jobs starting after those hotfixes.

Interpretation: serving health is real, but not sufficient for stage launch or downstream promotion authority.

### Source architecture and high-risk modules

Jangar already has most primitives needed for this design.

- Status and data contracts already model runtime kits, admission passports, dependency quorum, execution trust,
  rollout health, and consumer projections.
- The Torghut quant health route exists at
  `services/jangar/src/routes/api/torghut/trading/control-plane/quant/health.ts`, but a live request timed out during
  this assessment.
- `services/jangar/src/server/torghut-quant-runtime.ts` materializes quant metrics in process-local runtime state.
  That is acceptable as a metrics producer, but consumer-facing authority must be an epoch receipt with freshness and
  reason codes.
- Jangar status surfaced the missing `nats` runtime component, but the release and dispatch model did not yet turn it
  into a stage-specific enforcement boundary.
- March 20 and March 21 designs already define admission passports, runtime kits, recovery epochs, backlog seats, and
  rollout proof fences. This document narrows the next step to consumer-facing runtime evidence epochs and artifact
  parity.

Interpretation: Jangar does not need another broad control-plane concept. It needs to bind existing concepts into one
consumer-facing evidence epoch.

### Database, data, and consistency evidence

The Jangar database substrate was not the weak point in this run.

- Jangar control-plane status reported database health and migration consistency as healthy.
- Jangar `/ready` reported the memory provider configured and healthy.
- The repo memory helper still returned `ECONNRESET` for two retrieval attempts against `/api/memories`.
- The service account lacked direct Torghut DB and ClickHouse exec access, reinforcing that Jangar deploy gates must
  consume typed receipts rather than privileged shell checks.

Interpretation: Jangar should project downstream receipt freshness and route transport failures separately from
backing-store health.

## Problem statement

Jangar can currently say:

- serving is up;
- execution trust is degraded;
- a runtime kit is missing a component;
- rollout health is degraded;
- dependency quorum blocks;
- Torghut status is unavailable;
- stage evidence is stale.

What it cannot yet do is bind those facts to one consumer-facing runtime evidence epoch that answers:

- can this stage launch;
- can this swarm advance;
- can this Torghut research epoch advance;
- can this release widen;
- can this portfolio candidate fund capital;
- can this hotfix job coexist with the cron schedule.

Without that boundary, stale work can relaunch after rollout changes, missing tools remain visible but weakly enforced,
and downstream Torghut evidence is treated as route availability instead of epoch-bound proof.

## Alternatives considered

### Option A: split Jangar controller topology first

Pros:

- useful later if resource contention keeps appearing;
- reduces blast radius for process-level failures.

Cons:

- does not prove current work belongs to the current recovery epoch;
- does not stop missing runtime tools from shipping in an image;
- does not address Torghut artifact platform parity.

Decision: rejected for this phase.

### Option B: add more fields and alerts to current status routes

Pros:

- smallest implementation delta;
- preserves current UI and API shape.

Cons:

- produces more fragmented truth;
- does not give dispatch or deploy verification one gate id;
- keeps operators manually reconciling symptoms.

Decision: rejected as the primary architecture.

### Option C: runtime evidence epochs plus artifact parity gates

Pros:

- directly addresses missing-tool, stale-stage, hotfix-overlap, and artifact-platform failures;
- fits the existing March 20 and March 21 Jangar architecture stack;
- lets serving remain up while promotion and stage execution fail closed.

Cons:

- adds persistent receipt and epoch state;
- requires consumers to stop reading generic status as final authority;
- needs careful migration to avoid deadlocking current swarms.

Decision: selected.

## Decision

Adopt Option C.

Jangar will compile runtime evidence epochs and artifact parity gates. Existing recovery epochs remain the work
ownership model. Runtime evidence epochs become the consumer-facing proof that the current runtime, tools, rollout,
downstream evidence, and artifact set can safely support the requested stage.

## Architecture

### Runtime evidence epoch

Add a runtime evidence epoch:

```text
runtime_evidence_epoch_id
recovery_epoch_id
consumer_class
created_at
fresh_until
decision
reason_codes
serving_passport_id
collaboration_runtime_kit_id
stage_runtime_kit_id
rollout_health_receipt_id
dependency_quorum_receipt_id
downstream_receipt_ids
artifact_parity_receipt_ids
reseat_receipt_ids
```

Allowed decisions:

- `serve_only`
- `shadow_allowed`
- `stage_allowed`
- `promotion_allowed`
- `blocked`
- `quarantined`

Rules:

- `/ready` may return HTTP 200 when the serving passport is fresh, even if the runtime evidence epoch is `blocked`.
- stage launch requires `stage_allowed` for the target consumer.
- Torghut promotion requires `promotion_allowed` and a fresh Torghut evidence epoch.
- missing `nats` blocks consumer classes that require channel coordination.
- stale stage evidence blocks launch until reseated or quarantined.

### Runtime-kit enforcement by consumer class

Required consumer classes:

- `serving`
- `swarm_discover`
- `swarm_plan`
- `swarm_implement`
- `swarm_verify`
- `torghut_quant`
- `deploy_verification`
- `collaboration`

Example requirements:

- `serving` requires `bun` and route serving.
- `collaboration` requires `/usr/local/bin/codex-nats-publish`, `/usr/local/bin/codex-nats-soak`, `nats`, and
  `NATS_URL`.
- `deploy_verification` requires `kubectl`, `gh`, GitHub auth, and artifact parity access.
- `torghut_quant` requires Jangar status, Torghut evidence epoch, quant health, and empirical service receipts.

The May 5 missing-`nats` evidence should allow serving to continue and block NATS-required plan, implement, verify, and
collaboration consumers.

### Artifact parity gate

Compile an artifact parity receipt for GitOps image consumers:

```text
artifact_parity_receipt_id
consumer_ref
image_ref
digest
required_platforms
observed_platforms
missing_platforms
runtime_pull_failures
decision
reason_codes
```

Decisions:

- `pass`
- `warn_unused_platform_missing`
- `fail_missing_required_platform`
- `fail_pull_observed`
- `fail_gitops_runtime_drift`
- `unknown_registry`

Inputs include GitOps image refs, release-contract digest, registry manifest platform metadata, node architecture
inventory, recent pull failures, and current pod image ids when readable.

The Torghut sim failure makes this gate mandatory for sim, analysis, and live promotion.

### Downstream receipt ingestion

Jangar should ingest Torghut receipts rather than treating raw route polling as final authority.

Torghut downstream receipts:

- service health;
- schema/data freshness;
- empirical jobs;
- ClickHouse guardrails;
- portfolio proof;
- Torghut evidence epoch.

Rules:

- a raw route timeout creates a receipt with timeout reason codes;
- it does not erase the previous receipt;
- it does not become success;
- consumers decide based on freshness and stage requirements.

### Reseat and quarantine workflow

When Jangar sees a job that a cronjob did not create or forgot:

1. write a `reseat_candidate` receipt;
2. bind it to the current recovery epoch if legitimate;
3. quarantine it if it belongs to a retired or unknown epoch;
4. surface the decision in control-plane status;
5. prevent duplicate launch while reseat is unresolved.

This keeps hotfixes useful without making cron ownership ambiguous.

### API projection

Add `runtime_evidence_epoch_id` and decision to:

- `/ready`;
- `/api/agents/control-plane/status`;
- swarm status projections;
- dispatch logs;
- deploy verification output;
- Jangar Torghut control-plane pages;
- progress-comment and NATS status payloads when available.

## Implementation scope

Engineer stage should implement additive state first:

1. `services/jangar/src/server/runtime-evidence-epochs.ts`
   - compiler and pure decision helpers.
2. `services/jangar/src/server/artifact-parity.ts`
   - digest/platform receipt builder.
3. `services/jangar/src/server/downstream-receipts.ts`
   - Torghut receipt ingestion and timeout normalization.
4. Kysely migration
   - append-only `runtime_evidence_epochs`, `runtime_evidence_receipts`, and `artifact_parity_receipts`.
5. `services/jangar/src/routes/ready.tsx`
   - include runtime evidence epoch id and decision.
6. `services/jangar/src/server/control-plane-status.ts`
   - project runtime evidence epoch and artifact parity summaries.
7. Dispatch path
   - require `stage_allowed` for stage work once enforcement is enabled.
8. Tests
   - missing NATS, stale stages, rollout degradation, downstream timeout, and artifact platform failure.

Deployer stage should add runtime-image preflight for `nats`, artifact parity before Torghut release widening, unknown
hotfix-job quarantine, and an operator-visible active epoch id.

## Validation gates

Required local checks for engineer changes:

- `bun run --filter jangar test -- runtime-evidence`
- `bun run --filter jangar test -- artifact-parity`
- `bunx oxfmt --check services/jangar/src/server services/jangar/src/routes`
- `bun run lint:jangar`

Required deployer checks:

- `curl --max-time 8 http://jangar.jangar.svc.cluster.local/ready`
- `curl --max-time 8 http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status?namespace=agents`
- `kubectl get pods -n agents -o wide`
- `kubectl get events -n agents --sort-by=.lastTimestamp`
- `kubectl get pods -n torghut -o wide`
- `kubectl get events -n torghut --sort-by=.lastTimestamp`

Acceptance gates:

- serving passport may degrade, but the decision is explicit;
- collaboration runtime kit passes when a stage requires NATS;
- `agents-controllers` rollout is healthy or the epoch blocks stage launch;
- hotfix and cron-overlap jobs are reseated or quarantined;
- Torghut artifact parity passes before sim, analysis, or live release widening;
- Torghut downstream evidence epoch is fresh before promotion-friendly authority is emitted.

## Rollout and rollback

Rollout phases:

1. Shadow epoch
   - compile epochs without blocking and compare with current dependency quorum and admission passport outputs.
2. Collaboration stage gate
   - block NATS-required stages when collaboration runtime is missing; keep serving available.
3. Artifact parity gate
   - require artifact parity for Torghut release candidates; block sim and analysis on required platform gaps.
4. Full consumer enforcement
   - dispatch, deploy verification, and Torghut promotion authority require a fresh runtime evidence epoch.

Rollback rules:

- compiler failure falls back to previous serving status but blocks promotion-friendly authority;
- artifact parity false positives can disable enforcement by feature flag while keeping shadow receipts;
- legitimate hotfix blocks can use one expiring override receipt;
- unavailable Torghut receipts preserve last known receipt, mark it stale after `fresh_until`, and block promotion.

## Risks and mitigations

Risk: epoch objects become stale and block all work.

Mitigation: `serve_only` remains available and stage/promotion gates are separated by consumer class.

Risk: registry access is not always available for artifact parity.

Mitigation: use `unknown_registry` separately and combine registry checks with observed pull events and node inventory.

Risk: runtime-kit checks drift from the actual image.

Mitigation: check from inside the deployed runtime image where possible and include component digests.

Risk: downstream receipt ingestion duplicates Torghut authority.

Mitigation: Jangar stores and projects Torghut receipts, but Torghut remains the trading and portfolio authority.

## Handoff to engineer

Build the compiler and tests first.

Acceptance gates:

1. missing `nats` produces `blocked` for collaboration, plan, implement, and verify consumers;
2. serving remains available when only collaboration runtime is missing;
3. Torghut `ImagePullBackOff` or missing manifest platform blocks artifact parity for release widening;
4. downstream Torghut timeout becomes a receipt with timeout reason codes;
5. status routes project `runtime_evidence_epoch_id` without dropping existing fields.

## Handoff to deployer

Deploy shadow mode before enforcement.

Acceptance gates:

1. active Jangar pods report a runtime evidence epoch id in `/ready` and control-plane status;
2. the deployed runtime image contains `nats` when collaboration stages are enabled;
3. `agents-controllers` rollout is healthy before stage enforcement widens;
4. Torghut sim and analysis artifacts pass digest/platform parity before promotion;
5. unknown hotfix jobs are reseated or quarantined before the next scheduled stage launch.
