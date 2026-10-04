import { describe, expect, it, vi } from 'vitest'

import { logger } from '@/logger'

import { deriveRepositoryFullName, isGithubIssueCommentEvent, isGithubIssueEvent, isRecord } from './github-payload'

describe('isRecord', () => {
  it('returns true for plain objects', () => {
    expect(isRecord({ a: 1 })).toBe(true)
  })

  it('returns false for nullish or non-object values', () => {
    expect(isRecord(null)).toBe(false)
    expect(isRecord(undefined)).toBe(false)
    expect(isRecord(42)).toBe(false)
    expect(isRecord('record')).toBe(false)
  })
})

describe('isGithubIssueEvent', () => {
  it('identifies payloads that include an issue field', () => {
    expect(isGithubIssueEvent({ issue: {}, action: 'opened' })).toBe(true)
  })

  it('rejects payloads missing the issue field', () => {
    expect(isGithubIssueEvent({ action: 'opened' })).toBe(false)
  })
})

describe('isGithubIssueCommentEvent', () => {
  it('identifies payloads that include a comment field', () => {
    expect(isGithubIssueCommentEvent({ comment: { body: 'hello' } })).toBe(true)
  })

  it('rejects payloads missing the comment field', () => {
    expect(isGithubIssueCommentEvent({ action: 'created' })).toBe(false)
  })
})

describe('deriveRepositoryFullName', () => {
  it('prefers the repository full_name when available', () => {
    expect(deriveRepositoryFullName({ full_name: 'owner/name' }, 'https://example.com/alt')).toBe('owner/name')
  })

  it('derives the owner and repo from repository_url when full_name missing', () => {
    const fullName = deriveRepositoryFullName(undefined, 'https://api.github.com/repos/acme/widgets')
    expect(fullName).toBe('acme/widgets')
  })

  it('returns null and warns when the repository_url is malformed', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {
      // no-op for tests
    })

    const fullName = deriveRepositoryFullName(undefined, 'not a url')

    expect(fullName).toBeNull()
    expect(warnSpy).toHaveBeenCalled()

    warnSpy.mockRestore()
  })

  it('returns null when neither full_name nor repository_url are provided', () => {
    expect(deriveRepositoryFullName(undefined, undefined)).toBeNull()
  })
})
