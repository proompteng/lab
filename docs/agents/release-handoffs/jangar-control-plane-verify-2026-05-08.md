# Jangar Control Plane Release Handoff - 2026-05-08

Owner update message:

Jangar rollout is healthy at main `02157285492418fff35e70beae53e65ee776f353`. #5412 merged at
2026-05-08T09:57:29Z as `7a5c2788f23fc622760ff11dd7c4fd989e3ed64f`; its main-branch CI is green, #6092/#6093
promoted the Jangar and Torghut images, and post-deploy verification passed. #5889 remains a no-go: it is clean and
green at head `d9809859bd619b004f2f14dcf8acb75ae73aff53`, but it is a 1,639-line direct-control-plane diff with no
posted Codex review because the connector still returns the account usage-limit blocker.

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
  - Current head: `d9809859bd619b004f2f14dcf8acb75ae73aff53`.
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
  https://github.com/proompteng/lab/pull/5889#issuecomment-4405559488. Latest connector blocker:
  https://github.com/proompteng/lab/pull/5889#issuecomment-4405560890.
- No production manifests were manually applied from this shell.

## Checks

- #5412 main commit `7a5c2788f23fc622760ff11dd7c4fd989e3ed64f` passed `Docker Build and Push`,
  `torghut-build-push`, `torghut-ci`, `jangar-build-push`, and `agents-ci`; `agents-ci / integration` completed at
  2026-05-08T10:26:02Z.
- #6092 `jangar-post-deploy-verify` run `25549824671` passed.
- #6093 `torghut-ci`, `torghut-post-deploy-verify`, `argo-lint`, and `kubeconform` passed.
- #5889 hosted checks pass or skip intentionally: `CI / check_changed_files`, semantic title and commit checks,
  `agents-ci / validate`, `agents-ci / integration`, and `jangar-ci / lint-and-typecheck / run`.

## Deployment Evidence

- Argo: `argocd/jangar`, `argocd/agents`, `argocd/symphony-jangar`, `argocd/agents-ci`, `argocd/torghut`,
  `argocd/symphony-torghut`, and `argocd/torghut-options` are `Synced`, `Healthy`, operation `Succeeded`, revision
  `02157285492418fff35e70beae53e65ee776f353`.
- Rollouts: `deployment/jangar`, `deployment/agents`, `deployment/agents-controllers`,
  `deployment/symphony-jangar`, and `deployment/symphony-torghut` all report successful rollout.
- Active Jangar images:
  - `deployment/jangar` and `deployment/agents-controllers`:
    `registry.ide-newton.ts.net/lab/jangar:7a5c2788@sha256:2c455fdbd3accf2dfadaf525e463ad6b23261ec4cbcb00dbaa70c16882d5a5df`.
  - `deployment/agents`:
    `registry.ide-newton.ts.net/lab/jangar-control-plane:7a5c2788@sha256:203c8009b3c559fdf32a123a3978ec77fc0fe641ed163f1cedae0e9045d04674`.
- Torghut active routeable deployments are on digest
  `sha256:dbd4b1b267f2387aeecf7e3f3f242b8630b7fdddb7f2a69f4c827a7069ae6afa`.
- Service health: Jangar `/health` returned `status=ok`; Symphony `/readyz` returned `ok=true`.
- Control-plane status: controller authority is healthy, database is connected, and migration consistency is healthy
  with 28 registered and 28 applied migrations.
- Event review: recent Jangar, Agents, and Torghut warnings are startup readiness probes that cleared after replacement
  pods became ready. Torghut still has unrelated PodDisruptionBudget selection warnings.

## Metrics And Risk

- `failed_agentrun_rate`: since 2026-05-08T00:00Z, matching Jangar control-plane AgentRuns show 35 total, 34
  succeeded, 1 running, and 0 failed.
- `ready_status_truth`: Argo, rollout status, pod readiness, endpoints, service health, controller authority, database
  health, migration state, and image digests agree for the deployed baseline.
- `manual_intervention_count`: zero production workload mutations from this shell.
- `pr_to_rollout_latency`: improved for #5412/#6092/#6093 because merge-to-healthy GitOps rollout is now proven;
  blocked for #5889 by Codex review capacity.
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
