import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'bun:test'

const guardScript = () => readFileSync(resolve(process.cwd(), 'scripts/agents/guard-extraction-boundaries.sh'), 'utf8')

describe('agents extraction boundary guard', () => {
  it('does not fail on colocated tests that assert forbidden runtime strings are absent', () => {
    const content = guardScript()

    expect(content).toContain("--glob '!**/__tests__/**'")
    expect(content).toContain("--glob '!**/*.test.*'")
  })

  it('guards legacy completion topics and reflected Jangar database secrets out of Agents runtime', () => {
    const content = guardScript()

    expect(content).toContain('argo\\.workflows\\.completions')
    expect(content).toContain('reflection-(allowed|auto)-namespaces')
    expect(content).toContain('jangar-db-ca')
    expect(content).toContain('agents-control-plane runtime profile')
    expect(content).toContain('agents-controllers runtime profile')
  })
})
