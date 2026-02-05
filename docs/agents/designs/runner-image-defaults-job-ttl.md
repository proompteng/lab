# Runner Image Defaults and Job TTL

Status: Partial (2026-02-05)

## Purpose
Provide reliable default runner images and safe Job TTLs so AgentRuns do not fail due to missing images or premature
cleanup.

## Current State
- Runtime image selection in `services/jangar/src/server/agents-controller.ts`:
  - Job runtime requires `spec.workload.image`, `JANGAR_AGENT_RUNNER_IMAGE`, or `JANGAR_AGENT_IMAGE`.
  - Workflow runtime requires the same image inputs.
- Chart defaults:
  - `runner.image.repository` defaults to `registry.ide-newton.ts.net/lab/codex-universal` in
    `charts/agents/values.yaml`.
  - The deployment template sets `JANGAR_AGENT_RUNNER_IMAGE` when `runner.image.repository` is present.
- Job TTL:
  - `JANGAR_AGENT_RUNNER_JOB_TTL_SECONDS` defaults to 600 seconds.
  - `spec.runtime.config.ttlSecondsAfterFinished` overrides the env value.
  - TTL is clamped to `[30s, 7d]`.
- Cluster: the `agents` deployment does not currently expose `JANGAR_AGENT_RUNNER_IMAGE` or
  `JANGAR_AGENT_RUNNER_JOB_TTL_SECONDS`, implying drift from the chart defaults. AgentRuns in the cluster supply
  `spec.workload.image` explicitly.

## Design
- Ensure `JANGAR_AGENT_RUNNER_IMAGE` is always set in chart values for production.
- Keep Job TTL defaults high enough to allow status reconciliation and artifact collection.
- Allow per-run overrides via `spec.runtime.config.ttlSecondsAfterFinished`.

## Configuration
- `runner.image.repository`, `runner.image.tag`, `runner.image.digest` map to `JANGAR_AGENT_RUNNER_IMAGE`.
- `controller.jobTtlSecondsAfterFinished` maps to `JANGAR_AGENT_RUNNER_JOB_TTL_SECONDS`.
- AgentRun retention is controlled separately by `spec.ttlSecondsAfterFinished` and
  `JANGAR_AGENTS_CONTROLLER_AGENTRUN_RETENTION_SECONDS`.

## Validation
- Create an AgentRun without `spec.workload.image` and confirm it succeeds when the env default is set.
- Set `spec.runtime.config.ttlSecondsAfterFinished` and confirm the Job spec TTL is patched accordingly.
- Confirm AgentRun retention deletes completed runs after the configured TTL.
