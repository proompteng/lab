# Release Branch Auto-PR Workflow

This workflow opens pull requests whenever Argo CD Image Updater commits to a `release/<sha256>` branch or when a maintainer triggers the `workflow_dispatch` input. The automation relies on standard GitHub Actions branching semantics and the release workflow documented in GitHub’s [manual dispatch guide](https://docs.github.com/actions/using-workflows/events-that-trigger-workflows#workflow_dispatch).

## Release PR Automerge

PRs created from release branches can be auto-merged by [`.github/workflows/release-pr-automerge.yml`](../.github/workflows/release-pr-automerge.yml) when they match strict safety gates:

- Base branch is `main`.
- Head branch starts with `release/`.
- PR is not draft.
- PR author is allowlisted GitHub Actions identity.
- PR head repository matches the base repository.
- Label `do-not-automerge` is not present.
- All changed files are allowlisted release artifacts (currently:
  - `argocd/applications/proompteng/kustomization.yaml`
  - `argocd/applications/synthesis/kustomization.yaml`
  - `argocd/applications/bumba/kustomization.yaml`
  - `argocd/applications/khoshut/kustomization.yaml`
  - `argocd/applications/analysis/kustomization.yaml`
  - `argocd/applications/bilig/kustomization.yaml`
  - `argocd/applications/olden/kustomization.yaml`
    ).

The workflow enables squash auto-merge (`gh pr merge --auto --squash`) only after all eligibility checks pass. GitHub still enforces required checks and merge rules before the merge actually executes.

### Operator Controls

- To block automerge for a specific release PR, add label `do-not-automerge`.
- To inspect automerge decisions:
  - `gh pr view <num> -R proompteng/lab --json labels,author,baseRefName,headRefName,files`
  - `gh run view <run-id> -R proompteng/lab`
  - `gh pr checks <num> -R proompteng/lab`

## Enrolling a New Application

1. Add the app to the `product-image-updater` ImageUpdater resource with a `writeBackTarget` that points at its Kustomize directory.
2. Confirm [`.github/workflows/auto-pr-release-branches.yml`](../.github/workflows/auto-pr-release-branches.yml) still watches `release/**` branches and `argocd/applications/*/kustomization.yaml`.
3. Add the app Kustomization file to the allowlist in [`.github/workflows/release-pr-automerge.yml`](../.github/workflows/release-pr-automerge.yml) if its release PRs should auto-merge.
4. Push an Image Updater-style change to a `release/<sha256>` branch or trigger the workflow manually with `head_branch=release/<sha256>` to verify that a pull request is created.

## Enabling Docker Image Publishing

When a new application should ship a container image, mirror its registration in [`.github/workflows/docker-build-push.yaml`](../.github/workflows/docker-build-push.yaml).

1. Add the application under the `dorny/paths-filter` step so that commits touching its source trigger a build.
2. Confirm the workflow declares explicit `permissions:` at the top level (for example `contents: read`) and only grants broader access to the individual jobs that require it.
3. If the app is Next.js-based, set `output: 'standalone'` in `next.config.mjs` so the build generates the `/standalone` server bundle consumed by the Dockerfile.
4. Create a `build-<app>` job that calls `docker-build-common.yaml` with the application's image name, Dockerfile path, and build context.
5. Append the job to the `cleanup-release` `needs` list so failed builds automatically roll back the tag and release.

This keeps the continuous delivery release tagging and the image publishing workflow in sync whenever a new app comes online.

## Formatting Notes

- Use single quotes for all YAML string literals in `.github/workflows/auto-pr-release-branches.yml` to keep quoting consistent and avoid escaping GitHub expressions like `${{ ... }}`.
- Run `bun run format` before committing if you make broader changes that touch project code; the workflow file is not autoformatted, so keep it tidy by hand.

This documentation helps ensure the `workflow_dispatch` options stay synchronized with the applications managed by Argo CD Image Updater.
