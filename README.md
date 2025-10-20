# Experimentation Lab

A multi-language monorepo for experimenting with conversational tooling, data pipelines, and deployment workflows. The repo combines Next.js frontends, Convex-backed APIs, Go microservices, and Kubernetes/Terraform automation for end-to-end prototyping.

[![Open in Coder](https://coder.proompteng.ai/open-in-coder.svg)](https://coder.proompteng.ai/templates/k8s-arm64/workspace?param.repository_url=https%3A%2F%2Fgithub.com%2Fproompteng%2Flab&param.repository_directory=%7E%2Fgithub.com)

---

## Quick Start

1. **Prerequisites**
   - Node.js 22.20.x and pnpm 10+ (see the [Node.js release schedule](https://nodejs.org/en/about/previous-releases) and [Corepack docs](https://nodejs.org/api/corepack.html))
   - Go 1.24+ ([download from go.dev](https://go.dev/dl/))
   - Bun (optional, see `bun.lock`; install via the [Bun docs](https://bun.sh/docs/installation))
   - Docker / Kubernetes tooling (use the [Docker Desktop install](https://docs.docker.com/desktop/) and [kubectl setup guide](https://kubernetes.io/docs/tasks/tools/)) if you plan to run services or apply manifests locally
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

> Prefer a hosted development experience? Click the **Open in Coder** button above to provision a workspace with Node 22, pnpm, and the repository pre-installed. The template uses Coder’s [Kubernetes deployment model](https://coder.com/docs) and the bootstrap script outlined in `docs/coder-workspace-bootstrap.md`.

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
| `kubernetes/` | Cluster manifests, Coder template, and helper scripts (`kubernetes/install.sh`). |
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
- Tailwind CSS (v3.4 per the [Tailwind release blog](https://tailwindcss.com/blog/tailwindcss-v3-4)) & Radix UI used extensively in frontend components.

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

These instructions remain intentionally permissive for an isolated lab network—tighten auth and networking before production use. Consult the [PostgreSQL documentation](https://www.postgresql.org/docs/current/) for hardening guidance.

---

## Infrastructure & Operations

| Task | Command / Notes |
| ---- | ---------------- |
| Plan infrastructure | `pnpm run tf:plan` (OpenTofu under `tofu/harvester`; see the [OpenTofu docs](https://opentofu.org/docs/intro/install/)) |
| Apply infrastructure | `pnpm run tf:apply` (only after reviewing the plan) |
| Destroy Harvester VM | `pnpm run tf:destroy` |
| Apply Kubernetes base | `pnpm run harvester:apply` or `./kubernetes/install.sh` |
| Bootstrap Argo CD | `pnpm run k:bootstrap` (applies manifests in `argocd/`; reference the [Argo CD getting started guide](https://argo-cd.readthedocs.io/en/stable/getting_started/)) |
| Run Ansible playbooks | `pnpm run ansible` (install Ansible via the [official instructions](https://docs.ansible.com/ansible/latest/installation_guide/installation_distros.html)) |
| Manage Coder template | `kubernetes/coder` contains Terraform + template YAML used by the button above. |

Supporting configuration:
- `skaffold.yaml` for iterative container builds.
- `scripts/generate-*` helpers to create sealed secrets and Tailscale auth keys.
- `tmp/` contains sample certs, Milvus configs, and operator bundles used during experimentation.

---

## Coder Workspace

- Template name: **k8s-arm64** (see `kubernetes/coder/template.yaml`).
- Bootstrap script provisions code-server, Node 22, pnpm, Convex CLI, kubectl/argocd, and installs repo dependencies.
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
