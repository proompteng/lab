# Agents Control Plane UI

Status: Current (2026-05-25)

`services/agents` serves the operator UI and the existing API surface from the same control-plane service. The service exposes:

- `/` and `/primitives/**` for the TanStack Start UI
- `/health` and `/ready` for probes
- `/v1/*` for existing typed resources, logs, terminal events, and AgentRun submission
- `/mcp` for the Agents MCP endpoint

## Architecture

The UI is a TanStack Start application running on Bun with Vite 8, React 19, Tailwind CSS v4, shadcn components, and `@tailwindcss/vite`.

The frontend route tree lives in `services/agents/src/app-routes`. Existing controller, reconciler, gRPC, runner, and `/v1` implementation modules remain separate from the frontend bundle. TanStack Start owns the web entrypoint, while Start server routes delegate `/v1/*`, `/mcp`, `/health`, `/ready`, and `/metrics` to the existing Agents runtime handlers.

The control-plane image builds the Start `.output` bundle and starts it with `bun run start`. The controller image still starts `src/server/controller-entrypoint.ts`.

## CRD Schema Forms

The primitive registry is generated from `charts/agents/crds/*.yaml` by:

```bash
bun run --cwd services/agents generate:control-plane-registry
```

The generated registry contains each CRD kind, group, version, plural, scope, `openAPIV3Schema`, and display metadata. The schema form reads the CRD schema and renders native React Hook Form controls for strings, numbers, booleans, enums, arrays, and nested objects. Schemaless or preserved-unknown object subtrees use a JSON/YAML textarea fallback. Kubernetes remains the authoritative validator on submit.

## Primitive Routes

- `/primitives`: overview of every chart primitive
- `/primitives/$kind`: resource list for one primitive
- `/primitives/$kind/$namespace/$name`: resource detail
- `/primitives/$kind/new`: schema-form create flow

Navigation uses header breadcrumbs. There is no explicit back button.

## Create Flow

Create screens build a raw manifest preview before submit. Submission goes through the UI server endpoint backed by the existing typed-resource apply behavior and includes an `Idempotency-Key`.

For `AgentRun`, guided creation keeps `spec.parameters.prompt` out of the submitted manifest when `spec.implementationSpecRef` is present, preserving the ImplementationSpec text as the source of truth.

## Smoke And Rollout Proof

Local validation before a PR:

```bash
bun run --cwd services/agents test
bun run --cwd services/agents tsc
bun run --cwd services/agents lint
scripts/agents/validate-agents.sh
bun run lint:argocd
```

Render the GitOps app before merging:

```bash
mise exec helm@3 -- kustomize build --enable-helm argocd/applications/agents >/tmp/agents-render.yaml
```

After merge, let Argo CD sync the enabled `agents` app. Live proof must include health, ready, `/v1/control-plane/status`, `/mcp`, UI navigation across primitive categories, one disposable non-executing primitive created through the schema form, and a deterministic fake app-server smoke `AgentRun` with `Succeeded=True` and logs available through `/v1/control-plane/logs?tailLines=5`.
