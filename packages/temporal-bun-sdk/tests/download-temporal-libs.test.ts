import { afterEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, rmSync } from 'node:fs'

import {
  CACHE_ROOT,
  detectPlatform,
  downloadLibraries,
  getAssetNames,
  isSupportedPlatform,
  type PlatformTriple,
} from '../scripts/download-temporal-libs.ts'

const ORIGINAL_FETCH = global.fetch
const ORIGINAL_FORCE_PLATFORM = process.env.FORCE_PLATFORM
const ORIGINAL_FORCE_ARCH = process.env.FORCE_ARCH

function resetEnv(): void {
  if (ORIGINAL_FORCE_PLATFORM === undefined) {
    delete process.env.FORCE_PLATFORM
  } else {
    process.env.FORCE_PLATFORM = ORIGINAL_FORCE_PLATFORM
  }

  if (ORIGINAL_FORCE_ARCH === undefined) {
    delete process.env.FORCE_ARCH
  } else {
    process.env.FORCE_ARCH = ORIGINAL_FORCE_ARCH
  }
}

afterEach(() => {
  resetEnv()
  global.fetch = ORIGINAL_FETCH

  if (existsSync(CACHE_ROOT)) {
    rmSync(CACHE_ROOT, { recursive: true, force: true })
  }
})

describe('detectPlatform', () => {
  test('uses FORCE_PLATFORM / FORCE_ARCH overrides', () => {
    process.env.FORCE_PLATFORM = 'linux'
    process.env.FORCE_ARCH = 'arm64'

    expect(detectPlatform()).toBe('linux-arm64')
  })

  test('throws for unsupported combinations', () => {
    process.env.FORCE_PLATFORM = 'win32'
    process.env.FORCE_ARCH = 'arm64'

    expect(() => detectPlatform()).toThrow(
      'Unsupported platform combination: platform=win32 arch=arm64',
    )
  })
})

describe('getAssetNames', () => {
  test('returns expected archive and checksum names', () => {
    const result = getAssetNames('linux-arm64', 'temporal-libs-v9.9.9')

    expect(result).toEqual({
      archive: 'temporal-static-libs-linux-arm64-v9.9.9.tar.gz',
      checksum: 'temporal-static-libs-linux-arm64-v9.9.9.tar.gz.sha256',
    })
  })
})

describe('isSupportedPlatform', () => {
  test('recognises supported platforms', () => {
    const supported: PlatformTriple[] = ['linux-arm64', 'linux-x64', 'macos-arm64']

    for (const platform of supported) {
      expect(isSupportedPlatform(platform)).toBe(true)
    }
  })

  test('rejects unsupported platforms', () => {
    expect(isSupportedPlatform('windows-x64')).toBe(false)
  })
})

describe('downloadLibraries', () => {
  test('throws when release is missing required assets', async () => {
    const mockFetch = mock(async () =>
      new Response(
        JSON.stringify({
          tag_name: 'temporal-libs-v9.9.9',
          assets: [],
        }),
        { status: 200 },
      ),
    )

    global.fetch = mockFetch as typeof fetch

    await expect(downloadLibraries('temporal-libs-v9.9.9', 'linux-arm64')).rejects.toThrow(
      'Release temporal-libs-v9.9.9 is missing required assets for linux-arm64',
    )
  })
})
