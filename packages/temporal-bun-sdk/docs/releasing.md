# Release the Temporal Bun SDK

To publish the next patch version from `main`, run this command from the repository root:

```bash
bun run release:temporal patch
```

The command uses your existing `gh` login. It opens or updates the version PR,
waits for CI and review, and merges the exact checked commit. It then follows the
publication workflow and downloads the package from npm. Before reporting
success, it verifies the package version, readiness artifacts, source commit, and
GitHub release tag. The final output includes the install command and release links.

This command merges and publishes. To inspect the proposed release first, add
`--dry-run`. To open the PR for a manual merge, add `--prepare-only`.

Use `minor`, `major`, or an exact stable version instead of `patch` when needed.
Omit the version argument to let Release Please select it from Conventional
Commits. Only commits already on `main` enter the release. The command does not
switch your checkout or include local changes. You can also run `bun run release`
from `packages/temporal-bun-sdk`.

If a check fails or a review needs attention, the command stops with the PR link.
Resolve the failure and run the same command again. An interrupted command can
resume its merged release even after GitHub marks the package published. The
command saves the release PR and version locally before waiting for checks, and
retains them until package and tag verification succeeds. Resuming a failed
publication reruns its failed jobs instead of opening another version PR. To resume verification of the latest
completed release from another checkout, pass its exact version.

If `main` changes during validation, rerun the command to regenerate and recheck
the version PR. The command checks both the PR commit and its base commit before
merging so the generated changelog matches the selected release.
The merge commit records the checked base. The publication workflow verifies that
record against the actual merge parent before allowing an npm upload; a base
change during GitHub's merge operation stops publication. Rerunning the command
prepares a replacement version from current `main`, skipping the rejected version.
If you selected an exact version, choose a newer version for the replacement.

The main-branch workflow runs the integration and load suites on the shared
Temporal cluster, then publishes with npm trusted publishing and provenance.
The workflow creates the GitHub release and tag after it verifies the uploaded
package. No local npm token or second publish dispatch is needed.

Preparing a version PR does not run the build or integration suite. PR checks
validate the proposed version, and publication still requires the existing replay,
fuzz, load, package, and provenance gates for the merged commit. Ordinary source
pushes cannot republish an unchanged version.

Shared-cluster checks run one at a time so cleanup cannot interrupt another
release's tests. GitHub's [concurrency queue](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)
keeps later runs waiting instead of replacing a pending release.
Cleanup verifies stale visibility records immediately after Temporal confirms
their workflows have completed. Actual running workflows still fail verification.
Publications share one package-wide queue across versions. Before uploading a
new version, the workflow checks its npm dist-tag and refuses to move it backward
if a newer version has already reached that tag.

Service dependency caches contain installed dependencies. Image builds restore
the current workspace manifests separately, so a version or release-command
change does not require refreshing dependency hashes. Dependency and lockfile
changes still go through the dependency closure checks.

## Preview the version PR

```bash
bun run release:temporal patch --dry-run
```

This reads GitHub and prints the proposed release without opening or updating a
PR. For example, `patch` proposes `0.11.4` when `main` contains `0.11.3`.

To stop after preparing that PR:

```bash
bun run release:temporal patch --prepare-only
```

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
