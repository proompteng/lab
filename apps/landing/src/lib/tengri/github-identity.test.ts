import { expect, mock, test } from 'bun:test'

void mock.module('server-only', () => ({}))
const { verifyGithubIdentity } = await import('./github-identity')

test('administration binds canonical GitHub numeric IDs and ignores display metadata', () => {
  const first = verifyGithubIdentity('Example', {
    id: 123,
    login: 'example',
    type: 'User',
    email: 'same@fixture.invalid',
  })
  const second = verifyGithubIdentity('Other', { id: 456, login: 'other', type: 'User', email: 'same@fixture.invalid' })
  expect(first.githubId).toBe('123')
  expect(first.humanId).toHaveLength(64)
  expect(first.humanId).not.toBe(second.humanId)
  for (const value of [
    { id: 123, login: 'different', type: 'User' },
    { id: 123, login: 'example', type: 'Organization' },
    { id: Number.MAX_SAFE_INTEGER + 1, login: 'example', type: 'User' },
    { id: '123', login: 'example', type: 'User' },
  ])
    expect(() => verifyGithubIdentity('Example', value)).toThrow()
})
