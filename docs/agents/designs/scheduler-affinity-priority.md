# Scheduler Affinity and Priority Defaults

Status: Current (2026-02-07)
## Purpose
Provide consistent scheduling defaults for AgentRun Jobs while allowing per-run overrides.

## Current State

- Chart values: `controller.defaultWorkload` includes node selector, tolerations, affinity, topology spread
  constraints, pod security context, image pull secrets, priority class, and scheduler name.
- Env wiring: `charts/agents/templates/deployment.yaml` maps defaults to `JANGAR_AGENT_RUNNER_*` env vars.
- Runtime behavior: `services/jangar/src/server/agents-controller.ts` applies defaults unless overridden by
  `spec.runtime.config` on the AgentRun.
- Cluster: `controller.defaultWorkload` is not set in ArgoCD values, so defaults are empty.

## Default Fields

- `controller.defaultWorkload.nodeSelector` → `JANGAR_AGENT_RUNNER_NODE_SELECTOR`
- `controller.defaultWorkload.tolerations` → `JANGAR_AGENT_RUNNER_TOLERATIONS`
- `controller.defaultWorkload.topologySpreadConstraints` → `JANGAR_AGENT_RUNNER_TOPOLOGY_SPREAD_CONSTRAINTS`
- `controller.defaultWorkload.affinity` → `JANGAR_AGENT_RUNNER_AFFINITY`
- `controller.defaultWorkload.podSecurityContext` → `JANGAR_AGENT_RUNNER_POD_SECURITY_CONTEXT`
- `controller.defaultWorkload.imagePullSecrets` → `JANGAR_AGENT_RUNNER_IMAGE_PULL_SECRETS`
- `controller.defaultWorkload.priorityClassName` → `JANGAR_AGENT_RUNNER_PRIORITY_CLASS`
- `controller.defaultWorkload.schedulerName` → `JANGAR_AGENT_RUNNER_SCHEDULER_NAME`

## Override Rules

- AgentRun `spec.runtime.config` values take precedence over controller defaults.
- If no override is specified, the controller uses the env defaults.

## Validation

- Set defaults in `controller.defaultWorkload` and confirm Job specs include them.
- Override defaults in a single AgentRun and verify the override wins.

## Operational Considerations

- Keep configuration in the appropriate control plane (Helm values, CI, or code) and document overrides.
- Update runbooks with enable/disable steps, rollback guidance, and expected failure modes.

## Rollout

- Ship behind feature flags or conservative defaults; validate in non-prod or CI first.
- Verify deployment health (CI checks, ArgoCD sync, logs/metrics) before widening rollout.

## Risks and Mitigations

- Misconfiguration can cause deployment or runtime regressions; mitigate with schema validation and safe defaults.
- Additional load or latency can impact controller throughput or CI runtime; mitigate with caps and monitoring.

## Handoff Appendix (Repo + Chart + Cluster)

See `docs/agents/designs/handoff-common.md`.
