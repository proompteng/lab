# Torghut Quant Release Verification

Timestamp: 2026-05-05T16:04:00Z
Repository: `proompteng/lab`
Base: `main`
Release branch: `codex/swarm-torghut-quant-verify`

## Gate Decision

No-go for the remaining Torghut implementation PR.

Open Torghut PRs at verification start:

- #5412, `feat(torghut): add evidence epochs and shared live gate`, was clean, non-draft, and green, but changed
  3,165 total lines. The required large-diff Codex review did not post because `chatgpt-codex-connector` returned a
  code-review usage-limit message. I did not merge it without a posted Codex review and resolved threads, or an explicit
  maintainer waiver.
- #5458, `chore(torghut): promote image 02ffd49f`, was conflict-blocked and superseded by the newer Torghut image
  already promoted on `main`. I closed it as unsafe to repair because merging it would roll production backward.
- #5467, `chore(torghut): promote image 0c28a908`, was conflict-blocked and superseded by the newer Torghut image
  already promoted on `main`. I closed it as unsafe to repair because merging it would roll production backward.

No Torghut PR was squash-merged during this verification pass.

## PR Comment Updates

- #5412 progress comment updated through `services/jangar/scripts/codex/codex-progress-comment.ts`:
  https://github.com/proompteng/lab/pull/5412#issuecomment-4378206627.
- #5458 closed with a superseded-release comment:
  https://github.com/proompteng/lab/pull/5458.
- #5467 closed with a superseded-release comment:
  https://github.com/proompteng/lab/pull/5467.

## Rollout Evidence

Direct Argo CD Application reads were blocked by Kubernetes RBAC for
`system:serviceaccount:agents:agents-sa`, so sync health could not be confirmed from the Argo Application CRs in this
runner. The smallest unblocker is read-only `get`/`list` access to `applications.argoproj.io` in namespace `argocd`, or
an Argo CD credential with equivalent read access.

GitOps/source parity:

- `origin/main` manifest `argocd/applications/torghut/knative-service.yaml` points at
  `registry.ide-newton.ts.net/lab/torghut@sha256:8e6702020cdfcb633ac2cf28324a8aed93943c25ee584baa766873e37e1dd99d`.
- The active Torghut pod `torghut-00213-deployment-7bd7f7dcb9-sz9z4` was Running and Ready with user container image
  digest `sha256:8e6702020cdfcb633ac2cf28324a8aed93943c25ee584baa766873e37e1dd99d`.
- `origin/main` reports `TORGHUT_VERSION=v0.568.3-2-g90e95ffb0` and
  `TORGHUT_COMMIT=90e95ffb0ddebf31d0eddd5e59195a8f00786f4f`, matching `/trading/status` from the live service.

Workload readiness:

- Torghut namespace pods were Running and ready at inspection, including active `torghut-00213`, active
  `torghut-sim-00292`, ClickHouse, CNPG, Symphony, options catalog/enricher, TA, TA sim taskmanagers, and guardrail
  exporters.
- Live Torghut `/healthz`, `/readyz`, `/trading/status`, `/trading/health`, and
  `/trading/profitability/runtime` returned HTTP 200.
- Sim Torghut `/healthz` returned HTTP 200. Sim `/readyz` returned HTTP 200 with a slower 4.38 second response after an
  earlier 5 second probe timeout.
- Options catalog and options enricher `/healthz` endpoints returned HTTP 200.

Event and log notes:

- Recent Torghut events included liveness/readiness probe 503s for `torghut-ws` and `torghut-ws-options`, followed by
  restarts. Both pods were Ready at inspection, with restart counts 6 and 2 respectively.
- Recent events also included a Flink `torghut-ta-sim` `JobException` before returning to Running, plus repeated
  PodDisruptionBudget selection warnings for ClickHouse.
- `torghut-ws` logs showed Kafka produce success around the inspection time.
- `torghut-ws-options` logs showed repeated Alpaca message decode warnings while continuing to run.

## Risk And Rollback

Residual risks:

- #5412 remains blocked by missing Codex review capacity, not by CI, conflicts, or review threads. It must not merge until
  a Codex review posts and all threads resolve, unless a maintainer explicitly waives that gate.
- Argo Application sync/health is not directly observable from this runner due RBAC. Workload and source parity are
  available, but direct GitOps health remains an access blocker.
- Streaming sidecars are currently Ready but have recent probe failures and restarts. Treat another liveness loop or
  sustained readiness 503 as a rollout-health blocker.
- Sim readiness is healthy with a longer response time. Treat sustained `/readyz` latency above probe timeout as a
  rollback trigger for sim-facing promotion.

Rollback path:

- For the current main rollout, revert the Torghut image promotion commit `f551d8c7c` or open a new GitOps promotion PR
  to the last known-good Torghut image, then let Argo CD reconcile.
- If #5412 later merges and live submission health regresses, revert the shared live-gate code/config change or promote a
  prior image through the normal release PR flow. Preserve append-only evidence epoch, receipt, and profit-window records
  for audit continuity.
- For stream instability, roll back the relevant `torghut-ws` or `torghut-ws-options` image via GitOps and keep the main
  Torghut service unchanged unless live readiness or trading health also regresses.

## Owner Update Message

Merge gate is no-go. #5412 is clean and green, but it changes 3,165 lines and the required Codex review did not post; the
connector returned a usage-limit error, so I did not merge it. I closed #5458 and #5467 because main already runs a newer
Torghut image, and repairing those conflicting PRs would have created a rollback. Current rollout evidence is mostly
healthy at the workload layer: active Torghut live and sim pods are Running/Ready on the main manifest digest, live and
sim readiness endpoints returned HTTP 200, and options health endpoints are 200. Residual risk is streaming-sidecar
instability from recent `torghut-ws` and `torghut-ws-options` probe failures/restarts, plus Argo Application CR access is
blocked for this runner. Next action is to restore Codex review capacity or provide an explicit maintainer waiver, then
re-check #5412 review threads, required checks, and Argo/workload health before merge.

## Next Action

Restore Codex review capacity or provide an explicit maintainer waiver for #5412. After that, re-check review threads,
conflicts, required checks, Argo sync/health, workload readiness, and recent warning events before any squash merge.
