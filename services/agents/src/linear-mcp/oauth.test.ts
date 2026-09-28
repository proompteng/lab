import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import { describe, expect, it, vi } from 'vitest'

import { createLinearOAuthFetch, LinearOAuthTokenProvider } from './oauth'

const oauthConfig = {
  clientId: 'linear-client',
  clientSecret: 'linear-secret',
  tokenUrl: new URL('https://api.linear.app/oauth/token'),
  scopes: ['read', 'write'],
}

describe('Linear OAuth client credentials', () => {
  it('requests read/write app actor tokens and caches them before expiry', async () => {
    const fetchMock = vi.fn<FetchLike>(async (_url, init) => {
      expect(init?.method).toBe('POST')
      expect(String(init?.body)).toContain('grant_type=client_credentials')
      expect(String(init?.body)).toContain('scope=read%2Cwrite')
      expect(new Headers(init?.headers).get('authorization')).toBe(
        `Basic ${Buffer.from('linear-client:linear-secret').toString('base64')}`,
      )
      return Response.json({ access_token: 'token-one', expires_in: 2_592_000, scope: 'read write' })
    })
    const provider = new LinearOAuthTokenProvider(oauthConfig, { fetch: fetchMock, now: () => 1000 })

    await expect(provider.getToken()).resolves.toBe('token-one')
    await expect(provider.getToken()).resolves.toBe('token-one')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('obtains a new token and retries once after an upstream 401', async () => {
    let tokenNumber = 0
    const tokenFetch = vi.fn<FetchLike>(async () => {
      tokenNumber += 1
      return Response.json({ access_token: `token-${tokenNumber}`, expires_in: 2_592_000, scope: 'read write' })
    })
    const provider = new LinearOAuthTokenProvider(oauthConfig, { fetch: tokenFetch })
    const upstreamFetch = vi.fn<FetchLike>(async (_url, init) => {
      const authorization = new Headers(init?.headers).get('authorization')
      return authorization === 'Bearer token-1' ? new Response(null, { status: 401 }) : Response.json({ ok: true })
    })

    const response = await createLinearOAuthFetch(provider, { fetch: upstreamFetch })('https://mcp.linear.app/mcp', {
      method: 'POST',
      body: '{}',
    })

    expect(response.status).toBe(200)
    expect(tokenFetch).toHaveBeenCalledTimes(2)
    expect(upstreamFetch).toHaveBeenCalledTimes(2)
  })

  it('refreshes before expiry and does not reuse the stale app actor token', async () => {
    let now = 1_000
    let tokenNumber = 0
    const tokenFetch = vi.fn<FetchLike>(async () => {
      tokenNumber += 1
      return Response.json({ access_token: `token-${tokenNumber}`, expires_in: 600, scope: 'read write' })
    })
    const provider = new LinearOAuthTokenProvider(oauthConfig, { fetch: tokenFetch, now: () => now })

    await expect(provider.getToken()).resolves.toBe('token-1')
    now += 301_000
    await expect(provider.getToken()).resolves.toBe('token-2')

    expect(tokenFetch).toHaveBeenCalledTimes(2)
  })

  it('retries authentication only once and passes through rate limiting without refreshing', async () => {
    let tokenNumber = 0
    const tokenFetch = vi.fn<FetchLike>(async () => {
      tokenNumber += 1
      return Response.json({ access_token: `token-${tokenNumber}`, expires_in: 2_592_000, scope: 'read write' })
    })
    const provider = new LinearOAuthTokenProvider(oauthConfig, { fetch: tokenFetch })
    const unauthorized = vi.fn<FetchLike>(async () => new Response(null, { status: 401 }))
    const oauthFetch = createLinearOAuthFetch(provider, { fetch: unauthorized })

    expect((await oauthFetch('https://mcp.linear.app/mcp')).status).toBe(401)
    expect(unauthorized).toHaveBeenCalledTimes(2)
    expect(tokenFetch).toHaveBeenCalledTimes(2)

    const rateLimited = vi.fn<FetchLike>(async () => new Response(null, { status: 429 }))
    const rateLimitedProvider = new LinearOAuthTokenProvider(oauthConfig, { fetch: tokenFetch })
    expect(
      (await createLinearOAuthFetch(rateLimitedProvider, { fetch: rateLimited })('https://mcp.linear.app/mcp')).status,
    ).toBe(429)
    expect(rateLimited).toHaveBeenCalledOnce()
  })

  it('records token endpoint timeouts without logging or returning credential material', async () => {
    const recordRefresh = vi.fn()
    const provider = new LinearOAuthTokenProvider(oauthConfig, {
      fetch: vi.fn<FetchLike>(async () => {
        throw new DOMException('timed out', 'TimeoutError')
      }),
      metrics: { recordRefresh },
    })

    await expect(provider.getToken()).rejects.toThrow('Linear OAuth token request failed')
    expect(recordRefresh).toHaveBeenCalledWith('error')
  })

  it('rejects malformed token responses and accepts the legacy scope array shape', async () => {
    const recordRefresh = vi.fn()
    const malformed = new LinearOAuthTokenProvider(oauthConfig, {
      fetch: vi.fn<FetchLike>(async () => new Response('not-json', { status: 200 })),
      metrics: { recordRefresh },
    })

    await expect(malformed.getToken()).rejects.toThrow('Linear OAuth token response is invalid')
    expect(recordRefresh).toHaveBeenCalledWith('error')

    const legacy = new LinearOAuthTokenProvider(oauthConfig, {
      fetch: vi.fn<FetchLike>(async () =>
        Response.json({ access_token: 'legacy-token', expires_in: 2_592_000, scope: ['read', 'write'] }),
      ),
    })
    await expect(legacy.getToken()).resolves.toBe('legacy-token')
  })
})
