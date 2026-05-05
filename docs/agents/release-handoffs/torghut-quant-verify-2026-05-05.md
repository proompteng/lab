# Torghut Quant Release Verification

Timestamp: 2026-05-05T16:30:00Z
Repository: `proompteng/lab`
Base: `main`
Release branch: `codex/swarm-torghut-quant-verify`
Audit PR: #5496

## Gate Decision

Go for the Torghut image promotion that became available during verification; no-go for the remaining large
implementation PR.

PR outcomes:

- #5494, `chore(torghut): promote image 2ea968af`, was a small GitOps image promotion with 44 total changed lines. It
  was clean, comment-clean, and green across `torghut-ci`, `argo-lint`, `kubeconform`, semantic title, and semantic
  commit checks. It was squash-merged at 2026-05-05T16:12:33Z with merge commit
  `2dbe57a9872dac681d6f8cdce021996243f70197`.
- #5412, `feat(torghut): add evidence epochs and shared live gate`, remains open and no-go. It is clean and green but
  changes 3,165 total lines, so the large-diff Codex review gate applies. The Codex review request returned a
  `chatgpt-codex-connector` usage-limit response instead of a posted review. I did not merge it without a posted Codex
  review and resolved threads, or an explicit maintainer waiver.
- #5458, `chore(torghut): promote image 02ffd49f`, was conflict-blocked and superseded by newer Torghut images. I closed
  it as unsafe to repair because merging it would roll production backward.
- #5467, `chore(torghut): promote image 0c28a908`, was conflict-blocked and superseded by newer Torghut images. I closed
  it as unsafe to repair because merging it would roll production backward.

## PR Comment Updates

- #5412 progress comment updated through `services/jangar/scripts/codex/codex-progress-comment.ts`:
  https://github.com/proompteng/lab/pull/5412#issuecomment-4378206627.
- #5458 closed with a superseded-release comment:
  https://github.com/proompteng/lab/pull/5458.
- #5467 closed with a superseded-release comment:
  https://github.com/proompteng/lab/pull/5467.
- #5496 progress comment updated through `services/jangar/scripts/codex/codex-progress-comment.ts`:
  https://github.com/proompteng/lab/pull/5496#issuecomment-4380989574.

## Rollout Evidence

Direct Argo CD Application reads were blocked by Kubernetes RBAC for
`system:serviceaccount:agents:agents-sa`, so sync health could not be confirmed from the Argo Application CRs in this
runner. The smallest unblocker is read-only `get`/`list` access to `applications.argoproj.io` in namespace `argocd`, or
an Argo CD credential with equivalent read access.

GitOps/source parity:

- `origin/main` now contains #5494 at `2dbe57a9872dac681d6f8cdce021996243f70197`.
- `origin/main` manifest `argocd/applications/torghut/knative-service.yaml` points at
  `registry.ide-newton.ts.net/lab/torghut@sha256:6ee3ec45802d336b0e6626e942d380a9bb47bb375f0901012d80e653f76c127b`.
- `origin/main` reports `TORGHUT_VERSION=v0.568.4-9-g2ea968afb` and
  `TORGHUT_COMMIT=2ea968afb40aab74c57016e0f9ecfd3d37ccb05f`.

Workload readiness after #5494:

- Active live pod `torghut-00214-deployment-5c4d6f4697-pswkt` was Running and Ready on
  `sha256:6ee3ec45802d336b0e6626e942d380a9bb47bb375f0901012d80e653f76c127b` with zero restarts.
- Active sim pod `torghut-sim-00293-deployment-6bf6cdc698-mm22b` was Running and Ready on the same digest with zero
  restarts.
- Live Torghut `/readyz`, `/trading/status`, and `/trading/health` returned HTTP 200. `/trading/status` reported
  `v0.568.4-9-g2ea968afb`, commit `2ea968afb40aab74c57016e0f9ecfd3d37ccb05f`, and active revision `torghut-00214`.
- Sim Torghut `/readyz` returned HTTP 200.
- `torghut-ta`, `torghut-ta-sim`, and their taskmanager pods were Running and ready after Flink reconciliation.
- The #5494 migration job reconciled on the new digest and then disappeared after completion/cleanup.
- Options catalog initially held readiness at HTTP 503, then warmed up and returned HTTP 200 on repeated `/readyz` polls.
  The pod logged `options catalog provisional hot-set ready pages=1 contracts=10000 hot=160 warm=800`.
- Options enricher `/readyz` returned HTTP 200 with a fresh success timestamp.

Event notes:

- Expected transient rollout warnings appeared while old revisions and Flink jobs were replaced: startup/readiness probe
  failures, a temporary `torghut-ta-sim` missing job, and old-pod readiness failures during shutdown.
- Follow-up evidence showed active live/sim pods, TA, TA-sim, and options pods all Running and ready. No new stuck pod or
  sustained readiness failure remained in the checked surface.

## Risk And Rollback

Residual risks:

- #5412 remains unmerged because Codex review capacity is exhausted. It should stay blocked until a Codex review posts
  and all resulting threads resolve, or until a maintainer explicitly waives the gate.
- Direct Argo Application CR reads are blocked for `system:serviceaccount:agents:agents-sa`; use a credential with
  Application read access for direct sync inspection.
- Streaming sidecars `torghut-ws` and `torghut-ws-options` were Ready during final inspection but had recent liveness
  restarts before #5494. Treat another liveness loop or sustained readiness 503 as a rollout-health blocker.

Rollback path:

- For #5494, revert merge commit `2dbe57a9872dac681d6f8cdce021996243f70197` or open a new GitOps promotion PR to the
  previous known-good Torghut image, then let Argo CD reconcile.
- If #5412 later merges and live submission health regresses, revert the shared live-gate code/config change or promote a
  prior image through the normal release PR flow. Preserve append-only evidence epoch, receipt, and profit-window records
  for audit continuity.
- For stream instability, roll back the relevant `torghut-ws` or `torghut-ws-options` image via GitOps and keep the main
  Torghut service unchanged unless live readiness or trading health also regresses.

## Owner Update Message

Rollout gate is green for #5494. I squash-merged the small Torghut image promotion after all checks passed, and the
cluster reconciled active live/sim pods to digest `6ee3ec45` with zero restarts. Live `/readyz`, `/trading/status`, and
`/trading/health` are 200, sim `/readyz` is 200, TA and TA-sim are Running, and the options catalog holdback cleared after
the hot-set worker logged provisional readiness for 160 hot and 800 warm contracts. #5412 remains a no-go because the
required Codex review still has not posted due the connector usage-limit response. Argo Application CR sync/health remains
an access blocker from this runner, so the direct evidence is source parity plus workload, endpoint, and event checks.
Rollback for #5494 is a revert of `2dbe57a9872dac681d6f8cdce021996243f70197` or a GitOps promotion PR to the previous
known-good image.

## Next Action

Restore Codex review capacity or provide an explicit maintainer waiver for #5412. After that, re-check review threads,
conflicts, required checks, Argo sync/health, workload readiness, and recent warning events before any squash merge.
