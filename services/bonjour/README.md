# @proompteng/bonjour

Disabled TypeScript sample service that renders Kubernetes resources with cdk8s via the official CLI. It remains a
local compiler canary only; it is not an Argo CD application or an adoption pilot.

## Scripts

- `bun run --filter @proompteng/bonjour dev` – run the Hono server locally on port 3000.
- `bun run --filter @proompteng/bonjour synth` – regenerate local per-resource manifests with the pinned cdk8s CLI.
- `bun run --filter @proompteng/bonjour build` – compile TypeScript to `dist/` for packaging.
- `bun run --filter @proompteng/bonjour clean` – remove build and manifest artifacts.
- `bun run packages/scripts/src/bonjour/build-image.ts [tag]` – build and push the Docker image to
  `registry.ide-newton.ts.net/lab/bonjour` (defaults to `latest` if no tag is provided).

## Generated Assets

Running `bun run --filter @proompteng/bonjour synth` produces one local-inspection file per resource:

```
services/bonjour/manifests/
  Deployment.*.yaml
  HorizontalPodAutoscaler.*.yaml
  Service.*.yaml
```

The exact names contain cdk8s-plus construct addresses because this disabled canary is not GitOps authority. Live
applications use the stable filename policy in `@proompteng/k8s`.

Configure synthesis via environment variables:

- `IMAGE` – container image reference (default `registry.ide-newton.ts.net/lab/bonjour:latest`).
- `REPLICAS` – minimum replica count for the HPA target (default `2`).
- `PORT` – container port (default `3000`).
- `NAMESPACE` – Kubernetes namespace metadata (default `bonjour`).
- `CPU_TARGET_PERCENT` – average CPU utilization target for the HPA (default `70`).

## GitOps status

Bonjour is intentionally absent from the staged ApplicationSets. Argo CD does not synthesize TypeScript: live
applications use committed, per-resource YAML produced by `@proompteng/k8s` and reconciled through their existing
Kustomizations. See `docs/cdk8s-manifest-authoring-design.md`.

## Continuous Delivery

Pushes to `main` that touch `services/bonjour/**` trigger the shared `Docker Build and Push` workflow, which includes a
`build-bonjour` job. The job tags and pushes `registry.ide-newton.ts.net/lab/bonjour` images using the repo-wide
`docker-build-common` composite with the same semver tagging automation as other services.
