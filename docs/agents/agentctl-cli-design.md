# agentctl CLI Design

Status: Current (2026-01-20)

Location: `services/jangar/agentctl`

## Purpose
`agentctl` is the Jangar CLI for managing Agents primitives and submitting runs without hand‑writing YAML.
It talks to the Jangar controller over gRPC.

## Goals
- CRUD for Agent, AgentRun, ImplementationSpec, ImplementationSource, Memory, Orchestration, OrchestrationRun, Tool,
  ToolRun, Signal, SignalDelivery, ApprovalPolicy, Budget, SecretBinding, Schedule, Artifact, Workspace.
- First‑class “run” commands to submit AgentRuns, OrchestrationRuns, and ToolRuns from flags or spec files.
- Works against any Kubernetes cluster where Jangar is deployed.
- In‑cluster gRPC by default (port‑forward or in‑cluster usage).
- Human‑friendly status, logs, and controller health.

## Non‑goals
- Full Helm management (left to `helm`).
- Replacing kubectl for advanced resource operations.
- Managing database lifecycle or ingress.

## Architecture
- Client talks to the Jangar gRPC API (no direct Kubernetes access).
- gRPC is the only supported transport for in-cluster usage (port-forward or in-cluster gRPC service).
- Default namespace is `agents`, with explicit overrides via flags/config.
- Jangar is the source of truth for list/get/apply/delete operations.

## Command Surface (proposed)
### Core
- `agentctl version`
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

### Orchestration
- `agentctl orchestration list`
- `agentctl orchestration get <name>`
- `agentctl orchestration apply -f <file>`
- `agentctl orchestration delete <name>`

### OrchestrationRun
- `agentctl orchestration-run submit --orchestration <name> [--param ...] [--budget ...] [--idempotency-key ...]`
- `agentctl orchestration-run apply -f <file>`
- `agentctl orchestration-run get <name>`
- `agentctl orchestration-run list`

### Tool
- `agentctl tool list`
- `agentctl tool get <name>`
- `agentctl tool apply -f <file>`
- `agentctl tool delete <name>`

### ToolRun
- `agentctl tool-run submit --tool <name> [--param ...] [--retry-limit ...] [--timeout-seconds ...]`
- `agentctl tool-run apply -f <file>`
- `agentctl tool-run get <name>`
- `agentctl tool-run list`

### Signal
- `agentctl signal list`
- `agentctl signal get <name>`
- `agentctl signal apply -f <file>`
- `agentctl signal delete <name>`

### SignalDelivery
- `agentctl signal-delivery list`
- `agentctl signal-delivery get <name>`
- `agentctl signal-delivery apply -f <file>`
- `agentctl signal-delivery delete <name>`

### ApprovalPolicy
- `agentctl approval-policy list`
- `agentctl approval-policy get <name>`
- `agentctl approval-policy apply -f <file>`
- `agentctl approval-policy delete <name>`

### Budget
- `agentctl budget list`
- `agentctl budget get <name>`
- `agentctl budget apply -f <file>`
- `agentctl budget delete <name>`

### SecretBinding
- `agentctl secret-binding list`
- `agentctl secret-binding get <name>`
- `agentctl secret-binding apply -f <file>`
- `agentctl secret-binding delete <name>`

### Schedule
- `agentctl schedule list`
- `agentctl schedule get <name>`
- `agentctl schedule apply -f <file>`
- `agentctl schedule delete <name>`

### Artifact
- `agentctl artifact list`
- `agentctl artifact get <name>`
- `agentctl artifact apply -f <file>`
- `agentctl artifact delete <name>`

### Workspace
- `agentctl workspace list`
- `agentctl workspace get <name>`
- `agentctl workspace apply -f <file>`
- `agentctl workspace delete <name>`

### AgentRun
- `agentctl run submit --agent <name> --impl <name> --runtime <type> [--workload-image ...] [--cpu ...] [--memory ...] [--idempotency-key ...]`
- `agentctl run apply -f <file>`
- `agentctl run get <name>`
- `agentctl run list`
- `agentctl run logs <name> [--follow]` (via Jangar gRPC)
- `agentctl run cancel <name>`

## Flags & Defaults
- `--namespace` (default `agents`).
- `--address` (gRPC address; default `127.0.0.1:50051` for port‑forward).
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

`agentctl orchestration-run submit` builds an OrchestrationRun manifest from flags:
- Required: `--orchestration`.
- Optional: `--param key=value`, `--budget`, `--idempotency-key`.

`agentctl tool-run submit` builds a ToolRun manifest from flags:
- Required: `--tool`.
- Optional: `--param key=value`, `--retry-limit`, `--timeout-seconds`.

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
