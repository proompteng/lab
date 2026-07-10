# cdk8s TypeScript Manifest Adoption Plan

**Goal:** Make TypeScript the authoring layer for repo-owned Kubernetes objects while preserving deterministic,
reviewable YAML as the GitOps artifact consumed by Kustomize and Argo CD.

**Decision:** Use cdk8s as a build-time compiler. Synthesize manifests locally and in CI, commit the generated YAML,
and keep Argo CD as the only reconciler. Do not make Argo repo-server dependency installation or TypeScript execution
part of the normal reconciliation path.

**First pilot:** Olden. It is disabled in the product ApplicationSet and has no live Application, Deployment, Service,
or pod. Its namespace remains Active. This creates a safe implementation window before a separately reviewed re-enable.

**Tech stack:** Bun 1.3.14, Node 24.11.1, TypeScript, cdk8s 2.x, `constructs` 10.x, Kustomize, kubeconform,
Argo CD, Kubernetes 1.35.

---

## Verified Baseline

The following was verified on 2026-07-09 against `origin/main` and the live `galactic-tailscale` cluster:

- Kubernetes server version is `v1.35.0`.
- The repository contains roughly 799 Argo YAML files across 100 top-level application directories.
- `services/bonjour/infra/` already defines a Deployment, Service, and HPA with cdk8s.
- `argocd/applicationsets/cdk8s.yaml` contains only the disabled Bonjour entry.
- `argocd/applications/argocd/plugin/cdk8s-plugin.yaml` runs `bun install` and synthesis in the Argo repo-server
  sidecar. The sidecar is live but has no enabled cdk8s Application consumer.
- `packages/cloutt/` is an older cdk8s experiment whose generated Reviseur output is no longer a reliable source of
  truth.
- The checked-in cdk8s CLI can successfully import `k8s@1.35.0` TypeScript L1 constructs.
- PR [#12208](https://github.com/proompteng/lab/pull/12208) disabled Olden at merge
  `dcf956e7540fdb0b92e7b1f0088d6ededd73a645`.
- Argo deleted the generated Olden Application. Because `preserveResourcesOnDeletion: true` left the Deployment and
  Service orphaned, those two resources were explicitly deleted. The `olden` namespace remains Active.
- A follow-up adds `cascadeResourcesOnDeletion: true` for Olden so a future generated Application carries Argo's
  resources finalizer and repeated disablement does not orphan a publicly routed workload.
- Root finished `Synced/Healthy` at the same merge revision.

This rollout behavior is a hard requirement for future disable/rollback procedures: ApplicationSet removal and child
resource pruning are separate truth surfaces and must be verified independently.

## Scope

### In scope

- Repo-owned Kubernetes workload resources such as Deployment, StatefulSet, Service, ConfigMap, RBAC, Job,
  CronJob, NetworkPolicy, PDB, PVC, and typed custom resources.
- Reusable TypeScript policy constructs for labels, security context, probes, resources, observability, and image
  contracts.
- Deterministic YAML generation, semantic tests, generated-drift checks, Kustomize rendering, schema validation, and
  rollout proof.
- Incremental migration without changing application behavior.

### Out of scope

- Eliminating YAML from the repository.
- Replacing Argo CD, Kustomize, Helm, External Secrets, or Sealed Secrets.
- Generating `Namespace` objects under `argocd/applications/**`.
- Migrating third-party Helm charts or remote vendor bases solely to make them TypeScript.
- Changing application images, ports, resources, probes, scheduling, secrets, or networking during a mechanical
  manifest migration.
- Applying generated manifests directly from CI.

## Target Architecture

```text
app-owned TypeScript chart
        |
        v
shared cdk8s runner + pinned L1 imports
        |
        v
argocd/applications/<app>/_generated/<app>.k8s.yaml
        |
        v
handwritten kustomization.yaml (images, overlays, patches)
        |
        v
Argo CD -> Kubernetes
```

Generated YAML is committed so pull requests expose the exact desired-state diff. Argo continues reading the existing
application directory with its native Kustomize integration; no cdk8s config-management plugin is needed for migrated
applications.

## Proposed Repository Layout

```text
packages/k8s-manifests/
  package.json
  cdk8s.yaml
  tsconfig.json
  src/
    imports/
      k8s.ts
    policy/
      assertions.ts
      labels.ts
      workload-security.ts
    synth.ts

apps/olden/infra/
  chart.ts
  chart.test.ts
  main.ts
  tsconfig.json

argocd/applications/olden/
  _generated/
    olden.k8s.yaml
  kustomization.yaml
```

Application charts live beside their owning code. Shared constructs move into `packages/k8s-manifests` only after at
least two applications need the same behavior. `_generated` files are never edited by hand; the owning synth command
must regenerate them.

## Authoring Contract

1. Use generated L1 constructs from `cdk8s import k8s@1.35.0` for the first migration wave.
2. Do not use cdk8s-plus abstractions during mechanical parity migrations. They can add generated names or internal
   selector labels that obscure the existing wire contract.
3. Set every `metadata.name` and namespace explicitly. Construct-path hashes must not determine live resource identity.
4. Reuse one labels object for workload selectors, pod-template labels, and Service selectors.
5. Use the existing logical image name in generated resources. Keep digest/tag promotion in the handwritten
   Kustomization `images` block.
6. Make synthesis depend only on committed inputs. Environment variables may select an application to synthesize but
   must not alter production manifest values.
7. Produce one stable multi-document file per application using `YamlOutputType.FILE_PER_CHART`.
8. Do not emit timestamps, random values, current Git SHA, absolute paths, or dependency-version banners into YAML.
9. Do not emit `Namespace` or plaintext `Secret` objects.
10. Keep large configuration payloads as ordinary source files and load them deterministically rather than embedding
    unreadable TypeScript template literals.

## Task 1: Establish the Shared Compiler Package

**Files:**

- Create: `packages/k8s-manifests/package.json`
- Create: `packages/k8s-manifests/cdk8s.yaml`
- Create: `packages/k8s-manifests/tsconfig.json`
- Create: `packages/k8s-manifests/src/synth.ts`
- Create: `packages/k8s-manifests/src/policy/*.ts`
- Modify: root `package.json`
- Modify: `bun.lock` only through `bun install`

- [ ] Pin `cdk8s`, `cdk8s-cli`, and `constructs` through the workspace lockfile.
- [ ] Start with the repository's existing cdk8s versions to isolate migration behavior from dependency upgrades.
- [ ] Add root commands `manifests:synth`, `manifests:synth:check`, and `manifests:test`.
- [ ] Make `manifests:synth -- --app <name>` select a registered app and reject unknown names.
- [ ] Clean only the selected application's generated output before synthesis.
- [ ] Write output atomically so a failed synth cannot leave a partially updated manifest.
- [ ] Add assertions for explicit names, no Namespace, no plaintext Secret, stable selectors, and approved image names.

**Acceptance:** Two clean synth runs produce identical hashes and a failed assertion leaves tracked output unchanged.

## Task 2: Generate And Pin Kubernetes L1 Types

**Files:**

- Create: `packages/k8s-manifests/src/imports/k8s.ts`
- Modify: `packages/k8s-manifests/cdk8s.yaml`

- [ ] Configure `cdk8s import k8s@1.35.0`.
- [ ] Commit generated imports, as recommended by cdk8s, so CI does not download API schemas during normal synthesis.
- [ ] Add `manifests:imports:check` to regenerate imports in a temporary directory and compare hashes.
- [ ] Record Kubernetes 1.35 as the import compatibility target.
- [ ] Upgrade imported Kubernetes types separately from workload migrations.

**Acceptance:** L1 import regeneration is deterministic and does not require cluster access.

## Task 3: Harden Bonjour As A Disabled Tooling Canary

**Files:**

- Modify: `services/bonjour/package.json`
- Modify: `services/bonjour/README.md`
- Modify: `services/bonjour/infra/main.ts`
- Modify: `services/bonjour/infra/server-chart.ts`
- Create: `services/bonjour/infra/server-chart.test.ts`

- [ ] Fix the local `synth` command, which currently lacks a usable cdk8s app configuration.
- [ ] Make infra TypeScript part of blocking type-aware lint and type-check coverage.
- [ ] Add structural tests for Deployment, Service, and HPA output.
- [ ] Synthesize twice and prove byte-for-byte determinism.
- [ ] Validate generated output with kubeconform.
- [ ] Keep Bonjour disabled; this task proves compiler mechanics only.

**Acceptance:** Bonjour synthesis is reproducible locally and in CI without changing live cluster state.

## Task 4: Implement Olden With Exact Semantic Parity

**Files:**

- Create: `apps/olden/infra/chart.ts`
- Create: `apps/olden/infra/chart.test.ts`
- Create: `apps/olden/infra/main.ts`
- Create: `apps/olden/infra/tsconfig.json`
- Create: `argocd/applications/olden/_generated/olden.k8s.yaml`
- Modify: `argocd/applications/olden/kustomization.yaml`

- [ ] Reproduce the current Olden Deployment and Service with L1 constructs.
- [ ] Preserve names `Deployment/olden` and `Service/olden` in namespace `olden`.
- [ ] Preserve the `app: olden` selector contract.
- [ ] Preserve rolling-update settings, arm64 node selector, seccomp profile, container security context, CPU/memory
      requests and limits, port 3000, and readiness probe.
- [ ] Emit the logical image `registry.ide-newton.ts.net/lab/olden` without an inline digest.
- [ ] Replace `deployment.yaml` and `service.yaml` references in Kustomization with `_generated/olden.k8s.yaml`.
- [ ] Keep the current Kustomize image digest override unchanged.
- [ ] Compare normalized old and generated objects by `apiVersion/kind/namespace/name` and full `spec`.
- [ ] Delete handwritten Deployment and Service YAML only after parity checks pass.

**Acceptance:** Fully rendered Kustomize output is semantically identical to the pre-migration desired state, excluding
YAML key ordering and comments.

## Task 5: Add Blocking CI

**Files:**

- Create: `.github/workflows/cdk8s-manifests.yml`
- Modify: `.github/workflows/kubeconform.yml`
- Modify: `.github/workflows/pull-request.yml` if app-specific chart checks remain there

- [ ] Trigger on app infra TypeScript, shared manifest code, generated YAML, cdk8s config, imported types, and lockfile
      changes.
- [ ] Install dependencies with the pinned Bun version and frozen lockfile.
- [ ] Run formatting, lint, type-checking, and cdk8s structural tests.
- [ ] Run synthesis twice and compare output hashes.
- [ ] Run tracked synthesis and fail on `git diff --exit-code -- argocd/applications/**/_generated`.
- [ ] Run `scripts/kubeconform.sh` against generated manifests.
- [ ] Run `kustomize build --enable-helm` for each changed application and validate the fully rendered output.
- [ ] Scan rendered resources for Namespace, plaintext Secret, mutable image tags, and missing workload policies.
- [ ] Keep strict server dry-run as a protected rollout gate where an in-cluster ARC service account is available; do
      not provide general GitHub-hosted runners with cluster credentials.

**Acceptance:** A TypeScript-only manifest change cannot merge without updated generated YAML and successful schema,
render, and policy validation.

## Task 6: Review And Re-enable Olden Separately

The implementation PR must leave Olden disabled. Re-enable only after the generated diff is reviewed and merged.

- [ ] Create a fresh re-enable branch from the implementation merge.
- [ ] Change Olden to `enabled: "true"` and temporarily set `automation: manual`.
- [ ] Confirm the generated Olden Application carries `resources-finalizer.argocd.argoproj.io` before syncing it.
- [ ] Validate the product ApplicationSet and enabled-app inventory counts.
- [ ] Merge after green CI.
- [ ] Sync root through Argo and wait for the generated Olden Application.
- [ ] Inspect the Argo diff before syncing Olden.
- [ ] Sync Olden and verify Deployment/Service identity, image digest, rollout strategy, pod readiness, endpoints, and
      HTTP `/` response.
- [ ] Confirm root and Olden are `Synced/Healthy` at the intended revision.
- [ ] Restore `automation: auto` in a follow-up after one stable reconciliation window.

**Acceptance:** Olden returns with the same resource names and behavior, served from TypeScript-authored and
Git-reviewed generated YAML.

## Task 7: Expand In Controlled Waves

| Wave | Candidates                             | Rationale                                                             |
| ---- | -------------------------------------- | --------------------------------------------------------------------- |
| 1    | Olden                                  | Deployment + Service, no secrets or CRDs; currently disabled.         |
| 2    | Bumba, Analysis, Khoshut               | Small first-party workloads with limited composition.                 |
| 3    | Docs, Proompteng                       | Add typed Traefik and Tailscale resources after CRD import is proven. |
| 4    | Oirat, Registry, Flamingo              | RBAC/secret, persistence/networking, or GPU rollout risk.             |
| 5    | Agents, Torghut, Jangar, Observability | Large CRD-heavy applications requiring mature shared constructs.      |

Third-party Helm/operator applications remain YAML/Helm unless a separate decision shows a concrete maintenance
benefit.

For each application:

- [ ] Migrate without unrelated runtime changes.
- [ ] Preserve resource identity and Kustomize image promotion.
- [ ] Require normalized semantic parity before deleting handwritten YAML.
- [ ] Land implementation while the application's existing automation remains safe.
- [ ] Verify live Argo state and workload-specific health after rollout.
- [ ] Record rollback behavior and any resources not pruned by Application deletion.

## Task 8: Add Typed CRDs From Pinned Sources

**Files:**

- Create: `packages/k8s-manifests/crds/`
- Create: `packages/k8s-manifests/src/imports/<group>.ts`
- Modify: `schemas/custom/**` through the owning schema generator

- [ ] Vendor CRDs from the exact operator/chart revision used by GitOps.
- [ ] Never import CRDs from the live cluster during CI.
- [ ] Generate cdk8s L1 bindings and kubeconform schemas from the same pinned CRD revision.
- [ ] Commit both generated TypeScript bindings and validation schemas.
- [ ] Add drift checks for both outputs.
- [ ] Prefer L1 bindings until repeated usage justifies a higher-level construct.

**Acceptance:** Custom-resource typing and schema validation cannot silently target different CRD versions.

## Task 9: Retire The Argo cdk8s Plugin

After all intended consumers use committed generated YAML:

- [ ] Verify no Application references `source.plugin.name: cdk8s`.
- [ ] Remove `argocd/applicationsets/cdk8s.yaml` or move any remaining app into a standard ApplicationSet.
- [ ] Remove the cdk8s ConfigManagementPlugin and repo-server sidecar.
- [ ] Render and validate the Argo application.
- [ ] Roll out through GitOps.
- [ ] Verify both repo-server replicas are Ready without the sidecar and root/argocd are `Synced/Healthy`.

**Acceptance:** Argo reconciliation no longer depends on Bun, npm registry availability, or TypeScript execution.

## Rollback Strategy

1. If generated manifests fail before merge, regenerate or revert the TypeScript change; tracked YAML remains the
   review boundary.
2. If an enabled application renders incorrectly before sync, do not sync it. Revert the implementation commit.
3. If a live application regresses, revert to the last handwritten or generated-good revision and sync through Argo.
4. If an application must be disabled, require an explicit per-app cascade/preserve decision. Apps marked
   `cascadeResourcesOnDeletion: true` must receive `resources-finalizer.argocd.argoproj.io` before they are removed from
   the generator.
5. After setting an ApplicationSet entry to `enabled: "false"`, verify the generated Application and child resources
   independently. Do not infer pruning from Application deletion alone.
6. Delete orphaned resources explicitly only after the Application is gone and the desired disabled state is confirmed.
7. Preserve namespaces unless namespace deletion is explicitly requested.

## Adoption Completion Gates

The adoption is complete only when:

- TypeScript is the authoritative source for migrated Kubernetes objects.
- Generated YAML is deterministic, committed, and never hand-edited.
- CI blocks source/output drift and validates the final Kustomize render.
- Resource identities and image-promotion behavior remain stable.
- CRD bindings and kubeconform schemas share pinned inputs.
- Olden has been re-enabled and proven `Synced/Healthy` through the new path.
- The Argo cdk8s runtime plugin is removed after its last consumer is gone.
- Rollback and disablement procedures reflect observed ApplicationSet deletion behavior.

## References

- [cdk8s overview](https://cdk8s.io/docs/latest/)
- [cdk8s synth](https://cdk8s.io/docs/latest/cli/synth/)
- [cdk8s import](https://cdk8s.io/docs/latest/cli/import/)
- [cdk8s testing](https://cdk8s.io/docs/latest/basics/testing/)
- [cdk8s resource naming](https://cdk8s.io/docs/latest/basics/api-object/)
- [Argo CD application sources](https://argo-cd.readthedocs.io/en/stable/user-guide/application_sources/)
- [Argo CD Kustomize integration](https://argo-cd.readthedocs.io/en/stable/user-guide/kustomize/)
- [Kubernetes server-side dry-run](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_apply/)
