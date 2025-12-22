import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'

import { listPullRequestCheckFailures } from '@/services/github/reviews'
import type { ListCheckFailuresOptions } from '@/services/github/types'

const createResponse = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init })

describe('listPullRequestCheckFailures', () => {
  const baseOptions: Omit<ListCheckFailuresOptions, 'fetchImplementation'> = {
    repositoryFullName: 'proompteng/lab',
    headSha: 'abc123',
    token: 'test-token',
    apiBaseUrl: 'https://api.github.test',
    userAgent: 'test-agent',
  }

  it('aggregates failures from check runs and commit statuses', async () => {
    const fetchStub = vi.fn(async (input: string | URL) => {
      const url = String(input)
      if (url.includes('/check-runs')) {
        const page = new URL(url).searchParams.get('page')
        if (page === '1') {
          return createResponse({
            check_runs: [
              {
                name: 'ci / unit',
                status: 'completed',
                conclusion: 'failure',
                details_url: 'https://ci.example.com/unit',
              },
            ],
          })
        }
        return createResponse({ check_runs: [] })
      }

      if (url.endsWith('/status')) {
        return createResponse({
          statuses: [
            {
              context: 'lint',
              state: 'failure',
              target_url: 'https://ci.example.com/lint',
              description: 'Formatting failed',
            },
          ],
        })
      }

      throw new Error(`unexpected url: ${url}`)
    }) as unknown as ListCheckFailuresOptions['fetchImplementation']

    const result = await Effect.runPromise(
      listPullRequestCheckFailures({
        ...baseOptions,
        fetchImplementation: fetchStub,
      }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }

    const names = result.checks.map((check) => check.name).sort()
    expect(names).toEqual(['ci / unit', 'lint'])
    expect(result.checks.find((check) => check.name === 'ci / unit')?.url).toBe('https://ci.example.com/unit')
    expect(result.checks.find((check) => check.name === 'lint')?.details).toContain('Formatting failed')
  })

  it('propagates API errors as structured results', async () => {
    const fetchStub = vi.fn(async (input: string | URL) => {
      const url = String(input)
      if (url.includes('/check-runs')) {
        return new Response('nope', { status: 500, headers: { 'content-type': 'application/json' } })
      }
      throw new Error(`unexpected url: ${url}`)
    }) as unknown as ListCheckFailuresOptions['fetchImplementation']

    const result = await Effect.runPromise(
      listPullRequestCheckFailures({
        ...baseOptions,
        fetchImplementation: fetchStub,
      }),
    )

    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }

    expect(result.reason).toBe('http-error')
    expect(result.status).toBe(500)
  })
})
