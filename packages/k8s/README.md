# @proompteng/k8s

Build-time TypeScript authoring for repository-owned Kubernetes resources. The package writes deterministic, committed,
one-resource-per-file YAML into each application's existing Argo CD directory. Argo CD continues to reconcile static
Kustomize output and never executes TypeScript.

## Add an application

1. Create `src/apps/<name>/chart.ts` with explicit resource names and namespaces.
2. Add exact-contract tests in `src/apps/<name>/chart.test.ts`.
3. Export a `defineApplication(...)` declaration from `src/apps/<name>/application.ts`.
4. Import that declaration into the explicit list in `src/registry.ts`.
5. Prove parity, synthesize, and validate:

```bash
bun run --filter @proompteng/k8s parity -- --app <name> --baseline <git-ref>
bun run --filter @proompteng/k8s synth -- --app <name>
bun run --filter @proompteng/k8s synth:check -- --all
```

Writing synthesis requires one `--app`; `--all` is intentionally check-only so a failed chart cannot partially
regenerate multiple applications.

Generated files must only be changed through the synth command. The parent application Kustomization remains the
image-promotion write-back target.
