import { describe, expect, test } from 'bun:test'

import { parseIssueIdentifierPath } from './http-server'

describe('http request parsing', () => {
  test('parses issue identifier paths', () => {
    expect(parseIssueIdentifierPath('/api/v1/ABC-123')).toEqual({ issueIdentifier: 'ABC-123' })
  })

  test('rejects empty issue identifier paths', () => {
    expect(parseIssueIdentifierPath('/api/v1/')).toBeNull()
  })
})
