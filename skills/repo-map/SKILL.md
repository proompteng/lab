---
name: repo-map
description: Locate code, services, and infra in the lab monorepo.
---

## Scope
- UIs live in `apps/<app>` (Next.js/Turbo).
- Go services live in `services/<service>` with `main.go` and adjacent `*_test.go`.
- Shared TypeScript utilities live in `packages/backend`; CDK8s blueprints in `packages/cloutt`.
- GitOps specs are in `argocd/`; OpenTofu in `tofu/harvester`; bootstrap in `kubernetes/`; Ansible in `ansible/`.
- Automation scripts are in `packages/scripts` and `scripts/`.

## Codex/Jangar Locations
- Jangar service: `services/jangar`.
- Codex CLI tooling: `apps/froussard/src/codex/cli`.
- Codex app-server types: `packages/codex/src/app-server`.

## Skills
- Repo skills are stored as `skills/<skill-name>/SKILL.md`.
