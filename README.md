# lab

Multi-language monorepo for the Proompteng product surfaces, agent platform, shared SDKs, and GitOps/infrastructure
automation.

The repository centers on:

- product surfaces and adjacent runtimes in `apps/`
- agent and control-plane services in `services/`
- shared TypeScript packages and deploy tooling in `packages/`
- Kubernetes, Argo CD, Helm, OpenTofu, and Ansible assets for running the stack

## What Lives Here

### Apps

- `apps/` mixes browser apps, desktop apps, runtime services, and a few templates/config-only directories
- `apps/landing`: Next.js marketing site backed by the shared Convex project in `packages/backend`
- `apps/app`: TanStack Start control-plane UI
- `apps/cms`: Payload CMS for landing content
- `apps/docs`: Fumadocs-based documentation app
- `apps/froussard`: Bun webhook bridge service in `apps/`
- `apps/reestr`, `apps/reviseur`, `apps/kabina`, `apps/nata`, `apps/kitty-krew`, `apps/alchimie`, `apps/discourse`:
  additional product and experiment surfaces

### Shared packages

- `packages/backend`: Convex backend, codegen, and seed flows used by frontend apps
- `packages/scripts`: typed Bun deploy/build/reseal automation used across services
- `packages/temporal-bun-sdk`: Temporal SDK and examples for Bun-based workers
- `packages/codex`: Codex client/runtime package
- `packages/design`, `packages/atelier`, `packages/cloutt`, `packages/cx-tools`, `packages/discord`,
  `packages/otel`, `packages/schematic`: shared libraries and tooling

### Services

- `services/jangar`: OpenAI-compatible streaming chat/completions service and agent control-plane runtime
- `services/torghut`: FastAPI autonomous trading service with research and rollout workflows
- `services/memories`: memory storage/retrieval service used by agent workflows
- `services/golink`, `services/oirat`, `services/bumba`, `services/khoshut`, `services/facteur`, `services/graf`,
  `services/prt`, `services/bonjour`, `services/tigresse`, `services/saigak`, `services/dernier`, `services/dorvud`,
  `services/miel`, `services/eclair`, `services/galette`, `services/vecteur`, `services/workers`: supporting product,
  integration, runtime, and infrastructure services implemented across TS, Go, Python, Kotlin, and Ruby

### Platform and infra

- `charts/agents`: Helm chart and CRDs for the agents platform
- `argocd/`: GitOps manifests and ApplicationSets
- `kubernetes/`: cluster bootstrap and operational manifests/scripts
- `tofu/`: OpenTofu stacks
- `ansible/`: provisioning and operational playbooks
- `devices/`: machine-specific infrastructure notes and manifests
- `proto/`, `schemas/`: shared contracts and schema assets
- `docs/`: design docs, runbooks, incidents, and architecture references
- `skills/`: reusable agent skills

## Quick Start

### Prerequisites

- Node `24.11.1`
- Bun `1.3.10`
- Go `1.24+` for Go services
- Ruby `3.4.7` + Bundler `2.7+` for `services/dernier`
- Python:
  - `3.9-3.12` for `apps/alchimie`
  - `3.11-3.12` for `services/torghut`

Install workspace dependencies:

```bash
bun install
```

Common entry points from the repo root:

```bash
# Landing site + shared Convex backend
bun run dev:setup:convex
bun run seed:models
bun run dev:landing

# Control-plane UI
bun run dev:app

# Payload CMS
bun run dev:cms

# Docs app
bun run dev:docs

# Convex backend only
bun run dev:convex
```

Service-specific local workflows live in the nearest README. Two important examples:

- `services/jangar/README.md`: local Jangar development, Tilt port-forwards, worker split, and gRPC notes
- `services/torghut/README.md`: `uv`-based Python setup, migration checks, whitepaper workflow, and rollout automation

## Common Commands

### Frontend and TypeScript workspaces

```bash
bun run format
bun run format:check
bun run lint:oxlint
bun run lint:oxlint:type
```

Target a single workspace:

```bash
bun run --filter <workspace> <script>
```

Examples:

```bash
bun run --filter landing build
bun run --filter app test
bun run --filter @proompteng/backend codegen
```

### Go services

```bash
go test ./services/...
go build ./services/...
```

### Infrastructure

```bash
bun run tf:plan
bun run tf:apply
bun run lint:argocd
bun run ansible
```

Service deploy/build/reseal workflows use the typed scripts under `packages/scripts/src/**`.

## Repository Layout

| Path | Purpose |
| --- | --- |
| `apps/` | Mixed product surfaces: web apps, desktop apps, some runtime services, and app-adjacent templates/config |
| `packages/` | Shared TS libraries, Convex backend, SDKs, and deploy tooling |
| `services/` | Backend services across TS, Go, Python, Ruby, and Kotlin |
| `charts/agents/` | Agents Helm chart, CRDs, examples, and values |
| `argocd/` | Desired GitOps state for applications and platform components |
| `kubernetes/` | Cluster bootstrap, utilities, and supporting manifests |
| `tofu/` | OpenTofu stacks for infrastructure provisioning |
| `ansible/` | Playbooks and inventory |
| `docs/` | Current-state docs, design docs, runbooks, and incident writeups |
| `devices/` | Hardware/node-specific operational material |
| `proto/` | Protobuf definitions |
| `schemas/` | SQL and schema assets |
| `scripts/` | Repository-level helpers |
| `skills/` | Agent skill definitions |

## Recommended Starting Points

- Agents platform docs: `docs/agents/README.md`
- Jangar service docs: `services/jangar/README.md`
- Torghut docs index: `docs/torghut/README.md`
- Deploy/build script catalog: `packages/scripts/README.md`
- Root tooling and workflows: `AGENTS.md`

## Notes

- Use `mise` when a workflow requires a pinned tool major such as `helm@3`.
- Generated artifacts and lockfiles are maintained through their owning generators and package managers.
- For infra changes, default to GitOps under `argocd/` and let Argo CD apply the desired state.
