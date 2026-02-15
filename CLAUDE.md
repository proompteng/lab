# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a comprehensive home cloud laboratory monorepo containing:

- Multiple applications (Next.js, React, TypeScript, Python, Go)
- Infrastructure as Code (OpenTofu/Terraform)
- GitOps deployment configurations (ArgoCD)
- Configuration management (Ansible)
- Kubernetes cluster management

## Common Development Commands

### Package Management & Dependencies

```bash
# Install all dependencies
bun install

# Clean all node_modules
bun run clean

# Format code using Biome
bun run format
```

### Application Development

```bash
# Start development servers
bun run dev:proompteng

# Build applications
bun run build:proompteng
bun run build:reviseur

# Start production servers
bun run start:proompteng

# Lint applications
bun run lint:proompteng
```

### Individual App Commands

```bash
# For TanStack Start apps (kitty-krew)
cd apps/kitty-krew
bun install # Install dependencies
bun run dev    # Start development server
bun run build  # Build for production
bun run start  # Start production server

# For Python apps (like alchimie)
cd apps/alchimie
uv sync     # Install dependencies
uv run dagster dev  # Start Dagster development server
uv run pytest  # Run tests

# For Go services (like prt)
cd services/prt
go run main.go  # Run the service
go test ./... # Run tests
```

### Infrastructure Management

```bash
# Terraform/OpenTofu operations
bun run tf:plan     # Plan infrastructure changes
bun run tf:apply    # Apply infrastructure changes
bun run tf:destroy  # Destroy infrastructure

# Ansible configuration management
bun run ansible     # Run Rancher installation playbook

# Kubernetes operations
bun run k:install   # Install K3s cluster
bun run k:bootstrap # Bootstrap ArgoCD
bun run harvester:apply # Apply Harvester templates

# Direct kubectl operations
kubectl --kubeconfig ~/.kube/altra.yaml apply -f ./tofu/harvester/templates
```

## Architecture & Structure

### Monorepo Layout

- `/apps/` - Independent applications with their own package.json
- `/services/` - Go backend services
- `/argocd/` - GitOps deployment manifests and ApplicationSets
- `/tofu/` - Infrastructure as Code (OpenTofu/Terraform)
- `/ansible/` - Configuration management playbooks
- `/kubernetes/` - Cluster setup and management scripts
- `/scripts/` - Build and deployment scripts

### Key Technologies

- **Frontend**: Next.js 15, React 19, TanStack Router, tRPC, Tailwind CSS
- **Backend**: Go 1.24, Node.js 22.20, Python 3.9-3.13
- **Data**: Dagster, Temporal, PostgreSQL, Kafka, Milvus
- **Infrastructure**: Kubernetes (K3s), ArgoCD, Harvester, Ansible
- **Tooling**: Bun 1.3.9, Biome, Turbo, Docker, UV

### Application Patterns

- **Next.js apps** (proompteng): Use App Router, TypeScript, Tailwind CSS, @proompteng/design components
- **React apps** (kitty-krew): TanStack Start with TanStack Router and tRPC for type-safe APIs
- **Python apps** (alchimie): Dagster for data pipelines, UV for dependency management
- **Go services** (prt): Temporal workflows, PostgreSQL integration, database migrations

### Infrastructure Patterns

- **GitOps**: ArgoCD ApplicationSets with Kustomize overlays
- **Multi-environment**: Dev/prod overlays in `/argocd/applications/*/overlays/`
- **Service mesh**: Istio components for ingress and networking
- **Storage**: Rook-Ceph for persistent volumes, MinIO for object storage
- **Messaging**: Kafka with Strimzi operator, Knative Eventing
- **Databases**: CloudNative-PG for PostgreSQL, Milvus for vector storage

## Code Standards

### Formatting & Linting

- Use Biome for formatting and linting (configured in biome.json)
- Settings: 2 spaces indentation, single quotes, trailing commas, 120 char line width
- Run `bun run format` to format all files

### File Naming & Structure

- Use kebab-case for file names (especially .tsx files)
- Follow existing patterns in each application
- Component files should match their exported component name in kebab-case

### Styling (React/Next.js apps)

- Use Tailwind CSS utility classes exclusively
- Use `cn()` utility for conditional classNames
- Follow zinc color palette for consistency
- Maintain responsive design with Tailwind's responsive prefixes
- Never hardcode width/height values

### Testing

- Next.js/React apps: Check package.json for test commands
- Go services: `go test ./...`
- Python apps: `uv run pytest`

## Container Registry & Deployment

- Private registry: `registry.ide-newton.ts.net` (for ARM64 builds)
- Build scripts in `/scripts/` directory (e.g., `build-kitty-krew.sh`)
- ArgoCD manages deployments from Git

## Kubernetes Context

- Harvester cluster config: `~/.kube/altra.yaml`
- Use `kubectl --kubeconfig ~/.kube/altra.yaml` for cluster operations
- ArgoCD UI available after bootstrap

### ArgoCD, kubectl, and git preferences

- Use the current/default kube context by default; do not pass a kubeconfig path unless explicitly requested.
- Scope kubectl to the target namespace with `-n`; prefer read-only queries (get/describe/logs) and short-lived actions (rollout restart). Avoid `kubectl apply` for desired state unless asked.
- Manage apps declaratively via Git under `argocd/`; pin chart versions and avoid ad-hoc Helm installs.
