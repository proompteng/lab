# Jangar Control Plane Release Verify - 2026-05-08

Governing requirements:

- Verify stages merge only green PRs and prove Argo sync, workload readiness, and service health after rollout.
- Promotion and rollback must go through GitOps PRs; no production manifest mutation was made from the local shell.
- Large PRs over 1,000 changed lines require a posted Codex review before merge.

## PRs Touched

- #5889, `feat(jangar): add repair warrant exchange`
  - Status: hold.
  - Evidence: mergeable with hosted checks passing, but the diff is 1,639 changed lines.
  - Blocker: repeated `@codex review` requests returned Codex usage-limit comments instead of a posted review.
  - Release decision: do not merge until Codex review capacity is restored or the large-change gate is explicitly changed.
- #6101, `chore(jangar): roll back runtime image to healthy digest`
  - Status: closed as superseded by #6107.
  - Evidence: conflict repair was validated locally, but the PR was closed with the stated reason that #6107 already promoted the fixed image.
  - Release decision: no merge because it would downgrade the live Jangar image from `55ac37c7` to `7a5c2788`.

## Validation Evidence

- `PATH="$HOME/go/bin:$PATH" bun run lint:argocd` in the #6101 repair worktree:
  `Summary: 801 resources found in 629 files - Valid: 346, Invalid: 0, Errors: 0, Skipped: 455`.
- `git diff --check` in the #6101 repair worktree passed.
- Argo CD:
  - `jangar`: `Synced`, `Healthy`, revision `b9457ad091faf47d38c93421941056e1e8da793f`, operation succeeded at `2026-05-08T12:21:58Z`.
  - `symphony-jangar`: `Synced`, `Healthy`, revision `db7c62b1cbe39343909f3a67115f6677cba51a52`.
- Workload readiness:
  - `deployment/jangar` observed generation `365`, ready replicas `1/1`, rollout status succeeded.
  - Live app image and runtime image are `registry.ide-newton.ts.net/lab/jangar:55ac37c7@sha256:8e41233672728ea2d4cf3ef61ce6af22645348641c13af7d63389d39d5e49dd8`.
  - `JANGAR_SOURCE_HEAD_SHA` and `JANGAR_GITOPS_REVISION` are both `55ac37c789d70fead8020eff787aa1b455085f19`.
- Service health:
  - `curl -fsS --max-time 10 http://jangar.jangar.svc.cluster.local/health` returned `{"status":"ok","service":"jangar",...}`.
  - The live Jangar pod was `2/2 Running` with `0` restarts.

## Risk And Rollback

- Residual risk: AgentRun history still shows failures outside the Jangar rollout path. In the latest 30 AgentRuns observed during verification: 16 succeeded, 9 were running, 3 failed, and 2 had not been reconciled to a phase yet.
- Residual risk: Jangar app logs still contain non-fatal snapshot refresh failures for stale or closed PR refs, plus earlier readiness-probe failures from the replaced image.
- Rollback path: open a fresh GitOps PR that reverts `argocd/applications/jangar/deployment.yaml` and `argocd/applications/jangar/kustomization.yaml` to the last healthy digest, then wait for Argo sync and workload health. Do not apply manifests directly from a local shell.

## Next Action

- Keep #5889 held until a Codex review is posted and any review threads are resolved.
- Leave #6101 closed unless the currently healthy `55ac37c7` rollout regresses.
- Continue watching failed AgentRuns as the control-plane metric; the smallest release blocker for this run is missing Codex review capacity on #5889.
