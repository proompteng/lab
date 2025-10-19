import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { __private } from '../reseal-secrets'

describe('froussard reseal-secrets helpers', () => {
  it('writeDocuments normalizes YAML separators', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'froussard-reseal-test-'))
    const target = join(dir, 'secrets.yaml')

    await __private.writeDocuments(target, ['---\nfirst', 'second'])

    const content = readFileSync(target, 'utf8')
    expect(content).toBe('---\nfirst\n---\nsecond\n')
  })
})
