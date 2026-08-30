# Argo CD ApplicationSets

Status: Current source map for the `galactic` GitOps hierarchy.

The root Argo CD Application is `argocd/root.yaml`. It owns this directory and registers four ApplicationSets:

- `helm-apps.yaml`: OCI Helm releases such as Kargo.
- `bootstrap.yaml`: cluster prerequisites and GitOps controllers.
- `platform.yaml`: shared infrastructure and tooling.
- `product.yaml`: product workloads.

The same root also owns `home-root.yaml`, which delegates the separate home repository, and
`home-repo-credentials.yaml`, which generates its repository credential. A normal repository change must preserve all
of these root-owned resources.

## Normal change path

1. Edit the owning ApplicationSet entry or application manifests under `argocd/applications/**`.
2. Run `bun run lint:argocd` and the focused renderer/tests for the changed application.
3. Commit the change and let CI, Kargo where applicable, and Argo CD reconcile it.
4. Verify the generated Application source/revision and sync/health state.

Do not manually create ApplicationSets, apply child applications, or sync around Kargo as a normal deployment path.
ApplicationSet entries own namespaces through `CreateNamespace=true` and managed namespace metadata; child application
renders must not contain `Namespace` resources.

Useful read-only checks:

```bash
GALACTIC_CONTEXT=galactic-lan # or galactic-tailscale
kubectl --context "$GALACTIC_CONTEXT" -n argocd get application root
kubectl --context "$GALACTIC_CONTEXT" -n argocd get applicationsets
kubectl --context "$GALACTIC_CONTEXT" -n argocd get applications.argoproj.io
```

## Initial bootstrap

A new cluster necessarily has a short bootstrap interval before Argo CD can own itself. Follow
`devices/galactic/docs/bootstrap-argocd.md` for that bounded procedure, including CRD ordering and the initial
`argocd/root.yaml` handoff. Once the root Application is healthy, return to the normal GitOps path above.

Only during that first bootstrap, install the large ApplicationSet CRD server-side before handing ownership to Argo
CD:

```bash
GALACTIC_CONTEXT=galactic-lan # or galactic-tailscale
kubectl --context "$GALACTIC_CONTEXT" apply --server-side --force-conflicts \
  -f https://raw.githubusercontent.com/argoproj/argo-cd/v3.5.2/manifests/crds/applicationset-crd.yaml
```

If the server-side apply cannot create a missing CRD, the create-only fallback is:

```bash
curl -fsSL https://raw.githubusercontent.com/argoproj/argo-cd/v3.5.2/manifests/crds/applicationset-crd.yaml \
  | kubectl --context "$GALACTIC_CONTEXT" create -f -
```

Do not use either command as routine reconciliation after `argocd/root.yaml` is healthy.

After the Argo CD control plane is ready, perform the one-time handoff to the repository root Application:

```bash
kubectl --context "$GALACTIC_CONTEXT" -n argocd apply -f argocd/root.yaml
kubectl --context "$GALACTIC_CONTEXT" -n argocd get application root
kubectl --context "$GALACTIC_CONTEXT" -n argocd get applicationsets
```

The repository is public, so this root handoff does not require a manually registered repository credential. Once the
`root` Application is healthy, it owns every resource listed above; do not apply the child ApplicationSets directly.

The former Harvester preparation command and manual child-ApplicationSet workflow were removed from this runbook. Their
retained files are tracked for evidence-gated retirement in `docs/repository-cleanup-todo.md`.
