import { existsSync, readdirSync, readFileSync } from 'node:fs'

import { afterEach, describe, expect, it } from 'bun:test'

import { __private, assertOciPlatforms, createOciIndex, inspectOciPlatforms } from '../oci'

const originalWhich = Bun.which
const repoRoot = new URL('../../../../../', import.meta.url)
const readRepoFile = (path: string): string => readFileSync(new URL(path, repoRoot), 'utf8')
const repoFileExists = (path: string): boolean => existsSync(new URL(path, repoRoot))
const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const releasePrTokenInput = 'token: ${{ secrets.AGENTS_SPLIT_TOKEN || secrets.GITHUB_TOKEN }}'
const expectNixListBlock = (source: string, assignment: string): string => {
  const match = source.match(new RegExp(`${escapeRegex(assignment)}\\s*=\\s*\\[([\\s\\S]*?)\\];`, 'm'))
  expect(match?.[1]).toBeDefined()
  return match?.[1] ?? ''
}
const expectNixMakeBinPathBlock = (source: string, assignment: string): string => {
  const match = source.match(
    new RegExp(`${escapeRegex(assignment)}\\s*=\\s*lib\\.makeBinPath\\s*\\[([\\s\\S]*?)\\];`, 'm'),
  )
  expect(match?.[1]).toBeDefined()
  return match?.[1] ?? ''
}

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
const agentsReleaseWorkflow = readRepoFile('.github/workflows/agents-release.yml')
const agentsCiWorkflow = readRepoFile('.github/workflows/agents-ci.yml')
const arcRunnerBuildWorkflow = readRepoFile('.github/workflows/arc-runner-build-push.yml')
const arcRunnerReleaseWorkflow = readRepoFile('.github/workflows/arc-runner-release.yml')
const jangarBuildWorkflow = readRepoFile('.github/workflows/jangar-build-push.yaml')
const jangarReleaseWorkflow = readRepoFile('.github/workflows/jangar-release.yml')
const jangarPostDeployVerifyWorkflow = readRepoFile('.github/workflows/jangar-post-deploy-verify.yml')
const symphonyBuildWorkflow = readRepoFile('.github/workflows/symphony-build-push.yaml')
const symphonyCiWorkflow = readRepoFile('.github/workflows/symphony-ci.yml')
const symphonyReleaseWorkflow = readRepoFile('.github/workflows/symphony-release.yml')
const symphonyReleaseMetadataScript = readRepoFile('packages/scripts/src/symphony/resolve-release-metadata.ts')
const jangarReleaseMetadataScript = readRepoFile('packages/scripts/src/jangar/resolve-release-metadata.ts')
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
const productImageUpdater = readRepoFile('argocd/applications/argocd/base/image-updater-product.yaml')
const oiratWorkflow = readRepoFile('.github/workflows/oirat-ci.yml')
const bumbaWorkflow = readRepoFile('.github/workflows/bumba-ci.yml')
const froussardWorkflow = readRepoFile('.github/workflows/froussard-ci.yml')
const headlampWorkflow = readRepoFile('.github/workflows/headlamp-ci.yml')
const headlampReleaseWorkflow = readRepoFile('.github/workflows/headlamp-release.yml')
const headlampValues = readRepoFile('argocd/applications/headlamp/values.yaml')
const headlampStaticCopyPatch = readRepoFile('services/headlamp/patches/0004-static-copy-writable.patch')
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
const jangarImageModule = readRepoFile('nix/images/jangar.nix')
const bumbaImageModule = readRepoFile('nix/images/bumba.nix')
const headlampImageModule = readRepoFile('nix/images/headlamp.nix')
const torghutImageModule = readRepoFile('nix/images/torghut.nix')
const torghutTaImageModule = readRepoFile('nix/images/torghut-ta.nix')
const torghutWsImageModule = readRepoFile('nix/images/torghut-ws.nix')
const torghutHyperliquidFeedImageModule = readRepoFile('nix/images/torghut-hyperliquid-feed.nix')
const agentsImageModule = readRepoFile('nix/images/agents.nix')
const openaiCodexCliModule = readRepoFile('nix/images/openai-codex-cli.nix')
const oiratBuildScript = readRepoFile('packages/scripts/src/oirat/build-image.ts')
const bumbaBuildScript = readRepoFile('packages/scripts/src/bumba/build-image.ts')
const atticBuildScript = readRepoFile('packages/scripts/src/attic/build-image.ts')
const atticDeployScript = readRepoFile('packages/scripts/src/attic/deploy-service.ts')
const froussardBuildScript = readRepoFile('packages/scripts/src/froussard/build-image.ts')
const froussardDeployScript = readRepoFile('packages/scripts/src/froussard/deploy-service.ts')
const headlampBuildScript = readRepoFile('packages/scripts/src/headlamp/build-image.ts')
const headlampDeployScript = readRepoFile('packages/scripts/src/headlamp/deploy-service.ts')
const symphonyBuildScript = readRepoFile('packages/scripts/src/symphony/build-image.ts')
const symphonyDeployScript = readRepoFile('packages/scripts/src/symphony/deploy-service.ts')
const sagBuildScript = readRepoFile('packages/scripts/src/sag/build-image.ts')
const sagDeployScript = readRepoFile('packages/scripts/src/sag/deploy-service.ts')
const jangarBuildScript = readRepoFile('packages/scripts/src/jangar/build-image.ts')
const jangarDeployScript = readRepoFile('packages/scripts/src/jangar/deploy-service.ts')
const jangarUpdateScript = readRepoFile('packages/scripts/src/jangar/update-manifests.ts')
const agentsBuildScript = readRepoFile('packages/scripts/src/agents/build-image.ts')
const agentsDeployScript = readRepoFile('packages/scripts/src/agents/deploy-service.ts')
const arcRunnerBuildScript = readRepoFile('packages/scripts/src/arc-runner/build-image.ts')
const arcRunnerDeployScript = readRepoFile('packages/scripts/src/arc-runner/deploy-service.ts')
const torghutBuildScript = readRepoFile('packages/scripts/src/torghut/build-image.ts')
const torghutImageBuildersScript = readRepoFile('packages/scripts/src/torghut/image-builders.ts')
const torghutWsBuildScript = readRepoFile('packages/scripts/src/torghut/build-ws-image.ts')
const torghutTaBuildScript = readRepoFile('packages/scripts/src/torghut/build-ta-image.ts')
const torghutHyperliquidFeedBuildScript = readRepoFile('packages/scripts/src/torghut/build-hyperliquid-feed-image.ts')
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
  it('creates generated release PRs with an app token fallback so automerge can run', () => {
    for (const [name, workflow] of [
      ['agents', agentsReleaseWorkflow],
      ['arc-runner', arcRunnerReleaseWorkflow],
      ['attic', atticReleaseWorkflow],
      ['enabled-product', enabledProductReleaseWorkflow],
      ['enabled-simple', enabledSimpleReleaseWorkflow],
      ['headlamp', headlampReleaseWorkflow],
      ['jangar', jangarReleaseWorkflow],
      ['sag', sagReleaseWorkflow],
      ['symphony', symphonyReleaseWorkflow],
      ['torghut', torghutReleaseWorkflow],
      ['torghut-hyperliquid-feed', torghutHyperliquidFeedReleaseWorkflow],
      ['torghut-ta', torghutTaReleaseWorkflow],
      ['torghut-ws', torghutWsReleaseWorkflow],
    ]) {
      expect(workflow, `${name} must open generated release PRs through create-pull-request`).toContain(
        'peter-evans/create-pull-request@',
      )
      expect(workflow, `${name} release PRs must not be authored only by GITHUB_TOKEN`).toContain(releasePrTokenInput)
    }
  })

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
    expect(nixOciWorkflow).toContain('Warm Nix image archive output in Attic')
    expect(nixOciWorkflow).toContain('mapfile -t image_paths < "${NIX_OCI_LOG_DIR}/image-paths-${ARCH}.txt"')
    expect(nixOciWorkflow).toContain("ATTIC_PUSH_NO_CLOSURE: 'true'")
    expect(nixOciWorkflow).toContain('NIX_IMAGE_CACHE_WARM_TIMEOUT: 2m')
    expect(nixOciWorkflow).toContain('NIX_IMAGE_CACHE_WARM_MAX_BYTES: 268435456')
    expect(nixOciWorkflow).toContain("printf 'skipped-size\\t%s\\t%s\\n'")
    expect(nixOciWorkflow).toContain('Skipping Attic image output push for ${ARCH}')
    expect(nixOciWorkflow).toContain(
      'timeout --kill-after=30s "${NIX_IMAGE_CACHE_WARM_TIMEOUT}" bash nix/cache-push.sh "${cache_paths[@]}"',
    )
    expect(nixOciWorkflow).toContain(
      'Attic image output push failed for ${ARCH}; registry image push remains authoritative.',
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
    expect(nixOciWorkflow).toContain('image_build_timeout:')
    expect(nixOciWorkflow).toContain('default: 8m')
    expect(nixOciWorkflow).toContain('NIX_IMAGE_BUILD_ATTIC_TIMEOUT: ${{ inputs.image_build_timeout }}')
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
    expect(nixOciWorkflow).toContain('No Nix image output paths were captured.')
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
    expect(ociReleaseContractScript).toContain('lockfileHashes: $lockfileHashes')
    expect(ociReleaseContractScript).toContain('toolVersions: $toolVersions')
    expect(ociReleaseContractScript).toContain('cacheProvenance: $cacheProvenance')
    expect(ociReleaseContractScript).toContain('timings: $timings')
    expect(ociReleaseContractScript).toContain('github-actions-logs')
    expect(ociReleaseContractScript).toContain('NIX_OCI_CONTRACT_LOG_DIRS')
    expect(ociReleaseContractScript).toContain('atticSubstitutions')
    expect(ociReleaseContractScript).toContain('cacheNixosSubstitutions')
    expect(ociReleaseContractScript).toContain('sha256sum "${lockfile}"')
    expect(ociReleaseContractScript).toContain('skopeo --version')
    expect(ociReleaseContractScript).toContain('createdAt: $createdAt')
    expect(nixOciWorkflow).toContain('Upload Nix OCI log artifact')
    expect(nixOciWorkflow).toContain('Download build-platform Nix OCI logs')
    expect(nixOciWorkflow).toContain('nix-oci-logs-${{ inputs.image_name }}-${{ matrix.arch }}')
    expect(nixOciWorkflow).toContain('NIX_OCI_CONTRACT_LOG_DIRS: .artifacts/${{ inputs.image_name }}/nix-oci-logs')
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
    expect(ciNixOciSummaryScript).toContain('Image archive Attic warm size skips')
    expect(ciNixOciSummaryScript).toContain('Image archive Attic warm skipped bytes')
    expect(ciNixOciSummaryScript).toContain('count_image_cache_status_rows skipped-size')
    expect(ciNixOciSummaryScript).toContain('GITHUB_STEP_SUMMARY')
  })

  it('proves Nix store writes and preserves the sudo wrapper for later composite steps', () => {
    const setupNixToolchain = readRepoFile('.github/actions/setup-nix-toolchain/action.yml')

    expect(setupNixToolchain).toContain('nix store add-file "${write_probe}"')
    expect(setupNixToolchain).toContain('LAB_NIX_WRAPPER_DIR=${wrapper_dir}')
    expect(setupNixToolchain).toContain('wrapper_prefix="${LAB_NIX_WRAPPER_DIR:+${LAB_NIX_WRAPPER_DIR}:}"')
    expect(setupNixToolchain).toContain(
      'export PATH="${wrapper_prefix}${HOME}/.nix-profile/bin:/nix/var/nix/profiles/default/bin:${PATH}"',
    )
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
      arcRunnerBuildWorkflow,
      jangarBuildWorkflow,
      symphonyBuildWorkflow,
      sagBuildWorkflow,
      productNixWorkflow,
      torghutBuildWorkflow,
      headlampWorkflow,
    ]) {
      expect(workflow).not.toContain("'packages/scripts/src/shared/**'")
      expect(workflow).not.toContain('- packages/scripts/src/shared/**')
      expect(workflow).not.toContain("'packages/scripts/src/shared/nix-oci-deploy.ts'")
      expect(workflow).not.toContain("- 'nix/oci-release-contract.sh'")
    }

    expect(productNixWorkflow).not.toContain("'nix/**'")
    expect(agentsBuildWorkflow).not.toContain("'packages/scripts/src/shared/docker.ts'")
    for (const workflow of [
      oiratWorkflow,
      bumbaWorkflow,
      froussardWorkflow,
      headlampWorkflow,
      productNixWorkflow,
      agentsBuildWorkflow,
      jangarBuildWorkflow,
      symphonyBuildWorkflow,
      sagBuildWorkflow,
    ]) {
      expect(workflow).not.toContain("'package.json'")
    }
    for (const workflow of [enabledSimpleReleaseWorkflow, enabledProductReleaseWorkflow, sagReleaseWorkflow]) {
      expect(workflow).not.toContain('package.json')
    }

    for (const workflow of [jangarBuildWorkflow]) {
      expect(workflow).not.toContain("'packages/scripts/src/jangar/**'")
      expect(workflow).not.toContain("'packages/scripts/src/shared/docker.ts'")
      expect(workflow).not.toContain("'packages/scripts/src/shared/nix-oci-deploy.ts'")
      expect(workflow).toContain("'nix/images/jangar.nix'")
      expect(workflow).not.toContain("'nix/images/bun-workspace-service.nix'")
      expect(workflow).not.toContain("- 'nix/oci-release-contract.sh'")
    }
    expect(symphonyBuildWorkflow).not.toContain("'packages/scripts/src/symphony/**'")
    expect(symphonyBuildWorkflow).not.toContain("'packages/scripts/src/shared/cli.ts'")
    expect(symphonyBuildWorkflow).not.toContain("'packages/scripts/src/shared/git.ts'")
    expect(symphonyBuildWorkflow).not.toContain("'packages/scripts/src/shared/docker.ts'")
    expect(sagBuildWorkflow).not.toContain("'packages/scripts/src/sag/**'")
    expect(sagBuildWorkflow).not.toContain("'packages/scripts/src/shared/cli.ts'")
    expect(sagBuildWorkflow).not.toContain("'packages/scripts/src/shared/git.ts'")
    expect(sagBuildWorkflow).not.toContain("'packages/scripts/src/shared/docker.ts'")
    expect(headlampWorkflow).not.toContain("'argocd/applications/headlamp/**'")
    expect(headlampWorkflow).not.toContain("'docs/headlamp-setup.md'")
    expect(headlampWorkflow).not.toContain("'packages/scripts/src/headlamp/**'")
    expect(headlampWorkflow).not.toContain("'packages/scripts/src/shared/nix-oci-deploy.ts'")

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
      headlampReleaseWorkflow,
    ]) {
      expect(workflow).not.toContain('.github/workflows/')
      expect(workflow).not.toContain('packages/scripts/src/shared/nix-oci-deploy.ts')
      expect(workflow).not.toContain('nix/oci-release-contract.sh')
      for (const helperInput of nixImageHelperInputs) {
        expect(workflow).toContain(helperInput)
      }
    }

    expect(symphonyReleaseMetadataScript).not.toContain('.github\\/workflows\\/')
    expect(symphonyReleaseMetadataScript).not.toContain('setup-nix-toolchain')
    expect(symphonyReleaseMetadataScript).not.toContain('nix\\/oci-release-contract\\.sh')
    for (const helperInput of nixImageHelperInputs) {
      expect(symphonyReleaseMetadataScript).toContain(helperInput.replaceAll('/', '\\/').replaceAll('.', '\\.'))
    }

    expect(jangarReleaseMetadataScript).not.toContain('.github\\/workflows\\/')
    expect(jangarReleaseMetadataScript).not.toContain('setup-nix-toolchain')
    expect(jangarReleaseMetadataScript).not.toContain('packages\\/scripts\\/src\\/jangar')
    expect(jangarReleaseMetadataScript).not.toContain('packages\\/scripts\\/src\\/shared')
    expect(jangarReleaseMetadataScript).not.toContain('nix\\/oci-release-contract\\.sh')
    expect(jangarReleaseMetadataScript).toContain('images\\/jangar\\.nix')
    for (const helperInput of nixImageHelperInputs) {
      expect(jangarReleaseMetadataScript).toContain(helperInput.replaceAll('/', '\\/').replaceAll('.', '\\.'))
    }
  })

  it('uses the published full-SHA tag for manual Nix image promotions', () => {
    expect(jangarReleaseMetadataScript).toContain('`sha-${sourceSha}`')
    expect(jangarReleaseMetadataScript).not.toContain('sourceSha.slice(0, 8)')
    expect(symphonyReleaseMetadataScript).toContain('`sha-${sourceSha}`')
    expect(symphonyReleaseMetadataScript).not.toContain('sourceSha.slice(0, 8)')
    for (const workflow of [
      torghutReleaseWorkflow,
      torghutTaReleaseWorkflow,
      torghutWsReleaseWorkflow,
      torghutHyperliquidFeedReleaseWorkflow,
    ]) {
      expect(workflow).toContain('TAG="sha-${SOURCE_SHA}"')
      expect(workflow).not.toContain('git rev-parse --short=8')
    }
    expect(atticReleaseMetadataScript).toContain('tag="sha-${source_sha}"')
    expect(atticReleaseMetadataScript).not.toContain('git rev-parse --short=12')
  })

  it('does not fan out migrated image builds on workflow-only changes', () => {
    const migratedImageWorkflows = [
      atticWorkflow,
      arcRunnerBuildWorkflow,
      oiratWorkflow,
      bumbaWorkflow,
      froussardWorkflow,
      productNixWorkflow,
      agentsBuildWorkflow,
      jangarBuildWorkflow,
      symphonyBuildWorkflow,
      sagBuildWorkflow,
      torghutBuildWorkflow,
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
    expect(agentsCiWorkflow).toContain("- 'packages/scripts/src/shared/nix-oci-deploy.ts'")
    expect(symphonyCiWorkflow).not.toContain("- 'packages/scripts/src/shared/nix-oci-deploy.ts'")
    expect(torghutCiWorkflow).not.toContain("- 'packages/scripts/src/shared/nix-oci-deploy.ts'")
    expect(agentsCiWorkflow).not.toContain("- 'package.json'")
    expect(torghutCiWorkflow).not.toContain('github/workflows/torghut-')
    expect(torghutCiWorkflow).not.toContain("- 'packages/scripts/src/shared/oci-digest.ts'")
  })

  it('runs Symphony deployment convergence regressions in service CI', () => {
    expect(symphonyCiWorkflow).toContain('packages/scripts/src/symphony/verify-deployment.test.ts')
  })

  it('does not fan out migrated image builds on unrelated flake attr changes', () => {
    for (const workflow of [
      atticWorkflow,
      oiratWorkflow,
      bumbaWorkflow,
      froussardWorkflow,
      productNixWorkflow,
      agentsBuildWorkflow,
      jangarBuildWorkflow,
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
      agentsBuildWorkflow,
      jangarBuildWorkflow,
      sagBuildWorkflow,
    ]) {
      expect(workflow).not.toContain("- 'flake.lock'")
      expect(workflow).not.toContain("- 'nix/images/bun-workspace-service.nix'")
    }
    expect(atticWorkflow).not.toContain("- 'flake.lock'")
    expect(atticWorkflow).toContain("- 'nix/images/attic.nix'")
    expect(productNixWorkflow).not.toContain("- 'flake.nix'")
    expect(productNixWorkflow).toContain("- 'flake.lock'")
    expect(productNixWorkflow).toContain("- 'nix/images/bun-workspace-service.nix'")
    expect(headlampWorkflow).not.toContain("- 'flake.nix'")
    expect(headlampReleaseWorkflow).toContain('flake.nix')
  })

  it('validates Bumba pull requests when the Temporal SDK changes', () => {
    const pullRequestTrigger = bumbaWorkflow.match(/\n  pull_request:\n([\s\S]*?)\n  workflow_dispatch:/)?.[1]
    expect(pullRequestTrigger).toContain("- 'packages/temporal-bun-sdk/**'")
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
    expect(ociPushScript).toContain('skopeo --policy "${policy_json}" copy')
  })

  it('serializes layer uploads against the shaped registry writer', () => {
    expect(ociPushScript).toContain('--image-parallel-copies 1 --format oci')
  })

  it('precomputes destination digests to avoid redundant registry writes', () => {
    expect(ociPushScript).toContain('copy --dest-precompute-digests')
  })

  it('tags platform latest refs without re-copying image layers', () => {
    expect(ociPushScript).toContain('crane tag "${reference}" "${latest_tag}"')
    expect(ociPushScript).not.toContain(
      'skopeo --policy "${policy_json}" copy --dest-precompute-digests --image-parallel-copies 1 --format oci "docker://${reference}"',
    )
  })

  it('does not use Docker Buildx or docker daemon commands in migrated workflows', () => {
    const migratedWorkflows = [
      atticWorkflow,
      nixOciWorkflow,
      arcRunnerBuildWorkflow,
      arcRunnerReleaseWorkflow,
      oiratWorkflow,
      bumbaWorkflow,
      froussardWorkflow,
      productNixWorkflow,
      enabledProductReleaseWorkflow,
      agentsBuildWorkflow,
      jangarBuildWorkflow,
      jangarReleaseWorkflow,
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
    expect(flake).toContain('"arc-runner-image"')
    expect(flake).toContain('"oirat-image"')
    expect(flake).toContain('"bumba-image"')
    expect(flake).toContain('"froussard-image"')
    expect(flake).toContain('"headlamp-image"')
    expect(repoFileExists('nix/images/oirat.nix')).toBe(true)
    expect(repoFileExists('nix/images/bumba.nix')).toBe(true)
    expect(repoFileExists('nix/images/froussard.nix')).toBe(true)
    expect(repoFileExists('nix/images/headlamp.nix')).toBe(true)

    for (const [workflow, imageName, packageAttr, artifact] of [
      [oiratWorkflow, 'oirat', 'oirat-image', 'oirat-release-contract'],
      [bumbaWorkflow, 'bumba', 'bumba-image', 'bumba-release-contract'],
      [froussardWorkflow, 'froussard', 'froussard-image', 'froussard-release-contract'],
      [headlampWorkflow, 'headlamp', 'headlamp-image', 'headlamp-release-contract'],
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
    expect(nixOciWorkflow).toContain('name: Warm Nix image archive output in Attic')
    expect(nixOciWorkflow).toContain('publish-index:')

    for (const [workflow, artifact] of [
      [oiratWorkflow, 'oirat-release-contract'],
      [bumbaWorkflow, 'bumba-release-contract'],
      [froussardWorkflow, 'froussard-release-contract'],
      [sagBuildWorkflow, 'sag-release-contract'],
      [symphonyBuildWorkflow, 'symphony-release-contract'],
      [jangarBuildWorkflow, 'jangar-release-contract'],
      [torghutBuildWorkflow, 'torghut-release-contract'],
      [torghutTaBuildWorkflow, 'torghut-ta-release-contract'],
      [torghutWsBuildWorkflow, 'torghut-ws-release-contract'],
      [torghutHyperliquidFeedBuildWorkflow, 'torghut-hyperliquid-feed-release-contract'],
      [headlampWorkflow, 'headlamp-release-contract'],
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

  it('routes the enabled Headlamp image through a real Nix OCI attr', () => {
    expect(flake).toContain('"headlamp-image"')
    expect(repoFileExists('nix/images/headlamp.nix')).toBe(true)
    expect(headlampImageModule).toContain('pkgs.fetchFromGitHub')
    expect(headlampImageModule).toContain('rev = headlampSha')
    expect(headlampImageModule).toContain('pkgs.buildGoModule')
    expect(headlampImageModule).toContain('buildNpmPackage')
    expect(headlampImageModule).toContain('pkgs.dockerTools.buildLayeredImage')
    expect(headlampImageModule).toContain('REACT_APP_ENABLE_WEBSOCKET_MULTIPLEXER')
    expect(headlampImageModule).toContain('"HEADLAMP_STATIC_PLUGINS_DIR=/headlamp/static-plugins"')
    expect(headlampImageModule).toContain('"HOME=/tmp"')
    expect(headlampImageModule).toContain('etc/ssl/certs/ca-certificates.crt')
    expect(headlampImageModule).toContain('export HOME="$TMPDIR/home"')
    expect(headlampImageModule).toContain('0004-static-copy-writable.patch')
    expect(headlampStaticCopyPatch).toContain('func makeStaticIndexWritable(staticDir string) error')
    expect(headlampStaticCopyPatch).toContain('os.Remove(indexPath)')
    expect(headlampStaticCopyPatch).toContain('os.WriteFile(indexPath, data, fs.FileMode(0o600))')
    expect(headlampStaticCopyPatch).not.toContain('filepath.WalkDir')
    expect(headlampStaticCopyPatch).not.toContain('os.Chmod')
    expect(headlampImageModule).toContain('cp main.js package.json "$out/static-plugins/prometheus/"')
    expect(headlampImageModule).not.toContain('chmod -R u+w "$out/headlamp/frontend"')
    expect(headlampImageModule).not.toContain('find "$out/headlamp/frontend" -type d -exec chmod 0777 {} +')
    expect(headlampImageModule).not.toContain('find "$out/headlamp/frontend" -type f -exec chmod 0666 {} +')
    expect(headlampImageModule).not.toContain('cp prometheus/main.js prometheus/package.json')
    expect(headlampImageModule).not.toContain('created = "now"')
    expect(headlampImageModule).not.toContain('docker build')
    expect(headlampValues).toContain('name: headlamp-tmp')
    expect(headlampValues).toContain('mountPath: /tmp')
    expect(headlampValues).toContain('emptyDir: {}')

    expect(headlampWorkflow).toContain('uses: ./.github/workflows/nix-oci-build-common.yml')
    expect(headlampWorkflow).toContain('image_name: headlamp')
    expect(headlampWorkflow).toContain('package_attr: headlamp-image')
    expect(headlampWorkflow).toContain('headlamp-release-contract')
    expect(headlampWorkflow).toContain('tag: sha-${{ github.sha }}')
    expect(headlampWorkflow).toContain('image_build_timeout: 20m')
    expect(headlampWorkflow).toContain('sh services/headlamp/scripts/test-upstream.sh')
    expect(headlampWorkflow).not.toContain('docker/build-push-action')
    expect(headlampWorkflow).not.toContain('docker/setup-buildx-action')
    expect(headlampWorkflow).not.toContain('docker buildx')
    expect(headlampWorkflow).not.toContain('docker run')
    expect(headlampWorkflow).not.toContain('docker push')

    expect(headlampReleaseWorkflow).toContain('headlamp-release-contract')
    expect(headlampReleaseWorkflow).toContain('argocd/applications/headlamp/values.yaml')
    expect(headlampReleaseWorkflow).toContain('nix run .#assert-oci-platforms -- "${IMAGE}@${DIGEST}"')
    expect(headlampReleaseWorkflow).toContain('repository: lab/headlamp@sha256')
    expect(headlampReleaseWorkflow).toContain('peter-evans/create-pull-request@v7')
    expect(headlampReleaseWorkflow).not.toContain('docker buildx')
    expect(headlampReleaseWorkflow).not.toContain('docker/setup-buildx-action')
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
    expect(sagPostDeployVerifyWorkflow).toContain('Determine Sag ApplicationSet state')
    expect(sagPostDeployVerifyWorkflow).toContain('argocd/applicationsets/product.yaml')
    expect(sagPostDeployVerifyWorkflow).toContain("if: steps.sag.outputs.enabled == 'true'")
    expect(sagPostDeployVerifyWorkflow).toContain(
      'Sag is disabled in the product ApplicationSet; post-deploy verification is not applicable.',
    )
    expect(sagPostDeployVerifyWorkflow).toContain('kubectl -n sag rollout status deployment/sag')
    expect(sagPostDeployVerifyWorkflow).toContain('desired_replicas=')
    expect(sagPostDeployVerifyWorkflow).toContain(
      'Sag desired replicas is 0; runtime rollout smoke is intentionally skipped',
    )
    expect(sagPostDeployVerifyWorkflow).toContain('Sag deployment image does not contain expected digest')
    expect(sagPostDeployVerifyWorkflow).toContain('get application sag -o json 2>')
    expect(sagPostDeployVerifyWorkflow).toContain('Sag Argo application is not readable yet; retrying.')
    expect(sagPostDeployVerifyWorkflow).toContain('jq -e . >/dev/null 2>&1')
  })

  it('routes the enabled Jangar image through a real Nix OCI attr', () => {
    expect(flake).toContain('"jangar-image"')
    expect(repoFileExists('nix/images/jangar.nix')).toBe(true)
    expect(jangarImageModule).toContain('dependencyClosure = "bunCache";')
    expect(jangarImageModule).toContain('"@proompteng/jangar"')
    expect(jangarImageModule).toContain('"@proompteng/cx-tools"')
    expect(jangarImageModule).toContain(
      'for package in agent-contracts codex cx-tools design discord otel temporal-bun-sdk',
    )
    expect(jangarImageModule).toContain('cp -R "$TMPDIR/work/services/jangar/node_modules"')
    expect(jangarImageModule).toContain('node-gyp rebuild')
    expect(jangarImageModule).toContain('test -f build/Release/pty.node')
    expect(jangarImageModule).toContain('rm -rf build')
    expect(jangarImageModule).toContain('node-pty native module missing from runtime node_modules')
    expect(jangarImageModule).toContain(
      'cp -R "$node_pty_dir/build" "$out/app/services/jangar/.output/server/node_modules/node-pty/build"',
    )
    expect(jangarImageModule).toContain('import ./openai-codex-cli.nix')
    expect(jangarImageModule).toContain('openvscode-server')
    expect(jangarImageModule).toContain('import ./bun-workspace-service.nix')
    expect(jangarImageModule).not.toContain('created = "now"')
    expect(jangarImageModule).not.toContain('docker build')

    expect(jangarBuildWorkflow).toContain('uses: ./.github/workflows/nix-oci-build-common.yml')
    expect(jangarBuildWorkflow).toContain('image_name: jangar')
    expect(jangarBuildWorkflow).toContain('package_attr: jangar-image')
    expect(jangarBuildWorkflow).toContain('jangar-release-contract')
    expect(jangarBuildWorkflow).toContain('tag: sha-${{ github.sha }}')
    expect(jangarBuildWorkflow).toContain('image_build_timeout: 12m')
    expect(jangarBuildWorkflow).not.toContain('oven-sh/setup-bun')
    expect(jangarBuildWorkflow).not.toContain('docker/setup-buildx-action')

    expect(jangarReleaseWorkflow).toContain('uses: ./.github/actions/setup-nix-toolchain')
    expect(jangarReleaseWorkflow).toContain('crane digest "${IMAGE_NAME}:${IMAGE_TAG}"')
    expect(jangarReleaseWorkflow).toContain('nix run .#assert-oci-platforms -- "${IMAGE}@${DIGEST}"')
    expect(jangarReleaseWorkflow).toContain(`source_ci_run_id:
        description: Successful jangar-build-push run ID that produced the image
        required: true`)
    expect(jangarReleaseWorkflow).toContain(
      'JANGAR_SOURCE_CI_RUN_ID: ${{ github.event.workflow_run.id || inputs.source_ci_run_id }}',
    )
    expect(jangarReleaseWorkflow).toContain(
      '- Source CI run: `${{ github.event.workflow_run.id || inputs.source_ci_run_id }}`',
    )
    expect(jangarReleaseWorkflow).not.toContain('JANGAR_SOURCE_CI_RUN_ID: ${{ github.run_id }}')
    expect(jangarReleaseWorkflow).not.toContain('docker buildx')
    expect(jangarReleaseWorkflow).not.toContain('docker/setup-buildx-action')
  })

  it('keeps Jangar post-deploy verification observe-only without rollback PR automation', () => {
    expect(jangarPostDeployVerifyWorkflow).toContain('name: jangar-post-deploy-verify')
    expect(jangarPostDeployVerifyWorkflow).toContain('contents: read')
    expect(jangarPostDeployVerifyWorkflow).toContain('Verify deployment health and digest')
    expect(jangarPostDeployVerifyWorkflow).toContain('Sync Temporal routing after rollout')
    expect(jangarPostDeployVerifyWorkflow).toContain('--allow-no-versioned-pollers')
    expect(jangarPostDeployVerifyWorkflow).toContain('bun install --frozen-lockfile --ignore-scripts')
    expect(jangarPostDeployVerifyWorkflow).toContain('--filter @proompteng/scripts')
    expect(jangarPostDeployVerifyWorkflow).toContain('--filter @proompteng/temporal-bun-sdk')
    expect(jangarPostDeployVerifyWorkflow).toContain('bun run --filter @proompteng/temporal-bun-sdk build')
    expect(jangarPostDeployVerifyWorkflow.indexOf('Install Temporal routing dependencies')).toBeLessThan(
      jangarPostDeployVerifyWorkflow.indexOf('Sync Temporal routing after rollout'),
    )
    expect(jangarPostDeployVerifyWorkflow).not.toContain('contents: write')
    expect(jangarPostDeployVerifyWorkflow).not.toContain('pull-requests: write')
    expect(jangarPostDeployVerifyWorkflow).not.toContain('Prepare rollback manifests')
    expect(jangarPostDeployVerifyWorkflow).not.toContain('Open rollback pull request')
    expect(jangarPostDeployVerifyWorkflow).not.toContain('peter-evans/create-pull-request')
    expect(jangarPostDeployVerifyWorkflow).not.toContain('codex/jangar-rollback')
    expect(jangarPostDeployVerifyWorkflow).not.toContain('rollback(jangar)')
  })

  it('routes the enabled Torghut family images through real Nix OCI attrs', () => {
    expect(torghutReleaseWorkflow).toContain("TORGHUT_INCLUDE_OPTIONS_MANIFESTS: 'true'")
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
    const torghutRuntimeContents = expectNixListBlock(torghutImageModule, 'contents')
    const torghutRuntimePath = expectNixMakeBinPathBlock(torghutImageModule, 'runtimePath')
    expect(torghutImageModule).toContain('pkgs.uv')
    expect(torghutRuntimeContents).toContain('pkgs.bash')
    expect(torghutRuntimePath).toContain('pkgs.bash')
    expect(torghutImageModule).toContain('pkgs.stdenv.cc.cc.lib')
    expect(torghutImageModule).toContain('"LD_LIBRARY_PATH=${runtimeLibraryPath}"')
    expect(torghutImageModule).toContain('"PYTHONPATH=/app"')
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
      ['agents-codex-runner', 'agents-codex-runner-image', 'agents-codex-runner-release-contract'],
    ] as const) {
      expect(agentsImageModule).toContain(`"${packageAttr}"`)
      expect(agentsBuildWorkflow).toContain(`image_name: ${imageName}`)
      expect(agentsBuildWorkflow).toContain(`package_attr: ${packageAttr}`)
      expect(agentsBuildWorkflow).toContain(artifact)
    }

    expect(flake).toContain('import ./nix/images/agents.nix')
    expect(agentsImageModule).toContain('import ./openai-codex-cli.nix')
    expect(agentsImageModule).toContain('"agents-codex-runner-image"')
    expect(agentsImageModule).toContain('pname = "alpaca-mcp-server";')
    expect(agentsImageModule).toContain('version = "2.0.1";')
    expect(agentsImageModule).toContain('pname = "fastmcp";')
    expect(agentsImageModule).toContain('version = "2.13.2";')
    expect(agentsImageModule).toContain('pname = "mcp";')
    expect(agentsImageModule).toContain('version = "1.19.0";')
    expect(agentsImageModule).toContain('pname = "beartype";')
    expect(agentsImageModule).toContain('version = "0.22.2";')
    expect(agentsImageModule).toContain('pname = "alpaca-py";')
    expect(agentsImageModule).toContain('pname = "pandas-ta-classic";')
    expect(agentsImageModule).toContain('pythonPackages.buildPythonPackage')
    expect(agentsBuildWorkflow).toContain('uses: ./.github/workflows/nix-oci-build-common.yml')
    expect(agentsBuildWorkflow).toContain('tag: sha-${{ github.sha }}')
    expect(agentsBuildWorkflow).not.toContain('Resolve preserved runner image pin')
    expect(agentsBuildWorkflow).toContain('--runner-tag "${TAG}"')
    expect(agentsBuildWorkflow).toContain('--runner-repository registry.ide-newton.ts.net/lab/agents-codex-runner')
    expect(agentsBuildWorkflow).toContain("'charts/agents/crds/**'")
    expect(agentsBuildWorkflow).not.toContain("'charts/agents/**'")
    expect(agentsBuildWorkflow).not.toContain("'argocd/applications/agents/**'")
    expect(agentsBuildWorkflow).toContain("'packages/scripts/src/agents/update-values.ts'")
    expect(agentsBuildWorkflow).not.toContain("'packages/scripts/src/agents/**'")
    for (const runtimePackage of ['agent-contracts', 'codex', 'cx-tools', 'otel', 'temporal-bun-sdk']) {
      expect(agentsBuildWorkflow).toContain(`'packages/${runtimePackage}/**'`)
    }
    expect(agentsBuildWorkflow).toContain("'!**/*.test.ts'")
    expect(agentsBuildWorkflow).toContain("'!**/*.spec.ts'")
    expect(agentsBuildWorkflow).toContain("'!**/*.md'")
    expect(agentsBuildWorkflow).not.toContain('oven-sh/setup-bun')
    expect(agentsBuildWorkflow).not.toContain('docker/setup-buildx-action')
    expect(agentsBuildWorkflow).not.toContain('docker buildx')

    expect(agentsImageModule).toContain('dependencyClosure = "bunCache";')
    expect(agentsImageModule).toContain('agentsRuntimeRoot = import ./bun-workspace-service.nix')
    expect(agentsImageModule).toContain('returnRuntimeRoot = true;')
    expect(agentsImageModule).toContain('runtimeRoot = agentsRuntimeRoot;')
    expect(agentsImageModule).toContain('runtimeSourceFilter = rel: _type:')
    expect(agentsImageModule).toContain('sourcePaths = runnerSourcePaths;')
    expect(agentsImageModule).toContain('buildCommands = runnerBuildCommands;')
    expect(agentsImageModule).toContain('lib.hasSuffix ".test.ts" rel')
    expect(agentsImageModule).toContain('lib.hasSuffix ".md" rel')
    expect(agentsImageModule).toContain('"@proompteng/agents"')
    expect(agentsImageModule).toContain('"@proompteng/cx-tools"')
    expect(agentsImageModule).toContain('"charts/agents/crds"')
    expect(agentsImageModule).toContain('"agents-controller-image"')
    expect(agentsImageModule).toContain('"agents-control-plane-image"')
    expect(agentsImageModule).toContain('"agents-shell-image"')
    expect(agentsImageModule).toContain('"agents-codex-runner-image"')
    expect(agentsImageModule).toContain('"$out/workspace"')
    expect(agentsImageModule).toContain('#!${pkgs.bash}/bin/bash')
    expect(agentsImageModule).not.toContain('#!/usr/bin/env bash')
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
    ] as const) {
      expect(flake).toContain(`"${packageAttr}"`)
      expect(repoFileExists(`nix/images/${service}.nix`)).toBe(true)
      expect(productNixWorkflow).toContain(`image_name: ${service}`)
      expect(productNixWorkflow).toContain(`package_attr: ${packageAttr}`)
      expect(productNixWorkflow).toContain(`${service}-release-contract`)
    }

    expect(productNixWorkflow).toContain('uses: ./.github/workflows/nix-oci-build-common.yml')
    expect(productNixWorkflow).toContain('tag: sha-${{ github.sha }}')
    expect(productNixWorkflow.match(/- 'packages\/design\/\*\*'/g)).toHaveLength(5)
    expect(flake).toContain('"olden-image"')
    expect(repoFileExists('nix/images/olden.nix')).toBe(true)
    expect(productNixWorkflow).not.toContain('image_name: olden')
    expect(productNixWorkflow).not.toContain('build_olden')
    expect(productNixWorkflow).not.toContain("'apps/olden/**'")
    expect(productNixWorkflow).not.toContain("'nix/images/olden.nix'")
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
    expect(headlampWorkflow).not.toContain("'argocd/applications/headlamp/**'")
    expect(enabledSimpleReleaseWorkflow).not.toContain('packages/scripts/src/oirat argocd/applications/oirat')
    expect(enabledSimpleReleaseWorkflow).not.toContain('packages/scripts/src/bumba argocd/applications/bumba')
    expect(enabledSimpleReleaseWorkflow).not.toContain('packages/scripts/src/froussard argocd/applications/froussard')
  })

  it('keeps manual migrated app deploy scripts on the shared Nix image helper', () => {
    for (const script of [
      arcRunnerBuildScript,
      oiratBuildScript,
      bumbaBuildScript,
      atticBuildScript,
      froussardBuildScript,
      headlampBuildScript,
      symphonyBuildScript,
      sagBuildScript,
      jangarBuildScript,
      agentsBuildScript,
      agentsDeployScript,
      torghutImageBuildersScript,
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
    expect(atticDeployScript).not.toContain("from '../shared/docker'")
    expect(atticDeployScript).not.toContain('inspectImageDigest')
    expect(atticDeployScript).toContain("from './build-image'")
    expect(atticDeployScript).toContain('dryRun')
    expect(atticDeployScript).toContain('no-apply')
    expect(atticDeployScript).toContain('@sha256:<64 hex>')
    expect(atticDeployScript).toContain('Non-dry attic:deploy requires --image-digest')
    expect(atticDeployScript).toContain('assertDeployImagePlatforms(imageDigest)')
    expect(atticDeployScript).toContain('gc-cronjob.yaml')
    expect(arcRunnerDeployScript).not.toContain("from '../shared/docker'")
    expect(arcRunnerDeployScript).not.toContain('inspectImageDigest')
    expect(arcRunnerDeployScript).toContain("from './build-image'")
    expect(arcRunnerDeployScript).toContain('dryRun')
    expect(arcRunnerDeployScript).toContain('no-apply')
    expect(arcRunnerDeployScript).toContain('registry.ide-newton.ts.net/lab/arc-runner@sha256:<64 hex>')
    expect(arcRunnerDeployScript).toContain('image: docker:dind')
    expect(froussardDeployScript).not.toContain("from '../shared/docker'")
    expect(froussardDeployScript).not.toContain('buildAndPushDockerImage')
    expect(froussardDeployScript).not.toContain('inspectImageDigest')
    expect(froussardDeployScript).toContain("from './build-image'")
    expect(headlampDeployScript).not.toContain("from '../shared/docker'")
    expect(headlampDeployScript).not.toContain('inspectImageDigest')
    expect(headlampDeployScript).toContain("from './build-image'")
    expect(headlampDeployScript).toContain('dryRun')
    expect(headlampDeployScript).toContain('no-apply')
    expect(headlampDeployScript).toContain('registry.ide-newton.ts.net/lab/headlamp@sha256:<64 hex>')
    expect(headlampDeployScript).toContain('values.yaml')
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
    expect(jangarDeployScript).not.toContain("from '../shared/docker'")
    expect(jangarDeployScript).not.toContain('inspectImageDigest')
    expect(jangarDeployScript).toContain('dryRun')
    expect(jangarDeployScript).toContain('noApply')
    expect(jangarDeployScript).toContain('digest:')
    expect(jangarUpdateScript).not.toContain("from '../shared/docker'")
    expect(jangarUpdateScript).not.toContain('inspectImageDigest')
    expect(jangarUpdateScript).toContain('requireDigest')
    expect(agentsDeployScript).not.toContain("from '../shared/docker'")
    expect(agentsDeployScript).not.toContain('inspectImageDigest')
    expect(agentsDeployScript).toContain("from '../shared/nix-oci-deploy'")
    expect(agentsDeployScript).toContain('dryRun')
    expect(agentsDeployScript).toContain('runnerRepository')
    expect(agentsDeployScript).toContain('agents-codex-runner-image')
    expect(agentsDeployScript).not.toContain('readRunnerImagePin')
    expect(torghutBuildScript).toContain("from './image-builders'")
    expect(torghutWsBuildScript).toContain("from './image-builders'")
    expect(torghutWsBuildScript).toContain("buildTorghutImage('ws'")
    expect(torghutTaBuildScript).toContain("from './image-builders'")
    expect(torghutTaBuildScript).toContain("buildTorghutImage('ta'")
    expect(torghutHyperliquidFeedBuildScript).toContain("from './image-builders'")
    expect(torghutHyperliquidFeedBuildScript).toContain("buildTorghutImage('hyperliquid-feed'")
    expect(torghutDeployScript).not.toContain("from '../shared/docker'")
    expect(torghutDeployScript).not.toContain('buildAndPushDockerImage')
    expect(torghutDeployScript).not.toContain("from '../shared/nix-oci-deploy'")
    expect(torghutDeployScript).toContain("from './build-image'")
    expect(torghutDeployScript).toContain("from './build-ws-image'")
    expect(torghutDeployScript).toContain("from './build-ta-image'")
    expect(torghutTaDeployScript).not.toContain("from '../shared/docker'")
    expect(torghutTaDeployScript).not.toContain('buildAndPushDockerImage')
    expect(torghutTaDeployScript).not.toContain("from '../shared/nix-oci-deploy'")
    expect(torghutTaDeployScript).toContain("from './build-ta-image'")

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
    expect(nixOciDeployScript).toContain('collectLockfileHashes')
    expect(nixOciDeployScript).toContain('collectToolVersions')
    expect(nixOciPlanScript).toContain('Nix OCI image pushes must stay in')
  })

  it('opens digest-pinning release PRs for enabled simple app Nix builds', () => {
    expect(enabledSimpleReleaseWorkflow).toContain('workflows:')
    expect(enabledSimpleReleaseWorkflow).toContain('- oirat')
    expect(enabledSimpleReleaseWorkflow).toContain('- bumba')
    expect(enabledSimpleReleaseWorkflow).toContain('- froussard')
    expect(enabledSimpleReleaseWorkflow).toContain('nix run .#assert-oci-platforms -- "${IMAGE}@${DIGEST}"')
    expect(enabledSimpleReleaseWorkflow).toContain('service build inputs changed after source commit')
    for (const [workflow, sharedPath] of [
      [oiratWorkflow, "'packages/discord/**'"],
      [bumbaWorkflow, "'packages/temporal-bun-sdk/**'"],
      [froussardWorkflow, "'packages/codex/**'"],
      [froussardWorkflow, "'packages/discord/**'"],
      [froussardWorkflow, "'packages/otel/**'"],
    ]) {
      expect(workflow).toContain(sharedPath)
    }
    expect(froussardWorkflow).toContain("'packages/agent-contracts/**'")
    expect(enabledSimpleReleaseWorkflow).toContain('argocd/applications/oirat/kustomization.yaml')
    expect(enabledSimpleReleaseWorkflow).toContain('argocd/applications/bumba/kustomization.yaml')
    expect(enabledSimpleReleaseWorkflow).toContain('argocd/applications/bumba/deployment.yaml')
    expect(enabledSimpleReleaseWorkflow).toContain('TEMPORAL_WORKER_BUILD_ID')
    expect(enabledSimpleReleaseWorkflow).toContain('build_id="bumba@${SOURCE_SHA}"')
    expect(enabledSimpleReleaseWorkflow).toContain('BUILD_ID="${build_id}" perl')
    expect(enabledSimpleReleaseWorkflow).toContain('value: ${build_id}')
    expect(enabledSimpleReleaseWorkflow).toContain('argocd/applications/froussard/knative-service.yaml')
    expect(enabledSimpleReleaseWorkflow).toContain('\\@sha256:[0-9a-f]{64}')
    expect(enabledSimpleReleaseWorkflow).toContain('peter-evans/create-pull-request@v7')
    expect(enabledSimpleReleaseWorkflow).not.toContain('docker buildx')
  })

  it('keeps Bumba image content independent from GitOps-only release commits', () => {
    const bumbaFlakeBlock = flake.match(
      /"bumba-image"\s*=\s*import \.\/nix\/images\/bumba\.nix \{([\s\S]*?)\n\s*\};/m,
    )?.[1]

    expect(bumbaImageModule).not.toContain('repoRevision')
    expect(bumbaImageModule).not.toContain('TEMPORAL_WORKER_BUILD_ID')
    expect(bumbaFlakeBlock).toBeDefined()
    expect(bumbaFlakeBlock).not.toContain('repoRevision')
    expect(readRepoFile('argocd/applications/bumba/deployment.yaml')).toContain('TEMPORAL_WORKER_BUILD_ID')
  })

  it('keeps Bumba release ownership out of Argo CD Image Updater', () => {
    expect(productImageUpdater).not.toContain('namePattern: bumba')
    expect(productImageUpdater).not.toContain('writeBackTarget: kustomization:/argocd/applications/bumba')
    expect(productImageUpdater).not.toContain('imageName: registry.ide-newton.ts.net/lab/bumba:latest')
    expect(enabledSimpleReleaseWorkflow).toContain('- bumba')
    expect(enabledSimpleReleaseWorkflow).toContain('argocd/applications/bumba/kustomization.yaml')
  })

  it('opens digest-pinning release PRs for enabled product app Nix builds', () => {
    expect(enabledProductReleaseWorkflow).toContain('workflows:')
    expect(enabledProductReleaseWorkflow).toContain('- product-nix-images')
    for (const service of ['proompteng', 'app', 'synthesis', 'docs']) {
      expect(enabledProductReleaseWorkflow).toContain(`argocd/applications/${service}/kustomization.yaml`)
    }
    expect(enabledProductReleaseWorkflow).not.toContain('argocd/applications/olden/kustomization.yaml')
    expect(enabledProductReleaseWorkflow).not.toContain('- olden')
    expect(enabledProductReleaseWorkflow).toContain('registry.ide-newton.ts.net/lab/${SERVICE}')
    expect(enabledProductReleaseWorkflow).toContain('registry.ide-newton.ts.net/lab/${service}')
    expect(enabledProductReleaseWorkflow).toContain('${service}-image')
    expect(enabledProductReleaseWorkflow).toContain('nix run .#assert-oci-platforms -- "${image}@${digest}"')
    expect(enabledProductReleaseWorkflow).toContain('service build inputs changed after')
    for (const sharedInput of [
      'nix/images/bun-workspace-service.nix',
      'nix/packages.nix',
      'nix/cache-push.sh',
      'nix/ci-nix-oci-summary.sh',
      'nix/ci-run-timed.sh',
      'nix/oci-inspect-archive.sh',
      'nix/oci-push.sh',
      'flake.lock',
      'bun.lock',
    ]) {
      expect(productNixWorkflow.match(new RegExp(`'${escapeRegex(sharedInput)}'`, 'g'))).toHaveLength(5)
      expect(enabledProductReleaseWorkflow).toContain(sharedInput)
    }
    expect(enabledProductReleaseWorkflow).not.toContain('.github/workflows/product-nix-images.yml')
    expect(enabledProductReleaseWorkflow).not.toContain('.github/workflows/nix-oci-build-common.yml')
    expect(enabledProductReleaseWorkflow).toContain('peter-evans/create-pull-request@v7')
    expect(enabledProductReleaseWorkflow).not.toContain('packages/scripts/src/shared/nix-oci-deploy.ts')
    expect(enabledProductReleaseWorkflow).not.toContain('docker buildx')
  })

  it('blocks stale Docker-era release branches but auto-merges generated Nix OCI release PRs', () => {
    expect(autoPrReleaseBranchesWorkflow).toContain('migrated_nix_image_paths=(')
    for (const path of [
      'argocd/applications/app/kustomization.yaml',
      'argocd/applications/bumba/kustomization.yaml',
      'argocd/applications/docs/kustomization.yaml',
      'argocd/applications/headlamp/values.yaml',
      'argocd/applications/oirat/kustomization.yaml',
      'argocd/applications/proompteng/kustomization.yaml',
      'argocd/sag/kustomization.yaml',
      'argocd/applications/symphony/kustomization.yaml',
      'argocd/applications/symphony-jangar/kustomization.yaml',
      'argocd/applications/symphony-torghut/kustomization.yaml',
      'argocd/applications/synthesis/kustomization.yaml',
    ]) {
      expect(autoPrReleaseBranchesWorkflow).toContain(`"${path}"`)
    }
    expect(autoPrReleaseBranchesWorkflow).toContain('reason="migrated-nix-image-app:${path}"')
    expect(autoPrReleaseBranchesWorkflow).toContain('disabled_image_paths=(')
    expect(autoPrReleaseBranchesWorkflow).toContain('"argocd/applications/olden/kustomization.yaml"')
    expect(autoPrReleaseBranchesWorkflow).toContain('reason="disabled-image-app:${path}"')
    expect(releasePrAutomergeWorkflow).toContain('nix_oci_release_paths=(')
    expect(releasePrAutomergeWorkflow).toContain("contains(github.event.pull_request.head.ref, '-nix-release-')")
    expect(releasePrAutomergeWorkflow).toContain("contains(github.event.pull_request.head.ref, '-release-')")
    for (const path of [
      'argocd/applications/arc/application.yaml',
      'argocd/applications/app/kustomization.yaml',
      'argocd/applications/attic/deployment.yaml',
      'argocd/applications/attic/gc-cronjob.yaml',
      'argocd/applications/bumba/deployment.yaml',
      'argocd/applications/bumba/kustomization.yaml',
      'argocd/applications/docs/kustomization.yaml',
      'argocd/applications/froussard/knative-service.yaml',
      'argocd/applications/headlamp/values.yaml',
      'argocd/applications/oirat/kustomization.yaml',
      'argocd/applications/proompteng/kustomization.yaml',
      'argocd/applications/synthesis/kustomization.yaml',
    ]) {
      expect(releasePrAutomergeWorkflow).toContain(`"${path}"`)
    }
    expect(releasePrAutomergeWorkflow).not.toContain('argocd/applications/olden/kustomization.yaml')
    expect(releasePrAutomergeWorkflow).toContain(
      '[[ "$PR_HEAD_REF" =~ ^codex/(attic|arc-runner)-release-sha-[0-9a-f]{40}$ ]]',
    )
    expect(releasePrAutomergeWorkflow).toContain(
      '[[ "$PR_HEAD_REF" =~ ^codex/(headlamp|oirat|bumba|froussard)-nix-release-sha-[0-9a-f]{40}$ ]]',
    )
    expect(releasePrAutomergeWorkflow).toContain('[[ "$PR_HEAD_REF" =~ ^codex/product-nix-release-[0-9a-f]{40}$ ]]')
    expect(releasePrAutomergeWorkflow).toContain('for required_label in automated-pr nix-oci')
    expect(releasePrAutomergeWorkflow).toContain('[[ "$PR_AUTHOR" != "gregkonush" ]]')
    expect(releasePrAutomergeWorkflow).toContain('commit_committer_login')
    expect(releasePrAutomergeWorkflow).toContain('commit_committer_email')
    expect(releasePrAutomergeWorkflow).toContain('reason=human-authored-release-pr')
    expect(releasePrAutomergeWorkflow).not.toContain(
      'allowed_authors=("app/github-actions" "github-actions[bot]" "gregkonush")',
    )
    expect(releasePrAutomergeWorkflow).toContain('set_output "head_sha=${PR_HEAD_SHA}"')
    expect(releasePrAutomergeWorkflow).toContain('PR_HEAD_SHA: ${{ steps.gates.outputs.head_sha }}')
    expect(releasePrAutomergeWorkflow).toContain('--match-head-commit "$PR_HEAD_SHA"')
    expect(releasePrAutomergeWorkflow).not.toContain('current_head_sha="$(gh pr view')
    expect(torghutDeployAutomergeWorkflow).toContain('--match-head-commit "${PR_HEAD_SHA}"')
    expect(releasePrAutomergeWorkflow).toContain('reason=eligible:${release_kind}')
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
    expect(atticReleaseWorkflow).toContain('nix-oci')
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
