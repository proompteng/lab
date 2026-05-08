# Jangar Control Plane Release Handoff - 2026-05-08

Owner update message:

Merge gate remains no-go for #5889. It is clean and mergeable at head
`c8164ef2bb9e3bc7f19ae05ad7ecafc374fe9ba1`, and the current `gh pr checks` view is pass or intentionally skipped, but
the PR is a 1,639-line direct-control-plane diff with no posted Codex review. The latest current-head review request
at https://github.com/proompteng/lab/pull/5889#issuecomment-4406651322 received the usage-limit response at
https://github.com/proompteng/lab/pull/5889#issuecomment-4406652965 instead of a review. Jangar and agents are healthy
on the live baseline: Argo reports `jangar` Synced/Healthy at `370622b6755b955c1edf4e0e59b64572083f9e3f` and
`agents` Synced/Healthy at `74befb03e6df84d62b53f5732e0bcc6b90ef52d8`; the watched deployments rolled out; current
pods are Ready; and AgentRuns created in the last two hours show 35 total, 32 succeeded, 3 running, and 0 failed.

## PRs Touched

- #5412 `feat(torghut): add profit escrow runtime projections`
  - Merged by `gregkonush` at 2026-05-08T09:57:29Z.
  - Merge commit: `7a5c2788f23fc622760ff11dd7c4fd989e3ed64f`.
  - Merged head: `33c711fe3ed5ceb868d44bc516b893948c41b37a`.
  - Progress comment refreshed:
    https://github.com/proompteng/lab/pull/5412#issuecomment-4404049669.
- #6092 `chore(jangar): promote image 7a5c2788`
  - Merged at 2026-05-08T10:09:16Z as `5bbe0f360738a011d4644e306ee947dc70385882`.
  - `jangar-post-deploy-verify` run `25549824671` passed.
- #6093 `chore(torghut): promote image 8a01e3d2`
  - Merged at 2026-05-08T10:09:19Z as `8d4afcbcdb8b0e74b1cd7c3f731bd9c5d403319d`.
  - `torghut-ci`, `torghut-post-deploy-verify`, `argo-lint`, and `kubeconform` passed.
- #6091 `chore(torghut): promote image 7a5c2788`
  - Closed unmerged at 2026-05-08T10:15:48Z after #6093 superseded it.
- #6090 `docs(jangar): refresh control plane release gate`
  - Audit PR merged at 2026-05-08T10:00:38Z as `7488d10a5f42adbc91445aee7c4ceb3b65251dcc`.
  - Superseded by this correction because #5412 and the image promotions moved after #6090 was prepared.
- #5889 `feat(jangar): add repair warrant exchange`
  - Current head: `c8164ef2bb9e3bc7f19ae05ad7ecafc374fe9ba1`.
  - Progress comment refreshed:
    https://github.com/proompteng/lab/pull/5889#issuecomment-4398288855.
  - Merge decision: no-go. The PR is clean and green, but it exceeds the mandatory large-diff Codex review gate and no
    Codex review has posted.

## Comments And Conflicts

- #5412 had zero posted reviews and zero review threads when it merged. It was over the large-diff gate at 8,203
  additions and 737 deletions. The latest connector response before merge was the Codex usage-limit blocker; a
  maintainer waiver comment exists at https://github.com/proompteng/lab/pull/5412#issuecomment-4405085130. I did not
  merge #5412.
- #5889 has zero posted reviews and zero review threads. Latest current-head Codex review request:
  https://github.com/proompteng/lab/pull/5889#issuecomment-4406651322. Latest connector blocker:
  https://github.com/proompteng/lab/pull/5889#issuecomment-4406652965.
- No production manifests were manually applied from this shell.

## Checks

- #5412 main commit `7a5c2788f23fc622760ff11dd7c4fd989e3ed64f` passed `Docker Build and Push`,
  `torghut-build-push`, `torghut-ci`, `jangar-build-push`, and `agents-ci`; `agents-ci / integration` completed at
  2026-05-08T10:26:02Z.
- #6092 `jangar-post-deploy-verify` run `25549824671` passed.
- #6093 `torghut-ci`, `torghut-post-deploy-verify`, `argo-lint`, and `kubeconform` passed.
- #5889 hosted checks pass or skip intentionally: `CI / check_changed_files`, semantic title and commit checks,
  `agents-ci / validate`, `agents-ci / integration`, and `jangar-ci / lint-and-typecheck / run`.
- Raw check-run history for the current head still includes two superseded cancelled semantic jobs. The merge gate is
  closed regardless because the large-diff Codex review has not posted.

## Deployment Evidence

- Argo: `argocd/jangar` is `Synced`, `Healthy`, operation `Succeeded`, revision
  `370622b6755b955c1edf4e0e59b64572083f9e3f`; `argocd/agents` is `Synced`, `Healthy`, operation `Succeeded`, revision
  `74befb03e6df84d62b53f5732e0bcc6b90ef52d8`.
- Rollouts: `deployment/jangar`, `deployment/agents`, and `deployment/agents-controllers` all report successful
  rollout.
- Active Jangar images:
  - `deployment/jangar`:
    `registry.ide-newton.ts.net/lab/jangar:fa3d104c@sha256:e4fda889861d807265ca5638218431f8ad841bf08b54f8482bf73e43b8d71bf2`.
  - `deployment/agents-controllers`:
    `registry.ide-newton.ts.net/lab/jangar:fa3d104c@sha256:e4fda889861d807265ca5638218431f8ad841bf08b54f8482bf73e43b8d71bf2`.
  - `deployment/agents`:
    `registry.ide-newton.ts.net/lab/jangar-control-plane:fa3d104c@sha256:db357ea8ffa64343957d6675513da9fa78c515823fb88cc26cc7f4c11e1c81c2`.
- Pod readiness: `jangar-77c49fd877-t4vcg` is `2/2 Running`; `agents-5b8d56c6f6-78nhr` is `1/1 Running`;
  both `agents-controllers` pods are `1/1 Running`.
- Services: `service/jangar` has endpoint `10.244.5.136:8080`; `service/agents`, `service/agents-grpc`, and
  `service/agents-metrics` have endpoints on the current agents pod.
- Access limitation: direct pod exec is forbidden for `system:serviceaccount:agents:agents-sa`, so this pass did not
  perform an in-pod curl. Readiness evidence comes from Argo sync, rollout status, readiness probes, endpoints, and
  event review.
- Event review: recent Jangar and Agents warnings are startup readiness probes from replacement rollouts that are
  cleared by current rollout status. Remaining recent warnings include unrelated Torghut scheduling delays.

## Metrics And Risk

- `failed_agentrun_rate`: AgentRuns created in the last two hours show 35 total, 32 succeeded, 3 running, and
  0 failed.
- `ready_status_truth`: Argo, rollout status, pod readiness, Services/EndpointSlices, and event review agree for the
  deployed baseline; service-account exec limits are recorded as an evidence limitation.
- `manual_intervention_count`: zero production workload mutations from this shell.
- `pr_to_rollout_latency`: no new direct Jangar PR merged in this refresh because #5889 is held by Codex review
  capacity.
- `handoff_evidence_quality`: progress comments, repo rollout doc, release handoff, mission ledger, and swarm verify
  file carry the same gate evidence.
- Residual risk: #5889 remains open and direct-control-plane relevant, but it is not live. Main has moved after
  #5889's last runtime check run, so any future merge attempt needs a fresh rebase/recheck after the review gate clears.

## Rollback Path

- For the #5412 rollout, revert merge commit `7a5c2788f23fc622760ff11dd7c4fd989e3ed64f` through a normal PR or
  promote the previous Torghut/Jangar images through the normal release PR and GitOps path.
- For the current Jangar image, open a normal GitOps revert PR to restore the previous promoted image if health
  regresses.
- #5889 has no runtime rollback from this pass because it did not merge.
- No direct production mutation should be used for normal rollback.

## Next Action

Keep #5889 held until Codex review capacity is restored, a current-head Codex review posts, all threads are resolved,
and the branch is refreshed and rechecked on current main.
