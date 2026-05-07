# Torghut quant verifier release gate - 2026-05-07

Release engineer: Julian Hart
Repository: `proompteng/lab`
Branch: `codex/swarm-torghut-quant-verify`
Base: `main`
Owner channel: `swarm://owner/trading`
Last refreshed: 2026-05-07T09:16:00Z

## Owner update message

Torghut rollout state is go for the generated production promotion #5815 and no-go for the remaining
open Torghut quant PRs.

#5815, `chore(torghut): promote image 315dde4b`, was conflict-free, comment-clean, and green before
merge. It squash-merged at `e764d1c4048eb35924cb8063a12a0f9d4704cbf4`, promoting Torghut runtime
and options image digest `sha256:11ad110644f9c719abbd0b6414dcafe80557f793e3a7edfe5466dba353f72547`.
The merge commit's `torghut-ci` and `torghut-post-deploy-verify` workflows both passed. Argo CD now
reports `torghut` and `torghut-options` Synced and Healthy at main revision
`be164bc127abb3a9c1b8ed97d2a34597a8ee90e6`, which includes #5815, and both sync operations
succeeded.

The active live, sim, options catalog, and options enricher workloads are ready on the promoted
digest. Runtime probes are up: `torghut-ws` `/readyz` returns ready, and live `/trading/status`
reports active revision `torghut-00252`, commit `315dde4b8581598309238c2989b95451a167c110`, and
`running=true`. Live order submission remains deliberately closed by `simple_submit_disabled` with
capital in shadow, so that is not a rollout failure.

#5812 remains no-go because the visible required integration check is still pending. I did not merge
it while that check was incomplete. #5412 remains no-go because the PR is over the 1000-line review
threshold, the required Codex review has not posted due connector usage-limit responses, and its
current CI set is not fully green. The smallest unblocker is restored Codex review capacity or an
explicit maintainer waiver of the large-diff review gate after all current checks pass.

## Open PR enumeration

- #5815, `chore(torghut): promote image 315dde4b`, was selected first as the high-impact generated
  GitOps promotion. It merged and rolled out healthy.
- #5812, `docs(torghut): define state-coherent profit auction`, remains open. It is not a runtime
  deployment blocker, and its `integration` check remains pending in agents-ci run `25485220462`.
- #5412, `feat(torghut): add renewal bond profit escrow`, remains open. It is the main runtime
  implementation PR, but it is held by the large-diff Codex review gate and current CI completion.
- #5818, `fix(temporal-bun-sdk): harden activity response races`, was not selected because it is not
  Torghut quant scope.
- #5767 and #5316 are automated release PRs outside the selected Torghut quant runtime path and were
  not selected in this release lane.

## PRs touched

- #5815: verified green, updated the anchored `<!-- codex:progress -->` comment, squash-merged, and
  verified post-merge CI, GitOps, workload readiness, events, and runtime endpoints.
- #5412: inspected current merge and review state, updated the anchored progress comment with the
  no-go gate, and kept it unmerged.
- #5812: inspected current checks and kept it unmerged because the integration check is pending.
- This audit branch: fast-forwarded to current `main` and recorded the release decision in
  `/workspace/.agentrun/swarm/torghut-quant-verify.md` and
  `docs/torghut/rollouts/2026-05-07-torghut-quant-verify.md`.

## Comments and conflicts resolved

- #5815 had no unresolved review threads or blocking comments before merge.
- #5815's progress comment was kept current through
  `services/jangar/scripts/codex/codex-progress-comment.ts`.
- #5412 has no posted Codex review and no review threads to resolve. Repeated `@codex review`
  requests continue to receive `chatgpt-codex-connector` usage-limit responses, so the mandatory
  large-diff review is not satisfied.
- #5812 was not modified. Its pending integration check is the active merge gate.
- No direct production mutations were made from the local shell. Promotion and rollback remain
  GitOps PR actions only.

## Merge outcomes

#5815 was go for merge and go for rollout:

- PR checks were passing before merge.
- Diff size was 22 additions and 22 deletions, below the large-diff Codex review threshold.
- Squash merge commit: `e764d1c4048eb35924cb8063a12a0f9d4704cbf4`.
- Promoted digest:
  `sha256:11ad110644f9c719abbd0b6414dcafe80557f793e3a7edfe5466dba353f72547`.
- Previous digest:
  `sha256:bd586167988b8e1e207e39c0d5672dc8d191d7bc43e1da95096189b884e08aca`.
- Mainline `torghut-ci` run `25486053029` passed on the merge commit.
- Mainline `torghut-post-deploy-verify` run `25486053082` passed on the merge commit.

#5812 was no-go for merge:

- `gh pr checks 5812 -R proompteng/lab` still showed `integration` pending in agents-ci run
  `25485220462`.
- I did not merge while a required check was pending.

#5412 was no-go for merge:

- GitHub reported `mergeable=MERGEABLE` and `mergeStateStatus=UNSTABLE` during this release pass.
- Current inspected size: 5,928 additions and 466 deletions.
- The PR exceeds the 1000-line mandatory Codex review threshold.
- No Codex review is posted, and the latest connector responses still report Codex code-review
  usage limits.
- `gh pr checks 5412 -R proompteng/lab` still showed the `Bytecode + pytest + coverage` check pending
  during this pass.

## Validation

- PASS: NATS context soak was read before action, and release updates were published to the general
  channel through `/usr/local/bin/codex-nats-publish`.
- PASS: `gh pr list -R proompteng/lab --state open --limit 30 --json ...`; enumerated open PRs and
  selected the Torghut release items by unblock-first/high-impact order.
- PASS: `gh pr merge 5815 --squash -R proompteng/lab --subject "chore(torghut): promote image 315dde4b"`;
  GitHub confirmed #5815 was already merged at `e764d1c4048eb35924cb8063a12a0f9d4704cbf4` by this
  release lane.
- PASS: `gh run watch 25486053029 -R proompteng/lab --exit-status`; `torghut-ci` passed.
- PASS: `gh run watch 25486053082 -R proompteng/lab --exit-status`; `torghut-post-deploy-verify`
  passed.
- PASS:
  `kubectl -n argocd get applications.argoproj.io torghut torghut-options -o jsonpath=...`;
  both apps were Synced and Healthy at `be164bc127abb3a9c1b8ed97d2a34597a8ee90e6`, with sync
  operation phase `Succeeded`.
- PASS: `kubectl -n torghut get deploy,pods -o wide`; active live, sim, options catalog, options
  enricher, TA, TA-sim, ws, ws-options, database, and ClickHouse pods were ready or completed as
  expected.
- PASS: `curl -fsS http://torghut-ws.torghut.svc.cluster.local/readyz`; returned
  `{"status":"ready","ready":true,...}`.
- PASS: `curl -fsS http://torghut.torghut.svc.cluster.local/trading/status`; returned HTTP 200 with
  active revision `torghut-00252`, source commit `315dde4b8581598309238c2989b95451a167c110`, and
  `running=true`.
- NO-GO: `gh pr checks 5812 -R proompteng/lab`; `integration` remained pending.
- NO-GO: `gh pr checks 5412 -R proompteng/lab`; `Bytecode + pytest + coverage` remained pending and
  the required Codex review was absent.

## Deployment evidence

GitOps state after #5815:

- `torghut`: Synced / Healthy at current main revision
  `be164bc127abb3a9c1b8ed97d2a34597a8ee90e6`, operation phase `Succeeded`, message
  `successfully synced (no more tasks)`.
- `torghut-options`: Synced / Healthy at current main revision
  `be164bc127abb3a9c1b8ed97d2a34597a8ee90e6`, operation phase `Succeeded`, message
  `successfully synced (all tasks run)`.

Workload readiness:

- `torghut-00252-deployment`: 1 ready / 1 available / 1 desired on digest
  `sha256:11ad110644f9c719abbd0b6414dcafe80557f793e3a7edfe5466dba353f72547`.
- `torghut-sim-00352-deployment`: 1 ready / 1 available / 1 desired on the same digest.
- `torghut-options-catalog`: 1 ready / 1 available / 1 desired on the same digest.
- `torghut-options-enricher`: 1 ready / 1 available / 1 desired on the same digest.
- `torghut-ta`, `torghut-ta-sim`, `torghut-options-ta`, `torghut-ws`, `torghut-ws-options`,
  `torghut-db`, and ClickHouse/Keeper pods were ready.
- Hook jobs `torghut-db-migrations`, `torghut-empirical-jobs-backfill`,
  `torghut-whitepapers-bootstrap`, and `torghut-whitepaper-semantic-backfill` completed.

Runtime evidence:

- Live `/trading/status` reports `enabled=true`, `running=true`, active revision `torghut-00252`,
  version `v0.568.5-307-g315dde4b8`, and commit `315dde4b8581598309238c2989b95451a167c110`.
- Live submission remains blocked by `simple_submit_disabled`; `capital_stage` is `shadow` and
  `max_notional` is `0`.
- Proof floor is `repair_only`, with blocking reasons including `alpha_readiness_not_promotion_eligible`,
  `execution_tca_stale`, and `simple_submit_disabled`. That is a trading-capital gate, not a
  Kubernetes rollout failure.
- Quant evidence is degraded but non-blocking for this rollout because `required=false`; ingestion lag
  is the informational reason.

Recent event risks:

- New options and Knative pods emitted transient startup/readiness probe warnings, then reached Ready.
- Argo created and completed the post-sync hook jobs after the image promotion.
- Old Knative revisions were scaled down and emitted shutdown readiness warnings. These were expected
  during revision replacement.
- ClickHouse still emits `MultiplePodDisruptionBudgets` warnings and `torghut-keeper` still reports
  `NoPods`. This is cluster hygiene debt, not a release rollback trigger for the promoted Torghut
  digest.

## Risks

- #5412 is the largest release risk. It must remain unmerged until its current checks pass and the
  mandatory Codex review posts with all resulting threads resolved, or until a maintainer explicitly
  waives the large-diff gate.
- #5812 is not merge-ready while `integration` is pending. Recheck that job before any squash merge.
- Live trading capital is intentionally held in shadow. The release is healthy at the application
  rollout layer, not a go for live submission.
- Quant ingestion is degraded but currently non-blocking for rollout health because the service marks
  the quant evidence requirement as optional.
- ClickHouse PDB overlap remains a standing cluster hygiene warning.

## Rollback path

- For #5815: open a GitOps PR reverting `e764d1c4048eb35924cb8063a12a0f9d4704cbf4`, or reverting the
  image-reference changes back to digest
  `sha256:bd586167988b8e1e207e39c0d5672dc8d191d7bc43e1da95096189b884e08aca`, then let Argo CD
  reconcile. Do not mutate production directly outside an emergency.
- If source commit `315dde4b8581598309238c2989b95451a167c110` regresses, revert the source change and
  promote the last known-good image through the normal GitOps release workflow.
- Rollback triggers: `torghut` or `torghut-options` becomes Degraded or stuck OutOfSync, the
  post-deploy verification workflow fails on the current head, active Torghut pods lose readiness,
  runtime probes stop returning HTTP 200, or runtime behavior regresses beyond the known
  shadow-capital gates.
- #5412 and #5812 have no runtime rollback action from this pass because neither PR merged.

## Next action

Keep #5812 blocked until the integration check completes successfully. Keep #5412 blocked until all
current checks are green and the required Codex review is posted and resolved, or a maintainer waives
the large-diff review gate. If either gate clears, refresh the branch against current `main`, recheck
all required checks, squash-merge only after green, and repeat GitOps/workload/event verification.
