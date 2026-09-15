import { describe, expect, it } from 'bun:test'

import {
  ATLAS_ELIGIBILITY_VERSION,
  isAtlasGitFileEligible,
  resolveAtlasMaxFileBytes,
  shouldSkipAtlasPath,
} from './file-eligibility'

describe('Atlas file eligibility', () => {
  it('keeps the filter explicitly versioned', () => {
    expect(ATLAS_ELIGIBILITY_VERSION).toBe('atlas-eligibility-v1')
  })

  it('accepts regular source and documentation files', () => {
    expect(isAtlasGitFileEligible({ path: 'services/jangar/src/server/atlas.ts', mode: '100644', byteSize: 42 })).toBe(
      true,
    )
    expect(isAtlasGitFileEligible({ path: 'docs/atlas/README.md', mode: '100644', byteSize: 42 })).toBe(true)
  })

  it('rejects generated dependency locks, binaries, symlinks, submodules, and oversized blobs', () => {
    expect(shouldSkipAtlasPath('bun.lock')).toBe(true)
    expect(shouldSkipAtlasPath('apps/docs/public/hero.png')).toBe(true)
    expect(isAtlasGitFileEligible({ path: 'link', mode: '120000', byteSize: 12 })).toBe(false)
    expect(isAtlasGitFileEligible({ path: 'vendor', mode: '160000', byteSize: 12 })).toBe(false)
    expect(
      isAtlasGitFileEligible({ path: 'large.ts', mode: '100644', byteSize: 101 }, { ATLAS_MAX_FILE_BYTES: '100' }),
    ).toBe(false)
  })

  it('rejects invalid maximum file sizes', () => {
    expect(() => resolveAtlasMaxFileBytes({ ATLAS_MAX_FILE_BYTES: '0' })).toThrow(/positive integer/)
  })
})
