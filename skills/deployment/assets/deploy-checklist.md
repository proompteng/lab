# Kargo deployment checklist

- [ ] Source PR merged to `main`.
- [ ] Main build/test workflow passed, completed the final multi-architecture index, and published the eligible
      `kargo-sha-<40>` alias with the required OCI source-time/revision labels (or the external contract: `analysis`
      `latest`/`Digest` discovery with immutable digest pinning, or `bilig` bare 40-hex/`NewestBuild`).
- [ ] Kargo Warehouse discovered the image and created Freight in `lab-delivery`.
- [ ] The exact automatic policy promoted the intended Stage in `lab-delivery`.
- [ ] Kargo pushed the exact source commit, digest, and build/provenance metadata to `kargo/<stage>` and Argo
  Application sync/health completed in `argocd`.
- [ ] Workload rollout completed and the running image ID matches the promoted digest (or its platform child digest).
- [ ] Service-specific readiness and live checks passed.
- [ ] Delivery record distinguishes merged, built, published, Freight, promoted, Argo healthy, rollout, and live proof.

Do not add a SHA/digest manifest PR, release branch, release automerge, Image Updater write-back, manual Argo sync, or
direct `kubectl` deployment. Re-promote a known-good Freight for a rollback. Bayn is outside Kargo and requires its
`bayn-release` activation and lineage authority.
