# Nix Enabled-App Rollout Evidence - 2026-07-05

This is an evidence checkpoint for the enabled-app Nix build performance rollout. It is not the final rollout report.

## Scope

- Enabled app proved: `oirat`.
- Build path: `.github/workflows/oirat-ci.yml` using `.github/workflows/nix-oci-build-common.yml`.
- Nix attr: `oirat-image`.
- Manual path present: `packages/scripts/src/oirat/build-image.ts` and `packages/scripts/src/oirat/deploy-service.ts`.
- Release path: `.github/workflows/enabled-simple-nix-release.yml` plus `.github/workflows/release-pr-automerge.yml`.
- Hard exclusions respected: no Ceph, Rook, ObjectBucketClaim, PVC, Talos, node, power, or storage changes.

## Fixes Landed

| PR                                                     | Commit                                     | Purpose                                                                                        |
| ------------------------------------------------------ | ------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| [#12032](https://github.com/proompteng/lab/pull/12032) | `4404a90ac83d6643b78a6f847e5a34b0416ae3bd` | Refresh stale Oirat fixed-output Bun dependency hashes for `x86_64-linux` and `aarch64-linux`. |
| [#12035](https://github.com/proompteng/lab/pull/12035) | `30405fc1be26d5d52eb8e8c4afbd034bf86bd583` | Fix generated release PR automerge when the automation token authors PRs as `gregkonush`.      |
| [#12034](https://github.com/proompteng/lab/pull/12034) | `9f893bf90693c3569047a571664e2978bf49e8e1` | Promote Oirat to the Nix-built OCI digest.                                                     |

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
