# Experimentation Lab

A multi-language monorepo for experimenting with conversational tooling, data pipelines, and deployment workflows. The repo combines Next.js frontends, Convex-backed APIs, Go microservices, and Kubernetes/Terraform automation for end-to-end prototyping.

[![Open in Coder](https://coder.proompteng.ai/open-in-coder.svg)](https://coder.proompteng.ai/templates/k8s-arm64/workspace?param.repository_url=https%3A%2F%2Fgithub.com%2Fproompteng%2Flab&param.repository_directory=%7E%2Fgithub.com)

---

## Quick Start

1. **Prerequisites**
   - Node.js 24.11.x and pnpm 10.23.x (via Corepack)
   - Go 1.24+
   - Bun (optional, see `bun.lock`)
   - Docker / Kubernetes tooling if you plan to run services or apply manifests locally
2. **Install workspace dependencies**
   ```bash
   pnpm install
   ```
3. **Launch the primary web app**
   ```bash
   pnpm run dev:proompteng
   ```
4. **Start the Convex backend locally** (in another terminal)
   ```bash
   pnpm run dev:convex
   ```
5. **Run Go services** (example)
   ```bash
   go run ./services/prt
   ```

> Prefer a hosted development experience? Click the **Open in Coder** button above to provision a workspace with Node 24, pnpm, and the repository pre-installed.

---

## Repository Layout

| Path | Description |
| ---- | ----------- |
| `apps/` | Next.js/Turbopack frontends (e.g. `proompteng`, `reviseur`, `alchimie`) with co-located fixtures and tests. |
| `packages/backend` | Convex backend project (`convex dev`, codegen, model seeding). |
| `packages/atelier`, `packages/cloutt` | Shared TypeScript utilities and infrastructure tooling. |
| `services/` | Go microservices (`miel`, `prix`, `prt`, `eclair`) with adjacent tests and Dockerfiles. |
| `ansible/` | Playbooks and inventory for provisioning supporting hosts. |
| `tofu/` | OpenTofu (Terraform) configurations for Harvester, Cloudflare, Rancher, and Tailscale. |
| `kubernetes/` | Cluster bootstrap/maintenance tooling (install scripts, Coder template); no workload manifests. |
| `argocd/` | Argo CD application specs and ApplicationSets for GitOps deployment. |
| `scripts/` | Helper scripts for builds, secrets management, and Tailscale automation. |
| `AGENTS.md`, `CLAUDE.md` | Notes and prompts for AI agent integrations. |

---

## Development Workflows

### Frontend
- Lint & format: `pnpm run lint:proompteng`, `pnpm run format`
- Build & smoke test: `pnpm run build:proompteng` then `pnpm run start:proompteng`
- Shared Biome config lives at `biome.json`

### Convex Backend
- Generate types: `pnpm --filter @proompteng/backend run codegen`
- Start local dev: `pnpm run dev:convex`
- Seed models: `pnpm run seed:models`

### Go Services
- Test all services: `go test ./services/...`
- Build binaries: `go build ./services/...`
- Unit test a single service: `go test ./services/prt -run TestHandleRoot`

### Tooling & Quality
- Husky + Biome formatted on commit (`lint-staged` configuration in `package.json`).
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
| Plan infrastructure | `pnpm run tf:plan` (OpenTofu under `tofu/harvester`)
| Apply infrastructure | `pnpm run tf:apply` (only after reviewing the plan)
| Destroy Harvester VM | `pnpm run tf:destroy`
| Apply Kubernetes base | `pnpm run harvester:apply` or `./kubernetes/install.sh`
| Bootstrap Argo CD | `pnpm run k:bootstrap` (applies manifests in `argocd/`)
| Run Ansible playbooks | `pnpm run ansible`
| Manage Coder template | `kubernetes/coder` contains Terraform + template YAML used by the button above.

Supporting configuration:
- `skaffold.yaml` for iterative container builds.
- `scripts/generate-*` helpers to create sealed secrets and Tailscale auth keys.
- `tmp/` contains sample certs, Milvus configs, and operator bundles used during experimentation.

---

## Coder Workspace

- Template name: **k8s-arm64** (see `kubernetes/coder/template.yaml`).
- Bootstrap script provisions code-server, Node 24, pnpm, Convex CLI, kubectl/argocd, and installs repo dependencies.
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
