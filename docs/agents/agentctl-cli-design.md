# agentctl CLI Design

Status: Current (2026-01-30)

Location: `services/jangar/agentctl` (ships with the Jangar service; **not** a separate product or service).

## Purpose
`agentctl` is the CLI for managing Agents primitives and submitting AgentRuns without hand‑writing YAML.
It ships with the Jangar service and is a thin wrapper around Kubernetes APIs (like `kubectl`/`argocd`/`virtctl`
style CLIs). gRPC is supported as an optional transport when you want to target Jangar directly.

## Goals
- CRUD for Agent, AgentRun, ImplementationSpec, ImplementationSource, Memory.
- CRUD for supporting primitives (Tool, Schedule, Workspace, Signal, ApprovalPolicy, Budget, SecretBinding).
- First‑class “run” command to submit an AgentRun from flags or a spec file.
- Interactive `init` flows for ImplementationSpecs and AgentRuns.
- `run codex` convenience command to generate an ImplementationSpec and submit an AgentRun.
- Works against any Kubernetes cluster where Jangar is deployed by using the current kube context.
- Optional gRPC mode for direct Jangar access (port‑forward, in‑cluster, or gateway).
- Packaged as a Node-bundled CLI (single JS file) with optional Bun binaries; distributed via npm and Homebrew.
- Human‑friendly status, logs, and controller health.

## Non‑goals
- Full Helm management (left to `helm`).
- Replacing kubectl for advanced resource operations.
- Managing database lifecycle or ingress.

## Architecture
- Client talks to the Kubernetes API directly by default.
- gRPC transport is available for compatibility and future remote access.
- CLI built with `@effect/cli` for composable command parsing and completion generation.
- Default namespace is `agents`, with explicit overrides via flags/config.
- CLI is bundled and versioned with the Jangar service, even though it is published independently.
- Jangar is the source of truth for list/get/apply/delete operations.

### gRPC connectivity (optional)
- **Optional:** gRPC can be enabled on the Jangar chart to serve agentctl and health endpoints.
- **Current:** in-cluster gRPC only; external access via `kubectl port-forward` or an in-cluster client.
- **Future-proofing:** TLS/mTLS support, optional auth tokens, and a dedicated Ingress/gateway can be layered without changing CLI commands.

### gRPC primitive coverage
For the full gRPC parity plan (proto additions, auth, error handling, testing), see
`docs/agents/agentctl-grpc-coverage.md`.

## Command Surface
### Core
- `agentctl version [--client]`
- `agentctl config view|set`
- `agentctl completion <shell>`
- `agentctl completion install <shell>`
- `agentctl status` / `agentctl diagnose` (control-plane health)

### Agent
- `agentctl agent get <name>` / `agentctl agent describe <name>`
- `agentctl agent list` / `agentctl agent watch`
- `agentctl agent apply -f <file>`
- `agentctl agent delete <name>`

### ImplementationSpec
- `agentctl impl get <name>` / `agentctl impl describe <name>`
- `agentctl impl list` / `agentctl impl watch`
- `agentctl impl create --text <text> [--summary ...] [--source ...]`
- `agentctl impl init [--apply] [--file <path>]`
- `agentctl impl apply -f <file>`
- `agentctl impl delete <name>`

### ImplementationSource (GitHub/Linear)
- `agentctl source list` / `agentctl source watch`
- `agentctl source get <name>` / `agentctl source describe <name>`
- `agentctl source apply -f <file>`
- `agentctl source delete <name>`

### Memory
- `agentctl memory list` / `agentctl memory watch`
- `agentctl memory get <name>` / `agentctl memory describe <name>`
- `agentctl memory apply -f <file>`
- `agentctl memory delete <name>`

### Supporting primitives
- `agentctl tool list|get|describe|watch|apply|delete`
- `agentctl schedule list|get|describe|watch|apply|delete`
- `agentctl workspace list|get|describe|watch|apply|delete`
- `agentctl signal list|get|describe|watch|apply|delete`
- `agentctl approval list|get|describe|watch|apply|delete`
- `agentctl budget list|get|describe|watch|apply|delete`
- `agentctl secretbinding list|get|describe|watch|apply|delete`

### AgentRun
- `agentctl run submit --agent <name> --impl <name> --runtime <type> [--workload-image ...] [--cpu ...] [--memory ...] [--idempotency-key ...]`
- `agentctl run init [--apply] [--file <path>] [--wait]`
- `agentctl run codex --prompt "<task>" --agent <name> --runtime <type> [--wait]`
- `agentctl run apply -f <file>`
- `agentctl run get <name>` / `agentctl run describe <name>`
- `agentctl run status <name>` (alias for `run get`)
- `agentctl run wait <name>` (block until terminal phase)
- `agentctl run list` / `agentctl run watch`
- `agentctl run logs <name> [--follow]` (Kubernetes pods in kube mode; gRPC optional)
- `agentctl run cancel <name>`

### Status / Diagnose
`agentctl status` and `agentctl diagnose` present control-plane health. In kube mode they inspect the namespace,
deployment, and CRDs directly; in gRPC mode they call the Jangar control-plane status endpoint. Use `--output json`
for machine parsing.

Example table (left-aligned, kubectl-style headers):

```
COMPONENT                NAMESPACE  STATUS     MESSAGE
namespace                agents     healthy
agents-controller        agents     healthy
supporting-controller    agents     healthy
orchestration-controller agents     healthy
runtime:workflow         agents     healthy
runtime:job              agents     healthy
runtime:temporal         agents     configured temporal configuration resolved
runtime:custom           agents     unknown    custom runtime configured per AgentRun
database                 agents     healthy
grpc                     agents     healthy   127.0.0.1:50051
```

`--output json` includes:

```json
{
  "service": "jangar",
  "generated_at": "...",
  "controllers": [
    {
      "name": "agents-controller",
      "enabled": true,
      "started": true,
      "crds_ready": true,
      "missing_crds": [],
      "last_checked_at": "...",
      "status": "healthy",
      "message": ""
    }
  ],
  "runtime_adapters": [
    {
      "name": "workflow",
      "available": true,
      "status": "healthy",
      "message": "",
      "endpoint": ""
    }
  ],
  "database": {
    "configured": true,
    "connected": true,
    "status": "healthy",
    "message": "",
    "latency_ms": 12
  },
  "grpc": {
    "enabled": true,
    "address": "127.0.0.1:50051",
    "status": "healthy",
    "message": ""
  },
  "namespaces": [
    {
      "namespace": "agents",
      "status": "healthy",
      "degraded_components": []
    }
  ]
}
```

## Flags & Defaults
- `--namespace` / `-n` (default `agents`).
- `--kube` (default) to force Kubernetes API mode.
- `--kubeconfig` / `AGENTCTL_KUBECONFIG` to select a kubeconfig file.
- `--context` / `AGENTCTL_CONTEXT` to select a kube context.
- `--grpc` to force gRPC mode.
- `--server` / `--address` (gRPC address; default `agents-grpc.agents.svc.cluster.local:50051`).
- For port‑forwarded usage, pass `--grpc --server 127.0.0.1:50051`.
- `--token` (optional shared secret).
- `--tls` to enable TLS when configured (future-proofed).
- `--output` / `-o` (`yaml|json|table`, default `table`).
- `describe` defaults to `--output yaml` unless explicitly overridden.
- `--wait` for `run submit` to block until completion.
- `--idempotency-key` to avoid duplicate run submissions.
- `--interval` (seconds) for `watch` commands (default 5).
- `--apply` and `--file` for `init` commands.

## Spec Rendering
`agentctl run submit` builds an AgentRun manifest from flags:
- Required: `--agent`, `--impl` (ImplementationSpec), `--runtime`.
- Optional: `--workload-image`, `--cpu`, `--memory`, `--memory-ref`, `--param key=value`.
- Produces `spec.implementationSpecRef`, `spec.runtime`, `spec.workload`, `spec.parameters`.
- `--idempotency-key` is sent to gRPC as `idempotency_key` and recorded as a delivery-id label in kube mode.

## Runtime Handling
- `--runtime` maps to `spec.runtime.type`.
- `--runtime-config key=value` maps into `spec.runtime.config` (schemaless).

## Logging & Artifacts
- `agentctl run logs` streams from Kubernetes pods in kube mode and from Jangar gRPC in gRPC mode.

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
- Distribute `agentctl` as a standalone CLI (Node bundle in releases) and npm + Homebrew packages.
- Default transport is Kubernetes API; gRPC is optional for direct Jangar access.
- `agentctl` lives under `services/jangar/**` and is bundled for Node; optional Bun binaries can be published for convenience.
- Secrets referenced by name only; values never printed.
