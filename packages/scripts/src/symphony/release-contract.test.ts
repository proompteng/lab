import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

import { repoRoot } from '../shared/cli'
import { readReleaseContract, writeReleaseContract } from './release-contract'

describe('symphony release contract', () => {
  it('round-trips normalized contract data', () => {
    const dir = mkdtempSync(join(tmpdir(), 'symphony-release-contract-'))
    const path = join(dir, 'contract.json')

    try {
      writeReleaseContract(relative(repoRoot, path), {
        sourceSha: '1234567890abcdef1234567890abcdef12345678',
        tag: 'abc12345',
        digest:
          'registry.ide-newton.ts.net/lab/symphony@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        image: 'registry.ide-newton.ts.net/lab/symphony',
        createdAt: '2026-03-14T21:00:00.000Z',
      })

      const raw = readFileSync(path, 'utf8')
      expect(raw).toContain('"digest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"')

      expect(readReleaseContract(relative(repoRoot, path))).toEqual({
        sourceSha: '1234567890abcdef1234567890abcdef12345678',
        tag: 'abc12345',
        digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        image: 'registry.ide-newton.ts.net/lab/symphony',
        createdAt: '2026-03-14T21:00:00.000Z',
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('accepts generic Nix OCI release contracts without a Symphony createdAt field', () => {
    const dir = mkdtempSync(join(tmpdir(), 'symphony-generic-release-contract-'))
    const path = join(dir, 'contract.json')

    try {
      writeFileSync(
        path,
        `${JSON.stringify(
          {
            service: 'symphony',
            sourceSha: '1234567890abcdef1234567890abcdef12345678',
            tag: 'sha-1234567890abcdef1234567890abcdef12345678',
            digest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            image: 'registry.ide-newton.ts.net/lab/symphony',
            packageAttr: 'symphony-image',
            builder: 'nix-dockerTools-skopeo',
          },
          null,
          2,
        )}\n`,
        'utf8',
      )

      expect(readReleaseContract(relative(repoRoot, path))).toEqual({
        sourceSha: '1234567890abcdef1234567890abcdef12345678',
        tag: 'sha-1234567890abcdef1234567890abcdef12345678',
        digest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        image: 'registry.ide-newton.ts.net/lab/symphony',
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
