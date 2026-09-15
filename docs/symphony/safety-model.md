# Symphony Safety Model

## Posture

Symphony is intentionally a high-trust internal automation service.

It is designed to run:

- inside a trusted cluster
- against trusted repositories
- with repository-owned workflow configuration in `WORKFLOW.md`
- with credentials injected by Kubernetes secrets

This is not a multi-tenant control plane and it does not attempt to treat repository content, issue text, or workflow hooks as untrusted input.

## Trust Boundaries

### Trusted

- `WORKFLOW.md`
- workspace hook scripts from `WORKFLOW.md`
- the target repository mounted or cloned into the issue workspace
- cluster-injected credentials for Linear and Codex
- the operator who deploys and edits Symphony

### Semi-trusted

- Linear issue bodies, comments, and metadata
- repository contents that may contain mistakes or unsafe instructions

These inputs are operationally useful but should not be assumed harmless just because they come from normal engineering systems.

## Approval and Sandbox Policy

Symphony does not implement its own approval workflow.

The active runtime policy is the Codex policy configured in `WORKFLOW.md` and exposed live through:

- `GET /api/v1/state`
- the built-in dashboard at `/`

The production contract is:

- approval policy is explicit in workflow config
- thread sandbox is explicit in workflow config
- turn sandbox policy is explicit in workflow config
- the live service exposes those values so operators can verify what is actually running

## Dynamic Tools

Symphony keeps tracker writes agent-owned.

Supported tool surface in this arc:

- `linear_graphql`

Rules:

- the tool reuses Symphony’s configured Linear auth
- the tool accepts exactly one GraphQL operation per call
- unsupported tool names fail closed instead of stalling the session
- Symphony itself does not implement first-class ticket mutation APIs in the orchestrator

## Secrets

Secrets are supplied through Kubernetes secrets and `$VAR` indirection in workflow config.

Required handling rules:

- never log raw API keys or auth payloads
- validate presence of secrets without printing them
- keep long-lived credentials out of `WORKFLOW.md`
- prefer namespace-scoped secrets over workstation-local files in cluster deployments

Current production secrets used by Symphony:

- `LINEAR_API_KEY`
- Codex auth material mounted into the pod

## Workspace Safety

Baseline invariants:

- Codex always runs with `cwd` set to the per-issue workspace
- workspace paths must remain under `workspace.root`
- workspace directory names are sanitized from issue identifiers
- durable scheduler metadata is written only under `${workspace.root}/_symphony/`

These controls reduce blast radius but are not a substitute for correct Codex approval and sandbox settings.

## Leader Election and Operational Safety

Symphony uses Kubernetes Lease leader election for scheduler ownership.

Operational rules:

- only the leader may poll Linear
- only the leader may dispatch or retry work
- followers stay available for health and debug visibility
- if leadership is lost, local workers are interrupted and the replica drops back to follower mode

This prevents duplicate dispatch after rollout, restart, or replica overlap.

## Operator Escalation Rules

Operators should intervene when any of the following are true:

- `recentErrors` shows repeated tracker auth, schema, or workflow validation failures
- leader election is enabled but no replica reports `isLeader=true`
- retry queue grows while capacity is available
- workers repeatedly fail with the same workspace hook or Codex protocol error
- the dashboard policy summary does not match the expected deployment policy

Escalation order:

1. verify `GET /api/v1/state`
2. verify the active `WORKFLOW.md`
3. verify Kubernetes secret and Lease health
4. inspect issue-specific detail at `GET /api/v1/<issue_identifier>`
5. only then change tracker state, workflow config, or deployment config

## Deferred Hardening

Not in this arc:

- multi-tenant isolation
- external sandboxing beyond the Codex/host boundary
- SSH worker pools
- orchestrator-owned tracker writes
- Liquid template migration
