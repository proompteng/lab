import { existsSync, readFileSync } from 'node:fs'

import { afterEach, describe, expect, it } from 'bun:test'

import { __private, assertOciPlatforms, createOciIndex, inspectOciPlatforms } from '../oci'

const originalWhich = Bun.which
const repoRoot = new URL('../../../../../', import.meta.url)
const readRepoFile = (path: string): string => readFileSync(new URL(path, repoRoot), 'utf8')
const repoFileExists = (path: string): boolean => existsSync(new URL(path, repoRoot))

const atticWorkflow = readRepoFile('.github/workflows/attic-build-push.yaml')
const atticReleaseWorkflow = readRepoFile('.github/workflows/attic-release.yml')
const atticReleaseMetadataScript = readRepoFile('nix/attic-release-metadata.sh')
const atticDeployment = readRepoFile('argocd/applications/attic/deployment.yaml')
const atticGcCronJob = readRepoFile('argocd/applications/attic/gc-cronjob.yaml')
const flake = readRepoFile('flake.nix')
const inspectOciArchiveScript = readRepoFile('nix/oci-inspect-archive.sh')
const ciRunTimedScript = readRepoFile('nix/ci-run-timed.sh')
const ciNixOciSummaryScript = readRepoFile('nix/ci-nix-oci-summary.sh')
const nixOciWorkflow = readRepoFile('.github/workflows/nix-oci-build-common.yml')
const enabledSimpleReleaseWorkflow = readRepoFile('.github/workflows/enabled-simple-nix-release.yml')
const oiratWorkflow = readRepoFile('.github/workflows/oirat-ci.yml')
const bumbaWorkflow = readRepoFile('.github/workflows/bumba-ci.yml')
const froussardWorkflow = readRepoFile('.github/workflows/froussard-ci.yml')
const oiratBuildScript = readRepoFile('packages/scripts/src/oirat/build-image.ts')
const bumbaBuildScript = readRepoFile('packages/scripts/src/bumba/build-image.ts')
const froussardDeployScript = readRepoFile('packages/scripts/src/froussard/deploy-service.ts')
const nixOciDeployScript = readRepoFile('packages/scripts/src/shared/nix-oci-deploy.ts')
const ociPushScript = readRepoFile('nix/oci-push.sh')

afterEach(() => {
  __private.setSpawnSync()
  Bun.which = originalWhich
})

const spawnResult = (exitCode: number, stdout = '', stderr = '') =>
  ({
    exitCode,
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(stderr),
  }) as ReturnType<typeof Bun.spawnSync>

const manifestList = JSON.stringify({
  schemaVersion: 2,
  manifests: [
    {
      digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      platform: { os: 'linux', architecture: 'amd64' },
    },
    {
      digest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      platform: { os: 'unknown', architecture: 'unknown' },
    },
    {
      digest: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      platform: { os: 'linux', architecture: 'arm64' },
    },
  ],
})

describe('inspectOciPlatforms', () => {
  it('reads schedulable platforms from crane manifest output', () => {
    Bun.which = ((binary: string) => (binary === 'crane' ? '/bin/crane' : null)) as typeof Bun.which
    __private.setSpawnSync(((command: Parameters<typeof Bun.spawnSync>[0]) => {
      const joined = typeof command === 'string' ? command : command.join(' ')
      if (joined === 'crane manifest registry.example/lab/example:sha') {
        return spawnResult(0, manifestList)
      }
      return spawnResult(1)
    }) as typeof Bun.spawnSync)

    expect(inspectOciPlatforms('registry.example/lab/example:sha')).toEqual([
      {
        platform: 'linux/amd64',
        digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
      {
        platform: 'linux/arm64',
        digest: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      },
    ])
  })

  it('falls back to regctl when crane cannot read the manifest', () => {
    Bun.which = ((binary: string) =>
      binary === 'crane' || binary === 'regctl' ? `/bin/${binary}` : null) as typeof Bun.which
    __private.setSpawnSync(((command: Parameters<typeof Bun.spawnSync>[0]) => {
      const joined = typeof command === 'string' ? command : command.join(' ')
      if (joined === 'crane manifest registry.example/lab/example:sha') {
        return spawnResult(1, '', 'not found')
      }
      if (joined === 'regctl manifest get registry.example/lab/example:sha --format raw-body') {
        return spawnResult(0, manifestList)
      }
      return spawnResult(1)
    }) as typeof Bun.spawnSync)

    expect(inspectOciPlatforms('registry.example/lab/example:sha').map((entry) => entry.platform)).toEqual([
      'linux/amd64',
      'linux/arm64',
    ])
  })
})

describe('assertOciPlatforms', () => {
  it('fails when a required platform is missing', () => {
    Bun.which = ((binary: string) => (binary === 'crane' ? '/bin/crane' : null)) as typeof Bun.which
    __private.setSpawnSync(((command: Parameters<typeof Bun.spawnSync>[0]) => {
      const joined = typeof command === 'string' ? command : command.join(' ')
      if (joined === 'crane manifest registry.example/lab/example:sha') {
        return spawnResult(
          0,
          JSON.stringify({
            manifests: [
              {
                digest: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
                platform: { os: 'linux', architecture: 'arm64' },
              },
            ],
          }),
        )
      }
      return spawnResult(1)
    }) as typeof Bun.spawnSync)

    expect(() => assertOciPlatforms('registry.example/lab/example:sha', ['linux/amd64', 'linux/arm64'])).toThrow(
      'missing required platform(s): linux/amd64',
    )
  })
})

describe('createOciIndex', () => {
  it('creates an index from arch tags, tags latest, and returns digest outputs', () => {
    const calls: string[] = []
    Bun.which = ((binary: string) => (binary === 'crane' ? '/bin/crane' : null)) as typeof Bun.which
    __private.setSpawnSync(((command: Parameters<typeof Bun.spawnSync>[0]) => {
      const joined = typeof command === 'string' ? command : command.join(' ')
      calls.push(joined)

      if (joined === 'crane digest registry.example/lab/example:sha-123-amd64') {
        return spawnResult(0, 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
      }
      if (joined === 'crane digest registry.example/lab/example:sha-123-arm64') {
        return spawnResult(0, 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc')
      }
      if (
        joined ===
        'crane index append -m registry.example/lab/example@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa -m registry.example/lab/example@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc -t registry.example/lab/example:sha-123'
      ) {
        return spawnResult(0)
      }
      if (joined === 'crane tag registry.example/lab/example:sha-123 latest') {
        return spawnResult(0)
      }
      if (joined === 'crane digest registry.example/lab/example:sha-123') {
        return spawnResult(0, 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd')
      }
      if (joined === 'crane manifest registry.example/lab/example:sha-123') {
        return spawnResult(0, manifestList)
      }
      return spawnResult(1, '', `unexpected call: ${joined}`)
    }) as typeof Bun.spawnSync)

    const result = createOciIndex({
      image: 'registry.example/lab/example',
      tag: 'sha-123',
      latest: true,
      archTags: [
        { platform: 'linux/amd64', tag: 'sha-123-amd64' },
        { platform: 'linux/arm64', tag: 'sha-123-arm64' },
      ],
    })

    expect(result).toMatchObject({
      image: 'registry.example/lab/example',
      tag: 'sha-123',
      reference: 'registry.example/lab/example@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
      digest: 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
    })
    expect(result.platformDigests).toHaveLength(2)
    expect(calls).toContain('crane tag registry.example/lab/example:sha-123 latest')
  })
})

describe('native OCI build workflows', () => {
  it('routes the live Attic image through real Nix OCI builds', () => {
    expect(atticWorkflow).toContain('uses: ./.github/workflows/nix-oci-build-common.yml')
    expect(atticWorkflow).toContain('package_attr: atticd-image')
    expect(atticWorkflow).not.toContain('needs: meta')
    expect(atticWorkflow).toContain('tag: sha-${{ github.sha }}')
    expect(atticWorkflow).not.toContain('argocd/applications/attic/**')
    expect(flake).not.toContain('facteur-image')
    expect(repoFileExists('.github/workflows/facteur-build-push.yaml')).toBe(false)
    expect(repoFileExists('nix/images/facteur.nix')).toBe(false)
  })

  it('defines ARC Nix image builds, Skopeo pushes, and OCI index publication', () => {
    expect(nixOciWorkflow).toContain('runner: arc-amd64')
    expect(nixOciWorkflow).toContain('runner: arc-arm64')
    expect(nixOciWorkflow).toContain('nix build ".#${PACKAGE_ATTR}"')
    expect(nixOciWorkflow).toContain('nix run .#inspect-oci-archive -- "${IMAGE_TAR}"')
    expect(nixOciWorkflow).toContain('nix run .#oci-push --')
    expect(nixOciWorkflow).toContain('nix run .#create-oci-index --')
    expect(nixOciWorkflow).toContain('nix run .#assert-oci-platforms --')
    expect(nixOciWorkflow).toContain('nix run .#cache-push -- "${IMAGE_TAR}"')
    expect(nixOciWorkflow).toContain('nix run .#write-oci-release-contract --')
    expect(nixOciWorkflow).toContain('substituters = http://attic.attic.svc.cluster.local/lab https://cache.nixos.org/')
    expect(nixOciWorkflow).not.toContain('extra-substituters = http://attic.attic.svc.cluster.local/lab')
    expect(nixOciWorkflow).toContain('nix build --print-build-logs --no-link --print-out-paths "$@"')
    expect(nixOciWorkflow).toContain('helper_attrs=(.#inspectOciArchive)')
    expect(nixOciWorkflow).toContain('helper_attrs+=(.#ociPush .#cachePush)')
    expect(nixOciWorkflow).toContain('test -s "${output_file}"')
    expect(nixOciWorkflow).toContain('No build-platform helper closure paths were captured.')
    expect(nixOciWorkflow).toContain('No index helper closure paths were captured.')
    expect(nixOciWorkflow).toContain('nix/ci-run-timed.sh')
    expect(nixOciWorkflow).toContain('nix/ci-nix-oci-summary.sh')
    expect(nixOciWorkflow).toContain(
      'helper_attrs=(.#createOciIndex .#assertOciPlatforms .#writeOciReleaseContract .#cachePush)',
    )
    expect(nixOciWorkflow).not.toContain('nix develop -c')
  })

  it('records real Nix OCI timing and cache-hit summaries', () => {
    expect(ciRunTimedScript).toContain('printf')
    expect(ciRunTimedScript).toContain('timings.tsv')
    expect(ciRunTimedScript).toContain('PIPESTATUS[0]')
    expect(ciNixOciSummaryScript).toContain('Attic substitutions')
    expect(ciNixOciSummaryScript).toContain('cache.nixos.org substitutions')
    expect(ciNixOciSummaryScript).toContain('Local derivation builds')
    expect(ciNixOciSummaryScript).toContain('GITHUB_STEP_SUMMARY')
  })

  it('allows Nix dockerTools archives without Docker repo tags', () => {
    expect(inspectOciArchiveScript).toContain('tags:(.RepoTags // [])')
    expect(inspectOciArchiveScript).toContain('(.Architecture | type == "string" and length > 0)')
    expect(inspectOciArchiveScript).toContain('(.Os | type == "string" and length > 0)')
    expect(inspectOciArchiveScript).not.toContain('(.RepoTags | length >= 1)')
  })

  it('gives Skopeo an explicit containers policy on ARC runners', () => {
    expect(ociPushScript).toContain('policy_json="$(mktemp)"')
    expect(ociPushScript).toContain('"type": "insecureAcceptAnything"')
    expect(ociPushScript).toContain('skopeo --policy "${policy_json}" copy --format oci')
  })

  it('tags platform latest refs without re-copying image layers', () => {
    expect(ociPushScript).toContain('crane tag "${reference}" "${latest_tag}"')
    expect(ociPushScript).not.toContain('skopeo --policy "${policy_json}" copy --format oci "docker://${reference}"')
  })

  it('does not use Docker Buildx or docker daemon commands in migrated workflows', () => {
    const migratedWorkflows = [atticWorkflow, nixOciWorkflow, oiratWorkflow, bumbaWorkflow, froussardWorkflow]
    for (const workflow of migratedWorkflows) {
      expect(workflow).not.toContain('docker/build-push-action')
      expect(workflow).not.toContain('docker load')
      expect(workflow).not.toContain('docker run')
      expect(workflow).not.toContain('docker tag')
      expect(workflow).not.toContain('docker push')
      expect(workflow).not.toContain('docker/setup-buildx-action')
    }
  })

  it('removes synthetic Nix cache and Docker-backed native workflow files', () => {
    expect(repoFileExists('.github/workflows/nix-cache-smoke.yml')).toBe(false)
    expect(repoFileExists('.github/workflows/nix-cache-warm.yml')).toBe(false)
    expect(repoFileExists('.github/workflows/nix-toolchain.yml')).toBe(false)
    expect(repoFileExists('.github/workflows/oci-native-build-common.yml')).toBe(false)
    expect(repoFileExists('.github/workflows/oci-builder-benchmark.yml')).toBe(false)
    expect(repoFileExists('nix/cache-smoke-input.txt')).toBe(false)
    expect(flake).not.toContain('cacheSmoke')
    expect(flake).not.toContain('cache-smoke')
  })

  it('routes enabled simple app image builds through real Nix OCI attrs', () => {
    expect(flake).toContain('"oirat-image"')
    expect(flake).toContain('"bumba-image"')
    expect(flake).toContain('"froussard-image"')
    expect(repoFileExists('nix/images/oirat.nix')).toBe(true)
    expect(repoFileExists('nix/images/bumba.nix')).toBe(true)
    expect(repoFileExists('nix/images/froussard.nix')).toBe(true)

    for (const [workflow, imageName, packageAttr, artifact] of [
      [oiratWorkflow, 'oirat', 'oirat-image', 'oirat-release-contract'],
      [bumbaWorkflow, 'bumba', 'bumba-image', 'bumba-release-contract'],
      [froussardWorkflow, 'froussard', 'froussard-image', 'froussard-release-contract'],
    ] as const) {
      expect(workflow).toContain('uses: ./.github/workflows/nix-oci-build-common.yml')
      expect(workflow).toContain(`image_name: ${imageName}`)
      expect(workflow).toContain(`package_attr: ${packageAttr}`)
      expect(workflow).toContain(`'${artifact}'`)
      expect(workflow).toContain('tag: sha-${{ github.sha }}')
      expect(workflow).not.toContain('uses: ./.github/workflows/docker-build-common.yaml')
    }
  })

  it('keeps manual migrated app deploy scripts on the shared Nix image helper', () => {
    for (const script of [oiratBuildScript, bumbaBuildScript, froussardDeployScript]) {
      expect(script).toContain("from '../shared/nix-oci-deploy'")
      expect(script).not.toContain("from '../shared/docker'")
      expect(script).not.toContain('buildAndPushDockerImage')
      expect(script).not.toContain('inspectImageDigest')
    }

    expect(nixOciDeployScript).toContain("await run('nix', ['build', `.#${packageAttr}`")
    expect(nixOciDeployScript).toContain("await run('nix', pushArgs")
    expect(nixOciDeployScript).toContain("runCapture('crane', ['digest'")
    expect(nixOciDeployScript).toContain('Nix OCI image pushes must stay in')
  })

  it('opens digest-pinning release PRs for enabled simple app Nix builds', () => {
    expect(enabledSimpleReleaseWorkflow).toContain('workflows:')
    expect(enabledSimpleReleaseWorkflow).toContain('- oirat')
    expect(enabledSimpleReleaseWorkflow).toContain('- bumba')
    expect(enabledSimpleReleaseWorkflow).toContain('- froussard')
    expect(enabledSimpleReleaseWorkflow).toContain('nix run .#assert-oci-platforms -- "${IMAGE}@${DIGEST}"')
    expect(enabledSimpleReleaseWorkflow).toContain('service build inputs changed after source commit')
    expect(enabledSimpleReleaseWorkflow).toContain('argocd/applications/oirat/kustomization.yaml')
    expect(enabledSimpleReleaseWorkflow).toContain('argocd/applications/bumba/kustomization.yaml')
    expect(enabledSimpleReleaseWorkflow).toContain('argocd/applications/froussard/knative-service.yaml')
    expect(enabledSimpleReleaseWorkflow).toContain('peter-evans/create-pull-request@v7')
    expect(enabledSimpleReleaseWorkflow).not.toContain('docker buildx')
  })

  it('promotes Attic by digest after a Nix OCI build contract', () => {
    expect(atticReleaseWorkflow).toContain('attic-release-contract')
    expect(atticReleaseWorkflow).toContain('argocd/applications/attic/deployment.yaml')
    expect(atticReleaseWorkflow).toContain('argocd/applications/attic/gc-cronjob.yaml')
    expect(atticReleaseWorkflow).toContain('nix run .#resolve-attic-release-metadata')
    expect(atticReleaseWorkflow).toContain('export IMAGE_REF="${IMAGE}@${DIGEST}"')
    expect(atticReleaseWorkflow).toContain('image: $ENV{IMAGE_REF}')
    expect(atticReleaseWorkflow).toContain(
      'substituters = http://attic.attic.svc.cluster.local/lab https://cache.nixos.org/',
    )
    expect(atticReleaseWorkflow).not.toContain('image: \'"${image_ref}"\'')
    expect(atticReleaseWorkflow).not.toContain('nix develop -c')
    expect(atticReleaseMetadataScript).toContain('"${builder}" != \'nix-dockerTools-skopeo\'')
    expect(atticReleaseMetadataScript).toContain('crane digest "${image}:${tag}"')
  })

  it('disables AWS metadata lookups for the Attic S3 client without changing storage resources', () => {
    for (const manifest of [atticDeployment, atticGcCronJob]) {
      expect(manifest).toContain('name: AWS_REGION')
      expect(manifest).toContain('value: us-east-1')
      expect(manifest).toContain('name: AWS_DEFAULT_REGION')
      expect(manifest).toContain('name: AWS_EC2_METADATA_DISABLED')
      expect(manifest).toContain('value: "true"')
    }
    expect(atticDeployment).not.toContain('ObjectBucketClaim')
    expect(atticGcCronJob).not.toContain('ObjectBucketClaim')
  })
})
