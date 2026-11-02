import { expect, test } from 'bun:test'

import { SymphonyError } from './errors'
import { renderPromptTemplate } from './template'
import type { Issue } from './types'

const issue: Issue = {
  id: 'issue-1',
  identifier: 'ABC-123',
  title: 'Example issue',
  description: 'Description',
  priority: 1,
  state: 'Todo',
  branchName: 'abc-123',
  url: 'https://linear.app/abc/issue/ABC-123',
  labels: ['bug', 'urgent'],
  blockedBy: [],
  createdAt: '2026-03-13T00:00:00.000Z',
  updatedAt: '2026-03-13T00:00:00.000Z',
}

test('renderPromptTemplate renders issue fields and attempt', () => {
  const rendered = renderPromptTemplate('Issue {{issue.identifier}} attempt={{attempt}}', {
    issue,
    attempt: 2,
  })

  expect(rendered).toBe('Issue ABC-123 attempt=2')
})

test('renderPromptTemplate fails on unknown variables in strict mode', () => {
  expect(() =>
    renderPromptTemplate('Missing {{issue.missingField}}', {
      issue,
      attempt: null,
    }),
  ).toThrow(SymphonyError)
})
