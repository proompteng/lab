# Torghut quant verifier release gate - 2026-05-06

Release engineer: Julian Hart
Repository: `proompteng/lab`
Branch: `codex/swarm-torghut-quant-verify`
Base: `main`
Owner channel: `swarm://owner/trading`

## Owner update message

I merged PR #5635, then picked up and verified PR #5638 after #5637 created a newer Torghut image
promotion. Argo CD has `torghut` and `torghut-options` Synced/Healthy at rollout revision
`a458b1a93ac7893e1a1caf7d2b551ed64df5949e`, which contains the #5638 squash merge
`540e03c0fee508e3d0d580892f9cc9b23cfec86c`. Torghut, Torghut Sim, options catalog, and options
enricher are rolled out on promoted image digest
`sha256:9e4146a183a6e73567f0005e3990a7f50aa4f9b3bdbcf8e37cfbf959c647a2d0`. PR #5412 remains a
release no-go because the large-diff Codex review has not posted; live Torghut capital also remains
business-gated in shadow with `/readyz` returning 503 for `simple_submit_disabled`, while root
liveness and simulation readiness are healthy.

## Decision

Gate decision: go for merged PRs #5635 and #5638 rollouts; no-go for PR #5412.

PR #5635, `chore(torghut): promote image facb4325`, was the selected unblock-first release PR. It
was small, conflict-free, Torghut-scoped, and all visible checks were pass or skipped before merge.
I updated its PR body from the repository template, posted the anchored progress comment, waited for
the refreshed semantic checks to pass, then squash-merged it at 2026-05-06T06:57:46Z.

PR #5638, `chore(torghut): promote image 8a130c30`, opened after #5637 merged during rollout
verification. It was also small, conflict-free, Torghut-scoped, and green before merge. I updated its
PR body from the repository template, posted the anchored progress comment, waited for the refreshed
semantic checks to pass, then confirmed it squash-merged at 2026-05-06T07:12:18Z.

PR #5412, `feat(torghut): add evidence epochs and shared live gate`, stayed open. GitHub reported it
mergeable with green visible checks at head `d7eb2f1dbe5855209d8fd27a78bbadfe8fc4fc94`, but the
change set is 3,138 additions and 27 deletions across 20 files. The required large-diff Codex review
has not posted; the latest request returned the Codex connector usage-limit blocker. I refreshed the
anchored progress comment and did not merge it.

## PRs touched

- #5412: progress comment updated with current no-go evidence. No conflicts or review threads were
  present. Merge held on missing large-diff Codex review.
- #5635: body updated to the repository PR template, progress comment created, semantic checks
  revalidated, and PR squash-merged.
- #5638: body updated to the repository PR template, progress comment created, semantic checks
  revalidated, and PR squash-merged.
- #5637: not selected or modified by this run. It merged independently during rollout verification;
  it created #5638.
- #5639: not selected or modified by this run. It merged independently during #5638 rollout
  verification; rollout revision `a458b1a93ac7893e1a1caf7d2b551ed64df5949e` contains #5638.
- #5640: not selected or modified by this run. It merged documentation after #5638 and did not
  create another Torghut image promotion PR.

## Comments and conflicts

- #5412: no conflicts, zero reviews, zero review threads. Progress comment now states no-go until
  Codex large-diff review posts and any resulting threads are resolved, or a maintainer explicitly
  waives the gate.
- #5635: no conflicts, no review threads. Progress comment records the go decision, promoted source
  commit, image digest, checks, and rollback path.
- #5638: no conflicts, no review threads. Progress comment records the go decision, promoted source
  commit, image digest, checks, and rollback path.

## Merge outcomes

- #5412: held, not merged.
- #5635: merged by squash at merge commit `62d9fc8722be0403a9b57f22e73667dc018e9b47`.
- #5638: merged by squash at merge commit `540e03c0fee508e3d0d580892f9cc9b23cfec86c`.

## Validation

PRs #5635 and #5638 GitHub checks before merge:

- PASS: `torghut-ci / Pyright`
- PASS: `torghut-ci / Bytecode + pytest + coverage`
- PASS: `torghut-ci / Quality signals (complexity + security)`
- PASS: `argo-lint / lint`
- PASS: `kubeconform / validate`
- PASS: `Semantic Pull Request / Validate PR title`
- PASS: `Semantic Commits / Lint commit messages`
- PASS: `torghut-deploy-automerge / enable`

Progress and PR metadata:

- PASS: #5635 body placeholder scan before `gh pr edit`
- PASS: #5638 body placeholder scan before `gh pr edit`
- PASS: #5412 progress comment updated with `services/jangar/scripts/codex/codex-progress-comment.ts`
- PASS: #5635 progress comment created with `services/jangar/scripts/codex/codex-progress-comment.ts`
- PASS: #5638 progress comment created with `services/jangar/scripts/codex/codex-progress-comment.ts`

## Deployment evidence

GitOps state after merge:

- `kubectl get applications.argoproj.io -n argocd torghut torghut-options -o json`
  - `torghut`: `Synced`, `Healthy`, revision `a458b1a93ac7893e1a1caf7d2b551ed64df5949e`, operation
    `Succeeded`, message `successfully synced (no more tasks)`.
  - `torghut-options`: `Synced`, `Healthy`, revision `a458b1a93ac7893e1a1caf7d2b551ed64df5949e`,
    operation `Succeeded`, message `successfully synced (all tasks run)`.
- The sync result for `torghut` shows the PreSync `torghut-db-migrations` hook succeeded on image
  `registry.ide-newton.ts.net/lab/torghut@sha256:9e4146a183a6e73567f0005e3990a7f50aa4f9b3bdbcf8e37cfbf959c647a2d0`.
- The sync result for `torghut` shows Knative Services `torghut` and `torghut-sim` healthy on the
  same promoted digest.
- The sync result for `torghut-options` shows deployments `torghut-options-catalog` and
  `torghut-options-enricher` applied on the same promoted digest.

Workload readiness:

- PASS: `kubectl rollout status -n torghut deployment/torghut-00233-deployment --timeout=60s`
- PASS: `kubectl rollout status -n torghut deployment/torghut-sim-00314-deployment --timeout=60s`
- PASS: `kubectl rollout status -n torghut deployment/torghut-options-catalog --timeout=60s`
- PASS: `kubectl rollout status -n torghut deployment/torghut-options-enricher --timeout=60s`
- Current ready replicas:
  - `torghut-00233-deployment`: `1/1`, promoted digest.
  - `torghut-sim-00314-deployment`: `1/1`, promoted digest.
  - `torghut-options-catalog`: `1/1`, promoted digest.
  - `torghut-options-enricher`: `1/1`, promoted digest.

Runtime probes:

- PASS: `curl http://torghut.torghut.svc.cluster.local/healthz` returned
  `{"status":"ok","service":"torghut"}`.
- PASS: `curl http://torghut.torghut.svc.cluster.local/` returned `status=ok`,
  `version=v0.568.5-137-g8a130c304`, and commit
  `8a130c3047a48c60c5c8bd96c3d8aeee95b9ac7c`.
- PASS: `curl http://torghut-sim.torghut.svc.cluster.local/readyz` returned `status=ok`.
- RESIDUAL: `curl http://torghut.torghut.svc.cluster.local/readyz` returned 503 with
  `status=degraded`, `live_submission_gate.reason=simple_submit_disabled`,
  `capital_stage=shadow`, and healthy Postgres, ClickHouse, Alpaca, database schema, and Jangar
  universe checks. This is a business gate, not a failed image rollout.
- RESIDUAL: `curl http://torghut.torghut.svc.cluster.local/api/torghut/trading/control-plane/quant/health`
  returned 404 on this promoted image. PR #5412 would add that typed endpoint, but #5412 was not
  merged.

Events:

- Torghut namespace events showed expected rollout transitions: migration job completion, new
  Knative revisions `torghut-00233` and `torghut-sim-00314`, VirtualService updates, and PostSync
  jobs completing.
- Warnings during rollout were startup/readiness probe failures on new pods before readiness and
  readiness failures on old pods during scale-down. The current promoted deployments are rolled out
  and ready.

RBAC note:

- The verifier service account could read Argo Applications, Deployments, Pods, Jobs, Logs, and
  Events. It could not list Knative Service resources or StatefulSets directly, so Argo health and
  generated Deployment readiness were the authoritative read-only sources for those controllers.

## Risk

- #5412 remains the main release risk. It changes live-gate and evidence-receipt behavior and is
  above the 1,000-line review threshold, so it remains blocked until Codex review capacity is
  restored or a maintainer waives the gate.
- #5635 was successfully superseded by #5638. The current #5638 rollout is healthy at the GitOps and
  workload layer, but live capital remains shadow-blocked by `simple_submit_disabled`. Do not
  interpret the image rollout as live capital enablement.
- The promoted image does not include the typed quant-health route expected by #5412; that 404 is
  expected while #5412 stays unmerged.

## Rollback path

- For #5638: open a follow-up GitOps PR reverting the Torghut image tag/digest changes to the
  previous promoted digest, then let Argo CD reconcile. Do not apply direct production mutations
  outside an emergency.
- Rollback triggers: Argo app moves to Degraded/OutOfSync and does not self-heal, promoted
  deployments crash loop, migration hook fails, sustained readiness failures appear on the current
  promoted revisions, or trading root/health endpoints regress.
- For #5412: no runtime rollback action is needed because it was not merged. Keep live-promotion
  flags disabled and keep the PR held until review threads, if any, are resolved.

## Next action

Keep #5412 open and blocked on the Codex large-diff review gate. Re-request Codex review when quota
is restored, resolve any review threads, refresh against current main, wait for all checks to pass on
the final head, then squash-merge and repeat the same Argo/workload/event verification.
