import { afterEach, describe, expect, it } from 'bun:test'

import type { BuildAndPushNixImageOptions } from '../../shared/nix-oci-deploy'
import { __private, buildImage } from '../build-image'

afterEach(() => {
  __private.setBuildAndPushNixImage()
  __private.setExecGit()
})

describe('buildImage', () => {
  it('builds the core Torghut image through the Nix OCI helper', async () => {
    let captured: BuildAndPushNixImageOptions | undefined

    __private.setExecGit((args) => {
      if (args[0] === 'describe') return 'v0.1.0'
      if (args[0] === 'rev-parse') return '0123456789abcdef0123456789abcdef01234567'
      throw new Error(`unexpected git command: ${args.join(' ')}`)
    })
    __private.setBuildAndPushNixImage(async (options) => {
      captured = options
      return {
        service: options.service,
        image: `${options.registry}/${options.repository}`,
        tag: options.tag ?? 'latest',
        digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        reference: `${options.registry}/${options.repository}@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`,
        sourceSha: options.sourceSha ?? '',
        packageAttr: options.packageAttr,
        contractPath: '.artifacts/torghut/manual-release-contract.json',
        platforms: ['linux/amd64'],
        platformDigests: {
          'linux/amd64': 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
        imageTarPath: '/nix/store/torghut-image.tar',
      }
    })

    const result = await buildImage({
      registry: 'registry.ide-newton.ts.net',
      repository: 'lab/torghut',
      tag: '01234567',
    })

    expect(captured).toMatchObject({
      service: 'torghut',
      imageName: 'torghut',
      packageAttr: 'torghut-image',
      registry: 'registry.ide-newton.ts.net',
      repository: 'lab/torghut',
      tag: '01234567',
      sourceSha: '0123456789abcdef0123456789abcdef01234567',
      latestTag: 'latest',
    })
    expect(result).toEqual({
      image: 'registry.ide-newton.ts.net/lab/torghut:01234567',
      digest:
        'registry.ide-newton.ts.net/lab/torghut@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      version: 'v0.1.0',
      commit: '0123456789abcdef0123456789abcdef01234567',
    })
  })

  it('propagates dry-run mode to the Nix OCI helper', async () => {
    let captured: BuildAndPushNixImageOptions | undefined

    __private.setExecGit((args) => {
      if (args[0] === 'describe') return 'v0.1.0'
      if (args[0] === 'rev-parse') return '0123456789abcdef0123456789abcdef01234567'
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
        contractPath: '.artifacts/torghut/manual-release-contract.json',
        platforms: [],
        platformDigests: {},
        dryRun: true,
      }
    })

    await buildImage({ tag: '01234567', dryRun: true })

    expect(captured?.dryRun).toBe(true)
  })
})
