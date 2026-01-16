# CI Workflows (Implementation-Grade)

This document defines the exact CI checks required for Crossplane configuration packages.

## 1) GitHub Actions workflow (example)

```yaml
name: crossplane-xpkg
on:
  pull_request:
    paths:
      - 'packages/crossplane/**'
  push:
    branches: [main]
    paths:
      - 'packages/crossplane/**'

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Install Crossplane CLI
        run: |
          curl -sL https://raw.githubusercontent.com/crossplane/crossplane/master/install.sh | sh
          sudo mv crp /usr/local/bin/crossplane
      - name: Build memory package
        run: |
          crossplane xpkg build --package-root=packages/crossplane/configuration-memory --ignore='**/examples/**'
      - name: Build orchestration package
        run: |
          crossplane xpkg build --package-root=packages/crossplane/configuration-orchestration --ignore='**/examples/**'
```

## 2) Required checks

- Must run on PR and main
- Must fail if `crossplane.yaml` is missing or malformed
- Must fail if non-XRD/Composition YAML is included

**Note:** The `configuration-agents` package is deprecated in favor of the native Agents CRDs installed
via `charts/agents`.

## 3) Optional release step (main)

- Build OCI image and push to registry
- Update `Configuration` CRs in GitOps to point at new image tags
