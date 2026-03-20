# Torghut Quant Verify Report - 2026-03-19

## Scope

- Mission branch: `codex/swarm-torghut-quant-verify`
- Repository: `proompteng/lab`
- Objective: bring open Torghut PRs to production-ready state, merge only with green checks, and confirm healthy in-cluster rollout
- Release engineer: `Julian Hart` for Torghut Traders

## PR Queue

- Enumerated open PRs on `proompteng/lab` at 2026-03-19 18:00 UTC.
- Torghut-related PRs still open in this verify loop:
  - `#4628` `docs(torghut): record verify rollout blockers` on `codex/swarm-torghut-quant-verify`
  - `#4631` `docs(torghut): add segment authority and promotion certificate contracts` on `codex/swarm-torghut-quant-plan`
- Non-Torghut PR `#4625` remained unrelated and was not selected.
- `#4631` was inspected first because it was the only conflicting Torghut PR, but GitHub refused a server-side `gh pr update-branch --rebase` refresh with `Cannot update PR branch due to conflicts`.
- `#4628` became the selected release vehicle because it is the active verify branch and can carry the repo-owned production follow-up fixes.

## Torghut PRs Reviewed

- `#4628` `docs(torghut): record verify rollout blockers`
  - Active verify branch for this run.
  - Expanded in this run to carry the options-lane GitOps fixes identified during rollout inspection.
- `#4631` `docs(torghut): add segment authority and promotion certificate contracts`
  - Open, conflict-blocked on `codex/swarm-torghut-quant-plan`.
  - No checks failing, but not mergeable because GitHub reports branch conflicts and rejected a server-side rebase.
- `#4591` `chore(torghut): promote image 54971ed8`
  - Merged 2026-03-19 05:51 UTC.
  - All visible checks completed successfully or skipped by policy.
- `#4603` `fix(torghut): recover march 19 live and proof lanes`
  - Merged 2026-03-19 08:24 UTC.
  - Follow-up production recovery change set inspected for current rollout correlation.
- `#4615` `fix(torghut): disable llm recovery gate for march 19`
  - Merged 2026-03-19 09:01 UTC.
  - Follow-up Knative config and runtime gating change set inspected for current rollout correlation.

## Collaboration Status

- Huly dedicated-account credentials were recovered from `secret/huly-api-torghut` in namespace `agents`.
- Required actor validation keys were present for `Julian Hart`.
- Collaboration remained blocked because both of the required Huly helper calls timed out against `http://transactor.huly.svc.cluster.local`:
  - `account-info`
  - `list-channel-messages`
- The base service answered `404` for `/api/v1/`, but authenticated account resolution on `/api/v1/account/<workspace-id>` timed out after 15 seconds with no response.

## Rollout Evidence

### Core workloads currently serving

- `kubectl get pods -n torghut` showed the primary live and simulation revisions in `Running` state:
  - `torghut-00153-deployment-6cf7d8d5f-726xr`
  - `torghut-sim-00262-deployment-b48785c4b-fqpsl`
- Direct health probes returned `200`:
  - `http://torghut-00153-private.torghut.svc.cluster.local/healthz`
  - `http://torghut-sim-00262-private.torghut.svc.cluster.local/healthz`
  - `http://torghut-forecast.torghut.svc.cluster.local:8089/healthz`
  - `http://torghut-lean-runner.torghut.svc.cluster.local:8088/healthz`

### Drift and stability concerns

- Git-tracked live manifest `argocd/applications/torghut/knative-service.yaml` pins:
  - `registry.ide-newton.ts.net/lab/torghut@sha256:884bec35f7d24ef34c51240e697aa996bc134385be9f6936aa170880fe2d601e`
- The running live pod `torghut-00153-deployment-6cf7d8d5f-726xr` is actually serving:
  - `registry.ide-newton.ts.net/lab/torghut@sha256:884bec35f7d24ef34c51240e697aa996bc134385be9f6936aa170880fe2d601e`
- The same live pod reports:
  - `serving.knative.dev/creator=admin`
  - `TRADING_AUTONOMY_ALLOW_LIVE_PROMOTION=true` in the running pod while the Git-tracked manifest still sets `false`
  - recent readiness and liveness failures in namespace events, including `LatestReadyFailed` and probe timeouts around revision `torghut-00153`
- The simulation pod `torghut-sim-00262-deployment-b48785c4b-fqpsl` still matches the Git-tracked digest `884bec...`.

### Unhealthy torghut workloads

- `torghut-options-catalog-676574bcc9-wkqp5`
  - `CrashLoopBackOff`
  - startup log ends with `password authentication failed for user "torghut_app"`
  - live pod still points at secret `torghut-options-db-app`, but the current CNPG-managed `torghut-db-app` secret in namespace `torghut` has a different password value
- `torghut-options-enricher-64b577944c-tp7fp`
  - `CrashLoopBackOff`
  - startup log ends with `password authentication failed for user "torghut_app"`
  - live pod still points at secret `torghut-options-db-app`, which no longer matches the canonical CNPG app secret
- `torghut-options-ta-7987889f4f-zxl5g`
  - `ImagePullBackOff`
  - `kubectl describe pod` shows repeated image pull failures for `registry.ide-newton.ts.net/lab/torghut-ta@sha256:3d7f435b1eb4df8d9e4cb5c4f0c1a7bda412d51672d0eb0eb8285b83fe31cbb1`
  - the current repo fix on this branch updates `argocd/applications/torghut-options/ta/flinkdeployment.yaml` to the known-good digest already running for `torghut-ta`
- `torghut-ws-options-68ffc7448b-qcnv4`
  - running but not ready
  - namespace events show repeated `503` readiness failures and liveness restarts, consistent with upstream options-lane dependency degradation
- `torghut-dspy-cluster-runner`
  - job failed with `RuntimeError: jangar_agentrun_not_succeeded:dataset-build:failed`

## Changes Landed On This Branch

- `argocd/applications/torghut-options/catalog/deployment.yaml`
  - repoints `DB_DSN` from stale sealed secret `torghut-options-db-app` to CNPG-managed `torghut-db-app`
- `argocd/applications/torghut-options/enricher/deployment.yaml`
  - repoints `DB_DSN` from stale sealed secret `torghut-options-db-app` to CNPG-managed `torghut-db-app`
- `argocd/applications/torghut-options/ta/flinkdeployment.yaml`
  - replaces missing TA image digest `3d7f435...` with the current live core TA digest `20fe1818...`
  - aligns the embedded TA version and commit metadata with the promoted image that already runs in `torghut-ta`

## Merge Outcome

- `#4631` was not merged in this run because it remains conflict-blocked on a separate swarm branch.
- `#4628` remains the active merge candidate for this branch after the options-lane GitOps fixes and artifact updates in this run.

## Risk

- The core live and simulation services currently answer health checks, so the main trading path is not fully down.
- The torghut namespace is not healthy enough to call production rollout complete because:
  - the live `torghut` revision still shows manual/admin drift in env state even though the image digest now matches Git
  - options-lane services are unavailable
  - `torghut-options` is configured as `automation: manual` in `argocd/applicationsets/product.yaml`, so a merged Git fix still requires GitOps reconciliation before live pods change
  - the release persona cannot complete required Huly audit updates from this runtime

## Rollback Path

- If the latest Torghut live-path changes need to be rolled back, revert PRs `#4615`, `#4603`, and `#4591` in reverse order through normal PR flow and let Argo CD reconcile.
- If the live service drift is unintended, restore the Git-tracked Knative service env through Git instead of another manual admin update.
- If the options-lane fix regresses, revert the `#4628` follow-up commit to point catalog/enricher back to `torghut-options-db-app` and restore the previous options TA digest.

## Next Action

- Merge `#4628` once CI stays green.
- Ask the owning operator to reconcile the manual `torghut-options` Argo app to apply the merged secret-reference and TA-image fixes.
- Restore Huly transactor responsiveness for dedicated-account API calls so the required issue/chat/doc artifacts can be written by the Julian Hart account.
- Re-run the verify loop after GitOps reconciliation and confirm catalog/enricher/TA/ws-options readiness plus the live `torghut` env drift state.
