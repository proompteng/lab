# Feature flags

Flipt reads the flag catalog from the `feature-flags-state` branch of `proompteng/lab`.
Its bare Git repository is persisted on PVC `feature-flags` at
`/var/opt/flipt/repositories/default`. The application follows reviewed `main`
configuration through Argo CD and retains its pinned upstream Flipt image.
The storage branch must contain
`argocd/applications/feature-flags/gitops/default/features.yaml`. A branch with
only the bootstrap README starts successfully but cannot evaluate catalog flags.

## Git cache recovery

The `repair-git-cache` init container runs before Flipt. It moves empty files from
`refs/remotes/origin` into unique directories under `default.ref-backups`, then lets
Flipt fetch the remote refs again. It preserves local branches, objects, nonempty
remote refs, and lock files. If it cannot create a backup, startup fails and the
original ref remains in place.

For other Git errors, inspect and back up the cached repository before a repair.
Preserve unpushed commits. Keep the PVC and repair only confirmed corruption.

Render and run the recovery regression tests from the repository root:

```sh
nix develop -c kustomize build --enable-helm argocd/applications/feature-flags > /tmp/feature-flags.yaml
nix develop -c yq eval-all -o=json -I=0 '[.]' /tmp/feature-flags.yaml > /tmp/feature-flags.json
FEATURE_FLAGS_RENDERED_MANIFEST=/tmp/feature-flags.json python3 argocd/applications/feature-flags/repair_git_cache_test.py -v
nix develop -c shellcheck argocd/applications/feature-flags/repair-git-cache.sh
```

## Rollout verification

After Argo CD reconciles the reviewed commit, confirm that `repair-git-cache`
completed successfully, the Flipt pod is ready, and the services have ready
endpoints. Check `/health` and evaluate a known catalog flag through
`POST /evaluate/v1/boolean`. Argo CD sync status alone does not prove flag evaluation.

If recovery fails, inspect init-container logs and the preserved ref backups.
Restore the repository backup only after checking for newer local commits.
