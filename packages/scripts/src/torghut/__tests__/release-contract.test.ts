import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

import { repoRoot } from '../../shared/cli'
import { readReleaseContract, writeReleaseContract } from '../release-contract'

const platformDigests = {
  'linux/amd64': 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
  'linux/arm64': 'sha256:2222222222222222222222222222222222222222222222222222222222222222',
}

describe('torghut release-contract', () => {
  it('writes and reads a valid contract', () => {
    const dir = mkdtempSync(join(tmpdir(), 'torghut-release-contract-'))
    const contractPath = join(dir, 'contract.json')

    writeReleaseContract(relative(repoRoot, contractPath), {
      sourceSha: '1234567890abcdef1234567890abcdef12345678',
      tag: '12345678',
      digest: 'sha256:6af34b1781155267ed6821833feb0ee8856b2b08128cb0ac9b0c388615b380fe',
      image: 'registry.ide-newton.ts.net/lab/torghut',
      platforms: ['linux/amd64', 'linux/arm64'],
      platformDigests,
      createdAt: '2026-02-21T00:00:00.000Z',
    })

    const parsed = readReleaseContract(relative(repoRoot, contractPath))
    expect(parsed).toEqual({
      sourceSha: '1234567890abcdef1234567890abcdef12345678',
      tag: '12345678',
      digest: 'sha256:6af34b1781155267ed6821833feb0ee8856b2b08128cb0ac9b0c388615b380fe',
      image: 'registry.ide-newton.ts.net/lab/torghut',
      platforms: ['linux/amd64', 'linux/arm64'],
      platformDigests,
      createdAt: '2026-02-21T00:00:00.000Z',
    })

    rmSync(dir, { recursive: true, force: true })
  })

  it('normalizes digest values with repository prefix', () => {
    const dir = mkdtempSync(join(tmpdir(), 'torghut-release-contract-'))
    const contractPath = join(dir, 'contract.json')

    writeReleaseContract(relative(repoRoot, contractPath), {
      sourceSha: 'abcdefabcdefabcdefabcdefabcdefabcdefabcd',
      tag: 'abcdefab',
      digest:
        'registry.ide-newton.ts.net/lab/torghut@sha256:430763ebeeda8734e1da3ae8c6b665bcc1b380fb815317fffc98371cccea219e',
      image: 'registry.ide-newton.ts.net/lab/torghut',
      platforms: ['linux/amd64', 'linux/arm64'],
      platformDigests: {
        'linux/amd64':
          'registry.ide-newton.ts.net/lab/torghut@sha256:1111111111111111111111111111111111111111111111111111111111111111',
        'linux/arm64':
          'registry.ide-newton.ts.net/lab/torghut@sha256:2222222222222222222222222222222222222222222222222222222222222222',
      },
      createdAt: '2026-02-21T00:01:00.000Z',
    })

    const parsed = readReleaseContract(relative(repoRoot, contractPath))
    expect(parsed.digest).toBe('sha256:430763ebeeda8734e1da3ae8c6b665bcc1b380fb815317fffc98371cccea219e')
    expect(parsed.platformDigests).toEqual(platformDigests)

    rmSync(dir, { recursive: true, force: true })
  })

  it('rejects contracts without required platform metadata', () => {
    const dir = mkdtempSync(join(tmpdir(), 'torghut-release-contract-'))
    const contractPath = join(dir, 'contract.json')

    expect(() =>
      writeReleaseContract(relative(repoRoot, contractPath), {
        sourceSha: 'abcdefabcdefabcdefabcdefabcdefabcdefabcd',
        tag: 'abcdefab',
        digest: 'sha256:430763ebeeda8734e1da3ae8c6b665bcc1b380fb815317fffc98371cccea219e',
        image: 'registry.ide-newton.ts.net/lab/torghut',
        platforms: ['linux/arm64'],
        platformDigests: {
          'linux/arm64': 'sha256:2222222222222222222222222222222222222222222222222222222222222222',
        },
        createdAt: '2026-02-21T00:01:00.000Z',
      }),
    ).toThrow('platforms missing required values: linux/amd64')

    expect(() =>
      writeReleaseContract(relative(repoRoot, contractPath), {
        sourceSha: 'abcdefabcdefabcdefabcdefabcdefabcdefabcd',
        tag: 'abcdefab',
        digest: 'sha256:430763ebeeda8734e1da3ae8c6b665bcc1b380fb815317fffc98371cccea219e',
        image: 'registry.ide-newton.ts.net/lab/torghut',
        platforms: ['linux/amd64', 'linux/arm64'],
        platformDigests: {
          'linux/arm64': 'sha256:2222222222222222222222222222222222222222222222222222222222222222',
        },
        createdAt: '2026-02-21T00:01:00.000Z',
      }),
    ).toThrow("Invalid digest for platform 'linux/amd64'")

    rmSync(dir, { recursive: true, force: true })
  })
})
