# Jangar Control Plane Release Verification

Timestamp: 2026-05-05T14:56:00Z
Repository: `proompteng/lab`
Base: `main`
Release branch: `codex/swarm-jangar-control-plane-verify`

## Gate Decision

No-go for the remaining large open Jangar-impacting PRs.

The earlier NATS-selected blockers are already merged:

- #5376, `fix(torghut): restore live jangar dependency quorum`, merged at 2026-05-05T09:16:09Z.
- #5364, `ci: stabilize agents and jangar checks`, merged at 2026-05-05T09:21:18Z.
- #5387, `fix(torghut): restore rollout readiness`, merged at 2026-05-05T10:17:03Z.

The current open high-impact PRs are clean and green but blocked by the large-change Codex review gate:

- #5454, `feat(jangar): surface failure-domain lease holdbacks`, changes 1,542 lines. `@codex review` was requested, but the connector replied that code-review usage limits are exhausted and no review threads were posted.
- #5412, `feat(torghut): add evidence epochs and shared live gate`, changes 3,165 lines. `@codex review` was requested, but the connector replied that code-review usage limits are exhausted and no review threads were posted.

I did not squash-merge #5454 or #5412 because the execution policy requires a posted Codex review and resolved threads, unless a maintainer explicitly waives that gate.

## PR Comment Updates

- #5454 progress comment updated through `services/jangar/scripts/codex/codex-progress-comment.ts`: https://github.com/proompteng/lab/pull/5454#issuecomment-4379440176.
- #5412 progress comment updated through `services/jangar/scripts/codex/codex-progress-comment.ts`: https://github.com/proompteng/lab/pull/5412#issuecomment-4378206627.

## Rollout Evidence

The in-cluster service account cannot read Argo Application CRs directly, so GitOps status was verified through Argo application-controller logs and workload readiness.

Argo controller evidence:

- `jangar` logged `Skipping auto-sync: application status is Synced` at 2026-05-05T14:51:41Z.
- `jangar` logged `Updated health status: Progressing -> Healthy` at 2026-05-05T14:38:05Z.
- `torghut` logged `Updated health status: Progressing -> Healthy` at 2026-05-05T14:53:57Z.
- `torghut` logged repeated later reconciliations with `No status changes. Skipping patch`.

Workload readiness:

- Jangar namespace pods were Running and ready, including `jangar` 2/2, `bumba` 1/1, `symphony-jangar` 1/1, database, Redis, Open WebUI, Alloy, and Symphony.
- Torghut namespace pods were Running and ready, including `torghut-00209` 2/2, `torghut-sim-00288` 2/2, `torghut-ws` 1/1, ClickHouse, CNPG, Flink taskmanagers, exporters, Symphony, options, and TA pods.

Event notes:

- Jangar events showed transient scheduling/readiness warnings during rollout and legacy sealed-secret unseal warnings. No checked Jangar pod was stuck or unready.
- Torghut events showed transient startup/readiness warnings during Knative revision turnover and older Flink/PDB warnings. No checked Torghut pod was stuck or unready.

## Risk And Rollback

Residual risks:

- #5454 and #5412 remain unmerged because Codex review capacity is exhausted. They should stay blocked until Codex review posts and all resulting threads resolve, or until a maintainer explicitly waives the gate.
- Direct Argo Application CR reads are blocked for `system:serviceaccount:agents:agents-sa`; use Argo controller logs plus namespace workload readiness from this runner, or a credential with Application read access for direct sync inspection.

Rollback path:

- For already-merged changes, revert the bad code or release-promotion PR on `main`, then let Argo CD reconcile through GitOps.
- If #5454 later merges, rollback is revert or ignore the additive shadow-only `failure_domain_leases` surface; no admission enforcement is enabled by that PR.
- If #5412 later merges, rollback through the normal release PR flow by reverting the Torghut image/config promotion or shared-gate code change. Retain append-only evidence epoch and receipt records for forensic continuity.

## Next Action

Restore Codex review capacity or provide an explicit maintainer waiver for #5454 and #5412. After that, re-check review threads, conflicts, required checks, and Argo/workload health before merging either PR.
