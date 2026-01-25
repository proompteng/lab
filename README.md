# Experimentation Lab

A multi-language monorepo for experimenting with conversational tooling, data pipelines, and deployment workflows. The repo combines Next.js frontends, Convex-backed APIs, Go microservices, and Kubernetes/Terraform automation for end-to-end prototyping.

[![Open in Coder](https://coder.proompteng.ai/open-in-coder.svg)](https://coder.proompteng.ai/templates/k8s-arm64/workspace?param.repository_url=https%3A%2F%2Fgithub.com%2Fproompteng%2Flab&param.repository_directory=%7E%2Fgithub.com)

---

## Quick Start

1. **Prerequisites**
   - Node.js 24.11.x and Bun 1.3.5
   - Go 1.24+
   - Docker / Kubernetes tooling if you plan to run services or apply manifests locally
2. **Install workspace dependencies**
   ```bash
   bun install
   ```
3. **Launch the landing web app**
   ```bash
   bun run dev:landing
   ```
4. **Start the Convex backend locally** (in another terminal)
   ```bash
   bun run dev:convex
   ```
5. **Run Go services** (example)
   ```bash
   go run ./services/prt
   ```

> Prefer a hosted development experience? Click the **Open in Coder** button above to provision a workspace with Node 24, Bun, and the repository pre-installed.

---

## Repository Layout

| Path | Description |
| ---- | ----------- |
| `apps/` | Frontends and UX surfaces (e.g. `landing`, `app`, `docs`) with co-located fixtures and tests. |
| `packages/backend` | Convex backend project (`convex dev`, codegen, model seeding). |
| `packages/atelier`, `packages/cloutt` | Shared TypeScript utilities and infrastructure tooling. |
| `services/` | Go microservices (`miel`, `prt`, `eclair`) with adjacent tests and Dockerfiles. |
| `ansible/` | Playbooks and inventory for provisioning supporting hosts. |
| `tofu/` | OpenTofu (Terraform) configurations for Harvester, Cloudflare, Rancher, and Tailscale. |
| `kubernetes/` | Cluster bootstrap/maintenance tooling (install scripts, Coder template); no workload manifests. |
| `argocd/` | Argo CD application specs and ApplicationSets for GitOps deployment. |
| `scripts/` | Helper scripts for builds, secrets management, and Tailscale automation. |
| `AGENTS.md`, `CLAUDE.md` | Notes and prompts for AI agent integrations. |

---

## Development Workflows

### Frontend
- Lint & format: `bun run lint:landing`, `bun run format`
- Build & smoke test: `bun run build:landing` then `bun run start:landing`
- Shared Biome config lives at `biome.json`

### Convex Backend
- Generate types: `bun run --filter @proompteng/backend codegen`
- Start local dev: `bun run dev:convex`
- Seed models: `bun run seed:models`

### Go Services
- Test all services: `go test ./services/...`
- Build binaries: `go build ./services/...`
- Unit test a single service: `go test ./services/prt -run TestHandleRoot`

### Tooling & Quality
- Husky + Biome formatted on commit (`lint-staged` configuration in `package.json`).
- Oxlint runs alongside Biome: `bun run lint:oxlint` for repo-wide JS/TS checks and `bun run lint:oxlint:type` to run type-aware checks across TS workspaces.
- Type-aware Oxlint uses tsgolint (typescript-go), which may skip unsupported tsconfig options (such as `baseUrl`)—use lint-only tsconfigs per workspace if needed.
- TailwindCSS v4 & Radix UI used extensively in frontend components.

---

## Database Setup

Some experiments expect a Postgres instance (see original Home Cloud notes). To recreate the environment locally:

1. Install the CLI:
   ```bash
   brew install postgresql
   ```
2. (Linux) install server packages:
   ```bash
   sudo apt update && sudo apt install postgresql
   ```
3. Enable remote access (optional lab setup):
   - Add to `pg_hba.conf`:
     ```
     host    all    all    192.168.1.0/24    trust
     ```
   - Ensure `postgresql.conf` includes `listen_addresses = '*'`.
4. Create a user & database:
   ```bash
   create role altra with login;
   create database altra with owner altra;
   ```
5. Grant privileges as needed:
   ```sql
   grant create on database altra to altra;
   ```

These instructions remain intentionally permissive for an isolated lab network—tighten auth and networking before production use.

---

## Infrastructure & Operations

| Task | Command / Notes |
| ---- | ---------------- |
| Plan infrastructure | `bun run tf:plan` (OpenTofu under `tofu/harvester`)
| Apply infrastructure | `bun run tf:apply` (only after reviewing the plan)
| Destroy Harvester VM | `bun run tf:destroy`
| Apply Kubernetes base | `bun run harvester:apply` or `./kubernetes/install.sh`
| Bootstrap Argo CD | `bun run k:bootstrap` (applies manifests in `argocd/`)
| Run Ansible playbooks | `bun run ansible`
| Manage Coder template | `kubernetes/coder` contains Terraform + template YAML used by the button above.

Supporting configuration:
- `skaffold.yaml` for iterative container builds.
- `scripts/generate-*` helpers to create sealed secrets and Tailscale auth keys.
- `tmp/` contains sample certs, Milvus configs, and operator bundles used during experimentation.

---

## Coder Workspace

- Template name: **k8s-arm64** (see `kubernetes/coder/template.yaml`).
- Bootstrap script provisions code-server, Node 24, Bun, Convex CLI, kubectl/argocd, and installs repo dependencies.
- Use `coder templates push` / `coder update` to maintain the template when infrastructure changes are made.

---

## Additional Resources

- `docs/tooling.md` – Install guides for Node, Terraform/OpenTofu, kubectl, Ansible, PostgreSQL, Python tooling, and the GitHub CLI
- `docs/kafka-topics.md` – Kafka topic naming (dot notation) and Strimzi resource guidance
- `docs/codex-workflow.md` – How to exercise the Codex planning + implementation workflow after deployment
- `argocd/README.md` – GitOps deployment notes
- `kubernetes/README.md` – Cluster setup instructions
- `services/*/README.md` – Service-specific docs (`miel`, `prt`)
- `tofu/README.md` – Terraform/OpenTofu usage

Feel free to add new experiments under `apps/` or `services/`—keep scope tight, follow the Biome/Tailwind conventions, and document deployment steps alongside automation scripts.
