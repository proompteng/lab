import { afterEach, describe, expect, it } from 'bun:test'

import type { BuildAndPushNixImageOptions } from '../../shared/nix-oci-deploy'
import { buildHyperliquidFeedImage } from '../build-hyperliquid-feed-image'
import { __private, buildImage } from '../build-image'
import { buildNotebookImage } from '../build-notebook-image'
import { buildTechnicalAnalysisImage } from '../build-ta-image'
import { buildWebsocketImage } from '../build-ws-image'

afterEach(() => {
  __private.setBuildAndPushNixImage()
  __private.setExecGit()
})

describe('buildImage', () => {
  const stubGit = () => {
    __private.setExecGit((args) => {
      if (args[0] === 'describe') return 'v0.1.0'
      if (args[0] === 'rev-parse') return '0123456789abcdef0123456789abcdef01234567'
      throw new Error(`unexpected git command: ${args.join(' ')}`)
    })
  }

  const stubBuild = (capture: (options: BuildAndPushNixImageOptions) => void) => {
    __private.setBuildAndPushNixImage(async (options) => {
      capture(options)
      return {
        service: options.service,
        image: `${options.registry}/${options.repository}`,
        tag: options.tag ?? 'latest',
        digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        reference: `${options.registry}/${options.repository}@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`,
        sourceSha: options.sourceSha ?? '',
        packageAttr: options.packageAttr,
        contractPath: `.artifacts/${options.service}/manual-release-contract.json`,
        platforms: ['linux/amd64'],
        platformDigests: {
          'linux/amd64': 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
        imageTarPath: `/nix/store/${options.imageName}-image.tar`,
      }
    })
  }

  it('builds the core Torghut image through the Nix OCI helper', async () => {
    let captured: BuildAndPushNixImageOptions | undefined

    stubGit()
    stubBuild((options) => {
      captured = options
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

    stubGit()
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

  it('builds every Torghut-family image through the explicit Nix attr', async () => {
    for (const [build, expected] of [
      [
        buildImage,
        {
          service: 'torghut',
          imageName: 'torghut',
          packageAttr: 'torghut-image',
          repository: 'lab/torghut',
        },
      ],
      [
        buildWebsocketImage,
        {
          service: 'torghut-ws',
          imageName: 'torghut-ws',
          packageAttr: 'torghut-ws-image',
          repository: 'lab/torghut-ws',
        },
      ],
      [
        buildTechnicalAnalysisImage,
        {
          service: 'torghut-ta',
          imageName: 'torghut-ta',
          packageAttr: 'torghut-ta-image',
          repository: 'lab/torghut-ta',
        },
      ],
      [
        buildHyperliquidFeedImage,
        {
          service: 'torghut-hyperliquid-feed',
          imageName: 'torghut-hyperliquid-feed',
          packageAttr: 'torghut-hyperliquid-feed-image',
          repository: 'lab/torghut-hyperliquid-feed',
        },
      ],
      [
        buildNotebookImage,
        {
          service: 'torghut-notebook',
          imageName: 'torghut-notebook',
          packageAttr: 'torghut-notebook-image',
          repository: 'lab/torghut-notebook',
        },
      ],
    ] as const) {
      let captured: BuildAndPushNixImageOptions | undefined

      stubGit()
      stubBuild((options) => {
        captured = options
      })

      const result = await build({ tag: '01234567', dryRun: true })

      expect(captured).toMatchObject({
        ...expected,
        registry: 'registry.ide-newton.ts.net',
        tag: '01234567',
        sourceSha: '0123456789abcdef0123456789abcdef01234567',
        latestTag: 'latest',
        dryRun: true,
      })
      expect(result.digest).toBe(
        `registry.ide-newton.ts.net/${expected.repository}@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`,
      )

      __private.setBuildAndPushNixImage()
      __private.setExecGit()
    }
  })

  it('rejects Docker-only build options on Torghut Nix image builds', async () => {
    try {
      await buildImage({ context: 'services/torghut' })
      throw new Error('expected Torghut Nix image build to reject Docker-only options')
    } catch (error) {
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toBe(
        'Torghut core Nix image builds do not accept Docker-only option(s): context',
      )
    }
  })
})
