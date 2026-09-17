# Release the Temporal Bun SDK

From the repository root, run:

```bash
bun run release:temporal
```

The command uses your existing `gh` login to open or update the SDK version PR
from commits on `main`. Release Please chooses the version from Conventional
Commits and updates `package.json`, `CHANGELOG.md`, and
`.release-please-manifest.json`. Your login lets the PR trigger normal GitHub
Actions checks without adding a repository secret.

Review and merge that PR after its checks pass. The main-branch workflow detects
the version increase, runs the integration and load suites on the shared Temporal
cluster, and publishes to npm with trusted publishing and provenance. It then
downloads the published package and verifies its readiness artifacts. It creates
the GitHub release and tag at the commit recorded in that package, then marks the
version PR released so the next release can proceed. No second publish dispatch
is needed.

Preparing a version PR does not run the build or integration suite. PR checks
validate the proposed version, and publication still requires the existing replay,
fuzz, load, package, and provenance gates for the merged commit. Ordinary source
pushes cannot republish an unchanged version.

Shared-cluster checks run one at a time so cleanup cannot interrupt another
release's tests. GitHub's [concurrency queue](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)
keeps later runs waiting instead of replacing a pending release.

Service dependency caches contain installed dependencies. Image builds restore
the current workspace manifests separately, so a version or release-command
change does not require refreshing dependency hashes. Dependency and lockfile
changes still go through the dependency closure checks.

## Preview the version PR

```bash
bun run release:temporal --dry-run
```

This reads GitHub and prints the proposed release without opening or updating a
PR. Only commits already on `main` enter the release. You can also run
`bun run release` from `packages/temporal-bun-sdk`.

## Retry or dry-run publication

If publication fails, rerun the failed jobs from the main-branch workflow run.
An already published version is verified instead of published again. To validate
the current main version without uploading it:

```bash
gh workflow run temporal-bun-sdk.yml --ref main \
  -f release_mode=publish -f dry_run=true -f npm_tag=latest
```

Use `dry_run=false` to retry publication through a new workflow run. For a
prerelease, choose `npm_tag=beta` or `npm_tag=next`. Automatic publication accepts
stable version increases only. The package and manifest versions must match.
Dry runs leave release PR labels unchanged.

The workflow's older `release_mode=prepare` option remains available and now runs
only Release Please. It uses `GITHUB_TOKEN`, so GitHub does not start PR workflows
for its generated PR. Prefer the local command. If you use that fallback, close
and reopen its PR with your own GitHub account to trigger checks before merging.

## Readiness evidence

The `production-readiness-artifacts` artifact contains the package readiness and
provenance files plus replay, fuzz, and load reports. Publication requires evidence
from the same commit and GitHub Actions run. Local tests cannot replace this
release evidence. CI continues to use `temporal-grpc:7233` on ARC runners.

The GitHub Actions run, npm publication result, and published-package verification
are the release receipt. A merged version PR alone does not prove npm publication.
