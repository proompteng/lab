# @proompteng/scripts

Utility Bun/TypeScript scripts that automate common platform workflows. Use `bun run <path-to-script>`.

## Prerequisites

- Bun ≥ 1.2 (matches repo toolchain)
- Required CLIs noted per script available on `PATH`
- Authenticated GitHub CLI (`gh auth status`) for GitHub integrations
- Kubernetes/Argo credentials when triggering infrastructure workflows

## Available scripts

| Script | Description | Required CLIs | Example |
| --- | --- | --- | --- |
| `src/codex/trigger-review-workflow.ts` | Collects unresolved review threads and failing checks for a pull request and submits the `github-codex-review` Argo workflow when action is needed. | `gh`, `argo` | `bun run packages/scripts/src/codex/trigger-review-workflow.ts --pr=1529` (also accepts full PR URLs) |
| `src/jangar/build-image.ts` | Builds and pushes the `lab/jangar` Bun worker image using the jangar Dockerfile. | `docker` | `bun run packages/scripts/src/jangar/build-image.ts` |
| `src/jangar/deploy-service.ts` | Builds the jangar image, bumps the Argo CD manifests, and applies the Knative service. | `docker`, `kubectl` | `bun run packages/scripts/src/jangar/deploy-service.ts` |
| `src/froussard/deploy-service.ts` | Builds and pushes the Froussard Docker image, updates `knative-service.yaml` with the new digest + version metadata, and `kubectl apply`s the manifest (pass `--dry-run` to skip pushing/applying). | `docker`, `kubectl` | `bun run packages/scripts/src/froussard/deploy-service.ts` |
| `src/froussard/reseal-secrets.ts` | Reseals the Froussard SealedSecrets using the cluster cert bundle. | `kubectl`, `openssl`, `kubeseal` | `bun run packages/scripts/src/froussard/reseal-secrets.ts` |
| `src/facteur/build-image.ts` | Builds the Facteur container image and pushes to the configured registry. | `docker`/`podman` | `bun run packages/scripts/src/facteur/build-image.ts` |
| `src/facteur/deploy-service.ts` | Builds the Facteur image, applies the kustomize overlay, and redeploys the Knative service. | `kubectl`, `kn`, `docker`/`podman` | `bun run build:facteur` (or direct `bun run …/deploy-service.ts`) |
| `src/facteur/reseal-secrets.ts` | Reseals Facteur SealedSecrets with the current cluster certs. | `kubectl`, `openssl`, `kubeseal` | `bun run packages/scripts/src/facteur/reseal-secrets.ts` |
| `src/facteur/run-consumer.ts` | Launches the Facteur Kafka consumer locally for manual verification. | `docker`/`podman` (for build) | `bun run packages/scripts/src/facteur/run-consumer.ts` |
| `src/registry/prune-images.ts` | Prunes old image tags from the in-cluster registry (keeps last N version-like tags per repository, then runs registry GC). Defaults to dry-run; pass `--apply` to delete. | `kubectl` | `bun run packages/scripts/src/registry/prune-images.ts --repo=lab/jangar --keep=5 --apply` |

## Testing & linting

We keep lightweight unit tests alongside scripts where feasible (see `src/codex/__tests__`). Run the following before pushing changes:

```bash
# Lint scripts
bun run --filter @proompteng/scripts lint

# Execute Bun tests
bun test packages/scripts/src/**/__tests__/*.test.ts
```

These commands are also executed in CI (see `.github/workflows/scripts-ci.yml`).
