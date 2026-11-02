import { describe, expect, it } from 'vitest'

import { selectReactionRepository } from './codex-workflow'

describe('selectReactionRepository', () => {
  const makeRepo = (fullName: string) => ({ full_name: fullName, default_branch: 'main' })

  it('prefers the issue repository when present', () => {
    const issueRepo = makeRepo('issue/repo')
    const fallbackRepo = makeRepo('fallback/repo')

    const issue = { repository: issueRepo }

    const result = selectReactionRepository(issue, fallbackRepo)

    expect(result).toBe(issueRepo)
  })

  it('falls back to the top-level repository when the issue repository is missing', () => {
    const fallbackRepo = makeRepo('fallback/repo')
    const issue = { repository: undefined }

    const result = selectReactionRepository(issue, fallbackRepo)

    expect(result).toBe(fallbackRepo)
  })

  it('returns null when neither repository is available', () => {
    const result = selectReactionRepository(undefined, undefined)

    expect(result).toBeNull()
  })
})
