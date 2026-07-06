# Nix Enabled-App Rollout Evidence - 2026-07-05

This is an evidence checkpoint for the enabled-app Nix build performance rollout. It is not the final rollout report.

## Scope

- Enabled apps proved: `oirat`, `bumba`, `froussard`, `arc`, `attic`, `headlamp`, `app`, `docs`,
  `proompteng`, `olden`, `synthesis`, `symphony`, `symphony-jangar`, `symphony-torghut`.
- Build paths: `.github/workflows/oirat-ci.yml`, `.github/workflows/bumba-ci.yml`,
  `.github/workflows/froussard-ci.yml`, `.github/workflows/arc-runner-build-push.yml`, and
  `.github/workflows/attic-build-push.yaml`, and `.github/workflows/headlamp-ci.yml` using
  `.github/workflows/nix-oci-build-common.yml`; product apps use `.github/workflows/product-nix-images.yml`.
- Nix attrs: `oirat-image`, `bumba-image`, `froussard-image`, `arc-runner-image`, `atticd-image`,
  `headlamp-image`, `app-image`, `docs-image`, `proompteng-image`, `olden-image`, `synthesis-image`,
  `symphony-image`.
- Manual paths present:
  - `packages/scripts/src/oirat/build-image.ts` and `packages/scripts/src/oirat/deploy-service.ts`
  - `packages/scripts/src/bumba/build-image.ts` and `packages/scripts/src/bumba/deploy-service.ts`
  - `packages/scripts/src/froussard/build-image.ts` and `packages/scripts/src/froussard/deploy-service.ts`
  - `packages/scripts/src/arc-runner/build-image.ts` and `packages/scripts/src/arc-runner/deploy-service.ts`
  - `packages/scripts/src/attic/build-image.ts` and `packages/scripts/src/attic/deploy-service.ts`
  - `packages/scripts/src/headlamp/build-image.ts` and `packages/scripts/src/headlamp/deploy-service.ts`
  - product app build/deploy scripts under `packages/scripts/src/{app,docs,proompteng,olden,synthesis}/`
  - `packages/scripts/src/symphony/build-image.ts` and `packages/scripts/src/symphony/deploy-service.ts`
- Release path: `.github/workflows/enabled-simple-nix-release.yml`,
  `.github/workflows/arc-runner-release.yml`, `.github/workflows/attic-release.yml`, plus
  `.github/workflows/headlamp-release.yml`, `.github/workflows/enabled-product-nix-release.yml`, and
  `.github/workflows/release-pr-automerge.yml`.
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
| [#11923](https://github.com/proompteng/lab/pull/11923) | `404c77437b0565f28e250b62e4335f62d5767ad3` | Add the Froussard manual Nix image build path.                                                  |
| [#12010](https://github.com/proompteng/lab/pull/12010) | `0aa4503b9a1c2edf189775c9efa527fca2fc10ff` | Promote Froussard to the latest Nix-built OCI digest.                                           |
| [#12015](https://github.com/proompteng/lab/pull/12015) | `6145a5fd5198b313fa93d7f5d323bc70646a6a27` | Harden the ARC runner Nix image and manual build/deploy path before promotion.                   |
| [#12020](https://github.com/proompteng/lab/pull/12020) | `e31f832a82ba1c5458c1cd5c7db5ee67fa22a338` | Promote ARC runner sets to the Nix-built multi-platform digest.                                  |
| [#12022](https://github.com/proompteng/lab/pull/12022) | `51afc32c04c41643c8c57452a18033d5ef4c25c0` | Further harden the ARC runner script contract and manual deployment path.                        |
| [#11576](https://github.com/proompteng/lab/pull/11576) | `b6083af08a7063a28742339c2a341331f11b21ad` | Preserve the Attic image digest through the release workflow.                                    |
| [#11580](https://github.com/proompteng/lab/pull/11580) | `0b6ef5c947dba634f08718b3d9a3052767a7d833` | Promote Attic deployment and GC CronJob to the Nix-built digest.                                 |
| [#11988](https://github.com/proompteng/lab/pull/11988) | `b149b5722d85353afe59690b29894b22a6937e0e` | Add the Headlamp Nix image build and release path.                                               |
| [#11999](https://github.com/proompteng/lab/pull/11999) | `2cefa5e2ed774cc46706d49def73e3ed90b0268e` | Fix Headlamp runtime static index copy in the Nix image.                                         |
| [#12001](https://github.com/proompteng/lab/pull/12001) | `aa4fdb5cffc9f2e9f97f011278222878170e483e` | Promote Headlamp to the final repaired Nix-built digest.                                         |
| [#11851](https://github.com/proompteng/lab/pull/11851) | `5e046147da58bd014bca17565cbd731626ec875b` | Include platform digests in OCI release contracts used by product apps.                          |
| [#11866](https://github.com/proompteng/lab/pull/11866) | `7529c68ea151aa2106a821565c514f41719a8e5c` | Promote `app`, `docs`, `proompteng`, `olden`, and `synthesis` to Nix-built digests.              |
| [#11676](https://github.com/proompteng/lab/pull/11676) | `c035fd755d223c31a267bbffe8e0c8c2cd2f3fb5` | Add the shared Symphony Nix image build path.                                                    |
| [#11857](https://github.com/proompteng/lab/pull/11857) | `d8c2aea2d995d14dbf7b6acd68395529a03e37cc` | Promote `symphony`, `symphony-jangar`, and `symphony-torghut` to the Nix-built digest.           |

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

## Froussard Rollout Proof

Froussard is the third simple enabled app with current live Nix OCI rollout proof. This section records current evidence
only; it does not claim a new build was dispatched for this checkpoint.

### Froussard Main Build Proof

Run [28752511208](https://github.com/proompteng/lab/actions/runs/28752511208) succeeded on `main`.

| Phase                        | Result            |
| ---------------------------- | ----------------- |
| monorepo test job            | passed in `32s`   |
| `linux/amd64` build-platform | passed in `2m15s` |
| `linux/arm64` build-platform | passed in `3m08s` |
| publish-index                | passed in `38s`   |
| release contract             | uploaded as `froussard-release-contract` |

Release contract fields:

- `service`: `froussard`
- `packageAttr`: `froussard-image`
- `builder`: `nix-dockerTools-skopeo`
- `invocation`: `github-actions`
- `sourceSha`: `eef803e3aebef1a473d2b691a7f3e3963ce72d6a`
- `image`: `registry.ide-newton.ts.net/lab/froussard`
- `digest`: `sha256:f20f361eb6542712ea4dbd966d02bfae65ad0628af01a769d12a9543579ae1f0`
- platform digests:
  - `linux/amd64`: `sha256:c356587a2928bcb80c62a575c452b1492da9b5ab74530ccea0a1300a39cc197b`
  - `linux/arm64`: `sha256:9c0a509aad36c4967536c1b2d178c1307385e5434bd446cd0e88084fa1231a79`
- `platforms`: `linux/amd64`, `linux/arm64`

The Froussard release contract available from this run did not include the newer `cacheProvenance` or per-phase
`timings` fields, so this checkpoint uses the GitHub job wall times above and does not claim Froussard cache-hit counts.

### Froussard Release Automation Proof

Release PR [#12010](https://github.com/proompteng/lab/pull/12010) promoted
`registry.ide-newton.ts.net/lab/froussard@sha256:f20f361eb6542712ea4dbd966d02bfae65ad0628af01a769d12a9543579ae1f0`.

The PR changed only `argocd/applications/froussard/knative-service.yaml`:

- image changed from `sha256:70568478495af17ebb088359e6a7776cb06e233e9f66d9e3df0f8ba1e854006d` to
  `sha256:f20f361eb6542712ea4dbd966d02bfae65ad0628af01a769d12a9543579ae1f0`
- `FROUSSARD_COMMIT` changed from `694f2886e8b58d499ae57064f99bddaeb48a23f1` to
  `eef803e3aebef1a473d2b691a7f3e3963ce72d6a`
- testing recorded by the generated PR:
  `nix run .#assert-oci-platforms -- "registry.ide-newton.ts.net/lab/froussard@sha256:f20f361eb6542712ea4dbd966d02bfae65ad0628af01a769d12a9543579ae1f0" linux/amd64 linux/arm64`

### Froussard Live Rollout Smoke

Current readback:

- Argo Application `froussard`: `Synced`, `Healthy`
- Argo revision: `51afc32c04c41643c8c57452a18033d5ef4c25c0`
- Knative Service `froussard`: `Ready=True`
- latest ready revision: `froussard-00021`
- public URL: `https://froussard.proompteng.ai`
- live image: `registry.ide-newton.ts.net/lab/froussard@sha256:f20f361eb6542712ea4dbd966d02bfae65ad0628af01a769d12a9543579ae1f0`
- `FROUSSARD_COMMIT`: `eef803e3aebef1a473d2b691a7f3e3963ce72d6a`
- Deployment status: `1/1` ready and available
- Pod: `froussard-00021-deployment-59c4866db4-bt9lz`, `2/2 Running`, `0` restarts
- in-cluster readiness smoke against `/health/readiness`: `OK`
- log smoke: recent `/health/readiness` and `/health/liveness` requests returned through the running app container, and
  GitHub webhook events were published to `github.webhook.events`

### Froussard Cache Status

Froussard has current live digest proof but does not yet have a complete cache-provenance checkpoint in this document
because the downloaded release contract exposed `cacheProvenance=null` and `timings=null`. A future real Froussard source
change should produce the newer release-contract shape and can be used for warm-cache or substitute-only proof without
creating a synthetic job.

## ARC Runner Rollout Proof

ARC is the first enabled platform app counted in this checkpoint. It is a build-performance dependency for the rest of
the rollout because the `arc-amd64` and `arc-arm64` runner sets execute the real Nix OCI jobs.

### ARC Main Build Proof

Run [28753997784](https://github.com/proompteng/lab/actions/runs/28753997784) succeeded on `main`.

| Phase                        | Result            |
| ---------------------------- | ----------------- |
| `linux/amd64` build-platform | passed in `4m24s` |
| `linux/arm64` build-platform | passed in `5m48s` |
| publish-index                | passed in `26s`   |
| release contract             | uploaded as `arc-runner-release-contract` |

Release contract fields:

- `service`: `arc-runner`
- `packageAttr`: `arc-runner-image`
- `builder`: `nix-dockerTools-skopeo`
- `invocation`: `github-actions`
- `sourceSha`: `6145a5fd5198b313fa93d7f5d323bc70646a6a27`
- `image`: `registry.ide-newton.ts.net/lab/arc-runner`
- `digest`: `sha256:578cfa96457948232aa056412e9f1dbdaeccb976418c7030ff8ba3fb8382eb60`
- platform digests:
  - `linux/amd64`: `sha256:3aa57aef2ea2d6b675b0a421e118a6bee32b6556066e1c95917a9608724b99df`
  - `linux/arm64`: `sha256:6248c0416c3af94b91e5e7c67573f8d32ec8821a6e97a16b5ae947be991de1d8`
- `platforms`: `linux/amd64`, `linux/arm64`
- lockfile hashes:
  - `flake.lock`: `ecff06cebb0e40ac241f0a6eb93b08d00b9c5dc28f5619f5247840f7d0b16857`
  - `bun.lock`: `d097c7625564044607451e8382833faba62a4a14af630bb9fe1ab4b41236da23`
- tool versions:
  - `nix`: `nix (Nix) 2.28.5`
  - `skopeo`: `skopeo version 1.20.0`
  - `crane`: `v0.20.6`

### ARC Release Automation Proof

Run [28754170561](https://github.com/proompteng/lab/actions/runs/28754170561) consumed the release contract, verified the
OCI index, and created release PR [#12020](https://github.com/proompteng/lab/pull/12020).

The release PR changed only `argocd/applications/arc/application.yaml`:

- all six ARC runner image references changed to
  `registry.ide-newton.ts.net/lab/arc-runner@sha256:578cfa96457948232aa056412e9f1dbdaeccb976418c7030ff8ba3fb8382eb60`
- `docker:dind` sidecars were left unchanged
- node-local runner work directory sizing was preserved
- generated testing recorded:
  `nix run .#assert-oci-platforms -- "registry.ide-newton.ts.net/lab/arc-runner@sha256:578cfa96457948232aa056412e9f1dbdaeccb976418c7030ff8ba3fb8382eb60" linux/amd64 linux/arm64`

### ARC Live Rollout Smoke

Current readback:

- Argo Application `arc`: `Synced`, `Healthy`
- Argo revision: `3e223397cc180f31e70e228cbcc54c339a5e84c3`
- live ARC runner image:
  `registry.ide-newton.ts.net/lab/arc-runner@sha256:578cfa96457948232aa056412e9f1dbdaeccb976418c7030ff8ba3fb8382eb60`
- `AutoscalingRunnerSet` capacity:
  - `arc-amd64`: `minRunners=1`, `maxRunners=10`
  - `arc-arm64`: `minRunners=1`, `maxRunners=10`
  - `analysis-arm64`: `minRunners=1`, `maxRunners=5`
- live pods:
  - `arc-controller-gha-rs-controller-*`: `1/1 Running`, `0` restarts
  - `arc-amd64-*listener`: `1/1 Running`, `0` restarts
  - `arc-amd64-*runner-*`: `2/2 Running`, `0` restarts, runner image digest matches the release contract
  - `arc-arm64-*listener`: `1/1 Running`, `0` restarts
  - `arc-arm64-*runner-*`: `2/2 Running`, `0` restarts, runner image digest matches the release contract
  - `analysis-arm64-*runner-*`: `2/2 Running`, `0` restarts, runner image digest matches the release contract

### ARC Cache Status

The ARC release contract proves the digest, platforms, lockfile hashes, and tool versions, but it does not include the
newer `cacheProvenance` or per-phase `timings` objects. This checkpoint therefore uses GitHub job wall times above and
does not claim ARC cache-hit counts. A future ARC image input change should produce a newer release contract and can be
used for warm-cache or substitute-only proof without adding synthetic jobs.

## Attic Rollout Proof

Attic is the enabled platform cache service used by the Nix OCI rollout. This checkpoint counts the live Attic image
rollout and endpoint smoke, not the later build-only dispatches that did not publish a release contract.

### Attic Main Build Proof

Run [28341358905](https://github.com/proompteng/lab/actions/runs/28341358905) succeeded on `main`.

| Phase                        | Result            |
| ---------------------------- | ----------------- |
| `linux/amd64` build-platform | passed in `7m43s` |
| `linux/arm64` build-platform | passed in `6m28s` |
| publish-index                | passed in `5m30s` |
| release contract             | uploaded as `attic-release-contract` |

Release contract fields:

- `packageAttr`: `atticd-image`
- `builder`: `nix-dockerTools-skopeo`
- `sourceSha`: `b6083af08a7063a28742339c2a341331f11b21ad`
- `image`: `registry.ide-newton.ts.net/lab/attic`
- `tag`: `sha-b6083af08a7063a28742339c2a341331f11b21ad`
- `digest`: `sha256:061938ea73b005333d3138d3940347a80ddde7d82e456d5914c001233a0f6747`
- `reference`:
  `registry.ide-newton.ts.net/lab/attic@sha256:061938ea73b005333d3138d3940347a80ddde7d82e456d5914c001233a0f6747`

The older Attic release contract did not include platform digest, lockfile hash, tool version, timing, or cache
provenance fields. The workflow still created and verified the OCI index in the `publish-index` job before writing the
release contract.

### Attic Release Automation Proof

Release PR [#11580](https://github.com/proompteng/lab/pull/11580) promoted
`registry.ide-newton.ts.net/lab/attic@sha256:061938ea73b005333d3138d3940347a80ddde7d82e456d5914c001233a0f6747`.

The PR changed only `argocd/applications/attic/deployment.yaml` and `argocd/applications/attic/gc-cronjob.yaml`:

- deployment init container and app container image references were pinned to the Nix-built digest
- GC CronJob image reference was pinned to the same Nix-built digest
- generated testing recorded:
  `nix run .#assert-oci-platforms -- "registry.ide-newton.ts.net/lab/attic@sha256:061938ea73b005333d3138d3940347a80ddde7d82e456d5914c001233a0f6747" linux/amd64 linux/arm64`

### Attic Live Rollout Smoke

Current readback:

- Argo Application `attic`: `Synced`, `Healthy`
- Argo revision: `44e3b7729c6e5b35c1a819aee9f3d2fd9271c415`
- Deployment `attic`: `1/1` ready and available
- pod `attic-5dcd5c985f-74h5x`: `1/1 Running`, `0` restarts
- init container `db-migrations`: ready, `0` restarts
- live deployment image:
  `registry.ide-newton.ts.net/lab/attic@sha256:061938ea73b005333d3138d3940347a80ddde7d82e456d5914c001233a0f6747`
- live GC CronJob image:
  `registry.ide-newton.ts.net/lab/attic@sha256:061938ea73b005333d3138d3940347a80ddde7d82e456d5914c001233a0f6747`
- in-cluster cache endpoint smoke against `http://attic.attic.svc.cluster.local/lab/nix-cache-info` returned:

```text
WantMassQuery: 1
StoreDir: /nix/store
Priority: 41
```

- host cache endpoint smoke against `https://attic.ide-newton.ts.net/lab/nix-cache-info` returned the same cache info.

### Attic Cache Status

The live Attic service is reachable from both the in-cluster service URL and the Tailscale host URL, so it is available
as a substituter for the rollout. The Attic image release itself still uses an older release contract, so this checkpoint
does not claim per-run Attic substitution counts for the Attic image build.

The later workflow-dispatch run [28722715748](https://github.com/proompteng/lab/actions/runs/28722715748) is explicitly
not counted as release proof: it built and inspected amd64/arm64 archives, but skipped platform push, skipped Attic
warming, skipped publish-index, and did not upload `attic-release-contract`.

## Headlamp Rollout Proof

Headlamp is an enabled platform app that deploys a chart but overrides the chart image with a repo-built Headlamp image,
so it counts as a Nix image rollout target.

### Headlamp Repair Trail

The initial migration PR [#11988](https://github.com/proompteng/lab/pull/11988) added the Headlamp Nix image path. The
final repaired source for the current live image is [#11999](https://github.com/proompteng/lab/pull/11999), which fixed
the static index copy inside the runtime image after earlier writable-static-mode fixes.

### Headlamp Main Build Proof

Run [28752171560](https://github.com/proompteng/lab/actions/runs/28752171560) succeeded on `main`.

| Phase                        | Result            |
| ---------------------------- | ----------------- |
| `linux/amd64` build-platform | passed in `2m53s` |
| `linux/arm64` build-platform | passed in `5m09s` |
| publish-index                | passed in `29s`   |
| release contract             | uploaded as `headlamp-release-contract` |

Release contract fields:

- `service`: `headlamp`
- `packageAttr`: `headlamp-image`
- `builder`: `nix-dockerTools-skopeo`
- `invocation`: `github-actions`
- `sourceSha`: `2cefa5e2ed774cc46706d49def73e3ed90b0268e`
- `image`: `registry.ide-newton.ts.net/lab/headlamp`
- `digest`: `sha256:6d61f6563c3df42d176b1d445a757df48f0c6f84c02baa4f4f76dbd258ee2ddd`
- platform digests:
  - `linux/amd64`: `sha256:001ed86f05c11456b57028b1c1a73dfb6935d1fbd4e2b66d9df811b3adab4c88`
  - `linux/arm64`: `sha256:903369555829d19233e4d3653e2add3f3fdb0be81eff666a7018225c08b08577`
- `platforms`: `linux/amd64`, `linux/arm64`

### Headlamp Release Automation Proof

Release PR [#12001](https://github.com/proompteng/lab/pull/12001) promoted
`registry.ide-newton.ts.net/lab/headlamp@sha256:6d61f6563c3df42d176b1d445a757df48f0c6f84c02baa4f4f76dbd258ee2ddd`.

The PR changed only `argocd/applications/headlamp/values.yaml`:

- chart image override changed to the Nix-built digest
- generated testing recorded:
  `nix run .#assert-oci-platforms -- "registry.ide-newton.ts.net/lab/headlamp@sha256:6d61f6563c3df42d176b1d445a757df48f0c6f84c02baa4f4f76dbd258ee2ddd" linux/amd64 linux/arm64`

### Headlamp Live Rollout Smoke

Current readback:

- Argo Application `headlamp`: `Synced`, `Healthy`
- Argo revision: `d111652cc57e6242f628422057d3cbbaac2b53fd`
- Deployment `headlamp`: `1/1` ready and available
- pod `headlamp-5b6f9d49d8-7cjh2`: `1/1 Running`, `0` restarts
- live image:
  `registry.ide-newton.ts.net/lab/headlamp@sha256:6d61f6563c3df42d176b1d445a757df48f0c6f84c02baa4f4f76dbd258ee2ddd`
- in-cluster service smoke against `http://headlamp.headlamp.svc.cluster.local/` returned `HTTP/1.1 200 OK`

### Headlamp Cache Status

The Headlamp release contract proves digest, platforms, platform digests, and source SHA, but it does not include the
newer `cacheProvenance`, lockfile hash, tool version, or per-phase timing objects. This checkpoint therefore uses GitHub
job wall times above and does not claim Headlamp cache-hit counts.

## Product Apps Rollout Proof

This section covers the enabled product apps built by `.github/workflows/product-nix-images.yml`: `app`, `docs`,
`proompteng`, `olden`, and `synthesis`.

### Product Main Build Proof

Run [28701445310](https://github.com/proompteng/lab/actions/runs/28701445310) succeeded on `main`.

| Service     | Nix attr           | amd64 build | arm64 build | publish-index |
| ----------- | ------------------ | ----------: | ----------: | ------------: |
| `app`       | `app-image`        |      `7m24s` |     `41m31s` |        `1m13s` |
| `docs`      | `docs-image`       |     `13m01s` |      `3m03s` |        `1m07s` |
| `olden`     | `olden-image`      |      `2m42s` |      `3m31s` |        `1m18s` |
| `proompteng` | `proompteng-image` |      `4m37s` |     `12m51s` |        `1m11s` |
| `synthesis` | `synthesis-image`  |      `3m43s` |     `29m31s` |        `1m16s` |

Release contract fields:

| Service     | Digest                                                              | amd64 platform digest                                                  | arm64 platform digest                                                  |
| ----------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `app`       | `sha256:c410d4f09aa4290dfb12da53982dd950a7c8d5a2630a06912d166fad2abbb9c3` | `sha256:299b53c8dcb45f7e39a7e2514906224c6ce3b07f0e4d5f35ee9a982402e151fe` | `sha256:63e6df8380680f6cd8d79a600f5ca1eb9d6cbd199902359df3a2ef93953ee54a` |
| `docs`      | `sha256:e9d7ebbff45c66bbf77c8b73a05ed8ec6801297a737ae2e7cdbda410ae1fe58d` | `sha256:790323474421235381f8f3fb4a9c81b90636f760b43cc3feb2242bc3e862f6a1` | `sha256:9f929166566804759675c2200bf9fe9ebb7d8783ff97b7d42f50458cdc940232` |
| `olden`     | `sha256:84b359d4418e036be781cc56ce2c910fbcc9c2a3c7c52732098d89c9bb22d3b5` | `sha256:872fae03ede1e2e349cab6bd10a3548ea550bcc0d0dc3d4e34620bbabd56a51e` | `sha256:0f19783f5624e3576d562ab7802270780ec3b5c44e91c61f32d5ebbc536f0eb0` |
| `proompteng` | `sha256:aeb92626912fb5c5f48a37b1ec67531fae4d5e1e4cb57c541bdacc9996074ee2` | `sha256:50f681c72d939834e00ad9422c2c88d1bafb1bef85f40006f57c1cc5063de347` | `sha256:d655ce6d9c74f4bba631e559b7ed894000c8658758a7e7806d5c82d3d16f2836` |
| `synthesis` | `sha256:62486474c8875e2ed3341abeb5d06a45d385a25e8f53a8a8f7efb3dd6b3cee32` | `sha256:562099c5a4e77ec279dbfde1b2fdc2ca25e6d04c82b376b0d1557d7b8d182f29` | `sha256:c0eff204ca36ca7c256986ba8b120faf18f9bfe3113e2910d177334ab4251b6b` |

Shared contract fields for all five product apps:

- `builder`: `nix-dockerTools-skopeo`
- `invocation`: `github-actions`
- `sourceSha`: `5e046147da58bd014bca17565cbd731626ec875b`
- `platforms`: `linux/amd64`, `linux/arm64`

### Product Release Automation Proof

Release PR [#11866](https://github.com/proompteng/lab/pull/11866) promoted all five product app digests from source
commit `5e046147da58bd014bca17565cbd731626ec875b`.

The PR changed only these GitOps image pins:

- `argocd/applications/app/kustomization.yaml`
- `argocd/applications/docs/kustomization.yaml`
- `argocd/applications/olden/kustomization.yaml`
- `argocd/applications/proompteng/kustomization.yaml`
- `argocd/applications/synthesis/kustomization.yaml`

The generated PR testing recorded `nix run .#assert-oci-platforms -- <image>@<digest> linux/amd64 linux/arm64` for each
promoted image.

### Product Live Rollout Smoke

Current readback:

| Service     | Argo state       | Live image digest                                                      | Pod state             | Smoke |
| ----------- | ---------------- | ---------------------------------------------------------------------- | --------------------- | ----- |
| `app`       | `Synced/Healthy` | `sha256:c410d4f09aa4290dfb12da53982dd950a7c8d5a2630a06912d166fad2abbb9c3` | `1/1 Running`, `0` restarts | `/` returned `307`; following redirect returned `200` |
| `docs`      | `Synced/Healthy` | `sha256:e9d7ebbff45c66bbf77c8b73a05ed8ec6801297a737ae2e7cdbda410ae1fe58d` | `1/1 Running`, `0` restarts | `/` returned `200` |
| `olden`     | `Synced/Healthy` | `sha256:84b359d4418e036be781cc56ce2c910fbcc9c2a3c7c52732098d89c9bb22d3b5` | `1/1 Running`, `0` restarts | `/` returned `200` |
| `proompteng` | `Synced/Healthy` | `sha256:aeb92626912fb5c5f48a37b1ec67531fae4d5e1e4cb57c541bdacc9996074ee2` | `1/1 Running`, `0` restarts | `/` returned `200` |
| `synthesis` | `Synced/Healthy` | `sha256:62486474c8875e2ed3341abeb5d06a45d385a25e8f53a8a8f7efb3dd6b3cee32` | `1/1 Running`, `0` restarts | `/` returned `200` |

### Product Cache Status

The product build jobs used Attic setup and pushed build-platform helper closures plus image archive closures to Attic.
The release contracts prove digest and platform identity, but they do not include normalized `cacheProvenance` objects.
This checkpoint therefore records job wall times and does not claim cache-hit counts.

The July 4 product run is not yet a clean performance win across the board: `app` arm64 took `41m31s` and `synthesis`
arm64 took `29m31s`, largely in image archive warming. The next product optimization should reduce or bound closure
warming costs while preserving the digest-pinned Nix OCI release path.

## Symphony Family Rollout Proof

The Symphony family has three enabled Argo Applications that share the same `symphony-image` output:
`symphony`, `symphony-jangar`, and `symphony-torghut`.

### Symphony Main Build Proof

Run [28701445299](https://github.com/proompteng/lab/actions/runs/28701445299) succeeded on `main`.

| Phase                        | Result           |
| ---------------------------- | ---------------- |
| `linux/amd64` build-platform | passed in `3m10s` |
| `linux/arm64` build-platform | passed in `4m36s` |
| publish-index                | passed in `1m14s` |
| release contract             | uploaded as `symphony-release-contract` |

Release contract fields:

- `service`: `symphony`
- `packageAttr`: `symphony-image`
- `builder`: `nix-dockerTools-skopeo`
- `invocation`: `github-actions`
- `sourceSha`: `5e046147da58bd014bca17565cbd731626ec875b`
- `image`: `registry.ide-newton.ts.net/lab/symphony`
- `digest`: `sha256:8602e26cc30db8af3e1af8eabe3051c8661f36263086ae2db3b18a384e7fc391`
- platform digests:
  - `linux/amd64`: `sha256:1257ee187d795a1231d7f90c77893a27822ae9f39aea3c9d3e3cb9220b54e358`
  - `linux/arm64`: `sha256:0728e2d7958ee4250608e4978ba073e6f97bfc09bce849a73ce77b69a2f1bfdb`
- `platforms`: `linux/amd64`, `linux/arm64`

### Symphony Release Automation Proof

Release PR [#11857](https://github.com/proompteng/lab/pull/11857) promoted the shared Symphony image digest to all
three enabled Symphony-family apps.

The PR changed only:

- `argocd/applications/symphony/deployment.patch.yaml`
- `argocd/applications/symphony/kustomization.yaml`
- `argocd/applications/symphony-jangar/deployment.patch.yaml`
- `argocd/applications/symphony-jangar/kustomization.yaml`
- `argocd/applications/symphony-torghut/deployment.patch.yaml`
- `argocd/applications/symphony-torghut/kustomization.yaml`

### Symphony Live Rollout Smoke

Current readback:

| App                 | Runtime namespace | Deployment state        | Live image digest                                                      | Smoke |
| ------------------- | ----------------- | ----------------------- | ---------------------------------------------------------------------- | ----- |
| `symphony`          | `jangar`          | `1/1` ready and updated | `sha256:8602e26cc30db8af3e1af8eabe3051c8661f36263086ae2db3b18a384e7fc391` | `/readyz` returned `200` |
| `symphony-jangar`   | `jangar`          | `1/1` ready and updated | `sha256:8602e26cc30db8af3e1af8eabe3051c8661f36263086ae2db3b18a384e7fc391` | `/readyz` returned `200` |
| `symphony-torghut`  | `torghut`         | `1/1` ready and updated | `sha256:8602e26cc30db8af3e1af8eabe3051c8661f36263086ae2db3b18a384e7fc391` | `/readyz` returned `200` |

All three Argo Applications are `Synced` and `Healthy` at revision
`88b0e10f5520b9d5b3485c42398220dda7986aa8`.

### Symphony Cache Status

The Symphony build used Attic setup and pushed build-platform helper closures plus the image archive closure to Attic.
The release contract proves digest and platform identity, but it does not include normalized `cacheProvenance`, lockfile,
or tool-version fields. This checkpoint therefore records job wall times and does not claim cache-hit counts.

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
