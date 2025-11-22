import { describe, expect, it } from 'vitest'

import { __private } from '../deploy-codex-image'

const image = 'registry.ide-newton.ts.net/lab/codex-universal@sha256:deadbeef'

describe('replaceImageReferences', () => {
  it('replaces codex image references regardless of tag or digest', () => {
    const content = `
    image: registry.ide-newton.ts.net/lab/codex-universal:latest
    another: registry.ide-newton.ts.net/lab/codex-universal@sha256:abc123
    `

    const rewritten = __private.replaceImageReferences(
      content,
      'registry.ide-newton.ts.net',
      'lab/codex-universal',
      image,
    )

    expect(rewritten).not.toContain('latest')
    expect(rewritten).not.toContain('abc123')
    const matches = rewritten.match(new RegExp(image, 'g')) ?? []
    expect(matches.length).toBe(2)
  })
})
