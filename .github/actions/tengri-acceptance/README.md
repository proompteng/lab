# Tengri acceptance runner

This standalone Bun package owns the real guest acceptance command invoked by
`tengri-post-deploy.yml`. Its pinned artifact client and lockfile are isolated from
the product workspace so CI-only dependencies do not alter product image inputs.
The product Nix dependency filters explicitly exclude this package, including its
directory structure; the shared workspace lockfile stays unchanged.

From the repository root:

```bash
bun install --cwd .github/actions/tengri-acceptance --frozen-lockfile --ignore-scripts
bun run --cwd .github/actions/tengri-acceptance test
```

Run the CLI from the repository root so its Git and manifest reads resolve the
checked-out Kargo revision. See [acceptance setup and safety](../../../docs/tengri/acceptance.md)
for authenticated execution, required read permissions, and recovery behavior.
