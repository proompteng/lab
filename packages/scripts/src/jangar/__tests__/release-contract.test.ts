import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

import { repoRoot } from '../../shared/cli'
import { readReleaseContract, writeReleaseContract } from '../release-contract'

describe('release-contract', () => {
  it('writes and reads a valid contract', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jangar-release-contract-'))
    const contractPath = join(dir, 'contract.json')

    writeReleaseContract(relative(repoRoot, contractPath), {
      sourceSha: '1234567890abcdef1234567890abcdef12345678',
      tag: '12345678',
      digest: 'sha256:6af34b1781155267ed6821833feb0ee8856b2b08128cb0ac9b0c388615b380fe',
      image: 'registry.ide-newton.ts.net/lab/jangar',
      createdAt: '2026-02-20T06:30:00.000Z',
    })

    const parsed = readReleaseContract(relative(repoRoot, contractPath))
    expect(parsed.sourceSha).toBe('1234567890abcdef1234567890abcdef12345678')
    expect(parsed.tag).toBe('12345678')
    expect(parsed.digest).toBe('sha256:6af34b1781155267ed6821833feb0ee8856b2b08128cb0ac9b0c388615b380fe')
    expect(parsed.image).toBe('registry.ide-newton.ts.net/lab/jangar')

    rmSync(dir, { recursive: true, force: true })
  })

  it('normalizes digest values with repository prefix', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jangar-release-contract-'))
    const contractPath = join(dir, 'contract.json')

    writeReleaseContract(relative(repoRoot, contractPath), {
      sourceSha: 'abcdefabcdefabcdefabcdefabcdefabcdefabcd',
      tag: 'abcdefab',
      digest:
        'registry.ide-newton.ts.net/lab/jangar@sha256:430763ebeeda8734e1da3ae8c6b665bcc1b380fb815317fffc98371cccea219e',
      image: 'registry.ide-newton.ts.net/lab/jangar',
      createdAt: '2026-02-20T06:31:00.000Z',
    })

    const parsed = readReleaseContract(relative(repoRoot, contractPath))
    expect(parsed.digest).toBe('sha256:430763ebeeda8734e1da3ae8c6b665bcc1b380fb815317fffc98371cccea219e')

    rmSync(dir, { recursive: true, force: true })
  })

  it('ignores legacy extra fields when reading old contracts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jangar-release-contract-'))
    const contractPath = join(dir, 'contract.json')

    writeFileSync(
      contractPath,
      `${JSON.stringify(
        {
          sourceSha: 'fedcba0987654321fedcba0987654321fedcba09',
          tag: 'fedcba09',
          digest: 'sha256:92b26b54d2ee65b1ce53f15fe4cb37500865167583515a69f8f299ec52ffb405',
          image: 'registry.ide-newton.ts.net/lab/jangar',
          legacyField: 'ignored',
          createdAt: '2026-02-20T06:32:00.000Z',
        },
        null,
        2,
      )}\n`,
      'utf8',
    )

    const parsed = readReleaseContract(relative(repoRoot, contractPath))
    expect(parsed).toEqual({
      sourceSha: 'fedcba0987654321fedcba0987654321fedcba09',
      tag: 'fedcba09',
      digest: 'sha256:92b26b54d2ee65b1ce53f15fe4cb37500865167583515a69f8f299ec52ffb405',
      image: 'registry.ide-newton.ts.net/lab/jangar',
      createdAt: '2026-02-20T06:32:00.000Z',
    })

    rmSync(dir, { recursive: true, force: true })
  })
})
