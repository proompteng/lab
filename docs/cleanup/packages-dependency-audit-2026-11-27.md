# Package dependency audit — 2026-11-27

Wave 20B audited all 15 directories in `packages/` on `aa0a2d91f`. The audit compared declared dependencies in
all 42 tracked `package.json` files with repo-wide `rg` searches for package names, relative paths, CLI names,
imports, tests, build inputs, and runbooks. It also checked the Rust manifests, Nix install filters and source paths,
Dockerfiles, CI workflows, and the CI impact map. A zero count in workspace manifests was not enough to delete a package.

## Package inventory

| Package                    | Verified consumers and decision                                                                                                                                                                                                                                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `agent-contracts`          | **Keep.** Froussard, Agents, Jangar, and Memories import the shared contracts. Froussard, Agents, and Jangar also include them in Nix images.                                                                                                                                                                                        |
| `atelier`                  | **Removed.** This private Temporal bootstrap helper had no external imports, manifest dependencies, build inputs, or workflow calls. The root type-lint list and package inventory were its only outside references. The [Temporal bootstrap procedure](../../argocd/applications/README.md#temporal) already uses the Temporal CLI. |
| `backend`                  | **Keep.** Landing consumes the generated Convex client; the Proompteng Nix image includes it. Root dev, seed, and codegen commands and the manual Convex deploy workflow also use it.                                                                                                                                                |
| `cloutt`                   | **Removed.** The cdk8s-plus experiment generated Reviseur manifests locally. Reviseur uses separate checked-in Kustomize manifests. No other package, Nix build, CI workflow, or external test used the generator or its private sealed-secret helper.                                                                               |
| `codex`                    | **Keep.** Agentctl, Agents, Jangar, and Symphony declare the SDK; Sag imports it and includes it in its Nix image. Root postinstall builds its artifacts, and Codex CI checks the app-server protocol.                                                                                                                               |
| `cx-tools`                 | **Keep.** The Agents and Jangar images build and install its CLI binaries. Image-layout tests cover them even though no other manifest depends on the workspace.                                                                                                                                                                     |
| `design`                   | **Keep; trim dependencies.** App, Docs, Landing, Olden, Reestr, Synthesis, Golink, and Jangar import components or styles. Nix images include it, and Schematic offers it in its TanStack template.                                                                                                                                  |
| `discord`                  | **Keep.** Oirat imports the SDK, and Jangar uses it in its Discord channel tooling. Both images include it; root scripts build and test it.                                                                                                                                                                                          |
| `k8s`                      | **Keep.** The cdk8s CLI produces the checked-in Docs and Analysis GitOps manifests. Both standalone cdk8s CI and the PR gate check synthesis and generated imports.                                                                                                                                                                  |
| `otel`                     | **Keep.** Agents, Bonjour, Jangar, and Symphony import the telemetry shims. Root postinstall and Nix images build them.                                                                                                                                                                                                              |
| `platform-client`          | **Keep.** This is a Rust crate, not a Bun workspace. Ofz and Relay declare it by path; the Ofz image and Relay Nix package include it, and Relay CI tests it.                                                                                                                                                                        |
| `schematic`                | **Keep.** No application manifest declares this generator, but its CLI and templates have dedicated [CI and tests](../../.github/workflows/schematic-ci.yml). It still emits a reference to the shared Docker workflow.                                                                                                              |
| `scripts`                  | **Keep.** Root scripts, CI workflows and actions, image builders, and operator runbooks invoke its files directly.                                                                                                                                                                                                                   |
| `temporal-bun-sdk`         | **Keep.** Agents, Bumba, Jangar, Scripts, and the example declare it. Agents, Bumba, and Jangar include it in Nix images; CI also validates and publishes it as a standalone npm package.                                                                                                                                            |
| `temporal-bun-sdk-example` | **Keep.** The SDK's [Effect workflow test](../../packages/temporal-bun-sdk/tests/workflow/example-effect4.test.ts) imports it directly. The SDK evidence collector and CI use it, and the SDK docs link to it.                                                                                                                       |

## Dependency changes

- Removed 18 unused Radix component declarations from `design`. The components use Base UI; the Radix Label and
  Slot imports are still required and were retained.
- Removed the unused JetBrains Mono, Tabler Icons, and `date-fns` declarations from `design`. The audit included the
  exported CSS and shadcn configuration. Apps that import the font or Tabler Icons already declare them directly.
  Removing declarations does not remove dependencies still needed elsewhere or transitively.
- Regenerated `bun.lock` with Bun 1.4.2 without introducing new package versions. Refreshed the affected Nix
  fixed-output hashes for both Linux architectures. Besides the smaller Design closures, the installed-tree
  closures no longer contain the two deleted workspace directories; those directories were part of the hashed
  output even when neither workspace was selected.

## Deferred

- Keep Schematic until its CLI, tests, and shared workflow contract are retired together. The
  [cleanup backlog](../repository-cleanup-todo.md#direct-cluster-deployment-bypasses) tracks its generated direct-apply
  path separately.
- Keep the Temporal example until the SDK regression test, evidence collector, CI, and documentation no longer
  depend on it. The absence of a downstream workspace declaration does not make it dead.
- App and service dependency manifests were not pruned in this wave. Audit them at their own build and test
  boundaries rather than assuming unused declarations in `design` are unused by its consumers.
