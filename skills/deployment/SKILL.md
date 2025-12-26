---
name: deployment
description: Use the repo’s deployment scripts and infra workflows safely.
---

## Infra & GitOps
- ArgoCD reconciles desired state; edit manifests in `argocd/` and let automation deploy.
- Use `bun run tf:plan` before `bun run tf:apply`.
- Prefer read-only `kubectl -n <namespace> get ...` for checks.

## Service Deploy Scripts
- Rebuild/push Codex runner image: `bun apps/froussard/src/codex/cli/build-codex-image.ts`.
- Deploy Froussard: `bun packages/scripts/src/froussard/deploy-service.ts`.
- Deploy Facteur: `bun packages/scripts/src/facteur/deploy-service.ts`.

## CLI Notes
- Avoid changing `KUBECONFIG` unless you need a different context.
- Use `argocd app get <app>`/`argocd app list` read-only by default.
