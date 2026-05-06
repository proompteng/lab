# Jangar Control Plane Release Verification

Timestamp: 2026-05-06T17:55:34Z
Repository: `proompteng/lab`
Base: `main`
Release branch: `codex/swarm-jangar-control-plane-verify`
Observed main: `0ca4999af2f521a330a661fbd09473c18b02a0c8`

## Owner Update Message

Merge gate is no-go for #5412. The PR is conflict-free, non-draft, and all visible checks are passing or intentionally
skipped, but it changes 4,239 total lines and there is still no posted Codex review. I refreshed the required review
request on 2026-05-06 at 17:55 UTC; the connector responded with the same Codex code-review usage-limit blocker at
17:57 UTC. I will not squash-merge until a Codex review is posted and every resulting thread is resolved.

The already-merged Jangar rollout is healthy at the GitOps and core workload layer. Argo reports `agents`, `jangar`,
`torghut`, `torghut-options`, `symphony-jangar`, and `symphony-torghut` Synced/Healthy at
`0ca4999af2f521a330a661fbd09473c18b02a0c8`, and the `jangar`, `agents`, and `agents-controllers` deployments all
completed rollout successfully. The active Jangar and agents images are the `eb0d955b` promotion from #5725.

Residual risk: the `agents` namespace still contains historical failed AgentRun pods, and one recent
`torghut-market-context-news-batch` job hit `BackoffLimitExceeded`. Those are not blocking the current Jangar image
rollout because the Argo apps and desired core deployments are healthy, but they are follow-up runtime noise to keep
watching.

Next checkpoint: wait for the #5412 Codex review result, then re-check review threads, required checks, and the
Jangar/Torghut rollout signals before any merge.

## PRs Touched

- #5387, `fix(torghut): restore rollout readiness`, was already merged on 2026-05-05 at 10:17:03 UTC with terminal
  checks passing or skipped.
- #5364, `ci: stabilize agents and jangar checks`, was already merged on 2026-05-05 at 09:21:18 UTC with terminal
  checks passing or skipped.
- #5376, `fix(torghut): restore live jangar dependency quorum`, was already merged on 2026-05-05 at 09:16:09 UTC with
  terminal checks passing or skipped.
- #5725, `chore(jangar): promote image eb0d955b`, merged on 2026-05-06 at 17:46:34 UTC as
  `0ca4999af2f521a330a661fbd09473c18b02a0c8`; this is the current observed main rollout.
- #5412, `feat(torghut): add proof leases and evidence gates`, remains open. I selected it as the only open
  Jangar-adjacent production PR in the queue, confirmed clean merge state and green/skipped checks, posted a fresh
  Codex review request, and did not merge because the large-diff review gate is unresolved.
- #5316, `chore(release/735ddbc): automated release PR`, remains open but only changes the docs Argo application
  kustomization. I did not select it for the Jangar control-plane release lane.

## Comments And Conflicts

- #5412 merge state: `CLEAN`.
- #5412 review threads: none reported by the pull request review-comments API.
- #5412 latest reviews: none.
- #5412 visible check summary: 27 total checks, zero failing, cancelled, or pending; pass/skipped only.
- #5412 diff size: 4,211 additions and 28 deletions, 4,239 total changed lines.
- Required review request refreshed at https://github.com/proompteng/lab/pull/5412#issuecomment-4390638334.
- A concurrent release-gate refresh also requested review at
  https://github.com/proompteng/lab/pull/5412#issuecomment-4390641593.
- The connector responded with Codex code-review usage-limit blockers, latest observed at
  https://github.com/proompteng/lab/pull/5412#issuecomment-4390650614.

## Merge Outcomes

- No new Jangar-impacting PR was squash-merged in this checkpoint.
- #5412 is blocked by policy, not by merge conflicts or failing CI.
- Current production main is already at `0ca4999af2f521a330a661fbd09473c18b02a0c8` from #5725.

## Deployment Evidence

GitOps status from `kubectl get applications.argoproj.io -n argocd agents jangar torghut torghut-options
symphony-jangar symphony-torghut`:

- `agents`: Synced, Healthy, operation phase Succeeded, revision `0ca4999af2f521a330a661fbd09473c18b02a0c8`.
- `jangar`: Synced, Healthy, operation phase Succeeded, revision `0ca4999af2f521a330a661fbd09473c18b02a0c8`.
- `torghut`: Synced, Healthy, operation phase Succeeded, revision `0ca4999af2f521a330a661fbd09473c18b02a0c8`.
- `torghut-options`: Synced, Healthy, operation phase Succeeded, revision
  `0ca4999af2f521a330a661fbd09473c18b02a0c8`.
- `symphony-jangar`: Synced, Healthy, operation phase Succeeded, revision
  `0ca4999af2f521a330a661fbd09473c18b02a0c8`.
- `symphony-torghut`: Synced, Healthy, operation phase Succeeded, revision
  `0ca4999af2f521a330a661fbd09473c18b02a0c8`.

Workload readiness:

- `kubectl rollout status -n jangar deployment/jangar --timeout=120s`: successfully rolled out.
- `kubectl rollout status -n agents deployment/agents --timeout=120s`: successfully rolled out.
- `kubectl rollout status -n agents deployment/agents-controllers --timeout=120s`: successfully rolled out.
- `kubectl get deploy -n jangar jangar symphony-jangar`: `jangar` is 1/1 ready and `symphony-jangar` is 1/1 ready.
- `kubectl get deploy -n agents agents agents-controllers`: `agents` is 1/1 ready and `agents-controllers` is 2/2
  ready.

Image evidence:

- `jangar`: `registry.ide-newton.ts.net/lab/jangar:eb0d955b@sha256:3908c6a1c4e40816a062e3ed86d9f96ab32717255fc89b351c5fec5a76738645`.
- `agents`: `registry.ide-newton.ts.net/lab/jangar-control-plane:eb0d955b@sha256:937bf64464650bcacd9baa3085808631edf04db254ccb0dd4461637695b31f50`.
- `agents-controllers`: `registry.ide-newton.ts.net/lab/jangar:eb0d955b@sha256:3908c6a1c4e40816a062e3ed86d9f96ab32717255fc89b351c5fec5a76738645`.

Event and pod-risk notes:

- Recent Jangar warnings were rollout readiness probe failures on old and new Jangar pods. The active deployment is now
  rolled out and all Jangar namespace pods are Running with no non-Running/non-Succeeded pods reported.
- The `agents` namespace contains historical Error pods from prior scheduled AgentRun attempts.
- A recent `torghut-market-context-news-batch-gwrv9-job` pod is Error and the job reports `BackoffLimitExceeded`. This
  is runtime follow-up risk, but it did not prevent Argo Healthy or core deployment readiness.
- The service account could list deployments, pods, events, jobs, and Argo Applications. It could not list
  statefulsets or daemonsets in `jangar` or `agents`; no direct production mutations were attempted.

## Risks And Rollback Path

Risks:

- #5412 cannot merge until Codex review is posted and all review threads are resolved.
- The repeated Codex usage-limit responses are an external review-capacity blocker.
- Recent AgentRun job errors in `agents` should be watched separately from the core rollout gate.
- If the `torghut-market-context-news-batch` backoff is tied to production market-context freshness, route it to the
  Torghut runtime owner before promoting Torghut-adjacent changes.

Rollback path:

- #5412 has not merged, so no rollback is needed for that PR.
- If the current `eb0d955b` Jangar rollout regresses, revert #5725 or open a generated rollback PR to restore the last
  known-good image digest in `argocd/applications/agents/values.yaml` and `argocd/applications/jangar/`.
- For application behavior regressions from earlier merged fixes, revert the offending merge commit on `main` and let
  Argo CD reconcile. Do not mutate production directly from the local shell.
- Rollback trigger: Argo app health becomes Degraded/Progressing for the Jangar apps, `jangar`/`agents` deployments
  lose ready replicas, or fresh readiness failures coincide with app restarts after the rollout window.

## Next Action

1. Wait for Codex review on #5412 or capture the connector usage-limit response as the blocker.
2. Re-check #5412 reviews, threads, and required checks before any merge.
3. Keep watching the recent `torghut-market-context-news-batch` backoff in `agents`.
4. If #5412 passes the review gate, squash-merge only after checks remain green and then verify Argo and workload
   readiness at the new main revision.
