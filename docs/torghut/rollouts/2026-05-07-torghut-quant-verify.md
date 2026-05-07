# Torghut quant verifier release gate - 2026-05-07

Release engineer: Julian Hart
Repository: `proompteng/lab`
Branch: `codex/swarm-torghut-quant-verify`
Base: `main`
Owner channel: `swarm://owner/trading`
Last refreshed: 2026-05-07T18:12:00Z

## Owner update message

Torghut rollout gate is go at main `7b7673a30a342b54085fa35f90f7d3e0338d3e6b` (#5932).
PR #5931 merged the flat TA quote ingestion fix, and the automatic promotion PR #5932 moved the
runtime image to digest
`sha256:da08c6f6f976f1f9495435de56f63937578f5da7a79b627c831098cc550044d5`.

Current-main checks are green, including Torghut CI, kubeconform, argo-lint, and
`torghut-post-deploy-verify`. Argo CD shows both `torghut` and `torghut-options` `Synced` /
`Healthy` at `7b7673a30a342b54085fa35f90f7d3e0338d3e6b`. Live and sim TA ConfigMaps both carry
`TA_QUOTE_STALE_AFTER_MS=15000`, and the live, sim, catalog, enricher, TA, TA-sim, options TA, and
websocket workloads are ready with zero restarts on their current pods.

#5412 remains no-go. It is still above the mandatory large-diff Codex review threshold and no
successful Codex review has posted. It must not merge until that review posts, review threads are
resolved, merge state is refreshed, and fresh required checks pass.

## Open PR enumeration

- #5931, `fix(torghut): preserve executable flat quotes`, was the high-impact unblock. It was a
  small Torghut code/config fix, had no review threads, passed visible required checks, and was
  below the 1000-line mandatory Codex review threshold.
- #5932, `chore(torghut): promote image abaaf775`, was the automatic image promotion for #5931. It
  merged after #5931 and became the active rollout gate.
- #5412, `feat(torghut): add renewal bond profit escrow`, remains open and no-go because the large
  diff still lacks the required Codex review. Visible checks were refreshed after main advanced, but
  ticket/check state is not enough to override the missing review gate.
- #5933, `docs(jangar): record release gate blocker`, is Jangar-scoped and outside this Torghut
  release gate.

## PRs touched

- #5918 `feat(torghut): add route reacquisition book`
  - Added regression coverage for route reacquisition repair branches.
  - Squash-merged at `f65301040fb055abf4d0e277fbfe98ebe2d5b2ca`.
- #5910 `fix(torghut): reject stale TA quotes`
  - Added quote-quality regression coverage.
  - Squash-merged at `3300ed68d642b2178bcedeef58a66bf9adc82526`.
- #5920 `chore(torghut): promote ws image 0333e762`
  - Squash-merged at `495239359bf79921223195785b18e97e3eb99631`.
  - Websocket workload remains ready on spec digest
    `sha256:67f4c169ac4bc80e2649902eda8763ad3545a675d11ec0d134820d009704566b`.
- #5921 `chore(torghut-options): promote ta image 0333e762`
  - Squash-merged at `57b2f2f21d71798288df40459fc0a6ee8e6d0154`.
  - Options TA remains ready on spec digest
    `sha256:c1c7b8556683d05f4f3847d82e95e7fc93de31a32624adf4300a04a435c7683d`.
- #5922 `chore(torghut): promote image 5d072a62`
  - Squash-merged at `23d1668522dcfe89fe31b7bad3352940b1dd8952`; superseded by later Torghut
    promotions.
- #5923 `chore(torghut): promote image 3300ed68`
  - Squash-merged at `585e5f3b4120e5eb95ba4dd00d0dab327ed7816a`; superseded by later Torghut
    promotions.
- #5924 `chore(torghut): promote live ta image 3300ed68`
  - Squash-merged at `a42f6ee4641f052c8951455c7788102770dcc5b6`.
  - Live TA remains ready on spec digest
    `sha256:e22e7fb47921db61f749006c5ebde0eb8c12c1b9f9fe24db3f8f739745f9bad2`.
- #5929 `feat(torghut): rank route reacquisition repairs`
  - Squash-merged at `1b4e860a488b9038d9f29c688a3c900f9644e49b`.
  - Added ranked route repair behavior and tests.
- #5930 `chore(torghut): promote image 1b4e860a`
  - Squash-merged at `3675674d7089bb8d1e942e160505e9b72090dc70`; superseded by #5932 after
    #5931 built.
- #5931 `fix(torghut): preserve executable flat quotes`
  - Selected as the final high-impact unblock.
  - Squash-merged at `abaaf77572f6c9c53c8b8b6f61409e87235b5c19`.
- #5932 `chore(torghut): promote image abaaf775`
  - Final production promotion, squash-merged at `7b7673a30a342b54085fa35f90f7d3e0338d3e6b`.
- #5412 `feat(torghut): add renewal bond profit escrow`
  - Rechecked status, review state, and large-diff gate.
  - Held no-go at `539180cd0ef3e21c32e4dcd10f31dbd4f2f8da09`.
- This audit branch refreshed this rollout note and
  `/workspace/.agentrun/swarm/torghut-quant-verify.md`.

## Comments and conflicts resolved

- No selected merged PR had unresolved review threads at the time it merged or was verified.
- #5918 and #5910 had follow-up test commits pushed before merge.
- #5931 had no review threads. Its anchored Codex progress comment recorded that the rollout gate
  moved to the automatic promotion.
- #5932 had no review comments. Main CI and rollout were verified after the merge before declaring
  the release go.
- #5412 had no review threads in the GitHub review-thread query, but it remains no-go because the
  mandatory Codex review did not post. Prior Codex review requests were answered by the connector
  usage-limit response.
- Progress comments were refreshed for active release-gate PRs. The helper script
  `services/jangar/scripts/codex/codex-progress-comment.ts` was attempted first; GitHub REST writes
  were rate-limited during closeout, so the final #5412/#5932 comment writes used GitHub GraphQL with
  the same `<!-- codex:progress -->` anchor.
- No production workloads were mutated directly from the local shell. Promotion occurred through PR
  merge and Argo CD reconciliation.
- Live release updates were published through `/usr/local/bin/codex-nats-publish --publish-general`.

## Merge outcomes

- Merged source fixes: #5918, #5910, #5929, #5931.
- Merged image/config promotions: #5920, #5921, #5922, #5923, #5924, #5930, #5932.
- Not merged: #5412.

#5931 merged:

- PR: https://github.com/proompteng/lab/pull/5931.
- Title: `fix(torghut): preserve executable flat quotes`.
- Merge commit: `abaaf77572f6c9c53c8b8b6f61409e87235b5c19`.
- Change: preserved flat `imbalance_bid_px` / `imbalance_ask_px` fields, added flat
  `imbalance_spread` normalization, and raised TA quote freshness to 15000 ms in GitOps manifests.
- PR checks passed before merge: Torghut Pyright, Bytecode + pytest + coverage, Quality signals,
  argo-lint, kubeconform, changed-file check, and semantic checks.

#5932 merged:

- PR: https://github.com/proompteng/lab/pull/5932.
- Title: `chore(torghut): promote image abaaf775`.
- Merge commit: `7b7673a30a342b54085fa35f90f7d3e0338d3e6b`.
- Promoted digest:
  `sha256:da08c6f6f976f1f9495435de56f63937578f5da7a79b627c831098cc550044d5`.
- The #5931 post-deploy verifier was cancelled after #5932 superseded it; #5932 became the active
  gate and its current-main verifier passed.

#5412 remains no-go:

- PR: https://github.com/proompteng/lab/pull/5412.
- Head branch: `codex/swarm-torghut-quant`.
- Size: 5,921 additions and 455 deletions at latest inspection.
- Gate: no successful Codex review is posted; do not merge until review and any resulting threads
  are resolved.

## Validation

- PASS: Read NATS context before action via `.codex-nats-context.json` and raw NATS context checks.
- PASS: Published live release updates through `/usr/local/bin/codex-nats-publish --publish-general`.
- PASS: `python3 -m py_compile services/torghut/app/trading/route_reacquisition.py
services/torghut/tests/test_route_reacquisition.py`.
- PASS: `python3 -m py_compile services/torghut/app/trading/quote_quality.py
services/torghut/tests/test_quote_quality.py`.
- PASS: `git diff --check` in the #5918 and #5910 worktrees before pushing follow-up tests.
- PASS: `gh pr checks 5931 -R proompteng/lab --watch --interval 10`.
- PASS: GitHub GraphQL review-thread checks for #5931 and #5412 returned no review threads.
- PASS: GitHub GraphQL status rollup for `7b7673a30a342b54085fa35f90f7d3e0338d3e6b` returned
  `SUCCESS`; green checks included `torghut-ci`, `kubeconform`, `argo-lint`, and
  `torghut-post-deploy-verify`.
- PASS: main `7b7673a` checks: argo-lint run `25513190781`, kubeconform run `25513190682`,
  torghut-ci run `25513190689`, and torghut-post-deploy-verify run `25513190873`.
- PASS: `bun run lint:argocd` after installing the CI-pinned `kubeconform v0.7.0`.
- PASS: `kubectl kustomize --enable-helm argocd/applications/torghut` rendered
  `TA_QUOTE_STALE_AFTER_MS: "15000"` for both TA ConfigMaps.
- PASS: `kubectl wait application/torghut -n argocd --for=jsonpath='{.status.health.status}'=Healthy`.
- PASS:
  `kubectl wait application/torghut-options -n argocd --for=jsonpath='{.status.sync.revision}'=7b7673a30a342b54085fa35f90f7d3e0338d3e6b`.
- PASS: `kubectl wait job/torghut-db-migrations -n torghut --for=condition=complete`.
- PASS: `kubectl get applications -n argocd torghut torghut-options -o wide`.
- PASS: `kubectl get pods -n torghut -o wide`.
- PASS: `git diff --check`.

## Deployment evidence

- `torghut`: `Synced` / `Healthy` at revision `7b7673a30a342b54085fa35f90f7d3e0338d3e6b`, operation
  phase `Succeeded`, message `successfully synced (no more tasks)`.
- `torghut-options`: `Synced` / `Healthy` at revision
  `7b7673a30a342b54085fa35f90f7d3e0338d3e6b`, operation phase `Succeeded`, message
  `successfully synced (all tasks run)`.
- `torghut-ta-config`: `TA_QUOTE_STALE_AFTER_MS=15000`.
- `torghut-ta-sim-config`: `TA_QUOTE_STALE_AFTER_MS=15000`.
- `torghut-00276-deployment-86cbf6d59c-6486g`: Running, ready `true,true`, zero restarts, Torghut
  digest `sha256:da08c6f6f976f1f9495435de56f63937578f5da7a79b627c831098cc550044d5`.
- `torghut-sim-00376-deployment-f8bcd59b9-jbw7j`: Running, ready `true,true`, zero restarts, same
  Torghut digest.
- `torghut-options-catalog-57c548878d-p4ddw`: Running, ready `true`, zero restarts, same Torghut
  digest.
- `torghut-options-enricher-78b8dd8d69-l677m`: Running, ready `true`, zero restarts, same Torghut
  digest.
- `torghut-ta-68bbdcd87b-4fcpn`: Running, ready `true`, zero restarts, live TA digest
  `sha256:e22e7fb47921db61f749006c5ebde0eb8c12c1b9f9fe24db3f8f739745f9bad2`.
- `torghut-ta-sim-598655766-rmd4t`: Running, ready `true`, zero restarts, TA sim digest
  `sha256:20fe1818a7c5239d58d4e3888804163025b9b3b2ee1a1674fd7db77007f682af`.
- `torghut-options-ta-db9b6984f-mf578`: Running, ready `true`, zero restarts, options TA digest
  `sha256:c1c7b8556683d05f4f3847d82e95e7fc93de31a32624adf4300a04a435c7683d`.
- `torghut-ws-6f54db9949-qcgpf` and `torghut-ws-options-848bfc58d4-d64q5`: Running, ready `true`,
  zero restarts, websocket spec digest
  `sha256:67f4c169ac4bc80e2649902eda8763ad3545a675d11ec0d134820d009704566b`.

Event evidence:

- New Knative revisions `torghut-00276` and `torghut-sim-00376` became ready.
- The `torghut-db-migrations` hook completed.
- `torghut-empirical-jobs-backfill`, `torghut-whitepaper-semantic-backfill`, and
  `torghut-whitepapers-bootstrap` completed during the final sync.
- TA and TA-sim Flink deployments moved through `RECONCILING` / `INITIALIZING` / `CREATED` to
  `RUNNING`.
- Transient startup/readiness and mount warnings occurred during pod replacement and cleared. The
  final workload state is ready with zero restarts.

## Risks

- #5412 remains the main open Torghut code risk. It must stay unmerged until the large-diff Codex
  review gate is satisfied.
- Codex review requests for #5412 are currently blocked by Codex review usage limits.
- The TA-sim ConfigMap has an ApplicationSet ignore rule for `/data`; the final rollout did apply
  the 15000 ms value during the #5932 sync, but future data-only sim ConfigMap changes should be
  checked explicitly in-cluster.
- Pre-existing failed historical jobs, including the older
  `torghut-whitepaper-autoresearch-profit-target-8r6w6` pod, remain non-blocking residual noise for
  this rollout because current Torghut workloads and the post-deploy verifier are green.
- Recurring ClickHouse PDB and Flink external-status warnings predate this rollout and did not block
  the verified Torghut workloads.
- #5931 changed TA quote freshness behavior. Watch live and sim TA quote age after rollout; rollback
  is GitOps-only.

## Rollback path

- For #5932: open a GitOps PR reverting `7b7673a30a342b54085fa35f90f7d3e0338d3e6b`, or restore the
  previous Torghut image digest
  `sha256:ad28c58749e5d2015f5ba4bd72bab64919963cc2d208a846a9ef047726950fb4` in the affected
  manifests, then let Argo CD reconcile.
- For #5931: open a GitOps PR reverting `abaaf77572f6c9c53c8b8b6f61409e87235b5c19`, or set
  `TA_QUOTE_STALE_AFTER_MS` back to `2000` in `argocd/applications/torghut/ta/configmap.yaml` and
  `argocd/applications/torghut/ta-sim/configmap.yaml`, then let Argo CD reconcile.
- For #5929/#5930: revert source commit `1b4e860a488b9038d9f29c688a3c900f9644e49b`, rebuild, and
  promote through the normal release PR path.
- For #5412: no rollback is required because it was not merged and no production rollout occurred.

## Next action

Keep #5412 blocked until Codex review posts and all resulting threads are resolved. Continue
watching TA quote-quality admission, flat quote ingestion, route repair evidence, and the TA-sim
ConfigMap value on the final `7b7673a` rollout; if behavior regresses, revert through GitOps using
the paths above.
