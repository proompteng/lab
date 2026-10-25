# prt service

Skaffold drives both local and remote developer loops for this Knative-backed Go service. It watches code changes,
rebuilds container images, and reapplies manifests so Knative rolls out new revisions automatically.

## Why Skaffold?

- Orchestrates the entire loop (build → push → deploy) with one command instead of juggling `docker`, `kubectl`, and `kustomize` manually.
- Keeps the commands identical between local and remote clusters; profiles simply swap registry/cluster settings.
- Integrates with Knative so every rebuild becomes a new revision and traffic smoothly shifts to it.

## Prerequisites

- Docker with BuildKit/buildx enabled (`docker buildx inspect default` should list `linux/arm64`).
- Skaffold v2.11+ (config version `v4beta11`). See the [Skaffold CLI documentation](https://skaffold.dev/docs/) for installation and usage details.
- Access to the target Kubernetes cluster and container registry (`registry.ide-newton.ts.net`).
- Git repository available so Skaffold can derive commit-based tags.

## Knative routing & subdomain

- A `DomainMapping` is applied for `prt.proompteng.ai`, pointing straight at the Knative Service (see the [Knative Serving domain mapping guide](https://knative.dev/docs/serving/setting-up-custom-domains/)).
- Knative Serving is already configured to mint certificates through cert-manager and to use the `{{.Name}}.{{.Domain}}` template, so the public URL resolves to `https://prt.proompteng.ai` once DNS points at the cluster ingress.
- Argo CD’s ApplicationSet sets `CreateNamespace=true`, so the `prt` namespace is created automatically—no standalone Namespace manifest is needed.

## Local dev loop

```sh
skaffold dev
```

- Builds the image for your host architecture.
- Applies manifests from `argocd/applications/prt/base` into the current kube-context.
- Streams container logs and redeploys on code changes.

## Remote (cluster) deploy

```sh
skaffold run --profile remote --default-repo registry.ide-newton.ts.net/lab
```

- Cross-builds for `linux/arm64` and pushes to the registry using your current Git commit as the tag (e.g. `registry.ide-newton.ts.net/lab/prt:abc1234`).
- Renders the Knative overlay at `argocd/applications/prt/overlays/cluster` (which already pins the registry host).
- Applies the manifests directly so a new Knative revision rolls out immediately.

> Tip: Run `skaffold build --profile remote --default-repo registry.ide-newton.ts.net/lab` to publish once, then `skaffold render --profile remote > /tmp/prt.yaml` if you want to inspect the exact manifest before applying.

## Remote hot reload

```sh
skaffold dev --profile remote --default-repo registry.ide-newton.ts.net/lab --port-forward
```

- Watches your source files; on save, rebuilds for `linux/arm64`, pushes, and reapplies manifests to the remote cluster.
- Uses commit-based tags so each rebuild gets a unique image, and Knative’s revision controller handles zero-downtime swaps.
- Streams Knative rollout events and container logs; Ctrl+C stops the loop cleanly.

## Promoting via Argo CD

1. Build/push the image: `skaffold build --profile remote --default-repo registry.ide-newton.ts.net/lab`.
2. Update the overlay to the pushed tag: `kustomize edit set image prt=registry.ide-newton.ts.net/lab/prt:$(git rev-parse --short HEAD)` inside `argocd/applications/prt/overlays/cluster`.
3. Commit the changed manifests and push; Argo CD sync then deploys the same revision Skaffold built.

## Frequently asked

- **Will Skaffold push a `latest` tag?** No—`skaffold.yaml` tags images with the abbreviated Git SHA, so Knative always gets an immutable image. The overlay’s default tag (`main`) is just a placeholder until you promote a specific build.
- **How do I get instant updates in the remote cluster?** Use `skaffold dev --profile remote`; it continuously rebuilds/pushes and forces Knative to roll a new revision after every change.

## Health endpoints

- `/health/liveness`
- `/health/readiness`
- Legacy `/healthz` remains for backwards compatibility.

## Flow with Argo CD

1. Run the remote profile so images and manifests match what Argo CD expects.
2. Commit the overlay and DomainMapping changes if you edited config (e.g. autoscaling hints, image tags).
3. The `product` ApplicationSet tracks `argocd/applications/prt`, so a sync promotes the latest committed revision in the cluster.
