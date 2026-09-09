# Kubernetes

Status: Current source map for the Talos-based `galactic` cluster.

## Current cluster

The current home-lab Kubernetes cluster is managed by Omni/Talos. Argo CD owns application desired state.

Start with:

1. `devices/galactic/README.md`
2. `docs/runbooks/galactic-kubernetes-access.md`
3. `devices/galactic/docs/bootstrap-argocd.md`
4. `devices/galactic/omni/README.md`
5. `docs/runbooks/rook-ceph-on-talos.md`

Machine configuration and Kubernetes upgrades flow through Omni. Normal application and platform changes flow through
committed manifests under `argocd/**`, CI validation, Kargo where applicable, and Argo CD reconciliation. Direct
`kubectl apply` is reserved for the documented initial Argo bootstrap, the explicitly operator-invoked diagnostic
resources below, or a bounded emergency procedure.

Validate GitOps manifests from the repository root:

```bash
bun run lint:argocd
```

## Supporting manifests

The active, independently operated material under this directory is limited to:

- `kubernetes/coder/**`: Coder workspace infrastructure and validation.
- `kubernetes/rook-ceph-rbd-canary/**`: explicit RBD/NBD storage canaries.
- `kubernetes/rook-ceph-rwx-benchmarks/**`: explicit CephFS benchmark jobs.

These canaries and benchmarks are operator-invoked diagnostics. Follow their nearest README and always use an explicit
cluster context and namespace.

## Legacy files retained pending verification

The following files describe the retired Harvester-backed K3s fleet and are not current cluster instructions:

- `kubernetes/install.sh`
- `kubernetes/install-k3s.ts`
- `kubernetes/devices.json`
- `tofu/harvester/**`
- `tofu/rancher/**`
- the K3s/Rancher inventory and playbooks under `ansible/**`

They remain in the working tree only until the external-state and consumer checks in
`docs/repository-cleanup-todo.md` are complete. Do not run them against `galactic`.
