import { existsSync, readdirSync, readFileSync } from 'node:fs'

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
const productApplicationSet = readRepoFile('argocd/applicationsets/product.yaml')
const flake = readRepoFile('flake.nix')
const inspectOciArchiveScript = readRepoFile('nix/oci-inspect-archive.sh')
const ociReleaseContractScript = readRepoFile('nix/oci-release-contract.sh')
const ciRunTimedScript = readRepoFile('nix/ci-run-timed.sh')
const ciNixOciSummaryScript = readRepoFile('nix/ci-nix-oci-summary.sh')
const nixOciWorkflow = readRepoFile('.github/workflows/nix-oci-build-common.yml')
const enabledSimpleReleaseWorkflow = readRepoFile('.github/workflows/enabled-simple-nix-release.yml')
const productNixWorkflow = readRepoFile('.github/workflows/product-nix-images.yml')
const bunWorkspaceServiceModule = readRepoFile('nix/images/bun-workspace-service.nix')
const enabledProductReleaseWorkflow = readRepoFile('.github/workflows/enabled-product-nix-release.yml')
const agentsBuildWorkflow = readRepoFile('.github/workflows/agents-build-push.yml')
const agentsCiWorkflow = readRepoFile('.github/workflows/agents-ci.yml')
const jangarBuildWorkflow = readRepoFile('.github/workflows/jangar-build-push.yaml')
const symphonyBuildWorkflow = readRepoFile('.github/workflows/symphony-build-push.yaml')
const symphonyCiWorkflow = readRepoFile('.github/workflows/symphony-ci.yml')
const symphonyReleaseWorkflow = readRepoFile('.github/workflows/symphony-release.yml')
const symphonyReleaseMetadataScript = readRepoFile('packages/scripts/src/symphony/resolve-release-metadata.ts')
const sagBuildWorkflow = readRepoFile('.github/workflows/sag-build-push.yaml')
const sagReleaseWorkflow = readRepoFile('.github/workflows/sag-release.yml')
const sagPostDeployVerifyWorkflow = readRepoFile('.github/workflows/sag-post-deploy-verify.yml')
const torghutBuildWorkflow = readRepoFile('.github/workflows/torghut-build-push.yaml')
const torghutTaBuildWorkflow = readRepoFile('.github/workflows/torghut-ta-build-push.yaml')
const torghutWsBuildWorkflow = readRepoFile('.github/workflows/torghut-ws-build-push.yaml')
const torghutHyperliquidFeedBuildWorkflow = readRepoFile('.github/workflows/torghut-hyperliquid-feed-build-push.yaml')
const torghutReleaseWorkflow = readRepoFile('.github/workflows/torghut-release.yml')
const torghutTaReleaseWorkflow = readRepoFile('.github/workflows/torghut-ta-release.yml')
const torghutWsReleaseWorkflow = readRepoFile('.github/workflows/torghut-ws-release.yml')
const torghutHyperliquidFeedReleaseWorkflow = readRepoFile('.github/workflows/torghut-hyperliquid-feed-release.yml')
const torghutCiWorkflow = readRepoFile('.github/workflows/torghut-ci.yml')
const torghutDeployAutomergeWorkflow = readRepoFile('.github/workflows/torghut-deploy-automerge.yml')
const autoPrReleaseBranchesWorkflow = readRepoFile('.github/workflows/auto-pr-release-branches.yml')
const releasePrAutomergeWorkflow = readRepoFile('.github/workflows/release-pr-automerge.yml')
const oiratWorkflow = readRepoFile('.github/workflows/oirat-ci.yml')
const bumbaWorkflow = readRepoFile('.github/workflows/bumba-ci.yml')
const froussardWorkflow = readRepoFile('.github/workflows/froussard-ci.yml')
const froussardKnativeService = readRepoFile('argocd/applications/froussard/knative-service.yaml')
const appImageModule = readRepoFile('nix/images/app.nix')
const productImageModules = [
  appImageModule,
  readRepoFile('nix/images/docs.nix'),
  readRepoFile('nix/images/olden.nix'),
  readRepoFile('nix/images/proompteng.nix'),
  readRepoFile('nix/images/synthesis.nix'),
]
const allNixImageModules = readdirSync(new URL('nix/images/', repoRoot))
  .filter((name) => name.endsWith('.nix'))
  .map((name) => [name, readRepoFile(`nix/images/${name}`)] as const)
const symphonyImageModule = readRepoFile('nix/images/symphony.nix')
const sagImageModule = readRepoFile('nix/images/sag.nix')
const torghutImageModule = readRepoFile('nix/images/torghut.nix')
const torghutTaImageModule = readRepoFile('nix/images/torghut-ta.nix')
const torghutWsImageModule = readRepoFile('nix/images/torghut-ws.nix')
const torghutHyperliquidFeedImageModule = readRepoFile('nix/images/torghut-hyperliquid-feed.nix')
const agentsImageModule = readRepoFile('nix/images/agents.nix')
const openaiCodexCliModule = readRepoFile('nix/images/openai-codex-cli.nix')
const oiratBuildScript = readRepoFile('packages/scripts/src/oirat/build-image.ts')
const bumbaBuildScript = readRepoFile('packages/scripts/src/bumba/build-image.ts')
const froussardDeployScript = readRepoFile('packages/scripts/src/froussard/deploy-service.ts')
const symphonyBuildScript = readRepoFile('packages/scripts/src/symphony/build-image.ts')
const symphonyDeployScript = readRepoFile('packages/scripts/src/symphony/deploy-service.ts')
const sagBuildScript = readRepoFile('packages/scripts/src/sag/build-image.ts')
const sagDeployScript = readRepoFile('packages/scripts/src/sag/deploy-service.ts')
const agentsDeployScript = readRepoFile('packages/scripts/src/agents/deploy-service.ts')
const torghutBuildScript = readRepoFile('packages/scripts/src/torghut/build-image.ts')
const torghutDeployScript = readRepoFile('packages/scripts/src/torghut/deploy-service.ts')
const torghutTaDeployScript = readRepoFile('packages/scripts/src/torghut/deploy-ta.ts')
const torghutUpdateScripts = [
  readRepoFile('packages/scripts/src/torghut/update-manifests.ts'),
  readRepoFile('packages/scripts/src/torghut/update-ta-manifest.ts'),
  readRepoFile('packages/scripts/src/torghut/update-ws-manifest.ts'),
  readRepoFile('packages/scripts/src/torghut/update-hyperliquid-feed-manifest.ts'),
]
const productBuildScripts = [
  readRepoFile('packages/scripts/src/app/build-image.ts'),
  readRepoFile('packages/scripts/src/docs/build-image.ts'),
  readRepoFile('packages/scripts/src/proompteng/build-image.ts'),
  readRepoFile('packages/scripts/src/olden/build-image.ts'),
  readRepoFile('packages/scripts/src/synthesis/build-image.ts'),
]
const productDeployScripts = [
  readRepoFile('packages/scripts/src/app/deploy-service.ts'),
  readRepoFile('packages/scripts/src/docs/deploy-service.ts'),
  readRepoFile('packages/scripts/src/proompteng/deploy-service.ts'),
  readRepoFile('packages/scripts/src/olden/deploy-service.ts'),
  readRepoFile('packages/scripts/src/synthesis/deploy-service.ts'),
]
const nixOciDeployScript = readRepoFile('packages/scripts/src/shared/nix-oci-deploy.ts')
const nixOciPlanScript = readRepoFile('packages/scripts/src/shared/nix-oci.ts')
const ociPushScript = readRepoFile('nix/oci-push.sh')
const nixImageHelperInputs = [
  'nix/cache-push.sh',
  'nix/ci-nix-oci-summary.sh',
  'nix/ci-run-timed.sh',
  'nix/oci-inspect-archive.sh',
  'nix/oci-push.sh',
  'nix/oci-release-contract.sh',
]

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

  it('reads the platform from single-architecture manifests', () => {
    Bun.which = ((binary: string) => (binary === 'crane' ? '/bin/crane' : null)) as typeof Bun.which
    __private.setSpawnSync(((command: Parameters<typeof Bun.spawnSync>[0]) => {
      const joined = typeof command === 'string' ? command : command.join(' ')
      if (joined === 'crane manifest registry.example/lab/example:sha') {
        return spawnResult(
          0,
          JSON.stringify({
            schemaVersion: 2,
            config: {
              digest: 'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
            },
          }),
        )
      }
      if (joined === 'crane digest registry.example/lab/example:sha') {
        return spawnResult(0, 'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee')
      }
      if (joined === 'crane config registry.example/lab/example:sha') {
        return spawnResult(0, JSON.stringify({ os: 'linux', architecture: 'arm64' }))
      }
      return spawnResult(1)
    }) as typeof Bun.spawnSync)

    expect(inspectOciPlatforms('registry.example/lab/example:sha')).toEqual([
      {
        platform: 'linux/arm64',
        digest: 'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      },
    ])
  })

  it('falls back to regctl for single-architecture image digest and config reads', () => {
    Bun.which = ((binary: string) =>
      binary === 'crane' || binary === 'regctl' ? `/bin/${binary}` : null) as typeof Bun.which
    __private.setSpawnSync(((command: Parameters<typeof Bun.spawnSync>[0]) => {
      const joined = typeof command === 'string' ? command : command.join(' ')
      if (joined === 'crane manifest registry.example/lab/example:sha') {
        return spawnResult(1, '', 'not found')
      }
      if (joined === 'regctl manifest get registry.example/lab/example:sha --format raw-body') {
        return spawnResult(
          0,
          JSON.stringify({
            schemaVersion: 2,
            config: {
              digest: 'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
            },
          }),
        )
      }
      if (joined === 'crane digest registry.example/lab/example:sha') {
        return spawnResult(1, '', 'not found')
      }
      if (joined === 'regctl image digest registry.example/lab/example:sha') {
        return spawnResult(0, 'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee')
      }
      if (joined === 'crane config registry.example/lab/example:sha') {
        return spawnResult(1, '', 'not found')
      }
      if (joined === 'regctl image inspect registry.example/lab/example:sha') {
        return spawnResult(0, JSON.stringify({ os: 'linux', architecture: 'amd64' }))
      }
      return spawnResult(1)
    }) as typeof Bun.spawnSync)

    expect(inspectOciPlatforms('registry.example/lab/example:sha')).toEqual([
      {
        platform: 'linux/amd64',
        digest: 'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      },
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
    expect(nixOciWorkflow).toContain('bash nix/oci-inspect-archive.sh "${IMAGE_TAR}"')
    expect(nixOciWorkflow).toContain('bash nix/oci-push.sh')
    expect(nixOciWorkflow).toContain('publish_on_dispatch:')
    expect(nixOciWorkflow).toContain("github.event_name == 'workflow_dispatch'")
    expect(nixOciWorkflow).toContain("github.ref == 'refs/heads/main' || inputs.publish_on_dispatch")
    expect(nixOciWorkflow).toContain('bun run packages/scripts/src/shared/oci.ts create-index')
    expect(nixOciWorkflow).toContain('bun run packages/scripts/src/shared/oci.ts assert')
    expect(nixOciWorkflow).toContain('printf \'%s\\n\' "${image_tar}" > "${NIX_OCI_LOG_DIR}/image-paths-${ARCH}.txt"')
    expect(nixOciWorkflow).not.toContain('Prime OCI helper closures')
    expect(nixOciWorkflow).not.toContain('Push build platform helper closures to Attic')
    expect(nixOciWorkflow).toContain('Warm Nix image archive closure in Attic')
    expect(nixOciWorkflow).toContain('mapfile -t image_paths < "${NIX_OCI_LOG_DIR}/image-paths-${ARCH}.txt"')
    expect(nixOciWorkflow).toContain('bash nix/cache-push.sh "${image_paths[@]}"')
    expect(nixOciWorkflow).toContain(
      'Attic image closure push failed for ${ARCH}; registry image push remains authoritative.',
    )
    expect(nixOciWorkflow).not.toContain('cache_paths=("${helper_paths[@]}" "${image_paths[@]}")')
    expect(nixOciWorkflow).not.toContain('nix run .#cache-push')
    expect(nixOciWorkflow).toContain(
      'bash nix/oci-release-contract.sh .artifacts/${{ inputs.image_name }}/release-contract.json',
    )
    expect(nixOciWorkflow).toContain('PLATFORM_DIGEST_AMD64: ${{ steps.oci.outputs.platform_digest_amd64 }}')
    expect(nixOciWorkflow).toContain('PLATFORM_DIGEST_ARM64: ${{ steps.oci.outputs.platform_digest_arm64 }}')
    expect(nixOciWorkflow).toContain('substituters = http://attic.attic.svc.cluster.local/lab https://cache.nixos.org/')
    expect(nixOciWorkflow).toContain('fallback = true')
    expect(nixOciWorkflow).toContain('stalled-download-timeout = 60')
    expect(nixOciWorkflow).toContain('NIX_IMAGE_BUILD_ATTIC_TIMEOUT: 8m')
    expect(nixOciWorkflow).toContain('timeout --kill-after=30s "${NIX_IMAGE_BUILD_ATTIC_TIMEOUT}"')
    expect(nixOciWorkflow).toContain('build-image-${ARCH}-cache-nixos-fallback')
    expect(nixOciWorkflow).toContain('timeout --kill-after=30s "${NIX_IMAGE_BUILD_ATTIC_TIMEOUT}" \\')
    expect(nixOciWorkflow).toContain('substituters = https://cache.nixos.org/')
    expect(nixOciWorkflow).toContain('Nix image archive build retried without Attic')
    expect(nixOciWorkflow).not.toContain('extra-substituters = http://attic.attic.svc.cluster.local/lab')
    expect(nixOciWorkflow).not.toContain('nix build --print-build-logs --no-link --print-out-paths "$@"')
    expect(nixOciWorkflow).not.toContain('helper_attrs=')
    expect(nixOciWorkflow).not.toContain('helper_paths')
    expect(nixOciWorkflow).not.toContain('No build-platform helper closure paths were captured.')
    expect(nixOciWorkflow).toContain('No Nix image closure paths were captured.')
    expect(nixOciWorkflow).not.toContain('No index helper closure paths were captured.')
    expect(nixOciWorkflow).toContain('Start checkout timer')
    expect(nixOciWorkflow).toContain('Record checkout timing')
    expect(nixOciWorkflow).toContain('"checkout-${ARCH}"')
    expect(nixOciWorkflow).toContain('"checkout-publish-index"')
    expect(nixOciWorkflow).toContain('Start Nix setup timer')
    expect(nixOciWorkflow).toContain('Record Nix setup timing')
    expect(nixOciWorkflow).toContain('"nix-setup-${ARCH}"')
    expect(nixOciWorkflow).toContain('"nix-setup-publish-index"')
    expect(nixOciWorkflow).toContain("require-preinstalled: 'true'")
    expect(nixOciWorkflow).toContain("install-ci-toolchain: 'false'")
    expect(nixOciWorkflow).not.toContain("install-ci-toolchain: 'true'")
    expect(nixOciWorkflow).toContain('nix/ci-run-timed.sh')
    expect(nixOciWorkflow).toContain('nix/ci-nix-oci-summary.sh')
    expect(nixOciWorkflow).not.toContain('nix develop -c')
  })

  it('writes release contracts with platform digests for strict Torghut promotion', () => {
    expect(ociReleaseContractScript).toContain('PLATFORM_DIGEST_AMD64')
    expect(ociReleaseContractScript).toContain('PLATFORM_DIGEST_ARM64')
    expect(ociReleaseContractScript).toContain('platformDigests: {')
    expect(ociReleaseContractScript).toContain('"linux/amd64": $platformDigestAmd64')
    expect(ociReleaseContractScript).toContain('"linux/arm64": $platformDigestArm64')
    expect(ociReleaseContractScript).toContain('createdAt: $createdAt')
  })

  it('records real Nix OCI timing and cache-hit summaries', () => {
    expect(ciRunTimedScript).toContain('printf')
    expect(ciRunTimedScript).toContain('timings.tsv')
    expect(ciRunTimedScript).toContain('PIPESTATUS[0]')
    expect(ciNixOciSummaryScript).toContain('Attic substitutions')
    expect(ciNixOciSummaryScript).toContain('cache.nixos.org substitutions')
    expect(ciNixOciSummaryScript).toContain('Local derivation builds')
    expect(ciNixOciSummaryScript).toContain('Nix OCI Performance Contract')
    expect(ciNixOciSummaryScript).toContain('Total timed seconds')
    expect(ciNixOciSummaryScript).toContain('Cache substitutions')
    expect(ciNixOciSummaryScript).toContain('Existing image archive bytes')
    expect(ciNixOciSummaryScript).toContain('Image archive Attic warm successes')
    expect(ciNixOciSummaryScript).toContain('Image archive Attic warm failures')
    expect(ciNixOciSummaryScript).toContain('GITHUB_STEP_SUMMARY')
  })

  it('keeps Nix image derivations deterministic and dockerTools-backed', () => {
    for (const [name, imageModule] of allNixImageModules) {
      if (imageModule.includes('created = "now"')) {
        throw new Error(`${name} must not use impure dockerTools timestamps`)
      }
      if (imageModule.includes('docker build')) {
        throw new Error(`${name} must not emulate Dockerfile builds`)
      }
    }
    expect(
      allNixImageModules.some(([, imageModule]) => imageModule.includes('pkgs.dockerTools.buildLayeredImage')),
    ).toBe(true)
  })

  it('caps Bun workspace image layers to keep registry publishes bounded', () => {
    expect(bunWorkspaceServiceModule).toContain('maxLayers ? 24')
    expect(bunWorkspaceServiceModule).toContain('inherit maxLayers;')
  })

  it('creates writable temp directories in Bun workspace images for non-root runtime pods', () => {
    expect(bunWorkspaceServiceModule).toContain('extraCommands =')
    expect(bunWorkspaceServiceModule).toContain('mkdir -p tmp var/tmp')
    expect(bunWorkspaceServiceModule).toContain('chmod 1777 tmp var/tmp')
  })

  it('does not fan out expensive image builds on unrelated shared script changes', () => {
    for (const workflow of [
      agentsBuildWorkflow,
      jangarBuildWorkflow,
      symphonyBuildWorkflow,
      sagBuildWorkflow,
      productNixWorkflow,
      torghutBuildWorkflow,
    ]) {
      expect(workflow).not.toContain("'packages/scripts/src/shared/**'")
      expect(workflow).not.toContain('- packages/scripts/src/shared/**')
      expect(workflow).not.toContain("'packages/scripts/src/shared/nix-oci-deploy.ts'")
    }

    expect(productNixWorkflow).not.toContain("'nix/**'")
    expect(agentsBuildWorkflow).not.toContain("'packages/scripts/src/shared/docker.ts'")

    for (const workflow of [jangarBuildWorkflow]) {
      expect(workflow).toContain("'packages/scripts/src/shared/cli.ts'")
      expect(workflow).toContain("'packages/scripts/src/shared/docker.ts'")
      expect(workflow).toContain("'packages/scripts/src/shared/git.ts'")
    }
    expect(symphonyBuildWorkflow).not.toContain("'packages/scripts/src/symphony/**'")
    expect(symphonyBuildWorkflow).not.toContain("'packages/scripts/src/shared/cli.ts'")
    expect(symphonyBuildWorkflow).not.toContain("'packages/scripts/src/shared/git.ts'")
    expect(symphonyBuildWorkflow).not.toContain("'packages/scripts/src/shared/docker.ts'")
    expect(sagBuildWorkflow).not.toContain("'packages/scripts/src/sag/**'")
    expect(sagBuildWorkflow).not.toContain("'packages/scripts/src/shared/cli.ts'")
    expect(sagBuildWorkflow).not.toContain("'packages/scripts/src/shared/git.ts'")
    expect(sagBuildWorkflow).not.toContain("'packages/scripts/src/shared/docker.ts'")

    expect(enabledProductReleaseWorkflow).not.toContain('packages/scripts/src/shared nix/images')
    expect(enabledProductReleaseWorkflow).not.toContain('packages/scripts/src/shared/nix-oci-deploy.ts')
    expect(sagReleaseWorkflow).not.toContain('packages/scripts/src/shared/nix-oci-deploy.ts')
    expect(symphonyReleaseMetadataScript).not.toContain('packages\\/scripts\\/src\\/symphony')
    expect(symphonyReleaseMetadataScript).not.toContain('packages\\/scripts\\/src\\/shared')
  })

  it('keeps workflow_run release stale guards aligned to image build triggers', () => {
    for (const workflow of [
      enabledSimpleReleaseWorkflow,
      enabledProductReleaseWorkflow,
      sagReleaseWorkflow,
      torghutTaReleaseWorkflow,
      torghutWsReleaseWorkflow,
      torghutHyperliquidFeedReleaseWorkflow,
    ]) {
      expect(workflow).not.toContain('.github/workflows/')
      expect(workflow).not.toContain('packages/scripts/src/shared/nix-oci-deploy.ts')
      for (const helperInput of nixImageHelperInputs) {
        expect(workflow).toContain(helperInput)
      }
    }

    expect(symphonyReleaseMetadataScript).not.toContain('.github\\/workflows\\/')
    expect(symphonyReleaseMetadataScript).not.toContain('setup-nix-toolchain')
    for (const helperInput of nixImageHelperInputs) {
      expect(symphonyReleaseMetadataScript).toContain(helperInput.replaceAll('/', '\\/').replaceAll('.', '\\.'))
    }
  })

  it('does not fan out migrated image builds on workflow-only changes', () => {
    const migratedImageWorkflows = [
      atticWorkflow,
      oiratWorkflow,
      bumbaWorkflow,
      froussardWorkflow,
      productNixWorkflow,
      agentsBuildWorkflow,
      symphonyBuildWorkflow,
      sagBuildWorkflow,
      torghutTaBuildWorkflow,
      torghutWsBuildWorkflow,
      torghutHyperliquidFeedBuildWorkflow,
    ]

    for (const workflow of migratedImageWorkflows) {
      expect(workflow).not.toContain("- '.github/workflows/")
      expect(workflow).not.toContain("- '.github/actions/setup-nix-toolchain/**'")
    }
  })

  it('does not fan out service CI on image workflow-only changes', () => {
    for (const workflow of [agentsCiWorkflow, symphonyCiWorkflow, torghutCiWorkflow]) {
      expect(workflow).not.toContain("- '.github/workflows/")
      expect(workflow).not.toContain("- '.github/actions/setup-nix-toolchain/**'")
    }
    expect(torghutCiWorkflow).not.toContain('github/workflows/torghut-')
  })

  it('does not fan out migrated image builds on unrelated flake attr changes', () => {
    for (const workflow of [
      atticWorkflow,
      oiratWorkflow,
      bumbaWorkflow,
      froussardWorkflow,
      productNixWorkflow,
      agentsBuildWorkflow,
      symphonyBuildWorkflow,
      sagBuildWorkflow,
    ]) {
      expect(workflow).not.toContain("- 'flake.nix'")
      expect(workflow).not.toContain('- flake.nix')
    }

    for (const workflow of [enabledSimpleReleaseWorkflow, enabledProductReleaseWorkflow, sagReleaseWorkflow]) {
      expect(workflow).not.toContain(' flake.nix ')
      expect(workflow).not.toContain('\n              flake.nix\n')
    }

    expect(symphonyReleaseMetadataScript).not.toContain('flake\\.nix$')
    expect(symphonyReleaseMetadataScript).toContain('nix\\/images\\/openai-codex-cli\\.nix$')
    for (const workflow of [
      oiratWorkflow,
      bumbaWorkflow,
      froussardWorkflow,
      productNixWorkflow,
      agentsBuildWorkflow,
      sagBuildWorkflow,
    ]) {
      expect(workflow).toContain("- 'flake.lock'")
      expect(workflow).toContain("- 'nix/images/bun-workspace-service.nix'")
    }
    expect(atticWorkflow).toContain("- 'flake.lock'")
    expect(atticWorkflow).toContain("- 'nix/images/attic.nix'")
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
    const migratedWorkflows = [
      atticWorkflow,
      nixOciWorkflow,
      oiratWorkflow,
      bumbaWorkflow,
      froussardWorkflow,
      productNixWorkflow,
      enabledProductReleaseWorkflow,
      agentsBuildWorkflow,
      symphonyBuildWorkflow,
      symphonyReleaseWorkflow,
      sagBuildWorkflow,
      sagReleaseWorkflow,
      sagPostDeployVerifyWorkflow,
      torghutBuildWorkflow,
      torghutTaBuildWorkflow,
      torghutWsBuildWorkflow,
      torghutHyperliquidFeedBuildWorkflow,
      torghutReleaseWorkflow,
      torghutTaReleaseWorkflow,
      torghutWsReleaseWorkflow,
      torghutHyperliquidFeedReleaseWorkflow,
      torghutCiWorkflow,
      torghutDeployAutomergeWorkflow,
    ]
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
    expect(repoFileExists('.github/workflows/docker-build-push.yaml')).toBe(false)
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

  it('lets workflow-dispatched main image builds publish release contracts', () => {
    const mainDispatchPredicate =
      "(github.event_name == 'push' || github.event_name == 'workflow_dispatch') && github.ref == 'refs/heads/main'"

    expect(nixOciWorkflow).toContain("github.event_name == 'push' && github.ref == 'refs/heads/main'")
    expect(nixOciWorkflow).toContain("github.event_name == 'workflow_dispatch'")
    expect(nixOciWorkflow).toContain("github.ref == 'refs/heads/main' || inputs.publish_on_dispatch")
    expect(nixOciWorkflow).toContain('name: Push platform image without Docker')
    expect(nixOciWorkflow).toContain('name: Warm Nix image archive closure in Attic')
    expect(nixOciWorkflow).toContain('publish-index:')

    for (const [workflow, artifact] of [
      [oiratWorkflow, 'oirat-release-contract'],
      [bumbaWorkflow, 'bumba-release-contract'],
      [froussardWorkflow, 'froussard-release-contract'],
      [sagBuildWorkflow, 'sag-release-contract'],
      [symphonyBuildWorkflow, 'symphony-release-contract'],
      [torghutBuildWorkflow, 'torghut-release-contract'],
      [torghutTaBuildWorkflow, 'torghut-ta-release-contract'],
      [torghutWsBuildWorkflow, 'torghut-ws-release-contract'],
      [torghutHyperliquidFeedBuildWorkflow, 'torghut-hyperliquid-feed-release-contract'],
    ] as const) {
      expect(workflow).toContain(`latest: \${{ ${mainDispatchPredicate} }}`)
      expect(workflow).toContain(`release_artifact_name: \${{ ${mainDispatchPredicate} && '${artifact}' || '' }}`)
    }

    for (const artifact of [
      'agents-controller-release-contract',
      'agents-control-plane-release-contract',
      'agents-shell-release-contract',
    ]) {
      expect(agentsBuildWorkflow).toContain(
        `release_artifact_name: \${{ ${mainDispatchPredicate} && '${artifact}' || '' }}`,
      )
    }
    expect(agentsBuildWorkflow).toContain(`write-values:\n    if: ${mainDispatchPredicate}`)
    expect(atticWorkflow).toContain(`latest: \${{ ${mainDispatchPredicate} }}`)
    expect(atticWorkflow).toContain('release_artifact_name: attic-release-contract')
  })

  it('routes the enabled Symphony fleet image through a real Nix OCI attr', () => {
    expect(flake).toContain('"symphony-image"')
    expect(repoFileExists('nix/images/symphony.nix')).toBe(true)
    expect(symphonyImageModule).toContain('import ./openai-codex-cli.nix')
    expect(openaiCodexCliModule).toContain('pname = "openai-codex-cli"')
    expect(openaiCodexCliModule).toContain('version = codexVersion')
    expect(symphonyImageModule).toContain('dependencyClosure = "bunCache";')
    expect(symphonyImageModule).toContain('"@proompteng/symphony"')
    expect(symphonyImageModule).toContain('pkgs.uv')

    expect(symphonyBuildWorkflow).toContain('uses: ./.github/workflows/nix-oci-build-common.yml')
    expect(symphonyBuildWorkflow).toContain('image_name: symphony')
    expect(symphonyBuildWorkflow).toContain('package_attr: symphony-image')
    expect(symphonyBuildWorkflow).toContain('symphony-release-contract')
    expect(symphonyBuildWorkflow).toContain('tag: sha-${{ github.sha }}')
    expect(symphonyBuildWorkflow).not.toContain('oven-sh/setup-bun')
    expect(symphonyBuildWorkflow).not.toContain('docker/setup-buildx-action')

    expect(symphonyReleaseWorkflow).toContain('uses: ./.github/actions/setup-nix-toolchain')
    expect(symphonyReleaseWorkflow).toContain('crane digest "${IMAGE_NAME}:${IMAGE_TAG}"')
    expect(symphonyReleaseWorkflow).not.toContain('docker buildx')
    expect(symphonyReleaseWorkflow).not.toContain('docker/setup-buildx-action')
  })

  it('routes the enabled Sag image through a real Nix OCI attr', () => {
    expect(flake).toContain('"sag-image"')
    expect(repoFileExists('nix/images/sag.nix')).toBe(true)
    expect(sagImageModule).toContain('dependencyClosure = "bunCache";')
    expect(sagImageModule).toContain('"@proompteng/codex"')
    expect(sagImageModule).toContain('"@proompteng/sag"')
    expect(sagImageModule).toContain('import ./openai-codex-cli.nix')

    expect(sagBuildWorkflow).toContain('uses: ./.github/workflows/nix-oci-build-common.yml')
    expect(sagBuildWorkflow).toContain('image_name: sag')
    expect(sagBuildWorkflow).toContain('package_attr: sag-image')
    expect(sagBuildWorkflow).toContain('sag-release-contract')
    expect(sagBuildWorkflow).toContain('tag: sha-${{ github.sha }}')
    expect(sagBuildWorkflow).not.toContain('oven-sh/setup-bun')
    expect(sagBuildWorkflow).not.toContain('docker/setup-buildx-action')

    expect(sagReleaseWorkflow).toContain('argocd/sag/kustomization.yaml')
    expect(sagReleaseWorkflow).toContain('nix run .#assert-oci-platforms -- "${IMAGE}@${DIGEST}"')
    expect(sagReleaseWorkflow).toContain('test "${service}" = "sag"')
    expect(sagReleaseWorkflow).not.toContain('packages/scripts/src/shared/nix-oci-deploy.ts')
    expect(sagReleaseWorkflow).not.toContain('docker buildx')
    expect(sagPostDeployVerifyWorkflow).toContain('kubectl -n sag rollout status deployment/sag')
    expect(sagPostDeployVerifyWorkflow).toContain('desired_replicas=')
  })

  it('routes the enabled Torghut family images through real Nix OCI attrs', () => {
    for (const [workflow, imageName, packageAttr, artifact] of [
      [torghutBuildWorkflow, 'torghut', 'torghut-image', 'torghut-release-contract'],
      [torghutTaBuildWorkflow, 'torghut-ta', 'torghut-ta-image', 'torghut-ta-release-contract'],
      [torghutWsBuildWorkflow, 'torghut-ws', 'torghut-ws-image', 'torghut-ws-release-contract'],
      [
        torghutHyperliquidFeedBuildWorkflow,
        'torghut-hyperliquid-feed',
        'torghut-hyperliquid-feed-image',
        'torghut-hyperliquid-feed-release-contract',
      ],
    ] as const) {
      expect(workflow).toContain('uses: ./.github/workflows/nix-oci-build-common.yml')
      expect(workflow).toContain(`image_name: ${imageName}`)
      expect(workflow).toContain(`package_attr: ${packageAttr}`)
      expect(workflow).toContain(artifact)
      expect(workflow).toContain('tag: sha-${{ github.sha }}')
    }

    for (const packageAttr of [
      'torghut-image',
      'torghut-ta-image',
      'torghut-ws-image',
      'torghut-hyperliquid-feed-image',
    ]) {
      expect(flake).toContain(`"${packageAttr}"`)
    }
    expect(torghutImageModule).toContain('pkgs.uv')
    expect(torghutTaImageModule).toContain('pkgs.dockerTools.pullImage')
    expect(torghutTaImageModule).toContain('sha256:d357b0e1eb89eb4377735a008dfcbd35f7f06af6cba24dfbb6062379fb70a9a9')
    expect(torghutTaImageModule).toContain('sha256:c0b3512ea891d604c585d3cb217b75a2bf920d9faaa9f0770496476189d5f57f')
    expect(torghutTaImageModule).toContain('flink-s3-fs-hadoop-2.0.1.jar')
    expect(torghutTaImageModule).not.toContain('flink-2.0.1-bin-scala_2.12.tgz')
    expect(torghutTaImageModule).not.toContain('archive.apache.org/dist/flink')
    expect(torghutWsImageModule).toContain('ForwarderAppKt')
    expect(torghutHyperliquidFeedImageModule).toContain('HyperliquidFeedAppKt')

    for (const workflow of [
      torghutReleaseWorkflow,
      torghutTaReleaseWorkflow,
      torghutWsReleaseWorkflow,
      torghutHyperliquidFeedReleaseWorkflow,
    ]) {
      expect(workflow).toContain('uses: ./.github/actions/setup-nix-toolchain')
      expect(workflow).toContain('crane digest "${IMAGE_NAME}:${IMAGE_TAG}"')
      expect(workflow).toContain('nix run .#assert-oci-platforms -- "${IMAGE_REF}" linux/amd64 linux/arm64')
      expect(workflow).not.toContain('packages/scripts/src/shared/nix-oci-deploy.ts')
      expect(workflow).not.toContain('packages/scripts/src/shared/oci-digest.ts')
      expect(workflow).not.toContain('docker buildx')
    }
  })

  it('routes the enabled Agents service images through real Nix OCI attrs', () => {
    for (const [imageName, packageAttr, artifact] of [
      ['agents-controller', 'agents-controller-image', 'agents-controller-release-contract'],
      ['agents-control-plane', 'agents-control-plane-image', 'agents-control-plane-release-contract'],
      ['agents-shell', 'agents-shell-image', 'agents-shell-release-contract'],
    ] as const) {
      expect(agentsImageModule).toContain(`"${packageAttr}"`)
      expect(agentsBuildWorkflow).toContain(`image_name: ${imageName}`)
      expect(agentsBuildWorkflow).toContain(`package_attr: ${packageAttr}`)
      expect(agentsBuildWorkflow).toContain(artifact)
    }

    expect(flake).toContain('import ./nix/images/agents.nix')
    expect(agentsBuildWorkflow).toContain('uses: ./.github/workflows/nix-oci-build-common.yml')
    expect(agentsBuildWorkflow).toContain('tag: sha-${{ github.sha }}')
    expect(agentsBuildWorkflow).toContain('Resolve preserved runner image pin')
    expect(agentsBuildWorkflow).toContain('--runner-tag "${RUNNER_TAG}"')
    expect(agentsBuildWorkflow).toContain("'charts/agents/crds/**'")
    expect(agentsBuildWorkflow).not.toContain("'charts/agents/**'")
    expect(agentsBuildWorkflow).not.toContain("'argocd/applications/agents/**'")
    expect(agentsBuildWorkflow).not.toContain('oven-sh/setup-bun')
    expect(agentsBuildWorkflow).not.toContain('docker/setup-buildx-action')
    expect(agentsBuildWorkflow).not.toContain('docker buildx')

    expect(agentsImageModule).toContain('dependencyClosure = "bunCache";')
    expect(agentsImageModule).toContain('"@proompteng/agents"')
    expect(agentsImageModule).toContain('"@proompteng/cx-tools"')
    expect(agentsImageModule).toContain('"charts/agents/crds"')
    expect(agentsImageModule).toContain('"agents-controller-image"')
    expect(agentsImageModule).toContain('"agents-control-plane-image"')
    expect(agentsImageModule).toContain('"agents-shell-image"')
  })

  it('preserves isolated Bun workspace runtime dependencies in Agents images', () => {
    expect(agentsImageModule).toContain('copyWorkspaceNodeModules()')
    expect(agentsImageModule).toContain(
      'copyWorkspaceNodeModules "$TMPDIR/work/packages/$package/node_modules" "$out/app/packages/$package/node_modules"',
    )
    expect(agentsImageModule).toContain(
      'copyWorkspaceNodeModules "$TMPDIR/work/services/agents/node_modules" "$out/app/services/agents/node_modules"',
    )
    expect(agentsImageModule).toContain('rm -rf "$target_path"')
    expect(agentsImageModule).toContain('cp -R "$source_path/." "$target_path/"')
    expect(agentsImageModule).toContain('linkBunIsolatedPackage "effect"')
    expect(agentsImageModule).toContain('realpath --relative-to="$(dirname "$target_path")" "$package_path"')
    expect(agentsImageModule).toContain('Bun isolated package not found in runtime image')
  })

  it('routes enabled product app image builds through real Nix OCI attrs', () => {
    for (const [service, packageAttr] of [
      ['proompteng', 'proompteng-image'],
      ['app', 'app-image'],
      ['synthesis', 'synthesis-image'],
      ['docs', 'docs-image'],
      ['olden', 'olden-image'],
    ] as const) {
      expect(flake).toContain(`"${packageAttr}"`)
      expect(repoFileExists(`nix/images/${service}.nix`)).toBe(true)
      expect(productNixWorkflow).toContain(`image_name: ${service}`)
      expect(productNixWorkflow).toContain(`package_attr: ${packageAttr}`)
      expect(productNixWorkflow).toContain(`${service}-release-contract`)
    }

    expect(productNixWorkflow).toContain('uses: ./.github/workflows/nix-oci-build-common.yml')
    expect(productNixWorkflow).toContain('tag: sha-${{ github.sha }}')
    expect(productNixWorkflow).not.toContain('uses: ./.github/workflows/docker-build-common.yaml')
    expect(productNixWorkflow).not.toContain('mathieudutour/github-tag-action')
    expect(productNixWorkflow).not.toContain('ncipollo/release-action')
    expect(productNixWorkflow).not.toContain("'argocd/applications/docs/**'")
    expect(productNixWorkflow).not.toContain("'argocd/applications/app/**'")
    expect(productNixWorkflow).not.toContain("'argocd/applications/proompteng/**'")
    expect(productNixWorkflow).not.toContain("'argocd/applications/olden/**'")
    expect(productNixWorkflow).not.toContain("'argocd/applications/synthesis/**'")
    expect(appImageModule).toContain('"@proompteng/source"')
    for (const imageModule of productImageModules) {
      expect(imageModule).toContain('dependencyClosure = "bunCache";')
    }
    expect(bunWorkspaceServiceModule).toContain('cp -R ${depsSource}/. "$TMPDIR/work/"')
    expect(bunWorkspaceServiceModule).toContain('--cache-dir "$BUN_INSTALL_CACHE_DIR"')
    expect(bunWorkspaceServiceModule).toContain('for attempt in 1 2 3')
    expect(bunWorkspaceServiceModule).toContain('IntegrityCheckFailed|Integrity check failed')
    expect(bunWorkspaceServiceModule).toContain('rm -rf "$BUN_INSTALL_CACHE_DIR"')
    expect(bunWorkspaceServiceModule).toContain("find . -path '*/node_modules' -prune -exec rm -rf {} +")
  })

  it('does not rebuild migrated simple app images for GitOps-only manifest changes', () => {
    expect(oiratWorkflow).not.toContain("'argocd/applications/oirat/**'")
    expect(bumbaWorkflow).not.toContain("'argocd/applications/bumba/**'")
    expect(bumbaWorkflow).not.toContain("'argocd/applicationsets/product.yaml'")
    expect(froussardWorkflow).not.toContain("'argocd/applications/froussard/**'")
    expect(enabledSimpleReleaseWorkflow).not.toContain('packages/scripts/src/oirat argocd/applications/oirat')
    expect(enabledSimpleReleaseWorkflow).not.toContain('packages/scripts/src/bumba argocd/applications/bumba')
    expect(enabledSimpleReleaseWorkflow).not.toContain('packages/scripts/src/froussard argocd/applications/froussard')
  })

  it('keeps manual migrated app deploy scripts on the shared Nix image helper', () => {
    for (const script of [
      oiratBuildScript,
      bumbaBuildScript,
      froussardDeployScript,
      symphonyBuildScript,
      sagBuildScript,
      agentsDeployScript,
      torghutBuildScript,
      torghutDeployScript,
      torghutTaDeployScript,
      ...productBuildScripts,
    ]) {
      expect(script).toContain("from '../shared/nix-oci-deploy'")
      expect(script).not.toContain("from '../shared/docker'")
      expect(script).not.toContain('buildAndPushDockerImage')
      expect(script).not.toContain('inspectImageDigest')
    }
    for (const script of productDeployScripts) {
      expect(script).not.toContain("from '../shared/docker'")
      expect(script).not.toContain('inspectImageDigest')
      expect(script).toContain('dryRun')
      expect(script).toContain('noApply')
      expect(script).toContain('digest:')
    }
    expect(symphonyDeployScript).not.toContain("from '../shared/docker'")
    expect(symphonyDeployScript).not.toContain('inspectImageDigest')
    expect(symphonyDeployScript).toContain('dryRun')
    expect(symphonyDeployScript).toContain('noApply')
    expect(symphonyDeployScript).toContain('digest:')
    expect(sagDeployScript).not.toContain("from '../shared/docker'")
    expect(sagDeployScript).not.toContain('inspectImageDigest')
    expect(sagDeployScript).toContain('dryRun')
    expect(sagDeployScript).toContain('noApply')
    expect(sagDeployScript).toContain('digest:')
    expect(agentsDeployScript).not.toContain("from '../shared/docker'")
    expect(agentsDeployScript).not.toContain('inspectImageDigest')
    expect(agentsDeployScript).toContain("from '../shared/nix-oci-deploy'")
    expect(agentsDeployScript).toContain('dryRun')
    expect(agentsDeployScript).toContain('readRunnerImagePin')

    for (const script of torghutUpdateScripts) {
      expect(script).not.toContain("from '../shared/docker'")
      expect(script).not.toContain('inspectImageDigest')
      expect(script).toContain("from '../shared/oci-digest'")
      expect(script).toContain('inspectOciImageDigest')
    }

    expect(nixOciDeployScript).toContain("await run('nix', ['build', `.#${packageAttr}`")
    expect(nixOciDeployScript).toContain("await run('nix', pushArgs")
    expect(nixOciDeployScript).toContain("runCapture('crane', ['digest'")
    expect(nixOciDeployScript).toContain('buildNixOciBuildPlan')
    expect(nixOciDeployScript).toContain('inspectOciPlatforms')
    expect(nixOciDeployScript).toContain('Pushed Nix OCI image has no observable platform metadata')
    expect(nixOciDeployScript).toContain('platformDigests')
    expect(nixOciDeployScript).toContain('imageTarPath')
    expect(nixOciPlanScript).toContain('Nix OCI image pushes must stay in')
  })

  it('opens digest-pinning release PRs for enabled simple app Nix builds', () => {
    expect(enabledSimpleReleaseWorkflow).toContain('workflows:')
    expect(enabledSimpleReleaseWorkflow).toContain('- oirat')
    expect(enabledSimpleReleaseWorkflow).toContain('- bumba')
    expect(enabledSimpleReleaseWorkflow).toContain('- froussard')
    expect(enabledSimpleReleaseWorkflow).toContain('nix run .#assert-oci-platforms -- "${IMAGE}@${DIGEST}"')
    expect(enabledSimpleReleaseWorkflow).toContain('service build inputs changed after source commit')
    for (const [workflow, dependencyPath] of [
      [oiratWorkflow, "'packages/discord/**'"],
      [bumbaWorkflow, "'packages/temporal-bun-sdk/**'"],
      [froussardWorkflow, "'packages/agent-contracts/**'"],
      [froussardWorkflow, "'packages/codex/**'"],
      [froussardWorkflow, "'packages/discord/**'"],
      [froussardWorkflow, "'packages/otel/**'"],
    ]) {
      expect(workflow).toContain(dependencyPath)
    }
    expect(enabledSimpleReleaseWorkflow).toContain('argocd/applications/oirat/kustomization.yaml')
    expect(enabledSimpleReleaseWorkflow).toContain('argocd/applications/bumba/kustomization.yaml')
    expect(enabledSimpleReleaseWorkflow).toContain('argocd/applications/froussard/knative-service.yaml')
    expect(enabledSimpleReleaseWorkflow).toContain('\\@sha256:[0-9a-f]{64}')
    expect(enabledSimpleReleaseWorkflow).toContain('peter-evans/create-pull-request@v7')
    expect(enabledSimpleReleaseWorkflow).not.toContain('docker buildx')
  })

  it('opens digest-pinning release PRs for enabled product app Nix builds', () => {
    expect(enabledProductReleaseWorkflow).toContain('workflows:')
    expect(enabledProductReleaseWorkflow).toContain('- product-nix-images')
    for (const service of ['proompteng', 'app', 'synthesis', 'docs', 'olden']) {
      expect(enabledProductReleaseWorkflow).toContain(`argocd/applications/${service}/kustomization.yaml`)
    }
    expect(enabledProductReleaseWorkflow).toContain('registry.ide-newton.ts.net/lab/${SERVICE}')
    expect(enabledProductReleaseWorkflow).toContain('registry.ide-newton.ts.net/lab/${service}')
    expect(enabledProductReleaseWorkflow).toContain('${service}-image')
    expect(enabledProductReleaseWorkflow).toContain('nix run .#assert-oci-platforms -- "${image}@${digest}"')
    expect(enabledProductReleaseWorkflow).toContain('service build inputs changed after')
    expect(productNixWorkflow).toContain("'nix/packages.nix'")
    expect(enabledProductReleaseWorkflow).not.toContain('.github/workflows/product-nix-images.yml')
    expect(enabledProductReleaseWorkflow).not.toContain('.github/workflows/nix-oci-build-common.yml')
    expect(enabledProductReleaseWorkflow).toContain('peter-evans/create-pull-request@v7')
    expect(enabledProductReleaseWorkflow).not.toContain('packages/scripts/src/shared/nix-oci-deploy.ts')
    expect(enabledProductReleaseWorkflow).not.toContain('docker buildx')
  })

  it('blocks stale Docker-era release PRs for migrated simple Nix image apps', () => {
    expect(autoPrReleaseBranchesWorkflow).toContain('migrated_nix_image_paths=(')
    for (const path of [
      'argocd/applications/app/kustomization.yaml',
      'argocd/applications/bumba/kustomization.yaml',
      'argocd/applications/docs/kustomization.yaml',
      'argocd/applications/oirat/kustomization.yaml',
      'argocd/applications/olden/kustomization.yaml',
      'argocd/applications/proompteng/kustomization.yaml',
      'argocd/sag/kustomization.yaml',
      'argocd/applications/symphony/kustomization.yaml',
      'argocd/applications/symphony-jangar/kustomization.yaml',
      'argocd/applications/symphony-torghut/kustomization.yaml',
      'argocd/applications/synthesis/kustomization.yaml',
    ]) {
      expect(autoPrReleaseBranchesWorkflow).toContain(`"${path}"`)
      expect(releasePrAutomergeWorkflow).not.toContain(`'${path}'`)
      expect(releasePrAutomergeWorkflow).not.toContain(`"${path}"`)
    }
    expect(autoPrReleaseBranchesWorkflow).toContain('reason="migrated-nix-image-app:${path}"')
  })

  it('keeps Froussard Knative digest rollouts from respecting ignored live annotations during apply', () => {
    const match = productApplicationSet.match(/- name: froussard[\s\S]*?automation: manual/)
    expect(match).not.toBeNull()
    const froussardBlock = match?.[0] ?? ''
    expect(froussardBlock).toContain('syncOptions:')
    expect(froussardBlock).toContain('- ServerSideApply=true')
    expect(froussardBlock).toContain('- ApplyOutOfSyncOnly=true')
    expect(froussardBlock).not.toContain('- RespectIgnoreDifferences=true')
    expect(froussardKnativeService).toContain(
      'serving.knative.dev/creator: system:serviceaccount:argocd:argocd-application-controller',
    )
    expect(froussardKnativeService).toContain(
      'serving.knative.dev/lastModifier: system:serviceaccount:argocd:argocd-application-controller',
    )
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
