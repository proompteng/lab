import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { __test } from '~/server/agents-controller'

const loadPrivateKey = () =>
  readFileSync(
    resolve(__dirname, '../../../../packages/temporal-bun-sdk/tests/fixtures/tls/temporal-test-client.key'),
    'utf8',
  )

describe('github app token cache', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    __test.clearGithubAppTokenCache()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('reuses cached tokens until refresh window', async () => {
    const baseTime = new Date('2026-02-04T00:00:00Z')
    vi.setSystemTime(baseTime)

    const expiresAt = new Date(baseTime.getTime() + 60 * 60 * 1000)
    const fetchMock = vi.fn(async () => {
      const token = `token-${fetchMock.mock.calls.length + 1}`
      return {
        ok: true,
        status: 201,
        statusText: 'Created',
        json: async () => ({ token, expires_at: expiresAt.toISOString() }),
      } as unknown as Response
    })

    vi.stubGlobal('fetch', fetchMock)

    const token1 = await __test.fetchGithubAppToken({
      apiBaseUrl: 'https://api.github.com',
      appId: '123',
      installationId: '456',
      privateKey: loadPrivateKey(),
    })

    expect(token1).toBe('token-1')
    expect(fetchMock).toHaveBeenCalledTimes(1)

    vi.setSystemTime(new Date(baseTime.getTime() + 10 * 60 * 1000))

    const token2 = await __test.fetchGithubAppToken({
      apiBaseUrl: 'https://api.github.com',
      appId: '123',
      installationId: '456',
      privateKey: loadPrivateKey(),
    })

    expect(token2).toBe('token-1')
    expect(fetchMock).toHaveBeenCalledTimes(1)

    vi.setSystemTime(new Date(baseTime.getTime() + 56 * 60 * 1000))

    const token3 = await __test.fetchGithubAppToken({
      apiBaseUrl: 'https://api.github.com',
      appId: '123',
      installationId: '456',
      privateKey: loadPrivateKey(),
    })

    expect(token3).toBe('token-2')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
