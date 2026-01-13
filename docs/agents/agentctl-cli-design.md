# agentctl CLI Design

Status: Draft (2026-01-13)

## Purpose
`agentctl` is a thin CLI for managing Agents CRDs and submitting AgentRun workloads without requiring users to hand‑write YAML.

## Goals
- CRUD for Agent, AgentRun, ImplementationSpec, ImplementationSource, Memory.
- First‑class “run” command to submit an AgentRun from flags or a spec file.
- Works against any Kubernetes cluster (minikube/kind/managed) via kubeconfig.
- Minimal dependencies; no bespoke server required.
- Human‑friendly status and logs for runs.

## Non‑goals
- Full Helm management (left to `helm`).
- Replacing kubectl for advanced resource operations.
- Managing database lifecycle or ingress.

## Architecture
- Client talks directly to Kubernetes API using kubeconfig.
- Optional Jangar API endpoint for streaming logs/artifacts (if exposed).
- All resources are Kubernetes native; `agentctl` is a convenience layer.

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
- `agentctl source apply -f <file>`
- `agentctl source delete <name>`

### Memory
- `agentctl memory list`
- `agentctl memory apply -f <file>`
- `agentctl memory delete <name>`

### AgentRun
- `agentctl run submit --agent <name> --impl <name> --runtime <type> [--workload-image ...] [--cpu ...] [--memory ...]`
- `agentctl run apply -f <file>`
- `agentctl run get <name>`
- `agentctl run list`
- `agentctl run logs <name> [--follow]` (via Jangar API or Kubernetes logs)
- `agentctl run cancel <name>`

## Flags & Defaults
- `--context`, `--kubeconfig`, `--namespace` (default from kubeconfig).
- `--output` (`yaml|json|table`).
- `--wait` for `run submit` to block until completion.

## Spec Rendering
`agentctl run submit` builds an AgentRun manifest from flags:
- Required: `--agent`, `--impl` (ImplementationSpec), `--runtime`.
- Optional: `--workload-image`, `--cpu`, `--memory`, `--memory-ref`, `--param key=value`.
- Produces `spec.implementationSpecRef`, `spec.runtime`, `spec.workload`, `spec.parameters`.

## Runtime Handling
- `--runtime` maps to `spec.runtime.type`.
- `--runtime-config key=value` maps into `spec.runtime.config` (schemaless).

## Logging & Artifacts
- If Jangar exposes an HTTP endpoint, `agentctl run logs` streams from Jangar.
- Fallback: read Kubernetes workload logs (runtime‑specific).

## Error Handling
- Validate required fields before submitting.
- Detect schema errors from the API server and print actionable hints.
- Surface CRD missing errors with guidance to install the chart.

## Security
- Uses kubeconfig auth (no credentials stored).
- Secrets referenced by name only; values never printed.

## Open Questions (if needed)
- Whether to bundle `agentctl` in the Jangar image or distribute separately.
- How to standardize artifact retrieval across runtime adapters.
