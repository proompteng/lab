# Jangar Control Plane Release Verification

Timestamp: 2026-05-05T17:27:51Z
Repository: `proompteng/lab`
Base: `main`
Release branch: `codex/swarm-jangar-control-plane-verify`
Current observed main: `3e9f8e98b9b1a1828f516d84d1cfac56b84d8100`

## Owner Update Message

Merge gate is no-go for #5454. The PR is clean against `main` and required checks are green, but it changes
1,542 total lines and the required Codex review has not posted because the connector is still blocked by code-review
usage limits. I did not squash-merge it.

Jangar GitOps rollout is healthy at the Argo/Kubernetes level after the latest Jangar sync. Argo synced `jangar` to
`e65390a0704b25c83da5ef2ea9b2a1ceafd6a9bc`, reported `OutOfSync -> Synced` at 2026-05-05T17:25:10Z, and returned
`Progressing -> Healthy` at 2026-05-05T17:26:09Z. The current Jangar pod is `jangar-7575c9cdf6-26glb`, ready 2/2,
running image `registry.ide-newton.ts.net/lab/jangar:e48d29c9@sha256:f0bec7dfbeea4bbe99c36d9f5a9e327c95bc36e57c0d021bc502e7a603d671aa`.

Next checkpoint is Codex review capacity or an explicit maintainer waiver for #5454, then re-check reviews, required
checks, and rollout health before any merge.

## Gate Decision

No-go for #5454, `feat(jangar): surface failure-domain lease holdbacks`.

Evidence:

- GitHub reports #5454 `mergeable=MERGEABLE` and `mergeStateStatus=CLEAN`.
- `gh pr checks 5454` shows pass/skipped only: `jangar-ci / lint-and-typecheck / run`, `agents-ci / validate`,
  `agents-ci / integration`, semantic PR title, semantic commits, and changed-file checks pass.
- The PR changes 1,538 additions and 4 deletions, so the repo large-diff Codex-review gate applies.
- GraphQL reports zero reviews and zero review threads for #5454.
- `@codex review` was retried at 2026-05-05T17:21:52Z; the connector responded at 2026-05-05T17:22:04Z that
  Codex code-review usage limits are exhausted.
- The #5454 progress comment was refreshed through `services/jangar/scripts/codex/codex-progress-comment.ts`:
  https://github.com/proompteng/lab/pull/5454#issuecomment-4379440176.

Do not merge #5454 until a Codex review is posted and all threads are resolved, or until a maintainer explicitly waives
the large-diff review gate.

## PRs Touched

- #5376, `fix(torghut): restore live jangar dependency quorum`, was already merged at 2026-05-05T09:16:09Z as
  `3f443891f7f9a4e2058c630e027b69626714cbf6`.
- #5364, `ci: stabilize agents and jangar checks`, was already merged at 2026-05-05T09:21:18Z as
  `3726ade1c5c11fd33ecd7a6d273d84128979653d`.
- #5387, `fix(torghut): restore rollout readiness`, was already merged at 2026-05-05T10:17:03Z as
  `65e4d54152313a6eddef8ca6ce4f6ca193e23af5`.
- #5454 remains open and unmerged. I retried the required Codex review, confirmed green checks, confirmed no review
  threads, and refreshed the progress comment.
- #5412, `feat(torghut): add evidence epochs and shared live gate`, remains related but outside the selected Jangar PR
  lane. It is also clean/green and blocked by the same large-diff Codex-review usage-limit condition.
- #5496, `docs(torghut): record quant verify release gate`, merged during this verification window as
  `e65390a0704b25c83da5ef2ea9b2a1ceafd6a9bc`.
- #5513, `fix(jangar): enable nats agent visibility`, merged during this verification window as
  `1352c06bdd59824a420fb14efd55b80e9cc269e7`; Argo reconciled the Jangar application after this change.

## Comments And Conflicts

- #5454 has no merge conflict and no review threads to resolve.
- #5454 has a fresh Codex-review request retry and a fresh connector usage-limit response:
  https://github.com/proompteng/lab/pull/5454#issuecomment-4381502475 and
  https://github.com/proompteng/lab/pull/5454#issuecomment-4381503723.
- No code changes were pushed to #5454 because the active blocker is external review capacity, not a local diff issue.

## Deployment Evidence

Direct Argo Application reads are blocked for this runner:

- `kubectl get applications.argoproj.io -A` is forbidden for `system:serviceaccount:agents:agents-sa`.

Read-only rollout evidence from allowed signals:

- Argo controller logs show Jangar automated sync to `e65390a0704b25c83da5ef2ea9b2a1ceafd6a9bc` at
  2026-05-05T17:25:09Z.
- Argo controller logs show `Sync operation to e65390a0704b25c83da5ef2ea9b2a1ceafd6a9bc succeeded` at
  2026-05-05T17:25:09Z.
- Argo controller logs show `Updated sync status: OutOfSync -> Synced` at 2026-05-05T17:25:10Z.
- Argo controller logs show `Updated health status: Progressing -> Healthy` at 2026-05-05T17:26:09Z.
- `kubectl get pods -n jangar -o wide` shows all Jangar namespace pods Running and ready, including:
  - `jangar-7575c9cdf6-26glb` 2/2, 0 restarts.
  - `bumba-847bf8c449-j4d76` 1/1, 0 restarts.
  - `symphony-jangar-bc667d45c-77v7w` 1/1, 0 restarts.
  - `jangar-db-1` 1/1, 1 restart from earlier in the day.
- `kubectl get pod -n jangar jangar-7575c9cdf6-26glb -o jsonpath=...` confirms the active app image is
  `registry.ide-newton.ts.net/lab/jangar:e48d29c9@sha256:f0bec7dfbeea4bbe99c36d9f5a9e327c95bc36e57c0d021bc502e7a603d671aa`
  and both `app` and `docker` containers are ready with zero restarts.
- `kubectl logs -n jangar pod/jangar-7575c9cdf6-26glb -c app --since=2m | rg ...` returned no matching error,
  panic, fatal, heartbeat, timeout, deadlock, or worktree lines.

Residual runtime notes:

- Recent Jangar events include startup readiness warnings for old and current Jangar pods. The current pod is now ready.
- `jangar-db-1` logged readiness probe 500s and a `workflow_comms.agent_messages` deadlock around 2026-05-05T17:24Z.
  The database pod is currently Running and Ready, so this is a monitor item rather than a rollout failure.

## Risk And Rollback

Residual risks:

- #5454 cannot merge under policy until Codex review capacity is restored or a maintainer waiver is recorded.
- #5412 has the same large-diff review-capacity blocker but is not the selected Jangar PR for this gate.
- The in-cluster service account cannot read Argo Application CRs directly; rollout health had to be proven from Argo
  controller logs and workload readiness.
- Database readiness/deadlock warnings should be watched. They did not prevent Argo Healthy or pod readiness during this
  verification, but they are relevant to operator confidence.

Rollback path:

- #5454 has not merged, so no rollback is needed for that PR.
- For already-merged Jangar changes, revert the offending merge or release-promotion PR on `main` and let Argo CD
  reconcile through GitOps.
- For the current Jangar deployment, rollback is a revert of the image/config change in
  `argocd/applications/jangar/deployment.yaml`, followed by normal PR merge and Argo reconciliation.

## Next Action

Restore Codex code-review capacity or record an explicit maintainer waiver for #5454. After that, re-check:

- GitHub merge state and required checks for #5454.
- Posted Codex review and any review threads.
- Argo sync/health logs for `jangar`.
- Jangar namespace pod readiness and recent warning events.
