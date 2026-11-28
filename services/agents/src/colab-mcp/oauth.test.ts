import { describe, expect, it, vi } from 'vitest'

import { createColabTokenProvider } from './oauth'

const adc = {
  type: 'authorized_user',
  client_id: 'test-client',
  client_secret: 'test-secret',
  refresh_token: 'test-refresh-token',
}

describe('Colab authorized-user ADC', () => {
  it('refreshes once for concurrent callers, then at expiry minus 60 seconds or on rotation', async () => {
    let now = 0
    let credentials = adc
    let requests = 0
    const exchange = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe('https://oauth2.googleapis.com/token')
      expect(init?.method).toBe('POST')
      expect(init?.redirect).toBe('error')
      expect(new Headers(init?.headers).get('content-type')).toBe('application/x-www-form-urlencoded')
      expect(Object.fromEntries(init?.body as URLSearchParams)).toEqual({
        grant_type: 'refresh_token',
        client_id: adc.client_id,
        client_secret: adc.client_secret,
        refresh_token: credentials.refresh_token,
      })
      return Response.json({ access_token: `test-access-${++requests}`, expires_in: 3600 })
    })
    const tokens = createColabTokenProvider('/adc/credentials.json', {
      fetch: exchange,
      read: async () => JSON.stringify(credentials),
      now: () => now,
    })

    expect(await tokens.credentialsReady()).toBe(true)
    expect(exchange).not.toHaveBeenCalled()
    expect(await Promise.all([tokens.getToken(), tokens.getToken()])).toEqual(['test-access-1', 'test-access-1'])
    now = 3_539_999
    expect(await tokens.getToken()).toBe('test-access-1')
    now++
    expect(await tokens.getToken()).toBe('test-access-2')
    credentials = { ...adc, refresh_token: 'new-test-refresh-token' }
    expect(await tokens.getToken()).toBe('test-access-3')
    expect(exchange).toHaveBeenCalledTimes(3)
  })

  it('fails closed if the mounted ADC is removed even with an unexpired access token', async () => {
    const read = vi.fn(async () => JSON.stringify(adc))
    const exchange = vi.fn(async () => Response.json({ access_token: 'test-access', expires_in: 3600 }))
    const tokens = createColabTokenProvider('/adc/credentials.json', { read, fetch: exchange })
    expect(await tokens.getToken()).toBe('test-access')
    read.mockRejectedValue(new Error('ENOENT'))
    expect(await tokens.credentialsReady()).toBe(false)
    await expect(tokens.getToken()).rejects.toMatchObject({ code: 'colab_credentials_unavailable' })
    expect(exchange).toHaveBeenCalledTimes(1)
  })

  it('does not expose OAuth errors or use malformed ADC', async () => {
    const read = vi.fn(async () => JSON.stringify(adc))
    const exchange = vi.fn(async () => Response.json({ error: 'test-secret' }, { status: 401 }))
    const tokens = createColabTokenProvider('/adc/credentials.json', { read, fetch: exchange })
    await expect(tokens.getToken()).rejects.toThrow('Colab gateway credentials are missing or invalid.')
    read.mockResolvedValue('{"type":"service_account"}')
    expect(await tokens.credentialsReady()).toBe(false)
    await expect(tokens.getToken()).rejects.toMatchObject({ code: 'colab_credentials_unavailable' })
    expect(exchange).toHaveBeenCalledTimes(1)
  })
})
