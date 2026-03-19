# Torghut Quant Verify Report - 2026-03-19

## Scope

- Mission branch: `codex/swarm-torghut-quant-verify`
- Repository: `proompteng/lab`
- Objective: bring open Torghut PRs to production-ready state, merge only with green checks, and confirm healthy in-cluster rollout

## PR Queue

- Enumerated open PRs on `proompteng/lab` at 2026-03-19 18:00 UTC.
- Result: only PR `#4625` (`docs: add bilig deployment contract docs`) was open, and it is unrelated to Torghut.
- No open `torghut` or `torghut-quant` PRs were available to unblock or merge in this run.

## Torghut PRs Reviewed

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
  - `registry.ide-newton.ts.net/lab/torghut@sha256:a599ab5e52448e2d2e47a3b31a9d8695c1e6cca10271001e77e3f52726a6188d`
- The same live pod reports:
  - `serving.knative.dev/creator=admin`
  - a recent `OOMKilled` last state
  - repeated startup, readiness, and liveness probe failures in `kubectl describe pod`
- The simulation pod `torghut-sim-00262-deployment-b48785c4b-fqpsl` still matches the Git-tracked digest `884bec...`.

### Unhealthy torghut workloads

- `torghut-options-catalog-676574bcc9-wkqp5`
  - `CrashLoopBackOff`
  - startup log ends with `password authentication failed for user "torghut_app"`
- `torghut-options-enricher-64b577944c-tp7fp`
  - `CrashLoopBackOff`
  - startup log ends with `password authentication failed for user "torghut_app"`
- `torghut-options-ta-7987889f4f-zxl5g`
  - `ImagePullBackOff`
  - `kubectl describe pod` shows repeated image pull failures for `registry.ide-newton.ts.net/lab/torghut-ta@sha256:3d7f435b1eb4df8d9e4cb5c4f0c1a7bda412d51672d0eb0eb8285b83fe31cbb1`
- `torghut-dspy-cluster-runner`
  - job failed with `RuntimeError: jangar_agentrun_not_succeeded:dataset-build:failed`

## Merge Outcome

- No merge was performed in this run.
- Reason:
  - there were no open Torghut PRs to merge
  - current production verification is blocked by live service drift, unhealthy options-lane workloads, and Huly collaboration timeouts

## Risk

- The core live and simulation services currently answer health checks, so the main trading path is not fully down.
- The torghut namespace is not healthy enough to call production rollout complete because:
  - the live service does not match the Git-tracked digest
  - options-lane services are unavailable
  - the release persona cannot complete required Huly audit updates from this runtime

## Rollback Path

- If the latest Torghut live-path changes need to be rolled back, revert PRs `#4615`, `#4603`, and `#4591` in reverse order through normal PR flow and let Argo CD reconcile.
- If the live service drift is unintended, restore the Git-tracked Knative service image through Git instead of another manual admin update.
- For the options lane, restore valid `torghut_app` database credentials and publish the missing `torghut-ta` image digest before re-running verification.

## Next Action

- Restore Huly transactor responsiveness for dedicated-account API calls.
- Reconcile the live `torghut` Knative service back to Git-tracked state or land the missing manifest update through PR.
- Repair the options-lane database credentials and `torghut-ta` image availability.
- Re-run the verify loop once the namespace is fully healthy.
