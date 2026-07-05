# Nix Enabled-App Rollout Evidence - 2026-07-05

This is an evidence checkpoint for the enabled-app Nix build performance rollout. It is not the final rollout report.

## Scope

- Enabled apps proved: `oirat`, `bumba`.
- Build paths: `.github/workflows/oirat-ci.yml` and `.github/workflows/bumba-ci.yml` using
  `.github/workflows/nix-oci-build-common.yml`.
- Nix attrs: `oirat-image`, `bumba-image`.
- Manual paths present:
  - `packages/scripts/src/oirat/build-image.ts` and `packages/scripts/src/oirat/deploy-service.ts`
  - `packages/scripts/src/bumba/build-image.ts` and `packages/scripts/src/bumba/deploy-service.ts`
- Release path: `.github/workflows/enabled-simple-nix-release.yml` plus `.github/workflows/release-pr-automerge.yml`.
- Hard exclusions respected: no Ceph, Rook, ObjectBucketClaim, PVC, Talos, node, power, or storage changes.

## Fixes Landed

| PR                                                     | Commit                                     | Purpose                                                                                        |
| ------------------------------------------------------ | ------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| [#12032](https://github.com/proompteng/lab/pull/12032) | `4404a90ac83d6643b78a6f847e5a34b0416ae3bd` | Refresh stale Oirat fixed-output Bun dependency hashes for `x86_64-linux` and `aarch64-linux`. |
| [#12035](https://github.com/proompteng/lab/pull/12035) | `30405fc1be26d5d52eb8e8c4afbd034bf86bd583` | Fix generated release PR automerge when the automation token authors PRs as `gregkonush`.      |
| [#12034](https://github.com/proompteng/lab/pull/12034) | `9f893bf90693c3569047a571664e2978bf49e8e1` | Promote Oirat to the Nix-built OCI digest.                                                     |
| [#12037](https://github.com/proompteng/lab/pull/12037) | `4b844e1b20b1b6b372487de2dddef00cbea8d663` | Refresh stale Bumba fixed-output Bun dependency hashes for both ARC platforms.                  |
| [#12040](https://github.com/proompteng/lab/pull/12040) | `50c26221def75ebe05c4788dc2b5e1601e15988e` | Move Bumba Temporal worker build id out of image content so GitOps-only commits do not change the image digest. |
| [#12042](https://github.com/proompteng/lab/pull/12042) | `a3218b4d8abd7e64223055e2aedaa2768944acd3` | Fix the Bumba release workflow so it writes the full `bumba@<source-sha>` build id.             |
| [#12045](https://github.com/proompteng/lab/pull/12045) | `728e5481a807cc799459d76938ea211db81eeefb` | Allow generated Bumba release PRs to update `deployment.yaml` as part of automerge.             |
| [#12044](https://github.com/proompteng/lab/pull/12044) | `d5b641d7f5513a59d49f5ede295bc89e0b831cda` | Promote Bumba to the corrected Nix-built OCI digest and matching Temporal worker build id.      |

## Failed Proof That Exposed The Gap

Run [28755585769](https://github.com/proompteng/lab/actions/runs/28755585769) failed on `main` before #12032.

- `linux/amd64` expected `sha256-b7gVdCguIM7nTpTtFVCB5XtQa8gTlpYCbBXZirSxzRM=`, got `sha256-bNAJstmwJ+1p2iZpop6zGONyOp8hEfgfrOML5kTASVo=`.
- `linux/arm64` expected `sha256-QQZr97O1Ux7zqCrk3UaeMRL43ALxn+1I6AzgrpkL7Tc=`, got `sha256-vkXEfzpeFgruwUyn5bzdvBG8TGfWaCVzZ/OsUjm3dCM=`.
- Both failures were fixed by #12032.

## Main Build Proof

Run [28755754903](https://github.com/proompteng/lab/actions/runs/28755754903) succeeded on `main`.

| Phase                        | Result                               |
| ---------------------------- | ------------------------------------ |
| `linux/amd64` build-platform | passed in `2m28s`                    |
| `linux/arm64` build-platform | passed in `2m54s`                    |
| publish-index                | passed in `32s`                      |
| release contract             | uploaded as `oirat-release-contract` |

Release contract fields:

- `service`: `oirat`
- `packageAttr`: `oirat-image`
- `builder`: `nix-dockerTools-skopeo`
- `invocation`: `github-actions`
- `sourceSha`: `4404a90ac83d6643b78a6f847e5a34b0416ae3bd`
- `image`: `registry.ide-newton.ts.net/lab/oirat`
- `digest`: `sha256:ea89bc7c66cb89373661d09162bd046e0f70c8ada356bfb1773833dfd20a7214`
- `platforms`: `linux/amd64`, `linux/arm64`
- cache provenance: `atticSubstitutions=0`, `cacheNixosSubstitutions=90`, `localBuilds=26`, `plannedLocalBuildBlocks=2`
- total timed seconds from contract: `320`

## Release Automation Proof

Run [28755847063](https://github.com/proompteng/lab/actions/runs/28755847063) consumed the release contract, verified the OCI index, and created release PR #12034.

The first automerge attempt on #12034 was green but did not merge because the generated PR author was `gregkonush`, while the workflow allowlist only accepted `app/github-actions` and `github-actions[bot]`.

Run [28756006919](https://github.com/proompteng/lab/actions/runs/28756006919), after #12035 merged, proved the repaired automation:

- eligibility output: `eligible=true`
- reason output: `eligible:nix-oci-release`
- merge command: `gh pr merge "$PR_NUMBER" -R "$GH_REPO" --auto --squash`
- resulting merged PR: #12034

## Live Rollout Smoke

After #12034 merged, Argo was synced for the `oirat` Application only.

Readback:

- Argo Application `oirat`: `Synced`, `Healthy`
- Argo revision: `9f893bf90693c3569047a571664e2978bf49e8e1`
- Deployment image: `registry.ide-newton.ts.net/lab/oirat@sha256:ea89bc7c66cb89373661d09162bd046e0f70c8ada356bfb1773833dfd20a7214`
- Deployment status: `ready=1`, `available=1`, `updated=1`, generation equals observed generation
- Pod: `1/1 Running`, `0` restarts
- Log smoke: `Discord mention bot ready as proompteng#6924`

## Warm Cache Proof

Run [28756095363](https://github.com/proompteng/lab/actions/runs/28756095363) was a second real Oirat run on current `main`; it was not a synthetic cache job.

| Phase                                  | Previous Run | Warm Run |
| -------------------------------------- | -----------: | -------: |
| `linux/amd64` build-platform wall time |      `2m28s` |  `1m24s` |
| `linux/arm64` build-platform wall time |      `2m54s` |  `1m47s` |
| publish-index wall time                |        `32s` |    `25s` |
| contract total timed seconds           |        `320` |    `191` |

Warm release contract fields:

- `sourceSha`: `9f893bf90693c3569047a571664e2978bf49e8e1`
- `digest`: `sha256:ea89bc7c66cb89373661d09162bd046e0f70c8ada356bfb1773833dfd20a7214`
- `platforms`: `linux/amd64`, `linux/arm64`
- cache provenance: `atticSubstitutions=2`, `cacheNixosSubstitutions=2`, `localBuilds=0`, `plannedLocalBuildBlocks=0`

The follow-on release workflow [28756154430](https://github.com/proompteng/lab/actions/runs/28756154430) verified the OCI index and did not create a release PR because the digest was already pinned on `main`.

## Bumba Rollout Proof

### Bumba Failure And Repair Trail

The first repaired Bumba build after the dependency-hash fix succeeded, but a follow-up run exposed a reproducibility bug:
`nix/images/bumba.nix` embedded `TEMPORAL_WORKER_BUILD_ID=bumba@${repoRevision}` into image content. A GitOps-only
release commit therefore changed the image digest even when Bumba source and lockfile inputs had not changed.

The corrective PR [#12040](https://github.com/proompteng/lab/pull/12040) removed `repoRevision` from the Bumba image
derivation and moved the Temporal worker build id to `argocd/applications/bumba/deployment.yaml`.

### Bumba Main Build Proof

Run [28757196192](https://github.com/proompteng/lab/actions/runs/28757196192) succeeded on `main`.

| Phase                        | Result            |
| ---------------------------- | ----------------- |
| `linux/amd64` build-platform | passed in `1m55s` |
| `linux/arm64` build-platform | passed in `3m50s` |
| publish-index                | passed in `38s`   |
| release contract             | uploaded as `bumba-release-contract` |

Release contract fields:

- `service`: `bumba`
- `packageAttr`: `bumba-image`
- `builder`: `nix-dockerTools-skopeo`
- `invocation`: `github-actions`
- `sourceSha`: `50c26221def75ebe05c4788dc2b5e1601e15988e`
- `image`: `registry.ide-newton.ts.net/lab/bumba`
- `digest`: `sha256:712854e03d2bff1251958bf159557337c3063042cf19d0701a4752ad1034395a`
- platform digests:
  - `linux/amd64`: `sha256:28130bff6aa6c950d1e5f8ffaa9979185ce454379ff9a3faad5bcf3c8ddf6cd6`
  - `linux/arm64`: `sha256:8cb2e0216b09a344ad81952b58240eeff2de17499ed1eaf9fee72fdd7ce88b3a`
- `platforms`: `linux/amd64`, `linux/arm64`
- cache provenance: `atticSubstitutions=0`, `cacheNixosSubstitutions=90`, `localBuilds=26`, `plannedLocalBuildBlocks=2`
- timed phases:
  - `build-image-amd64=38s`
  - `push-platform-image-amd64=25s`
  - `push-image-archive-output-amd64=29s`
  - `build-image-arm64=88s`
  - `push-platform-image-arm64=31s`
  - `push-image-archive-output-arm64=83s`
  - `create-oci-index=5s`
  - `assert-oci-platforms=5s`

### Bumba Release Automation Proof

Run [28757311373](https://github.com/proompteng/lab/actions/runs/28757311373) verified the promoted OCI index but failed
while updating `TEMPORAL_WORKER_BUILD_ID`: the Perl replacement interpreted `bumba@$ENV{SOURCE_SHA}` incorrectly and
wrote only `value: bumba`.

Run [28757457979](https://github.com/proompteng/lab/actions/runs/28757457979), after #12042 merged, proved the repaired
release workflow:

- OCI index verification passed for `registry.ide-newton.ts.net/lab/bumba@sha256:712854e03d2bff1251958bf159557337c3063042cf19d0701a4752ad1034395a`.
- GitOps digest update wrote `digest: sha256:712854e03d2bff1251958bf159557337c3063042cf19d0701a4752ad1034395a`.
- GitOps worker build id update wrote `value: bumba@50c26221def75ebe05c4788dc2b5e1601e15988e`.
- Release PR [#12044](https://github.com/proompteng/lab/pull/12044) was created with only
  `argocd/applications/bumba/kustomization.yaml` and `argocd/applications/bumba/deployment.yaml` changed.

The first automerge eligibility run for #12044 correctly refused to merge because `deployment.yaml` was not in the
release allowlist. PR [#12045](https://github.com/proompteng/lab/pull/12045) added that path to both the workflow trigger
and the Nix OCI release allowlist. Workflow run
[28757613295](https://github.com/proompteng/lab/actions/runs/28757613295) then proved the fixed automerge path:

- eligibility output: `eligible=true`
- reason output: `eligible:nix-oci-release`
- merge command: `gh pr merge "$PR_NUMBER" -R "$GH_REPO" --auto --squash`
- resulting merged PR: #12044

### Bumba Live Rollout Smoke

After #12044 merged and Argo refreshed the `bumba` Application only, current readback is:

- Argo Application `bumba`: `Synced`, `Healthy`
- Argo revision: `51afc32c04c41643c8c57452a18033d5ef4c25c0`
- Deployment image: `registry.ide-newton.ts.net/lab/bumba@sha256:712854e03d2bff1251958bf159557337c3063042cf19d0701a4752ad1034395a`
- Temporal worker build id: `bumba@50c26221def75ebe05c4788dc2b5e1601e15988e`
- Deployment status: `ready=1`, `available=1`, `updated=1`, generation equals observed generation
- Pod: `bumba-7d9b559d46-h7g82`, `1/1 Running`, `0` restarts
- Readiness smoke:

```json
{"status":"ok","uptimeMs":63625,"running":true,"shuttingDown":false,"temporal":{"ok":true,"lastSuccessAt":1783291954325,"lastFailureAt":null},"consumer":{"required":true,"running":true,"ok":true}}
```

Logs showed a transient Temporal `build ID ... not found` warning during startup, followed by successful routing alignment
to `bumba@50c26221def75ebe05c4788dc2b5e1601e15988e`.

### Bumba Cache Status

Bumba does not yet have a valid warm-cache win to claim after the reproducibility fix. The corrected build contract still
shows `atticSubstitutions=0`, `cacheNixosSubstitutions=90`, `localBuilds=26`, and `plannedLocalBuildBlocks=2`.

Do not count the earlier Bumba follow-up run as a reproducibility proof; it was the run that exposed GitOps-only digest
churn from the embedded worker build id. The next valid Bumba cache proof should be a real source-triggered run after the
corrected closure is already warm, or a substitute-only proof scoped to the same Nix output without creating a new release
churn PR.

## Inventory Audit

Command:

```bash
bun run packages/scripts/src/shared/nix-rollout-report.ts --json
```

Readback:

- enabled entries: `72`
- ApplicationSet entries: `71`
- direct Applications: `1`
- class counts: `nix-image=21`, `vendor-manifest=25`, `helm-chart=24`, `external-source=2`
- missing build contracts: none
- deferred apps: none
- manifest-only repo image apps: `3`

## Remaining Work

The rollout is not complete from this checkpoint alone. Remaining proof still needs to cover the other enabled repo-owned image apps with the same evidence shape:

- release contract for the app
- real amd64 and arm64 Nix OCI build proof
- cache provenance and timings
- digest-pinned GitOps release PR
- Argo `Synced` and `Healthy`
- live image digest matching the release contract
- service-specific smoke
- warm-cache/substitute-only proof where applicable
