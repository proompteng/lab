# CI and Crossplane Packaging

## Repository layout

All Crossplane configuration packages live in `packages/crossplane/`. Each package must be OCI-compliant and
contain a `crossplane.yaml` at its root.

Example:

```
packages/
  crossplane/
    configuration-agents/
      crossplane.yaml
      apis/
      compositions/
    configuration-memory/
      crossplane.yaml
      apis/
      compositions/
    configuration-orchestration/
      crossplane.yaml
      apis/
      compositions/
```

## OCI compliance requirements

- The configuration package is an OCI image.
- `crossplane.yaml` is required at the package root.
- Package contents must only include XRDs and Compositions (other files must be excluded in build).

## CI requirements

CI must validate all packages on PR and on main merge:

1) Build each package with the Crossplane CLI.
2) Fail if package contains invalid or non-supported files.

Example validation command:

```
crossplane xpkg build \
  --package-root=packages/crossplane/configuration-agents \
  --ignore="**/examples/**"
```

## GitOps delivery

Argo CD should install configuration packages via `Configuration` CRs and reference the OCI image produced
by CI.

## Ownership

- Jangar owns the control-plane API and lifecycle.
- Crossplane owns provider reconciliation.
- Argo CD owns deployment and drift reconciliation.
