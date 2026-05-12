import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'bun:test'

const workflow = readFileSync(
  new URL('../../../../../.github/workflows/torghut-build-push.yaml', import.meta.url),
  'utf8',
)

const pathPatternIndex = (pattern: string): number =>
  workflow.split('\n').findIndex((line) => line.trim() === `- '${pattern}'`)

describe('torghut build-push workflow', () => {
  it('does not build and deploy Torghut for test-only script changes', () => {
    const scriptsInclude = pathPatternIndex('packages/scripts/src/torghut/**')
    const testsExclude = pathPatternIndex('!packages/scripts/src/torghut/__tests__/**')
    const testFilesExclude = pathPatternIndex('!packages/scripts/src/torghut/**/*.test.ts')

    expect(scriptsInclude).toBeGreaterThan(-1)
    expect(testsExclude).toBeGreaterThan(scriptsInclude)
    expect(testFilesExclude).toBeGreaterThan(scriptsInclude)
  })
})
