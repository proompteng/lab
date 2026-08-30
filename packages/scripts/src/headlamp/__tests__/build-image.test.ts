import { afterEach, describe, expect, it } from 'bun:test'

import type { BuildAndPushNixImageOptions } from '../../shared/nix-oci-deploy'
import { __private, buildImage } from '../build-image'

afterEach(() => {
  __private.setBuildAndPushNixImage()
  __private.setExecGit()
})

describe('headlamp build-image helpers', () => {
  it('builds the Headlamp image through the shared Nix OCI helper', async () => {
    let captured: BuildAndPushNixImageOptions | undefined

    __private.setExecGit((args) => {
      if (args[0] === 'rev-parse' && args[1] === '--short') return 'abc1234'
      if (args[0] === 'rev-parse') return 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      throw new Error(`unexpected git command: ${args.join(' ')}`)
    })
    __private.setBuildAndPushNixImage(async (options) => {
      captured = options
      return {
        service: options.service,
        image: `${options.registry}/${options.repository}`,
        tag: options.tag ?? 'latest',
        digest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        reference: `${options.registry}/${options.repository}@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`,
        sourceSha: options.sourceSha ?? '',
        packageAttr: options.packageAttr,
        contractPath: '.artifacts/headlamp/manual-release-contract.json',
        platforms: ['linux/amd64', 'linux/arm64'],
        platformDigests: {
          'linux/amd64': 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
          'linux/arm64': 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
        },
        imageTarPath: '/nix/store/headlamp-image.tar',
      }
    })

    const result = await buildImage({
      registry: 'registry.ide-newton.ts.net',
      repository: 'lab/headlamp',
      tag: 'sha-test',
    })

    expect(captured).toMatchObject({
      service: 'headlamp',
      imageName: 'headlamp',
      packageAttr: 'headlamp-image',
      registry: 'registry.ide-newton.ts.net',
      repository: 'lab/headlamp',
      tag: 'sha-test',
      sourceSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      latestTag: 'latest',
    })
    expect(result).toEqual({
      image: 'registry.ide-newton.ts.net/lab/headlamp:sha-test',
      digest:
        'registry.ide-newton.ts.net/lab/headlamp@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      version: 'v0.40.1',
      commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    })
  })

  it('propagates dry-run mode to the Nix OCI helper', async () => {
    let captured: BuildAndPushNixImageOptions | undefined

    __private.setExecGit((args) => {
      if (args[0] === 'rev-parse' && args[1] === '--short') return 'abc1234'
      if (args[0] === 'rev-parse') return 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      throw new Error(`unexpected git command: ${args.join(' ')}`)
    })
    __private.setBuildAndPushNixImage(async (options) => {
      captured = options
      return {
        service: options.service,
        image: `${options.registry}/${options.repository}`,
        tag: options.tag ?? 'latest',
        digest: 'sha256:dry-run',
        reference: `${options.registry}/${options.repository}@sha256:dry-run`,
        sourceSha: options.sourceSha ?? '',
        packageAttr: options.packageAttr,
        contractPath: '.artifacts/headlamp/manual-release-contract.json',
        platforms: [],
        platformDigests: {},
        dryRun: true,
      }
    })

    await buildImage({ tag: 'sha-test', dryRun: true })

    expect(captured?.dryRun).toBe(true)
  })

  it('rejects Docker-only options instead of preserving a fallback path', () => {
    expect(() =>
      __private.resolveBuildConfiguration({
        dockerfile: 'Dockerfile',
        tag: 'sha-test',
        commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      }),
    ).toThrow('Headlamp Nix image builds do not accept Docker-only option(s): dockerfile')

    expect(() =>
      __private.resolveBuildConfiguration({
        context: '.',
        platforms: ['linux/amd64'],
        cacheRef: 'registry.example/cache',
        tag: 'sha-test',
        commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      }),
    ).toThrow('context, platforms, cacheRef')
  })

  it('parses manual CLI tag, registry, repository, and dry-run flags', () => {
    expect(
      __private.parseArgs([
        '--tag=sha-test',
        '--registry',
        'registry.ide-newton.ts.net',
        '--repository=lab/headlamp',
        '--dry-run',
      ]),
    ).toEqual({
      tag: 'sha-test',
      registry: 'registry.ide-newton.ts.net',
      repository: 'lab/headlamp',
      dryRun: true,
    })
  })
})
