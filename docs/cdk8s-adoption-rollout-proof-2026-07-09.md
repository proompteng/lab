# cdk8s Adoption Rollout Proof

## Result

cdk8s adoption is established for the live `docs` and `analysis` applications. Both applications now use committed,
one-resource-per-file manifests synthesized from TypeScript in `packages/k8s`. The final Kustomize renders were unchanged,
Argo reconciled both applications without replacing their workloads or services, and both endpoints remained HTTP 200.
The obsolete in-cluster cdk8s config-management plugin was removed.

Evidence was captured on 2026-07-09 in the `galactic-tailscale` Kubernetes 1.35.0 cluster.

## Immutable References

- Design and Olden disablement: [PR #12209](https://github.com/proompteng/lab/pull/12209), merge
  `64f072fa58ad5d50077418c7a359da90cd544c66`.
- Immediate pre-cutover baseline: `a09e6443dda7fe749b2e2a3d111e7551e320b025`.
- Compiler, migrations, CI, and plugin removal: [PR #12214](https://github.com/proompteng/lab/pull/12214), merge
  `90cc200975cce30cfa233e63f3e23546a45d4653`.
- Adoption revision reconciled by Argo CD: `90cc200975cce30cfa233e63f3e23546a45d4653`.
- Dedicated manifest validation: [cdk8s-manifests CI job](https://github.com/proompteng/lab/actions/runs/29072349240/job/86296312346).
- Post-cutover image build: [product-nix-images run](https://github.com/proompteng/lab/actions/runs/29073583282), source
  `90cc200975cce30cfa233e63f3e23546a45d4653`.
- Post-cutover image write-back: [PR #12223](https://github.com/proompteng/lab/pull/12223), merge
  `fb509a2eeb94354fa55cd791a83046c21079ca45`.

## Compiler and GitOps Contract

- Workspace package: `@proompteng/k8s` in `packages/k8s`.
- Registered applications: `docs` and `analysis`, through the explicit registry in `packages/k8s/src/registry.ts`.
- Output: one Kubernetes object per YAML file plus a sorted generated `kustomization.yaml` in each existing Argo
  application directory.
- Reconciliation: Argo CD consumes committed static Kustomize output; neither Argo nor the cluster executes TypeScript.
- Safety: synthesis stages, validates, and atomically swaps one application's output directory. It rejects `Namespace`,
  plaintext `Secret`, identity collisions, selector mismatches, and promoted image digests in generated source.
- CI: formatting, Oxlint, type-aware Oxlint, TypeScript, 13 compiler/chart/policy tests, import drift, two clean synthesis
  passes, tracked-output drift, kubeconform, final Kustomize render, image pinning, and image-updater target checks passed.
- Cluster validation: strict server-side dry-runs of the final `docs` and `analysis` renders passed against the live API
  before merge. The GitHub-hosted validation job has no in-cluster identity, so this conditional design gate was executed
  from the rollout environment and is recorded here.

The pre-cutover and post-cutover Kustomize render hashes were byte-identical:

| Application | Before and after SHA-256                                           |
| ----------- | ------------------------------------------------------------------ |
| `docs`      | `157bb8924913727bb88e9e3d27a52a87c26d650a5111ae32ecd68852afd417c5` |
| `analysis`  | `b55b66ba1c38486ca78231981dce577695ac39df05d53ac88dc1fa6d9d6e8ff2` |

## Argo Reconciliation

At the adoption revision, all four relevant Argo applications reported `Synced/Healthy`:

| Application | Revision                                   | Sync   | Health  |
| ----------- | ------------------------------------------ | ------ | ------- |
| `root`      | `90cc200975cce30cfa233e63f3e23546a45d4653` | Synced | Healthy |
| `argocd`    | `90cc200975cce30cfa233e63f3e23546a45d4653` | Synced | Healthy |
| `docs`      | `90cc200975cce30cfa233e63f3e23546a45d4653` | Synced | Healthy |
| `analysis`  | `90cc200975cce30cfa233e63f3e23546a45d4653` | Synced | Healthy |

The root application pruned the unused `cdk8s` ApplicationSet. The Argo application then removed the
`argocd-cdk8s-plugin` ConfigMap and the `cdk8s-plugin` repo-server sidecar through server-side apply. The repo-server
Deployment was `2/2` Ready with only `argocd-repo-server` and `lovely-plugin`; no Application referenced a source plugin
named `cdk8s`.

Ten scaled-to-zero historical repo-server ReplicaSets retained by `revisionHistoryLimit: 10` still contain their original
pod templates. They have no ready or running replicas and are not active consumers. They were intentionally retained as
normal Kubernetes rollout history instead of deleting rollback records solely to erase historical template text.

## Live No-Rollout Evidence

The resource identities and rollout revisions below were captured before merge and again after Argo reconciled
`90cc200975cce30cfa233e63f3e23546a45d4653`.

| `docs` object                                | Before                                                                                                        | After                        |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| Deployment UID                               | `bccfe942-5d83-465b-9763-4f6050143d35`                                                                        | unchanged                    |
| Deployment generation / revision / readiness | `30` / `26` / `1/1`                                                                                           | unchanged                    |
| Active ReplicaSet                            | `docs-9fd8978b7`, UID `f59463a7-6d18-4ea5-9e1e-135ddd96908e`                                                  | unchanged, `1/1` Ready       |
| Pod                                          | `docs-9fd8978b7-lnfcw`, UID `8af04212-ee87-4ba0-9f9e-826b6d51037a`                                            | unchanged, Running and Ready |
| Service UID / cluster IP                     | `90d452e6-c4e9-4fd7-8bf6-1773c3642194` / `10.99.117.67`                                                       | unchanged                    |
| IngressRoute UID                             | `7b62dc9a-d357-49f0-b51e-9d7825c6c729`                                                                        | unchanged                    |
| Image                                        | `registry.ide-newton.ts.net/lab/docs@sha256:e9d7ebbff45c66bbf77c8b73a05ed8ec6801297a737ae2e7cdbda410ae1fe58d` | unchanged                    |

The `docs` EndpointSlice had a ready endpoint. `IngressRoute/docs` retained entry points `web` and `websecure`, match
``Host(`docs.proompteng.ai`)``, and backend `Service/docs:80`. `https://docs.proompteng.ai/` returned HTTP 200.

| `analysis` object                            | Before                                                                             | After                        |
| -------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------- |
| Deployment UID                               | `3edc34e1-d0a2-46ce-868c-96433a3a4764`                                             | unchanged                    |
| Deployment generation / revision / readiness | `560` / `560` / `1/1`                                                              | unchanged                    |
| Active ReplicaSet                            | `analysis-7764d5744f`, UID `f3897204-05b4-4eee-b2e7-2d26945ca991`                  | unchanged, `1/1` Ready       |
| Pod                                          | `analysis-7764d5744f-9mpgv`, UID `d2c3e869-bdbb-4321-8e42-9b0fb8ef0282`            | unchanged, Running and Ready |
| ClusterIP Service UID / IP                   | `9b0f82a1-7c94-4d3d-983e-779a3cf8aa2f` / `10.97.152.183`                           | unchanged                    |
| Tailscale Service UID / cluster IP           | `9c334712-f4aa-46b6-96d2-4bb63fb32db8` / `10.108.187.90`                           | unchanged                    |
| Tailscale address                            | `analysis.ide-newton.ts.net` / `100.88.130.68`                                     | unchanged                    |
| Image                                        | `registry.ide-newton.ts.net/lab/analysis:8abe6b2fc7bfc2ac249be7e2125164fd348be48d` | unchanged                    |

The `analysis` EndpointSlice had a ready endpoint and `http://analysis.ide-newton.ts.net/` returned HTTP 200.

## Image Promotion Contract

Generated Deployments retain logical image names. Promoted values remain in the parent application Kustomizations:

- The normal post-merge product pipeline built and published the multi-platform `docs` image from adoption revision
  `90cc200975cce30cfa233e63f3e23546a45d4653` as
  `registry.ide-newton.ts.net/lab/docs@sha256:cf21ba6fbf2748f9db46f4b2d77731be54b11c97f80ef79a477b53f3c35beb75`.

- `docs` retains its digest in `argocd/applications/docs/kustomization.yaml`; the docs promotion helper regression tests
  prove that updating the digest changes that parent file and fails closed if its image stanza changes.
- `analysis` retains its commit tag in `argocd/applications/analysis/kustomization.yaml`.
- Argo Image Updater retains `kustomization:/argocd/applications/docs` and
  `kustomization:/argocd/applications/analysis` as write-back targets.
- Blocking cdk8s CI renders both parents and verifies the final docs digest, analysis tag, and both write-back targets.

This keeps release automation independent from TypeScript synthesis and prevents generated files from becoming mutable
promotion targets.

### Live post-cutover promotion

The real release workflow changed only the digest field in `argocd/applications/docs/kustomization.yaml`; it did not edit
the generated resource files. Argo reconciled merge `fb509a2eeb94354fa55cd791a83046c21079ca45`, and the following expected image
rollout completed:

| Evidence            | Result                                                                                                                                                    |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Argo applications   | `root`, `argocd`, `docs`, and `analysis` were `Synced/Healthy` at `fb509a2eeb94354fa55cd791a83046c21079ca45`                                              |
| Deployment identity | UID remained `bccfe942-5d83-465b-9763-4f6050143d35`; generation advanced `30` to `31` and revision `26` to `27`                                           |
| Promoted image      | `registry.ide-newton.ts.net/lab/docs@sha256:cf21ba6fbf2748f9db46f4b2d77731be54b11c97f80ef79a477b53f3c35beb75`                                             |
| New ReplicaSet      | `docs-c7755f6db`, UID `3c94a124-af18-491a-8188-c636c3642773`, `1/1` Ready                                                                                 |
| New pod             | `docs-c7755f6db-5chmz`, UID `90460aae-9601-42a6-b3c7-82825429077b`, Running, Ready, zero restarts                                                         |
| Stable networking   | Service UID `90d452e6-c4e9-4fd7-8bf6-1773c3642194`, cluster IP `10.99.117.67`, and IngressRoute UID `7b62dc9a-d357-49f0-b51e-9d7825c6c729` were unchanged |
| Endpoint            | EndpointSlice was ready and `https://docs.proompteng.ai/` returned HTTP 200                                                                               |

This proves the existing release workflow can write the parent Kustomization after cdk8s adoption, Argo can render the
generated resource boundary with the new digest, and Kubernetes performs only the intended image rollout.

## Rollback

Rollback is an in-place GitOps revert of merge `90cc200975cce30cfa233e63f3e23546a45d4653`:

```bash
bun run --filter @proompteng/k8s test
bun run --filter @proompteng/k8s synth:check -- --all
git revert --no-commit 90cc200975cce30cfa233e63f3e23546a45d4653
# If image promotion has advanced either parent Kustomization, preserve its current digest or tag while resolving.
nix develop -c kustomize build argocd/applications/docs > /tmp/docs-rollback.yaml
nix develop -c kustomize build argocd/applications/analysis > /tmp/analysis-rollback.yaml
nix develop -c scripts/kubeconform.sh /tmp/docs-rollback.yaml
nix develop -c scripts/kubeconform.sh /tmp/analysis-rollback.yaml
kubectl apply --server-side --dry-run=server --validate=strict -n docs -f /tmp/docs-rollback.yaml
kubectl apply --server-side --dry-run=server --validate=strict -n analysis -f /tmp/analysis-rollback.yaml
git commit -m 'revert(k8s): restore handwritten application manifests'
```

After review and merge, let Argo restore the previous static desired state without deleting either Application,
namespace, or workload identity. Confirm `root`, `docs`, and `analysis` are `Synced/Healthy`; both Deployments are Ready;
the active ReplicaSet and pod identities are expected; `Service/docs`, `IngressRoute/docs`, `Service/analysis`, and
`Service/analysis-tailscale` retain their addresses and ready endpoints; and both HTTP checks return 200.
