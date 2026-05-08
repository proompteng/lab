# Torghut quant verifier release gate - 2026-05-08

Release engineer: Julian Hart
Repository: `proompteng/lab`
Branch: `codex/swarm-torghut-quant-verify`
Base: `main`
Owner channel: `swarm://owner/trading`
Last refreshed: 2026-05-08T08:25:00Z

## Owner update message

Merge gate is no-go for #5412. The PR is open, non-draft, conflict-free, and green on hosted checks at
head `489ef179d7d6b8c5fae0cbbc9f339876db3c32f5`, but it is still above the large-diff review threshold
at 8,074 additions and 617 deletions. There is no posted Codex review and no review thread; the latest
`@codex review` request for this head returned the Codex usage-limit blocker at 2026-05-08T08:11:33Z.

The audit PR for this pass, #6066, merged at `f45234fc501469f947ad8c055e50ebfb95e6565f`. Current main
then advanced to `819e30031328b4b6f0d5fbc51cd6078589ecee64` via #6067, #6068, and #6070. The Torghut
rollout remains healthy: Argo CD reports `torghut`, `torghut-options`, and `symphony-torghut` as `Synced`
and `Healthy`. Live and sim Torghut workloads are ready on image digest
`sha256:056d6b0bc237adec3e3aa5e89a3f08ee81523ec18d8374c4a4e7d072e436f0f3`, runtime build commit
`809276e6db88bf4546f3fc6c75bd16c54815fb1d`, active revision `torghut-00302`.

Trading remains intentionally capital-safe: `/trading/status` reports `floor_state=repair_only`,
`route_state=repair_only`, `capital_state=zero_notional`, `max_notional=0`, and live submission blocked by
`simple_submit_disabled`. The smallest blocker preventing revenue impact is the missing large-diff Codex
review or explicit maintainer waiver for #5412; after that, the runtime still needs alpha-readiness and
live-submission gates to clear before non-zero notional.

## Governing requirements

- `docs/torghut/design-system/current-source-of-truth-and-priority-guide-2026-03-09.md` keeps deployed
  runtime source of truth in `argocd/applications/torghut/**`, `services/torghut/README.md`, and
  `services/torghut/app/config.py`.
- `docs/torghut/design-system/v6/182-torghut-route-proven-profit-receipts-and-consumer-evidence-canary-2026-05-08.md`
  requires route-proven profit evidence, explicit route repair packets, and paper/live notional held at zero when the
  receipt boundary is not promotion-authoritative.
- `docs/torghut/design-system/v1/architecture-and-context.md` defines GitOps manifests under
  `argocd/applications/torghut/**` as the production deployment source of truth and requires explicit namespace
  checks for workload health.

## Open PR enumeration

- #5412, `feat(torghut): add profit escrow runtime projections`
  - Selected as the only open Torghut runtime PR in this inventory.
  - Merge gate: no-go. Checks are green and merge state is clean, but the large-diff Codex review has not posted.
- #6060, `docs(jangar): refresh control plane release gate`
  - Not selected: Jangar verifier documentation scope, not Torghut runtime scope.
- #5889, `feat(jangar): add repair warrant exchange`
  - Not selected: Jangar control-plane scope, not Torghut runtime scope.
- #5767, `chore(release/c3ba60b): automated release PR`
  - Not selected: older automated release PR outside the Torghut quant runtime gate.
- #5316, `chore(release/735ddbc): automated release PR`
  - Not selected: older automated release PR outside the Torghut quant runtime gate.

## PRs touched

- #5412
  - Rechecked mergeability, hosted checks, review state, comments, review threads, and changed-line count.
  - Latest reviewed head: `489ef179d7d6b8c5fae0cbbc9f339876db3c32f5`.
  - Latest Codex review request:
    https://github.com/proompteng/lab/pull/5412#issuecomment-4404817379
  - Latest connector blocker:
    https://github.com/proompteng/lab/pull/5412#issuecomment-4404818477
  - Kept open and unmerged.
- Current main rollout
  - Verified current main `819e30031328b4b6f0d5fbc51cd6078589ecee64` in Argo CD and live Torghut workloads.
  - No direct production mutation was made from the local shell.

## Comments and conflicts resolved

- #5412 reports `mergeStateStatus=CLEAN` and `mergeable=MERGEABLE`.
- #5412 has zero review threads and no posted GitHub reviews.
- #5412 is comment-clean except for the unresolved policy blocker: every latest Codex review request returns the
  usage-limit response instead of a review.
- No merge conflict required local resolution in this pass.
- No service code was changed in this pass.

## Merge outcomes

- #5412: not merged. Merge is blocked by the mandatory large-diff Codex review gate.
- No selected Torghut code PR was squash-merged during this pass.
- Current main rollout was verified only; it was not mutated from this workspace.

## Validation

- PASS: memory retrieval completed with prior Torghut release-gate context.
- PASS: NATS context soak with `/usr/local/bin/codex-nats-soak` wrote `.codex-nats-context.json`; it fetched 25
  general-channel messages and filtered 0 relevant messages.
- PASS: open PR inventory from
  `gh pr list -R proompteng/lab --state open --limit 100 --json number,title,headRefName,baseRefName,...`.
- PASS: `gh pr view 5412 -R proompteng/lab --json ...` reports head
  `489ef179d7d6b8c5fae0cbbc9f339876db3c32f5`, `CLEAN`, `MERGEABLE`, 8,074 additions, and 617 deletions.
- PASS: `gh pr checks 5412 -R proompteng/lab --watch --interval 20` reports all non-skipped checks passing,
  including `Bytecode + pytest + coverage`, `Pyright`, `Quality signals (complexity + security)`,
  `agents-ci / integration` after 14m46s, `agents-ci / validate`, `jangar-ci / lint-and-typecheck / run`,
  `check_changed_files`, semantic commits, and semantic PR title.
- PASS: `gh api repos/proompteng/lab/pulls/5412/reviews --paginate` returned no reviews.
- PASS: `gh api graphql ... reviewThreads(first:100)` returned `totalCount=0`.
- BLOCKED: the latest `@codex review` request returned the Codex usage-limit response instead of posting a review.
- PASS: `kubectl get applications.argoproj.io -n argocd torghut torghut-options symphony-torghut ...` reports all
  three apps `Synced` and `Healthy`; final revision evidence is recorded in this run's handoff artifact because main
  continued advancing while this audit branch was rebased.
- PASS: `kubectl get deploy -n torghut ...` reports live, sim, options, websocket, and TA deployments ready and
  available.
- PASS: `kubectl get events -n torghut --sort-by=.lastTimestamp` returned no current namespace events.
- PASS: `curl -fsS http://torghut.torghut.svc.cluster.local/healthz` returns HTTP 200 with
  `{"status":"ok","service":"torghut"}`.
- PASS: `curl -fsS http://torghut.torghut.svc.cluster.local/trading/status | jq ...` reports the runtime build,
  proof floor, live-submission gate, TCA route evidence, and capital state.
- PASS: `curl -fsS http://torghut.torghut.svc.cluster.local/trading/consumer-evidence | jq ...` returns HTTP 200
  with schema `torghut.consumer-evidence-status.v1`, fresh empirical jobs, and candidate
  `chip-paper-microbar-composite@execution-proof`.
- LIMITATION: this service account cannot read Knative `services.serving.knative.dev` or `revisions.serving.knative.dev`;
  rollout verification used Argo CD Application state, Deployments, Pods, events, and in-cluster HTTP service access.

## Deployment evidence

- No new rollout was triggered from #5412 because no merge occurred.
- Audit PR #6066 merge revision: `f45234fc501469f947ad8c055e50ebfb95e6565f`.
- Current main revision: `819e30031328b4b6f0d5fbc51cd6078589ecee64`.
- Current main subject: `docs(torghut): define session route microcanaries (#6070)`.
- Current main changes after #6066 include #6068, `fix(torghut): bound autoresearch replay budget`, and #6070,
  `docs(torghut): define session route microcanaries`; both were checked for CI status and rollout health.
- Torghut GitOps image digest in current manifests:
  `sha256:056d6b0bc237adec3e3aa5e89a3f08ee81523ec18d8374c4a4e7d072e436f0f3`.
- Runtime build: `v0.568.5-541-g809276e6d`.
- Runtime build commit: `809276e6db88bf4546f3fc6c75bd16c54815fb1d`.
- Active revision from `/trading/status`: `torghut-00302`.
- Argo state:
  - `torghut`: `Synced` / `Healthy`
  - `torghut-options`: `Synced` / `Healthy`
  - `symphony-torghut`: `Synced` / `Healthy`
- Workload readiness:
  - `torghut-00302-deployment`: `1/1` ready, available, and updated
  - `torghut-sim-00400-deployment`: `1/1` ready, available, and updated
  - `torghut-options-catalog`: `1/1` ready, available, and updated
  - `torghut-options-enricher`: `1/1` ready, available, and updated
  - `torghut-ws`, `torghut-ws-options`, `torghut-ta`, and `torghut-ta-sim`: `1/1` ready and available

## Runtime and value-gate evidence

- `post_cost_daily_net_pnl`: no positive live revenue impact can be claimed from this pass. Current runtime remains
  zero-notional; #5412 is the smallest unmerged blocker for additional profit-evidence projection.
- `routeable_candidate_count`: current proof-floor execution TCA dimension reports one routeable symbol candidate and
  the consumer-evidence route reports candidate `chip-paper-microbar-composite@execution-proof`.
- `zero_notional_or_stale_evidence_rate`: capital is held at `zero_notional`, `max_notional=0`, and
  quant ingestion is degraded with `quant_pipeline_stages_missing`.
- `fill_tca_or_slippage_quality`: execution TCA reports 7,334 orders, 7,245 filled executions, average absolute
  slippage `13.8203637593029676` bps versus the 8 bps guardrail, and route-universe exclusions enforced.
- `capital_gate_safety`: live submission is not allowed; blockers are `simple_submit_disabled` and
  `alpha_readiness_not_promotion_eligible`.

## Risk

- #5412 remains the main Torghut runtime blocker. Its checks are green, but the required large-diff Codex review is
  not posted.
- The Codex review blocker is outside the local release engineer's control: the connector reports usage limits.
- Runtime trading remains safe but revenue-inactive: proof floor `repair_only`, capital state `zero_notional`, and
  live submission disabled.
- Quant ingestion remains degraded, and alpha readiness is not promotion-eligible.

## Rollback path

- If the current `809276e6` rollout becomes unhealthy, open a rollback PR against current `main` that restores the
  previous healthy Torghut digest, then let release automation and Argo CD reconcile. Do not mutate production
  directly from a local shell.
- If #5412 is later merged and regresses runtime health, revert the squash merge through a PR and allow release
  automation plus GitOps reconciliation to promote the reverted image.
- Keep `TRADING_SIMPLE_SUBMIT_ENABLED=false`, live submission blocked, and `capital_state=zero_notional` until proof
  floor, alpha readiness, quant evidence, and review gates are all clear.

Rollback triggers:

- Any of `torghut`, `torghut-options`, or `symphony-torghut` becomes Degraded or stuck OutOfSync.
- Live/sim/options/websocket/TA workloads lose readiness after the startup window.
- `/healthz`, `/trading/status`, or `/trading/consumer-evidence` regresses from HTTP 200.
- Proof floor advances capital away from zero before the documented gates clear.

## Next action

Restore Codex review capacity or record an explicit maintainer waiver for #5412. Then rerun #5412 hosted checks,
resolve any review findings, squash-merge only if all checks are green, and verify the resulting release PR plus Argo
CD rollout before declaring the Torghut quant PR production-ready.
