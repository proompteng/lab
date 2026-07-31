import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const workflow = readFileSync('.github/workflows/bayn-qualification.yml', 'utf8')

describe('Bayn qualification workflow verifier integrity', () => {
  test('passes explicit checked-out repository identity and a bounded Git deadline', () => {
    expect(workflow).toContain('fetch-depth: 0')
    expect(workflow).toContain('--repository-root "${GITHUB_WORKSPACE}"')
    expect(workflow).toContain('--trusted-repository "${GITHUB_REPOSITORY}"')
    expect(workflow).toContain('--git-timeout-ms 10000')
  })

  test('keeps read-only GitHub permissions and does not claim the missing executor is installed', () => {
    expect(workflow).toContain('actions: read')
    expect(workflow).toContain('contents: read')
    expect(workflow).not.toMatch(/(?:issues|packages|pull-requests|statuses|checks|deployments|id-token): write/)
    expect(workflow).toContain('Require separately installed immutable evidence collector')
    expect(workflow).toContain('must be invoked by the same reviewed collector')
  })
})
