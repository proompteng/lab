# agentctl CLI Design

Status: Current (2026-01-19)

Location: `services/jangar/agentctl` (ships with the Jangar service; not a separate product).

## Purpose
`agentctl` is the Jangar CLI for managing Agents primitives and submitting AgentRuns without hand‑writing YAML.
It talks to the Jangar controller over gRPC.

## Goals
- CRUD for Agent, AgentRun, ImplementationSpec, ImplementationSource, Memory.
- CRUD for supporting primitives (Tool, Schedule, Workspace, Signal, ApprovalPolicy, Budget, SecretBinding).
- First‑class “run” command to submit an AgentRun from flags or a spec file.
- Works against any Kubernetes cluster where Jangar is deployed.
- In‑cluster gRPC by default (port‑forward or in‑cluster usage).
- Human‑friendly status, logs, and controller health.

## Non‑goals
- Full Helm management (left to `helm`).
- Replacing kubectl for advanced resource operations.
- Managing database lifecycle or ingress.

## Architecture
- Client talks to the Jangar gRPC API (no direct Kubernetes access).
- Default namespace is `agents`, with explicit overrides via flags/config.
- Jangar is the source of truth for list/get/apply/delete operations.

### gRPC connectivity (current + future)
- **Current:** in-cluster gRPC only; external access via `kubectl port-forward` or an in-cluster client.
- **Future-proofing:** TLS/mTLS support, optional auth tokens, and a dedicated Ingress/gateway can be layered without changing CLI commands.

## Command Surface (proposed)
### Core
- `agentctl version [--client]`
- `agentctl config view|set`
- `agentctl completion <shell>`

### Agent
- `agentctl agent get <name>`
- `agentctl agent list`
- `agentctl agent apply -f <file>`
- `agentctl agent delete <name>`

### ImplementationSpec
- `agentctl impl get <name>`
- `agentctl impl list`
- `agentctl impl create --text <text> [--summary ...] [--source ...]`
- `agentctl impl apply -f <file>`
- `agentctl impl delete <name>`

### ImplementationSource (GitHub/Linear)
- `agentctl source list`
- `agentctl source get <name>`
- `agentctl source apply -f <file>`
- `agentctl source delete <name>`

### Memory
- `agentctl memory list`
- `agentctl memory get <name>`
- `agentctl memory apply -f <file>`
- `agentctl memory delete <name>`

### Supporting primitives
- `agentctl tool list|get|apply|delete`
- `agentctl schedule list|get|apply|delete`
- `agentctl workspace list|get|apply|delete`
- `agentctl signal list|get|apply|delete`
- `agentctl approval list|get|apply|delete`
- `agentctl budget list|get|apply|delete`
- `agentctl secretbinding list|get|apply|delete`

### AgentRun
- `agentctl run submit --agent <name> --impl <name> --runtime <type> [--workload-image ...] [--cpu ...] [--memory ...] [--idempotency-key ...]`
- `agentctl run apply -f <file>`
- `agentctl run get <name>`
- `agentctl run list`
- `agentctl run logs <name> [--follow]` (via Jangar gRPC)
- `agentctl run cancel <name>`

## Flags & Defaults
- `--namespace` / `-n` (default `agents`).
- `--server` / `--address` (gRPC address; default `agents.agents.svc.cluster.local:50051`).
- For port‑forwarded usage, pass `--server 127.0.0.1:50051`.
- In‑cluster usage targets the `agents` service `grpc` port (requires `grpc.enabled` and `JANGAR_GRPC_*` envs in Helm values).
- `--token` (optional shared secret).
- `--tls` to enable TLS when configured (future-proofed).
- `--output` (`yaml|json|table`).
- `--wait` for `run submit` to block until completion.
- `--idempotency-key` to avoid duplicate run submissions.

## Spec Rendering
`agentctl run submit` builds an AgentRun manifest from flags:
- Required: `--agent`, `--impl` (ImplementationSpec), `--runtime`.
- Optional: `--workload-image`, `--cpu`, `--memory`, `--memory-ref`, `--param key=value`.
- Produces `spec.implementationSpecRef`, `spec.runtime`, `spec.workload`, `spec.parameters`, `spec.idempotencyKey`.

## Runtime Handling
- `--runtime` maps to `spec.runtime.type`.
- `--runtime-config key=value` maps into `spec.runtime.config` (schemaless).

## Logging & Artifacts
- `agentctl run logs` streams from Jangar gRPC endpoints.

## Error Handling
- Validate required fields before submitting.
- Detect schema errors from the API server and print actionable hints.
- Surface CRD missing errors with guidance to install the chart.
- Exit codes:
  - `0` success
  - `2` validation error
  - `3` Kubernetes API error
  - `4` runtime adapter error (submit/cancel)
  - `5` unknown/unhandled

## Security
- Optional shared token (`authorization: Bearer <token>`) and future mTLS support.
- Secrets referenced by name only; values never printed.

## Decisions
- Distribute `agentctl` as a standalone binary (GitHub releases) and npm + Homebrew packages.
- `agentctl` depends on Jangar gRPC endpoints for all operations.
- Uses Jangar gRPC auth (in‑cluster only for now; no kubeconfig access).
- Secrets referenced by name only; values never printed.

## Decisions
- `agentctl` lives under `services/jangar/**` and is packaged via Bun into a single binary.
- Ready for npm publishing and Homebrew tap packaging.
- Jangar gRPC is the only supported transport (future TLS/auth TBD).
