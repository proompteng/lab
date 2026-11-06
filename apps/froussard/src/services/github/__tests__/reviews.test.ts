import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'

import { listPullRequestBlockingChecks } from '@/services/github/reviews'
import type { ListBlockingChecksOptions } from '@/services/github/types'

const createResponse = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init })

describe('listPullRequestBlockingChecks', () => {
  const baseOptions: Omit<ListBlockingChecksOptions, 'fetchImplementation'> = {
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

      if (url.includes('/status?')) {
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
    }) as unknown as ListBlockingChecksOptions['fetchImplementation']

    const result = await Effect.runPromise(
      listPullRequestBlockingChecks({
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

  it.each([
    ['queued', null, true],
    ['in_progress', null, true],
    ['completed', 'failure', true],
    ['completed', null, true],
    ['completed', 'success', false],
    ['completed', 'skipped', false],
    ['completed', 'neutral', false],
  ] as const)('treats %s / %s as blocking=%s', async (status, conclusion, blocked) => {
    const result = await Effect.runPromise(
      listPullRequestBlockingChecks({
        ...baseOptions,
        fetchImplementation: async (input) =>
          createResponse(
            input.includes('/check-runs') ? { check_runs: [{ name: 'CI', status, conclusion }] } : { statuses: [] },
          ),
      }),
    )
    expect(result).toMatchObject({ ok: true })
    if (result.ok) expect(result.checks.length > 0).toBe(blocked)
  })

  it('blocks a pending commit status even when check runs passed', async () => {
    const result = await Effect.runPromise(
      listPullRequestBlockingChecks({
        ...baseOptions,
        fetchImplementation: async (input) =>
          createResponse(
            input.includes('/check-runs')
              ? { check_runs: [{ name: 'CI', status: 'completed', conclusion: 'success' }] }
              : { statuses: [{ context: 'external', state: 'pending' }] },
          ),
      }),
    )
    expect(result).toMatchObject({ ok: true, checks: [{ name: 'external', conclusion: 'pending' }] })
  })

  it('blocks when CI has not reported any checks', async () => {
    const result = await Effect.runPromise(
      listPullRequestBlockingChecks({
        ...baseOptions,
        fetchImplementation: async (input) =>
          createResponse(input.includes('/check-runs') ? { check_runs: [] } : { statuses: [] }),
      }),
    )
    expect(result).toMatchObject({ ok: true, checks: [{ conclusion: 'pending' }] })
  })

  it('rejects malformed check data instead of treating it as passing', async () => {
    const result = await Effect.runPromise(
      listPullRequestBlockingChecks({
        ...baseOptions,
        fetchImplementation: async () => createResponse({ check_runs: [{ name: 'CI' }] }),
      }),
    )
    expect(result).toMatchObject({ ok: false, reason: 'invalid-json' })
  })

  it('propagates API errors as structured results', async () => {
    const fetchStub = vi.fn(async (input: string | URL) => {
      const url = String(input)
      if (url.includes('/check-runs')) {
        return new Response('nope', { status: 500, headers: { 'content-type': 'application/json' } })
      }
      throw new Error(`unexpected url: ${url}`)
    }) as unknown as ListBlockingChecksOptions['fetchImplementation']

    const result = await Effect.runPromise(
      listPullRequestBlockingChecks({
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
