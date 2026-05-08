# Torghut quant verifier release gate - 2026-05-08

Release engineer: Julian Hart
Repository: `proompteng/lab`
Branch: `codex/swarm-torghut-quant-verify`
Base: `main`
Owner channel: `swarm://owner/trading`
Last refreshed: 2026-05-08T04:59:13Z

## Owner update message

Current merge state is no-go for #5412 and healthy for the already-merged Torghut promotion on
main.

#5412, `feat(torghut): add profit escrow runtime projections`, is open, non-draft, `CLEAN`,
`MERGEABLE`, and green on visible hosted checks at head
`649b7b68c6b446a1bc434d1b9be547d2d90b53c6`. I did not squash-merge it because the diff is 7,087
additions and 485 deletions, which exceeds the mandatory 1,000-line Codex review threshold. I
requested Codex review again for the current head at 2026-05-08T04:56Z, and the connector replied
with the usage-limit blocker instead of a posted review. There are no visible GitHub reviews and no
review threads.

The current in-cluster Torghut rollout is healthy for main revision
`05120af0507fde710e94cf3c6301f3c7f8f97a9e`, `chore(torghut): promote image 5bca70f4 (#6038)`.
Argo CD reports `torghut`, `torghut-options`, and `symphony-torghut` as `Synced` and `Healthy`.
The active Torghut service revision is `torghut-00299`, build commit
`5bca70f421b2247b4b7a7b847f74cb5222ba48ac`, with live and sim deployments available and ready.
Runtime trading remains intentionally closed: proof floor `repair_only`, capital state
`zero_notional`, and live submission blocked by `simple_submit_disabled`.

## Open PR enumeration

- #5412, `feat(torghut): add profit escrow runtime projections`
  - Selected as the only open Torghut runtime PR in the current inventory.
  - No-go for merge: blocked by the large-diff Codex review gate.
- #5889, `feat(jangar): add repair warrant exchange`
  - Not selected: Jangar control-plane scope, not Torghut.
- #6039, `feat(jangar): inject swarm mission contracts`
  - Not selected: Jangar mission-contract scope, not Torghut.
- #5767, `chore(release/c3ba60b): automated release PR`
  - Not selected: release automation PR outside this Torghut quant runtime gate.
- #5316, `chore(release/735ddbc): automated release PR`
  - Not selected: release automation PR outside this Torghut quant runtime gate.

## PRs touched

- #5412
  - Rechecked mergeability, hosted checks, review state, comments, review threads, and changed-line
    count.
  - Posted a fresh `@codex review` request for the current head:
    https://github.com/proompteng/lab/pull/5412#issuecomment-4403461823
  - Observed the connector usage-limit response:
    https://github.com/proompteng/lab/pull/5412#issuecomment-4403462484
  - Updated the anchored Codex progress comment on the PR:
    https://github.com/proompteng/lab/pull/5412#issuecomment-4378206627
  - Kept open and unmerged.
- #6038
  - Used as the current merged Torghut promotion for rollout evidence.
  - Merge commit `05120af0507fde710e94cf3c6301f3c7f8f97a9e` is reconciled in-cluster.

## Comments and conflicts resolved

- #5412 reports `mergeStateStatus=CLEAN` and `mergeable=MERGEABLE`.
- #5412 has no visible posted GitHub review and no review threads.
- #5412 remains blocked by policy because the required Codex review did not post.
- The latest #5412 Codex review request was followed by the connector usage-limit response instead
  of a review.
- No code conflicts required local resolution in this pass.
- No direct production mutation was made. Production movement remains PR merge plus GitOps
  reconciliation only.

## Merge outcomes

- #5412: not merged. Merge gate is blocked on Codex review capacity or an explicit maintainer
  waiver, followed by any review-thread resolution and green checks.
- No selected Torghut code PR was squash-merged during this pass.
- #6038 was already merged before this pass and was verified in-cluster as the current rollout.

## Validation

- PASS: NATS context soak read with `/usr/local/bin/codex-nats-soak`; it fetched 25 general-channel
  messages and filtered 0 for this branch.
- PASS: Open PR inventory from
  `gh pr list -R proompteng/lab --state open --limit 100 --json ...`.
- PASS: #5412 visible hosted checks are complete with success or intentional skip at head
  `649b7b68c6b446a1bc434d1b9be547d2d90b53c6`, including Torghut bytecode and pytest, Pyright,
  quality signals, changed-file checks, semantic commits, and semantic PR title.
- PASS: GitHub PR data reports #5412 as `CLEAN` and `MERGEABLE`.
- PASS: GitHub review data reports no latest reviews and no review threads for #5412.
- BLOCKED: The required Codex large-diff review did not post; the connector returned a usage-limit
  response at 2026-05-08T04:56:33Z.
- PASS: #6038 release PR merged at 2026-05-08T04:51:47Z with release, Argo, and Torghut checks
  successful or intentionally skipped.
- PASS: `kubectl get applications.argoproj.io -n argocd torghut torghut-options symphony-torghut`
  reports all three apps `Synced` and `Healthy` at revision
  `05120af0507fde710e94cf3c6301f3c7f8f97a9e`.
- PASS: `kubectl get deployments -n torghut ...` reports active live, sim, options, websocket, and
  TA deployments available and ready.
- PASS: `curl -fsS http://torghut.torghut.svc.cluster.local/healthz` returns HTTP 200 with
  `{"status":"ok","service":"torghut"}`.
- PASS: `curl -fsS http://torghut.torghut.svc.cluster.local/trading/status` returns HTTP 200 and
  reports `running=true`, mode `live`, build commit
  `5bca70f421b2247b4b7a7b847f74cb5222ba48ac`, active revision `torghut-00299`, proof floor
  `repair_only`, and capital state `zero_notional`.
- LIMITATION: The service account cannot list Knative Services, so rollout verification used Argo
  Application status, Deployments, Pods, events, and in-cluster HTTP service access from the runner.

## Deployment evidence

- No new rollout was triggered from #5412 because no merge occurred.
- Current main revision: `05120af0507fde710e94cf3c6301f3c7f8f97a9e`
- Current main commit subject: `chore(torghut): promote image 5bca70f4 (#6038)`
- Current Torghut runtime build commit:
  `5bca70f421b2247b4b7a7b847f74cb5222ba48ac`
- Current Torghut image digest in GitOps manifests:
  `sha256:c70d26e2c5e300a2ff4ac5f3cedaaf0bde670897bdc800c39cd97aaf3a1e51fa`
- Active Torghut service revision: `torghut-00299`
- Argo state:
  - `torghut`: `Synced` / `Healthy`
  - `torghut-options`: `Synced` / `Healthy`
  - `symphony-torghut`: `Synced` / `Healthy`
- Workload readiness:
  - `torghut-00299-deployment`: `1/1` available
  - `torghut-sim-00398-deployment`: `1/1` available
  - `torghut-options-catalog`: `1/1` available
  - `torghut-options-enricher`: `1/1` available
  - `torghut-ws`, `torghut-ws-options`, `torghut-ta`, and `torghut-ta-sim`: `1/1` available
- Event review:
  - Recent live and sim revision startup warnings were transient; active pods are now ready.
  - The older `torghut-whitepaper-autoresearch-profit-target-8r6w6` Argo Workflow pod remains
    failed from 2026-05-07 and is unrelated to the #6038 rollout gate.

## Risk

- #5412 remains the main unmerged Torghut runtime risk. Its code path is green on visible checks but
  cannot merge without the required large-diff Codex review or explicit maintainer waiver.
- Codex review capacity is an external blocker. The connector returned a usage-limit response instead
  of posting the required review.
- Runtime trading is intentionally closed: proof floor `repair_only`, live submission disabled, and
  capital `zero_notional`. This is safe for capital exposure, but it is not a live-capital promotion.
- Quant ingestion remains informationally degraded, and alpha readiness still blocks promotion.
- A stale failed whitepaper autoresearch Workflow pod remains in the namespace; it is not blocking
  the current service rollout but should stay visible as operational noise.

## Rollback path

- If the current `5bca70f4` rollout becomes unhealthy, open a fresh rollback PR against current
  `main` that restores the previous healthy Torghut image digest from #6032,
  `sha256:68618ea3f8c9924bcf7ba2523423bf45ec893ab41cc2c35c529dd1d1d83ba8e0`, while preserving the
  extended probe budgets unless evidence shows the probes caused the failure.
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
- Core runtime dependencies degrade beyond the documented business safety gates.

## Next action

Keep #5412 blocked until Codex review capacity is restored or a maintainer explicitly waives the
large-diff gate. After that, rerun #5412 checks, resolve any review threads, squash-merge only if all
required checks are green, and then verify the resulting release PR plus Argo CD rollout before
declaring the Torghut quant PR production-ready.
