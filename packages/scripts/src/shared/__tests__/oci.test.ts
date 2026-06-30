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
const productApplicationSet = readRepoFile('argocd/applicationsets/product.yaml')
const flake = readRepoFile('flake.nix')
const inspectOciArchiveScript = readRepoFile('nix/oci-inspect-archive.sh')
const ciRunTimedScript = readRepoFile('nix/ci-run-timed.sh')
const ciNixOciSummaryScript = readRepoFile('nix/ci-nix-oci-summary.sh')
const nixOciWorkflow = readRepoFile('.github/workflows/nix-oci-build-common.yml')
const enabledSimpleReleaseWorkflow = readRepoFile('.github/workflows/enabled-simple-nix-release.yml')
const productNixWorkflow = readRepoFile('.github/workflows/product-nix-images.yml')
const bunWorkspaceServiceModule = readRepoFile('nix/images/bun-workspace-service.nix')
const enabledProductReleaseWorkflow = readRepoFile('.github/workflows/enabled-product-nix-release.yml')
const agentsBuildWorkflow = readRepoFile('.github/workflows/agents-build-push.yml')
const jangarBuildWorkflow = readRepoFile('.github/workflows/jangar-build-push.yaml')
const symphonyBuildWorkflow = readRepoFile('.github/workflows/symphony-build-push.yaml')
const symphonyReleaseWorkflow = readRepoFile('.github/workflows/symphony-release.yml')
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
const symphonyImageModule = readRepoFile('nix/images/symphony.nix')
const oiratBuildScript = readRepoFile('packages/scripts/src/oirat/build-image.ts')
const bumbaBuildScript = readRepoFile('packages/scripts/src/bumba/build-image.ts')
const froussardDeployScript = readRepoFile('packages/scripts/src/froussard/deploy-service.ts')
const symphonyBuildScript = readRepoFile('packages/scripts/src/symphony/build-image.ts')
const symphonyDeployScript = readRepoFile('packages/scripts/src/symphony/deploy-service.ts')
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
    expect(nixOciWorkflow).toContain('nix run .#cache-push -- "${helper_paths[@]}"')
    expect(nixOciWorkflow).not.toContain('nix run .#cache-push -- "${IMAGE_TAR}"')
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

  it('does not fan out expensive image builds on unrelated shared script changes', () => {
    for (const workflow of [agentsBuildWorkflow, jangarBuildWorkflow, symphonyBuildWorkflow, productNixWorkflow]) {
      expect(workflow).not.toContain("'packages/scripts/src/shared/**'")
      expect(workflow).not.toContain('- packages/scripts/src/shared/**')
    }

    expect(productNixWorkflow).not.toContain("'nix/**'")
    for (const workflow of [agentsBuildWorkflow, jangarBuildWorkflow]) {
      expect(workflow).toContain("'packages/scripts/src/shared/cli.ts'")
      expect(workflow).toContain("'packages/scripts/src/shared/docker.ts'")
      expect(workflow).toContain("'packages/scripts/src/shared/git.ts'")
    }
    expect(symphonyBuildWorkflow).toContain("'packages/scripts/src/shared/cli.ts'")
    expect(symphonyBuildWorkflow).toContain("'packages/scripts/src/shared/git.ts'")
    expect(symphonyBuildWorkflow).toContain("'packages/scripts/src/shared/nix-oci-deploy.ts'")
    expect(symphonyBuildWorkflow).not.toContain("'packages/scripts/src/shared/docker.ts'")

    expect(productNixWorkflow).toContain("'packages/scripts/src/shared/nix-oci-deploy.ts'")
    expect(enabledProductReleaseWorkflow).not.toContain('packages/scripts/src/shared nix/images')
    expect(enabledProductReleaseWorkflow).toContain('packages/scripts/src/shared/nix-oci-deploy.ts')
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
      symphonyBuildWorkflow,
      symphonyReleaseWorkflow,
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

  it('routes the enabled Symphony fleet image through a real Nix OCI attr', () => {
    expect(flake).toContain('"symphony-image"')
    expect(repoFileExists('nix/images/symphony.nix')).toBe(true)
    expect(symphonyImageModule).toContain('pname = "openai-codex-cli"')
    expect(symphonyImageModule).toContain('version = codexVersion')
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
    expect(enabledProductReleaseWorkflow).toContain('peter-evans/create-pull-request@v7')
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
