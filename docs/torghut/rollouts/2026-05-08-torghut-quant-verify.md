# Torghut quant verifier release gate - 2026-05-08

Release engineer: Julian Hart
Repository: `proompteng/lab`
Branch: `codex/swarm-torghut-quant-verify`
Base: `main`
Owner channel: `swarm://owner/trading`
Last refreshed: 2026-05-08T03:37:09Z

## Owner update message

Torghut rollout state is go after rollback, with one runtime PR still held no-go.

I merged #6014, `revert(torghut): rollback failed promotion
19432a44f628c25d18a537970058468eb3330cf1`, by squash at
`f82ea3e78bd398ebd0ff53744d86270a7cbc4835` after required checks were green. That reverted the
failed #6013 promotion at `19432a44f628c25d18a537970058468eb3330cf1`, whose post-deploy verifier
failed on Torghut `/readyz` with HTTP 504.

Argo CD now reports the `torghut` application `Synced` / `Healthy` at main revision
`1e3b516eecfbe0ee5a7c401b058b69c61ace25e5`. The last Torghut sync operation completed successfully
for rollback revision `f82ea3e78bd398ebd0ff53744d86270a7cbc4835`; subsequent main commits
`8f981ed88b8f6e7fac718b6546e67159ca6f2f80` and
`1e3b516eecfbe0ee5a7c401b058b69c61ace25e5` changed Jangar-only files, with no Torghut manifest,
Torghut service, or Torghut CI workflow diff from the rollback commit.

Current Torghut workloads are rolled out and available on the restored image digest
`sha256:a5f1bfde242b80a1c18d7776859dcb1b56d69c5ec5d742bb59b5244ec54c87a2`:
`torghut-00294-deployment`, `torghut-sim-00393-deployment`, `torghut-options-catalog`, and
`torghut-options-enricher`. Mainline `torghut-ci`, `torghut-post-deploy-verify`, `argo-lint`, and
`kubeconform` passed on the rollback commit, and Jangar CI/post-deploy verification passed after the
later Jangar dependency promotion.

Runtime trading promotion remains intentionally closed. Torghut `/healthz`, `/trading/status`, and
`/trading/revenue-repair` respond successfully; `/readyz` returns degraded because the business
safety gates are closed, not because the core rollout is unavailable. The revenue-repair digest
reports `business_state=repair_only`, `revenue_ready=false`,
`live_submission_reason=simple_submit_disabled`, `capital_state=zero_notional`, and
`max_notional=0`.

#5412, `feat(torghut): add profit escrow runtime projections`, remains no-go. It is clean,
mergeable, and green on hosted checks at head `9a4c424b4a855046408cbc7895381eccce233a9f`, with no
review threads, but the diff is 7,099 additions and 498 deletions. That exceeds the mandatory
large-diff Codex review threshold. The latest Codex review request returned the connector
usage-limit blocker at 2026-05-08T03:03:08Z instead of a posted review. Smallest unblocker: restore
Codex review capacity or record an explicit maintainer waiver, then resolve any review threads,
rerun required checks, and only then squash-merge.

## Open PR enumeration

- #5412, `feat(torghut): add profit escrow runtime projections`
  - Selected as the only open Torghut runtime PR.
  - Held no-go on the mandatory large-diff Codex review gate.
- #6006, `docs(torghut): record quant verify gate`
  - Selected as the audit PR for this release-engineering pass.
  - Updated to replace stale pre-rollback evidence with the final rollback and rollout record.
- #6014, `revert(torghut): rollback failed promotion 19432a44f628c25d18a537970058468eb3330cf1`
  - Selected as the unblock-first item after #6013 post-deploy failed.
  - Merged by squash after checks were green.
- #6013, `chore(torghut): promote image da8b6386`
  - Treated as the failed promotion to roll back.
  - Post-deploy verifier failed on `/readyz` HTTP 504.
- #5767 and #5316, older automated release PRs
  - Not selected because they are not the unblock-first path for the current Torghut runtime gate.

## PRs touched

- #5412
  - Rechecked mergeability, hosted checks, review threads, latest review blocker, and conflict state.
  - Validated the refreshed branch locally in a temporary worktree after the `services/torghut/app/main.py`
    merge conflict was resolved by preserving both mainline consumer-evidence receipts and the PR's
    profit-escrow runtime projections.
  - Did not merge because the large-diff review gate is unmet.
- #6006
  - Rebased the audit branch onto current `main`.
  - Refreshed this rollout record with the failed promotion, rollback merge, post-rollback evidence,
    transient degraded state, residual risk, and rollback path.
- #6014
  - Verified PR checks, mergeability, and scope before merge.
  - Squash-merged to restore the last healthy Torghut image digest.
- #6013
  - Verified failure evidence from the post-deploy workflow and cluster probes.
  - Confirmed it was rolled back by #6014.
- #6017 and #6019
  - Observed as Jangar-only follow-up commits after the Torghut rollback.
  - Confirmed they did not change Torghut manifests, Torghut service code, or Torghut CI workflows.
  - Waited for their Jangar CI/post-deploy checks to pass because Jangar is a Torghut dependency.

## Comments and conflicts

- #5412 currently reports `mergeStateStatus=CLEAN` and `mergeable=MERGEABLE`.
- #5412 has no posted reviews and no open review threads in the data returned by GitHub.
- #5412 remains blocked by policy because the required large-diff Codex review has not posted.
- The latest #5412 Codex review attempt was followed by the connector usage-limit response instead
  of a code review.
- The only #5412 code conflict observed during this pass was in `services/torghut/app/main.py`; the
  refreshed remote head now includes both mainline Jangar continuity evidence and the PR profit-escrow
  projection payloads.
- #6014 was clean and mergeable before squash merge.
- No direct production mutations were made from the local shell. Production movement happened through
  PR merge, release automation, and Argo CD reconciliation.
- Live release updates were published through `/usr/local/bin/codex-nats-publish --publish-general`.

## Validation

- PASS: NATS context soak was read before action with `/usr/local/bin/codex-nats-soak`; a broader
  general-channel read was also taken for recent teammate state.
- PASS: Open PRs were enumerated with `gh pr list --repo proompteng/lab --state open --limit 100`.
- PASS: #5412 hosted checks passed or were intentionally skipped on head
  `9a4c424b4a855046408cbc7895381eccce233a9f`, including:
  - `torghut-ci / Bytecode + pytest + coverage`
  - `torghut-ci / Pyright`
  - `torghut-ci / Quality signals (complexity + security)`
  - `CI / check_changed_files`
  - semantic commit and semantic PR title checks
- PASS: #5412 local validation in `/tmp/lab-pr5412-merge/services/torghut`:
  - `/root/.local/bin/uv sync --frozen --extra dev`
  - `/root/.local/bin/uv run --frozen ruff check app/main.py tests/test_trading_api.py`
  - `/root/.local/bin/uv run --frozen python scripts/check_migration_graph.py`
  - all three Pyright profiles: `pyrightconfig.json`, `pyrightconfig.alpha.json`, and
    `pyrightconfig.scripts.json`
  - targeted pytest set for trading API, consumer evidence, Jangar continuity, submission council,
    renewal-bond profit escrow, and executable-alpha receipts: 113 passed, 1 warning
- BLOCKED: #5412 changed lines are 7,597 total, above the 1,000-line Codex review gate; no Codex
  review has posted.
- PASS: #6014 PR checks were green before merge, including Torghut bytecode + pytest + coverage,
  Pyright, quality signals, semantic checks, and manifest validation.
- PASS: #6014 squash-merged at `f82ea3e78bd398ebd0ff53744d86270a7cbc4835`.
- PASS: `gh run watch 25534861744 --repo proompteng/lab --exit-status`; mainline `torghut-ci`
  passed on the rollback commit.
- PASS: `gh run watch 25534861747 --repo proompteng/lab --exit-status`;
  `torghut-post-deploy-verify` passed on the rollback commit.
- PASS: `gh run watch 25535170753 --repo proompteng/lab --exit-status`; Jangar CI passed after the
  later dependency promotion.
- PASS: `gh run watch 25535175186 --repo proompteng/lab --exit-status`; Jangar post-deploy
  verification passed after the later dependency promotion.
- PASS: `kubectl get application -n argocd torghut -o jsonpath=...`; Argo CD reports `Synced`,
  `Healthy`, revision `1e3b516eecfbe0ee5a7c401b058b69c61ace25e5`, operation `Succeeded`, and
  `successfully synced (no more tasks)`.
- PASS: `kubectl rollout status -n torghut deployment/torghut-00294-deployment --timeout=120s`.
- PASS: `kubectl rollout status -n torghut deployment/torghut-sim-00393-deployment --timeout=120s`.
- PASS: `kubectl rollout status -n torghut deployment/torghut-options-catalog --timeout=120s`.
- PASS: `kubectl rollout status -n torghut deployment/torghut-options-enricher --timeout=120s`.
- PASS: Current deployment availability shows all four Torghut runtime deployments available.
- PASS: Current service probes from the runner:
  - `/healthz`: HTTP 200
  - `/trading/status`: HTTP 200
  - `/trading/revenue-repair`: HTTP 200
  - `torghut-ws /readyz`: HTTP 200
- EXPECTED DEGRADED: Torghut `/readyz` returns HTTP 503 because business safety gates are closed.
- LIMITATION: The runner service account cannot list Knative Services or exec into Torghut pods, so
  rollout verification used Argo, Deployments, Pods, events, logs, service HTTP probes, and CI
  post-deploy artifacts.

## Deployment evidence

Rollback and GitOps state:

- Failed promotion PR: #6013
- Failed promotion commit: `19432a44f628c25d18a537970058468eb3330cf1`
- Failed image digest:
  `sha256:822106feadcbae3cf78241f0508533133339a995327325e4668870294d763f2b`
- Failed verifier: `torghut-post-deploy-verify` run `25534396528`
- Failure symptom: Torghut `/readyz` returned HTTP 504 and the subsequent readiness curl timed out.
- Rollback PR: #6014
- Rollback merge commit: `f82ea3e78bd398ebd0ff53744d86270a7cbc4835`
- Restored Torghut image digest:
  `sha256:a5f1bfde242b80a1c18d7776859dcb1b56d69c5ec5d742bb59b5244ec54c87a2`
- Current Argo comparison revision: `1e3b516eecfbe0ee5a7c401b058b69c61ace25e5`
- Current Argo health: `Synced` / `Healthy`
- Last Torghut operation revision: `f82ea3e78bd398ebd0ff53744d86270a7cbc4835`
- Last Torghut operation phase: `Succeeded`
- Argo message: `successfully synced (no more tasks)`

Workload readiness:

- `torghut-00294-deployment`: `1/1` ready and available.
- `torghut-sim-00393-deployment`: `1/1` ready and available.
- `torghut-options-catalog`: `1/1` ready and available.
- `torghut-options-enricher`: `1/1` ready and available.
- Current live pod `torghut-00294-deployment-7b944c8867-pxz5s` is Running with both containers
  ready after two user-container restarts during rollout recovery.
- Current sim pod `torghut-sim-00393-deployment-79df845bb6-cwr4c` is Running with both containers
  ready.

Runtime probes:

- `/healthz`: HTTP 200 with `{"status":"ok","service":"torghut"}`.
- `/trading/status`: HTTP 200 with build commit `7d88cb2a34d47c2d857c8c0824bbaa5d8cdcdcf4`.
- `/trading/revenue-repair`: HTTP 200 with `business_state=repair_only` and
  `revenue_ready=false`.
- `/readyz`: HTTP 503 degraded because safety gates remain closed.
- `torghut-ws /readyz`: HTTP 200 with `ready=true`.

Post-deploy artifacts:

- `torghut-post-deploy-verify` run `25534861747` passed on the rollback commit.
- Artifact `torghut-revenue-repair-25534861747-1` was uploaded.
- Revenue repair digest: `business_state=repair_only`, `revenue_ready=false`,
  `live_submission_allowed=false`, `live_submission_reason=simple_submit_disabled`,
  `proof_floor_state=repair_only`, `capital_state=zero_notional`, `max_notional=0`.
- Runtime blockers in the digest include `alpha_readiness_not_promotion_eligible`,
  `execution_tca_route_universe_incomplete`, `simple_submit_disabled`, and
  `quant_pipeline_stages_missing`.

Event review:

- A transient degraded window occurred after the rollback sync: the live Knative revision reported
  readiness/liveness probe failures and the `torghut-00294` user container restarted twice.
- The transient state recovered without local mutation; rollout status later completed and Argo
  returned to `Healthy`.
- Persistent hygiene noise remains: ClickHouse `MultiplePodDisruptionBudgets`,
  `torghut-keeper` `NoPods`, and an older failed `torghut-whitepaper-autoresearch-profit-target`
  pod. These are not tied to the rollback commit but should stay visible to operators.

## Risk

- #5412 is the main unmerged Torghut runtime risk. It changes profit-escrow runtime projections and
  must not merge until the large-diff review gate is satisfied.
- Codex code-review capacity is the blocker for #5412. The connector is returning the usage-limit
  response rather than a review.
- Torghut runtime trading remains in `repair_only` / zero-notional mode by design. That is the
  expected safety posture, but it is not a live-capital promotion.
- The live Torghut pod had transient liveness/readiness failures after rollback before recovering.
  A repeat of that behavior is a rollback trigger if it persists or expands beyond a single
  recovery window.
- Route-universe and execution-TCA evidence remain incomplete for live capital promotion.
- The runner service account lacks permissions for Knative Service listing and pod exec, so those
  checks were substituted with permitted Argo, Deployment, Pod, event, log, service-probe, and CI
  verifier evidence.

## Rollback path

- If the failed #6013 image digest reappears, revert the promotion or restore digest
  `sha256:a5f1bfde242b80a1c18d7776859dcb1b56d69c5ec5d742bb59b5244ec54c87a2` through a PR and let
  Argo CD reconcile.
- If the restored image digest becomes unstable, revert source commit
  `7d88cb2a34d47c2d857c8c0824bbaa5d8cdcdcf4`, let `torghut-build-push` produce the revert image,
  and let normal release automation open the GitOps promotion PR.
- Runtime safety rollback remains to keep live submission disabled and `capital_state=zero_notional`
  until route universe, execution TCA, alpha readiness, and quant pipeline evidence clear.
- #5412 needs no runtime rollback because it was not merged.

Rollback triggers:

- `torghut` becomes Degraded or stuck OutOfSync on the current main revision.
- Mainline Torghut checks fail on the current promotion or rollback commit.
- Active live/sim/options workloads lose readiness or restart repeatedly.
- `/healthz`, `/trading/status`, `/trading/revenue-repair`, or `torghut-ws /readyz` regress.
- Runtime blockers expand beyond the documented safety-gate posture into core dependency failure,
  including Postgres, ClickHouse, Alpaca, or universe resolution failure.

## Next action

Merge #6006 only after its docs-only checks are green. Keep #5412 open and blocked. The next release
captain should not merge #5412 until Codex review capacity is restored or a maintainer explicitly
waives the large-diff gate. After that, refresh against current `main`, resolve all review threads,
rerun required checks, squash-merge only with all required checks green, and repeat GitOps, workload,
post-deploy, and event verification.
