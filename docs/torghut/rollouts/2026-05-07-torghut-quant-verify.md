# Torghut quant verifier release gate - 2026-05-07

Release engineer: Julian Hart
Repository: `proompteng/lab`
Branch: `codex/swarm-torghut-quant-verify`
Base: `main`
Owner channel: `swarm://owner/trading`
Last refreshed: 2026-05-07T19:10:00Z

## Owner update message

Torghut rollout gate is go at promotion commit
`4797740664c4b0140e0ac1bbe6e0802b8187a0ed` (#5946). #5944 merged the flat quote
backfill fix at `e8d235d9eba9d4fa0a2a8753e591568e8e492ee5`, and automatic promotion #5946
moved the Torghut runtime image to
`sha256:adee80182e01fcd1de43d9fa527f9957d9b493791ad816ea8de285847de2b66b`.

Required checks are green on the promotion commit: argo-lint, kubeconform, Torghut Pyright,
Quality signals, Bytecode + pytest + coverage, and `torghut-post-deploy-verify`. Argo CD shows
both `torghut` and `torghut-options` `Synced` / `Healthy` at revision
`4797740664c4b0140e0ac1bbe6e0802b8187a0ed`. Live and sim Torghut, options catalog, and options
enricher are ready on the promoted digest with zero restarts.

#5412 remains no-go. It is still above the mandatory large-diff Codex review threshold and no
successful Codex review has posted. It must not merge until the review posts, any review threads
are resolved, merge state is refreshed, and fresh required checks pass.

## Open PR enumeration

- #5412 `feat(torghut): add renewal bond profit escrow`
  - Open and Torghut-scoped, but no-go because it has 5,921 additions and 455 deletions and still
    lacks the required Codex review.
- #5944 `fix(torghut): backfill flat quote fields into signals`
  - Selected as the active small production fix after #5941. It had no review comments, passed
    required checks, and merged.
- #5946 `chore(torghut): promote image e8d235d9`
  - Automatic Torghut image promotion for #5944. It merged and became the final production rollout
    gate.
- Other open PRs at closeout were not Torghut quant blockers for this release gate.

## PRs touched

- #5918 `feat(torghut): add route reacquisition book`
  - Added route reacquisition regression coverage.
  - Squash-merged at `f65301040fb055abf4d0e277fbfe98ebe2d5b2ca`.
- #5910 `fix(torghut): reject stale TA quotes`
  - Added quote-quality regression coverage.
  - Squash-merged at `3300ed68d642b2178bcedeef58a66bf9adc82526`.
- #5920 `chore(torghut): promote ws image 0333e762`
  - Squash-merged at `495239359bf79921223195785b18e97e3eb99631`.
  - Websocket workloads remain ready on digest
    `sha256:67f4c169ac4bc80e2649902eda8763ad3545a675d11ec0d134820d009704566b`.
- #5921 `chore(torghut-options): promote ta image 0333e762`
  - Squash-merged at `57b2f2f21d71798288df40459fc0a6ee8e6d0154`.
  - Options TA remains ready on digest
    `sha256:c1c7b8556683d05f4f3847d82e95e7fc93de31a32624adf4300a04a435c7683d`.
- #5922 `chore(torghut): promote image 5d072a62`
  - Squash-merged at `23d1668522dcfe89fe31b7bad3352940b1dd8952`; superseded by later Torghut
    promotions.
- #5923 `chore(torghut): promote image 3300ed68`
  - Squash-merged at `585e5f3b4120e5eb95ba4dd00d0dab327ed7816a`; superseded by later Torghut
    promotions.
- #5924 `chore(torghut): promote live ta image 3300ed68`
  - Squash-merged at `a42f6ee4641f052c8951455c7788102770dcc5b6`.
  - Live TA remains ready on digest
    `sha256:e22e7fb47921db61f749006c5ebde0eb8c12c1b9f9fe24db3f8f739745f9bad2`.
- #5929 `feat(torghut): rank route reacquisition repairs`
  - Squash-merged at `1b4e860a488b9038d9f29c688a3c900f9644e49b`.
- #5930 `chore(torghut): promote image 1b4e860a`
  - Squash-merged at `3675674d7089bb8d1e942e160505e9b72090dc70`; superseded by #5932.
- #5931 `fix(torghut): preserve executable flat quotes`
  - Squash-merged at `abaaf77572f6c9c53c8b8b6f61409e87235b5c19`.
- #5932 `chore(torghut): promote image abaaf775`
  - Squash-merged at `7b7673a30a342b54085fa35f90f7d3e0338d3e6b`; superseded by #5941.
- #5937 `fix(torghut): advance past stale feature batches`
  - Squash-merged at `b2ab2e76c90e8090b21d434fc37a7137fc20e40a`.
  - Advanced the cursor for staleness-only feature-quality failures without decisions or order
    submission.
- #5941 `chore(torghut): promote image b2ab2e76`
  - Squash-merged at `637123ed50b2101c3588009a1817c6e32c017a99`; superseded by #5946.
- #5944 `fix(torghut): backfill flat quote fields into signals`
  - Squash-merged at `e8d235d9eba9d4fa0a2a8753e591568e8e492ee5`.
  - Backfilled flat ClickHouse quote fields into non-empty signal payloads and added regression
    coverage for executable quote quality.
- #5946 `chore(torghut): promote image e8d235d9`
  - Squash-merged by release automation at `4797740664c4b0140e0ac1bbe6e0802b8187a0ed`.
  - Final production promotion for this gate.
- #5412 `feat(torghut): add renewal bond profit escrow`
  - Rechecked and held no-go at `539180cd0ef3e21c32e4dcd10f31dbd4f2f8da09`.
- #5935, #5939, and #5943
  - Audit documentation PRs merged during the release train.

## Comments and conflicts resolved

- No selected merged PR had unresolved review threads at the time it merged or was verified.
- #5918 and #5910 received follow-up test commits before merge.
- #5944 had no review comments and passed changed-file, semantic, Pyright, Quality signals, and
  Bytecode + pytest + coverage checks before squash merge.
- #5946 had no review comments. Its promotion checks and main push checks passed before declaring
  the rollout go.
- #5412 had no review threads in the GitHub review-thread query, but it remains no-go because the
  mandatory Codex review did not post. Prior Codex review requests were blocked by usage limits.
- Anchored progress comments using `<!-- codex:progress -->` were refreshed for #5412, #5937,
  #5941, #5943, #5944, and #5946 with `services/jangar/scripts/codex/codex-progress-comment.ts`.
- No production workload was mutated directly from the local shell. Promotion occurred through PR
  merge and Argo CD reconciliation.
- Live release updates were published through `/usr/local/bin/codex-nats-publish --publish-general`.

## Validation

- PASS: #5944 PR checks passed: changed-file gate, semantic commit/title, Pyright, Quality signals,
  and Bytecode + pytest + coverage.
- PASS: #5946 PR checks passed: semantic commit/title, argo-lint, kubeconform, Torghut deploy
  enable, Pyright, Quality signals, and Bytecode + pytest + coverage.
- PASS: main `4797740664c4b0140e0ac1bbe6e0802b8187a0ed` checks passed:
  argo-lint run `25516014519`, kubeconform run `25516014553`, torghut-ci run `25516014537`, and
  torghut-post-deploy-verify run `25516014608`.
- PASS: `kubectl get applications -n argocd torghut torghut-options -o wide`.
- PASS:
  `kubectl get applications -n argocd torghut torghut-options -o jsonpath='{range .items[*]}{.metadata.name}{" sync="}{.status.sync.status}{" health="}{.status.health.status}{" revision="}{.status.sync.revision}{" op="}{.status.operationState.phase}{" msg="}{.status.operationState.message}{"\n"}{end}'`.
- PASS:
  `kubectl get pods -n torghut -o jsonpath='{range .items[*]}{.metadata.name}{" status="}{.status.phase}{" ready="}{range .status.containerStatuses[*]}{.ready}{","}{end}{" restarts="}{range .status.containerStatuses[*]}{.restartCount}{","}{end}{" images="}{range .spec.containers[*]}{.image}{","}{end}{"\n"}{end}'`.
- PASS:
  `kubectl get deployments -n torghut torghut-options-catalog torghut-options-enricher torghut-ws torghut-ws-options torghut-ta torghut-ta-sim torghut-options-ta -o jsonpath='{range .items[*]}{.metadata.name}{" ready="}{.status.readyReplicas}{"/"}{.status.replicas}{" updated="}{.status.updatedReplicas}{" available="}{.status.availableReplicas}{" image="}{range .spec.template.spec.containers[*]}{.image}{","}{end}{"\n"}{end}'`.
- PASS: `kubectl get events -n torghut --field-selector type=Warning --sort-by=.lastTimestamp`.
- PASS:
  `kubectl get configmap -n torghut torghut-ta-config torghut-ta-sim-config -o jsonpath='{range .items[*]}{.metadata.name}{" TA_QUOTE_STALE_AFTER_MS="}{.data.TA_QUOTE_STALE_AFTER_MS}{"\n"}{end}'`.

## Deployment evidence

- `torghut`: `Synced` / `Healthy` at revision
  `4797740664c4b0140e0ac1bbe6e0802b8187a0ed`, operation phase `Succeeded`, message
  `successfully synced (no more tasks)`.
- `torghut-options`: `Synced` / `Healthy` at revision
  `4797740664c4b0140e0ac1bbe6e0802b8187a0ed`, operation phase `Succeeded`, message
  `successfully synced (all tasks run)`.
- `torghut-00278-deployment-77d85b564c-7pbrl`: Running, ready `true,true`, zero restarts, Torghut
  digest `sha256:adee80182e01fcd1de43d9fa527f9957d9b493791ad816ea8de285847de2b66b`.
- `torghut-sim-00378-deployment-5db755df9-vgldf`: Running, ready `true,true`, zero restarts, same
  Torghut digest.
- `torghut-options-catalog-6ccf7d9c7f-zvj5c`: Running, ready `true`, zero restarts, same Torghut
  digest.
- `torghut-options-enricher-5d6cbf797b-j6lw2`: Running, ready `true`, zero restarts, same Torghut
  digest.
- `torghut-ta-5db478c445-dpj7b`: Running, ready `true`, zero restarts, live TA digest
  `sha256:e22e7fb47921db61f749006c5ebde0eb8c12c1b9f9fe24db3f8f739745f9bad2`.
- `torghut-ta-sim-598655766-rmd4t`: Running, ready `true`, zero restarts, TA-sim digest
  `sha256:20fe1818a7c5239d58d4e3888804163025b9b3b2ee1a1674fd7db77007f682af`.
- `torghut-options-ta-db9b6984f-mf578`: Running, ready `true`, zero restarts, options TA digest
  `sha256:c1c7b8556683d05f4f3847d82e95e7fc93de31a32624adf4300a04a435c7683d`.
- `torghut-ws-6f54db9949-qcgpf` and `torghut-ws-options-848bfc58d4-d64q5`: Running, ready `true`,
  zero restarts, websocket digest
  `sha256:67f4c169ac4bc80e2649902eda8763ad3545a675d11ec0d134820d009704566b`.
- `torghut-ta-config` and `torghut-ta-sim-config` both carry `TA_QUOTE_STALE_AFTER_MS=15000`.
- Event review showed expected startup/readiness probe warnings during rollout and recurring
  ClickHouse PodDisruptionBudget overlap warnings. Final workload state is ready; no current
  rollout error remains.
- The pre-existing failed `torghut-whitepaper-autoresearch-profit-target-8r6w6` pod remains
  unrelated residual noise.

## Risks

- #5412 remains the main open Torghut code risk. It must stay unmerged until the large-diff Codex
  review gate is satisfied.
- Codex review requests for #5412 are currently blocked by Codex review usage limits.
- Recurring ClickHouse PodDisruptionBudget warnings predate this rollout and did not block verified
  readiness.
- The older failed whitepaper autoresearch workflow pod predates this final rollout and is a
  follow-up operational cleanup item, not a rollback trigger.
- #5944 changed signal ingest payload backfill behavior. Watch TA quote validity and order
  eligibility metrics after rollout.

## Rollback path

- For #5946: open a GitOps PR reverting `4797740664c4b0140e0ac1bbe6e0802b8187a0ed`, or restore
  Torghut image digest `sha256:1c6894aabfd6400465eaaa22dc99713b4e4c82d64c68c329d15217e3c37868ca`
  in the affected manifests, then let Argo CD reconcile.
- For #5944: open a PR reverting `e8d235d9eba9d4fa0a2a8753e591568e8e492ee5`, rebuild, and promote
  through the normal release workflow.
- For #5937: open a PR reverting `b2ab2e76c90e8090b21d434fc37a7137fc20e40a`, rebuild, and promote
  through the normal release workflow.
- For #5931: open a PR reverting `abaaf77572f6c9c53c8b8b6f61409e87235b5c19` or restore the prior
  TA quote freshness ConfigMap value while reverting flat quote ingest behavior.
- For #5412: no rollback required because it was not merged.

## Next action

Keep #5412 blocked until Codex review capacity is available. Continue watching flat quote
ingestion, TA quote age, route repair evidence, and stale-batch cursor advancement on the final
`4797740664c4b0140e0ac1bbe6e0802b8187a0ed` rollout.
