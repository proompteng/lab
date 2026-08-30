# 70. Jangar Actuation Escrow and Deploy Proof Lanes (2026-05-05)

Status: Approved for implementation (`plan`)
Date: `2026-05-05`
Owner: Victor Chen (Jangar Engineering)
Mission: `codex/swarm-jangar-control-plane-plan`
Swarm impacts:

- `jangar-control-plane`
- `torghut-quant`

Companion doc:

- `docs/torghut/design-system/v6/75-torghut-profit-actuation-cells-and-capital-guardrail-marketplace-2026-05-05.md`

Extends:

- `docs/agents/designs/69-jangar-evidence-escrow-and-repair-cell-contract-2026-05-05.md`
- `docs/agents/designs/68-jangar-evidence-clock-arbiter-and-rollout-veto-contract-2026-05-05.md`
- `docs/agents/designs/66-jangar-recovery-release-lanes-and-rollout-proof-fence-contract-2026-03-21.md`
- `docs/torghut/design-system/v6/74-torghut-profit-cells-and-evidence-escrow-promotion-veto-2026-05-05.md`

## Executive Summary

The decision is to add **actuation escrow** and **deploy proof lanes** on top of Jangar evidence escrow. Evidence escrow
answers what the system believes. Actuation escrow answers whether a specific action may proceed: dispatch a swarm
stage, admit a schedule run, widen a deploy, unblock a repair cell, or pass a platform veto to Torghut.

The reason is the current May 5 assessment. Jangar is serving and the controller heartbeat path is fresh, but the
control plane still shows contradictory actuation signals:

- `/ready` returns `status="ok"` while `execution_trust.status="degraded"`;
- `/api/agents/control-plane/status?namespace=agents` reports healthy heartbeats, DB, rollout, and watches, but blocks
  dependency quorum on empirical job degradation and reports stale `jangar-control-plane` stages;
- the Jangar pod runtime kit still reports `runtime_kit_component_missing:nats_cli`, even though the local runner had
  to install the CLI before NATS publishing worked;
- recent namespace events show readiness failures for Jangar, Bumba, Redis, and Torghut revisions during rollout;
- the Jangar database has fresh current-state rows, but also a large unprocessed GitHub webhook tail and huge Torghut
  quant history tables that are not safe to scan in live gates.

The tradeoff is another durable control object and a stricter deploy contract. I am accepting that cost because the
system now has enough evidence to diagnose failure, but not enough authority to stop unsafe actuation consistently.
That is the six-month risk: a green serving route can coexist with stale stage truth, missing runtime tooling, unowned
webhook backlog, and stale downstream profit evidence.

## Success Criteria

This design is complete when engineer and deployer stages can prove these statements:

1. Every dispatch, scheduled launch, deploy widening, and Torghut platform promotion check cites one
   `actuation_escrow_id`.
2. The actuation escrow decision is derived from one current `evidence_escrow_id`, one runtime kit set, one rollout
   proof lane, and bounded DB watermarks.
3. Serving readiness can remain available while dispatch or promotion is held, but the response exposes the held
   actuation ids and reason codes.
4. Missing required runtime components in the deployed image, including `nats`, block collaboration and swarm-stage
   actuation before a stage starts.
5. Deleted or merged GitHub branch refs do not poison review ingestion; the deploy proof lane falls back to commit SHA
   and archived PR metadata.
6. Rollback is a reversible projection change: stop enforcing actuation escrow, keep writing evidence, and preserve the
   escrow records for audit.

## Assessment Snapshot

### Runtime Inputs

- repository: `proompteng/lab`
- base: `main`
- head: `codex/swarm-jangar-control-plane-plan`
- swarmName: `jangar-control-plane`
- swarmStage: `plan`
- objective: assess cluster/source/database state and create or update merged design artifacts that improve Jangar
  control-plane resilience and Torghut profitability

NATS context soak used `.codex-nats-context.json`. It requested the `workflow.general.>` context, fetched `0` messages,
and therefore provided no teammate state to reuse before action. The first publish attempt failed because the runner
image did not contain the `nats` CLI; after installing it locally, `codex-nats-publish` successfully published status
updates.

### Cluster Health, Rollout, and Events

Read-only Kubernetes access used the `agents` service account.

- `kubectl get pods -n jangar -o wide`
  - `jangar-675b5b8855-rwglb` was `2/2 Running` on image digest
    `sha256:4ebf9060cac6d01623a719b37286fd51fbeae95fe657cd8bc88c9b5bdf0c7c92`.
  - `bumba`, `symphony`, `symphony-jangar`, OpenWebUI, Redis, Alloy, and `jangar-db-1` were running.
- `kubectl get events -n jangar --sort-by=.lastTimestamp`
  - showed recent readiness probe failures during rollout for Jangar (`/health` connection refused), Bumba (`503`),
    Redis (`redis-cli ping` timed out after one second), and `jangar-db-1` (`HTTP probe failed with statuscode: 500`).
  - showed the current Jangar pod created and started about three minutes before the assessment sample.
- `kubectl logs -n jangar pod/jangar-675b5b8855-rwglb -c app --tail=80`
  - showed leader election succeeded for `jangar-controller-leader`.
  - showed GitHub review ingest failures resolving deleted or merged branch refs, including
    `codex/swarm-jangar-control-plane-plan` for PR `5392`.
- `kubectl get pods -n agents -o wide`
  - showed the split controller deployment currently running and ready.
  - also showed many historical failed schedule pods for Jangar and Torghut swarms.
- `kubectl get agentruns -n agents`
  - showed current Jangar plan, discover, implement, and verify runs in `Running` or `Pending` states, plus old failed
    requirement runs.
- RBAC reality:
  - the service account can read pods, pod logs, services, events, AgentRuns, and specific reflected DB secrets.
  - it cannot list deployments in `jangar`, cannot read Argo CD Applications, cannot read CNPG cluster objects, and
    cannot exec into DB pods.

Interpretation:

- The serving path is up.
- The deployer path cannot depend on privileged cluster reads.
- Actuation safety needs to consume typed Jangar evidence and DB watermarks, not ad hoc shell access.

### Source Architecture and High-Risk Modules

The in-tree source already has the components needed for this contract:

- `services/jangar/src/server/control-plane-status.ts`
  - composes controller heartbeats, rollout health, execution trust, workflow reliability, runtime kits, DB status, and
    dependency quorum.
- `services/jangar/src/server/control-plane-runtime-admission.ts`
  - builds runtime kits and admission passports, but currently describes missing `nats` as a runtime fact instead of an
    image-build and stage-actuation blocker.
- `services/jangar/src/server/control-plane-rollout-health.ts`
  - can derive rollout state from deployments when RBAC allows it, and already separates heartbeat authority from
    rollout fallback.
- `services/jangar/src/server/control-plane-workflows.ts`
  - evaluates recent workflow failures and dependency quorum, but its output is still advisory unless a consumer
    enforces it.
- `services/jangar/src/server/control-plane-execution-trust.ts`
  - identifies stale stages and pending requirements; in this assessment it reported five pending Jangar requirements
    and all four Jangar stages stale.
- `services/jangar/src/server/github-review-ingest.ts` and `github-worktree-snapshot.ts`
  - need a deleted-head fallback so merged PRs and deleted branches do not look like active review-ingest defects.
- `services/jangar/scripts/codex-nats-publish.ts`
  - shells out to `nats`, which makes `nats` a required collaboration runtime component for Codex/Jangar images.

Risk evidence:

- `bun run --cwd services/jangar check:module-sizes` passed for 407 files, so the module-size guardrail is not failing.
- The largest Jangar modules remain broad and operationally sensitive, including `codex-judge.ts`, `atlas-store.ts`,
  `orchestration-controller.ts`, `chat-completion-encoder.ts`, `torghut-market-context-agents.ts`,
  `torghut-simulation-control-plane.ts`, and `supporting-primitives-controller.ts`.
- Existing tests cover many controller and status surfaces, but there is no single parity test requiring `/ready`,
  status, dispatch, deploy verification, and Torghut promotion to cite the same actuation decision.

### Database and Data Quality

The Jangar database was assessed with the app account through Postgres. No writes were issued.

- PostgreSQL version: `17.0`.
- Schema inventory:
  - `agents_control_plane`: 2 tables.
  - `jangar_github`: 9 tables.
  - `workflow_comms`: 1 table.
  - `torghut_control_plane`: 11 tables.
  - `public`: 54 tables.
- Fresh current-state rows:
  - `agents_control_plane.component_heartbeats.updated_at` reached `2026-05-05T09:27:22.350Z`.
  - `workflow_comms.agent_messages.timestamp` reached `2026-05-05T09:27:18.253Z`.
  - `public.agent_runs.updated_at` reached `2026-05-05T09:27:26.912Z`.
- Current-state shape:
  - `agents_control_plane.resources_current` had `3103` `AgentRun` rows in `Failed`, `3074` of them deleted.
  - `AgentRun` rows in `Running`: `10`.
  - `ImplementationSpec` rows: `23`.
- GitHub webhook state:
  - `jangar_github.events` had `14352` unprocessed `check_run.created` rows, `13822` unprocessed
    `check_run.completed` rows, and `8728` unprocessed `check_suite.completed` rows.
  - `jangar_github.check_state` had `791` success rows, `370` pending rows, and `252` failure rows.
- Memory state:
  - `memories.entries` had `81` rows with newest update `2026-05-05T06:29:19.517Z`.
  - the repo memory helper still failed twice with `ECONNRESET` against `/api/memories`.
- Torghut control-plane data in Jangar:
  - `quant_metrics_latest` had fresh updates at `2026-05-05T09:27:26.162Z`.
  - only `91` latest metric rows were `ok/good`.
  - `558` rows were `ok/stale`.
  - `2627` rows were `insufficient_data/insufficient_data`.
  - `quant_metrics_series` was estimated at `317739425` rows, and `quant_pipeline_health` at `50618301` rows.

Interpretation:

- Current-state projection is healthy enough to drive gates.
- Broad history scans are the wrong primitive for deploy or promotion gates.
- Webhook backlog and deleted-ref errors need repair-cell ownership before review-ingest evidence is trusted for
  actuation.

## Problem Statement

Jangar now has many high-quality facts but no single action contract. A consumer can see that serving is healthy, that
execution trust is degraded, that collaboration tooling is missing from the deployed image, that workflow messages are
fresh, and that GitHub webhook processing is behind. The system still requires humans and downstream code to infer
which facts should stop which actions.

That inference is too fragile. The next architecture boundary must say:

- this evidence was accepted;
- this evidence was stale or missing;
- this repair cell owns the gap;
- this exact action is allowed, degraded, held, or blocked;
- this deploy or promotion can be rolled back by changing projection and enforcement, not by deleting facts.

## Alternatives Considered

### Option A: Patch the Local Defects and Keep Current Status Semantics

This option bakes `nats` into the image, adds the GitHub deleted-ref fallback, tunes probes, and leaves status routes as
the main authority.

Pros:

- Fast.
- Reduces visible runtime noise.
- Low schema impact.

Cons:

- Leaves dispatch, deploy, and Torghut promotion to interpret multiple status fields independently.
- Does not solve partial-RBAC deploy verification.
- Does not give repair cells an enforceable action boundary.

Decision: rejected as the architecture answer. These patches are required implementation work, but they are not enough.

### Option B: Make `/ready` the Universal Safety Gate

This option makes `/ready` return `503` whenever execution trust, runtime kits, webhook backlog, or Torghut evidence is
degraded.

Pros:

- Easy for Kubernetes and operators to understand.
- Prevents false confidence from a green serving path.

Cons:

- Takes away the recovery UI/API during observer or downstream repair.
- Couples platform serving to trading economics.
- Encourages every subsystem to overload one HTTP bit.

Decision: rejected. Serving must stay recoverable while unsafe actuation fails closed.

### Option C: Actuation Escrow and Deploy Proof Lanes (Selected)

This option writes one actuation decision per target action and makes deploy verification consume proof lanes that are
valid under partial RBAC.

Pros:

- Gives every action one durable id and one reason-code set.
- Keeps serving, dispatch, deploy, repair, and promotion authority separate.
- Lets deployers validate without privileged cluster access.
- Converts webhook backlog, missing runtime tooling, and stale stages into explicit repair work.
- Gives Torghut a platform veto without making Jangar own PnL.

Cons:

- Adds schema, compiler, and projector work.
- Requires staged enforcement to avoid deadlocking current swarms.
- Adds one more object operators must learn.

Decision: selected.

## Target Architecture

### Actuation Escrow

An actuation escrow is a sealed decision record:

```text
actuation_escrow_id
evidence_escrow_id
target_kind
target_ref
consumer_class
decision
reason_codes
runtime_kit_ids
rollout_proof_lane_id
db_watermark_ids
github_ingest_watermark_id
repair_cell_ids
issued_at
fresh_until
producer_revision
rollback_projection
```

Consumer classes:

- `serving`
- `swarm_dispatch`
- `schedule_launch`
- `deploy_widening`
- `repair_unblock`
- `torghut_platform_promotion`

Decisions:

- `allow`: all required evidence is fresh and compatible.
- `degrade`: action can proceed only in a reduced class, such as serving without promotion.
- `hold`: action waits for a bounded repair cell but does not page.
- `block`: action must not proceed.

### Deploy Proof Lane

A deploy proof lane is a typed sequence of receipts for one commit or release:

1. `premerge`: CI, docs validation, schema migration plan, and runtime tool attestation.
2. `predeploy`: image digest, platform manifest, release contract, and GitOps manifest render.
3. `canary`: leader election, heartbeat, DB migration consistency, runtime kit, and watch reliability.
4. `postdeploy`: current-state watermarks, webhook backlog budget, workflow reliability, and Torghut platform veto.
5. `rollback`: previous image digest, previous projection generation, and repair-cell disposition.

The deploy proof lane must work when the runner cannot list deployments or Argo CD Applications. It may consume Jangar
status, pod state, services, events, DB watermarks, and GitHub API state. Privileged checks can enrich the lane, but
they cannot be required for a green decision.

### Runtime Tool Attestation

The image build must emit a runtime tool receipt for:

- `bun`
- `gh`
- `git`
- `kubectl`
- `nats`
- `codex-nats-publish`
- `codex-nats-soak`

Missing optional tools degrade only their consumer class. Missing required collaboration tools block swarm dispatch and
stage completion, because a worker that cannot publish coordination state is not production-equivalent.

### GitHub Review Ingest Repair

Review ingest must distinguish these cases:

- active branch exists: read worktree snapshot from head ref;
- merged branch deleted: read PR head SHA and archived file metadata;
- branch truly missing before merge: assign `github_ref_missing` repair cell;
- GitHub API unavailable: assign `github_api_unavailable` repair cell with retry deadline.

Deleted merged branches are not a control-plane defect. Treating them as one makes review truth noisy.

### Bounded Data Watermarks

Actuation escrow reads current-state tables and watermarks only:

- `agents_control_plane.component_heartbeats`
- `agents_control_plane.resources_current`
- `workflow_comms.agent_messages`
- `jangar_github.check_state`
- `jangar_github.pr_state`
- `torghut_control_plane.quant_metrics_latest`

History tables such as `torghut_control_plane.quant_metrics_series` and `quant_pipeline_health` are not live gate
inputs. Producers must summarize them into current-state watermarks under their own read budgets.

## Implementation Scope

Engineer stage should implement:

1. Add additive Jangar DB tables for `actuation_escrows`, `deploy_proof_lanes`, `deploy_proof_receipts`, and
   `actuation_watermarks`.
2. Add a compiler that consumes the latest evidence escrow, runtime kit snapshot, workflow reliability, DB status,
   GitHub state, and Torghut quant latest rows.
3. Extend `/ready` and `/api/agents/control-plane/status` to include current actuation ids without making serving fail
   on non-serving blocks.
4. Add dispatch and schedule-launch admission checks that require an `allow` decision for their consumer class.
5. Add runtime tool attestation to the Jangar image build and CI.
6. Add GitHub deleted-ref fallback in review ingest.
7. Add repair-cell rows for webhook backlog and runtime kit defects.

Deployer stage should implement:

1. Render and validate the deploy proof lane before rollout widening.
2. Verify current Jangar pod runtime kit includes `nats`.
3. Verify postdeploy actuation decisions are `allow` for serving and either `allow` or explicitly `hold` for dispatch.
4. Refuse Torghut promotion if the platform promotion actuation is `block`.

## Validation Gates

Required local and CI checks:

- `bun run --cwd services/jangar check:module-sizes`
- `bun run --cwd services/jangar docs:inventory:check`
- `bun run --cwd services/jangar test -- src/server/__tests__/control-plane-status.test.ts`
- new actuation compiler unit tests with frozen DB/current-state fixtures
- new runtime tool attestation tests proving `nats` is required for collaboration kits
- new GitHub review-ingest test for deleted merged branch refs
- migration tests for additive escrow tables

Required read-only deploy checks:

- `curl http://jangar.jangar.svc.cluster.local/ready`
- `curl 'http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status?namespace=agents'`
- `kubectl get pods -n jangar -o wide`
- `kubectl get events -n jangar --sort-by=.lastTimestamp`
- bounded SQL probe for current-state watermarks, with statement timeout

Pass criteria:

- serving actuation `allow` or `degrade` with no serving-class blocker;
- swarm dispatch actuation `allow` before scheduled launches;
- deploy widening actuation `allow` before production rollout;
- Torghut platform promotion actuation `allow` before non-observe capital promotion;
- no gate reads from broad quant history tables.

## Rollout Plan

1. Shadow-write actuation escrow and deploy proof lane records without enforcement.
2. Surface current actuation ids in `/ready`, status API, and Jangar UI.
3. Enforce `schedule_launch` and `swarm_dispatch` for newly created runs only.
4. Enforce `deploy_widening` for Jangar image promotions.
5. Pass `torghut_platform_promotion` to Torghut as a required input.
6. Retire legacy route-time promotion interpretation once parity tests show identical allow/hold/block decisions for
   two consecutive rollout windows.

## Rollback Plan

Rollback is projection-first:

1. Disable actuation enforcement flags.
2. Keep writing actuation escrow records for audit.
3. Return dispatch and deploy paths to legacy status-derived decisions.
4. Mark the current actuation generation `superseded`.
5. Re-enable enforcement only after a new escrow generation passes shadow parity.

Do not delete escrow rows. They are evidence for why rollback happened.

## Risks

- Schema and compiler complexity can create another failure domain. Mitigation: additive tables, shadow mode, and
  statement timeouts.
- Over-strict dispatch gates can stall swarms. Mitigation: start with new runs only and allow manual emergency override
  with an explicit repair-cell receipt.
- Operators may confuse evidence escrow and actuation escrow. Mitigation: UI language must lead with action decision
  and cite evidence id second.
- Torghut may treat platform `allow` as profit approval. Mitigation: companion profit-cell design keeps Jangar as a
  veto input, not final economic authority.

## Engineer Handoff

Build the compiler and schema first. The first implementation milestone is not enforcement; it is a shadow actuation
record that matches current status decisions and exposes one id in `/ready` and status. Do not add broad table scans.
Every DB read must be from current-state tables or a producer-owned watermark.

Acceptance gates:

- additive migrations pass;
- shadow compiler fixtures cover healthy, degraded, hold, and block;
- Jangar image CI proves `nats` is present;
- deleted merged branch refs no longer create review-ingest repair defects;
- NATS publish works from a fresh Jangar runner image without local tool installation.

## Deployer Handoff

Treat actuation ids as rollout gates. Before widening a Jangar deploy, collect the deploy proof lane, current status,
pod state, and current DB watermarks. If serving is allowed but dispatch is held, keep the service available and stop
new scheduled work until the repair cell exits. If platform promotion is blocked, pass that veto to Torghut and do not
interpret live trading health as platform approval.

Acceptance gates:

- postdeploy `/ready` and status responses cite the same current actuation generation;
- Jangar pod runtime kit includes `nats`;
- workflow messages continue to arrive in `workflow_comms.agent_messages`;
- webhook backlog is below the configured action budget or assigned to a repair cell;
- rollback recipe points to the previous image and previous projection generation.
