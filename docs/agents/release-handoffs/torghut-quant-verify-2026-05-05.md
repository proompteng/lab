# Torghut Quant Release Verification

Timestamp: 2026-05-05T16:55:13Z
Repository: `proompteng/lab`
Base: `main`
Release branch: `codex/swarm-torghut-quant-verify`
Audit PR: #5496

## Gate Decision

Go for the selected small Torghut release and safety PRs. No-go remains in place for the large implementation PR and
for live order submission.

PR outcomes:

- #5494, `chore(torghut): promote image 2ea968af`, was clean, comment-clean, and green across Torghut CI, Argo lint,
  kubeconform, semantic title, and semantic commit checks. It was squash-merged at 2026-05-05T16:12:33Z with merge
  commit `2dbe57a9872dac681d6f8cdce021996243f70197`.
- #5503, `fix(torghut): clean argo rollout drift`, was a small follow-up cleanup for drift after #5494. It updated the
  options TA restart nonce, removed a blank DSPy artifact hash from the sim Knative service, and moved the whitepapers
  bootstrap job from `Skip` to `PostSync` hook semantics. It was merged at 2026-05-05T16:36:29Z with merge commit
  `b653bd4fd6faeb39ab78a1eea4d2b6f2ed299f4a`.
- #5507, `fix(torghut): narrow paper lane to executable chip core`, passed every visible required check and had no
  comments or review threads. It was merged at 2026-05-05T16:48:21Z with merge commit
  `d73020e67ff5409786f2c1c9984d03575c648088`.
- #5412, `feat(torghut): add evidence epochs and shared live gate`, remains open and no-go. It is clean and green, but
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

Direct Argo CD Application, Knative Service, Knative Revision, and FlinkDeployment reads were blocked by Kubernetes RBAC
for `system:serviceaccount:agents:agents-sa`. The smallest unblocker is read-only `get`/`list` access to those resources,
or an Argo CD credential with equivalent read access.

GitOps/source parity:

- `origin/main` contains the selected merges through #5507 at `d73020e67ff5409786f2c1c9984d03575c648088`.
- `origin/main` keeps the Torghut runtime image at
  `registry.ide-newton.ts.net/lab/torghut@sha256:6ee3ec45802d336b0e6626e942d380a9bb47bb375f0901012d80e653f76c127b`.
- The cluster `torghut-ws-config` ConfigMap now has `SYMBOLS=NVDA,AMD,INTC`.
- The cluster `torghut-strategy-config` ConfigMap now marks the first strategy as `intraday_tsmom_v1@paper` with
  `universe_symbols: ["NVDA", "AMD", "INTC"]`.
- The active live pod `torghut-00215-deployment-554dc64c86-8wmgt` has
  `TRADING_SIMPLE_SUBMIT_ENABLED=false` and `TRADING_UNIVERSE_STATIC_FALLBACK_SYMBOLS=NVDA,AMD,INTC`.

Workload readiness after #5507:

- Live pod `torghut-00215-deployment-554dc64c86-8wmgt` is `2/2 Running` with zero restarts.
- Sim pod `torghut-sim-00295-deployment-67b7d6cfc9-xct8n` is `2/2 Running` with zero restarts.
- `torghut-ta`, `torghut-ta-sim`, `torghut-options-ta`, and their taskmanager pods are Running and ready.
- Options catalog and options enricher are Running and ready.
- `kubectl -n torghut get pods --field-selector=status.phase!=Running` returned no resources after hook cleanup.

Endpoint checks after #5507:

- Live `/healthz`: HTTP 200.
- Live `/trading/status`: HTTP 200 and active revision `torghut-00215`.
- Live `/readyz` and `/trading/health`: HTTP 503 because `live_submission_gate.allowed=false` with reason
  `simple_submit_disabled`. This is the safety state introduced by #5507; live order submission is intentionally no-go.
- Sim `/readyz`: HTTP 200 on active revision `torghut-sim-00295`.
- Options catalog `/readyz`: HTTP 200.
- Options enricher `/readyz`: HTTP 200 with a fresh success timestamp.
- Options TA REST `/config`: HTTP 200.

Event notes:

- Expected transient rollout warnings appeared while Knative replaced old live/sim revisions and Flink reconciled:
  startup/readiness probe failures, old-revision readiness failures during termination, temporary Flink `Job Not Found`,
  and PDB selection warnings.
- Follow-up evidence showed new live/sim revisions ready, old revisions drained, hooks completed, and no stuck or pending
  pods.

## Risk And Rollback

Residual risks:

- Live order submission is intentionally blocked after #5507. Treat `simple_submit_disabled` as the current trading gate:
  cluster rollout is applied, but live trading remains no-go until executable proof exists and a follow-up PR re-enables
  submit.
- Live `/readyz` and `/trading/health` return 503 because the app currently includes the disabled live submission gate in
  its health dependencies. If operators require HTTP 200 readiness while submit is intentionally disabled, the next PR
  should change the health semantics rather than re-enable live submit without proof.
- Jangar's dynamic equity universe endpoint still returns 12 symbols even though the deployed static fallback, strategy
  catalog, and websocket fallback are narrowed to `NVDA,AMD,INTC`. Strategy runtime filters by strategy symbols, but the
  dynamic Jangar source should be narrowed or made auditable before claiming full runtime universe closure.
- #5412 remains unmerged because Codex review capacity is exhausted. It should stay blocked until a Codex review posts
  and all resulting threads resolve, or until a maintainer explicitly waives the gate.
- Direct Argo, Knative, and Flink custom-resource reads are blocked for `system:serviceaccount:agents:agents-sa`; use a
  credential with the missing read access for direct sync inspection.
- Streaming sidecars `torghut-ws` and `torghut-ws-options` were Ready during final inspection but had recent liveness
  restarts before the selected merges. Treat another liveness loop or sustained readiness 503 as a rollout-health
  blocker.

Rollback path:

- For #5507, revert merge commit `d73020e67ff5409786f2c1c9984d03575c648088` if the submit-disable health behavior or
  chip-core narrowing causes unacceptable production impact. Reverting will re-enable the prior live submit posture, so
  require explicit maintainer approval before using that rollback.
- For #5503, revert merge commit `b653bd4fd6faeb39ab78a1eea4d2b6f2ed299f4a` if the hook or options TA drift cleanup
  regresses reconciliation.
- For #5494, revert merge commit `2dbe57a9872dac681d6f8cdce021996243f70197` or open a new GitOps promotion PR to the
  previous known-good Torghut image, then let Argo CD reconcile.
- If #5412 later merges and live submission health regresses, revert the shared live-gate code/config change or promote a
  prior image through the normal release PR flow. Preserve append-only evidence epoch, receipt, and profit-window records
  for audit continuity.

## Owner Update Message

Rollout state is applied with a live-trading no-go gate. #5494, #5503, and #5507 are merged with green checks, and GitOps
reconciled #5507 into the cluster: `torghut-00215` and `torghut-sim-00295` are Running with zero restarts, the strategy
and websocket configmaps are narrowed to `NVDA,AMD,INTC`, and live status reports active revision `torghut-00215`.
Infrastructure health is stable from the surfaces I can read, but live `/readyz` and `/trading/health` are 503 because
#5507 intentionally disables live simple submit; live order submission is blocked by design until executable proof exists.
#5412 remains a no-go because the required Codex review did not post. Argo/Knative/Flink custom-resource reads remain
RBAC-blocked in this runner, so the direct evidence is source parity plus workload, endpoint, configmap, and event checks.

## Next Action

Decide whether the intended `simple_submit_disabled` state should keep live `/readyz` degraded or whether health should
report HTTP 200 while separately surfacing live order submission as no-go. Then restore Codex review capacity or provide
an explicit maintainer waiver for #5412 before any large implementation merge.
