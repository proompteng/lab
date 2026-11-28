import { expect, it } from 'vitest'

import { redactCredentials, stringifyRunnerOutput } from './redact'

it.each([
  ['fetch https://secret-user@github.com/org/repo', 'fetch https://[REDACTED]@github.com/org/repo'],
  ["https://user:pa'ss%40word@github.com:8443/org/repo", 'https://[REDACTED]@github.com:8443/org/repo'],
  ['url=https://x-access-token:opaque-value@github.com/org/repo', 'url=https://[REDACTED]@github.com/org/repo'],
  ['x-access-token:opaque-value', 'x-access-token:[REDACTED]'],
  ['"authorization": "bEaReR opaque.token=="', '"authorization": "bEaReR [REDACTED]"'],
  ['Authorization: Basic dXNlcjpwYXNz', 'Authorization: Basic [REDACTED]'],
  ['ghp_exampleToken, ghs_exampleToken and github_pat_exampleToken', '[REDACTED], [REDACTED] and [REDACTED]'],
  ['https://github.com/org/repo?q=user@example.test#ref', 'https://github.com/org/repo?q=user@example.test#ref'],
])('redacts credentials while preserving surrounding diagnostic context: %s', (input, expected) => {
  expect(redactCredentials(input)).toBe(expected)
  expect(redactCredentials(expected)).toBe(expected)
})

it('redacts an authorization field in structured output', () => {
  expect(
    JSON.parse(stringifyRunnerOutput({ headers: { Authorization: 'Bearer opaque', Accept: 'application/json' } })),
  ).toEqual({
    headers: { Authorization: '[REDACTED]', Accept: 'application/json' },
  })
})
