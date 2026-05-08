# Torghut quant verifier release gate - 2026-05-08

Release engineer: Julian Hart
Repository: `proompteng/lab`
Branch: `codex/swarm-torghut-quant-verify`
Base: `main`
Audit PR: #6036
Owner channel: `swarm://owner/trading`
Last refreshed: 2026-05-08T04:35:00Z

## Owner update message

Current rollout state is go for the already-merged mainline Torghut promotion and no-go for new
Torghut merges.

Argo CD reports `torghut`, `torghut-options`, and `symphony-torghut` as `Synced` and `Healthy` at
main revision `f37038d2650e17436d92ad28cb5fc74461fcb1c3`. The current Torghut service revision is
`torghut-00298`, built from `44fd611a3c0ed48ac168f3eaa036e73e4cdf96f8` and running image digest
`sha256:68618ea3f8c9924bcf7ba2523423bf45ec893ab41cc2c35c529dd1d1d83ba8e0`. The active live and sim
Knative-backed deployments are ready with both containers healthy.

#5412, `feat(torghut): add profit escrow runtime projections`, remains held. It is open, non-draft,
`CLEAN`, `MERGEABLE`, and green on visible hosted checks at head
`9a4c424b4a855046408cbc7895381eccce233a9f`, but it changes 7,099 additions and 498 deletions. That
exceeds the mandatory 1,000-line Codex review threshold. No Codex review has posted; the latest
review request returned the connector usage-limit blocker at 2026-05-08T03:03:08Z. I did not merge it.

#6023, `revert(torghut): rollback failed promotion 87e6e9cdb4951776c10ef9a56e507b0e72cf5a08`, is
not a safe rollback for the current mainline state. It was generated for an older failed verifier run
and now only removes the extended Torghut probe budgets while rewinding Knative timestamps. Current
main has already promoted and reconciled a newer image through #6032. Merging #6023 would reduce the
probe budget on the currently healthy rollout; the correct rollback path for a new failure is a fresh
rollback PR against current main, not this stale rollback. I closed #6023 with that no-go decision.

## Open PR enumeration

- #5412, `feat(torghut): add profit escrow runtime projections`
  - Selected as the remaining Torghut quant runtime PR.
  - No-go: blocked by the large-diff Codex review gate.
- #6023, `revert(torghut): rollback failed promotion 87e6e9cdb4951776c10ef9a56e507b0e72cf5a08`
  - Evaluated as the unblock-first rollback candidate.
  - No-go for merge: obsolete against current main and safety-negative because it removes probe
    budget now used by the healthy rollout.
  - Closed with a release-gate comment.
- #5767, `chore(release/c3ba60b): automated release PR`
  - Not selected: touches `argocd/applications/app/kustomization.yaml`, not Torghut.
- #5316, `chore(release/735ddbc): automated release PR`
  - Not selected: touches `argocd/applications/docs/kustomization.yaml`, not Torghut.
- #5889, `feat(jangar): add repair warrant exchange`
  - Not selected: Jangar control-plane scope, not the Torghut runtime release gate.
- #6036, `docs(torghut): refresh quant release gate`
  - Audit PR for this release-engineering pass.
  - Carries this refreshed gate record and no runtime changes.

## PRs touched

- #5412
  - Rechecked mergeability, visible checks, review state, latest blocker comment, and changed-line
    count.
  - Kept open and unmerged because the large-diff Codex review has not posted.
- #6023
  - Rechecked diff, checks, scope, and current production relevance.
  - Classified no-go for merge because it reverts probe-budget protection after newer Torghut
    promotions have already reconciled.
  - Closed after documenting the no-go decision on the PR.
- #6021 and #6032
  - Used as context for the rollback decision. #6021 introduced the probe budget that #6023 would
    revert; #6032 is the current mainline Torghut promotion that is reconciled in-cluster.
- #6036
  - Opened from `codex/swarm-torghut-quant-verify` to `main` as the audit artifact PR.

## Comments and conflicts resolved

- #5412 currently reports `mergeStateStatus=CLEAN` and `mergeable=MERGEABLE`.
- #5412 has no posted GitHub review in the visible PR data.
- #5412 remains blocked by policy because the required Codex review did not post.
- The latest #5412 Codex review request was followed by the connector usage-limit response instead
  of a review.
- #6023 had no review comments to resolve. Its visible checks passed, but merge readiness was a no-go
  because the change is stale and unsafe for current main; it is now closed.
- No local direct production mutation was made. Production movement remains PR merge plus GitOps
  reconciliation only.

## Merge outcomes

- #5412: not merged. Merge gate is blocked on Codex review capacity or an explicit maintainer waiver,
  followed by any review-thread resolution and green checks.
- #6023: not merged. Closed as obsolete for current main and kept out of the release lane.
- #6036: opened as the docs-only audit PR for this release pass.
- No selected Torghut code PR was squash-merged during this pass.

## Validation

- PASS: NATS context soak read from `.codex-nats-context.json`; no prior general-channel messages
  were returned by the soak.
- PASS: Open PR inventory from `gh pr list -R proompteng/lab --state open --limit 100`.
- PASS: #5412 visible hosted checks are complete with success or intentional skip at head
  `9a4c424b4a855046408cbc7895381eccce233a9f`, including Torghut bytecode and pytest, Pyright,
  quality signals, changed-file checks, semantic commits, and semantic PR title.
- PASS: #6023 visible hosted checks completed successfully or skipped intentionally, including
  `argo-lint`, `kubeconform`, Torghut CI, semantic commits, and semantic PR title.
- PASS: #6023 diff review shows only
  `argocd/applications/torghut/knative-service.yaml` and
  `argocd/applications/torghut/knative-service-sim.yaml`.
- PASS: `kubectl get application -n argocd` reports `torghut`, `torghut-options`, and
  `symphony-torghut` as `Synced` and `Healthy`.
- PASS: `kubectl get app torghut -n argocd -o jsonpath=...` reports revision
  `f37038d2650e17436d92ad28cb5fc74461fcb1c3`, operation `Succeeded`, and
  `successfully synced (no more tasks)`.
- PASS: `kubectl get deploy,pod -n torghut -o wide` shows current live and sim Torghut deployments
  available, with active pods running and ready.
- PASS: `curl -fsS http://torghut.torghut.svc.cluster.local/healthz` returns HTTP 200 with
  `{"status":"ok","service":"torghut"}`.
- PASS: `curl -fsS http://torghut.torghut.svc.cluster.local/trading/status` returns HTTP 200 and
  reports build commit `44fd611a3c0ed48ac168f3eaa036e73e4cdf96f8`, active revision
  `torghut-00298`, `running=true`, `capital_stage=shadow`, and live submission blocked by
  `simple_submit_disabled`.
- EXPECTED DEGRADED: `/readyz` and `/trading/health` return HTTP 503 because the runtime proof floor
  is `repair_only`, capital is `zero_notional`, and live submission is disabled. Core dependencies
  in the response are healthy: Postgres, ClickHouse, Alpaca, universe resolution, and empirical jobs.
- LIMITATION: The service account cannot list Knative Services or use Kubernetes service proxy, so
  rollout verification used Argo Application status, Deployments, Pods, events, and in-cluster HTTP
  service access from the runner.

## Deployment evidence

- Current main revision: `f37038d2650e17436d92ad28cb5fc74461fcb1c3`
- Current main commit subject: `chore(torghut): promote image 44fd611a (#6032)`
- Current Torghut source commit in runtime status:
  `44fd611a3c0ed48ac168f3eaa036e73e4cdf96f8`
- Current Torghut image digest:
  `sha256:68618ea3f8c9924bcf7ba2523423bf45ec893ab41cc2c35c529dd1d1d83ba8e0`
- Argo state:
  - `torghut`: `Synced` / `Healthy`
  - `torghut-options`: `Synced` / `Healthy`
  - `symphony-torghut`: `Synced` / `Healthy`
- Workload readiness:
  - `torghut-00298-deployment`: `1/1` available
  - `torghut-sim-00397-deployment`: `1/1` available
  - `torghut-options-catalog`: `1/1` available
  - `torghut-options-enricher`: `1/1` available
  - `torghut-ws`, `torghut-ws-options`, Torghut TA deployments, and guardrail exporters are ready.
- Event review:
  - New Torghut live and sim revisions emitted transient startup/readiness warnings during startup.
  - Both active revisions became ready and older revisions scaled down.
  - The older `torghut-whitepaper-autoresearch-profit-target` pod remains in Error and is unrelated
    to the #6032 rollout gate.

## Risk

- #5412 remains the main unmerged Torghut runtime risk. Its code path is green on visible checks but
  cannot merge without the required large-diff Codex review or explicit maintainer waiver.
- Codex review capacity is an external blocker. The connector returned a usage-limit response instead
  of posting the required review.
- #6023 is a stale rollback risk. Merging it would reduce live and sim probe budgets after the current
  promoted image has already reconciled successfully.
- Runtime trading is intentionally closed: proof floor `repair_only`, live submission disabled, and
  capital `zero_notional`. This is safe for capital exposure, but it is not a live-capital promotion.
- Quant ingestion remains informationally degraded, and execution TCA route-universe evidence remains
  incomplete for promotion.

## Rollback path

- If the current `44fd611a` image becomes unhealthy, open a fresh rollback PR against current `main`
  that restores the last known good Torghut manifest image digest and keeps the extended probe
  budgets unless evidence shows the probes caused the failure.
- If #5412 is later merged and causes runtime failure, revert the squash merge through a PR and allow
  release automation plus Argo CD to reconcile the reverted image.
- Runtime safety rollback remains to keep `TRADING_SIMPLE_SUBMIT_ENABLED=false`, live submission
  blocked, and `capital_state=zero_notional` until proof floor, route-universe, alpha readiness, and
  quant evidence clear.

Rollback triggers:

- `torghut`, `torghut-options`, or `symphony-torghut` becomes Degraded or stuck OutOfSync on current
  main.
- Active live/sim/options workloads lose readiness or restart repeatedly after the startup window.
- `/healthz` or `/trading/status` regresses from HTTP 200.
- Core dependencies in `/readyz` degrade beyond the documented business safety gates.

## Next action

Keep #5412 blocked until Codex review capacity is restored or a maintainer explicitly waives the
large-diff gate. Keep #6023 out of the merge lane; if a rollback is needed, generate it against
current main and current rollout evidence. Repeat PR checks and GitOps rollout verification before
any Torghut runtime merge.
