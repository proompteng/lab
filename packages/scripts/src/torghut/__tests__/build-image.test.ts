import { afterEach, describe, expect, it } from 'bun:test'

import type { DockerBuildOptions } from '../../shared/docker'
import { __private, buildImage } from '../build-image'

afterEach(() => {
  __private.setBuildAndPushDockerImage()
  __private.setExecGit()
  delete process.env.TORGHUT_IMAGE_CACHE_REF
  delete process.env.TORGHUT_IMAGE_CACHE_MODE
  delete process.env.TORGHUT_IMAGE_PLATFORMS
})

describe('buildImage', () => {
  it('passes registry cache settings to the Docker builder when configured', async () => {
    let captured: DockerBuildOptions | undefined

    __private.setExecGit((args) => {
      if (args[0] === 'describe') return 'v0.1.0'
      if (args[0] === 'rev-parse') return '0123456789abcdef0123456789abcdef01234567'
      throw new Error(`unexpected git command: ${args.join(' ')}`)
    })
    __private.setBuildAndPushDockerImage(async (options) => {
      captured = options
      return {
        ...options,
        image: `${options.registry}/${options.repository}:${options.tag}`,
      }
    })

    process.env.TORGHUT_IMAGE_CACHE_REF = 'registry.ide-newton.ts.net/lab/torghut:buildcache'
    process.env.TORGHUT_IMAGE_CACHE_MODE = 'min'

    await buildImage({
      registry: 'registry.ide-newton.ts.net',
      repository: 'lab/torghut',
      tag: '01234567',
      platforms: ['linux/arm64'],
    })

    expect(captured?.cacheRef).toBe('registry.ide-newton.ts.net/lab/torghut:buildcache')
    expect(captured?.cacheMode).toBe('min')
  })

  it('treats a none cache ref as disabled', async () => {
    let captured: DockerBuildOptions | undefined

    __private.setExecGit((args) => {
      if (args[0] === 'describe') return 'v0.1.0'
      if (args[0] === 'rev-parse') return '0123456789abcdef0123456789abcdef01234567'
      throw new Error(`unexpected git command: ${args.join(' ')}`)
    })
    __private.setBuildAndPushDockerImage(async (options) => {
      captured = options
      return {
        ...options,
        image: `${options.registry}/${options.repository}:${options.tag}`,
      }
    })

    process.env.TORGHUT_IMAGE_CACHE_REF = 'none'

    await buildImage({ tag: '01234567' })

    expect(captured?.cacheRef).toBeUndefined()
  })

  it('defaults to amd64 and arm64 image platforms', async () => {
    let captured: DockerBuildOptions | undefined

    __private.setExecGit((args) => {
      if (args[0] === 'describe') return 'v0.1.0'
      if (args[0] === 'rev-parse') return '0123456789abcdef0123456789abcdef01234567'
      throw new Error(`unexpected git command: ${args.join(' ')}`)
    })
    __private.setBuildAndPushDockerImage(async (options) => {
      captured = options
      return {
        ...options,
        image: `${options.registry}/${options.repository}:${options.tag}`,
      }
    })

    await buildImage({ tag: '01234567' })

    expect(captured?.platforms).toEqual(['linux/amd64', 'linux/arm64'])
  })
})
