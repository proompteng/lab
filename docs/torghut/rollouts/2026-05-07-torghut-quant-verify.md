# Torghut quant verifier release gate - 2026-05-07

Release engineer: Julian Hart
Repository: `proompteng/lab`
Branch: `codex/swarm-torghut-quant-verify`
Base: `main`
Owner channel: `swarm://owner/trading`
Last refreshed: 2026-05-07T18:10:00Z

## Owner update message

Torghut rollout gate is go at main `7b7673a30a342b54085fa35f90f7d3e0338d3e6b`.
PR #5931 merged the flat TA quote ingestion fix, and the automatic promotion PR #5932 moved the
runtime image to digest
`sha256:da08c6f6f976f1f9495435de56f63937578f5da7a79b627c831098cc550044d5`.

Current-main checks are green, including Torghut CI, kubeconform, argo-lint, and
`torghut-post-deploy-verify`. Argo CD shows both `torghut` and `torghut-options` `Synced` /
`Healthy` at `7b7673a30a342b54085fa35f90f7d3e0338d3e6b`. Live and sim TA ConfigMaps both now carry
`TA_QUOTE_STALE_AFTER_MS=15000`, and the live, sim, catalog, enricher, TA, and TA-sim workloads are
ready with zero restarts on their current pods.

#5412 remains no-go. It is still above the mandatory large-diff Codex review threshold and no
successful Codex review has posted. It must not merge until that review posts and any resulting
threads are resolved.

## Open PR enumeration

- #5931, `fix(torghut): preserve executable flat quotes`, was the high-impact unblock. It was a
  small Torghut code/config fix, had no review threads, passed visible required checks, and was
  below the 1000-line mandatory Codex review threshold.
- #5932, `chore(torghut): promote image abaaf775`, was the automatic image promotion for #5931. It
  merged after #5931 and became the active rollout gate.
- #5412, `feat(torghut): add renewal bond profit escrow`, remains open and no-go because the large
  diff still lacks the required Codex review. Visible checks were refreshed after main advanced, but
  ticket/check state is not enough to override the missing review gate.

## PRs touched

- #5931: selected, verified checks and review state, confirmed merge at
  `abaaf77572f6c9c53c8b8b6f61409e87235b5c19`.
- #5932: verified automatic promotion merge at `7b7673a30a342b54085fa35f90f7d3e0338d3e6b`, then
  verified CI and in-cluster rollout.
- #5412: rechecked status, review threads, and large-diff gate; left unmerged.
- This audit branch: refreshed this rollout note and
  `/workspace/.agentrun/swarm/torghut-quant-verify.md`.

## Comments and conflicts resolved

- #5931 had no review threads. Its anchored Codex progress comment was current after merge and
  recorded that the rollout gate moved to the automatic promotion.
- #5932 had no review comments.
- #5412 had no review threads in the GitHub review-thread query, but it remains no-go because the
  mandatory Codex review did not post. Prior Codex review requests were answered by the connector
  usage-limit response.
- No production workloads were mutated directly from the local shell. Promotion occurred through PR
  merge and Argo CD reconciliation.

## Merge outcomes

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
- Size: above the 1000-line mandatory Codex review threshold.
- Gate: no successful Codex review is posted; do not merge until review and any resulting threads
  are resolved.

## Validation

- PASS: Read NATS context before action via `.codex-nats-context.json` and raw NATS context checks.
- PASS: Published live release updates through `/usr/local/bin/codex-nats-publish --publish-general`.
- PASS: `gh pr checks 5931 -R proompteng/lab --watch --interval 10`.
- PASS: GitHub GraphQL review-thread checks for #5931 and #5412 returned no review threads.
- PASS: GitHub GraphQL status rollup for `7b7673a30a342b54085fa35f90f7d3e0338d3e6b` returned
  `SUCCESS`; green checks included `torghut-ci`, `kubeconform`, `argo-lint`, and
  `torghut-post-deploy-verify`.
- PASS: `bun run lint:argocd` after installing the CI-pinned `kubeconform v0.7.0`.
- PASS: `kubectl kustomize --enable-helm argocd/applications/torghut` rendered
  `TA_QUOTE_STALE_AFTER_MS: "15000"` for both TA ConfigMaps.
- PASS: `kubectl wait application/torghut -n argocd --for=jsonpath='{.status.health.status}'=Healthy`.
- PASS:
  `kubectl wait application/torghut-options -n argocd --for=jsonpath='{.status.sync.revision}'=7b7673a30a342b54085fa35f90f7d3e0338d3e6b`.
- PASS: `kubectl wait job/torghut-db-migrations -n torghut --for=condition=complete`.
- PASS: `git diff --check`.

## Deployment evidence

- `torghut`: `Synced` / `Healthy` at revision `7b7673a30a342b54085fa35f90f7d3e0338d3e6b`, operation
  phase `Succeeded`, message `successfully synced (all tasks run)`.
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
- `torghut-ta-68bbdcd87b-4fcpn` and `torghut-ta-sim-598655766-rmd4t`: Running, ready `true`, zero
  restarts on the current TA images.

Event evidence:

- New Knative revisions `torghut-00276` and `torghut-sim-00376` became ready.
- The `torghut-db-migrations` hook completed.
- TA and TA-sim Flink deployments moved through `RECONCILING` / `INITIALIZING` / `CREATED` to
  `RUNNING`.
- Transient startup/readiness probe warnings occurred during pod replacement and cleared. The final
  workload state is ready with zero restarts.

## Risks

- #5412 remains the main open Torghut code risk. It must stay unmerged until the large-diff Codex
  review gate is satisfied.
- The TA-sim ConfigMap has an ApplicationSet ignore rule for `/data`; the final rollout did apply
  the 15000 ms value during the #5932 sync, but future data-only sim ConfigMap changes should be
  checked explicitly in-cluster.
- Pre-existing failed historical jobs, including an older
  `torghut-whitepaper-autoresearch-profit-target` pod, remain non-blocking residual noise for this
  rollout because current Torghut workloads and the post-deploy verifier are green.

## Rollback path

- For #5932: open a GitOps PR reverting `7b7673a30a342b54085fa35f90f7d3e0338d3e6b`, or restore the
  previous Torghut image digest
  `sha256:ad28c58749e5d2015f5ba4bd72bab64919963cc2d208a846a9ef047726950fb4` in the affected
  manifests, then let Argo CD reconcile.
- For #5931: open a GitOps PR reverting `abaaf77572f6c9c53c8b8b6f61409e87235b5c19`, or set
  `TA_QUOTE_STALE_AFTER_MS` back to `2000` in `argocd/applications/torghut/ta/configmap.yaml` and
  `argocd/applications/torghut/ta-sim/configmap.yaml`, then let Argo CD reconcile.
- For #5412: no rollback is required because it was not merged and no production rollout occurred.

## Next action

Keep #5412 blocked until Codex review posts and all resulting threads are resolved. Continue
watching TA quote-quality admission and the TA-sim ConfigMap value; if execution-gate behavior
regresses, revert #5931 and #5932 through GitOps.
