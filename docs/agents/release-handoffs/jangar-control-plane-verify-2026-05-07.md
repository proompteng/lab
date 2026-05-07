# Jangar Control Plane Release Verification

Timestamp: 2026-05-07T04:58:00Z
Repository: `proompteng/lab`
Base: `main`
Release branch: `codex/swarm-jangar-control-plane-verify`
Observed main: `6c84303fe49b3dc6e275f6302b0b42cd37d69562`

## Owner Update Message

Jangar GitOps rollout is healthy, but the runtime action gate is held. The latest Jangar source PR #5774 merged as
`39c27b12595aeaf8b4de2b06627cf51ecf11fba4`, and the generated GitOps promotion PR #5775 promoted image tag
`39c27b12` and merged as `6c84303fe49b3dc6e275f6302b0b42cd37d69562`.

Argo reports `jangar` and `agents` Synced/Healthy at `6c84303fe49b3dc6e275f6302b0b42cd37d69562`. The `jangar`
deployment is 1/1 ready, `agents` is 1/1 ready, and `agents-controllers` is 2/2 ready. The Jangar deployment verifier
passed expected revision, digest, rollout, and admission-passport checks for
`sha256:cdfdcb5e829ee93de87320b2912260cc7d025a9924815ec1327d2f99bcbed755`.

The merge gate remains no-go for #5412. It is dirty against current `main`, still exceeds the 1000-line large-diff
threshold, and still lacks the mandatory Codex review because review requests return the connector usage-limit blocker.
Runtime residual risk is also no-go for material action widening: control-plane status reports `execution_trust=degraded`
because discover, plan, implement, and verify stage evidence is stale.

## PRs Touched

- #5774, `fix(jangar): refresh schedule runtime digests`
  - Head: `codex/jangar-swarm-schedule-digest-refresh`
  - Merged before this handoff as `39c27b12595aeaf8b4de2b06627cf51ecf11fba4`.
  - Selected as the latest Jangar source change behind the active production image.
- #5775, `chore(jangar): promote image 39c27b12`
  - Head: `codex/jangar-release-39c27b12`
  - Generated GitOps promotion for #5774.
  - Merged before this handoff as `6c84303fe49b3dc6e275f6302b0b42cd37d69562`.
  - Created anchored Codex progress comment:
    https://github.com/proompteng/lab/pull/5775#issuecomment-4394256111.
- #5412, `feat(torghut): add proof leases and evidence gates`
  - Head: `codex/swarm-torghut-quant`
  - Rechecked because it is the only currently open PR matching the Jangar-impacting inventory search.
  - Not selected for merge: Torghut-scoped, dirty against `main`, over the mandatory large-diff review threshold, and
    still blocked on Codex review capacity.
  - Refreshed anchored Codex progress comment:
    https://github.com/proompteng/lab/pull/5412#issuecomment-4378206627.
- #5767, `chore(release/c3ba60b): automated release PR`, remains open and was not selected; it only updates
  `argocd/applications/app/kustomization.yaml`.
- #5316, `chore(release/735ddbc): automated release PR`, remains open and was not selected; it only updates
  `argocd/applications/docs/kustomization.yaml`.

## Comments And Conflicts

- The stale May 5 selection set is already merged:
  - #5387 merged at 2026-05-05T10:17:03Z as `65e4d54152313a6eddef8ca6ce4f6ca193e23af5`.
  - #5364 merged at 2026-05-05T09:21:18Z as `3726ade1c5c11fd33ecd7a6d273d84128979653d`.
  - #5376 merged at 2026-05-05T09:16:09Z as `3f443891f7f9a4e2058c630e027b69626714cbf6`.
- #5774 was merged with visible checks passing or intentionally skipped: changed-files, semantic PR title, semantic
  commits, `agents-ci / validate`, `agents-ci / integration`, and `jangar-ci / lint-and-typecheck`.
- #5775 was merged with visible checks passing or intentionally skipped: semantic PR title, semantic commits, argo-lint,
  kubeconform, `jangar-ci / lint-and-typecheck`, and `jangar-deploy-automerge / enable`.
- #5412 currently reports `DIRTY` / `CONFLICTING`, with 4,097 additions and 26 deletions. Visible checks on its current
  head are green or skipped, but merge is blocked by conflicts and by the unresolved large-diff Codex review gate.

## Merge Outcomes

- #5774 merged at 2026-05-07T04:31:39Z as `39c27b12595aeaf8b4de2b06627cf51ecf11fba4`.
- #5775 merged at 2026-05-07T04:42:25Z as `6c84303fe49b3dc6e275f6302b0b42cd37d69562`.
- No open Jangar-control-plane PR remained to squash-merge in this pass after #5775 reached `main`.
- #5412 remains open and is no-go until conflicts are resolved and a mandatory Codex review posts with all resulting
  review threads resolved, or a maintainer explicitly waives the large-diff review gate.

## Deployment Evidence

GitOps status from read-only `kubectl` checks:

- `jangar`: Synced, Healthy, revision `6c84303fe49b3dc6e275f6302b0b42cd37d69562`, last operation Succeeded at
  2026-05-07T04:50:22Z.
- `agents`: Synced, Healthy, revision `6c84303fe49b3dc6e275f6302b0b42cd37d69562`, last operation Succeeded at
  2026-05-07T04:46:18Z.

Workload readiness:

- `deployment/jangar` in namespace `jangar`: generation 323 observed, 1/1 ready, 1 updated, 1 available.
- `deployment/agents` in namespace `agents`: generation 176 observed, 1/1 ready, 1 updated, 1 available.
- `deployment/agents-controllers` in namespace `agents`: generation 203 observed, 2/2 ready, 2 updated, 2 available.

Image evidence:

- `jangar`: `registry.ide-newton.ts.net/lab/jangar:39c27b12@sha256:cdfdcb5e829ee93de87320b2912260cc7d025a9924815ec1327d2f99bcbed755`.
- `agents`: `registry.ide-newton.ts.net/lab/jangar-control-plane:39c27b12@sha256:f87519ada87ad62df64d7b923ed9d8a7cb621862c4fa43ecb5691694ecf67e71`.
- `agents-controllers`: `registry.ide-newton.ts.net/lab/jangar:39c27b12@sha256:cdfdcb5e829ee93de87320b2912260cc7d025a9924815ec1327d2f99bcbed755`.

Validation commands:

- `kubectl rollout status -n jangar deployment/jangar --timeout=180s` passed.
- `kubectl rollout status -n agents deployment/agents --timeout=180s` passed.
- `kubectl rollout status -n agents deployment/agents-controllers --timeout=180s` passed.
- `bun run packages/scripts/src/jangar/verify-deployment.ts --require-synced --expected-revision 6c84303fe49b3dc6e275f6302b0b42cd37d69562 --expected-revision-mode exact --health-attempts 3 --health-interval-seconds 2 --digest-attempts 3 --digest-interval-seconds 2` passed.

Control-plane status at 2026-05-07T04:55:52Z:

- Controllers: `agents-controller`, `supporting-controller`, and `orchestration-controller` healthy.
- Database: healthy; migration consistency healthy with 28 registered and 28 applied migrations.
- Watch reliability: healthy over the 15-minute window with 1,477 events, zero errors, and zero restarts.
- Runtime kits and admission passports: verifier confirmed fresh `serving`, `swarm_plan`, and `swarm_implement`
  passports and image digest parity.
- Execution trust: degraded because discover, plan, implement, and verify stage evidence is stale.
- Namespace status: `agents` degraded on `empirical:forecast` and `execution_trust`.

Event notes:

- `jangar` emitted transient readiness warnings during pod startup for the new `jangar-56bdb9885b-dss9q` pod; the final
  pod state is Running and Ready with zero restarts.
- `agents` emitted transient readiness warnings during controller replacement and retained failed pre-promotion schedule
  jobs whose logs cite stale schedule passport/runtime/recovery digests. The current CronJob templates use image tag
  `39c27b12`; their status shows latest successful runs at 2026-05-07T04:51:52Z or 2026-05-07T04:51:53Z, but the
  control-plane status still reports stale stage evidence.
- The `agents` service proxy health checks were blocked by service-account RBAC for `services/proxy` in namespace
  `agents`; the Jangar service proxy health and Jangar control-plane status endpoint were readable.

## Risks And Rollback Path

Risks:

- Deployment rollout is healthy, but runtime authority is held. `execution_trust=degraded` keeps material actions and
  merge/deploy widening in hold or repair-only posture until fresh stage evidence is available.
- #5412 remains a production-risk hold: it is dirty, large, and lacks required Codex review. Do not merge it on green
  checks alone.
- Forecast service evidence is degraded with `registry_empty`; empirical jobs are fresh, but forecast-backed action
  widening remains blocked.

Rollback path:

- If image tag `39c27b12` causes readiness, digest, or control-plane regression, open a GitOps PR reverting #5775 in
  `argocd/applications/jangar/kustomization.yaml`, `argocd/applications/jangar/deployment.yaml`, and
  `argocd/applications/agents/values.yaml`, then let Argo CD reconcile.
- If the source behavior from #5774 is implicated after image rollback, revert #5774 through a normal PR and redeploy
  via the Jangar release workflow.
- Do not drop schema or runtime evidence during rollback; the current risk is runtime trust/evidence freshness, not a
  database migration failure.

## Next Action

Keep the Jangar deployment in production; the GitOps rollout is confirmed. The next release gate is runtime evidence
repair: refresh the Jangar stage evidence until `execution_trust` returns healthy, then re-check material-action receipts
before allowing any deploy widening. Keep #5412 blocked until conflicts and the mandatory Codex review gate are resolved.
